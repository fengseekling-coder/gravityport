// GravityPort A3 顶栏契约（任务 70）：三段结构（左=后退/前进+堆叠返回、
// 中=绝对居中的缩略图大小滑杆、右=分类/排序/搜索+上下文按钮）、类型筛选
// 从顶栏移除且不得回来、#viewTitle 视觉隐藏但保留读屏语义、滑杆规格与
// 本地存储键、--gallery-columns 驱动画廊列数（>767px 由计算接管，≤767px
// 固定 2 列）、新 i18n 键中英文、列数计算函数对几组宽度的结果。
// 只读 web/app/ 源码；列数函数通过源码切片 + new Function 求值。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readIndexHtml = () => readFile(resolve(root, "web/app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");

function topbarBlock(html) {
  const start = html.indexOf('<header class="topbar"');
  const end = html.indexOf("</header>", start);
  assert.ok(start > -1 && end > start, "topbar header must exist");
  return html.slice(start, end);
}

test("topbar three segments: nav group → centered size group → actions", async () => {
  const topbar = topbarBlock(await readIndexHtml());
  const contextAt = topbar.indexOf('class="topbar-context"');
  const sizeAt = topbar.indexOf('class="topbar-size-group"');
  const actionsAt = topbar.indexOf('class="topbar-actions"');
  assert.ok(contextAt > -1 && sizeAt > contextAt && actionsAt > sizeAt, "DOM order must be context → size group → actions");
  // 左：后退、前进两个图标按钮，28×28（.toolbar-icon 基类 + nav-history-button）。
  assert.match(topbar, /<button class="toolbar-icon nav-history-button" id="navHistoryBack" type="button" disabled/);
  assert.match(topbar, /<button class="toolbar-icon nav-history-button" id="navHistoryForward" type="button" disabled/);
  // 中：滑杆组初始隐藏（JS 量重叠后决定显隐），带 − / 滑轨 / + 。
  assert.match(topbar, /<div class="topbar-size-group" id="topbarSizeGroup" hidden>/);
  assert.match(topbar, /id="gallerySizeMinus"/);
  assert.match(topbar, /id="gallerySizeSlider"/);
  assert.match(topbar, /id="gallerySizePlus"/);
  // 右：work 组顺序分类 → 排序 → 搜索；primary 组保留清空回收站与打开检视器。
  const work = topbar.slice(topbar.indexOf('class="topbar-work-group"'), topbar.indexOf('class="topbar-primary-group"'));
  const positions = ['id="categorySelect"', 'id="sortSelect"', 'id="searchInput"'].map((marker) => work.indexOf(marker));
  assert.ok(positions.every((at) => at > -1) && positions[0] < positions[1] && positions[1] < positions[2], "work group must read category → sort → search");
  const primary = topbar.slice(topbar.indexOf('class="topbar-primary-group"'));
  assert.ok(primary.includes('id="emptyTrashBtn"') && primary.includes('id="openInspectorBtn"'), "context buttons stay last on the right");
});

