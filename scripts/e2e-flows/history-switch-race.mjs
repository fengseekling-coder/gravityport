// GravityPort React UI flow: switching to a version/round from the inspector
// binds the in-flight asset fetch to the view it was clicked in. A delayed
// response that lands after a project switch — or after a newer version
// click — must never append its asset to, or move the selection of, the view
// it no longer belongs to.
export const name = "history-switch-race";
export const description = "parent+2 versions -> slow 版本 3 fetch -> switch to another project -> late response must not append or select -> back in default, 版本 3 then 版本 2 clicked with both delayed -> the newer click wins and stays";

import { CHOOSE_PROJECT_SOURCE } from "./_shared.mjs";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const parentCreate = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("history-race-parent.png", [74, 127, 181]),
      prompt: "history race parent prompt",
    });
    const parent = parentCreate.asset;
    const child2 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(parent.id)}/versions`, { version_change: "e2e second version" });
    const child3 = await ctx.api(server.origin, "POST",
      `/api/assets/default/${encodeURIComponent(child2.asset.id)}/versions`, { version_change: "e2e third version" });
    const vacation = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "vacation", imagePath: await ctx.makePng("history-race-vacation.png", [181, 127, 74]),
      prompt: "vacation project asset",
    });
    const result = await ctx.runInPage(server, flowSource({
      parentId: parent.id,
      child2Id: child2.asset?.id || "",
      child3Id: child3.asset?.id || "",
      vacationId: vacation.asset?.id || "",
    }), { windowSize: [1440, 940] });
    if (result?.lateResponseIgnored !== true || result?.newerClickWins !== true) {
      throw new Error(`history-switch-race result: ${JSON.stringify({ parent: parent.id, ...result })}`);
    }
    return { parentId: parent.id, child2Id: child2.asset?.id, child3Id: child3.asset?.id, ...result };
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
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | rows=' + (versionRows().map((row) => '[' + (row.querySelector('span')?.textContent || '').slice(0, 24) + ']').join(' ') || 'none'));
    }
    const cards = () => document.querySelectorAll('.asset-card').length;
    const cardById = (id) => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.dataset.assetId === id) || null;
    const selectedCard = () => document.querySelector('.asset-card.asset-selected');
    const versionRows = () => Array.from(document.querySelectorAll('.version-list[aria-label="版本"] .related'));
    // The row text runs straight into the change note ("版本 3e2e third…"),
    // so anchor on the index not being followed by another digit.
    const rowOf = (label) => versionRows()
      .find((row) => new RegExp('^' + label + '(?!\\d)').test(row.querySelector('span')?.textContent || '')) || null;
    const escapeRegex = (text) => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const switchProject = chooseProject;
    // Delay exactly the single-asset detail fetch for one id. The versions
    // and generation-history endpoints share the prefix, so anchor the id
    // against the query string or a following path segment. Wrappers chain:
    // each passes through to the window.fetch it was installed over, so two
    // delayed ids can be in flight at once.
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

    await waitFor(() => document.querySelector('.app') && cardById(config.parentId), 'seeded parent card');
    (await waitFor(() => cardById(config.parentId), 'parent card')).click();
    await waitFor(() => document.querySelector('.details .asset-title'), 'inspector opens');
    await waitFor(() => versionRows().length >= 3, '版本 section lists all three versions');

    // ── Stage A: a slow 版本 3 response outlives its view (project switch) ──
    const restoreA = delayDetail(config.child3Id, 900);
    (await waitFor(() => rowOf('版本 3'), '版本 3 row')).click();
    await waitFor(() => window['delay-' + config.child3Id] >= 1, 'the slow 版本 3 fetch is in flight');
    await switchProject('vacation');
    await waitFor(() => cards() === 1 && cardById(config.vacationId), 'the vacation gallery loads');
    restoreA();
    await sleep(1600);
    const lateResponseIgnored = cards() === 1
      && !cardById(config.child3Id)
      && (!selectedCard() || selectedCard().dataset.assetId === config.vacationId);

    // ── Stage B: two version clicks race — the newer intent wins and stays ──
    await switchProject('default');
    await waitFor(() => cardById(config.parentId), 'the default gallery is back');
    (await waitFor(() => cardById(config.parentId), 'parent card')).click();
    await waitFor(() => versionRows().length >= 3, '版本 section lists the chain again');
    const restoreB = delayDetail(config.child3Id, 1200);
    delayDetail(config.child2Id, 400);
    (await waitFor(() => rowOf('版本 3'), '版本 3 row')).click();
    await waitFor(() => window['delay-' + config.child3Id] >= 1, 'the 版本 3 fetch is in flight');
    (await waitFor(() => rowOf('版本 2'), '版本 2 row')).click();
    await waitFor(() => window['delay-' + config.child2Id] >= 1, 'the 版本 2 fetch is in flight');
    // 版本 2 resolves first and owns the selection; the later 版本 3 response
    // is stale by intent and must never take it back.
    restoreB();
    await sleep(1600);
    const selectedRow = versionRows().find((row) => row.firstElementChild?.tagName === 'svg') || null;
    const selectedLabel = (selectedRow?.querySelector('span')?.textContent || '').trim();
    const newerClickWins = /^版本 2(?!\d)/.test(selectedLabel)
      && rowOf('版本 3')?.firstElementChild?.tagName !== 'svg';

    return { lateResponseIgnored, newerClickWins, selectedLabel };
  })()
  `;
}
