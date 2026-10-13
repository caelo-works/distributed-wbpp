// Command wbpp-sidecar is the networking companion for the Distributed-WBPP
// PixInsight cluster. PixInsight's scripting runtime (PJSR) can act only as a
// network *client*, so this self-contained binary provides the two things it
// cannot: LAN auto-discovery (signed UDP multicast beacons) and peer-to-peer
// file transfer (mutual TLS, every request signed with the cluster key).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// buildVersion is injected at build time via -ldflags "-X main.buildVersion=...".
var buildVersion = "dev"

func main() {
	// `ctl` subcommands have their own flag set (thin local-daemon HTTP clients
	// driven by PixInsight via ExternalProcess + files).
	if len(os.Args) > 1 && os.Args[1] == "ctl" {
		runCtl(os.Args[2:])
		return
	}
	// `keygen` / `keycheck`: create or validate a cluster key (file channel, for PJSR).
	if len(os.Args) > 1 && (os.Args[1] == "keygen" || os.Args[1] == "keycheck") {
		runKeyCmd(os.Args[1], os.Args[2:])
		return
	}

	var (
		showVersion = flag.Bool("version", false, "print version and exit")
		mode        = flag.String("mode", "", "server | worker")
		secretFile  = flag.String("secret-file", "", "file holding the cluster key (read, then deleted); required by every daemon mode")
		listen      = flag.String("listen", "", "worker: comma-separated IPv4 addresses to listen on (default: every private LAN address + 127.0.0.1)")
		dir         = flag.String("dir", "./sidecar-data", "directory for received files")
		port        = flag.Int("port", 0, "worker HTTP port (0 = OS-assigned)")
		piVersion   = flag.String("pi-version", "unknown", "PixInsight version (handshake identity)")
		wbppVersion = flag.String("wbpp-version", "unknown", "WBPP version (handshake identity)")
		sendFile    = flag.String("send", "", "server: file to send to the first matching worker")
		target      = flag.String("target", "", "server: explicit host:port, bypassing discovery")
		peers       = flag.String("peers", "", "agent: comma-separated static worker host:port list (bench: bypass multicast)")
		listFor     = flag.Duration("list", 0, "server: just list discovered nodes for this duration")
		discoverTO  = flag.Duration("discover-timeout", 30*time.Second, "server: how long to wait for a worker")
		force       = flag.Bool("force", false, "server: send even if the version handshake mismatches")

		distribute = flag.String("distribute", "", "server: directory of input frames to shard across workers")
		reference  = flag.String("reference", "", "server: shared reference frame pushed to every worker (optional)")
		op         = flag.String("op", "registration", "server: operation name carried in the work manifest")
		outDir     = flag.String("out", "./distributed-out", "server: where to collect processed outputs")
		postfix    = flag.String("postfix", "_r", "server: output filename postfix (StarAlignment uses _r)")
		outExt     = flag.String("out-ext", ".xisf", "server: output file extension")

		controlPort = flag.Int("control-port", 48099, "agent/worker: localhost control API port (PJSR talks to this)")
		executor    = flag.String("executor", "mock", "worker backend: 'pull' (local PixInsight) | 'mock' (copy, for tests)")
		jsonOut     = flag.Bool("json", false, "server --list: emit discovered nodes as JSON")
		outFile     = flag.String("out-file", "", "write JSON result to this file (robust PJSR channel; stdout capture is unreliable in PixInsight)")
		jobFile     = flag.String("job-file", "", "server: run a DistributeJob read from this JSON file, write the report to --out-file")
		logFile     = flag.String("log-file", "", "also write the daemon log to this file (diagnostics)")
		compress    = flag.Bool("compress", false, "compress frame transfers (byte-shuffle+zstd); only worth it on a slow/shared link, a net loss on a fast LAN")
	)
	flag.Parse()
	compressTransfers = *compress

	if *logFile != "" {
		if f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644); err == nil {
			log.SetOutput(io.MultiWriter(os.Stderr, f))
		}
	}

	if *showVersion {
		fmt.Printf("wbpp-sidecar %s (%s/%s, %s)\n", buildVersion, runtime.GOOS, runtime.GOARCH, "protocol "+strconv.Itoa(ProtocolVersion))
		return
	}

	nodeID := makeNodeID(*port)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var sec *ClusterSecurity
	if *mode == "worker" || *mode == "server" || *mode == "agent" {
		var err error
		if sec, err = loadSecret(*secretFile); err != nil {
			log.Fatalf("%s: %v", *mode, err)
		}
	}

	switch *mode {
	case "worker":
		var ips []string
		if *listen != "" {
			for _, a := range strings.Split(*listen, ",") {
				if a = strings.TrimSpace(a); a != "" {
					ips = append(ips, a)
				}
			}
		} else {
			ips = clusterListenIPs()
		}
		runWorker(ctx, sec, workerConfig{
			dir: *dir, port: *port, nodeID: nodeID, listen: ips,
			pi: *piVersion, wbpp: *wbppVersion, executor: *executor, controlPort: *controlPort,
		})
	case "server":
		sc := serverConfig{
			dir: *dir, nodeID: nodeID, pi: *piVersion, wbpp: *wbppVersion,
			sendFile: *sendFile, target: *target, listFor: *listFor, discoverTO: *discoverTO, force: *force,
			distribute: *distribute, reference: *reference, op: *op, outDir: *outDir,
			postfix: *postfix, outExt: *outExt, jsonOut: *jsonOut, outFile: *outFile, jobFile: *jobFile,
		}
		runServer(ctx, sec, sc)
	case "agent":
		sc := serverConfig{
			dir: *dir, nodeID: nodeID, pi: *piVersion, wbpp: *wbppVersion,
			discoverTO: *discoverTO, op: *op, outDir: *outDir, postfix: *postfix, outExt: *outExt,
			peers: *peers,
		}
		runAgent(ctx, sec, sc, *controlPort)
	default:
		fmt.Fprintln(os.Stderr, "usage: wbpp-sidecar --mode server|worker|agent [flags]")
		flag.PrintDefaults()
		os.Exit(2)
	}
}

