export const E2E_DROP_GROUP_NAME = "E2E Drop";

export function createCriticalUiFlowSource({
  mode,
  searchTerm,
  recipeChange,
  dropGroupName = E2E_DROP_GROUP_NAME,
  pasteEnabled = false,
}) {
  const config = JSON.stringify({ mode, searchTerm, recipeChange, dropGroupName, pasteEnabled });
  return `
(async () => {
  const config = ${config};
  const editedPrompt = config.searchTerm + ' / ' + config.recipeChange;
  const stamp = Date.now().toString(36);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rendererErrors = [];
  window.addEventListener('error', (event) => rendererErrors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
  window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    const diagnostic = {
      selectedId: document.querySelector('.asset-card.selected')?.dataset.id || '',
      detailTitle: document.querySelector('#detailTitle')?.textContent || '',
      toast: document.querySelector('.toast-message, .toast')?.textContent || '',
      confirmOpen: document.querySelector('#confirmDialog')?.classList.contains('open') || false,
      detailBusy: document.querySelector('#detailPanel [aria-busy="true"]')?.getAttribute('data-action') || '',
      statusText: document.querySelector('#statusText')?.textContent || '',
      cardCount: document.querySelectorAll('.asset-card').length,
    };
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(diagnostic));
  }
  function setValue(selector, value) {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing input ' + selector);
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element;
  }
  function click(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing control ' + selector);
    if (element.disabled) throw new Error('Disabled control ' + selector);
    element.click();
    return element;
  }
  async function search() {
    // GravityPort A4a：搜索词原为「编辑后的 prompt」；配方编辑退役后改用当前
    // 第一张卡的 id 作锚（id 在结构化搜索字段里，必命中），搜索路径本身照常验。
    const anchorId = document.querySelector('.asset-card')?.dataset?.id || '';
    if (!anchorId) throw new Error('no asset card to anchor the search');
    setValue('#searchInput', anchorId);
    // The search handler is debounced. A pre-existing card can satisfy the
    // result-count assertion before the query has actually committed, which
    // lets the delayed search clear an Inspector opened by the next step. The
    // V2 shell intentionally has no active-filter chip, so observe the query
    // committed on the results container instead of a transient busy frame.
    await waitFor(
      () => document.querySelector('#assetGrid')?.dataset.query === anchorId,
      'committed search query',
    );
    await waitFor(
      () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.asset-card').length >= 1,
      'search results',
    );
  }
  async function openNewestResult() {
    const card = await waitFor(() => document.querySelector('.asset-card .asset-card-select'), 'asset card');
    const assetId = card.closest('.asset-card')?.dataset.id;
    if (!assetId) throw new Error('Asset card is missing its id');
    const selectionTrace = [];
    card.click();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const selected = document.querySelector('.asset-card.selected');
      const favorite = document.querySelector('[data-action="toggle-favorite"]');
      const sample = {
        cardConnected: card.isConnected,
        selectedId: selected?.dataset.id || '',
        favorite: Boolean(favorite),
      };
      const previous = selectionTrace.at(-1);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(sample)) selectionTrace.push(sample);
      if (sample.selectedId === assetId && sample.favorite) return;
      await sleep(20);
    }
    throw new Error('Timed out waiting for selected asset inspector trace=' + JSON.stringify(selectionTrace)
      + ' rendererErrors=' + JSON.stringify(rendererErrors));
  }
  // 沙箱渲染端读不了本地文件：在页面里用 canvas 画一张小图再转成 File，
  // 用 new DataTransfer() 装载后派发 DragEvent。collectDroppedFiles 拿不到
  // webkitGetAsEntry 时回退读 dataTransfer.files（见 web/app/batch-import.mjs）。
  async function makePngFile(name, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
      (value) => (value ? resolveBlob(value) : rejectBlob(new Error('canvas.toBlob produced no blob'))),
      'image/png',
    ));
    return new File([blob], name, { type: 'image/png' });
  }
  function dragEvent(type, dataTransfer, target) {
    const rect = target.getBoundingClientRect();
    const init = {
      bubbles: true,
      cancelable: true,
      dataTransfer,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    let event = new DragEvent(type, init);
    if (!event.dataTransfer) {
      event = new Event(type, init);
      Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      Object.defineProperty(event, 'clientX', { value: init.clientX });
      Object.defineProperty(event, 'clientY', { value: init.clientY });
    }
    return event;
  }
  // 派发 dragenter + dragover，返回触发 drop 的函数：侧边栏分组要在 drop 之前
  // 断言 .group-drop-target 高亮（drop 处理器会立即清掉它）。
  function beginFileDrag(target, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    target.dispatchEvent(dragEvent('dragenter', dataTransfer, target));
    target.dispatchEvent(dragEvent('dragover', dataTransfer, target));
    return () => target.dispatchEvent(dragEvent('drop', dataTransfer, target));
  }
  function dispatchPaste(file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    let event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer });
    if (!event.clipboardData) {
      event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    }
    document.dispatchEvent(event);
  }
  const groupItemSelector = '#sidebarManualGroupList .nav-group-item[data-filter="group"][data-value="' + config.dropGroupName + '"]';
  async function openGroupView() {
    const groupItem = await waitFor(() => document.querySelector(groupItemSelector), 'sidebar drop group item');
    groupItem.click();
    await waitFor(
      () => document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value === config.dropGroupName
        && document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false',
      'group view is open',
    );
  }
  function backToAllAssets() {
    click('#quickFilters .nav-item[data-filter="all"]');
    return waitFor(
      () => document.querySelector('#sidebarManualGroupList .nav-group-item.active') == null
        && document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
        && document.querySelectorAll('.asset-card').length >= 2,
      'back to all assets',
    );
  }

  await waitFor(
    () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false',
    'initialized MOSA application shell',
  );

  const result = {
    mode: config.mode,
    dropImportedCount: 0,
    sidebarDropHighlighted: false,
    sidebarDropCleared: false,
    sidebarDropNavigated: true,
    groupAssetCount: 0,
    pasteImported: false,
    modalOpenAfterPaste: false,
    favorite: false,
    recipeSaved: false,
    recipeSnapshotCount: 0,
    resultCount: 0,
    selectedId: null,
  };

  if (config.mode === 'exercise') {
    // 空状态：手动导入弹窗已删除，不允许任何入口复活。
    await waitFor(() => document.querySelector('.gallery-empty-state'), 'gallery empty state');
    if (document.querySelector('[data-action="empty-import"]')) throw new Error('retired [data-action="empty-import"] is back');
    if (document.querySelector('#importModal')) throw new Error('retired #importModal is back');

    // 1) 外部文件拖进画廊 → 导入到当前视图（全部）。
    const library = document.querySelector('.library');
    if (!library) throw new Error('Missing .library drop surface');
    beginFileDrag(library, await makePngFile('mosa-e2e-' + stamp + '-a.png', '#4a7fb5'))();
    await waitFor(() => document.querySelectorAll('.asset-card').length >= 1, 'gallery drop import');
    result.dropImportedCount = document.querySelectorAll('.asset-card').length;

    // 2) 外部文件拖到侧边栏手动分组 → 导入到该分组，且当前视图不跳转。
    const groupItem = await waitFor(() => document.querySelector(groupItemSelector), 'sidebar drop group item');
    const viewTitleBefore = document.querySelector('#viewTitle')?.textContent || '';
    const activeGroupBefore = document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value || '';
    const finishGroupDrop = beginFileDrag(groupItem, await makePngFile('mosa-e2e-' + stamp + '-b.png', '#8a5a2f'));
    result.sidebarDropHighlighted = groupItem.classList.contains('group-drop-target');
    finishGroupDrop();
    result.sidebarDropCleared = !groupItem.classList.contains('group-drop-target');
    await waitFor(() => document.querySelectorAll('.asset-card').length >= 2, 'sidebar group drop import lands in the all view');
    result.sidebarDropNavigated = (document.querySelector('#viewTitle')?.textContent || '') !== viewTitleBefore
      || (document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value || '') !== activeGroupBefore;

    // 3) 点开分组：刚拖入的卡片在这里。
    await openGroupView();
    await waitFor(() => document.querySelectorAll('.asset-card').length >= 1, 'dropped card appears in its group');
    result.groupAssetCount = document.querySelectorAll('.asset-card').length;
    await backToAllAssets();

    // 4) 粘贴导入（仅 Web exercise 轮）。
    if (config.pasteEnabled) {
      const cardsBeforePaste = document.querySelectorAll('.asset-card').length;
      dispatchPaste(await makePngFile('mosa-e2e-' + stamp + '-paste.png', '#3f7a4a'));
      await waitFor(() => document.querySelectorAll('.asset-card').length === cardsBeforePaste + 1, 'paste import');
      result.pasteImported = document.querySelectorAll('.asset-card').length === cardsBeforePaste + 1;
    }
    result.modalOpenAfterPaste = Boolean(document.querySelector('.modal-overlay.open'));

    // 5) 收藏 + 配方自动保存（沿用原有交互）。
    await openNewestResult();
    let favorite = await waitFor(
      () => document.querySelector('[data-action="toggle-favorite"]'),
      'favorite action',
    );
    if (favorite.getAttribute('aria-pressed') !== 'true') favorite.click();
    favorite = await waitFor(
      () => {
        const button = document.querySelector('[data-action="toggle-favorite"]');
        return button?.getAttribute('aria-pressed') === 'true' ? button : null;
      },
      'favorite persistence in renderer',
    );

    // GravityPort A4a（任务 73）：配方编辑 disclosure 已从检视器拿掉——锁「不得
    // 回来」。原「编辑 prompt → data-recipe-change → save-recipe 自动保存」链路
    // 随入口退役（少验：配方自动保存；数据路径由 store/API 单测覆盖）。
    await waitFor(
      () => document.querySelector('[data-inspector-section="prompt"]'),
      'prompt section',
    );
    if (document.querySelector('[data-edit], [data-action="save-recipe"], [data-recipe-change]')) {
      throw new Error('retired recipe editing controls are back');
    }

    // 6) 用 searchTerm 搜索（卡片文件名带同一 stamp，标题搜索可命中）。
    await search();
    await openNewestResult();
  } else {
    // verify：重启后 E2E Drop 分组里仍然有 1 张素材。
    await openGroupView();
    await waitFor(() => document.querySelectorAll('.asset-card').length >= 1, 'group assets after restart', 20000);
    result.groupAssetCount = document.querySelectorAll('.asset-card').length;
    await backToAllAssets();

    await search();
    await openNewestResult();
    await waitFor(
      () => document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true',
      'favorite after restart',
    );
    result.favorite = document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true';
    // GravityPort A4a：重启后配方编辑区同样必须保持移除；原「重启后 prompt 值 /
    // 快照历史 / 变更说明」断言随编辑入口退役（少验：配方数据重启持久化）。
    await waitFor(
      () => document.querySelector('[data-inspector-section="prompt"]'),
      'prompt section after restart',
    );
    if (document.querySelector('[data-edit], [data-action="save-recipe"], [data-recipe-change]')) {
      throw new Error('retired recipe editing controls are back after restart');
    }
  }

  result.favorite = result.favorite || document.querySelector('[data-action="toggle-favorite"]')?.getAttribute('aria-pressed') === 'true';
  // GravityPort A4a：recipeSaved 改为「配方编辑区保持移除」；快照计数仅观测。
  result.recipeEditorRemoved = !document.querySelector('[data-edit], [data-action="save-recipe"]');
  result.recipeSnapshotCount = document.querySelectorAll('[data-recipe-snapshot-id]').length;
  result.resultCount = document.querySelectorAll('.asset-card').length;
  result.selectedId = document.querySelector('.asset-card.selected')?.dataset.id || null;
  return result;
})()
`;
}

