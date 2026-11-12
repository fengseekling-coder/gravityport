// Task 377: MCP polish round.
//
// - AI saves through MCP default to source type "mcp-agent" (shown as
//   "AI 助手" in the App); Codex output keeps "codex-generated"; caller-named
//   sources are kept; asset_import_folder stamps the same default per file.
// - A PNG stream that stops short of its IEND trailer is refused with
//   IMAGE_FILE_INCOMPLETE (MCP and the App's POST /api/assets/import-batch).
// - An image beyond the derivative pixel ceiling is saved with a bilingual
//   warning and structuredContent.warnings.
// - Asset ids that do not match ^[A-Za-z0-9_-]{1,96}$ are refused with
//   INVALID_ASSET_ID before the store's sanitizeId could mangle them.
// - System-recorded business fields are dropped with an ignored_fields
//   notice; the edit markers' own prompt_status write still lands.
// - generation_record backfills an empty user_prompt slot (first wording
//   wins, never overwrites), which makes the wording searchable.

import { crc32 } from "node:zlib";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

let outsideIndex = 1;
/** A PNG with unique bytes outside the Codex output directory (plain AI-saved situation). */
async function outsidePng(workspace) {
  outsideIndex += 1;
  const dir = join(workspace.root, "outside");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, `mcp-agent-${outsideIndex}.png`);
  await writeFile(filePath, await uniquePngBytes(outsideIndex));
  return filePath;
}

async function writeTruncatedPng(filePath) {
  await mkdir(join(filePath, ".."), { recursive: true });
  const full = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#445566" } }).png().toBuffer();
  // Keep the first half: the head still carries signature + IHDR (isPng true),
  // the IEND trailer is gone — exactly the "cut off mid-download" shape.
  await writeFile(filePath, full.subarray(0, Math.floor(full.length / 2)));
  return filePath;
}

async function writeHugePng(filePath, { width = 16500, height = 16500 } = {}) {
  await mkdir(join(filePath, ".."), { recursive: true });
  // 16500×16500 = 272,250,000 pixels — past the 268,402,689 derivative ceiling
  // (task 380). Declare the dimensions in the PNG IHDR header with a valid CRC
  // so header-only metadata reads report them without encoding 272M pixels.
  const buf = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#223344" } }).png().toBuffer();
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf.writeUInt32BE(crc32(buf.subarray(12, 29)), 29);
  await writeFile(filePath, buf);
  return filePath;
}

test("1. asset_create stamps mcp-agent when the AI names no source", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const filePath = await outsidePng(workspace);
  const created = await server.callToolStrict("asset_create", { imagePath: filePath, prompt: "saved by the assistant" });
  const asset = created.structuredContent.asset;
  assert.equal(asset.source?.type, "mcp-agent");

  // A caller-named sourceType survives.
  const named = join(workspace.root, "outside", "named.png");
  await writePngFixture(named, { color: "#a10203" });
  const namedResult = await server.callToolStrict("asset_create", { imagePath: named, prompt: "named", sourceType: "local-file" });
  assert.equal(namedResult.structuredContent.asset.source?.type, "local-file");

  // A caller-named source.type survives too.
  const sourced = join(workspace.root, "outside", "sourced.png");
  await writePngFixture(sourced, { color: "#a20405" });
  const sourcedResult = await server.callToolStrict("asset_create", { imagePath: sourced, prompt: "sourced", source: { type: "studio-pipeline" } });
  assert.equal(sourcedResult.structuredContent.asset.source?.type, "studio-pipeline");

  // Files in the Codex output directory keep the store's codex-generated stamp.
  const codexFile = join(workspace.imagesDir, "codex-task-1", "codex-out.png");
  await writePngFixture(codexFile, { color: "#a30607" });
  const codexResult = await server.callToolStrict("asset_create", { imagePath: codexFile, prompt: "from codex" });
  assert.equal(codexResult.structuredContent.asset.source?.type, "codex-generated");

  // The tool description names the new default.
  const listed = await server.request("tools/list", {});
  const createTool = listed.result.tools.find((tool) => tool.name === "asset_create");
  assert.match(createTool.inputSchema.properties.sourceType.description, /mcp-agent/);
});

