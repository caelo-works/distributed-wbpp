# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-02

### Added

- First public release: distribute PixInsight's Weighted Batch Preprocessing (WBPP)
  across multiple PixInsight instances on a local network, driven from the native WBPP
  dialog.
- **Per-frame distribution** of calibration, registration, local normalization and
  measurements, with an adaptive server ∥ cluster split that self-tunes to each machine's
  measured throughput.
- **Whole-job distribution** of calibration-master integrations (bias/dark/flat), leased
  to free workers while the server integrates its own share in parallel.
- **Sidecar** companion (Go, one static binary per OS) for LAN discovery (UDP multicast)
  and frame transfer (HTTP + SHA-256); embedded in the package, selected per OS/arch at
  runtime.
- **Safe local fallback**: a strict PixInsight + WBPP version handshake; on any mismatch,
  missing helper or error, the run falls back to unmodified local WBPP.
- Distribution through the shared CaeloWorks PixInsight update repository, via a
  reproducible release artifact (`build-update-package.sh`).
- Verified on PixInsight 1.9.3 / WBPP 2.9.1 (see [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)).

[Unreleased]: https://github.com/caelo-works/distributed-wbpp/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/caelo-works/distributed-wbpp/releases/tag/v1.0.0
