// GravityPort React UI flow (task 292): imports stream into the gallery live.
// Empty library: the first batch's cards are on screen before the second
// batch's import request even fires, and every card carries its real aspect
// ratio from first paint (no 1:1 placeholder that jumps later). Stock
// library, scrolled to the bottom: the import must not move the scroll
// position, must not fire a single gallery page request while running, and
// the toast offers 查看 to jump to the streamed cards; after the import the
// suppressed refreshes resume and the new cards end up on derivatives.
export const name = "import-live-cards";
export const description = "empty library: first batch live before batch 2 + true ratios; stocked library: scroll held, zero page pulls during import, 查看 jumps to the new cards, derivatives land";

const IMPORT_TOTAL = 200;
const STOCK_TOTAL = 300;
const BATCH_SIZE = 40;
// Mixed ratios including one square: the square is allowed to be "1 / 1",
// everything else must never be.
const RATIOS = [[96, 64], [64, 96], [100, 100], [120, 75], [80, 120]];

export async function run(ctx) {
  await ctx.prepare();
  const empty = await runEmptyLibraryScenario(ctx);
  const stocked = await runStockedLibraryScenario(ctx);
  assertEmptyScenario(empty);
  assertStockedScenario(stocked);
  return {
    emptyLibrary: empty,
    stockedLibrary: stocked,
  };
}

function assertEmptyScenario(result) {
  if (result.importBatches < 5) throw new Error(`expected at least 5 import batches, got ${result.importBatches}`);
  if (!(result.cardsWhenBatch2Issued >= 1)) {
    throw new Error(`no cards from batch 1 were visible before batch 2 was issued: ${JSON.stringify(result)}`);
  }
  if (result.firstSeen.length < 10) throw new Error(`ratio sampling saw too few cards: ${result.firstSeen.length}`);
  const changed = result.firstSeen.filter(({ id, ratio }) => {
    const after = result.afterDerivatives[id];
    return after !== undefined && after !== ratio;
  });
  if (changed.length) throw new Error(`aspect ratio changed after derivatives: ${JSON.stringify(changed)}`);
  const fakeSquare = result.notSquareIds.filter(id => result.firstSeen.find(card => card.id === id)?.ratio === "1 / 1");
  if (fakeSquare.length) throw new Error(`non-square cards rendered as 1 / 1 at first sight: ${JSON.stringify(fakeSquare)}`);
  if (!result.derivativesDone) throw new Error("mounted imported cards never switched to derivative URLs");
}

function assertStockedScenario(result) {
  const drift = result.scrollSamples.filter(top => Math.abs(top - result.scrollTopStart) > 2);
  if (drift.length) throw new Error(`scroll position moved during import: start ${result.scrollTopStart}, drift ${JSON.stringify(drift)}`);
  if (result.galleryGetsDuringImport !== 0) {
    throw new Error(`gallery page requests during import: ${result.galleryGetsDuringImport}`);
  }
  if (!result.sawToastAction) throw new Error("the import toast never offered the 查看 action");
  if (result.scrollTopAfterJump > 40) throw new Error(`查看 did not return to the top: ${result.scrollTopAfterJump}`);
  if (!String(result.firstCardIdAfterJump || "").startsWith("live-")) {
    throw new Error(`the top card after 查看 is not an imported one: ${result.firstCardIdAfterJump}`);
  }
  if (result.galleryGetsAfterImport < 1) throw new Error("no gallery refresh committed after the import ended");
  if (!result.derivativesDone) throw new Error("mounted imported cards never switched to derivative URLs");
}

async function runEmptyLibraryScenario(ctx) {
  const server = await ctx.startServer();
  try {
    return await ctx.runInPage(server, emptyLibrarySource(), { windowSize: [1280, 800] });
  } finally {
    await server.stop();
  }
}

async function runStockedLibraryScenario(ctx) {
  const server = await ctx.startServer();
  try {
    // Seed the stock through /api/assets/create (always creates, unlike the
    // import route) and let its derivatives finish before the UI round, so
    // the measured import window is free of background churn.
    const fixturePath = await ctx.makePng("live-stock-fixture.png", [74, 127, 181]);
    const workers = 6;
    for (let round = 0; round < STOCK_TOTAL / workers; round += 1) {
      await Promise.all(Array.from({ length: workers }, (_, index) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: `live stock ${round * workers + index}`,
        })));
    }
    await waitForStockDerivatives(server.origin);
    return await ctx.runInPage(server, stockedLibrarySource(), { windowSize: [1280, 800] });
  } finally {
    await server.stop();
  }
}

