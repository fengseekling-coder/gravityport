// GravityPort React UI flow (task 308): multi-selection inside a stack view.
// An automatic stack (captures sharing one generation session) of 5 members
// is entered by double-clicking its root card. A marquee over three members
// pressed on one of them drags out of the window as three files — it used to
// hand over only the pressed card — and the drag ghost shows the selected
// count. A two-member selection dropped before another member reorders as one
// block (the PATCH replaces the whole stack order, computed from the view's
// display order). A single-card drag still hands over exactly one path with
// no count badge, and a stack-card drag inside the stack never merges.
export const name = "stack-interior-multi-drag";
export const description = "auto stack of 5: marquee 3 members and drag out hands 3 paths, ghost shows 3 -> 2 members dragged before another member move as one block, server order matches the view-order block move, ghost shows 2 -> single member drag out still hands 1 path, no count badge";

const STACK_SIZE = 5;
const SESSION_ID = "e2e-stack-interior-308";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const memberIds = [];
    for (let index = 0; index < STACK_SIZE; index += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`stack-interior-${index}.png`, [40 + index * 40, 90, 170]),
        prompt: `stack interior ${index}`,
        source: { type: "codex-generated", generation_session_id: SESSION_ID },
      });
      memberIds.push(created.asset.id);
    }
    // Server truth: the shared generation session formed one automatic stack
    // over exactly the five created assets.
    const root = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const byId = new Map((root.assets || []).map((asset) => [asset.id, asset]));
    const stackIds = [...new Set(memberIds.map((id) => byId.get(id)?.stack?.id).filter(Boolean))];
    if (stackIds.length !== 1) throw new Error(`expected one automatic stack, got ${JSON.stringify(stackIds)}`);
    const stackId = stackIds[0];
    const stackMembers = ((await ctx.api(server.origin, "GET", `/api/asset-stacks/${stackId}/assets?project=default&limit=250`)).assets || [])
      .map((asset) => asset.id);
    if (JSON.stringify([...stackMembers].sort()) !== JSON.stringify([...memberIds].sort())) {
      throw new Error(`stack members ${JSON.stringify(stackMembers)} != created ${JSON.stringify(memberIds)}`);
    }
    const pathOf = (id) => byId.get(id)?.image_path || "";

    const result = await ctx.runInPage(server, stackInteriorSource({ stackId, stackSize: STACK_SIZE }), { windowSize: [1440, 940] });

    // Drag out: exactly the marquee's three members, in view (DOM) order.
    if (!Array.isArray(result?.marqueeIds) || result.marqueeIds.length !== 3) {
      throw new Error(`marquee did not select 3 members: ${JSON.stringify(result?.marqueeIds)}`);
    }
    const expectedOut = result.marqueeIds.map(pathOf);
    if (JSON.stringify(result?.draggedPaths) !== JSON.stringify(expectedOut)) {
      throw new Error(`drag-out paths ${JSON.stringify(result?.draggedPaths)} != selected ${JSON.stringify(expectedOut)}`);
    }
    if (result?.ghostCount3 !== "3") {
      throw new Error(`drag ghost count during the 3-card drag was ${JSON.stringify(result?.ghostCount3)}, expected "3"`);
    }

    // Block reorder: the two selected members move as one block before the
    // target; the PATCH basis is the view's display order at drag time.
    const expectedOrder = moveBlockRelative(result.domBefore, result.blockIds, result.targetId, result.placement);
    const orderNow = ((await ctx.api(server.origin, "GET", `/api/asset-stacks/${stackId}/assets?project=default&limit=250`)).assets || [])
      .map((asset) => asset.id);
    if (JSON.stringify(orderNow) !== JSON.stringify(expectedOrder)) {
      throw new Error(`stack order after the block drop ${JSON.stringify(orderNow)} != expected ${JSON.stringify(expectedOrder)}`);
    }
    if (result?.ghostCount2 !== "2") {
      throw new Error(`drag ghost count during the 2-card reorder was ${JSON.stringify(result?.ghostCount2)}, expected "2"`);
    }
    if (result?.reorderLineAppeared !== true) {
      throw new Error("no reorder line appeared (the drag must stay a reorder: stackIds empty inside a stack)");
    }

    // Single-card drag out: unchanged, one path and no count badge.
    if (JSON.stringify(result?.draggedPathsSingle) !== JSON.stringify([pathOf(result.singleId)])) {
      throw new Error(`single drag-out paths ${JSON.stringify(result?.draggedPathsSingle)} != [${pathOf(result.singleId)}]`);
    }
    if (result?.ghostBadgeSingle !== null) {
      throw new Error(`single drag showed a count badge: ${JSON.stringify(result?.ghostBadgeSingle)}`);
    }
    return {
      stackId,
      marqueeIds: result.marqueeIds,
      draggedPaths: result.draggedPaths.length,
      ghostCount3: result.ghostCount3,
      blockIds: result.blockIds,
      targetId: result.targetId,
      placement: result.placement,
      orderAfter: orderNow,
      ghostCount2: result.ghostCount2,
      reorderLineAppeared: result.reorderLineAppeared,
      singleId: result.singleId,
      draggedPathsSingle: result.draggedPathsSingle.length,
    };
  } finally {
    await server.stop();
  }
}

