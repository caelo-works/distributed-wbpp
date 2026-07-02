package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// DistributeJob is one distributed operation: run Op (with its serialized
// PixInsight process) over Inputs, sharded across the given workers, collecting
// outputs into OutDir.
type DistributeJob struct {
	Inputs        []string `json:"inputs"`         // absolute paths on the server (sharded)
	Reference     string   `json:"reference"`      // legacy single shared reference frame (path)
	Op            string   `json:"op"`             // "registration" | "calibration" | ...
	ProcessSource string   `json:"process_source"` // PJSR-serialized process (opaque here)
	OutDir        string   `json:"out_dir"`
	Prefix        string   `json:"prefix"`
	Postfix       string   `json:"postfix"`
	OutExt        string   `json:"out_ext"`
	Force         bool     `json:"force"` // bypass the version handshake

	// Generic distribution (passed through to the PJSR worker):
	SharedFiles   []string          `json:"shared_files"`    // absolute paths uploaded once to every worker (cached by checksum)
	FileRefFields map[string]string `json:"file_ref_fields"` // process field -> absolute path of a shared file (master/reference)
	TargetsField  string            `json:"targets_field"`   // "targetFrames" | "targets"
	PathIndex     int               `json:"path_index"`      // path index within a target row
	Drizzle       bool              `json:"drizzle"`

	// WholeJob: this is one indivisible job (e.g. an ImageIntegration) that must run
	// ENTIRE on a single worker — never sharded. The agent leases one free worker for
	// it (serializing concurrent whole-jobs per worker), then hands [thatWorker] to
	// distributeJob, so shard(inputs, 1) puts every input on it.
	WholeJob bool `json:"whole_job"`
}

// OutputRecord is the per-frame result the server reports back to its caller
// (the PJSR script): which worker produced which output, and whether integrity
// held after download.
type OutputRecord struct {
	Input    string `json:"input"`
	Output   string `json:"output"`
	Worker   string `json:"worker"`
	Path     string `json:"path"` // local path in OutDir
	Verified bool   `json:"verified"`
	Error    string `json:"error,omitempty"`
}

// JobReport summarizes a completed distribution.
type JobReport struct {
	Op        string         `json:"op"`
	Workers   int            `json:"workers"`
	Total     int            `json:"total"`
	Collected int            `json:"collected"`
	Failed    int            `json:"failed"`
	ElapsedMS int64          `json:"elapsed_ms"`
	Outputs   []OutputRecord `json:"outputs"`
}

// logf matches log.Printf; callers can pass a no-op to stay quiet.
type logf func(format string, args ...any)

// distributeJob is the reusable fan-out engine shared by the CLI and the
// localhost control API. It performs the strict version handshake with every
// worker, shards inputs round-robin, pushes (reference + shard) to each worker,
// runs the operation there, then pulls and verifies every output. It never
// calls os.Exit/Fatal — failures are recorded in the returned report.
func distributeJob(ctx context.Context, self Capabilities, workers []NodeInfo, job DistributeJob, lg logf) (JobReport, error) {
	if lg == nil {
		lg = func(string, ...any) {}
	}
	rep := JobReport{Op: job.Op, Workers: len(workers), Total: len(job.Inputs)}
	if len(job.Inputs) == 0 {
		return rep, fmt.Errorf("no inputs")
	}
	if len(workers) == 0 {
		return rep, fmt.Errorf("no workers")
	}
	if err := os.MkdirAll(job.OutDir, 0o755); err != nil {
		return rep, fmt.Errorf("out dir: %w", err)
	}

	// Handshake: refuse to dispatch to any node whose versions differ (unless forced).
	for i := range workers {
		caps, err := FetchCapabilities(ctx, workers[i].Addr)
		if err != nil {
			return rep, fmt.Errorf("handshake with %s: %w", workers[i].Addr, err)
		}
		if m := versionMismatch(self, caps); m != "" && !job.Force {
			return rep, fmt.Errorf("version handshake refused for %s: %s", workers[i].Addr, m)
		}
	}

	lg("distributing %d frame(s) across %d worker(s)", len(job.Inputs), len(workers))
	// Split proportionally to each worker's measured throughput (equal until known), so
	// a slow client gets fewer frames and doesn't bottleneck the group.
	shards := weightedShard(job.Inputs, workers)
	multi := len(workers) > 1
	start := time.Now()

	// Process the workers CONCURRENTLY — upload + run + download each shard in its own
	// goroutine so N clients work in parallel (the cluster's wall time ≈ the slowest
	// worker, not the sum). Each goroutine returns a partial result merged under a lock.
	var mu sync.Mutex
	var wg sync.WaitGroup
	for wi, w := range workers {
		files := shards[wi]
		if len(files) == 0 {
			continue
		}
		wg.Add(1)
		go func(wi int, w NodeInfo, files []string) {
			defer wg.Done()
			t := time.Now()
			outs, collected, failed := runWorkerShard(ctx, self, wi, w, files, job, lg)
			if multi && collected > 0 { // feed the per-worker throughput estimate
				recordThroughput(w.NodeID, collected, time.Since(t))
			}
			mu.Lock()
			rep.Outputs = append(rep.Outputs, outs...)
			rep.Collected += collected
			rep.Failed += failed
			mu.Unlock()
		}(wi, w, files)
	}
	wg.Wait()
	rep.ElapsedMS = time.Since(start).Milliseconds()
	return rep, nil
}

