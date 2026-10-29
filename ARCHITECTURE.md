# GravityPort 系统架构

本文档描述仓库当前实现，而不是未来重构方案。产品版本以根目录
`package.json` 的 `version` 字段为唯一权威，不在本文档重复硬编码。运行时要求 Node.js
22 或更高版本；桌面层共享同一套 Electron/Renderer/Runtime 代码，目前明确支持
`darwin-arm64` 与 `win32-x64` 两个打包目标，其中 Windows 10/11 x64 处于 Preview/Testing 阶段。

## 1. 系统定位

GravityPort 是一个本地优先的创意资产库。它把图像和视频原件、可获得的 Prompt、
生成工具上下文、来源信息、标签和版本历史保存在本地，提供浏览、搜索、归档
和版本化的能力。GravityPort 不生成媒体、不提供云端同步，也不把
素材库自动上传到远端服务。

默认服务只绑定 `127.0.0.1`。浏览器扩展是可选集成：独立 `npm start` Runtime
只有在显式配置本地 ingest Token 和允许的扩展 origin 后才启用；Packaged Desktop
会在本地自动生成 Token，并只授权固定的 GravityPort 扩展 origin 完成配对。

桌面版的出站连接仅限：更新清单与更新包、匿名使用统计、C2PA helper 下载、用户主动连接时的
Pinterest 授权中转与 Pinterest API，以及用户在设置页点击发送时的反馈转发；它们都不携带
素材库内容（见 [PRIVACY.md](PRIVACY.md) 的 Network Boundary）。

命名兼容：产品由 MOSA 更名为 GravityPort 后，以下标识有意保留旧名，以兼容现有安装和
集成：npm 包名与 CLI 别名 `mosa`、`bin/mosa.mjs`、`lib/mosa-runtime.mjs`
（`startMosaRuntime()`）、所有 `MOSA_*` 环境变量、数据库文件 `mosa.db`、`/api/health`
返回的 `product: "mosa"`、请求头 `x-mosa-token` / `x-mosa-client-token`，以及 Cowart
默认路径中的 `mosa` 目录。

## 2. 运行时分层

