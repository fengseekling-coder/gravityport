// GravityPort React UI flow: a select-all queued behind an in-flight load is
// bound to the view identity and selection revision it was pressed in. A
// same-view refresh lets it through; a project switch consumes the stale
// intent without selecting the new gallery; Escape cancels it outright.
export const name = "pending-select-all-scope";
export const description = "delayed load + ⌘A -> project switch -> new project NOT all-selected || same-view refresh + ⌘A -> all selected after settle || delayed project load + ⌘A + Escape -> nothing all-selected";

import { CHOOSE_PROJECT_SOURCE } from "./_shared.mjs";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const defaultIds = [];
    for (const file of ["pending-a.png", "pending-b.png", "pending-c.png", "pending-d.png"]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, [74, 127, 181]), prompt: "pending select all",
      });
      defaultIds.push(created.asset?.id);
    }
    const vacationIds = [];
    for (const file of ["pending-v1.png", "pending-v2.png"]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "vacation", imagePath: await ctx.makePng(file, [181, 127, 74]), prompt: "pending vacation",
      });
      vacationIds.push(created.asset?.id);
    }
    const result = await ctx.runInPage(server, flowSource({
      favoriteTargetId: defaultIds[0],
    }), { windowSize: [1440, 940] });
    if (result?.switchConsumedPending !== true || result?.sameViewRefreshFires !== true
      || result?.escapeCancelsPending !== true) {
      throw new Error(`pending-select-all-scope result: ${JSON.stringify(result)}`);
    }
    return { ...result, defaultCount: defaultIds.length, vacationCount: vacationIds.length };
  } finally {
    await server.stop();
  }
}

function flowSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${CHOOSE_PROJECT_SOURCE}
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      e2eTimeoutReport(label, timeoutMs);
      throw new Error('Timed out waiting for ' + label
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | selected=' + document.querySelectorAll('.asset-card.asset-selected').length
        + ' | busy=' + Boolean(document.querySelector('.empty-state[role="status"]'))
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const ringCount = () => document.querySelectorAll('.asset-card.asset-selected').length;
    const busy = () => Boolean(document.querySelector('.empty-state[role="status"]'));
    const navButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    const pressSelectAll = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    const pressEscape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // Delays every gallery listing GET: the load effect's loading window
    // becomes long enough to press ⌘A inside it deterministically.
    const delayGallery = (ms) => {
      if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
      const previousFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : String(input.url || '');
        if (url.includes('/api/assets?') && url.includes('view=gallery')) await sleep(ms);
        return previousFetch(input, init);
      };
      return () => { window.fetch = previousFetch; };
    };
    const switchProject = chooseProject;

    await waitFor(() => document.querySelector('.app') && cards().length >= 1, 'first default cards rendered');

    // ── Stage A: ⌘A during a delayed load, then a project switch — the new
    // project must open with its implicit single, never a select-all. ──
    const restoreA = delayGallery(800);
    navButton('收藏').click();
    await waitFor(busy, 'the 收藏 load is in flight');
    pressSelectAll();
    await switchProject('vacation');
    restoreA();
    await waitFor(() => cards().length === 2, 'the vacation gallery loads');
    await sleep(600);
    const switchConsumedPending = cards().length === 2 && ringCount() === 1;

    // ── Stage B: ⌘A during a delayed same-view refresh — it fires on the
    // settled view. ──
    await switchProject('default');
    await waitFor(() => cards().length === 4, 'the default gallery is back');
    const restoreB = delayGallery(600);
    const target = await waitFor(() => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === config.favoriteTargetId) || null, 'favorite target card');
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'context menu for favorite');
    const favoriteItem = Array.from(document.querySelectorAll('.context-menu button'))
      .find((entry) => entry.textContent.trim() === '收藏');
    if (!favoriteItem) throw new Error('missing favorite menu item');
    favoriteItem.click();
    await waitFor(busy, 'the same-view refresh is in flight');
    pressSelectAll();
    restoreB();
    await waitFor(() => ringCount() === 4, 'the queued select-all lands on the settled view');
    const sameViewRefreshFires = ringCount() === 4;

    // ── Stage C: ⌘A during a delayed project load, then Escape — nothing is
    // all-selected. ──
    const restoreC = delayGallery(600);
    await switchProject('vacation');
    await waitFor(busy, 'the delayed vacation load is in flight');
    pressSelectAll();
    pressEscape();
    restoreC();
    await waitFor(() => cards().length === 2, 'the vacation gallery loads again');
    await sleep(600);
    const escapeCancelsPending = cards().length === 2 && ringCount() === 1;

    return { switchConsumedPending, sameViewRefreshFires, escapeCancelsPending };
  })()
  `;
}
