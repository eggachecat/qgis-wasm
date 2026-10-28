/**
 * runtime.js — the agent loop, UI-agnostic. The panel (ui/panel.js), the `assistant_*` tools, ?ask= and tests all
 * drive the same AgentRuntime; swap the UI (e.g. for assistant-ui in a React portal) without touching this file.
 *
 *   const agent = await createAgent({ host, config, origin, baseUrl })
 *   agent.ask('Load the roads from the shared drive and buffer them by 100 m')   // resolves with the final answer
 *   agent.addEventListener('delta' | 'message' | 'tool.start' | 'tool.end' | 'confirm' | 'turn.start' | 'turn.end' | 'error' | 'status', …)
 *   agent.stop(); agent.reset(); agent.status(); agent.updateConfig({ model: '…' })
 */
import { ToolRegistry } from './tools.js';
import { McpServer } from './mcp.js';
import { createProvider } from './providers/index.js';
import { loadSkill, skillContext } from './skills.js';
import { saveUserConfig, loadConfig } from './config.js';

export const BUILTIN_SYSTEM_PROMPT = `You are the agent of QGIS Desktop running in a web browser (qgis-wasm). You operate this QGIS instance through tools: inspect the project (state, layers_list, layer_fields, layer_features), load data (layers_add with a path in the virtual filesystem or a URL, basemaps_use for configured basemaps, import_data when available), style and label layers (layer_set_style for quick colours / sizes / a label field; layer_style_set for categorized or graduated renderers, colour ramps, label fonts, buffers, placement and scale ranges; layer_style_get to read the current style; layer_style_qml for a complete QML style), rename / hide / scale-limit layers (layer_set_properties), select features (layer_select), zoom (layers_zoom_to, canvas_set_extent), run analyses (processing_list / processing_describe / processing_run), export images (canvas_export_image) and save or share projects (project_save to a /cloud/<mount>/ path or project_share).
Virtual filesystem: /cloud/<mount>/… is mounted object storage shared with the team, /home/web_user/… is the user's persistent home directory, /qgis/share/demo holds demo data. Browse with files_list. Internal catalogues are exposed as mcp__<server>__<tool> tools; their results (URLs or paths) can be opened with layers_add / import_data. The deployment's query data sources (listed as "sources" in the state below: OGC API Features endpoints, catalogues, GeoJSON APIs) are reached with sources_collections / sources_search / sources_load — when the user asks for data that is not on the map, search them before saying it is unavailable. view_link returns a link that reproduces the current view for a colleague (project_share first saves the project to cloud storage).
The section "Current QGIS state" below is refreshed before every request: the layers, the configured basemaps and the canvas extent are already there, so do not call state, layers_list, basemaps_list or canvas_extent just to look around. Every round trip to you costs the user seconds: when tool calls are independent (e.g. basemaps_use and canvas_set_extent, or several layers_add) issue them together in one response instead of one per turn, and skip verification calls unless the result matters for the next step.
Prefer calling tools over guessing, check processing_describe before processing_run, and finish with a short summary of what changed (layer names, feature counts). Paths in the virtual filesystem are not URLs: write them as plain text, never as links. Ask before destructive actions unless the user already asked for them. Answer in the user's language.`;

export class AgentRuntime extends EventTarget {
  constructor({ host, config, origin, baseUrl, log = console.log }) {
    super();
    this.host = host;
    this.config = config;
    this.origin = origin || host.origin || location.origin;
    this.baseUrl = baseUrl || new URL('./', location.href).href; // preset skill URLs are relative to the page
    this.log = log;
    this.registry = new ToolRegistry();
    this.registry.setPolicy(config.tools);
    this.provider = createProvider(config);
    this.mcpServers = [];
    this.skills = [];
    this.items = [];          // model transcript (user / assistant / tool_call / tool_result)
    this.messages = [];       // UI transcript, same order, richer
    this.busy = false;
    this.iteration = 0;
    this.lastAnswer = '';
    this.abort = null;
    this.confirmHandler = null; // async (tool, args) => boolean ; set by the UI
    this.stateSnapshot = null;
    this.hostToolsLoaded = false;
  }

