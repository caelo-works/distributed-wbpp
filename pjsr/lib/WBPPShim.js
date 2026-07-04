/*
 * WBPPShim.js — graft cluster distribution onto the native WBPP engine.
 *
 * Mechanism (validated primitives on PixInsight 1.9.4 / #engine v8):
 *   - native prototypes are NOT patchable under v8 (probe ❌ — executeGlobal
 *     dispatches natively even past an own-property override);
 *   - engine.processContainer.add is plain JS (probe ✅) and receives the
 *     fully-configured process right before executeGlobal.
 * Therefore, for a distributable operation we:
 *   1. temporarily override engine.processContainer.add to CAPTURE the
 *      fully-configured instance (masters, params, output dir) and abort the
 *      native _run (sentinel throw) BEFORE it executes/post-processes;
 *   2. distribute the captured process over the cluster (the sidecar transfers
 *      the referenced shared files — masters/reference — once, checksum-cached);
 *   3. run our OWN post-processing: processingSucceeded/addDrizzleFile per frame.
 *
 * This needs no replication of WBPP's process-building code (WBPP builds it; we
 * capture it), so it's the same tiny surface for every operation and more
 * update-resistant. Anchored to operation names + process field names.
 *
 * ============================ WBPP 3.0.x anchors ============================
 * Operations are ES6 classes extending BPPOperationBlock (this.name, this.group,
 * instance _run). Every distributable op follows the same sequence:
 *    P.<targets> = full list; engine.processContainer.add( P );   <- CAPTURE here
 *    P.<targets> = cache-subset; P.executeGlobal();
 * Under #engine v8 native prototypes are NOT patchable (executeGlobal dispatches
 * natively), but engine.processContainer is a plain JS stub on 1.9.4 (WBPP installs
 * it itself: "V8: ProcessContainer.add() is not available"), so we patch ITS add()
 * to capture the fully-configured process and abort the native run (sentinel).
 * Identity lives in BPP.Version.*; steps in BPP.FrameProcessingStep; enum values
 * are ImageType.Light/Flat (renamed); measurements moved to
 * engine.subframeAnalyzer.computeDescriptors (same SS columns, same return);
 * master writes go through engine.imageProcessor.writeImage.
 * Post-processing uses frame.processingSucceeded(step, out) / processingFailed().
 * ===========================================================================
 */

#ifndef __WBPP_WBPPShim_js
#define __WBPP_WBPPShim_js

#include "ProcessSerializer.js"

// WBPP versions whose operation names + process fields we've verified.
// (2.9.x is served by plugin v1.0.0 — this shim targets the 3.0 engine layout.)
var WBPP_SHIM_COMPAT = { "3.0.1": true };

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


// Optional UI logger (WBPP wipes the console; the dashboard subscribes here).
var __wbppClusterLog = null;
function __clusterLog( msg )
{
   if ( __wbppClusterLog )
      try { __wbppClusterLog( msg ); } catch ( e ) {}
}

var __WBPP_CAPTURE_SENTINEL = { __wbppCapture: true };

// Adaptive load balancing: measured cost-per-frame (seconds) for the server lane
// and the cluster lane, per operation label. The cluster cost includes network
// transfer, so a slow/Wi-Fi client naturally gets fewer frames. EMA-smoothed and
// refined after every group, so the split self-tunes across a run.
var __costServer = {};   // label -> s/frame (compute only)
var __costCluster = {};  // label -> s/frame (compute + transfer, whole cluster)
var __globalServerFrac = undefined; // server's frame-share, EMA across ALL ops — seeds a
                                    // never-seen op so it doesn't restart from an even
                                    // split (the per-op warm-up tax): the server/cluster
                                    // speed ratio is ~stable between ops even if the
                                    // absolute cost/frame differs.
function __ema( old, val ) { return ( old == undefined ) ? val : ( 0.6 * old + 0.4 * val ); }

// Cluster split note for the Measurements row. WBPP rewrites that operation's
// statusMessage after computeDescriptors, so we stash the split here and append it
// once the native Measurements _run has set its own message (see wrapQueue).
var __measureSplitNote = "";

// Adaptive split: how many of M frames the server keeps for `label`. Uses the
// measured cost ratio once both lanes are known, else an even bootstrap. Clamp [0,M].
function __serverCount( label, M, nWorkers )
{
   var sc = __costServer[ label ], cc = __costCluster[ label ];
   var n;
   if ( sc != undefined && cc != undefined )
      n = Math.round( M * cc / ( sc + cc ) );       // this op's own measured split
   else if ( __globalServerFrac != undefined )
      n = Math.round( M * __globalServerFrac );      // carry the split learned by earlier ops
   else
      n = Math.floor( M / ( nWorkers + 1 ) );        // cold start: even bootstrap
   return Math.max( 0, Math.min( M, n ) );
}

// Feed one group's measured times back into the per-operation cost EMAs.
function __learnCosts( label, serverSecs, serverN, clusterMs, clusterN, collected )
{
   if ( serverN > 0 && serverSecs > 0 )
      __costServer[ label ] = __ema( __costServer[ label ], serverSecs / serverN );
   if ( clusterN > 0 && clusterMs > 0 && collected > 0 )
      __costCluster[ label ] = __ema( __costCluster[ label ], ( clusterMs / 1000 ) / clusterN );
   // carry the server frame-share across ops so a new op starts near-optimal
   var sc = __costServer[ label ], cc = __costCluster[ label ];
   if ( sc != undefined && cc != undefined && ( sc + cc ) > 0 )
      __globalServerFrac = __ema( __globalServerFrac, cc / ( sc + cc ) );
}

// The verified, present outputs of a distribution report.
function __verifiedOutputs( report )
{
   var out = [], outs = ( report && report.outputs ) || [];
   for ( var o = 0; o < outs.length; ++o )
      if ( outs[ o ].verified && outs[ o ].path && File.exists( outs[ o ].path ) )
         out.push( outs[ o ] );
   return out;
}

/*
 * __captureViaContainer — v8-era capture primitive. Native process prototypes are
 * not patchable under #engine v8, but every WBPP op adds its FULLY-CONFIGURED
 * process to engine.processContainer (a plain JS stub on 1.9.4) right before
 * executeGlobal. We patch that add() to grab the instance and abort the native
 * run with the sentinel. Returns { captured, nativeErr } and always restores.
 */
