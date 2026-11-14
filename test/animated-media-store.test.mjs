import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import zlib from "node:zlib";
import Database from "better-sqlite3";
import sharp from "sharp";
import { startMediumBackfill } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { mp4Bytes } from "./helpers/managed-media.mjs";

// Task 412: completeDerivativeJob stamps the animation flag into
// business_fields (never into search), and enqueueAnimationBackfill drips
// old GIF/WebP/APNG/AVIF rows through the same derivative queue once the
// medium backfill (task 383) has drained.

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

function minimalApng({ width = 32, height = 24, frames = 2 } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames, 0);
  const fctl = (seq) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(seq, 0);
    data.writeUInt32BE(width, 4);
    data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  const raw = (color) => {
    const stride = 1 + width * 3;
    const frame = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y += 1) {
      frame[y * stride] = 0;
      for (let x = 0; x < width; x += 1) {
        frame[y * stride + 1 + x * 3] = color[0];
        frame[y * stride + 2 + x * 3] = color[1];
        frame[y * stride + 3 + x * 3] = color[2];
      }
    }
    return zlib.deflateSync(frame);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("acTL", actl),
    fctl(0),
    pngChunk("IDAT", raw([255, 40, 40])),
    fctl(1),
    pngChunk("IDAT", raw([40, 40, 255])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function avisAvif() {
  const red = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 255, g: 40, b: 40 } } }).png().toBuffer();
  const blue = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 40, g: 40, b: 255 } } }).png().toBuffer();
  const avif = await sharp([red, blue], { join: { animated: true } }).avif().toBuffer();
  const patched = Buffer.from(avif);
  const boxSize = avif.readUInt32BE(0);
  for (let offset = 16; offset + 4 <= boxSize; offset += 4) {
    if (patched.subarray(offset, offset + 4).toString("latin1") === "miaf") {
      patched.write("avis", offset, "latin1");
      return patched;
    }
  }
  throw new Error("no compatible brand to patch with avis");
}

async function createLibrary(t, assets) {
  const root = await mkdtemp(join(tmpdir(), "mosa-animated-store-"));
  const libraryDir = join(root, "library");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => store.close());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));

  for (const [assetId, createdAt, makeFile] of assets) {
    const imagePath = join(root, "generated-images", `${assetId}${makeFile.extension}`);
    await writeFile(imagePath, await makeFile.bytes());
    await store.createAsset({ assetId, imagePath, prompt: `animated store ${assetId}`, created_at: createdAt });
  }
  return { root, libraryDir, store };
}

// Old libraries have completed derivative runs that predate the flag: drain
// with width/height only, so business_fields carries no $.animated.
async function drainDerivativeJobs(store) {
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    await store.completeDerivativeJob(job, {
      width: 32,
      height: 24,
      previewPath: job.previewPath,
      mediumPath: job.mediumPath,
      thumbnailPath: job.thumbnailPath,
    });
  }
}

// One more full job run for the asset: rebuild-mode enqueue, claim, complete
// with the given result.
async function runOneDerivativeJob(store, result) {
  await store.enqueueMissingDerivatives({ mode: "rebuild" });
  const job = await store.claimDerivativeJob();
  await store.completeDerivativeJob(job, {
    previewPath: job.previewPath,
    mediumPath: job.mediumPath,
    thumbnailPath: job.thumbnailPath,
    ...result,
  });
}

function editLibraryRows(libraryDir, run) {
  const database = new Database(sqliteDatabasePath(libraryDir));
  try {
    run(database);
  } finally {
    database.close();
  }
}

function jobRows(libraryDir, where = "1=1", ...params) {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    return database.prepare(`SELECT * FROM derivative_jobs WHERE ${where} ORDER BY created_at DESC, rowid DESC`).all(...params);
  } finally {
    database.close();
  }
}

async function businessFieldsOf(store, assetId) {
  const asset = await store.getAsset("default", assetId);
  return asset.business_fields || {};
}