```text
┌──────────────────────────────────────────────────────────────┐
│ 客户端                                                      │
│  浏览器静态 UI         Electron 桌面壳        MCP stdio 客户端 │
│  web/gravityport/dist  desktop/main.mjs       Codex 等工具   │
└───────────────┬──────────────────┬──────────────────┬────────┘
                │ HTTP              │ HTTP              │ JSON-RPC/stdio
                ▼                   ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│ GravityPort 本地运行时                                       │
│  server.mjs → lib/mosa-runtime.mjs                           │
│  Node node:http、静态资源处理、API 分发、运行时锁和安全边界   │
└───────────────┬──────────────────┬──────────────────┬────────┘
                │                  │                  │
                ▼                  ▼                  ▼
        资产存储与 API       桥接与发现          衍生任务 worker
        SQLite/JSON 回退      Codex/Grok/Cowart    sharp 图像处理
        better-sqlite3        ChatGPT 桌面版同步   原图不被改写
                              可选 Web Capture
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│ 本地文件系统                                                 │
│  SQLite 数据库、原图、预览、缩略图、Prompt/来源和迁移备份      │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 客户端

只有一份 UI：`web/gravityport/` 是 React + Vite 的界面源码。`src/` 下
`App.tsx` 负责页面状态、事件绑定、导航和 API 调用；画廊窗口化、选择、
拖拽、右键菜单、回收站、版本树、滚动记忆、偏好等逻辑拆分为同目录下的
纯逻辑模块（可独立编译测试），界面组件和样式在 `src/` 与 `index.css`。
界面以中文文案为源，英文对照在 `src/i18n.ts`。

`npm run build` 先由 Vite 把源码构建到 `web/gravityport/dist/`，再由
`scripts/write-build-identity.mjs` 在该目录写入 `build-identity.json`。
本地运行时经同源静态服务提供这个目录（`lib/mosa-runtime.mjs` 的默认
appDir 就是 `web/gravityport/dist`）；服务运行前必须先完成构建。

`uiFingerprint` 以 `lib/build-identity.mjs` 的 `computeUiFingerprint()`
计算：对 appDir 下除 `build-identity.json` 外的每一个文件，把相对路径和
文件内容一起做 SHA-256，没有扩展名白名单；因此 dist 中任何可被静态服务
交付的文件变化都会改变构建身份。源码侧另有 `scripts/check-dead-code.mjs`
门禁：`lib/`、`web/gravityport/src/`、`desktop/`、`mcp/`、`scripts/` 中没有被其他跟踪文件
引用的模块、没有消费者的导出符号和未被使用的 CSS 类都会让检查失败；`web/gravityport/src`
下的文件还必须被 git 跟踪或忽略。

Electron 桌面壳由 `desktop/main.mjs`、`desktop/preload.cjs` 和
`desktop/service-manager.mjs` 组成。它与浏览器端共用同一份
`web/gravityport/dist` 构建产物（打包进应用，forge 包内唯一 UI 路径），
并通过受限的 preload API（`window.electronAPI`）处理桌面能力：剪贴板粘贴写入导入暂存区、
写剪贴板、原生拖出与拖回去重判定、受控更新的检查/下载/安装、打开外链与 Pinterest 授权页、
切换库位置和窗口全屏同步。导入成功和可用更新的系统通知由主进程
直接发出；在系统文件管理器中定位原件走运行时的 `POST /api/open-folder`。业务数据仍由同一个
本地 HTTP 运行时提供。更新（`update-service.mjs`、`macos-updater.mjs`、
`windows-updater.mjs`）、匿名统计（`anonymous-usage.mjs`）、扩展配对 Token
（`web-capture-pairing.mjs`）、旧视觉数据清理（`legacy-visual-cleanup.mjs`）、C2PA helper
安装和改名提示各在 `desktop/` 下独立成模块。

操作系统差异集中在 `desktop/platform/index.mjs`。当前 adapter 只负责桌面壳
边界，例如 macOS traffic lights、Windows 原生标题栏/菜单栏策略和窗口生命周期
钩子；业务逻辑、素材库 UI、HTTP runtime 和存储实现不按平台复制。Windows
默认隐藏 Electron 原生 application menu 的可见菜单栏，但仍安装 application menu，
以保留 `Ctrl+F`（搜索）以及编辑、视图菜单中的系统快捷键。

### 2.2 本地 HTTP 运行时

`server.mjs` 是服务入口，调用 `lib/mosa-runtime.mjs` 的
`startMosaRuntime()`。运行时使用 Node 内置 `node:http` 创建服务器，使用
`lib/api-routes.mjs` 将请求分发到：

- `lib/api/asset-routes.mjs`：素材创建、导入暂存与批量导入、查询、元数据与精选、收藏、归档、复制、版本、Stack 和回收站。
- `lib/api/generation-routes.mjs`：生成事件、生成关系、单次 lineage 查询，以及资产详情所需的聚合生成历史。
- `lib/api/library-routes.mjs`：项目、分组、库路径和受限文件夹操作。
- `lib/api/bridge-routes.mjs`：健康检查、桥接状态、Web Capture 配对与 ingest（含分块上传、状态上报、对话标题与轮次绑定）、ChatGPT 桌面版对话的下发与结果回报，以及 Cowart 画布。
- `lib/api/pinterest-routes.mjs`、`lib/api/feedback-routes.mjs`：Pinterest 连接和设置反馈。
- `lib/http-response.mjs`：JSON 请求体读取、响应和 HTTP 错误处理。

同一运行时还负责静态 UI、`/library/` 下的原图和衍生图读取、内容安全策略、
Host（DNS rebinding）与 loopback origin 检查、管理请求的 client token 校验、运行时锁、
回收站定时清理和桥接生命周期。服务启动时监听
`127.0.0.1:43517`；可通过 `MOSA_PORT` 覆盖，端口为 `0` 时由操作系统分配。

### 2.3 MCP

`mcp/server.mjs` 是独立的 JSON-RPC over stdio MCP 服务。它直接打开同一资产存储，
不创建额外的 HTTP 端口：SQLite 库依靠 WAL 与桌面/Web 运行时并存；JSON 兼容库必须独占
运行时锁，不能与正在运行的 App 同时写入。库位置按 `GRAVITYPORT_LIBRARY_DIR`、配置里的
`GRAVITYPORT_LIBRARY_LOCATION_FILE`、桌面版 userData 下的 `library-location.json`
（无复制配置时兜底读取）的顺序解析；任何位置都找不到库时报错退出，MCP 永远不新建素材库。
开库后每次工具调用前都会核对 `mosa.db` 的设备号与 inode，库被移动或删除时拒绝读写并返回
`LIBRARY_DATABASE_CHANGED`。本地视觉检索已移除：`asset_search` 只做文本与时间检索，老客户端
缓存旧 schema 传来的 `visual: true` 会被接受并忽略。当前工具覆盖：

- `asset_create`、`asset_list`、`asset_get`
- `asset_search`（文本与时间范围组合）、`asset_provenance_export`（导出脱敏 provenance bundle 与未签名的 C2PA assertion payload）
- `asset_update_metadata`、`asset_attach_prompt`
- `asset_archive`、`asset_duplicate`
- `asset_version_create`、`asset_version_history`、`asset_recipe_history`
- `generation_record`、`generation_list`
- `generation_relation_record`、`generation_lineage`

生成事件独立于去重后的 Asset：同一媒体内容可以对应多次生成事件。生成关系连接
Generation Event，而不是复用 `parent_asset_id`。普通 HTTP/MCP 调用方只能声明
`user_confirmed`、`observed` 或 `inferred`；`provider_verified` 保留给 GravityPort 直接
观察到官方 provider 响应的受信集成。

资产检视器通过 `GET /api/assets/:project/:asset/generation-history` 读取与当前素材
相关的全部 Generation Event，并合并这些事件所在的 lineage component。这样即使
同一个去重后的 Asset 对应多次独立生成，UI 也不会把它们错误压成一个版本节点。
聚合结果还会返回同一 provider、同一 conversation 中尚未与当前 lineage 建立关系的
`context_events`、持久化的 `relation_candidates`，以及这些事件输出素材的轻量
`output_assets`。ChatGPT Relation Resolver（`lib/generation-history.mjs` 的
`resolveGenerationRelationCandidates()`）只生成候选关系：同 conversation、相邻生成、
修改语义、参考图/provider asset 等信号会形成置信度与 evidence，但不会直接写入版本树。
候选可以被用户确认或忽略，用户也可以手动添加关系；确认后才通过 Generation
Relation 写入 `user_confirmed` 边，被否决的候选会持久化为 dismissed，后续解析不会反复
弹回。公共管理面可以创建、修改或删除非 `provider_verified` 关系，官方验证关系保持只读。

服务声明的 MCP server version 为 `0.2.0`；产品版本仍以 `package.json` 为准。

### 2.4 本地视觉检索（已移除）

本地以图搜图（Visual Pack、SigLIP2 embedding、视觉关系索引、`/api/visual/*` 路由、
MCP `asset_search` 的 `visual` 检索、设置「模型」页与检视器「相关推荐」）已整块移除：
找图靠分组、自动堆叠、搜索框与对话 AI。桌面启动时由 `desktop/legacy-visual-cleanup.mjs`
清理旧版本留在 Electron `userData` 下的视觉包、暂存与索引目录。MCP 老客户端缓存旧
schema 传来的 `visual: true` 会被接受并忽略，照常返回文本检索结果。

## 3. 仓库模块与构建

```text
web/gravityport/          React 界面源码（src/）与 Vite 构建产物（dist/）
server.mjs               本地 Web 服务 CLI 入口
lib/mosa-runtime.mjs     HTTP 运行时编排和静态资源服务
lib/api-routes.mjs       API 总分发
lib/api/*.mjs            素材、生成历史、库、桥接/Web Capture、Pinterest 和反馈路由
lib/pinterest/           Pinterest OAuth、token 存储与 API 客户端
lib/feedback/            反馈转发配置
lib/asset-store.mjs      存储选择和 JSON 兼容实现
lib/sqlite-asset-store.mjs SQLite 实现（better-sqlite3）
lib/*.mjs                Node 运行时模块
lib/*.ts                 TypeScript 源码；构建后生成运行时 JS/声明文件
desktop/                 Electron 主进程、preload、服务管理和 Forge 配置
desktop/platform/        桌面操作系统 adapter（macOS / Windows / generic）
mcp/server.mjs           MCP stdio 服务
bin/mosa.mjs             库维护 CLI（gravityport / mosa）
extensions/              可选 Chrome Web Capture 扩展
scripts/                 构建、启动、迁移、验证和 QA 脚本
docs/                    使用、运维、发布和模型评估文档
test/                    Node 测试和契约测试
```

根目录 `tsconfig.json` 将 `lib/**/*.ts` 编译为 ES2022/Node16 模块；
`web/gravityport` 用 Vite 构建 React 界面。
`npm run build` 先构建 GravityPort UI 到 `web/gravityport/dist`
（`scripts/build-gravityport-ui.mjs`），再运行 TypeScript 编译，最后由
`scripts/write-build-identity.mjs` 把构建身份写入 dist 的
`build-identity.json`。运行服务、MCP 或桌面壳前，
必须让对应的构建步骤完成；源码中的 TypeScript 文件是修改入口，编译生成的
JS、声明文件和 dist 产物不是独立的架构层。

可确认的本地脚本入口：

```text
npm start                 启动 Node 本地服务
npm run mcp               启动 MCP stdio 服务
npm run desktop:start     启动 Electron 本地开发壳
npm run desktop:package   Forge 打包 macOS arm64 应用目录，并运行包校验和打包冒烟测试
npm run desktop:make      打包 macOS arm64 应用，生成更新 ZIP，并用 scripts/make-macos-dmg.mjs 生成 DMG
npm run desktop:package:windows  Forge 打包 Windows 10/11 x64 应用目录
npm run desktop:make:windows     Forge 生成 Windows x64 ZIP（开发产物）
npm run build             构建 UI、编译 TypeScript 并写入构建身份
```

`desktop/forge.config.mjs` 以目标平台驱动 Electron Forge、原生模块解包和依赖
筛选。`darwin-arm64` 使用 macOS 原生 `better-sqlite3`/Sharp runtime，`win32-x64`
使用 Windows 对应 native binding；不支持的目标会直接失败。仓库提供的是本地
开发/打包流程；本地构建不等同于已签名的发布安装包。

跨平台文件路径由 `lib/path-safety.mjs` 和 `lib/source-locations.ts` 等共享边界
统一处理。Windows drive-letter、UNC、跨盘 `relative()` 等情况不能按 POSIX `/`
规则判断，也不能把 `C:\\...` 错认成 URL。Codex/Grok/Cowart 默认来源路径集中
到 source-location resolver，但某个来源在 Windows 上的真实目录只有经过真机验证
后才进入正式默认值，避免用猜测替代来源契约。

## 4. 服务生命周期

### 4.1 Node 服务

`startMosaRuntime()` 的主要顺序如下：

1. 解析项目根、库目录、端口、Codex/Grok/Cowart 来源路径、client token 和可选桥接
   配置，并冻结本进程的构建身份。
2. 先执行运行时隔离检查，再取得该库的运行时锁（`<库目录>/.mosa-runtime.lock`），
   避免同一库重复写入。
3. 选择存储（见 5.1）并创建库变更流；桌面版创建 Pinterest 客户端；创建（但不启动）Codex、ChatGPT 桌面版同步、Grok、Cowart、
   Cowart discovery 桥接和衍生任务 worker，安装每小时一次的回收站清理；确保 `default`
   项目存在。
4. 创建 Node HTTP 服务并监听 loopback，返回 `url`、端口、库目录、存储类型、构建身份、
   `clientToken` 和 `stop()`。
5. 监听成功后才开始后台工作：约 1 秒后并行启动各桥接（可按 `GRAVITYPORT_DISABLE_BRIDGES`
   禁用，单个桥接启动失败只记日志）；约 1.8 秒后执行一次回收站清理、历史孤立衍生文件
   回收，以及缺失尺寸/缩略图/预览素材的重新入队，三者结束后才启动衍生任务 worker。
   这些维护失败只记日志，不影响服务可用。

停止时，运行时先停止接受新的长期连接并主动结束 Library SSE 响应，再关闭
HTTP listener；随后等待 derivative worker 与所有桥接排空正在执行的任务，
最后关闭存储并释放运行时锁。这个顺序避免 `server.close()` 与 SSE/后台任务
互相等待。服务不会为释放端口而终止未验证的其他进程。

### 4.2 Electron 服务归属

Electron 启动时由 `desktop/service-manager.mjs` 探测
`GET /api/health`（必要时使用库路径和桥接状态兼容探测）：

- 已有服务的库目录相同，且完整服务身份一致（`serviceProtocolVersion`、
  `productVersion`、`gitSha`、`uiFingerprint`、`runtimeFingerprint` 与 client token
  指纹 `clientAuthFingerprint`）：桌面壳附着到该服务，不拥有它。
- 没有可附着的服务：桌面壳启动并拥有一个本地运行时，退出时停止自己拥有
  的运行时。
- 正常桌面升级遇到同库的已验证旧版本时：先受控退出旧 owner，再由当前桌面
  进程接管同一端口和 Library；如果另一个进程抢先成为 owner，只接受完整构建
  身份与当前版本完全一致的服务，否则 fail-closed。
- 端口被其他服务占用，或 GravityPort 服务使用了不同库：报告冲突，不替换或终止
  原服务。

Web UI 启动时同时读取 `/api/health` 与静态 `build-identity.json`，在加载图库
数据前校验 product/UI/runtime fingerprint。长生命周期旧 Runtime 即使从磁盘
读到了新版静态文件，也不能继续以旧 API 契约驱动新版界面。

桌面默认使用 `127.0.0.1:43517`；默认库目录统一由 `lib/library-location.mjs` 的
`resolveLibraryLocation()` 解析：`GRAVITYPORT_LIBRARY_DIR` 优先；其次桌面版的
`library-location.json`（记录损坏或记录的库不存在时报错退出，不退回默认、
不新建库）；否则 `$HOME/MOSA Library` 里有库就用它，`$HOME/GravityPort Library`
里有库就用它，两处都没有才在 `$HOME/GravityPort Library` 新建（只有这一条
允许指向不存在的目录）。如需独立运行时，使用 `MOSA_DESKTOP_PORT` 和
`GRAVITYPORT_LIBRARY_DIR` 明确指定；未设置 `MOSA_DESKTOP_PORT` 时，桌面壳在 `43517`–`43521`
中探测并回退端口。

桌面版可在「设置 → 存储 → 修改」移动自己拥有的库：先停止运行时，经
`lib/library-relocation.mjs` 完整复制到空目录（跳过 `.mosa-runtime.lock`），成功后写入
`library-location.json` 并重启，最后才删除旧目录；设置了 `GRAVITYPORT_LIBRARY_DIR` 或附着到
外部服务时不允许移动。macOS 上可选的 Web Capture 后台 supervisor 与桌面壳通过库目录中的
`.mosa-desktop-starting.json` 交接标记协调，细节见 [docs/operations.md](docs/operations.md)。

### 4.3 桌面更新与匿名统计

`desktop/update-service.mjs` 从 `https://gravityport.azhuilab.com/releases/gravityport/latest.json`
拉取发布清单（禁止重定向），配置了发布公钥时先用 `lib/release-manifest-signature.mjs`
校验签名，再按版本号和发行通道判断能否更新。`desktop/macos-updater.mjs` /
`desktop/windows-updater.mjs` 从 `https://gravityport.azhuilab.com/downloads/` 下载对应平台的
更新包，校验 SHA-256 与签名身份（macOS Team ID / Windows 签名证书指纹）后交给分离的
helper 替换应用并重启。打包版在首次启动和每个统计日各发一次无请求体的 `HEAD` 请求，把
随机安装 ID、平台、架构和版本附在同一清单地址上作为匿名使用统计
（`desktop/anonymous-usage.mjs`）；设置 `GRAVITYPORT_DISABLE_TELEMETRY=1`、QA 运行或未打包的
开发壳都不会发送。发布流程见 [docs/releasing.md](docs/releasing.md)。

