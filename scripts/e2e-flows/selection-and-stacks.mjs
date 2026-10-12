// Pluggable e2e flow: gallery multi-selection (Ctrl/Cmd toggle, Shift range,
// pointer marquee, Cmd/Ctrl+A), the unified context menus (selection heading,
// batch favorite / 添加分组 / 堆叠所选 — the bottom selection bar
// was removed by the context-menu unification; 任务 91 拿掉了菜单里的取消选择,
// Esc 是既有入口), then the full Stack lifecycle
// (stack-from-selection menu item, rename modal with empty-name rejection,
// enter / remove members via 移出堆叠 / return, restart persistence, dissolve
// from the stack-interior blank-area menu, Empty Trash from the trash
// blank-area menu through its confirm dialog). Seed via API, assert on
// returned page facts in Node, audit every mutation through the API, and
// restart the server on the same library before dissolving so the stack rename
// and membership are proven to persist.

import { existsSync } from "node:fs";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "selection-and-stacks";
export const description =
  "selection: ctrl-toggle/shift-range/marquee/select-all/esc-deselect -> batch favorite+move-to-group+stack-selected via context menu -> stack rename/empty-name/open/multi-remove/return -> restart -> in-stack blank dissolve -> trash blank empty-trash -> API audit";

// Menu labels verified against web/app/i18n.mjs (zh is the default locale;
// 任务 91：收藏/添加分组照稿子改文案，取消选择从多选菜单拿掉——Esc 是既有入口):
// addToFavorites=收藏, addToGroup=添加分组, stackSelected=堆叠所选,
// removeFromStack=移出堆叠, openStack=打开堆叠,
// renameStack=重命名堆叠, dissolveStack=解散堆叠, emptyTrash=清空回收站.
const MENU = {
  favorite: "收藏",
  addToGroup: "添加分组",
  stackSelected: "堆叠所选",
  removeFromStack: "移出堆叠",
  openStack: "打开堆叠",
  renameStack: "重命名堆叠",
  dissolveStack: "解散堆叠",
  emptyTrash: "清空回收站",
  moveToTrash: "移到回收站",
};

