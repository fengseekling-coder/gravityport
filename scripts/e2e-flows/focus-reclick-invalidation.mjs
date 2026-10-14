// GravityPort React UI flow: re-clicking the currently focused asset still
// invalidates an in-flight history fetch. The latest click is the latest
// intent — "stay here" — so a late version response must neither retake the
// focus nor collapse the multi-selection behind an open context menu.
export const name = "focus-reclick-invalidation";
export const description = "focus 版本 1 -> slow 版本 3 fetch -> re-click 版本 1 -> stays 版本 1 || multi-select A+B focused on A -> slow 版本 2 fetch -> right-click A -> batch favorite still hits exactly A+B on the server";
export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("reclick-parent.png", [74, 127, 181]),
      prompt: "reclick parent prompt",
    });
    const parent = parentCreate.asset;
    const child2 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.id)}/versions`, { version_change: "e2e reclick second version" });
    const child3 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(child2.asset.id)}/versions`, { version_change: "e2e reclick third version" });
    const standalone = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("reclick-a.png", [181, 127, 74]),
      prompt: "reclick standalone a",
    });
    const result = await ctx.runInPage(server, flowSource({
      parentId: parent.id,
      child2Id: child2.asset?.id || "",
      child3Id: child3.asset?.id || "",
      standaloneId: standalone.asset?.id || "",
    }), { windowSize: [1440, 940] });
    if (result?.reclickStays !== true || result?.batchTargetHonest !== true) {
      throw new Error(`focus-reclick-invalidation result: ${JSON.stringify({ parent: parent.id, ...result })}`);
    }
    // Server truth: the batch favorite hit exactly the multi-selection
    // (standalone + parent); the delayed version child stays unfavorited.
    // (Trash cannot serve here: the server requires versions to be trashed
    // leaves-first, so a parent with live children is rightly refused.)
    const all = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=200");
    const favoriteById = new Map((all.assets || []).map(item => [item.id, Boolean(item.favorite)]));
    const serverTarget = favoriteById.get(result.standaloneId) === true
      && favoriteById.get(result.parentId) === true
      && favoriteById.get(result.child2Id) === false
      && favoriteById.get(result.child3Id) === false;
    if (!serverTarget) {
      throw new Error(`focus-reclick-invalidation server truth: favorites=${JSON.stringify([...favoriteById])}`);
    }
    return { ...result, serverTarget };
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
        + ' | selected=' + JSON.stringify(selectedIds())
        + ' | rows=' + (versionRows().map((row) => '[' + (row.querySelector('span')?.textContent || '').slice(0, 20) + ']').join(' ') || 'none')
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cardById = (id) => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === id) || null;
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected'))
      .map((card) => card.dataset.assetId);
    const versionRows = () => Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'));
    const rowOf = (label) => versionRows()
      .find((row) => new RegExp('^' + label + '(?!\\d)').test(row.querySelector('span')?.textContent || '')) || null;
    const checkedRowLabel = () => {
      const row = versionRows().find((entry) => entry.firstElementChild?.tagName === 'svg');
      return (row?.querySelector('span')?.textContent || '').trim();
    };
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
    const ctrlClick = (card) => card.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, ctrlKey: true,
    }));
    const contextMenuOn = async (card) => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      return waitFor(() => document.querySelector('.context-menu'), 'context menu');
    };

    await waitFor(() => document.querySelector('.app') && cardById(config.parentId)
      && cardById(config.child3Id) && cardById(config.standaloneId), 'all seeded cards rendered');

    // ── Stage A: focus 版本 1, slow 版本 3, re-click 版本 1 ──
    (await waitFor(() => cardById(config.parentId), 'parent card')).click();
    await waitFor(() => Boolean(document.querySelector('.details .asset-title')), 'inspector opens');
    await waitFor(() => versionRows().length >= 3, '版本 rows listed');
    const restoreA = delayDetail(config.child3Id, 1200);
    (await waitFor(() => rowOf('版本 3'), '版本 3 row')).click();
    await waitFor(() => window['delay-' + config.child3Id] >= 1, 'the slow 版本 3 fetch is in flight');
    rowOf('版本 1').click();
    restoreA();
    await sleep(1800);
    const reclickStays = selectedIds().length === 1 && selectedIds()[0] === config.parentId
      && /^版本 1/.test(checkedRowLabel());

    // ── Stage B: multi-select A+B focused on A, slow 版本 2, right-click A ──
    ctrlClick(cardById(config.standaloneId));
    ctrlClick(cardById(config.parentId));
    await waitFor(() => selectedIds().length === 2
      && selectedIds().includes(config.standaloneId) && selectedIds().includes(config.parentId),
      'two rings on A + parent');
    const restoreB = delayDetail(config.child2Id, 1200);
    (await waitFor(() => rowOf('版本 2'), '版本 2 row')).click();
    await waitFor(() => window['delay-' + config.child2Id] >= 1, 'the slow 版本 2 fetch is in flight');
    // Right-click the inspected member: the re-click must invalidate the
    // in-flight 版本 2 fetch, or its late response would collapse the batch
    // onto 版本 2 behind the open menu. The batch op is a favorite — trash
    // cannot serve: the server requires versions to be trashed leaves-first,
    // so a parent with live children is rightly refused.
    await contextMenuOn(cardById(config.parentId));
    await sleep(1800);
    const batchTargetHonest = selectedIds().length === 2
      && selectedIds().includes(config.standaloneId) && selectedIds().includes(config.parentId);
    const item = Array.from(document.querySelectorAll('.context-menu button'))
      .find((entry) => entry.textContent.trim() === '收藏');
    if (!item) throw new Error('missing favorite menu item');
    item.click();
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    await waitFor(() => navSmall('收藏') === '2', 'favorite count is exactly the two selected');
    restoreB();

    return { reclickStays, batchTargetHonest, standaloneId: config.standaloneId, parentId: config.parentId, child2Id: config.child2Id, child3Id: config.child3Id };
  })()
  `;
}