  // ------------------------------------------------------------------ setup
  async init() {
    await this.host.ready;
    try { this.api = await this.host.checkApi(); if (!this.api.ok) this.log(`agent: QGIS bridge API ${this.api.bridgeApi} ≠ expected ${this.api.expected} — some tools may differ`); } catch (e) { this.api = { ok: true }; }
    await this.reloadHostTools();
    // MCP servers and skills load in the background; the panel shows their state
    this.connectMcp();
    this.loadSkills();
    this.hostEvents = this.host.on?.('layers.changed', () => { this.stateSnapshot = null; });
    return this;
  }

  async reloadHostTools() {
    try { await this.registry.addHost(this.host); this.hostToolsLoaded = true; } catch (e) { this.log(`agent: could not read the QGIS tool manifest: ${e.message}`, true); }
    this.emitStatus();
  }

  async connectMcp() {
    this.registry.removeSource('mcp');
    this.mcpServers = (this.config.mcpServers || []).filter((s) => s && s.url).map((s) => new McpServer(s, { origin: this.origin }));
    await Promise.all(this.mcpServers.map(async (s) => { await s.connect(); if (s.ready) this.registry.addMcp(s); else this.log(`agent: MCP ${s.name}: ${s.error}`, true); this.emitStatus(); }));
  }

  async loadSkills() {
    this.registry.removeSource('skill');
    this.skills = [];
    const ctx = skillContext({ host: this.host, config: this.config, log: this.log, baseUrl: this.baseUrl });
    for (const url of this.config.skills || []) {
      try {
        const skill = await loadSkill(url, ctx);
        skill.enabled = !(this.config.disabledSkills || []).includes(skill.id);
        this.skills.push(skill);
        if (skill.enabled) this.registry.addSkill(skill, ctx);
      } catch (e) { this.log(`agent: skill ${url} failed: ${e.message}`, true); this.skills.push({ id: url, name: url, url, error: e.message, enabled: false, tools: [], commands: [], suggestions: [] }); }
      this.emitStatus();
    }
  }

  /** Change configuration at runtime (settings view); persisted to the user layer unless persist=false */
  async updateConfig(partial, { persist = true } = {}) {
    if (persist) saveUserConfig(partial);
    const { config } = loadConfig(this.presetAgent || {});
    if (!persist) Object.assign(config, partial);
    this.config = config;
    this.registry.setPolicy(config.tools);
    this.provider = createProvider(config);
    await Promise.all([this.connectMcp(), this.loadSkills()]);
    this.emitStatus();
    return this.config;
  }

  // ------------------------------------------------------------------ status
  get configured() { return !!(this.provider && this.provider.configured); }

