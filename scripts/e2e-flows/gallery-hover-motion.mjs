// GravityPort React UI flow (task 412): gallery cards play their ORIGINAL
// media while the pointer rests on them, and go back to the still thumbnail
// when it leaves.
//
//   - animated GIF card: the <img> swaps to the /images/ original (srcset
//     dropped) after hover, and back to the /thumbnails/ row (srcset back)
//     after the pointer leaves; the play mark is there from the start.
//   - static PNG card: hovering never touches its src.
//   - video card: a <video> plays (paused === false) while hovered and no
//     video plays after the pointer leaves.
//
// Hovers are trusted CDP mouse moves against the QA desktop shell (quiet QA
// renders hidden with throttling off — task 325/346); the harness lives in
// _animated-desktop.mjs.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { runDesktopShell } from "./_animated-desktop.mjs";

const VIDEO_FIXTURE = join("test", "fixtures", "viewer-video-controls", "portrait.mp4");

export const name = "gallery-hover-motion";
export const description = "hover plays the GIF card's /images/ original (srcset dropped) and restores the thumbnail row on leave; a static PNG never swaps; a hovered video card plays (paused=false) and stops on leave";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    const makeFrame = (color) => sharp({ create: { width: 414, height: 414, channels: 3, background: color } }).png().toBuffer();
    const gifPath = join(ctx.fixturesDir, "hover-animated.gif");
    await sharp([await makeFrame({ r: 214, g: 61, b: 46 }), await makeFrame({ r: 52, g: 101, b: 214 })], {
      join: { animated: true, delay: [120, 120] },
    }).gif().toFile(gifPath);
    const staticPath = await ctx.makePng("hover-static.png", [74, 127, 181], { width: 300, height: 200 });
    const videoPath = join(ctx.fixturesDir, "hover-clip.mp4");
    await copyFile(join(ctx.rootDir, VIDEO_FIXTURE), videoPath);

    const seeds = {};
    for (const [stem, imagePath] of [["gif", gifPath], ["png", staticPath], ["video", videoPath]]) {
      seeds[stem] = (await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath, prompt: `gallery hover motion ${stem}`,
      })).asset.id;
    }
    // The GIF must carry the stamped flag, or the card would never get its
    // motion props.
    const gifReady = await waitFor(ctx, server, seeds.gif, { animated: true });
    if (gifReady.business_fields?.animated !== true) {
      throw new Error(`derivative run did not stamp $.animated for the GIF: ${JSON.stringify(gifReady.business_fields)}`);
    }
    await waitFor(ctx, server, seeds.png);
    await waitFor(ctx, server, seeds.video);

    // Layer 2 gets its own single writer: the desktop shell opens the same
    // library directory, so the main server stops first.
    await server.stop();
    serverRunning = false;

    const result = await runDesktopShell(ctx, async ({ evaluate, waitForValue, sleep, mouseMove, pointOf }) => {
      await waitForValue(`document.querySelectorAll('.asset-card[data-asset-id]').length >= 3`, "three seeded cards");

      // Neutral parking spot for "pointer left": the toolbar band above the
      // grid holds no cards, so no motion listener fires there.
      const parkPoint = { x: 3, y: 3 };
      const cardImage = (id) => `document.querySelector('.asset-card[data-asset-id="${id}"] img')`;
      const srcOf = (id) => `(() => { const img = ${cardImage(id)}; return img ? new URL(img.getAttribute('src') || '', location.href).pathname : null; })()`;

      // --- animated GIF card ---
      await waitForValue(`Boolean(${cardImage(seeds.gif)})`, "the GIF card image");
      const thumbnailSrc = await evaluate(srcOf(seeds.gif));
      if (!thumbnailSrc || !thumbnailSrc.includes("/thumbnails/")) {
        throw new Error(`the GIF card did not start on its thumbnail row: ${JSON.stringify(thumbnailSrc)}`);
      }
      const markShown = await evaluate(`(() => {
        const card = document.querySelector('.asset-card[data-asset-id="${seeds.gif}"]');
        return Boolean(card?.querySelector('.video-mark'));
      })()`);
      if (markShown !== true) throw new Error("the animated card is missing its play mark before any hover");
      const srcSetBefore = await evaluate(`${cardImage(seeds.gif)}.getAttribute('srcset')`);
      if (!srcSetBefore) throw new Error("the GIF card started without a srcset");

      await mouseMove(await pointOf(`.asset-card[data-asset-id="${seeds.gif}"]`));
      const hoverSrc = await waitForValue(`(() => {
        const img = ${cardImage(seeds.gif)};
        const path = new URL(img.getAttribute('src') || '', location.href).pathname;
        return path.includes('/images/') && !img.getAttribute('srcset') ? path : null;
      })()`, "the GIF card swapping to its original", 8000);
      await sleep(150);
      const sizesWhileHover = await evaluate(`${cardImage(seeds.gif)}.getAttribute('sizes')`);
      if (sizesWhileHover !== null) throw new Error(`sizes stayed while playing: ${JSON.stringify(sizesWhileHover)}`);

      await mouseMove(parkPoint);
      const restored = await waitForValue(`(() => {
        const img = ${cardImage(seeds.gif)};
        const path = new URL(img.getAttribute('src') || '', location.href).pathname;
        return path === ${JSON.stringify(thumbnailSrc)} && img.getAttribute('srcset') ? path : null;
      })()`, "the GIF card restoring its thumbnail row", 8000);
      if (restored !== thumbnailSrc) throw new Error(`the restored src ${JSON.stringify(restored)} is not the original thumbnail row ${JSON.stringify(thumbnailSrc)}`);

      // --- static PNG card: hover never swaps anything ---
      const pngSrcBefore = await evaluate(srcOf(seeds.png));
      if (!pngSrcBefore || !pngSrcBefore.includes("/thumbnails/")) {
        throw new Error(`the PNG card did not start on its thumbnail row: ${JSON.stringify(pngSrcBefore)}`);
      }
      await mouseMove(await pointOf(`.asset-card[data-asset-id="${seeds.png}"]`));
      await sleep(700);
      const pngSrcAfter = await evaluate(srcOf(seeds.png));
      if (pngSrcAfter !== pngSrcBefore) {
        throw new Error(`hovering the static PNG changed its src: ${JSON.stringify(pngSrcBefore)} -> ${JSON.stringify(pngSrcAfter)}`);
      }
      await mouseMove(parkPoint);
      await sleep(150);

      // --- video card: hover plays, leave stops ---
      await mouseMove(await pointOf(`.asset-card[data-asset-id="${seeds.video}"]`));
      const played = await waitForValue(`(() => {
        const card = document.querySelector('.asset-card[data-asset-id="${seeds.video}"]');
        const video = Array.from(card.querySelectorAll('video')).find((entry) => entry.paused === false && !entry.ended);
        return video ? { paused: video.paused, muted: video.muted } : null;
      })()`, "a playing video inside the hovered video card", 8000);
      await mouseMove(parkPoint);
      const stopped = await waitForValue(`(() => {
        const card = document.querySelector('.asset-card[data-asset-id="${seeds.video}"]');
        return card.querySelectorAll('video').length === 0
          || Array.from(card.querySelectorAll('video')).every((entry) => entry.paused === true);
      })()`, "no video still playing after the pointer left", 8000);
      return { hoverSrc, played, stopped, restored };
    });

    const problems = [];
    if (result.hoverSrc?.includes("/images/") !== true) problems.push(`hover src ${JSON.stringify(result.hoverSrc)}`);
    if (result.played?.paused !== false) problems.push(`no playing video on hover (${JSON.stringify(result.played)})`);
    if (result.stopped !== true) problems.push("video still playing after leave");
    if (problems.length) throw new Error(`gallery-hover-motion: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true, ...result };
  } finally {
    if (serverRunning) await server.stop().catch(() => {});
  }
}

async function waitFor(ctx, server, assetId, { animated = false } = {}) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    const asset = detail?.asset || {};
    const fields = asset.business_fields || {};
    const dimsReady = Number(fields.width) > 100 && Number(fields.height) > 100;
    if (dimsReady && (!animated || fields.animated === true)) return asset;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`asset ${assetId} never became ready (dimensions${animated ? " + animated flag" : ""}) — derivative worker did not run`);
}
