package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base32"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Cluster security. Every node of a cluster holds the same secret (a random key
// generated on the server and pasted once on each client). Everything else is
// derived from it:
//
//   - a cluster CA (ed25519, deterministic from the secret) that signs each
//     process's ephemeral TLS certificate, so LAN traffic is mutual TLS and a
//     node with another secret fails the handshake;
//   - a request key that signs every LAN request and response (HMAC), on top of
//     TLS;
//   - a beacon key that signs discovery beacons.
//
// The secret itself is never logged, sent or written anywhere by the sidecar.

const (
	clusterKeyLen    = 32 // normalized key: 32 base32 chars (160 bits)
	clusterTLSName   = "wbpp-cluster"
	authSkewLimit    = 10 * time.Minute
	nonceCacheMax    = 200000
	headerDate       = "X-WBPP-Date"
	headerNonce      = "X-WBPP-Nonce"
	headerContentSHA = "X-WBPP-Content-SHA256"
	headerSignature  = "X-WBPP-Signature"
)

var emptySHA256 = sha256Hex(nil)

// GenerateClusterKey returns a fresh random key formatted for humans:
// 8 groups of 4 base32 characters joined by "-".
func GenerateClusterKey() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	s := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	groups := make([]string, 0, 8)
	for i := 0; i < len(s); i += 4 {
		groups = append(groups, s[i:i+4])
	}
	return strings.Join(groups, "-"), nil
}

// NormalizeClusterKey turns a pasted key into its canonical 32-char form:
// uppercase, every character outside [A-Z0-9] dropped (dashes, spaces, line
// breaks). Valid only if exactly 32 characters of the base32 alphabet remain.
func NormalizeClusterKey(in string) (string, error) {
	var b strings.Builder
	for _, r := range strings.ToUpper(in) {
		if (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	s := b.String()
	if len(s) != clusterKeyLen {
		return "", fmt.Errorf("cluster key must have %d characters (got %d)", clusterKeyLen, len(s))
	}
	for _, r := range s {
		if !((r >= 'A' && r <= 'Z') || (r >= '2' && r <= '7')) {
			return "", fmt.Errorf("cluster key contains an invalid character %q (allowed: A-Z, 2-7)", r)
		}
	}
	return s, nil
}

// ClusterSecurity holds everything derived from the cluster secret.
type ClusterSecurity struct {
	requestKey []byte
	beaconKey  []byte

	caPool    *x509.CertPool
	serverTLS *tls.Config
	clientTLS *tls.Config
	client    *http.Client

	mu        sync.Mutex
	nonces    map[string]time.Time // replay cache
	lastLog   map[string]time.Time // rate-limited auth failure logs, per remote IP
	now       func() time.Time
	skewLimit time.Duration
}

func deriveKey(secret, label string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(label))
	return m.Sum(nil)
}

// NewClusterSecurity validates the key and builds the TLS material and the
// cluster HTTP client.
func NewClusterSecurity(key string) (*ClusterSecurity, error) {
	secret, err := NormalizeClusterKey(key)
	if err != nil {
		return nil, err
	}
	cs := &ClusterSecurity{
		requestKey: deriveKey(secret, "dwbpp/3/request"),
		beaconKey:  deriveKey(secret, "dwbpp/3/beacon"),
		nonces:     map[string]time.Time{},
		lastLog:    map[string]time.Time{},
		now:        time.Now,
		skewLimit:  authSkewLimit,
	}

	caCert, caKey, err := buildClusterCA(deriveKey(secret, "dwbpp/3/ca"))
	if err != nil {
		return nil, fmt.Errorf("cluster CA: %w", err)
	}
	leaf, err := buildLeafCert(caCert, caKey)
	if err != nil {
		return nil, fmt.Errorf("node certificate: %w", err)
	}
	cs.caPool = x509.NewCertPool()
	cs.caPool.AddCert(caCert)

	cs.serverTLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{leaf},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    cs.caPool,
	}
	cs.clientTLS = &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{leaf},
		RootCAs:      cs.caPool,
		ServerName:   clusterTLSName,
	}
	cs.client = &http.Client{
		Timeout: 0, // no timeout: large frame uploads
		Transport: &http.Transport{
			Proxy:               nil, // LAN traffic never goes through a system proxy
			DialContext:         (&net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			TLSClientConfig:     cs.clientTLS,
			TLSHandshakeTimeout: 10 * time.Second,
			MaxIdleConnsPerHost: 8,
			IdleConnTimeout:     90 * time.Second,
		},
	}
	return cs, nil
}

var (
	certNotBefore = time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	certNotAfter  = time.Date(2124, 1, 1, 0, 0, 0, 0, time.UTC)
)

// buildClusterCA rebuilds the cluster CA from the seed. Every node derives the
// same key pair and the same certificate, so a leaf signed by any node of the
// cluster verifies on every other node.
func buildClusterCA(seed []byte) (*x509.Certificate, ed25519.PrivateKey, error) {
	priv := ed25519.NewKeyFromSeed(seed[:ed25519.SeedSize])
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "Distributed WBPP cluster CA"},
		NotBefore:             certNotBefore,
		NotAfter:              certNotAfter,
		IsCA:                  true,
		BasicConstraintsValid: true,
		MaxPathLenZero:        true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, priv.Public(), priv)
	if err != nil {
		return nil, nil, err
	}
	cert, err := x509.ParseCertificate(der)
	return cert, priv, err
}

