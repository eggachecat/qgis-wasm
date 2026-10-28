/**
 * sources-overpass.js — query source type "overpass": OpenStreetMap through an Overpass API interpreter, declared like
 * any other source (docs/06 §4). The public Overpass API answers it (an own mirror is kinder to it and to you):
 *
 *   { "name": "osm", "type": "overpass", "title": "OpenStreetMap (Overpass)",
 *     "url": "https://overpass-api.de/api/interpreter", "limit": 5000 }
 *
 *   q      either a full Overpass QL program (contains "out") — passed through as is — or tag filters: "highway=traffic_signals",
 *          "amenity=cafe; shop", "building" (one or more, ";" separated; each becomes nwr[key=value]); without a bbox the
 *          filters are wrapped in the collection's / the preset's area if any, otherwise an error: OSM is too big to ask without one
 *   bbox   xmin,ymin,xmax,ymax (EPSG:4326) → Overpass (south,west,north,east)
 *   collections  a few named tag presets for the menus (traffic signals, crossings, junctions, roads, buildings, parking, …)
 *   limit  "out geom <limit>"
 *
 * The answer ([out:json] with "out geom") is turned into GeoJSON here: nodes → points, ways → lines, closed ways with an
 * area tag → polygons, multipolygon relations → polygons from their outer members; tags become string properties next to
 * osm_id / osm_type. QGIS sees one GeoJSON file.
 */
