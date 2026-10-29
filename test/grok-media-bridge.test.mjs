import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { buildGrokAssetId, createGrokMediaBridge, reconcileGrokMedia, sha256File, __test } from "../lib/grok-media-bridge.js";

const SESSION_ID = "019f8f50-1f0d-7983-ab3f-544a0b5f7577";
const WORKSPACE = "%2Ftmp%2Fmosa-grok-fixture";

function pngFixture(width = 32, height = 24) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const ihdr = pngChunk("IHDR", ihdrData);
  const idat = pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01]));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function tinyMp4() {
  const body = Buffer.from("ftypisom\0\0\0\0isomiso2mp41", "binary");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + body.length, 0);
  return Buffer.concat([size, body]);
}

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

async function createGrokSessionFixture(root, {
  sessionId = SESSION_ID,
  workspace = WORKSPACE,
  imageName = "1.png",
  videoName = null,
  includeImage = true,
  includeChat = true,
  toolPrompt = "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图",
  userPrompt = "Call the image_gen tool with this prompt.",
  toolName = "image_gen",
  mediaRelativePath = null,
  outsideToolPath = null,
  omitMediaFile = false,
} = {}) {
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, workspace, sessionId);
  const imagesDir = join(sessionPath, "images");
  const videosDir = join(sessionPath, "videos");
  await mkdir(imagesDir, { recursive: true });
  await mkdir(videosDir, { recursive: true });
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({
    info: { id: sessionId, cwd: "/tmp/mosa-grok-fixture" },
    current_model_id: "grok-4.5",
    created_at: "2026-07-23T14:10:20.640068Z",
  }, null, 2));

  const mediaPath = mediaRelativePath
    ? resolve(sessionPath, mediaRelativePath)
    : includeImage
      ? join(imagesDir, imageName)
      : videoName
        ? join(videosDir, videoName)
        : null;

  if (mediaPath && !omitMediaFile) {
    await mkdir(join(mediaPath, ".."), { recursive: true });
    if (VIDEO_EXT.test(mediaPath)) await writeFile(mediaPath, tinyMp4());
    else await writeFile(mediaPath, pngFixture(1280, 720));
  }

  if (includeChat) {
    const callId = "call-test-media-1";
    const toolResultPath = outsideToolPath || mediaPath;
    const chat = [
      {
        type: "user",
        content: [{ type: "text", text: `<user_query>\n${userPrompt}\n</user_query>` }],
        prompt_index: 0,
      },
      {
        type: "assistant",
        content: "",
        tool_calls: [{
          id: callId,
          name: toolName,
          arguments: JSON.stringify({ prompt: toolPrompt, aspect_ratio: "16:9" }),
        }],
        model_id: "grok-4.5-build",
      },
      {
        type: "tool_result",
        tool_call_id: callId,
        content: JSON.stringify({
          path: toolResultPath,
          filename: imageName || videoName || "media.bin",
          session_folder: toolName.includes("video") ? "videos" : "images",
          message: "generated",
        }),
      },
    ];
    await writeFile(join(sessionPath, "chat_history.jsonl"), chat.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }

  return { sessionsDir, sessionPath, mediaPath, imagesDir, videosDir };
}

test("runtime handoff drains the current Grok import without starting the remaining backlog", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-handoff-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const fixture = await createGrokSessionFixture(root);
  await writeFile(join(fixture.imagesDir, "2.png"), pngFixture(40, 30));
  const store = createAssetStore({ projectRoot: join(root, "project"), managerDir: join(root, "manager") });
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
  const bridge = createGrokMediaBridge({ store, sessionsDir: fixture.sessionsDir, signal: controller.signal });
  t.after(() => bridge.stop());
  await bridge.start();
  await bridge.stop();
  assert.equal(started, 1);
  assert.equal(completed, 1);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("passes automatic ingest mode and continues after a suppressed Grok media item", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-suppressed-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const first = await createGrokSessionFixture(root, { sessionId: "019f8f50-1f0d-7983-ab3f-544a0b5f7578", imageName: "first.png" });
  const second = await createGrokSessionFixture(root, { sessionId: "019f8f50-1f0d-7983-ab3f-544a0b5f7579", imageName: "second.png" });
  await writeFile(second.mediaPath, pngFixture(640, 480));

  const calls = [];
  const store = {
    async listAssets() { return []; },
    async createAsset(params, options) {
      calls.push({ params, options });
      if (calls.length === 1) throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
      return { id: "grok-imported", ...params };
    },
  };

  const sessionsRoot = await realpath(first.sessionsDir);
  const result = await reconcileGrokMedia({ store, sessionsDir: first.sessionsDir });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.options), [
    { trustedSourceRoots: [sessionsRoot], ingestMode: "automatic" },
    { trustedSourceRoots: [sessionsRoot], ingestMode: "automatic" },
  ]);
  assert.equal(result.skipped.filter((item) => item.reason === "suppressed-after-delete").length, 1);
  assert.equal(result.imported.length, 1);
});