## 5. 存储与媒体处理

### 5.1 存储选择

`lib/asset-store.mjs` 的 `createAssetStore()` 按以下顺序选择存储：

- `mosa.db` 存在且迁移状态为已完成：使用 `lib/sqlite-asset-store.mjs` 和 `better-sqlite3`。
- 数据库缺失但存在 `.sqlite-migration-completed` 标记：报错 `SQLITE_LIBRARY_MISSING`，
  要求恢复 `mosa.db`，不会退回旧 JSON 快照。
- `mosa.db` 存在但迁移未完成（可能是中断的迁移）：fail-closed，保持 JSON 兼容存储。
- 库目录中没有任何旧 JSON 数据的全新库：直接新建 SQLite 库。
- 其余情况（有旧 JSON 数据且尚未迁移）：保留 JSON 兼容存储，以便先检查再用
  `gravityport migrate` 迁移；不会因为升级程序而自动删除旧数据。

SQLite 数据库路径为 `<库目录>/mosa.db`（默认库目录按上文
`resolveLibraryLocation()` 解析，也可由 `GRAVITYPORT_LIBRARY_DIR` 指定）。SQLite schema 版本以
`lib/sqlite-asset-store.mjs` 导出的 `CURRENT_SCHEMA_VERSION` 为唯一权威；不要在
运维或架构文档中复制一个容易随迁移失效的数字。数据库启用 WAL、外键和 busy timeout。主要表和索引包括：

- `projects`、`groups`、`assets`：项目、分组、素材原数据、哈希、来源和状态。
- `tags`、`asset_tags`：标签关联。
- `asset_versions`：父子版本关系和变更摘要。
- `recipe_snapshots`：不可变的生成配方快照，包括 Prompt、模型、提供方、技能、
  比例、主题、引用和 provenance。
