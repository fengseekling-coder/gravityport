import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { acquireMosaRuntimeLock } from "../lib/runtime-lock.js";

test("Generation HTTP API records events, explicit relations, and lineage without accepting provider_verified claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-generation-api-"));
  const libraryDir = join(root, "library");
  const generatedDir = join(root, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const firstPath = join(generatedDir, "first.png");
  const secondPath = join(generatedDir, "second.png");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#243047" } }).png().toFile(firstPath);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#c43d38" } }).png().toFile(secondPath);

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const firstAsset = await store.createAsset({ assetId: "generation-api-first", imagePath: firstPath });
  const secondAsset = await store.createAsset({ assetId: "generation-api-second", imagePath: secondPath });
  await store.setMigrationState("completed", { test: true });
  store.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: generatedDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);
  const baseUrl = `http://127.0.0.1:${port}`;

  const firstResponse = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: firstAsset.id,
    provider: "openai",
    providerGenerationCallId: "ig_api_first",
    providerResponseId: "resp_api_first",
    effectivePrompt: "first generation",
    verificationLevel: "observed",
  });
  assert.equal(firstResponse.status, 201);
  const firstEvent = (await firstResponse.json()).event;
  assert.equal(firstEvent.output_asset_id, firstAsset.id);
  assert.equal(firstEvent.provider_generation_call_id, "ig_api_first");
  assert.equal(firstEvent.verification_level, "observed");

  const secondResponse = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: secondAsset.id,
    provider: "openai",
    providerGenerationCallId: "ig_api_second",
    providerResponseId: "resp_api_second",
    effectivePrompt: "make the background warm",
    verificationLevel: "user_confirmed",
  });
  assert.equal(secondResponse.status, 201);
  const secondEvent = (await secondResponse.json()).event;

  const relationResponse = await postJson(`${baseUrl}/api/generation-relations`, {
    childGenerationId: secondEvent.id,
    parentGenerationId: firstEvent.id,
    relationType: "edited_from",
    verificationLevel: "user_confirmed",
    evidence: { user_selected_parent: true },
  });
  assert.equal(relationResponse.status, 201);
  assert.equal((await relationResponse.json()).relation.relation_type, "edited_from");

  const listResponse = await fetch(`${baseUrl}/api/generations?project=default&asset=${encodeURIComponent(firstAsset.id)}`);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()).events;
  assert.deepEqual(listed.map((event) => event.id), [firstEvent.id]);

  const firstPageResponse = await fetch(`${baseUrl}/api/generations?project=default&limit=1`);
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.equal(firstPage.events.length, 1);
  assert.equal(firstPage.page.limit, 1);
  assert.equal(firstPage.page.nextCursor, "1");
  const secondPageResponse = await fetch(`${baseUrl}/api/generations?project=default&limit=1&cursor=${firstPage.page.nextCursor}`);
  assert.equal(secondPageResponse.status, 200);
  const secondPage = await secondPageResponse.json();
  assert.equal(secondPage.events.length, 1);
  assert.notEqual(secondPage.events[0].id, firstPage.events[0].id);

  const lineageResponse = await fetch(`${baseUrl}/api/generations/${encodeURIComponent(secondEvent.id)}/lineage?project=default`);
  assert.equal(lineageResponse.status, 200);
  const lineage = (await lineageResponse.json()).lineage;
  assert.deepEqual(new Set(lineage.events.map((event) => event.id)), new Set([firstEvent.id, secondEvent.id]));
  assert.equal(lineage.relations[0].verification_level, "user_confirmed");

  const assetHistoryResponse = await fetch(`${baseUrl}/api/assets/default/${encodeURIComponent(firstAsset.id)}/generation-history`);
  assert.equal(assetHistoryResponse.status, 200);
  const assetHistory = (await assetHistoryResponse.json()).history;
  assert.equal(assetHistory.asset_id, firstAsset.id);
  assert.deepEqual(assetHistory.generation_ids, [firstEvent.id]);
  assert.deepEqual(new Set(assetHistory.events.map((event) => event.id)), new Set([firstEvent.id, secondEvent.id]));
  assert.equal(assetHistory.relations.length, 1);

  const chatParentResponse = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: firstAsset.id,
    provider: "chatgpt",
    providerAssetId: "chat-file-parent",
    conversationId: "chat-conversation-a",
    messageId: "chat-message-a",
    effectivePrompt: "product poster",
    verificationLevel: "observed",
    createdAt: "2026-08-27T10:00:00.000Z",
  });
  assert.equal(chatParentResponse.status, 201);
  const chatParent = (await chatParentResponse.json()).event;
  const chatChildResponse = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: secondAsset.id,
    provider: "chatgpt",
    conversationId: "chat-conversation-a",
    messageId: "chat-message-b",
    effectivePrompt: "参考这张图，把背景改成黑色",
    references: [{ provider_asset_id: "chat-file-parent" }],
    verificationLevel: "observed",
    createdAt: "2026-08-27T10:05:00.000Z",
  });
  assert.equal(chatChildResponse.status, 201);
  const chatChild = (await chatChildResponse.json()).event;

  const candidateHistoryResponse = await fetch(`${baseUrl}/api/assets/default/${encodeURIComponent(firstAsset.id)}/generation-history`);
  assert.equal(candidateHistoryResponse.status, 200);
  const candidateHistory = (await candidateHistoryResponse.json()).history;
  assert.ok(candidateHistory.relation_candidates.some((candidate) => (
    candidate.child_generation_id === chatChild.id
    && candidate.parent_generation_id === chatParent.id
    && candidate.status === "suggested"
  )));

  const dismissResponse = await fetch(`${baseUrl}/api/generation-relation-candidates`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: "default",
      childGenerationId: chatChild.id,
      parentGenerationId: chatParent.id,
      status: "dismissed",
    }),
  });
  assert.equal(dismissResponse.status, 200);
  assert.equal((await dismissResponse.json()).candidate.status, "dismissed");
  const dismissedHistory = (await (await fetch(`${baseUrl}/api/assets/default/${encodeURIComponent(firstAsset.id)}/generation-history`)).json()).history;
  assert.equal(dismissedHistory.relation_candidates.some((candidate) => (
    candidate.child_generation_id === chatChild.id
    && candidate.parent_generation_id === chatParent.id
  )), false, "dismissed candidate stays out of the possible-relation surface");

  const reserved = await postJson(`${baseUrl}/api/generations`, {
    outputAssetId: firstAsset.id,
    provider: "openai",
    providerGenerationCallId: "ig_untrusted_claim",
    verificationLevel: "provider_verified",
  });
  assert.equal(reserved.status, 400);
  assert.deepEqual(await reserved.json(), {
    error: "provider_verified is reserved for trusted GravityPort provider integrations.",
    code: "GENERATION_PROVIDER_VERIFICATION_RESERVED",
  });
});

