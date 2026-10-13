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

#engine v8

#feature-id    DistributedWBPP : CaeloWorks > Distributed WBPP
#feature-icon  @script_icons_dir/DistributedWBPP.svg
#feature-info  Run the native WBPP across multiple PixInsight instances on the LAN.

// defined BEFORE the includes: a #define only substitutes text that FOLLOWS it, and
// lib/WorkerRuntime.js (included below) uses DWBPP_BUILD. Build stamp injected at deploy.
#define DWBPP_BUILD   "__BUILD__"

// the installed WBPP engine + GUI (server role runs it; client role loads it too,
// which is what lets both nodes advertise the same WBPP version for the handshake).
// WBPP >= 3.0 (PixInsight 1.9.4): single entry include, identity under BPP.Version.*,
// engine v8. For WBPP 2.9.x (PixInsight <= 1.9.3) use plugin v1.0.0.
#include "__WBPPDIR__/BPP-Main.js"

// No pjsr .jsh header includes: under engine v8 the legacy headers don't load;
// StdButton/StdIcon/FrameStyle (and Sizer classes) are provided as runtime globals.
// NB: never write a slash-star sequence inside a line comment here — the v8
// preprocessor's comment stripper does not respect line-comment precedence and
// would swallow everything up to the next star-slash (it ate our lib includes).
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

// The installed WBPP version, wherever this WBPP generation keeps it:
// >= 3.0 exposes BPP.Version.WBPP_VERSION; 2.9.x had a WBPP_VERSION #define.
function wbppVersionString()
{
   if ( typeof BPP != "undefined" && BPP.Version && BPP.Version.WBPP_VERSION )
      return String( BPP.Version.WBPP_VERSION );
   if ( typeof WBPP_VERSION != "undefined" )
      return String( WBPP_VERSION );
   return "unknown";
}

// Launch the native WBPP exactly as the stock WBPP.js entry does.
function runNativeWBPP()
{
   BPPmain( false /* fastMode */,
      BPP.Version.WBPP_ID, BPP.Version.WBPP_TITLE,
      BPP.Version.WBPP_SETTINGS_KEY_BASE, BPP.Version.WBPP_VERSION );
}

// Full directory of this script (PixInsight splits a path into DRIVE + DIRECTORY,
// so File.extractDirectory alone drops the drive letter — recompose it).
function scriptDir()
{
   return File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
}

// Per-user folder for everything this script writes at run time (logs, client
// cache, the one-shot key file). Nothing is ever written under the PixInsight
// installation.
function dwbppUserDir()
{
   return File.homeDirectory + "/CaeloWorks/DistributedWBPP";
}
function dwbppLogDir()   { return dwbppUserDir() + "/logs"; }
function dwbppCacheDir() { return dwbppUserDir() + "/client-cache"; }

// Delete the files of the client cache (frames, masters and outputs received
// during a session). Only ever touches dwbppCacheDir(), never recurses.
function dwbppClearCache()
{
   var dir = dwbppCacheDir();
   if ( !File.directoryExists( dir ) )
      return 0;
   var n = 0, f = new FileFind;
   if ( f.begin( dir + "/*" ) )
      do
      {
         if ( f.isDirectory || f.name == "." || f.name == ".." )
            continue;
         try { File.remove( dir + "/" + f.name ); ++n; } catch ( e ) {}
      }
      while ( f.next() );
   return n;
}

function dwbppIsWindows() { return /MSWIN|Windows/i.test( String( CoreApplication.platform ) ); }
function dwbppIsMac()     { return /MAC|macOS|OSX/i.test( String( CoreApplication.platform ) ); }

