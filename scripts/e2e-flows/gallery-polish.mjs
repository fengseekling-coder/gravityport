// GravityPort React UI flow: the small gallery pieces wired in after the menu
// work — view-specific empty states, landscape cards spanning columns, the
// remembered column count, and the group statistics dialog.
export const name = "gallery-polish";
export const description = "empty library/favorites/trash show their own guidance -> a wide image spans columns and the column choice is remembered -> group statistics shows labelled counts";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const empty = await ctx.runInPage(server, emptySource(), { windowSize: [1440, 940] });
    if (empty?.library !== true || empty?.favorites !== true || empty?.trash !== true) {
      throw new Error(`gallery-polish empty states: ${JSON.stringify(empty)}`);
    }

    const normalIds = [];
    for (const [index, color] of [[0, [74, 127, 181]], [1, [181, 127, 74]], [2, [127, 181, 74]], [3, [181, 74, 127]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`polish-n${index}.png`, color, { width: 120, height: 120 }),
        prompt: `polish normal ${index}`,
      });
      normalIds.push(created.asset.id);
    }
    const wide = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng("polish-wide.png", [60, 60, 60], { width: 480, height: 120 }),
      prompt: "polish wide banner",
    });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: "polish" });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      projectId: "default", action: "group", assetIds: normalIds.slice(0, 2), group: "polish",
    });

    const layout = await ctx.runInPage(server, layoutSource({ wideId: wide.asset.id, normalId: normalIds[0] }), { windowSize: [1440, 940] });
    if (layout?.wideSpans !== true || layout?.columnsRemembered !== true || layout?.groupStatsLabelled !== true || layout?.groupMenuShared !== true) {
      throw new Error(`gallery-polish layout: ${JSON.stringify(layout)}`);
    }
    return { empty, layout };
  } finally {
    await server.stop();
  }
}

const helpers = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | empty=' + (document.querySelector('.empty-state')?.textContent || '')
        + ' | cards=' + document.querySelectorAll('.asset-card').length);
    }
    function navButton(label) {
      return Array.from(document.querySelectorAll('.main-nav button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    }
    const emptyText = () => document.querySelector('.empty-state:not([role])')?.textContent || '';
`;

function emptySource() {
  return `(async () => {
    ${helpers}
    await waitFor(() => document.querySelector('.app'), 'app shell');
    await waitFor(() => emptyText().includes('素材库还是空的'), 'the empty library guidance');
    const library = emptyText().includes('把图片或文件夹拖进窗口');

    (await waitFor(() => navButton('收藏'), 'favorites nav')).click();
    await waitFor(() => emptyText().includes('还没有收藏'), 'the empty favorites guidance');
    const favorites = true;

    (await waitFor(() => navButton('回收站'), 'trash nav')).click();
    await waitFor(() => emptyText().includes('回收站是空的'), 'the empty trash guidance');
    const trash = emptyText().includes('90 天');
    return { library, favorites, trash };
  })()`;
}

function layoutSource(config) {
  return `(async () => {
    ${helpers}
    const config = ${JSON.stringify(config)};
    const card = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    await waitFor(() => card(config.wideId) && card(config.normalId), 'wide and normal cards mounted');

    // Pick the 4-column layout, then compare widths: the wide image must cover
    // more than one column while a square image stays on one.
    document.querySelector('.column-trigger').click();
    const four = await waitFor(() => Array.from(document.querySelectorAll('.column-popover button'))
      .find((node) => node.textContent.trim() === '4') || null, 'column tick 4');
    four.click();
    await waitFor(() => document.querySelector('.asset-grid')?.style.gridTemplateColumns.startsWith('repeat(4'), 'grid reflects 4 columns');
    const widths = () => [card(config.wideId)?.getBoundingClientRect().width || 0, card(config.normalId)?.getBoundingClientRect().width || 0];
    // The spanned layout lands once the masonry model has been measured.
    await waitFor(() => { const [w, n] = widths(); return n > 0 && w > n * 1.5; }, 'the wide card spanning columns', 10000)
      .catch(() => {});
    const [wideWidth, normalWidth] = widths();
    const wideSpans = wideWidth > normalWidth * 1.5;
    const columnsRemembered = window.localStorage.getItem('gravityport.galleryColumns') === '4';

    // Group statistics: right-click the group in the sidebar -> 分组统计.
    const groupRow = await waitFor(() => Array.from(document.querySelectorAll('.group-row'))
      .find((row) => (row.getAttribute('aria-label') || '') === 'polish') || null, 'the polish group row');
    groupRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 300 }));
    const statsItem = await waitFor(() => Array.from(document.querySelectorAll('.context-menu button'))
      .find((button) => button.textContent.trim() === '分组统计') || null, 'group statistics menu item');
    // The group menu is the shared context menu: no heading, the six colors
    // in a submenu, and delete styled as the danger row.
    const groupMenu = statsItem.closest('.context-menu');
    const groupMenuShared = Boolean(groupMenu) && !groupMenu.querySelector('.menu-heading')
      && Array.from(groupMenu.querySelectorAll('button[aria-haspopup="menu"]')).some((button) => button.textContent.includes('分组颜色'))
      && Array.from(groupMenu.querySelectorAll('button.danger')).some((button) => button.textContent.includes('删除分组'));
    statsItem.click();
    const dialog = await waitFor(() => document.querySelector('.group-stats-data'), 'the statistics dialog');
    await waitFor(() => dialog.textContent.includes('素材总数') && dialog.textContent.includes('按分类'), 'labelled statistics');
    const groupStatsLabelled = !/total:|favorites:|versionChildren/.test(dialog.textContent);
    return { wideWidth, normalWidth, wideSpans, columnsRemembered, groupStatsLabelled, groupMenuShared };
  })()`;
}
