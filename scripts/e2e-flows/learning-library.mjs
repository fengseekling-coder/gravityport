// GravityPort React UI flow (task 459): the learning library behind its dev
// switch. Round 1 runs on a fresh profile (entry off) and proves the sidebar
// section, card-menu entry and group-menu entry are absent, then plants
// gravityport.dev.ai-generation=1. Round 2 reloads with the entry on and walks
// the whole page: + creates 海报风格（示例）, group menu 全部加入学习库 fills it
// without touching the group's count or cards, a card joins a second library
// through the card menu's 新建学习库…, the learn view shows every member
// standalone (stacks unfolded), the right pane defaults to 手册 and follows
// selection to 详情 and back, the header name renames in place, a card drag
// onto the sidebar row joins without moving the card's group, 移出学习库
// removes one, and deleting the library returns to 所有素材 with every image
// still there. Server truth is re-verified from node.
import { PAGE_WAIT_SOURCE } from "./_shared.mjs";

export const name = "learning-library";
export const description = "learning library (entry on): + creates one, group 全部加入学习库, second library via card menu, learn view (no stack fold, guide/details tabs), header rename, card drag join, remove-from-learning-library, delete returns to 所有素材; entry off hides section + menus";

const LIB_NAME = "海报风格（示例）";
const LIB_NAME_RENAMED = "海报风格（改名）";
const LIB_SECOND = "第二个学习库";
const GROUP_MAIN_PREFIX = "海报（示例）-";
const GROUP_SIDE_PREFIX = "零散组-";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const stamp = Date.now().toString(36);
    const groupMain = `${GROUP_MAIN_PREFIX}${stamp}`;
    const groupSide = `${GROUP_SIDE_PREFIX}${stamp}`;
    const ids = {};
    for (const [key, color] of [["a", [74, 127, 181]], ["b", [186, 94, 60]], ["c", [58, 138, 87]], ["d", [96, 74, 155]]]) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath: await ctx.makePng(`ll-${key}.png`, color), prompt: `learning library ${key}`,
      });
      ids[key] = created.asset.id;
    }
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default", assetIds: [ids.a, ids.b],
    });
    if (!stack.stack?.id) throw new Error(`seed stack create failed: ${JSON.stringify(stack)}`);
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: groupMain });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [ids.a, ids.b, ids.c], group: groupMain,
    });
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: groupSide });
    await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [ids.d], group: groupSide,
    });

    // Round 1: fresh profile — the entry is OFF, so the sidebar section and the
    // learning-library menu entries are hidden. The round plants the flag for
    // round 2 (the flag is read once at app-module load).
    const off = await ctx.runInPage(server, entryOffSource());
    if (!off || off.sectionHidden !== true || off.assetMenuHidden !== true || off.groupMenuHidden !== true) {
      throw new Error(`learning-library entry-off round failed: ${JSON.stringify(off)}`);
    }

    // Round 2: entry ON — the full page flow.
    const config = { groupMain, groupSide, libName: LIB_NAME, libRenamed: LIB_NAME_RENAMED, libSecond: LIB_SECOND, ids };
    const result = await ctx.runInPage(server, flowSource(config));
    if (!result || result.failedSteps?.length) {
      throw new Error(`learning-library page result: ${JSON.stringify(result)}`);
    }

    // ── Server truth, re-read from node ──
    const libraries = await ctx.api(server.origin, "GET", "/api/learning-libraries?project=default");
    const rows = libraries.learningLibraries || [];
    if (rows.length !== 1) throw new Error(`after deleting one of two libraries, ${rows.length} remain: ${JSON.stringify(rows)}`);
    // 删除的是改名库；活下来的是第二个学习库，成员只剩卡片 d（count 1）。
    if (rows[0].name !== LIB_SECOND || rows[0].count !== 1) {
      throw new Error(`surviving library mismatch: ${JSON.stringify(rows[0])} (want ${LIB_SECOND} count 1)`);
    }
    const mainGroup = await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(groupMain)}&limit=250`);
    const mainIds = (mainGroup.assets || []).map((asset) => asset.id).sort();
    const expectedMain = [ids.a, ids.b, ids.c].sort();
    if (JSON.stringify(mainIds) !== JSON.stringify(expectedMain)) {
      throw new Error(`加入/删除学习库 must not touch the group: ${JSON.stringify(mainIds)} != ${JSON.stringify(expectedMain)}`);
    }
    const sideGroup = await ctx.api(server.origin, "GET", `/api/assets?project=default&group=${encodeURIComponent(groupSide)}&limit=250`);
    const sideAssets = sideGroup.assets || [];
    if (sideAssets.length !== 1 || sideAssets[0].id !== ids.d || sideAssets[0].group !== groupSide) {
      throw new Error(`the dragged card's group must not change: ${JSON.stringify(sideAssets.map((asset) => ({ id: asset.id, group: asset.group })))}`);
    }
    const stackMembers = await ctx.api(server.origin, "GET", `/api/asset-stacks/${stack.stack.id}/assets?project=default`);
    const memberIds = (stackMembers.assets || []).map((asset) => asset.id).sort();
    if (JSON.stringify(memberIds) !== JSON.stringify([ids.a, ids.b].sort())) {
      throw new Error(`the stack must survive untouched: ${JSON.stringify(memberIds)}`);
    }
    return { ...result, checks: { libraryRenamedCount3: true, mainGroupIntact: true, sideGroupIntact: true, stackIntact: true } };
  } finally {
    await server.stop();
  }
}

