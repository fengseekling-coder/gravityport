// Task 385 — the MCP side of the viewer confirmation: when the user is
// viewing the exact asset in the App, asset_trash files a delete request into
// the shared .live/ directory and waits for the App's answer (progress
// notifications keep a tokened client alive). Everything else trashes exactly
// as before. Real server process, real runtime service, real files.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createLiveDeletionRequests } from "../lib/live-deletion-requests.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";

async function setup(t, { timeoutMs = "1500" } = {}) {
  const workspace = await createMcpWorkspace(t);
  const imagePath = await writePngFixture(join(workspace.imagesDir, "confirm.png"), { color: "#243047" });
  const server = startMcpServer(t, workspace, {
    env: { MOSA_QA_RUN: "1", MOSA_DELETE_CONFIRM_TIMEOUT_MS: timeoutMs },
  });
  // The App side: a real runtime service whose viewer reports into the same
  // library's .live/ directory (the presence route names the service pid).
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: workspace.root,
    libraryDir: workspace.libraryDir,
    assetsRoot: join(workspace.libraryDir, "assets"),
    generatedImagesDir: workspace.imagesDir,
  });
  t.after(() => runtime.stop());
  const live = createLiveDeletionRequests({ libraryDir: workspace.libraryDir });
  const authedPost = (path, body) => fetch(`${runtime.url}${path}`, {
    method: "POST",
    headers: {
      "x-mosa-client-token": runtime.clientToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
  return { workspace, imagePath, server, runtime, live, authedPost };
}

test("the viewer-showing asset is asked about: allowed lands in the trash with the requester named", async (t) => {
  const { workspace, imagePath, server, live, authedPost } = await setup(t);
  const client = await server.request("initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "claude-ai", version: "1.0.0" },
  });
  assert.equal(client.result.serverInfo.name, "GravityPort MCP");

  await server.callToolStrict("asset_create", { assetId: "watched", imagePath });
  const presence = await authedPost("/api/viewer-presence", { projectId: "default", assetId: "watched" });
  assert.equal(presence.status, 200, "the real presence route recorded the viewer");

  const call = server.callTool("asset_trash", { assetId: "watched" });
  // The request file appears with the sanitized display name.
  const filed = await live.listPendingRequests();
  let request = filed[0] || null;
  for (let waited = 0; waited < 3000 && !request; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    request = (await live.listPendingRequests())[0] || null;
  }
  assert.ok(request, "the delete request was filed");
  assert.equal(request.requester.kind, "mcp");
  assert.equal(request.requester.name, "Claude", "claude-ai displays as Claude");
  assert.equal(request.projectId, "default");
  assert.equal(request.assetId, "watched");

  await live.writeDecision(request.id, "allowed");
  const result = await call;
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.asset_id, "watched");
  assert.equal(result.structuredContent.trashed, true);
  assert.match(result.content[0].text, /已移到回收站，可恢复，90 天后自动清除。\/ Moved to Trash; restorable for 90 days\./);

  // The requester removes the request file it created once it holds the result.
  let gone = false;
  for (let waited = 0; waited < 3000 && !gone; waited += 100) {
    gone = !(await live.readRequest(request.id));
    if (!gone) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(gone, true, "the MCP server deleted its own request file");
});

test("denied answers isError with reason user_denied and the asset stays", async (t) => {
  const { imagePath, server, live, authedPost } = await setup(t);
  await server.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "codex" } });
  await server.callToolStrict("asset_create", { assetId: "kept", imagePath });
  await authedPost("/api/viewer-presence", { projectId: "default", assetId: "kept" });

  const call = server.callTool("asset_trash", { assetId: "kept" });
  let request = null;
  for (let waited = 0; waited < 3000 && !request; waited += 100) {
    request = (await live.listPendingRequests())[0] || null;
    if (!request) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(request, "the delete request was filed");
  assert.equal(request.requester.name, "Codex", "codex displays as Codex");
  await live.writeDecision(request.id, "denied");

  const result = await call;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, "user_denied");
  assert.equal(result.structuredContent.trashed, false);
  assert.match(result.content[0].text, /用户拒绝了这次删除，素材没有动。\/ The user declined this deletion; the asset was not changed\./);
  const asset = await server.callToolStrict("asset_get", { assetId: "kept" });
  assert.ok(asset.structuredContent.asset, "the denied asset still exists");
});

