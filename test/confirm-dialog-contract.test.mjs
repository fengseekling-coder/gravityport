// ConfirmDialog contract (Phase 5B / F-15): the single app-wide confirmation
// dialog that replaced every window.confirm, its single-pending Promise API,
// focus/Escape lifecycle, the four migrated business paths, the async
// confirmDetailNavigation guard, and the zero-change perimeters. Node standard
// library only, no network access, and never a whole-file SHA of app.js /
// index.html as a substitute for behaviour contracts (package manifest pins
// excepted).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const readApp = () => readFile(resolve(root, "web/app/app.mjs"), "utf8");
const readAssetView = () => readFile(resolve(root, "web/app/asset-view.mjs"), "utf8");
const readConfirmDialog = () => readFile(resolve(root, "web/app/confirm-dialog.mjs"), "utf8");
const readInspectorMarkup = () => readFile(resolve(root, "web/app/inspector-markup.mjs"), "utf8");
const readHtml = () => readFile(resolve(root, "web/app/index.html"), "utf8");
const readCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const count = (source, needle) => source.split(needle).length - 1;

/** Slices a top-level app.js function (async or sync) up to the next top-level function. */
function functionSlice(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function not found: ${name}`);
  const candidates = ["\nfunction ", "\nasync function "]
    .map((marker) => source.indexOf(marker, start + 1))
    .filter((index) => index !== -1);
  const next = candidates.length ? Math.min(...candidates) : -1;
  return source.slice(start, next === -1 ? source.length : next);
}

// 1-7. One static ConfirmDialog with the full dialog ARIA contract and native buttons.
test("1-7. a single app-wide ConfirmDialog with dialog semantics", async () => {
  const html = await readHtml();
  assert.equal(count(html, 'id="confirmDialog"'), 1, "exactly one ConfirmDialog overlay");
  assert.equal(count(html, "confirm-dialog-card"), 1, "exactly one confirm dialog card");
  assert.equal(count(html, 'id="confirmDialogTitle"'), 1, "exactly one dialog title");
  assert.equal(count(html, 'id="confirmDialogDescription"'), 1, "exactly one dialog description");
  const overlay = html.slice(html.indexOf('id="confirmDialog"'), html.indexOf('id="imagePreviewModal"'));
  assert.match(overlay, /role="dialog"/, "role=dialog");
  assert.match(overlay, /aria-modal="true"/, "aria-modal=true");
  assert.match(overlay, /aria-labelledby="confirmDialogTitle"/, "aria-labelledby points at the title");
  assert.match(overlay, /aria-describedby="confirmDialogDescription"/, "aria-describedby points at the description");
  assert.match(overlay, /<h3 id="confirmDialogTitle">/, "title is real text content");
  assert.match(overlay, /<p id="confirmDialogDescription">/, "description is real text content");
  assert.match(overlay, /<button class="btn-secondary" id="confirmDialogCancel" type="button"/, "Cancel is a native button");
  assert.match(overlay, /<button class="btn-danger" id="confirmDialogConfirm" type="button"/, "Confirm is a native button");
  assert.doesNotMatch(overlay, /confirmDialogAlternate/, "ConfirmDialog stays a two-button surface");
  assert.match(overlay, /data-i18n="cancel"/, "Cancel reuses the shared cancel copy");
  assert.match(html, /class="modal-overlay confirm-dialog-overlay" id="confirmDialog"/, "reuses the modal-overlay shell");
});

// 8-11. One Promise API, boolean result, resolver settles once, one pending at a time.
test("8-11. single Promise API with a single pending confirmation", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const close = functionSlice(confirmDialog, "closeConfirmDialog");
  assert.match(confirmDialog, /function requestConfirmation\(\{/, "the single confirmation API exists");
  assert.match(request, /return new Promise\(\(resolve\) =>/, "returns a Promise");
  assert.equal(count(request, "confirmDialogState.resolve = resolve"), 1, "resolver assigned exactly once per open");
  assert.match(close, /resolve\(result\)/, "resolves with the boolean result");
  assert.match(app, /closeConfirmDialog\(true\)/, "Confirm settles true");
  assert.match(app, /closeConfirmDialog\(false\)/, "Cancel settles false");
  assert.match(close, /if \(!confirmDialogState\.pending\) return;/, "resolver settles only once");
  assert.match(close, /confirmDialogState\.resolve = null;/, "resolver cleared on close");
  assert.match(request, /if \(confirmDialogState\.pending \|\| !els\.confirmDialog\) return Promise\.resolve\(false\);/,
    "a second request while pending resolves false immediately — no queue, no resolver override");
  assert.doesNotMatch(request, /(rootId|childId)\s*=/, "never assigns the anchored-overlay manager private state");
});

// 12-15. Confirm=true, Cancel/Escape/Backdrop=false; the backdrop can never confirm.
test("12-15. result semantics — backdrop can only cancel", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  assert.match(app, /els\.confirmDialogConfirm\?\.addEventListener\("click", \(\) => closeConfirmDialog\(true\)\);/, "Confirm button settles true");
  assert.match(app, /els\.confirmDialogCancel\?\.addEventListener\("click", \(\) => closeConfirmDialog\(false\)\);/, "Cancel button settles false");
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(trap, /closeConfirmDialog\(false\)/, "Escape settles false");
  const backdrop = app.match(/els\.confirmDialog\?\.addEventListener\("click",[^\n]*/)?.[0] || "";
  assert.match(backdrop, /event\.target === els\.confirmDialog\) closeConfirmDialog\(false\)/, "backdrop click only cancels");
  assert.doesNotMatch(backdrop, /closeConfirmDialog\(true\)/, "backdrop can never confirm");
});

// 16-18. Default focus lands on Cancel (two-button mode) or the confirm button
// (single-button notice mode, 任务 116); Tab/Shift+Tab cycle between the buttons.
test("16-18. default focus on Cancel with a two-stop Tab cycle", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(request, /requestAnimationFrame\(\(\) => \{ if \(confirmDialogState\.pending\) \(confirmDialogState\.hideCancel \? els\.confirmDialogConfirm : els\.confirmDialogCancel\)\?\.focus\(\); \}\);/,
    "two-button mode still opens focused on Cancel (destructive actions never default-focus the confirm button); single-button notice mode opens focused on the confirm button");
  assert.match(trap, /const focusable = \[els\.confirmDialogCancel, els\.confirmDialogConfirm\]/, "the trap cycles exactly the two dialog buttons");
  assert.match(trap, /event\.shiftKey \? \(current <= 0 \? focusable\.length - 1 : current - 1\) : \(current === focusable\.length - 1 \? 0 : current \+ 1\)/,
    "Tab wraps forward and Shift+Tab wraps backward");
  assert.match(trap, /event\.preventDefault\(\);\s*\n\s*focusable\[next\]\.focus\(\);/, "focus never escapes to the page background");
});

// 任务 116：单按钮提示弹窗（老用户「已更名」提示）。取消按钮整颗隐藏（hidden
// 属性 + 一条 display:none 规则）、无「不再提醒」行、打开焦点在确认按钮；关闭后取消按钮
// 恢复显示、焦点恢复走既有路径，普通确认框行为与以前完全一致。
test("116. single-button notice mode hides Cancel and focuses Confirm; ordinary dialogs restore both", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const close = functionSlice(confirmDialog, "closeConfirmDialog");
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(request, /hideCancel = false \} = \{\}/, "hideCancel is an optional switch on the single confirmation API");
  assert.match(request, /els\.confirmDialogCancel\.hidden = hideCancel === true;/, "the cancel button is hidden with the hidden attribute");
  // The button classes set display themselves, so the attribute alone would leave
  // the button on screen; this rule is what actually removes it.
  const styles = await readFile(new URL("../web/app/styles.css", import.meta.url), "utf8");
  assert.match(styles, /^\.confirm-dialog-actions \[hidden\] \{ display: none; \}$/m, "a hidden dialog button is really not rendered");
  assert.match(request, /confirmDialogState\.hideCancel = hideCancel === true;/, "the mode rides on the shared dialog state, not a second dialog");
  assert.match(close, /if \(els\.confirmDialogCancel\) els\.confirmDialogCancel\.hidden = false;/, "closing restores the cancel button for every later dialog");
  assert.match(close, /confirmDialogState\.hideCancel = false;/, "the mode is reset on close");
  assert.match(trap, /filter\(\(button\) => button && !button\.disabled && !button\.hidden\)/, "the Tab cycle skips the hidden cancel button");
  // 业务接线：改名提示只问一次、单按钮、主按钮 tone、不传 dontAskAgainKey；
  // 占用预检保证「没弹出来」不算已读。
  const notice = functionSlice(app, "maybeShowRenameNotice");
  assert.match(notice, /if \(notice\?\.shouldShow !== true\) return;/, "the renderer asks the desktop shell once and only shows a pending notice");
  assert.match(notice, /if \(confirmDialogState\.pending \|\| !els\.confirmDialog\) return;/, "a busy dialog surface means the notice did not show — not read, ask again next launch");
  assert.match(notice, /tone: "warning",/, "the notice button is the primary tone, not danger");
  assert.match(notice, /hideCancel: true,/);
  assert.doesNotMatch(notice, /dontAskAgainKey/, "the notice never offers the dont-ask row");
  assert.match(app, /void maybeShowRenameNotice\(\);/, "wired after the first screen renders");
});

// 19-21. Escape is consumed at the head of the priority chain and never leaks.
test("19-21. Escape consumed first, never leaks into the viewer", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const trap = functionSlice(confirmDialog, "trapConfirmDialogFocus");
  assert.match(trap, /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);\s*\n\s*closeConfirmDialog\(false\);/,
    "Escape is preventDefault + stopPropagation, then cancels");
  assert.ok(app.indexOf('document.addEventListener("keydown", trapConfirmDialogFocus);')
    < app.indexOf('document.addEventListener("keydown", trapSettingsModalFocus);'),
  "the confirm trap registers before the surviving modal traps — Escape priority head");
  const shortcuts = functionSlice(app, "setupKeyboardShortcuts");
  assert.match(shortcuts, /if \(confirmDialogState\.pending\) return;/, "background shortcuts stay silent while the dialog is open");
  const keyboardNav = functionSlice(app, "bindKeyboardNav");
  assert.match(keyboardNav, /confirmDialogState\.pending/, "arrow-key gallery navigation stays silent while the dialog is open");
});

// 22-23. Focus returns to a connected trigger; a disconnected trigger falls back safely.
test("22-23. focus restoration with safe fallbacks", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const restore = functionSlice(confirmDialog, "restoreConfirmDialogFocus");
  const target = functionSlice(confirmDialog, "isConfirmFocusTarget");
  assert.match(restore, /if \(restoreFocusInto\(returnFocus, triggerElement\)\) return;/, "restoration is attempted synchronously first — CI hidden windows throttle rAF to seconds (task 96 rework 2)");
  assert.match(restore, /requestAnimationFrame\(/, "a deferred rAF pass remains as the fallback for targets that are mid-rebuild");
  assert.match(restore, /for \(const candidate of \[returnFocus, triggerElement\]\)/, "priority 1 returnFocus, priority 2 pre-open activeElement");
  // 2026-09-04: the single-asset archive entry retired, so its requery branch went with it.
  assert.doesNotMatch(restore, /data-action="archive-asset"/, "no requery entry for the retired archive action");
  // 2026-09-04: the restricted-regenerate entry retired with the inspector regenerate button.
  assert.doesNotMatch(restore, /data-action="regenerate"/, "no requery entry for the retired regenerate action");
  assert.doesNotMatch(restore, /data-version-select|batchArchive|contextKey/, "retired action-specific requery branches do not survive");
  assert.match(restore, /state\.viewMode === "asset" \? els\.assetViewBack : els\.searchInput/, "priority 3 safe zone, never body");
  assert.match(target, /element\.isConnected && !element\.disabled && !element\.hidden && element\.offsetParent !== null/,
    "never restores into disconnected, disabled, hidden, or invisible nodes");
  assert.doesNotMatch(restore, /document\.body\.focus/, "focus never lands on body");
});

// 24-25. The surviving Settings surface closes before the dialog opens; the
// retired filter surface must not be preserved as a hidden compatibility path.
test("24-25. settings closes before opening and filter surface stays retired", async () => {
  const app = await readApp();
  const confirmDialog = await readConfirmDialog();
  const request = functionSlice(confirmDialog, "requestConfirmation");
  const closeSettings = request.indexOf('closePanel(els.settingsMenu, els.settingsToggle, "confirm-dialog")');
  const open = request.indexOf('els.confirmDialog.classList.add("open")');
  assert.ok(closeSettings > -1 && closeSettings < open, "Settings closes via the shared closePanel wrapper before the dialog opens");
  assert.doesNotMatch(request, /filterPanel|filterToggle/);
  assert.doesNotMatch(app, /filterPanel|filterToggle/);
  assert.match(app, /function closePanel\(panel, trigger, reason = "escape"\)[\s\S]*?panel\.hidden = true;[\s\S]*?trigger\?\.setAttribute\("aria-expanded", "false"\)/,
    "closePanel no longer depends on the retired anchored-overlay manager");
});

// 26-29. window.confirm is gone; batch archive confirms on a selection snapshot.
// 2026-08-18: V2-only token consolidation. The V2 design retired the
// batch-management affordance entirely; `batchArchive()` was removed from
// `app.mjs` along with `state.selectedIds`.
// 2026-09-04: the single-asset archive entry (inspector danger action) was
// retired with its listener, confirm copy, and contextKey.

// 30-31. The single-asset archive action stays retired end to end.
test("30-31. single-asset archive action is fully retired", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  assert.doesNotMatch(inspector, /data-action="archive-asset"/, "the inspector renders no archive entry");
  assert.doesNotMatch(app, /data-action="archive-asset"/, "no archive-asset listener survives in app.mjs");
  assert.doesNotMatch(app, /:archive-asset`/, "no archive-asset contextKey survives");
  assert.doesNotMatch(app, /title: t\("archiveOneTitle"\)/, "the single-archive confirm copy is unreferenced");
});