function entryOffSource() {
  return `(async () => {
${PAGE_WAIT_SOURCE}
    await waitFor(() => document.querySelector('.app') && document.querySelector('.workspace'), 'app shell');
    const sectionLabels = Array.from(document.querySelectorAll('.group-section .section-toggle span')).map((span) => span.textContent.trim());
    const sectionHidden = !sectionLabels.includes('学习库');
    const firstCard = await waitFor(() => document.querySelector('.asset-card:not(.asset-card-virtual-placeholder)'), 'a seeded card');
    firstCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 640, clientY: 400 }));
    await waitFor(() => document.querySelector('.context-menu'), 'card context menu');
    const menuLabels = Array.from(document.querySelectorAll('.context-menu button')).map((button) => button.textContent.trim());
    const assetMenuHidden = !menuLabels.some((label) => label.includes('加入学习库'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.context-menu'), 'card menu closes');
    const groupRow = Array.from(document.querySelectorAll('.sidebar .group-row'))
      .find((button) => (button.getAttribute('aria-label') || '').includes('${GROUP_MAIN_PREFIX}'));
    groupRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 500 }));
    await waitFor(() => document.querySelector('.context-menu'), 'group context menu');
    const groupLabels = Array.from(document.querySelectorAll('.context-menu button')).map((button) => button.textContent.trim());
    const groupMenuHidden = !groupLabels.some((label) => label.includes('加入学习库'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !document.querySelector('.context-menu'), 'group menu closes');
    localStorage.setItem('gravityport.dev.ai-generation', '1');
    return { sectionHidden, assetMenuHidden, groupMenuHidden, sectionLabels };
  })()
  `;
}