  status() {
    return {
      configured: this.configured, busy: this.busy, model: this.config.model, provider: this.config.provider, iteration: this.iteration,
      lastAnswer: this.lastAnswer, host: this.host.kind, api: this.api || null,
      mcpServers: this.mcpServers.map((s) => s.status()),
      skills: this.skills.map((s) => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled, tools: (s.tools || []).map((t) => t.name), commands: (s.commands || []).map((c) => c.name), error: s.error || '' })),
      tools: this.registry.size, toolsBySource: this.registry.summary(),
      transcript: this.transcript(),
    };
  }

  /** Flat transcript like the former C++ dock: [{role:'user'|'assistant'|'tool', text?, name?, arguments?, output?}] */
  transcript() {
    const out = [];
    for (const m of this.messages) {
      if (m.role === 'tool') out.push({ role: 'tool', name: m.name, arguments: m.args, output: typeof m.output === 'string' ? m.output.slice(0, 2000) : '', error: m.error || '' });
      else out.push({ role: m.role, text: m.text || '' });
    }
    return out;
  }

  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  emitStatus() { this.emit('status', this.status()); }

  commands() { return this.skills.filter((s) => s.enabled).flatMap((s) => s.commands.map((c) => ({ ...c, skill: s.name }))); }
  suggestions() { return [...(this.config.ui.suggestions || []), ...this.skills.filter((s) => s.enabled).flatMap((s) => s.suggestions)]; }

  // ------------------------------------------------------------------ prompt
  async buildSystem() {
    let system = this.config.systemPrompt || BUILTIN_SYSTEM_PROMPT;
    const skillTexts = this.skills.filter((s) => s.enabled && s.instructions).map((s) => `## Skill: ${s.name}\n${s.instructions.trim()}`);
    if (skillTexts.length) system += '\n\n' + skillTexts.join('\n\n');
    if (this.config.hints) system += `\n\n## Deployment notes\n${this.config.hints.trim()}`;
    if (this.config.instructions) system += `\n\n## Instructions from the user\n${this.config.instructions.trim()}`;
    if (this.config.context?.state) {
      const snapshot = await this.snapshot();
      if (snapshot) system += `\n\n## Current QGIS state (auto-updated before each request)\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\``;
    }
    return system;
  }

  async snapshot() {
    try {
      const opt = (tool) => this.registry.has(tool) ? this.host.call(tool, {}).catch(() => null) : Promise.resolve(null);
      const [st, basemaps, extent, sources] = await Promise.all([this.host.call('state'), opt('basemaps_list'), opt('canvas_extent'), opt('sources_list')]);
      const max = this.config.context?.maxLayers || 30;
      const layers = (st.layers || []).slice(0, max).map((l) => ({ id: l.id, name: l.name, type: l.type, geometry: l.geometryType, features: l.featureCount, crs: l.crs, visible: l.visible, selected: l.selectedCount }));
      const r4 = (v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v);
      const snap = { qgis: st.version, project: st.project, layers, moreLayers: Math.max(0, (st.layers || []).length - max) };
      if (Array.isArray(basemaps)) snap.basemaps = basemaps.map((b) => b.name); // names for basemaps_use
      if (Array.isArray(sources) && sources.length) snap.sources = sources.map((s) => ({ name: s.name, type: s.type, title: s.title })); // for sources_*
      if (extent && extent.xmin !== undefined) snap.canvas = { crs: extent.crs, xmin: r4(extent.xmin), ymin: r4(extent.ymin), xmax: r4(extent.xmax), ymax: r4(extent.ymax) };
      return snap;
    } catch (e) { return null; }
  }

  // ------------------------------------------------------------------ the loop
  /** Send a user message and let the model work until it answers. Resolves with the final text. */
  async ask(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return '';
    if (!this.configured) throw new Error('the agent is not configured (model / baseUrl): open the settings or set the preset\'s "agent" section');
    if (this.busy) throw new Error('the agent is busy');
    // "/command rest" → the skill's prompt + rest
    let userText = trimmed;
    const m = /^\/(\S+)\s*([\s\S]*)$/.exec(trimmed);
    if (m) { const cmd = this.commands().find((c) => c.name === m[1]); if (cmd) userText = `${cmd.prompt}${m[2]}`.trim(); }

    this.busy = true; this.iteration = 0; this.abort = new AbortController();
    this.pushMessage({ role: 'user', text: userText });
    this.items.push({ role: 'user', content: userText });
    this.emit('turn.start', { text: userText }); this.emitStatus();
    let finalText = '';
    try {
      for (this.iteration = 1; this.iteration <= this.config.maxIterations; this.iteration++) {
        if (this.abort.signal.aborted) break;
        const assistant = this.pushMessage({ role: 'assistant', text: '', streaming: true });
        const calls = [];
        let text = '';
        try {
          for await (const ev of this.provider.stream({ system: await this.buildSystem(), items: this.items, tools: this.registry.definitions(), signal: this.abort.signal })) {
            if (ev.type === 'text') { text += ev.delta; assistant.text = text; this.emit('delta', { message: assistant, delta: ev.delta }); }
            else if (ev.type === 'tool_call') calls.push(ev);
            else if (ev.type === 'done') { if (ev.text && !text) { text = ev.text; assistant.text = text; } assistant.usage = ev.usage; }
          }
        } finally { assistant.streaming = false; }
        if (!text) this.removeMessage(assistant); else { this.items.push({ role: 'assistant', content: text }); this.emit('message', { message: assistant }); }
        if (!calls.length) { finalText = text; break; }
        for (const call of calls) {
          if (this.abort.signal.aborted) break;
          await this.runTool(call);
        }
        if (this.fatal) { finalText = `QGIS crashed in this tab — reload the page and ask again. (${this.fatal})`; this.pushMessage({ role: 'assistant', text: finalText, error: true }); break; }
        if (this.iteration === this.config.maxIterations) finalText = text || '(stopped: iteration limit reached)';
      }
      if (this.abort.signal.aborted && !finalText) finalText = '(stopped)';
    } catch (e) {
      const msg = e.name === 'AbortError' ? '(stopped)' : `Error: ${e.message || e}`;
      this.pushMessage({ role: 'assistant', text: msg, error: e.name !== 'AbortError' });
      this.emit('error', { error: e });
      finalText = msg;
    } finally {
      this.busy = false; this.abort = null; this.lastAnswer = finalText;
      this.emit('turn.end', { text: finalText }); this.emitStatus();
      this.host.emit?.('assistant.finished', { text: finalText });
    }
    return finalText;
  }

  async runTool(call) {
    let args = {};
    try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch (e) { args = { _raw: call.arguments }; }
    const msg = this.pushMessage({ role: 'tool', name: call.name, args, callId: call.callId, running: true, started: Date.now() });
    this.emit('tool.start', { message: msg });
    this.host.emit?.('assistant.tool', { name: call.name, arguments: args });
    let output, error = '';
    try {
      const tool = this.registry.get(call.name);
      if (!tool) throw new Error(`unknown tool ${call.name}`);
      if (!this.registry.isAllowed(call.name)) throw new Error(`tool ${call.name} is not allowed by the deployment policy`);
      if (this.registry.needsConfirm(call.name) && this.confirmHandler) {
        msg.awaitingConfirm = true; this.emit('confirm', { message: msg });
        const ok = await this.confirmHandler(call.name, args, msg);
        msg.awaitingConfirm = false;
        if (!ok) throw new Error(`the user declined to run ${call.name}`);
      }
      const result = await withTimeout(tool.run(args), this.config.toolTimeoutMs || 180000, call.name);
      msg.result = result;
      msg.images = await this.collectImages(result);
      output = typeof result === 'string' ? result : JSON.stringify(result === undefined ? { ok: true } : result);
    } catch (e) {
      error = e.message || String(e);
      output = `Error: ${error}`;
      if (/no longer usable in this tab/.test(error)) this.fatal = error; // QGIS crashed (qgis-shell.js): the turn ends after this result
    }
    const max = this.config.maxToolOutputChars || 24000;
    if (output.length > max) output = output.slice(0, max) + `\n…[truncated ${output.length - max} chars]`;
    msg.output = output; msg.error = error; msg.running = false; msg.ms = Date.now() - msg.started;
    this.items.push({ type: 'tool_call', callId: call.callId, name: call.name, arguments: call.arguments || '{}' });
    this.items.push({ type: 'tool_result', callId: call.callId, output });
    this.emit('tool.end', { message: msg });
    return msg;
  }

  /** Pictures a tool produced (exported map images, MCP image blocks) for the panel */
  async collectImages(result) {
    const images = [];
    try {
      if (result && Array.isArray(result.images)) for (const im of result.images) images.push(`data:${im.mimeType || 'image/png'};base64,${im.data}`);
      const path = result && typeof result === 'object' && typeof result.path === 'string' && /\.(png|jpe?g|webp)$/i.test(result.path) ? result.path : null;
      if (path && this.registry.has('file_base64')) { const f = await this.host.call('file_base64', { path }); images.push(`data:${f.mimeType};base64,${f.base64}`); }
    } catch (e) { /* optional */ }
    return images;
  }

  stop() { if (this.abort) this.abort.abort(); }

  reset() {
    this.stop();
    this.items = []; this.messages = []; this.lastAnswer = ''; this.iteration = 0;
    this.emit('reset'); this.emitStatus();
  }

  pushMessage(m) { m.id = m.id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; this.messages.push(m); this.emit('message.added', { message: m }); return m; }
  removeMessage(m) { const i = this.messages.indexOf(m); if (i >= 0) { this.messages.splice(i, 1); this.emit('message.removed', { message: m }); } }
}

function withTimeout(promise, ms, name) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${name} timed out after ${ms / 1000}s`)), ms); })]).finally(() => clearTimeout(t));
}

/** Build a runtime from a host + preset "agent" section (+ user overrides) */
export async function createAgent({ host, presetAgent, origin, baseUrl, log }) {
  const { config } = loadConfig(presetAgent || {});
  const agent = new AgentRuntime({ host, config, origin, baseUrl, log });
  agent.presetAgent = presetAgent || {};
  return agent.init();
}
