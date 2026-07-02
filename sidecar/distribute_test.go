package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// TestWorkRoundTrip exercises the worker-side pipeline end to end against the
// real HTTP handlers: upload inputs -> /lan/work (mock executor) -> download
// each produced output and verify its checksum. This is the same sequence the
// server's runDistribute performs, minus discovery.
func TestWorkRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	_, addr := newTestServer(t, dataDir, Capabilities{NodeID: "w1"})
	ctx := context.Background()

	// create two input "frames" locally and upload them to the worker
	srcDir := t.TempDir()
	var names []string
	for _, name := range []string{"light_0001.xisf", "light_0002.xisf"} {
		p := filepath.Join(srcDir, name)
		if err := os.WriteFile(p, []byte("frame:"+name), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := UploadFile(ctx, addr, p); err != nil {
			t.Fatalf("upload %s: %v", name, err)
		}
		names = append(names, name)
	}

	res, err := SendWork(ctx, addr, WorkManifest{
		JobID: "reg-w0", Op: "registration",
		InputNames: names, OutputPostfix: "_r", OutputExt: ".xisf",
	})
	if err != nil {
		t.Fatalf("send work: %v", err)
	}
	if len(res.Outputs) != len(names) {
		t.Fatalf("got %d outputs, want %d", len(res.Outputs), len(names))
	}

	outDir := t.TempDir()
	for _, pair := range res.Outputs {
		if pair.Output != trimExt(pair.Input)+"_r.xisf" {
			t.Fatalf("unexpected output name %q for input %q", pair.Output, pair.Input)
		}
		dest := filepath.Join(outDir, pair.Output)
		got, err := DownloadFile(ctx, addr, pair.Output, dest)
		if err != nil {
			t.Fatalf("download %s: %v", pair.Output, err)
		}
		if got != pair.SHA256 {
			t.Fatalf("checksum mismatch for %s: worker %s, downloaded %s", pair.Output, pair.SHA256, got)
		}
		if _, err := os.Stat(dest); err != nil {
			t.Fatalf("output %s not written locally: %v", pair.Output, err)
		}
	}
}

func TestShardRoundRobin(t *testing.T) {
	got := shard([]int{1, 2, 3, 4, 5}, 2)
	if len(got) != 2 || len(got[0]) != 3 || len(got[1]) != 2 {
		t.Fatalf("unbalanced shard: %v", got)
	}
	// every item present exactly once
	seen := map[int]int{}
	for _, b := range got {
		for _, v := range b {
			seen[v]++
		}
	}
	for v := 1; v <= 5; v++ {
		if seen[v] != 1 {
			t.Fatalf("item %d appeared %d times", v, seen[v])
		}
	}
}

func trimExt(name string) string {
	return name[:len(name)-len(filepath.Ext(name))]
}
