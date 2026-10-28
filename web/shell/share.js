/**
 * share.js — one meaning of "share": a frozen, self-contained copy of the project in its own folder on the shared cloud
 * mount, addressed by a short id (docs/06 §3). The live "recipe" link (link.js view_link: ?add=source://… re-queries
 * on open) stays for live data and for links built by other systems; this is the stored one.
 *
 *   <mount>/<prefix>/<id>/
 *     project.qgz     the project, data sources rewritten to the copies below (QGIS writes them as relative paths)
 *     data/…          every layer file that existed only in this browser: query results, uploads, downloads, exports
 *     share.json      manifest: title, created, extent, and for every layer its source and where it came from
 *                     (source://osm/traffic_signals?bbox=…, a URL, …) — so a snapshot can be refreshed from its sources
 *
 *   ?share=<id>                      link.js opens <folder>/project.qgz and restores the extent
 *   tools  project_share { name }    → { id, url, path, copied, skipped }   (the agent's "share this project")
 *          share_open { id }         open a snapshot
 *          share_refresh { id? }     re-run the recorded queries of the current (or given) snapshot and rewrite the
 *                                    data files in place: layer ids, names, styles and order stay
 *
 * Transfers never block the tab: the snapshot is written under a cloudfs write-behind lease (the files stay in memory
 * while QGIS re-reads them and saves the project) and then uploaded asynchronously, in parallel, with byte counts;
 * opening a snapshot prefetches its files the same way before QGIS reads them. Each operation is a task on progress.js
 * (the workspace strip, the loading page's veil and the Debug view show it).
 *
 * QGIS sees files and two tools (project_save, layer_set_source); the mount, the id, the manifest and the link are page
 * concerns. Which mount: preset "share": { "mount": "shared", "prefix": "projects" } (default: the first mount).
 */
