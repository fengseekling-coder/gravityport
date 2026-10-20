// GravityPort React UI flow (task 196): dragging stacks merges them. A stack
// card dropped on another stack card moves all its members (in order) behind
// the target's own; the target keeps its name and cover and the emptied stack
// is gone. A stack plus a plain card dropped on a plain card builds a new
// stack with that card as cover. Undo rebuilds every dragged stack with its
// old members, order, cover and name. A stack dropped on itself does nothing.
export const name = "stack-merge-drag";
export const description = "stack merge: stack onto stack (members appended, name + cover kept, source gone) + undo rebuilds it -> stack + plain card onto a plain card makes a new stack + undo -> stack onto itself is inert";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const make = async (key, color) => (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng(`merge-${key}.png`, color), prompt: `stack merge ${key}`,
    })).asset.id;
    const stackA = [await make("a1", [70, 120, 180]), await make("a2", [80, 130, 170]), await make("a3", [90, 140, 160])];
    const stackB = [await make("b1", [180, 90, 60]), await make("b2", [170, 100, 70])];
    const target = await make("t", [60, 140, 90]);
    const plain = await make("p", [120, 80, 160]);
    const seed = async (ids, name) => {
      const made = await ctx.api(server.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: ids, coverAssetId: ids[0] });
      if (!made?.stack?.id) throw new Error(`stack seed failed: ${JSON.stringify(made)}`);
      await ctx.api(server.origin, "PATCH", `/api/asset-stacks/${made.stack.id}`, { projectId: "default", name });
      return made.stack.id;
    };
    const config = {
      stackA, stackB, target, plain,
      stackAId: await seed(stackA, "甲堆叠"),
      stackBId: await seed(stackB, "乙堆叠"),
    };
    const result = await ctx.runInPage(server, pageSource(config), { windowSize: [1280, 860] });
    if (!result || result.failedSteps?.length) throw new Error(`stack-merge-drag result: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await server.stop();
  }
}

function pageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const steps = [];
    const failedSteps = [];
    async function step(name, fn) {
      try { steps.push(name + ' :: ' + JSON.stringify(await fn())); }
      catch (error) { failedSteps.push(name + ' :: ' + error.message); }
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < deadline) {
        try { const value = await check(); if (value) return value; last = 'falsy'; } catch (error) { last = error.message; }
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + ' | last=' + last + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    async function api(path) {
      const response = await fetch(path);
      if (!response.ok) throw new Error('GET ' + path + ' -> ' + response.status);
      return response.json();
    }
    const rootAssets = async () => (await api('/api/assets?project=default&limit=250')).assets || [];
    // The root listing shows one card per stack (its cover) carrying the stack.
    const stacks = async () => (await rootAssets()).filter((asset) => asset.stack && asset.stack.id)
      .map((asset) => ({ cover: asset.id, id: asset.stack.id, name: asset.stack.name || '' }));
    const stackWithCover = async (coverId) => (await stacks()).find((stack) => stack.cover === coverId) || null;
    const members = async (stackId) => ((await api('/api/asset-stacks/' + stackId + '/assets?project=default&limit=250')).assets || []).map((asset) => asset.id);
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const centerOf = (el) => { const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const DRAG_ID = 11;
    const moveEvent = (x, y) => new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: x, clientY: y });
    async function select(ids) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
      const [first, ...rest] = ids;
      await waitFor(() => cardFor(first), 'card ' + first);
      cardFor(first).click();
      for (const id of rest) cardFor(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
      await waitFor(() => ids.every((id) => cardFor(id)?.classList.contains('asset-selected')), 'selection ' + ids.join(','), 5000);
    }
    // The gallery re-lays-out after every merge and undo (cards come and go,
    // Windows CI is slow): wait until every card holds still across samples.
    async function waitForGalleryStable(timeoutMs = 8000) {
      const snapshot = () => Array.from(document.querySelectorAll('.asset-grid .asset-card')).map((card) => {
        const box = card.getBoundingClientRect();
        return card.getAttribute('data-asset-id') + ':' + Math.round(box.left) + ',' + Math.round(box.top);
      }).join('|');
      let previous = snapshot();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(150);
        const next = snapshot();
        if (next === previous) return;
        previous = next;
      }
      throw new Error('gallery layout never settled');
    }
    // Press the source card, walk to the target card and release on where it
    // sits at that moment (re-read until two reads agree). Returns the cards
    // that showed the drop highlight just before release.
    async function drag(fromId, toId) {
      await waitForGalleryStable();
      const fromEl = cardFor(fromId);
      const from = centerOf(fromEl);
      const self = toId === fromId;
      const aim = () => { const c = centerOf(cardFor(toId)); return self ? { x: c.x + 10, y: c.y + 10 } : c; };
      fromEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: from.x, clientY: from.y }));
      await sleep(40);
      const start = aim();
      for (let i = 1; i <= 6; i += 1) {
        window.dispatchEvent(moveEvent(from.x + (start.x - from.x) * i / 6 + (self ? 10 : 0), from.y + (start.y - from.y) * i / 6));
        await sleep(40);
      }
      let to = aim();
      for (let chase = 0; chase < 4; chase += 1) {
        window.dispatchEvent(moveEvent(to.x, to.y));
        await sleep(150);
        const again = aim();
        const settled = Math.abs(again.x - to.x) <= 1 && Math.abs(again.y - to.y) <= 1;
        to = again;
        if (settled) break;
      }
      // The highlight is React state painted a frame or more after the move;
      // give a slow runner time before reading it (a self drop never gets one).
      if (!self) await waitFor(() => cardFor(toId)?.classList.contains('card-drop-target'), 'drop highlight on the target', 3000).catch(() => null);
      const highlighted = Array.from(document.querySelectorAll('.asset-card.card-drop-target')).map((card) => card.getAttribute('data-asset-id'));
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: to.x, clientY: to.y }));
      fromEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return highlighted;
    }
    async function undo() {
      const button = await waitFor(() => document.querySelector('.toast-action'), 'undo button');
      if (button.textContent.trim() !== '撤销') throw new Error('toast action is ' + button.textContent);
      button.click();
    }
    // After undo the dragged stack is rebuilt (a new stack id): find it by
    // its old cover and compare members and name.
    async function expectRebuiltA() {
      return waitFor(async () => {
        const rebuilt = await stackWithCover(config.stackA[0]);
        if (!rebuilt || rebuilt.name !== '甲堆叠') return null;
        return same(await members(rebuilt.id), config.stackA) ? rebuilt : null;
      }, 'stack A rebuilt with its members, order, cover and name');
    }

    await waitFor(() => cardFor(config.stackA[0]) && cardFor(config.stackB[0]) && cardFor(config.target), 'gallery rendered');

    await step('stack onto stack merges into the target', async () => {
      await select([config.stackA[0]]);
      const highlighted = await drag(config.stackA[0], config.stackB[0]);
      if (!same(highlighted, [config.stackB[0]])) throw new Error('target highlight: ' + JSON.stringify(highlighted));
      const merged = [...config.stackB, ...config.stackA];
      await waitFor(async () => same(await members(config.stackBId), merged), 'B holds its members then A in order');
      const toast = document.querySelector('.toast')?.textContent || '';
      if (!toast.includes('已合并到堆叠「乙堆叠」，共 3 项')) throw new Error('toast: ' + toast);
      const all = await waitFor(async () => { const list = await stacks(); return list.some((s) => s.id === config.stackAId) ? null : list; }, 'stack A gone');
      const b = all.find((s) => s.id === config.stackBId);
      if (!b || b.cover !== config.stackB[0] || b.name !== '乙堆叠') throw new Error('B changed: ' + JSON.stringify(b));
      return { stacks: all.length };
    });

    await step('undo splits the merge back', async () => {
      await undo();
      const rebuilt = await expectRebuiltA();
      await waitFor(async () => same(await members(config.stackBId), config.stackB), 'B back to its own members');
      config.stackAId = rebuilt.id;
      return { rebuilt: rebuilt.id };
    });

    await step('stack + plain card onto a plain card makes a new stack', async () => {
      await waitFor(() => cardFor(config.stackA[0]) && cardFor(config.plain) && cardFor(config.stackA[0]).querySelector('.stack-mark'), 'cards back after undo');
      await select([config.stackA[0], config.plain]);
      const highlighted = await drag(config.stackA[0], config.target);
      if (!same(highlighted, [config.target])) throw new Error('target highlight: ' + JSON.stringify(highlighted));
      const created = await waitFor(() => stackWithCover(config.target), 'new stack with the target as cover');
      const got = await members(created.id);
      const want = [config.target, ...config.stackA, config.plain];
      if (got[0] !== config.target || got.length !== want.length || !want.every((id) => got.includes(id))) {
        throw new Error('new stack members: ' + JSON.stringify(got));
      }
      if ((await stacks()).some((s) => s.id === config.stackAId)) throw new Error('stack A still exists');
      return { members: got.length };
    });

    await step('undo restores the plain cards and stack A', async () => {
      await undo();
      await expectRebuiltA();
      await waitFor(async () => {
        const list = await rootAssets();
        const loose = (id) => list.some((asset) => asset.id === id && !(asset.stack && asset.stack.id));
        return loose(config.target) && loose(config.plain);
      }, 'target and plain card loose again');
      return true;
    });

    await step('stack onto itself is inert', async () => {
      await waitFor(() => cardFor(config.stackA[0]), 'stack A card');
      const before = JSON.stringify((await stacks()).map((s) => s.id).sort());
      await select([config.stackA[0]]);
      const highlighted = await drag(config.stackA[0], config.stackA[0]);
      if (highlighted.length) throw new Error('self drop highlighted: ' + JSON.stringify(highlighted));
      await sleep(800);
      const after = JSON.stringify((await stacks()).map((s) => s.id).sort());
      if (before !== after) throw new Error('stacks changed: ' + before + ' -> ' + after);
      return true;
    });

    return { steps, failedSteps };
  })()`;
}
