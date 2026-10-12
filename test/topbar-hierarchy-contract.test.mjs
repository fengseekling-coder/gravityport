import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

// Phase 2B (F-18 / O4-A): topbar action-hierarchy contract. The workspace bar is
// split into .topbar-context (title + type filters) and .topbar-actions with three action
// groups (utility / work / primary); Import stays the single primary action; the
// bridge status is de-noised (dot + capped short label, meta visually-hidden) while
// role=status / aria-live / title / #statusText keep full state semantics; compact
// breakpoints hide visible labels via the clip pattern (never display:none on state
// semantics, never aria-hidden on whole buttons). No functional behaviour changes:
// this suite locks DOM, selectors and behaviours — not whole-file SHAs.
// Node standard library only; no network access.

const root = resolve(import.meta.dirname, "..");
const readHtml = () => readFile(resolve(root, "web/app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");

/** Extracts a `{...}` block starting at the marker, honouring nested braces. */
function extractBlock(css, marker, fromIndex = 0) {
  const start = css.indexOf(marker, fromIndex);
  assert.ok(start > -1, `block not found: ${marker}`);
  let i = start + marker.length;
  let depth = 1;
  while (depth > 0 && i < css.length) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    i += 1;
  }
  assert.equal(depth, 0, `unbalanced braces in block: ${marker}`);
  return { block: css.slice(start, i), start, end: i };
}

function topbarBlock(html) {
  const start = html.indexOf('<header class="topbar"');
  const end = html.indexOf("</header>", start);
  assert.ok(start > -1 && end > start, "topbar header must exist");
  return html.slice(start, end);
}

const CONTROL_IDS = ["bridgeStatus", "categorySelect", "sortSelect", "searchInput", "openInspectorBtn"];

// 1. The topbar exposes exactly two regions: context and actions.
// 2026-10 (GravityPort A3 / 任务 70): the V2 type filters left the topbar
// ("按稿子精简") — the context region now holds the back/forward nav group plus
// the visually-hidden view title, and a centered thumbnail-size slider group
// sits between context and actions. mediaKind state and its backend semantics
// stay; the strip must not come back.
test("1. topbar has context and actions regions; the type filters stay removed", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.split('class="topbar-context"').length - 1, 1, "exactly one .topbar-context");
  assert.equal(topbar.split('class="topbar-actions"').length - 1, 1, "exactly one .topbar-actions");
  assert.ok(topbar.indexOf('class="topbar-context"') < topbar.indexOf('class="topbar-actions"'), "context precedes actions");
  const context = /<div class="topbar-context">([\s\S]*?)<\/div>\s*<div class="topbar-size-group"/.exec(topbar);
  assert.ok(context, "context block must precede the centered size group");
  assert.ok(context[1].includes('id="viewTitle"'), "context holds the view title");
  assert.equal(topbar.includes('class="topbar-type-filters"'), false, "the V2 type filters must not return to the topbar");
  assert.equal(topbar.includes('data-type="img"'), false, "no type-filter buttons may remain in the topbar");
  const actions = topbar.slice(topbar.indexOf('class="topbar-actions"'));
  assert.equal(actions.includes('id="assetCount"'), false, "the topbar no longer renders library statistics");
});