test("2. asset_import_folder stamps mcp-agent per file when no source is named", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const folder = join(workspace.root, "batch-folder");
  await mkdir(join(folder, "sub"), { recursive: true });
  await writePngFixture(join(folder, "one.png"), { color: "#b10102" });
  await writePngFixture(join(folder, "sub", "two.png"), { color: "#b20304" });
  const imported = await server.callToolStrict("asset_import_folder", { folderPath: folder, recursive: true });
  assert.equal(imported.structuredContent.imported, 2);

  const list = await server.callToolStrict("asset_list", { limit: 100 });
  assert.equal(list.structuredContent.total, 2);
  for (const summary of list.structuredContent.assets) {
    const full = await server.callToolStrict("asset_get", { assetId: summary.id });
    assert.equal(full.structuredContent.asset.source?.type, "mcp-agent", `asset ${summary.id} should be mcp-agent`);
  }

  // A folder inside the Codex output directory keeps codex-generated.
  const codexFolder = join(workspace.imagesDir, "codex-task-2");
  await mkdir(codexFolder, { recursive: true });
  await writePngFixture(join(codexFolder, "three.png"), { color: "#c30506" });
  const codexImport = await server.callToolStrict("asset_import_folder", { folderPath: codexFolder });
  assert.equal(codexImport.structuredContent.imported, 1);
  const codexAssetId = codexImport.structuredContent.assetIds[0];
  const codexAsset = await server.callToolStrict("asset_get", { assetId: codexAssetId });
  assert.equal(codexAsset.structuredContent.asset.source?.type, "codex-generated");
});

const INCOMPLETE_ZH = "这张图的文件不完整，可能下载或复制时断了，请换一份完整的文件。";
const INCOMPLETE_EN = "The image file is incomplete (it may have been cut off while downloading or copying).";

test("3. a truncated PNG is refused with IMAGE_FILE_INCOMPLETE (bilingual)", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const truncated = await writeTruncatedPng(join(workspace.root, "outside", "truncated-mcp.png"));
  const result = await server.callTool("asset_create", { imagePath: truncated, prompt: "broken" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "IMAGE_FILE_INCOMPLETE");
  assert.ok(result.content[0].text.includes(INCOMPLETE_ZH), `content should carry the Chinese reason, got: ${result.content[0].text}`);
  assert.ok(result.content[0].text.includes(INCOMPLETE_EN), `content should keep the English sentence, got: ${result.content[0].text}`);

  // The library is untouched.
  const list = await server.callToolStrict("asset_list", {});
  assert.equal(list.structuredContent.total, 0);

  // A complete PNG still imports.
  const complete = await outsidePng(workspace);
  const ok = await server.callToolStrict("asset_create", { imagePath: complete, prompt: "fine" });
  assert.equal(ok.structuredContent.asset.source?.type, "mcp-agent");

  // A complete PNG with bytes appended after IEND (some tools add metadata
  // there) still imports: only a missing trailer means the file was cut off.
  const padded = join(workspace.root, "outside", "padded-after-iend.png");
  await writeFile(padded, Buffer.concat([await uniquePngBytes(9001), Buffer.alloc(300, 0x41)]));
  const paddedOk = await server.callToolStrict("asset_create", { imagePath: padded, prompt: "trailing bytes" });
  assert.ok(paddedOk.structuredContent.asset.id, "a PNG with bytes after IEND is accepted");
});

test("4. an image beyond 268 megapixels saves with a preview warning", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const huge = await writeHugePng(join(workspace.root, "outside", "huge-16500.png"));
  const created = await server.callToolStrict("asset_create", { imagePath: huge, prompt: "too big for previews" });
  assert.deepEqual(created.structuredContent.warnings, ["IMAGE_TOO_LARGE_FOR_PREVIEW"]);
  assert.match(created.content[0].text, /这张图超过 2\.68 亿像素，App 里不会生成缩略图和预览。\/ This image exceeds 268 megapixels; the App will not generate a thumbnail or preview for it\./);
  assert.equal(created.structuredContent.asset.business_fields.width, 16500);
  assert.equal(created.structuredContent.asset.business_fields.height, 16500);

  // A normal image carries neither the warning text nor the warnings key.
  const normal = await outsidePng(workspace);
  const quiet = await server.callToolStrict("asset_create", { imagePath: normal, prompt: "normal size" });
  assert.equal(quiet.structuredContent.warnings, undefined);
  assert.ok(!quiet.content[0].text.includes("2.68 亿像素"));
});

