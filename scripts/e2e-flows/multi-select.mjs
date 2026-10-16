// GravityPort React UI flow: modifier multi-select, marquee selection and
// select-all drive real batch mutations through the context menu.
export const name = "multi-select";
export const description = "ctrl-click multi-select -> batch trash via context menu -> marquee selects a region -> batch favorite -> select-all and Escape";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    for (const file of ["multi-a.png", "multi-b.png", "multi-c.png"]) {
      await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(file, [74, 127, 181]), prompt: "multi select flow",
      });
    }
    const result = await ctx.runInPage(server, multiSelectSource());
    if (result?.multiSelected !== 2 || result?.batchTrashMoved !== 2 || result?.marqueeSelected !== 2 || result?.nativeSelectionCleared !== true
      || result?.batchFavorited !== true || result?.selectAllCount < 1 || result?.escapeCleared !== true) {
      throw new Error(`multi-select result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function multiSelectSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      let stable = 0;
      while (Date.now() < deadline) {
        const value = check();
        if (value) { stable += 1; if (stable >= 2) return value; } else stable = 0;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | selected=' + document.querySelectorAll('.asset-card.asset-selected').length
        + ' | labels=' + JSON.stringify(cards().map((c) => (c.getAttribute('aria-label') || '').slice(8, 24)))
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const plain = () => cards().filter((card) => !card.querySelector('.stack-mark'));
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    function clickCard(card, modifiers = {}) {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    }
    function contextMenuOn(card) {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      return waitFor(() => document.querySelector('.context-menu'), 'context menu');
    }
    function menuLabel(label) {
      const item = Array.from(document.querySelectorAll('.context-menu button')).find((entry) => entry.textContent.trim() === label);
      if (!item) throw new Error('missing menu item ' + label);
      return item;
    }

    await waitFor(() => plain().length === 3, 'three seeded cards');

    // Click one card, ctrl-click another: the ring renders on both.
    clickCard(plain()[0]);
    clickCard(plain()[1], { ctrlKey: true });
    await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'two selected rings');
    const multiSelected = document.querySelectorAll('.asset-card.asset-selected').length;

    // The context menu acts on the whole selection: one confirm, two rows trash.
    await contextMenuOn(plain()[1]);
    menuLabel('移至回收站').click();
    await waitFor(() => Boolean(document.querySelector('[role="alertdialog"]')), 'batch delete confirm');
    const confirm = Array.from(document.querySelectorAll('[role="alertdialog"] button'))
      .find((button) => button.textContent.trim() === '移至回收站');
    confirm.click();
    await waitFor(() => navSmall('回收站') === '2', 'batch trash count');
    const batchTrashMoved = Number(navSmall('回收站'));

    // Restore both through the Trash scope, then exercise the marquee.
    const trashNav = Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === '回收站'));
    trashNav.click();
    await waitFor(() => cards().length === 2, 'trash scope lists two');
    for (const _ of [0, 1]) {
      const card = document.querySelector('.asset-card');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
      const item = await waitFor(() => Array.from(document.querySelectorAll('.context-menu button'))
        .find((entry) => entry.textContent.trim() === '恢复') || null, 'restore item');
      item.click();
      await sleep(700);
    }
    await waitFor(() => navSmall('回收站') === '0', 'trash emptied again');
    const allNav = Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === '所有素材'));
    allNav.click();
    await waitFor(() => plain().length === 3, 'three back in the all view');

    // Marquee: press in the gutter between the second and third card of the
    // first row (found by real hit-testing, so a card covering the gutter
    // fails here) and sweep left over the first two cards.
    const grid = document.querySelector('.asset-grid');
    const row = plain().map((card) => card.getBoundingClientRect()).sort((a, b) => a.left - b.left);
    if (row.length !== 3 || row.some((box) => Math.abs(box.top - row[0].top) > 1)) {
      throw new Error('marquee fixture expects three cards in one row: ' + JSON.stringify(row.map((box) => [box.left, box.top])));
    }
    const gutter = row[2].left - row[1].right;
    const x0 = (row[1].right + row[2].left) / 2;
    const y0 = row[1].top + row[1].height / 2;
    const x1 = row[0].left + row[0].width / 2;
    const y1 = row[0].bottom + 40;
    const pressed = document.elementFromPoint(x0, y0);
    if (Math.round(gutter) !== 8 || !grid.contains(pressed) || pressed.closest('.asset-card')) {
      throw new Error('gallery gutter is not an 8px blank strip: ' + JSON.stringify({ gutter, pressed: pressed?.className || pressed?.tagName }));
    }
    // A leftover native selection over the cards must not survive the marquee
    // (the browser paints it in DOM order, unrelated to the masonry).
    window.getSelection().selectAllChildren(grid);
    const nativeSelectionPlanted = !window.getSelection().isCollapsed;
    pressed.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 7, button: 0, clientX: x0, clientY: y0 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: 7, clientX: x1, clientY: y1 }));
    await sleep(120);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 7, clientX: x1, clientY: y1 }));
    await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'marquee selects two');
    const marqueeSelected = document.querySelectorAll('.asset-card.asset-selected').length;
    const nativeSelectionCleared = nativeSelectionPlanted && window.getSelection().isCollapsed
      && getComputedStyle(grid).userSelect === 'none';

    // Batch favorite through the context menu on the marquee selection.
    plain()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 300 }));
    await waitFor(() => document.querySelector('.context-menu'), 'menu for batch favorite');
    menuLabel('收藏').click();
    await waitFor(() => navSmall('收藏') === '2', 'batch favorite count');
    const batchFavorited = navSmall('收藏') === '2';

    // Select-all and Escape. The batch refresh re-selects the first card when
    // it lands, so let the reload settle before the keyboard part.
    await sleep(900);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length >= 2, 'select-all marks cards');
    const selectAllCount = document.querySelectorAll('.asset-card.asset-selected').length;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 0, 'Escape clears selection');
    const escapeCleared = document.querySelectorAll('.asset-card.asset-selected').length === 0;

    return { multiSelected, batchTrashMoved, marqueeSelected, nativeSelectionCleared, batchFavorited, selectAllCount, escapeCleared };
  })()
  `;
}
