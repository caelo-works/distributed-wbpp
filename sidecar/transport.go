package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Header carrying the sender's precomputed SHA-256 (hex) of the ORIGINAL
// (uncompressed) file, so the receiver can reject a corrupted or truncated
// transfer. Mandatory on /upload; covered by the request signature.
const headerChecksum = "X-WBPP-SHA256"
const headerEncoding = "X-WBPP-Encoding"
const encShuffleZstd = "sz" // body is byte-shuffle + zstd (see compress.go)

// Body caps per LAN endpoint (anything not listed: 64 KiB).
const (
	maxUploadBytes   = 8 << 30
	maxManifestBytes = 32 << 20
)

// compressTransfers gates the SENDER (--compress). Off by default: on a fast LAN the
// compress+decompress CPU costs more than the bandwidth it saves; it only pays on a
// slow/shared link (Wi-Fi, 1Gbps split many ways). Receivers always honour the header,
// so a compressing node interoperates with a non-compressing one either way.
var compressTransfers bool

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// validName reports whether s is a plain file name the worker may use inside its
// data dir: no path separator, no NUL, not "." or "..".
func validName(s string) bool {
	return s != "" && s != "." && s != ".." && !strings.ContainsAny(s, "/\\\x00")
}

var jsIdentifier = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// TransportServer is the per-node LAN endpoint (mutual TLS + signed requests)
// used for the handshake, file transfers and work manifests.
type TransportServer struct {
	caps     Capabilities
	dataDir  string
	executor Executor // worker-side processing backend (mock or PixInsight)
	sec      *ClusterSecurity
	srv      *http.Server
	lns      []net.Listener
}

// newTransportServer builds the server and its authenticated handler without
// binding anything (tests serve the handler themselves).
func newTransportServer(caps Capabilities, dataDir string, sec *ClusterSecurity) *TransportServer {
	ts := &TransportServer{caps: caps, dataDir: dataDir, executor: MockExecutor{}, sec: sec}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", ts.handleHealth)
	mux.HandleFunc("/have", ts.handleHave)
	mux.HandleFunc("/upload", ts.handleUpload)
	mux.HandleFunc("/download", ts.handleDownload)
	mux.HandleFunc("/lan/work", ts.handleWork)
	ts.srv = &http.Server{
		Handler:           sec.authenticate(mux, map[string]int64{"/upload": maxUploadBytes, "/lan/work": maxManifestBytes}),
		TLSConfig:         sec.serverTLS,
		ReadHeaderTimeout: 30 * time.Second,
	}
	return ts
}

// NewTransportServer binds one listener per cluster address (port 0 = the first
// bind picks a port, the others reuse it) but does not yet serve; call Port()
// to learn the chosen port, then Serve().
func NewTransportServer(caps Capabilities, dataDir string, port int, listenIPs []string, sec *ClusterSecurity) (*TransportServer, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	ts := newTransportServer(caps, dataDir, sec)
	for _, ip := range listenIPs {
		ln, err := net.Listen("tcp", net.JoinHostPort(ip, strconv.Itoa(port)))
		if err != nil {
			log.Printf("transport: cannot listen on %s:%d: %v", ip, port, err)
			continue
		}
		if port == 0 {
			port = ln.Addr().(*net.TCPAddr).Port
		}
		ts.lns = append(ts.lns, ln)
	}
	if len(ts.lns) == 0 {
		return nil, fmt.Errorf("no cluster address to listen on (tried %s)", strings.Join(listenIPs, ", "))
	}
	return ts, nil
}

// clusterListenIPs returns the addresses the worker listens on: every private
// IPv4 (RFC 1918, link-local) of an up, non-loopback interface, then 127.0.0.1
// for same-host use. Never the wildcard address.
func clusterListenIPs() []string {
	var out []string
	ifaces, _ := net.Interfaces()
	for _, ifi := range ifaces {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip4 := ipn.IP.To4()
			if ip4 != nil && (ip4.IsPrivate() || ip4.IsLinkLocalUnicast()) {
				out = append(out, ip4.String())
			}
		}
	}
	return append(out, "127.0.0.1")
}

// SetExecutor swaps the worker-side processing backend (default MockExecutor).
func (ts *TransportServer) SetExecutor(e Executor) { ts.executor = e }

func (ts *TransportServer) Port() int { return ts.lns[0].Addr().(*net.TCPAddr).Port }

