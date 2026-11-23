// 任务 458：AI 测试连接的纯函数行为测试。全部用假响应/假异常，不发任何真实
// 网络请求；假密钥一律 sk-test- / AIzaTEST 开头，失败响应体里故意放进完整假
// 密钥，断言它一个字都不出现在返回值和 console 里。
import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_CONNECTION_SUCCESS_TEMPLATE,
  buildConnectionTestRequest,
  classifyConnectionTestError,
  describeConnectionFailure,
  parseConnectionTestResponse,
  readConnectionTestBody,
} from "../lib/ai/connection-test.mjs";
import { aiPresetServiceById } from "../lib/ai/model-catalog.mjs";

const FAKE_CLAUDE_KEY = `sk-test-${"0".repeat(30)}1234`;
const FAKE_GEMINI_KEY = `AIzaTEST${"0".repeat(30)}5678`;
const FAKE_OPENAI_KEY = `sk-test-${"0".repeat(30)}4321`;

// 接管 console，记录所有调用，测完还原。
function withSilentConsole(run) {
  const original = { warn: console.warn, error: console.error, info: console.info, log: console.log };
  const calls = [];
  const record = (level) => (...args) => calls.push({ level, args });
  console.warn = record("warn");
  console.error = record("error");
  console.info = record("info");
  console.log = record("log");
  try {
    return { result: run(), calls };
  } finally {
    console.warn = original.warn;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
  }
}

test("请求形状：五种服务各一条，method/redirect/credentials 固定、没有请求体", () => {
  const cases = [
    {
      service: aiPresetServiceById("claude"),
      key: FAKE_CLAUDE_KEY,
      url: "https://api.anthropic.com/v1/models?limit=1000",
      headerName: "x-api-key",
      headerValue: FAKE_CLAUDE_KEY,
      extraHeaders: { "anthropic-version": "2023-06-01" },
    },
    {
      service: aiPresetServiceById("openai"),
      key: FAKE_OPENAI_KEY,
      url: "https://api.openai.com/v1/models",
      headerName: "authorization",
      headerValue: `Bearer ${FAKE_OPENAI_KEY}`,
    },
    {
      service: aiPresetServiceById("gemini"),
      key: FAKE_GEMINI_KEY,
      purpose: "text",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/models",
      headerName: "authorization",
      headerValue: `Bearer ${FAKE_GEMINI_KEY}`,
    },
    {
      service: aiPresetServiceById("gemini"),
      key: FAKE_GEMINI_KEY,
      purpose: "image",
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      headerName: "x-goog-api-key",
      headerValue: FAKE_GEMINI_KEY,
    },
    {
      service: aiPresetServiceById("ollama"),
      key: "",
      url: "http://127.0.0.1:11434/api/tags",
      headerName: null,
    },
    {
      service: { id: "custom-00112233", label: "本地", format: "openai", baseUrl: "http://127.0.0.1:1234/v1" },
      key: FAKE_OPENAI_KEY,
      url: "http://127.0.0.1:1234/v1/models",
      headerName: "authorization",
      headerValue: `Bearer ${FAKE_OPENAI_KEY}`,
    },
    {
      service: { id: "custom-44556677", label: "代理", format: "claude", baseUrl: "https://x.example" },
      key: FAKE_CLAUDE_KEY,
      url: "https://x.example/v1/models",
      headerName: "x-api-key",
      headerValue: FAKE_CLAUDE_KEY,
    },
  ];
  for (const item of cases) {
    const { url, init } = buildConnectionTestRequest(item.service, item.key, item.purpose);
    assert.equal(url, item.url, JSON.stringify(item.service));
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error", "带密钥的请求不许跟随跳转");
    assert.equal(init.credentials, "omit");
    assert.equal(init.body, undefined, "GET 没有请求体");
    assert.ok(init.signal instanceof AbortSignal, "10 秒超时用 AbortSignal");
    if (item.headerName === null) {
      assert.deepEqual(init.headers, {}, "Ollama 不带鉴权头");
    } else {
      assert.equal(init.headers[item.headerName], item.headerValue);
      for (const [name, value] of Object.entries(item.extraHeaders || {})) {
        assert.equal(init.headers[name], value);
      }
    }
  }
  // Gemini 一把密钥两处用：text / image 走两个不同地址、密钥同一个头一个样。
  const gemini = aiPresetServiceById("gemini");
  const text = buildConnectionTestRequest(gemini, FAKE_GEMINI_KEY, "text");
  const image = buildConnectionTestRequest(gemini, FAKE_GEMINI_KEY, "image");
  assert.notEqual(text.url, image.url);
  assert.equal(text.init.headers.authorization, `Bearer ${FAKE_GEMINI_KEY}`);
  assert.equal(image.init.headers["x-goog-api-key"], FAKE_GEMINI_KEY);
});

