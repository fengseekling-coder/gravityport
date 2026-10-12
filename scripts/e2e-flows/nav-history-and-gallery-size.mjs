// 任务 70（GravityPort A3）：后退/前进浏览位置历史 + 缩略图大小滑杆运行时验证。
//
// Session one（同一次页面加载）：
//   1) 初始后退/前进按钮都 disabled；
//   2) 切两次侧栏入口（来源 codex-generated → 手动分组）：后退逐步可用，画廊
//      内容、#viewTitle 与 API 镜像一致；
//   3) 后退两次：先回来源窗口再回「全部素材」，侧栏选中态与画廊集合都恢复；
//   4) 前进两次：依次回到来源、分组窗口（恢复不产生新记录——后退后前进链完好）；
//   5) macOS 键盘 ⌘[ 后退一步（非 mac 跳过），停在中间位置；
//   6) 在中间位置点「全部素材」发起新导航 → 前进链被截断（前进按钮 disabled）；
//   7) 滑杆（关检视器后）：拖到 120 / 400 / 200，列数随目标宽反向变化、行内
//      --gallery-columns 与实际轨道数一致、首行铺满无空洞、卡片互不重叠，
//      值持久化进 mosa.gallery-card-size；
//   8) 任务 123：堆叠返回并入后退/前进——双击进堆叠（后退亮、前进灰）→ 后退
//      退出（滚动位置与卡片顺序原样恢复、前进亮）→ 前进重进同一堆叠 → ⌘[ 退
//      出/⌘] 再进 → 侧栏新导航截掉堆叠记录（前进灰）→ 再进后 Esc 退出（前进
//      亮）→ 窄屏（640px）堆叠里只露后退、退出后两个都隐藏 → 解散堆叠退出
//      （堆叠记录丢弃、前进保持灰）。
// Session two（同一 server 重新加载）：滑杆值从本地存储恢复；关掉默认打开的
// 检视器后（与 session one 末态相同的布局状态），列数与刷新前一致。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "nav-history-and-gallery-size";
export const description = "back/forward over sidebar scopes restores ranges and galleries (restore records nothing, middle-position nav truncates forward); thumbnail slider drives --gallery-columns both ways with overlap-free layout and reload persistence; stacks ride the same back/forward (enter records, exit consumes, dissolve drops) incl. narrow-viewport reveal";

const GROUP_NAME = "navhistory-group";
const IMAGE_COUNT = 12;

function seedPlan() {
  const entries = [];
  for (let index = 0; index < IMAGE_COUNT; index += 1) {
    entries.push({
      id: `navh-img-${String(index).padStart(2, "0")}`,
      // 前 3 张进手动分组（混两种来源），来源 6/6 分开，保证三个历史窗口的
      // 卡片集合互不相同。
      group: index < 3 ? GROUP_NAME : "",
      sourceType: index % 2 === 0 ? "web-chatgpt" : "codex-generated",
      // 高低比交错，让瀑布流有真实的高度差（重叠/空洞检查更有意义）。
      size: index % 3 === 0 ? [72, 108] : index % 3 === 1 ? [108, 72] : [80, 80],
    });
  }
  return entries;
}

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const plan = seedPlan();
    for (const [index, entry] of plan.entries()) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`${entry.id}.png`, [40 + index * 12, 90, 140], { width: entry.size[0], height: entry.size[1] }),
        assetId: entry.id,
        sourceType: entry.sourceType,
        ...(entry.group ? { group: entry.group } : {}),
      });
      if (created?.asset?.id !== entry.id) throw new Error(`Seed ${entry.id}: unexpected asset id ${created?.asset?.id}`);
    }
    const apiIds = async (params) => {
      const response = await ctx.api(server.origin, "GET", `/api/assets?project=default&${new URLSearchParams(params)}`);
      return (response.assets || []).map((asset) => asset.id);
    };
    const expect = {
      allIds: await apiIds({ sort: "newest", limit: "250" }),
      codexIds: await apiIds({ sort: "newest", limit: "250", source: "codex-generated" }),
      groupIds: await apiIds({ sort: "newest", limit: "250", group: GROUP_NAME }),
    };

    // 1440×800：滑杆组三态的最小常规验证宽。返工 1 规则（用户 10-06 拍板）：
    // 居中 = 窗口中线（检视器开关都一样）。检视器开着顶栏窄（840px），窗口中线
    // 放不下 → 退让到左右两组之间的空白居中（行内 left 偏离窗口中线）；关检视
    // 器 → 回到窗口居中（行内 left = 窗口中线 − 顶栏左缘）。1280 开检视器才
    // 隐藏（空白 < 组宽 + 24，由 web-style-snapshot 的键锁）。
    const facts = await ctx.runInPage(server, sessionOneSource(expect), { windowSize: [1440, 800] });
    assertSessionOne(facts, expect);

    const reloaded = await ctx.runInPage(server, sessionTwoSource(), { windowSize: [1440, 800] });
    assertSessionTwo(reloaded, facts);

    return {
      historySteps: facts.historySteps,
      sliderSteps: facts.sliderSteps,
      reloadedSliderValue: reloaded.sliderValue,
      reloadedColumns: reloaded.columns,
      rendererErrors: facts.rendererErrors + reloaded.rendererErrors,
    };
  } finally {
    await server.stop();
  }
}