export function createStackUiFlowSource() {
  return `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = check();
      if (value) return value;
      await sleep(100);
    }
    throw new Error('Timed out waiting for ' + label);
  }
  function ctrlClick(element) {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
  }
  function doubleClick(element) {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
  }
  function pointer(target, type, x, y, pointerId = 91) {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: type === 'pointerdown' ? 0 : -1,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }));
  }

  await waitFor(
    () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#assetGrid > .asset-card').length >= 2,
    'two root gallery cards',
  );
  const initialCards = [...document.querySelectorAll('#assetGrid > .asset-card')];
  const firstId = initialCards[0].dataset.id;
  const secondId = initialCards[1].dataset.id;
  ctrlClick(initialCards[0].querySelector('.asset-card-select'));
  ctrlClick(initialCards[1].querySelector('.asset-card-select'));
  // A small drag of an existing multi-selection onto one of its own members
  // must be a no-op, not an accidental Stack creation.
  const selfDropFrom = initialCards[0].getBoundingClientRect();
  const selfDropTo = initialCards[1].getBoundingClientRect();
  pointer(initialCards[0].querySelector('.asset-card-select'), 'pointerdown', selfDropFrom.left + selfDropFrom.width / 2, selfDropFrom.top + selfDropFrom.height / 2, 90);
  pointer(window, 'pointermove', selfDropTo.left + selfDropTo.width / 2, selfDropTo.top + selfDropTo.height / 2, 90);
  pointer(window, 'pointerup', selfDropTo.left + selfDropTo.width / 2, selfDropTo.top + selfDropTo.height / 2, 90);
  await sleep(80);
  if (document.querySelector('#assetGrid > .asset-card.is-stack')) throw new Error('Self-drop unexpectedly created a Stack');
  ctrlClick(initialCards[0].querySelector('.asset-card-select'));
  ctrlClick(initialCards[1].querySelector('.asset-card-select'));
  const dragFrom = initialCards[0].getBoundingClientRect();
  const dragTo = initialCards[1].getBoundingClientRect();
  pointer(initialCards[0].querySelector('.asset-card-select'), 'pointerdown', dragFrom.left + dragFrom.width / 2, dragFrom.top + dragFrom.height / 2, 92);
  pointer(window, 'pointermove', dragTo.left + dragTo.width / 2, dragTo.top + dragTo.height / 2, 92);
  pointer(window, 'pointerup', dragTo.left + dragTo.width / 2, dragTo.top + dragTo.height / 2, 92);
  const stackCard = await waitFor(
    () => document.querySelector('#assetGrid > .asset-card.is-stack'),
    'collapsed Stack card created by direct drag',
  );
  const stackId = stackCard.dataset.stackId;
  const rootCountAfterStack = document.querySelectorAll('#assetGrid > .asset-card').length;
  doubleClick(stackCard.querySelector('.asset-card-select'));
  await waitFor(
    () => document.body.getAttribute('data-in-stack') === 'true'
      && document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('#assetGrid > .asset-card').length === 2,
    'Stack interior',
  );

  let inside = [...document.querySelectorAll('#assetGrid > .asset-card')];
  const originalCoverId = inside[0].dataset.id;
  const reorderCard = inside[1];
  const targetCard = inside[0];
  const reorderId = reorderCard.dataset.id;
  ctrlClick(reorderCard.querySelector('.asset-card-select'));
  const from = reorderCard.getBoundingClientRect();
  const to = targetCard.getBoundingClientRect();
  pointer(reorderCard.querySelector('.asset-card-select'), 'pointerdown', from.left + from.width / 2, from.top + from.height / 2);
  pointer(window, 'pointermove', to.left + Math.max(2, to.width * 0.2), to.top + to.height / 2);
  pointer(window, 'pointerup', to.left + Math.max(2, to.width * 0.2), to.top + to.height / 2);
  await waitFor(
    () => {
      const cards = [...document.querySelectorAll('#assetGrid > .asset-card')];
      return document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false'
        && cards[0]?.dataset.id === reorderId;
    },
    'manual reorder and cover change',
  );
  const newCoverId = document.querySelector('#assetGrid > .asset-card')?.dataset.id;
  document.querySelector('#navHistoryBack').click();
  const returnedStack = await waitFor(
    () => document.querySelector('#assetGrid > .asset-card[data-stack-id="' + CSS.escape(stackId) + '"]'),
    'returned Stack node',
  );
  return {
    stackId,
    firstId,
    secondId,
    originalCoverId,
    newCoverId,
    returnedCoverId: returnedStack.dataset.id,
    rootCountAfterStack,
    currentRootCount: document.querySelectorAll('#assetGrid > .asset-card').length,
    stackCount: returnedStack.querySelector('.asset-stack-count')?.textContent || '',
    topbarStatsRemoved: document.querySelector('#assetCount') === null,
  };
})()
`;
}