(function () {
  'use strict';

  let qgis = null, preset = {};
  const log = (m, err) => (err ? console.error : console.log)(m);
  const inst = () => window.qgisInstance;
  const LOCAL = /^\/(home\/web_user|tmp)\//; // exists only in this browser (IndexedDB)
  const FILE_PROVIDERS = ['ogr', 'gdal', 'delimitedtext', 'mdal'];
  const splitSource = (src) => { const i = String(src).indexOf('|'); return i < 0 ? [String(src), ''] : [src.slice(0, i), src.slice(i)]; };
  const fileOf = (src) => { let [path] = splitSource(src || ''); if (path.startsWith('file://')) path = decodeURIComponent(path.slice(7).split('?')[0]); return path; };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const exists = (path) => { try { inst().FS.stat(path); return true; } catch (e) { return false; } };
  const sizeOf = (path) => { try { return inst().FS.stat(path).size; } catch (e) { return 0; } };
  const readJson = (path) => { try { return JSON.parse(new TextDecoder().decode(inst().FS.readFile(path))); } catch (e) { return null; } };
  const writeJson = (path, obj) => inst().FS.writeFile(path, JSON.stringify(obj, null, 1));
  const copyFile = (src, dst) => { const fs = inst().FS; fs.mkdirTree(dst.slice(0, dst.lastIndexOf('/'))); fs.writeFile(dst, fs.readFile(src)); };
  const uniqueName = (dir, base, taken) => { let name = base, i = 2; const m = /^(.*?)(\.[^.]*)?$/.exec(base); while (taken.has(name) || exists(`${dir}/${name}`)) name = `${m[1]}-${i++}${m[2] || ''}`; taken.add(name); return name; };
  const GEOJSON = /\.(geo)?json$/i;
  const layerNameFor = (s) => (String(s || 'layer').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'layer').slice(0, 60);
  const P = () => window.qgisProgress || null;
  const fmtBytes = (n) => (P() ? P().fmt.bytes(n) : `${n} B`);
  const upload = (task, verb) => ({ done, total, file, files, finished }) => task?.update({ done, total, unit: 'bytes', detail: `${verb} ${file}${files > 1 ? ` (${Math.min(finished + 1, files)} of ${files})` : ''}` });

  /** The share location from the preset: { mount, prefix, root, folder(id) } */
  function config() {
    const share = preset.share || {};
    const mounts = window.qgisCloud ? window.qgisCloud.list() : [];
    const mount = mounts.find((m) => m.name === share.mount) || mounts[0];
    if (!mount) throw new Error('no cloud mount to share to (configure "mounts" and "share" in the preset)');
    const prefix = (share.prefix || 'projects').replace(/^\/+|\/+$/g, '');
    return { mount, prefix, root: `${mount.path}/${prefix}`, folder: (id) => `${mount.path}/${prefix}/${id}` };
  }
  /** The snapshot id a project path belongs to, or null */
  function idOf(projectPath) {
    try { const m = new RegExp(`^${escapeRe(config().root)}/([^/]+)/`).exec(projectPath || ''); return m ? m[1] : null; } catch (e) { return null; }
  }
  const link = (id, extent) => window.qgisLink.build({ preset: preset.name, share: id, extent: extent && extent.xmin !== undefined ? extent : null });
  // project.read, then the first canvas.refreshed after it (each with a timeout; the handlers are one-shot by flag)
  function watchOpen() {
    let read = false, rendered = false, onRead = null, onRendered = null;
    qgis.on('project.read', () => { if (read) return; read = true; onRead?.(); });
    qgis.on('canvas.refreshed', () => { if (!read || rendered) return; rendered = true; onRendered?.(); });
    const until = (flag, set, ms) => (flag() ? Promise.resolve() : new Promise((res) => { const tm = setTimeout(res, ms); set(() => { clearTimeout(tm); res(); }); }));
    return { read: (ms) => until(() => read, (f) => { onRead = f; }, ms), rendered: (ms) => until(() => rendered, (f) => { onRendered = f; }, ms) };
  }
  // the canvas already shows this extent (a snapshot opens at the view it was shared from): no second render
  async function sameExtent(ext) {
    try {
      const cur = await qgis.call('canvas_extent');
      if (!cur || cur.xmin === undefined || (ext.crs && cur.crs && ext.crs !== cur.crs)) return false;
      const tol = Math.max(cur.xmax - cur.xmin, cur.ymax - cur.ymin) * 0.002;
      return ['xmin', 'ymin', 'xmax', 'ymax'].every((k) => Math.abs(cur[k] - ext[k]) <= tol);
    } catch (e) { return false; }
  }
  // write-behind lease on a snapshot folder (null when the mount cannot upload asynchronously: then closes upload at once)
  const lease = (folder) => { try { return window.qgisCloud && window.qgisCloud.writeBehind ? window.qgisCloud.writeBehind(folder) : null; } catch (e) { log(`share: ${e.message}`); return null; } };

  /** A GeoJSON layer (or file) packed as a GeoPackage: QGIS writes it (native:savefeatures) to a local temp file and the
   *  bytes are copied to `dst`. Worth it for a snapshot — a GeoJSON has no spatial index and is parsed whole by every
   *  thread that opens it; the GeoPackage of a 10 MB / 25k-polygon result was 7.2 MB, took 0.3 s to write, opened in
   *  0.06 s instead of 0.5 s and rendered zoomed-in views 3–4× faster. Returns the size, or 0 when QGIS could not pack
   *  it (mixed geometries, odd fields…) — the caller then copies the file as it is. */
  async function pack(input, dst, layerName, task, label) {
    const tmp = `/tmp/share-pack/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.gpkg`;
    try {
      inst().FS.mkdirTree('/tmp/share-pack');
      task?.set(`Packing ${label} as GeoPackage`);
      await qgis.call('processing_run', { algorithm: 'native:savefeatures', parameters: { INPUT: input, OUTPUT: tmp, LAYER_NAME: layerName }, add_to_project: false });
      const size = sizeOf(tmp);
      if (!size) throw new Error('nothing written');
      copyFile(tmp, dst);
      return size;
    } catch (e) { log(`share: ${label} stays GeoJSON — could not pack it as GeoPackage: ${e.message || e}`); return 0; }
    finally { try { inst().FS.unlink(tmp); } catch (e) { /* never written */ } }
  }

  /** Freeze the current project into <root>/<id>/ (project + browser-local data + manifest); returns the short link */
  async function snapshot({ name, title } = {}) {
    if (!qgis) throw new Error('share is not initialised');
    const cfg = config();
    const id = newId();
    const folder = cfg.folder(id);
    const task = P()?.begin('Sharing a snapshot', { detail: 'Collecting the layers' });
    const held = lease(folder);
    try {
      const [info, layers, extent] = await Promise.all([qgis.call('project_info'), qgis.call('layers_list'), qgis.call('canvas_extent').catch(() => null)]);
      const manifest = { id, title: title || name || info.title || (info.file ? info.file.split('/').pop().replace(/\.qg[sz]$/i, '') : '') || 'project', created: new Date().toISOString(), preset: preset.name, origin: location.origin, project: 'project.qgz', extent: extent || null, layers: [], copied: [] };
      inst().FS.mkdirTree(`${folder}/data`);
      const taken = new Set();
      const origins = window.qgisLink ? window.qgisLink.origins : new Map();
      for (const l of layers) {
        const src = l.source || '';
        const file = fileOf(src);
        const entry = { id: l.id, name: l.name, provider: l.provider, source: src, origin: origins.get(l.id) || origins.get(file) || null };
        if (FILE_PROVIDERS.includes(l.provider) && LOCAL.test(file)) {
          if (!exists(file)) entry.note = 'its file is missing in this browser';
          else {
            const stem = file.split('/').pop() || 'layer';
            let base, dst, newSrc, size;
            // a GeoJSON goes into the snapshot as a GeoPackage (pack); anything else — and a GeoJSON QGIS cannot pack — as a copy
            if (l.provider === 'ogr' && GEOJSON.test(stem)) {
              const layerName = layerNameFor(stem.replace(GEOJSON, ''));
              base = uniqueName(`${folder}/data`, stem.replace(GEOJSON, '.gpkg'), taken); dst = `${folder}/data/${base}`;
              size = await pack(l.id, dst, layerName, task, l.name);
              if (size) { newSrc = `${dst}|layername=${layerName}`; entry.packed = 'geojson'; } else taken.delete(base);
            }
            if (!newSrc) {
              base = uniqueName(`${folder}/data`, stem, taken); dst = `${folder}/data/${base}`;
              task?.set(`Copying ${l.name} (${fmtBytes(sizeOf(file))})`);
              copyFile(file, dst);
              const [path, rest] = splitSource(src);
              const query = path.startsWith('file://') && path.includes('?') ? path.slice(path.indexOf('?')) : '';
              newSrc = (path.startsWith('file://') ? `file://${dst}${query}` : dst) + rest;
              size = sizeOf(file);
            }
            task?.set(`QGIS re-reads ${l.name} from the snapshot folder`); // CPU work in QGIS: the tab is busy for a moment
            await qgis.call('layer_set_source', { layer: l.id, source: newSrc });
            entry.source = newSrc; entry.data = `data/${base}`; entry.size = size;
            manifest.copied.push({ layer: l.name, from: file, to: entry.data, size, ...(entry.packed ? { packed: entry.packed } : {}) });
          }
        } else if (l.provider === 'memory') entry.note = 'in-memory layer: export it to a file first (it is not stored)';
        manifest.layers.push(entry);
      }
      task?.set('Saving the project');
      const saved = await qgis.call('project_save', { path: `${folder}/project.qgz` });
      manifest.size = saved.size || sizeOf(`${folder}/project.qgz`);
      writeJson(`${folder}/share.json`, manifest);
      if (held) { const n = held.pending().length; task?.update({ done: 0, total: 1, unit: 'bytes', detail: `Uploading ${n} file(s)` }); await held.flush({ onProgress: upload(task, 'Uploading') }); }
      const skipped = manifest.layers.filter((e) => e.note).map((e) => `${e.name}: ${e.note}`);
      log(`share: snapshot ${id} — ${manifest.copied.length} file(s) copied, ${skipped.length} skipped`);
      task?.finish('Link ready');
      return { id, folder, path: saved.path, size: saved.size, url: link(id, extent), copied: manifest.copied, skipped };
    } catch (e) { task?.fail(e); throw e; } finally { held?.release(); }
  }

  function resolve(id) {
    const cfg = config();
    const folder = cfg.folder(id);
    const manifest = readJson(`${folder}/share.json`);
    const project = `${folder}/${manifest?.project || 'project.qgz'}`;
    if (!manifest && !exists(project)) throw new Error(`no shared snapshot "${id}" under ${cfg.root}`);
    return { id, folder, project, manifest };
  }
  /** Open a snapshot: its files are downloaded first (with progress), then QGIS opens the project, then the manifest's extent (unless one is given) */
  async function open(id, { extent } = {}) {
    const cloud = window.qgisCloud && window.qgisCloud.prefetch ? window.qgisCloud : null;
    const task = P()?.begin(`Opening the shared snapshot ${id.slice(0, 8)}…`, { detail: 'Reading the manifest' });
    let r;
    try {
      // the manifest first, by its key: no directory listings on the way (each one is a round trip to the store)
      if (cloud) await cloud.prefetch([{ path: `${config().folder(id)}/share.json` }]);
      r = resolve(id);
      const entries = r.manifest?.layers || [];
      task?.update({ label: `Opening the shared snapshot “${r.manifest?.title || id.slice(0, 8)}”` });
      const files = [{ path: r.project, size: r.manifest?.size || 0 }, ...entries.filter((e) => e.data).map((e) => ({ path: `${r.folder}/${e.data}`, size: e.size || 0 }))];
      if (cloud) await cloud.prefetch(files, { onProgress: upload(task, 'Downloading') });
      task?.update({ done: null, total: null, detail: `QGIS is loading the project (${entries.length} layer${entries.length === 1 ? '' : 's'})` });
      // QGIS reads the project asynchronously after qgisOpen returns and renders the first view in its worker threads;
      // changing the extent while that first render still parses a big layer stalls the tab (the running job is
      // cancelled and waited for), so: wait for the project, then for its first rendered view, then set the extent
      const phases = watchOpen();
      await (window.qgisOpen ? window.qgisOpen(r.project) : qgis.open(r.project));
      await phases.read(120000);
      task?.set('QGIS is rendering the first view');
      await phases.rendered(45000);
      for (const e of entries) if (e.origin && window.qgisLink) { window.qgisLink.remember(e.id, e.origin); if (e.source) window.qgisLink.remember(fileOf(e.source), e.origin); } // view_link can still build a live link
      const ext = extent || r.manifest?.extent;
      if (ext && ext.xmin !== undefined && !(await sameExtent(ext))) { task?.set('Setting the view'); await qgis.call('canvas_set_extent', ext).catch(() => {}); }
      task?.finish();
      return { id, folder: r.folder, project: r.project, title: r.manifest?.title || null, layers: entries.length };
    } catch (e) { task?.fail(e); throw e; }
  }
  /** Re-run the recorded source:// queries of a snapshot and rewrite its data files in place */
  async function refresh({ id } = {}) {
    const info = await qgis.call('project_info');
    const sid = id || idOf(info.file);
    if (!sid) throw new Error('the current project is not a shared snapshot (project_share makes one)');
    const r = resolve(sid);
    if (!r.manifest) throw new Error(`snapshot ${sid} has no share.json`);
    if (!window.qgisSources) throw new Error('this page has no query sources (sources.js)');
    const task = P()?.begin(`Refreshing the snapshot “${r.manifest.title || sid.slice(0, 8)}”`, { detail: 'Re-running the recorded queries' });
    const held = lease(r.folder);
    try {
      const refreshed = [], skipped = [];
      const current = await qgis.call('layers_list');
      for (const e of r.manifest.layers) {
        if (!e.data || !e.origin || !/^source:\/\//i.test(e.origin)) { if (e.origin) skipped.push(`${e.name}: ${e.origin} (not a query)`); continue; }
        task?.set(`Querying ${e.origin}`);
        const out = await window.qgisSources.materialize(e.origin, { task });
        if (!out.file) { skipped.push(`${e.name}: ${e.origin} (no file)`); continue; }
        if (e.packed === 'geojson' || /\.gpkg$/i.test(e.data)) { // the snapshot holds this result as a GeoPackage: pack the new one the same way
          const layerName = (/\|layername=([^|]*)/.exec(e.source || '') || [])[1] || layerNameFor(e.name);
          if (!(await pack(out.file, `${r.folder}/${e.data}`, layerName, task, e.name))) { skipped.push(`${e.name}: the new result could not be packed as GeoPackage`); continue; }
        } else copyFile(out.file, `${r.folder}/${e.data}`);
        const target = current.find((l) => l.id === e.id) || current.find((l) => l.name === e.name);
        if (target) { task?.set(`QGIS re-reads ${e.name}`); await qgis.call('layer_set_source', { layer: target.id, source: e.source }); }
        refreshed.push(e.name);
      }
      r.manifest.refreshed = new Date().toISOString();
      writeJson(`${r.folder}/share.json`, r.manifest);
      if (held) await held.flush({ onProgress: upload(task, 'Uploading') });
      task?.finish();
      return { id: sid, refreshed, skipped };
    } catch (e) { task?.fail(e); throw e; } finally { held?.release(); }
  }

  const schema = (props = {}, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
  function init(q, p) {
    qgis = q; preset = p || {};
    qgis.registerTool('project_share', {
      source: 'shell',
      description: 'Share the current project as a frozen snapshot: copy it and every layer file that exists only in this browser (query results, uploads) into <mount>/projects/<id>/ on the shared cloud mount and return a short link (?share=<id>) that opens the same project, data and view for anyone with access. The snapshot remembers where each layer came from, so share_refresh can update it later.',
      inputSchema: schema({ name: { type: 'string', description: 'Optional title for the snapshot (defaults to the project title)' } }),
      run: ({ name } = {}) => snapshot({ name }),
    });
    qgis.registerTool('share_open', { source: 'shell', description: 'Open a shared snapshot by id (the ?share=<id> of a link).', inputSchema: schema({ id: { type: 'string' } }, ['id']), run: ({ id }) => open(id) });
    qgis.registerTool('share_refresh', { source: 'shell', description: 'Refresh the layers of the current shared snapshot (or the given id) from their recorded query sources: the data files are rewritten in place, layers keep their ids, names and styles.', inputSchema: schema({ id: { type: 'string', description: 'Snapshot id (default: the open project)' } }), run: ({ id } = {}) => refresh({ id }) });
  }

  window.qgisShare = { init, config, idOf, snapshot, resolve, open, refresh, link };
})();
