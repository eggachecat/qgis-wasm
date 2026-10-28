# Plugins and migration guide

> Chinese original: [03-插件与迁移指南.md](../03-插件与迁移指南.md)

The QGIS wasm module has no CPython (see the trade-offs table in [01-approach.md](01-approach.md)), so PyQGIS plugins cannot run "as is". This repository offers three compatibility paths:

| Path | Fits | How |
|---|---|---|
| **Python plugin (PyQGIS compatibility layer)** | tool-style plugins built around `iface`/`QgsProject`/`QgsVectorLayer`/`processing.run`, where the UI is just menu items and simple prompts | plugin code unchanged or barely changed: Python runs in Pyodide inside the page; `qgis.core` / `qgis.gui` / `qgis.utils` / `qgis.PyQt` / `processing` are provided by `web/shell/pyqgis/`, and underneath they drive the real QGIS synchronously through the control surface (§0) |
| **Web plugin** (JavaScript ES module) | plugins that need custom UI (HTML panels); also the same set of capabilities the agent uses | one `activate(qgis)` function that calls the QGIS control surface (`QgsWasmBridge`) through `qgis.call(tool, params)` and uses `ui_add_action` to put entries into the real QGIS menus/toolbars |
| **C++ plugin, statically linked in** | existing QGIS C++ plugins (upstream `src/plugins/*`, in-house C++ plugins), plugins that need `QgsMapTool`/Qt panels | linked as a static library into `qgis.wasm`; entry functions are prefixed with `QGIS_PLUGIN_SYMBOL()` and registered in `qgswasmstaticplugins.cpp`; the plugin manager lists them as usual and they can be enabled/disabled |

## 0. Python plugins

### 0.1 How it runs

```
preset.plugins_python: ["plugins/hello_pyqgis/"]  or  python_plugins {action:"load", source:"/cloud/shared/plugins/<id>"}
   │  web/shell/pyqgis.js: loads Pyodide on demand (CDN, preset.python.indexUrl can change it), installs web/shell/pyqgis/ into /qgis_shim,
   │  copies the plugin directory to Pyodide's /plugins/<id>/ (and mirrors it into the QGIS virtual filesystem /home/web_user/python-plugins/<id>/, so icons/data are readable)
   ▼
qgis.utils.loadPlugin(id); startPlugin(id)  →  classFactory(iface).initGui()
   │  QAction → ui_add_action: the item appears in the real QGIS Plugins menu / plugin toolbar; a click → event → Python triggered signal
   │  QgsProject / QgsVectorLayer / QgsMapCanvas / processing.run … → qgis._bridge.call(tool) → run_sync(JSPI) → QgsWasmBridge
   ▼
the real QGIS (layers, canvas, Processing are all C++)
```

The key is Pyodide's `run_sync` (based on JSPI, Chrome ≥ 137): Python code keeps its synchronous style, and underneath every PyQGIS call synchronously waits on a bridge Promise. Every entry into Python (plugin load, menu callbacks, signals, `python_run`) goes through `runPythonAsync` and is serialized; that is the precondition for `run_sync`.

Example: `web/shell/plugins/hello_pyqgis/` (Plugin Builder style: `QAction` + `iface.addToolBarIcon/addPluginToMenu`, `QgsVectorLayer(...)` + `QgsProject.instance().addMapLayer()`, `iface.mapCanvas().setExtent()`, `iface.messageBar().pushMessage()`, `QInputDialog.getDouble()`, `processing.run("native:buffer", …)`, `QgsProject.instance().layersAdded.connect()`), loaded by the default preset. The console/agent can also run Python directly:

```js
await qgis.call('python_run', { code: "from qgis.core import QgsProject\n[l.name() for l in QgsProject.instance().mapLayers().values()]" })
```

### 0.2 Supported scope

The compatibility layer covers the part of the API that "tool-style plugins" commonly use. **The members listed below are available; names not in the list raise an `ImportError` with a hint at `import` time** (Qt widget classes instead raise `NotImplementedError` at instantiation; the import itself does not fail).