// 1b. GravityPort A3 三段结构：左=后退/前进，中=居中缩略图滑杆，右=既有 actions。
// 任务 123：堆叠返回按钮删除——进堆叠算一步浏览历史，导航组里只有后退、前进
// 两个按钮；「在不在堆叠里」由 body[data-in-stack] 表达，不再有独立按钮。
test("1b. nav history group and centered size group flank the actions", async () => {
  const topbar = topbarBlock(await readHtml());
  const context = /<div class="topbar-context">([\s\S]*?)<\/div>\s*<div class="topbar-size-group"/.exec(topbar);
  assert.ok(context, "context block must exist");
  const navGroup = context[1];
  const backAt = navGroup.indexOf('id="navHistoryBack"');
  const forwardAt = navGroup.indexOf('id="navHistoryForward"');
  assert.ok(backAt > -1 && forwardAt > backAt, "order must be back → forward");
  assert.match(navGroup, /id="navHistoryBack"[^>]*disabled/, "back starts disabled");
  assert.match(navGroup, /id="navHistoryForward"[^>]*disabled/, "forward starts disabled");
  assert.equal(navGroup.split("<button").length - 1, 2, "the nav group holds exactly back and forward (任务 123)");
  assert.doesNotMatch(navGroup, /id="stackBack"/, "the stack-back button must stay deleted");
  const html = await readHtml();
  assert.doesNotMatch(html, /id="stackBack"/, "no stack-back button may remain anywhere in the page");
  const sizeAt = topbar.indexOf('class="topbar-size-group"');
  assert.ok(sizeAt > topbar.indexOf('class="topbar-context"') && sizeAt < topbar.indexOf('class="topbar-actions"'), "size group sits between context and actions");
  assert.match(topbar, /id="topbarSizeGroup"[^>]*hidden/, "the size group starts hidden until JS measures the overlap");
});

// 2. The actions region holds exactly the three approved groups.
test("2. actions region holds utility / work / primary groups", async () => {
  const topbar = topbarBlock(await readHtml());
  for (const group of ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"]) {
    assert.equal(topbar.split(`class="${group}"`).length - 1, 1, `exactly one .${group}`);
  }
  const order = ["topbar-utility-group", "topbar-work-group", "topbar-primary-group"].map((g) => topbar.indexOf(`class="${g}"`));
  assert.ok(order[0] < order[1] && order[1] < order[2], "group order must be utility → work → primary");
});

// 3. The utility group retains bridge live semantics only. Theme switching is
// owned by Settings so the gallery topbar does not duplicate the control.
test("3. utility group retains bridge semantics without a theme button", async () => {
  const topbar = topbarBlock(await readHtml());
  const utilityStart = topbar.indexOf('class="topbar-utility-group"');
  const workStart = topbar.indexOf('class="topbar-work-group"');
  const bridgeAt = topbar.indexOf('id="bridgeStatus"');
  assert.ok(bridgeAt > utilityStart && bridgeAt < workStart, "#bridgeStatus must sit inside the utility group");
  assert.equal(topbar.includes('id="themeToggle"'), false, "theme toggle must not be duplicated in the topbar");
});

// 4. The work group carries the refinements (category → sort → search; the
// type filters left the topbar entirely in GravityPort A3 / 任务 70).
// 2026-08-18: V2-only token consolidation. The
// V2 design removed the legacy #batchToggle and #filterToggle buttons.
// 2026-10: the topbar gains the 任务 34 category
// dropdown ahead of sort, sharing the .sort-control look.
test("4. category, sort and search live in the work group", async () => {
  const topbar = topbarBlock(await readHtml());
  const workStart = topbar.indexOf('class="topbar-work-group"');
  const primaryStart = topbar.indexOf('class="topbar-primary-group"');
  for (const marker of ['class="sort-control category-control"', 'class="sort-control"', 'id="categorySelect"', 'id="sortSelect"', 'id="searchInput"']) {
    const at = topbar.indexOf(marker);
    assert.ok(at > workStart && at < primaryStart, `${marker} must sit inside the work group`);
  }
  // Work-group order: category → sort → search.
  const positions = ['id="categorySelect"', 'id="sortSelect"', 'id="searchInput"'].map((m) => topbar.indexOf(m));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `V2 order violated at ${i}`);
  }
});

// 5. The retired topbar import action stays absent.
test("5. topbar import action is removed and inspector opener lives in the primary group", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.includes('id="newAssetTopBtn"'), false, "#newAssetTopBtn must stay removed");
  assert.equal(topbar.includes('class="create-button"'), false, "topbar must not render the retired import button");
  const primaryStart = topbar.indexOf('class="topbar-primary-group"');
  const inspectorAt = topbar.indexOf('id="openInspectorBtn"');
  assert.ok(inspectorAt > primaryStart, "#openInspectorBtn must sit inside the primary group");
  assert.match(topbar, /id="openInspectorBtn"[^>]*data-i18n-aria-label="openAssetInspector"[^>]*aria-label="打开资产监视器"/);
});

