/**
 * link.js — the URL scheme of QGIS Desktop in the browser: deep links in, share links out.
 *
 * Everything about "what does this URL mean" lives here, on the page. QGIS knows nothing about URLs, presets or
 * sharing — it only sees tool calls (layers_add, basemaps_use, canvas_set_extent …). Query parameters, all optional
 * and combinable:
 *
 *   ?preset=<name>                      deployment preset (presets/<name>.json, default "default")
 *   ?open=<path|url>[,…]                open through QGIS itself: a project (.qgs/.qgz) replaces the current one,
 *                                       data files go through QGIS' own dialogs (sublayer choice …)
 *   ?add=<path|url|source://…>          add as layer(s) without dialogs — repeatable: a file in the virtual filesystem
 *                                       (/cloud/…, /qgis/share/demo/…), an http(s) URL (downloaded first), an XYZ
 *                                       tile template, or a query source: source://<name>/<collection>?q=…&bbox=…
 *   ?basemap=<name>                     add one of the preset's XYZ basemaps as the bottom layer
 *   ?crs=EPSG:3857                      project CRS
 *   ?extent=xmin,ymin,xmax,ymax[@CRS]   zoom to a bounding box (CRS defaults to EPSG:4326)
 *   ?ask=<text>                         hand a question to the web agent once it is ready (qgis-shell.js)
 *   ?trace=1 / ?force=1                 QGIS_WASM_TRACE to the console / skip the browser preflight (index.html)
 *
 *   window.qgisLink.parse(search?)       → { preset, open[], add[], basemap, crs, extent, ask }
 *   window.qgisLink.build(spec)          → absolute URL of this deployment for such a spec
 *   window.qgisLink.apply(qgis, spec)    → performs it (project first, then basemap, layers, CRS, extent)
 *   window.qgisLink.current(qgis, opts)  → { url, spec, skipped }: a link that reproduces the current view — the
 *                                          project if it lives on a cloud mount, otherwise the layers that are
 *                                          reachable from any browser (cloud files, URLs, query sources, basemaps)
 *   window.qgisLink.remember(key, spec)  → records where a downloaded file / a layer came from (used by current())
 *   window.qgisLink.init(qgis, opts)     → registers the page tool view_link and the Plugins → Share menu
 */