// In-page helpers specific to this flow, interpolated after PAGE_HELPERS.
const SELECTION_HELPERS = String.raw`
  // Gallery multi-selection marks cards with .multi-selected; .selected is
  // reserved for the single detail selection (cardSelectionFlags in
  // gallery-selection.mjs), so no card may carry .selected while a
  // multi-selection is active.
  const selectedCardIds = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
  const detailSelectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
  // 底部批量栏已移除：多选信息（已选 N 项）只在右键菜单的表头行里。
  const menuInfoText = () => document.querySelector('.context-menu-heading')?.textContent || '';
  const selectionBarAbsent = () => !document.querySelector('#selectionBar');
  const menuLabels = () => [...document.querySelectorAll('.context-menu .context-menu-label')].map((node) => node.textContent || '');
  const allToastTexts = () => [...document.querySelectorAll('.toast-message')].map((node) => node.textContent || '');
  const stackNodeSelector = (stackId) => '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(stackId) + '"]';
  const stackNodeTitle = (stackId) => document.querySelector(stackNodeSelector(stackId) + ' .asset-card-title')?.textContent || '';
  const stackNodeCount = (stackId) => document.querySelector(stackNodeSelector(stackId) + ' .asset-stack-count')?.textContent || '';
  // Ctrl/Cmd+click toggles a card into the multi-selection (handleCardClick in
  // gallery-selection.mjs tests metaKey || ctrlKey); both modifiers are set so
  // the gesture is platform-independent.
  function ctrlClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
  }
  // Plain Shift+click replaces the current selection with the anchor->target
  // range (selectRange with additive=false; the anchor is the last toggled
  // card), so Ctrl S1 -> Ctrl S3 -> Shift S5 yields exactly {S3,S4,S5}.
  function shiftClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }));
  }
  // Cmd/Ctrl+A is owned by the gallery keyboard router in app.mjs (document
  // keydown); the event target must not be a form field, so dispatch on
  // document itself.
  function selectAllKeyboard() {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'a', metaKey: true, ctrlKey: true }));
  }
  // Escape 由 document 捕获链消费（菜单开着=关菜单；否则=清选区/退出层级）。
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  }
  // Pointer-event marquee (gallery-selection.mjs): pointerdown in the gallery,
  // one pointermove past the 3px drag threshold, then pointerup (endPointer
  // applies the final rectangle synchronously). shiftKey makes the gesture
  // additive so several marquees can accumulate a selection.
  async function marqueeSelect(fromX, fromY, toX, toY, { shiftKey = false } = {}) {
    const grid = document.querySelector('#assetGrid');
    if (!grid) throw new Error('Missing #assetGrid');
    const init = { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: fromX, clientY: fromY, shiftKey };
    grid.dispatchEvent(new PointerEvent('pointerdown', init));
    window.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: toX, clientY: toY }));
    await sleep(90);
    window.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, clientX: toX, clientY: toY }));
    await sleep(40);
    // Failure diagnostics: what each individual marquee actually selected.
    marqueeLog.push({ from: [Math.round(fromX), Math.round(fromY)], to: [Math.round(toX), Math.round(toY)], shiftKey, selected: selectedCardIds().map((id) => id.slice(0, 12)) });
  }
  const marqueeLog = [];
  const cardRect = (assetId) => {
    const card = document.querySelector(cardSelector(assetId));
    if (!card) throw new Error('Missing card for ' + assetId);
    return card.getBoundingClientRect();
  };
  const rectsIntersect = (a, b) => a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
  // Frames the given cards with the shipped marquee: one rectangle when the
  // layout allows framing exactly the targets, otherwise a non-additive
  // marquee for the first target plus shift-additive marquees for the rest.
  // Either way the assertion is the resulting selection set.
  // Slow runners keep decoding images and re-flowing the masonry after the
  // gallery reports settled; Windows CI once measured S2 ~320px tall and then
  // framed the wrong cards once it shrank to 92px. Wait until every card image
  // is decoded and the card rects stop moving before measuring a marquee.
  async function waitForStableCardLayout(label) {
    const snapshot = () => JSON.stringify(rootCardIds().map((id) => {
      const r = cardRect(id);
      return [id, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
    }));
    const imagesReady = () => [...document.querySelectorAll('#assetGrid .asset-card img')]
      .every((img) => img.complete && img.naturalWidth > 0);
    let previous = '';
    let stableReads = 0;
    await waitFor(() => {
      if (!gallerySettled() || !imagesReady()) { stableReads = 0; previous = ''; return false; }
      const current = snapshot();
      stableReads = current === previous ? stableReads + 1 : 0;
      previous = current;
      return stableReads >= 3;
    }, label + ' (stable card layout)');
  }
  async function marqueeFrameExactly(targetIds) {
    await waitForStableCardLayout('marquee targets');
    const targets = targetIds.map((id) => ({ id, rect: cardRect(id) }));
    const allIds = rootCardIds();
    const inset = 3;
    const framedBy = (rect) => allIds.filter((id) => rectsIntersect(rect, cardRect(id)));
    const union = {
      left: Math.min(...targets.map((entry) => entry.rect.left)) + inset,
      right: Math.max(...targets.map((entry) => entry.rect.right)) - inset,
      top: Math.min(...targets.map((entry) => entry.rect.top)) + inset,
      bottom: Math.max(...targets.map((entry) => entry.rect.bottom)) - inset,
    };
    if (JSON.stringify(framedBy(union).sort()) === JSON.stringify([...targetIds].sort())) {
      await marqueeSelect(union.left, union.top, union.right, union.bottom);
      return 'single-rect';
    }
    for (const [index, entry] of targets.entries()) {
      // Re-measure right before each gesture: an earlier marquee re-renders
      // the selection and must not leave this one aiming at a stale rect.
      await waitForStableCardLayout('marquee target ' + (index + 1));
      const rect = cardRect(entry.id);
      await marqueeSelect(rect.left + inset, rect.top + inset, rect.right - inset, rect.bottom - inset, { shiftKey: index > 0 });
    }
    return 'additive-rects';
  }
  // Walks an open context menu down the labels array (parent items hover-open
  // their submenu, the last label is clicked). Exact .context-menu-label
  // matching so group/stack names never prefix-match each other.
  async function findMenuItem(label, parentLabel) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const items = [...document.querySelectorAll('.context-menu-item')];
      const match = items.find((entry) => !entry.disabled && entry.querySelector('.context-menu-label')?.textContent === label);
      if (match) return match;
      const parent = items.find((entry) => entry.querySelector('.context-menu-label')?.textContent === parentLabel);
      if (parent) parent.dispatchEvent(new MouseEvent('mouseenter'));
      await sleep(100);
    }
    throw new Error('Timed out waiting for menu item ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic()));
  }
  async function rightClickChoose(triggerSelector, labels) {
    let item = await openContextMenu(triggerSelector, labels[0]);
    for (let index = 1; index < labels.length; index += 1) {
      item.dispatchEvent(new MouseEvent('mouseenter'));
      item = await findMenuItem(labels[index], labels[index - 1]);
    }
    item.click();
  }
  // ===== 堆叠退出诊断（仅 Page 6 安装）=====
  // CI 偶发「返回根视图后缺移出成员」超时（任务 26 两轮排查未复现），超时时
  // 只有 pageDiagnostic 的通用字段，无法判断变更丢在哪一步。这里包一层
  // window.fetch 记录请求时序（gallery-rows 额外记录受影响行与响应行），
  // 配合「移出完成」「点返回前」两个时刻的状态快照，在超时错误里一并抛出。
  // 成功路径零输出；流程结束（成功或失败）由调用方 finally 还原 fetch。
  const T28 = { log: [], snapshots: {}, originalFetch: null, installed: false, t0: 0 };
  function t28InstallFetchProbe() {
    if (T28.installed) return;
    T28.installed = true;
    T28.t0 = performance.now();
    T28.originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      let path = String(typeof input === 'string' ? input : input?.url || '');
      const method = String(init?.method || (typeof input === 'object' ? input?.method : '') || 'GET').toUpperCase();
      try {
        const parsed = new URL(path, location.origin);
        for (const key of [...parsed.searchParams.keys()]) {
          if (key.toLowerCase().includes('token')) parsed.searchParams.delete(key);
        }
        path = parsed.pathname + parsed.search;
      } catch { path = path.slice(0, 120); }
      const record = { t: Math.round(performance.now() - T28.t0), method, path };
      const isRows = path.includes('/api/gallery-rows');
      if (isRows) {
        try {
          const body = JSON.parse(String(init?.body || '{}'));
          record.assetIds = Array.isArray(body?.assetIds) ? body.assetIds.slice(0, 24) : [];
          record.stackId = String(body?.request?.stackId || '');
          record.boundaryCursor = Boolean(body?.request?.boundaryCursor);
        } catch { /* 记录请求体失败不阻塞原请求 */ }
      }
      try {
        const response = await T28.originalFetch(input, init);
        record.status = response.status;
        if (isRows) {
          // 响应体异步解析：waitFor 超时（15s）远晚于解析完成，汇总时已就绪。
          void response.clone().json().then((payload) => {
            record.rows = (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => String(row?.id || ''));
            record.rowByAssetId = (payload?.rowByAssetId && typeof payload.rowByAssetId === 'object') ? payload.rowByAssetId : {};
          }).catch(() => {});
        }
        T28.log.push(record);
        if (T28.log.length > 40) T28.log.shift();
        return response;
      } catch (error) {
        record.status = 'error';
        T28.log.push(record);
        if (T28.log.length > 40) T28.log.shift();
        throw error;
      }
    };
  }
  function t28RestoreFetch() {
    if (!T28.installed) return;
    window.fetch = T28.originalFetch;
    T28.installed = false;
  }
  function t28GalleryState() {
    return {
      rootIds: rootCardIds(),
      ariaBusy: document.querySelector('#assetGrid')?.getAttribute('aria-busy') ?? null,
      baseline: window.__mosa?.librarySync?.baseline?.() ?? null,
    };
  }
  // 超时汇总：单行 JSON ≤6KB，超长时丢请求记录的最旧段（保留最近的时序）。
  function t28Summary() {
    const summary = { snapshots: T28.snapshots, now: t28GalleryState(), requests: T28.log };
    let text = JSON.stringify(summary);
    while (text.length > 6000 && summary.requests.length > 1) {
      summary.requests.shift();
      text = JSON.stringify(summary);
    }
    return text.length > 6000 ? text.slice(0, 6000) : text;
  }
`;

