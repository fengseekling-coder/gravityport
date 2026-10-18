// GravityPort React UI flow (task 180): video cards show a video frame.
//
// Videos never get a generated thumbnail, so their thumbnail_url falls back
// to the mp4 itself. The gallery card and the Inspector summary must render
// it with <video> (an <img> of an mp4 is a broken icon), the frame must
// actually decode, and a play chip marks the video — but not image — cards.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "video-first-frame";
export const description = "mp4 asset -> gallery card renders <video> with a decoded frame and a play chip -> image card has neither -> Inspector summary shows the video frame and chip -> no <img> points at an mp4";

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
    if (result?.cardDecoded !== true) problems.push("video card decoded a frame");
    if (result?.cardMark !== true) problems.push("video card has the play chip");
    if (result?.imageCardClean !== true) problems.push("image card keeps <img> and has no play chip");
    if (result?.summaryVideo !== true) problems.push("Inspector summary shows the video frame and play chip");
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
    async function waitFor(check, label, timeoutMs = 15000) {
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

    const cardVideo = await waitFor(() => videoCard.querySelector('video.black-image'), 'video card renders <video>');
    await waitFor(() => cardVideo.readyState >= 2 && cardVideo.videoWidth > 0, 'video card decoded a frame'
      + ' | src=' + cardVideo.getAttribute('src') + ' | error=' + (cardVideo.error && cardVideo.error.code));
    const cardDecoded = cardVideo.videoWidth === 180 && cardVideo.videoHeight === 320 && cardVideo.muted === true;
    const cardMark = Boolean(videoCard.querySelector('.video-mark svg'));
    const imageCardClean = Boolean(imageCard.querySelector('img.black-image')) && !imageCard.querySelector('video') && !imageCard.querySelector('.video-mark');

    videoCard.click();
    await waitFor(() => (document.querySelector('.details .asset-name')?.textContent || '').includes('first-frame-clip'), 'inspector shows the clip');
    const summary = document.querySelector('.details .summary-image');
    const summaryFrame = await waitFor(() => summary.querySelector('video'), 'summary renders <video>');
    await waitFor(() => summaryFrame.readyState >= 2 && summaryFrame.videoWidth > 0, 'summary decoded a frame');
    const mark = summary.querySelector('.video-mark svg');
    const summaryVideo = !summary.querySelector('img') && Boolean(mark) && getComputedStyle(mark).opacity === '1';

    const brokenImgs = Array.from(document.querySelectorAll('img')).filter((img) => /\\.(mp4|mov|webm|m4v)(?:[?#]|$)/i.test(img.getAttribute('src') || '')).length;
    return { cardDecoded, cardMark, imageCardClean, summaryVideo, brokenImgs };
  })()`;
}
