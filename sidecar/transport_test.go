package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// testSecurity builds the security material for a fresh random cluster key.
func testSecurity(t *testing.T) *ClusterSecurity {
	t.Helper()
	key, err := GenerateClusterKey()
	if err != nil {
		t.Fatal(err)
	}
	sec, err := NewClusterSecurity(key)
	if err != nil {
		t.Fatal(err)
	}
	return sec
}

// newTestServer serves the real authenticated LAN handlers over mutual TLS on a
// loopback httptest server. Returns the server, its host:port and the cluster
// security a client of the same cluster uses.
func newTestServer(t *testing.T, dataDir string, caps Capabilities) (*httptest.Server, string, *ClusterSecurity) {
	t.Helper()
	sec := testSecurity(t)
	srv, addr := serveTransport(t, newTransportServer(caps, dataDir, sec))
	return srv, addr, sec
}

func serveTransport(t *testing.T, ts *TransportServer) (*httptest.Server, string) {
	t.Helper()
	srv := httptest.NewUnstartedServer(ts.srv.Handler)
	srv.TLS = ts.sec.serverTLS.Clone()
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, strings.TrimPrefix(srv.URL, "https://")
}

// rawRequest sends a request with the cluster TLS identity of sec but lets the
// caller set (or omit) the signature headers, to probe the authentication layer.
func rawRequest(t *testing.T, sec *ClusterSecurity, method, rawURL string, body []byte, sign func(*http.Request)) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, rawURL, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if sign != nil {
		sign(req)
	}
	resp, err := sec.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func randomFile(t *testing.T, name string, n int) (string, []byte) {
	t.Helper()
	payload := make([]byte, n)
	if _, err := rand.Read(payload); err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(src, payload, 0o644); err != nil {
		t.Fatal(err)
	}
	return src, payload
}

func TestUploadRoundTripChecksum(t *testing.T) {
	for _, compress := range []bool{false, true} {
		t.Run("compress="+strconv.FormatBool(compress), func(t *testing.T) {
			compressTransfers = compress
			defer func() { compressTransfers = false }()

			dir := t.TempDir()
			_, addr, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
			src, payload := randomFile(t, "frame.bin", 512*1024+17)

			res, err := sec.UploadFile(context.Background(), addr, src)
			if err != nil {
				t.Fatalf("upload: %v", err)
			}
			want := sha256.Sum256(payload)
			if res.SHA256 != hex.EncodeToString(want[:]) || res.Bytes != int64(len(payload)) {
				t.Fatalf("server echoed %d bytes / %s", res.Bytes, res.SHA256)
			}
			got, err := os.ReadFile(filepath.Join(dir, "frame.bin"))
			if err != nil || !bytes.Equal(got, payload) {
				t.Fatal("stored file differs from sent payload")
			}
			if _, err := os.Stat(filepath.Join(dir, "frame.bin.part")); !os.IsNotExist(err) {
				t.Fatal("temporary .part file left behind")
			}

			dest := filepath.Join(t.TempDir(), "back.bin")
			sum, err := sec.DownloadFile(context.Background(), addr, "frame.bin", dest)
			if err != nil {
				t.Fatalf("download: %v", err)
			}
			back, _ := os.ReadFile(dest)
			if sum != res.SHA256 || !bytes.Equal(back, payload) {
				t.Fatal("download round trip differs")
			}
		})
	}
}

// TestUploadRejectsCorruption verifies the receiver refuses a correctly signed
// transfer whose declared file checksum does not match the bytes received.
func TestUploadRejectsCorruption(t *testing.T) {
	dir := t.TempDir()
	_, addr, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
	hdr := http.Header{}
	hdr.Set(headerChecksum, "deadbeef") // wrong on purpose
	resp, _, err := sec.do(context.Background(), http.MethodPost, addr, "/upload", url.Values{"name": {"x.bin"}}, []byte("hello world"), hdr)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); !os.IsNotExist(err) {
		t.Fatal("corrupted upload should not have been kept on disk")
	}
}

func TestUploadRequiresChecksum(t *testing.T) {
	dir := t.TempDir()
	_, addr, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
	resp, _, err := sec.do(context.Background(), http.MethodPost, addr, "/upload", url.Values{"name": {"x.bin"}}, []byte("hello"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(dir, "x.bin")); !os.IsNotExist(err) {
		t.Fatal("upload without checksum should not be stored")
	}
}

func TestUploadRejectsPathNames(t *testing.T) {
	dir := t.TempDir()
	_, addr, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
	for _, name := range []string{"../evil.bin", "a/b.bin", `a\b.bin`, "..", ""} {
		hdr := http.Header{}
		hdr.Set(headerChecksum, sha256Hex([]byte("x")))
		resp, _, err := sec.do(context.Background(), http.MethodPost, addr, "/upload", url.Values{"name": {name}}, []byte("x"), hdr)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("name %q: status = %d, want 400", name, resp.StatusCode)
		}
	}
}

