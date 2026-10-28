import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";

// JSON-RPC 2.0: a notification (a request without `id`) must never be answered.
// MCP clients send notifications/initialized right after initialize; the server
// used to reply with an id-less "Method not found" error.
test("MCP stays silent on notifications and keeps answering requests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-mcp-notify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  // The MCP server never creates a library, so seed one before starting it.
  const seedStore = createAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
    explicitLibraryDir: libraryDir,
    assetsRoot: join(libraryDir, "assets"),
    generatedImagesDir: join(libraryDir, "imports"),
  });
  seedStore.close();
  const server = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: join(root, "library"),
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
  });

  const lines = [];
  let buffer = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      lines.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const send = (message) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const waitFor = async (id) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = lines.find((line) => line.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no response for id ${id}`);
  };

  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  await waitFor(1);
  send({ method: "notifications/initialized" });
  send({ method: "notifications/cancelled", params: { requestId: 1 } });
  send({ id: 2, method: "ping" });
  // Responses are written in order, so once ping is answered nothing for the
  // notifications can still be pending.
  assert.deepEqual((await waitFor(2)).result, {});
  assert.deepEqual(lines.map((line) => line.id), [1, 2], "only the two requests are answered");

  send({ id: 3, method: "no/such/method" });
  assert.equal((await waitFor(3)).error.code, -32601, "unknown request methods still get Method not found");
});
