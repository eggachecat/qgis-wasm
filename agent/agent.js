/**
 * agent.js — entry point of the web agent (docs/05-Web-Agent.md).
 *
 * Loaded by index.html as a module next to the QGIS shell, or by agent.html as a standalone page that drives a QGIS
 * running elsewhere (?qgis=<server origin>). Everything it needs from QGIS goes through core/host.js.
 *
 *   window.qgisAgent                     the AgentRuntime (ask / stop / reset / status / updateConfig / registry)
 *   window.qgisAgentPanel                the panel (open / close / toggle / setLayout — delegated to the workspace in the page)
 *   tools assistant_ask / assistant_status / assistant_reset   registered on the host for ?ask=, MCP and scripts
 */
import { connectHost } from './core/host.js';
import { createAgent } from './core/runtime.js';
import { mountPanel } from './ui/panel.js';

const params = new URLSearchParams(location.search);
const log = (m, err) => (err ? console.error : console.log)(m);

async function boot() {
  const remote = params.get('qgis');
  const host = await connectHost({ remote });
  if (remote) await host.loadPreset(params.get('preset') || 'default');
  else await host.presetReady; // the shell reads presets/<name>.json asynchronously; the module must not boot before it
  const preset = host.preset || {};
  if (remote && params.get('client')) host.client = params.get('client'); // drive one specific connected QGIS page
  // skill URLs in the preset are relative to the QGIS page (e.g. "agent/skills/import-wizard.js")
  const baseUrl = remote ? `${remote.replace(/\/+$/, '')}/` : new URL('./', location.href).href;
  const agent = await createAgent({ host, presetAgent: preset.agent || {}, origin: remote || location.origin, baseUrl, log });
  window.qgisAgent = agent;

  // the same three tools the former C++ dock offered, so ?ask=, the MCP server and scripts keep working
  const schema = (props = {}, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
  host.registerTool('assistant_ask', { description: 'Send a message to the web agent of this QGIS page and let it work (tools, MCP, skills); poll assistant_status for the result.', inputSchema: schema({ text: { type: 'string' } }, ['text']), source: 'agent', run: async ({ text }) => { agent.ask(text).catch(() => {}); return { accepted: true }; } });
  host.registerTool('assistant_status', { description: 'Status and transcript of the web agent (configured, busy, model, mcpServers, skills, transcript, lastAnswer).', inputSchema: schema(), source: 'agent', run: async () => agent.status() });
  host.registerTool('assistant_reset', { description: 'Clear the web agent conversation.', inputSchema: schema(), source: 'agent', run: async () => { agent.reset(); return { ok: true }; } });

  // in the page the agent renders into the workspace panel (web/shell/workspace.js); agent.html is the whole page
  const panel = mountPanel(agent, { screen: remote ? null : document.getElementById('screen'), standalone: !!remote, workspace: remote ? null : window.qgisWorkspace || null });
  window.qgisAgentPanel = panel;
  if (remote) document.title = `${preset.title || 'QGIS'} — agent`;
  log(`agent: ${agent.configured ? agent.config.model : 'not configured'}, ${agent.registry.size} tools, host ${host.kind}`);
  return agent;
}

boot().catch((e) => log(`agent failed to start: ${e.message}`, true));
