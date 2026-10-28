/**
 * qgis-shell.js — the browser side of QGIS Desktop for WebAssembly.
 *
 *  - loads the Qt/Emscripten module (qtloader.js) and the deployment preset (?preset=<name> → presets/<name>.json)
 *  - persistent user directory (IDBFS) and pluggable cloud mounts (cloudfs.js) → /cloud/<name>
 *  - window.qgis: promise based API over the QGIS control surface (QgsWasmBridge): qgis.call(tool, params),
 *    qgis.on(event, fn), qgis.tools(), qgis.open(urlOrPath), qgis.share(path) …
 *  - the page-side layers that know nothing about QGIS internals and that QGIS knows nothing about: the URL scheme
 *    and share links (link.js: ?open= ?add= ?basemap= ?extent= …, view_link) and query data sources (sources.js:
 *    OGC API Features / catalogues / GeoJSON APIs → sources_* tools, Plugins → Data sources menu, source:// links)
 *  - web plugins: ES modules listed in the preset (plugins/…) get the same API (docs/03-插件与迁移指南.md)
 *  - agent transport: the page registers with the static server (scripts/serve.mjs) over SSE and executes the tool
 *    calls that MCP clients (Claude Code, internal agents, …) send to POST /mcp
 *
 * Rule from docs/02: every call into C++ is queued into Qt's event loop (qgis_wasm_call) and resolved asynchronously.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const ui = { screen: $('screen'), log: $('log') };
  const log = (text, isError) => {
    (isError ? console.error : console.log)(text);
    if (isError && ui.log) ui.log.textContent += text + '\n';
  };

  // ------------------------------------------------------------------ loading page: index.html #loading, driven by loading.js
  const noop = () => {};
  const loading = window.qgisLoading || { setStage: noop, setManifest: noop, setPreset: noop, wrapFetch: noop, emscripten: noop, finish: noop, fail: noop, hold: () => noop };

  window.qgisStatus = 'loading';
  window.qgisInfo = { threads: typeof SharedArrayBuffer !== 'undefined', jspi: !!WebAssembly.Suspending, crossOriginIsolated: self.crossOriginIsolated };
  if (!self.crossOriginIsolated) log('Warning: page is not cross-origin isolated (COOP/COEP headers missing); threads are unavailable.', true);

  // ------------------------------------------------------------------ Qt window decorations
  // Qt for WebAssembly decorates top-level windows with its own title bar (minimise / maximise / close buttons)
  // and border. The maximised QGIS main window *is* the page: its decorations are removed entirely; dialogs keep
  // theirs. (Without the bar Qt does not propagate the full size to the main widget — QgsWasmApp sets it explicitly;
  // the frames before that happen behind the loading screen, see onLoaded below.)
  const styleQtFrames = () => {
    const root = document.querySelector('#qt-shadow-container')?.shadowRoot;
    if (!root) return false;
    if (!root.querySelector('#qgis-shell-style')) {
      const style = document.createElement('style');
      style.id = 'qgis-shell-style';
      style.textContent = [
        '.qt-decorated-window.maximized > .title-bar { display: none !important; }',
        '.qt-decorated-window.maximized { border: none !important; box-shadow: none !important; }',
      ].join('\n');
      root.appendChild(style);
    }
    return true;
  };
  const frameTimer = setInterval(() => { if (styleQtFrames()) clearInterval(frameTimer); }, 50);

  // ------------------------------------------------------------------ bridge (window.qgis)
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  let instance = null;
  let readyResolve;
  const readyPromise = new Promise((r) => { readyResolve = r; });
  let presetResolve;
  const presetPromise = new Promise((r) => { presetResolve = r; });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- after a worker thread crash. debug.js relays the crash out of the worker (window.qgisCrash, window event
  //     "qgis-crash"); from then on the C++ side is not trustworthy: Emscripten makes the main thread throw the string
  //     "unwind" out of whatever is on its stack the next time it waits for a lock (system/lib/pthread/emscripten_yield.c,
  //     after _emscripten_thread_crashed), so qgis_wasm_call throws "unwind" or a queued tool never answers. Both become
  //     one clear error here — the agent stops retrying and the user knows to reload — instead of "Error: unwind".
  const crash = { detail: window.qgisCrash || null };
  const crashMessage = () => {
    const d = crash.detail;
    return `QGIS is no longer usable in this tab: ${d && d.thread ? `a QGIS worker thread crashed (${d.message})` : `the QGIS main thread was unwound (${d ? d.message : 'a worker thread crashed earlier'})`}. Reload the page to continue; the crash report is in the Debug view and is kept for the next start. Do not retry the call.`;
  };
  const failPending = (olderThanMs) => { for (const [id, p] of pending) if (performance.now() - p.at >= olderThanMs) { pending.delete(id); p.reject(new Error(crashMessage())); } };
  const crashError = (e) => {
    if (!crash.detail) {
      crash.detail = { at: Date.now(), message: `main thread unwound: ${String((e && e.message) || e)}` };
      window.qgisCrash = window.qgisCrash || crash.detail;
      window.qgisStatus = 'crashed';
      try { window.dispatchEvent(new CustomEvent('qgis-crash', { detail: crash.detail })); } catch (err) { /* ignore */ }
    }
    const err = new Error(crashMessage()); err.cause = e; return err;
  };
  window.addEventListener('qgis-crash', (ev) => {
    if (!crash.detail) crash.detail = ev.detail;
    window.qgisStatus = 'crashed';
    setTimeout(() => failPending(0), 10000); // calls already queued get 10 s to answer; new ones are capped below
  });

  // tools implemented on the page itself (they need the page: URLs, downloads, mounts)
  const jsTools = {
    mounts_list: {
      description: 'List the cloud storage mounts of this page (/cloud/<name>) with their type and configuration (secrets hidden).',
      inputSchema: { type: 'object', properties: {} },
      async run() { return window.qgisCloud ? window.qgisCloud.list() : []; },
    },
    mounts_add: {
      description: 'Mount object storage at /cloud/<name>: type "s3" (endpoint, bucket, prefix, region, accessKeyId, secretAccessKey, pathStyle), type "swift" (url = https://host/v1/AUTH_account/container, prefix, token) or type "http" (baseUrl, index). proxy: true routes requests through the same-origin /proxy for servers without CORS.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['s3', 'swift', 'http'] }, url: { type: 'string' }, token: { type: 'string' }, proxy: { type: 'boolean' }, endpoint: { type: 'string' }, bucket: { type: 'string' }, prefix: { type: 'string' }, region: { type: 'string' }, accessKeyId: { type: 'string' }, secretAccessKey: { type: 'string' }, pathStyle: { type: 'boolean' }, baseUrl: { type: 'string' }, index: { type: 'string' }, persist: { type: 'boolean', description: 'remember this mount in the browser (localStorage)' } }, required: ['type'] },
      async run(cfg) { return { path: qgis.mount(cfg) }; },
    },
    download: {
      description: 'Download a URL into the virtual filesystem (default /home/web_user/downloads/<name>) and return the local path, e.g. to pass it to layers_add or project_open.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string', description: 'target path (optional)' } }, required: ['url'] },
      async run({ url, path }) { return { path: await download(url, path) }; },
    },
    file_base64: {
      description: 'Read a file of the virtual filesystem as base64 (e.g. an image exported with canvas_export_image).',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      async run({ path }) {
        const bytes = instance.FS.readFile(path);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        const mimeType = /\.png$/i.test(path) ? 'image/png' : /\.jpe?g$/i.test(path) ? 'image/jpeg' : /\.(geo)?json$/i.test(path) ? 'application/json' : 'application/octet-stream';
        return { path, size: bytes.length, mimeType, base64: btoa(bin) };
      },
    },
    python_run: {
      description: 'Run Python (PyQGIS style) code in the page: Pyodide + the qgis.core / qgis.gui / qgis.utils / processing compatibility layer that drives this QGIS instance. Returns the value of the last expression. Example: "from qgis.core import QgsProject\\n[l.name() for l in QgsProject.instance().mapLayers().values()]"',
      inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
      async run({ code }) { return { result: await window.qgisPython.run(code) }; },
    },
    python_plugins: {
      description: 'Python plugins: action "list" (loaded plugins), "load" (source = directory URL with files.json, .zip URL, or a virtual filesystem directory such as /cloud/<mount>/plugins/<id>), "unload" (id).',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'load', 'unload'] }, source: { type: 'string' }, id: { type: 'string' } }, required: ['action'] },
      async run({ action, source, id }) {
        if (action === 'load') return window.qgisPython.loadPlugin(source);
        if (action === 'unload') return { unloaded: await window.qgisPython.unloadPlugin(id) };
        return window.qgisPython.list();
      },
    },
    page_info: {
      description: 'Information about this browser page: URL, preset name, mounts, whether threads/JSPI are available.',
      inputSchema: { type: 'object', properties: {} },
      async run() { return { url: location.href, origin: location.origin, preset: window.qgisPreset?.name, mounts: window.qgisCloud ? window.qgisCloud.list() : [], mcp: window.qgisAgentMcpUrl || null, ...window.qgisInfo }; },
    },
    upload: {
      description: 'Store a file given as base64 in the virtual filesystem (default /home/web_user/uploads/<name>) and return its path, e.g. for files dropped into the agent panel.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, base64: { type: 'string' }, path: { type: 'string', description: 'target path (optional)' } }, required: ['name', 'base64'] },
      async run({ name, base64, path }) {
        const target = path || `/home/web_user/uploads/${String(name).replace(/[\\/]/g, '_')}`;
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        instance.FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
        instance.FS.writeFile(target, bytes);
        return { path: target, size: bytes.length };
      },
    },
  };

  async function download(url, target) {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'download.bin');
    const task = window.qgisProgress ? window.qgisProgress.begin(`Downloading ${name}`, { detail: url.length > 90 ? url.slice(0, 87) + '…' : url }) : null; // the workspace / loading page show it
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      const total = Number(res.headers.get('content-length')) || null;
      let buf;
      if (res.body && task) { // stream it, so the bytes show as they arrive
        const reader = res.body.getReader(), chunks = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.byteLength; task.update({ done: got, total, unit: 'bytes' }); }
        buf = new Uint8Array(got); let o = 0; for (const ch of chunks) { buf.set(ch, o); o += ch.byteLength; }
      } else buf = new Uint8Array(await res.arrayBuffer());
      const path = target || `/home/web_user/downloads/${name}`;
      instance.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
      instance.FS.writeFile(path, buf);
      window.qgisLink?.remember(path, url); // so that view_link can reproduce layers made from it
      task?.finish();
      return path;
    } catch (e) { task?.fail(e); throw e; }
  }

  const qgis = {
    /** Resolves once QGIS accepts tool calls */
    ready: readyPromise,
    get instance() { return instance; },
    get preset() { return window.qgisPreset; },
    /** Resolves with the deployment preset once presets/<name>.json has been read (or failed) — page scripts that boot
     *  on their own (the agent module) wait for this instead of racing the fetch */
    presetReady: presetPromise,

    /** Call a tool of the control surface. Rejects with the tool's error message. */
    async call(tool, params = {}) {
      if (jsTools[tool]) return jsTools[tool].run(params || {});
      await readyPromise;
      const id = nextId++;
      const json = JSON.stringify(params || {});
      const result = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, tool, at: performance.now() });
        const attempt = () => {
          if (!instance) return reject(new Error('QGIS is not running'));
          let accepted;
          try { accepted = instance.ccall('qgis_wasm_call', 'number', ['number', 'string', 'string'], [id, tool, json]); }
          catch (e) { pending.delete(id); return reject(crashError(e)); } // "unwind": see above
          if (accepted) { if (crash.detail) setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(crashMessage())); } }, 15000); return; }
          setTimeout(attempt, 300); // QGIS still starting up
        };
        attempt();
      });
      // layers added straight from a URL (QGIS downloads them): remember the origin so that view_link can reproduce them
      if (tool === 'layers_add' && Array.isArray(result) && /^https?:\/\//i.test(params?.uri || '') && window.qgisLink) for (const l of result) window.qgisLink.remember(l.id, params.uri);
      return result;
    },
    /** MCP style manifest of all tools: QGIS tools (source "qgis") + page tools (source "shell" or the registrant's) */
    async tools() {
      const native = (await qgis.call('tools_list')).map((t) => ({ ...t, source: 'qgis' }));
      const page = Object.entries(jsTools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, source: t.source || 'shell' }));
      return [...native, ...page];
    },
    /** Add a page tool (web plugins, the web agent): { description, inputSchema, run(params), source? } */
    registerTool(name, def) {
      if (!name || typeof def?.run !== 'function') throw new Error('registerTool(name, { description, inputSchema, run })');
      jsTools[name] = { description: def.description || '', inputSchema: def.inputSchema || { type: 'object', properties: {} }, source: def.source || 'page', run: def.run };
      return true;
    },
    unregisterTool(name) { return delete jsTools[name]; },
    /** Page-side event (listeners registered with on()) */
    emit(type, payload = {}) { dispatch(type, payload); },
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); return () => qgis.off(event, fn); },
    off(event, fn) { listeners.get(event)?.delete(fn); },
    /** Download (if URL) and add as layer(s) through layers_add (no dialogs). Project files open as projects. */
    async open(target, extra = {}) {
      const path = /^https?:\/\//i.test(target) ? await download(target) : target;
      return qgis.call('layers_add', { uri: path, ...extra });
    },
    /** Link that opens a (cloud) path in this deployment, optionally at a canvas extent (link.js owns the URL scheme) */
    share(path, extent = null) {
      // a stored snapshot (share.js) gets its short link; any other cloud path opens by path
      const id = window.qgisShare ? window.qgisShare.idOf(path) : null;
      return window.qgisLink.build({ preset: window.qgisPreset?.name, ...(id ? { share: id } : { open: [path] }), extent: extent && extent.xmin !== undefined ? extent : null });
    },
    mount(cfg) {
      const path = window.qgisCloud.mount(cfg);
      if (cfg.persist) {
        try {
          const saved = JSON.parse(localStorage.getItem('qgis-wasm.mounts') || '[]').filter((m) => m.name !== cfg.name);
          saved.push({ ...cfg, persist: undefined });
          localStorage.setItem('qgis-wasm.mounts', JSON.stringify(saved));
        } catch (e) { log(`could not persist mount: ${e.message}`, true); }
      }
      qgis.call('ui_message', { title: 'Cloud', text: `Mounted ${cfg.type} storage at ${path} (Browser panel → Favorites → Cloud)`, level: 'success', duration: 8 }).catch(() => {});
      return path;
    },
    mounts() { return window.qgisCloud.list(); },
    /** Persistent user directory: flush to IndexedDB now */
    sync() { return new Promise((r) => instance.FS.syncfs(false, r)); },
  };
  window.qgis = qgis;

  const dispatch = (type, payload) => {
    for (const fn of listeners.get(type) || []) { try { fn(payload, type); } catch (e) { log(`listener error (${type}): ${e.message}`, true); } }
    for (const fn of listeners.get('*') || []) { try { fn(payload, type); } catch (e) { log(`listener error (*): ${e.message}`, true); } }
  };

  // ------------------------------------------------------------------ agent transport (MCP via scripts/serve.mjs)
  async function connectAgentTransport() {
    // a static host (GitHub Pages, a CDN) has no agent transport and no /mcp: ask first, otherwise EventSource would retry
    // forever. serve.mjs (every version) answers OPTIONS with 204; static servers answer 405 / 501 or fall back to index.html
    try { const probe = await fetch('mcp', { method: 'OPTIONS', cache: 'no-store' }); if (probe.status !== 204) return; } catch (e) { return; }
    // the id is the only thing that lets an MCP client address this page on a shared server, so it must be unguessable
    const clientId = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    let source;
    try { source = new EventSource(`agent/events?client=${clientId}&title=${encodeURIComponent(document.title)}`); } catch (e) { return; }
    source.addEventListener('hello', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        window.qgisAgentMcpUrl = d.mcp; window.qgisAgentShared = !!d.shared;
        log(`MCP endpoint of this page: ${d.mcp}`);
      } catch (e) { /* ignore */ }
    });
    source.addEventListener('call', async (ev) => {
      const { id, tool, params } = JSON.parse(ev.data);
      let body;
      try {
        if (tool === 'tools/list') body = { ok: true, result: await qgis.tools() };
        else body = { ok: true, result: await qgis.call(tool, params) };
      } catch (e) {
        body = { ok: false, error: e.message || String(e) };
      }
      fetch('agent/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, client: clientId, ...body }) }).catch(() => {});
    });
    source.onerror = () => { /* server without the agent endpoint, or restarting: EventSource retries by itself */ };
    window.qgisAgentClientId = clientId;
  }

  // ------------------------------------------------------------------ startup
  (async () => {
    // 1. deployment preset, and the build's list of files served next to qgis.js instead of inside qgis.data
    const presetName = params.get('preset') || 'default';
    const lazyAssets = fetch('qgis.lazy.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const bundleInfo = fetch('qgis.bundle.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let preset = {};
    try {
      const res = await fetch(`presets/${presetName}.json`, { cache: 'no-cache' });
      if (res.ok) preset = await res.json();
      else if (params.has('preset')) log(`preset "${presetName}" not found (presets/${presetName}.json)`, true);
    } catch (e) { log(`preset load failed: ${e.message}`, true); }
    preset.name = presetName;
    preset.origin = location.origin;
    window.qgisPreset = preset;
    if (preset.title) document.title = preset.title;
    presetResolve(preset);
    loading.setPreset(preset);
    // a link that opens a project (?share=<id>, ?open=…, the preset's "open" list) keeps the loading page up — as a veil
    // over the appearing QGIS — until that project is in: the page shows the download of the snapshot instead of a map
    // that fills in later (loading.js hold; released by link.apply once the project part is done)
    const startLink = window.qgisLink ? window.qgisLink.parse() : { share: null, open: (params.get('open') || '').split(',').filter(Boolean) };
    const releaseHold = startLink.share || startLink.open.length || (preset.open || []).length ? loading.hold() : noop;
    // page-side layers (tools registered now, menus once QGIS is up): URL scheme / sharing, query data sources, the workspace panel
    if (window.qgisLink) window.qgisLink.init(qgis);
    if (window.qgisSources) window.qgisSources.init(qgis, preset);
    if (window.qgisShare) window.qgisShare.init(qgis, preset); // project_share / share_open / share_refresh, ?share=<id>
    if (window.qgisDebug) window.qgisDebug.attach(qgis, preset); // times every tool call, records QGIS events and its message log
    if (window.qgisWorkspace) { try { window.qgisWorkspace.init(qgis, preset, { screen: ui.screen }); } catch (e) { log(`workspace failed: ${e.message}`, true); } }
    const lazy = await lazyAssets;
    loading.setManifest(await bundleInfo);
    loading.wrapFetch();
    loading.setStage('Downloading QGIS');

    // 2. the module
    try {
      const config = {
        qt: {
          entryFunction: window.qgis_entry,
          containerElements: [ui.screen],
          environment: {
            QGIS_PREFIX_PATH: '/qgis',
            PROJ_DATA: '/proj',
            HOME: '/home/web_user',
            QGIS_LOG_FILE: '',
            QGIS_WASM_PRESET: '/tmp/qgis-wasm-preset.json',
            GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR', // no directory scan for sibling files on open: on a cloud mount each scan is a listing round trip
            ...(params.has('trace') ? { QGIS_WASM_TRACE: '1' } : {}),
            ...(params.get('qtlog') ? { QT_LOGGING_RULES: params.get('qtlog') } : {}), // e.g. ?qtlog=qt.qpa.*=true — Qt's own categories, to the console / Debug view
          },
          onLoaded: () => {
            window.qgisStatus = 'loaded';
            // the main window appears at QGIS' desktop default geometry and is maximised a moment later (docs/02):
            // the loading screen stays opaque until the window has settled — QgisApp is initialised (the bridge is up,
            // which comes right after the maximised frame) plus a moment for that frame to paint. The cap is a safety
            // net only: before it was 6 s, shorter than a cold start, and the small window showed through.
            const settled = loading.hold({ opaque: true, timeoutMs: 45000 });
            const t0 = performance.now();
            const tryRelease = () => { if (window.qgisBridgeReady === true && performance.now() - t0 >= 1200) setTimeout(settled, 400); else setTimeout(tryRelease, 100); };
            setTimeout(tryRelease, 1200);
            loading.finish();
          },
          onExit: (e) => { window.qgisStatus = 'exited'; loading.fail(`QGIS exited (code ${e.code ?? '?'}) ${e.text ?? ''}`); },
        },
        arguments: ['--noversioncheck', '--globalsettingsfile', '/qgis/share/qgis/resources/qgis_global_settings.ini'],
        preRun: [(module) => {
          loading.setStage('Restoring your profile and mounting cloud storage');
          // persistent user profile in IndexedDB
          module.FS.mkdirTree('/home/web_user');
          module.FS.mount(module.IDBFS, {}, '/home/web_user');
          module.addRunDependency('qgis-idbfs');
          module.FS.syncfs(true, (err) => { if (err) console.warn('IDBFS restore failed', err); module.removeRunDependency('qgis-idbfs'); });
          // the preset for QgsWasmPreset::apply()
          module.FS.mkdirTree('/tmp');
          module.FS.writeFile('/tmp/qgis-wasm-preset.json', JSON.stringify(preset));
          // (file dialog sidebar bookmarks for the mounts are written by QgsWasmPreset::apply(); Qt keeps QSettings in
          //  window.localStorage on wasm, not in a .conf file)
          // cloud mounts (before main(): the Browser panel sees them from the start)
          if (window.qgisCloud) {
            window.qgisCloud.init(module, (m) => console.log(m));
            let saved = [];
            try { saved = JSON.parse(localStorage.getItem('qgis-wasm.mounts') || '[]'); } catch (e) { /* ignore */ }
            for (const m of [...(preset.mounts || []), ...saved]) {
              try { window.qgisCloud.mount(m); } catch (e) { log(`mount ${m.name || m.type} failed: ${e.message}`, true); }
            }
            // files the build left out of qgis.data (qgis.lazy.json, cmake/QgisWasmApp.cmake): a read-only HTTP mount
            // next to qgis.js plus a link from each file's original place to it — QGIS opens the usual path and the
            // bytes are fetched on first read (world_map.gpkg: CRS selector preview, status bar easter eggs)
            if (lazy && Array.isArray(lazy.files) && lazy.files.length) {
              try {
                const mountPath = window.qgisCloud.mount({ type: 'http', name: 'lazy', url: new URL('.', location.href).href, files: lazy.files, path: '/qgis/share/qgis/lazy', internal: true });
                for (const f of lazy.files) {
                  module.FS.mkdirTree(f.vfs.slice(0, f.vfs.lastIndexOf('/')));
                  try { module.FS.unlink(f.vfs); } catch (e) { /* nothing there yet */ }
                  module.FS.symlink(`${mountPath}/${f.path}`, f.vfs);
                }
                window.qgisLazyAssets = lazy.files.map((f) => ({ ...f, mount: `${mountPath}/${f.path}` }));
              } catch (e) { log(`lazy assets failed: ${e.message}`, true); }
            }
          }
        }],
        setStatus: (text) => loading.emscripten(text),
        // the module's stdout/stderr (Qt warnings, QGIS messages, GDAL/PROJ errors): console + the debug view
        print: (t) => { console.log(t); window.qgisDebug?.qgis('info', t); },
        printErr: (t) => { console.warn(t); window.qgisDebug?.qgis(/critical|error|fatal/i.test(t) ? 'error' : 'warn', t); },
        // C++ → page
        qgisBridgeResolve: (id, json) => {
          const p = pending.get(id);
          if (!p) return;
          pending.delete(id);
          let res;
          try { res = JSON.parse(json); } catch (e) { return p.reject(new Error(`bad bridge reply for ${p.tool}`)); }
          res.ok ? p.resolve(res.result) : p.reject(new Error(res.error || `tool ${p.tool} failed`));
        },
        qgisBridgeEvent: (type, json) => {
          let payload = {};
          try { payload = JSON.parse(json); } catch (e) { /* ignore */ }
          if (type === 'ready') { readyResolve(); window.qgisBridgeReady = true; }
          dispatch(type, payload);
        },
      };
      instance = await qtLoad(config);
      window.qgisInstance = instance;
      const sync = () => instance.FS.syncfs(false, () => {});
      setInterval(sync, 15000);
      window.addEventListener('pagehide', sync);

      // 3. legacy entry point used by tests/docs: open through QgisApp::openFile() (with QGIS' own dialogs)
      const openInQgis = async (path) => { for (;;) { if (instance.ccall('qgis_wasm_open', 'number', ['string'], [path])) return true; await sleep(500); } };
      window.qgisOpen = async (target) => {
        const path = /^https?:\/\//i.test(target) ? await download(target) : target;
        console.log('qgisOpen: opening', path);
        await openInQgis(path);
        console.log('qgisOpen: done', path);
        return path;
      };

      connectAgentTransport();
      await readyPromise;

      // 4. web plugins
      for (const url of preset.plugins || []) {
        try {
          const mod = await import(new URL(url, location.href).href);
          const activate = mod.default || mod.activate;
          if (typeof activate === 'function') await activate(qgis);
          console.log('plugin loaded', url);
        } catch (e) { log(`plugin ${url} failed: ${e.message}`, true); }
      }

      // 4b. Python plugins (Pyodide + PyQGIS compatibility layer): Pyodide alone is a ≈10 s download, so this runs
      // alongside the link below — a shared project must not wait for Python it does not use
      qgis.python = window.qgisPython;
      const pythonPlugins = (async () => {
        for (const src of preset.plugins_python || []) {
          try { await window.qgisPython.loadPlugin(src); } catch (e) { log(`python plugin ${src} failed: ${e.message}`, true); }
        }
      })();

      // 5. the link (link.js): the preset's "open" list first, then ?open= ?add= ?basemap= ?crs= ?extent=
      const link = window.qgisLink ? window.qgisLink.parse() : { open: (params.get('open') || '').split(',').map((s) => s.trim()).filter(Boolean), add: [] };
      link.open = [...(preset.open || []), ...link.open];
      if (window.qgisLink) window.qgisLink.apply(qgis, link, { log, afterProject: releaseHold }).catch((e) => log(`link failed: ${e.message}`, true)).finally(releaseHold);
      else (async () => { for (const target of link.open) await window.qgisOpen(target).catch((e) => log(`open failed: ${e.message}`, true)); })().finally(releaseHold);
      await pythonPlugins;
      // 6. ?ask=<question> for demos: wait until the Assistant is configured and idle, then ask
      if (params.get('ask')) {
        (async () => {
          for (let i = 0; i < 60; i++) {
            try {
              const st = await qgis.call('assistant_status');
              if (st.configured && !st.busy) { await qgis.call('assistant_ask', { text: params.get('ask') }); return; }
              if (!st.configured && i > 10) { log('ask: the Assistant is not configured (preset "agent" section)', true); return; }
            } catch (e) { /* QGIS still starting */ }
            await sleep(1000);
          }
          log('ask: the Assistant did not become ready', true);
        })();
      }
    } catch (e) {
      window.qgisStatus = 'exited';
      loading.fail('Failed to start QGIS — details in the console');
      log(e && (e.stack || e.message || String(e)), true);
    }
  })();
})();
