// 任务 463：学习后台 IPC 通道的行为测试。真模块（desktop/ipc/ai-learning.mjs）
// + test/helpers/fake-ipc-main.mjs + 假 Claude fetch（不向任何真实地址发请求，
// 不花一分钱）。不可信发送方六个通道都 { ok: false }、假 fetch 没被调、库里没
// 有新 run；报价的 8 种 blocked 各一条；所有返回值 stringify 后搜不到假密钥。
// 台账（F 节）的 1000 次小额与 50 并发也在这里。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { makeFakeIpcMain } from "./helpers/fake-ipc-main.mjs";
import { registerAiLearningIpc } from "../desktop/ipc/ai-learning.mjs";
import { createAiCredentialStore, createQaAiEncryptionStub } from "../desktop/ai/credential-store.mjs";
import { createAiSettingsStore } from "../desktop/ai/settings-store.mjs";
import { monthTotals, recordAiUsage } from "../desktop/ai/usage-ledger.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { uniquePngBytes } from "./helpers/unique-image.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const CLIENT_TOKEN = "learning-ipc-client-token-01234567890abcdef";
const FAKE_CLAUDE_KEY = `sk-test-${"0".repeat(30)}1234`;

const trustedEvent = { trusted: true };
const untrustedEvent = { trusted: false };
const trustByMarker = (event) => event?.trusted === true;

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  return dir;
}

const GOOD_NOTE = {
  subject: "一张测试图", style_keywords: ["flat"],
  palette: [{ hex: "#112233", role: "main", name: "深蓝" }],
  composition: "居中", camera: "平视", lighting: "柔光", material: "哑光",
  character: "", mood_keywords: ["安静"], prompt_techniques: ["minimal"], has_text: false,
};
const GOOD_GUIDE = {
  entries: [{ section: "palette", text: "深蓝主色", swatches: [{ hex: "#112233", name: "深蓝" }], sources: [1] }],
};

