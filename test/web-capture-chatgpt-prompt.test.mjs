// web-capture-chatgpt-prompt.test.mjs — task 353: ChatGPT captures store the
// real image-tool prompt as 提示词1 and the model's caption of the finished
// image in source.model_caption (提示词2). Every ingest input below is built
// from the real 2026-11-03 Chrome capture in
// test/fixtures/chatgpt-image-gen-ws-2026-11-03.json (README.md in
// 素材/工具/2-4-chatgpt-samples documents how each field was observed).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it, test } from "node:test";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { withUserEditMarkers } from "../lib/user-edit-marker.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";

const SAMPLE = JSON.parse(readFileSync(
  new URL("./fixtures/chatgpt-image-gen-ws-2026-11-03.json", import.meta.url),
  "utf8",
));

// Frame 11: the hidden assistant tool call whose content.text is the JSON the
// chat model sent to the image tool ({prompt, aspect_ratio, …}).
const TOOL_CALL_FRAME = SAMPLE.wsFrames.find((entry) => entry.i === 11);
// Frame 15: the hidden tool result carrying the image plus "Model caption: …".
const TOOL_RESULT_FRAME = SAMPLE.wsFrames.find((entry) => entry.i === 15);

const toolCallMessage = TOOL_CALL_FRAME.frame.payload.update_content.messages[0];
const toolResultMessage = TOOL_RESULT_FRAME.frame.payload.update_content.messages[0];
const REAL_REQUEST_PROMPT = JSON.parse(toolCallMessage.content.text).prompt;
const CAPTION = toolResultMessage.content.parts.find((part) => typeof part === "string" && part.startsWith("Model caption: "));
const FILE_ID = toolResultMessage.content.parts
  .find((part) => part?.content_type === "image_asset_pointer").asset_pointer
  .replace(/^sediment:\/\//, "");
const CONVERSATION_ID = TOOL_RESULT_FRAME.frame.payload.conversation_id;
const MESSAGE_ID = toolResultMessage.id;

async function noiseImage(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251) + seed * 13) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

/** The capture payload the extension sends for frame 15's image (the
 * description still travels as the main prompt; the App decides the swap). */
function frame15CaptureInput(imageBase64, overrides = {}) {
  return {
    provider: "chatgpt",
    prompt: CAPTION,
    promptStatus: "visible-caption",
    generationRequestPrompt: REAL_REQUEST_PROMPT,
    mimeType: "image/png",
    imageBase64,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    generationContextId: `chatgpt:${CONVERSATION_ID}:${MESSAGE_ID}`,
    providerAssetId: FILE_ID,
    generationStatus: "completed",
    ...overrides,
  };
}

async function sampleLibrary(t, prefix = "mosa-web-chatgpt-prompt-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  return { store, tempRoot: join(libraryDir, ".web-capture-tmp") };
}

test("a frame-15 style capture stores the real tool prompt as 提示词1 and the caption as model_caption", async (t) => {
  const { store, tempRoot } = await sampleLibrary(t);
  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput((await noiseImage(3531)).toString("base64")),
  });
  assert.equal(first.status, "imported");
  assert.equal(first.asset.prompt, REAL_REQUEST_PROMPT, "提示词1 is the prompt the chat model sent to the image tool");
  assert.equal(first.asset.source?.prompt_status, "generation-tool-prompt");
  assert.equal(first.asset.business_fields?.prompt_status, "generation-tool-prompt");
  assert.equal(first.asset.source?.model_caption, CAPTION, "the description the extension sent as its main prompt is kept for 提示词2");
  assert.equal(first.asset.source?.generation_request_prompt, REAL_REQUEST_PROMPT);
  assert.match(String(first.asset.theme), /^Create a simple illustration/, "the theme derives from the stored prompt");

  const [event] = await store.listGenerationEvents("default", { captureContextId: `chatgpt:${CONVERSATION_ID}:${MESSAGE_ID}` });
  assert.ok(event);
  assert.equal(event.effective_prompt, REAL_REQUEST_PROMPT);
  assert.equal(event.prompt_status, "generation-tool-prompt");
  assert.equal(event.provider_asset_id, FILE_ID);
});

test("a capture with only the request prompt (placeholder-style) still fills 提示词1", async (t) => {
  const { store, tempRoot } = await sampleLibrary(t);
  const imported = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput((await noiseImage(3532)).toString("base64"), {
      prompt: "",
      promptStatus: "not-available",
    }),
  });
  assert.equal(imported.status, "imported");
  assert.equal(imported.asset.prompt, REAL_REQUEST_PROMPT);
  assert.equal(imported.asset.source?.prompt_status, "generation-tool-prompt");
  assert.equal(imported.asset.source?.model_caption ?? null, null, "no caption travelled with a placeholder-only capture");
});

