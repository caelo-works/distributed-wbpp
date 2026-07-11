/*
 * WorkerRuntime.js — the cluster CLIENT runtime (included by DistributedWBPP.js).
 *
 * runWorker(bridge, opts) polls the sidecar's pull queue and, for each shard,
 * rebuilds the serialized process, rewrites paths to the locally uploaded copies,
 * runs it, and reports the outputs. Handles every distributable op: calibration /
 * registration / local normalization (a captured process), measurements
 * (SubframeSelector -> metrics) and integration (ImageIntegration -> master).
 *
 * Depends on the includes + helpers the entry provides before this file:
 * SidecarBridge, ProcessSerializer, FileLogger, and scriptParentDir()/piVersion().
 */

// Friendly label for a job op, shown in the client activity log.

// Self-contained WBPP version read (also defined by the entry; duplicate function
// declarations are legal and identical). >= 3.0: BPP.Version; 2.9.x: #define.
function wbppVersionString()
{
   if ( typeof BPP != "undefined" && BPP.Version && BPP.Version.WBPP_VERSION )
      return String( BPP.Version.WBPP_VERSION );
   if ( typeof WBPP_VERSION != "undefined" )
      return String( WBPP_VERSION );
   return "unknown";
}

function opLabel( op )
{
   var m = { calibration: "calibration", registration: "registration",
             localnorm: "local normalization", measurements: "measurements",
             integration: "integration", light_integration: "light integration", drizzle_integration: "drizzle integration" };
   return m[ op ] || ( op || "processing" );
}


function ensureDirectory( path )
{
   if ( !File.directoryExists( path ) )
      File.createDirectory( path, true );
}

// Last path component, tolerant of both / and \ separators (paths embedded in a
// .xdrz may come from any machine's filesystem).
function baseNameOf( p )
{
   var s = String( p ).replace( /\\/g, "/" );
   var i = s.lastIndexOf( "/" );
   return ( i >= 0 ) ? s.substring( i + 1 ) : s;
}

/*
 * processJob — run one shard. The serialized process carries the SERVER's paths,
 * so we rewrite reference/output/targets to this worker's local uploaded copies
 * (all under bridge.dataDir). StarAlignment.targets row shape = [enabled, isFile,
 * path], confirmed from WBPP's WBPPUtils.enableTargetFrames(paths, 3).
 */
/*
 * processJob — generic: rebuild ANY WBPP process from the serialized source the
 * server captured, rewrite the server-side paths to this worker's local copies,
 * run it, and report the outputs. Works for StarAlignment (registration),
 * ImageCalibration (calibration), and future per-frame ops.
 *
 * The server captured the fully-configured process (masters, params, output
 * naming) via an executeGlobal interception, so here we only rewrite paths:
 *   - file_ref_fields : process field -> local basename (masters / reference)
 *   - outputDirectory  -> local data dir
 *   - the targets array -> this shard's local frames
 */
/*
 * measureFrames — Measurements shard. Runs SubframeSelector in MeasureSubframes
 * mode (same config as WBPP's engine.computeDescriptors) on this worker's frames
 * and writes the raw SS.measurements rows to a JSON file, with the file-path
 * column (index 3) replaced by the basename so the server can match rows to its
 * own frames. Returns that JSON as the single output (rapatriated by the normal
 * file channel — no metric-specific transport needed). The measurements are
 * intrinsic (FWHM in px, eccentricity, star counts, PSF signal…), so they match
 * a local measure bit-for-bit regardless of scale settings.
 */