// buildLeafCert creates this process's ephemeral TLS identity, signed by the CA.
func buildLeafCert(ca *x509.Certificate, caKey ed25519.PrivateKey) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "Distributed WBPP node"},
		DNSNames:     []string{clusterTLSName},
		NotBefore:    certNotBefore,
		NotAfter:     certNotAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca, &key.PublicKey, caKey)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

// --- request / response signatures ---

func (cs *ClusterSecurity) mac(parts ...string) string {
	m := hmac.New(sha256.New, cs.requestKey)
	m.Write([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(m.Sum(nil))
}

func (cs *ClusterSecurity) requestSignature(method, path, rawQuery, date, nonce, bodySHA string) string {
	return cs.mac("DWBPP3", method, path, rawQuery, date, nonce, bodySHA)
}

func (cs *ClusterSecurity) responseSignature(nonce string, status int, bodySHA string) string {
	return cs.mac("DWBPP3-RESP", nonce, strconv.Itoa(status), bodySHA)
}

func newNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// signRequest stamps req with the date, a fresh nonce, the body hash and the
// signature. Returns the nonce (the response signature is bound to it).
func (cs *ClusterSecurity) signRequest(req *http.Request, bodySHA string) string {
	return cs.signRequestAt(req, bodySHA, cs.now())
}

func (cs *ClusterSecurity) signRequestAt(req *http.Request, bodySHA string, at time.Time) string {
	date := strconv.FormatInt(at.UnixMilli(), 10)
	nonce := newNonce()
	req.Header.Set(headerDate, date)
	req.Header.Set(headerNonce, nonce)
	req.Header.Set(headerContentSHA, bodySHA)
	req.Header.Set(headerSignature, cs.requestSignature(req.Method, req.URL.Path, req.URL.RawQuery, date, nonce, bodySHA))
	return nonce
}

// writeSigned writes a LAN response with its body hash and signature, bound to
// the request's nonce so a response cannot be replayed onto another request.
func (cs *ClusterSecurity) writeSigned(w http.ResponseWriter, r *http.Request, status int, contentType string, body []byte) {
	cs.writeSignedSum(w, r, status, contentType, body, sha256Hex(body))
}

// writeSignedSum is writeSigned with the body hash already computed by the caller.
func (cs *ClusterSecurity) writeSignedSum(w http.ResponseWriter, r *http.Request, status int, contentType string, body []byte, sum string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set(headerContentSHA, sum)
	w.Header().Set(headerSignature, cs.responseSignature(r.Header.Get(headerNonce), status, sum))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func (cs *ClusterSecurity) writeSignedJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		b = []byte(`{"error":"encode"}`)
		status = http.StatusInternalServerError
	}
	cs.writeSigned(w, r, status, "application/json", append(b, '\n'))
}

// errBodyTampered is returned by a verified request body whose bytes do not
// match the signed hash.
var errBodyTampered = errors.New("request body does not match its signed hash")

// verifyingBody hashes the body as it is read and fails at EOF if it does not
// match the signed hash, so a handler never commits tampered data.
type verifyingBody struct {
	r    io.ReadCloser
	h    hash.Hash
	want string
}

func (v *verifyingBody) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	if n > 0 {
		_, _ = v.h.Write(p[:n])
	}
	if err == io.EOF && hex.EncodeToString(v.h.Sum(nil)) != v.want {
		return n, errBodyTampered
	}
	return n, err
}

func (v *verifyingBody) Close() error { return v.r.Close() }

// authenticate wraps the LAN handlers: it checks the request signature, the
// clock window and the nonce, caps the body size and verifies the body hash as
// the handler reads it. limits maps a path to its body cap (default 64 KiB).
func (cs *ClusterSecurity) authenticate(next http.Handler, limits map[string]int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		date, nonce := r.Header.Get(headerDate), r.Header.Get(headerNonce)
		bodySHA, sig := r.Header.Get(headerContentSHA), r.Header.Get(headerSignature)
		if date == "" || nonce == "" || bodySHA == "" || sig == "" {
			cs.reject(w, r, http.StatusUnauthorized, "unauthenticated request (no cluster signature)")
			return
		}
		want := cs.requestSignature(r.Method, r.URL.Path, r.URL.RawQuery, date, nonce, bodySHA)
		if !hmac.Equal([]byte(want), []byte(sig)) {
			cs.reject(w, r, http.StatusUnauthorized, "bad request signature (different cluster key?)")
			return
		}
		ms, err := strconv.ParseInt(date, 10, 64)
		if err != nil {
			cs.reject(w, r, http.StatusUnauthorized, "bad request date")
			return
		}
		now := cs.now()
		skew := now.Sub(time.UnixMilli(ms))
		if skew > cs.skewLimit || skew < -cs.skewLimit {
			cs.reject(w, r, http.StatusUnauthorized, fmt.Sprintf(
				"clock skew: the sender's clock differs from this node's by %ds (limit %ds); synchronize the clocks of both PCs",
				int64(skew.Seconds()), int64(cs.skewLimit.Seconds())))
			return
		}
		if msg := cs.useNonce(nonce, now); msg != "" {
			cs.reject(w, r, http.StatusUnauthorized, msg)
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if bodySHA != emptySHA256 || r.ContentLength > 0 {
				cs.reject(w, r, http.StatusBadRequest, "unexpected request body")
				return
			}
		}
		limit, ok := limits[r.URL.Path]
		if !ok {
			limit = 64 << 10
		}
		r.Body = &verifyingBody{r: http.MaxBytesReader(w, r.Body, limit), h: sha256.New(), want: bodySHA}
		next.ServeHTTP(w, r)
	})
}

