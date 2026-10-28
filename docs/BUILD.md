# Building QGIS for WebAssembly

Everything here runs on Linux x86-64. Budget about an hour for the dependencies on a 32-core machine (Qt itself is
minutes; most of it is qtdeclarative's host tools) and about 25 minutes for QGIS; an incremental C++ change under
`src/app` rebuilds in about 3 minutes. Disk: ≈ 40 GB for toolchains, dependencies and the build tree.

## Prerequisites

`git`, `cmake` (vcpkg brings a newer one), `ninja`, `python3`, `flex`, `bison`, `pkg-config`, `curl`, `zip`,
`unzip`, `tar`, a C/C++ compiler for the host tools (gcc or clang), and Node.js ≥ 18 for the local server, the
tests and the bundle compression. Playwright (`pip install playwright`) and a local Google Chrome ≥ 137 for the e2e
suites (`CHROME=/path/to/chrome` overrides the default `/usr/bin/google-chrome`).

## Steps

```bash
git clone --recurse-submodules https://github.com/eggachecat/qgis-wasm.git qgis-wasm && cd qgis-wasm
scripts/bootstrap.sh          # emsdk 6.0.10 + vcpkg at the pinned commit, under build/
scripts/apply-patches.sh      # patches/qgis-wasm.patch onto external/QGIS (upstream tag final-4_2_3)
scripts/build-deps.sh         # vcpkg install with the triplet wasm32-emscripten-qt-threads (Qt 6.11, GDAL, PROJ, GEOS, …)
scripts/build-qgis.sh         # cmake configure + ninja → build/qgis/output/bin/
node scripts/serve.mjs --port 8123    # COOP/COEP headers, range requests, .br/.gz sidecars, /mcp, /proxy
```

`scripts/build-qgis.sh [configure|build|all]` — `build` alone is the incremental path. The build ends with
`scripts/compress-bundle.mjs`, which writes the `.br` / `.gz` sidecars that make the first load ≈ 34 MB instead of
≈ 160 MB, and copies the web page next to `qgis.js` (`web/shell`, or `web/minimal` on the minimal branch). After a
change under `web/`, `scripts/stage-web.sh` refreshes the page files in the bundle (`--internal` / `--oss` picks the
deployment overlay or the plain variant).

## What the build consists of

```
emsdk 6.0.10 ──┐
vcpkg          ├─ triplet wasm32-emscripten-qt-threads (-pthread, wasm exceptions, release only)
               │   ├─ qtbase[widgets,opengl,gles3,network,sql-sqlite,…] + x64 host tools (moc, uic, rcc, lrelease)
               │   ├─ qtdeclarative qtsvg qtmultimedia[widgets] qttools qt5compat qtkeychain
               │   ├─ gdal proj geos sqlite3 libspatialindex expat libzip protobuf zstd exiv2 freetype gsl
               │   └─ qscintilla, libb2, json-c, libspatialindex: overlay ports in build/vcpkg-ports (CMake builds)
               ▼
external/QGIS (submodule) + patches/qgis-wasm.patch
   cmake -DWITH_GUI=ON -DWITH_DESKTOP=ON -DWITH_ANALYSIS=ON -DFORCE_STATIC_LIBS=ON -DWITH_QTPRINTER=OFF -DWITH_AUTH=OFF …
   → libqgis_core.a libqgis_analysis.a libqgis_gui.a libqgis_app.a + providers + C++ plugins (static)
   → qgis.js + qgis.wasm (≈ 134 MB, function names kept) + qgis.data (QGIS resources, PROJ data, fonts, demo project)
```

The patch (`patches/qgis-wasm.patch`) holds every change to QGIS: the CMake of the wasm executable
(`cmake/QgisWasmApp.cmake`: Emscripten options, preloaded data, JSPI, static plugins, Qt finalisation), guards for
what the browser lacks (SSL, processes, sockets, DBus), static linking of providers and plugins, and the browser
hooks in `src/app/qgswasm*.{h,cpp}` that `main.cpp` calls. Change QGIS in `external/QGIS`, build, then run
`scripts/export-patches.sh` and commit the patch.

## Knobs

| Setting | Meaning |
|---|---|
| `QGIS_WASM_BUILD_TYPE=Release` (default) / `Debug` | environment variable for `build-qgis.sh` |
| `-DQGIS_WASM_NESTED_LOOPS=jspi` (default) / `asyncify` / `none` | how `QDialog::exec()` suspends: JSPI needs Chrome / Edge ≥ 137 or Safari 27; Asyncify works in older browsers at a size and speed cost |
| `-DQGIS_WASM_PROFILING_FUNCS=OFF` | drop function names from the wasm (≈ 15 MB smaller, unreadable stacks) |
| `-DQGIS_WASM_STATIC_PLUGINS=…` | which upstream C++ plugins to link in (Topology Checker and Geometry Checker by default) |
| `-DQGIS_WASM_LAZY_FILES=src@vfs-path;…` | large resources kept out of `qgis.data` and downloaded on first read (`world_map.gpkg` by default) |
| `QGIS_WASM_SHELL_DIR=…` | the page directory copied next to `qgis.js` (default `web/shell`, or `web/minimal` when that is all the checkout has) |
| `-DCMAKE_CXX_FLAGS=-ffile-prefix-map=<checkout>=.` (and `CMAKE_C_FLAGS`) | strip the absolute checkout path from the strings compiled into `qgis.wasm` (`__FILE__` in log and assert messages); the dependencies built by `build-deps.sh` keep their vcpkg paths unless rebuilt the same way |

Pass CMake options through `scripts/build-qgis.sh configure -D…`.

## Running it

- The browser needs **WebAssembly JSPI** (nested event loops) and **SharedArrayBuffer** (threads). The second needs
  the headers `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless` on the page
  — `scripts/serve.mjs` and `deploy/nginx-qgis.conf` send them; on a static host `web/shell/coi-serviceworker.js`
  adds them from a service worker and the page reloads once.
- When the browser is not on the build machine, forward the port (`ssh -L 8123:127.0.0.1:8123 <host>`) — a secure
  context is required for SharedArrayBuffer — or deploy behind HTTPS (`scripts/deploy.sh`).
- Emscripten's `qgis.js` fetches `qgis.wasm` and `qgis.data` with `fetch`; the loading page counts the bytes and, on a
  host that only has the `.gz` copies (GitHub Pages: files over 100 MB are refused), inflates them while streaming.

## Tests

```bash
node tests/layering.test.mjs      # the layering guard (QGIS never reads the page; the page uses window.qgis only; every tool name exists)
node tests/cloudfs-sign.test.mjs  # SigV4 signing
node tests/serve-shared.test.mjs  # serve.mjs --shared (page addressing, result ownership, proxy allow-list)
python3 tests/e2e/smoke.py        # startup, demo project rendering (pixel check), remote GeoJSON, a modal dialog
python3 tests/e2e/features.py     # the control surface, presets, mounts, sharing, plugins, Processing, MCP, query sources, the workspace, crash handling…
python3 tests/e2e/agent.py        # the Web Agent against a scripted mock model
python3 tests/e2e/warm.py         # cold vs warm start (cache policy)
python3 tests/e2e/minimal.py      # the minimal page (a bundle staged from web/minimal)
```

The e2e suites start `scripts/serve.mjs` on 8123 (or reuse the one listening there) and the mocks on 9123 / 9124.
Screenshots land in `docs/screenshots/`.
