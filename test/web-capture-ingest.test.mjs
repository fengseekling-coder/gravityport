import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { removeTestPath as rm, deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { createReferenceAttachmentStore } from "../lib/reference-attachment-store.js";
import {
  cleanupWebCaptureTemp,
  createWebCaptureIngest,
  ingestWebCapture,
  WEB_CAPTURE_MAX_BODY_BYTES,
  WEB_CAPTURE_MAX_IMAGE_BYTES,
  WEB_CAPTURE_MAX_VIDEO_BYTES,
} from "../lib/web-capture-ingest.js";
import { isAllowedIngestOrigin, parseAllowedIngestOrigins } from "../lib/server-security.js";

// High-entropy raster so compressed size exceeds the logo gate (~20KiB).
const SAMPLE_PNG_BASE64 = await (async () => {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
})();

test("web capture temp cleanup removes stale crash leftovers without touching fresh files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-temp-cleanup-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const tempRoot = join(root, ".web-capture-tmp");
  await mkdir(tempRoot, { recursive: true });
  const stale = join(tempRoot, "chatgpt-stale.png");
  const fresh = join(tempRoot, "chatgpt-fresh.png");
  await writeFile(stale, "stale");
  await writeFile(fresh, "fresh");
  const now = Date.now();
  const staleTime = new Date(now - 48 * 60 * 60 * 1000);
  await utimes(stale, staleTime, staleTime);
  const removed = await cleanupWebCaptureTemp(tempRoot, { ttlMs: 24 * 60 * 60 * 1000, now: () => now });
  assert.equal(removed, 1);
  assert.deepEqual(await readdir(tempRoot), ["chatgpt-fresh.png"]);
});

const LOGO_PNG_BASE64 = (
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 220, g: 30, b: 30 } },
  })
    .png()
    .toBuffer()
).toString("base64");

function sampleMp4Bytes() {
  const bytes = Buffer.alloc(96 * 1024, 0);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0x200, 12);
  bytes.write("isom", 16, "ascii");
  bytes.write("mp42", 20, "ascii");
  return bytes;
}

test("allows only configured extension origins for ingest routes", () => {
  const allowed = parseAllowedIngestOrigins("chrome-extension://abcdef,moz-extension://firefox");
  assert.equal(isAllowedIngestOrigin(undefined, 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("http://127.0.0.1:43517", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://abcdef", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("moz-extension://firefox", 43517, allowed), true);
  assert.equal(isAllowedIngestOrigin("chrome-extension://other", 43517, allowed), false);
  assert.equal(isAllowedIngestOrigin("https://chatgpt.com", 43517, allowed), false);
});

test("request body budget includes a maximum-size base64 image envelope", () => {
  const imageBase64 = Buffer.alloc(WEB_CAPTURE_MAX_IMAGE_BYTES).toString("base64");
  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    provider: "chatgpt",
    imageBase64,
    mimeType: "image/jpeg",
  }));
  assert.ok(envelopeBytes < WEB_CAPTURE_MAX_BODY_BYTES);
  assert.ok(WEB_CAPTURE_MAX_BODY_BYTES - envelopeBytes > 512 * 1024);
});

test("request body budget also covers supported generated video captures", () => {
  const videoBase64 = Buffer.alloc(WEB_CAPTURE_MAX_VIDEO_BYTES).toString("base64");
  const envelopeBytes = Buffer.byteLength(JSON.stringify({
    provider: "flow",
    mediaKind: "video",
    mediaBase64: videoBase64,
    mimeType: "video/mp4",
  }));
  assert.ok(envelopeBytes < WEB_CAPTURE_MAX_BODY_BYTES);
});

test("ingests Flow generated video bytes and dedupes them by content hash", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-video-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const mediaBase64 = sampleMp4Bytes().toString("base64");

  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "flow",
      mediaKind: "video",
      mediaBase64,
      mimeType: "video/mp4",
      prompt: "play_circle Cinematic camera move across a futuristic city at dusk",
      prompt_status: "provider-visible-prompt",
      prompt_source: "flow-visible-prompt",
      width: 1280,
      height: 720,
      durationSeconds: 8,
      pageUrl: "https://labs.google/fx/tools/flow/demo",
    },
  });
  assert.equal(first.status, "imported");
  assert.equal(first.asset.source?.provider, "flow");
  assert.equal(first.asset.source?.media_kind, "video");
  assert.equal(first.asset.business_fields?.media_kind, "video");
  assert.equal(first.asset.business_fields?.mime_type, "video/mp4");
  // sampleMp4Bytes() has no moov, so the file read fails and the
  // page-reported values are kept as the fallback.
  assert.equal(first.asset.business_fields?.width, 1280);
  assert.equal(first.asset.business_fields?.height, 720);
  assert.equal(first.asset.business_fields?.duration_seconds, 8);
  assert.equal(first.asset.theme, "Cinematic camera move across a futuristic city at dusk");
  assert.match(first.asset.asset, /\.mp4$/);

  const second = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "flow", mediaKind: "video", mediaBase64, mimeType: "video/mp4" },
  });
  assert.equal(second.status, "skipped");
  assert.equal(second.reason, "already-archived-same-content");
  assert.equal(second.asset.id, first.asset.id);
});

test("reads video dimensions and duration from the captured file, not the page-reported values", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-video-file-meta-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  // A real MP4 (72x128, ~2 s) with page-reported values that disagree: the
  // Jimeng page reports no dimensions at all and a rounded-up duration.
  const fixtureBytes = await readFile(join(import.meta.dirname, "fixtures", "video-metadata", "capture-72x128.mp4"));
  const mediaBase64 = fixtureBytes.toString("base64");
  const imported = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "jimeng", mediaKind: "video", mediaBase64, mimeType: "video/mp4", durationSeconds: 7 },
  });
  assert.equal(imported.status, "imported");
  assert.equal(imported.asset.business_fields?.width, 72);
  assert.equal(imported.asset.business_fields?.height, 128);
  assert.equal(imported.asset.business_fields?.duration_seconds, 2);

  // Non-zero page values that disagree with the file lose to the file too.
  const conflicting = Buffer.concat([fixtureBytes, Buffer.from("different-content")]);
  const second = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "jimeng", mediaKind: "video", mediaBase64: conflicting.toString("base64"), mimeType: "video/mp4", width: 1000, height: 1000, durationSeconds: 30 },
  });
  assert.equal(second.status, "imported");
  assert.equal(second.asset.business_fields?.width, 72);
  assert.equal(second.asset.business_fields?.height, 128);
  assert.equal(second.asset.business_fields?.duration_seconds, 2);
});

test("rejects video capture from unsupported providers and mismatched bytes", async () => {
  const store = { createAsset: async () => { throw new Error("must not create"); }, listAssets: async () => [] };
  const mediaBase64 = sampleMp4Bytes().toString("base64");
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-video-provider", input: { provider: "chatgpt", mediaKind: "video", mediaBase64, mimeType: "video/mp4" } }),
    (error) => error?.code === "WEB_CAPTURE_BAD_VIDEO_PROVIDER",
  );
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-video-mime", input: { provider: "flow", mediaKind: "video", mediaBase64: Buffer.alloc(96 * 1024).toString("base64"), mimeType: "video/mp4" } }),
    (error) => error?.code === "WEB_CAPTURE_MIME_MISMATCH",
  );
});

test("ingests chatgpt web capture bytes and dedupes by content hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-capture-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  // Force sqlite path by creating completed migration marker via store bootstrap helper:
  // createSqliteAssetStore works directly for unit tests.
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir,
  });

  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        prompt: "Model caption: A poster-style vector illustration travel poster of Bangkok with bold typography, limited red and cream palette, geometric flat layout.",
        prompt_status: "generation-tool-prompt",
        prompt_scope: "output",
        generation_status: "completed",
        user_message: "做一张曼谷海报",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        pageUrl: "https://chatgpt.com/c/demo",
        conversationId: "demo",
        messageId: "turn-42",
        generationContextId: "chatgpt:demo:call-web-42",
        providerToolCallId: "call-web-42",
        providerResponseId: "resp-web-42",
        providerAssetId: "file-web-42",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.source?.type, "web-chatgpt");
    assert.match(first.asset.prompt, /poster-style vector illustration/i);
    assert.equal(first.asset.source?.provider, "chatgpt");
    assert.equal(first.asset.source?.user_message, "做一张曼谷海报");
    assert.equal(first.asset.source?.capture_session_id, "chatgpt:demo");
    assert.equal(first.asset.source?.generation_batch_id, "chatgpt:demo:turn-42");
    assert.equal(first.asset.source?.provider_tool_call_id, "call-web-42");
    assert.equal(first.asset.source?.provider_generation_call_id, null);
    assert.equal(first.asset.source?.prompt_scope, "output");
    assert.equal(first.asset.source?.generation_status, "completed");
    assert.equal(first.asset.business_fields?.prompt_scope, "output");
    assert.equal(first.asset.business_fields?.generation_status, "completed");
    const [generation] = await store.listGenerationEvents("default", { captureContextId: "chatgpt:demo:call-web-42" });
    assert.equal(generation.provider_tool_call_id, "call-web-42");
    assert.equal(generation.provider_generation_call_id, "");
    assert.equal(generation.provider_response_id, "resp-web-42");
    assert.equal(generation.prompt_scope, "output");
    assert.equal(generation.generation_status, "completed");
    assert.equal(generation.verification_level, "observed");
    assert.ok(first.contentHash);

    const second = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        prompt: "duplicate upload",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
      },
    });
    assert.equal(second.status, "skipped");
    assert.equal(second.reason, "already-archived-same-content");
    assert.equal(second.asset.id, first.asset.id);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicated ChatGPT output advances generation status from partial to completed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-generation-status-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const baseInput = {
    provider: "chatgpt",
    imageBase64: SAMPLE_PNG_BASE64,
    mimeType: "image/jpeg",
    conversationId: "status-conversation",
    messageId: "status-message",
    generationContextId: "chatgpt:status-conversation:call-status",
    providerToolCallId: "call-status",
    providerGenerationCallId: "gen-status",
    providerAssetId: "file-status",
    prompt_scope: "attempt",
  };

  const partial = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { ...baseInput, generation_status: "partial", capturedAt: "2026-08-31T00:00:00.000Z" },
  });
  assert.equal(partial.status, "imported");
  assert.equal(partial.asset.source?.generation_status, "partial");

  const completed = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { ...baseInput, generation_status: "completed", capturedAt: "2026-08-31T00:00:01.000Z" },
  });
  assert.equal(completed.status, "skipped");
  assert.equal(completed.reason, "already-archived-recipe-merged");
  assert.equal(completed.asset.source?.generation_status, "completed");
  assert.equal(completed.asset.business_fields?.generation_status, "completed");
  const events = await store.listGenerationEvents("default", { assetId: partial.asset.id });
  assert.equal(events.length, 1);
  assert.equal(events[0].generation_status, "completed");
  assert.equal(events[0].provider_generation_call_id, "gen-status");
});

