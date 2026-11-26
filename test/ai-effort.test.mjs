// 任务 476：学习两步推理强度（目录、设置、Claude 调用、报价、学习流程、IPC、界面纯函数）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  AI_EFFORT_LEVELS,
  AI_LEARNING_DEFAULT_EFFORT,
  AI_MODELS,
  aiEffortFor,
  aiEffortLevelsFor,
  aiPresetServiceById,
} from "../lib/ai/model-catalog.mjs";
import {
  ANALYSIS_FIXED_INPUT_TOKENS,
  ANALYSIS_OUTPUT_TOKENS,
  ANALYSIS_OUTPUT_TOKENS_BY_EFFORT,
  SUMMARY_FIXED_INPUT_TOKENS,
  SUMMARY_NOTE_TOKENS,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_OUTPUT_TOKENS_BY_EFFORT,
  effortCostMultiple,
  estimateLearningCost,
  imageTokens,
} from "../lib/ai/learning-cost.mjs";
import { createAiSettingsStore } from "../desktop/ai/settings-store.mjs";
import { analyzeImage, createClaudeClient, summarizeGuide } from "../desktop/ai/claude-client.mjs";
import { createLearningRunner } from "../desktop/ai/learning-runner.mjs";
import { createLearningServiceClient } from "../desktop/ai/learning-service-client.mjs";
import { createAiCredentialStore, createQaAiEncryptionStub } from "../desktop/ai/credential-store.mjs";
import { registerAiIpc } from "../desktop/ipc/ai.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { makeFakeIpcMain } from "./helpers/fake-ipc-main.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const FAKE_KEY = `sk-test-${"0".repeat(30)}4760`;
const CLIENT_TOKEN = "ai-effort-runner-client-token-0123456789abcdef";

const GOOD_NOTE = {
  subject: "海报样本",
  style_keywords: ["flat"],
  palette: [{ hex: "#112233", role: "main", name: "深蓝" }],
  composition: "居中",
  camera: "平视",
  lighting: "柔光",
  material: "哑光",
  character: "",
  mood_keywords: ["安静"],
  prompt_techniques: ["minimal palette"],
  has_text: false,
};

const GOOD_GUIDE = {
  entries: [
    { section: "positioning", text: "冷蓝极简风格", swatches: [], sources: [1] },
    { section: "palette", text: "深蓝主色", swatches: [{ hex: "#112233", name: "深蓝" }], sources: [1] },
  ],
};