test("5. asset ids that are not letters/digits/_/- are refused before the store", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const filePath = await outsidePng(workspace);

  const chineseCreate = await server.callTool("asset_create", { imagePath: filePath, assetId: "蓝色鲸鱼", prompt: "x" });
  assert.equal(chineseCreate.isError, true);
  assert.equal(chineseCreate.structuredContent.error.code, "INVALID_ASSET_ID");
  assert.match(chineseCreate.content[0].text, /名字只能用英文字母、数字、下划线和连字符，最长 96 个字；不传的话会自动起名。/);
  assert.match(chineseCreate.content[0].text, /Asset ids may only use letters, digits, underscores and hyphens \(up to 96 characters\); omit it to get one generated\./);

  const created = await server.callToolStrict("asset_create", { imagePath: filePath, prompt: "base asset" });
  const assetId = created.structuredContent.asset.id;

  const badDuplicate = await server.callTool("asset_duplicate", { assetId, assetIdNew: "复制版" });
  assert.equal(badDuplicate.structuredContent.error.code, "INVALID_ASSET_ID");

  const badVersion = await server.callTool("asset_version_create", { assetId, assetIdNew: "新版本一", version_change: "tweak" });
  assert.equal(badVersion.structuredContent.error.code, "INVALID_ASSET_ID");

  // The 96-character boundary: 96 chars pass, 97 refuse.
  const boundaryPath = await outsidePng(workspace);
  const created96 = await server.callToolStrict("asset_create", { imagePath: boundaryPath, assetId: "a".repeat(96), prompt: "boundary" });
  assert.equal(created96.structuredContent.asset.id, "a".repeat(96));
  const refused97 = await server.callTool("asset_create", { imagePath: boundaryPath, assetId: "a".repeat(97), prompt: "over boundary" });
  assert.equal(refused97.structuredContent.error.code, "INVALID_ASSET_ID");

  // A conforming custom id is kept as-is (fresh bytes, no dedup).
  const customPath = await outsidePng(workspace);
  const custom = await server.callToolStrict("asset_create", { imagePath: customPath, assetId: "my_whale-01", prompt: "custom id" });
  assert.equal(custom.structuredContent.asset.id, "my_whale-01");
});

function systemNoticeText(keys) {
  return `这次传的 ${keys} 是系统记录的，没有改。/ ${keys} are recorded by GravityPort and were not changed.`;
}

function assertNotice(text, keys) {
  assert.ok(text.includes(systemNoticeText(keys)), `content should carry the system-fields notice for ${keys}, got: ${text}`);
}

test("6. system-recorded business fields are dropped and reported", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  // asset_create: width/height are recomputed from the file, other keys stay.
  const filePath = await outsidePng(workspace, { width: 8, height: 8 });
  const created = await server.callToolStrict("asset_create", {
    imagePath: filePath,
    prompt: "system fields at create",
    business_fields: { width: 1, height: 1, media_kind: "video", note: "kept" },
  });
  const asset = created.structuredContent.asset;
  assert.deepEqual(created.structuredContent.ignored_fields, ["width", "height", "media_kind"]);
  assertNotice(created.content[0].text, "width, height, media_kind");
  assert.equal(asset.business_fields.width, 8, "width stays the file's real width");
  assert.equal(asset.business_fields.height, 8);
  assert.notEqual(asset.business_fields.media_kind, "video");
  assert.equal(asset.business_fields.note, "kept");

  // asset_update_metadata: null values are dropped too, real values survive.
  const updated = await server.callToolStrict("asset_update_metadata", {
    assetId: asset.id,
    business_fields: { width: null, duration_seconds: 42, flavor: "vanilla" },
  });
  assert.deepEqual(updated.structuredContent.ignored_fields, ["width", "duration_seconds"]);
  assertNotice(updated.content[0].text, "width, duration_seconds");
  assert.equal(updated.structuredContent.asset.business_fields.width, 8);
  assert.equal(updated.structuredContent.asset.business_fields.duration_seconds, undefined);
  assert.equal(updated.structuredContent.asset.business_fields.flavor, "vanilla");

  // asset_version_create: the same keys are dropped and reported.
  const version = await server.callToolStrict("asset_version_create", {
    assetId: asset.id,
    version_change: "metadata-only version",
    business_fields: { width: 1, file_bytes: 1, tone: "warm" },
  });
  assert.deepEqual(version.structuredContent.ignored_fields, ["width", "file_bytes"]);
  assertNotice(version.content[0].text, "width, file_bytes");
  assert.equal(version.structuredContent.asset.business_fields.width, 8, "the version keeps the real width");
  assert.equal(version.structuredContent.asset.business_fields.tone, "warm");
});

test("7. a prompt edit still becomes user-edited after the system-field strip", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const filePath = await outsidePng(workspace);
  const created = await server.callToolStrict("asset_create", { imagePath: filePath, prompt: "first prompt" });

  const edited = await server.callToolStrict("asset_update_metadata", {
    assetId: created.structuredContent.asset.id,
    prompt: "hand typed by the assistant on the user's behalf",
    business_fields: { prompt_status: "whatever" },
  });
  assert.deepEqual(edited.structuredContent.ignored_fields, ["prompt_status"]);
  assert.equal(edited.structuredContent.asset.business_fields.prompt_status, "user-edited");
  assert.equal(edited.structuredContent.asset.source.prompt_status, "user-edited");
  assert.ok(edited.structuredContent.asset.source.prompt_user_edited_at, "the prompt marker must be stamped");

  // A prompt_status-only patch changes nothing and stamps no marker.
  const before = edited.structuredContent.asset.source.prompt_user_edited_at;
  const statusOnly = await server.callToolStrict("asset_update_metadata", {
    assetId: created.structuredContent.asset.id,
    business_fields: { prompt_status: "not-available" },
  });
  assert.deepEqual(statusOnly.structuredContent.ignored_fields, ["prompt_status"]);
  assert.equal(statusOnly.structuredContent.asset.business_fields.prompt_status, "user-edited");
  assert.equal(statusOnly.structuredContent.asset.source.prompt_user_edited_at, before);
});

