import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import sharp from "sharp";
import test from "node:test";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import { startMediumBackfill } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";
import { mp4Bytes } from "./helpers/managed-media.mjs";
import { MAX_DERIVATIVE_INPUT_PIXELS } from "../lib/derivative-limits.js";

// Task 383: enqueueMediumBackfill drips medium-only derivative gaps back in
// (the "startup" mode beside it deliberately leaves them alone), and the
// runtime's startMediumBackfill paces that drip: one small batch per tick,
// only while the queue holds no pending/running work, silent forever once a
// tick enqueues nothing or the stop handle fires.

// 16383 × 16383 = MAX_DERIVATIVE_INPUT_PIXELS exactly; one pixel more on each
// side crosses it.
const AT_CAP_DIMENSIONS = { width: 16383, height: 16383 };
const OVER_CAP_DIMENSIONS = { width: 16384, height: 16384 };

assert.ok(AT_CAP_DIMENSIONS.width * AT_CAP_DIMENSIONS.height === MAX_DERIVATIVE_INPUT_PIXELS, "at-cap boundary matches the real constant");
assert.ok(OVER_CAP_DIMENSIONS.width * OVER_CAP_DIMENSIONS.height > MAX_DERIVATIVE_INPUT_PIXELS, "over-cap boundary crosses the real constant");

async function createLibrary(t, datedAssets) {
  const root = await mkdtemp(join(tmpdir(), "mosa-medium-backfill-"));
  const libraryDir = join(root, "library");
  await mkdir(join(root, "generated-images"), { recursive: true });
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => store.close());
  t.after(() => removeTestPath(root, { recursive: true, force: true }));

  for (const [assetId, createdAt] of datedAssets) {
    const imagePath = join(root, "generated-images", `${assetId}.png`);
    await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 16 * (assetId.length % 8), g: 32, b: 64 } } })
      .png()
      .toFile(imagePath);
    await store.createAsset({ assetId, imagePath, prompt: `medium backfill ${assetId}`, created_at: createdAt });
  }
  return { root, libraryDir, store };
}

// Bring assets to the "old image" state the task describes: the original
// three-tier run completed, then the medium column went empty (what a
// library that predates mediums looks like). Draining first matters — a
// fresh asset's own pending job would otherwise keep it out of the scan.
async function ageToMediumGap(store, libraryDir, assetIds) {
  await drainDerivativeJobs(store);
  editLibraryRows(libraryDir, (database) => {
    database.prepare(`UPDATE assets SET medium_path = NULL WHERE id IN (${assetIds.map(() => "?").join(", ")})`)
      .run(...assetIds);
  });
}

function editLibraryRows(libraryDir, run) {
  // A second connection is the only way to null the derivative columns: they
  // are written by the worker, not by updateMetadata (same reasoning as
  // derivative-enqueue.test.mjs).
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

// Task rule: every library-touching test ends with integrity_check = ok.
function assertLibraryIntegrity(libraryDir) {
  const database = new Database(sqliteDatabasePath(libraryDir), { readonly: true });
  try {
    assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    database.close();
  }
}

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

// A pacer-under-test wrapper: real store underneath, calls counted on top.
// statusCalls doubles as the tick heartbeat — every tick queries it, with or
// without the busy check, so the busy-window assertions wait for PROOF the
// pacer ticked instead of a fixed sleep that load can outpace.
function countedStore(store, calls, statusCalls = []) {
  const wrapped = Object.create(store);
  wrapped.enqueueMediumBackfill = async (options) => {
    calls.push(options?.limit);
    return store.enqueueMediumBackfill(options);
  };
  wrapped.derivativeStatus = async (...args) => {
    statusCalls.push(1);
    return store.derivativeStatus(...args);
  };
  return wrapped;
}

test("enqueueMediumBackfill enqueues an in-use image missing only its medium, with the asset's created_at on the job", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [["old", "2026-08-01T00:00:00.000Z"]]);
  await ageToMediumGap(store, libraryDir, ["old"]);

  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 1);
  const rows = jobRows(libraryDir, "asset_id = ?", "old");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "pending");
  const asset = await store.getAsset("default", "old");
  assert.equal(rows[0].created_at, asset.created_at, "the job carries the asset's created_at, not now()");
  // A second call sees the pending row and does not queue a duplicate.
  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 0, "already-pending rows are skipped");
  assertLibraryIntegrity(libraryDir);
});

