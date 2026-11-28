import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, watch } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-ignore - better-sqlite3 is consumed as an untyped runtime dependency in this repository.
import Database from "better-sqlite3";
import sharp from "sharp";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { createCodexImageBridge, reconcileCodexGeneratedImages } from "../lib/codex-image-bridge.js";

test("archives Codex generated images with task metadata and avoids duplicates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f04";
  const imagePath = join(imagesDir, taskId, "exec-test.png");
  const sessionPath = join(sessionsDir, "2026", "07", "18", `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(join(sessionsDir, "2026", "07", "18"), { recursive: true });
  await writeFile(imagePath, await pngFixture(1024, 1536));
  const revisedPrompt = "Use case: stylized-concept\nAsset type: premium sci-fi keyframe, 2:3 portrait\nPrimary request: Build a luminous vertical megacity with rain and suspended transit rings.";
  await writeFile(sessionPath, `${JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra" },
  })}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "生成五张高级艺术视觉图，2:3" }] },
  })}\n${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-18T22:55:27.133Z",
    payload: { type: "image_generation_end", call_id: "exec-test", saved_path: imagePath, revised_prompt: revisedPrompt },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].source.type, "codex-generated");
  assert.equal(first.imported[0].source.codex_task_id, taskId);
  assert.equal(first.imported[0].prompt, revisedPrompt);
  assert.equal(first.imported[0].source.prompt_status, "image-generation-revised-prompt");
  assert.equal(first.imported[0].source.codex_image_generation_call_id, "exec-test");
  assert.equal(first.imported[0].source.model, "gpt-5.6-terra");
  assert.equal(first.imported[0].ratio, "2:3");
  assert.equal(first.imported[0].business_fields.width, 1024);
  assert.match(first.imported[0].source.content_sha256, /^[a-f0-9]{64}$/);

  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped[0].reason, "already-archived");
});

test("recovers an inline Codex image_generation_call result when generated_images has no file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-session-result-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f40";
  const callId = "ig_session_recovery";
  const advertisedPath = join(imagesDir, taskId, `${callId}.png`);
  const sessionPath = join(sessionsDir, "2026", "09", "12", `rollout-test-${taskId}.jsonl`);
  const revisedPrompt = "A precise editorial still life with translucent glass forms.";
  const result = (await pngFixture(640, 480)).toString("base64");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(join(sessionsDir, "2026", "09", "12"), { recursive: true });
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "response_item", timestamp: "2026-09-12T20:00:00.000Z", payload: { type: "image_generation_call", id: callId, status: "generating", result } },
    { type: "event_msg", timestamp: "2026-09-12T20:00:00.100Z", payload: { type: "image_generation_end", call_id: callId, status: "generating", saved_path: advertisedPath, revised_prompt: revisedPrompt } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 1);
  const asset = first.imported[0];
  assert.equal(asset.prompt, revisedPrompt);
  assert.equal(asset.source.generation_tool, "codex-imagegen-session-recovery");
  assert.equal(asset.source.codex_task_id, taskId);
  assert.equal(asset.source.codex_image_generation_call_id, callId);
  assert.equal(asset.source.codex_image_path, advertisedPath);
  assert.equal(asset.source.codex_session_path, sessionPath);
  assert.equal(asset.source.codex_recovered_from_session, true);
  assert.equal(asset.source.storage_mode, "copy");
  assert.equal(asset.source.model, "gpt-5.6-terra");
  assert.equal(asset.ratio, "4:3");

  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.ok(second.skipped.some((item) => item.reason === "already-archived-session-result"));
});

test("skips unchanged Codex candidates without touching the asset store twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-signature-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const imagePath = join(imagesDir, "task-a", "stable.png");
  await mkdir(join(imagesDir, "task-a"), { recursive: true });
  await writeFile(imagePath, await pngFixture(64, 64));

  let sourceLookups = 0;
  let listCalls = 0;
  const store = {
    codexImagesDir: imagesDir,
    async listAssets() { listCalls += 1; return []; },
    async findAssetBySourcePath() {
      sourceLookups += 1;
      return { id: "existing", project_id: "default", prompt: "", theme: "", business_fields: {}, source: { path: imagePath } };
    },
    async findAssetByContentHash() { throw new Error("content lookup should not run"); },
    async findAssetByPixelHash() { throw new Error("pixel lookup should not run"); },
    async updateMetadata() {},
    async createAsset() { throw new Error("create should not run"); },
  };
  const processedSignatures = new Map();
  const sessionsDir = join(root, "sessions");
  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir, processedSignatures });
  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir, processedSignatures });

  assert.equal(first.skipped[0].reason, "already-archived");
  assert.equal(second.skipped[0].reason, "unchanged");
  assert.equal(sourceLookups, 1);
  assert.equal(listCalls, 0, "indexed bridge lookup must not fall back to full project listing");
});

