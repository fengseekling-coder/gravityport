// GravityPort React UI flow (review 中10): a view that dies under the user —
// a dissolved stack, a fully trashed stack, a deleted group, a renamed group —
// exits automatically and rewrites the history entry, so going back never
// returns to the dead view. Plus the stack's filtered empty state.
export const name = "live-sync-view-gone";
export const description = "dissolved/emptied stack auto-exits (back never returns), deleted group falls back to 所有素材, renamed group follows, stack+video filter shows the no-results empty state";

import { TOOLBAR_SELECT_SOURCE } from "./_shared.mjs";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const ids = [];
    for (let i = 1; i <= 8; i += 1) {
      const asset = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`view-gone-${i}.png`, [74, 127, 181]),
        prompt: `view gone ${i}`,
      });
      ids.push(asset.asset.id);
    }
    // stackA gets dissolved, stackB gets emptied by trash, stackC stays for
    // the filtered empty state; groupA gets deleted, groupB gets renamed.
    const stackA = (await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [ids[0], ids[1]] })).stack;
    const stackB = (await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [ids[2], ids[3]] })).stack;
    const stackC = (await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [ids[4], ids[5]] })).stack;
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: "GoneA" });
    await ctx.api(server.origin, "POST", "/api/assets/batch", { projectId: "default", action: "group", assetIds: [ids[0]], group: "GoneA" });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: "RenameB" });
    await ctx.api(server.origin, "POST", "/api/assets/batch", { projectId: "default", action: "group", assetIds: [ids[1]], group: "RenameB" });

    const result = await ctx.runInPage(server, viewGoneSource(stackA.id, stackA.cover_asset_id, stackB.id, stackB.cover_asset_id, stackC.cover_asset_id, ids[2], ids[3]), { windowSize: [1440, 940] });
    if (result?.dissolveExited !== true || result?.backSkipsDeadStack !== true
      || result?.emptiedStackExited !== true || result?.deletedGroupFellBack !== true
      || result?.backFromDeletedGroupLandsSafe !== true || result?.forwardAfterBackSafe !== true
      || result?.renamedGroupFollowed !== true || result?.filteredEmptyState !== true) {
      throw new Error(`live-sync-view-gone result: ${JSON.stringify(result)}`);
    }
    return { ...result };
  } finally {
    await server.stop();
  }
}

