// GravityPort React UI flow: pagination across a project switch. A delayed
// second page for the OLD project must never merge into the NEW project's
// gallery or move its cursor — the in-flight request is aborted on the view
// change and a late response is discarded. The stale merge is short-lived
// (the next same-view refresh wipes it), so the flow watches
// data-loaded-assets continuously instead of sampling once.
export const name = "pagination-race";
export const description = "110 default assets + 1 alpha -> page-2 fetch delayed -> project switch while pending -> alpha never shows more than its own 1 asset -> default paginates cleanly again";

const TOTAL = 110;
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("race-fixture.png", [74, 127, 181]);
    const workers = 6;
    let created = 0;
    while (created < TOTAL) {
      const batch = Math.min(workers, TOTAL - created);
      await Promise.all(Array.from({ length: batch }, () =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: "pagination race",
        })));
      created += batch;
    }
    const inAlpha = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "alpha", imagePath: await ctx.makePng("race-alpha.png", [186, 94, 60]), prompt: "pagination race alpha",
    });
    const result = await ctx.runInPage(server, raceSource({ alphaId: inAlpha.asset.id }), { windowSize: [1440, 940] });
    if (result?.raceRejected !== true || result?.settledClean !== true) {
      throw new Error(`pagination-race result: ${JSON.stringify({ ...result, alphaId: inAlpha.asset.id })}`);
    }
    return { ...result, alphaId: inAlpha.asset.id };
  } finally {
    await server.stop();
  }
}

function raceSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | loaded=' + (document.querySelector('.asset-grid')?.dataset.loadedAssets || '?')
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const domIds = () => Array.from(document.querySelectorAll('[data-asset-id]')).map((node) => node.getAttribute('data-asset-id'));
    const projectLabel = () => document.querySelector('.sidebar-project .toolbar-select span')?.textContent?.trim() || '?';
    async function chooseProject(name) {
      const trigger = await waitFor(() => document.querySelector('.sidebar-project .toolbar-select') || null, 'project switcher');
      trigger.click();
      const option = await waitFor(() => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === name) || null, 'project option ' + name);
      option.click();
      await waitFor(() => !document.querySelector('.toolbar-select-menu'), 'project menu closes');
    }

    await waitFor(() => loadedCount() === ${PAGE_SIZE}, 'the first page loads exactly');

    // Continuous watcher: every data-loaded-assets change is recorded with the
    // active project, so a short-lived stale merge cannot escape the assert.
    const loadedTrace = [];
    const trace = new MutationObserver(() => {
      loadedTrace.push({ at: Math.round(performance.now()), loaded: loadedCount(), project: projectLabel() });
    });

    // Fault injection: every cursor (second-page) request is held for 1.5s.
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    const previousFetch = window.__origFetch;
    window.__cursorRequests = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input.url);
      if (url.includes('cursor=')) {
        window.__cursorRequests += 1;
        await sleep(1500);
      }
      return previousFetch(input, init);
    };

    // Drive the grid to the bottom: the scroll handler pulls page 2.
    const grid = document.querySelector('.asset-grid');
    trace.observe(grid, { attributes: true, attributeFilter: ['data-loaded-assets'] });
    grid.scrollTop = grid.scrollHeight;
    grid.dispatchEvent(new Event('scroll'));
    await waitFor(() => window.__cursorRequests >= 1, 'the delayed page-2 request is in flight');

    // Switch projects while the old project's page 2 is still pending.
    await chooseProject('alpha');
    await waitFor(() => loadedCount() === 1, 'alpha loads exactly one asset');
    // Give the delayed response ample time to (wrongly) land and merge.
    window.fetch = window.__origFetch;
    await sleep(2500);
    trace.disconnect();

    // The stale page must never have been visible on alpha: no trace entry
    // shows more than the one alpha asset, the settled state still lists
    // exactly that asset, and no error toast surfaced from the abort.
    const staleExposure = loadedTrace.filter((entry) => entry.project === 'alpha' && entry.loaded > 1);
    const ids = domIds();
    const raceRejected = staleExposure.length === 0
      && loadedCount() === 1
      && ids.length === 1
      && ids[0] === config.alphaId
      && !document.querySelector('.toast');

    // ── Pagination must work cleanly again after the aborted race ──
    await chooseProject('default');
    await waitFor(() => loadedCount() === ${PAGE_SIZE}, 'default project back to its first page');
    const grid2 = document.querySelector('.asset-grid');
    for (let step = 0; step < 40 && loadedCount() < ${TOTAL}; step += 1) {
      grid2.scrollTop = grid2.scrollHeight;
      grid2.dispatchEvent(new Event('scroll'));
      await sleep(150);
    }
    await waitFor(() => loadedCount() === ${TOTAL}, 'pagination completes to 110 after the race');
    const settledClean = loadedCount() === ${TOTAL} && !document.querySelector('.toast');

    return { cursorRequests: window.__cursorRequests, raceRejected, settledClean,
      staleExposure: staleExposure.slice(0, 4) };
  })()
  `;
}
