// GravityPort React UI flow (task 155): marquee gesture ownership in a full
// gallery, left mouse only. A press in the 8px gutter or on an unselected card
// sweeps a marquee; a press on a selected card starts a card drag; Shift-drag
// from a card is an additive marquee whose trailing click is not a Shift-click
// range; a sweep held at the bottom edge auto-scrolls and reaches cards that
// started below the fold.
export const name = "marquee-select";
export const description = "gutter marquee -> unselected-card press is a marquee -> selected-card press is a card drag -> Shift-drag on a card adds to the selection without a range click -> bottom-edge sweep auto-scrolls past the fold";

const SEED_TOTAL = 60;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("marquee-fixture.png", [74, 127, 181]);
    for (let round = 0; round < SEED_TOTAL / 6; round += 1) {
      await Promise.all(Array.from({ length: 6 }, (_, index) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: `marquee flow ${round * 6 + index}`,
        })));
    }
    const result = await ctx.runInPage(server, marqueeSource(), { windowSize: [1440, 940] });
    if (result?.gutterSelected !== 2 || result?.cardSweepGhost !== false || result?.cardSweepRect !== true || result?.cardSweepSelected !== true
      || result?.cardDragGhost !== true || result?.cardDragMarquee !== false
      || result?.shiftSelected !== 3 || result?.shiftClickConsumed !== true || result?.shiftDragGhost !== false
      || !(result?.scrolled > 0) || result?.reachedBelowFold !== true) {
      throw new Error(`marquee-select result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function marqueeSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cards().length + ' | selected=' + selectedIds().length);
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected')).map((card) => card.dataset.assetId);
    const grid = () => document.querySelector('.asset-grid');
    const pointer = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra,
    }));
    const clearSelection = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Escape drops the batch; the inspected card may stay highlighted.
      await waitFor(() => selectedIds().length <= 1, 'selection cleared');
    };
    const center = (box) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

    await waitFor(() => cards().length >= ${SEED_TOTAL}, 'all cards rendered');
    await sleep(400);
    // Rows by on-screen position (the masonry DOM order is not the visual order).
    const boxes = cards().map((card) => ({ id: card.dataset.assetId, box: card.getBoundingClientRect() }));
    const firstTop = Math.min(...boxes.map((entry) => entry.box.top));
    const row0 = boxes.filter((entry) => Math.abs(entry.box.top - firstTop) < 1).sort((a, b) => a.box.left - b.box.left);
    if (row0.length < 4) throw new Error('need four columns, got ' + row0.length);
    const cardAt = (entry) => document.querySelector('.asset-card[data-asset-id="' + entry.id + '"]');

    // 1. Gutter between columns 2 and 3, sweep left over columns 1-2.
    const gx = (row0[1].box.right + row0[2].box.left) / 2;
    const gy = center(row0[1].box).y;
    const gutterTarget = document.elementFromPoint(gx, gy);
    if (!grid().contains(gutterTarget) || gutterTarget.closest('.asset-card')) throw new Error('gutter press hit a card');
    pointer(gutterTarget, 'pointerdown', gx, gy);
    pointer(window, 'pointermove', center(row0[0].box).x, center(row0[0].box).y + 10);
    await sleep(80);
    pointer(window, 'pointerup', center(row0[0].box).x, center(row0[0].box).y + 10);
    await waitFor(() => selectedIds().length === 2, 'gutter marquee selects two');
    const gutterSelected = selectedIds().filter((id) => id === row0[0].id || id === row0[1].id).length;
    await clearSelection();

    // 2a. A plain press on an UNSELECTED card sweeps a marquee (left mouse
    // only, no modifier): from column 4 left over column 3.
    const sweepFrom = center(row0[3].box);
    const sweepTo = center(row0[2].box);
    pointer(cardAt(row0[3]), 'pointerdown', sweepFrom.x, sweepFrom.y);
    pointer(window, 'pointermove', sweepTo.x, sweepTo.y);
    await sleep(120);
    const cardSweepGhost = document.body.classList.contains('gp-card-dragging');
    const cardSweepRect = Boolean(document.querySelector('.marquee-rect'));
    pointer(window, 'pointerup', sweepTo.x, sweepTo.y);
    // The click a real browser fires after the release must not reselect.
    cardAt(row0[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: sweepTo.x, clientY: sweepTo.y, detail: 1 }));
    await sleep(300);
    const sweepIds = selectedIds();
    const cardSweepSelected = sweepIds.length === 2 && sweepIds.includes(row0[2].id) && sweepIds.includes(row0[3].id);
    await clearSelection();

    // 2b. A press on a SELECTED card is a card drag, never a marquee.
    cardAt(row0[3]).click();
    await waitFor(() => cardAt(row0[3]).classList.contains('asset-selected'), 'drag source selected');
    const dragFrom = center(row0[3].box);
    pointer(cardAt(row0[3]), 'pointerdown', dragFrom.x, dragFrom.y);
    pointer(window, 'pointermove', dragFrom.x + 30, dragFrom.y + 30);
    await sleep(120);
    const cardDragGhost = document.body.classList.contains('gp-card-dragging');
    const cardDragMarquee = Boolean(document.querySelector('.marquee-rect'));
    pointer(window, 'pointercancel', dragFrom.x + 30, dragFrom.y + 30);
    await waitFor(() => !document.body.classList.contains('gp-card-dragging'), 'card drag cancelled');
    await clearSelection();

    // 3. Select a card in another row, then Shift-drag from column 2 to 3 on
    // the first row: the base stays, both swept cards join, and the click the
    // browser fires after the release is not a Shift-click range.
    const below = boxes.filter((entry) => entry.box.top > row0[0].box.bottom + 2).sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left)[0];
    cardAt(below).click();
    await waitFor(() => selectedIds().length === 1 || document.querySelector('.asset-card.asset-selected'), 'base card selected');
    const shiftFrom = center(row0[1].box);
    const shiftTo = center(row0[2].box);
    pointer(cardAt(row0[1]), 'pointerdown', shiftFrom.x, shiftFrom.y, { shiftKey: true });
    pointer(window, 'pointermove', shiftTo.x, shiftTo.y, { shiftKey: true });
    await sleep(80);
    const shiftDragGhost = document.body.classList.contains('gp-card-dragging');
    pointer(window, 'pointerup', shiftTo.x, shiftTo.y, { shiftKey: true });
    cardAt(row0[2]).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true, clientX: shiftTo.x, clientY: shiftTo.y, detail: 1 }));
    await sleep(300);
    const shiftIds = selectedIds();
    const shiftSelected = shiftIds.length;
    const shiftClickConsumed = shiftIds.includes(below.id) && shiftIds.includes(row0[1].id) && shiftIds.includes(row0[2].id);
    await clearSelection();

    // 4. Sweep from the first-row gutter and hold the pointer at the grid's
    // bottom edge: the gallery auto-scrolls and the sweep reaches a card in
    // column 2 that started below the fold.
    const g = grid();
    const gridBox = g.getBoundingClientRect();
    const belowFold = boxes.filter((entry) => Math.abs(entry.box.left - row0[1].box.left) < 1 && entry.box.top > gridBox.bottom).map((entry) => entry.id);
    if (!belowFold.length) throw new Error('fixture has nothing below the fold');
    const startScroll = g.scrollTop;
    const ax = (row0[0].box.right + row0[1].box.left) / 2;
    const scrollTarget = document.elementFromPoint(ax, gy);
    pointer(scrollTarget, 'pointerdown', ax, gy);
    pointer(window, 'pointermove', center(row0[1].box).x, gridBox.bottom - 4);
    await waitFor(() => g.scrollTop - startScroll > 300, 'marquee auto-scroll', 8000);
    await sleep(200);
    pointer(window, 'pointerup', center(row0[1].box).x, gridBox.bottom - 4);
    await sleep(200);
    const scrolled = g.scrollTop - startScroll;
    const finalIds = selectedIds();
    const reachedBelowFold = belowFold.some((id) => finalIds.includes(id));
    return { gutterSelected, cardSweepGhost, cardSweepRect, cardSweepSelected, cardDragGhost, cardDragMarquee, shiftSelected, shiftClickConsumed, shiftDragGhost, scrolled, reachedBelowFold, rowWidth: row0.length };
  })()`;
}
