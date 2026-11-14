// GravityPort React UI flow (task 413): the new formats behave like ordinary
// assets end to end. A TIFF and (on macOS) a HEIC drop into the gallery, the
// derivative worker fills their thumbnails, and the viewer keeps the 1600px
// preview forever — these originals can never render in <img>, so no zoom or
// dwell may swap them in. A ProRes MOV imports as a video asset but the
// renderer cannot decode it: the viewer must say so ("这个视频的编码 App 播放
// 不了") after its HEAD probe confirms the file is served, instead of the old
// "找不到原始文件".
import { copyFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import sharp from "sharp";

export const name = "import-tiff-heic";
export const description = "TIFF drop imports with a thumbnail and the viewer stays on /previews/ -> HEIC (macOS) likewise -> ProRes MOV viewer reports the undecodable codec, not a missing file";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  try {
    const dir = ctx.fixturesDir;
    // The HEIC rides through the system sips (macOS only); without it the flow
    // runs the TIFF and ProRes halves and skips the HEIC half honestly.
    const heicPath = join(dir, "dropped.heic");
    let heicAvailable = false;
    if (process.platform === "darwin") {
      const pngPath = join(dir, "heic-src.png");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect width="2400" height="1600" fill="#204a72"/><circle cx="1200" cy="800" r="480" fill="#e6783c"/></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(pngPath);
      await new Promise((resolveSips, rejectSips) => {
        execFile("/usr/bin/sips", ["-s", "format", "heic", pngPath, "--out", heicPath], { timeout: 30000 }, (error, _stdout, stderr) => {
          if (error) rejectSips(new Error(String(stderr || error.message)));
          else resolveSips();
        });
      });
      heicAvailable = true;
    }
    // 2400x1600 — bigger than the 1600px preview tier, so the viewer's own
    // swap-to-original rule would fire if the display gate let it through.
    const tiffPath = join(dir, "dropped.tiff");
    await sharp({ create: { width: 2400, height: 1600, channels: 3, background: { r: 40, g: 60, b: 90 } } })
      .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1600"><rect x="160" y="160" width="800" height="600" fill="#e6783c"/></svg>`), top: 0, left: 0 }])
      .tiff({ compression: "lzw" })
      .toFile(tiffPath);

    const tiffBytes = (await readFile(tiffPath)).toString("base64");
    const heicBytes = heicAvailable ? (await readFile(heicPath)).toString("base64") : "";

    // The ProRes MOV is created server-side (a plain video import) — it needs
    // no derivative, and the viewer error comes from the renderer's decoder.
    const proresPath = join(dir, "413-prores.mov");
    await copyFile(join(ctx.rootDir, "test", "fixtures", "media-signature", "prores-undecodable.mov"), proresPath);
    const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: proresPath, prompt: "prores clip the browser cannot decode",
    });
    const proresId = created.asset.id;

    const result = await ctx.runInPage(server, pageSource(proresId, tiffBytes, heicBytes, heicAvailable));
    if (result?.__pageError) throw new Error(`import-tiff-heic page error: ${result.__pageError}`);

    const problems = [];
    if (result?.tiffThumbnail !== true) problems.push("TIFF card never showed a /thumbnails/ img");
    if (result?.tiffViewerStaysPreview !== true) problems.push("TIFF viewer swapped away from the preview: " + JSON.stringify(result?.tiffViewer));
    if (result?.tiffViewer?.originalRequests !== 0) problems.push("TIFF viewer fetched the undecodable original: " + JSON.stringify(result?.tiffViewer));
    if (heicAvailable) {
      if (result?.heicThumbnail !== true) problems.push("HEIC card never showed a /thumbnails/ img");
      if (result?.heicViewerStaysPreview !== true) problems.push("HEIC viewer swapped away from the preview: " + JSON.stringify(result?.heicViewer));
      if (result?.heicViewer?.originalRequests !== 0) problems.push("HEIC viewer fetched the undecodable original: " + JSON.stringify(result?.heicViewer));
    }
    if (result?.proresImported !== true) problems.push("ProRes MOV did not import");
    if (result?.proresMessage !== "这个视频的编码 App 播放不了") problems.push("viewer message was: " + JSON.stringify(result?.proresMessage));
    if (problems.length) throw new Error(`import-tiff-heic: ${problems.join("; ")} — ${JSON.stringify(result)}`);
    return { ok: true, heicTested: heicAvailable, tiff: result.tiffViewer, heic: result.heicViewer, proresMessage: result.proresMessage };
  } finally {
    await server.stop();
  }
}

