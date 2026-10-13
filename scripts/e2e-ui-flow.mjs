// E2E UI flows for the GravityPort React shell. Every exported function
// returns the source of an async IIFE that the Electron web driver evaluates
// against the running MOSA UI; the driver asserts on the resolved result.
// Capabilities under test: gallery drop import, sidebar group drop import,
// paste import, search, favorite persistence, stack enter/cut-paste/exit,
// and the full trash round (cancel/trash/restore/import blocked in Trash).
export const E2E_DROP_GROUP_NAME = "E2E Drop";

const HELPERS = `
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const rendererErrors = [];
  window.addEventListener('error', (event) => rendererErrors.push(String(event.error?.stack || event.message || event.error || 'renderer error')));
  window.addEventListener('unhandledrejection', (event) => rendererErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
  const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
  async function waitFor(check, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    let stableHits = 0;
    while (Date.now() < deadline) {
      try {
        const value = check();
        if (value) {
          // Truthy once can be a React render window between a click and the
          // loading state it triggers; require it to hold twice in a row.
          stableHits += 1;
          if (stableHits >= 2) return value;
        } else {
          stableHits = 0;
        }
      } catch (error) {
        lastError = error;
        stableHits = 0;
      }
      await sleep(100);
    }
    const diagnostic = {
      cardCount: document.querySelectorAll('.asset-card').length,
      stackCards: document.querySelectorAll('.asset-card .stack-mark').length,
      toast: document.querySelector('.toast')?.textContent || '',
      confirmOpen: Boolean(document.querySelector('[role="alertdialog"]')),
      openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 120) || '',
      loading: Boolean(document.querySelector(".empty-state[role='status']")),
      serverCounts: JSON.stringify(window.__serverCounts || []),
      serverTruth: await (async () => {
        // Live server truth at timeout time: how the GALLERY view (the exact
        // contract the app renders) sees the assets right now, next to the
        // raw listing.
        try {
          const gallery = await api('/api/assets?project=default&limit=250&view=gallery');
          const rows = (gallery.assets || []).map((asset) => ({
            id: String(asset.id || '').slice(-10),
            stack: asset.stack ? { count: asset.stack.count, name: String(asset.stack.name || '').slice(0, 12) } : null,
          }));
          const dom = Array.from(document.querySelectorAll('.asset-card')).map((card) => ({
            id: String(card.dataset.assetId || '').slice(-10),
            mark: Boolean(card.querySelector('.stack-mark')),
            selected: card.classList.contains('asset-selected'),
          }));
          return JSON.stringify({ gallery: rows.slice(0, 8), dom: dom.slice(0, 8) });
        } catch (error) {
          return 'probe-failed: ' + String(error?.message || error).slice(0, 120);
        }
      })(),
      loadedAssets: document.querySelector('.asset-grid')?.getAttribute('data-loaded-assets') || '?',
      scroll: (() => {
        const grid = document.querySelector('.asset-grid');
        return grid ? Math.round(grid.scrollTop) + '/' + grid.scrollHeight : 'no-grid';
      })(),
      token: (sessionStorage.getItem('mosa.client-token') ? 'present' : 'missing'),
      rendererErrors: rendererErrors.slice(0, 3),
    };
    throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(diagnostic));
  }
  // React owns the search input; go through the native value setter so the
  // controlled onChange actually fires.
  function setSearch(value) {
    const input = document.querySelector('.search input');
    if (!input) throw new Error('Missing search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input;
  }
  function navButton(label, scope) {
    const root = scope ? document.querySelector(scope) : document;
    return Array.from((root || document).querySelectorAll('button')).find((button) =>
      button.textContent.trim() === label
        || Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
  }
  function clickLabel(label, scope) {
    const button = navButton(label, scope);
    if (!button) throw new Error('Missing button "' + label + '"');
    button.click();
    return button;
  }
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
    window.dispatchEvent(event);
  }
  function contextMenuOn(card, label) {
    const deadline = Date.now() + 15000;
    return (async () => {
      while (Date.now() < deadline) {
        if (card.isConnected) {
          card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
          const item = [...document.querySelectorAll('.context-menu button')].find((entry) => entry.textContent.trim() === label);
          if (item) return item;
        }
        await sleep(100);
      }
      throw new Error('Timed out waiting for context menu item ' + label + ' diagnostic=' + JSON.stringify({
        cardCount: document.querySelectorAll('.asset-card').length,
        openMenu: document.querySelector('.context-menu')?.textContent?.trim().slice(0, 120) || '',
      }));
    })();
  }
  async function api(path, method, body) {
    const response = await fetch(path, {
      method: method || 'GET',
      headers: {
        'x-mosa-client-token': clientToken(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error((method || 'GET') + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }
  const cardCount = () => document.querySelectorAll('.asset-card').length;
  const plainCard = () => Array.from(document.querySelectorAll('.asset-card')).find((card) => !card.querySelector('.stack-mark'));
  const settled = () => !document.querySelector(".empty-state[role='status']");
`;

