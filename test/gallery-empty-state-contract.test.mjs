import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

// F-08 守护契约：画廊空状态语义分离。
// 任务 111（2026-10-10）：七档空态按固定顺序分流（无结果 / 回收站 / 收藏 /
// 待整理 / 分组 / 空库 / 兜底），命中第一条就用它；判定集中在
// deriveGalleryEmptyState()，清除集中在 resetLibraryRefinements()。
// Node 标准库、零网络；helper 行为层用真实源码求值（new Function），其余为
// 源码切片契约。不用整文件 SHA 代替行为契约（package/lockfile 除外）。

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "web/app/asset-view.mjs"), "utf8");
const readApiClient = () => readFile(resolve(root, "web/app/api-client.mjs"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const readI18n = () => readFile(resolve(root, "web/app/i18n.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "web/app/inspector-markup.mjs"), "utf8");

const count = (source, needle) => source.split(needle).length - 1;
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `marker not found: ${endMarker}`);
  return source.slice(start, end);
}

const FACET_KEYS = ["source", "group", "category", "style", "conversation", "generationBatch"];
const EMPTY_FACETS = Object.fromEntries(FACET_KEYS.map((key) => [key, ""]));

/** Evaluates the real deriveGalleryEmptyState source against a given state. */
function makeDerive(app) {
  const helperSource = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  const run = new Function("state", "FACET_KEYS", `${helperSource}\nreturn deriveGalleryEmptyState();`);
  return (overrides = {}) => run({
    galleryStatus: "ready", galleryError: null, assets: [], pageTotal: 0,
    query: "", scope: "all", mediaKind: "all", facets: { ...EMPTY_FACETS },
    groups: { total: 0, favorites: 0, unorganized: 0, trash: 0, sourceTypes: [], groups: [] },
    ...overrides,
  }, FACET_KEYS);
}

const LIBRARY_STATE = { groups: { total: 9, favorites: 0, unorganized: 0, trash: 0, sourceTypes: [], groups: [["concept-art", 3], ["ui-icons", 0]] } };

// 2026-10-10（任务 111）：空态按情况说话——deriveGalleryEmptyState 按固定顺序
// 返回七种档位之一；galleryEmptyMarkup 每档出自己的标题/说明，只有无结果档带
// 「清除筛选」按钮，空库档的说明就是拖入提示（emptyDropHint）。本契约断言该
// 表面逐条成立。
test("01-06. centralized helper decides; loading/error/cards precede the seven kinds", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 1. renderGrid routes every zero result through the centralized helper.
  const renderGrid = sliceBetween(app, "function renderGrid()", "\nfunction renderErrorState");
  assert.match(renderGrid, /els\.assetGrid\.innerHTML = galleryEmptyMarkup\(\);/, "the empty branch renders through the shared markup builder");
  assert.match(app, /function galleryEmptyMarkup\(\)[\s\S]*?deriveGalleryEmptyState\(\)/, "the markup builder asks the centralized helper");
  // 2. The helper depends only on existing state, never on a second total.
  const helper = sliceBetween(app, "function deriveGalleryEmptyState()", "/** One shell for every empty state");
  for (const signal of ["state.galleryStatus", "state.assets"]) {
    assert.match(helper, new RegExp(signal.replace(/\./g, "\\.")), `the helper reads ${signal}`);
  }
  assert.doesNotMatch(helper, /state\.pageTotal/, "the current result total never impersonates the library total");
  assert.match(helper, /state\.groups\?\.total/, "the whole-library total comes from state.groups.total");
  assert.doesNotMatch(helper, /fetch\(|api\(/, "the helper never sends a request");

  // 3. loading precedes every empty kind. 4. error too. 5. cards mean no empty.
  assert.equal(derive({ galleryStatus: "loading", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ galleryStatus: "error", groups: { total: 0, groups: [] } }), "none");
  assert.equal(derive({ assets: [{ id: "a" }], ...LIBRARY_STATE }), "none");
  assert.ok(helper.indexOf('galleryStatus === "loading"') < helper.indexOf("state.assets.length"), "loading guard precedes the card guard");
  assert.ok(helper.indexOf('galleryStatus === "error"') < helper.indexOf("state.assets.length"), "error guard precedes the card guard");
  // 6. The empty library only counts as such in the "all" scope.
  assert.equal(derive({ groups: { total: 0, groups: [] } }), "library-empty");
  assert.equal(derive({ scope: "trash", groups: { total: 0, groups: [] } }), "trash-empty", "an empty trash in an empty library still speaks as trash");
});

test("07-13. the seven kinds in their fixed order, first match wins", async () => {
  const app = await readApp();
  const derive = makeDerive(app);

  // 1. 搜索或筛选无结果：query / mediaKind / 除 group 外任何 facet。
  assert.equal(derive({ query: "zzz", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ mediaKind: "video", ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, source: "codex-generated" }, ...LIBRARY_STATE }), "no-results");
  assert.equal(derive({ facets: { ...EMPTY_FACETS, style: "cyberpunk" }, ...LIBRARY_STATE }), "no-results");
  // 2-4. 回收站 / 收藏 / 待整理固定入口的空态（侧栏入口是「在哪儿看」，不算筛选）。
  assert.equal(derive({ scope: "trash", ...LIBRARY_STATE }), "trash-empty");
  assert.equal(derive({ scope: "favorite", ...LIBRARY_STATE }), "favorites-empty");
  assert.equal(derive({ scope: "unorganized", ...LIBRARY_STATE }), "unorganized-empty");
  // 5. 分组里本来就没图。
  assert.equal(derive({ facets: { ...EMPTY_FACETS, group: "ui-icons" }, ...LIBRARY_STATE }), "group-empty");
  // 6. 空库：所有素材 + 整库总数 0（groups.total 是权威值）。
  assert.equal(derive({ groups: { total: 0, favorites: 0, unorganized: 0, trash: 0, sourceTypes: [], groups: [] } }), "library-empty");
  // 7. 其余兜底（某来源下没有图等不出名的情形）回到无结果文案。
  assert.equal(derive({ ...LIBRARY_STATE }), "no-results", "no assets, no refinements, non-zero library total = the no-results fallback");
  // 边界：分组里搜不到算第 1 条；回收站里搜不到也算第 1 条。
  assert.equal(derive({ query: "zzz", facets: { ...EMPTY_FACETS, group: "ui-icons" }, ...LIBRARY_STATE }), "no-results", "a miss inside a group is a search miss (case 1), not the group-empty copy");
  assert.equal(derive({ scope: "trash", query: "zzz", ...LIBRARY_STATE }), "no-results", "a miss inside the trash is a search miss (case 1), not the trash-empty copy");
  // 边界：第 1 条先于第 2 条——回收站里加了来源筛选，命中第 1 条。
  assert.equal(derive({ scope: "trash", facets: { ...EMPTY_FACETS, source: "codex-generated" }, ...LIBRARY_STATE }), "no-results", "case 1 outranks case 2: a filter inside the trash is a search miss");
});

test("14-19. one shell, per-kind copy, and the single clear action on the no-results kind", async () => {
  const app = await readApp();
  const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");

  // 任务 111（2026-10-10）：每种档位共用同一个外壳（图标 + 标题 + 说明），文案
  // 与按钮由 GALLERY_EMPTY_STATE_COPY 按 kind 决定；空库档的说明一句就是拖入
  // 提示（emptyDropHint），不再单独重复渲染第二遍。
  assert.match(markup, /data-empty-kind=\\"" \+ kind/, "the shell carries its kind via data attribute (string concat in V2)");
  assert.match(markup, /<svg class=\\?"gallery-empty-icon\\?"/, "the shell uses the package glyph icon");
  assert.match(markup, /GALLERY_EMPTY_STATE_COPY\[kind\]/, "the copy comes from the per-kind table");
  assert.match(markup, /t\(copy\.titleKey\)/, "the heading uses the kind's title key");
  assert.match(markup, /t\(copy\.descriptionKey\)/, "the description uses the kind's description key");
  assert.match(markup, /data-action=\\?"empty-clear\\?"/, "the clear action targets empty-clear");
  assert.doesNotMatch(markup, /empty-import/, "no import button action remains");
  // 只有无结果档带「清除筛选」；其余档没有按钮区。拖入提示不再作为独立段落
  // 出现在任何档位（空库档它就是说明本身）。
  assert.doesNotMatch(markup, /emptyDropHint/, "the drop hint is a description key in the table, never a second paragraph");
  assert.equal(count(markup, "<p>"), 1, "exactly one description <p> per kind, assembled from the table");
  assert.doesNotMatch(markup, /role="alert"/, "a static empty state is not an alert");
  assert.doesNotMatch(markup, /(<[^>]*\s|\s)hidden(\s|>|=)/, "no hidden control can leak into the tab order (aria-hidden stays allowed)");

  // 每档的文案键与动作（表即真相）：六档齐全、键都存在、只有 no-results 有动作。
  const table = sliceBetween(app, "const GALLERY_EMPTY_STATE_COPY = {", "};");
  const kinds = {
    "no-results": ["noResultsTitle", "noResultsDescription", true],
    "trash-empty": ["trashEmptyTitle", "trashEmptyDescription", false],
    "favorites-empty": ["favoritesEmptyTitle", "favoritesEmptyDescription", false],
    "unorganized-empty": ["unorganizedEmptyTitle", "unorganizedEmptyDescription", false],
    "group-empty": ["groupEmptyTitle", "groupEmptyDescription", false],
    "library-empty": ["emptyLibraryTitle", "emptyDropHint", false],
  };
  for (const [kind, [titleKey, descriptionKey, clearAction]] of Object.entries(kinds)) {
    const row = new RegExp(`"${kind}": \\{ titleKey: "${titleKey}", descriptionKey: "${descriptionKey}"${clearAction ? ", clearAction: true" : ""} \\}`);
    assert.match(table, row, `the ${kind} row pins its copy keys${clearAction ? " and the clear action" : " and no action"}`);
  }
  const i18n = await readI18n();
  for (const key of Object.values(kinds).flat().filter((value) => typeof value === "string")) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }

  // 读屏播报跟着各档标题走：announceEmptyState 查同一张表，旧的中性兜底键不再出现。
  const announce = sliceBetween(app, "function announceEmptyState(", "\n}");
  assert.match(announce, /GALLERY_EMPTY_STATE_COPY\[kind\]/, "the announcement reads the same per-kind table");
  assert.match(announce, /t\(copy\.titleKey\)/, "the announcement speaks the kind's title");
  assert.doesNotMatch(announce, /statusScopeEmpty|statusLibraryEmpty/, "the retired neutral announcements are gone");
});

test("20-32. resetLibraryRefinements is the single clear path with focus recovery", async () => {
  const app = await readApp();
  const reset = sliceBetween(app, "function resetLibraryRefinements()", "\n\nasync function init()");

  // 20-24. V2 (2026-08-16) drops the legacy `state.facetQuery` / facet-search
  // input (the facet panel merged into the topbar `.topbar-type-filters` chip
  // strip). The reset now clears query, scope, mediaKind, and the facet
  // groups via `clearFacets()`.
  assert.match(reset, /state\.query = "";/, "clears the query");
  assert.match(reset, /state\.scope = "all";/, "restores the all scope");
  assert.match(reset, /state\.mediaKind = "all";/, "restores the all media kind");
  assert.match(reset, /clearFacets\(\);/, "clears every facet including the group");
  // 25-27. Never touches sort, theme, language or project (density is gone).
  for (const untouched of ["state.sort", "state.darkMode", "state.languagePreference", "state.locale =", "state.project =", "setLanguage"]) {
    assert.doesNotMatch(reset, new RegExp(untouched.replace(/[.=]/g, (m) => `\\${m}`)), `${untouched} stays untouched`);
  }
  // 28. Exactly one refresh: one loadAssets, no second path through applyFilterChange.
  assert.equal(count(reset, "loadAssets("), 1, "the reset triggers exactly one refresh");
  assert.doesNotMatch(reset, /applyFilterChange\(\)/, "no duplicate refresh path");
  // The empty-state action is the only full-reset entry point. The retired
  // filter-chip toolbar no longer keeps a second clear-all wrapper alive.
  assert.equal(count(app, "resetLibraryRefinements();"), 1, "only the empty-state reset entry remains");
  assert.doesNotMatch(app, /function clearAllFilters\(|renderActiveFilters|removeFilterChip/);
  const delegation = sliceBetween(app, 'els.assetGrid?.addEventListener("click"', 'els.quickFilters?.addEventListener("click"');
  assert.match(delegation, /resetLibraryRefinements\(\); return;/, "the empty-state clear/view-all actions share the same helper");
  // 29. The search input DOM stays in sync.
  assert.match(reset, /els\.searchInput\) els\.searchInput\.value = "";/, "the search input is cleared");
  // 30-31. Quick filters and type filters re-render in the same pass.
  assert.match(reset, /renderQuickFilters\(\); renderTypeFilters\(\);/, "type filters and quick filters sync in the same pass");
  // 32. Focus never lands on body: first card, else the grid container.
  assert.match(reset, /els\.assetGrid\?\.querySelector\("\.asset-card-select"\)/, "focus prefers the first asset card");
  assert.match(reset, /else els\.assetGrid\?\.focus\(\{ preventScroll: true \}\);/, "the grid container is the focus fallback");
  // Announcement reuses the existing polite live region.
  assert.match(reset, /announceGalleryStatus\(t\("statusRefinementsCleared"\)\)/, "the reset announces through the existing live region");
});

test("33-36. import stays drag/drop-only; retry and pagination failures stay honest", async () => {
  const [app, apiClient] = await Promise.all([readApp(), readApiClient()]);
  const delegation = sliceBetween(app, 'els.assetGrid?.addEventListener("click"', 'els.quickFilters?.addEventListener("click"');

  // 33-34. 2026-09: the manual import modal is retired. The empty state never
  // opens a modal, and no import-modal opener survives anywhere in the app.
  assert.doesNotMatch(delegation, /empty-import/, "the empty state has no import button left");
  assert.doesNotMatch(app, /function openImportModal\(\)/, "the import modal opener is gone");
  assert.doesNotMatch(app, /importModal/, "no import modal references survive in the renderer");
  const markup = sliceBetween(app, "function galleryEmptyMarkup()", "/** Reuses the existing polite live region");
  assert.doesNotMatch(markup, /importModal|modal-overlay|role="dialog"/, "the empty state never builds a second modal");
  // Return focus of the surviving modals stays untouched.
  assert.match(app, /state\.modalReturnFocus instanceof HTMLElement\) state\.modalReturnFocus\.focus\(\);/);
  // 35. Fatal error keeps error-state + Retry.
  const renderGrid = sliceBetween(app, "function renderGrid()", "\nfunction renderErrorState");
  assert.match(renderGrid, /if \(state\.galleryStatus === "error"\)/, "the error branch precedes every empty state");
  assert.match(renderGrid, /data-action="retry"/, "the error state keeps its retry action");
  assert.match(delegation, /\[data-action="retry"\]'\)\) window\.location\.reload\(\)/, "retry behaviour is unchanged");
  assert.match(renderGrid, /announceEmptyState/, "announcements fire only for empty states, never for errors");
  // 36. A pagination failure can never clear existing cards.
  const loadAssets = sliceBetween(apiClient, "async function loadAssets(", "let libraryRefreshInFlight");
  assert.ok(loadAssets.indexOf("const result = await requestAssetPage(") < loadAssets.indexOf("state.assets = nextAssets"), "assets only change after a successful response");
  assert.doesNotMatch(app, /state\.assets = \[\]/, "nothing ever empties the card list directly");
  assert.doesNotMatch(delegation, /load-more[\s\S]*?renderErrorState/, "load-more failures do not repaint the grid as an error or empty state");
});

// 37-39. (Retired) batch, viewer and return snapshot semantics stay untouched.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance entirely (no `updateBatchUI`, no
// `setBatchBusy`, no `state.batchSaving`). The viewer return-snapshot and
// view-mode state machine remain unchanged; those anchors are covered by
// `confirm-dialog-contract` test 51-54 and the Phase 4C neighbour suite.

test("40. i18n keys for the seven empty states stay symmetric across zh and en", async () => {
  const i18n = await readI18n();

  // 任务 111（2026-10-10）：七档空态各自的文案键 + 恢复动作 + 重置播报。
  const ACTIVE_KEYS = [
    "noResultsTitle", "noResultsDescription", "resetFilters", "emptyDropHint", "statusRefinementsCleared",
    "trashEmptyTitle", "trashEmptyDescription",
    "favoritesEmptyTitle", "favoritesEmptyDescription",
    "unorganizedEmptyTitle", "unorganizedEmptyDescription",
    "groupEmptyTitle", "groupEmptyDescription",
    "emptyLibraryTitle",
  ];
  for (const key of ACTIVE_KEYS) {
    assert.equal(count(i18n, `${key}:`), 2, `${key} exists exactly once per locale`);
  }
  // The empty library never borrows the no-results wording and vice versa.
  assert.match(i18n, /noResultsTitle: "没有找到匹配的素材"/);
  assert.match(i18n, /noResultsTitle: "No matching assets"/);
  // The keys the per-kind copy retired are gone in both locales.
  for (const retired of ["noAssets", "noAssetsHint", "statusScopeEmpty", "statusLibraryEmpty"]) {
    assert.doesNotMatch(i18n, new RegExp(`\\b${retired}:`), `retired empty-state key ${retired} is gone`);
  }
});

test("41-43. styles stay inside the token boundary; dependencies stay frozen", async () => {
  const [app, css, pkg, lock] = await Promise.all([readApp(), readCss(), readFile(resolve(root, "package.json"), "utf8"), readFile(resolve(root, "package-lock.json"), "utf8")]);

  // 41. No !important; the shell reuses tokens and adds no new color system.
  // 2026-08-18: V2-only token consolidation. The V2 empty-state heading now
  // consumes `--color-text-primary` (the canonical V2 token) instead of the
  // Phase 1A `--text-1` alias.
  const cssDeclarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(cssDeclarations, /!important/, "no !important in any CSS declaration");
  assert.match(css, /\.gallery-empty-state \{ display: flex; grid-column: 1 \/ -1;/, "the shell spans the content area, never the sidebar");
  assert.match(css, /\.gallery-empty-state h2 \{ color: var\(--color-text-primary\);/, "the heading uses an existing V2 token");
  assert.match(css, /\.gallery-empty-state p \{[^}]*overflow-wrap: anywhere;/, "long descriptions wrap instead of breaking the layout");
  assert.match(css, /\.empty-state-actions \{ display: flex; flex-wrap: wrap;/, "actions stay reachable at 200% zoom");
  const shellStyles = sliceBetween(css, ".gallery-empty-state {", ".error-state {");
  assert.doesNotMatch(shellStyles, /#[0-9a-fA-F]{3,8}\b|backdrop-filter|gradient|box-shadow/, "no new colors, glassmorphism, gradients or big shadows");
  assert.doesNotMatch(css, /\.empty-state-onboard/, "the dead onboarding shell styles are gone");
  assert.doesNotMatch(css, /\.empty-state \{/, "the old misleading empty-state styles are gone");
  // 42-43. Only approved local helpers are imported; no manifest or lockfile
  // change. `tag-utils.mjs` is the local tag normalization helper;
  // `navigation-history.mjs` is the GravityPort A3 浏览位置历史模块（任务 70）.
  assert.deepEqual([...app.matchAll(/^import .* from "(.*)";$/gm)].map((match) => match[1]).sort(), ["./api-client.mjs", "./asset-stacks.mjs", "./asset-view.mjs", "./batch-import.mjs", "./bridge-status-poller.mjs", "./confirm-dialog.mjs", "./context-menu-actions.mjs", "./context-menu-bindings.mjs", "./context-menu.mjs", "./cut-paste.mjs", "./gallery-selection.mjs", "./i18n-runtime.mjs", "./image-preview.mjs", "./inspector-markup.mjs", "./inspector-overlay.mjs", "./library-reconciliation.mjs", "./middle-ellipsis.mjs", "./native-asset-drag.mjs", "./navigation-history.mjs", "./status-live-region.mjs", "./tag-utils.mjs", "./toast-manager.mjs"], "app.js imports only approved local helpers");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies must stay untouched");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies must stay untouched");
  assertPackageLockMatchesManifest(lock, manifest, "package-lock.json must preserve dependency identity");
});

test("44. Phase 1–4C neighbouring contracts and anchors stay intact", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  const viewer = await readAssetView();

  await Promise.all([
    access(resolve(root, "test/gallery-experience.test.mjs")),
    access(resolve(root, "test/accessibility-contract.test.mjs")),
    access(resolve(root, "test/shell-layout-contract.test.mjs")),
    access(resolve(root, "test/ui-component-contract.test.mjs")),
    access(resolve(root, "test/hidden-attribute-contract.test.mjs")),
    access(resolve(root, "test/inspector-cowart-original-actions-contract.test.mjs")),
  ]);
  // Anchors those contracts rely on.
  assert.doesNotMatch(app, /clearAllFilters|removeFilterChip|renderActiveFilters/, "the retired chip toolbar leaves no renderer hooks");
  assert.match(app, /if \(state\.galleryStatus === "loading"\) \{ els\.assetGrid\.innerHTML = gallerySkeletonMarkup\(\); restoreGridFallbackFocus\(\); return; \}/, "the skeleton branch survives and does not drop focus to body");
  assert.match(viewer, /state\.libraryReturnSnapshot = \{/);
  assert.match(inspector, /function detailMoreSectionMarkup\(asset\)/);
});

test("45. incremental commits never append cards behind a mounted empty state (task 122)", async () => {
  const app = await readApp();

  // The shared gallery-child predicate, evaluated behaviorally: only the four
  // legitimate gallery surfaces count as card mode.
  const predicateSource = sliceBetween(app, "function galleryChildElement(element)", "\nfunction reconcileAssetCards");
  const galleryChildElement = new Function(`${predicateSource}\nreturn galleryChildElement;`)();
  const withClasses = (...classes) => ({ classList: { contains: (name) => classes.includes(name) } });
  assert.equal(galleryChildElement(withClasses("asset-card")), true);
  assert.equal(galleryChildElement(withClasses("asset-load-more")), true);
  assert.equal(galleryChildElement(withClasses("infinite-scroll-sentinel")), true);
  assert.equal(galleryChildElement(withClasses("gallery-virtual-extent")), true);
  assert.equal(galleryChildElement(withClasses("gallery-empty-state")), false);
  assert.equal(galleryChildElement(withClasses("gallery-skeleton")), false);
  assert.equal(galleryChildElement(withClasses("error-state")), false);

  // commitIncrementalGalleryChanges must hand the whole frame to renderGrid
  // while a non-card surface is mounted. Appending cards behind the empty
  // state keeps `.grid:has(.gallery-empty-state) { display: flex }` alive and
  // squeezes the whole batch into one narrow row (task 122 repro: 24 cards at
  // ~30px). The guard has to run before the id-keyed DOM surgery, and the
  // placeholder cleanup in reconcileAssetCards shares the same predicate.
  const commit = sliceBetween(app, "function commitIncrementalGalleryChanges", "\n// Viewer（大图查看模式）");
  assert.match(commit, /some\(\(element\) => !galleryChildElement\(element\)\)/, "the incremental commit checks for non-card surfaces");
  const guardAt = commit.indexOf("!galleryChildElement(element)");
  const renderGridAt = commit.indexOf("renderGrid();", guardAt);
  const surgeryAt = commit.indexOf("const assetsById");
  assert.ok(renderGridAt > -1, "the guard delegates to renderGrid");
  // The mirror case takes the same exit: once the last asset is removed from
  // outside, the id surgery would only detach cards and leave a blank grid, so
  // an empty list also hands the frame to renderGrid (which paints the empty state).
  assert.match(commit, /if \(!state\.assets\.length \|\| \[\.\.\.grid\.children\]\.some\(\(element\) => !galleryChildElement\(element\)\)\) \{\s*\n\s*renderGrid\(\);/,
    "an emptied list is rendered by renderGrid, not by the incremental commit");
  assert.ok(renderGridAt < surgeryAt, "the guard must run before the incremental id surgery");
  assert.equal([...app.matchAll(/!galleryChildElement\(element\)/g)].length, 2,
    "reconcileAssetCards and commitIncrementalGalleryChanges share the predicate; no third copy");

  // Skeleton/error surfaces cannot reach the incremental commit at all: the
  // reconciler only reconciles the active view while galleryStatus is "ready".
  // During loading the in-flight loadAssets renders the fresh result; during
  // error the delta is skipped and the retry button reloads.
  const reconciliation = await readFile(resolve(root, "web/app/library-reconciliation.mjs"), "utf8");
  assert.match(reconciliation, /if \(state\.galleryStatus === "ready"\) targets\.push\(\{ kind: "active", request: requestAtStart \}\);/,
    "only the ready state takes the incremental commit path (skeleton/error immunity)");
});
