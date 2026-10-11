// R21（Web 端）检视器主体契约（任务 24，头部以下区块）：只读 web/app/styles.css。
// 锁定：区块左右内边距 24 与 1px 分隔线、小标题 10.5px/590、标签 4/8 内边距与
// 10px 字号、提示词框四项、参考图 3 列网格、来源卡边框/圆角/按钮行、表单控件
// 高 32/圆角 8、本任务新增字号下限 10px，以及浅色覆盖后 hover/active 语义补回。
// 任务 41：区块小标题复制按钮改带文字后按 AA 校色（#929297 → #6e6e73）。
// 任务 43：小标题与来源卡键名随 AA 加深（#8d8d93 → #707076、#a0a0a6 → #707076）。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const readWebCss = () => readFile(resolve(root, "web/app/styles.css"), "utf8");

// 同一选择器在样式表里出现多次时，浏览器用的是最后一组；任务 24 的规则全部
// 追加在文件末尾，这里一律按「最后一次出现」取块（写法同 web-r21-inspector-head）。
// 选择器可能写在逗号分组里（组的声明在最后一个成员之后），所以选择器后面
// 允许跟「 {」或「,\n」，再吞到本条规则的收尾大括号。
function lastBlock(css, selector) {
  const pattern = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?: \\{|,\\n)[^}]*\\}`, "g");
  const blocks = css.match(pattern) || [];
  assert.ok(blocks.length, `${selector} must exist`);
  return blocks.at(-1);
}

test("A4a sections use the design 20px rhythm with per-section top spacing", async () => {
  const css = await readWebCss();
  // GravityPort A4a：区块间距照稿子（区块间 20、左右内边距 20、区块头下距 4）。
  const prompt = lastBlock(css, ".mosa-v2 .detail .detail-prompt-section");
  assert.match(prompt, /padding: var\(--sp-5\) var\(--sp-5\) 0;/, "prompt section keeps the 20px top gap");
  const reference = lastBlock(css, ".mosa-v2 .detail .detail-reference-section");
  assert.match(reference, /padding: var\(--sp-5\) var\(--sp-5\) 0;/);
  const versionContext = lastBlock(css, ".mosa-v2 .detail .detail-version-context");
  assert.match(versionContext, /padding: var\(--sp-5\) var\(--sp-5\);/);
  const palette = lastBlock(css, ".mosa-v2 .detail .detail-palette-section");
  assert.match(palette, /padding: var\(--sp-3\) var\(--sp-5\) 0;/, "palette follows the tags row by 12px");
  const tags = lastBlock(css, ".mosa-v2 .detail .detail-tags-section");
  assert.match(tags, /padding: var\(--sp-2\) var\(--sp-5\) 0;/, "tags sit 10px under the head block");
  const overview = lastBlock(css, ".mosa-v2 .detail .detail-overview");
  assert.match(overview, /padding: 0 var\(--sp-5\) var\(--sp-2\);/, "the head block hugs the 64px header");
  // 沿用现有描边：提示词区块顶部分隔线规则保留（约定：描边不比、沿用现有）。
  assert.match(css, /\.mosa-v2 \.detail \.detail-prompt-section \{[\s\S]*?border-top: 1px solid var\(--inspector-divider\);[\s\S]*?border-radius: 0;[\s\S]*?background: transparent;/);
});

test("section titles read as 12px/16 heads with copy buttons in .copy grey", async () => {
  const css = await readWebCss();
  const head = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head");
  assert.match(head, /height: 16px;/);
  assert.match(head, /margin-bottom: var\(--sp-1\);/);
  // 任务 110：小节标题提级到 --text-sm(12px)/semibold,与正文拉开层级(区块头高度 16 保持不变)。
  const title = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head h3");
  assert.match(title, /font-size: var\(--text-sm\);/);
  assert.match(title, /line-height: var\(--text-sm-lh\);/);
  const subhead = lastBlock(css, ".mosa-v2 .detail .detail-prompt-subhead");
  assert.match(subhead, /height: 16px;/);
  assert.match(subhead, /margin-top: var\(--sp-5\);/);
  const subheadTitle = lastBlock(css, ".mosa-v2 .detail .detail-prompt-subhead h4");
  assert.match(subheadTitle, /font-size: var\(--text-sm\);/);
  // 任务 110：标题字重与颜色提级（semibold / primary），来源摘要 span 不在其列。
  assert.match(css, /\.mosa-v2 \.detail \.detail-prompt-head h3,\n\.mosa-v2 \.detail \.detail-prompt-subhead h4 \{\n  font-size: var\(--text-sm\);\n  font-weight: var\(--weight-semibold\);\n  line-height: var\(--text-sm-lh\);\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head h3, \.detail-prompt-subhead h4\) \{\n  color: var\(--color-text-primary\);\n\}/);
  const disclosure = lastBlock(css, ".mosa-v2 .detail .detail-disclosure > summary");
  assert.match(disclosure, /font-size: var\(--text-xs\);/);
  assert.match(disclosure, /font-weight: var\(--weight-medium\);/);
  // 任务 43：辅助键名随 AA 加深 #8d8d93 → #707076（面板 #fbfbfc 上 4.76:1）。
  // 任务 110：四个小节标题（h3/h4）从这条 :is 组拆出、改回 primary（上一条断言），
  // 其余辅助名保持 #707076。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-source-summary > span, \.detail-disclosure > summary, \.detail-fields \.field > span\) \{\n  color: #707076;\n\}/);
  // 任务 41：复制按钮带文字后按 AA 校色——R21 稿 #929297 只有 2.99:1，加深为 #6e6e73
  // （面板 #fbfbfc 上 4.90:1）；同一 :is 块里的来源摘要 strong 一并达标。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head \.section-head-copy, \.detail-copy-sub, \.detail-source-copy \.section-head-copy, \.detail-source-summary > strong\) \{\n  color: #6e6e73;\n\}/);
  const icon = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head .section-head-copy svg");
  assert.match(icon, /width: 12px;/);
  assert.match(icon, /height: 12px;/);
  // A4a：区块头右侧「查看」按钮沿用复制按钮的浅/深色。
  const view = lastBlock(css, ".mosa-v2 .detail .detail-section-view");
  assert.match(view, /font-size: var\(--text-xs\);/, "查看 follows the --text-xs floor (返工 1, 规范表 v1)");
  assert.match(css, /:root\[data-theme="dark"\] \.mosa-v2 \.detail \.detail-section-view \{ color: #d1d1d6; \}/);
});

test("tags use 20px pills with the 4px radius, 4px gaps and the light palette", async () => {
  const css = await readWebCss();
  const tag = lastBlock(css, ".mosa-v2 .detail .detail-tag");
  // GravityPort A4a：胶囊 20 高、圆角 4、横竖间距 4（量数）。
  assert.match(tag, /min-height: 20px; height: 20px;/);
  assert.match(tag, /padding: 0 var\(--sp-2\);/);
  assert.match(tag, /border-radius: var\(--radius-xs\);/);
  const tagLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-tag \{[^}]*\}/.exec(css)?.[0];
  assert.match(tagLight, /border-color: transparent;/);
  assert.match(tagLight, /background: #f0f0f2;/);
  assert.match(tagLight, /color: #5b5b61;/);
  const row = lastBlock(css, ".mosa-v2 .detail .detail-tags-row");
  assert.match(row, /gap: var\(--sp-1\);/, "tags must sit 4px apart");
  assert.match(row, /max-height: none;/, "folding is count-based; a height cap with overflow:visible would paint expanded rows over the palette and prompt");
  const add = lastBlock(css, ".mosa-v2 .detail .detail-tags-add");
  assert.match(add, /min-height: 20px; height: 20px;/);
});

test("prompt tabs render as 40×12-class chips with the 2px radius and 4px gap", async () => {
  const css = await readWebCss();
  const toggle = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head .detail-prompt-toggle");
  assert.match(toggle, /height: 12px;/);
  assert.match(toggle, /padding: 0 var\(--sp-1\);/);
  assert.match(toggle, /border-radius: var\(--radius-xs\);/);
  assert.match(toggle, /font-size: var\(--text-xs\);/);
  const active = lastBlock(css, ".mosa-v2 .detail .detail-prompt-head .detail-prompt-toggle.is-active");
  assert.match(active, /border-color: var\(--color-text-primary\);/, "the active tab keeps a token border");
});

test("prompt and instruction boxes grow with content, cap at 120px, and scroll", async () => {
  const css = await readWebCss();
  const box = lastBlock(css, ".mosa-v2 .detail .detail-prompt-box");
  assert.match(box, /max-height: 120px;/);
  assert.doesNotMatch(box, /(^|[^-])height: \d+px;|min-height: \d+px;/, "no fixed height or min-height: empty boxes collapse to one text line");
  assert.match(box, /border-radius: var\(--radius-xs\);/);
  const instruction = lastBlock(css, ".mosa-v2 .detail .detail-instruction-box");
  assert.match(instruction, /max-height: 120px;/);
  assert.doesNotMatch(instruction, /(^|[^-])height: \d+px;|min-height: \d+px;/);
  assert.match(instruction, /margin-top: var\(--sp-1\);/);
  // 任务 110：正文提级到 --text-sm/--text-sm-lh(12/16),与小节标题同字号、靠字重分层级。
  const typography = lastBlock(css, ".mosa-v2 .detail .detail-prompt-box,\n.mosa-v2 .detail .detail-instruction-box");
  assert.match(typography, /padding: var\(--sp-3\);/);
  assert.match(typography, /font-size: var\(--text-sm\);/);
  assert.match(typography, /line-height: var\(--text-sm-lh\);/);
  const light = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-prompt-box,\n:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-instruction-box \{[^}]*\}/.exec(css)?.[0];
  assert.match(light, /border-color: transparent;/);
  assert.match(light, /background: #f3f3f5;/);
  assert.match(light, /color: #4a4a50;/);
  // 任务 124：两个框都是人写的文字——都用界面字体（指令框此前一直继承 .prompt-box 的
  // 等宽字体），都保留原文的换行和分段。全文件里这两个选择器没有别处再改这两项。
  for (const selector of [".mosa-v2 .detail .detail-prompt-box", ".mosa-v2 .detail .detail-instruction-box"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const declaring = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`, "g"))].map((match) => match[1]);
    const fonts = declaring.flatMap((body) => [...body.matchAll(/font-family: ([^;]+);/g)].map((match) => match[1]));
    const spaces = declaring.flatMap((body) => [...body.matchAll(/white-space: ([^;]+);/g)].map((match) => match[1]));
    assert.deepEqual(fonts, ["var(--font-family-ui)"], `${selector} uses the UI font`);
    assert.deepEqual(spaces, ["pre-wrap"], `${selector} keeps line breaks`);
  }
});