test("passes automatic ingest mode and continues after a suppressed Codex image", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-suppressed-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const firstPath = join(imagesDir, "task-a", "first.png");
  const secondPath = join(imagesDir, "task-b", "second.png");
  await mkdir(join(imagesDir, "task-a"), { recursive: true });
  await mkdir(join(imagesDir, "task-b"), { recursive: true });
  await writeFile(firstPath, await pngFixture(800, 800));
  await writeFile(secondPath, await pngFixture(640, 480));

  const calls = [];
  const store = {
    codexImagesDir: imagesDir,
    async listAssets() { return []; },
    async createAsset(params, options) {
      calls.push({ params, options });
      if (calls.length === 1) throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
      return { id: "codex-imported", ...params };
    },
  };

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir: join(root, "sessions") });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options), [
    { trustedSourceRoots: [imagesDir], ingestMode: "automatic" },
    { trustedSourceRoots: [imagesDir], ingestMode: "automatic" },
  ]);
  assert.equal(result.skipped.filter((item) => item.reason === "suppressed-after-delete").length, 1);
  assert.equal(result.imported.length, 1);
});

test("retries a deterministic Codex asset id collision through automatic identity dedupe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-id-race-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const imagePath = join(imagesDir, "task-a", "same.png");
  await mkdir(join(imagesDir, "task-a"), { recursive: true });
  await writeFile(imagePath, await pngFixture(640, 480));

  const assetIds = [];
  const store = {
    codexImagesDir: imagesDir,
    async listAssets() { return []; },
    async createAsset(params) {
      assetIds.push(params.assetId);
      if (assetIds.length === 1) throw Object.assign(new Error("winner reserved the compact id"), { code: "ASSET_ALREADY_EXISTS" });
      throw Object.assign(new Error("same content won elsewhere"), {
        code: "AUTOMATIC_INGEST_DUPLICATE",
        identityKind: "content",
      });
    },
  };

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir: join(root, "sessions") });
  assert.equal(assetIds.length, 2);
  assert.notEqual(assetIds[1], assetIds[0]);
  assert.match(assetIds[1], new RegExp(`^${assetIds[0]}-[a-f0-9]{8}$`));
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, "already-archived-same-content");
});

test("upgrades an archived task instruction to the matching image generation prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f06";
  const imagePath = join(imagesDir, taskId, "exec-upgrade.png");
  const sessionPath = join(sessionsDir, "2026", "07", "18", `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(join(sessionsDir, "2026", "07", "18"), { recursive: true });
  await writeFile(imagePath, await pngFixture(768, 1024));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "生成一张科幻图" }] },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  const [fallbackAsset] = await store.listAssets({ projectId: "default" });
  assert.equal(fallbackAsset.source.prompt_status, "task-user-prompt");

  const revisedPrompt = "Use case: stylized-concept\nAsset type: alien observatory, 3:4 portrait\nPrimary request: Create a luminous ancient observatory above a cloud ocean.";
  await appendFile(sessionPath, `${JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra" },
  })}\n${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-18T22:55:27.133Z",
    payload: { type: "image_generation_end", call_id: "exec-upgrade", saved_path: imagePath, revised_prompt: revisedPrompt },
  })}\n`);
  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.deepEqual(second.updated, [fallbackAsset.id]);
  const upgraded = await store.getAsset("default", fallbackAsset.id);
  assert.equal(upgraded.prompt, revisedPrompt);
  assert.equal(upgraded.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(upgraded.source.model, "gpt-5.6-terra");
});

test("does not downgrade revised prompt provenance when only task fallback remains", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f07";
  const imagePath = join(imagesDir, taskId, "verified.png");
  const sessionPath = join(sessionsDir, `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(1024, 1024));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "turn_context",
    payload: { model: "gpt-5.6-terra" },
  })}\n${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Task-level fallback prompt" }] },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await store.createAsset({
    assetId: "verified-provenance",
    imagePath,
    prompt: "Verified revised prompt",
    sourceType: "codex-generated",
    business_fields: { prompt_status: "image-generation-revised-prompt" },
    source: {
      prompt_status: "image-generation-revised-prompt",
      codex_image_generation_call_id: "verified-call",
    },
  });

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.deepEqual(result.updated, []);
  const asset = await store.getAsset("default", "verified-provenance");
  assert.equal(asset.prompt, "Verified revised prompt");
  assert.equal(asset.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(asset.source.codex_image_generation_call_id, "verified-call");
  assert.equal(asset.source.user_message, undefined);
  assert.equal(asset.source.model, undefined);
});

