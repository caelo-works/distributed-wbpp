# Distributed WBPP — support knowledge base

Written for a **support agent**, not for a user. It is exhaustive on purpose: it states
what every window shows, what every message means, and what is actually broken or missing
today. Quote it, don't paraphrase it.

Four rules when you use it:

- **The interface is English-only**, but many users write in French. They will say
  « client », « serveur », « le PC qui pilote ». Always give them back the **exact English
  button and menu names** listed here, so they can find them on screen.
- **Never invent a figure.** In particular: **no official speedup number is published.**
  Never promise "×2" or any multiplier. Explain what the gain depends on, and escalate if
  the user insists on a figure.
- **Never invent a path, a port or a version compatibility.** If it is not written here,
  say you don't know and escalate.
- **A distributed run can never produce a silently wrong result** — every failure falls
  back to a normal local WBPP. When a user is scared about their data, that is the line to
  hold, and it is true.

Applies to **plugin 1.8.0**. To check the user's version: the **title bar of the first
window** ("Distributed WBPP  [build …]") shows the build, and the installed version is
listed in **Resources → Updates**.

---

## 1. The facts card

| | |
|---|---|
| What it is | A PixInsight script that runs the **native WBPP** across several PixInsight machines on the same local network |
| Version | 1.8.0 · GPL-3.0 · free and open source |
| Requires | **PixInsight 1.9.4 or newer**, with **WBPP 3.0.1** — the same versions on **every** machine |
| Platforms | Windows, macOS, Linux — including a mix of them in the same cluster |
| Where it lives | **Script → CaeloWorks → Distributed WBPP** |
| Install it on | **Every** machine of the cluster, server and helpers alike |
| Licences | Every machine runs a real, licensed PixInsight. The plugin does not replace PixInsight. |
| Network | Plain LAN. **No shared folder, no NAS, no manual IP address.** Nothing leaves the local network; no internet needed. |
| Repository | https://github.com/caelo-works/distributed-wbpp |
| Product page | https://pixinsight-scripts.caelo.works/en/scripts/distributed-wbpp |

**The mental model.** One machine is the **Server**: the user drives the real WBPP dialog
on it, exactly as usual. The other machines are **Clients**: they run the same script,
click "Client", and leave the window open. The server splits the heavy work across the
clients and collects the results.

**The one thing that changes in the user's habits:** starting the script in **Client** mode
on the other PCs before launching the run. Everything else — frames, settings, output
folder — is stock WBPP.

---

## 2. Installing it

The plugin must be installed on **every** machine of the cluster, server and clients.

### Route A — the CaeloWorks update repository (recommended)

1. **Resources → Updates → Manage Repositories**
2. Add `https://pixinsight-scripts.caelo.works/update/`
3. **Resources → Updates → Check for Updates**, accept, **restart PixInsight**.

Updates then arrive through the same channel automatically.

> **"Unsigned repository" warning.** Expected. The repository is not CPD-signed yet;
> signing is underway. Tell the user it is safe to accept, and that this is a signature on
> the *repository*, not a virus warning.

### Route B — manual