// The shipped sidecar builds that can run here, most likely first. PJSR has no
// CPU-architecture API, so on macOS and Linux both builds are candidates and the
// first one that actually runs wins (see resolveSidecar).
function sidecarCandidates()
{
   var here = scriptDir();
   var names;
   if ( dwbppIsWindows() )
      names = [ "wbpp-sidecar-windows-amd64.exe" ];  // only a windows-amd64 build is shipped
   else if ( dwbppIsMac() )
      names = [ "wbpp-sidecar-darwin-arm64", "wbpp-sidecar-darwin-amd64" ];
   else
      names = [ "wbpp-sidecar-linux-amd64", "wbpp-sidecar-linux-arm64" ];
   var out = [];
   for ( var i = 0; i < names.length; ++i )
   {
      out.push( here + "/bin/" + names[ i ] );  // installed package layout
      out.push( here + "/" + names[ i ] );      // flat (dev)
   }
   return out;
}

// True if the binary starts and answers --version on this machine. A build for
// another CPU architecture fails to start, which is how the right one is found.
function sidecarRuns( path )
{
   try
   {
      var P = new ExternalProcess;
      P.start( path, [ "--version" ] );
      if ( P.waitForStarted && !P.waitForStarted( 5000 ) )
         return false;
      P.waitForFinished( 10000 );
      return P.exitCode == 0;
   }
   catch ( e )
   {
      return false;
   }
}

function resolveSidecar()
{
   var c = sidecarCandidates(), present = [];
   for ( var i = 0; i < c.length; ++i )
      if ( File.exists( c[ i ] ) )
         present.push( c[ i ] );
   if ( dwbppIsWindows() )
      return present.length > 0 ? present[ 0 ] : null;
   for ( var j = 0; j < present.length; ++j )
      if ( sidecarRuns( present[ j ] ) )
         return present[ j ];
   // Fallback for a copy that lost its exec bit (e.g. a manual unzip): the update
   // package already ships these files as 0755, so this is normally never reached.
   for ( var k = 0; k < present.length; ++k )
   {
      try { var X = new ExternalProcess; X.start( "/bin/chmod", [ "u+x", present[ k ] ] ); X.waitForFinished(); } catch ( e ) {}
      if ( sidecarRuns( present[ k ] ) )
         return present[ k ];
   }
   return null;
}

// ---- cluster key ------------------------------------------------------------

var DWBPP_KEY_SETTING = "DistributedWBPP/clusterKey";

// Canonical form of a cluster key (32 base32 characters), or null if the text
// is not a valid key. Spaces, dashes and case are ignored, so a key can be
// pasted in any layout.
function dwbppNormalizeKey( text )
{
   var k = String( text || "" ).toUpperCase().replace( /[^A-Z0-9]/g, "" );
   return /^[A-Z2-7]{32}$/.test( k ) ? k : null;
}

// Display form: 8 groups of 4 characters.
function dwbppFormatKey( key )
{
   return key.match( /.{1,4}/g ).join( "-" );
}

function dwbppLoadKey()
{
   var v = Settings.read( DWBPP_KEY_SETTING, DataType.UCString );
   return ( Settings.lastReadOK && dwbppNormalizeKey( v ) ) ? dwbppNormalizeKey( v ) : "";
}

function dwbppSaveKey( key )
{
   Settings.write( DWBPP_KEY_SETTING, DataType.UCString, key );
}

// A fresh random key, drawn by the sidecar from the OS secure random source.
function dwbppGenerateKey( sidecar )
{
   // written in the per-user folder, never in a shared temp dir, and deleted at once
   if ( !File.directoryExists( dwbppUserDir() ) )
      File.createDirectory( dwbppUserDir(), true );
   var out = dwbppUserDir() + "/wbpp-keygen-" + ( new Date ).getTime() + ".txt";
   var P = new ExternalProcess;
   P.start( sidecar, [ "keygen", "--out-file", out ] );
   if ( P.waitForStarted && !P.waitForStarted() )
      throw new Error( "the sidecar did not start" );
   P.waitForFinished( 10000 );
   var key = File.exists( out ) ? dwbppNormalizeKey( File.readTextFile( out ) ) : null;
   try { if ( File.exists( out ) ) File.remove( out ); } catch ( e ) {}
   if ( key == null )
      throw new Error( "could not generate a cluster key" );
   return key;
}

// (pad2 / nowHMS come from lib/WorkerRuntime.js)