func TestFetchCapabilitiesHandshake(t *testing.T) {
	caps := Capabilities{
		Magic: BeaconMagic, Protocol: ProtocolVersion, NodeID: "w1",
		Role: RoleWorker, OS: "linux", PIVersion: "1.8.9-3", WBPPVersion: "2.7.6",
	}
	_, addr, sec := newTestServer(t, t.TempDir(), caps)

	got, err := sec.FetchCapabilities(context.Background(), addr)
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

var allEndpoints = []struct{ method, path string }{
	{http.MethodGet, "/health"},
	{http.MethodGet, "/have?name=a.xisf&sha=00"},
	{http.MethodPost, "/upload?name=a.xisf"},
	{http.MethodGet, "/download?name=a.xisf"},
	{http.MethodPost, "/lan/work"},
}

// TestUnsignedRequestsRejected: valid TLS client identity, but no signature.
func TestUnsignedRequestsRejected(t *testing.T) {
	dir := t.TempDir()
	srv, _, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
	if err := os.WriteFile(filepath.Join(dir, "a.xisf"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, ep := range allEndpoints {
		resp := rawRequest(t, sec, ep.method, srv.URL+ep.path, []byte("{}"), nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s unsigned: status %d, want 401", ep.method, ep.path, resp.StatusCode)
		}
	}
}

// TestBadSignatureRejected: right TLS identity, signature made with another key.
func TestBadSignatureRejected(t *testing.T) {
	srv, _, sec := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	other := testSecurity(t)
	for _, ep := range allEndpoints {
		body := []byte{}
		if ep.method == http.MethodPost {
			body = []byte("{}")
		}
		resp := rawRequest(t, sec, ep.method, srv.URL+ep.path, body, func(r *http.Request) {
			other.signRequest(r, sha256Hex(body))
		})
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s with foreign signature: status %d, want 401", ep.method, ep.path, resp.StatusCode)
		}
	}
}

// TestWrongSecretFailsTLS: a node of another cluster cannot even complete the
// TLS handshake (its certificate is not signed by this cluster's CA).
func TestWrongSecretFailsTLS(t *testing.T) {
	_, addr, _ := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	other := testSecurity(t)
	if _, err := other.FetchCapabilities(context.Background(), addr); err == nil {
		t.Fatal("a client with another cluster key reached the worker")
	}
	// and a client presenting no certificate at all
	noCert := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	if resp, err := noCert.Get("https://" + addr + "/health"); err == nil {
		resp.Body.Close()
		t.Fatalf("client without certificate got status %d", resp.StatusCode)
	}
}

func TestPlainHTTPFails(t *testing.T) {
	_, addr, _ := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	resp, err := http.Get("http://" + addr + "/health")
	if err == nil {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			t.Fatal("plain HTTP request served")
		}
	}
}

func TestReplayedNonceRejected(t *testing.T) {
	srv, _, sec := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	var saved http.Header
	resp := rawRequest(t, sec, http.MethodGet, srv.URL+"/health", nil, func(r *http.Request) {
		sec.signRequest(r, emptySHA256)
		saved = r.Header.Clone()
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first request: status %d", resp.StatusCode)
	}
	resp = rawRequest(t, sec, http.MethodGet, srv.URL+"/health", nil, func(r *http.Request) { r.Header = saved })
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replayed request: status %d, want 401", resp.StatusCode)
	}
}

func TestStaleDateRejected(t *testing.T) {
	srv, _, sec := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	resp := rawRequest(t, sec, http.MethodGet, srv.URL+"/health", nil, func(r *http.Request) {
		sec.signRequestAt(r, emptySHA256, time.Now().Add(-15*time.Minute))
	})
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("stale request: status %d, want 401", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(b), "clock skew") {
		t.Fatalf("stale request error should mention clock skew, got %s", b)
	}
}

// TestTamperedBodyRejected: the signature covers a body hash, the bytes sent differ.
func TestTamperedBodyRejected(t *testing.T) {
	dir := t.TempDir()
	srv, _, sec := newTestServer(t, dir, Capabilities{NodeID: "w1"})
	signed := []byte("original frame")
	sent := []byte("tampered frame")
	resp := rawRequest(t, sec, http.MethodPost, srv.URL+"/upload?name=t.bin", sent, func(r *http.Request) {
		r.Header.Set(headerChecksum, sha256Hex(sent))
		sec.signRequest(r, sha256Hex(signed))
	})
	if resp.StatusCode == http.StatusOK {
		t.Fatal("tampered upload accepted")
	}
	for _, n := range []string{"t.bin", "t.bin.part"} {
		if _, err := os.Stat(filepath.Join(dir, n)); !os.IsNotExist(err) {
			t.Fatalf("tampered upload left %s on disk", n)
		}
	}
}

// TestBadResponseSignatureRejected: a response whose signature does not match
// (here a server of another cluster key, reached with this cluster's TLS) is
// not trusted by the client.
func TestBadResponseSignatureRejected(t *testing.T) {
	sec := testSecurity(t)
	forger := testSecurity(t) // signs with another cluster's request key
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(headerChecksum, sha256Hex([]byte("payload")))
		forger.writeSigned(w, r, http.StatusOK, "application/octet-stream", []byte("payload"))
	})
	srv := httptest.NewUnstartedServer(h)
	srv.TLS = sec.serverTLS.Clone()
	srv.StartTLS()
	defer srv.Close()
	addr := strings.TrimPrefix(srv.URL, "https://")
	if _, err := sec.DownloadFile(context.Background(), addr, "x.bin", filepath.Join(t.TempDir(), "x.bin")); err == nil {
		t.Fatal("download with a bad response signature accepted")
	}
}