// loadSecret reads the cluster key from path, deletes the file (best effort, so
// the key does not linger on disk) and builds the cluster security material.
func loadSecret(path string) (*ClusterSecurity, error) {
	if path == "" {
		return nil, errNoSecret
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cluster key: %v", err)
	}
	_ = os.Remove(path)
	sec, err := NewClusterSecurity(string(raw))
	if err != nil {
		return nil, fmt.Errorf("cluster key: %v", err)
	}
	return sec, nil
}

// runKeyCmd implements `keygen [--out-file F]` and `keycheck --in-file F [--out-file G]`.
func runKeyCmd(cmd string, args []string) {
	fs := flag.NewFlagSet(cmd, flag.ExitOnError)
	outFile := fs.String("out-file", "", "write the result to this file")
	inFile := fs.String("in-file", "", "keycheck: file holding the key to validate")
	_ = fs.Parse(args)
	if cmd == "keygen" {
		key, err := GenerateClusterKey()
		if err != nil {
			fmt.Fprintln(os.Stderr, "keygen:", err)
			os.Exit(1)
		}
		writeOut(*outFile, []byte(key))
		return
	}
	res := map[string]any{"ok": true}
	raw, err := os.ReadFile(*inFile)
	if err == nil {
		_, err = NormalizeClusterKey(string(raw))
	}
	if err != nil {
		res = map[string]any{"ok": false, "error": err.Error()}
	}
	b, _ := json.Marshal(res)
	writeOut(*outFile, b)
}

type workerConfig struct {
	dir              string
	port             int
	listen           []string
	nodeID, pi, wbpp string
	executor         string
	controlPort      int
}