**`qgis.core`**

- `QgsProject`: `mapLayers` / `mapLayer` / `mapLayersByName` / `addMapLayer(s)` / `removeMapLayer(s)` / `read` / `write` / `fileName` / `title` / `crs` / `setCrs` / `layerTreeRoot`, signals `layersAdded`, `layersRemoved`, `readProject`, `cleared`.
- `QgsVectorLayer` / `QgsRasterLayer`: `id` / `name` / `isValid` / `extent` / `crs` / `source` / `providerType` / `featureCount` / `fields` / `getFeatures` / `getFeature` / `selectByExpression` / `selectByIds` / `selectAll` / `removeSelection` / `selectedFeatures` / `selectedFeatureCount` / `setOpacity` / `triggerRepaint` / `dataProvider`.
- Features and fields: `QgsFeature`, `QgsFields`, `QgsField`, `QgsFeatureRequest` (expression, extent, fid, limit, subset).
- Geometry and coordinates: `QgsGeometry` (GeoJSON underneath: `asJson` / `asWkt` / `boundingBox` / `centroid` / `type`), `QgsRectangle`, `QgsPointXY`, `QgsCoordinateReferenceSystem` (`authid`), `QgsCoordinateTransform` (exact transformation through the QGIS expression engine).
- Expressions and settings: `QgsExpression` (`evaluate`, with optional layer/feature context), `QgsSettings`, `QgsMessageLog`, `QgsApplication.processingRegistry()`, `Qgis.MessageLevel`.

> Feature reads go through `layer_features` (GeoJSON). For large layers, narrow with an expression or `limit`; do not `getFeatures()` on the whole layer.

**`qgis.gui`**

- `QgisInterface`: `mapCanvas` / `messageBar` / `mainWindow` / `layerTreeView` / `activeLayer` / `addVectorLayer` / `addRasterLayer` / `addProject` / `newProject` / `zoomFull` / `addPluginToMenu` / `removePluginMenu` / `addToolBarIcon` / `removeToolBarIcon` / `addToolBar` / `addPluginTo*Menu` / `registerMainWindowAction`, signals `projectRead`, `newProjectCreated`.
- `QgsMapCanvas`: `extent` / `setExtent` / `zoomToFullExtent` / `zoomToSelected` / `zoomIn` / `zoomOut` / `zoomScale` / `setCenter` / `center` / `scale` / `refresh` / `mapSettings` / `layers` / `saveAsImage`, signals `extentsChanged`, `mapCanvasRefreshed`.
- `QgsMessageBar`: `pushMessage` (two signatures), `pushInfo` / `pushSuccess` / `pushWarning` / `pushCritical`.

> `QgsMapTool*` and `iface.addDockWidget` raise `NotImplementedError` — they need C++ (see §2).

**`qgis.PyQt` / `PyQt5` / `PyQt6`**

- `QtCore`: `QObject`, `pyqtSignal` / `pyqtSlot`, `Qt` constants, `QTimer` (page timers), `QVariant`, `QCoreApplication.translate`, `QSize` / `QPoint` / `QUrl` / `QFileInfo` and the like.
- `QtGui`: `QAction` (becomes a real QGIS menu/toolbar item), `QIcon` (files inside the plugin directory work), `QColor`, `QKeySequence`, `QDesktopServices`.
- `QtWidgets`: `QMenu` / `QToolBar` (mapped to the Plugins submenu/plugin toolbar), `QMessageBox` (browser alert/confirm + message bar), `QInputDialog` (browser prompt), `QFileDialog` (enter a virtual filesystem path), `QProgressDialog` (message bar), `QApplication.clipboard()`.

> Other widget classes raise `NotImplementedError` **at instantiation**; `uic.loadUi` / `loadUiType` are unavailable — turn custom dialogs into several menu items + prompts, or use a web plugin.

**`processing`**