function pageSource(proresId, tiffB64, heicB64, heicAvailable) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const value = check();
          if (value) return value;
        } catch (error) { /* keep waiting */ }
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const pathOfSrc = (value) => new URL(value || "", location.href).pathname;
    const bytesToFile = (b64, name, type) => new File([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], name, { type });
    function dropOn(target, file) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      const rect = target.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, dataTransfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      let event = new DragEvent('drop', init);
      if (!event.dataTransfer) {
        event = new Event('drop', init);
        Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
      }
      target.dispatchEvent(event);
    }
    const cardFor = (name) => [...document.querySelectorAll('.asset-card[aria-label]')].find((card) => card.getAttribute('aria-label').includes(name)) || null;
    const scrollGrid = async (id) => {
      const grid = document.querySelector('.asset-grid');
      for (let step = 0; step < 60; step += 1) {
        if (document.querySelector('.asset-grid [data-asset-id="' + id + '"]')) return;
        if (grid) grid.scrollTop += 300;
        await sleep(200);
      }
    };
    // Waits until the derivative flushed (img src moved to /thumbnails/) and decoded.
    const waitForThumbnail = async (name) => {
      const card = await waitFor(() => cardFor(name), name + ' card mounts');
      const img = await waitFor(() => {
        const image = card.querySelector('img');
        return image && (image.getAttribute('src') || '').includes('/thumbnails/') ? image : null;
      }, name + ' thumbnail img');
      await waitFor(() => img.complete && img.naturalWidth > 0, name + ' thumbnail decoded');
      return true;
    };
    const checkViewerStaysPreview = async (name) => {
      const card = cardFor(name);
      card.scrollIntoView({ block: 'center' });
      performance.clearResourceTimings();
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const media = await waitFor(() => document.querySelector('.image-viewer img.viewer-image'), name + ' viewer opens');
      await waitFor(() => media.complete && media.naturalWidth > 0, name + ' viewer preview decoded');
      const startSrc = pathOfSrc(media.getAttribute('src'));
      const observed = [];
      const observer = new MutationObserver(() => observed.push(pathOfSrc(media.getAttribute('src'))));
      observer.observe(media, { attributes: true, attributeFilter: ['src'] });
      // Zoom beyond the preview and give the 200ms fit-wait plenty of slack:
      // a swapped original would show up as a second src write, and the
      // original fetch itself would land in the resource timings. Any /images/
      // request while this viewer is open means the gate let an undecodable
      // original through.
      const zoomOneToOne = () => Array.from(document.querySelectorAll('.viewer-controls button')).find((button) => button.title === '实际大小');
      const zoomIn = () => document.querySelector('.viewer-controls button[aria-label="放大"]');
      zoomOneToOne().click();
      await sleep(300);
      zoomIn().click();
      await sleep(400);
      zoomIn().click();
      await sleep(800);
      observer.disconnect();
      const finalSrc = pathOfSrc(media.getAttribute('src'));
      const originalRequests = performance.getEntriesByType('resource')
        .filter((entry) => pathOfSrc(entry.name).includes('/images/')).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await waitFor(() => !document.querySelector('.image-viewer'), name + ' viewer closes');
      return {
        staysPreview: startSrc.includes('/previews/') && finalSrc === startSrc && observed.every((src) => src === startSrc),
        originalRequests,
        startSrc, finalSrc, observed: [...new Set(observed)],
      };
    };

    // The ProRes asset is created before the page loads, so the library is not
    // empty — wait for the app shell, not the empty state.
    await waitFor(() => document.querySelector('.app'), 'app shell ready');
    const workspace = document.querySelector('.workspace');

    dropOn(workspace, bytesToFile(${JSON.stringify(tiffB64)}, 'dropped.tiff', 'image/tiff'));
    if (${heicAvailable}) dropOn(workspace, bytesToFile(${JSON.stringify(heicB64)}, 'dropped.heic', 'image/heic'));
    const scenes = {};
    scenes.tiffThumbnail = await waitForThumbnail('dropped.tiff');
    if (${heicAvailable}) scenes.heicThumbnail = await waitForThumbnail('dropped.heic');

    scenes.tiffViewer = await checkViewerStaysPreview('dropped.tiff');
    scenes.tiffViewerStaysPreview = scenes.tiffViewer.staysPreview;
    if (${heicAvailable}) {
      scenes.heicViewer = await checkViewerStaysPreview('dropped.heic');
      scenes.heicViewerStaysPreview = scenes.heicViewer.staysPreview;
    }

    // The ProRes video: its src must fail to decode, the HEAD probe must say
    // the file is served, and the stage must blame the codec — not the file.
    await scrollGrid(${JSON.stringify(proresId)});
    const videoCard = await waitFor(() => document.querySelector('.asset-card[data-asset-id="${proresId}"]'), 'prores card mounts');
    videoCard.scrollIntoView({ block: 'center' });
    videoCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => document.querySelector('.image-viewer'), 'viewer opens for the video');
    const message = await waitFor(() => {
      const stage = document.querySelector('.viewer-missing p');
      return stage ? stage.textContent : null;
    }, 'viewer error message appears');
    scenes.proresImported = true;
    scenes.proresMessage = message;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return scenes;
  })().catch((error) => ({ __pageError: String(error && error.message ? error.message : error) }))
  `;
}
