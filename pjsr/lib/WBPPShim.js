/*
 * WBPPShim.js — graft cluster distribution onto the native WBPP engine.
 *
 * Mechanism (validated primitives on PixInsight 1.9.3):
 *   - <Process>.prototype.executeGlobal CAN be monkey-patched (probe ✅);
 *   - process.outputData is READ-ONLY (probe ❌) — so we cannot let WBPP's native
 *     post-processing run off our results.
 * Therefore, for a distributable operation we:
 *   1. temporarily override the operation's process class executeGlobal to
 *      CAPTURE the fully-configured instance (masters, params, output dir) and
 *      abort the native _run (sentinel throw) BEFORE its outputData-based
 *      post-processing;
 *   2. distribute the captured process over the cluster (the sidecar transfers
 *      the referenced shared files — masters/reference — once, checksum-cached);
 *   3. run our OWN post-processing: processingSucceeded/addDrizzleFile per frame.
 *
 * This needs no replication of WBPP's process-building code (WBPP builds it; we
 * capture it), so it's the same tiny surface for every operation and more
 * update-resistant. Anchored to operation names + process field names, which are
 * stable across WBPP 2.9.x.
 *
 * ============================ WBPP 2.9.1 anchors ============================
 * Operations are BPPOperationBlock(name, group, ...): names "Registration"
 * (StarAlignment.targets, ref=referenceImage, out "_r"+drizzle) and "Calibration"
 * (ImageCalibration.targetFrames, masters=masterBias/Dark/FlatPath, out "_c").
 * Post-processing uses frame.processingSucceeded(step, out) / processingFailed().
 * ===========================================================================
 */

#ifndef __WBPP_WBPPShim_js
#define __WBPP_WBPPShim_js

#include "ProcessSerializer.js"

// WBPP versions whose operation names + process fields we've verified.
var WBPP_SHIM_COMPAT = { "2.9.1": true };

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

   var version = ( typeof WBPP_VERSION != "undefined" ) ? WBPP_VERSION : "unknown";
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

   // Measurements is not a per-group process op — it calls engine.computeDescriptors.
   // Distribute it too (unless explicitly disabled) via a data-return path.
   if ( options.measurements !== false )
      wrapMeasurements( engine, bridge );

   // Phase 1: distribute calib master integrations across machines in parallel.
   // Uses the sidecar whole-job primitive (whole_job:true) — each indivisible
   // integration is leased to a single free worker; concurrent jobs serialize per
   // worker (no deadlock). Server integrates its own share locally in parallel.
   if ( options.calibIntegration !== false )
      wrapCalibIntegration( engine, bridge );

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
   engine.__wbppMeasureWrapped = true;
   var original = engine.computeDescriptors;
   engine.computeDescriptors = function( fileItems )
   {
      try { return distributeMeasurements( engine, fileItems, bridge, original ); }
      catch ( e )
      {
         __clusterLog( "⚠ measurements: local fallback (" + e.message + ")" );
         return original.call( engine, fileItems );
      }
   };
}