// 6. All retained topbar control IDs stay unique in the page.
test("6. retained control IDs stay unique", async () => {
  const html = await readHtml();
  for (const id of CONTROL_IDS) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id} must appear exactly once`);
  }
  const app = await readApp();
  for (const id of CONTROL_IDS) {
    assert.equal(app.split(`querySelector("#${id}")`).length - 1, 1, `app.js must keep a single #${id} lookup and render no duplicate`);
  }
});

// 7. The DOM order of the V2 controls is unchanged.
// 2026-08-18: V2-only token consolidation. The V2 design removed the legacy
// #batchToggle, #filterToggle and the redundant #themeToggle buttons; the
// controls that survive are bridgeStatus → sortSelect → searchInput → openInspectorBtn
// (utility → work → primary).
test("7. control DOM order is unchanged", async () => {
  const topbar = topbarBlock(await readHtml());
  const positions = ["bridgeStatus", "sortSelect", "searchInput", "openInspectorBtn"].map((id) => topbar.indexOf(`id="${id}"`));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `order violated at index ${i}`);
  }
  // The hidden live region still precedes the visible bridge status.
  assert.ok(topbar.indexOf('id="statusText"') < topbar.indexOf('id="bridgeStatus"'), "#statusText stays before #bridgeStatus");
});

// 8. The retired import CTA is replaced by a quiet icon-only inspector opener.
test("8. the topbar primary action is the quiet inspector opener", async () => {
  const topbar = topbarBlock(await readHtml());
  assert.equal(topbar.includes("newAssetTopBtn"), false, "retired import action must stay absent");
  assert.equal(topbar.split('class="create-button"').length - 1, 0, "no solid import CTA remains");
  assert.match(topbar, /class="toolbar-icon inspector-open-button" id="openInspectorBtn"/);
});