function __captureViaContainer( engine, runNative, skipAdds )
{
   // NB: on 1.9.4 processContainer is a NATIVE ProcessContainer and method patches
   // on native objects are ignored under v8 — so we swap the whole PROPERTY for a
   // plain-JS decoy during the armed window (engine is plain JS; WBPP itself
   // assigns this property), and restore it afterwards.
   var orig = engine.processContainer;
   if ( !orig )
      throw new Error( "engine.processContainer not available for capture" );
   var captured = null, nativeErr = null;
   var toSkip = skipAdds || 0;
   engine.processContainer = {
      // forward the first `skipAdds` processes to the real container (their native
      // execution proceeds untouched) and capture-abort the next one — lets us grab
      // the SECOND process of a composite routine (e.g. generateLNReference: LN
      // runs locally, the reference ImageIntegration is captured).
      add: function( p )
      {
         if ( toSkip > 0 )
         {
            toSkip--;
            try { return orig.add( p ); } catch ( e ) { return; }
         }
         captured = p;
         throw __WBPP_CAPTURE_SENTINEL;
      },
      toSource: function() { return ( orig && orig.toSource ) ? orig.toSource.apply( orig, arguments ) : ""; }
   };
   try { runNative(); }
   catch ( e ) { if ( e !== __WBPP_CAPTURE_SENTINEL ) nativeErr = e; }
   finally { engine.processContainer = orig; }
   return { captured: captured, nativeErr: nativeErr };
}

// A fresh unique temp dir for a cluster download.
function __makeTempDir( tag )
{
   var p = File.systemTempDirectory + "/wbpp-" + tag + "-" + ( new Date ).getTime();
   if ( !File.directoryExists( p ) )
      File.createDirectory( p, true );
   return p;
}

// Per-operation descriptor. proc/step reference core/WBPP globals resolved at
// call time (never at include time) so include order can't bite us.
function wbppDistOps()
{
   return {
      "Registration": {
         proc: StarAlignment, targetsField: "targets", pathIndex: 2,
         fileRefFields: [ "referenceImage" ], drizzle: true, step: "REGISTRATION", label: "registration"
      },
      "Calibration": {
         proc: ImageCalibration, targetsField: "targetFrames", pathIndex: 1,
         fileRefFields: [ "masterBiasPath", "masterDarkPath", "masterFlatPath" ], drizzle: false, step: "CALIBRATION", label: "calibration"
      },
      // Local Normalization: per-frame, output is a small .xnml (not an image),
      // attached to the frame via addLocalNormalizationFile (postType localNorm).
      "Local Normalization": {
         proc: LocalNormalization, targetsField: "targetItems", pathIndex: 1,
         fileRefFields: [ "referencePathOrViewId" ], drizzle: false,
         outPrefix: "", outPostfix: "", outExt: ".xnml", postType: "localNorm", label: "localnorm"
      }
   };
}

/*
 * installShim( engine, bridge, options ) -> { active, reason, workers }
 *   options.operations : array of operation names to distribute
 *                        (default: all supported). options.onLog : logger.
 * Inactive => WBPP runs 100% locally (safe fallback). Call before GO.
 */
function installShim( engine, bridge, options )
{
   options = options || {};
   if ( typeof options.onLog == "function" )
      __wbppClusterLog = options.onLog;

   var version = wbppVersionString();
   if ( options.enabled === false )
      return { active: false, reason: "disabled by user" };
   if ( !WBPP_SHIM_COMPAT[ version ] )
   {
      console.warningln( "** Distributed-WBPP: WBPP " + version + " not in the compatibility table; running locally." );
      return { active: false, reason: "unsupported WBPP version " + version };
   }

   var workers = [];
   try { workers = bridge.workers(); } catch ( e ) {}
   if ( workers.length < ( options.minWorkers || 1 ) )
   {
      console.warningln( "** Distributed-WBPP: no clients discovered; running locally." );
      return { active: false, reason: "no workers discovered" };
   }

   // remember the discovered workers (count drives the server/client split; the list
   // feeds the dashboard) and whether the server also processes a shard (default yes).
   bridge.__nWorkers = workers.length;
   bridge.__workerList = workers;
   bridge.__serverWorks = ( options.serverWorks !== false );

   var ops = wbppDistOps();
   var enabled = options.operations || Object.keys( ops );
   wrapQueue( engine, engine.operationQueue, bridge, ops, enabled );

   // Measurements is not a per-group process op — it calls engine.subframeAnalyzer.computeDescriptors.
   // Distribute it too (unless explicitly disabled) via a data-return path.
   if ( options.measurements !== false )
      wrapMeasurements( engine, bridge );

   // Phase 1: distribute calib master integrations across machines in parallel.
   // Uses the sidecar whole-job primitive (whole_job:true) — each indivisible
   // integration is leased to a single free worker; concurrent jobs serialize per
   // worker (no deadlock). Server integrates its own share locally in parallel.
   if ( options.calibIntegration !== false )
      wrapCalibIntegration( engine, bridge );
      wrapLNReference( engine, bridge );

   return { active: true, reason: "ok", workers: workers.length, operations: enabled };
}

// ---- Measurements distribution (SubframeSelector metrics) -------------------
// SS.measurements column indices (WBPP 2.9.1 computeDescriptors, BPP-engine.js).
var SSM = { FWHM: 5, ecc: 6, psfW: 7, SNR: 9, median: 10, mad: 11, noise: 12, stars: 14, Mstar: 26, psfSNR: 28 };

function buildDescriptor( row, filePath )
{
   if ( !row )
      return { filePath: filePath, failed: true };
   var d = {
      filePath: filePath,
      FWHM: row[ SSM.FWHM ], eccentricity: row[ SSM.ecc ], PSFSignalWeight: row[ SSM.psfW ],
      SNR: row[ SSM.SNR ], median: row[ SSM.median ], mad: row[ SSM.mad ], noise: row[ SSM.noise ],
      numberOfStars: row[ SSM.stars ], Mstar: row[ SSM.Mstar ], PSFSNR: row[ SSM.psfSNR ]
   };
   d.failed = !( isFinite( d.FWHM ) && isFinite( d.eccentricity ) && isFinite( d.numberOfStars )
      && isFinite( d.PSFSignalWeight ) && isFinite( d.PSFSNR ) && isFinite( d.SNR )
      && isFinite( d.median ) && isFinite( d.mad ) && isFinite( d.Mstar ) && d.numberOfStars > 0 );
   return d;
}

function wrapMeasurements( engine, bridge )
{
   if ( engine.__wbppMeasureWrapped )
      return;
   if ( !engine.subframeAnalyzer || typeof engine.subframeAnalyzer.computeDescriptors != "function" )
   {
      console.warningln( "** Distributed-WBPP: engine.subframeAnalyzer not found; measurements stay local." );
      return;
   }
   engine.__wbppMeasureWrapped = true;
   var analyzer = engine.subframeAnalyzer;
   var original = analyzer.computeDescriptors;
   analyzer.computeDescriptors = function( fileItems )
   {
      try { return distributeMeasurements( engine, fileItems, bridge, original ); }
      catch ( e )
      {
         __clusterLog( "⚠ measurements: local fallback (" + e.message + ")" );
         return original.call( analyzer, fileItems );
      }
   };
}

