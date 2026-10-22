# GravityPort 中文使用指南

GravityPort 原名 MOSA。已安装的用户，素材库文件夹、设置和命令名都保持不变。

GravityPort 是面向 Codex、Cowart 和本地 Grok Build CLI 的本地创作素材库。它不负责生图，而是在媒体生成或画布编辑后，自动把图片/视频、Prompt、来源、参数、版本和画布上下文归档为可检索、可复用的本地素材。

## 许可与商用

GravityPort 采用 [PolyForm Noncommercial License 1.0.0](../LICENSE)，属于源码可见、非商业许可软件，不是 OSI 认可的开源软件。

- 个人、学习、研究、兴趣项目等非商业用途，以及非商业修改和传播均可免费使用。
- 任何商业用途、收费服务、客户交付或商业平台集成都须另行取得版权所有者的书面授权；申请流程见 [商业授权说明](../COMMERCIAL-LICENSE.md)。
- 重新分发原版或修改版时，必须保留许可证条款和 Required Notice。

## 产品边界

- **Codex** 负责 AI 生成、理解和任务执行。
- **Cowart** 负责画布编排与编辑。
- **Grok Build CLI** 可在本地生成图片与视频。
- **网页生图扩展**可选，用于把 ChatGPT、Gemini、Flow 和 Google AI Studio 的网页成图及其可用上下文发送到本机 GravityPort；开启自动入库后，也会代为收录 ChatGPT 桌面应用里生成的图片。
- **GravityPort** 负责自动收集、归档、检索和版本管理。

GravityPort 当前是绑定 `127.0.0.1` 的本地 Web 应用，也提供共享同一套 UI/Runtime 的 Electron 桌面壳。macOS arm64 是现有桌面开发目标，Windows 10/11 x64 已进入 Preview/Testing；仓库尚未发布正式签名安装器。它不是云服务，也不调用 Grok API，不应通过公网或反向代理暴露。Desktop 可选安装一个完全本地运行的 Visual Pack（界面里叫「视觉能力包」），用于检视器「相关推荐」的相似图、视觉关系候选，以及 MCP `asset_search`（`visual: true`）和本地 `/api/visual/search` 的文字搜图（画廊的「搜索素材」仍是文本检索）；未安装时核心素材库功能保持不变。

## 环境要求

- 源码模式需要 Node.js 22 或更高版本、npm；桌面开发目前覆盖 macOS arm64 与 Windows 10/11 x64。Windows 首次执行 `npm ci` 时请优先使用仓库 `.nvmrc` / `.node-version` 固定的 Node 22.x，与 Windows CI 保持一致，避免 Node 24 下 Electron node-gyp 工具链解析差异触发不必要的 ClangCL 编译要求。
- 要自动归档 Codex 生图，需要安装 Codex Desktop。
- 要自动归档 Grok 媒体，需要本机已登录并可写入 `~/.grok/sessions` 的 Grok Build CLI。
- Cowart 自动归档需要安装 Cowart 插件；不使用 Cowart 时不影响 GravityPort 的其他功能。
- 网页生图归档需要 Chrome。使用 GravityPort Desktop App 时会自动生成本机 Token，并只授权 GravityPort 开发版与 Chrome Web Store 正式版这两个固定扩展来源完成本地配对；仅源码 `npm start` 模式需要手工配置 `MOSA_WEB_CAPTURE_TOKEN` 与 `MOSA_WEB_CAPTURE_ORIGINS`。要收录 ChatGPT 桌面应用里生成的图片，还需要扩展已配对、Chrome 已登录 chatgpt.com，并开启「发现新图时自动入库」。

### Windows 10/11 x64 Preview 状态

之前的版本在 Windows 真机上验证过：应用启动、本地 SQLite、Sharp 原生图像处理、素材库/资产检视器，以及 Codex 素材自动收录；换成新界面之后还没有在 Windows 真机上重新验证。Windows 使用原生标题栏，但隐藏 Electron 默认菜单栏；菜单 accelerator 仍保留。

Windows 上的 Grok/Cowart 来源目录尚未完成真机验证，暂不把推测路径写成正式默认值。当前打包版已经支持在应用内读取官方 release manifest、下载对应版本的 portable ZIP、校验文件大小与 SHA-256，并在退出本地 Runtime、释放文件锁后通过独立更新辅助进程原位替换应用目录；替换失败时会回滚旧目录。Windows 安装器和代码签名仍属于发布阶段工作，因此当前 Windows 构建仍应视为测试版，而不是正式签名发行版。