// 32-35. The inspector regenerate button retired on 2026-09-04; the
// restricted-regenerate warning flow retired with it. `regenerationInstruction`
// survives for the recipe-history copy entry, and the i18n copy stays (45-50).
test("32-35. restricted regenerate flow is fully retired", async () => {
  const app = await readApp();
  const inspector = await readInspectorMarkup();
  assert.doesNotMatch(inspector, /data-action="regenerate"/, "the inspector renders no regenerate entry");
  assert.doesNotMatch(app, /data-action="regenerate"/, "no regenerate listener survives in app.mjs");
  assert.doesNotMatch(app, /:restricted-regenerate`/, "no restricted-regenerate contextKey survives");
  assert.doesNotMatch(app, /title: t\("restrictedRegenerateTitle"\)/, "the restricted-regenerate confirm copy is unreferenced");
  assert.match(app, /function regenerationInstruction\(/, "recipe-history copy keeps regenerationInstruction");
});

// 36-42. confirmDetailNavigation is async, awaited everywhere, and flushes the pending auto-save before navigation.
test("36-42. async dirty-navigation guard awaited at every call site", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  assert.match(app, /async function confirmDetailNavigation\(\)/, "the guard is async");
  const guard = functionSlice(app, "confirmDetailNavigation");
  assert.match(guard, /return flushInspectorSave\(\);/,
    "navigation flushes the pending auto-save; a failed flush returns false and blocks navigation instead of prompting to discard");
  assert.match(app, /async function persistInspectorDraft\(panel, asset, renderId\)/, "the debounced auto-save path exists");
  assert.ok(count(app, "await confirmDetailNavigation(") >= 2, "all app-side destructive navigation paths await the shared guard");
  assert.equal(count(viewer, "await confirmDetailNavigation("), 2, "openAssetView and previous/next navigation await in asset-view.mjs");
  assert.doesNotMatch(app, /if \(!confirmDetailNavigation\(/, "no synchronous call site survives");
  assert.match(app, /async function selectAsset\(id, shouldScroll = false\)/, "selectAsset migrated to async");
  assert.match(viewer, /async function openAssetView\(id, trigger\)/, "openAssetView migrated to async");
  const helper = functionSlice(app, "selectDetailVersion");
  assert.match(helper, /if \(!await confirmDetailNavigation\(target\.id\)\) \{ restoreVersionPickerValue\(\); return false; \}/,
    "a failed flush restores the select value and keeps the current version");
  assert.match(helper, /state\.selectedId = target\.id;/, "a successful flush completes the version switch");
});

// 43-44. Context keys and stale-result guards on every async path.
test("43-44. contextKey guards keep stale results from acting", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  // 2026-08-26: auto-save retired the discard-confirmation prompt, so the
  // `:discard-version` contextKey retired with it (navigation now flushes the
  // pending draft instead of asking permission to discard). 2026-09-04: the
  // single-asset archive and restricted-regenerate contextKeys retired too.
  assert.doesNotMatch(app, /:archive-asset`/, "the retired archive contextKey is gone");
  assert.doesNotMatch(app, /:restricted-regenerate`/, "the retired regenerate contextKey is gone");
  const selectAsset = functionSlice(app, "selectAsset");
  const openView = functionSlice(viewer, "openAssetView");
  const helper = functionSlice(app, "selectDetailVersion");
  for (const [name, body] of [["selectAsset", selectAsset], ["openAssetView", openView], ["selectDetailVersion", helper]]) {
    assert.ok(body.indexOf("await confirmDetailNavigation") < body.indexOf("isCurrentDetailSelection"),
      `${name} rechecks the context after the flush resolves`);
  }
});

// 45-50. Only copy for active confirmation flows remains in the bundle.
test("45-50. active confirm copy stays symmetric and retired copy is removed", async () => {
  const { default: translations } = await import(pathToFileURL(resolve(root, "web/app/i18n.mjs")).href);
  const keys = ["discardChangesTitle", "discardChangesDescription", "discardChangesAction"];
  for (const locale of ["zh", "en"]) {
    for (const key of keys) {
      assert.ok(typeof translations[locale][key] === "string" && translations[locale][key].length, `${locale}.${key} exists`);
    }
  }
  for (const removed of [
    "archiveManyTitle", "archiveManyDescription", "archiveOneTitle", "archiveOneDescription", "archiveAction",
    "restrictedRegenerateTitle", "restrictedRegenerateDescription", "restrictedRegenerateAction",
    "confirmBatchArchive", "discardVersionChanges", "regenerateRestrictedConfirm",
  ]) {
    assert.equal(translations.zh[removed], undefined, `legacy key ${removed} removed (zh)`);
    assert.equal(translations.en[removed], undefined, `legacy key ${removed} removed (en)`);
  }
});

// 51-54. Neighbouring contracts keep their anchors.
test("51-54. anchored overlay, viewer escape, version workflow, and return snapshot anchors intact", async () => {
  const app = await readApp();
  const viewer = await readAssetView();
  const shortcuts = functionSlice(app, "setupKeyboardShortcuts");
  // 2026-08-18: V2-only token consolidation. The V2 design retired the
  // standalone #filterPanel element (its affordance merged into the
  // `.topbar-type-filters` strip in `.topbar-context`). The Escape chain
  // now starts from the image-preview modal and walks through group /
  // settings overlays before view-mode / detail-open fall-through. The
  // contract pins the surviving branches. (2026-09: the manual import
  // modal was retired, so its branch is gone from the chain.)
  const branches = [
    ["!els.imagePreviewModal?.hidden", "imagePreview"],
    ["els.groupModal?.classList.contains(\"open\")", "groupModal"],
    ["!els.settingsMenu?.hidden", "settingsMenu"],
  ];
  // Only inspect positions that fall inside the Escape branch (after the
  // first `if (event.key === "Escape")` marker) so we don't compare
  // image-preview positions in the *second* Escape handler (the image
  // zoom branch) against the modal branch above it.
  const escapeBranchStart = shortcuts.indexOf("if (event.key === \"Escape\")");
  assert.ok(escapeBranchStart > -1, "the Escape branch must exist");
  const escapeBranch = shortcuts.slice(escapeBranchStart);
  const positions = branches.map(([needle]) => escapeBranch.indexOf(needle));
  for (let i = 0; i < branches.length; i += 1) {
    assert.ok(positions[i] > -1, `Escape chain branch survives: ${branches[i][1]}`);
  }
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `Escape priority order: ${branches[i][1]} after ${branches[i - 1][1]}`);
  }
  const iDetailExit = shortcuts.indexOf('if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }');
  assert.ok(iDetailExit > -1, "view/detail Escape fallthrough is centralized through the dirty-safe close helper");
  assert.ok(positions[positions.length - 1] < iDetailExit, "modal fallthroughs precede view/detail exit");
  assert.match(shortcuts, /if \(event\.defaultPrevented\) return;/, "modal trap consumption still respected");
  assert.match(app, /select\.addEventListener\("change", \(\) => selectDetailVersion\(select\.value\)\);/, "version picker delegation intact");
  assert.match(app, /selectDetailVersion\(button\.dataset\.versionId\);/, "timeline delegation intact");
  const openView = functionSlice(viewer, "openAssetView");
  assert.match(openView, /state\.libraryReturnSnapshot = \{/, "return snapshot still built on open");
  assert.match(viewer, /function returnToLibrary\(/, "return path intact");
});

// 55. Toast compatibility entry kept — Phase 5C moved the behaviour to the
// dual-lane Toast Manager, so the contract here is delegation, not the old
// single-slot internals (which are now guarded by toast-manager-contract).
test("55. showToast keeps its signature and only delegates to the Toast Manager", async () => {
  const app = await readApp();
  const toast = functionSlice(app, "showToast");
  assert.match(toast, /function showToast\(message, type = "default", options = \{\}\)/, "existing call sites keep the (message, type) signature; options is the task-90 action-toast passthrough");
  assert.match(toast, /return toastManager\.show\(message, type, options\);/, "showToast only delegates to the manager — no duplicated queue logic");
  assert.doesNotMatch(app, /\btoastTimer\b/, "the legacy global single timer is gone");
});

// 56-57. Package manifest and lockfile frozen; no new dependencies.
test("56-57. package manifest and lockfile unchanged", async () => {
  const pkg = await readFile(resolve(root, "package.json"), "utf8");
  const lock = await readFile(resolve(root, "package-lock.json"), "utf8");
  // R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
  // qa:packaged launcher scripts, so the whole-manifest hash no longer holds;
  // the dependency sections the freeze really guards stay byte-identical.
  const manifest = JSON.parse(pkg);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies frozen");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies frozen");
  assertPackageLockMatchesManifest(lock, manifest, "package-lock.json dependency graph frozen");
});

// 58. The stylesheet stays free of !important while hosting the dialog styles.
// 2026-08-18: V2-only token consolidation. The DestructiveButton recipe
// now consumes V2 semantic tokens (`--color-danger`, `--app-card`) instead
// of the Phase 1A short names (`--error`, `--surface-1`).
test("58. dialog styles without !important", async () => {
  const css = await readCss();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(withoutComments, /!important/, "stylesheet must stay free of !important");
  // 任务 94（A4f）量数口径，任务 109（规范表 v1）收窄：卡 420 宽、高度随内容
  // （min-height 兜底删除，文案区不再撑固定高）；底行独立于 .modal-footer（无
  // 分隔线），左「不再提醒」右按钮组，放不下时「不再提醒」换行到按钮上面。
  assert.match(css, /\.confirm-dialog-card \{ box-sizing: border-box; width: 420px; \}/, "dialog geometry follows 规范表 v1 (420 wide, content-driven height, border-box)");
  assert.doesNotMatch(css, /\.confirm-dialog-card \{[^}]*min-height/);
  assert.doesNotMatch(css, /\.confirm-dialog-card \{[^}]*640/);
  assert.match(css, /\.confirm-dialog-copy \{ flex: 1 1 auto; padding: var\(--sp-10\) var\(--sp-10\) 0; overflow-wrap: break-word; \}/, "copy wraps instead of overflowing");
  assert.match(css, /\.confirm-dialog-copy h3 \{ margin: 0; font-size: var\(--text-lg\); font-weight: var\(--weight-semibold\); letter-spacing: 0; line-height: var\(--text-lg-lh\); \}/, "title typography from 规范表 v1: 15px semibold (--text-lg / --weight-semibold)");
  assert.match(css, /\.confirm-dialog-footer \{ display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var\(--sp-2\); padding: var\(--sp-6\) var\(--sp-10\) var\(--sp-10\); \}/, "footer keeps the 40px side and bottom insets, checkbox left and buttons right, wrapping the dont-ask row onto its own line when tight");
  assert.match(css, /\.confirm-dialog-dont-ask \{ display: inline-flex; flex: 0 1 auto; align-items: center; gap: var\(--sp-2\); font-size: var\(--text-sm\); cursor: pointer; \}/, "the dont-ask row is 12px (--text-sm, 规范表 v1)");
  assert.match(css, /\.confirm-dialog-dont-ask input \{[^}]*width: 16px; height: 16px[^}]*border-radius: var\(--radius-xs\)/, "the dont-ask checkbox is a 16×16 rounded-4 control");
  assert.match(css, /\.confirm-dialog-actions \.btn-secondary, \.confirm-dialog-actions \.btn-danger, \.confirm-dialog-actions \.btn-primary \{ min-width: 80px; height: var\(--control-md\); padding: 0 var\(--sp-3\); border-radius: var\(--radius-md\); font-size: var\(--text-md\); font-weight: var\(--weight-regular\); \}/, "footer buttons are 80 wide at the 28px control height (--control-md), type 13 (--text-md, 规范表 v1)");
  assert.match(css, /\.confirm-dialog-actions \{[^}]*margin-left: auto;/, "buttons stay right-aligned when the dont-ask row is hidden");
  assert.match(css, /@media \(max-width: 767px\) \{\s*\/\* 任务 94：确认弹窗窄屏不超过视口减两侧 16（420 宽卡只在桌面态给足）。 \*\/\s*\.confirm-dialog-overlay \{ padding: var\(--sp-4\); \}/,
    "narrow viewports cap the dialog at viewport minus 16 per side inside the registered ≤767 block");
  assert.match(css, /\.btn-danger \{ border: 1px solid var\(--color-danger\); color: var\(--color-danger\); background: var\(--app-card\); \}/,
    "the danger confirm button consumes the approved DestructiveButton recipe");
  assert.doesNotMatch(css, /\.btn-danger-solid\b/, "ConfirmDialog does not carry a third destructive-button recipe");
  assert.match(css, /:where\(\.action-btn\.danger, \.btn-danger\):not\(:disabled\):not\(\[aria-disabled="true"\]\):hover/,
    "danger hover stays inside the precise-pointer media guard");
});

test("context-menu bulk Trash action passes the selected count into its title", async () => {
  const source = await readFile(resolve(root, "web/app/context-menu-actions.mjs"), "utf8");
  const { default: translations } = await import(pathToFileURL(resolve(root, "web/app/i18n.mjs")).href);

  assert.match(translations.zh.moveAssetsToTrashTitle, /\{count\}/);
  assert.match(translations.en.moveAssetsToTrashTitle, /\{count\}/);
  assert.match(source, /t\("moveAssetsToTrashTitle", \{ count: ids\.length \}\)/,
    "Trash confirmation reports the real expanded mutation count, including Stack members and unloaded selections");
  assert.doesNotMatch(source, /t\("moveAssetsToTrashTitle"\)/);
  assert.doesNotMatch(source, /t\("archiveAsset"\)/, "archive is no longer exposed from the asset context menu");
});
