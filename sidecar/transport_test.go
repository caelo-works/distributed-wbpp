package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// newTestServer wires the real upload/health handlers onto an httptest server so
// we exercise the production code paths without binding a privileged port.
func newTestServer(t *testing.T, dataDir string, caps Capabilities) (*httptest.Server, string) {
	t.Helper()
	ts := &TransportServer{caps: caps, dataDir: dataDir, executor: MockExecutor{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", ts.handleHealth)
	mux.HandleFunc("/have", ts.handleHave)
	mux.HandleFunc("/upload", ts.handleUpload)
	mux.HandleFunc("/download", ts.handleDownload)
	mux.HandleFunc("/lan/work", ts.handleWork)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	// strip the http:// scheme so it matches how UploadFile/FetchCapabilities
	// build URLs (they prepend the scheme themselves).
	return srv, srv.URL[len("http://"):]
}

func TestUploadRoundTripChecksum(t *testing.T) {
	dir := t.TempDir()
	_, addr := newTestServer(t, dir, Capabilities{NodeID: "w1"})

	// random payload so the test can't accidentally pass on zeroed buffers
	payload := make([]byte, 512*1024+17)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), "frame.bin")
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}

	res, err := UploadFile(context.Background(), addr, src)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	want := sha256.Sum256(payload)
	wantHex := hex.EncodeToString(want[:])
	if res.SHA256 != wantHex {
		t.Fatalf("server sha256 = %s, want %s", res.SHA256, wantHex)
	}
	if res.Bytes != int64(len(payload)) {
		t.Fatalf("server bytes = %d, want %d", res.Bytes, len(payload))
	}

	got, err := os.ReadFile(filepath.Join(dir, "frame.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatal("stored file differs from sent payload")
	}
}

// TestUploadRejectsCorruption verifies the receiver refuses a transfer whose
// declared checksum does not match the bytes actually received.
func TestUploadRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	srv, _ := newTestServer(t, dir, Capabilities{NodeID: "w1"})

	body := bytes.NewReader([]byte("hello world"))
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/upload?name=x.bin", body)
	req.Header.Set(headerChecksum, "deadbeef") // wrong on purpose
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); !os.IsNotExist(err) {
		t.Fatal("corrupted upload should not have been kept on disk")
	}
}

func TestFetchCapabilitiesHandshake(t *testing.T) {
	caps := Capabilities{
		Magic: BeaconMagic, Protocol: ProtocolVersion, NodeID: "w1",
		Role: RoleWorker, OS: "linux", PIVersion: "1.8.9-3", WBPPVersion: "2.7.6",
	}
	_, addr := newTestServer(t, t.TempDir(), caps)

	got, err := FetchCapabilities(context.Background(), addr)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	if got != caps {
		t.Fatalf("caps = %+v, want %+v", got, caps)
	}
}

func TestVersionMismatch(t *testing.T) {
	base := Capabilities{Protocol: 1, PIVersion: "1.8.9-3", WBPPVersion: "2.7.6"}
	if m := versionMismatch(base, base); m != "" {
		t.Fatalf("identical caps should match, got %q", m)
	}
	bad := base
	bad.WBPPVersion = "2.7.5"
	if m := versionMismatch(base, bad); m == "" {
		t.Fatal("differing WBPP version should be flagged")
	}
}
