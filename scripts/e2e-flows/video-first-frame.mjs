// GravityPort React UI flow (task 180, updated by task 248): video cards show
// a stored poster frame. The renderer extracts a poster from the mp4 (see
// video-poster.ts), the library re-encodes it to thumbnails/<id>.webp, and
// after the derivatives flush the gallery card and the Inspector summary
// render it with <img> — never an <img> pointing at the mp4 itself — while a
// play chip still marks the video card but not the image card. The
// black-intro skipping and pixel-level poster checks live in the
// video-poster flow; this one pins the rendering contract.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "video-first-frame";
export const description = "mp4 asset -> gallery card renders the stored poster <img> with a play chip -> image card has neither -> Inspector summary shows the poster img and chip -> no <img> points at an mp4";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const videoPath = join(ctx.fixturesDir, "first-frame-clip.mp4");
    await copyFile(join(ctx.rootDir, "test", "fixtures", "video-first-frame.mp4"), videoPath);
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: videoPath, prompt: "video first frame clip",
    });
    await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: await ctx.makePng("first-frame-still.png", [181, 127, 74]), prompt: "video first frame still",
    });
    const result = await ctx.runInPage(server, videoFrameSource());
    if (result?.__pageError) throw new Error(`video-first-frame page error: ${result.__pageError}`);
    const problems = [];
    if (result?.cardPoster !== true) problems.push("video card renders the stored poster <img>");
    if (result?.cardMark !== true) problems.push("video card has the play chip");
    if (result?.imageCardClean !== true) problems.push("image card keeps <img> and has no play chip");
    if (result?.summaryPoster !== true) problems.push("Inspector summary shows the poster img and play chip");
    if (result?.brokenImgs !== 0) problems.push(`${result?.brokenImgs} <img> elements point at an mp4`);
    if (problems.length) throw new Error(`video-first-frame result: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true };
  } finally {
    await server.stop();
  }
}

function videoFrameSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label + ' | last=' + String(last));
    }
    const cards = () => Array.from(document.querySelectorAll('.asset-card'));
    const cardFor = (namePart) => cards().find((c) => (c.getAttribute('aria-label') || '').includes(namePart));
    await waitFor(() => cards().length === 2, 'two seeded cards');
    const videoCard = cardFor('first-frame-clip');
    const imageCard = cardFor('first-frame-still');
    if (!videoCard || !imageCard) throw new Error('cards: ' + JSON.stringify(cards().map((c) => c.getAttribute('aria-label'))));

    // Until the poster lands the card legitimately renders the <video>
    // fallback; the poster upload + derivatives flush swap it for <img>.
    const cardImg = await waitFor(() => videoCard.querySelector('img.black-image'), 'video card renders the poster <img>');
    const src = cardImg.getAttribute('src') || '';
    if (!src.includes('/thumbnails/')) throw new Error('poster img src is not a thumbnail derivative: ' + src);
    await waitFor(() => cardImg.complete && cardImg.naturalWidth > 0, 'poster img decoded');
    const cardPoster = true;
    const cardMark = Boolean(videoCard.querySelector('.video-mark svg'));
    const imageCardClean = Boolean(imageCard.querySelector('img.black-image')) && !imageCard.querySelector('video') && !imageCard.querySelector('.video-mark');

    videoCard.click();
    await waitFor(() => (document.querySelector('.details .asset-name')?.textContent || '').includes('first-frame-clip'), 'inspector shows the clip');
    const summary = document.querySelector('.details .summary-image');
    await waitFor(() => summary && summary.querySelector('img'), 'summary renders the poster <img>');
    const mark = summary.querySelector('.video-mark svg');
    const summaryPoster = Boolean(summary.querySelector('img')) && Boolean(mark) && getComputedStyle(mark).opacity === '1';

    const brokenImgs = Array.from(document.querySelectorAll('img')).filter((img) => /\\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(img.getAttribute('src') || '')).length;
    return { cardPoster, cardMark, imageCardClean, summaryPoster, brokenImgs };
  })()`;
}
