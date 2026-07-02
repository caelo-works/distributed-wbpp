#!/usr/bin/env bash
#
# build-update-package.sh <version> [releaseDate YYYYMMDD]
#
# Produces the standardized DISTRIBUTION ARTIFACT that the CaeloWorks showcase site
# (caelo-works/pixinsight-scripts, served at https://pixinsight-scripts.caelo.works/update/)
# ingests to build the shared, signed updates.xri. This repo does NOT generate or host the
# final updates.xri — it only emits, per release, two files under dist/:
#
#   dist/DistributedWBPP-<version>.zip   the package, tree RELATIVE TO PixInsight's install
#                                        dir (the updater extracts it verbatim):
#                                          src/scripts/CaeloWorks/DistributedWBPP/DistributedWBPP.js
#                                          src/scripts/CaeloWorks/DistributedWBPP/lib/*.js
#                                          src/scripts/CaeloWorks/DistributedWBPP/bin/wbpp-sidecar-*
#                                          rsc/icons/script/DistributedWBPP/DistributedWBPP.svg
#   dist/update-package.json             metadata the site needs to emit the <package> xri
#                                        element (name, version, fileName, sha1, ...).
#
# The zip is REPRODUCIBLE (sorted entries, fixed mtimes/permissions) so identical content
# always yields the same SHA-1 — the site authenticates the package by that SHA-1.
#
set -euo pipefail

VERSION="${1:?usage: build-update-package.sh <version> [releaseDate YYYYMMDD]}"
RELEASE_DATE="${2:-$(date +%Y%m%d)}"

REPO="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
VENDORDIR="CaeloWorks/DistributedWBPP"
ZIPNAME="DistributedWBPP-${VERSION}.zip"
OUT="$REPO/dist"
STAGE="$( mktemp -d )"
trap 'rm -rf "$STAGE"' EXIT

DST="$STAGE/src/scripts/$VENDORDIR"
mkdir -p "$DST/lib" "$DST/bin" "$STAGE/rsc/icons/script/DistributedWBPP"
rm -rf "$OUT"; mkdir -p "$OUT"

# 1) entry script: the WBPP #include is made relative to the install dir. From
#    src/scripts/CaeloWorks/DistributedWBPP/ that is ../../BatchPreprocessing/ . Stamp version.
sed -e 's#__WBPPDIR__/#../../BatchPreprocessing/#g' \
    -e "s/__BUILD__/${VERSION}/g" \
    "$REPO/pjsr/DistributedWBPP.js" > "$DST/DistributedWBPP.js"

# 2) libs
cp "$REPO"/pjsr/lib/*.js "$DST/lib/"

# 3) sidecar binaries — EMBEDDED, all OSes (resolveSidecar picks <os>-<arch> at runtime).
#    See README "Sidecar: embedded, not downloaded" for the rationale.
cp "$REPO"/bin/wbpp-sidecar-* "$DST/bin/"

# 4) menu icon (#feature-icon @script_icons_dir/DistributedWBPP.svg)
cp "$REPO/pjsr/assets/DistributedWBPP.svg" "$STAGE/rsc/icons/script/DistributedWBPP/DistributedWBPP.svg"

# 5) reproducible zip: sorted entries, fixed mtime (1980-01-01), fixed perms
#    (0755 for bin/, 0644 otherwise). No OS/timestamp entropy -> stable SHA-1.
python3 - "$STAGE" "$OUT/$ZIPNAME" <<'PY'
import os, sys, zipfile, stat
stage, out = sys.argv[1], sys.argv[2]
files = []
for root, _, names in os.walk(stage):
    for n in names:
        full = os.path.join(root, n)
        arc = os.path.relpath(full, stage).replace(os.sep, "/")
        files.append((arc, full))
files.sort(key=lambda x: x[0])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for arc, full in files:
        zi = zipfile.ZipInfo(arc, date_time=(1980, 1, 1, 0, 0, 0))
        perm = 0o755 if "/bin/" in ("/" + arc) else 0o644
        zi.external_attr = (perm & 0xFFFF) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        with open(full, "rb") as f:
            z.writestr(zi, f.read())
PY

SHA1=$( sha1sum "$OUT/$ZIPNAME" | cut -d' ' -f1 )

# 6) metadata sidecar — exactly the contract the site ingests
cat > "$OUT/update-package.json" <<JSON
{
  "name": "Distributed WBPP",
  "slug": "distributed-wbpp",
  "version": "${VERSION}",
  "fileName": "${ZIPNAME}",
  "sha1": "${SHA1}",
  "type": "script",
  "releaseDate": "${RELEASE_DATE}",
  "piVersionRange": "1.9.0:1.9.99",
  "title": "Distributed WBPP v${VERSION}",
  "descriptionHtml": "<p>Distribute PixInsight's Weighted Batch Preprocessing (WBPP) across several PixInsight instances on your local network. One machine drives the native WBPP UI as usual, while the heavy per-frame steps (calibration, registration, local normalization, measurements) and calibration-master integrations are sharded to helper machines. Falls back to a normal local WBPP run when no helpers are found.</p>"
}
JSON

echo "dist/$ZIPNAME  ($(du -h "$OUT/$ZIPNAME" | cut -f1), sha1 $SHA1)"
echo "dist/update-package.json"
