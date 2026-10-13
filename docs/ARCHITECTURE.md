# Architecture — Distributed-WBPP

## Problem & constraints
Distribute a single WBPP run across 2–3 LAN PCs, driven entirely from the native
WBPP UI, with **no shared folder**, **LAN auto-discovery**, and resilience to WBPP
updates. Two hard limits shape everything:

1. **PJSR is network-client-only** (`NetworkTransfer`); it cannot listen or
   discover. → a bundled **sidecar** binary does all LAN work. And PixInsight does
   not capture a child's stdout, so PJSR ↔ sidecar talk through **files**
   (`--in-file`/`--out-file`).
2. **WBPP has no public extension API**. → distribution is grafted by a small,
   version-pinned **monkey-patch** with a safe local fallback.

Determinism is guaranteed by a **strict version handshake**: identical PixInsight
+ WBPP on every node (pixel rejection / algorithms must match). Validated
**bit-identical** (a worker-produced master == a local master).

## Components

```
                 ┌──────────────── SERVER PC ─────────────────┐
 user configures │ PixInsight + native WBPP + WBPPShim         │
 WBPP, clicks GO │   • per-frame: capture executeGlobal,       │
                 │     split group server ∥ cluster (adaptive) │
                 │   • whole-job: capture ImageIntegration,     │
                 │     lease workers for whole masters          │
                 │        │ ctl distribute (localhost, files)   │
                 │        ▼                                     │
                 │   sidecar --mode agent                       │
                 │    • multicast browse (find workers)         │
                 │    • shard/lease + push + run + collect       │
                 └───────────────│────────────────────────────┘
                                 │ LAN: discovery (UDP multicast)
                                 │      transfer (mutual TLS + HMAC)
                 ┌───────────────▼────────────────────────────┐
                 │ CLIENT PC: sidecar --mode worker + PI worker │
                 │   • advertises on the LAN                    │
                 │   • pulls shard + serialized process         │
                 │   • runs it (calib / SA / LN / SS / II)      │
                 │   • returns outputs (frames / metrics / master)│
                 └──────────────────────────────────────────────┘
        final light integrations = distributed per filter; autocrop + astrometry = LOCAL
```

## Two distribution models

The shim uses whichever fits the step:

**Per-frame (intra-group split).** For `Calibration`, `Registration`,
`LocalNormalization` (process ops) and `Measurements` (via `engine.computeDescriptors`).
The group's frames are split into a server share and a cluster share; the server
processes its share locally **while** the agent shards the rest across workers, then
we join. The split is **adaptive**: per-operation cost/frame is measured (compute for
the server, compute+transfer for the cluster) and EMA-smoothed, so the next group
rebalances — slow/Wi-Fi clients get fewer frames. A **lights-only guard** keeps cheap
flat/dark calibration local.

**Whole-job (job assignment).** For `ImageIntegration` (a reduction — indivisible).
Each master integration is captured (its configured `ImageIntegration` via the
executeGlobal sentinel) and dispatched **whole** to one worker; the server integrates
its share locally in parallel. The sidecar's **whole-job primitive** leases one free
worker per job (busy tracker) and serializes concurrent jobs per worker, so two jobs
never collide on one worker's pull queue. Calib masters (bias/dark/darkflat) are a
consecutive batch; flat masters are interleaved with their calibration, so the shim
takes over at the first flat integration, runs the (cheap) flat calibrations locally,
then batches the flat integrations.

## Sidecar (Go, `sidecar/`)
- `protocol.go` — wire types, constants (multicast group, magic, TTL, handshake).
- `discovery.go` — UDP multicast **beacon** advertise/browse + a TTL `Registry`
  (custom beacon for a zero-dependency static binary; swappable to DNS-SD).
- `transport.go`: HTTPS (mutual TLS): `/health` (handshake), `/have`, `/upload`,
  `/download`, `/lan/work`; every request and response is HMAC-signed, every transfer
  carries a SHA-256 and is verified. Master files are cached by checksum (uploaded
  once, reused across groups). `/lan/work` validates the manifest (op, process id,
  plain file names) before parking it.
