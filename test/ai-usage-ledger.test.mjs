// 任务 458：AI 花费台账与单价行的行为测试（真模块，目录在 os.tmpdir()）。
// 这张单没有任何花钱的调用，金额都是 $0.00；后面几张单调 recordAiUsage 记账。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { aiMonthTotalLine, aiPriceLine, aiFreePriceLine } from "../lib/ai/model-catalog.mjs";
import { aiUsageMonthKey, monthTotals, recordAiUsage } from "../desktop/ai/usage-ledger.mjs";

function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_match, name) => params?.[name] ?? "");
}

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("单价文字：文字模型（Haiku）、按张计价、OpenAI 出图、Ollama、未知模型五种", () => {
  const haiku = aiPriceLine("claude-haiku-5-5", 0);
  assert.equal(fill(haiku.template, haiku.params), "单价 输入 $0.10 · 输出 $0.50（每百万 token）· 本月 $0.00");

  const banana = aiPriceLine("gemini-nano-banana-2.1", 0);
  assert.equal(fill(banana.template, banana.params), "单价 约 $0.034 一张（1K）· 本月 $0.00");

  const openaiImage = aiPriceLine("gpt-image-2", 0);
  assert.equal(fill(openaiImage.template, openaiImage.params), "单价 图像输出 $30.00（每百万 token）· 本月 $0.00");

  const free = aiFreePriceLine();
  assert.equal(fill(free.template, free.params), "本机运行，不收费");

  const unknown = aiPriceLine("mystery-model", 0);
  assert.equal(fill(unknown.template, unknown.params), "单价未知 · 本月 $0.00");

  // 金额一律保留两位；按张计价保留到厘。
  const paid = aiPriceLine("claude-sonnet-5-5", 1.5);
  assert.equal(fill(paid.template, paid.params), "单价 输入 $2.00 · 输出 $10.00（每百万 token）· 本月 $1.50");
});

test("monthTotals 跨月清零：11 月记的 12 月看不到", async (t) => {
  const dir = await makeTempDir(t, "ai-usage-");
  await recordAiUsage(dir, { slot: "analysis", costUsd: 0.125, at: "2026-11-22T10:00:00" });
  await recordAiUsage(dir, { slot: "image", costUsd: 0.0336, at: "2026-11-28T10:00:00" });
  const november = await monthTotals(dir, new Date("2026-11-30T23:59:59"));
  assert.deepEqual(november, { analysis: 0.13, brain: 0, image: 0.03 });
  const december = await monthTotals(dir, new Date("2026-12-01T00:00:00"));
  assert.deepEqual(december, { analysis: 0, brain: 0, image: 0 }, "跨月清零");
});

test("recordAiUsage 只收三块和 ≥0 的有限金额，按本机日历月归档", async (t) => {
  const dir = await makeTempDir(t, "ai-usage-validate-");
  await assert.rejects(() => recordAiUsage(dir, { slot: "summary", costUsd: 1 }), TypeError);
  await assert.rejects(() => recordAiUsage(dir, { slot: "brain", costUsd: -1 }), TypeError);
  await assert.rejects(() => recordAiUsage(dir, { slot: "brain", costUsd: Number.NaN }), TypeError);
  await recordAiUsage(dir, { slot: "brain", costUsd: 0.1, at: "2026-11-22T23:30:00" });
  assert.equal(aiUsageMonthKey(new Date("2026-11-22T23:30:00")), "2026-11");
  const totals = await monthTotals(dir, new Date("2026-11-30T12:00:00"));
  assert.equal(totals.brain, 0.1);
});
