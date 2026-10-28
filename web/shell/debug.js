/**
 * debug.js — the Debug view of the workspace: the page's and QGIS' logs in one list, plus the numbers that explain
 * what the browser is doing (startup phases, memory, threads, tool timings, main-thread stalls).
 *
 *   web     console.error / console.warn, uncaught errors and rejections
 *   qgis    the module's stdout/stderr (Qt warnings, GDAL/PROJ messages — routed by qgis-shell.js print/printErr) and
 *           QGIS' own message log (bridge event "log": tag, level — providers, Processing, plugins)
 *   tool    every window.qgis.call with its duration (slow calls stand out)
 *   event   bridge events except the chatty canvas.refreshed (counted)
 *   perf    main-thread tasks ≥ 100 ms (PerformanceObserver longtask), the loading phases (window.qgisLoadStats),
 *           every page task (progress.js: sharing, opening a snapshot, queries, downloads) with its duration
 *   qgis    also a crash inside a pthread worker, with the worker's own stack. The browser hands the page only
 *           "worker sent an error! qgis.js:1: RuntimeError: …" (message, file, line); the Error and its stack stay in
 *           the worker. Emscripten starts every pthread as `new Worker(<qgis.js>, { name: 'em-pthread' })`, so the page
 *           wraps that script in a tiny blob prelude that listens for `error` inside the worker and relays it over a
 *           BroadcastChannel — same script, same fetch; the wasm frames carry function names (--profiling-funcs).
 *
 * Collection is cheap: a ring buffer of 2000 entries, nothing rendered while the view is hidden; only the error count
 * reaches the header button. "Copy" puts the filtered list on the clipboard for a bug report.
 * A worker crash is also the moment the application stops being trustworthy: Emscripten lets the main thread throw
 * "unwind" the next time it waits for a lock, tool calls fail or hang (qgis-shell.js turns both into one clear error)
 * and the canvas stops updating. The crash is therefore announced (window.qgisCrash, window event "qgis-crash" — the
 * workspace shows a bar with Reload / Copy report) and the report is kept in localStorage: the next start lists it in
 * this view ("previous session … crashed") so it can still be copied after the reload.
 *   window.qgisDebug.entries / .push(source, level, text) / .qgis(level, text) / .attach(qgis) / .report() / .lastCrash
 */