function measureFrames( bridge, job )
{
   var SS = new SubframeSelector;
   SS.routine = SubframeSelector.MeasureSubframes;
   SS.nonInteractive = true;
   SS.cameraResolution = SubframeSelector.Bits16;
   SS.scaleUnit = SubframeSelector.ArcSeconds;
   SS.dataUnit = SubframeSelector.DataNumber;
   SS.fileCache = true;
   SS.noNoiseAndSignalWarnings = true;

   // row shape follows the core process (4 columns on PI 1.9.4) — use WBPP's own
   // helper instead of hand-built rows so it tracks the process definition.
   var paths = [];
   for ( var i = 0; i < job.input_names.length; ++i )
      paths.push( bridge.dataDir + "/" + job.input_names[ i ] );
   SS.subframes = WBPPUtils.enableTargetFrames( paths, 2 );

   if ( !SS.executeGlobal() )
      throw new Error( "SubframeSelector measure failed" );

   // index the measurement rows by frame basename
   var byBase = {};
   for ( var k = 0; k < SS.measurements.length; ++k )
   {
      var r = [];
      for ( var c = 0; c < SS.measurements[ k ].length; ++c )
         r.push( SS.measurements[ k ][ c ] );
      byBase[ File.extractNameAndExtension( String( SS.measurements[ k ][ 3 ] ) ) ] = r;
   }
   // emit ONE .ssm.json per input frame (outputs == inputs, so the sidecar's
   // per-frame accounting is satisfied and each row rides the normal file channel).
   var outputs = [];
   for ( var i = 0; i < job.input_names.length; ++i )
   {
      var b = job.input_names[ i ];                       // basename, e.g. x_c.xisf
      var nm = File.extractName( b ) + ".ssm.json";       // x_c.ssm.json
      File.writeTextFile( bridge.dataDir + "/" + nm, JSON.stringify( byBase[ b ] || null ) );
      outputs.push( { input: b, output: nm } );
   }
   return outputs;
}

/*
 * integrateFrames — Integration shard (Phase 1: calib master generation). Runs the
 * SERVER-captured ImageIntegration (identical params) on this worker's frames and
 * saves the integration result view as a plain XISF. The server finalizes it into a
 * WBPP master (keywords + naming). One whole integration = one job (not splittable),
 * assigned to one machine; parallelism comes from running independent integrations
 * (bias/dark/flat) on different machines at once.
 */
/*
 * drizzleIntegrate — DrizzleIntegration shard (whole-job per filter). The .xdrz
 * files arrive as inputs; the calibrated source images and the .xnml files arrive
 * as shared_files. DrizzleIntegration reads each .xdrz's embedded absolute paths
 * VERBATIM (inputDirectory does NOT remap them — proven during v1.4.0), so the
 * embedded <SourceImage>/<AlignmentTargetImage> are rewritten to this worker's
 * local copies before integrating. Returns the 2-image drizzle bundle
 * (integration + weights); the server finalizes it.
 */
function drizzleIntegrate( bridge, job )
{
   var DI = deserializeProcess( job.process_source, "DI" );
   var rows = [];
   for ( var i = 0; i < job.input_names.length; ++i )
   {
      var xdrz = bridge.dataDir + "/" + job.input_names[ i ];
      var stem = bridge.dataDir + "/" + File.extractName( job.input_names[ i ] );  // basename, no .xdrz

      // A .xdrz embeds the ABSOLUTE path of its source (calibrated) and alignment-target
      // (registered) images — on the server, or on whichever worker registered the frame.
      // DrizzleIntegration reads those paths verbatim (inputDirectory does NOT remap them),
      // so rewrite them to this worker's local uploaded copies before integrating. The
      // .xdrz is pure XML text (base64 payload), so a targeted rewrite round-trips safely.
      try
      {
         var txt = File.readTextFile( xdrz );
         txt = txt.replace( /<SourceImage>([^<]*)<\/SourceImage>/,
            function ( _, p ) { return "<SourceImage>" + bridge.dataDir + "/" + baseNameOf( p ) + "</SourceImage>"; } );
         txt = txt.replace( /<AlignmentTargetImage>([^<]*)<\/AlignmentTargetImage>/,
            function ( _, p ) { return "<AlignmentTargetImage>" + bridge.dataDir + "/" + baseNameOf( p ) + "</AlignmentTargetImage>"; } );
         File.writeTextFile( xdrz, txt );
      }
      catch ( e ) { throw new Error( "xdrz path rewrite failed: " + e.message ); }

      var ln = File.exists( stem + ".xnml" ) ? ( stem + ".xnml" ) : "";
      rows.push( [ true, xdrz, ln ] );
   }
   DI.inputData = rows;
   DI.showImages = false;

   if ( !DI.executeGlobal() )
      throw new Error( "DrizzleIntegration failed" );

   var win = ImageWindow.windowById( DI.integrationImageId );
   if ( !win || win.isNull )
      throw new Error( "no drizzle window (" + DI.integrationImageId + ")" );
   var weight = null;
   try { var w = ImageWindow.windowById( DI.weightImageId ); if ( w && !w.isNull ) weight = w; } catch ( e ) {}

   var outName = "drizzle-" + job.job_id + ".xisf";
   var wins = [ win ], ids = [ "drizzle_integration" ];
   if ( weight != null ) { wins.push( weight ); ids.push( "drizzle_weights" ); }
   engine.imageProcessor.writeImage( bridge.dataDir + "/" + outName, wins, ids );
   win.forceClose();
   if ( weight != null ) try { weight.forceClose(); } catch ( e ) {}
   return [ { input: "__drizzle__", output: outName } ];
}

