// 任务 458：AI IPC 通道的行为测试。真模块（desktop/ipc/ai.mjs）+ test/helpers/
// fake-ipc-main.mjs + 假 fetch（测试一律用假 fetch，不向任何真实地址发请求）。
// 五个通道的所有返回值 JSON.stringify 后搜不到假密钥。
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { makeFakeIpcMain } from "./helpers/fake-ipc-main.mjs";
import { registerAiIpc } from "../desktop/ipc/ai.mjs";
import { createAiCredentialStore, createQaAiEncryptionStub } from "../desktop/ai/credential-store.mjs";
import { createAiSettingsStore } from "../desktop/ai/settings-store.mjs";

const trustedEvent = { trusted: true };
const untrustedEvent = { trusted: false };
const trustByMarker = (event) => event?.trusted === true;

const FAKE_OPENAI_KEY = `sk-test-${"0".repeat(30)}5678`;
const FAKE_CLAUDE_KEY = `sk-test-${"0".repeat(30)}1234`;
const FAKE_CUSTOM_KEY = `sk-test-${"0".repeat(30)}8765`;
const FAKE_GEMINI_KEY = `AIzaTEST${"0".repeat(30)}1234`;

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// 两模型清单的假响应；status/body 可覆盖。
function fakeModelListResponse(status = 200, body) {
  return new Response(body ?? JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "extra-model" }] }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAiDeps(t, { outboundFetch } = {}) {
  return Promise.resolve().then(async () => {
    const dir = await makeTempDir(t, "ai-ipc-");
    const ipc = makeFakeIpcMain();
    const fetchCalls = [];
    const defaultFetch = async (url, init) => {
      fetchCalls.push({ url, init });
      return fakeModelListResponse();
    };
    registerAiIpc({
      ipcMain: ipc,
      trustedRendererEvent: trustByMarker,
      aiCredentialStore: createAiCredentialStore({ dir, encryption: createQaAiEncryptionStub() }),
      aiSettingsStore: createAiSettingsStore({ dir }),
      desktopDataDir: dir,
      aiOutboundFetch: outboundFetch || defaultFetch,
    });
    return { dir, ipc, handlers: ipc.handlers, fetchCalls };
  });
}

function snapshotDir(dir) {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).sort();
  return JSON.stringify({ files, contents: files.map((name) => readFileSync(join(dir, name), "utf8")) });
}

test("registerAiIpc 只注册五个 AI 通道，顺序固定", async (t) => {
  const deps = await makeAiDeps(t);
  assert.deepEqual(deps.ipc.channels(), [
    "ai-get-state",
    "ai-save-key",
    "ai-delete-key",
    "ai-test-connection",
    "ai-update-settings",
  ]);
});

test("不可信发送方调五个通道都 { ok: false } 且文件一个都没变", async (t) => {
  const deps = await makeAiDeps(t);
  const before = snapshotDir(deps.dir);
  const returns = [];
  returns.push(await deps.handlers.get("ai-get-state")(untrustedEvent));
  returns.push(await deps.handlers.get("ai-save-key")(untrustedEvent, "openai", FAKE_OPENAI_KEY));
  returns.push(await deps.handlers.get("ai-delete-key")(untrustedEvent, "openai"));
  returns.push(await deps.handlers.get("ai-test-connection")(untrustedEvent, "openai", "text"));
  returns.push(await deps.handlers.get("ai-update-settings")(untrustedEvent, { slots: { brain: { serviceId: "openai" } } }));
  for (const item of returns) assert.deepEqual(item, { ok: false }, JSON.stringify(item));
  assert.deepEqual(deps.fetchCalls, [], "不可信发送方不得触发任何外发请求");
  assert.equal(snapshotDir(deps.dir), before, "userData 目录里的文件一个都没变");
});

