// R21（Web 端）设置弹窗两栏契约（任务 25 / 任务 81 GravityPort A5 重排）：
// 只读 web/app/app.mjs、web/app/styles.css 与 web/app/i18n.mjs。
// 锁定：两栏框架（240px 左栏 + 1fr 内容）、tablist/tab/tabpanel 语义、
// 四个 data-settings-page 及每页应含的控件、#settingsModalTitle 与
// data-settings-close 仍在、↑↓ Home End 键盘处理、state.settingsPage 默认
// general、A5 主要尺寸（1200×728、左栏 240、导航 36 高、行最小 72 高、
// 分段控件 128×32）、任务 81 新增字号下限 10px 与导航新文案。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readWebI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");

// 同一选择器可能出现多次，浏览器用最后一组；任务 25 的规则全部追加在文件末尾，
// 这里按「最后一次出现」取块（写法同 web-r21-inspector-body，允许逗号分组）。
function lastBlock(css, selector) {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\{|,\\n)[^}]*\\}`, "g");
  const blocks = css.match(pattern) || [];
  assert.ok(blocks.length, `${selector} must exist`);
  return blocks.at(-1);
}

/** Extracts one renderSettingsMenu template panel section by its page id. */
function panelSlice(markup, pageId) {
  const start = markup.indexOf(`data-settings-panel="${pageId}"`);
  assert.notEqual(start, -1, `panel ${pageId} must exist`);
  const end = markup.indexOf("</section>", start);
  assert.notEqual(end, -1, `panel ${pageId} must be closed`);
  return markup.slice(start, end);
}

/** Slices the R21 settings renderer region (renderSettingsMenu … activateSettingsPage). */
async function settingsRenderBody() {
  const app = await readWebApp();
  const body = /function renderSettingsMenu\(\{ force = false \} = \{\}\) \{([\s\S]*?)\n\}\n\n\/\/ 设置弹窗内焦点/.exec(app)?.[1];
  assert.ok(body, "expected the R21 settings renderer body");
  return body;
}

test("R21 settings modal renders the two-pane frame with tablist semantics", async () => {
  const body = await settingsRenderBody();
  // 对话框语义保持：role/aria-modal/labelledby/tabindex 与关闭按钮原样保留。
  assert.match(body, /class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle" tabindex="-1"/);
  assert.match(body, /<h2 id="settingsModalTitle">\$\{t\("settings"\)\}<\/h2>/);
  assert.match(body, /class="settings-modal-close" type="button" data-settings-close/);
  // 两栏：左栏 aside（品牌 + tablist + 本地优先），右栏 main（标题栏 + 滚动内容）。
  assert.match(body, /<aside class="settings-modal-sidebar">/);
  assert.match(body, /<div class="settings-modal-brand">/);
  assert.match(body, /<nav class="settings-modal-nav" role="tablist" aria-orientation="vertical"/);
  assert.match(body, /<div class="settings-modal-main">/);
  // 四个分类按钮与四个面板一一对应：tab 构建行与 panel 构建行都带完整语义。
  assert.match(body, /class="settings-nav-tab\$\{active \? " active" : ""\}" type="button" role="tab" id="settings-tab-\$\{page\.id\}" aria-selected="\$\{active\}" aria-controls="settings-page-\$\{page\.id\}" data-settings-page="\$\{page\.id\}" tabindex="\$\{active \? 0 : -1\}"/);
  // 任务 81：稿子右栏只有页头标题 + 行，页内不再重复渲染页标题/说明。
  assert.match(body, /class="settings-page" role="tabpanel" id="settings-page-\$\{page\.id\}" aria-labelledby="settings-tab-\$\{page\.id\}" data-settings-panel="\$\{page\.id\}"\$\{page\.id === activePage \? "" : " hidden"\}><div class="settings-group">\$\{page\.rows\}<\/div><\/section>/);
  // 非当前页用 hidden 属性隐藏；右栏标题栏显示当前分类名。
  assert.match(body, /data-settings-active-title/);
});

test("each category page holds exactly its own rows and controls", async () => {
  const body = await settingsRenderBody();
  // 四页顺序固定，行内容复用既有 row() 变量；任务 81 起页对象不再带说明文案。
  assert.match(body, /\{ id: "general", label: t\("settingsPageGeneral"\), rows: appearanceRows,/);
  assert.match(body, /\{ id: "library", label: t\("settingsPageLibrary"\), rows: storageRows,/);
  assert.match(body, /\{ id: "visual", label: t\("settingsPageVisual"\), rows: visualRows,/);
  assert.match(body, /\{ id: "about", label: t\("settingsPageAbout"\), rows: aboutProductRow \+ aboutRow \+ userIdRow,/);
  // 常规与外观：主题、素材卡片信息、界面语言。
  const appearanceRows = /const appearanceRows = \[([\s\S]*?)\]\.join\(""\);/.exec(body)?.[1] || "";
  assert.match(appearanceRows, /themeRow/);
  assert.match(appearanceRows, /data-card-info-opt/);
  assert.match(appearanceRows, /data-locale/);
  // 主题行：预览卡整行渲染在 settings-theme-row 里（任务 81 稿子无行标题）。
  const themeRow = /const themeRow = `([\s\S]*?)`;/.exec(body)?.[1] || "";
  assert.match(themeRow, /class="settings-modal-row settings-theme-row"/);
  assert.match(themeRow, /themeChoices\(t\("themeMode"\), "data-appearance-opt", state\.themeSetting, \[\{ value: "system", label: t\("themeSystem"\) \}, \{ value: "light", label: t\("themeLight"\) \}, \{ value: "dark", label: t\("themeDark"\) \}\]\)/);
  // 素材库与存储：素材库位置（路径框内嵌打开 + 更改位置）+ 存储引擎。
  const pathBox = /const libraryPathBox = `([\s\S]*?)`;/.exec(body)?.[1] || "";
  assert.match(pathBox, /class="settings-path-box"/);
  assert.match(pathBox, /class="settings-path" data-settings-library-path title="\$\{path\}"/);
  assert.match(pathBox, /data-open-library/);
  const changeLibraryControl = /const changeLibraryControl = window\.electronAPI\?\.changeLibraryLocation\s*\n\s*\? `([\s\S]*?)`\n\s*: "";/.exec(body);
  assert.ok(changeLibraryControl, "expected the changeLibraryControl template");
  assert.match(changeLibraryControl[1], /data-change-library/);
  const storageRows = /const storageRows = \[([\s\S]*?)\]\.join\(""\);/.exec(body)?.[1] || "";
  assert.match(storageRows, /row\(t\("libraryPath"\), "", `\$\{libraryPathBox\}\$\{changeLibraryControl\}`, "settings-library-row"\)/);
  assert.match(storageRows, /data-settings-storage-engine/);
  // 本地视觉能力：视觉模型状态行（任务 109 起为独立模板，不再走 row()）；
  // 关于 MOSA：版本 / 更新行。
  const visualRows = /const visualRows = `([\s\S]*?)`;\n  \/\/ 任务 109/.exec(body)?.[1] || "";
  assert.match(visualRows, /data-settings-visual-model/);
  assert.match(visualRows, /<h4>\$\{t\("visualModelTitle"\)\}<\/h4>/);
  const aboutRow = /const aboutRow = row\(([\s\S]*?)\);\n  \/\/ 用户 ID 行/.exec(body)?.[1] || "";
  assert.match(aboutRow, /data-settings-version/);
  assert.match(aboutRow, /data-settings-update-action/);
  // 关于 MOSA：版本 / 更新行之后是用户 ID 行（任务 69；仅桌面版拿到 ID 时渲染）。
  const userIdRow = /const userIdRow = state\.userProfileId\s*\n\s*\? row\(([\s\S]*?)\)\n\s*: "";/.exec(body)?.[1] || "";
  assert.match(userIdRow, /data-settings-user-id/);
  assert.match(userIdRow, /data-copy-user-id/);
  // 控件不串页。
  assert.doesNotMatch(storageRows, /data-appearance-opt|data-locale/);
  assert.doesNotMatch(appearanceRows, /data-settings-library-path|data-settings-version/);
  // 左栏底部本地优先说明。
  assert.match(body, /class="settings-local-first"/);
  assert.match(body, /\$\{t\("settingsLocalFirst"\)\}/);
  assert.match(body, /\$\{t\("settingsLocalFirstDesc"\)\}/);
});

test("category switching keeps the roving-tabindex keyboard contract", async () => {
  const app = await readWebApp();
  // ↑/↓ 移动并自动激活，Home/End 到首/末；激活复用 click 业务路径。
  assert.match(app, /function handleSettingsMenuKeydown\(event\)[\s\S]*?const tab = event\.target\.closest\?\.\('\[role="tab"\]'\)[\s\S]*?ArrowDown" \|\| event\.key === "ArrowRight"[\s\S]*?ArrowUp" \|\| event\.key === "ArrowLeft"[\s\S]*?Home[\s\S]*?End[\s\S]*?tabs\[next\]\.click\(\);[\s\S]*?tabs\[next\]\.focus\(\);/);
  // 点击分支与唯一激活入口：同步 aria-selected、tabindex、面板 hidden。
  assert.match(app, /const settingsPageTab = event\.target\.closest\("\[data-settings-page\]"\);\n    if \(settingsPageTab\) \{ activateSettingsPage\(settingsPageTab\.dataset\.settingsPage\); return; \}/);
  assert.match(app, /function activateSettingsPage\(pageId\)[\s\S]*?aria-selected[\s\S]*?tabIndex = active \? 0 : -1[\s\S]*?panel\.hidden = panel\.dataset\.settingsPanel !== pageId/);
  // state.settingsPage：会话内记忆，默认 general，非法值回退 general。
  assert.match(app, /settingsPage: "general",/);
  assert.match(app, /if \(!settingsPages\.some\(\(page\) => page\.id === state\.settingsPage\)\) state\.settingsPage = "general";/);
  // 可见重建（语言切换）后焦点恢复：先记录身份，再优先回原控件、其次回当前分类标签。
  assert.match(app, /function describeSettingsFocus\(element\)/);
  assert.match(app, /function restoreSettingsFocus\(previousFocus\)/);
  assert.match(app, /const previousFocus = refreshingVisibleDialog \? describeSettingsFocus\(document\.activeElement\) : null;/);
  assert.match(app, /restoreSettingsFocus\(previousFocus\);/);
});

test("A5 settings geometry: fixed 720x464 card, 240px sidebar, 36px tabs and rows at 72px", async () => {
  const css = await readWebCss();
  const card = lastBlock(css, ".mosa-v2 .settings-modal-card");
  assert.match(card, /display: grid;/);
  assert.match(card, /grid-template-columns: 240px minmax\(0, 1fr\);/);
  // 任务 121（用户 10-11 定）：弹窗固定为「常规与外观」页的大小 720×464，切分页
  // 不再变矮；行轨道 minmax(0,1fr) 把高度传导给右栏，内容超出只有
  // .settings-modal-body 滚动；窗口矮时跟着窗口收。
  assert.match(card, /width: min\(720px, 100%\);/);
  assert.match(card, /(^|\n)\s{2}height: min\(464px, calc\(100dvh - 48px\)\);/);
  assert.match(card, /max-height: min\(464px, calc\(100dvh - 48px\)\);/);
  assert.match(card, /grid-template-rows: minmax\(0, 1fr\);/);
  assert.doesNotMatch(card, /540px/);
  assert.doesNotMatch(card, /max-height: none;/);
  // 高度固定后卡片垂直居中：上边距按 464 算，窗口矮到放不下时归零。≤839 的单栏
  // 布局不在这次范围，高度仍随内容、顶边仍按原来的位置固定。
  assert.match(card, /align-self: start;/);
  assert.match(card, /margin-top: max\(0px, calc\(\(100dvh - 48px - 464px\) \/ 2\)\);/);
  assert.match(css, /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-card \{[^}]*height: auto;[^}]*margin-top: max\(0px, calc\(\(100dvh - 32px - 540px\) \/ 2\)\);/);
  assert.doesNotMatch(css, /\.mosa-v2 \.settings-modal-card \{[^}]*align-self: center;/);
  // 全文件不再有 960/728 写死值（不再生效的旧规则一并清掉）。
  assert.doesNotMatch(css, /\.mosa-v2 \.settings-modal-card \{[^}]*960/);
  assert.doesNotMatch(css, /\.mosa-v2 \.settings-modal-card \{[^}]*728/);
  const sidebar = lastBlock(css, ".mosa-v2 .settings-modal-sidebar");
  assert.match(sidebar, /padding: 0 var\(--sp-5\) var\(--sp-5\);/);
  assert.match(sidebar, /background: var\(--app-sidebar\);/);
  const brand = lastBlock(css, ".mosa-v2 .settings-modal-brand");
  assert.match(brand, /height: 60px;/);
  const header = lastBlock(css, ".mosa-v2 .settings-modal-header");
  assert.match(header, /height: 60px;/);
  assert.match(header, /margin: 0 var\(--sp-10\);/);
  const title = lastBlock(css, ".mosa-v2 .settings-modal-header h2");
  assert.match(title, /font-size: var\(--text-xl\);/, "「设置」大标题归 --text-xl（规范表 v1，16px 原值升 18px 档）");
  const main = lastBlock(css, ".mosa-v2 .settings-modal-main");
  assert.match(main, /background: var\(--app-bg\);/);
  const close = lastBlock(css, ".mosa-v2 .settings-modal-close");
  assert.match(close, /width: 28px;/);
  assert.match(close, /height: 28px;/);
  const tab = lastBlock(css, ".mosa-v2 .settings-nav-tab");
  assert.match(tab, /height: 36px;/);
  assert.match(tab, /padding: 0 var\(--sp-2\);/);
  assert.match(tab, /border-radius: var\(--radius-md\);/);
  assert.match(tab, /font-size: var\(--text-md\);/);
  const row = lastBlock(css, ".mosa-v2 .settings-group .settings-modal-row");
  assert.match(row, /min-height: 72px;/);
  assert.match(row, /padding: var\(--sp-5\) 0;/);
  const rowSeparator = lastBlock(css, ".mosa-v2 .settings-group .settings-modal-row:not(:last-child)");
  assert.match(rowSeparator, /border-bottom: 1px solid var\(--color-border-subtle\);/);
  const segmented = lastBlock(css, ".mosa-v2 .settings-menu .segmented");
  assert.match(segmented, /width: 128px;/);
  assert.match(segmented, /height: 32px;/);
  assert.match(segmented, /padding: 0;/);
  const body_ = lastBlock(css, ".mosa-v2 .settings-modal-body");
  assert.match(body_, /padding: 0 var\(--sp-10\) var\(--sp-6\);/);
  const rowTitle = lastBlock(css, ".mosa-v2 .settings-row-copy h4");
  assert.match(rowTitle, /font-size: var\(--text-md\);/);
  const textAction = lastBlock(css, ".mosa-v2 .settings-text-action");
  assert.match(textAction, /min-height: 32px;/);
  assert.match(textAction, /padding: 0 var\(--sp-4\);/);
  const pathBox = lastBlock(css, ".mosa-v2 .settings-path-box");
  assert.match(pathBox, /width: 320px;/);
  assert.match(pathBox, /height: 32px;/);
  assert.match(pathBox, /border-radius: var\(--radius-md\);/);
  const path = lastBlock(css, ".mosa-v2 .settings-path");
  assert.match(path, /font-size: var\(--text-xs\);/);
  assert.match(path, /max-width: 100%;/);
  // 任务 110：库路径改「头 + 尾」两段中间省略（末尾保留库文件夹名），省略号由 .me-head 画。
  assert.match(path, /display: flex;/);
  assert.match(css, /\.me-head \{ min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.me-tail \{ max-width: 100%; flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
});

// 任务 109：模型页「标题一行；说明+状态另起一行」、状态可换行不截断；
// 关于页在版本号上面加一行产品名（复用 appTitle，不新加文案键）。
test("task 109: model page stacks description under the title, about page names the product first", async () => {
  const body = await settingsRenderBody();
  const visualRows = /const visualRows = `([\s\S]*?)`;\n  \/\/ 任务 109/.exec(body)?.[1] || "";
  assert.ok(visualRows, "expected the task-109 visual rows template");
  assert.match(visualRows, /class="settings-modal-row settings-visual-model-row"/);
  assert.match(visualRows, /<h4>\$\{t\("visualModelTitle"\)\}<\/h4>/);
  assert.match(visualRows, /class="settings-visual-model-detail"><p>\$\{t\("visualModelDescription"\)\}<\/p><div data-settings-visual-model>/);
  const aboutProductRow = /const aboutProductRow = `([\s\S]*?)`;\n  const aboutRow/.exec(body)?.[1] || "";
  assert.ok(aboutProductRow, "expected the task-109 about product row");
  assert.match(aboutProductRow, /class="settings-about-product-name">\$\{t\("appTitle"\)\}</);
  assert.match(body, /rows: aboutProductRow \+ aboutRow \+ userIdRow,/);
  const css = await readWebCss();
  const detail = lastBlock(css, ".mosa-v2 .settings-visual-model-row .visual-model-status span");
  assert.match(detail, /white-space: normal;/);
  assert.match(detail, /text-overflow: clip;/);
  assert.doesNotMatch(detail, /ellipsis/);
  const row = lastBlock(css, ".mosa-v2 .settings-visual-model-row");
  assert.match(row, /grid-template-columns: minmax\(0, 1fr\);/);
  // 说明文字和标题、状态左对齐：抵消旧规则 .settings-menu p 的内边距。
  const description = lastBlock(css, ".mosa-v2 .settings-visual-model-detail p");
  assert.match(description, /margin: 0; padding: 0;/);
});

test("new surface split and segmented track use tokens or already-existing light values", async () => {
  const css = await readWebCss();
  // 两栏分色（任务 81）：左栏 app-sidebar（浅色=白），右栏 app-bg（浅色=灰）。
  assert.match(css, /\.mosa-v2 \.settings-modal-sidebar \{[\s\S]*?background: var\(--app-sidebar\);/);
  assert.match(css, /\.mosa-v2 \.settings-modal-main \{[\s\S]*?background: var\(--app-bg\);/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-nav-tab \{\n  color: #5f5f65;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-nav-tab\.active \{\n  color: #202024;\n  background: #ececef;\n\}/);
  // 灰底上的分段轨道：沿用既有浅色值，补既有值 #e2e2e5 的描边让轨道在灰底可辨。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-menu \.segmented \{\n  border: 1px solid #e2e2e5;\n  background: #f1f1f3;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-menu \.segmented-btn\.active \{[^}]*color: #303035;[^}]*background: #fff;[^}]*font-weight: var\(--weight-medium\);[^}]*box-shadow: 0 0 0 1px #e2e2e5 inset;/);
  // 深色不得出现这些浅色值。
  assert.doesNotMatch(css, /\[data-theme="dark"\][^\n]*#f1f1f3/);
});

test("narrow viewports below 840px collapse the sidebar into one scrollable row", async () => {
  const css = await readWebCss();
  const narrow = /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-card \{[^}]*\}/.exec(css)?.[0];
  assert.ok(narrow, "the narrow-window media block must exist");
  assert.match(narrow, /width: 100%;/);
  assert.match(narrow, /max-height: calc\(100dvh - 32px\);/);
  assert.match(narrow, /flex-direction: column;/);
  const sidebar = /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-sidebar \{[^}]*\}/.exec(css)?.[0];
  assert.match(sidebar, /flex-direction: row;/);
  assert.match(css, /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-nav \{[^}]*flex-direction: row;[^}]*overflow-x: auto;/);
  assert.match(css, /@media \(max-width: 839px\) \{[\s\S]*?\.mosa-v2 \.settings-modal-foot \{\n    display: none;\n  \}/);
});

test("every font size added by this task stays at or above the 10px floor", async () => {
  const css = await readWebCss();
  const marker = css.indexOf("R21 设置弹窗");
  assert.notEqual(marker, -1, "the task 25 block must exist");
  const added = css.slice(marker);
  // 规范表 v1（任务 104）后字号走 :root 变量，这里解析 token 实际值再做下限校验。
  const tokens = new Map([...css.matchAll(/(--text-(?:xs|sm|md|lg|xl)):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[1], Number(m[2])]));
  const sizes = [
    ...[...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1])),
    ...[...added.matchAll(/font-size: var\((--text-(?:xs|sm|md|lg|xl))\)/g)].map((match) => tokens.get(match[1])),
  ];
  assert.ok(sizes.length >= 10, `expected the task's font sizes to be pinned (got ${sizes.length})`);
  for (const size of sizes) {
    assert.ok(size >= 10, `every added font-size must stay >= 10px (got ${size}px)`);
  }
});

