# GravityPort Web Capture（0.15.30）

把 **ChatGPT、Gemini、Flow 和 Google AI Studio 网页**中用户可见的生成媒体归档到本机 GravityPort。ChatGPT 支持图片提示词关联；Flow 与 Google AI Studio 同时支持已识别的视频，Gemini、Flow 与 Google AI Studio 的页面可见 Prompt 均明确标为未验证。

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

自动入库关闭时，扩展不会解析 ChatGPT 的网络生成数据，也不会运行 Google 站点的自动 DOM 扫描；手动保存会在本次操作期间临时启用必要的 ChatGPT 页面关联读取。

ChatGPT 捕获现在把一次响应明确拆成 **Message / Generation Attempt / Output** 三层，而不是把一个 tool call 里的所有图片和 Prompt 塞进同一个上下文。Attempt 保存 generation-call / tool-call、共享 Prompt 和生成状态；每个 Output 单独保存 provider asset / Estuary identity、输出级 Prompt 和媒体证据。输出级 Prompt 只属于自己的图片；真正的 Attempt 共享 Prompt 才会分发给同一次生成里的多个 Output。图片先到、Prompt 后到或多张图并行完成都可以按稳定标识补齐，不再依赖“最近几秒出现的文字”猜测。

失败、取消、部分完成和重试也作为独立 Attempt 处理。若同一消息中 `gen-a` 失败而 `gen-b` 成功，两个 generation-call 不会因为 message ID 相同而合并；存在多个 Attempt 时，message 级兜底会直接失效，宁可保留 `not-available` 也不会把失败尝试的 Prompt 借给成功图片。一个 Attempt 有多张图时，晚到的共享 Prompt 会逐张升级所有 Output，不会只升级第一张。

如果 ChatGPT 实际只返回一个拼图 / 多宫格文件，它仍然是一个 Output。只有 provider 元数据明确给出整张 Output 的共享 Prompt 时才保存该 Prompt；若只发现多个同优先级 panel Prompt 而无法证明哪一个描述整张拼图，GravityPort 会保留 `not-available`，不会任意挑第一条。页面中的 `failed / timeout / cancelled` 等错误说明只作为生成状态证据，不会再被当成 `visible-caption` Prompt。

自动收录还会结合生成状态和短暂的媒体稳定窗口：`in_progress / partial` 输出优先等待后续状态，`completed / failed / cancelled` 进入终态后可立即处理；没有明确状态的媒体需要先稳定一小段时间。这样可以降低中间预览图、错误后的残留图抢先入库的概率，同时保留终态到达后重新确认同一输出的能力。

ChatGPT Prompt 字段使用确定性的来源优先级：`revised_prompt` → `generation_prompt` → `image_prompt` → image-generation 工具内部的 `original_prompt` / `prompt` → `Model caption` / `model_caption` → 其他明确 caption。snake_case 与 camelCase 字段会统一归一化。用户原始指令继续单独保存在 `user_message`，不会伪装成模型实际执行的生图 Prompt。

ChatGPT 生图调用参数里的 `prompt`（对话模型发给生图工具的提示词）作为独立的“提示词2”保存在 `generation_request_prompt`，不参与上面的优先级，也不替换 Prompt。它同样只在实时推送里出现：扩展按图片消息的 `parent_id` 对应到发起调用的消息；没有 `parent_id` 时，只在同一轮里恰好有一次同一工具的调用时才对应。
不会把整页最后一条用户消息误配给历史图片。

ChatGPT 网页捕获现在会把“媒体”和“生成事件”分开记录。同一张去重后的图片可以对应多次独立生成；GravityPort 自己构造的 `capture_context_id` 只用于关联一次网页捕获，不会冒充 OpenAI 的 generation-call ID。若页面运行时数据明确包含 tool-call、generation-call、response 或 provider asset ID，会分别保存为 provider 字段，但其证据等级仍是 `observed`，不是 OpenAI 公共 API 的 `provider_verified`。延迟补抓时优先沿用生成事件自身携带的 conversation ID，不只依赖当前页面 URL。网页捕获不会仅凭会话顺序自动建立父子版本关系。

自 `0.15.18` 起，新会话在地址栏尚未出现 `/c/<conversationId>` 时，实时 transport 中已经观察到的 conversation identity 会先作为当前会话身份使用；随后 URL 获得同一 ID 只做身份补全，不再清空 live-only 的 Model caption、ImageGen request Prompt 或 generation registry。ChatGPT 的 `blob:` 输出若所在 DOM wrapper 同时列出 displayed/commentary 等多个 message ID，只有这些 ID 全部能唯一归并到同一个 Generation Attempt 时才允许绑定；跨 retry/失败 Attempt 或存在未知 message ID 时仍保持 fail-closed。