test("re-observing an archived image without any identifier adds no generation event", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reident-unmarked-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");

  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      conversationId: "reident-conversation",
      messageId: "turn-first",
      generationContextId: "chatgpt:reident-conversation:call-first",
      providerAssetId: "file-first",
    },
  });
  assert.equal(first.status, "imported");

  // The pre-#142 bug: a page re-observation of the same pixels with no
  // provider identity appended a phantom generation record on every capture.
  const reObservation = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      user_message: "some nearby turn's text",
      capturedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  assert.equal(reObservation.status, "skipped");
  assert.ok(String(reObservation.reason || "").startsWith("already-archived"), `unexpected reason: ${reObservation.reason}`);
  const events = await store.listGenerationEvents("default", { assetId: first.asset.id });
  assert.equal(events.length, 1, "the unidentified re-observation must not append a generation record");
});

test("re-observing an archived image with a message id still records the generation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reident-marked-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");

  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      conversationId: "marked-conversation",
      messageId: "turn-a",
      generationContextId: "chatgpt:marked-conversation:call-a",
      providerAssetId: "file-a",
      capturedAt: "2026-09-01T00:00:00.000Z",
    },
  });
  assert.equal(first.status, "imported");

  const reObservation = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      conversationId: "marked-conversation",
      messageId: "turn-b",
      generationContextId: "chatgpt:marked-conversation:call-b",
      providerAssetId: "file-b",
      capturedAt: "2026-09-01T01:00:00.000Z",
    },
  });
  assert.equal(reObservation.status, "skipped");
  const events = await store.listGenerationEvents("default", { assetId: first.asset.id });
  assert.equal(events.length, 2, "an identified re-observation records its generation as before");
  assert.deepEqual(events.map((event) => event.message_id).sort(), ["turn-a", "turn-b"]);
});

test("completed ChatGPT bytes replace an earlier provisional asset with the same provider asset id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-provisional-replace-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const providerAssetId = "file-progressive-output";
  const provisionalBytes = await noiseImage(221);
  const finalBytes = await noiseImage(222);

  const provisional = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: provisionalBytes.toString("base64"),
      mimeType: "image/png",
      conversationId: "progressive-conversation",
      messageId: "progressive-message",
      generationContextId: "chatgpt:progressive-conversation:call-progressive",
      providerGenerationCallId: "gen-progressive",
      providerAssetId,
      generationStatus: "in_progress",
      capturedAt: "2026-09-03T20:00:00.000Z",
    },
  });
  assert.equal(provisional.status, "imported");

  const completed = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: finalBytes.toString("base64"),
      mimeType: "image/png",
      conversationId: "progressive-conversation",
      messageId: "progressive-message",
      generationContextId: "chatgpt:progressive-conversation:call-progressive",
      providerGenerationCallId: "gen-progressive",
      providerAssetId,
      generationStatus: "completed",
      capturedAt: "2026-09-03T20:00:05.000Z",
    },
  });
  assert.equal(completed.status, "imported");
  assert.equal(completed.replacedAssetId, provisional.asset.id);
  assert.equal(completed.asset.id, provisional.asset.id, "terminal media upgrades preserve the logical asset id");
  const assets = await store.listAssets({ projectId: "default" });
  const logical = assets.filter((asset) => asset.source?.provider_asset_id === providerAssetId);
  assert.equal(logical.length, 1);
  assert.equal(logical[0].id, completed.asset.id);
  assert.equal(logical[0].source?.generation_status, "completed");
  assert.notEqual(logical[0].source?.content_sha256, provisional.asset.source?.content_sha256);
});

for (const terminalStatus of ["failed", "cancelled"]) {
  test(`${terminalStatus} ChatGPT output keeps the final visible bytes on the same logical asset`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-web-${terminalStatus}-replace-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    const libraryDir = join(root, "library");
    await mkdir(libraryDir, { recursive: true });
    const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
    t.after(() => store.close?.());
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const providerAssetId = `file-${terminalStatus}-visible-output`;
    const provisional = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(231)).toString("base64"),
        mimeType: "image/png",
        providerAssetId,
        generationStatus: "in_progress",
      },
    });
    const terminal = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(232)).toString("base64"),
        mimeType: "image/png",
        providerAssetId,
        generationStatus: terminalStatus,
      },
    });
    assert.equal(terminal.status, "imported");
    assert.equal(terminal.asset.id, provisional.asset.id);
    assert.equal(terminal.asset.source?.generation_status, terminalStatus);
    assert.notEqual(terminal.asset.source?.content_sha256, provisional.asset.source?.content_sha256);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  });
}

test("output-scoped URL fallback upgrades one ChatGPT output without collapsing siblings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-output-url-fallback-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const common = {
    provider: "chatgpt",
    mimeType: "image/png",
    conversationId: "multi-output-conversation",
    messageId: "multi-output-message",
    generationContextId: "chatgpt:multi-output-conversation:call-multi",
    providerGenerationCallId: "gen-multi",
  };
  const firstUrl = "https://images.openai.com/output-a.png?id=output-a";
  const secondUrl = "https://images.openai.com/output-b.png?id=output-b";
  const first = await ingestWebCapture({
    store,
    tempRoot,
    input: {
      ...common,
      imageBase64: (await noiseImage(241)).toString("base64"),
      sourceMediaUrl: firstUrl,
      generationStatus: "in_progress",
    },
  });
  const sibling = await ingestWebCapture({
    store,
    tempRoot,
    input: {
      ...common,
      imageBase64: (await noiseImage(242)).toString("base64"),
      sourceMediaUrl: secondUrl,
      generationStatus: "completed",
    },
  });
  const terminal = await ingestWebCapture({
    store,
    tempRoot,
    input: {
      ...common,
      imageBase64: (await noiseImage(243)).toString("base64"),
      sourceMediaUrl: firstUrl,
      generationStatus: "completed",
    },
  });
  assert.equal(terminal.asset.id, first.asset.id);
  assert.notEqual(sibling.asset.id, first.asset.id);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 2);
});

test("concurrent provisional and terminal captures serialize one logical provider asset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-logical-concurrency-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const providerAssetId = "file-concurrent-logical-output";
  const provisionalPromise = ingestWebCapture({
    store,
    tempRoot,
    input: {
      provider: "chatgpt",
      imageBase64: (await noiseImage(244)).toString("base64"),
      mimeType: "image/png",
      providerAssetId,
      generationStatus: "in_progress",
    },
  });
  const terminalPromise = ingestWebCapture({
    store,
    tempRoot,
    input: {
      provider: "chatgpt",
      imageBase64: (await noiseImage(245)).toString("base64"),
      mimeType: "image/png",
      providerAssetId,
      generationStatus: "completed",
    },
  });
  const [provisional, terminal] = await Promise.all([provisionalPromise, terminalPromise]);
  assert.equal(terminal.asset.id, provisional.asset.id);
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].source?.generation_status, "completed");
  assert.equal(assets[0].source?.provider_asset_id, providerAssetId);
});

test("metadata-only provider Prompt upgrade preserves media identity and asset count", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-metadata-upgrade-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "metadata-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });
  const sourceMediaUrl = "https://flow-content.google/output.png?media_id=metadata-output";
  const initial = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(246)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl,
    promptStatus: "not-available",
    generationStatus: "completed",
  }, "metadata-secret");
  const originalPath = initial.asset.image_path;
  const originalHash = initial.asset.source?.content_sha256;
  const upgraded = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl,
    prompt: "A precise Flow prompt recovered after the media was already archived.",
    promptStatus: "provider-visible-prompt",
    promptSource: "flow-visible-prompt",
    promptPriority: 50,
    generationStatus: "completed",
  }, "metadata-secret");
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.asset.id, initial.asset.id);
  assert.equal(upgraded.asset.image_path, originalPath);
  assert.equal(upgraded.asset.source?.content_sha256, originalHash);
  assert.match(upgraded.asset.prompt, /precise Flow prompt/);
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
});

test("records a reliable capture session without inventing a generation batch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-session-only-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  let created;
  let createOptions;
  const store = {
    createAsset: async (input, options) => { created = input; createOptions = options; return { id: input.assetId, ...input, source: { ...input.source } }; },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  await ingestWebCapture({
    store,
    tempRoot: join(root, "capture"),
    input: {
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      conversationId: "conversation-without-turn",
      captureMode: "manual",
    },
  });
  assert.equal(created.source.capture_session_id, "chatgpt:conversation-without-turn");
  assert.equal(created.source.message_id, null);
  assert.equal(created.source.generation_batch_id, null);
  assert.equal(created.source.capture_mode, "manual");
  assert.equal(created.business_fields.auto_archived, false);
  assert.equal(created.business_fields.capture_mode, "manual");
  assert.ok(created.tags.includes("manual-capture"));
  assert.equal(created.tags.includes("auto-archived"), false);
  assert.deepEqual(createOptions, { trustedSourceRoots: [join(root, "capture")], ingestMode: "manual" });
});

test("skips suppressed web captures and removes their temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-suppressed-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const tempRoot = join(root, "capture");
  let createOptions;
  const store = {
    createAsset: async (_input, options) => {
      createOptions = options;
      throw Object.assign(new Error("suppressed"), { code: "AUTOMATIC_IMPORT_SUPPRESSED" });
    },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const result = await ingestWebCapture({
    store,
    tempRoot,
    input: { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" },
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "suppressed-after-delete");
  assert.ok(result.contentHash);
  assert.deepEqual(createOptions, { trustedSourceRoots: [tempRoot], ingestMode: "automatic" });
  assert.deepEqual(await readdir(tempRoot), []);
});

test("accepts the allowlisted generic providers with provider-derived metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-providers-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const expected = [
    ["gemini", "Gemini", "web-gemini", "Gemini web capture"],
    ["flow", "Flow", "web-flow", "Flow web capture"],
    ["google-ai-studio", "Google AI Studio", "web-google-ai-studio", "Google AI Studio web capture"],
  ];

  for (const [index, [provider, label, sourceType, skill]] of expected.entries()) {
    let created;
    const store = {
      createAsset: async (input) => { created = input; return { id: input.assetId, ...input, source: { ...input.source } }; },
      listAssets: async () => [],
      findAssetByContentHash: async () => null,
    };
    const image = await noiseImage(index + 20);
    await ingestWebCapture({
      store,
      tempRoot: join(root, provider),
      input: { provider, imageBytes: image, mimeType: "image/png" },
    });

    assert.equal(created.sourceType, sourceType);
    assert.equal(created.source.type, sourceType);
    assert.equal(created.source.provider, provider);
    assert.equal(created.skill, skill);
    assert.equal(created.theme, `${label} web image`);
    assert.deepEqual(created.tags, [provider, "web-capture", "auto-archived"]);
    assert.match(created.fileName, new RegExp(`^${provider}-[0-9]+-[a-f0-9]{8}\\.png$`));
    assert.match(created.assetId, new RegExp(`^web-${provider}-[a-f0-9]{12}$`));
  }
});