function assertSessionOne(facts, expect) {
  if (!facts) throw new Error("session one returned no facts");
  const problems = [];
  if (facts.initiallyBackDisabled !== true || facts.initiallyForwardDisabled !== true) problems.push("history buttons must start disabled");
  if (JSON.stringify(facts.codexWindowIds) !== JSON.stringify(expect.codexIds)) problems.push(`codex window mismatch: ${JSON.stringify(facts.codexWindowIds)}`);
  if (JSON.stringify(facts.groupWindowIds) !== JSON.stringify(expect.groupIds)) problems.push(`group window mismatch: ${JSON.stringify(facts.groupWindowIds)}`);
  if (facts.groupWindowTitle !== GROUP_NAME) problems.push(`group window must name itself in #viewTitle: ${JSON.stringify(facts.groupWindowTitle)}`);
  if (facts.backEnabledAfterTwoNavs !== true || facts.forwardDisabledAfterTwoNavs !== true) problems.push("after two navigations only back may be enabled");
  if (JSON.stringify(facts.backToCodexIds) !== JSON.stringify(expect.codexIds)) problems.push(`back #1 must restore the codex window: ${JSON.stringify(facts.backToCodexIds)}`);
  if (facts.backToCodexSourceActive !== true) problems.push("back #1 must restore the sidebar source selection");
  if (JSON.stringify(facts.backToAllIds) !== JSON.stringify(expect.allIds.slice(0, facts.backToAllIds.length))) problems.push("back #2 must restore the full library window");
  if (facts.backToAllActive !== true) problems.push("back #2 must restore the 全部素材 selection");
  if (facts.backDisabledAtOldest !== true || facts.forwardEnabledAtOldest !== true) problems.push("at the oldest position back must disable and forward must enable");
  if (JSON.stringify(facts.forwardToCodexIds) !== JSON.stringify(expect.codexIds)) problems.push(`forward #1 must restore the codex window: ${JSON.stringify(facts.forwardToCodexIds)}`);
  if (JSON.stringify(facts.forwardToGroupIds) !== JSON.stringify(expect.groupIds)) problems.push(`forward #2 must restore the group window: ${JSON.stringify(facts.forwardToGroupIds)}`);
  if (facts.forwardDisabledAfterForwardAll !== true) problems.push("forward must disable again at the newest position");
  if (facts.keyboardStepUsed === true) {
    if (JSON.stringify(facts.keyboardBackIds) !== JSON.stringify(expect.codexIds)) problems.push(`⌘[ must go back to the codex window: ${JSON.stringify(facts.keyboardBackIds)}`);
    if (facts.keyboardForwardEnabled !== true) problems.push("⌘[ (one step back from the middle) must leave forward enabled");
  }
  if (facts.forwardDisabledAfterFreshNav !== true || facts.backEnabledAfterFreshNav !== true) problems.push("a fresh navigation at a middle position must truncate the forward chain");
  // 任务 123：堆叠返回并入后退/前进。
  const sh = facts.stackHistory || {};
  if (sh.entered !== true || sh.backEnabledInStack !== true || sh.forwardDisabledInStack !== true) {
    problems.push(`in a stack: back enabled, forward disabled: ${JSON.stringify(sh)}`);
  }
  if (sh.exitedByBack !== true || sh.forwardEnabledAtRoot !== true) problems.push("the back button must exit the stack and light forward at the root");
  if (sh.forwardReentered !== true) problems.push("forward must re-enter the same stack from the root record");
  if (sh.keyboardUsed !== true || sh.forwardEnabledAfterKeyboardExit !== true || sh.keyboardReentered !== true) {
    problems.push("⌘[ must exit like the back button and ⌘] must re-enter like forward");
  }
  if (sh.forwardGrayAfterSidebarNav !== true) problems.push("a fresh sidebar navigation must truncate the stack record (forward gray)");
  if (sh.escExited !== true || sh.forwardEnabledAfterEscExit !== true) problems.push("an Esc exit must light forward exactly like the button exit");
  const narrow = sh.narrow || {};
  if (narrow.inStackBackVisible !== true || narrow.inStackForwardHidden !== true) problems.push("narrow viewport: in a stack only the back button may show (visible + enabled)");
  if (narrow.exitedByBack !== true || narrow.bothHiddenAfterExit !== true) problems.push("narrow viewport: both history buttons must hide after leaving the stack");
  if (sh.dissolveExited !== true || sh.forwardGrayAfterDissolve !== true) problems.push("a dissolve exit must drop the stack record (forward gray)");
  if (problems.length) throw new Error(`nav history facts wrong: ${problems.join("; ")}`);
  if (!Array.isArray(facts.sliderSteps) || facts.sliderSteps.length !== 3) throw new Error(`slider steps missing: ${JSON.stringify(facts.sliderSteps)}`);
  const [at120, at400, at200] = facts.sliderSteps;
  if (!(at120.columns > at200.columns && at200.columns > at400.columns)) {
    throw new Error(`columns must shrink as the target width grows: ${JSON.stringify(facts.sliderSteps)}`);
  }
  for (const step of facts.sliderSteps) {
    if (step.rowComplete !== true) throw new Error(`slider ${step.value}: the first row must fill every column (no holes): ${JSON.stringify(step)}`);
    if (step.overlaps > 0) throw new Error(`slider ${step.value}: ${step.overlaps} overlapping card pairs`);
    if (step.inlineColumns !== step.columns) throw new Error(`slider ${step.value}: inline --gallery-columns (${step.inlineColumns}) != rendered tracks (${step.columns})`);
    if (step.sliderValue !== String(step.value)) throw new Error(`slider ${step.value}: #gallerySizeSlider shows ${step.sliderValue}`);
  }
  if (facts.storedSize !== "200") throw new Error(`mosa.gallery-card-size must persist the last slider value: ${facts.storedSize}`);
  if (facts.finalColumns !== facts.sliderSteps[2].columns) throw new Error("the default slider step must match the returned final column count");
}

