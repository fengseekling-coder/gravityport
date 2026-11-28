// GravityPort React UI flow (task 412): an animated GIF opens in the viewer
// with the still preview first, then swaps to the ORIGINAL (whatever its
// size — the old rule demanded the original to be bigger than the preview)
// and actually plays: a screenshot of the viewer region taken inside the
// isolated QA desktop shell (CDP Page.captureScreenshot, clipped to the media
// box) must be followed, within ~1.5s, by one that differs pixel-wise.
//
// The desktop shell is the only instance reachable over CDP (the web-driver
// window has no debugging port); quiet QA mode renders it hidden with
// background throttling off (task 325/346), so the GIF keeps animating.
import { join } from "node:path";
import sharp from "sharp";
import { runDesktopShell } from "./_animated-desktop.mjs";
import { flowArtifactDir } from "./_artifacts.mjs";

export const name = "viewer-animated-original";
export const description = "414x414 two-frame GIF: viewer shows the still preview, swaps to the /images/ original, and a later viewer-region screenshot (retried at uneven gaps over ~1.5s) differs from the first (flow artifact PNGs)";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    // Two solid frames 414x414, 120ms each (a 240ms loop); the capture loop
    // below retries at uneven gaps so it cannot keep landing on one frame.
    const makeFrame = (color) => sharp({ create: { width: 414, height: 414, channels: 3, background: color } }).png().toBuffer();
    const gifPath = join(ctx.fixturesDir, "animated-414.gif");
    await sharp([await makeFrame({ r: 214, g: 61, b: 46 }), await makeFrame({ r: 52, g: 101, b: 214 })], {
      join: { animated: true, delay: [120, 120] },
    }).gif().toFile(gifPath);
    const asset = (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: gifPath, prompt: "viewer animated original",
    })).asset;

    // The flag must be stamped by the real derivative worker before the UI
    // would treat this asset as animated.
    const ready = await waitFor(ctx, server, asset.id);
    if (ready.business_fields?.animated !== true) {
      throw new Error(`derivative run did not stamp $.animated for the GIF: ${JSON.stringify(ready.business_fields)}`);
    }

    // Layer 2 gets its own single writer: the desktop shell opens the same
    // library directory, so the main server stops first.
    await server.stop();
    serverRunning = false;

    // captureRect writes flow artifacts by file name; the pixel comparison
    // below reads them back from the run's artifact directory.
    const shotNames = { first: "412-viewer-frame-1.png", second: "412-viewer-frame-2.png" };
    const shots = {
      first: join(flowArtifactDir(ctx), shotNames.first),
      second: join(flowArtifactDir(ctx), shotNames.second),
    };
    const result = await runDesktopShell(ctx, async ({ evaluate, waitForValue, sleep, doubleClick, pointOf, captureRect }) => {
      await waitForValue(`document.querySelectorAll('.asset-card').length >= 1`, "the seeded GIF card");
      await doubleClick(await pointOf('.asset-card[data-asset-id]'));
      await waitForValue(`Boolean(document.querySelector('.image-viewer img.viewer-image'))`, "the viewer image");
      await waitForValue(`(() => {
        const media = document.querySelector('.image-viewer img.viewer-image');
        return media.complete && media.naturalWidth > 0;
      })()`, "the still preview decoded");

      // The original must take over: /images/, not /previews/.
      const originalPathname = await waitForValue(`(() => {
        const media = document.querySelector('.image-viewer img.viewer-image');
        const path = new URL(media.getAttribute('src') || '', location.href).pathname;
        return path.includes('/images/') ? path : null;
      })()`, "the swap to the original GIF", 15000);
      await waitForValue(`(() => {
        const media = document.querySelector('.image-viewer img.viewer-image');
        return media.complete && media.naturalWidth > 0;
      })()`, "the original decoded");

      const rect = await evaluate(`(() => {
        const r = document.querySelector('.image-viewer img.viewer-image').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
      })()`);
      if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`viewer media box is empty: ${JSON.stringify(rect)}`);
      // Two 120ms frames make a 240ms cycle, so two captures a fixed 350ms
      // apart land on the same frame whenever the first falls in the first
      // 50ms of a frame (~40% of runs — CI hit it on PR #348). Keep capturing
      // the second shot at short, uneven gaps until it differs, for up to ~1.5s
      // (several full cycles); a GIF that is really frozen never differs.
      await captureRect(rect, shotNames.first);
      const firstRaw = await sharp(shots.first).raw().toBuffer();
      let attempts = 0;
      for (const gap of [90, 70, 110, 90, 130, 70, 110, 150, 90, 130, 170, 110]) {
        attempts += 1;
        await sleep(gap);
        await captureRect(rect, shotNames.second);
        const secondRaw = await sharp(shots.second).raw().toBuffer();
        if (secondRaw.length !== firstRaw.length || !secondRaw.equals(firstRaw)) break;
      }
      return { originalPathname, rect, attempts };
    });

    const [rawFirst, rawSecond] = await Promise.all([
      sharp(shots.first).raw().toBuffer(),
      sharp(shots.second).raw().toBuffer(),
    ]);
    if (rawFirst.length !== rawSecond.length) throw new Error("the two viewer screenshots have different sizes");
    let differingBytes = 0;
    for (let index = 0; index < rawFirst.length; index += 1) {
      if (rawFirst[index] !== rawSecond[index]) differingBytes += 1;
    }
    if (differingBytes === 0) throw new Error("the two viewer screenshots are pixel-identical — the GIF is not animating");

    return {
      ok: true,
      originalSrc: result.originalPathname,
      mediaBox: result.rect,
      differingBytes,
      captureAttempts: result.attempts,
      screenshots: [shots.first, shots.second],
    };
  } finally {
    if (serverRunning) await server.stop().catch(() => {});
  }
}

async function waitFor(ctx, server, assetId) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    const asset = detail?.asset || {};
    const fields = asset.business_fields || {};
    if (Number(fields.width) > 100 && Number(fields.height) > 100 && fields.animated === true) return asset;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`asset ${assetId} never became ready (dimensions + animated flag) — derivative worker did not run`);
}
