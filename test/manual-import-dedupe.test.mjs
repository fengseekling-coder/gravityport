import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { computePerceptualHash, perceptualHammingDistance } from "../lib/perceptual-hash.js";
import { importStagingDir } from "../lib/import-staging.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
// The main checkout sits on origin/main and holds the pre-task code; it opens
// libraries carrying the new table without complaint (original task §7.13).
const mainCheckout = resolve(repositoryRoot, "..", "gravityport");

// ─── fixtures ────────────────────────────────────────────────────────────────

async function makeStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const sourcesDir = join(root, "project", "generated-images");
  await mkdir(sourcesDir, { recursive: true });
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir: join(root, "library"),
    initializeFreshLibrary: true,
  });
  t.after(() => store.close());
  return { root, store, sourcesDir };
}

async function pngFile(sourcesDir, name, seed, width = 64, height = 64) {
  const filePath = join(sourcesDir, name);
  await sharp({ create: { width, height, channels: 3, background: { r: seed & 255, g: (seed * 7 + 11) & 255, b: (seed * 13 + 29) & 255 } } })
    .png().toFile(filePath);
  return filePath;
}

/** Two different 64×64 gradients: horizontal vs vertical — same shape, very
 * different dHash (row-difference bits all zero vs all one). */
async function gradientFile(sourcesDir, name, direction, size = 64) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = direction === "horizontal" ? Math.round((255 * x) / (size - 1)) : Math.round((255 * y) / (size - 1));
      const index = (y * size + x) * 3;
      raw[index] = value;
      raw[index + 1] = value;
      raw[index + 2] = value;
    }
  }
  const filePath = join(sourcesDir, name);
  await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .withMetadata({ exif: { IFD0: { ImageDescription: "dedupe fixture" } } })
    .toFile(filePath);
  return filePath;
}

async function importAsset(store, imagePath, extra = {}, context = { skipIdenticalBytes: true }) {
  return store.createAsset({ imagePath, prompt: "dedupe fixture", ...extra }, context);
}

async function drainDerivatives(store) {
  for (;;) {
    const job = await store.claimDerivativeJob();
    if (!job) break;
    const result = await processDerivativeJob(store, job);
    assert.equal(result.ok, true, `derivative generation failed: ${JSON.stringify(result)}`);
  }
}

async function transformTo(sourcePath, targetPath, transform) {
  let pipeline = sharp(sourcePath, { failOn: "error", limitInputPixels: 40_000_000 }).rotate();
  pipeline = transform(pipeline);
  await pipeline.toFile(targetPath);
  return targetPath;
}

function hashRowCount(store, assetId) {
  const database = new Database(store.databasePath, { readonly: true });
  try {
    return database.prepare("SELECT COUNT(*) AS n FROM asset_perceptual_hashes WHERE asset_id = ?").get(assetId).n;
  } finally {
    database.close();
  }
}

/** Store-level tests hold tiny libraries whose hash rows are complete after
 * drainDerivatives; writing the flag here equals a finished sweep and lets
 * similarCheckState compare instead of holding everything pending. */