自 `0.15.19` 起，ChatGPT 新版"一轮多张图"画廊（大图 + 缩略图条，页面上只有同源 `blob:` 地址、同一消息 ID 重复 N 次）不再因此全部丢失 Model caption。页面取生成图的固定链路是 `fetch /backend-api/estuary/content?id=file_X` → `Response.blob()` → `URL.createObjectURL()`；page-hook 会把"下载得到的 Blob → 文件编号 file_X"记进 WeakMap，并在 `createObjectURL` 时经既有页面通道发出 `blob-asset` 消息，内容脚本只在校验同源 `blob:` 与 `file_` 形态编号后把 `blob:` 地址补进图片身份键。绑定因此直接按文件编号对上实时推送里各图的 caption，不再依赖消息 ID（消息 ID 在多次生成时按设计放弃绑定）；对应关系只发送 `id` 这一个参数，`sig`/`p`/`cid`/`ts` 等签名或令牌参数不读取、不保存、不发送。批量请求（`batch_requests` 多条）下的"提示词2"（`generation_request_prompt`）保持留空：页面上没有能把某张图可靠对应到第几条请求的证据（final 消息中途的图片顺序是完成顺序），宁可缺也不配错。

自 `0.15.20` 起，画廊里没点开的图也会入库：只要某个 `blob:` 地址有文件编号映射且注册表里有该文件编号的生成证据，缩略图不再要求 `<img>` 加载完成——字节直接按 `blob:` 地址从页面内存读取，真实宽高由解码后的字节判定（仍套用"已证明生成图"的 256px 最小边），大图与缩略图共用同一 `blob:` 身份，依旧只入库一次。

自 `0.15.21` 起，ChatGPT 通过流式请求（`POST /backend-api/f/conversation` 的 SSE）推送的回复改为边收边解析：按 `delta encoding v1` 的 add 与补丁事件在流中重建消息，图片的生成 ID、资源 ID 与消息 ID 在事件到达时立即绑定，页面在 `[DONE]` 之后中止请求也不再丢失整轮内容；补丁支持 append（含对象合并与 `/message/content/parts/N` 数组下标）、replace 与跨事件续接 append，遇到不认识的补丁直接忽略，单条流沿用 12MB 解析上限。旧的缓冲解析与非 SSE 的 JSON 响应路径保持不变。

自 `0.15.22` 起，page-hook 与内容脚本之间改用一次性移交的私有 `MessagePort` 通信，不再把通道名写在 DOM 里，页面上后注入的脚本既拿不到通道也无法伪造采集事件；同时 provider 页面的内容脚本向 background 请求设置时只拿到 `autoCapture` 一个字段，Token 不再下发到页面环境。

自 `0.15.23` 起，图生图轮次恢复收录上传的参考图：ChatGPT 把一条用户消息拆成"附件单元 + 文字单元"两个兄弟节点后，原有的选择器只能认到不含图的文字单元，参考图因此一张也收不到。现在 `:user` 结尾的 `data-chatgpt-search-unit-key` 单元与 `data-content-search-unit-key` 单元同等识别，并按同一个 turn 容器（或 unit-key 前缀）合并同一条用户消息的全部用户单元取图；取图范围仍限定在用户单元内部，同一容器里助手单元生成画廊中的图不会被误判为参考图，输入框里的附件照旧跳过。

自 `0.15.24` 起，采集载荷会附带当前 ChatGPT 对话的标题（优先读 `document.title` 并去掉“ - ChatGPT”这类站名后缀，读不到再取侧栏当前对话项的文字；“ChatGPT / New chat / 新聊天 / 新对话”等占位标题视为无标题，且仅当图片的 conversation ID 与当前网址一致时才附带）。GravityPort 用它给还没有名字的会话堆叠自动命名；重新打开旧对话时，标题也会单独上报一次补齐（同一对话同一标题每次浏览器会话只发一次，未配对 Token 时不发），用户自己起过名的堆叠不受影响。