- `pullexecutor.go` — `PullExecutor`: `/lan/work` parks a shard; the PixInsight
  worker pulls it (`GET /v1/work`), runs it, reports (`POST /v1/work/result`).
- `distribute.go` — `distributeJob()`: handshake → shard → push shared+shard →
  run → download+verify. `WholeJob` sends all inputs to the single leased worker.
- `api.go` — `--mode agent`: localhost control plane (`/v1/status`, `/v1/nodes`,
  `/v1/distribute`). For whole-jobs it leases a free worker (`acquireWorker`/
  `releaseWorker`, serialized) before dispatch.
- `main.go` — flags + modes `worker` / `server` / `agent`.

## PixInsight side (PJSR, `pjsr/`)
- `DistributedWBPP.js` — the single entry (`#feature-id`). A role picker chooses:
  - **Server** — mirrors `WBPP.js` (`#include BPP-defines/BPP-main` then `BPPmain`)
    and inserts one hook, `installShim(engine, bridge)`, between the include and the
    run. The user sees the **normal WBPP dialog**, plus a live cluster dashboard.
  - **Client** — runs `lib/WorkerRuntime.js`.
- `lib/WorkerRuntime.js`: the client pull loop (Timer); rebuild the job's process
  from its data description (allowlist, op → process id), rewrite server paths → local
  uploaded copies, run it, report outputs.
  Modes: process (calib/SA/LN), `measurements` (SubframeSelector → `.ssm.json`),
  `integration` (ImageIntegration → save the integration view → server finalizes).
- `lib/SidecarBridge.js` — launch the sidecar + drive its control API over files;
  `distributeAsync`/`distributeWait` for non-blocking cluster jobs.
- `lib/WBPPShim.js` — the monkey-patch (both models above) + adaptive split + the
  Execution Monitor tagging.
- `lib/ProcessSerializer.js`: `{ id, params }` data round-trip of a process: names
  from `toSource`, values from the live instance; rebuilt with `new` from a fixed
  allowlist, known parameters and types only. No `eval`.

## The WBPP hook (WBPP 2.9.1)
Operations are `BPPOperationBlock(name, group, trackable)` with a stable `this.name`
and per-instance `this.run`. We wrap at **`addOperation`** time and swap `op.run` for
the distributed version when `name` matches a distributable op. `Measurements` and
`Integration` don't expose a simple process, so we wrap the engine calls they make
(`engine.computeDescriptors`, and capture `ImageIntegration.executeGlobal`). The
queue's `operations[]` array is used for **look-ahead** batching (skipping the unnamed
`addOperationBlock` log blocks WBPP interleaves). Anchored to WBPP 2.9.1
(`engine` at `BPP-engine.js:4688`); `WBPP_SHIM_COMPAT` gates the version.

## Failure & fallback
- Unknown WBPP version → shim inactive, **native local run** (warned).
- No workers discovered → native local run.
- Any per-operation / per-job distribution error → that step falls back to local
  (frames re-processed locally so nothing is ever lost).
- Version mismatch at handshake → job refused (unless `--force`).

## Security (LAN)
See `SECURITY.md` for the threat model.
- Per-cluster **key** (160 bits, `wbpp-sidecar keygen`), stored in the script Settings,
  handed to the sidecar through a one-shot file (`--secret-file`, deleted on read).
- Sub-keys derived by HMAC: request/response signing, beacon signing, and the seed of
  an ed25519 cluster CA. Each sidecar mints an ephemeral leaf from that CA; LAN
  connections are TLS 1.3 with `RequireAndVerifyClientCert`.
- Beacons are signed and must come from an announced address; older-protocol and
  foreign-key beacons are reported in `/v1/nodes` (`incompatible`).
- Worker listens on private LAN IPv4s + loopback only; body sizes capped.
- Control APIs bound to **127.0.0.1**, with an `X-WBPP-Control` header and `Host` check.
- Jobs carry process data, never code (see `ProcessSerializer.js`).
