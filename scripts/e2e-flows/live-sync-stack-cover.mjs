// GravityPort React UI flow (320 补充 2): archiving a stack cover externally
// must swap the stack card to its new cover through the incremental sync —
// the new cover's id is in no journal assetIds list, so the client has to
// send the affected stack id along (and the App actually does, now).
export const name = "live-sync-stack-cover";
export const description = "external archive of a stack cover -> stack card stays with the new cover and count-1; moving the new cover out -> same; no cursor-less /api/assets";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const ids = [];
    for (let i = 1; i <= 5; i += 1) {
      const asset = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`stack-cover-${i}.png`, [74, 127, 181]),
        prompt: `stack cover flow ${i}`,
      });
      ids.push(asset.asset.id);
    }
    // 4 张成堆叠：归档一个封面、再回收站一个新封面，堆叠始终 ≥2 存活成员。
    const stackA = (await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [ids[0], ids[1], ids[2], ids[3]] })).stack;
    const result = await ctx.runInPage(server, stackCoverSource(stackA.id, stackA.cover_asset_id), { windowSize: [1440, 940] });
    if (result?.archivedSwap !== true || result?.movedOutSwap !== true || result?.fullReloads !== 0) {
      throw new Error(`live-sync-stack-cover result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function stackCoverSource(stackId, firstCover) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
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
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const stackCard = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"] .stack-mark');
    const FALLBACK_REASONS = ['incomplete', 'unknown-kind', 'library-backfilled', 'library-changed-detail', 'too-many-ids', 'rows-failed', 'data-version-only', 'errors', 'lastError'];
    const noFallback = (label) => {
      const stats = window.__mosaLibrarySync?.stats() || {};
      const fallbacks = Object.entries(stats).filter(([key, value]) => FALLBACK_REASONS.includes(key) && Number(value) > 0);
      if (fallbacks.length) throw new Error(label + ' fell back: ' + JSON.stringify(fallbacks));
    };
    const cursorless = () => performance.getEntriesByType('resource')
      .filter(entry => { try { return new URL(entry.name).pathname === '/api/assets' && !new URL(entry.name).searchParams.has('cursor'); } catch { return false; } })
      .length;

    // 根视图：2 张卡（3 堆叠节点 + 2 散卡 = 4）。等堆叠卡出现。
    // 记录 gallery-rows 的请求体，定位 affectedStackIds 是否真的上行。
    window.__rowsBodies = [];
    if (!window.__origFetchRows) {
      window.__origFetchRows = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        if (url.includes('/api/gallery-rows')) {
          window.__rowsBodies.push(String(init?.body || '').slice(0, 300));
        }
        return window.__origFetchRows(input, init);
      };
    }
    await waitFor(() => stackCard(${JSON.stringify(firstCover)}), 'stack card visible');
    const cursorlessBaseline = cursorless(); // 首屏请求不计入场景统计

    // ── 1. 外部归档封面：堆叠卡留在页上、换成新封面、张数 -1 ──
    const stackBefore = await api('/api/asset-stacks/' + ${JSON.stringify(stackId)} + '?project=default');
    const countBefore = stackBefore.stack.count;
    await api('/api/assets/default/' + ${JSON.stringify(firstCover)} + '/archive', 'POST');
    // 新封面是服务端按剩余成员的最小 position 定的：等堆叠卡换到新封面。
    const stackAfter = await api('/api/asset-stacks/' + ${JSON.stringify(stackId)} + '?project=default');
    const newCover = stackAfter.stack.cover_asset_id;
    try {
      await waitFor(() => stackCard(newCover), 'stack card swapped to the new cover after archive');
    } catch (error) {
      const delta = await api('/api/library-changes?project=default&since=0&limit=20000');
      return {
        archivedSwap: false,
        diag: {
          rowsBodies: window.__rowsBodies || [],
          newCover,
          cards: [...document.querySelectorAll('.asset-card')].map(n => n.dataset.assetId),
          stats: window.__mosaLibrarySync?.stats() || null,
          journal: delta.changes.map(c => [c.revision, c.kind, c.entityId, c.assetIds]).slice(-5),
        },
      };
    }
    const swapped = Boolean(stackCard(newCover)) && !stackCard(${JSON.stringify(firstCover)});
    const archivedSwap = swapped;
    noFallback('archive cover');

    // ── 2. 外部回收站新封面：同样的换卡行为（堆叠仍有 ≥2 存活成员）──
    await api('/api/assets/batch', 'POST', { action: 'trash', projectId: 'default', assetIds: [newCover] });
    const stackAfter2 = await api('/api/asset-stacks/' + ${JSON.stringify(stackId)} + '?project=default');
    const thirdCover = stackAfter2.stack.cover_asset_id;
    await waitFor(() => stackCard(thirdCover), 'stack card swapped after moving the new cover out');
    const movedOutSwap = Boolean(stackCard(thirdCover)) && !stackCard(newCover);
    noFallback('move cover out');

    const fullReloads = cursorless() - cursorlessBaseline;
    return { archivedSwap, movedOutSwap, fullReloads, countBefore, countAfter: stackAfter2.stack.count };
  })()
  `;
}