// Addrs returns the non-loopback IPv4 addresses actually listened on (advertised
// in the beacon so peers can check a beacon's source).
func (ts *TransportServer) Addrs() []string {
	var out []string
	for _, ln := range ts.lns {
		ip := ln.Addr().(*net.TCPAddr).IP
		if !ip.IsLoopback() {
			out = append(out, ip.String())
		}
	}
	return out
}

func (ts *TransportServer) Serve() error {
	var wg sync.WaitGroup
	errs := make(chan error, len(ts.lns))
	for _, ln := range ts.lns {
		wg.Add(1)
		go func(ln net.Listener) {
			defer wg.Done()
			if err := ts.srv.ServeTLS(ln, "", ""); err != nil && err != http.ErrServerClosed {
				errs <- err
			}
		}(ln)
	}
	wg.Wait()
	close(errs)
	return <-errs
}

func (ts *TransportServer) Shutdown(ctx context.Context) error { return ts.srv.Shutdown(ctx) }

func (ts *TransportServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	ts.sec.writeSignedJSON(w, r, http.StatusOK, ts.caps)
}

// handleUpload streams the request body to "<name>.part" while hashing it, checks
// the signed body hash (at EOF) and the original-file checksum, then renames it
// into place. Nothing is kept on any failure.
func (ts *TransportServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ts.sec.writeSignedJSON(w, r, http.StatusMethodNotAllowed, UploadResult{Error: "POST required"})
		return
	}
	start := time.Now()
	name := r.URL.Query().Get("name")
	if !validName(name) {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{Error: "invalid file name"})
		return
	}
	want := r.Header.Get(headerChecksum)
	if want == "" {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{Error: "missing " + headerChecksum})
		return
	}
	dest := filepath.Join(ts.dataDir, name)
	part := dest + ".part"

	var n int64
	var got string
	if r.Header.Get(headerEncoding) == encShuffleZstd {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{Error: "body: " + err.Error()})
			return
		}
		data, err := unpackFrame(raw)
		if err != nil {
			ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{Error: "body: " + err.Error()})
			return
		}
		if err := os.WriteFile(part, data, 0o644); err != nil {
			ts.sec.writeSignedJSON(w, r, http.StatusInternalServerError, UploadResult{Error: "write: " + err.Error()})
			return
		}
		n, got = int64(len(data)), sha256Hex(data)
	} else {
		f, err := os.Create(part)
		if err != nil {
			ts.sec.writeSignedJSON(w, r, http.StatusInternalServerError, UploadResult{Error: "write: " + err.Error()})
			return
		}
		h := sha256.New()
		n, err = io.Copy(io.MultiWriter(f, h), r.Body)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(part)
			ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{Error: "body: " + err.Error()})
			return
		}
		got = hex.EncodeToString(h.Sum(nil))
	}
	if want != got {
		os.Remove(part)
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, UploadResult{
			Error: fmt.Sprintf("checksum mismatch: want %s got %s", want, got),
		})
		return
	}
	if err := os.Rename(part, dest); err != nil {
		os.Remove(part)
		ts.sec.writeSignedJSON(w, r, http.StatusInternalServerError, UploadResult{Error: "write: " + err.Error()})
		return
	}
	ts.sec.writeSignedJSON(w, r, http.StatusOK, UploadResult{
		OK: true, Name: name, Bytes: n, SHA256: got,
		ElapsedMS: time.Since(start).Milliseconds(),
	})
}

// handleHave lets the server skip re-uploading a shared file (e.g. a master
// bias/dark/flat) that the worker already holds with the same content. Returns
// 200 if dataDir/name exists and its SHA-256 matches ?sha=, else 404.
func (ts *TransportServer) handleHave(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	want := r.URL.Query().Get("sha")
	if !validName(name) || want == "" {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, map[string]bool{"have": false})
		return
	}
	got, err := fileSHA256(filepath.Join(ts.dataDir, name))
	if err != nil || got != want {
		ts.sec.writeSignedJSON(w, r, http.StatusNotFound, map[string]bool{"have": false})
		return
	}
	ts.sec.writeSignedJSON(w, r, http.StatusOK, map[string]bool{"have": true})
}

