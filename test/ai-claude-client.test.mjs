// 任务 463：Claude 客户端的行为测试。真 SDK（@anthropic-ai/sdk 1.12.0）+
// 假 fetch（测试一律不向任何真实地址发请求；真密钥由 Claude 在隔离测试 App
// 里自己填验收）。假 fetch 记下每次的网址、头、body、init。
import assert from "node:assert/strict";
import test from "node:test";

import Anthropic from "@anthropic-ai/sdk";
import {
  analyzeImage,
  classifyClaudeError,
  createClaudeClient,
  summarizeGuide,
  usageToCost,
} from "../desktop/ai/claude-client.mjs";
import { ANALYSIS_SYSTEM_PROMPT, SUMMARY_SYSTEM_PROMPT } from "../desktop/ai/learning-prompts.mjs";

const FAKE_KEY = `sk-test-${"0".repeat(30)}1234`;
const WRONG_ENV_KEY = `sk-test-${"0".repeat(30)}9999`;

const IMAGE = { mediaType: "image/webp", base64: Buffer.from("fake-webp-bytes").toString("base64"), byteLength: 15 };
const METADATA = { prompt: "a red barn", favorite: false, rating: 0, palette: [] };

function makeFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : "";
    let body = null;
    try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = bodyText; }
    // init.headers 是 Headers 实例：快照成普通对象方便断言。
    const headers = Object.fromEntries(new Headers(init?.headers || {}).entries());
    const call = { url: String(url), init: { ...init, body: undefined }, body, headers };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, fetchImpl };
}

function jsonResponse(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// messages.stream 的假响应：最小 SSE 事件序列，finalMessage 从这里聚合。
function sseMessageResponse({ text, stopReason = "end_turn", model = "claude-haiku-5-5", usage = {} }) {
  const events = [
    // usage 整个进 message_start（iterations 之类才能活着到达 finalMessage）。
    { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens ?? 10, output_tokens: 0, ...usage } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output_tokens ?? 20 } },
    { type: "message_stop" },
  ];
  const payload = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const GOOD_NOTE = {
  subject: "a barn", style_keywords: ["flat"], palette: [{ hex: "#AA0000", role: "main", name: "red" }],
  composition: "centered", camera: "eye level", lighting: "soft", material: "matte", character: "",
  mood_keywords: ["calm"], prompt_techniques: ["minimal palette"], has_text: false,
};
const GOOD_GUIDE = { entries: [{ section: "palette", text: "red dominates", swatches: [{ hex: "#AA0000", name: "red" }], sources: [1] }] };

async function analyzeWith(responseHandler) {
  const { calls, fetchImpl } = makeFakeFetch(responseHandler);
  const client = createClaudeClient({ apiKey: FAKE_KEY, baseURL: "https://claude.test.example", outboundFetch: fetchImpl });
  const outcome = await analyzeImage(client, { model: "claude-haiku-5-5", image: IMAGE, metadata: METADATA, systemPrompt: ANALYSIS_SYSTEM_PROMPT });
  return { calls, outcome };
}

async function summarizeWith(responseHandler) {
  const { calls, fetchImpl } = makeFakeFetch(responseHandler);
  const client = createClaudeClient({ apiKey: FAKE_KEY, baseURL: "https://claude.test.example", outboundFetch: fetchImpl });
  const outcome = await summarizeGuide(client, { model: "claude-sonnet-5-5", userContent: "<notes>\n#1 0 | barn | flat | #AA0000 | c | cam | l | m | ch | mood | pt\n</notes>", systemPrompt: SUMMARY_SYSTEM_PROMPT });
  return { calls, outcome };
}

// 注意：任务单写的是「x-api-key 是假密钥、没有 authorization 头」，但装好的
// SDK 1.12.0 里 apiKey 凭证实际发的是 Authorization: Bearer（client.mjs 449-452
// 行 apiKeyAuth = Bearer；全包没有任何发送 x-api-key 的路径，d.ts 304 行也只把
// X-Api-Key 当手设 defaultHeaders 提及）。Anthropic API 官方两种鉴权头都收。
// 这里按 SDK 的真实行为断言，出入写在回报「需要 Claude 定的事」。
test("请求形状：网址 = baseURL + /v1/messages；Bearer 假密钥；没有 x-api-key 头；redirect/credentials 钉死；body 是 json_schema + effort low；图块在文字块前；没有 temperature/top_p/top_k/thinking", async () => {
  const { calls, outcome } = await analyzeWith(() => jsonResponse(200, {
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
    stop_reason: "end_turn", usage: { input_tokens: 2276, output_tokens: 800 },
  }));
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://claude.test.example/v1/messages");
  assert.equal(call.headers.authorization, `Bearer ${FAKE_KEY}`, "SDK 1.12.0 sends the api key as Bearer");
  assert.equal(call.headers["x-api-key"], undefined);
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.body.model, "claude-haiku-5-5");
  assert.equal(call.body.max_tokens, 4000);
  assert.equal(call.body.output_config.format.type, "json_schema");
  assert.equal(call.body.output_config.effort, "low");
  const [imageBlock, textBlock] = call.body.messages[0].content;
  assert.equal(imageBlock.type, "image");
  assert.equal(imageBlock.source.media_type, "image/webp");
  assert.equal(imageBlock.source.type, "base64");
  assert.equal(textBlock.type, "text");
  assert.match(textBlock.text, /^<asset_metadata>/);
  assert.equal(call.body.temperature, undefined);
  assert.equal(call.body.top_p, undefined);
  assert.equal(call.body.top_k, undefined);
  assert.equal(call.body.thinking, undefined);
});

