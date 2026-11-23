// 任务 463：跑学习的行为测试。真 startMosaRuntime 临时库 + 真
// learning-service-client + 假 Claude fetch（不向任何真实地址发请求、不花一分
// 钱）；图用 test/helpers/unique-image.mjs 造真 PNG，中图生成好才开始；
// concurrency / chunkSize / now 注入。
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { createLearningServiceClient } from "../desktop/ai/learning-service-client.mjs";
import { createLearningRunner } from "../desktop/ai/learning-runner.mjs";
import { createAiCredentialStore, createQaAiEncryptionStub } from "../desktop/ai/credential-store.mjs";
import { createAiSettingsStore } from "../desktop/ai/settings-store.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

// 测试专用的运行时 HTTP 助手（服务 client 只有学习路由；这里还要查 /api/assets）。
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

const CLIENT_TOKEN = "learning-runner-client-token-0123456789abcdef";

const GOOD_NOTE = {
  subject: "一张测试图",
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
    { section: "positioning", text: "一致的扁平插画", swatches: [], sources: [1, 2] },
    { section: "palette", text: "深蓝主色", swatches: [{ hex: "#112233", name: "深蓝" }], sources: [1] },
    { section: "prompting", text: "短提示词加 minimal palette", swatches: [], sources: [1, 2, 3] },
  ],
};

/**
 * 假 Claude fetch：按 analyze / summarize 两类回答，行为可逐测试覆盖
 * （overrides.analyze / overrides.summarize 里返回 { status, body } 或抛错）。
 * calls 里记下每次的网址和 body（分析/汇总分开计数）。
 */
