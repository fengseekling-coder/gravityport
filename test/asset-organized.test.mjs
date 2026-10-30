// Task 304: one "整理过" list shared by the unorganized inbox, the provider
// deletion sync and "标为已整理". These tests run the real SQLite store and the
// real web-capture ingest, so the system-tag rules are checked against what the
// capture pipeline actually writes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { applyProviderDeletions } from "../lib/provider-deletion-sync.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function makeStore(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-asset-organized-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  await store.ensureProject("default");
  return { store, libraryDir, sourcePath };
}

async function plainAsset(store, sourcePath, assetId, extra = {}) {
  return store.createAsset({
    assetId,
    imagePath: sourcePath,
    prompt: `prompt ${assetId}`,
    source: { type: "local-file" },
    ...extra,
  });
}

async function unorganizedIds(store) {
  return (await store.listAssets({ projectId: "default", unorganized: true })).map((asset) => asset.id).sort();
}

// High-entropy raster so the capture passes the logo gate; a seed per asset
// keeps the content hashes distinct so captures never dedupe.
async function jpegBase64(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + seed * 17 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
}

let nextSeed = 1;
async function ingestJimengImage(store, libraryDir, itemId, recordId = `rec-${itemId}`) {
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(libraryDir, ".web-capture-tmp"),
    projectId: "default",
    input: {
      provider: "jimeng",
      mediaKind: "image",
      imageBase64: await jpegBase64(nextSeed++),
      mimeType: "image/jpeg",
      providerAssetId: itemId,
      conversationId: recordId,
      generationContextId: recordId,
      pageUrl: "https://jimeng.jianying.com/ai-tool/asset",
    },
  });
  assert.equal(imported.status, "imported");
  return imported.asset;
}

// Minimal ftyp-headered MP4 so the real store accepts a video.
function sampleMp4Bytes() {
  const bytes = Buffer.alloc(96 * 1024, 7);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0x200, 12);
  bytes.write("isom", 16, "ascii");
  bytes.write("mp42", 20, "ascii");
  return bytes;
}

async function ingestJimengVideo(store, libraryDir, itemId) {
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(libraryDir, ".web-capture-tmp"),
    projectId: "default",
    input: {
      provider: "jimeng",
      mediaKind: "video",
      mediaBase64: sampleMp4Bytes().toString("base64"),
      mimeType: "video/mp4",
      providerAssetId: itemId,
      generationStatus: "completed",
      pageUrl: "https://jimeng.jianying.com/ai-tool/asset",
    },
  });
  assert.equal(imported.status, "imported");
  return imported.asset;
}

test("each organized clause alone takes an asset out of Unorganized; none leaves it there", async (t) => {
  const { store, sourcePath } = await makeStore(t);
  const cases = {
    favorite: "favorite",
    rated: "rated",
    grouped: "grouped",
    userTag: "userTag",
    curated: "curated",
    curationNote: "curationNote",
    userEdited: "userEdited",
    promptEdited: "promptEdited",
  };
  const ids = {};
  for (const name of Object.keys(cases)) ids[name] = (await plainAsset(store, sourcePath, name)).id;
  const plain = (await plainAsset(store, sourcePath, "plain")).id;
  const manualA = (await plainAsset(store, sourcePath, "manual-a")).id;
  const manualB = (await plainAsset(store, sourcePath, "manual-b")).id;

  await store.toggleFavorite("default", ids.favorite);
  await store.updateMetadata("default", ids.rated, { rating: 3 });
  await store.createGroup({ projectId: "default", name: "Reviewed" });
  await store.updateMetadata("default", ids.grouped, { group: "Reviewed" });
  await store.updateMetadata("default", ids.userTag, { tags: ["mytag"] });
  await store.createAssetStack("default", [manualA, manualB]);
  await store.updateCuration("default", ids.curated, { curated: true });
  await store.updateCuration("default", ids.curationNote, { note: "构图很好" });
  await store.updateMetadata("default", ids.userEdited, { source: { user_edited_at: "2026-10-28T08:00:00.000Z" } });
  await store.updateMetadata("default", ids.promptEdited, { source: { prompt_user_edited_at: "2026-10-28T08:00:00.000Z" } });

  assert.deepEqual(await unorganizedIds(store), [plain].sort());
  const stats = await store.listNavigationStats("default");
  assert.equal(stats.unorganized, 1);
});

