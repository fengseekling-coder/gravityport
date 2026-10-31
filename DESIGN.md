# 界面设计规范

本文总结 GravityPort 桌面版界面（`web/gravityport`）现在的设计规则，写给改界面的人和代码助手。**代码是准绳**：值以 `web/gravityport/src/index.css` 为准，这里只是归纳。改了样式表里的变量、字号或组件规格，同一个改动里把本文对应的地方一起改掉。

`index.css` 是在原型样式上一层层叠加出来的，`:root` 出现了好几次，后面的覆盖前面的。最终生效的是注释 `Product-wide language` 下面那一层 `--ui-*` 变量；`.app` 里的旧变量名（`--panel`、`--work`、`--text`、`--muted`、`--line`、`--ink-secondary`、`--ink-tertiary`、`--surface-raised`、`--surface-hover`）都指向它们，新代码不要再用旧名字。判断一个元素的最终效果，看浏览器里的计算值，不要只读前面的规则。

## 原则

- 安静：界面是灰阶，图片是主角。强调色只做小面积标记。
- 一种值只有一个出处：颜色、间距、圆角、字号都用变量，不写新的字面量。
- 浅色、深色两套主题同时成立：每加一个颜色，两套主题都要有值、都要读得清。

## 主题和颜色

默认跟随系统。根元素 `.app` 加 `.dark` 就切到深色，`--ui-*` 整体换值。

| 变量 | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--ui-text` | `#292929` | `#f1f1f1` | 正文、标题、选中项和悬停时的文字 |
| `--ui-secondary` | `#707070` | `#b0b0b0` | 次要文字、静止的控件和菜单项 |
| `--ui-muted` | `#737373` | `#909090` | 计数、元数据、占位提示、图标 |
| `--ui-hover` | `#00000005` | `#ffffff08` | 悬停底色（半透明，叠在表面上） |
| `--ui-selected` | `#e8e8e8` | `#ffffff12` | 当前项、按下的行、普通按钮悬停 |
| `--ui-inset` | `#00000004` | `#ffffff06` | 凹进去的区块：搜索框、属性小格、设置分组 |
| `--ui-line` | `#0000000c` | `#ffffff0c` | 细分隔线、输入框描边 |
| `--ui-panel` | `#fafafa` | `#242424` | 侧栏、详情栏、设置窗口、确认框 |
| `--ui-work` | `#dedede` | `#343434` | 画廊和查看器，图片都放在它上面 |
| `--ui-raised` | `#ffffff` | `#2c2c2c` | 浮起来的菜单、下拉、提示条 |
| `--ui-accent` | `#009a1a` | `#39ff14` | 唯一的强调色 |
| `--focus-ring` | `#009a1a` | `#39ff14` | 焦点框、选中卡片的框 |
| `--ui-primary` | `#343434` | `#e3e3e3` | 主按钮底色 |
| `--ui-primary-text` | `#ffffff` | `#292929` | 主按钮文字 |
| `--ui-danger` | `#c45050` | `#ef9494` | 危险操作、错误 |

规则：

- 三种表面各有其位：`--ui-panel` 放两侧和弹窗，`--ui-work` 放画廊，`--ui-raised` 放浮层。半透明的 `--ui-hover`、`--ui-selected`、`--ui-inset`、`--ui-line` 叠在所在表面上用，不要换成实色。
- 文字只有三级：要读的内容 `--ui-text`，静止的控件和说明 `--ui-secondary`，计数和元数据 `--ui-muted`。
- `--ui-accent` 只用在：侧栏当前项的图标、设置当前页的图标、打开的开关、下拉里的勾、选中的外观、提示条图标和「撤销」、焦点框、框选线、拖放目标。不铺大面积；浅色主题下不排小字。
- 主按钮用 `--ui-primary`，不用强调色。
- 图片一律放在纯黑底上（`.black-image`），没加载出来时也是黑块。
- 设置外观页的主题预览是静态小样，不随当前主题换色：预览专用变量 `--preview-*` 钉在 `:root`（浅色面 `--preview-light-surface/-panel/-tile`，深色面 `--preview-dark-surface/-panel/-tile`，跟随系统预览的深色半区 `--preview-dark-tile-split`，预览边线 `--preview-border` 与深色预览边 `--preview-dark-border`，选中描边 `--preview-chosen-outline`，角标 `--preview-badge/-badge-border/-badge-text`，投影 `--preview-shadow`）。这些值只属于预览小样，别的界面不许引用，也不要拿它们替换 `--ui-*`。
- 图片上的小标（堆叠数、视频、回收站倒计时）两套主题都一样：底 `rgba(22, 22, 22, 0.72)`、字 `#f5f5f7`、999px 胶囊、12px 字。
- 「我的分组」的六个标记色在 `context-menus.ts` 的 `GROUP_COLORS`（`#E06C75` `#D19A66` `#98C379` `#61AFEF` `#C678DD` `#56B6C2`），只用在分组名前的 10px 圆点。浅色主题下圆点外加 1px `--ui-line` 细圈（深色不加）：五个标记色在浅色 `--ui-panel` 上不到 3:1，靠这圈标出边界。