function markBackfillDone(store) {
  return withRawDatabase(store, (database) => {
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('perceptual-hash-backfilled', '1', '2026-10-29T00:00:00.000Z')
      ON CONFLICT(key) DO UPDATE SET value = '1'
    `).run();
  });
}

function withRawDatabase(store, task) {
  const database = new Database(store.databasePath);
  return Promise.resolve(task(database)).finally(() => database.close());
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

// ─── byte-identical dedupe gate (rework §1) ──────────────────────────────────

test("manual ingestMode alone no longer dedupes: two imports of one file stay 2 assets", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-gate-");
  const first = await pngFile(sourcesDir, "a.png", 1);
  const second = await pngFile(sourcesDir, "b.png", 1);
  await importAsset(store, first, { assetId: "one" }, { ingestMode: "manual" });
  await importAsset(store, second, { assetId: "two" }, { ingestMode: "manual" });
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 2);
});

test("MCP-style createAsset without any context still stores both copies", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-mcp-");
  const first = await pngFile(sourcesDir, "a.png", 2);
  const second = await pngFile(sourcesDir, "b.png", 2);
  await store.createAsset({ assetId: "mcp-one", imagePath: first });
  await store.createAsset({ assetId: "mcp-two", imagePath: second });
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 2);
});

test("skipIdenticalBytes throws ALREADY_IN_LIBRARY carrying the existing copy's location", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-skip-");
  const first = await pngFile(sourcesDir, "a.png", 3);
  const second = await pngFile(sourcesDir, "b.png", 3);
  const original = await importAsset(store, first, { assetId: "keep-me" });
  await store.assignAssetsToGroup("default", ["keep-me"], "H");
  await assert.rejects(importAsset(store, second, { assetId: "dupe" }), (error) => {
    assert.equal(error.code, "ALREADY_IN_LIBRARY");
    assert.equal(error.existingAsset.id, "keep-me");
    assert.equal(error.existingAsset.groupName, "H");
    assert.equal(error.existingAsset.archived, false);
    return true;
  });
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].id, original.id);
});

test("trash copy does not dedupe, archived copy does", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-trash-");
  const first = await pngFile(sourcesDir, "a.png", 4);
  const second = await pngFile(sourcesDir, "b.png", 4);
  const third = await pngFile(sourcesDir, "c.png", 4);
  await importAsset(store, first, { assetId: "original" });
  await store.deleteAsset("default", "original");
  // With the only live copy in Trash the same bytes import again.
  await importAsset(store, second, { assetId: "after-trash" });
  // Park the live copy in Trash as well, then bring the archived one back so
  // the archived row is the only live same-bytes asset for the next import.
  await store.deleteAsset("default", "after-trash");
  await store.restoreAsset("default", "original");
  await store.archiveAsset("default", "original");
  await assert.rejects(importAsset(store, third, { assetId: "vs-archived" }), (error) => {
    assert.equal(error.code, "ALREADY_IN_LIBRARY");
    assert.equal(error.existingAsset.archived, true);
    return true;
  });
  const database = new Database(store.databasePath, { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets").get().n, 2);
  } finally {
    database.close();
  }
});

test("videos only dedupe on identical bytes and never on similarity", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-video-");
  const bytes = Buffer.from("not really a video, but the extension rules");
  const first = join(sourcesDir, "clip-one.mp4");
  const second = join(sourcesDir, "clip-two.mp4");
  await writeFile(first, bytes);
  await writeFile(second, bytes);
  await importAsset(store, first, { assetId: "clip-one" });
  await assert.rejects(importAsset(store, second, { assetId: "clip-two" }), (error) => {
    assert.equal(error.code, "ALREADY_IN_LIBRARY");
    return true;
  });
  const assets = await store.listAssets({ projectId: "default" });
  assert.equal(assets.length, 1);
});

// ─── similarity recall (user-approved option A) ──────────────────────────────

const RECALL_TRANSFORMS = [
  ["scale-50", (p) => p.resize(32, 32, { fit: "fill" }).png()],
  ["scale-25", (p) => p.resize(16, 16, { fit: "fill" }).jpeg({ quality: 85 })],
  ["jpeg-q70", (p) => p.jpeg({ quality: 70 })],
  ["webp-q80", (p) => p.webp({ quality: 80 })],
];

// Recompression and metadata stripping keep the pixels: they must resolve to
// the identical branch (original task §2.1 row two), not to the review list.
const IDENTICAL_TRANSFORMS = [
  ["png-recompress", (p) => p.png({ compressionLevel: 0 })],
  ["strip-metadata", (p) => p.toFormat("png")],
];

for (const [name, transform] of IDENTICAL_TRANSFORMS) {
  test(`identical: ${name} copy resolves to the identical branch`, async (t) => {
    const { store, sourcesDir } = await makeStore(t, `mosa-dedupe-samepix-${name}-`);
    const originalPath = await gradientFile(sourcesDir, "base.png", "horizontal");
    await importAsset(store, originalPath, { assetId: "base" });
    await drainDerivatives(store);
    const variantPath = join(sourcesDir, `variant-${name}.png`);
    await transformTo(originalPath, variantPath, transform);
    const variant = await importAsset(store, variantPath, { assetId: `variant-${name}` });
    await drainDerivatives(store);
    await markBackfillDone(store);
    const state = await store.similarCheckState("default", [variant.id]);
    assert.deepEqual(state.pending, []);
    assert.deepEqual(state.matches, []);
    assert.deepEqual(state.identical, [{ newAssetId: variant.id, existingAssetId: "base" }]);
  });
}

for (const [name, transform] of RECALL_TRANSFORMS) {
  test(`recall: ${name} copy of a library image is flagged as possible duplicate`, async (t) => {
    const { store, sourcesDir } = await makeStore(t, `mosa-dedupe-recall-${name}-`);
    const originalPath = await gradientFile(sourcesDir, "base.png", "horizontal");
    await importAsset(store, originalPath, { assetId: "base" });
    await drainDerivatives(store);
    const variantPath = join(sourcesDir, `variant-${name}.png`);
    await transformTo(originalPath, variantPath, transform);
    const variant = await importAsset(store, variantPath, { assetId: `variant-${name}` });
    await drainDerivatives(store);
    await markBackfillDone(store);
    const state = await store.similarCheckState("default", [variant.id]);
    assert.deepEqual(state.pending, []);
    assert.equal(state.identical.length, 0);
    assert.equal(state.matches.length, 1, `expected one match, got ${JSON.stringify(state.matches)}`);
    assert.equal(state.matches[0].newAssetId, variant.id);
    assert.equal(state.matches[0].existingAssetId, "base");
  });
}

test("clearer flag: bigger import against smaller library copy is clearer", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-clearer-");
  const small = await gradientFile(sourcesDir, "small.png", "horizontal", 64);
  await importAsset(store, small, { assetId: "small" });
  await drainDerivatives(store);
  const bigPath = join(sourcesDir, "big.png");
  await transformTo(small, bigPath, (p) => p.resize(128, 128, { fit: "fill" }).png());
  const big = await importAsset(store, bigPath, { assetId: "big" });
  await drainDerivatives(store);
  await markBackfillDone(store);
  const state = await store.similarCheckState("default", ["big"]);
  assert.equal(state.matches.length, 1);
  assert.equal(state.matches[0].clearer, true);

  // The mirror case: the library copy is the larger one. Horizontal
  // gradients keep their row-difference bits across sizes, so the pair stays
  // far inside the threshold; the 96px import matches no exact-size row.
  const otherBase = await gradientFile(sourcesDir, "base-large.png", "horizontal", 128);
  await importAsset(store, otherBase, { assetId: "base-large" });
  await drainDerivatives(store);
  const smallCopy = join(sourcesDir, "small-copy.png");
  await transformTo(otherBase, smallCopy, (p) => p.resize(96, 96, { fit: "fill" }).png());
  const smallAsset = await importAsset(store, smallCopy, { assetId: "small-copy" });
  await drainDerivatives(store);
  await markBackfillDone(store);
  const secondState = await store.similarCheckState("default", ["small-copy"]);
  const match = secondState.matches.find((entry) => entry.newAssetId === "small-copy");
  assert.ok(match, `expected a match for the downscaled copy: ${JSON.stringify(secondState)}`);
  assert.equal(match.clearer, false);
});

test("a new image gets at most one match: the closest candidate", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-single-");
  const base = await gradientFile(sourcesDir, "base.png", "horizontal");
  await importAsset(store, base, { assetId: "base" });
  await drainDerivatives(store);
  const halfPath = join(sourcesDir, "half.png");
  await transformTo(base, halfPath, (p) => p.resize(32, 32, { fit: "fill" }).png());
  await importAsset(store, halfPath, { assetId: "half" });
  await drainDerivatives(store);
  const quarterPath = join(sourcesDir, "quarter.png");
  await transformTo(base, quarterPath, (p) => p.resize(16, 16, { fit: "fill" }).jpeg({ quality: 85 }));
  const quarter = await importAsset(store, quarterPath, { assetId: "quarter" });
  await drainDerivatives(store);
  await markBackfillDone(store);

  const state = await store.similarCheckState("default", ["quarter"]);
  assert.equal(state.matches.length, 1);
  const [baseHash, halfHash, quarterHash] = await Promise.all([
    (async () => computePerceptualHash(await readFile(join(store.libraryDir, "assets", "default", "thumbnails", "base.webp"))))(),
    (async () => computePerceptualHash(await readFile(join(store.libraryDir, "assets", "default", "thumbnails", "half.webp"))))(),
    computePerceptualHash(await readFile(join(store.libraryDir, "assets", "default", "thumbnails", "quarter.webp"))),
  ]);
  const smallest = Math.min(
    perceptualHammingDistance(quarterHash, baseHash),
    perceptualHammingDistance(quarterHash, halfHash),
  );
  assert.equal(state.matches[0].distance, smallest);
});

test("similar pixels with a different aspect ratio are not candidates", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-ratio-");
  const square = await gradientFile(sourcesDir, "square.png", "horizontal", 64);
  await importAsset(store, square, { assetId: "square" });
  await drainDerivatives(store);
  // Same pixels squeezed to 2:1 — distance 0, but the aspect ratio drifts far
  // beyond R, so the pair never becomes a candidate.
  const stretched = join(sourcesDir, "stretched.png");
  await transformTo(square, stretched, (p) => p.resize(64, 32, { fit: "fill" }).png());
  const stretchedAsset = await importAsset(store, stretched, { assetId: "stretched" });
  await drainDerivatives(store);
  await markBackfillDone(store);
  const state = await store.similarCheckState("default", [stretchedAsset.id]);
  assert.deepEqual(state.matches, []);
  assert.deepEqual(state.identical, []);
  assert.deepEqual(state.pending, []);
});

test("same-size different-composition images are not flagged", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-negative-");
  const horizontal = await gradientFile(sourcesDir, "horizontal.png", "horizontal");
  const vertical = await gradientFile(sourcesDir, "vertical.png", "vertical");
  await importAsset(store, horizontal, { assetId: "horizontal" });
  await drainDerivatives(store);
  const verticalAsset = await importAsset(store, vertical, { assetId: "vertical" });
  await drainDerivatives(store);
  await markBackfillDone(store);
  const state = await store.similarCheckState("default", [verticalAsset.id]);
  assert.deepEqual(state.matches, []);
  assert.deepEqual(state.identical, []);
});

test("pixel-identical byte-different copy is identical; resolve trashes it with the reason", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-identical-");
  const original = await gradientFile(sourcesDir, "original.png", "horizontal");
  await importAsset(store, original, { assetId: "original" });
  await drainDerivatives(store);
  const copy = join(sourcesDir, "copy.png");
  await transformTo(original, copy, (p) => p.png({ compressionLevel: 0 })); // same pixels, different bytes
  const copyAsset = await importAsset(store, copy, { assetId: "copy" });
  await drainDerivatives(store);
  await markBackfillDone(store);
  const state = await store.similarCheckState("default", [copyAsset.id]);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.matches, []);
  assert.deepEqual(state.identical, [{ newAssetId: "copy", existingAssetId: "original" }]);
  const verdict = await store.verifyImportResolve("default", {
    kind: "trash-new", newAssetId: "copy", existingAssetId: "original", reason: "duplicate-import:identical",
  });
  assert.deepEqual(verdict, { ok: true });
  await store.deleteAsset("default", "copy", { reason: "duplicate-import:identical" });
  const trashed = await store.getAsset("default", "copy");
  assert.ok(trashed.deleted_at);
  assert.equal(trashed.trash_reason?.code, "duplicate-import:identical");
});

// ─── backfill (rework §2 and §4) ─────────────────────────────────────────────

test("backfill pages forward, terminates with unreadable thumbnails, and flags done", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-backfill-");
  for (const [index, name] of ["one", "two", "three"].entries()) {
    await importAsset(store, await pngFile(sourcesDir, `${name}.png`, index + 10), { assetId: name });
  }
  await drainDerivatives(store);
  // Simulate a pre-291 library: no hash rows yet, and one thumbnail lost.
  await withRawDatabase(store, (database) => {
    database.prepare("DELETE FROM asset_perceptual_hashes").run();
  });
  await unlink(join(store.libraryDir, "assets", "default", "thumbnails", "two.webp"));
  store.startPerceptualHashBackfill();
  await waitFor(async () => {
    const database = new Database(store.databasePath, { readonly: true });
    try {
      return Boolean(database.prepare("SELECT value FROM library_meta WHERE key = 'perceptual-hash-backfilled'").get());
    } finally {
      database.close();
    }
  }, "backfill done flag");
  assert.equal(hashRowCount(store, "one"), 1);
  assert.equal(hashRowCount(store, "three"), 1);
  assert.equal(hashRowCount(store, "two"), 0);
  const state = await store.similarCheckState("default", ["two"]);
  assert.deepEqual(state.pending, []);
  assert.deepEqual(state.unchecked, ["two"]);
});

test("while the backfill flag is missing every checked asset stays pending", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-wait-");
  const base = await gradientFile(sourcesDir, "base.png", "horizontal");
  await importAsset(store, base, { assetId: "base" });
  await drainDerivatives(store);
  const copy = join(sourcesDir, "copy.png");
  await transformTo(base, copy, (p) => p.png({ compressionLevel: 0 }));
  const copyAsset = await importAsset(store, copy, { assetId: "copy" });
  await drainDerivatives(store);
  assert.equal(hashRowCount(store, "copy"), 1);
  const state = await store.similarCheckState("default", ["copy"]);
  assert.deepEqual(state.pending, ["copy"]);
  assert.deepEqual(state.matches, []);
  await withRawDatabase(store, (database) => {
    database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('perceptual-hash-backfilled', '1', '2026-10-29T00:00:00.000Z')")
      .run();
  });
  const afterFlag = await store.similarCheckState("default", ["copy"]);
  assert.deepEqual(afterFlag.pending, []);
  assert.equal(afterFlag.identical.length, 1);
});

// ─── hash row lifecycle (original task §7.10) ───────────────────────────────

test("permanent delete removes the hash row; media replacement invalidates and recomputes it", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-lifecycle-");
  const first = await pngFile(sourcesDir, "a.png", 21);
  await importAsset(store, first, { assetId: "doomed" });
  await drainDerivatives(store);
  assert.equal(hashRowCount(store, "doomed"), 1);
  await store.deleteAsset("default", "doomed");
  await store.permanentlyDeleteAsset("default", "doomed");
  assert.equal(hashRowCount(store, "doomed"), 0);

  const second = await pngFile(sourcesDir, "b.png", 22);
  await importAsset(store, second, { assetId: "replaced" });
  await drainDerivatives(store);
  const before = hashRowCount(store, "replaced");
  assert.equal(before, 1);
  const replacement = await pngFile(sourcesDir, "c.png", 23, 96, 96);
  await store.replaceAssetMedia("default", "replaced", { imagePath: replacement });
  assert.equal(hashRowCount(store, "replaced"), 0);
  await drainDerivatives(store);
  assert.equal(hashRowCount(store, "replaced"), 1);
});

// ─── resolve verification (rework §6) ────────────────────────────────────────

test("verifyImportResolve rejects invalid, self-referencing, pixel-mismatched and smaller replacements", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-verify-");
  const base = await gradientFile(sourcesDir, "base.png", "horizontal", 100);
  await importAsset(store, base, { assetId: "base" });
  await drainDerivatives(store);
  const copy = join(sourcesDir, "copy.png");
  await transformTo(base, copy, (p) => p.png({ compressionLevel: 0 }));
  await importAsset(store, copy, { assetId: "copy" });
  await drainDerivatives(store);

  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "trash-new", newAssetId: "", existingAssetId: "base" }),
    { ok: false, code: "IMPORT_RESOLVE_INVALID" },
  );
  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "trash-new", newAssetId: "copy", existingAssetId: "copy" }),
    { ok: false, code: "IMPORT_RESOLVE_SAME_ASSET" },
  );
  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "trash-new", newAssetId: "copy", existingAssetId: "ghost" }),
    { ok: false, code: "IMPORT_RESOLVE_ASSET_MISSING" },
  );
  assert.deepEqual(
    await store.verifyImportResolve("default", {
      kind: "trash-new", newAssetId: "copy", existingAssetId: "base", reason: "duplicate-import:identical",
    }),
    { ok: true },
  );

  // Same pixel confirmation but genuinely different pixels → mismatch.
  const vertical = await gradientFile(sourcesDir, "vertical.png", "vertical", 100);
  await importAsset(store, vertical, { assetId: "vertical" });
  await drainDerivatives(store);
  assert.deepEqual(
    await store.verifyImportResolve("default", {
      kind: "trash-new", newAssetId: "vertical", existingAssetId: "base", reason: "duplicate-import:identical",
    }),
    { ok: false, code: "IMPORT_RESOLVE_PIXEL_MISMATCH" },
  );

  // replace-with-new: smaller, not similar, and unverified (no hash row).
  const smaller = join(sourcesDir, "smaller.png");
  await transformTo(base, smaller, (p) => p.resize(50, 50, { fit: "fill" }).png());
  const smallerAsset = await importAsset(store, smaller, { assetId: "smaller" });
  await drainDerivatives(store);
  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "replace-with-new", newAssetId: "smaller", existingAssetId: "base" }),
    { ok: false, code: "IMPORT_RESOLVE_NOT_LARGER" },
  );
  const unrelated = await gradientFile(sourcesDir, "unrelated.png", "vertical", 200);
  const unrelatedAsset = await importAsset(store, unrelated, { assetId: "unrelated" });
  await drainDerivatives(store);
  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "replace-with-new", newAssetId: "unrelated", existingAssetId: "base" }),
    { ok: false, code: "IMPORT_RESOLVE_NOT_SIMILAR" },
  );
  // Larger than the library copy but its derivatives have not run yet, so
  // there is no perceptual hash row to verify the distance claim with (the
  // dimensions come straight from the fixture row).
  const biggerCopy = join(sourcesDir, "bigger-copy.png");
  await transformTo(base, biggerCopy, (p) => p.resize(200, 200, { fit: "fill" }).png());
  await store.createAsset({ assetId: "bigger-no-hash", imagePath: biggerCopy }, { skipIdenticalBytes: true });
  await withRawDatabase(store, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = '{\"width\":200,\"height\":200}' WHERE id = 'bigger-no-hash'").run();
  });
  assert.deepEqual(
    await store.verifyImportResolve("default", { kind: "replace-with-new", newAssetId: "bigger-no-hash", existingAssetId: "base" }),
    { ok: false, code: "IMPORT_RESOLVE_UNVERIFIED" },
  );
  void unrelatedAsset;
});

// ─── HTTP surface: import-batch skip, similar-check, resolve orchestration ──

async function startDedupeRuntime(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());
  assert.equal(runtime.storage, "sqlite");
  const headers = { "content-type": "application/json", "x-mosa-client-token": runtime.clientToken };
  const post = (path, body) => fetch(`${runtime.url}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const stagingDir = importStagingDir(join(root, "library", "assets"));
  return { root, runtime, generated, post, headers, stagingDir };
}

async function importBatch(post, stagingDir, sourcesDir, files) {
  const items = [];
  for (const [index, file] of files.entries()) {
    const stagedPath = join(stagingDir, `staged-${index}-${file.name}`);
    await mkdir(stagingDir, { recursive: true });
    await writeFile(stagedPath, await readFile(file.path));
    items.push({ imagePath: stagedPath, fileName: file.name });
  }
  const response = await post("/api/assets/import-batch", { projectId: "default", items });
  assert.equal(response.status, 200);
  return response.json();
}

async function waitThumbnail(libraryDir, assetId) {
  await waitFor(async () => existsSync(join(libraryDir, "assets", "default", "thumbnails", `${assetId}.webp`)), `thumbnail ${assetId}`);
}

async function waitForBackfill(libraryDir) {
  await waitFor(async () => {
    const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
    try {
      return Boolean(database.prepare("SELECT value FROM library_meta WHERE key = 'perceptual-hash-backfilled'").get());
    } finally {
      database.close();
    }
  }, "backfill done flag");
}

test("import-batch returns already-in-library skips and cleans staged files", async (t) => {
  const { root, runtime, generated, post, stagingDir } = await startDedupeRuntime(t, "mosa-dedupe-http-batch-");
  const libraryDir = join(root, "library");
  const original = await gradientFile(generated, "original.png", "horizontal");
  await post("/api/assets/create", { projectId: "default", assetId: "original", imagePath: original, prompt: "p" });
  await waitThumbnail(libraryDir, "original");

  const batch = await importBatch(post, stagingDir, generated, [
    { name: "original-copy.png", path: original },
    { name: "original.png", path: original },
  ]);
  assert.equal(batch.imported, 0);
  assert.equal(batch.failed, 0);
  assert.equal(batch.alreadyInLibrary, 2);
  const skipped = batch.results.find((entry) => entry.skipped === "already-in-library");
  assert.ok(skipped, `expected a skip in ${JSON.stringify(batch.results)}`);
  assert.equal(skipped.existingAsset.id, "original");
  assert.equal(skipped.existingAsset.groupName, "");
  const stagedLeftovers = existsSync(stagingDir) ? await readdir(stagingDir) : [];
  assert.deepEqual(stagedLeftovers, []);
  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL").get().n, 1);
  } finally {
    database.close();
  }
  await runtime.stop();
});

test("resolve orchestration: identical pair trashes exactly one copy across two checks", async (t) => {
  const { root, runtime, generated, post } = await startDedupeRuntime(t, "mosa-dedupe-http-resolve-");
  const libraryDir = join(root, "library");
  const original = await gradientFile(generated, "original.png", "horizontal");
  await post("/api/assets/create", { projectId: "default", assetId: "original", imagePath: original, prompt: "p" });
  await waitThumbnail(libraryDir, "original");
  const copy = join(generated, "copy.png");
  await transformTo(original, copy, (p) => p.png({ compressionLevel: 0 }));
  await post("/api/assets/create", { projectId: "default", assetId: "copy", imagePath: copy, prompt: "p" });
  await waitThumbnail(libraryDir, "copy");

  await waitForBackfill(libraryDir);
  const checkCopy = await (await post("/api/import/similar-check", { projectId: "default", assetIds: ["copy"] })).json();
  assert.deepEqual(checkCopy.identical, [{ newAssetId: "copy", existingAssetId: "original" }]);
  const checkOriginal = await (await post("/api/import/similar-check", { projectId: "default", assetIds: ["original"] })).json();
  assert.deepEqual(checkOriginal.identical, [{ newAssetId: "original", existingAssetId: "copy" }]);

  const firstResolve = await (await post("/api/import/resolve", {
    projectId: "default",
    actions: [{ kind: "trash-new", newAssetId: "copy", existingAssetId: "original", reason: "duplicate-import:identical" }],
  })).json();
  assert.equal(firstResolve.results[0].ok, true);

  const secondResolve = await (await post("/api/import/resolve", {
    projectId: "default",
    actions: [{ kind: "trash-new", newAssetId: "original", existingAssetId: "copy", reason: "duplicate-import:identical" }],
  })).json();
  assert.equal(secondResolve.results[0].ok, false);
  assert.equal(secondResolve.results[0].code, "IMPORT_RESOLVE_ASSET_TRASHED");

  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    const trashed = database.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL").get().n;
    assert.equal(trashed, 1, "exactly one of the pixel-identical pair may land in Trash");
  } finally {
    database.close();
  }
  await runtime.stop();
});

