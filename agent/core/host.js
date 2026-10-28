/**
 * host.js — the only thing the agent knows about QGIS.
 *
 * A Host is "something that runs QGIS and speaks the tool contract" (docs/05-Web-Agent.md §2):
 *   host.tools()            → [{ name, description, inputSchema, source? }]   (MCP-style manifest)
 *   host.call(name, args)   → Promise<result>                                   (rejects with the tool's error)
 *   host.on(event, fn)      → unsubscribe                                       (QGIS events, may be a no-op)
 *   host.registerTool(...)  → adds a page tool so that MCP / ?ask= / other agents see it (may be a no-op)
 *
 * Two implementations: the page that runs QGIS (window.qgis from web/shell/qgis-shell.js) and a remote page reached
 * through scripts/serve.mjs (/agent/call), which makes the same agent usable from a separate browser tab or portal.
 * Nothing else in web/agent touches window.qgis, the Emscripten filesystem or C++.
 */

export const HOST_API = 1; // major version of the tool contract this agent was written against (qgis_version.bridgeApi)

export async function connectHost({ remote = null, timeoutMs = 30000 } = {}) {
  if (remote) return new RemoteHost(remote);
  const started = Date.now();
  while (!window.qgis) {
    if (Date.now() - started > timeoutMs) throw new Error('window.qgis is not available (is qgis-shell.js loaded?)');
    await new Promise((r) => setTimeout(r, 100));
  }
  return new LocalHost(window.qgis);
}

export class LocalHost {
  constructor(qgis) { this.qgis = qgis; this.kind = 'local'; }
  get ready() { return this.qgis.ready; }
  get preset() { return this.qgis.preset || window.qgisPreset || {}; }
  get presetReady() { return this.qgis.presetReady || Promise.resolve(this.preset); }
  get origin() { return location.origin; }
  call(name, args = {}) { return this.qgis.call(name, args); }
  tools() { return this.qgis.tools(); }
  on(event, fn) { return this.qgis.on(event, fn); }
  emit(event, payload) { this.qgis.emit?.(event, payload); }
  registerTool(name, def) { return this.qgis.registerTool ? this.qgis.registerTool(name, def) : false; }
  unregisterTool(name) { return this.qgis.unregisterTool ? this.qgis.unregisterTool(name) : false; }
  /** Compatibility check against the running QGIS build (docs/05 §6) */
  async checkApi() {
    const v = await this.call('qgis_version');
    return { ok: (v.bridgeApi || 1) === HOST_API, qgis: v.version, bridgeApi: v.bridgeApi || 1, expected: HOST_API };
  }
}

export class RemoteHost {
  /** @param base origin of a scripts/serve.mjs that has a QGIS page connected, e.g. http://127.0.0.1:8123 */
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
    this.kind = 'remote';
    this.ready = Promise.resolve();
    this.client = null; // a specific connected page (from /agent/clients), default: the most recent one
    this.presetData = null;
  }
  get preset() { return this.presetData || {}; }
  get origin() { return this.base; }
  async loadPreset(name = 'default') {
    try { this.presetData = await (await fetch(`${this.base}/presets/${name}.json`, { cache: 'no-cache' })).json(); } catch (e) { this.presetData = {}; }
    this.presetData.name = name; this.presetData.origin = this.base;
    return this.presetData;
  }
  async call(name, args = {}) {
    const res = await fetch(`${this.base}/agent/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: name, params: args, client: this.client }) });
    const body = await res.json();
    if (!body.ok) throw new Error(body.error || `remote call ${name} failed`);
    return body.result;
  }
  tools() { return this.call('tools/list', {}); }
  on() { return () => {}; } // no event stream for remote clients: the runtime polls `state` instead
  emit() {}
  registerTool() { return false; }
  unregisterTool() { return false; }
  async clients() { return (await fetch(`${this.base}/agent/clients`)).json(); }
  async checkApi() {
    const v = await this.call('qgis_version');
    return { ok: (v.bridgeApi || 1) === HOST_API, qgis: v.version, bridgeApi: v.bridgeApi || 1, expected: HOST_API };
  }
}