// Task rule: every library-touching test ends with integrity_check = ok.
function assertLibraryIntegrity(libraryDir) {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    database.close();
  }
}

const GIF = { extension: ".gif", bytes: async () => sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 200, g: 10, b: 10 } } }).gif().toBuffer() };
const WEBP = { extension: ".webp", bytes: async () => sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 200, b: 10 } } }).webp().toBuffer() };
const APNG = { extension: ".apng", bytes: async () => minimalApng() };
const AVIF = { extension: ".avif", bytes: avisAvif };
const PNG = { extension: ".png", bytes: async () => sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 10, b: 200 } } }).png().toBuffer() };
const JPG = { extension: ".jpg", bytes: async () => sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 96, g: 74, b: 155 } } }).jpeg().toBuffer() };
const VIDEO = { extension: ".mp4", bytes: async () => mp4Bytes() };

test("completeDerivativeJob stamps animated/frame_count, keeps them out of search, and leaves them alone without the flag", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["flagme", "2026-08-01T00:00:00.000Z", GIF],
  ]);
  await drainDerivativeJobs(store);

  // Old run: no flag keys at all.
  const before = await businessFieldsOf(store, "flagme");
  assert.equal("animated" in before, false);
  assert.equal("frame_count" in before, false);

  await runOneDerivativeJob(store, { width: 60, height: 40, animated: true, frameCount: 2 });
  const flagged = await businessFieldsOf(store, "flagme");
  assert.equal(flagged.animated, true);
  assert.equal(flagged.frame_count, 2);

  // frame_count only lands on a positive integer: null (AVIF), 0 and a
  // fraction are all refused while animated still writes — and a refused
  // value never touches the frame_count the earlier run wrote.
  for (const frameCount of [null, 0, 1.5]) {
    await runOneDerivativeJob(store, { width: 60, height: 40, animated: true, frameCount });
    const fields = await businessFieldsOf(store, "flagme");
    assert.equal(fields.animated, true);
    assert.equal(fields.frame_count, 2, `frame_count ${frameCount} must leave the stored key untouched`);
  }

  // animated: false is a real value and writes over the old true.
  await runOneDerivativeJob(store, { width: 60, height: 40, animated: false });
  assert.equal((await businessFieldsOf(store, "flagme")).animated, false);

  // A result without `animated` (older processors, error completions) leaves
  // both keys untouched — the previously stored values simply persist.
  await runOneDerivativeJob(store, { width: 61, height: 41 });
  const untouched = await businessFieldsOf(store, "flagme");
  assert.equal(untouched.animated, false, "the old flag value stays");
  assert.equal(untouched.frame_count, 2, "the old frame_count stays");

  // The flag never joins the searchable business fields: searching for its
  // value finds nothing, while a prompt word does.
  const trueHits = await store.listAssets({ projectId: "default", query: "true" });
  assert.deepEqual(trueHits.map((entry) => entry.id), [], "searching 'true' must not surface animated assets");
  const frameHits = await store.listAssets({ projectId: "default", query: "2" });
  assert.deepEqual(frameHits.map((entry) => entry.id), [], "searching the frame count must not surface the asset either");
  const promptHits = await store.listAssets({ projectId: "default", query: "flagme" });
  assert.deepEqual(promptHits.map((entry) => entry.id), ["flagme"], "positive control: the search does find the asset by prompt");
  assertLibraryIntegrity(libraryDir);
});

