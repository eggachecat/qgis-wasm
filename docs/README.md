# Documentation

Every document exists in English and Chinese; each page links to its counterpart at the top.

| # | English | 中文 | What it answers |
|---|---|---|---|
| 01 | [Technical approach](en/01-approach.md) | [技术方案](01-技术方案.md) | Why QGIS can run in a browser at all, what the build produces, every change made to the upstream source, and what is deliberately given up |
| 02 | [Runtime behaviour and debugging](en/02-runtime-and-debugging.md) | [运行时与调试](02-运行时与调试.md) | How start-up works, the runtime traps that cost the most time (queued calls, thread pool, cache pairing, sync XHR), the debugging tools |
| 03 | [Plugins and migration](en/03-plugins-and-migration.md) | [插件与迁移指南](03-插件与迁移指南.md) | Three compatibility paths for plugins (PyQGIS layer, web plugin, statically linked C++), the supported API surface, and how to migrate |
| 04 | [Cloud storage, presets and the agent](en/04-cloud-presets-and-agent.md) | [云存储-Preset-Agent](04-云存储-Preset-Agent.md) | Mounts (S3/Swift/HTTP), the preset format, the control surface and the MCP server |
| 05 | [Web Agent](en/05-web-agent.md) | [Web-Agent](05-Web-Agent.md) | The agent's boundaries, the host contract, the model loop, skills, configuration layers, how to extend it and what to expect when QGIS is upgraded |
| 06 | [Architecture and layering](en/06-architecture.md) | [架构与分层](06-架构与分层.md) | Who owns what (shell / QGIS / agent), extension points, the URL scheme, query data sources, transport and caching, browser compatibility |
| — | [BUILD.md](BUILD.md) | — | Toolchain, build steps, knobs, how to run and test (English only) |
| — | [AGENTS.md](../AGENTS.md) | — | How to work in this repository: layout, build commands, rules of the road (English only) |

## The layering rule

One sentence, repeated in every document because every design decision follows from it:

> **QGIS knows only files and tool calls.** URLs, sharing, presets, cloud storage protocols, external data services and models all live in the page layer.

`tests/layering.test.mjs` enforces it statically.

## Reading order

- **New to the project**: 01 → 06 → 02, then BUILD.md to build it.
- **Writing a plugin**: 03 (and 05 §5 if the plugin is really an agent skill).
- **Deploying it for a team**: 04 (mounts, presets) → 06 §5 (transport, shared server) → BUILD.md (publishing).
- **Debugging something odd**: 02.
