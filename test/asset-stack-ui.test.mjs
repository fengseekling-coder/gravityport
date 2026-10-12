import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { moveBlockBefore, moveBlockRelative } from "../web/app/asset-stacks.mjs";
import { createInspectorMarkup } from "../web/app/inspector-markup.mjs";

test("stack manual ordering makes the first asset the cover", () => {
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["d"], "a"), ["d", "a", "b", "c"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c", "d"], ["b", "c"], "a"), ["b", "c", "a", "d"]);
  assert.deepEqual(moveBlockBefore(["a", "b", "c"], ["a"], "c"), ["b", "a", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["d"], "b", "before"), ["a", "d", "b", "c"]);
  assert.deepEqual(moveBlockRelative(["a", "b", "c", "d"], ["a"], "c", "after"), ["b", "c", "a", "d"]);
});

test("Stack Inspector falls back to real media when a thumbnail is not ready", () => {
  const { stackInspectorMarkup } = createInspectorMarkup({
    state: { groups: { groups: [] }, locale: "zh-CN" },
    t: (key) => key,
    referenceRightsMarkup: () => "",
  });
  const markup = stackInspectorMarkup({
    id: "stack-a",
    count: 1,
    members: [{
      id: "asset-a",
      image_url: "/api/assets/default/asset-a/media",
      thumbnail_url: "/api/assets/default/asset-a/thumbnail",
      thumbnail_ready: false,
      medium_url: "/api/assets/default/asset-a/medium",
      medium_ready: false,
      preview_url: "/api/assets/default/asset-a/preview",
      preview_ready: false,
      source: { media_kind: "image" },
    }],
  });
  assert.match(markup, /src="\/api\/assets\/default\/asset-a\/media"/,
    "Stack Inspector uses the original image when no derivative is ready");
  assert.doesNotMatch(markup, /<svg class="thumb image-thumb-pending"/,
    "Stack Inspector must not inherit the gallery's blank thumbnail placeholder");
  assert.doesNotMatch(markup, /stack-inspector-summary|stackItemCount|<h3>/,
    "Stack Inspector goes straight to member media without repeating a redundant Stack/count summary");
});