test("可信时存、测、改设置、删的整条路走通；返回值里搜不到假密钥", async (t) => {
  const deps = await makeAiDeps(t);
  const returns = [];
  const call = async (channel, ...args) => {
    const result = await deps.handlers.get(channel)(trustedEvent, ...args);
    returns.push(result);
    return result;
  };

  // 1. 存密钥 → last4，且第一次存自动选（只填一家也能用）。
  const saved = await call("ai-save-key", "openai", FAKE_OPENAI_KEY);
  assert.deepEqual(saved, { ok: true, last4: "5678" });
  const state1 = await call("ai-get-state");
  assert.equal(state1.available, true);
  const openai = state1.services.find((service) => service.id === "openai");
  assert.equal(openai.hasKey, true);
  assert.equal(openai.last4, "5678");
  assert.equal(openai.keyUrl, "https://platform.openai.com/api-keys");
  assert.deepEqual(state1.slots, {
    analysis: { serviceId: "openai", model: "gpt-5-nano", summaryModel: "gpt-5-mini" },
    brain: { serviceId: "openai", model: "gpt-5-mini" },
    image: { serviceId: "openai", model: "gpt-image-2" },
  });

  // 2. 测试连接（假 fetch 回两条模型）→ 连接正常；逐张分析选的模型在清单里，
  //    大脑的 gpt-5-mini 不在 → missingModel 提醒。
  const tested = await call("ai-test-connection", "openai", "text");
  assert.equal(tested.ok, true);
  assert.equal(tested.code, "ok");
  assert.equal(tested.message, "连接正常 · 可用 2 个模型");
  assert.equal(tested.modelCount, 2);
  assert.equal(tested.missingModel, "GPT-5 mini");
  assert.equal(deps.fetchCalls.length, 1);
  assert.equal(deps.fetchCalls[0].url, "https://api.openai.com/v1/models");
  const state2 = await call("ai-get-state");
  assert.deepEqual(state2.services.find((service) => service.id === "openai").lastTest.models, ["gpt-5-nano", "extra-model"]);

  // 3. 改设置：大脑换用测试清单里的模型；出图换模型。
  const updated = await call("ai-update-settings", { slots: { brain: { serviceId: "openai", model: "extra-model" } } });
  assert.equal(updated.ok, true);
  assert.equal(updated.state.slots.brain.model, "extra-model");

  // 4. 删密钥。
  assert.deepEqual(await call("ai-delete-key", "openai"), { ok: true });
  const state3 = await call("ai-get-state");
  assert.equal(state3.services.find((service) => service.id === "openai").hasKey, false);

  // 五个通道的所有返回值序列化后搜不到假密钥（原文和去前缀的串都不行）。
  const serialized = JSON.stringify(returns);
  assert.ok(!serialized.includes(FAKE_OPENAI_KEY), "返回值里不能出现密钥原文");
  assert.ok(!serialized.includes(FAKE_OPENAI_KEY.slice("sk-test-".length)), "去前缀后的串也不能出现");
});

test("第一次存密钥自动选：只存 Claude → 分析、大脑是 Claude，出图仍「未选择」", async (t) => {
  const deps = await makeAiDeps(t);
  const saved = await deps.handlers.get("ai-save-key")(trustedEvent, "claude", FAKE_CLAUDE_KEY);
  assert.deepEqual(saved, { ok: true, last4: "1234" });
  const state = await deps.handlers.get("ai-get-state")(trustedEvent);
  assert.deepEqual(state.slots, {
    analysis: { serviceId: "claude", model: "claude-haiku-5-5", summaryModel: "claude-sonnet-5-5" },
    brain: { serviceId: "claude", model: "claude-haiku-5-5" },
    image: { serviceId: "", model: "" },
  });
});