// handleDownload serves a file previously stored in dataDir (used by the server
// to pull processed outputs back from a worker).
func (ts *TransportServer) handleDownload(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if !validName(name) {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, map[string]string{"error": "invalid file name"})
		return
	}
	data, err := os.ReadFile(filepath.Join(ts.dataDir, name))
	if err != nil {
		ts.sec.writeSignedJSON(w, r, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	sum := sha256Hex(data)
	w.Header().Set(headerChecksum, sum) // checksum of the ORIGINAL bytes
	if compressTransfers {
		w.Header().Set(headerEncoding, encShuffleZstd)
		data = packFrame(data)
		sum = sha256Hex(data)
	}
	ts.sec.writeSignedSum(w, r, http.StatusOK, "application/octet-stream", data, sum)
}

// processID maps each distributable op to the only PixInsight process its
// manifest may carry ("" = the op carries no process).
var processID = map[string]string{
	"registration":        "StarAlignment",
	"calibration":         "ImageCalibration",
	"localnorm":           "LocalNormalization",
	"measurements":        "",
	"integration":         "ImageIntegration",
	"light_integration":   "ImageIntegration",
	"drizzle_integration": "DrizzleIntegration",
}

// validateManifest checks a work manifest before it is handed to PixInsight:
// a known op, the matching process id, plain file names and identifier-only
// field names.
func validateManifest(m WorkManifest) error {
	want, ok := processID[m.Op]
	if !ok {
		return fmt.Errorf("unknown op %q", m.Op)
	}
	hasProcess := len(m.Process) > 0 && string(m.Process) != "null"
	if want == "" {
		if hasProcess {
			return fmt.Errorf("op %q carries no process", m.Op)
		}
	} else {
		if !hasProcess {
			return fmt.Errorf("op %q needs a process", m.Op)
		}
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(m.Process, &p); err != nil {
			return fmt.Errorf("bad process: %v", err)
		}
		if p.ID != want {
			return fmt.Errorf("op %q expects process %s, got %q", m.Op, want, p.ID)
		}
	}
	for _, n := range m.InputNames {
		if !validName(n) {
			return fmt.Errorf("invalid input name %q", n)
		}
	}
	if m.ReferenceName != "" && !validName(m.ReferenceName) {
		return fmt.Errorf("invalid reference name %q", m.ReferenceName)
	}
	for field, n := range m.FileRefFields {
		if !jsIdentifier.MatchString(field) {
			return fmt.Errorf("invalid field name %q", field)
		}
		if !validName(n) {
			return fmt.Errorf("invalid file name %q for %s", n, field)
		}
	}
	for _, f := range []string{m.TargetsField, m.DirField} {
		if f != "" && !jsIdentifier.MatchString(f) {
			return fmt.Errorf("invalid field name %q", f)
		}
	}
	return nil
}

// handleWork receives one shard of a distributed operation, validates it and
// runs it through the configured executor, returning the produced output files
// (which the server then downloads).
func (ts *TransportServer) handleWork(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		ts.sec.writeSignedJSON(w, r, http.StatusMethodNotAllowed, WorkResult{Error: "POST required"})
		return
	}
	body, err := io.ReadAll(r.Body) // read to EOF so the signed body hash is checked
	if err != nil {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, WorkResult{Error: "bad manifest: " + err.Error()})
		return
	}
	var m WorkManifest
	if err := json.Unmarshal(body, &m); err != nil {
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, WorkResult{Error: "bad manifest: " + err.Error()})
		return
	}
	if err := validateManifest(m); err != nil {
		log.Printf("rejected work manifest %q: %v", m.JobID, err)
		ts.sec.writeSignedJSON(w, r, http.StatusBadRequest, WorkResult{JobID: m.JobID, Error: "rejected manifest: " + err.Error()})
		return
	}
	outputs, err := ts.executor.Process(ts.dataDir, m)
	if err != nil {
		ts.sec.writeSignedJSON(w, r, http.StatusInternalServerError, WorkResult{JobID: m.JobID, Error: err.Error()})
		return
	}
	ts.sec.writeSignedJSON(w, r, http.StatusOK, WorkResult{OK: true, JobID: m.JobID, Outputs: outputs})
}

// --- client side ---

// FetchCapabilities performs the handshake GET /health against a peer.
func (cs *ClusterSecurity) FetchCapabilities(ctx context.Context, addr string) (Capabilities, error) {
	var caps Capabilities
	resp, body, err := cs.do(ctx, http.MethodGet, addr, "/health", nil, nil, nil)
	if err != nil {
		return caps, err
	}
	if resp.StatusCode != http.StatusOK {
		return caps, fmt.Errorf("health: %s", peerError(resp.StatusCode, body))
	}
	err = json.Unmarshal(body, &caps)
	return caps, err
}

// HasFile asks addr whether it already holds name with the given SHA-256, so the
// server can skip re-uploading unchanged shared files (masters, reference).
func (cs *ClusterSecurity) HasFile(ctx context.Context, addr, name, sha string) bool {
	resp, _, err := cs.do(ctx, http.MethodGet, addr, "/have", url.Values{"name": {name}, "sha": {sha}}, nil, nil)
	return err == nil && resp.StatusCode == http.StatusOK
}

