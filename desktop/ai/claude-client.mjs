// 任务 463：Claude 客户端（全仓唯一 import @anthropic-ai/sdk 的文件）。
//
// 密钥与花钱的调用只活在主进程（458 的边界）。三个必须显式传的参数：
// apiKey、authToken: null、baseURL —— 不传时 SDK 会去读
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY 环境变量和
// 本机登录档，测试里特意钉死「环境变量不串」。
//
// 自定义 fetch 包 outboundFetch（正式运行是 net.fetch：走系统代理、不带
// cookie），再强制 redirect: "error"、credentials: "omit"。所有返回值、日志
// 里只有分类和状态码 —— 错误的 message 可能带服务原文，一个字都不外传。

import Anthropic from "@anthropic-ai/sdk";
import {
  ANALYSIS_NOTE_JSON_SCHEMA,
  GUIDE_OUTPUT_JSON_SCHEMA,
} from "../../lib/ai/learning-schema.mjs";
import { tokenCostUsd } from "../../lib/ai/learning-cost.mjs";

export function createClaudeClient({ apiKey, baseURL, outboundFetch }) {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL,
    maxRetries: 2,
    fetch: (url, init) => outboundFetch(url, { ...init, redirect: "error", credentials: "omit" }),
  });
}

/** 错误按类判断（只用 instanceof 和 status），永不按错误文字判断。 */
export function classifyClaudeError(error) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return "auth";
  if (error instanceof Anthropic.RateLimitError) return "rate-limit";
  if (error instanceof Anthropic.InternalServerError) return "server";
  if (error instanceof Anthropic.APIConnectionError) return "network";
  if (error instanceof Anthropic.BadRequestError) return "rejected";
  if (error instanceof Anthropic.APIError) {
    const status = Number(error.status);
    if (status === 401 || status === 403) return "auth";
    if (status === 429) return "rate-limit";
    if (status >= 500) return "server";
    if (status === 400 || status === 413 || status === 422) return "rejected";
    return "unknown";
  }
  return "unknown";
}

// 只认 type === "text" 的块（Haiku/Sonnet 5.5 默认开着「想一想」，回答前面
// 可能有 thinking 块），拼起来 JSON.parse；按 type 找块，不按位置。
function parseStructuredOutput(message) {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** usage 四个字段，没有的当 0；喂 tokenCostUsd 算钱。 */
export function usageToCost(model, usage) {
  return tokenCostUsd(model, {
    inputTokens: Number(usage?.input_tokens || 0),
    outputTokens: Number(usage?.output_tokens || 0),
    cacheWriteTokens: Number(usage?.cache_creation_input_tokens || 0),
    cacheReadTokens: Number(usage?.cache_read_input_tokens || 0),
  });
}

// 汇总兜底模型 claude-sonnet-5 不在单价表里；Sonnet 5 与 Sonnet 5.5 同价，
// 兜底被实际用到时按 Sonnet 5.5 算（回报里写明）。
const FALLBACK_BILLING_MODEL = "claude-sonnet-5-5";

/**
 * 一次结构化补全。stop_reason refusal → refusal；解析失败或 max_tokens 截断
 * → 用 retryMaxTokens 重试一次，还不行 → bad-output。解析成功即算数（服务
 * 端 schema 已约束结构）。send 由调用方给（分析走 create，汇总走流式）。
 */
async function createStructuredMessage({ send, createParams, retryMaxTokens }) {
  let attemptParams = createParams;
  let retried = false;
  for (;;) {
    let message;
    try {
      message = await send(attemptParams);
    } catch (error) {
      return { ok: false, code: classifyClaudeError(error), error };
    }
    if (message.stop_reason === "refusal") return { ok: false, code: "refusal", message };
    const parsed = parseStructuredOutput(message);
    if (parsed) return { ok: true, note: parsed, message };
    if (!retried) {
      retried = true;
      attemptParams = { ...attemptParams, ...(retryMaxTokens ? { max_tokens: retryMaxTokens } : {}) };
      continue;
    }
    return { ok: false, code: "bad-output", message };
  }
}

/**
 * 逐张分析一张图。图片块放在文字块前面；元数据块包在
 * <asset_metadata>…</asset_metadata> 里。不传 thinking / temperature /
 * top_p / top_k（Haiku 5.5 与 Sonnet 5.5 都会 400）；想多少用 effort 控制。
 */
export async function analyzeImage(client, { model, image, metadata, signal, systemPrompt }) {
  const params = {
    model,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        { type: "text", text: `<asset_metadata>\n${JSON.stringify(metadata)}\n</asset_metadata>` },
      ],
    }],
    output_config: { format: { type: "json_schema", schema: ANALYSIS_NOTE_JSON_SCHEMA }, effort: "low" },
  };
  // 分析走 messages.create（60s 超时）；解析失败用 max_tokens 8000 重试一次。
  const result = await createStructuredMessage({
    send: (attemptParams) => client.messages.create(attemptParams, { timeout: 60_000, signal }),
    createParams: params,
    retryMaxTokens: 8000,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, costUsd: 0, usage: null, model };
  }
  const message = result.message;
  const costUsd = usageToCost(message.model || model, message.usage);
  return {
    ok: true,
    note: result.note,
    usage: message.usage,
    costUsd: costUsd === null ? 0 : costUsd,
    costKnown: costUsd !== null,
    model: message.model || model,
  };
}

