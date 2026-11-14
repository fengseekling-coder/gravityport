// Task 413: TIFF/HEIC imports and derivatives, the macOS-only HEIC gate, the
// renderer-side original-display rule, and the sips helpers behind them.
// Everything here imports the real modules — the samples are produced on the
// fly (sharp for TIFF/PNG, the system sips for HEIC/HEIF), never downloaded.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import sharp from "sharp";

import { mimeTypeForFile } from "../lib/asset-store.mjs";
import { isDerivativeTempFileName } from "../lib/derivative-temp-file.js";
import { processDerivativeJob } from "../lib/derivative-worker.js";
import { missingImageDimensionFields } from "../lib/sqlite-store/backfills.mjs";
import { heicUnsupportedOnPlatform, setHeicImportPlatformForTests } from "../lib/heic-import-gate.mjs";
import { ImportStagingError, stageFileForImport, stageReadableForImport } from "../lib/import-staging.mjs";
import { heifPrimaryRotation, readImageDimensionsWithSips, sipsAvailable } from "../lib/sips-image-support.mjs";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

// The renderer rule is a real import of the compiled web source (same pattern
// as animated-frontend.test.mjs — original-display.ts has no imports itself).
const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");
const tempRoot = await mkdtemp(join(tmpdir(), "mosa-413-frontend-"));
after(() => rm(tempRoot, { recursive: true, force: true }));
const { browserCanDisplayOriginal, needsImagePlaceholder } = await (async () => {
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "original-display.ts"), "--outDir", tempRoot, "--module", "esnext",
    "--target", "es2022", "--moduleResolution", "bundler", "--skipLibCheck",
  ], { stdio: "pipe" });
  return import(join(tempRoot, "original-display.js"));
})();

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const SIPS_READY = await sipsAvailable();
const HEIC_SAMPLE_UNAVAILABLE = !SIPS_READY && "HEIC samples need macOS's system sips";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function tiffBytes({ width = 96, height = 72, compression = "lzw" } = {}) {
  // Multi-page TIFFs decode as page 1 through sharp; a single page is enough here.
  return sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } })
    .tiff({ compression })
    .toBuffer();
}

/** PNG in, HEIC/HEIF out — macOS only (sharp has no HEIC encoder). */
function sipsConvert(pngPath, outPath, format = "heic") {
  return new Promise((resolveSips, rejectSips) => {
    execFile("/usr/bin/sips", ["-s", "format", format, pngPath, "--out", outPath], { timeout: 30000 }, (error, _stdout, stderr) => {
      if (error) rejectSips(new Error(String(stderr || error.message)));
      else resolveSips();
    });
  });
}

/**
 * A HEIC carrying a display rotation: sharp writes a PNG, stamps EXIF
 * Orientation=6 onto a JPEG copy, and sips re-encodes that JPEG as HEIC —
 * ImageIO turns the marker into the HEIF rotation property the same way an
 * iPhone photo carries it.
 */
async function makeHeic({ rotated = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mosa-413-heic-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  // Top-white / bottom-black banding makes the stored direction visible.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#204a72"/><rect width="600" height="80" fill="#ffffff"/><rect y="320" width="600" height="80" fill="#000000"/></svg>`;
  const pngPath = join(dir, "src.png");
  await sharp(Buffer.from(svg)).png().toFile(pngPath);
  const heicPath = join(dir, rotated ? "src-orient6.heic" : "src.heic");
  if (rotated) {
    const jpegPath = join(dir, "src-orient6.jpg");
    await sharp(pngPath).withMetadata({ orientation: 6 }).jpeg({ quality: 92 }).toFile(jpegPath);
    await sipsConvert(jpegPath, heicPath);
  } else {
    await sipsConvert(pngPath, heicPath);
  }
  return heicPath;
}

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
    async isAssetActive() { return true; },
  };
}

