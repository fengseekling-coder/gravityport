// Web Capture e2e flow: simulates the MOSA Chrome extension talking to the
// loopback bridge. Token is obtained the same way the extension gets it —
// through /api/web-capture/pair from an allowlisted extension origin — and the
// capture is sent with the real request shapes: JSON+Base64 ingest, the binary
// envelope, the metadata completion pass, and the chunked video upload session.

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import sharp from "sharp";
import { PAGE_HELPERS } from "./_page-helpers.mjs";

export const name = "web-capture";
export const description = "extension pairing -> JSON ingest (live gallery push + inspector + source filter) -> binary envelope -> metadata completion -> chunked video upload -> conversation turn bindings -> duplicate idempotency -> token rejection";

// Server-side configuration is documented runtime configuration (PRIVACY.md:
// "Disable web capture by leaving MOSA_WEB_CAPTURE_TOKEN unset"), not a test
// hook: the e2e runner owns the server process, so it configures the bridge
// like any headless owner would. Values must satisfy parseAllowedIngestOrigins
// (chrome-extension://<id>) and the token comparison.
const WEB_CAPTURE_EXTENSION_ORIGIN = "chrome-extension://mosae2eextension";
// Generated per run so no Token value lives in a tracked file.
const WEB_CAPTURE_TEST_TOKEN = `mosa_e2e_${randomBytes(24).toString("hex")}`;
const WEB_CAPTURE_ENV_KEYS = ["MOSA_WEB_CAPTURE_TOKEN", "MOSA_WEB_CAPTURE_ORIGINS", "MOSA_WEB_CAPTURE_PAIR"];

// Test-only placeholder data: no real accounts, URLs, or local paths.
const PROMPT_CAPTION = "MOSA e2e 网页采集可见提示词 001";
const PROMPT_UPGRADED = "MOSA e2e 网页采集升级后的图像工具提示词 001";
const PROMPT_REQUEST = "MOSA e2e 图像工具请求提示词 001";
const USER_MESSAGE = "MOSA e2e 用户消息 001";
const PROMPT_GEMINI = "MOSA e2e Gemini 网页可见提示词 002";
const PROMPT_FLOW_VIDEO = "MOSA e2e Flow 网页视频提示词 003";
const PAGE_URL_CHATGPT = "https://example.com/chat/e2e-capture-demo";
const PAGE_URL_GEMINI = "https://example.com/gemini/e2e-capture-demo";
const PAGE_URL_FLOW = "https://example.com/flow/e2e-capture-demo";
const MEDIA_URL_CHATGPT = "https://example.com/media/e2e-capture-0001.png?asset_id=e2e-asset-0001";
const MEDIA_URL_GEMINI = "https://example.com/media/e2e-capture-0002.png?asset_id=e2e-asset-0002";
const CONVERSATION_CHATGPT = "e2e-conv-0001";
const MESSAGE_CHATGPT = "e2e-msg-0001";
const CONVERSATION_GEMINI = "e2e-conv-0002";
const MESSAGE_GEMINI = "e2e-msg-0002";
const CONVERSATION_FLOW = "e2e-conv-0003";
const MESSAGE_FLOW = "e2e-msg-0003";
const PROVIDER_ASSET_CHATGPT = "e2e-provider-asset-0001";
const PROVIDER_ASSET_GEMINI = "e2e-provider-asset-0002";
const MODEL_CHATGPT = "e2e-test-model";
const MODEL_GEMINI = "e2e-test-model-gemini";
const MODEL_FLOW = "e2e-test-model-flow";
const EXTENSION_VERSION = "0.0.0-e2e";