test("archives Codex images with the user's message in source and business fields", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-user-msg-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f10";
  const imagePath = join(imagesDir, taskId, "exec-user-msg.png");
  const sessionPath = join(sessionsDir, `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(640, 960));
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做一张书封" }] } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "exec-user-msg", saved_path: imagePath, revised_prompt: "Book cover, warm palette, bold serif title." } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(result.imported.length, 1);
  const asset = result.imported[0];
  assert.equal(asset.source.user_message, "帮我做一张书封");
  assert.equal(asset.business_fields.user_message, "帮我做一张书封");
  assert.equal(asset.prompt, "Book cover, warm palette, bold serif title.");
});

test("reprocesses an archived Codex image when the session gains a user message and writes the backfill once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-backfill-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f11";
  const imagePath = join(imagesDir, taskId, "exec-backfill.png");
  const sessionPath = join(sessionsDir, `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(512, 512));
  const imageEvent = { type: "event_msg", timestamp: "2026-10-25T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "exec-backfill", saved_path: imagePath, revised_prompt: "Book cover, warm palette, bold serif title." } };
  await writeFile(sessionPath, `${JSON.stringify(imageEvent)}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const processedSignatures = new Map();
  const options = { store, imagesDir, sessionsDir, processedSignatures, stableWindowMs: 0 };
  const first = await reconcileCodexGeneratedImages(options);
  assert.equal(first.imported.length, 1);
  const assetId = first.imported[0].id;

  await writeFile(sessionPath, `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做一张书封" }] } })}\n${JSON.stringify(imageEvent)}\n`);
  const second = await reconcileCodexGeneratedImages(options);
  assert.deepEqual(second.updated, [assetId]);
  const backfilled = await store.getAsset("default", assetId);
  assert.equal(backfilled.source.user_message, "帮我做一张书封");
  assert.equal(backfilled.business_fields.user_message, "帮我做一张书封");
  assert.equal(backfilled.prompt, "Book cover, warm palette, bold serif title.");
  assert.equal(backfilled.source.prompt_status, "image-generation-revised-prompt");

  const third = await reconcileCodexGeneratedImages(options);
  assert.deepEqual(third.updated, []);
});

test("does not guess a user message from the task fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-no-guess-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f12";
  const imagePath = join(imagesDir, taskId, "exec-no-guess.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(imagePath, await pngFixture(700, 500));

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await store.createAsset({ assetId: "no-guess", imagePath, prompt: "", sourceType: "codex-generated" });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-test-${taskId}.jsonl`), `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做一张书封" }] },
  })}\n`);

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir, threadHistoryPath: join(root, "missing.sqlite") });
  assert.deepEqual(result.updated, []);
  const asset = await store.getAsset("default", "no-guess");
  assert.equal(asset.source.user_message, undefined);
  assert.equal(asset.business_fields.user_message, undefined);
  assert.equal(asset.prompt, "");
  assert.notEqual(asset.source.prompt_status, "task-user-prompt");
});

test("archives Codex images from the thread-history database with the turn's user message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-db-archive-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f14";
  const imagePath = join(imagesDir, taskId, "db-archive.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(imagePath, await pngFixture(640, 960));
  const fixture = await createThreadHistoryDbFixture(root, taskId, [
    { savedPath: imagePath, itemId: "ig-db", revisedPrompt: "Book cover, warm palette, bold serif title.", userMessage: "帮我做一张书封" },
  ]);
  fixture.close();

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir, threadHistoryPath: fixture.dbPath });
  assert.equal(result.imported.length, 1);
  const asset = result.imported[0];
  assert.equal(asset.prompt, "Book cover, warm palette, bold serif title.");
  assert.equal(asset.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(asset.source.user_message, "帮我做一张书封");
  assert.equal(asset.business_fields.user_message, "帮我做一张书封");
  assert.equal(asset.source.codex_generation_origin, "codex-thread-history");
  assert.equal(asset.source.codex_image_generation_call_id, "ig-db");
});

test("upgrades an archived Codex image once the thread-history database appears", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-db-upgrade-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f15";
  const imagePath = join(imagesDir, taskId, "db-upgrade.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(imagePath, await pngFixture(512, 512));

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const options = { store, imagesDir, sessionsDir, stableWindowMs: 0, threadHistoryPath: join(root, "absent", "thread_history_1.sqlite") };
  const first = await reconcileCodexGeneratedImages(options);
  assert.equal(first.imported.length, 1);
  const assetId = first.imported[0].id;
  assert.equal(first.imported[0].source.prompt_status, "not-available");

  await mkdir(join(root, "absent"), { recursive: true });
  const fixture = await createThreadHistoryDbFixture(join(root, "absent"), taskId, [
    { savedPath: imagePath, itemId: "ig-up", revisedPrompt: "Upgraded revised prompt.", userMessage: "升级用的指令" },
  ]);
  fixture.close();
  const second = await reconcileCodexGeneratedImages(options);
  assert.deepEqual(second.updated, [assetId]);
  const upgraded = await store.getAsset("default", assetId);
  assert.equal(upgraded.prompt, "Upgraded revised prompt.");
  assert.equal(upgraded.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(upgraded.source.user_message, "升级用的指令");
  assert.equal(upgraded.business_fields.user_message, "升级用的指令");
  assert.equal(upgraded.source.codex_generation_origin, "codex-thread-history");

  const third = await reconcileCodexGeneratedImages(options);
  assert.deepEqual(third.updated, []);
});

test("keeps an existing Codex user message even when the session has a newer one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-keep-msg-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f13";
  const imagePath = join(imagesDir, taskId, "exec-keep-msg.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(imagePath, await pngFixture(480, 480));

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await store.createAsset({
    assetId: "keep-msg",
    imagePath,
    prompt: "Verified revised prompt",
    sourceType: "codex-generated",
    business_fields: { prompt_status: "image-generation-revised-prompt", user_message: "第一次的指令" },
    source: { prompt_status: "image-generation-revised-prompt", user_message: "第一次的指令" },
  });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-test-${taskId}.jsonl`), `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "后来的新指令" }] },
  })}\n`);

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.deepEqual(result.updated, []);
  const asset = await store.getAsset("default", "keep-msg");
  assert.equal(asset.source.user_message, "第一次的指令");
  assert.equal(asset.business_fields.user_message, "第一次的指令");
});

