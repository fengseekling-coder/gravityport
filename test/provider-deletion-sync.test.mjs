// Task 258: provider-site deletion sync. When the user deletes a work on the
// provider site itself (Jimeng's /mweb/v1/remove_history for now), GravityPort
// moves the matching capture to its trash — unless the user organized it here
// (favorited, rated, grouped, or tagged). The extension part is exercised with
// the real request/response shapes captured from the live site (2026-10-26):
// the request body is a JSON string
// {"item_id_list_map":{"<recordId>":["<itemId>",…]}} and the success reply is
// {"ret":"0",…} over HTTP 200. Values below are synthetic but byte-shaped.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import Database from "better-sqlite3";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture, createWebCaptureIngest } from "../lib/web-capture-ingest.js";
import {
  applyProviderDeletions,
  normalizeProviderDeletionItems,
  readProviderDeletionSettings,
  writeProviderDeletionSettings,
} from "../lib/provider-deletion-sync.mjs";
import { handleBridgeRoute, isWebCaptureApiPath } from "../lib/api/bridge-routes.mjs";

const extensionRoot = new URL("../extensions/chatgpt-web-capture/", import.meta.url);
const backgroundSource = await readFile(new URL("background.js", extensionRoot), "utf8");
const providerPolicySource = await readFile(new URL("provider-policy.js", extensionRoot), "utf8");
const jimengHookSource = await readFile(new URL("jimeng-page-hook.js", extensionRoot), "utf8");
const providerJimengSource = await readFile(new URL("provider-jimeng.js", extensionRoot), "utf8");

// The live sample the user produced by deleting two works on the Jimeng
// "资产" page (request body verbatim; reply verbatim).
const REMOVE_HISTORY_BODY = '{"item_id_list_map":{"45764385435404":["7689895316266716440"]}}';
const REMOVE_HISTORY_SUCCESS = '{"ret":"0","errmsg":"success","systime":"1793026609","logid":"2026102622564989F44EE69599345F6503"}';
const REMOVE_HISTORY_URL = "https://jimeng.jianying.com/mweb/v1/remove_history?aid=513084&web_version=7.6.4&da_version=3.0.0&aigc_features=FEATQ1";

// High-entropy raster so compressed size exceeds the logo gate (~20KiB); a
// seed per asset keeps content hashes distinct so captures never dedupe.
async function jpegBase64(seed) {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + seed * 17 + (i % 251)) & 255;
  const buf = await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
  return buf.toString("base64");
}

async function makeLibrary() {
  const root = await mkdtemp(join(tmpdir(), "mosa-provider-delete-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  return { root, libraryDir, store };
}

let nextImageSeed = 1;
async function ingestJimengCapture(store, projectId, { itemId, recordId, imageBase64, captureMode } = {}) {
  // Default to a session per item id: two captures sharing a conversation are
  // auto-stacked at ingest (task 249), which the stacking cases below build
  // explicitly instead.
  const cleanRecordId = recordId ?? `rec-${itemId}`;
  const base64 = imageBase64 ?? await jpegBase64(nextImageSeed);
  if (imageBase64 == null) nextImageSeed += 1;
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(store.libraryDir, ".web-capture-tmp"),
    projectId,
    input: {
      provider: "jimeng",
      mediaKind: "image",
      imageBase64: base64,
      mimeType: "image/jpeg",
      providerAssetId: itemId,
      conversationId: cleanRecordId,
      generationContextId: cleanRecordId,
      pageUrl: "https://jimeng.jianying.com/ai-tool/asset",
      captureMode,
    },
  });
  assert.equal(imported.status, "imported");
  return imported.asset;
}

// Minimal ftyp-headered MP4 (sampleMp4Bytes pattern in
// web-capture-same-id-upgrade.test.mjs) so the real store accepts a video.
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

