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
import { AI_EFFORT_LEVELS, AI_LEARNING_DEFAULT_EFFORT } from "../../lib/ai/model-catalog.mjs";

const VALID_EFFORTS = new Set(AI_EFFORT_LEVELS);
const SUMMARY_HIGH_EFFORTS = new Set(["high", "xhigh", "max"]);
const ANALYZE_LIMITS_BY_EFFORT = {
  low: { maxTokens: 4000, retryMaxTokens: 8000, timeoutMs: 60_000, stream: false },
  medium: { maxTokens: 8000, retryMaxTokens: 16000, timeoutMs: 120_000, stream: false },
  high: { maxTokens: 16000, retryMaxTokens: 32000, timeoutMs: 600_000, stream: true },
  xhigh: { maxTokens: 16000, retryMaxTokens: 32000, timeoutMs: 600_000, stream: true },
  max: { maxTokens: 16000, retryMaxTokens: 32000, timeoutMs: 600_000, stream: true },
};

function resolveEffort(effort, fallback) {
  return typeof effort === "string" && VALID_EFFORTS.has(effort) ? effort : fallback;
}

export function createClaudeClient({ apiKey, baseURL, outboundFetch }) {
  return new Anthropic({
    apiKey,
    authToken: null,
    baseURL,
    // 这个客户端只给学习用；SDK 的重试会照 retry-after 睡、没有上限、暂停叫不醒，
    // 一律交给 runner 处理（见 @anthropic-ai/sdk/client.mjs 第 884–914 行）。
    maxRetries: 0,
    fetch: (url, init) => outboundFetch(url, { ...init, redirect: "error", credentials: "omit" }),
  });
}

/**
 * 解析响应头里的 retry-after-ms / retry-after（与 SDK client.mjs 887–904 行一致）。
 * 先看 retry-after-ms（浮点毫秒），没有/无效/为 0 再看 retry-after（浮点秒数或 HTTP 日期）。
 * 结果为有限正数时返回毫秒数，否则返回 null；不设上限（上限由 runner 决定）。
 */
export function retryAfterMsFromHeaders(headers, nowMs = Date.now()) {
  if (!headers || typeof headers.get !== "function") return null;
  let timeoutMs;
  const retryAfterMsHeader = headers.get("retry-after-ms");
  if (retryAfterMsHeader) {
    const parsedMs = parseFloat(retryAfterMsHeader);
    if (Number.isFinite(parsedMs) && parsedMs > 0) timeoutMs = parsedMs;
  }
  if (timeoutMs === undefined) {
    const retryAfterHeader = headers.get("retry-after");
    if (retryAfterHeader) {
      const parsedSeconds = parseFloat(retryAfterHeader);
      if (!Number.isNaN(parsedSeconds)) {
        timeoutMs = parsedSeconds * 1000;
      } else {
        timeoutMs = Date.parse(retryAfterHeader) - nowMs;
      }
    }
  }
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null;
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

/** 一条回答按哪个模型计价：走了服务端兜底按兜底模型，否则按回答里的模型。 */
function billingModelOf(message, requestedModel) {
  const iterations = Array.isArray(message?.usage?.iterations) ? message.usage.iterations : [];
  const fallbackEntry = iterations.find((entry) => entry?.type === "fallback_message" && entry.model);
  const billedModel = fallbackEntry ? fallbackEntry.model : (message?.model || requestedModel);
  if (usageToCost(billedModel, {}) !== null) return { billedModel, costModel: billedModel, fallbackUsed: Boolean(fallbackEntry) };
  return { billedModel, costModel: fallbackEntry ? FALLBACK_BILLING_MODEL : billedModel, fallbackUsed: Boolean(fallbackEntry) };
}

/**
 * 这次调用里收到的每一条回答都要算钱：被拒（refusal）、截断（max_tokens）、
 * 解析失败后重试的那几次服务端照样收费，不算进来花费上限就会偏低（463 验收）。
 * 一条回答都没收到（HTTP 错误、连不上）才是 0。
 */
function messagesCost(messages, requestedModel) {
  let costUsd = 0;
  let costKnown = true;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const message of messages) {
    const { costModel } = billingModelOf(message, requestedModel);
    const cost = usageToCost(costModel, message?.usage);
    if (cost === null) costKnown = false;
    else costUsd += cost;
    inputTokens += Number(message?.usage?.input_tokens || 0);
    outputTokens += Number(message?.usage?.output_tokens || 0);
  }
  return { costUsd, costKnown, inputTokens, outputTokens };
}

/**
 * 一次结构化补全。stop_reason refusal → refusal；解析失败或 max_tokens 截断
 * → 用 retryMaxTokens 重试一次，还不行 → bad-output。解析成功即算数（服务
 * 端 schema 已约束结构）。send 由调用方给（分析走 create，汇总走流式）。
 * 返回值带 messages：收到的每一条回答（算钱用）。
 */