test("persists Gemini, Flow, and AI Studio provider-visible prompts as unverified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-flow-prompt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const image = await noiseImage(42);
  const created = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      created.push(asset);
      return asset;
    },
    listAssets: async () => created,
    findAssetByContentHash: async (_projectId, hash) => created.find((asset) => asset.source?.content_sha256 === hash) || null,
    updateMetadata: async (_projectId, assetId, metadata) => {
      const asset = created.find((entry) => entry.id === assetId);
      Object.assign(asset, metadata, { source: { ...asset.source, ...(metadata.source || {}) }, business_fields: { ...asset.business_fields, ...(metadata.business_fields || {}) } });
      return asset;
    },
  };

  const flow = await ingestWebCapture({
    store,
    tempRoot: join(root, "flow"),
    input: {
      provider: "flow",
      imageBytes: image,
      mimeType: "image/png",
      prompt: "A visible Flow prompt for a cinematic mountain landscape",
      prompt_status: "provider-visible-prompt",
      prompt_source: "flow-visible-composer",
    },
  });
  assert.equal(flow.status, "imported");
  assert.equal(flow.asset.prompt, "A visible Flow prompt for a cinematic mountain landscape");
  assert.equal(flow.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(flow.asset.source?.prompt_source, "flow-visible-composer");
  assert.equal(flow.asset.business_fields?.prompt_status, "provider-visible-prompt");

  const aiStudio = await ingestWebCapture({
    store,
    tempRoot: join(root, "google-ai-studio"),
    input: {
      provider: "google-ai-studio",
      imageBytes: await noiseImage(101),
      mimeType: "image/png",
      prompt: "A visible AI Studio user prompt associated with the image turn",
      prompt_status: "provider-visible-prompt",
      prompt_source: "google-ai-studio-visible-user-prompt",
    },
  });
  assert.equal(aiStudio.status, "imported");
  assert.equal(aiStudio.asset.prompt, "A visible AI Studio user prompt associated with the image turn");
  assert.equal(aiStudio.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(aiStudio.asset.source?.prompt_source, "google-ai-studio-visible-user-prompt");

  const gemini = await ingestWebCapture({
    store,
    tempRoot: join(root, "gemini"),
    input: {
      provider: "gemini",
      imageBytes: await noiseImage(149),
      mimeType: "image/png",
      prompt: "A visible Gemini user prompt structurally associated with the image",
      prompt_status: "provider-visible-prompt",
      prompt_source: "gemini-visible-user-prompt",
    },
  });
  assert.equal(gemini.status, "imported");
  assert.equal(gemini.asset.prompt, "A visible Gemini user prompt structurally associated with the image");
  assert.equal(gemini.asset.source?.prompt_status, "provider-visible-prompt");
  assert.equal(gemini.asset.source?.prompt_source, "gemini-visible-user-prompt");

  // An unrelated provider cannot claim the Google visible-prompt status.
  const other = await ingestWebCapture({
    store,
    tempRoot: join(root, "chatgpt"),
    input: {
      provider: "chatgpt",
      imageBytes: await noiseImage(150),
      mimeType: "image/png",
      prompt: "This must not be persisted",
      prompt_status: "provider-visible-prompt",
      prompt_source: "gemini-visible-user-prompt",
    },
  });
  assert.equal(other.status, "imported");
  assert.equal(other.asset.prompt, "");
  assert.equal(other.asset.source?.prompt_status, "not-available");
  assert.equal(other.asset.source?.prompt_source, "gemini-visible-user-prompt");
});

test("does not let a Flow-only prompt upgrade a same-image asset from another provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-flow-prompt-dedupe-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const image = await noiseImage(44);
  const assets = [];
  const store = {
    createAsset: async (input) => {
      const asset = { id: input.assetId, project_id: "default", ...input, source: { ...input.source } };
      assets.push(asset);
      return asset;
    },
    listAssets: async () => assets,
    findAssetByContentHash: async (_projectId, hash) => assets.find((asset) => asset.source?.content_sha256 === hash) || null,
    updateMetadata: async (_projectId, assetId, metadata) => {
      const asset = assets.find((entry) => entry.id === assetId);
      Object.assign(asset, metadata, { source: { ...asset.source, ...(metadata.source || {}) }, business_fields: { ...asset.business_fields, ...(metadata.business_fields || {}) } });
      return asset;
    },
  };
  const first = await ingestWebCapture({
    store,
    tempRoot: join(root, "chatgpt"),
    input: { provider: "chatgpt", imageBytes: image, mimeType: "image/png" },
  });
  const repeat = await ingestWebCapture({
    store,
    tempRoot: join(root, "flow"),
    input: {
      provider: "flow",
      imageBytes: image,
      mimeType: "image/png",
      prompt: "Do not cross provider boundary",
      prompt_status: "provider-visible-prompt",
    },
  });
  assert.equal(repeat.status, "skipped");
  assert.equal(repeat.upgraded, false);
  assert.equal(repeat.asset.id, first.asset.id);
  assert.equal(repeat.asset.prompt, "");
  assert.equal(repeat.asset.source?.provider, "chatgpt");
  assert.deepEqual(
    repeat.asset.source?.capture_occurrences?.map((entry) => entry.provider),
    ["chatgpt", "flow"],
  );
});

test("rejects provider values outside the exact allowlist", async () => {
  const store = {
    createAsset: async () => { throw new Error("must not create an asset"); },
    listAssets: async () => [],
  };
  await assert.rejects(
    () => ingestWebCapture({ store, tempRoot: "/tmp/mosa-web-provider-invalid", input: { provider: "google-ai-studio.example", imageBase64: SAMPLE_PNG_BASE64 } }),
    (error) => error?.statusCode === 400 && error?.code === "WEB_CAPTURE_BAD_PROVIDER",
  );
});

