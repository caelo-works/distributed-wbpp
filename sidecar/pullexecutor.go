package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"sync"
	"time"
)

// PullExecutor is the production worker backend. The sidecar cannot run
// PixInsight processes itself, so when a shard arrives via /lan/work this
// executor parks it and waits for the *local* PixInsight worker script to do the
// work. That script polls the localhost endpoints:
//
//	GET  /v1/work          -> next pending WorkManifest (204 if none)
//	POST /v1/work/result   -> { job_id, outputs:[{input,output}], error }
//
// The sidecar fills in each output's SHA-256 (so the server can verify the file
// it later downloads) and unblocks the waiting /lan/work request.
type PullExecutor struct {
	dataDir string
	timeout time.Duration

	pending chan WorkManifest
	mu      sync.Mutex
	waiting map[string]chan WorkResult
}

func NewPullExecutor(dataDir string, timeout time.Duration) *PullExecutor {
	if timeout <= 0 {
		timeout = 30 * time.Minute // registering a big shard can take a while
	}
	return &PullExecutor{
		dataDir: dataDir,
		timeout: timeout,
		pending: make(chan WorkManifest, 64),
		waiting: map[string]chan WorkResult{},
	}
}

// Process parks the manifest for the local PixInsight worker and blocks until it
// reports a result (or the timeout fires). Called from the /lan/work handler.
func (p *PullExecutor) Process(dataDir string, m WorkManifest) ([]OutputPair, error) {
	ch := make(chan WorkResult, 1)
	p.mu.Lock()
	p.waiting[m.JobID] = ch
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		delete(p.waiting, m.JobID)
		p.mu.Unlock()
	}()

	select {
	case p.pending <- m:
	case <-time.After(p.timeout):
		return nil, errors.New("no PixInsight worker available to pull the job")
	}

	select {
	case res := <-ch:
		if res.Error != "" {
			return nil, errors.New(res.Error)
		}
		return res.Outputs, nil
	case <-time.After(p.timeout):
		return nil, errors.New("PixInsight worker timed out processing the shard")
	}
}

// handlePull serves GET /v1/work to the local PixInsight worker script. Short
// long-poll: wait briefly for a job so the PJSR worker can poll at a relaxed
// rate (fewer process spawns) without a long UI freeze, yet pick up work fast.
func (p *PullExecutor) handlePull(w http.ResponseWriter, r *http.Request) {
	select {
	case m := <-p.pending:
		writeJSON(w, http.StatusOK, m)
	case <-time.After(800 * time.Millisecond):
		w.WriteHeader(http.StatusNoContent) // nothing to do right now
	case <-r.Context().Done():
		w.WriteHeader(http.StatusNoContent)
	}
}

// handleResult serves POST /v1/work/result. The PJSR worker reports which output
// files it wrote (by name, in dataDir); we checksum them here and hand the
// result to the blocked Process call.
func (p *PullExecutor) handleResult(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var res WorkResult
	if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad result: " + err.Error()})
		return
	}
	// Fill in checksums for the files the worker produced.
	if res.Error == "" {
		for i := range res.Outputs {
			sum, err := fileSHA256(filepath.Join(p.dataDir, res.Outputs[i].Output))
			if err != nil {
				res.Error = "missing/unreadable output " + res.Outputs[i].Output + ": " + err.Error()
				break
			}
			res.Outputs[i].SHA256 = sum
		}
	}

	p.mu.Lock()
	ch := p.waiting[res.JobID]
	p.mu.Unlock()
	if ch == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown or expired job_id " + res.JobID})
		return
	}
	ch <- res
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
