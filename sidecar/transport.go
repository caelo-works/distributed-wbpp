package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// Header carrying the sender's precomputed SHA-256 (hex) so the receiver can
// reject a corrupted or truncated transfer.
const headerChecksum = "X-WBPP-SHA256"
const headerEncoding = "X-WBPP-Encoding"
const encShuffleZstd = "sz" // body is byte-shuffle + zstd (see compress.go)

// compressTransfers gates the SENDER (--compress). Off by default: on a fast LAN the
// compress+decompress CPU costs more than the bandwidth it saves — it only pays on a
// slow/shared link (Wi-Fi, 1Gbps split many ways). Receivers always honour the header,
// so a compressing node interoperates with a non-compressing one either way.
var compressTransfers bool

// readBody reads a request body, decompressing it if it was sent shuffle+zstd.
func readBody(r *http.Request) ([]byte, error) {
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if r.Header.Get(headerEncoding) == encShuffleZstd {
		return unpackFrame(raw)
	}
	return raw, nil
}

func sha256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// TransportServer is the per-node HTTP endpoint used for the handshake and for
// receiving files. In Jalon 1 a worker runs this and the server uploads to it;
// later both roles use the same endpoints.
type TransportServer struct {
	caps     Capabilities
	dataDir  string
	executor Executor // worker-side processing backend (mock or PixInsight)
	srv      *http.Server
	ln       net.Listener
}

// NewTransportServer binds a listener (port 0 = OS-assigned) but does not yet
// serve; call Port() to learn the chosen port, then Serve().
func NewTransportServer(caps Capabilities, dataDir string, port int) (*TransportServer, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return nil, err
	}
	ts := &TransportServer{caps: caps, dataDir: dataDir, executor: MockExecutor{}, ln: ln}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", ts.handleHealth)
	mux.HandleFunc("/have", ts.handleHave)
	mux.HandleFunc("/upload", ts.handleUpload)
	mux.HandleFunc("/download", ts.handleDownload)
	mux.HandleFunc("/lan/work", ts.handleWork)
	ts.srv = &http.Server{Handler: mux}
	return ts, nil
}

// SetExecutor swaps the worker-side processing backend (default MockExecutor).
func (ts *TransportServer) SetExecutor(e Executor) { ts.executor = e }

func (ts *TransportServer) Port() int { return ts.ln.Addr().(*net.TCPAddr).Port }

func (ts *TransportServer) Serve() error {
	err := ts.srv.Serve(ts.ln)
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func (ts *TransportServer) Shutdown(ctx context.Context) error { return ts.srv.Shutdown(ctx) }

func (ts *TransportServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, ts.caps)
}

// handleUpload streams the request body to a file while hashing it, then
// verifies the hash against the sender-provided header before acknowledging.
func (ts *TransportServer) handleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, UploadResult{Error: "POST required"})
		return
	}
	start := time.Now()
	name := filepath.Base(r.URL.Query().Get("name"))
	if name == "" || name == "." || name == "/" {
		name = "upload.bin"
	}
	dest := filepath.Join(ts.dataDir, name)

	data, err := readBody(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, UploadResult{Error: "body: " + err.Error()})
		return
	}
	got := sha256Hex(data)
	if want := r.Header.Get(headerChecksum); want != "" && want != got {
		writeJSON(w, http.StatusBadRequest, UploadResult{
			Error: fmt.Sprintf("checksum mismatch: want %s got %s", want, got),
		})
		return
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, UploadResult{Error: "write: " + err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, UploadResult{
		OK: true, Name: name, Bytes: int64(len(data)), SHA256: got,
		ElapsedMS: time.Since(start).Milliseconds(),
	})
}

// handleHave lets the server skip re-uploading a shared file (e.g. a master
// bias/dark/flat) that the worker already holds with the same content. Returns
// 200 if dataDir/name exists and its SHA-256 matches ?sha=, else 404.
func (ts *TransportServer) handleHave(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("name"))
	want := r.URL.Query().Get("sha")
	if name == "" || want == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	got, err := fileSHA256(filepath.Join(ts.dataDir, name))
	if err != nil || got != want {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// handleDownload serves a file previously stored in dataDir (used by the server
// to pull processed outputs back from a worker).
func (ts *TransportServer) handleDownload(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("name"))
	if name == "" || name == "." {
		http.Error(w, "missing name", http.StatusBadRequest)
		return
	}
	path := filepath.Join(ts.dataDir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set(headerChecksum, sha256Hex(data)) // checksum of the ORIGINAL bytes
	if compressTransfers {
		w.Header().Set(headerEncoding, encShuffleZstd)
		_, _ = w.Write(packFrame(data))
	} else {
		_, _ = w.Write(data)
	}
}

// handleWork receives one shard of a distributed operation and runs it through
// the configured executor, returning the produced output files (which the
// server then downloads). Synchronous: fine for the mock executor; the
// PixInsight executor will block until the local worker script finishes.
func (ts *TransportServer) handleWork(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, WorkResult{Error: "POST required"})
		return
	}
	var m WorkManifest
	if err := json.NewDecoder(r.Body).Decode(&m); err != nil {
		writeJSON(w, http.StatusBadRequest, WorkResult{Error: "bad manifest: " + err.Error()})
		return
	}
	outputs, err := ts.executor.Process(ts.dataDir, m)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, WorkResult{JobID: m.JobID, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, WorkResult{OK: true, JobID: m.JobID, Outputs: outputs})
}