function integrateFrames( bridge, job )
{
   var isLight = ( job.op == "light_integration" );
   var II = deserializeProcess( job.process_source, "II" );

   // rebuild the images rows against the local uploaded copies. For LIGHTS the rows
   // carry the per-frame companions [enabled, path, .xdrz, .xnml] — shipped via
   // shared_files (single leased worker) and matched here by basename.
   var imgs = [], xdrzPaths = [], lmdBefore = {};
   for ( var i = 0; i < job.input_names.length; ++i )
   {
      var path = bridge.dataDir + "/" + job.input_names[ i ];
      var dz = "", ln = "";
      if ( isLight )
      {
         var stem = bridge.dataDir + "/" + File.extractName( job.input_names[ i ] );
         if ( File.exists( stem + ".xdrz" ) )
         {
            dz = stem + ".xdrz";
            xdrzPaths.push( dz );
            lmdBefore[ dz ] = WBPPUtils.getLastModifiedDate( dz );
         }
         if ( File.exists( stem + ".xnml" ) )
            ln = stem + ".xnml";
      }
      imgs.push( [ true, path, dz, ln ] ); // [enabled, path, drizzle, LN]
   }
   II.images = imgs;
   II.showImages = false;
   if ( !isLight )
      try { II.generateDrizzleData = false; } catch ( e ) {}

   if ( !II.executeGlobal() )
      throw new Error( "ImageIntegration failed" );

   var win = ImageWindow.windowById( II.integrationImageId );
   if ( !win || win.isNull )
      throw new Error( "no integration window (" + II.integrationImageId + ")" );
   var lowWin = null, highWin = null;
   try { var lw = ImageWindow.windowById( II.lowRejectionMapImageId ); if ( lw && !lw.isNull ) lowWin = lw; } catch ( e ) {}
   try { var hw = ImageWindow.windowById( II.highRejectionMapImageId ); if ( hw && !hw.isNull ) highWin = hw; } catch ( e ) {}

   var outName = "integration-" + job.job_id + ".xisf";
   var outputs = [ { input: "__integration__", output: outName } ];
   if ( isLight )
   {
      // bundle integration + rejection maps exactly like WBPP's doIntegrate does
      // (the server-side autocrop reads the embedded maps from the master file)
      var wins = [ win ], ids = [ "integration" ];
      if ( lowWin != null ) { wins.push( lowWin ); ids.push( "rejection_low" ); }
      if ( highWin != null ) { wins.push( highWin ); ids.push( "rejection_high" ); }
      engine.imageProcessor.writeImage( bridge.dataDir + "/" + outName, wins, ids );
      // return the drizzle files the integration actually updated
      for ( var d = 0; d < xdrzPaths.length; ++d )
         if ( WBPPUtils.getLastModifiedDate( xdrzPaths[ d ] ) != lmdBefore[ xdrzPaths[ d ] ] )
            outputs.push( { input: "__xdrz__", output: File.extractNameAndExtension( xdrzPaths[ d ] ) } );
   }
   else
      win.saveAs( bridge.dataDir + "/" + outName, false /*queryOpts*/, false /*allowMsgs*/, false /*strict*/, false /*noOverwrite -> allow*/ );

   win.forceClose();
   if ( lowWin != null ) try { lowWin.forceClose(); } catch ( e ) {}
   if ( highWin != null ) try { highWin.forceClose(); } catch ( e ) {}
   return outputs;
}

