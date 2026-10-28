/**
 * mcp.js — minimal MCP client (Streamable HTTP transport, JSON-RPC 2.0) for the internal data sources.
 *
 * A server is { name, url, proxy?, headers? }. proxy: true routes requests through <origin>/proxy?url= (scripts/serve.mjs)
 * for servers without CORS headers; 'auto' (default) tries direct first and falls back to the proxy.
 * Responses may be plain JSON or an SSE stream (text/event-stream); both are handled.
 */

export class McpServer {
  constructor(def, { origin = location.origin, clientInfo = { name: 'qgis-wasm-agent', version: '1.0' } } = {}) {
    this.name = def.name;
    this.url = def.url;
    this.headers = def.headers || {};
    this.proxy = def.proxy === undefined ? 'auto' : def.proxy;
    this.origin = origin;
    this.clientInfo = clientInfo;
    this.sessionId = null;
    this.tools = [];
    this.ready = false;
    this.error = '';
    this.nextId = 1;
  }

  endpoint(viaProxy) { return viaProxy ? `${this.origin}/proxy?url=${encodeURIComponent(this.url)}` : this.url; }

  async post(message, viaProxy) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const res = await fetch(this.endpoint(viaProxy), { method: 'POST', headers, body: JSON.stringify(message) });
    const sid = res.headers.get('Mcp-Session-Id'); if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const type = res.headers.get('Content-Type') || '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      let last = null;
      for (const chunk of text.split(/\n\n/)) {
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === message.id) return m; last = m; } catch (e) { /* keep-alive */ }
      }
      return last;
    }
    return res.json();
  }

  async rpc(method, params = {}) {
    const message = { jsonrpc: '2.0', id: this.nextId++, method, params };
    let reply;
    if (this.proxy === true) reply = await this.post(message, true);
    else {
      try { reply = await this.post(message, false); }
      catch (e) {
        if (this.proxy === 'auto' && this.origin) { reply = await this.post(message, true); this.proxy = true; }
        else throw e;
      }
    }
    if (reply && reply.error) throw new Error(`${this.name}: ${reply.error.message || JSON.stringify(reply.error)}`);
    return reply ? reply.result : null;
  }

  async notify(method, params = {}) {
    try { await this.post({ jsonrpc: '2.0', method, params }, this.proxy === true); } catch (e) { /* optional */ }
  }

  async connect() {
    this.ready = false; this.error = '';
    try {
      await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: this.clientInfo });
      await this.notify('notifications/initialized');
      const result = await this.rpc('tools/list');
      this.tools = (result && result.tools) || [];
      this.ready = true;
    } catch (e) {
      this.error = e.message || String(e);
      this.tools = [];
    }
    return this;
  }

  /** tools/call → { text, images: [{ data, mimeType }], structured, isError } */
  async callTool(name, args = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args || {} });
    const content = (result && result.content) || [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    const images = content.filter((c) => c.type === 'image' && c.data).map((c) => ({ data: c.data, mimeType: c.mimeType || 'image/png' }));
    const out = { text, images, isError: !!(result && result.isError) };
    if (result && result.structuredContent !== undefined) out.structured = result.structuredContent;
    if (out.isError) throw new Error(text || `${name} failed`);
    return out;
  }

  status() { return { name: this.name, url: this.url, ready: this.ready, tools: this.tools.length, error: this.error, proxy: this.proxy }; }
}
