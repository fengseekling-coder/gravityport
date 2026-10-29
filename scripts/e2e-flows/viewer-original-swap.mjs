// GravityPort React UI flow (task 295): the viewer keeps the preview while the
// preview already has enough pixels for the view, and swaps in the original
// only after it decodes. Fit mode waits 200ms first, so quick arrow-key flips
// never pull the originals. Device pixel ratio is pinned per scene through
// window.devicePixelRatio (the value the viewer reads), since the web driver
// window has no CDP session.
import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

export const name = "viewer-original-swap";
export const description = "1x fit keeps the preview (no original request) -> 1:1 swaps to the decoded original with unchanged geometry -> 2x fit swaps after its 200ms wait -> small image never requests its original -> fast arrow flips at 2x request no originals before settling -> video src untouched";

const BIG = { width: 4800, height: 3200 };
const SMALL = { width: 1200, height: 800 };
const FLIP_STEMS = ["vos-flip-1", "vos-flip-2", "vos-flip-3", "vos-flip-4", "vos-flip-5"];
const VIDEO_FIXTURE = join("test", "fixtures", "viewer-video-controls", "portrait.mp4");

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    // Oldest first: the gallery lists newest first, so the seeded cards sit
    // near the top of the grid in the order the scenes need them.
    const ids = {};
    for (const stem of ["vos-clip", ...FLIP_STEMS, "vos-small", "vos-big"]) {
      if (stem === "vos-clip") {
        const clipPath = join(ctx.fixturesDir, "vos-clip.mp4");
        await copyFile(join(ctx.rootDir, VIDEO_FIXTURE), clipPath);
        ids[stem] = (await ctx.api(server.origin, "POST", "/api/assets/create", {
          projectId: "default", imagePath: clipPath, prompt: "viewer original swap clip",
        })).asset.id;
        continue;
      }
      const size = stem === "vos-small" ? SMALL : BIG;
      const imagePath = await makeGradientPng(ctx, `${stem}.png`, size);
      ids[stem] = (await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default", imagePath, prompt: `viewer original swap ${stem}`,
      })).asset.id;
    }

    const assets = {};
    for (const stem of Object.keys(ids)) {
      const asset = await waitForReady(ctx, server, ids[stem], stem !== "vos-clip");
      assets[stem] = {
        id: ids[stem],
        preview: pathOf(asset.preview_url || asset.image_url, server.origin),
        original: pathOf(asset.image_url, server.origin),
      };
    }

    // A taller window gives fit mode a scale (about 0.2) at which 2x needs more
    // device pixels than the preview holds; the default 1280x800 tops out near 0.15.
    const result = await ctx.runInPage(server, `(${viewerScenes.toString()})(${JSON.stringify({ assets, bigEdge: BIG.width, smallEdge: SMALL.width, flipStems: FLIP_STEMS })})`, { windowSize: [1440, 1000] });
    if (result?.pageError) throw new Error(`viewer-original-swap page error: ${result.pageError}`);

    const problems = [];
    const expect = (condition, message) => { if (condition !== true) problems.push(message); };
    const fit1x = result.fit1x;
    expect(fit1x.needEdge <= 1600 * 1.05, `precondition: 1x fit needs ${fit1x.needEdge} device px, must be <= 1680`);
    expect(fit1x.previewShown === true, `1x fit must keep the preview, src is ${fit1x.src}`);
    const oneToOne = result.oneToOne;
    expect(oneToOne.swapped === true, "1:1 never swapped to the original within 2s");
    expect(oneToOne.swapCount === 1, `expected one src change to the original, saw ${oneToOne.swapCount}`);
    expect(oneToOne.snapshot?.complete === true && oneToOne.snapshot?.naturalWidth > 0, `src changed before the original was decoded: ${JSON.stringify(oneToOne.snapshot)}`);
    expect(oneToOne.naturalWidth === BIG.width, `original naturalWidth ${oneToOne.naturalWidth} (want ${BIG.width})`);
    const pre = oneToOne.snapshot?.preSwap;
    expect(pre && pre.width && pre.width === oneToOne.snapshot.width && pre.height === oneToOne.snapshot.height, `geometry moved on swap: ${JSON.stringify(pre)} -> ${JSON.stringify(oneToOne.snapshot)}`);
    expect(pre && pre.zoom === oneToOne.snapshot.zoom, `zoom text moved on swap: ${JSON.stringify(pre)} -> ${oneToOne.snapshot?.zoom}`);
    expect(oneToOne.styleAfterSwap === 0, `${oneToOne.styleAfterSwap} style write(s) after the swap`);
    expect(oneToOne.after.width === oneToOne.snapshot?.width && oneToOne.after.zoom === oneToOne.snapshot?.zoom, `geometry after swap ${JSON.stringify(oneToOne.after)}`);
    const fit2x = result.fit2x;
    expect(fit2x.needEdge > 1600 * 1.05, `precondition: 2x fit needs ${fit2x.needEdge} device px, must be > 1680`);
    expect(fit2x.swapped === true, "2x fit never swapped to the original");
    expect(fit2x.naturalWidth === BIG.width, `2x original naturalWidth ${fit2x.naturalWidth}`);
    expect(result.small.originalRequests === 0, `small image requested its original ${result.small.originalRequests} time(s)`);
    expect(result.small.previewShown === true, "small image left its preview");
    expect(result.flips.needEdge > 1600 * 1.05, `precondition: flip view needs ${result.flips.needEdge} device px, must be > 1680`);
    expect(result.flips.unmatched === 0 && result.flips.visitedCount === 5, `flip visited ${result.flips.visitedCount} images (${result.flips.unmatched} unmatched), want 5`);
    expect(result.flips.earlyRequests === 0, `fast flips pulled ${result.flips.earlyRequests} original(s) before the viewer settled`);
    expect(result.video.isVideo === true && result.video.srcUnchanged === true && result.video.stillMounted === true, `video changed: ${JSON.stringify(result.video)}`);
    if (problems.length) throw new Error(`viewer-original-swap: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true, fit1x, oneToOne: { swapMs: oneToOne.swapMs, naturalWidth: oneToOne.naturalWidth }, fit2x: { swapMs: fit2x.swapMs, needEdge: fit2x.needEdge }, small: result.small, flips: result.flips, video: result.video };
  } finally {
    await server.stop();
  }
}

async function makeGradientPng(ctx, fileName, { width, height }) {
  const filePath = join(ctx.fixturesDir, fileName);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a7fb5"/><stop offset="1" stop-color="#e6783c"/></linearGradient></defs>`
    + `<rect width="${width}" height="${height}" fill="url(#g)"/>`
    + `<circle cx="${width / 2}" cy="${height / 2}" r="${height / 4}" fill="#141e2a"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(filePath);
  return filePath;
}

function pathOf(url, origin) {
  return new URL(url, origin).pathname;
}

async function waitForReady(ctx, server, assetId, needsPreview) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    const asset = detail?.asset || {};
    const fields = asset.business_fields || {};
    const dimsReady = Number(fields.width) > 100 && Number(fields.height) > 100;
    if (dimsReady && (!needsPreview || asset.preview_ready === true)) return asset;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`asset ${assetId} never became ready (preview and dimensions) — derivative worker did not run`);
}

// Runs inside the web driver window. Serialized with Function#toString, so it
// must stay self-contained: no imports, no closures over node-side values.
function viewerScenes(config) {
  return (async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        try { last = check(); } catch (error) { last = String(error); }
        if (last) return last;
        await sleep(40);
      }
      throw new Error("Timed out waiting for " + label + " | last=" + String(last));
    }
    async function settles(check, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try { if (check()) return true; } catch (error) { /* keep polling */ }
        await sleep(40);
      }
      return false;
    }
    const pathOfSrc = (value) => new URL(value || "", location.href).pathname;
    const setDpr = (value) => Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => value });
    const zoomText = () => (document.querySelector(".viewer-controls output")?.textContent || "").trim();
    const zoomPercent = () => parseInt(zoomText(), 10) / 100;
    const viewerMedia = () => document.querySelector(".image-viewer .viewer-image");
    const oneToOneButton = () => Array.from(document.querySelectorAll(".viewer-controls button")).find((button) => button.title === "原始尺寸");
    const zoomInButton = () => document.querySelector('.viewer-controls button[aria-label="放大"]');
    const requestsTo = (path) => performance.getEntriesByType("resource").filter((entry) => pathOfSrc(entry.name) === path).length;
    const closeViewer = async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await waitFor(() => !document.querySelector(".image-viewer"), "viewer closed");
    };
    // Gallery virtualizes rows, so scroll the grid until the card is mounted.
    const findCard = async (id) => {
      const grid = document.querySelector(".asset-grid");
      for (let step = 0; step < 60; step += 1) {
        const card = document.querySelector('.asset-grid [data-asset-id="' + id + '"]');
        if (card) return card;
        if (grid) grid.scrollTop += 300;
        await sleep(250);
      }
      throw new Error("card never mounted for " + id);
    };
    const openViewer = async (id) => {
      const card = await findCard(id);
      card.scrollIntoView({ block: "center" });
      card.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      const media = await waitFor(() => viewerMedia(), "viewer media for " + id);
      await waitFor(() => (media.tagName === "VIDEO" ? media.readyState >= 1 : media.complete && media.naturalWidth > 0), "first frame for " + id);
      return media;
    };
    await waitFor(() => document.querySelector(".asset-grid"), "gallery grid");

    try {
      const { assets, bigEdge, smallEdge, flipStems } = config;
      const big = assets["vos-big"];
      const small = assets["vos-small"];
      const clip = assets["vos-clip"];
      const scenes = {};

      // Scene 1: 1x, fit. The preview stays on screen; then 1:1 swaps to the original.
      setDpr(1);
      const bigMedia = await openViewer(big.id);
      await sleep(1200);
      const fitSrc = bigMedia.getAttribute("src") || "";
      const fitZoom = zoomText();
      scenes.fit1x = {
        src: fitSrc,
        previewShown: pathOfSrc(fitSrc) === big.preview,
        zoom: fitZoom,
        needEdge: bigEdge * (parseInt(fitZoom, 10) / 100) * window.devicePixelRatio,
      };
      // Reverse check 2 lives here: the MutationObserver reads complete and
      // naturalWidth at the instant src becomes the original. Geometry is taken
      // from the last style write before the swap (the 1:1 render); the swap
      // itself must write no style at all.
      const swaps = [];
      let lastStyle = null;
      let swapSeen = false;
      let styleAfterSwap = 0;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          const element = record.target;
          if (!element.classList.contains("viewer-image")) continue;
          if (record.attributeName === "style") {
            if (swapSeen) styleAfterSwap += 1;
            lastStyle = { width: element.style.width, height: element.style.height, zoom: zoomText() };
            continue;
          }
          if (pathOfSrc(element.getAttribute("src")) !== big.original) continue;
          swapSeen = true;
          swaps.push({ complete: element.complete, naturalWidth: element.naturalWidth, preSwap: lastStyle, width: element.style.width, height: element.style.height, zoom: zoomText() });
        }
      });
      observer.observe(document.querySelector(".image-viewer"), { subtree: true, attributes: true, attributeFilter: ["src", "style"] });
      oneToOneButton().click();
      const swapStarted = performance.now();
      const swapped = await settles(() => pathOfSrc(bigMedia.getAttribute("src")) === big.original && bigMedia.complete && bigMedia.naturalWidth > 0, 2000);
      const swapMs = Math.round(performance.now() - swapStarted);
      await sleep(150);
      observer.disconnect();
      scenes.oneToOne = {
        swapped,
        swapMs,
        swapCount: swaps.length,
        snapshot: swaps[0] || null,
        styleAfterSwap,
        after: { width: bigMedia.style.width, height: bigMedia.style.height, zoom: zoomText() },
        naturalWidth: bigMedia.naturalWidth,
      };
      await closeViewer();

      // Scene 2: 2x, fit. The preview cannot hold the device pixels, so the
      // original takes over after the 200ms fit wait.
      setDpr(2);
      const bigAgain = await openViewer(big.id);
      await sleep(300);
      const fit2xZoom = zoomText();
      const fit2xNeed = bigEdge * (parseInt(fit2xZoom, 10) / 100) * window.devicePixelRatio;
      const fit2xSwapped = await settles(() => pathOfSrc(bigAgain.getAttribute("src")) === big.original && bigAgain.complete && bigAgain.naturalWidth > 0, 3000);
      scenes.fit2x = { zoom: fit2xZoom, needEdge: fit2xNeed, swapped: fit2xSwapped, naturalWidth: bigAgain.naturalWidth };
      await closeViewer();

      // Scene 3: a 1200x800 image whose preview is no bigger than the original
      // never requests the original, however far it is zoomed.
      setDpr(2);
      performance.clearResourceTimings();
      const smallMedia = await openViewer(small.id);
      await sleep(300);
      oneToOneButton().click();
      await sleep(300);
      zoomInButton().click();
      await sleep(250);
      zoomInButton().click();
      await sleep(500);
      scenes.small = {
        zoom: zoomText(),
        previewShown: pathOfSrc(smallMedia.getAttribute("src")) === small.preview,
        originalRequests: requestsTo(small.original),
        edge: smallEdge,
      };
      await closeViewer();

      // Scene 4: fast flips at 2x, one every 50ms. The viewer must not pull the
      // originals of the images it passes through.
      setDpr(2);
      performance.clearResourceTimings();
      const flipAssets = flipStems.map((stem) => assets[stem]);
      // No dwell before the first flip: the first image must not sit for the
      // 200ms fit wait. Same window and same 4800px size as scene 2, so its
      // device-pixel need is the one measured there.
      await openViewer(flipAssets[0].id);
      const flipNeedEdge = fit2xNeed;
      const visited = [];
      const visitedPreview = [];
      const visitAt = [];
      const recordVisited = () => {
        const preview = pathOfSrc(viewerMedia().getAttribute("src"));
        // The gallery neighbours are not only flip images (the clip and the
        // small image sit between them), so every seeded asset is matched.
        const hit = Object.values(assets).find((asset) => asset.preview === preview || asset.original === preview);
        visited.push(hit ? hit.original : null);
        visitedPreview.push(preview);
        visitAt.push(Math.round(performance.now()));
      };
      recordVisited();
      for (let step = 0; step < 4; step += 1) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        await sleep(50);
        recordVisited();
      }
      await sleep(900);
      const earlyRequests = visited.slice(0, -1).reduce((sum, path) => sum + (path ? requestsTo(path) : 0), 0);
      const lastRequests = visited[visited.length - 1] ? requestsTo(visited[visited.length - 1]) : 0;
      const requestStarts = performance.getEntriesByType("resource").filter((entry) => Object.values(assets).some((asset) => asset.original === pathOfSrc(entry.name)))
        .map((entry) => ({ at: Math.round(entry.startTime), path: pathOfSrc(entry.name) }));
      scenes.flips = {
        needEdge: flipNeedEdge,
        visitedCount: new Set(visited.filter(Boolean)).size,
        unmatched: visited.filter((path) => !path).length,
        visitedPreview,
        earlyRequests,
        lastRequests,
        visitAt,
        requestStarts: requestStarts.map((item) => ({ at: item.at, index: visited.indexOf(item.path) })),
      };
      await closeViewer();

      // Scene 5: video. Its source must not be swapped for anything.
      setDpr(2);
      const videoEl = await openViewer(clip.id);
      const videoSrc = videoEl.getAttribute("src");
      oneToOneButton().click();
      await sleep(300);
      zoomInButton().click();
      await sleep(600);
      scenes.video = {
        isVideo: videoEl.tagName === "VIDEO",
        srcUnchanged: videoEl.getAttribute("src") === videoSrc,
        stillMounted: viewerMedia() === videoEl,
        zoom: zoomText(),
      };
      await closeViewer();
      return scenes;
    } catch (error) {
      return { pageError: String(error && error.message ? error.message : error) };
    }
  })();
}
