import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import sharp from "sharp";
import {
  createImageDecodeClient,
  IMAGE_DECODER_CRASHED,
  IMAGE_DECODER_TIMEOUT,
} from "../lib/image-decode-client.js";
import {
  encodeVideoPosterOp,
  metadataOp,
  paletteOp,
  perceptualHashOp,
  pixelDigestOp,
} from "../lib/image-decode-ops.js";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { safePixelDigest } from "../lib/image-pixel-hash.js";
import { runStartupShutdownExit, STARTUP_SHUTDOWN_TIMEOUT_MS } from "../desktop/startup-shutdown.mjs";
import { deferTestPathRemoval, removeTestPath } from "./test-cleanup.mjs";

const CRASH_WORKER = fileURLToPath(new URL("./fixtures/image-decode-crash-worker.mjs", import.meta.url));
const SILENT_WORKER = fileURLToPath(new URL("./fixtures/image-decode-silent-worker.mjs", import.meta.url));

// Task 341 fixtures: no committed JPEG/WebP assets exist, so they are encoded
// here once per run (sharp determinism: identical inputs, identical bytes).
// The JPEG is a real diagonal gradient built from raw pixels.
async function writeFixtures(root) {
  const pngPath = join(root, "solid-64x48.png");
  const jpegPath = join(root, "gradient-100x80.jpg");
  const webpPath = join(root, "solid-64x48.webp");
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 74, g: 127, b: 181 } } }).png().toFile(pngPath);
  const gradient = Buffer.alloc(100 * 80 * 3);
  for (let y = 0; y < 80; y += 1) {
    for (let x = 0; x < 100; x += 1) {
      const offset = (y * 100 + x) * 3;
      gradient[offset] = Math.round((x / 99) * 255);
      gradient[offset + 1] = Math.round((y / 79) * 255);
      gradient[offset + 2] = 128;
    }
  }
  await sharp(gradient, { raw: { width: 100, height: 80, channels: 3 } }).jpeg({ quality: 90 }).toFile(jpegPath);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 74, g: 127, b: 181 } } }).webp().toFile(webpPath);
  return { pngPath, jpegPath, webpPath };
}

function fixtureClient(timeoutMs) {
  return createImageDecodeClient({ workerPath: CRASH_WORKER, timeoutMs });
}

test("child-process decodes are byte-identical to in-process decodes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-parity-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { pngPath, jpegPath, webpPath } = await writeFixtures(root);
  const client = createImageDecodeClient();

  try {
    for (const imagePath of [pngPath, jpegPath, webpPath]) {
      const bytes = await readFile(imagePath);
      const [pixelPath, pixelBytes, pixelOp] = await Promise.all([
        client.pixelDigest(imagePath),
        client.pixelDigest(bytes),
        pixelDigestOp(bytes),
      ]);
      assert.equal(pixelPath, pixelOp, `pixelDigest parity for ${imagePath}`);
      assert.equal(pixelBytes, pixelOp, "pixelDigest parity for path vs Buffer");

      const [phashClient, phashOp] = await Promise.all([
        client.perceptualHash(imagePath),
        perceptualHashOp(imagePath),
      ]);
      assert.equal(phashClient, phashOp, `perceptualHash parity for ${imagePath}`);

      const [paletteClient, paletteOpResult] = await Promise.all([
        client.palette(imagePath),
        paletteOp(imagePath),
      ]);
      assert.deepEqual(paletteClient, paletteOpResult, `palette parity for ${imagePath}`);

      const [metadataClient, metadataOpResult] = await Promise.all([
        client.metadata(imagePath),
        metadataOp(imagePath),
      ]);
      assert.deepEqual(metadataClient, metadataOpResult, `metadata parity for ${imagePath}`);
    }

    const posterBytes = await readFile(pngPath);
    const [posterClient, posterOp] = await Promise.all([
      client.encodeVideoPoster(posterBytes),
      encodeVideoPosterOp(posterBytes),
    ]);
    assert.ok(Buffer.isBuffer(posterClient));
    assert.ok(posterClient.equals(posterOp), "encodeVideoPoster parity");
  } finally {
    await client.close();
  }
});

