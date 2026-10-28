#!/usr/bin/env node
/**
 * Static server + agent gateway for the QGIS WebAssembly bundle (build/qgis/output/bin by default).
 *
 *  - COOP/COEP headers (Qt for WebAssembly threads need SharedArrayBuffer), range requests, SPA fallback,
 *    pre-compressed .br/.gz sidecars (scripts/compress-bundle.mjs) with ETag revalidation
 *  - /proxy?url=…         CORS proxy for data servers / MCP servers without CORS headers (any method, body forwarded)
 *  - /agent/events        SSE channel each open QGIS page subscribes to (qgis-shell.js); /agent/result receives replies
 *  - /mcp                 MCP server (Streamable HTTP, JSON-RPC 2.0): tools/list and tools/call are forwarded to the
 *                         connected QGIS page, i.e. any MCP client (Claude Code, Claude Desktop via scripts/mcp-stdio.mjs,
 *                         internal agents) can operate the QGIS desktop running in the browser.
 *
 *   node scripts/serve.mjs [--port 8080] [--host 0.0.0.0] [--dir build/qgis/output/bin] [--no-proxy]
 *                          [--shared] [--proxy-allow host[:port],…] [--public-url https://qgis.example.com]
 *   claude mcp add --transport http qgis http://127.0.0.1:8080/mcp
 *
 *  Shared deployment (deploy/, scripts/deploy.sh): run with --shared --host 127.0.0.1 behind a TLS reverse proxy. Then
 *  every MCP / agent call names the page it drives (/mcp?client=<id>; the page shows its own endpoint under
 *  Plugins → Share), results are accepted only from that page, /agent/clients is off, and /proxy only reaches hosts that
 *  the presets name (plus --proxy-allow). Without --shared (a developer's machine) calls go to the most recent page and
 *  the proxy reaches anything.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(arg("--port", process.env.PORT ?? 8080));
const DIR = path.resolve(here, "..", arg("--dir", "build/qgis/output/bin"));
const PROXY = !args.includes("--no-proxy");
const HOST = arg("--host", process.env.HOST ?? "0.0.0.0");
// --shared: a multi-user deployment (TLS terminated in front, many people's tabs connected). Every MCP / agent call must
// name the page it drives (?client=<id>, the id is a secret only that page knows), the client listing is off, /proxy only
// reaches hosts the deployment names. Without it (a developer's machine) a call goes to the most recent page and the proxy
// reaches anything, as before.
const SHARED = args.includes("--shared");
const PUBLIC_URL = (arg("--public-url", process.env.PUBLIC_URL ?? "") || "").replace(/\/+$/, "");
const MAX_BODY = 1024 * 1024 * 1024; // request bodies (proxy uploads to object storage can be large)
const VERSION = "0.2.1";

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".geojson": "application/geo+json", ".wasm": "application/wasm", ".data": "application/octet-stream", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".qgs": "application/xml", ".qgz": "application/zip", ".md": "text/markdown", ".csv": "text/csv", ".txt": "text/plain",
  ".gpkg": "application/geopackage+sqlite3", ".tif": "image/tiff", ".tiff": "image/tiff", ".pmtiles": "application/octet-stream",
};
const baseHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Range, Mcp-Session-Id, Mcp-Protocol-Version, X-Amz-Date, X-Amz-Content-Sha256, X-Amz-Security-Token, X-Amz-Copy-Source, X-Amz-User-Agent, If-None-Match, If-Modified-Since, Cache-Control, Pragma",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, Content-Range, Accept-Ranges, Content-Length, ETag",
};
const send = (res, code, body, type = "text/plain; charset=utf-8", extra = {}) => {
  res.writeHead(code, { ...baseHeaders, "Content-Type": type, ...extra });
  res.end(body);
};
const sendJson = (res, code, obj, extra = {}) => send(res, code, JSON.stringify(obj), "application/json", extra);
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = []; let size = 0;
  req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("request body too large")); req.destroy(); } else chunks.push(c); });
  req.on("end", () => resolve(Buffer.concat(chunks))); req.on("error", reject);
});
// the origin pages and MCP clients see: --public-url, else what the (reverse) proxy or the client sent
const publicBase = (req) => PUBLIC_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`}`;

// ---------------------------------------------------------------- proxy policy
// With --shared (or --proxy-allow) /proxy only reaches hosts the deployment names: every host that appears in a URL of
// DIR/presets/*.json (mounts, query sources, basemaps, MCP servers, the model gateway) plus --proxy-allow host[:port],…
const hostOf = (s) => { try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).host.toLowerCase(); } catch { return String(s).toLowerCase(); } };
const proxyAllow = new Set((arg("--proxy-allow", "") || "").split(",").map((x) => x.trim()).filter(Boolean).map(hostOf));
const PROXY_RESTRICTED = SHARED || args.includes("--proxy-allow");
if (fs.existsSync(path.join(DIR, "presets"))) {
  for (const f of fs.readdirSync(path.join(DIR, "presets"))) if (f.endsWith(".json")) {
    for (const m of fs.readFileSync(path.join(DIR, "presets", f), "utf8").matchAll(/https?:\/\/[^\s"'<>\\/]+/gi)) proxyAllow.add(hostOf(m[0]));
  }
}
const proxyAllowed = (u) => !PROXY_RESTRICTED || proxyAllow.has(u.host.toLowerCase()) || proxyAllow.has(u.hostname.toLowerCase());

// ---------------------------------------------------------------- agent transport: pages ↔ server
const clients = new Map(); // clientId → { id, res, title, since }
const waiting = new Map(); // callId → { resolve, timer }
let callSeq = 1;

function pickClient(preferred) {
  if (preferred && clients.has(preferred)) return clients.get(preferred);
  if (SHARED) return null; // never guess on a shared server: a call must name its page
  let latest = null;
  for (const c of clients.values()) if (!latest || c.since > latest.since) latest = c;
  return latest;
}
function callTool(tool, params, { client, timeoutMs = 180000 } = {}) {
  const target = pickClient(client);
  if (!target) {
    if (SHARED) return Promise.reject(new Error(client
      ? `No QGIS page with client id ${client} is connected (the tab was closed or reloaded; each page gets a new id).`
      : "This server is shared: name the page to drive with ?client=<id> (/mcp?client=… or {\"client\": …}). The page shows its endpoint under Plugins → Share → \"Copy MCP endpoint of this page\"."));
    return Promise.reject(new Error(`No QGIS page is connected. Open http://127.0.0.1:${PORT}/ in a browser (Chrome ≥ 137) and retry.`));
  }
  const id = String(callSeq++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`tool ${tool} timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    waiting.set(id, { client: target.id, resolve: (body) => { clearTimeout(timer); waiting.delete(id); body.ok ? resolve(body.result) : reject(new Error(body.error || `${tool} failed`)); } });
    target.res.write(`event: call\ndata: ${JSON.stringify({ id, tool, params: params ?? {} })}\n\n`);
  });
}

// ---------------------------------------------------------------- MCP server (Streamable HTTP)
const sessionId = crypto.randomUUID();
const MCP_INSTRUCTIONS = "Tools operate the QGIS Desktop instance running in the connected browser tab (qgis-wasm). Call `state` first. "
  + "Files live in a virtual filesystem: /cloud/<mount>/… is mounted object storage, /home/web_user is persistent, /qgis/share/demo has demo data; "
  + "URLs can be passed to layers_add / project_open directly. project_share saves a project to a cloud mount and returns a link that opens it.";

async function mcpHandle(message, client = null) {
  const { id, method, params = {} } = message;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, msg, data) => ({ jsonrpc: "2.0", id, error: { code, message: msg, ...(data ? { data } : {}) } });
  try {
    switch (method) {
      case "initialize":
        return reply({ protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "qgis-wasm", version: VERSION }, instructions: MCP_INSTRUCTIONS });
      case "ping":
        return reply({});
      case "tools/list": {
        const tools = await callTool("tools/list", {}, { client });
        return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema || { type: "object", properties: {} } })) });
      }
      case "tools/call": {
        const name = params.name;
        const args = params.arguments || {};
        try {
          const result = await callTool(name, args, { client });
          const content = [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }];
          if (name === "canvas_export_image" && result && result.path) {
            try { const img = await callTool("file_base64", { path: result.path }, { client }); content.push({ type: "image", data: img.base64, mimeType: img.mimeType }); } catch (e) { /* text only */ }
          }
          const out = { content, isError: false };
          if (result && typeof result === "object" && !Array.isArray(result)) out.structuredContent = result;
          return reply(out);
        } catch (e) {
          return reply({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
        }
      }
      case "resources/list": return reply({ resources: [] });
      case "prompts/list": return reply({ prompts: [] });
      default:
        if (method && method.startsWith("notifications/")) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return fail(-32000, e.message);
  }
}

