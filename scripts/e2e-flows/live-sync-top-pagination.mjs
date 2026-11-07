// GravityPort React UI flow (320 返工 2):
// 加载超过 320 张卡片（激活虚拟化窗口）后回到顶部收藏一张，断言 gallery-rows ≤ 1；
// 随后再次滚动到底部，断言翻页机制正常恢复继续加载（loaded 数变多），证明守卫不会卡死。
export const name = "live-sync-top-pagination";
export const description = "load >320 cards (virtual window active) -> back to top -> favorite (gallery-rows <= 1) -> scroll down -> pagination continues";

const SEED_TOTAL = 420;
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("live-sync-top-pagination-fixture.png", [50, 120, 200]);
    let created = 0;
    while (created < SEED_TOTAL) {
      const batch = Math.min(20, SEED_TOTAL - created);
      await Promise.all(Array.from({ length: batch }, (_, index) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default",
          imagePath: fixturePath,
          prompt: `top pagination guard ${created + index}`,
        })));
      created += batch;
    }

    const ids = [];
    let cursor;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await ctx.api(server.origin, "GET", `/api/assets?project=default&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      ids.push(...page.assets.map(asset => asset.id));
      if (!page.page.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    if (ids.length !== SEED_TOTAL) throw new Error(`seeded ${ids.length}, expected ${SEED_TOTAL}`);

    const result = await ctx.runInPage(server, topPaginationSource(ids[0]), { windowSize: [1440, 940] });
    if (result?.topLoaded <= 320 || result?.rowsOnFavorite > 1 || !result?.paginationContinued) {
      throw new Error(`live-sync-top-pagination result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function topPaginationSource(targetCardId) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }

    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const api = (path, method, body) => fetch(path, {
      method: method || 'GET',
      headers: { 'x-mosa-client-token': clientToken(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(method + ' ' + path + ' -> ' + response.status);
      return response.json();
    });

    const grid = () => document.querySelector('.asset-grid');
    const loadedCount = () => Number(grid()?.getAttribute('data-loaded-assets') || 0);
    const assetsPath = (name) => { try { return new URL(name).pathname } catch { return name } };
    const deltaCalls = (path) => performance.getEntriesByType('resource').filter(entry => assetsPath(entry.name) === path).length;

    // 1. 等待第一页加载完成
    await waitFor(() => loadedCount() === ${PAGE_SIZE}, 'first page loaded');

    // 2. 向下滚动使加载素材数量超过 320 张（激活虚拟化窗口）
    const scroller = grid();
    for (let guard = 0; guard < 30 && loadedCount() <= 320; guard += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      await sleep(180);
    }
    await waitFor(() => loadedCount() > 320, 'loaded more than 320 cards');
    const topLoaded = loadedCount();

    // 3. 回到顶部
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll'));
    await sleep(300);

    // 4. 收藏首张素材，统计期间 gallery-rows 请求数
    // The seeded cards queue derivative work that journals its own library
    // changes, and each derivative flush fetches gallery rows too. Revision
    // stability alone proved too weak on Windows CI (352): with 2 concurrent
    // worker jobs a >1.5s gap between two completions — or a claim backoff
    // after SQLITE_BUSY — reads as quiet while jobs remain, and the next
    // completion lands inside the measurement window (rowsOnFavorite 2-3).
    // So gate on the real end state: a derivative job writes width/height,
    // preview and thumbnail in ONE update, so every seeded asset carrying
    // dimensions plus preview_ready/thumbnail_ready means the queue is fully
    // drained. The stable revision on top covers anything the API cannot see.
    const countUnsettled = async () => {
      let cursor = '';
      let count = 0;
      let unsettled = 0;
      do {
        const data = await api('/api/assets?project=default&limit=250' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        for (const asset of data.assets || []) {
          const width = Number(asset.business_fields?.width) || 0;
          const height = Number(asset.business_fields?.height) || 0;
          if (!(width > 0 && height > 0) || asset.thumbnail_ready !== true || asset.preview_ready !== true) unsettled += 1;
          count += 1;
        }
        cursor = data.page?.nextCursor || '';
      } while (cursor);
      return { count, unsettled };
    };
    const waitAllSettled = async () => {
      const startedAt = Date.now();
      const deadline = startedAt + 120000;
      let lastRevision = null;
      let stableSince = startedAt;
      for (;;) {
        if (Date.now() >= deadline) {
          const snapshot = await countUnsettled().catch(() => ({ count: -1, unsettled: -1 }));
          throw new Error('library never settled before favorite (waited ' + (Date.now() - startedAt) + 'ms): '
            + 'assets=' + snapshot.count + ', missing dimensions/derivatives=' + snapshot.unsettled
            + ', revision=' + JSON.stringify(lastRevision));
        }
        const settledSnapshot = await countUnsettled();
        const settled = settledSnapshot.unsettled === 0 && settledSnapshot.count >= ${SEED_TOTAL};
        const { revision } = await api('/api/library-revision?project=default');
        if (revision !== lastRevision) { lastRevision = revision; stableSince = Date.now(); }
        if (settled && Date.now() - stableSince >= 1500) break;
        await sleep(250);
      }
      await sleep(300);
    };
    await waitAllSettled();
    const beforeRows = deltaCalls('/api/gallery-rows');
    const beforeChanges = deltaCalls('/api/library-changes');
    await api('/api/assets/default/' + ${JSON.stringify(targetCardId)} + '/favorite', 'POST');
    await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(targetCardId)} + '"] .favorite-mark'), 'favorite mark displayed');
    await sleep(400);

    const rowsOnFavorite = deltaCalls('/api/gallery-rows') - beforeRows;
    // 352 diagnostics carried on the result line: changesOnFavorite === 0
    // with rowsOnFavorite > 1 would mean the app re-rows without any journal
    // change; unsettledAfterMeasurement > 0 would mean background derivative
    // churn leaked past the settle gate into the window.
    const changesOnFavorite = deltaCalls('/api/library-changes') - beforeChanges;
    const unsettledAfterMeasurement = (await countUnsettled()).unsettled;

    // 5. 再次滚到底部，验证翻页机制未卡死，能正常继续向下翻页加载
    const loadedBeforeScroll = loadedCount();
    for (let guard = 0; guard < 25; guard += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll'));
      if (loadedCount() > loadedBeforeScroll) break;
      await sleep(200);
    }
    const finalLoaded = loadedCount();
    const paginationContinued = finalLoaded > loadedBeforeScroll;

    return {
      topLoaded,
      rowsOnFavorite,
      changesOnFavorite,
      unsettledAfterMeasurement,
      loadedBeforeScroll,
      finalLoaded,
      paginationContinued,
    };
  })()`;
}
