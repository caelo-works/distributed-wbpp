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
function opLabel( op )
{
   var m = { calibration: "calibration", registration: "registration",
             localnorm: "local normalization", measurements: "measurements",
             integration: "integration" };
   return m[ op ] || ( op || "processing" );
}


function ensureDirectory( path )
{
   if ( !File.directoryExists( path ) )
      File.createDirectory( path, true );
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
   SS.routine = SubframeSelector.prototype.MeasureSubframes;
   SS.nonInteractive = true;
   SS.cameraResolution = SubframeSelector.prototype.Bits16;
   SS.scaleUnit = SubframeSelector.prototype.ArcSeconds;
   SS.dataUnit = SubframeSelector.prototype.DataNumber;
   SS.fileCache = true;
   SS.noNoiseAndSignalWarnings = true;

   var subs = [];
   for ( var i = 0; i < job.input_names.length; ++i )
      subs.push( [ true, bridge.dataDir + "/" + job.input_names[ i ] ] );
   SS.subframes = subs;

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
function integrateFrames( bridge, job )
{
   var II = deserializeProcess( job.process_source, "II" );
   var imgs = [];
   for ( var i = 0; i < job.input_names.length; ++i )
      imgs.push( [ true, bridge.dataDir + "/" + job.input_names[ i ], "", "" ] ); // [enabled, path, drizzle, LN]
   II.images = imgs;
   II.showImages = false;
   try { II.generateDrizzleData = false; } catch ( e ) {}

   if ( !II.executeGlobal() )
      throw new Error( "ImageIntegration failed" );

   var win = ImageWindow.windowById( II.integrationImageId );
   if ( !win || win.isNull )
      throw new Error( "no integration window (" + II.integrationImageId + ")" );

   var outName = "integration-" + job.job_id + ".xisf";
   win.saveAs( bridge.dataDir + "/" + outName, false /*queryOpts*/, false /*allowMsgs*/, false /*strict*/, false /*noOverwrite -> allow*/ );
   win.forceClose();
   // free rejection-map windows if any were produced
   try { var lw = ImageWindow.windowById( II.lowRejectionMapImageId ); if ( lw && !lw.isNull ) lw.forceClose(); } catch ( e ) {}
   try { var hw = ImageWindow.windowById( II.highRejectionMapImageId ); if ( hw && !hw.isNull ) hw.forceClose(); } catch ( e ) {}
   return [ { input: "__integration__", output: outName } ];
}

function processJob( bridge, job )
{
   if ( job.op == "measurements" )
      return measureFrames( bridge, job );
   if ( job.op == "integration" )
      return integrateFrames( bridge, job );

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
   P.outputDirectory = bridge.dataDir;
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
function WorkerDialog( bridge )
{
   this.__base__ = Dialog;
   this.__base__();
   this.bridge = bridge;
   this.windowTitle = "Distributed WBPP — Client  [build " + DWBPP_BUILD + "]";

   this.jobs = 0;
   this.frames = 0;
   this.errors = 0;

   // header
   this.header = new Label( this );
   this.header.frameStyle = FrameStyle_Box;
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
   this.sizer.add( this.header );
   this.sizer.add( this.log, 100 );
   this.sizer.add( this.buttons );
   this.setMinSize( 620, 420 );

   var self = this;

   // auto-export to a shared log file on the deployment drive (e.g. Y:\...\logs)
   this.logger = new FileLogger( scriptParentDir() + "/logs", "client",
      [ "Distributed-WBPP CLIENT",
        "PixInsight " + piVersionString() + " / WBPP " + WBPP_VERSION,
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
WorkerDialog.prototype = new Dialog;

// Run the client dialog on an already-started worker bridge (the entry owns the
// sidecar lifecycle). Blocks until the operator quits the client.
function runWorker( bridge )
{
   ensureDirectory( bridge.dataDir );
   console.noteln( "* Distributed-WBPP client active (pi=", piVersionString(),
      ", wbpp=", WBPP_VERSION, "). Data: ", bridge.dataDir );
   ( new WorkerDialog( bridge ) ).execute();
}