- `asset_stacks`、`asset_stack_members`、`auto_stack_exclusions`：手动或按会话自动生成的
  Stack、成员顺序，以及用户移出自动 Stack 后的排除记录。
- `generation_events`、`generation_relations`、`generation_relation_candidates`、
  `generation_conversations`：生成事件、已确认的生成关系、待确认/已忽略的关系候选，以及
  ChatGPT 对话轮次同步状态（`lib/generation-message-binding.mjs`）。
- `library_changes`、`pending_derivative_changes`：Library Change Journal
  （`/api/library-changes` 的数据源）以及把衍生图完成合并为一次修订的暂存表。
- `derivative_jobs`：可恢复的缩略图/中图/预览任务。
- `automatic_ingest_suppressions`：用户删除后按内容/像素哈希抑制自动重新收录的
  轻量记录；不保存图片、Prompt 或原始 URL。
- `migration_issues`、`library_meta`、`schema_migrations`：迁移和 schema 状态。
- `asset_fts`：SQLite FTS5 trigram 全文索引，用于资产文本搜索。
- `asset_short_terms`：短 Unicode 搜索辅助索引。它为资产搜索文本维护 1–2 个 Unicode
  code point 的非 ASCII 子串候选，用于避免中文等短词退化为全库 `LIKE` 扫描；
  最终筛选与排序语义仍由普通资产查询负责。该索引是本地派生数据，不是 embedding
  或语义搜索索引，可由资产元数据重新构建。

进入搜索文本、FTS 和短词索引的字段由 `lib/asset-search-scope.mjs` 白名单决定（Prompt、
用户原话、provider/model、标签、名称等），路径、哈希和采集内部字段不参与搜索。

### 5.2 文件与衍生物

迁移完成的库使用如下逻辑布局（`$HOME` 只是示例根目录）：

```text
$HOME/GravityPort Library/
├── mosa.db                         SQLite 数据库（文件名沿用旧名）
├── .sqlite-migration-completed     迁移完成标记
├── .mosa-runtime.lock              运行时锁
├── .mosa-desktop-starting.json     桌面启动/更新交接标记（短时存在）
├── .chatgpt-desktop-sync.json      ChatGPT 桌面版对话同步状态
├── .schema-backups/                schema 升级前的数据库备份
├── assets/
│   ├── <project-id>/
│   │   ├── original/               原始媒体
│   │   ├── thumbnails/             400px WebP 缩略图
│   │   ├── mediums/                960px WebP 中图
│   │   └── previews/               1600px WebP 预览
│   └── import-staging/             浏览器/手动上传暂存区
├── reference-attachments/          Web Capture 参考图私有附件
├── .web-capture-tmp/               网页捕获暂存区
└── legacy-json-backup/             迁移产生的 JSON 备份
```

资产原件以 `<asset-id><扩展名>` 写入 `assets/<project-id>/original/`（asset id 由净化后的
文件名加时间戳与随机串组成），复制后重新计算 SHA-256 并与导入前比对；去重依据内容哈希和
像素哈希。Codex 原件在同一文件系统上优先用硬链接，否则复制。原始字节不被衍生处理覆盖。
`lib/derivative-worker.ts` 从 SQLite `derivative_jobs` 认领任务，交给独立子进程
`lib/derivative-processor.ts`（Electron 下为 utilityProcess）用 `sharp` 生成 400px 缩略图、
960px 中图和 1600px 预览（均为 WebP），同时记录宽高与主色；任务状态持久化，重启后可继续，
启动维护还会把缺少尺寸、缩略图或预览的旧素材重新入队。视频不经过 `sharp` 或转码，按原始
媒体提供播放；界面用 `<video preload="metadata">` 显示首帧作为缩略图。

HTTP 读取路径由 `lib/mosa-runtime.mjs` 实现：

```text
/library/:project/images/:file         原始媒体
/library/:project/mediums/:id.webp     图像中图
/library/:project/previews/:id.webp    图像预览
/library/:project/thumbnails/:id.webp  图像缩略图
/library/:project/references/:file     Web Capture 引用附件
```

迁移、备份和维护通过 `bin/mosa.mjs` 提供（命令名用 `gravityport`，`mosa` 仍可用）：

```text
gravityport migrate [--library <path>] [--from <legacy-assets>] [--dry-run] [--resume]
gravityport verify [--library <path>]
gravityport backup [--library <path>] --to <backup-dir>
gravityport backup-verify --from <backup-dir>
gravityport restore --from <backup-dir> --to <empty-library-dir>
gravityport thumbnails <rebuild|repair> [--library <path>]
```

### 5.3 回收站

删除素材只写入 `deleted_at`，移出全文索引和衍生任务，并记录
`automatic_ingest_suppressions`，防止桥接把同一内容自动收回；仍有未删除子版本的父版本
不能移入回收站。回收站条目保留 90 天（`TRASH_RETENTION_MS`）：运行时监听后先清理一次，
之后每小时分批清理过期条目。永久删除（单条、清空回收站或过期清理）先把原件和衍生文件
移入隐藏的 `.trash-purge-*` 暂存目录，数据库提交后再删除文件；中断的清理在下次运行时
恢复或完成（`lib/trash-files.mjs`）。

## 6. API 边界

以下为当前路由分组；具体字段和状态码以 `lib/api/*.mjs` 为准。

| 范围 | 当前能力 |
| --- | --- |
| `/api/health` | 产品/构建身份、库目录和存储信息 |
| `/api/navigation`、`/api/library-revision`、`/api/library-events` | 侧栏统计、库修订号与 SSE 变更通知 |
| `/api/library-changes` | Library Change Journal 增量查询：按 `since` 游标回放两个 revision 之间的变更记录，journal 被剪枝时返回显式 gap |
| `/api/gallery-rows` | 增量 reconciliation 取数：按受影响素材 id 集合返回当前画廊请求语义下的视图行与 asset→row 映射 |
| `/api/assets` | 分页列表、搜索和筛选；创建、读取、元数据更新、收藏、归档、批量操作、复制 |
| `/api/asset-stacks` | 创建、读取、解散 Stack，管理成员与手动顺序 |
| `/api/assets/:project/:asset/versions` | 读取版本树或创建子版本 |
| `/api/assets/:project/:asset/recipes` | 读取生成配方快照历史 |
| `/api/projects`、`/api/groups` | 列出项目、列出或创建分组 |
| `/api/groups/:name`、`/api/groups/:name/merge`、`/api/groups/:name/stats`、`/api/group-order` | 分组改名/设置、删除、合并、统计与排序 |
| `/api/assets/:project/:asset/curation`、`/api/assets/:project/:asset/favorite` | 精选标记与精选备注、收藏 |
| `/api/assets/:project/:asset/generation-history` | 检视器使用的聚合生成历史（见 2.3） |
| `/api/generations`、`/api/generations/:id/lineage` | 列出或记录 Generation Event；读取单次生成所在的 lineage |
| `/api/generation-relations`、`/api/generation-relation-candidates` | 创建、修改、删除非 `provider_verified` 的生成关系；把候选标记为 suggested 或 dismissed |
| `/api/library-path`、`/api/open-folder` | 返回库边界信息；只允许打开受信任的库/来源目录 |
| `/api/bridges`、`/api/web-capture` | Codex、Grok、Cowart、Web Capture 和 discovery 状态 |
| `/api/ingest/web-capture`、`/api/ingest/web-capture-metadata`、`/api/ingest/web-capture-binary`、`/api/ingest/web-capture-upload/*` | 通过统一 Token/origin 策略接收网页捕获、元数据补全、二进制和分块上传 |
| `/api/cowart-canvases` | 列出、注册和移除受信任的 Cowart 画布 |
| `/api/trash` | 回收站：清空指定项目的回收站；单条恢复/永久删除走 `/api/assets/:project/:asset/restore` 与 `/api/assets/:project/:asset/permanent` |
| `/api/asset-stacks/move` | 在堆叠之间批量搬移素材（剪切/粘贴与拖拽落点共用） |
| `/api/import/stage`、`/api/assets/import-batch` | 导入暂存：`POST` 把浏览器/手动上传的文件流式写入 `<库目录>/assets/import-staging/`，`DELETE` 清理暂存文件；`import-batch` 分批入库（桌面粘贴由主进程直接写入 `userData` 暂存区） |
| `/api/feedback/diagnostics`、`/api/feedback/submit` | 设置反馈页：读取脱敏诊断日志预览；校验并转发一条反馈到收集服务 |
| `/api/pinterest/connect`、`/api/pinterest/callback`、`/api/pinterest/status`、`/api/pinterest/boards`、`/api/pinterest/boards/:id/pins`、`/api/pinterest/disconnect` | Pinterest 连接：本机 OAuth 回调、连接状态、画板/Pin 浏览与断开 |
| `/api/ingest/web-capture-turn-bindings` | 采集插件上报对话结构（消息号与轮次绑定），供版本树按对话轮次显示 |
| `/api/generation-message-bindings` | 生成记录补齐消息号与轮次的服务端写入接口 |
| `/api/web-capture/pair`、`/api/web-capture/retry` | 扩展配对（桌面版自动发放 Token）与重试请求计数下发 |
| `/api/ingest/web-capture-status`、`/api/ingest/web-capture-session-title`、`/api/ingest/web-capture-desktop-sync` | 扩展状态上报（响应中下发重试请求与 ChatGPT 桌面版待同步对话）、对话标题回写 Stack 名称、桌面版对话同步结果回报 |