test("enqueueAnimationBackfill picks GIF/WebP/APNG/AVIF without the flag and skips png/jpg/video, flagged rows, failed-3 rows and duplicates", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["a-gif", "2026-08-10T00:00:00.000Z", GIF],
    ["b-webp", "2026-08-09T00:00:00.000Z", WEBP],
    ["c-apng", "2026-08-08T00:00:00.000Z", APNG],
    ["d-avif", "2026-08-07T00:00:00.000Z", AVIF],
    ["e-png", "2026-08-06T00:00:00.000Z", PNG],
    ["f-jpg", "2026-08-05T00:00:00.000Z", JPG],
    ["g-clip", "2026-08-04T00:00:00.000Z", VIDEO],
  ]);
  await drainDerivativeJobs(store);

  // Already flagged: a GIF whose run stamped the flag is never re-queued.
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.animated', json('true')) WHERE id = 'a-gif'").run();
  });
  // A stuck failure (attempts >= 3) is a hard stop, like the medium backfill.
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE derivative_jobs SET status = 'failed', attempts = 3, updated_at = '2000-01-01T00:00:00.000Z' WHERE asset_id = 'b-webp'").run();
  });

  assert.equal(await store.enqueueAnimationBackfill({ limit: 8 }), 2, "only c-apng and d-avif qualify");
  const pending = jobRows(libraryDir, "status = 'pending'");
  assert.deepEqual(pending.map((row) => row.asset_id), ["c-apng", "d-avif"], "newest created_at first");
  const apngRow = pending.find((row) => row.asset_id === "c-apng");
  const asset = await store.getAsset("default", "c-apng");
  assert.equal(apngRow.created_at, asset.created_at, "the job carries the asset's created_at, not now()");

  // A pending row is not queued twice.
  assert.equal(await store.enqueueAnimationBackfill({ limit: 8 }), 0, "already-pending rows are skipped");

  // A failure under the attempt cap still gets a reset try.
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE derivative_jobs SET status = 'failed', attempts = 1, updated_at = '2000-01-01T00:00:00.000Z' WHERE asset_id = 'b-webp'").run();
  });
  assert.equal(await store.enqueueAnimationBackfill({ limit: 8 }), 1, "failed-1 webp re-queues");
  assert.deepEqual(jobRows(libraryDir, "asset_id = ?", "b-webp").map((row) => row.status), ["pending"]);

  // limit takes the newest eligible rows first: the unflagged webp (08-09)
  // now outranks the apng (08-08).
  editLibraryRows(libraryDir, (database) => {
    database.prepare("DELETE FROM derivative_jobs").run();
  });
  assert.equal(await store.enqueueAnimationBackfill({ limit: 1 }), 1);
  assert.deepEqual(jobRows(libraryDir, "status = 'pending'").map((row) => row.asset_id), ["b-webp"]);
  assertLibraryIntegrity(libraryDir);
});

test(".png rows are never picked even when unflagged, and a flagged APNG is not re-queued", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["png-old", "2026-08-02T00:00:00.000Z", PNG],
    ["apng-flagged", "2026-08-01T00:00:00.000Z", APNG],
  ]);
  await drainDerivativeJobs(store);
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.animated', json('true')) WHERE id = 'apng-flagged'").run();
  });
  assert.equal(await store.enqueueAnimationBackfill({ limit: 8 }), 0, ".png stays out of the backfill even when unflagged");
  assertLibraryIntegrity(libraryDir);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

// Pacer-under-test wrapper: real store underneath, calls counted on top.
// statusCalls is the tick heartbeat (every tick queries the status).
function countedStore(store, calls, statusCalls = []) {
  const wrapped = Object.create(store);
  wrapped.enqueueMediumBackfill = async (options) => {
    calls.medium.push(options?.limit);
    return store.enqueueMediumBackfill(options);
  };
  wrapped.enqueueAnimationBackfill = async (options) => {
    calls.animation.push(options?.limit);
    return store.enqueueAnimationBackfill(options);
  };
  wrapped.derivativeStatus = async (...args) => {
    statusCalls.push(1);
    return store.derivativeStatus(...args);
  };
  return wrapped;
}

