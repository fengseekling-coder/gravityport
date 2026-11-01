// GravityPort React UI flow (task 322): dragging a card that already belongs
// to a stack onto another stack or card in search results moves it cleanly without
// error, and Undo returns it to its original stack and position.
export const name = "stack-drop-move";
export const description = "drag card from stack into another stack/card in search results moves members and supports exact undo";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const make = async (key, color) => (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`dropmove-${key}.png`, color),
      prompt: `dropmove test asset ${key}`,
    })).asset.id;

    // Stack A: a1, a2, a3 (named "甲")
    const a1 = await make("a1", [70, 120, 180]);
    const a2 = await make("a2", [80, 130, 170]);
    const a3 = await make("a3", [90, 140, 160]);

    // Stack B: b1, b2 (named "乙")
    const b1 = await make("b1", [180, 90, 60]);
    const b2 = await make("b2", [170, 100, 70]);

    // Stack C: c1, c2 (named "丙")
    const c1 = await make("c1", [60, 150, 120]);
    const c2 = await make("c2", [50, 160, 110]);

    // Loose assets P and Q
    const p = await make("p", [140, 70, 150]);
    const q = await make("q", [130, 120, 80]);

    const seed = async (ids, name) => {
      const made = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
        projectId: "default", assetIds: ids, coverAssetId: ids[0],
      });
      if (!made?.stack?.id) throw new Error(`stack seed failed: ${JSON.stringify(made)}`);
      await ctx.api(server.origin, "PATCH", `/api/asset-stacks/${made.stack.id}`, { projectId: "default", name });
      return made.stack.id;
    };

    const config = {
      a1, a2, a3,
      b1, b2,
      c1, c2,
      p, q,
      stackA: [a1, a2, a3],
      stackB: [b1, b2],
      stackC: [c1, c2],
      stackAId: await seed([a1, a2, a3], "甲"),
      stackBId: await seed([b1, b2], "乙"),
      stackCId: await seed([c1, c2], "丙"),
    };

    const result = await ctx.runInPage(server, pageSource(config), { windowSize: [1280, 860] });
    if (!result || result.failedSteps?.length) throw new Error(`stack-drop-move result: ${JSON.stringify(result)}`);
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
    const members = async (stackId) => ((await api('/api/asset-stacks/' + stackId + '/assets?project=default&limit=250')).assets || []).map((asset) => asset.id);
    const rootAssets = async () => (await api('/api/assets?project=default&limit=250')).assets || [];
    const stackOfAsset = async (assetId) => {
      const list = await rootAssets();
      const match = list.find((a) => a.id === assetId && a.stack && a.stack.id);
      return match ? match.stack : null;
    };
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const centerOf = (el) => { const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    const DRAG_ID = 21;
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

    async function drag(fromId, toId) {
      await waitForGalleryStable();
      const fromEl = cardFor(fromId);
      const from = centerOf(fromEl);
      const aim = () => centerOf(cardFor(toId));
      fromEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: from.x, clientY: from.y }));
      await sleep(40);
      const start = aim();
      for (let i = 1; i <= 6; i += 1) {
        window.dispatchEvent(moveEvent(from.x + (start.x - from.x) * i / 6, from.y + (start.y - from.y) * i / 6));
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
      await waitFor(() => cardFor(toId)?.classList.contains('card-drop-target'), 'drop highlight on target card', 3000).catch(() => null);
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

    async function setSearch(term) {
      const input = await waitFor(() => document.querySelector('.search input'), 'search input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, term);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);
      await waitForGalleryStable();
    }

    // Step 0: Filter by search term 'dropmove' to unstack all cards
    await waitFor(() => cardFor(config.a1) && cardFor(config.b1) && cardFor(config.c1) && cardFor(config.p), 'initial gallery cards');
    await setSearch('dropmove');
    await waitFor(() => cardFor(config.a2) && cardFor(config.b2) && cardFor(config.c2), 'unstacked cards visible in search');

    // Step 1: Drag a2 onto b1 in search results
    await step('1. drag a2 from stack A onto b1 of stack B in search results', async () => {
      await select([config.a2]);
      await drag(config.a2, config.b1);

      const toast = await waitFor(() => {
        const text = document.querySelector('.toast')?.textContent || '';
        return text.includes('已把 1 个素材移到堆叠「乙」') ? text : null;
      }, 'toast indicating moved 1 asset to stack 乙');

      // Check no English error on page
      const bodyText = document.body.textContent || '';
      if (bodyText.includes('already belongs') || bodyText.includes('ASSET_ALREADY_STACKED')) {
        throw new Error('English error appeared in DOM: ' + bodyText);
      }

      // Check members via API
      await waitFor(async () => {
        const bMembers = await members(config.stackBId);
        return same(bMembers, [config.b1, config.b2, config.a2]) ? bMembers : null;
      }, 'stack B has [b1, b2, a2]');

      await waitFor(async () => {
        const aMembers = await members(config.stackAId);
        return same(aMembers, [config.a1, config.a3]) ? aMembers : null;
      }, 'stack A has [a1, a3]');

      return { toast };
    });

    // Step 2: Click Undo
    await step('2. click undo to restore a2 into stack A at 2nd position', async () => {
      await undo();

      await waitFor(async () => {
        const aMembers = await members(config.stackAId);
        return same(aMembers, [config.a1, config.a2, config.a3]) ? aMembers : null;
      }, 'stack A restored to [a1, a2, a3]');

      await waitFor(async () => {
        const bMembers = await members(config.stackBId);
        return same(bMembers, [config.b1, config.b2]) ? bMembers : null;
      }, 'stack B restored to [b1, b2]');

      return true;
    });

    // Step 3: Drag a1 onto loose card P
    await step('3. drag a1 onto loose asset P makes new stack; undo restores A and P', async () => {
      await select([config.a1]);
      await drag(config.a1, config.p);

      const toast = await waitFor(() => {
        const text = document.querySelector('.toast')?.textContent || '';
        return text.includes('已堆叠 2 项素材') ? text : null;
      }, 'toast indicating 2 assets stacked');

      // Verify A lost a1
      await waitFor(async () => {
        const aMembers = await members(config.stackAId);
        return same(aMembers, [config.a2, config.a3]) ? aMembers : null;
      }, 'stack A has [a2, a3]');

      // Undo
      await undo();

      // Verify A has [a1, a2, a3] again
      await waitFor(async () => {
        const aMembers = await members(config.stackAId);
        return same(aMembers, [config.a1, config.a2, config.a3]) ? aMembers : null;
      }, 'stack A restored to [a1, a2, a3]');

      // Verify P is loose again
      await waitFor(async () => {
        const stack = await stackOfAsset(config.p);
        return stack === null;
      }, 'P is loose');

      return true;
    });

    // Step 4: Stack C left with 1 member dissolves; undo rebuilds C
    await step('4. drag c1 onto B dissolves C; undo rebuilds C with original name and cover', async () => {
      await select([config.c1]);
      await drag(config.c1, config.b1);

      await waitFor(() => {
        const text = document.querySelector('.toast')?.textContent || '';
        return text.includes('已把 1 个素材移到堆叠「乙」') ? text : null;
      }, 'toast indicating moved to stack 乙');

      // Stack C should be dissolved (API returns 404 for stackCId)
      await waitFor(async () => {
        const resp = await fetch('/api/asset-stacks/' + config.stackCId + '?project=default');
        return resp.status === 404;
      }, 'stack C dissolved');

      // B has [b1, b2, c1]
      await waitFor(async () => {
        const bMembers = await members(config.stackBId);
        return same(bMembers, [config.b1, config.b2, config.c1]) ? bMembers : null;
      }, 'stack B has [b1, b2, c1]');

      // Undo
      await undo();

      // Rebuilt C should have [c1, c2], cover c1, name '丙'
      const rebuiltC = await waitFor(async () => {
        const stack = await stackOfAsset(config.c1);
        if (!stack || stack.name !== '丙') return null;
        const stackData = await api('/api/asset-stacks/' + stack.id + '/assets?project=default&limit=250');
        if (stackData.stack?.cover_asset_id !== config.c1) return null;
        const cMembers = (stackData.assets || []).map((a) => a.id);
        return same(cMembers, [config.c1, config.c2]) ? stackData.stack : null;
      }, 'stack C rebuilt with name 丙, cover c1, and members [c1, c2]');
      if (!rebuiltC || rebuiltC.cover_asset_id !== config.c1) {
        throw new Error('rebuilt stack C cover is not c1');
      }

      // B restored to [b1, b2]
      await waitFor(async () => {
        const bMembers = await members(config.stackBId);
        return same(bMembers, [config.b1, config.b2]) ? bMembers : null;
      }, 'stack B restored to [b1, b2]');

      return { rebuiltStackId: rebuiltC.id };
    });

    // Step 5: Clear search, drag loose Q onto stack card B
    await step('5. clear search and drag loose card Q onto stack B shows Added 1 asset', async () => {
      await setSearch('');

      // In collapsed gallery, stack B cover is b1 with stack-mark
      await waitFor(() => {
        const card = cardFor(config.b1);
        return card && card.querySelector('.stack-mark');
      }, 'stack B rendered as collapsed card with stack-mark');

      await select([config.q]);
      await drag(config.q, config.b1);

      const toast = await waitFor(() => {
        const text = document.querySelector('.toast')?.textContent || '';
        return text.includes('已向堆叠加入 1 项素材') ? text : null;
      }, 'toast indicating 已向堆叠加入 1 项素材');

      // Check B has [b1, b2, q]
      await waitFor(async () => {
        const bMembers = await members(config.stackBId);
        return same(bMembers, [config.b1, config.b2, config.q]) ? bMembers : null;
      }, 'stack B has [b1, b2, q]');

      return { toast };
    });

    return { steps, failedSteps };
  })()`;
}