async function ingestJimengVideo(store, projectId, itemId) {
  const imported = await ingestWebCapture({
    store,
    tempRoot: join(store.libraryDir, ".web-capture-tmp"),
    projectId,
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

async function assetInTrash(store, projectId, assetId) {
  const asset = await store.getAsset(projectId, assetId);
  return Boolean(asset.deleted_at);
}

// ---------------------------------------------------------------- sync core

test("an unorganized jimeng capture moves to the trash and can be restored", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
    // 移进回收站带原因（280 的原因码，281 开始写入）。
    const trashed = await store.getAsset("default", asset.id);
    assert.equal(trashed.trash_reason?.code, "provider-deleted:jimeng");
    assert.ok(String(trashed.trash_reason?.at || "").trim());
    // Recoverable, not a permanent delete; restoring clears the reason.
    await store.restoreAsset("default", asset.id);
    assert.equal(await assetInTrash(store, "default", asset.id), false);
    const restored = await store.getAsset("default", asset.id);
    assert.equal(restored.trash_reason, undefined);
  } finally {
    store.close?.();
  }
});

test("favorited, rated, grouped and tagged captures are kept", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const favorited = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    await store.updateMetadata("default", favorited.id, { favorite: true });
    const rated = await ingestJimengCapture(store, "default", { itemId: "7700970082708589850" });
    await store.updateMetadata("default", rated.id, { rating: 4 });
    const grouped = await ingestJimengCapture(store, "default", { itemId: "7700970082708589851" });
    await store.updateMetadata("default", grouped.id, { group: "好图" });
    const tagged = await ingestJimengCapture(store, "default", { itemId: "7700970082708589852" });
    await store.updateMetadata("default", tagged.id, { tags: ["风景"] });

    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [
        { recordId: "49017522166284", itemId: "7700970082708589849" },
        { recordId: "49017522166284", itemId: "7700970082708589850" },
        { recordId: "49017522166284", itemId: "7700970082708589851" },
        { recordId: "49017522166284", itemId: "7700970082708589852" },
      ],
    });
    assert.deepEqual(result, { trashed: 0, kept: 4, notFound: 0 });
    for (const asset of [favorited, rated, grouped, tagged]) {
      assert.equal(await assetInTrash(store, "default", asset.id), false);
    }
  } finally {
    store.close?.();
  }
});

test("every organized kind the 2026-10-28 ruling adds is kept", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const ingested = {};
    const cases = {
      manualStack: "7700970082708589801",
      curated: "7700970082708589802",
      curationNote: "7700970082708589803",
      archived: "7700970082708589804",
      userEditedAt: "7700970082708589805",
      promptUserEditedAt: "7700970082708589806",
    };
    for (const [name, itemId] of Object.entries(cases)) {
      ingested[name] = await ingestJimengCapture(store, "default", { itemId });
    }
    // 手动堆叠成员：createAssetStack 建的栈 origin 默认 'manual'（迁移 4194）。
    const stackHelper = await ingestJimengCapture(store, "default", { itemId: "7700970082708589807" });
    const manualStackSummary = await store.createAssetStack("default", [ingested.manualStack.id, stackHelper.id]);
    assert.equal(manualStackSummary.origin, "manual");
    await store.updateCuration("default", ingested.curated.id, { curated: true });
    await store.updateCuration("default", ingested.curationNote.id, { note: "构图很好" });
    await store.archiveAsset("default", ingested.archived.id);
    await store.updateMetadata("default", ingested.userEditedAt.id, { source: { user_edited_at: "2026-10-28T08:00:00.000Z" } });
    await store.updateMetadata("default", ingested.promptUserEditedAt.id, { source: { prompt_user_edited_at: "2026-10-28T08:00:00.000Z" } });

    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: Object.values(cases).map((itemId) => ({ recordId: "49017522166284", itemId })),
    });
    assert.deepEqual(result, { trashed: 0, kept: 6, notFound: 0 });
    for (const asset of Object.values(ingested)) {
      assert.equal(await assetInTrash(store, "default", asset.id), false);
    }
    // 收录方式、category、只改备注（未知元数据）都不在保护范围内，单独验。
    const categorized = await ingestJimengCapture(store, "default", { itemId: "7700970082708589810" });
    await store.updateMetadata("default", categorized.id, { category: "人物" });
    const noteOnly = await ingestJimengCapture(store, "default", { itemId: "7700970082708589811" });
    await store.updateMetadata("default", noteOnly.id, { note: "随手记" });
    const manualCapture = await ingestJimengCapture(store, "default", { itemId: "7700970082708589812", captureMode: "manual" });
    // 自动堆叠成员：同一会话的第二张入库即堆（任务 249），origin 不是 manual。
    const autoStack = await ingestJimengCapture(store, "default", { itemId: "7700970082708589808", recordId: "49017522166284" });
    const autoStackSibling = await ingestJimengCapture(store, "default", { itemId: "7700970082708589809", recordId: "49017522166284" });
    assert.notEqual(autoStack.id, autoStackSibling.id);
    const autoPage = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
    let autoStackSummary = null;
    for (const entry of autoPage.assets.filter((node) => node.stack)) {
      const summary = await store.getAssetStack("default", entry.stack.id);
      const members = await store.listAssetStackAssets("default", entry.stack.id);
      if (members.assets.some((member) => member.id === autoStack.id)) autoStackSummary = summary;
    }
    assert.ok(autoStackSummary, "the same-session pair is auto-stacked at ingest");
    assert.equal(autoStackSummary.origin, "auto");
    const negative = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [
        { recordId: "49017522166284", itemId: "7700970082708589808" },
        { recordId: "49017522166284", itemId: "7700970082708589810" },
        { recordId: "49017522166284", itemId: "7700970082708589811" },
        { recordId: "49017522166284", itemId: "7700970082708589812" },
      ],
    });
    assert.deepEqual(negative, { trashed: 4, kept: 0, notFound: 0 });
    for (const asset of [autoStack, categorized, noteOnly, manualCapture]) {
      assert.equal(await assetInTrash(store, "default", asset.id), true);
      // 自动堆叠成员进回收站也带原因。
      const row = await store.getAsset("default", asset.id);
      assert.equal(row.trash_reason?.code, "provider-deleted:jimeng");
    }
  } finally {
    store.close?.();
  }
});

