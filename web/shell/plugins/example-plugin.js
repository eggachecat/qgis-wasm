/**
 * Example web plugin for QGIS Desktop in the browser.
 *
 * A web plugin is an ES module exporting `activate(qgis)` (default export or named). It gets the same control
 * surface as agents and the page (`qgis.call(tool, params)`, `qgis.on(event, fn)`, `qgis.open(url)`, …) and can
 * add entries to the real QGIS menus and toolbars. See docs/03-插件与迁移指南.md for the PyQGIS → web mapping.
 */
const NATURAL_EARTH = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson';

export default async function activate(qgis) {
  // Plugins → Web Plugins → … (and a toolbar button); like iface.addPluginToMenu() / iface.addToolBarIcon()
  await qgis.call('ui_add_action', { id: 'example.natural-earth', text: 'Add Natural Earth countries (web plugin demo)', menu: 'Web Plugins', toolbar: true, icon: 'mActionAddOgrLayer.svg' });
  await qgis.call('ui_add_action', { id: 'example.summary', text: 'Layer summary in message bar', menu: 'Web Plugins' });

  qgis.on('action', async ({ id }) => {
    if (id === 'example.natural-earth') {
      const layers = await qgis.open(NATURAL_EARTH);              // download → layers_add (no dialogs)
      await qgis.call('layer_set_style', { layer: layers[0].id, fill: '#f6d55c', stroke: '#3c3c3c', stroke_width: 0.3, label_field: 'NAME', label_size: 8 });
      await qgis.call('layers_zoom_to', { layer: layers[0].id });
      await qgis.call('ui_message', { title: 'Web plugin', text: `Added ${layers[0].name} with ${layers[0].featureCount} countries`, level: 'success', duration: 6 });
    } else if (id === 'example.summary') {
      const layers = await qgis.call('layers_list');
      await qgis.call('ui_message', { title: 'Web plugin', text: `${layers.length} layer(s): ${layers.map((l) => l.name).join(', ') || 'none'}`, duration: 6 });
    }
  });

  // react to QGIS events (like QgsProject.instance().layersAdded.connect(...))
  qgis.on('layers.added', ({ layers }) => console.log('[example-plugin] layers added:', layers.map((l) => l.name)));
}
