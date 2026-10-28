# Cloud storage, presets and the agent

> Chinese original: [04-云存储-Preset-Agent.md](../04-云存储-Preset-Agent.md)

All three rest on the same fact: what runs in the browser is the full QGIS desktop application. So "integrating" them means making QGIS' own filesystem, settings system and UI see them, not building a second interface beside it.

```
  preset JSON ──▶ web/shell/qgis-shell.js ──▶ Emscripten FS ──▶ QGIS (Browser panel / open and save dialogs / GDAL / QgsProject)
    mounts            cloudfs.js (S3 / HTTP)      /cloud/<name>
    settings/basemaps ──▶ QgsWasmPreset::apply() ──▶ user profile (QgsSettings / XYZ connections / favorites)
    agent ──▶ web/agent (the Web Agent on the page, [docs/05](05-web-agent.md)) ──▶ model API + MCP server (internal data sources)
  MCP client (Claude Code, etc.) ──▶ scripts/serve.mjs /mcp ──▶ page (SSE) ──▶ QgsWasmBridge tools ──▶ QGIS
```

## 1. Cloud storage (S3-compatible)

> Mounts handle data that behaves like files. Services whose data exists only through queries (collection / bbox / keyword) use the preset's `sources` ([docs/06](06-architecture.md) §4). Both live in the page layer; QGIS is unchanged.

### 1.1 Usage

Declare mounts in the preset (or with the page console `qgis.mount({...})` / the agent tool `mounts_add`):

```json
"mounts": [
  { "type": "swift", "name": "shared", "url": "https://swift.example.com/v1/AUTH_team/shared" },
  { "type": "s3", "name": "gis", "endpoint": "https://s3.corp.example.com", "bucket": "gis-data", "prefix": "team-a/",
    "region": "us-east-1", "accessKeyId": "AKIA…", "secretAccessKey": "…", "pathStyle": true },
  { "type": "http", "name": "cdn", "baseUrl": "https://cdn.example.com/basemaps/", "index": "index.json" }
],
"share": { "mount": "shared", "prefix": "projects" }
```

Three backends:

| type | Use | Configuration |
|---|---|---|
| `swift` | OpenStack Swift-style object storage — services of the form `https://<host>/v1/AUTH_<account>/<container>/<object>` (anonymous or token read/write, Range; directory listing uses the JSON API, and when the container has staticweb (`X-Container-Meta-Web-Listings`) enabled it automatically switches to parsing its HTML directory page). The deployed preset usually mounts it as `/cloud/shared`. Container listings are eventually consistent: objects of size 0 in a listing are re-checked with HEAD | `url` (account + container), `prefix`, `token` (when `X-Auth-Token` is required), `proxy` |
| `s3` | AWS S3 / MinIO / Ceph RGW and other SigV4 APIs | `endpoint`, `bucket`, `prefix`, `region`, `accessKeyId`, `secretAccessKey`, `sessionToken`, `pathStyle`, `proxy` |
| `http` | A read-only HTTP directory (CDN), with one `index.json` describing the file list | `baseUrl`, `index`, `proxy` |

**About `proxy` (CORS and proxying)**

- `"auto"` (default): each request first goes direct; when the browser blocks it for missing CORS headers, it automatically switches to `/proxy?url=…` on the same-origin `scripts/serve.mjs`, and remembers that choice.
  - Directory listing and object transfer are **recorded separately**: for example, object GET/PUT/HEAD go direct once CORS is configured, while a staticweb container has no CORS headers and its listing still goes through the proxy.
  - The console prints which method each class ended up using.
- `true` forces the proxy, `false` forces direct.
- Services without CORS headers **must** go through the proxy (preflight rejected, or no `Access-Control-Allow-Origin` in the response). The proxy forwards all methods, request bodies and headers (including `Range`, `Authorization`, `x-amz-*`); S3 signatures are still computed for the real URL.
- Once CORS is configured on the storage side the preset needs no change (`auto` will go direct automatically). Headers that must be allowed:
  - **Swift**: container metadata `X-Container-Meta-Access-Control-Allow-Origin: <page origin>`, plus `…-Allow-Headers` / `…-Expose-Headers`.
  - **S3**: bucket CORS rules allow `Range`, `Content-Type`, `Authorization`, `x-amz-*` and expose `Content-Length`, `Content-Range`, `ETag`.

**Sharing**: `project_share` does not let the user pick a path — it saves the project as `/cloud/<share.mount>/<share.prefix>/<uuid>/<project title>.qgz` (default `shared/projects/…`) and returns a `?preset=<name>&open=<path>` link. When the other person opens the link, the same preset mounts the same container and the project appears directly.

