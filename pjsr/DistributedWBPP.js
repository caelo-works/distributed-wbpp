/*
 * DistributedWBPP.js — one entry, two roles.
 *
 * Launch this on every PixInsight in the cluster and pick a role:
 *   • Server — opens the NATIVE WBPP dialog with cluster distribution grafted in.
 *               Configure your frames and click GO as usual; the heavy per-frame
 *               steps + calib master integrations are split across the clients.
 *   • Client  — turns this PixInsight into a worker: it discovers the server on the
 *               LAN and processes the shards it is handed. Just leave it open.
 *
 * No shared folder for data — frames move over the LAN via the bundled sidecar.
 * Determinism is enforced by a strict version handshake (identical PixInsight +
 * WBPP on every node). If the WBPP version is unknown or no clients are found, the
 * server falls back to a normal local WBPP run — never a silently wrong result.
 *
 * The two absolute #include paths below point at the INSTALLED WBPP (so it tracks
 * PixInsight updates); packaging rewrites the __WBPPDIR__ path and the build stamp.
 */

/* beautify ignore:start */

#feature-id    Batch Processing > Distributed WBPP
#feature-icon  @script_icons_dir/DistributedWBPP.svg
#feature-info  Run the native WBPP across multiple PixInsight instances on the LAN.

// defined BEFORE the includes: a #define only substitutes text that FOLLOWS it, and
// lib/WorkerRuntime.js (included below) uses DWBPP_BUILD. Build stamp injected at deploy.
#define CLUSTER_TOKEN "distributed-wbpp"
#define DWBPP_BUILD   "__BUILD__"

// the installed WBPP engine + GUI (server role runs it; client role loads it too,
// which is what lets both nodes advertise the same WBPP_VERSION for the handshake)
#include "__WBPPDIR__/BPP-defines.jsh"
#include "__WBPPDIR__/BPP-main.js"

#include <pjsr/Sizer.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include "lib/SidecarBridge.js"
#include "lib/ProcessSerializer.js"
#include "lib/WBPPShim.js"
#include "lib/FileLogger.js"
#include "lib/WorkerRuntime.js"

/* beautify ignore:end */

// ---- shared helpers (also used by WorkerRuntime) ---------------------------

function piVersionString()
{
   return format( "%d.%d.%d",
      CoreApplication.versionMajor, CoreApplication.versionMinor, CoreApplication.versionRelease );
}

// Full directory of this script (PixInsight splits a path into DRIVE + DIRECTORY,
// so File.extractDirectory alone drops the drive letter — recompose it).
function scriptDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

// One level up, computed WITHOUT ".." (PJSR File.exists doesn't normalize it).
function scriptParentDir()
{
   var d = scriptDir();
   while ( d.length > 1 && ( d.charAt( d.length - 1 ) == '/' || d.charAt( d.length - 1 ) == '\\' ) )
      d = d.substring( 0, d.length - 1 );
   var i = Math.max( d.lastIndexOf( '/' ), d.lastIndexOf( '\\' ) );
   return ( i > 0 ) ? d.substring( 0, i ) : d;
}

// The sidecar binary matching this machine's OS + CPU architecture, as shipped
// in bin/ (wbpp-sidecar-<os>-<arch>[.exe]). PJSR has no CPU-arch API, so on Unix
// we ask the OS via `uname -m` through the file channel (ExternalProcess.stdout
// is unreliable here — see SidecarBridge).
function machineArch()
{
   var plat = String( CoreApplication.platform );
   if ( /MSWIN|Windows/i.test( plat ) )
      return "amd64";                       // only a windows-amd64 build is shipped
   var arch = "amd64";
   try
   {
      var tmp = File.systemTempDirectory + "/wbpp-arch.txt";
      var U = new ExternalProcess;
      U.start( "/bin/sh", [ "-c", "uname -m > '" + tmp + "'" ] );
      U.waitForFinished();
      var m = File.exists( tmp ) ? File.readTextFile( tmp ) : "";
      if ( /arm64|aarch64/i.test( m ) )
         arch = "arm64";
   }
   catch ( e ) {}
   return arch;
}

function sidecarBinaryName()
{
   var plat = String( CoreApplication.platform );
   var isWin = /MSWIN|Windows/i.test( plat );
   var os = isWin ? "windows" : ( /MAC|macOS|OSX/i.test( plat ) ? "darwin" : "linux" );
   return "wbpp-sidecar-" + os + "-" + machineArch() + ( isWin ? ".exe" : "" );
}

