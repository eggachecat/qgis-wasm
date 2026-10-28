/**
 * workspace.js — the page's own panel: the front door of the web layer around QGIS (docs/06).
 *
 * A flat button at the bottom right opens a card over the map (or a docked sidebar). Its header carries the page-level
 * functions — save, share links, data sources and cloud storage, the MCP endpoint, layout, links, about — as flat icon
 * buttons and small menus; the body is a slot the web agent renders into, so the conversation takes most of the room
 * and the other functions stay one click away. Everything here reaches QGIS through window.qgis tool calls; the agent
 * reaches the workspace through window.qgisWorkspace (slot, open/close, addAction, setBadge) and nothing else.
 *
 *   window.qgisWorkspace.init(qgis, preset)            called by qgis-shell.js once window.qgis exists
 *   .open() .close() .toggle() .isOpen .layout .setLayout('float' | 'dock') .slot
 *   .addAction({ id, title, icon, run, order }) / .removeAction(id)     header buttons (the agent adds its own)
 *   .setBadge(n) .setSubtitle(text) .notify(title, text, level, seconds)
 *
 * Long operations need no code here: every menu action runs as a task on progress.js, and so do the shell modules'
 * own operations (sharing, opening a snapshot, querying a source); the panel renders whatever task is running —
 * a strip under the header while open, a pill beside the button and a ring on it while closed.
 *
 * Preset:  "ui": { "openOnStart": true, "layout": "float", "width": 480, "height": null, "title": "…" }
 *          "links": [{ "title": "Source code (GitHub)", "url": "https://…" }]   (⋯ → Links, and the loading page)
 * The last open/closed state, layout and card geometry are remembered per browser (localStorage, qgis-wasm.workspace.*).
 */
