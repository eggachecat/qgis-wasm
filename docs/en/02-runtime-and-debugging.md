# Runtime behaviour and debugging handbook

> Chinese original: [02-运行时与调试.md](../02-运行时与调试.md)

This document records the problems actually hit when running the QGIS desktop application in a browser, their causes, and how they were handled. Every conclusion comes from a reproduction in `tests/e2e/*` on Chrome 149 (headless + SwiftShader).

## 1. Startup sequence

```
index.html ─ qtloader.js ─▶ qgis.js (MODULARIZE, EXPORT_NAME=qgis_entry)
   │  qt.environment: QGIS_PREFIX_PATH=/qgis  PROJ_DATA=/proj  HOME=/home/web_user
   │  preRun: FS.mount(IDBFS, /home/web_user) + FS.syncfs(true)          ← user directory comes from IndexedDB
   │  qgis.data (19 MB) → /qgis/share/qgis/{resources,svg,fonts}, /proj, /qgis/share/demo
   ▼
main()  (QGIS' own src/app/main.cpp)
   ├─ Q_INIT_RESOURCE(images)        Qt resources in the static library (icons, splash screen, symbol SVG) must be referenced explicitly
   ├─ QgsApplication myApp(...)       QGIS_PREFIX_PATH → pkgDataPath=/qgis/share/qgis
   ├─ fontManager()->addUserFontDirectory(<data>/fonts)   Open Sans (used by the default style) ships in the bundle
   ├─ setMaxThreads(8)                every QThread is a Web Worker
   ├─ set defaults: do not download fonts, do not fetch feed.qgis.org (browser CORS blocks it)
   ├─ QgisApp  ── the real QGIS main window ── showMaximized() + size set explicitly to the screen (page) size
   ├─ completeInitialization()  →  sQgisWasmReady = true
   └─ QgsApplication::exec()    the main loop suspends/resumes via JSPI, main() never returns
```

On this machine (32 cores, tmpfs browser profile): the page is interactive after about 2 s (wasm instantiation), the QGIS main window at about 8 s, and opening the demo project and completing the parallel render at about 10 s; on a 12-core machine with Chrome 149, the main window measured 2.4 s and the demo render 10 s (for the performance differences see [docs/06](06-architecture.md) §7).

## 2. Key findings

### 2.1 JS → C++ calls must be queued into the Qt event loop

The Qt for WebAssembly main event loop is in a **JSPI suspended** state between two events. If JavaScript calls a C++ export function directly and that C++ then triggers a suspend on another stack (nested event loop, `QProgressDialog`, `processEvents(WaitForMoreEvents)` …), Qt's `QWasmSuspendResumeControl` records only one suspend point, and the main loop never receives a resume signal again — the symptoms: JS is still alive, all Qt timers stop, nothing is repainted, the page "freezes".

`qgis_wasm_open()` (`src/app/qgswasmapp.cpp`) therefore does exactly one thing: `QMetaObject::invokeMethod(app, [...]{ app->openFile(path); }, Qt::QueuedConnection)`, and Qt's own loop does the real work in `processEvents()`. `ccall` does not need `async` either. **Every JS entry point added from now on must follow this rule.**

The same rule applies to all **C++ entered from a JavaScript callback**, not just export functions: Qt wasm's `QNetworkReply::finished` is emitted synchronously from the browser fetch callback, and running code that opens a nested event loop (a `QgsBlockingNetworkRequest` download, a dialog) directly in that slot freezes all of QGIS. `QgsWasmAssistantDock` therefore queues every network reply with `QMetaObject::invokeMethod(..., QueuedConnection)` into the Qt event loop before handling it (the first version did not, and it froze when the assistant called `layers_add` to download data). How to tell: ask yourself whether the bottom of this C++ call stack is Qt's `processEvents()` or some JS callback.

### 2.2 The page's own UI and Qt's global event listeners