async function createStructuredMessage({ send, createParams, retryMaxTokens }) {
  let attemptParams = createParams;
  let retried = false;
  const messages = [];
  for (;;) {
    let message;
    try {
      message = await send(attemptParams);
    } catch (error) {
      const retryAfterMs = error instanceof Anthropic.APIError
        ? retryAfterMsFromHeaders(error.headers)
        : null;
      return { ok: false, code: classifyClaudeError(error), retryAfterMs, error, messages };
    }
    messages.push(message);
    if (message.stop_reason === "refusal") return { ok: false, code: "refusal", message, messages };
    const parsed = parseStructuredOutput(message);
    if (parsed) return { ok: true, note: parsed, message, messages };
    if (!retried) {
      retried = true;
      attemptParams = { ...attemptParams, ...(retryMaxTokens ? { max_tokens: retryMaxTokens } : {}) };
      continue;
    }
    return { ok: false, code: "bad-output", message, messages };
  }
}

/**
 * 逐张分析一张图。图片块放在文字块前面；元数据块包在
 * <asset_metadata>…</asset_metadata> 里。不传 thinking / temperature /
 * top_p / top_k（Haiku 5.5 与 Sonnet 5.5 都会 400）；想多少用 effort 控制。
 */
export async function analyzeImage(client, { model, image, metadata, signal, systemPrompt, effort }) {
  const resolvedEffort = resolveEffort(effort, AI_LEARNING_DEFAULT_EFFORT.analysis);
  const limits = ANALYZE_LIMITS_BY_EFFORT[resolvedEffort];
  const params = {
    model,
    max_tokens: limits.maxTokens,
    system: systemPrompt,
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } },
        { type: "text", text: `<asset_metadata>\n${JSON.stringify(metadata)}\n</asset_metadata>` },
      ],
    }],
    output_config: { format: { type: "json_schema", schema: ANALYSIS_NOTE_JSON_SCHEMA }, effort: resolvedEffort },
  };
  // 低/中档走 messages.create（60s/120s 超时）；高及以上走流式（600s）。解析失败放大 max_tokens 重试一次。
  const send = limits.stream
    ? (attemptParams) => client.messages.stream(attemptParams, { timeout: limits.timeoutMs, signal }).finalMessage()
    : (attemptParams) => client.messages.create(attemptParams, { timeout: limits.timeoutMs, signal });
  const result = await createStructuredMessage({
    send,
    createParams: params,
    retryMaxTokens: limits.retryMaxTokens,
  });
  const spent = messagesCost(result.messages, model);
  const usage = { input_tokens: spent.inputTokens, output_tokens: spent.outputTokens };
  if (!result.ok) {
    return {
      ok: false,
      code: result.code,
      retryAfterMs: result.retryAfterMs ?? null,
      costUsd: spent.costUsd,
      costKnown: spent.costKnown,
      usage,
      model,
    };
  }
  const message = result.message;
  return {
    ok: true,
    note: result.note,
    usage,
    costUsd: spent.costUsd,
    costKnown: spent.costKnown,
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
export async function summarizeGuide(client, { model, userContent, signal, systemPrompt, effort }) {
  const resolvedEffort = resolveEffort(effort, AI_LEARNING_DEFAULT_EFFORT.summary);
  const maxTokens = SUMMARY_HIGH_EFFORTS.has(resolvedEffort) ? 64000 : 32000;
  const params = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: { type: "json_schema", schema: GUIDE_OUTPUT_JSON_SCHEMA }, effort: resolvedEffort },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: [{ model: "claude-sonnet-5" }],
  };
  // 输出长的请求走流式（finalMessage），免得 HTTP 超时；解析失败重试一次。
  const result = await createStructuredMessage({
    send: (attemptParams) => client.beta.messages.stream(attemptParams, { timeout: 600_000, signal }).finalMessage(),
    createParams: params,
  });
  const spent = messagesCost(result.messages, model);
  const usage = { input_tokens: spent.inputTokens, output_tokens: spent.outputTokens };
  if (!result.ok) {
    // 汇总的解析失败按 summary-error 交回（refusal / 错误分类原样）；已收到的
    // 回答照样计价交回，由调用方记账、计入这次学习的花费。
    const code = result.code === "bad-output" ? "summary-error" : result.code;
    return {
      ok: false,
      code,
      retryAfterMs: result.retryAfterMs ?? null,
      usage,
      costUsd: spent.costUsd,
      costKnown: spent.costKnown,
    };
  }
  const { billedModel, costModel, fallbackUsed } = billingModelOf(result.message, model);
  return {
    ok: true,
    guide: result.note,
    usage,
    costUsd: spent.costUsd,
    costKnown: spent.costKnown,
    billedModel,
    costModel,
    fallbackUsed,
  };
}
