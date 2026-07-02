package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/net/ipv4"
)

// Registry holds the set of currently-alive peers, keyed by NodeID, and expires
// entries that have not been re-announced within NodeTTL. It is safe for
// concurrent use.
type Registry struct {
	mu    sync.Mutex
	nodes map[string]NodeInfo
	now   func() time.Time // injectable clock for tests
}

func NewRegistry() *Registry {
	return &Registry{nodes: map[string]NodeInfo{}, now: time.Now}
}

// Upsert records or refreshes a peer. Returns true if this is a newly-seen node.
func (r *Registry) Upsert(n NodeInfo) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, existed := r.nodes[n.NodeID]
	n.LastSeen = r.now()
	r.nodes[n.NodeID] = n
	return !existed
}

// Alive returns the peers seen within NodeTTL, pruning the rest.
func (r *Registry) Alive() []NodeInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := r.now().Add(-NodeTTL)
	out := make([]NodeInfo, 0, len(r.nodes))
	for id, n := range r.nodes {
		if n.LastSeen.Before(cutoff) {
			delete(r.nodes, id)
			continue
		}
		out = append(out, n)
	}
	return out
}

// parseBeacon validates a raw datagram against magic/protocol/token and returns
// the decoded beacon. ok is false for anything that is not a beacon meant for
// this cluster, so callers can silently ignore foreign multicast traffic.
func parseBeacon(data []byte, token string) (Beacon, bool) {
	var b Beacon
	if err := json.Unmarshal(data, &b); err != nil {
		return Beacon{}, false
	}
	if b.Magic != BeaconMagic || b.Protocol != ProtocolVersion || b.Token != token {
		return Beacon{}, false
	}
	return b, true
}

// multicastInterfaces returns the up, multicast-capable interfaces that have an
// IPv4 address. On a multi-homed host (very common on Windows: real LAN + WSL
// vEthernet + VPNs) we must advertise and listen on ALL of them, otherwise the
// sender and receiver can pick different interfaces and never meet.
func multicastInterfaces() []net.Interface {
	all, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var out []net.Interface
	for _, ifi := range all {
		if ifi.Flags&net.FlagUp == 0 || ifi.Flags&net.FlagMulticast == 0 {
			continue
		}
		addrs, err := ifi.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				out = append(out, ifi)
				break
			}
		}
	}
	return out
}

func ifaceIPv4(ifi net.Interface) net.IP {
	addrs, _ := ifi.Addrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok {
			if ip4 := ipn.IP.To4(); ip4 != nil {
				return ip4
			}
		}
	}
	return nil
}

// Advertise sends the beacon to the cluster multicast group out of every
// multicast-capable interface, every BeaconInterval, until ctx is done.
//
// Uses x/net/ipv4 so we can explicitly enable multicast loopback — without it,
// two processes on the SAME Windows host never see each other's beacons (the OS
// default for IP_MULTICAST_LOOP is unreliable across the Hyper-V/WSL switches).
func Advertise(ctx context.Context, b Beacon) error {
	group, err := net.ResolveUDPAddr("udp4", MulticastAddr)
	if err != nil {
		return err
	}
	c, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		return err
	}
	defer c.Close()
	p := ipv4.NewPacketConn(c)
	_ = p.SetMulticastLoopback(true) // same-host delivery
	_ = p.SetMulticastTTL(2)         // local subnet (a hop of slack)

	ifaces := multicastInterfaces()
	var names []string
	for _, ifi := range ifaces {
		names = append(names, ifi.Name+"("+ipStr(ifaceIPv4(ifi))+")")
	}
	if len(names) == 0 {
		names = []string{"default"}
	}
	log.Printf("discovery: advertising on %d interface(s): %s", len(names), strings.Join(names, ", "))

	payload, _ := json.Marshal(b)
	send := func() {
		if len(ifaces) == 0 {
			_, _ = p.WriteTo(payload, nil, group)
			return
		}
		for i := range ifaces {
			if err := p.SetMulticastInterface(&ifaces[i]); err != nil {
				continue
			}
			_, _ = p.WriteTo(payload, nil, group)
		}
	}
	send() // announce immediately
	ticker := time.NewTicker(BeaconInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			send()
		}
	}
}

// Browse joins the cluster group on every multicast-capable interface using a
// SINGLE socket (avoiding the Windows multi-socket-same-port ambiguity) and
// keeps reg up to date until ctx is done.
func Browse(ctx context.Context, token string, reg *Registry, onNew func(NodeInfo)) error {
	group, err := net.ResolveUDPAddr("udp4", MulticastAddr)
	if err != nil {
		return err
	}
	c, err := net.ListenPacket("udp4", net.JoinHostPort("0.0.0.0", strconv.Itoa(group.Port)))
	if err != nil {
		return err
	}
	p := ipv4.NewPacketConn(c)
	_ = p.SetMulticastLoopback(true)

	ifaces := multicastInterfaces()
	var names []string
	for i := range ifaces {
		if err := p.JoinGroup(&ifaces[i], &net.UDPAddr{IP: group.IP}); err == nil {
			names = append(names, ifaces[i].Name)
		}
	}
	if len(names) == 0 {
		if err := p.JoinGroup(nil, &net.UDPAddr{IP: group.IP}); err != nil {
			c.Close()
			return err
		}
		names = []string{"default"}
	}
	log.Printf("discovery: listening on %d interface(s): %s", len(names), strings.Join(names, ", "))

	go func() {
		<-ctx.Done()
		c.Close() // unblock ReadFrom
	}()

	buf := make([]byte, 64*1024)
	for {
		n, _, src, err := p.ReadFrom(buf)
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return err
			}
		}
		ua, _ := src.(*net.UDPAddr)
		if ua == nil {
			continue
		}
		b, ok := parseBeacon(buf[:n], token)
		if !ok {
			continue
		}
		info := NodeInfo{Beacon: b, Addr: net.JoinHostPort(ua.IP.String(), strconv.Itoa(b.HTTPPort))}
		if reg.Upsert(info) && onNew != nil {
			onNew(info)
		}
	}
}

func ipStr(ip net.IP) string {
	if ip == nil {
		return "?"
	}
	return ip.String()
}
