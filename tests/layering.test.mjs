#!/usr/bin/env node
// Layering guard (docs/06-架构与分层.md): QGIS knows only files and tool calls; URLs, sharing, presets, cloud
// protocols, external data services and models live in the page layer, which reaches QGIS only through window.qgis
// (tool calls, events) and the virtual filesystem. Static checks over the patch and the page sources, so the boundary
// cannot erode unnoticed. No browser, no build: `node tests/layering.test.mjs` (a second or so).
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const walk = (dir, exts, out = []) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
};
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const lines = (text) => stripComments(text).split("\n");
let failed = 0;
const check = (name, problems, detail = "") => {
  const ok = problems.length === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok && detail ? ` — ${detail}` : ""}${ok ? "" : "\n      " + problems.slice(0, 15).join("\n      ") + (problems.length > 15 ? `\n      … ${problems.length - 15} more` : "")}`);
};
const scan = (sources, patterns) => {
  const out = [];
  for (const [file, text] of sources) {
    lines(text).forEach((line, i) => {
      for (const [re, why] of patterns) if (re.test(line)) out.push(`${file}:${i + 1}: ${why} — ${line.trim().slice(0, 110)}`);
    });
  }
  return out;
};

// --- the QGIS side: added lines of the patch, per file ------------------------------------------------------------
const patch = read("patches/qgis-wasm.patch").split("\n");
const added = new Map(); // file → added source text
let current = null;
for (const l of patch) {
  if (l.startsWith("+++ b/")) { current = l.slice(6); if (!added.has(current)) added.set(current, []); continue; }
  if (current && l.startsWith("+") && !l.startsWith("+++")) added.get(current).push(l.slice(1));
}
const qgisSources = [...added].filter(([f]) => f.startsWith("src/")).map(([f, ls]) => [`patch:${f}`, ls.join("\n")]);

check("QGIS (patch) does not read the page: no URL parsing, storage, page globals or shell modules", scan(qgisSources, [
  [/\bwindow(\.[A-Za-z_$]|\[)/, "window"], [/\bdocument(\.[A-Za-z_$]|\[)/, "document"], [/\bnavigator\s*\./, "navigator"],
  [/\blocation\s*\.\s*(href|search|hash|origin|pathname|host)\b/, "location"], [/\bURLSearchParams\b/, "URLSearchParams"],
  [/\b(localStorage|sessionStorage|indexedDB)\b/, "browser storage"], [/\bfetch\s*\(/, "fetch()"],
  [/\bqgis(Link|Sources|Cloud|Preset|Agent|Python|Instance|Open)\b/, "page module"],
]), `${qgisSources.length} patched source files`);

check("QGIS (patch) knows no model, key or share-link vocabulary", scan(qgisSources, [
  [/\b(anthropic|openai|ollama|claude|gpt-|llm)\b/i, "model vocabulary"], [/\/v1\/(responses|chat\/completions|messages)\b/, "model API"],
  [/\bsk-[A-Za-z0-9_-]{8,}/, "API key"], [/[?&](preset|open|add|basemap|crs|extent|ask|trace|force)=/, "share-link parameter"],
  [/\bsource:\/\//, "source:// spec"],
]));

// the only JavaScript QGIS carries (EM_JS bodies) talks to the shell through Module hooks the shell actually provides
const patchText = [...added.values()].flat().join("\n");
const hooks = [...new Set([...patchText.matchAll(/Module\['([A-Za-z]+)'\]/g)].map((m) => m[1]))];
const shellJs = read("web/shell/qgis-shell.js");
check("every Module hook the patch calls is provided by web/shell/qgis-shell.js", hooks.filter((h) => !new RegExp(`\\b${h}\\s*[:=(]`).test(shellJs)).map((h) => `Module['${h}'] missing`), hooks.join(", "));

// --- the page side ------------------------------------------------------------------------------------------------
// (debug.js is left out on purpose: the Debug view reads the module's runtime statistics — heap size, worker threads — which is its job)
const pageFiles = ["web/shell/progress.js", "web/shell/loading.js", "web/shell/link.js", "web/shell/sources.js", "web/shell/sources-overpass.js", "web/shell/share.js", "web/shell/workspace.js", ...walk("web/shell/plugins", [".js"]), ...walk("web/agent", [".js"]), ...(fs.existsSync(path.join(ROOT, "internal/web")) ? walk("internal/web", [".js"]) : [])]; // + the deployment overlay's page modules when present
const pageSources = pageFiles.map((f) => [f, read(f)]);
const internals = [
  [/\b(ccall|cwrap|wasmExports|wasmMemory|callMain|PThread|stringToUTF8|UTF8ToString|allocateUTF8|setValue|getValue)\s*\(/, "Emscripten internal"],
  [/\bHEAP(U?(8|16|32|64)|F(32|64))\b/, "wasm heap"], [/\bModule\s*[.[]/, "Module"], [/qgisBridge(Resolve|Event)\b/, "bridge hook"],
  [/\b_?qgis_wasm_[a-z_]+\s*\(/, "C export"], [/\bqgisInstance\s*\.\s*(?!FS\b)[A-Za-z_]/, "qgisInstance member other than FS"],
];
check("link.js / sources.js / plugins / agent reach QGIS only through window.qgis (+ files), never module internals", scan(pageSources, internals), `${pageFiles.length} files`);

const agentFiles = pageFiles.filter((f) => f.startsWith("web/agent/"));
// (window.qgisWorkspace — where to render, open/close, header buttons — is the agent's one other page contract and stays allowed)
check("the agent depends on the window.qgis contract alone (no shell modules, no filesystem)", scan(agentFiles.map((f) => [f, read(f)]), [
  [/\bqgis(Instance|Link|Sources|Cloud|Python|Open|Status|Info)\b/, "shell module"], [/\bFS\s*\./, "virtual filesystem"], [/\bcloudfs\b/, "cloudfs"],
]), `${agentFiles.length} files`);

const badImports = [];
for (const f of agentFiles) {
  for (const m of read(f).matchAll(/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (!spec.startsWith(".")) { badImports.push(`${f}: bare import '${spec}'`); continue; }
    const target = path.normalize(path.join(path.dirname(f), spec));
    if (!target.startsWith("web/agent/")) badImports.push(`${f}: imports outside web/agent — '${spec}'`);
    else if (!fs.existsSync(path.join(ROOT, target))) badImports.push(`${f}: missing import '${spec}'`);
  }
}
check("agent modules import only from web/agent/", badImports);

const shellFiles = walk("web/shell", [".js"]).filter((f) => !f.startsWith("web/shell/plugins/"));
// ("claude" alone is allowed here: `claude mcp add …` is the command of an MCP client the Share menu quotes, not a model)
check("the shell carries no model vocabulary (providers, models and keys belong to the agent / presets)", scan(shellFiles.map((f) => [f, read(f)]), [
  [/\b(anthropic|openai|ollama|gpt-|claude-[a-z0-9-]+)\b/i, "model vocabulary"], [/\/v1\/(responses|chat\/completions|messages)\b/, "model API"], [/\bsk-[A-Za-z0-9_-]{8,}/, "API key"],
]), `${shellFiles.length} files`);

// --- the contract itself: every literal tool call resolves to a tool somebody registers --------------------------
const bridgeTools = new Set([...patchText.matchAll(/registerTool\(\s*u"([a-z0-9_]+)"_s/g)].map((m) => m[1]));
const shellTools = new Set();
for (const f of [...shellFiles, ...agentFiles]) for (const m of read(f).matchAll(/registerTool\(\s*['"]([a-z0-9_]+)['"]/g)) shellTools.add(m[1]);
// the shell's built-in tools are the keys of `const jsTools = { name: { … }, … }` in qgis-shell.js
const table = shellJs.slice(shellJs.indexOf("const jsTools = {"));
for (const m of table.slice(0, table.indexOf("\n  };")).matchAll(/^    ([a-z0-9_]+): \{/gm)) shellTools.add(m[1]);
const known = new Set([...bridgeTools, ...shellTools]);
const calls = [];
for (const f of [...pageFiles, "web/shell/qgis-shell.js", "web/shell/pyqgis.js"]) for (const m of read(f).matchAll(/\.call\(\s*['"]([a-z0-9_]+)['"]/g)) calls.push([f, m[1]]);
for (const f of walk("web/shell/pyqgis", [".py"])) for (const m of read(f).matchAll(/_bridge\.call\(\s*"([a-z0-9_]+)"/g)) calls.push([f, m[1]]);
check("every literal tool call in the page / PyQGIS layer names a tool registered by QGIS or the shell",
  calls.filter(([, t]) => !known.has(t)).map(([f, t]) => `${f}: '${t}' is not registered`),
  `${bridgeTools.size} QGIS tools + ${shellTools.size} page tools; ${new Set(calls.map((c) => c[1])).size} distinct calls`);

console.log(failed ? "FAILED" : "OK");
process.exit(failed ? 1 : 0);
