/**
 * tools.js — one registry for every tool the model may call, whatever its origin:
 *   source "qgis"   : the C++ bridge of the running QGIS (discovered at runtime from tools_list → no agent change when QGIS gains tools)
 *   source "shell"  : page tools of web/shell (project_share, mounts, python_run, …)
 *   source "mcp"    : tools of an MCP server, named mcp__<server>__<tool>
 *   source "skill"  : tools contributed by a skill module (web/agent/skills, or user-added URLs)
 * plus the policy (allow / deny / confirm globs) that decides what the model may run without asking.
 */

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.policy = { allow: [], deny: [], confirm: [] };
  }

  /** @param tool { name, description, parameters (JSON schema), source, run(args, ctx) → any, confirm?: boolean } */
  add(tool) {
    if (!tool || !tool.name || typeof tool.run !== 'function') throw new Error('tool needs name and run()');
    this.tools.set(tool.name, { parameters: { type: 'object', properties: {} }, source: 'skill', description: '', ...tool });
    return tool.name;
  }
  remove(name) { return this.tools.delete(name); }
  removeSource(source, owner = null) {
    for (const [name, t] of [...this.tools]) if (t.source === source && (owner === null || t.owner === owner)) this.tools.delete(name);
  }
  get(name) { return this.tools.get(name); }
  has(name) { return this.tools.has(name); }
  get size() { return this.tools.size; }

  setPolicy(policy = {}) { this.policy = { allow: policy.allow || [], deny: policy.deny || [], confirm: policy.confirm || [] }; }
  isAllowed(name) {
    if (this.policy.deny.some((g) => glob(g, name))) return false;
    if (this.policy.allow.length && !this.policy.allow.some((g) => glob(g, name))) return false;
    return true;
  }
  needsConfirm(name) { const t = this.tools.get(name); return !!(t && t.confirm) || this.policy.confirm.some((g) => glob(g, name)); }

  /** Enabled tools (policy applied) */
  list() { return [...this.tools.values()].filter((t) => this.isAllowed(t.name)); }
  /** Provider-neutral function definitions */
  definitions() { return this.list().map((t) => ({ name: t.name, description: t.description || '', parameters: normaliseSchema(t.parameters) })); }
  summary() {
    const by = {};
    for (const t of this.list()) by[t.source] = (by[t.source] || 0) + 1;
    return by;
  }

  /** Every tool of the host (QGIS bridge + page tools); replaces the previous host tools. */
  async addHost(host) {
    this.removeSource('qgis'); this.removeSource('shell');
    const manifest = await host.tools();
    for (const t of manifest) {
      if (t.name === 'tools_list' || t.name.startsWith('assistant_')) continue; // the model has the manifest already / talking to itself
      this.add({ name: t.name, description: t.description, parameters: t.inputSchema, source: t.source || 'qgis', run: (args) => host.call(t.name, args) });
    }
    return manifest.length;
  }

  /** Tools of a connected MCP server (core/mcp.js) */
  addMcp(server) {
    this.removeSource('mcp', server.name);
    for (const t of server.tools || []) {
      const name = `mcp__${sanitize(server.name)}__${sanitize(t.name)}`;
      this.add({ name, owner: server.name, description: `[${server.name}] ${t.description || ''}`, parameters: t.inputSchema, source: 'mcp', run: (args) => server.callTool(t.name, args) });
    }
  }

  /** Tools of a skill (core/skills.js); ctx is what skill tools receive as their second argument */
  addSkill(skill, ctx) {
    this.removeSource('skill', skill.id);
    for (const t of skill.tools || []) {
      this.add({ name: t.name, owner: skill.id, description: t.description, parameters: t.parameters, confirm: !!t.confirm, source: 'skill', run: (args) => t.run(args || {}, ctx) });
    }
  }
}

export function glob(pattern, name) {
  if (pattern === name) return true;
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(name);
}

export function sanitize(name) { return String(name).replace(/[^A-Za-z0-9_-]/g, '_'); }

export function normaliseSchema(schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : { type: 'object', properties: {} };
  if (!s.type) s.type = 'object';
  if (s.type === 'object' && !s.properties) s.properties = {};
  return s;
}
