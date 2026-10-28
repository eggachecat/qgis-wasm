#!/usr/bin/env bash
# Configure + build QGIS (core, analysis, gui, app, providers and the `qgis` wasm executable)
# against the vcpkg-built WebAssembly dependencies.  Usage: scripts/build-qgis.sh [configure|build|all] [ninja args]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/env.sh"
SRC="$ROOT/external/QGIS"
BUILD="$ROOT/build/qgis"
STEP="${1:-all}"; shift || true
BUILD_TYPE="${QGIS_WASM_BUILD_TYPE:-Release}"
INST="$VCPKG_INSTALLED/$VCPKG_TRIPLET"
# the web page copied next to qgis.js: the full shell (web/shell) or, on the minimal branch, web/minimal
if [ -d "$ROOT/web/shell" ]; then SHELL_DIR="$ROOT/web/shell"; LAZY_FLAG=(); else SHELL_DIR="$ROOT/web/minimal"; LAZY_FLAG=(-DQGIS_WASM_LAZY_FILES=); fi   # the minimal page has no on-demand file loader: everything in qgis.data
HOST_INST="$VCPKG_INSTALLED/x64-linux"

if [ "$STEP" = configure ] || [ "$STEP" = all ]; then
  cmake -S "$SRC" -B "$BUILD" -G Ninja \
    -DCMAKE_BUILD_TYPE="$BUILD_TYPE" \
    -DCMAKE_TOOLCHAIN_FILE="$VCPKG_ROOT/scripts/buildsystems/vcpkg.cmake" \
    -DVCPKG_CHAINLOAD_TOOLCHAIN_FILE="$ROOT/build/vcpkg-toolchains/qgis-wasm.cmake" \
    -DVCPKG_TARGET_TRIPLET="$VCPKG_TRIPLET" \
    -DVCPKG_INSTALLED_DIR="$VCPKG_INSTALLED" \
    -DVCPKG_MANIFEST_MODE=OFF \
    -DCMAKE_PREFIX_PATH="$INST" \
    -DQt6_DIR="$INST/share/Qt6" \
    -DQT_HOST_PATH="$HOST_INST" -DQT_HOST_PATH_CMAKE_DIR="$HOST_INST/share" \
    -DQt6LinguistTools_DIR="$HOST_INST/share/Qt6LinguistTools" \
    -DQT_LRELEASE_EXECUTABLE="$HOST_INST/tools/Qt6/bin/lrelease" \
    -DCMAKE_INSTALL_PREFIX="$ROOT/build/dist" \
    -DFORCE_STATIC_LIBS=ON -DENABLE_TESTS=OFF -DNATIVE_CRSSYNC_BIN=/bin/true \
    -DWITH_GUI=ON -DWITH_DESKTOP=ON -DWITH_ANALYSIS=ON \
    -DWITH_QTPRINTER=ON -DWITH_INTERNAL_QWT=ON -DWITH_QTWEBENGINE=OFF -DWITH_CRASH_HANDLER=OFF \
    -DWITH_PYTHON=OFF -DWITH_BINDINGS=OFF -DWITH_3D=OFF -DWITH_EXIV2=OFF -DWITH_PDAL=OFF -DWITH_DRACO=OFF \
    -DWITH_QTSERIALPORT=OFF -DWITH_QTPOSITIONING=OFF -DWITH_AUTH=OFF -DWITH_SPATIALITE=OFF \
    -DWITH_QGIS_PROCESS=OFF -DWITH_POSTGRESQL=OFF -DWITH_GRASS7=OFF -DWITH_CUSTOM_WIDGETS=OFF \
    -DWITH_SERVER=OFF -DWITH_APIDOC=OFF -DWITH_QUICK=OFF -DWITH_QSPATIALITE=OFF \
    -DWITH_INTERNAL_POLY2TRI=ON -DWITH_INTERNAL_SPATIALINDEX=OFF -DWITH_INTERNAL_LAZPERF=ON \
    -DQSCINTILLA_INCLUDE_DIR="$INST/include" -DQSCINTILLA_LIBRARY="$INST/lib/libqscintilla2_qt6.a" -DQSCINTILLA_VERSION_STR=2.14.1 \
    -DQGIS_WASM_PROJ_DATA_DIR="$INST/share/proj" -DQGIS_WASM_GLOBAL_SETTINGS="$ROOT/web/qgis_global_settings.ini" -DQGIS_WASM_SHELL_DIR="${QGIS_WASM_SHELL_DIR:-$SHELL_DIR}" "${LAZY_FLAG[@]}" -DQGIS_WASM_FONTS_DIR="$ROOT/web/fonts" -DQGIS_WASM_DEMO_DIR="$ROOT/web/demo" \
    -DQGIS_PLUGIN_SUBDIR=lib -DQGIS_INCLUDE_SUBDIR=include/qgis \
    "${QGIS_WASM_CMAKE_EXTRA[@]:-}"
fi
if [ "$STEP" = build ] || [ "$STEP" = all ]; then
  cmake --build "$BUILD" -- "$@"
  # pre-compressed .br/.gz sidecars of qgis.wasm / qgis.data / qgis.js: serve.mjs (or nginx brotli_static) then sends
  # ~40 MB instead of ~166 MB on first load; stale sidecars are ignored by the server, so this is safe to skip
  if command -v node >/dev/null 2>&1; then node "$ROOT/scripts/compress-bundle.mjs" --dir "$BUILD/output/bin" || echo "compress-bundle failed (non-fatal)"; fi
fi
