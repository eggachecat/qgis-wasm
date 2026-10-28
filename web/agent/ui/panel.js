/**
 * panel.js — the default UI of the agent: chat, tool cards, approvals, settings. Plain DOM, no framework; it only talks
 * to the AgentRuntime's events and methods, so it can be replaced by any other front-end that drives the same runtime.
 *
 * Three ways to show it:
 *   embedded    inside the page's workspace panel (web/shell/workspace.js, window.qgisWorkspace): the workspace owns the
 *               button, the header, open/close, layout and geometry; the agent fills its slot and adds two header
 *               buttons (new conversation, settings) through workspace.addAction. This is the normal case.
 *   standalone  agent.html: the whole page.
 *   floating    no workspace on the page: the agent brings its own button and a floating card (legacy).
 */
import { render, ensureMarkdown, escapeHtml } from './markdown.js';
import { listProviders } from '../core/providers/index.js';
import { resetUserConfig } from '../core/config.js';

const I = {
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
};

const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};

export function mountPanel(agent, { container = document.body, screen = null, standalone = false, workspace = null, cssUrl = new URL('./agent.css', import.meta.url).href } = {}) {
  if (![...document.querySelectorAll('link[rel="stylesheet"]')].some((l) => l.href === cssUrl)) document.head.append(h('link', { rel: 'stylesheet', href: cssUrl })); // index.html links it statically; agent.html does not
  ensureMarkdown().then(() => { for (const m of agent.messages) refresh(m); });

  const ui = agent.config.ui || {};
  const embedded = !!workspace && !standalone;
  if (embedded) container = workspace.slot;
  const root = h('div', { class: 'qa-root', 'data-open': 'false', 'data-view': 'chat', 'data-standalone': String(standalone), 'data-embedded': String(embedded) });
  root.style.setProperty('--qa-w', `${ui.width || 420}px`);
  if (ui.theme) root.dataset.theme = ui.theme;
  // legacy modes only: 'float' = a card over the map that takes no width from QGIS; 'dock' = a sidebar QGIS makes room for
  let layout = embedded ? 'embedded' : standalone || ui.layout === 'dock' ? 'dock' : 'float';
  root.dataset.layout = layout;

  // --- header
  const dot = h('span', { class: 'qa-dot', 'data-state': 'idle' });
  const sub = h('span');
  const title = h('div', { class: 'qa-title' }, ui.title || 'QGIS Agent');
  const settingsBtn = h('button', { class: 'qa-icon-btn', title: 'Settings', html: I.gear, onclick: () => setView(root.dataset.view === 'settings' ? 'chat' : 'settings') });
  const header = h('div', { class: 'qa-head' },
    h('div', { class: 'qa-logo', html: I.spark }),
    h('div', { class: 'qa-titles' }, title, h('div', { class: 'qa-sub' }, dot, sub)),
    h('button', { class: 'qa-icon-btn', title: 'New conversation', html: I.plus, onclick: () => { agent.reset(); setView('chat'); input.focus(); } }),
    settingsBtn,
    standalone ? null : h('button', { class: 'qa-icon-btn', title: 'Close', html: I.close, onclick: () => setOpen(false) }),
  );

  // --- chat view
  const empty = h('div', { class: 'qa-empty' });
  const list = h('div', { class: 'qa-view qa-view-chat' }, empty);
  // --- settings view
  const settings = h('div', { class: 'qa-view qa-view-settings' });

  // --- composer
  const input = h('textarea', { class: 'qa-input', rows: '1', placeholder: 'Ask the agent… (/ for commands)' });
  const sendBtn = h('button', { class: 'qa-send', 'data-mode': 'send', title: 'Send', html: I.send });
  const cmds = h('div', { class: 'qa-cmds', 'data-open': 'false' });
  const hintRight = h('span', { class: 'qa-drop' }, 'drop files to upload');
  const composer = h('div', { class: 'qa-composer' }, cmds,
    h('div', { class: 'qa-composer-box' }, input, sendBtn),
    h('div', { class: 'qa-hint' }, h('span', {}, 'Enter to send · Shift+Enter for a new line'), hintRight));

  const grip = h('div', { class: 'qa-grip', title: 'Drag to resize' });
  const approvals = h('div', { class: 'qa-approvals' });
  // embedded: the workspace header carries the identity and the buttons; the agent adds its own two there
  const panel = h('aside', { class: 'qa-panel', role: embedded ? 'region' : 'dialog', 'aria-label': 'QGIS agent' }, ...(embedded ? [] : [grip, header]), h('div', { class: 'qa-body' }, list, settings), approvals, composer);
  const badge = h('span', { class: 'qa-badge' });
  const fab = h('button', { class: 'qa-fab', title: 'QGIS agent', 'aria-label': 'Open the QGIS agent', html: I.spark, onclick: () => setOpen(true) });
  fab.append(badge);
  if (embedded) {
    workspace.addAction({ id: 'agent.new', title: 'New conversation', icon: I.plus, order: 10, run: () => { agent.reset(); setView('chat'); input.focus(); } });
    workspace.addAction({ id: 'agent.settings', title: 'Agent settings', icon: I.gear, order: 20, run: () => setView(root.dataset.view === 'settings' ? 'chat' : 'settings') });
    root.append(panel);
  } else root.append(fab, panel);
  container.append(root);

  // ------------------------------------------------------------------ state
  let unread = 0;
  const OPEN_KEY = 'qgis-wasm.agent.open';
  const isOpen = () => (embedded ? workspace.isOpen : root.dataset.open === 'true');
  function setOpen(open) {
    if (embedded) { open ? workspace.open() : workspace.close(); if (open) { unread = 0; setTimeout(() => input.focus(), 50); scrollToEnd(); } return; }
    root.dataset.open = String(open);
    if (screen) screen.style.right = open && layout === 'dock' ? `${ui.width || 420}px` : '';
    try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) { /* private mode */ }
    if (open) { unread = 0; badge.style.display = 'none'; setTimeout(() => input.focus(), 50); scrollToEnd(); }
    window.dispatchEvent(new Event('resize'));
  }
  if (embedded) { root.dataset.open = 'true'; workspace.el.addEventListener('ws-open', (e) => { if (e.detail.open) { unread = 0; workspace.setBadge(0); setTimeout(() => input.focus(), 50); scrollToEnd(); } }); }
  function setView(v) { root.dataset.view = v; settingsBtn.innerHTML = v === 'settings' ? I.back : I.gear; if (v === 'settings') renderSettings(); else input.focus(); }
  function setLayout(l) {
    if (embedded) return workspace.setLayout(l);
    if (standalone) return;
    layout = l === 'dock' ? 'dock' : 'float';
    root.dataset.layout = layout;
    setOpen(root.dataset.open === 'true');
  }

  // ------------------------------------------------------------------ floating card: move by the header, resize by the top-left grip; geometry remembered per browser
  const GEOMETRY_KEY = 'qgis-wasm.agent.geometry';
  const MARGIN = 22;
  const defaultGeometry = () => ({ x: MARGIN, y: MARGIN, w: ui.width || 420, h: ui.height || null }); // h null: full height, equal margins top and bottom
  const geom = defaultGeometry();
  try { Object.assign(geom, JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}')); } catch (e) { /* ignore */ }
  function applyGeometry(persist) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const full = geom.h == null;
    geom.w = Math.round(Math.max(320, Math.min(geom.w, vw - 16)));
    const hh = full ? vh - 2 * MARGIN : Math.round(Math.max(360, Math.min(geom.h, vh - 16)));
    if (!full) geom.h = hh; else geom.y = MARGIN;
    geom.x = Math.round(Math.max(8, Math.min(geom.x, vw - geom.w - 8)));
    geom.y = Math.round(Math.max(8, Math.min(geom.y, vh - hh - 8)));
    root.style.setProperty('--qa-fx', `${geom.x}px`); root.style.setProperty('--qa-fy', `${geom.y}px`);
    root.style.setProperty('--qa-fw', `${geom.w}px`); root.style.setProperty('--qa-fh', `${hh}px`);
    if (persist) try { localStorage.setItem(GEOMETRY_KEY, JSON.stringify(geom)); } catch (e) { /* ignore */ }
  }
  function draggable(handle, onMove, accept) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || layout !== 'float' || (accept && !accept(e))) return;
      e.preventDefault();
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      const start = { x: e.clientX, y: e.clientY, g: { ...geom } };
      root.classList.add('qa-moving');
      const move = (ev) => { onMove(ev.clientX - start.x, ev.clientY - start.y, start.g); applyGeometry(false); };
      const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); root.classList.remove('qa-moving'); applyGeometry(true); };
      handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
    });
  }
  if (!embedded) {
    draggable(header, (dx, dy, g) => { geom.x = g.x - dx; geom.y = g.y - dy; }, (e) => !e.target.closest('button'));
    draggable(grip, (dx, dy, g) => { geom.w = g.w - dx; geom.h = (g.h == null ? window.innerHeight - 2 * MARGIN : g.h) - dy; });
    window.addEventListener('resize', () => applyGeometry(false));
    applyGeometry(false);
  }
  // follow new content unless the user scrolled up to read something (force = always, e.g. after the user sent a message)
  function scrollToEnd(force = false) {
    const nearEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    if (!force && !nearEnd) return;
    requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
  }

  // ------------------------------------------------------------------ status line
  function updateStatus(st) {
    const state = !st.configured ? 'error' : st.busy ? 'busy' : 'ready';
    dot.dataset.state = state;
    const mcp = st.mcpServers.length ? ` · MCP ${st.mcpServers.filter((s) => s.ready).length}/${st.mcpServers.length}` : '';
    sub.textContent = st.configured ? `${st.model} · ${st.tools} tools${mcp}${st.host === 'remote' ? ' · remote' : ''}` : 'not configured — open settings';
    if (embedded) workspace.setSubtitle(`${state === 'busy' ? 'working · ' : state === 'error' ? 'agent not configured · ' : ''}${sub.textContent}`);
    sendBtn.dataset.mode = st.busy ? 'stop' : 'send';
    sendBtn.innerHTML = st.busy ? I.stop : I.send;
    sendBtn.title = st.busy ? 'Stop' : 'Send';
    renderEmpty();
  }
  function renderEmpty() {
    const show = agent.messages.length === 0;
    empty.style.display = show ? '' : 'none';
    if (!show) return;
    const chips = agent.suggestions().slice(0, 6);
    empty.replaceChildren(
      h('div', { class: 'qa-logo', style: 'width:44px;height:44px;margin:0 auto;border-radius:12px', html: I.spark }),
      h('h3', {}, 'What should QGIS do?'),
      h('p', {}, 'Import data, style layers, run analyses, save and share — in your own words.'),
      h('div', { class: 'qa-chips' }, ...chips.map((s) => h('button', { class: 'qa-chip', onclick: () => { input.value = s; send(); } }, s))),
    );
  }

  // ------------------------------------------------------------------ messages
  const els = new Map(); // message id → element
  function elFor(m) {
    let el = els.get(m.id);
    if (el) return el;
    if (m.role === 'user') el = h('div', { class: 'qa-msg user', 'data-id': m.id }, m.text);
    else if (m.role === 'assistant') el = h('div', { class: 'qa-msg assistant', 'data-id': m.id }, h('div', { class: 'qa-md' }));
    else el = h('details', { class: 'qa-tool', 'data-id': m.id, 'data-tool': m.name }, h('summary'), h('div', { class: 'qa-tool-body' }), h('div', { class: 'qa-tool-images' }));
    els.set(m.id, el);
    list.append(el);
    renderEmpty();
    return el;
  }
  let raf = 0;
  function refresh(m) {
    const el = elFor(m);
    if (m.role === 'user') { el.textContent = m.text; return; }
    if (m.role === 'assistant') {
      el.classList.toggle('error', !!m.error);
      const md = el.querySelector('.qa-md');
      md.innerHTML = render(m.text) + (m.streaming ? '<span class="qa-cursor"></span>' : '');
      for (const a of md.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener'; }
      return;
    }
    const tool = agent.registry.get(m.name);
    const state = m.running ? (m.awaitingConfirm ? 'confirm' : 'running') : m.error ? 'error' : 'ok';
    el.querySelector('summary').replaceChildren(
      state === 'running' ? h('span', { class: 'qa-spin' }) : h('span', { class: state === 'error' ? 'qa-err' : state === 'confirm' ? 'qa-err' : 'qa-ok', html: state === 'ok' ? I.check : I.warn, style: 'width:14px;height:14px;display:inline-flex' }),
      h('span', { class: 'qa-tool-name' }, m.name),
      h('span', { class: 'qa-tool-src' }, tool ? tool.source : 'tool'),
      h('span', { class: 'qa-tool-ms' }, m.running ? (m.awaitingConfirm ? 'needs your approval' : 'running…') : `${(m.ms / 1000).toFixed(1)}s`),
    );
    const body = el.querySelector('.qa-tool-body');
    body.replaceChildren(
      h('div', { class: 'qa-label' }, 'arguments'), h('pre', {}, JSON.stringify(m.args, null, 1)),
      ...(m.output !== undefined ? [h('div', { class: 'qa-label' }, m.error ? 'error' : 'result'), h('pre', { style: m.error ? 'color:var(--qa-danger)' : '' }, m.output)] : []),
    );
    const imgs = el.querySelector('.qa-tool-images');
    imgs.replaceChildren(...(m.images || []).map((src) => h('img', { src, alt: m.name })));
    if (m.images && m.images.length) el.open = true;
    if (m.error) el.open = true;
  }
  const scheduleRefresh = (m) => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; refresh(m); scrollToEnd(); }); };

  agent.addEventListener('message.added', (e) => { refresh(e.detail.message); scrollToEnd(e.detail.message.role === 'user'); });
  agent.addEventListener('message.removed', (e) => { els.get(e.detail.message.id)?.remove(); els.delete(e.detail.message.id); renderEmpty(); });
  agent.addEventListener('delta', (e) => scheduleRefresh(e.detail.message));
  agent.addEventListener('message', (e) => { refresh(e.detail.message); scrollToEnd(); if (!isOpen() && !standalone) { unread++; if (embedded) workspace.setBadge(unread); else { badge.textContent = String(unread); badge.style.display = 'grid'; } } });
  agent.addEventListener('tool.start', (e) => { refresh(e.detail.message); scrollToEnd(); });
  agent.addEventListener('tool.end', (e) => { refresh(e.detail.message); scrollToEnd(); });
  agent.addEventListener('reset', () => { for (const el of els.values()) el.remove(); els.clear(); renderEmpty(); });
  agent.addEventListener('status', (e) => updateStatus(e.detail));
  agent.addEventListener('turn.end', () => { input.disabled = false; });

  // waiting indicator: shown whenever the model is being awaited (after the user's message and after each tool), with the elapsed time —
  // the gateway's time to first token is seconds, and a silent panel reads as frozen
  const thinkingText = h('span', { class: 'qa-thinking-text' }, 'Thinking…');
  const thinking = h('div', { class: 'qa-thinking' }, h('span', { class: 'qa-spin' }), thinkingText);
  let thinkT0 = 0, thinkTimer = 0;
  function showThinking(on) {
    clearInterval(thinkTimer); thinkTimer = 0;
    if (!on) { thinking.remove(); return; }
    thinkT0 = performance.now();
    thinkingText.textContent = `Waiting for ${agent.config.model || 'the model'}…`;
    list.append(thinking);
    thinkTimer = setInterval(() => { thinkingText.textContent = `Waiting for ${agent.config.model || 'the model'} · ${((performance.now() - thinkT0) / 1000).toFixed(0)} s`; }, 500);
    scrollToEnd();
  }
  agent.addEventListener('turn.start', () => showThinking(true));
  agent.addEventListener('delta', () => showThinking(false));
  agent.addEventListener('tool.start', () => showThinking(false));
  agent.addEventListener('tool.end', () => showThinking(true));
  agent.addEventListener('turn.end', () => showThinking(false));
  agent.addEventListener('error', () => showThinking(false));
  agent.addEventListener('reset', () => showThinking(false));

  // approval of guarded tools
  agent.confirmHandler = (name, args, m) => new Promise((resolve) => {
    setOpen(true);
    setView('chat');
    const el = elFor(m); refresh(m); el.open = true; el.classList.add('qa-pending');
    const summary = JSON.stringify(args || {});
    const done = (ok) => { bar.remove(); el.classList.remove('qa-pending'); resolve(ok); };
    const bar = h('div', { class: 'qa-confirm' },
      h('span', { class: 'qa-confirm-icon', html: I.warn }),
      h('div', { class: 'qa-confirm-text' }, h('div', {}, h('b', {}, name), ' needs your approval'), h('code', { title: summary }, summary.length > 110 ? `${summary.slice(0, 107)}…` : summary)),
      h('div', { class: 'qa-confirm-actions' }, h('button', { class: 'qa-btn', onclick: () => done(false) }, 'Deny'), h('button', { class: 'qa-btn primary', onclick: () => done(true) }, 'Allow')),
    );
    approvals.append(bar);
    requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  });

  // ------------------------------------------------------------------ composer
  function autosize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; }
  async function send() {
    const text = input.value.trim();
    if (!text) return;
    if (agent.busy) return;
    input.value = ''; autosize(); hideCmds();
    try { await agent.ask(text); } catch (e) { agent.pushMessage({ role: 'assistant', text: `Error: ${e.message}`, error: true }); }
  }
  sendBtn.addEventListener('click', () => { if (agent.busy) agent.stop(); else send(); });
  input.addEventListener('input', () => { autosize(); updateCmds(); });
  input.addEventListener('keydown', (e) => {
    if (cmds.dataset.open === 'true') {
      const items = [...cmds.children]; let i = items.findIndex((x) => x.dataset.active === 'true');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); i = (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items.forEach((x, j) => { x.dataset.active = String(j === i); }); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && i >= 0) { e.preventDefault(); items[i].click(); return; }
      if (e.key === 'Escape') { hideCmds(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  function updateCmds() {
    const m = /^\/(\S*)$/.exec(input.value);
    if (!m) return hideCmds();
    const all = agent.commands().filter((c) => c.name.startsWith(m[1]));
    if (!all.length) return hideCmds();
    cmds.replaceChildren(...all.map((c, i) => h('div', { class: 'qa-cmd', 'data-active': String(i === 0), onclick: () => { input.value = `/${c.name} `; hideCmds(); input.focus(); autosize(); } }, h('b', {}, `/${c.name}`), h('span', {}, `${c.description} · ${c.skill}`))));
    cmds.dataset.open = 'true';
  }
  function hideCmds() { cmds.dataset.open = 'false'; }

  // files dropped on the panel → /home/web_user/uploads/<name> through the host's upload tool
  ['dragenter', 'dragover'].forEach((t) => panel.addEventListener(t, (e) => { e.preventDefault(); root.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((t) => panel.addEventListener(t, () => root.classList.remove('dragging')));
  panel.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!agent.registry.has('upload') && !(await agent.host.tools()).some((t) => t.name === 'upload')) { agent.pushMessage({ role: 'assistant', text: 'This host has no upload tool.', error: true }); return; }
    const paths = [];
    for (const f of files) {
      const base64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
      try { const { path } = await agent.host.call('upload', { name: f.name, base64 }); paths.push(path); } catch (err) { agent.pushMessage({ role: 'assistant', text: `Upload of ${f.name} failed: ${err.message}`, error: true }); }
    }
    if (paths.length) { input.value = `${input.value.trim()} ${paths.map((p) => `Import ${p}`).join('; ')}`.trim(); autosize(); input.focus(); }
  });

  // ------------------------------------------------------------------ settings
  function renderSettings() {
    const c = agent.config, st = agent.status();
    const field = (label, el) => h('div', { class: 'qa-field' }, h('label', {}, label), el);
    const provider = h('select', {}, ...listProviders().map((p) => h('option', { value: p.id, selected: p.id === c.provider ? '' : undefined }, p.label)));
    const model = h('input', { value: c.model || '', placeholder: 'model id' });
    const baseUrl = h('input', { value: c.baseUrl || '', placeholder: 'https://…/v1' });
    const apiKey = h('input', { type: 'password', value: c.apiKey || '', placeholder: 'API key (kept in this browser)' });
    const instructions = h('textarea', { placeholder: 'e.g. Always answer in Chinese. Name result layers "<input> · <operation>".' }, c.instructions || '');
    const confirm = h('input', { value: (c.tools.confirm || []).join(', '), placeholder: 'tools that need approval, comma separated, * allowed' });
    const deny = h('input', { value: (c.tools.deny || []).join(', '), placeholder: 'tools the model may never call' });
    const mcpName = h('input', { placeholder: 'name' }), mcpUrl = h('input', { placeholder: 'https://host/mcp' });
    const skillUrl = h('input', { placeholder: 'https://…/my-skill.js  or  skills/x.js' });
    const user = JSON.parse(localStorage.getItem('qgis-wasm.agent') || '{}');
    const save = async () => {
      await agent.updateConfig({ provider: provider.value, model: model.value.trim() || undefined, baseUrl: baseUrl.value.trim() || undefined, apiKey: apiKey.value || undefined, instructions: instructions.value,
        toolsConfirm: confirm.value.split(',').map((s) => s.trim()).filter(Boolean), toolsDeny: deny.value.split(',').map((s) => s.trim()).filter(Boolean) });
      renderSettings();
    };
    settings.replaceChildren(
      h('div', { class: 'qa-section' }, 'Model'),
      field('Provider', provider), field('Model', model), field('Base URL', baseUrl), field('API key', apiKey),
      h('div', { class: 'qa-section' }, 'Your instructions'), field('Added to every conversation', instructions),
      h('div', { class: 'qa-section' }, 'Tool policy'), field('Ask before running', confirm), field('Never run', deny),
      h('div', { class: 'qa-section' }, 'MCP servers (internal data sources)'),
      h('div', { class: 'qa-list' }, ...st.mcpServers.map((s) => h('div', { class: 'qa-row' }, h('span', { class: 'qa-grow' }, `${s.name} `, h('small', {}, s.url)), h('span', { class: `qa-tag ${s.ready ? 'ok' : 'err'}`, title: s.error || '' }, s.ready ? `${s.tools} tools` : (s.error ? 'error' : 'connecting')),
        (user.mcpServersExtra || []).some((x) => x.name === s.name) ? h('button', { class: 'qa-btn danger', onclick: async () => { await agent.updateConfig({ mcpServersExtra: (user.mcpServersExtra || []).filter((x) => x.name !== s.name) }); renderSettings(); } }, 'remove') : h('small', {}, 'preset')))),
      h('div', { class: 'qa-actions-row' }, mcpName, mcpUrl, h('button', { class: 'qa-btn', onclick: async () => { if (!mcpName.value || !mcpUrl.value) return; await agent.updateConfig({ mcpServersExtra: [...(user.mcpServersExtra || []), { name: mcpName.value.trim(), url: mcpUrl.value.trim(), proxy: 'auto' }] }); renderSettings(); } }, 'Add')),
      h('div', { class: 'qa-section' }, 'Skills'),
      h('div', { class: 'qa-list' }, ...st.skills.map((s) => h('div', { class: 'qa-row' }, h('input', { type: 'checkbox', checked: s.enabled ? '' : undefined, onchange: async (e) => { const d = new Set(user.disabledSkills || []); if (e.target.checked) d.delete(s.id); else d.add(s.id); await agent.updateConfig({ disabledSkills: [...d] }); renderSettings(); } }),
        h('span', { class: 'qa-grow' }, `${s.name} `, h('small', {}, s.error ? s.error : `${s.tools.length} tools${s.commands.length ? ', /' + s.commands.join(' /') : ''}`)),
        (user.skillsExtra || []).includes(s.url) ? h('button', { class: 'qa-btn danger', onclick: async () => { await agent.updateConfig({ skillsExtra: (user.skillsExtra || []).filter((u) => u !== s.url) }); renderSettings(); } }, 'remove') : h('small', {}, 'preset')))),
      h('div', { class: 'qa-actions-row' }, skillUrl, h('button', { class: 'qa-btn', onclick: async () => { if (!skillUrl.value) return; await agent.updateConfig({ skillsExtra: [...(user.skillsExtra || []), skillUrl.value.trim()] }); renderSettings(); } }, 'Add')),
      h('div', { class: 'qa-actions-row' }, h('button', { class: 'qa-btn primary', onclick: save }, 'Save'), h('button', { class: 'qa-btn', onclick: async () => { resetUserConfig(); if (!embedded) { try { localStorage.removeItem(GEOMETRY_KEY); } catch (e) { /* ignore */ } Object.assign(geom, defaultGeometry()); applyGeometry(false); } await agent.updateConfig({}, { persist: false }); renderSettings(); } }, 'Reset to preset'), h('button', { class: 'qa-btn', onclick: () => setView('chat') }, 'Back to chat')),
      h('div', { class: 'qa-note' }, `Preset "${agent.host.preset?.name || 'default'}" provides the defaults; your changes stay in this browser.${embedded ? ' Panel layout and position: the ⋯ menu of the workspace header.' : ''} QGIS ${st.api?.qgis || ''} · bridge API ${st.api?.bridgeApi || ''} · ${JSON.stringify(st.toolsBySource)}`),
    );
  }

  // ------------------------------------------------------------------ boot
  updateStatus(agent.status());
  for (const m of agent.messages) refresh(m);
  if (!embedded) {
    let openAtStart = standalone || !!ui.openOnStart;
    try { const saved = localStorage.getItem(OPEN_KEY); if (saved !== null && !standalone) openAtStart = saved === '1'; } catch (e) { /* ignore */ }
    setOpen(openAtStart);
    document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && e.code === 'Space') { e.preventDefault(); setOpen(root.dataset.open !== 'true'); } }, true);
  } else if (workspace.isOpen) setTimeout(() => input.focus(), 50);

  return { el: root, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()), setView, setLayout, get layout() { return embedded ? workspace.layout : layout; }, get isOpen() { return isOpen(); }, get embedded() { return embedded; } };
}