test("overlapping identical resolves for one pair still trash exactly one copy", async (t) => {
  const { root, runtime, generated, post } = await startDedupeRuntime(t, "mosa-dedupe-http-race-");
  const libraryDir = join(root, "library");
  const original = await gradientFile(generated, "original.png", "horizontal");
  await post("/api/assets/create", { projectId: "default", assetId: "original", imagePath: original, prompt: "p" });
  await waitThumbnail(libraryDir, "original");
  const copy = join(generated, "copy.png");
  await transformTo(original, copy, (p) => p.png({ compressionLevel: 0 }));
  await post("/api/assets/create", { projectId: "default", assetId: "copy", imagePath: copy, prompt: "p" });
  await waitThumbnail(libraryDir, "copy");

  // No similar-check first: neither pixel digest is cached, so each
  // verification awaits real decodes — the widest window for interleaving.
  const [first, second] = await Promise.all([
    post("/api/import/resolve", {
      projectId: "default",
      actions: [{ kind: "trash-new", newAssetId: "copy", existingAssetId: "original", reason: "duplicate-import:identical" }],
    }).then((response) => response.json()),
    post("/api/import/resolve", {
      projectId: "default",
      actions: [{ kind: "trash-new", newAssetId: "original", existingAssetId: "copy", reason: "duplicate-import:identical" }],
    }).then((response) => response.json()),
  ]);
  const outcomes = [first.results[0], second.results[0]];
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.find((entry) => !entry.ok).code, "IMPORT_RESOLVE_ASSET_TRASHED");
  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL").get().n, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NULL").get().n, 1);
  } finally {
    database.close();
  }
  await runtime.stop();
});