test("an already-archived caption asset is never rewritten to the request prompt", async (t) => {
  const { store, tempRoot } = await sampleLibrary(t);
  const imageBase64 = (await noiseImage(3533)).toString("base64");
  // Old-world asset: the extension missed the live push, so only the caption
  // was archived (no request prompt anywhere).
  const old = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput(imageBase64, { generationRequestPrompt: "" }),
  });
  assert.equal(old.status, "imported");
  assert.equal(old.asset.prompt, CAPTION);
  // The pre-353 backfill put the request prompt beside the caption.
  await store.updateMetadata("default", old.asset.id, {
    source: { ...(old.asset.source || {}), generation_request_prompt: REAL_REQUEST_PROMPT },
  });

  const again = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput(imageBase64),
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.asset.prompt, CAPTION, "the stored prompt must not be swapped to the request prompt");
  assert.equal(again.asset.source?.prompt_status, "visible-caption");
  assert.equal(again.asset.source?.model_caption ?? null, null, "old assets stay untouched (user decision 2026-11-03)");
  assert.equal(again.asset.source?.generation_request_prompt, REAL_REQUEST_PROMPT);
});

test("a user-edited prompt survives a frame-15 style recapture", async (t) => {
  const { store, tempRoot } = await sampleLibrary(t);
  const imageBase64 = (await noiseImage(3534)).toString("base64");
  const first = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput(imageBase64),
  });
  assert.equal(first.status, "imported");

  // The UI PATCH entry point: stamp markers the way lib/api/asset-routes.mjs does.
  await store.updateMetadata("default", first.asset.id, withUserEditMarkers(
    await store.getAsset("default", first.asset.id),
    { prompt: "手改：只要苹果，不要桌子" },
  ));

  const again = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: frame15CaptureInput(imageBase64),
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.asset.prompt, "手改：只要苹果，不要桌子", "the user edit must survive the recapture");
  assert.ok(again.asset.source?.prompt_user_edited_at);
  assert.equal(again.asset.source?.model_caption, CAPTION, "the caption stored at creation is unchanged by the recapture");
});

// --- 提示词2 display layer (mosa-api.ts normalizeAsset) ---

// mosa-api.ts is a browser-facing TypeScript source, so the display-layer
// tests compile the real file on the fly (same approach as library-sync.test.mjs).
const uiTempRoot = await mkdtemp(join(tmpdir(), "mosa-chatgpt-prompt-ui-"));
after(() => rm(uiTempRoot, { recursive: true, force: true }));
{
  const uiRoot = resolve(import.meta.dirname, "..", "web", "gravityport");
  const outDir = join(uiTempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(import.meta.dirname, "..", "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "mosa-api.ts"),
    "--outDir", outDir,
    "--rootDir", join(uiRoot, "src"),
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { stdio: "pipe" });
}
const { normalizeAsset } = await import(join(uiTempRoot, "out", "mosa-api.js"));

describe("normalizeAsset prompt2", () => {
  it("shows the model caption for post-353 captures (request prompt equals 提示词1)", () => {
    const asset = normalizeAsset({
      id: "new",
      prompt: REAL_REQUEST_PROMPT,
      source: {
        model_caption: CAPTION,
        generation_request_prompt: REAL_REQUEST_PROMPT,
      },
    });
    assert.equal(asset.prompt2, CAPTION);
  });

  it("keeps the pre-353 display: the request prompt beside a caption 提示词1", () => {
    const asset = normalizeAsset({
      id: "old",
      prompt: CAPTION,
      source: { generation_request_prompt: REAL_REQUEST_PROMPT },
    });
    assert.equal(asset.prompt2, REAL_REQUEST_PROMPT);
  });

  it("hides 提示词2 when only the request prompt exists and it already is 提示词1", () => {
    const asset = normalizeAsset({
      id: "placeholder",
      prompt: REAL_REQUEST_PROMPT,
      source: { generation_request_prompt: REAL_REQUEST_PROMPT },
    });
    assert.equal(asset.prompt2, "");
  });

  it("still reads the business_fields fallback for the request prompt", () => {
    const asset = normalizeAsset({
      id: "fields",
      prompt: "页面描述",
      business_fields: { generation_request_prompt: "工具提示词" },
    });
    assert.equal(asset.prompt2, "工具提示词");
  });
});