Download `DistributedWBPP-<version>.zip` from the
[Releases](https://github.com/caelo-works/distributed-wbpp/releases) and extract it **into
the PixInsight installation directory**, so the files land as:

```
<PixInsight>/src/scripts/CaeloWorks/DistributedWBPP/
    DistributedWBPP.js
    DistributedWBPP.svg
    lib/
    bin/          <- the network companion, one binary per OS
```

Restart PixInsight. The `bin/` folder is **not optional** — without it the script starts
and then says the sidecar was not found.

### "I installed it and I don't see it in the menu"

Almost always one of:

- **PixInsight was not restarted** after the install/update.
- The user is looking in the wrong place: it is **Script → CaeloWorks → Distributed
  WBPP**. It was moved into the **CaeloWorks** submenu in version 1.8.0 — a user upgrading
  from an older build may be looking under the previous location.
- Manual install extracted to the wrong folder: the tree must end up under
  `<PixInsight>/src/scripts/`, not in a random directory.

### "The menu entry has a generic gear icon"

Cosmetic only, the script works. It means the user is on a version **older than 1.8.0**, or
the `DistributedWBPP.svg` file was not extracted next to `DistributedWBPP.js`. Reinstalling
1.8.0 or later fixes it.

---

## 3. Running it — the correct sequence

### 3.1 The order matters, and it is the number-one mistake

1. **On each helper PC first:** **Script → CaeloWorks → Distributed WBPP** → click
   **"Client — help"**. Leave that window open.
2. **Then on the driving PC:** same script → click **"Server — drive WBPP"**.
3. A small **Distributed WBPP — Server** dashboard opens, then the **native WBPP dialog**.
4. The user configures WBPP as usual and clicks **Run**.

**The server looks for clients when it starts, not during the run.** A client started
*after* the server will **not** join. If a user reports "my second PC does nothing", the
first question is always: *was the client window already open before you launched the
server?*

### 3.2 The three windows

- **Role picker** — opens on every machine. Two buttons: **"Server — drive WBPP"** and
  **"Client — help"**. The title bar shows the build number.
- **Server dashboard** — opens next to WBPP on the server. Shows the connected clients, a
  timestamped event log, and a **"Distributed steps: N"** counter. It is non-modal:
  **closing it does not stop the run.**
- **Client window** — on each helper. Header **"Client active. Waiting for work from the
  server…"**, an event log, and a status bar: **"Jobs: N · Frames processed: N · Errors:
  N"**. The **"Leave client mode"** button quits.

### 3.3 What a healthy run looks like

On the **server dashboard**, right at the start:

> `Cluster ACTIVE — 2 client(s); heavy steps will be distributed.`

Then, during the run, lines like:

> `Group LIGHT-Ha : 60 frame(s) — 34 local ∥ 26 cluster`
> `✓ registration : server 34 in 210.4s ∥ cluster 26 in 198.1s`

On the **client window**:

> `Received: registration — 26 frame(s)`
> `✓ registration : 26 frame(s) en 3m 18s`

(The client line really does say "en" — a leftover French word in the 1.8.0 build. It is
cosmetic, not an error.)

In **WBPP's own Execution Monitor**, distributed steps are tagged **`[cluster]`** in the
status column. That tag is the proof the work was really distributed.

---

## 4. What is distributed, what stays local, and how fast it gets

### 4.1 Distributed across the cluster

- **Calibration** of lights, flats and darks
- **Measurements** (the SubframeSelector metrics WBPP uses to weight frames)
- **Registration** (star alignment)
- **Local Normalization** (the `.xnml` files)
- **Calibration master integrations** — master bias, master dark, master flat
- **The Local Normalization reference**
- **The final light integration**, one per filter
- **Drizzle integration**, one per filter

### 4.2 Stays on the server — and that is deliberate

- **Autocrop** — it is a single global crop computed as the *intersection* across all
  filters. Splitting it would break inter-filter alignment.
- **The astrometric solution** — it depends on the star catalogue installed on each
  machine.
- **Cosmetic Correction** — not distributed yet.
- **Debayer (OSC users)** — not distributed yet. OSC users still get everything else
  distributed; this step just runs on the server.

### 4.3 Never distributed (falls back to local, silently and correctly)

- Groups of **fewer than 3 frames**
- **FastIntegration** groups and the **RGB-combine** group
- Anything **served from WBPP's cache** — a re-run of the same job computes nothing, so
  there is nothing to distribute. This is a very common "it didn't distribute anything!"
  report: the user re-ran an already-cached job.

### 4.4 How much faster — never promise a number

**No official speedup figure is published. Do not quote one.** What to tell a user, and
what actually drives the gain:

- The gain is real on **large datasets**; on a handful of frames the network transfer can
  eat the benefit entirely.
- **Wired gigabit** is strongly recommended. Frames are hundreds of megabytes; a client on
  **Wi-Fi** will be measured as slow, automatically receive a small share, and contribute
  little.
- The **server's upload link is the ceiling**: it must push frames to every helper. Adding
  more machines keeps helping, with diminishing returns.
- The steps that stay local (autocrop, astrometry, cosmetic correction, debayer) set a hard
  floor on the total time, no matter how many machines are added.
- A **slow helper is never a problem**: the split adapts to each machine's measured speed,
  so a weak PC just gets fewer frames.

If a user asks "how much faster will it be for me?", the honest answer is: *it depends on
your dataset and your network, and we don't publish a number we couldn't stand behind — try
it on a real run and compare.*

---

## 5. Network, discovery and the firewall

Machines find each other **automatically**. There is nothing to configure, no IP address to
type, no shared folder to mount. If discovery fails, it is almost always the firewall or
the network layout.

### 5.1 What it needs from the network

- All machines on the **same LAN subnet**. Discovery uses **UDP multicast**, which does not
  cross subnets, VLANs or a guest Wi-Fi network.
- The companion program (`wbpp-sidecar`) must be able to **receive inbound connections** on
  a port the operating system assigns at random each run.
- Frames travel over plain HTTP on the LAN, each file verified with a checksum. **Nothing
  goes to the internet.**

### 5.2 The firewall rule — the most common blocker

On Windows, the first launch normally raises the standard **Windows Defender Firewall**
prompt. The user **must click "Allow access"**, on **Private** networks. If it was denied
once, or if company policy blocks it, the rule has to be created by hand — and it must
target **the program, not a port** (the port changes every run):

Allow inbound **TCP and UDP**, on **Private** networks, for:

```
<PixInsight>\src\scripts\CaeloWorks\DistributedWBPP\bin\wbpp-sidecar-windows-amd64.exe
```

On **macOS**, allow the binary if the application-firewall prompt appears. On **Linux**,
there is usually nothing to do; if `ufw` is active, it must let the sidecar receive
connections.

**Symptom of a firewall block:** the clients look perfectly healthy and say they are
waiting, but the server says **"no workers discovered"** and runs locally.

### 5.3 Things that silently break discovery

- A client on a **different subnet / VLAN / guest Wi-Fi** — it will never be seen.
- **Multicast filtered** by a managed switch or a Wi-Fi access point (IGMP snooping
  misconfigured). Test by putting both machines on the same wired switch.
- A **VPN client** on one of the machines capturing the routes.
- **Mismatched plugin versions** between machines — always make sure every PC runs the same
  plugin version.

---

## 6. Versions — everything must match

### 6.1 The rule

Every machine of the cluster must run **the same PixInsight version** and **the same WBPP
version**. This is checked automatically before any work is sent. A single machine on a
different build is enough for it to be refused, and the run then happens locally on the
server.

This strictness is on purpose: different versions could produce different pixels, and a
silently wrong master is worse than no speedup.

### 6.2 What is supported

- **PixInsight 1.9.4 + WBPP 3.0.1** → use plugin **1.1.0 or newer** (current: 1.8.0).
  Verified: full run distributed, outputs pixel-identical to a local-only run.
- **PixInsight 1.9.3 + WBPP 2.9.1** → use plugin **1.0.0 only**. Plugin 1.0.1 and later do
  **not** load on that generation.
- **Any other PixInsight or WBPP version** → the plugin loads, refuses to distribute, and
  runs a **normal local WBPP**. This is expected behaviour, not a bug.

The script also refuses to start at all below **PixInsight 1.9.4** (PixInsight shows its own
minimum-version error).

### 6.3 Mixing Windows, macOS and Linux in one cluster

**Supported.** All three are validated, including a Windows server driving macOS and Linux
helpers.

One honest caveat to give the user: results are **bit-for-bit identical** when every machine
runs the **same OS**. **Across different OSes** they are **numerically equivalent but not
bit-identical** — PixInsight's math libraries differ slightly per platform, so a few pixels
sitting exactly on a rejection threshold can be clipped on one OS and kept on another. The
measured difference is thousands of times below the noise: astronomically insignificant.

**Support line:** *"Mixing operating systems is supported and your data is fine. If you
need strictly reproducible, bit-identical results between runs, use machines with the same
OS."*

---

## 7. Error messages and warnings — exact text

The user will copy-paste these. Here is what each one really means.

### 7.1 Messages that stop the script

- **"Sidecar not found next to the script."** (followed by the paths it tried)
  The `bin/` folder is missing from the install. The zip was extracted incompletely or to
  the wrong place. Reinstall.
- **"Could not start the sidecar: …"** (client)
  The companion binary exists but cannot run: wrong OS binary, missing execute permission,
  or blocked by security software. Reinstall; on macOS/Linux check the file is executable;
  check the antivirus quarantine.
- A **PixInsight minimum-version error at launch** — the machine runs PixInsight older than
  **1.9.4**. Upgrade PixInsight, or use plugin **1.0.0** on the 1.9.3 generation.

### 7.2 Messages that mean "it will run locally" (the run is fine)

- **"Cluster inactive (no workers discovered) — WBPP runs locally."**
  No client was found. See the firewall / discovery causes: client not started before the
  server, client window closed, firewall, different subnet.
- **"Cluster inactive (unsupported WBPP version X) — WBPP runs locally."**
  That WBPP version is not in the verified compatibility table. **By design.** The plugin
  refuses to distribute on an unverified WBPP rather than risk a wrong master.
- **"Clients: none (WBPP will run locally)"** on the dashboard — same thing.
- In PixInsight's console: **"** Distributed-WBPP: no clients discovered; running
  locally."**, **"** Distributed-WBPP: WBPP … not in the compatibility table; running
  locally."**, or **"** Distributed-WBPP: sidecar failed (…). Local WBPP."**
  All three mean: **WBPP ran normally, on this machine only.** The result is correct.

### 7.3 Warnings during a distributed run (the result is still correct)

These appear in the server dashboard. **They are performance warnings, never data
warnings** — the work was recomputed on the server:

- **"⚠ … local fallback (…)"** — that step could not be distributed and ran locally.
- **"✗ … failed (…) — local fallback"** — same thing.
- **"⚠ cluster failed (…) — N frame(s) locally"** — the cluster part of a group failed; the
  server did those frames itself.
- **"⚠ … : N output(s) missing — running locally"** — some results never came back; they
  were recomputed. **No frame is ever lost.**

On the **client** window:

- **"✗ Failed job <id>: <message>"** — that job was re-run on the server. The message names
  the real cause (disk full, a frame PixInsight itself refused, out of memory on that
  machine). The **"Errors: N"** counter counts these.

Repeated fallbacks are worth escalating — the run is correct, but something is wrong.

---

## 8. Known bugs and limitations — read before answering

### 8.1 A client must be started BEFORE the server

The server looks for helpers **when it opens WBPP**, not continuously. A client launched
after the run has started is **not** picked up, and never will be for that run.
**Workaround:** start every client first, then the server. Not a bug — but it is the single
most common cause of "my other PC does nothing".

### 8.2 Server and client on the same PC is not supported

One role per machine. Running both on the same computer breaks the companion program (both
roles use the same local control channel, and starting one clears the other's). There is no
benefit anyway: the server already uses its own CPU for its share of the work. **If a user
did this, tell them to pick one role per machine.**

### 8.3 Only one cluster per network at a time

Two people running a distributed WBPP on the same LAN at the same time will **compete for
the same helper machines** — there is no way to separate two clusters today. **Workaround:**
run one at a time.

### 8.4 Cosmetic Correction and Debayer are not distributed

They run on the server. OSC users get every other step distributed, but their debayer stage
is not accelerated. Planned, not available in 1.8.0. **Do not tell a user it should be
distributed.**

### 8.5 Autocrop and the astrometric solution stay on the server

Deliberate, and it will not change: autocrop is one global crop across all filters
(distributing it would break inter-filter alignment), and plate solving depends on the star
catalogue installed on each machine. These steps set a floor on the total run time.

### 8.6 Nothing is distributed on a cached re-run

If the user re-runs a job WBPP already has in cache, no work is computed, so nothing is
distributed and the dashboard stays empty. **This is not a failure.**

### 8.7 The companion binary is not code-signed

It is a small unsigned executable that opens network sockets — a classic **antivirus false
positive**, and on macOS it can raise a security prompt (in practice Gatekeeper does not
block it, because PixInsight launches it directly). Users can allow-list
`…/CaeloWorks/DistributedWBPP/bin/wbpp-sidecar-*`. Code signing is on the roadmap.

### 8.8 The helpers' temporary folder is not cleaned automatically

Each client stores the frames it receives in a temporary working folder, and it is **not
purged between runs**. On a machine short on disk space it can grow. It is safe to empty it
**when no run is in progress**. The client window prints the exact path on startup
("Client started — waiting for the server (data: …)").

### 8.9 The client log says "en" instead of "in"

Cosmetic leftover in the 1.8.0 build: a completed job reads
`✓ registration : 26 frame(s) en 3m 18s`. Harmless, no action needed.

---

## 9. Troubleshooting — symptom → cause → answer

### 9.1 Nothing is being distributed

| The user says | It means | Tell them |
|---|---|---|
| *"Cluster inactive (no workers discovered)"* | No helper was found | In order: was the **client window opened before the server**? Is it still open? Was the **firewall prompt accepted** on every machine? Are all PCs on the **same subnet** (not a guest Wi-Fi, not a VLAN)? |
| *"Cluster inactive (unsupported WBPP version …)"* | This WBPP is not verified | By design — it runs a normal local WBPP rather than risk a wrong master. Ask for the exact WBPP version and escalate. |
| "The clients are seen but never receive anything" | Usually the **version handshake**: PixInsight or WBPP versions differ between machines | Compare PixInsight (**Help → About**) and WBPP versions on every machine. They must be **identical**. |
| "The dashboard stays empty, nothing happens" | The job is **served from WBPP's cache** — nothing to compute | Have them run a job that actually recomputes something. |
| "My second PC does nothing" | Client started after the server | Quit everything, start the client(s) first, then the server. |

### 9.2 It runs, but not faster

| The user says | It means | Tell them |
|---|---|---|
| "It's barely faster" | Small dataset, or Wi-Fi, or the server's upload is saturated | Explain the factors (see below). **Do not promise a multiplier — no official figure exists.** |
| "My helper is on Wi-Fi" | Frames are hundreds of MB | Wired gigabit is strongly recommended; the helper's share is automatically reduced when it is measured as slow, so it will contribute little. |
| "Adding a third PC changed almost nothing" | The **server's upload link** is the ceiling — it must push the frames to every helper | Expected. Diminishing returns are inherent to the design. |
| "The whole run still takes ages at the end" | **Autocrop and the astrometric solution stay on the server** by design | These steps are not distributed and set a floor on the total time. |

### 9.3 Warnings and errors during the run

| The user says | It means | Tell them |
|---|---|---|
| *"I see ⚠ local fallback lines"* | A step could not be distributed and was recomputed on the server | **The result is correct.** It is a performance warning, not a data warning. If it repeats, collect the logs and escalate. |
| *"The client shows Errors: N"* | Those jobs were re-run on the server | The run is still correct. Ask for the client log: the line `✗ Failed job …` names the real cause (disk full, out of memory, a frame PixInsight refused). |
| "I closed a client during the run" | Its jobs are recomputed on the server | Nothing is lost; the run completes correctly, just without that helper. |
| "A client PC crashed / was unplugged" | Same | Same: recomputed on the server, no data loss. |
| *"Sidecar not found next to the script"* | The `bin/` folder is missing | Reinstall — the whole zip tree must be extracted into the PixInsight install directory. |
| "PixInsight warns about an unsigned repository" | Expected — the repo is not CPD-signed yet | Safe to accept. It is a signature on the repository, not a virus warning. |
| "My antivirus flagged wbpp-sidecar" | Unsigned executable that opens sockets — classic false positive | Allow-list `…/CaeloWorks/DistributedWBPP/bin/wbpp-sidecar-*`. |

---

## 10. "Is my data safe?" — what you can promise

These are guarantees the design actually enforces. State them plainly:

- **A distributed run never produces a silently wrong result.** Unverified WBPP version,
  missing client, network error, a helper that crashes or is unplugged, a timeout, a
  version mismatch → the work is **recomputed on the server**, and the run continues.
- **Every file transferred is checksum-verified.** A corrupt or missing result is
  recomputed locally rather than accepted.
- **It does not modify WBPP, and it does not touch the user's files.** It runs the WBPP
  installed on the machine; WBPP writes its output exactly where the user configured it.
- **It has been validated bit-for-bit.** On same-OS clusters, the masters produced by a
  distributed run are bit-identical to those of a local-only run. Across different OSes
  they are numerically equivalent (see the mixed-OS caveat).
- **Nothing leaves the local network.** No cloud, no telemetry, no internet connection
  required.
- **Worst case is always "no speedup", never "wrong data".**

---

## 11. Escalating

**Stop and escalate — do not improvise — when:**

- The user reports **wrong pixels, a corrupt master, or a result that differs from a local
  run** on the *same* OS. That would contradict a core guarantee; it must be looked at.
- The dashboard says **"unsupported WBPP version X"** — a new WBPP came out and needs to be
  validated. Take the version number and pass it on.
- **Fallback warnings repeat** on every run (the results are correct, but something is
  wrong).
- Anything about **crashes, data loss, or a behaviour not described in this document**.
- Anything about **purchases, licences or refunds** — the plugin is free and open source,
  but PixInsight itself is not, and licensing is not ours to answer.

**Collect these before escalating. Without them the report is not actionable:**

1. The **plugin version**, the **PixInsight version** and the **WBPP version** — **for
   every machine** of the cluster (they must match, and that is often the answer).
2. The **operating system of every machine**.
3. The **logs**, from this folder on each machine:
   `<PixInsight>/src/scripts/CaeloWorks/logs/` — send the `server-*.log` from the server,
   the `client-*.log` from each helper, plus `sidecar-agent.log` / `sidecar-worker.log` if
   present. The client window and the server dashboard both print their log path on
   startup.
4. The **WBPP console output** (PixInsight's Process Console) — especially any line of the
   form `N succeeded, M failed`.
5. The **dataset shape**: number of frames, filters, mono or OSC, drizzle on or off.
6. **Whether a local-only run of the same job works** — this separates a distribution bug
   from a WBPP or data problem, and it is always worth asking.

File issues at https://github.com/caelo-works/distributed-wbpp/issues.