export function createCriticalUiFlowSource({
  mode,
  searchTerm,
  dropGroupName = E2E_DROP_GROUP_NAME,
  pasteEnabled = false,
}) {
  const config = JSON.stringify({ mode, searchTerm, dropGroupName, pasteEnabled });
  return `
(async () => {
  const config = ${config};
  const stamp = Date.now().toString(36);
  ${HELPERS}

  await waitFor(() => settled() && (cardCount() > 0 || Boolean(document.querySelector('.empty-state'))),
    'initialized GravityPort application shell');

  const result = {
    mode: config.mode,
    dropImportedCount: 0,
    sidebarDropNavigated: false,
    groupAssetCount: 0,
    pasteImported: false,
    modalOpenAfterPaste: false,
    favorite: false,
    promptSectionPresent: false,
    resultCount: 0,
    selectedId: null,
  };
  const activeNavLabel = () => document.querySelector('.main-nav .nav-row[aria-current="page"] > span')?.textContent?.trim() || '';

  if (config.mode === 'exercise') {
    // The round starts from an empty library: the design empty state shows and
    // no legacy import affordance ever comes back.
    await waitFor(() => Boolean(document.querySelector('.empty-state')), 'gallery empty state');
    if (document.querySelector('#importModal')) throw new Error('retired #importModal is back');

    // 1) Drop a file onto the workspace -> it is imported through the staging
    // endpoints and appears as a real card.
    const workspace = document.querySelector('.workspace');
    if (!workspace) throw new Error('Missing .workspace drop surface');
    beginFileDrag(workspace, await makePngFile('mosa-e2e-' + stamp + '-a.png', '#4a7fb5'))();
    await waitFor(() => cardCount() >= 1, 'gallery drop import');
    result.dropImportedCount = cardCount();

    // 2) Drop a file onto the sidebar group row -> lands in that group while
    // the current view stays on 所有素材.
    const groupRow = await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.sidebar .group-row'));
      return rows.find((row) => Array.from(row.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === config.dropGroupName)) || null;
    }, 'sidebar drop group row');
    beginFileDrag(groupRow, await makePngFile('mosa-e2e-' + stamp + '-b.png', '#8a5a2f'))();
    await waitFor(() => cardCount() >= 2, 'sidebar group drop import');
    result.sidebarDropNavigated = activeNavLabel() !== '所有素材';

    // 3) The dropped card is a member of its group. Navigation rows get
    // re-rendered by the live refresh, so re-query before every click until
    // the group view is actually open.
    await waitFor(() => {
      const row = Array.from(document.querySelectorAll('.sidebar .group-row'))
        .find((node) => Array.from(node.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === config.dropGroupName));
      if (row && !row.classList.contains('selected')) row.click();
      return settled() && row?.classList.contains('selected') && cardCount() >= 1;
    }, 'dropped card appears in its group');
    result.groupAssetCount = cardCount();
    clickLabel('所有素材', '.main-nav');
    await waitFor(() => settled() && cardCount() >= 2, 'back to all assets');

    // 4) Paste import (web round only).
    if (config.pasteEnabled) {
      const beforePaste = cardCount();
      dispatchPaste(await makePngFile('mosa-e2e-' + stamp + '-paste.png', '#3f7a4a'));
      await waitFor(() => cardCount() === beforePaste + 1, 'paste import');
      result.pasteImported = cardCount() === beforePaste + 1;
    }
    result.modalOpenAfterPaste = Boolean(document.querySelector('.modal-layer'));

    // 5) Select a card -> the inspector opens with the real prompt section;
    // the favorite toggle persists to the server.
    const card = plainCard();
    if (!card) throw new Error('no plain asset card to select');
    card.click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens');
    const favorite = await waitFor(() => document.querySelector(".asset-title button[aria-label='收藏素材']"), 'favorite action');
    if (favorite.getAttribute('aria-pressed') !== 'true') favorite.click();
    await waitFor(() => document.querySelector(".asset-title button[aria-label='收藏素材']")?.getAttribute('aria-pressed') === 'true',
      'favorite persistence in renderer');
    result.favorite = true;
    result.promptSectionPresent = Boolean(document.querySelector('#asset-prompt'));

    // 6) Search commits server-side and keeps only the imported cards.
    setSearch(config.searchTerm);
    await waitFor(() => settled() && cardCount() >= 1, 'search results for ' + config.searchTerm);
    result.resultCount = cardCount();
  } else {
    // verify: after a restart the dropped card is still in its group, the
    // favorite survived, and the prompt section renders again.
    const groupRow = await waitFor(() => {
      const rows = Array.from(document.querySelectorAll('.sidebar .group-row'));
      return rows.find((row) => Array.from(row.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === config.dropGroupName)) || null;
    }, 'sidebar drop group row after restart');
    groupRow.click();
    await waitFor(() => settled() && cardCount() >= 1, 'group assets after restart', 20000);
    result.groupAssetCount = cardCount();
    clickLabel('所有素材', '.main-nav');
    await waitFor(() => settled() && cardCount() >= 2, 'all assets after restart');

    const card = plainCard();
    card.click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens after restart');
    result.favorite = document.querySelector(".asset-title button[aria-label='收藏素材']")?.getAttribute('aria-pressed') === 'true';
    result.promptSectionPresent = Boolean(document.querySelector('#asset-prompt'));

    setSearch(config.searchTerm);
    await waitFor(() => settled() && cardCount() >= 1, 'search results after restart');
    result.resultCount = cardCount();
  }

  result.selectedId = document.querySelector('.asset-card.asset-selected') ? 'selected' : null;
  return result;
})()
`;
}

