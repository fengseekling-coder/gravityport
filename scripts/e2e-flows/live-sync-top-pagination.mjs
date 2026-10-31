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
    const beforeRows = deltaCalls('/api/gallery-rows');
    await api('/api/assets/default/' + ${JSON.stringify(targetCardId)} + '/favorite', 'POST');
    await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(targetCardId)} + '"] .favorite-mark'), 'favorite mark displayed');
    await sleep(400);

    const rowsOnFavorite = deltaCalls('/api/gallery-rows') - beforeRows;

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
      loadedBeforeScroll,
      finalLoaded,
      paginationContinued,
    };
  })()`;
}