// 9. Bridge meta no longer occupies visible topbar layout (visually-hidden, not display:none).
test("9. bridge meta is visually hidden without display:none", async () => {
  const html = await readHtml();
  assert.match(html, /class="bridge-status-meta visually-hidden" id="bridgeStatusMeta"/, "#bridgeStatusMeta must carry .visually-hidden");
  const css = await readCss();
  const { block } = extractBlock(css, ".visually-hidden {");
  assert.match(block, /position: absolute/, "visually-hidden must detach from layout");
  assert.match(block, /clip: rect\(0,0,0,0\)/, "visually-hidden must clip, not display:none");
  assert.doesNotMatch(css, /\.bridge-status-meta[^{]*\{[^}]*display:\s*none/, "meta must never be display:none (state semantics preserved)");
  assert.doesNotMatch(css, /#bridgeStatusLabel[^{]*\{[^}]*display:\s*none/, "label must never be display:none (state semantics preserved)");
});

// 10. Bridge role=status / aria-live / state pipeline stays intact.
test("10. bridge status live semantics stay intact", async () => {
  const html = await readHtml();
  assert.match(html, /id="bridgeStatus" data-state="checking" role="status" aria-live="polite"/, "bridge status keeps role=status + aria-live");
  assert.match(html, /id="statusText" role="status" aria-live="polite"/, "#statusText live region stays");
  const app = await readApp();
  assert.match(app, /els\.bridgeStatus\.dataset\.state = stateName; els\.bridgeStatus\.title = value;/, "setStatus still publishes data-state + tooltip");
  assert.match(app, /els\.bridgeStatusLabel\) els\.bridgeStatusLabel\.textContent = value;/, "setStatus still publishes the label text");
  // The hidden live text is owned by status-live-region.mjs (announce-on-change,
  // never mid-announcement); app.mjs only feeds it through setPersistentStatus.
  assert.match(app, /statusRegion\.setPersistentStatus\(value\);/, "setStatus still feeds the hidden live region");
  const regionModule = await readFile(resolve(root, "web/app/status-live-region.mjs"), "utf8");
  assert.match(regionModule, /node\.textContent = text;/, "the live region module still writes the hidden live text");
});

// 11. Theme selection is exposed only in Settings.
test("11. theme selection is not duplicated in the topbar", async () => {
  const [html, app] = await Promise.all([readHtml(), readApp()]);
  assert.doesNotMatch(topbarBlock(html), /themeToggle|theme-icon-moon|theme-icon-sun/);
  assert.match(app, /data-appearance-opt/,
    "settings must retain the appearance control after the topbar duplicate is removed");
});

// 12. (Retired) Batch toggle keeps aria-pressed.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// #batchToggle button (its affordance merged into the `.topbar-type-filters`
// strip in `.topbar-context`). The aria-pressed pipeline for batch mode is
// still asserted in `card-action-contract` test #18 — that surface covers
// the grid-level batch behaviour the new topbar hands off to.

// 13. (Retired) Filter toggle keeps aria-expanded.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// #filterToggle button (its affordance merged into the `.topbar-type-filters`
// strip in `.topbar-context`). The `.filter-panel` popover is now anchored
// from the type chips, not a dedicated toggle.

// 14. Sort select keeps its accessible name and native options.
test("14. sort select keeps its accessible name", async () => {
  const select = /<select id="sortSelect"[^>]*>/.exec(await readHtml());
  assert.ok(select, "sort select must exist");
  assert.match(select[0], /aria-label="排序"/, "aria-label must be preserved");
  const topbar = topbarBlock(await readHtml());
  for (const value of ["newest", "oldest", "name"]) {
    assert.ok(topbar.includes(`<option value="${value}"`), `native option ${value} must be preserved`);
  }
});

// 15. Inspector opener is icon-only but remains accessibly named and wired.
test("15. inspector opener keeps an accessible name and manual-open behavior", async () => {
  const button = /<button class="toolbar-icon inspector-open-button" id="openInspectorBtn"[^>]*>[\s\S]*?<\/button>/.exec(await readHtml());
  assert.ok(button, "inspector opener must exist");
  assert.match(button[0], /aria-label="打开资产监视器"/, "icon button keeps an explicit accessible name");
  const app = await readApp();
  assert.match(app, /els\.openInspectorBtn\?\.addEventListener\("click", openDetailSurfaceManually\);/);
  assert.match(app, /if \(els\.openInspectorBtn\) els\.openInspectorBtn\.hidden = state\.detailOpen;/);
});

// 16. The retired 1179px filter-only tier leaves no no-op CSS behind.
test("16. retired filter-only compact tier is removed", async () => {
  const css = await readCss();
  assert.doesNotMatch(css, /\.filter-dot|\.topbar-work-group \.toolbar-filter > span/);
});

// 17. The 960px compact tier exists (≤1120px bridge-label clip rule; 960 falls inside).
test("17. the 960px compact tier exists", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, "@media (max-width: 1120px) {");
  assert.match(block, /#bridgeStatusLabel \{[^}]*clip: rect\(0,0,0,0\)/, "bridge label clip-hidden at ≤1120px (dot-only)");
});

// 18. The topbar single-row contract exists (nowrap; ≤700px document-flow tier excepted).
test("18. the topbar nowrap contract exists", async () => {
  const { block } = extractBlock(await readCss(), ".topbar {");
  assert.match(block, /flex-wrap: nowrap/, "base .topbar must declare flex-wrap: nowrap");
  assert.match(block, /align-items: center/, "base .topbar must keep vertical centering");
});

// 19. The title area keeps min-width:0 + ellipsis contracts.
test("19. title min-width and ellipsis contracts exist", async () => {
  const css = await readCss();
  const { block: context } = extractBlock(css, ".topbar-context {");
  assert.match(context, /min-width: 0/, ".topbar-context must allow shrink");
  // The full flex shrink chain must be declared: a flex item's default min-width:auto
  // (= min-content) blocks ellipsis on nowrap text (caught by Phase 2B runtime).
  const { block: row } = extractBlock(css, ".title-row {");
  assert.match(row, /min-width: 0/, ".title-row must allow shrink");
  const { block: title } = extractBlock(css, ".title-row h2 {");
  assert.match(title, /min-width: 0/, "title h2 must allow shrink (flex-item min-width:auto blocks ellipsis)");
  assert.match(title, /overflow: hidden/, "title must clip overflow");
  assert.match(title, /text-overflow: ellipsis/, "title must ellipsize");
  assert.match(title, /white-space: nowrap/, "title must stay on one line");
  const { block: count } = extractBlock(css, ".title-row p {");
  assert.match(count, /flex: 0 0 auto/, "count must never cover the title");
});

