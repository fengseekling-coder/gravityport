// 任务 144：检视器「版本树」按对话轮次显示。computeConversationRounds /
// conversationRoundRows 的判定规则整体搬自旧版 test/conversation-rounds.test.mjs
// （任务 75 + 返工 1，断言照旧）；旧版测 HTML 拼接的用例改为测 roundLine 的
// 第二行文字（zh 全部形态 + 英文单复数）。实现经 tsc 编译真实的
// conversation-rounds.ts 后 import，文案走真实的 i18n.ts + app-lifecycle.ts
// fill（与 App 的 (text, params) => params ? fillNamed(text, params) : tr(text)
// 同一接线）。Node 标准库，零网络。
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport", "src");

let computeConversationRounds;
let conversationRoundRows;
let roundLine;
let translate;
let fill;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-rounds-"));
  const sources = [
    join(uiRoot, "mosa-api.ts"),
    join(uiRoot, "conversation-rounds.ts"),
    join(uiRoot, "i18n.ts"),
    join(uiRoot, "app-lifecycle.ts"),
  ];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources,
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  ({ computeConversationRounds, conversationRoundRows, roundLine } = await import(join(compileRoot, "conversation-rounds.js")));
  ({ translate } = await import(join(compileRoot, "i18n.js")));
  ({ fill } = await import(join(compileRoot, "app-lifecycle.js")));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

const SYNC = "2026-10-07T09:00:00.000Z";
const CONVERSATION = "conv-1";
// 「N 秒前」：数字越大时间越早，与生成树的 e2e 助手同一口径。
const iso = (secondsAgo) => new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - secondsAgo * 1000).toISOString();

const asset = (id, extra = {}) => ({ id, deleted_at: null, thumbnail_url: `thumb://${id}`, thumbnail_ready: true, ...extra });

const event = (id, outputAssetId, { conversation = CONVERSATION, provider = "chatgpt", message = `msg-${id}`, turn = null, synced = SYNC, model = "gpt-5-4-thinking", created, ...rest } = {}) => (
  { id, output_asset_id: outputAssetId, provider, conversation_id: conversation, message_id: message, turn_index: turn, turn_synced_at: turn === null ? null : synced, model, created_at: created, ...rest }
);

const conversationEntry = (turnCount, syncedAt = SYNC) => ({ provider: "chatgpt", conversation_id: CONVERSATION, turn_count: turnCount, synced_at: syncedAt });

const historyOf = (events, { assets, conversations = [], truncated = false } = {}) => ({
  events,
  context_events: [],
  output_assets: (assets ?? events.map((item) => asset(item.output_asset_id))),
  conversations,
  context_truncated: truncated,
});

// 主场景：5 张图 3 轮（第 2 轮 2 张、第 3 轮 2 张），当前素材 a3 在第 2 轮，
// 对话共 5 轮。turn_count 是 5，但只轮 1/2/3 有已收录图。
function aLevelHistory() {
  const events = [
    event("e1", "a1", { turn: 1, created: iso(50) }),
    event("e2", "a2", { turn: 2, created: iso(40) }),
    event("e3", "a3", { turn: 2, created: iso(30) }),
    event("e4", "a4", { turn: 3, created: iso(20) }),
    event("e5", "a5", { turn: 3, created: iso(10) }),
  ];
  return historyOf(events, { conversations: [conversationEntry(5)] });
}

// 与 App 同接线的翻译回调：translate 之后再 fill。
const zhT = (key, params) => (params ? fill(translate(key, "zh"), params) : translate(key, "zh"));
const enT = (key, params) => (params ? fill(translate(key, "en"), params) : translate(key, "en"));