test("resolve rejects a smaller replacement and a self-pair without touching anything", async (t) => {
  const { root, runtime, generated, post } = await startDedupeRuntime(t, "mosa-dedupe-http-verify-");
  const libraryDir = join(root, "library");
  const base = await gradientFile(generated, "base.png", "horizontal", 100);
  await post("/api/assets/create", { projectId: "default", assetId: "base", imagePath: base, prompt: "p" });
  await waitThumbnail(libraryDir, "base");
  const smaller = join(generated, "smaller.png");
  await transformTo(base, smaller, (p) => p.resize(50, 50, { fit: "fill" }).png());
  await post("/api/assets/create", { projectId: "default", assetId: "smaller", imagePath: smaller, prompt: "p" });
  await waitThumbnail(libraryDir, "smaller");

  const replace = await (await post("/api/import/resolve", {
    projectId: "default",
    actions: [{ kind: "replace-with-new", newAssetId: "smaller", existingAssetId: "base" }],
  })).json();
  assert.equal(replace.results[0].ok, false);
  assert.equal(replace.results[0].code, "IMPORT_RESOLVE_NOT_LARGER");

  const selfPair = await (await post("/api/import/resolve", {
    projectId: "default",
    actions: [{ kind: "trash-new", newAssetId: "base", existingAssetId: "base" }],
  })).json();
  assert.equal(selfPair.results[0].ok, false);
  assert.equal(selfPair.results[0].code, "IMPORT_RESOLVE_SAME_ASSET");

  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assets WHERE deleted_at IS NOT NULL").get().n, 0);
    assert.equal(database.prepare("SELECT content_sha256 FROM assets WHERE id = 'base'").get().content_sha256,
      database.prepare("SELECT content_sha256 FROM assets WHERE id = 'base'").get().content_sha256);
  } finally {
    database.close();
  }
  await runtime.stop();
});

