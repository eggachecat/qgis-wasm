#!/usr/bin/env node
// scripts/serve.mjs on a shared host (--shared, see deploy/): the CORS proxy only reaches hosts the presets name and
// follows redirects only inside that set; every MCP / agent call names the page it drives and a result is accepted only
// from that page; the client listing is off. The developer defaults (no flag) stay as they were. Two servers on free
// ports, fake pages on the SSE channel, no browser:  node tests/serve-shared.test.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`); };
const post = async (url, body, headers = {}) => { const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const rpc = (url, method, params, headers) => post(url, { jsonrpc: "2.0", id: 1, method, params }, headers).then((r) => r.body);

// an upstream the proxy may reach: echoes requests; one redirect stays inside the allowlist, one leaves it
const upstreamPort = await freePort();
const upstream = http.createServer((req, res) => {
  if (req.url === "/redirect-out") { res.writeHead(302, { Location: "http://127.0.0.1:1/" }); return res.end(); }
  if (req.url === "/redirect-in") { res.writeHead(302, { Location: `http://127.0.0.1:${upstreamPort}/echo` }); return res.end(); }
  res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ path: req.url, method: req.method }));
}).listen(upstreamPort, "127.0.0.1");

// a bundle directory whose preset names the upstream, so the allowlist is derived from the deployment itself
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serve-shared-"));
fs.mkdirSync(path.join(dir, "presets"));
fs.writeFileSync(path.join(dir, "presets", "default.json"), JSON.stringify({ sources: [{ type: "ogcapi", url: `http://127.0.0.1:${upstreamPort}/ogcapi` }] }));
fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html>ok");

async function start(flags) {
  const port = await freePort();
  const proc = spawn("node", [path.join(ROOT, "scripts/serve.mjs"), "--port", String(port), "--host", "127.0.0.1", "--dir", dir, ...flags], { stdio: ["ignore", "pipe", "pipe"] });
  let banner = "";
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => { banner += d; if (banner.includes("serving")) resolve(); });
    proc.on("exit", (c) => reject(new Error(`serve.mjs exited with ${c}`)));
    setTimeout(() => reject(new Error("serve.mjs did not start")), 10000);
  });
  return { port, proc, base: `http://127.0.0.1:${port}`, banner: banner.trim() };
}

