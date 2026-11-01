// GravityPort React UI flow (review 2-6): the open viewer follows external
// mutations — a deleted card steps to the one now at its position with the
// title counter intact; a card that merely left the view stays until the
// viewer closes, then leaves the view.
export const name = "live-sync-viewer";
export const description = "external trash under the open viewer steps to the next card (title 10 -> 10/11); external unfavorite pins the viewed card until the viewer closes";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // Twelve distinct names: viewer assertions read the title's strong text.
    const created = [];
    for (let i = 1; i <= 12; i += 1) {
      const asset = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`viewer-flow-${String(i).padStart(2, "0")}.png`, [74, 127, 181]),
        prompt: `viewer flow ${i}`,
      });
      created.push(asset.asset);
    }
    // Newest-first: card #10 (1-based) is creation 03, card #11 is creation 02.
    const tenth = created[2].id;
    // A favorite pair for the pinned-card part.
    const favoriteA = created[5].id;
    await ctx.api(server.origin, "POST", `/api/assets/default/${encodeURIComponent(favoriteA)}/favorite`);
    const favoriteB = created[7].id;
    await ctx.api(server.origin, "POST", `/api/assets/default/${encodeURIComponent(favoriteB)}/favorite`);

    const result = await ctx.runInPage(server, viewerSource(tenth, favoriteA), { windowSize: [1440, 940] });
    if (result?.steppedToEleventh !== true || result?.titleAfterTrash !== "10 / 11"
      || result?.pinnedWhileOpen !== true || result?.goneAfterClose !== true) {
      throw new Error(`live-sync-viewer result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function viewerSource(tenth, favoriteA) {
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
    const viewerTitle = () => document.querySelector('.viewer-title');
    const viewerName = () => document.querySelector('.viewer-title strong')?.textContent || '';
    const viewerCounter = () => document.querySelector('.viewer-title span')?.textContent || '';
    const FALLBACK_REASONS = ['incomplete', 'unknown-kind', 'library-backfilled', 'library-changed-detail', 'too-many-ids', 'rows-failed', 'data-version-only', 'errors', 'lastError'];
    const noFallback = (label) => {
      const stats = window.__mosaLibrarySync?.stats() || {};
      const fallbacks = Object.entries(stats).filter(([key, value]) => FALLBACK_REASONS.includes(key) && Number(value) > 0);
      if (fallbacks.length) throw new Error(label + ' fell back: ' + JSON.stringify(fallbacks));
    };

    await waitFor(() => cardCount() === 12, '12 cards rendered');

    // ── Part 1: external trash under the open viewer ──
    const tenthCard = document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(tenth)} + '"]');
    tenthCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => viewerTitle(), 'viewer opened on the tenth card');
    const nameAtOpen = viewerName();
    if (viewerCounter() !== '10 / 12') throw new Error('initial counter is ' + viewerCounter());
    await api('/api/assets/batch', 'POST', { action: 'trash', projectId: 'default', assetIds: [${JSON.stringify(tenth)}] });
    // The viewer steps to the card now sitting at the same position (the old
    // eleventh): the name changes, the counter stays 10, the total drops by one.
    await waitFor(() => viewerName() && viewerName() !== nameAtOpen, 'viewer stepped to the next card');
    const titleAfterTrash = viewerCounter();
    const steppedToEleventh = viewerName() !== nameAtOpen && titleAfterTrash === '10 / 11';
    noFallback('viewer trash');

    // Close the viewer for part 2.
    const backButton = Array.from(document.querySelectorAll('button')).find(node => node.textContent.includes('返回'));
    backButton.click();
    await waitFor(() => !viewerTitle(), 'viewer closed');

    // ── Part 2: external unfavorite under the open viewer in 收藏 ──
    const favoritesRow = document.querySelector('.main-nav .nav-row[aria-label="收藏"]');
    favoritesRow.click();
    await waitFor(() => cardCount() === 2, 'two favorites listed');
    const favoriteCard = document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(favoriteA)} + '"]');
    favoriteCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => viewerTitle(), 'viewer opened on the favorite');
    const favoriteNameAtOpen = viewerName();
    const titleBefore = viewerCounter();
    await api('/api/assets/default/' + ${JSON.stringify(favoriteA)} + '/favorite', 'POST');
    await sleep(700);
    // Unfavorited while viewing: still in the library, only out of this view —
    // the viewer keeps showing it (pinned), the counter unchanged.
    const pinnedWhileOpen = viewerName() === favoriteNameAtOpen && viewerCounter() === titleBefore;
    noFallback('viewer unfavorite');
    const backButton2 = Array.from(document.querySelectorAll('button')).find(node => node.textContent.includes('返回'));
    backButton2.click();
    try {
      await waitFor(() => cardCount() === 1, 'unfavorited card left 收藏 after the viewer closed');
    } catch (error) {
      return {
        steppedToEleventh, titleAfterTrash, pinnedWhileOpen,
        goneAfterClose: false,
        diag: {
          cardCount: cardCount(),
          stats: window.__mosaLibrarySync?.stats() || null,
          cards: [...document.querySelectorAll('.asset-card')].map(node => node.dataset.assetId),
          viewerOpen: Boolean(document.querySelector('.viewer-title')),
        },
      };
    }
    const goneAfterClose = cardCount() === 1;

    return { steppedToEleventh, titleAfterTrash, pinnedWhileOpen, goneAfterClose };
  })()
  `;
}
