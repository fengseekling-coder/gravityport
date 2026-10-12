// 任务 61：画廊重建不泄漏观察节点 + 退出堆叠后筛选控件/检视器行为正确的运行时验证。
// 54-3 退出堆叠后分类下拉要恢复快照态且可继续切换（任务 70 起类型按钮已从顶栏
// 移除，该契约的 UI 面只剩分类下拉）；54-5 进出堆叠是导航，不算「用户手动关闭
// 检视器」，之后单击卡片仍自动打开检视器；55-1 反复重建（搜索命中/不命中交替）
// 后画廊仍正常。观察器泄漏量不在页面断言（审查脚本 t-leak.mjs 在页面加载前注入
// 计数），这里锁界面事实 + 接口复查。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "gallery-rebuild-and-stack-exit";
export const description = "stack exit restores the category select and keeps inspector auto-open on card click; alternating hit/miss searches rebuild the gallery cleanly";

const HIT_TERM = "rebuildprobe";
const MISS_TERM = "zznomatchzz";
const ROOT_CATEGORY = "product";
const STACK_CATEGORY = "concept";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const create = async (fileName, [r, g, b], prompt) => ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(fileName, [r, g, b]),
      prompt,
      category: ROOT_CATEGORY,
    });
    const cover = await create("gr-cover.png", [181, 68, 74], `${HIT_TERM} stack cover`);
    const member = await create("gr-member.png", [74, 127, 181], `${HIT_TERM} stack member`);
    const plainA = await create("gr-plain-a.png", [58, 138, 87], `${HIT_TERM} plain one`);
    const plainB = await create("gr-plain-b.png", [140, 98, 181], `${HIT_TERM} plain two`);
    const stack = await ctx.api(server.origin, "POST", "/api/asset-stacks", {
      projectId: "default",
      assetIds: [cover.asset.id, member.asset.id],
      coverAssetId: cover.asset.id,
    });

    const config = {
      hitTerm: HIT_TERM,
      missTerm: MISS_TERM,
      stackId: stack.stack.id,
      coverId: cover.asset.id,
      memberId: member.asset.id,
      plainId: plainA.asset.id,
      rootCategory: ROOT_CATEGORY,
      stackCategory: STACK_CATEGORY,
    };

    const facts = await ctx.runInPage(server, pageSource(config));
    assertFacts(facts);

    // ===== 接口复查 =====
    // 1) 根视图筛选（图片 + product）下的素材数；root 把非封面成员折叠进堆叠
    //    节点卡，所以页面卡片数 = 命中素材数 - 折叠成员数。
    const filtered = await ctx.api(server.origin, "GET", `/api/assets?project=default&mediaKind=img&category=${ROOT_CATEGORY}&limit=250`);
    if ((filtered.assets || []).length - 1 !== facts.filteredCardCount) {
      throw new Error(`filtered asset count mismatch: api=${(filtered.assets || []).length} (folded=1) page=${facts.filteredCardCount}`);
    }
    // 2) 堆叠成员确实还是 2 个（预置未被界面操作破坏）。
    const stackDetail = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(config.stackId)}?project=default`);
    if (Number(stackDetail?.stack?.count) !== 2) {
      throw new Error(`stack member count changed: ${JSON.stringify(stackDetail?.stack)}`);
    }
    // 3) 清空搜索后：卡片 id 集合 == 接口素材 id 集合去掉被折叠的非封面成员。
    const all = await ctx.api(server.origin, "GET", "/api/assets?project=default&limit=250");
    const stackAssets = await ctx.api(server.origin, "GET", `/api/asset-stacks/${encodeURIComponent(config.stackId)}/assets?project=default&limit=250`);
    const coverId = stackDetail?.stack?.cover_asset_id || config.coverId;
    const foldedIds = (stackAssets.assets || []).map((asset) => asset.id).filter((id) => id !== coverId);
    const apiIds = (all.assets || []).map((asset) => asset.id).filter((id) => !foldedIds.includes(id)).sort();
    const pageIds = [...facts.finalCardIds].sort();
    if (JSON.stringify(pageIds) !== JSON.stringify(apiIds)) {
      throw new Error(`card id set mismatch: page=${JSON.stringify(pageIds)} api=${JSON.stringify(apiIds)} folded=${JSON.stringify(foldedIds)}`);
    }
    return {
      cards: pageIds.length,
      hitRounds: facts.hitRounds,
      missRounds: facts.missRounds,
      stackMembers: Number(stackDetail?.stack?.count),
    };
  } finally {
    await server.stop();
  }
}

function assertFacts(facts) {
  const expectations = {
    rootCardsBeforeFilters: 3,
    filteredCardCount: 3,
    enteredStack: true,
    stackCardsAfterCategoryFilter: 0,
    categoryAfterExit: ROOT_CATEGORY,
    categorySwitchesAfterExit: true,
    cardCountAfterCategoryReset: 3,
    rootInspectorAutoOpened: true,
    enteredStackWithInspectorOpen: true,
    stackMemberInspectorAutoOpened: true,
    backAtRootAfterFinalExit: true,
    delayedFrameSearchSurvives: true,
    hitRounds: 10,
    missRounds: 10,
    missShowsEmptyState: true,
    missShowsNoCards: true,
    finalErrorState: false,
    finalCardCount: 3,
    rendererErrors: 0,
  };
  const problems = Object.entries(expectations)
    .filter(([key, expected]) => facts?.[key] !== expected)
    .map(([key, expected]) => `${key}=${JSON.stringify(facts?.[key])} (expected ${JSON.stringify(expected)})`);
  if (problems.length) throw new Error(`Unexpected page facts: ${problems.join("; ")} — ${JSON.stringify(facts)}`);
}

function pageSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const facts = { hitRounds: 0, missRounds: 0 };
    const assert = (ok, label) => { if (!ok) throw new Error('gallery-rebuild-and-stack-exit: ' + label + ' diagnostic=' + JSON.stringify(pageDiagnostic())); };
    const categoryValue = () => document.querySelector('#categorySelect')?.value ?? '';
    const stackNode = () => document.querySelector('#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(config.stackId) + '"]');

    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three root cards (stack node + two plain)');
    facts.rootCardsBeforeFilters = rootCardIds().length;

    // ===== 根视图：product 分类（任务 70：类型筛选入口已移除，只走分类下拉）=====
    // change 处理函数先 await 导航授权才 applyFilterChange，而两种分类的卡片数
    // 相同、下拉值又是同步改的——结果态区分不了新旧请求。先装 busy 记录器再
    // setValue：记录到一次 busy=true（这次 change 真的发出了画廊请求）且画廊
    // 重新空闲，筛选才算已应用。
    let busyTransitions = watchGalleryBusyTransitions();
    setValue('#categorySelect', config.rootCategory);
    await waitFor(() => galleryRequestRecordedBusy(busyTransitions) && gallerySettled()
      && rootCardIds().length === 3 && categoryValue() === config.rootCategory, 'category filter keeps every card');
    facts.filteredCardCount = rootCardIds().length;

    // ===== 双击进入堆叠 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack view');
    facts.enteredStack = true;

    // ===== 堆叠内：换分类（concept 把成员筛掉）=====
    setValue('#categorySelect', config.stackCategory);
    await waitFor(() => gallerySettled() && categoryValue() === config.stackCategory && rootCardIds().length === 0, 'stack category filters the members out');
    facts.stackCardsAfterCategoryFilter = rootCardIds().length;

    // ===== 返回退出堆叠：控件恢复快照态（54-3） =====
    click('#navHistoryBack');
    await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled(), 'exited stack view');
    // exitStack 的 rAF 收尾（滚动/选中恢复 + 焦点回落到封面卡）在隐藏窗口里被
    // 节流：不等它落地就点卡会被迟到的恢复覆盖（实测）。焦点回到卡片或
    // 画格即代表 rAF 已执行。
    await waitFor(() => Boolean(document.activeElement?.closest?.('.asset-card'))
      || document.activeElement === document.querySelector('#assetGrid'), 'stack exit restored focus');
    facts.categoryAfterExit = categoryValue();
    assert(facts.categoryAfterExit === config.rootCategory, 'category select must show the pre-enter value');
    // 下拉没有失步：恢复「product」后要能继续切走再切回（handler 早退即卡死）。
    // 切走/切回的等待与首切同理：busy 记录器证明这次 change 发出了请求。
    busyTransitions = watchGalleryBusyTransitions();
    setValue('#categorySelect', '');
    await waitFor(() => galleryRequestRecordedBusy(busyTransitions) && gallerySettled()
      && categoryValue() === '' && rootCardIds().length === 3, 'category switches after exit');
    facts.categorySwitchesAfterExit = true;
    facts.cardCountAfterCategoryReset = rootCardIds().length;
    busyTransitions = watchGalleryBusyTransitions();
    setValue('#categorySelect', config.rootCategory);
    await waitFor(() => galleryRequestRecordedBusy(busyTransitions) && gallerySettled()
      && rootCardIds().length === 3 && categoryValue() === config.rootCategory, 'category restored for the inspector steps');

    // ===== 退出堆叠后单击卡片自动打开检视器（54-5） =====
    const cardNow = () => document.querySelector(cardSelector(config.plainId) + ' .asset-card-select');
    cardNow().click();
    await waitFor(() => document.querySelector('#openInspectorBtn')?.hidden === true, 'inspector auto-opens on plain card click');
    facts.rootInspectorAutoOpened = true;

    // ===== 检视器开着时双击进堆叠（导航关闭），单击成员卡自动打开 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible again');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack with inspector open');
    facts.enteredStackWithInspectorOpen = true;
    const memberCard = document.querySelector(cardSelector(config.memberId) + ' .asset-card-select');
    assert(Boolean(memberCard), 'stack member card visible inside stack');
    memberCard.click();
    await waitFor(() => document.body.classList.contains('detail-open'), 'inspector auto-opens on member card click');
    facts.stackMemberInspectorAutoOpened = true;

    // ===== 再退出，回到根视图做重建循环 =====
    click('#navHistoryBack');
    await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 3, 'back at root for rebuild loop');
    facts.backAtRootAfterFinalExit = true;

    // ===== 快速返回：堆叠内改筛选的请求还没返回就退出，画廊不能卡在加载中 =====
    await waitFor(() => Boolean(stackNode()), 'stack node visible for quick exit');
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack for quick exit');
    setValue('#categorySelect', config.stackCategory);
    click('#navHistoryBack');
    await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 3, 'quick exit with an in-flight stack request settles');
    facts.quickExitSettled = true;

    // ===== 任务 95：退出堆叠的选中恢复不得放进延迟帧改写 selectedId =====
    // Windows 隐藏窗口把 rAF 攒到任意后续帧批量执行。若 exitStack 把
    // state.selectedId 的恢复留在 rAF 里，它会落在搜索 intent 的创建（input
    // 事件）与校验（防抖回调）之间：isNavigationIntentCurrent 的 selectedId
    // 比对失配，刚输入的搜索被静默丢弃，画廊停在旧结果且不忙。这里冻结
    // rAF，再进出堆叠一次制造退出尾巴，并把积压帧精准注入到不命中搜索的
    // 防抖窗口中点——空态必须照常渲染。
    const stackedRafs = [];
    const realRequestAnimationFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => { stackedRafs.push(callback); return stackedRafs.length; };
    const flushStackedRafs = () => { for (const callback of stackedRafs.splice(0)) callback(Date.now()); };
    stackNode().querySelector('.asset-card-select')
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack for delayed-frame probe');
    click('#navHistoryBack');
    await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 3, 'exited stack for delayed-frame probe');
    setValue('#searchInput', config.missTerm);
    await sleep(90);
    flushStackedRafs();
    await waitFor(() => gallerySettled() && rootCardIds().length === 0
      && Boolean(document.querySelector('#assetGrid .gallery-empty-state')), 'miss search survives a delayed stack-exit frame');
    facts.delayedFrameSearchSurvives = true;
    window.requestAnimationFrame = realRequestAnimationFrame;
    flushStackedRafs();
    setValue('#searchInput', config.hitTerm);
    await waitFor(() => gallerySettled() && rootCardIds().length === 4, 'hit search works after delayed-frame probe');

    // ===== 反复重建：命中/不命中交替各 10 次（55-1） =====
    for (let round = 0; round < 10; round += 1) {
      setValue('#searchInput', config.hitTerm);
      // 任务 83：搜索平铺——命中词让堆叠两成员（含封面）各自成卡，4 张全部
      // 出现，且任何一行都不渲染成堆叠节点或带角标。
      await waitFor(() => gallerySettled() && rootCardIds().length === 4
        && !document.querySelector('#assetGrid > .asset-card.is-stack')
        && !document.querySelector('#assetGrid .asset-stack-count'),
      'hit search shows all cards flat without stack chrome (round ' + round + ')');
      facts.hitRounds += 1;
      setValue('#searchInput', config.missTerm);
      await waitFor(() => gallerySettled() && rootCardIds().length === 0
        && Boolean(document.querySelector('#assetGrid .gallery-empty-state')), 'miss search shows empty state (round ' + round + ')');
      facts.missRounds += 1;
    }
    facts.missShowsEmptyState = facts.missRounds === 10;
    facts.missShowsNoCards = true;
    setValue('#searchInput', '');
    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'cleared search restores the full gallery');
    facts.finalCardIds = rootCardIds();
    facts.finalCardCount = facts.finalCardIds.length;
    facts.finalErrorState = Boolean(document.querySelector('#assetGrid .error-state'));
    facts.rendererErrors = rendererErrors.length;
    assert(facts.rendererErrors === 0, 'no renderer errors during rebuild loop');
    return facts;
  })()`;
}