test("ai-test-connection：401 → 密钥不对（401）；Gemini 出图走原生入口、同一把密钥", async (t) => {
  const deps = await makeAiDeps(t);
  const handlers = deps.handlers;
  // 假 fetch 回 401，响应体故意带完整假密钥（真实 OpenAI 就这样），断言不外漏。
  const failingFetch = async () => fakeModelListResponse(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_OPENAI_KEY}.` } }));
  // 用带毒 401 的假 fetch 单独注册一套。
  const ipc2 = makeFakeIpcMain();
  const dir2 = await makeTempDir(t, "ai-ipc-401-");
  registerAiIpc({
    ipcMain: ipc2,
    trustedRendererEvent: trustByMarker,
    aiCredentialStore: createAiCredentialStore({ dir: dir2, encryption: createQaAiEncryptionStub() }),
    aiSettingsStore: createAiSettingsStore({ dir: dir2 }),
    desktopDataDir: dir2,
    aiOutboundFetch: failingFetch,
  });
  await ipc2.handlers.get("ai-save-key")(trustedEvent, "openai", FAKE_OPENAI_KEY);
  const result = await ipc2.handlers.get("ai-test-connection")(trustedEvent, "openai", "text");
  assert.equal(result.ok, false);
  assert.equal(result.code, "auth");
  assert.equal(result.message, "无法连接 OpenAI：密钥不对或没有权限（401）");
  assert.ok(!JSON.stringify(result).includes(FAKE_OPENAI_KEY), "失败返回值不能带响应体原文里的密钥");

  // Gemini：purpose "text" 走兼容入口（authorization Bearer），purpose "image"
  // 走原生入口（x-goog-api-key），同一把密钥。
  await handlers.get("ai-save-key")(trustedEvent, "gemini", FAKE_GEMINI_KEY);
  deps.fetchCalls.length = 0;
  await handlers.get("ai-test-connection")(trustedEvent, "gemini", "text");
  await handlers.get("ai-test-connection")(trustedEvent, "gemini", "image");
  assert.deepEqual(deps.fetchCalls.map((item) => item.url), [
    "https://generativelanguage.googleapis.com/v1beta/openai/models",
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
  ]);
  assert.equal(deps.fetchCalls[0].init.headers.authorization, `Bearer ${FAKE_GEMINI_KEY}`);
  assert.equal(deps.fetchCalls[1].init.headers["x-goog-api-key"], FAKE_GEMINI_KEY);
});

test("自定义地址校验：https 收、http 只收本机回环、带凭据/其它协议拒", async (t) => {
  const deps = await makeAiDeps(t);
  const handlers = deps.handlers;
  // 界面每次发全量列表（已有 + 新增）；校验不过的条目被丢、已有的保留。
  const sent = [];
  const update = (url) => {
    sent.push({ label: "本地", format: "openai", baseUrl: url });
    return handlers.get("ai-update-settings")(trustedEvent, { customServices: [...sent] });
  };
  const keptUrls = async () => (await handlers.get("ai-get-state")(trustedEvent)).services.filter((service) => service.id.startsWith("custom-")).map((service) => service.baseUrl);

  assert.equal((await update("https://x.example/v1")).ok, true);
  assert.deepEqual(await keptUrls(), ["https://x.example/v1"], "https://x.example/v1 收");
  assert.equal((await update("http://127.0.0.1:1234/v1")).ok, true);
  assert.equal((await update("http://localhost:8080")).ok, true);
  assert.equal((await update("http://[::1]:9000/v1")).ok, true);
  assert.deepEqual(await keptUrls(), ["https://x.example/v1", "http://127.0.0.1:1234/v1", "http://localhost:8080", "http://[::1]:9000/v1"]);

  for (const url of ["http://x.example", "http://user:pw@127.0.0.1", "file:///", "javascript:alert(1)", "ftp://x.example", "not a url"]) {
    const before = await keptUrls();
    await update(url);
    assert.deepEqual(await keptUrls(), before, `${url} 必须被拒收`);
  }
});

test("删掉自定义服务：密钥一起删，用到它的槽位退回「未选择」", async (t) => {
  const deps = await makeAiDeps(t);
  const handlers = deps.handlers;
  const added = await handlers.get("ai-update-settings")(trustedEvent, {
    customServices: [{ label: "本地", format: "openai", baseUrl: "http://127.0.0.1:1234/v1" }],
  });
  assert.equal(added.ok, true);
  const customId = added.state.services.find((service) => service.id.startsWith("custom-")).id;
  assert.match(customId, /^custom-[0-9a-f]{8}$/);

  await handlers.get("ai-save-key")(trustedEvent, customId, FAKE_CUSTOM_KEY);
  await handlers.get("ai-update-settings")(trustedEvent, {
    slots: { analysis: { serviceId: customId, model: "extra-model", summaryModel: "" } },
  });
  const credentialPath = join(deps.dir, "ai-credentials.json");
  assert.ok(readFileSync(credentialPath, "utf8").includes(customId), "密钥已落盘");

  const removed = await handlers.get("ai-update-settings")(trustedEvent, { customServices: [] });
  assert.equal(removed.ok, true);
  assert.equal(removed.state.services.some((service) => service.id === customId), false, "服务列表里没了");
  assert.ok(!readFileSync(credentialPath, "utf8").includes(customId), "密钥连着一起删了");
  assert.deepEqual(removed.state.slots.analysis, { serviceId: "", model: "", summaryModel: "" }, "用到它的块退回未选择");
  assert.ok(!JSON.stringify(removed).includes(FAKE_CUSTOM_KEY));
});

test("ai-get-state 的单价行：分析和汇总两行单价 + 本月合计，出图/大脑一行带本月", async (t) => {
  const deps = await makeAiDeps(t);
  const handlers = deps.handlers;
  await handlers.get("ai-save-key")(trustedEvent, "openai", FAKE_OPENAI_KEY);
  const state = await handlers.get("ai-get-state")(trustedEvent);
  assert.equal(state.priceLines.analysis.length, 3);
  assert.deepEqual(state.priceLines.analysis[0], {
    template: "单价 输入 {input} · 输出 {output}（每百万 token）",
    params: { input: "$0.05", output: "$0.40" },
  });
  assert.deepEqual(state.priceLines.analysis[1], {
    template: "单价 输入 {input} · 输出 {output}（每百万 token）",
    params: { input: "$0.25", output: "$2.00" },
  });
  assert.deepEqual(state.priceLines.analysis[2], { template: "本月合计 {month}", params: { month: "$0.00" } });
  assert.deepEqual(state.priceLines.brain, [{
    template: "单价 输入 {input} · 输出 {output}（每百万 token）· 本月 {month}",
    params: { input: "$0.25", output: "$2.00", month: "$0.00" },
  }]);
  assert.deepEqual(state.priceLines.image, [{
    template: "单价 图像输出 {output}（每百万 token）· 本月 {month}",
    params: { output: "$30.00", month: "$0.00" },
  }]);
  assert.deepEqual(state.monthTotals, { analysis: 0, brain: 0, image: 0 });
  // 没选服务的槽位一行「单价未知 · 本月 $0.00」。
  await handlers.get("ai-update-settings")(trustedEvent, { slots: { image: { serviceId: "", model: "" } } });
  const state2 = await handlers.get("ai-get-state")(trustedEvent);
  assert.deepEqual(state2.priceLines.image, [{ template: "单价未知 · 本月 {month}", params: { month: "$0.00" } }]);
});

test("ai-update-settings 逐项校验：不认识的字段丢掉，越界的模型/服务拒收", async (t) => {
  const deps = await makeAiDeps(t);
  const handlers = deps.handlers;
  await handlers.get("ai-save-key")(trustedEvent, "openai", FAKE_OPENAI_KEY);

  // 出图块选 Claude（不能出图）→ 该项丢弃，保留原值。
  const result = await handlers.get("ai-update-settings")(trustedEvent, {
    slots: { image: { serviceId: "claude", model: "claude-haiku-5-5" } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.state.slots.image.serviceId, "openai");

  // 模型不属于这个服务的家族 → 丢弃，保留原值。
  const result2 = await handlers.get("ai-update-settings")(trustedEvent, {
    slots: { analysis: { model: "claude-haiku-5-5" } },
  });
  assert.equal(result2.state.slots.analysis.model, "gpt-5-nano");

  // 未知字段直接丢掉，不进文件。
  const result3 = await handlers.get("ai-update-settings")(trustedEvent, {
    slots: { brain: { serviceId: "openai", model: "gpt-5-mini", apiKey: FAKE_OPENAI_KEY, rogue: true } },
  });
  assert.equal(result3.ok, true);
  const stored = JSON.parse(readFileSync(join(deps.dir, "ai-settings.json"), "utf8"));
  assert.ok(!JSON.stringify(stored).includes("apiKey"), "不认识的字段不能落盘");
  assert.ok(!JSON.stringify(stored).includes(FAKE_OPENAI_KEY), "设置文件里不能有密钥");
});