function distributeMeasurements( engine, fileItems, bridge, original )
{
   var nWorkers = bridge.__nWorkers || 1;
   var M = fileItems ? fileItems.length : 0;
   if ( M < 2 || nWorkers < 1 || bridge.__serverWorks === false )
      return original.call( engine.subframeAnalyzer, fileItems );

   var label = "measurements";
   var serverCount = __serverCount( label, M, nWorkers );

   var serverItems = fileItems.slice( 0, serverCount );
   var clientItems = fileItems.slice( serverCount );
   var clientPaths = [];
   for ( var i = 0; i < clientItems.length; ++i )
      clientPaths.push( clientItems[ i ].current );

   __measureSplitNote = "  [cluster: " + serverItems.length + " local + " + clientItems.length + " client]";
   __clusterLog( "Measurements: " + M + " frame(s) — " + serverItems.length + " local ∥ " +
      clientItems.length + " cluster (" + ( ( __costServer[ label ] != undefined ) ? "adaptive" : "init" ) + ")" );

   var outTmp = __makeTempDir( "measure" );

   var handle = null;
   if ( clientPaths.length > 0 )
      handle = bridge.distributeAsync( { inputs: clientPaths, op: "measurements", out_dir: outTmp,
         postfix: "", out_ext: ".ssm.json" } );

   // server measures its shard locally (native computeDescriptors -> setDescriptor)
   var T = new ElapsedTime;
   var serverRes = ( serverItems.length > 0 ) ? original.call( engine.subframeAnalyzer, serverItems )
                                              : { nCached: 0, nMeasured: 0, nFailed: 0 };
   var serverSecs = T.value;

   // join: read each client frame's .ssm.json, build the descriptor, attach it
   var report = { collected: 0, failed: 0, elapsed_ms: 0, outputs: [] };
   var nMeasured = 0, nFailed = 0;
   if ( handle )
   {
      try
      {
         report = bridge.distributeWait( handle );
         var rowByBase = {}, outs = __verifiedOutputs( report );
         for ( var o = 0; o < outs.length; ++o )
            try { rowByBase[ String( outs[ o ].input ) ] = JSON.parse( File.readTextFile( outs[ o ].path ) ); }
            catch ( e ) {}
         var leftovers = [];
         for ( var c = 0; c < clientItems.length; ++c )
         {
            var base = File.extractNameAndExtension( clientItems[ c ].current );
            var d = buildDescriptor( rowByBase[ base ], clientItems[ c ].current );
            if ( !d.failed ) { clientItems[ c ].setDescriptor( d ); nMeasured++; }
            else leftovers.push( clientItems[ c ] );   // not returned/invalid -> measure locally
         }
         if ( leftovers.length > 0 )
         {
            __clusterLog( "⚠ measurements: " + leftovers.length + " frame(s) not returned — measuring locally" );
            var r3 = original.call( engine.subframeAnalyzer, leftovers );
            nMeasured += r3.nMeasured; nFailed += r3.nFailed;
         }
      }
      catch ( e )
      {
         __clusterLog( "⚠ measurements cluster failed (" + e.message + ") — local measure" );
         var r2 = original.call( engine.subframeAnalyzer, clientItems );
         nMeasured += r2.nMeasured; nFailed += r2.nFailed;
      }
   }

   __clusterLog( "✓ measurements : server " + serverItems.length + " in " + serverSecs.toFixed( 1 ) +
      "s ∥ cluster " + nMeasured + "/" + clientItems.length + " in " + ( report.elapsed_ms / 1000 ).toFixed( 1 ) + "s" );

   __learnCosts( label, serverSecs, serverItems.length, report.elapsed_ms, clientItems.length, nMeasured );

   return { nCached: serverRes.nCached, nMeasured: serverRes.nMeasured + nMeasured, nFailed: serverRes.nFailed + nFailed };
}

// ---- Calib master integration distribution (Phase 1: whole-job assignment) --

function wrapCalibIntegration( engine, bridge )
{
   var q = engine.operationQueue;
   if ( !q || q.__wbppCalibIntegWrapped )
      return;
   q.__wbppCalibIntegWrapped = true;
   var inner = q.addOperation;
   q.addOperation = function( operation, params )
   {
      if ( operation && operation.name == "Integration" && operation.group
           && typeof ImageType != "undefined" )
      {
         operation.__origRun = operation.run;
         operation.run = function( env, ri )
         {
            if ( operation.__clusterDone )                 // computed as part of a batch
               return operation.__clusterStatus;
            var isLight = ( operation.group.imageType == ImageType.Light );
            var isFlat = ( operation.group.imageType == ImageType.Flat );
            var kind = isLight ? "lights" : ( isFlat ? "flats" : "calib" );
            try
            {
               if ( isLight )
                  return distributeLightBatch( engine, operation, bridge, env, ri );
               return isFlat ? distributeFlatBatch( engine, operation, bridge, env, ri )
                             : distributeCalibBatch( engine, operation, bridge, env, ri );
            }
            catch ( e )
            {
               __clusterLog( "⚠ integration " + kind + ": local fallback (" + e.message + ")" );
               return operation.__origRun.call( operation, env, ri );
            }
         };
      }
      return inner.call( q, operation, params );
   };
}

// gather the ready calib Integration ops starting at firstOp. WBPP interleaves
// unnamed log blocks (addOperationBlock) between the integrations, so we SKIP those
// and only stop at a real named operation (e.g. flat "Calibration" = a dependency
// boundary, since flats need the bias/darkflat masters from this batch).
function gatherCalibBatch( engine, firstOp )
{
   var ops = engine.operationQueue.operations, batch = [];
   for ( var i = firstOp.__index__; i < ops.length; ++i )
   {
      var op = ops[ i ].operation;
      if ( op.name == "Integration" && op.group && op.group.imageType != ImageType.Light )
      {
         var af = op.group.activeFrames();
         if ( af.length < 3 )
            break;
         var ready = true;
         for ( var k = 0; k < af.length; ++k )
            if ( !File.exists( af[ k ].current ) ) { ready = false; break; }
         if ( !ready )
            break;
         batch.push( op );
      }
      else if ( op.name && op.name.length > 0 )
         break;         // a real named op (Calibration, …) => stop at the boundary
      // else: unnamed log block => skip and keep scanning
   }
   return batch;
}

// capture the configured ImageIntegration the op would run (abort local execute)
function captureII( engine, operation, env, ri )
{
   var cap = __captureViaContainer( engine, function() { operation.__origRun.call( operation, env, ri ); } );
   if ( cap.nativeErr )
      throw cap.nativeErr;
   var captured = cap.captured;
   if ( !captured )
      throw new Error( "II not captured (skipped)" );
   if ( !( captured instanceof ImageIntegration ) )
      throw new Error( "captured a non-II process" );
   var frames = [], af = operation.group.activeFrames();
   for ( var i = 0; i < af.length; ++i )
      frames.push( af[ i ].current );
   // per-frame companion files from the captured 4-column rows [enabled, path, xdrz, xnml]
   // (calib integrations have 2-column rows -> none). Shipped as shared_files: a whole-job
   // is leased to exactly ONE worker, so "shared" degenerates to a single upload.
   var companions = [], xdrzByBase = {};
   try
   {
      var rows = captured.images;
      for ( var r = 0; r < rows.length; ++r )
      {
         var dz = ( rows[ r ].length > 2 ) ? String( rows[ r ][ 2 ] ) : "";
         var ln = ( rows[ r ].length > 3 ) ? String( rows[ r ][ 3 ] ) : "";
         if ( dz.length > 0 && File.exists( dz ) )
         {
            companions.push( dz );
            xdrzByBase[ File.extractNameAndExtension( dz ) ] = dz;
         }
         if ( ln.length > 0 && File.exists( ln ) )
            companions.push( ln );
      }
   }
   catch ( e ) {}
   return { source: serializeProcess( captured, "II" ), frames: frames,
            companions: companions, xdrzByBase: xdrzByBase };
}

