// Learning-guide UI pure functions (task 464): section ordering & grouping,
// USD formatting, bottom action state machine, pause reason strings, log row
// templates, gallery filter params, default add section, revertible run, and
// local log date formatting. The real TypeScript module
// (web/gravityport/src/learning-guide-model.ts) is compiled with tsc and
// imported directly — nothing is hand-copied.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let GUIDE_SECTIONS;
let groupGuideEntries;
let defaultAddSection;
let formatLearningUsd;
let learningActionState;
let pauseReasonText;
let learningLogRowText;
let findRevertibleRunId;
let learningFilterParams;
let formatLearningLogDate;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-learning-guide-ui-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "learning-guide-model.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  const mod = await import(join(compileRoot, "learning-guide-model.js"));
  ({
    GUIDE_SECTIONS,
    groupGuideEntries,
    defaultAddSection,
    formatLearningUsd,
    learningActionState,
    pauseReasonText,
    learningLogRowText,
    findRevertibleRunId,
    learningFilterParams,
    formatLearningLogDate,
  } = mod);
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

const makeEntry = (overrides) => ({
  id: "lge_1",
  section: "palette",
  position: 0,
  text: "冷蓝配冰白",
  swatches: [],
  origin: "ai",
  locked: false,
  sources: ["a1"],
  sourceCount: 1,
  updatedAt: "2026-11-23T00:00:00.000Z",
  ...overrides,
});

const makeRun = (overrides = {}) => ({
  id: "lr_1",
  kind: "learn",
  status: "running",
  phase: "analyze",
  itemCount: 10,
  doneCount: 4,
  failedCount: 0,
  skippedCount: 0,
  costUsd: 0.02,
  estimateUsd: 0.05,
  capUsd: 0.13,
  pauseReason: "",
  ...overrides,
});

describe("GUIDE_SECTIONS & groupGuideEntries", () => {
  it("defines the 9 sections in exact order", () => {
    assert.deepEqual(GUIDE_SECTIONS.map((s) => s.id), [
      "positioning",
      "palette",
      "composition",
      "lighting",
      "material",
      "subject",
      "mood",
      "prompting",
      "avoid",
    ]);
    assert.deepEqual(GUIDE_SECTIONS.map((s) => s.label), [
      "一句话定位",
      "配色",
      "构图和镜头",
      "光线",
      "材质和质感",
      "人物和造型",
      "情绪",
      "提示词写法",
      "避免",
    ]);
  });

  it("orders groups by GUIDE_SECTIONS, sorts within each group by position, and omits empty groups", () => {
    const grouped = groupGuideEntries([
      makeEntry({ id: "e_avoid", section: "avoid", position: 0 }),
      makeEntry({ id: "e_pal_2", section: "palette", position: 2 }),
      makeEntry({ id: "e_pos", section: "positioning", position: 0 }),
      makeEntry({ id: "e_pal_0", section: "palette", position: 0 }),
      makeEntry({ id: "e_light", section: "lighting", position: 1 }),
      makeEntry({ id: "e_unknown", section: "nonexistent", position: 0 }),
    ]);
    assert.deepEqual(grouped.map((g) => g.section), ["positioning", "palette", "lighting", "avoid"]);
    assert.deepEqual(grouped[1].entries.map((e) => e.id), ["e_pal_0", "e_pal_2"]);
    assert.equal(grouped.some((g) => g.section === "composition"), false, "empty groups omitted");
    assert.equal(grouped.some((g) => g.section === "nonexistent"), false, "unknown sections ignored");
  });

  it("picks the first empty non-palette section for defaultAddSection and falls back to composition", () => {
    assert.equal(defaultAddSection([makeEntry({ section: "positioning" })]), "composition");
    assert.equal(
      defaultAddSection([makeEntry({ section: "positioning" }), makeEntry({ section: "composition" })]),
      "lighting",
    );
    const allUsed = GUIDE_SECTIONS.map((s, i) => makeEntry({ id: `e_${i}`, section: s.id }));
    assert.equal(defaultAddSection(allUsed), "composition");
  });
});

describe("formatLearningUsd", () => {
  it("formats values below $0.01 as 不到 $0.01 and >= $0.01 with two decimals", () => {
    assert.equal(formatLearningUsd(0), "不到 $0.01");
    assert.equal(formatLearningUsd(0.004), "不到 $0.01");
    assert.equal(formatLearningUsd(0.0099), "不到 $0.01");
    assert.equal(formatLearningUsd(0.01), "$0.01");
    assert.equal(formatLearningUsd(0.074), "$0.07");
    assert.equal(formatLearningUsd(1.5), "$1.50");
  });

  it("supports custom translator for 不到 $0.01", () => {
    const tr = (text) => (text === "不到 $0.01" ? "under $0.01" : text);
    assert.equal(formatLearningUsd(0.004, tr), "under $0.01");
    assert.equal(formatLearningUsd(0.074, tr), "$0.07");
  });
});

