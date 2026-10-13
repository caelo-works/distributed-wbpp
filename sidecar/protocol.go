package main

import "time"

// Protocol-level constants shared by discovery, transport and the localhost API.
const (
	// ProtocolVersion is bumped on any wire-incompatible change. The server and
	// workers must agree on it (checked during the HTTP handshake).
	ProtocolVersion = 3 // v3: mutual TLS, signed requests and beacons, data-only process manifests

	// Discovery beacon multicast group + port. 239.255.0.0/16 is the
	// administratively-scoped (site-local) IPv4 multicast range, appropriate
	// for a LAN-only cluster.
	MulticastAddr = "239.255.42.99:42099"

	// BeaconMagic guards against parsing unrelated multicast traffic.
	BeaconMagic = "wbpp-cluster"

	// BeaconInterval is how often a worker re-announces itself.
	BeaconInterval = 2 * time.Second

	// NodeTTL is how long a discovered node stays "alive" without a fresh
	// beacon. Generous (15 beacon intervals) to tolerate Wi-Fi multicast loss,
	// where beacons drop for seconds at a time.
	NodeTTL = 30 * time.Second
)

// Role identifies what a node does in the cluster.
type Role string

const (
	RoleServer Role = "server"
	RoleWorker Role = "worker"
)

// Beacon is the small JSON payload multicast periodically by every node so
// peers can discover it without any shared folder or manual IP configuration.
// On the wire it is followed by a newline and its HMAC under the cluster's
// beacon key, so nodes of another cluster (another key) never see each other.
type Beacon struct {
	Magic       string   `json:"magic"`
	Protocol    int      `json:"protocol"`
	NodeID      string   `json:"node_id"`
	Role        Role     `json:"role"`
	Host        string   `json:"host"`      // advertised hostname (informational)
	HTTPPort    int      `json:"http_port"` // where this node's transport server listens
	Addrs       []string `json:"addrs"`     // LAN IPv4s the node listens on (a beacon must come from one)
	OS          string   `json:"os"`
	PIVersion   string   `json:"pi_version"`   // PixInsight version (handshake identity)
	WBPPVersion string   `json:"wbpp_version"` // WBPP version (handshake identity)
}

// NodeInfo is a discovered peer plus bookkeeping used to expire stale nodes.
type NodeInfo struct {
	Beacon
	Addr     string    `json:"addr"`      // ip:port reachable for HTTP (from packet source + HTTPPort)
	LastSeen time.Time `json:"last_seen"` // updated on every received beacon
}

// IncompatibleNode is a node seen on the LAN that cannot join this cluster: an
// older/newer protocol, or a different cluster key. Reported so the user can act.
type IncompatibleNode struct {
	Addr     string    `json:"addr"`
	Reason   string    `json:"reason"`
	LastSeen time.Time `json:"-"`
}

// Capabilities is returned by GET /health and is the basis of the strict
// version handshake: the server refuses to dispatch work to a worker whose
// identity does not match its own.
type Capabilities struct {
	Magic       string `json:"magic"`
	Protocol    int    `json:"protocol"`
	NodeID      string `json:"node_id"`
	Role        Role   `json:"role"`
	OS          string `json:"os"`
	PIVersion   string `json:"pi_version"`
	WBPPVersion string `json:"wbpp_version"`
}

// UploadResult is the JSON body returned by the worker after receiving a file,
// echoing what it actually stored so the sender can verify integrity.
type UploadResult struct {
	OK        bool   `json:"ok"`
	Name      string `json:"name"`
	Bytes     int64  `json:"bytes"`
	SHA256    string `json:"sha256"`
	ElapsedMS int64  `json:"elapsed_ms"`
	Error     string `json:"error,omitempty"`
}