test("visual stack behavior is wired into the shared web renderer", async () => {
  const [app, apiClient, stackController, selection, contextActions, contextBindings, html, css, i18n, inspector] = await Promise.all([
    readFile(new URL("../web/app/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/api-client.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/asset-stacks.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/gallery-selection.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/context-menu-actions.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/context-menu-bindings.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/index.html", import.meta.url), "utf8"),
    readFile(new URL("../web/app/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../web/app/i18n.mjs", import.meta.url), "utf8"),
    readFile(new URL("../web/app/inspector-markup.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(app, /activeStackId: ""/);
  assert.match(app, /createAssetStackController\(/);
  assert.match(app, /assetStacks\.bind\(\)/);
  assert.ok(app.indexOf("assetStacks.bind();") < app.indexOf("gallerySelection.bind();"),
    "asset drag arbitration must bind before marquee selection so a card press is claimed synchronously");
  assert.match(app, /asset\?\.stack\?\.id/);
  assert.match(app, /assetStacks\.enterStack\(asset\.stack\.id, asset\.stack\)/);
  const singleClick = app.slice(
    app.indexOf('els.assetGrid?.addEventListener("click"'),
    app.indexOf('els.assetGrid?.addEventListener("dblclick"'),
  );
  const doubleClick = app.slice(
    app.indexOf('els.assetGrid?.addEventListener("dblclick"'),
    app.indexOf('els.quickFilters?.addEventListener'),
  );
  assert.doesNotMatch(singleClick, /assetStacks\.enterStack/,
    "collapsed Stack single-click must not navigate");
  assert.match(singleClick, /void selectGalleryNode\(id\)/,
    "collapsed Stack single-click goes through the shared logical-node selector");
  assert.match(app, /async function selectGalleryNode\(id, shouldScroll = false\)[\s\S]*?return selectStackNode\(asset, shouldScroll\)/,
    "mouse and keyboard selection share the same Stack-aware node semantics");
  assert.match(app, /async function selectStackNode\(asset, shouldScroll = false\)[\s\S]*?state\.detailStack = \{[\s\S]*?loading: true/,
    "Stack inspection owns an explicit detail state");
  assert.match(app, /state\.generationHistory = null;[\s\S]*?if \(!state\.detailManuallyClosed\) setDetailOpen\(true\);[\s\S]*?if \(state\.detailManuallyClosed\) return true;/,
    "Stack selection also respects the manual-close Inspector lock");
  assert.match(app, /async function loadStackInspectorMembers\(stackId, coverAssetId[\s\S]*?\/api\/asset-stacks\/\$\{encodeURIComponent\(stackId\)\}\/assets/,
    "Stack inspection loads the complete member list through one reusable refresh path");
  assert.match(app, /const stackDetail = state\.detailStack\?\.coverAssetId === state\.selectedId \? state\.detailStack : null/,
    "the inspector distinguishes a logical Stack from the cover asset that represents it in the gallery");
  assert.match(app, /stackInspectorMarkup\(stackDetail\)/,
    "the detail renderer has a dedicated Stack member view");
  assert.match(app, /bindStackInspectorMediaFallbacks\(els\.detailPanel\)/,
    "Stack Inspector retries a missing derivative with the original media URL");
  assert.match(inspector, /function stackInspectorMediaMarkup\(asset = \{\}\)[\s\S]*?thumbnailUrl \|\| mediumUrl \|\| previewUrl \|\| originalUrl/,
    "Stack Inspector owns a real-media fallback chain instead of the gallery placeholder contract");
  assert.match(doubleClick, /if \(!state\.activeStackId && \(card\?\.dataset\.stackId \|\| asset\?\.stack\?\.id\)\)/,
    "only the collapsed Stack node intercepts double-click; active Stack members remain openable");
  assert.match(doubleClick, /assetStacks\.enterStack\(asset\.stack\.id, asset\.stack\)/,
    "collapsed Stack double-click opens the Stack");
  assert.match(doubleClick, /void openAssetView\(id, selectButton\)/,
    "a member double-click inside the active Stack opens the dedicated Viewer");
  assert.match(app, /asset-stack-count/);
  assert.match(app, /stackMatchAccessibleName/);
  assert.match(css, /\.asset-card\.is-stack \.card-actions \{ opacity: 0; pointer-events: none; \}/);
  assert.match(app, /actions\?\.setAttribute\("inert", ""\)/);
  assert.match(app, /assetStacks\.isBusy\(\)/);
  assert.match(app, /state\.activeStackId[\s\S]*?stackItemCount/);

  assert.match(apiClient, /request\.stackId[\s\S]*?\/api\/asset-stacks\//);
  assert.match(apiClient, /Number\(options\.limit\) \|\| GALLERY_PAGE_SIZE/);
  assert.match(apiClient, /sort: state\.activeStackId \? "manual" : state\.sort/);
  assert.match(apiClient, /mosa:active-stack-missing/);
  assert.match(apiClient, /params\.set\("view", "gallery"\)/);

  assert.match(stackController, /POST[\s\S]*?\/api\/asset-stacks/);
  assert.match(stackController, /\/order/);
  assert.match(stackController, /removeSelectedFromStack/);
  assert.match(stackController, /stackViewIsUnfiltered/);
  assert.match(stackController, /!state\.nextCursor && state\.assets\.length >= Number\(state\.pageTotal/);
  assert.match(stackController, /if \(event\.shiftKey\) return/);
  assert.doesNotMatch(stackController, /selected\.has\(assetId\) \|\| state\.selectedId === assetId/,
    "an unselected ordinary card must be draggable without a preparatory click");
  assert.match(stackController, /const candidateIds = dragIdsForCard\(state, assetId\)/,
    "direct drag still preserves an existing multi-selection when appropriate");
  const createGhost = stackController.slice(
    stackController.indexOf("function createGhost"),
    stackController.indexOf("function syncChrome"),
  );
  assert.match(createGhost, /sourceCard[\s\S]*?sourceButton[\s\S]*?sourceMedia/,
    "drag feedback resolves the actual source card media");
  assert.match(createGhost, /sourceMedia\.cloneNode\(true\)/,
    "drag feedback previews the dragged asset instead of an empty rectangle");
  assert.match(createGhost, /const count = dragGhostCount\(drag\)/,
    "collapsed Stack drag feedback counts the logical Stack node rather than the surrounding batch selection");
  assert.match(createGhost, /if \(count > 1\)[\s\S]*?asset-stack-drag-count/,
    "multi-asset drags add a count badge on top of the media preview");
  assert.match(stackController, /marker\.style\.transform = `translate3d\(\$\{clientX \+ 14\}px, \$\{clientY \+ 14\}px, 0\)`/,
    "the drag preview follows the pointer position every animation frame");
  assert.match(css, /\.asset-stack-drag-preview \{[^}]*opacity: 0;[^}]*transform: rotate\(2deg\) scale\(\.92\);[^}]*transition:/,
    "the media preview has an entrance animation without adding pointer lag");
  assert.match(css, /\.asset-stack-drag-ghost\.is-visible \.asset-stack-drag-preview \{[^}]*opacity: \.94;[^}]*scale\(1\)/,
    "the media preview settles into a visible lifted state");
  assert.match(stackController, /if \(!targetId \|\| drag\.assetIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /if \(movingIds\.includes\(targetId\)\) return false/);
  assert.match(stackController, /STACK_DRAG_THRESHOLD_PX = 8/);
  assert.match(stackController, /setPointerCapture\(event\.pointerId\)/);
  assert.match(stackController, /if \(pointerMoveFrame !== null\) \{\s+cancelAnimationFrame\(pointerMoveFrame\);\s+pointerMoveFrame = null;\s+flushPointerMove\(\);/,
    "pointerup flushes a coalesced move before resolving the drop target");
  const endPointer = stackController.slice(
    stackController.indexOf("function endPointer"),
    stackController.indexOf("async function finishGroupDrop"),
  );
  assert.match(endPointer, /const groupTarget = dropGroupTarget;/,
    "sidebar drops snapshot their target before visual drag state is cleared");
  assert.ok(endPointer.indexOf("const groupTarget = dropGroupTarget;") < endPointer.indexOf("removeGhost();"),
    "sidebar drop target must survive removeGhost/clearDropTarget until the mutation is scheduled");
  assert.match(endPointer, /if \(groupTarget\)[\s\S]*?drag\.stackId[\s\S]*?finishStackGroupDrop\(drag\.stackId, value\)[\s\S]*?finishGroupDrop\(drag\.assetIds, value\)/,
    "the preserved sidebar target routes Stack nodes and ordinary assets to distinct group mutations");
  assert.match(stackController, /const draggedStackId = !state\.activeStackId \? String\(draggedAsset\?\.stack\?\.id \|\| ""\) : "";/,
    "collapsed Stack drags carry their logical stack id");
  assert.match(stackController, /if \(pointer\.stackId\) return;[\s\S]*?const target = targetCardAt/,
    "a collapsed Stack can target sidebar groups but never falls through to Stack-on-Stack merge");
  assert.match(stackController, /async function finishStackGroupDrop\(stackId, groupName\)[\s\S]*?\/api\/asset-stacks\/\$\{encodeURIComponent\(stackId\)\}\/group/,
    "Stack sidebar drops use the Stack-level navigation-group endpoint");
  assert.match(stackController, /gallerySelection\.snapshotSelection\?\.\(\)/,
    "Stack entry snapshots selection through the selection state machine");
  assert.match(stackController, /gallerySelection\.restoreSelection\(\{[\s\S]*?allowedIds: visibleIds/,
    "Stack exit restores batch selection through the selection state machine instead of assigning internal state directly");
  assert.match(stackController, /lostpointercapture/);
  assert.match(stackController, /window\.addEventListener\("blur"/);
  assert.match(stackController, /moveBlockRelative\(currentIds, drag\.assetIds, targetId, placement\)/);
  assert.match(stackController, /runStackMutation/);
  assert.match(stackController, /state\.storageKind !== "sqlite"/);
  assert.match(stackController, /abandonStackContext/);
  assert.match(stackController, /function isBusy\(\)/);
  assert.doesNotMatch(stackController, /create.*folder|folder.*create/i);

  assert.match(selection, /state\.assetStackDragCandidate/);
  // 含堆叠选区不能再堆叠的守卫随底部批量栏退役，搬到右键菜单
  // stackSelected 项的可见性里；JSON 存储守卫同批迁移到菜单项置灰。
  assert.doesNotMatch(selection, /selectionStack|selectionRemoveFromStack|selectionSelectAll|selectionClear|selectionBar/,
    "the removed selection bar must not leave sync residue in gallery-selection");
  assert.match(contextActions, /label: t\("stackSelected"\)[\s\S]{0,400}?disabled: state\.storageKind !== "sqlite" \|\| stackMutationInFlight\(\),/,
    "the context-menu stack action keeps the storage and in-flight guards the bar used to carry");

  assert.match(contextActions, /if \(options\.stackNode && asset\?\.stack\?\.id && logicalSelectionCount\(selectedAssets, options\) === 1\)/);
  assert.match(contextActions, /mosa:open-stack/);
  assert.match(contextActions, /openStackRenameModal\?\.\(\{/,
    "the Stack menu routes rename through the shared rename modal collector");
  assert.match(contextActions, /applyStackGroupMutation\(projectId, stackId, groupName\)/,
    "the collapsed Stack context menu can move the whole Stack to a navigation group");
  assert.match(contextActions, /stackMovedToGroup/,
    "Stack group moves report Stack-level feedback instead of pretending only the cover moved");
  assert.match(contextActions, /method: "PATCH"/,
    "renaming a stack persists through the stack PATCH route");
  assert.match(contextActions, /dissolveStack/);
  assert.match(contextActions, /method: "DELETE"/);
  assert.match(contextActions, /stackTrashTitle/,
    "moving a stack to Trash confirms with the member count before mutating");
  const stackMenu = contextActions.slice(
    contextActions.indexOf("if (options.stackNode"),
    contextActions.lastIndexOf("const selectionCount = logicalSelectionCount"),
  );
  assert.match(stackMenu, /danger: true/,
    "the destructive Stack action reuses the shared danger item styling");
  assert.ok(stackMenu.indexOf("label: t(\"dissolveStack\")") < stackMenu.indexOf("label: t(\"moveToTrash\")"),
    "the structural dissolve action precedes the destructive trash action");
  assert.match(contextActions, /action: "trash"/,
    "stack trash reuses the ordinary per-asset batch trash mutation");
  assert.match(contextActions, /gallerySelection\?\.resolveSelectedAssetIds/,
    "mixed Stack selections resolve to real member asset IDs at mutation time");
  assert.match(contextBindings, /stackNode: !state\.activeStackId && Boolean\(asset\.stack\?\.id\)/);
  assert.match(contextBindings, /stack-updated/,
    "rename refresh events flow through the incremental stack reconciliation");
  assert.match(contextBindings, /if \(!selectedIds\.has\(asset\.id\)\) \{[\s\S]*?gallerySelection\?\.replaceWith\?\.\(asset\.id\)/,
    "right-clicking outside the current selection first makes that card the selection");
  assert.match(contextBindings, /selectionCount: selectedIds\.size/);

  // 任务 123：#stackBack 已删除——导航组里只有后退/前进两个按钮，「在不在
  // 堆叠里」由 body[data-in-stack] 表达（窄屏样式与 e2e 的判断依据）。
  assert.doesNotMatch(html, /id="stackBack"/);
  assert.doesNotMatch(css, /\.stack-back/);
  assert.match(stackController, /data-in-stack/,
    "the stack controller owns the body[data-in-stack] marker through syncChrome");
  assert.match(stackController, /async function exitMissingStack\(\)/,
    "exiting a vanished stack (dissolved / members emptied / missing) has its own entry");
  // 底部批量栏已移除：堆叠/移出堆叠走右键菜单，由 actions 路由回控制器。
  assert.doesNotMatch(html, /id="selectionStack"|id="selectionRemoveFromStack"/);
  assert.match(contextActions, /label: t\("stackSelected"\)[\s\S]{0,400}?action: async \(\) => \{\s*await assetStacks\?\.createStackFromSelection\?\.\(\);/,
    "the multi-selection context menu stacks through the controller's own guard chain");
  assert.match(contextActions, /label: t\("removeFromStack"\)[\s\S]{0,400}?action: async \(\) => \{\s*await assetStacks\?\.removeSelectedFromStack\?\.\(\);/,
    "stack-interior context menus remove members through the controller");
  assert.match(contextActions, /label: t\("backToLibrary"\)[\s\S]{0,300}?await assetStacks\?\.exitStack\?\.\(\);/,
    "the stack-interior empty-grid menu exits through the shared exit pipeline");
  assert.match(contextActions, /onRenamed: \(nextName\) => \{/,
    "in-stack rename refreshes the active stack summary and chrome after the shared dialog succeeds");
  assert.match(contextActions, /onDissolved: \(\) => assetStacks\?\.exitMissingStack\?\.\(\)/,
    "in-stack dissolve reuses the shared confirmation and then exits as a vanished stack (任务 123)");
  assert.match(html, /id="stackRenameModal"/,
    "stack rename reuses the shared modal-overlay/modal-card shell");
  assert.match(html, /id="stackRenameInput"/);
  assert.match(app, /function openStackRenameModal/);
  assert.match(app, /stackRenameModal\?\.classList\.contains\("open"\)/,
    "the rename modal joins the shared keyboard/overlay guard chains");
  assert.match(app, /stackNameRequired/,
    "an empty final stack name is rejected at the modal before any request");
  assert.match(app, /stackName \|\| cardShortTitle\(asset\)/,
    "a custom stack name takes over the collapsed card title");
  assert.match(app, /asset\.stack\?\.name \|\| ""/,
    "the card render key includes the stack name so renames re-render");
  assert.match(app, /stackNamedItemCount/);
  assert.match(css, /\.asset-card\.is-stack/);
  assert.match(css, /\.asset-stack-count/);
  assert.match(css, /\.asset-card\.stack-drop-target/);
  assert.match(css, /\.stack-reorder-before/);
  assert.match(css, /\.stack-reorder-after/);
  assert.match(css, /\.asset-card\.is-stack\.is-video \.video-badge/);
  assert.match(css, /\.stack-inspector-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);

  assert.match(i18n, /stackSelected: "堆叠所选"/);
  assert.match(i18n, /stackInspectorTitle: "堆叠检视器"/);
  assert.match(i18n, /stackOrderChanged: "堆叠内容已发生变化，已刷新，请重新拖动排序"/);
  assert.match(i18n, /stackSelected: "Stack selected"/);
  assert.doesNotMatch(i18n, /stackAssets:/, "the retired selection-bar label must not survive as a dead i18n key");
  assert.match(i18n, /stackInspectorTitle: "Stack inspector"/);
  assert.match(i18n, /stackOrderChanged: "The stack changed while you were reordering it\. It has been refreshed; drag again\."/);
  assert.match(i18n, /operationInProgress:/);
  assert.match(i18n, /searchStack:/);
  assert.match(i18n, /stackMatchCount:/);
  assert.match(i18n, /dissolveStack:/);
  assert.match(i18n, /renameStack: "重命名堆叠"/);
  assert.match(i18n, /stackTrashDescription: "其中的 \{count\} 个素材也会一起移到回收站。你可以之后从回收站恢复。"/);
  assert.match(i18n, /renameStack: "Rename stack"/);
  assert.match(i18n, /stackTrashDescription: "Its \{count\} assets will also move to Trash\. You can restore them later from Trash\."/);
});
