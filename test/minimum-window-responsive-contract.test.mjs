// Phase 6A / F-10 / F-20（960×640 部分）：桌面最小窗口与 960×640 响应式守护契约。
// 任务书 42 项契约点映射见 docs/ui-audit/33-phase-6a-minimum-window-results.md §25。
// 原则：Node 标准库、无网络、行为契约优先；不以整文件 SHA 代替产品行为契约
// （SHA 仅用于锁定 package.json / package-lock.json 不新增依赖这一卫生项）。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const sources = {};
async function source(relativePath) {
  if (!sources[relativePath]) sources[relativePath] = await read(relativePath);
  return sources[relativePath];
}

test("1-2. BrowserWindow minWidth=960 且 minHeight=640（F-10 单次授权范围）", async () => {
  const main = await source("desktop/main.mjs");
  assert.match(main, /minWidth: 960,/);
  assert.match(main, /minHeight: 640,/);
  // 旧批准值以下的最小尺寸不得残留。
  assert.doesNotMatch(main, /minWidth: 900,/);
  assert.doesNotMatch(main, /minHeight: 600,/);
});

test("3. 不在 renderer 中模拟窗口最小值", async () => {
  const appJs = await source("web/app/app.mjs");
  const index = await source("web/app/index.html");
  const styles = await source("web/app/styles.css");
  // renderer 不得用 resizeTo/resizeBy 或任何内视口钳制模拟桌面窗口最小尺寸。
  assert.doesNotMatch(appJs, /window\.resizeTo\(|window\.resizeBy\(/);
  assert.doesNotMatch(appJs, /Math\.max\(\s*960/);
  assert.doesNotMatch(appJs, /simulateMinWindow|min-window-sim/);
  // 不用 CSS min-width 代替桌面窗口约束（html/body 不设 960px 最小宽度）。
  assert.doesNotMatch(styles, /(html|body)[^{]*\{[^}]*min-width:\s*9[0-9][0-9]px/s);
  assert.doesNotMatch(index, /min-width:\s*960/);
});

test("4. 不增加 resize watchdog / setBounds 强制", async () => {
  const main = await source("desktop/main.mjs");
  assert.doesNotMatch(main, /on\("resize"/);
  assert.doesNotMatch(main, /setBounds\(/);
  assert.doesNotMatch(main, /watchdog/i);
});

test("5-6. 初始窗口尺寸不低于批准的最小值", async () => {
  const main = await source("desktop/main.mjs");
  const match = main.match(/DEFAULT_BOUNDS = \{ width: (\d+), height: (\d+) \}/);
  assert.ok(match, "DEFAULT_BOUNDS literal must remain declarative");
  assert.ok(Number(match[1]) >= 960, `initial width ${match[1]} >= minWidth 960`);
  assert.ok(Number(match[2]) >= 640, `initial height ${match[2]} >= minHeight 640`);
});

test("7-9. preload 路径与安全 WebPreferences 不变", async () => {
  const main = await source("desktop/main.mjs");
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
});

test("10-11. 退役 Finder IPC 保持移除且其余 Desktop IPC 不变", async () => {
  const main = await source("desktop/main.mjs");
  const preload = await source("desktop/preload.cjs");
  assert.doesNotMatch(main, /ipcMain\.handle\("show-item-in-folder",/);
  assert.doesNotMatch(preload, /showItemInFolder|show-item-in-folder/);
  // 手动导入已统一走 renderer 文件选择 + 本地 staging；其余既有 IPC 通道保持不变。
  assert.doesNotMatch(main, /ipcMain\.handle\("open-file-dialog"/);
  assert.doesNotMatch(preload, /ipcRenderer\.invoke\("open-file-dialog"\)/);
  for (const channel of ["paste-image", "set-locale"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`));
  }
  // 更新检查、下载安装都不接受 renderer 提供的 URL；其余能力仍保持封闭。
  // 任务 96（A6）：第 18 条批准通道 set-window-full-screen（大图页全屏与窗口系统全屏同步）。
  // 任务 116：第 19/20 条 rename-notice-state / acknowledge-rename-notice（老用户「已更名」提示）。
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 20, "no invoke channel beyond the currently approved narrow requests, including the Visual Pack lifecycle");
});

test("12-14. 960 下 Sidebar 批准收敛规则与搜索可达", async () => {
  const styles = await source("web/app/styles.css");
  const index = await source("web/app/index.html");
  // 701–1120 图标栏收敛（960×640 落在该区间）仍是批准的唯一紧凑档。
  assert.match(styles, /@media \(min-width: 701px\) and \(max-width: 1120px\)/);
  assert.match(styles, /\.shell\.details-open \.nav-item-text,/);
  // V2 FilterBar：唯一搜索框位于顶栏右侧，仍是同一个 #searchInput。
  assert.match(index, /<div class="topbar-search">/);
  assert.match(index, /id="searchInput"/);
  // 顶栏搜索的焦点态规则保留。
  assert.match(styles, /\.topbar-search:focus-within \{/);
});

test("15-16. 960 下 Viewer shell 与舞台契约", async () => {
  const styles = await source("web/app/styles.css");
  // .asset-view 保持 flex 互斥布局（hidden 才退出），不在紧凑档新增隐藏规则。
  assert.match(styles, /\.asset-view\[hidden\] \{ display: none; \}/);
  assert.match(styles, /\.asset-view \{ display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; overflow: hidden;/);
  // 舞台收缩链：min-width:0 + overflow:hidden，不被 Inspector 挤死也不外溢。
  assert.match(styles, /\.asset-view-stage \{ position: relative; display: flex; min-width: 0; min-height: 0; flex: 1;/);
});

test("17-18. Inspector 独立滚动且宽度不超批准范围", async () => {
  const styles = await source("web/app/styles.css");
  assert.match(styles, /\.detail-inspector-scroll \{ position: relative; flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; \}/);
  // 批准宽度：宽屏 280px（GravityPort，token 值由 web-r21-inspector-head 锁定）/
  // 紧凑 280px，均来自 Token 且未出现更大值（规范表 v1：检视器 320→280）。
  assert.match(styles, /--inspector-width-compact: 280px;/);
  assert.match(styles, /\.shell\.details-open \{[^}]*var\(--inspector-width\)/s);
  assert.doesNotMatch(styles, /--inspector-width[^:]*:\s*3[7-9]\dpx|--inspector-width[^:]*:\s*[4-9]\d\dpx/);
});

test("19-21. Return / Prev / Next / Fit 控件可见契约（A4c 改版后）", async () => {
  const index = await source("web/app/index.html");
  const styles = await source("web/app/styles.css");
  // 任务 90：返回 + 左右翻页箭头 + 右上动作组；位置计数/缩放控制条按稿子移除，
  // 适合窗口沿用 #assetZoomFit（动作按钮 24px 高）。
  assert.match(index, /id="assetViewBack"/);
  assert.match(index, /id="assetViewPrev"/);
  assert.match(index, /id="assetViewNext"/);
  assert.match(index, /id="assetZoomFit"/);
  assert.match(index, /id="assetViewDelete"/);
  assert.match(index, /id="assetViewFullscreen"/);
  assert.match(styles, /\.asset-view-back \{ min-width: 0;/);
  assert.match(styles, /\.asset-view-arrow \{ position: absolute;/);
  assert.match(styles, /\.asset-view-action \{ display: inline-flex;/);
});

test("22-24. Inspector A4a 六区块顺序：File/Tags/Palette/Prompt/Reference/Version", async () => {
  const appJs = await source("web/app/app.mjs");
  const inspector = await source("web/app/inspector-markup.mjs");
  const compositionStart = appJs.indexOf('const scroller = renderDetailInspectorContent(t("assetInspector"), `${detailFileSectionMarkup(asset)}');
  const template = appJs.slice(compositionStart, appJs.indexOf(";", compositionStart) + 1);
  assert.notEqual(compositionStart, -1, "asset content is composed into the persistent inspector scroller");
  assert.match(template, /\$\{detailFileSectionMarkup\(asset\)\}\$\{detailTagsSectionMarkup\(asset\)\}/, "File and Tags enter the scroll column directly");
  const order = [
    "detailFileSectionMarkup",
    "detailTagsSectionMarkup",
    "detailPaletteSectionMarkup",
    "detailPromptSectionMarkup",
    "detailReferenceSectionMarkup",
    "detailVersionContextSectionMarkup",
  ];
  let cursor = 0;
  for (const markup of order) {
    const position = template.indexOf(markup, cursor);
    assert.notEqual(position, -1, `${markup} present in inspector template`);
    cursor = position;
  }
  // GravityPort A4a：版本树与上下文收尾；配方/来源/分组/图片位置区块不得回来。
  for (const retired of ["detailSourceSectionMarkup", "detailGroupSectionMarkup", "detailMoreSectionMarkup"]) {
    assert.ok(!template.includes(retired), `${retired} must not come back to the scroll column`);
  }
  // data-inspector-section 标记与顺序一致（version-overlay 是浮层内容壳）。
  assert.match(inspector, /data-inspector-section="version-overlay"/);
});

test("25. body/document 不设置造成水平滚动的固定宽度", async () => {
  const styles = await source("web/app/styles.css");
  assert.doesNotMatch(styles, /body\s*\{[^}]*width:\s*\d+px/s);
  assert.doesNotMatch(styles, /html\s*\{[^}]*width:\s*\d+px/s);
  // 不以 body overflow-x:hidden 掩盖横向溢出（Phase 2C 守护 #14 延续）。
  assert.doesNotMatch(styles, /body\s*\{[^}]*overflow-x:\s*hidden/s);
});

test("26. 断点必须属于已登记的 V2 响应式设计区间", async () => {
  const styles = await source("web/app/styles.css");
  // 只审计 @media 媒体查询中的宽度边界，不扫组件级 width/max-width 声明。
  const mediaQueries = [...styles.matchAll(/@media[^{]+\{/g)].map((match) => match[0]);
  const boundaryValues = [];
  for (const query of mediaQueries) {
    boundaryValues.push(...[...query.matchAll(/(?:min|max)-width:\s*(\d+)px/g)].map((match) => Number(match[1])));
  }
  // 1279/767 come from the supplied Library v2 reference: five columns at
  // 1280+, three columns at 768–1279, and a two-column drawer layout below.
  // 839 是 R21 设置弹窗窄窗档（任务 25，≤840px 收成单列）。
  const allowed = new Set([1400, 1399, 1280, 1279, 1120, 900, 839, 767, 701, 700, 480]);
  for (const width of boundaryValues) {
    assert.ok(allowed.has(width), `media query boundary ${width}px must belong to the registered breakpoint set`);
  }
  for (const magic of [959, 961, 1119, 1121]) {
    assert.equal(boundaryValues.includes(magic), false, `no magic ${magic}px breakpoint`);
  }
});

test("27. 959 Web fallback 保持（Electron 钳制 960 之外 Web 仍回退）", async () => {
  const styles = await source("web/app/styles.css");
  const assetView = await source("web/app/asset-view.mjs");
  // 959 落在 701–1120 图标栏区间：收敛规则在 959 继续生效，无独立 959 断点。
  assert.match(styles, /@media \(min-width: 701px\) and \(max-width: 1120px\)/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*body \{ overflow: auto; \}/);
  // 滚动容器 helper 继续处理 ≤959 文档级滚动回退（Return Snapshot 正确性的前提）。
  assert.match(assetView, /getLibraryScrollContainer/);
  assert.match(assetView, /≤959px/);
});

test("28-30. Surface max-height / ConfirmDialog viewport-safe / Toast fixed 栈保持", async () => {
  const styles = await source("web/app/styles.css");
  // The retired filter popover is gone; the surviving settings surface remains viewport-safe.
  assert.doesNotMatch(styles, /\.filter-panel\b/);
  assert.match(styles, /\.settings-menu \{[^}]*max-height: calc\(100vh - 56px\)/);
  assert.doesNotMatch(styles, /\.anchored-overlay/);
  // ConfirmDialog：modal-overlay padding 20px + modal-card max-width/max-height 保证视口安全；
  // 任务 94 后由 overlay 收口，任务 109 起桌面态卡 420 宽、高度随内容（240 下限删除），
  // ≤767 仍由 overlay padding 16 收口（视口减两侧 16）。
  assert.match(styles, /\.modal-overlay \{ position: fixed;[^}]*padding: var\(--sp-5\);/);
  assert.match(styles, /\.modal-card \{[^}]*max-width: 100%; max-height: min\(760px, 88vh\)/);
  assert.match(styles, /\.confirm-dialog-card \{ box-sizing: border-box; width: 420px; \}/);
  assert.doesNotMatch(styles, /\.confirm-dialog-card \{[^}]*min-height/);
  assert.match(styles, /@media \(max-width: 767px\) \{[^]*?\.confirm-dialog-overlay \{ padding: var\(--sp-4\); \}/);
  // Toast：fixed 栈不扩展文档布局。
  assert.match(styles, /\.toast-stack \{ position: fixed; z-index: var\(--z-toast\);/);
  assert.match(styles, /\.toast-stack-polite \{ bottom: calc\(20px \+ var\(--toast-error-stack-height, 0px\)\); \}/);
});

test("31. F-08 空状态不退化", async () => {
  const appJs = await source("web/app/app.mjs");
  assert.match(appJs, /gallery-empty-state/);
  assert.match(appJs, /data-empty-kind=/);
  assert.match(appJs, /empty-state-actions/);
});

test("32-34. Phase 5 Confirm / Toast 契约测试文件不退化", async () => {
  const confirm = await source("test/confirm-dialog-contract.test.mjs");
  const toast = await source("test/toast-manager-contract.test.mjs");
  assert.match(confirm, /confirmDialog/);
  assert.match(toast, /createToastManager/);
  // Phase 5C 校正登记：test block 覆盖全部契约点（任务 96 追加类型图标点后 19 块）。
  const toastBlocks = toast.split(/test\(/).length - 1;
  assert.equal(toastBlocks, 19, "toast contract keeps its test blocks (60 Phase 5C points + task 96 per-type icon)");
});

test("35-37. Viewer Navigation / Transform / Return Snapshot 不退化", async () => {
  const appJs = await source("web/app/app.mjs");
  const assetView = await source("web/app/asset-view.mjs");
  // 35 Navigation：稳定序列 + 边界禁用（BUG-10 扩展 session 持有总数/游标/快照）。
  assert.match(assetView, /const assetViewSequence = \{\n\s+ids: \[\], index: -1, requestKey: "",\n\s+total: 0, nextCursor: null, loading: false, generation: 0,\n\s+snapshot: null,\n\s*\};/);
  assert.match(assetView, /setAssetViewControlDisabled\(els\.assetViewPrev, !canNavigateAssetView\(-1\)\)/);
  assert.match(appJs, /els\.assetViewPrev\?\.addEventListener\("click", \(\) => navigateAssetView\(-1\)\)/);
  // 36 Transform：统一 transform 应用点与拖拽禁用契约保持。
  assert.match(assetView, /function applyAssetViewTransform\(\)/);
  const index = await source("web/app/index.html");
  assert.match(index, /id="assetViewImage"[^>]*draggable="false"/);
  // 37 Return Snapshot：四字段最小集合保持。
  assert.match(assetView, /state\.libraryReturnSnapshot = \{\n\s+scrollTop: getLibraryScrollContainer\(\)\.scrollTop,\n\s+focusedAssetId:/);
  assert.match(assetView, /selectedAssetId: state\.selectedId,\n\s+requestKey: assetRequestKey\(currentAssetRequest\(\)\)/);
});

test("38. Inspector IA V2 七项 section 标记全在且唯一", async () => {
  const inspector = await source("web/app/inspector-markup.mjs");
  const sections = ["file", "prompt", "source", "version", "group", "tags", "more"];
  for (const section of sections) {
    assert.equal(
      inspector.split(`data-inspector-section="${section}"`).length - 1,
      1,
      `inspector section "${section}" rendered exactly once`,
    );
  }
  assert.doesNotMatch(inspector, /data-inspector-section="new-version"|data-action="save-version"/);
});

// 39. 2026-09-04：App/Web 原图能力入口已从检视器移除（右键菜单保留 Finder 与复制路径）。
test("39. App/Web 原图能力入口保持移除", async () => {
  const inspector = await source("web/app/inspector-markup.mjs");
  assert.doesNotMatch(inspector, /typeof window\.electronAPI\?\.showItemInFolder === "function" && imagePath\) return "desktop-finder"/);
  assert.doesNotMatch(inspector, /original-media-link/);
});

test("40-41. package 与 lockfile 不变、无新依赖", async () => {
  const pkg = await source("package.json");
  const lock = await source("package-lock.json");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac");
  assertPackageLockMatchesManifest(lock, manifest);
});

// 42. 任务 96（A6）：701–1120 详情打开时顶栏过订修复——动作组/排序下拉/搜索框可收缩
// （select 88 下限、搜索框 38 图标入口下限），聚焦浮成 fixed 面板且右缘让开检视器。
test("42. 紧凑档详情打开时顶栏搜索收缩与浮动面板", async () => {
  const styles = await source("web/app/styles.css");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.topbar-actions,\n  \.mosa-v2 \.shell\.details-open \.topbar-work-group \{ flex: 0 1 auto; min-width: 0; \}/, "action groups participate in shrinking");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.sort-control \{ flex: 0 1 auto; min-width: 100px; \}/, "select labels shrink with a 100px floor so four CJK characters stay readable");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.sort-control select \{ width: 100%; min-width: 0; \}/, "selects fill their label so they never spill over neighbours");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.topbar-search \{ flex: 0 1 144px; width: auto; min-width: 38px; position: relative; \}/, "search shrinks to a 38px icon entry at worst");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.topbar-search input \{ position: absolute; inset: 0; width: 100%; height: 100%; \}/, "input covers the collapsed entry so the panel is reachable by click");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.topbar-search input::placeholder \{ color: transparent; \}/, "collapsed entry hides the placeholder fragment next to the icon");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.topbar-search:focus-within input::placeholder \{ color: var\(--color-text-tertiary\); \}/, "floating panel restores the placeholder hint");
  const focusPanel = styles.slice(styles.indexOf(".mosa-v2 .shell.details-open .topbar-search:focus-within"));
  assert.match(focusPanel, /position: fixed;/, "focused search floats above the topbar clip");
  assert.match(focusPanel, /right: calc\(var\(--inspector-width-compact\) \+ 16px\);/, "floating panel stays clear of the docked inspector");
});

// 43. 任务 96 返工 1：701–1120 档详情打开时 V2 网格第一列收成 56 图标栏
// （.mosa-v2 层的全宽规则曾盖掉布局骨架 B 模式的紧凑列）。
test("43. 紧凑档详情打开时 V2 网格侧栏为图标栏宽度", async () => {
  const styles = await source("web/app/styles.css");
  assert.match(styles, /\/\* 任务 96 返工 1[\s\S]*?\.mosa-v2 \.shell\.details-open \{ grid-template-columns: var\(--sidebar-width-compact\) minmax\(0, 1fr\) var\(--inspector-width-compact\); \}/, "V2 grid collapses the sidebar to the icon rail with the compact inspector");
  assert.match(styles, /\.mosa-v2 \.shell\.details-open \.primary-nav,\n  \.mosa-v2 \.shell\.details-open \.sidebar-footer \{ padding-right: var\(--sp-3\); padding-left: var\(--sp-3\); \}/, "icon rail paddings shrink so icons center in 56px");
});