所有请求先经过 Host 校验：`Host` 必须是 `127.0.0.1`、`localhost` 或 `::1`，且端口等于
实际监听端口，以阻止 DNS rebinding。普通 API 只接受无 Origin 或同源 loopback Origin；其中
所有非 GET/HEAD/OPTIONS 的 `/api/*` 管理请求还必须携带运行时 client token：页面脚本用
`x-mosa-client-token` 头，或使用服务返回 `index.html` 时下发、按端口区分的
`mosa-browser-client-<port>` Cookie（HttpOnly、SameSite=Strict）。token 来自
`MOSA_CLIENT_TOKEN`，未设置时每次启动随机生成；桌面版持久化在 `userData` 中。只读 GET
（健康检查、列表、SSE）不要求 token。Web Capture 路由走另一套边界：预检和跨 origin 请求
只有在 origin 位于显式允许列表时才放行，且必须提供 ingest Token；`/api/web-capture/pair`
和扩展 origin 发来的 `/api/health` 只接受允许列表中的扩展 origin。响应统一设置 CSP
（`img-src` 额外放行 `https://i.pinimg.com` 以显示 Pinterest 图片）、`nosniff` 和同源资源
策略等安全头。判定逻辑在 `lib/server-security.ts`。

## 7. 桥接与数据流

### 7.1 Codex

`lib/codex-image-bridge.ts` 监视 Codex 自己的生成图像目录，并读取同一 Codex 根
下的会话数据匹配任务、Prompt、模型和生成时间。Codex 根优先取 `CODEX_HOME`；
未设置时 macOS/Linux 默认为 `$HOME/.codex`，Windows 默认为
`%USERPROFILE%\.codex`。因此默认素材目录为 `<CODEX_HOME>/generated_images`，
会话目录为 `<CODEX_HOME>/sessions`。

Codex 自动收录是双来源模型，而不是只靠一个图片目录：

- **文件来源**：监听 `<CODEX_HOME>/generated_images`，发现真实落盘图片后按来源路径、
  SHA-256 和像素哈希去重，并从对应 session 补齐 Prompt、模型、call ID 和生成时间。
- **会话来源**：同时监听 `<CODEX_HOME>/sessions`。`lib/codex-session-index.ts` 对 JSONL
  维护进程内字节游标；首次读取完整文件，后续只读取新增的完整行。识别的生成事件包括
  `image_generation_call` / `image_generation_end`，以及新版 Codex code mode 写出的
  `item_completed` 事件（`item.type` 为 `Extension`、`kind` 为 `image_gen.generation`）。
  若事件携带图片 `result`，但标准
  `generated_images` 文件不存在，GravityPort 可以从 session 恢复图片，不会因为 Codex
  某次未落盘而漏收。

标准文件始终优先。只有标准图片不可用时才启用 session result 恢复。
`lib/codex-session-recovery.ts` 会先限制事件与图片体积、校验 base64 并按二进制签名
识别真实图片格式，再写入 GravityPort 私有临时目录；素材库完成 copy 后立即删除临时文件。
session 中的任意 `saved_path` 不会因此成为新的受信任文件根。恢复出来的素材继续走
与标准文件相同的 automatic-ingest suppression、内容哈希、像素哈希和资产创建链。

图片目录和 session 目录都使用 watcher；watcher 不可用时由轮询兜底。GravityPort 不会为了
监听而创建 Codex 的 `sessions` 目录，Codex 后续创建目录后轮询会自动重新挂载 watcher。
Prompt 优先取生成事件里的 revised prompt；没有时退回该任务最后一条用户消息（若带有
Codex 的「# Files mentioned by the user」前缀，只保留 `## My request:` 之后的正文）；两者
都没有才明确记录为不可用，不会凭空生成 Prompt。会话中稍后出现 revised prompt 时，桥接会
升级已入库素材的 Prompt。

GravityPort 不把 Codex 的 workspace、Documents、Desktop、Downloads 或任意项目目录当作
默认素材扫描根。若用户确实修改了 Codex 本身的存储根，应配置 Codex 官方的
`CODEX_HOME`；GravityPort 会跟随同一个根，而不是另外发明一套默认目录。

### 7.2 Grok Build CLI

`lib/grok-media-bridge.ts` 读取配置的 `$HOME/.grok/sessions`（可由
`GROK_SESSIONS_DIR` 覆盖），只发现会话目录中的图像和视频，并从同会话的
`chat_history.jsonl` 提取可匹配的工具上下文。来源路径必须位于受信任的会话
根目录内。

### 7.3 Cowart

`lib/cowart-bridge.ts` 归档受信任画布快照中的图像；
`lib/cowart-canvas-discovery.ts` 可从近期 Codex 会话发现 Cowart 项目；
`lib/cowart-bridge-manager.ts` 管理主画布和已注册外部项目，
`lib/cowart-project-registry.ts` 读写外部项目注册表。

默认管理画布目录为 `<CODEX_HOME>/cowart-data/mosa`，GravityPort 自己的 Cowart registry
默认为 `<CODEX_HOME>/mosa/cowart-projects.json`。外部画布必须通过路径、
目录标记、非 symlink 和项目内边界校验；不可信条目可以移除，但不会启动 watcher。

### 7.4 Web Capture