test("a decoder child crash rejects the request without taking the caller down, and the next request restarts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-crash-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { pngPath } = await writeFixtures(root);
  const poisonedPath = join(root, "crash-me.png");
  await writeFile(poisonedPath, await readFile(pngPath));
  const client = fixtureClient(10_000);

  const previousWorkerPath = process.env.MOSA_IMAGE_DECODE_WORKER_PATH;
  process.env.MOSA_IMAGE_DECODE_WORKER_PATH = CRASH_WORKER;
  t.after(() => {
    if (previousWorkerPath === undefined) delete process.env.MOSA_IMAGE_DECODE_WORKER_PATH;
    else process.env.MOSA_IMAGE_DECODE_WORKER_PATH = previousWorkerPath;
  });

  try {
    await assert.rejects(
      () => client.pixelDigest(poisonedPath),
      (error) => error.code === IMAGE_DECODER_CRASHED,
    );
    // The next request goes through, which can only happen if the child was
    // restarted (or was forked fresh for it).
    const digest = await client.pixelDigest(pngPath);
    assert.match(digest, /^[0-9a-f]{64}$/);

    // The library entry point rides the same module-level decoder: a poisoned
    // input is rejected there too instead of reaching the caller's process.
    const viaLibrary = join(root, "crash-me-library.png");
    await writeFile(viaLibrary, await readFile(pngPath));
    await assert.rejects(
      () => safePixelDigest(viaLibrary),
      (error) => error.code === IMAGE_DECODER_CRASHED,
    );
  } finally {
    await client.close();
  }
});

test("deleteAsset still trashes the asset when the pixel digest crashes", async (t) => {
  const previousWorkerPath = process.env.MOSA_IMAGE_DECODE_WORKER_PATH;
  process.env.MOSA_IMAGE_DECODE_WORKER_PATH = CRASH_WORKER;
  t.after(() => {
    if (previousWorkerPath === undefined) delete process.env.MOSA_IMAGE_DECODE_WORKER_PATH;
    else process.env.MOSA_IMAGE_DECODE_WORKER_PATH = previousWorkerPath;
  });

  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-trash-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  await mkdir(join(root, "generated-images"), { recursive: true });
  const { pngPath } = await writeFixtures(root);
  const imagePath = join(root, "generated-images", "crash-me-1.png");
  await writeFile(imagePath, await readFile(pngPath));
  const bytesBefore = await readFile(imagePath);

  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir: join(root, "library") });
  t.after(() => { try { store.close(); } catch {} });
  await store.createAsset({ assetId: "crash-me-1", imagePath, prompt: "poisoned asset" });

  const result = await store.deleteAsset("default", "crash-me-1");
  assert.equal(result.trashed, true);
  assert.ok(result.deleted_at, "deleteAsset returns a deleted_at timestamp");

  const dbPath = sqliteDatabasePath(join(root, "library"));
  const database = new Database(dbPath, { readonly: true });
  try {
    const row = database.prepare("SELECT deleted_at FROM assets WHERE project_id = 'default' AND id = 'crash-me-1'").get();
    assert.ok(row?.deleted_at, "the row carries a deleted_at value");
    const suppression = database.prepare(
      "SELECT content_sha256, pixel_sha256 FROM automatic_ingest_suppressions WHERE project_id = 'default'",
    ).get();
    assert.ok(suppression, "an automatic suppression row was recorded");
    assert.ok(suppression.content_sha256, "the content hash is recorded");
    assert.ok(!suppression.pixel_sha256, "no pixel hash is recorded after the decode crash");
  } finally {
    database.close();
  }

  const bytesAfter = await readFile(imagePath);
  assert.ok(bytesBefore.equals(bytesAfter), "the image file bytes are untouched");
});

test("a silent decoder child times out, is stopped, and the next request restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-timeout-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { pngPath } = await writeFixtures(root);
  const client = createImageDecodeClient({ workerPath: SILENT_WORKER, timeoutMs: 500 });

  try {
    const started = Date.now();
    await assert.rejects(
      () => client.pixelDigest(pngPath),
      (error) => error.code === IMAGE_DECODER_TIMEOUT,
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 450, `the timeout fired no earlier than requested (took ${elapsed}ms)`);
    assert.ok(elapsed < 4000, `the timeout fired promptly (took ${elapsed}ms)`);
    assert.equal(client.pid, null, "the timed-out child was stopped");

    await assert.rejects(
      () => client.pixelDigest(pngPath),
      (error) => error.code === IMAGE_DECODER_TIMEOUT,
    );
  } finally {
    await client.close();
  }
});