test("a duplicate and its original are both kept for the same item id", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const original = await ingestJimengCapture(store, "default", { itemId: "7700970082708589821" });
    const duplicate = await store.duplicateAsset("default", original.id);
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589821" }],
    });
    // 副本不再带编号，组里只有本体；本体靠「有派生引用」保住。
    assert.deepEqual(result, { trashed: 0, kept: 1, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", original.id), false);
    assert.equal(await assetInTrash(store, "default", duplicate.id), false);
  } finally {
    store.close?.();
  }
});

test("a version and its original are both kept, including the legacy both-match shape", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    // 新式版本：不带编号，本体靠子版本关系保住。
    const original = await ingestJimengCapture(store, "default", { itemId: "7700970082708589831" });
    const version = await store.createAssetVersion("default", original.id, {
      version_change: "只改提示词",
      prompt: "新提示词",
    });
    const fresh = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589831" }],
    });
    assert.deepEqual(fresh, { trashed: 0, kept: 1, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", original.id), false);
    assert.equal(await assetInTrash(store, "default", version.id), false);

    // 263 的绕过场景（旧数据：版本和本体都带编号，版本更新、排前面）。
    const legacyOriginal = await ingestJimengCapture(store, "default", { itemId: "7700970082708589832" });
    const legacyVersion = await store.createAssetVersion("default", legacyOriginal.id, {
      version_change: "只改提示词",
      prompt: "另一版提示词",
    });
    const rawDb = new Database(join(libraryDir, "mosa.db"));
    try {
      rawDb.prepare(`
        UPDATE assets SET provider_asset_id = ?,
          source_json = json_set(source_json, '$.provider_asset_id', ?)
        WHERE project_id = ? AND id = ?
      `).run("7700970082708589832", "7700970082708589832", "default", legacyVersion.id);
    } finally {
      rawDb.close();
    }
    const legacy = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589832" }],
    });
    assert.deepEqual(legacy, { trashed: 0, kept: 2, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", legacyOriginal.id), false);
    assert.equal(await assetInTrash(store, "default", legacyVersion.id), false);
  } finally {
    store.close?.();
  }
});

test("same bytes recaptured under another item id keep the asset when either id is deleted", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    // 走 280 的真路径：同字节第二个编号并入 merged_provider_asset_ids。
    const bytes = await jpegBase64(nextImageSeed);
    nextImageSeed += 1;
    const first = await ingestJimengCapture(store, "default", { itemId: "7700970082708589841", imageBase64: bytes });
    const second = await ingestWebCapture({
      store,
      tempRoot: join(store.libraryDir, ".web-capture-tmp"),
      projectId: "default",
      input: {
        provider: "jimeng",
        mediaKind: "image",
        imageBase64: bytes,
        mimeType: "image/jpeg",
        providerAssetId: "7700970082708589842",
        conversationId: "rec-7700970082708589842",
        generationContextId: "rec-7700970082708589842",
        pageUrl: "https://jimeng.jianying.com/ai-tool/asset",
      },
    });
    assert.equal(second.status, "skipped");
    assert.equal(second.asset.id, first.id);
    const merged = await store.getAsset("default", first.id);
    assert.deepEqual(merged.source.merged_provider_asset_ids, ["7700970082708589842"]);
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589841" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 1, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", first.id), false);
  } finally {
    store.close?.();
  }
});