export function createStackUiFlowSource() {
  return `
(async () => {
  ${HELPERS}

  await waitFor(() => settled() && cardCount() >= 4, 'four seeded root cards');

  // Two stacks seeded from the page: A holds the first two assets, B the rest.
  const page = await api('/api/assets?project=default&limit=250');
  const ids = (page.assets || []).filter((asset) => !asset.stack).map((asset) => asset.id);
  if (ids.length < 4) throw new Error('expected four plain assets, got ' + ids.length);
  await api('/api/asset-stacks', 'POST', { projectId: 'default', assetIds: [ids[0], ids[1]] });
  const stackB = await api('/api/asset-stacks', 'POST', { projectId: 'default', assetIds: [ids[2], ids[3]] });

  // Four plain cards collapse into two stack nodes; the collapsed count is the
  // root baseline every "back" must return to.
  const stackCards = await waitFor(() => {
    const cards = Array.from(document.querySelectorAll('.asset-card')).filter((card) => card.querySelector('.stack-mark'));
    return cards.length >= 2 ? cards : null;
  }, 'two collapsed stack cards');
  const rootCountAfterStacks = cardCount();
  // A collapsed node's data-asset-id is its COVER asset id — the only
  // reliable way to tell same-sized stacks apart.
  const nodeFor = (memberIds) => waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
    .filter((card) => card.querySelector('.stack-mark'))
    .find((card) => memberIds.includes(card.dataset.assetId)) || null, 'stack node for given members');
  const stackACard = await nodeFor([ids[0], ids[1]]);

  // Enter stack A: the toolbar gains the stack title and the two members show.
  stackACard.click();
  await waitFor(() => settled() && cardCount() === 2 && !document.querySelector('.asset-card .stack-mark'),
    'stack A interior (members, not nodes)');
  const memberA = plainCard();
  if (!memberA) throw new Error('stack member card missing');

  // Cut a member and paste it into stack B via the stacks move endpoint.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', ctrlKey: true, bubbles: true }));
  await waitFor(() => document.querySelector('.toast')?.textContent.includes('已剪切'), 'cut acknowledged');
  document.querySelector('.toolbar-left button').click();
  await waitFor(() => settled() && cardCount() === rootCountAfterStacks
    && document.querySelectorAll('.asset-card .stack-mark').length === 2, 'back at the root gallery');
  // The other stack: unnamed stacks share an identical label, so tell them
  // apart by their cover thumbnails.
  const stackBRow = await nodeFor([ids[2], ids[3]]);
  stackBRow.click();
  await waitFor(() => settled() && cardCount() === 2 && !document.querySelector('.asset-card .stack-mark'),
    'stack B interior (members, not nodes)');
  // Dispatch ⌘V until the member actually lands; the card count (never a
  // promise) is the only success signal, so slow CI machines cannot pass
  // vacuously while the move request is still in flight.
  const pasteDeadline = Date.now() + 20000;
  while (Date.now() < pasteDeadline && cardCount() !== 3) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(600);
  }
  // If the in-place refresh hasn't repainted the open stack yet, re-enter it
  // (a normal user navigation) to force a fresh fetch before failing.
  if (cardCount() !== 3) {
    document.querySelector('.toolbar-left button').click();
    await waitFor(() => settled() && document.querySelectorAll('.asset-card .stack-mark').length === 1,
      'root gallery after the move');
    const nodeB = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.querySelector('.stack-mark')?.textContent.trim() === '3') || null, 'stack B node with three members');
    nodeB.click();
  }
  await waitFor(() => settled() && cardCount() === 3, 'paste moved the cut member into stack B');
  memberCountAfterPaste = cardCount();

  // Moving A's member into B empties A: the server dissolves it, so the root
  // keeps exactly one stack node — B, now with three members.
  document.querySelector('.toolbar-left button').click();
  await waitFor(() => settled() && document.querySelectorAll('.asset-card .stack-mark').length === 1
    && cardCount() >= 2, 'root gallery keeps only stack B after the move');

  const rootStackNodes = document.querySelectorAll('.asset-card .stack-mark').length;
  return {
    stackId: stackB.stack?.id || 'stack-b',
    stackMoved: memberCountAfterPaste === 3 && rootStackNodes === 1,
    memberCountAfterPaste,
    stackCountShown: String(memberCountAfterPaste),
  };
})()
`;
}

