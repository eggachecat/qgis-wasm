/**
 * sources.js — pluggable *query* data sources for QGIS Desktop in the browser.
 *
 * Cloud mounts (cloudfs.js) make object storage look like files. Query sources are the other kind of external data:
 * services you ask a question — a collection, a bounding box, a few search words — and get features back: OGC API
 * Features endpoints, a dataset catalogue with download URLs, an internal HTTP API that returns GeoJSON. They are
 * declared in the preset ("sources": [...]) or added at runtime (qgisSources.add({...}) / the sources_add tool), and
 * reachable from everywhere through the shell:
 *
 *   tools     sources_list / sources_collections / sources_search / sources_load / sources_add — so the web agent,
 *             MCP clients and web plugins see every source automatically, nothing to configure twice
 *   menu      Plugins → Data sources → <source>…  (asks for a collection / search words, loads, zooms)
 *   links     ?add=source://<name>/<collection>?q=…&bbox=…&limit=…   (link.js; view_link reproduces such layers)
 *
 * QGIS itself only ever sees a file appearing in its virtual filesystem followed by a layers_add call.
 *
 * Built-in types (new ones: qgisSources.registerType(type, adapter)):
 *   ogcapi   OGC API – Features    { url: 'https://host/ogcapi' }                     collections → items?bbox=&limit=
 *   catalog  JSON catalogue        { url: 'https://host/catalog.json' }                [{ name, title, description, url, format }]
 *                                  optional search: 'https://host/search?q={q}'        (same shape, server side search)
 *   geojson  templated URL         { url: 'https://host/api?bbox={bbox}&q={q}&limit={limit}' }   one query → one layer
 *
 * An adapter implements (cfg = the source's configuration; everything async, errors are thrown):
 *   collections(cfg)                               → [{ id, title, description, extent? }]       optional
 *   search(cfg, { q, bbox, limit })                → [{ id, title, description, url?, format? }]  optional
 *   fetch(cfg, { collection, id, q, bbox, limit }) → { text | bytes, format, name } or { url, format, name }
 *
 * Common configuration: name, type, title, description, url, headers, params (extra query parameters), limit,
 * proxy (true / false / 'auto' — like cloudfs: when the browser blocks a request for lack of CORS headers it is
 * retried through the same-origin /proxy of scripts/serve.mjs).
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'qgis-wasm.sources';
  const ROOT = '/home/web_user/sources';
  const types = {};
  const sources = new Map(); // name → cfg
  let qgis = null;
  const log = (m, err) => (err ? console.error : console.log)(m);

  // ------------------------------------------------------------------ helpers
  const slug = (s) => String(s || 'query').normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'query';
  const join = (base, path) => `${String(base).replace(/\/+$/, '')}/${path}`;
  const tokens = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (words, text) => !words.length || words.every((w) => text.toLowerCase().includes(w));
  const extOf = (url) => (/\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url || '')) || [])[1]?.toLowerCase() || '';
  function bboxArray(b) {
    if (!b) return null;
    const n = (Array.isArray(b) ? b : String(b).split(',')).map(Number);
    if (n.length !== 4 || n.some(Number.isNaN)) throw new Error(`bbox must be xmin,ymin,xmax,ymax (got ${JSON.stringify(b)})`);
    return n;
  }
  const bboxString = (b) => { const n = bboxArray(b); return n ? n.join(',') : ''; };
  /** fill {q} {bbox} {limit} {collection} {id} into a URL template; parameters left empty are dropped */
  function fill(template, vars) {
    let url = String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] == null ? '' : String(vars[k])));
    url = url.replace(/([?&])[^&=?]+=(?=&|$)/g, '$1').replace(/&&+/g, '&').replace(/\?&/, '?').replace(/[?&]$/, '');
    return url;
  }

  const PROXY = () => `${location.origin}/proxy?url=`;
  async function http(cfg, url, init = {}) {
    const headers = { Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.5', ...(cfg.headers || {}), ...(init.headers || {}) };
    const check = (res) => { if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`); return res; };
    const prefix = typeof cfg.proxy === 'string' && cfg.proxy !== 'auto' ? cfg.proxy : PROXY();
    const viaProxy = () => fetch(prefix + encodeURIComponent(url), { ...init, headers });
    if (cfg.proxy === true || (typeof cfg.proxy === 'string' && cfg.proxy !== 'auto')) return check(await viaProxy());
    try {
      return check(await fetch(url, { ...init, headers }));
    } catch (e) {
      // TypeError: blocked by CORS or unreachable → same-origin proxy of scripts/serve.mjs (unless proxy: false)
      if (cfg.proxy === false || !(e instanceof TypeError)) throw e;
      if (!cfg._proxied) { cfg._proxied = true; log(`sources: ${cfg.name}: direct request blocked (CORS), using the same-origin /proxy`); }
      return check(await viaProxy());
    }
  }

  // ------------------------------------------------------------------ built-in adapters
  const pending = []; // preset sources whose type is not registered yet (a web plugin registers it after the preset is read)
  function registerType(type, adapter) {
    if (!type || typeof adapter?.fetch !== 'function') throw new Error('registerType(type, { collections?, search?, fetch })');
    types[type] = adapter;
    const mine = pending.filter((c) => c.type === type);
    if (mine.length) {
      pending.splice(0, pending.length, ...pending.filter((c) => c.type !== type));
      for (const cfg of mine) { try { add(cfg); } catch (e) { log(`sources: ${cfg?.name || cfg?.type}: ${e.message}`, true); } }
      if (qgis) registerTools();
    }
  }

  registerType('ogcapi', {
    async collections(cfg) {
      const res = await http(cfg, join(cfg.url, 'collections') + '?f=json');
      const j = await res.json();
      return (j.collections || []).map((c) => ({ id: c.id, title: c.title || c.id, description: c.description || '', extent: c.extent?.spatial?.bbox?.[0] }));
    },
    async search(cfg, { q } = {}) {
      const words = tokens(q);
      return (await this.collections(cfg)).filter((c) => matches(words, `${c.id} ${c.title} ${c.description}`));
    },
    async fetch(cfg, { collection, id, bbox, limit, q } = {}) {
      const col = collection || id;
      if (!col) throw new Error(`${cfg.name}: a collection is required (sources_collections lists them)`);
      const u = new URL(join(cfg.url, `collections/${encodeURIComponent(col)}/items`));
      u.searchParams.set('f', 'json');
      u.searchParams.set('limit', String(limit || cfg.limit || 1000));
      if (bbox) u.searchParams.set('bbox', bboxString(bbox));
      if (q) u.searchParams.set('q', q);
      for (const [k, v] of Object.entries(cfg.params || {})) u.searchParams.set(k, v);
      const res = await http(cfg, u.href);
      return { text: await res.text(), format: 'geojson', name: col };
    },
  });

  registerType('catalog', {
    async search(cfg, { q } = {}) {
      const res = await http(cfg, cfg.search ? fill(cfg.search, { q }) : cfg.url);
      const j = await res.json();
      const items = Array.isArray(j) ? j : j.datasets || j.items || j.results || [];
      const words = tokens(q);
      return items
        .filter((d) => cfg.search || matches(words, `${d.name || ''} ${d.title || ''} ${d.description || ''} ${(d.keywords || []).join(' ')}`))
        .map((d) => ({ id: d.name || d.id, title: d.title || d.name || d.id, description: d.description || '', url: d.url, format: d.format || extOf(d.url), size: d.size }));
    },
    async fetch(cfg, { collection, id, q } = {}) {
      const key = collection || id;
      const hits = await this.search(cfg, { q: key || q });
      const d = (key && (hits.find((h) => h.id === key) || hits.find((h) => h.title === key))) || (!key && hits.length === 1 ? hits[0] : null);
      if (!d) throw new Error(`${cfg.name}: ${key ? `no dataset named "${key}"` : `${hits.length} datasets match "${q}", pass the dataset name`}${hits.length ? ` (candidates: ${hits.slice(0, 8).map((h) => h.id).join(', ')})` : ''}`);
      if (!d.url) throw new Error(`${cfg.name}: dataset ${d.id} has no download URL`);
      return { url: d.url, format: d.format, name: d.title || d.id };
    },
  });

  registerType('geojson', {
    async fetch(cfg, { q, bbox, limit, collection, id } = {}) {
      const url = fill(cfg.url, { q, bbox: bbox ? bboxString(bbox) : '', limit: limit || cfg.limit || '', collection: collection || '', id: id || '' });
      const res = await http(cfg, url);
      return { text: await res.text(), format: 'geojson', name: [cfg.title || cfg.name, q || collection || id].filter(Boolean).join(' – ') };
    },
  });

  // ------------------------------------------------------------------ registry
  const get = (name) => { const c = sources.get(name); if (!c) throw new Error(`no query source named "${name}" (have: ${[...sources.keys()].join(', ') || 'none'})`); return c; };
  const info = (c) => ({ name: c.name, type: c.type, title: c.title || c.name, description: c.description || '', url: c.url, capabilities: { collections: !!types[c.type].collections, search: !!types[c.type].search, query: c.type === 'geojson' } });
  const loadUser = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch (e) { return []; } };
  const saveUser = (list) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ } };

  function add(cfg, { persist = false } = {}) {
    if (!cfg || !cfg.type) throw new Error('a source needs a "type"');
    if (!types[cfg.type]) throw new Error(`unknown source type "${cfg.type}" (have: ${Object.keys(types).join(', ')})`);
    if (!cfg.url) throw new Error(`source ${cfg.name || cfg.type}: "url" is required`);
    const c = { ...cfg };
    delete c.persist;
    c.name = c.name || slug(c.title || c.type);
    sources.set(c.name, c);
    if (persist) saveUser([...loadUser().filter((s) => s.name !== c.name), c]);
    return info(c);
  }
  function remove(name) {
    const had = sources.delete(name);
    saveUser(loadUser().filter((s) => s.name !== name));
    return had;
  }
  const list = () => [...sources.values()].map(info);
  async function collections(name) {
    const c = get(name);
    return types[c.type].collections ? types[c.type].collections(c) : [];
  }
  /** search one source, or every source that can search (results carry "source") */
  async function search(name, opts = {}) {
    const names = name ? [name] : [...sources.keys()];
    const out = [];
    await Promise.all(names.map(async (n) => {
      const c = get(n);
      if (!types[c.type].search) return;
      try {
        for (const hit of await types[c.type].search(c, opts)) out.push({ source: n, ...hit, spec: toSpec(n, { collection: hit.id }) });
      } catch (e) { if (name) throw e; log(`sources: ${n}: ${e.message}`, true); }
    }));
    return out;
  }

  // source://<name>/<collection>?q=…&bbox=…&limit=…
  function toSpec(name, { collection, id, q, bbox, limit } = {}) {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (bbox) p.set('bbox', bboxString(bbox));
    if (limit) p.set('limit', String(limit));
    const qs = p.toString();
    return `source://${encodeURIComponent(name)}/${encodeURIComponent(collection || id || '')}${qs ? '?' + qs : ''}`;
  }
  function parseSpec(spec) {
    const m = /^source:\/\/([^/?#]+)(?:\/([^?#]*))?(?:\?(.*))?$/i.exec(String(spec).trim());
    if (!m) throw new Error(`not a source spec: ${spec} (expected source://<name>/<collection>?q=…&bbox=…)`);
    const p = new URLSearchParams(m[3] || '');
    const o = { name: decodeURIComponent(m[1]) };
    if (m[2]) o.collection = decodeURIComponent(m[2]);
    if (p.get('q')) o.q = p.get('q');
    if (p.get('bbox')) o.bbox = p.get('bbox');
    if (p.get('limit')) o.limit = Number(p.get('limit'));
    return o;
  }

  /** Run a query and write the answer to a file under /home/web_user/sources (or return the dataset URL) — no layer yet */
  async function materialize(nameOrSpec, opts = {}) {
    let name = nameOrSpec;
    if (/^source:\/\//i.test(String(nameOrSpec))) { const parsed = parseSpec(nameOrSpec); name = parsed.name; opts = { ...parsed, ...opts }; }
    const cfg = get(name);
    const bbox = opts.bbox ? bboxArray(opts.bbox) : null;
    const query = { collection: opts.collection, id: opts.id, q: opts.q || opts.query, bbox, limit: opts.limit };
    const own = !opts.task && window.qgisProgress; // the caller's task (load) or one of our own
    const task = opts.task || (own ? window.qgisProgress.begin(`Querying ${cfg.title || name}`, { detail: query.collection || query.q || (bbox ? 'bbox' : '') }) : null);
    let out;
    try {
      out = await types[cfg.type].fetch(cfg, { ...query, progress: (detail) => task?.set(detail) });
      task?.set(out.url ? 'Handing the URL to QGIS' : `Writing the result (${window.qgisProgress ? window.qgisProgress.fmt.bytes((out.text ?? out.bytes ?? '').length) : ''})`);
    } catch (e) { if (own) task.fail(e); throw e; }
    if (own) task.finish();
    const spec = toSpec(name, query);
    if (out.url) return { source: name, spec, query, url: out.url, file: null, name: out.name || name };
    const body = out.text != null ? out.text : out.bytes;
    if (body == null) throw new Error(`${name}: the adapter returned neither data nor a URL`);
    const ext = out.format === 'geojson' || !out.format ? 'geojson' : out.format;
    const dir = `${ROOT}/${slug(name)}`;
    const file = `${dir}/${slug(out.name || query.collection || query.id || query.q)}-${Date.now().toString(36)}.${ext}`;
    const inst = window.qgisInstance;
    inst.FS.mkdirTree(dir);
    inst.FS.writeFile(file, body);
    return { source: name, spec, query, url: null, file, name: out.name || name };
  }

  /** Query a source and add the result to the project as layer(s) */
  async function load(name, opts = {}) {
    if (!qgis) throw new Error('sources are not initialised');
    const title = (() => { try { return get(/^source:\/\//i.test(String(name)) ? parseSpec(name).name : name).title; } catch (e) { return String(name); } })();
    const task = window.qgisProgress ? window.qgisProgress.begin(`Loading from ${title}`, { detail: opts.collection || opts.q || opts.query || '' }) : null;
    try {
      const out = await materialize(name, { ...opts, task });
      const layerName = opts.name || out.name || name;
      const file = out.file;
      task?.set(`QGIS is reading ${layerName}`);
      const layers = await qgis.call('layers_add', { uri: out.url || file, name: layerName });
      const spec = out.spec;
      for (const l of layers) { window.qgisLink?.remember(l.id, spec); window.qgisLink?.remember((l.source || '').split('|')[0], spec); }
      if (opts.zoom !== false && layers.length) { task?.set('Zooming to the layer'); await qgis.call('layers_zoom_to', { layer: layers[0].id }).catch(() => {}); }
      task?.finish();
      return { source: name, spec, file, layers };
    } catch (e) { task?.fail(e); throw e; }
  }
  const loadSpec = (spec, overrides = {}) => { const { name, ...query } = parseSpec(spec); return load(name, { ...query, ...overrides }); };

  // ------------------------------------------------------------------ page tools (agent / MCP / plugins) + QGIS menu
  const schema = (props = {}, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
  const S = (description, type = 'string') => ({ type, description });
  function registerTools() {
    qgis.registerTool('sources_list', { source: 'shell', description: 'List the configured query data sources of this deployment (OGC API Features endpoints, dataset catalogues, GeoJSON query APIs) with their capabilities. Use sources_collections / sources_search to see what they offer and sources_load to put results on the map.', inputSchema: schema(), run: async () => list() });
    qgis.registerTool('sources_collections', { source: 'shell', description: 'Collections (datasets, feature types) a query source offers.', inputSchema: schema({ source: S('Source name (sources_list)') }, ['source']), run: ({ source }) => collections(source) });
    qgis.registerTool('sources_search', { source: 'shell', description: 'Search one query source, or all of them, by words. Returns candidates with "spec" (source://…) that sources_load or a link can open.', inputSchema: schema({ source: S('Source name; omit to search every source'), query: S('Search words') }), run: ({ source, query }) => search(source || null, { q: query }) });
    qgis.registerTool('sources_load', { source: 'shell', description: 'Query a data source and add the result to the project as layer(s): the collection / dataset name (sources_collections, sources_search), optionally limited to a bounding box, a free text query and a maximum number of features. Returns the layers and the source:// spec that reproduces them in a link.', inputSchema: schema({ source: S('Source name'), collection: S('Collection or dataset name'), query: S('Free text query (q parameter / template {q})'), bbox: S('xmin,ymin,xmax,ymax in EPSG:4326 (optional)'), limit: S('Maximum number of features (optional)', 'integer'), name: S('Layer name (optional)'), zoom: S('Zoom to the result (default true)', 'boolean') }, ['source']), run: ({ source, ...o }) => load(source, o) });
    qgis.registerTool('sources_add', { source: 'shell', description: 'Register a query data source on this page: type "ogcapi" (url = OGC API Features landing page), "catalog" (url = JSON list of {name,title,description,url,format}; optional search = URL template with {q}) or "geojson" (url = template with {bbox} {q} {limit} returning GeoJSON). persist: remember it in this browser.', inputSchema: schema({ name: S('Short name'), type: { type: 'string', enum: Object.keys(types) }, title: S('Display title'), url: S('Endpoint / template'), search: S('catalog: search URL template with {q} (optional)'), proxy: S('true / false / "auto" (default)'), persist: S('Remember in this browser', 'boolean') }, ['type', 'url']), run: ({ persist, ...cfg }) => add(cfg, { persist: !!persist }) });
  }

  async function menuAction(cfg) {
    const t = types[cfg.type];
    const title = cfg.title || cfg.name;
    let value = '';
    if (t.collections) {
      const cols = await collections(cfg.name);
      value = window.prompt(`${title}\n\nCollection to load:\n${cols.slice(0, 25).map((c) => `  ${c.id}${c.title && c.title !== c.id ? ` — ${c.title}` : ''}`).join('\n')}${cols.length > 25 ? `\n  … ${cols.length - 25} more` : ''}`, cols[0]?.id || '');
      if (!value) return;
      await load(cfg.name, { collection: value });
    } else if (t.search) {
      value = window.prompt(`${title}\n\nDataset name or search words:`, '');
      if (!value) return;
      const hits = await search(cfg.name, { q: value });
      if (!hits.length) throw new Error(`nothing matches "${value}"`);
      let pick = hits.find((h) => h.id === value) || (hits.length === 1 ? hits[0] : null);
      if (!pick) {
        const chosen = window.prompt(`${hits.length} datasets match:\n${hits.slice(0, 25).map((h) => `  ${h.id} — ${h.title}`).join('\n')}\n\nDataset to load:`, hits[0].id);
        if (!chosen) return;
        pick = hits.find((h) => h.id === chosen) || hits.find((h) => h.title === chosen);
        if (!pick) throw new Error(`no dataset named "${chosen}"`);
      }
      await load(cfg.name, { collection: pick.id });
    } else {
      value = window.prompt(`${title}\n\nQuery (the {q} of the template):`, '');
      if (value == null) return;
      await load(cfg.name, { q: value });
    }
  }
  async function addMenu() {
    for (const cfg of sources.values()) {
      await qgis.call('ui_add_action', { id: `shell.source.${cfg.name}`, text: `${cfg.title || cfg.name}…`, menu: 'Data sources', icon: 'mActionAddLayer.svg' });
    }
    qgis.on('action', async ({ id }) => {
      if (!id?.startsWith('shell.source.')) return;
      const cfg = sources.get(id.slice('shell.source.'.length));
      if (!cfg) return;
      try {
        await menuAction(cfg);
      } catch (e) {
        await qgis.call('ui_message', { title: cfg.title || cfg.name, text: e.message || String(e), level: 'critical', duration: 12 }).catch(() => {});
      }
    });
  }

  /** Called by qgis-shell.js right after the preset is known */
  function init(q, preset = {}, { menu = true } = {}) {
    qgis = q;
    for (const cfg of [...(preset.sources || []), ...loadUser()]) {
      if (cfg && cfg.type && !types[cfg.type]) { pending.push(cfg); continue; } // registered later by a web plugin (preset "plugins")
      try { add(cfg); } catch (e) { log(`sources: ${cfg?.name || cfg?.type}: ${e.message}`, true); }
    }
    registerTools();
    if (menu && sources.size) qgis.ready.then(addMenu).catch((e) => log(`sources: menu failed: ${e.message}`, true));
    return list();
  }

  window.qgisSources = { registerType, add, remove, list, collections, search, load, loadSpec, materialize, toSpec, parseSpec, init, get types() { return Object.keys(types); } };
})();