- `run` (layer objects/ids/paths as parameters; layer ids in the result are automatically replaced with layer objects and are already added to the project), `algorithmHelp`, `algorithms`.
- Only QGIS' C++ `native:*` algorithms; no Python algorithms or models.

**Not supported**

- `QThread` / `QgsTask`: single-threaded; split work into steps with `QTimer` / `asyncio`.
- Edit sessions: `startEditing` / `commitChanges` return False.
- `sqlite3` / `osgeo` / `requests`: Pyodide ships `sqlite3`, but it cannot open files in the QGIS filesystem; for network use `pyodide.http.pyfetch` or the bridge's `files_download`.
- Custom Qt windows and map tools (need C++).

### 0.3 Migration checklist

1. Dialogs: `QDialog`/`.ui` → `QInputDialog.getText/getDouble/getItem` (native browser popups, synchronous) or split into several menu items; complex UI → web plugin.
2. File paths: local paths → virtual filesystem paths (`/cloud/<mount>/…`, `/home/web_user/…`); `QFileDialog` becomes a path input.
3. Network: `requests`/`urllib` → `qgis._bridge.call("files_download", url=...)` to get a local path, or `pyodide.http.pyfetch`.
4. Threads/tasks: switch to small synchronous steps or `QTimer.singleShot`.
5. Map tools/panels: `QgsMapTool`, `addDockWidget` → C++ plugin (§2).
6. Verify piece by piece with `python_run` in the console, then move it into `plugins_python` (a directory + `files.json`, or a zip, or a directory on a cloud mount: `python_plugins {action:"load", source:"/cloud/shared/plugins/<id>"}`).


## 1. Web plugins

### 1.1 How to write one

```js
// web/shell/plugins/my-plugin.js
export default async function activate(qgis) {
  // menu: Plugins → My Plugin → Buffer selected layer (equivalent to iface.addPluginToMenu); toolbar: true also adds a toolbar button
  await qgis.call('ui_add_action', { id: 'my.buffer', text: 'Buffer selected layer', menu: 'My Plugin', toolbar: true, icon: 'mActionBuffer.svg' });

  qgis.on('action', async ({ id }) => {                         // equivalent to QAction.triggered
    if (id !== 'my.buffer') return;
    const layers = await qgis.call('layers_list');
    const target = layers.find(l => l.type === 'vector');
    const run = await qgis.call('processing_run', { algorithm: 'native:buffer', parameters: { INPUT: target.id, DISTANCE: 0.5 } });
    await qgis.call('ui_message', { title: 'My Plugin', text: `Buffered ${target.name} → ${run.layers[0].name}`, level: 'success' });
  });

  qgis.on('layers.added', ({ layers }) => console.log('new layers', layers.map(l => l.name)));  // QgsProject.layersAdded
}
```

Put the file in `web/shell/plugins/`, register it in the preset's `plugins` list (`"plugins": ["plugins/my-plugin.js"]`), and refresh the page for it to take effect; you can also debug it in the console with `import('./plugins/my-plugin.js').then(m => m.default(qgis))`.

### 1.2 Available API