// finalize a client-integrated image into a WBPP master (keywords + naming + save)
function finalizeMaster( engine, frameGroup, integratedPath )
{
   var w = ImageWindow.open( integratedPath );
   w = ( w instanceof Array ) ? w[ 0 ] : w;
   var kw = [
      new FITSKeyword( "IMAGETYP", StackEngine.imageTypeToMasterKeywordValue( frameGroup.imageType ), "Type of image" ),
      new FITSKeyword( "XBINNING", format( "%d", frameGroup.binning ), "Binning factor, horizontal axis" ),
      new FITSKeyword( "YBINNING", format( "%d", frameGroup.binning ), "Binning factor, vertical axis" ),
      new FITSKeyword( "FILTER", frameGroup.filter, "Filter used when taking image" ),
      new FITSKeyword( "EXPTIME", format( "%.3f", frameGroup.exposureTime ), "Exposure time in seconds" )
   ];
   var uniq = [ "IMAGETYP", "XBINNING", "YBINNING", "FILTER", "EXPTIME" ];
   w.keywords = kw.concat( w.keywords.filter( function( k ) { return uniq.indexOf( k.name ) == -1; } ) );
   var filePath = WBPPUtils.existingAndUniqueFileName( engine.outputDirectory + "/master",
      "master" + frameGroup.folderName( false ) + ".xisf" );
   engine.imageProcessor.writeImage( filePath, [ w ], [ "integration" ] );
   w.forceClose();
   return filePath;
}

// Assign a set of independent integration ops across machines and run them: the
// server integrates its share locally while the cluster integrates the rest as
// whole-jobs (one per free worker, serialized), then finalize each client result
// into a WBPP master. Marks every op __clusterDone with its status.
function dispatchIntegrationBatch( engine, bridge, batch, env, ri, label )
{
   var nWorkers = bridge.__nWorkers || 1, machines = nWorkers + 1, load = [];
   for ( var m = 0; m < machines; ++m ) load.push( 0 );
   for ( var i = 0; i < batch.length; ++i )   // cache the (native) frame count once per op
      batch[ i ].__nFrames = batch[ i ].group.activeFrames().length;
   var order = batch.slice().sort( function( a, b ) { return b.__nFrames - a.__nFrames; } );
   for ( var i = 0; i < order.length; ++i )
   {
      var best = 0, bestLoad = load[ 0 ] * 0.7;   // server cheaper (no transfer)
      for ( var m = 1; m < machines; ++m )
         if ( load[ m ] < bestLoad ) { best = m; bestLoad = load[ m ]; }
      order[ i ].__machine = best;
      load[ best ] += order[ i ].__nFrames;
   }

   var T = new ElapsedTime, handles = [], nLocal = 0, nCluster = 0;
   for ( var i = 0; i < batch.length; ++i )
   {
      var op = batch[ i ];
      if ( op.__machine == 0 )
         continue;
      try
      {
         var cap = captureII( engine, op, env, ri );
         var isLight = ( op.group.imageType == ImageType.Light );
         var outTmp = __makeTempDir( "integ-" + i );
         var h = bridge.distributeAsync( { inputs: cap.frames,
            op: isLight ? "light_integration" : "integration", process_source: cap.source,
            shared_files: isLight ? cap.companions : [],
            out_dir: outTmp, postfix: "", out_ext: ".xisf", whole_job: true } );
         handles.push( { op: op, handle: h, cap: cap, isLight: isLight } );
         nCluster++;
      }
      catch ( e )
      {
         __clusterLog( "⚠ integration capture failed (" + e.message + ") — local" );
         op.__clusterStatus = op.__origRun.call( op, env, ri );  // not capturable -> local
         op.__clusterDone = true; nLocal++;
      }
   }
   for ( var i = 0; i < batch.length; ++i )
      if ( batch[ i ].__machine == 0 && !batch[ i ].__clusterDone )
      {
         batch[ i ].__clusterStatus = batch[ i ].__origRun.call( batch[ i ], env, ri );
         batch[ i ].__clusterDone = true; nLocal++;
      }
   for ( var j = 0; j < handles.length; ++j )
   {
      var cop = handles[ j ].op;
      try
      {
         var vo = __verifiedOutputs( bridge.distributeWait( handles[ j ].handle ) );
         if ( vo.length == 0 )
            throw new Error( "no integrated result" );
         if ( handles[ j ].isLight )
            finalizeLightMaster( engine, cop, vo, handles[ j ].cap );
         else
         {
            var master = finalizeMaster( engine, cop.group, vo[ vo.length - 1 ].path );
            engine.addFile( master );
            cop.statusMessage = cop.__nFrames + " integrated  [cluster]";
         }
         cop.__clusterStatus = OperationBlockStatus.DONE;
      }
      catch ( e )
      {
         __clusterLog( "⚠ integration client failed (" + e.message + ") — local" );
         cop.__clusterStatus = cop.__origRun.call( cop, env, ri );
      }
      cop.__clusterDone = true;
   }
   __clusterLog( "✓ " + label + " : " + batch.length + " master(s) — " + nLocal + " local ∥ " +
      nCluster + " cluster in " + T.value.toFixed( 1 ) + "s" );
}

/*
 * gatherLightBatch — consecutive LIGHT Integration ops (one per filter group)
 * starting at firstOp, skipping WBPP's unnamed log blocks. Stops at any other
 * named op (Autocrop is the natural boundary). Fast Integration groups have a
 * different op name and COMBINED_RGB groups get no "Integration" op, so both
 * are naturally excluded.
 */
function gatherLightBatch( engine, firstOp )
{
   var ops = engine.operationQueue.operations, batch = [];
   for ( var i = firstOp.__index__; i < ops.length; ++i )
   {
      var op = ops[ i ].operation;
      if ( op.name == "Integration" && op.group && op.group.imageType == ImageType.Light )
      {
         if ( op.group.fastIntegrationData && op.group.fastIntegrationData.enabled )
            break;                        // fast-integration flows stay native
         var af = op.group.activeFrames();
         if ( af.length < 3 )
            break;                        // native handles the <3-frames refusal
         var ready = true;
         for ( var k = 0; k < af.length; ++k )
            if ( !File.exists( af[ k ].current ) ) { ready = false; break; }
         if ( !ready )
            break;
         batch.push( op );
      }
      else if ( op.name && op.name.length > 0 )
         break;         // a real named op (Autocrop, ...) => the batch boundary
      // else: unnamed log block => skip and keep scanning
   }
   return batch;
}

