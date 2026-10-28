// Same-provider-id media replacement must only ever upgrade (task 280, user
// rule 2026-10-28): a preview or an equal/smaller re-encode never overwrites
// archived pixels, the replaced media moves to an independent Trash snapshot,
// prompts survive empty arrivals, and copies/versions never answer the
// identity lookup. The real sqlite store and the real ingest module run
// against a temporary library (web-capture-ingest.test.mjs pattern).
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";

async function noiseImage(width, height, seed, format = "png") {
  const raw = Buffer.alloc(width * height * 3);
  randomBytes(raw.length).copy(raw);
  raw[0] = seed & 255;
  const encoder = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === "webp") return encoder.webp({ lossless: true }).toBuffer();
  if (format === "jpeg") return encoder.jpeg({ quality: 80 }).toBuffer();
  return encoder.png().toBuffer();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// Minimal ftyp-headered MP4 container, large enough for the 64 KiB floor
// (sampleMp4Bytes pattern in web-capture-ingest.test.mjs).
function sampleMp4Bytes(seedByte = 7) {
  const bytes = Buffer.alloc(96 * 1024, seedByte);
  bytes.writeUInt32BE(24, 0);
  bytes.write("ftyp", 4, "ascii");
  bytes.write("isom", 8, "ascii");
  bytes.writeUInt32BE(0x200, 12);
  bytes.write("isom", 16, "ascii");
  bytes.write("mp42", 20, "ascii");
  return bytes;
}

async function createTestStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  const tempRoot = join(libraryDir, ".web-capture-tmp");
  return { store, tempRoot };
}

async function captureImage(store, tempRoot, input) {
  return ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "chatgpt", mimeType: "image/png", generationStatus: "completed", ...input },
  });
}

test("a preview arrival for the same id never overwrites the archived original", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-preview-");
  const providerAssetId = "file-upgrade-preview-vs-original";
  const originalBytes = await noiseImage(2048, 2048, 5, "jpeg");
  const first = await captureImage(store, tempRoot, {
    imageBase64: originalBytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "a lighthouse over calm water",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  assert.equal(first.status, "imported");

  const preview = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(640, 640, 9, "webp")).toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(preview.status, "skipped");
  assert.equal(preview.asset.id, first.asset.id);
  assert.equal(preview.asset.prompt, "a lighthouse over calm water");
  // The archived original file is untouched on disk and in the database.
  assert.equal(sha256(await readFile(first.asset.image_path)), sha256(originalBytes));
  const reread = await store.getAsset("default", first.asset.id);
  assert.equal(reread.prompt, "a lighthouse over calm water");
  assert.equal(sha256(await readFile(reread.image_path)), sha256(originalBytes));
  assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  assert.equal((await store.listAssets({ projectId: "default", trash: true })).length, 0);
});

test("an archived preview yields to the same-id original; the preview moves to Trash intact", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-original-");
  const providerAssetId = "file-upgrade-preview-yields";
  const previewBytes = await noiseImage(640, 640, 9, "webp");
  const first = await captureImage(store, tempRoot, {
    imageBase64: previewBytes.toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId,
    prompt: "canvas draft",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  assert.equal(first.status, "imported");
  await store.toggleFavorite("default", first.asset.id);
  await store.updateMetadata("default", first.asset.id, { tags: ["keep"], group: "Trip" });
  // Stacks need two members; the sibling shares the stack but not the id.
  const sibling = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(300, 300, 21)).toString("base64"),
    capturedAt: "2026-10-28T10:00:30.000Z",
  });
  const stack = await store.createAssetStack("default", [first.asset.id, sibling.asset.id]);

  const sharperBytes = await noiseImage(1024, 1024, 13);
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: sharperBytes.toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-28T10:02:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  assert.equal(sharper.asset.id, first.asset.id);

  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  const snapshot = trash[0];
  assert.match(snapshot.id, new RegExp(`^${first.asset.id}-replaced-`));
  assert.equal(snapshot.trash_reason?.code, "replaced-by-better-version");
  assert.ok(snapshot.trash_reason?.at);
  // The moved file is the old preview's bytes, not a copy or a deletion.
  assert.equal(sha256(await readFile(snapshot.image_path)), sha256(previewBytes));
  // Snapshot identity is cleared; curation stays with the main asset.
  assert.equal(snapshot.source?.provider_asset_id ?? "", "");
  assert.equal(snapshot.source?.logical_output_id ?? "", "");
  assert.equal(snapshot.prompt, "canvas draft");
  assert.equal(snapshot.favorite, false);
  assert.deepEqual(snapshot.tags, []);
  assert.ok(!snapshot.group);
  assert.ok(!snapshot.parent_asset_id);

  const main = await store.getAsset("default", first.asset.id);
  assert.equal(main.favorite, true);
  assert.equal(main.group, "Trip");
  assert.ok(main.tags.includes("keep"));
  const stackAssets = await store.listAssetStackAssets("default", stack.id);
  assert.ok(stackAssets.assets.some((asset) => asset.id === first.asset.id));
  assert.equal(sha256(await readFile(main.image_path)), sha256(sharperBytes));
});

