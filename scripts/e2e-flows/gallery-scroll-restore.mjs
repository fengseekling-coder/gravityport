// GravityPort React UI flow (task 152): the gallery returns to where the user
// left it. Preview round-trips hold the exact position (revealing only a
// viewer-paged focused card), stack round-trips restore the loaded window,
// position and focused card via both the back button and the blank-menu
// 「返回素材库」, sidebar switches to a group and to Pinterest restore per
// view, and never-visited views start explicitly at the top.
export const name = "gallery-scroll-restore";
export const description =
  "341 cards -> preview exit holds position / reveals paged card -> stack via back and 返回素材库 restores window+position+selection -> group and Pinterest sidebar switches restore -> first visit starts at 0";

const PLAIN_TOTAL = 340; // > GALLERY_MOUNT_ALL_THRESHOLD (320): windowing on
const STACK_MEMBERS = 3;
const GROUP_MEMBERS = 3;
const GROUP_NAME = "滚动测试分组";
const PAGE = 100;

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const fixturePath = await ctx.makePng("scroll-restore.png", [74, 127, 181]);
    // Stack members are seeded FIRST so the newest-first root view ranks the
    // stack card last (position ~341) — never inside the first page.
    const members = [];
    for (let i = 0; i < STACK_MEMBERS; i += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: fixturePath, prompt: "scroll stack member",
      });
      members.push(created.asset.id);
    }
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: members, coverAssetId: members[0],
    });
    const coverId = stack.stack?.cover_asset_id || members[0];
    if (!stack.stack?.id) throw new Error(`stack seed failed: ${JSON.stringify(stack)}`);
    const workers = 6;
    const plain = [];
    for (let created = 0; created < PLAIN_TOTAL; created += workers) {
      const batch = Math.min(workers, PLAIN_TOTAL - created);
      const made = await Promise.all(Array.from({ length: batch }, () =>
        ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: fixturePath, prompt: "scroll restore plain",
        })));
      plain.push(...made.map(entry => entry.asset.id));
    }
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: plain.slice(0, GROUP_MEMBERS), group: GROUP_NAME,
    });
    const rootTotal = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=1&view=gallery")
      .then(data => data.page?.total);
    if (rootTotal !== PLAIN_TOTAL + 1) throw new Error(`unexpected gallery root total ${rootTotal}`);
    // The import backfill fills width/height (and fires SSE) a moment after
    // create: cards first render as 1:1 placeholders and the layout shifts
    // when the real ratios land. Every asset must carry its final dimensions
    // before the page opens and starts measuring.
    const allDimsSettled = async () => {
      let cursor = "";
      let count = 0;
      do {
        const data = await ctx.api(server.origin, "GET",
          `/api/assets?project=default&view=gallery&limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        for (const asset of data.assets || []) {
          const fields = asset.business_fields || {};
          if (!(Number(fields.width) > 0 && Number(fields.height) > 0)) return false;
          count += 1;
        }
        cursor = data.page?.nextCursor || "";
      } while (cursor);
      return count >= PLAIN_TOTAL + 1;
    };
    for (let i = 0; i < 120 && !(await allDimsSettled()); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!(await allDimsSettled())) throw new Error("import dimension backfill never settled");

    const result = await ctx.runInPage(server, pageSource({ coverId, groupName: GROUP_NAME }), { windowSize: [1440, 940] });
    for (const [step, value] of Object.entries(result || {})) {
      if (value?.failed) throw new Error(`step ${step} failed: ${JSON.stringify(value)}`);
    }
    return { coverId, rootTotal, ...result };
  } finally {
    await server.stop();
  }
}

function pageSource({ coverId, groupName }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const twoFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    async function waitFor(check, label, timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        let value;
        try { value = check(); } catch { value = false; }
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | loaded=' + loaded() + ' | scroll=' + scrollState()
        + ' | loading=' + Boolean(document.querySelector(".empty-state[role='status']")));
    }
    const grid = () => document.querySelector('.asset-grid');
    const loaded = () => Number(grid()?.getAttribute('data-loaded-assets') || 0);
    const scrollState = () => {
      const g = grid();
      return g ? JSON.stringify({ top: Math.round(g.scrollTop), ch: g.clientHeight, sh: g.scrollHeight }) : 'none';
    };
    const realCards = () => Array.from(document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)'));
    const realCard = (id) => document.querySelector('.asset-card:not(.asset-card-virtual-placeholder)[data-asset-id="' + id + '"]');
    const selectedId = () => document.querySelector('.asset-card.asset-selected')?.getAttribute('data-asset-id') || '';
    const previewOpen = () => Boolean(document.querySelector('.workspace.preview-open'));
    const viewerIndex = () => parseInt((document.querySelector('.viewer-title span')?.textContent || '0').split('/')[0], 10) || 0;
    const navButton = (label) => {
      const button = Array.from(document.querySelectorAll('nav button'))
        .find((candidate) => Array.from(candidate.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
      if (!button) throw new Error('nav button not found: ' + label + ' | nav rows: '
        + Array.from(document.querySelectorAll('nav button')).map((row) => row.textContent.trim()).join(','));
      return button;
    };
    const key = (init) => document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

    // Loading has ended (no 加载中) and the loaded count held steady, then two
    // frames so layout and the virtual window settle before any read.
    async function settle(label) {
      let last = -1, stable = 0;
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const busy = Boolean(document.querySelector(".empty-state[role='status']"));
        const count = loaded();
        if (!busy && count > 0 && count === last) {
          stable += 1;
          if (stable >= 3) { await twoFrames(); return count; }
        } else stable = 0;
        last = count;
        await sleep(120);
      }
      throw new Error('Timed out settling ' + label + ' | loaded=' + loaded() + ' | scroll=' + scrollState());
    }
    // Position read: scrollTop plus the anchor card at the viewport's top
    // edge (intersecting it or the closest below, smallest top, DOM order on
    // ties) with its offset from the top edge.
    function measure() {
      const g = grid();
      const gTop = g.getBoundingClientRect().top;
      let best = null, bestTop = Infinity;
      for (const el of realCards()) {
        const r = el.getBoundingClientRect();
        if (r.bottom <= gTop + 1) continue;
        const top = r.top - gTop;
        if (top < bestTop) { bestTop = top; best = el; }
      }
      return {
        scrollTop: Math.round(g.scrollTop),
        clientHeight: g.clientHeight,
        loaded: loaded(),
        anchorId: best ? best.getAttribute('data-asset-id') : null,
        anchorOffset: best ? Math.round((best.getBoundingClientRect().top - gTop) * 100) / 100 : null,
      };
    }
    function assertClose(actual, expected, tolerance, label) {
      if (actual === null || actual === undefined || Math.abs(actual - expected) > tolerance) {
        throw new Error(label + ': ' + actual + ' vs ' + expected);
      }
    }
    // The anchor card pins the identity of the position; scrollTop and its
    // offset compare within tolerance. Deep in a tall gallery the CSS grid's
    // sub-pixel row quantization drifts a few px from the masonry model's
    // exact floats (measured ~4px at 14,000px), so the tolerance scales with
    // depth while the anchor must match exactly.
    function assertSamePosition(before, after, label) {
      const tolerance = Math.max(2, Math.ceil(after.scrollTop / 3000));
      if (Math.abs(after.scrollTop - before.scrollTop) > tolerance || after.anchorId !== before.anchorId
        || Math.abs((after.anchorOffset ?? 0) - (before.anchorOffset ?? 0)) > tolerance) {
        throw new Error(label + ' moved: ' + JSON.stringify({ before, after, tolerance }));
      }
    }
    // Nudge until the scroller actually holds the target: early pages are
    // short, so the first assignment clamps until pagination appends.
    async function scrollTo(target, label) {
      for (let i = 0; i < 80; i += 1) {
        grid().scrollTop = target;
        await sleep(150);
        if (Math.abs(grid().scrollTop - target) <= 2) break;
      }
      await settle(label);
    }
    // A card fully inside the viewport whose DOM-order next card is too.
    function fullyVisiblePair() {
      const g = grid();
      const gTop = g.getBoundingClientRect().top;
      const bottom = gTop + g.clientHeight;
      const cards = realCards();
      for (let i = 0; i + 1 < cards.length; i += 1) {
        const a = cards[i].getBoundingClientRect();
        const b = cards[i + 1].getBoundingClientRect();
        if (a.top >= gTop - 1 && a.bottom <= bottom + 1 && b.top >= gTop - 1 && b.bottom <= bottom + 1) return cards[i];
      }
      return null;
    }
    async function openPreview(card) {
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await waitFor(previewOpen, 'preview opens');
      await waitFor(() => document.querySelector('img.viewer-image')?.complete === true, 'viewer image loads');
    }
    async function closePreviewViaButton() {
      document.querySelector('.toolbar-left button').click();
      await waitFor(() => grid() && !previewOpen(), 'preview closes via 返回');
      await settle('after preview close');
    }
    async function closePreviewViaEscape() {
      key({ key: 'Escape' });
      await waitFor(() => grid() && !previewOpen(), 'preview closes via Escape');
      await settle('after preview close');
    }

    const result = {};
    await waitFor(() => document.querySelector('.app') && loaded() === ${PAGE}, 'first page loads exactly');
    // The backfill's SSE refetch must have re-rendered the grid with the real
    // (uniform 4:3) ratios before any position gets measured — placeholder
    // squares shift the whole layout when the real dimensions land.
    await waitFor(() => {
      const cards = realCards();
      return cards.length > 0 && cards.every((el) => {
        const r = el.getBoundingClientRect();
        return Math.abs(r.height - r.width * 0.75) <= 2;
      });
    }, 'cards render their real aspect ratios');

    // ── step 1: preview round-trip keeps the exact position ──
    await scrollTo(3 * grid().clientHeight, 'deep scroll');
    const p1before = measure();
    let pair = fullyVisiblePair();
    if (!pair) throw new Error('no fully visible card pair at the deep scroll | ' + JSON.stringify(p1before));
    const p1cardId = pair.getAttribute('data-asset-id');
    await openPreview(pair);
    const p1start = viewerIndex();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await waitFor(() => viewerIndex() === p1start + 1, 'viewer arrow steps one card');
    await closePreviewViaButton();
    const p1after = measure();
    assertSamePosition(p1before, p1after, 'preview exit 1');
    result.previewSameButton = { before: p1before, after: p1after, cardId: p1cardId, failed: false };

    await openPreview(realCard(p1cardId));
    await closePreviewViaEscape();
    const p1after2 = measure();
    assertSamePosition(p1before, p1after2, 'preview exit 2');
    result.previewSameEscape = { before: p1before, after: p1after2, failed: false };

    // ── step 2: paging far in the preview reveals the focused card only ──
    pair = fullyVisiblePair();
    if (!pair) throw new Error('no fully visible card pair for the far preview');
    await openPreview(pair);
    const p2start = viewerIndex();
    for (let i = 0; i < 120; i += 1) {
      const at = viewerIndex();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await waitFor(() => viewerIndex() === at + 1, 'viewer arrow ' + i);
    }
    const p2end = viewerIndex();
    if (p2end < p2start + 15) throw new Error('arrow paging barely moved: ' + p2start + ' -> ' + p2end);
    await closePreviewViaEscape();
    const sel = document.querySelector('.asset-card.asset-selected');
    if (!sel) throw new Error('no selected card after the far preview');
    const g2 = grid();
    const g2Top = g2.getBoundingClientRect().top;
    const selRect = sel.getBoundingClientRect();
    if (selRect.top < g2Top - 1 || selRect.bottom > g2Top + g2.clientHeight + 1) {
      throw new Error('focused card not fully visible after the far preview: top=' + (selRect.top - g2Top)
        + ' bottom=' + (selRect.bottom - g2Top) + ' ch=' + g2.clientHeight);
    }
    const p2after = measure();
    const selBottomContent = (selRect.bottom - g2Top) + g2.scrollTop;
    const bound = p1after.scrollTop + (selBottomContent - (p1after.scrollTop + p1after.clientHeight)) + 8 + 2;
    if (p2after.scrollTop <= p1after.scrollTop) throw new Error('far preview did not scroll: ' + JSON.stringify({ before: p1after, after: p2after }));
    if (p2after.scrollTop > bound) throw new Error('far preview overscrolled: ' + p2after.scrollTop + ' > bound ' + bound);
    result.previewFar = { from: p1after.scrollTop, to: p2after.scrollTop, bound, viewerStart: p2start, viewerEnd: p2end, failed: false };

    // ── step 3: enter the stack, come back via the toolbar back button ──
    // Walk to the very bottom: a scroll parked at the edge gets no further
    // scroll events, so each page landing is followed by a small wiggle that
    // re-fires the pagination check until every asset is loaded.
    for (let i = 0; i < 100 && loaded() < ${PLAIN_TOTAL + 1}; i += 1) {
      const g = grid();
      const before = loaded();
      g.scrollTop = g.scrollHeight;
      await sleep(120);
      g.scrollTop = Math.max(0, g.scrollHeight - 40);
      await sleep(300);
      if (loaded() === before) await sleep(400);
    }
    await waitFor(() => loaded() >= ${PLAIN_TOTAL + 1}, 'full window loads for the stack trip');
    // Windowing (>320 assets) mounts only the viewport's cards: walk down to
    // the stack card so it is a real, clickable node.
    for (let i = 0; i < 60 && !realCard('${coverId}'); i += 1) {
      const g = grid();
      g.scrollTop = Math.min(g.scrollHeight, g.scrollTop + g.clientHeight);
      await sleep(150);
    }
    await waitFor(() => realCard('${coverId}'), 'stack cover card loads');
    const coverEl = realCard('${coverId}');
    const g3 = grid();
    g3.scrollTop = g3.scrollTop + (coverEl.getBoundingClientRect().top - g3.getBoundingClientRect().top) - g3.clientHeight / 2 + coverEl.getBoundingClientRect().height / 2;
    await settle('stack cover centered');
    coverEl.click();
    await waitFor(() => selectedId() === '${coverId}', 'stack cover selected');
    const s1before = measure();
    if (!s1before.loaded || s1before.loaded < ${PLAIN_TOTAL}) throw new Error('root window not fully loaded before stack: ' + s1before.loaded);
    coverEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => loaded() === ${STACK_MEMBERS} && document.querySelector('.viewer-title'), 'stack view opens');
    await settle('stack view');
    const stackTop = Math.round(grid().scrollTop);
    if (stackTop !== 0) throw new Error('stack view did not start at the top: ' + stackTop);
    document.querySelectorAll('.toolbar-left button')[0].click();
    const backStarted = performance.now();
    await waitFor(() => grid() && !document.querySelector('.viewer-title'), 'back lands in the root gallery');
    await settle('after stack back');
    const backMs = Math.round(performance.now() - backStarted);
    const s1after = measure();
    if (s1after.loaded < s1before.loaded) throw new Error('stack back lost loaded cards: ' + s1after.loaded + ' < ' + s1before.loaded);
    assertSamePosition(s1before, s1after, 'stack back');
    if (selectedId() !== '${coverId}') throw new Error('stack back did not restore the focused cover: ' + selectedId());
    result.stackBack = { before: s1before, after: s1after, stackTop, selected: selectedId(), backMs, failed: false };

    // ── step 4: again, leaving through the blank-menu 返回素材库 ──
    const cover2 = realCard('${coverId}');
    cover2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => loaded() === ${STACK_MEMBERS} && document.querySelector('.viewer-title'), 'stack view reopens');
    await settle('stack view 2');
    const g4 = grid();
    const g4Rect = g4.getBoundingClientRect();
    const real4 = realCards();
    const contentBottom = real4.length ? real4[real4.length - 1].getBoundingClientRect().bottom - g4Rect.top : 0;
    const blankY = g4Rect.top + Math.min(g4.clientHeight - 40, contentBottom + 40);
    const blankX = g4Rect.right - 40;
    g4.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: blankX, clientY: blankY }));
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length > 0, 'blank menu opens');
    const backRow = Array.from(document.querySelectorAll('[role="menuitem"]'))
      .find((row) => (row.getAttribute('aria-label') || row.textContent || '').includes('返回素材库'));
    if (!backRow) throw new Error('返回素材库 missing from the stack blank menu');
    backRow.click();
    await waitFor(() => grid() && !document.querySelector('.viewer-title'), '返回素材库 lands in the root gallery');
    await settle('after 返回素材库');
    const s2after = measure();
    if (s2after.loaded < s1before.loaded) throw new Error('返回素材库 lost loaded cards: ' + s2after.loaded + ' < ' + s1before.loaded);
    assertSamePosition(s1before, s2after, '返回素材库');
    if (selectedId() !== '${coverId}') throw new Error('返回素材库 did not restore the focused cover: ' + selectedId());
    result.stackBlankMenu = { after: s2after, selected: selectedId(), failed: false };

    // ── step 5: sidebar group switch and back, plus back/forward ──
    grid().scrollTop = 2 * grid().clientHeight;
    await settle('group-step scroll');
    const g5before = measure();
    // A never-visited view that is itself tall (待整理 = 337 cards) must start
    // explicitly at the top, not inherit the outgoing scroll position.
    navButton('待整理').click();
    await waitFor(() => grid() && loaded() === ${PAGE}, '待整理 view loads its first page');
    await settle('待整理 view');
    const unorganizedTop = Math.round(grid().scrollTop);
    if (unorganizedTop !== 0) throw new Error('first 待整理 visit did not start at the top: ' + unorganizedTop);
    navButton('所有素材').click();
    await waitFor(() => grid() && loaded() > ${PAGE}, 'root gallery returns from 待整理');
    await settle('after 待整理 round-trip');
    const g5afterUnorganized = measure();
    assertSamePosition(g5before, g5afterUnorganized, '待整理 round-trip');
    navButton('${groupName}').click();
    await waitFor(() => loaded() === ${GROUP_MEMBERS}, 'group view loads');
    await settle('group view');
    const groupTop = Math.round(grid().scrollTop);
    if (groupTop !== 0) throw new Error('first group visit did not start at the top: ' + groupTop);
    navButton('所有素材').click();
    await waitFor(() => grid(), 'root gallery returns');
    await settle('after group -> all');
    const g5after = measure();
    assertSamePosition(g5before, g5after, 'sidebar group round-trip');
    document.querySelectorAll('.toolbar-left button')[0].click();
    await waitFor(() => loaded() === ${GROUP_MEMBERS}, 'back returns to the group');
    await settle('back to group');
    const groupTop2 = Math.round(grid().scrollTop);
    if (groupTop2 !== 0) throw new Error('group revisit did not stay at the top: ' + groupTop2);
    document.querySelectorAll('.toolbar-left button')[1].click();
    await waitFor(() => grid() && loaded() > ${GROUP_MEMBERS}, 'forward returns to all assets');
    await settle('forward to all');
    const g5after2 = measure();
    assertSamePosition(g5before, g5after2, 'forward back to all');
    result.groupSwitch = { before: g5before, after: g5after, afterForward: g5after2, groupTop, groupTop2, unorganizedTop, afterUnorganized: g5afterUnorganized, failed: false };

    // ── step 6: Pinterest out and back ──
    const p6before = measure();
    navButton('Pinterest').click();
    await waitFor(() => document.querySelector('.pinterest-guide'), 'Pinterest guide shows');
    navButton('所有素材').click();
    await waitFor(() => grid(), 'root gallery returns from Pinterest');
    await settle('after Pinterest round-trip');
    const p6after = measure();
    assertSamePosition(p6before, p6after, 'Pinterest round-trip');
    result.pinterest = { before: p6before, after: p6after, failed: false };

    return result;
  })()
  `;
}