// The master-frame metadata doIntegrate applies before writing: WBPP comments,
// unique-merged IMAGETYP/BINNING/FILTER/EXPTIME keywords, signature property and
// the Instrument:Filter:Name image property.
function __applyMasterMetadata( engine, frameGroup, win )
{
   var keywords = [
      new FITSKeyword( "COMMENT", "", "PixInsight image preprocessing pipeline" ),
      new FITSKeyword( "COMMENT", "", "Master frame generated with " + engine.title + " v" + engine.version ),
      new FITSKeyword( "IMAGETYP", StackEngine.imageTypeToMasterKeywordValue( frameGroup.imageType ), "Type of image" ),
      new FITSKeyword( "XBINNING", format( "%d", frameGroup.binning ), "Binning factor, horizontal axis" ),
      new FITSKeyword( "YBINNING", format( "%d", frameGroup.binning ), "Binning factor, vertical axis" ),
      new FITSKeyword( "FILTER", frameGroup.filter, "Filter used when taking image" ),
      new FITSKeyword( "EXPTIME", format( "%.3f", frameGroup.exposureTime ), "Exposure time in seconds" )
   ];
   var uniq = [ "IMAGETYP", "XBINNING", "YBINNING", "FILTER", "EXPTIME" ];
   engine.imageProcessor.generateSignatureProperty( win );
   engine.imageProcessor.setImagePropertyString( win, "Instrument:Filter:Name", frameGroup.filter );
   win.keywords = keywords.concat( win.keywords.filter( function( k ) { return uniq.indexOf( k.name ) == -1; } ) );
}

/*
 * finalizeLightMaster — turn a worker's raw integration bundle into the exact
 * master WBPP's own doIntegrate would have produced, and wire the group state:
 *   - outputs: one .xisf (integration + embedded rejection maps) + the UPDATED
 *     .xdrz drizzle files (only those the integration actually touched);
 *   - copy the updated .xdrz over the server originals (drizzle integration and
 *     autocrop read them from disk);
 *   - write the master with WBPP naming/keywords/signature into out/master and
 *     register it in-memory via frameGroup.setMasterFileName (autocrop +
 *     astrometry read that);
 *   - replicate the native drizzle bookkeeping: frames whose .xdrz was NOT
 *     updated are marked processingFailed (BPP-operations.js light _run).
 */
function finalizeLightMaster( engine, operation, vo, cap )
{
   var frameGroup = operation.group;

   // split the outputs: the single .xisf bundle vs updated .xdrz files
   var bundlePath = null, updatedXdrz = {};
   for ( var i = 0; i < vo.length; ++i )
   {
      var nm = File.extractNameAndExtension( vo[ i ].path );
      if ( /\.xisf$/i.test( nm ) )
         bundlePath = vo[ i ].path;
      else if ( /\.xdrz$/i.test( nm ) )
         updatedXdrz[ nm ] = vo[ i ].path;
   }
   if ( !bundlePath )
      throw new Error( "no master bundle in the outputs" );

   // 1) copy updated drizzle files over the originals (basename-matched)
   var nXdrz = 0;
   for ( var base in updatedXdrz )
      if ( updatedXdrz.hasOwnProperty( base ) && cap.xdrzByBase[ base ] )
      {
         try
         {
            if ( File.exists( cap.xdrzByBase[ base ] ) )
               File.remove( cap.xdrzByBase[ base ] );
            File.copyFile( cap.xdrzByBase[ base ], updatedXdrz[ base ] );
            nXdrz++;
         }
         catch ( e ) { console.warningln( "** Distributed-WBPP: xdrz copy-back failed: " + e.message ); }
      }

   // 2) open the bundle (integration [+ rejection_low [+ rejection_high]])
   var wins = ImageWindow.open( bundlePath );
   if ( !( wins instanceof Array ) )
      wins = [ wins ];
   var win = wins[ 0 ], lowWin = ( wins.length > 1 ) ? wins[ 1 ] : null,
       highWin = ( wins.length > 2 ) ? wins[ 2 ] : null;

   // 3) keywords + signature + filter property, exactly like doIntegrate
   __applyMasterMetadata( engine, frameGroup, win );

   // 4) write with WBPP naming; the high rejection map is embedded only when the
   //    engine embeds rejection maps (doIntegrate: II.clipHigh && embedRejectionMaps)
   var filePath = WBPPUtils.existingAndUniqueFileName( engine.outputDirectory + "/master",
      "master" + frameGroup.folderName( false ) + ".xisf" );
   var outWins = [ win ], outIds = [ "integration" ];
   if ( lowWin != null ) { outWins.push( lowWin ); outIds.push( "rejection_low" ); }
   if ( highWin != null && engine.generateRejectionMaps ) { outWins.push( highWin ); outIds.push( "rejection_high" ); }
   engine.imageProcessor.writeImage( filePath, outWins, outIds );
   for ( var w = 0; w < wins.length; ++w )
      try { wins[ w ].forceClose(); } catch ( e ) {}

   // 5) in-memory wiring + native drizzle bookkeeping
   frameGroup.setMasterFileName( filePath );
   var af = frameGroup.activeFrames();
   if ( frameGroup.isDrizzleEnabled() )
      for ( var f = 0; f < af.length; ++f )
      {
         var dz = af[ f ].drizzleFile;
         if ( dz != undefined && !updatedXdrz[ File.extractNameAndExtension( dz ) ] )
         {
            af[ f ].processingFailed();
            console.writeln( "Drizzle data for frame <raw>" + af[ f ].fileItem.filePath + "</raw> has not been updated." );
         }
      }
   engine.processLogger.addSuccess( "Integration completed", "master Light saved at path " + filePath + " [cluster]" );
   operation.statusMessage = operation.__nFrames + " integrated  [cluster]" +
      ( nXdrz > 0 ? ( ", " + nXdrz + " xdrz updated" ) : "" );
   return filePath;
}

/*
 * -------- LN reference generation (per filter, whole-job) --------------------
 * The "LN reference generation" op calls engine.imageProcessor.generateLNReference:
 * it locally-normalizes the N best frames (a LocalNormalization the op adds to the
 * container FIRST) and then integrates them via doIntegrate with the LN_Reference_
 * prefix (an ImageIntegration added SECOND). We let the LN pass through natively
 * (skipAdds=1) and capture the reference ImageIntegration, then lease it as a
 * whole-job — the worker path is the existing "light_integration" one (4-column
 * rows with .xnml companions; no drizzle, no rejection maps here).
 * The interactive mode has a different op name ("LN reference [interactive]") and
 * is therefore never touched.
 */
function wrapLNReference( engine, bridge )
{
   var q = engine.operationQueue;
   if ( !q || q.__wbppLNRefWrapped )
      return;
   q.__wbppLNRefWrapped = true;
   var inner = q.addOperation;
   q.addOperation = function( operation, params )
   {
      if ( operation && operation.name == "LN reference generation" && operation.group )
      {
         operation.__origRun = operation.run;
         operation.run = function( env, ri )
         {
            if ( operation.__clusterDone )
               return operation.__clusterStatus;
            try
            {
               return distributeLNRefBatch( engine, operation, bridge, env, ri );
            }
            catch ( e )
            {
               __clusterLog( "⚠ LN reference: local fallback (" + e.message + ")" );
               return operation.__origRun.call( operation, env, ri );
            }
         };
      }
      return inner.call( q, operation, params );
   };
}