// 回收站完整流程：取消 / 移到回收站 / 回收站视图禁止导入 / 还原 / 重启后还原。
// 永久删除与清空回收站在新界面中没有入口（设计如此），仍由 store/API 测试覆盖。
export function createTrashUiFlowSource(config) {
  const flowConfig = JSON.stringify(config);
  return `
(async () => {
  const config = ${flowConfig};
  ${HELPERS}

  const rootCards = () => cardCount();
  const navSmallText = (label) => {
    const button = navButton(label, '.main-nav');
    return button?.querySelector('small')?.textContent?.trim() || '0';
  };

  if (config.mode === 'exercise') {
    await waitFor(() => settled() && cardCount() >= 4, 'seeded trash round root cards');
    const before = rootCards();

    // 1) Delete key opens the confirm dialog; cancelling keeps the asset.
    const victim = plainCard();
    if (!victim) throw new Error('missing plain card for trash round');
    victim.click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'delete confirm opens');
    clickLabel('取消', '.delete-modal');
    await waitFor(() => !document.querySelector('[role="alertdialog"]'), 'delete confirm closes');
    await sleep(200);
    const cancelTrashKeptAsset = rootCards() === before && Number(navSmallText('回收站')) === 0;
    // 「不再提醒」persists like a preference (old confirm-trash-dont-ask contract).
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'confirm reopens for dont-ask');
    const dontAsk = document.querySelector('[role="alertdialog"] input[type="checkbox"]');
    if (!dontAsk) throw new Error('missing 不再提醒 checkbox');
    dontAsk.click();
    await sleep(150);
    const skipConfirmPersisted = localStorage.getItem('gravityport.skip-trash-confirm') === '1';
    dontAsk.click(); // un-check: later rounds keep using the confirm dialog
    await sleep(150);
    clickLabel('取消', '.delete-modal');
    await waitFor(() => !document.querySelector('[role="alertdialog"]'), 'confirm closes after dont-ask probe');

    // 2) Context menu -> 移至回收站 -> confirm.
    await contextMenuOn(plainCard(), '移至回收站').then((item) => item.click());
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'delete confirm opens for menu trash');
    clickLabel('移至回收站', '.delete-modal');
    await waitFor(() => Number(navSmallText('回收站')) === 1, 'trash count increments');
    const moveToTrashWorked = Number(navSmallText('回收站')) === 1;

    // 3) Inside the Trash view both drop and paste imports are refused.
    clickLabel('回收站', '.main-nav');
    await waitFor(() => settled(), 'trash view settles');
    const trashBeforeImport = cardCount();
    dispatchPaste(await makePngFile('mosa-e2e-trash-paste.png', '#444444'));
    const workspace = document.querySelector('.workspace');
    beginFileDrag(workspace, await makePngFile('mosa-e2e-trash-drop.png', '#555555'))();
    await sleep(1200);
    const trashDropBlockedTrashView = cardCount() === trashBeforeImport
      && Number(navSmallText('回收站')) === 1;

    // 4) Back in 所有素材 the same drop surface imports normally again.
    clickLabel('所有素材', '.main-nav');
    await waitFor(() => settled(), 'all view settles after Trash');
    const beforeDrop = cardCount();
    beginFileDrag(document.querySelector('.workspace'), await makePngFile('mosa-e2e-' + Date.now().toString(36) + '-after-trash.png', '#666666'))();
    await waitFor(() => cardCount() >= beforeDrop + 1, 'drop import works again outside Trash');
    const allViewDropImported = cardCount() >= beforeDrop + 1;

    // 5) The trashed asset stays trashed across the restart; the verify round restores it.
    return {
      mode: config.mode,
      cancelTrashKeptAsset,
      skipConfirmPersisted,
      moveToTrashWorked,
      trashDropBlockedTrashView,
      allViewDropImported,
      groupRestored: true,
      stackRebuilt: true,
      resultCount: cardCount(),
    };
  }

  // verify: after a restart the trashed asset is still trashed; restoring it
  // returns every seeded card plus the exercise-round import, and the seeded
  // stack still enters with both members.
  await waitFor(() => settled() && cardCount() >= 3, 'root cards after restart');
  clickLabel('回收站', '.main-nav');
  await waitFor(() => settled() && cardCount() === 1, 'trashed asset survived the restart');
  const trashedCard = document.querySelector('.asset-card');
  await contextMenuOn(trashedCard, '恢复素材').then((item) => item.click());
  await waitFor(() => Number(navSmallText('回收站')) === 0, 'restore after restart');
  clickLabel('所有素材', '.main-nav');
  await waitFor(() => settled() && cardCount() >= 5, 'restored asset back in the root view');
  const rootCountAfterRestore = cardCount();

  const stackCard = await waitFor(() => document.querySelector('.asset-card .stack-mark')?.closest('.asset-card') || null, 'stack card after restart');
  stackCard.click();
  await waitFor(() => settled() && cardCount() === 2, 'stack interior after restart');
  const stackCountShown = document.querySelector('.viewer-title span')?.textContent?.trim().split(' ')[0] || String(cardCount());

  return {
    mode: config.mode,
    restoreAfterRestartWorked: Number(navSmallText('回收站')) === 0,
    rootCountAfterRestore,
    stackCountShown,
    stackIdStillValid: cardCount() === 2,
  };
})()
`;
}
