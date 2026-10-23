# GravityPort Web Capture（0.15.40）

把 **ChatGPT、Gemini、Flow、Google AI Studio、即梦（Jimeng）和 Midjourney 网页**中用户可见的生成媒体归档到本机 GravityPort。ChatGPT 支持图片提示词关联；Flow、Google AI Studio、即梦与 Midjourney 同时支持已识别的视频，Gemini、Flow、Google AI Studio、即梦与 Midjourney 的页面可见 Prompt 均明确标为未验证。

> 本扩展随 GravityPort 一同采用 [PolyForm Noncommercial License 1.0.0](../../LICENSE)：允许非商业使用、修改和传播；商业用途须另行取得书面授权。

## 首次配置

1. Chrome 打开 `chrome://extensions` 并开启**开发者模式**。
2. 选择**加载已解压的扩展程序**，加载本目录。
3. 打开 GravityPort Desktop App。
4. 扩展会自动在本机固定 discovery 端口中查找 GravityPort，验证产品身份后完成本地配对，并把地址与 Token 只保存在 `chrome.storage.local`。
5. 首次安装会自动打开扩展设置页。确认数据说明后勾选**发现新图时自动入库**；新安装默认关闭自动收录。
6. 刷新要使用的网页。

Desktop App 默认不需要手填地址、Token 或扩展 ID。GravityPort 会为官方扩展使用固定 ID，并在首次启动时生成设备级随机 Token，保存在 Electron `userData` 中；如果首选端口被占用，Desktop 会自动使用备用 discovery 端口，扩展也会自动重新发现。

只有从源码用 `npm start` 启动独立 Web Runtime 时，才需要开发者手工配置：

```bash
MOSA_WEB_CAPTURE_TOKEN='replace-with-a-random-secret' \
MOSA_WEB_CAPTURE_ORIGINS='chrome-extension://replace-with-extension-id' \
npm start
```

未配置 Token 时 Web Capture 保持禁用；扩展来源不在白名单中时请求会被拒绝。不要在共享环境、Issue、日志或截图中公开 Token。

## 加载 / 更新扩展

更新扩展代码后，在 `chrome://extensions` 点扩展卡片上的**刷新**，然后硬刷新要使用的网页。源码 / 本地开发包通过 manifest public key 保持固定的本地扩展 ID；Chrome Web Store 发布包会在打包时移除该 key，并由商店 listing 自身固定扩展身份。

## 使用

打开 chatgpt.com 出图后：

1. **自动**：发现大图会自动 POST 到 GravityPort（toast 提示）
2. **手动**：右下角悬浮 **GravityPort** 面板
   - **保存当前图**：页面上最大的那张
   - **保存全部大图**：本页最多 12 张

自动入库关闭时，扩展不会解析 ChatGPT 的网络生成数据，不会领取或打开 ChatGPT 桌面版对话，也不会运行 Google 站点的自动 DOM 扫描；手动保存会在本次操作期间临时启用必要的 ChatGPT 页面关联读取。也不会单独上报 ChatGPT 对话标题（自 0.15.36 起；手动保存的素材照旧带上标题）。自动入库开着时，扩展会把当前打开的 ChatGPT 对话标题和对话号发给本机 GravityPort，仅用于给已有的该对话堆叠命名。

ChatGPT 捕获现在把一次响应明确拆成 **Message / Generation Attempt / Output** 三层，而不是把一个 tool call 里的所有图片和 Prompt 塞进同一个上下文。Attempt 保存 generation-call / tool-call、共享 Prompt 和生成状态；每个 Output 单独保存 provider asset / Estuary identity、输出级 Prompt 和媒体证据。输出级 Prompt 只属于自己的图片；真正的 Attempt 共享 Prompt 才会分发给同一次生成里的多个 Output。图片先到、Prompt 后到或多张图并行完成都可以按稳定标识补齐，不再依赖“最近几秒出现的文字”猜测。