test("web i18n carries the four category names, page descriptions and local-first copy", async () => {
  const i18n = await readWebI18n();
  // 任务 81：导航/页标题改用稿子的说法（常规与外观 / 存储 / 模型 / 关于）。
  for (const [key, zh, en] of [
    ["settingsPageGeneral", "常规与外观", "General & Appearance"],
    ["settingsPageLibrary", "存储", "Storage"],
    ["settingsPageVisual", "模型", "Model"],
    ["settingsPageAbout", "关于", "About"],
    ["settingsLocalFirst", "本地优先", "Local first"],
    ["themeSystem", "跟随系统", "System"],
  ]) {
    assert.match(i18n, new RegExp(`${key}: "${zh}"`), `zh copy for ${key}`);
    assert.match(i18n, new RegExp(`${key}: "${en.replaceAll("&", "&")}"`), `en copy for ${key}`);
  }
  for (const key of ["settingsPageGeneralDesc", "settingsPageLibraryDesc", "settingsPageVisualDesc", "settingsPageAboutDesc", "settingsLocalFirstDesc"]) {
    const matches = i18n.match(new RegExp(`${key}: "`, "g")) || [];
    assert.equal(matches.length, 2, `${key} must exist in both locales`);
  }
});

// 任务 81 新增：锁 A5 的四项交付——导航新文案、四页齐全、二选一渲染成分段按钮、
// 素材库路径框内嵌打开按钮。
test("A5 settings dialog: GravityPort nav copy, four pages, segmented binary rows and the path box", async () => {
  const i18n = await readWebI18n();
  const body = await settingsRenderBody();
  // 1) 4 个导航项的新文案（中英文都在）。
  for (const [key, zh, en] of [
    ["settingsPageGeneral", "常规与外观", "General & Appearance"],
    ["settingsPageLibrary", "存储", "Storage"],
    ["settingsPageVisual", "模型", "Model"],
    ["settingsPageAbout", "关于", "About"],
  ]) {
    assert.match(i18n, new RegExp(`${key}: "${zh}"`));
    assert.match(i18n, new RegExp(`${key}: "${en}"`));
  }
  // 2) 四个页面都还在（data-settings-page id 不变）。
  for (const id of ["general", "library", "visual", "about"]) {
    assert.match(body, new RegExp(`\\{ id: "${id}", label: t\\("`));
  }
  // 3) 二选一的设置渲染成分段按钮（卡片信息、界面语言）。
  assert.match(body, /segmented\(t\("cardInfo"\), "data-card-info-opt", state\.showCardInfo \? "show" : "hide", \[\{ value: "hide", label: t\("cardInfoHide"\) \}, \{ value: "show", label: t\("cardInfoShow"\) \}\]\)/);
  assert.match(body, /segmented\(t\("interfaceLanguage"\), "data-locale", visualLocale, \[\{ value: "zh", label: "中文" \}, \{ value: "en", label: "EN" \}\]\)/);
  // 4) 素材库路径框里有「打开」按钮。
  const pathBox = /const libraryPathBox = `([\s\S]*?)`;/.exec(body)?.[1] || "";
  assert.match(pathBox, /class="settings-path-box"/);
  assert.match(pathBox, /data-settings-library-path/);
  assert.match(pathBox, /data-open-library>\$\{t\("settingsOpenLibrary"\)\}/);
});

