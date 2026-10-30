// GravityPort React UI flow (task 304): 待整理 holds what is not organized. An
// automatic stack shows there as one card (automatic stacks do not count as
// organized), while a manual stack, a favorite and anything else organized
// stay out. 标为已整理 on a stack card empties it and the sidebar count drops
// by the stack size; undo brings it back. A multi-selection that holds a stack
// and a loose card marks both at once and the inbox shows its empty state.
export const name = "unsorted-inbox";
export const description = "待整理: an automatic stack shows as one card, manual stacks and favorites stay out -> 标为已整理 on the stack card drops the sidebar count by its size, undo restores -> a multi-selection with a stack marks everything and the inbox shows the new empty-state copy";

const SESSION_ID = "e2e-unsorted-304";
const AUTO_SIZE = 3;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (fileName, prompt, source, color) => {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(fileName, color),
        prompt,
        source,
      });
      return created.asset.id;
    };
    // Three captures sharing one generation session form an automatic stack.
    const autoIds = [];
    for (let index = 0; index < AUTO_SIZE; index += 1) {
      autoIds.push(await create(`unsorted-auto-${index}.png`, `unsorted auto ${index}`, {
        type: "codex-generated",
        generation_session_id: SESSION_ID,
      }, [30 + index * 40, 110, 200]));
    }
    // Two plain assets stacked by hand are organized, so they stay out.
    const manualIds = [
      await create("unsorted-manual-0.png", "unsorted manual 0", { type: "local-file" }, [200, 90, 40]),
      await create("unsorted-manual-1.png", "unsorted manual 1", { type: "local-file" }, [210, 100, 50]),
    ];
    const made = await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: manualIds });
    if (made?.stack?.origin !== "manual") throw new Error(`manual stack create failed: ${JSON.stringify(made)}`);
    // One favorite and one plain loose asset.
    const favoriteId = await create("unsorted-favorite.png", "unsorted favorite", { type: "local-file" }, [60, 180, 90]);
    await ctx.api(server.origin, "POST", "/api/assets/batch", { action: "favorite", projectId: "default", assetIds: [favoriteId], favorite: true });
    const looseId = await create("unsorted-loose.png", "unsorted loose", { type: "local-file" }, [120, 60, 180]);

    const result = await ctx.runInPage(server, unsortedSource(), { windowSize: [1440, 940] });
    const checks = {
      inboxShowsStackAndLoose: result?.inboxCards === 2 && result?.inboxStacks === 1,
      sidebarCountBefore: result?.navBefore === AUTO_SIZE + 1,
      stackMarkedLeavesInbox: result?.inboxCardsAfterStack === 1 && result?.inboxStacksAfterStack === 0,
      sidebarCountDrops: result?.navAfterStack === 1,
      undoRestoresStack: result?.navAfterUndo === AUTO_SIZE + 1 && result?.inboxStacksAfterUndo === 1,
      multiSelectEmptiesInbox: result?.navAfterMulti === 0 && result?.emptyStateCopy === true,
    };
    if (Object.values(checks).some((value) => value !== true)) {
      throw new Error(`unsorted-inbox page result: ${JSON.stringify(result)}`);
    }

    // Server truth: nothing is left unorganized, and the manual stack and the
    // favorite are still there.
    const inbox = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250&unorganized=1");
    if ((inbox.assets || []).length !== 0) {
      throw new Error(`待整理 still holds ${JSON.stringify((inbox.assets || []).map((asset) => asset.id))}`);
    }
    const all = (await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const byId = new Map(all.map((asset) => [asset.id, asset]));
    const manualStill = manualIds.every((id) => byId.has(id));
    const favoriteStill = Boolean(byId.get(favoriteId)?.favorite);
    if (!manualStill || !favoriteStill || !autoIds.every((id) => byId.has(id)) || !byId.has(looseId)) {
      throw new Error(`server state after the flow: manual=${manualStill} favorite=${favoriteStill}`);
    }
    return { ...result, checks };
  } finally {
    await server.stop();
  }
}

function unsortedSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cards().length
        + ' | nav=' + navSmall('待整理') + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const isStack = (card) => Boolean(card.querySelector('.stack-mark'));
    const stacksIn = () => cards().filter(isStack).length;
    const selected = () => cards().filter((card) => card.classList.contains('asset-selected'));
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    const mainNavButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes(label)) || null;
    const click = (card, modifiers = {}) => card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...modifiers }));
    const menuButton = (label) => Array.from(document.querySelectorAll('.context-menu button')).find((entry) => entry.textContent.trim() === label);
    const rightClick = (card) => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));

    mainNavButton('待整理').click();
    await waitFor(() => mainNavButton('待整理')?.getAttribute('aria-current') === 'page' && cards().length === 2 && stacksIn() === 1, 'inbox shows the automatic stack and the loose card');
    await sleep(300);
    const inboxCards = cards().length;
    const inboxStacks = stacksIn();
    const navBefore = Number(navSmall('待整理'));

    // 1. Right-click the stack card: 标为已整理 leaves the inbox with its members.
    rightClick(cards().find(isStack));
    await waitFor(() => menuButton('标为已整理'), 'stack card menu offers 标为已整理');
    menuButton('标为已整理').click();
    await waitFor(() => navSmall('待整理') === String(navBefore - ${AUTO_SIZE}), 'sidebar drops by the stack size');
    await waitFor(() => cards().length === 1 && stacksIn() === 0, 'the stack card leaves the inbox');
    const inboxCardsAfterStack = cards().length;
    const inboxStacksAfterStack = stacksIn();
    const navAfterStack = Number(navSmall('待整理'));

    // 2. Undo brings the whole stack back.
    const undo = await waitFor(() => document.querySelector('.toast .toast-action'), 'undo action');
    undo.click();
    await waitFor(() => navSmall('待整理') === String(navBefore) && stacksIn() === 1, 'undo restores the stack card');
    await sleep(300);
    const navAfterUndo = Number(navSmall('待整理'));
    const inboxStacksAfterUndo = stacksIn();

    // 3. A multi-selection of the stack card and the loose card: one 标为已整理
    // marks both, and the inbox shows its empty state.
    click(cards().find(isStack));
    await waitFor(() => selected().length === 1, 'stack card selected');
    click(cards().find((card) => !isStack(card)), { metaKey: true });
    await waitFor(() => selected().length === 2, '⌘-click adds the loose card');
    rightClick(selected()[0]);
    await waitFor(() => menuButton('标为已整理'), 'batch menu offers 标为已整理');
    menuButton('标为已整理').click();
    await waitFor(() => cards().length === 0 && document.querySelector('.empty-state'), 'inbox shows its empty state');
    const emptyText = document.querySelector('.empty-state')?.textContent || '';
    const emptyStateCopy = emptyText.includes('都整理好了') && emptyText.includes('标为已整理');
    const navAfterMulti = Number(navSmall('待整理'));

    return { inboxCards, inboxStacks, navBefore, inboxCardsAfterStack, inboxStacksAfterStack, navAfterStack, navAfterUndo, inboxStacksAfterUndo, navAfterMulti, emptyStateCopy };
  })()`;
}