describe("learningActionState (every row in B.3)", () => {
  it("1. web-only when not desktop", () => {
    const state = learningActionState({ desktop: false, quote: null, status: null, quoting: false });
    assert.deepEqual(state, { kind: "web-only" });
  });

  it("2. quoting when estimating", () => {
    const state = learningActionState({ desktop: true, quote: null, status: null, quoting: true });
    assert.deepEqual(state, { kind: "quoting" });
  });

  it("3. ready-first (learn, analyzedCount === 0)", () => {
    const state = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: null, busyElsewhere: null },
      quote: { ok: true, kind: "learn", counts: { newCount: 48, analyzedCount: 0, totalCount: 48, noPreview: 0 }, estimateUsd: 0.074 },
    });
    assert.deepEqual(state, { kind: "ready-first", count: 48, estimateUsd: 0.074, noPreview: 0 });
  });

  it("4. ready-new (learn, analyzedCount > 0) with noPreview > 0", () => {
    const state = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: null, busyElsewhere: null },
      quote: { ok: true, kind: "learn", counts: { newCount: 12, analyzedCount: 48, totalCount: 62, noPreview: 2 }, estimateUsd: 0.02 },
    });
    assert.deepEqual(state, { kind: "ready-new", count: 12, estimateUsd: 0.02, noPreview: 2 });
  });

  it("5. ready-summary (summary-only)", () => {
    const state = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: null, busyElsewhere: null },
      quote: { ok: true, kind: "summary-only", counts: { newCount: 0, analyzedCount: 48, totalCount: 48, noPreview: 1 }, estimateUsd: 0.03 },
    });
    assert.deepEqual(state, { kind: "ready-summary", estimateUsd: 0.03, noPreview: 1 });
  });

  it("6. analyzing (running + analyze) computes progress from done + failed + skipped", () => {
    const run = makeRun({ status: "running", phase: "analyze", itemCount: 10, doneCount: 3, failedCount: 1, skippedCount: 1 });
    const state = learningActionState({ desktop: true, quoting: false, quote: null, status: { run } });
    assert.equal(state.kind, "analyzing");
    assert.equal(state.progress, 0.5);
  });

  it("7. summarizing (running + summarize)", () => {
    const run = makeRun({ status: "running", phase: "summarize" });
    const state = learningActionState({ desktop: true, quoting: false, quote: null, status: { run } });
    assert.equal(state.kind, "summarizing");
  });

  it("8. pausing", () => {
    const run = makeRun({ status: "pausing", phase: "analyze" });
    const state = learningActionState({ desktop: true, quoting: false, quote: null, status: { run } });
    assert.equal(state.kind, "pausing");
  });

  it("9. paused (user vs auth/no-key with resume quote)", () => {
    const userPaused = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: makeRun({ status: "paused", pauseReason: "user" }) },
      quote: { ok: true, kind: "resume", estimateUsd: 0.05 },
    });
    assert.equal(userPaused.kind, "paused");
    assert.equal(userPaused.reasonText, "已暂停");
    assert.equal(userPaused.showAiSettings, false);
    assert.equal(userPaused.canResume, true);
    assert.equal(userPaused.resumeEstimateUsd, 0.05);

    const authPaused = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: makeRun({ status: "paused", pauseReason: "auth" }) },
      quote: { ok: true, kind: "resume", estimateUsd: 0.03 },
    });
    assert.equal(authPaused.kind, "paused");
    assert.equal(authPaused.reasonText, "Claude 拒绝了密钥，请到 AI 设置检查");
    assert.equal(authPaused.showAiSettings, true);

    const noKeyPaused = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: makeRun({ status: "paused", pauseReason: "no-key" }) },
      quote: { ok: false, blocked: "no-key" },
    });
    assert.equal(noKeyPaused.kind, "paused");
    assert.equal(noKeyPaused.showAiSettings, true);
    assert.equal(noKeyPaused.canResume, false);
    assert.deepEqual(noKeyPaused.resumeBlocked, { kind: "blocked", blocked: "no-key", showAiSettings: true, serviceLabel: "" });
    assert.equal(userPaused.resumeBlocked, null);
  });

  it("9b. paused but cannot resume: says why (another library running, resume quote blocked)", () => {
    const busyPaused = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: makeRun({ status: "paused", pauseReason: "user" }), busyElsewhere: { libraryId: "ll_other", libraryName: "人像库" } },
      quote: null,
    });
    assert.equal(busyPaused.kind, "paused");
    assert.equal(busyPaused.canResume, false);
    assert.deepEqual(busyPaused.resumeBlocked, { kind: "blocked", blocked: "busy", showAiSettings: false, libraryName: "人像库" });

    const priceBlocked = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: makeRun({ status: "paused", pauseReason: "user" }), busyElsewhere: null },
      quote: { ok: false, blocked: "unknown-price", modelLabel: "custom-model" },
    });
    assert.deepEqual(priceBlocked.resumeBlocked, { kind: "blocked", blocked: "unknown-price", showAiSettings: true, modelLabel: "custom-model" });
  });

  it("10–16. all 7 blocked states", () => {
    const cases = [
      { quote: { ok: false, blocked: "encryption-unavailable" }, expected: { kind: "blocked", blocked: "encryption-unavailable", showAiSettings: false } },
      { quote: { ok: false, blocked: "no-service" }, expected: { kind: "blocked", blocked: "no-service", showAiSettings: true } },
      { quote: { ok: false, blocked: "unsupported-service" }, expected: { kind: "blocked", blocked: "unsupported-service", showAiSettings: true } },
      { quote: { ok: false, blocked: "no-key", serviceLabel: "Claude" }, expected: { kind: "blocked", blocked: "no-key", showAiSettings: true, serviceLabel: "Claude" } },
      { quote: { ok: false, blocked: "unknown-price", modelLabel: "custom-model" }, expected: { kind: "blocked", blocked: "unknown-price", showAiSettings: true, modelLabel: "custom-model" } },
      { quote: { ok: false, blocked: "busy", libraryName: "海报风格" }, expected: { kind: "blocked", blocked: "busy", showAiSettings: false, libraryName: "海报风格" } },
      { quote: { ok: false, blocked: "empty" }, expected: { kind: "blocked", blocked: "empty", showAiSettings: false } },
    ];
    for (const { quote, expected } of cases) {
      const actual = learningActionState({ desktop: true, quoting: false, status: { run: null, busyElsewhere: null }, quote });
      assert.deepEqual(actual, expected, `blocked=${quote.blocked}`);
    }
    const busyFromStatus = learningActionState({
      desktop: true,
      quoting: false,
      status: { run: null, busyElsewhere: { libraryId: "ll_other", libraryName: "人像库" } },
      quote: null,
    });
    assert.deepEqual(busyFromStatus, { kind: "blocked", blocked: "busy", showAiSettings: false, libraryName: "人像库" });
  });
});