// The pure function the app applies on a reorder drop (card-drag.ts), copied
// here so the expected order comes from the same rule the UI runs.
function moveBlockRelative(items, movingIds, targetId, placement) {
  const moving = new Set(movingIds);
  const block = items.filter((id) => moving.has(id));
  const rest = items.filter((id) => !moving.has(id));
  let targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) targetIndex = rest.length;
  else if (placement === "after") targetIndex += 1;
  rest.splice(targetIndex, 0, ...block);
  return rest;
}

function stackInteriorSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | selected=' + selectedIds().length
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
      throw new Error('Timed out waiting for ' + label + ' | last=' + last);
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
    const stackOrder = async () => ((await api('/api/asset-stacks/' + config.stackId + '/assets?project=default&limit=250')).assets || []).map(a => a.id);
    const cardFor = (id) => document.querySelector('.asset-card[data-asset-id="' + id + '"]');
    const visibleIds = () => Array.from(document.querySelectorAll('.asset-grid .asset-card:not(.asset-card-virtual-placeholder)'))
      .map(c => c.getAttribute('data-asset-id'));
    const selectedIds = () => Array.from(document.querySelectorAll('.asset-card.asset-selected')).map(c => c.getAttribute('data-asset-id'));
    const ghostCount = () => document.querySelector('.card-drag-ghost-count')?.textContent || null;
    const centerOf = (el) => { const box = el.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; };
    const DRAG_ID = 31;
    const pointer = (target, type, x, y, extra = {}) => target.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: DRAG_ID, pointerType: 'mouse', button: 0,
      buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra,
    }));
    // Escape until no card is marked, with the empty state holding for several
    // reads: every view reload re-lands the implicit selection on the first
    // card, and a marked card would turn the marquee press into a card drag.
    async function resetSelection() {
      let emptyReads = 0;
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (selectedIds().length) {
          emptyReads = 0;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        } else emptyReads += 1;
        if (emptyReads >= 3) return;
        await sleep(100);
      }
      throw new Error('selection never cleared: ' + JSON.stringify(selectedIds()));
    }
    // The gallery re-lays-out asynchronously; a drag that starts while cards
    // are still moving would chase a stale point.
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
    const click = (card, modifiers = {}) => card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...modifiers }));
    // After a drag (or a system hand-off) the app swallows the next synthetic
    // click: the suppression flag only resets on a real pointerdown, which
    // dispatched clicks never have. Re-click like stack-select-all-drag does
    // and report every retry.
    async function clickUntil(check, label, card, modifiers, attempts = 4) {
      const retries = [];
      for (let attempt = 1; ; attempt += 1) {
        click(card, modifiers);
        try {
          await waitFor(check, label, 3000);
          return retries;
        } catch (error) {
          if (attempt >= attempts) throw error;
          retries.push('attempt ' + attempt);
        }
      }
    }

    // ── Enter the automatic stack from the root gallery ──
    await waitFor(() => visibleIds().length === 1 && visibleIds().length && cardFor(visibleIds()[0])?.querySelector('.stack-mark'),
      'root gallery shows the automatic stack card');
    await waitForGalleryStable();
    cardFor(visibleIds()[0]).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await waitFor(() => visibleIds().length === config.stackSize && visibleIds().every((id) => !cardFor(id)?.querySelector('.stack-mark')),
      'stack view opens with member cards');
    await sleep(300);
    await waitForGalleryStable();

    // ── Part A: marquee three members, press one, drag out of the window ──
    await resetSelection();
    const shown = visibleIds();
    const first3 = shown.slice(0, 3);
    const boxes = first3.map((id) => cardFor(id).getBoundingClientRect());
    // Sweep from the pressed card's centre down-right across the three cards'
    // lower halves: the rect can only reach these three (a wrapped fifth card
    // sits below this band, a fourth card right of the sweep's right edge).
    const startX = centerOf(cardFor(first3[0])).x;
    const startY = boxes[0].top + boxes[0].height * 0.5;
    const endX = boxes[2].right - 2;
    const endY = boxes[2].bottom - 2;
    pointer(cardFor(first3[0]), 'pointerdown', startX, startY);
    pointer(window, 'pointermove', endX, endY);
    await sleep(150);
    pointer(window, 'pointerup', endX, endY);
    await waitFor(() => JSON.stringify(selectedIds()) === JSON.stringify(first3),
      'marquee selects exactly the 3 swept members | selected=' + JSON.stringify(selectedIds()));
    const marqueeIds = selectedIds();

    window.__draggedPaths = null;
    window.electronAPI = { startNativeDrag: async (paths) => { window.__draggedPaths = paths; return { ok: true }; } };
    const pressBox = cardFor(first3[0]).getBoundingClientRect();
    const pressX = pressBox.left + pressBox.width / 2;
    const pressY = pressBox.top + pressBox.height / 2;
    pointer(cardFor(first3[0]), 'pointerdown', pressX, pressY);
    await sleep(40);
    // Cross the drag threshold inside the window and read the ghost count.
    pointer(window, 'pointermove', pressX + 24, pressY + 24,
      { screenX: window.screenX + pressX + 24, screenY: window.screenY + pressY + 24 });
    const ghostCount3 = await waitFor(() => ghostCount() === '3' ? ghostCount() : null, 'ghost count shows 3');
    // Leave the window: the system drag takes the selected members' paths.
    pointer(window, 'pointermove', window.innerWidth + 200, pressY,
      { screenX: window.screenX + window.outerWidth + 200, screenY: window.screenY + pressY });
    const draggedPaths = await waitFor(() => window.__draggedPaths, 'native drag paths for the 3-card drag');
    pointer(window, 'pointerup', window.innerWidth + 200, pressY);
    delete window.electronAPI;
    await sleep(300);

    // ── Part B: two members dropped before another member reorder as a block ──
    await resetSelection();
    await waitForGalleryStable();
    const domBefore = visibleIds();
    const orderBefore = await stackOrder();
    // Take the block off the server's stack order and the target off its head
    // so the drag exercises ids whose view positions differ from their stack
    // positions; moveBlockRelative orders the block by the view order.
    const blockIds = orderBefore.slice(-2);
    const targetId = orderBefore[0];
    await clickUntil(() => selectedIds().length === 1 && selectedIds()[0] === blockIds[0], 'first block member selected', cardFor(blockIds[0]));
    click(cardFor(blockIds[1]), { metaKey: true });
    await waitFor(() => JSON.stringify(selectedIds().sort()) === JSON.stringify([...blockIds].sort()), 'both block members selected');
    const pressCard = cardFor(blockIds[0]);
    const pressAt = centerOf(pressCard);
    pointer(pressCard, 'pointerdown', pressAt.x, pressAt.y);
    await sleep(40);
    const targetBox = cardFor(targetId).getBoundingClientRect();
    const dropX = targetBox.left + targetBox.width * 0.25;
    const dropY = targetBox.top + targetBox.height / 2;
    for (let i = 1; i <= 6; i += 1) {
      pointer(window, 'pointermove', pressAt.x + (dropX - pressAt.x) * i / 6, pressAt.y + (dropY - pressAt.y) * i / 6);
      await sleep(40);
    }
    // The reorder line is painted by the drag's rAF flush; wait for it instead
    // of reading once (a hidden window can flush late). Its presence is also
    // the proof the drag stayed a reorder (stackIds empty): a drag carrying
    // stacks would paint a merge target instead and this wait would time out.
    const lineState = await waitFor(() => cardFor(targetId)?.classList.contains('stack-reorder-before')
      ? (ghostCount() === '2' ? 'line+ghost2' : 'line-noghost2') : null,
      'reorder-before line on the target and ghost count 2');
    const ghostCount2 = ghostCount();
    pointer(window, 'pointerup', dropX, dropY);
    await sleep(80);
    click(pressCard);
    // The drop PATCHes the whole order computed from the view's display order.
    const expectedNext = (() => {
      const moving = new Set(blockIds);
      const block = domBefore.filter((id) => moving.has(id));
      const rest = domBefore.filter((id) => !moving.has(id));
      rest.splice(rest.indexOf(targetId), 0, ...block);
      return rest;
    })();
    await waitForApi(async () => JSON.stringify(await stackOrder()) === JSON.stringify(expectedNext) ? expectedNext : null,
      'server order becomes the block move | expected=' + JSON.stringify(expectedNext)
      + ' | now=' + JSON.stringify(await stackOrder()));
    const reorderLineAppeared = lineState === 'line+ghost2';

    // ── Part C: a single selected member still drags out alone ──
    await resetSelection();
    await waitForGalleryStable();
    const singleId = visibleIds()[2];
    await clickUntil(() => selectedIds().length === 1 && selectedIds()[0] === singleId, 'single member selected', cardFor(singleId));
    window.__draggedPaths = null;
    window.electronAPI = { startNativeDrag: async (paths) => { window.__draggedPaths = paths; return { ok: true }; } };
    const singleBox = cardFor(singleId).getBoundingClientRect();
    const sx = singleBox.left + singleBox.width / 2;
    const sy = singleBox.top + singleBox.height / 2;
    pointer(cardFor(singleId), 'pointerdown', sx, sy);
    await sleep(40);
    pointer(window, 'pointermove', sx + 24, sy + 24,
      { screenX: window.screenX + sx + 24, screenY: window.screenY + sy + 24 });
    await waitFor(() => document.querySelector('.card-drag-ghost'), 'single drag ghost appears');
    const ghostBadgeSingle = ghostCount();
    pointer(window, 'pointermove', window.innerWidth + 200, sy,
      { screenX: window.screenX + window.outerWidth + 200, screenY: window.screenY + sy });
    const draggedPathsSingle = await waitFor(() => window.__draggedPaths, 'native drag paths for the single drag');
    pointer(window, 'pointerup', window.innerWidth + 200, sy);
    delete window.electronAPI;
    await sleep(200);

    return { marqueeIds, draggedPaths, ghostCount3, domBefore, blockIds, targetId, placement: 'before', ghostCount2, reorderLineAppeared, singleId, draggedPathsSingle, ghostBadgeSingle };
  })()`;
}