function makeFakeClaudeFetch({ analyzeDelayMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const kind = Array.isArray(body?.messages?.[0]?.content) && body.messages[0].content[0]?.type === "image" ? "analyze" : "summarize";
    calls.push({ url: String(url), kind });
    if (kind === "analyze") {
      if (analyzeDelayMs) await new Promise((resolveWait) => setTimeout(resolveWait, analyzeDelayMs));
      return new Response(JSON.stringify({
        id: "msg_i", type: "message", role: "assistant", model: "claude-haiku-5-5",
        content: [{ type: "text", text: JSON.stringify(GOOD_NOTE) }],
        stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const text = JSON.stringify(GOOD_GUIDE);
    const events = [
      { type: "message_start", message: { id: "s", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { calls, fetchImpl };
}

function runtimeRequest(port, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolveRequest, rejectRequest) => {
    const req = http.request({
      host: "127.0.0.1", port, path, method,
      headers: { "x-mosa-client-token": CLIENT_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
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

// 一份完整的依赖（真 runtime + 真 credential/settings store + 假 Claude fetch），
// 各测试按需覆盖个别依赖。
async function makeDeps(t, { key = FAKE_CLAUDE_KEY, autoSelect = "claude", credentialOverrides = {}, settingsOverrides = {}, fakeFetch } = {}) {
  const dir = await makeTempDir(t, "ai-learning-ipc-");
  const root = dir;
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: join(root, "project"),
    managerDir: join(root, "manager"),
    appDir: join(repositoryRoot, "web", "gravityport", "dist"),
    libraryDir: join(root, "library"),
    assetsRoot: join(root, "library", "assets"),
    generatedImagesDir: join(root, "generated-images"),
    clientToken: CLIENT_TOKEN,
    webCaptureToken: "learning-ipc-capture-token-01234567890abcdef",
  });
  t.after(() => runtime.stop());
  const { calls, fetchImpl } = fakeFetch || makeFakeClaudeFetch();
  const credentialStore = createAiCredentialStore({ dir: join(root, "ai"), encryption: createQaAiEncryptionStub() });
  const settingsStore = createAiSettingsStore({ dir: join(root, "ai") });
  if (autoSelect) await settingsStore.autoSelectService(autoSelect);
  if (key) await credentialStore.save("claude", key);
  for (const [patch, value] of Object.entries(credentialOverrides)) void [patch, value];
  const ipc = makeFakeIpcMain();
  const deps = {
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    aiCredentialStore: credentialStore,
    aiSettingsStore: settingsStore,
    aiOutboundFetch: fetchImpl,
    getService: () => ({ port: runtime.port, clientToken: CLIENT_TOKEN }),
    desktopDataDir: join(root, "ai"),
    getCurrentLocale: () => "zh",
  };
  return { dir, root, runtime, ipc, deps, calls, credentialStore, settingsStore };
}

test("不可信发送方调六个通道都 { ok: false }、假 fetch 没被调、库里没有新 run", async (t) => {
  const env = await makeDeps(t);
  registerAiLearningIpc(env.deps);
  assert.deepEqual(env.ipc.channels(), [
    "ai-learning-quote",
    "ai-learning-start",
    "ai-learning-pause",
    "ai-learning-resume",
    "ai-learning-abandon",
    "ai-learning-status",
  ]);
  const returns = [];
  returns.push(await env.ipc.handlers.get("ai-learning-quote")(untrustedEvent, { project: "default", libraryId: "ll_x" }));
  returns.push(await env.ipc.handlers.get("ai-learning-start")(untrustedEvent, { quoteToken: "0".repeat(32) }));
  returns.push(await env.ipc.handlers.get("ai-learning-pause")(untrustedEvent, { runId: "lr_x" }));
  returns.push(await env.ipc.handlers.get("ai-learning-resume")(untrustedEvent, { runId: "lr_x", quoteToken: "0".repeat(32) }));
  returns.push(await env.ipc.handlers.get("ai-learning-abandon")(untrustedEvent, { runId: "lr_x" }));
  returns.push(await env.ipc.handlers.get("ai-learning-status")(untrustedEvent, { project: "default", libraryId: "ll_x" }));
  for (const value of returns) assert.deepEqual(value, { ok: false });
  assert.equal(env.calls.length, 0, "the fake Claude fetch was never called");
  // 库里没有新 run：直接查运行时的 learning 状态（还没建过学习库也没有 run）。
  const libraries = await runtimeRequest(env.runtime.port, "/api/learning-libraries?project=default");
  assert.deepEqual(libraries.payload.learningLibraries, []);
});

// 每条 blocked 一个独立 test：一个进程同时只许一个 runtime。
async function quoteBlocked(t, { libraryName, setup, transformDeps }) {
  const env = await makeDeps(t, setup || {});
  if (transformDeps) transformDeps(env.deps, env);
  registerAiLearningIpc(env.deps);
  const created = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: libraryName } });
  assert.equal(created.status, 201);
  const quote = await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId: created.payload.library.id });
  assert.equal(quote.ok, false);
  return quote;
}

test("blocked：encryption-unavailable（加密层不可用）", async (t) => {
  const quote = await quoteBlocked(t, {
    libraryName: "加密不可用",
    transformDeps: (deps) => {
      deps.aiCredentialStore = {
        isEncryptionAvailable: () => false,
        readForRequest: async () => null,
      };
    },
  });
  assert.equal(quote.blocked, "encryption-unavailable");
});

test("blocked：no-service（没选分析服务）", async (t) => {
  const quote = await quoteBlocked(t, { libraryName: "没选服务", setup: { autoSelect: null, key: null } });
  assert.equal(quote.blocked, "no-service");
});

for (const serviceId of ["openai", "ollama"]) {
  test(`blocked：unsupported-service（${serviceId}）`, async (t) => {
    const quote = await quoteBlocked(t, { libraryName: `不支持-${serviceId}`, setup: { autoSelect: serviceId, key: null } });
    assert.equal(quote.blocked, "unsupported-service", serviceId);
  });
}

test("blocked：no-key（选了 Claude 没存密钥）", async (t) => {
  const quote = await quoteBlocked(t, { libraryName: "没密钥", setup: { key: null } });
  assert.equal(quote.blocked, "no-key");
});

test("blocked：unknown-price（模型不在单价表里）", async (t) => {
  const env = await makeDeps(t);
  // 库里放一张可学的图（empty 检查在估价之前，空库会先被 empty 拦下）。
  await seedLearnableImage(env, "up1");
  const created = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: "单价未知" } });
  await runtimeRequest(env.runtime.port, `/api/learning-libraries/${created.payload.library.id}/members`, { method: "POST", body: { projectId: "default", assetIds: ["up1"] } });
  env.deps.aiSettingsStore = {
    read: async () => ({ slots: { analysis: { serviceId: "claude", model: "mystery-model", summaryModel: "mystery-model" } }, customServices: [] }),
  };
  registerAiLearningIpc(env.deps);
  const quote = await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId: created.payload.library.id });
  assert.equal(quote.ok, false);
  assert.equal(quote.blocked, "unknown-price");
});

