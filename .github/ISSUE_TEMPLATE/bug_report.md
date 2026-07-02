---
name: Bug report
about: Something went wrong during a distributed run
title: ""
labels: bug
---

**What happened**
A clear description of the bug, and what you expected instead.

**Environment (must match on every node)**
- PixInsight version:
- WBPP version:
- OS of each node (Windows/macOS/Linux + arch):
- Cluster size (server + how many clients):
- Distributed WBPP version:

**Steps to reproduce**
1.
2.

**Logs**
Attach the relevant logs from `logs/` next to the script (server and/or client), and the
cluster lines from WBPP's process console (e.g. `✓ calibration : server … ∥ cluster …`,
or any `⚠`/`✗` fallback line).

**Did it fall back to local WBPP?**
- [ ] Yes — a warning was shown and WBPP ran locally
- [ ] No — it distributed but the result/behavior was wrong