test("skips unchanged Grok candidates without re-querying the asset store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-signature-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const fixture = await createGrokSessionFixture(root);
  let sourceLookups = 0;
  let listCalls = 0;
  const store = {
    async listAssets() { listCalls += 1; return []; },
    async findAssetBySourcePath() {
      sourceLookups += 1;
      return { id: "existing", project_id: "default", prompt: "", theme: "", business_fields: {}, source: { path: fixture.mediaPath } };
    },
    async findAssetByContentHash() { throw new Error("content lookup should not run"); },
    async findAssetByPixelHash() { throw new Error("pixel lookup should not run"); },
    async updateMetadata() {},
    async createAsset() { throw new Error("create should not run"); },
  };
  const processedSignatures = new Map();
  const first = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir, processedSignatures });
  const second = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir, processedSignatures });
  assert.equal(first.skipped.some((item) => item.reason === "already-archived"), true);
  assert.equal(second.skipped.some((item) => item.reason === "unchanged"), true);
  assert.equal(sourceLookups, 1);
  assert.equal(listCalls, 0);
});

test("caches Grok session parsing and ignores unrelated chat mtime churn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-session-cache-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const fixture = await createGrokSessionFixture(root);
  const chatPath = join(fixture.sessionPath, "chat_history.jsonl");
  let sourceLookups = 0;
  let updates = 0;
  const store = {
    async listAssets() { return []; },
    async findAssetBySourcePath() {
      sourceLookups += 1;
      return {
        id: "existing",
        project_id: "default",
        prompt: "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图",
        theme: "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图",
        business_fields: { prompt_status: "generation-tool-prompt" },
        source: {
          path: fixture.mediaPath,
          grok_media_path: fixture.mediaPath,
          grok_session_path: fixture.sessionPath,
          grok_tool_call_id: "call-test-media-1",
          model: "grok-4.5-build",
          generation_tool: "image_gen",
          media_kind: "image",
          prompt_status: "generation-tool-prompt",
        },
      };
    },
    async updateMetadata() { updates += 1; },
    async createAsset() { throw new Error("create should not run"); },
  };
  const processedSignatures = new Map();
  const sessionMetadataCache = new Map();
  const options = { store, sessionsDir: fixture.sessionsDir, processedSignatures, sessionMetadataCache };

  await reconcileGrokMedia(options);
  const updatesAfterFirstReconcile = updates;
  const canonicalChatPath = await realpath(chatPath);
  const firstCached = sessionMetadataCache.get(canonicalChatPath)?.metadata;
  await reconcileGrokMedia(options);
  assert.equal(sessionMetadataCache.get(canonicalChatPath)?.metadata, firstCached, "unchanged JSONL must reuse parsed metadata");

  await appendFile(chatPath, `${JSON.stringify({
    type: "user",
    content: [{ type: "text", text: "<user_query>unrelated follow-up conversation</user_query>" }],
  })}\n`);
  const third = await reconcileGrokMedia(options);
  assert.equal(third.skipped.some((item) => item.reason === "unchanged"), true, "chat mtime alone must not invalidate archived media");
  assert.equal(sourceLookups, 1);
  assert.equal(updates, updatesAfterFirstReconcile, "unrelated chat churn must not write asset metadata again");
  assert.notEqual(sessionMetadataCache.get(canonicalChatPath)?.metadata, firstCached, "changed JSONL should refresh the parse cache once");
});