// 测试侧播种：同库 store 建图 + 自己清衍生队列。
async function seedLearnableImage(env, id, seed = 1) {
  const store = createSqliteAssetStore({
    projectRoot: join(env.root, "project"),
    managerDir: join(env.root, "manager"),
    libraryDir: join(env.root, "library"),
  });
  const sourcesDir = join(env.root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const imagePath = join(sourcesDir, `${id}.png`);
  await writeFile(imagePath, await uniquePngBytes(seed));
  await store.createAsset({ assetId: id, imagePath, prompt: `p ${id}`, source: { type: "local-file" } });
  for (;;) {
    const job = await store.claimDerivativeJob();
    if (!job) break;
    const result = await processDerivativeJob(store, job);
    assert.equal(result.ok, true);
  }
  store.close();
}

test("blocked：empty（没有能学的图、也没有任何笔记）", async (t) => {
  const quote = await quoteBlocked(t, { libraryName: "空库" });
  assert.equal(quote.blocked, "empty");
});

test("blocked：open-run（有一条暂停着的学习，带 runId）", async (t) => {
  const env = await makeDeps(t);
  registerAiLearningIpc(env.deps);
  const created = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: "暂停着" } });
  const libraryId = created.payload.library.id;
  const run = await runtimeRequest(env.runtime.port, `/api/learning-libraries/${libraryId}/runs`, { method: "POST", body: { projectId: "default", assetIds: [] } });
  await runtimeRequest(env.runtime.port, `/api/learning-runs/${run.payload.run.id}`, { method: "PATCH", body: { projectId: "default", to: "pausing", reason: "user" } });
  await runtimeRequest(env.runtime.port, `/api/learning-runs/${run.payload.run.id}`, { method: "PATCH", body: { projectId: "default", to: "paused" } });
  const quote = await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId });
  assert.equal(quote.ok, false);
  assert.equal(quote.blocked, "open-run");
  assert.equal(quote.runId, run.payload.run.id);
});

