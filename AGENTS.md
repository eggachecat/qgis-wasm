# Working in this repository

Guidance for people and for coding agents (Claude Code, Codex, Cursor, …) that change this project. It is short on
purpose; the documents it points to carry the detail. The minimal branch keeps only the parts about the build.

## 0. What this is

The upstream QGIS desktop application (C++/Qt, `qgis_core` + `qgis_analysis` + `qgis_gui` + `qgis_app`, the data
providers, QGIS' own `main.cpp`) compiled to WebAssembly with Emscripten and Qt for WebAssembly, plus a browser page
around it: a loading page, cloud storage mounts, a URL scheme and share links, injectable query data sources, a Python
runtime with a PyQGIS compatibility layer, a tool contract (`window.qgis`) that an MCP server and a Web Agent use.

The one architectural rule (docs/06): **QGIS knows only files and tool calls.** URLs, sharing, presets, cloud
protocols, external data services, models and keys live in the page layer and reach QGIS only through
`window.qgis.call(tool, params)` / `window.qgis.on(event, fn)` and the virtual filesystem. `tests/layering.test.mjs`
enforces it statically; keep it green.

## 1. Layout

| Path | What lives there | Change it when |
|---|---|---|
| `external/QGIS` | upstream QGIS, submodule pinned to tag `final-4_2_3` | never directly; see `patches/` |
| `patches/qgis-wasm.patch` | every change to QGIS: CMake, `__EMSCRIPTEN__` guards, `src/app/qgswasm*.{h,cpp}` (browser hooks, the tool registry `QgsWasmBridge`, presets, static plugins) | you need a new tool, a new event, or QGIS behaves differently in the browser. Edit `external/QGIS`, build, then `scripts/export-patches.sh` regenerates the patch — commit the patch, never the submodule's own changes |
| `web/shell/` | the page: `index.html` (preflight, loading page, script order), `qgis-shell.js` (presets, `window.qgis`, startup), `loading.js`, `progress.js` (task bus), `cloudfs.js` (mounts), `link.js` + `share.js` (URLs, snapshots), `sources.js` + `sources-overpass.js` (query sources), `workspace.js` (the panel), `debug.js`, `pyqgis.js` + `pyqgis/` (Python), `brand.js` (look), `coi-serviceworker.js` (static hosts), `presets/`, `plugins/` | page behaviour. Every long operation reports to `qgisProgress`; every call into QGIS goes through `window.qgis` |
| `web/agent/` | the Web Agent: model loop, providers, MCP client, skills, panel UI. Depends on the `window.qgis` contract only (`core/host.js`) | agent behaviour, providers, skills |
| `scripts/` | toolchain (`bootstrap`, `build-deps`, `build-qgis`, `apply-patches`, `export-patches`), `serve.mjs` (static + COOP/COEP + `/mcp` + `/proxy` + agent transport), `stage-web.sh`, `compress-bundle.mjs`, `deploy.sh`, `export-*.sh` | build, run, publish |
| `tests/` | `e2e/` (Playwright + Chrome: `smoke.py`, `features.py`, `agent.py`, `warm.py`, `minimal.py`), node tests (`layering`, `cloudfs-sign`, `serve-shared`, `oss-guard`), mocks (`s3-mock`, `mock-mcp`, `mock-llm`), `data/` | with every behaviour change; add a check next to the behaviour |
| `docs/` | `README.md` (bilingual index), `BUILD.md` (English), 01–06 in Chinese under `docs/` and in English under `docs/en/` (approach, runtime and debugging, plugins, cloud/presets/agent, Web Agent, architecture) | keep the row of the thing you changed accurate, and change **both** the Chinese document and its English sibling |
| `internal/` (optional, not published) | a deployment's overlay: `web/brand.js`, `web/presets/*.json`, extra page modules (its own source types as web plugins), `deploy.env`, `tests/` extensions. `scripts/stage-web.sh` copies it over the bundle; `scripts/export-oss.sh` removes it | anything that names your organisation's hosts, products or keys |

## 2. Build, run, test

```bash
scripts/bootstrap.sh && scripts/apply-patches.sh && scripts/build-deps.sh   # once (toolchains, then an hour of dependencies)
scripts/build-qgis.sh                      # QGIS → build/qgis/output/bin (≈ 25 min cold, ≈ 3 min for a C++ change in src/app)
scripts/stage-web.sh [--oss|--internal]    # web layers (+ overlay) into the bundle; after any change under web/
node scripts/serve.mjs --port 8123         # then http://127.0.0.1:8123/  (Chrome / Edge ≥ 137: WebAssembly JSPI)
node tests/layering.test.mjs && node tests/cloudfs-sign.test.mjs && node tests/serve-shared.test.mjs
python3 tests/e2e/smoke.py && python3 tests/e2e/features.py && python3 tests/e2e/agent.py && python3 tests/e2e/warm.py
```

Details, prerequisites and the CMake knobs: [docs/BUILD.md](docs/BUILD.md). The e2e suites start their own
`serve.mjs` on port 8123 (or reuse one already listening there) plus the mocks on 9123/9124; do not run two browser
suites at once — the MCP checks address the most recent page.

## 3. Rules of the road

- **Layering first.** A new capability is a page module or an agent skill unless QGIS itself lacks a primitive; then
  it is one additive tool in `QgsWasmBridge` (JSON in, JSON out, schema, no dialogs) and the page builds on it. Tools
  are additive: never change an existing tool's parameters or result shape (bump `bridgeApi` if you must).
- **Synchronous means blocking the UI.** QGIS' filesystem calls are synchronous on the main thread; anything that
  can take time (uploads, listings, big downloads) is done asynchronously around it (`cloudfs.writeBehind`,
  `prefetch`, `warm`) and reports to `qgisProgress`. Never add a `setTimeout`-and-hope.
- **Calls into C++ are queued.** `qgis_wasm_call` only posts into Qt's event loop (docs/02 §2.1); never run QGIS code
  inside a JavaScript → C++ export, never suspend there.
- **No secrets, no internal names.** Keys, tokens, internal hosts and product names go into `internal/` (the
  overlay) or into the user's browser settings, never into `web/`, `tests/`, `docs/` or a commit message.
  `tests/oss-guard.mjs` fails an export that contains them: generic shapes (keys, tokens, home directories) live in the
  script, the overlay's own vocabulary in `internal/oss-guard.json` — extend that list when the overlay grows.
- **Brand is data.** Colours come from `--brand-accent`, the spinner from `qgisBrand.spinner()`; do not hard-code
  either in a stylesheet or a script.
- **Tests travel with the change.** A behaviour has a check in `tests/e2e/*.py` (browser) or `tests/*.test.mjs`
  (static). Deployment-specific checks live in `internal/tests/e2e_overlay.py` and run only when the overlay exists.
- **Docs are part of the change.** README (both languages) for what users see, docs/0x for how it works, the
  troubleshooting table in docs/02 for anything a user may hit.
- **Patch hygiene.** `scripts/export-patches.sh` after every change under `external/QGIS`; the patch applies cleanly
  to a fresh `final-4_2_3` checkout (`scripts/apply-patches.sh`).
- **Commits.** Present tense, say what changed and why in the first line, details below; one logical change per
  commit; never commit `build/` output, screenshots of a private deployment, or anything the guard rejects.

## 4. Publishing

The repository has **two branches**: `main` (the source) and `gh-pages` (the built bundle as a static site).

```bash
scripts/release.sh                   # incremental build → export gh-pages → push main + gh-pages
scripts/export-pages.sh gh-pages     # only the static site, no build and no push
```

CI (`.github/workflows/`):

- `tests.yml` — on every push and pull request: layering, SigV4, shared server, docs links, OSS guard. Seconds, hosted
  runner, no build.
- `scripts/deploy-cloudflare.sh` — the same static site on Cloudflare Pages: `_headers` for cross-origin isolation at
  the edge, and members over Pages' 25 MiB per-file limit (today `qgis.wasm.gz`) on an R2 bucket whose absolute URL goes
  into `qgis.bundle.json`. `web/shell/loading.js` buffers such a cross-origin member before handing it to Emscripten.
- `pages.yml` — manual by default (`workflow_dispatch`); builds and pushes `gh-pages`. It needs a **self-hosted
  runner** with the labels `self-hosted, linux, qgis-wasm`: a from-scratch build wants ~110 GB of build tree and hours
  of CPU, which hosted runners do not have. Uncomment its `push:` trigger once the runner is registered.

`main` is the default branch. Each export adds one commit on top of the previous one with the whole tree as of
the current `HEAD` (pushes stay fast-forward); the guard runs on every exported tree. `gh-pages` carries ≈ 55 MB of build output (`qgis.wasm.gz` alone is 37 MB): push it to
GitHub only — it does not fit a host with a small per-file push rule (5 MiB is a common limit on self-hosted Git servers),
and GitHub Pages does not serve Git LFS objects, so LFS is no way around it.