func TestOversizedManifestRejected(t *testing.T) {
	_, addr, sec := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	big := WorkManifest{JobID: "j", Op: "measurements", InputNames: []string{strings.Repeat("a", maxManifestBytes)}}
	if _, err := sec.SendWork(context.Background(), addr, big); err == nil {
		t.Fatal("oversized manifest accepted")
	}
}

func TestBadManifestsRejected(t *testing.T) {
	_, addr, sec := newTestServer(t, t.TempDir(), Capabilities{NodeID: "w1"})
	sa := json.RawMessage(`{"id":"StarAlignment","params":{}}`)
	cases := map[string]WorkManifest{
		"unknown op":         {Op: "shell", Process: sa, InputNames: []string{"a.xisf"}},
		"wrong process":      {Op: "calibration", Process: sa, InputNames: []string{"a.xisf"}},
		"missing process":    {Op: "registration", InputNames: []string{"a.xisf"}},
		"process on measure": {Op: "measurements", Process: sa, InputNames: []string{"a.xisf"}},
		"path in input":      {Op: "registration", Process: sa, InputNames: []string{"../a.xisf"}},
		"abs path in input":  {Op: "registration", Process: sa, InputNames: []string{"C:\\a.xisf"}},
		"path in file ref":   {Op: "registration", Process: sa, InputNames: []string{"a.xisf"}, FileRefFields: map[string]string{"referenceImage": "/etc/passwd"}},
		"bad field name":     {Op: "registration", Process: sa, InputNames: []string{"a.xisf"}, TargetsField: "targets; x"},
		"bad dir field":      {Op: "registration", Process: sa, InputNames: []string{"a.xisf"}, DirField: "a.b"},
	}
	for name, m := range cases {
		m.JobID = "j"
		if _, err := sec.SendWork(context.Background(), addr, m); err == nil || !strings.Contains(err.Error(), "rejected manifest") {
			t.Fatalf("%s: got %v, want a rejected manifest", name, err)
		}
	}
}

func TestClusterKeyFormat(t *testing.T) {
	key, err := GenerateClusterKey()
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 39 || strings.Count(key, "-") != 7 {
		t.Fatalf("unexpected key layout %q", key)
	}
	norm, err := NormalizeClusterKey(" " + strings.ToLower(key) + "\r\n")
	if err != nil || norm != strings.ReplaceAll(key, "-", "") {
		t.Fatalf("normalize(%q) = %q, %v", key, norm, err)
	}
	for _, bad := range []string{"", "ABCD", strings.Repeat("A", 31), strings.Repeat("A", 33), strings.Repeat("A", 31) + "1"} {
		if _, err := NormalizeClusterKey(bad); err == nil {
			t.Fatalf("invalid key %q accepted", bad)
		}
	}
	other, _ := GenerateClusterKey()
	if other == key {
		t.Fatal("two generated keys are equal")
	}
}

func TestLocalControlOnly(t *testing.T) {
	h := localControlOnly(48099, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	cases := []struct {
		host, header string
		want         int
	}{
		{"127.0.0.1:48099", "1", http.StatusOK},
		{"localhost:48099", "1", http.StatusOK},
		{"127.0.0.1:48099", "", http.StatusForbidden},
		{"evil.example:48099", "1", http.StatusForbidden},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodGet, "/v1/nodes", nil)
		r.Host = c.host
		if c.header != "" {
			r.Header.Set(headerControl, c.header)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Fatalf("host %q header %q: %d, want %d", c.host, c.header, w.Code, c.want)
		}
	}
}
