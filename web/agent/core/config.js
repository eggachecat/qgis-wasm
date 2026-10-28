/**
 * config.js — three layers of configuration, merged in this order:
 *   1. DEFAULTS (here)
 *   2. the deployment preset's "agent" section (web/shell/presets/<name>.json, maintained by the organisation)
 *   3. the user's own overrides (localStorage, edited in the panel's settings view)
 *
 * Users cannot remove what the preset provides (skills, MCP servers), they add to it and tune model / prompt / policy.
 */

export const STORAGE_KEY = 'qgis-wasm.agent';

export const DEFAULTS = Object.freeze({
  provider: 'openai-responses',      // core/providers/<id>.js
  baseUrl: '',                        // e.g. https://api.openai.com/v1 or your gateway's OpenAI-compatible base URL
  apiKey: '',
  model: '',
  systemPrompt: '',                   // deployment prompt; empty → the built-in one (core/runtime.js)
  hints: '',                          // deployment notes appended to the prompt: places, how to use the organisation's data sources
  instructions: '',                   // the user's own additions to the prompt
  mcpServers: [],                     // [{ name, url, proxy?: boolean|'auto', headers?: {} }]
  skills: [],                         // URLs of skill modules (relative to the page) or JSON prompt packs
  tools: {
    allow: [],                        // glob patterns; empty = everything
    deny: [],                         // glob patterns, e.g. "settings_*"
    confirm: [],                      // glob patterns of tools that wait for Allow/Deny; empty = run everything (a preset may list e.g. 'project_save')
  },
  context: { state: true, maxLayers: 30 }, // inject a compact QGIS state snapshot into every request
  maxIterations: 24,
  maxToolOutputChars: 24000,
  maxOutputTokens: 4096,
  stream: true,
  ui: { openOnStart: false, layout: 'float', width: 420, height: null, title: 'QGIS Agent', suggestions: [] }, // layout: 'float' (card over the map) | 'dock' (sidebar, QGIS makes room); height null = full height with equal margins
});

function userOverrides() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch (e) { return {}; }
}

/** Resolved configuration + the raw user layer (so the settings view can show what the user changed). */
export function loadConfig(presetAgent = {}) {
  const user = userOverrides();
  const config = {
    ...DEFAULTS,
    ...stripUndefined(presetAgent),
    tools: { ...DEFAULTS.tools, ...(presetAgent.tools || {}) },
    context: { ...DEFAULTS.context, ...(presetAgent.context || {}) },
    ui: { ...DEFAULTS.ui, ...(presetAgent.ui || {}) },
  };
  for (const k of ['provider', 'baseUrl', 'apiKey', 'model', 'instructions', 'maxIterations', 'stream']) if (user[k] !== undefined && user[k] !== '') config[k] = user[k];
  config.mcpServers = [...(config.mcpServers || []), ...(user.mcpServersExtra || [])];
  config.skills = [...(config.skills || []), ...(user.skillsExtra || [])];
  config.disabledSkills = user.disabledSkills || [];
  if (user.toolsConfirm) config.tools.confirm = user.toolsConfirm;
  if (user.toolsDeny) config.tools.deny = user.toolsDeny;
  config.ui = { ...config.ui, ...(user.ui || {}) };
  return { config, user, preset: presetAgent };
}

export function saveUserConfig(partial) {
  const next = { ...userOverrides(), ...partial };
  for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === null) delete next[k];
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function resetUserConfig() { localStorage.removeItem(STORAGE_KEY); }

function stripUndefined(o) { const r = {}; for (const [k, v] of Object.entries(o || {})) if (v !== undefined) r[k] = v; return r; }
