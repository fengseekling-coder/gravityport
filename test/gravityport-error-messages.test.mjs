import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";

import { extractI18nKeys } from "../scripts/check-i18n-keys.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const srcRoot = join(repositoryRoot, "web", "gravityport", "src");

let errorMessagesModule;
let mosaApiModule;
let tempTscDir;

before(async () => {
  tempTscDir = await mkdtemp(join(tmpdir(), "mosa-gp-err-msg-"));
  const sources = [
    join(srcRoot, "vite-env.d.ts"),
    join(srcRoot, "error-messages.ts"),
    join(srcRoot, "mosa-api.ts"),
  ];
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    ...sources, "--outDir", tempTscDir, "--module", "esnext", "--target", "es2022",
    "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  errorMessagesModule = await import(join(tempTscDir, "error-messages.js"));
  mosaApiModule = await import(join(tempTscDir, "mosa-api.js"));
});

after(async () => {
  if (tempTscDir) {
    await rm(tempTscDir, { recursive: true, force: true });
  }
});

const REQUIRED_CODES = [
  "ASSET_ALREADY_STACKED",
  "STACK_NOT_FOUND",
  "STACK_ASSET_ARCHIVED",
  "STACK_NEEDS_MULTIPLE_ASSETS",
  "STACK_COVER_NOT_MEMBER",
  "STACK_NAME_EMPTY",
  "STACK_ORDER_MISMATCH",
  "STACK_MOVE_BATCH_SIZE_INVALID",
  "ASSET_STACKS_UNAVAILABLE",
  "ASSET_NOT_FOUND",
];

test("every required error code returns a non-empty Chinese message", () => {
  for (const code of REQUIRED_CODES) {
    const message = errorMessagesModule.messageForErrorCode(code);
    assert.ok(typeof message === "string" && message.length > 0, `code ${code} returned empty message`);
    // Ensure it contains Chinese characters
    assert.match(message, /[\u4e00-\u9fa5]/, `code ${code} should return Chinese text`);
  }
});

test("unknown error code returns empty string", () => {
  assert.equal(errorMessagesModule.messageForErrorCode("UNKNOWN_ERROR_CODE"), "");
  assert.equal(errorMessagesModule.messageForErrorCode(""), "");
  assert.equal(errorMessagesModule.messageForErrorCode(null), "");
  assert.equal(errorMessagesModule.messageForErrorCode(undefined), "");
});

// 任务 359：错误码文案中英两份都在 error-messages.ts，不再靠 i18n 键二次翻译。
test("each error code carries both a zh and an en sentence", () => {
  for (const code of REQUIRED_CODES) {
    const zh = errorMessagesModule.messageForErrorCode(code, "zh");
    const en = errorMessagesModule.messageForErrorCode(code, "en");
    assert.ok(zh, `code ${code} must map to a Chinese sentence`);
    assert.ok(en, `code ${code} must map to an English sentence`);
    assert.notEqual(zh, en, `code ${code} must not reuse the Chinese sentence as English`);
  }
});

test("failureMessage in mosa-api maps recognized error codes to Chinese and falls back to error.message", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // 1. Error with code: "ASSET_ALREADY_STACKED"
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: "ASSET_ALREADY_STACKED",
      error: "Asset already in another stack",
    }), { status: 400, headers: { "content-type": "application/json" } });

    const outcomeStacked = await mosaApiModule.moveAssetsToStack("default", ["a1"], "target-stack");
    assert.equal(
      outcomeStacked.firstError,
      "无法堆叠素材。素材已在其他堆叠中，列表已刷新，请重试。",
      "ASSET_ALREADY_STACKED code must map to localized Chinese message"
    );

    // 2. Unknown error code falls back to error.message
    globalThis.fetch = async () => new Response(JSON.stringify({
      code: "UNKNOWN_UNRECOGNIZED_CODE",
      error: "Raw server failure message",
    }), { status: 400, headers: { "content-type": "application/json" } });

    const outcomeFallback = await mosaApiModule.moveAssetsToStack("default", ["a1"], "target-stack");
    // 任务 359：未识别的码走 {detail} 兜底，原文进括号。
    assert.equal(
      outcomeFallback.firstError,
      "无法完成操作（UNKNOWN_UNRECOGNIZED_CODE）",
      "Unrecognized code must fall back to the unknown sentence with the code as detail"
    );

    // 3. Other required error codes map to their Chinese message as well
    for (const code of REQUIRED_CODES) {
      globalThis.fetch = async () => new Response(JSON.stringify({
        code,
        error: `Raw error for ${code}`,
      }), { status: 400, headers: { "content-type": "application/json" } });

      const outcome = await mosaApiModule.moveAssetsToStack("default", ["a1"], "target-stack");
      const expectedMessage = errorMessagesModule.messageForErrorCode(code);
      assert.equal(outcome.firstError, expectedMessage, `Error code ${code} must map to ${expectedMessage}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describeError is the shared path for App.tsx and mosa-api: code first, then message", () => {
  const { describeError } = errorMessagesModule;
  const stacked = Object.assign(new Error("Asset already in another stack"), { code: "ASSET_ALREADY_STACKED" });
  assert.equal(describeError(stacked), "无法堆叠素材。素材已在其他堆叠中，列表已刷新，请重试。");
  assert.equal(describeError(stacked, "en"), "Couldn’t stack assets. An asset is already in another stack. The list was refreshed. Try again.");
  // 未识别的错误走 {detail} 兜底，原文放括号（规范：技术信息放句末括号）。
  const unknown = Object.assign(new Error("Raw server failure message"), { code: "UNKNOWN_UNRECOGNIZED_CODE" });
  // {detail} 取状态码或服务端 code（规范与审查表 ERR-UNKNOWN）。
  assert.equal(describeError(unknown), "无法完成操作（UNKNOWN_UNRECOGNIZED_CODE）");
  assert.equal(describeError(new Error("plain")), "无法完成操作（plain）");
  assert.equal(describeError("text"), "无法完成操作（text）");
  // 客户端错误码：HTTP_ERROR 带状态码、分组错误带名字。
  assert.equal(describeError(Object.assign(new Error("HTTP 502"), { code: "HTTP_ERROR", status: 502 })), "无法连接本地服务（HTTP 502）");
  assert.equal(describeError(Object.assign(new Error("Group already exists: 风景"), { code: "GROUP_ALREADY_EXISTS" })), "已有名为「风景」的分组。");
  for (const code of REQUIRED_CODES) {
    assert.equal(describeError({ code, message: "raw" }), errorMessagesModule.messageForErrorCode(code));
  }
});
