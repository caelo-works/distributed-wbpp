# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-07-04

### Added
- **Linux validated end-to-end** (Ubuntu 24.04, PixInsight 1.9.4 / WBPP 3.0.1): a real
  mixed cluster — Windows server + Linux worker — ran the full SHO pipeline with every
  distributed operation (per-frame ops, calibration/light/drizzle integrations, LN
  reference) collected from the Linux node; WBPP logs clean on both sides, worker
  finished 16 jobs / 44 frames with 0 errors. The bundled `wbpp-sidecar-linux-amd64`
  (static ELF, no runtime dependency) is now runtime-verified. macOS remains the only
  untested platform.

### Changed
- README and `docs/COMPATIBILITY.md` now document the **mixed-OS caveat**: results are
  bit-identical when all nodes run the same OS, and numerically equivalent across OSes
  (PixInsight's per-platform math libraries can flip pixels sitting exactly on a
  rejection threshold; measured mean difference < 1e-8, worst local difference ~1.4e-3
  on marginal hot pixels). An integration leased to a same-OS worker in the very same
  run reproduced the local master bit-identically, isolating the divergence to platform
  math rather than the distribution mechanism.

## [1.4.0] - 2026-07-04

### Added
- **The drizzle integrations are now distributed** (one whole-job per filter group),
  leased alongside the light integrations. The captured `DrizzleIntegration` travels
  with each frame's `.xdrz` drizzle-data file, its calibrated source image and (when
  local normalization is enabled) its `.xnml`; the worker returns the drizzle master
  bundle (integration + weights) and the server finalizes it exactly like WBPP's own
  `doDrizzleIntegration` (naming `_drizzle_<scale>x`, master keywords, signature,
  `setMasterFileName(DRIZZLE)`), so the local autocrop crops it natively afterwards.

### Fixed
- A `.xdrz` produced during a **distributed registration** embeds the absolute source
  path on the worker that generated it. Drizzle integration reads those paths verbatim
  (it does not remap them), so the server's own drizzle — and any worker's — could
  silently drop the frames whose `.xdrz` pointed elsewhere. Both sides now rewrite the
  embedded `<SourceImage>`/`<AlignmentTargetImage>` paths to locally resolvable copies
  before integrating (server → its canonical calibrated/registered tree; worker → its
  data dir), so every frame is integrated on every machine.

### Validation
- Real 2-node LAN run: all 21 masters — the 3 `_drizzle_2x` and their 3
  `_drizzle_2x_autocrop` included — pixel-identical to a local-only baseline (max
  |difference| = 0), and the WBPP log reports `DrizzleIntegration: 10 succeeded,
  0 failed` on every group. Pipeline 548.3s vs 759.3s local (drizzle enabled).

## [1.3.0] - 2026-07-04

### Added
- **The LN reference generation is now distributed** (one whole-job per filter group).
  The inner local normalization of the best frames still runs natively on the server
  (its bookkeeping untouched — the capture decoy lets the first process through), and
  the reference ImageIntegration that follows is captured and leased to a worker,
  reusing the light-integration worker path (.xnml companions, no rejection maps).
  The finalized LN_Reference master is wired back through the group's in-memory
  reference so the local-normalization operations consume it natively. The interactive
  reference-selection mode is untouched (different operation name).

### Validation
- Real 2-node LAN run: 15/15 masters (LN_Reference included) pixel-identical to the
  local baseline (max |difference| = 0).

## [1.2.0] - 2026-07-04

### Added
- **The final LIGHT integrations are now distributed** (one whole-job per filter group),
  attacking the pipeline's largest remaining serial tail. The captured ImageIntegration
  travels with its per-frame drizzle/local-normalization companions; the worker returns
  the integration bundle (with embedded rejection maps) plus the updated `.xdrz` files,
  and the server finalizes the master exactly like WBPP's own `doIntegrate` (naming,
  keywords, signature, in-memory group wiring) so autocrop and the astrometric solution
  run natively on it.
- Autocrop and the astrometric solution intentionally stay **local**: autocrop is a
  single global operation that crops all filters to the intersection of their crop
  rectangles, and plate-solving depends on a per-node Gaia XPSD database / network
  catalog.

### Validation
- Real 2-node LAN run: all 15 masters (including `_autocrop`) pixel-identical to a
  local-only baseline (max |difference| = 0); pipeline 369.3s vs 632.3s local (1.7x
  with one helper).

## [1.1.0] - 2026-07-03

### Added
- **Distribution restored on WBPP 3.0.x / PixInsight 1.9.4.** The shim was ported to the
  v8-era engine: process capture now hooks `engine.processContainer` (native prototype
  patching is ignored under v8), measurements go through `engine.subframeAnalyzer`,
  enums/steps use the 3.0 layout (`ImageType.Light`, `BPP.FrameProcessingStep`), and the
  worker builds process target rows with `WBPPUtils.enableTargetFrames` so row shapes
  track the core processes.
- Robustness: partial cluster shortfalls are now reprocessed locally (measurements and
  per-frame operations) — a failed or partial worker result can no longer lose frames.
- Groups using WBPP 3.0 Fast Integration run locally (guard) until that flow is modeled.

### Changed
- `SidecarBridge` gained `killStale` and `controlPort` options (same-host server+worker
  co-hosting for the loopback bench).

## [1.0.1] - 2026-07-03

### Fixed
- **Loads again on PixInsight 1.9.4 / WBPP 3.0.1** (WBPP 3.0 was a breaking restructure):
  single `BPP-Main.js` include (no more `BPP-defines.jsh`), identity read from
  `BPP.Version.*`, `#engine v8`, and v8 runtime constant objects (`StdButton.Ok`,
  `StdIcon.Error`, `FrameStyle.Box`) instead of the legacy `pjsr/*.jsh` headers, which no
  longer load under v8.

### Changed
- **Distribution is temporarily inactive on WBPP 3.0.x**: the shim's engine anchors are
  not yet re-verified for 3.0, so runs fall back to the normal local WBPP (by design —
  see `docs/COMPATIBILITY.md`). Clustering returns once the 3.0 port is validated.
- The update channel now gates this plugin to PixInsight ≥ 1.9.4 (`piVersionRange`);
  PixInsight ≤ 1.9.3 / WBPP 2.9.x stays on plugin v1.0.0. A runtime
  `ensureMinimumVersion( 1, 9, 4 )` guards direct installs.
- README states the real platform-validation status: validated on **Windows**; the
  **macOS** and **Linux** binaries are cross-compiled and bundled but not yet
  runtime-tested.

### Added
- Best-effort macOS quarantine removal (`xattr -dr com.apple.quarantine`) for the
  extracted sidecar binary, so Gatekeeper is less likely to block the unsigned companion.
  Untested on macOS — the proper fix remains code-signing + notarization.
- Optional, **disabled-by-default** script code-signing step in `build-update-package.sh`
  (`XSSK_PATH` + `PI_EXE`): produces `DistributedWBPP.xsgn` next to the entry script,
  entitlements `[]`. Password is prompted (`read -s`) and never persisted. Stays off until
  CaeloWorks' CPD identity is distributed by Pleiades. `*.xssk` is now git-ignored.

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

[Unreleased]: https://github.com/caelo-works/distributed-wbpp/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/caelo-works/distributed-wbpp/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/caelo-works/distributed-wbpp/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/caelo-works/distributed-wbpp/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/caelo-works/distributed-wbpp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/caelo-works/distributed-wbpp/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/caelo-works/distributed-wbpp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/caelo-works/distributed-wbpp/releases/tag/v1.0.0