function sseTextResponse(text, model = "claude-sonnet-5-5", usage = { input_tokens: 1000, output_tokens: 500 }) {
  const events = [
    { type: "message_start", message: { id: "msg_sse", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: usage.input_tokens, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

// ── 1. 目录 ──

test("1. 目录：Claude 表内五档、表外三档、别家/Ollama 空、Claude 自定义同 Claude；aiEffortFor 兜底", () => {
  assert.deepEqual(AI_EFFORT_LEVELS, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(AI_LEARNING_DEFAULT_EFFORT, { analysis: "low", summary: "medium" });

  for (const model of AI_MODELS) {
    if (model.service === "claude") {
      assert.deepEqual(model.efforts, ["low", "medium", "high", "xhigh", "max"]);
      assert.equal(model.effortSource, "https://platform.claude.com/docs/en/build-with-claude/effort");
      assert.equal(model.effortCheckedAt, "2026-11-26");
    } else {
      assert.equal("efforts" in model, false, `non-claude model ${model.id} must not declare efforts`);
    }
  }

  const claude = aiPresetServiceById("claude");
  const openai = aiPresetServiceById("openai");
  const gemini = aiPresetServiceById("gemini");
  const ollama = aiPresetServiceById("ollama");
  const customClaude = { id: "custom-12345678", label: "网关", format: "claude", baseUrl: "http://127.0.0.1:9001" };
  const customOpenai = { id: "custom-87654321", label: "O网关", format: "openai", baseUrl: "http://127.0.0.1:9002" };

  assert.deepEqual(aiEffortLevelsFor(claude, "claude-haiku-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(aiEffortLevelsFor(claude, "claude-sonnet-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(aiEffortLevelsFor(claude, "claude-discovered-2026"), ["low", "medium", "high"]);
  assert.deepEqual(aiEffortLevelsFor(customClaude, "claude-haiku-5-5"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(aiEffortLevelsFor(customClaude, "claude-discovered-2026"), ["low", "medium", "high"]);

  assert.deepEqual(aiEffortLevelsFor(openai, "gpt-5-nano"), []);
  assert.deepEqual(aiEffortLevelsFor(gemini, "gemini-2.5-flash-lite"), []);
  assert.deepEqual(aiEffortLevelsFor(ollama, "llama3"), []);
  assert.deepEqual(aiEffortLevelsFor(customOpenai, "flow-model-a"), []);
  assert.deepEqual(aiEffortLevelsFor(claude, ""), []);
  assert.deepEqual(aiEffortLevelsFor(null, "claude-haiku-5-5"), []);

  // aiEffortFor：空 → 默认；非法值 → 默认；不在该模型列表里（表外模型存 max）→ 默认；合法保留。
  assert.equal(aiEffortFor({ model: "claude-haiku-5-5", effort: "" }, "analysis", claude), "low");
  assert.equal(aiEffortFor({ summaryModel: "claude-sonnet-5-5", summaryEffort: "" }, "summary", claude), "medium");
  assert.equal(aiEffortFor({ model: "claude-haiku-5-5", effort: "turbo" }, "analysis", claude), "low");
  assert.equal(aiEffortFor({ summaryModel: "claude-sonnet-5-5", summaryEffort: "turbo" }, "summary", claude), "medium");
  assert.equal(aiEffortFor({ model: "claude-discovered-2026", effort: "max" }, "analysis", customClaude), "low");
  assert.equal(aiEffortFor({ summaryModel: "claude-discovered-2026", summaryEffort: "max" }, "summary", customClaude), "medium");
  assert.equal(aiEffortFor({ model: "claude-discovered-2026", effort: "high" }, "analysis", customClaude), "high");
  assert.equal(aiEffortFor({ model: "gpt-5-nano", effort: "high" }, "analysis", openai), "");
});

// ── 2. 设置 ──

test("2. 设置：旧格式缺键读空、收合法丢非法、换模型按支持列表清/留、换服务清空、删自定义服务五字段全空", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-ai-effort-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // 写入旧格式 ai-settings.json（没有 effort 和 summaryEffort）。
  await writeFile(join(dir, "ai-settings.json"), JSON.stringify({
    version: 1,
    slots: {
      analysis: { serviceId: "claude", model: "claude-sonnet-5-5", summaryModel: "claude-sonnet-5-5" },
      brain: { serviceId: "claude", model: "claude-haiku-5-5" },
      image: { serviceId: "", model: "" },
    },
    customServices: [],
    lastTests: {},
  }, null, 2));

  const store = createAiSettingsStore({ dir });
  const loaded = await store.read();
  assert.equal(loaded.slots.analysis.effort, "");
  assert.equal(loaded.slots.analysis.summaryEffort, "");

  // 加一个 Claude 格式自定义服务并记录测试清单（含表内和表外模型）。
  const added = await store.applyUpdate({
    customServices: [{ label: "中转", format: "claude", baseUrl: "http://127.0.0.1:9100" }],
  });
  const customId = added.settings.customServices[0].id;
  await store.recordTest(customId, {
    ok: true,
    code: "ok",
    models: ["claude-sonnet-5-5", "claude-ext-preview"],
  });

  // 选到该自定义服务的 Sonnet 5.5，存 xhigh 与 high。
  const set1 = await store.applyUpdate({
    slots: {
      analysis: {
        serviceId: customId,
        model: "claude-sonnet-5-5",
        summaryModel: "claude-sonnet-5-5",
        effort: "xhigh",
        summaryEffort: "high",
      },
    },
  });
  assert.equal(set1.settings.slots.analysis.effort, "xhigh");
  assert.equal(set1.settings.slots.analysis.summaryEffort, "high");

  // 非法值被丢掉，保留原值。
  const bad = await store.applyUpdate({
    slots: { analysis: { effort: "ultra", summaryEffort: "bogus" } },
  });
  assert.equal(bad.settings.slots.analysis.effort, "xhigh");
  assert.equal(bad.settings.slots.analysis.summaryEffort, "high");

  // 从 Sonnet 5.5 换到表外模型：xhigh 不在三档内被清成 ""，high 在三档内保留。
  const switchedModel = await store.applyUpdate({
    slots: {
      analysis: {
        model: "claude-ext-preview",
        summaryModel: "claude-ext-preview",
      },
    },
  });
  assert.equal(switchedModel.settings.slots.analysis.effort, "");
  assert.equal(switchedModel.settings.slots.analysis.summaryEffort, "high");

  // 再给 analysis 设 high 后换到 OpenAI：effort 和 summaryEffort 均清空。
  await store.applyUpdate({ slots: { analysis: { effort: "high" } } });
  const switchedService = await store.applyUpdate({
    slots: { analysis: { serviceId: "openai", model: "gpt-5-nano", summaryModel: "gpt-5-mini" } },
  });
  assert.equal(switchedService.settings.slots.analysis.effort, "");
  assert.equal(switchedService.settings.slots.analysis.summaryEffort, "");

  // 换回自定义服务并设置档位，然后删除自定义服务 → 学习槽五个字段全空。
  await store.applyUpdate({
    slots: {
      analysis: {
        serviceId: customId,
        model: "claude-sonnet-5-5",
        summaryModel: "claude-sonnet-5-5",
        effort: "max",
        summaryEffort: "low",
      },
    },
  });
  const removed = await store.applyUpdate({ customServices: [] });
  assert.deepEqual(removed.settings.slots.analysis, {
    serviceId: "",
    model: "",
    summaryModel: "",
    effort: "",
    summaryEffort: "",
  });
});

// ── 3. 调用 ──

test("3. 调用：五档 analyzeImage / summarizeGuide 逐格核对参数、重试上限、走法与超时；不传 effort 与改动前逐字段相等", async () => {
  const image = { mediaType: "image/jpeg", base64: "AAAA" };
  const metadata = { id: "a1" };

  function makeRecordingClient({ failFirst = false } = {}) {
    const calls = [];
    let attempt = 0;
    const replyFor = (params, isSummary) => {
      attempt += 1;
      const text = failFirst && attempt === 1
        ? "not valid json"
        : JSON.stringify(isSummary ? GOOD_GUIDE : GOOD_NOTE);
      return {
        model: params.model,
        stop_reason: "end_turn",
        content: [{ type: "text", text }],
        usage: { input_tokens: 100, output_tokens: 50 },
      };
    };
    return {
      calls,
      client: {
        messages: {
          create: async (params, opts) => {
            calls.push({ method: "messages.create", params: structuredClone(params), opts: { ...opts } });
            return replyFor(params, false);
          },
          stream: (params, opts) => {
            calls.push({ method: "messages.stream", params: structuredClone(params), opts: { ...opts } });
            return { finalMessage: async () => replyFor(params, false) };
          },
        },
        beta: {
          messages: {
            stream: (params, opts) => {
              calls.push({ method: "beta.messages.stream", params: structuredClone(params), opts: { ...opts } });
              return { finalMessage: async () => replyFor(params, true) };
            },
          },
        },
      },
    };
  }

  // 改动前基线（不传 effort）：逐字段对比。
  const baselineRec = makeRecordingClient();
  await analyzeImage(baselineRec.client, { model: "claude-haiku-5-5", image, metadata, systemPrompt: "SYS_A" });
  await summarizeGuide(baselineRec.client, { model: "claude-sonnet-5-5", userContent: "USER_S", systemPrompt: "SYS_S" });

  const analyzeDefaultCall = baselineRec.calls[0];
  assert.equal(analyzeDefaultCall.method, "messages.create");
  assert.deepEqual(analyzeDefaultCall.opts, { timeout: 60_000, signal: undefined });
  assert.deepEqual(Object.keys(analyzeDefaultCall.params), ["model", "max_tokens", "system", "messages", "output_config"]);
  assert.equal(analyzeDefaultCall.params.model, "claude-haiku-5-5");
  assert.equal(analyzeDefaultCall.params.max_tokens, 4000);
  assert.equal(analyzeDefaultCall.params.system, "SYS_A");
  assert.deepEqual(analyzeDefaultCall.params.messages, [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
      { type: "text", text: "<asset_metadata>\n{\"id\":\"a1\"}\n</asset_metadata>" },
    ],
  }]);
  assert.equal(analyzeDefaultCall.params.output_config.format.type, "json_schema");
  assert.equal(analyzeDefaultCall.params.output_config.effort, "low");

  const summaryDefaultCall = baselineRec.calls[1];
  assert.equal(summaryDefaultCall.method, "beta.messages.stream");
  assert.deepEqual(summaryDefaultCall.opts, { timeout: 600_000, signal: undefined });
  assert.deepEqual(Object.keys(summaryDefaultCall.params), ["model", "max_tokens", "system", "messages", "output_config", "betas", "fallbacks"]);
  assert.equal(summaryDefaultCall.params.model, "claude-sonnet-5-5");
  assert.equal(summaryDefaultCall.params.max_tokens, 32000);
  assert.equal(summaryDefaultCall.params.system, "SYS_S");
  assert.deepEqual(summaryDefaultCall.params.messages, [{ role: "user", content: "USER_S" }]);
  assert.deepEqual(summaryDefaultCall.params.betas, ["server-side-fallback-2026-07-01"]);
  assert.deepEqual(summaryDefaultCall.params.fallbacks, [{ model: "claude-sonnet-5" }]);
  assert.equal(summaryDefaultCall.params.output_config.format.type, "json_schema");
  assert.equal(summaryDefaultCall.params.output_config.effort, "medium");

  // 非法 effort 也退回默认。
  const invalidRec = makeRecordingClient();
  await analyzeImage(invalidRec.client, { model: "claude-haiku-5-5", image, metadata, systemPrompt: "SYS_A", effort: "bogus" });
  await summarizeGuide(invalidRec.client, { model: "claude-sonnet-5-5", userContent: "USER_S", systemPrompt: "SYS_S", effort: "bogus" });
  assert.equal(invalidRec.calls[0].params.output_config.effort, "low");
  assert.equal(invalidRec.calls[0].params.max_tokens, 4000);
  assert.equal(invalidRec.calls[1].params.output_config.effort, "medium");
  assert.equal(invalidRec.calls[1].params.max_tokens, 32000);

  // 五档 analyzeImage（带一次解析失败重试，验证首轮与重试 max_tokens、走法、超时）。
  const analyzeExpected = [
    ["low", 4000, 8000, "messages.create", 60_000],
    ["medium", 8000, 16000, "messages.create", 120_000],
    ["high", 16000, 32000, "messages.stream", 600_000],
    ["xhigh", 16000, 32000, "messages.stream", 600_000],
    ["max", 16000, 32000, "messages.stream", 600_000],
  ];
  for (const [effort, maxTokens, retryMaxTokens, method, timeout] of analyzeExpected) {
    const rec = makeRecordingClient({ failFirst: true });
    const outcome = await analyzeImage(rec.client, {
      model: "claude-haiku-5-5",
      image,
      metadata,
      systemPrompt: "SYS_A",
      effort,
    });
    assert.equal(outcome.ok, true, `analyzeImage effort=${effort} ok`);
    assert.equal(rec.calls.length, 2, `analyzeImage effort=${effort} retried once`);
    assert.equal(rec.calls[0].method, method, `analyzeImage effort=${effort} method`);
    assert.equal(rec.calls[1].method, method, `analyzeImage effort=${effort} retry method`);
    assert.equal(rec.calls[0].opts.timeout, timeout, `analyzeImage effort=${effort} timeout`);
    assert.equal(rec.calls[0].params.output_config.effort, effort);
    assert.equal(rec.calls[1].params.output_config.effort, effort);
    assert.equal(rec.calls[0].params.max_tokens, maxTokens);
    assert.equal(rec.calls[1].params.max_tokens, retryMaxTokens);
  }

  // 五档 summarizeGuide。
  const summaryExpected = [
    ["low", 32000],
    ["medium", 32000],
    ["high", 64000],
    ["xhigh", 64000],
    ["max", 64000],
  ];
  for (const [effort, maxTokens] of summaryExpected) {
    const rec = makeRecordingClient();
    const outcome = await summarizeGuide(rec.client, {
      model: "claude-sonnet-5-5",
      userContent: "USER_S",
      systemPrompt: "SYS_S",
      effort,
    });
    assert.equal(outcome.ok, true, `summarizeGuide effort=${effort} ok`);
    assert.equal(rec.calls.length, 1);
    assert.equal(rec.calls[0].method, "beta.messages.stream");
    assert.equal(rec.calls[0].opts.timeout, 600_000);
    assert.equal(rec.calls[0].params.output_config.effort, effort);
    assert.equal(rec.calls[0].params.max_tokens, maxTokens);
  }

  // 真 SDK + 假 fetch 验证 analyzeImage high 档走流式 SSE 正常解析。
  const sdkBodies = [];
  const sdkClient = createClaudeClient({
    apiKey: FAKE_KEY,
    baseURL: "https://claude.test.example",
    outboundFetch: async (_url, init) => {
      sdkBodies.push(JSON.parse(init.body));
      return sseTextResponse(JSON.stringify(GOOD_NOTE), "claude-haiku-5-5", { input_tokens: 1500, output_tokens: 2000 });
    },
  });
  const sdkOutcome = await analyzeImage(sdkClient, {
    model: "claude-haiku-5-5",
    image,
    metadata,
    systemPrompt: "SYS_A",
    effort: "high",
  });
  assert.equal(sdkOutcome.ok, true);
  assert.equal(sdkBodies.length, 1);
  assert.equal(sdkBodies[0].stream, true);
  assert.equal(sdkBodies[0].max_tokens, 16000);
  assert.equal(sdkBodies[0].output_config.effort, "high");
});

// ── 4. 报价 ──

test("4. 报价：默认参数与改动前逐位相等；high / max 按表放大；effortCostMultiple 关键点准确", () => {
  assert.equal(ANALYSIS_OUTPUT_TOKENS, 800);
  assert.equal(SUMMARY_OUTPUT_TOKENS, 6000);
  assert.deepEqual(ANALYSIS_OUTPUT_TOKENS_BY_EFFORT, { low: 800, medium: 1600, high: 3200, xhigh: 4800, max: 6400 });
  assert.deepEqual(SUMMARY_OUTPUT_TOKENS_BY_EFFORT, { low: 5000, medium: 6000, high: 9000, xhigh: 12000, max: 15000 });

  const newImages = [{ width: 1920, height: 1080 }, { width: 800, height: 800 }, { width: null, height: null }];
  // 改动前基线逐位相等。
  const defaultQuote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    newImages,
    existingNoteCount: 10,
    summarize: true,
  });
  assert.equal(defaultQuote.analysisUsd, 0.0017955);
  assert.equal(defaultQuote.summaryUsd, 0.07224);
  assert.equal(defaultQuote.summaryCalls, 1);
  assert.equal(defaultQuote.estimateUsd, 0.0740355);
  assert.equal(defaultQuote.capUsd, 0.17);

  // high / max 手算对照（输入与默认完全一致，输出换用表值）。
  const imgInputSum = newImages.reduce((sum, img) => sum + imageTokens(img.width, img.height) + ANALYSIS_FIXED_INPUT_TOKENS, 0);
  const sumInput = (10 + newImages.length) * SUMMARY_NOTE_TOKENS + SUMMARY_FIXED_INPUT_TOKENS;

  const highQuote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    analysisEffort: "high",
    summaryEffort: "high",
    newImages,
    existingNoteCount: 10,
    summarize: true,
  });
  const expectedHighAnalysis = (imgInputSum * 0.1 + 3 * 3200 * 0.5) / 1_000_000;
  const expectedHighSummary = (sumInput * 2 + 9000 * 10) / 1_000_000;
  assert.ok(Math.abs(highQuote.analysisUsd - expectedHighAnalysis) < 1e-12);
  assert.ok(Math.abs(highQuote.summaryUsd - expectedHighSummary) < 1e-12);
  assert.ok(highQuote.estimateUsd > defaultQuote.estimateUsd);
  assert.equal(highQuote.capUsd, Math.ceil((expectedHighAnalysis + expectedHighSummary) * 1.5 * 100 + 5) / 100);

  const maxQuote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    analysisEffort: "max",
    summaryEffort: "max",
    newImages,
    existingNoteCount: 10,
    summarize: true,
  });
  const expectedMaxAnalysis = (imgInputSum * 0.1 + 3 * 6400 * 0.5) / 1_000_000;
  const expectedMaxSummary = (sumInput * 2 + 15000 * 10) / 1_000_000;
  assert.ok(Math.abs(maxQuote.analysisUsd - expectedMaxAnalysis) < 1e-12);
  assert.ok(Math.abs(maxQuote.summaryUsd - expectedMaxSummary) < 1e-12);

  assert.equal(effortCostMultiple("analysis", "low"), 1);
  assert.equal(effortCostMultiple("analysis", "medium"), 2);
  assert.equal(effortCostMultiple("analysis", "high"), 4);
  assert.equal(effortCostMultiple("analysis", "xhigh"), 6);
  assert.equal(effortCostMultiple("analysis", "max"), 8);
  assert.equal(effortCostMultiple("summary", "low"), 1);
  assert.equal(effortCostMultiple("summary", "medium"), 1);
  assert.equal(effortCostMultiple("summary", "high"), 1.5);
  assert.equal(effortCostMultiple("summary", "xhigh"), 2);
  assert.equal(effortCostMultiple("summary", "max"), 2.5);
});

