import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";

import { assertMediaSignature, classifyMediaSignature } from "../lib/media-signature.mjs";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function sharpBytes(format) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })[format]().toBuffer();
}


// One real sample per managed media extension (task 366): images are generated
// by sharp on the fly, SVG is the real repository icon, videos are the existing
// e2e fixtures plus the two committed ffmpeg samples (webm/m4v had none).
async function mediaSamples() {
  const samples = [
    { ext: ".png", bytes: await sharpBytes("png") },
    // APNG is a valid PNG stream; the sniff accepts it through the PNG signature.
    { ext: ".apng", bytes: await sharpBytes("png") },
    { ext: ".jpg", bytes: await sharpBytes("jpeg") },
    { ext: ".jpeg", bytes: await sharpBytes("jpeg") },
    { ext: ".gif", bytes: await sharpBytes("gif") },
    { ext: ".webp", bytes: await sharpBytes("webp") },
    { ext: ".avif", bytes: await sharpBytes("avif") },
    { ext: ".svg", bytes: await readFile(join(repositoryRoot, "desktop", "assets", "mosa-app-icon.svg")) },
    // Task 413: TIFF in both byte orders, HEIC/HEIF via sips, MKV as a committed
    // ffmpeg sample (the task 413 playback probe accepted the container).
    { ext: ".tif", bytes: await sharpBytes("tiff") },
    { ext: ".tiff", bytes: await sharpBytes("tiff") },
    // sharp writes little-endian ("II") TIFF; big-endian ("MM") is the other
    // byte order cameras and scanners emit. Only the signature is checked here.
    { ext: ".tif", bytes: Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.alloc(60)]) },
    { ext: ".mp4", bytes: await readFile(join(repositoryRoot, "test", "fixtures", "video-first-frame.mp4")) },
    { ext: ".mov", bytes: await readFile(join(repositoryRoot, "test", "fixtures", "video-metadata", "sample-72x128.mov")) },
    { ext: ".m4v", bytes: await readFile(join(repositoryRoot, "test", "fixtures", "media-signature", "sample.m4v")) },
    { ext: ".webm", bytes: await readFile(join(repositoryRoot, "test", "fixtures", "media-signature", "sample.webm")) },
    { ext: ".mkv", bytes: await readFile(join(repositoryRoot, "test", "fixtures", "media-signature", "sample.mkv")) },
  ];
  if (process.platform === "darwin") {
    samples.push({ ext: ".heic", bytes: await makeHeicSampleBytes() });
    // sips cannot write the "public.heif" type ("Can't write format", Error 13);
    // its HEIC output is an HEIF container with the heic brand, which .heif files
    // carry too.
    samples.push({ ext: ".heif", bytes: await makeHeicSampleBytes() });
  }
  return samples;
}

// sharp has no HEIC/HEIF encoder; macOS's system sips writes both from a PNG
// (task 413). Non-macOS runners skip these samples — HEIC imports are gated to
// darwin by heic-import-gate.mjs anyway.
async function makeHeicSampleBytes(format = "heic") {
  const dir = await mkdtemp(join(tmpdir(), "mosa-sips-heic-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const pngPath = join(dir, "src.png");
  const outPath = join(dir, `src.${format}`);
  await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toFile(pngPath);
  await new Promise((resolveSips, rejectSips) => {
    execFile("/usr/bin/sips", ["-s", "format", format, pngPath, "--out", outPath], { timeout: 30000 }, (error, _stdout, stderr) => {
      if (error) rejectSips(new Error(String(stderr || error.message)));
      else resolveSips();
    });
  });
  return readFile(outPath);
}

async function makeSniffDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "mosa-media-signature-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  return dir;
}

test("every managed media extension accepts a real sample of its class", async (t) => {
  const dir = await makeSniffDir(t);
  for (const { ext, bytes } of await mediaSamples()) {
    const filePath = join(dir, `sample${ext}`);
    await writeFile(filePath, bytes);
    await assert.doesNotReject(() => assertMediaSignature(filePath, ext), `real ${ext} sample must be accepted`);
  }
});

test("plain text, empty files and 4-byte-truncated headers are rejected", async (t) => {
  const dir = await makeSniffDir(t);

  const textPath = join(dir, "fake.png");
  await writeFile(textPath, "a plain text note saved with an image extension\n");
  await assert.rejects(() => assertMediaSignature(textPath, ".png"), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    return true;
  });

  const emptyPath = join(dir, "empty.jpg");
  await writeFile(emptyPath, Buffer.alloc(0));
  await assert.rejects(() => assertMediaSignature(emptyPath, ".jpg"), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    return true;
  });

  // Only the first four bytes of the real header survive the cut. Task 413:
  // TIFF's whole magic is those four bytes (II*\0 / MM\0*), so its cut keeps
  // three — every format here needs more than that to pass.
  for (const { ext, bytes } of await mediaSamples()) {
    const truncated = join(dir, `truncated${ext}`);
    await writeFile(truncated, bytes.subarray(0, ext === ".tif" || ext === ".tiff" ? 3 : 4));
    await assert.rejects(() => assertMediaSignature(truncated, ext), (error) => {
      assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA", `truncated ${ext} must be rejected`);
      return true;
    });
  }

  // Text that merely mentions svg markup is not an SVG document.
  const lookalike = join(dir, "notes.svg");
  await writeFile(lookalike, "The <svg element is described in this note.\n");
  await assert.rejects(() => assertMediaSignature(lookalike, ".svg"), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    return true;
  });

  // FF D8 FF 00 filler after SOI is junk, not a real JPEG marker (rework 1
  // keeps the marker set tight; only COM/FE was added).
  const junkJpeg = join(dir, "junk.jpg");
  await writeFile(junkJpeg, Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]));
  await assert.rejects(() => assertMediaSignature(junkJpeg, ".jpg"), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    return true;
  });
});

