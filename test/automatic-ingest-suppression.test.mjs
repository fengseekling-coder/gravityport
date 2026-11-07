import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { brokenPngBytes } from "./helpers/managed-media.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";
import sharp from "sharp";

const PIXEL_HASH = "b".repeat(64);
const SECOND_PIXEL_HASH = "c".repeat(64);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function setupStore(t, kind) {
  const root = await mkdtemp(join(tmpdir(), `mosa-ingest-suppression-${kind}-`));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const managerDir = join(projectRoot, "mosa");
  const libraryDir = join(root, "library");
  const sourcePath = join(projectRoot, "generated-images", "original.png");
  await mkdir(join(projectRoot, "generated-images"), { recursive: true });
  await writeFile(sourcePath, await brokenPngBytes(1));
  const store = kind.startsWith("sqlite")
    ? createSqliteAssetStore({ projectRoot, managerDir, libraryDir })
    : createJsonAssetStore({ projectRoot, managerDir });
  t.after(async () => {
    store.close?.();
  });
  return { root, projectRoot, libraryDir, sourcePath, store };
}

function automaticInput(sourcePath, assetId, source = {}) {
  return {
    projectId: "default",
    assetId,
    imagePath: sourcePath,
    source: { ...source },
  };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind} revalidates a current pixel hash when its claimed content changed`, async (t) => {
    const { store, sourcePath } = await setupStore(t, `${kind}-stale-current-pixel`);
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 17, g: 61, b: 149 } },
    }).png().toBuffer();
    await writeFile(sourcePath, png);
    const actualPixelHash = await safePixelDigest(png);
    const stalePixelHash = "d".repeat(64);
    await store.recordAutomaticIngestSuppression("default", {
      pixel_sha256: stalePixelHash,
      pixel_hash_version: PIXEL_HASH_VERSION,
    });

    const asset = await store.createAsset(
      automaticInput(sourcePath, `${kind}-stale-current-pixel`, {
        content_sha256: "e".repeat(64),
        pixel_sha256: stalePixelHash,
        pixel_hash_version: PIXEL_HASH_VERSION,
      }),
      { ingestMode: "automatic" },
    );

    assert.equal(asset.source.pixel_sha256, actualPixelHash);
    assert.equal(asset.source.pixel_hash_version, PIXEL_HASH_VERSION);
  });

  test(`${kind} deletion upgrades a legacy pixel identity from the managed image`, async (t) => {
    const { store, sourcePath } = await setupStore(t, `${kind}-delete-legacy-pixel`);
    const png = await sharp({
      create: { width: 9, height: 7, channels: 3, background: { r: 201, g: 99, b: 31 } },
    }).png().toBuffer();
    await writeFile(sourcePath, png);
    const currentPixelHash = await safePixelDigest(png);
    const asset = await store.createAsset(
      automaticInput(sourcePath, `${kind}-delete-legacy-pixel`, { pixel_sha256: PIXEL_HASH }),
      { ingestMode: "automatic" },
    );
    await store.deleteAsset("default", asset.id);
    const [suppression] = await store.listAutomaticIngestSuppressions("default");
    assert.equal(suppression.pixel_sha256, currentPixelHash);
    assert.equal(suppression.pixel_hash_version, PIXEL_HASH_VERSION);
  });

  test(`${kind} automatic ingest is idempotent under concurrent writes with different asset ids`, async (t) => {
    const { store, sourcePath } = await setupStore(t, `${kind}-duplicate-race`);
    const results = await Promise.allSettled([
      store.createAsset(automaticInput(sourcePath, `${kind}-race-a`), { ingestMode: "automatic" }),
      store.createAsset(automaticInput(sourcePath, `${kind}-race-b`), { ingestMode: "automatic" }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.equal(rejected?.reason?.code, "AUTOMATIC_INGEST_DUPLICATE");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  });

  test(`${kind} does not trust a legacy pixel hash as the current pixel identity`, async (t) => {
    const { store, sourcePath } = await setupStore(t, `${kind}-pixel-version`);
    await store.createAsset(
      automaticInput(sourcePath, `${kind}-legacy-pixel`, { pixel_sha256: PIXEL_HASH }),
      { ingestMode: "automatic" },
    );
    await writeFile(sourcePath, await brokenPngBytes(2));
    const current = await store.createAsset(
      automaticInput(sourcePath, `${kind}-current-pixel`, {
        pixel_sha256: PIXEL_HASH,
        pixel_hash_version: PIXEL_HASH_VERSION,
      }),
      { ingestMode: "automatic" },
    );
    assert.equal(current.id, `${kind}-current-pixel`);
    assert.equal((await store.listAssets({ projectId: "default" })).length, 2);
  });

  test(`${kind} deletion suppresses the same automatic content and manual import restores it`, async (t) => {
    const { store, sourcePath } = await setupStore(t, kind);

    const first = await store.createAsset(
      automaticInput(sourcePath, `${kind}-first`, { pixel_sha256: PIXEL_HASH }),
      { ingestMode: "automatic" },
    );
    await store.deleteAsset("default", first.id);

    const suppressions = await store.listAutomaticIngestSuppressions("default");
    assert.equal(suppressions.length, 1);
    assert.equal(suppressions[0].content_sha256, first.source.content_sha256);
    assert.equal(suppressions[0].pixel_sha256, PIXEL_HASH);
    assert.equal((await store.findAutomaticIngestSuppression("default", {
      content_sha256: first.source.content_sha256,
    })).reason, "user-deleted");

    await assert.rejects(
      store.createAsset(automaticInput(sourcePath, `${kind}-automatic-again`, { pixel_sha256: PIXEL_HASH }), { ingestMode: "automatic" }),
      (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED",
    );

    const manual = await store.createAsset(
      automaticInput(sourcePath, `${kind}-manual-restore`, { pixel_sha256: PIXEL_HASH }),
      { ingestMode: "manual" },
    );
    assert.equal(manual.id, `${kind}-manual-restore`);
    assert.deepEqual(await store.listAutomaticIngestSuppressions("default"), []);
  });

  test(`${kind} rechecks suppression immediately before an automatic asset becomes visible`, async (t) => {
    const { store, sourcePath } = await setupStore(t, `${kind}-race`);
    const originalFind = store.findAutomaticIngestSuppression.bind(store);
    const checked = deferred();
    const continueImport = deferred();
    let paused = false;
    store.findAutomaticIngestSuppression = async (...args) => {
      const result = await originalFind(...args);
      if (!paused) {
        paused = true;
        checked.resolve(args[1]);
        await continueImport.promise;
      }
      return result;
    };

    const creating = store.createAsset(
      automaticInput(sourcePath, `${kind}-stale-preflight`, { pixel_sha256: PIXEL_HASH }),
      { ingestMode: "automatic" },
    );
    const hashes = await checked.promise;
    await store.recordAutomaticIngestSuppression("default", hashes);
    continueImport.resolve();

    await assert.rejects(creating, (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED");
    await assert.rejects(store.getAsset("default", `${kind}-stale-preflight`), (error) => error.code === "ASSET_NOT_FOUND");
    assert.deepEqual(await readdir(store.imagesDir("default")), []);
  });

}

test("automatic suppression matches a re-encoded image only when the trusted pixel hash agrees", async (t) => {
  const { store, sourcePath } = await setupStore(t, "sqlite-pixel");
  const first = await store.createAsset(
    automaticInput(sourcePath, "pixel-first", { pixel_sha256: PIXEL_HASH }),
    { ingestMode: "automatic" },
  );
  await store.deleteAsset("default", first.id);

  await writeFile(sourcePath, await brokenPngBytes(3));
  await assert.rejects(
    store.createAsset(automaticInput(sourcePath, "pixel-reencoded", { pixel_sha256: PIXEL_HASH }), { ingestMode: "automatic" }),
    (error) => error.code === "AUTOMATIC_IMPORT_SUPPRESSED",
  );

  const changedPixels = await store.createAsset(
    automaticInput(sourcePath, "pixel-changed", { pixel_sha256: "c".repeat(64) }),
    { ingestMode: "automatic" },
  );
  assert.equal(changedPixels.id, "pixel-changed");
});

test("SQLite clears only the requested pixel-only suppression", async (t) => {
  const { store, sourcePath } = await setupStore(t, "sqlite-pixel-only-clear");
  await store.recordAutomaticIngestSuppression("default", { pixel_sha256: PIXEL_HASH });
  await store.recordAutomaticIngestSuppression("default", { pixel_sha256: SECOND_PIXEL_HASH });

  assert.equal(await store.clearAutomaticIngestSuppression("default", { pixel_sha256: PIXEL_HASH }), 1);
  assert.deepEqual(
    (await store.listAutomaticIngestSuppressions("default")).map((record) => record.pixel_sha256),
    [SECOND_PIXEL_HASH],
  );

  await store.recordAutomaticIngestSuppression("default", { pixel_sha256: PIXEL_HASH });
  await store.createAsset(
    automaticInput(sourcePath, "manual-pixel-only-clear", { pixel_sha256: PIXEL_HASH }),
    { ingestMode: "manual" },
  );
  assert.deepEqual(
    (await store.listAutomaticIngestSuppressions("default")).map((record) => record.pixel_sha256),
    [SECOND_PIXEL_HASH],
  );
});

test("SQLite keeps pixel-only suppressions from different hash versions independent", async (t) => {
  const { store, sourcePath } = await setupStore(t, "sqlite-pixel-version-clear");
  await store.recordAutomaticIngestSuppression("default", { pixel_sha256: PIXEL_HASH });
  await store.recordAutomaticIngestSuppression("default", {
    pixel_sha256: PIXEL_HASH,
    pixel_hash_version: PIXEL_HASH_VERSION,
  });

  assert.equal((await store.listAutomaticIngestSuppressions("default")).length, 2);
  assert.equal(await store.clearAutomaticIngestSuppression("default", {
    pixel_sha256: PIXEL_HASH,
    pixel_hash_version: PIXEL_HASH_VERSION,
  }), 1);
  assert.deepEqual(
    (await store.listAutomaticIngestSuppressions("default")).map((record) => record.pixel_hash_version),
    [""],
  );

  await store.recordAutomaticIngestSuppression("default", {
    pixel_sha256: PIXEL_HASH,
    pixel_hash_version: PIXEL_HASH_VERSION,
  });
  await store.createAsset(
    automaticInput(sourcePath, "manual-versioned-pixel-clear", {
      pixel_sha256: PIXEL_HASH,
      pixel_hash_version: PIXEL_HASH_VERSION,
    }),
    { ingestMode: "manual" },
  );
  assert.deepEqual(
    (await store.listAutomaticIngestSuppressions("default")).map((record) => record.pixel_hash_version),
    [""],
  );
});

test("same source URL with changed content remains eligible for automatic import", async (t) => {
  const { store, sourcePath } = await setupStore(t, "sqlite-url");
  const first = await store.createAsset(
    automaticInput(sourcePath, "url-first", { page_url: "https://example.test/image/1" }),
    { ingestMode: "automatic" },
  );
  await store.deleteAsset("default", first.id);

  await writeFile(sourcePath, await brokenPngBytes(4));
  const next = await store.createAsset(
    automaticInput(sourcePath, "url-changed-content", { page_url: "https://example.test/image/1" }),
    { ingestMode: "automatic" },
  );
  assert.equal(next.id, "url-changed-content");
});

test("SQLite keeps suppression lookup indexed and soft-deletes the asset atomically with suppression", async (t) => {
  const { store, libraryDir, sourcePath } = await setupStore(t, "sqlite-index");
  const asset = await store.createAsset({ assetId: "indexed-delete", imagePath: sourcePath }, { ingestMode: "manual" });
  await store.deleteAsset("default", asset.id);

  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  t.after(() => database.close());
  const suppression = database.prepare("SELECT content_sha256, pixel_sha256, reason FROM automatic_ingest_suppressions").get();
  assert.match(suppression.content_sha256, /^[a-f0-9]{64}$/);
  assert.equal(suppression.pixel_sha256, "");
  assert.equal(suppression.reason, "user-deleted");
  const trashed = database.prepare("SELECT deleted_at FROM assets WHERE id = ?").get(asset.id);
  assert.match(trashed.deleted_at, /^\d{4}-\d{2}-\d{2}T/);
  const plan = database.prepare(`EXPLAIN QUERY PLAN
    SELECT 1 FROM automatic_ingest_suppressions INDEXED BY automatic_suppressions_project_content_idx
    WHERE project_id = ? AND content_sha256 = ?
  `).all("default", suppression.content_sha256).map((row) => row.detail).join(" | ");
  assert.match(plan, /automatic_suppressions_project_content_idx/);
});