// ── 5. 学习 runner：报价带档位、途中改设置不影响本次、续跑重新报价用新设置 ──

function runtimeRequest(port, clientToken, path, { method = "GET", body } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        "x-mosa-client-token": clientToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = null;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        resolveRequest({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, payload });
      });
    });
    req.on("error", rejectRequest);
    if (body !== undefined) {
      const payload = JSON.stringify(body);
      req.setHeader("content-length", String(Buffer.byteLength(payload)));
      req.write(payload);
    }
    req.end();
  });
}

async function waitForRunStatus(serviceClient, runId, statuses) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const got = await serviceClient.getRun("default", runId);
    const run = got.payload?.run;
    if (run && statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run stuck at ${JSON.stringify(run)}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

test("5. 学习：存 analysis=high / summary=low → 报价带档位、途中改 max 仍发 high/low、暂停后续跑重新报价用新设置", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ai-effort-runner-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: join(root, "project"),
    managerDir: join(root, "manager"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    codexThreadHistoryDir: join(root, "codex-thread-history"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    disabledBridges: ["cowart", "cowartDiscovery", "codex", "grok"],
    maintenanceStartDelayMs: 10 * 60 * 1000,
    clientToken: CLIENT_TOKEN,
    webCaptureToken: "ai-effort-capture-token-0123456789abcd",
  });
  t.after(() => runtime.stop());

  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const ids = ["e1", "e2", "e3"];
  const sideStore = await createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "manager"),
    libraryDir: join(root, "library"),
  });
  try {
    for (const [index, id] of ids.entries()) {
      const imagePath = join(sourcesDir, `${id}.png`);
      await writeFile(imagePath, await uniquePngBytes(index + 50));
      await sideStore.createAsset({ assetId: id, imagePath, prompt: `prompt ${id}`, source: { type: "local-file" } });
    }
    for (;;) {
      const job = await sideStore.claimDerivativeJob();
      if (!job) break;
      const res = await processDerivativeJob(sideStore, job);
      assert.equal(res.ok, true);
    }
  } finally {
    sideStore.close();
  }

  const libRes = await runtimeRequest(runtime.port, CLIENT_TOKEN, "/api/learning-libraries", {
    method: "POST", body: { projectId: "default", name: "推理强度测试库" },
  });
  const libraryId = libRes.payload.library.id;
  await runtimeRequest(runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${libraryId}/members`, {
    method: "POST", body: { projectId: "default", assetIds: ids },
  });

  const credentialStore = createAiCredentialStore({ dir: join(root, "ai"), encryption: createQaAiEncryptionStub() });
  const settingsStore = createAiSettingsStore({ dir: join(root, "ai") });
  await credentialStore.save("claude", FAKE_KEY);
  await settingsStore.autoSelectService("claude");
  await settingsStore.applyUpdate({
    slots: { analysis: { effort: "high", summaryEffort: "low" } },
  });

  const calls = [];
  let releaseFirstAnalyze = null;
  let firstAnalyzeStarted = null;
  const firstAnalyzeReady = new Promise((r) => { firstAnalyzeStarted = r; });

  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const isAnalyze = Array.isArray(body?.messages?.[0]?.content) && body.messages[0].content[0]?.type === "image";
    calls.push({
      kind: isAnalyze ? "analyze" : "summarize",
      effort: body?.output_config?.effort,
      maxTokens: body?.max_tokens,
      stream: Boolean(body?.stream),
    });
    if (isAnalyze) {
      if (calls.filter((c) => c.kind === "analyze").length === 1) {
        firstAnalyzeStarted();
        await new Promise((r) => { releaseFirstAnalyze = r; });
      }
      if (body.stream) {
        return sseTextResponse(JSON.stringify(GOOD_NOTE), "claude-haiku-5-5", { input_tokens: 1500, output_tokens: 1000 });
      }
      return new Response(JSON.stringify({
        id: "msg_a", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1500, output_tokens: 1000 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return sseTextResponse(JSON.stringify(GOOD_GUIDE), "claude-sonnet-5-5", { input_tokens: 3000, output_tokens: 1500 });
  };

  const runner = createLearningRunner({
    getService: () => ({ port: runtime.port, clientToken: CLIENT_TOKEN }),
    credentialStore,
    settingsStore,
    ledgerDir: join(root, "ai"),
    outboundFetch: fetchImpl,
    concurrency: 1,
  });
  const serviceClient = createLearningServiceClient({ port: runtime.port, clientToken: CLIENT_TOKEN });

  // 1) 报价带 high / low 且估算按表放大。
  const quote = await runner.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote.ok, true);
  assert.equal(quote.models.analysis.effort, "high");
  assert.equal(quote.models.summary.effort, "low");
  const expectedLowQuote = estimateLearningCost({
    analysisModel: "claude-haiku-5-5",
    summaryModel: "claude-sonnet-5-5",
    analysisEffort: "low",
    summaryEffort: "low",
    newImages: [{ width: 32, height: 32 }, { width: 32, height: 32 }, { width: 32, height: 32 }],
    existingNoteCount: 0,
    summarize: true,
  });
  assert.ok(quote.analysisUsd > expectedLowQuote.analysisUsd, "high analysis effort quotes higher than low");

  // 2) 开跑第一张，等第一张发出后、第二张发出前把设置改成 max / max；继续放行 → 整次学习仍是 high / low。
  const started = await runner.start({ quoteToken: quote.quoteToken });
  assert.equal(started.ok, true);
  await firstAnalyzeReady;
  await settingsStore.applyUpdate({
    slots: { analysis: { effort: "max", summaryEffort: "max" } },
  });
  // 等第一张放行后直接暂停，把第 3 张留给续跑测新设置；不对，先跑完一次测「途中改设置后续请求仍是 high 且汇总仍是 low」，再测续跑！
  releaseFirstAnalyze();
  const doneRun = await waitForRunStatus(serviceClient, started.runId, ["done", "paused", "failed"]);
  assert.equal(doneRun.status, "done");

  const run1Analyze = calls.filter((c) => c.kind === "analyze");
  const run1Summary = calls.filter((c) => c.kind === "summarize");
  assert.equal(run1Analyze.length, 3);
  assert.equal(run1Summary.length, 1);
  assert.deepEqual(run1Analyze.map((c) => c.effort), ["high", "high", "high"], "mid-run settings edit must not affect in-progress run");
  assert.equal(run1Summary[0].effort, "low", "summary also uses quote-time effort");

  // 3) 续跑（resume）重新报价按当时的新设置（先加 2 张新图、暂停在第一张、改设置再续跑）。
  const moreIds = ["e4", "e5"];
  const sideStore2 = await createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "manager"),
    libraryDir: join(root, "library"),
  });
  try {
    for (const [index, id] of moreIds.entries()) {
      const imagePath = join(sourcesDir, `${id}.png`);
      await writeFile(imagePath, await uniquePngBytes(index + 80));
      await sideStore2.createAsset({ assetId: id, imagePath, prompt: `prompt ${id}`, source: { type: "local-file" } });
    }
    for (;;) {
      const job = await sideStore2.claimDerivativeJob();
      if (!job) break;
      const res = await processDerivativeJob(sideStore2, job);
      assert.equal(res.ok, true);
    }
  } finally {
    sideStore2.close();
  }
  await runtimeRequest(runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${libraryId}/members`, {
    method: "POST", body: { projectId: "default", assetIds: moreIds },
  });

  // 此时设置是 max / max；放缓第一张以便暂停。
  let releasePauseGate = null;
  let pauseGateStarted = null;
  const pauseGateReady = new Promise((r) => { pauseGateStarted = r; });
  const calls2 = [];
  const runner2 = createLearningRunner({
    getService: () => ({ port: runtime.port, clientToken: CLIENT_TOKEN }),
    credentialStore,
    settingsStore,
    ledgerDir: join(root, "ai"),
    outboundFetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      const isAnalyze = Array.isArray(body?.messages?.[0]?.content) && body.messages[0].content[0]?.type === "image";
      calls2.push({ kind: isAnalyze ? "analyze" : "summarize", effort: body?.output_config?.effort });
      if (isAnalyze && calls2.length === 1) {
        pauseGateStarted();
        await new Promise((r) => { releasePauseGate = r; });
      }
      if (isAnalyze) {
        return body.stream
          ? sseTextResponse(JSON.stringify(GOOD_NOTE), "claude-haiku-5-5", { input_tokens: 1500, output_tokens: 1000 })
          : new Response(JSON.stringify({
              id: "msg_a2", type: "message", role: "assistant", model: "claude-haiku-5-5",
              content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1500, output_tokens: 1000 },
            }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return sseTextResponse(JSON.stringify(GOOD_GUIDE), "claude-sonnet-5-5", { input_tokens: 3000, output_tokens: 1500 });
    },
    concurrency: 1,
  });

  const quote2 = await runner2.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote2.models.analysis.effort, "max");
  assert.equal(quote2.models.summary.effort, "max");
  const started2 = await runner2.start({ quoteToken: quote2.quoteToken });
  await pauseGateReady;
  await runner2.pause({ runId: started2.runId });
  releasePauseGate();
  const pausedRun = await waitForRunStatus(serviceClient, started2.runId, ["paused"]);
  assert.equal(pausedRun.status, "paused");

  // 暂停期间把设置改成 medium / high → 续跑重新报价用新设置。
  await settingsStore.applyUpdate({
    slots: { analysis: { effort: "medium", summaryEffort: "high" } },
  });
  const resumeQuote = await runner2.quote({ project: "default", libraryId, runId: started2.runId, language: "zh" });
  assert.equal(resumeQuote.ok, true);
  assert.equal(resumeQuote.kind, "resume");
  assert.equal(resumeQuote.models.analysis.effort, "medium");
  assert.equal(resumeQuote.models.summary.effort, "high");

  const resumed = await runner2.resume({ runId: started2.runId, quoteToken: resumeQuote.quoteToken });
  assert.equal(resumed.ok, true);
  const resumedDone = await waitForRunStatus(serviceClient, started2.runId, ["done", "failed"]);
  assert.equal(resumedDone.status, "done");
  assert.deepEqual(calls2, [
    { kind: "analyze", effort: "max" },
    { kind: "analyze", effort: "medium" },
    { kind: "summarize", effort: "high" },
  ]);
});