test("palette swatches are 24×12 with the 4px radius and 2px gaps", async () => {
  const css = await readWebCss();
  const row = lastBlock(css, ".mosa-v2 .detail .detail-palette-row");
  assert.match(row, /display: flex;/);
  assert.match(row, /gap: var\(--sp-half\);/);
  const swatch = lastBlock(css, ".mosa-v2 .detail .detail-palette-swatch");
  assert.match(swatch, /width: 24px; height: 12px;/);
  assert.match(swatch, /border-radius: var\(--radius-xs\);/);
  assert.match(swatch, /border: 0;/, "the swatch colors by data only, no chrome");
});

test("reference thumbnails sit in a 64px box as 56×56 tiles in one clipped row", async () => {
  const css = await readWebCss();
  const box = lastBlock(css, ".mosa-v2 .detail .detail-reference-box");
  assert.match(box, /height: 64px;/);
  assert.match(box, /padding: var\(--sp-1\);/);
  assert.match(box, /border-radius: var\(--radius-xs\);/);
  assert.match(box, /overflow: hidden;/, "thumbnails clip instead of wrapping");
  // 任务 110：没有参考图时空框收到 28px（与版本树空框一致），有图仍 64px。
  assert.match(css, /\.mosa-v2 \.detail \.detail-reference-box:has\(> \.detail-reference-empty\) \{ height: 28px; \}/);
  const thumbs = lastBlock(css, ".mosa-v2 .detail .detail-reference-box .detail-reference-thumbnails");
  assert.match(thumbs, /display: flex;/);
  assert.match(thumbs, /gap: var\(--sp-1\);/);
  assert.match(thumbs, /overflow: hidden;/);
  const thumb = lastBlock(css, ".mosa-v2 .detail .detail-reference-box .detail-reference-thumb");
  assert.match(thumb, /width: 56px; height: 56px;/);
  assert.match(thumb, /border-radius: var\(--radius-xs\);/);
  const boxLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-reference-box \{[^}]*\}/.exec(css)?.[0];
  assert.match(boxLight, /border-color: #e7e7ea;/);
  assert.match(boxLight, /background: #f3f3f5;/);
});

test("version context rows are 40px tall with 40×40 thumbnails and 4px rhythm", async () => {
  const css = await readWebCss();
  const box = lastBlock(css, ".mosa-v2 .detail .detail-version-context-box");
  assert.match(box, /gap: var\(--sp-1\);/);
  assert.match(box, /padding: var\(--sp-1\);/);
  assert.match(box, /border-radius: var\(--radius-xs\);/);
  const row = lastBlock(css, ".mosa-v2 .detail .detail-version-context-row");
  assert.match(row, /height: 40px;/);
  assert.match(row, /padding: var\(--sp-1\);/);
  // 任务 75：行是复用 open-generation-output 的按钮——无按钮默认外观，键盘焦点
  // 用既有焦点环 token。
  assert.match(row, /border: 0;/);
  assert.match(row, /text-align: left;/);
  assert.match(row, /cursor: pointer;/);
  assert.match(css, /\.mosa-v2 \.detail \.detail-version-context-row:disabled \{ cursor: default; \}/);
  assert.match(css, /\.mosa-v2 \.detail \.detail-version-context-row:focus-visible \{ outline: 2px solid var\(--color-focus-ring, #0a84ff\); outline-offset: 2px; \}/);
  const thumb = lastBlock(css, ".mosa-v2 .detail .detail-version-context-row .generation-output-thumb");
  assert.match(thumb, /width: 40px; height: 40px;/);
  assert.match(thumb, /border-radius: var\(--radius-xs\);/);
  assert.match(thumb, /border: 0;/, "the thumb is a true 40×40 (the shared class's 1px border is reset in this box)");
  const model = lastBlock(css, ".mosa-v2 .detail .detail-version-context-model");
  assert.match(model, /font-size: var\(--text-xs\);/, "version context rows follow the --text-xs floor (返工 1, 规范表 v1)");
  assert.match(model, /text-overflow: ellipsis;/);
  assert.match(model, /line-height: var\(--text-xs-lh\);/, "14px line pitch ×3 fills the 40px row for the conversation lines");
  // 任务 75：对话模式的三行小字列与轮次/合计行（同 --text-xs 字号下限、省略号截断）。
  const lines = lastBlock(css, ".mosa-v2 .detail .detail-version-context-lines");
  assert.match(lines, /flex-direction: column;/);
  assert.match(lines, /justify-content: center;/);
  const turn = lastBlock(css, ".mosa-v2 .detail .detail-version-context-turn,\n.mosa-v2 .detail .detail-version-context-total");
  assert.match(turn, /font-size: var\(--text-xs\);/);
  assert.match(turn, /line-height: var\(--text-xs-lh\);/);
  assert.match(turn, /text-overflow: ellipsis;/);
  const current = lastBlock(css, ".mosa-v2 .detail .detail-version-context-current");
  assert.match(current, /color: var\(--color-accent\);/, "the current-asset marker uses the accent token");
  const boxLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-version-context-box \{[^}]*\}/.exec(css)?.[0];
  assert.match(boxLight, /border-color: #e7e7ea;/);
  assert.match(boxLight, /background: #f3f3f5;/);
  const rowLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-version-context-row \{[^}]*\}/.exec(css)?.[0];
  assert.match(rowLight, /background: rgb\(255 255 255 \/ \.7\);/);
  // 浅色轮次/合计行沿用模型行的浅色灰；当前素材行不得被覆盖掉强调色。
  const turnLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-version-context-turn:not\(\.detail-version-context-current\),\n:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-version-context-total \{[^}]*\}/.exec(css)?.[0];
  assert.match(turnLight, /color: #636369;/);
});

test("source facts render as an R21 context card with an equal-split action row", async () => {
  const css = await readWebCss();
  const table = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-table");
  assert.match(table, /gap: var\(--sp-1\);/);
  assert.match(table, /padding: var\(--sp-3\);/);
  assert.match(table, /border: 1px solid transparent;/);
  assert.match(table, /border-radius: var\(--radius-md\);/);
  const tableLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-table \{[^}]*\}/.exec(css)?.[0];
  assert.match(tableLight, /border-color: #e7e7ea;/);
  assert.match(tableLight, /background: #fafafa;/);
  const metaKey = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-key");
  assert.match(metaKey, /font-size: var\(--text-xs\);/);
  const metaVal = lastBlock(css, ".mosa-v2 .detail .detail-source-content .meta-val");
  assert.match(metaVal, /text-align: right;/, "source values must right-align like R21 context-facts");
  assert.match(metaVal, /overflow-wrap: normal;/, "source values must stay single-line with ellipsis");
  // 任务 43：来源卡键名随 AA 加深 #a0a0a6 → #707076（卡底 #fafafa 上 4.71:1）。
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-key \{\n  color: #707076;\n\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.meta-val \{\n  color: #66666c;\n\}/);
  const nav = lastBlock(css, ".mosa-v2 .detail .detail-source-content .generation-navigation");
  assert.match(nav, /display: grid;/);
  assert.match(nav, /grid-template-columns: repeat\(auto-fit, minmax\(0, 1fr\)\);/);
  assert.match(nav, /padding: var\(--sp-2\);/);
  const navLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-source-content \.generation-navigation \{[^}]*\}/.exec(css)?.[0];
  assert.match(navLight, /border-top-color: #e7e7ea;/);
  assert.match(navLight, /background: #f7f7f8;/);
  const navBtn = lastBlock(css, ".mosa-v2 .detail .generation-navigation .action-btn");
  assert.match(navBtn, /min-height: 28px;/);
  assert.match(navBtn, /border-radius: var\(--radius-md\);/);
  assert.match(navBtn, /font-size: var\(--text-xs\);/);
  const navBtnLight = /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn \{[^}]*\}/.exec(css)?.[0];
  assert.match(navBtnLight, /background: #ececef;/);
  assert.match(navBtnLight, /color: #606066;/);
});

test("version area unifies to the 10-10.5px scale with 12px row pitch and 8px radii", async () => {
  const css = await readWebCss();
  const timeline = lastBlock(css, ".mosa-v2 .detail .version-timeline");
  assert.match(timeline, /gap: var\(--sp-3\);/, "version rows must sit 12px apart");
  const single = lastBlock(css, ".mosa-v2 .detail .version-single strong");
  assert.match(single, /font-size: var\(--text-xs\);/);
  const picker = lastBlock(css, ".mosa-v2 .detail .version-picker select");
  assert.match(picker, /border-radius: var\(--radius-md\);/);
  assert.match(picker, /font-size: var\(--text-xs\);/);
  const compareSelect = lastBlock(css, ".mosa-v2 .detail .version-compare-controls select");
  assert.match(compareSelect, /height: 32px;/);
  assert.match(compareSelect, /border-radius: var\(--radius-md\);/);
  const compareGrid = lastBlock(css, ".mosa-v2 .detail .version-compare-grid");
  assert.match(compareGrid, /border-radius: var\(--radius-md\);/);
  const compareHead = lastBlock(css, ".mosa-v2 .detail .version-compare-head strong");
  assert.match(compareHead, /font-size: var\(--text-xs\);/);
  const compareRow = lastBlock(css, ".mosa-v2 .detail .version-compare-row > span");
  assert.match(compareRow, /font-size: var\(--text-xs\);/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.version-single strong, \.version-summary-label strong\) \{\n  color: var\(--color-accent\);\n\}/);
});

test("the two-column form row keeps its 8px gap", async () => {
  const css = await readWebCss();
  const two = lastBlock(css, ".mosa-v2 .detail .two");
  assert.match(two, /gap: var\(--sp-2\);/);
});

test("the pathbar pill is 28px tall, fully rounded, with token chrome", async () => {
  const css = await readWebCss();
  const bar = lastBlock(css, ".mosa-v2 .detail .detail-pathbar");
  assert.match(bar, /padding: var\(--sp-3\) var\(--sp-5\) var\(--sp-5\);/, "the capsule sits 20px from the card bottom/sides");
  const pill = lastBlock(css, ".mosa-v2 .detail .detail-pathbar-pill");
  // 任务 110：胶囊 36 → --control-md（28px）；圆角仍是全圆 --radius-pill。
  assert.match(pill, /height: var\(--control-md\);/);
  assert.match(pill, /border-radius: var\(--radius-pill\);/);
  const path = lastBlock(css, ".mosa-v2 .detail .detail-pathbar-path");
  assert.match(path, /display: flex;/);
  assert.match(path, /min-width: 0;/);
  // 任务 110：路径是「头 + 尾」两段中间省略——容器 flex，头段收缩画省略号、尾段不收缩。
  assert.match(css, /\.me-head \{ min-width: 0; flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(css, /\.me-tail \{ max-width: 100%; flex: 0 0 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  // 返工 1:胶囊文字照稿——「素材路径」标签、路径 10px、「打开」12px；任务 110：标签收敛到 --text-sm(12px)。
  const label = lastBlock(css, ".mosa-v2 .detail .detail-pathbar-label");
  assert.match(label, /font-size: var\(--text-sm\);/);
  assert.match(label, /font-weight: var\(--weight-medium\);/);
  assert.match(path, /font-size: var\(--text-xs\);/);
  const openBtn = lastBlock(css, ".mosa-v2 .detail .detail-pathbar-open");
  assert.match(openBtn, /font-size: var\(--text-sm\);/);
  const open = lastBlock(css, ".mosa-v2 .detail .detail-pathbar-open");
  assert.match(open, /min-height: 24px;/);
  assert.match(css, /\.mosa-v2 \.detail \.detail-pathbar-open:disabled \{ opacity: \.4; cursor: default; \}/);
});

test("the version/reference/palette sections fill the flex column in DOM order", async () => {
  const css = await readWebCss();
  const orders = [
    [".mosa-v2 .detail-overview", "order: 1;"],
    [".mosa-v2 .detail-tags-section", "order: 2;"],
    [".mosa-v2 .detail-palette-section", "order: 3;"],
    [".mosa-v2 .detail-prompt-section", "order: 4;"],
    [".mosa-v2 .detail-reference-section", "order: 5;"],
    [".mosa-v2 .detail-version-context", "order: 6;"],
  ];
  for (const [selector, declaration] of orders) {
    const block = lastBlock(css, selector);
    assert.match(block, new RegExp(declaration.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${selector} keeps its A4a order`);
  }
});

test("light overrides re-declare the hover/active semantics they would otherwise bury", async () => {
  const css = await readWebCss();
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.detail-tags-add:hover \{[^}]*color: var\(--color-text-primary\);[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail :is\(\.detail-prompt-head \.section-head-copy, \.detail-copy-sub, \.detail-source-copy \.section-head-copy\):hover \{[^}]*color: var\(--color-text-primary\);[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn:not\(:disabled\):not\(\[aria-disabled="true"\]\):hover \{[^}]*background: #e6e6e9;[^}]*\}/);
  assert.match(css, /:root\[data-theme="light"\] \.mosa-v2 \.detail \.generation-navigation \.action-btn:not\(:disabled\):not\(\[aria-disabled="true"\]\):active \{[^}]*background: #e0e0e4;[^}]*\}/);
});

test("every font size added by this task stays at or above the 10px floor", async () => {
  const css = await readWebCss();
  const marker = css.indexOf("R21 检视器主体");
  assert.notEqual(marker, -1, "the task 24 block must exist");
  const added = css.slice(marker);
  // 规范表 v1（任务 104）后字号走 :root 变量，这里解析 token 实际值再做下限校验。
  const tokens = new Map([...css.matchAll(/--text-(?:xs|sm|md|lg|xl):\s*(\d+(?:\.\d+)?)px/g)].map((m) => [m[0].match(/--text-[\w-]+/)[0], Number(m[1])]));
  assert.ok(tokens.size >= 5, `the spec-table font tokens must exist (got ${tokens.size})`);
  const sizes = [
    ...[...added.matchAll(/font-size: (\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1])),
    ...[...added.matchAll(/font-size: var\((--text-(?:xs|sm|md|lg|xl))\)/g)].map((match) => tokens.get(match[1])),
  ];
  assert.ok(sizes.length >= 20, `expected the task's font sizes to be pinned (got ${sizes.length})`);
  for (const size of sizes) {
    assert.ok(size >= 10, `every added font-size must stay >= 10px (got ${size}px)`);
  }
});
