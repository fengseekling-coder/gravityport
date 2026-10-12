// Pluggable e2e flow (任务 93)：堆叠之间剪切粘贴（A4e）。
// 剪切 A 堆 1 张 → 回外层再进 A（变淡跨视图保持）→ 堆叠卡片右键「粘贴到此堆叠」
// 移进 B（计数 2→3 / 3→2、toast 带堆叠名）→ 进 B ⌘X 剪 2 张 → 回「所有素材」
// ⌘V → 2 张变散图、B 剩 1 张自动解散（toast 附解散句）→ 剪切后 Esc 卡片恢复。
// Seed via API；页面内断言 DOM 事实；结束经 API 审计落库结果。
// 剪贴板一致性走任务单回退规则（窗口失焦取消）——隐藏驱动窗口永不失焦，
// 剪切状态在页面内存活；⌘V 用合成 paste 事件驱动真实的 document 处理链。

import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "stack-cut-paste";
export const description =
  "stack cut/paste: cut member in A (dim) -> dim persists across views -> stack-card 粘贴到此堆叠 moves into B (counts+toast) -> ⌘X two members in B -> ⌘V on 所有素材 un-stacks them and auto-dissolves B (toast) -> Esc cancels the cut -> API audit";

// 菜单文案与 web/app/i18n.mjs 对齐：cut=剪切, openStack=打开堆叠,
// pasteIntoStack=粘贴到此堆叠。
const MENU = {
  cut: "剪切",
  openStack: "打开堆叠",
  pasteIntoStack: "粘贴到此堆叠",
};

const CUT_PASTE_HELPERS = String.raw`
  const stackNodeSelector = (stackId) => '#assetGrid > .asset-card.is-stack[data-stack-id="' + CSS.escape(stackId) + '"]';
  const stackNodeOf = (stackId) => document.querySelector(stackNodeSelector(stackId));
  const stackCount = (stackId) => stackNodeOf(stackId)?.querySelector('.asset-stack-count')?.textContent || '';
  const stackTitle = (stackId) => stackNodeOf(stackId)?.querySelector('.asset-card-title')?.textContent || '';
  const isCut = (assetId) => document.querySelector(cardSelector(assetId))?.classList.contains('is-cut') || false;
  const menuLabels = () => [...document.querySelectorAll('.context-menu .context-menu-label')].map((node) => node.textContent || '');
  const allToastTexts = () => [...document.querySelectorAll('.toast-message')].map((node) => node.textContent || '');
  function ctrlClickCard(assetId) {
    const target = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
    if (!target) throw new Error('Missing card select for ' + assetId);
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true, metaKey: true }));
  }
  // ⌘/Ctrl+X 走 app.mjs 的 document keydown 路由（cutFromKeyboard）。
  function pressCutShortcut() {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'x', metaKey: true, ctrlKey: true }));
  }
  // ⌘V 的真实入口是 document paste 事件（setupPasteImport）；剪切分流发生在
  // 读取 clipboardData 内容之前，空 DataTransfer 即可驱动完整移动链路。
  function pressPasteShortcut() {
    const dataTransfer = new DataTransfer();
    let event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dataTransfer });
    if (!event.clipboardData) {
      event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: dataTransfer });
    }
    document.dispatchEvent(event);
  }
  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Escape' }));
  }
  const selectedCardIds = () => [...document.querySelectorAll('.asset-card.multi-selected')].map((card) => card.dataset.id).sort();
  // 本流程只需要顶层菜单项：openContextMenu 命中后直接点。
  async function rightClickChoose(selector, label) {
    const item = await openContextMenu(selector, label);
    item.click();
  }
  const enterStackViaMenu = async (stackId) => {
    await rightClickChoose(stackNodeSelector(stackId) + ' .asset-card-select', MENU.openStack);
    await waitFor(() => document.body.getAttribute('data-in-stack') === 'true' && gallerySettled(), 'entered stack ' + stackId.slice(0, 12));
  };
`;