function assertOk(condition, message) {
  if (!condition) throw new Error(`web-capture: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`web-capture: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Array-valued observations must compare by content, not identity.
function assertSameArray(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`web-capture: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Raw fetch against the bridge routes: the extension authenticates with a
// Bearer Web Capture Token, not the MOSA client token, so ctx.api is wrong for
// these calls. Returns { status, body } without throwing on non-2xx.
async function bridgeFetch(origin, method, path, { token = "", originHeader = "", body = null, rawBody = null, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(originHeader ? { origin: originHeader } : {}),
      ...(body !== null ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
    ...(rawBody !== null ? { body: rawBody } : {}),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, body: json, text };
}

// The ChatGPT-shaped capture payload is built inside the page source (it must
// carry the page-generated image), so the extension request shape lives there;
// this flow keeps every large payload out of the runInPage result channel.

async function listAssets(origin, extraQuery = "") {
  const page = await (await fetch(`${origin}/api/assets?project=default&limit=250${extraQuery}`)).json();
  return Array.isArray(page?.assets) ? page.assets : [];
}

async function findAssetById(origin, assetId) {
  return (await listAssets(origin)).find((asset) => asset.id === assetId) || null;
}

export async function run(ctx) {
  await ctx.prepare();

  // The e2e process owns the spawned servers, so the bridge configuration is
  // passed through the documented environment variables; originals are
  // restored afterwards so later flows in the same process stay untouched.
  const savedEnv = WEB_CAPTURE_ENV_KEYS.map((key) => [key, process.env[key]]);
  process.env.MOSA_WEB_CAPTURE_TOKEN = WEB_CAPTURE_TEST_TOKEN;
  process.env.MOSA_WEB_CAPTURE_ORIGINS = WEB_CAPTURE_EXTENSION_ORIGIN;
  process.env.MOSA_WEB_CAPTURE_PAIR = "auto";

  let server = null;
  let summary = null;
  try {
    server = await ctx.startServer();
    const { origin } = server;

    // ===== 1. Pairing: how the extension legitimately obtains the token =====
    const pairing = await bridgeFetch(origin, "POST", "/api/web-capture/pair", { originHeader: WEB_CAPTURE_EXTENSION_ORIGIN });
    assertEqual(pairing.status, 200, `pairing from the allowlisted extension origin must succeed (body: ${pairing.text.slice(0, 200)})`);
    assertEqual(pairing.body?.product, "mosa", "pairing response product");
    const token = String(pairing.body?.token || "");
    assertEqual(token, WEB_CAPTURE_TEST_TOKEN, "pairing must return the runtime's configured Web Capture Token");
    const pairingForeignOrigin = await bridgeFetch(origin, "POST", "/api/web-capture/pair", { originHeader: "chrome-extension://notallowlisted" });
    assertEqual(pairingForeignOrigin.status, 403, "pairing from a non-allowlisted extension origin must be rejected");

    // ===== 2. Positive: JSON ingest, then live gallery push without reload =====
    const liveResult = await ctx.runInPage(server, liveCaptureSource({ token }));
    assertEqual(liveResult?.initialCardCount, 0, "fresh library must start with an empty gallery");
    assertEqual(liveResult?.httpStatus, 201, "JSON ingest of a new capture must answer 201");
    assertEqual(liveResult?.ingestStatus, "imported", "JSON ingest result status");
    const chatgptAssetId = String(liveResult?.assetId || "");
    assertOk(chatgptAssetId, "JSON ingest must return the archived asset id");
    assertEqual(liveResult?.cardAppeared, true, "captured card must appear in the gallery without a reload (library push)");
    assertEqual(liveResult?.cardTitle, PROMPT_CAPTION, "card title must show the captured prompt theme");
    assertOk(Array.isArray(liveResult?.cardMetaSpans) && liveResult.cardMetaSpans.includes("ChatGPT 网页版"),
      `card meta must show the ChatGPT web source label (got ${JSON.stringify(liveResult?.cardMetaSpans)})`);
    assertEqual(liveResult?.detailPrompt, PROMPT_CAPTION, "inspector prompt box must show the caption prompt");
    assertEqual(liveResult?.detailRequestPrompt, PROMPT_REQUEST, "inspector request-prompt box must show the ChatGPT image-tool prompt kept beside the caption");
    assertEqual(liveResult?.sourceLabel, "ChatGPT 网页版", "inspector head source line must show the ChatGPT web source name");
    assertEqual(liveResult?.sourceSectionAbsent, true, "A4a: the source section must stay removed from the inspector");
    assertEqual(liveResult?.assetConversationId, CONVERSATION_CHATGPT, "the captured asset must carry the conversation id");
    assertEqual(liveResult?.assetMessageId, MESSAGE_CHATGPT, "the captured asset must carry the message id (API)");
    assertEqual(liveResult?.assetModel, MODEL_CHATGPT, "the captured asset must carry the model (API)");
    assertSameArray(liveResult?.sourceFilterCardIds, [chatgptAssetId], "sidebar source filter must narrow the gallery to the captured card");
    assertEqual(liveResult?.sourceFilterNavCount, "1", "sidebar source nav count for the captured source type");

    // Interface recheck of what the page just showed.
    const chatgptAsset = await findAssetById(origin, chatgptAssetId);
    assertOk(chatgptAsset, "captured asset must be listed by the assets API");
    assertEqual(chatgptAsset?.source?.type, "web-chatgpt", "asset source.type");
    assertEqual(chatgptAsset?.source?.provider, "chatgpt", "asset source.provider");
    assertEqual(chatgptAsset?.prompt, PROMPT_CAPTION, "asset prompt as stored");
    assertEqual(chatgptAsset?.source?.prompt_status, "visible-caption", "asset prompt_status as stored");
    assertEqual(chatgptAsset?.source?.page_url, PAGE_URL_CHATGPT, "asset page_url as stored");
    assertEqual(chatgptAsset?.source?.conversation_id, CONVERSATION_CHATGPT, "asset conversation_id as stored");
    assertEqual(chatgptAsset?.source?.generation_request_prompt, PROMPT_REQUEST, "ChatGPT request prompt stored beside the caption prompt");
    assertEqual(chatgptAsset?.source?.verification_level, "observed", "web capture provenance is observed, not provider-verified");
    assertEqual(chatgptAsset?.business_fields?.capture_channel, "chrome-extension", "capture channel recorded in business fields");
    const bySourceApi = await listAssets(origin, "&source=web-chatgpt");
    assertOk(bySourceApi.some((asset) => asset.id === chatgptAssetId), "assets API source filter must return the captured asset");
    assertEqual(bySourceApi.length, 1, "assets API source filter must return exactly the captured asset");

    // ===== 3. Duplicate resend (extension retry): no second asset =====
    assertEqual(liveResult?.duplicateHttpStatus, 200, "duplicate capture must answer 200 (not a new import)");
    assertEqual(liveResult?.duplicateStatus, "skipped", "duplicate capture result status");
    assertEqual(liveResult?.duplicateReason, "already-archived-same-content", "duplicate capture idempotency reason");
    assertEqual(liveResult?.duplicateAssetId, chatgptAssetId, "duplicate capture must resolve to the existing asset");
    assertEqual((await listAssets(origin)).length, 1, "duplicate capture must not create a second asset");

    // ===== 3.5 Prompt-less replay (reopened conversation): generation record survives =====
    // The replay carries no prompt/model/status — the reopened-page shape. The
    // stored generation event must keep the live capture's values, so the
    // history API still reports the captured prompt and model afterwards.
    assertEqual(liveResult?.replayHttpStatus, 200, "prompt-less replay must answer 200 (same image, duplicate path)");
    assertEqual(liveResult?.replayStatus, "skipped", "prompt-less replay result status");
    const replayHistory = await (await fetch(`${origin}/api/generations?project=default&asset=${encodeURIComponent(chatgptAssetId)}`)).json();
    const replayEvent = Array.isArray(replayHistory?.events) ? replayHistory.events.find((event) => event.capture_context_id === "e2e-genctx-0001") : null;
    assertOk(replayEvent, "generation history lists the captured event after the prompt-less replay");
    assertEqual(replayEvent.effective_prompt, PROMPT_CAPTION, "replay without a prompt must keep the captured effective_prompt");
    assertEqual(replayEvent.model, MODEL_CHATGPT, "replay without a model must keep the captured model");
    assertEqual(replayEvent.prompt_status, "visible-caption", "replay must keep the captured prompt_status");
    const replayedAsset = await findAssetById(origin, chatgptAssetId);
    assertEqual(replayedAsset?.prompt, PROMPT_CAPTION, "the asset prompt is untouched by the prompt-less replay");

    // ===== 4. Metadata completion: later, better prompt upgrades the asset =====
    const upgrade = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-metadata", {
      token,
      body: {
        provider: "chatgpt",
        providerAssetId: PROVIDER_ASSET_CHATGPT,
        prompt: PROMPT_UPGRADED,
        prompt_status: "generation-tool-prompt",
        prompt_source: "image-tool-call",
        prompt_priority: 60,
        prompt_scope: "message",
        user_message: USER_MESSAGE,
        model: MODEL_CHATGPT,
      },
    });
    assertEqual(upgrade.status, 200, "metadata completion must answer 200");
    assertEqual(upgrade.body?.upgraded, true, "metadata completion must report the prompt upgrade");
    assertEqual(upgrade.body?.asset?.prompt, PROMPT_UPGRADED, "metadata completion must replace the prompt with the trusted image-tool prompt");
    const upgradedAsset = await findAssetById(origin, chatgptAssetId);
    assertEqual(upgradedAsset?.prompt, PROMPT_UPGRADED, "upgraded prompt as stored");
    assertEqual(upgradedAsset?.source?.prompt_status, "generation-tool-prompt", "upgraded prompt_status as stored");

    // ===== 5. Binary envelope ingest (Gemini shape) =====
    const geminiPng = await sharp({
      create: {
        width: 512, height: 512, channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 1 },
        noise: { type: "gaussian", mean: 128, sigma: 45 },
      },
    }).png().toBuffer();
    assertOk(geminiPng.length >= 20 * 1024, `binary-envelope fixture must exceed the 20 KiB capture minimum (got ${geminiPng.length} bytes)`);
    const geminiMetadata = {
      provider: "gemini",
      mediaKind: "image",
      mimeType: "image/png",
      prompt: PROMPT_GEMINI,
      prompt_status: "provider-visible-prompt",
      prompt_source: "user-query",
      prompt_priority: 10,
      prompt_scope: "message",
      generation_status: "completed",
      page_url: PAGE_URL_GEMINI,
      source_media_url: MEDIA_URL_GEMINI,
      conversation_id: CONVERSATION_GEMINI,
      message_id: MESSAGE_GEMINI,
      generation_context_id: "e2e-genctx-0002",
      provider_asset_id: PROVIDER_ASSET_GEMINI,
      model: MODEL_GEMINI,
      capture_mode: "manual",
      extension_version: EXTENSION_VERSION,
    };
    const geminiEnvelope = Buffer.concat([
      Buffer.from(JSON.stringify(geminiMetadata), "utf8"),
    ]);
    const envelopeHeader = Buffer.alloc(4);
    envelopeHeader.writeUInt32BE(geminiEnvelope.length, 0);
    const binaryIngest = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-binary", {
      token,
      rawBody: Buffer.concat([envelopeHeader, geminiEnvelope, geminiPng]),
    });
    assertEqual(binaryIngest.status, 201, "binary envelope ingest of a new capture must answer 201");
    assertEqual(binaryIngest.body?.status, "imported", "binary envelope ingest result status");
    const geminiAssetId = String(binaryIngest.body?.asset?.id || "");
    assertOk(geminiAssetId, "binary envelope ingest must return the archived asset id");
    const geminiAsset = await findAssetById(origin, geminiAssetId);
    assertEqual(geminiAsset?.source?.type, "web-gemini", "binary-envelope asset source.type");
    assertEqual(geminiAsset?.prompt, PROMPT_GEMINI, "Gemini provider-visible prompt must be stored");
    assertEqual(geminiAsset?.source?.prompt_status, "provider-visible-prompt", "Gemini prompt_status as stored");
    assertEqual(geminiAsset?.business_fields?.capture_mode, "manual", "manual capture mode as stored");

    // ===== 6. Chunked upload session (Flow video shape) =====
    const videoBytes = Buffer.alloc(72 * 1024);
    videoBytes.writeUInt32BE(videoBytes.length, 0);
    videoBytes.write("ftyp", 4, "ascii");
    videoBytes.write("isom", 8, "ascii");
    let lcgSeed = 0x2f6e2b1;
    for (let offset = 16; offset < videoBytes.length; offset += 4) {
      lcgSeed = (Math.imul(lcgSeed, 1664525) + 1013904223) >>> 0;
      videoBytes.writeUInt32BE(lcgSeed, offset);
    }
    const flowMetadata = {
      provider: "flow",
      mediaKind: "video",
      mimeType: "video/mp4",
      width: 640,
      height: 360,
      duration_seconds: 2.5,
      prompt: PROMPT_FLOW_VIDEO,
      prompt_status: "provider-visible-prompt",
      prompt_source: "prompt-card",
      prompt_priority: 10,
      prompt_scope: "message",
      generation_status: "completed",
      page_url: PAGE_URL_FLOW,
      source_media_url: "https://example.com/media/e2e-capture-0003.mp4?asset_id=e2e-asset-0003",
      conversation_id: CONVERSATION_FLOW,
      message_id: MESSAGE_FLOW,
      generation_context_id: "e2e-genctx-0003",
      model: MODEL_FLOW,
      capture_mode: "automatic",
      extension_version: EXTENSION_VERSION,
    };
    const uploadBegin = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-upload/begin", {
      token,
      body: { totalBytes: videoBytes.length, totalChunks: 1, metadata: flowMetadata },
    });
    assertEqual(uploadBegin.status, 201, "chunked upload begin must answer 201");
    const uploadId = String(uploadBegin.body?.uploadId || "");
    assertOk(uploadId, "chunked upload begin must return an upload id");
    const uploadChunk = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-upload/chunk", {
      token,
      rawBody: videoBytes,
      headers: { "x-mosa-upload-id": uploadId, "x-mosa-chunk-index": "0" },
    });
    assertEqual(uploadChunk.status, 200, "chunked upload chunk must answer 200");
    assertEqual(uploadChunk.body?.nextIndex, 1, "chunked upload must advance to the next chunk index");
    const uploadCommit = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-upload/commit", {
      token,
      body: { uploadId },
    });
    assertEqual(uploadCommit.status, 201, "chunked upload commit of a new capture must answer 201");
    assertEqual(uploadCommit.body?.status, "imported", "chunked upload commit result status");
    const flowAssetId = String(uploadCommit.body?.asset?.id || "");
    assertOk(flowAssetId, "chunked upload commit must return the archived asset id");
    const flowAsset = await findAssetById(origin, flowAssetId);
    assertEqual(flowAsset?.source?.type, "web-flow", "chunked-upload asset source.type");
    assertEqual(flowAsset?.source?.media_kind, "video", "chunked-upload asset media kind");
    assertEqual(flowAsset?.prompt, PROMPT_FLOW_VIDEO, "Flow video prompt as stored");
    assertEqual(flowAsset?.business_fields?.duration_seconds, 2.5, "video duration as stored");

    // ===== 7. Conversation turn bindings (extension 0.15.25) =====
    // The page-world extractor is loaded verbatim from page-hook.js — the very
    // function the real hook runs — and fed a conversation JSON shaped like
    // the page's own /backend-api/conversation/<id> response. The resulting
    // snapshot is then POSTed with exactly the extension background's request
    // shape. The UI "turn N of M" rendering itself belongs to a later update;
    // here the numbers are checked on the generation history the Inspector
    // consumes, plus the Inspector rendering the bound generation event.
    const extractTurnBindings = await loadConversationTurnBindingExtractor();
    const turnConversation = {
      title: "MOSA e2e turn fixture",
      conversation_id: CONVERSATION_CHATGPT,
      current_node: "e2e-node-a3",
      mapping: {
        "e2e-node-root": { id: "e2e-node-root", message: null, parent: null, children: ["e2e-node-u1"] },
        "e2e-node-u1": {
          id: "e2e-node-u1",
          parent: "e2e-node-root",
          children: ["e2e-node-g1"],
          message: {
            id: MESSAGE_CHATGPT,
            author: { role: "user" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 用户消息一"] },
            metadata: {},
          },
        },
        "e2e-node-g1": {
          id: "e2e-node-g1",
          parent: "e2e-node-u1",
          children: ["e2e-node-a1"],
          message: {
            id: "e2e-node-msg-g1",
            author: { role: "tool", name: "image_gen" },
            recipient: "assistant",
            content: {
              content_type: "multimodal_text",
              parts: [{
                content_type: "image_asset_pointer",
                asset_pointer: `file-service://${PROVIDER_ASSET_CHATGPT}`,
                metadata: { dalle: { gen_id: "e2e-gen-0001" } },
              }],
            },
            metadata: {},
            status: "finished_successfully",
          },
        },
        "e2e-node-a1": {
          id: "e2e-node-a1",
          parent: "e2e-node-g1",
          children: ["e2e-node-u2"],
          message: {
            id: "e2e-node-msg-a1",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 回复一"] },
            metadata: {},
            status: "finished_successfully",
          },
        },
        "e2e-node-u2": {
          id: "e2e-node-u2",
          parent: "e2e-node-a1",
          children: ["e2e-node-u2old", "e2e-node-g2"],
          message: {
            id: "e2e-user-0002",
            author: { role: "user" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 用户消息二"] },
            metadata: {},
          },
        },
        // Edited-away branch under the same parent: never reported.
        "e2e-node-u2old": {
          id: "e2e-node-u2old",
          parent: "e2e-node-u2",
          children: ["e2e-node-gold"],
          message: {
            id: "e2e-user-0002-old",
            author: { role: "user" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 用户消息二（编辑前）"] },
            metadata: {},
          },
        },
        "e2e-node-gold": {
          id: "e2e-node-gold",
          parent: "e2e-node-u2old",
          children: [],
          message: {
            id: "e2e-node-msg-gold",
            author: { role: "tool", name: "image_gen" },
            recipient: "assistant",
            content: {
              content_type: "multimodal_text",
              parts: [{
                content_type: "image_asset_pointer",
                asset_pointer: "file-service://file_e2e_edited_away",
                metadata: { dalle: { gen_id: "e2e-gen-old" } },
              }],
            },
            metadata: {},
            status: "finished_successfully",
          },
        },
        "e2e-node-g2": {
          id: "e2e-node-g2",
          parent: "e2e-node-u2",
          children: ["e2e-node-a2"],
          message: {
            id: "e2e-node-msg-g2",
            author: { role: "tool", name: "image_gen" },
            recipient: "assistant",
            content: {
              content_type: "multimodal_text",
              parts: [{
                content_type: "image_asset_pointer",
                asset_pointer: "sediment://file_e2e_turn2",
                metadata: { dalle: { gen_id: "e2e-gen-0002" } },
              }],
            },
            metadata: {},
            status: "finished_successfully",
          },
        },
        "e2e-node-a2": {
          id: "e2e-node-a2",
          parent: "e2e-node-g2",
          children: ["e2e-node-u3"],
          message: {
            id: "e2e-node-msg-a2",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 回复二"] },
            metadata: {},
            status: "finished_successfully",
          },
        },
        "e2e-node-u3": {
          id: "e2e-node-u3",
          parent: "e2e-node-a2",
          children: ["e2e-node-a3"],
          message: {
            id: "e2e-user-0003",
            author: { role: "user" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 用户消息三"] },
            metadata: {},
          },
        },
        "e2e-node-a3": {
          id: "e2e-node-a3",
          parent: "e2e-node-u3",
          children: [],
          message: {
            id: "e2e-node-msg-a3",
            author: { role: "assistant" },
            content: { content_type: "text", parts: ["MOSA e2e turn fixture 回复三"] },
            metadata: {},
            status: "finished_successfully",
          },
        },
      },
    };
    const turnReport = extractTurnBindings(turnConversation);
    assertOk(turnReport, "the fixture conversation must yield a turn-binding report");
    assertEqual(turnReport.conversationId, CONVERSATION_CHATGPT, "turn report conversation id");
    assertEqual(turnReport.turnCount, 3, "turn report counts three visible user turns");
    assertSameArray(turnReport.bindings, [
      { provider_asset_id: PROVIDER_ASSET_CHATGPT, message_id: MESSAGE_CHATGPT, turn_index: 1 },
      { provider_asset_id: "file_e2e_turn2", message_id: "e2e-user-0002", turn_index: 2 },
    ], "turn report bindings (edited-away branch excluded, sediment:// reduced)");

    // The extension background's own request shape: pairing token Bearer on
    // the capture entry /api/ingest/web-capture-turn-bindings (the shared
    // store path behind /api/generation-message-bindings).
    const validTurnBatch = {
      project_id: "default",
      provider: "chatgpt",
      conversation_id: turnReport.conversationId,
      turn_count: turnReport.turnCount,
      bindings: turnReport.bindings,
    };
    const turnBindingsPost = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-turn-bindings", {
      token,
      body: validTurnBatch,
    });
    assertEqual(turnBindingsPost.status, 200, "the pairing token must be accepted on the capture turn-bindings entry");
    assertEqual(turnBindingsPost.body?.updated, 1, "the captured image's event adopts its turn number");
    assertEqual(turnBindingsPost.body?.conflicts, 0, "no message-id conflicts for the fixture");

    // By server design a repost refreshes the snapshot watermark and counts
    // as updated; suppressing the resend is the extension's summary dedup.
    const turnBindingsRepost = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-turn-bindings", {
      token,
      body: validTurnBatch,
    });
    assertEqual(turnBindingsRepost.status, 200, "the repost answers 200");
    assertEqual(turnBindingsRepost.body?.updated, 1, "an identical repost only refreshes the watermark");
    assertEqual(turnBindingsRepost.body?.conflicts, 0, "the identical repost raises no conflicts");

    // The capture entry only accepts the pairing token: the loopback client
    // token is not a capture credential.
    const clientTokenProbe = await fetch(`${origin}/api/ingest/web-capture-turn-bindings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mosa-client-token": WEB_CAPTURE_TEST_TOKEN,
      },
      body: JSON.stringify(validTurnBatch),
    });
    assertEqual(clientTokenProbe.status, 401, "the capture entry must reject a client-token-only request");
    assertEqual((await clientTokenProbe.json())?.code, "WEB_CAPTURE_UNAUTHORIZED", "rejection comes from the capture token gate");

    // ChatGPT's newer conversation read (extension 0.15.26) serves the
    // displayed branch as a flat `messages` list with `page_info` paging
    // instead of a mapping tree. The same extractor source runs here: a
    // complete read reports, a read with older pages outstanding reports
    // nothing (stitching pages is future work), and the report still goes
    // through the pairing-token capture entry.
    const flatConversation = {
      conversation_id: CONVERSATION_CHATGPT,
      current_node: "e2e-flat-a3",
      page_info: {
        start_cursor: "e2e-flat-cursor-start",
        end_cursor: "e2e-flat-cursor-end",
        has_previous_page: false,
        has_next_page: false,
      },
      messages: [
        {
          id: "e2e-flat-u1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式用户消息一"] },
          metadata: {},
        },
        {
          id: "e2e-flat-g1",
          author: { role: "tool", name: "image_gen" },
          recipient: "assistant",
          content: {
            content_type: "multimodal_text",
            parts: [{
              content_type: "image_asset_pointer",
              asset_pointer: "file-service://file_e2e_flat_turn1",
              metadata: { dalle: { gen_id: "e2e-flat-gen-0001" } },
            }],
          },
          metadata: { parent_id: "e2e-flat-u1" },
          status: "finished_successfully",
        },
        {
          id: "e2e-flat-a1",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式回复一"] },
          metadata: { parent_id: "e2e-flat-g1" },
          status: "finished_successfully",
        },
        {
          id: "e2e-flat-u2",
          author: { role: "user" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式用户消息二"] },
          metadata: { parent_id: "e2e-flat-a1" },
        },
        {
          id: "e2e-flat-g2",
          author: { role: "tool", name: "image_gen" },
          recipient: "assistant",
          content: {
            content_type: "multimodal_text",
            parts: [{
              content_type: "image_asset_pointer",
              asset_pointer: "sediment://file_e2e_flat_turn2",
              metadata: { dalle: { gen_id: "e2e-flat-gen-0002" } },
            }],
          },
          metadata: { parent_id: "e2e-flat-u2" },
          status: "finished_successfully",
        },
        {
          id: "e2e-flat-a2",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式回复二"] },
          metadata: { parent_id: "e2e-flat-g2" },
          status: "finished_successfully",
        },
        {
          id: "e2e-flat-u3",
          author: { role: "user" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式用户消息三"] },
          metadata: { parent_id: "e2e-flat-a2" },
        },
        {
          id: "e2e-flat-a3",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["MOSA e2e turn fixture 新格式回复三"] },
          metadata: { parent_id: "e2e-flat-u3" },
          status: "finished_successfully",
        },
      ],
    };
    const flatReport = extractTurnBindings(flatConversation);
    assertOk(flatReport, "the flat-format fixture must yield a turn-binding report");
    assertEqual(flatReport.conversationId, CONVERSATION_CHATGPT, "flat turn report conversation id");
    assertEqual(flatReport.turnCount, 3, "flat turn report counts three visible user turns");
    assertSameArray(flatReport.bindings, [
      { provider_asset_id: "file_e2e_flat_turn1", message_id: "e2e-flat-u1", turn_index: 1 },
      { provider_asset_id: "file_e2e_flat_turn2", message_id: "e2e-flat-u2", turn_index: 2 },
    ], "flat turn report bindings (sediment:// reduced)");
    const pagedFlatConversation = {
      ...flatConversation,
      page_info: { ...flatConversation.page_info, has_previous_page: true },
    };
    assertEqual(extractTurnBindings(pagedFlatConversation), null,
      "a flat read with older pages outstanding must report nothing");

    const flatTurnBatch = {
      project_id: "default",
      provider: "chatgpt",
      conversation_id: flatReport.conversationId,
      turn_count: flatReport.turnCount,
      bindings: flatReport.bindings,
    };
    const flatBindingsPost = await bridgeFetch(origin, "POST", "/api/ingest/web-capture-turn-bindings", {
      token,
      body: flatTurnBatch,
    });
    assertEqual(flatBindingsPost.status, 200, "the pairing token must accept the flat-format batch");
    assertEqual(flatBindingsPost.body?.updated, 0, "the flat fixture's file ids match no captured event");
    assertEqual(flatBindingsPost.body?.conflicts, 0, "the flat fixture raises no message-id conflicts");
    assertEqual(flatBindingsPost.body?.unmatched, 2, "both flat fixture entries are unmatched by design");

    const historyResponse = await fetch(`${origin}/api/assets/default/${chatgptAssetId}/generation-history`);
    assertEqual(historyResponse.status, 200, "generation history must answer 200");
    const historyBody = await historyResponse.json();
    const boundEvent = (historyBody?.history?.events || []).find((event) => event.provider_asset_id === PROVIDER_ASSET_CHATGPT);
    assertOk(boundEvent, "the captured asset must have a generation event for the bound file");
    assertEqual(boundEvent?.turn_index, 1, "the stored event carries turn_index 1");
    assertOk(Boolean(boundEvent?.turn_synced_at), "the stored event carries the snapshot watermark");

    const turnInspector = await ctx.runInPage(server, turnBindingInspectorSource({ chatgptAssetId }));
    assertOk((turnInspector?.historyItems || 0) >= 1, "the Inspector generation history renders the bound event");

    // ===== 8. Negative: missing / wrong token must be rejected =====
    // Token verification runs before the body is read, so a small body keeps
    // these requests honest: rejection happens at the auth layer.
    const noToken = await bridgeFetch(origin, "POST", "/api/ingest/web-capture", { body: { provider: "chatgpt" } });
    assertEqual(noToken.status, 401, "ingest without a token must be rejected with 401");
    assertEqual(noToken.body?.code, "WEB_CAPTURE_UNAUTHORIZED", "ingest without a token error code");
    const wrongToken = await bridgeFetch(origin, "POST", "/api/ingest/web-capture", {
      token: "mosa_e2e_wrong_web_capture_token",
      body: { provider: "chatgpt" },
    });
    assertEqual(wrongToken.status, 401, "ingest with a wrong token must be rejected with 401");
    assertEqual(wrongToken.body?.code, "WEB_CAPTURE_UNAUTHORIZED", "ingest with a wrong token error code");
    const rejectedAssetIds = (await listAssets(origin)).map((asset) => asset.id).sort();
    assertEqual(JSON.stringify(rejectedAssetIds), JSON.stringify([chatgptAssetId, geminiAssetId, flowAssetId].sort()),
      "rejected captures must not add gallery assets (library must hold exactly the three captured assets)");

    // ===== 9. Fresh page: persistence, source nav for all captures, upgraded prompt =====
    const finalResult = await ctx.runInPage(server, finalVerificationSource({
      chatgptAssetId, geminiAssetId, flowAssetId,
    }));
    assertSameArray([...(finalResult?.rootCardIds || [])].sort(), [chatgptAssetId, geminiAssetId, flowAssetId].sort(),
      "fresh page must show exactly the three captured assets");
    for (const [value, count] of [["web-chatgpt", "1"], ["web-gemini", "1"], ["web-flow", "1"]]) {
      assertEqual(finalResult?.sourceNavCounts?.[value], count, `sidebar source nav count for ${value}`);
    }
    assertEqual(finalResult?.chatgptPrompt, PROMPT_UPGRADED, "inspector must show the completed (upgraded) prompt");
    assertEqual(finalResult?.chatgptRequestPrompt, PROMPT_REQUEST, "inspector must keep the request prompt beside the upgraded caption");
    assertEqual(finalResult?.chatgptCardTitle, PROMPT_UPGRADED, "card title must reflect the upgraded prompt theme");
    assertEqual(finalResult?.geminiPrompt, PROMPT_GEMINI, "inspector must show the Gemini capture prompt");

    summary = {
      token: "pairing-endpoint",
      imported: [chatgptAssetId, geminiAssetId, flowAssetId],
      duplicateResend: liveResult?.duplicateReason,
      metadataUpgrade: upgrade.body?.upgraded,
      turnBindings: { turns: turnReport.turnCount, bound: turnBindingsPost.body?.updated },
      tokenRejections: [noToken.status, wrongToken.status],
    };
  } finally {
    await server?.stop();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return summary;
}

// Runs in the sandboxed renderer on a fresh library: sends the ChatGPT capture
// from the open page (so the gallery is provably already on screen), then
// observes the pushed card, the inspector, and the sidebar source filter.
function liveCaptureSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const panel = () => document.querySelector('#detailPanel');
    const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
    const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';

    await waitFor(() => gallerySettled(), 'initial gallery settles', 20000);
    const initialCardCount = rootCardIds().length;
    // 任务 122：这条流程从空库起步——推送的卡片加入前，网格必须正处于
    // 「素材库还是空的」空态；推送之后空态必须让位（增量提交曾把卡片追加在
    // 空态后面，:has 的 flex 规则把卡片压扁）。
    await waitFor(() => document.querySelector('#assetGrid > .gallery-empty-state')?.dataset.emptyKind === 'library-empty',
      'library-empty state on screen before the capture', 10000);

    // The bridge routes are locale-sensitive in the UI only: pin the real
    // settings entry to Chinese so label assertions are deterministic.
    click('#settingsToggle');
    await waitFor(() => !document.querySelector('#settingsMenu')?.hidden, 'settings menu opens');
    await waitFor(() => Boolean(document.querySelector('#settingsMenu [data-locale="zh"]')), 'language option renders');
    click('#settingsMenu [data-locale="zh"]');
    await waitFor(() => document.documentElement.lang === 'zh-CN', 'interface language switches to Chinese');
    if (!document.querySelector('#settingsMenu')?.hidden) click('#settingsToggle');

    // Extension-shaped capture body: a >20 KiB PNG is required, so draw noise
    // instead of a flat colour (flat PNGs are far below the minimum).
    const width = 512;
    const height = 512;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(width, height);
    let seed = 0x2f6e2b1;
    for (let i = 0; i < imageData.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      imageData.data[i] = seed & 0xff;
      imageData.data[i + 1] = (seed >>> 8) & 0xff;
      imageData.data[i + 2] = (seed >>> 16) & 0xff;
      imageData.data[i + 3] = 255;
    }
    context.putImageData(imageData, 0, 0);
    const blob = await new Promise((resolveBlob, rejectBlob) => canvas.toBlob(
      (value) => (value ? resolveBlob(value) : rejectBlob(new Error('canvas.toBlob produced no blob'))),
      'image/png',
    ));
    const imageBytes = new Uint8Array(await blob.arrayBuffer());
    if (imageBytes.length < 20 * 1024) throw new Error('noise PNG below the 20 KiB capture minimum: ' + imageBytes.length);
    let binary = '';
    for (let i = 0; i < imageBytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, imageBytes.subarray(i, i + 0x8000));
    }
    const imageBase64 = btoa(binary);
    const digest = await crypto.subtle.digest('SHA-256', imageBytes);
    const sha256Hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const expectedAssetId = 'web-chatgpt-' + sha256Hex.slice(0, 12);

    const payload = {
      provider: 'chatgpt',
      mediaKind: 'image',
      mimeType: 'image/png',
      imageBase64,
      prompt: ${JSON.stringify(PROMPT_CAPTION)},
      prompt_status: 'visible-caption',
      prompt_source: 'visible-caption',
      prompt_priority: 20,
      prompt_scope: 'message',
      user_message: ${JSON.stringify(USER_MESSAGE)},
      generation_request_prompt: ${JSON.stringify(PROMPT_REQUEST)},
      generation_status: 'completed',
      page_url: ${JSON.stringify(PAGE_URL_CHATGPT)},
      source_media_url: ${JSON.stringify(MEDIA_URL_CHATGPT)},
      final_media_url: ${JSON.stringify(MEDIA_URL_CHATGPT)},
      conversation_id: ${JSON.stringify(CONVERSATION_CHATGPT)},
      message_id: ${JSON.stringify(MESSAGE_CHATGPT)},
      generation_context_id: 'e2e-genctx-0001',
      provider_asset_id: ${JSON.stringify(PROVIDER_ASSET_CHATGPT)},
      model: ${JSON.stringify(MODEL_CHATGPT)},
      capture_mode: 'automatic',
      extension_version: ${JSON.stringify(EXTENSION_VERSION)},
    };
    const response = await fetch('/api/ingest/web-capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
      body: JSON.stringify(payload),
    });
    const ingestBody = await response.json();
    const assetId = String(ingestBody?.asset?.id || '');
    if (assetId !== expectedAssetId) {
      throw new Error('unexpected archived asset id ' + assetId + ' (expected ' + expectedAssetId + ')');
    }

    // No reload, no navigation: the card must arrive through the library push.
    await waitFor(() => document.querySelector(cardSelector(assetId)), 'captured card appears without reload (library push)', 30000);
    await waitFor(() => gallerySettled(), 'gallery settles after the pushed card', 15000);
    // 任务 122：第一张推送卡片落位后空状态必须已经让位给真实卡片网格。
    await waitFor(() => !document.querySelector('#assetGrid > .gallery-empty-state'),
      'library empty state removed by the first pushed card', 10000);
    const card = document.querySelector(cardSelector(assetId));
    const cardTitle = card?.querySelector('.asset-card-title')?.textContent || '';
    const cardMetaSpans = [...(card?.querySelectorAll('.asset-card-meta span') || [])].map((node) => node.textContent);

    // The card was just mounted by the library push and background
    // reconciliation can still replace its node; clickUntil re-queries the
    // live card on every attempt instead of clicking a detached node.
    await clickUntil(
      () => document.querySelector(cardSelector(assetId) + ' .asset-card-select'),
      () => detailOpen() && selectedId() === assetId,
      'inspector opens for the captured asset',
      15000,
    );
    const detailPrompt = panel()?.querySelector('.prompt-box.detail-prompt-box[data-prompt-panel="1"]')?.textContent?.trim() || '';
    const detailRequestPrompt = panel()?.querySelector('.prompt-box.detail-prompt-box[data-prompt-panel="2"]')?.textContent?.trim() || '';
    // GravityPort A4a：来源区块（summary + meta 表）已从检视器拿掉——来源名改从
    // 头部「来源 · 日期」行读取,并锁「来源区块不再渲染」;conversation id 改经
    // API 验证（Node 侧）。
    const headSourceLine = panel()?.querySelector('.asset-kind')?.textContent?.trim() || '';
    const sourceLabel = headSourceLine.split('·')[0]?.trim() || '';
    const sourceSectionAbsent = !panel()?.querySelector('[data-inspector-section="source"]');
    const assetSource = await fetch('/api/assets/default/' + encodeURIComponent(assetId)).then((r) => r.json()).then((body) => body?.asset?.source || {});
    const assetConversationId = assetSource.conversation_id || '';
    const assetMessageId = assetSource.message_id || '';
    const assetModel = assetSource.model || '';

    const sourceNav = () => document.querySelector('#sidebarGroupList button[data-filter="source"][data-value="web-chatgpt"]');
    await waitFor(() => sourceNav() && sourceNav().querySelector('.nav-count')?.textContent === '1',
      'sidebar source nav lists web-chatgpt with count 1', 20000);
    const sourceFilterNavCount = sourceNav().querySelector('.nav-count')?.textContent || '';
    sourceNav().click();
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify([assetId]),
      'source filter narrows the gallery to the captured card', 15000);

    // Extension retry shape: resending the identical capture from the same
    // open page must resolve to the existing asset and add no gallery card.
    const duplicateResponse = await fetch('/api/ingest/web-capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
      body: JSON.stringify(payload),
    });
    const duplicateBody = await duplicateResponse.json();
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify([assetId]),
      'duplicate capture adds no gallery card', 15000);

    // Reopened-conversation shape: the replay carries the same image and page
    // anchors but no live prompt/model data — exactly what the plugin reports
    // when it re-reads an old page. The stored generation event must keep its
    // captured prompt and model instead of collapsing to empty.
    const replayResponse = await fetch('/api/ingest/web-capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + config.token },
      body: JSON.stringify({ ...payload, prompt: '', prompt_status: 'not-available', user_message: '', model: '' }),
    });
    const replayBody = await replayResponse.json();
    await waitFor(() => gallerySettled() && JSON.stringify(rootCardIds()) === JSON.stringify([assetId]),
      'prompt-less replay adds no gallery card', 15000);

    return {
      initialCardCount,
      httpStatus: response.status,
      ingestStatus: ingestBody?.status || '',
      assetId,
      cardAppeared: true,
      cardTitle,
      cardMetaSpans,
      detailPrompt,
      detailRequestPrompt,
      sourceLabel,
      sourceSectionAbsent,
      assetConversationId,
      assetMessageId,
      assetModel,
      sourceFilterNavCount,
      sourceFilterCardIds: rootCardIds(),
      duplicateHttpStatus: duplicateResponse.status,
      duplicateStatus: duplicateBody?.status || '',
      duplicateReason: duplicateBody?.reason || '',
      duplicateAssetId: String(duplicateBody?.asset?.id || ''),
      replayHttpStatus: replayResponse.status,
      replayStatus: replayBody?.status || '',
      replayReason: replayBody?.reason || '',
      rendererErrors: rendererErrors.slice(0, 3),
    };
  })()`;
}

