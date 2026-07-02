package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// runAgent runs the long-lived daemon that the local PixInsight script drives
// over localhost. It continuously discovers peers (multicast) and, in server
// role, exposes a control API the PJSR "server" script calls to enumerate
// workers and submit distributed jobs. Bound to 127.0.0.1 only — it is a local
// control plane, never exposed on the LAN. (The LAN-facing transport server,
// used by other nodes, is started separately for worker role.)
func runAgent(ctx context.Context, sc serverConfig, ctrlPort int) {
	self := Capabilities{
		Protocol: ProtocolVersion, NodeID: sc.nodeID, Role: RoleServer,
		OS: runtime.GOOS, PIVersion: sc.pi, WBPPVersion: sc.wbpp,
	}
	reg := NewRegistry()
	go func() {
		if err := Browse(ctx, sc.token, reg, func(n NodeInfo) {
			log.Printf("agent: discovered %s %s at %s", n.Role, n.NodeID, n.Addr)
		}); err != nil {
			log.Printf("agent: browse stopped: %v", err)
		}
	}()

	// Bench mode: static peers bypass multicast (robust on multi-homed hosts). The
	// product default remains multicast auto-discovery (Browse above).
	if sc.peers != "" {
		go seedStaticPeers(ctx, sc.token, sc.peers, reg)
	}

	api := &controlAPI{self: self, reg: reg, defaults: sc, busy: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/status", api.handleStatus)
	mux.HandleFunc("/v1/nodes", api.handleNodes)
	mux.HandleFunc("/v1/distribute", api.handleDistribute)

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", ctrlPort))
	if err != nil {
		log.Fatalf("agent: control listen: %v", err)
	}
	srv := &http.Server{Handler: mux}
	go func() {
		<-ctx.Done()
		shctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shctx)
	}()

	log.Printf("agent %s control API on http://127.0.0.1:%d (token=%q, pi=%s, wbpp=%s)",
		sc.nodeID, ln.Addr().(*net.TCPAddr).Port, sc.token, sc.pi, sc.wbpp)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Printf("agent: control server: %v", err)
	}
}

// seedStaticPeers periodically health-checks a fixed worker host:port list and injects
// them into the registry, bypassing multicast. Bench-only (opt-in via --peers); the
// product default stays multicast auto-discovery (Browse). Re-seeds every 10s so the
// entries never age out (NodeTTL) and stale/down peers drop off.
func seedStaticPeers(ctx context.Context, token, peers string, reg *Registry) {
	var addrs []string
	for _, a := range strings.Split(peers, ",") {
		if a = strings.TrimSpace(a); a != "" {
			addrs = append(addrs, a)
		}
	}
	for {
		for _, addr := range addrs {
			cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
			caps, err := FetchCapabilities(cctx, addr)
			cancel()
			if err != nil {
				continue // worker not up yet / unreachable — try again next round
			}
			host, portStr, _ := net.SplitHostPort(addr)
			port, _ := strconv.Atoi(portStr)
			reg.Upsert(NodeInfo{
				Beacon: Beacon{
					Magic: BeaconMagic, Protocol: caps.Protocol, Token: token,
					NodeID: caps.NodeID, Role: caps.Role, Host: host, HTTPPort: port,
					OS: caps.OS, PIVersion: caps.PIVersion, WBPPVersion: caps.WBPPVersion,
				},
				Addr: addr,
			})
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

// startWorkerControlAPI exposes the localhost endpoints the local PixInsight
// worker script polls to pull shards and report results. Bound to 127.0.0.1.
func startWorkerControlAPI(ctx context.Context, pe *PullExecutor, port int, nodeID string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/work", pe.handlePull)
	mux.HandleFunc("/v1/work/result", pe.handleResult)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		log.Fatalf("worker: control listen: %v", err)
	}
	srv := &http.Server{Handler: mux}
	go func() {
		<-ctx.Done()
		shctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shctx)
	}()
	go func() {
		log.Printf("worker %s pull API on http://127.0.0.1:%d (GET /v1/work, POST /v1/work/result)", nodeID, port)
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("worker: control server: %v", err)
		}
	}()
}