`extensions/chatgpt-web-capture/` 是可选浏览器扩展，当前 provider 为 ChatGPT、
Gemini、Flow 和 Google AI Studio。扩展只向配置的本地 GravityPort 地址发送捕获的媒体
字节、页面来源和能安全匹配的 Prompt/对话上下文；服务端 `lib/web-capture-ingest.ts`
对图像用 `sharp` 校验格式、尺寸、像素数（≤40M 像素、≤15 MiB）和 MIME，对 Flow 与
Google AI Studio 的视频按容器签名和大小（≤96 MiB，可分块上传）校验，并用 SHA-256 去重。

独立的 `npm start` Web Runtime 使用 Web Capture 时必须同时配置：

- `GRAVITYPORT_WEB_CAPTURE_TOKEN`：请求的 Bearer 或 `x-mosa-token` 凭据；
- `GRAVITYPORT_WEB_CAPTURE_ORIGINS`：精确的 `chrome-extension://...` 或
  `moz-extension://...` origin 列表。

Desktop Runtime 不要求用户手工填写这两个值。Electron 首次启动会在
`userData` 中生成并持久化随机 Token，默认授权 GravityPort 的两个固定扩展 origin
（未打包开发版与 Chrome Web Store 版）；扩展会在
`43517` 到 `43521` 的本机 discovery 端口中先验证 `/api/health`，再通过仅允许
该扩展 origin 的配对路由取得 Token。若首选端口被其他程序占用，Desktop 会在
同一 discovery 端口集合内选择可用端口，且不会终止或替换已有监听进程。

ChatGPT 在可用时保留消息范围上下文；其他 provider 只保留能安全匹配的、页面
可见的局部 Prompt，并明确标为未验证的 provider-visible Prompt。参考图像进入
独立的私有引用附件存储，不自动成为普通画廊素材。

### 7.5 ChatGPT 桌面版对话

ChatGPT 桌面版（与 Codex 同一个 App）不把聊天中的生成图或聊天文本写到本机，Codex
桥接和浏览器扩展都看不到它们。`lib/chatgpt-desktop-sync.mjs` 只负责认出“刚用过的
对话”，图像仍由已配对的 Web Capture 扩展按普通 ChatGPT 页面流程采集：

- 运行时随 Codex 桥接一起启动它（`GRAVITYPORT_DISABLE_BRIDGES` 含 `codex` 时一并禁用），每
  10 秒轮询 `<CODEX_HOME>/.codex-global-state.json`，只读取桌面聊天绑定的 ChatGPT 对话号，
  以及每段对话最后一次提问的消息编号。
- 新绑定的对话，或最后一次提问编号发生变化的对话，记为“有活动”；首次运行时把已有绑定
  各标记一次以补采。状态写在 `<库目录>/.chatgpt-desktop-sync.json`，只保存对话号、时间戳、
  重试计数和提问编号的截断 SHA-256，不读入 Prompt 文本，最多跟踪 200 段。
- 对话静默 90 秒后，在扩展调用 `POST /api/ingest/web-capture-status` 时随响应下发；只发给
  声明 `desktopSync: true`（自动入库已开且当前没有同步窗口）的扩展，一次一段，下发后租约
  5 分钟。
- 扩展先用浏览器自己的 ChatGPT 登录读取该对话：确认没有生成图就回报 `no-images`；否则在
  最小化、不抢焦点的窗口中打开 `https://chatgpt.com/c/<对话号>#gravityport-desktop-sync`
  采集，页面采集安静 10 秒（至少 20 秒、最多 110 秒）后关窗，整段任务 150 秒超时。结果经
  `POST /api/ingest/web-capture-desktop-sync` 回报 `captured`、`no-images`、`failed` 或
  `timeout`，每次活动最多尝试 3 次。