test("does not infer an unmatched image model from the task's final turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f08";
  const imagePath = join(imagesDir, taskId, "unmatched.png");
  const sessionPath = join(sessionsDir, `rollout-test-${taskId}.jsonl`);
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(800, 1200));
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "first-model" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First turn" }] } },
    { type: "turn_context", payload: { model: "final-model" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Final turn" }] } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].source.prompt_status, "task-user-prompt");
  assert.equal(result.imported[0].source.model, null);
});

test("watches a later Codex image and stores fallback metadata when no session is available", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f05";
  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ stableWindowMs: 0, store, imagesDir, sessionsDir: join(root, "sessions"), debounceMs: 10, pollIntervalMs: 100 });
  t.after(() => bridge.stop());
  await bridge.start();

  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(join(imagesDir, taskId, "watch.png"), await pngFixture(800, 800));
  await waitFor(() => bridge.status().totalImported === 1);
  const [asset] = await store.listAssets({ projectId: "default" });
  assert.equal(asset.source.codex_task_id, taskId);
  assert.equal(asset.source.prompt_status, "not-available");
  assert.equal(asset.ratio, "1:1");
});

test("bridge caches the session index but refreshes metadata after a matching session changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f09";
  const imagePath = join(imagesDir, taskId, "cached.png");
  const sessionPath = join(sessionsDir, `rollout-test-${taskId}.jsonl`);
  const unrelatedPath = join(sessionsDir, "unrelated.jsonl");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(640, 480));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fallback prompt" }] },
  })}\n`);
  await writeFile(unrelatedPath, "{}\n");

  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ stableWindowMs: 0, store, imagesDir, sessionsDir, pollIntervalMs: 60_000 });
  t.after(() => bridge.stop());
  await bridge.start();
  await rm(unrelatedPath);

  await bridge.reconcile();
  const revisedPrompt = "Asset type: cached metadata refresh\nPrimary request: Keep session discovery incremental.";
  await appendFile(sessionPath, `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-10T11:00:00.000Z",
    payload: { type: "image_generation_end", call_id: "cached", saved_path: imagePath, revised_prompt: revisedPrompt },
  })}\n`);
  const refreshed = await bridge.reconcile();
  assert.equal(refreshed.updated?.length, 1);
  const [asset] = await store.listAssets({ projectId: "default" });
  assert.equal(asset.prompt, revisedPrompt);
});

test("runtime handoff drains the current Codex import without starting the remaining backlog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-handoff-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "images");
  await mkdir(imagesDir);
  for (let index = 0; index < 3; index += 1) await writeFile(join(imagesDir, `${index}.png`), await pngFixture(40 + index, 30));
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const controller = new AbortController();
  const originalCreate = store.createAsset.bind(store);
  let started = 0;
  let completed = 0;
  store.createAsset = async (...args) => {
    started += 1;
    controller.abort();
    const asset = await originalCreate(...args);
    completed += 1;
    return asset;
  };
  const bridge = createCodexImageBridge({ stableWindowMs: 0, store, imagesDir, sessionsDir: join(root, "sessions"), signal: controller.signal });
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.stop();
  assert.equal(started, 1);
  assert.equal(completed, 1, "the in-flight write is drained before shutdown");
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

async function pngFixture(width, height) {
  // Task 366: imports sniff the file head, so fixtures carry real PNG bytes.
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
}

async function createThreadHistoryDbFixture(dir, taskId, generations) {
  const dbPath = join(dir, "thread_history_1.sqlite");
  const db = new Database(dbPath);
  db.exec([
    "CREATE TABLE thread_items (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL, item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '', updated_at_ordinal INTEGER NOT NULL DEFAULT 0, started_at_ms INTEGER, completed_at_ms INTEGER, PRIMARY KEY (thread_id, turn_id, item_id))",
    "CREATE TABLE thread_turns (thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, rollout_ordinal INTEGER NOT NULL, status TEXT NOT NULL, error_json TEXT, started_at INTEGER, completed_at INTEGER, duration_ms INTEGER, first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER, rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER, root_turn_id TEXT, PRIMARY KEY (thread_id, turn_id))",
  ].join(";"));
  generations.forEach((generation, index) => {
    const turnId = `turn-${index + 1}`;
    db.prepare("INSERT INTO thread_turns (thread_id, turn_id, rollout_ordinal, status, first_user_item_id) VALUES (?, ?, ?, 'completed', ?)")
      .run(taskId, turnId, index, generation.userMessage ? `um-${index + 1}` : null);
    if (generation.userMessage) {
      db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, 'userMessage')")
        .run(taskId, turnId, `um-${index + 1}`, 1, 1_000, JSON.stringify({
          type: "userMessage",
          id: `um-${index + 1}`,
          content: [{ type: "text", text: generation.userMessage }],
        }));
    }
    db.prepare("INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, completed_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?, 'imageGeneration')")
      .run(taskId, turnId, generation.itemId, 2, 2_000, 3_000, JSON.stringify({
        type: "imageGeneration",
        id: generation.itemId,
        status: "completed",
        revisedPrompt: generation.revisedPrompt,
        savedPath: generation.savedPath,
      }));
  });
  return { dbPath, close() { db.close(); } };
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex image bridge.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("keeps user-edited prompts across Codex reconciliation while untouched assets still upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-user-edit-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library") });
  t.after(() => store.close?.());
  await store.ensureProject("default");

  const writeSession = async (taskId, callId, imagePath, revisedPrompt) => {
    const sessionPath = join(sessionsDir, "2026", "10", "28", `rollout-${taskId}.jsonl`);
    await mkdir(join(sessionsDir, "2026", "10", "28"), { recursive: true });
    await writeFile(sessionPath, [
      { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
      { type: "event_msg", timestamp: "2026-10-28T10:00:00.000Z", payload: { type: "image_generation_end", call_id: callId, saved_path: imagePath, revised_prompt: revisedPrompt } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n");
    return sessionPath;
  };

  const pathA = join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f11", "edited.png");
  const pathB = join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f12", "kept.png");
  await mkdir(join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f11"), { recursive: true });
  await mkdir(join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f12"), { recursive: true });
  await writeFile(pathA, await pngFixture(1024, 1536));
  await writeFile(pathB, await pngFixture(800, 600));
  const promptA = "Use case: stylized-concept\nAsset type: premium sci-fi keyframe, 2:3 portrait\nPrimary request: original prompt for the edited image.";
  const promptB = "Use case: stylized-concept\nAsset type: premium sci-fi keyframe, 2:3 portrait\nPrimary request: original prompt for the untouched image.";
  await writeSession("019f776f-f6d5-7692-b9e5-dd280fc09f11", "call-edit", pathA, promptA);
  await writeSession("019f776f-f6d5-7692-b9e5-dd280fc09f12", "call-keep", pathB, promptB);

  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 2);
  const assetA = first.imported.find((asset) => asset.source.codex_task_id === "019f776f-f6d5-7692-b9e5-dd280fc09f11");
  const assetB = first.imported.find((asset) => asset.source.codex_task_id === "019f776f-f6d5-7692-b9e5-dd280fc09f12");
  assert.equal(assetA.prompt, promptA);

  // The UI PATCH entry point: stamp markers the way lib/api/asset-routes.mjs does.
  await store.updateMetadata("default", assetA.id, withUserEditMarkers(await store.getAsset("default", assetA.id), { prompt: "USER EDIT: luminous vertical megacity" }));

  const revisedA = `${promptA} Revised after the user edit.`;
  const revisedB = `${promptB} Revised while nobody was looking.`;
  await writeSession("019f776f-f6d5-7692-b9e5-dd280fc09f11", "call-edit", pathA, revisedA);
  await writeSession("019f776f-f6d5-7692-b9e5-dd280fc09f12", "call-keep", pathB, revisedB);

  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.deepEqual(second.updated, [assetB.id], "only the untouched asset is rewritten");
  const afterA = await store.getAsset("default", assetA.id);
  const afterB = await store.getAsset("default", assetB.id);
  assert.equal(afterA.prompt, "USER EDIT: luminous vertical megacity", "the user edit must survive reconciliation");
  assert.equal(afterB.prompt, revisedB, "the untouched asset must still follow the session");
  assert.ok(afterA.source.prompt_user_edited_at);
});

test("a user-renamed Codex asset keeps its theme while its prompt still upgrades", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-user-theme-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library") });
  t.after(() => store.close?.());
  await store.ensureProject("default");

  const imagePath = join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f13", "renamed.png");
  await mkdir(join(imagesDir, "019f776f-f6d5-7692-b9e5-dd280fc09f13"), { recursive: true });
  await writeFile(imagePath, await pngFixture(640, 480));
  const sessionPath = join(sessionsDir, "2026", "10", "28", "rollout-019f776f-f6d5-7692-b9e5-dd280fc09f13.jsonl");
  await mkdir(join(sessionsDir, "2026", "10", "28"), { recursive: true });
  const writeSession = (revisedPrompt) => writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "event_msg", timestamp: "2026-10-28T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "call-theme", saved_path: imagePath, revised_prompt: revisedPrompt } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  const promptV1 = "Use case: stylized-concept\nAsset type: neon harbor skyline\nPrimary request: first revision of the prompt.";
  await writeSession(promptV1);

  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 1);
  const asset = first.imported[0];

  // Rename only: the prompt keeps no marker, so upgrades stay possible.
  await store.updateMetadata("default", asset.id, withUserEditMarkers(await store.getAsset("default", asset.id), { theme: "用户起的名字" }));

  const promptV2 = "Use case: stylized-concept\nAsset type: neon harbor skyline at dawn\nPrimary request: second revision of the prompt.";
  await writeSession(promptV2);
  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.ok(second.updated.includes(asset.id), "the prompt upgrade must still happen");

  const after = await store.getAsset("default", asset.id);
  assert.equal(after.prompt, promptV2);
  assert.equal(after.theme, "用户起的名字", "the user rename must not be recomputed from the new prompt");
  assert.ok(after.source.theme_user_edited_at);
});

// Large deterministic fixture so the web-capture path accepts it (it rejects
// captures under 20 KiB) and the same bytes can seed a Codex task folder.
async function noisyPngFixture(width = 320, height = 240) {
  const raw = Buffer.alloc(width * height * 3);
  for (let index = 0; index < raw.length; index += 1) raw[index] = (index * 37 + Math.floor(index / width) * 23) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
}

test("a Codex byte rematch of its own archived image upgrades it from the newer session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-byte-own-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskA = "019f776f-f6d5-7692-b9e5-dd280fc09f21";
  const taskB = "019f776f-f6d5-7692-b9e5-dd280fc09f22";
  const imagePathA = join(imagesDir, taskA, "exec-original.png");
  const imagePathB = join(imagesDir, taskB, "exec-copy.png");
  await mkdir(join(imagesDir, taskA), { recursive: true });
  await mkdir(join(imagesDir, taskB), { recursive: true });

  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  await writeFile(imagePathA, await pngFixture(512, 512));
  const sessionA = join(sessionsDir, `rollout-test-${taskA}.jsonl`);
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(sessionA, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First pass prompt" }] },
  })}\n`);
  const first = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(first.imported.length, 1);
  const archived = first.imported[0];
  assert.equal(archived.source.prompt_status, "task-user-prompt");

  // The very same bytes turn up under another task whose session carries the
  // revised prompt: the Codex-owned asset upgrades, no second asset is built.
  await copyFile(imagePathA, imagePathB);
  await writeFile(join(sessionsDir, `rollout-test-${taskB}.jsonl`), [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "event_msg", timestamp: "2026-10-29T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "call-copy", saved_path: imagePathB, revised_prompt: "Use case: stylized-concept\nAsset type: upgraded remaster\nPrimary request: sharper second pass of the same image." } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.some((item) => item.reason === "already-archived-same-content"), true);
  assert.deepEqual(second.updated, [archived.id]);

  const upgraded = await store.getAsset("default", archived.id);
  assert.match(upgraded.prompt, /sharper second pass/);
  assert.equal(upgraded.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(upgraded.source.model, "gpt-5.6-terra");
  // Two observations: the task-A path re-observed, plus the task-B byte
  // rematch that carried the upgrade.
  const codexOccurrences = upgraded.source.capture_occurrences.filter((entry) => entry.provider === "codex");
  assert.equal(codexOccurrences.length, 2);
  const taskBOccurrence = codexOccurrences.find((entry) => entry.conversation_id === taskB);
  assert.equal(taskBOccurrence.message_id, "call-copy");
  assert.equal(taskBOccurrence.source_path, imagePathB);

  const third = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(third.imported.length, 0);
  assert.deepEqual(third.updated, [], "a second identical pass writes nothing");
  const reread = await store.getAsset("default", archived.id);
  assert.equal(reread.source.capture_occurrences.filter((entry) => entry.provider === "codex").length, 2, "repeated observations stay deduplicated per key");
});

test("a Codex byte rematch of another channel's image only records an occurrence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-byte-other-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");

  const imageBytes = await noisyPngFixture();
  const web = await ingestWebCapture({
    store,
    tempRoot: join(libraryDir, ".web-capture-tmp"),
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: imageBytes.toString("base64"),
      mimeType: "image/png",
      prompt: "web caption prompt A",
      prompt_status: "visible-caption",
      conversationId: "conv-web-1",
    },
  });
  assert.equal(web.status, "imported");

  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f23";
  const imagePath = join(imagesDir, taskId, "exec-web-copy.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, imageBytes);
  await writeFile(join(sessionsDir, `rollout-test-${taskId}.jsonl`), [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "event_msg", timestamp: "2026-10-29T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "call-web-copy", saved_path: imagePath, revised_prompt: "Codex revised prompt that ranks higher and must not land." } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const result = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.some((item) => item.reason === "already-archived-same-content"), true);
  assert.equal(result.updated.length, 0);

  const asset = await store.getAsset("default", web.asset.id);
  assert.equal(asset.prompt, "web caption prompt A");
  assert.equal(asset.source.prompt_status, "visible-caption");
  assert.equal(asset.source.generation_tool, "web-ui");
  assert.notEqual(asset.source.model, "gpt-5.6-terra");
  const codexOccurrences = asset.source.capture_occurrences.filter((entry) => entry.provider === "codex");
  assert.equal(codexOccurrences.length, 1);
  assert.equal(codexOccurrences[0].conversation_id, taskId);

  const second = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(second.updated.length, 0);
  const reread = await store.getAsset("default", web.asset.id);
  assert.equal(reread.source.capture_occurrences.filter((entry) => entry.provider === "codex").length, 1, "the same observation is recorded once");
});

test("defers a Codex image written inside the stability window and archives it once unchanged", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-stable-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f21";
  const imagePath = join(imagesDir, taskId, "late-write.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(320, 200));

  let clock = 1_000_000_000;
  const nowMs = () => clock;
  // 文件「刚写完」：mtime 落在稳定窗口内。
  await utimes(imagePath, new Date(clock - 500), new Date(clock - 500));
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const processedSignatures = new Map();
  const deferredObservations = new Map();
  const options = { store, imagesDir, sessionsDir, processedSignatures, deferredObservations, stableWindowMs: 2000, nowMs };

  const first = await reconcileCodexGeneratedImages(options);
  assert.equal(first.imported.length, 0);
  assert.deepEqual(first.skipped, [{ path: imagePath, reason: "not-ready" }]);
  assert.equal(first.deferred, 1);
  assert.equal(processedSignatures.size, 0, "a deferred file must not be recorded as processed");

  // 时钟推过稳定窗口、文件没变：再扫一轮收进。
  clock += 2000;
  const second = await reconcileCodexGeneratedImages(options);
  assert.equal(second.imported.length, 1);
  assert.equal(second.imported[0].source.codex_task_id, taskId);
  assert.ok(processedSignatures.has(imagePath));

  // 中途文件变大（还在写）：重新计时，这一轮仍不收。
  clock += 2000;
  await writeFile(imagePath, await pngFixture(320, 480));
  await utimes(imagePath, new Date(clock - 100), new Date(clock - 100));
  const third = await reconcileCodexGeneratedImages(options);
  assert.equal(third.imported.length, 0);
  assert.deepEqual(third.skipped, [{ path: imagePath, reason: "not-ready" }]);
  assert.equal(third.deferred, 1);

  // 再推过一个窗口：这份候选处理完（同路径已归档，不再新建素材）。
  clock += 2000;
  const fourth = await reconcileCodexGeneratedImages(options);
  assert.equal(fourth.imported.length, 0);
  assert.deepEqual(fourth.skipped, [{ path: imagePath, reason: "already-archived" }]);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("archives a Codex image whose mtime is already outside the stability window immediately", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-old-mtime-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f22";
  const imagePath = join(imagesDir, taskId, "settled.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(320, 200));

  const clock = 1_000_000_000;
  // 修改时间早于稳定窗口：第一轮就收，不许给正常情况加延迟。
  await utimes(imagePath, new Date(clock - 60_000), new Date(clock - 60_000));
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir, stableWindowMs: 2000, nowMs: () => clock });
  assert.equal(result.imported.length, 1);
  assert.deepEqual(result.skipped, []);
});

test("schedules an automatic rescan roughly one stability window after a defer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-rescan-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f23";
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 60, debounceMs: 10, pollIntervalMs: 60_000 });
  t.after(() => bridge.stop());
  // Task 452: start() no longer creates Codex's images root, so the test makes
  // it first (a real Codex install has it) to keep the watcher armed.
  await mkdir(imagesDir, { recursive: true });
  await bridge.start();
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(join(imagesDir, taskId, "rescan.png"), await pngFixture(64, 64));
  // 推迟后不许再等人来扫：大约一个稳定窗口后要自己再扫一轮并收进。
  await waitFor(() => bridge.status().totalImported === 1, 4000);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("keeps the Codex bridge enabled when the first scan fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-start-err-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const imagePath = join(imagesDir, "task-b", "first-scan.png");
  await mkdir(join(imagesDir, "task-b"), { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(imagePath, await pngFixture(64, 64));
  await chmod(imagesDir, 0o000);
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 0, debounceMs: 10, pollIntervalMs: 60_000 });
  t.after(async () => { await bridge.stop(); await chmod(imagesDir, 0o755).catch(() => {}); await rm(root, { recursive: true, force: true }); });

  const status = await bridge.start();
  assert.equal(status.enabled, true);
  assert.match(String(status.lastError || ""), /EACCES/);
  assert.equal(status.lastErrorCode, "EACCES");
  await chmod(imagesDir, 0o755);
  await bridge.reconcile();
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  const after = bridge.status();
  assert.equal(after.enabled, true);
  assert.equal(after.lastError, null);
  assert.equal(after.lastErrorCode, null);
  assert.equal(after.polling, true);
});

