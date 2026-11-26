// 任务 463：估价纯函数的行为测试（真模块，期望值全部手算写死，不许用被测
// 函数算期望）。核对单子 B.2 的 200 张例子和四、测试 10 的每一条。
import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYSIS_FIXED_INPUT_TOKENS,
  ANALYSIS_IMAGE_LONG_EDGE,
  ANALYSIS_OUTPUT_TOKENS,
  SUMMARY_CHUNK_SIZE,
  estimateLearningCost,
  imageTokens,
  tokenCostUsd,
} from "../lib/ai/learning-cost.mjs";

test("imageTokens：960×960 → 1176；1920×1080 缩到 960×540 → 662；尺寸未知按 960×960；不放大", () => {
  assert.equal(imageTokens(960, 960), 1176); // 921600 / 784 = 1175.51 → ceil 1176
  assert.equal(imageTokens(1920, 1080), 662); // 960×540 → 518400 / 784 = 661.2 → ceil 662
  assert.equal(imageTokens(null, null), 1176);
  assert.equal(imageTokens(undefined, undefined), 1176);
  assert.equal(imageTokens(480, 480), Math.ceil(230400 / 784)); // 294，不放大（本来就小于 960）
  assert.equal(imageTokens(3840, 2160), 662); // 长边 3840 缩到 960 → 960×540 同 1920×1080
  assert.equal(imageTokens(2000, 1000), Math.ceil((960 * 480) / 784)); // 588
});

test("tokenCostUsd：单价只从 model-catalog 取；缓存写 ×1.25、读 ×0.1；单次输入超 10 万用高档；不在表里或非 token 计价 → null", () => {
  // Haiku $0.10/$0.50 每百万：(1000 × 0.10 + 100 × 0.50) / 1e6 = 0.00015
  assert.ok(Math.abs(tokenCostUsd("claude-haiku-5-5", { inputTokens: 1000, outputTokens: 100 }) - 0.00015) < 1e-15);
  // 缓存写 ×1.25、读 ×0.1（都按输入单价）：
  // (1000 × 0.10 + 200 × 0.10 × 1.25 + 400 × 0.10 × 0.1 + 100 × 0.50) / 1e6 = 0.000179
  assert.ok(Math.abs(tokenCostUsd("claude-haiku-5-5", { inputTokens: 1000, outputTokens: 100, cacheWriteTokens: 200, cacheReadTokens: 400 }) - 0.000179) < 1e-15);
  // Haiku 高档：单次输入 100001 > 100000 → $0.50/$2.50：
  // (100001 × 0.5 + 0) / 1e6 = 0.0500005
  assert.equal(tokenCostUsd("claude-haiku-5-5", { inputTokens: 100_001, outputTokens: 0 }), 0.0500005);
  // 恰好在阈值上不换档：(100000 × 0.1) / 1e6 = 0.01
  assert.equal(tokenCostUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 0 }), 0.01);
  // Sonnet 5.5 $2/$10：(2000 × 2 + 100 × 10) / 1e6 = 0.005
  assert.equal(tokenCostUsd("claude-sonnet-5-5", { inputTokens: 2000, outputTokens: 100 }), 0.005);
  // 出图模型（按张计价）→ null；不在表里 → null。
  assert.equal(tokenCostUsd("gpt-image-2", { inputTokens: 10, outputTokens: 10 }), null);
  assert.equal(tokenCostUsd("gemini-nano-banana-2.1", { inputTokens: 10, outputTokens: 10 }), null);
  assert.equal(tokenCostUsd("mystery-model", { inputTokens: 10, outputTokens: 10 }), null);
});

