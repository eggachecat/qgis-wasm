/**
 * pyqgis.js — Python plugins for QGIS Desktop in the browser.
 *
 * Python runs in Pyodide on the page (loaded on demand from a CDN or the preset's `python.indexUrl`). The PyQGIS
 * compatibility layer (web/shell/pyqgis/: qgis.core, qgis.gui, qgis.utils, qgis.PyQt, processing) is installed into
 * Pyodide's filesystem and talks to the real QGIS through the control surface (`window.qgis.call`) — synchronously,
 * thanks to Pyodide's JSPI based `run_sync`, so plugin code keeps its PyQGIS shape:
 *
 *   layer = QgsVectorLayer("/cloud/shared/data/a.gpkg|layername=roads", "Roads", "ogr")
 *   QgsProject.instance().addMapLayer(layer); iface.mapCanvas().setExtent(layer.extent())
 *
 * Rules: every entry into Python goes through pyodide.runPythonAsync() (needed for run_sync) and entries are
 * serialised. QGIS events are forwarded into Python the same way (signals), as are menu/toolbar action clicks.
 *
 *   window.qgisPython.run(code)            → run Python (returns the value of the last expression)
 *   window.qgisPython.loadPlugin(source)   → source: directory URL (…/<id>/ with files.json), .zip URL, or VFS dir
 *   window.qgisPython.unloadPlugin(id) / list()
 */
