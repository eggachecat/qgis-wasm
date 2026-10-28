#!/usr/bin/env node
/**
 * stdio ↔ HTTP shim for MCP clients that only speak stdio (e.g. Claude Desktop):
 * forwards each JSON-RPC message from stdin to the qgis-wasm server's /mcp endpoint and writes the reply to stdout.
 *
 *   node scripts/mcp-stdio.mjs [http://127.0.0.1:8123/mcp]
 *
 * Claude Code can use the HTTP endpoint directly:  claude mcp add --transport http qgis http://127.0.0.1:8123/mcp
 */
import readline from "node:readline";

const url = process.argv[2] || process.env.QGIS_WASM_MCP_URL || "http://127.0.0.1:8123/mcp";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionId = null;

rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let message;
  try { message = JSON.parse(line); } catch (e) { return; }
  try {
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    const res = await fetch(url, { method: "POST", headers, body: line });
    sessionId = res.headers.get("mcp-session-id") || sessionId;
    if (res.status === 202 || message.id === undefined) return; // notification
    const text = await res.text();
    process.stdout.write(text.trim() + "\n");
  } catch (e) {
    if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `qgis-wasm server unreachable at ${url}: ${e.message}` } }) + "\n");
  }
});