test("archives one asset when the same picture arrives in two encodings", async () => {
  // The extension uploads either the file ChatGPT served or a canvas re-encode
  // of it. Same pixels, different bytes — the file hash alone imported both.
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  const servedPng = await sharp(raw, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  // What a browser canvas produces: an opaque alpha channel, lighter compression.
  const canvasPng = await sharp(raw, { raw: { width, height, channels: 3 } })
    .ensureAlpha()
    .png({ compressionLevel: 3 })
    .toBuffer();
  assert.notEqual(servedPng.toString("base64"), canvasPng.toString("base64"));

  const root = await mkdtemp(join(tmpdir(), "mosa-web-pixels-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const served = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { provider: "chatgpt", imageBase64: servedPng.toString("base64"), mimeType: "image/png" },
    });
    assert.equal(served.status, "imported");
    assert.ok(served.asset.source?.pixel_sha256);

    const reEncoded = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { provider: "chatgpt", imageBase64: canvasPng.toString("base64"), mimeType: "image/png" },
    });
    assert.equal(reEncoded.status, "skipped");
    assert.equal(reEncoded.reason, "already-archived-same-pixels");
    assert.equal(reEncoded.asset.id, served.asset.id);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent web captures still import identical content only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-concurrent-dedupe-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const capture = createWebCaptureIngest({
      store,
      libraryDir,
      projectId: "default",
      token: "test-token",
      allowedOrigins: ["chrome-extension://test"],
    });
    const input = { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" };
    const results = await Promise.all([
      capture.ingest(input, "test-token"),
      capture.ingest(input, "test-token"),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["imported", "skipped"]);
    assert.equal(results.find((result) => result.status === "skipped")?.reason, "already-archived-same-content");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("web capture uses bounded parallel ingest slots instead of one global queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-parallel-ingest-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const originalCreateAsset = store.createAsset.bind(store);
    let activeCreates = 0;
    let peakCreates = 0;
    store.createAsset = async (...args) => {
      activeCreates += 1;
      peakCreates = Math.max(peakCreates, activeCreates);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 60));
      try {
        return await originalCreateAsset(...args);
      } finally {
        activeCreates -= 1;
      }
    };
    const capture = createWebCaptureIngest({
      store,
      libraryDir,
      projectId: "default",
      token: "test-token",
      allowedOrigins: ["chrome-extension://test"],
    });
    const inputs = await Promise.all(Array.from({ length: 6 }, async (_, index) => ({
      provider: "chatgpt",
      imageBase64: (await noiseImage(80 + index)).toString("base64"),
      mimeType: "image/png",
    })));
    const results = await Promise.all(inputs.map((input) => capture.ingest(input, "test-token")));
    assert.equal(results.every((result) => result.status === "imported"), true);
    assert.ok(peakCreates > 1, `expected parallel creates, saw peak ${peakCreates}`);
    assert.ok(peakCreates <= 4, `ingest pool exceeded its concurrency cap: ${peakCreates}`);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("independent web capture queues remain idempotent for the same deterministic asset id", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-independent-race-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const input = { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" };
    const results = await Promise.all([
      ingestWebCapture({ store, tempRoot, projectId: "default", input }),
      ingestWebCapture({ store, tempRoot, projectId: "default", input }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), ["imported", "skipped"]);
    assert.equal(results.find((result) => result.status === "skipped")?.reason, "already-archived-same-content");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("archives a reference as a deduplicated attachment without adding a library asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reference-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const reference = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        is_reference: true,
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        user_message: "Use the uploaded photo as the exact identity reference.",
        conversationId: "reference-demo",
        providerAssetId: "file-reference-demo",
        capturedAt: "2026-08-13T10:00:00.000Z",
      },
    });
    assert.equal(reference.status, "imported");
    assert.equal(reference.asset, undefined);
    assert.match(reference.attachment.id, /^ref-[a-f0-9]{24}$/);
    assert.equal(reference.attachment.conversation_id, "reference-demo");
    assert.equal(reference.attachment.provider_asset_id, "file-reference-demo");
    assert.match(reference.attachment.attachment_url, /^\/library\/default\/references\//);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
    assert.deepEqual(await readFile(join(libraryDir, "reference-attachments", "default", "files", reference.attachment.file_name)), Buffer.from(SAMPLE_PNG_BASE64, "base64"));

    // The same upload arriving again (another URL variant) must not add a row.
    const repeat = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        is_reference: true,
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
      },
    });
    assert.equal(repeat.status, "skipped");
    assert.equal(repeat.reason, "reference-already-archived-same-content");
    assert.equal(repeat.attachment.id, reference.attachment.id);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 0);

    const generation = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBytes: await noiseImage(77),
        mimeType: "image/png",
        conversationId: "reference-demo",
        capturedAt: "2026-08-13T10:01:00.000Z",
      },
    });
    assert.equal(generation.status, "imported");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
    assert.equal(generation.asset.references.length, 1);
    assert.equal(generation.asset.references[0].reference_id, reference.attachment.id);
    assert.equal(generation.asset.references[0].attachment_url, reference.attachment.attachment_url);
    assert.equal(generation.asset.references[0].provider_asset_id, "file-reference-demo");
    const history = await store.getRecipeSnapshotHistory("default", generation.asset.id);
    assert.equal(history.snapshots[0].references[0].attachment_url, reference.attachment.attachment_url);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("generation contexts keep one reference blob but record every use and bind every output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-reference-context-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const referenceBytes = await noiseImage(81);
    const saveReference = (generationContextId, capturedAt, providerAssetId = "") => ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: referenceBytes,
        mimeType: "image/png",
        conversationId: "context-demo",
        messageId: `user-${generationContextId}`,
        generationContextId,
        providerAssetId,
        capturedAt,
      },
    });
    const firstReference = await saveReference("chatgpt:context-demo:gen-a", "2026-08-20T10:00:00.000Z");
    const enrichedReference = await saveReference("chatgpt:context-demo:gen-a", "2026-08-20T10:00:01.000Z", "file-reference-a");
    assert.equal(enrichedReference.status, "skipped", "late provider metadata enriches the existing reference instead of creating another blob");
    assert.equal(enrichedReference.attachment.provider_asset_id, "file-reference-a");
    assert.equal(enrichedReference.attachment.usages[0].provider_asset_id, "file-reference-a");

    const output = async (seed, generationContextId, capturedAt) => ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: await noiseImage(seed),
        mimeType: "image/png",
        conversationId: "context-demo",
        messageId: generationContextId.endsWith("gen-a") ? "tool-a" : "tool-b",
        generationContextId,
        capturedAt,
      },
    });

    const firstOutput = await output(82, "chatgpt:context-demo:gen-a", "2026-08-20T10:01:00.000Z");
    const secondOutput = await output(83, "chatgpt:context-demo:gen-a", "2026-08-20T10:01:01.000Z");
    assert.deepEqual(firstOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id]);
    assert.deepEqual(secondOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id], "every output in one generation context keeps the references");
    assert.equal(firstOutput.asset.references[0].provider_asset_id, "file-reference-a");
    assert.equal(firstOutput.asset.references[0].application_status, "observed_input");
    assert.equal(firstOutput.asset.references[0].verification_level, "observed");

    const repeatedReference = await saveReference("chatgpt:context-demo:gen-b", "2026-08-20T10:05:00.000Z", "file-reference-b");
    assert.equal(repeatedReference.status, "skipped", "the physical reference file remains deduplicated");
    assert.equal(repeatedReference.attachment.id, firstReference.attachment.id);
    assert.deepEqual(repeatedReference.attachment.usages.map((usage) => usage.generation_context_id), [
      "chatgpt:context-demo:gen-a",
      "chatgpt:context-demo:gen-b",
    ]);

    const thirdOutput = await output(84, "chatgpt:context-demo:gen-b", "2026-08-20T10:06:00.000Z");
    assert.deepEqual(thirdOutput.asset.references.map((item) => item.reference_id), [firstReference.attachment.id], "reusing the same reference in a later generation remains traceable");
    assert.equal(thirdOutput.asset.references[0].provider_asset_id, "file-reference-b", "relation evidence uses the provider asset ID from this generation context, not the attachment's first-ever ID");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 3, "reference usages never become gallery assets");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("deduplicated output preserves a new generation recipe and reference set", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-duplicate-recipe-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const firstReference = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: await noiseImage(91),
        mimeType: "image/png",
        conversationId: "duplicate-recipe",
        generationContextId: "chatgpt:duplicate-recipe:gen-a",
        capturedAt: "2026-08-20T11:00:00.000Z",
      },
    });
    const outputBytes = await noiseImage(92);
    const firstOutput = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: outputBytes,
        mimeType: "image/png",
        prompt: "first recipe prompt with cinematic lighting and detailed composition",
        prompt_status: "generation-tool-prompt",
        conversationId: "duplicate-recipe",
        messageId: "tool-a",
        generationContextId: "chatgpt:duplicate-recipe:gen-a",
        capturedAt: "2026-08-20T11:01:00.000Z",
      },
    });
    const secondReference = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        isReference: true,
        imageBytes: await noiseImage(93),
        mimeType: "image/png",
        conversationId: "duplicate-recipe",
        generationContextId: "chatgpt:duplicate-recipe:gen-b",
        capturedAt: "2026-08-20T11:05:00.000Z",
      },
    });
    const duplicateOutput = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBytes: outputBytes,
        mimeType: "image/png",
        prompt: "second recipe prompt with rainy night atmosphere and neon reflections",
        prompt_status: "generation-tool-prompt",
        conversationId: "duplicate-recipe",
        messageId: "tool-b",
        generationContextId: "chatgpt:duplicate-recipe:gen-b",
        capturedAt: "2026-08-20T11:06:00.000Z",
      },
    });

    assert.equal(firstOutput.status, "imported");
    assert.equal(duplicateOutput.status, "skipped");
    assert.equal(duplicateOutput.recipeMerged, true);
    assert.equal(duplicateOutput.asset.id, firstOutput.asset.id);
    assert.deepEqual(duplicateOutput.asset.references.map((item) => item.reference_id), [secondReference.attachment.id]);
    const history = await store.getRecipeSnapshotHistory("default", firstOutput.asset.id);
    assert.ok(history.snapshots.some((snapshot) => snapshot.references.some((item) => item.reference_id === firstReference.attachment.id)));
    assert.ok(history.snapshots.some((snapshot) => snapshot.references.some((item) => item.reference_id === secondReference.attachment.id)));
    assert.ok(history.snapshots.some((snapshot) => snapshot.effective_prompt.includes("first recipe prompt")));
    assert.ok(history.snapshots.some((snapshot) => snapshot.effective_prompt.includes("second recipe prompt")));
    assert.ok(history.snapshots.some((snapshot) => snapshot.provenance.capture_context_id === "chatgpt:duplicate-recipe:gen-a"));
    assert.ok(history.snapshots.some((snapshot) => snapshot.provenance.capture_context_id === "chatgpt:duplicate-recipe:gen-b"));
    assert.ok(history.snapshots.every((snapshot) => snapshot.provenance.provider_generation_call_id === ""));
    const generationEvents = await store.listGenerationEvents("default", { assetId: firstOutput.asset.id });
    assert.equal(generationEvents.length, 2, "one deduplicated asset keeps both generation occurrences");
    assert.deepEqual(generationEvents.map((event) => event.capture_context_id), [
      "chatgpt:duplicate-recipe:gen-a",
      "chatgpt:duplicate-recipe:gen-b",
    ]);
    assert.ok(generationEvents.every((event) => event.verification_level === "observed"));
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1, "identical output bytes remain one gallery asset");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("small valid reference images bypass output-logo size filtering", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-small-reference-"));
  const small = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 24, g: 48, b: 72, alpha: 1 } } }).png().toBuffer();
  assert.ok(small.length < 20 * 1024, "fixture must exercise the reference exception");
  let createCalls = 0;
  const store = {
    createAsset: async () => { createCalls += 1; throw new Error("reference must not become an asset"); },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };
  try {
    const result = await ingestWebCapture({
      store,
      tempRoot: join(root, "tmp"),
      input: { provider: "chatgpt", isReference: true, imageBytes: small, mimeType: "image/png", generationContextId: "small-ref-context" },
    });
    assert.equal(result.status, "imported");
    assert.equal(createCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects tiny logo images, blanks unbound short prompts, and preserves user instructions separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-logo-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBase64: LOGO_PNG_BASE64, mimeType: "image/png", prompt: "在做一版 香港 的" },
      }),
      /too small|IMAGE_TOO_SMALL/i,
    );

    const result = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "在做一版 香港 的",
        user_message: "在做一版 香港 的",
      },
    });
    assert.equal(result.status, "imported");
    assert.equal(result.asset.prompt, "");
    assert.equal(result.asset.source?.prompt_status, "not-available");
    assert.equal(result.asset.source?.user_message, "在做一版 香港 的");

    const userInstructionUpdate = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "生成一张 西藏 的",
        prompt_status: "user-message",
        prompt_source: "awaiting-generation-caption",
        user_message: "生成一张 西藏 的",
      },
    });
    // A re-observation with no binding evidence must not swap in another turn's
    // instruction: the first archived instruction stays and nothing is rewritten.
    assert.equal(userInstructionUpdate.status, "skipped");
    assert.equal(userInstructionUpdate.upgraded, false);
    assert.equal(userInstructionUpdate.asset.prompt, "");
    assert.equal(userInstructionUpdate.asset.source?.prompt_status, "not-available");
    assert.equal(userInstructionUpdate.asset.source?.prompt_source, result.asset.source?.prompt_source);
    assert.equal(userInstructionUpdate.asset.source?.user_message, "在做一版 香港 的");

    const upgraded = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "red sun",
        prompt_status: "generation-tool-prompt",
      },
    });
    assert.equal(upgraded.status, "skipped");
    assert.equal(upgraded.upgraded, true);
    assert.equal(upgraded.asset.prompt, "red sun");
    assert.equal(upgraded.asset.source?.prompt_status, "generation-tool-prompt");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("re-observing an archived ChatGPT image keeps its first user instruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const imageBase64 = (await noiseImage(401)).toString("base64");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64,
        mimeType: "image/png",
        user_message: "画一张夜晚的城市",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.source?.user_message, "画一张夜晚的城市");
    const snapshotsBefore = (await store.getRecipeSnapshotHistory("default", first.asset.id)).snapshots.length;

    const reobserved = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64,
        mimeType: "image/png",
        user_message: "给这只猫做成3D角色",
      },
    });
    assert.equal(reobserved.status, "skipped");
    assert.equal(reobserved.upgraded, false);
    assert.equal(reobserved.asset.source?.user_message, "画一张夜晚的城市");
    assert.equal(reobserved.asset.business_fields?.user_message, "画一张夜晚的城市");
    assert.equal(
      (await store.getRecipeSnapshotHistory("default", first.asset.id)).snapshots.length,
      snapshotsBefore,
      "a rejected instruction rewrite must not add a recipe snapshot",
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty instruction is filled and a strict completion is accepted on re-observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-fill-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");

    const unfilled = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { provider: "chatgpt", imageBase64: (await noiseImage(402)).toString("base64"), mimeType: "image/png" },
    });
    assert.equal(unfilled.status, "imported");
    assert.equal(unfilled.asset.source?.user_message, null);

    const filled = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(402)).toString("base64"),
        mimeType: "image/png",
        user_message: "画一张夜晚的城市",
      },
    });
    assert.equal(filled.status, "skipped");
    assert.equal(filled.upgraded, true);
    assert.equal(filled.asset.source?.user_message, "画一张夜晚的城市");
    assert.equal(filled.asset.business_fields?.user_message, "画一张夜晚的城市");

    const started = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(403)).toString("base64"),
        mimeType: "image/png",
        user_message: "画一张猫",
      },
    });
    assert.equal(started.status, "imported");

    const extended = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(403)).toString("base64"),
        mimeType: "image/png",
        user_message: "画一张猫，背景是夜晚的城市",
      },
    });
    assert.equal(extended.status, "skipped");
    assert.equal(extended.upgraded, true);
    assert.equal(extended.asset.source?.user_message, "画一张猫，背景是夜晚的城市");
    assert.equal(extended.asset.business_fields?.user_message, "画一张猫，背景是夜晚的城市");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt upgrade keeps the archived user instruction when the new one is unrelated", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-prompt-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const imageBase64 = (await noiseImage(404)).toString("base64");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64,
        mimeType: "image/png",
        user_message: "画一张夜晚的城市",
      },
    });
    assert.equal(first.status, "imported");

    const upgraded = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64,
        mimeType: "image/png",
        prompt: "Model caption: A neon-lit city skyline reflected in a rainy street.",
        prompt_status: "visible-caption",
        user_message: "给这只猫做成3D角色",
      },
    });
    assert.equal(upgraded.status, "skipped");
    assert.equal(upgraded.upgraded, true);
    assert.match(upgraded.asset.prompt, /neon-lit city skyline/i);
    assert.equal(upgraded.asset.source?.prompt_status, "visible-caption");
    assert.equal(upgraded.asset.source?.user_message, "画一张夜晚的城市");
    assert.equal(upgraded.asset.business_fields?.user_message, "画一张夜晚的城市");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("merging a later generation occurrence keeps the archived user instruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-merge-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const baseInput = {
      provider: "chatgpt",
      imageBase64: (await noiseImage(405)).toString("base64"),
      mimeType: "image/png",
      conversationId: "merge-user-message-conversation",
      messageId: "merge-user-message-message",
      generationContextId: "chatgpt:merge-user-message-conversation:call-merge",
      providerToolCallId: "call-merge",
      providerAssetId: "file-merge-user-message",
    };
    const partial = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { ...baseInput, generation_status: "partial", user_message: "画一张夜晚的城市" },
    });
    assert.equal(partial.status, "imported");
    assert.equal(partial.asset.source?.user_message, "画一张夜晚的城市");

    const completed = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: { ...baseInput, generation_status: "completed", user_message: "给这只猫做成3D角色" },
    });
    assert.equal(completed.status, "skipped");
    assert.equal(completed.reason, "already-archived-recipe-merged");
    assert.equal(completed.recipeMerged, true);
    assert.equal(completed.asset.source?.generation_status, "completed");
    assert.equal(completed.asset.source?.user_message, "画一张夜晚的城市");
    assert.equal(completed.asset.business_fields?.user_message, "画一张夜晚的城市");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a new image still records its own user instruction", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-new-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const cat = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(406)).toString("base64"),
        mimeType: "image/png",
        user_message: "画一张猫",
      },
    });
    const dog = await ingestWebCapture({
      store,
      tempRoot,
      projectId: "default",
      input: {
        provider: "chatgpt",
        imageBase64: (await noiseImage(407)).toString("base64"),
        mimeType: "image/png",
        user_message: "画一条狗",
      },
    });
    assert.equal(cat.status, "imported");
    assert.equal(dog.status, "imported");
    assert.equal(cat.asset.source?.user_message, "画一张猫");
    assert.equal(dog.asset.source?.user_message, "画一条狗");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider prompt priority prevents a later lower-quality generation field from downgrading an archived prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-prompt-priority-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    const first = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "provider revised prompt",
        prompt_status: "generation-tool-prompt",
        prompt_source: "revised_prompt",
        prompt_priority: 700,
        generationContextId: "chatgpt:test:revised",
      },
    });
    assert.equal(first.status, "imported");
    assert.equal(first.asset.prompt, "provider revised prompt");
    assert.equal(first.asset.business_fields?.prompt_priority, 700);

    const lower = await ingestWebCapture({
      store,
      tempRoot,
      input: {
        provider: "chatgpt",
        imageBase64: SAMPLE_PNG_BASE64,
        mimeType: "image/jpeg",
        prompt: "a much longer generation prompt that arrived later but comes from a lower-priority provider field and must not replace revised_prompt",
        prompt_status: "generation-tool-prompt",
        prompt_source: "generation_prompt",
        prompt_priority: 650,
        generationContextId: "chatgpt:test:lower",
      },
    });
    assert.equal(lower.status, "skipped");
    assert.equal(lower.asset.prompt, "provider revised prompt");
    assert.equal(lower.asset.business_fields?.prompt_priority, 700);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("web capture token gate rejects bad credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-token-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const disabled = createWebCaptureIngest({ store, libraryDir, token: "", allowedOrigins: ["chrome-extension://approved"] });
    assert.equal(disabled.status().enabled, false);
    assert.equal(disabled.status().tokenConfigured, false);
    assert.deepEqual(disabled.status().providers, ["chatgpt", "gemini", "flow", "google-ai-studio", "jimeng", "midjourney"]);
    await assert.rejects(
      () => disabled.ingest({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64 }, ""),
      (error) => error?.statusCode === 503 && error?.code === "WEB_CAPTURE_DISABLED",
    );

    const ingest = createWebCaptureIngest({
      store,
      libraryDir,
      token: "secret-token",
      allowedOrigins: ["chrome-extension://approved"],
    });
    assert.equal(ingest.status().enabled, true);
    await assert.rejects(
      () => ingest.ingest({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64 }, "wrong"),
      /Unauthorized/,
    );
    const ok = await ingest.ingest({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      prompt: "token ok",
    }, "secret-token");
    assert.equal(ok.status, "imported");
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("web capture status bridge exposes only bounded queue diagnostics and retry requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-status-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const ingest = createWebCaptureIngest({
      store,
      libraryDir,
      token: "status-secret",
      allowedOrigins: ["chrome-extension://approved"],
    });
    assert.throws(
      () => ingest.updateClientStatus({ pending: 1 }, "wrong"),
      /Unauthorized/,
    );
    const reported = ingest.updateClientStatus({
      pending: 1,
      failed: 1,
      items: [{
        id: "capture-1",
        provider: "chatgpt",
        mediaKind: "image",
        promptStatus: "not-available",
        generationStatus: "completed",
        createdAt: 123,
        updatedAt: 456,
        attempts: 2,
        lastError: "MOSA temporarily unavailable",
        prompt: "must not cross the status bridge",
        pageUrl: "https://example.invalid/private",
      }],
    }, "status-secret");
    assert.deepEqual(reported, { ok: true, retryRequestId: 0 });
    const bridgeStatus = ingest.status();
    assert.equal(bridgeStatus.queue.pending, 1);
    assert.equal(bridgeStatus.queue.failed, 1);
    assert.deepEqual(bridgeStatus.queue.items[0], {
      id: "capture-1",
      provider: "chatgpt",
      mediaKind: "image",
      promptStatus: "not-available",
      generationStatus: "completed",
      createdAt: 123,
      updatedAt: 456,
      attempts: 2,
      lastError: "MOSA temporarily unavailable",
    });
    assert.equal(JSON.stringify(bridgeStatus.queue).includes("must not cross"), false);
    assert.equal(JSON.stringify(bridgeStatus.queue).includes("example.invalid"), false);
    assert.deepEqual(ingest.requestRetry(), { ok: true, retryRequestId: 1 });
    assert.equal(ingest.status().retryRequestId, 1);
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("validates decoded image bytes, declared MIME, size, and pixel limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-image-validation-"));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  try {
    await store.ensureProject("default");
    const tempRoot = join(libraryDir, ".web-capture-tmp");
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/png" },
      }),
      (error) => error?.code === "WEB_CAPTURE_MIME_MISMATCH",
    );
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: Buffer.alloc(24 * 1024, 7), mimeType: "image/png" },
      }),
      (error) => error?.code === "WEB_CAPTURE_BAD_IMAGE_BYTES",
    );
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: Buffer.alloc(WEB_CAPTURE_MAX_IMAGE_BYTES + 1), mimeType: "image/png" },
      }),
      (error) => error?.statusCode === 413 && error?.code === "WEB_CAPTURE_IMAGE_TOO_LARGE",
    );

    const oversizedPng = await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="6500" height="6500"><rect width="100%" height="100%" fill="red"/></svg>',
    )).png().toBuffer();
    const paddedOversizedPng = Buffer.concat([
      oversizedPng,
      Buffer.alloc(Math.max(0, 20 * 1024 - oversizedPng.length)),
    ]);
    await assert.rejects(
      () => ingestWebCapture({
        store,
        tempRoot,
        input: { provider: "chatgpt", imageBytes: paddedOversizedPng, mimeType: "image/png" },
      }),
      (error) => error?.statusCode === 413 && error?.code === "WEB_CAPTURE_PIXEL_LIMIT",
    );
  } finally {
    store.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP ingest endpoint accepts chrome-extension origin with token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-http-"));
  const sessionsDir = join(root, "sessions");
  const libraryDir = join(root, "library");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "empty.jsonl"), "\n");

  // Force SQLite runtime so the server does not fall back to the repo JSON assets tree.
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.ensureProject("default");
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      MOSA_WEB_CAPTURE_TOKEN: "test-token",
      MOSA_WEB_CAPTURE_ORIGINS: "chrome-extension://abc123",
      MOSA_WEB_CAPTURE_PAIR: "auto",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      // A wedged server would otherwise hang the whole suite instead of
      // failing. Re-applied from ea347c6 after a wholesale file copy from the
      // retired checkout reverted it.
      const forceKill = setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
      }, 5_000);
      try {
        const [, signal] = await exited;
        assert.notEqual(signal, "SIGKILL", "MOSA test server did not shut down within 5 seconds");
      } finally {
        clearTimeout(forceKill);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  const extensionHealth = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { origin: "chrome-extension://abc123" },
  });
  assert.equal(extensionHealth.status, 200, "approved extension origin can discover MOSA through health");
  assert.equal(extensionHealth.headers.get("access-control-allow-origin"), "chrome-extension://abc123");
  assert.equal((await extensionHealth.json()).product, "mosa");

  const blockedExtensionHealth = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { origin: "chrome-extension://other" },
  });
  assert.equal(blockedExtensionHealth.status, 403, "unapproved extension origins stay blocked from health");
  await blockedExtensionHealth.arrayBuffer();

  const blocked = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://chatgpt.com",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
    }),
  });
  assert.equal(blocked.status, 403);
  await blocked.arrayBuffer();

  const unapprovedExtension = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://other",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ provider: "chatgpt", imageBase64: SAMPLE_PNG_BASE64, mimeType: "image/jpeg" }),
  });
  assert.equal(unapprovedExtension.status, 403);
  await unapprovedExtension.arrayBuffer();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer wrong",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
    }),
  });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  assert.equal(unauthorized.headers.get("access-control-allow-origin"), "chrome-extension://abc123");

  const blockedPairing = await fetch(`http://127.0.0.1:${port}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://other", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(blockedPairing.status, 403);
  await blockedPairing.arrayBuffer();

  const paired = await fetch(`http://127.0.0.1:${port}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://abc123", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(paired.status, 200);
  assert.equal(paired.headers.get("access-control-allow-origin"), "chrome-extension://abc123");
  assert.deepEqual(await paired.json(), { product: "mosa", token: "test-token" });

  const imported = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      prompt: "Model caption: A detailed travel poster illustration with bold typography and limited color palette for Hong Kong skyline.",
      prompt_status: "generation-tool-prompt",
      user_message: "在做一版 香港 的",
      imageBase64: SAMPLE_PNG_BASE64,
      mimeType: "image/jpeg",
      pageUrl: "https://chatgpt.com/c/test",
    }),
  });
  assert.equal(imported.status, 201);
  const body = await imported.json();
  assert.equal(body.status, "imported");
  assert.equal(body.asset?.source?.type, "web-chatgpt");
  assert.match(body.asset?.prompt || "", /Hong Kong/i);
  assert.equal(body.asset?.source?.user_message, "在做一版 香港 的");

  const binaryImage = await noiseImage(72);
  const binaryMetadata = Buffer.from(JSON.stringify({
    provider: "chatgpt",
    mediaKind: "image",
    mimeType: "image/png",
    pageUrl: "https://chatgpt.com/c/binary-test",
    sourceMediaUrl: "https://images.openai.com/binary-test.png?id=asset-1&sig=secret#fragment",
    finalMediaUrl: "https://cdn.example.invalid/binary-test.png?X-Goog-Signature=secret&mediaId=media-2",
  }), "utf8");
  const binaryHeader = Buffer.alloc(4);
  binaryHeader.writeUInt32BE(binaryMetadata.length, 0);
  const binaryImported = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-binary`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: Buffer.concat([binaryHeader, binaryMetadata, binaryImage]),
  });
  assert.equal(binaryImported.status, 201);
  const binaryBody = await binaryImported.json();
  assert.equal(binaryBody.status, "imported");
  assert.equal(binaryBody.asset?.source?.capture_occurrences?.[0]?.source_media_url, "https://images.openai.com/binary-test.png?id=asset-1");
  assert.equal(binaryBody.asset?.source?.capture_occurrences?.[0]?.final_media_url, "https://cdn.example.invalid/binary-test.png?mediaId=media-2");

  const streamedVideo = sampleMp4Bytes();
  const streamedChunks = [
    streamedVideo.subarray(0, 32 * 1024),
    streamedVideo.subarray(32 * 1024, 64 * 1024),
    streamedVideo.subarray(64 * 1024),
  ];
  const uploadBegin = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/begin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      totalBytes: streamedVideo.length,
      totalChunks: streamedChunks.length,
      metadata: {
        provider: "flow",
        mediaKind: "video",
        mimeType: "video/mp4",
        prompt: "A streamed Flow video",
        prompt_status: "provider-visible-prompt",
        prompt_source: "flow-visible-prompt",
      },
    }),
  });
  assert.equal(uploadBegin.status, 201);
  const { uploadId } = await uploadBegin.json();
  assert.ok(uploadId);

  const outOfOrderChunk = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/chunk`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
      "x-mosa-upload-id": uploadId,
      "x-mosa-chunk-index": "1",
    },
    body: streamedChunks[1],
  });
  assert.equal(outOfOrderChunk.status, 409, "stream upload rejects out-of-order chunks without advancing state");
  await outOfOrderChunk.arrayBuffer();

  for (const [index, chunk] of streamedChunks.entries()) {
    const chunkResponse = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/chunk`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        origin: "chrome-extension://abc123",
        authorization: "Bearer test-token",
        "x-mosa-upload-id": uploadId,
        "x-mosa-chunk-index": String(index),
      },
      body: chunk,
    });
    assert.equal(chunkResponse.status, 200);
    await chunkResponse.arrayBuffer();
  }
  const uploadCommit = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ uploadId }),
  });
  const uploadCommitText = await uploadCommit.text();
  assert.equal(uploadCommit.status, 201, uploadCommitText);
  const uploadBody = JSON.parse(uploadCommitText);
  assert.equal(uploadBody.status, "imported");
  assert.equal(uploadBody.asset?.source?.provider, "flow");
  assert.equal(uploadBody.asset?.business_fields?.file_bytes, streamedVideo.length);
  const uploadTempFiles = await readdir(join(libraryDir, ".web-capture-tmp")).catch(() => []);
  assert.equal(uploadTempFiles.some((name) => name.startsWith(`upload-${uploadId}`)), false, "committed upload temp file is removed");

  const unknownLengthVideo = Buffer.from(streamedVideo);
  unknownLengthVideo[100] = 1;
  const unknownBegin = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/begin`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      totalBytes: 0,
      totalChunks: 0,
      metadata: { provider: "flow", mediaKind: "video", mimeType: "video/mp4" },
    }),
  });
  assert.equal(unknownBegin.status, 201, "remote streams may begin before content length/chunk count is known");
  const unknownUploadId = (await unknownBegin.json()).uploadId;
  for (const [index, chunk] of [unknownLengthVideo.subarray(0, 48 * 1024), unknownLengthVideo.subarray(48 * 1024)].entries()) {
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/chunk`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        origin: "chrome-extension://abc123",
        authorization: "Bearer test-token",
        "x-mosa-upload-id": unknownUploadId,
        "x-mosa-chunk-index": String(index),
      },
      body: chunk,
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const unknownCommit = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture-upload/commit`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({ uploadId: unknownUploadId }),
  });
  assert.equal(unknownCommit.status, 201);
  await unknownCommit.arrayBuffer();

  const referenceResponse = await fetch(`http://127.0.0.1:${port}/api/ingest/web-capture`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "chrome-extension://abc123",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      provider: "chatgpt",
      is_reference: true,
      imageBase64: (await noiseImage(88)).toString("base64"),
      mimeType: "image/png",
      conversationId: "http-reference-demo",
      capturedAt: "2026-08-13T10:00:00.000Z",
    }),
  });
  assert.equal(referenceResponse.status, 201);
  const referenceBody = await referenceResponse.json();
  assert.equal(referenceBody.status, "imported");
  assert.equal(referenceBody.asset, undefined);
  assert.match(referenceBody.attachment?.attachment_url || "", /^\/library\/default\/references\//);

  const attachmentResponse = await fetch(`http://127.0.0.1:${port}${referenceBody.attachment.attachment_url}`);
  assert.equal(attachmentResponse.status, 200);
  assert.equal(attachmentResponse.headers.get("content-type"), "image/png");
  assert.ok((await attachmentResponse.arrayBuffer()).byteLength > 20 * 1024);

  const missingAttachment = await fetch(`http://127.0.0.1:${port}/library/default/references/not-present.png`);
  assert.equal(missingAttachment.status, 404);
  await missingAttachment.arrayBuffer();

  const bridges = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(bridges.status, 200);
  const bridgeBody = await bridges.json();
  assert.equal(bridgeBody.webCapture?.enabled, true);
  assert.ok(bridgeBody.webCapture?.providers?.includes("chatgpt"));
});