失败、取消、部分完成和重试也作为独立 Attempt 处理。若同一消息中 `gen-a` 失败而 `gen-b` 成功，两个 generation-call 不会因为 message ID 相同而合并；存在多个 Attempt 时，message 级兜底会直接失效，宁可保留 `not-available` 也不会把失败尝试的 Prompt 借给成功图片。一个 Attempt 有多张图时，晚到的共享 Prompt 会逐张升级所有 Output，不会只升级第一张。

如果 ChatGPT 实际只返回一个拼图 / 多宫格文件，它仍然是一个 Output。只有 provider 元数据明确给出整张 Output 的共享 Prompt 时才保存该 Prompt；若只发现多个同优先级 panel Prompt 而无法证明哪一个描述整张拼图，GravityPort 会保留 `not-available`，不会任意挑第一条。页面中的 `failed / timeout / cancelled` 等错误说明只作为生成状态证据，不会再被当成 `visible-caption` Prompt。

自动收录还会结合生成状态和短暂的媒体稳定窗口：`in_progress / partial` 输出优先等待后续状态，`completed / failed / cancelled` 进入终态后可立即处理；没有明确状态的媒体需要先稳定一小段时间。这样可以降低中间预览图、错误后的残留图抢先入库的概率，同时保留终态到达后重新确认同一输出的能力。

ChatGPT Prompt 字段使用确定性的来源优先级：`revised_prompt` → `generation_prompt` → `image_prompt` → image-generation 工具内部的 `original_prompt` / `prompt` → `Model caption` / `model_caption` → 其他明确 caption。snake_case 与 camelCase 字段会统一归一化。用户原始指令继续单独保存在 `user_message`，不会伪装成模型实际执行的生图 Prompt。

ChatGPT 生图调用参数里的 `prompt`（对话模型发给生图工具的提示词）作为独立的“提示词2”保存在 `generation_request_prompt`，不参与上面的优先级，也不替换 Prompt。它同样只在实时推送里出现：扩展按图片消息的 `parent_id` 对应到发起调用的消息；没有 `parent_id` 时，只在同一轮里恰好有一次同一工具的调用时才对应，不会把整页最后一条用户消息误配给历史图片。

ChatGPT 网页捕获现在会把“媒体”和“生成事件”分开记录。同一张去重后的图片可以对应多次独立生成；GravityPort 自己构造的 `capture_context_id` 只用于关联一次网页捕获，不会冒充 OpenAI 的 generation-call ID。若页面运行时数据明确包含 tool-call、generation-call、response 或 provider asset ID，会分别保存为 provider 字段，但其证据等级仍是 `observed`，不是 OpenAI 公共 API 的 `provider_verified`。延迟补抓时优先沿用生成事件自身携带的 conversation ID，不只依赖当前页面 URL。网页捕获不会仅凭会话顺序自动建立父子版本关系。

各版本的具体改动（ChatGPT 多图画廊、流式解析、参考图、对话轮次等）见 [CHANGELOG.md](CHANGELOG.md)。

GravityPort 会在本地为同一 ChatGPT conversation 的 Generation Event 计算“关系候选”，但不会自动写成正式父子边。明确复用先前生成图的 provider asset ID 是强证据；“再改一下 / 把背景换黑 / 保持其他不变”等修改型用户指令、相邻生成和时间距离只能作为辅助信号。候选必须由用户确认后才进入正式生成树；只因为两张图前后出现，不会自动建立版本关系。

ChatGPT 中能够明确识别为本轮上传输入的参考图，会作为该轮生成记录的私有附件保存：按内容 hash 去重，绑定到随后生成图片的 recipe snapshot，但不会作为独立素材出现在瀑布流、搜索、最近添加或素材总数中。旧版已作为普通素材入库的参考图不会被自动迁移或删除。Google 站点只有在页面结构和会话标识都能可靠确认时才会采用同一机制；当前不会仅凭“图片出现在生成图之前”猜测参考关系。

提示词来源有三条通道，互为兜底：

