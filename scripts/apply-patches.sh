#!/usr/bin/env bash
# Apply patches/qgis-wasm.patch onto a clean external/QGIS checkout (after `git submodule update --init`).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/external/QGIS"
git apply --3way "$ROOT/patches/qgis-wasm.patch"
echo "applied"
