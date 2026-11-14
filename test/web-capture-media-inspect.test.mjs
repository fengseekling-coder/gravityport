// Task 416 (audit 低10 ① follow-up, left by 410): inspectImageBytes' manual
// multi-page pixel check — width × pageHeight × pages over
// WEB_CAPTURE_MAX_IMAGE_PIXELS while a single page stays under it — had no
// test guarding it. The decoder's own limitInputPixels only sees the first
// page, so this check is the one rejecting oversized animated GIFs/WebP.
//
// The fixture is a hand-built animated GIF: a 64×64 canvas with many tiny
// frames. inspectImageBytes reads metadata WITHOUT sharp's animated flag
// (image-decode-ops metadataOp), which reports width/height from the logical
// screen descriptor and pages = frame count — so totalPixels scales with
// pages while the bytes stay tiny (~21 B/frame) and no pixels are decoded
// (metadataOp is header-only; safePixelDigest returns "" for multi-frame).
import assert from "node:assert/strict";
import test from "node:test";

import { inspectImageBytes } from "../lib/web-capture/media-inspect.js";
import { WEB_CAPTURE_MAX_IMAGE_PIXELS } from "../lib/web-capture/limits.js";

function buildAnimatedGif({ canvasSize, frameCount }) {
  const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];
  const bytes = [];
  bytes.push(0x47, 0x49, 0x46, 0x38, 0x39, 0x61); // "GIF89a"
  bytes.push(...u16(canvasSize), ...u16(canvasSize), 0x70, 0x00, 0x00); // logical screen, no global color table
  for (let index = 0; index < frameCount; index += 1) {
    if (index === 0) {
      bytes.push(0x21, 0xff, 0x0b); // application extension: NETSCAPE2.0 loop
      bytes.push(..."NETSCAPE2.0".split("").map((ch) => ch.charCodeAt(0)));
      bytes.push(0x03, 0x01, 0x00, 0x00, 0x00);
    }
    bytes.push(0x21, 0xf9, 0x04, 0x04, 0x28, 0x00, 0x00, 0x00); // graphic control: 40 ms delay
    // image descriptor: a 1×1 frame at (0,0), local tables absent
    bytes.push(0x2c, ...u16(0), ...u16(0), ...u16(1), ...u16(1), 0x00);
    // LZW min code size 2; stream: clear(4), code 0, eoi(5) → [0x44, 0x01]
    bytes.push(0x02, 0x02, 0x44, 0x01, 0x00);
  }
  bytes.push(0x3b); // trailer
  return Buffer.from(bytes);
}

const FRAME_BUDGET = Math.floor(WEB_CAPTURE_MAX_IMAGE_PIXELS / (64 * 64));

test("a multi-page GIF whose pages multiply past the pixel limit is rejected with WEB_CAPTURE_PIXEL_LIMIT", async () => {
  const frameCount = FRAME_BUDGET + 1; // 64×64×9766 = 40,005,376 > 40,000,000
  const gif = buildAnimatedGif({ canvasSize: 64, frameCount });
  assert.equal(gif.length < 1024 * 1024, true, "the fixture stays small (no pixel decoding needed)");

  await assert.rejects(
    () => inspectImageBytes(gif),
    (error) => {
      assert.equal(error.statusCode, 413);
      assert.equal(error.code, "WEB_CAPTURE_PIXEL_LIMIT");
      return true;
    },
  );
});

test("the same construction just under the limit passes inspection", async () => {
  const frameCount = FRAME_BUDGET - 1; // 64×64×9764 = 39,988,736 < 40,000,000
  const gif = buildAnimatedGif({ canvasSize: 64, frameCount });

  const inspected = await inspectImageBytes(gif);
  assert.equal(inspected.format, "gif");
  assert.equal(inspected.width, 64);
  assert.equal(inspected.height, 64);
  assert.equal(inspected.pixelHash, "", "multi-frame images keep the empty digest");
});
