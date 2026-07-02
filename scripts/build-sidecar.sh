#!/usr/bin/env bash
# Cross-compile the wbpp-sidecar into fully static, dependency-free binaries for
# every OS in the cluster. CGO is disabled so each binary is self-contained and
# needs no runtime installed on the target machine (a hard project requirement).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/sidecar"
OUT="$ROOT/bin"
mkdir -p "$OUT"

# version stamp (git tag/sha if available, else "dev")
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --always --dirty 2>/dev/null || echo dev)}"
LDFLAGS="-s -w -X main.buildVersion=${VERSION}"

# os/arch  ->  output filename
targets=(
  "windows/amd64 wbpp-sidecar-windows-amd64.exe"
  "linux/amd64   wbpp-sidecar-linux-amd64"
  "linux/arm64   wbpp-sidecar-linux-arm64"
  "darwin/amd64  wbpp-sidecar-darwin-amd64"
  "darwin/arm64  wbpp-sidecar-darwin-arm64"
)

echo "Building wbpp-sidecar ${VERSION}"
for t in "${targets[@]}"; do
  read -r osarch name <<<"$t"
  GOOS="${osarch%/*}"; GOARCH="${osarch#*/}"
  echo "  -> $GOOS/$GOARCH  $name"
  ( cd "$SRC" && CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" \
      go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$name" . )
done

echo "Done. Artifacts in $OUT:"
ls -lh "$OUT"
