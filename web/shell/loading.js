/**
 * loading.js — the loading page (index.html #loading): the brand's spinner (brand.js), real megabytes instead of a bare
 * bar, the stage the browser is in and a rotating note on why. The bytes of qgis.wasm / qgis.data are counted as they
 * stream (a clone of the response is read in parallel; the original keeps its URL, so Chrome's compiled-code cache
 * still applies) against the sizes in qgis.bundle.json (scripts/compress-bundle.mjs).
 *
 * It is a listener of the page's task bus (progress.js): while it is up, the most recent task is the stage line and
 * the bar. Two kinds of hold keep it up after QGIS reports running: the shell's "settle" hold (opaque: the main
 * window is shown at QGIS' desktop default geometry first and maximised a moment later — those frames stay behind
 * the loading screen) and a link that opens a project (?share=<id>, ?open=…), which turns it into a translucent veil
 * over the window until that project is in, so a shared link shows "downloading 9 MB of layer data" with a rate
 * rather than an empty map that fills in later.
 *
 *   window.qgisLoading.setStage(text) .setManifest(bundle) .setPreset(preset) .wrapFetch() .emscripten(text)
 *                     .finish(text) .fail(text) .hold({ opaque, timeoutMs }) → release()
 *   window.qgisLoadStats: { files, startedAt, downloadDoneAt, loadedAt, hiddenAt, stages } (tests/e2e/warm.py reads it)
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const el = { root: $('loading'), stage: $('ld-stage'), elapsed: $('ld-elapsed'), bar: $('ld-bar'), fill: $('ld-fill'), meter: $('ld-meter'), speed: $('ld-speed'), files: $('ld-files'), fact: $('ld-fact'), foot: $('ld-foot') };
  const files = new Map(); // name → { size, wire, loaded, done, t0, t1, li }
  const stats = { files: {}, startedAt: performance.now(), downloadDoneAt: null, loadedAt: null, hiddenAt: null, stages: [] };
  window.qgisLoadStats = stats;
  const mb = (n) => (n >= 1e7 ? (n / 1e6).toFixed(0) : (n / 1e6).toFixed(1)) + ' MB';
  const FACTS = (window.qgisBrand && Array.isArray(window.qgisBrand.facts) && window.qgisBrand.facts.length) ? window.qgisBrand.facts : [
    '<b>This is QGIS itself.</b> The desktop application\'s C++ and Qt code is compiled to WebAssembly; the map renders in worker threads inside your browser. Nothing runs on a server.',
    '<b>One download, then cached.</b> The bundle is ≈34 MB compressed. Your browser keeps it, and the machine code it compiled, so the next start takes about a second.',
    '<b>Why the wait?</b> 134 MB of code are compiled while they stream in; modal dialogs become suspended WebAssembly stacks (JSPI); worker threads share memory, which is why the page needs COOP/COEP headers.',
    '<b>Your files stay with you.</b> /home/web_user lives in this browser (IndexedDB); /cloud/&lt;name&gt; mounts object storage as folders; projects and views can be shared as links.',
    '<b>Data on request.</b> Query sources — OGC API Features, catalogues, OpenStreetMap, a team\'s own services — show up as tools, menu entries and link parameters; QGIS only sees files.',
    '<b>An agent can drive it.</b> The workspace\'s assistant and any MCP client such as Claude Code use the same ≈55 tools over one small contract (window.qgis).',
  ];
  let factIdx = 0, factTimer = 0, tick = 0, finished = false, hidden = false, stage = '', holds = 0, opaqueHolds = 0, task = null, taskTimer = 0;
  const holdStage = () => (holds > opaqueHolds ? 'QGIS is running — opening the project' : 'QGIS is running — laying out the window');
  const applyHoldLook = () => { if (!finished || hidden) return; el.root?.classList.toggle('veil', opaqueHolds === 0); };
  const setFact = () => { if (!el.fact) return; el.fact.style.opacity = '0'; setTimeout(() => { el.fact.innerHTML = FACTS[factIdx++ % FACTS.length]; el.fact.style.opacity = '1'; }, 350); };

  function render() {
    if (!el.fill) return;
    let total = 0, loaded = 0, active = false;
    for (const f of files.values()) { total += f.size; loaded += Math.min(f.loaded, f.size); if (f.loaded && !f.done) active = true; }
    const done = files.size > 0 && [...files.values()].every((f) => f.done);
    if (task) { // a page task owns the bar while it runs (after the download, or on top of it)
      const fr = task.fraction;
      el.bar.classList.toggle('indeterminate', fr == null);
      if (fr != null) el.fill.style.width = `${(100 * fr).toFixed(1)}%`;
      el.meter.textContent = window.qgisProgress ? window.qgisProgress.describe(task) : task.detail;
      el.speed.textContent = '';
      return;
    }
    el.bar.classList.toggle('indeterminate', !total || (done && !finished));
    if (total) el.fill.style.width = `${Math.min(100, (100 * loaded) / total).toFixed(1)}%`;
    el.meter.textContent = total ? `${mb(loaded)} of ${mb(total)}${done ? ' · downloaded' : ''}` : '';
    const dl = [...files.values()].filter((f) => f.loaded && f.t0);
    if (active && dl.length) { const t = Math.max(...dl.map((f) => (f.t1 || performance.now()) - f.t0)) / 1000; if (t > .3) el.speed.textContent = `${(loaded / 1e6 / t).toFixed(1)} MB/s`; }
    for (const [name, f] of files) { // (the state dot is the row's ::before)
      if (!f.li) { f.li = document.createElement('li'); f.li.innerHTML = `<code>${name}</code><span class="ld-size"></span><span class="ld-pct"></span>`; el.files.append(f.li); }
      f.li.dataset.state = f.done ? 'done' : f.loaded ? 'active' : 'queued';
      f.li.querySelector('.ld-size').textContent = f.wire && f.wire < f.size ? `${mb(f.size)} · ${mb(f.wire)} over the wire` : mb(f.size);
      f.li.querySelector('.ld-pct').textContent = f.done ? 'done' : f.loaded ? `${Math.min(100, Math.round((100 * f.loaded) / f.size))}%` : '';
    }
  }
  function setStage(text) {
    if (text === stage) return;
    stage = text; if (el.stage) el.stage.textContent = text;
    stats.stages.push({ at: Math.round(performance.now() - stats.startedAt), text }); if (stats.stages.length > 60) stats.stages.shift();
  }
  function setManifest(m) {
    for (const name of ['qgis.wasm', 'qgis.data', 'qgis.js']) {
      const e = m && m.files && m.files[name];
      if (!e) continue;
      const wire = e.br || e.gz || e.size, ready = name === 'qgis.js'; // qgis.js is already running
      // "static": "gz" (scripts/export-pages.sh): only <name>.gz exists on this host; wrapFetch() inflates it on the page
      // e.url: the compressed file lives on another host (an R2 bucket when the static host cannot take it)
      files.set(name, { size: e.size, wire, loaded: ready ? e.size : 0, done: ready, t0: 0, t1: 0, li: null, gzOnly: e.static === 'gz' && typeof DecompressionStream === 'function', src: e.url || null });
      stats.files[name] = { size: e.size, wire, loaded: ready ? e.size : 0, ms: 0 };
    }
    render();
  }
  function setPreset(preset) {
    if (!el.foot) return;
    const info = window.qgisInfo || {};
    const items = [...(preset.links || []).filter((l) => l && l.url).map((l) => `<a href="${l.url}" target="_blank" rel="noopener">${String(l.title || l.url).replace(/</g, '&lt;')}</a>`),
      `preset ${preset.name}`, `threads ${info.threads ? 'on' : 'off'} · JSPI ${info.jspi ? 'on' : 'off'}`];
    el.foot.innerHTML = items.join('<span>·</span>');
  }
  function progress(name, loaded, done) {
    const f = files.get(name); if (!f) return;
    if (!f.t0) f.t0 = performance.now();
    f.loaded = loaded; stats.files[name].loaded = loaded;
    if (done && !f.done) { f.done = true; f.t1 = performance.now(); stats.files[name].ms = Math.round(f.t1 - f.t0); }
    if ([...files.values()].every((x) => x.done)) {
      if (stats.downloadDoneAt == null) { stats.downloadDoneAt = performance.now(); performance.mark('qgis-wasm:download-done'); setStage('Compiling WebAssembly and starting Qt'); }
    } else if (!/^Downloading/.test(stage)) setStage('Downloading QGIS');
    render();
  }
  // count the bytes of the bundle files as the module fetches them: the clone is read here, the caller gets the original
  function wrapFetch() {
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url;
      let name = null;
      try { name = new URL(url, location.href).pathname.split('/').pop(); } catch (e) { /* ignore */ }
      if (!name || !files.has(name) || files.get(name).done) return orig.call(this, input, init);
      const f = files.get(name);
      if (f.gzOnly && f.src) {
        // cross-origin member (an R2 bucket): fetch once, inflate into a buffer, hand out a solid Response.
        // A streamed Response from another origin makes Chromium's streaming compile fail, and Emscripten then
        // re-fetches the file by its same-origin name — which the static host would answer with index.html.
        if (!f.bytes) f.bytes = (async () => {
          const res = await orig.call(window, f.src, init);
          if (!res.ok || !res.body) throw new Error(`${f.src}: HTTP ${res.status}`);
          const reader = res.body.pipeThrough(new DecompressionStream('gzip')).getReader();
          const out = new Uint8Array(f.size);
          let off = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (off + value.byteLength > out.length) throw new Error(`${name}: more than the ${f.size} bytes in the manifest`);
            out.set(value, off); off += value.byteLength;
            progress(name, off, false);
          }
          if (off !== f.size) throw new Error(`${name}: ${off} of ${f.size} bytes`);
          progress(name, off, true);
          return out;
        })();
        return f.bytes.then((bytes) => new Response(bytes, {
          status: 200,
          headers: { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' },
        }));
      }
      if (f.gzOnly) { // fetch <name>.gz, count the compressed bytes, hand the consumer an inflated stream with the right media type
        const gzUrl = f.src ? new URL(f.src) : new URL(url, location.href); if (!f.src) gzUrl.pathname += '.gz';
        return orig.call(this, gzUrl.href, init).then((res) => {
          if (!res.ok || !res.body) return res;
          const [counted, payload] = res.body.tee();
          const reader = counted.getReader();
          (async () => {
            let got = 0;
            try { for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.byteLength; progress(name, Math.round((got * f.size) / (f.wire || f.size)), false); } progress(name, f.size, true); }
            catch (e) { /* the real consumer reports its own errors */ }
          })();
          const alreadyInflated = /\bgzip\b/.test(res.headers.get('content-encoding') || ''); // a host that announces the encoding: the browser inflated it
          const body = alreadyInflated ? payload : payload.pipeThrough(new DecompressionStream('gzip'));
          return new Response(body, { status: 200, headers: { 'Content-Type': name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
        });
      }
      return orig.call(this, input, init).then((res) => {
        if (!res.ok || !res.body) return res;
        const reader = res.clone().body.getReader();
        (async () => {
          let got = 0;
          try { for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.byteLength; progress(name, got, false); } progress(name, got, true); }
          catch (e) { /* the real consumer reports its own errors */ }
        })();
        return res;
      });
    };
  }
  function emscripten(text) {
    if (!text) return;
    if (/Running/.test(text)) setStage('Starting QGIS: profile, data providers, main window');
    else if (/Preparing/.test(text)) setStage('Unpacking the QGIS data files');
  }
  function hide() {
    if (hidden) return;
    hidden = true; stats.hiddenAt = performance.now();
    clearInterval(factTimer); clearInterval(tick); clearInterval(taskTimer);
    if (el.elapsed) el.elapsed.textContent = `${((stats.hiddenAt - stats.startedAt) / 1000).toFixed(1)} s`;
    if (el.fill) { el.fill.style.width = '100%'; el.bar.classList.remove('indeterminate'); }
    el.root?.classList.remove('veil');
    setTimeout(() => el.root?.classList.add('done'), 350);
    setTimeout(() => el.root?.classList.add('hidden'), 1000);
  }
  function finish(text = 'QGIS is running') {
    if (finished) return;
    finished = true; stats.loadedAt = performance.now(); performance.mark('qgis-wasm:loaded');
    if (holds > 0) { applyHoldLook(); if (!task) setStage(holdStage()); render(); return; } // held: opaque while the window settles, then a veil while a link opens its project
    setStage(text);
    hide();
  }
  /** Keep the page up until the returned function is called: opaque (the window is still settling) or, once only
   *  non-opaque holds remain, as a veil over QGIS (a project is being opened) */
  function hold({ opaque = false, timeoutMs = 240000 } = {}) {
    if (hidden) return () => {};
    holds++; if (opaque) opaqueHolds++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true; clearTimeout(timer);
      holds = Math.max(0, holds - 1); if (opaque) opaqueHolds = Math.max(0, opaqueHolds - 1);
      if (!holds && finished) hide();
      else if (finished) { applyHoldLook(); if (!task) setStage(holdStage()); render(); }
    };
    const timer = setTimeout(release, timeoutMs); // never trap the user behind the page
    return release;
  }
  function fail(text) { finished = true; clearInterval(factTimer); clearInterval(tick); setStage(text); el.root?.classList.remove('done', 'hidden', 'veil'); el.bar?.classList.remove('indeterminate'); if (el.fill) el.fill.style.background = '#d1434b'; }

  // the task bus: the most recent task is the stage while the page is up
  function onTask() {
    if (hidden) return;
    const t = window.qgisProgress.current();
    if (t !== task) { task = t; if (task) setStage(task.label); }
    if (task) render();
    else if (finished) { setStage(holds ? holdStage() : 'QGIS is running'); render(); }
  }
  if (el.root) {
    setFact(); factTimer = setInterval(setFact, 5500);
    tick = setInterval(() => { if (el.elapsed) el.elapsed.textContent = `${((performance.now() - stats.startedAt) / 1000).toFixed(0)} s`; }, 500);
    setStage('Reading the deployment preset');
    if (window.qgisProgress) { window.qgisProgress.on(onTask); taskTimer = setInterval(() => { if (task) render(); }, 400); }
  }
  window.qgisLoading = { setStage, setManifest, setPreset, wrapFetch, emscripten, finish, fail, hold, get stats() { return stats; }, get holds() { return holds; } };
})();