test("retries a deterministic Grok asset id collision through automatic identity dedupe", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-id-race-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const fixture = await createGrokSessionFixture(root);
  const assetIds = [];
  const store = {
    async listAssets() { return []; },
    async createAsset(params) {
      assetIds.push(params.assetId);
      if (assetIds.length === 1) throw Object.assign(new Error("winner reserved the compact id"), { code: "ASSET_ALREADY_EXISTS" });
      throw Object.assign(new Error("same pixels won elsewhere"), {
        code: "AUTOMATIC_INGEST_DUPLICATE",
        identityKind: "pixel",
      });
    },
  };

  const result = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(assetIds.length, 2);
  assert.notEqual(assetIds[1], assetIds[0]);
  assert.match(assetIds[1], new RegExp(`^${assetIds[0]}-[a-f0-9]{8}$`));
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, "already-archived-same-pixels");
});

test("archives Grok images with tool prompt and avoids duplicates on restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    toolPrompt: "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图",
  });
  const store = createAssetStore({ projectRoot, managerDir });

  const first = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(first.imported.length, 1);
  const asset = first.imported[0];
  assert.equal(asset.source.type, "grok-generated");
  assert.equal(asset.source.media_kind, "image");
  assert.equal(asset.source.grok_session_id, SESSION_ID);
  assert.equal(asset.source.prompt_status, "generation-tool-prompt");
  assert.equal(asset.prompt, "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图");
  assert.equal(asset.source.generation_tool, "image_gen");
  assert.equal(asset.source.model, "grok-4.5-build");
  assert.match(asset.id, /^grok-/);
  assert.match(asset.id, /image/);
  assert.match(asset.source.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(asset.business_fields.width, 1280);
  assert.equal(asset.business_fields.height, 720);

  const second = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.some((item) => item.reason === "already-archived"), true);

  const third = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir, knownHashes: null });
  assert.equal(third.imported.length, 0);
});

test("archives image and video with the same stem without id collision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const imagePath = join(sessionPath, "images", "1.png");
  const videoPath = join(sessionPath, "videos", "1.mp4");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await mkdir(join(sessionPath, "videos"), { recursive: true });
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(imagePath, pngFixture(64, 48));
  await writeFile(videoPath, tinyMp4());
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "assistant",
      tool_calls: [
        { id: "call-img", name: "image_gen", arguments: JSON.stringify({ prompt: "still mecha" }) },
        { id: "call-vid", name: "image_to_video", arguments: JSON.stringify({ prompt: "moving mecha" }) },
      ],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-img", content: JSON.stringify({ path: imagePath, filename: "1.png" }) }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-vid", content: JSON.stringify({ path: videoPath, filename: "1.mp4" }) }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 2);
  const ids = result.imported.map((asset) => asset.id).sort();
  assert.equal(new Set(ids).size, 2);
  assert.notEqual(ids[0], ids[1]);
  const video = result.imported.find((asset) => asset.source.media_kind === "video");
  assert.equal(video.source.prompt_status, "generation-tool-prompt");
  assert.equal(video.prompt, "moving mecha");
});

test("archives Grok videos without running image derivative expectations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    includeImage: false,
    videoName: "clip.mp4",
    toolName: "image_to_video",
    toolPrompt: "animate the red mecha walking through rain",
  });
  const videoPath = join(fixture.videosDir, "clip.mp4");
  await writeFile(videoPath, tinyMp4());
  await writeFile(join(fixture.sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nMake a video\n</user_query>" }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "assistant",
      content: "",
      tool_calls: [{
        id: "call-video-1",
        name: "image_to_video",
        arguments: JSON.stringify({ prompt: "animate the red mecha walking through rain", image: "images/1.jpg" }),
      }],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-video-1",
      content: JSON.stringify({ path: videoPath, filename: "clip.mp4", session_folder: "videos" }),
    }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(result.imported.length, 1);
  const asset = result.imported[0];
  assert.equal(asset.source.type, "grok-generated");
  assert.equal(asset.source.media_kind, "video");
  assert.equal(asset.source.prompt_status, "generation-tool-prompt");
  assert.equal(asset.prompt, "animate the red mecha walking through rain");
  assert.equal(asset.business_fields.mime_type, "video/mp4");
  assert.equal(asset.source.generation_tool, "image_to_video");
  assert.match(asset.asset, /\.mp4$/);
});

test("uses ordered call-scoped user fallback only for a matched tool result without tool prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const imagePath = join(sessionPath, "images", "2.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(imagePath, pngFixture(64, 64));
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nfallback user prompt for mecha poster\n</user_query>" }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "assistant",
      content: "",
      tool_calls: [{ id: "call-2", name: "image_gen", arguments: JSON.stringify({ aspect_ratio: "1:1" }) }],
      model_id: "grok-4.5",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-2",
      content: JSON.stringify({ path: imagePath, filename: "2.png", session_folder: "images" }),
    }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].prompt, "fallback user prompt for mecha poster");
  assert.equal(result.imported[0].source.prompt_status, "session-user-prompt");
});

test("does not attach a later user prompt to an earlier tool call without tool prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const firstPath = join(sessionPath, "images", "first.png");
  const secondPath = join(sessionPath, "images", "second.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(firstPath, pngFixture(32, 32));
  await writeFile(secondPath, pngFixture(36, 36));
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nprompt for first image only\n</user_query>" }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-first", name: "image_gen", arguments: JSON.stringify({ aspect_ratio: "1:1" }) }],
      model_id: "grok-4.5",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-first",
      content: JSON.stringify({ path: firstPath, filename: "first.png" }),
    }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nprompt for second image only\n</user_query>" }],
      prompt_index: 1,
    }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-second", name: "image_gen", arguments: JSON.stringify({ aspect_ratio: "1:1" }) }],
      model_id: "grok-4.5",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-second",
      content: JSON.stringify({ path: secondPath, filename: "second.png" }),
    }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 2);
  const first = result.imported.find((asset) => asset.source.grok_output_file === "first.png");
  const second = result.imported.find((asset) => asset.source.grok_output_file === "second.png");
  assert.equal(first.prompt, "prompt for first image only");
  assert.equal(first.source.prompt_status, "session-user-prompt");
  assert.equal(second.prompt, "prompt for second image only");
  assert.equal(second.source.prompt_status, "session-user-prompt");
  assert.notEqual(first.prompt, second.prompt);
  assert.equal(first.prompt.includes("second"), false);
  assert.equal(second.prompt.includes("first"), false);
});

test("orphan media is archived with not-available prompt instead of session fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const matchedPath = join(sessionPath, "images", "matched.png");
  const orphanPath = join(sessionPath, "images", "orphan.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(matchedPath, pngFixture(32, 32));
  await writeFile(orphanPath, pngFixture(40, 40));
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\nonly for the matched image\n</user_query>" }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-m", name: "image_gen", arguments: JSON.stringify({ prompt: "matched tool prompt" }) }],
      model_id: "grok-4.5",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-m",
      content: JSON.stringify({ path: matchedPath, filename: "matched.png" }),
    }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 2);
  const matched = result.imported.find((asset) => asset.source.grok_output_file === "matched.png");
  const orphan = result.imported.find((asset) => asset.source.grok_output_file === "orphan.png");
  assert.equal(matched.prompt, "matched tool prompt");
  assert.equal(matched.source.prompt_status, "generation-tool-prompt");
  assert.equal(orphan.prompt, "");
  assert.equal(orphan.source.prompt_status, "not-available");
});

test("ambiguous tool matches leave media without a wrong prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const imagePath = join(sessionPath, "images", "shared.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(imagePath, pngFixture(48, 48));
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "assistant",
      tool_calls: [
        { id: "call-a", name: "image_gen", arguments: JSON.stringify({ prompt: "prompt A" }) },
        { id: "call-b", name: "image_gen", arguments: JSON.stringify({ prompt: "prompt B" }) },
      ],
      model_id: "grok-4.5",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-a", content: JSON.stringify({ path: imagePath, filename: "shared.png" }) }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-b", content: JSON.stringify({ path: imagePath, filename: "shared.png" }) }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].prompt, "");
  assert.equal(result.imported[0].source.prompt_status, "not-available");
  assert.equal(result.warnings.some((warning) => /ambiguous/i.test(warning)), true);
});

test("records not-ready when a discovered candidate becomes unreadable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    imageName: "locked.png",
    includeChat: false,
  });
  // Windows cannot express POSIX chmod(0) read-deny, so the unreadable fault
  // is injected at the hash-read seam instead of through filesystem permissions.
  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({
    store,
    sessionsDir: fixture.sessionsDir,
    sha256FileImpl: async (filePath) => {
      const error = new Error("EACCES: permission denied, open " + filePath);
      error.code = "EACCES";
      throw error;
    },
  });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.some((item) => item.reason === "not-ready" || item.reason === "import-failed"), true);
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 0);
});

test("rejects tool-result paths and symlinks that escape the Grok sessions root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const outsideDir = join(root, "outside");
  await mkdir(outsideDir, { recursive: true });
  const outsideImage = join(outsideDir, "escape.png");
  await writeFile(outsideImage, pngFixture(40, 40));

  const fixture = await createGrokSessionFixture(root, {
    outsideToolPath: outsideImage,
    toolPrompt: "should not attach to outside path",
  });

  // Symlink planted inside the session images tree pointing outside the root.
  const symlinkPath = join(fixture.imagesDir, "linked-escape.png");
  await symlink(outsideImage, symlinkPath);

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.notEqual(result.imported[0].source.grok_media_path, outsideImage);
  assert.equal(result.imported[0].source.prompt_status, "not-available");
  assert.equal(result.skipped.some((item) => item.reason === "symlink-rejected" || item.reason === "out-of-root"), true);
  assert.equal(result.warnings.some((warning) => /rejected tool_result path|out-of-root|symlink/i.test(warning)), true);

  await assert.rejects(
    () => store.createAsset({ imagePath: outsideImage, prompt: "nope" }),
    /outside the project roots|Unsupported/,
  );
});

test("deduplicates by content hash and can upgrade provenance from a later Grok path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    imageName: "1.png",
    includeChat: false,
  });
  const store = createAssetStore({ projectRoot, managerDir });
  const first = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(first.imported.length, 1);
  assert.equal(first.imported[0].source.prompt_status, "not-available");

  const copyPath = join(fixture.imagesDir, "1-copy.png");
  await writeFile(copyPath, await readFile(fixture.mediaPath));
  await writeFile(join(fixture.sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-copy", name: "image_gen", arguments: JSON.stringify({ prompt: "upgraded tool prompt" }) }],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-copy",
      content: JSON.stringify({ path: copyPath, filename: "1-copy.png" }),
    }),
  ].join("\n") + "\n");

  const second = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(second.imported.length, 0);
  assert.equal(second.skipped.some((item) => item.reason === "already-archived-same-content"), true);
  assert.equal(second.updated.length >= 1, true);
  const upgraded = await store.getAsset("default", first.imported[0].id);
  assert.equal(upgraded.prompt, "upgraded tool prompt");
  assert.equal(upgraded.source.prompt_status, "generation-tool-prompt");
});

test("bridge start/stop reports health fields and metadata warnings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root);
  // Inject a malformed chat line into an otherwise valid history.
  await writeFile(join(fixture.sessionPath, "chat_history.jsonl"), [
    "{not-json",
    ...(await readFile(join(fixture.sessionPath, "chat_history.jsonl"), "utf8")).split("\n").filter(Boolean),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const bridge = createGrokMediaBridge({
    store,
    sessionsDir: fixture.sessionsDir,
    pollIntervalMs: 60_000,
    debounceMs: 10,
  });
  // Stop the bridge in t.after so watchers/pollers are always cleaned up even
  // if an assertion throws. Without this, a failed assert leaves fs.watch and
  // setInterval alive and the test process never exits.
  t.after(() => { bridge.stop(); rm(root, { recursive: true, force: true }); });
  const status = await bridge.start();
  assert.equal(status.enabled, true);
  assert.equal(status.sessionsDir, resolve(fixture.sessionsDir));
  assert.equal(typeof status.totalImported, "number");
  assert.ok(status.totalImported >= 1);
  assert.equal(status.lastError, null);
  assert.match(String(status.lastWarning || ""), /malformed/i);
  bridge.stop();
  assert.equal(bridge.status().enabled, false);
  assert.equal(bridge.status().polling, false);
});

test("buildGrokAssetId distinguishes media kind, normalized-equivalent names, and long names", () => {
  const imageId = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "image",
    fileName: "1.png",
    relativePath: `${SESSION_ID}/images/1.png`,
  });
  const videoId = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "video",
    fileName: "1.mp4",
    relativePath: `${SESSION_ID}/videos/1.mp4`,
  });
  assert.notEqual(imageId, videoId);
  assert.match(imageId, /image/);
  assert.match(videoId, /video/);

  const spaced = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "image",
    fileName: "a b.png",
    relativePath: `${SESSION_ID}/images/a b.png`,
  });
  const dashed = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "image",
    fileName: "a-b.png",
    relativePath: `${SESSION_ID}/images/a-b.png`,
  });
  assert.notEqual(spaced, dashed);

  const longA = `prefix-${"x".repeat(80)}-tail-a.png`;
  const longB = `prefix-${"x".repeat(80)}-tail-b.png`;
  const longIdA = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "image",
    fileName: longA,
    relativePath: `${SESSION_ID}/images/${longA}`,
  });
  const longIdB = buildGrokAssetId({
    sessionId: SESSION_ID,
    mediaKind: "image",
    fileName: longB,
    relativePath: `${SESSION_ID}/images/${longB}`,
  });
  assert.notEqual(longIdA, longIdB);
  assert.ok(longIdA.length <= 96);
  assert.ok(longIdB.length <= 96);
});

