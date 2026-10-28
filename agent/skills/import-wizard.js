/**
 * import-wizard — built-in skill: bring data into the map in one step (download if needed, add every layer, zoom,
 * report). Also the reference example for writing skills (docs/05 §5): a plain ES module, no build step.
 */
export default {
  name: 'Import',
  description: 'Import datasets from URLs, cloud mounts, uploads and internal catalogues',
  instructions: `## Importing data
- Sources the user may give: http(s) URLs (GeoJSON, GeoPackage, zipped Shapefiles, CSV, GeoTIFF, …), paths in the virtual filesystem (/cloud/<mount>/…, /home/web_user/uploads/… for files dropped into the chat), and datasets found with catalogue tools (mcp__*). Prefer import_data: it downloads when needed, adds all layers, zooms and returns feature counts.
- Use layers_add directly only for special sources: XYZ tile templates, WMS/WFS/ArcGIS services (set provider), CSV with explicit delimitedtext options, a single sublayer of a container (layer argument).
- When the user names a dataset vaguely ("the roads"), search the catalogue tools first, then files_list on the cloud mounts; show the candidates if there is more than one plausible match.
- After importing, report layer names and feature counts and offer the obvious next steps (basemap, styling, analysis).`,
  commands: [
    { name: 'import', description: 'Import a dataset from a URL or a path', prompt: 'Import this dataset into the map, zoom to it and summarise it: ' },
  ],
  suggestions: ['Import https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson', 'What data is on the shared cloud drive?'],
  tools: [
    {
      name: 'import_data',
      description: 'Import a dataset in one step: downloads an http(s) URL into the virtual filesystem when needed, adds every layer the source contains to the project, zooms the map to the result and returns the added layers with feature counts.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'http(s) URL or a path in the virtual filesystem (e.g. /cloud/shared/data/roads.gpkg)' },
          name: { type: 'string', description: 'Display name for a single-layer source (optional)' },
          layer: { type: 'string', description: 'Sublayer to add from a multi-layer container (optional, default: all)' },
          zoom: { type: 'boolean', description: 'Zoom to the imported layers (default true)' },
        },
        required: ['source'],
      },
      async run({ source, name, layer, zoom = true }, ctx) {
        let path = source;
        if (/^https?:\/\//i.test(source)) ({ path } = await ctx.call('download', { url: source }));
        const added = await ctx.call('layers_add', { uri: path, ...(name ? { name } : {}), ...(layer ? { layer } : {}) });
        const layers = Array.isArray(added) ? added : added && added.layers ? added.layers : added ? [added] : [];
        if (zoom && layers.length) { try { await ctx.call('layers_zoom_to', { layer: layers[0].id || layers[0].name }); } catch (e) { /* raster without extent etc. */ } }
        return { source, path, layers: layers.map((l) => ({ id: l.id, name: l.name, type: l.type, geometry: l.geometryType, features: l.featureCount, crs: l.crs })) };
      },
    },
  ],
};