type controlAPI struct {
	self     Capabilities
	reg      *Registry
	defaults serverConfig

	mu   sync.Mutex      // guards busy
	busy map[string]bool // NodeID -> a whole-job is running on it
}

// acquireWorker leases one free worker for a whole-job, serializing concurrent
// whole-jobs so a worker never runs two at once (which deadlocks its pull queue).
// Blocks (polling) until a worker is free; gives up only if NO worker exists for
// the deadline or the request is cancelled.
func (a *controlAPI) acquireWorker(ctx context.Context) (NodeInfo, bool) {
	noWorkerDeadline := time.Now().Add(20 * time.Second)
	for {
		workers := a.aliveWorkers()
		if len(workers) > 0 {
			noWorkerDeadline = time.Now().Add(20 * time.Second) // reset while queued behind busy peers
			a.mu.Lock()
			for _, wk := range workers {
				if !a.busy[wk.NodeID] {
					a.busy[wk.NodeID] = true
					a.mu.Unlock()
					return wk, true
				}
			}
			a.mu.Unlock()
		} else if time.Now().After(noWorkerDeadline) {
			return NodeInfo{}, false
		}
		select {
		case <-ctx.Done():
			return NodeInfo{}, false
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (a *controlAPI) releaseWorker(id string) {
	a.mu.Lock()
	delete(a.busy, id)
	a.mu.Unlock()
}

func (a *controlAPI) handleStatus(w http.ResponseWriter, r *http.Request) {
	workers := a.aliveWorkers()
	writeJSON(w, http.StatusOK, map[string]any{
		"node_id":      a.self.NodeID,
		"role":         a.self.Role,
		"protocol":     a.self.Protocol,
		"pi_version":   a.self.PIVersion,
		"wbpp_version": a.self.WBPPVersion,
		"version":      buildVersion,
		"worker_count": len(workers),
	})
}

func (a *controlAPI) handleNodes(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"workers": a.aliveWorkers()})
}

// handleDistribute accepts a DistributeJob (inputs are paths on this machine,
// readable by the sidecar) and runs it synchronously, returning the JobReport.
// This is exactly what the PJSR WBPPShim calls to offload a group's
// registration/calibration to the cluster.
func (a *controlAPI) handleDistribute(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST required"})
		return
	}
	var job DistributeJob
	if err := json.NewDecoder(r.Body).Decode(&job); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad job: " + err.Error()})
		return
	}
	applyJobDefaults(&job, a.defaults)

	// Wait briefly for at least one worker (the agent browses continuously, but
	// the registry may be momentarily empty right after startup or a beacon gap).
	workers := a.aliveWorkers()
	for deadline := time.Now().Add(20 * time.Second); len(workers) == 0 && time.Now().Before(deadline); {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(300 * time.Millisecond):
		}
		workers = a.aliveWorkers()
	}
	if len(workers) == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "no workers discovered"})
		return
	}

	// Whole-job: lease ONE free worker (serialized) and run the entire job on it.
	if job.WholeJob {
		wk, ok := a.acquireWorker(r.Context())
		if !ok {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "no worker available for whole-job"})
			return
		}
		defer a.releaseWorker(wk.NodeID)
		workers = []NodeInfo{wk}
	}

	rep, err := distributeJob(r.Context(), a.self, workers, job, log.Printf)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "report": rep})
		return
	}
	writeJSON(w, http.StatusOK, rep)
}

func (a *controlAPI) aliveWorkers() []NodeInfo {
	var out []NodeInfo
	for _, n := range a.reg.Alive() {
		if n.Role == RoleWorker {
			out = append(out, n)
		}
	}
	return out
}

// applyJobDefaults fills unset job fields from the agent's configured defaults so
// the PJSR caller can send a minimal request.
func applyJobDefaults(job *DistributeJob, d serverConfig) {
	if job.Op == "" {
		job.Op = d.op
	}
	if job.OutDir == "" {
		job.OutDir = d.outDir
	}
	// NOTE: do NOT default an empty Postfix — the PJSR shim always sends it
	// explicitly, and some operations legitimately need an empty postfix
	// (Local Normalization: output is <base>.xnml, no postfix).
	if job.OutExt == "" {
		job.OutExt = d.outExt
	}
}