test("rejects symlinked chat_history or summary outside the sessions root", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    toolPrompt: "should remain unavailable when chat is unsafe",
  });
  const outsideChat = join(root, "outside-chat.jsonl");
  await writeFile(outsideChat, [
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-out", name: "image_gen", arguments: JSON.stringify({ prompt: "leaked outside prompt" }) }],
      model_id: "grok-4.5",
    }),
    JSON.stringify({
      type: "tool_result",
      tool_call_id: "call-out",
      content: JSON.stringify({ path: fixture.mediaPath, filename: "1.png" }),
    }),
  ].join("\n") + "\n");
  await rm(join(fixture.sessionPath, "chat_history.jsonl"), { force: true });
  await symlink(outsideChat, join(fixture.sessionPath, "chat_history.jsonl"));

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].prompt, "");
  assert.equal(result.imported[0].source.prompt_status, "not-available");
  assert.equal(result.warnings.some((warning) => /chat_history\.jsonl.*symlink/i.test(warning)), true);
});

test("rejects session when summary.json is an out-of-root symlink even with safe chat_history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root, {
    toolPrompt: "must not leak when summary is unsafe",
  });
  const outsideSummary = join(root, "outside-summary.json");
  await writeFile(outsideSummary, JSON.stringify({ current_model_id: "leaked-model" }));
  await rm(join(fixture.sessionPath, "summary.json"), { force: true });
  await symlink(outsideSummary, join(fixture.sessionPath, "summary.json"));

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].prompt, "");
  assert.equal(result.imported[0].source.prompt_status, "not-available");
  assert.notEqual(result.imported[0].source.model, "leaked-model");
  assert.equal(result.imported[0].source.model == null || result.imported[0].source.model === "", true);
  assert.equal(result.warnings.some((warning) => /summary\.json.*symlink/i.test(warning)), true);

  const summaryCheck = await __test.assertSafeSessionFile(join(fixture.sessionPath, "summary.json"), resolve(fixture.sessionsDir));
  assert.equal(summaryCheck.ok, false);
  assert.equal(summaryCheck.reason, "symlink-rejected");
});

test("records the user message current at each Grok tool call", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-user-msg-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const firstPath = join(sessionPath, "images", "cover.png");
  const secondPath = join(sessionPath, "images", "poster.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(firstPath, pngFixture(64, 48));
  await writeFile(secondPath, pngFixture(48, 64));
  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\n帮我做一张书封\n</user_query>" }],
      prompt_index: 0,
    }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-cover", name: "image_gen", arguments: JSON.stringify({ prompt: "cover illustration, warm palette" }) }],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-cover", content: JSON.stringify({ path: firstPath, filename: "cover.png" }) }),
    JSON.stringify({
      type: "user",
      content: [{ type: "text", text: "<user_query>\n再画一张同风格的海报\n</user_query>" }],
      prompt_index: 1,
    }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-poster", name: "image_gen", arguments: JSON.stringify({ prompt: "poster artwork, cool palette" }) }],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-poster", content: JSON.stringify({ path: secondPath, filename: "poster.png" }) }),
  ].join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const result = await reconcileGrokMedia({ store, sessionsDir });
  assert.equal(result.imported.length, 2);
  const cover = result.imported.find((asset) => asset.source.grok_output_file === "cover.png");
  const poster = result.imported.find((asset) => asset.source.grok_output_file === "poster.png");
  assert.equal(cover.source.user_message, "帮我做一张书封");
  assert.equal(cover.business_fields.user_message, "帮我做一张书封");
  assert.equal(cover.prompt, "cover illustration, warm palette");
  assert.equal(poster.source.user_message, "再画一张同风格的海报");
  assert.equal(poster.business_fields.user_message, "再画一张同风格的海报");
  assert.equal(poster.prompt, "poster artwork, cool palette");
});