test("trashed, video, thumbnail-less, failed-3, over-cap and archived assets are never enqueued", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["inuse", "2026-08-05T00:00:00.000Z"],
    ["trashed", "2026-08-04T00:00:00.000Z"],
    ["nothumb", "2026-08-02T00:00:00.000Z"],
    ["failed3", "2026-08-01T00:00:00.000Z"],
    ["overcap", "2026-07-31T00:00:00.000Z"],
    ["archived", "2026-07-30T00:00:00.000Z"],
  ]);
  await ageToMediumGap(store, libraryDir, ["inuse", "trashed", "nothumb", "failed3", "overcap", "archived"]);

  // A video with thumbnail/preview recorded and medium missing would look
  // eligible on the columns alone — the media kind must exclude it.
  const videoPath = join(store.projectRoot, "generated-images", "clip.mp4");
  await writeFile(videoPath, mp4Bytes());
  await store.createAsset({ assetId: "clip", imagePath: videoPath, prompt: "video", created_at: "2026-08-06T00:00:00.000Z" });
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET thumbnail_path = 'seeded.webp', preview_path = 'seeded.webp', medium_path = NULL WHERE id = 'clip'").run();
  });

  await store.deleteAsset("default", "trashed");
  await store.archiveAsset("default", "archived");
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET thumbnail_path = NULL, medium_path = NULL WHERE id = 'nothumb'").run();
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.width', ?, '$.height', ?) WHERE id = 'overcap'")
      .run(OVER_CAP_DIMENSIONS.width, OVER_CAP_DIMENSIONS.height);
    database.prepare("UPDATE derivative_jobs SET status = 'failed', attempts = 3, updated_at = '2000-01-01T00:00:00.000Z' WHERE asset_id = 'failed3'").run();
  });

  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 1, "only the plain in-use gap qualifies");
  const pending = jobRows(libraryDir, "status = 'pending'");
  assert.deepEqual(pending.map((row) => row.asset_id), ["inuse"]);
  // failed-3 is a hard stop; failed-1 still gets a (reset) try, like the
  // claim path's own retry policy.
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE derivative_jobs SET status = 'failed', attempts = 1, updated_at = '2000-01-01T00:00:00.000Z' WHERE asset_id = 'failed3'").run();
  });
  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 1, "a failure under the attempt cap is re-queued");
  const again = jobRows(libraryDir, "asset_id = ?", "failed3");
  assert.equal(again[0].status, "pending");
  assertLibraryIntegrity(libraryDir);
});

test("width × height at MAX_DERIVATIVE_INPUT_PIXELS qualifies; one pixel more does not; missing dimensions are not excluded", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["atcap", "2026-08-03T00:00:00.000Z"],
    ["overcap", "2026-08-02T00:00:00.000Z"],
    ["nodims", "2026-08-01T00:00:00.000Z"],
  ]);
  await ageToMediumGap(store, libraryDir, ["atcap", "overcap", "nodims"]);
  editLibraryRows(libraryDir, (database) => {
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.width', ?, '$.height', ?) WHERE id = 'atcap'")
      .run(AT_CAP_DIMENSIONS.width, AT_CAP_DIMENSIONS.height);
    database.prepare("UPDATE assets SET business_fields_json = json_set(business_fields_json, '$.width', ?, '$.height', ?) WHERE id = 'overcap'")
      .run(OVER_CAP_DIMENSIONS.width, OVER_CAP_DIMENSIONS.height);
    database.prepare("UPDATE assets SET business_fields_json = json_remove(business_fields_json, '$.width', '$.height') WHERE id = 'nodims'").run();
  });

  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 2, "the over-cap row is excluded, missing dimensions are not");
  const pending = jobRows(libraryDir, "status = 'pending'");
  assert.deepEqual(pending.map((row) => row.asset_id), ["atcap", "nodims"], "newest created_at first");
  assertLibraryIntegrity(libraryDir);
});

test("limit takes the newest eligible assets first", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["a1", "2026-08-01T00:00:00.000Z"],
    ["a2", "2026-08-02T00:00:00.000Z"],
    ["a3", "2026-08-03T00:00:00.000Z"],
    ["a4", "2026-08-04T00:00:00.000Z"],
    ["a5", "2026-08-05T00:00:00.000Z"],
  ]);
  await ageToMediumGap(store, libraryDir, ["a1", "a2", "a3", "a4", "a5"]);

  assert.equal(await store.enqueueMediumBackfill({ limit: 2 }), 2);
  const pending = jobRows(libraryDir, "status = 'pending'");
  assert.deepEqual(pending.map((row) => row.asset_id), ["a5", "a4"], "only the two newest, in created_at order");
  assertLibraryIntegrity(libraryDir);
});

