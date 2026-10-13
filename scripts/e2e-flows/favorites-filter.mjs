// GravityPort React UI flow: API-seeded favorites drive the sidebar filter and
// the inspector favorite toggle round-trips to the server.
export const name = "favorites-filter";
export const description = "API-seeded favorite -> Favorites nav filter shows only it -> inspector toggle unfavorites -> count updates -> restart keeps state";

export async function run(ctx) {
  await ctx.prepare();
  const first = await ctx.startServer();
  let seeded;
  try {
    const plain = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("plain.png", [74, 127, 181]), prompt: "favorites flow plain",
    });
    const starred = await ctx.api(first.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("starred.png", [181, 68, 74]), prompt: "favorites flow starred",
    });
    const favoriteResponse = await ctx.api(first.origin, "POST", `/api/assets/default/${encodeURIComponent(starred.asset.id)}/favorite`);
    console.log(`[favorites-flow] seed favorite -> favorite=${favoriteResponse?.asset?.favorite} id=${starred.asset.id.slice(0, 10)}`);
    // The create response omits the derived name; the stored filename is the
    // same string the gallery renders, so fall back to it.
    const starredName = starred.asset.name || starred.asset.asset || String(starred.asset.image_path || "").split("/").pop();
    seeded = { plainId: plain.asset.id, starredId: starred.asset.id, starredName };
    console.log(`[favorites-flow] seeded=${JSON.stringify(seeded)}`);
    assertFiltered(await ctx.runInPage(first, favoritesSource(seeded)), "before restart");
  } finally {
    await first.stop();
  }
  const second = await ctx.startServer();
  try {
    assertFiltered(await ctx.runInPage(second, favoritesSource(seeded)), "after restart");
  } finally {
    await second.stop();
  }
  return seeded;
}

function assertFiltered(result, phase) {
  if (result?.favoriteCardCount !== 1 || result?.toggledCount !== 0 || result?.allCardCount !== 2) {
    throw new Error(`Favorites filter ${phase}: ${JSON.stringify(result)}`);
  }
}

function favoritesSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    console.log('FAV-PAGE-CONFIG', JSON.stringify(config));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      const nav = await fetch('/api/navigation?project=default').then(r => r.json()).catch(() => null);
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cardCount()
        + ' | labels=' + JSON.stringify(Array.from(document.querySelectorAll('.asset-card')).map(c => (c.getAttribute('aria-label') || '').slice(0, 40)))
        + ' | nav=' + JSON.stringify(nav?.navigation || {}).slice(0, 200)
        + ' | active=' + (document.querySelector('.main-nav .nav-row[aria-current="page"] > span')?.textContent || 'none'));
    }
    function navButton(label) {
      return Array.from(document.querySelectorAll('.main-nav button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    }
    const cardCount = () => document.querySelectorAll('.asset-card').length;

    await waitFor(() => document.querySelector('.app') && cardCount() === 2, 'two seeded cards');
    const allCardCount = cardCount();

    // Live refresh can re-render the nav between query and click; retry until
    // the Favorites view is actually open.
    await waitFor(() => {
      const button = navButton('收藏');
      if (button && button.getAttribute('aria-current') !== 'page') button.click();
      return button?.getAttribute('aria-current') === 'page' && cardCount() === 1;
    }, 'favorites filter shows the starred card only');
    const favoriteCardCount = cardCount();

    // Inspector toggle: the starred card un-favorites through the real API and
    // immediately leaves the Favorites scope (the row disappears with it).
    document.querySelector('.asset-card').click();
    await waitFor(() => document.querySelector(".asset-title button[aria-label='收藏素材']"), 'favorite button');
    const heart = document.querySelector(".asset-title button[aria-label='收藏素材']");
    if (heart.getAttribute('aria-pressed') === 'true') heart.click();
    await waitFor(() => cardCount() === 0, 'un-favorite drops the card from the Favorites scope');
    const toggledCount = cardCount();

    // Re-favorite from the all view: the state must persist across restarts.
    await waitFor(() => {
      const button = navButton('所有素材');
      if (button && button.getAttribute('aria-current') !== 'page') button.click();
      return button?.getAttribute('aria-current') === 'page' && cardCount() === 2;
    }, 'all view restored');
    const starredCard = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => (card.getAttribute('aria-label') || '').includes(config.starredName)) || null, 'starred card in all view');
    starredCard.click();
    const heartAgain = await waitFor(() => document.querySelector(".asset-title button[aria-label='收藏素材']"), 'favorite button again');
    if (heartAgain.getAttribute('aria-pressed') !== 'true') heartAgain.click();
    await waitFor(() => document.querySelector(".asset-title button[aria-label='收藏素材']")?.getAttribute('aria-pressed') === 'true',
      're-favorite persists in renderer');

    return { allCardCount, favoriteCardCount, toggledCount };
  })()
  `;
}
