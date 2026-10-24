# Changelog

This file records user-visible changes. Internal deployment notes, local paths, and development handoffs are intentionally not tracked in the public repository.

## Unreleased

### License

- Releases after 0.3.5 move from the PolyForm Noncommercial License 1.0.0 to the PolyForm Shield License 1.0.0. Using GravityPort at work and for client projects is now permitted without separate permission. Using GravityPort's code to provide a competing product, including renamed or lightly modified copies, is not permitted, even when offered for free. Copies obtained under earlier terms keep them.

### Desktop & MCP

- Pasting imports now works everywhere in the library: ⌘V (Ctrl+V on Windows) or the blank-area right-click 粘贴 imports files copied in Finder / Explorer (images and videos), images copied in the browser, and screenshots. Pasting inside a group or an open stack files the new assets there; views that cannot show them (favorites, smart groups, search terms, the 图片/视频 filter) say where to look, the Trash refuses with a note, and files that are already in the library are never imported twice. Screenshots and browser copies no longer all arrive as image.png — they are named 粘贴的图片 (Pasted image) with the time to the second.
- Moving the library in Settings no longer risks losing AI-assistant writes: the desktop now marks the library before copying, the built-in MCP server refuses tool calls with a "moving the library" error for the duration (and answers normally again if the move fails), and the copy is aborted and rolled back if the source database changes while it is being copied.
- The local visual search code is removed entirely: the optional Visual Pack download, the local embedding/index runtime, the `/api/visual/*` endpoints, the CLI `visual-model-verify` command, and the `onnxruntime-node` dependency are gone. On startup the app deletes the leftover Visual Pack and visual index data earlier versions kept under its data folder (never the library); MCP `asset_search` keeps answering normally, and clients that still send `visual: true` get lexical results without an error.

### Web Capture

- Extension 0.15.40: Jimeng's full-size originals (`aigc_resize:0:0.png`, e.g. 1440×2560) are now captured. Their URL carries no size, so 0.15.39 treated them as 0-pixel images and silently skipped every new Jimeng generation; the size now comes from the response. Midjourney also treats jobs that render within 8 seconds of the page opening as history, so a page that shows only one or two old jobs no longer auto-captures them.

## 0.3.5 — 2026-10-23 / Preview

### Updates

- The app now keeps itself up to date while it is open: the desktop app checks the release feed a couple of minutes after launch and then every four hours, and downloads a new version in the background. Once the package is verified, a persistent 重启并更新 (Restart to update) button appears at the bottom of the sidebar, one system notification is sent per version, and Settings → 关于 offers the same button; a version you skipped stays staged, so the next launch offers it again without downloading twice. Failed background downloads stay silent and are retried on the next cycle.

### Web Capture

- The browser extension (0.15.39) can now archive generated images and videos from Jimeng (`jimeng.jianying.com`, the generate and conversation pages) and Midjourney (`www.midjourney.com/imagine`). Jimeng media comes from the site's own generation responses, so the full-size signed URLs are captured and downloaded while they are still valid, with the site-shown prompt, model, dimensions and reference thumbnails when the page exposes them; Midjourney captures prefer the full-size PNG downloaded in the extension background over the 640px preview (falling back to the preview, marked as such). On both sites, history that already existed when the extension started is never auto-captured — only newly generated items are — and any item can still be saved with the right-click menu.

## 0.3.4 — 2026-10-23 / Preview

### Windows

- Windows now has an installer: one `.exe` that installs GravityPort for the current user without an administrator prompt (into `%LOCALAPPDATA%\Programs\GravityPort`), adds Start menu and desktop shortcuts and a Settings → Apps entry, and opens the app. The website offers it instead of the portable ZIP. In-app updates keep downloading the update ZIP and replace the installed app in place, and uninstalling keeps the library and settings. The installer is not code-signed yet, so SmartScreen still asks once, when it runs.

### Security

- The desktop app now runs on Electron 43.8.3 (Chromium 150.0.7871.250, Node.js 24.22.0) instead of 43.2.0, picking up the Chromium security fixes released since July; images and videos captured from the web are decoded by this engine.

### Updates