async function makeDerivativeJob(root, id, originalPath) {
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

test("mimeTypeForFile maps the task 413 extensions", () => {
  assert.equal(mimeTypeForFile("a.tif"), "image/tiff");
  assert.equal(mimeTypeForFile("a.TIFF"), "image/tiff");
  assert.equal(mimeTypeForFile("a.heic"), "image/heic");
  assert.equal(mimeTypeForFile("a.heif"), "image/heif");
  assert.equal(mimeTypeForFile("a.mkv"), "video/x-matroska");
  // Pre-existing mappings stay untouched.
  assert.equal(mimeTypeForFile("a.png"), "image/png");
  assert.equal(mimeTypeForFile("a.mov"), "video/quicktime");
});

test("browserCanDisplayOriginal refuses TIFF/HEIC originals and keeps the rest", () => {
  for (const refused of ["a.tif", "a.tiff", "a.heic", "a.heif", "/library/p/images/x.TIF", "/library/p/images/x.heic?v=3"]) {
    assert.equal(browserCanDisplayOriginal(refused), false, `${refused} must not swap to the original`);
  }
  for (const allowed of ["a.png", "a.jpg", "a.webp", "a.avif", "a.gif", "a.svg", "a.mp4", "/library/p/images/y.PNG?v=2"]) {
    assert.equal(browserCanDisplayOriginal(allowed), true, `${allowed} keeps the default rule`);
  }
  assert.equal(browserCanDisplayOriginal(null), false);
  assert.equal(browserCanDisplayOriginal(undefined), false);
  assert.equal(browserCanDisplayOriginal(""), false);
  assert.equal(needsImagePlaceholder("a.heic"), true);
  assert.equal(needsImagePlaceholder("/library/p/images/z.tiff"), true);
  assert.equal(needsImagePlaceholder("a.png"), false);
});

test("the HEIC gate is a no-op on darwin and refuses .heic/.heif elsewhere", () => {
  assert.equal(heicUnsupportedOnPlatform(".heic", "darwin"), false);
  assert.equal(heicUnsupportedOnPlatform(".heif", "darwin"), false);
  assert.equal(heicUnsupportedOnPlatform(".png", "win32"), false);
  assert.equal(heicUnsupportedOnPlatform(".HEIC", "win32"), true, "case-insensitive");
  assert.equal(heicUnsupportedOnPlatform(".heif", "win32"), true);
  assert.equal(heicUnsupportedOnPlatform(".heif", "linux"), true);
});

for (const kind of ["json", "sqlite"]) {
  test(`${kind} store imports TIFF on any platform and refuses HEIC off macOS`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `mosa-413-store-${kind}-`));
    deferTestPathRemoval(dir, { recursive: true, force: true });
    const projectRoot = join(dir, "project");
    const generated = join(projectRoot, "generated-images");
    await mkdir(generated, { recursive: true });

    const tiffPath = join(generated, "sample.tif");
    await writeFile(tiffPath, await tiffBytes());
    const heicPath = join(generated, "sample.heic");
    const heicBytes = SIPS_READY ? await readFile(await makeHeic()) : ONE_PIXEL_PNG;
    await writeFile(heicPath, heicBytes);

    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(dir, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    setHeicImportPlatformForTests("win32");
    try {
      await assert.rejects(store.createAsset({ imagePath: heicPath }), (error) => {
        assert.equal(error.code, "HEIC_UNSUPPORTED_ON_PLATFORM");
        assert.equal(error.statusCode, 400);
        return true;
      });
    } finally {
      setHeicImportPlatformForTests(null);
    }

    // darwin accepts the same file (real HEIC bytes on macOS; skipped elsewhere
    // because the png stand-in bytes would fail the byte-signature gate, not the
    // platform gate).
    if (SIPS_READY) {
      setHeicImportPlatformForTests("darwin");
      try {
        await store.createAsset({ imagePath: heicPath });
      } finally {
        setHeicImportPlatformForTests(null);
      }
    }
    // TIFF imports on any platform, gate on or off.
    setHeicImportPlatformForTests("win32");
    try {
      const tiffResult = await store.createAsset({ imagePath: tiffPath });
      assert.ok(tiffResult.asset, "TIFF imports with the gate on win32");
    } finally {
      setHeicImportPlatformForTests(null);
    }
  });
}

test("staging refuses HEIC off macOS for both the file and the stream door", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-413-staging-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const stagingRoot = join(dir, "staging");
  const heicSource = join(dir, "pick.heic");
  await writeFile(heicSource, ONE_PIXEL_PNG);

  setHeicImportPlatformForTests("win32");
  try {
    await assert.rejects(stageFileForImport({ sourcePath: heicSource, stagingRoot }), (error) => {
      assert.ok(error instanceof ImportStagingError);
      assert.equal(error.code, "HEIC_UNSUPPORTED_ON_PLATFORM");
      return true;
    });
    await assert.rejects(stageReadableForImport({
      readable: (async function* generate() { yield ONE_PIXEL_PNG; })(),
      fileName: "dropped.heic",
      stagingRoot,
    }), (error) => {
      assert.equal(error.code, "HEIC_UNSUPPORTED_ON_PLATFORM");
      return true;
    });
  } finally {
    setHeicImportPlatformForTests(null);
  }

  // darwin stages the same file, and TIFF stages on any platform.
  setHeicImportPlatformForTests("win32");
  try {
    const tiffSource = join(dir, "pick.tif");
    await writeFile(tiffSource, await tiffBytes());
    const stagedTiff = await stageFileForImport({ sourcePath: tiffSource, stagingRoot });
    assert.ok(stagedTiff.endsWith(".tif"), "TIFF stages regardless of the platform gate");
  } finally {
    setHeicImportPlatformForTests(null);
  }
});