- `qgis.call(tool, params) → Promise<result>`: all tools are listed by `await qgis.tools()` (currently 68, including page tools and skill tools), in groups: `project_*`, `layers_*`, `layer_*`, `canvas_*`, `expression_evaluate`, `processing_*`, `settings_*`, `basemaps_*`, `files_*`, `ui_*`, `plugins_*`, `assistant_*`, plus the page-side `project_share`, `mounts_*`, `download`, `file_base64`, `page_info`. Every tool carries a JSON schema (the same manifest is also given to MCP and the assistant).
- `qgis.on(event, fn)` / `qgis.off`: events `ready`, `project.read`, `project.cleared`, `layers.added`, `layers.removed`, `selection.changed`, `canvas.extent`, `canvas.refreshed`, `action`, `assistant.finished`; `'*'` subscribes to all.
- `qgis.open(urlOrPath)`: downloads (if it is a URL) then `layers_add`, no dialog; `window.qgisOpen()` instead goes through `QgisApp::openFile()` (with QGIS' own sublayer dialog).
- `qgis.share(path)`: builds a `?preset=…&open=<path>` link; `qgis.mount(cfg)` / `qgis.mounts()`: cloud storage mounts; `qgis.instance.FS`: the Emscripten filesystem (`readFile`/`writeFile`).

### 1.3 PyQGIS → web plugin mapping

| PyQGIS | Web plugin |
|---|---|
| `classFactory(iface)` / `initGui()` | `export default async function activate(qgis)` |
| `iface.addPluginToMenu(name, action)`, `iface.addToolBarIcon(action)` | `ui_add_action { id, text, menu, toolbar, icon }` |
| `action.triggered.connect(fn)` | `qgis.on('action', ({ id }) => …)` |
| `iface.removePluginMenu(...)` / `unload()` | `ui_remove_action { id }` |
| `iface.messageBar().pushMessage(title, text, level)` | `ui_message { title, text, level, duration }` |
| `QgsProject.instance().mapLayers()` / `mapLayersByName()` | `layers_list` (results contain id, name, type, provider, source, crs, extent, fields, featureCount) |
| `QgsVectorLayer(uri, name, provider)` + `addMapLayer()` | `layers_add { uri, name, provider }` (files, URLs, `{z}/{x}/{y}` tile templates, any QGIS data source URI) |
| `QgsRasterLayer(uri, name, 'wms')` (XYZ) | `layers_add { uri: 'https://…/{z}/{x}/{y}.png' }` or `basemaps_use { name }` |
| `QgsProject.instance().removeMapLayer(id)` | `layers_remove { layer }` |
| `QgsProject.instance().read(path)` / `write(path)` | `project_open { path }` / `project_save { path }` (`/cloud/<mount>/…` means saving to object storage) |
| `QgsProject.instance().setCrs(crs)` | `project_set_crs { crs }` |
| `layer.getFeatures(QgsFeatureRequest().setFilterExpression(e).setLimit(n))` | `layer_features { layer, expression, limit, geometry, fields }` → GeoJSON FeatureCollection |
| `layer.selectByExpression(e)` / `iface.mapCanvas().zoomToSelected()` | `layer_select { layer, expression, behavior, zoom }` |
| `layer.fields()` | `layer_fields { layer }` |
| `layer.setRenderer(QgsSingleSymbolRenderer(symbol))`, `setOpacity()` | `layer_set_style { layer, fill, stroke, stroke_width, size, opacity, label_field, label_size, label_color, label_buffer, label_bold, label_placement }` (shortcut; only the given keys change, the existing symbol is the starting point) |
| `setRenderer(QgsCategorizedSymbolRenderer / QgsGraduatedSymbolRenderer)`, color ramps, `setLabeling(QgsVectorLayerSimpleLabeling(settings))`, `QgsTextFormat` (font/stroke/background/placement/scale range), `setMinimumScale()` | `layer_style_set { layer, renderer: {type: single \| categorized \| graduated, symbol, field, categories, ranges, classes, mode, ramp}, labels: {field \| expression, size, color, font, bold, buffer, background, placement, offset, overlap, min_scale, max_scale, …}, opacity, min_scale, max_scale }`; `layer_style_get { layer }` reads back the same JSON document. In Python, `QgsPalLayerSettings`, `QgsTextFormat`, `QgsTextBufferSettings`, `QgsVectorLayerSimpleLabeling`, `QgsSymbol/QgsMarkerSymbol/QgsLineSymbol/QgsFillSymbol`, `QgsSingleSymbolRenderer`, `QgsCategorizedSymbolRenderer + QgsRendererCategory`, `QgsGraduatedSymbolRenderer + QgsRendererRange` (including `createRenderer()`, `setClassificationMethod()`), `QgsGradientColorRamp`, `QgsStyle.defaultStyle().colorRamp(name)` are all PyQGIS wrappers over this document: the objects are detached copies, sent to QGIS only at `layer.setRenderer()` / `setLabeling()` (consistent with PyQGIS semantics); `layer.renderer()` / `labeling()` read back from QGIS every time. Names outside the subset (`QgsRuleBasedRenderer`, `QgsSvgMarkerSymbolLayer`…) raise an `ImportError` with a hint at `import` time, pointing to QML or the bridge tools |
| `layer.loadNamedStyle(path)` / `saveNamedStyle(path)` / `importNamedStyle(doc)` / `exportNamedStyle()` | `layer_style_qml { layer, qml?, path?, save? }`: full QGIS QML (rule-based rendering, SVG symbols, raster color shading… anything the layer properties dialog can do can be loaded into it) |
| `layer.setName()`, `setScaleBasedVisibility()`, layer tree checkbox | `layer_set_properties { layer, name, visible, opacity, min_scale, max_scale }` |
| `iface.mapCanvas().extent()` / `setExtent()` / `zoomToFullExtent()` / `refresh()` | `canvas_extent` / `canvas_set_extent { xmin, ymin, xmax, ymax, crs }` / `canvas_zoom_full` / `canvas_refresh` |
| `iface.mapCanvas().saveAsImage(path)` | `canvas_export_image { path, width, height }` + `file_base64 { path }` to fetch the bytes |
| `QgsExpression(e).evaluate(context)` | `expression_evaluate { expression, layer }` |
| `processing.run('native:buffer', params)` | `processing_run { algorithm, parameters, add_to_project }`: layer-type outputs (sink / vectorDestination / rasterDestination) left empty = temporary layer added to the project; file-type outputs (`fileDestination` / `folderDestination`, e.g. `OUTPUT: '/cloud/…/x.gpkg'` of `native:savefeatures`, `native:package`) are just a path, and when left empty get a temporary file; the result is in `results.OUTPUT`, open it with `layers_add`; `processing_list { filter }`, `processing_describe { algorithm }` look up algorithms and parameters (only C++ `native:*`, no Python algorithms) |
| `QgsSettings().value(k)` / `setValue(k, v)` | `settings_get { key }` / `settings_set { key, value }` |
| `QgsProject.instance().layersAdded.connect(fn)` and other signals | `qgis.on('layers.added' \| 'layers.removed' \| 'project.read' \| 'selection.changed' \| 'canvas.extent', fn)` |
| `QFileDialog`, custom Qt dialogs | do it in HTML/JS (page layer), or design the parameters as a few fixed `ui_add_action` menu items; features that need real Qt dialogs go through a C++ plugin |
| `iface.addDockWidget(...)` custom panel | no web equivalent yet (Qt panels can only come from C++); a lightweight panel can be an HTML overlay on the page |
| reading and writing local files `open(path)` | `files_list / files_read_text / files_write_text / files_download`, or `qgis.instance.FS` |
| `urllib` / `requests` to an internal service | plain `fetch()` (subject to CORS; services without CORS can go through `/proxy?url=` in `scripts/serve.mjs`) |

No counterpart, and none planned: `QgsMapTool` subclasses (custom mouse tools), custom Qt dialogs/panels, Python Processing algorithms and models (a model in `model3` that contains only native algorithms can be called step by step through `processing_run`). These need the C++ path.

### 1.4 Migration steps

1. List the plugin's entry points (menu/toolbar items) → each becomes one `ui_add_action`.
2. Move the logic in `initGui()` into `activate()`; translate each `triggered` handler into a `qgis.on('action')` branch.
3. Replace PyQGIS calls per the table above; wherever many features need to be read, narrow with `expression`/`fields`/`limit` of `layer_features`, or compute inside QGIS with `processing_run`/`expression_evaluate` (`aggregate()` and the like).
4. Dialogs: few parameters → several menu items or `window.prompt`; many parameters → an HTML panel.
5. Write regressions with `tests/e2e/drive.py` (`js:` steps) or Playwright.

## 2. C++ plugins, statically linked in

Upstream's **Topology Checker** (`src/plugins/topology`) and **Geometry Checker** (`src/plugins/geometry_checker`) are already compiled into `qgis.wasm` this way: they show up in Plugins → Manage and Install Plugins and can be enabled there; once Topology Checker is enabled it appears in the Vector menu and as a panel.

### 2.1 Mechanism

- There is no `dlopen()` in the browser. Under Emscripten, `src/plugins/CMakeLists.txt` builds the plugin targets as `STATIC` libraries, and `QGIS_WASM_STATIC_PLUGINS` in `cmake/QgisWasmApp.cmake` links them into the executable.
- A plugin's C entry points (`classFactory`, `name`, `description`, `category`, `type`, `version`, `icon`, `unload`) would collide with each other in one executable, so each plugin is compiled with `QGIS_PLUGIN_STATIC_NAME=<library name>`, and the source declares the entry points with `QGIS_PLUGIN_SYMBOL()` from `qgisplugin.h`:

  ```cpp
  QGISEXTERN QgisPlugin *QGIS_PLUGIN_SYMBOL( classFactory )( QgisInterface *iface ) { return new MyPlugin( iface ); }
  QGISEXTERN const QString *QGIS_PLUGIN_SYMBOL( name )() { return &sName; }
  // the same applies to description / category / type / version / icon / unload
  ```

  In a shared-library build the macro does nothing, so the same source still compiles into an ordinary `.so`.
- `src/app/qgswasmstaticplugins.cpp` registers these entry points in a table; under Emscripten, `QgsPluginRegistry` (load/unload/session restore) and `QgsPluginManager` (listing) consult this table instead of scanning directories. Plugin `.qrc` resources are initialized with `Q_INIT_RESOURCE` when the table is initialized.

### 2.2 Adding your own C++ plugin

1. Put the plugin source in `external/QGIS/src/plugins/<name>/` (or use `CUSTOM_PLUGINS`), `add_library(plugin_<name> ${QGIS_PLUGIN_LIBRARY_TYPE} …)`, and under Emscripten `target_compile_definitions(plugin_<name> PRIVATE QGIS_PLUGIN_STATIC_NAME=plugin_<name>)`.
2. Change the entry functions to use `QGIS_PLUGIN_SYMBOL()` (8 places).
3. `qgswasmstaticplugins.cpp`: add `QGIS_WASM_DECLARE_PLUGIN( plugin_<name> )`, the table entry `QGIS_WASM_PLUGIN_ENTRY( plugin_<name> )`, and `Q_INIT_RESOURCE( <qrc name> )`; add the target name to `QGIS_WASM_STATIC_PLUGINS` in `QgisWasmApp.cmake`.
4. Dependencies that are unavailable (Python, serial port, PostgreSQL, QtWebEngine…) must either be removed or guarded with `__EMSCRIPTEN__`.
5. Write the library name in the preset's `plugins_cpp`, so it is enabled the first time a user opens the page.

### 2.3 From a Python plugin to a C++ plugin

For plugins that need `QgsMapTool` or custom Qt dialogs/panels, rewriting the UI layer in C++ is recommended (`QgisInterface`'s API maps one-to-one onto PyQGIS: `iface->addPluginToMenu`, `iface->mapCanvas()`, `QgsProject::instance()` …); if the business logic is mostly expressions/Processing calls, it can also be split into a C++ shell plus a web plugin.

## 3. Replacing some plugins with the agent

Many "small plugins" just chain a few QGIS operations together. The Web Agent on the page (`web/agent`, [docs/05](05-web-agent.md); and external agents connected through MCP) gets exactly the same tool set as web plugins, so a task such as "label layer X by field Y and export an image" can be given to the agent without writing a plugin; flows that need to be fixed can then be turned into a web plugin. See [04-cloud-presets-and-agent.md](04-cloud-presets-and-agent.md).
