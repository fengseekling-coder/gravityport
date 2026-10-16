// GravityPort React UI flow (task 146): card dragging — short press still
// selects, drag onto a card builds a stack with a 6s undo, multi-drag onto a
// stack joins it, drag to a sidebar group / 待整理 reassigns the group, a
// stack card drops on the sidebar move all members, a stack card is inert on
// gallery cards, inert rows change nothing, reorder inside an unfiltered
// stack, no reorder with a search term, Escape cancels cleanly, and the
// synthetic click after a drag is swallowed. Every step checks server truth
// through the in-page API and the final state is re-verified from node.
export const name = "card-drag";
export const description = "card drag: select threshold -> stack create + undo -> multi-drag join stack + undo -> sidebar group/待整理 drops -> stack card sidebar drop -> stack card inert on cards -> inert nav rows -> stack reorder + cover -> search blocks reorder -> Escape cancels -> click swallowed";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // 4 loose assets + one 3-member stack + one empty personal group. The
    // shared prompt prefix doubles as the search term that matches every
    // stack member while the reorder guard is being tested.
    const loose = [];
    for (const [key, color] of [["a", [74, 127, 181]], ["b", [186, 94, 60]], ["c", [58, 138, 87]], ["d", [96, 74, 155]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`cd-${key}.png`, color), prompt: `card drag ${key}`,
      });
      loose.push(created.asset.id);
    }
    const members = [];
    for (const [key, color] of [["m1", [33, 77, 121]], ["m2", [121, 77, 33]], ["m3", [77, 121, 33]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`cd-${key}.png`, color), prompt: "cd-reorder shared prompt",
      });
      members.push(created.asset.id);
    }
    const seedStack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: members,
    });
    const orderStackId = seedStack.stack?.id;
    if (!orderStackId) throw new Error(`seed stack create failed: ${JSON.stringify(seedStack)}`);
    const dropGroup = `拖放分组-${Date.now().toString(36)}`;
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: dropGroup });

    const config = {
      looseIds: loose, memberIds: members, orderStackId, dropGroup,
      searchTerm: "cd-reorder",
    };
    const result = await ctx.runInPage(server, cardDragSource(config));
    if (!result || result.failedSteps?.length) {
      throw new Error(`card-drag page result: ${JSON.stringify(result)}`);
    }
    const finalStackId = result.finalStackId;
    if (!finalStackId) throw new Error(`page flow did not report the surviving stack: ${JSON.stringify(result)}`);

    // Node-side re-verification of the final server state: the loose group
    // assignment from the sidebar drops, the surviving stack (cover B), the
    // reordered seed stack (cover m3), and nothing favorite/trashed.
    const root = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const byId = new Map((root.assets || []).map(asset => [asset.id, asset]));
    const expectGroup = (id, group) => {
      const asset = byId.get(id);
      if (!asset) throw new Error(`asset ${id} missing from root view`);
      if ((asset.group || "") !== group) throw new Error(`asset ${id} group ${(asset.group || "")} != ${group}`);
    };
    expectGroup(config.looseIds[0], config.dropGroup);
    expectGroup(config.looseIds[1], config.dropGroup);
    expectGroup(config.looseIds[2], "");
    expectGroup(config.looseIds[3], config.dropGroup);
    for (const id of config.memberIds) expectGroup(id, "");
    if (byId.get(config.looseIds[1])?.stack?.id !== finalStackId) {
      throw new Error(`surviving stack mismatch on B: ${JSON.stringify(byId.get(config.looseIds[1])?.stack)}`);
    }
    // The root listing annotates only the cover, so membership comes from the
    // stack's own endpoint.
    const survivingOrder = ((await ctx.api(server.origin, "GET", `/api/asset-stacks/${finalStackId}/assets?project=default&limit=250`)).assets || []).map(asset => asset.id).sort();
    const survivingExpected = [config.looseIds[0], config.looseIds[1]].sort();
    if (JSON.stringify(survivingOrder) !== JSON.stringify(survivingExpected)) {
      throw new Error(`surviving stack members mismatch: ${JSON.stringify(survivingOrder)} != ${JSON.stringify(survivingExpected)}`);
    }
    // The page read the stack view's display order off the grid DOM (the sort
    // is not the stack order); "third to the front" is expressed in that
    // order, so the server rotation is verified against it.
    const seedShown = result.seedShown || [];
    if (seedShown.length !== 3) throw new Error(`page did not report the stack display order: ${JSON.stringify(seedShown)}`);
    const expectedSeedOrder = [seedShown[2], seedShown[0], seedShown[1]];
    const finalStackOrder = ((await ctx.api(server.origin, "GET", `/api/asset-stacks/${config.orderStackId}/assets?project=default&limit=250`)).assets || []).map(asset => asset.id);
    if (JSON.stringify(finalStackOrder) !== JSON.stringify(expectedSeedOrder)) {
      throw new Error(`seed stack order mismatch: ${JSON.stringify(finalStackOrder)} != ${JSON.stringify(expectedSeedOrder)}`);
    }
    if (byId.get(seedShown[2])?.stack?.id !== config.orderStackId) {
      throw new Error(`seed stack cover should be the dragged card: ${JSON.stringify(byId.get(seedShown[2])?.stack)}`);
    }
    const favorites = (await ctx.api(server.origin, "GET", "/api/assets?project=default&favorite=1&limit=250")).assets || [];
    if (favorites.length) throw new Error(`unexpected favorites: ${JSON.stringify(favorites.map(a => a.id))}`);
    const trash = (await ctx.api(server.origin, "GET", "/api/assets?project=default&trash=1&limit=250")).assets || [];
    if (trash.length) throw new Error(`unexpected trash: ${JSON.stringify(trash.map(a => a.id))}`);
    return { steps: result.steps || 0, retries: result.retries || [], dropGroup, orderStackId, finalStackId };
  } finally {
    await server.stop();
  }
}

function cardDragSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const steps = [];
    const failedSteps = [];
    // Re-drags are allowed but never silent: every one lands in the result.
    const retries = [];
    async function step(name, action) {
      try {
        const detail = await action();
        steps.push(name + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''));
        console.log('[card-drag-flow] step ok:', name, detail === undefined ? '' : JSON.stringify(detail));
      } catch (error) {
        failedSteps.push(name + ' :: ' + error.message);
        console.log('[card-drag-flow] step FAIL:', name, error.message);
      }
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | toast=' + (document.querySelector('.toast')?.textContent || ''));
    }
    async function waitForApi(fn, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const value = await fn();
          if (value) return value;
          last = 'falsy';
        } catch (error) { last = error.message; }
        await sleep(150);
      }
      // A function label re-evaluates at timeout so the failure carries the
      // server truth at that moment, not at the call.
      const detail = typeof label === 'function' ? label() : label;
      throw new Error('Timed out waiting for ' + detail + ' | last=' + last);
    }
    async function api(path, method, body) {
      const token = sessionStorage.getItem('mosa-client-token') || '';
      const response = await fetch(path, {
        method: method || 'GET',
        headers: { 'x-mosa-client-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error((method || 'GET') + ' ' + path + ' -> ' + response.status + ': ' + text.slice(0, 200));
      return text ? JSON.parse(text) : null;
    }
    const rootAssets = async () => (await api('/api/assets?project=default&limit=250')).assets || [];
    const assetById = async (id) => (await rootAssets()).find((asset) => asset.id === id) || null;
    let stackOrderCache = [];
    const stackOrder = async (stackId) => {
      const ids = ((await api('/api/asset-stacks/' + stackId + '/assets?project=default&limit=250')).assets || []).map(a => a.id);
      if (stackId === config.orderStackId) stackOrderCache = ids;
      return ids;
    };
    const stackCount = async () => new Set((await rootAssets()).map(a => a.stack && a.stack.id).filter(Boolean)).size;
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const navRow = (label) => document.querySelector('.main-nav .nav-row[aria-label="' + label + '"]');
    const groupRow = () => document.querySelector('[data-drop-group="' + config.dropGroup + '"]');
    const ungroupRow = () => document.querySelector('[data-drop-ungroup]');
    const centerOf = (el) => {
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const DRAG_ID = 9;
    const moveEvent = (x, y) => new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: x, clientY: y });
    // The gallery re-lays-out asynchronously (page loads, worker fills), and a
    // drag that starts while cards are still moving would chase a stale point.
    // Wait until the full card id sequence AND every card's rect hold still
    // across two samples, then drag.
    async function waitForGalleryStable(timeoutMs = 8000) {
      const snapshot = () => Array.from(document.querySelectorAll('.asset-grid .asset-card')).map((c) => {
        const r = c.getBoundingClientRect();
        return c.getAttribute('data-asset-id') + ':' + Math.round(r.left) + ',' + Math.round(r.top);
      }).join('|');
      let prev = snapshot();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(120);
        const next = snapshot();
        if (next === prev) return true;
        prev = next;
      }
      throw new Error('gallery layout never stabilized');
    }
    // The next multi-select must start from a known empty baseline, otherwise
    // the modifier-clicks toggle against whatever survived from the last step.
    // An empty selection is not sticky: every gallery reload (a stack drop
    // refreshes the view) re-lands the implicit selection on the first card,
    // and on slow runners that reload can finish after the Escape. So press
    // Escape again whenever a card is marked, until empty holds for 3 reads.
    async function resetSelection(timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let emptyReads = 0;
      while (Date.now() < deadline) {
        if (selectedIds().length) {
          emptyReads = 0;
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } else if (++emptyReads >= 3) return;
        await sleep(120);
      }
      throw new Error('selection never stayed cleared: ' + JSON.stringify(selectedIds()));
    }
    // A drag whose drop lands on nothing (the gallery can still relayout
    // behind a finished wait) is exactly what a real user does next: drag
    // again. Rebuild the selection from the empty baseline, redo the gesture,
    // and only accept the server state — never the UI.
    async function dragWithRetry(fromEl, targetEl, offset, serverCheck, label, attempts = 3) {
      let lastError;
      const wantSel = JSON.stringify([config.looseIds[2], config.looseIds[3]].sort());
      for (let attempt = 1; attempt <= attempts; attempt++) {
        await resetSelection();
        // Click C, ⌘-click D (a ⌘-click adds to the inspected card, task 155).
        cardFor(config.looseIds[2]).click();
        cmdClick(cardFor(config.looseIds[3]));
        // A reload landing between the reset and the clicks adds the implicit
        // first card; that is a wrong start, so it counts as a retry too.
        try {
          await waitFor(() => JSON.stringify(selectedIds().slice().sort()) === wantSel, 'C+D selected (attempt ' + attempt + ')', 3000);
        } catch (error) { lastError = error; retries.push(label + ' attempt ' + attempt + ' (selection)'); continue; }
        const base = targetEl && targetEl() ? centerOf(targetEl()) : null;
        if (!base) throw new Error('retry drag target missing: ' + label);
        const toPoint = { x: base.x + (offset ? offset.x : 0), y: base.y + (offset ? offset.y : 0) };
        await dragTo(fromEl, toPoint, { trackEl: targetEl });
        try {
          return await waitForApi(serverCheck, label + ' (attempt ' + attempt + ')', 3000);
        } catch (error) { lastError = error; retries.push(label + ' attempt ' + attempt); }
      }
      throw lastError;
    }
    // Press the card's center, walk towards the tracked target and release on
    // it. The target point is re-resolved from trackEl on every sample, so a
    // gallery relayout between the press and the release cannot strand the
    // drop on a stale coordinate: the pointer ends on the target's current
    // center plus the offset the caller aimed for (left-half stays left-half).
    // A real browser synthesizes a click after pointerup; synthetic pointers
    // don't, so the flow dispatches the equivalent click itself — that is the
    // click the drag-swallow logic must eat.
    async function dragTo(fromEl, toPoint, opts) {
      const options = opts || {};
      await waitForGalleryStable();
      const trackEl = options.trackEl || null;
      const startTrack = trackEl && trackEl() ? centerOf(trackEl()) : null;
      const rel = startTrack ? { x: toPoint.x - startTrack.x, y: toPoint.y - startTrack.y } : { x: 0, y: 0 };
      const aimNow = () => {
        const el = trackEl && trackEl();
        if (!el) return toPoint;
        const c = centerOf(el);
        return { x: c.x + rel.x, y: c.y + rel.y };
      };
      // Only a highlighted card drags (task 155); a press on an unselected
      // card is a marquee. Click it first, as a user would.
      if (!fromEl.classList.contains('asset-selected')) {
        fromEl.click();
        await waitFor(() => fromEl.classList.contains('asset-selected'), 'drag source selected');
      }
      const from = centerOf(fromEl);
      const start = aimNow();
      fromEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: from.x, clientY: from.y }));
      await sleep(40);
      const total = options.steps || 6;
      for (let i = 1; i <= total; i++) {
        const x = from.x + (start.x - from.x) * (i / total);
        const y = from.y + (start.y - from.y) * (i / total);
        window.dispatchEvent(moveEvent(x, y));
        await sleep(40);
      }
      // Follow the target to where it sits right now, and keep chasing until
      // two consecutive reads agree: a relayout that lands between samples
      // must not strand the release on a stale point.
      let finalPoint = aimNow();
      for (let chase = 0; chase < 3; chase++) {
        window.dispatchEvent(moveEvent(finalPoint.x, finalPoint.y));
        await sleep(130);
        const again = aimNow();
        const settled = Math.abs(again.x - finalPoint.x) <= 1 && Math.abs(again.y - finalPoint.y) <= 1;
        finalPoint = again;
        if (settled) break;
      }
      if (options.beforeRelease) {
        try {
          await options.beforeRelease();
        } catch (error) {
          // A failed check must not leak a live drag into the next steps:
          // cancel it the way a user would (Escape), then let go.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(60);
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: finalPoint.x, clientY: finalPoint.y }));
          await sleep(120);
          throw error;
        }
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: finalPoint.x, clientY: finalPoint.y }));
      fromEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(80);
    }
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected')).map(c => c.getAttribute('data-asset-id'));
    const cmdClick = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }));
    const dropHighlights = () => ({
      card: document.querySelectorAll('.asset-card.card-drop-target').length,
      reorder: document.querySelectorAll('.asset-card.stack-reorder-target').length,
      side: document.querySelectorAll('.nav-row.side-drop-target').length,
      ghost: document.querySelectorAll('.card-drag-ghost').length,
    });
    const pressUndo = async () => {
      const button = await waitFor(() => document.querySelector('.toast-action'), 'undo button in toast');
      if (button.textContent.trim() !== '撤销') throw new Error('toast action is not 撤销: ' + button.textContent);
      button.click();
      return waitFor(() => !document.querySelector('.toast-action'), 'undo toast clears');
    };
    // The root gallery collapses stacks to their cover card, so the card to
    // double-click into a stack is whatever the server currently lists first.
    const enterStack = async () => {
      const order = await stackOrder(config.orderStackId);
      const cover = order[0];
      if (!cardFor(cover)) throw new Error('cover card ' + cover + ' not in the gallery: ' + JSON.stringify(order));
      cardFor(cover).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      await waitFor(() => {
        const cards = document.querySelectorAll('.asset-grid .asset-card:not(.asset-card-virtual-placeholder)');
        return cards.length >= config.memberIds.length
          && Array.from(cards).every(c => !c.querySelector('.stack-mark')) ? cards.length : null;
      }, 'stack view opens with member cards');
      return stackOrderCache;
    };
    const leaveStack = async (expectCover) => {
      // A settled search commit records its own history entry, so leaving the
      // stack can take more than one 回退; click until the cover card with its
      // stack-mark is back in the root gallery.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (cardFor(expectCover)?.querySelector('.stack-mark')) return;
        const back = document.querySelector('button[aria-label="后退"]');
        if (!back) throw new Error('back button missing');
        back.click();
        await sleep(400);
      }
      throw new Error('back never left the stack, cover=' + expectCover + ' | cards=' + dumpCards());
    };
    const dumpCards = () => Array.from(document.querySelectorAll('.asset-card'))
      .map(c => c.getAttribute('data-asset-id') + '[' + c.className + ']')
      .join(' ');

    await waitFor(() => cardFor(config.looseIds[0]) && cardFor(config.memberIds[0]), 'seeded cards render');

    // ── 1) Press + tiny move (<8px) + release: no drag happens and the click
    // ── the browser would synthesize still selects (the swallow is drag-only).
    // ── Synthetic pointer events get no automatic click, so the flow clicks
    // ── the card itself: a sub-threshold gesture must not swallow it.
    await step('sub-threshold press does not drag or swallow the click', async () => {
      const card = cardFor(config.looseIds[0]);
      const box = card.getBoundingClientRect();
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: cx, clientY: cy }));
      await sleep(30);
      window.dispatchEvent(moveEvent(cx + 3, cy + 2));
      await sleep(30);
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: cx + 3, clientY: cy + 2 }));
      await sleep(60);
      const leftovers = dropHighlights();
      if (leftovers.card || leftovers.reorder || leftovers.side || leftovers.ghost) {
        throw new Error('sub-threshold press left drag visuals: ' + JSON.stringify(leftovers));
      }
      if ((document.body.className || '').includes('gp-card-dragging')) throw new Error('body kept the dragging class');
      card.click();
      await waitFor(() => JSON.stringify(selectedIds()) === JSON.stringify([config.looseIds[0]]),
        'the follow-up click selects the pressed card | selected=' + JSON.stringify(selectedIds()));
      const annotated = await assetById(config.looseIds[0]);
      if (annotated.stack) throw new Error('short press created a stack: ' + JSON.stringify(annotated.stack));
      if ((await stackCount()) !== 1) throw new Error('short press changed the stack count');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    });

    // ── 2) A onto B: new stack with cover B, undo dissolves it ──
    await step('drag A onto B creates a stack with cover B, undo dissolves', async () => {
      await dragTo(cardFor(config.looseIds[0]), centerOf(cardFor(config.looseIds[1])), { trackEl: () => cardFor(config.looseIds[1]) });
      const stackId = await waitForApi(async () => {
        const annotated = await assetById(config.looseIds[1]);
        return annotated.stack && annotated.stack.id ? annotated.stack.id : null;
      }, 'stack annotation on B');
      config.finalStackId = stackId;
      const order = await stackOrder(stackId);
      if (JSON.stringify(order) !== JSON.stringify([config.looseIds[1], config.looseIds[0]])) {
        throw new Error('new stack order (cover first) wrong: ' + JSON.stringify(order));
      }
      await pressUndo();
      let undoProbe = '';
      await waitForApi(async () => {
        const b = await assetById(config.looseIds[1]);
        undoProbe = 'b.stack=' + JSON.stringify(b.stack)
          + ' toast=' + (document.querySelector('.toast')?.textContent || 'none');
        // The root listing only annotates the cover card, so B is the one to watch.
        return !b.stack ? true : null;
      }, () => 'dissolve returns A and B to the root | ' + undoProbe);
      if ((await stackCount()) !== 1) throw new Error('undo left an extra stack behind');
      return stackId;
    });

    // ── 3) Rebuild the stack, then multi-select C+D onto it; undo moves them back out ──
    await step('multi-drag C+D onto the rebuilt stack joins it, undo restores', async () => {
      await dragTo(cardFor(config.looseIds[0]), centerOf(cardFor(config.looseIds[1])), { trackEl: () => cardFor(config.looseIds[1]) });
      const stackId = await waitForApi(async () => {
        const annotated = await assetById(config.looseIds[1]);
        return annotated.stack && annotated.stack.id ? annotated.stack.id : null;
      }, 'rebuilt stack');
      config.finalStackId = stackId;
      if ((await stackCount()) !== 2) throw new Error('rebuild should hold exactly two stacks');
      // The click the drag swallowed must not have selected the pressed card
      // (implicit focus selection may mark another card — that is by design).
      if (JSON.stringify(selectedIds()) === JSON.stringify([config.looseIds[0]])) {
        throw new Error('a finished drag left the pressed card selected: ' + JSON.stringify(selectedIds()));
      }
      // The swallowed click must not turn into "select the pressed card":
      // asserted below on the selection left by this gesture.
      await dragWithRetry(cardFor(config.looseIds[2]), () => cardFor(config.looseIds[1]), null,
        async () => {
          const order = await stackOrder(stackId);
          const wanted = [config.looseIds[0], config.looseIds[1], config.looseIds[2], config.looseIds[3]].sort();
          return JSON.stringify(order.slice().sort()) === JSON.stringify(wanted) ? order : null;
        }, 'stack gains C and D');
      const selAfterJoin = selectedIds();
      if (JSON.stringify(selAfterJoin) === JSON.stringify([config.looseIds[2]])) {
        throw new Error('the post-drag click selected the pressed card');
      }
      await pressUndo();
      await waitForApi(async () => {
        const order = await stackOrder(stackId);
        return JSON.stringify(order.slice().sort()) === JSON.stringify([config.looseIds[0], config.looseIds[1]].sort()) ? order : null;
      }, () => 'undo removes only C and D | order=' + JSON.stringify(stackOrderCache));
      const after = await stackOrder(stackId);
      if (!after.includes(config.looseIds[0]) || !after.includes(config.looseIds[1])) {
        throw new Error('original members did not survive the undo: ' + JSON.stringify(after));
      }
      return stackId;
    });

    // ── 4) Multi-drag C+D onto the sidebar group row, then C onto 待整理 ──
    await step('drag C+D onto a group row, then C onto 待整理', async () => {
      await dragWithRetry(cardFor(config.looseIds[2]), () => groupRow(), null,
        async () => {
          const c = await assetById(config.looseIds[2]);
          const d = await assetById(config.looseIds[3]);
          return c.group === config.dropGroup && d.group === config.dropGroup ? true : null;
        }, 'C and D join the group');
      // The sidebar drop cleared the selection (a retry may have left C+D
      // marked), so start from the empty baseline and ⌘-click C alone.
      // Same re-land race as in dragWithRetry: if a reload marks the first
      // card between the reset and the click, start over.
      for (let pick = 1; ; pick++) {
        await resetSelection();
        cardFor(config.looseIds[2]).click();
        try {
          await waitFor(() => JSON.stringify(selectedIds()) === JSON.stringify([config.looseIds[2]]), 'only C selected', 3000);
          break;
        } catch (error) {
          if (pick >= 3) throw error;
          retries.push('only C selected attempt ' + pick);
        }
      }
      await dragTo(cardFor(config.looseIds[2]), centerOf(ungroupRow()), { trackEl: () => ungroupRow() });
      await waitForApi(async () => {
        const c = await assetById(config.looseIds[2]);
        return !(c.group || '') ? true : null;
      }, 'C leaves the group via 待整理');
      return true;
    });

    // ── 5) Stack card onto the group row: every member follows ──
    await step('stack card onto the group row moves all members', async () => {
      await dragTo(cardFor(config.looseIds[1]), centerOf(groupRow()), { trackEl: () => groupRow() });
      await waitForApi(async () => {
        const a = await assetById(config.looseIds[0]);
        const b = await assetById(config.looseIds[1]);
        return a.group === config.dropGroup && b.group === config.dropGroup ? true : null;
      }, 'stack members join the group');
      return true;
    });

    // ── 6) Stack card onto a plain card: nothing happens, no highlight ──
    await step('stack card is inert on gallery cards', async () => {
      const stackCard = cardFor(config.looseIds[1]);
      await dragTo(stackCard, centerOf(cardFor(config.looseIds[2])), {
          trackEl: () => cardFor(config.looseIds[2]),
        beforeRelease: async () => {
          const highlights = dropHighlights();
          if (highlights.card) throw new Error('stack drag highlighted a gallery card: ' + JSON.stringify(highlights));
        },
      });
      // Only a selected card drags (task 155), so the stack card is already
      // the selection here and a leaked post-drag click would change nothing;
      // the multi-drag step above is where the swallow is proven.
      if ((await stackCount()) !== 2) throw new Error('stack drag onto a card changed the stack count');
      const c = await assetById(config.looseIds[2]);
      if (c.stack) throw new Error('target card joined a stack: ' + JSON.stringify(c.stack));
      return true;
    });

    // ── 7) Plain card onto 收藏 / 回收站 / 所有素材: nothing changes ──
    await step('inert nav rows accept nothing', async () => {
      for (const label of ['收藏', '回收站', '所有素材']) {
        await dragTo(cardFor(config.looseIds[2]), centerOf(navRow(label)), {
          trackEl: () => navRow(label),
          beforeRelease: async () => {
            if (document.querySelectorAll('.nav-row.side-drop-target').length) {
              throw new Error(label + ' row highlighted during drag');
            }
          },
        });
      }
      const c = await assetById(config.looseIds[2]);
      if (c.group || c.favorite) throw new Error('inert rows changed C: ' + JSON.stringify({ group: c.group, favorite: c.favorite }));
      if ((await stackCount()) !== 2) throw new Error('inert rows changed the stacks');
      const trash = (await api('/api/assets?project=default&trash=1&limit=250')).assets || [];
      if (trash.length) throw new Error('something landed in trash: ' + JSON.stringify(trash.map(a => a.id)));
      return true;
    });

    // ── 8) Inside the 3-member stack: drag the third visible card onto the
    // ── left half of the first. The stack view renders in its own display
    // ── order (the sort is not the stack order), so "third" and "first" are
    // ── read off the grid DOM, and the server order must become 3,1,2.
    await step('stack reorder puts the third card first and flips the cover', async () => {
      await enterStack();
      const visibleIds = () => Array.from(document.querySelectorAll('.asset-grid .asset-card:not(.asset-card-virtual-placeholder)'))
        .map(c => c.getAttribute('data-asset-id'));
      const shown = visibleIds();
      config.seedShown = shown;
      if (shown.length !== 3) throw new Error('stack view should show 3 members: ' + JSON.stringify(shown));
      const first = shown[0];
      const third = shown[2];
      const coverBefore = stackOrderCache[0];
      try {
        const firstBox = cardFor(first).getBoundingClientRect();
        const leftHalf = { x: firstBox.left + firstBox.width * 0.25, y: firstBox.top + firstBox.height / 2 };
        await dragTo(cardFor(third), leftHalf, {
          trackEl: () => cardFor(first),
          beforeRelease: async () => {
            // The line is painted by the drag's rAF flush; a hidden window on
            // a slow runner (Windows CI) can run it well after the chase's
            // last 130ms sleep, so wait for it instead of reading once.
            const line = await waitFor(() => {
              const el = cardFor(first);
              return el && el.classList.contains('stack-reorder-target') ? el : null;
            }, 'reorder line', 3000).catch(() => {
              throw new Error('no reorder line on the first card: ' + dumpCards());
            });
            if (!line.classList.contains('stack-reorder-before')) {
              throw new Error('left half must show the before line: ' + line.className);
            }
          },
        });
      } catch (error) {
        // Still in the stack view: leave it, or the next step's double-click
        // lands on a member card and opens the preview instead.
        await leaveStack(coverBefore).catch(() => {});
        throw error;
      }
      const expected = [third, first, shown[1]];
      const order = await waitForApi(async () => {
        const current = await stackOrder(config.orderStackId);
        return JSON.stringify(current) === JSON.stringify(expected) ? current : null;
      }, () => 'stack order becomes 3,1,2 | server=' + JSON.stringify(stackOrderCache) + ' expected=' + JSON.stringify(expected));
      await leaveStack(third);
      return order;
    });

    // ── 9) With a search term the stack must not reorder ──
    await step('search term blocks reordering', async () => {
      await enterStack();
      const input = await waitFor(() => document.querySelector('.search input'), 'search input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, config.searchTerm);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(800);
      await waitFor(() => document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length >= 3, 'all members still visible under the search term');
      const shown = Array.from(document.querySelectorAll('.asset-grid .asset-card:not(.asset-card-virtual-placeholder)'))
        .map(c => c.getAttribute('data-asset-id'));
      await dragTo(cardFor(shown[2]), centerOf(cardFor(shown[0])), {
        trackEl: () => cardFor(shown[0]),
        beforeRelease: async () => {
          if (document.querySelectorAll('.asset-card.stack-reorder-target').length) {
            throw new Error('reorder line shown while a search term is active');
          }
        },
      });
      const order = await stackOrder(config.orderStackId);
      if (JSON.stringify(order) !== JSON.stringify(stackOrderCache)) {
        throw new Error('search-term drag reordered the stack: ' + JSON.stringify(order) + ' != ' + JSON.stringify(stackOrderCache));
      }
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);
      await leaveStack(order[0]);
      return order;
    });

    // ── 10) Escape mid-drag cancels: no server change, no leftover visuals ──
    await step('escape cancels a live drag', async () => {
      await waitForGalleryStable();
      const targetCard = cardFor(config.looseIds[3]);
      const to = centerOf(targetCard);
      cardFor(config.looseIds[2]).click();
      await waitFor(() => cardFor(config.looseIds[2]).classList.contains('asset-selected'), 'escape drag source selected');
      const from = centerOf(cardFor(config.looseIds[2]));
      cardFor(config.looseIds[2]).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: from.x, clientY: from.y }));
      await sleep(40);
      window.dispatchEvent(moveEvent(from.x + (to.x - from.x) * 0.5, from.y + (to.y - from.y) * 0.5));
      await sleep(60);
      window.dispatchEvent(moveEvent(to.x, to.y));
      await sleep(80);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(60);
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: to.x, clientY: to.y }));
      await sleep(120);
      if ((await stackCount()) !== 2) throw new Error('escape cancel still created a stack');
      const d = await assetById(config.looseIds[3]);
      if (d.stack) throw new Error('escape cancel stacked onto D: ' + JSON.stringify(d.stack));
      const leftovers = dropHighlights();
      if (leftovers.card || leftovers.reorder || leftovers.side || leftovers.ghost) {
        throw new Error('visual leftovers after escape: ' + JSON.stringify(leftovers));
      }
      if ((document.body.className || '').includes('gp-card-dragging')) throw new Error('body kept the dragging class');
      return true;
    });

    if (failedSteps.length) throw new Error('failed steps: ' + JSON.stringify(failedSteps));
    return { steps: steps.length, retries, finalStackId: config.finalStackId, seedShown: config.seedShown || [] };
  })()`;
}
