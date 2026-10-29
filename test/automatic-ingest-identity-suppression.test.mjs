// Site-identity suppression list (task 300): deleting an automatic capture
// also records its provider identity, so the same id arriving again — even
// with different bytes or pixels — no longer resurrects the asset. Restore
// and non-automatic creations clear the entry; the media-replacement snapshot
// (task 280) is the exception because its id lives on in the surviving asset.
// Real sqlite store, real ingest module, temporary library
// (web-capture-same-id-upgrade.test.mjs pattern).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";

// Midjourney provider asset ids are `<jobId>:<index>` with a hyphenated UUID
// jobId (extensions/chatgpt-web-capture/provider-midjourney.js); the Jimeng id
// is the numeric item id the page API returns (jimengPollFixture shape).
const MIDJOURNEY_PREVIEW_ID = "3f0c2a9e-8b1d-4c57-9e2a-1b6d7f40c8aa:0";
const JIMENG_ITEM_ID = "7468000000000000011";
const JIMENG_VIDEO_ID = "7468000000000000012";

async function noiseImage(width, height, seed, format = "png") {
  const raw = Buffer.alloc(width * height * 3);
  randomBytes(raw.length).copy(raw);
  raw[0] = seed & 255;
  const encoder = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === "webp") return encoder.webp({ lossless: true }).toBuffer();
  if (format === "jpeg") return encoder.jpeg({ quality: 80 }).toBuffer();
  return encoder.png().toBuffer();
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
  return { root, libraryDir, store, tempRoot };
}

async function captureImage(store, tempRoot, input) {
  return ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: { provider: "midjourney", mimeType: "image/png", generationStatus: "completed", ...input },
  });
}