function flowSource(config) {
  return `(async () => {
    const ids = ${JSON.stringify(config.ids)};
    const LIB_NAME = ${JSON.stringify(config.libName)};
    const LIB_NAME_RENAMED = ${JSON.stringify(config.libRenamed)};
    const LIB_SECOND = ${JSON.stringify(config.libSecond)};
    const GROUP_MAIN = ${JSON.stringify(config.groupMain)};
    const GROUP_SIDE = ${JSON.stringify(config.groupSide)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const failedSteps = [];
    async function step(label, run) {
      try { return { ok: true, value: await run() }; }
      catch (error) { failedSteps.push(label + ': ' + (error && error.message || error)); return { ok: false, value: null }; }
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label
        + ' | toast=' + (document.querySelector('.toast')?.textContent || '')
        + ' | cards=' + document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length);
    }
    const mainNavButton = (label) => Array.from(document.querySelectorAll('.main-nav button'))
      .find((button) => (button.textContent || '').includes(label)) || null;
    const activeNav = () => document.querySelector('.main-nav .nav-row[aria-current="page"] > span')?.textContent?.trim() || '';
    const libraryRows = () => Array.from(document.querySelectorAll('.sidebar .group-row'))
      .filter((button) => button.getAttribute('data-drop-learning-library'));
    const libraryRow = (name) => libraryRows().find((button) => (button.getAttribute('aria-label') || '') === name) || null;
    const libraryCount = (name) => libraryRow(name)?.querySelector('small')?.textContent || null;
    const groupRow = (name) => Array.from(document.querySelectorAll('.sidebar .group-row'))
      .find((button) => (button.getAttribute('aria-label') || '') === name) || null;
    const groupCount = (name) => groupRow(name)?.querySelector('small')?.textContent || null;
    const cardCount = () => document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)').length;
    const cardFor = (id) => Array.from(document.querySelectorAll('.asset-card'))
      .find((card) => card.getAttribute('data-asset-id') === id) || null;
    const menuButton = (label) => {
      const menu = document.querySelector('.context-menu');
      if (!menu) return null;
      return Array.from(menu.querySelectorAll('button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label)) || null;
    };
    const submenuButton = (label) => {
      const submenu = document.querySelector('.context-submenu');
      if (!submenu) return null;
      return Array.from(submenu.querySelectorAll('button'))
        .find((button) => Array.from(button.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label)) || null;
    };
    async function openMenu(el) {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 640, clientY: 400 }));
      return waitFor(() => document.querySelector('.context-menu') || null, 'context menu opens');
    }
    const closeMenu = () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return waitFor(() => !document.querySelector('.context-menu'), 'menu closes');
    };
    async function openSubmenuAndClick(parentLabel, itemLabel) {
      const parent = await waitFor(() => menuButton(parentLabel), 'menu item ' + parentLabel);
      parent.click();
      const item = await waitFor(() => submenuButton(itemLabel), 'submenu item ' + itemLabel);
      item.click();
      return waitFor(() => !document.querySelector('.context-menu'), 'menu closes after ' + itemLabel);
    }
    async function dialogSubmit(value, buttonLabel) {
      const input = await waitFor(() => document.querySelector('.group-dialog input'), 'dialog input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const button = await waitFor(() => Array.from(document.querySelectorAll('.group-dialog button'))
        .find((candidate) => candidate.textContent.trim() === buttonLabel) || null, 'dialog button ' + buttonLabel);
      button.click();
      return waitFor(() => !document.querySelector('.group-dialog'), 'dialog closes');
    }
    const centerOf = (el) => {
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    };
    const DRAG_ID = 9;
    const moveEvent = (x, y) => new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: x, clientY: y });
    async function dragCardToSidebar(card, targetEl) {
      card.click();
      await waitFor(() => card.classList.contains('asset-selected'), 'drag source selected');
      const from = centerOf(card);
      const to = centerOf(targetEl);
      card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: DRAG_ID, button: 0, clientX: from.x, clientY: from.y }));
      await sleep(40);
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        window.dispatchEvent(moveEvent(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps)));
        await sleep(40);
      }
      // Follow the row until two reads agree, then release on it.
      let finalPoint = centerOf(targetEl);
      for (let chase = 0; chase < 3; chase++) {
        window.dispatchEvent(moveEvent(finalPoint.x, finalPoint.y));
        await sleep(130);
        const again = centerOf(targetEl);
        if (Math.abs(again.x - finalPoint.x) <= 1 && Math.abs(again.y - finalPoint.y) <= 1) { finalPoint = again; break; }
        finalPoint = again;
      }
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: DRAG_ID, clientX: finalPoint.x, clientY: finalPoint.y }));
      await sleep(80);
      // 拖完手势会把下一次合成 click 吞掉（App 的防误选逻辑）；真实浏览器里
      // 下一次点击自带 pointerdown 会清掉这个标记，合成事件没有——补一个。
      window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 8, button: 0, clientX: 5, clientY: 5 }));
      await sleep(40);
    }
    const learnTabs = () => document.querySelector('.learn-library-tabs');
    const tabByLabel = (label) => Array.from((learnTabs() || {}).querySelectorAll?.('button') || [])
      .find((button) => button.textContent.trim() === label) || null;
    // 图墙上的空白点：网格内、任何卡片 bbox 之外。从网格左上角向右扫。
    const blankPoint = () => {
      const grid = document.querySelector('.asset-grid');
      if (!grid) return null;
      const bounds = grid.getBoundingClientRect();
      const cardBoxes = Array.from(document.querySelectorAll('.asset-card:not(.asset-card-virtual-placeholder)'))
        .map((card) => card.getBoundingClientRect());
      const hits = (x, y) => cardBoxes.some((box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
      for (let x = bounds.left + 4; x < bounds.right - 4; x += 8) {
        const y = bounds.top + 4;
        if (!hits(x, y)) return { x, y };
      }
      for (let y = bounds.top + 4; y < bounds.bottom - 4; y += 8) {
        const x = bounds.left + 4;
        if (!hits(x, y)) return { x, y };
      }
      return null;
    };
    const pressAndRelease = (x, y) => {
      const target = document.elementFromPoint(x, y) || document.querySelector('.asset-grid');
      target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
      target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 11, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
    };

    await waitFor(() => document.querySelector('.app') && libraryRows().length >= 0 && cardCount() > 0, 'app shell with entry on and seeded cards');
    const results = {};

    // ── 1) + creates 海报风格（示例）: row shows with count 0 ──
    await step('create via +', async () => {
      const section = await waitFor(() => Array.from(document.querySelectorAll('.group-section'))
        .find((candidate) => candidate.querySelector('.section-toggle span')?.textContent.trim() === '学习库') || null, '学习库 section');
      const addButton = section.querySelector('.add-group');
      addButton.click();
      await dialogSubmit(LIB_NAME, '新建');
      await waitFor(() => libraryRow(LIB_NAME) && libraryCount(LIB_NAME) === '0', 'library row with count 0');
      results.created = libraryCount(LIB_NAME);
    });

    // ── 2) Group menu 全部加入学习库 ▸ 海报风格（示例）: count 3, group untouched ──
    await step('group 全部加入学习库', async () => {
      const before = groupCount(GROUP_MAIN);
      if (before !== '3') throw new Error('group count before joining is ' + before + ', want 3');
      await openMenu(groupRow(GROUP_MAIN));
      await openSubmenuAndClick('全部加入学习库', LIB_NAME);
      await waitFor(() => libraryCount(LIB_NAME) === '3', 'library count 3 after group join');
      results.groupCountAfterJoin = groupCount(GROUP_MAIN);
      if (results.groupCountAfterJoin !== '3') throw new Error('group count changed to ' + results.groupCountAfterJoin);
    });

    // ── 3) The group view still shows its own cards (stack node + c = 2) ──
    await step('group view intact', async () => {
      groupRow(GROUP_MAIN).click();
      // 分组视图激活时 aria-current 落在分组行上，main-nav 行不再标页。
      await waitFor(() => groupRow(GROUP_MAIN)?.getAttribute('aria-current') === 'page', 'group view active');
      const beforeCards = cardCount();
      if (beforeCards !== 2) throw new Error('group view cards ' + beforeCards + ', want 2 (stack node + c)');
      await waitFor(() => cardCount() === 2, 'group cards still 2 after joining');
      results.groupCardsAfterJoin = cardCount();
      mainNavButton('所有素材').click();
      await waitFor(() => activeNav() === '所有素材', 'back to all assets');
    });

    // ── 4) Card d joins a NEW library via 加入学习库 ▸ 新建学习库… ──
    await step('card joins new library via menu', async () => {
      await waitFor(() => cardFor(ids.d), 'card d rendered');
      await openMenu(cardFor(ids.d));
      await openSubmenuAndClick('加入学习库', '新建学习库…');
      await dialogSubmit(LIB_SECOND, '新建');
      await waitFor(() => libraryRow(LIB_SECOND) && libraryCount(LIB_SECOND) === '1', 'second library row with count 1');
      results.secondLibraryCount = libraryCount(LIB_SECOND);
    });

    // ── 5) The learn view: stacks unfolded, tabs follow selection ──
    await step('learn view: unfold + tabs', async () => {
      libraryRow(LIB_NAME).click();
      // 学习库视图的 aria-current 落在侧栏学习库行上（main-nav 的所有素材
      // 行不变），行上还挂着 data-drop-learning-library=<id>。
      await waitFor(() => libraryRow(LIB_NAME)?.getAttribute('aria-current') === 'page', 'learn view active');
      await waitFor(() => cardCount() === 3
        && cardFor(ids.a) && cardFor(ids.b) && cardFor(ids.c), 'learn view lists a, b, c separately');
      const stackMarks = document.querySelectorAll('.asset-card .stack-mark').length;
      if (stackMarks) throw new Error(stackMarks + ' stack marks inside the learn view');
      results.learnCards = cardCount();
      // 点图墙空白处取消选择（学习库视图的新行为）：焦点卡清掉后页签回到
      // 「手册」——没有选中时进入学习库的默认页签。
      const blank = blankPoint();
      if (!blank) throw new Error('no blank point found on the learn-view grid');
      pressAndRelease(blank.x, blank.y);
      await waitFor(() => tabByLabel('手册')?.getAttribute('aria-selected') === 'true', '手册 tab selected with nothing focused');
      const panel = document.querySelector('.learn-library-panel');
      if (!panel) throw new Error('手册 panel missing');
      const headings = Array.from(panel.querySelectorAll('.learn-library-heading')).map((heading) => heading.textContent.trim());
      if (JSON.stringify(headings) !== JSON.stringify(['设计手册', '学习记录'])) {
        throw new Error('guide headings ' + JSON.stringify(headings));
      }
      if (panel.querySelector('button')) throw new Error('the guide panel must not carry buttons yet');
      // 点一张图切「详情」（右栏显示这张的详情），再点空白切回「手册」。
      cardFor(ids.a).click();
      await waitFor(() => tabByLabel('详情')?.getAttribute('aria-selected') === 'true', '详情 auto-selected with a card');
      await waitFor(() => document.querySelector('.details .asset-title'), 'inspector content under 详情');
      const blankAgain = blankPoint();
      if (!blankAgain) throw new Error('no blank point found for the flip-back');
      pressAndRelease(blankAgain.x, blankAgain.y);
      await waitFor(() => tabByLabel('手册')?.getAttribute('aria-selected') === 'true', '手册 returns after a blank press');
      results.tabsCycle = true;
    });

    // ── 6) Header name renames in place ──
    await step('header rename in place', async () => {
      const nameButton = await waitFor(() => document.querySelector('.learn-library-title .learn-library-name'), 'header name button');
      nameButton.click();
      const input = await waitFor(() => document.querySelector('.learn-library-title .learn-library-name-input'), 'header name input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, LIB_NAME_RENAMED);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await waitFor(() => libraryRow(LIB_NAME_RENAMED), 'sidebar row shows the new name');
      await waitFor(() => document.querySelector('.learn-library-title .learn-library-name')?.textContent.trim() === LIB_NAME_RENAMED, 'header shows the new name');
      results.renamed = true;
    });

    // ── 7) Back to 所有素材, drag card d onto the renamed row: count 3→4, group unchanged ──
    await step('card drag joins the library', async () => {
      mainNavButton('所有素材').click();
      await waitFor(() => activeNav() === '所有素材' && cardFor(ids.d), 'all-assets view with card d');
      const row = libraryRow(LIB_NAME_RENAMED);
      await dragCardToSidebar(cardFor(ids.d), row);
      await waitFor(() => libraryCount(LIB_NAME_RENAMED) === '4', 'library count 4 after the drag join');
      await waitFor(() => groupCount(GROUP_SIDE) === '1', 'the dragged card stays in its group');
      results.dragJoinCount = libraryCount(LIB_NAME_RENAMED);
    });

    // ── 8) 移出学习库 inside the learn view: count 4→3 ──
    await step('remove from learning library', async () => {
      libraryRow(LIB_NAME_RENAMED).click();
      await waitFor(() => libraryRow(LIB_NAME_RENAMED)?.getAttribute('aria-current') === 'page' && cardFor(ids.c), 'learn view again');
      await openMenu(cardFor(ids.c));
      await waitFor(() => menuButton('移出学习库'), '移出学习库 entry in the learn view');
      const remove = menuButton('移出学习库');
      remove.click();
      await waitFor(() => !document.querySelector('.context-menu'), 'menu closes after remove');
      await waitFor(() => libraryCount(LIB_NAME_RENAMED) === '3', 'library count 3 after removal');
      await waitFor(() => !cardFor(ids.c) && cardFor(ids.a), 'c leaves the learn view');
      results.afterRemove = libraryCount(LIB_NAME_RENAMED);
    });

    // ── 9) Delete the library: back to 所有素材, every image survives ──
    await step('delete the library', async () => {
      const row = libraryRow(LIB_NAME_RENAMED);
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 520 }));
      await waitFor(() => document.querySelector('.context-menu') || null, 'library menu opens');
      await waitFor(() => menuButton('删除学习库'), '删除学习库 entry');
      const deleteButton = menuButton('删除学习库');
      deleteButton.click();
      await waitFor(() => document.querySelector('.group-dialog') || null, 'delete confirm opens');
      const confirm = await waitFor(() => Array.from(document.querySelectorAll('.group-dialog button'))
        .find((candidate) => candidate.textContent.trim() === '删除') || null, 'confirm 删除 button');
      confirm.click();
      await waitFor(() => activeNav() === '所有素材', 'back to all assets after delete');
      await waitFor(() => !libraryRow(LIB_NAME_RENAMED), 'library row gone');
      await waitFor(() => cardCount() === 3, 'all-assets still shows stack node + c + d');
      results.afterDeleteCards = cardCount();
      results.afterDeleteLibraries = libraryRows().length;
    });

    if (failedSteps.length) return { failedSteps, results };
    return { ...results, failedSteps };
  })()
  `;
}