// 20. The topbar height still references the token. V2 (2026-08-07) moved the
// token to 56px and R21 (2026-09) moved it to 64px on the web shell (locked by
// web-r21-shell's shared-shell-size test); the token indirection itself is what
// this locks.
test("20. topbar height still references the token", async () => {
  const css = await readCss();
  const { block } = extractBlock(css, ".topbar {");
  assert.match(block, /height: var\(--topbar-height\)/, ".topbar must consume --topbar-height");
});

// 21. No overflow / ellipsis menu was introduced.
test("21. no overflow menu was introduced", async () => {
  const topbar = topbarBlock(await readHtml());
  for (const marker of ["overflow-menu", "ellipsis-menu", "more-menu", "kebab", "topbar-menu", "dropdown-menu"]) {
    assert.equal(topbar.includes(marker), false, `topbar must not introduce a ${marker}`);
  }
  const app = await readApp();
  assert.doesNotMatch(app, /overflow-menu|kebab|topbar-menu/, "app.js must not wire an overflow menu");
});

// 22. The V2 search location contract: search lives in the topbar work group,
//     not in the sidebar (mosa-library-v2 FilterBar, 2026-08-16).
test("22. the search lives in the topbar, not the sidebar", async () => {
  const html = await readHtml();
  const topbar = topbarBlock(html);
  assert.ok(topbar.includes('id="searchInput"'), "the search input must live in the topbar");
  const sidebarStart = html.indexOf('<aside class="sidebar"');
  const sidebarEnd = html.indexOf("</aside>", sidebarStart);
  assert.equal(html.slice(sidebarStart, sidebarEnd).includes('id="searchInput"'), false, "no search input may remain in the sidebar");
  const app = await readApp();
  assert.match(app, /const commitSearchInput = debounce\(async \(intent\) => \{/,
    "search commit remains debounced");
  assert.match(app, /els\.searchInput\?\.addEventListener\("input", \(\) => \{[\s\S]*?commitSearchInput\(beginNavigationIntent\(\)\);/,
    "the topbar input remains the single search event source");
});

// 23. No !important anywhere in the stylesheet (comments stripped).
test("23. no !important in styles.css", async () => {
  const css = (await readCss()).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(css.includes("!important"), false, "styles.css must not use !important");
});

// 24. Topbar rules consume only defined tokens (no new hex/rgba/shadow/radius systems).
test("24. topbar rules consume only defined tokens", async () => {
  const css = await readCss();
  const ruleBodies = [];
  for (const marker of [".topbar {", ".topbar-context {", ".topbar-actions {", ".topbar-utility-group, .topbar-work-group {", ".topbar-primary-group {", "#bridgeStatusLabel {"]) {
    ruleBodies.push(extractBlock(css, marker).block);
  }
  const consumed = new Set();
  for (const body of ruleBodies) {
    for (const v of body.matchAll(/var\((--[a-z0-9-]+)/gi)) consumed.add(v[1]);
  }
  assert.ok(consumed.size > 0, "topbar rules must consume design tokens");
  for (const token of consumed) {
    assert.ok(css.includes(`${token}:`), `token consumed by topbar rules must be defined: ${token}`);
  }
  // No new raw colour literals inside the new group/label rules.
  for (const body of ruleBodies) {
    assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, "topbar hierarchy rules must not introduce raw colour literals");
  }
});

// 25. Phase 1 and Phase 2A contract suites keep passing.
test("25. Phase 1 and Phase 2A contract suites keep passing", () => {
  const result = spawnSync(process.execPath, [
    "--test",
    "test/ui-component-contract.test.mjs",
    "test/card-action-contract.test.mjs",
    "test/search-location-contract.test.mjs",
  ], { cwd: root, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const out = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `Phase 1/2A contract suites must exit 0:\n${out}`);
});
