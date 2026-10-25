// GravityPort React UI flow (task 248): videos get a real poster stored in
// the library. The fixture starts with 1.5 s of pure black, so a poster taken
// at t≈0 is black; the renderer's frame picker must skip the intro, upload
// the chosen frame, and after the SSE derivatives flush the card renders an
// <img> from thumbnails/<id>.webp — not black, still 16:9 (task 244 intact),
// still badged with the play chip. A second page load must reuse the stored
// poster without uploading again.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

export const name = "video-poster";
export const description = "black-intro mp4 -> poster generated (img, not black, 16:9, play chip) -> detail plays the original video -> second page load reuses the stored poster without re-uploading";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const videoPath = join(ctx.fixturesDir, "poster-black-intro.mp4");
    await copyFile(join(ctx.rootDir, "test", "fixtures", "video-poster", "black-intro.mp4"), videoPath);
    const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: videoPath, prompt: "video poster clip",
    });
    const assetId = created.asset.id;

    const first = await ctx.runInPage(server, pageSource(assetId, { expectUpload: true }));
    if (first?.__pageError) throw new Error(`video-poster page error: ${first.__pageError}`);
    const problems = [];
    if (first?.posterImg !== true) problems.push("card renders the stored poster <img>");
    if (first?.notBlack !== true) problems.push(`poster pixels are not black (mean luma ${first?.posterLuma})`);
    if (first?.ratio169 !== true) problems.push(`card keeps its 16:9 aspect (${first?.cardRatio})`);
    if (first?.playChip !== true) problems.push("play chip still on the video card");
    if (first?.detailPoster !== true) problems.push("inspector summary shows the poster img and play chip");
    if (first?.viewerPlaysOriginal !== true) problems.push("viewer plays the original mp4");
    if (first?.uploadedPoster !== true) problems.push("this page actually uploaded a poster");
    if (problems.length) throw new Error(`video-poster first pass: ${problems.join("; ")} — ${JSON.stringify(first)}`);

    // Server-side truth after the upload: thumbnail_path + webp thumbnail_url.
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    if (detail?.asset?.thumbnail_ready !== true || !String(detail?.asset?.thumbnail_url || "").includes("/thumbnails/")) {
      throw new Error(`server did not persist the poster: ${JSON.stringify(detail?.asset?.thumbnail_url)}`);
    }

    // Second window = a fresh renderer run (attempted-set empty). The stored
    // poster must be served without any new poster upload.
    const second = await ctx.runInPage(server, pageSource(assetId, { expectUpload: false }));
    if (second?.__pageError) throw new Error(`video-poster second page error: ${second.__pageError}`);
    const secondProblems = [];
    if (second?.posterImg !== true) secondProblems.push("card renders the stored poster <img> after reload");
    if (second?.uploadedPoster !== false) secondProblems.push("second page re-uploaded a poster");
    if (secondProblems.length) throw new Error(`video-poster second pass: ${secondProblems.join("; ")} — ${JSON.stringify(second)}`);

    return { ok: true, assetId, posterMeanLuma: first.posterLuma, firstPassUploads: first.posterPosts, secondPassUploads: second.posterPosts };
  } finally {
    await server.stop();
  }
}

function pageSource(assetId, { expectUpload }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 25000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + ' | last=' + String(last));
    }
    const posterPosts = () => performance.getEntriesByType('resource')
      .filter((entry) => /\\/api\\/assets\\/[^/]+\\/[^/]+\\/poster$/.test(entry.name)).length;
    const posterPostsAtStart = posterPosts();

    const card = await waitFor(
      () => document.querySelector('.asset-card[data-asset-id="${assetId}"]'),
      'video card mounts',
    );
    // The poster upload + SSE derivatives flush swap <video> for <img>; until
    // then the card legitimately shows the video fallback.
    const posterImg = await waitFor(() => card.querySelector('img.black-image'), 'card renders poster <img>');
    const src = posterImg.getAttribute('src') || '';
    if (!src.includes('/thumbnails/')) throw new Error('poster img src is not a thumbnail derivative: ' + src);
    await waitFor(() => posterImg.complete && posterImg.naturalWidth > 0, 'poster img decoded');

    // Sample the poster pixels: a poster stuck on the black intro would be dark.
    const canvas = document.createElement('canvas');
    canvas.width = posterImg.naturalWidth;
    canvas.height = posterImg.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(posterImg, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let luma = 0;
    for (let i = 0; i < pixels.length; i += 4) luma += 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    const posterLuma = Math.round(luma / (pixels.length / 4));
    const notBlack = posterLuma > 40;

    // Task 244 keeps video dimensions: the 640x360 fixture card stays 16:9.
    const rect = card.getBoundingClientRect();
    const cardRatio = rect.width / rect.height;
    const ratio169 = Math.abs(cardRatio - 16 / 9) < 0.06;
    const playChip = Boolean(card.querySelector('.video-mark svg'));

    // Inspector: summary shows the poster img + chip; opening it plays the
    // original mp4, never the 400px poster.
    card.click();
    await waitFor(() => (document.querySelector('.details .asset-name')?.textContent || '').length > 0, 'inspector opens');
    const summary = document.querySelector('.details .summary-image');
    await waitFor(() => summary && summary.querySelector('img'), 'summary shows poster img');
    const detailPoster = Boolean(summary.querySelector('img')) && Boolean(summary.querySelector('.video-mark svg'));
    summary.click();
    const viewerVideo = await waitFor(() => document.querySelector('.image-viewer video.viewer-image'), 'viewer plays the video');
    await waitFor(() => viewerVideo.readyState >= 1 && viewerVideo.videoWidth > 0, 'viewer video decoded metadata');
    const viewerSrc = viewerVideo.getAttribute('src') || '';
    const viewerPlaysOriginal = viewerSrc.includes('/images/') && !viewerSrc.includes('/thumbnails/');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    const uploadedPoster = posterPosts() > posterPostsAtStart;
    return {
      expectUpload: ${expectUpload},
      posterImg: true,
      posterLuma,
      notBlack,
      cardRatio: Math.round(cardRatio * 1000) / 1000,
      ratio169,
      playChip,
      detailPoster,
      viewerPlaysOriginal,
      posterPosts: posterPosts() - posterPostsAtStart,
      uploadedPoster,
    };
  })()`;
}