After that, `/cloud/shared/...` and `/cloud/gis/...` are ordinary directories: you can browse them in the Browser panel's Favorites and double-click to add a layer; Project → Save As to `/cloud/gis/projects/x.qgz` writes back to object storage; tools such as `layers_add { uri: "/cloud/gis/data/a.gpkg" }`, `project_open` and `files_list` work just as well.

### 1.2 Implementation (`web/shell/cloudfs.js`)

- An Emscripten filesystem type built on top of MEMFS: a directory lists its objects the first time it is accessed (S3 `ListObjectsV2` / Swift `?format=json&delimiter=/`, cached for 30 s; a staticweb container only serves an HTML index page — after the first probe fails it remembers `listMode='html'`, and `"listMode": "html"` in the preset's mount skips the probe and saves one failed request; `proxy: "auto"` still tries a direct connection once before going through the page server's proxy, so before the container has CORS enabled the DevTools console still shows one blocked request — the Debug view does not count it, and it disappears once the container has CORS). A file is read the first time in 4 MB `Range` chunks (files ≤ 16 MB are fetched in one go); writes are buffered in memory and `PUT` as a whole on `close()`; `unlink`→`DELETE`, `mkdir`→an empty `key/` object, `rename`→`COPY`+`DELETE` (renaming directories is not supported).
- The Emscripten filesystem is synchronous (QGIS uses `fopen`/`read` on both the main thread and worker threads), so transfers use **synchronous XMLHttpRequest** (on the main thread binary can only be received as `x-user-defined` text; the script converts it). QGIS worker threads proxy filesystem calls to the main thread, so parallel rendering that reads `/cloud` is fine too.
- Signing is **AWS Signature V4** in pure JS in the browser (`UNSIGNED-PAYLOAD`, session tokens supported), compatible with S3, MinIO, Ceph RGW and others; without keys it is anonymous access. `tests/s3-mock.mjs` validates signatures strictly, and `tests/e2e/features.py` uses it for regression.
- Server requirements: **CORS** (`Access-Control-Allow-Origin` includes the page origin, allows `Authorization, Range, x-amz-*` headers, exposes `Content-Length, Content-Range, ETag`). MinIO/S3 bucket CORS configuration can do all of this; services that cannot can go through `scripts/serve.mjs`'s `/proxy?url=` (write `endpoint` as `http://<serve>/proxy?url=https://…`).
- The page's COEP is `credentialless`, so cross-origin requests carry no cookies; credentials go in signature headers.
- New backends: `qgisCloud.registerBackend(type, factory)`, just implement `list/read/size/write/remove/mkdir/rmdir/copy` (for example Azure Blob, GCS, WebDAV, an internal "S3-like" API).

**Listing at startup no longer blocks the main thread**: as soon as the Browser panel's favorites / file dialog appears it looks at the `/cloud/<name>` root, and cloudfs is synchronous for QGIS (synchronous XHR on the main thread) — measured on a local machine, 3 s of an 8 s startup were spent waiting for this one listing (a direct request rejected by CORS has to receive the whole response first, then goes through `/proxy`). There are now three layers: ① the result learned by `proxy: "auto"` (direct / proxy, per origin and request class) is stored in localStorage for 6 hours, so the next startup does not try direct again; ② the root listing is prefetched asynchronously when the mount is created (`qgisCloud.warm(path)` prefetches other directories), so it is already at hand when QGIS asks a second later and the synchronous path has zero wait; ③ under `/cloud/` QGIS' OGR provider no longer walks directories to guess Arc/Info grids (`qgsogrprovidermetadata.cpp`, `__EMSCRIPTEN__`). To take effect immediately after enabling CORS on the server: `qgisCloud.forgetCors()`, or wait 6 hours.

### 1.3 Known limitations

- The first read of a large file blocks the UI (synchronous request); formats read at random such as GeoPackage/GeoTIFF are fetched in chunks, usually a few requests suffice.
- Each browser tab caches independently; objects changed by another user/program become visible after 30 s or after refreshing the Browser panel.
- Multipart upload, versioning and ACLs are not supported; signatures for object keys containing characters such as `!'()*` may not match the server's.

## 2. Preset

`web/shell/presets/<name>.json`, selected with `?preset=<name>`, default `default`. The page writes it into the VFS; `QgsWasmPreset::apply()` (`src/app/qgswasmpreset.cpp`) applies it before the main window is created:

| Field | Meaning | Handled by |
|---|---|---|
| `settings` | Any QGIS settings key (`qgis/checkVersion`, `connections/xyz/items/X/url`…), written to the user profile on the **first** run; if the user changes it later, the user's value wins | QGIS |
| `enforce` | Written on every startup (organisation enforcement) | QGIS |
| `basemaps` | XYZ connections (Browser → XYZ Tiles; `basemaps_list/use`), synced on every startup | QGIS |
| `favorites` | Browser panel favorites, for example `/cloud` | QGIS |
| `plugins_cpp` | Static C++ plugins enabled on first startup | QGIS |
| `mounts` / `share` | Cloud storage mounts; the mount and prefix used for shared projects (see above) | Page |
| `sources` | Query data sources: `[{ name, type: "ogcapi" \| "catalog" \| "geojson", title, url, … }]`, which become `sources_*` tools, the Plugins → Data sources menu and `?add=source://…` links ([docs/06](06-architecture.md) §4) | Page |
| `plugins` | Web plugins (ES module URL) | Page |
| `plugins_python` / `python` | Python plugins (directory URL + `files.json`, a zip, or a virtual filesystem directory) and Pyodide's `indexUrl` (default jsDelivr 0.27.7; an intranet deployment can point at its own mirror) | Page |
| `open` | File/project to open at startup (`?open=` appends) | Page |
| `agent` | Web Agent configuration: `provider`, `baseUrl`, `model`, `apiKey`, `systemPrompt`, `mcpServers`, `skills`, `tools.confirm`, `ui` ([docs/05](05-web-agent.md) §4.5) | Page (web/agent) |

A preset is a static file, effective as soon as it is deployed; one deployment can carry several presets (team, project, demo). The page writes `origin` into the preset so the QGIS side can build same-origin `/proxy` URLs.

## 3. Agent

### 3.1 Control surface: `QgsWasmBridge` (`src/app/qgswasmbridge.cpp`)

Each capability is a "tool" with a JSON schema (≈50: project, layers, features, style, canvas, expressions, Processing, settings, basemaps, files, UI, plugins, assistant). The same registry serves three kinds of callers: the page / Web plugins (`qgis.call`), MCP clients, and the built-in assistant. All tools run in the Qt event loop; `qgis_wasm_call()` from JS→C++ only queues (the rule in [docs/02](02-runtime-and-debugging.md) §2.1).

### 3.2 External agents: the MCP server (`scripts/serve.mjs`)

The static server is also an **MCP (Streamable HTTP) server**: `initialize`, `tools/list` and `tools/call` are forwarded to a connected page (the page subscribes over SSE at `/agent/events` and posts results back to `POST /agent/result`). The result of `canvas_export_image` carries an `image` content block, so the agent can "see" the map.

```bash
node scripts/serve.mjs --port 8123                       # after opening http://127.0.0.1:8123/:
claude mcp add --transport http qgis http://127.0.0.1:8123/mcp
# clients that only support stdio: node scripts/mcp-stdio.mjs http://127.0.0.1:8123/mcp
curl -s http://127.0.0.1:8123/agent/clients             # connected pages
curl -s -X POST http://127.0.0.1:8123/agent/call -H 'content-type: application/json' -d '{"tool":"state"}'   # direct call from a script
```

An agent on an internal system can therefore: query its own catalogue/data lake → `layers_add { uri: "<url or /cloud path>" }` → `layer_set_style` → `canvas_export_image` → `project_share` to send the link to a person.

### 3.3 The Web Agent on the page (`web/agent/`, see [docs/05](05-web-agent.md))

There is no longer an assistant panel inside QGIS. The agent is a separate module on the page, rendered in a slot of the page's **workspace** (`web/shell/workspace.js`, [docs/06](06-architecture.md)): a flat button in the bottom-right corner opens a card floating over the map, with the page functions in the header (Project / Share / Data / ⋯) and the agent in the body (it does not take QGIS' width, and can be dragged and resized; `ui.layout: "dock"` turns it into a docked side panel), plus a model loop + tool registry (QGIS tools / page tools / MCP / skills) + approval policy + three layers of configuration (default ← preset `agent` ← user localStorage). `assistant_ask / assistant_status / assistant_reset` remain as page tools, so `?ask=…`, MCP clients and `features.py --llm` work as before. `agent/agent.html?qgis=<server>` is a standalone page for the same agent (remote host, via `/agent/call`).

### 3.4 Trade-offs

- Why not run the MCP server inside QGIS: there is no socket listener in wasm, so the server must live outside the page (`serve.mjs`), and the QGIS side only needs a control surface.
- Why the agent lives in the web layer rather than in C++: everything it needs (≈50 QGIS tools + page tools) is already behind `window.qgis`; the model loop, streaming output, MCP, Markdown and drag-and-drop upload are native capabilities in JS, and a change takes effect on refresh without touching QGIS; when QGIS is upgraded the agent does not change a single line ([docs/05](05-web-agent.md) §3).
- The plugin system and the agent share one tool set, avoiding two APIs.