test("reports sourceFound from the scan's own walks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-source-found-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  t.after(() => rm(root, { recursive: true, force: true }));

  // Neither data root exists yet: the walks hit their ENOENT branch and the
  // scan stays a clean no-op, so the card can tell「没装」from「没新图」.
  const missing = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(missing.imported.length, 0);
  assert.equal(missing.sourceFound, false);

  await mkdir(join(imagesDir, "task-found"), { recursive: true });
  await writeFile(join(imagesDir, "task-found", "found.png"), await pngFixture(64, 64));
  const present = await reconcileCodexGeneratedImages({ stableWindowMs: 0, store, imagesDir, sessionsDir });
  assert.equal(present.imported.length, 1);
  assert.equal(present.sourceFound, true);

  // The running bridge reports the same through status().
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 0, debounceMs: 10, pollIntervalMs: 60_000 });
  t.after(() => bridge.stop());
  const status = await bridge.start();
  assert.equal(status.enabled, true);
  assert.equal(status.lastError, null);
  assert.equal(status.sourceFound, true);
});

test("bridge start() does not create the Codex images root and reports sourceFound:false until it appears", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-no-mkdir-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  t.after(() => rm(root, { recursive: true, force: true }));

  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 0, debounceMs: 10, pollIntervalMs: 60_000 });
  t.after(() => bridge.stop());
  const started = await bridge.start();
  assert.equal(started.enabled, true);
  assert.equal(started.lastError, null);
  assert.equal(started.lastErrorCode, null);
  assert.equal(started.sourceFound, false);
  assert.equal(existsSync(imagesDir), false, "start() must not create Codex's images directory");
  assert.equal(started.watching, false);

  // Codex shows up later: the next scan flips sourceFound, imports the image
  // and arms the watchers.
  await mkdir(join(imagesDir, "task-late"), { recursive: true });
  await writeFile(join(imagesDir, "task-late", "late.png"), await pngFixture(64, 64));
  const result = await bridge.reconcile();
  assert.equal(result.imported.length, 1);
  const status = bridge.status();
  assert.equal(status.sourceFound, true);
  assert.equal(status.lastError, null);
  assert.equal(status.watching, true);
});

