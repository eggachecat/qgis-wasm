# source this: toolchain environment for qgis-wasm builds
export QGIS_WASM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
export EMSDK_QUIET=1
source "$QGIS_WASM_ROOT/build/emsdk/emsdk_env.sh" >/dev/null 2>&1 || { echo "emsdk missing: run scripts/bootstrap.sh" >&2; return 1 2>/dev/null || exit 1; }
export VCPKG_ROOT="$QGIS_WASM_ROOT/build/vcpkg"
export VCPKG_TRIPLET=wasm32-emscripten-qt-threads
export VCPKG_INSTALLED="$QGIS_WASM_ROOT/build/wasm/vcpkg_installed"
# vcpkg ships its own (newer) cmake once bootstrapped; until then this file must still return 0 (callers run under set -e)
CMAKE_BIN="$(ls -d "$VCPKG_ROOT"/downloads/tools/cmake-*/*/bin 2>/dev/null | head -1 || true)"
if [ -n "$CMAKE_BIN" ]; then export PATH="$CMAKE_BIN:$PATH"; fi
# ...and its own ninja (vcpkg's cmake downloads do not depend on a system ninja)
NINJA_BIN="$(ls -d "$VCPKG_ROOT"/downloads/tools/ninja-*/ 2>/dev/null | head -1 || true)"
if [ -n "$NINJA_BIN" ]; then export PATH="$NINJA_BIN:$PATH"; fi
# host tools built into build/local by scripts (flex: QGIS' lexers need it and the host may not ship it)
if [ -d "$QGIS_WASM_ROOT/build/local/bin" ]; then export PATH="$QGIS_WASM_ROOT/build/local/bin:$PATH"; fi
:
