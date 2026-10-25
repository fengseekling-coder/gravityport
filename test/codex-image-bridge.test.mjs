import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
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
  await writeFile(imagePath, pngFixture(1024, 1536));
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
  const first = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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

  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  const result = pngFixture(640, 480).toString("base64");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(join(sessionsDir, "2026", "09", "12"), { recursive: true });
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "response_item", timestamp: "2026-09-12T20:00:00.000Z", payload: { type: "image_generation_call", id: callId, status: "generating", result } },
    { type: "event_msg", timestamp: "2026-09-12T20:00:00.100Z", payload: { type: "image_generation_end", call_id: callId, status: "generating", saved_path: advertisedPath, revised_prompt: revisedPrompt } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const first = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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

  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.ok(second.skipped.some((item) => item.reason === "already-archived-session-result"));
});

test("skips unchanged Codex candidates without touching the asset store twice", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-signature-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const imagesDir = join(root, "generated_images");
  const imagePath = join(imagesDir, "task-a", "stable.png");
  await mkdir(join(imagesDir, "task-a"), { recursive: true });
  await writeFile(imagePath, pngFixture(64, 64));

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
  const first = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir, processedSignatures });
  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir, processedSignatures });

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
  await writeFile(firstPath, pngFixture(800, 800));
  await writeFile(secondPath, pngFixture(640, 480));

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

  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir: join(root, "sessions") });
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
  await writeFile(imagePath, pngFixture(640, 480));

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

  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir: join(root, "sessions") });
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
  await writeFile(imagePath, pngFixture(768, 1024));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "生成一张科幻图" }] },
  })}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  await writeFile(imagePath, pngFixture(1024, 1024));
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

  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  // The task fallback now backfills the missing user message; it must not
  // touch the prompt or its revised provenance.
  assert.deepEqual(result.updated, ["verified-provenance"]);
  const asset = await store.getAsset("default", "verified-provenance");
  assert.equal(asset.prompt, "Verified revised prompt");
  assert.equal(asset.source.prompt_status, "image-generation-revised-prompt");
  assert.equal(asset.business_fields.prompt_status, "image-generation-revised-prompt");
  assert.equal(asset.source.codex_image_generation_call_id, "verified-call");
  assert.equal(asset.source.user_message, "Task-level fallback prompt");
  assert.equal(asset.business_fields.user_message, "Task-level fallback prompt");
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
  await writeFile(imagePath, pngFixture(640, 960));
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做一张书封" }] } },
    { type: "event_msg", timestamp: "2026-10-25T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "exec-user-msg", saved_path: imagePath, revised_prompt: "Book cover, warm palette, bold serif title." } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  await writeFile(imagePath, pngFixture(512, 512));
  const imageEvent = { type: "event_msg", timestamp: "2026-10-25T10:00:00.000Z", payload: { type: "image_generation_end", call_id: "exec-backfill", saved_path: imagePath, revised_prompt: "Book cover, warm palette, bold serif title." } };
  await writeFile(sessionPath, `${JSON.stringify(imageEvent)}\n`);

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const processedSignatures = new Map();
  const options = { store, imagesDir, sessionsDir, processedSignatures };
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

test("backfills the user message on an archived Codex image without touching prompt provenance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-codex-msg-only-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const imagesDir = join(root, "generated_images");
  const sessionsDir = join(root, "sessions");
  const taskId = "019f776f-f6d5-7692-b9e5-dd280fc09f12";
  const imagePath = join(imagesDir, taskId, "exec-msg-only.png");
  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(imagePath, pngFixture(700, 500));

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  await store.createAsset({ assetId: "msg-only", imagePath, prompt: "", sourceType: "codex-generated" });
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, `rollout-test-${taskId}.jsonl`), `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我做一张书封" }] },
  })}\n`);

  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.deepEqual(result.updated, ["msg-only"]);
  const asset = await store.getAsset("default", "msg-only");
  assert.equal(asset.source.user_message, "帮我做一张书封");
  assert.equal(asset.business_fields.user_message, "帮我做一张书封");
  assert.equal(asset.prompt, "");
  assert.notEqual(asset.source.prompt_status, "task-user-prompt");
  assert.notEqual(asset.business_fields.prompt_status, "task-user-prompt");

  const second = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
  assert.deepEqual(second.updated, []);
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
  await writeFile(imagePath, pngFixture(480, 480));

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

  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  await writeFile(imagePath, pngFixture(800, 1200));
  await writeFile(sessionPath, [
    { type: "turn_context", payload: { model: "first-model" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "First turn" }] } },
    { type: "turn_context", payload: { model: "final-model" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Final turn" }] } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir, codexImagesDir: imagesDir });
  const result = await reconcileCodexGeneratedImages({ store, imagesDir, sessionsDir });
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
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir: join(root, "sessions"), debounceMs: 10, pollIntervalMs: 100 });
  t.after(() => bridge.stop());
  await bridge.start();

  await mkdir(join(imagesDir, taskId), { recursive: true });
  await writeFile(join(imagesDir, taskId, "watch.png"), pngFixture(800, 800));
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
  await writeFile(imagePath, pngFixture(640, 480));
  await writeFile(sessionPath, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fallback prompt" }] },
  })}\n`);
  await writeFile(unrelatedPath, "{}\n");

  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager"), codexImagesDir: imagesDir });
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir, pollIntervalMs: 60_000 });
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
  for (let index = 0; index < 3; index += 1) await writeFile(join(imagesDir, `${index}.png`), pngFixture(40 + index, 30));
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
  const bridge = createCodexImageBridge({ store, imagesDir, sessionsDir: join(root, "sessions"), signal: controller.signal });
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.stop();
  assert.equal(started, 1);
  assert.equal(completed, 1, "the in-flight write is drained before shutdown");
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

function pngFixture(width, height) {
  const image = Buffer.alloc(24);
  image.write("\x89PNG\r\n\x1a\n", 0, "binary");
  image.writeUInt32BE(width, 16);
  image.writeUInt32BE(height, 20);
  return image;
}

async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Codex image bridge.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
