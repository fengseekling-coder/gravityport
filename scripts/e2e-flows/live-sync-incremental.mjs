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
    // 342: on Windows CI the scroll-load phase stalled while the seeded
    // cards' derivative backfill was still journaling. Loading the 260-card
    // window is prep, not the subject under test, so wait for the library to
    // settle before opening the page. Two conditions, both required: every
    // asset carries its final width/height (gallery-scroll-restore.mjs
    // allDimsSettled) and the library revision holds still for 1.5s (the
    // page-side waitQuiet criterion below, moved to the Node side). The
    // "opens while churn is in flight" case is live-sync-import-derivatives'.
    const waitForLibraryQuiet = async () => {
      const startedAt = Date.now();
      const deadline = startedAt + 60000;
      let lastRevision = null;
      let stableSince = startedAt;
      let missingDimensions = 0;
      const allDimsSettled = async () => {
        let cursor = "";
        let count = 0;
        missingDimensions = 0;
        do {
          const data = await ctx.api(server.origin, "GET",
            `/api/assets?project=default&view=gallery&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
          for (const asset of data.assets || []) {
            const fields = asset.business_fields || {};
            if (!(Number(fields.width) > 0 && Number(fields.height) > 0)) missingDimensions += 1;
            count += 1;
          }
          cursor = data.page?.nextCursor || "";
        } while (cursor);
        return missingDimensions === 0 && count >= SEED_TOTAL;
      };
      for (;;) {
        if (Date.now() >= deadline) {
          throw new Error(`library never went quiet before opening the page (waited ${Date.now() - startedAt}ms): `
            + `revision=${JSON.stringify(lastRevision)}, assets missing width/height=${missingDimensions}`);
        }
        const dimsSettled = await allDimsSettled();
        const { revision } = await ctx.api(server.origin, "GET", "/api/library-revision?project=default");
        if (revision !== lastRevision) { lastRevision = revision; stableSince = Date.now(); }
        if (dimsSettled && Date.now() - stableSince >= 1500) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      return Date.now() - startedAt;
    };
    const quietMs = await waitForLibraryQuiet();
    console.log(`[e2e] flow live-sync-incremental: library quiet after ${quietMs}ms, opening the page`);
    const result = await ctx.runInPage(server, incrementalSource(favoriteTarget, trashTarget), { windowSize: [1440, 940] });
    if (result?.loaded !== SEED_TOTAL || result?.favoriteShown !== true || result?.trashGone !== true
      || result?.createdFirst !== true || result?.fullReloads !== 0 || result?.sidebarTrash !== 1
      || result?.totalAfterCreate !== SEED_TOTAL) {
      throw new Error(`live-sync-incremental result: ${JSON.stringify(result)}`);
    }
    return { ...result, quietMs };
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
    // Keep nudging to the bottom until the window is complete: a slow runner
    // can still be fetching when a fixed number of scrolls runs out, and with
    // nobody scrolling the next page never triggers.
    // 342: when this stalls on CI the bare timeout message carries no
    // evidence, so sample the loading state every 2s (keep the last 30) and
    // attach the trajectory to the timeout error. The flow still fails.
    const pagedRequestCount = () => performance.getEntriesByType('resource')
      .filter(entry => assetsPath(entry.name) === '/api/assets' && new URL(entry.name).searchParams.has('cursor'))
      .length;
    const samples = [];
    const scrollStartedAt = Date.now();
    const sampler = setInterval(() => {
      const g = grid();
      samples.push({
        t: Date.now() - scrollStartedAt,
        loaded: loadedCount(),
        scrollTop: Math.round(g?.scrollTop || 0),
        scrollHeight: g?.scrollHeight || 0,
        clientHeight: g?.clientHeight || 0,
        pagedRequests: pagedRequestCount(),
        visibility: document.visibilityState,
      });
      if (samples.length > 30) samples.splice(0, samples.length - 30);
    }, 2000);
    const scroller = grid();
    try {
      await waitFor(() => {
        if (loadedCount() === ${SEED_TOTAL}) return true;
        scroller.scrollTop = scroller.scrollHeight;
        return false;
      }, 'all 260 cards loaded', 90000);
    } catch (error) {
      throw new Error(String(error?.message || error) + ' ' + JSON.stringify({
        loaded: loadedCount(),
        pagedRequests: pagedRequestCount(),
        syncStats: window.__mosaLibrarySync?.stats() ?? null,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        samples,
      }));
    } finally {
      clearInterval(sampler);
    }
    // The seeded cards queue thumbnail work that journals its own library
    // changes. Count delta requests only once the library has gone quiet, so
    // background derivative changes are not billed to the step under test.
    const waitQuiet = async (label) => {
      const deadline = Date.now() + 90000;
      let last = null;
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        const { revision } = await api('/api/library-revision?project=default');
        if (revision !== last) { last = revision; stableSince = Date.now(); }
        else if (Date.now() - stableSince >= 1500) {
          await sleep(300);
          return;
        }
        await sleep(250);
      }
      throw new Error('Timed out waiting for the library to go quiet before ' + label);
    };
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
    await waitQuiet('favorite');
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
    await waitQuiet('trash');
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
    await waitQuiet('create');
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
