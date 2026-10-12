// R21（Web 端）shell 契约：全局 token、侧边栏、顶栏。只读 web/app/styles.css，
// 锁定本任务定下的 R21 值（设计稿 MOSA_UI_Integrated_R21_4px_Grid）。
// 深色规格未定：R21 的新颜色必须只出现在浅色作用域里，深色 token 保持现状。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start > -1, `marker not found: ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block after marker: ${marker}`);
}

test("R21 light-theme tokens and the shared shell sizes land in web styles", async () => {
  const css = await readWebCss();
  const lightStart = css.indexOf(':root[data-theme="light"]');
  const lightEnd = css.indexOf('设计令牌：深色');
  const light = css.slice(lightStart, lightEnd);
  assert.match(light, /--app-bg: #f6f6f7;/, "light --app-bg must be the R21 #f6f6f7");
  assert.match(light, /--color-text-primary: #1d1d1f;/, "light --color-text-primary must be the R21 #1d1d1f");
  assert.match(light, /--color-text-tertiary: #67676d;/, "light --color-text-tertiary must be the AA-darkened #67676d (任务 50)");
  // 深色没有 R21 规格：token 保持现状。
  const darkStart = css.indexOf(':root[data-theme="dark"]');
  const darkEnd = css.indexOf("共享 Token");
  const dark = css.slice(darkStart, darkEnd);
  assert.match(dark, /--app-bg: #1c1c1e;/, "dark --app-bg must stay untouched");
  assert.match(dark, /--color-text-primary: #f5f5f7;/, "dark --color-text-primary must stay untouched");
  // 共享 shell 尺寸 token（规范表 v1：顶栏 64→48、侧栏 280→220）。
  assert.match(css, /--topbar-height: 48px;/, "--topbar-height must be the spec-table v1 48px");
  assert.match(css, /--sidebar-width: 220px;/, "--sidebar-width must be the spec-table v1 220px");
  // 4px 结构网格阶梯（旧 --r21-s* 已并入规范表 v1 的 --sp-*，任务 107）。
  // 解析 :root 实际值逐档核对，阶梯本身不许被悄悄改动。
  const ladderValues = new Map([...css.matchAll(/(--sp-[a-z0-9]+)\s*:\s*(\d+)px\s*;/g)].map((m) => [m[1], m[2]]));
  for (const [name, value] of [
    ["--sp-1", "4"], ["--sp-2", "8"], ["--sp-3", "12"], ["--sp-4", "16"],
    ["--sp-5", "20"], ["--sp-6", "24"], ["--sp-8", "32"],
    ["--sp-10", "40"], ["--sp-12", "48"],
  ]) {
    assert.equal(ladderValues.get(name), value, `${name} must be ${value}px`);
  }
  // 基础字号 12px。
  assert.match(css, /body \{ overflow: hidden;[^}]*font: var\(--text-sm\)\/1\.5 var\(--font-family-ui\)/, "body base font-size must come from the spec v1 --text-sm token");
  assert.match(css, /--text-sm: 12px;/, "body base font-size must stay 12px");
});

test("R21 sidebar: light background, brand, nav items and group headings", async () => {
  const css = await readWebCss();
  // GravityPort A1 去掉侧栏右边线：浅色只覆盖背景；深色继续走 .mosa-v2 .sidebar 里的 token。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.sidebar \{ background: #fbfbfc; \}/);
  assert.match(css, /\.mosa-v2 \.sidebar \{[^}]*background: rgb\(from var\(--app-sidebar\)/, "the dark fallback must keep the token-driven background");
  // 品牌区：与顶栏同高（token=48，规范表 v1）、GravityPort A2 起文字靠右（右内边距 20）、
  // 名称 15px（--text-lg）/ 字重 500（--weight-medium）。
  const brand = blockAfter(css, ".mosa-v2 .brand {");
  assert.match(brand, /height: var\(--topbar-height\);/);
  assert.match(brand, /justify-content: flex-end;/);
  assert.match(brand, /padding: 0 var\(--sp-5\);/);
  assert.match(css, /\.mosa-v2 \.brand-info h1 \{ color: var\(--color-text-primary\); font-size: var\(--text-lg\); font-weight: var\(--weight-medium\);/);
  // 导航区：上下结构不变，左右 20（GravityPort A2，项宽 220−40=180），品牌区到第一项 16；导航项间距 4。
  assert.match(css, /\.mosa-v2 \.primary-nav \{ padding: var\(--sp-4\) var\(--sp-5\) var\(--sp-2\); \}/);
  assert.match(css, /\.mosa-v2 \.nav-list \{ gap: var\(--sp-1\); \}/);
  // 导航项：高 28（规范表 v1 36→28）、圆角 8、内边距 0 12（设置按钮与加号按钮共用这条圆角）。
  assert.match(css, /\.mosa-v2 \.nav-item, \.mosa-v2 \.add-group-button, \.mosa-v2 \.settings-trigger \{ min-height: 28px; border-radius: var\(--radius-md\);/);
  assert.match(css, /\.mosa-v2 \.nav-item \{ padding: 0 var\(--sp-3\); font-size: var\(--text-md\); \}/);
  assert.match(css, /\.mosa-v2 \.settings-trigger \{ width: 100%; justify-content: flex-start; gap: var\(--sp-2\); padding: 0 var\(--sp-3\); font-size: var\(--text-md\); \}/);
  // 选中导航项：字重 500（570 归档 --weight-medium），浅色底 #ececef。
  assert.match(css, /\.mosa-v2 \.nav-item\.active \{ color: var\(--color-text-primary\); background: var\(--app-chip-active\); font-weight: var\(--weight-medium\); \}/);
  // 浅色的灰色字色规则特异性高于 .nav-item.active，选中项必须在同一特异性下把字色改回主文字色。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-item\.active \{ background: #ececef; color: var\(--color-text-primary\); \}/);
  // 分组标题：12px（--text-sm）/ 600（--weight-semibold）（GravityPort A2）；浅色不再有写死字色（任务 50 删除），回落到基础规则的 tertiary token。
  assert.match(css, /\.mosa-v2 \.nav-label \{ margin: var\(--sp-4\) 0 var\(--sp-1h\); padding: 0 var\(--sp-3\); color: var\(--color-text-tertiary\); font-size: var\(--text-sm\); font-weight: var\(--weight-semibold\);/);
  assert.doesNotMatch(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-label \{/);
  // 分组之间的间距 24（GravityPort A2）。
  assert.match(css, /\.mosa-v2 \.sidebar-group-heading \{ display: flex; align-items: center; justify-content: space-between; min-height: 28px; margin: var\(--sp-6\) var\(--sp-2\) var\(--sp-half\); \}/);
  assert.match(css, /\.mosa-v2 \.sidebar-manual-group-heading \{ margin-top: var\(--sp-6\); \}/);
  // 导航项字色：浅色 #55555a。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.nav-item, :root\[data-theme="light"\] \.mosa-v2 \.settings-trigger \{ color: #55555a; \}/);
});

test("R21 topbar: nav history buttons, size slider, sort control and search box", async () => {
  const css = await readWebCss();
  // 顶栏高度走 token（64px 在 token 测试里已锁）。
  assert.match(css, /\.mosa-v2 \.topbar \{[^}]*height: var\(--topbar-height\);/);
  // GravityPort A3（任务 70）：类型筛选（全部/图片/视频）从顶栏移除——CSS 规则
  // 一并删干净（dead-code 门也会拦没标记消费的类），这里锁「不得回来」。
  assert.doesNotMatch(css, /\.type-filter|\.topbar-type-filters/, "the retired type-filter rules must not come back");
  // 后退/前进与滑杆两侧按钮：28×28 / 16px 图标（.toolbar-icon 基类）、圆角 8
  // （--radius-control）、无边框透明底；mosa-v2 的 32px 带边框外观只属于右侧控件。
  assert.match(css, /\.topbar-nav-group \{ display: flex; flex: 0 0 auto; align-items: center; gap: var\(--sp-1\); \}/);
  assert.match(css, /\.mosa-v2 \.topbar-nav-group \.toolbar-icon, \.mosa-v2 \.topbar-size-group \.toolbar-icon \{ width: 28px; height: 28px; flex: 0 0 auto; border: 0; border-radius: var\(--radius-md\); background: transparent; \}/);
  // 缩略图大小滑杆：相对顶栏绝对居中，滑轨宽 120，accent 走既有 token。
  assert.match(css, /\.topbar-size-group \{ position: absolute; top: 50%; left: 50%; display: flex; align-items: center; gap: var\(--sp-2\); transform: translate\(-50%, -50%\); \}/);
  assert.match(css, /\.topbar-size-slider \{ box-sizing: border-box; width: 120px; height: 28px; margin: 0; padding: 0; border: 0; accent-color: var\(--color-accent\); -webkit-appearance: none; appearance: none; background: transparent; \}/);
  // 返工 1 对照稿子：轨道 2px 高/圆角 1，滑块 24×12 横向胶囊圆角 6，颜色走 token。
  assert.match(css, /\.topbar-size-slider::-\webkit-slider-runnable-track \{ height: 2px; border-radius: var\(--radius-xs\); background: var\(--color-border-subtle\); \}/);
  assert.match(css, /\.topbar-size-slider::-\webkit-slider-thumb \{ -webkit-appearance: none; appearance: none; width: 24px; height: 12px; margin-top: calc\(var\(--sp-1\) \* -1\); border-radius: var\(--radius-sm\); background: var\(--color-accent\); \}/);
  // 窄档（≤767px）只隐藏前进/后退与滑杆（任务 70 返工：不再整组隐藏）。
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?\.mosa-v2 \.topbar-nav-group \.nav-history-button, \.mosa-v2 \.topbar-size-group \{ display: none; \}/);
  // 窄屏规则不得出现堆叠返回按钮：任务 123 后它在页面里已不存在，窄屏「在
  // 堆叠里」的退出按钮是露出的后退键（剥掉注释只看规则）。
  const narrowAt = css.indexOf("@media (max-width: 767px)");
  assert.ok(narrowAt > -1, "the narrow-screen media query must exist");
  let narrowDepth = 0;
  let narrowEnd = -1;
  for (let i = css.indexOf("{", narrowAt); i < css.length; i += 1) {
    if (css[i] === "{") narrowDepth += 1;
    if (css[i] === "}") {
      narrowDepth -= 1;
      if (narrowDepth === 0) { narrowEnd = i + 1; break; }
    }
  }
  const narrowRules = css.slice(narrowAt, narrowEnd).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(narrowRules, /#stackBack/, "the narrow-screen rules must not reference the deleted stack-back button");
  // 任务 123：窄屏在堆叠里（body[data-in-stack]）只露出后退按钮（=退出堆叠），
  // 前进仍隐藏；不在堆叠里两个都照旧隐藏。
  assert.match(narrowRules, /body\[data-in-stack="true"\]\.mosa-v2 \.topbar-nav-group #navHistoryBack \{ display: inline-grid; \}/,
    "in a stack the narrow viewport must reveal the back button (it exits the stack)");
  // 排序框：约 96 宽、高 32（既有规则）、左内边距 12、浅色底 #f4f4f5。
  assert.match(css, /\.mosa-v2 \.sort-control select \{ min-width: 88px; padding: 0 var\(--sp-6\) 0 var\(--sp-3\); \}/);
  assert.match(css, /\.mosa-v2 \.toolbar-filter, \.mosa-v2 \.toolbar-icon, \.mosa-v2 \.sort-control select \{ height: 32px;/);
  // 任务 70 返工 1（设计稿还原）：顶栏右侧控件压到 24 高——只限 .topbar-actions
  // 范围，共用 32px 规则和顶栏以外用到这些类的地方不动。
  assert.match(css, /\.mosa-v2 \.topbar-actions \.toolbar-filter, \.mosa-v2 \.topbar-actions \.toolbar-icon, \.mosa-v2 \.topbar-actions \.sort-control select, \.mosa-v2 \.topbar-actions \.topbar-search \{ height: 24px; \}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.sort-control select \{ background: #f4f4f5; \}/);
  // 搜索框：宽 152、高 24（--control-sm，规范表 v1 32→24）、浅色底 #f4f4f5。
  assert.match(css, /\.mosa-v2 \.topbar-search \{ flex: 0 1 144px; width: 144px; \}/);
  assert.match(css, /\.topbar-search \{ display: flex; box-sizing: border-box; min-width: 0; flex: 0 1 256px; align-items: center; gap: var\(--sp-2\); width: 256px; height: var\(--control-sm\);/);
  assert.match(css, /--control-sm: 24px;/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.topbar-search \{ background: #f4f4f5; \}/);
});

test("no comment in web styles closes early and swallows the next rule", async () => {
  // A comment like "/* … --sp-*/--radius-* */" ends at the first "*/" and turns
  // the rest into a selector that drops the following rule (task 107 lost the
  // Inspector colour tokens this way). Strip comments the way CSS does and
  // require that no stray closer is left behind.
  const css = await readWebCss();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stray = stripped.indexOf("*/");
  assert.equal(stray, -1, `stray comment closer near: ${JSON.stringify(stripped.slice(Math.max(0, stray - 60), stray + 4))}`);
});