// ---------------------------------------------------------------- HTTP server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "OPTIONS") return send(res, 204, "");

  // --- CORS proxy
  if (url.pathname === "/proxy") {
    if (!PROXY) return send(res, 403, "proxy disabled");
    const target = url.searchParams.get("url");
    if (!target || !/^https?:\/\//i.test(target)) return send(res, 400, "missing or invalid url");
    let targetUrl;
    try { targetUrl = new URL(target); } catch { return send(res, 400, "invalid url"); }
    if (!proxyAllowed(targetUrl)) return send(res, 403, `proxy: ${targetUrl.host} is not an allowed target (hosts named in presets/*.json or --proxy-allow)`);
    try {
      const skip = new Set(["host", "origin", "referer", "cookie", "connection", "content-length", "transfer-encoding", "accept-encoding", "sec-fetch-mode", "sec-fetch-site", "sec-fetch-dest", "user-agent"]);
      const headers = {};
      for (const [h, v] of Object.entries(req.headers)) if (!skip.has(h) && !h.startsWith("sec-ch-") && v !== undefined) headers[h] = Array.isArray(v) ? v.join(", ") : v;
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      // redirects are followed here, so that each hop is checked against the allowlist (a redirect to an internal host is not followed)
      let r, current = targetUrl, method = req.method, payloadIn = body;
      for (let hop = 0; ; hop++) {
        r = await fetch(current, { method, headers, body: payloadIn, redirect: "manual" });
        const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
        if (!loc || hop >= 5) break;
        current = new URL(loc, current);
        if (!proxyAllowed(current)) return send(res, 403, `proxy: redirect to ${current.host} is not allowed`);
        if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === "POST")) { method = "GET"; payloadIn = undefined; }
      }
      const out = { ...baseHeaders, "Content-Type": r.headers.get("content-type") ?? "application/octet-stream" };
      for (const [h, v] of r.headers.entries()) if (!["content-encoding", "transfer-encoding", "connection", "content-length", "access-control-allow-origin", "access-control-allow-headers", "access-control-allow-methods", "access-control-expose-headers"].includes(h)) out[h] = v;
      out["Access-Control-Expose-Headers"] = "*";
      if (req.method === "HEAD") {
        // HEAD has no body: forward the upstream Content-Length (cloudfs.js reads object sizes from it)
        if (r.headers.get("content-length")) out["Content-Length"] = r.headers.get("content-length");
        res.writeHead(r.status, out);
        return res.end();
      }
      const payload = Buffer.from(await r.arrayBuffer());
      out["Content-Length"] = String(payload.length);
      res.writeHead(r.status, out);
      return res.end(payload);
    } catch (e) {
      return send(res, 502, `proxy error: ${e.message}`);
    }
  }

  // --- agent transport
  if (url.pathname === "/agent/ping") { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); } // "this server has the agent transport and /mcp"
  if (url.pathname === "/agent/events") {
    const clientId = url.searchParams.get("client") || crypto.randomUUID();
    res.writeHead(200, { ...baseHeaders, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const mcp = SHARED ? `${publicBase(req)}/mcp?client=${encodeURIComponent(clientId)}` : `${publicBase(req)}/mcp`;
    res.write(`event: hello\ndata: ${JSON.stringify({ client: clientId, mcp, shared: SHARED })}\n\n`);
    clients.set(clientId, { id: clientId, res, title: url.searchParams.get("title") || "", since: Date.now() });
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(ping); clients.delete(clientId); });
    console.error(`[agent] page connected (${clients.size} total)`);
    return;
  }
  if (url.pathname === "/agent/result" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const w = waiting.get(String(body.id));
      if (w && w.client === body.client) w.resolve(body); // only the page the call went to may answer it
      return sendJson(res, 200, { ok: true });
    } catch (e) { return send(res, 400, e.message); }
  }
  if (url.pathname === "/agent/clients") {
    if (SHARED) return send(res, 403, "the client listing is disabled on a shared server; each page knows its own id");
    return sendJson(res, 200, [...clients.entries()].map(([id, c]) => ({ id, title: c.title, since: c.since })));
  }
  // simple REST access for scripts: POST /agent/call {tool, params}
  if (url.pathname === "/agent/call" && req.method === "POST") {
    try {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      const result = await callTool(body.tool, body.params || {}, { client: body.client });
      return sendJson(res, 200, { ok: true, result });
    } catch (e) { return sendJson(res, 200, { ok: false, error: e.message }); }
  }

  // --- MCP
  if (url.pathname === "/mcp") {
    if (req.method === "GET") return send(res, 405, "This MCP server does not open server-initiated streams; POST JSON-RPC messages.", "text/plain", { Allow: "POST, DELETE" });
    if (req.method === "DELETE") return send(res, 200, "");
    if (req.method !== "POST") return send(res, 405, "method not allowed");
    let payload;
    try { payload = JSON.parse((await readBody(req)).toString("utf8")); } catch (e) { return sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const messages = Array.isArray(payload) ? payload : [payload];
    const client = url.searchParams.get("client") || (typeof req.headers["x-qgis-client"] === "string" ? req.headers["x-qgis-client"] : null);
    const replies = (await Promise.all(messages.map((m) => mcpHandle(m, client)))).filter(Boolean);
    for (const m of messages) if (m.method && m.method !== "notifications/initialized") console.error(`[mcp] ${m.method}${m.params?.name ? " " + m.params.name : ""}`);
    if (!replies.length) return send(res, 202, "", "text/plain", { "Mcp-Session-Id": sessionId });
    return sendJson(res, 200, Array.isArray(payload) ? replies : replies[0], { "Mcp-Session-Id": sessionId });
  }

  // --- static files
  let file = path.join(DIR, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIR)) return send(res, 403, "forbidden");
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, "index.html");
    file = fs.existsSync(idx) ? idx : path.join(DIR, "index.html");
  }
  if (!fs.existsSync(file)) return send(res, 404, "not found");
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const type = MIME[ext] ?? "application/octet-stream";
  const range = req.headers.range;
  // Pre-compressed sidecars (scripts/compress-bundle.mjs writes qgis.wasm.br / .gz next to the originals; nginx users get
  // the same with brotli_static / gzip_static). Only whole-file responses are encoded (Range and Content-Encoding do not
  // mix), only when the sidecar is at least as new as its file (a stale .br next to a fresh qgis.js is exactly the
  // mismatch the ETag scheme below exists to prevent), and only when the client advertises the encoding. Browsers
  // offer "br" on secure origins only (https / localhost); plain http on a LAN address falls back to gzip.
  const accept = String(req.headers["accept-encoding"] || "");
  let encoded = null;
  if (!range) {
    for (const [enc, suffix] of [["br", ".br"], ["gzip", ".gz"]]) {
      if (!new RegExp(`(^|,)\\s*${enc}\\s*(;|,|$)`).test(accept) || !fs.existsSync(file + suffix)) continue;
      const side = fs.statSync(file + suffix);
      if (side.mtimeMs >= stat.mtimeMs) { encoded = { enc, file: file + suffix, size: side.size }; break; }
    }
  }
  // Everything revalidates on every load (cheap 304s): qgis.js and qgis.wasm are generated together and the glue's
  // EM_ASM table only matches its own binary — a cached qgis.wasm with a fresh qgis.js dies in main() with
  // "ASM_CONSTS[code] is not a function". The 130 MB binary is therefore validated by ETag instead of max-age.
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${encoded ? "-" + encoded.enc : ""}"`;
  const validators = { ETag: etag, "Last-Modified": stat.mtime.toUTCString(), "Cache-Control": "no-cache", Vary: "Accept-Encoding" };
  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch.split(",").map((t) => t.trim()).includes(etag)) {
    res.writeHead(304, { ...baseHeaders, ...validators });
    return res.end();
  }
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const endB = m[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, { ...baseHeaders, ...validators, "Content-Type": type, "Content-Range": `bytes ${start}-${endB}/${stat.size}`, "Content-Length": endB - start + 1, "Accept-Ranges": "bytes" });
    fs.createReadStream(file, { start, end: endB }).pipe(res);
    return;
  }
  if (encoded) {
    res.writeHead(200, { ...baseHeaders, ...validators, "Content-Type": type, "Content-Encoding": encoded.enc, "Content-Length": encoded.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(encoded.file).pipe(res);
    return;
  }
  res.writeHead(200, { ...baseHeaders, ...validators, "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => console.log(`qgis-wasm serving ${DIR} at http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}  (COOP/COEP on, MCP at /mcp${PROXY ? ", CORS proxy at /proxy?url=" : ""}`
  + (SHARED ? `; shared mode: pages addressed by ?client=, proxy limited to ${proxyAllow.size} hosts` : PROXY_RESTRICTED ? `; proxy limited to ${proxyAllow.size} hosts` : "") + ")"));