function viewGoneSource(stackA, stackACover, stackB, stackBCover, stackCCover, stackBMember1, stackBMember2) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${TOOLBAR_SELECT_SOURCE}
    async function chooseToolbarOption(label, optionText) {
      const trigger = Array.from(document.querySelectorAll('.toolbar-select')).find((node) => {
        const combobox = node.getAttribute('role') === 'combobox';
        const matches = node.getAttribute('aria-label') === label || node.textContent.includes(label);
        return combobox && matches;
      });
      if (!trigger) throw new Error('Missing toolbar select ' + label);
      const optionFor = () => Array.from(document.querySelectorAll('.toolbar-select-menu [role="option"]'))
        .find((node) => node.textContent.trim() === optionText) || null;
      await chooseToolbarSelect(() => trigger, optionFor, 'option ' + optionText, 'toolbar select ' + label, 'menu closes');
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    const api = (path, method, body) => fetch(path, {
      method: method || 'GET',
      headers: { 'x-mosa-client-token': clientToken(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => {
      if (!response.ok) throw new Error(method + ' ' + path + ' -> ' + response.status);
      return response.json();
    });
    const cardCount = () => document.querySelectorAll('.asset-card').length;
    const stackTitle = () => { const titles = document.querySelectorAll('.viewer-title'); return titles.length ? titles[titles.length - 1] : null; };
    const activeNav = () => document.querySelector('.nav-row[aria-current="page"]')?.getAttribute('aria-label') || '';
    const loadError = () => document.querySelector('.empty-state[role="alert"]');
    const FALLBACK_REASONS = ['incomplete', 'unknown-kind', 'library-backfilled', 'library-changed-detail', 'too-many-ids', 'rows-failed', 'data-version-only', 'errors', 'lastError'];
    const noFallback = (label) => {
      const stats = window.__mosaLibrarySync?.stats() || {};
      const fallbacks = Object.entries(stats).filter(([key, value]) => FALLBACK_REASONS.includes(key) && Number(value) > 0);
      if (fallbacks.length) throw new Error(label + ' fell back: ' + JSON.stringify(fallbacks));
    };
    const enterStack = async (coverSelector, label) => {
      const cover = document.querySelector(coverSelector);
      cover.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await waitFor(() => stackTitle() && stackTitle().querySelector('span')?.textContent?.trim().endsWith('素材'), label + ' stack entered');
    };

    await waitFor(() => cardCount() === 5, 'five top-level cards (three stack nodes + two loose assets)');

    // ── 1. external dissolve exits the stack view ──
    await enterStack('.asset-card[data-asset-id="' + ${JSON.stringify(stackACover)} + '"] .stack-mark', 'A');
    await api('/api/asset-stacks/' + ${JSON.stringify(stackA)}, 'DELETE', { projectId: 'default' });
    try {
      await waitFor(() => !stackTitle(), 'dissolve exited the stack view');
    } catch (error) {
      return {
        dissolveExited: false,
        diag: {
          stackTitle: stackTitle()?.textContent || null,
          stats: window.__mosaLibrarySync?.stats() || null,
          activeNav: activeNav(),
          cards: [...document.querySelectorAll('.asset-card')].map(node => node.dataset.assetId),
        },
      };
    }
    const dissolveExited = !stackTitle() && !loadError();
    noFallback('dissolve');
    // Back must not return to the dead stack: one back step goes to the
    // pre-stack entry (所有素材), a second is the history edge.
    document.querySelector('button[aria-label="后退"]').click();
    await sleep(500);
    const backSkipsDeadStack = !stackTitle() && !loadError() && cardCount() === 6;

    // ── 2. a stack whose members are all trashed exits too ──
    await enterStack('.asset-card[data-asset-id="' + ${JSON.stringify(stackBCover)} + '"] .stack-mark', 'B');
    await api('/api/assets/batch', 'POST', { action: 'trash', projectId: 'default', assetIds: [${JSON.stringify(stackBMember1)}, ${JSON.stringify(stackBMember2)}] });
    await waitFor(() => !stackTitle(), 'emptied stack exited the view');
    const emptiedStackExited = !stackTitle() && !loadError();
    noFallback('emptied stack');

    // ── 3. deleting the viewed group falls back to 所有素材 ──
    [...document.querySelectorAll('.nav-row')].find(node => node.getAttribute('aria-label') === 'GoneA').click();
    await waitFor(() => activeNav() === 'GoneA', 'group GoneA entered');
    await api('/api/groups/GoneA?project=default', 'DELETE');
    await waitFor(() => activeNav() === '所有素材', 'deleted group fell back to 所有素材');
    const deletedGroupFellBack = activeNav() === '所有素材' && !loadError();
    noFallback('group delete');

    // ── 4. renaming the viewed group follows the new name ──
    [...document.querySelectorAll('.nav-row')].find(node => node.getAttribute('aria-label') === 'RenameB').click();
    await waitFor(() => activeNav() === 'RenameB', 'group RenameB entered');
    await api('/api/groups/RenameB', 'PATCH', { projectId: 'default', name: 'RenamedC' });
    await waitFor(() => activeNav() === 'RenamedC', 'renamed group followed to RenamedC');
    const renamedGroupFollowed = activeNav() === 'RenamedC' && !loadError();
    noFallback('group rename');

    // ── 4b. 320 补充 6：后退/前进落到已删分组上同样替换成退出目标 ──
    // 历史：… → RenamedC → 待整理。外部删 RenamedC 后按后退——落到指向
    // 已删分组的条目，必须被替换成「所有素材」；再按前进回到待整理。
    [...document.querySelectorAll('.main-nav .nav-row')].find(node => node.getAttribute('aria-label') === '待整理').click();
    await waitFor(() => activeNav() === '待整理', '待整理 entered (history: RenamedC -> 待整理)');
    await api('/api/groups/' + encodeURIComponent('RenamedC') + '?project=default', 'DELETE');
    await sleep(700); // 让删除的推送/统计先落定
    document.querySelector('button[aria-label="后退"]').click();
    try {
      await waitFor(() => activeNav() === '所有素材', 'back onto the deleted group lands on 所有素材', 3000);
    } catch {}
    const backFromDeletedGroupLandsSafe = activeNav() === '所有素材' && !loadError();
    noFallback('back onto deleted group');
    document.querySelector('button[aria-label="前进"]').click();
    await sleep(500);
    const forwardAfterBackSafe = activeNav() === '待整理' && !loadError();

    // ── 5. stack + video filter with only images: no-results empty state ──
    if (activeNav() !== '所有素材') {
      [...document.querySelectorAll('.main-nav .nav-row')].find(node => node.getAttribute('aria-label') === '所有素材').click();
    }
    await waitFor(() => document.querySelector('.asset-card[data-asset-id="' + ${JSON.stringify(stackCCover)} + '"] .stack-mark'), 'stack C card visible in 所有素材');
    await enterStack('.asset-card[data-asset-id="' + ${JSON.stringify(stackCCover)} + '"] .stack-mark', 'C');
    await chooseToolbarOption('素材类型', '视频');
    await sleep(400);
    const emptyText = document.querySelector('.empty-state')?.textContent || '';
    const filteredEmptyState = emptyText.includes('没有匹配的素材') && Boolean(document.querySelector('.empty-state button'));
    return { dissolveExited, backSkipsDeadStack, emptiedStackExited, deletedGroupFellBack, backFromDeletedGroupLandsSafe, forwardAfterBackSafe, renamedGroupFollowed, filteredEmptyState };

  })()
  `;
}