test("the same input crashes twice and then fails fast, while other inputs still decode", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-ban-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { pngPath } = await writeFixtures(root);
  const poisonedPath = join(root, "crash-me-ban.png");
  await writeFile(poisonedPath, await readFile(pngPath));
  const client = fixtureClient(10_000);

  try {
    await assert.rejects(() => client.pixelDigest(poisonedPath), { code: IMAGE_DECODER_CRASHED });
    await assert.rejects(() => client.pixelDigest(poisonedPath), { code: IMAGE_DECODER_CRASHED });
    await assert.rejects(
      () => client.pixelDigest(poisonedPath),
      (error) => error.code === IMAGE_DECODER_CRASHED && /refused/.test(error.message),
    );
    // A healthy image still decodes through a fresh child.
    const digest = await client.pixelDigest(pngPath);
    assert.match(digest, /^[0-9a-f]{64}$/);
  } finally {
    await client.close();
  }
});

test("a byte input that crashes the decoder twice is banned from its first crash on", async () => {
  // Task 341 rework 1: byte inputs were never counted until a path crash had
  // been recorded, so this poisoned buffer kept crashing forever.
  const poisoned = Buffer.from("crash-me-bytes");
  const client = fixtureClient(10_000);

  try {
    await assert.rejects(() => client.pixelDigest(poisoned), { code: IMAGE_DECODER_CRASHED });
    await assert.rejects(() => client.pixelDigest(poisoned), { code: IMAGE_DECODER_CRASHED });
    assert.equal(client.pid, null);
    await assert.rejects(
      () => client.pixelDigest(poisoned),
      (error) => error.code === IMAGE_DECODER_CRASHED && /already crashed the decoder twice/.test(error.message),
    );
    // The refusal happens before any fork, so no new child appears.
    assert.equal(client.pid, null);
  } finally {
    await client.close();
  }
});

test("buffer input produces the same result as the same bytes on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-image-decode-buffer-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const { pngPath, jpegPath } = await writeFixtures(root);
  const client = createImageDecodeClient();

  try {
    for (const imagePath of [pngPath, jpegPath]) {
      const bytes = await readFile(imagePath);
      assert.equal(
        await client.pixelDigest(bytes),
        await client.pixelDigest(imagePath),
        `pixelDigest agrees between Buffer and path for ${imagePath}`,
      );
      assert.equal(
        await client.perceptualHash(bytes),
        await client.perceptualHash(imagePath),
        `perceptualHash agrees between Buffer and path for ${imagePath}`,
      );
    }
  } finally {
    await client.close();
  }
});

test("startup shutdown forces exit after the timeout when a step never settles", async () => {
  const exits = [];
  const errors = [];
  const started = Date.now();
  const timedOut = await runStartupShutdownExit({
    steps: [
      ["stopOwnedRuntime", () => new Promise(() => {})],
      ["releaseDesktopStartupHandoff", async () => {}],
    ],
    timeoutMs: 300,
    exit: (code) => exits.push(code),
    log: { warn: () => {}, error: (...parts) => errors.push(parts.join(" ")) },
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(exits, [1], "exit(1) is requested exactly once");
  assert.ok(elapsed >= 280, `exit waited for the timeout (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 3000, `exit happened promptly after the timeout (elapsed ${elapsed}ms)`);
  assert.deepEqual(timedOut, ["stopOwnedRuntime"]);
  assert.ok(errors.some((line) => line.includes("stopOwnedRuntime")), "the log names the timed-out step");
});

test("startup shutdown keeps the 5 second budget", () => {
  assert.equal(STARTUP_SHUTDOWN_TIMEOUT_MS, 5000);
});

test("reportStartupFailure routes its shutdown through the bounded exit", () => {
  const source = readFileSync(fileURLToPath(new URL("../desktop/main.mjs", import.meta.url)), "utf-8");
  assert.match(source, /import \{ runStartupShutdownExit \} from "\.\/startup-shutdown\.mjs";/);
  assert.match(source, /runStartupShutdownExit\(\{\s*\n\s*steps: \[\s*\n\s*\["stopOwnedRuntime", stopOwnedRuntime\],\s*\n\s*\["releaseDesktopStartupHandoff", releaseDesktopStartupHandoff\],/);
  assert.doesNotMatch(source, /Promise\.allSettled\(\[\s*\n\s*stopOwnedRuntime\(\),\s*\n\s*releaseDesktopStartupHandoff\(\),\s*\n\s*\]\)\.finally\(\(\) => app\.exit\(1\)\)/);
});