function assertSessionTwo(facts, previous) {
  if (facts.sliderValue !== previous.storedSize) {
    throw new Error(`reload must restore the slider from mosa.gallery-card-size (${previous.storedSize}): ${facts.sliderValue}`);
  }
  if (facts.columns !== previous.finalColumns) {
    throw new Error(`reload must keep the persisted column count at the same layout state (${previous.finalColumns}): ${facts.columns}`);
  }
}

function sessionOneSource(expect) {
  return `(async () => {
    const expect = ${JSON.stringify(expect)};
    ${PAGE_HELPERS}
    const facts = {
      historySteps: ["initial", "codex", "group", "back", "back", "forward", "forward", "keyboard-back", "fresh-nav"],
      sliderSteps: [],
      rendererErrors: 0,
    };
    const assert = (ok, label) => { if (!ok) throw new Error('nav-history-and-gallery-size: ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic())); };
    const back = () => document.querySelector('#navHistoryBack');
    const forward = () => document.querySelector('#navHistoryForward');
    const navIds = () => [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => card.dataset.id);
    const codexItem = () => document.querySelector('#sidebarGroupList .nav-item[data-filter="source"][data-value="codex-generated"]');
    const allItem = () => document.querySelector('#quickFilters .nav-item[data-filter="all"]');
    const viewTitle = () => document.querySelector('#viewTitle')?.textContent || '';
    const sameIds = (ids, order) => JSON.stringify(ids) === JSON.stringify(order);

    await waitFor(() => gallerySettled() && navIds().length === expect.allIds.length, 'initial gallery ready');
    facts.initiallyBackDisabled = back().disabled;
    facts.initiallyForwardDisabled = forward().disabled;

    // ===== 两次侧栏导航，各窗口与 API 镜像一致 =====
    // loadStats 与画廊首屏并行：先等侧栏项真的渲染出来再点。
    await waitFor(() => Boolean(codexItem()), 'sidebar source item rendered');
    click('#sidebarGroupList .nav-item[data-filter="source"][data-value="codex-generated"]');
    await waitFor(() => gallerySettled() && sameIds(navIds(), expect.codexIds), 'codex-generated window');
    facts.codexWindowIds = navIds();
    await waitFor(() => Boolean(document.querySelector('#sidebarManualGroupList .nav-item[data-filter="group"][data-value="${GROUP_NAME}"]')), 'sidebar group item rendered');
    click('#sidebarManualGroupList .nav-item[data-filter="group"][data-value="${GROUP_NAME}"]');
    await waitFor(() => gallerySettled() && sameIds(navIds(), expect.groupIds), 'manual group window');
    facts.groupWindowIds = navIds();
    facts.groupWindowTitle = viewTitle();
    facts.backEnabledAfterTwoNavs = !back().disabled;
    facts.forwardDisabledAfterTwoNavs = forward().disabled;

    // ===== 后退两次：恢复来源窗口、再恢复全部（范围+侧栏选中态+画廊内容）=====
    back().click();
    await waitFor(() => gallerySettled() && sameIds(navIds(), expect.codexIds) && codexItem()?.classList.contains('active'), 'back #1 restores the codex window');
    facts.backToCodexIds = navIds();
    facts.backToCodexSourceActive = codexItem()?.classList.contains('active') === true;
    back().click();
    await waitFor(() => gallerySettled() && navIds().length === expect.allIds.length && allItem()?.classList.contains('active'), 'back #2 restores all assets');
    facts.backToAllIds = navIds();
    facts.backToAllActive = allItem()?.classList.contains('active') === true;
    facts.backDisabledAtOldest = back().disabled;
    facts.forwardEnabledAtOldest = !forward().disabled;

    // ===== 前进两次：恢复不产生新记录，前进链完好 =====
    forward().click();
    await waitFor(() => gallerySettled() && sameIds(navIds(), expect.codexIds), 'forward #1 restores the codex window');
    facts.forwardToCodexIds = navIds();
    forward().click();
    await waitFor(() => gallerySettled() && sameIds(navIds(), expect.groupIds), 'forward #2 restores the group window');
    facts.forwardToGroupIds = navIds();
    facts.forwardDisabledAfterForwardAll = forward().disabled;

    // ===== 键盘：macOS ⌘[ 后退一步，停在中间位置（非 mac 跳过）=====
    if (/Mac/i.test(navigator.platform)) {
      facts.keyboardStepUsed = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, bubbles: true, cancelable: true }));
      await waitFor(() => gallerySettled() && sameIds(navIds(), expect.codexIds), 'keyboard ⌘[ goes back to the codex window');
      facts.keyboardBackIds = navIds();
      facts.keyboardForwardEnabled = !forward().disabled;
    }

    // ===== 中间位置的新导航截断前进链 =====
    click('#quickFilters .nav-item[data-filter="all"]');
    await waitFor(() => gallerySettled() && navIds().length === expect.allIds.length, 'fresh navigation to all assets');
    facts.forwardDisabledAfterFreshNav = forward().disabled;
    facts.backEnabledAfterFreshNav = !back().disabled;

    // ===== 滑杆（任务 70 返工 1）：检视器开着 → 退让居中；关掉 → 窗口居中 =====
    // 窗口中线在顶栏坐标系里的位置（检视器开着时顶栏被推窄，顶栏中线 ≠ 窗口中线）。
    const windowCenterInBar = () => window.innerWidth / 2 - document.querySelector('#topbarSizeGroup').parentElement.getBoundingClientRect().left;
    await waitFor(() => document.querySelector('#topbarSizeGroup')?.hidden === false
      && /^\\d+(\\.\\d+)?px$/.test(document.querySelector('#topbarSizeGroup')?.style.left || ''), 'size group recentered (inline left) while the inspector is open');
    const recenteredLeft = Number.parseFloat(document.querySelector('#topbarSizeGroup').style.left);
    if (Math.abs(recenteredLeft - windowCenterInBar()) < 24) {
      throw new Error('recentered left must sit off the window centerline: ' + recenteredLeft + ' vs ' + windowCenterInBar());
    }
    // ===== 任务 96 返工 2：关检视器后滑杆回窗口中线不得依赖帧回调 =====
    // CI 的隐藏窗口（Windows 尤甚）把 rAF 攒帧批量执行。冻结 rAF 锁死「关闭检
    // 视器 + 行内 left 回窗口中线必须同步落地」——返工 2 的探针实证这条链本就
    // 同步（CI 失败与 main 上 Windows e2e 的既有偶发停滞同池），此断言把它变成
    // 永久约束：将来谁把这条链改成依赖延迟帧，这里立刻挂。
    const sizeGroupState = () => {
      const group = document.querySelector('#topbarSizeGroup');
      const bar = group?.parentElement?.getBoundingClientRect();
      return {
        left: group?.style.left || '',
        hidden: group?.hidden,
        panelAriaHidden: document.querySelector('#detailPanel')?.getAttribute('aria-hidden'),
        centerInBar: bar ? window.innerWidth / 2 - bar.left : NaN,
      };
    };
    const frozenRafs = [];
    const realRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { frozenRafs.push(callback); return frozenRafs.length; };
    try {
      const before = sizeGroupState();
      const detailClose = document.querySelector('#detailPanel .detail-close');
      if (detailClose && before.panelAriaHidden === 'false') detailClose.click();
      // 关闭走 async 守卫链（microtask），冻结的只是帧回调：等关闭完成本身，
      // 然后要求行内 left 在同一同步块里落地——不押任何 rAF。
      await waitFor(() => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'true', 'inspector closes with rAF frozen');
      const frozen = sizeGroupState();
      if (frozen.hidden === true || Math.abs(Number.parseFloat(frozen.left || 'NaN') - frozen.centerInBar) > 0.75) {
        throw new Error('window-centered left must land synchronously with rAF frozen: ' + JSON.stringify({ before, frozen, diagnostic: pageDiagnostic() }));
      }
    } finally {
      window.requestAnimationFrame = realRaf;
      for (const callback of frozenRafs.splice(0)) callback(Date.now());
    }
    await waitFor(() => !document.querySelector('#topbarSizeGroup')?.hidden
      && Math.abs(Number.parseFloat(document.querySelector('#topbarSizeGroup')?.style.left || 'NaN') - windowCenterInBar()) <= 0.75, 'size group back to window-centered without the inspector');
    const gridElement = () => document.querySelector('#assetGrid');
    const trackCount = () => getComputedStyle(gridElement()).gridTemplateColumns.split(/\\s+/).filter(Boolean).length;
    // 布局稳定门：连续两次采样的卡片几何一致（瀑布流重排在 rAF 里落地）。
    async function waitForCardLayoutStable(label) {
      // 任务 100：瀑布流重排排在下一帧（scheduleMasonryLayout）。先等两帧真的跑完再
      // 采样——Windows CI 的隐藏窗口会把帧攒着，只等 120ms 会把旧布局误判成稳定。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('nav-history-and-gallery-size: no animation frame ran within 10s after ' + label)), 10000);
        requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
      });
      let previous = '';
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await sleep(120);
        const next = JSON.stringify([...document.querySelectorAll('#assetGrid > .asset-card')]
          .map((card) => { const r = card.getBoundingClientRect(); return [Math.round(r.left * 2), Math.round(r.top * 2), Math.round(r.width * 2)]; }));
        if (next === previous && gallerySettled()) return;
        previous = next;
      }
      throw new Error('nav-history-and-gallery-size: card layout never stabilized after ' + label);
    }
    async function applySlider(value, label) {
      setValue('#gallerySizeSlider', String(value));
      await waitFor(() => {
        const grid = gridElement();
        const tracks = getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean);
        return Number(grid.style.getPropertyValue('--gallery-columns')) === tracks.length;
      }, 'columns settle for slider ' + value + ' (' + label + ')', 20000);
      await waitForCardLayoutStable('slider ' + value);
      const grid = gridElement();
      const columns = trackCount();
      const rects = [...document.querySelectorAll('#assetGrid > .asset-card')].map((card) => card.getBoundingClientRect())
        .sort((a, b) => a.top - b.top || a.left - b.left);
      const minTop = rects[0].top;
      const firstRow = rects.filter((rect) => rect.top < minTop + 1);
      const rowComplete = firstRow.length === columns
        && firstRow.every((rect, index) => index === 0 || Math.abs((rect.left - firstRow[index - 1].right) - 4) <= 0.75);
      let overlaps = 0;
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const overlapX = Math.min(rects[i].right, rects[j].right) - Math.max(rects[i].left, rects[j].left);
          const overlapY = Math.min(rects[i].bottom, rects[j].bottom) - Math.max(rects[i].top, rects[j].top);
          if (overlapX > 1 && overlapY > 1) overlaps += 1;
        }
      }
      const step = {
        value,
        columns,
        inlineColumns: Number(grid.style.getPropertyValue('--gallery-columns')),
        rowComplete,
        overlaps,
        sliderValue: document.querySelector('#gallerySizeSlider').value,
      };
      // CI 诊断：行不完整时带回首行几何、轨道和滚动条占位，区分「少卡」和「间距不对」。
      if (!rowComplete) {
        step.firstRow = firstRow.map((rect) => [rect.left, rect.right, rect.top].map((n) => Math.round(n * 100) / 100));
        step.tracks = getComputedStyle(grid).gridTemplateColumns;
        step.gridWidths = [grid.offsetWidth, grid.clientWidth, grid.scrollWidth];
        step.scroller = (() => { const el = grid.closest('.gallery-scroll, .main-content, main') || document.scrollingElement; return el ? [el.className || el.tagName, el.offsetWidth, el.clientWidth] : null; })();
        step.cardCount = rects.length;
        step.innerWidth = window.innerWidth;
      }
      facts.sliderSteps.push(step);
      return step;
    }
    await applySlider(120, 'min');
    await applySlider(400, 'max');
    const lastStep = await applySlider(200, 'default');
    facts.finalColumns = lastStep.columns;
    facts.storedSize = localStorage.getItem('mosa.gallery-card-size') || '';

    // ===== 任务 123：堆叠返回并入后退/前进（进堆叠 = 一步浏览历史）=====
    // 前置：滑杆段结束在「全部素材」根位置，检视器关闭，前进为灰。堆叠成员
    // 选两张 codex-generated（步骤 7 的来源筛选下节点仍可见）。
    const stackMenu = { stackSelected: '堆叠所选', dissolveStack: '解散堆叠' };
    const sh = {};
    facts.stackHistory = sh;
    const inStackNow = () => document.body.getAttribute('data-in-stack') === 'true';
    const backBtn = () => document.querySelector('#navHistoryBack');
    const fwdBtn = () => document.querySelector('#navHistoryForward');
    const gridEl = () => document.querySelector('#assetGrid');
    const stackNodeEl = () => document.querySelector('#assetGrid > .asset-card.is-stack');
    const multiSelected = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
    const ctrlClickCard = (assetId) => {
      const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
      if (!target) throw new Error('Missing card select for ' + assetId);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
    };
    const openStackDblclick = async (label) => {
      const node = await waitFor(() => { const el = stackNodeEl(); return el?.isConnected ? el : null; }, 'stack node visible (' + label + ')', 20000);
      node.scrollIntoView({ block: 'center' });
      node.querySelector('.asset-card-select').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    };
    // 1) 建堆：两张成员 → 右键「堆叠所选」。
    await waitFor(() => Boolean(document.querySelector(cardSelector('navh-img-01')))
      && Boolean(document.querySelector(cardSelector('navh-img-03'))), 'stack members visible');
    ctrlClickCard('navh-img-01');
    await waitFor(() => JSON.stringify(multiSelected()) === JSON.stringify(['navh-img-01']), 'first member selected');
    ctrlClickCard('navh-img-03');
    await waitFor(() => JSON.stringify(multiSelected()) === JSON.stringify(['navh-img-01', 'navh-img-03']), 'both members selected');
    const stackMenuItem = await openContextMenu(cardSelector('navh-img-01'), stackMenu.stackSelected);
    stackMenuItem.click();
    const createdNode = await waitFor(() => stackNodeEl(), 'stack node appears');
    sh.stackId = createdNode.dataset.stackId;
    // 封面 = 画廊顺序里第一个被选中的成员（不一定是右键的那张），后续断言用它。
    sh.coverId = createdNode.dataset.id;
    await waitFor(() => gallerySettled() && multiSelected().length === 0, 'stack created, selection cleared');
    // 2) 记录根位置滚动与卡片顺序，滚到非零偏移（退出后必须原样恢复）。
    //    enterStack 快照的是双击那一刻的 scrollTop，而 openStackDblclick 的
    //    scrollIntoView 会滚动 #assetGrid。返工 1：必须先把节点摆进视口、再保存
    //    滚动落点——此前先保存后 scrollIntoView，保存值被自己的滚动动作作废
    //    （实测 104→34），退出按快照值恢复被误判为「滚动丢失」。
    const maxScroll = gridEl().scrollHeight - gridEl().clientHeight;
    gridEl().scrollTop = Math.min(160, maxScroll);
    const nodeForScrollSave = await waitFor(() => { const el = stackNodeEl(); return el?.isConnected ? el : null; }, 'stack node visible before scroll save', 20000);
    nodeForScrollSave.scrollIntoView({ block: 'center' });
    const rootOrderBefore = rootCardIds();
    const savedScrollTop = gridEl().scrollTop;
    sh.rootScrollTopSaved = savedScrollTop;
    // 3) 双击进堆叠：后退亮（=退出）、前进灰。
    await openStackDblclick('first enter');
    await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2
      && rootCardIds().includes('navh-img-01') && rootCardIds().includes('navh-img-03'), 'entered the stack');
    sh.entered = true;
    sh.backEnabledInStack = Boolean(backBtn()) && !backBtn().disabled;
    sh.forwardDisabledInStack = Boolean(fwdBtn()) && fwdBtn().disabled;
    // 4) 点后退=退出堆叠：根画廊滚动位置与卡片顺序原样恢复，前进亮。
    click('#navHistoryBack');
    await waitFor(() => !inStackNow() && gallerySettled(), 'exited via the back button');
    await waitFor(() => Math.abs(gridEl().scrollTop - savedScrollTop) <= 2, 'root scroll restored after back exit', 20000);
    await waitFor(() => JSON.stringify(rootCardIds()) === JSON.stringify(rootOrderBefore), 'root card order unchanged after back exit');
    sh.exitedByBack = true;
    sh.forwardEnabledAtRoot = !fwdBtn().disabled;
    // 5) 点前进=用历史记录重进同一个堆叠（不新增记录）。
    click('#navHistoryForward');
    await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2, 'forward re-entered the same stack');
    sh.forwardReentered = true;
    // 6) 快捷键退出 / 再进，与按钮完全同一套行为（规则 15）：macOS 是 ⌘[ / ⌘]，
    //    其他平台是 Alt+← / Alt+→。返工 1：此前这一段只在 macOS 派发，Windows 上
    //    整段跳过，走到第 7 步时人还在堆叠里——堆叠里点侧栏是堆叠内筛选（既定
    //    行为），于是第 7 步等不到根位置的来源窗口。两个平台都必须走完这一段。
    {
      const isMacPlatform = /Mac/i.test(navigator.platform);
      const backKey = isMacPlatform ? { key: '[', metaKey: true } : { key: 'ArrowLeft', altKey: true };
      const forwardKey = isMacPlatform ? { key: ']', metaKey: true } : { key: 'ArrowRight', altKey: true };
      sh.keyboardUsed = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { ...backKey, bubbles: true, cancelable: true }));
      await waitFor(() => !inStackNow() && gallerySettled(), 'keyboard back exits the stack');
      sh.forwardEnabledAfterKeyboardExit = !fwdBtn().disabled;
      document.dispatchEvent(new KeyboardEvent('keydown', { ...forwardKey, bubbles: true, cancelable: true }));
      await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2, 'keyboard forward re-enters the stack');
      sh.keyboardReentered = true;
      click('#navHistoryBack');
      await waitFor(() => !inStackNow() && gallerySettled(), 'back-button exit after the keyboard round trip');
    }
    // 7) 根位置点侧栏别的项：新记录截掉堆叠记录，前进变灰。点动态侧栏项之前
    //    先等它渲染出来（loadStats 与首屏并行）。
    const codexNavItem = () => document.querySelector('#sidebarGroupList .nav-item[data-filter="source"][data-value="codex-generated"]');
    await waitFor(() => Boolean(codexNavItem()), 'sidebar source item rendered');
    click('#sidebarGroupList .nav-item[data-filter="source"][data-value="codex-generated"]');
    // 后置条件必须真的等来源窗口生效（codex 6 张成员、2 张在堆叠里 = 5 张卡，
    // 且侧栏项激活）——否则「全部素材」窗口同样包含封面卡，等待会提前通过。
    await waitFor(() => gallerySettled() && !inStackNow()
      && codexNavItem()?.classList.contains('active')
      && rootCardIds().length === 5, 'codex source window loaded');
    sh.forwardGrayAfterSidebarNav = fwdBtn().disabled;
    // 8) 再进堆叠，Esc 退出：与按钮退出同一历史结果（前进亮）。
    await openStackDblclick('enter for Esc probe');
    await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2, 'entered stack for Esc probe');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await waitFor(() => !inStackNow() && gallerySettled(), 'Esc exits the stack');
    sh.escExited = true;
    sh.forwardEnabledAfterEscExit = !fwdBtn().disabled;
    // 9) 窄屏（≤767px）：堆叠里只露后退（可见可点），前进不可见；退出后两个
    //    都隐藏。live resize 由驱动器的 __MOSA_E2E_RESIZE__ 通道执行。
    console.log('__MOSA_E2E_RESIZE__ 640x900');
    await waitFor(() => window.innerWidth === 640, 'narrow viewport applied', 30000);
    await waitFor(() => gallerySettled() && Boolean(stackNodeEl()), 'gallery settled at narrow width');
    await openStackDblclick('narrow enter');
    await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2, 'entered stack at narrow width');
    sh.narrow = {
      inStackBackVisible: getComputedStyle(backBtn()).display !== 'none' && !backBtn().disabled,
      inStackForwardHidden: getComputedStyle(fwdBtn()).display === 'none',
    };
    click('#navHistoryBack');
    await waitFor(() => !inStackNow() && gallerySettled(), 'back button exits the stack at narrow width');
    sh.narrow.exitedByBack = true;
    sh.narrow.bothHiddenAfterExit = getComputedStyle(backBtn()).display === 'none' && getComputedStyle(fwdBtn()).display === 'none';
    console.log('__MOSA_E2E_RESIZE__ 1440x800');
    await waitFor(() => window.innerWidth === 1440, 'wide viewport restored', 30000);
    await waitFor(() => gallerySettled() && Boolean(stackNodeEl()), 'gallery settled back at wide width');
    // 10) 解散堆叠（堆叠内空白右键 + 确认）：退出后堆叠记录被丢弃，前进保持灰。
    await openStackDblclick('enter for dissolve');
    await waitFor(() => inStackNow() && gallerySettled() && rootCardIds().length === 2, 'entered stack for dissolve');
    const dissolveItem = await openContextMenu('#assetGrid', stackMenu.dissolveStack);
    dissolveItem.click();
    await answerConfirmDialog({ confirm: true });
    await waitFor(() => !inStackNow() && gallerySettled()
      && rootCardIds().includes('navh-img-01') && rootCardIds().includes('navh-img-03'), 'dissolve exits to the root');
    sh.dissolveExited = true;
    sh.forwardGrayAfterDissolve = fwdBtn().disabled;

    facts.rendererErrors = rendererErrors.length;
    assert(facts.rendererErrors === 0, 'no renderer errors');
    return facts;
  })()`;
}

function sessionTwoSource() {
  return `(async () => {
    ${PAGE_HELPERS}
    await waitFor(() => gallerySettled() && document.querySelectorAll('#assetGrid > .asset-card').length > 0, 'gallery ready after reload', 30000);
    // 1280 宽默认开着检视器；先关到与 session one 末态相同的布局状态。
    const detailClose = document.querySelector('#detailPanel .detail-close');
    if (detailClose && document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'false') detailClose.click();
    await waitFor(() => document.querySelector('#detailPanel')?.getAttribute('aria-hidden') === 'true', 'inspector closed after reload');
    let previous = '';
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await sleep(120);
      const grid = document.querySelector('#assetGrid');
      const next = getComputedStyle(grid).gridTemplateColumns;
      if (next === previous) break;
      previous = next;
    }
    const grid = document.querySelector('#assetGrid');
    return {
      sliderValue: document.querySelector('#gallerySizeSlider').value,
      storedSize: localStorage.getItem('mosa.gallery-card-size') || '',
      columns: getComputedStyle(grid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length,
      rendererErrors: rendererErrors.length,
    };
  })()`;
}