Qt for WebAssembly attaches pointer events on `window` (capture) and `keydown` (capture) and `copy/cut/paste` on `document`, and calls `preventDefault()` while handling them. The result is that clicking an input on the page layer (the workspace, the agent's chat box) does not give it focus and Ctrl+V never pastes — the e2e tests used `fill()`, which focuses programmatically, so this went unnoticed. `workspace.js` wraps `window/document.addEventListener` before Qt starts: listeners of these kinds registered afterwards skip events whose target is inside `.ws-root / .ws-menu / .qa-root`; page listeners that want to apply globally (Ctrl+Shift+Space) are marked `__wsPassthrough`. Qt canvas events inside the shadow DOM are already redirected to the host element at the window level and are unaffected. `features.py` regresses this with real clicks plus clipboard permission.

### 2.3 "Picking a file from the computer hangs": the page layer covered QGIS, not the dialog

Symptom: the "…" and "Load" buttons in the Data Source Manager, and even "Close" in the bottom-right corner, did nothing when clicked, while the rest of the application worked. Triage first suspected QFileDialog (it opens a nested event loop from the input callback of a secondary window): after adding the `ui_debug_dialog` diagnostic tool for comparison, the file dialog opened normally from the main loop, from any parent window, and with or without QGIS' 2886-character vector-format filter string; adding logging to `QgsFileWidget::openFileDialog()` showed the click never reached the slot at all. `document.elementFromPoint()` gave the answer: when the workspace is closed the card has `opacity: 0; pointer-events: none`, but the agent panel nested inside it set `pointer-events: auto` itself — a child's `pointer-events` is not constrained by the parent's `none` — so an invisible card swallowed every click on roughly the right third of the screen. Fix: `workspace.css` forces `pointer-events: none !important` and `visibility: hidden` on the closed-state `.ws-panel` and all of its descendants, and the agent panel was changed to `pointer-events: inherit`; `agent.py` regresses this with `elementFromPoint`. Lesson: any element on the page layer that covers the QGIS canvas must deactivate its whole subtree when closed; to triage "a region of QGIS does not respond to clicks", start with `elementFromPoint`. `ui_debug_dialog` (`kind: file | static | staticfilter | plain`, `parent: main | active | none`) is kept as a diagnostic tool.

### 2.4 The thread pool must be preloaded and bounded

QGIS' parallel rendering (`QgsMapRendererParallelJob`) uses one thread per layer, plus threads for the task manager, browser panel scans and so on. The Emscripten worker pool lazy-loads by default (`PTHREAD_POOL_DELAY_LOAD=1`): each worker instantiates the 130 MB module the first time it is used, and QGIS **waits synchronously** for render threads in many places (cancelling a task, `waitForFinished`) — once the main thread waits, the worker's load is stuck. Now:

- `PTHREAD_POOL_DELAY_LOAD=0`, pool size `clamp(hardwareConcurrency, 8, 16)`, all ready at startup;
- `QgsApplication::setMaxThreads(min(idealThreadCount, 8))`.

### 2.5 Differences caused by static linking

| Symptom | Cause | Handling |
|---|---|---|
| all icons `:/images/...` not found | `images.qrc` is compiled into `libqgis_core.a`; with no reference the linker drops it | `Q_INIT_RESOURCE(images)` in `main.cpp` |
| welcome page QML: `module "org.qgis.app" plugin "qgis_appplugin" not found` | QGIS links against `Qt::` unversioned targets, so `qt_import_qml_plugins` does not reach the dependency | `QgisWasmApp.cmake` links `qgis_appplugin` + `qgis_appplugin_init` explicitly |
| `duplicate symbol tinygltf::...`, `_GEOSQueryCallback` | two libraries each compiled an implementation | patch: keep only one in the static build / change to `static` |
| `QgsAuthManager::passwordHelperDisplayName` and others undefined | the auth data classes used by gui are only compiled under `WITH_AUTH` | core also compiles `qgsauthconfig.cpp`, `qgsauthmethodmetadata.cpp` when auth is off, plus two stubs |
| QScintilla `RunStyles<long,...>` undefined | on wasm32 `ptrdiff_t` is `long`, Scintilla assumes it equals `int` and does not instantiate | port patch |

### 2.6 Settings

QGIS 4's `QgsSettingsEntry*` (the new settings API) **reads only the user profile**, not `qgis_global_settings.ini` (the latter only affects old-style `QgsSettings` keys such as `qgis/checkVersion`). So browser-deployment defaults such as "do not download missing fonts" and "turn off the news feed" are written once in `main.cpp` after an `exists()` check, and users can still change them back in the options afterwards (the configuration is persisted in IDBFS).

### 2.7 Other runtime behaviour

**Files and paths**

- **A project must contain `<mapcanvas>`**. A project written headlessly by PyQGIS has no canvas extent, so `QgsMapCanvas` considers the setting invalid and draws nothing (native QGIS behaves the same); `scripts/make-demo-project.py` adds it.
- **The file dialog is not the browser's**. Qt wasm's "native" file dialog is really the browser's file picker/download, so `QFileDialog::getSaveFileName()` returns an empty string directly and Project → Save As… does nothing. `main.cpp` sets `Qt::AA_DontUseNativeDialogs` under Emscripten and uses Qt's own dialog instead, which browses the virtual filesystem and accepts an absolute path typed straight into the file name box.
  - Saving into a non-existent directory fails (as on the desktop): use "New Folder" in the dialog first, or save into an existing directory; `project_share` creates directories automatically.
  - The left-side bookmarks are pre-filled by `QgsWasmPreset::apply()`: the preset's `mounts` → `/cloud/<name>`, plus `favorites`, `/cloud`, `/home/web_user`, `/qgis/share/demo`; only directories that exist are added, and bookmarks the user added are kept.
  - Bookmarks are written to `FileDialog/shortcuts` in `QSettings( UserScope, "QtProject" )`, and `sidebarWidth` must be written as well: without it `QFileDialogPrivate::restoreWidgetState()` returns early on an empty splitter state and the bookmarks never take effect — one reason the earlier attempt to pre-fill `~/.config/QtProject.conf` looked "ineffective".
- **File I/O on cloud mounts is synchronous XHR** (`cloudfs.js`). The Emscripten filesystem lives on the main thread, and a worker's `read()` is proxied to the main thread, so the request completes synchronously on the main thread; a synchronous XHR on the main thread can only receive binary as `x-user-defined` text. The UI stalls during the first read of a large file: files up to 16 MB are fetched whole, larger ones in 4 MB chunks on demand; writes are a single `PUT` at `close()`.

**Settings and persistence**

- **Settings live in `window.localStorage`, not in a `.ini` file**. Under Emscripten `QgsUserProfile::initSettings()` does not call `QgsSettingsEntryBase::setupUserSettings()` (it would `QSettings::setDefaultFormat(IniFormat)` + `setPath(profile)`, and file-based QSettings relies on QLockFile/QSaveFile, which are unreliable on wasm), so Qt uses wasm's `NativeFormat` = `WebLocalStorageFormat`.
  - One record per key, prefix `qt-v0-<org>-<app>-`: QGIS itself is `qt-v0-QGIS-QGIS4-`, the file dialog is `qt-v0-QtProject-all-apps-`.
  - Writes hit storage immediately and survive a page refresh, independently of IDBFS. When debugging, look at `Object.keys(localStorage).filter(k => k.startsWith('qt-v0-'))` in the console.
  - "Reset configuration" = clear these keys, plus `/home/web_user` in IndexedDB. The profile directory (`/home/web_user/.local/share/QGIS/QGIS4/profiles/default`) holds only databases such as qgis.db and symbology-style.db, no QGIS4.ini.

**Windows, fonts and the first frame**

- **Windows**: Qt wasm draws top-level windows in the shadow DOM (the shadowRoot of `#qt-shadow-container`, one `<canvas>` per window); a modal dialog is a separate window (`canvases` count +1).
- **Title bar and the first frame**: Qt wasm draws its own title bar and frame for every top-level window that has one. The main window is the whole page, so `qgis-shell.js` injects styles into the shadow DOM that remove the entire title bar and frame of the maximized window.
  - Without frame margins Qt wasm does not pass the size to the QWidget, so `QgsWasmApp::showMainWindow` calls `setGeometry` explicitly 0 ms and 1000 ms after showing and on every page resize (this is what keeps the web agent panel docking and a narrowing page laid out correctly).
  - The `QgisApp` constructor restores the window geometry from the desktop; a browser has no saved state, so it falls back to "80% of the screen, 10% offset" — that frame is painted first and then maximized, which is the "small window in the top-left corner, then it fills the screen" that used to be visible.
  - Alternatives tried: `Qt::FramelessWindowHint` + setting the geometry before showing does make the first frame the full page, but the welcome page's QML view then stays at its minimum size and never recovers (Qt wasm never sends it a resize), so this was dropped.
  - What is done now is on the page layer: `onLoaded` puts an **opaque hold** on the loading page (`qgisLoading.hold({ opaque: true })`) and releases it only once the bridge is ready and at least 2.5 s have passed (capped at 6 s), so all intermediate frames happen behind the loading page; links with `?share= / ?open=` then continue behind a semi-transparent curtain.
- **Fonts**: Qt wasm bundles DejaVu Sans/Mono; the Open Sans used by the default style ships as static TTFs (FreeType rejects variable fonts). Any `.ttf/.otf` placed in `web/fonts/` is loaded by `addUserFontDirectory`.

**Network and threads**

- **Network**: `QNetworkAccessManager` → browser fetch, subject to CORS. `?open=https://…` / `window.qgisOpen(url)` first `fetch`es to `/home/web_user/downloads/` and then hands over to `QgisApp::openFile()`, so GDAL/OGR reads a local file and is not affected by the missing `/vsicurl/`.
- **User-Agent**: browsers forbid a page to set the `User-Agent` header, so `QgsNetworkAccessManager` no longer sets it under Emscripten (otherwise every request logs a console error).
- **JS → C++ tool calls**: `qgis_wasm_call(id, tool, json)` only queues (the rule in §2.1); `QgsWasmBridge::callFromJs` runs in the event loop and returns the result through `Module.qgisBridgeResolve`.
- **`QgsBlockingNetworkRequest` cannot be used on the main thread**: measured, its nested event loop never yields in this runtime (even the page's JS timers stop) and the whole tab hangs. So `files_download` / `layers_add(URL)` use a synchronous XMLHttpRequest inside EM_JS and write straight into the virtual filesystem (the same as cloudfs), while the assistant and MCP clients all use the asynchronous `QNetworkAccessManager`.

**Caching**

- **`qgis.js` and `qgis.wasm` must be a matching pair, and neither may be cached as an old version**. The `ASM_CONSTS` table in the glue JS is indexed by code addresses in the binary; after a rebuild, if the browser still holds the old `qgis.wasm` (or the old `qgis.js`), `main()` reports `ASM_CONSTS[code] is not a function` (inside `QWasmSuspendResumeControl`) as soon as it enters `QCoreApplication`, and the page shows nothing.
  - `scripts/serve.mjs` sends `Cache-Control: no-cache` + `ETag`/`Last-Modified` for all static files and handles `If-None-Match` → 304: every load revalidates but does not re-download 130 MB.
  - Deploying behind another static server, either enable ETag validation the same way (nginx: `etag on; add_header Cache-Control no-cache;`) or rename both files with a content hash. The temporary workaround on the user side is Ctrl+Shift+R to force a reload.

## 3. Debugging tools

| Tool | Purpose |
|---|---|
| `tests/e2e/smoke.py [--open path] [--remote URL]` | regression test: main window, project rendering (pixel sampling), remote files, modal dialogs |
| `tests/e2e/drive.py --page 'index.html?open=…' "click:x,y" "key:Escape" "wheel:0,-240" "js:<code>" "shot:<name>.png"` | scripted interaction and screenshots; `js:` has access to `qgisInstance` (the Emscripten Module: `FS`, `PThread`, `ENV`, `ccall`) |
| `?trace=1` | sets `QGIS_WASM_TRACE`; `QGIS_WASM_TRACE(...)` from `src/core/qgswasmtrace.h` prints key paths (render jobs, canvas refresh, project read, welcome page) to the browser console |
| `tests/e2e/stacks.py` | samples all workers via CDP (a thread blocked in `Atomics.wait` shows as idle — JSPI-suspended stacks are equally invisible; that is the practical limit of browser debugging) |
| `--profiling-funcs` (on by default) | `qgis.wasm` keeps function names, so browser DevTools shows readable wasm stacks |
| loading page (`index.html` + `loading.js`) | brand spinner (`brand.js`, replaceable by a deployment overlay); shows real MB, rate, per-file status, phase (download → compile → restore profile → start QGIS) and a carousel explaining how it works, driven by `qgis.bundle.json` (generated by `compress-bundle.mjs`: original / compressed size of every file); the byte counts come from counting a **clone** of the response in the `fetch` wrapper (the original response keeps its URL, so Chrome's wasm code cache is unaffected). `window.qgisLoadStats` records per-file bytes and milliseconds plus the timestamps of download completion and module readiness |
| `node scripts/serve.mjs --port 8123` | static server with COOP/COEP headers; without these two headers there is no `SharedArrayBuffer` and the threaded Qt build cannot start. `--shared --host 127.0.0.1 --public-url https://…` is the multi-user host shape (`scripts/deploy.sh`): a call must name its page, and the proxy only reaches hosts named in a preset |
| `node tests/serve-shared.test.mjs` | server behaviour in shared mode: page addressing, result ownership, proxy allowlist and redirects, dev-machine defaults unchanged; two temporary ports, fake pages over SSE, no browser |
| `tests/e2e/warm.py` | cold start vs warm start: the same browser profile loaded twice in a row; the second time `qgis.wasm/.data/.js` only send ETag revalidation headers on the wire (Resource Timing transferSize), main window ≈1 s; cold start is 1.4 s on a tmpfs profile and 8–13 s on the test machine's ext4 profile (the difference is the browser writing its cache to disk, not wasm compilation). Demonstrates that `no-cache + ETag` works properly together with Chrome's wasm compilation cache |
| `node tests/layering.test.mjs` | layering guard ([docs/06](06-architecture.md)): QGIS in the patch does not read the page (URLs, storage, page globals, model vocabulary), page modules touch QGIS only through `window.qgis` and the filesystem, the agent imports only its own directory, every literal tool call is registered by someone; no browser, runs in a second |
| `tests/e2e/features.py [--llm]` | feature regression: control surface, presets, S3 mounts (`tests/s3-mock.mjs` validates SigV4), Web/C++ plugins, Processing, map export, MCP, share links, and (`--llm`) the assistant + `tests/mock-mcp.mjs` |
| workspace → Debug view (`web/shell/debug.js`, the bug icon in the header) | see the logs of the page and of QGIS in one list: console.error/warn, uncaught exceptions, module stdout/stderr (Qt, GDAL/PROJ), the QGIS message log (bridge event `log`: provider / Processing / plugins), the duration of every tool call, main-thread stalls ≥100 ms, and the duration of every page task (progress.js: share, open snapshot, query, download); the header shows wasm heap / JS heap / threads / the three startup phases / mean tool-call time; filter by source, show errors only, copy all in one click. Collection cost: a 2000-entry ring buffer, at most 600 DOM rows, nothing rendered while closed (only the error count is accumulated); each log entry costs one array push and does not slow the system down — what is really expensive is an **open browser DevTools console** (tens of thousands of messages slow the page down; close it) |
| "worker sent an error! qgis.js:1: Uncaught RuntimeError: table index is out of bounds" (followed by "Uncaught [object ErrorEvent]") | a wasm trap in some pthread (render thread / task thread): an out-of-bounds function-table index in an indirect call — usually a wild function pointer (a vtable used after free, a data race between threads); it breaks only that thread and the main window keeps working. The browser hands the page only message / file / line number; the Error and the stack stay in the worker, so this one line alone is not enough to investigate. The page therefore wraps every `em-pthread` worker with a two-line blob preamble (`debug.js`): it listens for `error` inside the worker and forwards the wasm stack with function names (the build keeps `--profiling-funcs`) through a BroadcastChannel to the Debug view, in entries like `worker #3 (pthread 0x…) crashed: RuntimeError: … at QgsMapRendererParallelJob::…`. Next time it happens: Debug view → `qgis` filter → copy, and send that one entry together with its stack to locate it. **Consequence**: once a thread crashes, Emscripten marks the main thread (`_emscripten_thread_crashed`), and the next time the main thread waits for a lock (`emscripten_yield`) it throws the string `"unwind"`, tearing down all the C++ on the stack at that moment — so later tool calls report `Error: unwind`, or queue up and never get an answer, and the canvas stops refreshing ("nothing happens after setting the style" is usually this). The page therefore treats a crash as a state: `window.qgisCrash`, event `qgis-crash`, a red bar at the top of the page (Reload / Debug view / Copy report), and `qgis.call` reports both `unwind` and the silence that follows as "QGIS is no longer usable in this tab… reload" (the agent stops when it sees that line and does not retry); the crash report is stored in localStorage, and after a reload the first entry in the Debug view is "previous session … crashed", ready to copy at any time |
| tool calls report `Error: unwind` / queue up with no answer / the canvas does not move after a style change | see the previous row: this is the aftermath of an earlier crash of some worker thread, not the fault of that tool. There should be a red crash bar at the top of the page; if not, check the Debug view for `worker #N … crashed`. The only recovery is to reload the page |
| "stuck after sharing / nothing happens when opening a share link" | the former cause: `cloudfs` uses **synchronous XHR** to give QGIS the filesystem semantics it expects; sharing synchronously PUT a 9 MB GeoJSON on the main thread, and opening did a synchronous chunked GET, freezing the tab for the whole stretch and drawing no progress. Now a share writes under a write-behind lease and uploads asynchronously in parallel; opening a snapshot prefetches asynchronously first (straight to the key, no directory listing; `GDAL_DISABLE_READDIR_ON_OPEN=EMPTY_DIR` skips GDAL's directory scan when opening a file). What still briefly occupies the main thread is QGIS' own CPU work: `layer_set_source` makes OGR re-parse a large GeoJSON, and saving a project — the progress bar says "QGIS re-reads …". GeoJSON inside snapshots is now packed as GeoPackage ([docs/06](06-architecture.md), the sharing row): re-reads and every later render read a spatially indexed SQLite file instead of the whole JSON |
| browser console `qgis.call('state')`, `qgis.tools()`, `qgis.on('*', console.log)` | drive the control surface directly, observe events |
| `curl -X POST http://127.0.0.1:8123/agent/call -d '{"tool":"layers_list"}'` | call the QGIS in the page directly, without MCP |

## 4. Known limitations / future work

- **4 GiB memory ceiling (wasm32)**: the heap starts at 512 MB and grows on demand up to 4 GiB (`MAXIMUM_MEMORY=4GB`, the hard ceiling of 32-bit wasm), and it only grows. "<layer name>: Insufficient memory for image W×H" in the message bar means the heap failed to grow when the canvas for that layer was allocated in that frame (the ceiling was reached or the browser refused to grow it); that layer is not drawn in that frame and nothing crashes. Breaking through needs Memory64 (wasm64): Emscripten `-sMEMORY64=1`, all dependencies rebuilt, the JS glue of the Qt wasm platform plugin/loader made 64-bit (pointers become BigInt), the JSPI+threads+Memory64 combination unverified, roughly 10–20% slower, and no Safari support — estimated at several days to two weeks with no guaranteed result, so it is not being done now. What is done first instead: fewer render threads, a smaller image cache, chunked caching of large files in cloudfs.

- Startup needs about 152 MB downloaded (`qgis.wasm` 133 MB including function names + `qgis.data` 19 MB); a Release build without `--profiling-funcs` saves another 15 MB, and static assets could be switched to on-demand `fetch`.
- No Python, no SSL certificate management, no 3D; `/vsicurl/` is unavailable (GDAL is built without curl), so remote files are downloaded whole by `layers_add`/`files_download`, or read in chunks through a `/cloud` mount.
- The "Home", "/" and similar directory entries in the browser panel scan MEMFS/IDBFS; the "Cloud" favourite scans object storage (one ListObjectsV2 per directory, cached for 30 s).
- Text box IME, clipboard and drag-and-drop depend on how complete the Qt wasm platform plugin's implementation is.
