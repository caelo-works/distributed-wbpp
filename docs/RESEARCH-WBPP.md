# WBPP research — hook points for distribution

> Source of truth: the local PixInsight install (Windows).
> `C:\Program Files\PixInsight\src\scripts\BatchPreprocessing\` — **WBPP 2.9.1**
> (`BPP-*.js` files, internal prefix "BPP" = Batch PreProcessing; `WBPP.js`
> and `FBPP.js` are the entry points).
> Files dated "Released 2026-01-16". To be re-checked at every WBPP update.

## Engine map (key files)

| File | Role |
|---|---|
| `WBPP.js` / `FBPP.js` | entry points (load everything else) |
| `BPP-defines.jsh` | `#define WBPP_VERSION "2.9.1"`, constants |
| `BPP-StackEngine.js` | the engine object (`engine`) — small (67 l.), aggregates the state |
| `BPP-processing.js` | **calibration** execution (ImageCalibration), masters, integration (`executeGlobal`) |
| `BPP-operations.js` | all per-frame **operations**: CosmeticCorrection, Debayer, **StarAlignment**, LocalNormalization (3672 l.) |
| `BPP-operationQueue.js` | `OperationQueue` + `OperationBlock` — **the dispatcher** |
| `BPP-pipelineBuilders.js` | builds the operation queue based on groups/params |
| `BPP-ExecutionCache.js` | execution cache (key = process source + file LMD) |
| `BPP-FrameGroup.js` / `BPP-FrameGroupsManager.js` | frame grouping (filter/expo/binning…) |

## The dispatcher (interception chokepoint)

`BPP-operationQueue.js`:

- `OperationQueue.run(env)` → loops over `this.operations[]` → `executeTask(i)` →
  `operation._perform(env, requestInterruption)` → **`operation.run(env, interruptQueue)`**.
- `OperationBlock` is the base class; each operation assigns `this.run` /
  `this._run` **in the constructor** (closures, **no prototype** → you cannot
  patch a prototype; we wrap `operation.run` at the time of
  `addOperation`, or replace the closure of the targeted operation).

### 🎯 Official hook discovered — "pipeline event script"
`OperationQueue` supports a user-injected **event script**:
- `installEventScript(filePath)` loads a `.js`, validated in a sandbox.
- Emitted at: `"pipeline start"`, `"pipeline end"`, and per operation `"start"` / `"done"`
  **if** `op.operation.triggersEventScript === true`.
- `triggerOperationWithEvent()` injects `op.operation.envForScript()` into `env`,
  plus `env.operationIndex`, `env.operation`, `env.event`, `env.operationsCount`.

➡️ This is a **documented and stable extension point** (survives updates better).
It is **observational** (operation boundaries), so insufficient on its own to
**redirect** the compute, but ideal for: orchestration signals, sidecar
startup, reference frame selection, barriers. The actual compute redirection
happens at the operation level (below).

## StarAlignment operation (Milestone 3 target) — `BPP-operations.js` ~1827–1996

`_run` sequence:
1. `activeFrames = frameGroup.activeFrames()`; `filePaths = activeFrames.map(i => i.current)`.
2. builds `SA = new StarAlignment` with **all** params from `engine.*` +
   `SA.referenceImage = frameGroup.__reference_frame__`, `referenceIsFile = true`,
   `SA.outputDirectory = engine.outputDirectory + "/registered/" + subfolder`.
3. **serializes**: `SA.toSource("JavaScript", "SA", 0, SourceCodeFlag_NoTimeInfo |
   SourceCodeFlag_NoReadOnlyParams | SourceCodeFlag_NoDescription)`.
4. cache: skips already-aligned frames (key = `executionCache.keyFor(SASource)`).
5. `SA.targets = WBPPUtils.enableTargetFrames(filesToRegister, 3)` then **a single**
   `SA.executeGlobal()`.
6. reads `SA.outputData` (`outputData[i][0]` = output file), requires
   `outputData.length == filesToRegister.length`.

Outputs: `_r` postfix, `.xisf` extension, + drizzle `.xdrz`
(`generateDrizzleData = true`), `outputSampleFormat = f32`.

### Distribution strategy (registration)
Replace the registration operation's `_run` with a version that:
1. pushes `frameGroup.__reference_frame__` + `SASource` to each worker (versions
   already verified identical by the handshake);
2. **shards** `filesToRegister` across the workers;
3. each worker rebuilds `SA` from the source, sets `SA.targets` = its shard and
   the **same** `outputDirectory`, `executeGlobal()`, returns the `_r.xisf` (+ `.xdrz`) files;
4. the server aggregates the files in `registered/<subfolder>/` and **rebuilds
   `SA.outputData`** (same length/order as the input) so that the rest of `_run`
   (cache, matching) continues seamlessly.

Notes:
- **Cache**: disable/ignore the cache on the worker side (always align its shard);
  the server remains the owner of the cache.
- Same remarks for **calibration** (`BPP-processing.js`, `ImageCalibration`,
  `executeGlobal`), **CosmeticCorrection** and **Debayer** (`BPP-operations.js`).
- **Final integration**: stays **local** (reduction).

## Process serialization — confirmed
`ProcessInstance.toSource(lang, varId, indent, flags)` is used by WBPP itself
(line 1893) ⇒ `ProcessSerializer` (PJSR) will rely on it: we capture the source of the
process configured on the server side, `eval` it on the worker side to rebuild an
identical instance, set `targets`/`outputDirectory`, then `executeGlobal()`.

## Consequences for the WBPPShim
- Minimal hook: wrap, at `addOperation`, **the registration-type operations
  (and later calibration/cosmetic/debayer)**, identified by an
  operation marker (to be confirmed: name/type field on the OperationBlock or via
  `pipelineBuilders`).
- Compat table **per WBPP version** (`WBPP_VERSION`), currently `2.9.1`.
- Version missing from the table ⇒ **warning + WBPP left unpatched** (fallback).
- To confirm on the next pass: the operation-type marker and the exact place
  where `pipelineBuilders` instantiates the registration op.
