// GravityPort React UI flow (task 156): ⌘A and multi-card drags in a gallery
// made of stack cards. ⌘A selects stack cards too — including stacks on pages
// the grid has not loaded — and dragging that selection onto a sidebar group
// and batch move-to-trash both treat every stack as a whole (undo restores
// all members). A hand-picked selection of stacks and a plain card drags onto
// a group, and out of the window it hands the system drag every member path,
// in selection order with each stack expanded in its own order. A selection
// carrying stacks dropped on a plain card merges into a new stack (task 196).
export const name = "stack-select-all-drag";
export const description = "30 stacks behind 110 plain cards -> ⌘A selects all 140 cards across pages -> drag to a group moves all 170 assets -> ⌘A + Delete trashes 170, undo restores -> stacks + plain card drag to a group -> drag-out hands every member path in order -> stacks + a card merge onto a plain card";

const STACKS = 30;
const STACK_SIZE = 2;
const PLAIN = 110;
const KEEP_PLAIN = 5;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (index) => (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`ssad-${index}.png`, [20 + (index % 200), 60 + (index % 7) * 20, 140]),
      prompt: `stack select all ${index}`,
    })).asset.id;
    const inParallel = async (count, offset) => {
      const ids = [];
      for (let start = 0; start < count; start += 6) {
        const batch = Array.from({ length: Math.min(6, count - start) }, (_, i) => create(offset + start + i));
        ids.push(...await Promise.all(batch));
      }
      return ids;
    };
    // Stacks first, plain cards after: the newest-first gallery shows 100
    // plain cards on its first page and keeps every stack on later pages.
    const memberIds = await inParallel(STACKS * STACK_SIZE, 0);
    const stackIds = [];
    for (let stack = 0; stack < STACKS; stack += 1) {
      const made = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
        projectId: "default", assetIds: memberIds.slice(stack * STACK_SIZE, (stack + 1) * STACK_SIZE),
      });
      if (!made?.stack?.id) throw new Error(`stack create failed: ${JSON.stringify(made)}`);
      stackIds.push(made.stack.id);
    }
    const plainIds = await inParallel(PLAIN, STACKS * STACK_SIZE);
    const allGroup = `全选分组-${Date.now().toString(36)}`;
    const dragGroup = `拖放分组-${Date.now().toString(36)}`;
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: allGroup });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: dragGroup });
    const total = STACKS * STACK_SIZE + PLAIN;
    const cards = STACKS + PLAIN;

    // ── Part 1: cross-page ⌘A ──
    const first = await ctx.runInPage(server, selectAllSource({ cards, total, allGroup }), { windowSize: [1440, 940] });
    if (first?.firstPageStacks !== 0 || first?.selectedToast !== true || first?.groupToast !== true
      || first?.trashed !== total || first?.restored !== true) {
      throw new Error(`stack-select-all-drag part 1: ${JSON.stringify(first)}`);
    }
    const memberGroups = async (stackId) => ((await ctx.api(server.origin, "GET", `/api/asset-stacks/${stackId}/assets?project=default&limit=250`)).assets || [])
      .map((asset) => ({ id: asset.id, group: asset.group || "", path: asset.image_path || "" }));
    for (const stackId of stackIds) {
      const members = await memberGroups(stackId);
      if (members.length !== STACK_SIZE || members.some((member) => member.group !== allGroup)) {
        throw new Error(`stack ${stackId} members not all in ${allGroup}: ${JSON.stringify(members)}`);
      }
    }
    const rootList = async () => (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250&view=gallery")).assets || [];
    const plainGroups = (await rootList()).filter((asset) => !asset.stack);
    if (plainGroups.length !== PLAIN || plainGroups.some((asset) => (asset.group || "") !== allGroup)) {
      throw new Error(`plain cards not all in ${allGroup}: ${plainGroups.length} plain, groups ${JSON.stringify([...new Set(plainGroups.map((asset) => asset.group || ""))])}`);
    }
    const trash = await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=1");
    if ((trash.page?.total ?? -1) !== 0) throw new Error(`trash still holds ${trash.page?.total} after undo`);

    // ── Part 2: hand-picked drags in a gallery that fits on one page ──
    const keep = plainIds.slice(-KEEP_PLAIN);
    const drop = plainIds.slice(0, PLAIN - KEEP_PLAIN);
    await ctx.api(server.origin, "POST", "/api/assets/batch", { action: "trash", projectId: "default", assetIds: drop });
    const second = await ctx.runInPage(server, dragSource({ cards: STACKS + KEEP_PLAIN, stacks: STACKS, dragGroup }), { windowSize: [1440, 940] });
    if (second?.groupToast !== true || !Array.isArray(second?.draggedPaths) || second?.mergeMade !== true) {
      throw new Error(`stack-select-all-drag part 2: ${JSON.stringify(second)}`);
    }
    // Server truth for the group drop: both stacks whole, the plain card, and
    // nothing else.
    const root = await rootList();
    const coverOf = new Map(root.filter((asset) => asset.stack).map((asset) => [asset.id, asset.stack.id]));
    const [groupStackA, groupStackB] = second.groupCards.slice(0, 2).map((id) => coverOf.get(id));
    for (const stackId of [groupStackA, groupStackB]) {
      const members = await memberGroups(stackId);
      if (members.some((member) => member.group !== dragGroup)) throw new Error(`dragged stack ${stackId} not whole in ${dragGroup}: ${JSON.stringify(members)}`);
    }
    const plainAfter = root.find((asset) => asset.id === second.groupCards[2]);
    if ((plainAfter?.group || "") !== dragGroup) throw new Error(`dragged plain card not in ${dragGroup}`);
    const strays = root.filter((asset) => (asset.group || "") === dragGroup && !second.groupCards.includes(asset.id));
    if (strays.length) throw new Error(`cards outside the drag joined ${dragGroup}: ${strays.map((asset) => asset.id)}`);
    // Drag-out order: selection order, each stack expanded in stack order.
    const expected = [];
    for (const id of second.outCards) {
      const stackId = coverOf.get(id);
      if (stackId) expected.push(...(await memberGroups(stackId)).map((member) => member.path));
      else expected.push(root.find((asset) => asset.id === id)?.image_path || "");
    }
    if (JSON.stringify(second.draggedPaths) !== JSON.stringify(expected)) {
      throw new Error(`drag-out paths ${JSON.stringify(second.draggedPaths)} != ${JSON.stringify(expected)}`);
    }
    if (new Set(root.filter((asset) => asset.stack).map((asset) => asset.stack.id)).size !== STACKS) {
      throw new Error("a drag with stacks changed the stack set");
    }
    return { ...first, ...second, draggedPaths: second.draggedPaths.length };
  } finally {
    await server.stop();
  }
}