test("a freshly imported asset claims ahead of a backfilled old asset", async (t) => {
  const { store, libraryDir, root } = await createLibrary(t, [["old", "2026-08-01T00:00:00.000Z"]]);
  await ageToMediumGap(store, libraryDir, ["old"]);

  // Import the fresh asset FIRST and enqueue the backfill AFTER it: the
  // invariant under test is that a backfill queued at any time still claims
  // behind an import — which only holds while the backfill job carries the
  // asset's own created_at instead of its enqueue time.
  const freshPath = join(root, "generated-images", "fresh.png");
  await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 96, g: 74, b: 155 } } })
    .png()
    .toFile(freshPath);
  await store.createAsset({ assetId: "fresh", imagePath: freshPath, prompt: "fresh import" });

  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 1, "the old gap is queued with created_at 2026-08-01");
  const queued = jobRows(libraryDir, "asset_id = ?", "old");
  assert.equal(queued[0].created_at, "2026-08-01T00:00:00.000Z", "the backfill job keeps the asset's created_at");

  const first = await store.claimDerivativeJob();
  assert.equal(first.asset_id, "fresh", "the new import's job (created_at now) claims first");
  const second = await store.claimDerivativeJob();
  assert.equal(second.asset_id, "old");
  assert.equal(await store.claimDerivativeJob(), null);
  assertLibraryIntegrity(libraryDir);
});

test("a real worker run completes a medium backfill and the asset stops being eligible", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [["old", "2026-08-01T00:00:00.000Z"]]);
  await ageToMediumGap(store, libraryDir, ["old"]);

  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 1);
  const processor = createDerivativeProcessor();
  t.after(() => processor.close());
  for (let job = await store.claimDerivativeJob(); job; job = await store.claimDerivativeJob()) {
    const outcome = await processDerivativeJob(store, job, { processor });
    assert.equal(outcome.ok, true, `the real processor must succeed: ${outcome.error || ""}`);
  }
  const asset = await store.getAsset("default", "old");
  assert.ok(asset.medium_path, "medium_path is recorded after the run");
  await assert.ok(stat(asset.medium_path).then(() => true, () => false), "the medium file exists on disk");
  assert.equal(await store.enqueueMediumBackfill({ limit: 8 }), 0, "the backfilled asset is no longer a gap");
  assertLibraryIntegrity(libraryDir);
});

test("the pacer holds off while the queue has pending work, then drips a batch once it drains", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [
    ["busy", "2026-08-02T00:00:00.000Z"],
    ["waiting", "2026-08-01T00:00:00.000Z"],
  ]);
  await ageToMediumGap(store, libraryDir, ["busy", "waiting"]);

  // Queue busy: one of the two gaps is queued as a plain pending job.
  assert.equal(await store.enqueueMediumBackfill({ limit: 1 }), 1, "busy is queued first (newest created_at)");

  const calls = [];
  const ticks = [];
  const stop = startMediumBackfill(countedStore(store, calls, ticks), { intervalMs: 40, batchLimit: 2 });
  t.after(() => stop());

  // The pacer demonstrably ticks while the queue is busy — and must not
  // enqueue during any of those ticks (a fixed sleep here once raced a slow
  // first tick and passed vacuously).
  await waitFor(() => ticks.length >= 3, "three busy-window ticks");
  assert.equal(calls.length, 0, "no tick enqueues while the queue holds pending work");

  // Drain the queue for real (writes all three tiers for "busy"); "waiting"
  // is still a medium-only gap.
  await drainDerivativeJobs(store);
  await waitFor(() => calls.length >= 1, "the first batch after the queue drained");
  const pending = await waitFor(async () => {
    const rows = jobRows(libraryDir, "status = 'pending'");
    return rows.length === 1 ? rows : null;
  }, "waiting becomes the only pending job");
  assert.deepEqual(pending.map((row) => row.asset_id), ["waiting"]);
  assertLibraryIntegrity(libraryDir);
});

test("a tick that enqueues nothing ends this launch's backfill", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [["complete", "2026-08-01T00:00:00.000Z"]]);
  // Fully drained (createAsset leaves its own pending job), medium intact:
  // nothing is a medium-only gap, so the very first tick gets 0 back and
  // must stop looking for this launch.
  await drainDerivativeJobs(store);
  const calls = [];
  const stop = startMediumBackfill(countedStore(store, calls), { intervalMs: 30, batchLimit: 2 });
  t.after(() => stop());

  await waitFor(() => calls.length >= 1, "the first (empty) tick");
  await sleep(180);
  assert.equal(calls.length, 1, "no further ticks after a batch of 0");
  assertLibraryIntegrity(libraryDir);
});

test("stop() clears the timer: no ticks fire afterwards", async (t) => {
  const { store, libraryDir } = await createLibrary(t, [["gap", "2026-08-01T00:00:00.000Z"]]);
  await ageToMediumGap(store, libraryDir, ["gap"]);
  const calls = [];
  const stop = startMediumBackfill(countedStore(store, calls), { intervalMs: 30, batchLimit: 2 });
  await waitFor(() => calls.length >= 1, "the first tick");
  stop();
  const countAtStop = calls.length;
  await sleep(150);
  assert.equal(calls.length, countAtStop, "stop() silenced the chain");
  assertLibraryIntegrity(libraryDir);
});

test("a store without enqueueMediumBackfill (JSON backend) makes the pacer a no-op", async (t) => {
  const stop = startMediumBackfill({}, { intervalMs: 20 });
  await sleep(80); // would have ticked ~4 times with a real store
  stop();
});
