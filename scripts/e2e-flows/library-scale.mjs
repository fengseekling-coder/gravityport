// GravityPort React UI flow: a several-hundred-asset library stays interactive
// — the first page renders quickly, pagination pulls exactly one page at a
// time, and the sidebar totals track the server.
export const name = "library-scale";
export const description = "seed 300 assets -> first page (100) interactive within budget -> scrolling pulls 200 then 300 -> totals match /api/navigation";

const SEED_TOTAL = 300;
const PAGE_SIZE = 100;
const RENDER_BUDGET_MS = 30000;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("scale-fixture.png", [74, 127, 181]);
    const workers = 6;
    let created = 0;
    for (let round = 0; round < SEED_TOTAL / workers; round += 1) {
      await Promise.all(Array.from({ length: workers }, (_, index) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: `library scale ${round * workers + index}`,
        })));
      created += workers;
    }
    const result = await ctx.runInPage(server, scaleSource(), { windowSize: [1440, 940] });
    if (result?.initialCards !== PAGE_SIZE || result?.afterFirstScroll !== PAGE_SIZE * 2
      || result?.afterSecondScroll < SEED_TOTAL || result?.renderMs > RENDER_BUDGET_MS
      || result?.navTotal < SEED_TOTAL) {
      throw new Error(`library-scale result: ${JSON.stringify({ created, ...result })}`);
    }
    return { created, ...result };
  } finally {
    await server.stop();
  }
}

function scaleSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const started = performance.now();
    async function waitFor(check, label, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(100);
      }
      const grid = document.querySelector('.asset-grid');
      const scroll = grid ? { top: Math.round(grid.scrollTop), sh: grid.scrollHeight, ch: grid.clientHeight } : null;
      const loading = Boolean(document.querySelector(".empty-state[role='status']"));
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | scroll=' + JSON.stringify(scroll)
        + ' | observerFired=' + (window.__observerFired || 0)
        + ' | loading=' + String(loading)
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | serverTotal=' + await fetch('/api/assets?project=default&limit=1')
          .then((r) => r.json()).then((d) => (d.page && d.page.total) ?? '?').catch((e) => String(e)));

    }
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    async function scrollToMore() {
      const scroller = document.querySelector('.asset-grid');
      const seen = cardCount();
      for (let step = 0; step < 40; step++) {
        scroller.scrollBy(0, 900);
        await sleep(120);
        if (cardCount() > seen) break;
      }
    }
    window.__observerFired = 0;
    // Instrument the sentinel with our own observer to separate geometry from
    // app behavior.
    const observeSentinel = () => {
      const sentinel = Array.from(document.querySelector('.asset-grid').children)
        .find((el) => !el.classList.contains('asset-card'));
      if (sentinel && !window.__sentinelSeen) {
        window.__sentinelSeen = sentinel;
        const observer = new IntersectionObserver(() => { window.__observerFired += 1; }, { rootMargin: '600px 0px' });
        observer.observe(sentinel);
      }
    };
    const sentinelInterval = setInterval(observeSentinel, 500);

    await waitFor(() => cardCount() === ${PAGE_SIZE}, 'the first page renders exactly');
    const renderMs = Math.round(performance.now() - started);
    const initialCards = cardCount();
    const navTotal = await fetch('/api/navigation?project=default').then((r) => r.json()).then((d) => d.navigation.total);

    await scrollToMore();
    await waitFor(() => cardCount() === ${PAGE_SIZE * 2}, 'the second page appends exactly');
    const afterFirstScroll = cardCount();

    await scrollToMore();
    await waitFor(() => cardCount() >= ${SEED_TOTAL}, 'the library fully loads');
    const afterSecondScroll = cardCount();
    clearInterval(sentinelInterval);

    return { initialCards, renderMs, navTotal, afterFirstScroll, afterSecondScroll, observerFired: window.__observerFired || 0 };
  })()
  `;
}