function gatherLNRefBatch( engine, firstOp )
{
   var ops = engine.operationQueue.operations, batch = [];
   for ( var i = firstOp.__index__; i < ops.length; ++i )
   {
      var op = ops[ i ].operation;
      if ( op.name == "LN reference generation" && op.group )
         batch.push( op );
      else if ( op.name && op.name.length > 0 )
         break;         // next named op (first "Local Normalization") = boundary
      // else: unnamed log block => skip
   }
   return batch;
}

// Run the op natively up to the reference integration: the inner LN of the best
// frames executes locally (its bookkeeping intact), the ImageIntegration that
// follows is captured. Returns { source, frames, companions } for the job.
function captureLNRefII( engine, operation, env, ri )
{
   var cap = __captureViaContainer( engine,
      function() { operation.__origRun.call( operation, env, ri ); }, 1 /* let the LN through */ );
   if ( cap.nativeErr )
      throw cap.nativeErr;
   var captured = cap.captured;
   if ( !captured )
      throw new Error( "reference II not captured (native path completed)" );
   if ( !( captured instanceof ImageIntegration ) )
      throw new Error( "captured a non-II process" );
   var frames = [], companions = [];
   var rows = captured.images;
   for ( var r = 0; r < rows.length; ++r )
   {
      frames.push( String( rows[ r ][ 1 ] ) );
      var ln = ( rows[ r ].length > 3 ) ? String( rows[ r ][ 3 ] ) : "";
      if ( ln.length > 0 && File.exists( ln ) )
         companions.push( ln );
   }
   return { source: serializeProcess( captured, "II" ), frames: frames, companions: companions };
}

// Write the worker's integration as the LN_Reference master (doIntegrate naming:
// prefix LN_Reference_, empty postfix, no rejection maps) and wire the group.
function finalizeLNReference( engine, operation, vo, cap )
{
   var frameGroup = operation.group;
   var bundlePath = null;
   for ( var i = 0; i < vo.length; ++i )
      if ( /\.xisf$/i.test( vo[ i ].path ) )
         bundlePath = vo[ i ].path;
   if ( !bundlePath )
      throw new Error( "no reference integration in the outputs" );

   var wins = ImageWindow.open( bundlePath );
   var win = ( wins instanceof Array ) ? wins[ 0 ] : wins;
   __applyMasterMetadata( engine, frameGroup, win );
   var filePath = WBPPUtils.existingAndUniqueFileName( engine.outputDirectory + "/master",
      "LN_Reference_" + frameGroup.folderName( false ) + ".xisf" );
   engine.imageProcessor.writeImage( filePath, [ win ], [ "integration" ] );
   try { win.forceClose(); } catch ( e ) {}

   frameGroup.__ln_reference_frame__ = filePath;
   engine.processLogger.addSuccess( "Local normalization",
      "reference frame generated by integrating " + cap.frames.length + " frames [cluster]" );
   operation.statusMessage = "reference integrated  [cluster]";
   return filePath;
}

// Batch the consecutive LN-reference ops: each op's inner LN runs locally in turn,
// its reference integration is leased to the cluster; the server integrates its own
// share natively while the cluster works.
function dispatchLNRefBatch( engine, bridge, batch, env, ri )
{
   var nWorkers = bridge.__nWorkers || 1, machines = nWorkers + 1, load = [];
   for ( var m = 0; m < machines; ++m ) load.push( 0 );
   for ( var i = 0; i < batch.length; ++i )
      batch[ i ].__nFrames = batch[ i ].group.activeFrames().length;
   var order = batch.slice().sort( function( a, b ) { return b.__nFrames - a.__nFrames; } );
   for ( var i = 0; i < order.length; ++i )
   {
      var best = 0, bestLoad = load[ 0 ] * 0.7;   // server cheaper (no transfer)
      for ( var m = 1; m < machines; ++m )
         if ( load[ m ] < bestLoad ) { best = m; bestLoad = load[ m ]; }
      order[ i ].__machine = best;
      load[ best ] += order[ i ].__nFrames;
   }

   var T = new ElapsedTime, handles = [], nLocal = 0, nCluster = 0;
   for ( var i = 0; i < batch.length; ++i )
   {
      var op = batch[ i ];
      if ( op.__machine == 0 )
         continue;
      try
      {
         var cap = captureLNRefII( engine, op, env, ri );
         var outTmp = __makeTempDir( "lnref-" + i );
         var h = bridge.distributeAsync( { inputs: cap.frames, op: "light_integration",
            process_source: cap.source, shared_files: cap.companions,
            out_dir: outTmp, postfix: "", out_ext: ".xisf", whole_job: true } );
         handles.push( { op: op, handle: h, cap: cap } );
         nCluster++;
      }
      catch ( e )
      {
         __clusterLog( "⚠ LN reference capture failed (" + e.message + ") — local" );
         op.__clusterStatus = op.__origRun.call( op, env, ri );
         op.__clusterDone = true; nLocal++;
      }
   }
   for ( var i = 0; i < batch.length; ++i )
      if ( batch[ i ].__machine == 0 && !batch[ i ].__clusterDone )
      {
         batch[ i ].__clusterStatus = batch[ i ].__origRun.call( batch[ i ], env, ri );
         batch[ i ].__clusterDone = true; nLocal++;
      }
   for ( var j = 0; j < handles.length; ++j )
   {
      var cop = handles[ j ].op;
      try
      {
         var vo = __verifiedOutputs( bridge.distributeWait( handles[ j ].handle ) );
         if ( vo.length == 0 )
            throw new Error( "no reference result" );
         finalizeLNReference( engine, cop, vo, handles[ j ].cap );
         cop.__clusterStatus = OperationBlockStatus.DONE;
      }
      catch ( e )
      {
         __clusterLog( "⚠ LN reference client failed (" + e.message + ") — local" );
         cop.__clusterStatus = cop.__origRun.call( cop, env, ri );
      }
      cop.__clusterDone = true;
   }
   __clusterLog( "✓ LN reference : " + batch.length + " reference(s) — " + nLocal + " local ∥ " +
      nCluster + " cluster in " + T.value.toFixed( 1 ) + "s" );
}

function distributeLNRefBatch( engine, firstOp, bridge, env, ri )
{
   var batch = gatherLNRefBatch( engine, firstOp );
   if ( batch.length <= 1 || ( bridge.__nWorkers || 0 ) < 1 )
      return firstOp.__origRun.call( firstOp, env, ri );
   dispatchLNRefBatch( engine, bridge, batch, env, ri );
   return firstOp.__clusterStatus;
}

