# Contributing to Distributed WBPP

Thanks for your interest! This project distributes PixInsight's WBPP across a LAN using
a Go **sidecar** (networking) and a PJSR **shim** (a minimal monkey-patch of the WBPP
engine). Please read this before opening a PR.

## Getting set up

```bash
# Go sidecar — the networking/orchestration companion
cd sidecar
go test ./...          # unit tests
go vet ./...
gofmt -l .             # must be empty

# Cross-compile the sidecar for every OS -> bin/
bash scripts/build-sidecar.sh
```

The PJSR side (`pjsr/`) runs inside PixInsight; there is no headless test harness in
this repo (an end-to-end run needs a licensed PixInsight GUI and, for the cluster,
physical machines). See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Ground rules

- **The shim is fragile by nature.** It patches WBPP's internals, so read
  [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md) before touching `pjsr/lib/WBPPShim.js`.
  Never remove the safe **local fallback** — an untested/incompatible state must run
  normal local WBPP, never a silently wrong result.
- **Determinism is the contract.** A distributed run must match a local run
  bit-identically (or within the documented tolerance). If your change can affect
  output, validate both ways on a real dataset and say so in the PR.
- **Keep the patch surface minimal.** Prefer capturing WBPP's configured process over
  re-implementing its logic.

## Pull requests

1. Branch off `main`.
2. Keep the sidecar `gofmt`-clean and tests green (`go test ./...`, `go vet ./...`).
3. CI (Go test/vet/gofmt + a reproducible-package check) must pass.
4. Describe **what** changed and **how you validated** it (especially for shim or
   distribution-correctness changes).

## Releases

Releases are tag-driven: push a semver tag `vX.Y.Z` and the [Release
workflow](.github/workflows/release.yml) cross-compiles the sidecar, builds the
distribution artifact, and publishes it as release assets. Update
[`CHANGELOG.md`](CHANGELOG.md) in the same PR that warrants the bump.

[`docs/support-kb.md`](docs/support-kb.md) is the knowledge base read by the **public
support agent** on the CaeloWorks Discord — it answers members in our place, and it is
forbidden to invent, so anything absent from that file is an answer we don't give. It is
reviewed like code and must stay **100 % accurate for the shipped version**.

- Every release must leave it exact: covered version, requirements and compatibility, the
  distributed-vs-local step lists, UI and log strings, install paths, known limitations.
- **When a bug is fixed, its entry in "Known bugs and limitations" moves in the same PR** —
  otherwise the agent keeps announcing a bug that no longer exists.
- Constraints of the target system: it is chunked one article per `##`, so **no `##`
  section may exceed ~3500 characters without `###` subsections**, section titles must
  contain the words a user would actually type, and each section must stand alone (no
  "see above"). Nothing internal (architecture, release process, keys, infrastructure)
  belongs in it — the content can be quoted verbatim to any Discord member.

## Reporting bugs / requesting features

Use the issue templates. For anything security-related, follow
[`SECURITY.md`](SECURITY.md) instead of opening a public issue.
