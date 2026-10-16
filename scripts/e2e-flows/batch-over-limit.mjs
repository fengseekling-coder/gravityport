// GravityPort React UI flow: a cross-page select-all larger than the server's
// 1,000-id /api/assets/batch cap is submitted in sequential chunks, every
// action reports what the server actually confirmed, and a failed chunk is
// never announced as a full success.
export const name = "batch-over-limit";
export const description = "1001 assets -> ⌘A selects all across pages -> favorite lands in 2 chunks -> group removal in 2 chunks -> trash with a failed 2nd chunk reports '1000 moved, 1 failed' and server truth agrees -> retry finishes the job";
const TOTAL = 1001;
const GROUP_NAME = "e2e-batch-group";
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("batchlimit-fixture.png", [127, 74, 181]);
    const workers = 6;
    let created = 0;
    while (created < TOTAL) {
      const batch = Math.min(workers, TOTAL - created);
      await Promise.all(Array.from({ length: batch }, () =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: "batch over limit",
        })));
      created += batch;
    }
    // Server-side setup for the group leg: a group with every asset in it.
    // The assignment itself is split around the server's 1,000-id cap.
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    const allIds = [];
    let cursor = "";
    while (true) {
      const page = await ctx.api(server.origin, "GET",
        `/api/assets?project=default&limit=250&view=gallery${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const asset of page.assets || []) allIds.push(asset.id);
      cursor = page.page?.nextCursor || "";
      if (!cursor) break;
    }
    if (allIds.length !== TOTAL) throw new Error(`seeded ${allIds.length} ids, expected ${TOTAL}`);
    for (let offset = 0; offset < allIds.length; offset += 1000) {
      await ctx.api(server.origin, "POST", "/api/assets/batch", {
        action: "group", projectId: "default", assetIds: allIds.slice(offset, offset + 1000), group: GROUP_NAME,
      });
    }
    const result = await ctx.runInPage(server, flowSource(), { windowSize: [1440, 940] });
    if (result?.selectAll !== true || result?.favoriteChunked !== true || result?.groupChunked !== true
      || result?.partialTrashHonest !== true || result?.retryFinished !== true) {
      throw new Error(`batch-over-limit result: ${JSON.stringify(result)}`);
    }
    // Server truth at the end: every asset is in Trash, nothing active.
    const trashed = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=1");
    if ((trashed.page?.total ?? -1) !== TOTAL) {
      throw new Error(`server trash total ${trashed.page?.total} != ${TOTAL}`);
    }
    const active = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=1");
    if ((active.page?.total ?? -1) !== 0) {
      throw new Error(`server still lists ${active.page?.total} active assets`);
    }
    const groups = await ctx.api(server.origin, "GET", "/api/navigation?project=default");
    const group = (groups.navigation?.groups || []).find(entry => entry.name === GROUP_NAME);
    if (group && Number(group.count || 0) !== 0) {
      throw new Error(`group ${GROUP_NAME} still holds ${group.count} assets`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function flowSource() {
  return `(async () => {
    const TOTAL = ${TOTAL};
    const PAGE_SIZE = ${PAGE_SIZE};
    const GROUP_NAME = ${JSON.stringify(GROUP_NAME)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | loaded=' + (document.querySelector('.asset-grid')?.dataset.loadedAssets || '?')
        + ' | selected=' + document.querySelectorAll('.asset-card.asset-selected').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | batchPosts=' + window.__batchPosts);
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const mountedCards = () => Array.from(document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)'));
    // The toast message without its action button (task 142 adds 撤销).
    const toastText = () => Array.from(document.querySelector('.toast')?.childNodes || [])
      .filter((node) => !(node.nodeType === 1 && node.matches('button')))
      .map((node) => node.textContent).join('').trim();
    const toastAction = () => (document.querySelector('.toast .toast-action')?.textContent || '').trim();
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const pressSelectAll = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    const groupRow = () => Array.from(document.querySelectorAll('.sidebar .group-row'))
      .find((button) => button.getAttribute('aria-label') === GROUP_NAME) || null;
    const openContextMenu = async (label) => {
      mountedCards()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      await waitFor(() => document.querySelector('.context-menu'), 'context menu');
      const item = Array.from(document.querySelectorAll('.context-menu button'))
        .find((entry) => entry.textContent.trim() === label);
      if (!item) throw new Error('missing context menu item: ' + label);
      item.click();
    };
    const confirmTrash = async () => {
      await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'batch delete confirm');
      const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
        .find((button) => button.textContent.trim() === '移至回收站');
      confirm.click();
    };

    await waitFor(() => loadedCount() === PAGE_SIZE, 'the first page loads exactly');

    // Count every batch POST and every select-all page from here on.
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    const previousFetch = window.__origFetch;
    window.__batchPosts = 0;
    window.__batchFailAt = -1;
    window.__selectPages = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input.url || '');
      if (url.includes('/api/assets/batch')) {
        window.__batchPosts += 1;
        if (window.__batchFailAt === window.__batchPosts) {
          return new Response(JSON.stringify({ error: 'synthetic chunk failure' }),
            { status: 500, headers: { 'content-type': 'application/json' } });
        }
      }
      if (url.includes('limit=250')) window.__selectPages += 1;
      return previousFetch(input, init);
    };

    // ── 1) Cross-page select-all picks up the whole 1001-asset result ──
    pressSelectAll();
    await waitFor(() => toastText() === '已选 ' + TOTAL + ' 项', 'select-all announces the full result');
    const selectAll = window.__selectPages >= 5 && loadedCount() === PAGE_SIZE;

    // ── 2) Favorite: two chunks, every row confirmed server-side ──
    await openContextMenu('收藏');
    await waitFor(() => navSmall('收藏') === String(TOTAL), 'favorite count reaches the server');
    const favoriteChunked = window.__batchPosts === 2;

    // ── 3) Group removal: two chunks over the same selection ──
    groupRow()?.click();
    await waitFor(() => groupRow()?.getAttribute('aria-current') === 'page' && loadedCount() === PAGE_SIZE,
      'the group view loads');
    pressSelectAll();
    await waitFor(() => toastText() === '已选 ' + TOTAL + ' 项', 'select-all inside the group view');
    await openContextMenu('移除分组');
    await waitFor(() => groupRow()?.querySelector('small')?.textContent === '0', 'group drains to zero');
    const groupChunked = window.__batchPosts === 4;

    // ── 4) Trash with a failing second chunk: partial truth, never fake success ──
    Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes('所有素材'))?.click();
    await waitFor(() => loadedCount() === PAGE_SIZE, 'back on the all-assets view');
    pressSelectAll();
    await waitFor(() => toastText() === '已选 ' + TOTAL + ' 项', 'select-all before the partial trash');
    window.__batchPosts = 0;
    window.__batchFailAt = 2;
    await openContextMenu('移至回收站');
    await confirmTrash();
    await waitFor(() => toastText() === '已移至回收站 ' + (TOTAL - 1) + ' 项，1 项失败',
      'the partial result is announced with real counts');
    // Read the toast's action and the POST count right away (the toast times
    // out); the sidebar trash count arrives with the navigation refetch that
    // follows, which lags the toast on slow runners — wait for it instead of
    // sampling once.
    const partialAction = toastAction();
    const partialPosts = window.__batchPosts;
    const trashNavSettled = await waitFor(() => navSmall('回收站') === String(TOTAL - 1),
      'the sidebar trash count catches up', 20000).then(() => true, () => false);
    const partialDetail = { posts: partialPosts, action: partialAction, trashNav: navSmall('回收站') };
    const partialTrashHonest = partialPosts === 2 && trashNavSettled && partialAction === '撤销';
    window.__batchFailAt = -1;

    // ── 5) Retry on the survivor: one chunk, the job finishes ──
    pressSelectAll();
    await sleep(300);
    await openContextMenu('移至回收站');
    await confirmTrash();
    await waitFor(() => navSmall('回收站') === String(TOTAL) && navSmall('所有素材') === '0',
      'the retry moves the last asset');
    const retryFinished = window.__batchPosts === 3;

    return { selectAll, favoriteChunked, groupChunked, partialTrashHonest, partialDetail, retryFinished,
      selectPages: window.__selectPages, batchPosts: window.__batchPosts };
  })()
  `;
}