对比度（WCAG，正文要求 4.5:1）：

- 达标：`--ui-text` 在三种表面上都在 10:1 以上；`--ui-secondary` 在 `--ui-panel` 上浅色 4.7:1、深色 7.2:1；主按钮文字 11:1 以上。
- 现状不达标、新界面别再这样排小字：浅色 `--ui-secondary` / `--ui-muted` 放在 `--ui-work` 上（3.7 / 3.5:1，工具栏就是这样）；浅色 `--ui-accent` 当文字（在 `--ui-panel` 上 3.6:1）；浅色 `--ui-danger` 放在 `--ui-panel` 上（4.4:1）；深色 `--ui-muted` 放在 `--ui-work` 或 `--ui-raised` 上（3.9 / 4.4:1）。当图标、边框用时这些都够 3:1。

## 字体

- 只用系统字体：`-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif`。不加载网络字体。根字号 12px。
- 只有三档字号：12px 正文、16px 标题、20px 页标题（变量 `--type-body-size`、`--type-title-size`、`--type-page-size`）。11px 只给右键菜单小标题。
- 字重只用 400 / 500 / 600（`--type-weight-regular`、`--type-weight-label`、`--type-weight-title`）。
- 行高：单行控件和列表行 16px，段落 20px（`--type-body-line`），页标题 28px。
- 只有标题收紧字距：16px 标题 -0.3px（确认框标题 -0.5px），20px 页标题 -0.4px。
- 计数、尺寸、百分比、列数用 `font-variant-numeric: tabular-nums`。
- 等宽字只用在两处：反馈页的日志框（11px / 1.5）和连接页 MCP 配置的代码块（11px / 1.6），字体栈 `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`。

## 间距和尺寸

- 4px 一档：`--space-1`（4）、`-2`（8）、`-3`（12）、`-4`（16）、`-5`（20）、`-6`（24）、`-7`（28）、`-8`（32）、`-10`（40）、`-12`（48）、`-14`（56）、`-16`（64）。细线和按下时 1px 的位移不算。
- 控件高度：标准 32px（`--space-8`）、小号 28px（`--space-7`）、三条顶栏 56px（`--space-14`）。
- 侧栏和画廊左右各 12px，详情栏左右 16px，确认框内边距 24px。

## 布局和断点

- 三栏网格：`--sidebar-width`（220px）、画廊、`--inspector-width`（280px）。
- 窗口变窄时：≥1500 详情栏 296px；≤1000 详情栏 248px、查看器缩放条只留图标；≤720 侧栏 128px，详情栏、工具栏下拉、列数按钮隐藏；≤480 侧栏 64px 只留图标。工作区窄于 360px 时搜索框收成图标。
- 画廊是瀑布流，卡片间距 8px（留给框选起手）。列数可选 2 / 3 / 4 / 5 / 6 / 8，默认宽于 1400 为 4 列、窄于 1400 为 3 列、窄于 900 为 2 列（`gallery-columns.ts`）。

## 圆角、线、阴影和遮罩

