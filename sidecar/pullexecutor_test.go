package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func decodeJSON(resp *http.Response, v any) {
	defer resp.Body.Close()
	_ = json.NewDecoder(resp.Body).Decode(v)
}

func postJSON(url string, v any) {
	body, _ := json.Marshal(v)
	resp, err := http.Post(url, "application/json", bytes.NewReader(body))
	if err == nil {
		resp.Body.Close()
	}
}

// TestPullExecutorCycle simulates the production worker path without PixInsight:
// a /lan/work request parks a shard in the PullExecutor; a goroutine playing the
// role of the PixInsight worker script pulls it via GET /v1/work, "processes" it
// (writes <base>_r.xisf), and reports via POST /v1/work/result. The original
// /lan/work call must then return outputs with sidecar-computed checksums.
func TestPullExecutorCycle(t *testing.T) {
	dataDir := t.TempDir()
	pe := NewPullExecutor(dataDir, 5*time.Second)

	// transport server (LAN side) using the pull executor
	ts := &TransportServer{caps: Capabilities{NodeID: "w1"}, dataDir: dataDir, executor: pe}
	lanMux := http.NewServeMux()
	lanMux.HandleFunc("/upload", ts.handleUpload)
	lanMux.HandleFunc("/lan/work", ts.handleWork)
	lan := httptest.NewServer(lanMux)
	defer lan.Close()
	lanAddr := strings.TrimPrefix(lan.URL, "http://")

	// localhost worker control endpoints
	ctrlMux := http.NewServeMux()
	ctrlMux.HandleFunc("/v1/work", pe.handlePull)
	ctrlMux.HandleFunc("/v1/work/result", pe.handleResult)
	ctrl := httptest.NewServer(ctrlMux)
	defer ctrl.Close()

	ctx := context.Background()

	// upload two input frames to the worker
	srcDir := t.TempDir()
	names := []string{"light_0001.xisf", "light_0002.xisf"}
	for _, n := range names {
		p := filepath.Join(srcDir, n)
		if err := os.WriteFile(p, []byte("data:"+n), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := UploadFile(ctx, lanAddr, p); err != nil {
			t.Fatalf("upload %s: %v", n, err)
		}
	}

	// the fake "PixInsight worker": poll /v1/work, process, report result
	go fakePixInsightWorker(t, ctrl.URL, dataDir)

	res, err := SendWork(ctx, lanAddr, WorkManifest{
		JobID: "reg-w0", Op: "registration",
		InputNames: names, OutputPostfix: "_r", OutputExt: ".xisf",
	})
	if err != nil {
		t.Fatalf("send work: %v", err)
	}
	if len(res.Outputs) != 2 {
		t.Fatalf("got %d outputs, want 2", len(res.Outputs))
	}
	for _, o := range res.Outputs {
		if o.SHA256 == "" {
			t.Fatalf("output %s has no sidecar-computed checksum", o.Output)
		}
		if _, err := os.Stat(filepath.Join(dataDir, o.Output)); err != nil {
			t.Fatalf("output %s not on disk: %v", o.Output, err)
		}
	}
}

func fakePixInsightWorker(t *testing.T, ctrlURL, dataDir string) {
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(ctrlURL + "/v1/work")
		if err != nil {
			return
		}
		if resp.StatusCode == http.StatusNoContent {
			resp.Body.Close()
			time.Sleep(20 * time.Millisecond)
			continue
		}
		var m WorkManifest
		decodeJSON(resp, &m)

		// "run StarAlignment": copy each input to <base>_r.xisf
		var outs []OutputPair
		for _, in := range m.InputNames {
			base := strings.TrimSuffix(in, filepath.Ext(in))
			out := base + m.OutputPostfix + m.OutputExt
			if err := copyFile(filepath.Join(dataDir, in), filepath.Join(dataDir, out)); err != nil {
				t.Errorf("fake worker copy: %v", err)
				return
			}
			outs = append(outs, OutputPair{Input: in, Output: out})
		}
		postJSON(ctrlURL+"/v1/work/result", WorkResult{OK: true, JobID: m.JobID, Outputs: outs})
		return
	}
}