(function () {
  'use strict';
  const MAX = 2000;
  const entries = [];
  const counts = { error: 0, warn: 0, refreshes: 0, tools: 0, toolMs: 0, crashes: 0 };
  const listeners = new Set();
  let seq = 0;
  const fmt = (args) => args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack || ''}` : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch (e) { return String(a); } })())).join(' ');
  function push(source, level, text, extra) {
    const e = { id: ++seq, t: performance.now(), at: new Date(), source, level, text: String(text).slice(0, 4000), extra };
    entries.push(e);
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
    if (level === 'error') counts.error++; else if (level === 'warn') counts.warn++;
    for (const fn of listeners) { try { fn(e); } catch (err) { /* ignore */ } }
    return e;
  }

  // --- web: console + uncaught
  const orig = { error: console.error.bind(console), warn: console.warn.bind(console) };
  console.error = (...a) => { orig.error(...a); push('web', 'error', fmt(a)); };
  console.warn = (...a) => { orig.warn(...a); push('web', 'warn', fmt(a)); };
  window.addEventListener('error', (e) => push('web', 'error', `${e.message}${e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : ''}`));
  window.addEventListener('unhandledrejection', (e) => push('web', 'error', `unhandled rejection: ${e.reason && (e.reason.message || e.reason)}`));
  // --- pthread workers: relay a crash's stack out of the worker (see the header). The prelude registers its listener
  //     before importScripts() runs the real script, so Emscripten's own handlers (onunhandledrejection → rethrow) end
  //     up in it too; the id names the worker so repeated crashes of one thread stand out from many threads crashing.
  const CRASH_CHANNEL = 'qgis-worker-errors';
  const LAST_CRASH_KEY = 'qgis-wasm.lastCrash';
  let lastCrash = null;
  try { lastCrash = JSON.parse(localStorage.getItem(LAST_CRASH_KEY) || 'null'); } catch (e) { /* ignore */ }
  if (lastCrash && lastCrash.message) {
    push('qgis', 'warn', `previous session (${new Date(lastCrash.at).toLocaleString()}) ended with a worker crash — copy this entry for a bug report: worker #${lastCrash.worker} (${lastCrash.thread}) crashed: ${lastCrash.message}${lastCrash.stack ? `\n${lastCrash.stack}` : ''}${lastCrash.recent ? `\nbefore the crash:\n${lastCrash.recent.join('\n')}` : ''}`, { previous: true });
  }
  const pthreadWorkers = new Map(); // prelude id → Worker
  const prelude = (id, url) => `(()=>{let c=null;try{c=new BroadcastChannel(${JSON.stringify(CRASH_CHANNEL)})}catch(e){}self.addEventListener('error',e=>{try{c&&c.postMessage({id:${id},message:String(e.message||''),filename:String(e.filename||''),lineno:e.lineno||0,stack:e.error&&e.error.stack?String(e.error.stack):''})}catch(_){}})})();importScripts(${JSON.stringify(url)});`;
  try {
    const NativeWorker = window.Worker;
    let workerSeq = 0;
    window.Worker = class Worker extends NativeWorker {
      constructor(url, options) {
        if (options && options.name === 'em-pthread' && typeof url === 'string') {
          const id = ++workerSeq;
          const src = URL.createObjectURL(new Blob([prelude(id, new URL(url, location.href).href)], { type: 'text/javascript' }));
          super(src, options);
          pthreadWorkers.set(id, this);
          setTimeout(() => URL.revokeObjectURL(src), 60000); // the script is long loaded by then
        } else {
          super(url, options);
        }
      }
    };
    new BroadcastChannel(CRASH_CHANNEL).onmessage = (ev) => {
      const d = ev.data || {};
      const w = pthreadWorkers.get(d.id);
      const P = window.qgisInstance && window.qgisInstance.PThread;
      let thread = 'worker';
      if (P && w) {
        const hit = Object.entries(P.pthreads || {}).find(([, x]) => x === w);
        thread = hit ? `pthread 0x${Number(hit[0]).toString(16)}` : (P.unusedWorkers || []).includes(w) ? 'idle pool worker' : 'worker';
      }
      const stack = String(d.stack || '').split('\n').filter((l) => l.trim()).slice(0, 40).join('\n');
      const text = `worker #${d.id} (${thread}) crashed: ${d.message || 'unknown error'}${stack ? `\n${stack}` : ''}`;
      counts.crashes++;
      orig.error(`[qgis] ${text}`);
      push('qgis', 'error', text, { worker: d.id, thread });
      const detail = { at: Date.now(), worker: d.id, thread, message: d.message || 'unknown error', stack, url: location.href };
      if (!window.qgisCrash) {
        window.qgisCrash = detail;
        // kept for the next start (the page has to be reloaded): what crashed, where, and what the page was doing
        const recent = entries.filter((e) => e.source === 'tool' || e.level === 'error' || e.level === 'warn').slice(-24).map((e) => `${e.at.toISOString().slice(11, 23)} ${e.source} ${e.level} ${e.text.split('\n')[0].slice(0, 200)}`);
        try { localStorage.setItem(LAST_CRASH_KEY, JSON.stringify({ ...detail, ua: navigator.userAgent, recent })); } catch (e) { /* storage unavailable */ }
      }
      try { window.dispatchEvent(new CustomEvent('qgis-crash', { detail })); } catch (e) { /* ignore */ }
    };
  } catch (e) { /* no Worker / BroadcastChannel here */ }
  // --- perf: what makes the page feel stuck
  try { new PerformanceObserver((l) => { for (const en of l.getEntries()) if (en.duration >= 100) push('perf', en.duration >= 1000 ? 'warn' : 'info', `main thread busy for ${Math.round(en.duration)} ms`); }).observe({ type: 'longtask', buffered: true }); } catch (e) { /* no longtask support */ }

  // --- QGIS: tools and events, once the shell has window.qgis
  function attach(qgis) {
    const call = qgis.call.bind(qgis);
    qgis.call = async (tool, params) => {
      const t0 = performance.now();
      try { const r = await call(tool, params); const ms = performance.now() - t0; counts.tools++; counts.toolMs += ms; push('tool', ms > 5000 ? 'warn' : 'info', `${tool} · ${Math.round(ms)} ms`, { tool, ms, ok: true }); return r; }
      catch (e) { push('tool', 'error', `${tool} failed after ${Math.round(performance.now() - t0)} ms: ${e.message || e}`, { tool, ok: false }); throw e; }
    };
    qgis.on('*', (payload, type) => {
      if (type === 'canvas.refreshed') { counts.refreshes++; return; }
      if (type === 'log') { const lvl = payload.level === 'critical' ? 'error' : payload.level === 'warning' ? 'warn' : 'info'; push('qgis', lvl, `[${payload.tag || 'QGIS'}] ${payload.message}`); return; }
      push('event', 'info', `${type} ${JSON.stringify(payload || {}).slice(0, 240)}`);
    });
  }

  // --- the view
  const svg = (b) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${b}</svg>`;
  const I = { bug: svg('<path d="M8 2l1.9 1.9M16 2l-1.9 1.9"/><rect x="7" y="7" width="10" height="13" rx="5"/><path d="M3 13h4M17 13h4M5 19l2.5-1.5M19 19l-2.5-1.5M5 7l2.5 1.5M19 7l-2.5 1.5M12 7v13"/>') };
  const h = (tag, attrs = {}, ...children) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v != null) el.setAttribute(k, v); } for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); return el; };
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  const state = { filter: 'all', errorsOnly: false, visible: false, timer: 0, rendered: 0, view: null };

  function perfText() {
    const ls = window.qgisLoadStats || {};
    const inst = window.qgisInstance;
    const heap = inst && inst.HEAPU8 ? mb(inst.HEAPU8.byteLength) : '?';
    const js = performance.memory ? mb(performance.memory.usedJSHeapSize) : null;
    const workers = inst && inst.PThread ? `${(inst.PThread.runningWorkers || []).length} busy / ${(inst.PThread.unusedWorkers || []).length} idle` : '?';
    const phases = ls.loadedAt ? `download ${Math.round((ls.downloadDoneAt || 0) - ls.startedAt)} ms · compile+start ${Math.round(ls.loadedAt - (ls.downloadDoneAt || ls.startedAt))} ms · window ${Math.round(ls.loadedAt - ls.startedAt)} ms` : 'loading…';
    const tools = counts.tools ? `${counts.tools} tool calls · avg ${Math.round(counts.toolMs / counts.tools)} ms` : 'no tool calls yet';
    return [`wasm heap ${heap}${js ? ` · JS heap ${js}` : ''} · threads ${workers} · ${navigator.hardwareConcurrency || '?'} cores`, phases, `${tools} · ${counts.refreshes} canvas refreshes · ${counts.error} errors · ${counts.warn} warnings`];
  }
  function matches(e) { return (state.filter === 'all' || e.source === state.filter) && (!state.errorsOnly || e.level === 'error' || e.level === 'warn'); }
  function row(e) {
    const t = `${e.at.toTimeString().slice(0, 8)}.${String(e.at.getMilliseconds()).padStart(3, '0')}`;
    return h('div', { class: `dbg-row ${e.level}`, 'data-source': e.source }, h('span', { class: 'dbg-time' }, t), h('span', { class: 'dbg-src' }, e.source), h('span', { class: 'dbg-text' }, e.text));
  }
  function render(full) {
    const v = state.view; if (!v || !state.visible) return;
    for (const [i, line] of perfText().entries()) v.perf.children[i].textContent = line;
    if (full) { v.list.replaceChildren(...entries.filter(matches).slice(-600).map(row)); state.rendered = seq; }
    else { const fresh = entries.filter((e) => e.id > state.rendered && matches(e)); if (fresh.length) { v.list.append(...fresh.map(row)); while (v.list.children.length > 600) v.list.firstChild.remove(); } state.rendered = seq; }
    v.counts.textContent = `${entries.filter(matches).length} shown · ${entries.length} kept`;
    if (v.list.scrollHeight - v.list.scrollTop - v.list.clientHeight < 120) v.list.scrollTop = v.list.scrollHeight;
  }
  function build(el) {
    const chip = (id, label) => h('button', { class: 'dbg-chip', 'data-filter': id, 'aria-pressed': String(state.filter === id), onclick: () => { state.filter = id; for (const b of el.querySelectorAll('.dbg-chip[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === id)); render(true); } }, label);
    const errorsOnly = h('button', { class: 'dbg-chip', 'aria-pressed': 'false', onclick: (e) => { state.errorsOnly = !state.errorsOnly; e.currentTarget.setAttribute('aria-pressed', String(state.errorsOnly)); render(true); } }, 'errors & warnings');
    const copy = h('button', { class: 'dbg-chip', onclick: async () => { const text = report(matches); try { await navigator.clipboard.writeText(text); copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'copy'; }, 1200); } catch (e) { window.prompt('Copy', text.slice(0, 5000)); } } }, 'copy');
    const clear = h('button', { class: 'dbg-chip', onclick: () => { entries.length = 0; counts.error = counts.warn = 0; render(true); api.badge?.setBadge(0); } }, 'clear');
    const perf = h('div', { class: 'dbg-perf' }, h('div'), h('div'), h('div'));
    const counts_ = h('span', { class: 'dbg-counts' });
    const list = h('div', { class: 'dbg-list', role: 'log' });
    el.append(h('div', { class: 'dbg-head' }, h('div', { class: 'dbg-title' }, 'Debug', counts_), perf,
      h('div', { class: 'dbg-filters' }, chip('all', 'all'), chip('web', 'web'), chip('qgis', 'qgis'), chip('tool', 'tools'), chip('event', 'events'), chip('perf', 'perf'), h('span', { class: 'dbg-sep' }), errorsOnly, copy, clear)), list);
    state.view = { perf, list, counts: counts_ };
  }

  /** The view as text for a bug report: the perf lines, then the entries (all, or those a filter accepts) */
  function report(filter = () => true) {
    const head = [`qgis-wasm debug report · ${new Date().toISOString()} · ${location.href}`, navigator.userAgent, ...perfText()];
    if (window.qgisCrash) head.push(`CRASHED: worker #${window.qgisCrash.worker} (${window.qgisCrash.thread}) ${window.qgisCrash.message}`);
    return [...head, '', ...entries.filter(filter).map((e) => `${e.at.toISOString()} ${e.source.padEnd(5)} ${e.level.padEnd(5)} ${e.text}`)].join('\n');
  }
  const api = { entries, counts, push, qgis: (level, text) => push('qgis', level, text), attach, badge: null, workers: pthreadWorkers, report, get lastCrash() { return lastCrash; }, clearLastCrash() { lastCrash = null; try { localStorage.removeItem(LAST_CRASH_KEY); } catch (e) { /* ignore */ } } };
  function init() {
    const ws = window.qgisWorkspace; if (!ws || !ws.registerView) return;
    let unseen = 0;
    api.badge = ws.registerView({ id: 'debug', title: 'Debug: web + QGIS logs, timings, memory', icon: I.bug, order: 40, render: build,
      onShow: () => { state.visible = true; unseen = 0; api.badge.setBadge(0); render(true); state.timer = setInterval(() => render(false), 700); },
      onHide: () => { state.visible = false; clearInterval(state.timer); } });
    listeners.add((e) => { if (!state.visible && e.level === 'error') api.badge.setBadge(++unseen); });
    // the page's tasks (progress.js): one line each when they end, with the duration and what they moved
    window.qgisProgress?.on((e) => {
      if (e.type !== 'end') return;
      const t = e.task, P = window.qgisProgress;
      push('perf', t.error ? 'error' : t.elapsed >= 10000 ? 'warn' : 'info', `${t.label}: ${t.error ? `failed — ${t.error}` : 'done'} in ${P.fmt.duration(t.elapsed)}${t.unit === 'bytes' && t.total ? ` · ${P.fmt.bytes(t.total)}` : ''}`);
    });
  }
  window.qgisDebug = api;
  // the workspace exists once qgis-shell.js has initialised it; register then (debug.js loads before the shell)
  if (window.qgisWorkspace?.el) init(); else document.addEventListener('ws-ready', init, { once: true });
})();