test("replace-with-new keeps the library asset's curation and trashes the imported copy", async (t) => {
  const { root, runtime, generated, post, headers } = await startDedupeRuntime(t, "mosa-dedupe-http-replace-");
  const libraryDir = join(root, "library");
  const base = await gradientFile(generated, "base.png", "horizontal", 75);
  await post("/api/assets/create", { projectId: "default", assetId: "base", imagePath: base, prompt: "the original prompt" });
  await waitThumbnail(libraryDir, "base");
  // A stack needs two members: bring a small helper asset in first.
  const helper = await gradientFile(generated, "helper.png", "vertical", 40);
  await post("/api/assets/create", { projectId: "default", assetId: "helper", imagePath: helper, prompt: "helper" });
  await waitThumbnail(libraryDir, "helper");
  const stackResponse = await (await post("/api/asset-stacks", { projectId: "default", assetIds: ["base", "helper"] })).json();
  assert.ok(stackResponse.stack?.id, "stack fixture creation failed");
  await post("/api/assets/batch", { action: "group", projectId: "default", assetIds: ["base"], group: "H" });
  await post("/api/assets/batch", { action: "favorite", projectId: "default", assetIds: ["base"], favorite: true });
  const tagResponse = await fetch(`${runtime.url}/api/assets/default/base`, {
    method: "PATCH", headers, body: JSON.stringify({ tags: ["sunny"] }),
  });
  assert.equal(tagResponse.status, 200);

  const bigger = join(generated, "bigger.png");
  await transformTo(base, bigger, (p) => p.resize(150, 150, { fit: "fill" }).png());
  await post("/api/assets/create", { projectId: "default", assetId: "bigger", imagePath: bigger, prompt: "p" });
  await waitThumbnail(libraryDir, "bigger");

  const resolveResponse = await (await post("/api/import/resolve", {
    projectId: "default",
    actions: [{ kind: "replace-with-new", newAssetId: "bigger", existingAssetId: "base" }],
  })).json();
  assert.equal(resolveResponse.results[0].ok, true, `replace resolve rejected: ${JSON.stringify(resolveResponse)}`);

  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    const baseRow = database.prepare("SELECT * FROM assets WHERE id = 'base'").get();
    assert.equal(baseRow.deleted_at, null);
    assert.equal(baseRow.favorite, 1);
    assert.equal(baseRow.group_name, "H");
    assert.match(baseRow.prompt, /original prompt/);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM asset_tags WHERE asset_id = 'base'").get().n, 1, "tags must survive the replacement");
    const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE asset_id = 'base'").get();
    assert.equal(membership?.stack_id, stackResponse.stack.id);
    const biggerRow = database.prepare("SELECT deleted_at FROM assets WHERE id = 'bigger'").get();
    assert.ok(biggerRow.deleted_at, "the imported copy must not stay in the gallery");
    const snapshot = database.prepare(`
      SELECT id FROM assets
      WHERE deleted_at IS NOT NULL AND json_extract(metadata_json, '$.trash_reason.code') = 'replaced-by-better-version'
    `).get();
    assert.ok(snapshot, "the replaced media must sit in Trash as a snapshot");
  } finally {
    database.close();
  }
  await runtime.stop();
});

