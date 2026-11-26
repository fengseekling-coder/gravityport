// GravityPort React UI flow (task 421 / 472):
// 1. Default built mode (no localStorage flag) routes 版本树 -> 查看 directly into VersionCanvas,
//    hiding the gallery inspector, showing moved 版本对比 / 生成关系 / 版本历史 panels,
//    confirming a suggested candidate edge via real HTTP APIs, dragging to link, and returning cleanly.
// 2. Right-clicking a card with a tree offers「查看版本树」and opens VersionCanvas.
// 3. Setting localStorage "gravityport.dev.version-canvas"="0" falls back to the inline list and hides
//    right-click「查看版本树」, with confirmed relations persisted.
// 4. 960x640 narrow window layout, right-click latency & race guard, and trashed assets staying inline.
export const name = "version-canvas";
export const description = 'default 查看 enters VersionCanvas -> reload/reset -> right-click 查看版本树 -> "0" fallback expands inline -> 960px layout -> menu latency/race -> trash keeps inline';

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("vc-e2e-parent.png", [48, 86, 128]),
      prompt: "poster v1 sunlit bottle",
    });
    const parent = parentCreate.asset;

    const childCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("vc-e2e-child.png", [164, 92, 62], { width: 180, height: 320 }),
      prompt: "poster v2 warmer rim light",
    });
    const child = childCreate.asset;

    const siblingCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("vc-e2e-sibling.png", [72, 140, 96]),
      prompt: "poster v3 sibling",
    });
    const sibling = siblingCreate.asset;

    const soloCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("vc-e2e-solo.png", [120, 120, 120]),
      prompt: "solo card without generation history",
    });
    const solo = soloCreate.asset;

    await ctx.api(server.origin, "POST", `/api/assets/default/${encodeURIComponent(parent.id)}/versions`, {
      version_change: "version canvas e2e family item",
    });

    await ctx.api(server.origin, "POST", "/api/generations", {
      outputAssetId: parent.id,
      provider: "chatgpt",
      providerAssetId: "vc-e2e-chat-parent",
      conversationId: "vc-e2e-conv",
      messageId: "vc-e2e-msg-1",
      effectivePrompt: "poster v1 sunlit bottle",
      verificationLevel: "observed",
      createdAt: "2026-11-14T10:00:00.000Z",
    });

    await ctx.api(server.origin, "POST", "/api/generations", {
      outputAssetId: child.id,
      provider: "chatgpt",
      conversationId: "vc-e2e-conv",
      messageId: "vc-e2e-msg-2",
      effectivePrompt: "warmer rim light around neck",
      references: [{ provider_asset_id: "vc-e2e-chat-parent" }],
      verificationLevel: "observed",
      createdAt: "2026-11-14T10:05:00.000Z",
    });

    await ctx.api(server.origin, "POST", "/api/generations", {
      outputAssetId: sibling.id,
      provider: "chatgpt",
      conversationId: "vc-e2e-conv",
      messageId: "vc-e2e-msg-3",
      effectivePrompt: "same conversation, no reference",
      verificationLevel: "observed",
      createdAt: "2026-11-14T10:10:00.000Z",
    });

    const onResult = await ctx.runInPage(server, roundOnSource({ parentId: parent.id, childId: child.id, siblingId: sibling.id }), {
      windowSize: [1440, 940],
    });
    if (
      onResult?.canvasMounted !== true
      || onResult?.detailsHidden !== true
      || onResult?.memoryHintAbsent !== true
      || onResult?.sampleAbsent !== true
      || onResult?.inspectorSectionsPresent !== true
      || onResult?.confirmedOnCanvas !== true
      || onResult?.finalBadgeUpdated !== true
      || onResult?.annotationBoxTightFit !== true
      || onResult?.cardMovedOnDrag !== true
      || onResult?.noteSyncedToMainDetails !== true
      || onResult?.persistedAcrossReopen !== true
      || onResult?.returnedToGallery !== true
      || onResult?.linkedByDrag !== true
      || onResult?.comparedByMenu !== true
      || onResult?.zoomAfterViewer !== true
      || onResult?.tooltipShown !== true
      || onResult?.typeSavedOnPick !== true
    ) {
      throw new Error(`version-canvas default-on flow failed: ${JSON.stringify(onResult)}`);
    }

    const reloadResult = await ctx.runInPage(server, roundReloadAndReverseEditSource({
      childId: child.id,
      autoLeft: onResult.autoLeft,
      autoTop: onResult.autoTop,
      draggedLeft: onResult.draggedLeft,
      draggedTop: onResult.draggedTop,
    }), {
      windowSize: [1440, 940],
    });
    if (
      reloadResult?.persistedAfterReload !== true
      || reloadResult?.mainEditSyncedToCanvas !== true
      || reloadResult?.resetReturnedToAutoLayout !== true
    ) {
      throw new Error(`version-canvas reload/reverse-edit/reset check failed: ${JSON.stringify(reloadResult)}`);
    }

    const afterResetResult = await ctx.runInPage(server, roundAfterResetSource({
      childId: child.id,
      autoLeft: onResult.autoLeft,
      autoTop: onResult.autoTop,
    }), {
      windowSize: [1440, 940],
    });
    if (
      afterResetResult?.resetPersistedAfterReload !== true
      || afterResetResult?.escCancelled !== true
      || afterResetResult?.failureRolledBack !== true
      || typeof afterResetResult?.menuLatencyMs !== "number"
    ) {
      throw new Error(`version-canvas post-reset right-click check failed: ${JSON.stringify(afterResetResult)}`);
    }

    const fallbackResult = await ctx.runInPage(server, roundFallbackSource({ parentId: parent.id }), {
      windowSize: [1440, 940],
    });
    if (
      fallbackResult?.inlineExpanded !== true
      || fallbackResult?.canvasMounted !== false
      || fallbackResult?.hasConfirmedSection !== true
      || fallbackResult?.hasCandidateActions !== false
      || fallbackResult?.fallbackMenuOmitsCanvas !== true
    ) {
      throw new Error(`version-canvas fallback ("0") check failed: ${JSON.stringify(fallbackResult)}`);
    }

    const historyRes = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(parent.id)}/generation-history`);
    const history = historyRes?.history;
    const userConfirmed = (history?.relations || []).some((rel) => rel.verification_level === "user_confirmed");
    const dragLinkPersisted = (history?.relations || []).some((rel) => (
      rel.verification_level === "user_confirmed"
      && rel.relation_type === "edited_from"
      && rel.evidence?.canvas_link === true
    ));
    const suggestedLeft = (history?.relation_candidates || []).some((cand) => cand.status === "suggested");
    if (!userConfirmed || suggestedLeft || !dragLinkPersisted) {
      throw new Error(`version-canvas HTTP persistence mismatch: ${JSON.stringify({ userConfirmed, suggestedLeft, dragLinkPersisted })}`);
    }

    const narrowResult = await ctx.runInPage(server, roundNarrow960Source({ parentId: parent.id }), {
      windowSize: [960, 640],
    });
    if (
      narrowResult?.canvasNodes < 2
      || narrowResult?.inspectorVisible !== true
      || !(narrowResult?.inspectorWidth >= 240)
      || !(narrowResult?.stageWidth >= 300)
      || narrowResult?.exportInHeader !== true
      || narrowResult?.returnedToGallery !== true
    ) {
      throw new Error(`version-canvas 960x640 narrow layout check failed: ${JSON.stringify(narrowResult)}`);
    }

    const menuRaceResult = await ctx.runInPage(server, roundMenuLatencyAndRaceSource({
      parentId: parent.id,
      childId: child.id,
      soloId: solo.id,
    }), {
      windowSize: [1440, 940],
    });
    if (
      menuRaceResult?.race200Ok !== true
      || menuRaceResult?.race600Ok !== true
      || typeof menuRaceResult?.selectedMenuMedianMs !== "number"
      || typeof menuRaceResult?.otherMenuMedianMs !== "number"
    ) {
      throw new Error(`version-canvas menu latency/race check failed: ${JSON.stringify(menuRaceResult)}`);
    }

    const trashed = await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "trash",
      projectId: "default",
      assetIds: [sibling.id],
    });
    if (!JSON.stringify(trashed).includes(`"${sibling.id}"`)) {
      throw new Error(`version-canvas trash setup did not confirm sibling: ${JSON.stringify(trashed).slice(0, 200)}`);
    }

    const trashResult = await ctx.runInPage(server, roundTrashSource({ siblingId: sibling.id }), {
      windowSize: [1440, 940],
    });
    if (
      trashResult?.inlineExpanded !== true
      || trashResult?.canvasMounted !== false
      || trashResult?.trashMenuOmitsCanvas !== true
    ) {
      throw new Error(`version-canvas trash inline check failed: ${JSON.stringify(trashResult)}`);
    }

    return {
      parentId: parent.id,
      childId: child.id,
      ...onResult,
      menuLatencyMs: afterResetResult.menuLatencyMs,
      selectedMenuMedianMs: menuRaceResult.selectedMenuMedianMs,
      otherMenuMedianMs: menuRaceResult.otherMenuMedianMs,
      selectedMenuLatenciesMs: menuRaceResult.selectedMenuLatenciesMs,
      otherMenuLatenciesMs: menuRaceResult.otherMenuLatenciesMs,
      race200Ok: menuRaceResult.race200Ok,
      race600Ok: menuRaceResult.race600Ok,
      narrow960: narrowResult,
      trashInlineOk: true,
      persistedUserConfirmed: userConfirmed,
      persistedDragLink: dragLinkPersisted,
    };
  } finally {
    await server.stop();
  }
}

const HELPERS = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(check, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    let stable = 0;
    while (Date.now() < deadline) {
      const value = check();
      if (value) {
        stable += 1;
        if (stable >= 2) return value;
      } else {
        stable = 0;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label
      + ' | cards=' + document.querySelectorAll('.asset-card').length
      + ' | details=' + Boolean(document.querySelector('.details'))
      + ' | canvas=' + Boolean(document.querySelector('.version-canvas')));
  }
  const cardById = (id) => Array.from(document.querySelectorAll('.asset-card'))
    .find((card) => card.dataset.assetId === id) || null;
  const findVersionTreeButton = () => {
    const sections = Array.from(document.querySelectorAll('.details .detail-section'));
    const versionSection = sections.find((sec) => sec.querySelector('.field-heading')?.textContent?.includes('版本树'));
    return versionSection?.querySelector('button.section-action') || null;
  };
  const setReactValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const menuButton = (label) => {
    const menu = document.querySelector('.context-menu');
    if (!menu) return null;
    return Array.from(menu.querySelectorAll('button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label)) || null;
  };
  const menuLabels = () => Array.from(document.querySelectorAll('.context-menu > .menu-row > button'))
    .map((button) => Array.from(button.querySelectorAll(':scope > span')).map((span) => span.textContent.trim()).join(''));
  const closeContextMenu = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.context-menu'), 'context menu closes');
  };
  const openContextMenuMeasured = (card, clientX = 480, clientY = 320) => new Promise((resolve, reject) => {
    const start = performance.now();
    let done = false;
    const finish = (menu) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve({ menu, latencyMs: Math.round((performance.now() - start) * 100) / 100 });
    };
    const observer = new MutationObserver(() => {
      const menu = document.querySelector('.context-menu');
      if (menu) finish(menu);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      observer.disconnect();
      reject(new Error('Timed out waiting for context menu'));
    }, 10000);
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY }));
    const immediate = document.querySelector('.context-menu');
    if (immediate) finish(immediate);
  });
`;

function roundFallbackSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    try {
      const flagValue = localStorage.getItem('gravityport.dev.version-canvas');
      if (flagValue !== '0') throw new Error('expected fallback key "0", got ' + JSON.stringify(flagValue));
      await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'seeded parent card (fallback "0")');
      (await waitFor(() => cardById(config.parentId), 'parent card click')).click();
      await waitFor(() => Boolean(document.querySelector('.details .asset-title')) && Boolean(findVersionTreeButton()), 'inspector & 版本树 button');
      findVersionTreeButton().click();
      await waitFor(() => Boolean(document.querySelector('.details .version-tree')), 'inline version tree expands');
      const inlineExpanded = Boolean(document.querySelector('.details .version-tree'));
      const canvasMounted = Boolean(document.querySelector('.version-canvas'));
      const detailsText = document.querySelector('.details')?.textContent || '';
      const hasConfirmedSection = detailsText.includes('生成关系');
      const hasCandidateActions = Boolean(document.querySelector('.details .relation-candidate-actions'))
        || detailsText.includes('确认关系');

      const parentCard = await waitFor(() => cardById(config.parentId), 'parent card for fallback menu');
      await openContextMenuMeasured(parentCard, 480, 320);
      const fallbackMenuOmitsCanvas = !menuLabels().includes('查看版本树');
      await closeContextMenu();
      return { inlineExpanded, canvasMounted, hasConfirmedSection, hasCandidateActions, fallbackMenuOmitsCanvas };
    } finally {
      localStorage.removeItem('gravityport.dev.version-canvas');
    }
  })()`;
}

function roundOnSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    const flagValue = localStorage.getItem('gravityport.dev.version-canvas');
    if (flagValue !== null) throw new Error('expected default localStorage key null, got ' + JSON.stringify(flagValue));
    await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'seeded parent card (default on)');
    (await waitFor(() => cardById(config.parentId), 'parent card click')).click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')) && Boolean(findVersionTreeButton()), 'inspector & 版本树 button');
    findVersionTreeButton().click();

    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && document.querySelectorAll('.vc-node').length >= 2, 'VersionCanvas mounts with nodes');
    const canvasMounted = Boolean(document.querySelector('.version-canvas'));
    const detailsHidden = !document.querySelector('.details') && document.querySelector('.app')?.classList.contains('canvas-open');
    const canvasText = document.querySelector('.version-canvas')?.textContent || '';
    const memoryHintAbsent = (
      !document.querySelector('.vc-memory-status')
      && !document.querySelector('.vc-inspector-footer')
      && !canvasText.includes('本页暂存')
      && !canvasText.includes('画布修改仅保留在当前页面')
    );
    const sampleAbsent = !canvasText.includes('exampleCanvas') && !canvasText.includes('示例') && !canvasText.includes('coffee');
    const inspectorText = document.querySelector('.vc-inspector')?.textContent || '';
    const inspectorSectionsPresent = ['生成关系', '版本对比', '版本历史']
      .every((heading) => inspectorText.includes(heading));

    // Suggested edges are unlabeled dashed lines; confirm from the inspector list.
    await waitFor(() => document.querySelector('.vc-edges g.suggested'), 'suggested edge drawn as a dashed line');
    const unlabeled = !(document.querySelector('.version-canvas .vc-board-area')?.textContent || '').includes('可能改自');
    const confirmBtn = await waitFor(() => Array.from(document.querySelectorAll('.vc-inspector button'))
      .find((button) => button.textContent.trim() === '确认关系'), 'inspector suggestion confirm button');
    confirmBtn.click();
    await waitFor(() => (
      !document.querySelector('.vc-edges g.suggested')
      && document.querySelectorAll('.vc-edges g:not(.suggested):not(.vc-link-draft)').length >= 1
    ), 'suggested candidate becomes solid confirmed edge');
    const confirmedOnCanvas = (
      unlabeled
      && !document.querySelector('.vc-edges g.suggested')
      && (document.querySelector('.vc-inspector')?.textContent || '').includes('删除关系')
      && !(document.querySelector('.vc-inspector')?.textContent || '').includes('保存关系')
    );

    // Picking a relation type saves it at once (no 保存关系 button): choose 变体
    // in the app dropdown, wait for the 已保存 toast, and the dropdown keeps it
    // after the history refresh clears the drafts.
    const typeTrigger = () => document.querySelector('.vc-inspector .generation-relation-editor .toolbar-select');
    (await waitFor(() => typeTrigger(), 'relation type dropdown')).click();
    const variantOption = await waitFor(() => Array.from(document.querySelectorAll('.toolbar-select-option'))
      .find((option) => option.textContent.trim() === '变体'), '变体 option');
    variantOption.click();
    await waitFor(() => (document.querySelector('.vc-toast')?.textContent || '').includes('已保存'), 'relation type saved toast');
    await waitFor(() => (typeTrigger()?.textContent || '').includes('变体'), 'dropdown keeps the saved type');
    const typeSavedOnPick = (typeTrigger()?.textContent || '').includes('变体');

    // Drag from the confirmed child's right dot onto the unlinked sibling card.
    const nodeEl = (id) => document.querySelector('.vc-node[data-canvas-node="' + id + '"]');
    await waitFor(() => nodeEl(config.childId) && nodeEl(config.siblingId), 'child and sibling cards on canvas');
    const solidBefore = document.querySelectorAll('.vc-edges g:not(.suggested):not(.vc-link-draft)').length;
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const port = nodeEl(config.childId).querySelector('.vc-port-out');
    const stageEl = document.querySelector('.vc-stage');
    const from = center(port);
    const to = center(nodeEl(config.siblingId));
    const pointer = (type, target, at) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: at.x, clientY: at.y,
    }));
    pointer('pointerdown', port, from);
    await sleep(50);
    pointer('pointermove', stageEl, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
    await waitFor(() => document.querySelector('.vc-edges .vc-link-draft'), 'draft line follows the pointer');
    pointer('pointermove', stageEl, to);
    await waitFor(() => nodeEl(config.siblingId)?.classList.contains('is-link-target'), 'sibling highlights as drop target');
    pointer('pointerup', stageEl, to);
    await waitFor(() => (
      !document.querySelector('.vc-edges .vc-link-draft')
      && document.querySelectorAll('.vc-edges g:not(.suggested):not(.vc-link-draft)').length > solidBefore
    ), 'dragged link becomes a solid edge');
    const linkedByDrag = true;

    // Shift-select the pair, right-click one of them, compare.
    const clickImage = (id, shiftKey) => nodeEl(id).querySelector('.vc-node-image')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
    clickImage(config.childId, false);
    await sleep(100);
    clickImage(config.siblingId, true);
    await waitFor(() => (document.querySelector('.vc-inspector')?.textContent || '').includes('已选择 2 张素材'), 'two cards selected');
    const sib = center(nodeEl(config.siblingId));
    nodeEl(config.siblingId).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: sib.x, clientY: sib.y }));
    const compareItem = await waitFor(() => Array.from(document.querySelectorAll('.vc-context-menu button'))
      .find((button) => button.textContent.trim() === '对比所选素材'), 'compare item in the card menu');
    compareItem.click();
    await waitFor(() => Array.from(document.querySelectorAll('dialog[open]')).some((dialog) => dialog.textContent.includes('版本对比')), 'compare dialog opens');
    const comparedByMenu = !document.querySelector('.vc-board-actions')?.textContent.includes('对比');
    Array.from(document.querySelectorAll('dialog[open] button')).find((button) => button.getAttribute('aria-label') === '关闭')?.click();
    await waitFor(() => !Array.from(document.querySelectorAll('dialog[open]')).some((dialog) => dialog.textContent.includes('版本对比')), 'compare dialog closes');
    clickImage(config.childId, false);
    await waitFor(() => Boolean(document.querySelector('.vc-inspector .asset-summary')), 'back to a single selection');

    const finalBtn = await waitFor(() => document.querySelector('.version-canvas button[aria-label="设为定稿"]'), 'final toggle button');
    finalBtn.click();
    await waitFor(() => (document.querySelector('.vc-header')?.textContent || '').includes('1 个定稿'), 'header updates final count');
    const finalBadgeUpdated = (document.querySelector('.vc-header')?.textContent || '').includes('1 个定稿');

    // 查看大图 opens the gallery viewer inside the canvas; after 返回 the board
    // must still pinch / ⌘-scroll zoom (the stage remounts — 11-16 regression).
    let zoomAfterViewer = false;
    let zoomStepError = '';
    try {
      const worldScale = () => new DOMMatrix(getComputedStyle(document.querySelector('.vc-world')).transform).a;
      document.querySelector('.vc-inspector .summary-preview').click();
      await waitFor(() => document.querySelector('.vc-viewer .image-viewer'), 'big-image viewer opens in the canvas');
      const viewerOpened = Boolean(document.querySelector('.vc-viewer-header .viewer-title'));
      document.querySelector('.vc-viewer-header button').click();
      await waitFor(() => document.querySelector('.vc-stage') && !document.querySelector('.vc-viewer'), 'viewer closes back to the board');
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const scaleBefore = worldScale();
      const viewerStageEl = document.querySelector('.vc-stage');
      const stageRect = viewerStageEl.getBoundingClientRect();
      viewerStageEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: stageRect.left + 100, clientY: stageRect.top + 100 }));
      await waitFor(() => worldScale() > scaleBefore, 'pinch zoom works after the viewer closes');
      zoomAfterViewer = viewerOpened && worldScale() > scaleBefore;
    } catch (error) { zoomStepError = String(error && error.message || error); }

    // App tooltip (tooltip.ts): hovering an icon-only button shows its name in
    // the app's own label; the title comes back once the pointer leaves.
    const exportBtn = document.querySelector('.version-canvas button[aria-label="导出版本树"]');
    exportBtn.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
    const tipEl = await waitFor(() => {
      const el = document.querySelector('.app-tooltip');
      return el && !el.hidden && el.textContent === '导出版本树' ? el : null;
    }, 'app tooltip for the export button');
    const tipInApp = Boolean(tipEl.closest('.app')) && !exportBtn.hasAttribute('title');
    exportBtn.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body }));
    const tooltipShown = tipInApp && document.querySelector('.app-tooltip').hidden && exportBtn.getAttribute('title') === '导出版本树';

    // Edit note on child (click #vc-note-<id> -> InlineTextEditor textarea -> ⌘/Ctrl+Enter commits and persists).
    (await waitFor(() => document.getElementById('vc-note-' + config.childId), 'canvas note text')).click();
    const noteInput = await waitFor(() => document.querySelector('.vc-inspector .note-section textarea'), 'canvas note textarea');
    noteInput.focus();
    setReactValue(noteInput, 'canvas-e2e-note');
    await sleep(50);
    noteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await waitFor(() => (
      !document.querySelector('.vc-inspector .note-section textarea')
      && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'canvas-e2e-note'
      && (document.querySelector('.vc-toast')?.textContent || '').includes('已保存')
    ), 'canvas note saved');

    // Open annotation dialog on 9:16 portrait child, verify tight aspect fit, and add a mark.
    const annotateBtn = await waitFor(() => {
      const sec = Array.from(document.querySelectorAll('.vc-inspector .detail-section'))
        .find((el) => el.querySelector('.field-heading')?.textContent?.includes('标注'));
      return sec?.querySelector('button.section-action') || null;
    }, 'annotation add button');
    annotateBtn.click();
    const annImg = await waitFor(() => {
      const img = document.querySelector('.vc-annotation-image img');
      return img && img.complete && img.naturalWidth > 0 ? img : null;
    }, 'loaded annotation image');
    await sleep(80);
    const annBox = document.querySelector('.vc-annotation-image');
    const boxRect = annBox.getBoundingClientRect();
    const imgRect = annImg.getBoundingClientRect();
    const expectedRatio = annImg.naturalWidth / annImg.naturalHeight;
    const boxRatio = boxRect.width / boxRect.height;
    const annotationBoxTightFit = (
      Math.abs(boxRatio - expectedRatio) < 0.03
      && Math.abs(imgRect.width - boxRect.width) <= 2
      && Math.abs(imgRect.height - boxRect.height) <= 2
    );
    const annotationDebug = {
      boxWidth: boxRect.width,
      boxHeight: boxRect.height,
      imgWidth: imgRect.width,
      imgHeight: imgRect.height,
      naturalWidth: annImg.naturalWidth,
      naturalHeight: annImg.naturalHeight,
      ratioProp: annBox.style.getPropertyValue('--vc-annotation-ratio'),
    };
    annBox.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      detail: 1,
      clientX: boxRect.left + boxRect.width * 0.35,
      clientY: boxRect.top + boxRect.height * 0.25,
    }));
    const markInput = await waitFor(() => document.querySelector('.vc-annotation-fields input'), 'annotation mark text input');
    setReactValue(markInput, 'portrait-mark-fix');
    const annSaveBtn = await waitFor(() => Array.from(document.querySelectorAll('dialog[open] button'))
      .find((b) => b.textContent.trim() === '保存'), 'annotation dialog save button');
    annSaveBtn.click();
    await waitFor(() => (
      !document.querySelector('dialog[open] .vc-annotation')
      && (nodeEl(config.childId)?.querySelector('.vc-mark-badge')?.textContent || '').includes('1')
      && (document.querySelector('.vc-inspector')?.textContent || '').includes('portrait-mark-fix')
    ), 'annotation persisted to card badge & inspector');

    // Drag child card and release (persists position on pointerup).
    const dragStageEl = document.querySelector('.vc-stage');
    const childCard = nodeEl(config.childId);
    const autoLeft = parseFloat(childCard.style.left);
    const autoTop = parseFloat(childCard.style.top);
    const cardStart = center(childCard);
    const dragDelta = { x: 96, y: 64 };
    pointer('pointerdown', childCard, cardStart);
    await sleep(50);
    pointer('pointermove', dragStageEl, { x: cardStart.x + dragDelta.x, y: cardStart.y + dragDelta.y });
    await sleep(50);
    pointer('pointerup', dragStageEl, { x: cardStart.x + dragDelta.x, y: cardStart.y + dragDelta.y });
    await waitFor(() => Math.abs(parseFloat(nodeEl(config.childId).style.left) - autoLeft) > 20, 'dragged card shifted position');
    const draggedLeft = parseFloat(nodeEl(config.childId).style.left);
    const draggedTop = parseFloat(nodeEl(config.childId).style.top);
    const cardMovedOnDrag = Math.abs(draggedLeft - autoLeft) > 20 && Math.abs(draggedTop - autoTop) > 20;
    await sleep(250);

    // Close to gallery, verify main InspectorDetails shows the canvas note, then reopen without page refresh.
    const backBtn = await waitFor(() => document.querySelector('.version-canvas button[aria-label="返回素材库"]'), 'back button');
    backBtn.click();
    await waitFor(() => !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace')), 'canvas closes back to gallery');
    (await waitFor(() => cardById(config.childId), 'child card in gallery')).click();
    await waitFor(() => (document.querySelector('#asset-note')?.textContent || '').includes('canvas-e2e-note'), 'canvas note synced to main InspectorDetails');
    const noteSyncedToMainDetails = (document.querySelector('#asset-note')?.textContent || '').includes('canvas-e2e-note');

    (await waitFor(() => findVersionTreeButton(), 'reopen canvas button')).click();
    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && Boolean(nodeEl(config.childId)), 'VersionCanvas reopens without reload');
    await waitFor(() => (
      Boolean(nodeEl(config.childId)?.querySelector('.vc-final-badge'))
      && (nodeEl(config.childId)?.querySelector('.vc-mark-badge')?.textContent || '').includes('1')
      && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'canvas-e2e-note'
      && Math.abs(parseFloat(nodeEl(config.childId).style.left) - draggedLeft) <= 2
      && Math.abs(parseFloat(nodeEl(config.childId).style.top) - draggedTop) <= 2
    ), 'all 4 edits persist across close and reopen');
    const persistedAcrossReopen = true;

    const backBtn2 = await waitFor(() => document.querySelector('.version-canvas button[aria-label="返回素材库"]'), 'second back button');
    backBtn2.click();
    await waitFor(() => !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace')), 'canvas closes second time');
    const returnedToGallery = !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace'));

    return {
      canvasMounted,
      detailsHidden,
      memoryHintAbsent,
      sampleAbsent,
      inspectorSectionsPresent,
      confirmedOnCanvas,
      finalBadgeUpdated,
      annotationBoxTightFit,
      annotationDebug,
      cardMovedOnDrag,
      noteSyncedToMainDetails,
      persistedAcrossReopen,
      returnedToGallery,
      linkedByDrag,
      comparedByMenu,
      zoomAfterViewer,
      zoomStepError,
      tooltipShown,
      typeSavedOnPick,
      autoLeft,
      autoTop,
      draggedLeft,
      draggedTop,
    };
  })()`;
}

function roundReloadAndReverseEditSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    await waitFor(() => document.querySelector('.app') && cardById(config.childId), 'seeded child card after reload');
    cardById(config.childId).click();
    await waitFor(() => (document.querySelector('#asset-note')?.textContent || '').includes('canvas-e2e-note'), 'note persisted in main inspector after reload');

    // Edit note from main InspectorDetails -> open canvas -> verify reverse sync & all persisted canvas state.
    const noteBtn = document.querySelector('#asset-note');
    noteBtn.click();
    const noteArea = await waitFor(() => document.querySelector('.note-section textarea'), 'main inspector note textarea');
    noteArea.focus();
    setReactValue(noteArea, 'main-inspector-updated-note');
    await sleep(60);
    noteArea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await waitFor(() => !document.querySelector('.note-section textarea') && (document.querySelector('#asset-note')?.textContent || '').includes('main-inspector-updated-note'), 'main inspector note saved');

    (await waitFor(() => findVersionTreeButton(), 'open canvas after reverse edit')).click();
    const nodeEl = (id) => document.querySelector('.vc-node[data-canvas-node="' + id + '"]');
    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && Boolean(nodeEl(config.childId)), 'canvas mounts after reload');
    await waitFor(() => (
      Boolean(nodeEl(config.childId)?.querySelector('.vc-final-badge'))
      && (nodeEl(config.childId)?.querySelector('.vc-mark-badge')?.textContent || '').includes('1')
      && Math.abs(parseFloat(nodeEl(config.childId).style.left) - config.draggedLeft) <= 2
      && Math.abs(parseFloat(nodeEl(config.childId).style.top) - config.draggedTop) <= 2
    ), 'canvas state restored after reload');
    const persistedAfterReload = true;
    const mainEditSyncedToCanvas = (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note'
      && (document.querySelector('.vc-inspector')?.textContent || '').includes('portrait-mark-fix');

    // Click 重新排版 -> returns card to auto-layout while keeping final, marks, and note.
    const resetBtn = await waitFor(() => document.querySelector('.vc-header button[aria-label="重新排版"]'), 'reset layout button');
    resetBtn.click();
    await waitFor(() => (document.querySelector('.vc-toast')?.textContent || '').includes('已恢复自动排版'), 'reset layout toast confirms API save');
    await waitFor(() => (
      Math.abs(parseFloat(nodeEl(config.childId).style.left) - config.autoLeft) <= 2
      && Math.abs(parseFloat(nodeEl(config.childId).style.top) - config.autoTop) <= 2
    ), 'reset layout returns card to auto coordinates');
    const resetReturnedToAutoLayout = (
      Boolean(nodeEl(config.childId)?.querySelector('.vc-final-badge'))
      && (nodeEl(config.childId)?.querySelector('.vc-mark-badge')?.textContent || '').includes('1')
      && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note'
    );

    const backBtn = await waitFor(() => document.querySelector('.version-canvas button[aria-label="返回素材库"]'), 'back after reset');
    backBtn.click();
    await waitFor(() => !document.querySelector('.version-canvas'), 'canvas closed after reset');
    return { persistedAfterReload, mainEditSyncedToCanvas, resetReturnedToAutoLayout };
  })()`;
}

function roundAfterResetSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    await waitFor(() => document.querySelector('.app') && cardById(config.childId), 'seeded child card after post-reset reload');
    const childCard = await waitFor(() => cardById(config.childId), 'child card for right-click');
    const { latencyMs: menuLatencyMs } = await openContextMenuMeasured(childCard, 480, 320);
    const canvasMenuItem = await waitFor(() => menuButton('查看版本树'), 'right-click 查看版本树 item');
    canvasMenuItem.click();
    const nodeEl = (id) => document.querySelector('.vc-node[data-canvas-node="' + id + '"]');
    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && Boolean(nodeEl(config.childId)), 'canvas mounts from right-click menu');
    await waitFor(() => (
      Boolean(nodeEl(config.childId)?.querySelector('.vc-final-badge'))
      && (nodeEl(config.childId)?.querySelector('.vc-mark-badge')?.textContent || '').includes('1')
      && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note'
      && Math.abs(parseFloat(nodeEl(config.childId).style.left) - config.autoLeft) <= 2
      && Math.abs(parseFloat(nodeEl(config.childId).style.top) - config.autoTop) <= 2
    ), 'reset position and retained final/marks/note persisted across reload');

    // Esc cancels note edit and reverts to saved note.
    document.getElementById('vc-note-' + config.childId).click();
    const noteInput = await waitFor(() => document.querySelector('.vc-inspector .note-section textarea'), 'canvas note textarea for Esc test');
    noteInput.focus();
    setReactValue(noteInput, 'discard-by-esc');
    await sleep(40);
    noteInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.vc-inspector .note-section textarea') && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note', 'Esc reverts unsaved note');
    const escCancelled = (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note';

    // Failed save requests show toast "没有保存成功" and roll back local state.
    const origFetch = window.fetch;
    window.fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input?.url || '';
      if (target.includes('/canvas-state') || target.includes('/curation')) {
        return new Response(JSON.stringify({ error: 'simulated failure', code: 'SIMULATED_FAILURE' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
      return origFetch(input, init);
    };
    let failureRolledBack = false;
    try {
      const unfinalBtn = document.querySelector('.version-canvas button[aria-label="取消定稿"]');
      unfinalBtn.click();
      await waitFor(() => (
        (document.querySelector('.vc-toast')?.textContent || '').includes('没有保存成功')
        && Boolean(nodeEl(config.childId)?.querySelector('.vc-final-badge'))
      ), 'failed final toggle toasts and rolls back');

      document.getElementById('vc-note-' + config.childId).click();
      const failNote = await waitFor(() => document.querySelector('.vc-inspector .note-section textarea'), 'canvas note textarea for fail rollback');
      failNote.focus();
      setReactValue(failNote, 'failed-note-change');
      await sleep(40);
      failNote.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      await waitFor(() => (
        (document.querySelector('.vc-toast')?.textContent || '').includes('没有保存成功')
        && !document.querySelector('.vc-inspector .note-section textarea')
        && (document.getElementById('vc-note-' + config.childId)?.textContent || '') === 'main-inspector-updated-note'
      ), 'failed note save toasts and rolls back');
      failureRolledBack = true;
    } finally {
      window.fetch = origFetch;
    }

    localStorage.setItem('gravityport.dev.version-canvas', '0');
    return { resetPersistedAfterReload: true, escCancelled, failureRolledBack, menuLatencyMs };
  })()`;
}