// Lease the final per-filter LIGHT integrations across the cluster (whole-jobs).
// Autocrop and the astrometric solution stay LOCAL by design: autocrop is a single
// global op that crops all filters to the intersection of their crop rects, and
// plate-solving needs a per-node Gaia XPSD database / network catalog.
function distributeLightBatch( engine, firstOp, bridge, env, ri )
{
   var batch = gatherLightBatch( engine, firstOp );
   if ( batch.length <= 1 || ( bridge.__nWorkers || 0 ) < 1 )
      return firstOp.__origRun.call( firstOp, env, ri );
   dispatchIntegrationBatch( engine, bridge, batch, env, ri, "integration lights" );
   return firstOp.__clusterStatus;
}

function distributeCalibBatch( engine, firstOp, bridge, env, ri )
{
   var batch = gatherCalibBatch( engine, firstOp );
   if ( batch.length <= 1 || ( bridge.__nWorkers || 0 ) < 1 )
      return firstOp.__origRun.call( firstOp, env, ri );
   dispatchIntegrationBatch( engine, bridge, batch, env, ri, "integration calib" );
   return firstOp.__clusterStatus;
}

// Flats are interleaved Cal/Int in the queue (Cal-H, Int-H, Cal-O, Int-O, …). Gather
// all flat Cal + Int ops from the first flat Integration up to the light phase.
function gatherFlatBatch( engine, firstOp )
{
   var ops = engine.operationQueue.operations, ints = [], cals = [];
   for ( var i = firstOp.__index__; i < ops.length; ++i )
   {
      var op = ops[ i ].operation;
      if ( !op.group || op.group.imageType == ImageType.Light )
      {
         if ( op.name && op.name.length > 0 ) break;  // light phase / other named op
         continue;                                    // unnamed log block
      }
      if ( op.name == "Integration" && op.group.imageType == ImageType.Flat )
         ints.push( op );
      else if ( op.name == "Calibration" && op.group.imageType == ImageType.Flat )
         cals.push( op );
      else if ( op.name && op.name.length > 0 )
         break;
   }
   return { ints: ints, cals: cals };
}

// Take over at the first flat Integration: run the not-yet-executed flat calibrations
// locally (cheap) so every calibrated flat exists, then batch the flat integrations.
// Masters are produced BEFORE the light phase, so masterFlatPath resolves normally.
function distributeFlatBatch( engine, firstOp, bridge, env, ri )
{
   var fb = gatherFlatBatch( engine, firstOp );
   if ( fb.ints.length <= 1 || ( bridge.__nWorkers || 0 ) < 1 )
      return firstOp.__origRun.call( firstOp, env, ri );
   for ( var c = 0; c < fb.cals.length; ++c )
      if ( !fb.cals[ c ].__clusterDone )
      {
         fb.cals[ c ].__clusterStatus = fb.cals[ c ].run( env, ri ); // wrapped run -> local flat cal
         fb.cals[ c ].__clusterDone = true;
      }
   dispatchIntegrationBatch( engine, bridge, fb.ints, env, ri, "integration flats" );
   return firstOp.__clusterStatus;
}

function wrapQueue( engine, queue, bridge, ops, enabledNames )
{
   if ( !queue || typeof queue.addOperation != "function" )
   {
      console.warningln( "** Distributed-WBPP: engine.operationQueue not found; running locally." );
      return;
   }
   if ( queue.__wbppClusterWrapped )
      return;
   queue.__wbppClusterWrapped = true;

   var inner = queue.addOperation;
   queue.addOperation = function( operation, params )
   {
      if ( operation && ops[ operation.name ] && enabledNames.indexOf( operation.name ) >= 0 )
      {
         var descriptor = ops[ operation.name ];
         var originalRun = operation.run;
         operation.run = function( env, ri )
         {
            if ( operation.__clusterDone )   // pre-run as part of a flat batch
               return operation.__clusterStatus;
            try
            {
               return captureAndDistribute( engine, operation, descriptor, bridge, originalRun, env, ri );
            }
            catch ( e )
            {
               console.warningln( "** Distributed-WBPP: '" + operation.name + "' distribution failed (" + e.message + "); local fallback." );
               __clusterLog( "✗ " + descriptor.label + " failed (" + e.message + ") — local fallback" );
               return originalRun.call( operation, env, ri );
            }
         };
      }
      else if ( operation && operation.name == "Measurements" )
      {
         // Measurements distributes via the computeDescriptors wrap, not here; we
         // only append the cluster split to its status once its native _run has set
         // the "N measured" message (WBPP would otherwise overwrite ours).
         var measureRun = operation.run;
         operation.run = function( env, ri )
         {
            __measureSplitNote = "";
            var r = measureRun.call( operation, env, ri );
            if ( __measureSplitNote.length > 0 )
               operation.statusMessage = ( operation.statusMessage || "" ) + __measureSplitNote;
            return r;
         };
      }
      return inner.call( queue, operation, params );
   };
}

/*
 * captureAndDistribute — the heart of the generic distribution. Captures the
 * configured process the operation builds, distributes it, and post-processes.
 */
