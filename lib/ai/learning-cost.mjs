// 任务 463：学习后台的估算（B 节）。单价只从 lib/ai/model-catalog.mjs 取，
// 不另写一份。所有估算参数集中在这几个常量上 —— 第 8 张单按真账单校准。

import { aiModelById } from "./model-catalog.mjs";

// 估算参数（第 8 张单按真账单校准）：送出去的是长边 960 的中图。
export const ANALYSIS_IMAGE_LONG_EDGE = 960;
// 估算参数（第 8 张单按真账单校准）：系统提示 + schema + 元数据的平均输入。
export const ANALYSIS_FIXED_INPUT_TOKENS = 1100;
// 第 476 单初值，待真账单校准：逐张分析按推理强度的输出估算（含 thinking 块）。
export const ANALYSIS_OUTPUT_TOKENS_BY_EFFORT = Object.freeze({
  low: 800,
  medium: 1600,
  high: 3200,
  xhigh: 4800,
  max: 6400,
});
// 估算参数（第 8 张单按真账单校准）：分析输出（含「想一想」的 thinking 块）。
export const ANALYSIS_OUTPUT_TOKENS = ANALYSIS_OUTPUT_TOKENS_BY_EFFORT.low;
// 估算参数（第 8 张单按真账单校准）：每条笔记压进汇总输入的长度。
export const SUMMARY_NOTE_TOKENS = 240;
// 估算参数（第 8 张单按真账单校准）：汇总请求的系统提示 + schema + 指令。
export const SUMMARY_FIXED_INPUT_TOKENS = 3000;
// 第 476 单初值，待真账单校准：汇总手册按推理强度的输出估算（含 thinking 块）。
export const SUMMARY_OUTPUT_TOKENS_BY_EFFORT = Object.freeze({
  low: 5000,
  medium: 6000,
  high: 9000,
  xhigh: 12000,
  max: 15000,
});
// 估算参数（第 8 张单按真账单校准）：汇总输出（整本手册的 JSON）。
export const SUMMARY_OUTPUT_TOKENS = SUMMARY_OUTPUT_TOKENS_BY_EFFORT.medium;
// 估算参数（第 8 张单按真账单校准）：笔记超过这个条数就分批汇总再合并。
export const SUMMARY_CHUNK_SIZE = 300;
// 估算参数（第 8 张单按真账单校准）：合并那次每个批次的局部手册占的输入。
export const SUMMARY_MERGE_PER_BATCH_TOKENS = 2500;

/**
 * 一张图按面积折算的输入 token：先按长边 960 等比缩（不放大；尺寸未知按
 * 960×960），再按 ~28×28 像素一块向上取整。960×960 → 1176。
 */
export function imageTokens(width, height) {
  const w = Number(width);
  const h = Number(height);
  const known = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
  const scale = known ? Math.min(1, ANALYSIS_IMAGE_LONG_EDGE / Math.max(w, h)) : 1;
  const scaledW = known ? Math.max(1, Math.floor(w * scale)) : ANALYSIS_IMAGE_LONG_EDGE;
  const scaledH = known ? Math.max(1, Math.floor(h * scale)) : ANALYSIS_IMAGE_LONG_EDGE;
  return Math.ceil((scaledW * scaledH) / 784);
}

/** 单价上限：单次输入超过 tier.thresholdTokens 换 tier 的单价。 */
function priceTier(pricing, inputTokens) {
  const tier = pricing?.tier;
  if (tier && Number.isFinite(tier.thresholdTokens) && inputTokens > tier.thresholdTokens) {
    return { input: tier.input, output: tier.output };
  }
  return { input: pricing.input, output: pricing.output };
}

/**
 * 一次调用按 token 计价的美元数。缓存写 ×1.25、缓存读 ×0.1（都按输入单价）。
 * 表里没有这个模型或不是按 token 计价的模型 → null（报价时当「无法估价」拦下）。
 */