function makeFakeClaudeFetch(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    const entry = {
      url: String(url),
      auth: headers.authorization,
      kind: Array.isArray(body?.messages?.[0]?.content) && body.messages[0].content[0]?.type === "image" ? "analyze" : "summarize",
      body,
      at: Date.now(),
    };
    calls.push(entry);
    if (entry.kind === "analyze") {
      const override = overrides.analyze;
      if (override) return override(entry, calls.filter((call) => call.kind === "analyze").length);
      return new Response(JSON.stringify({
        id: "msg_a", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2276, output_tokens: 800 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const override = overrides.summarize;
    if (override) return override(entry, calls.filter((call) => call.kind === "summarize").length);
    const text = overrides.summarizeText ?? JSON.stringify(GOOD_GUIDE);
    const events = [
      { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 51000, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 6000 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  return { calls, fetchImpl };
}

async function makeHarness(t, { analyze, summarize, summarizeText, concurrency = 4, chunkSize = 300, now } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mosa-learning-runner-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: join(root, "project"),
    // managerDir 用临时目录：指向仓库根会把仓库自带的夹具图扫进临时库。
    managerDir: join(root, "manager"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    // 来源目录全指临时目录、桥全关：不传时会落到本机真实的 ~/.codex、
    // ~/.grok，测试服务会把用户自己的生图收进临时库（11-23 批次复跑撞上过）。
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "codex-sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-canvas"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    disabledBridges: ["cowart", "cowartDiscovery", "codex", "grok"],
    // 中图由测试自己用旁路 store 生成（drainDerivatives）。服务的例行维护（启动后
    // 1.8 秒：清理没被引用的中图，再启动它自己的中图生成）会和旁路生成抢同
    // 一批文件——把刚写好的中图当孤儿删掉，或两边同时改名同一个文件。测试
    // 期间不跑维护（stop() 会清掉这个定时器）。
    maintenanceStartDelayMs: 10 * 60 * 1000,
    clientToken: CLIENT_TOKEN,
    webCaptureToken: "learning-runner-capture-token-0123456789abcd",
  });
  t.after(() => runtime.stop());
  // 导入门禁只认 project 根下的路径：源文件放 generated-images 下（459 测试同款）。
  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });

  const { calls, fetchImpl } = makeFakeClaudeFetch({ analyze, summarize, summarizeText });
  const credentialStore = createAiCredentialStore({ dir: join(root, "ai"), encryption: createQaAiEncryptionStub() });
  const settingsStore = createAiSettingsStore({ dir: join(root, "ai") });
  await credentialStore.save("claude", `sk-test-${"0".repeat(30)}1234`);
  await settingsStore.autoSelectService("claude");

  let currentService = { port: runtime.port, clientToken: CLIENT_TOKEN };
  const runner = createLearningRunner({
    getService: () => currentService,
    credentialStore,
    settingsStore,
    ledgerDir: join(root, "ai"),
    outboundFetch: fetchImpl,
    concurrency,
    chunkSize,
    ...(now ? { now } : {}),
  });
  const serviceClient = createLearningServiceClient({ port: runtime.port, clientToken: CLIENT_TOKEN });
  return { root, sourcesDir, runtime, runner, serviceClient, calls, fetchImpl, credentialStore, settingsStore, setCurrentService: (value) => { currentService = value; } };
}

// 播种和衍生都走测试侧的同库 store（WAL 支持多连接；与 459 store 测试同款建
// 法），衍生用 claimDerivativeJob + processDerivativeJob 自己清队列 —— 不依赖
// 运行时 worker 的空闲轮询节奏。
async function makeSideStore(harness) {
  return createSqliteAssetStore({
    projectRoot: join(harness.root, "project"),
    managerDir: join(harness.root, "manager"),
    libraryDir: join(harness.root, "library"),
  });
}

async function seedImagesViaRuntime(harness, ids) {
  const store = await makeSideStore(harness);
  try {
    for (const [index, id] of ids.entries()) {
      const imagePath = join(harness.sourcesDir, `${id}.png`);
      await writeFile(imagePath, await uniquePngBytes(index + 1));
      const created = await store.createAsset({ assetId: id, imagePath, prompt: `prompt ${id}`, source: { type: "local-file" } });
      const asset = created?.asset?.id ? created.asset : created;
      assert.equal(asset.id, id);
    }
  } finally {
    store.close();
  }
}

async function drainDerivatives(harness) {
  const store = await makeSideStore(harness);
  try {
    for (;;) {
      const job = await store.claimDerivativeJob();
      if (!job) break;
      const result = await processDerivativeJob(store, job);
      assert.equal(result.ok, true, `derivative generation failed: ${JSON.stringify(result)}`);
    }
  } finally {
    store.close();
  }
}


async function makeLibraryWithImages(harness, { libraryName, imageIds }) {
  const library = await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, "/api/learning-libraries", {
    method: "POST", body: { projectId: "default", name: libraryName },
  });
  assert.equal(library.status, 201);
  const libraryId = library.payload.library.id;
  if (imageIds.length) {
    const added = await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${libraryId}/members`, {
      method: "POST", body: { projectId: "default", assetIds: imageIds },
    });
    assert.equal(added.status, 200);
  }
  return libraryId;
}

test("5 张图：报价 → 开始 → 5 done → 汇总 1 次 → 手册写入、run done；假 fetch 共 6 次；台账合计=6 次 usage 按单价之和（不四舍五入）", async (t) => {
  const harness = await makeHarness(t);
  const ids = ["r1", "r2", "r3", "r4", "r5"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "全流程", imageIds: ids });

  const quote = await harness.runner.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote.ok, true);
  assert.equal(quote.kind, "learn");
  assert.equal(quote.counts.newCount, 5, "A-newCount");
  assert.equal(quote.counts.totalCount, 5, "A-total");
  assert.equal(quote.service.id, "claude", "A-service");
  assert.equal(quote.models.analysis.id, "claude-haiku-5-5", "A-analysis");
  assert.equal(quote.models.summary.id, "claude-sonnet-5-5", "A-summary");
  assert.equal(quote.privacy.imageCount, 5, "A-imageCount");
  assert.equal(quote.privacy.longEdge, 960, "A-longEdge");

  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  assert.equal(started.ok, true);
  const runId = started.runId;

  // 等 run 跑完（假 fetch 都即时回答）。
  const deadline = Date.now() + 30000;
  let finalRun = null;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    finalRun = got.payload?.run;
    if (finalRun?.status === "done") break;
    if (Date.now() > deadline) throw new Error(`run never finished: ${JSON.stringify(finalRun)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(finalRun.doneCount, 5, "A-doneCount");
  assert.equal(finalRun.guideRevisionAfter, 1);
  assert.deepEqual(finalRun.change, { added: 3, replaced: 0, keptLocked: 0, droppedNoSource: 0 });

  // 假 fetch 一共 6 次：5 分析 + 1 汇总。
  assert.equal(harness.calls.length, 6, "A-calls6");
  assert.equal(harness.calls.filter((call) => call.kind === "analyze").length, 5, "A-analyze5");
  assert.equal(harness.calls.filter((call) => call.kind === "summarize").length, 1, "A-sum1");

  // 台账：6 次花费按单价精确求和（5 分析每张 (2276×0.1 + 800×0.5)/1e6，
  // 1 汇总 (51000×2 + 6000×10)/1e6），不四舍五入地比，误差 < 1e-9。
  const { monthTotals } = await import("../desktop/ai/usage-ledger.mjs");
  // node:fs/promises 没有 readFileSync —— 用同步的 node:fs。
  const { readFileSync: readSync } = await import("node:fs");
  const ledger = JSON.parse(readSync(join(harness.root, "ai", "ai-usage.json"), "utf8"));
  const analysisRaw = ledger.months[Object.keys(ledger.months)[0]].analysis;
  const expected = 5 * ((2276 * 0.1 + 800 * 0.5) / 1e6) + (51000 * 2 + 6000 * 10) / 1e6;
  assert.ok(Math.abs(analysisRaw - expected) < 1e-9, `ledger analysis ${analysisRaw} vs expected ${expected}`);

  // 手册写入：GET state 看得到 3 条、语言 zh。
  const state = await harness.serviceClient.getLearningState("default", libraryId);
  assert.equal(state.payload.guide.revision, 1);
  assert.equal(state.payload.guide.language, "zh");
  assert.equal(state.payload.guide.entries.length, 3);

  // 再报价：newCount 0、kind summary-only；加 2 张新图再报价 newCount 2。
  const quote2 = await harness.runner.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote2.ok, true);
  assert.equal(quote2.kind, "summary-only");
  assert.equal(quote2.counts.newCount, 0);
  const extraIds = ["r6", "r7"];
  await seedImagesViaRuntime(harness, extraIds);
  await drainDerivatives(harness);
  await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${libraryId}/members`, {
    method: "POST", body: { projectId: "default", assetIds: extraIds },
  });
  const quote3 = await harness.runner.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote3.ok, true);
  assert.equal(quote3.kind, "learn");
  assert.equal(quote3.counts.newCount, 2);
});

test("暂停：分析各等 200ms，跑到第 2 张暂停 → pausing → paused；暂停后假 fetch 没有新的分析请求；继续（新令牌）→ 跑完", async (t) => {
  const harness = await makeHarness(t, {
    analyze: async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      return new Response(JSON.stringify({
        id: "msg_p", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn", usage: { input_tokens: 2276, output_tokens: 800 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const ids = ["p1", "p2", "p3", "p4", "p5"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "暂停", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  assert.equal(started.ok, true);
  const runId = started.runId;

  // 等到第 2 个分析请求出现再暂停。
  const deadline = Date.now() + 10000;
  while (harness.calls.filter((call) => call.kind === "analyze").length < 2) {
    if (Date.now() > deadline) throw new Error("never reached the second analyze request");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  const paused = await harness.runner.pause({ runId });
  assert.equal(paused.ok, true);
  const analyzeCallsAtPause = harness.calls.filter((call) => call.kind === "analyze").length;

  // 状态先 pausing 后 paused。
  const statusNow = await harness.runner.status({ project: "default", libraryId });
  assert.ok(["pausing", "paused"].includes(statusNow.run.status), `status ${statusNow.run.status}`);
  const deadline2 = Date.now() + 15000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    if (got.payload?.run?.status === "paused") break;
    if (Date.now() > deadline2) throw new Error(`never paused: ${got.payload?.run?.status}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const final = await harness.runner.status({ project: "default", libraryId });
  assert.equal(final.run.status, "paused");
  assert.equal(final.run.pauseReason, "user");
  // 暂停之后假 fetch 没有再收到新的分析请求。
  await new Promise((resolveWait) => setTimeout(resolveWait, 400));
  const afterPauseCalls = harness.calls.filter((call) => call.kind === "analyze").length;
  assert.equal(afterPauseCalls, analyzeCallsAtPause, `no new analyze requests after pause (had ${analyzeCallsAtPause}, now ${afterPauseCalls})`);
  assert.ok(afterPauseCalls < 5, "the fifth image was never dispatched");

  // 继续：新报价令牌 → 跑完。
  const resumeQuote = await harness.runner.quote({ project: "default", libraryId, runId, language: "zh" });
  assert.equal(resumeQuote.ok, true);
  assert.equal(resumeQuote.kind, "resume");
  const resumed = await harness.runner.resume({ runId, quoteToken: resumeQuote.quoteToken });
  assert.equal(resumed.ok, true);
  const deadline3 = Date.now() + 30000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    if (got.payload?.run?.status === "done") break;
    if (Date.now() > deadline3) throw new Error(`resume never finished: ${JSON.stringify(got.payload?.run)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(harness.calls.filter((call) => call.kind === "summarize").length, 1);
});

test("401：第 3 张回 401 → run paused/auth、那张留 pending、没有再发请求；换回正常后继续 → 完成", async (t) => {
  let count = 0;
  const harness = await makeHarness(t, {
    analyze: async () => {
      count += 1;
      if (count === 3) {
        return new Response(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "msg_u", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const ids = ["u1", "u2", "u3", "u4"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "401", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const runId = started.runId;
  const deadline = Date.now() + 20000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    if (got.payload?.run?.status === "paused") {
  assert.equal(got.payload.run.pauseReason, "auth");
      // 并发 4 下 4 张同一波派出，401 落在哪个请求取决于到达顺序。确定的
      // 契约：401 那张留 pending；401 回来时还在取输入、没发出 Claude 请求的
      // 也留 pending（一分钱没花，继续时重做）；已发出的照常回来记账。所以
      // 「done + pending = 4」，且 Claude 只收到「done 张数 + 401 那一次」。
      const pendingItems = got.payload.run.items.filter((item) => item.status === "pending");
      assert.ok(pendingItems.length >= 1, "the 401 image stays pending");
      assert.equal(got.payload.run.doneCount + pendingItems.length, 4);
      assert.equal(got.payload.run.failedCount, 0);
      assert.equal(harness.calls.filter((call) => call.kind === "analyze").length, got.payload.run.doneCount + 1,
        "no Claude request goes out for an image after the auth pause");
      break;
    }
    if (Date.now() > deadline) throw new Error(`never paused on auth: ${JSON.stringify(got.payload?.run)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const callsAtPause = harness.calls.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  assert.equal(harness.calls.length, callsAtPause, "no further requests after the auth pause");

  // 换回正常（重新建一个正常回答的 runner——直接清掉坏 handler），继续。
  const resumeQuote = await harness.runner.quote({ project: "default", libraryId, runId });
  const resumed = await harness.runner.resume({ runId, quoteToken: resumeQuote.quoteToken });
  assert.equal(resumed.ok, true);
  const deadline2 = Date.now() + 30000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    if (got.payload?.run?.status === "done") break;
    if (Date.now() > deadline2) throw new Error(`resume after auth never finished: ${JSON.stringify(got.payload?.run)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  // 401 那张被重做并成功（假 fetch 的 count 继续增长）。
  assert.ok(count >= 5, `the failed image was retried (count ${count})`);
});

test("超支：假 usage 给很大的 token 数 → 碰上限 → paused/over-budget", async (t) => {
  const harness = await makeHarness(t, {
    analyze: async () => new Response(JSON.stringify({
      id: "msg_b", type: "message", role: "assistant", model: "claude-haiku-5-5",
      content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
      stop_reason: "end_turn", usage: { input_tokens: 5_000_000, output_tokens: 4_000_000 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  // 6 张 > 并发 4：第一波记完大额账后，第二波的派单检查必须拦住。
  const ids = ["b1", "b2", "b3", "b4", "b5", "b6"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "超支", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  assert.ok(quote.capUsd < 1, "cap is small for these images");
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const runId = started.runId;
  const deadline = Date.now() + 20000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    if (got.payload?.run?.status === "paused") {
      assert.equal(got.payload.run.pauseReason, "over-budget");
      assert.ok(got.payload.run.costUsd > quote.capUsd, `spent ${got.payload.run.costUsd} > cap ${quote.capUsd}`);
      // 必须在派单阶段就拦住（第一波 4 张记完账、第二波派出去之前）；
      // 只靠汇总阶段的检查兜底的话 6 张会全部跑完（doneCount === 6）。
      assert.ok(got.payload.run.doneCount < ids.length, `paused mid-run (doneCount ${got.payload.run.doneCount} < ${ids.length})`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`never paused over budget: ${JSON.stringify(got.payload?.run)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
});

test("一张 refusal：那张 failed/refusal、其余照跑、手册照写；下次报价它不在待学里", async (t) => {
  const refusalAssetIds = new Set(["f2"]);
  const harness = await makeHarness(t, {
    analyze: async (entry) => {
      const assetId = entry.body.messages[0].content[1].text.match(/"prompt":"([^"]+)"/)?.[1]?.includes("f2");
      void assetId;
      // f2 的图：从元数据里认不出来——用 base64 长度区分不可靠；直接按顺序第 2 个分析请求拒。
      const analyzeIndex = harness.calls.filter((call) => call.kind === "analyze").length;
      if (refusalAssetIds.has(`f${analyzeIndex}`) || analyzeIndex === 2) {
        return new Response(JSON.stringify({
          id: "msg_r", type: "message", role: "assistant", model: "claude-haiku-5-5",
          content: [{ type: "text", text: "I cannot help with that." }],
          stop_reason: "refusal", usage: { input_tokens: 50, output_tokens: 10 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "msg_f", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const ids = ["f1", "f2", "f3"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "refusal", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const runId = started.runId;
  const deadline = Date.now() + 30000;
  let finalRun = null;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    finalRun = got.payload?.run;
    if (finalRun?.status === "done") break;
    if (Date.now() > deadline) throw new Error(`never finished with a refusal: ${JSON.stringify(finalRun)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(finalRun.failedCount, 1);
  assert.equal(finalRun.doneCount, 2);
  const refusedItem = finalRun.items.find((item) => item.status === "failed");
  assert.equal(refusedItem.errorCode, "refusal");
  assert.equal(finalRun.guideRevisionAfter, 1, "the guide is still written");

  // 下次报价它不在待学里（refusal 指纹没变就不重学）。
  const quote2 = await harness.runner.quote({ project: "default", libraryId });
  assert.equal(quote2.kind, "summary-only");
  assert.equal(quote2.counts.newCount, 0);
});

test("分批：chunkSize 2、5 张 → 汇总请求 3+1=4 次；合并输出里不存在的引用号被丢、没有来源的条目计入 droppedNoSource", async (t) => {
  const harness = await makeHarness(t, {
    chunkSize: 2,
    summarize: async (_entry, index) => {
      // 前 3 次是批次汇总（各回一份带引用号的部分手册），第 4 次是合并。
      if (index < 4) {
        const text = JSON.stringify({
          entries: [{ section: "palette", text: `批次${index} 的配色`, swatches: [], sources: [index, index + 1] }],
        });
        const events = [
          { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      // 合并那次：两条合并条目，其中一条的引用 [99] 不存在 → 丢掉进 droppedNoSource。
      const text = JSON.stringify({
        entries: [
          { section: "palette", text: "合并后的配色", swatches: [], sources: [1, 2, 3] },
          { section: "mood", text: "没有来源的情绪", swatches: [], sources: [99] },
        ],
      });
      const events = [
        { type: "message_start", message: { id: "m2", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 200, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  const ids = ["c1", "c2", "c3", "c4", "c5"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "分批", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const runId = started.runId;
  const deadline = Date.now() + 30000;
  let finalRun = null;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    finalRun = got.payload?.run;
    if (finalRun?.status === "done") break;
    if (Date.now() > deadline) throw new Error(`chunked run never finished: ${JSON.stringify(finalRun)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.equal(harness.calls.filter((call) => call.kind === "summarize").length, 4, "3 batches + 1 merge");
  assert.deepEqual(finalRun.change, { added: 1, replaced: 0, keptLocked: 0, droppedNoSource: 1 });
});

test("令牌：过期（now 拨 11 分钟）、用过一次、对不上 runId → 都 quote-expired，假 fetch 一次都没被调", async (t) => {
  let currentNow = 1_760_000_000_000;
  const harness = await makeHarness(t, { now: () => currentNow });
  const ids = ["t1", "t2"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "令牌", imageIds: ids });

  const quote = await harness.runner.quote({ project: "default", libraryId });
  assert.equal(quote.ok, true);
  currentNow += 11 * 60 * 1000;
  const expired = await harness.runner.start({ quoteToken: quote.quoteToken });
  assert.deepEqual(expired, { ok: false, reason: "quote-expired" });
  assert.equal(harness.calls.length, 0);

  // 用过一次：先重新报价（时间拨回去无所谓，令牌 10 分钟内）→ start 成功后同一令牌再用 → quote-expired。
  currentNow = 1_760_000_000_000;
  const quote2 = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote2.quoteToken });
  assert.equal(started.ok, true);
  const reused = await harness.runner.start({ quoteToken: quote2.quoteToken });
  assert.deepEqual(reused, { ok: false, reason: "quote-expired" });
  // 第一次 start 已经开跑：等它结束或直接暂停收尾。
  await harness.runner.pause({ runId: started.runId });
  const deadline = Date.now() + 20000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", started.runId);
    if (["paused", "done"].includes(got.payload?.run?.status)) break;
    if (Date.now() > deadline) throw new Error("cleanup run never settled");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  const callsAfterReuse = harness.calls.length;

  // 普通报价：有暂停着的学习 → open-run。
  const quote3 = await harness.runner.quote({ project: "default", libraryId, language: "zh" });
  assert.equal(quote3.ok, false, "there is an open run (paused) → open-run blocked");
  assert.equal(quote3.blocked, "open-run");

  const settled = await harness.serviceClient.getRun("default", started.runId);
  if (settled.payload.run.status === "paused") {
    // 对不上 runId：令牌绑的是这次暂停的学习，拿去继续别的 runId → quote-expired。
    const resumeQuote = await harness.runner.quote({ project: "default", libraryId, runId: started.runId, language: "zh" });
    assert.equal(resumeQuote.ok, true);
    assert.equal(resumeQuote.kind, "resume");
    const mismatched = await harness.runner.resume({ runId: "lr_000000000000", quoteToken: resumeQuote.quoteToken });
    assert.deepEqual(mismatched, { ok: false, reason: "quote-expired" });
    const stillPaused = await harness.serviceClient.getRun("default", started.runId);
    assert.equal(stillPaused.payload.run.status, "paused", "a mismatched token changes nothing");
  }
  // 用过的令牌、对不上的令牌都没让假 fetch 多收到一次请求。
  assert.equal(harness.calls.length, callsAfterReuse, "rejected tokens never reach Claude");
});

test("扫尾：库里直接造一条 running 的 run，新建 runner 调 status → 那条变成 paused/interrupted", async (t) => {
  const harness = await makeHarness(t);
  const ids = ["w1"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "扫尾", imageIds: ids });
  const created = await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${libraryId}/runs`, {
    method: "POST", body: { projectId: "default", assetIds: ["w1"] },
  });
  assert.equal(created.status, 201);
  const runId = created.payload.run.id;

  // 新建一个 runner（内存里什么都没有），调 status。
  const freshRunner = createLearningRunner({
    getService: () => ({ port: harness.runtime.port, clientToken: CLIENT_TOKEN }),
    credentialStore: harness.credentialStore,
    settingsStore: harness.settingsStore,
    ledgerDir: join(harness.root, "ai"),
    outboundFetch: harness.fetchImpl,
  });
  const status = await freshRunner.status({ project: "default", libraryId });
  assert.equal(status.ok, true);
  assert.equal(status.run.status, "paused");
  assert.equal(status.run.pauseReason, "interrupted");
  const got = await harness.serviceClient.getRun("default", runId);
  assert.equal(got.payload.run.status, "paused");
  assert.equal(got.payload.run.pauseReason, "interrupted");
});

test("换库：跑到一半把 getService() 换成另一个端口 → 不再发任何请求", async (t) => {
  const harness = await makeHarness(t, {
    analyze: async () => {
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      return new Response(JSON.stringify({
        id: "msg_s", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const ids = ["s1", "s2", "s3"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "换库", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const runId = started.runId;
  const deadline = Date.now() + 10000;
  while (harness.calls.filter((call) => call.kind === "analyze").length < 1) {
    if (Date.now() > deadline) throw new Error("never dispatched the first analyze");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  // 换端口：指向一个不存在服务的端口（连接立刻失败——但 runner 应该根本不发）。
  harness.setCurrentService({ port: 1, clientToken: "other-token" });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const callsAfterSwitch = harness.calls.length;
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  assert.equal(harness.calls.length, callsAfterSwitch, "no further Claude requests after the service changed");

  // run 停在内存里：旧库的 run 还是 running（等下次扫尾收拾）。
  const got = await harness.serviceClient.getRun("default", runId);
  assert.equal(got.payload.run.status, "running");
  // 扫尾：换回来再 status → interrupted。
  harness.setCurrentService({ port: harness.runtime.port, clientToken: CLIENT_TOKEN });
  const status = await harness.runner.status({ project: "default", libraryId });
  assert.equal(status.run.status, "paused");
  assert.equal(status.run.pauseReason, "interrupted");
});



// ── 463 验收补的几条 ──

async function waitForRunStatus(harness, runId, statuses, label) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const got = await harness.serviceClient.getRun("default", runId);
    const run = got.payload?.run;
    if (run && statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`${label}: run stuck at ${JSON.stringify(run)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

function analyzeOk(usage = { input_tokens: 100, output_tokens: 50 }) {
  return new Response(JSON.stringify({
    id: "msg_ok", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
    stop_reason: "end_turn", usage,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function analyzeRefused(usage = { input_tokens: 2000, output_tokens: 100 }) {
  return new Response(JSON.stringify({
    id: "msg_r", type: "message", role: "assistant", model: "claude-haiku-5-5",
    content: [{ type: "text", text: "I cannot help with that." }],
    stop_reason: "refusal", usage,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function rateLimited() {
  return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), {
    status: 429, headers: { "content-type": "application/json", "retry-after": "0" },
  });
}

function readLedgerAnalysis(harness) {
  const raw = JSON.parse(readFileSync(join(harness.root, "ai", "ai-usage.json"), "utf8"));
  return raw.months[Object.keys(raw.months)[0]].analysis;
}

test("限流：第一次 429（SDK 重试完仍 429）那张放回队尾重做、并发降到 1、全部 done", async (t) => {
  // 并发 1，请求顺序确定。SDK maxRetries 2：一张图的一次分析 = 3 个请求。
  const harness = await makeHarness(t, {
    concurrency: 1,
    analyze: (_entry, analyzeIndex) => (analyzeIndex <= 3 ? rateLimited() : analyzeOk()),
  });
  const ids = ["q1", "q2", "q3"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "限流", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  assert.equal(started.ok, true);
  const run = await waitForRunStatus(harness, started.runId, ["done", "paused", "failed"], "rate-limit once");
  assert.equal(run.status, "done", `first 429 must not stop the run: ${JSON.stringify(run)}`);
  assert.equal(run.doneCount, 3, "the rate-limited image was re-queued and learned");
  assert.equal(harness.calls.filter((call) => call.kind === "analyze").length, 3 + 3);
});

test("限流两次：q1 的 3 次 429 → 放回队尾；q2 成功；q3 又 3 次 429 → paused/rate-limit，两张留 pending", async (t) => {
  const ids = ["q1", "q2", "q3"];
  const harness2 = await makeHarness(t, {
    concurrency: 1,
    analyze: (_entry, analyzeIndex) => (analyzeIndex <= 3 || (analyzeIndex >= 5 && analyzeIndex <= 7) ? rateLimited() : analyzeOk()),
  });
  await seedImagesViaRuntime(harness2, ids);
  await drainDerivatives(harness2);
  const libraryId2 = await makeLibraryWithImages(harness2, { libraryName: "限流两次", imageIds: ids });
  const quote2 = await harness2.runner.quote({ project: "default", libraryId: libraryId2 });
  const started2 = await harness2.runner.start({ quoteToken: quote2.quoteToken });
  const run2 = await waitForRunStatus(harness2, started2.runId, ["done", "paused", "failed"], "rate-limit twice");
  assert.equal(run2.status, "paused");
  assert.equal(run2.pauseReason, "rate-limit");
  assert.equal(run2.counts.byStatus.pending, 2, "both rate-limited images stay pending for the resume");
  assert.equal(run2.doneCount, 1);
});

test("一张都没学成、库里也没有旧笔记 → failed/nothing-learned（不卡在 running）；被拒的回答照样计价，记进 run 和台账", async (t) => {
  const harness = await makeHarness(t, { analyze: () => analyzeRefused() });
  const ids = ["n1", "n2"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "全被拒", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const run = await waitForRunStatus(harness, started.runId, ["failed", "done", "paused"], "nothing learned");
  assert.equal(run.status, "failed");
  assert.equal(run.pauseReason, "nothing-learned");
  assert.ok(run.finishedAt);
  assert.equal(run.failedCount, 2);
  assert.equal(harness.calls.filter((call) => call.kind === "summarize").length, 0, "nothing to summarize, no summary request");
  const perRefusal = (2000 * 0.1 + 100 * 0.5) / 1e6;
  assert.ok(Math.abs(run.costUsd - 2 * perRefusal) < 1e-9, `run cost ${run.costUsd}`);
  assert.ok(Math.abs(readLedgerAnalysis(harness) - 2 * perRefusal) < 1e-9, "ledger carries the refused calls");
  const status = await harness.runner.status({ project: "default", libraryId });
  assert.equal(status.run, null, "no open run is left behind");
});

test("汇总被拒 → paused/summary-error；分析和被拒那次汇总的花费都记进 run 和台账；继续 → 只重做汇总", async (t) => {
  let refuseSummary = true;
  const sse = (stopReason, text, usage) => {
    const events = [
      { type: "message_start", message: { id: "msg_s", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: usage.input, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: usage.output } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
  };
  const harness = await makeHarness(t, {
    analyze: () => analyzeOk(),
    summarize: () => (refuseSummary
      ? sse("refusal", "I cannot.", { input: 5000, output: 300 })
      : sse("end_turn", JSON.stringify(GOOD_GUIDE), { input: 5000, output: 1000 })),
  });
  const ids = ["s1", "s2", "s3"];
  await seedImagesViaRuntime(harness, ids);
  await drainDerivatives(harness);
  const libraryId = await makeLibraryWithImages(harness, { libraryName: "汇总被拒", imageIds: ids });
  const quote = await harness.runner.quote({ project: "default", libraryId });
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  const run = await waitForRunStatus(harness, started.runId, ["paused", "done", "failed"], "summary refused");
  assert.equal(run.status, "paused");
  assert.equal(run.pauseReason, "summary-error");
  const analysisCost = 3 * ((100 * 0.1 + 50 * 0.5) / 1e6);
  const refusedSummaryCost = (5000 * 2 + 300 * 10) / 1e6;
  assert.ok(Math.abs(run.costUsd - (analysisCost + refusedSummaryCost)) < 1e-9, `run cost ${run.costUsd}`);
  assert.ok(Math.abs(readLedgerAnalysis(harness) - (analysisCost + refusedSummaryCost)) < 1e-9);

  refuseSummary = false;
  const resumeQuote = await harness.runner.quote({ project: "default", libraryId, runId: started.runId });
  assert.equal(resumeQuote.kind, "resume");
  assert.equal(resumeQuote.counts.newCount, 0, "nothing left to analyze");
  const resumed = await harness.runner.resume({ runId: started.runId, quoteToken: resumeQuote.quoteToken });
  assert.equal(resumed.ok, true);
  const done = await waitForRunStatus(harness, started.runId, ["done", "paused", "failed"], "summary resumed");
  assert.equal(done.status, "done");
  assert.equal(harness.calls.filter((call) => call.kind === "analyze").length, 3, "no image is analyzed twice");
  const okSummaryCost = (5000 * 2 + 1000 * 10) / 1e6;
  assert.ok(Math.abs(done.costUsd - (analysisCost + refusedSummaryCost + okSummaryCost)) < 1e-9, `final cost ${done.costUsd}`);
});

test("别的学习库里残留一条 running（App 崩过）：在这个库开始学习 → 残留改 paused/interrupted，这次照常开跑；别的库暂停着不挡", async (t) => {
  const harness = await makeHarness(t);
  await seedImagesViaRuntime(harness, ["x1", "y1"]);
  await drainDerivatives(harness);
  const staleLibrary = await makeLibraryWithImages(harness, { libraryName: "残留", imageIds: ["x1"] });
  const freshLibrary = await makeLibraryWithImages(harness, { libraryName: "新学", imageIds: ["y1"] });
  const stale = await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${staleLibrary}/runs`, {
    method: "POST", body: { projectId: "default", assetIds: ["x1"] },
  });
  assert.equal(stale.status, 201);

  // 建 run 的 409 带上挡路的是哪条、哪个库。
  const blocked = await runtimeRequest(harness.runtime.port, CLIENT_TOKEN, `/api/learning-libraries/${freshLibrary}/runs`, {
    method: "POST", body: { projectId: "default", assetIds: ["y1"] },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.payload.code, "LEARNING_RUN_BUSY");
  assert.equal(blocked.payload.openRunId, stale.payload.run.id);
  assert.equal(blocked.payload.busyLibraryId, staleLibrary);
  assert.equal(blocked.payload.busyLibraryName, "残留");

  const quote = await harness.runner.quote({ project: "default", libraryId: freshLibrary });
  assert.equal(quote.ok, true);
  const started = await harness.runner.start({ quoteToken: quote.quoteToken });
  assert.equal(started.ok, true, `start must recover from the stale run: ${JSON.stringify(started)}`);
  const staleAfter = await harness.serviceClient.getRun("default", stale.payload.run.id);
  assert.equal(staleAfter.payload.run.status, "paused");
  assert.equal(staleAfter.payload.run.pauseReason, "interrupted");
  const done = await waitForRunStatus(harness, started.runId, ["done", "paused", "failed"], "fresh library");
  assert.equal(done.status, "done", "a paused run in another library does not block this one");
});