function source(config, body) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    const MENU = ${JSON.stringify(MENU)};
    ${PAGE_HELPERS}
    ${CUT_PASTE_HELPERS}
    try {
      ${body}
    } catch (error) {
      return { __pageError: String((error && error.message) || error), __pageStack: String((error && error.stack) || "") };
    }
  })()`;
}

function expect(condition, message) {
  if (!condition) throw new Error(`stack-cut-paste: ${message}`);
}

export async function run(ctx) {
  await ctx.prepare();
  const first = await ctx.startServer();
  try {
    // ===== Seed：A 堆 3 张、B 堆 2 张 =====
    const seedAsset = async (fileName, [r, g, b], prompt) => {
      const imagePath = await ctx.makePng(fileName, [r, g, b]);
      const response = await ctx.api(first.origin, "POST", "/api/assets/create", { projectId: "default", imagePath, prompt });
      return response.asset.id;
    };
    const a1 = await seedAsset("cutpaste-a1.png", [220, 68, 74], "cut paste A1");
    const a2 = await seedAsset("cutpaste-a2.png", [74, 181, 92], "cut paste A2");
    const a3 = await seedAsset("cutpaste-a3.png", [240, 180, 40], "cut paste A3");
    const b1 = await seedAsset("cutpaste-b1.png", [108, 92, 231], "cut paste B1");
    const b2 = await seedAsset("cutpaste-b2.png", [58, 138, 87], "cut paste B2");
    const stackA = await ctx.api(first.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [a1, a2, a3] });
    const stackB = await ctx.api(first.origin, "POST", "/api/asset-stacks", { projectId: "default", assetIds: [b1, b2] });
    expect(stackA?.stack?.id && stackB?.stack?.id, `seed stacks: ${JSON.stringify([stackA, stackB])}`);
    // API 建堆不落名字（卡片标题回落封面文件名）；命名后 toast 断言带堆叠名。
    await ctx.api(first.origin, "PATCH", `/api/asset-stacks/${encodeURIComponent(stackA.stack.id)}`, { projectId: "default", name: "A堆" });
    await ctx.api(first.origin, "PATCH", `/api/asset-stacks/${encodeURIComponent(stackB.stack.id)}`, { projectId: "default", name: "B堆" });
    const ids = { a1, a2, a3, b1, b2, stackAId: stackA.stack.id, stackBId: stackB.stack.id };

    // ===== Page 1：进 A 剪 1 张 → 变淡跨视图保持 → B 卡片右键「粘贴到此堆叠」 =====
    const p1 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'two stack nodes');
      // 堆叠卡片本身的菜单没有「剪切」（要搬里面的图先进堆叠再剪）。
      await openContextMenu(stackNodeSelector(config.stackAId) + ' .asset-card-select', MENU.openStack);
      const nodeMenuHasCut = menuLabels().includes(MENU.cut);
      pressEscape();
      await waitFor(() => !document.querySelector('.context-menu'), 'stack node menu closed');
      await enterStackViaMenu(config.stackAId);
      await waitFor(() => rootCardIds().length === 3, 'three members inside A');
      const cutItem = await openContextMenu(cardSelector(config.a1), MENU.cut);
      cutItem.click();
      await sleep(80);
      await waitFor(() => isCut(config.a1), 'a1 dimmed after cut');
      // 回外层再进 A：剪切状态活着，回来看到的这张仍然是淡的。
      click('#navHistoryBack');
      await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 2, 'back to root');
      await enterStackViaMenu(config.stackAId);
      await waitFor(() => rootCardIds().length === 3 && isCut(config.a1), 'a1 still dimmed after re-entering A');
      click('#navHistoryBack');
      await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 2, 'back to root for paste');
      const bName = stackTitle(config.stackBId);
      const bCountBefore = stackCount(config.stackBId);
      const aCountBefore = stackCount(config.stackAId);
      await rightClickChoose(stackNodeSelector(config.stackBId) + ' .asset-card-select', MENU.pasteIntoStack);
      await waitFor(() => allToastTexts().some((text) => text.includes('已移动 1 张到「' + bName + '」')), 'moved-into-B toast');
      await waitFor(() => gallerySettled()
        && stackCount(config.stackBId) === '3'
        && stackCount(config.stackAId) === '2', 'counts B=3 / A=2');
      const dimAfterPaste = isCut(config.a1);
      return { nodeMenuHasCut, bName, bCountBefore, aCountBefore, dimAfterPaste };
    `));
    expect(p1.nodeMenuHasCut === false, `P1 stack node menu has no cut item: ${JSON.stringify(p1)}`);
    expect(p1.bCountBefore === "2" && p1.aCountBefore === "3", `P1 counts before paste: ${JSON.stringify(p1)}`);
    expect(p1.dimAfterPaste === false, `P1 dim cleared after successful paste: ${JSON.stringify(p1)}`);
    const stacks1 = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackBId)}/assets?project=default&limit=250`);
    const memberIds1 = (stacks1.assets || []).map((entry) => entry.id).sort();
    expect(JSON.stringify(memberIds1) === JSON.stringify([ids.a1, ids.b1, ids.b2].sort()),
      `P1 B members after paste: ${JSON.stringify(memberIds1)}`);

    // ===== Page 2：进 B ⌘X 剪 2 张 → 所有素材 ⌘V → 变散图 + B 自动解散 =====
    const p2 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled() && rootCardIds().length === 2, 'root before second round');
      await enterStackViaMenu(config.stackBId);
      await waitFor(() => rootCardIds().length === 3, 'three members inside B');
      ctrlClickCard(config.b1);
      await waitFor(() => selectedCardIds().length === 1, 'b1 selected');
      ctrlClickCard(config.b2);
      await waitFor(() => selectedCardIds().length === 2, 'b1+b2 selected');
      pressCutShortcut();
      await waitFor(() => isCut(config.b1) && isCut(config.b2), 'b1+b2 dimmed after ⌘X');
      click('#navHistoryBack');
      await waitFor(() => !document.body.hasAttribute('data-in-stack') && gallerySettled() && rootCardIds().length === 2, 'back to 所有素材');
      pressPasteShortcut();
      await waitFor(() => allToastTexts().some((text) => text.includes('已移出堆叠 2 张')
        && text.includes('原堆叠只剩一张，已解散')), 'moved-out toast with dissolve note');
      // B 解散：节点消失；b1/b2/a1 都以散图卡出现（A 节点保留）。
      await waitFor(() => gallerySettled()
        && !stackNodeOf(config.stackBId)
        && rootCardIds().length === 4, 'B node dissolved, four root cards left');
      const looseNow = [config.b1, config.b2, config.a1].filter((id) => {
        const card = document.querySelector(cardSelector(id));
        return card && !card.classList.contains('is-stack');
      });
      const dimAfterPaste = isCut(config.b1) || isCut(config.b2);
      return { looseNow, dimAfterPaste };
    `));
    expect(p2.looseNow.length === 3, `P2 b1/b2/a1 are loose cards: ${JSON.stringify(p2)}`);
    expect(p2.dimAfterPaste === false, `P2 dim cleared after un-stack paste: ${JSON.stringify(p2)}`);
    // API 审计：A 只剩 a2+a3；B 已解散（成员端点 404）；a1/b1/b2 成散图。
    const membersA2 = await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackAId)}/assets?project=default&limit=250`);
    const memberIdsA2 = (membersA2.assets || []).map((entry) => entry.id).sort();
    expect(JSON.stringify(memberIdsA2) === JSON.stringify([ids.a2, ids.a3].sort()),
      `P2 stack A keeps a2+a3 only: ${JSON.stringify(memberIdsA2)}`);
    // B 剩 1 张自动解散：成员端点 404（STACK_NOT_FOUND）。
    let dissolvedAudit = "";
    try {
      await ctx.api(first.origin, "GET", `/api/asset-stacks/${encodeURIComponent(ids.stackBId)}/assets?project=default&limit=250`);
    } catch (error) {
      dissolvedAudit = String(error?.message || error);
    }
    expect(dissolvedAudit.includes("404") && dissolvedAudit.includes("STACK_NOT_FOUND"),
      `P2 stack B auto-dissolved (404 STACK_NOT_FOUND): ${dissolvedAudit}`);
    // ===== Page 3：剪切后 Esc，卡片恢复正常 =====
    const p3 = await ctx.runInPage(first, source(ids, `
      await waitFor(() => gallerySettled(), 'gallery before Esc probe');
      const cutItem = await openContextMenu(cardSelector(config.b1), MENU.cut);
      cutItem.click();
      await sleep(80);
      await waitFor(() => isCut(config.b1), 'b1 dimmed after cut');
      pressEscape();
      await waitFor(() => !isCut(config.b1), 'Esc restored b1');
      return { escCancelled: !isCut(config.b1) };
    `));
    expect(p3.escCancelled === true, `P3 Esc cancels the cut: ${JSON.stringify(p3)}`);

    return { pages: 3, movedIntoB: 1, unstacked: 2, dissolved: ids.stackBId };
  } finally {
    await first.stop();
  }
}