自 `0.15.25` 起，扩展会读取**用户自己打开的** ChatGPT 对话的结构，用来给素材标注所在轮次：数据只来自页面自己请求到的当前对话 JSON，只解析当前显示分支里的消息顺序与角色（隐藏的系统消息不计入轮次），把「哪个图片文件属于第几轮」——对话编号、该轮用户消息编号、轮次序号与总轮数、图片文件编号——发给本机 GravityPort。**不读取、不上传对话文字、提示词、标题或图片地址**；编辑掉的其他分支不读取；用户上传的图和仅被引用的图不参与；插件从不自己请求对话接口，也不读取未打开的对话。同一对话的同一结构每次浏览器会话只发一次，发送失败不记住、下次打开对话自然重试，未配对 Token 时不发；同一批次超过 2000 条时整批不发（截断会让轮次总数与素材对不上）。

自 `0.15.27` 起，ChatGPT 消息列表里省略掉的内部节点（工具调用等）不再让整批轮次作废：某条消息的上一条不在列表里时视为被省略的内部节点；上一条在列表里但排在它后面，仍然整批不发。

自 `0.15.26` 起，适配 ChatGPT 新的对话数据格式（对话改为按时间排好的扁平消息列表加分页字段，不再是分支树）：只在一次请求就拿到完整对话时上报轮次；只返回最近几页的长对话不上报（宁可不显示，也绝不报一个错的轮次），界面退回只显示张数，往上翻页拼接是后续工作。原有分支树格式的解析保持不变。


GravityPort 会在本地为同一 ChatGPT conversation 的 Generation Event 计算“关系候选”，但不会自动写成正式父子边。明确复用先前生成图的 provider asset ID 是强证据；“再改一下 / 把背景换黑 / 保持其他不变”等修改型用户指令、相邻生成和时间距离只能作为辅助信号。候选必须由用户确认后才进入正式生成树；只因为两张图前后出现，不会自动建立版本关系。

ChatGPT 中能够明确识别为本轮上传输入的参考图，会作为该轮生成记录的私有附件保存：按内容 hash 去重，绑定到随后生成图片的 recipe snapshot，但不会作为独立素材出现在瀑布流、搜索、最近添加或素材总数中。旧版已作为普通素材入库的参考图不会被自动迁移或删除。Google 站点只有在页面结构和会话标识都能可靠确认时才会采用同一机制；当前不会仅凭“图片出现在生成图之前”猜测参考关系。

提示词来源有三条通道，互为兜底：

1. **实时流**：ChatGPT 对多数账号用 WebSocket 推流，扩展会解析其中带图片资产的帧（`fetch`/`XHR` 看不到这些）。
2. **会话元数据**：打开或切换会话时页面自己拉取的会话 JSON。
3. **主动重读**：生成证据恢复会在约 2.8 秒、7.2 秒、15 秒分阶段重试；提示词升级仍采用有界延迟重读。所有请求只使用当前站点已有的同源浏览器会话去读当前会话，不会读取、复制或重放 ChatGPT 的 Authorization 请求头。拿到更好的提示词会通过 hash 去重自动升级已入库的图。

第 3 条失败时右下角面板会显示原因，不再静默丢失。

打开 Gemini（`gemini.google.com`）、Flow（`labs.google` 或新版独立域名 `flow.google.com`）或 Google AI Studio（`aistudio.google.com`）出图后，扩展只对视口中已加载且达到最小尺寸的用户可见图片自动入库。Gemini 只读取生成图所属 `model-response` 前、同一局部消息结构中的最近可见 `user-query`；Flow 优先使用图片组内唯一、相邻且带「Reuse Prompt」语义的 Prompt 卡片，在本地化界面没有该英文标签时，仅当局部生成结构中仍然只有一个可用 Prompt 卡片才接受，存在歧义则留空；AI Studio 只读取图片所在 `ms-chat-session` 内、图片 Model 回合之前最近的页面可见用户 Prompt 回合。三者均标记为「未验证为实际生图提示词」，不会读取输入框、编辑器、隐藏内容、模型思考、其他会话或登录信息；若图片先于 Prompt 完成渲染，只会对同一图片的局部关联信息进行有界重试。

远程生成媒体在提交前会进入扩展本地待处理队列，GravityPort 暂时未运行或扩展 Service Worker 被浏览器回收时会保留任务并在后续重新尝试。队列任务最长保留 7 天，过期记录会从本地存储清除；同一媒体后来拿到更完整的终态或 Prompt 时会更新原队列票据，而不是继续重放旧的 `in_progress / not-available` 元数据。纯页面本地 `blob:` 图片和视频字节会先写入扩展自己的 IndexedDB spool，标签页关闭后仍可由 Service Worker 继续投递；单个存储故障也不会反过来阻断 GravityPort 当前在线时的实时入库。Flow / AI Studio 的大体积页面本地视频使用分块扩展消息并逐块写入 IndexedDB，远程 HTTPS 视频则直接读取响应流；投递到 GravityPort 时两者都通过临时上传会话逐块写入本地临时文件。扩展后台不再在内存中保留整段视频，GravityPort commit 时也使用文件流计算内容哈希后直接导入。上传会话按顺序校验 chunk、限制总大小，并在 commit、abort 或超时清理临时文件；远程响应即使没有 `Content-Length` 也会在接收过程中持续执行 96 MiB 上限。原始媒体 URL 与实际重定向后的最终媒体 URL 会作为来源证据保存，但会移除签名、令牌和无关查询参数，仅保留必要的稳定媒体标识；最终重定向目标仍需通过媒体域名白名单。