(function () {
  'use strict';
  const registry = window.qgisSources;
  if (!registry) return;

  const PRESETS = [
    { id: 'traffic_signals', title: 'Traffic signals', filters: 'highway=traffic_signals' },
    { id: 'crossings', title: 'Pedestrian crossings', filters: 'highway=crossing' },
    { id: 'stop_signs', title: 'Stop and give-way signs', filters: 'highway=stop; highway=give_way' },
    { id: 'motorway_junctions', title: 'Motorway junctions (ramps)', filters: 'highway=motorway_junction; highway=motorway_link' },
    { id: 'roads', title: 'Roads (all highway ways)', filters: 'highway' },
    { id: 'railways', title: 'Railways and level crossings', filters: 'railway; railway=level_crossing' },
    { id: 'buildings', title: 'Buildings', filters: 'building' },
    { id: 'parking', title: 'Parking', filters: 'amenity=parking' },
    { id: 'construction', title: 'Construction', filters: 'highway=construction; construction; landuse=construction' },
    { id: 'tunnels_bridges', title: 'Tunnels and bridges', filters: 'tunnel=yes; bridge=yes' },
  ];
  // closed ways with one of these keys are areas (osm2pgsql's polygon rule, simplified)
  const AREA_KEYS = new Set(['building', 'landuse', 'leisure', 'amenity', 'natural', 'shop', 'tourism', 'man_made', 'place', 'boundary', 'aeroway', 'military', 'historic', 'power', 'public_transport', 'waterway', 'water', 'parking', 'area:highway']);

  const tokens = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (words, text) => !words.length || words.every((w) => text.toLowerCase().includes(w));
  const bboxOverpass = (b) => `${b[1]},${b[0]},${b[3]},${b[2]}`; // south,west,north,east

  function filterClause(f) {
    const m = /^\s*([A-Za-z0-9_:.-]+)\s*(=|!=|~)\s*(.+?)\s*$/.exec(f);
    if (!m) return `["${f.trim()}"]`;
    const v = m[3].replace(/^"|"$/g, '');
    return m[2] === '~' ? `["${m[1]}"~"${v}"]` : `["${m[1]}"${m[2]}"${v}"]`;
  }
  /** Build the Overpass QL program for tag filters (or pass a full program through) */
  function program(cfg, { q, collection, bbox, limit }) {
    if (q && /\bout\b/.test(q) && /;\s*$/.test(q.trim() + ';')) {
      if (/^\s*\[/.test(q)) return q;             // has its own settings
      return `[out:json][timeout:${cfg.timeout || 60}];${q}`;
    }
    const preset = collection ? PRESETS.find((p) => p.id === collection || p.title === collection) : null;
    const filters = String(preset ? preset.filters : q || '').split(/\s*;\s*/).filter(Boolean);
    if (!filters.length) throw new Error(`${cfg.name}: give tag filters (e.g. "highway=traffic_signals"), a collection or a full Overpass QL program`);
    const area = bbox ? `(${bboxOverpass(bbox)})` : cfg.bbox ? `(${bboxOverpass(cfg.bbox)})` : null;
    if (!area) throw new Error(`${cfg.name}: a bbox is required (OSM is too big to query without one)`);
    const n = Math.max(1, Number(limit || cfg.limit || 5000));
    return `[out:json][timeout:${cfg.timeout || 60}];(${filters.map((f) => `nwr${filterClause(f)}${area};`).join('')});out body geom ${n};`;
  }

  function toGeoJSON(data) {
    const features = [];
    const props = (el) => ({ osm_id: el.id, osm_type: el.type, ...(el.tags || {}) });
    const closed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
    const ring = (g) => g.map((p) => [p.lon, p.lat]);
    const isArea = (el, g) => closed(g) && (el.tags?.area === 'yes' || Object.keys(el.tags || {}).some((k) => AREA_KEYS.has(k)));
    for (const el of data.elements || []) {
      if (el.type === 'node') { if (Number.isFinite(el.lon)) features.push({ type: 'Feature', id: `node/${el.id}`, geometry: { type: 'Point', coordinates: [el.lon, el.lat] }, properties: props(el) }); continue; }
      if (el.type === 'way') {
        const g = (el.geometry || []).filter((p) => p && Number.isFinite(p.lon));
        if (g.length < 2) continue;
        features.push({ type: 'Feature', id: `way/${el.id}`, geometry: isArea(el, g) ? { type: 'Polygon', coordinates: [ring(g)] } : { type: 'LineString', coordinates: ring(g) }, properties: props(el) });
        continue;
      }
      if (el.type === 'relation') {
        const outers = (el.members || []).filter((m) => m.type === 'way' && (m.role === 'outer' || !m.role) && Array.isArray(m.geometry) && m.geometry.length > 3).map((m) => ring(m.geometry)).filter((r) => r.length > 3 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]);
        if (el.tags?.type === 'multipolygon' && outers.length) features.push({ type: 'Feature', id: `relation/${el.id}`, geometry: outers.length === 1 ? { type: 'Polygon', coordinates: [outers[0]] } : { type: 'MultiPolygon', coordinates: outers.map((r) => [r]) }, properties: props(el) });
        else for (const m of el.members || []) if (m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1) features.push({ type: 'Feature', id: `relation/${el.id}/way/${m.ref}`, geometry: { type: 'LineString', coordinates: ring(m.geometry) }, properties: { ...props(el), member_role: m.role || '' } });
      }
    }
    return features;
  }

  async function run(cfg, ql) {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...(cfg.headers || {}) }, body: `data=${encodeURIComponent(ql)}` };
    const check = async (res) => { if (!res.ok) throw new Error(`${cfg.name}: Overpass answered HTTP ${res.status}${res.status === 404 ? ' (is the forwarding route deployed on this gateway?)' : ''}: ${(await res.text()).slice(0, 200)}`); return res; };
    const proxied = () => fetch(`${location.origin}/proxy?url=${encodeURIComponent(cfg.url)}`, init);
    if (cfg.proxy === true) return check(await proxied());
    try { return check(await fetch(cfg.url, init)); } catch (e) { if (cfg.proxy === false || !(e instanceof TypeError)) throw e; return check(await proxied()); }
  }

  registry.registerType('overpass', {
    async collections() { return PRESETS.map((p) => ({ id: p.id, title: p.title, description: p.filters })); },
    async search(cfg, { q } = {}) { const w = tokens(q); return PRESETS.filter((p) => matches(w, `${p.id} ${p.title} ${p.filters}`)).map((p) => ({ id: p.id, title: p.title, description: p.filters })); },
    async fetch(cfg, { q, collection, id, bbox, limit, progress } = {}) {
      const ql = program(cfg, { q, collection: collection || id, bbox, limit });
      progress?.('Overpass is running the query (seconds to a minute for large areas)');
      const res = await run(cfg, ql);
      progress?.('Reading the answer');
      const data = await res.json();
      progress?.(`${(data.elements || []).length.toLocaleString()} OSM elements → GeoJSON`);
      if (data.remark && !(data.elements || []).length) throw new Error(`${cfg.name}: ${data.remark}`);
      const features = toGeoJSON(data);
      const preset = PRESETS.find((p) => p.id === (collection || id) || p.title === (collection || id));
      const name = `OSM · ${preset ? preset.title : (q || '').replace(/\s+/g, ' ').slice(0, 50)}`;
      return { text: JSON.stringify({ type: 'FeatureCollection', features, overpass: { query: ql, elements: (data.elements || []).length, remark: data.remark || null } }), format: 'geojson', name };
    },
  });
})();