func runWorker(ctx context.Context, sec *ClusterSecurity, wc workerConfig) {
	caps := Capabilities{
		Magic: BeaconMagic, Protocol: ProtocolVersion, NodeID: wc.nodeID,
		Role: RoleWorker, OS: runtime.GOOS, PIVersion: wc.pi, WBPPVersion: wc.wbpp,
	}
	dir, pi, wbpp := wc.dir, wc.pi, wc.wbpp
	nodeID := wc.nodeID
	ts, err := NewTransportServer(caps, dir, wc.port, wc.listen, sec)
	if err != nil {
		log.Fatalf("worker: %v", err)
	}

	// Choose the processing backend. 'pull' is the production path: the local
	// PixInsight worker script pulls shards over localhost and runs them. 'mock'
	// copies inputs->_r (for testing the LAN plumbing without PixInsight).
	if wc.executor == "pull" {
		pe := NewPullExecutor(dir, 0)
		ts.SetExecutor(pe)
		startWorkerControlAPI(ctx, pe, wc.controlPort, nodeID)
	}

	actualPort := ts.Port()
	log.Printf("worker %s listening on port %d of %s (os=%s, pi=%s, wbpp=%s, executor=%s)",
		nodeID, actualPort, strings.Join(append(ts.Addrs(), "127.0.0.1"), ", "), runtime.GOOS, pi, wbpp, wc.executor)

	go func() {
		if err := ts.Serve(); err != nil {
			log.Printf("worker: http server stopped: %v", err)
		}
	}()

	beacon := Beacon{
		Magic: BeaconMagic, Protocol: ProtocolVersion, NodeID: nodeID,
		Role: RoleWorker, Host: hostname(), HTTPPort: actualPort, Addrs: ts.Addrs(),
		OS: runtime.GOOS, PIVersion: pi, WBPPVersion: wbpp,
	}
	go func() {
		if err := Advertise(ctx, sec, beacon); err != nil {
			log.Printf("worker: advertise stopped: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("worker %s shutting down", nodeID)
	sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = ts.Shutdown(sctx)
}

type serverConfig struct {
	dir, nodeID, pi, wbpp     string
	sendFile, target, peers   string
	listFor, discoverTO       time.Duration
	force                     bool
	distribute, reference, op string
	outDir, postfix, outExt   string
	jsonOut                   bool
	outFile, jobFile          string
}

func runServer(ctx context.Context, sec *ClusterSecurity, sc serverConfig) {
	self := Capabilities{Protocol: ProtocolVersion, NodeID: sc.nodeID, Role: RoleServer, OS: runtime.GOOS, PIVersion: sc.pi, WBPPVersion: sc.wbpp}

	// Explicit single-file send to an explicit target (debugging / CI).
	if sc.target != "" && sc.distribute == "" {
		dispatch(ctx, sec, self, sc.target, sc.sendFile, sc.force)
		return
	}

	reg := NewRegistry()
	bctx, cancelBrowse := context.WithCancel(ctx)
	defer cancelBrowse()
	go func() {
		if err := Browse(bctx, sec, reg, func(n NodeInfo) {
			log.Printf("discovered %s %s at %s (os=%s, pi=%s, wbpp=%s)",
				n.Role, n.NodeID, n.Addr, n.OS, n.PIVersion, n.WBPPVersion)
		}); err != nil {
			log.Printf("server: browse stopped: %v", err)
		}
	}()

	// --list mode: just observe the cluster for a while, then print it.
	if sc.listFor > 0 {
		log.Printf("listing nodes for %s...", sc.listFor)
		select {
		case <-time.After(sc.listFor):
		case <-ctx.Done():
		}
		if sc.jsonOut {
			b, _ := json.MarshalIndent(map[string]any{"workers": filterWorkers(reg.Alive())}, "", "  ")
			// Prefer a file when asked: PixInsight's ExternalProcess does not
			// reliably capture child stdout, but PJSR File.readTextFile is robust.
			if sc.outFile != "" {
				if err := os.WriteFile(sc.outFile, b, 0o644); err != nil {
					log.Fatalf("write --out-file: %v", err)
				}
				log.Printf("wrote %d node(s) to %s", len(filterWorkers(reg.Alive())), sc.outFile)
			} else {
				fmt.Println(string(b))
			}
		} else {
			printNodes(reg.Alive())
		}
		return
	}

	// --job-file: one-shot DistributeJob from a file (the PJSR WBPPShim path).
	if sc.jobFile != "" {
		distributeFromFile(ctx, sec, self, reg, sc.jobFile, sc.outFile, sc.discoverTO)
		return
	}

	// --distribute: shard a directory of frames across all discovered workers.
	if sc.distribute != "" {
		runDistribute(ctx, sec, self, reg, sc)
		return
	}

	if sc.sendFile == "" {
		log.Printf("nothing to do (use --list, --send or --distribute)")
		return
	}
	worker := waitForWorker(ctx, reg, sc.discoverTO)
	if worker == nil {
		log.Fatalf("no worker discovered within %s", sc.discoverTO)
	}
	dispatch(ctx, sec, self, worker.Addr, sc.sendFile, sc.force)
}

// runDistribute is the CLI entry point: it gathers inputs, discovers workers and
// runs one distributed job, logging progress. The reusable engine lives in
// distributeJob (distribute.go) so the localhost control API shares it.
func runDistribute(ctx context.Context, sec *ClusterSecurity, self Capabilities, reg *Registry, sc serverConfig) {
	inputs, err := listFrames(sc.distribute)
	if err != nil {
		log.Fatalf("distribute: %v", err)
	}
	if len(inputs) == 0 {
		log.Fatalf("distribute: no files in %s", sc.distribute)
	}
	workers := waitForWorkers(ctx, reg, sc.discoverTO)
	if len(workers) == 0 {
		log.Fatalf("no workers discovered within %s", sc.discoverTO)
	}
	job := DistributeJob{
		Inputs: inputs, Reference: sc.reference, Op: sc.op,
		OutDir: sc.outDir, Postfix: sc.postfix, OutExt: sc.outExt, Force: sc.force,
	}
	rep, err := distributeJob(ctx, sec, self, workers, job, log.Printf)
	if err != nil {
		log.Fatalf("distribute: %v", err)
	}
	log.Printf("done: %d output(s) collected, %d failed, in %dms -> %s",
		rep.Collected, rep.Failed, rep.ElapsedMS, sc.outDir)
	if rep.Failed > 0 {
		os.Exit(1)
	}
}

// waitForWorker blocks until at least one worker is alive or the timeout fires.
func waitForWorker(ctx context.Context, reg *Registry, timeout time.Duration) *NodeInfo {
	deadline := time.Now().Add(timeout)
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		for _, n := range reg.Alive() {
			if n.Role == RoleWorker {
				return &n
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
			if time.Now().After(deadline) {
				return nil
			}
		}
	}
}

// waitForWorkers blocks until at least one worker is alive, then waits a short
// settle window so several workers announced close together are all included.
func waitForWorkers(ctx context.Context, reg *Registry, timeout time.Duration) []NodeInfo {
	if waitForWorker(ctx, reg, timeout) == nil {
		return nil
	}
	select {
	case <-time.After(BeaconInterval + 500*time.Millisecond): // let stragglers announce
	case <-ctx.Done():
	}
	var out []NodeInfo
	for _, n := range reg.Alive() {
		if n.Role == RoleWorker {
			out = append(out, n)
		}
	}
	return out
}

// listFrames returns the regular files in dir, sorted for deterministic sharding.
func listFrames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		files = append(files, filepath.Join(dir, e.Name()))
	}
	sort.Strings(files)
	return files, nil
}

// shard splits items round-robin into n buckets (round-robin keeps shard sizes
// balanced even when len(items) is not a multiple of n).
func shard[T any](items []T, n int) [][]T {
	if n < 1 {
		n = 1
	}
	out := make([][]T, n)
	for i, it := range items {
		out[i%n] = append(out[i%n], it)
	}
	return out
}

func filterWorkers(nodes []NodeInfo) []NodeInfo {
	out := []NodeInfo{}
	for _, n := range nodes {
		if n.Role == RoleWorker {
			out = append(out, n)
		}
	}
	return out
}

func baseOrEmpty(path string) string {
	if path == "" {
		return ""
	}
	return filepath.Base(path)
}

// dispatch performs the strict version handshake then uploads the file.
func dispatch(ctx context.Context, sec *ClusterSecurity, self Capabilities, addr, sendFile string, force bool) {
	caps, err := sec.FetchCapabilities(ctx, addr)
	if err != nil {
		log.Fatalf("handshake with %s failed: %v", addr, err)
	}
	if mismatch := versionMismatch(self, caps); mismatch != "" {
		if !force {
			log.Fatalf("version handshake refused: %s (use --force to override; results would be inconsistent)", mismatch)
		}
		log.Printf("WARNING: %s — proceeding because --force was set", mismatch)
	}
	log.Printf("handshake OK with %s (node=%s, pi=%s, wbpp=%s)", addr, caps.NodeID, caps.PIVersion, caps.WBPPVersion)

	st, err := os.Stat(sendFile)
	if err != nil {
		log.Fatalf("send file: %v", err)
	}
	log.Printf("uploading %q (%s) to %s ...", sendFile, humanBytes(st.Size()), addr)
	start := time.Now()
	res, err := sec.UploadFile(ctx, addr, sendFile)
	if err != nil {
		log.Fatalf("upload failed: %v", err)
	}
	elapsed := time.Since(start)
	log.Printf("OK: %d bytes, sha256=%s, server-elapsed=%dms, wall=%s, throughput=%s",
		res.Bytes, res.SHA256, res.ElapsedMS, elapsed.Round(time.Millisecond), throughput(res.Bytes, elapsed))
}

// versionMismatch enforces protocol + PixInsight + WBPP equality. Returns an
// empty string when the peer is compatible.
func versionMismatch(self, peer Capabilities) string {
	var problems []string
	if peer.Protocol != self.Protocol {
		problems = append(problems, fmt.Sprintf("protocol %d != %d", peer.Protocol, self.Protocol))
	}
	if peer.PIVersion != self.PIVersion {
		problems = append(problems, fmt.Sprintf("PixInsight %q != %q", peer.PIVersion, self.PIVersion))
	}
	if peer.WBPPVersion != self.WBPPVersion {
		problems = append(problems, fmt.Sprintf("WBPP %q != %q", peer.WBPPVersion, self.WBPPVersion))
	}
	return strings.Join(problems, "; ")
}

func printNodes(nodes []NodeInfo) {
	if len(nodes) == 0 {
		fmt.Println("no nodes discovered")
		return
	}
	fmt.Printf("%d node(s):\n", len(nodes))
	for _, n := range nodes {
		fmt.Printf("  - %-7s %-18s %s  os=%s pi=%s wbpp=%s\n",
			n.Role, n.NodeID, n.Addr, n.OS, n.PIVersion, n.WBPPVersion)
	}
}

// --- small helpers ---

func makeNodeID(port int) string {
	return fmt.Sprintf("%s-%d-%d", hostname(), os.Getpid(), port)
}

func hostname() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "node"
	}
	return h
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return strconv.FormatInt(n, 10) + " B"
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

func throughput(bytes int64, d time.Duration) string {
	if d <= 0 {
		return "n/a"
	}
	mbps := (float64(bytes) * 8 / 1e6) / d.Seconds()
	return fmt.Sprintf("%.1f Mbit/s", mbps)
}