/**
 * 一次汇总（或合并）。走 beta 接口：服务端兜底 beta
 * server-side-fallback-2026-07-01 + fallbacks: [{ model: "claude-sonnet-5" }]
 * （被拒时同一次请求里换 Sonnet 5 重跑，同价）。SDK 1.12.0 的
 * BetaMessageCreateParams 里 betas / fallbacks 两个参数都有（.d.ts 7458/7272
 * 行，BetaFallbacksParam = Array<BetaFallbackParam> | 'default'），不需要退
 * 路。合并那次用同一个函数，systemPrompt 换成合并提示。
 */
export async function summarizeGuide(client, { model, userContent, signal, systemPrompt }) {
  const params = {
    model,
    max_tokens: 32000,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: { type: "json_schema", schema: GUIDE_OUTPUT_JSON_SCHEMA }, effort: "medium" },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: [{ model: "claude-sonnet-5" }],
  };
  // 输出长的请求走流式（finalMessage），免得 HTTP 超时；解析失败重试一次。
  const result = await createStructuredMessage({
    send: (attemptParams) => client.beta.messages.stream(attemptParams, { timeout: 600_000, signal }).finalMessage(),
    createParams: params,
  });
  if (!result.ok) {
    // 汇总的解析失败按 summary-error 交回（refusal / 错误分类原样）。
    const code = result.code === "bad-output" ? "summary-error" : result.code;
    return { ok: false, code, usage: null };
  }
  const message = result.message;
  const parsed = result.note;
  // 汇总走了兜底（usage.iterations 里有 fallback_message 条目）时按实际模型
  // 计费模型算钱。
  let billedModel = message.model || model;
  const iterations = Array.isArray(message.usage?.iterations) ? message.usage.iterations : [];
  const fallbackEntry = iterations.find((entry) => entry?.type === "fallback_message" && entry.model);
  if (fallbackEntry) billedModel = fallbackEntry.model;
  const costKnown = usageToCost(billedModel, { inputTokens: 0, outputTokens: 0 });
  const costModel = costKnown === null ? FALLBACK_BILLING_MODEL : billedModel;
  const costUsd = usageToCost(costModel, message.usage);
  return {
    ok: true,
    guide: parsed,
    usage: message.usage,
    costUsd: costUsd === null ? 0 : costUsd,
    costKnown: costUsd !== null,
    billedModel,
    costModel,
    fallbackUsed: Boolean(fallbackEntry),
  };
}