test("no answer inside the window: user_no_response, the asset stays, and the request file is removed", async (t) => {
  const { imagePath, server, live, authedPost } = await setup(t);
  await server.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "cursor" } });
  await server.callToolStrict("asset_create", { assetId: "ignored", imagePath });
  await authedPost("/api/viewer-presence", { projectId: "default", assetId: "ignored" });

  const startedAt = Date.now();
  const result = await server.callTool("asset_trash", { assetId: "ignored" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, "user_no_response");
  assert.match(result.content[0].text, /没有回应，素材没有删除。\/ The user did not respond within \d+ seconds/);
  assert.ok(Date.now() - startedAt >= 1400, "the call really waited out the shortened window");
  const asset = await server.callToolStrict("asset_get", { assetId: "ignored" });
  assert.ok(asset.structuredContent.asset);
  assert.deepEqual(await live.listRequests(), [], "the timed-out request file was removed by its creator");
});

test("a viewer showing another asset, a stale viewer record, and an absent record all trash directly", async (t) => {
  const { workspace, imagePath, server, live, authedPost } = await setup(t);
  await server.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "gemini-pro" } });
  await server.callToolStrict("asset_create", { assetId: "direct-a", imagePath });
  const secondPath = await writePngFixture(join(workspace.imagesDir, "second.png"), { color: "#513a2a" });
  await server.callToolStrict("asset_create", { assetId: "direct-b", imagePath: secondPath });

  // The viewer watches Y; trashing X must not ask.
  await authedPost("/api/viewer-presence", { projectId: "default", assetId: "direct-b" });
  const direct = await server.callToolStrict("asset_trash", { assetId: "direct-a" });
  assert.equal(direct.structuredContent.trashed, true);
  assert.deepEqual(await live.listRequests(), [], "no request was filed for the unwatched asset");

  // A stale record (older than 30 s) is nobody watching.
  const staleLive = createLiveDeletionRequests({ libraryDir: workspace.libraryDir, now: () => Date.now() - 60_000 });
  await staleLive.writeViewer({ projectId: "default", assetId: "direct-b" });
  const stale = await server.callToolStrict("asset_trash", { assetId: "direct-b" });
  assert.equal(stale.structuredContent.trashed, true, "a stale viewer record trashes directly");
  assert.deepEqual(await live.listRequests(), []);

  // No record at all: the pre-385 behaviour.
  await live.clearViewer();
  const thirdPath = await writePngFixture(join(workspace.imagesDir, "third.png"), { color: "#2a5137" });
  await server.callToolStrict("asset_create", { assetId: "direct-c", imagePath: thirdPath });
  const none = await server.callToolStrict("asset_trash", { assetId: "direct-c" });
  assert.equal(none.structuredContent.trashed, true);
  assert.deepEqual(await live.listRequests(), []);
});

test("a waiting call with a progress token receives notifications/progress", async (t) => {
  const { imagePath, server, live, authedPost } = await setup(t, { timeoutMs: "7000" });
  await server.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "claude-ai" } });
  await server.callToolStrict("asset_create", { assetId: "progressing", imagePath });
  await authedPost("/api/viewer-presence", { projectId: "default", assetId: "progressing" });

  const call = server.request("tools/call", {
    name: "asset_trash",
    arguments: { assetId: "progressing" },
    _meta: { progressToken: "tok-385" },
  });
  const progress = await server.waitForServerRequest("notifications/progress", { timeoutMs: 10_000 });
  assert.equal(progress.params.progressToken, "tok-385");
  assert.equal(progress.params.message, "正在等用户在 GravityPort 里确认删除…");
  assert.ok(Number.isFinite(progress.params.progress) && Number.isFinite(progress.params.total));
  // Let the call finish on its own timeout so the server is clean for teardown.
  const result = await call;
  assert.equal(result.result.isError, true, "the unanswered window ends in an error result");
  assert.equal(result.result.structuredContent.reason, "user_no_response");
});

test("the refusal mark never stops the MCP trash: an asset the user protected from jimeng sync still trashes", async (t) => {
  const { workspace, imagePath, server, live } = await setup(t);
  await server.request("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "claude-ai" } });
  await server.callToolStrict("asset_create", { assetId: "marked", imagePath });
  // Write the mark directly through the same store the runtime opened — a
  // second readonly-ish connection on the same WAL database is the normal
  // App+MCP coexistence mode.
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(join(workspace.libraryDir, "mosa.db"));
  try {
    raw.prepare(`
      UPDATE assets SET source_json = json_set(COALESCE(source_json, '{}'), '$.provider_deletion_keep', json(?))
      WHERE project_id = 'default' AND id = 'marked'
    `).run(JSON.stringify({ provider: "jimeng", item_id: "7700970082708600099", refused_at: new Date().toISOString() }));
  } finally {
    raw.close();
  }

  // Nobody is viewing: the trash goes through as before, mark or no mark.
  const direct = await server.callToolStrict("asset_trash", { assetId: "marked" });
  assert.equal(direct.structuredContent.trashed, true);
  assert.deepEqual(await live.listRequests(), [], "no confirmation was filed");
});
