// 任务 217：对话轮次任选两版并排对比。roundCompareSelection（纯函数，规则：
// 有输出图的轮次 ≥2 才出对比、默认上一轮 vs 当前轮、无输出图的轮次不进选项）
// 与 VersionCompare 的字段行计算 versionCompareRows 都经 tsc 编译真实源码后
// import；组件再经 react-dom/server 渲染成静态标记，断言下拉框、并排图、图下
// 「第 N 轮」说明行和 .changed 标记。文案走真实的 i18n.ts + app-lifecycle.ts
// fill（与 App 同一接线）。编译产物放在 web/gravityport/node_modules 下的临时
// 目录里，编译出的 ESM 才能 resolve 到 react / react-dom。Node 标准库，零网络。
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport", "src");

let roundCompareSelection;
let conversationRoundRows;
let versionCompareRows;
let VersionCompare;
let translate;
let fill;
let createElement;
let renderToStaticMarkup;

before(async () => {
  // Compile target inside web/gravityport/node_modules: node resolves the
  // compiled "react" / "react-dom/server" imports from the adjacent tree.
  const compileRoot = await mkdtemp(join(repositoryRoot, "web", "gravityport", "node_modules", ".round-compare-test-"));
  const sources = [
    join(uiRoot, "mosa-api.ts"),
    join(uiRoot, "conversation-rounds.ts"),
    join(uiRoot, "i18n.ts"),
    join(uiRoot, "app-lifecycle.ts"),
    join(uiRoot, "version-compare.tsx"),
  ];
  // Compile as CommonJS: the emitted require("./i18n") resolves without an
  // extension (node ESM would not), and require("react") works anywhere.
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "commonjs",
    "--target", "es2022",
    "--moduleResolution", "node10",
    "--jsx", "react-jsx",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  ({ roundCompareSelection, conversationRoundRows } = await import(join(compileRoot, "conversation-rounds.js")));
  // CommonJS interop: the namespace's default is module.exports; the compiled
  // default export and the named helper both live on that object.
  const compareModule = (await import(join(compileRoot, "version-compare.js"))).default;
  ({ default: VersionCompare, versionCompareRows } = compareModule);
  ({ translate } = await import(join(compileRoot, "i18n.js")));
  ({ fill } = await import(join(compileRoot, "app-lifecycle.js")));
  // React 只装在 web/gravityport 下，用指向那棵树的 require 来解析。
  const webRequire = createRequire(join(repositoryRoot, "web", "gravityport", "package.json"));
  createElement = webRequire("react").createElement;
  renderToStaticMarkup = webRequire("react-dom/server").renderToStaticMarkup;
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

const SYNC = "2026-10-07T09:00:00.000Z";
const CONVERSATION = "conv-1";
// 「N 秒前」：数字越大时间越早，与 conversation-rounds 套件同一口径。
const iso = (secondsAgo) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - secondsAgo * 1000).toISOString();

const asset = (id, extra = {}) => ({
  id, deleted_at: null, thumbnail_url: `thumb://${id}`, thumbnail_ready: true,
  width: 1024, height: 768, image_url: `img://${id}`, preview_url: `preview://${id}`, medium_url: `medium://${id}`,
  ...extra,
});

const event = (id, outputAssetId, { turn = null, synced = SYNC, userPrompt = null, effective = null, created } = {}) => (
  {
    id, output_asset_id: outputAssetId, provider: "chatgpt", conversation_id: CONVERSATION,
    message_id: `msg-${id}`, turn_index: turn, turn_synced_at: turn === null ? null : synced,
    user_prompt: userPrompt || undefined, effective_prompt: effective || undefined,
    model: "gpt-5-4-thinking", created_at: created,
  }
);

const conversationEntry = (turnCount, syncedAt = SYNC) => ({ provider: "chatgpt", conversation_id: CONVERSATION, turn_count: turnCount, synced_at: syncedAt });

const historyOf = (events, { turnCount = 5 } = {}) => ({
  events,
  context_events: [],
  output_assets: events.map((item) => asset(item.output_asset_id)),
  conversations: turnCount === null ? [] : [conversationEntry(turnCount)],
  context_truncated: false,
});

// 主场景：4 张图 3 个有图轮次（第 2 轮两张），当前素材 a3 在第 2 轮。
function levelHistory() {
  return historyOf([
    event("e1", "a1", { turn: 1, created: iso(40) }),
    event("e2", "a2", { turn: 2, created: iso(30), userPrompt: "round two ask", effective: "round two prompt" }),
    event("e3", "a3", { turn: 2, created: iso(20), userPrompt: "round two ask", effective: "round two prompt" }),
    event("e4", "a4", { turn: 3, created: iso(10), userPrompt: "round three ask", effective: "round three prompt" }),
  ]);
}

const outputId = (row) => String(row.outputAsset?.id || "");

describe("roundCompareSelection (task 217)", () => {
  it("returns null when fewer than two rounds have images", () => {
    // 单轮一张。
    const single = historyOf([event("e1", "a1", { turn: 1, created: iso(10) })]);
    assert.equal(roundCompareSelection(conversationRoundRows(single, "a1"), "a1"), null);
    // 同一轮两张：轮次只有一个，没有「上一轮」可比。
    const sameRound = historyOf([
      event("e1", "a1", { turn: 2, created: iso(20) }),
      event("e2", "a2", { turn: 2, created: iso(10) }),
    ]);
    assert.equal(roundCompareSelection(conversationRoundRows(sameRound, "a2"), "a2"), null);
    // 无对话（plain 模式行集为空）。
    assert.equal(roundCompareSelection(conversationRoundRows(historyOf([]), "a1"), "a1"), null);
  });

  it("defaults: current in a middle round → previous round vs current", () => {
    const selection = roundCompareSelection(conversationRoundRows(levelHistory(), "a3"), "a3");
    assert.ok(selection);
    // 每个有图轮次一项：第 1 轮取 a1，第 2 轮的代表优先当前素材 a3，第 3 轮取 a4。
    assert.deepEqual(selection.options.map(outputId), ["a1", "a3", "a4"]);
    assert.deepEqual(selection.options.map((row) => row.turnIndex), [1, 2, 3]);
    assert.equal(outputId(selection.base), "a1");
    assert.equal(outputId(selection.target), "a3");
    assert.equal(selection.base.turnIndex, 1);
    assert.equal(selection.target.turnIndex, 2);
  });

  it("defaults: current in the first round → first round vs second round", () => {
    const selection = roundCompareSelection(conversationRoundRows(levelHistory(), "a1"), "a1");
    assert.ok(selection);
    assert.equal(outputId(selection.base), "a1");
    assert.equal(selection.base.turnIndex, 1);
    assert.equal(outputId(selection.target), "a2", "target falls forward to the second round");
    assert.equal(selection.target.turnIndex, 2);
  });

  it("defaults without a current round fall back to the last two rounds", () => {
    // 当前素材没有轮次（快照不合格）或不在行里：退化为最后两轮。
    const history = levelHistory();
    history.events[2] = event("e3", "a3", { turn: null, created: iso(20) });
    const selection = roundCompareSelection(conversationRoundRows(history, "a3"), "a3");
    assert.ok(selection);
    assert.equal(outputId(selection.base), "a2");
    assert.equal(outputId(selection.target), "a4");
  });

  it("rounds without output images never enter the options", () => {
    // 第 3 轮没有图（round 4 有图）：选项里没有第 3 轮，也不影响「≥2 轮」判定。
    const history = historyOf([
      event("e1", "a1", { turn: 1, created: iso(40) }),
      event("e2", "a2", { turn: 2, created: iso(20) }),
      event("e4", "a4", { turn: 4, created: iso(10) }),
    ]);
    const selection = roundCompareSelection(conversationRoundRows(history, "a4"), "a4");
    assert.ok(selection);
    assert.deepEqual(selection.options.map((row) => row.turnIndex), [1, 2, 4]);
    // 默认：当前在第 4 轮，基准是它上一「有图」的轮次（第 2 轮）。
    assert.equal(outputId(selection.base), "a2");
    assert.equal(outputId(selection.target), "a4");
  });

  it("rows without an output asset are dropped entirely", () => {
    const rows = [
      { event: event("e1", "a1", { turn: 1, created: iso(20) }), outputAsset: asset("a1"), isCurrent: false, turnIndex: 1 },
      { event: event("e2", "a2", { turn: 2, created: iso(10) }), outputAsset: null, isCurrent: false, turnIndex: 2 },
      { event: event("e3", "a3", { turn: 3, created: iso(5) }), outputAsset: asset("a3"), isCurrent: true, turnIndex: 3 },
    ];
    const selection = roundCompareSelection(rows, "a3");
    assert.ok(selection);
    assert.deepEqual(selection.options.map(outputId), ["a1", "a3"]);
    assert.equal(outputId(selection.base), "a1");
    assert.equal(outputId(selection.target), "a3");
  });

  it("images without a round number become their own options", () => {
    const history = levelHistory();
    history.events[3] = event("e4", "a4", { turn: null, created: iso(10) });
    const selection = roundCompareSelection(conversationRoundRows(history, "a3"), "a3");
    assert.ok(selection);
    assert.deepEqual(selection.options.map(outputId), ["a1", "a3", "a4"]);
    assert.equal(selection.options[2].turnIndex, null);
  });
});

describe("versionCompareRows (task 217)", () => {
  const base = { id: "a1", label: "第 1 轮", imageUrl: "medium://a1", values: { "尺寸": "1024 × 768", "用户指令": "", "提示词": "old prompt" } };
  const target = { id: "a3", label: "第 2 轮", imageUrl: "medium://a3", values: { "尺寸": "1024 × 768", "用户指令": "new ask", "提示词": "new prompt" } };

  it("marks exactly the fields whose two sides differ", () => {
    const rows = versionCompareRows(["尺寸", "用户指令", "提示词"], base, target);
    assert.deepEqual(rows.map((row) => row.changed), [false, true, true]);
    assert.deepEqual(rows.map((row) => row.field), ["尺寸", "用户指令", "提示词"]);
    assert.equal(rows[0].left, "1024 × 768");
    assert.equal(rows[1].left, "");
    assert.equal(rows[1].right, "new ask");
  });
});

describe("VersionCompare rendering (task 217)", () => {
  const entries = [
    { id: "a1", label: "第 1 轮", imageUrl: "medium://a1", values: { "尺寸": "1024 × 768", "用户指令": "", "提示词": "old prompt" } },
    { id: "a3", label: "第 2 轮", imageUrl: "medium://a3", values: { "尺寸": "2048 × 768", "用户指令": "new ask", "提示词": "new prompt" } },
  ];
  const props = {
    language: "zh",
    entries,
    fields: ["尺寸", "用户指令", "提示词"],
    defaultBaseId: "a1",
    defaultTargetId: "a3",
    captions: true,
  };

  it("renders two selects with the defaults picked, side-by-side images and captions", () => {
    const html = renderToStaticMarkup(createElement(VersionCompare, props));
    assert.match(html, /aria-label="基准版本"/);
    assert.match(html, /aria-label="目标版本"/);
    // 每个下拉框三个条目各一个 option……这里两个条目各一项，value 指向默认 id。
    assert.match(html, /<option value="a1" selected="">第 1 轮<\/option>/);
    assert.match(html, /<option value="a3" selected="">第 2 轮<\/option>/);
    const images = html.match(/<img[^>]*>/g) || [];
    assert.equal(images.length, 2);
    assert.match(images[0], /src="medium:\/\/a1"/);
    assert.match(images[1], /src="medium:\/\/a3"/);
    // 图下各一行「第 N 轮」。
    const captions = html.match(/<div class="version-compare-captions">[\s\S]*?<\/div>/) || [];
    assert.match(captions[0] || "", /<span>第 1 轮<\/span>/);
    assert.match(captions[0] || "", /<span>第 2 轮<\/span>/);
  });

  it("marks changed fields and renders empty values as —", () => {
    const html = renderToStaticMarkup(createElement(VersionCompare, props));
    const rows = html.match(/<div class="(changed|)"><strong>[^<]*<\/strong><span>[^<]*<\/span><span>[^<]*<\/span><\/div>/g) || [];
    assert.equal(rows.length, 3);
    assert.match(rows[0], /<strong>尺寸<\/strong><span>1024 × 768<\/span><span>2048 × 768<\/span>/);
    assert.match(rows[0], /^<div class="changed">/);
    assert.match(rows[1], /<strong>用户指令<\/strong><span>—<\/span><span>new ask<\/span>/);
    assert.match(rows[1], /^<div class="changed">/);
    assert.match(rows[2], /<strong>提示词<\/strong><span>old prompt<\/span><span>new prompt<\/span>/);
    assert.match(rows[2], /^<div class="changed">/);
    // 相同字段不标 changed：把两边改成一致再渲染。
    const same = renderToStaticMarkup(createElement(VersionCompare, {
      ...props,
      entries: entries.map((entry) => ({ ...entry, values: { ...entry.values, "尺寸": "1024 × 768" } })),
    }));
    assert.match(same, /<div class=""><strong>尺寸<\/strong><span>1024 × 768<\/span><span>1024 × 768<\/span><\/div>/);
  });

  it("renders nothing with fewer than two entries", () => {
    const html = renderToStaticMarkup(createElement(VersionCompare, { ...props, entries: entries.slice(0, 1) }));
    assert.equal(html, "");
  });

  it("translates the fixed labels through the real i18n table", () => {
    const zh = renderToStaticMarkup(createElement(VersionCompare, props));
    assert.match(zh, /<h4>版本对比<\/h4>/);
    const en = renderToStaticMarkup(createElement(VersionCompare, { ...props, language: "en" }));
    assert.match(en, /<h4>Compare versions<\/h4>/);
    assert.match(en, /aria-label="Base version"/);
    assert.match(en, /aria-label="Target version"/);
  });

  it("keeps the round copy wired through translate + fill", () => {
    assert.equal(fill(translate("第 {n} 轮", "zh"), { n: 2 }), "第 2 轮");
    assert.equal(fill(translate("第 {n} 轮", "en"), { n: 2 }), "Turn 2");
    assert.equal(translate("无轮次", "zh"), "无轮次");
    assert.equal(translate("无轮次", "en"), "No round");
  });
});