macOS Desktop 与 Web Capture 的后台监督服务共用同一资料库和本地端口。新版 Desktop 启动时会先发布一个最多 90 秒有效（覆盖 Desktop 最长 30 秒的旧 Runtime 退出等待和自身启动）、绑定当前 PID 与进程启动身份的接管标记；监督服务看到后会停止自己拉起的后台 Runtime 并让 Desktop 接管。若 Desktop 启动失败，标记会自动过期，后台服务恢复。这样覆盖安装/重启 GravityPort 时不应再需要手动结束仓库里的 `server.mjs`。外部非 GravityPort 服务、不同资料库的 GravityPort Runtime 仍不会被自动终止。

### 本地视觉搜索（暂不提供）

本地视觉搜索（按画面找相似图、文字搜图）的后台代码还在，但桌面界面目前不提供：设置里没有「模型」页，检视器也不显示相关推荐，GravityPort 不会下载任何模型。找图请用分组、自动堆叠、搜索框，或通过 MCP 让 AI 代理检索。技术细节和模型评估记录见 [visual-retrieval-model-evaluation.md](visual-retrieval-model-evaluation.md)。

## 安装桌面版

普通使用直接从[官网下载页](https://gravityport.azhuilab.com/#download)下载桌面版即可，不需要源码：

- **macOS（Apple 芯片）**：DMG，把 `GravityPort.app` 拖进「应用程序」。
- **Windows 10/11 x64**：便携 ZIP，解压后运行 `GravityPort.exe`（目前是 Preview 测试版）。
- **网页生图扩展（可选）**：开发者模式加载的 ZIP，安装步骤见[官网安装指南](https://gravityport.azhuilab.com/guide/)。

装好后，应用会在「设置 → 关于」里自己检查更新。第一个以 GravityPort 名义发布的版本推出之前，下载页提供的仍是最后一个以 MOSA 名义发布的版本。

### 第一次打开

当前桌面版是 Preview 版本：macOS 版还没有经过 Apple 公证，Windows 版还没有代码签名，所以第一次打开时系统会提示风险。

- **macOS**：先打开一次 GravityPort，看到「无法验证」的提示后点「完成」；然后打开「系统设置 → 隐私与安全性」，在「安全性」一栏找到 GravityPort，点「仍要打开」并确认。之后系统会记住这个选择。macOS 14 及更早版本也可以按住 Control 点按应用，选「打开」。
- **Windows**：如果 SmartScreen 提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。

要用网页生图扩展的话，先打开桌面版再加载扩展，两者会自动配对。

## 本地启动（源码）

以下命令从源码启动开发/本地服务，默认地址为 `http://127.0.0.1:43517`：

```bash
git clone https://github.com/fengseekling-coder/gravityport.git
cd gravityport
npm ci
npm test
npm start
```

仓库不包含真实或演示媒体素材。开发和测试请使用临时夹具或你自己准备的测试文件；真实个人素材库应使用独立目录，不要把仓库工作目录当作生产素材库。

## SQLite 素材库与迁移

默认运行期素材库：本机已有 `~/MOSA Library` 的继续用它；没有库的机器新建 `~/GravityPort Library`（规则在 `lib/library-location.mjs`）。迁移完成后，里面包含 `mosa.db`、原图、预览图、缩略图和 JSON/Prompt 备份：

```text
~/GravityPort Library/
├── mosa.db
├── assets/<project>/original/
├── assets/<project>/mediums/
├── assets/<project>/previews/
├── assets/<project>/thumbnails/
└── legacy-json-backup/
```

迁移前先做只读检查：

```bash
npm exec gravityport -- migrate --dry-run --library /absolute/path/to/library
```

示例使用 `gravityport` 命令名；旧命令名 `mosa` 仍可用，指向同一个 `bin/mosa.mjs`。

确认无问题后再迁移、校验和补全派生图：

```bash
npm exec gravityport -- migrate --library /absolute/path/to/library
npm exec gravityport -- verify --library /absolute/path/to/library
npm exec gravityport -- thumbnails rebuild --library /absolute/path/to/library
```

迁移会校验 JSON、原图、哈希和空分组。未完成或失败时不会激活 SQLite；完成后 SQLite 是唯一运行期权威，JSON 只保留为备份和兼容回退，不做双写。

### 素材库备份与恢复

SQLite 迁移完成后，可以把整个 GravityPort 素材库备份到另一个空目录：

```bash
npm exec gravityport -- backup --library /absolute/path/to/library --to /absolute/path/to/backup
npm exec gravityport -- backup-verify --from /absolute/path/to/backup
```

备份包含 SQLite 快照、受 GravityPort 管理的原图/派生文件、参考图附件和迁移完成标记。只有在库校验通过并写出带文件大小与 SHA-256 的 `backup-manifest.json` 后，这个目录才被视为完整备份。

恢复必须显式指定一个空目录，不会覆盖现有素材库：

```bash
npm exec gravityport -- restore --from /absolute/path/to/backup --to /absolute/path/to/restored-library
```

恢复前会先校验备份清单和文件哈希，恢复后会把受管理的绝对路径重定位到新目录并再次执行素材库完整性校验。建议备份时尽量暂停大批量导入/网页捕获；若备份过程中素材文件被并发永久删除，GravityPort 会让本次备份失败，而不是发布一个数据库仍引用缺失文件的快照。

## 自动归档

### Codex 生图

服务运行时，GravityPort 跟随 Codex 自己的本地数据根。若设置了 `CODEX_HOME`，就以该目录为准；未设置时 macOS/Linux 使用 `$HOME/.codex`，Windows 使用 `%USERPROFILE%\.codex`。

默认自动收录使用两条互补通道：`<CODEX_HOME>/generated_images/` 是标准图片来源，`<CODEX_HOME>/sessions/` 是生成事件与元数据来源。正常情况下 GravityPort 优先收标准落盘图片，再按同一 Codex session 补齐 Prompt、模型、call ID 和生成时间。Prompt 优先使用 Codex 实际交给生图工具的提示词；拿不到时才回退到这次任务的用户消息，并且只保留「## My request:」之后的内容，不会把 Codex 粘贴文件时附加的文件清单当成 Prompt。之前以回退方式收录的图片，下次读取对应 session 时会自动改正。

如果 Codex 的 session 已经记录了图片结果（`image_generation_call` / `image_generation_end`，或新版 Codex 代码模式写出的 `item_completed` 中 `image_gen.generation` 条目），但标准 `generated_images` 文件没有真正写出来，GravityPort 会自动从 session 中恢复这张图片并正常入库。恢复结果先经过体积限制、base64 校验和真实图片格式检查，只暂存在 GravityPort 自己的私有目录，完成素材库 copy 后立即删除；session 里的任意 `saved_path` 不会因此获得额外文件读取权限。

运行期间 GravityPort 同时监听图片目录和 session 目录。session JSONL 首次建立索引后只读取后续新增的完整记录，不会在每次轮询时重新解析整份会话。watcher 不可用时仍有轮询兜底。GravityPort 不再把 `Documents\\codex`、当前 workspace 或任意项目目录当成 Codex 默认素材来源。

如果你以前改过 Codex 自己的存储根，应修改 Codex 的 `CODEX_HOME`，GravityPort 会跟随同一个根。`CODEX_GENERATED_IMAGES_DIR` 和 `CODEX_SESSIONS_DIR` 仍可作为显式高级覆盖，但它们不是新的默认规则。

GravityPort 不扫描 Downloads、桌面、Documents 或任意本地图片目录。原图在同一文件系统时优先硬链接入库，跨文件系统时才复制。

### 网页生图

Web Capture 是可选功能。使用 Desktop App 时，只需加载官方扩展并打开 GravityPort；扩展会自动发现 `127.0.0.1` 上的 GravityPort discovery 端口并配对。如果首选端口被占用，Desktop 与扩展会自动切换到备用端口。

如果你从源码使用 `npm start` 启动独立 Web Runtime，则仍需手工配置：

```bash
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

Desktop 模式下扩展选项会自动得到实际 GravityPort 地址和 Token，通常无需手填。源码 Web Runtime 中，未配置 Token 时服务端保持禁用；来源不在精确白名单中时，跨来源请求会被拒绝。

扩展只向所配置的 `127.0.0.1` 或 `localhost` GravityPort 地址发送图片字节和页面来源信息。ChatGPT 在可用时还会发送匹配到的 Prompt/用户消息、会话/消息 ID 与模型信息；Gemini 仅保存生成图所属 `model-response` 前、同一局部消息结构里的最近可见 `user-query`；Flow 仅在同一可见媒体卡片有唯一「Reuse Prompt」控件时保存其相邻可见 Prompt；Google AI Studio 仅保存图片所在会话内、图片 Model 回合之前最近的页面可见用户 Prompt 回合。三者都明确标为未验证实际生图提示词。扩展不读取 Google 站点的会话接口、登录凭据、隐藏提示词、输入编辑器或模型思考；若图片先于可匹配 Prompt 完成渲染，只会对同一图片的局部关联信息进行有界重试。地址、Token 与自动采集开关保存在 Chrome 本地存储，不使用同步存储。完整边界见 [隐私说明](../PRIVACY.md) 和 [扩展指南](../extensions/chatgpt-web-capture/README.md)。

被可靠识别为生成输入的参考图会保存为“生成记录附件”，而不是独立素材：文件按内容 hash 去重，只绑定到同会话中随后产生的生成结果及其 recipe snapshot，不进入素材瀑布流、搜索、最近添加或素材总数。当前可靠自动识别以 ChatGPT 的上传输入为准；Flow、Gemini 不会仅凭页面先后顺序猜测参考关系。旧版已经入库的 `is_reference` 素材保持原样，GravityPort 不自动迁移或删除现有库内容。

### ChatGPT 桌面应用

ChatGPT 桌面应用（现在也承载 Codex）里聊天生成的图片不会写到本机磁盘，Codex 的 `generated_images` 和 session 里都没有，所以改由网页生图扩展代为收录。GravityPort 随 Codex 来源一起运行时，约每 10 秒查看一次 `<CODEX_HOME>/.codex-global-state.json`，只取桌面应用里聊天绑定的 ChatGPT 会话 ID 和每段对话最后一次提问的消息编号，据此判断哪段对话刚用过；进度记在素材库根目录的 `.chatgpt-desktop-sync.json`，只有会话 ID、时间、重试次数和那个编号的哈希，不保存提示词正文。第一次运行时，会对桌面应用里已有的对话各补查一次。

某个会话安静约 90 秒后，GravityPort 把它交给已配对、并勾选了「发现新图时自动入库」的扩展（0.15.33 起），一次一段。扩展先用 Chrome 里已登录的 ChatGPT 账号读一次这段对话：为此会向 `chatgpt.com/api/auth/session` 取一次访问令牌，只用于这一次读取，不保存，也不发送给 GravityPort。确认没有生成图的对话不会被打开；有生成图（或无法确认）时，才在一个最小化、不抢焦点的后台窗口里打开它，按普通 ChatGPT 网页的方式采集，完成后自动关闭窗口。每次活动最多尝试 3 次。

和在浏览器里重新打开旧对话一样，这种方式保存图片和你发送的消息；ChatGPT 自己给图片配的说明文字只有在浏览器里实时生成时才拿得到。收录的图片归入「智能分组」的 ChatGPT。需要 Chrome 正在运行、扩展已配对，且浏览器登录的 ChatGPT 账号和桌面应用一致；关闭自动入库即停止同步，设置 `MOSA_DISABLE_BRIDGES=codex` 则 GravityPort 完全不读该状态文件（同时停用 Codex 图片导入）。详见 [隐私说明](../PRIVACY.md#chatgpt-desktop-app-conversations)。

### Grok Build CLI 媒体

服务运行时，GravityPort 只监听 `~/.grok/sessions/`（可用 `GROK_SESSIONS_DIR` 覆盖）。它只发现各会话目录下 `images/` 与 `videos/` 中的媒体，并读取同会话的 `chat_history.jsonl` 提取工具参数中的 Prompt、模型与工具名。

Prompt 优先级：仅在工具调用与 tool_result 能匹配到该媒体路径时使用工具参数 Prompt；匹配成功但工具未带 prompt 时，才对该条结果回退会话用户指令；孤儿媒体或无法匹配时标记为不可用。视频按原始文件归档与提供服务，不经 sharp/ffmpeg 转码；界面使用原生视频播放；要在系统文件管理器里定位文件，点检视器底部的「素材路径」（打不开时改为复制路径），右键「复制路径」只复制路径。

### Cowart 画布

GravityPort 始终监听 Codex 根下的专用画布 `<CODEX_HOME>/cowart-data/mosa/`；未设置 `CODEX_HOME` 时就是用户默认的 `.codex/cowart-data/mosa/`。其他项目必须先在 Codex 中真实打开 Cowart 画布；GravityPort 从本地启动记录识别项目，验证 `<项目>/canvas/` 的画布标记后才加入允许列表并监听。

Cowart 快照可提供画布说明与来源，但不保证具有完整生图 Prompt。GravityPort 会保留这种差异，避免把画布描述误写成完整 Prompt。

## 界面与日常操作

以下说明对应现在的 GravityPort 界面（桌面版和源码 Web 界面是同一套）。

### 侧栏

左侧栏从上到下是「所有素材」「Pinterest」「待整理」「收藏」「回收站」，各自显示数量；下方是两个可折叠的分组区：「智能分组」按来源自动汇总素材（ChatGPT、Gemini、Flow、Google AI Studio、Codex、Grok、Cowart，只显示有素材的来源），「我的分组」是你自己建的分组，旁边的加号可以新建。侧栏的 Pinterest 入口在还没加载画板时标着「暂未开放」：Pinterest 目前处于试用额度，所有用户共用每天的请求次数。点进去或在「设置 → 连接」里点「连接 Pinterest」，在系统浏览器里授权一次后即可浏览自己的画板和 Pin；内容只在本机实时显示，不会存进素材库。这个视图里画廊工具栏、检视器、拖放导入、快捷键和右键菜单都不可用。

### 画廊

顶栏「调整列数」可在 2、3、4、5、6、8 列之间切换，选择会记住，不选时按窗口宽度默认 4（窄窗 3 或 2）列。在空白处按住拖动即可框选，从卡片上按住 Shift 起拖是加选，拖到窗口边缘会自动滚动；「全选」用 ⌘A（Windows 为 Ctrl+A），结果过大时只选中前一部分并明确提示。多选后可以右键批量操作，或直接拖动整批卡片。键盘也能浏览：方向键按屏幕上的位置移到相邻卡片，回车打开大图（堆叠卡片则进入堆叠）；⌘F（Windows 为 Ctrl+F）或 `/` 跳到搜索框。

顶栏还有「素材类型」（全部类型 / 图片 / 视频）、「排序」（最新优先 / 名称排序）和「搜索素材」。搜索只匹配看得见的内容：文件名、ID、提示词、标签、分组、分类、风格、主题、用户指令、模型名和来源名；搜索时堆叠会拆开，每张匹配的图单独显示。导入没有对话框：把图片或文件夹拖进画廊即导入当前分组或堆叠，拖到侧栏分组名上直接导入该分组，也可以直接粘贴剪贴板里的图片；已在素材库里的文件不会重复导入，不支持的格式会提示跳过数量。视频卡片显示视频开头的画面，右上角有播放标记。

### 检视器

单击卡片选中，右侧检视器显示它的信息；双击打开大图查看。检视器头部一行显示「类型 · 来源 · 日期」（例如「图片 · ChatGPT 网页版 · …」），下面是提示词区和标签：网页来源没有暴露原始生图提示词时会如实标注，不会编造。版本树列出这张图的生成记录：ChatGPT 会话里的图按对话轮次排列，默认显示当前图前后共三行，第二行写着「共 N 轮 · 当前第 n 轮」；点「查看」展开全部行，以及「生成关系」「候选关系」「版本历史」和「版本对比」。

### 查看大图

双击卡片、右键「在查看器中打开」或点检视器里的「打开预览」进入大图。顶栏左侧「返回」回到画廊，右侧是「删除」和「隐藏详情 / 显示详情」。左右方向键或两侧箭头切换上一张 / 下一张；滚轮以指针位置缩放，放大后按住拖动平移，双击在「1:1」和「适合窗口」之间切换；键盘 `+` / `-` 缩放，`0` 适合窗口，`1` 原始尺寸。

底部缩放条浮在图片上方，从左到右是缩小、缩放百分比、放大、「适合窗口」、「1:1」和「全屏」。鼠标停住 2 秒后缩放条会淡出，移动鼠标、滚轮缩放或按缩放键就会重新出现；指针停在缩放条上或焦点在缩放条里时不会淡出。

「全屏」会收起侧栏、顶栏和检视器，让图片铺满窗口并重新适配大小；缩放条、左右箭头和提示条仍保留，按钮变成「退出全屏」。按 Esc 先退出全屏，再按一次 Esc 关闭大图。这是窗口内的全屏，不会把窗口切成系统全屏；关闭大图后，下次打开仍是普通模式。视频在大图里用原生播放器播放。

### 堆叠

把一张卡片拖到另一张上即可建堆叠或并入堆叠（放错可在 6 秒内撤销），多选后右键「堆叠所选」也可以。双击堆叠进入成员视图，「返回素材库」或后退键退出。堆叠内可以直接拖动卡片排序；右键「剪切」再在堆叠上「粘贴到此堆叠」（或堆叠空白处「粘贴」）可以把素材在堆叠之间搬移（⌘X / ⌘V，Windows 为 Ctrl+X / Ctrl+V）。右键「解散堆叠」只解除堆叠关系，不删除、不归档任何素材。

### 分组

在侧栏「我的分组」旁点加号新建分组，或在画廊空白处右键「新建分组」。把卡片拖到侧栏分组名上即可归组；卡片右键「添加分组」可选现有分组或「新建分组并移入」。右键分组名可以重命名、上移/下移、选分组颜色、看分组统计、导出分组或合并到其他分组；「删除分组」只删除分组本身，其中全部素材保留。

### 回收站

移入回收站的素材保留 90 天，卡片上显示剩余天数倒计时；删除后弹出的提示条上有「撤销」，6 秒内点一下就恢复原状。在回收站里右键可以「恢复」或「永久删除」，空白处右键可以「全选」和「清空回收站」（清空需确认，不可恢复）。把堆叠移到回收站时成员素材一起进入，从回收站恢复后堆叠关系和手动顺序自动重建。回收站视图顶栏还有「清空回收站」按钮；选中素材后按 Delete 或 ⌫ 也能移至回收站；和右键菜单一样，勾过「不再提醒」就不再弹确认。

### 设置

设置在左下角「用户中心」，分五页：「常规」（主题、显示素材名称、界面语言）、「存储」（素材库位置与存储类型，可「打开」或「修改」）、「连接」（Pinterest 连接卡片）、「反馈」、「关于」（版本信息、检查与下载更新、本版本更新内容）。

### 反馈

「设置 → 反馈」里选择类型（问题 / 建议 / 其他），写正文（最多 5000 字），联系方式可选。「附上诊断日志」默认不勾选；勾选后可用「查看内容」看到将要发送的完整日志——路径中的用户名、令牌和邮箱已打码，可能含提示词的行会整行去掉。发送时会自动附上 App 版本、操作系统和芯片架构的摘要，正文和联系方式不会在后台被收集，只有点「发送」才提交。

## 检索与版本

- 图库使用缩略图，详情使用预览图，原图保持可访问。
- 旧版本导入、没有记录宽高的图片，会在服务启动后自动补齐尺寸并重新生成缩略图和预览图；尺寸缺失时，大图查看器也会按图片实际尺寸显示。只更新部分字段的元数据写入（HTTP `PATCH /api/assets/:projectId/:assetId`、MCP `asset_update_metadata`）不会清掉没提到的已记录尺寸；`business_fields` 只合并传入的键，值为 `null` 的键会被删除。
- 检视器「版本树」点「查看」展开后，同一版本家族里有两个以上版本时，「版本历史」下方会出现「版本对比」：分别选「基准版本」和「目标版本」，两张图并排显示，并比较尺寸、提示词和版本变更说明；不同的行会高亮，缺失的字段显示为「—」。GravityPort 不会为了对比而推测生成事实。
- Stack 在图库中是一个逻辑节点：单击选择 Stack（检视器显示封面），双击进入 Stack；框选、Shift 范围选择、⌘ 点选和 ⌘A 都把 Stack 当作一张卡片，不会把封面素材误当成整个 Stack。离开 Stack 时会回到之前的画廊视图并恢复滚动位置。
- Stack Inspector 会跟随 Library revision 刷新成员和封面；后台新增、删除、
  恢复或调整 Stack 后不需要重新点选才能看到最新内容。库同步是增量的：一次
  变化只取回并更新受影响的卡片（SSE 携带变更详情，断线或页面恢复时按
  revision 差量补齐），不会因单条素材变化重新拉取整个已加载的图库窗口。
- 下一页预加载失败时，当前图库内容会保留，并停止自动连续重试；用户可以通过
  显示的“加载更多”操作显式重试。
- 界面中的版本树和版本对比只用于查看；创建子版本目前通过 MCP 的 `asset_version_create` 或对应的 HTTP 接口完成，必须填写 `version_change`。提供新的图片路径时保存真实新图，不提供时复制父图作为配方快照。
- 版本历史按稳定深度优先顺序展示，包含归档节点与所有分支。

## MCP 与接口

GravityPort 自带 MCP 服务，通过 stdio 通信，不额外占用端口。AI 助手接上后，可以直接搜索、查看和记录你的素材库。

### 桌面版（推荐）

桌面版安装包里已经带了 MCP 服务，不用装 Node，也不用下载源码：

1. 打开「设置 → 连接」，找到「AI 助手（MCP）」。
2. 选你用的客户端：Claude Desktop、Claude Code 或 Codex，点「复制」。
3. 粘贴：
   - **Claude Desktop**：粘贴到 `claude_desktop_config.json`（Claude 设置 → 开发者 → 编辑配置）。文件里已有 `mcpServers` 的，只把 `gravityport` 这一段并进去。
   - **Claude Code**：复制的是一条 `claude mcp add-json …`（Windows 是 `claude mcp add …`）命令，在终端里运行一次即可。
   - **Codex**：粘贴到 `~/.codex/config.toml` 末尾。
4. 重启这个 AI 助手。

配置里写的是 GravityPort 自己的可执行文件（以 `ELECTRON_RUN_AS_NODE=1` 运行 App 内的 `mcp/server.mjs`）和桌面版记录素材库位置的文件 `library-location.json`，而不是素材库路径本身。所以：

- 在「设置 → 存储」里挪过素材库也不用改配置，重启 AI 助手就会跟过去。挪库时如果 AI 助手开着，它会提示素材库已移动、请重启。
- GravityPort 不用开着；开着时两边同时读写同一个库也是安全的（SQLite WAL）。
- macOS 上请先把 GravityPort 拖进「应用程序」文件夹再复制配置；从「下载」或磁盘映像里直接运行时路径是临时的，设置里会提醒。App 更新后路径不变，配置不用重新复制。
- 记录的素材库找不到（例如外接硬盘没接）时，MCP 服务会在 stderr 写明原因后退出，不会新建一个空库。

### 从源码运行

先执行一次 `npm ci` 完成构建。以 Codex 为例，在 `~/.codex/config.toml` 中加入：

```toml
[mcp_servers.gravityport]
command = "node"
args = ["/absolute/path/to/gravityport/mcp/server.mjs"]
```

其他 MCP 客户端同样填写 `node` 和 `mcp/server.mjs` 的绝对路径即可，也可以用 `npm run mcp` 启动。没有额外配置时，MCP 按与桌面版相同的规则查找默认素材库（`~/MOSA Library` 或 `~/GravityPort Library`）。要指定素材库，可在客户端配置的 `env` 里设置下面任一变量：

- `MOSA_LIBRARY_DIR`：素材库的绝对路径，优先级最高。
- `MOSA_LIBRARY_LOCATION_FILE`：桌面版的 `library-location.json`（macOS 在 `~/Library/Application Support/mosa/`），跟随桌面版里挪过的位置。

MCP 工具包括：

```text
asset_create
asset_list
asset_search
asset_get
asset_provenance_export
asset_update_metadata
asset_attach_prompt
asset_archive
asset_duplicate
asset_version_create
asset_version_history
asset_recipe_history
generation_record
generation_list
generation_relation_record
generation_lineage
```

`asset_list` 和 `GET /api/assets` 支持 `limit` 与 `cursor` 分页，默认 100 条、最大 250 条；`GET /api/assets` 还可用 `createdAfter` / `createdBefore` 传入 ISO-8601 时间做包含边界的创建时间过滤。

`asset_search` 面向 AI agent 的“视觉记忆”检索：可组合文本查询、`createdAfter` / `createdBefore` 时间范围，并在 `visual: true` 时复用**同一资料库**当前正在运行的 GravityPort 本地视觉检索服务（桌面版目前不提供视觉模型，这一项会返回视觉不可用）。MCP 会先核对 loopback Runtime 的 GravityPort 身份和资料库路径；视觉模型未安装、未启用、Runtime 不可达或资料库不匹配时，不会另起一套模型进程，也不会放宽安全边界，而是明确返回视觉不可用原因并保留文本/时间检索结果。文本与视觉同时可用时使用稳定的 reciprocal-rank fusion 合并排序。

`asset_provenance_export` 导出 `mosa.provenance.bundle/1`，包含经过字段白名单/敏感字段清理的素材身份、内容摘要、Recipe 历史、Generation Events/Relations 和 verification level；同时生成一个 `com.azhuilab.mosa.provenance` C2PA assertion payload。该 payload 明确标记为 `signed: false`：它只是交给 C2PA SDK/签名器的可移植声明数据，**不是**已经签名的 Content Credential，GravityPort 不会把未签名记录描述成经过 C2PA 验证的来源证明。

后端 `c2pa-export` 已提供真正的签名导出链路：它把上述 provenance 组装成 `c2pa.actions.v2` + GravityPort 自定义 assertion，通过外部 `c2patool` 写入**新的导出副本**，然后重新读取结果确认 GravityPort assertion 确实存在。开发测试模式可使用 c2patool 自带测试证书；生产模式禁止把私钥塞进 manifest 或环境变量，必须配置独立 subprocess signer。当前这仍是后端能力，尚未接入桌面 UI。

创建子版本时，使用 `asset_version_create` 并传入非空的 `version_change`；有新图时传入 `imagePath`，不传则复制父图作为配方快照；需要读取某个素材的不可变配方快照历史时，使用 `asset_recipe_history`。

生成历史与素材版本是两套关系。`generation_record` 记录一次独立生成，即使输出图片已经被内容去重；`generation_relation_record` 只在有明确证据时记录 `edited_from`、`variant_of`、`derived_from` 或 `based_on`；`generation_lineage` 读取相连的生成图。普通 MCP 调用方不能把记录标成 `provider_verified`，该等级只保留给 GravityPort 直接接入并验证 provider 响应的受信集成。

本地 HTTP 运行时同时提供：

```text
GET  /api/generations
POST /api/generations
POST /api/generation-relations
PATCH /api/generation-relations
DELETE /api/generation-relations
PATCH /api/generation-relation-candidates
GET  /api/generations/:generationId/lineage
```

`GET /api/generations` 可按 `project`、`asset`、`captureContext`、`providerToolCallId`、`providerGenerationCallId` 过滤。`PATCH /api/generation-relations` 可修正用户可管理的关系类型，`DELETE /api/generation-relations` 可解除错误关系；`provider_verified` 关系不能通过这些公共管理接口修改或删除。HTTP API 与 MCP 使用相同的 verification 规则。

资产检视器会把已确认的 Generation Relation 和“可能相关但尚未确认”的生成分开显示。ChatGPT Relation Resolver 会结合 conversation、生成先后、修改型提示词、参考图/provider asset 等信号保存 `relation_candidates` 和置信度，但不会仅凭这些线索自动写入版本树。用户可以对候选点「确认关系」或「忽略候选」，也可以用「添加生成关系」在同一对话里手动选另一张图、关系方向（「关联项为上游 / 下游」）和关系类型，再点「确认添加」；只有显式确认后才以 `user_confirmed` 关系进入生成谱系。被忽略的候选保留 dismissed 状态，后续解析不会反复建议同一对关系。点生成树里的行可以跳到对应输出素材；非 `provider_verified` 的关系可以改类型后「保存关系」或「删除关系」，`provider_verified` 关系显示「提供方验证关系不可修改」。

## 健康检查与维护

服务运行后，可查看当前存储、桥接状态和自动发现的画布：

```bash
curl -sS http://127.0.0.1:43517/api/library-path
curl -sS http://127.0.0.1:43517/api/bridges
curl -sS http://127.0.0.1:43517/api/cowart-canvases
curl -sS http://127.0.0.1:43517/api/web-capture
```

`/api/bridges` 中的 `lastError` 为空或 `null` 表示没有最近桥接错误；`webCapture.enabled` 只有在配置了 Token 和扩展来源后才为 `true`（Desktop 会自动配置，因此 Desktop 下通常为 `true`）。服务停止时不会丢失已经归档的素材，但新的 Codex、Grok、网页生图或 Cowart 媒体不会即时自动收集。

迁移、校验、派生图修复、端口冲突和恢复边界见 [operations.md](operations.md)。

## 数据安全

- 不要手工修改 `mosa.db`、迁移状态、版本关系或派生图任务。
- 不要为强制重试而删除原 JSON、`legacy-json-backup` 或数据库。
- 不要为了抢占端口直接终止未知服务。
- 不要放宽 Codex 来源目录或 Cowart 画布发现目录。
- 不要提交或公开 Web Capture Token、真实 Prompt、会话标识、页面 URL 或个人素材路径。

更多当前功能与配置请参阅仓库根目录的 [README.md](../README.md)。
