# 云存储、Preset 与 Agent

> English: [04-cloud-presets-and-agent.md](en/04-cloud-presets-and-agent.md)

这三块都建立在同一个事实上：浏览器里跑的是完整的 QGIS 桌面程序，所以"接入"意味着让 QGIS 自己的文件系统、设置系统和 UI 看见它们，而不是在旁边再造一套界面。

```
 preset JSON ──▶ web/shell/qgis-shell.js ──▶ Emscripten FS ──▶ QGIS (Browser 面板 / 打开保存对话框 / GDAL / QgsProject)
   mounts            cloudfs.js (S3 / HTTP)      /cloud/<name>
   settings/basemaps ──▶ QgsWasmPreset::apply() ──▶ 用户配置文件（QgsSettings / XYZ 连接 / 收藏夹）
   agent ──▶ web/agent（页面上的 Web Agent，docs/05） ──▶ 模型 API + MCP 服务器（内部数据源）
 MCP 客户端 (Claude Code 等) ──▶ scripts/serve.mjs /mcp ──▶ 页面 (SSE) ──▶ QgsWasmBridge 工具 ──▶ QGIS
```

## 1. 云存储（S3 兼容）

> 挂载解决"像文件一样的数据"。要查询（集合 / bbox / 关键词）才有数据的服务用 preset 的 `sources`（docs/06 §4），两者都在页面层，QGIS 零改动。

### 1.1 使用

在 preset 里声明挂载（或页面控制台 `qgis.mount({...})` / agent 工具 `mounts_add`）：

```json
"mounts": [
  { "type": "swift", "name": "shared", "url": "https://swift.example.com/v1/AUTH_team/shared" },
  { "type": "s3", "name": "gis", "endpoint": "https://s3.corp.example.com", "bucket": "gis-data", "prefix": "team-a/",
    "region": "us-east-1", "accessKeyId": "AKIA…", "secretAccessKey": "…", "pathStyle": true },
  { "type": "http", "name": "cdn", "baseUrl": "https://cdn.example.com/basemaps/", "index": "index.json" }
],
"share": { "mount": "shared", "prefix": "projects" }
```

三种后端：

| type | 适用 | 配置 |
|---|---|---|
| `swift` | OpenStack Swift 风格的对象存储——`https://<host>/v1/AUTH_<account>/<container>/<object>` 形式的服务（匿名或 token 读写、Range；目录列表用 JSON API，容器开了 staticweb（`X-Container-Meta-Web-Listings`）时自动改解析它的 HTML 目录页），部署的 preset 通常挂为 `/cloud/shared`。容器列表最终一致：列表里大小为 0 的对象会用 HEAD 复核 | `url`（账户+容器）、`prefix`、`token`（需要 `X-Auth-Token` 时）、`proxy` |
| `s3` | AWS S3 / MinIO / Ceph RGW 等 SigV4 接口 | `endpoint`、`bucket`、`prefix`、`region`、`accessKeyId`、`secretAccessKey`、`sessionToken`、`pathStyle`、`proxy` |
| `http` | 只读的 HTTP 目录（CDN），用一个 `index.json` 描述文件列表 | `baseUrl`、`index`、`proxy` |

**关于 `proxy`（CORS 与代理）**

- `"auto"`（默认）：每个请求先直连，浏览器因缺少 CORS 头而拦下时自动改走同源的 `scripts/serve.mjs` 的 `/proxy?url=…`，并记住这个选择。
  - 目录列表与对象传输**分开记录**：例如对象 GET/PUT/HEAD 配好 CORS 后直连，而 staticweb 容器没有 CORS 头、列表仍走代理。
  - 控制台会打印每一类最终用了哪种方式。
- `true` 强制走代理，`false` 强制直连。
- 没有 CORS 头的服务**必须**经代理（预检被拒、或响应里没有 `Access-Control-Allow-Origin`）。代理转发全部方法、请求体与头（含 `Range`、`Authorization`、`x-amz-*`），S3 签名仍对真实 URL 计算。
- 存储侧配好 CORS 后不需要改 preset（`auto` 会自动直连）。需要放行的头：
  - **Swift**：容器元数据 `X-Container-Meta-Access-Control-Allow-Origin: <页面来源>`，以及 `…-Allow-Headers` / `…-Expose-Headers`。
  - **S3**：bucket CORS 规则允许 `Range`、`Content-Type`、`Authorization`、`x-amz-*`，暴露 `Content-Length`、`Content-Range`、`ETag`。

**分享**：`project_share` 不让用户起路径——它把工程保存为 `/cloud/<share.mount>/<share.prefix>/<uuid>/<工程标题>.qgz`（默认 `shared/projects/…`），返回 `?preset=<name>&open=<path>` 链接；对方打开链接时同一 preset 挂同一容器，工程直接出现。