// 回收站完整流程：取消 / 移到回收站 / 整栈入回收站 / 还原（分组与 Stack 重建）/
// 永久删除 / 清空，另覆盖回收站视图禁止导入。文案与 web/app/i18n.mjs 保持一致
// （zh 是渲染端默认 locale）。界面不走通用的 critical 流程辅助函数，避免碰
// 现有两条流程；这里自带一份精简 helper。
export function createTrashUiFlowSource(config) {
  const flowConfig = JSON.stringify(config);
  return `
(async () => {
  const config = ${flowConfig};
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rendererErrors = [];
  window.addEventListener('error', (event) => rendererErrors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
  window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const value = check();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(100);
    }
    const diagnostic = {
      cardCount: document.querySelectorAll('.asset-card').length,
      trashCards: document.querySelectorAll('.asset-card.is-trash').length,
      confirmOpen: document.querySelector('#confirmDialog')?.classList.contains('open') || false,
      confirmText: document.querySelector('#confirmDialogDescription')?.textContent || '',
      toast: document.querySelector('.toast-message, .toast')?.textContent || '',
      statusText: document.querySelector('#statusText')?.textContent || '',
      openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 160) || '',
      rendererErrors: rendererErrors.slice(0, 3),
    };
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(diagnostic));
  }
  function click(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error('Missing control ' + selector);
    if (element.disabled) throw new Error('Disabled control ' + selector);
    element.click();
    return element;
  }
  const cardSelect = (assetId) => '.asset-card[data-id="' + assetId + '"] .asset-card-select';
  const cardElement = (assetId) => document.querySelector('.asset-card[data-id="' + assetId + '"]');
  const stackNode = () => document.querySelector('.asset-card.is-stack[data-stack-id="' + config.stackId + '"]');
  const trashCards = () => document.querySelectorAll('.asset-card.is-trash').length;
  const rootCards = () => document.querySelectorAll('#assetGrid > .asset-card').length;
  const busySettled = () => document.querySelector('#assetGrid')?.getAttribute('aria-busy') === 'false';

  async function openContextMenu(selector, label) {
    // 卡片 DOM 会被后台增量刷新 replaceWith 替换；派发在已断开元素上的事件
    // 冒泡不到 assetGrid，所以"查询 → 派发 → 检查"必须在同一个轮询周期里重试。
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const trigger = document.querySelector(selector);
      if (trigger?.isConnected) {
        trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
        const item = [...document.querySelectorAll('.context-menu-item')].find((entry) => entry.textContent.includes(label));
        // Clicked synchronously on purpose: this is the regression check for
        // the context-menu listener leak (menus hidden before their deferred
        // listener registration used to leak it and break every later menu).
        if (item) return item;
      }
      await sleep(100);
    }
    throw new Error('Timed out waiting for context menu item ' + label
      + ' diagnostic=' + JSON.stringify({
        cardCount: document.querySelectorAll('.asset-card').length,
        openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 100) || '',
        toast: document.querySelector('.toast-message, .toast')?.textContent || '',
        rendererErrors: rendererErrors.slice(0, 3),
      }));
  }
  async function confirmDialog({ expectDescriptionCount = null } = {}) {
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog opens');
    const description = document.querySelector('#confirmDialogDescription')?.textContent || '';
    if (expectDescriptionCount !== null && !description.includes(String(expectDescriptionCount))) {
      throw new Error('Confirm dialog description misses count ' + expectDescriptionCount + ': ' + description);
    }
    document.querySelector('#confirmDialogConfirm').click();
    await waitFor(() => !document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog closes');
  }
  async function cancelDialog() {
    await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog opens');
    document.querySelector('#confirmDialogCancel').click();
    await waitFor(() => !document.querySelector('#confirmDialog')?.classList.contains('open'), 'confirm dialog closes');
  }
  async function moveToTrash(assetId, { expectDescriptionCount = null } = {}) {
    const item = await openContextMenu(cardSelect(assetId), '移到回收站');
    item.click();
    await confirmDialog({ expectDescriptionCount });
    await waitFor(() => !cardElement(assetId), 'asset leaves the current view after trash');
  }
  async function restoreFromTrash(assetId) {
    const item = await openContextMenu(cardSelect(assetId), '还原素材');
    item.click();
    await waitFor(() => !cardElement(assetId), 'asset leaves Trash after restore');
  }
  async function goTrash() {
    click('.nav-item[data-filter="trash"]');
    await waitFor(() => busySettled(), 'trash view opens');
  }
  async function backToAll(minCards) {
    click('#quickFilters .nav-item[data-filter="all"]');
    await waitFor(() => busySettled() && rootCards() >= minCards, 'back to all assets');
  }
  // 与任务 03 相同的页内 File 拖入（collectDroppedFiles 回退读 dataTransfer.files）。
  async function makePngFile(name, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
      (value) => (value ? resolveBlob(value) : rejectBlob(new Error('canvas.toBlob produced no blob'))),
      'image/png',
    ));
    return new File([blob], name, { type: 'image/png' });
  }
  function dispatchFileDrag(target, file) {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    let dragOver = new DragEvent('dragover', init);
    if (!dragOver.dataTransfer) {
      dragOver = new Event('dragover', init);
      Object.defineProperty(dragOver, 'dataTransfer', { value: dataTransfer });
    }
    let drop = new DragEvent('drop', init);
    if (!drop.dataTransfer) {
      drop = new Event('drop', init);
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
    }
    target.dispatchEvent(dragOver);
    target.dispatchEvent(drop);
  }

  const result = {
    mode: config.mode,
    seededRootCards: 0,
    cancelTrashKeptAsset: false,
    moveToTrashWorked: false,
    stackTrashConfirmCount: false,
    stackTrashWorked: false,
    trashDropBlockedTrashView: false,
    trashDropBlockedAllView: false,
    restoreWorked: false,
    groupRestored: false,
    stackRebuilt: false,
    permanentDeleteWorked: false,
    emptyTrashWorked: false,
    trashBadgeShown: false,
    restoreAfterRestartWorked: false,
    rootCountAfterRestore: 0,
    stackCountShown: '',
  };

  await waitFor(() => busySettled(), 'initialized MOSA application shell');

  if (config.mode === 'exercise') {
    await waitFor(() => rootCards() >= 4, 'seeded library root cards');
    result.seededRootCards = rootCards();

    // 1) 取消不生效：确认框里点取消，B 留在画廊。
    const cancelItem = await openContextMenu(cardSelect(config.assetIds.b), '移到回收站');
    cancelItem.click();
    await cancelDialog();
    await waitFor(() => cardElement(config.assetIds.b) && busySettled(), 'B stays in gallery after cancelled trash');
    result.cancelTrashKeptAsset = true;

    // 2) A 移到回收站：全部视图消失，回收站里带 .is-trash。
    await moveToTrash(config.assetIds.a);
    await goTrash();
    await waitFor(() => cardElement(config.assetIds.a)?.classList.contains('is-trash'), 'A shows up in Trash with is-trash');
    result.moveToTrashWorked = trashCards() >= 1;

    // 3) 整个 Stack 移到回收站：确认框描述包含成员数 2。
    await backToAll(3);
    const stackMenuItem = await openContextMenu('.asset-card.is-stack[data-stack-id="' + config.stackId + '"] .asset-card-select', '移到回收站');
    stackMenuItem.click();
    await confirmDialog({ expectDescriptionCount: 2 });
    result.stackTrashConfirmCount = true;
    await waitFor(() => !stackNode(), 'Stack node leaves the gallery');
    await goTrash();
    await waitFor(
      () => cardElement(config.assetIds.c)?.classList.contains('is-trash') && cardElement(config.assetIds.d)?.classList.contains('is-trash'),
      'C and D show up in Trash',
    );
    result.stackTrashWorked = true;

    // 4) 回收站视图禁止导入：拖入事件不改变任何视图的卡片集合。
    const library = document.querySelector('.library');
    if (!library) throw new Error('Missing .library drop surface');
    const trashCountBeforeDrop = trashCards();
    dispatchFileDrag(library, await makePngFile('mosa-e2e-trash-drop.png', '#7a3f4a'));
    await sleep(1000);
    result.trashDropBlockedTrashView = busySettled() && trashCards() === trashCountBeforeDrop;
    await backToAll(2);
    // 回到全部视图：根卡片集合必须与拖入前完全一致（B、E）——既没有丢失，
    // 也没有因被拦截的拖入而多出任何导入卡片。
    const expectedRootIds = [config.assetIds.b, config.assetIds.e].sort().join(',');
    await waitFor(() => {
      const ids = [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => card.dataset.id).sort().join(',');
      return busySettled() && ids === expectedRootIds;
    }, 'all view keeps exactly B and E after blocked drop', 5000);
    result.trashDropBlockedAllView = true;

    // 5) 还原 A、C、D；分组与 Stack 关系重建。
    await goTrash();
    await restoreFromTrash(config.assetIds.a);
    await restoreFromTrash(config.assetIds.c);
    await restoreFromTrash(config.assetIds.d);
    await waitFor(() => trashCards() === 0, 'Trash is empty after restoring A/C/D');
    await backToAll(4);
    const restoredStack = stackNode();
    result.restoreWorked = Boolean(cardElement(config.assetIds.a) && cardElement(config.assetIds.b));
    result.stackRebuilt = Boolean(
      restoredStack
      && restoredStack.dataset.stackId === config.stackId
      && restoredStack.dataset.id === config.coverId
      && (restoredStack.querySelector('.asset-stack-count')?.textContent || '') === '2',
    );
    const groupItem = await waitFor(
      () => document.querySelector('#sidebarManualGroupList .nav-group-item[data-filter="group"][data-value="' + config.groupName + '"]'),
      'Trash Group nav item',
    );
    groupItem.click();
    await waitFor(
      () => document.querySelector('#sidebarManualGroupList .nav-group-item.active')?.dataset.value === config.groupName && busySettled(),
      'Trash Group view opens',
    );
    await waitFor(() => cardElement(config.assetIds.a), 'A is back inside Trash Group');
    result.groupRestored = true;
    click('#quickFilters .nav-item[data-filter="all"]');
    await waitFor(() => busySettled() && stackNode(), 'back to all with rebuilt Stack');

    // 6) 永久删除 B：移入回收站后右键永久删除并确认。
    await moveToTrash(config.assetIds.b);
    await goTrash();
    await waitFor(() => cardElement(config.assetIds.b)?.classList.contains('is-trash'), 'B waits in Trash');
    const deleteItem = await openContextMenu(cardSelect(config.assetIds.b), '永久删除');
    deleteItem.click();
    await confirmDialog();
    await waitFor(() => !cardElement(config.assetIds.b) && busySettled(), 'B disappears from Trash permanently');
    result.permanentDeleteWorked = true;

    // 7) 清空回收站：A 入回收站后一键清空，按钮回到 hidden。
    await backToAll(3);
    await moveToTrash(config.assetIds.a);
    await goTrash();
    await waitFor(() => cardElement(config.assetIds.a), 'A waits in Trash before emptying');
    const emptyButton = await waitFor(
      () => (document.querySelector('#emptyTrashBtn')?.hidden ? null : document.querySelector('#emptyTrashBtn')),
      'empty Trash button becomes visible',
    );
    emptyButton.click();
    await confirmDialog();
    await waitFor(
      () => trashCards() === 0 && document.querySelector('#emptyTrashBtn')?.hidden === true,
      'Trash empties and the button hides',
    );
    result.emptyTrashWorked = true;

    // 8) E 移到回收站，为重启验证留数据。
    await backToAll(2);
    await moveToTrash(config.assetIds.e);
    result.eLeftInTrash = true;
  } else {
    // verify：重启后 E 仍带剩余天数角标；还原后全部视图只剩重建的 Stack + E。
    await goTrash();
    const trashCard = await waitFor(
      () => [...document.querySelectorAll('.asset-card.is-trash')].find((card) => card.dataset.id === config.assetIds.e),
      'E waits in Trash after restart',
    );
    result.trashBadgeShown = Boolean(trashCard.querySelector('.trash-countdown'));
    await restoreFromTrash(config.assetIds.e);
    await waitFor(() => trashCards() === 0, 'Trash is empty after restoring E');
    result.restoreAfterRestartWorked = true;
    await backToAll(2);
    await waitFor(
      () => stackNode()?.querySelector('.asset-stack-count')?.textContent === '2' && cardElement(config.assetIds.e),
      'rebuilt Stack node and E are the only root cards',
    );
    result.rootCountAfterRestore = rootCards();
    result.stackCountShown = stackNode()?.querySelector('.asset-stack-count')?.textContent || '';
    result.stackIdStillValid = stackNode()?.dataset.stackId === config.stackId && stackNode()?.dataset.id === config.coverId;
  }

  return result;
})()
`;
}