// Loads the extension's page-world turn extractor verbatim from page-hook.js
// (the same source the real hook executes) so the flow exercises the real
// conversation-structure parsing, not a reimplementation.
async function loadConversationTurnBindingExtractor() {
  const hookSource = await readFile(new URL("../../extensions/chatgpt-web-capture/page-hook.js", import.meta.url), "utf8");
  const names = [
    "normalizeAssetId",
    "isHiddenConversationUserMessage",
    "isConversationUserMessage",
    "conversationGenerationAssets",
    "extractConversationTurnBindings",
    "extractMessagesConversationTurnBindings",
  ];
  const pieces = [/const MAX_CONVERSATION_TURN_BINDINGS = [^;]+;/.exec(hookSource)?.[0]];
  for (const name of names) {
    const match = new RegExp(`\\n {2}function ${name}\\([\\s\\S]*?\\n {2}\\}`).exec(hookSource);
    if (!match) throw new Error(`web-capture: page-hook.js is missing the extractable function ${name}`);
    pieces.push(match[0]);
  }
  const context = {};
  vm.runInNewContext(`${pieces.filter(Boolean).join("\n")}\nthis.extractRaw = extractConversationTurnBindings;`, context, { filename: "page-hook-turn-bindings.js" });
  return (input) => {
    const report = context.extractRaw(input);
    return report ? JSON.parse(JSON.stringify(report)) : null;
  };
}