function processJob( bridge, job )
{
   if ( job.op == "measurements" )
      return measureFrames( bridge, job );
   if ( job.op == "integration" || job.op == "light_integration" )
      return integrateFrames( bridge, job );
   if ( job.op == "drizzle_integration" )
      return drizzleIntegrate( bridge, job );

   var P;
   if ( job.process_source && job.process_source.length > 0 )
      P = deserializeProcess( job.process_source, "P" );
   else
      P = new StarAlignment; // bare --distribute registration test

   // rewrite shared-file refs (masters / reference) to local uploaded copies
   var refs = job.file_ref_fields || {};
   for ( var field in refs )
      if ( refs.hasOwnProperty( field ) )
         P[ field ] = bridge.dataDir + "/" + refs[ field ];
   // legacy single reference (CLI registration)
   if ( job.reference_name && job.reference_name.length > 0 && !( refs && refs.referenceImage ) )
   {
      P.referenceImage = bridge.dataDir + "/" + job.reference_name;
      P.referenceIsFile = true;
   }

   // output naming/dir so the reported name == the file the process writes.
   // Use the manifest values verbatim when provided (postfix may be "" for LN);
   // the output-naming params are wrapped because some processes (LocalNormalization)
   // don't expose them and their output extension is fixed (.xnml).
   var prefix  = ( typeof job.output_prefix == "string" ) ? job.output_prefix : "";
   var postfix = ( typeof job.output_postfix == "string" ) ? job.output_postfix : "_r";
   var ext     = ( typeof job.output_ext == "string" && job.output_ext.length ) ? job.output_ext : ".xisf";
   // most ops expose "outputDirectory"; the manifest may name a different field.
   try { P[ ( job.dir_field && job.dir_field.length ) ? job.dir_field : "outputDirectory" ] = bridge.dataDir; } catch ( e ) {}
   try { P.outputPrefix = prefix; } catch ( e ) {}
   try { P.outputPostfix = postfix; } catch ( e ) {}
   try { P.outputExtension = ext; } catch ( e ) {}
   try { P.overwriteExistingFiles = true; } catch ( e ) {}

   // rebuild the target list for this shard. Row shape follows path_index:
   //   1 -> [enabled, path]        (ImageCalibration.targetFrames)
   //   2 -> [enabled, isFile, path](StarAlignment.targets)
   var tf   = ( job.targets_field && job.targets_field.length ) ? job.targets_field : "targets";
   var pidx = job.path_index ? job.path_index : 2;
   var rows = [];
   for ( var i = 0; i < job.input_names.length; ++i )
   {
      var path = bridge.dataDir + "/" + job.input_names[ i ];
      rows.push( ( pidx == 1 ) ? [ true, path ] : [ true, true, path ] );
   }
   P[ tf ] = rows;

   if ( !P.executeGlobal() )
      throw new Error( "executeGlobal() failed for " + tf );

   var outputs = [];
   for ( var j = 0; j < job.input_names.length; ++j )
   {
      var base = File.extractName( job.input_names[ j ] );
      outputs.push( { input: job.input_names[ j ], output: prefix + base + postfix + ext } );

      if ( job.drizzle )
      {
         var drz = prefix + base + postfix + ".xdrz";
         if ( File.exists( bridge.dataDir + "/" + drz ) )
            outputs.push( { input: job.input_names[ j ], output: drz } );
      }
   }
   return outputs;
}

function pad2( n ) { return ( n < 10 ? "0" : "" ) + n; }
function nowHMS()
{
   var d = new Date;
   return pad2( d.getHours() ) + ":" + pad2( d.getMinutes() ) + ":" + pad2( d.getSeconds() );
}
// count registered frames in an outputs list (exclude the .xdrz drizzle entries)
function countFrames( outputs )
{
   var n = 0;
   for ( var i = 0; i < outputs.length; ++i )
      if ( !/\.xdrz$/i.test( outputs[ i ].output ) )
         ++n;
   return n;
}

/*
 * Worker dashboard — a WBPP-style progress window. A Timer polls the sidecar for
 * shards; a scrolling list logs each event (job received, frames registered,
 * duration, errors) and running counters are kept in the status bar.
 */
