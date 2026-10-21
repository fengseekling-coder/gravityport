// GravityPort React UI flow (task 155): multi-selection in a gallery made of
// stack cards, as in a real library. ⌘-click adds to the inspected card, a
// Shift-click range and a marquee both include stack cards, and a batch
// move-to-trash takes every member of a selected stack (undo brings them all
// back). Right-clicking a stack card inside a multi-selection opens the batch
// menu, so its 移至回收站 takes the plain images too, and a selection with a
// stack still confirms after 不再提醒 while a plain move no longer does. A
// focused card never draws the focus-visible outline on top of its selection
// ring.
export const name = "stack-selection";
export const description = "stack gallery: ⌘-click adds to the inspected card -> Shift range and marquee include stacks -> batch trash takes whole stacks, undo restores -> right-click on a selected stack card trashes the whole selection, stacks confirm after 不再提醒 -> the focus the app falls back to after a trash move never joins a ⌘-click batch or answers Delete -> no focus outline on cards";

const STACKS = 3;
const STACK_SIZE = 2;
const PLAIN = 3;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const ids = [];
    for (let index = 0; index < STACKS * STACK_SIZE + PLAIN; index += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`stack-sel-${index}.png`, [40 + index * 20, 90, 160]), prompt: `stack selection ${index}`,
      });
      ids.push(created.asset.id);
    }
    for (let stack = 0; stack < STACKS; stack += 1) {
      const made = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
        projectId: "default", assetIds: ids.slice(stack * STACK_SIZE, (stack + 1) * STACK_SIZE),
      });
      if (!made?.stack?.id) throw new Error(`stack create failed: ${JSON.stringify(made)}`);
    }
    const total = STACKS * STACK_SIZE + PLAIN;
    const result = await ctx.runInPage(server, stackSelectionSource(total), { windowSize: [1440, 940] });
    if (result?.cmdAdded !== 2 || result?.rangeAll !== STACKS + PLAIN || result?.rangeStacks !== STACKS
      || result?.marqueeAll !== STACKS + PLAIN || result?.marqueeStacks !== STACKS
      || result?.trashed !== total || result?.restored !== true
      || result?.stackCardMenuHeading !== "已选 2 项" || result?.mixedConfirmed !== true || result?.mixedTrashed !== 1 + STACK_SIZE
      || result?.plainSkippedConfirm !== true || result?.plainTrashed !== 1
      || result?.implicitDeleteIgnored !== true || result?.implicitNotBatched !== true || result?.firstKept !== true
      || result?.focusOutline !== "none") {
      throw new Error(`stack-selection result: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function stackSelectionSource(total) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cards().length + ' | selected=' + selected().length
        + ' | trash=' + navSmall('回收站') + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    // DOM order is the gallery's list order while every card is mounted.
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const isStack = (card) => Boolean(card.querySelector('.stack-mark'));
    const selected = () => cards().filter((card) => card.classList.contains('asset-selected'));
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const click = (card, modifiers = {}) => card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...modifiers }));
    const escape = async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => selected().length <= 1, 'Escape drops the batch');
    };

    await waitFor(() => cards().length === ${STACKS + PLAIN} && cards().filter(isStack).length === ${STACKS}, 'stack gallery rendered');
    await sleep(400);
    const stackCards = () => cards().filter(isStack);

    // 1. Click one stack card, ⌘-click another: both stay selected.
    click(stackCards()[0]);
    await waitFor(() => selected().length === 1 && selected()[0] === stackCards()[0], 'first stack inspected');
    click(stackCards()[1], { metaKey: true });
    await waitFor(() => selected().length === 2, '⌘-click adds the second stack');
    const cmdAdded = selected().length;
    await escape();

    // 2. Click the first card, Shift-click the last: the range keeps stacks.
    click(cards()[0]);
    await waitFor(() => selected()[0] === cards()[0], 'range anchor');
    click(cards()[cards().length - 1], { shiftKey: true });
    await waitFor(() => selected().length === cards().length, 'Shift range covers every card');
    const rangeAll = selected().length;
    const rangeStacks = selected().filter(isStack).length;
    await escape();

    // 3. Marquee from the grid's top-left gutter corner over every card.
    const grid = document.querySelector('.asset-grid');
    const boxes = cards().map((card) => card.getBoundingClientRect());
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const start = { x: left + 2, y: bottom + 4 };
    const pressed = document.elementFromPoint(start.x, start.y);
    if (!grid.contains(pressed) || pressed.closest('.asset-card')) throw new Error('marquee start is not blank grid: ' + (pressed?.className || pressed?.tagName));
    const pointer = (target, type, x, y) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 21, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }));
    pointer(pressed, 'pointerdown', start.x, start.y);
    pointer(window, 'pointermove', right - 2, top + 2);
    await sleep(120);
    pointer(window, 'pointerup', right - 2, top + 2);
    await waitFor(() => selected().length === cards().length, 'marquee covers every card');
    const marqueeAll = selected().length;
    const marqueeStacks = selected().filter(isStack).length;

    // 4. Batch move-to-trash from the context menu takes whole stacks.
    selected()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'context menu');
    const trashItem = Array.from(document.querySelectorAll('.context-menu button')).find((entry) => entry.textContent.trim() === '移至回收站');
    if (!trashItem) throw new Error('batch menu has no 移至回收站');
    trashItem.click();
    await waitFor(() => document.querySelector('[role="alertdialog"]'), 'batch delete confirm');
    // Turn on 不再提醒 here; step 4b checks it skips plain moves only.
    const skip = document.querySelector('[role="alertdialog"] input[type="checkbox"]');
    if (!skip) throw new Error('delete confirm has no 不再提醒 checkbox');
    if (!skip.checked) skip.click();
    await waitFor(() => skip.checked, '不再提醒 checked');
    Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === '移至回收站').click();
    await waitFor(() => navSmall('回收站') === '${total}', 'every stack member in the trash');
    const trashed = Number(navSmall('回收站'));
    const undo = await waitFor(() => document.querySelector('.toast .toast-action'), 'undo action');
    undo.click();
    await waitFor(() => navSmall('回收站') === '0' && cards().filter(isStack).length === ${STACKS}, 'undo restores every member');
    const restored = true;

    // 4b. One plain image plus one stack, right-clicked on the stack card:
    // the batch menu opens and trashes both, and the stack still confirms.
    const plainCards = () => cards().filter((card) => !isStack(card));
    const menuButton = (label) => Array.from(document.querySelectorAll('.context-menu button')).find((entry) => entry.textContent.trim() === label);
    await escape();
    click(plainCards()[0]);
    await waitFor(() => selected().length === 1 && selected()[0] === plainCards()[0], 'plain card inspected');
    const mixedStack = stackCards()[0];
    click(mixedStack, { metaKey: true });
    await waitFor(() => selected().length === 2, '⌘-click adds a stack to the plain card');
    mixedStack.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'stack card menu inside the selection');
    const stackCardMenuHeading = document.querySelector('.context-menu .menu-heading')?.textContent?.trim() || '';
    if (menuButton('重命名堆叠')) throw new Error('a stack card inside a multi-selection still opened the single-stack menu');
    menuButton('移至回收站').click();
    await waitFor(() => document.querySelector('[role="alertdialog"]'), 'a selection with a stack confirms despite 不再提醒');
    const mixedConfirmed = true;
    Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === '移至回收站').click();
    await waitFor(() => navSmall('回收站') === String(1 + ${STACK_SIZE}), 'the plain image and every stack member in the trash');
    const mixedTrashed = Number(navSmall('回收站'));
    (await waitFor(() => document.querySelector('.toast .toast-action'), 'mixed undo action')).click();
    await waitFor(() => navSmall('回收站') === '0', 'undo restores the mixed selection');

    // 4c. A plain-only move honours 不再提醒: no dialog, straight to the trash.
    await escape();
    await waitFor(() => plainCards().length === ${PLAIN}, 'plain cards back after undo');
    click(plainCards()[0]);
    await waitFor(() => selected().length === 1 && selected()[0] === plainCards()[0], 'plain card selected again');
    plainCards()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'plain card menu');
    menuButton('移至回收站').click();
    await waitFor(() => navSmall('回收站') === '1', 'plain move skips the confirm');
    const plainSkippedConfirm = !document.querySelector('[role="alertdialog"]');
    const plainTrashed = Number(navSmall('回收站'));
    (await waitFor(() => document.querySelector('.toast .toast-action'), 'plain undo action')).click();
    await waitFor(() => navSmall('回收站') === '0', 'undo restores the plain image');

    // 4d. After a trash move the focus falls back to the first card on its
    // own. That card must not ride along: Delete with nothing picked does
    // nothing, and a ⌘-click batch starts from the clicked card alone (it used
    // to sweep the newest card, out of sight at the top, into the trash).
    await escape();
    await waitFor(() => plainCards().length === ${PLAIN}, 'plain cards back after the plain undo');
    const victim = plainCards().find((card) => card !== cards()[0]);
    click(victim);
    await waitFor(() => selected().length === 1 && selected()[0] === victim, 'victim selected');
    victim.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'victim menu');
    menuButton('移至回收站').click();
    await waitFor(() => navSmall('回收站') === '1', 'victim in the trash');
    const firstId = await waitFor(() => selected().length === 1 && selected()[0] === cards()[0]
      ? cards()[0].getAttribute('data-asset-id') : '', 'focus falls back to the first card');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await sleep(600);
    const implicitDeleteIgnored = navSmall('回收站') === '1' && !document.querySelector('[role="alertdialog"]')
      && cards()[0].getAttribute('data-asset-id') === firstId;
    const target = cards().find((card, index) => index > 0 && !isStack(card));
    if (!target) throw new Error('no plain card left to ⌘-click: Delete trashed the implicit first card');
    click(target, { metaKey: true });
    await sleep(300);
    const implicitNotBatched = selected().length === 1 && selected()[0] === target;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
    await waitFor(() => navSmall('回收站') === '2', 'only the ⌘-clicked card joins the trash');
    await sleep(300);
    const firstKept = cards()[0]?.getAttribute('data-asset-id') === firstId && navSmall('回收站') === '2';

    // 5. A focused card never draws the focus-visible outline: the generic
    // button:focus-visible ring (same color, 3px out) doubled the selection
    // ring after any key press. Synthetic input cannot enter :focus-visible,
    // so check the rule that cancels it, and that it beats the generic one.
    const rules = Array.from(document.styleSheets).flatMap((sheet) => { try { return Array.from(sheet.cssRules); } catch { return []; } });
    const cardRule = rules.find((rule) => (rule.selectorText || '').split(',').some((part) => part.trim() === '.app .asset-card:focus-visible'));
    const focusOutline = cardRule ? cardRule.style.outlineStyle : 'missing';

    return { cmdAdded, rangeAll, rangeStacks, marqueeAll, marqueeStacks, trashed, restored,
      stackCardMenuHeading, mixedConfirmed, mixedTrashed, plainSkippedConfirm, plainTrashed,
      implicitDeleteIgnored, implicitNotBatched, firstKept, focusOutline };
  })()`;
}
