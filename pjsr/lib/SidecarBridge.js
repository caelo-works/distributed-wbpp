/*
 * SidecarBridge.js — the PJSR side of Distributed-WBPP.
 *
 * Transport decision (validated on PixInsight 1.9.3, 2026-06-30):
 *   - ExternalProcess LAUNCHES the sidecar reliably, but does NOT capture child
 *     stdout (P.stdout came back empty). PJSR File I/O, however, is rock solid.
 *   => Every request/response goes through FILES: we run the sidecar via
 *      ExternalProcess with --out-file / --in-file and read the result with
 *      File.readTextFile. No NetworkTransfer, no reliance on stdout.
 *
 * Roles:
 *   - server/agent: each call is a ONE-SHOT sidecar invocation (it does its own
 *     short LAN discovery, then exits). No long-lived daemon needed.
 *   - worker: ONE long-lived daemon (serves the LAN + holds the pull queue);
 *     pull/report go through the `ctl` subcommands (thin local HTTP clients in
 *     Go) via files.
 */

#ifndef __WBPP_SidecarBridge_js
#define __WBPP_SidecarBridge_js

function SidecarBridge( options )
{
   this.binaryPath      = options.binaryPath;             // absolute path to the sidecar for this OS
   this.token           = options.token       || "default";
   this.role            = options.role        || "server"; // "server"/"agent" | "worker"
   this.piVersion       = options.piVersion   || "unknown";
   this.wbppVersion     = options.wbppVersion || "unknown";
   this.dataDir         = options.dataDir     || "";       // worker: received frames + outputs
   this.workerPort      = options.workerPort  || 0;        // worker: LAN port (0 = auto)
   this.controlPort     = options.controlPort || 48099;    // worker: local ctl port
   this.discoverSeconds = options.discoverSeconds || 3;    // server: LAN discovery window
   this.distributeTO    = options.distributeTimeout || "30m"; // server: max wait for a distributed job
   this.peers           = options.peers || "";            // agent: static worker host:port list (bench; bypasses multicast)

   this.daemon = null;
   this._seq = 0;
   // Unique per-run id so temp job/report files never collide with a previous
   // run's files in the shared temp dir (which caused stale/offset report reads).
   this._session = "" + ( new Date ).getTime();

   // ---- lifecycle ----------------------------------------------------------

   // Optional path for the sidecar daemon's own log (diagnostics). Set from the
   // caller's log dir so it lands on the shared drive.
   this.logDir = options.logDir || "";

   this.start = function()
   {
      // Inlined (no helper-method calls) so nothing can be "not a function".
      var common = [ "--token", this.token, "--pi-version", this.piVersion, "--wbpp-version", this.wbppVersion ];
      var isWorker = ( this.role == "worker" );
      var logArgs = this.logDir ? [ "--log-file", this.logDir + "/sidecar-" + ( isWorker ? "worker" : "agent" ) + ".log" ] : [];
      var args;
      if ( isWorker )
      {
         args = [ "--mode", "worker", "--executor", "pull",
                  "--port", String( this.workerPort ),
                  "--control-port", String( this.controlPort ),
                  "--dir", this.dataDir ].concat( common ).concat( logArgs );
      }
      else
      {
         // Persistent agent: stays up for the whole WBPP run, discovers workers
         // continuously (no per-group re-discovery), keeps the master cache warm.
         // --postfix "" so the agent does NOT force an empty job postfix to "_r"
         // (Local Normalization needs an empty postfix: output is <base>.xnml).
         args = [ "--mode", "agent", "--control-port", String( this.controlPort ),
                  "--postfix", "" ]
                  .concat( this.peers ? [ "--peers", this.peers ] : [] )
                  .concat( common ).concat( logArgs );
      }

      // Clear any stale sidecar on THIS machine before launching a fresh one, so
      // relaunching is safe: no zombie agent holds the control port / leftover
      // requests, and no duplicate worker keeps advertising. Windows-only effect
      // (taskkill); harmless elsewhere. Assumes one role per machine (a 2-PC
      // cluster) — do NOT run server and worker on the same host.
      try
      {
         var K = new ExternalProcess;
         K.start( "taskkill", [ "/F", "/IM", "wbpp-sidecar.exe" ] );
         if ( K.waitForFinished ) K.waitForFinished( 3000 );
      }
      catch ( e ) {}
      msleep( 400 );

      this.daemon = new ExternalProcess;
      this.daemon.start( this.binaryPath, args );
      if ( this.daemon.waitForStarted && !this.daemon.waitForStarted() )
         throw new Error( "Failed to start sidecar: " + this.binaryPath );
      msleep( 800 ); // let it bind + (worker) advertise / (agent) start browsing
      return this;
   };

   this.stop = function()
   {
      if ( this.daemon )
      {
         try { this.daemon.terminate(); } catch ( e ) {}
         if ( this.daemon.waitForFinished )
            this.daemon.waitForFinished( 1500 );
         // terminate() can be ignored by a console app on Windows; force-kill so
         // the process doesn't linger (and keep locking the shared binary).
         try { if ( this.daemon.isRunning && this.daemon.kill ) this.daemon.kill(); } catch ( e ) {}
         this.daemon = null;
      }
   };

   // ---- server/agent role --------------------------------------------------

   /*
    * Workers currently discovered by the persistent agent. Polls for up to
    * ~waitMs (default 12s) since the agent needs a beacon cycle to discover a
    * peer after it starts. Returns as soon as at least one worker appears.
    */
   this.workers = function( waitMs, settleMs )
   {
      if ( waitMs == undefined ) waitMs = 12000;
      // Beacons arrive every 2s (BeaconInterval), so a second/third worker shows up a
      // cycle after the first. Don't return on the first-seen — keep polling until the
      // count has been STABLE for settleMs, so we collect the WHOLE cluster.
      if ( settleMs == undefined ) settleMs = 3000;
      var start = ( new Date ).getTime(), lastGrow = start, best = [];
      for ( ;; )
      {
         var out = this._tmp( "nodes.json" );
         this._runOneShot( [ "ctl", "nodes", "--control-port", String( this.controlPort ), "--out-file", out ] );
         var r = this._readJSON( out );
         var list = ( r && r.workers ) ? r.workers : [];
         if ( list.length > best.length ) { best = list; lastGrow = ( new Date ).getTime(); }
         var now = ( new Date ).getTime();
         if ( ( best.length > 0 && now - lastGrow >= settleMs ) || now - start > waitMs )
            return best;
         msleep( 500 );
      }
   };

   /*
    * Run a distributed job through the persistent agent (no per-group discovery).
    * `job` is a DistributeJob; returns the JobReport
    * { collected, failed, outputs:[{input,output,path,verified}] }.
    */
   this.distribute = function( job )
   {
      return this.distributeWait( this.distributeAsync( job ) );
   };

   /*
    * Start a distributed job WITHOUT blocking, so the server can do its own share
    * of the work meanwhile. Returns a handle to pass to distributeWait().
    */
   this.distributeAsync = function( job )
   {
      var jf = this._tmp( "job.json" );
      var rf = this._tmp( "report.json" );
      File.writeTextFile( jf, JSON.stringify( job ) );
      var P = new ExternalProcess;
      P.start( this.binaryPath, [ "ctl", "distribute", "--control-port", String( this.controlPort ),
                                  "--in-file", jf, "--out-file", rf ] );
      if ( P.waitForStarted && !P.waitForStarted() )
         throw new Error( "ctl distribute did not start" );
      return { process: P, reportFile: rf };
   };

   this.distributeWait = function( handle )
   {
      handle.process.waitForFinished( -1 );
      var rep = this._readJSON( handle.reportFile );
      if ( rep == null )
         throw new Error( "distribute: no report produced (" + handle.reportFile + ")" );
      if ( rep.error )
         throw new Error( "distribute: " + rep.error );
      return rep;
   };

   // ---- worker role: pull/report (via ctl + files) -------------------------

   this.pullWork = function()
   {
      var out = this._tmp( "pull.json" );
      this._runOneShot( [ "ctl", "pull", "--control-port", String( this.controlPort ), "--out-file", out ] );
      var r = this._readJSON( out );
      return ( r && r.job_id ) ? r : null; // {} (no work) => null
   };

   this.reportResult = function( result )
   {
      var inf = this._tmp( "result.json" );
      File.writeTextFile( inf, JSON.stringify( result ) );
      this._runOneShot( [ "ctl", "result", "--control-port", String( this.controlPort ), "--in-file", inf ] );
   };

   // ---- internals ----------------------------------------------------------

   this._common = function()
   {
      return [ "--token", this.token, "--pi-version", this.piVersion, "--wbpp-version", this.wbppVersion ];
   };

   this._tmp = function( name )
   {
      var p = File.systemTempDirectory + "/wbpp-" + this._session + "-" + ( this._seq++ ) + "-" + name;
      // ensure no stale content is ever read if the sidecar fails to write it
      try { if ( File.exists( p ) ) File.remove( p ); } catch ( e ) {}
      return p;
   };

   // Run the sidecar to completion. Results are read from the out-file, not
   // stdout (PixInsight does not reliably capture child stdout).
   this._runOneShot = function( args )
   {
      var P = new ExternalProcess;
      P.start( this.binaryPath, args );
      if ( P.waitForStarted && !P.waitForStarted() )
         throw new Error( "sidecar did not start: " + this.binaryPath );
      // -1 = wait indefinitely. Default is 30s (Qt), far too short for a group
      // whose frames (hundreds of MB) upload over the LAN/Wi-Fi before processing.
      P.waitForFinished( -1 );
      return P.exitCode;
   };

   this._readJSON = function( path )
   {
      if ( !File.exists( path ) )
         return null;
      try { return JSON.parse( File.readTextFile( path ) ); }
      catch ( e ) { return null; }
   };
}

#endif // __WBPP_SidecarBridge_js