// useNonce records a nonce, refusing one already seen inside the window.
func (cs *ClusterSecurity) useNonce(nonce string, now time.Time) string {
	if len(nonce) != 32 {
		return "bad request nonce"
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if _, seen := cs.nonces[nonce]; seen {
		return "replayed request"
	}
	if len(cs.nonces) >= nonceCacheMax {
		cutoff := now.Add(-2 * cs.skewLimit)
		for k, t := range cs.nonces {
			if t.Before(cutoff) {
				delete(cs.nonces, k)
			}
		}
		if len(cs.nonces) >= nonceCacheMax {
			return "too many requests, retry later"
		}
	}
	cs.nonces[nonce] = now
	return ""
}

// reject answers an authentication failure and logs it at most once a minute
// per remote address (never logs header values).
func (cs *ClusterSecurity) reject(w http.ResponseWriter, r *http.Request, status int, msg string) {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	cs.mu.Lock()
	last, seen := cs.lastLog[host]
	if !seen || time.Since(last) > time.Minute {
		cs.lastLog[host] = time.Now()
		cs.mu.Unlock()
		log.Printf("rejected %s %s from %s: %s", r.Method, r.URL.Path, host, msg)
	} else {
		cs.mu.Unlock()
	}
	cs.writeSignedJSON(w, r, status, map[string]string{"error": msg})
}

// do sends one signed request to a peer over mutual TLS and returns the
// response with its verified body. A response whose signature does not match
// is an error: its body is never trusted.
func (cs *ClusterSecurity) do(ctx context.Context, method, addr, path string, query url.Values, body []byte, header http.Header) (*http.Response, []byte, error) {
	u := url.URL{Scheme: "https", Host: addr, Path: path}
	if query != nil {
		u.RawQuery = query.Encode()
	}
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), rd)
	if err != nil {
		return nil, nil, err
	}
	if body != nil {
		req.ContentLength = int64(len(body))
	}
	for k, vs := range header {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	// a caller that already hashed the body passes it in the header (saves a pass
	// over a large frame)
	bodySHA := req.Header.Get(headerContentSHA)
	if bodySHA == "" {
		bodySHA = sha256Hex(body)
	}
	nonce := cs.signRequest(req, bodySHA)
	resp, err := cs.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp, nil, err
	}
	sum := sha256Hex(raw)
	if resp.Header.Get(headerContentSHA) != sum ||
		!hmac.Equal([]byte(resp.Header.Get(headerSignature)), []byte(cs.responseSignature(nonce, resp.StatusCode, sum))) {
		return resp, nil, fmt.Errorf("%s %s: response signature invalid (status %d)", method, path, resp.StatusCode)
	}
	return resp, raw, nil
}

// peerError extracts the {"error": "..."} message of a peer response.
func peerError(status int, body []byte) string {
	var e struct {
		Error string `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error != "" {
		return e.Error
	}
	return "status " + strconv.Itoa(status)
}

// --- beacons ---

// signBeacon returns the datagram for a beacon: JSON, newline, hex HMAC.
func (cs *ClusterSecurity) signBeacon(b Beacon) []byte {
	js, _ := json.Marshal(b)
	m := hmac.New(sha256.New, cs.beaconKey)
	m.Write(js)
	return append(append(js, '\n'), []byte(hex.EncodeToString(m.Sum(nil)))...)
}

func (cs *ClusterSecurity) beaconMACValid(js, mac []byte) bool {
	m := hmac.New(sha256.New, cs.beaconKey)
	m.Write(js)
	return hmac.Equal([]byte(hex.EncodeToString(m.Sum(nil))), bytes.TrimSpace(mac))
}

// --- localhost control planes ---

const headerControl = "X-WBPP-Control"

// localControlOnly guards the 127.0.0.1 control APIs against requests a web
// page could forge from a browser on this machine (cross-site POST, DNS
// rebinding): a custom header (forces a CORS preflight we never answer) and a
// loopback Host header are both required.
func localControlOnly(port int, next http.Handler) http.Handler {
	p := strconv.Itoa(port)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(headerControl) != "1" || (r.Host != "127.0.0.1:"+p && r.Host != "localhost:"+p) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden"})
			return
		}
		next.ServeHTTP(w, r)
	})
}