test("pairing is disabled by default on a headless CLI runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-pair-"));
  const sessionsDir = join(root, "sessions");
  const libraryDir = join(root, "library");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(join(sessionsDir, "empty.jsonl"), "\n");
  const seeded = createSqliteAssetStore({ projectRoot: root, managerDir: process.cwd(), libraryDir });
  await seeded.ensureProject("default");
  await seeded.setMigrationState("completed", { test: true });
  seeded.close();

  // No MOSA_WEB_CAPTURE_PAIR here: a CLI runtime does not silently pair unless
  // the process owner explicitly opts in.
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MOSA_PORT: "0",
      MOSA_PROJECT_DIR: root,
      MOSA_LIBRARY_DIR: libraryDir,
      CODEX_GENERATED_IMAGES_DIR: join(root, "generated-images"),
      CODEX_SESSIONS_DIR: sessionsDir,
      GROK_SESSIONS_DIR: join(root, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(root, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(root, "state", "cowart-projects.json"),
      MOSA_WEB_CAPTURE_TOKEN: "test-token",
      MOSA_WEB_CAPTURE_ORIGINS: "chrome-extension://abc123",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (server.exitCode === null) server.kill("SIGKILL");
      }, 5_000);
      try {
        await exited;
      } finally {
        clearTimeout(forceKill);
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  const port = await waitForServerPort(server);
  await waitForServer(port, server);

  // Even a perfectly formed extension Origin must not receive the long-lived
  // ingest token from a source/headless runtime unless its owner opted in.
  const pairAttempt = await fetch(`http://127.0.0.1:${port}/api/web-capture/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://abc123", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(pairAttempt.status, 503);
  assert.equal((await pairAttempt.json()).code, "WEB_CAPTURE_PAIRING_DISABLED");
});

async function waitForServerPort(server) {
  let buffer = "";
  for await (const chunk of server.stdout) {
    buffer += chunk.toString("utf8");
    const match = buffer.match(/GravityPort: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) return Number(match[1]);
  }
  throw new Error(`Server exited before printing port: ${buffer}`);
}

async function waitForServer(port, server, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited early with code ${server.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/bridges`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not become ready");
}

// Solid colours compress below the 20 KiB floor the ingest uses to reject UI
// logos, so fixtures need incompressible content.
async function noiseImage(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251) + seed * 13) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function referenceFixture(bytes, conversationId, capturedAt) {
  return {
    projectId: "default",
    bytes,
    extension: ".png",
    mimeType: "image/png",
    width: 720,
    height: 960,
    provider: "chatgpt",
    conversationId,
    capturedAt,
  };
}