test("a deleted Midjourney preview keeps the same-id original from coming back", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-a5-");
  const previewBytes = await noiseImage(640, 640, 9, "webp");
  const first = await captureImage(store, tempRoot, {
    imageBase64: previewBytes.toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(first.status, "imported");
  await store.deleteAsset("default", first.asset.id);

  const originalBytes = await noiseImage(2048, 2048, 17, "jpeg");
  const again = await captureImage(store, tempRoot, {
    imageBase64: originalBytes.toString("base64"),
    mimeType: "image/jpeg",
    mediaVariant: "original",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "suppressed-after-delete");
  assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
  assert.equal((await store.listAssets({ projectId: "default", trash: true })).length, 1);
});

test("restoring the deleted preview re-admits the id: the original replaces in place", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-restore-");
  const previewBytes = await noiseImage(640, 640, 9, "webp");
  const first = await captureImage(store, tempRoot, {
    imageBase64: previewBytes.toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  await store.deleteAsset("default", first.asset.id);
  await store.restoreAsset("default", first.asset.id);

  const originalBytes = await noiseImage(2048, 2048, 17, "jpeg");
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: originalBytes.toString("base64"),
    mimeType: "image/jpeg",
    mediaVariant: "original",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  assert.equal(sharper.reason, "logical-output-media-upgraded");
  assert.equal(sharper.asset.id, first.asset.id);
  assert.equal(sharper.replacedAssetId, first.asset.id);
  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  assert.equal(trash[0].trash_reason?.code, "replaced-by-better-version");
  assert.match(trash[0].id, new RegExp(`^${first.asset.id}-replaced-`));
  const main = await store.getAsset("default", first.asset.id);
  assert.equal(main.source?.media_variant, "original");
});

test("permanently deleting the preview keeps the id suppressed", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-permanent-");
  const previewBytes = await noiseImage(640, 640, 9, "webp");
  const first = await captureImage(store, tempRoot, {
    imageBase64: previewBytes.toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  await store.deleteAsset("default", first.asset.id);
  await store.permanentlyDeleteAsset("default", first.asset.id);
  assert.equal((await store.listAssets({ projectId: "default", trash: true })).length, 0);

  const originalBytes = await noiseImage(2048, 2048, 17, "jpeg");
  const again = await captureImage(store, tempRoot, {
    imageBase64: originalBytes.toString("base64"),
    mimeType: "image/jpeg",
    mediaVariant: "original",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "suppressed-after-delete");
});

test("a manual capture under the same id lands and clears the identity list", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-manual-");
  const previewBytes = await noiseImage(640, 640, 9, "webp");
  const first = await captureImage(store, tempRoot, {
    imageBase64: previewBytes.toString("base64"),
    mimeType: "image/webp",
    mediaVariant: "preview",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  await store.deleteAsset("default", first.asset.id);

  const manualBytes = await noiseImage(1024, 1024, 23);
  const manual = await captureImage(store, tempRoot, {
    imageBase64: manualBytes.toString("base64"),
    mimeType: "image/png",
    captureMode: "manual",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(manual.status, "imported");
  assert.notEqual(manual.asset.id, first.asset.id);

  // The identity list is gone: an automatic arrival under the same id is
  // answered by the manual asset (observed, not suppressed).
  const again = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(800, 800, 29)).toString("base64"),
    mimeType: "image/png",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:02:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.ok(String(again.reason || "").startsWith("already-archived"), `unexpected reason: ${again.reason}`);
  assert.equal(again.asset.id, manual.asset.id);
});

test("permanently deleting a replaced-away original does not suppress the surviving id", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-replaced-");
  const providerAssetId = "3f0c2a9e-8b1d-4c57-9e2a-1b6d7f40c8aa:1";
  const firstBytes = await noiseImage(1024, 1024, 5);
  const first = await captureImage(store, tempRoot, {
    imageBase64: firstBytes.toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  const sharper = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 13)).toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(sharper.status, "imported");
  const trash = await store.listAssets({ projectId: "default", trash: true });
  assert.equal(trash.length, 1);
  assert.equal(trash[0].trash_reason?.code, "replaced-by-better-version");
  await store.permanentlyDeleteAsset("default", trash[0].id);

  // The survivor still holds the id: a same-id arrival is observed, never
  // suppressed — otherwise the survivor's own future upgrades would be blocked.
  const again = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(800, 800, 31)).toString("base64"),
    providerAssetId,
    capturedAt: "2026-10-29T10:02:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.ok(String(again.reason || "").startsWith("already-archived"), `unexpected reason: ${again.reason}`);
  assert.equal(again.asset.id, first.asset.id);
});

test("Jimeng in-app deletion sync also suppresses by identity", async (t) => {
  const { store, tempRoot } = await createTestStore(t, "mosa-identity-jimeng-");
  const first = await captureImage(store, tempRoot, {
    provider: "jimeng",
    imageBase64: (await noiseImage(360, 360, 9)).toString("base64"),
    providerAssetId: JIMENG_ITEM_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(first.status, "imported");
  await store.deleteAsset("default", first.asset.id, { reason: "provider-deleted:jimeng" });

  const again = await captureImage(store, tempRoot, {
    provider: "jimeng",
    imageBase64: (await noiseImage(816, 1456, 17)).toString("base64"),
    providerAssetId: JIMENG_ITEM_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "suppressed-after-delete");
  assert.equal((await store.listAssets({ projectId: "default" })).length, 0);
});

test("the store-composed identity key matches the web capture key", async (t) => {
  const { root, store, tempRoot } = await createTestStore(t, "mosa-identity-key-");
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(640, 640, 9)).toString("base64"),
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  assert.equal(first.status, "imported");
  // web-capture-ingest's logicalCaptureKey shape.
  const webKey = `default\u001fmidjourney\u001fasset:${MIDJOURNEY_PREVIEW_ID}`;
  assert.equal(first.asset.source?.logical_output_id, webKey);
  await store.deleteAsset("default", first.asset.id);

  // The store side composes the same key from provider + provider asset id
  // (no stored logical_output_id on the incoming source) and must hit the
  // suppression the deleted web capture wrote.
  const sourcePath = join(root, "key-check-src.png");
  await writeFile(sourcePath, await noiseImage(512, 512, 37));
  await assert.rejects(
    store.createAsset(
      {
        projectId: "default",
        assetId: "identity-key-check",
        imagePath: sourcePath,
        sourceType: "web-midjourney",
        source: { provider: "midjourney", provider_asset_id: MIDJOURNEY_PREVIEW_ID },
      },
      { ingestMode: "automatic" },
    ),
    (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED",
  );
});

test("the identity list survives closing and reopening the same library", async (t) => {
  const { root, store, tempRoot } = await createTestStore(t, "mosa-identity-reopen-");
  const first = await captureImage(store, tempRoot, {
    imageBase64: (await noiseImage(640, 640, 9)).toString("base64"),
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:00:00.000Z",
  });
  await store.deleteAsset("default", first.asset.id);
  await store.close();

  // Reopening re-runs the schema block: the CREATE TABLE IF NOT EXISTS for the
  // identity list must be idempotent, and the recorded entry must survive.
  const reopened = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir: join(root, "library") });
  t.after(() => reopened.close?.());
  const again = await captureImage(reopened, tempRoot, {
    imageBase64: (await noiseImage(2048, 2048, 17, "jpeg")).toString("base64"),
    mimeType: "image/jpeg",
    providerAssetId: MIDJOURNEY_PREVIEW_ID,
    capturedAt: "2026-10-29T10:01:00.000Z",
  });
  assert.equal(again.status, "skipped");
  assert.equal(again.reason, "suppressed-after-delete");
});

test("a replaced-media trash row never records its identity on permanent deletion", async (t) => {
  const { root, libraryDir, store } = await createTestStore(t, "mosa-identity-swap-guard-");
  const sourceA = join(root, "swap-guard-a.png");
  await writeFile(sourceA, await noiseImage(512, 512, 5));
  await store.createAsset(
    {
      projectId: "default",
      assetId: "swap-guard-a",
      imagePath: sourceA,
      sourceType: "web-midjourney",
      source: { provider: "midjourney", provider_asset_id: "swap-guard:0" },
    },
    { ingestMode: "automatic" },
  );
  // Hand-forge the shape a swap snapshot would have if it kept its provider
  // identity (the store clears the identity on real snapshots today): a trash
  // row with the replaced-media reason AND the provider id still on it.
  const database = new Database(sqliteDatabasePath(libraryDir));
  t.after(() => database.close());
  const stamp = new Date().toISOString();
  const row = database.prepare("SELECT metadata_json FROM assets WHERE id = 'swap-guard-a'").get();
  const metadata = JSON.parse(row.metadata_json);
  metadata.trash_reason = { code: "replaced-by-better-version", at: stamp };
  database.prepare("UPDATE assets SET deleted_at = ?, metadata_json = ? WHERE id = 'swap-guard-a'")
    .run(stamp, JSON.stringify(metadata));
  database.close();
  await store.permanentlyDeleteAsset("default", "swap-guard-a");

  // The guard held: the id stays admissible for the survivor's sake.
  const sourceB = join(root, "swap-guard-b.png");
  await writeFile(sourceB, await noiseImage(640, 480, 11));
  const admitted = await store.createAsset(
    {
      projectId: "default",
      assetId: "swap-guard-b",
      imagePath: sourceB,
      sourceType: "web-midjourney",
      source: { provider: "midjourney", provider_asset_id: "swap-guard:0" },
    },
    { ingestMode: "automatic" },
  );
  assert.equal(admitted.id, "swap-guard-b");
});

test("restoring an asset re-admits its identity at the store level", async (t) => {
  const { root, store } = await createTestStore(t, "mosa-identity-restore-clear-");
  const png = await noiseImage(512, 512, 5);
  const sourceA = join(root, "identity-restore-a.png");
  await writeFile(sourceA, png);
  await store.createAsset(
    {
      projectId: "default",
      assetId: "identity-restore-a",
      imagePath: sourceA,
      sourceType: "web-midjourney",
      source: { provider: "midjourney", provider_asset_id: "restore-check:0" },
    },
    { ingestMode: "automatic" },
  );
  await store.deleteAsset("default", "identity-restore-a");
  const sourceB = join(root, "identity-restore-b.png");
  await writeFile(sourceB, await noiseImage(640, 480, 11));
  await assert.rejects(
    store.createAsset(
      {
        projectId: "default",
        assetId: "identity-restore-b",
        imagePath: sourceB,
        sourceType: "web-midjourney",
        source: { provider: "midjourney", provider_asset_id: "restore-check:0" },
      },
      { ingestMode: "automatic" },
    ),
    (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED",
  );
  // Restoring clears the entry: the same identity is admissible again.
  await store.restoreAsset("default", "identity-restore-a");
  const admitted = await store.createAsset(
    {
      projectId: "default",
      assetId: "identity-restore-b",
      imagePath: sourceB,
      sourceType: "web-midjourney",
      source: { provider: "midjourney", provider_asset_id: "restore-check:0" },
    },
    { ingestMode: "automatic" },
  );
  assert.equal(admitted.id, "identity-restore-b");
});

test("video rows without a stored logical id compose the same key on deletion", async (t) => {
  const { root, store } = await createTestStore(t, "mosa-identity-video-");
  const fixtureBytes = await readFile(join(import.meta.dirname, "fixtures", "video-metadata", "capture-72x128.mp4"));
  const videoA = join(root, "video-a.mp4");
  await writeFile(videoA, fixtureBytes);
  const videoInput = {
    projectId: "default",
    sourceType: "web-jimeng",
    source: { provider: "jimeng", provider_asset_id: JIMENG_VIDEO_ID, media_kind: "video" },
    business_fields: { media_kind: "video" },
  };
  const created = await store.createAsset({ ...videoInput, assetId: "video-legacy-id", imagePath: videoA }, { ingestMode: "automatic" });
  assert.equal(created.id, "video-legacy-id");
  await store.deleteAsset("default", "video-legacy-id");

  const videoB = join(root, "video-b.mp4");
  await writeFile(videoB, Buffer.concat([fixtureBytes, Buffer.from("different-bytes")]));
  await assert.rejects(
    store.createAsset({ ...videoInput, assetId: "video-again", imagePath: videoB }, { ingestMode: "automatic" }),
    (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED",
  );

  // The list is per media kind: an image under the same provider id is a
  // different identity row and stays eligible.
  const imagePath = join(root, "img-same-id.png");
  await writeFile(imagePath, await noiseImage(512, 512, 41));
  const image = await store.createAsset(
    {
      projectId: "default",
      assetId: "img-same-id",
      imagePath,
      sourceType: "web-jimeng",
      source: { provider: "jimeng", provider_asset_id: JIMENG_VIDEO_ID },
    },
    { ingestMode: "automatic" },
  );
  assert.equal(image.id, "img-same-id");
});