function sidecarCandidates()
{
   var here = scriptDir(), up = scriptParentDir(), name = sidecarBinaryName();
   return [ here + "/bin/" + name,                     // installed package layout
            here + "/" + name,                         // flat (dev)
            up + "/wbpp-sidecar.exe",                   // legacy deploy (bench)
            up + "/wbpp-sidecar-windows-amd64.exe",
            here + "/wbpp-sidecar.exe" ];
}

function resolveSidecar()
{
   var c = sidecarCandidates();
   for ( var i = 0; i < c.length; ++i )
      if ( File.exists( c[ i ] ) )
      {
         var p = c[ i ];
         if ( !/\.exe$/i.test( p ) )
         {
            // macOS quarantines binaries extracted from a downloaded zip; strip the flag
            // so Gatekeeper doesn't block the (unsigned) sidecar. UNTESTED on macOS — the
            // proper fix is code-signing + notarization; this is a best-effort fallback.
            if ( /MAC|macOS|OSX/i.test( String( CoreApplication.platform ) ) )
               try { var Q = new ExternalProcess; Q.start( "/usr/bin/xattr", [ "-dr", "com.apple.quarantine", p ] ); Q.waitForFinished(); } catch ( e ) {}
            // extracted zips can drop the exec bit on Unix — restore it before launch
            try { var X = new ExternalProcess; X.start( "/bin/chmod", [ "+x", p ] ); X.waitForFinished(); } catch ( e ) {}
         }
         return p;
      }
   return null;
}

// (pad2 / nowHMS come from lib/WorkerRuntime.js)

// ---- role picker ------------------------------------------------------------