test("an equal-pixel re-encode for the same id is not a replacement", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-same-pixels-");
  const providerAssetId = "file-upgrade-same-pixels";
  const firstBytes = await noiseImage(1024, 1024, 5, "jpeg");
  const first = await captureImage(store, tempRoot, {
    imageBase64: firstBytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const second = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1024, 1024, 11, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(second.status, "skipped");
  assert.equal(second.asset.id, first.asset.id);
  assert.equal((await store.listAssets({ projectId: "default", trash: true })).length, 0);
  assert.equal(sha256(await readFile((await store.getAsset("default", first.asset.id)).image_path)), sha256(firstBytes));
});

test("strictly more pixels replace the media and move the old original to Trash", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-more-pixels-");
  const providerAssetId = "file-upgrade-more-pixels";
  const firstBytes = await noiseImage(1024, 1024, 5, "jpeg");
  const first = await captureImage(store, tempRoot, {
    imageBase64: firstBytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const oldPath = first.asset.image_path;
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  assert.equal(sharper.reason, "logical-output-media-upgraded");
  assert.equal(sharper.asset.id, first.asset.id);
  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  // The old original moved onto the snapshot; the old path no longer holds it.
  assert.equal(sha256(await readFile(trash[0].image_path)), sha256(firstBytes));
  await assert.rejects(() => stat(oldPath));
});

test("a same-id image never replaces a video, and a video never replaces an image", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-cross-kind-");
  const providerAssetId = "jimeng-shared-output-id";
  const videoBase64 = sampleMp4Bytes().toString("base64");
  const video = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "jimeng",
      mediaKind: "video",
      mediaBase64: videoBase64,
      mimeType: "video/mp4",
      providerAssetId,
      generationStatus: "completed",
      capturedAt: "2026-10-28T10:00:00.000Z",
    },
  });
  assert.equal(video.status, "imported");
  const videoPath = video.asset.image_path;
  const videoHash = sha256(await readFile(videoPath));

  const image = await captureImage(store, tempRoot, {
    provider: "jimeng",
    imageBase64: (await noiseImage(1024, 1024, 17)).toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(image.status, "imported");
  assert.notEqual(image.asset.id, video.asset.id);
  // The video keeps its own row, its file, and its identity.
  const videoAfter = await store.getAsset("default", video.asset.id);
  assert.equal(videoAfter.source?.content_sha256, video.asset.source?.content_sha256);
  assert.equal(sha256(await readFile(videoPath)), videoHash);
  assert.equal((await store.findAssetByProviderIdentity("default", "jimeng", providerAssetId, "", "video"))?.id, video.asset.id);
  assert.equal((await store.findAssetByProviderIdentity("default", "jimeng", providerAssetId, "", "image"))?.id, image.asset.id);

  // The mirror case: the image is archived first, the video arrives with the
  // same id and lands as its own asset too.
  const { store: store2, tempRoot: tempRoot2 } = await createTestStore(t, "mosa-upgrade-cross-kind2-");
  const imageFirst = await captureImage(store2, tempRoot2, {
    provider: "jimeng",
    imageBase64: (await noiseImage(1024, 1024, 19)).toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-28T11:00:00.000Z",
  });
  const videoArrival = await ingestWebCapture({
    store: store2,
    tempRoot: tempRoot2,
    projectId: "default",
    input: {
      provider: "jimeng",
      mediaKind: "video",
      mediaBase64: sampleMp4Bytes(11).toString("base64"),
      mimeType: "video/mp4",
      providerAssetId,
      generationStatus: "completed",
      capturedAt: "2026-10-28T11:01:00.000Z",
    },
  });
  assert.equal(videoArrival.status, "imported");
  assert.notEqual(videoArrival.asset.id, imageFirst.asset.id);
  const imageAfter = await store2.getAsset("default", imageFirst.asset.id);
  assert.equal(imageAfter.source?.content_sha256, imageFirst.asset.source?.content_sha256);
});