test("system tags follow the capture pipeline per asset, not the tag name", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    // 图片上的 "video" 和即梦素材上的 "chatgpt" 都是用户标签 → 保留。
    const imageTaggedVideo = await ingestJimengCapture(store, "default", { itemId: "7700970082708589851" });
    await store.updateMetadata("default", imageTaggedVideo.id, { tags: ["video"] });
    const taggedChatgpt = await ingestJimengCapture(store, "default", { itemId: "7700970082708589852" });
    await store.updateMetadata("default", taggedChatgpt.id, { tags: ["chatgpt"] });
    // 视频素材的 "video" 是系统标签（media_kind = video），只有系统标签 → 移走。
    const video = await ingestJimengVideo(store, "default", "7700970082708589853");
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [
        { recordId: "49017522166284", itemId: "7700970082708589851" },
        { recordId: "49017522166284", itemId: "7700970082708589852" },
        { recordId: "49017522166284", itemId: "7700970082708589853" },
      ],
    });
    assert.deepEqual(result, { trashed: 1, kept: 2, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", imageTaggedVideo.id), false);
    assert.equal(await assetInTrash(store, "default", taggedChatgpt.id), false);
    assert.equal(await assetInTrash(store, "default", video.id), true);
  } finally {
    store.close?.();
  }
});

test("new duplicates and versions record the provider item id as provenance only", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const original = await ingestJimengCapture(store, "default", { itemId: "7700970082708589871" });
    const duplicate = await store.duplicateAsset("default", original.id);
    const version = await store.createAssetVersion("default", original.id, {
      version_change: "微调提示词",
      prompt: "微调后的提示词",
    });
    const rawDb = new Database(join(libraryDir, "mosa.db"));
    try {
      for (const derived of [duplicate, version]) {
        const row = rawDb.prepare("SELECT provider_asset_id, logical_output_id, source_json FROM assets WHERE project_id = ? AND id = ?")
          .get("default", derived.id);
        assert.equal(row.provider_asset_id, "");
        assert.equal(row.logical_output_id, "");
        const source = JSON.parse(row.source_json);
        assert.equal(source.provider_asset_id, undefined);
        assert.equal(source.logical_output_id, undefined);
        assert.equal(source.derived_from_provider_asset_id, "7700970082708589871");
      }
      assert.equal(duplicate.source.duplicated_from, original.id);
      assert.equal(version.parent_asset_id, original.id);
    } finally {
      rawDb.close();
    }
  } finally {
    store.close?.();
  }
});

test("unknown item ids count as notFound and leave the library untouched", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const before = await store.listAssets({ projectId: "default" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "1234567890" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
    assert.equal(await assetInTrash(store, "default", asset.id), false);
    assert.equal((await store.listAssets({ projectId: "default" })).length, before.length);
  } finally {
    store.close?.();
  }
});

test("the same item id under another provider is not touched", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const chatgptResult = await ingestWebCapture({
      store,
      tempRoot: join(store.libraryDir, ".web-capture-tmp"),
      projectId: "default",
      input: {
        provider: "chatgpt",
        mediaKind: "image",
        imageBase64: await jpegBase64(nextImageSeed++),
        mimeType: "image/jpeg",
        providerAssetId: "7700970082708589849",
        pageUrl: "https://chatgpt.com/c/conv",
      },
    });
    assert.equal(chatgptResult.status, "imported");
    const chatgptAsset = chatgptResult.asset;
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
    assert.equal(await assetInTrash(store, "default", chatgptAsset.id), false);
  } finally {
    store.close?.();
  }
});

test("the disabled switch leaves everything alone and reports disabled", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await writeProviderDeletionSettings(libraryDir, { jimengDeleteSyncEnabled: false });
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }, { recordId: "r", itemId: "42" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 2, disabled: true });
    assert.equal(await assetInTrash(store, "default", asset.id), false);
  } finally {
    store.close?.();
  }
});

test("captures in a second project are found and trashed", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await store.ensureProject("second");
    const asset = await ingestJimengCapture(store, "second", { itemId: "7700970082708589855" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589855" }],
    });
    assert.deepEqual(result, { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "second", asset.id), true);
  } finally {
    store.close?.();
  }
});

test("an already trashed capture is skipped without counting and without errors", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });
    await store.deleteAsset("default", asset.id);
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
  } finally {
    store.close?.();
  }
});