test("B.2 的 200 张例子：分析每张 $0.0006276，200 张 $0.12552；汇总 1 次 $0.162；合计 $0.28752；上限进到分 $0.49", () => {
  // 手算：每张输入 1176 + 1100 = 2276、输出 800。
  //   Haiku 每张 (2276 × 0.10 + 800 × 0.50) / 1e6 = 0.0006276，200 张 = 0.12552。
  //   汇总输入 200 × 240 + 3000 = 51000、输出 6000：
  //   Sonnet (51000 × 2 + 6000 × 10) / 1e6 = 0.162。
  //   合计 0.28752；cap = ceil(0.28752 × 1.5 + 0.05)到分 = 0.49。
  const quote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    newImages: Array.from({ length: 200 }, () => ({ width: 960, height: 960 })),
    existingNoteCount: 0,
    summarize: true,
  });
  assert.ok(Math.abs(quote.analysisUsd - 0.12552) < 1e-12);
  assert.ok(Math.abs(quote.summaryUsd - 0.162) < 1e-12);
  assert.equal(quote.summaryCalls, 1);
  assert.ok(Math.abs(quote.estimateUsd - 0.28752) < 1e-12);
  assert.equal(quote.capUsd, 0.49);
});

test("301 条笔记分 2 批、调用 3 次（2 批 + 1 次合并，合并输入另加 批数×2500）", () => {
  // 批次输入：300 × 240 + 3000 = 75000；1 × 240 + 3000 = 3240。
  //   Sonnet (75000×2 + 6000×10)/1e6 = 0.21；(3240×2 + 6000×10)/1e6 = 0.06648。
  //   合并输入 3000 + 2×2500 = 8000：(8000×2 + 6000×10)/1e6 = 0.076。
  //   合计 0.21 + 0.06648 + 0.076 = 0.35248。
  const quote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    newImages: [],
    existingNoteCount: 301,
    summarize: true,
  });
  assert.equal(quote.summaryCalls, 3);
  assert.ok(Math.abs(quote.summaryUsd - 0.35248) < 1e-12);
  assert.ok(Math.abs(quote.estimateUsd - 0.35248) < 1e-12);
  assert.equal(quote.capUsd, Math.ceil(0.35248 * 1.5 * 100 + 0.05 * 100) / 100); // ceil 到分 = 0.58
  assert.equal(quote.analysisUsd, 0);
});

test("任一模型没有单价 → 整个报价 null；summarize=false 只算分析；300 条整不拆批", () => {
  assert.equal(estimateLearningCost({
    analysisModel: "mystery-model", summaryModel: "claude-sonnet-5-5",
    newImages: [{ width: 960, height: 960 }], existingNoteCount: 0, summarize: true,
  }), null);
  assert.equal(estimateLearningCost({
    analysisModel: "claude-haiku-5-5", summaryModel: "mystery-model",
    newImages: [{ width: 960, height: 960 }], existingNoteCount: 0, summarize: true,
  }), null);
  const noSummary = estimateLearningCost({
    analysisModel: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5",
    newImages: [{ width: 960, height: 960 }], existingNoteCount: 5, summarize: false,
  });
  assert.equal(noSummary.summaryUsd, 0);
  assert.equal(noSummary.summaryCalls, 0);
  assert.ok(Math.abs(noSummary.estimateUsd - 0.0006276) < 1e-12);
  const exactChunk = estimateLearningCost({
    analysisModel: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5",
    newImages: [], existingNoteCount: SUMMARY_CHUNK_SIZE, summarize: true,
  });
  assert.equal(exactChunk.summaryCalls, 1, "300 条整恰好一批，不拆");
  assert.ok(Math.abs(exactChunk.summaryUsd - ((300 * 240 + 3000) * 2 + 6000 * 10) / 1e6) < 1e-12);
});

test("估算参数常量与单子一致（宽高、固定输入/输出、分批大小）", () => {
  assert.equal(ANALYSIS_IMAGE_LONG_EDGE, 960);
  assert.equal(ANALYSIS_FIXED_INPUT_TOKENS, 1100);
  assert.equal(ANALYSIS_OUTPUT_TOKENS, 800);
  assert.equal(SUMMARY_CHUNK_SIZE, 300);
});