之后 `/cloud/shared/...`、`/cloud/gis/...` 就是普通目录：Browser 面板的 Favorites 里能浏览、双击加图层；Project → Save As 到 `/cloud/gis/projects/x.qgz` 就是写回对象存储；`layers_add { uri: "/cloud/gis/data/a.gpkg" }`、`project_open`、`files_list` 等工具同样适用。

### 1.2 实现（`web/shell/cloudfs.js`）

- 一个 Emscripten 文件系统类型，建立在 MEMFS 之上：目录第一次被访问时列对象（S3 `ListObjectsV2` / Swift `?format=json&delimiter=/`，缓存 30 s；staticweb 容器只给 HTML 索引页——第一次探测失败后记住 `listMode='html'`，preset 的挂载里写 `"listMode": "html"` 可以直接跳过探测，少一次失败的请求；`proxy: "auto"` 仍会先直连一次再走页面服务器的代理，所以容器没开 CORS 之前 DevTools 控制台里还是会有一条被拦的请求——Debug 视图不计它，容器开了 CORS 就没有了），文件第一次被读时按 4 MB 分块 `Range` 请求（≤ 16 MB 的文件一次取完），写入缓冲在内存、`close()` 时整体 `PUT`；`unlink`→`DELETE`，`mkdir`→`key/` 空对象，`rename`→`COPY`+`DELETE`（目录重命名不支持）。
- Emscripten 的文件系统是同步的（QGIS 在主线程和工作线程里都用 `fopen`/`read`），所以传输用**同步 XMLHttpRequest**（主线程只能以 `x-user-defined` 文本收二进制，脚本做了转换）。QGIS 的工作线程把文件系统调用代理到主线程，所以并行渲染读 `/cloud` 也没问题。
- 签名是浏览器里纯 JS 的 **AWS Signature V4**（`UNSIGNED-PAYLOAD`，支持 session token），兼容 S3、MinIO、Ceph RGW 等；没有密钥就是匿名访问。`tests/s3-mock.mjs` 会严格校验签名，`tests/e2e/features.py` 用它回归。
- 服务端要求：**CORS**（`Access-Control-Allow-Origin` 包含页面来源，允许 `Authorization, Range, x-amz-*` 头，暴露 `Content-Length, Content-Range, ETag`）。MinIO/S3 的 bucket CORS 配置都能做到；做不到的服务可以走 `scripts/serve.mjs` 的 `/proxy?url=`（把 `endpoint` 写成 `http://<serve>/proxy?url=https://…` 即可）。
- 页面 COEP 是 `credentialless`，所以跨域请求不会带 cookie；凭证走签名头。
- 新后端：`qgisCloud.registerBackend(type, factory)`，实现 `list/read/size/write/remove/mkdir/rmdir/copy` 即可（例如 Azure Blob、GCS、WebDAV、内部的"类 S3"接口）。

**启动时的列目录不再卡主线程**：Browser 面板的收藏夹 / 文件对话框一显示就会去看 `/cloud/<name>` 根目录，而 cloudfs 对 QGIS 是同步的（主线程上的同步 XHR）——实测本机启动 8 s 里有 3 s 是在等这一次列目录（直连被 CORS 拒掉要先把整个响应收完，再走 `/proxy`）。现在三层处理：① `proxy: "auto"` 学到的结果（直连 / 代理，按 origin 和请求种类）记在 localStorage 里 6 小时，下次启动不再试直连；② 挂载时就异步预取根目录列表（`qgisCloud.warm(path)` 可预取别的目录），QGIS 一秒后来要时已经在手上，同步路径零等待；③ QGIS 的 OGR 提供者在 `/cloud/` 下不再为了猜 Arc/Info 网格而遍历目录（`qgsogrprovidermetadata.cpp`，`__EMSCRIPTEN__`）。服务器开了 CORS 后要立即生效：`qgisCloud.forgetCors()` 或等 6 小时。

### 1.3 已知限制

- 大文件首次读取会阻塞 UI（同步请求）；GeoPackage/GeoTIFF 这类随机读取的格式按块取，一般几次请求即可。
- 每个浏览器标签页各自缓存；别的用户/程序改了对象，30 s 后或 Browser 面板刷新后可见。
- 不支持多段上传、版本、ACL；对象键里 `!'()*` 等字符的签名可能与服务端不一致。

## 2. Preset

`web/shell/presets/<name>.json`，`?preset=<name>` 选择，默认 `default`。页面把它写进 VFS，`QgsWasmPreset::apply()`（`src/app/qgswasmpreset.cpp`）在主窗口创建前应用：

