package main

import (
	"encoding/json"
	"testing"
	"time"
)

func validBeacon(token string) Beacon {
	return Beacon{
		Magic: BeaconMagic, Protocol: ProtocolVersion, Token: token,
		NodeID: "w1", Role: RoleWorker, Host: "pc-b", HTTPPort: 5000,
		OS: "windows", PIVersion: "1.8.9-3", WBPPVersion: "2.7.6",
	}
}

func TestParseBeaconAcceptsValid(t *testing.T) {
	data, _ := json.Marshal(validBeacon("secret"))
	b, ok := parseBeacon(data, "secret")
	if !ok {
		t.Fatal("valid beacon rejected")
	}
	if b.NodeID != "w1" || b.HTTPPort != 5000 {
		t.Fatalf("decoded beacon wrong: %+v", b)
	}
}

func TestParseBeaconFiltersForeign(t *testing.T) {
	cases := map[string]func(*Beacon){
		"wrong token":    func(b *Beacon) { b.Token = "other" },
		"wrong magic":    func(b *Beacon) { b.Magic = "nope" },
		"wrong protocol": func(b *Beacon) { b.Protocol = 999 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			b := validBeacon("secret")
			mutate(&b)
			data, _ := json.Marshal(b)
			if _, ok := parseBeacon(data, "secret"); ok {
				t.Fatalf("%s should be filtered out", name)
			}
		})
	}
	// non-JSON garbage (e.g. unrelated multicast traffic) must not panic
	if _, ok := parseBeacon([]byte("\x00\x01not json"), "secret"); ok {
		t.Fatal("garbage accepted")
	}
}

// TestRegistryTTL drives the registry with a fake clock to assert that nodes
// expire after NodeTTL and that fresh beacons keep them alive.
func TestRegistryTTL(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	reg := NewRegistry()
	reg.now = func() time.Time { return now }

	n := NodeInfo{Beacon: validBeacon("secret"), Addr: "10.0.0.5:5000"}
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