- `--radius-control`（8px）：所有按钮、输入框、下拉、菜单、提示条、缩略图、图片卡片。`--radius-small` 同为 8px。
- `--radius-panel`（16px）：设置窗口、确认框。
- 999px 胶囊：图片上的小标。正圆：设置窗口关闭按钮、回到顶部、开关的圆点。
- 几乎不描边：区块靠表面颜色区分，必要时一条 `--ui-line`。
- 浮起只用一种阴影 `--ui-shadow`（浅色 `0 16px 48px #0000001c, 0 1px 4px #0000000a`，深色 `0 16px 48px #00000040, 0 1px 4px #00000020`）。下拉和列数弹层再加 `0 0 0 1px var(--ui-line)`。
- 遮罩：设置窗口、确认框、填写框都是 `#00000012`。

## 动效

- 缓动：`--ease-out`（`cubic-bezier(.22, 1, .36, 1)`）。
- 按钮的底色、文字、阴影过渡 180ms，按下下沉 1px。
- 浮层出现统一用 `surface-in`（透明、下移 10px、缩到 0.98 → 原位）：右键菜单 180ms，确认框和填写框 320ms，设置窗口 380ms；遮罩 `veil-in` 240ms；提示条 `toast-in` 上浮 8px，280ms。
- `prefers-reduced-motion: reduce` 时关掉所有动画和过渡。

## 状态

- 悬停：底色 `--ui-hover`，文字变 `--ui-text`。
- 选中：底色 `--ui-selected`，字重 500 或 600；侧栏当前项图标变 `--ui-accent`。
- 焦点：按钮 `outline: 2px solid var(--focus-ring)`、偏移 3px；搜索框 2px 框加 `--ui-raised` 底；画廊里选中框就是焦点框，不再叠第二圈。
- 禁用：透明度 0.4，不响应悬停。
- 图片卡片：悬停内圈 2px `--ui-line`；选中 `.asset-selected` 内圈 2px `--focus-ring`；拖放目标缩到 0.985 加 `--ui-accent` 框。侧栏行做拖放目标时内圈 1.5px `--ui-accent`。

## 图标

- 只用 `Icon.tsx` 里的这一套（34 个）：24 格画布、1.6 线宽、圆头圆角、不填色、`stroke="currentColor"`。
- 尺寸吸附到 12 / 16 / 24 / 32 四档：12 给下拉箭头和行内小标，16 给按钮、侧栏行、菜单项，24 给查看器翻页，32 给空状态和确认框。
- 只有已收藏的心形、图片小标里的堆叠和播放是实心。
- 加新图标照同样的画布、线宽、圆角画，加进 `Icon.tsx` 的表里；不引别的图标库，不用 emoji。

## 组件

