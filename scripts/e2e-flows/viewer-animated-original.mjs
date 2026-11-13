// GravityPort React UI flow (task 412): an animated GIF opens in the viewer
// with the still preview first, then swaps to the ORIGINAL (whatever its
// size — the old rule demanded the original to be bigger than the preview)
// and actually plays: two screenshots of the viewer region, taken at least
// 300ms apart inside the isolated QA desktop shell (CDP Page.captureScreenshot,
// clipped to the media box), must differ pixel-wise.
//
// The desktop shell is the only instance reachable over CDP (the web-driver
// window has no debugging port); quiet QA mode renders it hidden with
// background throttling off (task 325/346), so the GIF keeps animating.
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runDesktopShell } from "./_animated-desktop.mjs";

// The task's screenshot destination (素材/日志 inside the codex_aigc tree);
// built from homedir() so no user name lands in the source.
const FRAME_LOG_DIR = join(homedir(), "codex_aigc", "素材", "日志");

export const name = "viewer-animated-original";
export const description = "414x414 two-frame GIF: viewer shows the still preview, swaps to the /images/ original, and two viewer-region screenshots >=300ms apart differ (log dir PNGs)";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    // Two solid frames 414x414, ~120ms each: any two captures >=300ms apart
    // land on different phases of the loop.
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

    const shots = {
      first: join(FRAME_LOG_DIR, "412-viewer-frame-1.png"),
      second: join(FRAME_LOG_DIR, "412-viewer-frame-2.png"),
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
      await captureRect(rect, shots.first);
      await sleep(350);
      await captureRect(rect, shots.second);
      return { originalPathname, rect };
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