function distributeMeasurements( engine, fileItems, bridge, original )
{
   var nWorkers = bridge.__nWorkers || 1;
   var M = fileItems ? fileItems.length : 0;
   if ( M < 2 || nWorkers < 1 || bridge.__serverWorks === false )
      return original.call( engine, fileItems );

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
   var serverRes = ( serverItems.length > 0 ) ? original.call( engine, serverItems )
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
         for ( var c = 0; c < clientItems.length; ++c )
         {
            var base = File.extractNameAndExtension( clientItems[ c ].current );
            var d = buildDescriptor( rowByBase[ base ], clientItems[ c ].current );
            if ( !d.failed ) { clientItems[ c ].setDescriptor( d ); nMeasured++; }
            else { clientItems[ c ].processingFailed(); nFailed++; }
         }
      }
      catch ( e )
      {
         __clusterLog( "⚠ measurements cluster failed (" + e.message + ") — local measure" );
         var r2 = original.call( engine, clientItems );
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
           && typeof ImageType != "undefined" && operation.group.imageType != ImageType.LIGHT )
      {
         operation.__origRun = operation.run;
         operation.run = function( env, ri )
         {
            if ( operation.__clusterDone )                 // computed as part of a batch
               return operation.__clusterStatus;
            var isFlat = ( operation.group.imageType == ImageType.FLAT );
            try
            {
               return isFlat ? distributeFlatBatch( engine, operation, bridge, env, ri )
                             : distributeCalibBatch( engine, operation, bridge, env, ri );
            }
            catch ( e )
            {
               __clusterLog( "⚠ integration " + ( isFlat ? "flats" : "calib" ) + ": local fallback (" + e.message + ")" );
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
      if ( op.name == "Integration" && op.group && op.group.imageType != ImageType.LIGHT )
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
function captureII( operation, env, ri )
{
   var captured = null;
   var proto = ImageIntegration.prototype, orig = proto.executeGlobal;
   proto.executeGlobal = function() { captured = this; throw __WBPP_CAPTURE_SENTINEL; };
   try { operation.__origRun.call( operation, env, ri ); }
   catch ( e ) { if ( e !== __WBPP_CAPTURE_SENTINEL ) { proto.executeGlobal = orig; throw e; } }
   proto.executeGlobal = orig;
   if ( !captured )
      throw new Error( "II not captured (cached)" );
   var frames = [], af = operation.group.activeFrames();
   for ( var i = 0; i < af.length; ++i )
      frames.push( af[ i ].current );
   return { source: serializeProcess( captured, "II" ), frames: frames };
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
   engine.writeImage( filePath, [ w ], [ "integration" ] );
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
         var cap = captureII( op, env, ri );
         var outTmp = __makeTempDir( "integ-" + i );
         var h = bridge.distributeAsync( { inputs: cap.frames, op: "integration", process_source: cap.source,
            out_dir: outTmp, postfix: "", out_ext: ".xisf", whole_job: true } );
         handles.push( { op: op, handle: h } );
         nCluster++;
      }
      catch ( e )
      {
         op.__clusterStatus = op.__origRun.call( op, env, ri );  // cached / not capturable -> local
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
         var master = finalizeMaster( engine, cop.group, vo[ vo.length - 1 ].path );
         engine.addFile( master );
         cop.statusMessage = cop.__nFrames + " integrated  [cluster]";
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
      nCluster + " cluster en " + T.value.toFixed( 1 ) + "s" );
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
      if ( !op.group || op.group.imageType == ImageType.LIGHT )
      {
         if ( op.name && op.name.length > 0 ) break;  // light phase / other named op
         continue;                                    // unnamed log block
      }
      if ( op.name == "Integration" && op.group.imageType == ImageType.FLAT )
         ints.push( op );
      else if ( op.name == "Calibration" && op.group.imageType == ImageType.FLAT )
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
   if ( typeof ImageType != "undefined" && group.imageType != undefined && group.imageType != ImageType.LIGHT )
      return originalRun.call( operation, env, ri );

   var activeFrames = group.activeFrames();
   if ( activeFrames.length == 0 )
      return originalRun.call( operation, env, ri );

   // 1) capture the fully-configured process; abort native _run before its
   //    outputData-based post-processing. Save/restore group.fileItems because
   //    some operations (calibration) temporarily subset it during _run.
   var captured = null;
   var proc = descriptor.proc;
   var savedItems = group.fileItems;
   var origExec = proc.prototype.executeGlobal;
   proc.prototype.executeGlobal = function() { captured = this; throw __WBPP_CAPTURE_SENTINEL; };
   var nativeErr = null;
   try { originalRun.call( operation, env, ri ); }
   catch ( e ) { if ( e !== __WBPP_CAPTURE_SENTINEL ) nativeErr = e; }
   finally
   {
      proc.prototype.executeGlobal = origExec;
      try { group.fileItems = savedItems; } catch ( e ) {}
   }

   if ( nativeErr )
      throw nativeErr; // a genuine error before executeGlobal
   if ( !captured )
      return originalRun.call( operation, env, ri ); // nothing to run (all cached/skipped)

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
   __clusterLog( "Groupe " + group.folderName() + " : " + M + " frame(s) — " +
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
   var step = ( descriptor.step != undefined ) ? WBPPFrameProcessingStep[ descriptor.step ] : undefined;
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
