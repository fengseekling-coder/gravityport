// GravityPort React UI flow: keyboard browsing in the gallery. Arrow keys
// move the inspected card, Enter opens the viewer, ⌘F / Ctrl+F focuses the
// search field, and Delete honours 不再提醒 like the menu's 移至回收站.
export const name = "gallery-keyboard";
export const description = "arrow keys move the inspected card -> Enter opens the viewer -> ⌘F/Ctrl+F focuses search -> Delete skips the confirmation once 不再提醒 is ticked";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const ids = [];
    for (const [index, color] of [[0, [74, 127, 181]], [1, [181, 127, 74]], [2, [127, 181, 74]], [3, [181, 74, 127]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`keys-${index}.png`, color, { width: 120, height: 120 }),
        prompt: `keyboard ${index}`,
      });
      ids.push(created.asset.id);
    }
    const result = await ctx.runInPage(server, pageSource(), { windowSize: [1440, 940] });
    const expected = ["arrowMoved", "arrowBack", "enterOpened", "findFocused", "firstDeleteAsked", "secondDeleteSkipped"];
    if (expected.some((key) => result?.[key] !== true)) {
      throw new Error(`gallery-keyboard: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function pageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length);
    }
    const press = (key, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const focused = () => document.querySelector('.asset-card.asset-selected')?.getAttribute('data-asset-id') || '';
    await waitFor(() => cards().length >= 4, 'four cards');

    // Arrows: start on the top-left card, step right, then back left.
    const ordered = cards().sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top
      || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    const first = ordered[0].getAttribute('data-asset-id');
    ordered[0].click();
    await waitFor(() => focused() === first, 'the first card focused');
    document.body.focus();
    press('ArrowRight');
    const moved = await waitFor(() => focused() && focused() !== first ? focused() : '', 'the arrow to move the focus');
    const arrowMoved = cards().find((card) => card.getAttribute('data-asset-id') === moved).getBoundingClientRect().left
      > ordered[0].getBoundingClientRect().left;
    press('ArrowLeft');
    const arrowBack = (await waitFor(() => focused() === first, 'the focus back on the first card')) === true;

    // Enter opens the viewer; Escape closes it again.
    press('Enter');
    const enterOpened = Boolean(await waitFor(() => document.querySelector('.image-viewer'), 'the viewer'));
    press('Escape');
    await waitFor(() => !document.querySelector('.image-viewer'), 'the viewer to close');

    // Find: ⌘F on macOS, Ctrl+F elsewhere.
    const mac = navigator.platform.startsWith('Mac');
    press('f', mac ? { metaKey: true } : { ctrlKey: true });
    const search = document.querySelector('input[aria-label="搜索素材"]');
    const findFocused = (await waitFor(() => document.activeElement === search, 'the search field focus')) === true;
    search.blur();

    // Delete: the first press asks; tick 不再提醒 and confirm; the next one moves straight to the Trash.
    const before = cards().length;
    cards()[0].click();
    await sleep(150);
    press('Delete');
    const modal = await waitFor(() => document.querySelector('.delete-modal'), 'the move-to-trash confirmation');
    const firstDeleteAsked = Boolean(modal);
    modal.querySelector('input[type="checkbox"]').click();
    Array.from(modal.querySelectorAll('button')).find((button) => button.textContent.trim() === '移至回收站').click();
    await waitFor(() => !document.querySelector('.delete-modal') && cards().length === before - 1, 'the first card in the Trash');
    cards()[0].click();
    await sleep(150);
    press('Delete');
    await waitFor(() => cards().length === before - 2, 'the second card in the Trash without a dialog');
    const secondDeleteSkipped = !document.querySelector('.delete-modal');
    return { arrowMoved, arrowBack, enterOpened, findFocused, firstDeleteAsked, secondDeleteSkipped };
  })()`;
}