| 组件 | 类名 | 要点 |
| --- | --- | --- |
| 主按钮 | `.primary-button` | `--ui-primary` 底，高 32px，左右 12px；一个视图最多一个，只给确认框里真正执行的动作 |
| 普通按钮 | `.neutral-button` | `--ui-inset` 底、`--ui-secondary` 字，悬停 `--ui-selected` |
| 安静按钮 | `.toolbar button`、`.detail-heading button` 等 | 无底，悬停才出 `--ui-hover`；纯图标按钮 28 或 32px 见方，必须有 `aria-label` |
| 分段控件 | `.segmented` + `button.on` | 设置页里底槽 `--ui-inset`、选中 `--ui-raised` 加轻阴影 |
| 开关 | `button.settings-switch` + `.enabled` | 36×20，开时 `--ui-accent`，`role="switch"` |
| 搜索框 | `label.search` | 240×32，`--ui-inset` 底，输入时 `--ui-raised` 加 2px 焦点框 |
| 工具栏下拉 | `ToolbarSelect.tsx` | 列表 `.toolbar-select-menu` 最窄 176px，选项 32px 高，已选项打 `--ui-accent` 勾 |
| 列数 | `ColumnControl.tsx` | 弹层 192px，滑杆 + 2/3/4/5/6/8 刻度 |
| 侧栏 | `.sidebar`、`.nav-row`、`.section-toggle` | 行高 36px，当前项 `--ui-selected` 底加 `aria-current="page"` |
| 侧栏更新提醒 | `.update-ready-slot`、`.update-ready-line` | 更新包下好后的单行提醒，在「用户中心」上方：高 32px、12px 字、`--radius-control`，`--ui-hover` 底悬停加深到 `--ui-selected`；左侧 6px `--ui-accent` 圆点，文字 `--ui-secondary`（版本号 `--ui-text` 字重 500）超长省略号截断，右侧「重启更新」`--ui-text` 保持完整；点击整行即重启更新，更新中禁用并显示「正在更新…」，`title`/`aria-label` 保留完整句子；同一版本装失败两次后不再显示，改由系统对话框引导去官网下载 |
| 图片卡片 | `.asset-card` | 黑底，小标 `.stack-mark` `.video-mark` `.trash-countdown` `.favorite-mark`，名字条 `.card-name`；名字条显示时，收藏心形落在名字条右端、和最后一行对齐，名字给它让出位置。视频卡片封面：界面在后台从视频里抽一帧（跳过片头黑场）存进素材库，之后和图片一样用 `thumbnails/<id>.webp`；抽帧失败或还没完成时，退回显示视频开头附近的某一帧，播放标记始终在 |
| 拖动缩略图 | `.card-drag-ghost` | 跟着指针的缩略图；拖多张时右下角数量角标 `.card-drag-ghost-count`：`--ui-primary` 底、`--ui-primary-text` 字 |
| 详情栏 | `.details` | 概要 → 属性小格 → 标签 → 色板 → 提示词 → 用户指令 → 参考图 → 版本树 → 素材路径。回收站里的素材带回收站原因（`.trash-reason`，12px `--ui-muted` 一行，跟在概要来源行下面）：素材带 `trash_reason` 记录时显示，已知原因两种（被更清晰版本替换、即梦站内删除），未知代码不显示 |
| 右键菜单 | `.context-menu`、`.context-submenu` | 宽 192 / 200px，项高 32px，危险项 `.danger` 放最后一段；子菜单和主菜单同一种表面（`--ui-raised` 底、`--ui-shadow`），小标题 11px `--ui-muted`，分隔线 `--ui-line`；菜单内容以 `context-menus.ts` 为准 |
| 提示条 | `.toast` + `.toast-action` | 一句结果，能撤销就带「撤销」 |
| 确认框 | `.delete-modal` | 图标块、问题标题、一句后果、「取消」+ 写明动作的主按钮 |
| 填写框 | `.group-dialog` | 新建分组并移入、重命名分组和堆叠、合并分组、删除分组；外观同确认框（`--ui-panel` 底、`--radius-panel`、`--ui-shadow`、16px 标题、同一层遮罩），输入框 32px 高，「取消」+ 写明动作的主按钮；名字最长 80 字 |
| 导入结果清单 | `ImportReviewDialog.tsx`、`.import-review` | 手动导入结束后的逐张确认，外观照确认框规格（`--ui-panel` 底、`--radius-panel`、`--ui-shadow`、`surface-in` 320ms、遮罩同确认框）；标题一个问题，下面两节「已在素材库的其他位置」「可能重复」（有内容才显示），像素相同的只给一行只读说明；每行缩略图加宽×高加选项，默认全部保留，节标题右侧「全部…」快捷；行多时先 100 行，底部「再显示 100 条」；底部「取消」+「按所选处理」 |
| 设置窗口 | `.settings-modal` | 最大 736×560，左栏 176px，内容放在 `.settings-section` 块里 |
| MCP 配置卡片 | `McpClientConfigCard.tsx`、`mcp-config.css` | 连接页里：`--ui-panel` 底加 `--ui-line` 描边、`--radius-panel`；配置代码块 `--ui-inset` 底，右上角复制按钮 |
| 浏览器扩展卡 | `WebCaptureStatusCard.tsx`、`web-capture-status.css` | 连接页里：已连接/没有连接（5 分钟窗口）、扩展版本（落后自带版本给官网链接）、待重试张数加重试按钮、最近一次错误一行；离线空间快满、因空间不足丢过票据、只剩网址时各一行提示；打开时取一次，刷新按钮手动取 |
| 查看器 | `ImageViewer.tsx`、`.viewer-controls` | 底部缩放条，鼠标不动时淡出；「适合窗口」时画面下沿落在缩放条上方。视频用原生控件（禁全屏/下载/画中画，全屏走缩放条按钮），视频上的按下和双击不触发平移和 1:1 切换；图片先显示预览图，放大或适合窗口时需要的像素超过预览图，就在后台加载原图、解码完再替换（适合窗口时停留 200 毫秒后才加载），失败留在预览图。媒体加载出错（原图被挪走、文件损坏）时台面显示空态：32px 图标、「原图找不到了」一句、一个「打开素材位置」按钮（`.viewer-missing`） |
| 空状态 | `.empty-state` | 32px 图标 + 一句话 + 一句提示，文案在 `empty-state.ts` |