test("malformed item ids are dropped, duplicates collapse, and the batch caps at 200", async () => {
  assert.deepEqual(
    normalizeProviderDeletionItems([
      { recordId: "r1", itemId: "not-a-number" },
      { recordId: "r2", itemId: "1".repeat(33) },
      { recordId: "r3", itemId: "42" },
      { recordId: "r4", itemId: 43 },
      { recordId: "r5", itemId: "42" },
      null,
      "42",
    ]),
    [{ recordId: "r3", itemId: "42" }, { recordId: "r4", itemId: "43" }],
  );
  const longBatch = Array.from({ length: 201 }, (_, index) => ({ recordId: "r", itemId: String(9_000_000_000_000_000_000n + BigInt(index)) }));
  assert.equal(normalizeProviderDeletionItems(longBatch).length, 200);
  // The store path sees the same rules: only the 200 valid ids are looked up.
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "r", itemId: "abc" }, { recordId: "r", itemId: "1".repeat(33) }, { recordId: "r", itemId: "777" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1 });
  } finally {
    store.close?.();
  }
});

test("unsupported providers and non-object payloads are rejected", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await assert.rejects(
      () => applyProviderDeletions({ store, libraryDir }, { provider: "flow", items: [{ itemId: "42" }] }),
      (error) => error.code === "WEB_CAPTURE_PROVIDER_DELETION_INVALID",
    );
    await assert.rejects(
      () => applyProviderDeletions({ store, libraryDir }, {}),
      (error) => error.code === "WEB_CAPTURE_PROVIDER_DELETION_INVALID",
    );
  } finally {
    store.close?.();
  }
});

test("the settings file defaults to enabled and persists explicit changes", async () => {
  const { libraryDir } = await makeLibrary();
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: true });
  assert.deepEqual(
    await writeProviderDeletionSettings(libraryDir, { jimengDeleteSyncEnabled: false }),
    { jimengDeleteSyncEnabled: false },
  );
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: false });
  await rm(join(libraryDir, ".provider-deletion-sync.json"), { force: true });
  assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: true });
});

test("a settings file that exists but does not parse means off, warned once", async () => {
  const { libraryDir, store } = await makeLibrary();
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await writeFile(join(libraryDir, ".provider-deletion-sync.json"), "{bad json", "utf8");
    // 本文件里第一次坏文件读取 → 告警一次，按「关」。
    assert.deepEqual(await readProviderDeletionSettings(libraryDir), { jimengDeleteSyncEnabled: false });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /provider-deletion-sync\.json/);

    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589861" });
    const result = await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589861" }],
    });
    assert.deepEqual(result, { trashed: 0, kept: 0, notFound: 1, disabled: true });
    assert.equal(await assetInTrash(store, "default", asset.id), false);
    // 同进程内的后续读取不再重复告警。
    await applyProviderDeletions({ store, libraryDir }, {
      provider: "jimeng",
      items: [{ recordId: "49017522166284", itemId: "7700970082708589862" }],
    });
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    store.close?.();
  }
});

// -------------------------------------------------------------------- route

function fakeReq(body, token) {
  return {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    on(type, handler) {
      if (type === "data") handler(Buffer.from(body));
      if (type === "end") queueMicrotask(() => handler());
    },
    resume() {},
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key] = value; },
    end(payload) { this.body = String(payload ?? ""); },
  };
}

async function postBridge({ store, libraryDir }, pathname, body, token) {
  // The server-side capture token stays fixed; only the request's bearer
  // token varies, so a wrong header is really rejected.
  const capture = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "right-token",
    allowedOrigins: ["chrome-extension://test"],
  });
  const res = fakeRes();
  const handled = await handleBridgeRoute({
    req: fakeReq(JSON.stringify(body), token),
    res,
    url: new URL(`http://127.0.0.1:43110${pathname}`),
    context: {
      libraryDir,
      store,
      webCaptureIngest: capture,
      cowartBridge: { status: () => ({}) },
      cowartCanvasDiscovery: { status: () => ({}) },
      codexBridge: { status: () => ({}) },
      grokBridge: { status: () => ({}) },
    },
  });
  return { handled, res };
}

test("route policy: the deletions ingest shares the web capture origin policy, the settings route stays client-gated", () => {
  assert.equal(isWebCaptureApiPath("/api/ingest/web-capture-provider-deletions"), true);
  assert.equal(isWebCaptureApiPath("/api/web-capture/provider-deletion-settings"), false);
});

