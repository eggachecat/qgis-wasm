# Web Agent: boundaries, extension and upgrades

> Chinese original: [05-Web-Agent.md](../05-Web-Agent.md)

The agent does not live inside QGIS. It is an independent module on the page (`web/agent/`) that drives the QGIS in the browser through **one contract**. The split serves three purposes: features are easy to extend (skills, models and data sources are all pluggable), users can customise it easily (three configuration layers, and the user layer lives only in their own browser), and QGIS upgrades are cheap (the QGIS side has only a small, stable tool surface; the agent does not change a single line).

```
┌──────────────────────────────────────── Browser page ────────────────────────────────────────┐
│ web/agent  (Web Agent)                  web/shell  (host)                   QGIS (wasm)      │
│ ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────┐      ┌──────────────┐ │
│ │ ui/panel.js    │  │ skills/*       │  │ window.qgis                │      │ QgsWasm-     │ │
│ │ (FAB + panel)  │  │ (skill = tools │  │ .tools() .call()           │ ───▶ │ Bridge       │ │
│ └───────┬────────┘  │  + prompts)    │  │ .on() .registerTool        │ ◀─── │ ≈50 tools    │ │
│         ▼           └───────┬────────┘  │ page tools: share / mount  │      │ (C++, public │ │
│ ┌────────────────┐          ▼           │ Python / upload / download │      │  QGIS API)   │ │
│ │ core/runtime   │◀─ core/tools (registry + policy) ◀─ core/host.js ─┘      └──────────────┘ │
│ │ (model loop)   │◀─ core/mcp   (internal data sources)                                      │
│ └───────┬────────┘◀─ core/providers (Responses / Chat Completions / …)                       │
│         └─ core/config (DEFAULTS ← preset.agent ← user localStorage)                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
   agent.html?qgis=<server>  ──▶ scripts/serve.mjs /agent/call ──▶ QGIS in another tab (remote host)
```

There is only one dependency direction: **agent → host contract ← QGIS**. No code in `web/agent` touches `window.qgisInstance`, the Emscripten filesystem or C++; no code in QGIS knows that an agent exists.

## 1. The three layers and their responsibilities

| Layer | Location | Responsibility | Rate of change |
|---|---|---|---|
| **QGIS kernel** | `external/QGIS/src/app/qgswasm*.{h,cpp}` + 5 one-line hooks | Exposes QGIS capabilities as tools with a JSON schema (`QgsWasmBridge`), applies presets, startup hooks | Recompiled with each QGIS upgrade; tools are only added, never changed |
| **Host (shell)** | `web/shell/` | Loads QGIS, mounts cloud storage, loads presets / plugins / Python, provides `window.qgis` (QGIS tools + page tools), the outward SSE/MCP transport; the URL scheme and sharing (`link.js`) and query data sources (`sources.js`) are also page tools of this layer ([docs/06](06-architecture.md)) | Low |
| **Web Agent** | `web/agent/` | Model loop, tool registry and policy, MCP client, skills, configuration, UI | High: this is where product iteration happens; a change takes effect on refresh, without a compile |

Business capabilities such as "import" and "analyse" live in the **agent layer** (skills) rather than being added to QGIS: a skill can combine several QGIS tools, call PyQGIS and reach internal HTTP services, and publishing it means dropping a single JS file. Tools on the QGIS side stay generic (`layers_add`, not `add_geojson_from_s3`).

## 2. The host contract (the only thing the agent depends on)

`core/host.js` defines what QGIS looks like to the agent:

```js
host.tools()                 // → [{ name, description, inputSchema, source }]   MCP-style manifest, discovered at runtime
host.call(name, args)        // → Promise<result>                                 rejects on failure, message is the tool error
host.on(event, fn)           // QGIS events (layers.changed, selection.changed …), a remote host may be a no-op
await host.presetReady       // presets finished loading (the shell layer fetches presets/<name>.json asynchronously; the agent waits for this before reading preset.agent instead of racing it)
host.registerTool(name, def) // registers a page tool with the host (this is how assistant_* is registered), so MCP / ?ask= / other agents can see it too
host.checkApi()              // compares qgis_version.bridgeApi with the major version the agent expects
```