const pageHelpers = `
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | loaded=' + loadedCount() + ' | cards=' + cards().length
        + ' | selected=' + selected().length + ' | trash=' + navSmall('回收站') + ' | toast=' + toastText());
    }
    const loadedCount = () => Number(document.querySelector('.asset-grid')?.dataset.loadedAssets || 0);
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const isStack = (card) => Boolean(card.querySelector('.stack-mark'));
    const selected = () => cards().filter((card) => card.classList.contains('asset-selected'));
    const toastText = () => document.querySelector('.toast')?.textContent || '';
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const click = (card, modifiers = {}) => card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...modifiers }));
    const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const centerOf = (el) => { const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const DRAG_ID = 31;
    const pointer = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: DRAG_ID, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra,
    }));
    // Press a selected card and walk to the target's center in a few steps;
    // the release resolves the drop synchronously.
    async function dragTo(fromEl, targetEl, beforeRelease) {
      const from = centerOf(fromEl);
      pointer(fromEl, 'pointerdown', from.x, from.y);
      await sleep(40);
      const to = centerOf(targetEl);
      for (let i = 1; i <= 6; i += 1) {
        pointer(window, 'pointermove', from.x + (to.x - from.x) * i / 6, from.y + (to.y - from.y) * i / 6);
        await sleep(40);
      }
      const again = centerOf(targetEl);
      pointer(window, 'pointermove', again.x, again.y);
      await sleep(150);
      const checked = beforeRelease ? beforeRelease() : undefined;
      pointer(window, 'pointerup', again.x, again.y);
      await sleep(60);
      click(fromEl);
      return checked;
    }
    const groupRow = (name) => document.querySelector('[data-drop-group="' + name + '"]');
    async function clearAll() {
      let empty = 0;
      for (let i = 0; i < 60 && empty < 3; i += 1) {
        if (selected().length) { empty = 0; escape(); } else empty += 1;
        await sleep(100);
      }
    }
`;