describe("pauseReasonText", () => {
  it("maps all 11 pause reasons to distinct non-empty labels", () => {
    const expected = {
      user: "已暂停",
      interrupted: "上次学习被中断了",
      auth: "Claude 拒绝了密钥，请到 AI 设置检查",
      "no-key": "Claude 的密钥被删除了",
      "rate-limit": "请求太多或额度已用完，稍后再继续",
      network: "连不上 Claude，检查网络或代理",
      server: "Claude 暂时出错，稍后再继续",
      unknown: "出了点问题，已暂停",
      "over-budget": "花费快超出报价，已暂停",
      "library-unavailable": "素材库暂时不可用",
      "summary-error": "整理手册时出错，可以再试一次",
    };
    assert.equal(Object.keys(expected).length, 11);
    for (const [reason, text] of Object.entries(expected)) {
      assert.equal(pauseReasonText(reason), text, `reason=${reason}`);
    }
    assert.equal(pauseReasonText("something-unexpected"), "出了点问题，已暂停");
  });
});

describe("learningLogRowText & findRevertibleRunId", () => {
  it("formats first learn, re-learn with locked entries, summary-only, partial failures, reverted, discarded, nothing-learned, and manual edits", () => {
    assert.deepEqual(
      learningLogRowText(makeRun({ status: "done", itemCount: 16, doneCount: 16, costUsd: 0.04, change: { added: 6, replaced: 0, keptLocked: 0 } })),
      { template: "学了 {done} 张 · 新增 {added} 条 · 花费 {cost}", params: { done: 16, added: 6, cost: "$0.04" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "done", itemCount: 20, doneCount: 20, costUsd: 0.06, change: { added: 5, replaced: 4, keptLocked: 2 } })),
      { template: "学了 {done} 张 · 更新 {added} 条 · 保留 {locked} 条锁定 · 花费 {cost}", params: { done: 20, added: 5, locked: 2, cost: "$0.06" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "done", itemCount: 0, doneCount: 0, costUsd: 0.03, change: { added: 4, replaced: 4, keptLocked: 1 } })),
      { template: "重新整理手册 · 更新 {added} 条 · 保留 {locked} 条锁定 · 花费 {cost}", params: { added: 4, locked: 1, cost: "$0.03" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "done", itemCount: 10, doneCount: 8, failedCount: 2, costUsd: 0.03, change: { added: 4, replaced: 0, keptLocked: 0 } })),
      { template: "学了 {done} 张（{failed} 张未成功）· 更新 {added} 条 · 花费 {cost}", params: { done: 8, failed: 2, added: 4, cost: "$0.03" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "done", itemCount: 10, doneCount: 10, costUsd: 0.05, change: { added: 5, reverted: true } })),
      { template: "学了 {done} 张 · 已撤回 · 花费 {cost}", params: { done: 10, cost: "$0.05" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "canceled", itemCount: 6, doneCount: 4, costUsd: 0.01 })),
      { template: "已放弃 · 学了 {done} 张 · 花费 {cost}", params: { done: 4, cost: "$0.01" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ status: "failed", pauseReason: "nothing-learned", itemCount: 3, doneCount: 0, failedCount: 3, costUsd: 0.002 })),
      { template: "这次没有学到内容 · 花费 {cost}", params: { cost: "不到 $0.01" } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ kind: "edit", status: "done", itemCount: 0, doneCount: 0, costUsd: 0, change: { edited: 1 } })),
      { template: "手动修改 {n} 条", params: { n: 1 } },
    );

    assert.deepEqual(
      learningLogRowText(makeRun({ kind: "edit", status: "done", itemCount: 0, doneCount: 0, costUsd: 0, change: { added: 1, edited: 2, locked: 1 } })),
      { template: "手动调整手册（{n} 处）", params: { n: 4 } },
    );
  });

  it("identifies only the latest finished non-reverted learn run as revertible", () => {
    const runs = [
      makeRun({ id: "lr_edit", kind: "edit", status: "done" }),
      makeRun({ id: "lr_done_new", kind: "learn", status: "done", change: { added: 3 } }),
      makeRun({ id: "lr_done_old", kind: "learn", status: "done", change: { added: 2 } }),
    ];
    assert.equal(findRevertibleRunId(runs), "lr_done_new");
    const afterRevert = [
      makeRun({ id: "lr_done_new", kind: "learn", status: "done", change: { added: 3, reverted: true } }),
      makeRun({ id: "lr_done_old", kind: "learn", status: "done", change: { added: 2 } }),
    ];
    assert.equal(findRevertibleRunId(afterRevert), null);
  });

  it("hides revert once the guide moved past the run's revision (the backend would 409 LEARNING_GUIDE_CHANGED)", () => {
    const runs = [
      makeRun({ id: "lr_edit", kind: "edit", status: "done", guideRevisionAfter: 6 }),
      makeRun({ id: "lr_done", kind: "learn", status: "done", guideRevisionAfter: 5, change: { added: 3 } }),
    ];
    assert.equal(findRevertibleRunId(runs, 6), null);
    assert.equal(findRevertibleRunId(runs.slice(1), 5), "lr_done");
    assert.equal(findRevertibleRunId(runs.slice(1)), "lr_done");
  });
});