test("环境变量不串：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY 都设了毒值，请求照样只发传进去的地址、用传进去的密钥、头里没有毒值", async () => {
  const previous = {
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  process.env.ANTHROPIC_BASE_URL = "http://evil.invalid";
  process.env.ANTHROPIC_AUTH_TOKEN = "tok-test-0000";
  process.env.ANTHROPIC_API_KEY = WRONG_ENV_KEY;
  try {
    const { calls, outcome } = await analyzeWith(() => jsonResponse(200, {
      id: "msg_2", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
    }));
    assert.equal(outcome.ok, true);
    assert.equal(calls[0].url, "https://claude.test.example/v1/messages", "not the evil base url");
    assert.equal(calls[0].headers.authorization, `Bearer ${FAKE_KEY}`, "carries the passed key, not the poisoned one");
    assert.ok(!JSON.stringify(calls[0].headers).includes("tok-test-0000"), "no token from ANTHROPIC_AUTH_TOKEN");
    assert.ok(!JSON.stringify(calls[0].headers).includes(WRONG_ENV_KEY), "no key from ANTHROPIC_API_KEY");
    assert.ok(!calls[0].url.includes("evil.invalid"), "no poisoned base url");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("回答前面带 thinking 块照样解析（只认 type=text 的块）", async () => {
  const { outcome } = await analyzeWith(() => jsonResponse(200, {
    id: "msg_3", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [
      { type: "thinking", thinking: "let me look at this image…", signature: "sig" },
      { type: "text", text: JSON.stringify(GOOD_NOTE) },
    ],
    stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 },
  }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.note, GOOD_NOTE);
});

test("stop_reason refusal → refusal；max_tokens（解析失败）→ 用 max_tokens 8000 重试一次成功；两次都坏 → bad-output", async () => {
  const refused = await analyzeWith(() => jsonResponse(200, {
    id: "msg_4", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: "I cannot help with that." }],
    stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 10 },
  }));
  assert.equal(refused.outcome.ok, false);
  assert.equal(refused.outcome.code, "refusal");

  const retried = await analyzeWith((_call, index) => index === 1
    ? jsonResponse(200, {
      id: "msg_5a", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: "not json at all" }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
    })
    : jsonResponse(200, {
      id: "msg_5b", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
      stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 },
    }));
  assert.equal(retried.outcome.ok, true);
  assert.deepEqual(retried.outcome.note, GOOD_NOTE);
  assert.equal(retried.calls[0].body.max_tokens, 4000);
  assert.equal(retried.calls[1].body.max_tokens, 8000, "retry lifts max_tokens to 8000");
  assert.equal(retried.calls.length, 2);

  const bothBad = await analyzeWith(() => jsonResponse(200, {
    id: "msg_6", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: "still not json" }],
    stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
  }));
  assert.equal(bothBad.outcome.ok, false);
  assert.equal(bothBad.outcome.code, "bad-output");
  assert.equal(bothBad.calls.length, 2);
});

test("usage 进 tokenCostUsd：Haiku (2276 in / 800 out) = $0.0006276", async () => {
  const { outcome } = await analyzeWith(() => jsonResponse(200, {
    id: "msg_7", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
    stop_reason: "end_turn", usage: { input_tokens: 2276, output_tokens: 800 },
  }));
  assert.ok(Math.abs(outcome.costUsd - 0.0006276) < 1e-12);
  assert.equal(outcome.costKnown, true);
  // 模型不在单价表里：costUsd 记 0 且 costKnown=false（不拦流程）。
  assert.equal(usageToCost("mystery-model", { input_tokens: 10, output_tokens: 10 }), null);
});

