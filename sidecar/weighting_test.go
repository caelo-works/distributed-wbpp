package main

import (
	"testing"
	"time"
)

func TestWeightedShard(t *testing.T) {
	ws := []NodeInfo{{Beacon: Beacon{NodeID: "fast"}}, {Beacon: Beacon{NodeID: "slow"}}}
	in := []string{"0", "1", "2", "3", "4", "5", "6", "7", "8", "9"}

	// unknown throughput -> equal split, contiguous & ordered
	s := weightedShard(in, ws)
	if len(s[0])+len(s[1]) != len(in) {
		t.Fatalf("counts don't sum: %d+%d", len(s[0]), len(s[1]))
	}
	if len(s[0]) != 5 || len(s[1]) != 5 {
		t.Fatalf("equal split expected, got %d/%d", len(s[0]), len(s[1]))
	}
	if s[0][0] != "0" || s[1][0] != "5" {
		t.Fatalf("order not preserved: %v | %v", s[0], s[1])
	}

	// fast worker measured 3x quicker -> gets more, still sums exactly
	recordThroughput("fast", 30, time.Second)
	recordThroughput("slow", 10, time.Second)
	s = weightedShard(in, ws)
	if len(s[0])+len(s[1]) != len(in) {
		t.Fatalf("counts don't sum: %d+%d", len(s[0]), len(s[1]))
	}
	if len(s[0]) <= len(s[1]) {
		t.Fatalf("fast worker should get more, got %d/%d", len(s[0]), len(s[1]))
	}
}