// ---------------------------------------------------------------------------
// Unlike FrameStyle / StdButton / StdIcon, TextAlign is NOT injected as a
// runtime global under engine v8 (and pjsr headers do not load). Define it
// from the official pjsr TextAlign flag values so label alignment works.
if ( typeof TextAlign == "undefined" )
   TextAlign = { Left: 0x01, Right: 0x02, HorzCenter: 0x04, Justify: 0x08,
                 Top: 0x20, Bottom: 0x40, VertCenter: 0x80,
                 Center: 0x84, Default: 0x21, Unknown: 0x00 };

// ---------------------------------------------------------------------------
// CaeloWorks dialog header (same family look as the other CaeloWorks scripts):
// 44px emblem + bold title + a clickable "by CaeloWorks" + an italic tagline.

var DWBPP_PRODUCT_URL = "https://pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp";

// Open the product page in the default browser. Only reached from a click on the
// "by CaeloWorks" header link. The OS URL handler is started directly, never
// through a shell: explorer.exe on Windows, open on macOS, xdg-open on Linux.
// Anything but an https URL is refused.
function dwbppOpenInBrowser( url )
{
   if ( !/^https:\/\/\S+$/.test( url ) )
   {
      console.warningln( "Refusing to open a non-https URL: " + url );
      return;
   }
   try
   {
      var P = new ExternalProcess;
      if ( dwbppIsWindows() )
         P.start( "explorer.exe", [ url ] );
      else if ( dwbppIsMac() )
         P.start( "/usr/bin/open", [ url ] );
      else
         P.start( "xdg-open", [ url ] );
      if ( P.waitForStarted )
         P.waitForStarted();
   }
   catch ( e )
   {
      console.warningln( "Could not open " + url );
   }
}