test("an empty incoming prompt never clears the stored prompt metadata on replacement", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-empty-prompt-");
  const providerAssetId = "file-upgrade-empty-prompt";
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1024, 1024, 5, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "a quiet harbor at dawn",
    prompt_status: "generation-tool-prompt",
    prompt_source: "chatgpt-tool",
    prompt_priority: 7,
    user_message: "make it calm",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  const main = await store.getAsset("default", first.asset.id);
  assert.equal(main.prompt, "a quiet harbor at dawn");
  assert.equal(main.source?.prompt_status, "generation-tool-prompt");
  assert.equal(main.source?.prompt_source, "chatgpt-tool");
  assert.equal(main.source?.prompt_priority, 7);
  assert.equal(main.source?.user_message, "make it calm");
  assert.equal(main.business_fields?.prompt_status, "generation-tool-prompt");
  assert.equal(main.business_fields?.user_message, "make it calm");
});

test("a better incoming prompt upgrades through maybeUpgradePrompt; a weaker one does not", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-better-prompt-");
  const providerAssetId = "file-upgrade-better-prompt";
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1024, 1024, 5, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "sunset",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "a detailed sunset over the calm sea with a lighthouse",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  const main = await store.getAsset("default", first.asset.id);
  assert.equal(main.prompt, "a detailed sunset over the calm sea with a lighthouse");

  const { store: store2, tempRoot: tempRoot2 } = await createTestStore(t, "mosa-upgrade-weaker-prompt-");
  const first2 = await captureImage(store2, tempRoot2, {
    imageBase64: (await noiseImage(1024, 1024, 5, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "a detailed sunset over the calm sea with a lighthouse",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const sharper2 = await captureImage(store2, tempRoot2, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "sunset",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper2.status, "imported");
  const main2 = await store2.getAsset("default", first2.asset.id);
  assert.equal(main2.prompt, "a detailed sunset over the calm sea with a lighthouse");
});

test("the Trash snapshot is invisible to provider identity and deletion sync, and restores standalone", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-trash-invisible-");
  const providerAssetId = "file-upgrade-trash-invisible";
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(640, 640, 9, "webp")).toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId,
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1024, 1024, 13)).toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  const snapshotId = trash[0].id;

  const identity = await store.findAssetByProviderIdentity("default", "chatgpt", providerAssetId, "", "image");
  assert.equal(identity.id, first.asset.id);
  const deletionMatches = await store.findProviderDeletionMatches("default", "chatgpt", providerAssetId);
  assert.deepEqual(deletionMatches.map((match) => match.id), [first.asset.id]);

  const restored = await store.restoreAsset("default", snapshotId);
  assert.equal(restored.deleted_at, null);
  assert.ok(!restored.trash_reason);
  const active = await store.listAssets({ projectId: "default" });
  assert.deepEqual(active.map((asset) => asset.id).sort(), [first.asset.id, snapshotId].sort());
  // The restored snapshot is an ordinary asset again — its identity stays
  // cleared, so a same-id capture still resolves to the main asset only.
  const identityAfterRestore = await store.findAssetByProviderIdentity("default", "chatgpt", providerAssetId, "", "image");
  assert.equal(identityAfterRestore.id, first.asset.id);
});