describe("conversation rounds rules (ported from the old suite, assertions unchanged)", () => {
  it("context mode: rows follow created_at around the current asset and carry their own turns", () => {
    const result = computeConversationRounds(aLevelHistory(), "a3");
    assert.equal(result.mode, "context");
    assert.equal(result.turns, 5);
    assert.equal(result.images, 5);
    assert.deepEqual(result.rows.map((row) => row.event.output_asset_id), ["a2", "a3", "a4"], "the time window shows both turn-2 assets, not one per turn");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [2, 2, 3]);
    assert.deepEqual(result.rows.map((row) => row.isCurrent), [false, true, false]);
  });

  it("a turn_index beyond turn_count blanks only that row", () => {
    const history = aLevelHistory();
    history.events[3] = event("e4", "a4", { turn: 6, created: iso(20) });
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.equal(result.turns, 5);
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [2, 2, null], "the offending row loses its turn, the others keep theirs");
  });

  it("an asset without turn_index shows no turn on its own row only", () => {
    const history = aLevelHistory();
    history.events[1] = event("e2", "a2", { turn: null, created: iso(40) });
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [null, 2, 3]);
  });

  it("a stale-watermark asset blanks only its row (the re-synced neighbours keep theirs)", () => {
    const history = aLevelHistory();
    history.events[1] = event("e2", "a2", { turn: 2, synced: "2026-10-07T08:00:00.000Z", created: iso(40) });
    const result = computeConversationRounds(history, "a3");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [null, 2, 3]);
    assert.equal(result.turns, 5, "the conversation snapshot itself is still valid");
  });

  it("one asset carrying records with different turn_index blanks only its row", () => {
    const history = aLevelHistory();
    history.events.push(event("e6", "a2", { turn: 3, created: iso(9) }));
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [null, 2, 3], "a2 is inconsistent with itself, the other rows are unaffected");
  });

  it("context_truncated blanks every row's turn and hides the captured-image count", () => {
    const history = aLevelHistory();
    history.context_truncated = true;
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.equal(result.turns, null);
    assert.equal(result.images, null, "truncated counts may undercount, so no number is shown");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [null, null, null]);
  });

  // 返工 1 的「真实形状」：一个对话 16 张图，只有 2 张带同一次快照的轮次（2 和 3），
  // 对话共 3 轮——只有这 2 张对应的行显示轮次，其余行为 null，合计照常显示。
  function realShapeHistory() {
    const events = [];
    const assets = [];
    for (let image = 1; image <= 16; image += 1) {
      const id = `a${image}`;
      const turn = image === 7 ? 2 : image === 9 ? 3 : null;
      events.push(event(`e${image}`, id, { turn, created: iso(100 - image) }));
      assets.push(asset(id));
    }
    return historyOf(events, { assets, conversations: [conversationEntry(3)] });
  }

  it("real-shape conversation: 16 images, only two carry snapshot turns — those rows show turns, the rest stay blank", () => {
    // 当前素材 a8：窗口正好是带轮次的 a7/a9 夹着没轮次的 a8。
    const result = computeConversationRounds(realShapeHistory(), "a8");
    assert.equal(result.mode, "context");
    assert.equal(result.turns, 3);
    assert.equal(result.images, 16);
    assert.deepEqual(result.rows.map((row) => row.event.output_asset_id), ["a7", "a8", "a9"]);
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [2, null, 3]);
    // 远离带轮次素材的窗口：整窗无轮次，合计行照常。
    const tail = computeConversationRounds(realShapeHistory(), "a16");
    assert.deepEqual(tail.rows.map((row) => row.turnIndex), [null, null, null]);
    assert.equal(tail.turns, 3);
    assert.equal(tail.images, 16);
  });

  it("records of the current asset spanning two conversations fall back to no conversation", () => {
    const history = aLevelHistory();
    history.events.push(event("e6", "a3", { conversation: "conv-2", turn: 4, created: iso(8) }));
    history.conversations.push({ provider: "chatgpt", conversation_id: "conv-2", turn_count: 9, synced_at: SYNC });
    assert.equal(computeConversationRounds(history, "a3").mode, "plain");
  });

  it("records without turn indexes keep the count (the old B level is gone)", () => {
    const history = aLevelHistory();
    for (const [index, item] of history.events.entries()) {
      history.events[index] = event(item.id, item.output_asset_id, { turn: null, message: `m-${index}`, created: item.created_at });
    }
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.equal(result.images, 5, "message ids never affect the count");
    assert.deepEqual(result.rows.map((row) => row.turnIndex), [null, null, null]);
  });

  it("trashed assets are not counted, but the current asset counts even when trashed", () => {
    const history = aLevelHistory();
    history.output_assets.find((item) => item.id === "a5").deleted_at = "2026-10-07T10:00:00.000Z";
    const trashedCurrent = computeConversationRounds(history, "a2");
    assert.equal(trashedCurrent.mode, "context", "the stale row just leaves the counted set");
    assert.equal(trashedCurrent.images, 4);
    assert.deepEqual(trashedCurrent.rows.map((row) => row.event.output_asset_id), ["a1", "a2", "a3"], "current asset stays the row even though it is trashed");
    assert.deepEqual(trashedCurrent.rows.map((row) => row.turnIndex), [1, 2, 2]);
    // 当前素材本身在回收站：仍然计入且可作窗口中心。
    history.output_assets.find((item) => item.id === "a2").deleted_at = "2026-10-07T10:00:00.000Z";
    const currentTrashed = computeConversationRounds(history, "a2");
    assert.equal(currentTrashed.mode, "context");
    assert.equal(currentTrashed.images, 4, "the trashed current asset is still counted (a1..a4)");
  });

  it("records without a matching output_assets entry are not counted", () => {
    const history = aLevelHistory();
    history.events.push(event("e6", "ghost", { turn: 4, created: iso(8) }));
    const result = computeConversationRounds(history, "a3");
    assert.equal(result.mode, "context");
    assert.equal(result.images, 5);
    assert.ok(result.rows.every((row) => row.event.output_asset_id !== "ghost"));
  });

  it("the three-row window follows created_at: middle, first, last, and fewer than three assets", () => {
    const build = (turnNumbers, currentTurn, turnCount) => {
      const events = turnNumbers.map((turn, index) => event(`e${turn}`, `a${turn}`, { turn, created: iso(50 - index * 10) }));
      return historyOf(events, { conversations: [conversationEntry(turnCount)] });
    };
    const middle = computeConversationRounds(build([3, 4, 5, 6, 7], 5, 9), "a5");
    assert.deepEqual(middle.rows.map((row) => row.turnIndex), [4, 5, 6]);
    const first = computeConversationRounds(build([3, 4, 5, 6, 7], 3, 9), "a3");
    assert.deepEqual(first.rows.map((row) => row.turnIndex), [3, 4, 5], "at the start the window extends downward");
    assert.equal(first.rows[0].isCurrent, true);
    const last = computeConversationRounds(build([3, 4, 5, 6, 7], 7, 9), "a7");
    assert.deepEqual(last.rows.map((row) => row.turnIndex), [5, 6, 7], "at the end the window extends upward");
    const single = computeConversationRounds(build([4], 4, 9), "a4");
    assert.deepEqual(single.rows.map((row) => row.turnIndex), [4]);
    const pair = computeConversationRounds(build([4, 5], 4, 9), "a4");
    assert.deepEqual(pair.rows.map((row) => row.turnIndex), [4, 5]);
  });

  it("no conversation: non-chatgpt providers, empty conversation ids and unrecorded assets stay plain", () => {
    const flowHistory = historyOf([event("e1", "a1", { provider: "flow", turn: 1, created: iso(10) })], { conversations: [conversationEntry(5)] });
    assert.equal(computeConversationRounds(flowHistory, "a1").mode, "plain");
    const manualHistory = historyOf([event("e1", "a1", { conversation: "", turn: null, created: iso(10) })]);
    assert.equal(computeConversationRounds(manualHistory, "a1").mode, "plain");
    const unrecorded = computeConversationRounds(aLevelHistory(), "zz");
    assert.equal(unrecorded.mode, "plain");
    assert.equal(unrecorded.rows.length, 0, "plain rows come from the events fallback at the call site");
  });
});

