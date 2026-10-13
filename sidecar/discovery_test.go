package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func validBeacon() Beacon {
	return Beacon{
		Magic: BeaconMagic, Protocol: ProtocolVersion,
		NodeID: "w1", Role: RoleWorker, Host: "pc-b", HTTPPort: 5000, Addrs: []string{"10.0.0.5"},
		OS: "windows", PIVersion: "1.8.9-3", WBPPVersion: "2.7.6",
	}
}

var beaconSrc = net.ParseIP("10.0.0.5")

func TestClassifyBeaconAcceptsValid(t *testing.T) {
	sec := testSecurity(t)
	b, reason, ok := classifyBeacon(sec.signBeacon(validBeacon()), sec, beaconSrc)
	if !ok || reason != "" {
		t.Fatalf("valid beacon rejected (%q)", reason)
	}
	if b.NodeID != "w1" || b.HTTPPort != 5000 {
		t.Fatalf("decoded beacon wrong: %+v", b)
	}
}

// TestClustersDoNotSeeEachOther: two clusters with different keys on the same
// LAN never register each other's beacons.
func TestClustersDoNotSeeEachOther(t *testing.T) {
	a, b := testSecurity(t), testSecurity(t)
	if _, reason, ok := classifyBeacon(a.signBeacon(validBeacon()), b, beaconSrc); ok || reason != "different cluster key" {
		t.Fatalf("cluster B accepted cluster A's beacon (ok=%v, reason=%q)", ok, reason)
	}
	if _, _, ok := classifyBeacon(b.signBeacon(validBeacon()), a, beaconSrc); ok {
		t.Fatal("cluster A accepted cluster B's beacon")
	}
}

func TestClassifyBeaconFiltersForeign(t *testing.T) {
	sec := testSecurity(t)
	// unsigned current-protocol beacon
	js, _ := json.Marshal(validBeacon())
	if _, reason, ok := classifyBeacon(js, sec, beaconSrc); ok || reason != "different cluster key" {
		t.Fatalf("unsigned beacon: ok=%v reason=%q", ok, reason)
	}
	// tampered signed beacon (port changed after signing)
	d := sec.signBeacon(validBeacon())
	tampered := strings.Replace(string(d), `"http_port":5000`, `"http_port":5001`, 1)
	if _, _, ok := classifyBeacon([]byte(tampered), sec, beaconSrc); ok {
		t.Fatal("tampered beacon accepted")
	}
	// wrong magic: ignored silently
	wb := validBeacon()
	wb.Magic = "nope"
	if _, reason, ok := classifyBeacon(sec.signBeacon(wb), sec, beaconSrc); ok || reason != "" {
		t.Fatalf("wrong magic: ok=%v reason=%q", ok, reason)
	}
	// non-JSON garbage (e.g. unrelated multicast traffic) must not panic
	if _, reason, ok := classifyBeacon([]byte("\x00\x01not json\nzz"), sec, beaconSrc); ok || reason != "" {
		t.Fatal("garbage accepted")
	}
}

// TestOldProtocolBeaconIsIncompatible: a 1.8.x node (protocol 2, plain JSON with
// a token) is reported, not silently ignored, so the user knows to update it.
func TestOldProtocolBeaconIsIncompatible(t *testing.T) {
	sec := testSecurity(t)
	old := []byte(`{"magic":"wbpp-cluster","protocol":2,"token":"distributed-wbpp","node_id":"x","role":"worker","http_port":4000}`)
	if _, reason, ok := classifyBeacon(old, sec, beaconSrc); ok || reason != "older version (protocol 2)" {
		t.Fatalf("old beacon: ok=%v reason=%q", ok, reason)
	}
	nb := validBeacon()
	nb.Protocol = ProtocolVersion + 1
	if _, reason, ok := classifyBeacon(sec.signBeacon(nb), sec, beaconSrc); ok || !strings.HasPrefix(reason, "newer version") {
		t.Fatalf("newer beacon: ok=%v reason=%q", ok, reason)
	}
}

// TestBeaconSourceMustBeAdvertised: a valid beacon replayed from another host
// is ignored (it would otherwise redirect the cluster to that host).
func TestBeaconSourceMustBeAdvertised(t *testing.T) {
	sec := testSecurity(t)
	if _, reason, ok := classifyBeacon(sec.signBeacon(validBeacon()), sec, net.ParseIP("10.0.0.66")); ok || reason != "" {
		t.Fatalf("replayed beacon: ok=%v reason=%q", ok, reason)
	}
}

func TestRegistryIncompatible(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	reg := NewRegistry()
	reg.now = func() time.Time { return now }
	if !reg.NoteIncompatible("10.0.0.7", "different cluster key") {
		t.Fatal("first note should be new")
	}
	if reg.NoteIncompatible("10.0.0.7", "different cluster key") {
		t.Fatal("second note should not be new")
	}
	if got := reg.Incompatible(); len(got) != 1 || got[0].Addr != "10.0.0.7" {
		t.Fatalf("incompatible = %+v", got)
	}
	now = now.Add(NodeTTL + time.Second)
	if got := reg.Incompatible(); got == nil || len(got) != 0 {
		t.Fatalf("incompatible after TTL = %#v, want empty non-nil", got)
	}
}

// TestRegistryTTL drives the registry with a fake clock to assert that nodes
// expire after NodeTTL and that fresh beacons keep them alive.
func TestRegistryTTL(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	reg := NewRegistry()
	reg.now = func() time.Time { return now }

	n := NodeInfo{Beacon: validBeacon(), Addr: "10.0.0.5:5000"}
	if isNew := reg.Upsert(n); !isNew {
		t.Fatal("first Upsert should report a new node")
	}
	if isNew := reg.Upsert(n); isNew {
		t.Fatal("second Upsert of same node should not be new")
	}
	if got := len(reg.Alive()); got != 1 {
		t.Fatalf("alive = %d, want 1", got)
	}

	// advance just past the TTL without a refresh -> node should be pruned
	now = now.Add(NodeTTL + time.Second)
	if got := len(reg.Alive()); got != 0 {
		t.Fatalf("alive after TTL = %d, want 0", got)
	}

	// a fresh beacon revives it
	reg.Upsert(n)
	if got := len(reg.Alive()); got != 1 {
		t.Fatalf("alive after refresh = %d, want 1", got)
	}
}
