// GravityPort React UI flow (review 2-6): external mutations must reconcile
// the loaded gallery incrementally — no cursor-less /api/assets full reload,
// at most one library-changes + one gallery-rows request per change, cards
// land at their position, totals and the sidebar follow.
export const name = "live-sync-incremental";
export const description = "260 seeded cards, all loaded -> external favorite/trash/create each reconcile incrementally (0 full reloads, <=1 delta request each, counts follow)";

const SEED_TOTAL = 260;
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("live-sync-incremental-fixture.png", [74, 127, 181]);
    let created = 0;
    while (created < SEED_TOTAL) {
      const batch = Math.min(5, SEED_TOTAL - created);
      await Promise.all(Array.from({ length: batch }, (_, index) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: `live sync incremental ${created + index}`,
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
    const favoriteTarget = ids[149]; // 视口里的第 150 张（页面内已全部加载）
    const trashTarget = ids[119];
    const result = await ctx.runInPage(server, incrementalSource(favoriteTarget, trashTarget), { windowSize: [1440, 940] });
    if (result?.loaded !== SEED_TOTAL || result?.favoriteShown !== true || result?.trashGone !== true
      || result?.createdFirst !== true || result?.fullReloads !== 0 || result?.sidebarTrash !== 1
      || result?.totalAfterCreate !== SEED_TOTAL) {
      throw new Error(`live-sync-incremental result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function incrementalSource(favoriteTarget, trashTarget) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const cardIds = () => [...document.querySelectorAll('.asset-card[data-asset-id]')].map(el => el.dataset.assetId);
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

    await waitFor(() => loadedCount() === ${PAGE_SIZE}, 'first page rendered');
    // Load the whole window like a user scrolling down.
    const scroller = grid();
    for (let guard = 0; guard < 40 && loadedCount() < ${SEED_TOTAL}; guard += 1) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(220);
    }
    await waitFor(() => loadedCount() === ${SEED_TOTAL}, 'all 260 cards loaded');
    const syncStats = () => window.__mosaLibrarySync?.stats() || {};
    const FALLBACK_REASONS = ['incomplete', 'unknown-kind', 'library-backfilled', 'library-changed-detail', 'too-many-ids', 'rows-failed', 'data-version-only', 'errors', 'lastError'];
    const noFallback = (label) => {
      const stats = window.__mosaLibrarySync?.stats() || {};
      const fallbacks = Object.entries(stats).filter(([key, value]) => FALLBACK_REASONS.includes(key) && Number(value) > 0);
      if (fallbacks.length) throw new Error(label + ' fell back: ' + JSON.stringify(fallbacks));
    };

    // Resource bookkeeping: /api/assets without a cursor is a full reload.
    const cursorlessAssetRequests = () => performance.getEntriesByType('resource')
      .filter(entry => assetsPath(entry.name) === '/api/assets' && !new URL(entry.name).searchParams.has('cursor'))
      .length;
    const deltaCalls = (path) => performance.getEntriesByType('resource')
      .filter(entry => assetsPath(entry.name) === path).length;

    // 1. External favorite of the 150th card: the heart appears, and the
    // change rode one library-changes + one gallery-rows request at most.
    const beforeFavorite = { reloads: cursorlessAssetRequests(), changes: deltaCalls('/api/library-changes'), rows: deltaCalls('/api/gallery-rows') };
    await api('/api/assets/default/' + ${JSON.stringify(favoriteTarget)} + '/favorite', 'POST');
    try {
      await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(favoriteTarget)} + '"] .favorite-mark'), 'external favorite shows the heart');
    } catch (error) {
      const journal = await api('/api/library-changes?project=default&since=0&limit=20000');
      return {
        error: 'favorite-timeout',
        diag: {
          cardPresent: Boolean(document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(favoriteTarget)} + '"]')),
          cardCount: cardCount(),
          stats: syncStats(),
          journal: journal.changes.map((change) => [change.revision, change.kind, change.entityId, (change.assetIds || []).length]),
          loadedCount: loadedCount(),
        },
      };
    }
    noFallback('favorite');
    const favoriteDelta = { reloads: cursorlessAssetRequests() - beforeFavorite.reloads, changes: deltaCalls('/api/library-changes') - beforeFavorite.changes, rows: deltaCalls('/api/gallery-rows') - beforeFavorite.rows };
    if (favoriteDelta.reloads !== 0) throw new Error('favorite triggered a full reload: ' + JSON.stringify(favoriteDelta));
    if (favoriteDelta.changes > 1 || favoriteDelta.rows > 1) throw new Error('favorite needed too many delta requests: ' + JSON.stringify(favoriteDelta));

    // 2. External trash of the 120th card: the card leaves, the sidebar count follows.
    const beforeTrash = { reloads: cursorlessAssetRequests(), changes: deltaCalls('/api/library-changes'), rows: deltaCalls('/api/gallery-rows') };
    await api('/api/assets/batch', 'POST', { action: 'trash', projectId: 'default', assetIds: [${JSON.stringify(trashTarget)}] });
    await waitFor(() => !cardIds().includes(${JSON.stringify(trashTarget)}), 'external trash removes the card');
    noFallback('trash');
    const sidebarTrash = await waitFor(() => {
      const value = Number(document.querySelector('.main-nav .nav-row[aria-label="回收站"] small')?.textContent || '0');
      return value === 1 ? value : null;
    }, 'sidebar trash count follows', 10000);
    const trashDelta = { reloads: cursorlessAssetRequests() - beforeTrash.reloads, changes: deltaCalls('/api/library-changes') - beforeTrash.changes, rows: deltaCalls('/api/gallery-rows') - beforeTrash.rows };
    if (trashDelta.reloads !== 0) throw new Error('trash triggered a full reload: ' + JSON.stringify(trashDelta));

    // 3. External create: the new card lands first (newest-first), total +1.
    const beforeCreate = { reloads: cursorlessAssetRequests() };
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 24;
    const context = canvas.getContext('2d');
    context.fillStyle = '#2255aa';
    context.fillRect(0, 0, 32, 24);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const staged = await fetch('/api/import/stage', {
      method: 'POST',
      headers: { 'x-mosa-file-name': 'live-sync-incremental-new.png', 'x-mosa-client-token': clientToken() },
      body: blob,
    }).then((r) => r.json());
    await api('/api/assets/import-batch', 'POST', { projectId: 'default', items: [{ imagePath: staged.path }] });
    await sleep(600);
    const createdFirst = cardIds()[0] !== ${JSON.stringify(favoriteTarget)} && cardIds()[0] !== ${JSON.stringify(trashTarget)};
    await waitFor(() => cardCount() === ${SEED_TOTAL}, 'created card inserted in place (260 cards after the trash)');
    noFallback('create');
    const fullReloads = cursorlessAssetRequests() - beforeCreate.reloads + favoriteDelta.reloads + trashDelta.reloads;
    const totalAfterCreate = await api('/api/assets?project=default&limit=1&includeTotal=1').then(r => r.page.total);
    return {
      loaded: ${SEED_TOTAL},
      favoriteShown: true,
      trashGone: true,
      createdFirst,
      sidebarTrash,
      fullReloads,
      totalAfterCreate,
    };
  })()
  `;
}
