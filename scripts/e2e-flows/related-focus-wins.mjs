// GravityPort React UI flow: an explicit focus switch invalidates an
// in-flight history fetch. A slow 版本 response that lands after the user
// has switched to a related recommendation must never retake the focus —
// the inspector stays on the asset the user clicked last.
export const name = "related-focus-wins";
export const description = "parent+2 versions + related asset -> slow 版本 3 fetch in flight -> click 相关推荐 D -> late 版本 3 response lands -> focus stays D";
export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("related-wins-parent.png", [74, 127, 181]),
      prompt: "related wins parent prompt",
    });
    const parent = parentCreate.asset;
    const child2 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.id)}/versions`, { version_change: "e2e related second version" });
    const child3 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(child2.asset.id)}/versions`, { version_change: "e2e related third version" });
    const related = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("related-d.png", [181, 127, 74]),
      prompt: "related wins standalone d",
    });
    const result = await ctx.runInPage(server, flowSource({
      parentId: parent.id,
      child3Id: child3.asset?.id || "",
      relatedId: related.asset?.id || "",
    }), { windowSize: [1440, 940] });
    if (result?.relatedRowFirst !== true || result?.focusStaysRelated !== true) {
      throw new Error(`related-focus-wins result: ${JSON.stringify({ parent: parent.id, ...result })}`);
    }
    return { parentId: parent.id, child3Id: child3.asset?.id, relatedId: related.asset?.id, ...result };
  } finally {
    await server.stop();
  }
}

function flowSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | selected=' + (document.querySelector('.asset-card.asset-selected')?.dataset.assetId || 'none')
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cardById = (id) => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === id) || null;
    const selectedId = () => document.querySelector('.asset-card.asset-selected')?.dataset.assetId || '';
    const versionRows = () => Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'));
    // Related rows are the .related buttons OUTSIDE the version/generation
    // lists; the newest seeded asset leads the list while the parent is
    // focused.
    const relatedRows = () => Array.from(document.querySelectorAll('button.related'))
      .filter((row) => !row.closest('.version-list'));
    const escapeRegex = (text) => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const delayDetail = (id, ms) => {
      if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
      const previousFetch = window.fetch.bind(window);
      const marker = 'delay-' + id;
      window[marker] = 0;
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : String(input.url || '');
        if (new RegExp('/api/assets/default/' + escapeRegex(id) + '(\\\\?|$)').test(url)) {
          window[marker] += 1;
          await sleep(ms);
        }
        return previousFetch(input, init);
      };
      return () => { window.fetch = previousFetch; };
    };

    await waitFor(() => document.querySelector('.app') && cardById(config.parentId)
      && cardById(config.relatedId) && cardById(config.child3Id), 'all seeded cards rendered');

    (await waitFor(() => cardById(config.parentId), 'parent card')).click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens');
    await waitFor(() => versionRows().length >= 3, '版本 section lists the whole chain');
    const firstRelated = await waitFor(() => relatedRows()[0] || null, '相关推荐 rows');
    const relatedRowFirst = (firstRelated.textContent || '').includes('related-d');
    if (!relatedRowFirst) {
      throw new Error('related row 0 is not the seeded related-d asset: ' + (firstRelated.textContent || '').slice(0, 60));
    }

    // Start the slow 版本 3 fetch, then switch focus through 相关推荐 before
    // it lands: the explicit switch must invalidate the request so the late
    // response cannot retake the focus.
    const restore = delayDetail(config.child3Id, 1200);
    versionRows().find((row) => new RegExp('^版本 3(?!\\\\d)').test(row.querySelector('span')?.textContent || '')).click();
    await waitFor(() => window['delay-' + config.child3Id] >= 1, 'the slow 版本 3 fetch is in flight');
    firstRelated.click();
    await waitFor(() => selectedId() === config.relatedId, 'focus moved to the related asset');

    restore();
    // Outlive the 1200ms delay plus the real fetch: any un-invalidated
    // response would have committed by now.
    await sleep(1800);
    const focusStaysRelated = selectedId() === config.relatedId
      && document.querySelectorAll('.asset-card.asset-selected').length === 1;

    return { relatedRowFirst, focusStaysRelated, focusedId: selectedId() };
  })()
  `;
}