test("reprocesses an archived Grok image when the chat gains a user message and writes the backfill once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-backfill-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const sessionsDir = join(root, "sessions");
  const sessionPath = join(sessionsDir, WORKSPACE, SESSION_ID);
  const imagePath = join(sessionPath, "images", "sig.png");
  await mkdir(join(sessionPath, "images"), { recursive: true });
  await writeFile(join(sessionPath, "summary.json"), JSON.stringify({ info: { id: SESSION_ID }, current_model_id: "grok-4.5" }));
  await writeFile(imagePath, pngFixture(64, 48));
  const assistant = {
    type: "assistant",
    tool_calls: [{ id: "call-sig", name: "image_gen", arguments: JSON.stringify({ prompt: "sig tool prompt" }) }],
    model_id: "grok-4.5-build",
  };
  const toolResult = { type: "tool_result", tool_call_id: "call-sig", content: JSON.stringify({ path: imagePath, filename: "sig.png" }) };
  await writeFile(join(sessionPath, "chat_history.jsonl"), [assistant, toolResult].map((row) => JSON.stringify(row)).join("\n") + "\n");

  const store = createAssetStore({ projectRoot, managerDir });
  const processedSignatures = new Map();
  const options = { store, sessionsDir, processedSignatures };
  const first = await reconcileGrokMedia(options);
  assert.equal(first.imported.length, 1);
  const assetId = first.imported[0].id;
  assert.equal(first.imported[0].source.user_message, null);
  assert.equal(first.imported[0].business_fields.user_message, null);

  await writeFile(join(sessionPath, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\n给机器人画一张海报\n</user_query>" }], prompt_index: 0 }),
    JSON.stringify(assistant),
    JSON.stringify(toolResult),
  ].join("\n") + "\n");
  const second = await reconcileGrokMedia(options);
  assert.deepEqual(second.updated, [assetId]);
  const backfilled = await store.getAsset("default", assetId);
  assert.equal(backfilled.source.user_message, "给机器人画一张海报");
  assert.equal(backfilled.business_fields.user_message, "给机器人画一张海报");
  assert.equal(backfilled.prompt, "sig tool prompt");
  assert.equal(backfilled.source.prompt_status, "generation-tool-prompt");

  const third = await reconcileGrokMedia(options);
  assert.deepEqual(third.updated, []);
});

test("keeps an existing Grok user message even when the chat has a newer one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-keep-msg-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const fixture = await createGrokSessionFixture(root);
  const store = createAssetStore({ projectRoot, managerDir });
  const first = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.equal(first.imported.length, 1);
  const assetId = first.imported[0].id;
  assert.equal(first.imported[0].source.user_message, "Call the image_gen tool with this prompt.");

  await writeFile(join(fixture.sessionPath, "chat_history.jsonl"), [
    JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\n换一条新指令再画一张\n</user_query>" }], prompt_index: 0 }),
    JSON.stringify({
      type: "assistant",
      tool_calls: [{ id: "call-test-media-1", name: "image_gen", arguments: JSON.stringify({ prompt: "一只红色机甲在雨夜城市中行走，电影级灯光，横向构图", aspect_ratio: "16:9" }) }],
      model_id: "grok-4.5-build",
    }),
    JSON.stringify({ type: "tool_result", tool_call_id: "call-test-media-1", content: JSON.stringify({ path: fixture.mediaPath, filename: "1.png" }) }),
  ].join("\n") + "\n");

  const second = await reconcileGrokMedia({ store, sessionsDir: fixture.sessionsDir });
  assert.deepEqual(second.updated, []);
  const asset = await store.getAsset("default", assetId);
  assert.equal(asset.source.user_message, "Call the image_gen tool with this prompt.");
  assert.equal(asset.business_fields.user_message, "Call the image_gen tool with this prompt.");
});