test("a second provider id for identical bytes is appended, never overwritten", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-merged-ids-");
  const bytes = await noiseImage(1024, 1024, 5, "jpeg");
  const first = await captureImage(store, tempRoot, {
    imageBase64: bytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId: "file-first-id",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const second = await captureImage(store, tempRoot, {
    imageBase64: bytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId: "file-second-id",
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(second.status, "skipped");
  assert.equal(second.asset.id, first.asset.id);
  const main = await store.getAsset("default", first.asset.id);
  assert.equal(main.source?.provider_asset_id, "file-first-id");
  assert.deepEqual(main.source?.merged_provider_asset_ids, ["file-second-id"]);
});

test("derived URLs carry a content version that changes with the bytes and stays stable otherwise", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-url-version-");
  const runDerivatives = async () => {
    for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
      assert.equal((await processDerivativeJob(store, job)).ok, true);
    }
  };
  const providerAssetId = "file-upgrade-url-version";
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1024, 1024, 5, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  await runDerivatives();
  // Derivative files keep the same `<id>.webp` name across a replacement, so
  // only the ?v= content version can tell the one-year cache the bytes changed.
  const derivedPattern = (tier) => new RegExp(`/${tier}/${first.asset.id}\\.webp\\?v=[0-9a-f]{12}$`);
  const before = await store.getAsset("default", first.asset.id);
  assert.match(before.thumbnail_url, derivedPattern("thumbnails"));
  assert.equal((await store.getAsset("default", first.asset.id)).thumbnail_url, before.thumbnail_url);

  await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  await runDerivatives();
  const after = await store.getAsset("default", first.asset.id);
  assert.match(after.thumbnail_url, derivedPattern("thumbnails"));
  assert.match(after.medium_url, derivedPattern("mediums"));
  assert.match(after.preview_url, derivedPattern("previews"));
  assert.notEqual(after.thumbnail_url, before.thumbnail_url);
  assert.notEqual(after.medium_url, before.medium_url);
  assert.notEqual(after.preview_url, before.preview_url);
  // The gallery reads through the paged listing: it must hand out the same
  // versioned URLs, or the gallery keeps showing the cached old pixels.
  const listed = (await store.listAssetPage({ projectId: "default", limit: 50 })).assets.find((asset) => asset.id === first.asset.id);
  assert.equal(listed?.thumbnail_url, after.thumbnail_url);
  assert.equal(listed?.medium_url, after.medium_url);
  assert.equal(listed?.preview_url, after.preview_url);

  // Without derivatives the fallback is the original URL itself (a replacement
  // always writes a new original file name), stable on every read.
  const untouched = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(512, 512, 23)).toString("base64"),
    capturedAt: "2026-10-28T10:02:00.000Z",
  });
  const untouchedAsset = await store.getAsset("default", untouched.asset.id);
  assert.equal(untouchedAsset.thumbnail_url, untouchedAsset.image_url);
  assert.equal((await store.getAsset("default", untouched.asset.id)).thumbnail_url, untouchedAsset.thumbnail_url);
});

test("copies and versions never answer the identity lookup; the ingested original is the one replaced", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-upgrade-copies-");
  const providerAssetId = "file-upgrade-with-copies";
  const originalBytes = await noiseImage(1024, 1024, 5, "jpeg");
  const main = await captureImage(store, tempRoot, {
    imageBase64: originalBytes.toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    prompt: "original prompt",
    prompt_status: "generation-tool-prompt",
    capturedAt: "2026-10-28T10:00:00.000Z",
  });
  const copy = await store.duplicateAsset("default", main.asset.id);
  // The version hangs off the copy so the ingested original stays childless
  // and can move to Trash at the end of this test.
  const version = await store.createAssetVersion("default", copy.id, { version_change: "tweak" });
  assert.equal(copy.source?.duplicated_from, main.asset.id);
  assert.equal(version.parent_asset_id, copy.id);

  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  assert.equal(sharper.asset.id, main.asset.id);
  // Copy and version keep their own bytes and prompt.
  assert.equal(sha256(await readFile(copy.image_path)), sha256(originalBytes));
  assert.equal(copy.prompt, "original prompt");
  const versionAfter = await store.getAsset("default", version.id);
  assert.equal(sha256(await readFile(versionAfter.image_path)), sha256(originalBytes));
  assert.equal(versionAfter.prompt, "original prompt");
  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  assert.match(trash[0].id, new RegExp(`^${main.asset.id}-replaced-`));

  // With the ingested original gone, the same id resolves to nothing: the
  // capture imports as a fresh asset instead of overwriting the copy.
  await store.deleteAsset("default", main.asset.id);
  const fresh = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(1536, 1536, 29, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId,
    capturedAt: "2026-10-28T10:02:00.000Z",
  });
  assert.equal(fresh.status, "imported");
  assert.notEqual(fresh.asset.id, copy.id);
  assert.notEqual(fresh.asset.id, version.id);
  assert.equal(sha256(await readFile((await store.getAsset("default", copy.id)).image_path)), sha256(originalBytes));
});