// runWorkerShard pushes the shared files + this worker's shard, runs the op, and pulls
// back + verifies the outputs. It returns a partial result (no shared state), so several
// workers can run concurrently.
func runWorkerShard(ctx context.Context, self Capabilities, wi int, w NodeInfo, files []string, job DistributeJob, lg logf) (outputs []OutputRecord, collected, failed int) {
	lg("worker %s <- %d frame(s)", w.NodeID, len(files))
	t0 := time.Now()

	// 1) push shared files once (reference + masters), skipping any the worker already
	//    holds (checksum cache) — masters are reused across groups.
	shared := job.SharedFiles
	if job.Reference != "" {
		shared = append([]string{job.Reference}, shared...)
	}
	for _, sf := range shared {
		up, err := UploadFileCached(ctx, w.Addr, sf)
		if err != nil {
			return shardError(files, w.NodeID, "shared upload "+filepath.Base(sf)+": "+err.Error())
		}
		if up {
			lg("  shared -> %s : %s", w.NodeID, filepath.Base(sf))
		}
	}
	// map process field -> uploaded basename (masters/reference), for the worker
	fileRefFields := map[string]string{}
	for field, path := range job.FileRefFields {
		fileRefFields[field] = filepath.Base(path)
	}

	// 2) push this shard's frames — cache-aware: skip any the worker already holds
	//    (same basename + SHA-256), so a frame reused across ops isn't re-transferred.
	inputNames := make([]string, 0, len(files))
	cached := 0
	for _, f := range files {
		up, err := UploadFileCached(ctx, w.Addr, f)
		if err != nil {
			return shardError(files, w.NodeID, "upload "+filepath.Base(f)+": "+err.Error())
		}
		if !up {
			cached++
		}
		inputNames = append(inputNames, filepath.Base(f))
	}
	tUpload := time.Since(t0)

	// 3) run the operation on the shard
	tWork := time.Now()
	res, err := SendWork(ctx, w.Addr, WorkManifest{
		JobID: fmt.Sprintf("%s-w%d", job.Op, wi), Op: job.Op,
		ProcessSource: job.ProcessSource, ReferenceName: baseOrEmpty(job.Reference),
		InputNames: inputNames, OutputPrefix: job.Prefix, OutputPostfix: job.Postfix, OutputExt: job.OutExt,
		TargetsField: job.TargetsField, PathIndex: job.PathIndex,
		FileRefFields: fileRefFields, Drizzle: job.Drizzle,
	})
	if err != nil {
		return shardError(files, w.NodeID, "work: "+err.Error())
	}
	dWork := time.Since(tWork)

	// 4) pull each produced output back and verify its checksum
	tDown := time.Now()
	for _, pair := range res.Outputs {
		dest := filepath.Join(job.OutDir, pair.Output)
		rec := OutputRecord{Input: pair.Input, Output: pair.Output, Worker: w.NodeID, Path: dest}
		got, err := DownloadFile(ctx, w.Addr, pair.Output, dest)
		switch {
		case err != nil:
			rec.Error = "download: " + err.Error()
			failed++
		case got != pair.SHA256:
			rec.Error = fmt.Sprintf("checksum mismatch (worker %s, local %s)", pair.SHA256, got)
			failed++
		default:
			rec.Verified = true
			collected++
		}
		outputs = append(outputs, rec)
	}
	lg("worker %s TIMING: upload=%s work=%s download=%s (%d frames, %d cached)",
		w.NodeID, tUpload.Round(time.Millisecond), dWork.Round(time.Millisecond),
		time.Since(tDown).Round(time.Millisecond), len(files), cached)
	return outputs, collected, failed
}

// shardError marks every file of a failed shard.
func shardError(files []string, worker, msg string) (outputs []OutputRecord, collected, failed int) {
	for _, f := range files {
		outputs = append(outputs, OutputRecord{Input: filepath.Base(f), Worker: worker, Error: msg})
	}
	return outputs, 0, len(files)
}
