// GravityPort React UI flow: ⌘A/Ctrl+A selects the WHOLE filtered result
// across pages (not only the loaded window), can be cancelled mid-flight,
// announces truncation honestly when the 200-page cap cuts an oversized
// result, and the resulting selection drives a real server-side batch action
// on a 340-asset (windowed) gallery.
export const name = "select-all-across-pages";
export const description = "340 assets -> mid-flight Escape cancels select-all -> ⌘A fetches all pages -> a synthetic endless result stops at the 200-page cap and says so -> every mounted card selected -> batch trash moves exactly 340 server-side";

const TOTAL = 340;
const PAGE_SIZE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("selectall-fixture.png", [74, 127, 181]);
    const workers = 6;
    let created = 0;
    while (created < TOTAL) {
      const batch = Math.min(workers, TOTAL - created);
      await Promise.all(Array.from({ length: batch }, () =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: "select all across pages",
        })));
      created += batch;
    }
    const result = await ctx.runInPage(server, selectAllSource(), { windowSize: [1440, 940] });
    if (result?.cancelKeptEmpty !== true || result?.capTruncationAnnounced !== true
      || result?.allSelected !== true || result?.batchTrashMoved !== TOTAL) {
      throw new Error(`select-all-across-pages result: ${JSON.stringify(result)}`);
    }
    // Server-side truth: the batch action hit exactly the full result.
    const trashed = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=1");
    if ((trashed.page?.total ?? -1) !== TOTAL) {
      throw new Error(`server trash total ${trashed.page?.total} != ${TOTAL}`);
    }
    const normal = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=1");
    if ((normal.page?.total ?? -1) !== 0) {
      throw new Error(`server still lists ${normal.page?.total} non-trashed assets`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function selectAllSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 45000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | loaded=' + (document.querySelector('.asset-grid')?.dataset.loadedAssets || '?')
        + ' | mounted=' + mountedCards().length
        + ' | selected=' + document.querySelectorAll('.asset-card.asset-selected').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const mountedCards = () => Array.from(document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)'));
    const selectedCount = () => document.querySelectorAll('.asset-card.asset-selected').length;
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const pressSelectAll = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));

    await waitFor(() => loadedCount() === ${PAGE_SIZE}, 'the first page loads exactly');

    // ── 1) Mid-flight cancel: Escape aborts the page fetches, nothing commits ──
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    const previousFetch = window.__origFetch;
    window.__selectAllRequests = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input.url);
      if (url.includes('limit=250')) {
        window.__selectAllRequests += 1;
        await sleep(1200);
      }
      return previousFetch(input, init);
    };
    pressSelectAll();
    await waitFor(() => window.__selectAllRequests >= 1, 'the select-all fetch is in flight');
    await sleep(150);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.fetch = window.__origFetch;
    await sleep(1800);
    // Cancel means the batch commit never happened: at most the design's
    // implicit single-card ring remains (a background SSE refresh re-lands
    // it), and no "已选 N 项" announcement is ever made.
    await waitFor(() => selectedCount() <= 1 && loadedCount() === ${PAGE_SIZE}
      && !(document.querySelector('.toast')?.textContent || '').includes('已选'), 'cancel kept the batch from committing');
    const cancelKeptEmpty = selectedCount() <= 1;

    // ── 2) Real cross-page select-all over 340 assets ──
    pressSelectAll();
    await waitFor(() => (document.querySelector('.toast')?.textContent || '').trim() === '已选 ${TOTAL} 项',
      'select-all announces the full result');
    const allSelected = selectedCount() > 0
      && selectedCount() === mountedCards().length
      && loadedCount() === ${PAGE_SIZE};
    await sleep(400);

    // ── 2b) The 200-page cap: an oversized result must announce truncation ──
    // Synthetic pages with an endless cursor — the select-all loop only reads
    // ids from the responses, so no real assets are needed. 200 pages × 250
    // is the cap; the commit may claim the first 50000, never a select-all.
    const origFetch = window.__origFetch || window.fetch.bind(window);
    let synthPage = 0;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : String(input.url || '');
      if (!url.includes('limit=250')) return origFetch(input, init);
      synthPage += 1;
      const assets = Array.from({ length: 250 }, (_, i) => ({
        id: 'synthetic-' + synthPage + '-' + i, width: 32, height: 24,
      }));
      return new Response(JSON.stringify({
        assets, page: { nextCursor: 'synthetic-cursor-' + synthPage, total: 999999 }, revision: 'synthetic',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    pressSelectAll();
    await waitFor(() => (document.querySelector('.toast')?.textContent || '').trim() === '结果过大，已选前 50000 项',
      'the page cap announces a truncated selection instead of a completed select-all');
    window.fetch = window.__origFetch;
    const capTruncationAnnounced = true;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => selectedCount() <= 1, 'the synthetic selection clears');
    pressSelectAll();
    await waitFor(() => (document.querySelector('.toast')?.textContent || '').trim() === '已选 ${TOTAL} 项',
      'the real select-all re-runs after the cap');
    await sleep(400);

    // ── 3) The cross-page selection drives a real batch trash ──
    mountedCards()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'context menu on the selection');
    const item = Array.from(document.querySelectorAll('.context-menu button'))
      .find((entry) => entry.textContent.trim() === '移至回收站');
    if (!item) throw new Error('missing batch trash menu item');
    item.click();
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'batch delete confirm');
    const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent.trim() === '移至回收站');
    confirm.click();
    await waitFor(() => navSmall('回收站') === String(${TOTAL}), 'batch trash count reaches the server');

    return { cancelKeptEmpty, capTruncationAnnounced, allSelected, batchTrashMoved: Number(navSmall('回收站')),
      selectedAnnounced: (document.querySelector('.toast')?.textContent || '').trim() };
  })()
  `;
}
