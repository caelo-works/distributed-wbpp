# STATUS — Distributed-WBPP

_Last updated: 2026-07-01. Validated target: PixInsight 1.9.3 / WBPP 2.9.1
(Windows, 2-PC cluster)._

## TL;DR

**It works end to end.** A full WBPP run (SHO, calib + lights) distributes
**all the heavy steps** across the cluster and produces **correct SHO masters**.
Correctness is proven: a master integrated on a worker is **bit-identical** to
a local master (mean/median/stdDev, diff 0), and the whole pipeline outputs the
correct H/O/S `masterLight` files from the distributed masters.

## What is distributed (validated)

### Per-frame model (intra-group split, adaptive)
Each group is cut server ∥ cluster; each machine's share is computed from the
**actual measured cost** (compute + transfer, moving average) → auto-balancing
that adjusts from one group to the next.

| Step | Captured process | Output |
|---|---|---|
| **Calibration** (lights) | `ImageCalibration` | `_c.xisf` |
| **Measurements** | `SubframeSelector` (MeasureSubframes) | `.ssm.json` (metrics → `setDescriptor`) |
| **Registration** | `StarAlignment` | `_r.xisf` (+ `.xdrz`) |
| **Local Normalization** | `LocalNormalization` | `.xnml` |

Mechanism: we intercept `executeGlobal` (sentinel) to **capture** the instance
configured by WBPP, distribute it via the sidecar, and replay the native
post-processing (`processingSucceeded` / `addLocalNormalizationFile` / `setDescriptor`). The
calibration of **flats/darks** is **not** distributed (trivial compute, heavy
transfer → "lights only" guard).

### Whole-job model (whole-job assignment)
An integration is **indivisible** → it goes **whole** to a worker.

| Step | Detail |
|---|---|
| **Calib master integration** — bias / dark / darkflat | wave A, consecutive ops |
| **Flat master integration** — H / O / S | wave B, interleaved Cal/Int → we take over at the 1st flat, run the flat calibrations locally, then batch the integrations |

The server integrates its share locally **while** the cluster handles the rest.
Measured results (30 lights, 1 worker): `calib integration 1 local ∥ 2 cluster ≈ 49 s`
(vs ~79 s), `flat integration 2 local ∥ 1 cluster ≈ 67 s`. Drops further with a 3rd PC.

### Stays **local** (by choice)
- **Final light integration** (reduction of the largest frames → transfer-bound).
- **Astrometric solution** (~fixed cost, ~30 s of potential gain, but deep coupling
  to `ImageSolver` + catalogs + risk of a blocking dialog → not worthwhile).
- Generation of the flat masters is **itself** distributed; their **calibration** stays local.

## Architecture

- **Go sidecar** (static binary, no runtime): LAN discovery (UDP multicast
  beacon), HTTP + SHA-256 transfer, localhost control plane, **whole-job
  primitive** (lease of a free worker + per-worker serialization → concurrent jobs
  queued, no deadlock). Strict version handshake.
- **PJSR ↔ sidecar bridge** (`SidecarBridge.js`): launches the sidecar via `ExternalProcess`,
  communicates via **files** (`--in-file`/`--out-file`; PJSR does not capture stdout).
  `distributeAsync`/`distributeWait` to launch a cluster job **without blocking** (the
  server works in parallel).
- **Shim** (`WBPPShim.js`): monkey-patch of `engine.operationQueue.addOperation` +
  override of `engine.computeDescriptors`; anchored on WBPP 2.9.1's operation names + process
  fields (`WBPP_SHIM_COMPAT = {"2.9.1":true}`). **Safe local
  fallback** if version unknown / no worker / any error.
- **Visibility**: server dashboard (non-modal window) + report in the **last
  column of WBPP's Execution Monitor** (`operation.statusMessage`, e.g.
  `10 registration [cluster: 5 local + 5 client]`).

Design details: `docs/ARCHITECTURE.md`. WBPP mapping: `docs/RESEARCH-WBPP.md`.

## Current builds (Y: deployment)
- Worker script: **3315617** (measurements + integration modes).
- Sidecar exe: **25485fd** (whole-job).
- A build number is injected into the window titles (at deployment) to
  confirm that the running copy really is the fresh one (PixInsight can cache).
- Deployment: `scripts/deploy.sh <target>` injects the build + the WBPP path and copies
  `pjsr/` + the exe to the launch folder (a shared drive works, or locally
  on each machine). **The exe is locked while a worker is running** → close the client
  to update it; a mere shim (PJSR) change only needs a relaunch
  of the client, or nothing if it is server-side only.

## Known limitations
- **Surviving WBPP updates**: minimal patch surface + per-version compat table
  + local fallback. A major WBPP overhaul may require a bump.
- **Drizzle**: the registration `.xdrz` files are brought back and reattached; the final
  *drizzle* integration stays local (like normal integration).
- **Speedup ceiling** set by the remaining local steps (final integration +
  astrometry), which do not scale with the number of raw frames — so the benefit grows
  with dataset size (the per-frame part then dominates).
