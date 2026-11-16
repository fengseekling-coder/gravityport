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
      imagePath: await ctx.makePng("vc-e2e-child.png", [164, 92, 62]),
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
      || onResult?.memoryPillPresent !== true
      || onResult?.sampleAbsent !== true
      || onResult?.inspectorSectionsPresent !== true
      || onResult?.confirmedOnCanvas !== true
      || onResult?.finalBadgeUpdated !== true
      || onResult?.returnedToGallery !== true
      || onResult?.linkedByDrag !== true
      || onResult?.comparedByMenu !== true
      || onResult?.zoomAfterViewer !== true
      || onResult?.tooltipShown !== true
      || onResult?.typeSavedOnPick !== true
    ) {
      throw new Error(`version-canvas gate-on flow failed: ${JSON.stringify(onResult)}`);
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
    const memoryPillPresent = (document.querySelector('.vc-memory-status')?.textContent || '').includes('本页暂存');
    const canvasText = document.querySelector('.version-canvas')?.textContent || '';
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
    const stageEl = document.querySelector('.vc-stage');
    const stageRect = stageEl.getBoundingClientRect();
    stageEl.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: stageRect.left + 100, clientY: stageRect.top + 100 }));
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

    const backBtn = await waitFor(() => document.querySelector('.version-canvas button[aria-label="返回素材库"]'), 'back button');
    backBtn.click();
    await waitFor(() => !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace')), 'canvas closes back to gallery');
    const returnedToGallery = !document.querySelector('.version-canvas') && Boolean(document.querySelector('.workspace'));

    localStorage.removeItem('gravityport.dev.version-canvas');
    return {
      canvasMounted,
      detailsHidden,
      memoryPillPresent,
      sampleAbsent,
      inspectorSectionsPresent,
      confirmedOnCanvas,
      finalBadgeUpdated,
      returnedToGallery,
      linkedByDrag,
      comparedByMenu,
      zoomAfterViewer,
      zoomStepError,
      tooltipShown,
      typeSavedOnPick,
    };
  })()`;
}