async function waitForStockDerivatives(origin) {
  // Every stock row must have its thumbnail before the UI round: a single
  // straggler derivative completing mid-import fires SSE that turns into a
  // gallery refresh (the thing the zero-page-pulls assertion counts on being
  // absent). Newest+oldest pages together cover all STOCK_TOTAL rows.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const [newest, oldest, totals] = await Promise.all([
      ctxApi(origin, "/api/assets?project=default&sort=newest&limit=250"),
      ctxApi(origin, "/api/assets?project=default&sort=oldest&limit=250"),
      ctxApi(origin, "/api/navigation?project=default"),
    ]);
    const byId = new Map();
    for (const asset of [...(newest?.assets || []), ...(oldest?.assets || [])]) byId.set(asset.id, asset);
    const pending = [...byId.values()].filter(asset => !asset.thumbnail_ready).length;
    if (byId.size >= STOCK_TOTAL && pending === 0 && Number(totals?.navigation?.total) >= STOCK_TOTAL) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("stock derivatives never settled");
}

async function ctxApi(origin, path) {
  const response = await fetch(`${origin}${path}`, { headers: { "x-mosa-client-token": "mosa_e2e_client_token_0123456789abcdefghijklmnop" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ─── In-page sources ──────────────────────────────────────────────────────────

function sharedHelpers(ratios, total, prefix) {
  return `
    const RATIOS = ${JSON.stringify(ratios)};
    const IMPORT_TOTAL = ${total};
    const PREFIX = ${JSON.stringify(prefix)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const value = check();
          if (value) return value;
        } catch (error) { lastError = error; }
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : ''));
    }
    const mountedCards = () => Array.from(document.querySelectorAll('.asset-grid .asset-card[data-asset-id]'));
    function ratioStyleOf(card) {
      // The card button itself carries aspectRatio (both windowed and plain).
      return card.style.aspectRatio || '';
    }
    async function makeFile(index) {
      const [width, height] = RATIOS[index % RATIOS.length];
      const name = PREFIX + '-' + String(index).padStart(3, '0') + '.png';
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#333333';
      context.fillRect(0, 0, width, height);
      // Name-seeded block noise (task 291): pure blocks would all hash alike
      // and trip the import review; each file gets its own fixed pattern.
      let seed = 2166136261;
      for (const ch of name) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
      for (let y = 0; y < height; y += 3) {
        for (let x = 0; x < width; x += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const level = seed >>> 24;
          context.fillStyle = 'rgba(' + level + ',' + level + ',' + level + ',0.7)';
          context.fillRect(x, y, 4, 3);
        }
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      return new File([blob], name, { type: 'image/png' });
    }
    async function makeImportFiles() {
      const files = [];
      for (let index = 0; index < IMPORT_TOTAL; index += 1) files.push(await makeFile(index));
      return files;
    }
    function dropOn(target, files) {
      const dataTransfer = new DataTransfer();
      for (const file of files) dataTransfer.items.add(file);
      const rect = target.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      let event = new DragEvent('drop', init);
      if (!event.dataTransfer) {
        event = new Event('drop', init);
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      }
      target.dispatchEvent(event);
    }
    function installFetchStats(stats) {
      const originalFetch = window.fetch;
      const totalBatches = Math.ceil(IMPORT_TOTAL / 40);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const method = String((init && init.method) || 'GET').toUpperCase();
        let pathname = url;
        try { pathname = new URL(url, location.origin).pathname; } catch {}
        if (method === 'GET' && pathname === '/api/assets') stats.galleryGets += 1;
        if (method === 'POST' && pathname === '/api/assets/import-batch') {
          stats.importBatches += 1;
          if (stats.importBatches === 2) stats.cardsWhenBatch2Issued = mountedCards().length;
          // Snapshot at the moment the LAST batch is issued: everything after
          // it belongs to the import's own end-of-import refresh, which the
          // zero-pull assertion must not count (the gate holds during the
          // import proper; the closing refresh is by design).
          if (stats.importBatches === totalBatches) stats.getsWhenLastBatchIssued = stats.galleryGets;
        }
        return originalFetch(input, init);
      };
    }
    // aspectRatio style captured at first sight; square-ness is judged later
    // from the img's natural size, never from the placeholder itself.
    function sampleFirstSight(seen) {
      for (const card of mountedCards()) {
        const id = card.getAttribute('data-asset-id') || '';
        if (!id.startsWith(PREFIX) || seen.has(id)) continue;
        seen.set(id, ratioStyleOf(card));
      }
    }
    async function waitImportBatches(stats, batches) {
      await waitFor(() => stats.importBatches >= batches, batches + ' import batches', 120000);
      await sleep(1200);
    }
    async function waitDerivativeUrls(stats) {
      const deadline = Date.now() + 240000;
      while (Date.now() < deadline) {
        const cards = mountedCards().filter((card) => (card.getAttribute('data-asset-id') || '').startsWith(PREFIX));
        const images = cards.map((card) => card.querySelector('img')).filter(Boolean);
        if (cards.length && images.length && images.every((img) => !String(img.currentSrc || img.src || '').includes('/images/'))) {
          return true;
        }
        await sleep(500);
      }
      return false;
    }
  `;
}

function emptyLibrarySource() {
  return `(async () => {
    ${sharedHelpers(RATIOS, IMPORT_TOTAL, "mix")}
    const stats = { galleryGets: 0, importBatches: 0, cardsWhenBatch2Issued: -1 };
    await waitFor(() => document.querySelector('.workspace') && document.querySelector('.empty-state'), 'empty library ready');
    installFetchStats(stats);
    const files = await makeImportFiles();
    dropOn(document.querySelector('.workspace'), files);
    // Ratio at first sight, sampled while later batches are still landing.
    const firstSeen = new Map();
    while (stats.importBatches < 5) {
      sampleFirstSight(firstSeen);
      await sleep(100);
    }
    sampleFirstSight(firstSeen);
    await waitImportBatches(stats, 5);
    const derivativesDone = await waitDerivativeUrls(stats);
    // Second sample for the same ids once derivatives landed.
    const afterDerivatives = {};
    for (const card of mountedCards()) {
      const id = card.getAttribute('data-asset-id') || '';
      if (firstSeen.has(id)) afterDerivatives[id] = ratioStyleOf(card);
    }
    // natural size decides which cards were never allowed to be 1 / 1.
    const notSquareIds = mountedCards()
      .filter((card) => firstSeen.has(card.getAttribute('data-asset-id') || ''))
      .map((card) => card.querySelector('img'))
      .filter((img) => img && img.naturalWidth > 0 && Math.abs(img.naturalWidth - img.naturalHeight) > 1)
      .map((img) => img.closest('[data-asset-id]').getAttribute('data-asset-id'));
    return {
      importBatches: stats.importBatches,
      cardsWhenBatch2Issued: stats.cardsWhenBatch2Issued,
      firstSeen: Array.from(firstSeen, ([id, ratio]) => ({ id, ratio })),
      afterDerivatives,
      notSquareIds,
      derivativesDone,
    };
  })()`;
}

function stockedLibrarySource() {
  return `(async () => {
    ${sharedHelpers(RATIOS, IMPORT_TOTAL, "live")}
    // Task 314: the app renders only after its capability exchange settles,
    // so the grid may not exist when this source starts. Re-query inside the
    // wait instead of capturing the element once.
    await waitFor(() => document.querySelector('.asset-grid') && mountedCards().length >= 100, 'first page ready', 30000);
    const grid = document.querySelector('.asset-grid');
    // Scroll to the very bottom: pagination appends until the stock runs out.
    for (let guard = 0; guard < 10 && mountedCards().length < ${STOCK_TOTAL}; guard += 1) {
      const before = mountedCards().length;
      grid.scrollTop = grid.scrollHeight;
      await waitFor(() => mountedCards().length > before, 'next page after scroll', 15000);
      await sleep(300);
    }
    const scrollTopStart = grid.scrollTop;
    if (mountedCards().length < ${STOCK_TOTAL}) throw new Error('stock library never fully loaded: ' + mountedCards().length);

    const stats = { galleryGets: 0, importBatches: 0, cardsWhenBatch2Issued: -1 };
    installFetchStats(stats);
    const files = await makeImportFiles();
    dropOn(document.querySelector('.workspace'), files);

    // Sample the scroll position while batches land, until the 查看 button
    // shows up — the user does not touch the gallery in this window.
    const scrollSamples = [];
    const action = await waitFor(() => {
      scrollSamples.push(grid.scrollTop);
      return document.querySelector('.toast-action');
    }, 'import toast with 查看 action', 60000);

    // 点击查看：held cards prepend, and the write of scrollTop happens inside
    // the handler before the prepend's re-render reads it.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const button = document.querySelector('.toast-action');
        if (!button) break;
        button.click();
        await sleep(120);
        if (grid.scrollTop <= 40) break;
      } catch {}
      await sleep(200);
    }
    await waitFor(() => grid.scrollTop <= 40, 'scroll back at the top', 10000);
    const scrollTopAfterJump = grid.scrollTop;
    const firstCardIdAfterJump = mountedCards()[0]?.getAttribute('data-asset-id') || '';

    // The zero-pull window runs to the END of the import (clicking 查看 only
    // mutates client state — no gallery request): the gate must stay silent
    // for the whole import, not just until the first toast action. The
    // snapshot point is the last batch's issuance, so the import's own
    // closing refresh stays out of the count.
    await waitImportBatches(stats, 5);
    const galleryGetsDuringImport = stats.getsWhenLastBatchIssued;
    const galleryGetsAfterImport = await waitFor(() => {
      if (stats.galleryGets > galleryGetsDuringImport) return stats.galleryGets - galleryGetsDuringImport;
      return 0;
    }, 'a committed gallery refresh after the import', 60000);
    const derivativesDone = await waitDerivativeUrls(stats);
    return {
      scrollTopStart,
      scrollSamples,
      galleryGetsDuringImport,
      sawToastAction: Boolean(action),
      scrollTopAfterJump,
      firstCardIdAfterJump,
      galleryGetsAfterImport,
      derivativesDone,
      importBatches: stats.importBatches,
      loadedTotal: mountedCards().length,
    };
  })()`;
}