- **Tool sources** are labelled with `source`: `qgis` (C++ Bridge), `shell` (page tools: `project_share`, `view_link`, `mounts_*`, `sources_list / sources_search / sources_load`, `download`, `upload`, `python_run`…), `agent`, `mcp` (`mcp__<server>__<tool>`), `skill`. The tool cards in the panel show this label. The state snapshot carries the `sources` list, and the prompt requires the model to search the data sources first when "the data is not on the map".
- **Discovery instead of hard-coding**: the agent reads the manifest at startup, so a new QGIS tool needs no agent change; conversely, if a tool a skill depends on is missing, only that skill tool fails and everything else keeps working.
- **Versioning**: `qgis_version` returns `bridgeApi` (currently 1). Bump the major version when you change a tool's parameters or result in a breaking way, and update the agent's `HOST_API` with it; adding tools or optional parameters does not bump it.
- **Two kinds of host**: `LocalHost` (`window.qgis` of the same page) and `RemoteHost` (`POST <server>/agent/call`, forwarded by `scripts/serve.mjs` to a connected QGIS page chosen with `?client=`). The same agent code can therefore be embedded in the QGIS page, run as a standalone page `agent/agent.html?qgis=http://host:8123`, or be embedded in another portal.

## 3. The QGIS side: minimal changes and the upgrade flow

### 3.1 What is changed today

| File | Nature | Contents |
|---|---|---|
| `src/app/qgswasmapp.{h,cpp}` | New | 5 hooks (`beforeApplication` / `applyDeploymentDefaults` / `beforeMainWindow` / `showMainWindow` / `afterInitialization`) + JS entry points `qgis_wasm_open/ready/call` |
| `src/app/qgswasmbridge.{h,cpp}` | New | the tool registry and ≈50 tools, all built on public QGIS API (`QgsProject`, `QgsMapLayer`, `QgsProcessingRegistry`…); the few calls into `QgisApp` private slots go through `QMetaObject::invokeMethod` |
| `src/app/qgswasmpreset.{h,cpp}` | New | preset → settings / basemap / favourites / file dialog bookmarks |
| `src/app/qgswasmstaticplugins.{h,cpp}` | New | table of statically linked C++ plugins |
| `src/app/main.cpp` | 30 lines changed | only hooks such as `#ifdef __EMSCRIPTEN__ QgsWasmApp::xxx(); #endif` plus two platform `#if`s |
| Other upstream files | Small changes | `qgspluginregistry.cpp` / `qgspluginmanager.cpp` (static plugin branch), `qgsnetworkaccessmanager.cpp` (no User-Agent), `qgsuserprofile.cpp` (do not switch ini), each plugin's CMake (static), `qgisplugin.h` (symbol prefix), top-level CMake |

All changes are in `patches/qgis-wasm.patch` (generated by `scripts/export-patches.sh`). The agent-related C++ is now zero: the original Assistant dock panel (Responses API + MCP client, ≈600 lines of C++) was deleted and all of its functionality lives in `web/agent`.

### 3.2 Upgrading QGIS

1. `cd external/QGIS && git fetch && git checkout <new tag>`, then `scripts/apply-patches.sh`. Conflicts almost always appear only at the hook sites in `main.cpp` and in the plugin CMake files; `qgswasm*.cpp` are independent files, so if an upstream API has changed, fix it there.
2. `scripts/build-qgis.sh all`.
3. Run the contract tests: `python3 tests/e2e/smoke.py`, `python3 tests/e2e/features.py`, `python3 tests/e2e/agent.py`. agent.py uses a scripted mock model (`tests/mock-llm.mjs`) to walk through "discover tools → call → skill → MCP → approval → both providers → remote host" without a real model; `features.py --llm` then verifies once more against a real gateway.
4. If a tool's behaviour has changed: change the Bridge so that the result structure is kept, or bump `bridgeApi` and update `HOST_API` in `core/host.js` together with the affected skills.

### 3.3 Rules for adding a tool to QGIS

Generic, with no business meaning; parameters and results are JSON (write the schema in full, write the description for the model to read); use public API only; run inside the Qt event loop (JS→C++ only queues, see [docs/02](02-runtime-and-debugging.md) §2.1); give large results a `limit`. No agent change is needed afterwards.

## 4. Inside the agent

### 4.1 The model loop (`core/runtime.js`)

```
ask(text)
  ├─ "/command rest" → the skill command's prompt + rest
  ├─ system = built-in/preset prompt + instructions of enabled skills + user instructions + current QGIS state snapshot (refreshed every turn)
  └─ loop ≤ maxIterations:
       provider.stream({system, items, tools})  → streamed text (shown character by character in the panel) / tool calls
       per tool call: policy check (deny / allow) → if confirmation is needed, wait for Allow/Deny in the panel (the approval bar is pinned above the input box and does not scroll away with the conversation) → execute (180 s timeout) → result JSON (truncated above 24k characters)
       no tool calls → finish, lastAnswer
```

Events: `turn.start` `message.added` `delta` `message` `tool.start` `confirm` `tool.end` `turn.end` `error` `status` `reset`. Methods: `ask` `stop` `reset` `status` `updateConfig` `commands` `suggestions`, plus `registry` (you can call `registry.get('import_data').run({...})` directly, which is what the tests do).

