#!/usr/bin/env python3
"""End-to-end test of the browser features built around the QGIS WebAssembly desktop:

  control surface (window.qgis / QgsWasmBridge), deployment preset, cloud mounts (S3-compatible mock with SigV4),
  web plugin, compiled-in C++ plugins, Processing, map export, MCP server (scripts/serve.mjs /mcp), share links,
  the shell layer (query data sources: catalogue / OGC API Features / GeoJSON template; deep links and view_link;
  Share and Data sources menus), the browser preflight, pre-compressed transfer,
  and — with --llm — the in-app Assistant driving the real model the preset's agent section names + a mock MCP catalogue.

  python3 tests/e2e/features.py [--llm] [--keep] [--timeout 300]

Starts: scripts/serve.mjs (port 8123), tests/s3-mock.mjs (9123, seeded with tests/data + the demo GeoPackage),
tests/mock-mcp.mjs (9124). Uses the preset web/shell/presets/e2e.json.
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
# a deployment's own checks (its source types, its mocks) ride along from internal/tests/e2e_overlay.py when that overlay exists
overlay = None
if (ROOT / "internal/tests/e2e_overlay.py").exists():
    sys.path.insert(0, str(ROOT / "internal/tests")); import e2e_overlay as overlay  # noqa: E402
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")
PORT, S3_PORT, MCP_PORT = 8123, 9123, 9124
CANVASES = "document.querySelector('#qt-shadow-container')?.shadowRoot?.querySelectorAll('canvas').length || 0"

def http_json(url, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **(headers or {})}, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode() or "null"), dict(r.headers)

def pixel(page, x, y):
    return tuple(page.evaluate(f"(() => {{ const c = document.querySelector('#qt-shadow-container').shadowRoot.querySelector('canvas');"
                               f" return Array.from(c.getContext('2d').getImageData({x}, {y}, 1, 1).data).slice(0, 3); }})()"))

def call(page, tool, params=None):
    return page.evaluate("async ([t, p]) => window.qgis.call(t, p)", [tool, params or {}])

def pyrun(page, code, attempts=3):
    """Run PyQGIS style code through python_run; errors come back as a string instead of aborting the test."""
    for i in range(attempts):
        r = page.evaluate("async (code) => { try { return { ok: true, result: (await window.qgis.call('python_run', { code })).result }; } catch (e) { return { ok: false, error: (String((e && (e.message || e.stack)) || e) + ' name=' + (e && e.name) + ' type=' + (e && e.type)).slice(0, 1500) }; } }", code)
        if r["ok"]:
            return r["result"]
        print(f"    python_run attempt {i + 1} failed: {r['error'][:300]}", flush=True)
        page.wait_for_timeout(2000)
    return f"PYTHON ERROR: {r['error']}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(ROOT / "build/qgis/output/bin"))
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--llm", action="store_true", help="also run the Assistant (real model via the gateway in the preset)")
    ap.add_argument("--only-llm", action="store_true", help="skip the base checks, run only the Assistant part (implies --llm)")
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    if args.only_llm: args.llm = True
    os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
    os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")

    seed = pathlib.Path(tempfile.mkdtemp(prefix="qgis-wasm-s3-"))
    (seed / "data").mkdir()
    for f in (ROOT / "tests/data").glob("*.geojson"):
        shutil.copy(f, seed / "data" / f.name)
    shutil.copy(ROOT / "external/QGIS/resources/data/world_map.gpkg", seed / "data" / "world_map.gpkg")
    procs = [
        subprocess.Popen(["node", str(ROOT / "scripts/serve.mjs"), "--port", str(PORT), "--dir", os.path.relpath(args.dir, ROOT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL),
        subprocess.Popen(["node", str(ROOT / "tests/s3-mock.mjs"), "--port", str(S3_PORT), "--bucket", "gis", "--access", "TESTKEY", "--secret", "TESTSECRET", "--seed", str(seed)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=sys.stderr if args.verbose else subprocess.DEVNULL),
        subprocess.Popen(["node", str(ROOT / "tests/mock-mcp.mjs"), "--port", str(MCP_PORT), "--data", str(ROOT / "tests/data")], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=sys.stderr if args.verbose else subprocess.DEVNULL),
    ]
    time.sleep(1.5)
    shots = ROOT / "docs/screenshots"; shots.mkdir(parents=True, exist_ok=True)
    console, failures, results = [], [], []
    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail)); print(("  ✓ " if ok else "  ✗ ") + name + (f" — {detail}" if detail else ""), flush=True)
    base = f"http://127.0.0.1:{PORT}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, headless=not args.keep, args=["--use-angle=swiftshader", "--use-gl=angle", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"])
            context = browser.new_context(viewport={"width": 1600, "height": 950})
            page = context.new_page()
            page.on("console", lambda m: console.append(f"[{m.type}] {m.text}"))
            page.on("pageerror", lambda e: failures.append(f"pageerror: {e}"))
            net = []  # every response of the first page: url, request Range header, Content-Encoding
            page.on("response", lambda r: net.append({"url": r.url, "range": r.request.headers.get("range"), "encoding": r.headers.get("content-encoding"), "status": r.status}))
            t0 = time.time()
            page.goto(f"{base}/index.html?preset=e2e&trace=1", wait_until="domcontentloaded")
            page.wait_for_function("() => window.qgisBridgeReady === true || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
            check("QGIS started and the bridge is ready", page.evaluate("window.qgisBridgeReady === true"), f"{time.time()-t0:.1f}s")
            page.wait_for_function("() => document.getElementById('loading').classList.contains('hidden')", timeout=60000)  # the settle hold lifts ≈ 1.6 s after the bridge is up
            page.evaluate("() => window.qgis.on('*', (p, t) => { if (t !== 'canvas.extent' && t !== 'canvas.refreshed') console.log('[event] ' + t + ' ' + JSON.stringify(p).slice(0, 300)); })")

            if not args.only_llm:
                # ---- control surface
                tools = page.evaluate("async () => window.qgis.tools()")
                names = {t["name"] for t in tools}
                check("tool manifest", len(tools) >= 42 and {"state", "layers_add", "layer_set_source", "processing_run", "project_share", "share_refresh", "mounts_list"} <= names, f"{len(tools)} tools")
                state = call(page, "state")
                check("state snapshot", state["version"].startswith("4.") and "layers" in state, f"QGIS {state['version']}, crs={state['project']['crs']}")

                # ---- preset: basemaps, settings, favourites
                basemaps = call(page, "basemaps_list")
                check("preset basemaps are XYZ connections", any(b["name"] == "OpenStreetMap" for b in basemaps) and any(b["name"] == "E2E Local Tiles" for b in basemaps), ", ".join(b["name"] for b in basemaps))
                check("preset settings seeded", call(page, "settings_get", {"key": "qgis/checkVersion"}) in (False, "false"))

                # ---- cloud mount (S3-compatible, SigV4): browse, read, add layer, render
                mounts = call(page, "mounts_list")
                check("S3 mount present", any(m["path"] == "/cloud/gis" for m in mounts), json.dumps([m["path"] for m in mounts]))
                listing = call(page, "files_list", {"path": "/cloud/gis/data"})
                check("S3 directory listed through the virtual filesystem", any(e["name"] == "world_map.gpkg" and e["size"] > 100000 for e in listing), ", ".join(f"{e['name']}({e['size']})" for e in listing))
                layers = call(page, "layers_add", {"uri": "/cloud/gis/data/world_map.gpkg", "layer": "countries", "name": "Countries (S3)"})
                check("GeoPackage from S3 added as layer (ranged reads)", len(layers) == 1 and layers[0]["featureCount"] > 100, f"{layers[0]['name']}: {layers[0]['featureCount']} features" if layers else "no layer")
                countries = layers[0]["id"]
                call(page, "layer_set_style", {"layer": countries, "fill": "#b4d2b4", "stroke": "#505050", "stroke_width": 0.2})
                call(page, "layers_zoom_to", {"layer": countries})
                # land somewhere in the canvas (Africa / Asia / South America for a world extent; the exact layout depends on docks)
                land_points = [(860, 470), (1000, 380), (640, 560), (780, 430)]
                def land():
                    return [pt for pt in land_points if pixel(page, *pt) not in ((255, 255, 255), (0, 0, 0))]
                deadline = time.time() + 60
                while time.time() < deadline and not land():
                    page.wait_for_timeout(1000)
                check("layer rendered", bool(land()), f"land pixels at {land()}")
                geojson = call(page, "layers_add", {"uri": "/cloud/gis/data/european_cities.geojson"})
                check("GeoJSON from S3 added", geojson and geojson[0]["featureCount"] == 10, f"{geojson[0]['featureCount'] if geojson else 0} features")
                page.screenshot(path=str(shots / "qgis-wasm-cloud-layer.png"))

                # ---- style documents: layer_style_set / layer_style_get / layer_style_qml / layer_set_properties
                cities = geojson[0]["id"]
                st = call(page, "layer_style_set", {"layer": cities, "renderer": {"type": "categorized", "field": "name", "symbol": {"size": 3, "shape": "square", "stroke_color": "#ffffff"}},
                                                    "labels": {"field": "name", "size": 9, "color": "#102030", "bold": True, "buffer": {"size": 0.8, "color": "#ffffffcc"}, "placement": "over_point", "offset": [0, -2.5]}, "opacity": 0.9})
                cats = st["renderer"]["categories"]
                named = [c for c in cats if c["value"] not in ("", None)]  # QGIS adds the "all other values" class at the end
                check("layer_style_set: categorized renderer with one class per value (+ all other values) and a colour each", st["renderer"]["type"] == "categorized" and len(named) == 10 and len(cats) == 11 and len({c["color"] for c in cats}) == 11 and st["renderer"]["symbol"]["shape"] == "square", f"{len(cats)} categories, e.g. {cats[0]}")
                check("layer_style_set: labels with buffer, placement and offset round-trip through layer_style_get", st["labels"]["enabled"] and st["labels"]["bold"] and st["labels"]["buffer"]["enabled"] and st["labels"]["placement"] == "over_point" and st["labels"]["offset"] == [0, -2.5] and abs(st["opacity"] - 0.9) < 1e-6, json.dumps(st["labels"])[:160])
                st = call(page, "layer_style_set", {"layer": cities, "renderer": {"type": "graduated", "field": "population", "classes": 3, "mode": "quantile", "ramp": "Blues"}})
                rng = st["renderer"]["ranges"]
                check("layer_style_set: graduated classes computed by QGIS with a named colour ramp", st["renderer"]["type"] == "graduated" and len(rng) == 3 and rng[0]["lower"] < rng[-1]["upper"] and len({r["color"] for r in rng}) == 3, f"{[(r['lower'], r['upper'], r['color']) for r in rng]}")
                qml = call(page, "layer_style_qml", {"layer": cities})["qml"]
                call(page, "layer_style_set", {"layer": cities, "renderer": {"type": "single", "symbol": {"color": "#000000"}}, "labels": {"enabled": False}})
                call(page, "layer_style_qml", {"layer": cities, "qml": qml})
                back = call(page, "layer_style_get", {"layer": cities})
                check("layer_style_qml: QML export re-imported restores renderer and labels", qml.lstrip().startswith("<!DOCTYPE qgis") and back["renderer"]["type"] == "graduated" and back["labels"]["enabled"] and back["labels"]["field"] == "name", f"{len(qml)} chars of QML")
                renamed = call(page, "layer_set_properties", {"layer": cities, "name": "European cities", "max_scale": 1000})
                bad = page.evaluate("async (l) => { try { await window.qgis.call('layer_style_set', { layer: l, renderer: { type: 'graduated', field: 'name', classes: 3 } }); return ''; } catch (e) { return e.message; } }", cities)
                check("layer_set_properties renames; a graduated renderer on a text field is refused with a hint", renamed["name"] == "European cities" and "numeric" in bad, bad[:120])
                call(page, "layer_set_style", {"layer": cities, "fill": "rgba(255,0,0,0.6)", "size": 2.5, "label_field": "name", "label_color": "#aa0000", "label_buffer": 1})
                quick = call(page, "layer_style_get", {"layer": cities})
                check("layer_set_style keeps working (rgba colours, label colour / buffer)", quick["renderer"]["symbol"]["color"].startswith("rgba(255,0,0") and quick["labels"]["color"] == "#aa0000" and quick["labels"]["buffer"]["enabled"], json.dumps(quick["renderer"]["symbol"])[:120])

                # ---- lazy assets: the build leaves world_map.gpkg out of qgis.data (qgis.lazy.json); the shell mounts it over
                # HTTP next to qgis.js and links the original path to it — QGIS opens the usual path, the bytes come on first read
                lazy = page.evaluate("async () => { const r = await fetch('qgis.lazy.json'); return r.ok ? r.json() : {}; }")
                lazy_vfs = next((f["vfs"] for f in lazy.get("files", []) if f["path"] == "world_map.gpkg"), None)
                is_link = bool(lazy_vfs) and page.evaluate("(p) => { const FS = window.qgisInstance.FS; return FS.isLink(FS.lstat(p).mode); }", lazy_vfs)
                lazy_hits = lambda: [r for r in net if r["url"] == f"{base}/world_map.gpkg"]
                check("lazy asset: world_map.gpkg left out of qgis.data, linked into the virtual filesystem, not downloaded at startup",
                      lazy_vfs and is_link and not lazy_hits(), f"{lazy_vfs} link={is_link}, downloads so far={len(lazy_hits())}")
                world = call(page, "layers_add", {"uri": f"{lazy_vfs}|layername=countries", "name": "World (lazy)"})
                hits = lazy_hits()
                check("lazy asset fetched on first read: one whole-file GET without Range (content negotiated), layer complete",
                      len(world) == 1 and world[0]["featureCount"] == 240 and len(hits) == 1 and not hits[0]["range"],
                      f"{world[0]['featureCount'] if world else 0} features, {len(hits)} request(s), encoding={hits[0]['encoding'] if hits else None}")
                if world:
                    call(page, "layers_remove", {"layer": world[0]["id"]})

                # ---- cloud write-back: files + project share link
                call(page, "files_write_text", {"path": "/cloud/gis/notes/hello.txt", "text": "written from the browser QGIS"})
                keys, _ = http_json(f"http://127.0.0.1:{S3_PORT}/_debug/keys")
                check("file written through the mount arrived in the bucket (PUT)", any(k["key"] == "notes/hello.txt" and k["size"] > 10 for k in keys))
                share = call(page, "project_share", {})  # a snapshot: <mount>/projects/<id>/{project.qgz, share.json, data/} and a short ?share=<id> link
                keys, _ = http_json(f"http://127.0.0.1:{S3_PORT}/_debug/keys")
                import re as _re
                check("snapshot stored under a generated id in the bucket (project + manifest) and a short share link returned",
                      any(k["key"] == f"projects/{share['id']}/project.qgz" and k["size"] > 1000 for k in keys) and any(k["key"] == f"projects/{share['id']}/share.json" for k in keys)
                      and f"share={share['id']}" in share["url"] and "open=" not in share["url"] and share["copied"] == [], share["url"])

                # ---- web plugin (menu action) + compiled-in C++ plugins
                page.evaluate("() => { window.__actions = []; window.qgis.on('action', (e) => window.__actions.push(e.id)); }")
                call(page, "ui_trigger_action", {"id": "example.summary"})
                page.wait_for_timeout(500)
                check("web plugin menu action triggered → page handler", page.evaluate("window.__actions") == ["example.summary"])
                plugins = call(page, "plugins_list")
                check("compiled-in C++ plugins listed", {p["key"] for p in plugins} >= {"plugin_topology", "plugin_geometrychecker"}, ", ".join(f"{p['name']} {p['version']}" for p in plugins))
                loaded = call(page, "plugins_load", {"key": "plugin_topology"})
                check("C++ plugin (Topology Checker) loaded", loaded["loaded"] is True)

                # ---- Python plugins (Pyodide + PyQGIS compatibility layer)
                deadline = time.time() + 120
                while time.time() < deadline and not page.evaluate("() => window.qgisPython && window.qgisPython.list().some(p => p.id === 'hello_pyqgis')"):
                    page.wait_for_timeout(1000)
                pyplugins = page.evaluate("() => window.qgisPython.list()")
                check("Python plugin loaded (Pyodide + PyQGIS layer)", any(p["id"] == "hello_pyqgis" and p["ok"] for p in pyplugins), json.dumps([p.get("metadata", {}).get("name") for p in pyplugins]))
                py = pyrun(page, "from qgis.core import QgsProject, QgsFeatureRequest\nl = QgsProject.instance().mapLayersByName('Countries (S3)')[0]\n(l.featureCount(), [f['NAME'] for f in l.getFeatures(QgsFeatureRequest(\"\\\"NAME\\\" LIKE 'Braz%'\"))])")
                check("PyQGIS style code reads the S3 layer", isinstance(py, list) and py[0] == 240 and py[1] == ["Brazil"], json.dumps(py)[:300])
                py = pyrun(page, "import qgis.utils, processing\nout = qgis.utils.plugins['hello_pyqgis'].buffer(1.5)\n(out.name(), out.featureCount())")
                check("processing.run from Python added a result layer", isinstance(py, list) and py[1] > 0, json.dumps(py)[:300])
                action_id = pyrun(page, "import qgis.utils\nqgis.utils.plugins['hello_pyqgis'].actions[0]._bridge_id")
                n_before = len(call(page, "layers_list"))
                call(page, "ui_trigger_action", {"id": action_id})
                page.wait_for_timeout(4000)
                check("QGIS menu entry of the Python plugin runs its Python callback", len(call(page, "layers_list")) == n_before + 1, f"action {action_id}, layers {n_before} → {len(call(page, 'layers_list'))}")
                # PyQGIS symbology / labelling classes on top of the style documents
                py = pyrun(page, "from qgis.core import QgsProject, QgsPalLayerSettings, QgsTextFormat, QgsVectorLayerSimpleLabeling, QgsSymbol, QgsSingleSymbolRenderer, QgsCategorizedSymbolRenderer, QgsRendererCategory\nfrom qgis.PyQt.QtGui import QColor\n"
                                 "l = QgsProject.instance().mapLayersByName('European cities')[0]\n"
                                 "s = QgsPalLayerSettings(); s.fieldName = 'name'; s.placement = QgsPalLayerSettings.OverPoint\n"
                                 "f = QgsTextFormat(); f.setSize(12); f.setColor(QColor('red')); f.buffer().setEnabled(True); s.setFormat(f)\n"
                                 "l.setLabeling(QgsVectorLayerSimpleLabeling(s)); l.setLabelsEnabled(True); l.triggerRepaint()\n"
                                 "sym = QgsSymbol.defaultSymbol(l.geometryType()); sym.setColor(QColor('#0044ff')); sym.setSize(4)\n"
                                 "l.setRenderer(QgsSingleSymbolRenderer(sym))\n"
                                 "single = (l.renderer().symbol().color().name(), l.renderer().symbol().size())\n"
                                 "cat = QgsCategorizedSymbolRenderer('name', [QgsRendererCategory('Paris', sym.clone(), 'Paris'), QgsRendererCategory('Rome', sym.clone(), 'Rome')]); l.setRenderer(cat)\n"
                                 "lab = l.labeling().settings()\n"
                                 "(l.labelsEnabled(), lab.fieldName, lab.format().color().name(), lab.format().buffer().enabled(), lab.placement, single, l.renderer().type(), [c.label() for c in l.renderer().categories()])")
                check("PyQGIS labelling and renderer classes drive the real layer (QgsPalLayerSettings, QgsTextFormat, renderers)", py == [True, "name", "#ff0000", True, 1, ["#0044ff", 4], "categorizedSymbol", ["Paris", "Rome"]], json.dumps(py)[:200])
                hint = pyrun(page, "msg = 'no error'\ntry:\n    from qgis.core import QgsRuleBasedRenderer\nexcept ImportError as e:\n    msg = str(e)\nmsg[:120]")
                check("a PyQGIS name outside the subset fails with a hint instead of a bare ImportError", isinstance(hint, str) and "not part of the browser PyQGIS compatibility layer" in hint, str(hint)[:100])
                page.screenshot(path=str(shots / "qgis-wasm-python-plugin.png"))

                # ---- processing + map export
                run = call(page, "processing_run", {"algorithm": "native:centroids", "parameters": {"INPUT": countries}})
                check("Processing algorithm ran and result layer added", run["layers"] and run["layers"][0]["featureCount"] > 100, f"{run['layers'][0]['name']}: {run['layers'][0]['featureCount']}" if run["layers"] else run.get("log", "")[:200])
                # a file destination (native:savefeatures → GeoPackage) takes a plain path; the bridge used to wrap it like a layer sink and the algorithm saw an empty filename
                page.evaluate("() => window.qgisInstance.FS.mkdirTree('/home/web_user/exports')")
                saved = call(page, "processing_run", {"algorithm": "native:savefeatures", "parameters": {"INPUT": countries, "OUTPUT": "/home/web_user/exports/countries.gpkg", "LAYER_NAME": "countries"}, "add_to_project": False})
                gsize = page.evaluate("() => { try { return window.qgisInstance.FS.stat('/home/web_user/exports/countries.gpkg').size; } catch (e) { return -1; } }")
                reopened = call(page, "layers_add", {"uri": "/home/web_user/exports/countries.gpkg|layername=countries", "name": "Countries (GeoPackage copy)"})
                reopened = reopened[0] if isinstance(reopened, list) else reopened
                check("processing_run writes a file destination (native:savefeatures → GeoPackage) that QGIS reopens", gsize > 10000 and reopened.get("featureCount") == 240 and str(saved.get("results", {}).get("OUTPUT", "")).startswith("/home/web_user/exports/countries.gpkg"), f"{gsize} bytes, {reopened.get('featureCount')} features, results {json.dumps(saved.get('results'))[:100]}")
                export = call(page, "canvas_export_image", {"width": 480, "height": 320})
                image = call(page, "file_base64", {"path": export["path"]})
                check("map exported to PNG", image["size"] > 2000 and image["mimeType"] == "image/png", f"{export['path']} {image['size']} bytes")

                # ---- MCP server (Streamable HTTP) → page → QGIS
                init, headers = http_json(f"{base}/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}}})
                check("MCP initialize", init["result"]["serverInfo"]["name"] == "qgis-wasm" and "Mcp-Session-Id" in headers)
                lst, _ = http_json(f"{base}/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
                check("MCP tools/list", len(lst["result"]["tools"]) >= 40)
                res, _ = http_json(f"{base}/mcp", {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "layers_list", "arguments": {}}})
                text = res["result"]["content"][0]["text"]
                check("MCP tools/call layers_list", "Countries (S3)" in text and not res["result"]["isError"])
                res, _ = http_json(f"{base}/mcp", {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "canvas_export_image", "arguments": {"width": 320, "height": 200}}})
                check("MCP canvas_export_image returns an image block", any(c["type"] == "image" and len(c["data"]) > 1000 for c in res["result"]["content"]))
                res, _ = http_json(f"{base}/mcp", {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "layer_select", "arguments": {"layer": countries, "expression": "\"NAME\" = 'Brazil'", "zoom": True}}})
                check("MCP tools/call layer_select", json.loads(res["result"]["content"][0]["text"])["selected"] == 1)
                page.screenshot(path=str(shots / "qgis-wasm-mcp-selection.png"))

                # ---- share link in a second tab: project from the cloud mount
                page2 = context.new_page()
                page2.goto(share["url"], wait_until="domcontentloaded")
                page2.wait_for_function("() => window.qgisBridgeReady === true || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
                deadline = time.time() + 60
                while time.time() < deadline and not any(l["name"] == "Countries (S3)" for l in call(page2, "layers_list")):
                    page2.wait_for_timeout(1000)
                l2 = call(page2, "layers_list")
                check("share link opens the project from object storage in a new tab", any(l["name"] == "Countries (S3)" for l in l2), ", ".join(l["name"] for l in l2))
                page2.wait_for_function("() => document.getElementById('loading').classList.contains('hidden')", timeout=20000)
                st2 = page2.evaluate("() => ({ stages: window.qgisLoadStats.stages.map((s) => s.text), holdMs: Math.round(window.qgisLoadStats.hiddenAt - window.qgisLoadStats.loadedAt) })")
                check("the loading page stays as a veil over the appearing QGIS while a ?share= link downloads and opens its snapshot (its own stage text), and goes away once the project is in",
                      any(s.startswith("Opening the shared snapshot") for s in st2["stages"]) and any(s == "QGIS is running — opening the project" for s in st2["stages"]) and st2["holdMs"] >= 0, f"held {st2['holdMs']} ms after QGIS was up; stages: {st2['stages'][-4:]}")
                page2.screenshot(path=str(shots / "qgis-wasm-share-link.png"))
                page2.close()

                # ---- after a worker thread crash Emscripten unwinds the main thread with the string "unwind" (docs/02):
                #      the shell turns it into one clear error, flags the tab and shows the crash bar (own tab: the state is sticky)
                page5 = context.new_page()
                page5.goto(f"{base}/index.html?preset=e2e", wait_until="domcontentloaded")
                page5.wait_for_function("() => window.qgisBridgeReady === true || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
                # (only the probe's own call trips the trap: the page is still booting plugins and the agent, which call too)
                page5.evaluate("() => { const inst = window.qgisInstance, orig = inst.ccall.bind(inst); inst.ccall = (name, ...rest) => { if (name === 'qgis_wasm_call' && rest[2] && rest[2][1] === 'files_list' && /unwind-probe/.test(rest[2][2])) throw 'unwind'; return orig(name, ...rest); }; }")
                unwound = page5.evaluate("async () => { try { await window.qgis.call('files_list', { path: '/home/web_user/unwind-probe' }); return ''; } catch (e) { return e.message; } }")
                crash_ui = page5.evaluate("() => ({ status: window.qgisStatus, bar: !!document.querySelector('.ws-crash'), text: (document.querySelector('.ws-crash') || {}).textContent || '' })")
                check("\"unwind\" from the main thread becomes a clear error, the tab is flagged and the crash bar appears", "no longer usable in this tab" in unwound and crash_ui["status"] == "crashed" and crash_ui["bar"] and "Reload" in crash_ui["text"], unwound[:100])
                page5.close()

                # ---- shell layer: query data sources (sources.js) — catalogue, OGC API Features, GeoJSON template; QGIS knows none of them
                srcs = call(page, "sources_list")
                check("preset query sources registered as page tools", {s["name"] for s in srcs} >= {"catalog", "features", "cities-api"} and {"sources_search", "sources_load", "view_link"} <= names, ", ".join(f"{s['name']}({s['type']})" for s in srcs))
                cols = call(page, "sources_collections", {"source": "features"})
                check("OGC API Features collections listed with extents", {c["id"] for c in cols} >= {"city_regions", "european_cities"} and all(len(c.get("extent") or []) == 4 for c in cols), ", ".join(c["id"] for c in cols))
                hits = call(page, "sources_search", {"query": "city regions"})
                check("one search across all sources: found in the catalogue and in the OGC API", {h["source"] for h in hits if h["id"] == "city_regions"} == {"catalog", "features"} and all(h["spec"].startswith("source://") for h in hits), json.dumps([(h["source"], h["id"]) for h in hits]))
                loaded = call(page, "sources_load", {"source": "features", "collection": "european_cities", "bbox": "-10,35,5,45", "limit": 50, "zoom": False, "name": "Iberian cities (OGC API)"})
                check("OGC API items with a bbox → GeoJSON in the virtual filesystem → layer", bool(loaded["layers"]) and loaded["layers"][0]["featureCount"] == 2 and loaded["layers"][0]["name"] == "Iberian cities (OGC API)" and loaded["spec"] == "source://features/european_cities?bbox=-10%2C35%2C5%2C45&limit=50" and loaded["file"].startswith("/home/web_user/sources/features/"),
                      f"{loaded['layers'][0]['featureCount'] if loaded['layers'] else 0} features, {loaded['spec']}")
                loaded2 = call(page, "sources_load", {"source": "catalog", "collection": "city_regions", "zoom": False, "name": "Regions (catalogue)"})
                check("catalogue dataset → its download URL → layer", bool(loaded2["layers"]) and loaded2["layers"][0]["featureCount"] == 10 and loaded2["layers"][0]["name"] == "Regions (catalogue)" and loaded2["file"] is None, (loaded2["layers"][0]["source"] if loaded2["layers"] else "-")[:120])
                loaded3 = call(page, "sources_load", {"source": "cities-api", "query": "Paris", "zoom": False})
                check("GeoJSON query template ({q}) → one layer", bool(loaded3["layers"]) and loaded3["layers"][0]["featureCount"] == 1 and loaded3["spec"] == "source://cities-api/?q=Paris", f"{loaded3['layers'][0]['name'] if loaded3['layers'] else '-'}: {loaded3['spec']}")

                # ---- a deployment's own source type (a web plugin from its overlay) against its mock gateway — the overlay's checks;
                #      without an overlay the OGC API source plays the "query layer" of the snapshot checks below
                # the overlay's checks apply only when the staged preset carries its source (an --oss staging on a checkout that has the overlay does not)
                ov = overlay  # (module-level; a local name keeps the gating from shadowing it)
                if ov and not any(src["name"] == getattr(ov, "SOURCE", None) for src in call(page, "sources_list")):
                    print(f"  - overlay checks skipped: the staged preset has no source '{getattr(ov, 'SOURCE', '?')}'", flush=True); ov = None
                if ov:
                    ploaded, qlayers = ov.query_source_checks(page, call, check)
                else:
                    ploaded = call(page, "sources_load", {"source": "features", "collection": "city_regions", "zoom": False})
                    check("OGC API source: a collection loaded as the query layer", bool(ploaded["layers"]) and ploaded["layers"][0]["featureCount"] == 10, f"{ploaded['layers'][0]['name'] if ploaded['layers'] else None}")
                    qlayers = ploaded["layers"]
                qname, qspec = ploaded["layers"][0]["name"], ploaded["spec"]

                ocols = call(page, "sources_collections", {"source": "osm"})
                check("Overpass source: tag presets listed as collections", {c["id"] for c in ocols} >= {"traffic_signals", "buildings", "roads"}, ", ".join(c["id"] for c in ocols))
                osig = call(page, "sources_load", {"source": "osm", "collection": "traffic_signals", "bbox": "-121.98,37.36,-121.95,37.38", "zoom": False})
                check("Overpass source: a preset within a bbox → point layer with OSM tags as fields", bool(osig["layers"]) and osig["layers"][0]["featureCount"] == 2 and osig["layers"][0]["geometry"] == "Point" and {"osm_id", "osm_type", "highway"} <= set(osig["layers"][0]["fields"]) and urllib.parse.unquote(osig["spec"]) == "source://osm/traffic_signals?bbox=-121.98,37.36,-121.95,37.38", f"{[(l['name'], l['geometry'], l['featureCount']) for l in osig['layers']]} {osig['spec']}")
                oall = call(page, "sources_load", {"source": "osm", "query": "building; highway", "bbox": "-121.98,37.36,-121.95,37.38", "zoom": False})
                check("Overpass source: tag filters → closed building way becomes a polygon, the road a line, nodes points (one layer per geometry type)", {(l["geometry"], l["featureCount"]) for l in oall["layers"]} == {("Point", 2), ("Polygon", 1), ("Line", 1)}, f"{[(l['geometry'], l['featureCount']) for l in oall['layers']]}")
                for lid in [l["id"] for l in osig["layers"] + oall["layers"]]: call(page, "layers_remove", {"layer": lid})

                # ---- share.js: a snapshot carries browser-local data along and remembers where it came from
                page.evaluate("() => { window.__tasks = []; window.qgisProgress.on((e) => window.__tasks.push({ type: e.type, label: e.task.label, detail: e.task.detail, done: e.task.done, total: e.task.total, unit: e.task.unit })); }")
                snap = call(page, "project_share", {"name": "Query snapshot"})
                keys, _ = http_json(f"http://127.0.0.1:{S3_PORT}/_debug/keys")
                data_keys = [k["key"] for k in keys if k["key"].startswith(f"projects/{snap['id']}/data/")]
                loaded_layer = next(l for l in call(page, "layers_list") if l["name"] == qname)
                manifest = json.loads(page.evaluate(f"() => new TextDecoder().decode(window.qgisInstance.FS.readFile('/cloud/gis/projects/{snap['id']}/share.json'))"))
                entry = next(e for e in manifest["layers"] if e["name"] == qname)
                check("snapshot packs the browser-local query result (GeoJSON) as a GeoPackage in <id>/data/, repoints the layer there and records its source:// origin",
                      any(k.endswith(".gpkg") for k in data_keys) and not any(k.endswith(".geojson") for k in data_keys) and loaded_layer["source"].startswith(f"/cloud/gis/projects/{snap['id']}/data/") and "|layername=" in loaded_layer["source"]
                      and loaded_layer["featureCount"] == 10 and entry["origin"] == qspec and entry["data"].startswith("data/") and entry["data"].endswith(".gpkg") and entry.get("packed") == "geojson" and entry["size"] > 1000
                      and any(c["layer"] == qname for c in snap["copied"]), f"copied={snap['copied']}, data={data_keys}")
                tasks = page.evaluate("() => window.__tasks")
                share_tasks = [t for t in tasks if t["label"] == "Sharing a snapshot"]
                details = [t["detail"] for t in share_tasks]
                ups = [t for t in share_tasks if t["unit"] == "bytes" and (t["detail"] or "").startswith("Uploading") and t["total"]]
                check("project_share is a task on the page's bus (progress.js): pack as GeoPackage → QGIS re-reads → save → asynchronous upload with byte counts (cloudfs write-behind lease), then done",
                      any(t["type"] == "begin" for t in share_tasks) and any(d.startswith(f"Packing {qname}") and d.endswith("as GeoPackage") for d in details) and any(d.startswith("QGIS re-reads") for d in details) and "Saving the project" in details
                      and ups and ups[-1]["done"] == ups[-1]["total"] and ups[-1]["total"] > 1000 and any(t["type"] == "end" for t in share_tasks), f"{len(share_tasks)} events; upload {ups[-1]['done']}/{ups[-1]['total']} B" if ups else json.dumps(details))
                refreshed = call(page, "share_refresh", {})
                check("share_refresh re-runs the recorded query and rewrites the data file in place (layer id, name and style stay)",
                      refreshed["id"] == snap["id"] and qname in refreshed["refreshed"] and any(l["id"] == loaded_layer["id"] and l["featureCount"] == 10 for l in call(page, "layers_list")), json.dumps(refreshed))
                vl = call(page, "view_link", {})
                check("view_link of a snapshot is its short link", vl["spec"].get("share") == snap["id"] and f"share={snap['id']}" in vl["url"], vl["url"])
                for lid in [l["id"] for l in qlayers]: call(page, "layers_remove", {"layer": lid})

                # ---- shell layer: the workspace panel (workspace.js) — front door of the web layer: menus over window.qgis tools, the agent in its slot
                ws = page.evaluate("() => ({ root: !!document.querySelector('.ws-root'), open: document.querySelector('.ws-root')?.dataset.open, fab: !!document.querySelector('.ws-fab'), tools: [...document.querySelectorAll('.ws-tools .ws-tool')].map(b => b.title), agentInSlot: !!document.querySelector('.ws-slot .qa-root[data-embedded=\"true\"]'), legacyFab: !!document.querySelector('.qa-fab') })")
                check("workspace present and closed at start (preset ui.openOnStart false); agent embedded, no second button", ws["root"] and ws["open"] == "false" and ws["fab"] and ws["agentInSlot"] and not ws["legacyFab"] and "Data sources and cloud storage" in ws["tools"], json.dumps(ws["tools"]))
                page.click(".ws-fab"); page.wait_for_timeout(600)
                page.click(".ws-tool[data-menu=data]"); page.wait_for_timeout(800)
                dmenu = page.evaluate("() => [...document.querySelectorAll('.ws-menu .ws-menu-item .ws-menu-label')].map(e => e.firstChild.textContent)")
                check("Data menu lists every query source and the cloud mount", {"E2E catalogue", "E2E OGC API Features", "E2E GeoJSON query API", "/cloud/gis"} | (ov.data_menu_items() if ov else set()) <= set(dmenu), json.dumps(dmenu))
                menu_source, menu_cols, menu_pick = ov.data_menu_pick() if ov else ("E2E OGC API Features", {"city regions", "european cities"}, "european cities")  # (OGC API collections show their titles)
                before_menu = {l["id"] for l in call(page, "layers_list")}
                page.click(f".ws-menu-item:has-text('{menu_source}')"); page.wait_for_timeout(1500)
                sub = page.evaluate("() => [...document.querySelectorAll('.ws-menu .ws-menu-item .ws-menu-label')].map(e => e.firstChild.textContent)")
                check("a source's submenu lists its collections", menu_cols <= set(sub), json.dumps(sub))
                page.click(f".ws-menu-item:has-text('{menu_pick}')"); page.wait_for_timeout(4000)
                menu_added = [l for l in call(page, "layers_list") if l["id"] not in before_menu]
                check("clicking a collection adds it to the map through sources_load", any(l["featureCount"] == 10 and "cities" in l["name"].lower() for l in menu_added), json.dumps([l["name"] for l in menu_added]))
                page.screenshot(path=str(shots / "qgis-wasm-workspace-data.png"))
                page.click(".ws-tool[data-menu=project]"); page.wait_for_timeout(600)
                with context.expect_page() as popup_info:
                    page.click(".ws-menu-item:has-text('Export the map view as PNG')")
                popup = popup_info.value
                deadline = time.time() + 30
                while time.time() < deadline and not popup.title().endswith(".png"):
                    page.wait_for_timeout(500)
                check("Project → Export the map view as PNG opens the image in a new tab (opened inside the click, so no pop-up blocker)", popup.title().endswith(".png") and popup.evaluate("() => !!document.querySelector('img') && document.querySelector('img').naturalWidth > 100"), popup.title())
                popup.close()
                # the panel keeps the browser's native input behaviour although Qt listens on window/document: a click focuses the chat box, Ctrl+V pastes
                context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
                page.evaluate("() => navigator.clipboard.writeText('pasted from the clipboard')")
                page.click(".qa-input"); page.wait_for_timeout(200)
                focused = page.evaluate("() => document.activeElement && document.activeElement.className")
                page.keyboard.press("Control+v"); page.keyboard.type(" + typed"); page.wait_for_timeout(300)
                typed = page.evaluate("() => { const t = document.querySelector('.qa-input'); const v = t.value; t.value = ''; return v; }")
                check("a real click focuses the chat box and Ctrl+V pastes into it (Qt's window/document listeners skip the page's own UI)", focused == "qa-input" and typed == "pasted from the clipboard + typed", f"focused={focused!r} value={typed!r}")
                page.click(".ws-tool[data-action='view.debug']"); page.wait_for_timeout(1200)
                dbg = page.evaluate("() => ({ view: window.qgisWorkspace.view, rows: document.querySelectorAll('.dbg-row').length, tools: document.querySelectorAll('.dbg-row[data-source=tool]').length, qgis: window.qgisDebug.entries.filter(e => e.source === 'qgis').length, perf: document.querySelector('.dbg-perf').textContent })")
                check("Debug view: tool calls with timings, QGIS output, memory / threads / startup phases", dbg["view"] == "debug" and dbg["tools"] > 10 and dbg["rows"] > 10 and "wasm heap" in dbg["perf"] and "compile+start" in dbg["perf"], f"rows {dbg['rows']}, tools {dbg['tools']}, qgis entries {dbg['qgis']}; {dbg['perf'][:90]}")
                page.screenshot(path=str(shots / "qgis-wasm-workspace-debug.png"))
                page.click(".ws-tool[data-action='view.debug']"); page.wait_for_timeout(300)
                # a crash inside a pthread worker: the prelude the page puts around every `em-pthread` worker relays the worker's own stack
                page.evaluate("() => { const src = URL.createObjectURL(new Blob(['function boomInWorker() { throw new RangeError(\"synthetic worker crash\"); }\\nboomInWorker();'], { type: 'text/javascript' })); window.__w = new Worker(src, { name: 'em-pthread' }); window.__w.onerror = (e) => e.preventDefault(); }")
                page.wait_for_timeout(1500)
                crash = page.evaluate("() => { const e = window.qgisDebug.entries.filter(e => e.source === 'qgis' && /crashed/.test(e.text)).pop(); return e ? e.text : ''; }")
                check("a crash inside a pthread worker reaches the Debug view with the worker's own stack (prelude around em-pthread workers)", "synthetic worker crash" in crash and "boomInWorker" in crash, crash[:200].replace("\n", " | "))
                # the crash also raises the page's crash bar (workspace.js); its × dismisses it — and lets the next clicks through
                page.wait_for_selector(".ws-crash", timeout=5000)
                page.click(".ws-crash-x")
                check("the crash bar appears on a worker crash and its × dismisses it", page.evaluate("() => window.qgisStatus === 'crashed' && !document.querySelector('.ws-crash')"))
                # running tasks (progress.js): the strip under the header while the card is open, a pill beside the button and a ring on it while closed
                page.evaluate("() => { window.__t = window.qgisProgress.begin('Test task', { detail: 'first half' }); window.__t.update({ done: 5e6, total: 1e7, unit: 'bytes' }); }")
                page.wait_for_timeout(500)
                strip = page.evaluate("() => { const s = document.querySelector('.ws-progress'); const r = s.getBoundingClientRect(); return { active: s.dataset.active, visible: r.height > 0, label: s.querySelector('.ws-prog-label').textContent, detail: s.querySelector('.ws-prog-detail').textContent, width: s.querySelector('.ws-prog-bar > div').style.width, spinner: s.querySelectorAll('svg *').length }; }")
                page.evaluate("() => window.qgisWorkspace.close()"); page.wait_for_timeout(400)
                pill = page.evaluate("() => { const p = document.querySelector('.ws-pill'); const r = p.getBoundingClientRect(); return { active: p.dataset.active, visible: r.width > 0 && getComputedStyle(p).display !== 'none', label: p.querySelector('.ws-pill-label').textContent, busy: document.querySelector('.ws-fab').dataset.busy, hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.ws-pill') === p }; }")
                page.evaluate("() => window.__t.finish()"); page.wait_for_timeout(300)
                after = page.evaluate("() => [document.querySelector('.ws-progress').dataset.active, document.querySelector('.ws-pill').dataset.active, document.querySelector('.ws-fab').dataset.busy]")
                check("workspace shows running tasks: strip (label, detail with bytes and the brand spinner, 50 % bar) while open; pill + ring on the button while closed; all gone when the task ends",
                      strip["active"] == "true" and strip["visible"] and strip["label"] == "Test task" and "5.0 MB of 10 MB" in strip["detail"] and strip["width"].startswith("50") and strip["spinner"] > 0
                      and pill["active"] == "true" and pill["visible"] and pill["label"].startswith("Test task · 50%") and pill["busy"] == "true" and pill["hit"] and after == ["false", "false", "false"], json.dumps([strip, pill, after]))
                page.evaluate("() => window.qgisWorkspace.open()"); page.wait_for_timeout(400)
                page.click(".ws-tool[data-menu=more]"); page.wait_for_timeout(800)
                links = page.evaluate("() => [...document.querySelectorAll('.ws-menu a.ws-menu-item')].map(a => a.href)")
                preset_link = page.evaluate("() => ((window.qgisPreset || {}).links || [])[0]?.url || ''")
                check("⋯ menu: the preset's links (source code) and the layout switches", bool(preset_link) and any(preset_link.rstrip('/') in u for u in links) and page.evaluate("() => [...document.querySelectorAll('.ws-menu .ws-menu-item.check')].length") == 3, json.dumps(links))
                page.screenshot(path=str(shots / "qgis-wasm-workspace-more.png"))
                page.keyboard.press("Escape"); page.evaluate("() => window.qgisWorkspace.close()"); page.wait_for_timeout(300)
                for l in menu_added: call(page, "layers_remove", {"layer": l["id"]})
                ls = page.evaluate("() => window.qgisLoadStats")
                bundle = json.loads(urllib.request.urlopen(f"{base}/qgis.bundle.json").read())
                check("loading page counted the real bytes of qgis.wasm and qgis.data against qgis.bundle.json and recorded the stages",
                      ls["files"]["qgis.wasm"]["loaded"] == bundle["files"]["qgis.wasm"]["size"] and ls["files"]["qgis.data"]["loaded"] == bundle["files"]["qgis.data"]["size"] and ls["downloadDoneAt"] and ls["loadedAt"] > ls["downloadDoneAt"],
                      f"wasm {ls['files']['qgis.wasm']['loaded']} B in {ls['files']['qgis.wasm']['ms']} ms, data {ls['files']['qgis.data']['ms']} ms, compile+start {round(ls['loadedAt'] - ls['downloadDoneAt'])} ms")

                # ---- shell layer: links (link.js) — the URL scheme lives on the page; QGIS only ever sees tool calls
                parsed = page.evaluate("() => window.qgisLink.parse('?preset=team&open=/cloud/x/a.qgz,/cloud/x/b.geojson&add=source://features/city_regions?bbox=1,2,3,4&add=https://h/x.geojson&extent=-20,30,40,70@EPSG:3857&basemap=OSM')")
                check("link parser: comma lists, repeated add=, source specs with their own query, extent with CRS",
                      parsed["open"] == ["/cloud/x/a.qgz", "/cloud/x/b.geojson"] and parsed["add"] == ["source://features/city_regions?bbox=1,2,3,4", "https://h/x.geojson"] and parsed["extent"] == {"xmin": -20, "ymin": 30, "xmax": 40, "ymax": 70, "crs": "EPSG:3857"} and parsed["basemap"] == "OSM" and parsed["preset"] == "team", json.dumps(parsed)[:200])
                view = call(page, "view_link", {})
                check("view_link: the project is a stored snapshot → its short ?share=<id> link + current extent", view["spec"].get("share") == snap["id"] and "extent=" in view["url"] and f"share={snap['id']}" in view["url"] and not view["spec"]["open"], view["url"])  # snap: the latest snapshot

                deep = page.evaluate("() => window.qgisLink.build({ preset: 'e2e', add: ['/cloud/gis/data/world_map.gpkg|layername=countries', 'http://127.0.0.1:9124/data/european_cities.geojson', 'source://features/city_regions?limit=5'], basemap: 'E2E Local Tiles', extent: { xmin: -20, ymin: 30, xmax: 40, ymax: 70, crs: 'EPSG:4326' } })")
                page3 = context.new_page()
                dialogs = []
                def on_dialog(d):
                    dialogs.append({"type": d.type, "message": d.message, "default": d.default_value})
                    d.accept("european_cities") if "Collection to load" in d.message else d.dismiss()
                page3.on("dialog", on_dialog)
                page3.goto(deep, wait_until="domcontentloaded")
                page3.wait_for_function("() => window.qgisBridgeReady === true || window.qgisStatus === 'exited'", timeout=args.timeout * 1000)
                deadline = time.time() + 90
                while time.time() < deadline and len(call(page3, "layers_list")) < 4:
                    page3.wait_for_timeout(1000)
                page3.wait_for_timeout(1500)  # the extent is applied after the last layer
                l3 = call(page3, "layers_list"); ext3 = call(page3, "canvas_extent")
                import math
                def merc(lon, lat): return math.radians(lon) * 6378137.0, math.log(math.tan((90 + lat) * math.pi / 360)) * 6378137.0
                want, tol = ((*merc(-20, 30), *merc(40, 70)), 1.0) if ext3["crs"] == "EPSG:3857" else ((-20, 30, 40, 70), 1e-6)
                contains = ext3["xmin"] <= want[0] + tol and ext3["xmax"] >= want[2] - tol and ext3["ymin"] <= want[1] + tol and ext3["ymax"] >= want[3] - tol
                tight = (ext3["xmax"] - ext3["xmin"]) < 3 * (want[2] - want[0]) and (ext3["ymax"] - ext3["ymin"]) < 3 * (want[3] - want[1])
                by_name = {l["name"]: l for l in l3}
                check("deep link: basemap at the bottom, cloud sublayer, URL layer and query source added, extent applied",
                      len(l3) == 4 and l3[-1]["name"] == "E2E Local Tiles" and by_name.get("countries", {}).get("featureCount") == 240 and by_name.get("european_cities", {}).get("featureCount") == 10 and by_name.get("city_regions", {}).get("featureCount") == 5 and contains and tight,
                      f"layers={[l['name'] for l in l3]} extent={[round(ext3[k]) for k in ('xmin', 'ymin', 'xmax', 'ymax')]} {ext3['crs']} contains={contains} tight={tight}")
                page3.screenshot(path=str(shots / "qgis-wasm-deep-link.png"))
                view3 = call(page3, "view_link", {})
                s3 = view3["spec"]
                check("view_link: unsaved project → the deep link is reconstructed from the layers (basemap, cloud sublayer, URL, source spec)",
                      s3["basemap"] == "E2E Local Tiles" and s3["add"] == ["/cloud/gis/data/world_map.gpkg|layername=countries", "http://127.0.0.1:9124/data/european_cities.geojson", "source://features/city_regions?limit=5"] and not s3["open"] and not view3["skipped"], json.dumps(s3)[:300])
                context.grant_permissions(["clipboard-read", "clipboard-write"], origin=base)
                call(page3, "ui_trigger_action", {"id": "shell.link.view"})
                page3.wait_for_timeout(1500)
                clip = page3.evaluate("async () => { try { return await navigator.clipboard.readText(); } catch (e) { return 'ERR ' + e.message; } }")
                prompted = [d for d in dialogs if d["type"] == "prompt" and "Copy this link" in d["message"]]
                check("Plugins → Share → Copy link to this view puts the link on the clipboard (or shows it)", clip == view3["url"] or (prompted and prompted[0]["default"] == view3["url"]), (clip or "")[:120])
                n3 = len(call(page3, "layers_list"))
                call(page3, "ui_trigger_action", {"id": "shell.source.features"})
                deadline = time.time() + 60
                while time.time() < deadline and len(call(page3, "layers_list")) < n3 + 1:
                    page3.wait_for_timeout(1000)
                l3b = call(page3, "layers_list")
                asked = [d for d in dialogs if "Collection to load" in d["message"]]
                check("Plugins → Data sources → <source>… asks for a collection and loads it", len(l3b) == n3 + 1 and l3b[0]["name"] == "european_cities" and l3b[0]["featureCount"] == 10 and asked and "city_regions" in asked[0]["message"], f"dialog: {asked[0]['message'][:80]!r}" if asked else "no dialog")
                page3.close()

                # ---- compatibility: preflight in index.html (a browser without JSPI gets an explanation, not a 160 MB download)
                page4 = context.new_page()
                page4.add_init_script("delete WebAssembly.Suspending;")
                requested = []
                page4.on("request", lambda r: requested.append(r.url))
                page4.goto(f"{base}/index.html?preset=e2e", wait_until="load")
                page4.wait_for_timeout(500)
                text = page4.inner_text("#unsupported")
                check("preflight: without JSPI the page explains what is missing and downloads nothing", page4.evaluate("window.qgisStatus") == "unsupported" and "JSPI" in text and "Chrome" in text and not any(u.endswith("/qgis.js") or u.endswith("/qgis.wasm") for u in requested), f"{len(requested)} requests, {text[:60]!r}")
                page4.close()

                # ---- transfer: pre-compressed sidecars (scripts/compress-bundle.mjs + serve.mjs)
                subprocess.run(["node", str(ROOT / "scripts/compress-bundle.mjs"), "--dir", args.dir, "--only", "qgis-shell.js", "--force"], check=True, stdout=subprocess.DEVNULL)
                req = urllib.request.Request(f"{base}/qgis-shell.js", headers={"Accept-Encoding": "br"})
                with urllib.request.urlopen(req, timeout=30) as r:
                    hdr, body = dict(r.headers), r.read()
                plain = urllib.request.urlopen(f"{base}/qgis-shell.js", timeout=30).read()
                check("server sends the brotli sidecar when accepted (identity otherwise), ETag per encoding", hdr.get("Content-Encoding") == "br" and len(body) < len(plain) // 2 and hdr.get("Vary") == "Accept-Encoding" and hdr.get("ETag", "").endswith('-br"') and plain.startswith(b"/**"), f"{len(plain)} → {len(body)} bytes")

            # ---- assistant (real model) + MCP catalogue — needs a model in the staged preset's agent section (never commit a key)
            if args.llm and not call(page, "assistant_status").get("configured"):
                print("  - --llm skipped: the preset's agent section names no model / key (put one in the staged presets/e2e.json locally)", flush=True); args.llm = False
            if args.llm:
                # MCP discovery (initialize + tools/list from C++) runs asynchronously after startup
                deadline = time.time() + 60
                while time.time() < deadline and not all(s["ready"] for s in call(page, "assistant_status")["mcpServers"]):
                    page.wait_for_timeout(1000)
                status = call(page, "assistant_status")
                check("assistant configured with the mock MCP catalogue", status["configured"] and any(s["ready"] and s["tools"] == 2 for s in status["mcpServers"]), json.dumps(status["mcpServers"]))
                call(page, "assistant_ask", {"text": "Search the internal catalogue for a dataset about city regions, load it into the map and zoom to it. Then tell me how many features it has."})
                deadline = time.time() + 240
                while time.time() < deadline and call(page, "assistant_status")["busy"]:
                    page.wait_for_timeout(2000)
                status = call(page, "assistant_status")
                tool_names = [t.get("name") for t in status["transcript"] if t["role"] == "tool"]
                layers_after = call(page, "layers_list")
                check("assistant used the catalogue (MCP) and loaded the dataset", not status["busy"] and any(n and n.startswith("mcp__catalog__") for n in tool_names) and any("city_regions" in l["name"] or "city regions" in l["name"].lower() for l in layers_after),
                      f"tools={tool_names} answer={status['lastAnswer'][:160]!r}")
                page.mouse.click(1590, 940)  # make sure the dock tab is visible in the shot
                page.screenshot(path=str(shots / "qgis-wasm-assistant.png"))

            if args.keep:
                print("browser kept open; Ctrl-C to end"); page.wait_for_timeout(3600_000)
            browser.close()
    finally:
        for pr in procs: pr.terminate()
        shutil.rmtree(seed, ignore_errors=True)
    errs = [c for c in console if c.startswith("[error]")]
    (ROOT / "docs/screenshots/console-features.log").write_text("\n".join(console + failures))
    print(f"console messages: {len(console)}, errors: {len(errs)}, page errors: {len(failures)}")
    for l in (console if args.verbose else errs + failures)[:80]: print("  ", l[:300])
    ok = all(r[1] for r in results) and not failures
    print("OK" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