// Third window on the same library: the Inspector's generation history must
// render the event the turn snapshot just annotated.
function turnBindingInspectorSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const panel = () => document.querySelector('#detailPanel');
    const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
    const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';

    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'gallery shows the three captured cards', 20000);
    const selectButton = () => document.querySelector(cardSelector(config.chatgptAssetId) + ' .asset-card-select');
    await waitFor(() => selectButton()?.isConnected, 'captured card is on screen', 15000);
    selectButton().click();
    await waitFor(() => detailOpen() && selectedId() === config.chatgptAssetId, 'inspector shows the captured asset', 15000);
    await waitFor(() => (document.querySelector('[data-generation-history]')?.querySelectorAll('.generation-lineage-item')?.length || 0) >= 1,
      'generation history renders at least one event for the captured asset', 15000);
    return {
      historyItems: document.querySelector('[data-generation-history]')?.querySelectorAll('.generation-lineage-item')?.length || 0,
    };
  })()`;
}

// Second window on the same library: persistence, source nav for all three
// captures, and the prompt completed by the metadata pass.
function finalVerificationSource(config) {
  return `(async () => {
    const config = ${JSON.stringify(config)};
    ${PAGE_HELPERS}
    const panel = () => document.querySelector('#detailPanel');
    const detailOpen = () => panel()?.getAttribute('aria-hidden') === 'false';
    const selectedId = () => document.querySelector('.asset-card.selected')?.dataset.id || '';
    async function openDetailFor(assetId) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const button = document.querySelector(cardSelector(assetId) + ' .asset-card-select');
        if (button?.isConnected) break;
        await sleep(100);
      }
      document.querySelector(cardSelector(assetId) + ' .asset-card-select')?.click();
      await waitFor(() => detailOpen() && selectedId() === assetId, 'inspector shows ' + assetId, 15000);
    }

    await waitFor(() => gallerySettled() && rootCardIds().length === 3, 'three captured cards after reload', 20000);
    const rootCardIdsBeforeFilter = rootCardIds();
    const sourceNavCounts = {};
    for (const value of ['web-chatgpt', 'web-gemini', 'web-flow']) {
      const nav = () => document.querySelector('#sidebarGroupList button[data-filter="source"][data-value="' + value + '"]');
      await waitFor(() => nav() && nav().querySelector('.nav-count')?.textContent === '1',
        'sidebar source nav lists ' + value + ' with count 1', 20000);
      sourceNavCounts[value] = nav().querySelector('.nav-count')?.textContent || '';
    }

    await openDetailFor(config.chatgptAssetId);
    const chatgptPrompt = panel()?.querySelector('.prompt-box.detail-prompt-box[data-prompt-panel="1"]')?.textContent?.trim() || '';
    const chatgptRequestPrompt = panel()?.querySelector('.prompt-box.detail-prompt-box[data-prompt-panel="2"]')?.textContent?.trim() || '';
    const chatgptCardTitle = document.querySelector(cardSelector(config.chatgptAssetId) + ' .asset-card-title')?.textContent || '';
    await openDetailFor(config.geminiAssetId);
    const geminiPrompt = panel()?.querySelector('.prompt-box.detail-prompt-box[data-prompt-panel="1"]')?.textContent?.trim() || '';

    return { rootCardIds: rootCardIdsBeforeFilter, sourceNavCounts, chatgptPrompt, chatgptRequestPrompt, chatgptCardTitle, geminiPrompt, rendererErrors: rendererErrors.slice(0, 3) };
  })()`;
}
