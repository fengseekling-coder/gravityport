// GravityPort React UI flow (task 431): the Pinterest pages use the gallery's
// own chrome. Board list -> open a board (top bar ‹ + "name · N 个 Pin", no
// in-page header) -> single-click a Pin (gallery selection outline, right column
// 素材详情 with the Pin) -> double-click (shared viewer, "i / N") -> Esc/返回 back
// to the Pin grid with its scroll position -> ‹ back to the board list.
// Every Pinterest endpoint is faked inside the page: no real Pinterest call.
export const name = "pinterest-browse";
export const description = "Pinterest boards -> board Pins -> click: right column detail -> double-click: viewer -> back -> board list, fake data only";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    for (const [file, color] of [["pin-browse-a.png", [74, 127, 181]], ["pin-browse-b.png", [181, 68, 74]]]) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, color), prompt: "pinterest browse seed",
      });
    }
    return await ctx.runInPage(server, pinterestBrowseSource());
  } finally {
    await server.stop();
  }
}

function pinterestBrowseSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        if (check()) { stable += 1; if (stable >= 2) return true; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | main=' + (document.querySelector('main')?.innerText || '').slice(0, 200));
    }
    // Every poll re-queries: the views replace their nodes when state changes.
    const q = (selector) => document.querySelector(selector);
    const qa = (selector) => Array.from(document.querySelectorAll(selector));
    const navButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
    const key = (init) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    const toolbarTitle = () => q('.toolbar .viewer-title')?.innerText.replace(/\\s+/g, ' ').trim() || '';

    await waitFor(() => q('.app') && qa('.asset-card').length === 2, 'two seeded cards');
    const seeded = (await (await fetch('/api/assets?project=default&limit=10', { credentials: 'same-origin' })).json()).assets || [];
    const image = seeded[0]?.thumbnail_url || seeded[0]?.image_url;
    if (!image) throw new Error('no seeded image url to stand in for Pin pictures');

    // Fake Pinterest API: connected, 3 boards (one private, one without cover), 12 Pins.
    const dims = [[600, 900], [900, 600], [600, 600], [600, 800], [800, 600], [600, 900]];
    const pins = Array.from({ length: 12 }, (_, i) => ({
      id: 'p' + i,
      title: i % 3 === 0 ? 'Pin ' + i : '',
      description: i === 0 ? 'First line\\nSecond line' : '',
      link: i === 0 ? 'https://example.com/shop/item' : '',
      pin_url: 'https://www.pinterest.com/pin/' + i + '/',
      board_id: '1001',
      created_at: '',
      media_type: 'image',
      image: { url: image, width: dims[i % dims.length][0], height: dims[i % dims.length][1] },
      thumbnail: { url: image, width: dims[i % dims.length][0], height: dims[i % dims.length][1] },
      video_cover_url: '',
    }));
    const boards = [
      { id: '1001', name: 'Inspiration', description: '', privacy: 'PUBLIC', pin_count: 12, cover_url: image },
      { id: '1002', name: 'Secret board', description: '', privacy: 'SECRET', pin_count: 4, cover_url: image },
      { id: '1003', name: 'Quick saves', description: '', privacy: 'PUBLIC', pin_count: 0, cover_url: '' },
    ];
    const realFetch = window.fetch.bind(window);
    const pinterestCalls = [];
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const path = new URL(url, location.href).pathname;
      if (!path.startsWith('/api/pinterest/')) return realFetch(input, init);
      pinterestCalls.push(path);
      const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/api/pinterest/status') return json({ connected: true, username: 'tester' });
      if (path === '/api/pinterest/boards') return json({ items: boards, bookmark: '' });
      if (/^\\/api\\/pinterest\\/boards\\/1001\\/pins$/.test(path)) return json({ items: pins, bookmark: '' });
      return json({ items: [], bookmark: '' });
    };

    // 1. Board list: gallery top bar without extra buttons, gallery-style cards.
    navButton('Pinterest').click();
    await waitFor(() => qa('.pinterest-board-card').length === 3, 'three board cards');
    if (q('.pinterest-board-header') || q('.pinterest-secondary')) throw new Error('board list still has the old in-page header/pill button');
    if (!qa('.pinterest-board-card .asset-card').length) throw new Error('board covers are not gallery cards');
    if (q('.toolbar .viewer-title') || q('.toolbar .search') || q('.toolbar .column-control')) throw new Error('board list top bar has extra controls: ' + toolbarTitle());
    if (q('.details')) throw new Error('right column shown on the board list');
    const privateLabel = qa('.pinterest-board-card')[1].querySelector('.pinterest-badge');
    if (!privateLabel || getComputedStyle(privateLabel).backgroundColor !== 'rgba(0, 0, 0, 0)') throw new Error('private label is not quiet text');
    const firstBoardName = qa('.pinterest-board-card')[0].querySelector('.pinterest-board-name').getBoundingClientRect();
    const firstBoardMeta = qa('.pinterest-board-card')[0].querySelector('.pinterest-board-meta').getBoundingClientRect();
    if (Math.abs(firstBoardName.top - firstBoardMeta.top) > 2) throw new Error('board name and Pin count are not on one line');

    // 2. Open a board: top bar ‹ + "name · N 个 Pin", cards are images only.
    qa('.pinterest-board-card')[0].click();
    await waitFor(() => qa('.pinterest-pin-card').length === 12, 'twelve Pin cards');
    await waitFor(() => /Inspiration/.test(toolbarTitle()) && /12/.test(toolbarTitle()), 'board title in the top bar');
    if (!q('.toolbar-left button[aria-label="后退"]')) throw new Error('no ‹ back button in the top bar');
    if (q('.pinterest-board-header')) throw new Error('in-page board header still drawn');
    if (!q('.toolbar .column-control')) throw new Error('column control missing in the board top bar');
    const titledCard = qa('.pinterest-pin-card')[0];
    if (titledCard.querySelector('.pinterest-pin-title') || titledCard.textContent.trim() !== '') throw new Error('Pin title still painted on the card');
    if (titledCard.getAttribute('title') !== 'Pin 0') throw new Error('Pin title not in the hover tooltip: ' + titledCard.getAttribute('title'));
    const gutters = (() => {
      const a = qa('.pinterest-pin-card')[0].getBoundingClientRect();
      const b = qa('.pinterest-pin-card')[1].getBoundingClientRect();
      return { sameColumnGap: Math.round(b.top - a.bottom), radius: getComputedStyle(qa('.pinterest-pin-card')[0]).borderRadius };
    })();

    // Entering a board focuses the first Pin, like the main gallery: the right column is there from the start.
    await waitFor(() => qa('.pinterest-pin-card')[0]?.classList.contains('asset-selected') && qa('.pinterest-pin-card.asset-selected').length === 1, 'first Pin focused on entering the board');
    await waitFor(() => q('.details') && /Pin 0/.test(q('.details').innerText), 'right column shows the first Pin on entering the board');

    // 3. Single click: selection outline + right column 素材详情 (no dialog).
    const grid = q('.pinterest-view');
    grid.scrollTop = 120;
    await sleep(100);
    const scrolledTo = grid.scrollTop;
    qa('.pinterest-pin-card')[0].click();
    await waitFor(() => qa('.pinterest-pin-card.asset-selected').length === 1, 'selected Pin outline');
    await waitFor(() => q('.details .detail-heading') && /素材详情/.test(q('.details .detail-heading').textContent), 'right column heading');
    if (q('[role="dialog"]')) throw new Error('a dialog opened for a single click');
    const detailText = q('.details').innerText;
    for (const piece of ['Pin 0', '来自 Pinterest', '在 Pinterest 打开', 'example.com', 'First line']) {
      if (!detailText.includes(piece)) throw new Error('right column misses ' + JSON.stringify(piece) + ': ' + detailText.slice(0, 200));
    }
    if (q('.details .tags, .details .add-tag, .details .prompt-tabs, .details [aria-label="收藏素材"]')) throw new Error('right column offers library operations for a Pin');
    // Collapsing the right column exposes the toolbar toggle, and clicking another Pin brings it back.
    q('.details .detail-heading button').click();
    await waitFor(() => !q('.details') && q('.toolbar .detail-toggle'), 'right column collapsed');
    qa('.pinterest-pin-card')[3].click();
    await waitFor(() => qa('.pinterest-pin-card.asset-selected').length === 1 && q('.details') && !/Pin 0|First line/.test(q('.details').innerText), 'selection moves to another Pin and reopens right column');

    // 4. Double click: shared viewer, "i / N" in the top bar.
    qa('.pinterest-pin-card')[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await waitFor(() => q('.image-viewer') && /1 \\/ 12/.test(toolbarTitle()), 'viewer with 1 / 12');
    if (q('.pinterest-pin-card')) throw new Error('Pin grid still mounted under the viewer');
    if (!qa('.toolbar-left button').some((button) => button.textContent.includes('返回'))) throw new Error('viewer top bar lacks 返回');
    key({ key: 'ArrowRight' });
    await waitFor(() => /2 \\/ 12/.test(toolbarTitle()), 'ArrowRight goes to 2 / 12');
    key({ key: 'ArrowLeft' });
    await waitFor(() => /1 \\/ 12/.test(toolbarTitle()), 'ArrowLeft goes back to 1 / 12');

    // Fullscreen + Esc: first Esc leaves fullscreen (must not bounce back on), second Esc exits the viewer.
    q('.viewer-controls button[title="全屏"]').click();
    await waitFor(() => q('.app.viewer-fullscreen'), 'viewer enters fullscreen');
    key({ key: 'Escape' });
    await waitFor(() => !q('.app.viewer-fullscreen') && q('.image-viewer'), 'first Esc leaves fullscreen only');
    await sleep(150);
    if (q('.app.viewer-fullscreen')) throw new Error('fullscreen bounced back on after Esc');

    // 5. Esc returns to the Pin grid, scroll position kept.
    key({ key: 'Escape' });
    await waitFor(() => !q('.image-viewer') && qa('.pinterest-pin-card').length === 12, 'Pin grid back after Esc');
    await waitFor(() => Math.abs(q('.pinterest-view').scrollTop - scrolledTo) <= 2, 'scroll position kept (' + scrolledTo + ')');
    const scrollAfter = q('.pinterest-view').scrollTop;
    // 返回 button route too.
    qa('.pinterest-pin-card')[1].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await waitFor(() => q('.image-viewer'), 'viewer again');
    qa('.toolbar-left button').find((button) => button.textContent.includes('返回')).click();
    await waitFor(() => !q('.image-viewer') && qa('.pinterest-pin-card').length === 12, 'Pin grid back after 返回');

    // 6. ‹ returns to the board list.
    q('.toolbar-left button[aria-label="后退"]').click();
    await waitFor(() => qa('.pinterest-board-card').length === 3 && !q('.toolbar .viewer-title') && !q('.details'), 'board list back');

    window.fetch = realFetch;
    return { gutters, scrolledTo, scrollAfter, pinterestCalls: pinterestCalls.length };
  })()
  `;
}