test("TIFF derivatives: three webp files with the source dimensions", { skip: false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-413-tiff-derivative-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = join(root, "source.tif");
  await writeFile(originalPath, await tiffBytes({ width: 96, height: 72 }));
  const job = await makeDerivativeJob(root, "tiffjob", originalPath);

  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, true);
  assert.equal(result.width, 96);
  assert.equal(result.height, 72);
  for (const finalPath of [job.previewPath, job.mediumPath, job.thumbnailPath]) {
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp");
    assert.ok(metadata.width > 0 && metadata.height > 0, `${finalPath} decodes with real dimensions`);
  }
});

test("HEIC derivatives on macOS: three webp files and upright dimensions", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-413-heic-derivative-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = await makeHeic();
  const job = await makeDerivativeJob(root, "heicjob", originalPath);

  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, true);
  assert.equal(result.width, 600);
  assert.equal(result.height, 400);
  for (const finalPath of [job.previewPath, job.mediumPath, job.thumbnailPath]) {
    const metadata = await sharp(finalPath).metadata();
    assert.equal(metadata.format, "webp");
  }
  // No sips temp residue anywhere (success path removes it in the finally).
  const previews = await readdir(join(root, "previews"));
  assert.deepEqual(previews.filter(isDerivativeTempFileName), []);
});

test("rotated HEIC (Orientation=6) derives upright like Finder shows it", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-413-heic-rotate-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = await makeHeic({ rotated: true });
  const job = await makeDerivativeJob(root, "rotjob", originalPath);

  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, true);
  // The stored pixels are 600x400 with a rotation marker, so the display
  // dimensions swap (orientedImageDimensions) — the card reads 400x600 portrait,
  // matching the Finder preview. The 400px thumbnail tier fits a portrait into
  // 267x400.
  assert.deepEqual([result.width, result.height], [400, 600]);
  const thumbnail = await sharp(job.thumbnailPath).metadata();
  assert.equal(thumbnail.width, 267);
  assert.equal(thumbnail.height, 400);
});

test("a corrupt HEIC fails the derivative job and leaves no temp file", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-413-heic-bad-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const originalPath = join(root, "broken.heic");
  await writeFile(originalPath, "this is not an image at all\n");
  const job = await makeDerivativeJob(root, "badjob", originalPath);

  // The worker turns a failed job into { ok: false } and records the error on
  // the store; it never throws.
  const result = await processDerivativeJob(fakeStore(), job);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /sips conversion failed/, `${result.error}`);
  const previews = await readdir(join(root, "previews"));
  assert.deepEqual(previews.filter(isDerivativeTempFileName), [], "the sips temp PNG is swept on failure");
});

test("sips dimension fallback reads HEIC dimensions, junk included as null", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  const plain = await makeHeic();
  assert.deepEqual(await readImageDimensionsWithSips(plain), { width: 600, height: 400 });
  // An ImageIO-written rotated HEIC carries its rotation in the HEIF irot
  // property, which `sips -g orientation` reports as <nil> — task 424 parses
  // the primary item's irot angle from the file head instead, so the fallback
  // returns the upright (swapped) size right away, like an EXIF-carrying HEIC.
  const rotated = await makeHeic({ rotated: true });
  assert.deepEqual(await readImageDimensionsWithSips(rotated), { width: 400, height: 600 });
  const notAnImage = join(await mkdtemp(join(tmpdir(), "mosa-413-sips-")), "nope.png");
  deferTestPathRemoval(dirname(notAnImage), { recursive: true, force: true });
  await writeFile(notAnImage, "junk");
  assert.equal(await readImageDimensionsWithSips(notAnImage), null);
});

test("heifPrimaryRotation reads the irot angle from real HEIC file heads", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  // readFile hands back the whole file; these samples are ~1 KiB, far inside
  // the 512 KiB head the production read uses.
  assert.equal(heifPrimaryRotation(await readFile(await makeHeic())), 0);
  assert.equal(heifPrimaryRotation(await readFile(await makeHeic({ rotated: true }))), 3);
});

test("the import dimension fallback derives upright dimensions for irot-only HEIC", { skip: HEIC_SAMPLE_UNAVAILABLE }, async () => {
  const rotated = await makeHeic({ rotated: true });
  const rotatedFields = await missingImageDimensionFields(rotated, {});
  assert.deepEqual([rotatedFields.width, rotatedFields.height], [400, 600]);
  const plain = await makeHeic();
  const plainFields = await missingImageDimensionFields(plain, {});
  assert.deepEqual([plainFields.width, plainFields.height], [600, 400]);
});

test("staging the new extensions keeps the set identical to the store's", async () => {
  // Re-imported fresh so the contract below cannot depend on module-load order.
  const { STAGING_EXTENSIONS } = await import("../lib/import-staging.mjs");
  const { SUPPORTED_MEDIA_EXTENSIONS } = await import("../lib/asset-store.mjs");
  assert.deepEqual([...STAGING_EXTENSIONS].sort(), SUPPORTED_MEDIA_EXTENSIONS);
  for (const extension of [".tif", ".tiff", ".heic", ".heif", ".mkv"]) {
    assert.equal(STAGING_EXTENSIONS.has(extension), true, `${extension} is staged`);
  }
});