// 任务 366 返工 1：新版 ffmpeg 的 MJPEG 在没有 JFIF 头时把 COM 注释段放在最前，
// FF D8 FF FE 是真 JPEG，不许误拒。
test("a real JPEG opening with a COM comment segment is accepted", async (t) => {
  const dir = await makeSniffDir(t);
  const base = await sharpBytes("jpeg"); // FF D8 (SOI) + FF DB (DQT) …
  const comment = Buffer.from("Lavc62.28.100 encoded frame", "latin1");
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(2), comment]);
  com.writeUInt16BE(comment.length + 2, 2); // segment length counts its own two bytes
  const comFirst = Buffer.concat([base.subarray(0, 2), com, base.subarray(2)]);

  // The spliced file must be a legal JPEG first: sharp reads real dimensions.
  const metadata = await sharp(comFirst).metadata();
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 8);

  const comPath = join(dir, "com-first.jpg");
  await writeFile(comPath, comFirst);
  await assert.doesNotReject(() => assertMediaSignature(comPath, ".jpg"), "COM-first JPEG must be accepted");
});

test("a class keeps its members: png bytes in .jpg pass, png bytes in .mp4 do not", async (t) => {
  const dir = await makeSniffDir(t);

  const pngInJpg = join(dir, "website.jpg");
  await writeFile(pngInJpg, await sharpBytes("png"));
  await assert.doesNotReject(() => assertMediaSignature(pngInJpg, ".jpg"));

  const pngInMp4 = join(dir, "wrong.mp4");
  await writeFile(pngInMp4, await sharpBytes("png"));
  await assert.rejects(() => assertMediaSignature(pngInMp4, ".mp4"), (error) => {
    assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
    return true;
  });
});

test("classifyMediaSignature stays empty for junk and incomplete headers", () => {
  assert.equal(classifyMediaSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47])), "", "only the first 4 PNG bytes: not a PNG");
  assert.equal(classifyMediaSignature(Buffer.alloc(0)), "");
  assert.equal(classifyMediaSignature(Buffer.from("just text")), "");
});

async function makeStoreWorkspace(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const projectRoot = join(dir, "project");
  const generated = join(projectRoot, "generated-images");
  await mkdir(generated, { recursive: true });
  return { dir, projectRoot, generated };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind} store rejects non-media bytes behind a media extension and keeps the count unchanged`, async (t) => {
    const { dir, projectRoot, generated } = await makeStoreWorkspace(t, `mosa-sniff-${kind}-`);
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(dir, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    const fakePath = join(generated, "fake.png");
    await writeFile(fakePath, "not an image, just text with a media extension");
    await assert.rejects(store.createAsset({ imagePath: fakePath }), (error) => {
      assert.equal(error.code, "IMAGE_CONTENT_NOT_MEDIA");
      // 任务 366 返工 1：内容不是媒体是客户端错误，必须回 400 而不是 500
      //（扩展把 >=500 当可重试，会反复排队）。
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /fake\.png/);
      return true;
    });
    assert.equal((await store.listAssets({ projectId: "default" })).length, 0, "the fake import must not leave a card behind");

    const realPath = join(generated, "real.png");
    await writeFile(realPath, await sharpBytes("png"));
    const created = await store.createAsset({ imagePath: realPath });
    assert.ok(created.id, "a real image must still import");
    assert.equal((await store.listAssets({ projectId: "default" })).length, 1);
  });

  test(`${kind} store accepts a JPEG that opens with a COM comment segment`, async (t) => {
    const { dir, projectRoot, generated } = await makeStoreWorkspace(t, `mosa-sniff-com-${kind}-`);
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(dir, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    const base = await sharpBytes("jpeg");
    const comment = Buffer.from("Lavc62.28.100 encoded frame", "latin1");
    const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.alloc(2), comment]);
    com.writeUInt16BE(comment.length + 2, 2);
    const comFirst = Buffer.concat([base.subarray(0, 2), com, base.subarray(2)]);
    assert.equal((await sharp(comFirst).metadata()).width, 8, "the spliced file is a legal JPEG");

    const comPath = join(generated, "com-first.jpg");
    await writeFile(comPath, comFirst);
    const created = await store.createAsset({ imagePath: comPath });
    assert.ok(created.id, "a COM-first JPEG must import through the real store");
  });
}