function source(config, body) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const MENU = ${JSON.stringify(MENU)};
    ${PAGE_HELPERS}
    ${SELECTION_HELPERS}
    ${body}
  })()`;
}

function expect(condition, message) {
  if (!condition) throw new Error(`selection-and-stacks: ${message}`);
}

const sameMembers = (actual, expected) => JSON.stringify([...(actual || [])].sort()) === JSON.stringify([...expected].sort());

export async function run(ctx) {
  await ctx.prepare();
  let ids;
  let imagePaths;
  const first = await ctx.startServer();
  try {
    // ===== Seed via API: S1-S6 ungrouped + group S-Target =====
    const seedAsset = async (fileName, [r, g, b], prompt) => {
      const imagePath = await ctx.makePng(fileName, [r, g, b]);
      const response = await ctx.api(first.origin, "POST", "/api/assets/create", { projectId: "default", imagePath, prompt });
      return { id: response.asset.id, imagePath: response.asset.image_path };
    };
    const s1 = await seedAsset("selection-s1.png", [220, 68, 74], "selection flow S1");
    const s2 = await seedAsset("selection-s2.png", [74, 181, 92], "selection flow S2");
    const s3 = await seedAsset("selection-s3.png", [240, 180, 40], "selection flow S3");
    const s4 = await seedAsset("selection-s4.png", [108, 92, 231], "selection flow S4");
    const s5 = await seedAsset("selection-s5.png", [58, 138, 87], "selection flow S5");
    const s6 = await seedAsset("selection-s6.png", [138, 90, 47], "selection flow S6");
    await ctx.api(first.origin, "POST", "/api/groups", { projectId: "default", name: "S-Target" });
    ids = { s1: s1.id, s2: s2.id, s3: s3.id, s4: s4.id, s5: s5.id, s6: s6.id, groupName: "S-Target", stackName: "S-Stack" };
    imagePaths = { s3: s3.imagePath, s4: s4.imagePath };

    // ===== Page 1: ctrl toggle + shift range + menu deselect + select-all =====
    const p1 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'six seeded cards');
      // 任务 93：「剪切」从 91 的禁用占位转正——单张可用，点击后 S1 变淡
      // （.is-cut），Esc 先取消剪切（卡片恢复），再按一次才清选区。
      const cutItem = await openContextMenu(cardSelector(config.s1), '剪切');
      const cutDisabled = cutItem.disabled || cutItem.classList.contains('disabled');
      cutItem.click();
      await sleep(80);
      const cutMenuClosed = !document.querySelector('.context-menu');
      await waitFor(() => document.querySelector(cardSelector(config.s1))?.classList.contains('is-cut'), 'S1 dimmed after cut');
      const cutToastAbsent = allToastTexts().length === 0;
      pressEscape();
      await waitFor(() => !document.querySelector(cardSelector(config.s1))?.classList.contains('is-cut'), 'Esc cancels the cut (S1 back to normal)');
      pressEscape();
      await waitFor(() => selectedCardIds().length === 0, 'selection cleared after the cut probe');
      ctrlClickCard(config.s1);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1]), 'S1 selected');
      ctrlClickCard(config.s3);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1, config.s3].sort()), 'S1+S3 selected');
      shiftClickCard(config.s5);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s3, config.s4, config.s5].sort()), 'range S3..S5 selected');
      const multiSelected = selectedCardIds();
      const detailSelectionDuringMulti = detailSelectedId();
      // 右键菜单统一：底部批量栏不存在，选区信息只出现在菜单表头行。
      const barAbsent = selectionBarAbsent();
      // 任务 91：取消选择从多选菜单拿掉（⌘A/Esc 是既有入口）。表头读数改经
      // 收藏项开菜单；Esc 第一下关菜单（菜单打开期间 Esc 归菜单），第二下清选区。
      await openContextMenu(cardSelector(config.s3), MENU.favorite);
      const infoAfterMulti = menuInfoText();
      pressEscape();
      pressEscape();
      await waitFor(() => selectedCardIds().length === 0, 'Esc clears the range selection');
      selectAllKeyboard();
      await waitFor(() => selectedCardIds().length === 6, 'Cmd/Ctrl+A selects all six');
      await openContextMenu(cardSelector(config.s1), MENU.favorite);
      const infoAfterSelectAll = menuInfoText();
      pressEscape();
      pressEscape();
      await waitFor(() => selectedCardIds().length === 0, 'Esc clears the select-all');
      return { multiSelected, barAbsent, infoAfterMulti, detailSelectionDuringMulti, infoAfterSelectAll, cutDisabled, cutMenuClosed, cutToastAbsent };
    `));
    expect(sameMembers(p1.multiSelected, [ids.s3, ids.s4, ids.s5]), `P1 shift-range selection: ${JSON.stringify(p1.multiSelected)}`);
    expect(p1.barAbsent === true, `P1 selection bar removed from DOM: ${p1.barAbsent}`);
    expect(p1.infoAfterMulti === "已选 3 项", `P1 menu selection heading: ${p1.infoAfterMulti}`);
    // 任务单写的是 .selected，但 shipped 代码里多选卡片带 .multi-selected，
    // .selected 只用于详情单选（gallery-selection.mjs cardSelectionFlags）。
    expect(p1.detailSelectionDuringMulti === "", `P1 no .selected card during multi-select: ${p1.detailSelectionDuringMulti}`);
    expect(p1.infoAfterSelectAll === "已选 6 项", `P1 select-all menu heading: ${p1.infoAfterSelectAll}`);
    expect(p1.cutDisabled === false, `P1 cut item is enabled after 任务 93: ${JSON.stringify(p1)}`);
    expect(p1.cutMenuClosed === true, `P1 clicking the enabled cut item closes the menu and cuts: ${JSON.stringify(p1)}`);
    expect(p1.cutToastAbsent === true, `P1 cutting raises no toast (dim + a11y announce only): ${JSON.stringify(p1)}`);

    // ===== Page 2: marquee frames exactly S2+S4 =====
    const p2 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'gallery before marquee');
      await sleep(150);
      const marqueeStrategy = await marqueeFrameExactly([config.s2, config.s4]);
      try {
        await waitFor(() => gallerySettled() && JSON.stringify(selectedCardIds()) === JSON.stringify([config.s2, config.s4].sort()), 'marquee selects exactly S2+S4');
      } catch (error) {
        const grid = document.querySelector('#assetGrid')?.getBoundingClientRect();
        const rects = Object.fromEntries(rootCardIds().map((id) => { const r = cardRect(id); return [id.slice(0, 14), [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]]; }));
        // Masonry placement drives the selection geometry snapshot; compare it
        // with the rendered rects above to spot a stale layout.
        const placement = Object.fromEntries(rootCardIds().map((id) => { const s = document.querySelector(cardSelector(id))?.style; return [id.slice(0, 12), s ? [s.gridColumnStart, s.gridRowStart, s.gridRowEnd] : null]; }));
        const gridStyle = getComputedStyle(document.querySelector('#assetGrid'));
        throw new Error(error.message + ' marquee=' + JSON.stringify({ marqueeStrategy, marqueeLog, selected: selectedCardIds(), grid: grid && [Math.round(grid.left), Math.round(grid.top), Math.round(grid.right), Math.round(grid.bottom)], viewport: [innerWidth, innerHeight, devicePixelRatio], gridScroll: document.querySelector('#assetGrid')?.scrollTop, columns: gridStyle.gridTemplateColumns, padding: [gridStyle.paddingLeft, gridStyle.paddingTop], rects, placement }));
      }
      const selected = selectedCardIds();
      await openContextMenu(cardSelector(config.s2), MENU.favorite);
      const infoText = menuInfoText();
      const barAbsent = selectionBarAbsent();
      pressEscape();
      pressEscape();
      await waitFor(() => selectedCardIds().length === 0, 'Esc clears the marquee selection');
      return { marqueeStrategy, selected, infoText, barAbsent };
    `));
    expect(sameMembers(p2.selected, [ids.s2, ids.s4]), `P2 marquee selection: ${JSON.stringify(p2.selected)}`);
    expect(p2.barAbsent === true && p2.infoText === "已选 2 项", `P2 marquee menu heading: ${p2.barAbsent} ${p2.infoText}`);

    // ===== Page 3: batch favorite + move to group via the multi-selection menu =====
    const p3 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'gallery before batch actions');
      ctrlClickCard(config.s1);
      await waitFor(() => selectedCardIds().length === 1, 'S1 selected for batch');
      ctrlClickCard(config.s2);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s1, config.s2].sort()), 'S1+S2 selected for batch');
      await rightClickChoose(cardSelector(config.s1), [MENU.favorite]);
      await waitFor(() => allToastTexts().some((text) => text.includes('收藏状态已更新')), 'batch favorite toast');
      await rightClickChoose(cardSelector(config.s1), [MENU.addToGroup, config.groupName]);
      await waitFor(() => allToastTexts().some((text) => text.includes('已移动到分组')), 'batch move-to-group toast');
      return { selectionAfterBatch: selectedCardIds() };
    `));
    expect(sameMembers(p3.selectionAfterBatch, [ids.s1, ids.s2]), `P3 selection survives batch actions: ${JSON.stringify(p3.selectionAfterBatch)}`);
    const listed = (await ctx.api(first.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const byId = new Map(listed.map((asset) => [asset.id, asset]));
    expect(byId.get(ids.s1)?.favorite === true && byId.get(ids.s2)?.favorite === true, `audit favorite S1/S2: ${JSON.stringify([byId.get(ids.s1)?.favorite, byId.get(ids.s2)?.favorite])}`);
    expect(byId.get(ids.s1)?.group === "S-Target" && byId.get(ids.s2)?.group === "S-Target", `audit group S1/S2: ${JSON.stringify([byId.get(ids.s1)?.group, byId.get(ids.s2)?.group])}`);
    expect([ids.s3, ids.s4, ids.s5, ids.s6].every((id) => byId.get(id)?.favorite === false && byId.get(id)?.group === ""), "audit S3-S6 untouched by the batch");

    // ===== Page 4: stack S2+S3+S4+S5 from the 堆叠所选 menu item =====
    // Four members so Page 6 can multi-select and remove two while the stack
    // survives (the server auto-dissolves a stack below two members).
    const p4 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'root gallery before stacking');
      ctrlClickCard(config.s2);
      await waitFor(() => selectedCardIds().length === 1, 'S2 selected for stack');
      ctrlClickCard(config.s3);
      await waitFor(() => selectedCardIds().length === 2, 'S2+S3 selected for stack');
      ctrlClickCard(config.s4);
      await waitFor(() => selectedCardIds().length === 3, 'S2+S3+S4 selected for stack');
      ctrlClickCard(config.s5);
      await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s2, config.s3, config.s4, config.s5].sort()), 'S2..S5 selected for stack');
      const rootCountBeforeStack = rootCardIds().length;
      await rightClickChoose(cardSelector(config.s3), [MENU.stackSelected]);
      const stackCard = await waitFor(() => document.querySelector('#assetGrid > .asset-card.is-stack'), 'Stack node appears');
      const stackId = stackCard.dataset.stackId;
      await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'root loses three cards (4 members -> 1 node)');
      return {
        stackId,
        coverId: stackCard.dataset.id,
        stackCountShown: stackCard.querySelector('.asset-stack-count')?.textContent || '',
        rootCountBeforeStack,
        rootCountAfterStack: rootCardIds().length,
        selectionAfterStack: selectedCardIds(),
      };
    `));
    expect(typeof p4.stackId === "string" && p4.stackId.startsWith("stack-"), `P4 stack id: ${p4.stackId}`);
    expect([ids.s2, ids.s3, ids.s4, ids.s5].includes(p4.coverId), `P4 stack cover is a member: ${p4.coverId}`);
    expect(p4.stackCountShown === "4", `P4 stack count badge: ${p4.stackCountShown}`);
    expect(p4.rootCountBeforeStack === 6 && p4.rootCountAfterStack === 3, `P4 root count 6 -> 3: ${p4.rootCountBeforeStack} -> ${p4.rootCountAfterStack}`);
    expect(p4.selectionAfterStack.length === 0, `P4 stacking clears the selection: ${JSON.stringify(p4.selectionAfterStack)}`);
    ids.stackId = p4.stackId;

    // ===== Page 5: rename via the modal, then an empty name must be rejected =====
    const p5 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => document.querySelector(stackNodeSelector(config.stackId)), 'Stack node before rename');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.renameStack]);
      await waitFor(() => document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal opens');
      setValue('#stackRenameInput', config.stackName);
      click('#saveStackRenameBtn');
      await waitFor(() => !document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal closes');
      await waitFor(() => stackNodeTitle(config.stackId) === config.stackName, 'node title shows S-Stack');
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.renameStack]);
      await waitFor(() => document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal reopens');
      setValue('#stackRenameInput', '');
      click('#saveStackRenameBtn');
      await waitFor(() => allToastTexts().some((text) => text.includes('堆叠名称不能为空')), 'empty-name rejected toast');
      const modalStillOpenAfterEmpty = document.querySelector('#stackRenameModal')?.classList.contains('open') || false;
      const titleAfterEmptyAttempt = stackNodeTitle(config.stackId);
      click('#cancelStackRenameBtn');
      await waitFor(() => !document.querySelector('#stackRenameModal')?.classList.contains('open'), 'rename modal cancelled');
      return { titleAfterRename: stackNodeTitle(config.stackId), modalStillOpenAfterEmpty, titleAfterEmptyAttempt };
    `));
    expect(p5.titleAfterRename === "S-Stack", `P5 renamed node title: ${p5.titleAfterRename}`);
    expect(p5.modalStillOpenAfterEmpty === true, `P5 modal stays open on empty name: ${p5.modalStillOpenAfterEmpty}`);
    expect(p5.titleAfterEmptyAttempt === "S-Stack", `P5 empty name not saved: ${p5.titleAfterEmptyAttempt}`);

    // ===== Page 6: open the stack, multi-select members and 移出堆叠, return =====
    let p6;
    try {
      p6 = await ctx.runInPage(first, source(ids, `
      t28InstallFetchProbe();
      try {
        await waitFor(() => document.querySelector(stackNodeSelector(config.stackId)), 'Stack node before opening');
        await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.openStack]);
        await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack view');
        const memberIdsInside = rootCardIds();
        const viewTitleInside = document.querySelector('#viewTitle')?.textContent || '';
        // 任务单：进堆叠多选成员 -> 右键“移出堆叠”（S4+S5 一起移出，剩 S2+S3）。
        ctrlClickCard(config.s4);
        await waitFor(() => selectedCardIds().length === 1, 'S4 selected inside stack');
        ctrlClickCard(config.s5);
        await waitFor(() => JSON.stringify(selectedCardIds()) === JSON.stringify([config.s4, config.s5].sort()), 'S4+S5 selected inside stack');
        await rightClickChoose(cardSelector(config.s4), [MENU.removeFromStack]);
        await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds().sort()) === JSON.stringify([config.s2, config.s3].sort()), 'S4+S5 removed, S2+S3 left');
        T28.snapshots.afterRemove = t28GalleryState();
        // The member count in the header refreshes in the background after an
        // in-place removal; it must not keep the count captured on entry.
        const viewTitleAfterRemove = await waitFor(() => {
          const title = document.querySelector('#viewTitle')?.textContent || '';
          return title.includes('S-Stack') && title.includes('2') && !title.includes('4') ? title : '';
        }, 'stack title member count after removal');
        const removeToast = allToastTexts().find((text) => text.includes('已从堆叠移出')) || '';
        T28.snapshots.beforeBack = t28GalleryState();
        click('#navHistoryBack');
        try {
          await waitFor(() => gallerySettled() && rootCardIds().length === 5
            && document.querySelector(cardSelector(config.s4))
            && document.querySelector(cardSelector(config.s5))
            && stackNodeCount(config.stackId) === '2', 'back at root with S4+S5 restored');
        } catch (error) {
          throw new Error(error.message + ' stackExitDiagnostics=' + t28Summary());
        }
        const nodeCard = document.querySelector(stackNodeSelector(config.stackId));
        return { memberIdsInside, viewTitleInside, viewTitleAfterRemove, removeToast, rootIdsAfterBack: rootCardIds(), nodeIdAfterBack: nodeCard?.dataset.id || '' };
      } finally {
        t28RestoreFetch();
      }
    `));
    } catch (error) {
      // 任务 28：页面超时（根视图缺 S5）时在 Node 端补服务端事实，区分
      // 「服务端就没有 S5」与「前端没画出来」。首屏查询参数与前端 loadAssets
      // 的首屏请求一致（buildAssetPageParams：project/q/limit=60/sort + view=gallery）。
      const audit = { serverRootIds: null, serverStack: null, auditError: "" };
      try {
        const page = await ctx.api(first.origin, "GET", "/api/assets?project=default&q=&limit=60&sort=newest&view=gallery");
        audit.serverRootIds = (page?.assets || []).map((asset) => asset.id);
      } catch (apiError) {
        audit.auditError = String(apiError?.message || apiError).slice(0, 160);
      }
      try {
        const summary = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}?project=default`);
        audit.serverStack = summary?.stack
          ? { id: summary.stack.id, name: summary.stack.name, count: summary.stack.count }
          : null;
      } catch (apiError) {
        audit.auditError = String(apiError?.message || apiError).slice(0, 160);
      }
      throw new Error(`selection-and-stacks Page 6 failed; serverAudit=${JSON.stringify(audit)}`, { cause: error });
    }
    expect(sameMembers(p6.memberIdsInside, [ids.s2, ids.s3, ids.s4, ids.s5]), `P6 stack interior: ${JSON.stringify(p6.memberIdsInside)}`);
    expect(p6.viewTitleInside.includes("S-Stack") && p6.viewTitleInside.includes("4"), `P6 view title inside stack: ${p6.viewTitleInside}`);
    expect(p6.viewTitleAfterRemove.includes("S-Stack") && p6.viewTitleAfterRemove.includes("2"), `P6 view title after removal: ${p6.viewTitleAfterRemove}`);
    expect(p6.removeToast.includes("已从堆叠移出") && p6.removeToast.includes("2"), `P6 remove toast: ${p6.removeToast}`);
    expect(sameMembers(p6.rootIdsAfterBack, [ids.s1, ids.s4, ids.s5, ids.s6, p6.nodeIdAfterBack]), `P6 root after return: ${JSON.stringify(p6.rootIdsAfterBack)}`);
    expect(p6.rootIdsAfterBack.includes(ids.s4) && p6.rootIdsAfterBack.includes(ids.s5), `P6 S4+S5 back at root: ${JSON.stringify(p6.rootIdsAfterBack)}`);

    // ===== API audit of the stack before the restart =====
    const stackSummary = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}?project=default`);
    expect(stackSummary?.stack?.name === "S-Stack" && stackSummary?.stack?.count === 2, `audit stack summary: ${JSON.stringify(stackSummary?.stack)}`);
    const stackMembers = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}/assets?project=default&limit=250`);
    expect(sameMembers((stackMembers?.assets || []).map((asset) => asset.id), [ids.s2, ids.s3]), `audit stack members: ${JSON.stringify(stackMembers?.assets?.map((asset) => asset.id))}`);

    // ===== Page 6.5: search flattens the stack; clearing the query restores it =====
    // 任务 83：搜索框有词时结果按单图平铺、不合成堆叠，清空后堆叠回来。搜索词
    // 取堆叠非封面成员的编号（封面命中时 store 平铺路径仍会给封面行附 stack 封面
    // 注解，前端会渲染成堆叠节点——该口子已单独上报）。等待全部走 gallerySettled，
    // 输入防抖由 waitFor 轮询消化，不写固定 sleep。
    // 搜索词用文件名主干（selection-s2 / selection-s3），不用两个字的 "S2" / "S3"：
    // 搜索会匹配素材的原始导入路径，而导入路径在随机命名的临时目录里
    // （mosa-critical-e2e-XXXXXX），目录名碰巧含 "S3" 时六张图全部命中（CI 上出过）。
    ids.stackCoverId = p6.nodeIdAfterBack;
    ids.searchTargetId = ids.stackCoverId === ids.s2 ? ids.s3 : ids.s2;
    ids.searchToken = ids.searchTargetId === ids.s2 ? "selection-s2" : "selection-s3";
    const p65 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && document.querySelector(stackNodeSelector(config.stackId)), 'root gallery before search flattening');
      setValue('#searchInput', config.searchToken);
      await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify([config.searchTargetId]),
        'search lists the single matching member flat');
      const searchedCard = document.querySelector(cardSelector(config.searchTargetId));
      const searchState = {
        rootIds: rootCardIds(),
        isStack: searchedCard?.classList.contains('is-stack') || false,
        badge: searchedCard?.querySelector('.asset-stack-count')?.textContent || '',
        anyStackNode: Boolean(document.querySelector('#assetGrid > .asset-card.is-stack')),
      };
      setValue('#searchInput', '');
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && Boolean(document.querySelector(stackNodeSelector(config.stackId))), 'clearing the search restores the stack node');
      return { ...searchState, countAfterClear: stackNodeCount(config.stackId) };
    `));
    expect(sameMembers(p65.rootIds, [ids.searchTargetId]), `P6.5 search result is the single member card: ${JSON.stringify(p65.rootIds)}`);
    expect(p65.isStack === false && p65.anyStackNode === false, `P6.5 search renders a flat card, no stack node: ${JSON.stringify(p65)}`);
    expect(p65.badge === "", `P6.5 no stack badge while searching: ${JSON.stringify(p65.badge)}`);
    expect(p65.countAfterClear === "2", `P6.5 stack node restored with count 2: ${p65.countAfterClear}`);
  } finally {
    await first.stop();
  }

  // ===== Restart on the same library: name + membership persist, then dissolve =====
  const second = await ctx.startServer();
  try {
    const p7 = await ctx.runInPage(second, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 5
        && document.querySelector(stackNodeSelector(config.stackId)), 'root gallery restored after restart');
      const titleAfterRestart = stackNodeTitle(config.stackId);
      const countAfterRestart = stackNodeCount(config.stackId);
      await rightClickChoose(stackNodeSelector(config.stackId) + ' .asset-card-select', [MENU.openStack]);
      await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack after restart');
      const memberIdsAfterRestart = rootCardIds();
      const viewTitleAfterRestart = document.querySelector('#viewTitle')?.textContent || '';
      // 任务单：堆叠内部空白处右键 -> “解散堆叠”（确认框照旧），解散后直接
      // 退回素材库，不需要先点返回。
      const blankItem = await openContextMenu('#assetGrid', MENU.dissolveStack);
      const blankMenuLabels = menuLabels();
      blankItem.click();
      const dissolveConfirmText = await answerConfirmDialog({ confirm: true });
      await waitFor(() => allToastTexts().some((text) => text.includes('已解散堆叠')), 'dissolve toast');
      const dissolveToast = allToastTexts().find((text) => text.includes('已解散堆叠')) || '';
      // Let the shipped incremental reconciliation settle, then capture the
      // gallery state as the user sees it right after the dissolve.
      await waitFor(() => gallerySettled() && rootCardIds().length === 6, 'six root entries after dissolve');
      const captureCards = () => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => ({
        id: card.dataset.id,
        isStack: card.classList.contains('is-stack'),
        badge: card.querySelector('.asset-stack-count')?.textContent || '',
        title: card.querySelector('.asset-card-title')?.textContent || '',
      }));
      const cardsAfterDissolve = captureCards();
      return {
        titleAfterRestart, countAfterRestart, memberIdsAfterRestart, viewTitleAfterRestart,
        blankMenuLabels, dissolveConfirmText, dissolveToast, cardsAfterDissolve,
        rootIdsAfterDissolve: rootCardIds(),
      };
    `));
    // 任务单要求：重启后 Stack 仍叫 S-Stack，成员是 S2、S3（P6 已移出 S4/S5）。
    expect(p7.titleAfterRestart === "S-Stack", `restart node title: ${p7.titleAfterRestart}`);
    expect(p7.countAfterRestart === "2", `restart node count badge: ${p7.countAfterRestart}`);
    expect(sameMembers(p7.memberIdsAfterRestart, [ids.s2, ids.s3]), `restart stack members: ${JSON.stringify(p7.memberIdsAfterRestart)}`);
    expect(p7.viewTitleAfterRestart.includes("S-Stack") && p7.viewTitleAfterRestart.includes("2"), `restart view title: ${p7.viewTitleAfterRestart}`);
    // 堆叠内部空白处菜单：没有“新建分组”，有重命名/解散/返回素材库。
    expect(p7.blankMenuLabels.includes("新建分组并移入") === false && p7.blankMenuLabels.includes("添加分组") === false,
      `stack blank menu must not offer group creation: ${JSON.stringify(p7.blankMenuLabels)}`);
    expect(p7.blankMenuLabels.includes("重命名堆叠") && p7.blankMenuLabels.includes("解散堆叠") && p7.blankMenuLabels.includes("返回素材库"),
      `stack blank menu contents: ${JSON.stringify(p7.blankMenuLabels)}`);
    expect(p7.dissolveConfirmText.includes("不会删除"), `dissolve confirm text: ${p7.dissolveConfirmText}`);
    expect(p7.dissolveToast.includes("2"), `dissolve toast contains "2": ${p7.dissolveToast}`);
    expect(sameMembers(p7.rootIdsAfterDissolve, [ids.s1, ids.s2, ids.s3, ids.s4, ids.s5, ids.s6]), `root after dissolve: ${JSON.stringify(p7.rootIdsAfterDissolve)}`);

    // ===== API audit: members released as standalone assets, nothing deleted or trashed =====
    const finalListed = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    const finalById = new Map(finalListed.map((asset) => [asset.id, asset]));
    expect(finalListed.length === 6, `audit six assets after dissolve: ${finalListed.length}`);
    expect([ids.s3, ids.s4].every((id) => finalById.get(id) && !finalById.get(id).stack), "audit S3/S4 have no stack after dissolve");
    expect(finalById.get(ids.s1)?.favorite === true && finalById.get(ids.s1)?.group === "S-Target", "audit S1 favorite/group persist across restart");
    const trashListed = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250&trash=1")).assets || [];
    expect(trashListed.length === 0, `audit trash empty after dissolve: ${JSON.stringify(trashListed.map((asset) => asset.id))}`);
    let stackGone = false;
    try {
      await ctx.api(second.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackId)}?project=default`);
    } catch {
      stackGone = true;
    }
    expect(stackGone === true, "audit stack record removed after dissolve");
    expect(existsSync(imagePaths.s3) && existsSync(imagePaths.s4), "audit S3/S4 managed files still on disk");

    // ===== 任务单第 8 步的界面断言：S3、S4 回到根层级成为"独立素材"。=====
    // Covers the incremental commit of a dissolved Stack whose cover was
    // removed earlier: the node row turns into a plain row with a different
    // sort key, which must be re-rendered, not just moved.
    expect(
      (p7.cardsAfterDissolve || []).some((card) => card.id === ids.s3 && !card.isStack)
        && (p7.cardsAfterDissolve || []).some((card) => card.id === ids.s4 && !card.isStack)
        && !(p7.cardsAfterDissolve || []).some((card) => card.isStack),
      `dissolve leaves a ghost stack node (cards=${JSON.stringify(p7.cardsAfterDissolve)})`,
    );

    // ===== Page 8: trash two assets, then Empty Trash from the blank-area menu =====
    await ctx.api(second.origin, "POST", "/api/assets/batch", {
      action: "trash", projectId: "default", assetIds: [ids.s4, ids.s5],
    });
    const p8 = await ctx.runInPage(second, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'four root cards after trashing S4+S5');
      click('#quickFilters .nav-item[data-filter="trash"]');
      await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'trash lists the two trashed assets');
      // 回收站空白处菜单：全选、刷新 ｜ 清空回收站；不得再出现“添加分组”
      //（标签在 Node 端断言）。
      const emptyItem = await openContextMenu('#assetGrid', MENU.emptyTrash);
      const trashMenuLabels = menuLabels();
      emptyItem.click();
      const emptyConfirmText = await answerConfirmDialog({ confirm: true });
      await waitFor(() => allToastTexts().some((text) => text.includes('回收站已清空')), 'trash emptied toast');
      await waitFor(() => gallerySettled() && rootCardIds().length === 0, 'trash grid empty after empty-trash');
      return { trashMenuLabels, emptyConfirmText };
    `));
    expect(p8.trashMenuLabels.includes("添加分组") === false,
      `trash blank menu must not offer group creation: ${JSON.stringify(p8.trashMenuLabels)}`);
    expect(p8.trashMenuLabels.includes(MENU.emptyTrash),
      `trash blank menu surfaces Empty Trash: ${JSON.stringify(p8.trashMenuLabels)}`);
    expect(p8.emptyConfirmText.includes("无法恢复"), `empty-trash confirm text: ${p8.emptyConfirmText}`);
    const trashAfterEmpty = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250&trash=1")).assets || [];
    expect(trashAfterEmpty.length === 0, `audit trash emptied: ${JSON.stringify(trashAfterEmpty.map((asset) => asset.id))}`);
    const aliveAfterEmpty = (await ctx.api(second.origin, "GET", "/api/assets?project=default&limit=250")).assets || [];
    expect(sameMembers(aliveAfterEmpty.map((asset) => asset.id), [ids.s1, ids.s2, ids.s3, ids.s6]),
      `audit only S4/S5 permanently deleted: ${JSON.stringify(aliveAfterEmpty.map((asset) => asset.id))}`);

    // ===== Page 9 (任务 94 / A4f): 右键多选移至回收站 → 撤销 → 几张都回来 =====
    // 勾「不再提醒」后再删不弹框；每次成功移入回收站都弹带撤销的 toast；撤销
    // 经现有 restore 端点恢复本次移走的那几张。结束前清掉 localStorage 键。
    // 任务 108：撤销提示在移动请求完成那一刻弹出并开始 6 秒计时，画廊刷新在这
    // 之后才结束——CI 慢跑器上「先等画廊、再找提示」可能等过 6 秒（10-09 挂了
    // 4 次）。两轮都改成点「移到回收站」之前先装 watchToasts 记录器；「出现过
    // 撤销提示」看记录而不是看它此刻还在不在；按钮靠 toast-manager 自带的
    // hover 暂停保活，点的时候一定还在。三个时间点记入 trashTimeline（每轮
    // 相对各自 watchToasts 安装点），任何超时错误都带上它与 toastEvents 记录。
    const p9 = await ctx.runInPage(second, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'four root cards before the trash-undo phase');
      pressEscape();
      await waitFor(() => selectedCardIds().length === 0, 'clean selection before the trash-undo phase');
      const undoAppearEvent = () => toastEventLog().find((entry) => entry.event === 'appear' && entry.lane === 'polite' && entry.hasAction) || null;
      const trashTimeline = [];
      const trashMark = (label) => trashTimeline.push(label + '@' + toastClock() + 'ms');
      const clickUndo = async (label) => {
        const button = await waitFor(() => document.querySelector('#toastContainer .toast.is-visible .toast-action'), label);
        button.click();
      };
      try {
        ctrlClickCard(config.s1);
        await waitFor(() => selectedCardIds().length === 1, 'S1 selected for trash');
        ctrlClickCard(config.s2);
        await waitFor(() => selectedCardIds().length === 2, 'S1+S2 selected for trash');
        watchToasts({ keepAliveActionToasts: true });
        const trashItem = await openContextMenu(cardSelector(config.s1), MENU.moveToTrash);
        trashMark('r1.menuClicked');
        trashItem.click();
        await waitFor(() => document.querySelector('#confirmDialog')?.classList.contains('open'), 'multi trash confirm opens');
        const confirm = {
          title: (document.querySelector('#confirmDialogTitle')?.textContent || '').trim(),
          cancelLabel: (document.querySelector('#confirmDialogCancel')?.textContent || '').trim(),
          confirmLabel: (document.querySelector('#confirmDialogConfirm')?.textContent || '').trim(),
          checkboxRowVisible: !document.querySelector('#confirmDialogDontAsk')?.hidden,
        };
        document.querySelector('#confirmDialogDontAskCheckbox').click();
        confirm.checkedAfterClick = document.querySelector('#confirmDialogDontAskCheckbox')?.checked === true;
        document.querySelector('#confirmDialogConfirm').click();
        await waitFor(() => !document.querySelector('#confirmDialog')?.classList.contains('open'), 'multi trash confirm closes');
        await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'S1+S2 leave the gallery after trash');
        trashMark('r1.galleryAtTwo');
        // 「出现过撤销提示」看记录（记录里有首个撤销提示及其按钮文案），不要求它此刻仍在。
        const undoSeen = await waitFor(undoAppearEvent, 'undo toast never appeared (confirm round; watching #toastContainer since before the click)');
        trashMark('r1.undoToastSeen');
        confirm.toastMessage = undoSeen.text;
        confirm.toastActionLabel = undoSeen.actionLabel;
        await clickUndo('undo toast action stays clickable after the gallery refresh (hover keep-alive)');
        await waitFor(() => gallerySettled() && rootCardIds().length === 4
          && document.querySelector(cardSelector(config.s1)) && document.querySelector(cardSelector(config.s2)),
          'undo restores both trashed assets');
        confirm.storedAfterDontAsk = localStorage.getItem('mosa.confirm-move-to-trash');

        // 勾过不再提醒：再来一次不弹框直接删。
        pressEscape();
        await waitFor(() => selectedCardIds().length === 0, 'selection cleared before the suppressed run');
        ctrlClickCard(config.s1);
        await waitFor(() => selectedCardIds().length === 1, 'S1 re-selected for the suppressed run');
        ctrlClickCard(config.s2);
        await waitFor(() => selectedCardIds().length === 2, 'S1+S2 re-selected for the suppressed run');
        watchToasts({ keepAliveActionToasts: true }); // 重置记录，第二轮从点击前重新观察
        const trashItem2 = await openContextMenu(cardSelector(config.s1), MENU.moveToTrash);
        trashMark('r2.menuClicked');
        trashItem2.click();
        await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'suppressed multi trash removes both without a dialog');
        trashMark('r2.galleryAtTwo');
        const dialogNeverOpened = !document.querySelector('#confirmDialog')?.classList.contains('open');
        const undoSeen2 = await waitFor(undoAppearEvent, 'undo toast never appeared (suppressed round; watching #toastContainer since before the click)');
        trashMark('r2.undoToastSeen');
        confirm.toastMessageSuppressed = undoSeen2.text;
        confirm.toastActionLabelSuppressed = undoSeen2.actionLabel;
        await clickUndo('undo toast action stays clickable after the gallery refresh (hover keep-alive, suppressed run)');
        await waitFor(() => gallerySettled() && rootCardIds().length === 4
          && document.querySelector(cardSelector(config.s1)) && document.querySelector(cardSelector(config.s2)),
          'undo restores after the suppressed run too');
        const storedBeforeCleanup = localStorage.getItem('mosa.confirm-move-to-trash');
        localStorage.removeItem('mosa.confirm-move-to-trash');
        const storedAfterCleanup = localStorage.getItem('mosa.confirm-move-to-trash');
        return { confirm, dialogNeverOpened, storedBeforeCleanup, storedAfterCleanup, trashTimeline, toastEvents: toastEventLog() };
      } catch (error) {
        // 任务 108：超时时把三个时间点一并带出（toastEvents 已在 waitFor 的
        // pageDiagnostic 里），「出现过又消失」与「根本没出现」由记录区分。
        throw new Error(error.message + ' trashTimeline=' + JSON.stringify(trashTimeline));
      }
    `));
    // 任务 111：多张确认框标题「把 {count} 个素材移到回收站？」，按钮写动作。
    expect(p9.confirm.title === "把 2 个素材移到回收站？", `P9 multi trash title: ${JSON.stringify(p9.confirm.title)}`);
    expect(p9.confirm.cancelLabel === "取消" && p9.confirm.confirmLabel === "移到回收站", `P9 multi trash buttons: ${JSON.stringify([p9.confirm.cancelLabel, p9.confirm.confirmLabel])}`);
    expect(p9.confirm.checkboxRowVisible === true && p9.confirm.checkedAfterClick === true, `P9 dont-ask checkbox: ${JSON.stringify(p9.confirm)}`);
    expect(p9.confirm.toastMessage.includes("2"), `P9 multi trash toast mentions the count: ${JSON.stringify(p9.confirm.toastMessage)}`);
    expect(p9.confirm.toastActionLabel === "撤销", `P9 multi trash toast action: ${JSON.stringify(p9.confirm.toastActionLabel)}`);
    expect(p9.confirm.storedAfterDontAsk === "off", `P9 storage after checking dont-ask: ${JSON.stringify(p9.confirm.storedAfterDontAsk)}`);
    expect(p9.dialogNeverOpened === true, `P9 suppressed run opened the dialog: ${JSON.stringify(p9.dialogNeverOpened)}`);
    // 任务 108：被抑制轮的撤销提示同样按记录断言（文案带数量、按钮是「撤销」）。
    expect(p9.confirm.toastMessageSuppressed.includes("2"), `P9 suppressed undo toast mentions the count: ${JSON.stringify(p9.confirm.toastMessageSuppressed)}`);
    expect(p9.confirm.toastActionLabelSuppressed === "撤销", `P9 suppressed undo toast action: ${JSON.stringify(p9.confirm.toastActionLabelSuppressed)}`);
    expect(p9.storedBeforeCleanup === "off" && p9.storedAfterCleanup === null, `P9 localStorage cleanup: ${JSON.stringify([p9.storedBeforeCleanup, p9.storedAfterCleanup])}`);

    return {
      assets: [ids.s1, ids.s2, ids.s3, ids.s4, ids.s5, ids.s6],
      group: ids.groupName,
      stackId: ids.stackId,
      renamedTo: ids.stackName,
      dissolveToast: p7.dissolveToast,
      restarted: true,
      // 任务 108：两轮「点击菜单 → 画廊变 2 → 记录到撤销提示」的时间点
      // （每轮相对各自 watchToasts 安装点）与第二轮的提示事件记录。
      trashTimeline: p9.trashTimeline,
      undoToastEvents: p9.toastEvents,
    };
  } finally {
    await second.stop();
  }
}