describe("conversationRoundRows (the expanded list)", () => {
  it("lists every captured image of the conversation in asset-time order with the same per-row validation", () => {
    const history = aLevelHistory();
    history.events[1] = event("e2", "a2", { turn: 9, created: iso(40) });
    const rows = conversationRoundRows(history, "a3");
    assert.deepEqual(rows.map((row) => row.event.output_asset_id), ["a1", "a2", "a3", "a4", "a5"], "all five images, oldest first");
    assert.deepEqual(rows.map((row) => row.turnIndex), [1, null, 2, 3, 3], "per-row validation matches the windowed rows");
    assert.deepEqual(rows.map((row) => row.isCurrent), [false, false, true, false, false]);
    assert.equal(conversationRoundRows(aLevelHistory(), "zz").length, 0, "plain mode has no conversation rows");
  });
});

describe("roundLine — the second line text (task 144 item 2)", () => {
  const lineOf = (row, turns) => roundLine(row, { turns }, zhT);

  it("current row with a validated turn: 共 N 轮 · 当前第 n 轮", () => {
    assert.equal(lineOf({ isCurrent: true, turnIndex: 2 }, 5), "共 5 轮 · 当前第 2 轮");
  });

  it("other rows with a validated turn: 共 N 轮 · 第 n 轮", () => {
    assert.equal(lineOf({ isCurrent: false, turnIndex: 3 }, 5), "共 5 轮 · 第 3 轮");
  });

  it("a row whose turn failed validation keeps the total: 共 N 轮 · 当前 / 共 N 轮", () => {
    assert.equal(lineOf({ isCurrent: true, turnIndex: null }, 5), "共 5 轮 · 当前");
    assert.equal(lineOf({ isCurrent: false, turnIndex: null }, 5), "共 5 轮");
  });

  it("an invalid snapshot drops the total: 当前第 n 轮 / 第 n 轮 / 当前 / empty", () => {
    assert.equal(lineOf({ isCurrent: true, turnIndex: 1 }, null), "当前第 1 轮");
    assert.equal(lineOf({ isCurrent: false, turnIndex: 2 }, null), "第 2 轮");
    assert.equal(lineOf({ isCurrent: true, turnIndex: null }, null), "当前");
    assert.equal(lineOf({ isCurrent: false, turnIndex: null }, null), "");
  });

  it("context_truncated shows no turns and no total: the current row reads 当前, the rest stay empty", () => {
    // 截断的行 turnIndex 恒为 null（compute 置空），文字与快照无效的行一致。
    assert.equal(lineOf({ isCurrent: true, turnIndex: null }, null), "当前");
    assert.equal(lineOf({ isCurrent: false, turnIndex: null }, null), "");
  });

  it("English uses singular turn when turns is 1 and plural otherwise", () => {
    const en = (row, turns) => roundLine(row, { turns }, enT);
    assert.equal(en({ isCurrent: true, turnIndex: 2 }, 1), "1 turn · this asset, turn 2");
    assert.equal(en({ isCurrent: false, turnIndex: 3 }, 1), "1 turn · turn 3");
    assert.equal(en({ isCurrent: true, turnIndex: null }, 1), "1 turn · this asset");
    assert.equal(en({ isCurrent: false, turnIndex: null }, 1), "1 turn");
    assert.equal(en({ isCurrent: true, turnIndex: 2 }, 5), "5 turns · this asset, turn 2");
    assert.equal(en({ isCurrent: false, turnIndex: 3 }, 5), "5 turns · turn 3");
    assert.equal(en({ isCurrent: true, turnIndex: null }, 5), "5 turns · this asset");
    assert.equal(en({ isCurrent: false, turnIndex: null }, 5), "5 turns");
    assert.equal(en({ isCurrent: true, turnIndex: 1 }, null), "This asset, turn 1");
    assert.equal(en({ isCurrent: false, turnIndex: 2 }, null), "Turn 2");
    assert.equal(en({ isCurrent: true, turnIndex: null }, null), "This asset");
  });
});

