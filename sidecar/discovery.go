package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sort"
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
	mu           sync.Mutex
	nodes        map[string]NodeInfo
	incompatible map[string]IncompatibleNode // keyed by addr + reason
	now          func() time.Time            // injectable clock for tests
}

func NewRegistry() *Registry {
	return &Registry{nodes: map[string]NodeInfo{}, incompatible: map[string]IncompatibleNode{}, now: time.Now}
}

// NoteIncompatible records a node that cannot join this cluster. Returns true
// the first time this (addr, reason) is seen, so callers log it only once.
func (r *Registry) NoteIncompatible(addr, reason string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	k := addr + "|" + reason
	_, existed := r.incompatible[k]
	r.incompatible[k] = IncompatibleNode{Addr: addr, Reason: reason, LastSeen: r.now()}
	return !existed
}

// Incompatible returns the incompatible nodes seen within NodeTTL (never nil).
func (r *Registry) Incompatible() []IncompatibleNode {
	r.mu.Lock()
	defer r.mu.Unlock()
	cutoff := r.now().Add(-NodeTTL)
	out := []IncompatibleNode{}
	for k, n := range r.incompatible {
		if n.LastSeen.Before(cutoff) {
			delete(r.incompatible, k)
			continue
		}
		out = append(out, n)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Addr+out[i].Reason < out[j].Addr+out[j].Reason })
	return out
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

// classifyBeacon checks a raw datagram received from src. It returns ok for a
// beacon of this cluster (valid HMAC, magic, protocol, and a source address the
// node advertises). For a Distributed WBPP node that cannot join (another
// protocol version, or another cluster key) it returns a non-empty reason so
// the user can be told; anything else (unrelated multicast traffic, a beacon
// replayed from another address) is silently ignored.
func classifyBeacon(data []byte, sec *ClusterSecurity, src net.IP) (b Beacon, reason string, ok bool) {
	js, mac := data, []byte(nil)
	if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
		js, mac = data[:i], data[i+1:]
	}
	if err := json.Unmarshal(js, &b); err != nil || b.Magic != BeaconMagic {
		return Beacon{}, "", false
	}
	switch {
	case b.Protocol < ProtocolVersion:
		return Beacon{}, fmt.Sprintf("older version (protocol %d)", b.Protocol), false
	case b.Protocol > ProtocolVersion:
		return Beacon{}, fmt.Sprintf("newer version (protocol %d)", b.Protocol), false
	}
	if mac == nil || !sec.beaconMACValid(js, mac) {
		return Beacon{}, "different cluster key", false
	}
	if len(b.Addrs) > 0 && src != nil {
		from := false
		for _, a := range b.Addrs {
			if ip := net.ParseIP(a); ip != nil && ip.Equal(src) {
				from = true
				break
			}
		}
		if !from {
			return Beacon{}, "", false
		}
	}
	return b, "", true
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
func Advertise(ctx context.Context, sec *ClusterSecurity, b Beacon) error {
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

	payload := sec.signBeacon(b)
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
func Browse(ctx context.Context, sec *ClusterSecurity, reg *Registry, onNew func(NodeInfo)) error {
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
		b, reason, ok := classifyBeacon(buf[:n], sec, ua.IP)
		if !ok {
			if reason != "" && reg.NoteIncompatible(ua.IP.String(), reason) {
				log.Printf("discovery: ignoring Distributed WBPP node at %s: %s", ua.IP, reason)
			}
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