// UploadFileCached uploads path to addr only if the worker doesn't already have
// it (same basename + SHA-256). Returns whether an upload actually happened. The
// file is read and hashed once, then reused for both the presence check and the
// upload, so skipping a re-send is free (no double read/hash).
func (cs *ClusterSecurity) UploadFileCached(ctx context.Context, addr, path string) (uploaded bool, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	sum := sha256Hex(data)
	if cs.HasFile(ctx, addr, filepath.Base(path), sum) {
		return false, nil // already present, skip transfer
	}
	_, err = cs.uploadData(ctx, addr, filepath.Base(path), data, sum)
	return err == nil, err
}

// UploadFile sends path to addr's /upload endpoint with an integrity checksum
// and returns the worker's echoed result.
func (cs *ClusterSecurity) UploadFile(ctx context.Context, addr, path string) (UploadResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return UploadResult{}, err
	}
	return cs.uploadData(ctx, addr, filepath.Base(path), data, sha256Hex(data))
}

// uploadData POSTs already-read bytes (with their precomputed SHA-256) to addr's
// /upload endpoint, compressing on the wire when enabled. Shared by UploadFile and
// UploadFileCached so a file is read and hashed only once.
func (cs *ClusterSecurity) uploadData(ctx context.Context, addr, name string, data []byte, sum string) (UploadResult, error) {
	var res UploadResult
	body := data
	hdr := http.Header{}
	hdr.Set(headerChecksum, sum)
	hdr.Set("Content-Type", "application/octet-stream")
	if compressTransfers {
		body = packFrame(data)
		hdr.Set(headerEncoding, encShuffleZstd)
	} else {
		hdr.Set(headerContentSHA, sum) // wire body == file: reuse its hash
	}
	resp, raw, err := cs.do(ctx, http.MethodPost, addr, "/upload", url.Values{"name": {name}}, body, hdr)
	if err != nil {
		return res, err
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return res, err
	}
	if resp.StatusCode != http.StatusOK || !res.OK {
		return res, fmt.Errorf("upload rejected: %s", peerError(resp.StatusCode, raw))
	}
	if res.SHA256 != sum {
		return res, fmt.Errorf("round-trip checksum mismatch: local %s remote %s", sum, res.SHA256)
	}
	return res, nil
}

// DownloadFile pulls name from addr's /download endpoint into destPath and
// returns the downloaded file's SHA-256 for integrity checking by the caller.
func (cs *ClusterSecurity) DownloadFile(ctx context.Context, addr, name, destPath string) (string, error) {
	resp, raw, err := cs.do(ctx, http.MethodGet, addr, "/download", url.Values{"name": {name}}, nil, nil)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: %s", name, peerError(resp.StatusCode, raw))
	}
	// the wire body hash was already verified against the signed header: reuse it
	// for an uncompressed body instead of hashing the file a second time
	data, sum := raw, resp.Header.Get(headerContentSHA)
	if resp.Header.Get(headerEncoding) == encShuffleZstd {
		if data, err = unpackFrame(raw); err != nil {
			return "", fmt.Errorf("decompress %s: %w", name, err)
		}
		sum = sha256Hex(data)
	}
	if want := resp.Header.Get(headerChecksum); want != sum {
		return "", fmt.Errorf("download %s: checksum mismatch", name)
	}
	if err := os.WriteFile(destPath, data, 0o644); err != nil {
		return "", err
	}
	return sum, nil
}

// SendWork posts a shard manifest to addr's /lan/work endpoint and returns the
// worker's result (the produced output files, by name).
func (cs *ClusterSecurity) SendWork(ctx context.Context, addr string, m WorkManifest) (WorkResult, error) {
	var res WorkResult
	body, err := json.Marshal(m)
	if err != nil {
		return res, err
	}
	hdr := http.Header{}
	hdr.Set("Content-Type", "application/json")
	resp, raw, err := cs.do(ctx, http.MethodPost, addr, "/lan/work", nil, body, hdr)
	if err != nil {
		return res, err
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return res, fmt.Errorf("work: %s", peerError(resp.StatusCode, raw))
	}
	if resp.StatusCode != http.StatusOK || !res.OK {
		return res, fmt.Errorf("work rejected by %s: %s", addr, peerError(resp.StatusCode, raw))
	}
	return res, nil
}

// errNoSecret is reported when a daemon is started without a cluster key.
var errNoSecret = errors.New("no cluster key: pass --secret-file")

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