test("the deletions route rejects a wrong bearer token", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    await assert.rejects(
      () => postBridge({ store, libraryDir }, "/api/ingest/web-capture-provider-deletions", { provider: "jimeng", items: [] }, "wrong-token"),
      (error) => error.statusCode === 401,
    );
  } finally {
    store.close?.();
  }
});

test("the deletions route trashes through the real store and the settings route round-trips", async () => {
  const { libraryDir, store } = await makeLibrary();
  try {
    await store.ensureProject("default");
    const asset = await ingestJimengCapture(store, "default", { itemId: "7700970082708589849" });

    const read = await postBridge({ store, libraryDir }, "/api/web-capture/provider-deletion-settings", {}, "right-token");
    assert.equal(read.res.statusCode, 200);
    assert.deepEqual(JSON.parse(read.res.body), { jimengDeleteSyncEnabled: true });

    const write = await postBridge(
      { store, libraryDir },
      "/api/web-capture/provider-deletion-settings",
      { jimengDeleteSyncEnabled: false },
      "right-token",
    );
    assert.equal(write.res.statusCode, 200);
    assert.deepEqual(JSON.parse(write.res.body), { jimengDeleteSyncEnabled: false });

    const result = await postBridge(
      { store, libraryDir },
      "/api/ingest/web-capture-provider-deletions",
      { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }] },
      "right-token",
    );
    assert.equal(result.res.statusCode, 200);
    assert.deepEqual(JSON.parse(result.res.body), { trashed: 0, kept: 0, notFound: 1, disabled: true });
    assert.equal(await assetInTrash(store, "default", asset.id), false);

    await postBridge({ store, libraryDir }, "/api/web-capture/provider-deletion-settings", { jimengDeleteSyncEnabled: true }, "right-token");
    const second = await postBridge(
      { store, libraryDir },
      "/api/ingest/web-capture-provider-deletions",
      { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7700970082708589849" }] },
      "right-token",
    );
    assert.deepEqual(JSON.parse(second.res.body), { trashed: 1, kept: 0, notFound: 0 });
    assert.equal(await assetInTrash(store, "default", asset.id), true);
  } finally {
    store.close?.();
  }
});

// ---------------------------------------------------------------- extension

function createHookSandbox({ fetchImpl } = {}) {
  const portMessages = [];
  const hookMessages = [];
  class FakeXHR {
    constructor() {
      this.listeners = {};
      this.responseType = "";
      this.status = 0;
      this.responseText = "";
      this.response = null;
    }

    open(_method, url) { this.__url = url; }

    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }

    send(body) { this.__body = body; }

    respond({ status, text, jsonResponse }) {
      this.status = status;
      if (jsonResponse !== undefined) {
        this.responseType = "json";
        this.response = jsonResponse;
      } else {
        this.responseText = text;
      }
      for (const handler of this.listeners.load || []) handler();
    }
  }
  const sandbox = {
    URL,
    location: { origin: "https://jimeng.jianying.com", href: "https://jimeng.jianying.com/ai-tool/asset" },
    XMLHttpRequest: FakeXHR,
    MessageChannel: function FakeChannel() {
      this.port1 = {
        postMessage: (message) => portMessages.push(message),
        addEventListener: () => {},
        start: () => {},
      };
      this.port2 = {};
    },
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.postMessage = (message, origin, transfer) => { hookMessages.push({ message, origin, transfer }); };
  vm.runInNewContext(jimengHookSource, sandbox, { filename: "jimeng-page-hook.js" });
  return { sandbox, FakeXHR, portMessages, hookMessages };
}

const deletionReports = (portMessages) => portMessages.filter((message) => message.type === "jimeng-deletion-observed");
// The hook runs in a vm sandbox, so its message objects live in another realm;
// JSON round-trips them into the test realm before deepStrictEqual.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("a confirmed remove_history XHR forwards the deleted item ids", () => {
  const { sandbox, FakeXHR, portMessages } = createHookSandbox();

  const xhr = new sandbox.XMLHttpRequest();
  xhr.open("POST", REMOVE_HISTORY_URL);
  xhr.send(REMOVE_HISTORY_BODY);
  xhr.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const reports = deletionReports(portMessages);
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0]), {
    type: "jimeng-deletion-observed",
    success: true,
    items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }],
  });

  // The general structure: several records, several items per record, numeric
  // ids accepted, junk dropped.
  const multi = new sandbox.XMLHttpRequest();
  multi.open("POST", "https://jimeng.jianying.com/mweb/v1/remove_history");
  multi.send(JSON.stringify({
    item_id_list_map: {
      "45764385435404": ["7689895316266716440", "7689895316266716441"],
      "45764385435405": [12345, "bad", null],
    },
  }));
  multi.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });
  const multiReports = deletionReports(portMessages);
  assert.equal(multiReports.length, 2);
  assert.deepEqual(plain(multiReports[1].items), [
    { recordId: "45764385435404", itemId: "7689895316266716440" },
    { recordId: "45764385435404", itemId: "7689895316266716441" },
    { recordId: "45764385435405", itemId: "12345" },
  ]);
  assert.equal(FakeXHR.prototype.open.name, "mosaHookedOpen", "the hook wraps, not replaces, the site's XHR");
});