// a fake QGIS page: subscribes to the SSE channel and answers calls (optionally lying about who it is)
function connectPage(base, id, { answer = true, as = id } = {}) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/agent/events?client=${encodeURIComponent(id)}&title=T`, (res) => {
      let buf = ""; const page = { id, res, hello: null, calls: [] };
      res.on("data", (d) => {
        buf += d; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (\S+)/m.exec(chunk)?.[1], data = /^data: (.*)$/m.exec(chunk)?.[1];
          if (ev === "hello") { page.hello = JSON.parse(data); resolve(page); }
          if (ev === "call") {
            const c = JSON.parse(data); page.calls.push(c);
            if (answer) post(`${base}/agent/result`, { id: c.id, client: as, ok: true, result: c.tool === "tools/list" ? [{ name: "state", description: "state", inputSchema: { type: "object", properties: {} } }] : { tool: c.tool, params: c.params, page: id } });
          }
        }
      });
    });
    req.on("error", () => {});
  });
}

const pages = [];
try {
  // ---------------------------------------------------------------- shared mode
  const S = await start(["--shared"]);
  check("shared server starts and announces the policy", /shared mode/.test(S.banner) && /limited to 1 hosts/.test(S.banner), S.banner.replace(/^.*\(/, "("));
  const A = await connectPage(S.base, "page-A"); const B = await connectPage(S.base, "page-B"); pages.push(A, B);
  check("hello tells each page its own MCP endpoint with its client id", A.hello.mcp === `${S.base}/mcp?client=page-A` && A.hello.shared === true, A.hello.mcp);
  check("client listing is off", (await fetch(`${S.base}/agent/clients`)).status === 403);
  let r = await post(`${S.base}/agent/call`, { tool: "state" });
  check("a call without a page id is refused, with a hint", r.body?.ok === false && /client/.test(r.body.error), r.body?.error?.slice(0, 80));
  r = await post(`${S.base}/agent/call`, { tool: "state", client: "page-B" });
  check("a call with a page id reaches exactly that page", r.body?.ok && r.body.result.page === "page-B" && A.calls.length === 0 && B.calls.length === 1);
  r = await post(`${S.base}/agent/call`, { tool: "state", client: "page-Z" });
  check("an unknown page id is an error, never a fallback to another page", r.body?.ok === false && /page-Z/.test(r.body.error) && A.calls.length === 0 && B.calls.length === 1);
  let m = await rpc(`${S.base}/mcp?client=page-A`, "tools/call", { name: "layers_list", arguments: { x: 1 } });
  check("MCP tools/call with ?client= drives that page", m?.result?.structuredContent?.page === "page-A" && A.calls.length === 1, JSON.stringify(m?.result?.structuredContent));
  m = await rpc(`${S.base}/mcp`, "tools/call", { name: "layers_list", arguments: {} }, { "X-Qgis-Client": "page-B" });
  check("MCP with the X-Qgis-Client header works too", m?.result?.structuredContent?.page === "page-B");
  m = await rpc(`${S.base}/mcp`, "tools/call", { name: "layers_list", arguments: {} });
  check("MCP without a page id returns a tool error naming the fix", m?.result?.isError === true && /client/.test(m.result.content[0].text));
  m = await rpc(`${S.base}/mcp?client=page-A`, "tools/list", {});
  check("MCP tools/list goes to the named page", Array.isArray(m?.result?.tools) && m.result.tools[0].name === "state");
  // result ownership: a result posted with another page's id does not resolve the call
  const C = await connectPage(S.base, "page-C", { answer: false }); pages.push(C);
  const pending = post(`${S.base}/agent/call`, { tool: "state", client: "page-C" });
  while (!C.calls.length) await sleep(20);
  await post(`${S.base}/agent/result`, { id: C.calls[0].id, client: "page-B", ok: true, result: { page: "spoofed" } });
  const early = await Promise.race([pending.then(() => "resolved"), sleep(400).then(() => "pending")]);
  await post(`${S.base}/agent/result`, { id: C.calls[0].id, client: "page-C", ok: true, result: { page: "page-C" } });
  r = await pending;
  check("a result is accepted only from the page the call went to", early === "pending" && r.body?.ok && r.body.result.page === "page-C", `spoofed result left the call ${early}`);
  // proxy policy
  const px = (u) => fetch(`${S.base}/proxy?url=${encodeURIComponent(u)}`);
  r = await px(`http://127.0.0.1:${upstreamPort}/echo`);
  check("proxy reaches a host named in the presets", r.status === 200 && (await r.json()).path === "/echo");
  check("proxy refuses a host the deployment does not name", (await px("http://127.0.0.1:1/")).status === 403 && (await px("https://example.com/")).status === 403);
  r = await px(`http://127.0.0.1:${upstreamPort}/redirect-in`);
  check("proxy follows a redirect that stays inside the allowlist", r.status === 200 && (await r.json()).path === "/echo");
  check("proxy does not follow a redirect that leaves it", (await px(`http://127.0.0.1:${upstreamPort}/redirect-out`)).status === 403);
  const idx = await fetch(`${S.base}/index.html`);
  check("static files keep COOP/COEP", idx.status === 200 && idx.headers.get("cross-origin-opener-policy") === "same-origin");
  S.proc.kill();

  // ---------------------------------------------------------------- developer defaults
  const D = await start([]);
  const P = await connectPage(D.base, "dev-page"); pages.push(P);
  check("developer mode: hello carries the plain MCP endpoint", P.hello.mcp === `${D.base}/mcp` && P.hello.shared === false, P.hello.mcp);
  check("developer mode: client listing available", (await (await fetch(`${D.base}/agent/clients`)).json()).some((c) => c.id === "dev-page"));
  r = await post(`${D.base}/agent/call`, { tool: "state" });
  check("developer mode: a call without a page id goes to the most recent page", r.body?.ok && r.body.result.page === "dev-page");
  check("developer mode: proxy is unrestricted", (await fetch(`${D.base}/proxy?url=${encodeURIComponent("http://127.0.0.1:1/")}`)).status !== 403);
  const R = await start(["--proxy-allow", `127.0.0.1:${upstreamPort}`]);
  check("--proxy-allow alone restricts the proxy without the shared page rules", (await fetch(`${R.base}/proxy?url=${encodeURIComponent("http://127.0.0.1:1/")}`)).status === 403 && /limited to 1 hosts/.test(R.banner) && !/shared mode/.test(R.banner));
  D.proc.kill(); R.proc.kill();
} catch (e) {
  failed++; console.log(`  ✗ ${e.message}`);
} finally {
  for (const p of pages) p.res.destroy();
  upstream.close(); fs.rmSync(dir, { recursive: true, force: true });
}
console.log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