// 任务 42：主题行是 R21 预览卡。任务 81 返工 1：三张卡——跟随系统/浅色/深色，
// 跟随系统在左；选中态跟 state.themeSetting 走（三态），实际外观仍是 light/dark。
test("theme row renders three R21 preview cards with full radio semantics", async () => {
  const body = await settingsRenderBody();
  const appearanceRows = /const appearanceRows = \[([\s\S]*?)\]\.join\(""\);/.exec(body)?.[1] || "";
  // 主题行用 themeChoices 预览卡（签名与 segmented 同构），仍由三态 themeSetting 驱动。
  const themeRow = /const themeRow = `([\s\S]*?)`;/.exec(body)?.[1] || "";
  assert.match(themeRow, /themeChoices\(t\("themeMode"\), "data-appearance-opt", state\.themeSetting, \[\{ value: "system", label: t\("themeSystem"\) \}, \{ value: "light", label: t\("themeLight"\) \}, \{ value: "dark", label: t\("themeDark"\) \}\]\)/);
  // 卡片语义：role=radio + aria-checked + roving tabindex + data-appearance-opt；
  // 预览图 aria-hidden；可访问名称来自可见标签；勾号徽章是选中态的非颜色标志。
  // 跟随系统卡的预览是左半浅色 + 右半深色（settings-theme-half-light/-dark）。
  const cardMarkup = /const themeChoiceCard = \(selected, attribute, value, label\) => `([\s\S]*?)`;\n/.exec(body)?.[1] || "";
  assert.ok(cardMarkup, "expected the themeChoiceCard template");
  assert.match(cardMarkup, /class="settings-theme-card\$\{selected \? " active" : ""\}" type="button" role="radio" aria-checked="\$\{selected\}" tabindex="\$\{selected \? 0 : -1\}"/);
  assert.match(cardMarkup, /<span class="settings-theme-preview" aria-hidden="true">/);
  assert.match(cardMarkup, /value === "system"/);
  assert.match(cardMarkup, /class="settings-theme-preview settings-theme-preview-system" aria-hidden="true"><span class="settings-theme-half settings-theme-half-light">\$\{themePreviewInnards\(\)\}<\/span><span class="settings-theme-half settings-theme-half-dark">\$\{themePreviewInnards\(\)\}<\/span>/);
  assert.match(cardMarkup, /class="settings-theme-check"><svg /);
  assert.match(cardMarkup, /<span class="settings-theme-label">\$\{label\}<\/span>/);
  // 组容器：radiogroup 可访问名称为主题模式。
  assert.match(body, /const themeChoices = \(ariaLabel, attribute, selectedValue, options\) => `<div class="settings-theme-choices" role="radiogroup" aria-label="\$\{escapeHtml\(ariaLabel\)\}">/);
  // 状态同步复用同一套 syncSegmentedRadios（组选择器扩项，不另立第二套）。
  const app = await readWebApp();
  assert.match(app, /querySelectorAll\("\.segmented, \.settings-theme-choices"\)/);
  assert.match(app, /querySelectorAll\("\.segmented-btn, \[role=\\"radio\\"\]"\)/);
});

// 任务 81 返工 1：主题三态——跟随系统/浅色/深色。存储沿用 mosa-dark-mode：
// "true"/"false" 历史取值原样有效，"system"/缺失/未知 = 跟随系统（新用户默认）；
// state.darkMode 只存实际生效值，data-theme 等读主题处永远拿到 light/dark。
test("theme setting is three-state with system following prefers-color-scheme live", async () => {
  const app = await readWebApp();
  // 存储映射与解析："true"→dark、"false"→light、其余→system。
  assert.match(app, /const THEME_SYSTEM = "system";/);
  assert.match(app, /function resolveThemeSetting\(raw\) \{\n  if \(raw === "true"\) return "dark";\n  if \(raw === "false"\) return "light";\n  return THEME_SYSTEM;\n\}/);
  assert.match(app, /function themeSettingStorageValue\(setting\) \{\n  if \(setting === "dark"\) return "true";\n  if \(setting === "light"\) return "false";\n  return THEME_SYSTEM;\n\}/);
  // 生效主题 = 设置本身，或跟随系统时由 prefers-color-scheme 推导。
  assert.match(app, /const systemDarkQuery = typeof window\.matchMedia === "function" \? window\.matchMedia\("\(prefers-color-scheme: dark\)"\) : null;/);
  assert.match(app, /function effectiveDarkMode\(setting\) \{\n  return setting === "dark" \|\| \(setting === THEME_SYSTEM && systemPrefersDark\(\)\);\n\}/);
  // state：themeSetting 三态 + darkMode 生效值，都从同一份存储初值推导。
  assert.match(app, /const initialThemeSetting = resolveThemeSetting\(safeStorageGet\("mosa-dark-mode"\)\);/);
  assert.match(app, /darkMode: effectiveDarkMode\(initialThemeSetting\), settingsReturnFocus: null,/);
  assert.match(app, /themeSetting: initialThemeSetting,/);
  // 点击：写三态、推导生效值、按三态映射写存储；darkMode 不再直接由字符串赋值。
  assert.match(app, /state\.themeSetting = newTheme === "light" \|\| newTheme === "dark" \? newTheme : THEME_SYSTEM;/);
  assert.match(app, /state\.darkMode = effectiveDarkMode\(state\.themeSetting\);/);
  assert.match(app, /safeStorageSet\("mosa-dark-mode", themeSettingStorageValue\(state\.themeSetting\)\);/);
  assert.doesNotMatch(app, /safeStorageSet\("mosa-dark-mode", String\(state\.darkMode\)\)/);
  // 跟随系统：matchMedia change 即时生效（不刷新页面），未选跟随系统时不动作。
  assert.match(app, /systemDarkQuery\?\.addEventListener\?\.\("change", \(\) => \{\n  if \(state\.themeSetting !== THEME_SYSTEM\) return;\n  state\.darkMode = systemPrefersDark\(\);\n  applyDarkMode\(\);\n\}\);/);
  // 选中态与同步走三态；data-theme 只会是 light/dark。
  assert.match(app, /setRadioState\("\[data-appearance-opt\]", state\.themeSetting\)/);
  assert.match(app, /button\.dataset\.appearanceOpt === state\.themeSetting/);
  assert.match(app, /const appearance = state\.darkMode \? "dark" : "light";\n  document\.documentElement\.setAttribute\("data-theme", appearance\);/);
});

test("theme preview cards lock the R21 swatches, hover lift and the check-mark selected marker", async () => {
  const css = await readWebCss();
  // 布局（任务 81 稿子）：两列固定 186 宽、间距 40、内容左对齐；缩略框 90 高、16px
  // 标题栏、8 圆角；名称居中在卡下方。任务 109：弹窗收窄到 720 后三张 186 固定宽
  // 放不下，卡改为可收缩（minmax(0,186px) + max-width），≤839 窄窗降级随之并入基础规则。
  const choices = lastBlock(css, ".mosa-v2 .settings-theme-choices");
  assert.match(choices, /grid-template-columns: repeat\(3, minmax\(0, 186px\)\);/);
  assert.match(choices, /gap: var\(--sp-10\);/);
  assert.match(choices, /justify-content: start;/);
  assert.doesNotMatch(css, /repeat\(3, 186px\)/);
  const card = lastBlock(css, ".mosa-v2 .settings-theme-card");
  assert.match(card, /width: 100%;/);
  assert.match(card, /max-width: 186px;/);
  assert.match(card, /text-align: center;/);
  const preview = lastBlock(css, ".mosa-v2 .settings-theme-preview");
  assert.match(preview, /height: 90px;/);
  assert.match(preview, /grid-template-rows: 16px minmax\(0, 1fr\);/);
  assert.match(preview, /border-radius: var\(--radius-md\);/);
  // 「跟随系统」预览：左右两半，配色复用既有浅/深两套固定值。
  const systemPreview = lastBlock(css, '.mosa-v2 .settings-theme-card[data-appearance-opt="system"] .settings-theme-preview');
  assert.match(systemPreview, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(systemPreview, /grid-template-rows: minmax\(0, 1fr\);/);
  assert.match(systemPreview, /border-color: var\(--color-border-subtle\);/);
  const half = lastBlock(css, ".mosa-v2 .settings-theme-half");
  assert.match(half, /grid-template-rows: 16px minmax\(0, 1fr\);/);
  assert.match(half, /overflow: hidden;/);
  const body_ = lastBlock(css, ".mosa-v2 .settings-theme-body");
  assert.match(body_, /grid-template-columns: 23% minmax\(0, 1fr\) 23%;/);
  // 选中：accent 边 + 浅 accent 外圈；勾号徽章默认隐藏、active 显示（非颜色标志）。
  const activePreview = lastBlock(css, ".mosa-v2 .settings-theme-card.active .settings-theme-preview");
  assert.match(activePreview, /border-color: var\(--color-accent\);/);
  assert.match(activePreview, /box-shadow: 0 0 0 1px color-mix\(in srgb, var\(--color-accent\) 15%, transparent\);/);
  const check = lastBlock(css, ".mosa-v2 .settings-theme-check");
  assert.match(check, /display: none;/);
  assert.match(check, /color: var\(--color-accent-contrast\);/);
  assert.match(check, /background: var\(--color-accent\);/);
  const checkActive = lastBlock(css, ".mosa-v2 .settings-theme-card.active .settings-theme-check");
  assert.match(checkActive, /display: grid;/, "the check-mark badge is the non-colour selected marker");
  // 悬停上移 1px（限定精确指针），prefers-reduced-motion 下不位移。
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\) \{[^}]*\.mosa-v2 \.settings-theme-card:hover \.settings-theme-preview \{[^}]*transform: translateY\(-1px\);/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.mosa-v2 \.settings-theme-card:hover \.settings-theme-preview \{\n    transform: none;\n  \}/);
  // 两套固定预览配色的关键值（浅色卡在深色主题下也保持浅色样子）；同一规则同时
  // 覆盖「跟随系统」卡的对应半幅（返工 1：half-light / half-dark 复用同色）。
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="light"\] \.settings-theme-preview,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-light \{\n  border-color: #d8d8dd;\n  background: #f6f6f7;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="light"\] \.settings-theme-chrome,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-light \.settings-theme-chrome \{\n  border-bottom-color: #d8d8dd;\n  background: #ededf0;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="light"\] \.settings-theme-nav,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-light \.settings-theme-nav \{\n  background: #efeff1;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="light"\] \.settings-theme-canvas,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-light \.settings-theme-canvas \{\n  background: #f9f9fa;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="light"\] \.settings-theme-grid i,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-light \.settings-theme-grid i \{\n  background: #dbdbe0;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="dark"\] \.settings-theme-preview,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-dark \{\n  border-color: #303036;\n  background: #151518;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="dark"\] \.settings-theme-chrome,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-dark \.settings-theme-chrome \{\n  border-bottom-color: #303036;\n  background: #1d1d21;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="dark"\] \.settings-theme-nav,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-dark \.settings-theme-nav \{\n  background: #18181c;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="dark"\] \.settings-theme-canvas,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-dark \.settings-theme-canvas \{\n  background: #101013;\n\}/);
  assert.match(css, /\.mosa-v2 \.settings-theme-card\[data-appearance-opt="dark"\] \.settings-theme-grid i,\n\.mosa-v2 \.settings-theme-card\[data-appearance-opt="system"\] \.settings-theme-half-dark \.settings-theme-grid i \{\n  background: #313138;\n\}/);
  // 标签 13px（--text-md）/600（--weight-semibold）居中（任务 81 稿子 + 规范表 v1）；文字色只在浅色作用域；新字号 ≥10px。
  const label = lastBlock(css, ".mosa-v2 .settings-theme-label");
  assert.match(label, /font-size: var\(--text-md\);/);
  assert.match(label, /font-weight: var\(--weight-semibold\);/);
  assert.match(label, /text-align: center;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.settings-theme-label \{\n  color: #2a2a2e;\n\}/);
  const marker = css.indexOf("任务 42");
  assert.notEqual(marker, -1, "the task 42 block must exist");
  const added = css.slice(marker);
  // 规范表 v1（任务 104）后字号走 :root 变量，这里解析 token 实际值再做下限校验。
  const tokens = new Map([...css.matchAll(/(--text-(?:xs|sm|md|lg|xl)):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[1], Number(m[2])]));
  const sizes = [
    ...[...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1])),
    ...[...added.matchAll(/font-size: var\((--text-(?:xs|sm|md|lg|xl))\)/g)].map((match) => tokens.get(match[1])),
  ];
  assert.ok(sizes.length >= 1, "expected task 42 font sizes to be pinned");
  for (const size of sizes) {
    assert.ok(size >= 10, `task 42 font sizes must stay >= 10px (got ${size}px)`);
  }
});
