#!/usr/bin/env node
/**
 * Mock "internal geodata catalogue" MCP server (Streamable HTTP, JSON-RPC 2.0) for tests and demos.
 * Exposes two tools and serves the datasets in --data as static files with CORS headers:
 *   search_datasets {query}  → [{name, title, description, url, format}]
 *   get_dataset {name}       → {name, url, …}
 * The same catalogue is also published the two ways web/shell/sources.js understands without MCP:
 *   /catalog.json                                  JSON catalogue (type "catalog")
 *   /ogcapi/collections[/<name>/items?bbox=&limit=] a minimal OGC API – Features facade over the GeoJSON files (type "ogcapi")
 *   + any internal/tests/mock-*.mjs next to this repository (a deployment's own services; default export (req, res, url, ctx) → bool)
 *
 *   node tests/mock-mcp.mjs --port 9124 --data tests/data
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", 9124));
const DATA = path.resolve(arg("--data", "tests/data"));
const base = () => `http://127.0.0.1:${PORT}/data/`;

const catalogue = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => /\.(geojson|json|gpkg|csv|tif|tiff)$/i.test(f)).map((f) => ({
  name: f.replace(/\.[^.]+$/, ""),
  title: f.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
  description: `Dataset ${f} from the internal catalogue (mock)`,
  url: base() + encodeURIComponent(f),
  format: path.extname(f).slice(1).toLowerCase(),
  size: fs.statSync(path.join(DATA, f)).size,
})) : [];

const tools = [
  { name: "search_datasets", description: "Search the internal geodata catalogue. Returns datasets with a download URL that QGIS can open directly (layers_add).", inputSchema: { type: "object", properties: { query: { type: "string", description: "free text, e.g. 'countries'" } } } },
  { name: "get_dataset", description: "Details of one dataset by name.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
];

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Range, Mcp-Session-Id, Mcp-Protocol-Version, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-Copy-Source, X-Amz-User-Agent, If-None-Match, If-Modified-Since, Cache-Control, Pragma", "Access-Control-Expose-Headers": "Mcp-Session-Id, Content-Length, Content-Range" };
const json = (res, code, obj, extra = {}) => { res.writeHead(code, { ...cors, "Content-Type": "application/json", ...extra }); res.end(JSON.stringify(obj)); };

function handle(m) {
  const reply = (result) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize": return reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "geo-catalogue-mock", version: "1.0.0" } });
    case "ping": return reply({});
    case "tools/list": return reply({ tools });
    case "tools/call": {
      const { name, arguments: a = {} } = m.params || {};
      if (name === "search_datasets") {
        const q = (a.query || "").toLowerCase().split(/\s+/).filter(Boolean);
        const hits = catalogue.filter((d) => !q.length || q.some((w) => (d.name + " " + d.description).toLowerCase().includes(w)));
        return reply({ content: [{ type: "text", text: JSON.stringify(hits, null, 2) }], structuredContent: { datasets: hits }, isError: false });
      }
      if (name === "get_dataset") {
        const d = catalogue.find((x) => x.name === a.name);
        return d ? reply({ content: [{ type: "text", text: JSON.stringify(d, null, 2) }], structuredContent: d, isError: false }) : reply({ content: [{ type: "text", text: `no dataset named ${a.name}` }], isError: true });
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${name}` } };
    }
    default:
      if (m.method?.startsWith("notifications/")) return null;
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } };
  }
}

// bounding boxes of GeoJSON (for the OGC API facade)
function bboxOf(fc) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => { if (typeof c[0] === "number") { b[0] = Math.min(b[0], c[0]); b[1] = Math.min(b[1], c[1]); b[2] = Math.max(b[2], c[0]); b[3] = Math.max(b[3], c[1]); } else for (const x of c) walk(x); };
  for (const f of fc.features || []) if (f.geometry) walk(f.geometry.type === "GeometryCollection" ? f.geometry.geometries.map((g) => g.coordinates) : f.geometry.coordinates);
  return b;
}
const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// route extensions: internal/tests/mock-*.mjs (absent in the open-source tree)
const extDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../internal/tests");
const extensions = [];
if (fs.existsSync(extDir)) for (const f of fs.readdirSync(extDir).filter((n) => /^mock-.*\.mjs$/.test(n)).sort()) extensions.push((await import(path.join(extDir, f))).default);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (url.pathname.startsWith("/data/")) {
    const file = path.join(DATA, decodeURIComponent(url.pathname.slice(6)));
    if (!file.startsWith(DATA) || !fs.existsSync(file)) { res.writeHead(404, cors); return res.end("not found"); }
    const stat = fs.statSync(file);
    res.writeHead(200, { ...cors, "Content-Type": /\.geojson$|\.json$/i.test(file) ? "application/geo+json" : "application/octet-stream", "Content-Length": stat.size, "Access-Control-Allow-Origin": "*" });
    return fs.createReadStream(file).pipe(res);
  }
  // --- optional route extensions (internal/tests/mock-*.mjs: default export async (req, res, url, ctx) → handled?)
  for (const ext of extensions) if (await ext(req, res, url, { catalogue, DATA, json, bboxOf, intersects, cors, fs, path })) return;
  // --- a mock Overpass interpreter (web/shell/sources-overpass.js): echoes the query, answers with two nodes, a closed
  // building way (→ polygon) and an open road way (→ line) inside whatever bbox was asked
  if (url.pathname === "/overpass/api/interpreter") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const q = decodeURIComponent((new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get("data") || url.searchParams.get("data") || "").replace(/\+/g, " "));
    const m = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(q);
    const [s, w, n, e] = m ? m.slice(1).map(Number) : [37.36, -121.98, 37.38, -121.95];
    const cy = (s + n) / 2, cx = (w + e) / 2, d = Math.min(n - s, e - w) / 10;
    const only = /\["highway"="traffic_signals"\]/.test(q) && !/building/.test(q);
    const elements = [
      { type: "node", id: 1, lat: cy, lon: cx, tags: { highway: "traffic_signals", name: "Signal A" } },
      { type: "node", id: 2, lat: cy + d, lon: cx + d, tags: { highway: "traffic_signals" } },
      ...(only ? [] : [
        { type: "way", id: 10, tags: { building: "yes", name: "Block" }, geometry: [{ lat: cy - d, lon: cx - d }, { lat: cy - d, lon: cx }, { lat: cy, lon: cx }, { lat: cy, lon: cx - d }, { lat: cy - d, lon: cx - d }] },
        { type: "way", id: 11, tags: { highway: "residential", name: "Mock Street" }, geometry: [{ lat: cy - 2 * d, lon: cx - 2 * d }, { lat: cy + 2 * d, lon: cx + 2 * d }] }]),
    ];
    return json(res, 200, { version: 0.6, generator: "mock", osm3s: { timestamp_osm_base: "2026-01-01T00:00:00Z" }, elements, remark: null, query: q });
  }
  if (url.pathname === "/catalog.json") return json(res, 200, catalogue);
  if (url.pathname === "/ogcapi" || url.pathname.startsWith("/ogcapi/")) {
    const rest = url.pathname.slice("/ogcapi".length);
    const geo = catalogue.filter((d) => d.format === "geojson");
    const read = (d) => JSON.parse(fs.readFileSync(path.join(DATA, `${d.name}.geojson`), "utf8"));
    const collection = (d) => ({ id: d.name, title: d.title, description: d.description, itemType: "feature", extent: { spatial: { bbox: [bboxOf(read(d))], crs: "http://www.opengis.net/def/crs/OGC/1.3/CRS84" } }, links: [{ rel: "items", type: "application/geo+json", href: `${url.origin}/ogcapi/collections/${d.name}/items` }] });
    if (rest === "" || rest === "/") return json(res, 200, { title: "mock OGC API – Features", description: "the test catalogue as collections", links: [{ rel: "data", href: `${url.origin}/ogcapi/collections` }] });
    if (rest === "/collections") return json(res, 200, { collections: geo.map(collection), links: [] });
    const m = /^\/collections\/([^/]+)(\/items)?$/.exec(rest);
    if (!m) { res.writeHead(404, cors); return res.end("not found"); }
    const d = geo.find((x) => x.name === decodeURIComponent(m[1]));
    if (!d) return json(res, 404, { code: "NotFound", description: `no collection ${m[1]}` });
    if (!m[2]) return json(res, 200, collection(d));
    const g = read(d);
    let features = g.features;
    const bbox = url.searchParams.get("bbox");
    if (bbox) { const b = bbox.split(",").map(Number); features = features.filter((f) => intersects(bboxOf({ features: [f] }), b)); }
    const q = (url.searchParams.get("q") || "").toLowerCase();
    if (q) features = features.filter((f) => JSON.stringify(f.properties || {}).toLowerCase().includes(q));
    const limit = Number(url.searchParams.get("limit") || 10);
    console.error(`[mock-mcp] ogcapi items ${d.name} bbox=${bbox || "-"} q=${q || "-"} limit=${limit} → ${Math.min(limit, features.length)}/${g.features.length}`);
    return json(res, 200, { type: "FeatureCollection", numberMatched: features.length, numberReturned: Math.min(limit, features.length), features: features.slice(0, limit), links: [] }, { "Content-Type": "application/geo+json" });
  }
  if (url.pathname === "/mcp") {
    if (req.method === "DELETE") { res.writeHead(200, cors); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405, cors); return res.end("POST JSON-RPC"); }
    const chunks = []; for await (const c of req) chunks.push(c);
    let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const messages = Array.isArray(payload) ? payload : [payload];
    const replies = messages.map(handle).filter(Boolean);
    for (const m of messages) console.error(`[mock-mcp] ${m.method} ${m.params?.name || ""}`);
    if (!replies.length) { res.writeHead(202, { ...cors, "Mcp-Session-Id": "mock-session" }); return res.end(); }
    return json(res, 200, Array.isArray(payload) ? replies : replies[0], { "Mcp-Session-Id": "mock-session" });
  }
  json(res, 200, { name: "geo-catalogue-mock", mcp: "/mcp", datasets: catalogue.length });
}).listen(PORT, () => console.log(`[mock-mcp] catalogue with ${catalogue.length} datasets at http://127.0.0.1:${PORT}/mcp`));
