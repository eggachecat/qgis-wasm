# Architecture and layering: what the shell layer does and what QGIS does not

> Chinese original: [06-架构与分层.md](../06-架构与分层.md)

What runs in the browser in this repository is the real QGIS desktop application. Around it is a thin **page shell (`web/shell/`)**, and outside that an independent **Web Agent (`web/agent/`)**. The layering principle is one sentence:

> **QGIS knows only files and tool calls. URLs, sharing, presets, cloud storage protocols, external data services, models — all of it lives in the page layer.**

The payoff is direct: swapping an object store, connecting a new internal data service, changing the share link format, or swapping models touches no C++ and needs no rebuild (25 minutes); a page refresh takes effect. When upgrading QGIS, the patch is only a small and stable tool surface ([docs/05](05-web-agent.md) §3).

```
┌───────────────────────────────────────────────────────────────── browser page ─────────────────────────────────────────────────────────────────┐
│                                                                                                                                                │
│    web/agent/                            web/shell/ (shell layer: the page-side "product")                         QGIS (wasm)                 │
│                                                                                                                                                │
│   ┌────────────────────┐                ┌──────────────────────────────────────────────────────────┐              ┌────────────────────────┐   │
│   │ model loop         │                │ index.html    preflight (JSPI / SAB) → load in order     │              │ QgsWasmBridge          │   │
│   │ skills / MCP       │───────────────▶│ qgis-shell.js presets, window.qgis, plugins,             │─────────────▶│ ≈50 tools              │   │
│   │ panel UI           │     tool       │               SSE/MCP transport, startup                 │     tool     │ (C++, additive only)   │   │
│   └────────────────────┘   contract     │ link.js       URL scheme: ?open ?add ?extent …           │     call     │                        │   │
│                                         │               view_link / Share menu                     │              │ QgsWasmPreset          │   │
│    agent.html?qgis=…                    │ sources.js    query data sources: OGC API / catalog /    │◀─────────────│ settings, basemaps,    │   │
│    (remote host)                        │               GeoJSON API → sources_* tools              │    events    │ favorites, C++ plugins │   │
│                                         │ cloudfs.js    object store → /cloud/<name> (files)       │              │                        │   │
│                                         │ pyqgis.js     Pyodide + PyQGIS compatibility layer       │              │ filesystem (FS)        │   │
│                                         └──────────────────────────────────────────────────────────┘              └────────────────────────┘   │
│                                                                                                                                                │
└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Dependency direction: **agent → `window.qgis` (tool contract) ← QGIS**; inside the shell layer, `link.js` uses `sources.js` (`source://` links), and both touch QGIS only through `window.qgis.call()` and Emscripten's `FS`. No code on the QGIS side references URL parameters, sharing, data sources or the agent.

## 1. Responsibilities of each layer

| Layer | Files | Knows | Does not know |
|---|---|---|---|
| **QGIS core** | `external/QGIS/src/app/qgswasm*.{h,cpp}` (patch) | tool registry (`layers_add`, `canvas_set_extent`, `ui_add_action`…), applying a preset's `settings/basemaps/favorites/plugins_cpp`, the virtual filesystem | URLs, sharing, cloud storage protocols, external data services, models, agent |
| **Shell layer: startup and contract** | `qgis-shell.js` | loading modules, presets, `window.qgis` (QGIS tools + page tools + events), Web/Python plugins, the outward SSE/MCP transport | any concrete business logic |
| **Shell layer: URL and sharing** | `link.js` | the semantics of `?open ?add ?basemap ?crs ?extent ?ask`; links produced by `view_link`/`project_share`; Plugins → Share menu | QGIS internals (it only calls tools) |
| **Shell layer: query data sources** | `sources.js` | the adapter contract (`collections / search / fetch`), the three built-in types `ogcapi / catalog / geojson`, `sources_*` tools, Plugins → Data sources menu, the `source://` spec | how data is rendered (written to a file, then `layers_add`) |
| **Shell layer: storage** | `cloudfs.js` | Swift / S3 / HTTP directory → `/cloud/<name>` filesystem (SigV4, chunked reads, write-back) | the meaning of file contents |
| **Shell layer: Python** | `pyqgis.js` + `pyqgis/` | Pyodide, the PyQGIS compatibility layer → tool calls | — |
| **Shell layer: workspace panel** | `workspace.js` | the page's own facade: buttons, header menu, floating card / docked sidebar, slots for plugins and the agent | agent internals, models |
| **Shell layer: sharing** | `share.js` | snapshot layout, manifest, packaging and refresh | QGIS internals (it only uses `project_save`, `layer_set_source`) |
| **Shell layer: debug view** | `debug.js` | logs on both the page and QGIS sides, timings, stalls, crashes | — |
| **Shell layer: task bus** | `progress.js` | unified progress reporting for all long operations | QGIS (it does not know this exists) |
| **Shell layer: loading page** | `loading.js` + `index.html` | real byte counts, phases, hold, brand | — |
| **Web Agent** | `web/agent/` | model loop, skills, MCP client, approval policy, three-layer configuration, conversation UI | `window.qgisInstance`, FS, C++, other shell modules (it knows only `window.qgis` and `window.qgisWorkspace`, [docs/05](05-web-agent.md)) |
| **Server** | `scripts/serve.mjs` | static files and headers, `/proxy`, `/mcp`, `/agent/*` | page logic (any static server + two response headers can replace the first part) |

