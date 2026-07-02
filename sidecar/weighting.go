package main

import (
	"sync"
	"time"
)

// Per-worker workerTP (frames/sec), EMA-smoothed across multi-worker jobs, so the
// cluster shard can be split PROPORTIONALLY to how fast each worker actually is. A slow
// client (e.g. weaker CPU) then gets fewer frames and stops bottlenecking the group —
// the intra-cluster analogue of the shim's server/cluster adaptive split. Only sharded
// (multi-worker) jobs feed it; whole-job integrations (one leased worker) don't, so a
// different workload never skews the per-frame estimate.
var workerTP = struct {
	mu sync.Mutex
	m  map[string]float64
}{m: map[string]float64{}}

func recordThroughput(nodeID string, frames int, elapsed time.Duration) {
	if frames <= 0 || elapsed <= 0 {
		return
	}
	tp := float64(frames) / elapsed.Seconds()
	workerTP.mu.Lock()
	if old, ok := workerTP.m[nodeID]; ok {
		tp = 0.6*old + 0.4*tp
	}
	workerTP.m[nodeID] = tp
	workerTP.mu.Unlock()
}

func workerWeight(nodeID string) float64 {
	workerTP.mu.Lock()
	defer workerTP.mu.Unlock()
	return workerTP.m[nodeID] // 0 == unknown (caller defaults to equal)
}

// weightedShard splits inputs across workers proportionally to measured workerTP
// (equal until measured), preserving input order within each shard. Uses the
// largest-remainder method so the counts sum exactly to len(inputs).
func weightedShard(inputs []string, workers []NodeInfo) [][]string {
	n := len(workers)
	out := make([][]string, n)
	if n == 0 || len(inputs) == 0 {
		return out
	}

	weights := make([]float64, n)
	var total float64
	for i, w := range workers {
		wt := workerWeight(w.NodeID)
		if wt <= 0 {
			wt = 1 // unknown -> equal share
		}
		weights[i] = wt
		total += wt
	}

	counts := make([]int, n)
	frac := make([]float64, n)
	assigned := 0
	for i := range workers {
		exact := float64(len(inputs)) * weights[i] / total
		counts[i] = int(exact)
		frac[i] = exact - float64(counts[i])
		assigned += counts[i]
	}
	for assigned < len(inputs) { // hand the remainder to the largest fractional parts
		best := 0
		for i := 1; i < n; i++ {
			if frac[i] > frac[best] {
				best = i
			}
		}
		counts[best]++
		frac[best] = -1
		assigned++
	}

	idx := 0
	for i := range workers {
		out[i] = inputs[idx : idx+counts[i]]
		idx += counts[i]
	}
	return out
}