- 这两条路由属于 Web Capture 路由集合，走 ingest Token 与扩展 origin 边界。数据边界见
  [PRIVACY.md](PRIVACY.md#chatgpt-desktop-app-conversations)。

### 7.6 Pinterest（暂未开放）

`lib/pinterest/` 与 `lib/api/pinterest-routes.mjs` 实现只读的 Pinterest 画板浏览；侧栏入口
和设置里的「连接」页在 `App.tsx` 中由常量 `PINTEREST_ENTRY` 关着（默认隐藏），等待 Pinterest 批准正式 API 访问。客户端只在桌面版创建；
OAuth 回调地址固定为 `http://localhost:43517/api/pinterest/callback`，运行时不在 43517
端口时连接返回 `PINTEREST_PORT_MISMATCH`。授权码与 refresh token 经
`https://gravityport.azhuilab.com/api/pinterest/token` 中转换取 token（app secret 不在客户端），
token 以 0600 权限原子写入 `userData`。画板与 Pin 通过 Pinterest API 实时读取，只在内存
缓存最多 5 分钟，不写入素材库；Pin 图片直接从 `i.pinimg.com` 加载。

### 7.7 设置反馈

运行时启动时由 `lib/diagnostic-log.mjs` 安装一个有界内存环形日志（最多 400 行 / 120 KB）。
设置页反馈面板通过 `GET /api/feedback/diagnostics` 预览脱敏后的诊断文本：库路径和主目录
替换为占位符，Token、长密钥和邮箱被遮蔽，可能含 Prompt 的整行被删除。
`POST /api/feedback/submit` 在本地校验类型、正文、联系方式和语言，对诊断文本重新脱敏并
截断，然后只向 `MOSA_FEEDBACK_URL`（默认 `https://gravityport.azhuilab.com/api/feedback`）转发
一次请求；本地日志只记录提交结果状态，不记录内容。

## 8. 一张图的一生：进库机制规矩表

本节是进库、认重、元数据、整理、删除和库位置的规矩表。**进库只有一个总入口：
`lib/library-ingest.mjs` 的 `ingestIntoLibrary`；各通道只负责拿到图和字段。**
认新旧、同编号换更清晰的、记出现、升级提示词、写生成记录的时机都在总入口里。
**改了本节任何一条规矩的 PR，必须在同一个 PR 里改本节。**

### 8.1 进库

```mermaid
flowchart TD
    A[通道拿到图和字段] --> B{总入口：认新旧<br/>findExistingAsset}
    B -->|站点编号命中，字节不同| C{只许换更清晰的<br/>isProviderMediaUpgrade}
    C -->|允许| D[替换媒体，旧原图进回收站<br/>reason: logical-output-media-upgraded]
    C -->|不允许| E[已有]
    B -->|编号/字节/像素命中| E[已有]
    D --> E
    E --> F[记一次出现<br/>recordIngestOccurrence]
    F --> G[调用方钩子：合并配方与参考图]
    G --> H{谁收的图谁升级<br/>canUpgradeMetadata}
    H -->|允许| I[按等级表升级提示词<br/>upgradePrompt]
    H -->|不允许| J[调用方钩子：请求提示词/会话标题/生成记录]
    I --> J
    J --> K[返回 skipped 与原因]
    B -->|没有命中| L[建素材<br/>createAssetViaGate：编号撞名重试一次，判重结果翻译成 skipped]
    L --> M[自动堆叠：同会话满 2 张建堆]
    M --> N[返回 imported]
```

各通道拿什么当编号、提示词从哪来、谁写生成记录：

| 通道 | 拿什么当编号 | 提示词从哪来 | 谁写生成记录 | 特殊规矩 |
| --- | --- | --- | --- | --- |
| 扩展 · ChatGPT（图片） | 图片地址的站点编号（`provider_asset_id`）→ 字节 → 像素 | 接口里的生成提示词；兜底 DOM 说明文字 | 写（有生成证据才记） | 已接入总入口（各站图片都走 `ingestWebCapture`） |
| 扩展 · Gemini / AI Studio（图片） | 暂无站点编号，字节 → 像素 | 前一轮用户消息的页面文字 | 写 | 已接入总入口；扩展暂不送站点编号，同一条生成换大图会各收一张 |
| 扩展 · Flow（图片） | 暂无站点编号，字节 → 像素 | 同行「Reuse prompt」卡片 | 写 | 已接入总入口；同上 |
| 扩展 · 即梦（图片） | 条目 id | 接口 JSON | 写 | 已接入总入口；只收之后新出的图；站内删除同步见 8.5 |
| 扩展 · Midjourney（图片） | `jobId:index` | DOM | 写 | 已接入总入口；原图拿不到时存预览并标 `preview` |
| 扩展视频（各站） | 只认字节，不认编号 | 同图片 | 每次都记 | 「只许换更清晰的」暂不适用（待接入总入口） |
| Codex | 来源路径 → 字节 → 像素 | 会话里的修订提示词，退回最后一条用户消息 | 不写 | 待接入总入口 |
| Grok Build CLI | 来源路径 → 字节 → 像素 | 会话工具调用参数 | 不写 | 待接入总入口 |
| Cowart | 来源路径 → 字节 | 画布 alt text | 不写 | 待接入总入口 |
| 手动导入（拖、选文件、粘贴） | — | 无 | 不写 | 字节相同跳过、显示像素相同的新图进回收站、感知相似的进清单让用户选（#314）（待接入总入口） |
| MCP `asset_create` | 调用方 | 调用方传 | `generation_record` 单独写 | 待接入总入口 |

写生成记录在总入口里是固定位置的调用方钩子；当前只有网页图片收录在用，Codex、
Grok、Cowart 和手动导入不写。

### 8.2 认同一张图

四种「是同一张」并存，命中后的行为由总入口决定：

1. **站点编号**：`provider_asset_id` / `logical_output_id`（`lib/web-capture-ingest.ts`
   的 `logicalCaptureKey` 拼装）。字节相同：记一次出现；字节不同：只许按
   「宽×高严格更大」换更清晰的（`isProviderMediaUpgrade`，#306），预览永远
   不能换掉原图，被换掉的旧原图进回收站，原因 `replaced-by-better-version`。
2. **文件字节**（`assets.content_sha256`）：跳过。
3. **显示像素**（`assets.pixel_sha256` + `pixel_hash_version`）：跳过；存的是旧
   哈希版本时，要重新计算存储原图的像素哈希、对得上才算，并顺手把新哈希写回。
4. **「删了不再自动收」名单**（`automatic_ingest_suppressions`，按字节+像素）：
   自动收录命中就静默跳过（`suppressed-after-delete`）；手动导入、MCP、复制、
   恢复会清掉对应记录。（该名单暂不按站点编号记——待接入总入口）

手动导入额外做感知相似检查（`asset_perceptual_hashes`，dHash，#314）：字节相同
跳过；显示像素相同的新图自动进回收站（可恢复）；相似的进清单让用户选。

三种「有关系」（不参与查重，字节/像素哈希与原图完全一样）：

- **副本 / 新版本**：`parent_asset_id`、`asset_versions`、
  `source.duplicated_from` / `versioned_from`，HTTP `/duplicate` `/versions` 与 MCP 可建。
- **智能堆叠**：`asset_stacks`（origin `auto` / `manual`）；同会话满 2 张自动建堆。
- **版本树候选**：`generation_relation_candidates`，只对同对话打分，用户确认才成为实线关系。

### 8.3 元数据谁说了算

**提示词等级表**（唯一一张，`lib/prompt-rank.mjs` 的 `PROMPT_STATUS_RANK`；
扩展 `background.js` 的 `promptPayloadRank` 和 `content.js` 的 `promptQuality`
的顺序必须与它一致，有测试锁住）。分越高越可信；分数 =
调用方 priority × 1e6 + 等级 × 1e4 + 文字长度（最多算 5000）：

| 等级 | 状态 |
| --- | --- |
| 0 | `not-available`、`not-available-in-session`、`image-generation-prompt-unavailable`，以及表里没有的任何状态 |
| 1 | `user-message`、`provider-visible-prompt`、`session-user-prompt`、`task-user-prompt`、`canvas-alt-text-only` |
| 2 | `visible-caption` |
| 3 | `generation-tool-prompt`、`image-generation-revised-prompt` |
| 4 | `user-edited` |

升级规矩（总入口的 `upgradePrompt`）：新的提示词为空一律不换；分数严格更高才换（超过 5000 字分数封顶后，同分且长 40 字以上也换）；
`user-message` 只许填空位或严格延长，永不覆盖已存的用户指令。

**用户手改最大**（#309，`lib/user-edit-marker.mjs`）：

- 手改标记 `prompt_user_edited_at` / `theme_user_edited_at` / `user_edited_at`
  存在 `source` 里；打标记的入口：界面 PATCH、MCP `asset_update_metadata`、
  `asset_attach_prompt`。手改过的提示词和名字，任何自动通道都不许改。
- 手改提示词时状态写成 `user-edited`（source 和 business_fields）。
- **删空提示词不算手改**：标记清掉、状态回到 `not-available`（只清提示词这一项
  时不打 `user_edited_at`），之后同一张图再被收到，网站上的提示词会按等级表补回来。
- 调用方不能改标记：patch 里的标记键一律忽略，最终值由
  `withUserEditMarkers` 决定。

**谁收的图谁升级**（总入口的 `ingestOwnerOf` / `canUpgradeMetadata`）：一张图
的主人由 `source_type` 决定——`web-<provider>`、`codex`、`grok`、`cowart`、
`manual`（本机导入）、其他。只有主人能升级它的提示词；别家网站同字节撞上只记
一次出现，提示词和用户指令都不动。唯一例外：主人是 `manual`（本机导入的图没有
来源信息）时，任何通道都可以按等级表补它的提示词。

**名字（theme）现状**：新建时从提示词算（网页取前 80 字，或「&lt;站名&gt; web
image」），只跟着真升级的提示词重算，且永不覆盖用户改过的名字。界面显示的是
文件名，theme 只用于「按名称排序」和搜索。

**来源字段**：同一个意思存在多处——`source_type` 列、`source.type`、
`source.provider`、`business_fields.provider`、`source.generation_tool`、
`skill`（给人看的来源文字）、`source.model`、`source_group`（智能分组用）。
归一函数在 `lib/generation-session.mjs` 和 `lib/asset-store.mjs`。提示词状态、
用户原话、生成状态在 `source` 和 `business_fields` 各存一份。

### 8.4 整理

| 概念 | 数据 | 谁做 | 上限 |
| --- | --- | --- | --- |
| 我的分组 | `assets.group_name` + `groups` 表 | 手动 | 一张图最多 1 个 |
| 智能分组 | `assets.source_group`，写死的来源集合 | 自动 | 恰好 1 个；手动导入与 MCP 的图不在任何一项里 |
| 堆叠 | `asset_stacks`（origin `auto` / `manual`）、`asset_stack_members` | 自动（同会话满 2 张）+ 手动 | 一张图最多 1 个；封面固定最早那张（现状） |
| 待整理 | 没分组且不在任何堆叠 | 算出来 | — |
| 收藏 | `favorite = 1` 或 `rating > 0` | 手动心形；打分只有 MCP 能写 | — |
| 标签 | `tags` / `asset_tags` | 手动；系统标签隐藏 | 多个 |
| 版本树 | 对话轮次（推算）、确认关系 `generation_relations`、候选关系、版本历史 `parent_asset_id` | 手动确认 / 自动猜 / MCP 与 HTTP | 多对多（现状） |
| 归档 | `assets.archived = 1`，归档时移出堆叠 | 只有 MCP `asset_archive` 与 HTTP | 界面没有入口和视图（现状） |
| 项目 | `project_id` | MCP / HTTP | 一张图 1 个 |

侧栏计数按张数，网格按卡片数（一个堆叠算一张）。

### 8.5 删除

- **移至回收站**：写 `deleted_at`，文件不动；写一条「删了不再自动收」；分组、
  堆叠成员、版本关系、生成记录都保留。
- **回收站恢复**：清 `deleted_at` 和那条名单，回到原分组和堆叠。
- **永久删除 / 清空回收站 / 90 天自动清**：删标签、版本行、堆叠成员（堆叠空了
  一起删）；生成记录连带删，指向它的确认关系和候选关系也删。
- **有子版本的父版本**：移回收站和永久删除都会被拒（`VERSION_PARENT_HAS_CHILDREN`）。
- **即梦站内删除同步**（#307）：默认开；整理过的不动（收藏、打分、分组、用户
  标签、手动堆叠、标记整理、归档、手改提示词或名字）；有副本或派生版本的整组
  不动；自动堆叠不算整理过；进回收站标 `provider-deleted:jimeng`。
- **MCP**：没有删除工具；唯一让图消失的是 `asset_archive`，进的不是回收站
  （见 8.4 归档）。
- **在 Finder 里删素材文件**：库不监视目录，记录还在，原图打不开没有提示（现状）。
- **删除分组**：只清 `group_name`，图留着；「连素材一起删」的路也会留下
  `group_name`，恢复任一张时分组会自己出现。

### 8.6 素材库在哪

- 默认顺序：先老库目录 `~/MOSA Library`，再新库目录 `~/GravityPort Library`。
- 找库顺序（`lib/library-location.mjs` 的 `resolveLibraryLocation`）：环境变量 →
  位置文件（存在就必须是真库，否则报错，不回退）→ 桌面版的位置文件 → 老默认 →
  新默认 → 允许新建才建空库。
- `library-location.json` 在应用数据目录；挪库成功后写，第一次成功开库也补写（#308）。
- 开库规则（`lib/asset-store.mjs`）：有库就开并补完成标记；有完成标记没数据库、
  有图没数据库、数据库没完成且没有老 JSON → 都报错不建空库；什么都没有才建新库（#308）。
- MCP：不建库；每次调工具前比对 `mosa.db` 的设备号和 inode；挪库中一律拒；
  挪库期间旧库的写入会被拒绝并在复制前后核对数据库指纹（#283）。
- 后台常驻进程和它拉起的 runtime 与桌面版一样读位置文件、不建库，找不到库就
  停下并记日志（#313）。

## 9. 配置与隐私边界

运行时支持的主要环境变量如下；路径应由使用者在本机配置，不要把真实路径或
Token 写入公共文档、日志或仓库：

| 变量 | 用途 |
| --- | --- |
| `MOSA_PORT` | Node 服务端口，默认 `43517` |
| `MOSA_DESKTOP_PORT` | Electron 壳使用的端口，默认 `43517`；显式设置后不再在 43517–43521 间回退 |
| `GRAVITYPORT_LIBRARY_DIR` | SQLite/库目录；显式指定后用于库隔离和迁移 |
| `MOSA_PROJECT_DIR` | 项目根目录覆盖 |
| `CODEX_HOME` | Codex 本地数据根；默认 `$HOME/.codex` / `%USERPROFILE%\.codex` |
| `CODEX_GENERATED_IMAGES_DIR` | Codex 生成图片目录覆盖 |
| `CODEX_SESSIONS_DIR` | Codex 会话目录覆盖 |
| `GROK_SESSIONS_DIR` | Grok 会话目录覆盖 |
| `COWART_MOSA_CANVAS_DIR` | GravityPort 管理画布目录覆盖 |
| `MOSA_COWART_REGISTRY_PATH` | Cowart 外部项目注册表路径覆盖（默认 `<CODEX_HOME>/mosa/cowart-projects.json`） |
| `GRAVITYPORT_DISABLE_BRIDGES` | 禁用指定桥接的逗号分隔列表：`codex`（同时停用 ChatGPT 桌面版对话同步）、`grok`、`cowart`、`cowartDiscovery`；未知名称直接报错 |
| `MOSA_CLIENT_TOKEN` | 管理 API 的 client token；未设置时 `npm start` 每次随机生成，桌面版使用 `userData` 中持久化的值 |
| `GRAVITYPORT_WEB_CAPTURE_TOKEN` | 启用网页捕获的本地 Token |
| `GRAVITYPORT_WEB_CAPTURE_ORIGINS` | 网页捕获允许的扩展 origin 列表 |
| `MOSA_WEB_CAPTURE_PAIR` | 设为 `auto` 时，独立 `npm start` Runtime 也允许扩展静默配对（默认关闭，桌面版始终自动配对） |
| `MOSA_C2PATOOL_PATH` | C2PA 导出（`lib/c2pa-export.mjs`，目前尚未接入 UI/HTTP/MCP 入口）使用的 `c2patool` 路径覆盖（见 [docs/operations.md](docs/operations.md)） |
| `GRAVITYPORT_DISABLE_TELEMETRY` | 设为 `1` 时桌面壳不发匿名使用统计（见 PRIVACY.md） |
| `MOSA_FEEDBACK_URL` | 反馈收集服务地址覆盖（默认 `https://gravityport.azhuilab.com/api/feedback`） |
| `MOSA_FEEDBACK_TIMEOUT_MS` | 反馈转发超时毫秒数（默认 15000） |

用户会手动设置的六个开关（`GRAVITYPORT_LIBRARY_DIR`、`GRAVITYPORT_LIBRARY_LOCATION_FILE`、
`GRAVITYPORT_DISABLE_BRIDGES`、`GRAVITYPORT_DISABLE_TELEMETRY`、`GRAVITYPORT_WEB_CAPTURE_TOKEN`、
`GRAVITYPORT_WEB_CAPTURE_ORIGINS`）仍接受改名前的 `MOSA_*` 同名变量作为不公开的兼容别名，两个都设时以
`GRAVITYPORT_*` 为准。各进程入口第一行 `import "lib/apply-env-aliases.mjs"`，把新名折到代码读取的
`MOSA_*` 上并删掉新名（`lib/env-aliases.mjs`），之后派生的子进程只看到一个值。其余内部变量保留 `MOSA_*`。

GravityPort 只读取已配置的 Codex（含 ChatGPT 桌面版状态文件）、Grok 和 Cowart 位置；不会把 Downloads、Desktop、
Documents 或任意项目图片目录作为默认扫描根。导入路径、画布路径、外部来源和
打开文件夹操作均经过边界
校验；运行时隔离检查在写入库或监听端口前失败即停止。请把 Prompt、会话 ID、
页面 URL、素材和 Token 视为私人数据。

## 10. 相关验证

源码或依赖变化后，使用仓库定义的检查：

```bash
npm run build
npm test
npm run lint
npm run check
git diff --check
```

上述命令验证构建、Node 测试、ESLint，以及 `npm run check` 中的源文件边界、死代码、
i18n 键和 Web UI 类型检查，最后检查补丁空白；真实桌面包、
浏览器扩展重载和已登录网页上的 Web Capture 仍需按相应指南单独验证。