test("成功解析：OpenAI data[].id、Ollama/Gemini 原生 models[].name、models/ 前缀去掉", () => {
  const openai = parseConnectionTestResponse(aiPresetServiceById("openai"), 200, JSON.stringify({ data: [{ id: "gpt-5-nano" }, { id: "gpt-image-2" }] }));
  assert.deepEqual(openai, { ok: true, code: "ok", models: ["gpt-5-nano", "gpt-image-2"], status: 200 });

  const ollama = parseConnectionTestResponse(aiPresetServiceById("ollama"), 200, JSON.stringify({ models: [{ name: "qwen3:8b" }] }));
  assert.deepEqual(ollama, { ok: true, code: "ok", models: ["qwen3:8b"], status: 200 });

  const geminiNative = parseConnectionTestResponse(aiPresetServiceById("gemini"), 200, JSON.stringify({ models: [{ name: "models/gemini-3.5-flash-lite" }] }));
  assert.deepEqual(geminiNative, { ok: true, code: "ok", models: ["gemini-3.5-flash-lite"], status: 200 });

  const geminiCompat = parseConnectionTestResponse(aiPresetServiceById("gemini"), 200, JSON.stringify({ data: [{ id: "models/gemini-2.5-flash-lite" }] }));
  assert.deepEqual(geminiCompat.models, ["gemini-2.5-flash-lite"]);

  const claude = parseConnectionTestResponse(aiPresetServiceById("claude"), 200, JSON.stringify({ data: [{ id: "claude-haiku-5-5" }] }));
  assert.deepEqual(claude.models, ["claude-haiku-5-5"]);
});

test("失败归类：状态码 → code，乱码 → bad-response", () => {
  const service = aiPresetServiceById("openai");
  for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "not-found"], [429, "rate-limit"], [503, "server"], [400, "bad-response"]]) {
    const parsed = parseConnectionTestResponse(service, status, JSON.stringify({ error: { message: "nope" } }));
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, code, String(status));
    assert.deepEqual(parsed.models, []);
  }
  assert.equal(parseConnectionTestResponse(service, 200, "这不是 JSON").code, "bad-response");
  assert.equal(parseConnectionTestResponse(service, 200, JSON.stringify({ unexpected: true })).code, "bad-response");
  assert.equal(parseConnectionTestResponse(service, 200, "null").code, "bad-response");
});