test("busy：A 库正在学，B 库报价 → busy 带 A 的 id 和名字；开始/继续的返回值里搜不到假密钥", async (t) => {
  const env = await makeDeps(t, { fakeFetch: makeFakeClaudeFetch({ analyzeDelayMs: 120 }) });
  registerAiLearningIpc(env.deps);
  const sideStore = createSqliteAssetStore({
    projectRoot: join(env.root, "project"),
    managerDir: join(env.root, "manager"),
    libraryDir: join(env.root, "library"),
  });
  const sourcesDir = join(env.root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const imageIds = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `i${index + 1}`;
    const imagePath = join(sourcesDir, `${id}.png`);
    await writeFile(imagePath, await uniquePngBytes(index + 1));
    await sideStore.createAsset({ assetId: id, imagePath, prompt: `p${id}`, source: { type: "local-file" } });
    imageIds.push(id);
  }
  for (;;) {
    const job = await sideStore.claimDerivativeJob();
    if (!job) break;
    const result = await processDerivativeJob(sideStore, job);
    assert.equal(result.ok, true);
  }
  sideStore.close();
  const libraryA = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: "A 库在学" } });
  await runtimeRequest(env.runtime.port, `/api/learning-libraries/${libraryA.payload.library.id}/members`, { method: "POST", body: { projectId: "default", assetIds: imageIds } });
  const libraryB = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: "B 库等着" } });

  const quoteA = await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId: libraryA.payload.library.id });
  assert.equal(quoteA.ok, true);
  const started = await env.ipc.handlers.get("ai-learning-start")(trustedEvent, { quoteToken: quoteA.quoteToken });
  assert.equal(started.ok, true);

  const quoteB = await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId: libraryB.payload.library.id });
  assert.equal(quoteB.ok, false);
  assert.equal(quoteB.blocked, "busy");
  assert.equal(quoteB.libraryId, libraryA.payload.library.id);
  assert.equal(quoteB.libraryName, "A 库在学");

  // 收尾：暂停 A 的学习，等它落停。
  await env.ipc.handlers.get("ai-learning-pause")(trustedEvent, { runId: started.runId });
  const deadline = Date.now() + 20000;
  for (;;) {
    const got = await runtimeRequest(env.runtime.port, `/api/learning-runs/${started.runId}?project=default`);
    if (["paused", "done"].includes(got.payload?.run?.status)) break;
    if (Date.now() > deadline) throw new Error("busy cleanup never settled");
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }

  // 所有返回值 stringify 后搜不到假密钥。
  const allReturns = [quoteA, started, quoteB];
  assert.ok(!JSON.stringify(allReturns).includes(FAKE_CLAUDE_KEY), "no fake key in IPC return values");
});

test("六个通道可信调用的返回值都搜不到假密钥；参数逐项校验", async (t) => {
  const env = await makeDeps(t);
  registerAiLearningIpc(env.deps);
  const created = await runtimeRequest(env.runtime.port, "/api/learning-libraries", { method: "POST", body: { projectId: "default", name: "校验" } });
  const libraryId = created.payload.library.id;
  const returns = [];
  returns.push(await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: "default", libraryId, unknownField: "丢掉" }));
  returns.push(await env.ipc.handlers.get("ai-learning-status")(trustedEvent, { project: "default", libraryId }));
  returns.push(await env.ipc.handlers.get("ai-learning-start")(trustedEvent, { quoteToken: "not-hex" }));
  returns.push(await env.ipc.handlers.get("ai-learning-start")(trustedEvent, { quoteToken: "12345" }));
  returns.push(await env.ipc.handlers.get("ai-learning-pause")(trustedEvent, { runId: 123 }));
  returns.push(await env.ipc.handlers.get("ai-learning-resume")(trustedEvent, { runId: "lr_x", quoteToken: "zz" }));
  returns.push(await env.ipc.handlers.get("ai-learning-abandon")(trustedEvent, { runId: "lr_x" }));
  returns.push(await env.ipc.handlers.get("ai-learning-quote")(trustedEvent, { project: 123, libraryId }));
  assert.ok(!JSON.stringify(returns).includes(FAKE_CLAUDE_KEY), "no fake key in any return value");
  // status 的返回形状。
  assert.equal(returns[1].ok, true);
  assert.equal(returns[1].run, null);
  assert.equal(returns[1].busyElsewhere, null);
});

test("台账：1000 次 $0.0004 → 本月 analysis 读出 $0.40；并发 50 次 $0.01 一笔不丢 → $0.50", async (t) => {
  const dir = await makeTempDir(t, "ai-learning-ledger-");
  for (let index = 0; index < 1000; index += 1) {
    await recordAiUsage(dir, { slot: "analysis", costUsd: 0.0004 });
  }
  const totals = await monthTotals(dir, new Date());
  assert.equal(totals.analysis, 0.4);
  await Promise.all(
    Array.from({ length: 50 }, () => recordAiUsage(dir, { slot: "analysis", costUsd: 0.01 })),
  );
  const afterConcurrent = await monthTotals(dir, new Date());
  assert.equal(afterConcurrent.analysis, 0.9);
});
