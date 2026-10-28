#!/usr/bin/env bash
# Fetch the pinned toolchains: emsdk (Emscripten) and vcpkg. Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMSDK_VERSION=6.0.10
VCPKG_COMMIT=9e593bb18ea69cc5095e012465dcd675a822ed0d   # 2026.07.29 release, same as qgis-js
mkdir -p "$ROOT/build"
if [ ! -d "$ROOT/build/emsdk/.git" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$ROOT/build/emsdk"
fi
( cd "$ROOT/build/emsdk" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" )
if [ ! -d "$ROOT/build/vcpkg/.git" ]; then
  git clone https://github.com/microsoft/vcpkg.git "$ROOT/build/vcpkg"
  git -C "$ROOT/build/vcpkg" checkout -q "$VCPKG_COMMIT"
fi
"$ROOT/build/vcpkg/bootstrap-vcpkg.sh" -disableMetrics
echo "toolchains ready"