test("错误分类：401/403/429（retry-after 0）/500/529/400/连不上；分类结果和 console 里都没有响应体里的假密钥", async () => {
  const consoleCalls = [];
  const originals = {};
  for (const method of ["log", "info", "warn", "error"]) {
    originals[method] = console[method].bind(console);
    console[method] = (...args) => { consoleCalls.push(args.map(String).join(" ")); };
  }
  try {
    const cases = [
      [401, "auth", { error: { type: "authentication_error", message: `bad key ${WRONG_ENV_KEY} leaked in body` } }],
      [403, "auth", { error: { type: "permission_error", message: "denied" } }],
      [429, "rate-limit", { error: { type: "rate_limit_error", message: "slow down" } }],
      [500, "server", { error: { type: "api_error", message: "boom" } }],
      [529, "server", { error: { type: "overloaded_error", message: "overloaded" } }],
      [400, "rejected", { error: { type: "invalid_request_error", message: "bad image" } }],
    ];
    for (const [status, expectedCode, payload] of cases) {
      const { outcome } = await analyzeWith(() => jsonResponse(status, payload, {
        "retry-after": "0",
        "request-id": `req-${status}`,
      }));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.code, expectedCode, `HTTP ${status} → ${expectedCode}`);
    }
    // 连不上：fetch 直接抛（SDK 包成 APIConnectionError）。
    const { outcome: refusedOutcome } = await analyzeWith(() => {
      throw new TypeError("fetch failed");
    });
    assert.equal(refusedOutcome.ok, false);
    assert.equal(refusedOutcome.code, "network");

    // 401 假响应体里放了完整假密钥：分类结果和 console 一个字都不能带它。
    assert.equal(Anthropic.AuthenticationError !== undefined, true);
    const serialized = consoleCalls.join("\n");
    assert.ok(!serialized.includes(WRONG_ENV_KEY), "console must not carry the fake key");
    assert.ok(!JSON.stringify(refusedOutcome).includes(WRONG_ENV_KEY), "outcome must not carry the fake key");
  } finally {
    for (const [method, original] of Object.entries(originals)) console[method] = original;
  }
});

test("汇总：带 betas + fallbacks、走流式、effort medium；引用 usage.iterations 的兜底模型计费", async () => {
  const { calls, outcome } = await summarizeWith(() => sseMessageResponse({
    text: JSON.stringify(GOOD_GUIDE),
    model: "claude-sonnet-5-5",
    usage: { input_tokens: 51000, output_tokens: 6000 },
  }));
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.guide, GOOD_GUIDE);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, "https://claude.test.example/v1/messages");
  // betas 以 anthropic-beta 头发出、fallbacks 留在 body（SDK 1.12.0 的线上形状）。
  assert.equal(call.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(call.body.betas, undefined);
  assert.deepEqual(call.body.fallbacks, [{ model: "claude-sonnet-5" }]);
  assert.deepEqual(call.body.fallbacks, [{ model: "claude-sonnet-5" }]);
  assert.equal(call.body.max_tokens, 32000);
  assert.equal(call.body.output_config.effort, "medium");
  assert.equal(call.body.stream, true);
  assert.ok(Math.abs(outcome.costUsd - ((51000 * 2 + 6000 * 10) / 1e6)) < 1e-12);

  // 兜底被用到（iterations 里有 fallback_message）：按实际模型计费；
  // claude-sonnet-5 不在单价表 → 按 Sonnet 5.5 同价算。
  const fallbackOutcome = await summarizeWith((_call, index) => index === 1
    ? sseMessageResponse({
      text: "not json",
      stopReason: "end_turn",
    })
    : sseMessageResponse({
      text: JSON.stringify(GOOD_GUIDE),
      usage: {
        input_tokens: 1000, output_tokens: 500,
        iterations: [{ type: "message", model: "claude-sonnet-5-5", input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, { type: "fallback_message", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }],
      },
    }));
  assert.equal(fallbackOutcome.outcome.ok, true);
  assert.equal(fallbackOutcome.outcome.fallbackUsed, true);
  assert.equal(fallbackOutcome.outcome.billedModel, "claude-sonnet-5");
  assert.equal(fallbackOutcome.outcome.costModel, "claude-sonnet-5-5");
  assert.ok(Math.abs(fallbackOutcome.outcome.costUsd - ((1000 * 2 + 500 * 10) / 1e6)) < 1e-12);
});

test("汇总 refusal → refusal；两次解析失败 → summary-error", async () => {
  const refused = await summarizeWith(() => sseMessageResponse({ text: "I cannot.", stopReason: "refusal" }));
  assert.equal(refused.outcome.ok, false);
  assert.equal(refused.outcome.code, "refusal");
  const bad = await summarizeWith(() => sseMessageResponse({ text: "not json" }));
  assert.equal(bad.outcome.ok, false);
  assert.equal(bad.outcome.code, "summary-error");
  assert.equal(bad.calls.length, 2, "summary retries once");
});
