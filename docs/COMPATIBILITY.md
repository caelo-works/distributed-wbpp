# WBPP compatibility policy

Distributed WBPP does **not** fork or reimplement WBPP. It loads the WBPP engine
installed on the machine and, at runtime, **monkey-patches a minimal set of its
methods** (see [`pjsr/lib/WBPPShim.js`](../pjsr/lib/WBPPShim.js)) to graft cluster
distribution onto the native pipeline. That coupling to WBPP's internals is the
project's main fragility, and this document is the contract for managing it.

## The safety guarantee

**A version we haven't verified never produces a wrong result — it produces a normal
local WBPP run.** The shim only activates when the detected WBPP version is present in
its compatibility table; otherwise (unknown version, missing helpers, or *any* error
mid-run) it logs a warning and falls back to unmodified local WBPP. There is no
"best-effort on an untested version" path, by design: a silently wrong master is worse
than no speedup.

## What the shim anchors on

The patch is deliberately small and pinned to identifiers that are stable across WBPP
2.9.x point releases:

- **Operation names** — `Calibration`, `Registration`, `Local Normalization`,
  `Measurements`, and the calibration-master integrations.
- **Process field names** — e.g. `ImageCalibration.targetFrames`,
  `StarAlignment.targets` / `referenceImage`, `LocalNormalization.targetItems`.
- **Post-processing hooks** — `frame.processingSucceeded(step, out)` /
  `processingFailed()`.

It captures the fully-configured process instance WBPP builds (rather than rebuilding
WBPP's configuration logic), so the surface that can break is limited to those names.

## Supported versions

Support is declared in one place — `WBPP_SHIM_COMPAT` in
[`pjsr/lib/WBPPShim.js`](../pjsr/lib/WBPPShim.js):

```js
var WBPP_SHIM_COMPAT = { "2.9.1": true };
```

| PixInsight | WBPP | Plugin | Status |
|---|---|---|---|
| 1.9.4 | 3.0.1 | ≥ 1.0.1 | **Loads & runs native WBPP** (v8 engine, `BPP.Version.*` layout). Distribution **inactive** — the 3.0.x engine anchors are not yet re-verified, so the shim falls back to a normal local run. Port in progress. |
| 1.9.3 | 2.9.1 | 1.0.0 | Verified — full SHO run, distributed masters validated bit-identically vs local. Plugin ≥ 1.0.1 does **not** load on this generation (WBPP 3.x include layout); stay on v1.0.0. |

> **WBPP 3.0 was a breaking restructure** (PixInsight 1.9.4): `BPP-defines.jsh` removed,
> identity moved to `BPP.Version.*`, scripts run under `#engine v8`, and the legacy
> `pjsr/*.jsh` headers no longer load (their constants are v8 runtime globals such as
> `StdButton.Ok`). Plugin 1.0.1 adopts that layout; the update channel gates it to
> PixInsight ≥ 1.9.4 via `piVersionRange`.

Every node in a cluster must run the **same** PixInsight + WBPP versions; the sidecar
enforces this with a version handshake and refuses to distribute on a mismatch.

## Adding support for a new WBPP version

When WBPP releases a new version, support is **opt-in and evidence-based**:

1. Open WBPP's source on the target machine (`<PixInsight>/src/scripts/BatchPreprocessing/`)
   and confirm the operation names, process fields and post-processing hooks the shim
   anchors on are unchanged (or update the anchors if they moved).
2. Run a real dataset **both ways** — distributed vs local-only — and confirm the
   masters/registered frames are **bit-identical** (or within the documented tolerance).
3. Add the version to `WBPP_SHIM_COMPAT`, extend the table above with the evidence, and
   note it in [`CHANGELOG.md`](../CHANGELOG.md).
4. Cut a new release (tag `vX.Y.Z`) — CI builds and publishes the artifact.

Until steps 1–3 are done for a version, that version simply runs locally. That is the
intended behavior, not a bug.
