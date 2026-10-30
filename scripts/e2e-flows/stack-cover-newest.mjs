// GravityPort React UI flow (task 305): an unlocked automatic stack keeps its
// newest member as the cover, updates the card in place (and lifts it to the
// front of the gallery) via live SSE when a new same-session image arrives
// without reloading the page, and shows the matching member on filtered views
// such as Favorites.
export const name = "stack-cover-newest";
export const description = "automatic stack (3 same-session images) shows newest as cover -> live API ingest of 4th same-session image updates cover and lifts stack to front without reload -> favoriting an earlier member shows that member as the card in Favorites";

const SESSION_ID = "e2e-stack-cover-305";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer({
    env: {
      MOSA_FEEDBACK_URL: "http://127.0.0.1:9",
      MOSA_FEEDBACK_TIMEOUT_MS: "3000",
    },
  });
  try {
    const create = async (fileName, prompt, source, color, createdAt) => {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(fileName, color),
        prompt,
        created_at: createdAt,
        source,
      });
      return created.asset.id;
    };

    const autoIds = [
      await create("stack-cover-0.png", "stack cover 0", {
        type: "codex-generated",
        generation_session_id: SESSION_ID,
      }, [40, 100, 190], "2026-10-30T10:00:00.000Z"),
      await create("stack-cover-1.png", "stack cover 1", {
        type: "codex-generated",
        generation_session_id: SESSION_ID,
      }, [80, 130, 190], "2026-10-30T10:01:00.000Z"),
      await create("stack-cover-2.png", "stack cover 2", {
        type: "codex-generated",
        generation_session_id: SESSION_ID,
      }, [120, 160, 190], "2026-10-30T10:02:00.000Z"),
    ];
    // One newer loose asset so the 3-image stack initially sits behind it,
    // proving the 4th same-session ingest lifts the stack card to index 0.
    const looseId = await create(
      "stack-cover-loose.png",
      "stack cover loose",
      { type: "local-file" },
      [200, 110, 60],
      "2026-10-30T10:03:00.000Z",
    );
    const fourthImagePath = await ctx.makePng("stack-cover-3.png", [220, 60, 120]);

    const result = await ctx.runInPage(
      server,
      pageFlowSource({
        token: ctx.token,
        sessionId: SESSION_ID,
        initialNewestId: autoIds[2],
        earlierFavoritedId: autoIds[0],
        looseId,
        fourthImagePath,
      }),
      { windowSize: [1440, 940] },
    );

    const checks = {
      initialCoverIsNewest: result?.initialStackCardId === autoIds[2],
      initialOrderBehindNewerLoose: result?.initialFirstCardId === looseId,
      liveCoverSwitchedToFourth: Boolean(result?.fourthId) && result?.afterFourthStackCardId === result?.fourthId,
      liveCardMovedToFront: Boolean(result?.fourthId) && result?.afterFourthFirstCardId === result?.fourthId,
      noPageReloadOccurred: result?.noReloadMarkerIntact === true,
      favoritesCardShowsMatchedEarlierMember: result?.favoritesCardId === autoIds[0] && result?.favoritesCardIsStack === true,
    };
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error(`stack-cover-newest page result: ${JSON.stringify({ result, checks, autoIds, looseId })}`);
    }
    return { ...result, checks };
  } finally {
    await server.stop();
  }
}

function pageFlowSource(params) {
  return `(async () => {
    const config = ${JSON.stringify(params)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const isStack = (card) => Boolean(card?.querySelector('.stack-mark'));
    const mainNavButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes(label)) || null;

    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      const cardIds = cards().map((card) => card.getAttribute('data-asset-id') + (isStack(card) ? '[stack]' : ''));
      throw new Error('Timed out waiting for ' + label + ' | cards=' + JSON.stringify(cardIds));
    }

    async function apiJson(method, path, body) {
      const response = await fetch(path, {
        method,
        headers: {
          'x-mosa-client-token': config.token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(method + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 240));
      return text ? JSON.parse(text) : null;
    }

    window.__stackCoverNoReloadMarker = 'intact-305';

    // 1. All assets: stack card shows the newest of the 3 initial captures.
    await waitFor(
      () => mainNavButton('所有素材')?.getAttribute('aria-current') === 'page'
        && cards().length === 2
        && cards().filter(isStack).length === 1,
      'initial gallery shows loose card and 3-member auto stack',
    );
    // Let the EventSource stream settle after initial gallery load.
    await sleep(350);

    const initialFirstCardId = cards()[0]?.getAttribute('data-asset-id') || '';
    const initialStackCard = cards().find(isStack);
    const initialStackCardId = initialStackCard?.getAttribute('data-asset-id') || '';

    // 2. Ingest a 4th capture in the same session via API without reloading the page.
    const createdFourth = await apiJson('POST', '/api/assets/create', {
      projectId: 'default',
      imagePath: config.fourthImagePath,
      prompt: 'stack cover 3 live newest',
      created_at: '2026-10-30T10:04:00.000Z',
      source: {
        type: 'codex-generated',
        generation_session_id: config.sessionId,
      },
    });
    const fourthId = createdFourth?.asset?.id || '';

    await waitFor(
      () => cards().length === 2
        && isStack(cards()[0])
        && cards()[0]?.getAttribute('data-asset-id') === fourthId,
      'live SSE updates stack cover to 4th image and lifts card to front',
    );
    const afterFourthFirstCardId = cards()[0]?.getAttribute('data-asset-id') || '';
    const afterFourthStackCardId = cards().find(isStack)?.getAttribute('data-asset-id') || '';

    // 3. Favorite an earlier member of the stack and enter Favorites view.
    await apiJson('POST', '/api/assets/batch', {
      action: 'favorite',
      projectId: 'default',
      assetIds: [config.earlierFavoritedId],
      favorite: true,
    });

    mainNavButton('收藏').click();
    await waitFor(
      () => mainNavButton('收藏')?.getAttribute('aria-current') === 'page'
        && cards().length === 1
        && cards()[0]?.getAttribute('data-asset-id') === config.earlierFavoritedId,
      'Favorites view shows the favorited earlier member as the stack card',
    );
    const favoritesCard = cards()[0];
    const favoritesCardId = favoritesCard?.getAttribute('data-asset-id') || '';
    const favoritesCardIsStack = isStack(favoritesCard);
    const noReloadMarkerIntact = window.__stackCoverNoReloadMarker === 'intact-305';

    return {
      initialFirstCardId,
      initialStackCardId,
      fourthId,
      afterFourthFirstCardId,
      afterFourthStackCardId,
      favoritesCardId,
      favoritesCardIsStack,
      noReloadMarkerIntact,
    };
  })()`;
}