(function () {
  'use strict';

  // Qt for WebAssembly listens for pointer, key and clipboard events on window / document (capture phase) and calls
  // preventDefault(): a click in the panel would not focus its input, typing could be swallowed, Ctrl+V would never paste.
  // This runs before Qt starts: every such listener added to window / document from now on skips events whose target is
  // inside the page's own UI (workspace, menus, agent), so the panel keeps the browser's native behaviour. Listeners the
  // page wants everywhere (the Ctrl+Shift+Space toggle) are marked __wsPassthrough.
  const INSIDE = '.ws-root, .ws-menu, .qa-root';
  const GUARDED = new Set(['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchend', 'touchmove', 'touchcancel', 'keydown', 'keyup', 'keypress', 'copy', 'cut', 'paste', 'drop', 'dragover', 'dragenter', 'dragleave']);
  const captureOf = (o) => !!(o === true || (o && typeof o === 'object' && o.capture));
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target);
    target.addEventListener = function (type, listener, options) {
      if (!GUARDED.has(type) || typeof listener !== 'function' || listener.__wsPassthrough) return add(type, listener, options);
      const key = `${type}|${captureOf(options)}`;
      const map = listener.__wsWrapped || (listener.__wsWrapped = new Map());
      if (!map.has(key)) map.set(key, function (e) { const t = e.target; if (t instanceof Element && t.closest(INSIDE)) return undefined; return listener.call(this, e); });
      return add(type, map.get(key), options);
    };
    target.removeEventListener = function (type, listener, options) {
      const w = listener && listener.__wsWrapped && listener.__wsWrapped.get(`${type}|${captureOf(options)}`);
      return remove(type, w || listener, options);
    };
  }

  const CSS_URL = new URL('workspace.css', document.currentScript?.src || location.href).href;
  const KEYS = { open: 'qgis-wasm.workspace.open', geometry: 'qgis-wasm.workspace.geometry', layout: 'qgis-wasm.workspace.layout' };
  const MARGIN = 22;
  const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
  const I = {
    bot: svg('<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4M8.5 4h7"/><circle cx="9" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13.5" r="1.2" fill="currentColor" stroke="none"/>'),
    close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
    folder: svg('<path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/>'),
    share: svg('<path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7"/><path d="M12 15V3M8 7l4-4 4 4"/>'),
    data: svg('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'),
    dots: svg('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
    save: svg('<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>'),
    link: svg('<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>'),
    cloud: svg('<path d="M7 18h10a4 4 0 00.5-8A6 6 0 006 10.5 4 4 0 007 18z"/>'),
    image: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M21 16l-5-5-8 8"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 011-1h10"/>'),
    external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5"/>'),
    search: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/>'),
    layers: svg('<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'),
    back: svg('<path d="M19 12H5M12 19l-7-7 7-7"/>'),
    check: svg('<path d="M20 6L9 17l-5-5"/>'),
    plug: svg('<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 01-12 0z"/><path d="M12 17v5"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
  };
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const log = (m, err) => (err ? console.error : console.log)(m);
  const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; } };
  const runTask = (label, fn) => (window.qgisProgress ? window.qgisProgress.run(label, fn) : fn());
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };

  const S = { qgis: null, preset: null, ui: {}, root: null, panel: null, slot: null, screen: null, head: null, actionsEl: null, badge: null, sub: null, layout: 'float', actions: new Map(), menu: null, geom: null };

  // ------------------------------------------------------------------ open / close / layout / geometry
  function setOpen(open) {
    S.root.dataset.open = String(open);
    if (S.screen) S.screen.style.right = open && S.layout === 'dock' ? `${S.geom.w}px` : '';
    store.set(KEYS.open, open ? '1' : '0');
    if (open) setBadge(0);
    else closeMenu();
    window.dispatchEvent(new Event('resize')); // Qt relayouts the screen
    S.root.dispatchEvent(new CustomEvent('ws-open', { detail: { open } }));
  }
  function setLayout(l) {
    S.layout = l === 'dock' ? 'dock' : 'float';
    S.root.dataset.layout = S.layout;
    store.set(KEYS.layout, S.layout);
    setOpen(S.root.dataset.open === 'true');
  }
  const defaultGeometry = () => ({ x: MARGIN, y: MARGIN, w: S.ui.width || 480, h: S.ui.height || null }); // h null: full height, equal margins
  function applyGeometry(persist) {
    const vw = window.innerWidth, vh = window.innerHeight, g = S.geom;
    const full = g.h == null;
    g.w = Math.round(Math.max(340, Math.min(g.w, vw - 16)));
    const hh = full ? vh - 2 * MARGIN : Math.round(Math.max(380, Math.min(g.h, vh - 16)));
    if (!full) g.h = hh; else g.y = MARGIN;
    g.x = Math.round(Math.max(8, Math.min(g.x, vw - g.w - 8)));
    g.y = Math.round(Math.max(8, Math.min(g.y, vh - hh - 8)));
    S.root.style.setProperty('--ws-x', `${g.x}px`); S.root.style.setProperty('--ws-y', `${g.y}px`);
    S.root.style.setProperty('--ws-w', `${g.w}px`); S.root.style.setProperty('--ws-h', `${hh}px`);
    if (S.layout === 'dock' && S.root.dataset.open === 'true' && S.screen) S.screen.style.right = `${g.w}px`;
    if (persist) store.set(KEYS.geometry, JSON.stringify(g));
  }
  function draggable(handle, onMove, accept) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || S.layout !== 'float' || (accept && !accept(e))) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      const start = { x: e.clientX, y: e.clientY, g: { ...S.geom } };
      S.root.classList.add('ws-moving');
      const move = (ev) => { onMove(ev.clientX - start.x, ev.clientY - start.y, start.g); applyGeometry(false); };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); S.root.classList.remove('ws-moving'); applyGeometry(true); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  }

  // ------------------------------------------------------------------ header actions and badge
  function renderActions() {
    S.actionsEl.replaceChildren(...[...S.actions.values()].sort((a, b) => (a.order ?? 50) - (b.order ?? 50)).map((a) =>
      h('button', { class: 'ws-tool', 'data-action': a.id, title: a.title, 'aria-label': a.title, html: a.icon || I.plus, onclick: () => { try { a.run(); } catch (e) { notify(a.title, e.message || String(e), 'critical'); } } })));
    for (const [vid] of views) { const btn = S.actionsEl.querySelector(`[data-action="view.${vid}"]`); if (btn) btn.setAttribute('aria-pressed', String(S.root.dataset.view === vid)); }
  }
  function addAction(a) { if (!a || !a.id || typeof a.run !== 'function') throw new Error('addAction({ id, title, icon, run, order })'); S.actions.set(a.id, a); renderActions(); return () => removeAction(a.id); }
  // a view is a second body the panel can show instead of the agent's slot (e.g. the debug view); its button goes to the header
  const views = new Map();
  function showView(id) {
    const next = id && views.has(id) && S.root.dataset.view !== id ? id : 'agent';
    S.root.dataset.view = next;
    for (const [vid, v] of views) { v.el.dataset.active = String(vid === next); const btn = S.actionsEl.querySelector(`[data-action="view.${vid}"]`); if (btn) btn.setAttribute('aria-pressed', String(vid === next)); if (vid === next) v.onShow?.(v.el); else if (v.el.dataset.active === 'false') v.onHide?.(v.el); }
    if (next !== 'agent') setOpen(true);
  }
  function registerView({ id, title, icon, render, onShow, onHide, order = 30 }) {
    if (!id || typeof render !== 'function') throw new Error('registerView({ id, title, icon, render })');
    const el = h('section', { class: 'ws-view', 'data-id': id, 'data-active': 'false' });
    S.views.append(el);
    views.set(id, { el, onShow, onHide });
    render(el);
    addAction({ id: `view.${id}`, title, icon, order, run: () => showView(id) });
    return { el, show: () => showView(id), hide: () => { if (S.root.dataset.view === id) showView(null); }, setBadge: (n) => { const b = S.actionsEl.querySelector(`[data-action="view.${id}"]`); if (b) b.dataset.badge = n > 0 ? String(n) : ''; } };
  }
  function removeAction(id) { const had = S.actions.delete(id); renderActions(); return had; }
  function setBadge(n) { S.badge.textContent = String(n || 0); S.badge.style.display = n > 0 && S.root.dataset.open !== 'true' ? 'grid' : 'none'; }
  function setSubtitle(text) { S.sub.textContent = text || ''; }
  const notify = (title, text, level = 'info', duration = 8) => S.qgis.call('ui_message', { title, text, level, duration }).catch(() => log(`${title}: ${text}`, level === 'critical'));

  // ------------------------------------------------------------------ running tasks (progress.js): strip / pill / ring
  const spinner = () => (window.qgisSpinner ? window.qgisSpinner() : '');
  let progRaf = 0, progShowTimer = 0;
  function renderProgress() {
    progRaf = 0;
    const P = window.qgisProgress; if (!P || !S.prog) return;
    const t = P.current();
    if (!t) { clearTimeout(progShowTimer); progShowTimer = 0; S.prog.dataset.active = 'false'; S.pill.dataset.active = 'false'; S.fab.dataset.busy = 'false'; return; }
    if (S.prog.dataset.active !== 'true') { // only tasks that last: a menu action finishing within 150 ms never flashes a strip
      if (!progShowTimer) progShowTimer = setTimeout(() => { progShowTimer = 0; if (P.current()) { S.prog.dataset.active = 'true'; S.pill.dataset.active = 'true'; S.fab.dataset.busy = 'true'; renderProgress(); } }, 150);
      return;
    }
    const fr = t.fraction, text = P.describe(t), more = P.count > 1 ? ` (+${P.count - 1})` : '';
    S.prog.dataset.mode = fr == null ? 'indeterminate' : 'determinate'; S.pill.dataset.mode = S.prog.dataset.mode;
    S.prog.querySelector('.ws-prog-label').textContent = t.label + more;
    S.prog.querySelector('.ws-prog-detail').textContent = text;
    S.prog.querySelector('.ws-prog-bar > div').style.width = fr == null ? '' : `${(100 * fr).toFixed(1)}%`;
    S.pill.querySelector('.ws-pill-label').textContent = `${t.label}${fr != null ? ` · ${Math.round(100 * fr)}%` : ''}${more}`;
    S.pill.querySelector('.ws-pill-bar > span').style.width = fr == null ? '' : `${(100 * fr).toFixed(1)}%`;
    S.pill.title = `${t.label}${text ? ' — ' + text : ''} · click to open the workspace`;
  }
  const scheduleProgress = () => { if (!progRaf) progRaf = requestAnimationFrame(renderProgress); };

  // ------------------------------------------------------------------ menus (one open at a time, under its button)
  // item: { type: 'item' | 'header' | 'check' | 'input' | 'note' | 'sep', label, hint, icon, run, href, checked, placeholder, onEnter }
  function closeMenu() { if (S.menu) { S.menu.el.remove(); S.menu = null; } }
  function openMenu(anchor, build) {
    if (S.menu && S.menu.anchor === anchor) return closeMenu();
    closeMenu();
    const el = h('div', { class: 'ws-menu', role: 'menu' });
    const state = { anchor, el, stack: [] };
    S.menu = state;
    S.root.append(el); // a sibling of the panel, fixed and above it: nothing rendered in the slot can cover it
    const place = () => { const a = anchor.getBoundingClientRect(); el.style.top = `${a.bottom + 6}px`; el.style.right = `${Math.max(8, window.innerWidth - a.right)}px`; el.style.maxHeight = `${Math.max(160, window.innerHeight - a.bottom - 22)}px`; };
    const render = async (builder) => {
      el.replaceChildren(h('div', { class: 'ws-menu-loading' }, 'Loading…'));
      let items;
      try { items = await builder(); } catch (e) { items = [{ type: 'note', label: e.message || String(e), error: true }]; }
      if (S.menu !== state) return;
      el.replaceChildren(...(state.stack.length ? [{ type: 'item', icon: I.back, label: 'Back', run: () => { state.stack.pop(); render(state.stack.length ? state.stack[state.stack.length - 1] : build); } }] : []).concat(items).map(item));
      place();
      const inp = el.querySelector('input'); if (inp) inp.focus();
    };
    const push = (builder) => { state.stack.push(builder); render(builder); };
    function item(it) {
      if (it.type === 'sep') return h('div', { class: 'ws-menu-sep' });
      if (it.type === 'header') return h('div', { class: 'ws-menu-header' }, it.label);
      if (it.type === 'note') return h('div', { class: `ws-menu-note${it.error ? ' error' : ''}` }, it.label);
      if (it.type === 'input') {
        const inp = h('input', { class: 'ws-menu-input', placeholder: it.placeholder || '', value: it.value || '' });
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) { e.preventDefault(); it.onEnter(inp.value.trim(), push); } });
        return h('div', { class: 'ws-menu-inputrow', html: I.search }, inp);
      }
      const row = h(it.href ? 'a' : 'button', { class: `ws-menu-item${it.type === 'check' ? ' check' : ''}`, role: 'menuitem', ...(it.href ? { href: it.href, target: '_blank', rel: 'noopener' } : {}), 'data-checked': it.type === 'check' ? String(!!it.checked) : undefined,
        onclick: async (e) => {
          if (it.href) { closeMenu(); return; }
          e.preventDefault();
          if (it.submenu) return push(it.submenu);
          if (!it.keepOpen) closeMenu();
          try { await runTask(it.label, () => it.run?.(push)); } catch (err) { notify(it.label, err.message || String(err), 'critical', 12); }
        } },
        h('span', { class: 'ws-menu-icon', html: it.type === 'check' ? I.check : it.icon || (it.href ? I.external : '') }),
        h('span', { class: 'ws-menu-label' }, it.label, it.hint ? h('small', {}, it.hint) : null),
        it.submenu ? h('span', { class: 'ws-menu-more', html: '›' }) : null);
      return row;
    }
    render(build);
    anchor.setAttribute('aria-expanded', 'true');
    const onDoc = (e) => { if (!el.contains(e.target) && !anchor.contains(e.target)) { closeMenu(); document.removeEventListener('pointerdown', onDoc, true); anchor.removeAttribute('aria-expanded'); } };
    document.addEventListener('pointerdown', onDoc, true);
    const onKey = (e) => { if (e.key === 'Escape') { closeMenu(); document.removeEventListener('keydown', onKey, true); } };
    document.addEventListener('keydown', onKey, true);
  }

  // ------------------------------------------------------------------ the page functions (all through window.qgis tools / shell modules)
  const links = () => [...(S.preset.links || [])].filter((l) => l && l.url);
  async function copyAndTell(title, url, note = '') {
    const ok = await copy(url);
    await notify(title, `${ok ? 'Copied to the clipboard: ' : ''}${url}${note}`, 'success', 15);
    if (!ok) window.prompt(title, url);
  }
  const projectMenu = () => [
    { type: 'header', label: 'Project' },
    { icon: I.save, label: 'Save project', hint: 'to where it was opened from', run: async () => {
      try { const r = await S.qgis.call('project_save', {}); await notify('Project', `Saved${r && r.path ? ` to ${r.path}` : ''}.`, 'success', 6); }
      catch (e) { await notify('Project', `${e.message || e} — use Project → Save As… in QGIS to choose a folder, e.g. /cloud/shared, or "Save to cloud and share".`, 'warning', 14); }
    } },
    { icon: I.cloud, label: 'Share a snapshot', hint: 'project + its data to cloud storage, frozen, short link', run: async () => { const r = await S.qgis.call('project_share', {}); await copyAndTell('Share', r.url, r.skipped?.length ? ` Not in the snapshot: ${r.skipped.join('; ')}.` : ''); } },
    { icon: I.folder, label: 'Open the demo project', hint: '/qgis/share/demo/world.qgs', run: () => (window.qgisOpen ? window.qgisOpen('/qgis/share/demo/world.qgs') : S.qgis.open('/qgis/share/demo/world.qgs')) },
    { icon: I.image, label: 'Export the map view as PNG', hint: 'downloads it and opens it in a new tab', run: async () => {
      const tab = window.open('', '_blank'); // opened inside the click, before any await: no pop-up blocker
      try {
        if (tab) tab.document.write('<!doctype html><title>Exporting map…</title><body style="margin:0;background:#111;color:#ccc;font:14px system-ui;display:grid;place-items:center;min-height:100vh">Rendering the map view…</body>');
        const r = await S.qgis.call('canvas_export_image', {});
        const img = await S.qgis.call('file_base64', { path: r.path });
        const bytes = Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType || 'image/png' }));
        const name = r.path.split('/').pop();
        const a = h('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
        if (tab) { tab.document.open(); tab.document.write(`<!doctype html><title>${name}</title><body style="margin:0;background:#111;display:grid;place-items:center;min-height:100vh"><img src="${url}" alt="${name}" style="max-width:100vw;max-height:100vh"><a href="${url}" download="${name}" style="position:fixed;top:12px;right:12px;font:14px system-ui;color:#fff;background:${(window.qgisBrand && window.qgisBrand.accent) || '#589632'};padding:6px 10px;border-radius:8px;text-decoration:none">Download ${name}</a></body>`); tab.document.close(); }
        await notify('Export', `${name} (${Math.round(bytes.length / 1024)} KB) downloaded; also at ${r.path}`, 'success', 8);
      } catch (e) { if (tab) tab.close(); throw e; }
    } },
  ];
  const shareMenu = () => [
    { type: 'header', label: 'Share' },
    { icon: I.cloud, label: 'Share a snapshot (stored)', hint: 'project + data copied to the cloud mount, frozen — ?share=<id>', run: async () => { const r = await S.qgis.call('project_share', {}); await copyAndTell('Share', r.url, r.skipped?.length ? ` Not in the snapshot: ${r.skipped.join('; ')}.` : ''); } },
    { icon: I.link, label: 'Copy a live link to this view', hint: 'a recipe: re-queries its sources when opened (view_link)', run: async () => { const r = await S.qgis.call('view_link', {}); await copyAndTell('Share', r.url, r.skipped?.length ? ` Not in the link: ${r.skipped.join('; ')}.` : ''); } },
    { icon: I.layers, label: 'Refresh this snapshot from its sources', hint: 'rewrites the query layers in place; styles stay', run: async () => { const r = await S.qgis.call('share_refresh', {}); await notify('Share', `Refreshed ${r.refreshed.length} layer(s) of snapshot ${r.id}${r.skipped.length ? `; not queries: ${r.skipped.join('; ')}` : ''}`, 'success', 10); } },
    { icon: I.plug, label: 'Copy the MCP endpoint of this page', hint: window.qgisAgentMcpUrl ? 'for Claude Code and other agents' : 'no agent server connected', run: async () => {
      const url = window.qgisAgentMcpUrl; if (!url) throw new Error('No agent server is connected to this page (scripts/serve.mjs provides /mcp).');
      await copyAndTell('MCP', url, ` Claude Code: claude mcp add --transport http qgis '${url}'${window.qgisAgentShared ? ' (valid while this tab stays open)' : ''}.`);
    } },
    ...(links().length ? [{ type: 'header', label: 'Links' }, ...links().map((l) => ({ label: l.title || l.url, hint: l.url.replace(/^https?:\/\//, ''), href: l.url }))] : []),
  ];
  const dataMenu = () => {
    const src = window.qgisSources, cloud = window.qgisCloud;
    const list = src ? src.list() : [];
    const mounts = cloud ? cloud.list() : [];
    const collectionsOf = (s) => async () => {
      const cols = await src.collections(s.name);
      return [{ type: 'header', label: `${s.title} — ${cols.length} collections` }, ...(!cols.length ? [{ type: 'note', label: 'No collections; use the search box above.' }] : cols.slice(0, 60).map((c) => ({ icon: I.layers, label: c.title || c.id, hint: c.description ? c.description.slice(0, 80) : c.id, run: async () => {
        await notify('Data sources', `Loading ${c.title || c.id} from ${s.title}…`, 'info', 4);
        const r = await src.load(s.name, { collection: c.id });
        await notify('Data sources', `${r.layers.map((l) => l.name).join(', ')} added (${r.spec})`, 'success', 8);
      } })))];
    };
    return [
      { type: 'input', placeholder: 'Search every data source… (Enter)', onEnter: (q, push) => push(async () => {
        const hits = await src.search(null, { q });
        return [{ type: 'header', label: `${hits.length} results for "${q}"` }, ...(!hits.length ? [{ type: 'note', label: 'Nothing found. Try a collection name or other words.' }] : hits.slice(0, 40).map((x) => ({ icon: I.layers, label: x.title || x.id, hint: `${x.source}${x.description ? ' · ' + x.description.slice(0, 70) : ''}`, run: async () => { const r = await src.loadSpec(x.spec); await notify('Data sources', `${r.layers.map((l) => l.name).join(', ')} added`, 'success', 8); } })))];
      }) },
      { type: 'header', label: 'Query data sources' },
      ...(!list.length ? [{ type: 'note', label: 'None configured (preset "sources" or the sources_add tool).' }] : list.map((s) => ({ icon: I.data, label: s.title, hint: `${s.type}${s.description ? ' · ' + s.description.slice(0, 70) : ''}`,
        submenu: s.capabilities.collections ? collectionsOf(s) : async () => [{ type: 'header', label: s.title }, { type: 'input', placeholder: `Query ${s.title}… (Enter)`, onEnter: async (q) => { closeMenu(); const r = await src.load(s.name, { q }); await notify('Data sources', `${r.layers.map((l) => l.name).join(', ')} added`, 'success', 8); } }] }))),
      { type: 'header', label: 'Cloud storage' },
      ...(!mounts.length ? [{ type: 'note', label: 'No mounts (preset "mounts" or the mounts_add tool).' }] : mounts.map((m) => ({ icon: I.cloud, label: `${m.path}`, hint: `${m.type} · open it from Browser → Favorites, or Project → Open…`, run: () => copyAndTell('Cloud storage', m.path) }))),
    ];
  };
  const moreMenu = async () => {
    const info = window.qgisInfo || {};
    let version = '';
    try { const st = await S.qgis.call('state'); version = st.version || st.qgis || st.qgisVersion || ''; } catch (e) { /* QGIS still starting */ }
    return [
      { type: 'header', label: 'Panel' },
      { type: 'check', label: 'Floating card over the map', hint: 'QGIS keeps its full width', checked: S.layout === 'float', run: () => setLayout('float') },
      { type: 'check', label: 'Docked sidebar', hint: 'QGIS makes room on the right', checked: S.layout === 'dock', run: () => setLayout('dock') },
      { type: 'check', label: 'Open when QGIS starts', checked: store.get(KEYS.open) !== '0', run: () => store.set(KEYS.open, store.get(KEYS.open) === '0' ? '1' : '0') },
      { label: 'Reset position and size', run: () => { S.geom = defaultGeometry(); store.set(KEYS.geometry, null); applyGeometry(false); } },
      ...(links().length ? [{ type: 'header', label: 'Links' }, ...links().map((l) => ({ label: l.title || l.url, hint: l.url.replace(/^https?:\/\//, ''), href: l.url }))] : []),
      { type: 'header', label: 'About' },
      { type: 'note', label: `${version ? `QGIS ${version} · ` : ''}preset "${S.preset.name}" · ${location.origin}` },
      { type: 'note', label: `threads ${info.threads ? 'on' : 'off'} · JSPI ${info.jspi ? 'on' : 'off'} · Ctrl+Shift+Space toggles this panel` },
    ];
  };

  // ------------------------------------------------------------------ init
  function init(qgis, preset, { container = document.body, screen = document.getElementById('screen') } = {}) {
    if (S.root) return api;
    S.qgis = qgis; S.preset = preset || {}; S.screen = screen;
    S.ui = { openOnStart: true, layout: 'float', width: 480, height: null, ...(S.preset.agent?.ui || {}), ...(S.preset.ui || {}) };
    if (!document.querySelector(`link[href="${CSS_URL}"]`)) document.head.append(h('link', { rel: 'stylesheet', href: CSS_URL }));

    S.badge = h('span', { class: 'ws-badge' });
    const fab = h('button', { class: 'ws-fab', title: 'Workspace and agent (Ctrl+Shift+Space)', 'aria-label': 'Open the workspace', html: I.bot, onclick: () => setOpen(true) }, S.badge);
    S.fab = fab;
    // running tasks: the strip (in the card) and the pill (beside the button, while the card is closed)
    S.prog = h('div', { class: 'ws-progress', 'data-active': 'false', role: 'status', 'aria-live': 'polite' },
      h('span', { class: 'ws-spin brand-spinner', 'aria-hidden': 'true', html: spinner() }),
      h('div', { class: 'ws-prog-text' }, h('div', { class: 'ws-prog-label' }), h('div', { class: 'ws-prog-detail' })),
      h('div', { class: 'ws-prog-bar' }, h('div')));
    S.pill = h('button', { class: 'ws-pill', 'data-active': 'false', title: 'Show the workspace', onclick: () => setOpen(true) },
      h('span', { class: 'ws-spin brand-spinner', 'aria-hidden': 'true', html: spinner() }), h('span', { class: 'ws-pill-label' }), h('span', { class: 'ws-pill-bar' }, h('span')));
    S.sub = h('div', { class: 'ws-sub' }, 'workspace');
    const tool = (id, title, icon, build) => h('button', { class: 'ws-tool', 'data-menu': id, title, 'aria-label': title, 'aria-haspopup': 'menu', html: icon, onclick: (e) => openMenu(e.currentTarget, build) });
    S.actionsEl = h('div', { class: 'ws-actions' });
    S.head = h('header', { class: 'ws-head' },
      h('div', { class: 'ws-logo', html: I.bot }),
      h('div', { class: 'ws-titles' }, h('div', { class: 'ws-title' }, S.ui.title || S.preset.title || 'QGIS'), S.sub),
      h('nav', { class: 'ws-tools', 'aria-label': 'Workspace' },
        tool('project', 'Project: save, share, open, export', I.folder, projectMenu),
        tool('share', 'Share: links, MCP endpoint', I.share, shareMenu),
        tool('data', 'Data sources and cloud storage', I.data, dataMenu),
        h('span', { class: 'ws-sep' }),
        S.actionsEl,
        tool('more', 'Layout, links, about', I.dots, moreMenu),
        h('button', { class: 'ws-tool ws-close', title: 'Close', 'aria-label': 'Close the workspace', html: I.close, onclick: () => setOpen(false) })));
    S.slot = h('div', { class: 'ws-slot' });
    S.views = h('div', { class: 'ws-views' });
    const grip = h('div', { class: 'ws-grip', title: 'Drag to resize' });
    S.panel = h('aside', { class: 'ws-panel', role: 'dialog', 'aria-label': 'QGIS workspace' }, grip, S.head, S.prog, S.slot, S.views);
    S.root = h('div', { class: 'ws-root', 'data-open': 'false', 'data-view': 'agent' }, fab, S.pill, S.panel);
    if (window.qgisProgress) window.qgisProgress.on(scheduleProgress);
    // never paint unstyled: stay hidden until workspace.css is applied (index.html links it statically; this is the fallback)
    const styled = () => [...document.styleSheets].some((ss) => { try { return (ss.href || '').endsWith('workspace.css') && ss.cssRules.length > 0; } catch (e) { return false; } });
    if (!styled()) { S.root.style.visibility = 'hidden'; const link = document.querySelector(`link[href="${CSS_URL}"]`); const reveal = () => { S.root.style.visibility = ''; }; if (link) link.addEventListener('load', reveal, { once: true }); setTimeout(reveal, 1500); }
    if (S.ui.theme) S.root.dataset.theme = S.ui.theme;
    container.append(S.root);

    S.layout = store.get(KEYS.layout) || (S.ui.layout === 'dock' ? 'dock' : 'float');
    S.root.dataset.layout = S.layout;
    S.geom = defaultGeometry();
    try { Object.assign(S.geom, JSON.parse(store.get(KEYS.geometry) || '{}')); } catch (e) { /* ignore */ }
    draggable(S.head, (dx, dy, g) => { S.geom.x = g.x - dx; S.geom.y = g.y - dy; }, (e) => !e.target.closest('button, a, input, .ws-menu'));
    draggable(grip, (dx, dy, g) => { S.geom.w = g.w - dx; S.geom.h = (g.h == null ? window.innerHeight - 2 * MARGIN : g.h) - dy; });
    window.addEventListener('resize', () => { applyGeometry(false); closeMenu(); });
    applyGeometry(false);

    // a worker thread crash (debug.js → window event "qgis-crash"): the tab cannot be trusted any more — say so on top
    // of the page, with the two things that help: reload, and the report for whoever fixes it (docs/02)
    const crashBar = (d) => {
      if (S.crash) return;
      const what = String((d && d.message) || 'a worker thread crashed').replace(/^Uncaught\s+/, '').slice(0, 140);
      const copy = h('button', { class: 'ws-crash-btn', onclick: async () => { const text = window.qgisDebug ? window.qgisDebug.report() : what; try { await navigator.clipboard.writeText(text); copy.textContent = 'copied'; setTimeout(() => { copy.textContent = 'Copy report'; }, 1500); } catch (e) { window.prompt('Copy', text.slice(0, 5000)); } } }, 'Copy report');
      S.crash = h('div', { class: 'ws-crash', role: 'alert' },
        h('span', { class: 'ws-crash-text' }, h('b', {}, 'QGIS crashed in this tab. '), `A render / task thread died (${what}). Tool calls and the map are unreliable from now on: reload the page; the crash report is kept in the Debug view across the reload.`),
        h('button', { class: 'ws-crash-btn', onclick: () => location.reload() }, 'Reload'),
        h('button', { class: 'ws-crash-btn', onclick: () => { setOpen(true); showView('debug'); } }, 'Debug view'), copy,
        h('button', { class: 'ws-crash-x', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => { S.crash.remove(); S.crash = null; S.crashDismissed = true; } }, '×'));
      container.append(S.crash);
    };
    if (window.qgisCrash) crashBar(window.qgisCrash);
    window.addEventListener('qgis-crash', (e) => { if (!S.crashDismissed) crashBar(e.detail); });

    document.dispatchEvent(new CustomEvent('ws-ready', { detail: api })); // debug.js and other page modules register their views now
    const saved = store.get(KEYS.open);
    setOpen(saved !== null ? saved === '1' : S.ui.openOnStart !== false);
    const toggleKey = (e) => { if (e.ctrlKey && e.shiftKey && e.code === 'Space') { e.preventDefault(); setOpen(S.root.dataset.open !== 'true'); } };
    toggleKey.__wsPassthrough = true; // also while typing in the panel
    document.addEventListener('keydown', toggleKey, true);
    return api;
  }

  const api = {
    init, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(S.root.dataset.open !== 'true'),
    get isOpen() { return !!S.root && S.root.dataset.open === 'true'; }, get layout() { return S.layout; }, setLayout,
    get slot() { return S.slot; }, get el() { return S.root; }, get view() { return S.root ? S.root.dataset.view : 'agent'; },
    addAction, removeAction, registerView, showView, setBadge, setSubtitle, notify, closeMenu,
  };
  window.qgisWorkspace = api;
})();