### 1.1 Details of a few shell-layer modules

**Workspace (`workspace.js`)**

- The flat button in the bottom-right corner opens a card floating over the map, or `ui.layout: "dock"` turns it into a docked sidebar; the header menu Project / Share / Data / ⋯ (save, share link, MCP endpoint, data sources and mounts, layout, link, about) **all go through `window.qgis` tools**; there is no second QGIS API on the page.
- The body is a single slot: the agent renders into it; `window.qgisWorkspace` (`open/close`, `slot`, `addAction`, `setBadge`) is its interface for the page's other modules.

**Sharing (`share.js`)**

"Sharing" has only one meaning: a **frozen, self-contained project folder** `<mount>/<prefix>/<id>/` on a cloud mount, containing:

- `project.qgz`;
- `data/` — layer files that exist only in the browser (query results, uploads, downloads, exports);
- the `share.json` manifest — title, time, extent, and each layer's origin `source://…` and size.

The tools are `project_share` / `share_open` / `share_refresh`, and the link is `?share=<id>`; refresh = re-run the queries according to the manifest and rewrite the files in `data/` in place (layer id, name and style unchanged).

When browser-local GeoJSON (query results) enters a snapshot, QGIS packs it into a **GeoPackage** (`native:savefeatures` writes to a local temporary file, which is then copied into the folder, `data/x.gpkg|layername=x`, with `packed: "geojson"` recorded in the manifest; refresh packs the same way). Why packing is worth it:

- it has a spatial index and is ready to use on open — GeoJSON has no index, so every thread that touches it parses the whole thing;
- about 30% smaller;
- measured on 10 MB / 25,000 polygons: packing 0.3 s, 7.2 MB; `layers_add` 0.06 s against 0.52 s; rendering after zooming in is 3–4× faster (105/45/37 ms against 192/161/182 ms).

If packing fails (mixed geometries, odd fields), the file is copied as-is. Transfer does not block the tab: the snapshot is written under `cloudfs`'s **write-behind lease** (files stay in memory first, and QGIS re-reads and saves the project from memory), then uploaded asynchronously and in parallel with byte counts reported; opening a snapshot first **prefetches** according to the manifest (`prefetch`, direct by key, no directory listing), and then QGIS reads from memory.

**Debug view (`debug.js`)**

- One list shows logs from both the page and QGIS: the page's `console.error/warn` and uncaught exceptions, the module's stdout/stderr (Qt, GDAL/PROJ), QGIS's own message log (bridge event `log`), the duration of every tool call, main-thread stalls ≥100 ms, memory / threads / startup phase, and the stacks of pthread worker crashes (the blob preamble wrapped around each `em-pthread` worker does the forwarding).
- A crash is also a page state: `window.qgisCrash`, the `qgis-crash` event, a red bar at the top of the page (Reload / Debug view / Copy report); `qgis.call` turns the subsequent `unwind` and the silence into one plain sentence; the report is stored in localStorage and listed first after a reload.
- Cost: a 2000-entry ring buffer, no rendering while closed, only the error count pushed to the header button.