function selectAllSource({ cards: cardTotal, total, allGroup }) {
  return `(async () => {
    ${pageHelpers}
    const pressSelectAll = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }));
    await waitFor(() => loadedCount() === 100 && cards().length > 0, 'first page loaded');
    await sleep(400);
    // Every stack sits beyond the loaded page: the batch can only know them
    // through the cross-page fetch.
    const firstPageStacks = cards().filter(isStack).length;

    // 1. ⌘A picks every card of the result, stacks included.
    pressSelectAll();
    await waitFor(() => toastText().includes('已选 ${cardTotal} 项'), '⌘A selects all ${cardTotal} cards');
    const selectedToast = true;

    // 2. Drag the selection onto a sidebar group: every stack moves whole.
    await waitFor(() => groupRow(${JSON.stringify(allGroup)}), 'group row');
    await dragTo(selected()[0], groupRow(${JSON.stringify(allGroup)}));
    await waitFor(() => toastText().includes('已把 ${cardTotal} 项移到'), 'group drop of the whole selection');
    const groupToast = true;
    await sleep(600);

    // 3. ⌘A again, Delete: every stack member goes to the trash; undo.
    pressSelectAll();
    await waitFor(() => toastText().includes('已选 ${cardTotal} 项'), 'second ⌘A');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await waitFor(() => document.querySelector('[role="alertdialog"]'), 'batch delete confirm');
    Array.from(document.querySelectorAll('[role="alertdialog"] button')).find((button) => button.textContent.trim() === '移至回收站').click();
    await waitFor(() => navSmall('回收站') === '${total}', 'every stack member in the trash', 45000);
    const trashed = Number(navSmall('回收站'));
    const undo = await waitFor(() => document.querySelector('.toast .toast-action'), 'undo action');
    undo.click();
    await waitFor(() => navSmall('回收站') === '0', 'undo restores every member', 45000);
    const restored = true;
    return { firstPageStacks, selectedToast, groupToast, trashed, restored };
  })()`;
}

function dragSource({ cards: cardTotal, stacks, dragGroup }) {
  return `(async () => {
    ${pageHelpers}
    await waitFor(() => cards().length === ${cardTotal} && cards().filter(isStack).length === ${stacks}, 'one-page gallery rendered');
    await sleep(400);
    const stackCards = () => cards().filter(isStack);
    const plainCards = () => cards().filter((card) => !isStack(card));
    const idOf = (card) => card.dataset.assetId;
    // A click landing while the freshly opened gallery still settles can be
    // lost; re-click like a user would, and report every re-click.
    const clickRetries = [];
    const selectCards = async (list) => {
      await clearAll();
      for (let attempt = 1; ; attempt += 1) {
        click(list[0]);
        try {
          await waitFor(() => selected().length === 1 && selected()[0] === list[0], 'first card inspected', 3000);
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
          clickRetries.push(idOf(list[0]) + ' attempt ' + attempt);
        }
      }
      for (const card of list.slice(1)) click(card, { metaKey: true });
      await waitFor(() => selected().length === list.length, list.length + ' cards selected');
    };

    // 1. Two stacks and a plain card onto a group row.
    const groupCards = [stackCards()[0], stackCards()[1], plainCards()[0]];
    const groupIds = groupCards.map(idOf);
    await selectCards(groupCards);
    await dragTo(groupCards[0], groupRow(${JSON.stringify(dragGroup)}));
    await waitFor(() => toastText().includes('已把 3 项移到'), 'group drop of stacks + plain');
    const groupToast = true;
    await sleep(600);

    // 2. Out of the window: the system drag gets every member path.
    window.__draggedPaths = null;
    window.electronAPI = { startNativeDrag: async (paths) => { window.__draggedPaths = paths; return { ok: true }; } };
    const outCards = [stackCards()[2], plainCards()[1], stackCards()[3]];
    const outIds = outCards.map(idOf);
    await selectCards(outCards);
    const from = centerOf(outCards[0]);
    pointer(outCards[0], 'pointerdown', from.x, from.y);
    await sleep(40);
    pointer(window, 'pointermove', from.x + 24, from.y + 24, { screenX: window.screenX + from.x + 24, screenY: window.screenY + from.y + 24 });
    await sleep(40);
    pointer(window, 'pointermove', window.innerWidth + 200, from.y, { screenX: window.screenX + window.outerWidth + 200, screenY: window.screenY + from.y });
    const draggedPaths = await waitFor(() => window.__draggedPaths, 'native drag paths');
    pointer(window, 'pointerup', window.innerWidth + 200, from.y);
    delete window.electronAPI;
    await sleep(300);

    // 3. A selection with stacks merges onto a plain card: the dragged stack
    // dissolves into a new stack, so the count comes back to the same number
    // once the gallery reloads (highlight timing is stack-merge-drag's job).
    const mergeCards = [stackCards()[4], plainCards()[2]];
    await selectCards(mergeCards);
    await dragTo(mergeCards[1], plainCards()[3]);
    await waitFor(() => toastText().includes('已堆叠'), 'merge toast');
    const mergeMade = Boolean(await waitFor(() => stackCards().length === ${stacks}, 'stack count settles after the merge', 10000).catch(() => false));
    return { groupToast, groupCards: groupIds, outCards: outIds, draggedPaths, mergeMade, clickRetries };
  })()`;
}
