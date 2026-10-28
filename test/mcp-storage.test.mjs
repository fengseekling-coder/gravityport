import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  createMcpWorkspace,
  startMcpServer,
  waitForFile,
  waitForFileAbsent,
  writePngFixture,
} from "./helpers/mcp-server-harness.mjs";

const RUNTIME_LOCK_FILE = ".mosa-runtime.lock";

test("two MCP servers can interleave writes into the same SQLite library and read each other", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const first = startMcpServer(t, workspace);
  await first.request("initialize", { protocolVersion: "2025-11-25" });

  // Spawn the second server only after the first one finished initializing so
  // the fresh-library SQLite setup is already committed when it inspects the
  // database file.
  const second = startMcpServer(t, workspace);
  await second.request("initialize", { protocolVersion: "2025-11-25" });

  async function createOn(server, assetId, color) {
    const imagePath = await writePngFixture(join(workspace.imagesDir, `${assetId}.png`), { color });
    const created = await server.callToolStrict("asset_create", { assetId, imagePath, prompt: `prompt for ${assetId}` });
    assert.equal(created.structuredContent.asset.id, assetId);
  }

  // Strictly interleaved writes: the two servers take turns committing.
  await createOn(first, "a-one", "#101010");
  await createOn(second, "b-one", "#202020");
  await createOn(first, "a-two", "#303030");
  await createOn(second, "b-two", "#404040");

  // Then one genuinely simultaneous write per server.
  await Promise.all([
    createOn(first, "a-three", "#505050"),
    createOn(second, "b-three", "#606060"),
  ]);

  const expectedIds = ["a-one", "a-two", "a-three", "b-one", "b-two", "b-three"].sort();
  for (const server of [first, second]) {
    const list = await server.callToolStrict("asset_list", { projectId: "default", limit: 250 });
    assert.deepEqual(list.structuredContent.assets.map((asset) => asset.id).sort(), expectedIds);
    const crossRead = await server.callToolStrict("asset_get", { assetId: "b-one" });
    assert.equal(crossRead.structuredContent.asset.prompt, "prompt for b-one");
  }
});

test("JSON storage grants an exclusive runtime lock and hands it to the next server on exit", async (t) => {
  const workspace = await createMcpWorkspace(t, { jsonLibrary: true });
  // createMcpWorkspace({ jsonLibrary: true }) seeds a genuine legacy JSON
  // library (per-asset metadata files, no mosa.db) — the condition
  // createAssetStore requires to pick the JSON backend instead of SQLite.

  const lockPath = join(workspace.libraryDir, RUNTIME_LOCK_FILE);
  const first = startMcpServer(t, workspace);
  await first.request("initialize", { protocolVersion: "2025-11-25" });
  await waitForFile(lockPath);
  const solo = await first.callToolStrict("asset_create", {
    assetId: "solo-asset",
    imagePath: await writePngFixture(join(workspace.imagesDir, "solo.png")),
    prompt: "created while holding the lock",
  });
  assert.equal(solo.structuredContent.asset.id, "solo-asset");

  // While the first server holds the lease, a second MCP server must fail
  // closed instead of racing the JSON store.
  const second = startMcpServer(t, workspace);
  const secondExit = await second.waitForExit();
  assert.equal(secondExit.code, 1, `the second server exits non-zero (stderr: ${second.stderr.slice(-500)})`);
  assert.match(second.stderr, /GravityPort runtime already active/);

  // The first server is unaffected by the failed takeover attempt.
  assert.deepEqual((await first.request("ping")).result, {});

  // SIGTERM releases the lock (exit code 0), and the next server can take over
  // and read what the previous one wrote.
  const firstExitPromise = first.waitForExit();
  first.child.kill("SIGTERM");
  const firstExit = await firstExitPromise;
  assert.equal(firstExit.code, 0);
  assert.equal(firstExit.signal, null);
  await waitForFileAbsent(lockPath);

  const third = startMcpServer(t, workspace);
  await third.request("initialize", { protocolVersion: "2025-11-25" });
  const list = await third.callToolStrict("asset_list", { projectId: "default" });
  // The seeded legacy fixture asset is part of the JSON library the third
  // server took over, next to what the first server wrote.
  assert.deepEqual(list.structuredContent.assets.map((asset) => asset.id).sort(), ["legacy-asset", "solo-asset"]);
});

test("the MCP server exits on its own when stdin closes", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  assert.deepEqual((await server.request("ping")).result, {});

  const exitPromise = server.waitForExit();
  server.child.stdin.end();
  const exit = await exitPromise;
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
});

test("the MCP server exits with code 0 on SIGTERM", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  assert.deepEqual((await server.request("ping")).result, {});

  const exitPromise = server.waitForExit();
  server.child.kill("SIGTERM");
  const exit = await exitPromise;
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
});