test("MCP exposes generation recording, relation, and lineage tools with the same trust boundary", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-generation-mcp-"));
  const libraryDir = join(root, "library");
  const generatedDir = join(root, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const firstPath = join(generatedDir, "first.png");
  const secondPath = join(generatedDir, "second.png");
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#27324a" } }).png().toFile(firstPath);
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ad4b3a" } }).png().toFile(secondPath);

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  const firstAsset = await store.createAsset({ assetId: "generation-mcp-first", imagePath: firstPath });
  const secondAsset = await store.createAsset({ assetId: "generation-mcp-second", imagePath: secondPath });
  await store.setMigrationState("completed", { test: true });
  store.close();

  // Simulate the desktop/server runtime holding its normal library lease.
  // SQLite MCP must remain available because its DB/filesystem operations are
  // designed for cross-process coexistence; only the legacy JSON backend is exclusive.
  const runtimeLease = await acquireMosaRuntimeLock({ libraryDir });
  t.after(() => runtimeLease.release());

  const server = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: generatedDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  });

  const definitions = await callMcp(server, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = definitions.result.tools;
  for (const name of ["generation_record", "generation_list", "generation_relation_record", "generation_lineage"]) {
    assert.ok(tools.some((tool) => tool.name === name), `expected ${name}`);
  }
  const relationDefinition = tools.find((tool) => tool.name === "generation_relation_record");
  assert.deepEqual(relationDefinition.inputSchema.properties.verificationLevel.enum, ["user_confirmed", "observed", "inferred"]);

  const invalidList = await callMcp(server, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "asset_list", arguments: { limit: 999 } },
  });
  assert.equal(invalidList.error.code, -32602);
  assert.match(invalidList.error.message, /arguments\.limit must be <= 250/);

  const emptyVersionChange = await callMcp(server, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "asset_version_create",
      arguments: { assetId: firstAsset.id, version_change: "" },
    },
  });
  assert.equal(emptyVersionChange.error.code, -32602);
  assert.match(emptyVersionChange.error.message, /arguments\.version_change must contain at least 1 characters/);

  const first = await callMcp(server, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "generation_record",
      arguments: {
        outputAssetId: firstAsset.id,
        provider: "openai",
        providerGenerationCallId: "ig_mcp_first",
        effectivePrompt: "first MCP generation",
        verificationLevel: "observed",
      },
    },
  });
  const firstEvent = first.result.structuredContent.event;

  const second = await callMcp(server, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "generation_record",
      arguments: {
        outputAssetId: secondAsset.id,
        provider: "openai",
        providerGenerationCallId: "ig_mcp_second",
        effectivePrompt: "second MCP generation",
        verificationLevel: "user_confirmed",
      },
    },
  });
  const secondEvent = second.result.structuredContent.event;

  const relation = await callMcp(server, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "generation_relation_record",
      arguments: {
        childGenerationId: secondEvent.id,
        parentGenerationId: firstEvent.id,
        relationType: "edited_from",
        verificationLevel: "user_confirmed",
        evidence: { user_selected_parent: true },
      },
    },
  });
  assert.equal(relation.result.structuredContent.relation.relation_type, "edited_from");

  const lineage = await callMcp(server, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "generation_lineage", arguments: { generationId: secondEvent.id } },
  });
  assert.equal(lineage.result.structuredContent.lineage.events.length, 2);

  const reserved = await callMcp(server, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "generation_record",
      arguments: {
        outputAssetId: firstAsset.id,
        provider: "openai",
        providerGenerationCallId: "ig_mcp_untrusted",
        verificationLevel: "provider_verified",
      },
    },
  });
  assert.equal(reserved.error.code, -32602);
  assert.match(reserved.error.message, /arguments\.verificationLevel must be one of: user_confirmed, observed, inferred/);
});

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForServerPort(server) {
  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  return new Promise((resolvePort, rejectPort) => {
    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => finish(new Error("Timed out waiting for MOSA server startup.")), 5000);
    const onOutput = (chunk) => {
      output += chunk;
      // Task 314: the child prints its capability on the boot line; stash it
      // so the readiness probes can present the credential it actually owns.
      const match = /GravityPort: http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      const tokenMatch = /#mosa-client-token=([A-Za-z0-9_%-]+)/.exec(output);
      if (match) {
        // Suppressed when stdout is redirected (server.mjs): the probes then
        // fall back to the MOSA_CLIENT_TOKEN the test itself exported.
        if (tokenMatch) server.mosaClientToken = decodeURIComponent(tokenMatch[1]);
        finish(null, Number(match[1]));
      }
    };
    const onErrorOutput = (chunk) => { errorOutput += chunk; };
    const onExit = () => finish(new Error(`MOSA server exited during startup.${errorOutput ? `\n${errorOutput}` : ""}`));
    const finish = (error, port) => {
      clearTimeout(timer);
      server.stdout.off("data", onOutput);
      server.stderr.off("data", onErrorOutput);
      server.off("exit", onExit);
      if (error) rejectPort(error);
      else resolvePort(port);
    };
    server.stdout.on("data", onOutput);
    server.stderr.on("data", onErrorOutput);
    server.once("exit", onExit);
  });
}

async function waitForServer(port, server) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("MOSA server exited during startup.");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
        // Task 314: /api/bridges requires the child's own capability now.
        headers: { "x-mosa-client-token": server.mosaClientToken ?? process.env.MOSA_CLIENT_TOKEN ?? "" },
      });
      if (response.ok) return;
    } catch {
      // Listener may not be ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Timed out waiting for MOSA server startup.");
}

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
