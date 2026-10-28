# qgis-wasm — 把 QGIS 桌面版本身编译进浏览器

[English](README.md) · 中文 · [在线演示](https://eggachecat.github.io/qgis-wasm/)（GitHub Pages）

这不是一个"长得像 QGIS 的网页"。这里编译的是 **QGIS 上游 C++ 源码**（`qgis_core`、`qgis_analysis`、`qgis_gui`、`qgis_app`、各 provider、上游 C++ 插件，以及 QGIS 自己的 `src/app/main.cpp` 入口），工具链是 Emscripten + **Qt 6.11 for WebAssembly**。QGIS 的主窗口、菜单、图层面板、地图画布、属性表、符号化/标注对话框、表达式编辑器、数据源管理器、选项对话框……全部是原来的 Qt Widgets 代码，由 Qt 的 `qwasm` 平台插件绘制到 `<canvas>` 上；地图由 QGIS 自己的并行渲染器在 Web Worker 线程里渲染，数据由编译成 wasm 的 GDAL/OGR、PROJ、GEOS 读取。

在此之上，这个仓库补了一个团队日常使用它所需要的东西。分层原则一句话：**QGIS 只认识文件和工具调用；URL、分享、preset、云存储协议、外部数据服务、模型全在页面层**（docs/06）。云存储、preset、插件放在 QGIS **里面**（QGIS 自己的文件系统、设置系统和菜单看见它们）；URL 方案、分享、查询数据源是页面壳层的模块；agent 是页面上**独立的 Web 层**，通过一个工具契约操控 QGIS（docs/05）：

| | |
|---|---|
| **云存储可插拔** | Swift 风格接口的对象存储（`…/v1/AUTH_…/container`）、S3 兼容存储、HTTP 目录挂载为虚拟文件系统的 `/cloud/<name>`，QGIS 的 Browser 面板、打开/保存对话框、GDAL、工程保存全部直接可用；浏览器里 SigV4 签名、分块读、关闭即写回；无 CORS 的服务经同源代理 |
| **查询数据源可注入** | 要"问一句才有数据"的服务——OGC API Features、数据目录、返回 GeoJSON 的内部 API——在 preset 里**一行声明**（`sources`），就同时出现在 agent 的工具里、QGIS 菜单（Plugins → Data sources）里和链接里（`?add=source://…`）；新协议 `qgisSources.registerType()` 一个 JS 文件，不碰 QGIS |
| **URL 与分享** | 两种链接、两种语义。**快照**（`project_share`，Share → "Share a snapshot"）：把工程*和所有只存在于这台浏览器里的图层文件*复制进云挂载的 `<mount>/projects/<id>/`，并写清单记下每层来源；短链接 `?share=<id>` 打开的就是你看到的那一刻，冻结；"Refresh this snapshot from its sources" 按记录的查询原地刷新。**实时链接**（`view_link`，"Copy a live link to this view"）：`?add=source://…&basemap=…&extent=…` 这样的配方，打开时重新查询，什么都不存，适合实时数据和外部系统程序化拼链接。URL 方案 `?share ?open ?add ?basemap ?crs ?extent ?ask` 可组合、无对话框 |
| **Preset** | 一个 JSON 描述组织的默认配置：设置、底图（XYZ 连接）、收藏夹、挂载、查询数据源、Web 插件、启动工程、助手配置；`?preset=team-a` 选择 |
| **Agent** | QGIS 内部一个 ≈55 个工具的控制面（`QgsWasmBridge`，只增不改）；外部 agent 通过内置的 **MCP 服务器** 操控（Claude Code 一条命令接入）；页面上的 **Web Agent**（`web/agent/`，右下角按钮 → 悬浮卡片）：模型循环、技能（导入 / 分析…可按 URL 发布）、内部数据源的 MCP 客户端、工具审批策略、三层配置（默认 ← preset ← 用户），也能作为独立页面远程操控某个 QGIS 标签页 |
| **插件** | **Python 插件**（Pyodide + PyQGIS 兼容层：`QgsProject`/`QgsVectorLayer`/`iface`/`processing.run` 等照常写，菜单项进真正的 QGIS 菜单）+ Web 插件（JS）+ C++ 插件静态编入（Topology Checker、Geometry Checker 已编入）；附迁移指南 |

| | |
|---|---|
| ![欢迎页](docs/screenshots/qgis-wasm-startup.png) | ![demo 工程](docs/screenshots/qgis-wasm-world-map.png) |
| 启动后的 QGIS 4.2 主窗口：浏览面板、图层面板、QML 欢迎页、状态栏 | `?open=/qgis/share/demo/world.qgs`：三个图层的 GeoPackage 工程 |
| ![云存储图层](docs/screenshots/qgis-wasm-cloud-layer.png) | ![MCP 选择](docs/screenshots/qgis-wasm-mcp-selection.png) |
| 从 S3 挂载 `/cloud/gis/data/world_map.gpkg` 加入的图层（分块 Range 读取） | 外部 MCP 客户端调用 `layer_select` 选中巴西并缩放 |
| ![数据菜单](docs/screenshots/qgis-wasm-workspace-data.png) | ![Web Agent](docs/screenshots/qgis-wasm-agent.png) |
| 工作区的 Data 菜单：每个查询源及其集合离地图一步之遥，还有云挂载 | Web Agent：目录 MCP 工具（搜索）→ 技能工具 `import_data`（下载 → 加图层 → 缩放）→ 汇总；面板是浮在地图上的卡片，可拖动、缩放，不占 QGIS 的宽度 |
| ![选项对话框](docs/screenshots/qgis-wasm-options-dialog.png) | ![分享链接](docs/screenshots/qgis-wasm-share-link.png) |
| 设置 → 选项：模态对话框（`QDialog::exec()`，JSPI 嵌套事件循环） | e2e：S3 模拟服务上的 `project_share` 链接在新标签页里打开 |

文档：[索引](docs/README.md) · [01-技术方案](docs/01-技术方案.md)（为什么可行、对 QGIS 的每处改动、取舍）· [02-运行时与调试](docs/02-运行时与调试.md) · [03-插件与迁移指南](docs/03-插件与迁移指南.md) · [04-云存储-Preset-Agent](docs/04-云存储-Preset-Agent.md) · [05-Web-Agent](docs/05-Web-Agent.md)（边界、技能、升级）· [06-架构与分层](docs/06-架构与分层.md)（壳层 / QGIS / agent 的边界、扩展点、URL 方案、查询数据源、传输与兼容）· [BUILD.md](docs/BUILD.md)（构建与运行）。每篇都有英文版，见[索引](docs/README.md)。

## 与 qgis-js 的区别

[qgis-js](https://github.com/qgis/qgis-js) 是最早把 QGIS 编译成 WebAssembly 的上游项目，本仓库站在它的肩膀上：同一个 QGIS commit、同一套 vcpkg 工具链（wasm 版 Qt 6.11.1、GDAL 3.12、PROJ 9.8、GEOS 3.14）都来自那里。但目标不同。qgis-js 是一个**无界面的渲染库**：只编译 `qgis_core`，向 JavaScript 暴露二十来个函数（`loadProject`、`renderImage`、`renderXYZTile`、`identify`、`renderLegend`、地图主题、变量……），把渲染好的像素交给页面，页面通常用 `@qgis-js/ol` 在 OpenLayers 地图里显示。它的 README 自己写明 *"No Qt GUI provided"*——demo 里看到的界面是 OpenLayers 加一个工程选择器，不是 QGIS。本仓库编译的是**整个桌面应用**（`qgis_core` + `qgis_analysis` + `qgis_gui` + `qgis_app`、各 provider、C++ 插件），跑的是 QGIS 自己的 `main.cpp`，浏览器里出现的就是 QGIS 主窗口和它的全部对话框。

| | qgis-js | qgis-wasm（本仓库） |
|---|---|---|
| 编译了什么 | `qgis_core` + 五个 provider（vcpkg port 以 `WITH_GUI=OFF WITH_DESKTOP=OFF` 编译 QGIS），不给 QGIS 打补丁 | `qgis_core` + `qgis_analysis` + `qgis_gui` + `qgis_app`、各 provider、上游 C++ 插件、QGIS 的 `src/app/main.cpp`；一个补丁（[`patches/qgis-wasm.patch`](patches/qgis-wasm.patch)） |
| 用户界面 | 没有（"No Qt GUI provided"），页面自己搭，一般用 OpenLayers | 原装 QGIS 桌面界面：Qt Widgets 由 Qt 的 `qwasm` 平台插件绘制到 `<canvas>`——菜单、面板、属性表、符号化与标注、表达式编辑器、数据源管理器、Processing 工具箱、选项…… |
| 怎么操控 | JavaScript API：加载工程、把某个范围或某块 XYZ 瓦片渲染成 `ImageData`、identify、图例、主题、变量 | 人像在桌面上一样用 QGIS；程序走 ≈55 个工具的控制面（`QgsWasmBridge`）、内置 MCP 服务器和 Web Agent |
| 嵌套事件循环（`QDialog::exec()`） | 不需要——没有对话框 | JSPI（Chrome ≥ 137 及其它支持 JSPI 的浏览器；没有 JSPI 的浏览器用 Asyncify 构建，docs/06） |
| 渲染 | `QgsMapRendererParallelJob` / `QgsMapRendererSequentialJob` 画进 `QImage`，像素拷给页面 | QGIS 自己的并行渲染器跑在 worker 线程里，由真正的地图画布绘制 |
| 线程 | WebAssembly 线程（SharedArrayBuffer，COOP/COEP 头） | 相同 |
| 网络数据 | "Network-based layers (e.g. WMS, WFS, WMTS, XYZ, COG, Vector Tiles) are not supported at the moment"（其 README） | XYZ 底图、HTTP(S) 上的文件、云挂载（`/cloud/<name>`：Swift、S3 兼容、HTTP 目录）；无 CORS 的服务走同源代理 |
| Python | 没有（"No Python (PyQGIS) available"） | Python 插件：Pyodide + PyQGIS 兼容层（`iface`、`QgsProject`、`QgsVectorLayer`、`processing.run`……） |
| 浏览器 | Chromium ≥ 95、Firefox ≥ 100 | Chrome ≥ 137 / 任何支持 JSPI 的浏览器（Safari 27 与 Firefox 见 docs/06） |
| 周边 | npm 包 `qgis-js`、`@qgis-js/ol`、`@qgis-js/utils`；一个 demo 站 | preset、云存储、可注入的查询数据源、快照与实时链接、工作区、Debug 视图、agent + MCP、部署脚本 |
| 状态 | 公测，"work in progress"，"the API surface is very limited at the moment" | 已在团队的部署里日常使用；`tests/` 下的 e2e 套件；`scripts/export-pages.sh` 生成静态演示站 |

只需要 QGIS *渲染*一个工程的 Web 应用——地图查看器、瓦片渲染、把 `.qgz` 嵌进现成的 OpenLayers / MapLibre 页面——选 qgis-js。需要人在 QGIS 里*工作*——改符号化、开属性表、跑 Processing、写插件用插件——又不想安装的，选本仓库。

## QGIS 版本与我们的改动

| | |
|---|---|
| QGIS 源码 | 上游 [qgis/QGIS](https://github.com/qgis/QGIS) **tag `final-4_2_3`**（QGIS 4.2.3 "Belém do Pará"，commit `b041a189`），作为 submodule `external/QGIS` 固定在这个 commit，不带任何第三方 fork |
| 我们的 delta | 单个补丁 [`patches/qgis-wasm.patch`](patches/qgis-wasm.patch)：对上游源码的全部修改（CMake、`__EMSCRIPTEN__` 守卫、新增的 `cmake/QgisWasmApp.cmake`、`src/app/qgswasm*.{h,cpp}`、`src/core/qgswasmtrace.h` 等），逐项说明见 [docs/01-技术方案.md](docs/01-技术方案.md#对-qgis-源码的改动) |
| 打补丁 | `scripts/apply-patches.sh`（在干净的 `git submodule update --init` 之后执行一次） |
| 改完导出 | `scripts/export-patches.sh`（把 `external/QGIS` 工作区相对 `final-4_2_3` 的差异重新写回补丁文件） |

升级 QGIS 版本的流程：把 submodule 切到新 tag → `scripts/apply-patches.sh`（冲突处按 `__EMSCRIPTEN__` 守卫逐个解决）→ `scripts/export-patches.sh` → 重新构建。

## 构建

前提：Linux x86-64，git、cmake、ninja、python3、flex、bison、pkg-config、Node.js ≥ 18（只用于本地服务器 / MCP / 测试）。32 核 + 94 GB 内存的机器上，依赖约 1 小时（Qt 本身只需几分钟，大头是 qtdeclarative 的宿主工具），QGIS 约 25 分钟。

```bash
git clone --recurse-submodules https://github.com/eggachecat/qgis-wasm.git qgis-wasm && cd qgis-wasm
scripts/bootstrap.sh          # emsdk 6.0.10 + vcpkg（固定 commit）
scripts/apply-patches.sh      # 把 patches/qgis-wasm.patch 打到 external/QGIS
scripts/build-deps.sh         # vcpkg: Qt 6.11 wasm、GDAL、PROJ、GEOS、GSL、QScintilla…（triplet wasm32-emscripten-qt-threads）
scripts/build-qgis.sh         # cmake 配置 + 编译 QGIS → build/qgis/output/bin/{qgis.js,qgis.wasm,qgis.data,qgis.lazy.json,index.html,qgis-shell.js,cloudfs.js,presets/,plugins/}
node scripts/serve.mjs --port 8123   # 静态服务器（COOP/COEP 头）+ MCP 服务器 (/mcp) + CORS 代理 (/proxy)
# 浏览器打开 http://127.0.0.1:8123/            （Chrome ≥ 137 / 其它支持 JSPI 的浏览器）
#          http://127.0.0.1:8123/?open=/qgis/share/demo/world.qgs
#          http://127.0.0.1:8123/?preset=team-a&open=/cloud/gis/projects/x.qgz
#          http://127.0.0.1:8123/?ask=add%20a%20basemap%20and%20zoom%20to%20Europe
#          http://127.0.0.1:8123/?basemap=OpenStreetMap&add=/cloud/shared/data/x.gpkg|layername=roads&add=source://features/rivers?bbox=-10,35,5,45&extent=-10,35,5,45
# scripts/build-qgis.sh 结尾会跑 scripts/compress-bundle.mjs：.br/.gz 旁路文件，首次加载 ≈34 MB 而不是 ≈166 MB（serve.mjs / nginx brotli_static）；world_map.gpkg 等按需文件（qgis.lazy.json）首次读取时才下载；
# qgis.bundle.json（各文件大小）供加载页使用：真实 MB、每个文件的进度、阶段（下载 → 编译 → 恢复档案 → 启动 QGIS）和原理说明
```

`QGIS_WASM_BUILD_TYPE=Release`（默认）/ `Debug`；`cmake -DQGIS_WASM_NESTED_LOOPS=jspi|asyncify|none`、`-DQGIS_WASM_PROFILING_FUNCS=OFF`（去掉函数名，wasm 小 15 MB）、`-DQGIS_WASM_STATIC_PLUGINS=…`（编入哪些 C++ 插件）、`-DQGIS_WASM_LAZY_FILES=源@虚拟路径;…`（哪些大资源不进 qgis.data、改为首次读取时下载，默认 `world_map.gpkg`）。

浏览器不在这台机器上时：SharedArrayBuffer 只在安全上下文可用，用 `ssh -L 8123:127.0.0.1:8123 <host>` 转发后访问 `http://127.0.0.1:8123/`，或者在 HTTPS 下部署。

## 部署（给多人用的主机）

```bash
scripts/deploy.sh my-host https://qgis.example.com    # [ssh 主机] [公开地址] [安装目录=/srv/qgis-wasm] [端口=8123]
```

脚本先把壳层/agent 文件和 `.br`/`.gz` 旁路文件刷进包里，再把包、`scripts/serve.mjs` 和 `deploy/*` rsync 到主机，在主机上跑 `deploy/remote-install.sh`：装一个 systemd 服务（`deploy/qgis-wasm.service`，有 sudo 装系统级，没有就 `--user`）跑 `serve.mjs --shared --host 127.0.0.1`；主机上有 nginx 且有该域名的证书时再装 `deploy/nginx-qgis.conf` 这个站点（`TLS_CERT=… TLS_KEY=…` 指定证书；没有证书就监听 :80，留给前面的 TLS 负载均衡）。每次构建后重跑即可，只传变化的文件。

`--shared` 是一台服务器能安全地服务多人标签页的关键：每个 MCP / agent 调用必须指明要操控哪个页面（`/mcp?client=<id>`；每个页面有一个猜不到的 id，在 Plugins → Share → "Copy MCP endpoint of this page" 里拿到自己的端点），结果只接受来自那个页面的回复，客户端列表关闭，CORS 代理只能到 preset 里点名的主机（外加 `--proxy-allow`）。不带这个开关（开发机）时调用落到最近的页面、代理什么都能到。前面的 TLS 层要原样保留 serve.mjs 的 `Content-Type: application/wasm`、`Cache-Control: no-cache` + ETag 和旁路文件的 `Content-Encoding`，这样第二次打开 ≈1 s（`tests/e2e/warm.py`）。

## 静态托管（GitHub Pages、任何文件服务器）

这套包也能从纯静态主机运行。静态主机做不到的两件事放在页面里解决：跨域隔离（线程需要 COOP/COEP 头）由一个小 service worker 提供（`web/shell/coi-serviceworker.js`，缺头时自动注册，页面重载一次）；134 MB 的 `qgis.wasm` 以 `qgis.wasm.gz` 传输（GitHub 不收 100 MB 以上的文件），浏览器里用 `DecompressionStream` 边流边解。没有服务器时 MCP 端点、CORS 代理、agent 传输不可用，其它照常。

```bash
scripts/export-pages.sh gh-pages              # → 分支 gh-pages：构建产物整理成静态站（.nojekyll、qgis.wasm.gz、qgis.data.gz）
```

把它推成 `gh-pages` 后让 GitHub Pages 指向它（Settings → Pages → Deploy from a branch → `gh-pages`，根目录）；本仓库的在线版本在 https://eggachecat.github.io/qgis-wasm/ 。

**Cloudflare Pages** 也能托管同一份产物，而且对多数访客更快：`scripts/export-static.mjs` 会写一个 `_headers`，让边缘直接发 `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`（线程可用，不再需要 service worker 重载）；超过 Pages 单文件 25 MiB 上限的文件放进 R2 桶（`qgis.bundle.json` 里带它的绝对 URL，配 CORS + 自定义域）。`scripts/deploy-cloudflare.sh` 用一个 `CLOUDFLARE_API_TOKEN` 完成两步；桶、桶的自定义域和 Pages 的自定义域是一次性的控制台设置。持续集成：`tests.yml` 在每次 push 时跑快速检查（分层、SigV4、共享服务器、文档链接、OSS guard）；`pages.yml` 重新构建并发布 `gh-pages`——它需要自托管 runner，因为从零构建要 ~110 GB 构建树和数小时 CPU。在已经装好工具链的机器上，`scripts/release.sh` 一条命令完成 构建 → 发布 → 推送。该分支约 55 MB 构建产物，只推到 GitHub：单文件上限小的远端会拒收，而 GitHub Pages 不提供 Git LFS 对象。

## 测试

```bash
python3 tests/e2e/smoke.py --remote https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson
#  启动、demo 工程渲染（取像素）、远程 GeoJSON → 子图层对话框 → 渲染、模态对话框开/关
python3 tests/e2e/features.py [--llm]
#  控制面、preset、S3 挂载（SigV4 模拟服务）读/写/分享链接、Web 插件、Python 插件、C++ 插件、Processing、导图、MCP、第二标签页打开分享链接；
#  壳层：查询数据源（目录 / OGC API Features / GeoJSON 模板 / Overpass mock；部署覆盖层存在时再加它自己的类型）、链接解析、view_link 两种分支、深链接在新标签页复现、
#  Share 与 Data sources 菜单、工作区（菜单、集合一键上图、链接）、加载页的字节数、无 JSPI 的预检页、.br 旁路文件协商；
#  --llm：Web Agent 通过网关的真实模型 + 模拟目录 MCP 服务器完成"搜索 → 加载 → 缩放"
python3 tests/e2e/agent.py
#  Web Agent（28 项）：脚本化模拟模型（tests/mock-llm.mjs）——工具发现、工作区里的 agent（卡片 / 停靠布局）、工具循环、MCP → 技能、审批、斜杠命令、两种 provider、用户配置、上传、独立页远程操控
python3 tests/e2e/warm.py
#  冷启动 vs 热启动（同一浏览器档案）：第二次 qgis.wasm/.data/.js 只传 ETag 校验头，主窗口 ≈1 s（冷启动 1.4 s 起，取决于浏览器写缓存的磁盘速度）
node tests/layering.test.mjs && node tests/cloudfs-sign.test.mjs && node tests/serve-shared.test.mjs
#  不开浏览器：分层守卫（QGIS 不读页面、页面只经 window.qgis 碰 QGIS、agent 只依赖契约、工具名都有登记）；SigV4 签名；
#  serve.mjs --shared（页面寻址、结果归属、代理白名单与重定向、开发机默认行为不变）
```

Playwright + 本机 `/usr/bin/google-chrome`（SwiftShader），截图写入 `docs/screenshots/`。`tests/e2e/drive.py` 可以脚本化点击/按键/滚轮/执行 JS/截图。

## 接入与使用

**云存储**：preset 的 `mounts`（或控制台 `qgis.mount({...})`）。团队的 preset 把自己的存储挂进来（能直连就直连，服务没有 CORS 头时自动改走同源 `/proxy`）：

```json
{ "type": "swift", "name": "shared", "url": "https://swift.example.com/v1/AUTH_team/shared" }
{ "type": "s3", "name": "gis", "endpoint": "https://s3.corp.example.com", "bucket": "gis-data", "accessKeyId": "…", "secretAccessKey": "…" }
```

→ `/cloud/shared/...` 出现在 Browser 面板的 Favorites；保存工程到那里就是写回对象存储；`project_share` 把工程存成 `shared/projects/<uuid>/<标题>.qgz` 并返回可分享链接（不需要用户起名）。详见 docs/04。

**Preset**：`web/shell/presets/<name>.json`，字段 `settings / enforce / basemaps / favorites / mounts / share / sources / plugins / plugins_python / plugins_cpp / open / agent`（`agent` 的子字段见 docs/05 §4.5），`?preset=<name>` 选择。

**查询数据源**（docs/06 §4）：preset 的 `sources`，三种内置类型：

```json
{ "name": "features", "type": "ogcapi",  "title": "内部要素服务", "url": "https://geo.corp/ogcapi" }
{ "name": "catalog",  "type": "catalog", "title": "数据目录",     "url": "https://data.corp/catalog.json" }
{ "name": "poi",      "type": "geojson", "title": "POI 查询",     "url": "https://api.corp/poi?bbox={bbox}&q={q}&limit={limit}" }
{ "name": "osm",      "type": "overpass","title": "OpenStreetMap (Overpass)", "url": "https://overpass-api.de/api/interpreter", "limit": 5000 }
```

第四个 `web/shell/sources-overpass.js`（类型 `overpass`）是经 Overpass 解释器取 OpenStreetMap：常用标签预设当集合（红绿灯、人行横道、匝道、道路、建筑…），查询词是标签过滤或完整 Overpass QL，bbox 必填，OSM JSON 在页面里转成 GeoJSON；默认 preset 指向公共 Overpass API（正式使用请换成自己的镜像）。"自带协议的服务"再多一个 JS 文件就行：写成 Web 插件，在里面 `qgisSources.registerType(type, { collections, search, fetch })`，列进 preset 的 `plugins`——QGIS 零改动，preset 里该类型的 `sources` 在它注册时自动接上。

→ 工具 `sources_list / sources_collections / sources_search / sources_load`（agent、MCP、插件自动可见）、菜单 Plugins → Data sources → "<title>…"、链接 `?add=source://<name>/<collection>?bbox=…`。QGIS 看到的只是 `/home/web_user/sources/` 下出现了一个 GeoJSON。

**链接**（docs/06 §3）：`?open=`（经 QGIS 打开工程/文件）、`?add=`（直接加图层：云文件、URL、XYZ 模板、`source://`，可重复）、`?basemap=`、`?crs=`、`?extent=xmin,ymin,xmax,ymax[@CRS]`、`?ask=`。Plugins → Share → "Copy link to this view" 生成复现当前视图的链接（工具 `view_link`）。

**MCP**（任何 agent 操控浏览器里的 QGIS）：

```bash
claude mcp add --transport http qgis http://127.0.0.1:8123/mcp     # Claude Code
node scripts/mcp-stdio.mjs http://127.0.0.1:8123/mcp              # 只支持 stdio 的客户端
```

**Web Agent**：preset 的 `agent`（`provider`、`baseUrl`、`model`、`apiKey`、`mcpServers`、`skills`、`tools.confirm`、`ui`），右下角按钮打开悬浮卡片（`ui.layout: "dock"` 改成停靠侧栏）。内部数据源优先写成 preset 的 `sources`（agent 的状态快照里有名单，`sources_search / sources_load` 直接用，而且菜单和链接也能用）；需要对话式检索的服务再提供 MCP 服务器。业务能力写成技能（一个 JS 文件）按 URL 发布。

**插件**：Python 插件目录（`metadata.txt` + `__init__.py` + `files.json`）或 zip 写进 preset 的 `plugins_python`，也可放在云挂载目录里用 `python_plugins {action:"load", source:"/cloud/shared/plugins/<id>"}` 加载；Web 插件放 `web/shell/plugins/`、写进 `plugins`；C++ 插件见 docs/03。控制台或 agent 可直接 `python_run` 跑 PyQGIS 写法的代码。

## 日常使用（界面里怎么做）

**把工程存到云挂载（`/cloud/<name>`）**

1. Project → Save As…（Qt 自己的文件对话框，浏览的是虚拟文件系统）。左侧快捷栏里有 preset 的各个挂载（点一下就列出容器内容）、`cloud`、`demo`、`web_user`，也可以像桌面版一样双击目录浏览，或直接在文件名里写绝对路径。
2. 选好目录（新目录用对话框的“新建文件夹”按钮），输入文件名如 `我的工程.qgz`，回车。保存即上传；Browser 面板里该挂载的收藏夹下能看到，刷新页面后仍在。
3. 要分享：Share → "Share a snapshot"（工作区头部或 Plugins → Share；或对助手说 "share this"，或任何 agent 调用 `project_share`）。工程和所有只在你浏览器里的图层文件被复制到 `shared/projects/<id>/`，短链接 `?share=<id>` 进了剪贴板，同事打开即是同一个工程、同样的数据和视野，冻结不变；之后可用 "Refresh this snapshot from its sources" 按记录的查询刷新。要看实时数据就用 "Copy a live link to this view"：打开时重新查询的配方（`view_link`）。也可以手工拼 `?open=` / `?add=`。
4. 打开别人的工程：Project → Open… 浏览到 `/cloud/shared/...`，或在 Browser 面板里双击。


**agent 在哪**

- **界面里**：右下角扁平的绿色按钮（或 `Ctrl+Shift+Space`）打开**工作区**（默认启动即开）：一张浮在地图上的卡片（靠右、上下等边距占满高度），不占 QGIS 的宽度；拖标题移动、拖左上角缩放，位置和大小记在浏览器里（⋯ → 停靠侧栏时 QGIS 让出右侧）。头部是页面功能，扁平图标 + 小菜单——**Project**（保存、分享快照、打开 demo、把地图视图导出 PNG：直接下载并在新标签页打开）、**Share**（快照：存储、冻结；实时链接：配方；按来源刷新快照；本页的 MCP 端点；preset 里的链接）、**Data**（跨源搜索；每个数据源的集合一键上图；云挂载）、**Debug** 视图（页面与 QGIS 的日志在一个列表里、工具耗时、主线程卡顿、内存 / 线程 / 启动阶段；按钮上有错误计数）、**⋯**（布局、启动即开、GitLab 等链接、关于）——主体就是 **agent**。输入自然语言即可，例如 "Add the OpenStreetMap basemap, zoom to Brazil and tell me its ISO code"；每一步工具调用是一张可展开的卡片（参数 / 结果 / 用时），导出的地图直接显示在对话里；输入 `/` 看技能命令（`/import`、`/stats`、`/buffer`），把文件拖进面板即上传到 `/home/web_user/uploads/`。默认所有工具直接执行，不打断你；要让某些操作（保存、删图层…）先确认，在 preset 的 `tools.confirm` 或 ⚙ 的 Ask before running 里列出工具名，那时输入框上方固定弹出 Allow / Deny。⚙ 设置里可以换模型、写自己的指令、加 MCP 服务器和技能、改审批策略；改动只存在自己的浏览器里，"Reset to preset" 回到组织默认。
- **独立页面**（可选，面向远程 / 门户嵌入）：`agent/agent.html?qgis=http://127.0.0.1:8123`——同一个 agent 在自己的页面里，经 `serve.mjs` 远程操控 QGIS 标签页。
- **外部 agent / 脚本**：`claude mcp add --transport http qgis http://127.0.0.1:8123/mcp` 之后，Claude Code 里直接说 "在 QGIS 里加载 … 并导出图片"；或 `curl -X POST http://127.0.0.1:8123/agent/call -d '{"tool":"state"}'`；`assistant_ask` / `assistant_status` 也是工具，外部 agent 可以让页面里的 agent 干活。
- **内部数据源**：每个数据源提供一个 MCP 服务器，写进 preset 的 `agent.mcpServers`；agent 搜到结果后用 `import_data` / `layers_add` 直接打开。

![Web Agent](docs/screenshots/qgis-wasm-agent.png)

## 与原始需求的对应

| 需求 | 现状 |
|---|---|
| GUI 完全在 web 上可用 | 真正的 QGIS 桌面 GUI 跑在浏览器里（本仓库的核心） |
| 工程 / 文件系统可插拔（CDN、内部类 S3 等） | `cloudfs.js`：Swift 风格、S3 兼容、HTTP 目录三个后端，挂到 `/cloud/<name>`，QGIS 全部文件操作直接可用；分享 = 自动生成 `projects/<uuid>/…` + 链接；新后端 `registerBackend()` 即可 |
| 外部数据查询源可注入 | `sources.js`：preset 一行声明 OGC API Features / 目录 / GeoJSON API，自动成为 agent 工具、QGIS 菜单项、工作区菜单项、链接参数；新协议 `registerType()`——`sources-overpass.js`（OpenStreetMap）是一个，团队自己的网关写成 Web 插件即可；QGIS 零改动（docs/06 §4） |
| 分享、载入、URL 解析在 web 层 | `share.js` + `link.js`：存储的快照（`<mount>/projects/<id>/` 工程 + 数据 + 清单；`?share=<id>`；按来源刷新；浏览器本地的 GeoJSON 以 GeoPackage 进快照——有空间索引、小三分之一、打开即用）和实时配方链接（`?open ?add ?basemap ?crs ?extent ?ask`、`view_link`）；Share 菜单；QGIS 对 URL 一无所知——它只看到文件和两个工具（docs/06 §3）。传输不冻结标签页：快照在 cloudfs 的 write-behind 租约下异步上传，`?share=` 链接在加载幕后面预取文件、显示真实 MB |
| 页面做的每件事都有进度 | `progress.js`：一条任务总线；分享、打开快照、查询数据源、下载、应用链接都往这里报，工作区（进度条 / 药丸 / 按钮上的环）、加载页、Debug 视图只负责听 |
| 通用内部配置 / 底图 | Preset JSON（设置、XYZ 底图连接、收藏夹、挂载、插件、启动工程、助手） |
| 原生 agent，可配置可操控 | `QgsWasmBridge` 控制面 + 内置 MCP 服务器（外部 agent）+ 页面上的 Web Agent（`web/agent/`：技能、MCP 客户端、审批策略、三层配置、独立页远程模式；能分享、能直接打开）；边界设计与升级流程见 docs/05 |
| 插件 | Python 插件：Pyodide + PyQGIS 兼容层（`web/shell/pyqgis/`，同步语义靠 JSPI `run_sync`），示例 `hello_pyqgis` 默认加载；Web 插件 API；C++ 插件静态编入（Topology Checker、Geometry Checker 已编入）。不支持的部分（自定义 Qt 对话框/地图工具、Python Processing 算法、线程）见 docs/03 |

## 品牌与部署覆盖层

`web/shell/brand.js` 一个文件决定部署的外观：产品名、强调色（以 `--brand-accent` 暴露）、加载 spinner，可选加载页的轮播文案。部署把自己的 `brand.js`、preset、额外页面模块（自己的数据源类型写成 Web 插件）、`deploy.env` 放在 `internal/`，每次构建后 `scripts/stage-web.sh` 把这层覆盖进产物目录（`--oss` 则只放开源版本）。开源树里没有 `internal/`：`scripts/export-oss.sh` 从带覆盖层的检出生成它，并拒绝导出任何仍带覆盖层主机名或密钥的内容（`tests/oss-guard.mjs`）。

## 许可

GPL-2.0-or-later（[LICENSE](LICENSE)），与 QGIS 相同：`patches/` 里的补丁修改的是 QGIS，页面层与脚本按同一条款发布。随包的 Open Sans 字体为 OFL（`web/OpenSans-OFL.txt`）。

## 仓库布局

| 路径 | 内容 |
|---|---|
| `external/QGIS` | QGIS 上游源码（submodule，tag `final-4_2_3` / `b041a189`） |
| `patches/qgis-wasm.patch` | 对 QGIS 的全部改动（`scripts/export-patches.sh` 重新生成） |
| `external/QGIS/cmake/QgisWasmApp.cmake` | wasm 可执行目标：Emscripten 运行时参数、预加载的 QGIS 数据目录、静态插件、Qt 终结、QML 插件、shell 目录拷贝 |
| `external/QGIS/src/app/qgswasmapp.*` | 浏览器钩子（`main.cpp` 只剩 5 个一行调用）+ JS 入口 `qgis_wasm_open/ready/call` |
| `external/QGIS/src/app/qgswasmbridge.*` | 控制面（工具注册表，页面 / MCP / Web Agent 共用） |
| `external/QGIS/src/app/qgswasmpreset.*` | preset 应用（设置、底图、收藏夹、C++ 插件启用） |
| `external/QGIS/src/app/qgswasmstaticplugins.*` | 静态编入的 C++ 插件表 |
| `external/QGIS/src/core/qgswasmtrace.h` | `QGIS_WASM_TRACE(...)`，`?trace=1` 时输出到浏览器控制台 |
| `vcpkg.json`、`build/vcpkg-ports/*`、`build/vcpkg-triplets/*`、`build/vcpkg-toolchains/*` | 依赖清单、overlay ports（`qscintilla`、`libb2` 为本仓库的 CMake 版）、wasm triplet |
| `web/shell/` | 浏览器壳：`index.html`（预检 + 加载页 + 按序加载）、`qgis-shell.js`（preset、`window.qgis`、插件、agent 传输、启动编排）、`workspace.js` + `workspace.css`（页面的面板：按钮、头部菜单、视图、agent 的槽位、运行中的任务）、`progress.js`（任务总线）、`loading.js`（加载页）、`share.js`（存储的快照：`?share=<id>`、`project_share`、`share_refresh`）、`debug.js`（Debug 视图）、`link.js`（URL 方案与实时链接）、`sources.js`（查询数据源）+ `sources-overpass.js`（经 Overpass 取 OpenStreetMap）、`brand.js`（名称、强调色、spinner——部署覆盖层替换的那个文件）、`cloudfs.js`、`pyqgis.js` + `pyqgis/`（Python 运行时与 PyQGIS 兼容层）、`presets/`、`plugins/` |
| `scripts/compress-bundle.mjs` | 构建后生成 `qgis.wasm/.data/.js` 及 `qgis.lazy.json` 所列按需文件的 `.br`/`.gz` 旁路文件（serve.mjs 与 nginx `brotli_static` 直接发送） |
| `web/agent/` | Web Agent：`agent.js`（入口）、`agent.html`（独立页）、`core/`（host / runtime / tools / mcp / skills / config / providers）、`ui/`（面板）、`skills/`（内置技能） |
| `web/` 其它 | 部署用 `qgis_global_settings.ini`、Open Sans 字体（OFL）、示例工程 |
| `scripts/` | bootstrap / build-deps / build-qgis / export-patches / apply-patches / make-demo-project / serve（静态 + MCP + 代理，`--shared` 用于多人主机）/ deploy（经 ssh 的 rsync + systemd + nginx）/ mcp-stdio / build-errors |
| `deploy/` | `qgis-wasm.service`（systemd 单元模板）、`nginx-qgis.conf`（TLS 站点模板）、`remote-install.sh`（在主机上执行） |
| `tests/` | `e2e/smoke.py`、`e2e/features.py`、`e2e/agent.py`、`e2e/warm.py`、`e2e/drive.py`、`e2e/stacks.py`、`layering.test.mjs`（分层守卫）、`serve-shared.test.mjs`、`cloudfs-sign.test.mjs`、`s3-mock.mjs`、`mock-mcp.mjs`、`mock-llm.mjs`、`data/` |
| `AGENTS.md` | 在这个仓库里怎么干活（给人也给编码 agent）：分层规则、东西放哪、怎么测、什么绝不能提交 |
| `internal/`（可选） | 部署自己的覆盖层，不在开源树里：`web/brand.js`、`web/presets/*.json`、额外页面模块、`deploy.env`、自家服务的 mock 扩展；`scripts/stage-web.sh` 把它覆盖进产物 |
| `docs/` | 方案、运行时与调试、插件与迁移指南、云存储/Preset/Agent、Web Agent（边界 / 技能 / 升级）、截图 |