后台消息现在会校验扩展自身 sender、顶层 frame、当前 Provider URL 和消息类型，视频分块传输也绑定到创建它的 tab / Provider，避免其他页面或错误 frame 复用入库消息。ChatGPT MAIN-world bridge 同时使用每个 document 独立的 channel 标识过滤陈旧或无关消息；这属于纵深防御，不把同一网页 MAIN world 中已经执行的站点脚本错误描述为密码学不可信边界。Gemini / Flow / AI Studio / ChatGPT 的 URL 归属判定统一收口到 `provider-policy.js`，后台安全门和页面适配器共用同一套规则。

在这三个 Google 站点上，也可右键生成图片后选择「保存图片到 GravityPort」；Gemini、Flow 与 AI Studio 手动保存时也只会按上述局部规则匹配 Prompt，未匹配则不保存文字。

## 数据与权限

- 扩展只在清单声明的 ChatGPT、Gemini、Flow 和 Google AI Studio 域名中运行，并只把数据发送到选项中配置的本机 GravityPort 地址。
- ChatGPT 入库数据包括图片字节、匹配到的 Prompt/用户消息、页面 URL、会话/消息 ID、模型信息、采集时间和扩展版本；页面运行时明确暴露时，还会保存彼此独立的 tool-call、generation-call、response 和 provider asset 标识。Gemini、Flow 与 AI Studio 只有在上述局部匹配成功时才额外包括该页面可见 Prompt。
- GravityPort 地址、Token 和自动采集开关保存在 Chrome 本地存储，不使用同步存储。
- 图片下载需要清单中列出的 OpenAI/Google 静态资源域名权限；本机通信只允许 `127.0.0.1` 或 `localhost`。
- GravityPort 不会因此获得任何受支持站点的账号密码或 API Key。完整说明见 [PRIVACY.md](../../PRIVACY.md)。

## 限制

ChatGPT 的 `Model caption` 只在实时推送中出现：它是 `commentary` 工具消息里与图片并列的字符串，这条消息和页面显示的图片消息不同，但共享同一 `gen_id`。存档会话（`/backend-api/conversations/…`）与图库接口都不含 caption，因此扩展安装前生成的图片无法补回 Prompt。自 2026-09-24 起页面图片改用 `blob:` 预览；`0.15.16` 让生成单元沿用同一消息里唯一的 caption，并通过 `gen_id` 绑定到页面显示的图片。`0.15.14` 按同一轮（`turn_exchange_id`）绑定长文本的逻辑已撤回：它会把工具状态说明（“Generated images … were saved at”）或技能（Skill）说明误当成 Prompt。

- Google 站点使用稳定性较低的可见 `<img>` 识别；全屏看图器或站点更新可能需要刷新页面后重试
- 全屏看图器 DOM 多变；若自动没命中，用悬浮「保存当前图」
- GPT 网页未暴露生成 metadata 时，扩展只保留对应用户消息，不会伪造模型实际执行的提示词
- 启发式判断“像生图 Prompt”的文本只作为恢复线索，不会被升级为 `generation-tool-prompt`
- 无标记的 caption 只在**图片工具消息**内被接受；助手的普通回复即使提到风格词也不会被当成提示词
- 用户消息里粘贴的 `Model caption:` 文本不会被当成模型 caption
- 重读会话不会读取或复制 ChatGPT 的 Authorization 请求头；若同源会话请求无法返回元数据，扩展保留已捕获的图片并把 Prompt 标记为不可用
- 相同内容 hash 去重
- 参考图附件不进入素材库；当前可靠自动识别以 ChatGPT 上传输入为准，Flow/Gemini 不按页面顺序猜测参考图
- 改扩展代码后要在 `chrome://extensions` 点刷新，并硬刷新网页

## 许可

本扩展是 GravityPort 的组成部分，受仓库根目录 [LICENSE](../../LICENSE) 约束。重新分发时必须保留许可证条款和 Required Notice。
