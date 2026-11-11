import assert from "node:assert/strict";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import test from "node:test";
import sharp from "sharp";
import { createDerivativeProcessor, processDerivativeJob } from "../lib/derivative-worker.js";
import { createMcpWorkspace, startMcpServer } from "./helpers/mcp-server-harness.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

async function makeJob(root, id) {
  const originalPath = join(root, `${id}.png`);
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toFile(originalPath);
  return {
    project_id: "default",
    asset_id: id,
    original_path: originalPath,
    previewPath: join(root, "previews", `${id}.webp`),
    mediumPath: join(root, "mediums", `${id}.webp`),
    thumbnailPath: join(root, "thumbnails", `${id}.webp`),
  };
}

function fakeStore() {
  const completions = [];
  return {
    completions,
    async completeDerivativeJob(_job, result) { completions.push(result); },
    async isAssetActive() { return true; },
  };
}

test("native image decoding runs outside the MOSA runtime process", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-isolation-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const store = fakeStore();
  const result = await processDerivativeJob(store, await makeJob(root, "isolated"));

  assert.equal(result.ok, true);
  assert.equal(Number.isInteger(result.processorPid), true);
  assert.notEqual(result.processorPid, process.pid);
});

test("processor crash rejects current work and the processor can restart cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-restart-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const processor = createDerivativeProcessor();
  const store = fakeStore();

  try {
    const first = await processDerivativeJob(store, await makeJob(root, "first"), { processor });
    assert.equal(first.ok, true);
    const firstPid = processor.pid;
    assert.ok(firstPid && firstPid !== process.pid);

    process.kill(firstPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await processDerivativeJob(store, await makeJob(root, "second"), { processor });
    assert.equal(second.ok, true);
    assert.ok(processor.pid && processor.pid !== firstPid);
    assert.notEqual(second.processorPid, firstPid);
  } finally {
    await processor.close();
  }
});

test("12000x12000 PNG generates all three derivative tiers and 16500x16500 is cleanly rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-large-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const processor = createDerivativeProcessor();
  const store = fakeStore();

  try {
    const largePath = join(root, "large-12000.png");
    await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 34, g: 51, b: 68 } } })
      .png({ compressionLevel: 1 })
      .toFile(largePath);
    const largeJob = {
      project_id: "default",
      asset_id: "large-12000",
      original_path: largePath,
      previewPath: join(root, "previews", "large-12000.webp"),
      mediumPath: join(root, "mediums", "large-12000.webp"),
      thumbnailPath: join(root, "thumbnails", "large-12000.webp"),
    };
    const largeResult = await processDerivativeJob(store, largeJob, { processor });
    assert.equal(largeResult.ok, true);
    assert.equal(largeResult.width, 12000);
    assert.equal(largeResult.height, 12000);
    await access(largeJob.previewPath);
    await access(largeJob.mediumPath);
    await access(largeJob.thumbnailPath);
    const thumbMeta = await sharp(largeJob.thumbnailPath).metadata();
    assert.equal(Math.max(thumbMeta.width, thumbMeta.height), 400);

    // 16500x16500 = 272,250,000 > MAX_DERIVATIVE_INPUT_PIXELS (268,402,689).
    // Patch IHDR width/height + CRC on a valid PNG so we test the pixel ceiling
    // without spending seconds encoding 272M pixels.
    const overLimitPath = join(root, "over-16500.png");
    const overBuf = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 70, g: 80, b: 90 } } }).png().toBuffer();
    overBuf.writeUInt32BE(16500, 16);
    overBuf.writeUInt32BE(16500, 20);
    overBuf.writeUInt32BE(crc32(overBuf.subarray(12, 29)), 29);
    await writeFile(overLimitPath, overBuf);
    const overJob = {
      project_id: "default",
      asset_id: "over-16500",
      original_path: overLimitPath,
      previewPath: join(root, "previews", "over-16500.webp"),
      mediumPath: join(root, "mediums", "over-16500.webp"),
      thumbnailPath: join(root, "thumbnails", "over-16500.webp"),
    };
    const overResult = await processDerivativeJob(store, overJob, { processor });
    assert.equal(overResult.ok, false);
    assert.match(String(overResult.error), /Input image exceeds pixel limit/i);
    await assert.rejects(access(overJob.previewPath));
    await assert.rejects(access(overJob.mediumPath));
    await assert.rejects(access(overJob.thumbnailPath));
    assert.match(String(store.completions.at(-1)?.error), /Input image exceeds pixel limit/i);
  } finally {
    await processor.close();
  }
});

test("MCP asset_create warns on images above 268,402,689 pixels and not on 12000x12000", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);

  const okPath = join(workspace.root, "large-12000-mcp.png");
  const okBuf = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 40, b: 60 } } }).png().toBuffer();
  okBuf.writeUInt32BE(12000, 16);
  okBuf.writeUInt32BE(12000, 20);
  okBuf.writeUInt32BE(crc32(okBuf.subarray(12, 29)), 29);
  await writeFile(okPath, okBuf);

  const okCreated = await server.callToolStrict("asset_create", { imagePath: okPath, prompt: "12000x12000 image" });
  assert.equal(okCreated.structuredContent.asset.business_fields.width, 12000);
  assert.equal(okCreated.structuredContent.asset.business_fields.height, 12000);
  assert.equal(okCreated.structuredContent.warnings, undefined);
  assert.ok(!okCreated.content[0].text.includes("IMAGE_TOO_LARGE_FOR_PREVIEW"));
  assert.ok(!okCreated.content[0].text.includes("不会生成缩略图"));

  const overPath = join(workspace.root, "over-16500-mcp.png");
  const overBuf = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 80, g: 40, b: 20 } } }).png().toBuffer();
  overBuf.writeUInt32BE(16500, 16);
  overBuf.writeUInt32BE(16500, 20);
  overBuf.writeUInt32BE(crc32(overBuf.subarray(12, 29)), 29);
  await writeFile(overPath, overBuf);

  const overCreated = await server.callToolStrict("asset_create", { imagePath: overPath, prompt: "16500x16500 image" });
  assert.equal(overCreated.structuredContent.asset.business_fields.width, 16500);
  assert.equal(overCreated.structuredContent.asset.business_fields.height, 16500);
  assert.deepEqual(overCreated.structuredContent.warnings, ["IMAGE_TOO_LARGE_FOR_PREVIEW"]);
  assert.ok(overCreated.content[0].text.includes("这张图超过 2.68 亿像素，App 里不会生成缩略图和预览。/ This image exceeds 268 megapixels; the App will not generate a thumbnail or preview for it."));
});