export function tokenCostUsd(model, { inputTokens = 0, outputTokens = 0, cacheWriteTokens = 0, cacheReadTokens = 0 } = {}) {
  const entry = aiModelById(model);
  if (!entry || entry.pricing?.kind !== "tokens") return null;
  const price = priceTier(entry.pricing, inputTokens);
  const cost = (
    inputTokens * price.input
    + cacheWriteTokens * price.input * 1.25
    + cacheReadTokens * price.input * 0.1
    + outputTokens * price.output
  ) / 1_000_000;
  return Number.isFinite(cost) ? cost : null;
}

function ceilToCent(value) {
  return Math.ceil(value * 100) / 100;
}

/**
 * 开始学习前的报价。任一模型没有单价 → null。
 * newImages: [{ width, height }]（这次要分析的新图；尺寸未知传 null）。
 * existingNoteCount: 库里已有的合格笔记数；新图分析完也会变成笔记。
 * summarize=false 表示这次只分析不汇总。
 */
export function estimateLearningCost({
  analysisModel,
  summaryModel,
  analysisEffort = "low",
  summaryEffort = "medium",
  newImages = [],
  existingNoteCount = 0,
  summarize = true,
}) {
  const analysisOutputTokens = ANALYSIS_OUTPUT_TOKENS_BY_EFFORT[analysisEffort] ?? ANALYSIS_OUTPUT_TOKENS;
  const summaryOutputTokens = SUMMARY_OUTPUT_TOKENS_BY_EFFORT[summaryEffort] ?? SUMMARY_OUTPUT_TOKENS;
  const images = Array.isArray(newImages) ? newImages : [];
  let analysisUsd = 0;
  for (const image of images) {
    const inputTokens = imageTokens(image?.width, image?.height) + ANALYSIS_FIXED_INPUT_TOKENS;
    const cost = tokenCostUsd(analysisModel, { inputTokens, outputTokens: analysisOutputTokens });
    if (cost === null) return null;
    analysisUsd += cost;
  }
  let summaryUsd = 0;
  let summaryCalls = 0;
  if (summarize) {
    const noteCount = Number(existingNoteCount) + images.length;
    if (noteCount > 0) {
      const batches = Math.ceil(noteCount / SUMMARY_CHUNK_SIZE);
      summaryCalls = batches === 1 ? 1 : batches + 1;
      // 分批：每批最多 SUMMARY_CHUNK_SIZE 条笔记。
      let remaining = noteCount;
      for (let batch = 0; batch < batches; batch += 1) {
        const batchNotes = Math.min(SUMMARY_CHUNK_SIZE, remaining);
        remaining -= batchNotes;
        const cost = tokenCostUsd(summaryModel, {
          inputTokens: batchNotes * SUMMARY_NOTE_TOKENS + SUMMARY_FIXED_INPUT_TOKENS,
          outputTokens: summaryOutputTokens,
        });
        if (cost === null) return null;
        summaryUsd += cost;
      }
      // 合并那次：输入是各批的局部手册，按每批 2500 token 估。
      if (batches > 1) {
        const mergeCost = tokenCostUsd(summaryModel, {
          inputTokens: SUMMARY_FIXED_INPUT_TOKENS + batches * SUMMARY_MERGE_PER_BATCH_TOKENS,
          outputTokens: summaryOutputTokens,
        });
        if (mergeCost === null) return null;
        summaryUsd += mergeCost;
      }
    }
  }
  const estimateUsd = analysisUsd + summaryUsd;
  return {
    analysisUsd,
    summaryUsd,
    summaryCalls,
    estimateUsd,
    // 上限 = 报价 × 1.5 + $0.05，进到分；实际花费碰到上限自动暂停。
    capUsd: ceilToCent(estimateUsd * 1.5 + 0.05),
  };
}

/**
 * 这一步按档位估的输出 token ÷ 默认档输出 token，四舍五入到 0.5（界面花费提示用）。
 */
export function effortCostMultiple(role, effort) {
  const isSummary = role === "summary";
  const table = isSummary ? SUMMARY_OUTPUT_TOKENS_BY_EFFORT : ANALYSIS_OUTPUT_TOKENS_BY_EFFORT;
  const defaultTokens = isSummary ? SUMMARY_OUTPUT_TOKENS : ANALYSIS_OUTPUT_TOKENS;
  const tokens = table[effort] ?? defaultTokens;
  return Math.round((tokens / defaultTokens) * 2) / 2;
}
