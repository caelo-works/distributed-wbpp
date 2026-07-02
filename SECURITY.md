# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (**Security → Report a vulnerability**), which
notifies the maintainers privately. We aim to acknowledge reports within a few days.

## Scope & threat model

Distributed WBPP runs a small companion (**the sidecar**) that does LAN networking:

- **Discovery** — UDP multicast beacons on the local network.
- **Transfer** — HTTP file transfer between nodes, with SHA-256 integrity checks.
- **Cluster membership** — nodes join a cluster by a shared **token**; the token gates
  cross-talk between overlapping clusters, it is **not** a strong authentication or
  encryption boundary.

The sidecar is designed for a **trusted local network** (your own machines). It is not
hardened for hostile/multi-tenant networks: traffic is unencrypted on the LAN and any
host that knows the token can join. Run it on networks you control.

If you find a way to make a node execute unintended code, exfiltrate data off the LAN,
or corrupt results undetected (past the SHA-256/handshake guarantees), that is in scope —
please report it.

## Supported versions

Security fixes target the **latest released version**. See [`CHANGELOG.md`](CHANGELOG.md).