// Task 473: on Linux, the recursive fs.watch of some Node 24 releases (24.16.0
// among them) does not throw for a missing root — it returns a watcher that
// watches nothing. The bridge used to take any returned watcher as proof that
// it was watching. watchImpl reproduces that platform behavior everywhere.
test("bridge does not report a watcher when watch() returns an inert one for a missing root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-inert-watch-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  t.after(() => rm(root, { recursive: true, force: true }));

  const watchedRoots = [];
  const inertForMissingRoot = (watchRoot, options, listener) => {
    watchedRoots.push(watchRoot);
    if (existsSync(watchRoot)) return watch(watchRoot, options, listener);
    return Object.assign(new EventEmitter(), { close() {} });
  };
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 0, debounceMs: 10, pollIntervalMs: 60_000, watchImpl: inertForMissingRoot });
  t.after(() => bridge.stop());

  const started = await bridge.start();
  assert.equal(started.sourceFound, false);
  assert.equal(started.watching, false, "no directory, so nothing is being watched");
  assert.equal(started.watchingImages, false);
  assert.equal(started.watchingSessions, false);
  assert.deepEqual(watchedRoots, [], "watch() is never asked to watch a root that does not exist");

  // The directory appears: the next scan imports the image and arms a real watcher.
  await mkdir(join(imagesDir, "task-late"), { recursive: true });
  await writeFile(join(imagesDir, "task-late", "late.png"), await pngFixture(64, 64));
  const result = await bridge.reconcile();
  assert.equal(result.imported.length, 1);
  const status = bridge.status();
  assert.equal(status.sourceFound, true);
  assert.equal(status.watchingImages, true);
  assert.equal(status.watchingSessions, false, "the sessions root still does not exist");
  assert.deepEqual(watchedRoots, [imagesDir]);
});