// ── 6. IPC ai-get-state 返回 learningEfforts（第七节第 3 条） ──

test("6. IPC ai-get-state：learningEfforts 在 Claude 预设、汇总存 low、表外 Claude 模型、OpenAI 自定义下各字段准确", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-ai-effort-ipc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ipc = makeFakeIpcMain();
  const trustedEvent = { trusted: true };
  registerAiIpc({
    ipcMain: ipc,
    trustedRendererEvent: (event) => event?.trusted === true,
    aiCredentialStore: createAiCredentialStore({ dir, encryption: createQaAiEncryptionStub() }),
    aiSettingsStore: createAiSettingsStore({ dir }),
    desktopDataDir: dir,
    aiOutboundFetch: async () => new Response(JSON.stringify({
      data: [{ id: "claude-haiku-5-5" }, { id: "claude-ext-preview" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  // Claude 预设 + Haiku 5.5：analysis 五档、value low、multiples.high === 4。
  await ipc.handlers.get("ai-save-key")(trustedEvent, "claude", FAKE_KEY);
  let state = await ipc.handlers.get("ai-get-state")(trustedEvent);
  assert.deepEqual(state.learningEfforts.analysis.levels, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(state.learningEfforts.analysis.value, "low");
  assert.equal(state.learningEfforts.analysis.defaultEffort, "low");
  assert.equal(state.learningEfforts.analysis.multiples.high, 4);

  // 汇总存 low → summary value === "low"。
  const upd1 = await ipc.handlers.get("ai-update-settings")(trustedEvent, {
    slots: { analysis: { summaryEffort: "low" } },
  });
  assert.equal(upd1.ok, true);
  assert.equal(upd1.state.learningEfforts.summary.value, "low");
  assert.equal(upd1.state.learningEfforts.summary.defaultEffort, "medium");

  // Claude 格式自定义服务 + 表外模型 → 三档。
  const addedClaude = await ipc.handlers.get("ai-update-settings")(trustedEvent, {
    customServices: [{ label: "C网关", format: "claude", baseUrl: "http://127.0.0.1:9101" }],
  });
  const claudeCustomId = addedClaude.state.services.find((s) => s.id.startsWith("custom-")).id;
  await ipc.handlers.get("ai-save-key")(trustedEvent, claudeCustomId, FAKE_KEY);
  await ipc.handlers.get("ai-test-connection")(trustedEvent, claudeCustomId, "text");
  const updExt = await ipc.handlers.get("ai-update-settings")(trustedEvent, {
    slots: { analysis: { serviceId: claudeCustomId, model: "claude-ext-preview", summaryModel: "claude-ext-preview" } },
  });
  assert.deepEqual(updExt.state.learningEfforts.analysis.levels, ["low", "medium", "high"]);
  assert.equal(updExt.state.learningEfforts.analysis.value, "low");
  assert.deepEqual(updExt.state.learningEfforts.summary.levels, ["low", "medium", "high"]);
  assert.equal(updExt.state.learningEfforts.summary.value, "medium");

  // OpenAI 格式自定义服务 → levels 为 []，value 为 ""。
  const addedOpenai = await ipc.handlers.get("ai-update-settings")(trustedEvent, {
    customServices: [
      { id: claudeCustomId, label: "C网关", format: "claude", baseUrl: "http://127.0.0.1:9101" },
      { label: "O网关", format: "openai", baseUrl: "http://127.0.0.1:9102" },
    ],
  });
  const openaiCustomId = addedOpenai.state.services.find((s) => s.id.startsWith("custom-") && s.id !== claudeCustomId).id;
  await ipc.handlers.get("ai-save-key")(trustedEvent, openaiCustomId, FAKE_KEY);
  const updOpenai = await ipc.handlers.get("ai-update-settings")(trustedEvent, {
    slots: { analysis: { serviceId: openaiCustomId, model: "gpt-5-nano", summaryModel: "gpt-5-mini" } },
  });
  assert.deepEqual(updOpenai.state.learningEfforts.analysis.levels, []);
  assert.equal(updOpenai.state.learningEfforts.analysis.value, "");
  assert.deepEqual(updOpenai.state.learningEfforts.summary.levels, []);
  assert.equal(updOpenai.state.learningEfforts.summary.value, "");
});

// ── 7. 界面纯函数 effortChoiceFor / effortLabelKey（编译真 TypeScript 到专属缓存目录） ──

test("7. 界面纯函数：effortChoiceFor 返回正确 patch，effortLabelKey 映射五档中文", async (t) => {
  const compileRoot = join(repositoryRoot, "node_modules", ".cache", "ai-effort-ts");
  await rm(compileRoot, { recursive: true, force: true });
  await mkdir(compileRoot, { recursive: true });
  t.after(() => rm(compileRoot, { recursive: true, force: true }));

  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "ai-settings-model.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });

  const { effortChoiceFor, effortLabelKey } = await import(`${join(compileRoot, "ai-settings-model.js")}?v=${Date.now()}`);

  const state = {
    available: true,
    services: [],
    slots: {
      analysis: { serviceId: "claude", model: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5", effort: "", summaryEffort: "" },
      brain: { serviceId: "", model: "" },
      image: { serviceId: "", model: "" },
    },
    catalog: { services: [], models: [] },
    priceLines: { analysis: [], brain: [], image: [] },
    monthTotals: { analysis: 0, brain: 0, image: 0 },
    learningEfforts: {
      analysis: { levels: ["low", "medium", "high"], value: "low", defaultEffort: "low", multiples: { low: 1, medium: 2, high: 4 } },
      summary: { levels: ["low", "medium", "high", "xhigh", "max"], value: "medium", defaultEffort: "medium", multiples: { low: 1, medium: 1, high: 1.5, xhigh: 2, max: 2.5 } },
    },
  };

  assert.deepEqual(effortChoiceFor(state, "analysis", "high"), { slot: "analysis", patch: { effort: "high" } });
  assert.deepEqual(effortChoiceFor(state, "analysis", "max"), { slot: "analysis", patch: { effort: "" } });
  assert.deepEqual(effortChoiceFor(state, "summary", "low"), { slot: "analysis", patch: { summaryEffort: "low" } });
  assert.deepEqual(effortChoiceFor(state, "summary", "max"), { slot: "analysis", patch: { summaryEffort: "max" } });

  assert.equal(effortLabelKey("low"), "低");
  assert.equal(effortLabelKey("medium"), "中");
  assert.equal(effortLabelKey("high"), "高");
  assert.equal(effortLabelKey("xhigh"), "很高");
  assert.equal(effortLabelKey("max"), "最高");
});