test("prefers the store's indexed content-hash lookup over a project scan", async (t) => {
  // The scan this replaced was worst on a miss, which is the normal case while
  // capturing new images. A store that offers the indexed lookup must have it
  // used, and the listing must not be pulled just to answer the byte question.
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-indexed-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const image = await noiseImage(5);

  let indexedCalls = 0;
  let listCalls = 0;
  const store = {
    createAsset: async (input) => ({ id: input.assetId, ...input, source: { ...input.source } }),
    listAssets: async () => { listCalls += 1; return []; },
    findAssetByContentHash: async () => { indexedCalls += 1; return null; },
  };

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: { provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png" },
  });

  assert.equal(indexedCalls, 1, "the indexed lookup answers the byte-hash question");
  // One listing pass is two calls, active and archived. Seeing four would mean
  // the pixel fallback and the turn-reference lookup each pulled their own.
  assert.equal(listCalls, 2, `the pixel fallback reuses one shared listing, saw ${listCalls} calls`);
});

test("links only the references from the generation's own turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-turn-"));
  deferTestPathRemoval(root, { recursive: true, force: true });

  const archived = [
    { id: "old-gen", source: { conversation_id: "c1", captured_at: "2026-07-26T10:01:00.000Z" }, business_fields: { is_reference: false } },
  ];
  const referenceStore = createReferenceAttachmentStore(root);
  await referenceStore.save(referenceFixture(await noiseImage(30), "c1", "2026-07-26T10:00:00.000Z"));
  const refA = await referenceStore.save(referenceFixture(await noiseImage(31), "c1", "2026-07-26T10:05:00.000Z"));
  const refB = await referenceStore.save(referenceFixture(await noiseImage(32), "c1", "2026-07-26T10:06:00.000Z"));
  await referenceStore.save(referenceFixture(await noiseImage(33), "c2", "2026-07-26T10:05:30.000Z"));

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async ({ archived: wantArchived } = {}) => (wantArchived ? [] : archived),
    findAssetByContentHash: async () => null,
  };
  const image = await noiseImage(3);

  await ingestWebCapture({
    store,
    referenceStore,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:07:00.000Z",
    },
  });

  assert.deepEqual(created.references.map((item) => item.asset_id), [refA.attachment.id, refB.attachment.id]);
  assert.deepEqual(created.references.map((item) => item.sha256), [refA.attachment.content_sha256, refB.attachment.content_sha256]);
  assert.equal(created.references[0].applied, true);
  assert.equal(created.references[0].role, "", "the capture cannot know the purpose and must not invent one");
});