test("sha256File streams file contents instead of loading the whole file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-hash-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const filePath = join(root, "payload.bin");
  const payload = Buffer.alloc(256 * 1024, 7);
  await writeFile(filePath, payload);
  const streamed = await sha256File(filePath);
  const direct = createHash("sha256").update(payload).digest("hex");
  assert.equal(streamed, direct);
  assert.equal(typeof createReadStream, "function");
  const source = await readFile(new URL("../lib/grok-media-bridge.ts", import.meta.url), "utf8");
  // Confirm sha256File streams via createReadStream + pipeline rather than
  // loading the whole file (which would blow memory on large media).
  // The source may have multiple functions, so locate sha256File's body
  // explicitly rather than scanning the whole file.
  const shaMatch = source.match(/(?:async\s+)?function sha256File\([^)]*\)[^{]*\{([\s\S]*?)\}\s*$/m);
  assert.ok(shaMatch, "sha256File function definition should be present");
  const body = shaMatch[1];
  assert.match(body, /createReadStream\(filePath\)/, "sha256File should stream via createReadStream(filePath)");
  assert.match(body, /pipeline\(createReadStream\(filePath\),\s*hash\)/, "sha256File should pipe through pipeline(..., hash) rather than loading bytes");
  assert.doesNotMatch(body, /readFile\(filePath/, "sha256File must not load the whole file via readFile");
});

test("keeps user-edited prompts across Grok reconciliation while untouched assets still upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-grok-user-edit-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library") });
  t.after(() => store.close?.());
  await store.ensureProject("default");

  const fixtureA = await createGrokSessionFixture(root, {
    sessionId: "019f8f50-1f0d-7983-ab3f-544a0b5f7571",
    workspace: "%2Ftmp%2Fmosa-grok-user-edit-a",
    imageName: "edit.png",
    toolPrompt: "original tool prompt for the edited image",
  });
  const fixtureB = await createGrokSessionFixture(root, {
    sessionId: "019f8f50-1f0d-7983-ab3f-544a0b5f7572",
    workspace: "%2Ftmp%2Fmosa-grok-user-edit-b",
    imageName: "keep.png",
    toolPrompt: "original tool prompt for the untouched image",
  });
  // Distinct pixels so the two assets do not dedupe against each other.
  await writeFile(fixtureA.mediaPath, pngFixture(640, 480));
  await writeFile(fixtureB.mediaPath, pngFixture(800, 600));

  const first = await reconcileGrokMedia({ store, sessionsDir: root });
  assert.equal(first.imported.length, 2);
  const assetA = first.imported.find((asset) => asset.source.grok_session_id === "019f8f50-1f0d-7983-ab3f-544a0b5f7571");
  const assetB = first.imported.find((asset) => asset.source.grok_session_id === "019f8f50-1f0d-7983-ab3f-544a0b5f7572");
  assert.ok(assetA && assetB);

  // The UI PATCH entry point: stamp markers the way lib/api/asset-routes.mjs does.
  await store.updateMetadata("default", assetA.id, withUserEditMarkers(
    await store.getAsset("default", assetA.id),
    { prompt: "USER EDIT: red mech in the rain", theme: "用户起的名字" },
  ));

  const rewriteChat = async (fixture, toolPrompt) => {
    const chatPath = join(fixture.sessionPath, "chat_history.jsonl");
    const rows = (await readFile(chatPath, "utf8")).trim().split("\n").map((row) => JSON.parse(row));
    for (const row of rows) {
      if (row.type === "assistant" && Array.isArray(row.tool_calls)) {
        for (const call of row.tool_calls) {
          const args = JSON.parse(call.arguments || "{}");
          args.prompt = toolPrompt;
          call.arguments = JSON.stringify(args);
        }
      }
    }
    await writeFile(chatPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  };
  await rewriteChat(fixtureA, "revised tool prompt for the edited image");
  await rewriteChat(fixtureB, "revised tool prompt for the untouched image");

  const second = await reconcileGrokMedia({ store, sessionsDir: root });
  assert.deepEqual(second.updated, [assetB.id], "only the untouched asset is rewritten");
  const afterA = await store.getAsset("default", assetA.id);
  const afterB = await store.getAsset("default", assetB.id);
  assert.equal(afterA.prompt, "USER EDIT: red mech in the rain", "the user edit must survive reconciliation");
  assert.equal(afterA.theme, "用户起的名字", "the user rename must survive reconciliation");
  assert.equal(afterB.prompt, "revised tool prompt for the untouched image", "the untouched asset must still follow the session");
  assert.ok(afterA.source.prompt_user_edited_at);
  assert.ok(afterA.source.theme_user_edited_at);
});