test("the pacer runs the animation backfill once medium gaps drain, and ends the launch when both return 0", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["flag-later", "2026-08-01T00:00:00.000Z", GIF],
  ]);
  await drainDerivativeJobs(store);
  // A GIF missing its medium (medium-only gap) must be re-derived first; the
  // animation drip only starts after the medium scan returns 0.
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET medium_path = NULL WHERE id = 'flag-later'").run();
  });

  const calls = { medium: [], animation: [] };
  const ticks = [];
  const stop = startMediumBackfill(countedStore(store, calls, ticks), { intervalMs: 40, batchLimit: 2 });
  t.after(() => stop());

  await waitFor(() => calls.medium.length >= 1, "the first medium batch");
  assert.deepEqual(calls.animation, [], "no animation call while medium gaps remain");
  assert.deepEqual(jobRows(libraryDir, "status = 'pending'").map((row) => row.asset_id), ["flag-later"], "the medium gap queued first");

  // Drain the queued job (the completion carries no flag — old-run shape);
  // the next tick finds no medium gap, calls the animation scan and queues
  // the same asset again for its flag.
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    await store.completeDerivativeJob(job, {
      width: 32, height: 24, previewPath: job.previewPath, mediumPath: job.mediumPath, thumbnailPath: job.thumbnailPath,
    });
  }
  await waitFor(() => calls.animation.length >= 1, "the animation batch after medium drained");
  await waitFor(() => jobRows(libraryDir, "status = 'pending'").length === 1, "the gif re-queued for its animation flag");

  // Drain again with a flag-carrying result: both scans now return 0 and the
  // closing tick ends this launch's backfill for good.
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    await store.completeDerivativeJob(job, {
      width: 32, height: 24, previewPath: job.previewPath, mediumPath: job.mediumPath, thumbnailPath: job.thumbnailPath,
      animated: true, frameCount: 2,
    });
  }
  assert.equal((await businessFieldsOf(store, "flag-later")).animated, true, "the re-run stamped the flag");
  await waitFor(() => calls.animation.length >= 2, "the closing tick ran both scans");
  await sleep(250);
  // The closing tick queries medium first (its 3rd call), then animation once
  // more (2nd): both return 0 and the chain stops for this launch.
  assert.equal(calls.medium.length, 3, "no tick after both scans returned 0 (medium)");
  assert.equal(calls.animation.length, 2, "no tick after both scans returned 0 (animation)");
  assertLibraryIntegrity(libraryDir);
});

test("a store without enqueueAnimationBackfill skips the animation drip without erroring", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["plain", "2026-08-01T00:00:00.000Z", PNG],
  ]);
  await drainDerivativeJobs(store);
  // A JSON-shaped store: only the methods startMediumBackfill already knew.
  const calls = { medium: [], animation: [] };
  const ticks = [];
  const jsonShapedStore = {
    derivativeStatus: async (...args) => {
      ticks.push(1);
      return store.derivativeStatus(...args);
    },
    enqueueMediumBackfill: async (options) => {
      calls.medium.push(options?.limit);
      return store.enqueueMediumBackfill(options);
    },
  };
  const stop = startMediumBackfill(jsonShapedStore, { intervalMs: 30, batchLimit: 2 });
  t.after(() => stop());
  await waitFor(() => ticks.length >= 1, "the first tick");
  await sleep(200);
  assert.equal(calls.animation.length, 0, "the animation scan never ran (and could not)");
  assert.equal(calls.medium.length, 1, "the launch ended after the medium scan returned 0");
  assertLibraryIntegrity(libraryDir);
});

test("stop() silences the animation drip like the rest of the pacer", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["stopme", "2026-08-01T00:00:00.000Z", GIF],
  ]);
  await drainDerivativeJobs(store);
  const calls = { medium: [], animation: [] };
  const ticks = [];
  const stop = startMediumBackfill(countedStore(store, calls, ticks), { intervalMs: 30, batchLimit: 2 });
  await waitFor(() => calls.animation.length >= 1, "the first animation batch");
  stop();
  const countAtStop = calls.animation.length;
  await sleep(150);
  assert.equal(calls.animation.length, countAtStop, "stop() silenced the chain");
  assertLibraryIntegrity(libraryDir);
});