| 字段 | 含义 | 由谁处理 |
|---|---|---|
| `settings` | 任意 QGIS 设置键（`qgis/checkVersion`、`connections/xyz/items/X/url`…），**首次**写入用户配置文件；用户之后改了算用户的 | QGIS |
| `enforce` | 每次启动都写入（组织强制） | QGIS |
| `basemaps` | XYZ 连接（Browser → XYZ Tiles；`basemaps_list/use`），每次启动同步 | QGIS |
| `favorites` | Browser 面板收藏夹，例如 `/cloud` | QGIS |
| `plugins_cpp` | 首次启动就启用的静态 C++ 插件 | QGIS |
| `mounts` / `share` | 云存储挂载、分享工程用的挂载与前缀（见上） | 页面 |
| `sources` | 查询数据源：`[{ name, type: "ogcapi" \| "catalog" \| "geojson", title, url, … }]`，成为 `sources_*` 工具、Plugins → Data sources 菜单、`?add=source://…` 链接（docs/06 §4） | 页面 |
| `plugins` | Web 插件（ES module URL） | 页面 |
| `plugins_python` / `python` | Python 插件（目录 URL + `files.json`、zip、或虚拟文件系统目录）与 Pyodide 的 `indexUrl`（默认 jsDelivr 0.27.7；内网部署可指向自己的镜像） | 页面 |
| `open` | 启动时打开的文件/工程（`?open=` 追加） | 页面 |
| `agent` | Web Agent 配置：`provider`、`baseUrl`、`model`、`apiKey`、`systemPrompt`、`mcpServers`、`skills`、`tools.confirm`、`ui`（docs/05 §4.5） | 页面（web/agent） |

preset 是静态文件，部署即生效；一个部署可以放多个 preset（团队、项目、演示）。页面会把 `origin` 写进 preset 供 QGIS 侧拼接同源的 `/proxy`。

## 3. Agent

### 3.1 控制面：`QgsWasmBridge`（`src/app/qgswasmbridge.cpp`）

每个能力是一个带 JSON schema 的"工具"（≈50 个：工程、图层、要素、样式、画布、表达式、Processing、设置、底图、文件、UI、插件、助手），同一份注册表给三类调用者使用：页面/Web 插件（`qgis.call`）、MCP 客户端、内置助手。所有工具在 Qt 事件循环里执行；JS→C++ 的 `qgis_wasm_call()` 只做排队（docs/02 §2.1 的规则）。

### 3.2 外部 agent：MCP 服务器（`scripts/serve.mjs`）

静态服务器同时是一个 **MCP（Streamable HTTP）服务器**：`initialize`、`tools/list`、`tools/call` 转发给已连接的页面（页面通过 `/agent/events` 的 SSE 订阅，结果 `POST /agent/result` 回来）。`canvas_export_image` 的结果附带 `image` 内容块，所以 agent 能"看到"地图。

```bash
node scripts/serve.mjs --port 8123                       # 打开 http://127.0.0.1:8123/ 后：
claude mcp add --transport http qgis http://127.0.0.1:8123/mcp
# 只支持 stdio 的客户端：node scripts/mcp-stdio.mjs http://127.0.0.1:8123/mcp
curl -s http://127.0.0.1:8123/agent/clients             # 已连接的页面
curl -s -X POST http://127.0.0.1:8123/agent/call -H 'content-type: application/json' -d '{"tool":"state"}'   # 脚本直连
```

内部系统的 agent 因此可以：查自家目录/数据湖 → `layers_add { uri: "<url 或 /cloud 路径>" }` → `layer_set_style` → `canvas_export_image` → `project_share` 把链接发给人。

### 3.3 页面上的 Web Agent（`web/agent/`，详见 docs/05）

QGIS 里不再有助手面板。agent 是页面上一个独立模块，渲染在页面**工作区**（`web/shell/workspace.js`，docs/06）的槽位里：右下角扁平按钮打开一张浮在地图上的卡片，头部是页面功能（Project / Share / Data / ⋯），主体是 agent（不占 QGIS 的宽度，可拖动缩放；`ui.layout: "dock"` 改成停靠侧栏），模型循环 + 工具注册表（QGIS 工具 / 页面工具 / MCP / 技能）+ 审批策略 + 三层配置（默认 ← preset `agent` ← 用户 localStorage）。`assistant_ask / assistant_status / assistant_reset` 作为页面工具保留，所以 `?ask=…`、MCP 客户端和 `features.py --llm` 的用法不变。`agent/agent.html?qgis=<server>` 是同一个 agent 的独立页面（远程宿主，经 `/agent/call`）。

### 3.4 取舍说明

- 为什么不在 QGIS 里直接开 MCP 服务器：wasm 里没有 socket 监听，服务器必须在页面之外（`serve.mjs`），QGIS 侧只需一个控制面。
- 为什么 agent 在 web 层而不是 C++ 里：它需要的一切（≈50 个 QGIS 工具 + 页面工具）都已经在 `window.qgis` 后面；模型循环、流式输出、MCP、Markdown、拖拽上传在 JS 里是原生能力，而且改完刷新即生效、不碰 QGIS；QGIS 升级时 agent 一行不改（docs/05 §3）。
- 插件系统与 agent 共享工具集，避免两套 API。
