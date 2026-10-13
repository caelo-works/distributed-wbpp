# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting on this repository (**Security → Report a vulnerability**), which
notifies the maintainers privately. We aim to acknowledge reports within a few days.

## Scope and threat model

Distributed WBPP runs a small companion (**the sidecar**) that does the LAN networking
PixInsight scripts cannot do. The README section
[Network, programs and files](README.md#network-programs-and-files) lists every port,
program and file involved.

**Trust boundary: the cluster key.** A cluster is the set of PCs that hold the same key:
160 random bits, generated on the server from the operating system's secure random source,
pasted once on each client and stored in that PC's PixInsight settings. The key never
travels over the network and is never written to a log or a command line (the sidecar
receives it through a short-lived file in the user's folder, which it deletes at once).

What the key protects:

- **Transport.** Every TCP connection between PCs is TLS 1.3 with mutual authentication.
  Both ends present a certificate issued by a cluster authority derived from the key; a
  host without the key cannot complete the handshake, so it cannot read, alter or inject
  anything.
- **Requests and answers.** On top of TLS, every request is signed (HMAC-SHA256 over the
  method, path, query, body hash, timestamp and a single-use nonce) and every answer is
  signed in return. Unsigned, altered, replayed or stale requests are refused. Uploaded
  and downloaded files are checked against their signed SHA-256.
- **Discovery.** Multicast announcements are signed with the key and must come from one of
  the addresses they announce. Announcements from another key or an older protocol are
  ignored (and reported to the user, so a misconfigured PC can be fixed).
- **No code from the network.** A job carries the identifier of a WBPP process and its
  parameter values, as data. A client rebuilds the process only from a fixed list
  (`StarAlignment`, `ImageCalibration`, `LocalNormalization`, `ImageIntegration`,
  `DrizzleIntegration`; frame measurements use a locally built `SubframeSelector`), assigns
  only parameters that process defines, with the expected types, and only touches files
  under its own cache folder. Any other job is refused and logged. Both the sidecar and the
  PixInsight side check this.

Other hardening:

- Clients listen on their private LAN addresses only (and on `127.0.0.1`), never on every
  interface. Request sizes are capped.
- The local control channel between PixInsight and its sidecar listens on `127.0.0.1` only
  and refuses requests that do not come from the script (a required header and a strict
  `Host` check block browser-originated requests).

**Out of scope / assumptions.**

- Anyone who has the key is a member of the cluster: a member can send work to the
  clients (within the fixed process list) and read the frames it is sent. Share the key
  only with your own PCs; replace it with **New key** if it leaks.
- A local user or program on the same PC that can read your user folder or PixInsight
  settings can read the key.
- Traffic analysis is possible: an observer on the LAN sees that PCs exchange encrypted
  data and the multicast announcements (machine name, OS and versions).

If you find a way to make a node execute unintended code, join a cluster without the key,
exfiltrate data off the LAN, or corrupt results undetected, that is in scope: please report
it.

## Supported versions

Security fixes target the **latest released version**. The protection described above
(cluster key, encrypted and signed transfers, data-only jobs) exists from 1.9.0 on: keep
every PC of the cluster on the latest version. See [`CHANGELOG.md`](CHANGELOG.md).