1. **实时流**：ChatGPT 对多数账号用 WebSocket 推流，扩展会解析其中带图片资产的帧（`fetch`/`XHR` 看不到这些）。
2. **会话元数据**：打开或切换会话时页面自己拉取的会话 JSON。
3. **主动重读**：生成证据恢复会在约 2.8 秒、7.2 秒、15 秒分阶段重试；提示词升级仍采用有界延迟重读。所有请求只使用当前站点已有的同源浏览器会话去读当前会话，不会读取、复制或重放页面的 Authorization 请求头（唯一例外是下文「ChatGPT 桌面版对话」的后台检查：扩展向 chatgpt.com 取一次登录令牌，只用于那一次读取）。拿到更好的提示词会通过 hash 去重自动升级已入库的图。

第 3 条失败时右下角面板会显示原因，不再静默丢失。

打开 Gemini（`gemini.google.com`）、Flow（`labs.google` 或新版独立域名 `flow.google.com`）或 Google AI Studio（`aistudio.google.com`）出图后，扩展只对视口中已加载且达到最小尺寸的用户可见图片自动入库。Gemini 只读取生成图所属 `model-response` 前、同一局部消息结构中的最近可见 `user-query`；Flow 优先使用图片组内唯一、相邻且带「Reuse Prompt」语义的 Prompt 卡片，在本地化界面没有该英文标签时，仅当局部生成结构中仍然只有一个可用 Prompt 卡片才接受，存在歧义则留空；AI Studio 只读取图片所在 `ms-chat-session` 内、图片 Model 回合之前最近的页面可见用户 Prompt 回合。三者均标记为「未验证为实际生图提示词」，不会读取输入框、编辑器、隐藏内容、模型思考、其他会话或登录信息；若图片先于 Prompt 完成渲染，只会对同一图片的局部关联信息进行有界重试。

**即梦**（`jimeng.jianying.com`，生成页与对话页）：扩展只读页面自己收到的 `/mweb/v1/` 接口响应（生成状态轮询与历史列表），从新生成的记录里取带签名的大图 / 视频网址、提示词、模型名、尺寸与参考图。图片和视频的签名网址会过期，因此出图当时就下载字节；GravityPort 没开时沿用 0.15.38 的离线字节队列。页面打开前就已存在的历史记录只记为基线、不自动入库，需要时右键「保存图片/视频到 GravityPort」。**Midjourney**（`www.midjourney.com`，`/imagine` 出图页）：从渲染的网格里识别 `cdn.midjourney.com` 预览图，优先在扩展后台带 Cookie 下载同路径的无后缀原图 PNG；拿不到原图时存预览图并在素材来源里标注 `media_variant: preview`。提示词取图片所在任务卡片的可见文本（`--ar`、`--v` 等参数原样保留），一个任务（job）算一次生成会话。MJ 已加载的历史卡片（打开页面时已存在、滚动触发的批量加载）只记为基线不自动入库；新生成的单张任务卡自动收。两站的页面可见提示词同样标记为「未验证为实际生图提示词」。

远程生成媒体在提交前会进入扩展本地待处理队列，GravityPort 暂时未运行或扩展 Service Worker 被浏览器回收时会保留任务并在后续重新尝试。队列任务最长保留 7 天，过期记录会从本地存储清除；同一媒体后来拿到更完整的终态或 Prompt 时会更新原队列票据，而不是继续重放旧的 `in_progress / not-available` 元数据。GravityPort 没开时，图片本身会先存进扩展的 IndexedDB（总量最多 512MB，超出后最旧的票据先退回仅网址，没有网址的直接移除），不再只留一个可能很快过期的下载网址；只有网址、页面没取到字节的采集会在入队时趁网址最新鲜当场补抓一次，抓不到才保持仅网址。纯页面本地 `blob:` 图片和视频字节会先写入扩展自己的 IndexedDB spool，标签页关闭后仍可由 Service Worker 继续投递；单个存储故障也不会反过来阻断 GravityPort 当前在线时的实时入库。Flow / AI Studio 的大体积页面本地视频使用分块扩展消息并逐块写入 IndexedDB，远程 HTTPS 视频则直接读取响应流；投递到 GravityPort 时两者都通过临时上传会话逐块写入本地临时文件。扩展后台不再在内存中保留整段视频，GravityPort commit 时也使用文件流计算内容哈希后直接导入。上传会话按顺序校验 chunk、限制总大小，并在 commit、abort 或超时清理临时文件；远程响应即使没有 `Content-Length` 也会在接收过程中持续执行 96 MiB 上限。原始媒体 URL 与实际重定向后的最终媒体 URL 会作为来源证据保存，但会移除签名、令牌和无关查询参数，仅保留必要的稳定媒体标识；最终重定向目标仍需通过媒体域名白名单。已过期的媒体网址（403 / 404 / 410）在重试 3 次后按「网址已过期」放弃并移出队列，不再每分钟空转；网络错误与 5xx 照旧重试。