test("non-zero ret, non-200 status, empty bodies and other endpoints never forward deletions; query params never appear", async () => {
  const seenFetches = [];
  const { sandbox, portMessages } = createHookSandbox({
    fetchImpl: (url, init) => {
      seenFetches.push({ url: String(url), init });
      return Promise.resolve(new Response(REMOVE_HISTORY_SUCCESS, { status: 200 }));
    },
  });

  const failure = new sandbox.XMLHttpRequest();
  failure.open("POST", REMOVE_HISTORY_URL);
  failure.send(REMOVE_HISTORY_BODY);
  failure.respond({ status: 200, text: '{"ret":"1","errmsg":"failed","logid":"x"}' });

  const httpError = new sandbox.XMLHttpRequest();
  httpError.open("POST", REMOVE_HISTORY_URL);
  httpError.send(REMOVE_HISTORY_BODY);
  httpError.respond({ status: 500, text: REMOVE_HISTORY_SUCCESS });

  const malformed = new sandbox.XMLHttpRequest();
  malformed.open("POST", REMOVE_HISTORY_URL);
  malformed.send("not json at all");
  malformed.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const wrongBody = new sandbox.XMLHttpRequest();
  wrongBody.open("POST", REMOVE_HISTORY_URL);
  wrongBody.send('{"other_map":{"1":["2"]}}');
  wrongBody.respond({ status: 200, text: REMOVE_HISTORY_SUCCESS });

  const otherEndpoint = new sandbox.XMLHttpRequest();
  otherEndpoint.open("POST", "https://jimeng.jianying.com/mweb/v1/get_asset_list?aid=513084");
  otherEndpoint.send("{}");
  otherEndpoint.respond({ status: 200, text: '{"ret":"0","data":{}}' });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletionReports(portMessages).length, 0, "nothing may be forwarded for the failure cases");

  // The fetch path observes the same endpoint the same way when the site
  // switches transport.
  await sandbox.window.fetch(REMOVE_HISTORY_URL, { method: "POST", body: REMOVE_HISTORY_BODY });
  await new Promise((resolve) => setImmediate(resolve));
  const reports = deletionReports(portMessages);
  assert.equal(reports.length, 1);
  assert.deepEqual(plain(reports[0].items), [{ recordId: "45764385435404", itemId: "7689895316266716440" }]);

  // URL query parameters (aid / signatures / versions) never travel in the
  // deletion report.
  const reportText = JSON.stringify(reports);
  for (const fragment of ["513084", "7.6.4", "3.0.0", "FEATQ1", "aid=", "aigc_features"]) {
    assert.equal(reportText.includes(fragment), false, `deletion report must not contain ${fragment}`);
  }
});