function roundNarrow960Source(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    const flagValue = localStorage.getItem('gravityport.dev.version-canvas');
    if (flagValue !== null) throw new Error('expected null key before 960px check, got ' + JSON.stringify(flagValue));
    await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'parent card at 960x640');
    cardById(config.parentId).click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')) && Boolean(findVersionTreeButton()), 'inspector & 查看 at 960x640');
    findVersionTreeButton().click();
    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && document.querySelectorAll('.vc-node').length >= 2, 'canvas at 960x640');
    const canvasNodes = document.querySelectorAll('.vc-node').length;
    const inspectorEl = document.querySelector('.vc-inspector');
    const stageEl = document.querySelector('.vc-stage');
    const headerEl = document.querySelector('.vc-header');
    const exportBtn = document.querySelector('.version-canvas button[aria-label="导出版本树"]');
    const inspectorStyle = inspectorEl ? getComputedStyle(inspectorEl) : null;
    const inspectorRect = inspectorEl ? inspectorEl.getBoundingClientRect() : { width: 0 };
    const stageRect = stageEl ? stageEl.getBoundingClientRect() : { width: 0 };
    const headerRect = headerEl ? headerEl.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
    const exportRect = exportBtn ? exportBtn.getBoundingClientRect() : { width: 0, left: 0, right: 0, top: 0, bottom: 0 };
    const inspectorVisible = Boolean(inspectorStyle && inspectorStyle.display !== 'none');
    const inspectorWidth = Math.round(inspectorRect.width);
    const stageWidth = Math.round(stageRect.width);
    const exportInHeader = exportRect.width > 0
      && exportRect.left >= headerRect.left - 1
      && exportRect.right <= headerRect.right + 1
      && exportRect.top >= headerRect.top - 1
      && exportRect.bottom <= headerRect.bottom + 1;
    const backBtn = await waitFor(() => document.querySelector('.version-canvas button[aria-label="返回素材库"]'), 'back button at 960x640');
    backBtn.click();
    await waitFor(() => !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace')), 'return to gallery at 960x640');
    const returnedToGallery = !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace'));
    return { canvasNodes, inspectorVisible, inspectorWidth, stageWidth, exportInHeader, returnedToGallery };
  })()`;
}

function roundMenuLatencyAndRaceSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    const flagValue = localStorage.getItem('gravityport.dev.version-canvas');
    if (flagValue !== null) throw new Error('expected null key before menu latency/race, got ' + JSON.stringify(flagValue));
    await waitFor(() => document.querySelector('.app') && cardById(config.parentId) && cardById(config.childId) && cardById(config.soloId), 'all cards for latency/race');

    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1 ? sorted[mid] : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
    };

    const selectedId = () => document.querySelector('.asset-card.asset-selected')?.dataset.assetId || '';

    // 1. Right-click the asset already open in the inspector (5 trials).
    cardById(config.parentId).click();
    await waitFor(() => selectedId() === config.parentId
      && Boolean(document.querySelector('.details .asset-title'))
      && Boolean(findVersionTreeButton()), 'parent inspected with history');
    const selectedMenuLatenciesMs = [];
    for (let i = 0; i < 5; i += 1) {
      const { latencyMs } = await openContextMenuMeasured(cardById(config.parentId), 420, 320);
      if (!menuLabels().includes('查看版本树')) throw new Error('selected card menu missing 查看版本树 on trial ' + i);
      selectedMenuLatenciesMs.push(latencyMs);
      await closeContextMenu();
    }

    // 2. Right-click another asset not currently open in the inspector (5 trials).
    const otherMenuLatenciesMs = [];
    for (let i = 0; i < 5; i += 1) {
      cardById(config.soloId).click();
      await waitFor(() => selectedId() === config.soloId
        && Boolean(document.querySelector('.details .asset-title'))
        && !findVersionTreeButton(), 'solo inspected before trial ' + i);
      const { latencyMs } = await openContextMenuMeasured(cardById(config.parentId), 420, 320);
      if (!menuLabels().includes('查看版本树')) throw new Error('other card menu missing 查看版本树 on trial ' + i);
      otherMenuLatenciesMs.push(latencyMs);
      await closeContextMenu();
    }

    // 3. Race test: right-click A (has canvas, delayed generation-history) then
    //    within 50ms right-click B (solo, no canvas). Final menu must stay B's.
    const runRace = async (delayMs) => {
      cardById(config.childId).click();
      await waitFor(() => selectedId() === config.childId
        && Boolean(document.querySelector('.details .asset-title'))
        && Boolean(findVersionTreeButton()), 'child inspected before race ' + delayMs);
      await sleep(100);
      const origFetch = window.fetch;
      let delayedCalls = 0;
      window.fetch = async (input, init) => {
        const target = typeof input === 'string' ? input : input?.url || '';
        if (target.includes('/' + encodeURIComponent(config.parentId) + '/generation-history')
          || target.includes('/' + config.parentId + '/generation-history')) {
          delayedCalls += 1;
          await sleep(delayMs);
        }
        return origFetch(input, init);
      };
      try {
        cardById(config.parentId).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 220, clientY: 220 }));
        await sleep(50);
        cardById(config.soloId).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 520, clientY: 340 }));
        await waitFor(() => Boolean(document.querySelector('.context-menu')), 'B context menu opens in race ' + delayMs);
        await sleep(delayMs + 200);
        const menu = document.querySelector('.context-menu');
        if (!menu) throw new Error('context menu vanished during race ' + delayMs);
        const labels = menuLabels();
        const left = parseFloat(menu.style.left || '0');
        const hasCanvasItem = labels.includes('查看版本树');
        if (delayedCalls < 1) throw new Error('race ' + delayMs + ' did not intercept A generation-history');
        if (hasCanvasItem) throw new Error('race ' + delayMs + ' leaked 查看版本树 from A onto B: ' + JSON.stringify({ labels, left }));
        if (Math.abs(left - 520) > 80) throw new Error('race ' + delayMs + ' menu overwritten by A position: left=' + left);
        return true;
      } finally {
        window.fetch = origFetch;
        if (document.querySelector('.context-menu')) await closeContextMenu();
      }
    };

    const race200Ok = await runRace(200);
    const race600Ok = await runRace(600);

    return {
      selectedMenuLatenciesMs,
      selectedMenuMedianMs: median(selectedMenuLatenciesMs),
      otherMenuLatenciesMs,
      otherMenuMedianMs: median(otherMenuLatenciesMs),
      race200Ok,
      race600Ok,
    };
  })()`;
}

function roundTrashSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    const flagValue = localStorage.getItem('gravityport.dev.version-canvas');
    if (flagValue !== null) throw new Error('expected null key before trash check, got ' + JSON.stringify(flagValue));
    await waitFor(() => Boolean(document.querySelector('.app')) && Boolean(document.querySelector('.main-nav')), 'app ready for trash view');
    const trashBtn = await waitFor(() => Array.from(document.querySelectorAll('.main-nav button')).find((button) =>
      button.textContent.trim() === '回收站'
        || Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === '回收站')), '回收站 nav button');
    trashBtn.click();
    const siblingCard = await waitFor(() => cardById(config.siblingId), 'trashed sibling card');
    siblingCard.click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector for trashed sibling');
    const viewBtn = await waitFor(() => findVersionTreeButton(), '版本树 查看 button for trashed sibling');
    viewBtn.click();
    await waitFor(() => Boolean(document.querySelector('.details .version-tree')), 'trashed sibling expands inline version tree');
    const inlineExpanded = Boolean(document.querySelector('.details .version-tree'));
    const canvasMounted = Boolean(document.querySelector('.version-canvas'));

    const freshCard = await waitFor(() => cardById(config.siblingId), 'trashed sibling card for context menu');
    await openContextMenuMeasured(freshCard, 480, 320);
    const trashMenuOmitsCanvas = !menuLabels().includes('查看版本树');
    await closeContextMenu();
    return { inlineExpanded, canvasMounted, trashMenuOmitsCanvas };
  })()`;
}
