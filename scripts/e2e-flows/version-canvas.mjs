// GravityPort React UI flow (task 421):
// 1. Default built mode (DEV=false, no localStorage flag) keeps 版本树 -> 查看 inline.
// 2. Enabling localStorage "gravityport.dev.version-canvas"="1" routes 查看 directly into VersionCanvas,
//    hiding the gallery inspector, showing moved 版本对比 / 生成关系 / 版本历史 panels,
//    confirming a suggested candidate edge via real HTTP APIs, toggling in-memory final status, and returning cleanly.
// 3. Clearing the flag returns to legacy mode with the confirmed relation persisted and candidate removed.
export const name = "version-canvas";
export const description = "VERSION_CANVAS_ENTRY gate off->on -> 查看 enters VersionCanvas -> confirm candidate edge -> return -> gate off persists relation";

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

    const offResult = await ctx.runInPage(server, roundOffSource({ parentId: parent.id, setFlag: true }), {
      windowSize: [1440, 940],
    });
    if (offResult?.inlineExpanded !== true || offResult?.canvasMounted !== false) {
      throw new Error(`version-canvas gate-off check failed: ${JSON.stringify(offResult)}`);
    }

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
      throw new Error(`version-canvas gate-on flow failed: ${JSON.stringify(onResult)}`);
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
    ) {
      throw new Error(`version-canvas post-reset reload check failed: ${JSON.stringify(afterResetResult)}`);
    }

    const verifyOffResult = await ctx.runInPage(server, roundOffSource({ parentId: parent.id, setFlag: false }), {
      windowSize: [1440, 940],
    });
    if (
      verifyOffResult?.inlineExpanded !== true
      || verifyOffResult?.canvasMounted !== false
      || verifyOffResult?.hasConfirmedSection !== true
      || verifyOffResult?.hasCandidateActions !== false
    ) {
      throw new Error(`version-canvas persistence check failed: ${JSON.stringify(verifyOffResult)}`);
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

    return {
      parentId: parent.id,
      childId: child.id,
      ...onResult,
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
`;

function roundOffSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'seeded parent card (gate off)');
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
    if (config.setFlag) {
      localStorage.setItem('gravityport.dev.version-canvas', '1');
    } else {
      localStorage.removeItem('gravityport.dev.version-canvas');
    }
    return { inlineExpanded, canvasMounted, hasConfirmedSection, hasCandidateActions };
  })()`;
}

function roundOnSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${HELPERS}
    await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'seeded parent card (gate on)');
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
    cardById(config.childId).click();
    (await waitFor(() => findVersionTreeButton(), 'open canvas after reset reload')).click();
    const nodeEl = (id) => document.querySelector('.vc-node[data-canvas-node="' + id + '"]');
    await waitFor(() => Boolean(document.querySelector('.version-canvas')) && Boolean(nodeEl(config.childId)), 'canvas mounts post-reset reload');
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

    localStorage.removeItem('gravityport.dev.version-canvas');
    return { resetPersistedAfterReload: true, escCancelled, failureRolledBack };
  })()`;
}
