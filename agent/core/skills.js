/**
 * skills.js — the extension unit of the agent (docs/05 §5).
 *
 * A skill is an ES module (or a JSON file for prompt-only packs) that exports
 *   export default {
 *     name, description,
 *     instructions: '…markdown appended to the system prompt while the skill is enabled…',
 *     commands: [{ name: 'import', description, prompt: 'Import … ' }],      // "/import" in the composer
 *     suggestions: ['Import https://… and style it'],                        // chips shown in an empty chat
 *     tools: [{ name, description, parameters, confirm?, async run(args, ctx) { … } }],
 *   }
 * or a function (ctx) => that object. Tools receive ctx = { host, call, python, fetch, config, log } — everything a
 * skill needs to compose QGIS tools (ctx.call('layers_add', …)), run PyQGIS (ctx.python.run(code)) or reach internal
 * HTTP services (ctx.fetch, proxy-aware).
 *
 * Skills come from the preset (agent.skills, maintained by the organisation) and from the user (settings → add URL).
 */

export async function loadSkill(url, ctx) {
  const abs = new URL(url, ctx.baseUrl || location.href).href;
  let def;
  if (/\.json(\?|$)/i.test(abs)) def = await (await fetch(abs, { cache: 'no-cache' })).json();
  else {
    const mod = await import(/* webpackIgnore: true */ abs + (abs.includes('?') ? '&' : '?') + 'v=' + Date.now());
    def = mod.default || mod.skill || mod;
  }
  if (typeof def === 'function') def = await def(ctx);
  return normalise(def, abs);
}

export function normalise(def, url = '') {
  if (!def || typeof def !== 'object') throw new Error(`skill ${url} does not export an object`);
  const id = def.id || (url ? decodeURIComponent(url.split('/').pop().replace(/\.(m?js|json)(\?.*)?$/i, '')) : def.name) || 'skill';
  return {
    id, url,
    name: def.name || id,
    description: def.description || '',
    instructions: def.instructions || '',
    commands: (def.commands || []).map((c) => ({ name: String(c.name).replace(/^\//, ''), description: c.description || '', prompt: c.prompt || '' })),
    suggestions: def.suggestions || [],
    tools: (def.tools || []).filter((t) => t && t.name && typeof t.run === 'function'),
    enabled: true,
  };
}

/** The context object skills get */
export function skillContext({ host, config, log, baseUrl }) {
  const origin = host.origin || location.origin;
  return {
    host, config, log, baseUrl,
    call: (name, args) => host.call(name, args),
    python: { run: async (code) => (await host.call('python_run', { code })).result },
    /** fetch that falls back to the same-origin /proxy for servers without CORS */
    async fetch(url, init) {
      try { return await fetch(url, init); }
      catch (e) { if (!origin) throw e; return fetch(`${origin}/proxy?url=${encodeURIComponent(url)}`, init); }
    },
  };
}