test("8. generation_record backfills an empty user_prompt slot; first wording wins", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const filePath = await outsidePng(workspace);
  const created = await server.callToolStrict("asset_create", { imagePath: filePath, prompt: "effective prompt only" });
  const assetId = created.structuredContent.asset.id;

  await server.callToolStrict("generation_record", { outputAssetId: assetId, provider: "test", userPrompt: "画一张蓝色的鲸鱼" });

  const found = await server.callToolStrict("asset_search", { query: "蓝色的鲸鱼" });
  assert.ok(
    found.structuredContent.results.some((entry) => entry.asset.id === assetId),
    "the backfilled user_prompt must be searchable",
  );
  const asset = await server.callToolStrict("asset_get", { assetId });
  assert.equal(asset.structuredContent.asset.user_prompt, "画一张蓝色的鲸鱼");

  // A second record never replaces the first wording.
  await server.callToolStrict("generation_record", { outputAssetId: assetId, provider: "test", userPrompt: "别的话" });
  const after = await server.callToolStrict("asset_get", { assetId });
  assert.equal(after.structuredContent.asset.user_prompt, "画一张蓝色的鲸鱼");

  // An asset that already carries a user_prompt is left alone.
  const otherPath = await outsidePng(workspace);
  const withPrompt = await server.callToolStrict("asset_create", {
    imagePath: otherPath,
    prompt: "has its own wording",
    user_prompt: "原始要求",
  });
  const withPromptId = withPrompt.structuredContent.asset.id;
  await server.callToolStrict("generation_record", { outputAssetId: withPromptId, provider: "test", userPrompt: "新的话" });
  const kept = await server.callToolStrict("asset_get", { assetId: withPromptId });
  assert.equal(kept.structuredContent.asset.user_prompt, "原始要求");
});

test("9. the App's import-batch refuses a truncated PNG with the same code", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-377-import-"));
  t.after(() => import("./test-cleanup.mjs").then(({ removeTestPath }) => removeTestPath(dir, { recursive: true, force: true })));
  const generated = join(dir, "generated-images");
  await mkdir(generated, { recursive: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: generated,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const truncated = await writeTruncatedPng(join(generated, "truncated-batch.png"));
  const response = await fetch(`${runtime.url}/api/assets/import-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", items: [{ imagePath: truncated, fileName: "truncated-batch.png" }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.imported, 0);
  assert.equal(body.failed, 1);
  assert.equal(body.results[0].ok, false);
  assert.equal(body.results[0].code, "IMAGE_FILE_INCOMPLETE");
});

test("10. the App toast keeps its generic import-failure sentence for the new code", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mosa-377-error-messages-"));
  try {
    // Same compile step gravityport-inspector-info.test.mjs uses for the
    // TypeScript sources under web/gravityport/src.
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(repositoryRoot, "web", "gravityport", "src", "error-messages.ts"),
      "--outDir", tempRoot, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck",
    ], { stdio: "pipe" });
    const errorMessages = await import(join(tempRoot, "error-messages.js"));
    // The import toast composes its reason with messageForErrorCode and
    // importFailureTail; both answering "" means the App falls back to the
    // existing "无法导入素材。" sentence — no raw English, no bare unknown-code
    // gibberish — because IMAGE_FILE_INCOMPLETE has no App copy (377 may not
    // add one).
    assert.equal(errorMessages.messageForErrorCode("IMAGE_FILE_INCOMPLETE", "zh"), "");
    assert.equal(errorMessages.messageForErrorCode("IMAGE_FILE_INCOMPLETE", "en"), "");
    assert.equal(errorMessages.importFailureTail("IMAGE_FILE_INCOMPLETE", "zh"), "");
    // Control: a code with an App copy keeps its sentence.
    assert.match(errorMessages.messageForErrorCode("IMAGE_CONTENT_NOT_MEDIA", "zh"), /导入失败，文件不是支持的格式/);
  } finally {
    await import("./test-cleanup.mjs").then(({ removeTestPath }) => removeTestPath(tempRoot, { recursive: true, force: true }));
  }
});