### 4.2 Tool registry and policy (`core/tools.js`)

One table holds the tools from every source; policy comes from configuration: `tools.allow` (whitelist globs, empty = everything), `tools.deny`, `tools.confirm` (the user must click Allow before execution; empty by default = everything runs directly, a preset can list e.g. `project_save`, and the user can add to it in settings). A skill tool can carry its own `confirm: true`. With no UI (a bare MCP call to `assistant_ask`) it does not hang: with no confirmation handler the call is allowed.

### 4.3 Model providers (`core/providers/`)

The interface is just an async generator: `for await (ev of provider.stream({system, items, tools, signal}))` yields `{type:'text', delta}`, `{type:'tool_call', callId, name, arguments}`, `{type:'done', text, usage}`. `openai-responses` (the gateway default, streaming + non-streaming fallback) and `openai-chat` (Chat Completions: OpenAI-compatible gateways, Ollama, vLLM) already exist. Adding a provider = one file in `providers/` + one line in `index.js` (or `registerProvider()` at runtime).

### 4.4 MCP client (`core/mcp.js`)

Streamable HTTP: `initialize` → `notifications/initialized` → `tools/list`, calls go through `tools/call`; supports JSON and SSE responses, `Mcp-Session-Id`, custom headers; `proxy: 'auto'` connects directly first and falls back to the same-origin `/proxy?url=` on a CORS failure. `image` content blocks in results are shown in the panel. Connecting an internal data source = one line in the preset's `agent.mcpServers`, or the user adds it in settings.

### 4.5 The three configuration layers (`core/config.js`)

`DEFAULTS` ← the preset's `agent` section (maintained by the organisation: model, key, system prompt, MCP servers, skills, policy, panel options) ← the user layer (`localStorage["qgis-wasm.agent"]`: model/URL/key overrides, own instructions, added MCP servers and skills, disabled skills, policy overrides, panel switches). The user **can only add**; they cannot take away what the preset gives. "Reset to preset" clears the user layer.

```json
"agent": {
  "provider": "openai-responses", "baseUrl": "https://api.example.com/v1", "model": "…", "apiKey": "…",
  "systemPrompt": "(optional, replaces the built-in prompt)",
  "mcpServers": [{ "name": "catalog", "url": "https://geo-catalog.internal/mcp", "proxy": "auto" }],
  "skills": ["agent/skills/import-wizard.js", "agent/skills/analysis.js", "https://cdn.internal/qgis-skills/stac.js"],
  "tools": { "confirm": ["project_save", "layers_remove"], "deny": ["settings_*"] },
  "hints": "Deployment notes appended to the system prompt: coordinates / bbox of frequently used places, how to use the organisation's data sources (how collections and filters are written), the two meanings of sharing…",
  "ui": { "title": "QGIS Agent", "suggestions": ["A starter task that fetches data for a place from a data source and fuses it with the basemap / analysis…"] }   // the panel's position / layout / whether it opens on startup belong to the shell layer: top-level "ui" in the preset: { "openOnStart", "layout", "width", "height", "title" } ([docs/06](06-architecture.md) workspace)
}
```

## 5. Extension points

### 5.1 Skills — the unit of publication for business capabilities

An ES module (or a JSON file with only prompts) placed at any URL that `import()` can reach (a same-origin directory, an internal CDN, an object store with CORS enabled):