// --- client side ---

var httpClient = &http.Client{Timeout: 0} // no timeout: large frame uploads

// FetchCapabilities performs the handshake GET /health against a peer.
func FetchCapabilities(ctx context.Context, addr string) (Capabilities, error) {
	var caps Capabilities
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+"/health", nil)
	if err != nil {
		return caps, err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return caps, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return caps, fmt.Errorf("health: status %d", resp.StatusCode)
	}
	err = json.NewDecoder(resp.Body).Decode(&caps)
	return caps, err
}

// HasFile asks addr whether it already holds name with the given SHA-256, so the
// server can skip re-uploading unchanged shared files (masters, reference).
func HasFile(ctx context.Context, addr, name, sha string) bool {
	url := "http://" + addr + "/have?name=" + name + "&sha=" + sha
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// UploadFileCached uploads path to addr only if the worker doesn't already have
// it (same basename + SHA-256). Returns whether an upload actually happened. The
// file is read and hashed once, then reused for both the presence check and the
// upload, so skipping a re-send is free (no double read/hash).
func UploadFileCached(ctx context.Context, addr, path string) (uploaded bool, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return false, err
	}
	sum := sha256Hex(data)
	if HasFile(ctx, addr, filepath.Base(path), sum) {
		return false, nil // already present, skip transfer
	}
	_, err = uploadData(ctx, addr, filepath.Base(path), data, sum)
	return err == nil, err
}

// UploadFile sends path to addr's /upload endpoint with an integrity checksum
// and returns the worker's echoed result.
func UploadFile(ctx context.Context, addr, path string) (UploadResult, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return UploadResult{}, err
	}
	return uploadData(ctx, addr, filepath.Base(path), data, sha256Hex(data))
}

// uploadData POSTs already-read bytes (with their precomputed SHA-256) to addr's
// /upload endpoint, compressing on the wire when enabled. Shared by UploadFile and
// UploadFileCached so a file is read and hashed only once.
func uploadData(ctx context.Context, addr, name string, data []byte, sum string) (UploadResult, error) {
	var res UploadResult
	body := data
	enc := ""
	if compressTransfers {
		body, enc = packFrame(data), encShuffleZstd
	}

	url := "http://" + addr + "/upload?name=" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return res, err
	}
	req.ContentLength = int64(len(body))
	req.Header.Set(headerChecksum, sum)
	if enc != "" {
		req.Header.Set(headerEncoding, enc)
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := httpClient.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return res, err
	}
	if resp.StatusCode != http.StatusOK || !res.OK {
		return res, fmt.Errorf("upload rejected: %s", res.Error)
	}
	if res.SHA256 != sum {
		return res, fmt.Errorf("round-trip checksum mismatch: local %s remote %s", sum, res.SHA256)
	}
	return res, nil
}

// DownloadFile pulls name from addr's /download endpoint into destPath and
// returns the downloaded file's SHA-256 for integrity checking by the caller.
func DownloadFile(ctx context.Context, addr, name, destPath string) (string, error) {
	url := "http://" + addr + "/download?name=" + name
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("download %s: status %d", name, resp.StatusCode)
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	data := raw
	if resp.Header.Get(headerEncoding) == encShuffleZstd {
		if data, err = unpackFrame(raw); err != nil {
			return "", fmt.Errorf("decompress %s: %w", name, err)
		}
	}
	if err := os.WriteFile(destPath, data, 0o644); err != nil {
		return "", err
	}
	return sha256Hex(data), nil
}

// SendWork posts a shard manifest to addr's /lan/work endpoint and returns the
// worker's result (the produced output files, by name).
func SendWork(ctx context.Context, addr string, m WorkManifest) (WorkResult, error) {
	var res WorkResult
	body, err := json.Marshal(m)
	if err != nil {
		return res, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+addr+"/lan/work", bytes.NewReader(body))
	if err != nil {
		return res, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return res, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return res, err
	}
	if resp.StatusCode != http.StatusOK || !res.OK {
		return res, fmt.Errorf("work rejected by %s: %s", addr, res.Error)
	}
	return res, nil
}

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
