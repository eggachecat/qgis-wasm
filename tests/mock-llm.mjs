#!/usr/bin/env node
/**
 * Scripted "language model" for deterministic agent tests: speaks the OpenAI Responses API (POST /v1/responses,
 * streaming or not) and Chat Completions (POST /v1/chat/completions). Behaviour depends on the last user message:
 *   "how many layers"   → calls layers_list, then answers "There are N layers: …"
 *   "city regions"      → mcp__catalog__search_datasets → import_data(first url) → "Imported <name> with N features."
 *   "save the project"  → project_save {path} → "Saved to <path>." (or reports the declined tool)
 *   "export"            → canvas_export_image → "Exported."
 *   anything else       → "Echo: <text>"
 * Steps are inferred from the function_call_output items already present in the request.
 *
 *   node tests/mock-llm.mjs --port 9125
 */
import http from "node:http";

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", 9125));
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept" };
let counter = 0;
const id = (p) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Normalise both wire formats into { user, calls: [{name, args, output}] } for the conversation so far */
function parse(body) {
  const out = { user: "", calls: [] };
  if (Array.isArray(body.input)) {
    const pending = new Map();
    for (const it of body.input) {
      if (it.role === "user") { out.user = typeof it.content === "string" ? it.content : (it.content || []).map((c) => c.text || "").join(""); out.calls = []; }
      if (it.type === "function_call") pending.set(it.call_id, { name: it.name, args: safeJson(it.arguments) });
      if (it.type === "function_call_output") { const c = pending.get(it.call_id) || { name: "?", args: {} }; out.calls.push({ ...c, output: it.output }); }
    }
  } else if (Array.isArray(body.messages)) {
    const pending = new Map();
    for (const m of body.messages) {
      if (m.role === "user") { out.user = typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join(""); out.calls = []; }
      for (const tc of m.tool_calls || []) pending.set(tc.id, { name: tc.function.name, args: safeJson(tc.function.arguments) });
      if (m.role === "tool") { const c = pending.get(m.tool_call_id) || { name: "?", args: {} }; out.calls.push({ ...c, output: m.content }); }
    }
  }
  return out; // only the calls after the last user message are kept
}
const safeJson = (s) => { try { return JSON.parse(s || "{}"); } catch (e) { return {}; } };

/** The script: returns { text } or { call: { name, args } } */
function decide({ user, calls }) {
  const u = user.toLowerCase();
  const last = calls[calls.length - 1];
  if (u.includes("how many layers")) {
    if (!last || last.name !== "layers_list") return { call: { name: "layers_list", args: {} } };
    const layers = safeJson(last.output);
    const names = Array.isArray(layers) ? layers.map((l) => l.name) : [];
    return { text: `There are **${names.length} layers**: ${names.join(", ")}.` };
  }
  if (u.includes("city regions")) {
    const search = calls.find((c) => c.name.startsWith("mcp__") && c.name.endsWith("search_datasets"));
    if (!search) return { call: { name: "mcp__catalog__search_datasets", args: { query: "city regions" } } };
    const imp = calls.find((c) => c.name === "import_data");
    if (!imp) {
      const res = safeJson(search.output);
      const hits = res.structured?.datasets || safeJson(res.text || "[]");
      const url = Array.isArray(hits) && hits[0] ? hits[0].url : "";
      return { call: { name: "import_data", args: { source: url, name: "City regions" } } };
    }
    const r = safeJson(imp.output);
    const layer = r.layers?.[0];
    return { text: layer ? `Imported **${layer.name}** with ${layer.features} features and zoomed to it.` : `Import failed: ${imp.output}` };
  }
  if (u.includes("save the project")) {
    if (!last || last.name !== "project_save") return { call: { name: "project_save", args: { path: "/home/web_user/agent-test.qgz" } } };
    return { text: last.output.startsWith("Error:") ? `I could not save: ${last.output}` : `Saved to /home/web_user/agent-test.qgz.` };
  }
  if (u.includes("export")) {
    if (!last || last.name !== "canvas_export_image") return { call: { name: "canvas_export_image", args: {} } };
    return { text: `Exported the map to \`${safeJson(last.output).path}\`.` };
  }
  return { text: `Echo: ${user}` };
}

const sse = (res, events) => { res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }); for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`); res.end(); };
const json = (res, code, obj) => { res.writeHead(code, { ...cors, "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

function responses(body, res) {
  const d = decide(parse(body));
  const rid = id("resp");
  const output = d.text
    ? [{ type: "message", id: id("msg"), role: "assistant", status: "completed", content: [{ type: "output_text", text: d.text, annotations: [] }] }]
    : [{ type: "function_call", id: id("fc"), call_id: id("call"), name: d.call.name, arguments: JSON.stringify(d.call.args), status: "completed" }];
  const response = { id: rid, object: "response", status: "completed", model: body.model, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  if (!body.stream) return json(res, 200, response);
  const events = [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }];
  for (const item of output) {
    events.push({ type: "response.output_item.added", output_index: 0, item: item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] } });
    if (item.type === "message") {
      const text = item.content[0].text;
      for (const piece of text.match(/.{1,7}/gs) || []) events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: piece });
      events.push({ type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text });
    } else {
      events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index: 0, item });
  }
  events.push({ type: "response.completed", response });
  sse(res, events);
}

function chat(body, res) {
  const d = decide(parse(body));
  const cid = id("chatcmpl");
  const message = d.text ? { role: "assistant", content: d.text } : { role: "assistant", content: null, tool_calls: [{ id: id("call"), type: "function", function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }] };
  const finish = d.text ? "stop" : "tool_calls";
  if (!body.stream) return json(res, 200, { id: cid, object: "chat.completion", model: body.model, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
  res.writeHead(200, { ...cors, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: cid, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  chunk({ role: "assistant" });
  if (d.text) for (const piece of d.text.match(/.{1,7}/gs) || []) chunk({ content: piece });
  else { const tc = message.tool_calls[0]; chunk({ tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] }); chunk({ tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] }); }
  chunk({}, finish);
  res.write("data: [DONE]\n\n"); res.end();
}

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const chunks = []; for await (const c of req) chunks.push(c);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return json(res, 400, { error: { message: "bad json" } }); }
  console.error(`[mock-llm] ${req.method} ${req.url} stream=${!!body.stream} items=${(body.input || body.messages || []).length}`);
  if (req.url.endsWith("/responses")) return responses(body, res);
  if (req.url.endsWith("/chat/completions")) return chat(body, res);
  if (req.url.endsWith("/models")) return json(res, 200, { data: [{ id: "mock-model" }] });
  json(res, 404, { error: { message: `no route ${req.url}` } });
}).listen(PORT, "127.0.0.1", () => console.error(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1`));