describe("learningFilterParams", () => {
  it("returns empty, learningEntry, or learningRun for the three cases", () => {
    assert.deepEqual(learningFilterParams(null), {});
    assert.deepEqual(learningFilterParams(undefined), {});
    assert.deepEqual(
      learningFilterParams({ kind: "entry", id: "lge_abc", label: "配色", count: 4 }),
      { learningEntry: "lge_abc" },
    );
    assert.deepEqual(
      learningFilterParams({ kind: "run", id: "lr_xyz", label: "11 月 18 日", count: 12 }),
      { learningRun: "lr_xyz" },
    );
  });
});

describe("formatLearningLogDate", () => {
  it("formats same-year and cross-year local dates in Chinese and English", () => {
    const now = new Date(2026, 10, 23, 12, 0, 0);
    const sameYear = new Date(2026, 10, 18, 9, 30, 0).toISOString();
    const prevYear = new Date(2025, 11, 5, 9, 30, 0).toISOString();
    assert.equal(formatLearningLogDate(sameYear, "zh", now), "11 月 18 日");
    assert.equal(formatLearningLogDate(sameYear, "en", now), "Nov 18");
    assert.equal(formatLearningLogDate(prevYear, "zh", now), "2025 年 12 月 5 日");
    assert.equal(formatLearningLogDate(prevYear, "en", now), "Dec 5, 2025");
  });
});