```js
export default {
  name: 'STAC', description: 'Search the internal STAC catalogue',
  instructions: `## STAC\n- Use stac_search for imagery; pass the asset href to import_data.`,
  commands: [{ name: 'stac', description: 'Search imagery', prompt: 'Search the STAC catalogue for: ' }],
  suggestions: ['Find Sentinel-2 scenes over Shanghai from last month'],
  tools: [{
    name: 'stac_search',
    description: 'Search the internal STAC API; returns items with asset hrefs that import_data can open.',
    parameters: { type: 'object', properties: { bbox: { type: 'array', items: { type: 'number' } }, datetime: { type: 'string' } } },
    confirm: false,
    async run({ bbox, datetime }, ctx) {
      const res = await ctx.fetch('https://stac.internal/search', { method: 'POST', body: JSON.stringify({ bbox, datetime, limit: 10 }) });
      return (await res.json()).features.map((f) => ({ id: f.id, href: f.assets.visual?.href }));
    },
  }],
};
```

`ctx` = `{ host, call, python, fetch, config, log }`: `ctx.call('layers_add', …)` composes QGIS tools, `ctx.python.run(code)` runs PyQGIS (Pyodide + compatibility layer), `ctx.fetch` falls back to the same-origin proxy automatically. The two built-in skills are templates: `skills/import-wizard.js` (`import_data`: download → add layer → zoom → summary) and `skills/analysis.js` (`layer_statistics` + notes on using processing). A skill can also be **prompt-only** (a JSON file), used to customise "how to do things" for a team.

### 5.2 Page tools (for web plugins)

`window.qgis.registerTool(name, { description, inputSchema, run, source })`: a tool registered by a web plugin appears in the agent, the MCP server and `window.qgis.tools()` at the same time. The agent's own `assistant_ask / assistant_status / assistant_reset` are registered this way, so `?ask=…`, `features.py --llm` and external MCP clients keep working unchanged.

### 5.3 Replacing the UI

`ui/panel.js` uses only `AgentRuntime` events and methods (§4.1). To switch to assistant-ui / a React portal: keep `core/` and replace `mountPanel()` in `agent.js` with your component; `createAgent()` does not care what the page looks like. The standalone page `agent/agent.html` is exactly "a page without QGIS + the same runtime".

## 6. Entry points at a glance

| Entry point | Usage |
|---|---|
| The panel in the page | The slot in the page's **workspace** (`web/shell/workspace.js`, flat button at the bottom right / `Ctrl+Shift+Space`, open on startup by default): the workspace owns the button, the header, the floating card / docked sidebar, drag-resize and memory (`localStorage["qgis-wasm.workspace.*"]`); the agent only renders the conversation and adds two buttons, New conversation / Settings, to the header (`window.qgisWorkspace.addAction`). Layout and "open on startup" are in the workspace's ⋯ menu (or the preset's top-level `ui`). On a page without a workspace (older deployments) the agent still brings its own button and floating card; on the standalone `agent.html` page the whole page is the panel |
| `?ask=…` | asks automatically after the page loads (once the agent is ready) |
| `assistant_ask / assistant_status / assistant_reset` | Page tools: usable from `window.qgis.call`, MCP `tools/call` and `POST /agent/call`; `assistant_status` returns `configured / busy / model / provider / mcpServers / skills / tools / transcript / lastAnswer` |
| `agent/agent.html?qgis=<server>[&preset=…][&client=…]` | Standalone page that drives a QGIS tab through serve.mjs (for remote use / portal embedding; the panel inside the QGIS page has no entry point for this, so open this URL directly) |
| External agents (Claude Code, etc.) | Still the MCP server `/mcp` ([docs/04](04-cloud-presets-and-agent.md) §3.2), sharing the same set of tools with the Web Agent |

| | |
|---|---|
| ![The panel in the page](../screenshots/qgis-wasm-agent.png) | ![Standalone page](../screenshots/qgis-wasm-agent-standalone.png) |
| In the page: catalogue MCP tool → skill tool `import_data` → summary, the card floats over the map | `agent/agent.html?qgis=…`: the same agent remotely drives QGIS in another tab |

## 7. Tests

- `tests/mock-llm.mjs`: a scripted model that implements both the Responses API and Chat Completions (streaming / non-streaming) and decides which tool to call and what to answer from the user's wording.
- `tests/e2e/agent.py` (28 checks): startup and discovery (source counts, skill commands, bridgeApi), the agent in the workspace (button, slot, header buttons; floating card (canvas width unchanged, full height, drag/resize/memory, no pop-out button) and docked mode (the canvas yields space), the `assistant_ask` tool loop, MCP → skill chain, approval allow/deny, slash commands, typed send and image results, provider switching, user config persisted to localStorage, upload → skill tool, `layer_statistics`, the standalone page's remote host).
- `tests/e2e/features.py --llm`: real gateway + mock catalogue MCP, verifying that the prompt works together with a real model.

## 8. Trade-offs and known limitations

- **The model cannot see images**: exported maps and MCP images are shown in the panel, but they are not sent to the model as `input_image` (when needed, add one message in the provider's `toInput`).
- **The remote host has no event stream**: `agent.html` can only call tools; QGIS events are not pushed (the runtime refreshes the state snapshot every turn, which is enough).
- **Markdown rendering depends on a CDN** (marked + DOMPurify, jsDelivr, the same policy as Pyodide); when it is unreachable it degrades to plain text.
- **One session per page**; history is not persisted (a refresh clears it). When needed, store `items` outside the runtime.
- **The key is in the front end**: this is an accepted trade-off of internal deployments (see README); the policy layer only controls tools, not model access.
- Skill URLs must be `import()`-able: skills on object storage need CORS or must go through `/proxy`; skills in the virtual filesystem (`/cloud/...`) cannot be loaded directly yet.
