// GravityPort React UI flow (task 197): moving cards to the trash keeps the
// gallery where it was — inside a stack and in the root gallery, from the
// context menu and from the Delete key. The cards after the trashed one move
// up into the gap; the scroller never jumps back to the top.
export const name = "trash-keeps-scroll";
export const description = "trash keeps the scroll position: root gallery + inside a stack (past the first page too), context menu + Delete key, undo, and a jump injected at the removal commit is put back";

const STACK_MEMBERS = 260;
const PLAIN_TOTAL = 160;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // Mixed aspect ratios, as in a real library: removing one card reflows
    // the masonry and moves later cards between columns.
    const SIZES = [[32, 24], [24, 40], [48, 20], [30, 30], [20, 48], [40, 24], [24, 36]];
    const fixtures = [];
    for (const [index, [width, height]] of SIZES.entries()) {
      fixtures.push(await ctx.makePng(`trash-scroll-${index}.png`, [60 + index * 25, 140, 188], { width, height }));
    }
    // Real cards carry tags: the inspector re-measures its tag row when the
    // trash moves the focus to another card, which reads layout in the same
    // commit as the shortened list.
    const tagsFor = (index) => Array.from({ length: 1 + (index % 4) }, (_, k) => `标签${(index + k) % 9}`);
    const fixturePath = (index) => fixtures[(index * 5 + Math.floor(index / 3)) % fixtures.length];
    const members = [];
    for (let i = 0; i < STACK_MEMBERS; i += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: fixturePath(i), prompt: "trash scroll member", tags: tagsFor(i),
      });
      members.push(created.asset.id);
    }
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: members, coverAssetId: members[0],
    });
    if (!stack.stack?.id) throw new Error(`stack seed failed: ${JSON.stringify(stack)}`);
    const workers = 6;
    for (let created = 0; created < PLAIN_TOTAL; created += workers) {
      const batch = Math.min(workers, PLAIN_TOTAL - created);
      await Promise.all(Array.from({ length: batch }, (_, offset) =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath(created + offset), prompt: "trash scroll plain", tags: tagsFor(created + offset),
        })));
    }
    // Cards render as 1:1 placeholders until the import backfill fills the
    // real dimensions; wait for it so the layout does not shift mid-measure.
    const allDimsSettled = async () => {
      let cursor = "";
      let count = 0;
      do {
        const data = await ctx.api(server.origin, "GET",
          `/api/assets?project=default&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const asset of data.assets || []) {
          const fields = asset.business_fields || {};
          if (!(Number(fields.width) > 0 && Number(fields.height) > 0)) return false;
          count += 1;
        }
        cursor = data.page?.nextCursor || "";
      } while (cursor);
      return count >= PLAIN_TOTAL + STACK_MEMBERS;
    };
    for (let i = 0; i < 120 && !(await allDimsSettled()); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!(await allDimsSettled())) throw new Error("import dimension backfill never settled");

    const result = await ctx.runInPage(server, pageSource(), { windowSize: [1440, 940] });
    for (const [step, value] of Object.entries(result || {})) {
      if (value?.failed) throw new Error(`step ${step} failed: ${JSON.stringify(result)}`);
    }
    return result;
  } finally {
    await server.stop();
  }
}

function pageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let value;
        try { value = check(); } catch { value = false; }
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + cards().length + ' | top=' + Math.round(grid()?.scrollTop || 0));
    }
    const grid = () => document.querySelector('.asset-grid');
    const cards = () => Array.from(document.querySelectorAll('.asset-card[data-asset-id]:not(.asset-card-virtual-placeholder)'));
    const navSmall = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label))
      ?.querySelector('small')?.textContent || '0';
    // Slow runners (Windows CI, a background window) keep re-laying out the
    // gallery after the previous step — late page reloads, detail merges, an
    // owed restore landing on a throttled frame. Measure only once card
    // positions, the extent and scrollTop hold still across three samples.
    const waitStable = async (timeoutMs = 10000) => {
      const snap = () => {
        const g = grid();
        return Math.round(g.scrollTop) + '|' + g.scrollHeight + '|' + cards().map((card) => card.getAttribute('data-asset-id') + ':' + Math.round(card.getBoundingClientRect().top)).join(',');
      };
      let previous = snap();
      let same = 0;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && same < 3) {
        await sleep(150);
        const next = snap();
        same = next === previous ? same + 1 : 0;
        previous = next;
      }
    };
    const settle = async () => {
      let last = -1;
      for (let i = 0; i < 40; i += 1) {
        await sleep(100);
        const now = Math.round(grid().scrollTop);
        if (now === last) return now;
        last = now;
      }
      return last;
    };
    // A card fully inside the viewport, a third of the way down.
    const cardInView = (at = 1 / 3) => {
      const g = grid().getBoundingClientRect();
      const line = g.top + g.height * at;
      return cards().find((card) => {
        const r = card.getBoundingClientRect();
        return r.top >= g.top && r.bottom <= g.bottom && r.top <= line && r.bottom >= line;
      }) || cards().find((card) => {
        const r = card.getBoundingClientRect();
        return r.top >= g.top && r.bottom <= g.bottom;
      });
    };
    // Watches scrollTop for a while after the trash and keeps the lowest value.
    const watch = async (ms) => {
      let min = Infinity;
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        min = Math.min(min, Math.round(grid().scrollTop));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      return { min, end: Math.round(grid().scrollTop) };
    };
    const scrollDown = async (fraction) => {
      await waitStable();
      const g = grid();
      // A late owed restore can move the scroller back after it was set:
      // set it again until it stays.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const target = fraction ? Math.round((g.scrollHeight - g.clientHeight) * fraction) : Math.round(g.clientHeight * 1.6);
        g.scrollTop = target;
        await settle();
        await waitStable();
        if (Math.abs(g.scrollTop - target) <= 2) break;
      }
      return Math.round(g.scrollTop);
    };
    const confirmIfAsked = async () => {
      await sleep(150);
      const dialog = document.querySelector('[role="alertdialog"]');
      if (!dialog) return;
      const skip = dialog.querySelector('input[type="checkbox"]');
      if (skip && !skip.checked) skip.click();
      await sleep(50);
      Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent.trim() === '移至回收站').click();
    };
    const trashVia = async (how, card) => {
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
      await waitFor(() => card.classList.contains('asset-selected'), 'card selected');
      if (how === 'menu') {
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
        await waitFor(() => document.querySelector('.context-menu'), 'context menu');
        Array.from(document.querySelectorAll('.context-menu button')).find((entry) => entry.textContent.trim() === '移至回收站').click();
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
      }
      await confirmIfAsked();
    };
    // One measured trash: scrolled down, a visible card goes, the gallery
    // must stay within a few pixels of where it was.
    const measure = async (how, fraction, at, injectJump = false) => {
      const before = await scrollDown(fraction);
      const card = cardInView(at);
      if (!card) return { failed: true, reason: 'no card in view', before };
      const id = card.getAttribute('data-asset-id');
      const trashBefore = Number(navSmall('回收站'));
      // The jump seen in a real library happened at the commit that drops the
      // trashed card; inject one there (scroll to the top as the DOM loses
      // the card) to prove the gallery puts the position back before paint.
      let injected = false;
      const observer = injectJump ? new MutationObserver(() => {
        if (injected || card.isConnected) return;
        injected = true;
        grid().scrollTop = 0;
      }) : null;
      observer?.observe(grid(), { childList: true });
      // On failure the result carries what the scroller did, for CI triage.
      const gridAtStart = grid();
      const t0 = performance.now();
      const timeline = [];
      const onScroll = (event) => {
        if (!(event.target instanceof Element) || !event.target.classList.contains('asset-grid')) return;
        const g = grid();
        timeline.push([Math.round(performance.now() - t0), Math.round(g.scrollTop), g.scrollHeight, g === gridAtStart ? 1 : 0, cards().length]);
      };
      document.addEventListener('scroll', onScroll, true);
      timeline.push(['env', document.visibilityState, document.hasFocus() ? 1 : 0]);
      await trashVia(how, card);
      await waitFor(() => Number(navSmall('回收站')) > trashBefore && !cards().some((c) => c.getAttribute('data-asset-id') === id), 'card left the gallery');
      const seen = await watch(1500);
      observer?.disconnect();
      document.removeEventListener('scroll', onScroll, true);
      timeline.push(['end', Math.round(grid().scrollTop), grid() === gridAtStart ? 1 : 0]);
      if (injectJump) {
        const failed = !injected || Math.abs(seen.end - before) > 4;
        return { before, end: seen.end, injected, failed, ...(failed ? { timeline: timeline.slice(0, 24) } : {}) };
      }
      const failed = !(before > 0) || Math.abs(seen.min - before) > 4 || Math.abs(seen.end - before) > 4;
      return { before, min: seen.min, end: seen.end, failed, ...(failed ? { timeline: timeline.slice(0, 24) } : {}) };
    };
    const undoAndMeasure = async () => {
      const before = Math.round(grid().scrollTop);
      const undo = await waitFor(() => Array.from(document.querySelectorAll('.toast button')).find((b) => b.textContent.trim() === '撤销'), 'undo button');
      const trashBefore = Number(navSmall('回收站'));
      undo.click();
      await waitFor(() => Number(navSmall('回收站')) < trashBefore, 'undo restored');
      const seen = await watch(1500);
      return { before, min: seen.min, end: seen.end, failed: Math.abs(seen.min - before) > 4 || Math.abs(seen.end - before) > 4 };
    };

    const result = {};
    await waitFor(() => cards().length > 20, 'root gallery rendered');
    await sleep(500);
    result.rootMenu = await measure('menu');
    result.rootKey = await measure('key');
    result.rootUndo = await undoAndMeasure();

    // Into the stack: its card sits at the end of the newest-first root.
    const g = grid();
    for (let i = 0; i < 40 && !document.querySelector('.asset-card .stack-mark'); i += 1) {
      g.scrollTop = g.scrollHeight;
      await sleep(250);
    }
    const stackCard = await waitFor(() => document.querySelector('.asset-card .stack-mark')?.closest('.asset-card'), 'stack card');
    stackCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => cards().length >= 20 && !cards().some((c) => c.querySelector('.stack-mark')), 'inside the stack');
    await sleep(500);
    result.stackMenu = await measure('menu');
    // Past the first page (100): load the whole stack, then trash deep down.
    for (let i = 0; i < 40 && Number(grid().getAttribute('data-loaded-assets') || 0) < ${STACK_MEMBERS - 1}; i += 1) {
      grid().scrollTop = grid().scrollHeight;
      await sleep(300);
    }
    result.stackDeepLoaded = { loaded: Number(grid().getAttribute('data-loaded-assets') || 0) };
    result.stackDeep = await measure('menu', 0.6);
    result.stackKey = await measure('key');
    // Several more cards at different heights: each reflow is a chance for
    // the browser to re-anchor the scroller on a card that changed column.
    for (const [index, at] of [0.15, 0.5, 0.8, 0.3, 0.65].entries()) {
      result['stackMore' + index] = await measure('menu', 0.2 + index * 0.12, at);
    }
    result.stackUndo = await undoAndMeasure();
    result.stackInjectedJump = await measure('menu', 0.4, 0.5, true);
    return result;
  })()`;
}