describe("the 5-turn / 11-image shape", () => {
  // 5 轮、11 张、当前第 1 轮且最早；11 张里 8 张带轮次（同一轮可多张，都在
  // 1..5 内循环取号），其余不带。
  function shapeHistory() {
    const events = [];
    const assets = [];
    for (let image = 1; image <= 11; image += 1) {
      const id = `a${image}`;
      const turn = image <= 8 ? ((image - 1) % 5) + 1 : null;
      events.push(event(`e${image}`, id, { turn, created: iso(100 - image) }));
      assets.push(asset(id));
    }
    return historyOf(events, { assets, conversations: [conversationEntry(5)] });
  }

  it("collapsed shows the current asset and the next two (current is the earliest)", () => {
    const result = computeConversationRounds(shapeHistory(), "a1");
    assert.equal(result.mode, "context");
    assert.equal(result.turns, 5);
    assert.equal(result.images, 11);
    assert.deepEqual(result.rows.map((row) => row.event.output_asset_id), ["a1", "a2", "a3"], "the window extends downward from the first asset");
    assert.deepEqual(result.rows.map((row) => row.isCurrent), [true, false, false]);
    assert.deepEqual(
      result.rows.map((row) => roundLine(row, result, zhT)),
      ["共 5 轮 · 当前第 1 轮", "共 5 轮 · 第 2 轮", "共 5 轮 · 第 3 轮"],
    );
  });

  it("expanded lists all 11 images", () => {
    const rows = conversationRoundRows(shapeHistory(), "a1");
    assert.equal(rows.length, 11);
    assert.deepEqual(rows.map((row) => row.event.output_asset_id), Array.from({ length: 11 }, (_, index) => `a${index + 1}`));
    assert.equal(rows.filter((row) => row.turnIndex !== null).length, 8, "exactly the eight rows carrying a snapshot turn show one");
  });
});