function captureAndDistribute( engine, operation, descriptor, bridge, originalRun, env, ri )
{
   var group = operation.group;
   if ( !group )
      return originalRun.call( operation, env, ri );

   // Only distribute LIGHT frames: their per-frame processing is heavy enough to
   // justify the network transfer. Calibrating flats/darks/bias is trivial compute
   // on big files, so distributing them is a net loss — run those locally.
   if ( typeof ImageType != "undefined" && group.imageType != undefined && group.imageType != ImageType.Light )
      return originalRun.call( operation, env, ri );

   var activeFrames = group.activeFrames();
   if ( activeFrames.length == 0 )
      return originalRun.call( operation, env, ri );

   // WBPP 3.0 Fast Integration splits calibration into two passes with different
   // measurement behavior; run those groups locally rather than model that flow.
   if ( group.fastIntegrationData && group.fastIntegrationData.enabled )
      return originalRun.call( operation, env, ri );

   // 1) capture the fully-configured process at processContainer.add (the op sets
   //    the FULL target list right before adding); abort native _run before it
   //    executes. Save/restore group.fileItems because some operations
   //    (calibration) temporarily subset it during _run.
   var savedItems = group.fileItems;
   var cap;
   try { cap = __captureViaContainer( engine, function() { originalRun.call( operation, env, ri ); } ); }
   finally { try { group.fileItems = savedItems; } catch ( e ) {} }

   if ( cap.nativeErr )
      throw cap.nativeErr; // a genuine error before the capture point
   var captured = cap.captured;
   if ( !captured )
      return originalRun.call( operation, env, ri ); // nothing to run (skipped op)
   if ( !( captured instanceof descriptor.proc ) )
   {
      // an unexpected process reached the container first — don't touch it
      __clusterLog( "⚠ " + descriptor.label + ": captured a " + ( captured.processId ? captured.processId() : "?" ) + " — local fallback" );
      return originalRun.call( operation, env, ri );
   }

   // 2) run it: the SERVER processes its own shard locally WHILE the clients
   //    process the rest in parallel — no machine sits idle (measured ~1.65x with
   //    one client on Ethernet; scales toward (nClients+1)x with size).
   var P = captured;
   var inputs = activeFrames.map( function( f ) { return f.current; } );

   var sharedFiles = [];
   var fileRefs = {};
   for ( var k = 0; k < descriptor.fileRefFields.length; ++k )
   {
      var field = descriptor.fileRefFields[ k ];
      var v = P[ field ];
      if ( v && String( v ).length > 0 && File.exists( v ) )
      {
         fileRefs[ field ] = v;
         sharedFiles.push( v );
      }
   }

   var source  = serializeProcess( P, "P" );
   var outDir  = P.outputDirectory;
   // LocalNormalization leaves outputDirectory empty and writes each .xnml next to
   // its input frame. Fall back to the input frames' directory so both the
   // server-local outputs and the downloaded client outputs land where WBPP expects.
   if ( !outDir || outDir.length == 0 )
      outDir = File.extractDrive( inputs[ 0 ] ) + File.extractDirectory( inputs[ 0 ] );
   // output naming: from the descriptor when it overrides (e.g. LN => .xnml),
   // else from the process's own output* params (StarAlignment / ImageCalibration).
   var prefix  = ( descriptor.outPrefix  != undefined ) ? descriptor.outPrefix  : P.outputPrefix;
   var postfix = ( descriptor.outPostfix != undefined ) ? descriptor.outPostfix : P.outputPostfix;
   var ext     = ( descriptor.outExt     != undefined ) ? descriptor.outExt     : P.outputExtension;

   // adaptive split: allocate frames so the server lane and the cluster lane
   // finish together — serverShare ∝ 1/serverCost. Bootstrap with an even split
   // until we have a measurement for this operation.
   var nWorkers = bridge.__nWorkers || 1;
   var label = descriptor.label;
   var M = inputs.length;
   var serverCount = ( bridge.__serverWorks === false ) ? 0 : __serverCount( label, M, nWorkers );

   var serverInputs = inputs.slice( 0, serverCount );
   var clientInputs = inputs.slice( serverCount );
   __clusterLog( "Group " + group.folderName() + " : " + M + " frame(s) — " +
      serverInputs.length + " local ∥ " + clientInputs.length + " cluster (" + label +
      ( ( __costServer[ label ] != undefined ) ? ", adaptive" : ", init" ) + ")" );

   function targetRows( paths )
   {
      var rows = [];
      for ( var s = 0; s < paths.length; ++s )
         rows.push( ( descriptor.pathIndex == 1 ) ? [ true, paths[ s ] ] : [ true, true, paths[ s ] ] );
      return rows;
   }

   // start the client shard asynchronously (non-blocking)
   var handle = null;
   if ( clientInputs.length > 0 )
      handle = bridge.distributeAsync(
      {
         inputs: clientInputs, shared_files: sharedFiles, file_ref_fields: fileRefs,
         op: descriptor.label, process_source: source, out_dir: outDir,
         prefix: prefix, postfix: postfix, out_ext: ext,
         targets_field: descriptor.targetsField, path_index: descriptor.pathIndex, drizzle: descriptor.drizzle
      } );

   // meanwhile, process the server shard locally
   var T = new ElapsedTime;
   if ( serverInputs.length > 0 )
   {
      try { P.outputDirectory = outDir; } catch ( e ) {} // force LN's empty dir to the resolved one
      P[ descriptor.targetsField ] = targetRows( serverInputs );
      P.executeGlobal();
   }
   var serverSecs = T.value;

   // join: wait for the cluster. On cluster failure, run those frames locally too
   // (server's are already done) so we never lose frames.
   var report = { collected: 0, failed: 0, workers: 0, elapsed_ms: 0 };
   if ( handle )
   {
      try { report = bridge.distributeWait( handle ); }
      catch ( e )
      {
         __clusterLog( "⚠ cluster failed (" + e.message + ") — " + clientInputs.length + " frame(s) locally" );
         P[ descriptor.targetsField ] = targetRows( clientInputs );
         P.executeGlobal();
      }
   }
   __clusterLog( "✓ " + descriptor.label + " : server " + serverInputs.length + " in " + serverSecs.toFixed( 1 ) +
      "s ∥ cluster " + report.collected + "/" + clientInputs.length + " in " + ( report.elapsed_ms / 1000 ).toFixed( 1 ) + "s" );

   // learn per-frame costs (incl. transfer for the cluster) for the next split
   __learnCosts( label, serverSecs, serverInputs.length, report.elapsed_ms, clientInputs.length, report.collected );

   // 3) post-processing (unified): server-local and client outputs both land in
   //    outDir with the same naming, so just check each frame's expected file.
   // any client frame whose expected output is missing gets processed locally
   // (partial cluster shortfalls must never lose frames)
   var missing = [];
   for ( var mI = 0; mI < clientInputs.length; ++mI )
   {
      var mOut = outDir + "/" + prefix + File.extractName( clientInputs[ mI ] ) + postfix + ext;
      if ( !File.exists( mOut ) )
         missing.push( clientInputs[ mI ] );
   }
   if ( missing.length > 0 && missing.length < clientInputs.length )
   {
      __clusterLog( "⚠ " + descriptor.label + ": " + missing.length + " output(s) missing — running locally" );
      P[ descriptor.targetsField ] = targetRows( missing );
      try { P.executeGlobal(); } catch ( e ) {}
   }

   var step = ( descriptor.step != undefined ) ? BPP.FrameProcessingStep[ descriptor.step ] : undefined;
   var nOK = 0, nFail = 0;
   for ( var c = 0; c < activeFrames.length; ++c )
   {
      var inputFile = activeFrames[ c ].current;
      var outputFile = outDir + "/" + prefix + File.extractName( inputFile ) + postfix + ext;
      if ( outputFile && File.exists( outputFile ) )
      {
         if ( descriptor.postType == "localNorm" )
            activeFrames[ c ].addLocalNormalizationFile( outputFile );  // .xnml attached to the frame
         else
            activeFrames[ c ].processingSucceeded( step, outputFile );
         if ( descriptor.drizzle )
         {
            var drz = File.changeExtension( outputFile, ".xdrz" );
            if ( File.exists( drz ) )
               activeFrames[ c ].addDrizzleFile( drz );
         }
         nOK++;
      }
      else
      {
         activeFrames[ c ].processingFailed();
         nFail++;
      }
   }

   // shown in the Execution Monitor's last column (BPP-engine.js:1410) — append
   // the cluster split so the operator sees the distribution per group.
   operation.statusMessage = WBPPUtils.resultCountToString( 0, nOK, nFail, descriptor.label ) +
      "  [cluster: " + serverInputs.length + " local + " + clientInputs.length + " client]";
   operation.hasWarnings = nFail > 0;
   console.noteln( "* Distributed-WBPP: " + descriptor.label + " — " + nOK + " ok, " + nFail + " failed." );
   return ( nFail > 0 && nOK == 0 ) ? OperationBlockStatus.FAILED : OperationBlockStatus.DONE;
}

#endif // __WBPP_WBPPShim_js