test("失败文案：code + 状态码 → 中文，{服务} 填显示名", () => {
  const cases = [
    [{ code: "auth", status: 401 }, "Claude", "无法连接 Claude：密钥不对或没有权限（401）"],
    [{ code: "auth", status: 403 }, "Claude", "无法连接 Claude：密钥不对或没有权限（403）"],
    [{ code: "not-found", status: 404 }, "OpenAI", "无法连接 OpenAI：地址不对（404）"],
    [{ code: "rate-limit", status: 429 }, "Gemini", "无法连接 Gemini：请求太多或额度已用完（429）"],
    [{ code: "server", status: 503 }, "本地", "无法连接 本地：服务暂时出错（503）"],
    [{ code: "redirect" }, "Claude", "无法连接 Claude：地址发生了跳转，为保护密钥已停止"],
    [{ code: "timeout" }, "OpenAI", "无法连接 OpenAI：10 秒内没有回应"],
    [{ code: "network" }, "Gemini", "无法连接 Gemini：连不上服务器，检查网络或代理"],
    [{ code: "bad-response" }, "本地", "无法连接 本地：返回的内容看不懂"],
    [{ code: "ollama-not-running" }, "本机 Ollama", "本机没有在运行 Ollama"],
  ];
  for (const [failure, label, message] of cases) {
    const described = describeConnectionFailure(label, failure);
    assert.equal(described.message, message, JSON.stringify(failure));
    assert.equal(described.code, failure.code);
    assert.equal(described.template.includes("{service}") || failure.code === "ollama-not-running", true);
  }
});

test("401 的假响应体里放进完整假密钥：返回值和 console 里都没有它", () => {
  // 单子要求：服务返回的原文一个字都不许显示、不许记日志（OpenAI 的 401 原文
  // 里会带半截密钥）。
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_OPENAI_KEY}. ` } });
  const { result, calls } = withSilentConsole(() => {
    const parsed = parseConnectionTestResponse(aiPresetServiceById("openai"), 401, body);
    const described = describeConnectionFailure("OpenAI", parsed);
    return { parsed, described, serialized: JSON.stringify([parsed, described]) };
  });
  assert.ok(!result.serialized.includes(FAKE_OPENAI_KEY), "返回值序列化后不能有完整密钥");
  assert.ok(!result.serialized.includes(FAKE_OPENAI_KEY.slice("sk-test-".length)), "去前缀后的串也不能有");
  assert.deepEqual(calls, [], "console 里不能有任何输出");
});

test("fetch 异常归类：跳转、超时、连不上、Ollama 连不上", () => {
  const service = aiPresetServiceById("openai");
  const redirectError = Object.assign(new TypeError("fetch failed"), { cause: new TypeError("redirect mode: error") });
  assert.equal(classifyConnectionTestError(service, redirectError).code, "redirect");
  assert.equal(classifyConnectionTestError(service, new Error("URL scheme redirect detected")).code, "redirect");
  assert.equal(classifyConnectionTestError(service, Object.assign(new Error(""), { name: "TimeoutError" })).code, "timeout");
  assert.equal(classifyConnectionTestError(service, Object.assign(new Error(""), { name: "AbortError" })).code, "timeout");
  assert.equal(classifyConnectionTestError(service, new TypeError("getaddrinfo ENOTFOUND api.openai.com")).code, "network");
  assert.equal(classifyConnectionTestError(service, new TypeError("connect ECONNREFUSED 127.0.0.1:1")).code, "network");
  const ollama = aiPresetServiceById("ollama");
  assert.equal(classifyConnectionTestError(ollama, new TypeError("connect ECONNREFUSED 127.0.0.1:11434")).code, "ollama-not-running");
  assert.equal(classifyConnectionTestError(ollama, Object.assign(new Error(""), { name: "TimeoutError" })).code, "timeout");
});

test("响应体最多读 2 MB：超限返回 null，正常小响应原样读出", async () => {
  const bigBody = "x".repeat(2 * 1024 * 1024 + 1);
  const bigResponse = new Response(bigBody);
  assert.equal(await readConnectionTestBody(bigResponse), null, "超 2 MB 的响应体不读");
  const okResponse = new Response(JSON.stringify({ data: [{ id: "gpt-5-nano" }] }));
  assert.equal(await readConnectionTestBody(okResponse), JSON.stringify({ data: [{ id: "gpt-5-nano" }] }));
  // 成功模板键（界面翻译用的）。
  assert.equal(AI_CONNECTION_SUCCESS_TEMPLATE, "连接正常 · 可用 {count} 个模型");
});
