// GravityPort React UI flow: unified selection under an explicit focus
// switch. Multi-select A/B, then move the inspector to version C: the batch
// selection must collapse onto the visible C, so a batch trash hits exactly
// the focused asset on the server — never the out-of-sight A/B the user
// stopped looking at.
export const name = "focus-switch-batch-target";
export const description = "ctrl-select A+B -> inspector on parent with 版本 rows -> slow 版本 2 click collapses rings to C -> context-menu trash -> server trash holds exactly C, A/B untouched";
export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("focus-batch-parent.png", [74, 127, 181]),
      prompt: "focus batch parent prompt",
    });
    const parent = parentCreate.asset;
    const child = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.id)}/versions`, { version_change: "e2e focus batch second version" });
    const standaloneA = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("focus-batch-a.png", [181, 127, 74]),
      prompt: "focus batch standalone a",
    });
    const standaloneB = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("focus-batch-b.png", [127, 181, 74]),
      prompt: "focus batch standalone b",
    });
    const result = await ctx.runInPage(server, flowSource({
      parentId: parent.id,
      childId: child.asset?.id || "",
      standaloneAId: standaloneA.asset?.id || "",
      standaloneBId: standaloneB.asset?.id || "",
    }), { windowSize: [1440, 940] });
    if (result?.ringsBefore !== 2 || result?.collapsedToChild !== true || result?.batchTrashedFocused !== true) {
      throw new Error(`focus-switch-batch-target result: ${JSON.stringify({ parent: parent.id, ...result })}`);
    }
    // Server truth: the trash holds exactly the focused version; the
    // multi-selected pair is still live in the library.
    const all = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=200");
    const trash = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=200");
    const allIds = new Set((all.assets || []).map(item => item.id));
    const trashIds = (trash.assets || []).map(item => item.id);
    const serverTargetsHonest = trashIds.length === 1 && trashIds[0] === result.trashedId
      && allIds.has(parent.id) && allIds.has(standaloneA.asset?.id) && allIds.has(standaloneB.asset?.id)
      && !allIds.has(result.trashedId);
    if (!serverTargetsHonest) {
      throw new Error(`focus-switch-batch-target server truth: trash=${JSON.stringify(trashIds)} all=${JSON.stringify([...allIds])}`);
    }
    return { ...result, serverTargetsHonest };
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
        + ' | rows=' + (versionRows().map((row) => '[' + (row.querySelector('span')?.textContent || '').slice(0, 24) + ']').join(' ') || 'none')
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cardById = (id) => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === id) || null;
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected'))
      .map((card) => card.dataset.assetId);
    const versionRows = () => Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'));
    const rowOf = (label) => versionRows()
      .find((row) => new RegExp('^' + label + '(?!\\d)').test(row.querySelector('span')?.textContent || '')) || null;
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

    await waitFor(() => document.querySelector('.app') && cardById(config.parentId)
      && cardById(config.childId) && cardById(config.standaloneAId) && cardById(config.standaloneBId),
      'all four seeded cards rendered');

    // Multi-select A + B, ending on the parent so the inspector shows the
    // 版本 rows: the batch selection is {A, parent}, focus is the parent.
    ctrlClick(cardById(config.standaloneAId));
    ctrlClick(cardById(config.parentId));
    await waitFor(() => selectedIds().length === 2
      && selectedIds().includes(config.standaloneAId) && selectedIds().includes(config.parentId),
      'two rings on A + parent');
    const ringsBefore = selectedIds().length;
    await waitFor(() => versionRows().length >= 2, '版本 rows visible on the focused parent');

    // Switch the inspector to 版本 2 while the multi-selection exists: the
    // commit must collapse the rings onto the focused version instead of
    // leaving A as a hidden batch target.
    const restore = delayDetail(config.childId, 700);
    (await waitFor(() => rowOf('版本 2'), '版本 2 row')).click();
    await waitFor(() => window['delay-' + config.childId] >= 1, 'the slow 版本 2 fetch fired');
    // Deterministic churn: a favorite toggle fires a library event whose
    // debounced refresh must leave the in-flight version click alone — a
    // background refresh may never silently drop an explicit focus commit.
    void fetch('/api/assets/default/' + config.standaloneBId + '/favorite', {
      method: 'POST',
      headers: { 'x-mosa-client-token': sessionStorage.getItem('mosa.client-token') || '' },
    });
    restore();
    await waitFor(() => selectedIds().length === 1 && selectedIds()[0] === config.childId,
      'rings collapsed to the focused 版本 2');
    const collapsedToChild = selectedIds().length === 1 && selectedIds()[0] === config.childId;

    // Batch trash through the context menu on the focused card: the server
    // must receive exactly the visible 版本 2.
    cardById(config.childId).dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: 600, clientY: 400,
    }));
    const item = await waitFor(() => Array.from(document.querySelectorAll('.context-menu button'))
      .find((entry) => entry.textContent.trim() === '移至回收站') || null, 'trash menu item');
    item.click();
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'delete confirm');
    const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent.trim() === '移至回收站');
    confirm.click();
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    await waitFor(() => navSmall('回收站') === '1', 'trash count is exactly one');
    const batchTrashedFocused = navSmall('回收站') === '1'
      && !cardById(config.childId)
      && Boolean(cardById(config.standaloneAId))
      && Boolean(cardById(config.parentId));

    return { ringsBefore, collapsedToChild, batchTrashedFocused, trashedId: config.childId };
  })()
  `;
}