后台消息现在会校验扩展自身 sender、顶层 frame、当前 Provider URL 和消息类型，视频分块传输也绑定到创建它的 tab / Provider，避免其他页面或错误 frame 复用入库消息。ChatGPT MAIN-world bridge 同时使用每个 document 独立的 channel 标识过滤陈旧或无关消息；这属于纵深防御，不把同一网页 MAIN world 中已经执行的站点脚本错误描述为密码学不可信边界。Gemini / Flow / AI Studio / ChatGPT 的 URL 归属判定统一收口到 `provider-policy.js`，后台安全门和页面适配器共用同一套规则。

在 ChatGPT、这三个 Google 站点和即梦 / Midjourney 上，也可右键生成图片后选择「保存图片到 GravityPort」；Flow、AI Studio、即梦与 Midjourney 的视频可右键选择「保存视频到 GravityPort」；Gemini、Flow、AI Studio 手动保存时也只会按上述局部规则匹配 Prompt，未匹配则不保存文字（即梦 / Midjourney 手动保存会带上本次会话从接口或卡片学到的提示词与模型名）。

### ChatGPT 桌面版对话

ChatGPT 桌面版（与 Codex 合在一个 App 里）不会把聊天里的图片和文字存到本机。GravityPort 启用 Codex 来源时，约每 10 秒查看一次桌面版的本地状态文件 `<CODEX_HOME>/.codex-global-state.json`（默认在 `~/.codex/`），只取桌面聊天绑定的 ChatGPT 对话号和每段对话最后一次提问的消息编号，据此判断哪段对话刚用过。对话安静 90 秒后，GravityPort 在扩展每分钟一次的本机状态上报回复里把它交给扩展，一次一段；只有已配对、开启了**发现新图时自动入库**、且当前没有同步窗口打开的扩展才会领取。

扩展先用浏览器里已登录的 ChatGPT 账号读一次这段对话：后台向 `https://chatgpt.com/api/auth/session` 取一次当前登录的访问令牌，只作为 Authorization 头用于这一次 `chatgpt.com/backend-api/conversation/<对话号>` 请求，不保存，也不发给 GravityPort 或其他任何地方。对话内容只用来判断其中有没有非用户消息里的图片，不保存也不上报。没有生成图就回报「无图」，不开窗口；有图（或读不到）时，在一个最小化、不抢焦点的新窗口里打开 `https://chatgpt.com/c/<对话号>#gravityport-desktop-sync`，按普通 ChatGPT 页面流程采集，采集安静 10 秒（至少 20 秒、最多 110 秒）后自动关窗。一次只开一个窗口，约 150 秒仍未结束按超时关闭；手动关掉窗口算本次失败，每次活动最多尝试 3 次。和在浏览器里重开旧对话一样，能收到图和用户原话，收不到 Model caption 与提示词2。浏览器登录的 ChatGPT 账号与桌面版不同时读不到对话，也不会入库。

GravityPort 只在素材库根目录的 `.chatgpt-desktop-sync.json` 里记录对话号、时间戳、重试计数和最后一次提问编号的 hash，不保存提示词文字。首次读到状态文件时，里面列出的每段桌面对话都会被检查一次。关闭扩展的自动入库即停止领取；`MOSA_DISABLE_BRIDGES=codex` 会让 GravityPort 完全不读该状态文件（同时停用 Codex 图片导入）。

## 数据与权限

