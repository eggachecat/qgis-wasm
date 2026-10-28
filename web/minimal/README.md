# qgis-wasm (minimal) — the QGIS desktop application compiled to WebAssembly

This branch is the smallest useful cut of the project: everything needed to **build the upstream QGIS desktop
application (`qgis_core` + `qgis_analysis` + `qgis_gui` + `qgis_app`, the data providers, QGIS' own `main.cpp`) with
Emscripten and Qt 6.11 for WebAssembly**, and one static page that runs it in the browser. No cloud mounts, presets,
sharing links, MCP server or agent — those live on the [`main` branch](https://github.com/eggachecat/qgis-wasm), built on exactly this base.

What you get: the QGIS main window with its menus, panels, dialogs, symbology, Processing toolbox and the parallel map
renderer in Web Worker threads, painted onto a `<canvas>` by Qt's `qwasm` platform plugin; files are read by GDAL/OGR,
PROJ and GEOS compiled to wasm; `/home/web_user` is kept in IndexedDB between visits.

## Build

See [docs/BUILD.md](docs/BUILD.md) for prerequisites, timings and the knobs. In short (Linux x86-64):

```bash
git clone --recurse-submodules https://github.com/eggachecat/qgis-wasm.git qgis-wasm && cd qgis-wasm
scripts/bootstrap.sh          # emsdk 6.0.10 + vcpkg (pinned)
scripts/apply-patches.sh      # patches/qgis-wasm.patch onto external/QGIS (tag final-4_2_3)
scripts/build-deps.sh         # Qt 6.11 for WebAssembly, GDAL, PROJ, GEOS, … (about an hour on 32 cores)
scripts/build-qgis.sh         # QGIS itself (about 25 minutes) → build/qgis/output/bin/{qgis.js,qgis.wasm,qgis.data,index.html}
node scripts/serve.mjs --port 8123   # a static server that sends the COOP/COEP headers threads need
# open http://127.0.0.1:8123/ in Chrome / Edge ≥ 137 (any browser with WebAssembly JSPI)
```

The page (`web/minimal/index.html`) is deliberately small: a browser preflight, Qt's loader with the module, a byte
counter for the download, IndexedDB for the home directory, and `coi-serviceworker.js` so the bundle also runs from a
plain static host (GitHub Pages, `python -m http.server` over HTTPS or localhost).

## What was changed in QGIS

One patch, [`patches/qgis-wasm.patch`](patches/qgis-wasm.patch), on top of upstream tag `final-4_2_3`: CMake for the
wasm executable (`cmake/QgisWasmApp.cmake`), `__EMSCRIPTEN__` guards where the browser has no SSL / processes /
sockets, static linking of providers and C++ plugins, and `src/app/qgswasm*.{h,cpp}` with the browser hooks that
`main.cpp` calls. `scripts/export-patches.sh` regenerates the patch from a modified `external/QGIS`.

## Tests

```bash
python3 tests/e2e/minimal.py     # Playwright + Chrome: the page starts, the main window paints, no page errors
```

## License

GPL-2.0-or-later ([LICENSE](LICENSE)), the licence of QGIS. Open Sans is under the OFL (`web/OpenSans-OFL.txt`).