浮层的层级：设置窗口遮罩 20，右键菜单 40（子菜单 41），确认框遮罩 45，导入结果清单 50，列数弹层 55，工具栏下拉 60，提示条 100，填写框遮罩 105，拖动中的缩略图 120。

## macOS 窗口

- 三条 56px 顶栏（侧栏标题行、工具栏、详情栏标题）是拖动窗口的区域，里面的按钮、输入框、下拉要排除在外（`-webkit-app-region: no-drag`）。新加的浮层也要排除。
- 侧栏标题行左边给系统的红黄绿按钮留位置，标题靠右对齐到计数那一列。

## 文案

- 界面中文为主，英文一一对应，新文案同时加进 `i18n.ts`。
- 名词只用这一套：素材、素材库、所有素材、待整理、收藏、回收站、智能分组、我的分组、堆叠、提示词、用户指令、版本树、素材详情、参考图、标为已整理。「标为已整理」只在待整理里出现，英文 `Mark as Sorted`。
- 按钮写清会发生什么：「移至回收站」「解散堆叠」「清除筛选」。取消一律「取消」，提交一律「保存」，不用「确定」。
- 确认框标题是一个问题，正文一句后果。提示条写过去式加数字。空状态两句：这里是什么、怎么填满。
- 导入结果的提示条把同一次导入的几件事并成一句过去式加数字：「已导入 2 张，1 张已在素材库中」「1 张已在素材库中，没有导入」；还要检查相似的图就在后面接「· 正在检查相似的图…」。导入结果清单的标题是一个问题（「这 N 张图怎么处理？」），和库里完全相同、已自动移进回收站的那部分只给一行只读说明，不进选项。
- 元数据用「 · 」连接；尺寸写「1024 × 1536」；中文和数字之间留空格；中文用全角标点和「」。不用感叹号和 emoji。
- 产品名只写 GravityPort。
- 更新失败、安装前预检用系统对话框（主进程，文案在 `desktop/notification-i18n.mjs`）：标题说结果，正文先一句原因、再一句下一步；去官网的按钮写「去官网下载」。

## 写新界面时

- 颜色只用 `--ui-*`，间距只用 `--space-*`，圆角只用 `--radius-*`；没有合适的变量时先补变量和本文，再用。
- 不写新的 `.dark` 字面量覆盖：深色值放进 `.app.dark` 的变量里。
- 字号只用 12 / 16 / 20，字重只用 400 / 500 / 600。
- 新浮层照确认框的规格：`--ui-panel` 底、`--radius-panel`、`--ui-shadow`、`surface-in` 动画，并加到上面的层级表里。
- 点遮罩关闭浮层时，只认点在遮罩本身（`event.target === event.currentTarget`）：框里的点击不能冒泡把框关掉，否则点「保存」会先关框、丢掉提交。
- 交付前浅色、深色都看一遍，窗口 1280 和 1440 宽都看一遍。

## 已知的偏差

这些是源码现状，改到相关代码时顺手收掉：

- 工具栏的文字和图标是浅色 `--ui-secondary` 放在 `--ui-work` 上（3.7:1），没到正文的 4.5:1；改它会动整条工具栏的观感，要单独定。
- 深色 `--ui-muted` 放在 `--ui-raised` 上只有 4.4:1，右键菜单的小标题、快捷键提示就是这样；两套主题都要达标，得调深色 `--ui-muted` 本身，会影响全局。
- `index.css` 前面的原型层里被后面覆盖、不生效的字面量，2026-10-30（任务 316）已按级联核实删掉一批（焦点框旧色、设置导航和详情栏被覆盖的字号内边距、外观预览写死色）。还留着的几处是「颜色已死但声明还承担别的」：`.nav-row`/`.toolbar-right select`/`.search` 的 border 简写（颜色被后面的 `border-color` 覆盖，但线宽线型还靠它）、`.settings-nav h2` 和 `.delete-modal h3` 的 `margin: 0 0 …`（margin-bottom 被覆盖，margin-top 仍生效）。读源码时以计算值为准，改到这几处时整体重构。