test("background: reportProviderDeletions posts to the app with the token, caps at 200 and rejects non-jimeng senders", async () => {
  const RUNTIME_ID = "test-extension-id";
  const BASE_URL = "http://127.0.0.1:43517";
  const TOKEN = "test-pairing-token";
  const listeners = { message: [] };
  const localStore = new Map([["mosaBaseUrl", BASE_URL], ["mosaToken", TOKEN], ["autoCapture", true]]);
  const storageArea = (store) => ({
    get(query) {
      if (query === null || query === undefined) return Promise.resolve(Object.fromEntries(store));
      if (Array.isArray(query)) {
        const out = {};
        for (const key of query) if (store.has(key)) out[key] = store.get(key);
        return Promise.resolve(out);
      }
      if (typeof query === "object") {
        const out = {};
        for (const [key, value] of Object.entries(query)) out[key] = store.has(key) ? store.get(key) : value;
        return Promise.resolve(out);
      }
      const out = {};
      if (store.has(String(query))) out[String(query)] = store.get(String(query));
      return Promise.resolve(out);
    },
    set(patch) { for (const [key, value] of Object.entries(patch)) store.set(key, value); return Promise.resolve(); },
    remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key); return Promise.resolve(); },
  });
  const appRequests = [];
  const chrome = {
    runtime: {
      id: RUNTIME_ID,
      getManifest: () => ({ version: "0.15.42" }),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onStartup: { addListener() {} },
      onInstalled: { addListener() {} },
    },
    storage: {
      local: storageArea(localStore),
      session: storageArea(new Map()),
      sync: storageArea(new Map()),
      onChanged: { addListener() {} },
    },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    windows: { onRemoved: { addListener() {} }, create: async () => null },
    contextMenus: { removeAll: async () => {}, create() {}, onClicked: { addListener() {} } },
    action: { setBadgeText: async () => {}, onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    tabs: { sendMessage: async () => { throw new Error("no receiver"); } },
  };
  const fetchImpl = (url, init = {}) => {
    const parsed = new URL(String(url));
    const record = { url: String(url), method: String(init.method || "GET"), headers: init.headers || {}, body: typeof init.body === "string" ? init.body : null };
    if (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") {
      appRequests.push(record);
      if (parsed.pathname === "/api/health") return Promise.resolve(new Response(JSON.stringify({ product: "mosa" })));
      if (parsed.pathname === "/api/ingest/web-capture-status") return Promise.resolve(new Response(JSON.stringify({ retryRequestId: 0 })));
      return Promise.resolve(new Response(JSON.stringify({ trashed: 0, kept: 0, notFound: 0 })));
    }
    return Promise.reject(new Error(`connection refused: ${url}`));
  };
  const context = vm.createContext({
    chrome,
    fetch: fetchImpl,
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });
  new vm.Script(providerPolicySource, { filename: "provider-policy.js" }).runInContext(context);
  const workerSource = backgroundSource.replace(/^import\s+".\/provider-policy.js";\s*$/m, "");
  new vm.Script(workerSource, { filename: "background.js" }).runInContext(context);

  const dispatchMessage = (message, sender) => new Promise((resolve, reject) => {
    const listener = listeners.message[0];
    let settled = false;
    const sendResponse = (response) => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    const keepOpen = listener(message, sender, sendResponse);
    if (keepOpen !== true && !settled) {
      settled = true;
      resolve(null);
    }
    setTimeout(() => {
      if (!settled) reject(new Error("sendResponse was never called"));
    }, 5_000);
  });

  const jimengSender = { id: RUNTIME_ID, tab: { id: 11 }, url: "https://jimeng.jianying.com/ai-tool/asset", frameId: 0 };
  const response = await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: { provider: "jimeng", items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }] },
  }, jimengSender);
  assert.equal(response.ok, true);
  const deletionPost = appRequests.find((request) => request.url === `${BASE_URL}/api/ingest/web-capture-provider-deletions`);
  assert.ok(deletionPost, "the deletion report must reach the app's new ingest route");
  assert.equal(deletionPost.method, "POST");
  assert.equal(deletionPost.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(deletionPost.body), {
    provider: "jimeng",
    items: [{ recordId: "45764385435404", itemId: "7689895316266716440" }],
  });

  // Cap: a 205-item batch is truncated to 200 before it leaves the worker.
  appRequests.length = 0;
  await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: {
      provider: "jimeng",
      items: Array.from({ length: 205 }, (_, index) => ({ recordId: "r", itemId: String(9_000_000_000_000_000_000n + BigInt(index)) })),
    },
  }, jimengSender);
  const cappedPost = appRequests.find((request) => request.url === `${BASE_URL}/api/ingest/web-capture-provider-deletions`);
  assert.equal(JSON.parse(cappedPost.body).items.length, 200);

  // A ChatGPT tab may not report jimeng deletions (provider gating).
  const chatgptResponse = await dispatchMessage({
    type: "mosa.reportProviderDeletions",
    payload: { provider: "jimeng", items: [{ recordId: "r", itemId: "42" }] },
  }, { id: RUNTIME_ID, tab: { id: 12 }, url: "https://chatgpt.com/c/conv", frameId: 0 });
  assert.equal(chatgptResponse.ok, false);

  // The wiring lines stay pinned: content script forwards the hook message,
  // background gates it to jimeng pages.
  assert.match(providerJimengSource, /message\?\.type === "jimeng-deletion-observed"/);
  assert.match(backgroundSource, /message\.type === "mosa\.reportProviderDeletions"\) return context\.provider === "jimeng";/);
  assert.match(backgroundSource, /\/api\/ingest\/web-capture-provider-deletions/);
});