- An in-app update no longer rolls back to the previous version once the new version has started upgrading the library: the previous version cannot open an upgraded library, so the updater keeps the new version (and the parked previous copy) and starts it again if needed. The new version also gets 120 seconds instead of 45 to report that it started, and right after an update the source bridges wait until it has reported, so a macOS folder-permission prompt can no longer hold it past the deadline.
- Update downloads that a finished update has already replaced (staged under the app's data directory, one folder per version) are now removed on the next launch instead of piling up; the download for the version currently running, anything newer, and anything still installing are always kept.

### Interface

- The expanded version tree now opens with a conversation-rounds comparison: pick any two rounds (the previous and the current one by default) to see their images side by side with the dimensions, your instruction, and the prompt, each row marked when it changed. Rounds without captured images are left out, and the block hides when fewer than two rounds have images.
- Settings → 连接 now has a Browser extension (浏览器扩展) card: it shows whether the extension has talked to the app recently (已连接 / 没有连接, with install guidance and a website link when it has not), the version it last captured with — plus a website link when that version is older than the one this app ships — how many captures wait in its retry queue together with a 重试 button, and the last ingest error. A 刷新 button re-reads the status; nothing polls in the background.
- With 显示素材名称 (Show asset names) on, a favorite's heart now sits at the right end of the card's name bar instead of hiding under it; the name stops short of the heart, and a long unbroken name wraps inside the bar instead of running past it.
- The group and stack name dialogs (新建分组并移入, 重命名分组, 合并分组, 删除分组, 重命名堆叠) now look like the confirmation dialogs: the same panel, corners, shadow, backdrop and title size, a 32px input, and 取消 beside a primary action button.
- Context-menu headings, separators and submenus now use the theme colors, so a submenu has the same solid surface and shadow as the menu it opens from, in light and dark mode.
- The count badge on a multi-card drag now uses the primary button colors, keeping its number readable in the light theme.
- The empty Favorites view now says how to add one — click the heart in Asset details, or right-click an asset and choose 收藏 — instead of mentioning a star.
- The browser-tab icon of the web interface is now the GravityPort mark.

### Fixes

- While GravityPort is closed, the browser extension now keeps the captured image itself offline (up to 512 MB in total; past that, the oldest queue tickets drop their bytes first) instead of only a soon-expiring download URL, and a capture that has no bytes yet fetches them once at enqueue time while the URL is freshest. Media whose URL-only ticket is definitively gone (403/404/410) is now given up after 3 retries and reported as an expired URL instead of retrying every minute until the 7-day cleanup. To hold the bytes, the extension (0.15.38) asks for the `unlimitedStorage` permission again.
- Dropping files into the gallery or pasting them while a group view is open now adds the imported assets to that group, matching what the guide promises; before, they always landed ungrouped in 待整理 no matter which view was open. Dropping a file onto a group's name in the sidebar keeps working as before.
- The CLI and library backup errors now tell you to run `gravityport migrate` instead of `mosa migrate` (both commands still work).
- A few leftover messages that could reach you now say GravityPort: the unauthorized-client notice when a write is rejected, the "runtime already active" dialog, and the browser extension's connection error (which now names `GRAVITYPORT_WEB_CAPTURE_ORIGINS`). The MCP tool description for adding an image now states which folders it accepts images from (the Codex generated_images folder and the library's own folders) and that anything else fails with IMAGE_PATH_NOT_READABLE.
- When an AI assistant closes its connection to the MCP server while a write is still in progress, the write now finishes and reports success instead of failing with "database connection is not open"; the server also reports its real version (the app's) instead of a hardcoded 0.2.0.
- The desktop app no longer lets its interface run the spellchecker, so it never downloads spelling dictionaries from Chromium's CDN — the app's only network calls stay the ones the privacy notes describe.
- The visual relationship index is stored at `<userData>/visual-relationship-indexes/<library>/` again instead of one directory deeper; an existing index is moved up on first use.
- Clicking 保存 in the 新建分组并移入 and 重命名堆叠 dialogs now saves: any click inside them used to reach the backdrop and close the dialog before the name was submitted, so only Return worked. Clicking the text of the dissolve-stack and trash-stack confirmations no longer closes them either.

## 0.3.3 — 2026-10-22 / Preview

### MCP

- The desktop app now ships its MCP server, so Claude, Codex, and other AI assistants can search, read, and add to your library without Node.js or a source checkout. Settings → 连接 has a new "AI assistants (MCP) / AI 助手（MCP）" card with ready-to-paste configs for Claude Desktop (JSON), Claude Code (a `claude mcp` command), and Codex (TOML), plus a Copy button. The config runs the app's own executable in Node mode and names the desktop's `library-location.json` instead of a fixed library path, so moving the library in Settings → Storage keeps it working after the assistant restarts; an assistant left running during a move is told to restart instead of touching the old location. On macOS the card asks you to move GravityPort into Applications first when it runs from a temporary location.
- The MCP server accepts a new `GRAVITYPORT_LIBRARY_LOCATION_FILE` variable that follows the desktop's saved library location, and exits with a message on stderr (never a fresh empty library) when the recorded library cannot be found.

### Rename / 更名

- The app now talks only to `gravityport.azhuilab.com`: the update feed (`releases/gravityport/latest.json`, which also carries the anonymous usage signal), update downloads, the feedback service, and the Pinterest authorization relay all moved off `mosa.azhuilab.com`. The old host keeps serving the same paths for installs that have not updated yet.
- The environment switches users set by hand now have GravityPort names: `GRAVITYPORT_DISABLE_TELEMETRY`, `GRAVITYPORT_DISABLE_BRIDGES`, `GRAVITYPORT_LIBRARY_DIR`, `GRAVITYPORT_LIBRARY_LOCATION_FILE`, `GRAVITYPORT_WEB_CAPTURE_TOKEN`, and `GRAVITYPORT_WEB_CAPTURE_ORIGINS`. The earlier `MOSA_*` spellings keep working; when both are set the GravityPort name wins. The MCP configs copied from Settings use the new names. Internal and build-time variables keep their names.

## 0.3.2 — 2026-10-21 / Preview

### Interface / 界面

- Stacks now sort in the gallery by their newest image instead of their cover's date: a stack that gains a fresh capture moves up with it, and trashing that image moves the stack back. Existing stacks are re-sorted the first time the app opens the library.
- The Pinterest entry is back: the sidebar row (marked 暂未开放 until you connect) and Settings → 连接 with the connection card show again. Pinterest's API access is still the trial tier, so browsing stays limited until standard access is approved.

### Fixes / 修复

- Moving cards to the trash no longer takes the newest card with them on the next batch: after a trash move the Inspector falls back to the gallery's first card on its own, and that card used to join the next ⌘-click selection (and answer the Delete key) even while it sat out of sight at the top. A card the app focused by itself now never joins a ⌘-click batch or a Shift-marquee, and never answers Delete; clicking it makes it a normal selection again.

## 0.3.1 — 2026-10-21 / Preview

### Rename / 更名

- The app now calls itself GravityPort everywhere you can see it — menus and notifications (About, Hide, Quit, update reminders, startup failures), the startup screen, library move and Visual Pack dialogs, restart toasts, and every user-facing error the desktop shell shows. Nothing about your data moves with the rename — libraries, settings, the database, and the browser extension pairing all stay exactly where they are — and if you used an earlier version, the first launch shows a one-time "MOSA is now GravityPort / MOSA 现已更名为 GravityPort" notice that never returns after you acknowledge it — this includes users who moved their library in Settings and turned anonymous usage off; brand-new installs never see it.
- User-facing names now say GravityPort: the Web Capture extension (0.15.29) shows it in its extension name, capture panel, toasts, context-menu items, options page, and error messages; the CLI gains a `gravityport` command with `mosa` still working as an alias of the same binary; the MCP server reports itself as GravityPort MCP; and newly exported C2PA content credentials record GravityPort as the claim generator. The app's last MOSA strings are gone too — the expired-session toast, the invalid-desktop-port error, and C2PA export errors now name GravityPort, and group exports download as `gravityport-group-<group>.json`. Storage keys, pairing identifiers, data locations, `MOSA_*` environment variables, and file names are untouched, so renamed extensions keep pairing with older app versions and content credentials exported earlier still read and validate.
- The rename ships from one source tree as two packages, switched by the `MOSA_RELEASE_PRODUCT` build variable (`GravityPort` by default, `MOSA` for the transition build that moves existing users onto the new update feed): it decides the app bundle, executable, package output directories, and update/DMG file names. Both products are otherwise identical — same interface, bundle id, settings location, and download page — and both check for updates (and report anonymous usage) at the new `releases/gravityport/latest.json` feed; the old `/releases/latest.json` path stays frozen for already-shipped versions.
- Documentation now calls the product GravityPort throughout (README, privacy policy, architecture, operations and Chinese guides, GitHub issue templates, and contributor/community documents), with a one-line "previously called MOSA" note under the README and Chinese-guide titles; the operations guide documents the packaging switch with both name sets and uses the `gravityport` CLI name, and the Web Capture store package is built as `GravityPort-Web-Capture-<version>.zip`.
- The source repository moved to `github.com/fengseekling-coder/gravityport` (the website to `gravityport-website`); GitHub redirects the old `mosa` addresses, and README, support, security, and issue-template links point at the new name.
- The app has a new icon: the GravityPort mark on a light tile replaces the previous gradient icon on macOS and Windows.
- New installations start their library in `~/GravityPort Library`; existing libraries keep their current location untouched (`~/MOSA Library` stays in use, and a library you moved via Settings → Storage keeps its saved location).

## 0.3.0-rc.1 — 2026-10-21 / Release Candidate (MOSA transition build)

### Interface / 界面

- The whole app now runs the new GravityPort interface: a single React app served to both the desktop shell and the browser, replacing the previous interface wholesale with a redesigned gallery, image viewer, Inspector, and Settings (常规 / 存储 / 模型 / 连接 / 反馈 / 关于), with a clearer hierarchy and higher information density. This first version also brings the redesign to full parity with the interface it replaced — desktop update checks with in-app download (progress and cancel), import by drag or paste with progress, trash/stack/group actions, generation relations, reference images, group context menus, and group export.
- The accent color is now green: selection and focus rings, switches, and icons follow it — a neon green in dark mode and a darker, readable green in light mode.
- On macOS, the top rows of the window — the brand bar, the toolbar, and the Inspector heading — drag the window; their controls stay clickable, and overlays such as menus and toasts never start a drag.
- Pinterest browsing is built but hidden in this release: the sidebar Pinterest row and Settings → Connections stay out of sight until Pinterest approves standard API access, because its trial access has one daily request allowance shared by every user. The code, the local connection API, and the privacy disclosure stay in place.
- Settings gains a 反馈 page for sending problems and ideas straight to us: you can optionally attach a diagnostic log that is redacted before it leaves the app (home and library paths, tokens, long secrets, and anything mentioning prompts removed), and its full contents are shown for review before sending.
- Local visual search is not offered for now: Settings no longer shows the 模型 page and the Inspector no longer asks for visually related assets, so the app never downloads a model. Groups, automatic stacks, and search cover finding images; the visual runtime and API stay in the code. The background indexer also no longer stops after the first eight images.
- The image viewer gains a 全屏 button (next to 1:1 in the zoom bar): it collapses the sidebar, toolbar, and Inspector so the viewer fills the window and the image grows to fit, while the zoom bar, paging arrows, and toasts stay put; the button turns into 退出全屏 and Esc leaves the fullscreen first, with a second Esc closing the viewer. This is a fullscreen inside the app's window — the window itself, its macOS traffic lights, and the system fullscreen state are untouched.
- Right-clicking a group under 我的分组 opens the same context menu as the gallery: rows aligned with the asset menu and split by separators, ends of the list greying out 上移分组 / 下移分组, the six group colors in a 分组颜色 submenu, and 删除分组 at the bottom in the danger style. It replaces a separate menu that had centered rows and no grouping.

### Gallery & organizing / 画廊与整理

- The gallery can be browsed from the keyboard: the arrow keys move the inspected card to its on-screen neighbour (scrolling it into view), Enter opens it in the viewer or enters a stack card's stack, and ⌘F / Ctrl+F or `/` focuses the search field — the desktop menu's Find (⌘F) now does the same, closing the viewer first when it is open. Arrows and Enter stay off while the viewer, Settings, a menu, or a dialog is open, and while several cards are selected.
- Images generated in the same session (a ChatGPT conversation, Flow project, Google AI Studio chat, Gemini chat, or Codex task) are now stacked automatically: a session's second image creates the stack, later images join it, and an existing stack that already holds images from the session — including a hand-made one — absorbs them instead. Existing libraries are organized once on upgrade; images you remove from a stack, or whose stack you dissolve, are never stacked back automatically, and a stack you named keeps its name.
- Stacks of images captured from one ChatGPT conversation are named automatically after the conversation title, at capture time and — for stacks created before this update — when the old conversation is opened again in the browser. Stacks you named yourself, stacks mixing several conversations, and non-capture stacks are never renamed.
- Assets can now be moved between stacks in one step: the move takes the selected images and a target stack — or none, to un-stack them — and atomically removes them from their current stacks and appends them to the target in order. The original stacks settle exactly as if the images had been removed there (positions compact, the cover reassigns, a stack left with one image dissolves, and moved images are never re-stacked automatically), and any invalid image or missing target aborts the whole batch.
- Cards can now be dragged to organize: drop them on a sidebar group or the 待整理 row to file them, drop one onto another card to build a stack or onto a stack to join it (a 6-second 撤销 toast undoes a mistake), reorder inside a stack by dragging (paused while a search is active), and drag cards out of the app to hand their original files to other programs — a stack card carries all of its members. Esc cancels a drag in progress.
- Marquee selection works again, with room to use it: wider gutters between cards leave room to start a sweep anywhere, a press on the background or an unselected card sweeps a marquee, Shift-drag adds to the current selection, holding the sweep at the grid's top or bottom edge scrolls the gallery, and the browser's native text selection no longer paints cards blue during a drag.
- Selection treats stacks as one card: marquee sweeps, Shift-click ranges, ⌘-click (which counts the inspected card as selected), ⌘A across pages, and multi-card drags all include stack cards. Batch actions follow suit — moving a selection with stacks to the Trash moves every member (one confirmation, one 撤销), adding or removing groups moves whole stacks, and dragging a stack selection out of the app hands over every member's file in order.
- Right-click menus now cover every surface: asset cards offer open, copy (复制图片 / 剪切 / 复制提示词 / 复制路径), organize (收藏, 添加分组 as a submenu led by 新建分组并移入, 移除分组), 导出至, stack actions, and 移至回收站 last, headed by "已选 {count} 项" when several are selected; stack cards offer 打开堆叠, paste-into, group actions, 重命名堆叠, and 解散堆叠, and their Trash move always confirms; blank space in the gallery offers paste, 新建分组, 全选, and refresh; blank space inside a stack offers 返回素材库, paste, rename, dissolve, and 全选; and blank space in the Trash offers 全选 and 清空回收站 only. Favoriting follows the whole selection, taking its cue from the card you clicked, and stack cards keep the old click grammar: one click selects, double click enters.
- A multi-selection's right-click menu now copies too: 复制图片 puts every selected original on the system clipboard as files (up to 512, pasting into Finder, Explorer, chat apps, or web pages as that many files) and 复制路径 copies their library paths one per line; stack cards in the selection expand to all of their members. A stack card's own menu gains 复制全部图片 and 复制全部路径, and the Trash's multi-selection 复制路径 now copies every selected path instead of only the inspected one. The file copy appears only in the desktop app; a single card's 复制图片 still copies the image itself.
- Right-clicking an image or a stack outside the current selection first selects it and moves the Inspector to it, exactly like a left click, while right-clicking a card already in the selection operates on the whole group.
- Wide images no longer punch lasting holes into the gallery: a landscape card can span two or three columns, but it keeps that span only where it leaves no voids behind — otherwise it narrows one step at a time, down to a single column if that fills the gap — so the columns settle evenly.
- The gallery column count is now a toolbar control (列数, from 2 to 8) that is remembered between sessions and defaults to the window width, and card images request a larger thumbnail tier so wider cards stay sharp.
- Returning to the gallery puts you back where you were — from the image viewer, a stack, or another sidebar view — with the card you left focused, and long galleries get a 回到顶部 button while the gallery's own scrollbar is hidden.
- Manual groups are called "groups" everywhere: the sidebar heads them 我的分组, with automatic source groups under 智能分组, and menus say 添加分组 / 新建分组 / 移除分组 — keeping them apart from the asset category field.
- The gallery's empty states speak to the actual situation instead of always claiming "no matching assets": an empty library shows the drag-and-drop import hint, and empty Favorites, Trash (with the 90-day note), 待整理, and manual groups each get their own guidance; only a search or filter miss keeps a 清除筛选 button.
- Sidebar groups gained management tools: the group menu offers 分组统计 — labelled totals plus per-category and per-source breakdowns — and 分组颜色 for color-marking.
- Import has no dialog: bring images in by dragging files or folders into the gallery (they land in the current group or stack; a drop onto a sidebar group imports straight into that group) or by pasting an image. Imports run in batches with a progress toast, dropping a mix of supported and unsupported files reports how many were skipped, and Prompt and other metadata are edited afterwards in the Inspector.
- "Export Group" no longer writes local file paths, local directories, `/library/...` links, or captured web page/media links into the exported JSON, so the file can be shared without revealing your user name or folder structure; your library is not changed.
- Image assets now carry a dominant-color palette: up to 8 colors as hex strings, largest share first, in the asset's `palette` field. New images get it when their thumbnail is generated and existing images get it from their current thumbnail the first time the asset is opened; videos have no palette yet, the palette is not part of search, and the Inspector shows the colors as swatches — clicking one copies its color.
- The old "Card density" setting is gone: cards show the image only by default, and Settings → 常规 has a 显示素材名称 switch that adds each card's name under its image.

### Inspector / 检视器

- The Inspector header now shows a kind · source · date line (for example "图片 · ChatGPT 网页版 · Oct 15, 2026"), the asset's 分组 as a trailing property tag, and honest prompt provenance: a web capture without a prompt says 网页来源未暴露原始生图提示词, and Gemini / Flow / Google AI Studio prompts carry a note that the page-visible prompt is unverified.
- The Prompt section is tighter: the prompt tabs (提示词1 / 提示词2) sit on one line, the prompt and the user instruction show five lines with 展开提示词 / 展开用户指令 appearing only when the text is longer, and the 参考图 section shows only thumbnails resolved from the asset's own history — the copyright and portrait-rights editor is gone.
- The Inspector's version tree is one 版本树 list of the asset's generation records: each row shows the output thumbnail with the prompt, time, provider, and model beside it, and 查看 expands the full relation tree, candidate suggestions, and version history — every block as thumbnail rows, with no raw generation ids anywhere.
- Images captured from one ChatGPT conversation are grouped into conversation rounds in the version tree: three rows around the current one by default (all of them when expanded, the current row highlighted), with a second line like "共 N 轮 · 当前第 n 轮"; assets outside a conversation keep the time · provider · model line.
- Inspector tags render as bare text instead of chips: the vendor name always comes first and cannot be removed, internal system tags (web-capture, auto-archived, and friends) are hidden from view but stay stored, a tag's remove × appears on hover or keyboard focus, and the collapsed row folds to two lines with +N and 添加标签.
- The 比例 tag names common aspect ratios — 9:16, 16:9, 2:3, 21:9 and their friends, width first, within 1% — instead of only the normalized decimal form (sizes matching none stay numeric).
- The open Inspector follows changes made elsewhere — another window, the MCP server, or the CLI: favorites, tags, and other metadata arrive with the background sync instead of leaving the Inspector stale until another asset is selected.

### Trash / 回收站

- Delete / ⌫ on a selection now goes through the same path as the 移至回收站 menu item, so 不再提醒 skips the confirmation there too instead of being ignored by the keyboard.
- The Trash gets dedicated handling: a context menu on cards (恢复 / 永久删除) and on blank ground (全选 / 清空回收站), a 清空回收站 toolbar button whenever there is something to clear, and a "{count} 天后删除" badge on every trashed card for the 90-day retention. Moving images to the Trash now shows a toast with a 6-second 撤销 that restores exactly the rows the server actually moved — on a partial failure, the moved ones can still be undone.
- Moving images to the Trash still asks first: the confirmation says "是否移至回收站？" with the 90-day note and 取消 / 移至回收站 buttons, and an optional "不再提醒" checkbox skips future confirmations for plain moves (moving a whole stack always confirms, and so do 永久删除 and 清空回收站).

### Search / 搜索

- Library search now only matches what you can actually see and would search for: file name, id, prompt, tags, group, category, style, theme, skill, curation note, the user instruction and request prompt, the provider/model name — plus a readable source name (ChatGPT, Gemini, Flow, Google AI Studio, Codex, Grok, Cowart) you can search by. Internal details an image carries along — original file paths, content hashes, capture channels, page URLs, mime types, dimensions, file sizes, timestamps, status strings — no longer match, and neither does the machine-generated part of ids and file names (import timestamp-and-random suffixes, hashes, collision randoms, UUIDs): searching "copy", "png", "observed", a folder name, or a few characters of a random suffix no longer floods the gallery, while pasting a whole id or file name copied from the Inspector still finds exactly that asset. Existing libraries re-index once on the first open after updating.
- Searching the library now lists every matching image on its own instead of grouping matches into stacks; clearing the search brings stacks back.

### Web Capture extension / 网页采集扩展

- The extension (0.15.37) no longer asks for the `unlimitedStorage` permission, and the development-only capture diagnostics recorder that existed in some development builds is gone. Capture behavior is unchanged.
- With auto capture off, the extension (0.15.36) no longer reports the open ChatGPT conversation's title on its own; switching auto capture on reports it once. Manually saved images still carry the title.
- Images made by chatting in the ChatGPT desktop app (which now also hosts Codex) are captured automatically: the desktop app keeps no chat images on disk, so GravityPort notices which conversation you just used and the Web Capture extension (0.15.35, auto capture on) checks it with your browser's own ChatGPT session and, unless it can tell the conversation holds no generated image, opens it in a minimized background window, captures it like any ChatGPT page, and closes the window. As with reopened browser conversations, the image and your message are kept; ChatGPT's own image caption is only available while generating in the browser.
- The extension keeps following ChatGPT's changing conversation data (0.15.26–0.15.27): the new flat, already-ordered message list with paging is parsed (turn numbers are only reported when a single read contains the complete conversation — a wrong turn number is worse than none; page stitching is future work), and internal steps the page hides no longer make it discard the whole read, while a parent placed after its child still does. Parsing of the older branch-tree format is unchanged.
- While you have a ChatGPT conversation open, the extension reads the structure of the conversation data the page itself loaded and reports which generated image file belongs to which message and turn (message numbers, turn numbers, and file ids only — never conversation text), through an authenticated capture entry that only the paired extension can use (0.15.25). Generation records captured without their ChatGPT message number are completed automatically when an existing library is opened — each blank record inherits the message id its image already stored, same conversation only — and turn numbers follow the conversation as of the most recent read, so edits or deletions inside ChatGPT are reflected on the next sync instead of keeping stale numbers forever. Edited-away branches, uploaded images, and images the model merely referenced are not reported, and a batch over 2000 entries is dropped whole rather than truncated.
- ChatGPT replies pushed through the streaming conversation request (for example GPT-5.6 Thinking image turns) are parsed while the stream arrives, so the generation bindings for new images survive the page aborting the request after `data: [DONE]`.
- ChatGPT image-to-image turns archive their uploaded reference images again (0.15.23): the user turn is split into an attachment unit and a text unit, reference lookup merges every user unit of the same message, and the assistant's generated gallery stays excluded.
- When one turn generates several images (0.15.20) — ChatGPT shows them as a gallery of `blob:` images sharing one message — each image is now bound to its own ChatGPT file and caption (the per-image request prompt stays empty for batched requests, because nothing in the page reliably ties an image to its request), and gallery images the user never clicked are archived too, reading a proven `blob:` straight from the page-local bytes so the large view and its thumbnail still archive once each.
- The ChatGPT page hook now talks to the extension over a private MessagePort instead of a channel name exposed in the DOM, and content scripts only receive the settings they need (0.15.22).
- Google Flow's migration to its dedicated `flow.google.com` domain is followed (0.15.5): the provider adapter runs on both the legacy `labs.google/fx` routes and the new host, the relocated media endpoint is accepted, failed media probes now back off per media item instead of re-fetching on every scan, and grid-tile Prompt association uses a thumbnail size floor so small tiles keep their visible Prompt card.
- Captured prompts and user instructions survive re-observation. Reopening a ChatGPT conversation no longer blanks the prompt and model of generation records that were already captured with them, and re-observing an already archived image no longer replaces its user instruction with a message from another turn, appends a blank generation record, or overwrites what the live capture stored (prompt, model, user instruction, provider ids, references, and their statuses) — only values that are actually present are accepted. On the first open after updating, earlier damage is repaired where it is still recoverable: user instructions that earlier captures overwrote are restored from the image's first saved prompt, the duplicate blank generation records from those repeated captures are removed, and prompts blanked by the old re-observation bug come back from the image's stored model caption when the record is the image's only history entry (images with a duplicate blank record next to an intact one are left alone, and the model name is not recoverable and stays blank).

### Desktop & updates / 桌面与更新

- Settings → About now says what changed: it lists the current version's release notes (on development builds, what is recorded for the next version so far), and when an update is available it adds a "What's new in {version}" block from the update feed above it. `release-notes.json` at the repository root is now the single source of these release notes, and release builds fail when the version being built has no entry.
- Internal updater groundwork for the rename and the signed release channel, with no user-visible changes yet: the macOS updater can replace the running app under a new name (`MOSA.app` → `GravityPort.app`, refusing to overwrite an app already present at the target location and moving the previous app to the Trash only after the new one reports ready, with automatic rollback), release manifests can declare the macOS app name and a production `teamIdentifier`, and Preview installs may now auto-update into a signed Production release (the reverse stays blocked). When the app runs from a Gatekeeper translocation path or a directory it cannot write to, update checks stop safely and ask you to move the app into Applications first.
- Windows updater groundwork matching the macOS rename support, with no user-visible changes yet: release manifests can declare the Windows payload executable name (`MOSA.exe` by default or `GravityPort.exe`, bound to the matching package filename) and, for Production, the signer thumbprint the installer verifies every payload signature against. The updater installs under whichever of the two names is already running — an update whose payload ships the other name is renamed into the installed name before anything moves — and a Production payload whose publisher subject differs from a signed installed release is refused, while certificate renewals (same publisher, new thumbprint) and unsigned Preview installs keep updating.
- The desktop app now creates a fixed, anonymous installation ID on every installation and provides it to the user interface.
- GravityPort on macOS now removes leftover `.MOSA-update-*` folders from failed in-place updates once they are more than 10 minutes old, as it already did on Windows.
- The desktop package now carries the full license texts of the third-party code it ships, in a `licenses` folder inside the app (`GravityPort.app/Contents/Resources/licenses/`, Windows `resources\licenses\`): Electron's and Chromium's licenses, the GNU LGPL and GPL texts for libvips, and a generated `THIRD_PARTY_LICENSES.txt` covering every npm package in the interface bundle and the desktop runtime plus each library packaged with libvips. Previously the DMG and update ZIP had none of them; packaging now stops if a shipped package has no license text.

### Fixes / 修复

- Right-clicking a stack card that is part of a multi-selection now opens the batch menu ("已选 {count} 项"), so 移至回收站 and the group actions take the whole selection; before, the stack card's own menu acted on that stack alone and left the other selected images behind. A selection containing a stack now always confirms before moving to the Trash, even with 不再提醒 on — that setting only skips plain moves, as documented.
- When the live event stream drops and reconnects, the app now refreshes once automatically, so changes made while the stream was down appear without a manual refresh.
- A background library refresh no longer cancels a select-all in progress: selecting across pages now completes even while thumbnails are still being generated and library events keep arriving.
- Dragging a library file out of the app and dropping it back — or dropping it in from the Finder — no longer imports a duplicate: files that already belong to the library are recognized and skipped, and when everything dropped was already in the library a toast says so ("{count} 个文件已在素材库中，没有重复导入").
- When the recorded library location is broken, or the library it points to can't be found, the app now shows an error and stops instead of silently falling back to a default and creating an empty library.
- Changing the library location now refuses the current folder, a folder inside it (or containing it, including case-only path differences), and any non-empty destination before copying anything, so a relocation can no longer copy a library into itself or delete it afterwards.
- With an MCP server or CLI writing to the same library at the same time, the first app launch after upgrading no longer occasionally fails to open: the one-time upgrade steps tolerate the concurrent writer and, if one still cannot run, are skipped with a log line and retried on the next open.
- Thumbnails, medium images, and previews are now written atomically: if the app quits, crashes, or loses power while generating them, the gallery keeps the previous complete image instead of showing a half-written one.
- Video assets no longer show a broken image in the gallery, the Inspector, the version tree, or the drag preview: videos have no generated thumbnail, so these spots now draw an early frame of the video itself, and gallery cards and the Inspector preview carry a play chip.
- A few images no longer show a wrong thumbnail ratio or a blank large view: images imported by older versions without recorded dimensions get them filled in when the app starts (thumbnail and preview are regenerated too, and a metadata write that names only some fields — a PATCH, an MCP call — no longer drops the recorded dimensions it did not mention), and the image viewer falls back to the loaded image's own dimensions when none are recorded, so it displays at the right size instead of collapsing to a point.
- The ChatGPT user instruction no longer ends or starts with the label of the tool the message was sent with (the "创建图像" / "Create image" chip line); the same words typed inside the message are kept.
- Images generated by newer Codex versions record the prompt Codex actually sent to image generation again, instead of falling back to your chat message with Codex's pasted-file list in front of it; images already captured that way are corrected the next time the app reads the Codex session.
- Fixed tags missing from assets loaded through the gallery list: the Inspector showed no tags, and adding a tag there could erase the asset's existing tags.

## 0.2.1-rc.34 — 2026-09-24 / Release Candidate

- The Windows update helper now exits explicitly after a successful update.
- Settings no longer re-renders on bursts of background Visual Pack status updates; status changes are collected into one short debounce, and opening Settings always shows fresh status.
- The SQLite library and the visual relationship index checkpoint their write-ahead log before closing, so an in-place desktop update no longer leaves a stale `-wal` file behind.

## 0.2.1-rc.33 — 2026-09-23 / Release Candidate

- MOSA Desktop now pairs the fixed allowlisted MOSA browser extensions automatically in the background. Installing/opening the app and loading the official extension no longer requires a native pairing confirmation dialog or manual Token entry; source/headless runtimes remain opt-in.
- Desktop runtime handoff during startup and updates, gallery resizing, and gallery multi-selection are more robust.
- The Windows updater keeps retrying while files stay locked for longer and hands its console off cleanly.

## 0.2.1-rc.32 — 2026-09-22 / Release Candidate

- Version-only release used to validate the Windows in-app update path from rc.31.

## 0.2.1-rc.31 — 2026-09-22 / Release Candidate

- The Windows updater retries file moves that fail briefly, for example while antivirus or indexing software still holds a file.

## 0.2.1-rc.30 — 2026-09-21 / Release Candidate

- Fixed Windows update ZIP generation on native Windows builders.

## 0.2.1-rc.29 — 2026-09-21 / Release Candidate

- The Windows update helper runs without a visible console window.

## 0.2.1-rc.28 — 2026-09-21 / Release Candidate

- Version-only release used to validate the Windows in-app update path from rc.27.

## 0.2.1-rc.27 — 2026-09-21 / Release Candidate

- Windows in-app updates are more reliable: the portable ZIP keeps its root folder, older flat payloads are still accepted, the updater is started fully detached from the app, and startup/readiness checks stay fail-closed.

## 0.2.1-rc.26 — 2026-09-20 / Release Candidate

- A whole stack can be moved into or out of a manual group.
- The Inspector can be reopened from a top-bar button after it has been closed.
- Removed the top-bar Import button; import by dragging files into the gallery.
- The Windows updater waits for its helper to confirm the handoff before replacing the app.

## 0.2.1-rc.25 — 2026-09-20 / Release Candidate

### Release integrity / 发布完整性

- Split desktop publishing into explicit Preview and Production tracks. Preview/RC keeps immutable Git provenance, signed release manifests, artifact hashes, exact build identity, and updater rollback without requiring Apple Developer or Windows Authenticode credentials; Production adds those platform trust chains as a deliberate stronger gate.
- Release builds now fail closed unless their source commit is clean, tagged, remotely reachable, and the exact release tag has been pushed. Build identity is carried into the release manifest and verified again after an in-place update reports readiness.
- `releases/latest.json` is now signed with a release-only Ed25519 key whose public key is pinned into the packaged build. Desktop updates and Visual Pack discovery verify that signature before trusting artifact hashes or model-pack metadata, separating release trust from the website/CDN that serves the files.
- macOS Production packaging rejects ad-hoc/non-hardened/wrong-team bundles, requires notarization and Gatekeeper acceptance, and Production in-place updates check the replacement against the installed Developer ID team plus Gatekeeper before replacement.
- Windows Production packaging has an explicit Authenticode path. Production verification pins the expected signer, and Production in-place updates require every executable/native payload (`.exe`, `.dll`, `.node`) to have a valid signature from the installed publisher before the application directory is replaced.
- SQLite schema upgrades create a verified pre-upgrade snapshot before the first mutation and run integrity plus foreign-key verification after migration, retaining the snapshot path in any upgrade failure for deterministic recovery.
- Removed the retired Inspector curation/reuse-context UI strings and the now-unreferenced context-package implementation instead of leaving hidden product surfaces behind.

### Local visual search / 本地视觉搜索

- Wired the first real MOSA-local image-text embedding runtime: a verified SigLIP2 Base int8 visual pack now powers `/api/visual/search`, image-to-image similarity, and near-duplicate/version/Stack candidates through a dedicated fail-closed inference worker process. No Ollama, Python, or network access is required at inference time.
- Moved ONNX Runtime and the tokenizer runtime out of the core desktop bundle and into the optional, platform-specific Visual Pack. The macOS arm64 pack remains below the 512 MiB gate while `MOSA.app` actively rejects accidental rebundling of those visual-only dependencies.
- Added an optional packaged visual smoke that proves the built `MOSA.app` can load the external verified pack, start its real ONNX worker, build embeddings, run text-to-image search, and return image-to-image neighbors.
- Settings can now install, update, cancel, and remove the optional Visual Pack without exposing model paths or download URLs to the renderer. Downloads come only from MOSA's fixed first-party origin, are staged with disk-space checks, pin the pack manifest from the release feed, verify every file by size and SHA-256, preserve the previous revision on failure, and restart MOSA only after a verified install/removal.
- Fixed the macOS Desktop/Web Capture KeepAlive races around startup and in-place self-update. Normal Desktop startup publishes a short-lived PID/start-identity handoff marker before runtime startup. During self-update, the detached helper takes ownership of that same backward-compatible marker before the old Desktop releases port 43517 and keeps it through replacement/readiness, so an already-loaded supervisor cannot reclaim the production runtime during the gap. The supervisor stands down before spawning or gracefully yields an already-running child, while stale markers and PID reuse fail open to normal background recovery.
- Added macOS in-app self-update support. Packaged MOSA can consume a version-bound arm64 ZIP from the existing first-party release manifest, download it to private userData staging with exact size/SHA-256 verification, stop its owned runtime, replace `MOSA.app` through a detached helper, relaunch the new build, require renderer/runtime readiness, and roll back automatically if replacement or relaunch fails. The release build now emits the matching update ZIP plus manifest metadata alongside the DMG.
- Added a canonical desktop release-manifest writer for release automation. It emits the same `platforms.*` schema consumed by Desktop, hashes real artifacts, refuses mixed-version macOS/Windows entries, removes legacy `artifacts.*`, preserves `visualPacks`, and validates the result with the production update parser before publishing.
- Settings now measures real runtime availability instead of reporting a placeholder: states are `not-installed`, `disabled`, `loading`, `ready`, `runtime-unavailable`, and `error`.
- Background embedding indexes assets incrementally with content-hash staleness detection; deleted assets are pruned from the derived index and a crash of the inference worker degrades to explicit unavailability rather than wrong results.

### Search & Stack reliability / 搜索与堆叠稳定性

- Custom Stack names are now searchable from the collapsed gallery while raw asset and Stack-interior searches keep their existing member-level semantics.
- Whole-Stack Trash operations now preserve and reconcile confirmed progress when a later batch request is interrupted; outcomes without a response are reported as unresolved instead of being mislabeled as failures or retried blindly.
- Local context-menu refresh events are scoped to the project that was mutated so a long-running operation cannot reconcile its result into a different project after navigation.

### Performance / 性能

- Added an indexed short-Unicode candidate table for one- and two-character non-ASCII search terms, with schema backfill and write-path synchronization, avoiding full-library `LIKE` scans for common short CJK queries.
- Collapsed gallery paging now uses a dedicated no-filter fast path and Stack annotations aggregate only the Stacks relevant to returned rows instead of scanning every active Stack member.
- The 50k performance gate now separately covers cold search, short CJK search, and a mixed library with 2,000 five-member Stacks.

### Web Capture activity / 网页收录状态

- Settings now shows the browser extension's bounded pending/retrying queue summary together with recent Runtime ingest outcomes and Prompt-availability status.
- The extension reports only redacted queue diagnostics to the authenticated loopback Runtime; raw Prompt text, page/media URLs, and media bytes are excluded from this status channel.
- A Settings retry action requests the extension to drain its existing durable queue; MOSA does not create a second delivery queue or blindly duplicate failed captures.

### Library backup & restore / 素材库备份与恢复

- Added explicit CLI backup, backup verification, and restore commands for completed SQLite libraries. A backup includes the SQLite snapshot, managed originals/derivatives, reference attachments, and the migration-completion marker.
- Backups are published only after MOSA integrity checks pass and a SHA-256 manifest has been written; verification detects missing or modified files before restore.
- Restore requires an explicit empty destination and rebases managed absolute paths into that destination before running the normal library verifier. Large media hashes are streamed instead of loaded into memory as one buffer.

### Gallery import & navigation / 图库导入与导航

- Dropped or picked assets now import into the currently active stack instead of landing as ungrouped library items.
- Removed the sidebar saved-filter presets. Existing project-local filter names are no longer restored into the gallery.
- Sidebar navigation now clears hidden facets, so switching primary view, source, or group does not keep leftover hidden filters.

### Inspector / 检视器
- Inspector version history now includes a two-version comparison view for stored media and persisted Prompt/style/theme/ratio/group/category/tag/change-summary fields. It compares existing records only and does not infer missing generation facts.

### Retrieval foundation / 检索基础
- Added a reproducible retrieval acceptance baseline with enforced lexical cases plus diagnostic conversational, semantic, cross-language, and visual-content probes. This makes the case for any future embedding layer measurable instead of assuming that a model is required.
- Added conservative Chinese conversational query planning: recognizable phrases such as “找一下之前做过的…” are reduced to design terms that actually exist in the local short-term index before entering the existing strict search path. The acceptance set now guards these supported conversational queries while leaving semantic and visual probes diagnostic.
- Added an audited design-vocabulary normalization layer for multi-signal paraphrases and cross-language designer terminology. On the current synthetic acceptance probes it closes the measured text-semantic gap without adding a model runtime; visual-content probes remain intentionally unsolved and separate.
- Expanded visual-retrieval diagnostics to use real generated pixel fixtures with composition facts withheld from searchable metadata, so future image-model experiments cannot accidentally pass by reading Prompt text.
- Added a model-candidate gate for local visual retrieval covering product-use licensing, optional model-pack footprint, memory, cold start, query/index latency, exact vector-search latency, and pixel-grounded retrieval quality. Also added a 50k × 512 exact-vector benchmark so an ANN dependency is introduced only if measured scale requires it.
- Added an offline visual-model-pack manifest/verifier and CLI command. Packs pin embedding dimension, preprocessing metadata, license/product-use declaration, byte sizes, and SHA-256 for every file; verification rejects traversal, symlinks, tampering, and oversized packs before any runtime integration.
- Added the model-neutral visual relationship engine foundation: a versioned userData-side embedding index, exact image-neighbor lookup, stable visual API contracts, safe derived-index cleanup, and advisory near-duplicate/version/Stack candidate classification. No candidate mutates library organization or provenance automatically.
- Added the model-neutral background embedding worker contract with incremental current/stale checks, pause/resume/stop behavior, per-asset failure isolation, and stale-vector pruning so a future local model can backfill the library without blocking normal MOSA use.
- Added a validated image/text embedding-provider boundary and text-to-image visual search API. Provider model id/revision/dimension must match the indexed vector space exactly, startup is lazy, runtime shutdown closes the provider, and MOSA can now expose visual text search without coupling product APIs to a specific model runtime.
- Made MOSA-local the explicit desktop visual-model path: Electron now discovers and verifies optional model packs under userData, persists local enablement/selection, and exposes a Settings status surface without an Ollama dependency. Installed-model and compatible-runtime readiness remain separate so unsupported builds fail closed.

## 0.2.1-rc.14 — 2026-09-16 / Release Candidate

### Drag & drop import / 拖放导入

- Dropping files and whole folders onto the gallery or the import card now imports every supported image/video in one batched queue, with progress in the gallery status line and per-batch failure isolation instead of "first file only".
- Unsupported files inside dropped folders are skipped and reported as an informational count; a folder full of non-media files no longer exhausts the import budget.
- The file picker accepts multi-selection; single files keep opening the familiar import flow.
- Holding a card drag and leaving the MOSA window hands the selected assets to the OS as a native file drag (Electron desktop), so assets can be dropped into Finder, browsers, and other apps.

### Security & privacy / 安全与隐私

- Web Capture pairing now requires an explicit native confirmation dialog in front of the user; headless CLI runtimes deny pairing by default (`MOSA_WEB_CAPTURE_PAIR=auto` opts in for automation).
- The CLI server no longer prints the management token into redirected output logs; interactive terminals keep the URL handoff.
- Anonymous usage telemetry can be disabled locally with `MOSA_DISABLE_TELEMETRY=1`.
- Web capture upload sessions are bounded (8 concurrent) to cap temp disk usage.

### Reliability / 稳定性

- The JSON fallback store now serializes every per-asset metadata/lifecycle write through one lock, closing a race where a metadata edit could resurrect an asset that was just moved to the Trash.
- Group hard-delete and asset creation now stage file removals/copies so interrupted operations roll back or clean up instead of leaving half-deleted or half-written files.
- Windows update apply keeps the previous installation parked for recovery until the updated app's next boot sweeps it, and the rollback deletion is explicitly scoped to the replacement payload.
- `npm run check` now also syntax-checks `.cjs` sources (the desktop preload was previously outside its coverage).

## 0.2.1-rc.13 — 2026-09-13 / Release Candidate

### Codex default source alignment / Codex 默认来源对齐

- MOSA now treats Codex's own `CODEX_HOME` as the single default root for Codex-owned local data. When `CODEX_HOME` is unset, the default remains `$HOME/.codex` on macOS/Linux and `%USERPROFILE%\.codex` on Windows.
- Automatic Codex image archive reads `generated_images` under that root, while Prompt/model/provenance matching reads `sessions` under the same root. Cowart's MOSA canvas and registry defaults are rebased from that same Codex root as well.
- Codex automatic archive now treats `generated_images` and `sessions` as two coordinated sources: standard generated files remain primary, while inline `image_generation_call` / `image_generation_end` results can recover an image when Codex did not persist the advertised generated file.
- Session JSONL processing was redesigned as an incremental byte-indexed reader. After the initial scan, an active runtime reads only newly appended complete records instead of reparsing whole session files on every bridge reconciliation.
- Inline session images are size-limited, base64-validated, binary-signature checked, staged only inside MOSA's private recovery directory, copied into the library, and then removed. Session `saved_path` values do not widen MOSA's filesystem trust boundary.
- Removed the MOSA-invented Windows `Documents\\codex` default and project-directory image scanning path. Custom source variables remain explicit overrides, but they no longer redefine Codex's defaults implicitly.
- Runtime startup resolves the Codex/Cowart source locations once and passes the same paths to every integration, preventing image, session, and Cowart components from drifting onto different roots.
- Codex automatic archive now reconciles two native sources: files under `<CODEX_HOME>/generated_images` and image-generation events appended to `<CODEX_HOME>/sessions`, so result-only generations can still be recovered when Codex does not persist the image file.
- Session JSONL processing is incremental by byte offset, merges duplicate call/end surfaces by generation identity, carries incomplete records across scans, and bounds inline-result recovery without rescanning whole sessions on every poll.
- Recovered session results are validated into a MOSA-private temporary area, copied into the library, then removed; they are never treated as external trusted roots or later hard-linked back to Codex session data.

## 0.2.1-rc.12 — 2026-09-12 / Release Candidate

### Startup critical-path redesign / 启动关键路径重构

- Shows a lightweight MOSA shell immediately while local runtime ownership and SQLite startup continue in parallel.
- Moves Codex, Grok, Cowart, and Cowart discovery scans off the runtime readiness path and isolates integration startup failures from the core library.
- Probes local runtime discovery ports concurrently while preserving primary-port fail-closed ownership rules.
- Runs independent first-view renderer requests in parallel so the gallery is no longer serialized behind project/version reads.

## 0.2.1-rc.11 — 2026-09-11 / Release Candidate

### Live drag preview / 实时拖拽预览

- Replaced the invisible single-asset drag state with a lightweight thumbnail preview that follows the pointer in real time.
- Added a short lift-in animation and a compact count badge for multi-selection drags without delaying pointer tracking or changing Stack/group drop semantics.

## 0.2.1-rc.10 — 2026-09-11 / Release Candidate

### Drag feedback cleanup / 拖拽反馈清理

- Removed the empty floating drag ghost for single-asset Stack and group drags.
- Reduced multi-selection drag feedback to a compact count badge while keeping drop-target highlighting and Stack/group behavior unchanged.

## 0.2.1-rc.9 — 2026-09-11 / Release Candidate

### Stack drag authentication validation / 堆叠拖拽鉴权验收

- Rebuilt the macOS application from the post-PR #78 `main` baseline so the installed desktop bundle and its local runtime include the authenticated drag-to-stack recovery shipped in `cbd4516`.
- Preserved the browser-session capability and runtime-supervision fixes while giving the corrected build a distinct release-candidate version for reliable rollback and field diagnosis.

## 0.2.1-rc.8 — 2026-09-11 / Release Candidate

### Desktop runtime ownership and drag workflow recovery / 桌面运行时接管与拖拽工作流恢复

- Hardened macOS background-runtime supervision so the desktop app can safely take ownership of the correct local MOSA runtime without leaving stale process state behind.
- Restored authenticated drag-to-stack creation and drag-into-existing-stack workflows while preserving the local runtime capability boundary.
- Added a first-party HttpOnly browser-session capability for direct loopback Web UI launches so state-changing actions no longer fail with `Unauthorized MOSA client.` when the page is opened without a fragment token.
- Fixed drag-to-group target lifetime so dropping assets onto manual groups or Unorganized continues to work after drag visual state is cleared.
- Expanded end-to-end regression coverage to exercise direct drag Stack creation from a bare local URL, Stack reordering, and browser mutation authentication.

## 0.2.1-rc.7 — 2026-09-11 / Release Candidate

### Runtime integrity, group workflows, and release validation / 运行时完整性、分组工作流与发布验证

- Hardened local runtime integrity with authenticated state-changing API requests, PID-reuse-safe runtime ownership, transactional metadata and generation-lineage updates, stricter Trash path boundaries, and isolated derivative processing so native image decoder failures cannot take down the main MOSA runtime.
- Strengthened Web Capture and gallery synchronization under concurrency, including serialized chunk uploads, safer ingest-slot handoff, revision-aware reconciliation, and protection against stale refreshes overwriting newly appended gallery pages.
- Expanded manual group management with drag-to-group, batch move/remove, persistent ordering and colors, group merge, group statistics, normalized case-insensitive naming, and safer version-family moves.
- Aligned source, Electron, E2E, and packaged-app validation with the runtime client-capability model across macOS and Windows, including authenticated packaged smoke coverage.
- Added a durable third-party notice crediting APSAL Open `v0.14.0` as a design influence on MOSA's recipe snapshot model, while explicitly separating that attribution from MOSA's own PolyForm Noncommercial licensing.

## 0.2.1-rc.6 — 2026-09-10 / Release Candidate

### Gallery stability and dependency hardening / 图库稳定性与依赖加固

- Stabilized infinite-scroll pagination so adding the next gallery page no longer temporarily collapses the virtual scroll extent and nudges the viewport.
- Hydrates all currently visible virtual gallery cards in the same paint cycle while keeping background hydration bounded, eliminating the visible placeholder-to-card ripple during fast paging.
- Hardened gallery interaction and navigation race handling, including incremental Masonry corrections that preserve stable per-column placement rather than globally rebalancing loaded cards.
- Updated Sharp to the release carrying the current libheif security fixes used by MOSA's packaged image pipeline.

## 0.2.1-rc.5 — 2026-09-08 / Release Candidate

### Desktop distribution, large-library navigation, and synchronization / 桌面分发、大图库导航与同步

- Added the first-party desktop release manifest and update-check flow. Packaged Windows builds can download the matching portable ZIP in-app, verify its size and SHA-256 digest, replace the application directory through a detached helper, and roll back on replacement failure.
- Added a macOS DMG distribution path with drag-to-Applications replacement behavior while keeping release-grade Developer ID signing and notarization fail-closed behind `desktop:release`.
- Added Stack Inspector behavior, windowed gallery navigation, large-gallery virtualization, and safer selection/navigation handling so loaded pages and scroll state survive common library transitions.
- Reworked library synchronization around revision-aware incremental change reconciliation instead of routinely reloading the entire loaded gallery window after one asset changes.
- Hardened desktop runtime ownership and stale-runtime handoff, Web Capture delivery/retry behavior, capture lookup performance, Windows packaging/runtime paths, file reveal on spaced Windows paths, and Inspector/context-submenu rendering.
- Aligned packaged anonymous install/activity reporting across website, GitHub, and directly shared packages while keeping development and QA launches excluded.

## 0.2.1-rc.4 — 2026-09-02 / Release Candidate

### Library organization and desktop branding / 素材整理与桌面品牌

- Added an **Unorganized / 未整理** library view. It shows assets that are neither in a manual group nor part of a Stack, so the items that still need curation have a dedicated place.
- Refined sidebar navigation so selecting a primary view, source, or manual group establishes one clear library context while other filters can still refine it.
- macOS and Windows desktop packages now use the MOSA app icon instead of Electron’s default icon.
- Build identity is generated only inside each package, preventing an outdated tracked identity file from being included in a new build.

## 0.2.1-rc.3 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A packaged desktop upgrade now waits for a KeepAlive-managed local MOSA service to finish restarting and report the exact new build identity, then opens directly instead of requiring a second manual launch.
- The handoff continues to fail closed if a different, same-version, newer, unverified, QA, development, or explicit-port runtime is encountered.

## 0.2.1-rc.2 — 2026-09-02 / Release Candidate

### Desktop upgrade reliability / 桌面升级可靠性

- A newer packaged MOSA build can now take over a verified, strictly older local runtime for the same library, then reconnect only after the replacement reports the new build identity.
- Development, QA, explicit-port, same-version, newer-version, and unverified local runtimes remain fail-closed and are never stopped automatically.
- Startup errors no longer expose internal build fingerprints or Git identifiers to users.

## 0.2.1-rc.1 — 2026-09-02 / Release Candidate

### Reliability and privacy / 可靠性与隐私

- Packaged desktop builds now report the same minimal anonymous install/activity UUID regardless of whether the app package came from the MOSA website, GitHub, or a directly shared copy.
- Anonymous usage reporting is independent from update-manifest parsing, retries with the same installation UUID after transient failures, and persists the local UUID/profile atomically.
- Development and QA launches remain excluded from production usage metrics.

## 0.2.0 — 2026-08-28

> **Local visual memory for AI creation.**
> 把 Codex、ChatGPT、Grok 与 Cowart 中的创作结果，连同可用的 Prompt、来源和版本，留在自己的电脑上。

### New / 新增

- **More creation sources, one local library.** Add optional Web Capture for ChatGPT, Gemini, Flow, and Google AI Studio; local Grok Build CLI image and video archiving; and safer project-local Cowart canvas discovery alongside Codex image collection.
- **A library built for reuse.** Add verified JSON-to-SQLite migration, FTS5 search, stable pagination, WebP previews and thumbnails, tags, favorites, and provenance while preserving originals.
- **Version history that keeps the why.** Add asset-based recipe version trees, REST and MCP version APIs, and bilingual UI flows for browsing versions and creating the next one.

### Removed / 移除

- Removed controlled insertion from MOSA into Cowart canvases to focus this release on asset collection, archiving, and version management. Cowart canvas archiving (collecting snapshots into the library) is unchanged.

### Web image capture

- Added an optional Chrome extension that captures ChatGPT-generated images with message-scoped Prompt and provenance data.
- Added a loopback-only ingest endpoint and bridge status endpoint. Web capture is disabled until `MOSA_WEB_CAPTURE_TOKEN` is explicitly configured.
- Added image-byte, MIME, size, pixel-count, origin, and request-envelope validation for browser-extension ingestion.
- Stores the extension address, Token, and auto-capture preference in Chrome local storage rather than synchronized storage.
- Hardened extension reload handling so startup context loss is reported reliably and temporary settings failures cannot re-enable auto-capture or overwrite the saved preference.
- Added Gemini, Flow, and Google AI Studio page support to the optional Chrome extension. These sites capture only user-visible generated images and page provenance; they do not inspect session APIs, credentials, or hidden prompts.

### Reliability and privacy / 可靠性与隐私

- Web Capture is loopback-only and disabled by default. It requires an explicit ingest Token and approved extension origin, then validates image bytes, MIME type, size, pixel count, and request shape.
- Migration verifies records, original-image hashes, and library structure before SQLite becomes authoritative; JSON remains a backup rather than a second live store.
- Grok and Cowart imports preserve their source boundaries, report health and errors, and deduplicate without widening the permitted local paths.
- Add Node 22 baseline, source checks, dependency audit scripts, and GitHub Actions CI for the public source.

### macOS desktop

- Added an Apple Silicon Electron shell that opens the existing MOSA Web UI without adding an AI model, cloud service, or frontend rewrite.
- Added verified attach, owned-runtime, and conflict modes for the local MOSA service, preserving external services and stopping only runtimes owned by the desktop app.
- Added Electron Forge packaging with ASAR and unpacked native dependencies for `better-sqlite3` and `sharp`.

### Windows desktop preview

- Added a shared Electron platform boundary so the renderer, local runtime, storage, Web Capture pairing, and most desktop behavior remain one implementation across macOS and Windows.
- Added the `win32-x64` Forge target with Windows-native `better-sqlite3` and Sharp runtime selection, ASAR native unpacking, Windows executable/path resolution, and Windows packaged-smoke support.
- Added Windows path safety for drive-letter paths, UNC paths, and cross-drive containment; source defaults now flow through a centralized source-location resolver instead of scattered platform assumptions.
- Added a Windows CI lane for x64 packaging, platform/path contracts, Electron E2E, and packaged smoke.
- Verified on a real Windows machine that MOSA starts successfully, renders the shared library and Inspector, and automatically collects Codex assets. The Windows shell keeps the native title bar while hiding Electron's visible application-menu row and retaining keyboard accelerators.

### Licensing / 许可

- Version 0.2.0 and later are source-available under the PolyForm Noncommercial License 1.0.0. Noncommercial personal, educational, research, hobby, modification, and distribution uses remain permitted; commercial use requires separate written authorization.
- [v0.1.0](https://github.com/fengseekling-coder/mosa/releases/tag/v0.1.0) remains the final MIT-licensed public source snapshot. Existing MIT copies retain their original rights.

### Known limits / 已知限制

- **Desktop builds are not a signed release.** macOS arm64 and Windows 10/11 x64 development/package targets exist, but no signed public desktop installer is published for 0.2.0. Windows is currently Preview/Testing; installer/signing/automatic-update work is still pending.
- **Windows source coverage is not complete yet.** Codex automatic collection has been verified on a real Windows machine; Grok and Cowart Windows source discovery remain unverified until their actual local layouts are confirmed.
- **No cloud by default.** MOSA provides no remote sync, embedded AI model, semantic search, or automatic library upload.
- **Capture is deliberately conservative.** Web Capture needs a locally loaded extension; when MOSA cannot confidently match generation context, it records the Prompt as unavailable instead of guessing.

## 0.1.0 - Final MIT-licensed source snapshot

- Added a local-first visual library that preserves prompts, image metadata, source paths, and provenance alongside each asset.
- Added automatic Codex image reconciliation and provenance capture from local image-generation records.
- Added Cowart canvas synchronization, source-aware reuse, and deduplication for images returned to the canvas.
- Added a browser UI with search, filters, metadata editing, English and Chinese interfaces, and a local MCP server.
- Added a reproducible judging path using tracked sample records and the `npm test` suite.

## 2026-07-19 - UI polish

- Fixed blank space below gallery cards and normalized vertical spacing.
- Truncated long collection names in the sidebar while preserving their full value in the hover title.
- Kept the complete README interface screenshot and removed two redundant detail screenshots.
