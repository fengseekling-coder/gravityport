// Task 381: keep packages/gravityport-mcp/tools.json in sync with the real
// mcp/server.mjs. The launcher package ships that snapshot so its no-app
// fallback can list the same tools without a library; when a tool definition
// changes, npm test fails here until the snapshot is regenerated with
// npm run mcp-launcher:tools.
//
// The live tools/list comes from a real mcp/server.mjs started with a
// throwaway HOME (no library): a missing library does not stop tools/list
// (task 362), and nothing is created anywhere.
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { removeTestPath } from "./test-cleanup.mjs";

test("mcp-launcher tools.json snapshot matches the live mcp/server.mjs tools/list", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "mosa-mcp-launcher-snapshot-"));
  const server = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await removeTestPath(home, { recursive: true, force: true });
  });

  const initialized = await callMcp(server, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-launcher-snapshot-test", version: "0.0.0" } },
  });
  assert.equal(initialized.result.serverInfo.name, "GravityPort MCP");

  const listed = await callMcp(server, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const liveTools = listed.result.tools;
  const snapshotPath = join(process.cwd(), "packages", "gravityport-mcp", "tools.json");
  const snapshotTools = JSON.parse(await readFile(snapshotPath, "utf8"));
  assert.deepEqual(
    liveTools,
    snapshotTools,
    "mcp-launcher 快照过期：运行 npm run mcp-launcher:tools 更新快照 / stale mcp-launcher snapshot: run npm run mcp-launcher:tools to update the snapshot",
  );
});

function callMcp(server, request) {
  return new Promise((resolveResponse, rejectResponse) => {
    let buffer = "";
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for the MOSA MCP response.")), 5000);
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        if (response.id === request.id) {
          finish(null, response);
          return;
        }
      }
    };
    const onExit = () => finish(new Error("MOSA MCP exited before responding."));
    const finish = (error, response) => {
      clearTimeout(timeout);
      server.stdout.off("data", onData);
      server.off("exit", onExit);
      if (error) rejectResponse(error);
      else resolveResponse(response);
    };
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", onData);
    server.once("exit", onExit);
    server.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