function RoleDialog()
{
   this.__base__ = Dialog;
   this.__base__();
   this.windowTitle = "Distributed WBPP  [build " + DWBPP_BUILD + "]";
   this.role = null;

   this.intro = new Label( this );
   this.intro.useRichText = true;
   this.intro.wordWrapping = true;
   this.intro.setMinWidth( 440 );
   this.intro.text =
      "<b>Distribute WBPP across the local network.</b><br><br>" +
      "Pick the role of <i>this</i> PC:<br>" +
      "• <b>Server</b> — drives WBPP (native UI), distributes the work.<br>" +
      "• <b>Client</b> — helps the server: leave the window open.";

   this.serverButton = new PushButton( this );
   this.serverButton.text = " Server — drive WBPP ";
   this.serverButton.onClick = function() { this.dialog.role = "server"; this.dialog.ok(); };

   this.clientButton = new PushButton( this );
   this.clientButton.text = " Client — help ";
   this.clientButton.onClick = function() { this.dialog.role = "client"; this.dialog.ok(); };

   this.cancelButton = new PushButton( this );
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function() { this.dialog.cancel(); };

   this.buttons = new HorizontalSizer;
   this.buttons.spacing = 8;
   this.buttons.add( this.serverButton );
   this.buttons.add( this.clientButton );
   this.buttons.addStretch();
   this.buttons.add( this.cancelButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 12;
   this.sizer.add( this.intro );
   this.sizer.add( this.buttons );
   this.setFixedSize();
}
RoleDialog.prototype = new Dialog;

// ---- server dashboard (non-modal, alongside the WBPP UI) --------------------

function ServerDashboard()
{
   this.__base__ = Dialog;
   this.__base__();
   this.windowTitle = "Distributed WBPP — Server  [build " + DWBPP_BUILD + "]";
   this.steps = 0;
   this.T = new ElapsedTime;

   this.header = new Label( this );
   this.header.frameStyle = FrameStyle_Box;
   this.header.margin = 6;
   this.header.useRichText = true;
   this.header.text = "<b>Server ready.</b> Distribution will show here during the WBPP run.";

   this.workers = new Label( this );
   this.workers.margin = 2;
   this.workers.text = "Clients: —";

   this.log = new TreeBox( this );
   this.log.numberOfColumns = 2;
   this.log.setHeaderText( 0, "Time" );
   this.log.setHeaderText( 1, "Event" );
   this.log.headerVisible = true;
   this.log.rootDecoration = false;
   this.log.alternateRowColor = true;
   this.log.setMinSize( 600, 320 );
   this.log.setColumnWidth( 0, 72 );

   this.stats = new Label( this );
   this.stats.margin = 4;
   this.stats.text = "Distributed steps: 0";

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { this.dialog.hide(); };

   this.buttons = new HorizontalSizer;
   this.buttons.add( this.stats );
   this.buttons.addStretch();
   this.buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   this.sizer.add( this.header );
   this.sizer.add( this.workers );
   this.sizer.add( this.log, 100 );
   this.sizer.add( this.buttons );
   this.setMinSize( 680, 460 );

   this.logger = new FileLogger( scriptParentDir() + "/logs", "server",
      [ "Distributed-WBPP SERVER",
        "PixInsight " + piVersionString() + " / WBPP " + ( ( typeof WBPP_VERSION != "undefined" ) ? WBPP_VERSION : "?" ),
        "" ] );

   var self = this;
   this.setWorkers = function( list )
   {
      self.workers.text = ( !list || list.length == 0 ) ? "Clients: none (WBPP will run locally)"
         : ( "Clients (" + list.length + "): " + list.map( function( w ) { return w.node_id || w.NodeID || "?"; } ).join( ", " ) );
   };
   this.logLine = function( msg )
   {
      var node = new TreeBoxNode( self.log );
      node.setText( 0, nowHMS() );
      node.setText( 1, msg );
      self.log.currentNode = node;
      self.header.text = "<b>Distributing…</b> " + msg;
      if ( msg.charAt( 0 ) == "✓" )   // a completed distributed step ("✓ …")
         self.stats.text = "Distributed steps: " + ( ++self.steps );
      self.logger.line( msg );
   };
   this.recap = function()
   {
      self.header.text = "<b>Done.</b> " + self.steps + " step(s) distributed in " + self.T.value.toFixed( 0 ) + " s.";
      self.logLine( "— fin du run —" );
   };
   if ( this.logger.ok )
      this.logLine( "Log auto → " + this.logger.path );
}
ServerDashboard.prototype = new Dialog;

function runServer( bridge )
{
   var dashboard = new ServerDashboard;
   dashboard.show();
   processEvents();

   // graft distribution onto the live engine BEFORE the pipeline is built. installShim
   // is a safe no-op (local fallback) if the WBPP version is unknown or no client is found.
   var status = installShim( engine, bridge, {
      minWorkers: 1,
      onLog: function( msg ) { dashboard.logLine( msg ); processEvents(); }
   } );
   dashboard.setWorkers( bridge.__workerList || [] );
   if ( status.active )
      dashboard.logLine( "Cluster ACTIVE — " + status.workers + " client(s); heavy steps will be distributed." );
   else
      dashboard.logLine( "Cluster inactive (" + status.reason + ") — WBPP runs locally." );

   // run WBPP exactly as the stock entry does; the user configures + clicks GO.
   try { BPPmain( false, WBPP_ID, WBPP_TITLE, WBPP_SETTINGS_KEY_BASE, WBPP_VERSION ); }
   finally { dashboard.recap(); }
}

// ---- entry ------------------------------------------------------------------

function main()
{
   var picker = new RoleDialog;
   if ( !picker.execute() || !picker.role )
      return;

   var sidecar = resolveSidecar();
   if ( sidecar == null )
   {
      ( new MessageBox( "Sidecar not found next to the script.\n\nPaths tried:\n  " +
         sidecarCandidates().join( "\n  " ), "Distributed WBPP", StdIcon_Error, StdButton_Ok ) ).execute();
      return;
   }

   var isServer = ( picker.role == "server" );
   var bridge = new SidecarBridge(
   {
      binaryPath:  sidecar,
      role:        isServer ? "server" : "worker",
      token:       CLUSTER_TOKEN,
      piVersion:   piVersionString(),
      wbppVersion: ( typeof WBPP_VERSION != "undefined" ) ? WBPP_VERSION : "unknown",
      logDir:      scriptParentDir() + "/logs",
      dataDir:     isServer ? "" : ( File.systemTempDirectory + "/wbpp-cluster-worker" ),
      discoverSeconds: 3
   } );

   try { bridge.start(); }
   catch ( e )
   {
      if ( isServer )
      {
         console.criticalln( "** Distributed-WBPP: sidecar failed (" + e.message + "). Local WBPP." );
         BPPmain( false, WBPP_ID, WBPP_TITLE, WBPP_SETTINGS_KEY_BASE, WBPP_VERSION );
      }
      else
         ( new MessageBox( "Could not start the sidecar: " + e.message,
            "Distributed WBPP — Client", StdIcon_Error, StdButton_Ok ) ).execute();
      return;
   }

   try { isServer ? runServer( bridge ) : runWorker( bridge ); }
   finally { bridge.stop(); }
}

main();