// The script emblem as a fixed-size control, or null if the SVG can't be found
// (dev checkouts, installed tree and script-side-by-side all resolve).
function dwbppMakeEmblem( dlg )
{
   var here = File.extractDrive( #__FILE__ ) + File.extractDirectory( #__FILE__ );
   // dev checkout: pjsr/assets/ ; installed: the SVG sits BESIDE the entry
   // script (that is where PixInsight resolves @script_icons_dir for scripts).
   var candidates = [ here + "/assets/DistributedWBPP.svg",
                      here + "/DistributedWBPP.svg" ];
   var bmp = null;
   for ( var i = 0; i < candidates.length && bmp == null; ++i )
      try
      {
         if ( File.exists( candidates[ i ] ) )
         {
            var b = new Bitmap( candidates[ i ] );
            bmp = ( typeof b.scaledTo == "function" ) ? b.scaledTo( 44, 44 ) : b;
         }
      }
      catch ( e ) { bmp = null; }
   if ( bmp == null )
      return null;
   var ctrl = new Control( dlg );
   ctrl.setFixedSize( 44, 44 );
   ctrl.__bmp = bmp;
   ctrl.onPaint = function()
   {
      var g = new Graphics( this );
      try { g.drawBitmap( 0, 0, this.__bmp ); } catch ( e ) {}
      g.end();
   };
   return ctrl;
}

// Builds the header sizer on dlg (emblem + title column + tagline below).
// Returns a VerticalSizer ready to be added at the top of the dialog's sizer.
function dwbppMakeHeader( dlg, tagline )
{
   var emblem = dwbppMakeEmblem( dlg );

   var title = new Label( dlg );
   title.text = "Distributed WBPP";
   var tf = title.font;
   tf.bold = true;
   tf.pointSize = Math.round( dlg.font.pointSize * 1.7 );
   title.font = tf;

   var by = new Label( dlg );
   by.useRichText = true;
   by.text = "by <span style=\"color:#5a8fd0; text-decoration:underline;\">CaeloWorks</span>";
   by.textAlignment = TextAlign.Left | TextAlign.VertCenter;
   by.toolTip = "Opens " + DWBPP_PRODUCT_URL + " in your default browser (build " + DWBPP_BUILD + ")";
   by.onMousePress = function() { dwbppOpenInBrowser( DWBPP_PRODUCT_URL ); };
   try { by.cursor = new Cursor( ( typeof StdCursor != "undefined" && StdCursor.PointingHand ) ? StdCursor.PointingHand : 13 ); } catch ( e ) {}

   var col = new VerticalSizer;
   col.add( title );
   col.add( by );

   var row = new HorizontalSizer;
   row.spacing = 10;
   if ( emblem != null )
      row.add( emblem );
   row.add( col );
   row.addStretch();

   var head = new VerticalSizer;
   head.spacing = 6;
   head.add( row );
   if ( tagline )
   {
      var tag = new Label( dlg );
      tag.useRichText = true;
      tag.wordWrapping = true;
      tag.text = tagline;
      head.add( tag );
   }
   return head;
}

// ---- help: network, programs and files --------------------------------------

// The same facts as the README section "Network, programs and files".
function dwbppHelpHtml()
{
   return "" +
      "<p><b>Network.</b> Everything stays on your local network; the script never connects to the Internet.</p>" +
      "<ul>" +
      "<li>Discovery: each client announces itself every 2 s by UDP multicast to <tt>239.255.42.99:42099</tt> " +
      "(machine name, operating system, PixInsight and WBPP versions, LAN address and port), signed with the cluster key.</li>" +
      "<li>Each client listens on one TCP port, chosen by the system, on its private LAN addresses only. " +
      "The server connects to it to send frames and jobs and to fetch the results.</li>" +
      "<li>PixInsight talks to its own sidecar on <tt>127.0.0.1:48099</tt>, which is reachable from this computer only.</li>" +
      "<li>What travels between your PCs: light and calibration frames, masters, intermediate files " +
      "(registration, drizzle and normalization data, measurements) and process parameters, including the file paths of the server.</li>" +
      "<li>Protection: a random 160-bit cluster key, generated on the server and pasted once on each client. " +
      "All transfers use TLS 1.3 with both ends authenticated by that key, every request and answer is signed, " +
      "and clients only run a fixed list of WBPP processes (calibration, registration, local normalization, " +
      "integration, drizzle integration, measurements) from parameter values, never code. " +
      "Nodes with another key, or an older version of the script, are ignored.</li>" +
      "<li>Firewall: the first time, Windows or macOS asks whether <tt>wbpp-sidecar</tt> may accept incoming " +
      "connections. Allow it on private networks on every PC of the cluster.</li>" +
      "</ul>" +
      "<p><b>Programs started.</b></p>" +
      "<ul>" +
      "<li>The bundled sidecar, <tt>&lt;PixInsight&gt;/src/scripts/CaeloWorks/DistributedWBPP/bin/wbpp-sidecar-&lt;os&gt;-&lt;cpu&gt;</tt>: " +
      "it runs in the background while the script is open, and briefly for each exchange with PixInsight. " +
      "On macOS and Linux it is first started with <tt>--version</tt> to pick the build for your processor.</li>" +
      "<li>Windows only: <tt>taskkill</tt>, at start, to end a sidecar left over by a previous session.</li>" +
      "<li>macOS and Linux only, as a repair: <tt>chmod u+x</tt> on the sidecar if it lost its execute permission " +
      "(a manual unzip). An installation from the update repository never needs it.</li>" +
      "<li>Your web browser, through <tt>explorer.exe</tt>, <tt>open</tt> or <tt>xdg-open</tt>, only when you click " +
      "<i>by CaeloWorks</i>, on " + DWBPP_PRODUCT_URL + ".</li>" +
      "</ul>" +
      "<p><b>Files.</b> Nothing is written inside the PixInsight installation.</p>" +
      "<ul>" +
      "<li>Logs: <tt>" + dwbppLogDir() + "</tt> (a few kB to a few MB per session; delete them at any time).</li>" +
      "<li>Client cache: <tt>" + dwbppCacheDir() + "</tt>, the frames, masters and results received from the server. " +
      "It can reach the size of the client's share of the data being processed. " +
      "It is emptied when the client starts and when you click <i>Leave client mode</i>.</li>" +
      "<li>Temporary files named <tt>wbpp-*</tt> in the system temporary folder: small exchange files, deleted after use, " +
      "and on the server the results downloaded from the clients, deleted at the end of the session.</li>" +
      "<li>The cluster key is kept in the PixInsight settings (<tt>" + DWBPP_KEY_SETTING + "</tt>).</li>" +
      "</ul>" +
      "<p><b>WBPP.</b> The server runs the WBPP installed with PixInsight and adapts it in memory only, for the " +
      "duration of the session: no WBPP file is changed. If anything is unexpected (unknown WBPP version, " +
      "no client found, a client error), the work runs locally, as in a normal WBPP run.</p>";
}

class HelpDialog extends Dialog
{
constructor()
{
   super();
   this.windowTitle = "Distributed WBPP: network, programs and files";

   this.textLabel = new Label( this );
   this.textLabel.useRichText = true;
   this.textLabel.wordWrapping = true;
   this.textLabel.setFixedWidth( 640 );
   this.textLabel.text = dwbppHelpHtml();

   this.closeButton = new PushButton( this );
   this.closeButton.text = "Close";
   this.closeButton.onClick = function() { this.dialog.ok(); };

   this.buttons = new HorizontalSizer;
   this.buttons.addStretch();
   this.buttons.add( this.closeButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 10;
   this.sizer.add( this.textLabel );
   this.sizer.add( this.buttons );
   this.adjustToContents();
   this.setFixedSize();
}
}

// ---- role picker ------------------------------------------------------------

class RoleDialog extends Dialog
{
constructor( sidecar )
{
   super();
   this.windowTitle = "Distributed WBPP  [build " + DWBPP_BUILD + "]";
   this.role = null;
   this.key = null;
   this.sidecar = sidecar;

   this.headerSizer = dwbppMakeHeader( this,
      "🖧  <i>Every PixInsight on your network, one WBPP run.</i>" );

   this.intro = new Label( this );
   this.intro.useRichText = true;
   this.intro.wordWrapping = true;
   this.intro.setMinWidth( 440 );
   this.intro.text =
      "Pick the role of <i>this</i> PC:<br>" +
      "• <b>Server</b> — drives WBPP (native UI), distributes the work.<br>" +
      "• <b>Client</b> — helps the server: leave the window open.";

   // cluster key: generated on the server, pasted once on each client
   this.keyLabel = new Label( this );
   this.keyLabel.text = "Cluster key:";
   this.keyLabel.textAlignment = TextAlign.Left | TextAlign.VertCenter;

   var saved = dwbppLoadKey();
   this.keyEdit = new Edit( this );
   this.keyEdit.text = saved ? dwbppFormatKey( saved ) : "";
   this.keyEdit.setMinWidth( 330 );
   this.keyEdit.toolTip = "<p>The key that lets your PCs work together, and only them.</p>" +
      "<p>Server: a key is created the first time; give it to your clients.<br>" +
      "Client: paste the key shown in the server window.</p>";

   this.newKeyButton = new PushButton( this );
   this.newKeyButton.text = "New key";
   this.newKeyButton.toolTip = "Create a new random key. Every client will need it.";
   this.newKeyButton.onClick = function()
   {
      var d = this.dialog;
      if ( dwbppNormalizeKey( d.keyEdit.text ) != null &&
           ( new MessageBox( "Replace the cluster key? Every client will need the new key.",
              "Distributed WBPP", StdIcon.Question, StdButton.Yes, StdButton.No ) ).execute() != StdButton.Yes )
         return;
      try { d.keyEdit.text = dwbppFormatKey( dwbppGenerateKey( d.sidecar ) ); }
      catch ( e ) { ( new MessageBox( e.message, "Distributed WBPP", StdIcon.Error, StdButton.Ok ) ).execute(); }
   };

   this.keyRow = new HorizontalSizer;
   this.keyRow.spacing = 6;
   this.keyRow.add( this.keyLabel );
   this.keyRow.add( this.keyEdit, 100 );
   this.keyRow.add( this.newKeyButton );

   this.serverButton = new PushButton( this );
   this.serverButton.text = " Server — drive WBPP ";
   this.serverButton.onClick = function()
   {
      var d = this.dialog;
      var key = dwbppNormalizeKey( d.keyEdit.text );
      if ( key == null )
      {
         if ( d.keyEdit.text.replace( /\s/g, "" ).length > 0 )
         {
            ( new MessageBox( "This is not a valid cluster key. Clear the field to have a new key created, " +
               "or click New key.", "Distributed WBPP", StdIcon.Error, StdButton.Ok ) ).execute();
            return;
         }
         try { key = dwbppGenerateKey( d.sidecar ); }
         catch ( e ) { ( new MessageBox( e.message, "Distributed WBPP", StdIcon.Error, StdButton.Ok ) ).execute(); return; }
      }
      dwbppSaveKey( key );
      d.key = key;
      d.role = "server";
      d.ok();
   };

   this.clientButton = new PushButton( this );
   this.clientButton.text = " Client — help ";
   this.clientButton.onClick = function()
   {
      var d = this.dialog;
      var key = dwbppNormalizeKey( d.keyEdit.text );
      if ( key == null )
      {
         ( new MessageBox( "Paste the cluster key shown in the Distributed WBPP window of the server " +
            "(32 letters and digits; dashes and spaces do not matter).",
            "Distributed WBPP", StdIcon.Warning, StdButton.Ok ) ).execute();
         return;
      }
      dwbppSaveKey( key );
      d.key = key;
      d.role = "client";
      d.ok();
   };

   this.helpButton = new PushButton( this );
   this.helpButton.text = "Network, programs and files…";
   this.helpButton.onClick = function() { ( new HelpDialog ).execute(); };

   this.cancelButton = new PushButton( this );
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function() { this.dialog.cancel(); };

   this.buttons = new HorizontalSizer;
   this.buttons.spacing = 8;
   this.buttons.add( this.serverButton );
   this.buttons.add( this.clientButton );
   this.buttons.addStretch();
   this.buttons.add( this.helpButton );
   this.buttons.add( this.cancelButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 12;
   this.sizer.add( this.headerSizer );
   this.sizer.add( this.intro );
   this.sizer.add( this.keyRow );
   this.sizer.add( this.buttons );
   this.setFixedSize();
}
}

// ---- server dashboard (non-modal, alongside the WBPP UI) --------------------

class ServerDashboard extends Dialog
{
constructor( clusterKey )
{
   super();
   this.windowTitle = "Distributed WBPP — Server  [build " + DWBPP_BUILD + "]";
   this.steps = 0;
   this.T = new ElapsedTime;

   this.headerSizer = dwbppMakeHeader( this,
      "🖧  <i>Server — the live server ∥ cluster split shows here during the run.</i>" );

   this.header = new Label( this );
   this.header.frameStyle = FrameStyle.Box;
   this.header.margin = 6;
   this.header.useRichText = true;
   this.header.text = "<b>Server ready.</b> Distribution will show here during the WBPP run.";

   this.keyLabel = new Label( this );
   this.keyLabel.text = "Cluster key (paste it once on each client):";
   this.keyLabel.textAlignment = TextAlign.Left | TextAlign.VertCenter;
   this.keyEdit = new Edit( this );
   this.keyEdit.readOnly = true;
   this.keyEdit.text = dwbppFormatKey( clusterKey );
   this.keyRow = new HorizontalSizer;
   this.keyRow.spacing = 6;
   this.keyRow.add( this.keyLabel );
   this.keyRow.add( this.keyEdit, 100 );

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
   this.sizer.add( this.headerSizer );
   this.sizer.add( this.header );
   this.sizer.add( this.keyRow );
   this.sizer.add( this.workers );
   this.sizer.add( this.log, 100 );
   this.sizer.add( this.buttons );
   this.setMinSize( 680, 500 );

   this.logger = new FileLogger( dwbppLogDir(), "server",
      [ "Distributed-WBPP SERVER",
        "PixInsight " + piVersionString() + " / WBPP " + wbppVersionString(),
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
      self.logLine( "— end of run —" );
   };
   if ( this.logger.ok )
      this.logLine( "Auto log → " + this.logger.path );
}
}

function runServer( bridge, clusterKey )
{
   var dashboard = new ServerDashboard( clusterKey );
   dashboard.show();
   processEvents();

   // graft distribution onto the live engine BEFORE the pipeline is built. installShim
   // is a safe no-op (local fallback) if the WBPP version is unknown or no client is found.
   var status = installShim( engine, bridge, {
      minWorkers: 1,
      onLog: function( msg ) { dashboard.logLine( msg ); processEvents(); }
   } );
   dashboard.setWorkers( bridge.__workerList || [] );
   // nodes the sidecar refused: tell the user what to do about each one
   for ( var i = 0; i < bridge.incompatible.length; ++i )
   {
      var n = bridge.incompatible[ i ];
      var why = String( n.reason || "" );
      dashboard.logLine( "⚠ Ignored a client at " + n.addr + ": " + why +
         ( /key/i.test( why ) ? ". Paste this server's cluster key on it." :
           /older/i.test( why ) ? ". Update it to Distributed WBPP 1.9.0 or later." :
           /newer/i.test( why ) ? ". Update this PC to the same Distributed WBPP version." : "." ) );
   }
   if ( status.active )
      dashboard.logLine( "Cluster ACTIVE — " + status.workers + " client(s); heavy steps will be distributed." );
   else
      dashboard.logLine( "Cluster inactive (" + status.reason + ") — WBPP runs locally." );

   // run WBPP exactly as the stock entry does; the user configures + clicks GO.
   try { runNativeWBPP(); }
   finally
   {
      dashboard.recap();
      removeClusterTempDirs();
   }
}

// ---- entry ------------------------------------------------------------------

function main()
{
   // this build targets the WBPP >= 3.0 layout (PixInsight >= 1.9.4);
   // on older PixInsight use plugin v1.0.0 (the update channel gates this too)
   CoreApplication.ensureMinimumVersion( 1, 9, 4 );

   var sidecar = resolveSidecar();
   if ( sidecar == null )
   {
      ( new MessageBox( "No sidecar that runs on this computer was found next to the script.\n\nPaths tried:\n  " +
         sidecarCandidates().join( "\n  " ), "Distributed WBPP", StdIcon.Error, StdButton.Ok ) ).execute();
      return;
   }

   var picker = new RoleDialog( sidecar );
   if ( !picker.execute() || !picker.role || !picker.key )
      return;

   var isServer = ( picker.role == "server" );
   if ( !File.directoryExists( dwbppUserDir() ) )
      File.createDirectory( dwbppUserDir(), true );
   if ( !isServer )
      dwbppClearCache();   // leftovers of a session that did not end cleanly

   var bridge = new SidecarBridge(
   {
      binaryPath:  sidecar,
      role:        isServer ? "server" : "worker",
      clusterKey:  picker.key,
      keyDir:      dwbppUserDir(),
      piVersion:   piVersionString(),
      wbppVersion: wbppVersionString(),
      logDir:      dwbppLogDir(),
      dataDir:     isServer ? "" : dwbppCacheDir(),
      discoverSeconds: 3
   } );
   if ( !File.directoryExists( dwbppLogDir() ) )
      File.createDirectory( dwbppLogDir(), true );

   try { bridge.start(); }
   catch ( e )
   {
      if ( isServer )
      {
         console.criticalln( "** Distributed-WBPP: sidecar failed (" + e.message + "). Local WBPP." );
         runNativeWBPP();
      }
      else
         ( new MessageBox( "Could not start the sidecar: " + e.message,
            "Distributed WBPP — Client", StdIcon.Error, StdButton.Ok ) ).execute();
      return;
   }

   try { isServer ? runServer( bridge, picker.key ) : runWorker( bridge ); }
   finally
   {
      bridge.stop();
      if ( !isServer )
         dwbppClearCache();
   }
}

main();