test("automatic stack members stay unorganized and show as one card; manual stack members do not", async (t) => {
  const { store, libraryDir, sourcePath } = await makeStore(t);
  const autoA = await ingestJimengImage(store, libraryDir, "7700970082708589001", "rec-session-1");
  const autoB = await ingestJimengImage(store, libraryDir, "7700970082708589002", "rec-session-1");
  const manualA = await plainAsset(store, sourcePath, "manual-a");
  const manualB = await plainAsset(store, sourcePath, "manual-b");
  const stack = await store.createAssetStack("default", [manualA.id, manualB.id]);
  assert.equal(stack.origin, "manual");
  assert.deepEqual(await unorganizedIds(store), [autoA.id, autoB.id].sort(), "the manual stack is organized, the automatic one is not");
  const gallery = await store.listAssetPage({ projectId: "default", unorganized: true, collapseStacks: true, limit: 0 });
  assert.equal(gallery.assets.length, 1, "the automatic stack shows as one card in Unorganized");
  assert.deepEqual(gallery.assets[0].stack.count, 2);
});

test("system tags follow the capture pipeline, not the tag text", async (t) => {
  const { store, libraryDir, sourcePath } = await makeStore(t);
  // 网页图只带自己的系统标签 → 整理过不算。
  const captured = await ingestJimengImage(store, libraryDir, "7700970082708589101");
  // 同一张图加了别家的标签 chatgpt → 用户标签，算整理过。
  const taggedChatgpt = await ingestJimengImage(store, libraryDir, "7700970082708589102");
  await store.updateMetadata("default", taggedChatgpt.id, { tags: ["jimeng", "web-capture", "auto-archived", "chatgpt"] });
  // 图片上的 video 标签不是系统标签，算整理过。
  const imageWithVideoTag = await ingestJimengImage(store, libraryDir, "7700970082708589103");
  await store.updateMetadata("default", imageWithVideoTag.id, { tags: ["jimeng", "web-capture", "auto-archived", "video"] });
  // 网页视频的 video 是系统标签，只有系统标签 → 不算。
  const video = await ingestJimengVideo(store, libraryDir, "7700970082708589104");
  // Codex 生成图：带自己的 codex 标签（来源名）→ 不算。
  const codex = await plainAsset(store, sourcePath, "codex-only", { source: { type: "codex-generated" }, tags: ["codex", "auto-archived"] });
  // Grok 图片：image 是这张图自己的媒体类型标签 → 不算。
  const grok = await plainAsset(store, sourcePath, "grok-only", { source: { type: "grok-generated" }, tags: ["grok", "auto-archived", "image"] });
  // 大小写不同照样认：JIMENG / Web-Capture 都是系统标签。
  const mixedCase = await ingestJimengImage(store, libraryDir, "7700970082708589105");
  await store.updateMetadata("default", mixedCase.id, { tags: ["JIMENG", "Web-Capture", "AUTO-Archived"] });

  // 先确认系统标签真的写进了库，下面的判断才不是空转。
  assert.deepEqual((await store.getAsset("default", codex.id)).tags.sort(), ["auto-archived", "codex"]);
  assert.ok((await store.getAsset("default", grok.id)).tags.includes("image"));
  const unorganized = await unorganizedIds(store);
  assert.ok(unorganized.includes(captured.id), "a plain web capture is unorganized");
  assert.ok(!unorganized.includes(taggedChatgpt.id), "a provider name other than the asset's own is a user tag");
  assert.ok(!unorganized.includes(imageWithVideoTag.id), "a video tag on an image is a user tag");
  assert.ok(unorganized.includes(video.id), "the video tag on a video is a system tag");
  assert.ok(unorganized.includes(codex.id), "the codex source name is a system tag");
  assert.ok(unorganized.includes(grok.id), "an image tag on an image is a system tag");
  assert.ok(unorganized.includes(mixedCase.id), "tag matching ignores case");
});