test("type filters are gone from the topbar and must not come back", async () => {
  const html = await readIndexHtml();
  const topbar = topbarBlock(html);
  assert.equal(topbar.includes("topbar-type-filters"), false, "no .topbar-type-filters group in the topbar");
  assert.equal(topbar.includes('class="type-filter'), false, "no .type-filter buttons in the topbar");
  // mediaKind 状态与后端语义保留：app.mjs 仍容忍容器缺失（?.），reset 仍复位 all。
  const app = await readApp();
  assert.match(app, /typeFilters: document\.querySelector\("\.topbar-type-filters"\)/);
  assert.match(app, /els\.typeFilters\?\.addEventListener/);
  assert.match(app, /function renderTypeFilters\(\) \{\n  els\.typeFilters\?\.querySelectorAll/);
  // CSS 规则删干净（dead-code 门同样会拦没标记消费的类）。
  const css = await readCss();
  assert.doesNotMatch(css, /\.type-filter|\.topbar-type-filters/);
});

test("#viewTitle stays in the DOM, visually hidden, still readable by screen readers", async () => {
  const html = await readIndexHtml();
  const topbar = topbarBlock(html);
  assert.match(topbar, /<div class="title-row visually-hidden"><h2 id="viewTitle">/);
  const css = await readCss();
  const hidden = css.indexOf(".visually-hidden { position: absolute;");
  assert.ok(hidden > -1, "the shared .visually-hidden utility must exist");
  // 旧的手写 clip 例外规则（:has(#stackBack...) 解除隐藏）必须删干净。
  assert.doesNotMatch(css, /title-row:has\(#stackBack/);
  // app.mjs 仍写 #viewTitle 内容（读屏读到当前范围）。
  const app = await readApp();
  assert.match(app, /els\.viewTitle\.textContent =/);
});

test("size slider spec: 120–400, step 20, default 200, storage key mosa.gallery-card-size", async () => {
  const html = await readIndexHtml();
  assert.match(html, /<input class="topbar-size-slider" id="gallerySizeSlider" type="range" min="120" max="400" step="20" value="200" data-i18n-aria-label="thumbSize" aria-label="缩略图大小" \/>/);
  const app = await readApp();
  assert.match(app, /const GALLERY_SIZE_STORAGE_KEY = "mosa\.gallery-card-size";/);
  assert.match(app, /const GALLERY_SIZE_MIN = 120;/);
  assert.match(app, /const GALLERY_SIZE_MAX = 400;/);
  assert.match(app, /const GALLERY_SIZE_STEP = 20;/);
  assert.match(app, /const GALLERY_SIZE_DEFAULT = 200;/);
  assert.match(app, /const GALLERY_MAX_COLUMNS = 10;/);
  assert.match(app, /let galleryTargetCardWidth = clampGalleryCardSize\(safeStorageGet\(GALLERY_SIZE_STORAGE_KEY\)\)/, "the stored size is restored at startup");
  assert.match(app, /els\.gallerySizeSlider\?\.addEventListener\("input", \(event\) => applyGalleryCardSize\(event\.target\.value, \{ persist: true \}\)\)/);
  assert.match(app, /applyGalleryCardSize\(galleryTargetCardWidth - GALLERY_SIZE_STEP, \{ persist: true \}\)/);
  assert.match(app, /applyGalleryCardSize\(galleryTargetCardWidth \+ GALLERY_SIZE_STEP, \{ persist: true \}\)/);
});

test("--gallery-columns drives the v2 grid and skeleton; width-based bands are gone", async () => {
  const css = await readCss();
  assert.match(css, /--gallery-columns: 5;/, "the CSS default must be defined (first paint before JS)");
  assert.match(css, /\.mosa-v2 \.grid \{ grid-template-columns: repeat\(var\(--gallery-columns\), minmax\(0, 1fr\)\);/);
  assert.match(css, /\.mosa-v2 \.gallery-skeleton \{ grid-template-columns: repeat\(var\(--gallery-columns\), minmax\(0, 1fr\)\);/);
  // >767px 的按宽度减列档（≤1400→4、≤900→3、≥1280→5、≤1279→3）由计算接管。
  assert.doesNotMatch(css, /@media \(min-width: 1280px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 1279px\)/);
  assert.doesNotMatch(css, /@media \(max-width: 1400px\) \{ \.mosa-v2 \.grid/);
  assert.doesNotMatch(css, /@media \(max-width: 900px\) \{ \.mosa-v2 \.grid/);
  // ≤767px 档固定 2 列不变（行内变量改不了它）。
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?\.mosa-v2 \.grid, \.mosa-v2 \.gallery-skeleton \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  // 窄档只隐藏前进/后退与滑杆；任务 123 后页面里没有堆叠返回按钮，堆叠里的
  // 窄屏退出由 r21-shell 的「堆叠里露出后退键」断言锁。
  assert.match(css, /@media \(max-width: 767px\) \{[\s\S]*?\.mosa-v2 \.topbar-nav-group \.nav-history-button, \.mosa-v2 \.topbar-size-group \{ display: none; \}/);
  // JS 侧：列数写进 #assetGrid 行内；画廊宽度变化（ResizeObserver）、检视器
  // 开关、滑杆变化都会重算；列数变化后走 scheduleMasonryLayout 重排。
  const app = await readApp();
  assert.match(app, /grid\.style\.setProperty\("--gallery-columns", String\(next\)\);/);
  assert.match(app, /syncGalleryColumns\(\);\n      scheduleMasonryLayout\(\);/, "the grid ResizeObserver recomputes columns before relayout");
  assert.match(app, /syncGalleryColumns\(\);\n  syncGallerySizeGroupVisibility\(\);/, "setDetailOpen recalculates columns and slider visibility");
  assert.match(app, /masonryResizeObserver = new ResizeObserver\(\(entries\) => \{[\s\S]*?syncGalleryColumns\(\);/);
  // 滑杆组重叠隐藏由 JS 写 hidden；≤767 由 CSS 兜底。
  assert.match(app, /function syncGallerySizeGroupVisibility\(\)/);
  assert.match(app, /window\.addEventListener\("resize", \(\) => \{ syncMobileNavigation\(\); syncGallerySizeGroupVisibility\(\);/);
});

test("computeGalleryColumnCount: floor((content+gap)/(target+gap)), clamp 1..10", async () => {
  const app = await readApp();
  const marker = "export function computeGalleryColumnCount(contentWidth, targetCardWidth, gap, maxColumns = GALLERY_MAX_COLUMNS)";
  const start = app.indexOf(marker);
  assert.ok(start > -1, "computeGalleryColumnCount must be exported for this contract");
  const open = app.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    if (app[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  // 与 theme-init / userCenterInitial 同款手法：切片 + new Function 在无 DOM 的 Node 里求值。
  // 默认参数引用模块常量 GALLERY_MAX_COLUMNS，求值作用域里按源码值补上。
  const fn = new Function(`const GALLERY_MAX_COLUMNS = 10; ${marker.replace("export ", "")} ${app.slice(open, end)}; return computeGalleryColumnCount;`)();
  assert.equal(typeof fn, "function");
  // 1440 宽、检视器关：内容宽 1440-280-2×20=1120、间距 4（返工 1 稿子值）、
  // 目标 200 → 5 列。
  assert.equal(fn(1120, 200, 4), 5);
  // 检视器开（320）：内容宽 800 → 3 列。
  assert.equal(fn(800, 200, 4), 3);
  // 1024 宽：内容宽 1024-280-40=704 → 3 列。
  assert.equal(fn(704, 200, 4), 3);
  // 滑杆两端：120 → 9 列；400 → 2 列。
  assert.equal(fn(1120, 120, 4), 9);
  assert.equal(fn(1120, 400, 4), 2);
  // 上限 10：超宽内容也封顶。
  assert.equal(fn(3000, 120, 4), 10);
  // 下限 1 与退化输入。
  assert.equal(fn(200, 200, 4), 1);
  assert.equal(fn(0, 200, 4), 1);
  assert.equal(fn(-10, 200, 4), 1);
  assert.equal(fn(1120, 0, 4), 1);
});

test("computeTopbarSizeGroupPlacement: window-centered → recentered → hidden, 12px breathing margins", async () => {
  const app = await readApp();
  const marker = "export function computeTopbarSizeGroupPlacement(centerX, leftGroupRight, rightGroupLeft, groupWidth, margin = TOPBAR_SIZE_GROUP_MARGIN)";
  const start = app.indexOf(marker);
  assert.ok(start > -1, "computeTopbarSizeGroupPlacement must be exported for this contract");
  const open = app.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < app.length; i += 1) {
    if (app[i] === "{") depth += 1;
    if (app[i] === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  // 与 computeGalleryColumnCount 同款手法：切片 + new Function 无 DOM 求值。
  const fn = new Function(`const TOPBAR_SIZE_GROUP_MARGIN = 12; ${marker.replace("export ", "")} ${app.slice(open, end)}; return computeTopbarSizeGroupPlacement;`)();
  assert.equal(typeof fn, "function");
  // 宽敞：窗口中线放得下 → centered，left=centerX（窗口中线在顶栏坐标系里的
  // 位置；检视器开着时顶栏中线 ≠ 窗口中线，所以居中也要写行内 left）。
  assert.deepEqual(fn(680, 84, 903, 192), { mode: "centered", left: 680 });
  // 正好 12px 呼吸边距也算放得下（>= 判定）：居中占 [114,306]，左右缘 102/318。
  assert.deepEqual(fn(210, 102, 318, 192), { mode: "centered", left: 210 });
  // 差 1px 就不算：居中右缘 306 撞上呼吸边距 305 → 退让到左右两组之间的
  // 空白居中，left = 空白中点（12px 只参与放不放得下，不改变中点）。
  assert.deepEqual(fn(210, 101, 317, 192), { mode: "recentered", left: 209 });
  assert.deepEqual(fn(600, 60, 300, 192), { mode: "recentered", left: 180 });
  // 空白正好 = 组宽 + 24：退让仍放得下（>= 边界）。
  assert.deepEqual(fn(600, 60, 276, 192), { mode: "recentered", left: 168 });
  // 空白 < 组宽 + 24：隐藏。
  assert.deepEqual(fn(600, 60, 275, 192), { mode: "hidden", left: null });
  // 测量缺失/退化（centerX NaN、零宽、右缘跑到左缘左边）一律隐藏。
  assert.deepEqual(fn(NaN, 60, 300, 192), { mode: "hidden", left: null });
  assert.deepEqual(fn(600, 60, 300, 0), { mode: "hidden", left: null });
  assert.deepEqual(fn(600, NaN, 300, 192), { mode: "hidden", left: null });
  assert.deepEqual(fn(600, 60, NaN, 192), { mode: "hidden", left: null });
  assert.deepEqual(fn(600, 300, 60, 192), { mode: "hidden", left: null });
});

test("nav history i18n keys exist in both locales; slider buttons are named", async () => {
  const { default: translations } = await import(await import("node:url").then((mod) => mod.pathToFileURL(resolve(root, "web/app/i18n.mjs")).href));
  assert.equal(translations.zh.navHistoryBack, "后退");
  assert.equal(translations.en.navHistoryBack, "Back");
  assert.equal(translations.zh.navHistoryForward, "前进");
  assert.equal(translations.en.navHistoryForward, "Forward");
  assert.equal(translations.zh.thumbSize, "缩略图大小");
  assert.equal(translations.en.thumbSize, "Thumbnail size");
  assert.equal(translations.zh.thumbSizeDecrease, "缩小缩略图");
  assert.equal(translations.en.thumbSizeDecrease, "Smaller thumbnails");
  assert.equal(translations.zh.thumbSizeIncrease, "放大缩略图");
  assert.equal(translations.en.thumbSizeIncrease, "Larger thumbnails");
});

test("nav history wiring: snapshots, restore through applyFilterChange, shortcuts, stack guard", async () => {
  const app = await readApp();
  // 快照内容：scope + facets 拷贝 + mediaKind + 搜索词（分类在 facets 里）；
  // 任务 123：堆叠也算位置的一部分（stackId），「根位置」与「同一根位置+堆叠」
  // 是两条记录。
  assert.match(app, /function captureNavigationSnapshot\(\) \{\n  return \{\n    scope: state\.scope,\n    facets: \{ \.\.\.state\.facets \},\n    mediaKind: state\.mediaKind,\n    query: state\.query,\n    stackId: state\.activeStackId \|\| "",\n  \};\n\}/);
  // 恢复：同步搜索框 → 走现有 applyFilterChange 流程 → 不产生新记录。
  const restore = app.slice(app.indexOf("function restoreNavigationSnapshot"), app.indexOf("async function navigateGalleryHistory"));
  assert.match(restore, /if \(els\.searchInput\) els\.searchInput\.value = state\.query;/);
  assert.match(restore, /applyFilterChange\(\);/);
  assert.doesNotMatch(restore, /navHistory\.push|recordNavigationPosition/, "restoring must not record");
  // 恢复前先过 beginNavigationIntent / authorizeNavigationIntent（未保存编辑先确认）。
  const navigate = app.slice(app.indexOf("async function navigateGalleryHistory"), app.indexOf("function resolveNavHistoryShortcut"));
  assert.match(navigate, /navHistory\.peekBack\(\)|navHistory\.peekForward\(\)/);
  assert.match(navigate, /const intent = beginNavigationIntent\(\);/);
  assert.match(navigate, /await authorizeNavigationIntent\(intent\)/);
  // 记录点：侧栏入口（setFilter）、搜索防抖提交、分类下拉、清除搜索、
  // 清除筛选、同对话/同一批次；排序（sortSelect change）不记。
  assert.equal(app.split("recordNavigationPosition();").length - 1 >= 6, true, "every approved navigation site records once");
  const sortHandler = app.slice(app.indexOf('els.sortSelect?.addEventListener("change"'), app.indexOf('els.detailPanel?.addEventListener("click"'));
  assert.doesNotMatch(sortHandler, /recordNavigationPosition/, "sort changes are not browse positions");
  // 任务 123：堆叠里后退=退出堆叠（经 exitStack 恢复根快照并统一登记光标，
  // 不走 restoreNavigationSnapshot 重新加载），前进在堆叠里不可用。
  assert.match(app, /if \(state\.activeStackId\) \{\n    \/\/ 堆叠里只有后退有意义（前进按钮此时是灰的）。\n    if \(direction >= 0\) return false;\n    \/\/ [^\n]*\n    if \(assetStacks\.isBusy\(\)\) return false;\n    return Boolean\(await assetStacks\.exitStack\(\)\);\n  \}/,
    "in a stack the shortcut obeys the same busy rule as the disabled back button");
  // 前进重进堆叠前必须确认根画廊没有请求在途：galleryStatus 启动后不再回到
  // "loading"，重载只体现在 #assetGrid 的 aria-busy 上。
  assert.match(app, /function isRootGalleryLoading\(\) \{\n  return state\.galleryStatus === "loading" \|\| els\.assetGrid\?\.getAttribute\("aria-busy"\) === "true";\n\}/);
  assert.match(app, /if \(direction > 0 && entry\.stackId\) \{[\s\S]{0,200}?if \(isRootGalleryLoading\(\) \|\| assetStacks\.isBusy\(\)\) return false;/);
  assert.match(app, /const inStack = Boolean\(state\.activeStackId\);/);
  // 快捷键：macOS ⌘[ / ⌘]，其他平台 Alt+← / Alt+→。
  assert.match(app, /function resolveNavHistoryShortcut\(event\)/);
  assert.match(app, /const navHistoryDirection = resolveNavHistoryShortcut\(event\);/);
  // 只存内存：历史模块不写本地存储。
  const module = await readFile(resolve(root, "web/app/navigation-history.mjs"), "utf8");
  assert.equal((module.match(/safeStorage|localStorage/g) || []).length, 0, "navigation history stays in memory");
});
