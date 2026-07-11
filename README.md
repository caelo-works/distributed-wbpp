<div align="center">

# Distributed WBPP

### Run PixInsight's Weighted Batch Preprocessing across every PC on your network

[![Version](https://img.shields.io/badge/version-1.8.0-22d3ee?style=for-the-badge&labelColor=0f172a)](https://github.com/caelo-works/distributed-wbpp/releases/latest)
[![PixInsight](https://img.shields.io/badge/PixInsight-%E2%89%A5%201.9.0-67e8f9?style=for-the-badge&labelColor=0f172a)](https://pixinsight.com/)
[![Status](https://img.shields.io/badge/status-beta-fbbf24?style=for-the-badge&labelColor=0f172a)](https://pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp)
[![License](https://img.shields.io/badge/license-GPL--3.0-94a3b8?style=for-the-badge&labelColor=0f172a)](LICENSE)
[![Website](https://img.shields.io/badge/%E2%86%92%20see%20all%20scripts-pixinsight--scripts.caelo.works-0f172a?style=for-the-badge&labelColor=22d3ee)](https://pixinsight-scripts.caelo.works/en)

[![CaeloWorks · PixInsight Scripts](https://pixinsight-scripts.caelo.works/assets/readme-banner.png)](https://pixinsight-scripts.caelo.works/en)

</div>

---

## Overview

WBPP calibrates, registers and integrates your frames one machine at a time — while
the other PCs on your network sit idle. Distributed WBPP puts them to work. You drive
the **native WBPP dialog** exactly as usual on one machine; the heavy,
embarrassingly-parallel per-frame steps (calibration, registration, local
normalization, measurements) and the calibration-master integrations are sharded
across helper PixInsight instances on your LAN, then collected back for the final
integration. No shared folder, no reconfiguration — frames move over the network
through a bundled companion, and the split **self-tunes to each machine's speed**. If
no helper is found or a version doesn't match, it falls back to a normal local WBPP
run — never a silently wrong result.

> 📖 **Full details & docs:** **[pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp](https://pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp)**

## Screenshots

<div align="center">

![Role picker — on each PC, choose Server (drive WBPP) or Client (help)](https://pixinsight-scripts.caelo.works/assets/scripts/distributed-wbpp-1-roles.webp)

![Server dashboard — connected clients and the live server ∥ cluster split during the WBPP run](https://pixinsight-scripts.caelo.works/assets/scripts/distributed-wbpp-2-monitor.webp)

![Client — a helper processing the shards it is handed](https://pixinsight-scripts.caelo.works/assets/scripts/distributed-wbpp-3-client.webp)

</div>

## Features

| | |
|---|---|
| 🖥️ **Native WBPP, unchanged** | You use the real WBPP dialog with all its options — distribution is grafted underneath. The only extra gesture: launch the script in *Client* mode on the other PCs. |
| 🌐 **Zero-config LAN clustering** | Helpers are discovered automatically (UDP multicast); frames and process parameters travel over HTTP with SHA-256 integrity. No shared drive, no manual IP addresses. |
| ⚡ **The heavy steps, in parallel** | Calibration, registration, local normalization, measurements and the calibration-master integrations are sharded across the cluster; the server works its own share at the same time. |
| ⚖️ **Adaptive load balancing** | The server ∥ cluster split is measured and self-tunes every group, weighted by each worker's real throughput — a slower machine simply gets fewer frames, automatically. |
| 🛟 **Safe local fallback** | A strict version handshake (identical PixInsight + WBPP on every node) guards determinism; on any mismatch, missing helper or error, it runs a normal local WBPP. |
| 💻 **Self-contained companion** | The networking companion ships inside the package — nothing to install, no runtime, no configuration. **Validated on Windows, macOS and Linux**, including mixed-OS clusters (see the mixed-OS note below). |

## Installation

### From the CaeloWorks update repository (recommended)

In PixInsight, open **Resources → Updates → Manage Repositories** and add
`https://pixinsight-scripts.caelo.works/update/`, then run
**Resources → Updates → Check for Updates**, accept the install and restart.
Do this on **every PC** of the cluster. Updates are then delivered
automatically through the same channel.

> The repository is not CPD-signed yet, so PixInsight shows an
> "unsigned repository" warning; signing is underway.

### Manual install

Download `DistributedWBPP-<version>.zip` from the
**[Releases](https://github.com/caelo-works/distributed-wbpp/releases)** and extract it
**into your PixInsight installation directory**, so that
`src/scripts/CaeloWorks/DistributedWBPP/` lands under `<PixInsight>/src/scripts/`.
Restart PixInsight — the script appears under **Script → Batch Processing → Distributed
WBPP**. Install it on **every PC** you want in the cluster.

> **Requires PixInsight 1.9.0 or newer**, the **same version on every node.**
>
> **Platform support:** validated end-to-end on **Windows**, **macOS** (Sonoma, Intel) and
> **Linux** (Ubuntu 24.04), including **mixed-OS clusters** (Windows server driving Linux
> and macOS workers). The companion is not yet code-signed; on macOS that is harmless in
> practice — PixInsight spawns it directly, a path Gatekeeper does not block — and the
> plugin defensively strips the quarantine flag anyway.
>
> **Mixed-OS note:** results are **bit-identical** when all nodes run the same OS. Across
> OSes they are **numerically equivalent but not bit-identical**: PixInsight's math libraries
> differ slightly per platform, so a handful of pixels sitting exactly on a rejection
> threshold may be clipped on one OS and kept on the other (observed: mean difference
> < 1e-8, worst local difference ~1e-3 on hot pixels of a master dark — astronomically
> insignificant).

## Getting started

1. On each **helper** PC, run **Script → Batch Processing → Distributed WBPP** and pick **Client** — leave the window open; it discovers the server and processes the shards it's handed.
2. On the machine you **drive from**, run it and pick **Server** — the **native WBPP dialog** opens.
3. Add your frames and configure everything as usual, then click **Run**. A dashboard lists the connected clients and the live **server ∥ cluster** split; WBPP's own Execution Monitor tags each distributed row.
4. When helpers are present the heavy steps are distributed automatically — including the final per-filter light integrations; autocrop and the astrometric solution run locally on the server.

Nothing changes in your usual WBPP habit — the single addition is starting the same
script in **Client** mode on the other PCs.

## How it works

The server runs the native WBPP pipeline; a version-pinned shim grafts distribution
onto it, splitting the heavy work over the cluster.
PJSR can only act as a network *client* and cannot discover peers, so a small bundled
companion — the **sidecar** (a single static executable per OS, no runtime) — does the
LAN work.

```
Server PC: PixInsight + native WBPP + shim ──(localhost, files)──▶ sidecar (agent) ──┐
                                                                                     │ LAN: auto-discovery
Client PC: PixInsight + worker script      ◀─(localhost, files)── sidecar (worker) ◀─┘  + frame transfer (SHA-256)
```

Two complementary distribution models:

| Model | Steps | How |
|---|---|---|
| **Per-frame** (intra-group split) | Calibration · Measurements · Registration · Local Normalization | each group's frames are split server ∥ cluster **adaptively** (measured per-machine cost, transfer included) |
| **Whole-job** (job assignment) | Calibration **master integrations** (bias / dark / flat) · **final light integrations** (one per filter) | each indivisible integration is leased to one free worker while the server integrates its share in parallel |

The final per-filter **light integrations are distributed too** (whole-jobs, with their
drizzle/local-normalization companions). Autocrop and the astrometric solution stay
**local** on purpose (global cross-filter crop intersection; per-node star-catalog
dependency). Correctness is enforced by the version handshake
and was validated **bit-identically** against a local run.

---

<details>
<summary><b>🛠 Development</b> — build, CI, packaging contract, WBPP compatibility, limits</summary>

### Repo layout

| Path | What |
|---|---|
| `sidecar/` | Go companion: discovery (UDP multicast), transfer (HTTP + SHA-256), control plane, whole-job leasing |
| `pjsr/DistributedWBPP.js` | Single entry: pick **Server** (native WBPP + shim) or **Client** (worker) |
| `pjsr/lib/` | `SidecarBridge` (PJSR↔sidecar), `WBPPShim` (the monkey-patch), `WorkerRuntime` (client loop), `ProcessSerializer`, `FileLogger` |
| `pjsr/assets/DistributedWBPP.svg` | Menu icon (`#feature-icon`) |
| `scripts/build-sidecar.sh` | Cross-compile the sidecar for win/linux/mac |
| `scripts/build-update-package.sh` | Emit the release artifact (`dist/` zip + `update-package.json`) for the shared update repo |
| `docs/` | Architecture, WBPP research, status |

### Build

```bash
cd sidecar && go test ./... && go vet ./...   # test the sidecar
bash scripts/build-sidecar.sh                 # cross-compile -> bin/ (win/linux/mac)
```

### Distribution

Distributed WBPP ships through a single, shared CaeloWorks update repository hosted on
the showcase site (`https://pixinsight-scripts.caelo.works/update/`), which lists every
CaeloWorks script. **This repo does not generate or host the `updates.xri`** — it emits,
per release, a standardized *distribution artifact* that the site ingests to build (and
CPD-sign) the aggregated index.

```bash
scripts/build-update-package.sh <version> [releaseDate YYYYMMDD]   # -> dist/
```

Produces two files under `dist/`, both **attached as assets of the matching GitHub
release** (the hand-off point the site pulls from):

| File | What |
|---|---|
| `DistributedWBPP-<version>.zip` | the package, tree **relative to PixInsight's install dir** (extracted verbatim by the updater): `src/scripts/CaeloWorks/DistributedWBPP/{DistributedWBPP.js, lib/*.js, bin/wbpp-sidecar-*}` + `rsc/icons/script/DistributedWBPP/DistributedWBPP.svg`. The WBPP `#include` is rewritten to the portable `../../BatchPreprocessing/`. |
| `update-package.json` | metadata the site needs to emit this package's `<package>` element: `name, slug, version, fileName, sha1, type, releaseDate, piVersionRange, title, descriptionHtml`. |

- **Reproducible zip.** Entries are sorted, mtimes pinned to 1980-01-01, permissions
  fixed (`0755` for `bin/`, `0644` otherwise) — identical content yields an identical
  SHA-1, so the site authenticates the package by the `sha1` in the JSON.
- **`fileName` is relative** to the repository base URL (served from `…/update/<fileName>`).
  No absolute GitHub URLs enter the index.
- **Two signatures, two owners.** The `<Signature developerId=…>` on the aggregated
  `updates.xri` is the **site's** job (CPD identity from Pleiades Astrophoto). The optional
  per-**script** code signature (`DistributedWBPP.xsgn`, alongside the `.js` in the zip) is
  **this** repo's job — but it is **disabled by default** and stays off until CaeloWorks'
  CPD public key is distributed by PixInsight, because an *unverifiable* signature can
  hard-block users whereas "unsigned" is only a dismissable warning. To cut a signed
  artifact once the CPD identity is live:

  ```bash
  XSSK_PATH=/path/to/CaeloWorks.xssk PI_EXE=/path/to/PixInsight \
    scripts/build-update-package.sh <version>
  ```

  The key **password** is prompted at runtime (`read -s`) and handed to PixInsight only
  through the signing process's transient environment — **never** written to a file, log,
  script or the repo (and `*.xssk` is git-ignored). Only the entry script is signed
  (`lib/*.js` are not). A `.xsgn` embeds a timestamp, so a **signed** zip is not
  byte-reproducible — its `sha1` changes per signing, and the site regenerates the index
  from the JSON `sha1` accordingly.
- **Sidecar embedded, not downloaded.** All Go binaries (~7 MB each) ride inside the zip
  and `resolveSidecar()` picks `wbpp-sidecar-<os>-<arch>` at runtime. Because the package
  is a single `os="all"` archive extracted verbatim, this costs each user ~28 MB of
  binaries they won't run — accepted to keep the artifact self-contained (no first-launch
  fetch, no separate binary host, no extra metadata channel). The escape hatch, if size
  ever bites, is a first-launch download with an embedded SHA manifest — a localized
  change to `SidecarBridge`, not a re-architecture.

### Limits (assumed)

- The shim monkey-patches WBPP's engine, so a major WBPP refactor can require a version
  bump (surface is minimal + version-pinned, with a safe **local fallback** when the
  version is unknown or anything fails — never a silently wrong result).
- **Autocrop** and the **astrometric solution** stay local (global cross-filter crop
  intersection; per-node star-catalog dependency). The speedup ceiling is set by these
  remaining local steps and by the transfer of the registered frames.
- PixInsight must be licensed + installed on every node, all at the **same version** as WBPP.

See [`docs/STATUS.md`](docs/STATUS.md) for the detailed state and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

</details>

---

<div align="center">

### 🌌 More PixInsight scripts by CaeloWorks

**[Explore the full catalogue → pixinsight-scripts.caelo.works](https://pixinsight-scripts.caelo.works/en)**

<sub>Made by <a href="https://caelo.works/en">CaeloWorks</a> · astrophotography software, firmware & hardware · GPL-3.0 License</sub>

<sub>PixInsight is a registered trademark of Pleiades Astrophoto, S.L. CaeloWorks is an independent third-party developer.</sub>

</div>
