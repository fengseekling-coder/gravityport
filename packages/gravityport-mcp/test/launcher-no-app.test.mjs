// Task 381: black-box test — spawn the real bin/gravityport-mcp.mjs with no
// GravityPort app anywhere it can see: GRAVITYPORT_APP_PATH points at a
// directory that does not exist, HOME and LOCALAPPDATA are empty temp dirs.
// The launcher must serve the fallback MCP server: initialize with the
// download URL, tools/list equal to tools.json (25 tools), and every tool
// call answered with the fixed bilingual install notice. Every stdout line
// must be valid JSON.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(packageRoot, "bin", "gravityport-mcp.mjs");
const toolsSnapshot = JSON.parse(readFileSync(join(packageRoot, "tools.json"), "utf8"));
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;

// Fixed notice wording, copied verbatim from the task order (not imported
// from the launcher) so a typo in the launcher fails this test.
const NOTICE_TEXT = [
  "使用 GravityPort MCP 需要先安装 GravityPort 桌面 App（macOS 和 Windows）。下载：https://gravityport.azhuilab.com/?ref=mcp 。安装后打开一次 App，再重启这个 AI 助手。如果 App 装在别的位置，请把环境变量 GRAVITYPORT_APP_PATH 设为 App 所在位置。",
  "GravityPort MCP needs the GravityPort desktop app (macOS and Windows). Download: https://gravityport.azhuilab.com/en/?ref=mcp . After installing, open the app once, then restart this AI assistant. If the app is installed somewhere else, set GRAVITYPORT_APP_PATH to its location.",
].join("\n");

test("launcher without the app answers with tools and the install notice", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "mosa-launcher-no-app-"));
  const launcher = spawn(process.execPath, [binPath], {
    env: {
      ...process.env,
      HOME: home,
      LOCALAPPDATA: home,
      GRAVITYPORT_APP_PATH: join(home, "not-installed", "GravityPort.app"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      const exited = once(launcher, "exit");
      launcher.kill("SIGTERM");
      await exited;
    }
    await rm(home, { recursive: true, force: true });
  });

  const rawLines = [];
  const pending = new Map();
  let lineBuffer = "";
  launcher.stdout.setEncoding("utf8");
  launcher.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      rawLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  const request = (payload) => new Promise((resolveRequest, rejectRequest) => {
    const timer = setTimeout(() => {
      pending.delete(payload.id);
      rejectRequest(new Error(`Timed out waiting for response id ${payload.id}.`));
    }, 5000);
    pending.set(payload.id, (message) => {
      clearTimeout(timer);
      resolveRequest(message);
    });
    launcher.stdin.write(`${JSON.stringify(payload)}\n`);
  });

  const initialize = await request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "launcher-test", version: "0.0.0" } },
  });
  assert.equal(initialize.result.serverInfo.name, "gravityport");
  assert.equal(initialize.result.serverInfo.version, packageVersion);
  assert.ok(
    initialize.result.instructions.includes("https://gravityport.azhuilab.com/en/?ref=mcp"),
    "initialize instructions carry the download URL",
  );

  const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.result.tools.length, 25);
  assert.deepEqual(listed.result.tools, toolsSnapshot);

  const call = await request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "asset_search", arguments: { query: "anything" } },
  });
  assert.equal(call.result.isError, true);
  assert.equal(call.result.content[0].text, NOTICE_TEXT);

  assert.equal(
    rawLines.filter((line) => {
      try {
        JSON.parse(line);
        return false;
      } catch {
        return true;
      }
    }).length,
    0,
    "every stdout line is valid JSON",
  );
});