test("a reference upload never calls createAsset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-ref-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const image = await noiseImage(0);

  let createCalls = 0;
  const store = {
    createAsset: async () => { createCalls += 1; throw new Error("must not create an asset"); },
    listAssets: async () => [],
    findAssetByContentHash: async () => null,
  };

  const result = await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: {
      provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png",
      conversationId: "c1", capturedAt: "2026-07-26T10:01:00.000Z", is_reference: true,
    },
  });

  assert.equal(result.status, "imported");
  assert.ok(result.attachment);
  assert.equal(result.asset, undefined);
  assert.equal(createCalls, 0);
});

test("serializes concurrent reference attachment index updates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-concurrent-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const independentStore = createReferenceAttachmentStore(root);
  const [first, second] = await Promise.all([
    referenceStore.save(referenceFixture(await noiseImage(60), "c1", "2026-08-13T10:00:00.000Z")),
    independentStore.save(referenceFixture(await noiseImage(61), "c1", "2026-08-13T10:00:01.000Z")),
  ]);
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.deepEqual(new Set((await referenceStore.list("default")).map((item) => item.id)), new Set([first.attachment.id, second.attachment.id]));
});

test("reference attachment pruning keeps reachable shared references and removes unreachable files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-prune-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const first = await referenceStore.save(referenceFixture(await noiseImage(62), "c1", "2026-08-13T10:00:00.000Z"));
  const second = await referenceStore.save(referenceFixture(await noiseImage(63), "c2", "2026-08-13T10:00:01.000Z"));

  // Both saves are inside the 24h grace window, so jump the prune clock past
  // it to exercise the reachable/unreachable split this test pins down.
  const result = await referenceStore.pruneUnused("default", new Set([first.attachment.id]), Date.now() + 25 * 60 * 60 * 1000);
  assert.deepEqual(result, { removed: 1, retained: 1, failed: 0 });
  assert.deepEqual((await referenceStore.list("default")).map((item) => item.id), [first.attachment.id]);
  const files = await readdir(join(root, "reference-attachments", "default", "files"));
  assert.deepEqual(files, [first.attachment.file_name]);
  assert.notEqual(first.attachment.id, second.attachment.id);
});

// Backdates one index entry (and its file) to simulate an attachment that has
// sat unused; stripLastSeen reproduces entries written before the field
// existed, which must fall back to the file's mtime.
async function backdateReference(root, attachmentId, ageMs, { stripLastSeen = false } = {}) {
  const projectRoot = join(root, "reference-attachments", "default");
  const indexPath = join(projectRoot, "index.json");
  const items = JSON.parse(await readFile(indexPath, "utf8"));
  const item = items.find((entry) => entry.id === attachmentId);
  assert.ok(item, `attachment ${attachmentId} present in index`);
  const oldTime = new Date(Date.now() - ageMs);
  if (stripLastSeen) delete item.last_seen_at;
  else item.last_seen_at = oldTime.toISOString();
  await writeFile(indexPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  await utimes(join(projectRoot, "files", item.file_name), oldTime, oldTime);
}

test("an unused reference attachment survives pruning for 24 hours, then is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-grace-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const saved = await referenceStore.save(referenceFixture(await noiseImage(64), "c1", "2026-08-13T10:00:00.000Z"));

  const immediate = await referenceStore.pruneUnused("default", new Set());
  assert.deepEqual(immediate, { removed: 0, retained: 1, failed: 0 }, "a just-captured reference is inside the grace window");
  assert.deepEqual(await referenceStore.list("default"), [saved.attachment]);

  const later = await referenceStore.pruneUnused("default", new Set(), Date.now() + 25 * 60 * 60 * 1000);
  assert.deepEqual(later, { removed: 1, retained: 0, failed: 0 }, "once the grace window has passed the unused reference goes");
  assert.deepEqual(await referenceStore.list("default"), [], "index entry removed");
  assert.deepEqual(await readdir(join(root, "reference-attachments", "default", "files")), [], "file removed");
});

test("attachments recorded before last_seen_at fall back to the file's mtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-grace-old-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const staleDays = await referenceStore.save(referenceFixture(await noiseImage(65), "c1", "2026-08-13T10:00:00.000Z"));
  const staleHours = await referenceStore.save(referenceFixture(await noiseImage(66), "c2", "2026-08-13T10:00:01.000Z"));
  await backdateReference(root, staleDays.attachment.id, 2 * 24 * 60 * 60 * 1000, { stripLastSeen: true });
  await backdateReference(root, staleHours.attachment.id, 60 * 60 * 1000, { stripLastSeen: true });

  const result = await referenceStore.pruneUnused("default", new Set());
  assert.deepEqual(result, { removed: 1, retained: 1, failed: 0 });
  assert.deepEqual((await referenceStore.list("default")).map((item) => item.id), [staleHours.attachment.id]);
  const files = await readdir(join(root, "reference-attachments", "default", "files"));
  assert.deepEqual(files, [staleHours.attachment.file_name]);
});

test("a duplicate capture refreshes the grace window", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-grace-refresh-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const bytes = await noiseImage(67);
  const first = await referenceStore.save(referenceFixture(bytes, "c1", "2026-08-13T10:00:00.000Z"));
  await backdateReference(root, first.attachment.id, 2 * 24 * 60 * 60 * 1000);

  const again = await referenceStore.save(referenceFixture(bytes, "c2", "2026-08-13T11:00:00.000Z"));
  assert.equal(again.created, false, "same bytes re-captured dedupes onto the existing attachment");
  const listed = await referenceStore.list("default");
  assert.ok(Date.parse(listed[0].last_seen_at) > Date.now() - 60_000, "the dedupe path rewrites last_seen_at");

  const result = await referenceStore.pruneUnused("default", new Set());
  assert.deepEqual(result, { removed: 0, retained: 1, failed: 0 }, "the refreshed timestamp keeps the attachment inside the window");
});

test("a referenced attachment is retained no matter how old it is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-grace-kept-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const referenceStore = createReferenceAttachmentStore(root);
  const saved = await referenceStore.save(referenceFixture(await noiseImage(68), "c1", "2026-08-13T10:00:00.000Z"));
  await backdateReference(root, saved.attachment.id, 3 * 24 * 60 * 60 * 1000);

  const result = await referenceStore.pruneUnused("default", new Set([saved.attachment.id]));
  assert.deepEqual(result, { removed: 0, retained: 1, failed: 0 });
  assert.deepEqual((await referenceStore.list("default")).map((item) => item.id), [saved.attachment.id]);
});

test("reference attachments dedupe re-encodes by current display pixels", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-reference-pixels-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const raw = Buffer.alloc(32 * 24 * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i * 17) & 255;
    raw[i + 1] = (i * 29) & 255;
    raw[i + 2] = (i * 43) & 255;
    raw[i + 3] = i % 20 === 0 ? 128 : 255;
  }
  const firstBytes = await sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
  const secondBytes = await sharp(raw, { raw: { width: 32, height: 24, channels: 4 } }).png({ compressionLevel: 1 }).toBuffer();
  assert.notDeepEqual(firstBytes, secondBytes);

  const referenceStore = createReferenceAttachmentStore(root);
  const first = await referenceStore.save(referenceFixture(firstBytes, "c1", "2026-08-13T10:00:00.000Z"));
  const second = await referenceStore.save(referenceFixture(secondBytes, "c1", "2026-08-13T10:00:01.000Z"));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.duplicateKind, "pixel");
  assert.equal(second.attachment.id, first.attachment.id);
  assert.equal((await referenceStore.list("default")).length, 1);
});

test("a capture with no conversation identifier links nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-ingest-noconv-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const image = await noiseImage(6);

  let created;
  const store = {
    createAsset: async (input) => { created = input; return { id: input.assetId, ...input }; },
    listAssets: async () => [
      { id: "loose-ref", source: { captured_at: "2026-07-26T10:00:00.000Z" }, business_fields: { is_reference: true } },
    ],
    findAssetByContentHash: async () => null,
  };

  await ingestWebCapture({
    store,
    tempRoot: join(root, "tmp"),
    input: { provider: "chatgpt", imageBase64: image.toString("base64"), mimeType: "image/png", capturedAt: "2026-07-26T10:01:00.000Z" },
  });

  assert.deepEqual(created.references, [], "nothing ties a loose capture to a turn");
});

test("stores the ChatGPT image request Prompt beside the caption Prompt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-request-prompt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  const caption = "Model caption: A clean flat vector illustration of a gray tabby cat on a pale cream background with soft lighting.";
  const requestPrompt = "Create a new image in the same visual style as Image A. Generate a simple flat illustration of a gray tabby cat.";
  const image = (await noiseImage(311)).toString("base64");

  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      prompt: caption,
      prompt_status: "visible-caption",
      generation_request_prompt: requestPrompt,
      imageBase64: image,
      mimeType: "image/png",
    },
  });
  assert.equal(first.status, "imported");
  assert.equal(first.asset.prompt, caption);
  assert.equal(first.asset.source?.generation_request_prompt, requestPrompt);

  const repeat = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "chatgpt", generation_request_prompt: "A different later text", imageBase64: image, mimeType: "image/png" },
  });
  assert.equal(repeat.status, "skipped");
  assert.equal(repeat.asset.prompt, caption);
  assert.equal(repeat.asset.source?.generation_request_prompt, requestPrompt, "the first observed request Prompt is kept");

  const gemini = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "gemini",
      generation_request_prompt: requestPrompt,
      imageBase64: (await noiseImage(312)).toString("base64"),
      mimeType: "image/png",
    },
  });
  assert.equal(gemini.status, "imported");
  assert.equal(gemini.asset.source?.generation_request_prompt, null);
});

test("adds a late ChatGPT request Prompt to an already archived capture", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-late-request-prompt-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "request-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });
  const requestPrompt = "Generate a simple flat illustration of an orange tabby cat sitting on a cream background.";

  const byDuplicate = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(321)).toString("base64"),
    mimeType: "image/png",
    promptStatus: "not-available",
  }, "request-secret");
  assert.equal(byDuplicate.asset.source?.generation_request_prompt, null);
  const repeated = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(321)).toString("base64"),
    mimeType: "image/png",
    generationRequestPrompt: requestPrompt,
  }, "request-secret");
  assert.equal(repeated.status, "skipped");
  assert.equal(repeated.asset.source?.generation_request_prompt, requestPrompt);

  await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(322)).toString("base64"),
    mimeType: "image/png",
    providerAssetId: "file-late-request",
    promptStatus: "not-available",
  }, "request-secret");
  const upgraded = await bridge.upgradeMetadata({
    provider: "chatgpt",
    mediaKind: "image",
    providerAssetId: "file-late-request",
    generationRequestPrompt: requestPrompt,
  }, "request-secret");
  assert.equal(upgraded.asset.source?.generation_request_prompt, requestPrompt);
  assert.equal(upgraded.asset.prompt, "", "a request Prompt never fills the caption Prompt");
});

// --- ChatGPT conversation session title for stack naming (0.15.24) ---

async function sessionTitleStore(t, prefix = "mosa-web-session-title-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "session-title-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });
  return { store, bridge };
}