test("archived assets are not in Unorganized", async (t) => {
  const { store, sourcePath } = await makeStore(t);
  const archived = await plainAsset(store, sourcePath, "archived");
  await store.archiveAsset("default", archived.id);
  assert.deepEqual(await unorganizedIds(store), []);
});

test("setAssetsCurated leaves Unorganized, keeps the note, and reports the prior state", async (t) => {
  const { store, sourcePath } = await makeStore(t);
  const first = await plainAsset(store, sourcePath, "first");
  const second = await plainAsset(store, sourcePath, "second");
  const withNote = await plainAsset(store, sourcePath, "with-note");
  await store.updateCuration("default", withNote.id, { note: "保留的备注" });
  assert.deepEqual(await unorganizedIds(store), [first.id, second.id].sort());

  const marked = await store.setAssetsCurated("default", [first.id, second.id, withNote.id], true);
  assert.equal(marked.partial, false);
  const byId = Object.fromEntries(marked.results.map((entry) => [entry.id, entry]));
  assert.deepEqual(byId[first.id], { id: first.id, curated: true, previous_curated: false, was_organized: false });
  assert.deepEqual(byId[withNote.id], { id: withNote.id, curated: true, previous_curated: false, was_organized: true });
  assert.deepEqual(await unorganizedIds(store), []);
  assert.equal((await store.listNavigationStats("default")).unorganized, 0);
  const kept = await store.getAsset("default", withNote.id);
  assert.equal(kept.curation_note, "保留的备注");

  // 撤销：设回假后回到待整理，备注仍在。
  const undone = await store.setAssetsCurated("default", [first.id], false);
  assert.equal(undone.results[0].previous_curated, true);
  assert.deepEqual(await unorganizedIds(store), [first.id]);
  assert.equal((await store.listNavigationStats("default")).unorganized, 1);
  assert.equal((await store.setAssetsCurated("default", [withNote.id], false)).results[0].curated, false);
  // 备注本身也算整理过，取消「标为已整理」不会让它回到待整理。
  assert.deepEqual(await unorganizedIds(store), [first.id]);
  const noteAfterUndo = await store.getAsset("default", withNote.id);
  assert.equal(noteAfterUndo.curation_note, "保留的备注");
});

test("Unorganized and provider deletion sync agree on the same items", async (t) => {
  const { store, libraryDir, sourcePath } = await makeStore(t);
  const captures = {
    plain: await ingestJimengImage(store, libraryDir, "7700970082708589201"),
    favorite: await ingestJimengImage(store, libraryDir, "7700970082708589202"),
    providerTag: await ingestJimengImage(store, libraryDir, "7700970082708589203"),
    curated: await ingestJimengImage(store, libraryDir, "7700970082708589204"),
    autoStackA: await ingestJimengImage(store, libraryDir, "7700970082708589205", "rec-session-2"),
    autoStackB: await ingestJimengImage(store, libraryDir, "7700970082708589206", "rec-session-2"),
  };
  await store.toggleFavorite("default", captures.favorite.id);
  await store.updateMetadata("default", captures.providerTag.id, { tags: ["jimeng", "web-capture", "auto-archived", "chatgpt"] });
  await store.setAssetsCurated("default", [captures.curated.id], true);

  const unorganized = new Set(await unorganizedIds(store));
  for (const [itemId, capture] of Object.entries({
    "7700970082708589201": captures.plain,
    "7700970082708589202": captures.favorite,
    "7700970082708589203": captures.providerTag,
    "7700970082708589204": captures.curated,
    "7700970082708589205": captures.autoStackA,
    "7700970082708589206": captures.autoStackB,
  })) {
    const [match] = await store.findProviderDeletionMatches("default", "jimeng", itemId);
    assert.equal(match.organized, !unorganized.has(capture.id), `verdict for ${itemId}`);
  }
  // 自动堆叠成员：待整理认作没整理，删除同步也认作没整理（移进回收站）。
  const result = await applyProviderDeletions({ store, libraryDir }, {
    provider: "jimeng",
    items: [
      { recordId: "rec-session-2", itemId: "7700970082708589205" },
      { recordId: "rec-session-2", itemId: "7700970082708589206" },
    ],
  });
  assert.deepEqual(result, { trashed: 2, kept: 0, notFound: 0 });
});