(function () {
  'use strict';

  const origins = new Map(); // virtual filesystem path or layer id → URL / source:// spec it was produced from
  const log = (m, err) => (err ? console.error : console.log)(m);
  const isUrl = (s) => /^https?:\/\//i.test(s);
  const isSourceSpec = (s) => /^source:\/\//i.test(s);
  const decode = (s) => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  /** files every deployment can see from any browser (not /home/web_user: that is this browser's IndexedDB) */
  const shareablePath = (p) => /^\/cloud\//.test(p) || /^\/qgis\/share\//.test(p);

  const num = (v) => Number(v.toFixed(Math.abs(v) >= 1000 ? 1 : 6));
  const fmtExtent = (e) => `${num(e.xmin)},${num(e.ymin)},${num(e.xmax)},${num(e.ymax)}${e.crs && e.crs !== 'EPSG:4326' ? '@' + e.crs : ''}`;
  function parseExtent(s) {
    if (!s) return null;
    const [coords, crs] = s.split('@');
    const n = coords.split(',').map(Number);
    if (n.length !== 4 || n.some(Number.isNaN)) return null;
    return { xmin: n[0], ymin: n[1], xmax: n[2], ymax: n[3], crs: crs || 'EPSG:4326' };
  }

  function parse(search = location.search) {
    const p = new URLSearchParams(search);
    // repeatable; a value without a query string of its own may also be a comma separated list (?open=a.qgz,b.geojson)
    const list = (key) => p.getAll(key).flatMap((v) => (v.includes('?') ? [v] : v.split(','))).map((s) => s.trim()).filter(Boolean);
    return { preset: p.get('preset') || 'default', share: p.get('share') || null, open: list('open'), add: list('add'), basemap: p.get('basemap') || null, crs: p.get('crs') || null, extent: parseExtent(p.get('extent')), ask: p.get('ask') || null };
  }

  function build(spec = {}) {
    const url = new URL(location.href);
    url.search = ''; url.hash = '';
    url.pathname = url.pathname.replace(/index\.html$/, ''); // short links that survive a directory move
    const q = url.searchParams;
    const preset = spec.preset || window.qgisPreset?.name || 'default';
    if (preset !== 'default') q.set('preset', preset);
    if (spec.share) q.set('share', spec.share); // a stored snapshot (share.js): <mount>/<prefix>/<id>/project.qgz
    for (const o of spec.open || []) q.append('open', o);
    for (const a of spec.add || []) q.append('add', a);
    if (spec.basemap) q.set('basemap', spec.basemap);
    if (spec.crs) q.set('crs', spec.crs);
    if (spec.extent) q.set('extent', fmtExtent(spec.extent));
    if (spec.ask) q.set('ask', spec.ask);
    return url.href;
  }

  async function addTarget(qgis, target) {
    if (isSourceSpec(target)) {
      if (!window.qgisSources) throw new Error('this page has no query sources (sources.js)');
      return (await window.qgisSources.loadSpec(target, { zoom: false })).layers;
    }
    return qgis.call('layers_add', { uri: target });
  }

  /** Apply a parsed link. Order matters: the project first (it replaces everything), then basemap (bottom), layers, CRS, extent. */
  // (afterProject fires once the project part — share / open — is done: the loading page drops its veil there)
  async function apply(qgis, spec, { log: out = log, afterProject } = {}) {
    const errors = [];
    const total = (spec.share ? 1 : 0) + (spec.open || []).length + (spec.basemap ? 1 : 0) + (spec.add || []).length + (spec.crs ? 1 : 0) + (spec.extent ? 1 : 0);
    const task = total && window.qgisProgress ? window.qgisProgress.begin('Opening the link', { done: 0, total, unit: 'steps' }) : null;
    let i = 0;
    const step = async (what, fn) => {
      task?.update({ done: i, detail: what });
      try { return await fn(); } catch (e) { errors.push(`${what}: ${e.message || e}`); out(`link: ${what} failed: ${e.message || e}`, true); return null; } finally { i++; }
    };
    try {
      await qgis.ready;
      if (spec.share) await step(`Opening the shared snapshot ${spec.share}`, () => { if (!window.qgisShare) throw new Error('this page has no share module (share.js)'); return window.qgisShare.open(spec.share, { extent: spec.extent }); });
      for (const target of spec.open || []) await step(`Opening ${target}`, () => (window.qgisOpen ? window.qgisOpen(target) : qgis.open(target)));
      try { afterProject?.(); } catch (e) { /* the page's concern */ }
      if (spec.basemap) await step(`Basemap ${spec.basemap}`, () => qgis.call('basemaps_use', { name: spec.basemap }));
      for (const target of spec.add || []) await step(`Adding ${target}`, () => addTarget(qgis, target));
      if (spec.crs) await step(`CRS ${spec.crs}`, () => qgis.call('project_set_crs', { crs: spec.crs }));
      if (spec.extent) await step('Setting the extent', () => qgis.call('canvas_set_extent', spec.extent));
      task?.finish(errors.length ? `${errors.length} step(s) failed` : '');
    } catch (e) { task?.fail(e); throw e; } finally { try { afterProject?.(); } catch (e) { /* idempotent */ } }
    return { errors };
  }

  /** A link that reproduces the current view (see header) */
  async function current(qgis, { layers = true } = {}) {
    const [info, extent] = await Promise.all([qgis.call('project_info'), qgis.call('canvas_extent')]);
    const spec = { preset: window.qgisPreset?.name, open: [], add: [], extent: { xmin: extent.xmin, ymin: extent.ymin, xmax: extent.xmax, ymax: extent.ymax, crs: extent.crs } };
    const skipped = [];
    const snapshotId = window.qgisShare ? window.qgisShare.idOf(info.file) : null;
    if (snapshotId) {
      spec.share = snapshotId; // the project is a stored snapshot: the short link
    } else if (info.file && shareablePath(info.file)) {
      spec.open.push(info.file);
    } else if (layers) {
      const [list, basemaps] = await Promise.all([qgis.call('layers_list'), qgis.call('basemaps_list').catch(() => [])]);
      for (const l of [...list].reverse()) { // the layer tree is top → bottom; a link adds bottom → top
        if (l.visible === false) continue;
        const src = l.source || '';
        const file = src.split('|')[0];
        const origin = origins.get(l.id) || origins.get(file);
        const xyz = /(?:^|&)type=xyz(?:&|$)/.test(src) ? /(?:^|&)url=([^&]+)/.exec(src) : null;
        const basemap = xyz ? basemaps.find((b) => decode(xyz[1]) === b.url) : null;
        if (basemap && !spec.basemap) spec.basemap = basemap.name;
        else if (xyz) spec.add.push(decode(xyz[1]));
        else if (origin) spec.add.push(origin);
        else if (shareablePath(file)) spec.add.push(src); // keep |layername=… so the same sublayer comes back
        else if (isUrl(file)) spec.add.push(file);
        else skipped.push(l.name);
      }
      if (info.file) skipped.unshift(`project file ${info.file} is not on a cloud mount (use project_share)`);
    }
    return { url: build(spec), spec, skipped };
  }

  const remember = (key, spec) => { if (key && spec) origins.set(key, spec); };

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
  }

  /** Page tool + QGIS menu entries. Called by qgis-shell.js once window.qgis exists. */
  function init(qgis, { menu = true } = {}) {
    qgis.registerTool('view_link', {
      description: 'A link that reproduces the current view in this web QGIS for anyone with access: the project if it is saved on a cloud mount, otherwise the shareable layers (cloud files, URLs, query sources, basemaps) plus the canvas extent. Layers that exist only in this browser are listed in "skipped" (save them to a cloud mount, or use project_share).',
      inputSchema: { type: 'object', properties: { layers: { type: 'boolean', description: 'Include the layers when the project is not on a cloud mount (default true)' } } },
      source: 'shell',
      run: ({ layers } = {}) => current(qgis, { layers: layers !== false }),
    });
    if (!menu) return;
    qgis.ready.then(async () => {
      await qgis.call('ui_add_action', { id: 'shell.link.project', text: 'Share a snapshot (stored on the cloud mount, frozen, short link)', menu: 'Share', toolbar: true, icon: 'mActionSharingExport.svg' });
      await qgis.call('ui_add_action', { id: 'shell.link.view', text: 'Copy a live link to this view (re-queries its sources when opened)', menu: 'Share' });
      await qgis.call('ui_add_action', { id: 'shell.link.refresh', text: 'Refresh this snapshot\'s layers from their sources', menu: 'Share' });
      await qgis.call('ui_add_action', { id: 'shell.link.mcp', text: 'Copy MCP endpoint of this page (for Claude Code and other agents)', menu: 'Share' });
      qgis.on('action', async ({ id }) => {
        if (!['shell.link.view', 'shell.link.project', 'shell.link.refresh', 'shell.link.mcp'].includes(id)) return;
        try {
          let url, note = '';
          if (id === 'shell.link.refresh') {
            const r = await qgis.call('share_refresh', {});
            await qgis.call('ui_message', { title: 'Share', text: `Refreshed ${r.refreshed.length} layer(s) of snapshot ${r.id}${r.skipped.length ? `; not queries: ${r.skipped.join('; ')}` : ''}`, level: 'success', duration: 10 });
            return;
          }
          if (id === 'shell.link.mcp') {
            // the server tells each page its own MCP endpoint (on a shared server it carries this page's client id)
            url = window.qgisAgentMcpUrl;
            if (!url) throw new Error('No agent server is connected to this page (scripts/serve.mjs provides /mcp).');
            note = ` Claude Code: claude mcp add --transport http qgis '${url}'.${window.qgisAgentShared ? ' The id is valid while this tab stays open.' : ''}`;
          } else if (id === 'shell.link.view') {
            const r = await current(qgis);
            url = r.url;
            if (r.skipped.length) note = ` Not in the link: ${r.skipped.join('; ')}.`;
          } else {
            const r = await qgis.call('project_share', {});
            url = r.url;
            if (r.skipped?.length) note = ` Not in the snapshot: ${r.skipped.join('; ')}.`;
          }
          const copied = await copy(url);
          await qgis.call('ui_message', { title: 'Share', text: `${copied ? 'Link copied to the clipboard: ' : 'Link: '}${url}${note}`, level: 'success', duration: 15 });
          if (!copied) window.prompt('Copy this link', url);
        } catch (e) {
          await qgis.call('ui_message', { title: 'Share', text: e.message || String(e), level: 'critical', duration: 12 }).catch(() => {});
        }
      });
    }).catch((e) => log(`link: menu failed: ${e.message}`, true));
  }

  window.qgisLink = { parse, build, apply, current, remember, init, origins, shareablePath };
})();