test("a captured title lands in the source of a newly archived ChatGPT image", async (t) => {
  const { bridge } = await sessionTitleStore(t);
  const imported = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(402)).toString("base64"),
    mimeType: "image/png",
    conversationId: "conv-title-new",
    generationSessionTitle: "  Bangkok Night Poster  ",
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal(imported.status, "imported");
  assert.equal(imported.asset.source?.generation_session_title, "Bangkok Night Poster", "trimmed on write");

  const capped = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(403)).toString("base64"),
    mimeType: "image/png",
    conversationId: "conv-title-capped",
    generation_session_title: "y".repeat(300),
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal(capped.asset.source?.generation_session_title?.length, 200, "capped to 200 chars");

  const untitled = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(404)).toString("base64"),
    mimeType: "image/png",
    conversationId: "conv-title-empty",
    generationSessionTitle: "   ",
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal("generation_session_title" in (untitled.asset.source || {}), false, "an empty title is not written at all");
});

test("re-observations backfill a missing title and never overwrite an existing one", async (t) => {
  const { store, bridge } = await sessionTitleStore(t);
  const base64 = (await noiseImage(405)).toString("base64");
  const first = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: base64,
    mimeType: "image/png",
    conversationId: "conv-title-backfill",
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal("generation_session_title" in (first.asset.source || {}), false);

  const snapshotsBefore = (await store.getRecipeSnapshotHistory("default", first.asset.id)).snapshots.length;
  const backfilled = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: base64,
    mimeType: "image/png",
    conversationId: "conv-title-backfill",
    generationSessionTitle: "Late Learned Chat",
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal(backfilled.status, "skipped");
  assert.equal(backfilled.asset.source?.generation_session_title, "Late Learned Chat", "the empty slot is backfilled");
  assert.equal(
    (await store.getRecipeSnapshotHistory("default", first.asset.id)).snapshots.length,
    snapshotsBefore,
    "backfilling a title adds no recipe snapshot",
  );

  const overwritten = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: base64,
    mimeType: "image/png",
    conversationId: "conv-title-backfill",
    generationSessionTitle: "Never Applied",
    promptStatus: "not-available",
  }, "session-title-secret");
  assert.equal(overwritten.asset.source?.generation_session_title, "Late Learned Chat", "an existing title is never replaced");
});

test("a title arriving with a session's second image names the auto stack", async (t) => {
  const { store, bridge } = await sessionTitleStore(t);
  await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(406)).toString("base64"),
    mimeType: "image/png",
    conversationId: "conv-title-stack",
    promptStatus: "not-available",
  }, "session-title-secret");
  await bridge.ingest({
    provider: "chatgpt",
    imageBase64: (await noiseImage(407)).toString("base64"),
    mimeType: "image/png",
    conversationId: "conv-title-stack",
    generationSessionTitle: "Stacked Conversation",
    promptStatus: "not-available",
  }, "session-title-secret");

  const page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  const stack = page.assets.find((asset) => asset.stack)?.stack || null;
  assert.ok(stack, "the second same-session image created the auto stack");
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.name, "Stacked Conversation", "the auto stack is named after the conversation title");
});

test("keeps user-edited prompts on web recapture while untouched assets still upgrade", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-edit-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "user-edit-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });

  const shortPrompt = "A flat red square";
  const initial = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(251)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-edit-a",
    prompt: shortPrompt,
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "user-edit-secret");
  assert.equal(initial.status, "imported");

  // The UI PATCH entry point: stamp markers the way lib/api/asset-routes.mjs does.
  await store.updateMetadata("default", initial.asset.id, withUserEditMarkers(
    await store.getAsset("default", initial.asset.id),
    { prompt: "USER EDIT: A flat vermilion square with torn edges" },
  ));

  const longerPrompt = "A flat vermilion square with torn edges, shot on medium-format film, soft studio lighting, extremely detailed texture, editorial composition";
  const recaptured = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-edit-a",
    prompt: longerPrompt,
    promptStatus: "provider-visible-prompt",
    promptSource: "flow-visible-prompt",
    promptPriority: 50,
    generationStatus: "completed",
  }, "user-edit-secret");
  assert.equal(recaptured.upgraded, false, "a user-edited prompt is not upgraded, and nothing else about it is rewritten");
  assert.equal(recaptured.asset.prompt, "USER EDIT: A flat vermilion square with torn edges", "the user edit must survive the recapture");
  assert.equal(recaptured.asset.theme, initial.asset.theme, "the theme derived from the page prompt must not be written either");
  assert.ok(recaptured.asset.source.prompt_user_edited_at);

  // Seeing the same image again must not rewrite the asset each time.
  const beforeRepeat = (await store.getAsset("default", initial.asset.id)).updated_at;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeated = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-edit-a",
    prompt: longerPrompt,
    promptStatus: "provider-visible-prompt",
    promptSource: "flow-visible-prompt",
    promptPriority: 50,
    generationStatus: "completed",
  }, "user-edit-secret");
  assert.equal(repeated.upgraded, false);
  assert.equal((await store.getAsset("default", initial.asset.id)).updated_at, beforeRepeat, "a repeated observation is a no-op");

  // Control: an untouched asset with the same history still follows the page.
  const control = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(252)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-edit-b",
    prompt: shortPrompt,
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "user-edit-secret");
  const controlUpgraded = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-edit-b",
    prompt: longerPrompt,
    promptStatus: "provider-visible-prompt",
    promptSource: "flow-visible-prompt",
    promptPriority: 50,
    generationStatus: "completed",
  }, "user-edit-secret");
  assert.equal(controlUpgraded.upgraded, true);
  assert.equal(controlUpgraded.asset.prompt, longerPrompt, "the untouched asset must still upgrade");
  assert.notEqual(controlUpgraded.asset.prompt, control.asset.prompt);
});

test("a user-renamed web asset keeps its theme while its prompt still upgrades", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-theme-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "user-theme-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });

  const initial = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(253)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-theme",
    prompt: "A flat red square",
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "user-theme-secret");

  // Rename only: the prompt keeps no marker, so upgrades stay possible.
  await store.updateMetadata("default", initial.asset.id, withUserEditMarkers(
    await store.getAsset("default", initial.asset.id),
    { theme: "狐狸（我改的）" },
  ));

  const longerPrompt = "A flat red square with visible brush texture, soft studio lighting, extremely detailed, editorial photography, medium format film look";
  const upgraded = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-theme",
    prompt: longerPrompt,
    promptStatus: "provider-visible-prompt",
    promptSource: "flow-visible-prompt",
    promptPriority: 50,
    generationStatus: "completed",
  }, "user-theme-secret");
  assert.equal(upgraded.upgraded, true);
  assert.equal(upgraded.asset.prompt, longerPrompt, "the prompt upgrade must still happen");
  assert.equal(upgraded.asset.theme, "狐狸（我改的）", "the user rename must survive the upgrade");
});

test("user-message backfill still runs after the markers and keeps them intact", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-user-message-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "user-message-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });

  const initial = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(254)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-message",
    prompt: "A flat red square",
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "user-message-secret");
  await store.updateMetadata("default", initial.asset.id, withUserEditMarkers(
    await store.getAsset("default", initial.asset.id),
    { prompt: "USER EDIT: A flat red square" },
  ));

  const backfilled = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=user-message",
    userMessage: "做一张红色的正方形",
    generationStatus: "completed",
  }, "user-message-secret");
  assert.equal(backfilled.upgraded, true);
  assert.equal(backfilled.asset.source.user_message, "做一张红色的正方形", "user-message backfill is untouched by the markers");
  assert.equal(backfilled.asset.prompt, "USER EDIT: A flat red square");
  assert.ok(backfilled.asset.source.prompt_user_edited_at, "the marker must survive the backfill write");
});

test("city-name heuristics no longer force a prompt upgrade on their own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-no-place-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "no-place-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });

  const initial = await bridge.ingest({
    provider: "flow",
    imageBase64: (await noiseImage(255)).toString("base64"),
    mimeType: "image/png",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=no-place",
    prompt: "A flat red square",
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "no-place-secret");
  assert.equal(initial.status, "imported");

  // Shorter, same rank, only distinguished by a city name — the deleted place
  // table would have forced this through before (promptRank also counts text
  // length, so the replacement must be shorter than the stored prompt).
  const sameRank = await bridge.upgradeMetadata({
    provider: "flow",
    mediaKind: "image",
    sourceMediaUrl: "https://flow-content.google/output.png?media_id=no-place",
    prompt: "Beijing square",
    promptStatus: "provider-visible-prompt",
    generationStatus: "completed",
  }, "no-place-secret");
  assert.equal(sameRank.upgraded, false);
  assert.equal(sameRank.asset.prompt, "A flat red square");
});

test("clearing a prompt in the details lets the next capture of the same image refill it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-web-prompt-refill-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const bridge = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "refill-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });

  const bytes = await noiseImage(311);
  const initial = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: bytes.toString("base64"),
    mimeType: "image/png",
    prompt: "A flat teal square on a hillside",
    promptStatus: "generation-tool-prompt",
    generationStatus: "completed",
  }, "refill-secret");
  assert.equal(initial.status, "imported");

  // The details PATCH entry point: clearing the prompt goes through the same
  // withUserEditMarkers path as lib/api/asset-routes.mjs.
  await store.updateMetadata("default", initial.asset.id, withUserEditMarkers(
    await store.getAsset("default", initial.asset.id),
    { prompt: "   " },
  ));
  const cleared = await store.getAsset("default", initial.asset.id);
  assert.equal(cleared.prompt, "");
  assert.ok(!cleared.source.prompt_user_edited_at, "clearing the prompt removes the stale marker");
  assert.equal(cleared.source.prompt_status, "not-available");

  // The same image captured again refills the prompt from the site.
  const recaptured = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: bytes.toString("base64"),
    mimeType: "image/png",
    prompt: "A flat teal square on a hillside",
    promptStatus: "generation-tool-prompt",
    generationStatus: "completed",
  }, "refill-secret");
  assert.equal(recaptured.status, "skipped");
  assert.equal(recaptured.upgraded, true);
  assert.equal(recaptured.asset.prompt, "A flat teal square on a hillside");
  assert.equal(recaptured.asset.source.prompt_status, "generation-tool-prompt");

  // Control: a non-empty rewrite is a real hand edit and survives recapture.
  const controlBytes = await noiseImage(312);
  const control = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: controlBytes.toString("base64"),
    mimeType: "image/png",
    prompt: "A flat amber square by the sea",
    promptStatus: "generation-tool-prompt",
    generationStatus: "completed",
  }, "refill-secret");
  assert.equal(control.status, "imported");
  await store.updateMetadata("default", control.asset.id, withUserEditMarkers(
    await store.getAsset("default", control.asset.id),
    { prompt: "USER EDIT: my own square" },
  ));
  const controlRecaptured = await bridge.ingest({
    provider: "chatgpt",
    imageBase64: controlBytes.toString("base64"),
    mimeType: "image/png",
    prompt: "A flat amber square by the sea",
    promptStatus: "generation-tool-prompt",
    generationStatus: "completed",
  }, "refill-secret");
  assert.equal(controlRecaptured.status, "skipped");
  assert.equal(controlRecaptured.upgraded, false);
  assert.equal(controlRecaptured.asset.prompt, "USER EDIT: my own square");
});
