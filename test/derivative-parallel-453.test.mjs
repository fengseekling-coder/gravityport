import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import sharp from "sharp";
// Namespace import on purpose: task 453 runs this file once against the
// pre-fix code (commit A), where lib/derivative-limits.js does not yet export
// derivativeTiersRunInParallel — a named import would fail the whole module
// there, and the orphan-temp test below must still be able to run.
import * as derivativeLimits from "../lib/derivative-limits.js";
import { isDerivativeTempFileName } from "../lib/derivative-temp-file.js";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const shasum = promisify(execFile);

// Directory write permission is only enforceable on POSIX; running as root
// bypasses it even there.
const CHMOD_INJECTION_UNAVAILABLE = process.platform === "win32"
  || (typeof process.getuid === "function" && process.getuid() === 0);

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
    async isAssetActive() { return true; },
  };
}

async function makeJob(root, id, { originalPath, width = 2048, height = 1536 } = {}) {
  if (!originalPath) {
    originalPath = join(root, `${id}.png`);
    await sharp({ create: { width, height, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toFile(originalPath);
  }
  const directories = {
    previews: join(root, "previews"),
    mediums: join(root, "mediums"),
    thumbnails: join(root, "thumbnails"),
  };
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  return {
    project_id: "default",
    asset_id: id,
    original_path: originalPath,
    previewPath: join(directories.previews, `${id}.webp`),
    mediumPath: join(directories.mediums, `${id}.webp`),
    thumbnailPath: join(directories.thumbnails, `${id}.webp`),
  };
}

async function seedOldDerivatives(job) {
  await Promise.all([
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } } }).webp().toFile(job.thumbnailPath),
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 200, b: 10 } } }).webp().toFile(job.mediumPath),
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 10, b: 200 } } }).webp().toFile(job.previewPath),
  ]);
}

function derivativeDirectories(job) {
  return [dirname(job.thumbnailPath), dirname(job.mediumPath), dirname(job.previewPath)];
}

test("derivativeTiersRunInParallel allows positive finite images up to 40MP and refuses the rest", () => {
  const run = derivativeLimits.derivativeTiersRunInParallel;
  assert.equal(typeof run, "function");
  assert.equal(run(2048, 2048), true);
  assert.equal(run(8000, 5000), true, "exactly 40,000,000 pixels stays parallel");
  assert.equal(run(8000, 5001), false, "one pixel over the cap must fall back to sequential");
  assert.equal(run(0, 100), false);
  assert.equal(run(NaN, 100), false);
  assert.equal(run(100, undefined), false);
});

test("a 2048x1536 image produces all three tiers with long edges 1600/960/400", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-parallel-ok-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const job = await makeJob(root, "parallel-ok");
  const result = await processDerivativeJob(fakeStore(), job);

  assert.equal(result.ok, true);
  for (const [finalPath, longEdge] of [
    [job.previewPath, 1600],
    [job.mediumPath, 960],
    [job.thumbnailPath, 400],
  ]) {
    assert.equal((await stat(finalPath)).isFile(), true, `${finalPath} must exist`);
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp", `${finalPath} must be a decodable webp`);
    assert.equal(Math.max(metadata.width, metadata.height), longEdge, `${finalPath} long edge must be ${longEdge}`);
  }
});

test("an orientation-6 JPEG produces portrait tiers and reports swapped dimensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-parallel-orient-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = join(root, "oriented.jpg");
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 120, g: 40, b: 160 } } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(originalPath);
  const job = await makeJob(root, "parallel-orient", { originalPath });
  const result = await processDerivativeJob(fakeStore(), job);

  assert.equal(result.ok, true);
  assert.deepEqual([result.width, result.height], [800, 1200]);
  for (const finalPath of [job.previewPath, job.mediumPath, job.thumbnailPath]) {
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp", `${finalPath} must be a decodable webp`);
    assert.ok(metadata.height > metadata.width, `${finalPath} must be portrait after auto-orient (${metadata.width}x${metadata.height})`);
  }
});

test("an image just over the pixel cap still produces all three tiers (sequential path)", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-parallel-cap-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = join(root, "over-cap.png");
  // Flat color keeps the 40MP PNG tiny so the test stays fast; the cap path
  // only depends on pixel count, not content.
  await sharp({ create: { width: 8000, height: 5001, channels: 3, background: { r: 12, g: 120, b: 60 } } })
    .png()
    .toFile(originalPath);
  const job = await makeJob(root, "parallel-cap", { originalPath });
  const result = await processDerivativeJob(fakeStore(), job);

  assert.equal(result.ok, true);
  for (const [finalPath, longEdge] of [
    [job.previewPath, 1600],
    [job.mediumPath, 960],
    [job.thumbnailPath, 400],
  ]) {
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp", `${finalPath} must be a decodable webp`);
    assert.equal(Math.max(metadata.width, metadata.height), longEdge, `${finalPath} long edge must be ${longEdge}`);
  }
});

test("a failing tier waits for the others and leaves no orphan temp files", { skip: CHMOD_INJECTION_UNAVAILABLE && "chmod cannot make a directory unwritable here" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-parallel-orphan-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const job = await makeJob(root, "parallel-orphan");
  await seedOldDerivatives(job);
  const directories = derivativeDirectories(job);

  const beforeLines = (await shasum("shasum", ["-a", "256", job.thumbnailPath, job.mediumPath, job.previewPath])).stdout;
  t.diagnostic(`old finals before the failed run:\n${beforeLines.trim()}`);

  // The medium directory becomes read-only, so the middle tier's temp write
  // fails with EACCES while the other two tiers keep writing their own temps.
  await chmod(dirname(job.mediumPath), 0o555);
  try {
    const result = await processDerivativeJob(fakeStore(), job);
    assert.equal(result.ok, false);
    // sharp wraps the raw fs error, so the message carries the strerror text
    // rather than the EACCES code.
    assert.match(String(result.error), /Permission denied/i);

    for (const directory of directories) {
      const names = await readdir(directory);
      assert.deepEqual(
        names.filter((name) => isDerivativeTempFileName(name)),
        [],
        `${directory} must not contain temp files after the failure`,
      );
    }
    const afterLines = (await shasum("shasum", ["-a", "256", job.thumbnailPath, job.mediumPath, job.previewPath])).stdout;
    t.diagnostic(`old finals after the failed run:\n${afterLines.trim()}`);
    assert.equal(afterLines.trim(), beforeLines.trim(), "old finals must stay byte-identical");
  } finally {
    await chmod(dirname(job.mediumPath), 0o755);
  }
});