test("bridge drops its watcher when the Codex images root is removed and arms a new one when it returns", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-root-lifecycle-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  t.after(() => rm(root, { recursive: true, force: true }));

  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, stableWindowMs: 0, debounceMs: 10, pollIntervalMs: 60_000 });
  t.after(() => bridge.stop());
  assert.equal((await bridge.start()).watchingImages, false);

  await mkdir(join(imagesDir, "task-first"), { recursive: true });
  await writeFile(join(imagesDir, "task-first", "first.png"), await pngFixture(64, 64));
  assert.equal((await bridge.reconcile()).imported.length, 1);
  assert.equal(bridge.status().watchingImages, true);

  // Codex's data is removed while the bridge runs.
  await rm(imagesDir, { recursive: true, force: true });
  await bridge.reconcile();
  const removed = bridge.status();
  assert.equal(removed.sourceFound, false);
  assert.equal(removed.lastError, null);
  assert.equal(removed.watchingImages, false, "a removed root is not being watched");
  assert.equal(removed.watching, false);

  // It comes back with a new image: imported, and watched again.
  await mkdir(join(imagesDir, "task-second"), { recursive: true });
  await writeFile(join(imagesDir, "task-second", "second.png"), await pngFixture(96, 80));
  assert.equal((await bridge.reconcile()).imported.length, 1);
  const returned = bridge.status();
  assert.equal(returned.sourceFound, true);
  assert.equal(returned.watchingImages, true);
});

test("pairs a Codex image with its own generation event when the images dir is reached through a symlink", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-symlink-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const realImagesDir = join(root, "real-images");
  const linkedImagesDir = join(root, "linked-images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f31";
  await mkdir(join(realImagesDir, taskId), { recursive: true });
  await symlink(realImagesDir, linkedImagesDir);
  await writeFile(join(realImagesDir, taskId, "linked.png"), await pngFixture(320, 200));
  // 会话里记的是真实路径写法，不是软链写法。
  const realSpelling = join(realImagesDir, taskId, "linked.png");
  const revisedPrompt = "Asset type: symlink pairing fixture\nPrimary request: pair by the real path spelling.";
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-test-${taskId}.jsonl`), `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-11-17T10:00:00.000Z",
    payload: { type: "image_generation_end", call_id: "linked", saved_path: realSpelling, revised_prompt: revisedPrompt },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: linkedImagesDir });
  const result = await reconcileCodexGeneratedImages({ store, imagesDir: linkedImagesDir, sessionsDir, stableWindowMs: 0 });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].prompt, revisedPrompt);
  assert.equal(result.imported[0].source.prompt_status, "image-generation-revised-prompt");
});
