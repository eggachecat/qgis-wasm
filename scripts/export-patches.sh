#!/usr/bin/env bash
# Export the local QGIS modifications (external/QGIS working tree vs. the pinned upstream commit)
# into patches/qgis-wasm.patch so they are tracked in this repository.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/external/QGIS"
git add -A -N . >/dev/null 2>&1 || true
git diff --binary HEAD > "$ROOT/patches/qgis-wasm.patch"
echo "wrote patches/qgis-wasm.patch ($(git diff --stat HEAD | tail -1))"