class WorkerDialog extends Dialog
{
constructor( bridge )
{
   super();
   this.bridge = bridge;
   this.windowTitle = "Distributed WBPP — Client  [build " + DWBPP_BUILD + "]";

   this.jobs = 0;
   this.frames = 0;
   this.errors = 0;

   // CaeloWorks family header (the helper lives in the entry script; the bench
   // harness includes this file without it and never opens this dialog).
   this.brandSizer = ( typeof dwbppMakeHeader != "undefined" )
      ? dwbppMakeHeader( this, "🖧  <i>Client — processing the shards this PC is handed.</i>" )
      : null;

   // header
   this.header = new Label( this );
   this.header.frameStyle = FrameStyle.Box;
   this.header.margin = 6;
   this.header.useRichText = true;
   this.header.text = "<b>Client active.</b> Waiting for work from the server…";

   // scrolling activity log
   this.log = new TreeBox( this );
   this.log.numberOfColumns = 2;
   this.log.setHeaderText( 0, "Time" );
   this.log.setHeaderText( 1, "Event" );
   this.log.headerVisible = true;
   this.log.rootDecoration = false;
   this.log.alternateRowColor = true;
   this.log.multipleSelection = false;
   this.log.setMinSize( 560, 300 );
   this.log.setColumnWidth( 0, 72 );

   // running counters
   this.stats = new Label( this );
   this.stats.margin = 4;
   this.stats.text = "Jobs: 0    ·    Frames processed: 0    ·    Errors: 0";

   this.quitButton = new PushButton( this );
   this.quitButton.text = "Leave client mode";
   this.quitButton.onClick = function() { this.dialog.ok(); };

   this.buttons = new HorizontalSizer;
   this.buttons.add( this.stats );
   this.buttons.addStretch();
   this.buttons.add( this.quitButton );

   this.sizer = new VerticalSizer;
   this.sizer.margin = 8;
   this.sizer.spacing = 6;
   if ( this.brandSizer != null )
      this.sizer.add( this.brandSizer );
   this.sizer.add( this.header );
   this.sizer.add( this.log, 100 );
   this.sizer.add( this.buttons );
   this.setMinSize( 620, 460 );

   var self = this;

   // auto-export to a shared log file on the deployment drive (e.g. Y:\...\logs)
   this.logger = new FileLogger( scriptParentDir() + "/logs", "client",
      [ "Distributed-WBPP CLIENT",
        "PixInsight " + piVersionString() + " / WBPP " + wbppVersionString(),
        "Data dir: " + bridge.dataDir, "" ] );

   // append one line to the UI list (auto-scroll) and to the log file
   this.logLine = function( msg )
   {
      var node = new TreeBoxNode( self.log );
      node.setText( 0, nowHMS() );
      node.setText( 1, msg );
      self.log.currentNode = node;      // scroll into view
      self.logger.line( msg );
   };
   this.updateStats = function()
   {
      self.stats.text = "Jobs: " + self.jobs + "    ·    Frames processed: " +
         self.frames + "    ·    Errors: " + self.errors;
   };

   this.logLine( "Client started — waiting for the server (data: " + bridge.dataDir + ")" );
   if ( this.logger.ok )
      this.logLine( "Log auto → " + this.logger.path );

   this.busy = false;
   this.timer = new Timer;
   this.timer.interval = 1.0; // pullWork blocks up to ~0.8s server-side; keep UI responsive
   this.timer.periodic = true;
   this.timer.onTimeout = function()
   {
      if ( self.busy ) return;
      self.busy = true;
      try
      {
         var job = self.bridge.pullWork();
         if ( job != null )
         {
            var nIn = job.input_names.length, lbl = opLabel( job.op );
            self.header.text = "<b>" + lbl + "…</b> " + nIn + " frame(s)";
            self.logLine( "Received: " + lbl + " — " + nIn + " frame(s)" );
            processEvents();

            var T = new ElapsedTime;
            try
            {
               var outputs = processJob( self.bridge, job );
               self.bridge.reportResult( { ok: true, job_id: job.job_id, outputs: outputs } );
               var nOut = countFrames( outputs );
               self.jobs += 1;
               self.frames += nOut;
               self.logLine( "✓ " + lbl + " : " + nOut + " frame(s) en " + T.text );
            }
            catch ( e )
            {
               self.bridge.reportResult( { ok: false, job_id: job.job_id, error: e.message } );
               self.errors += 1;
               self.logLine( "✗ Failed job " + job.job_id + ": " + e.message );
            }
            self.updateStats();
            self.header.text = "<b>Client active.</b> Waiting…";
         }
      }
      finally { self.busy = false; }
   };
   this.timer.start();

   this.onClose = function() { self.timer.stop(); };
}
}

// Run the client dialog on an already-started worker bridge (the entry owns the
// sidecar lifecycle). Blocks until the operator quits the client.
function runWorker( bridge )
{
   ensureDirectory( bridge.dataDir );
   console.noteln( "* Distributed-WBPP client active (pi=", piVersionString(),
      ", wbpp=", wbppVersionString(), "). Data: ", bridge.dataDir );
   ( new WorkerDialog( bridge ) ).execute();
}
