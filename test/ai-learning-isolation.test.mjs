// 任务 463：学习后台的隔离扫描（真文件，git ls-files）。SDK 只许在
// claude-client.mjs 出现；lib/、mcp/、web/、server.mjs 不许 import desktop/ai/；
// 学习路由不进扩展名单。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

import { isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = new Set([".mjs", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".json"]);

async function loadTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: new URL("..", import.meta.url).pathname });
  const files = new Map();
  for (const path of stdout.split("\n").filter(Boolean)) {
    if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) continue;
    files.set(path, await readFile(new URL(`../${path}`, import.meta.url).pathname, "utf8"));
  }
  return files;
}

test("@anthropic-ai/sdk 只在 desktop/ai/claude-client.mjs、package.json、package-lock.json 里出现", async () => {
  const files = await loadTrackedFiles();
  for (const [path, text] of files) {
    // 测试不进安装包：test/ai-claude-client.test.mjs 要用 SDK 的错误类核分类，
    // 本文件自己的测试名里也带着这个名字。只管产品代码。
    if (path.startsWith("test/")) continue;
    if (!text.includes("@anthropic-ai/sdk")) continue;
    assert.ok(
      path === "desktop/ai/claude-client.mjs" || path === "package.json" || path === "package-lock.json",
      `${path} 不得引用 @anthropic-ai/sdk（只有 claude-client.mjs 和两份清单可以）`,
    );
  }
  const client = files.get("desktop/ai/claude-client.mjs");
  assert.ok(client, "desktop/ai/claude-client.mjs 必须存在");
});

test("lib/、mcp/、web/、server.mjs 不 import desktop/ai/（沿用 458 的扫描）", async () => {
  const files = await loadTrackedFiles();
  const scopes = ["lib/", "mcp/", "packages/", "extensions/", "web/"];
  let checked = 0;
  for (const [path, text] of files) {
    const inScope = scopes.some((prefix) => path.startsWith(prefix)) || path === "server.mjs";
    if (!inScope) continue;
    checked += 1;
    assert.ok(!text.includes("desktop/ai/"), `${path} 不得引用 desktop/ai/`);
    assert.ok(!text.includes("readForRequest"), `${path} 不得出现 readForRequest`);
  }
  assert.ok(checked > 100, `扫描范围太小（${checked} 个文件），名单可能失效`);
});

test("claude-client.mjs 里钉住 authToken: null 和 redirect: \"error\"（环境变量不串、不带 cookie 的两道闸）", async () => {
  const files = await loadTrackedFiles();
  const client = files.get("desktop/ai/claude-client.mjs");
  assert.match(client, /authToken: null/);
  assert.match(client, /redirect: "error"/);
  assert.match(client, /credentials: "omit"/);
  assert.match(client, /baseURL/);
});

test("lib/api/learning-guide-routes.mjs 没有任何以 ai- 开头的路径", async () => {
  const files = await loadTrackedFiles();
  const routes = files.get("lib/api/learning-guide-routes.mjs");
  assert.ok(routes, "lib/api/learning-guide-routes.mjs 必须存在");
  assert.ok(!/["'`]\/?ai-/i.test(routes), "学习路由不得以 ai- 开头（密钥不进任何 HTTP 路由）");
});

test("13 条学习路由都不在扩展允许名单里", () => {
  const paths = [
    "/api/learning-libraries/ll_x/learning",
    "/api/learning-libraries/ll_x/learning/pending",
    "/api/learning-libraries/ll_x/learning/notes",
    "/api/learning-libraries/ll_x/runs",
    "/api/learning-runs/lr_x",
    "/api/learning-runs/lr_x/items/as_x/input",
    "/api/learning-runs/lr_x/items/as_x/result",
    "/api/learning-runs/lr_x/guide",
    "/api/learning-runs/lr_x/revert",
    "/api/learning-libraries/ll_x/guide/entries",
    "/api/learning-libraries/ll_x/guide/entries/lge_x",
  ];
  for (const path of paths) {
    assert.equal(isWebCaptureApiPath(path), false, `${path} must not be a web-capture path`);
  }
});