**Task bus (`progress.js`)**

- The single reporting point for every long operation on the page: `qgisProgress.begin(label)` → `t.set(detail)` / `t.update({ done, total, unit: 'bytes' })` / `t.finish()` / `t.fail()`, or `run(label, fn)`.
- Each interface listens for whatever is running: the workspace (a progress bar under the header when open; a pill next to the button when closed, which does not flash for work that finishes within 150 ms), the loading page (while still present, it shows the latest task as the phase line), the Debug view (one row per task + duration).
- Sharing, opening a snapshot, query data sources (page counts, Overpass waits), downloads, and every step of applying a link are all reported here.

**Loading page (`loading.js` + `index.html`)**

- Counts real bytes according to `qgis.bundle.json` (clones the response stream and counts, keeping the original response's URL so Chrome can still cache the compiled result), shows phases, cycles through explanations of the principles, and displays the links from the preset.
- The spinner and accent colour come from `brand.js` (`window.qgisBrand`: name, `--brand-accent`, `spinner()`; a deployment overlay can replace the whole file), and the workspace reuses the same set.
- `hold()`: links with `?share= / ?open=` make the loading page turn into a **semi-transparent curtain** after QGIS starts, showing snapshot download progress, and it only goes away once the project is in.

## 2. Extension points: where to change things when adding something new

| What you want to do | Where to change | Rebuild? |
|---|---|---|
| Connect a **new object store / file service** | `cloudfs.js` `registerBackend(type, impl)` (`list/read/size/write/remove/mkdir/copy`), referenced from preset `mounts` | No |
| Connect an **internal data query service** (OGC API Features, catalog, HTTP API returning GeoJSON) | **one preset line**: `"sources": [{ "name", "type": "ogcapi" \| "catalog" \| "geojson" \| "overpass", "url", … }]`; for any other shape, `qgisSources.registerType(type, { collections?, search?, fetch })` (one JS file, which can also be registered from a Web plugin). Precedent: `sources-overpass.js` (OpenStreetMap); a deployment's own gateway is likewise a `registerType()` in a Web plugin — the preset's `sources` of that type attach automatically once it registers, with zero changes to QGIS | No |
| Add a button / menu item to the workspace header | `window.qgisWorkspace.addAction({ id, title, icon, run })` (the agent's own two buttons are added this way); menu contents are maintained by group in `workspace.js` | No |
| Add a **view** to the workspace (occupies the panel body, like Debug) | `window.qgisWorkspace.registerView({ id, title, icon, render(el), onShow, onHide })` — one more button in the header, and when opened it replaces the agent's slot; `debug.js` is a ready example (it registers after the `ws-ready` event) | No |
| Let the agent / tests trigger QGIS's own menu items | `ui_trigger_action { id: "mActionAddOgrLayer" }` — first looks up what `ui_add_action` registered, then finds QGIS's QAction by objectName | No |
| A data source only the agent uses (needs conversational retrieval) | the service provides an MCP server, preset `agent.mcpServers` ([docs/05](05-web-agent.md) §4.4) | No |
| New **URL parameters / share content** | `link.js`'s `parse / build / apply / current` | No |
| A **long operation** whose progress people should see | `const t = qgisProgress.begin('Doing X'); t.update({ done, total, unit: 'bytes', detail }); t.finish()` — no interface code to touch, the workspace / loading page / Debug view display it themselves; large cloud files get byte counts for free through `qgisCloud.prefetch(items, { onProgress })` / `writeBehind(folder)` | No |
| A new **page tool** (for the agent / MCP / plugins) | `qgis.registerTool(name, { description, inputSchema, run })` (Web plugins, skills and the shell layer all do this) | No |
| A new **business capability** (import wizard, analysis workflow…) | agent skill (`web/agent/skills/*.js`, [docs/05](05-web-agent.md) §5.1) | No |
| A new **QGIS menu entry** | the `ui_add_action` tool + the `action` event (shared by Web plugins / the shell layer / Python plugins) | No |
| A capability QGIS does not expose yet | add a `registerTool` in `qgswasmbridge.cpp` (additive only, [docs/05](05-web-agent.md) §3.3) | Yes |
| A new **preset field** | fields the page consumes: change only the shell layer; fields QGIS must consume: change `qgswasmpreset.cpp` | Depends on the field |

## 3. URL scheme (`link.js`)

All parameters can be combined and are all optional; `?open=` keeps its original semantics (via QGIS's own `openFile()`; the project replaces the current project, and data files go through QGIS's dialogs), everything else is done by the shell layer calling tools directly, **with no dialogs**:

| Parameter | Meaning | Example |
|---|---|---|
| `preset=<name>` | deployment preset (`default` can be omitted) | `?preset=team-a` |
| `open=<path\|url>[,…]` | open a project / file (QGIS's openFile) | `?open=/cloud/shared/projects/<uuid>/x.qgz` |
| `share=<id>` | open a **snapshot** on a cloud mount: `<mount>/<prefix>/<id>/project.qgz`, and position to the extent in its `share.json` (`extent=` can override). This is the short link copied by "Share a snapshot"; project, data and styles are all frozen. While it opens, the loading page stays as a curtain: first prefetch all files according to the manifest (real MB and rate), then QGIS reads from memory and renders the first view, and only then does the curtain go away; when `extent=` equals the snapshot extent there is no second render (changing the extent while the first view is still parsing a large layer would stall the tab) | `?share=7f3c…` |
| `add=<path\|url\|source://…>` (repeatable) | add directly as a layer: a file in the virtual filesystem (`/cloud/…`, `/qgis/share/demo/…`, optionally with `\|layername=`), an http(s) URL (downloaded first), an XYZ template, a **query data source** | `?add=/cloud/gis/data/world_map.gpkg\|layername=countries&add=https://…/x.geojson&add=source://features/city_regions?limit=5` |
| `basemap=<name>` | an XYZ basemap from the preset, placed at the bottom | `?basemap=OpenStreetMap` |
| `crs=EPSG:xxxx` | project CRS | `?crs=EPSG:3857` |
| `extent=xmin,ymin,xmax,ymax[@CRS]` | zoom to an extent (EPSG:4326 by default) | `?extent=-20,30,40,70` |
| `ask=<text>` | hand to the Web Agent once the page is ready | `?ask=Add OSM and zoom to Brazil` |
| `trace=1` / `force=1` | debug output / skip the browser preflight | |

The application order is fixed: project → basemap → layers (in `add` order, bottom to top) → CRS → extent.

**Sharing** has three routes, all in the page layer:

- `project_share` (tool / agent / Plugins → Share → "Share project"): saves the project to the shared mount as `projects/<uuid>/<title>.qgz`, link = `?preset=…&open=<path>&extent=<current extent>`; whoever opens it gets the same project and the same view.
- `view_link` (tool / Plugins → Share → "Copy link to this view"): **does not save the project**. If the project itself is on a cloud mount, just `open=` it; otherwise write into the link the layers that "can be obtained from any browser" — cloud files (including sublayers), URLs (including URLs the agent added directly with `layers_add`, whose origin the shell layer remembered), `source://` queries, basemaps — plus the current extent. Things that exist only in this browser (`/home/web_user`, memory layers) are listed in `skipped` as a hint.
- Assembling the URL by hand: the table above is the public contract.

Links no longer carry `index.html`, and `preset=default` is omitted, so a short link like `http://host/?add=…&extent=…` works.

**Two kinds of links, two semantics.** `share=<id>` is a **storage share**: `project_share` copies the project and all layer files that exist only in the browser (query results, uploads, downloads, exports) into `<mount>/projects/<id>/`, uses `layer_set_source` to repoint the layers there and then saves, and writes `share.json` — the opener sees exactly what the sharer sees, independent of the data source's state or permissions at the time; the manifest records each layer's origin, so Share → "Refresh this snapshot from its sources" (`share_refresh`) can re-run the original queries and rewrite the files in `data/` in place without touching styles. Parameters such as `add=source://…` are a **recipe share** (`view_link`, "Copy a live link to this view"): nothing is stored, the queries run again on open, which suits live data and links assembled programmatically by external systems such as dashboards. When the project itself is a snapshot, `view_link` returns the short link.

## 4. Query data sources (`sources.js`)

Cloud mounts solve "data that behaves like files"; query data sources solve services where "there is data only after you ask a question". Declaration:

```json
"sources": [
  { "name": "features", "type": "ogcapi",  "title": "Internal feature service", "url": "https://geo.corp/ogcapi", "proxy": "auto", "limit": 2000 },
  { "name": "catalog",  "type": "catalog", "title": "Data catalog",     "url": "https://data.corp/catalog.json", "search": "https://data.corp/search?q={q}" },
  { "name": "poi",      "type": "geojson", "title": "POI query",     "url": "https://api.corp/poi?bbox={bbox}&q={q}&limit={limit}", "headers": { "X-Token": "…" } }
]
```

| Type | Contract | Suits |
|---|---|---|
| `ogcapi` | `GET {url}/collections` → collections; `GET {url}/collections/{id}/items?bbox=&limit=&q=` → GeoJSON | OGC API – Features services (pygeoapi, GeoServer, ldproxy, QGIS Server…) |
| `catalog` | `GET {url}` → `[{ name, title, description, url, format }]` (or `{datasets\|items\|results}`), with an optional `search` template for server-side search; a hit is opened via `layers_add` using its `url` (GeoJSON / GPKG / GeoTIFF… all fine) | data catalogs, dataset listings |
| `geojson` | fill `{q} {bbox} {limit} {collection} {id}` into the `{url}` template, returns GeoJSON | any internal "question and answer" API |
| `overpass` (`sources-overpass.js`) | collections = common tag presets (traffic_signals, crossings, stop_signs, motorway_junctions, roads, railways, buildings, parking, construction, tunnels_bridges); `q` = a tag filter (`highway=traffic_signals`, `amenity=cafe; shop`, `building`) or full Overpass QL; bbox required (a query without bbox is refused) → `(s,w,n,e)`; the result of `[out:json] … out body geom <limit>` is converted to GeoJSON in the page: node → point, way → line, closed way with area attributes → polygon, multipolygon relation → polygon | OpenStreetMap: public Overpass API `https://overpass-api.de/api/interpreter` (already configured in the default preset, use it sparingly; your own mirror is better) |

Once declared, four entry points appear automatically, with no second configuration:

1. **Tools**: `sources_list / sources_collections / sources_search / sources_load / sources_add` — the Web Agent's state snapshot contains the `sources` list, and the prompt tells the model "when the data the user wants is not on the map, search the data sources first"; MCP clients (Claude Code) and Web plugins can use them directly too.
2. **Menu**: Plugins → Data sources → "<title>…", ask for a collection / keyword, load and zoom.
3. **Links**: `?add=source://<name>/<collection>?q=…&bbox=…&limit=…`; `view_link` writes layers added this way back into the link.
4. **Code**: `qgisSources.load('features', { collection: 'roads', bbox: [..] })`.

Data flow: the adapter returns GeoJSON text → written to `/home/web_user/sources/<source>/<name>-<time>.geojson` → `layers_add`. What QGIS sees is just a file. CORS: try a direct connection first; if the browser blocks it, fall back to the same-origin `/proxy` (same as cloudfs; `proxy: false` forbids it).

> Why not use QGIS's own WFS / OAPIF providers directly? GDAL in this wasm build has no network drivers, and QGIS's `wfs` provider is not compiled either (see `build/qgis/src/providers`: only wms, wcs, arcgisrest, delimitedtext). More importantly: in the shell layer, a new service = one line of JSON, with no need to wait for QGIS to support its protocol.

## 5. Transport, caching and the server

| File | Raw | brotli (q9) | gzip | When downloaded |
|---|---|---|---|---|
| `qgis.wasm` | 133.6 MB | 30.7 MB | 39.0 MB | startup |
| `qgis.data` | 18.8 MB | 2.9 MB | 3.9 MB | startup |
| `qgis.js` | 0.4 MB | ≈0.1 MB | ≈0.1 MB | startup |
| `world_map.gpkg` (an on-demand file listed in `qgis.lazy.json`) | 12.9 MB | 4.5 MB | 9.1 MB | first read (CRS selector preview etc.) |

- `scripts/compress-bundle.mjs` generates the `.br` / `.gz` sidecar files after the build (`build-qgis.sh` calls it automatically, about 25 s); `serve.mjs` sends one when the client accepts that encoding and the sidecar file is not older than the original (`Content-Encoding` + `Vary: Accept-Encoding`, ETag with the encoding suffix). First load drops from ≈166 MB to ≈34 MB (gzip ≈43 MB). Browsers only announce `br` on secure origins (https / localhost); http on a LAN falls back to gzip.
- The validation strategy is unchanged: `Cache-Control: no-cache` + ETag, one 304 on every load (qgis.js and qgis.wasm must come as a pair and cannot each be cached by max-age, see the comment in serve.mjs). `tests/e2e/warm.py` proves this path works: opening a second time with the same browser profile, each of the three files transfers only a 300 B validation header, Chrome reuses the compiled result as well, and the main window comes up in ≈1.0 s; the loading page records "download complete → module ready" at 4.8 s cold and 0.13 s warm, and the difference is the compilation. Keep these two things when deploying to another server (the `application/wasm` Content-Type, `no-cache` + ETag) and warm starts still work.
- When several people share one server, `serve.mjs --shared` (`scripts/deploy.sh` installs it this way by default): MCP / agent calls must carry `?client=<page id>` (the page id is generated randomly by the page itself and known only to it; under Plugins → Share you can copy your own endpoint), `/agent/result` accepts only replies from that page, `/agent/clients` is off, `/proxy` only reaches hosts that appeared in the preset (add `--proxy-allow`), and redirects are checked hop by hop. All of this is in the page layer / server layer; QGIS does not know how many people are using it. Covered by `tests/serve-shared.test.mjs`.
- Switching to nginx: `brotli_static on; gzip_static on;` plus two headers is enough, with no change to the page layer:

```nginx
location / {
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy credentialless always;
  brotli_static on; gzip_static on;
  types { application/wasm wasm; }
  etag on;
}
```

- **On-demand files**: rarely used large resources do not go into `qgis.data`. `QGIS_WASM_LAZY_FILES` in `cmake/QgisWasmApp.cmake` (`source file@virtual filesystem path`, by default only `resources/data/world_map.gpkg` — 12.9 MB, read only by the CRS selector's preview map and a status-bar easter egg) excludes a file from the bundle, copies it next to `qgis.js`, and writes `qgis.lazy.json` (file name, size, virtual path). At startup the page uses `cloudfs.js`'s `http` backend to mount these files read-only at `/qgis/share/qgis/lazy` (an internal mount that does not appear in the mount list), then uses symlinks to point the original paths there: QGIS still opens the original paths, and the bytes are fetched only on the first read — one whole-file GET without Range, so the server can serve `.br` directly. Adding another file takes one more entry in the cmake list, with no changes to the page layer or QGIS. The remaining big item, `proj/proj.db` (10.2 MB), is read at startup and is not a good fit for on-demand loading.

## 6. Browser compatibility

`index.html` runs a preflight before loading any wasm: when **JSPI** (`WebAssembly.Suspending`) or **SharedArrayBuffer / cross-origin isolation** is missing, it shows an explanatory page (what is missing, why it is needed, what to do: change browser / use HTTPS or localhost / add COOP+COEP headers on the server), and nothing is downloaded; `?force=1` skips it (for asyncify builds).

| Browser | Status (2026-10) |
|---|---|
| Chrome / Edge ≥ 137 | available (JSPI on by default since 137) |
| Safari 27+ | JSPI has arrived with Safari 27, needs verification on real devices |
| Firefox | JSPI not yet on by default (planned for 153; Nightly can enable it with `javascript.options.wasm_js_promise_integration`) |

The fallback when Firefox is required is to build another copy with `cmake -DQGIS_WASM_NESTED_LOOPS=asyncify` (bigger and slower, [docs/01](01-approach.md)).

## 7. Current performance and directions

Measured ([docs/01](01-approach.md) §3, [docs/05](05-web-agent.md) §8, `agent.py`/`features.py` logs): main window 3–8 s, demo project render 10–16 s (slower under SwiftShader), each tool call < 0.3 s, no main-thread stall > 300 ms on the page; the agent's slowness comes from gateway first-byte 2–4 s × the number of round trips (common tasks have been reduced to 2 round trips). Next, ordered by payoff:

1. Transport: done (this document §5). Remember the sidecar files and the two headers when deploying to a CDN/nginx.
2. `-DQGIS_WASM_PROFILING_FUNCS=OFF`: wasm 15 MB smaller (about 3 MB compressed), at the cost of no function names in stack traces; can be enabled for release builds.
3. `qgis.data` on demand: done (§5), `world_map.gpkg` no longer downloads at startup, so startup decompresses 13 MB less into memory.
4. Startup: the Qt thread pool warm-up and QGIS initialization are already optimized ([docs/02](02-runtime-and-debugging.md) §2.4). wasm compilation is not the bottleneck: on a 32-core machine, with the browser profile on tmpfs, a cold start (download 34 MB + compile + initialize) brings up the main window in 1.4 s; a second open with the same profile takes 1.0 s (each file transfers only a 300 B validation header, and compiled results come from Chrome's code cache). On the test machine a cold start looks like 8–13 s, all of it Chrome writing the new profile and cache (about 50 MB) to an ext4 disk — I/O, unrelated to wasm; the same measurement moved to /dev/shm is 1.4 s. So the first-open experience depends on the user's disk; what the server side can do (compression, on-demand files, cacheability) is already done.

## 8. Tests

`tests/e2e/features.py` covers this document's shell-layer behavior: listing / collections / cross-source search / loading for the three data source types (bbox, catalog URL, `{q}` template); link parsing; both branches of `view_link` (project on the cloud → `open=`, unsaved → rebuild `add=`/`basemap=` from the layers); one deep link reproducing basemap, cloud sublayer, URL layer, query source and extent in a new tab (`docs/screenshots/qgis-wasm-deep-link.png`); the Share and Data sources menus; the preflight page without JSPI; `.br` sidecar negotiation; on-demand files (at startup only a symlink, no download; the first read is exactly one whole-file GET without Range, layer complete with 240 features). `tests/mock-mcp.mjs` doubles as a JSON catalog (`/catalog.json`) and an OGC API Features service (`/ogcapi`) (when a deployment overlay exists, it also loads the mocks for that overlay's own gateway from `internal/tests/mock-*.mjs`, and the corresponding checks are enabled with them). Workspace: the button and its closed state, the agent in the slot, the Data menu listing all data sources and mounts, submenus listing collections with one-click add, the preset links and the layout switch in the ⋯ menu; loading page: the byte counts of `qgis.wasm`/`qgis.data` in `window.qgisLoadStats` equal the sizes in `qgis.bundle.json`.

The boundary from §1 of this document is tested as well: `node tests/layering.test.mjs` (no browser, about a second) statically checks the patch and the page sources —

- Added lines under `src/` in the patch do not touch the page: no `window.` / `document.` / `location.*` / `URLSearchParams` / browser storage / `fetch(` / page module names; no models, keys, share parameters such as `?open=`, or `source://` vocabulary. The only JS in the patch (EM_JS) returns to the page only through the two hooks `Module['qgisBridgeResolve'|'qgisBridgeEvent']`, and the test verifies that `qgis-shell.js` really provides them.
- `link.js`, `sources.js`, Web plugins and the agent do not touch Emscripten internals (`ccall`/`HEAP*`/`Module.`/C exports/bridge hooks); `qgisInstance` may only be used up to `.FS`.
- The agent knows only the `window.qgis` contract: it does not reference shell-layer modules, does not touch the filesystem, and its `import`s do not leave `web/agent/`.
- The shell layer's five JS files contain no provider / model / key vocabulary (those belong to the agent and the preset).
- Every literal tool name in the page layer and the PyQGIS compatibility layer (`qgis.call('…')`, `_bridge.call("…")`) is among QGIS's 48 tools or the tools registered by the shell layer — a rename or a typo is reported on the spot.

Sharing: `project_share` leaves `projects/<id>/project.qgz` and `share.json` in the bucket and returns `?share=<id>`; with a local query layer, its file appears in `data/`, the layer source is repointed to the cloud, and the manifest records `source://<source>/<collection>`; after `share_refresh` rewrites in place, layer ids are unchanged and feature counts are unchanged; `view_link` returns the short link for a snapshot; a second tab opened with `?share=` gets the same layers. Workspace: Project → Export the map view as PNG opens a new tab within the click and downloads; the Debug view has tool timings, QGIS output and memory / threads / startup phase. `tests/e2e/warm.py` verifies the caching strategy of §5 (cold/warm start, see §7).