(function () {
  'use strict';

  const DEFAULT_INDEX = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
  const PLUGIN_ROOT = '/plugins'; // in Pyodide's filesystem
  const QGIS_PLUGIN_ROOT = '/home/web_user/python-plugins'; // mirror in QGIS' filesystem (icons, data)
  const state = { py: null, loading: null, queue: Promise.resolve(), plugins: new Map(), eventsWired: false };
  const log = (m, err) => (err ? console.error : console.log)(m);

  const loadScript = (url) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url; s.onload = resolve; s.onerror = () => reject(new Error(`could not load ${url}`));
    document.head.appendChild(s);
  });

  const enqueue = (fn) => {
    const next = state.queue.then(fn, fn);
    state.queue = next.catch(() => {});
    return next;
  };

  const toJs = (value) => {
    if (value && typeof value.toJs === 'function') {
      const v = value.toJs({ dict_converter: Object.fromEntries, create_proxies: false });
      value.destroy?.();
      return v;
    }
    return value;
  };

  async function ensure() {
    if (state.py) return state.py;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      const cfg = (window.qgisPreset && window.qgisPreset.python) || {};
      const indexURL = (cfg.indexUrl || DEFAULT_INDEX).replace(/\/?$/, '/');
      const t0 = performance.now();
      if (!window.loadPyodide) await loadScript(indexURL + 'pyodide.js');
      const py = await window.loadPyodide({ indexURL, stdout: (s) => console.log('[python] ' + s), stderr: (s) => console.warn('[python] ' + s) });
      // the compatibility layer
      const manifest = await (await fetch('pyqgis/manifest.json', { cache: 'no-cache' })).json();
      py.FS.mkdirTree(manifest.root);
      py.FS.mkdirTree(PLUGIN_ROOT);
      await Promise.all(manifest.files.map(async (f) => {
        const text = await (await fetch('pyqgis/' + f, { cache: 'no-cache' })).text();
        const dir = manifest.root + '/' + f.split('/').slice(0, -1).join('/');
        py.FS.mkdirTree(dir);
        py.FS.writeFile(manifest.root + '/' + f, text);
      }));
      py.runPython(`import sys\nfor p in (${JSON.stringify(manifest.root)}, ${JSON.stringify(PLUGIN_ROOT)}):\n    p in sys.path or sys.path.insert(0, p)`);
      await py.runPythonAsync('import qgis, qgis.utils, qgis.core, qgis.gui, processing');
      state.py = py;
      wireEvents();
      log(`python: Pyodide ${py.version} + PyQGIS compatibility layer ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
      return py;
    })();
    return state.loading;
  }

  function wireEvents() {
    if (state.eventsWired || !window.qgis) return;
    state.eventsWired = true;
    // signals: QGIS events → qgis._bridge._dispatch_event (through runPythonAsync, so handlers may call the bridge)
    window.qgis.on('*', (payload, type) => {
      if (!state.py || type === 'canvas.refreshed') return;
      enqueue(() => state.py.runPythonAsync(`import qgis._bridge as _b\n_b._dispatch_event(${JSON.stringify(type)}, ${JSON.stringify(JSON.stringify(payload))})`))
        .catch((e) => log(`python: event handler (${type}) failed: ${e.message || e}`, true));
    });
  }

  // --- plugin installation ------------------------------------------------------------------------------------------
  const mirrorToQgis = (id) => {
    // copy /plugins/<id> (Pyodide FS) → /home/web_user/python-plugins/<id> (QGIS FS) so QGIS can read icons / data
    const inst = window.qgisInstance;
    if (!inst) return;
    const walk = (src, dst) => {
      inst.FS.mkdirTree(dst);
      for (const name of state.py.FS.readdir(src)) {
        if (name === '.' || name === '..') continue;
        const s = `${src}/${name}`, d = `${dst}/${name}`;
        if (state.py.FS.isDir(state.py.FS.stat(s).mode)) walk(s, d);
        else inst.FS.writeFile(d, state.py.FS.readFile(s));
      }
    };
    walk(`${PLUGIN_ROOT}/${id}`, `${QGIS_PLUGIN_ROOT}/${id}`);
  };

  async function installFromDirectoryUrl(url) {
    const base = url.endsWith('/') ? url : url + '/';
    const id = decodeURIComponent(base.split('/').filter(Boolean).pop());
    const files = await (await fetch(base + 'files.json', { cache: 'no-cache' })).json();
    const py = state.py;
    py.FS.mkdirTree(`${PLUGIN_ROOT}/${id}`);
    for (const f of files) {
      const res = await fetch(base + f, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${res.status} for ${base + f}`);
      const dir = `${PLUGIN_ROOT}/${id}/` + f.split('/').slice(0, -1).join('/');
      py.FS.mkdirTree(dir);
      py.FS.writeFile(`${PLUGIN_ROOT}/${id}/${f}`, new Uint8Array(await res.arrayBuffer()));
    }
    return id;
  }

  async function installFromZipUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    const before = new Set(state.py.FS.readdir(PLUGIN_ROOT));
    state.py.unpackArchive(await res.arrayBuffer(), 'zip', { extractDir: PLUGIN_ROOT });
    const added = state.py.FS.readdir(PLUGIN_ROOT).filter((n) => !before.has(n) && n !== '.' && n !== '..' && !n.startsWith('__MACOSX'));
    if (!added.length) throw new Error('the zip did not contain a plugin directory');
    return added[0];
  }

  function installFromVfs(path) {
    const inst = window.qgisInstance;
    const id = path.replace(/\/+$/, '').split('/').pop();
    const walk = (src, dst) => {
      state.py.FS.mkdirTree(dst);
      for (const name of inst.FS.readdir(src)) {
        if (name === '.' || name === '..') continue;
        const s = `${src}/${name}`, d = `${dst}/${name}`;
        if (inst.FS.isDir(inst.FS.stat(s).mode)) walk(s, d);
        else state.py.FS.writeFile(d, inst.FS.readFile(s));
      }
    };
    walk(path.replace(/\/+$/, ''), `${PLUGIN_ROOT}/${id}`);
    return id;
  }

  async function loadPlugin(source) {
    await ensure();
    return enqueue(async () => {
      let id;
      if (/^https?:\/\//i.test(source) || !source.startsWith('/')) {
        const url = new URL(source, location.href).href;
        id = /\.zip($|\?)/i.test(url) ? await installFromZipUrl(url) : await installFromDirectoryUrl(url);
      } else {
        id = installFromVfs(source);
      }
      mirrorToQgis(id);
      const ok = toJs(await state.py.runPythonAsync(`import qgis.utils\nqgis.utils.unloadPlugin(${JSON.stringify(id)})\nqgis.utils.loadPlugin(${JSON.stringify(id)}) and qgis.utils.startPlugin(${JSON.stringify(id)})`));
      const metadata = toJs(await state.py.runPythonAsync(`import qgis.utils\n{k: qgis.utils.pluginMetadata(${JSON.stringify(id)}, k) for k in ("name", "version", "description", "author")}`));
      state.plugins.set(id, { id, source, ok: !!ok, metadata });
      if (!ok) throw new Error(`plugin ${id} failed to start (see console)`);
      log(`python: plugin ${id} (${metadata.name} ${metadata.version}) loaded from ${source}`);
      return { id, metadata };
    });
  }

  async function unloadPlugin(id) {
    if (!state.py) return false;
    const ok = toJs(await enqueue(() => state.py.runPythonAsync(`import qgis.utils\nqgis.utils.unloadPlugin(${JSON.stringify(id)})`)));
    state.plugins.delete(id);
    return !!ok;
  }

  async function run(code) {
    const py = await ensure();
    // run the code as Pyodide would (last expression = result) but turn Python exceptions into readable errors
    const wrapped = `import traceback as _tb\nfrom pyodide.code import eval_code_async as _eca\ntry:\n    __r = await _eca(${JSON.stringify(code)}, globals())\nexcept BaseException:\n    __r = {"__pyerror__": _tb.format_exc()}\n__r`;
    const result = toJs(await enqueue(() => py.runPythonAsync(wrapped)));
    if (result && typeof result === 'object' && result.__pyerror__) {
      const err = new Error(result.__pyerror__);
      err.name = 'PythonError';
      throw err;
    }
    return result;
  }

  window.qgisPython = {
    ensure,
    run,
    loadPlugin,
    unloadPlugin,
    list: () => [...state.plugins.values()],
    get ready() { return !!state.py; },
    get pyodide() { return state.py; },
    // QTimer support: fire a Python timer token through a proper entry point
    timer(ms, token) { setTimeout(() => run(`from qgis.PyQt.QtCore import QTimer\nQTimer._fire(${Number(token)})`).catch((e) => log(`python timer failed: ${e.message || e}`, true)), ms); },
  };
})();