// ─── old code opens the new library (original task §7.13) ───────────────────

test("origin/main code opens a library carrying the new table without error", async (t) => {
  assert.ok(existsSync(join(mainCheckout, "lib", "sqlite-asset-store.mjs")), "main checkout is required for this test");
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-oldcode-");
  await importAsset(store, await pngFile(sourcesDir, "a.png", 31), { assetId: "a" });
  await drainDerivatives(store);
  store.close();
  const script = `
    import { createSqliteAssetStore } from ${JSON.stringify(join(mainCheckout, "lib", "sqlite-asset-store.mjs"))};
    const store = createSqliteAssetStore({
      projectRoot: ${JSON.stringify(join(store.libraryDir, "..", "project"))},
      managerDir: ${JSON.stringify(join(store.libraryDir, "..", "project", "mosa"))},
      libraryDir: ${JSON.stringify(store.libraryDir)},
    });
    const assets = await store.listAssets({ projectId: "default" });
    if (assets.length !== 1) throw new Error("expected 1 asset, got " + assets.length);
    store.close();
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
});

// ─── dedupe lookup cost stays negligible on large libraries ─────────────────

test("skipIdenticalBytes lookup adds no measurable cost on a 2000-asset library", async (t) => {
  const { store, sourcesDir } = await makeStore(t, "mosa-dedupe-cost-");
  // Seed rows directly: the assertion targets the dedupe lookup, not the import pipeline.
  await withRawDatabase(store, (database) => {
    const insert = database.prepare(`
      INSERT INTO assets (project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating, version_change,
        source_type, source_json, metadata_json, search_text, media_kind, source_group,
        conversation_id, generation_batch, created_at, updated_at)
      VALUES ('default', @id, @asset, @path, @hash, '', '', '', '', '{}', '', 0, 0, '', '', 0, '',
        'local-file', '{}', '{}', '', 'image', '', '', '', '2026-08-29T12:00:00.000Z', '2026-08-29T12:00:00.000Z')
    `);
    const rows = [];
    for (let index = 0; index < 2000; index += 1) {
      rows.push({
        id: `seed-${String(index).padStart(4, "0")}`,
        asset: `seed-${index}.png`,
        path: join(sourcesDir, `seed-${index}.png`),
        hash: `hash${String(index).padStart(60, "0")}`,
      });
    }
    database.transaction(() => {
      for (const row of rows) insert.run(row);
    })();
  });
  const probe = await pngFile(sourcesDir, "probe.png", 41);
  const timed = async (context) => {
    const started = process.hrtime.bigint();
    try {
      await importAsset(store, probe, { assetId: `timed-${Math.random().toString(36).slice(2, 8)}` }, context);
    } catch (error) {
      if (error.code !== "ALREADY_IN_LIBRARY") throw error;
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  let withSwitchTotal = 0;
  let withoutSwitchTotal = 0;
  const rounds = 20;
  for (let round = 0; round < rounds; round += 1) {
    withSwitchTotal += await timed({ skipIdenticalBytes: true });
    withoutSwitchTotal += await timed({});
  }
  const withSwitchAverage = withSwitchTotal / rounds;
  const withoutSwitchAverage = withoutSwitchTotal / rounds;
  assert.ok(
    withSwitchAverage - withoutSwitchAverage < 3,
    `dedupe lookup should stay under 3ms per asset (with ${withSwitchAverage.toFixed(2)}ms vs without ${withoutSwitchAverage.toFixed(2)}ms)`,
  );
});
