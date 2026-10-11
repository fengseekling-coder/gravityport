// Empty-library live-append e2e flow: the page is open on a brand-new empty
// library (the "素材库还是空的" empty state on screen), then a batch of images
// arrives from OUTSIDE the page (rapid POST /api/assets/create, the shape the
// capture plugin and external writers use) without any reload. Every imported
// card must join a real masonry grid: the empty state must be gone, cards must
// keep sane widths, and the column variable must describe a multi-column grid.
//
// Regression background (task 122, observed once in an isolated instance):
// the incremental reconciliation path committed new cards after the still
// mounted .gallery-empty-state element, so the `.grid:has(.gallery-empty-state)
// { display: flex }` rule squeezed the whole batch into one 23px-wide row.
//
// Rendezvous without a pre-seeded canary (the library must stay empty until
// the page is ready): the page itself fires import #1 with a raw
// /api/assets/create fetch — the exact request an external writer makes; it
// does not touch the app's UI layer — and only PATCHes the marker prompt once
// the first pushed card is provably in the DOM. Node then fires the rest of
// the batch rapid-fire, so the batch lands while the page is live.

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "empty-live-append";
export const description = "empty library, page open -> rapid external /api/assets/create batch without reload -> empty state gone, real masonry columns, sane card widths";

const TOTAL_IMPORTS = 24;
const PAGE_WAIT_MS = 45_000;
const MARKER_WAIT_MS = 60_000;
// 1440 wide: the contract is a multi-column gallery (--gallery-columns > 1).
const WINDOW_SIZE = [1440, 900];

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function pageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const waitTick = (ms) => new Promise((resolveTick) => setTimeout(resolveTick, ms));
    async function waitForAsync(check, label, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
        await waitTick(100);
      }
      throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '') + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
    }

    // Recording EventSource wrapper: the app keeps owning its stream; we only
    // observe readyState and event counts (same pattern as live-sync).
    const sse = { sources: [] };
    const NativeEventSource = window.EventSource;
    window.EventSource = function (url, init) {
      const source = new NativeEventSource(url, init);
      const record = { url: String(url), readyAt: 0, changedEvents: 0, source: source };
      source.addEventListener('ready', () => { record.readyAt = Date.now(); });
      source.addEventListener('library-changed', () => { record.changedEvents += 1; });
      sse.sources.push(record);
      return source;
    };

    // The hidden e2e window never starts the SSE stream on its own
    // (startLibraryEventStream returns early while document.hidden), but the
    // real scenario is a visible browser tab. Drive the app's real
    // visibilitychange handler once to take the visible path.
    let fakeHidden = true;
    function setFakeVisibility(hidden) {
      fakeHidden = hidden;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => fakeHidden });
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (fakeHidden ? 'hidden' : 'visible') });
      document.dispatchEvent(new Event('visibilitychange'));
    }
    setFakeVisibility(false);
    await waitFor(() => {
      const record = sse.sources.at(-1);
      return Boolean(record) && record.source.readyState === 1 && record.readyAt > 0;
    }, 'live SSE stream connected', 15000);

    // Baseline: empty state on screen, no cards, sidebar count rendered as 0.
    const grid = () => document.querySelector('#assetGrid');
    const emptyState = () => grid()?.querySelector(':scope > .gallery-empty-state') || null;
    await waitFor(() => gallerySettled() && emptyState() && emptyState().dataset.emptyKind === 'library-empty',
      'library-empty state on screen', 20000);
    await waitFor(() => rootCardIds().length === 0, 'gallery holds no cards', 5000);
    const allCount = () => document.querySelector('#quickFilters [data-filter="all"] .nav-count')?.textContent || '';
    await waitForAsync(async () => {
      if (allCount() === '') return false;
      const response = await fetch('/api/navigation?project=default', { headers: { 'x-mosa-client-token': config.clientToken } });
      if (!response.ok) return false;
      return Number(allCount()) === Number((await response.json())?.navigation?.total);
    }, 'sidebar counts rendered and matching the empty server', 20000);
    const columnsAtEmpty = grid().style.getPropertyValue('--gallery-columns') || '(unset)';
    const displayAtEmpty = getComputedStyle(grid()).display;

    // Import #1 from the open page via the raw external-writer request shape.
    const firstResponse = await fetch('/api/assets/create', {
      method: 'POST',
      headers: { 'x-mosa-client-token': config.clientToken, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'default', imagePath: config.firstImagePath, prompt: config.firstPrompt }),
    });
    if (!firstResponse.ok) throw new Error('first external create failed: ' + firstResponse.status + ' ' + (await firstResponse.text()).slice(0, 200));
    const firstAssetId = String((await firstResponse.json())?.asset?.id || '');
    if (!firstAssetId) throw new Error('first external create returned no asset id');

    // Evidence at the moment the first pushed card lands: is the empty state
    // still a grid child, and what does the grid structure look like?
    let emptyStillThereAtFirstCard = null;
    let gridChildCountAtFirstCard = 0;
    let firstChildClassAtFirstCard = '';
    await waitFor(() => {
      const card = grid()?.querySelector(':scope > .asset-card[data-id="' + CSS.escape(firstAssetId) + '"]');
      if (!card) return false;
      emptyStillThereAtFirstCard = Boolean(emptyState());
      gridChildCountAtFirstCard = grid().children.length;
      firstChildClassAtFirstCard = grid().firstElementChild?.className || '';
      return true;
    }, 'first pushed card appears without reload', 30000);

    // Readiness marker for the Node side: only PATCH once the first card has
    // landed, so the rapid batch starts against a provably processed commit.
    const marker = 'empty-live-append-rest-ready-' + config.stamp;
    const patchResponse = await fetch('/api/assets/default/' + encodeURIComponent(firstAssetId), {
      method: 'PATCH',
      headers: { 'x-mosa-client-token': config.clientToken, 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: marker }),
    });
    if (!patchResponse.ok) throw new Error('marker PATCH failed: ' + patchResponse.status);

    // Node fires the remaining imports now: every imported asset must show up
    // as a card and the sidebar count must agree, all without a reload.
    await waitFor(() => grid().querySelectorAll(':scope > .asset-card').length >= config.totalCount,
      'every imported card appears', ${PAGE_WAIT_MS});
    await waitFor(() => allCount() === String(config.totalCount),
      'sidebar all-assets count reaches ' + config.totalCount, 30000);

    const cards = [...grid().querySelectorAll(':scope > .asset-card')];
    const sampledCards = cards.slice(0, 3).concat(cards.slice(-2));
    const verdict = {
      firstAssetId,
      emptyStillThereAtFirstCard,
      gridChildCountAtFirstCard,
      firstChildClassAtFirstCard,
      emptyStateGone: !emptyState(),
      emptyStateKindNow: emptyState()?.dataset.emptyKind || '',
      childCount: grid().children.length,
      firstChildClass: grid().firstElementChild?.className || '',
      cardCount: cards.length,
      cardWidths: sampledCards.map((card) => Math.round(card.getBoundingClientRect().width)),
      gridDisplay: getComputedStyle(grid()).display,
      galleryColumnsInline: grid().style.getPropertyValue('--gallery-columns') || '(unset)',
      loadedAssets: grid().dataset.loadedAssets || '',
      sidebarAllCount: allCount(),
      columnsAtEmpty,
      displayAtEmpty,
      sseChangedEvents: sse.sources.at(-1)?.changedEvents ?? -1,
      rendererErrors: rendererErrors.slice(0, 3),
    };

    // Mirror case: every asset is archived from OUTSIDE the page (raw fetch, the
    // shape an external writer uses), still without a reload. The incremental
    // commit only detaches cards, so the grid must hand the emptied list back to
    // the full render and show an empty state instead of a blank grid. Recorded,
    // not thrown, so the Node side can report it next to the first verdict.
    const removal = { archived: 0, emptyKind: '', cardCount: -1, timedOut: false };
    for (const card of cards) {
      const response = await fetch('/api/assets/default/' + encodeURIComponent(card.dataset.id) + '/archive', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mosa-client-token': config.clientToken },
        body: '{}',
      });
      if (response.ok) removal.archived += 1;
    }
    try {
      await waitFor(() => grid().querySelectorAll(':scope > .asset-card').length === 0 && Boolean(emptyState()),
        'an empty state replaces the last archived card', 30000);
    } catch {
      removal.timedOut = true;
    }
    removal.emptyKind = emptyState()?.dataset.emptyKind || '';
    removal.cardCount = grid().querySelectorAll(':scope > .asset-card').length;
    removal.childCount = grid().children.length;
    verdict.removal = removal;
    return verdict;
  })()`;
}

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    // Fixtures first, so the measured window contains only the imports.
    const imagePaths = [];
    for (let index = 0; index < TOTAL_IMPORTS; index += 1) {
      imagePaths.push(await ctx.makePng(
        `empty-live-append-${stamp}-${String(index).padStart(2, "0")}.png`,
        [(index * 37) % 256, (index * 71) % 256, (index * 113) % 256],
      ));
    }

    const state = { failure: null };
    const pagePromise = ctx.runInPage(server, pageSource({
      stamp,
      clientToken: ctx.token,
      totalCount: TOTAL_IMPORTS,
      firstImagePath: imagePaths[0],
      firstPrompt: `empty-live-append first ${stamp}`,
    }), { windowSize: WINDOW_SIZE }).catch((error) => {
      state.failure = error instanceof Error ? error : new Error(String(error));
      return null;
    });

    // Rendezvous: poll the assets API until the page's marker prompt shows up
    // (the page only PATCHes it after the first pushed card is in the DOM).
    const marker = `empty-live-append-rest-ready-${stamp}`;
    const deadline = Date.now() + MARKER_WAIT_MS;
    let markerSeen = false;
    while (Date.now() < deadline) {
      if (state.failure) throw state.failure;
      try {
        const page = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
        if ((page?.assets || []).some((asset) => asset.prompt === marker)) { markerSeen = true; break; }
      } catch { /* API hiccup: keep polling until the deadline */ }
      await sleep(150);
    }
    if (!markerSeen) {
      throw new Error(`empty-live-append: the page never confirmed the first card (marker ${marker})${state.failure ? `; page error: ${state.failure.message}` : ""}`);
    }

    // The rapid external batch: sequential POSTs keep the order deterministic
    // while still landing well inside the live-sync window.
    const batchStartedAt = Date.now();
    for (let index = 1; index < TOTAL_IMPORTS; index += 1) {
      const body = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: imagePaths[index],
        prompt: `empty-live-append batch ${stamp} #${index}`,
      });
      if (!body?.asset?.id) throw new Error(`empty-live-append: batch import #${index} returned no asset id`);
    }
    const batchMs = Date.now() - batchStartedAt;

    const result = await pagePromise;
    if (!result) throw state.failure || new Error("page returned a null result");

    const problems = [];
    if (result.emptyStillThereAtFirstCard !== false) problems.push(`the empty state was still mounted when the first pushed card landed (${JSON.stringify(result.emptyStillThereAtFirstCard)})`);
    if (result.emptyStateGone !== true) problems.push(`.gallery-empty-state survived external imports (kind now: ${JSON.stringify(result.emptyStateKindNow)})`);
    if (result.cardCount !== TOTAL_IMPORTS) problems.push(`card count ${result.cardCount} != imported ${TOTAL_IMPORTS}`);
    if (result.loadedAssets !== String(TOTAL_IMPORTS)) problems.push(`loadedAssets dataset ${JSON.stringify(result.loadedAssets)} != ${TOTAL_IMPORTS}`);
    if (!Array.isArray(result.cardWidths) || !result.cardWidths.length || Math.min(...result.cardWidths) <= 100) {
      problems.push(`card widths collapsed (${JSON.stringify(result.cardWidths)})`);
    }
    const columns = Number.parseInt(result.galleryColumnsInline, 10);
    if (!(columns > 1)) problems.push(`--gallery-columns ${JSON.stringify(result.galleryColumnsInline)} is not a multi-column grid at ${WINDOW_SIZE[0]}px`);
    if (result.rendererErrors?.length) problems.push(`renderer errors: ${JSON.stringify(result.rendererErrors)}`);
    const removal = result.removal || {};
    if (removal.archived !== TOTAL_IMPORTS) problems.push(`only ${removal.archived} of ${TOTAL_IMPORTS} external archives succeeded`);
    if (removal.cardCount !== 0 || !removal.emptyKind) {
      problems.push(`after every asset was archived from outside the grid showed ${removal.cardCount} card(s) and empty state ${JSON.stringify(removal.emptyKind)} (children ${removal.childCount})`);
    }
    if (problems.length) {
      throw new Error(`empty-live-append: ${problems.join("; ")} — full verdict ${JSON.stringify(result)}`);
    }

    return {
      imported: TOTAL_IMPORTS,
      batchMs,
      cardWidths: result.cardWidths,
      galleryColumns: columns,
      gridDisplay: result.gridDisplay,
      columnsAtEmpty: result.columnsAtEmpty,
      sseChangedEvents: result.sseChangedEvents,
      emptyKindAfterRemoval: removal.emptyKind,
    };
  } finally {
    await server.stop();
  }
}
