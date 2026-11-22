// 任务 458：密钥隔离——扫真文件文本，保证密钥只活在 desktop/ai/ 主进程模块里：
// 服务进程（server.mjs、lib/）、MCP、后台收图进程、扩展、web 渲染层都摸不到。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = new Set([".mjs", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".json", ".md", ".html", ".css", ".yml", ".yaml", ".svg", ".sh"]);

async function loadTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files"], { cwd: new URL("..", import.meta.url).pathname });
  const files = new Map();
  for (const path of stdout.split("\n").filter(Boolean)) {
    if (!TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) continue;
    files.set(path, await readFile(new URL(`../${path}`, import.meta.url).pathname, "utf8"));
  }
  return files;
}

test("lib/、server.mjs、mcp/、packages/、extensions/、web/ 里没有任何文件 import desktop/ai/ 或出现 ai-credentials.json", async () => {
  const files = await loadTrackedFiles();
  const scopes = ["lib/", "mcp/", "packages/", "extensions/", "web/"];
  let checked = 0;
  for (const [path, text] of files) {
    const inScope = scopes.some((prefix) => path.startsWith(prefix)) || path === "server.mjs";
    if (!inScope) continue;
    checked += 1;
    assert.ok(!text.includes("desktop/ai/"), `${path} 不得引用 desktop/ai/`);
    assert.ok(!text.includes("credential-store"), `${path} 不得引用 credential-store`);
    assert.ok(!text.includes("ai-credentials.json"), `${path} 不得出现 ai-credentials.json`);
    assert.ok(!text.includes("readForRequest"), `${path} 不得出现 readForRequest`);
  }
  assert.ok(checked > 100, `扫描范围太小（${checked} 个文件），名单可能失效`);
});

test("lib/api/ 没有新路由提到 ai-（密钥不进任何 HTTP 路由）", async () => {
  const files = await loadTrackedFiles();
  for (const [path, text] of files) {
    if (!path.startsWith("lib/api/")) continue;
    assert.ok(!/["'`]\/?ai-/i.test(text), `${path} 不得出现 ai- 路由`);
    assert.ok(!text.includes("credential-store"), `${path} 不得引用 credential-store`);
    assert.ok(!text.includes("ai-credentials"), `${path} 不得出现 ai-credentials`);
  }
});

test("desktop/ai/credential-store.mjs 的保存目录是传进来的 userData，不是素材库目录", async () => {
  const files = await loadTrackedFiles();
  const source = files.get("desktop/ai/credential-store.mjs");
  assert.ok(source, "desktop/ai/credential-store.mjs 必须存在");
  assert.ok(source.includes("createAiCredentialStore({ dir, encryption })"), "目录来自参数 dir");
  assert.ok(!source.includes("MOSA_LIBRARY_DIR"), "不得读 MOSA_LIBRARY_DIR");
  assert.ok(!source.includes("libraryDir"), "不得出现素材库目录概念");
  // 行为面：desktop/ipc/ai.mjs 只把 desktopDataDir 传给三个存储。
  const ipcSource = files.get("desktop/ipc/ai.mjs");
  assert.ok(ipcSource.includes("desktopDataDir"), "IPC 层把 desktopDataDir 传进来");
  assert.ok(!ipcSource.includes("libraryDir"), "IPC 层不得接触素材库目录");
  const mainSource = files.get("desktop/main.mjs");
  assert.ok(mainSource.includes("createAiCredentialStore({\n    dir: desktopDataDir,"), "main.mjs 传的是 desktopDataDir（userData）");
});