- 扩展只在清单声明的 ChatGPT、Gemini、Flow、Google AI Studio、即梦和 Midjourney 域名中运行，并只把数据发送到选项中配置的本机 GravityPort 地址。即梦侧只读页面自己的 `/mweb/v1/` 响应，从不修改请求；Midjourney 侧只读渲染后的 DOM 与 `cdn.midjourney.com` 媒体。
- ChatGPT 入库数据包括图片字节、匹配到的 Prompt/用户消息、「提示词2」（`generation_request_prompt`，页面实时数据中出现时）、页面 URL、去掉签名参数的原始与最终媒体 URL、尺寸、会话/消息 ID、对话标题、模型信息、生成状态、采集时间和扩展版本；页面运行时明确暴露时，还会保存彼此独立的 tool-call、generation-call、response 和 provider asset 标识。打开对话时另会上报对话轮次结构（只有编号与数字）。Gemini、Flow 与 AI Studio 只有在上述局部匹配成功时才额外包括该页面可见 Prompt。
- GravityPort 地址、Token、自动采集开关和待重试队列保存在 Chrome 本地存储（`chrome.storage.local`），不使用同步存储；桌面版对话同步进行中的任务（对话号、窗口/标签页编号、开始时间）只存在浏览器关闭即清空的 `chrome.storage.session`。
- 清单权限为 `storage`、`contextMenus`、`alarms`、`unlimitedStorage`（最后这项用于上面说的离线字节队列，Chrome 不因它弹新的安装警告）；图片下载需要清单中列出的 OpenAI/Google/即梦（`*.byteimg.com`、`*.jimeng.com`、`*.vlabvod.com`）/Midjourney（`cdn.midjourney.com`）静态资源域名权限；本机通信只允许 `127.0.0.1` 或 `localhost`。
- GravityPort 不会因此获得任何受支持站点的账号密码或 API Key。完整说明见 [PRIVACY.md](../../PRIVACY.md)。

## 限制

ChatGPT 的 `Model caption` 只在实时推送中出现：它是 `commentary` 工具消息里与图片并列的字符串，这条消息和页面显示的图片消息不同，但共享同一 `gen_id`。存档会话（`/backend-api/conversations/…`）与图库接口都不含 caption，因此扩展安装前生成的图片无法补回 Prompt。自 2026-09-24 起页面图片改用 `blob:` 预览；`0.15.16` 让生成单元沿用同一消息里唯一的 caption，并通过 `gen_id` 绑定到页面显示的图片。`0.15.14` 按同一轮（`turn_exchange_id`）绑定长文本的逻辑已撤回：它会把工具状态说明（“Generated images … were saved at”）或技能（Skill）说明误当成 Prompt。

- Google 站点使用稳定性较低的可见 `<img>` 识别；全屏看图器或站点更新可能需要刷新页面后重试
- 全屏看图器 DOM 多变；若自动没命中，用悬浮「保存当前图」
- GPT 网页未暴露生成 metadata 时，扩展只保留对应用户消息，不会伪造模型实际执行的提示词
- 启发式判断“像生图 Prompt”的文本只作为恢复线索，不会被升级为 `generation-tool-prompt`
- 无标记的 caption 只在**图片工具消息**内被接受；助手的普通回复即使提到风格词也不会被当成提示词
- 用户消息里粘贴的 `Model caption:` 文本不会被当成模型 caption
- 页面重读会话不会读取或复制 ChatGPT 页面的 Authorization 请求头；若同源会话请求无法返回元数据，扩展保留已捕获的图片并把 Prompt 标记为不可用（桌面版对话检查使用的单次令牌见「ChatGPT 桌面版对话」）
- 相同内容 hash 去重
- 参考图附件不进入素材库；当前可靠自动识别以 ChatGPT 上传输入为准，Flow/Gemini 不按页面顺序猜测参考图
- 改扩展代码后要在 `chrome://extensions` 点刷新，并硬刷新网页

## 许可

本扩展是 GravityPort 的组成部分，受仓库根目录 [LICENSE](../../LICENSE) 约束。重新分发时必须保留许可证条款和 Required Notice。
