<div align="center">

# Distributed WBPP

### Run PixInsight's Weighted Batch Preprocessing across every PC on your network

[![Version](https://img.shields.io/badge/version-1.9.2-22d3ee?style=for-the-badge&labelColor=0f172a)](https://github.com/caelo-works/distributed-wbpp/releases/latest)
[![PixInsight](https://img.shields.io/badge/PixInsight-%E2%89%A5%201.9.4-67e8f9?style=for-the-badge&labelColor=0f172a)](https://pixinsight.com/)
[![Status](https://img.shields.io/badge/status-withdrawn-ef4444?style=for-the-badge&labelColor=0f172a)](#end-of-life-distributed-wbpp-is-withdrawn)
[![License](https://img.shields.io/badge/license-GPL--3.0-94a3b8?style=for-the-badge&labelColor=0f172a)](LICENSE)

</div>

---

## End of life: Distributed WBPP is withdrawn

**Distributed WBPP is withdrawn, every version, by 2026-12-12.** It does not fit the rules
of the Certified PixInsight Developer Program, so it is no longer distributed, updated or
supported.

**Removing it from the CaeloWorks update repository does not uninstall it.** Copies
already installed stay on your PCs until you remove them. Follow the steps below on
**every PC** where you installed it, server and clients alike.

**Do not leave client mode running.** A PC in client mode accepts work from the network.
Version 1.0.0 in particular runs code received from the network (security advisory
[GHSA-r9w7-3wf4-hhr2](https://github.com/caelo-works/distributed-wbpp/security/advisories/GHSA-r9w7-3wf4-hhr2)):
stop it now.

### How to uninstall

`<PixInsight>` is the PixInsight installation folder, for example
`C:\Program Files\PixInsight` on Windows, `/Applications/PixInsight` on macOS (the folder
that contains `PixInsight.app`, `src` and `rsc`) or `/opt/PixInsight` on Linux.
`<home>` is your user folder: `C:\Users\<you>`, `/Users/<you>` or `/home/<you>`.

1. **Stop it.** On each client, click **Leave client mode**, close the script, then quit
   PixInsight. Check that no sidecar is left running: on Windows, end `wbpp-sidecar.exe`
   in the Task Manager (or run `taskkill /F /IM wbpp-sidecar.exe`); on macOS and Linux, run
   `pkill wbpp-sidecar`.
2. **Delete the script and its sidecar programs** from the PixInsight installation folder
   (administrator rights are needed):
   - `<PixInsight>/src/scripts/CaeloWorks/DistributedWBPP/` (the whole folder, including
     `bin/` and its `wbpp-sidecar-<os>-<cpu>` programs);
   - `<PixInsight>/rsc/icons/script/DistributedWBPP/`, if it exists (versions before 1.8.0);
   - versions 1.0.0 to 1.8.x only: the logs in `<PixInsight>/src/scripts/CaeloWorks/logs/`
     (`server-*.log`, `client-*.log`, `sidecar-*.log`), then that folder if it is empty.

   Keep `<PixInsight>/src/scripts/CaeloWorks/` itself if other CaeloWorks scripts are
   installed.
3. **Refresh the menu.** Start PixInsight, open **Script > Feature Scripts…**, click
   **Regenerate**, then **Done**, and restart PixInsight. **Script > CaeloWorks > Distributed WBPP** is
   gone.
4. **Delete the files in your user folder:**
   - `<home>/CaeloWorks/DistributedWBPP/` (logs and client cache, versions 1.9.x), then
     `<home>/CaeloWorks/` if it is empty;
   - in the system temporary folder, any leftover `wbpp-*` file or folder, and the
     `wbpp-cluster-worker` folder (versions 1.0.0 to 1.8.x).
5. **Delete the cluster key** (versions 1.9.x; earlier versions had none). It is stored in
   the PixInsight settings under `DistributedWBPP/clusterKey`. With a text editor, create a
   file named `remove-dwbpp-key.js` that contains this single line:

   ```
   Settings.remove( "DistributedWBPP/clusterKey" );
   ```

   In PixInsight, choose **Script > Execute Script File…**, select that file: it runs at
   once. Then delete the file. (In Windows Notepad, choose "All files" when saving, so the file
   is not named `remove-dwbpp-key.js.txt`.)
6. **Remove the firewall rule** for `wbpp-sidecar`, if you allowed it: on Windows, in
   **Windows Security > Firewall & network protection > Allow an app through firewall**; on
   macOS, in **System Settings > Network > Firewall > Options**.

The CaeloWorks update repository can stay in **Resources > Updates > Manage
Repositories** if you use other CaeloWorks scripts: it no longer offers Distributed WBPP,
but it does not remove it either.

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
| 🌐 **Zero-config LAN clustering** | Helpers are discovered automatically (UDP multicast); frames and process parameters travel encrypted (TLS), between PCs that share your cluster key. No shared drive, no manual IP addresses. |
| ⚡ **The heavy steps, in parallel** | Calibration, registration, local normalization, measurements and the calibration-master integrations are sharded across the cluster; the server works its own share at the same time. |
| ⚖️ **Adaptive load balancing** | The server ∥ cluster split is measured and self-tunes every group, weighted by each worker's real throughput — a slower machine simply gets fewer frames, automatically. |
| 🛟 **Safe local fallback** | A strict version handshake (identical PixInsight + WBPP on every node) guards determinism; on any mismatch, missing helper or error, it runs a normal local WBPP. |
| 💻 **Self-contained companion** | The networking companion ships inside the package — nothing to install, no runtime, no configuration. **Validated on Windows, macOS and Linux**, including mixed-OS clusters (see the mixed-OS note below). |

## Installation

> **Withdrawn.** Distributed WBPP is no longer distributed: do not install it. This section
> is kept for reference only. See [End of life](#end-of-life-distributed-wbpp-is-withdrawn).

### From the CaeloWorks update repository (recommended)

In PixInsight, open **Resources → Updates → Manage Repositories** and add
`https://pixinsight-scripts.caelo.works/update/`, then run
**Resources → Updates → Check for Updates**, accept the install and restart.
Do this on **every PC** of the cluster. Updates are then delivered
automatically through the same channel.

The repository is signed with the Caelo Works Certified PixInsight Developer identity, so
PixInsight verifies where the updates come from and that they have not been altered.

### Manual install

Download `DistributedWBPP-<version>.zip` from the
**[Releases](https://github.com/caelo-works/distributed-wbpp/releases)** and extract it
**into your PixInsight installation directory**, so that
`src/scripts/CaeloWorks/DistributedWBPP/` lands under `<PixInsight>/src/scripts/`.
Restart PixInsight — the script appears under **Script → CaeloWorks → Distributed
WBPP**. Install it on **every PC** you want in the cluster.

> **Requires PixInsight 1.9.4 or newer**, the **same version on every node**, and the
> **same version of Distributed WBPP on every node** (a 1.9.x node and a 1.8.x node cannot
> work together: the server lists the older ones and ignores them).
>
> **Platform support:** validated end-to-end on **Windows**, **macOS** (Sonoma, Intel) and
> **Linux** (Ubuntu 24.04), including **mixed-OS clusters** (Windows server driving Linux
> and macOS workers). The companion is not code-signed by Apple. On macOS that is harmless
> in practice: PixInsight starts it directly, a path Gatekeeper does not block, even when
> the files of a downloaded zip carry the quarantine flag. The script never touches that
> flag. If you installed manually from the zip and prefer to clear it, run this yourself:
> `xattr -dr com.apple.quarantine "/Applications/PixInsight/src/scripts/CaeloWorks/DistributedWBPP/bin"`.
>
> **Mixed-OS note:** results are **bit-identical** when all nodes run the same OS. Across
> OSes they are **numerically equivalent but not bit-identical**: PixInsight's math libraries
> differ slightly per platform, so a handful of pixels sitting exactly on a rejection
> threshold may be clipped on one OS and kept on the other (observed: mean difference
> < 1e-8, worst local difference ~1e-3 on hot pixels of a master dark — astronomically
> insignificant).

## Getting started

1. On the machine you **drive from**, run **Script → CaeloWorks → Distributed WBPP** and pick **Server**. The first time, a **cluster key** is created (32 letters and digits); the server window shows it. The **native WBPP dialog** opens.
2. On each **helper** PC, run the script, paste the server's **cluster key** in the role picker (once: it is remembered), and pick **Client**. Leave the window open; it processes the shards the server hands it.
3. Back on the server, add your frames and configure everything as usual, then click **Run**. A dashboard lists the connected clients and the live **server ∥ cluster** split; WBPP's own Execution Monitor tags each distributed row.
4. When helpers are present the heavy steps are distributed automatically, including the final per-filter light integrations; autocrop and the astrometric solution run locally on the server.

Apart from the key, pasted once per PC, nothing changes in your usual WBPP habit: the
single addition is starting the same script in **Client** mode on the other PCs. Only PCs
that share the key work together, so two clusters on the same network never mix. The
**New key** button in the role picker replaces the key (every client then needs the new one).

## How it works

The server runs the native WBPP pipeline; a version-pinned shim grafts distribution
onto it, splitting the heavy work over the cluster.
PJSR can only act as a network *client* and cannot discover peers, so a small bundled
companion — the **sidecar** (a single static executable per OS, no runtime) — does the
LAN work.

```
Server PC: PixInsight + native WBPP + shim ──(localhost, files)──▶ sidecar (agent) ──┐
                                                                                     │ LAN: auto-discovery
Client PC: PixInsight + worker script      ◀─(localhost, files)── sidecar (worker) ◀─┘  + frame transfer (TLS, cluster key)
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

## Network, programs and files

Everything Distributed WBPP does outside PixInsight's own processing, stated in full.
The script's role picker shows the same information (**Network, programs and files…**).

### Network

Everything stays on your local network. The script never connects to the Internet and
sends nothing to CaeloWorks or anyone else.

| What | Where | Why |
|---|---|---|
| Discovery announcements | UDP multicast `239.255.42.99`, port `42099`, local subnet only | Each client announces itself every 2 s: machine name, operating system, PixInsight and WBPP versions, its LAN addresses and port. Announcements are signed with the cluster key; the server ignores any other. |
| Client port | TCP, one port per client, chosen by the system at start, on the client's private LAN addresses only (plus `127.0.0.1`) | The server connects to it to send frames, masters and jobs, and to fetch the results. |
| Local control port | TCP `127.0.0.1:48099` | PixInsight talks to its own sidecar on the same computer. Not reachable from the network. |

**What travels between your PCs:** light and calibration frames, master frames,
intermediate files (registration and drizzle data, local normalization data, frame
measurements), the parameters of the WBPP processes run on the clients (they include the
file paths of the server), and the announcements listed above.

**How it is protected:**

- A **cluster key**: 160 random bits, created on the server from the system's secure random
  source and pasted once on each client. It is stored in the PixInsight settings of each PC
  and never sent over the network.
- **TLS 1.3** on every connection between PCs, with both ends authenticated by the key. A PC
  without the key cannot connect, read or alter what is transferred.
- Every request and every answer is also **signed** with the key (time-stamped, never
  accepted twice), and every file is checked against its signed SHA-256.
- Clients run only a fixed list of WBPP processes (calibration, registration, local
  normalization, image integration, drizzle integration, frame measurements), rebuilt from
  **parameter values**: a client never runs code received from the network.
- Announcements from PCs with another key, or from an older version of Distributed WBPP,
  are ignored; the server window names them so you know which PC to fix.

**Firewall.** The first time the sidecar starts on a PC, Windows or macOS asks whether
`wbpp-sidecar` may accept incoming network connections. Allow it **on private networks**,
on every PC of the cluster (server included: it receives the announcements).

### Programs started by the script

| Program | When | Why |
|---|---|---|
| The bundled sidecar, `<PixInsight>/src/scripts/CaeloWorks/DistributedWBPP/bin/wbpp-sidecar-<os>-<cpu>` (`windows-amd64.exe`, `darwin-arm64`, `darwin-amd64`, `linux-amd64`, `linux-arm64`) | In the background while the script is open; briefly for each exchange with PixInsight and to create a cluster key | Discovery and transfers on the LAN (PixInsight scripts cannot listen on the network). On macOS and Linux it is first started with `--version`, to pick the build that runs on your processor. Stopped when you close the script. |
| `taskkill /F /IM wbpp-sidecar.exe` | Windows only, when the script starts | Ends a sidecar left over by a previous session that did not close cleanly. |
| `/bin/chmod u+x` on the sidecar | macOS and Linux only, and only if no sidecar build can start because the file lost its execute permission (for example after a manual unzip) | Repair. An installation from the update repository never needs it. |
| Your web browser, through `explorer.exe` (Windows), `open` (macOS) or `xdg-open` (Linux) | Only when you click **by CaeloWorks** in a window header | Opens the product page, <https://pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp>. |

No shell is used, and nothing else is ever started.

### Files

Nothing is written inside the PixInsight installation. `<home>` is your user folder
(`C:/Users/<you>` on Windows, `/Users/<you>` on macOS, `/home/<you>` on Linux).

| What | Where | Size and cleanup |
|---|---|---|
| Logs | `<home>/CaeloWorks/DistributedWBPP/logs/`: `server-*.log` and `client-*.log` (one per session), `sidecar-agent.log` and `sidecar-worker.log` (rewritten each session) | A few kB to a few MB per session. Never deleted automatically; delete them whenever you like. |
| Client cache | `<home>/CaeloWorks/DistributedWBPP/client-cache/` (clients only) | The frames, masters and results the server sends during a session. It can reach the size of the client's share of the data being processed, so plan free space on that order. Emptied when the client starts and when you click **Leave client mode**. |
| Exchange files | `wbpp-*` files in the system temporary folder | Small request and result files between PixInsight and the sidecar, deleted right after use. |
| Downloaded results (server) | `wbpp-*` folders in the system temporary folder | Results fetched from the clients before WBPP takes them into its output folder. Deleted at the end of the session. |
| Cluster key | PixInsight settings, key `DistributedWBPP/clusterKey` | Kept until you replace it with **New key**. While the sidecar starts, the key is handed to it through a short-lived file in `<home>/CaeloWorks/DistributedWBPP/`, which the sidecar deletes at once. |

WBPP's own outputs go where WBPP puts them, exactly as in a normal run.

### How the server uses WBPP

The server runs the WBPP installed with your PixInsight. To distribute the work, it
adapts the running WBPP engine **in memory only**, for the duration of the session: no
WBPP file is modified, and nothing persists after you close the script. If anything is
unexpected (a WBPP version the script does not know, no client found, a client error), the
affected work runs locally, as in a normal WBPP run.

---

<details>
<summary><b>🛠 Development</b> — build, CI, packaging contract, WBPP compatibility, limits</summary>

### Repo layout

| Path | What |
|---|---|
| `sidecar/` | Go companion: discovery (signed UDP multicast), transfer (mutual TLS, signed requests), control plane, whole-job leasing |
| `pjsr/DistributedWBPP.js` | Single entry: pick **Server** (native WBPP + shim) or **Client** (worker) |
| `pjsr/lib/` | `SidecarBridge` (PJSR↔sidecar), `WBPPShim` (the monkey-patch), `WorkerRuntime` (client loop), `ProcessSerializer`, `FileLogger` |
| `pjsr/assets/DistributedWBPP.svg` | Menu icon (`#feature-icon`) |
| `scripts/build-sidecar.sh` | Cross-compile the sidecar for win/linux/mac |
| `scripts/build-update-package.sh` | Emit the release artifact (`dist/` zip + `update-package.json`) for the shared update repo |
| `docs/` | Architecture, WBPP research, status, [support KB](docs/support-kb.md) (user-facing: install, usage, troubleshooting — kept current at every release) |

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
| `DistributedWBPP-<version>.zip` | the package, tree **relative to PixInsight's install dir** (extracted verbatim by the updater): `src/scripts/CaeloWorks/DistributedWBPP/{DistributedWBPP.js, DistributedWBPP.svg, lib/*.js, bin/wbpp-sidecar-*}`. The menu icon ships **beside the entry script** — that is where PixInsight resolves `@script_icons_dir` for third-party scripts. The WBPP `#include` is rewritten to the portable `../../BatchPreprocessing/`. |
| `update-package.json` | metadata the site needs to emit this package's `<package>` element: `name, slug, version, fileName, sha1, type, releaseDate, piVersionRange, title, descriptionHtml`. |

- **Reproducible zip.** Entries are sorted, mtimes pinned to 1980-01-01, permissions
  fixed (`0755` for `bin/`, `0644` otherwise) — identical content yields an identical
  SHA-1, so the site authenticates the package by the `sha1` in the JSON.
- **`fileName` is relative** to the repository base URL (served from `…/update/<fileName>`).
  No absolute GitHub URLs enter the index.
- **Signature.** The release zip carries no per-script signature (`.xsgn`): the
  `<Signature developerId=…>` of the aggregated `updates.xri`, applied by the site with the
  Caelo Works CPD identity, covers the package through its `sha1`.
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

<sub>Made by <a href="https://caelo.works/en">CaeloWorks</a> · GPL-3.0 License</sub>

<sub>PixInsight is a registered trademark of Pleiades Astrophoto, S.L. CaeloWorks is an independent third-party developer.</sub>

</div>
