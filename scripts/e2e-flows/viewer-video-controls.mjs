// GravityPort React UI flow (task 254): the viewer's native video controls are
// actually reachable and "fit" clears the floating zoom bar.
//
// Two layers, because they need different windows:
// - Web-driver windows (ctx.runInPage) assert the DOM-level contract at two
//   window sizes: video pointer-events restored (images keep theirs), native
//   control attributes, video/image fit bottom above the zoom bar, double-click
//   on the video not toggling zoom while the stage still toggles, wheel zoom
//   still bubbling from the video, arrow navigation intact.
// - Pressing on the video must not setPointerCapture the stage (that would
//   starve the native scrubber), and a real double-click must not enter any
//   fullscreen. Synthetic events cannot exercise pointer capture, and hidden
//   web-driver windows never paint, so the trusted-input checks AND the three
//   screenshots run against the real desktop shell (task-229 QA windows are
//   showInactive, i.e. rendered) via CDP, the desktop-input way.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

const VIDEO_CARD_LABEL = "portrait";
const IMAGE_CARD_LABEL = "viewer-video-still";
const GROUP_NAME = "e2e-254 分组";

export const name = "viewer-video-controls";
export const description = "native video controls reachable (pointer-events, no pan/dblclick hijack, controlsList, no PiP, no native fullscreen) -> fit clears the zoom bar for video and image at 1280x800 and 1100x700 -> property tags wrap without overlap -> 3 screenshots";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    const videoPath = join(ctx.fixturesDir, "portrait.mp4");
    await copyFile(join(ctx.rootDir, "test", "fixtures", "viewer-video-controls", "portrait.mp4"), videoPath);
    const videoAsset = (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: videoPath, prompt: "viewer video controls clip",
    })).asset;
    const imageAssetPath = await ctx.makePng(`${IMAGE_CARD_LABEL}.png`, [74, 127, 181], { width: 1080, height: 1542 });
    const imageAsset = (await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default", imagePath: imageAssetPath, prompt: "viewer video controls still",
    })).asset;
    // The 6th property tag (分组) only renders when the asset carries a group.
    await ctx.api(server.origin, "POST", "/api/groups", { projectId: "default", name: GROUP_NAME });
    const batch = await ctx.api(server.origin, "POST", "/api/assets/batch", {
      action: "group", projectId: "default", assetIds: [videoAsset.id], group: GROUP_NAME,
    });
    const confirmed = (batch?.results || []).filter((item) => item.ok !== false).length;
    if (confirmed !== 1) throw new Error(`group batch did not confirm the video: ${JSON.stringify(batch)}`);

    // Fresh assets sit at 1x1 placeholders until the derivative worker backfills
    // real dimensions; the viewer's fit math needs them on first render (the
    // hidden e2e window short-circuits live SSE).
    await Promise.all([videoAsset, imageAsset].map((asset) => waitForRealDims(ctx, server, asset.id)));

    // Layer 1: web-driver windows, the task's two viewport sizes.
    for (const [index, windowSize] of [[1, [1280, 800]], [2, [1100, 700]]]) {
      const result = await ctx.runInPage(server, pageSource(), { windowSize });
      if (result?.__pageError) throw new Error(`viewer-video-controls page error (pass ${index}): ${result.__pageError}`);
      assertPageResult(result, `pass ${index} @ ${windowSize.join("x")}`, { full: index === 1 });
    }

    // Layer 2 gets its own single writer: the desktop shell opens the same
    // library directory, so the main server stops first.
    await server.stop();
    serverRunning = false;
    const desktop = await runDesktopPhase(ctx);
    return {
      ok: true,
      screenshots: desktop.screenshots,
      videoTags: desktop.videoTags,
      imageTags: desktop.imageTags,
      nativeFsButton: desktop.nativeFsButton,
      sizeLabelNote: `video 大小 cell shows ${JSON.stringify(desktop.videoTags?.sizeLabel)} (the server never writes a file size)`,
    };
  } finally {
    if (serverRunning) await server.stop().catch(() => {});
  }
}

async function waitForRealDims(ctx, server, assetId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(assetId)}`);
    const fields = detail?.asset?.business_fields || {};
    if (Number(fields.width) > 100 && Number(fields.height) > 100) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`asset ${assetId} dimensions were never backfilled — derivative worker did not run`);
}

function assertPageResult(result, label, { full }) {
  const problems = [];
  const expect = (condition, message) => { if (condition !== true) problems.push(message); };
  expect(result.videoPointerEvents !== "none", `video pointer-events is ${JSON.stringify(result.videoPointerEvents)}`);
  expect(result.imagePointerEvents === "none", `image pointer-events is ${JSON.stringify(result.imagePointerEvents)}`);
  expect(result.fitClearsBarVideo === true, `video fit bottom overlaps the zoom bar (gap ${result.fitGapVideo}px)`);
  expect(result.fitClearsBarImage === true, `image fit bottom overlaps the zoom bar (gap ${result.fitGapImage}px)`);
  expect(result.fitGapVideo > 0, `video fit gap ${result.fitGapVideo}px is not positive (check is vacuous)`);
  expect(result.fitGapImage > 0, `image fit gap ${result.fitGapImage}px is not positive (check is vacuous)`);
  if (full) {
    expect(result.controlsAttr === true, "video lost the controls attribute");
    expect(result.controlsList.includes("nofullscreen"), `controlsList missing nofullscreen (${JSON.stringify(result.controlsList)})`);
    expect(result.controlsList.includes("nodownload"), `controlsList missing nodownload (${JSON.stringify(result.controlsList)})`);
    expect(result.controlsList.includes("noremoteplayback"), `controlsList missing noremoteplayback (${JSON.stringify(result.controlsList)})`);
    expect(result.disablePip === true, "video missing disablepictureinpicture");
    expect(result.dblclickOnVideoKeepsZoom === true, `double-click on the video changed zoom (${result.zoomBefore} -> ${result.zoomAfterVideoDblclick})`);
    expect(result.dblclickOnStageTogglesZoom === true, `double-click on the stage no longer toggles zoom (${result.zoomBefore} -> ${result.zoomAfterStageDblclick})`);
    expect(result.wheelOnVideoZooms === true, `wheel over the video no longer zooms (${result.zoomAfterWheel})`);
    expect(result.fitStillClearsAfterRound === true, `fit geometry drifted after the zoom round (gap ${result.fitGapVideoAfterRound}px)`);
  }
  if (problems.length) throw new Error(`viewer-video-controls ${label}: ${problems.join("; ")} — ${JSON.stringify(result)}`);
}

function pageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
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
    const cardFor = (part) => cards().find((c) => (c.getAttribute('aria-label') || '').includes(part));
    const controlsRect = () => document.querySelector('.viewer-controls').getBoundingClientRect();
    const zoomOutput = () => (document.querySelector('.viewer-controls output')?.textContent || '').trim();
    const controlsButton = (title) => Array.from(document.querySelectorAll('.viewer-controls button')).find((b) => b.title === title);
    const gapBelow = (media) => Math.round((controlsRect().top - media.getBoundingClientRect().bottom) * 10) / 10;
    const openViewer = async (cardPart) => {
      await waitFor(() => cardFor(cardPart), 'card ' + cardPart);
      cardFor(cardPart).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      const media = await waitFor(() => document.querySelector('.image-viewer video.viewer-image, .image-viewer img.viewer-image'), 'viewer media');
      await waitFor(() => (media.tagName === 'VIDEO' ? media.readyState >= 1 : media.complete && media.naturalWidth > 0), 'viewer media metadata');
      return media;
    };

    await waitFor(() => cardFor('${VIDEO_CARD_LABEL}') && cardFor('${IMAGE_CARD_LABEL}'), 'two seeded cards');

    const video = await openViewer('${VIDEO_CARD_LABEL}');
    const result = {};
    result.videoPointerEvents = getComputedStyle(video).pointerEvents;
    result.controlsAttr = video.hasAttribute('controls');
    result.controlsList = video.getAttribute('controlsList') || '';
    result.disablePip = video.hasAttribute('disablepictureinpicture');
    result.fitGapVideo = gapBelow(video);
    result.fitClearsBarVideo = result.fitGapVideo >= 0;

    // A double-click on the video is the native controls' surface: no zoom toggle.
    result.zoomBefore = zoomOutput();
    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await sleep(200);
    result.zoomAfterVideoDblclick = zoomOutput();
    result.dblclickOnVideoKeepsZoom = result.zoomAfterVideoDblclick === result.zoomBefore;
    // Positive control: the same double-click on the stage still toggles to 1:1.
    const stage = document.querySelector('.viewer-stage');
    const stageRect = stage.getBoundingClientRect();
    stage.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: stageRect.left + 60, clientY: stageRect.top + 60 }));
    await sleep(200);
    result.zoomAfterStageDblclick = zoomOutput();
    result.dblclickOnStageTogglesZoom = result.zoomAfterStageDblclick !== result.zoomBefore;
    // Wheel over the video still zooms (the event bubbles to the stage listener).
    video.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 }));
    await sleep(200);
    result.zoomAfterWheel = zoomOutput();
    result.wheelOnVideoZooms = result.zoomAfterWheel !== result.zoomAfterStageDblclick;
    // Back to fit; the geometry must still clear the bar after the round trip.
    controlsButton('适合窗口').click();
    await sleep(250);
    result.fitGapVideoAfterRound = gapBelow(video);
    result.fitStillClearsAfterRound = result.fitGapVideoAfterRound >= 0;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const image = await waitFor(() => {
      const element = document.querySelector('img.viewer-image');
      return element && element.complete && element.naturalWidth > 0 ? element : null;
    }, 'image viewer media');
    result.imagePointerEvents = getComputedStyle(image).pointerEvents;
    result.fitGapImage = gapBelow(image);
    result.fitClearsBarImage = result.fitGapImage >= 0;

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => !document.querySelector('.image-viewer'), 'viewer closed');
    return result;
  })()`;
}

// The screenshots land in ../../tasks/logs next to the worktree (never inside
// the repo); if that path is unwritable the run root still gets a copy so the
// failure report can name a file.
async function screenshotDir(ctx) {
  const preferred = join(ctx.rootDir, "..", "tasks", "logs");
  try {
    await mkdir(preferred, { recursive: true });
    await writeFile(join(preferred, ".probe"), "");
    await rm(join(preferred, ".probe"), { force: true });
    return preferred;
  } catch {
    const fallback = join(ctx.fixturesDir, "screenshots");
    await mkdir(fallback, { recursive: true });
    return fallback;
  }
}

async function runDesktopPhase(ctx) {
  const guiRoot = join(ctx.userDataDir, "..", "desktop-gui");
  await mkdir(join(guiRoot, "generated-images"), { recursive: true });
  await mkdir(join(guiRoot, "codex-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "grok-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "cowart-data"), { recursive: true });

  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(guiRoot, "pid.txt");
  const logFile = join(guiRoot, "main.log");
  const healthFile = join(guiRoot, "health.json");
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: guiRoot,
    executable,
    args: [...qaFlags, "desktop/main.mjs", `--user-data-dir=${ctx.userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: ctx.userDataDir,
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      MOSA_PROJECT_DIR: ctx.rootDir,
      MOSA_DESKTOP_PORT: String(port),
      CODEX_GENERATED_IMAGES_DIR: join(guiRoot, "generated-images"),
      CODEX_SESSIONS_DIR: join(guiRoot, "codex-sessions"),
      GROK_SESSIONS_DIR: join(guiRoot, "grok-sessions"),
      COWART_MOSA_CANVAS_DIR: join(guiRoot, "cowart-data"),
      MOSA_COWART_REGISTRY_PATH: join(guiRoot, "cowart-data", "registry.json"),
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });

  let cdp = null;
  const shotsDir = await screenshotDir(ctx);
  const written = [];
  try {
    await waitForHealthFile(healthFile);
    const origin = `http://127.0.0.1:${port}`;
    cdp = await connectCdp(cdpPort, origin);
    await cdp.send("Page.enable");
    const evaluate = async (expression) => {
      const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response?.exceptionDetails) throw new Error("evaluate failed: " + (response.exceptionDetails.exception?.description || response.exceptionDetails.text));
      return response?.result?.value;
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitForValue(expression, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression).catch(() => null);
        if (value) return value;
        await sleep(150);
      }
      throw new Error(`desktop phase timed out waiting for ${label}`);
    }
    const capture = async (filename) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${filename}`);
      const path = join(shotsDir, filename);
      await writeFile(path, Buffer.from(shot.data, "base64"));
      written.push(path);
    };
    const pointOf = async (expression) => {
      const point = await evaluate(`(() => {
        const el = ${expression};
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`element not found: ${expression}`);
      return point;
    };
    const mouseButton = async (point, type, { clickCount = 1, buttons = type === "mousePressed" ? 1 : 0 } = {}) => {
      await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons, clickCount, pointerType: "mouse" });
    };
    const drag = async (from, to) => {
      await mouseButton(from, "mouseMoved");
      await mouseButton(from, "mousePressed");
      for (let step = 1; step <= 5; step += 1) {
        await mouseButton({ x: from.x + (to.x - from.x) * step / 5, y: from.y + (to.y - from.y) * step / 5 }, "mouseMoved", { buttons: 1 });
        await sleep(40);
      }
      await mouseButton(to, "mouseReleased");
      await sleep(150);
    };
    const doubleClick = async (point) => {
      await mouseButton(point, "mouseMoved");
      await mouseButton(point, "mousePressed");
      await mouseButton(point, "mouseReleased");
      await mouseButton(point, "mousePressed", { clickCount: 2 });
      await mouseButton(point, "mouseReleased", { clickCount: 2 });
      await sleep(200);
    };
    const mediaBox = () => evaluate(`(() => {
      const media = document.querySelector('.image-viewer video.viewer-image, .image-viewer img.viewer-image');
      if (!media) return null;
      const r = media.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), tag: media.tagName };
    })()`);

    await waitForValue(`document.querySelectorAll('.asset-card').length >= 2`, 'two seeded cards');

    // Open the video in the viewer with a trusted double-click on its card.
    const videoCardPoint = await pointOf(`document.querySelectorAll('.asset-card').length === 2
      ? (Array.from(document.querySelectorAll('.asset-card')).find((c) => (c.getAttribute('aria-label') || '').includes('${VIDEO_CARD_LABEL}')) || null)
      : null`);
    await doubleClick(videoCardPoint);
    await waitForValue(`(() => { const v = document.querySelector('.image-viewer video.viewer-image'); return Boolean(v && v.readyState >= 1 && v.videoWidth > 0); })()`, 'viewer video metadata');

    // Zoom in once: the portrait clip then overflows the stage vertically
    // (panning is possible) while a side band of stage background stays
    // visible for the positive-control pan drag.
    await evaluate(`Array.from(document.querySelectorAll('.viewer-controls button')).find((b) => b.title === '放大')?.click()`);
    await sleep(300);

    // Trusted press-drag-release on the video: the stage must not pan, capture
    // must not steal the pointer from the native controls.
    const before = await mediaBox();
    const stageBox = await evaluate(`(() => { const r = document.querySelector('.viewer-stage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    const videoCenter = { x: before.x + before.width / 2, y: before.y + before.height / 2 };
    await drag(videoCenter, { x: videoCenter.x + 50, y: videoCenter.y + 50 });
    const afterVideoDrag = await mediaBox();
    const videoDragKeptPosition = Math.abs(afterVideoDrag.x - before.x) <= 2 && Math.abs(afterVideoDrag.y - before.y) <= 2;
    const stageNeverGrabbed = await evaluate(`!document.querySelector('.viewer-stage').classList.contains('dragging')`);

    // Positive control: the same trusted drag on a stage point that is
    // verifiably OUTSIDE the media box pans the picture.
    const backgroundPoint = { x: stageBox.x + 20, y: stageBox.y + stageBox.height / 2 };
    const backgroundOutsideMedia = backgroundPoint.x < before.x - 4 || backgroundPoint.x > before.x + before.width + 4;
    await drag(backgroundPoint, { x: backgroundPoint.x, y: backgroundPoint.y + 70 });
    const afterStageDrag = await mediaBox();
    const stageDragPanned = Math.abs(afterStageDrag.y - afterVideoDrag.y) > 10;

    // Trusted double-click on the video: Chromium's native controls must not
    // enter any fullscreen, and the app zoom stays put.
    const zoomBefore = await evaluate(`document.querySelector('.viewer-controls output')?.textContent`);
    await doubleClick(videoCenter);
    const fullscreenElement = await evaluate(`document.fullscreenElement && document.fullscreenElement.nodeName || null`);
    const appFullscreenClass = await evaluate(`document.querySelector('.app')?.classList.contains('viewer-fullscreen') || false`);
    const zoomAfterDblclick = await evaluate(`document.querySelector('.viewer-controls output')?.textContent`);
    const dblclickStayedWindowed = fullscreenElement === null && appFullscreenClass === false && zoomAfterDblclick === zoomBefore;

    // This Electron build renders the media controls' fullscreen button even
    // with controlsList="nofullscreen" (verified against the shadow DOM). The
    // viewer must back out of any OS fullscreen that button requests.
    const fsButtonCenter = await (async () => {
      await cdp.send("DOM.enable");
      const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
      const centers = [];
      const walk = (node) => {
        if (!node) return;
        const attr = node.attributes || [];
        let cls = null;
        for (let i = 0; i < attr.length; i += 2) if (attr[i] === "class" || attr[i] === "pseudo") cls = attr[i + 1];
        if (cls === "-webkit-media-controls-fullscreen-button") centers.push(node.nodeId);
        for (const childNode of (node.children || [])) walk(childNode);
        for (const shadow of (node.shadowRoots || [])) walk(shadow);
      };
      walk(doc.root);
      for (const nodeId of centers) {
        const box = await cdp.send("DOM.getBoxModel", { nodeId }).catch(() => null);
        if (!box?.model) continue;
        const m = box.model.content;
        return { x: (m[0] + m[2]) / 2, y: (m[1] + m[3]) / 2 };
      }
      return null;
    })();
    let nativeFsButtonBackedOut = true;
    let nativeFsButtonRendered = false;
    if (fsButtonCenter) {
      nativeFsButtonRendered = true;
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: fsButtonCenter.x, y: fsButtonCenter.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: fsButtonCenter.x, y: fsButtonCenter.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: fsButtonCenter.x, y: fsButtonCenter.y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(600);
      nativeFsButtonBackedOut = await evaluate(`document.fullscreenElement === null && !(document.querySelector('.app')?.classList.contains('viewer-fullscreen') || false)`);
    }

    // Screenshot 1: back in fit state (zoom bar below the picture), video
    // paused — Chromium keeps the native controls out while paused, so the
    // capture reliably shows them above the zoom bar.
    const fitState = await evaluate(`(() => {
      const video = document.querySelector('.image-viewer video.viewer-image');
      if (video) video.pause();
      Array.from(document.querySelectorAll('.viewer-controls button')).find((b) => b.title === '适合窗口')?.click();
      return true;
    })()`);
    await sleep(300);
    const fitBox = await mediaBox();
    await mouseButton({ x: fitBox.x + fitBox.width / 2, y: fitBox.y + fitBox.height / 2 }, "mouseMoved");
    await sleep(800);
    await capture("254-video.png");
    if (fitState !== true) desktopFailures.push("could not restore the fit state for the screenshot");

    const desktopFailures = [];
    if (!videoDragKeptPosition) desktopFailures.push(`trusted drag on the video panned it (${JSON.stringify(before)} -> ${JSON.stringify(afterVideoDrag)})`);
    if (stageNeverGrabbed !== true) desktopFailures.push("stage kept the dragging class after a video drag");
    if (!backgroundOutsideMedia) desktopFailures.push(`positive-control drag point was not on stage background (media ${JSON.stringify(before)}, point ${JSON.stringify(backgroundPoint)})`);
    else if (!stageDragPanned) desktopFailures.push(`trusted drag on the stage background did not pan (${JSON.stringify(afterVideoDrag)} -> ${JSON.stringify(afterStageDrag)})`);
    if (!dblclickStayedWindowed) desktopFailures.push(`double-click on the video changed state (fullscreenElement=${fullscreenElement}, appClass=${appFullscreenClass}, zoom ${zoomBefore} -> ${zoomAfterDblclick})`);
    if (!nativeFsButtonBackedOut) desktopFailures.push("clicking the native fullscreen button left an OS fullscreen (exit guard did not revert it)");

    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitForValue(`!document.querySelector('.image-viewer')`, 'viewer closed after Escape');

    // Property tags: the grouped video carries 6 cells (格式/尺寸/比例/时长/大小/分组),
    // the ungrouped image 4 (格式/尺寸/比例/大小) — the task's short-row case. A gallery re-render can eat a click on a stale
    // node, so select → poll → reselect before giving up with a scene dump.
    const readTags = () => evaluate(`(() => {
      const tags = Array.from(document.querySelectorAll('.details .asset-properties .property-tag'));
      if (!tags.length || !tags.every((t) => t.clientWidth > 0)) return null;
      const rects = tags.map((t) => t.getBoundingClientRect());
      const overlaps = [];
      for (let a = 0; a < rects.length; a += 1) {
        for (let b = a + 1; b < rects.length; b += 1) {
          const ra = rects[a]; const rb = rects[b];
          const separated = ra.right <= rb.left + 0.5 || rb.right <= ra.left + 0.5 || ra.bottom <= rb.top + 0.5 || rb.bottom <= ra.top + 0.5;
          if (!separated) overlaps.push([a, b]);
        }
      }
      return {
        count: tags.length,
        labels: tags.map((t) => (t.getAttribute('aria-label') || '').split(':')[0]),
        overflowing: tags.map((t) => t.scrollWidth - t.clientWidth),
        wrappedLines: new Set(rects.map((r) => Math.round(r.top))).size,
        overlaps,
        sizeLabel: (tags.find((t) => (t.getAttribute('aria-label') || '').startsWith('大小'))?.textContent || '').trim(),
      };
    })()`);
    const selectAndReadTags = async (labelPart) => {
      for (let round = 0; round < 3; round += 1) {
        const clicked = await evaluate(`(() => {
          const card = Array.from(document.querySelectorAll('.asset-card')).find((c) => (c.getAttribute('aria-label') || '').includes('${labelPart}'))
            || document.querySelector('.asset-card');
          if (!card) return false;
          card.click();
          return true;
        })()`);
        for (let poll = 0; poll < 30; poll += 1) {
          const tags = await readTags();
          if (tags) return tags;
          await sleep(150);
        }
        if (!clicked) break;
      }
      return await evaluate(`(() => ({
        details: Boolean(document.querySelector('.details')),
        assetName: document.querySelector('.details .asset-name')?.textContent || null,
        tagCount: document.querySelectorAll('.details .asset-properties .property-tag').length,
        cards: Array.from(document.querySelectorAll('.asset-card')).map((c) => c.getAttribute('aria-label')),
      }))()`);
    };
    const videoTags = await selectAndReadTags(VIDEO_CARD_LABEL);
    if (!videoTags || !videoTags.count) desktopFailures.push("video property tags never rendered in .details");
    else {
      if (videoTags.count < 6) desktopFailures.push(`video shows ${videoTags.count} property tags, expected 6 (${JSON.stringify(videoTags.labels)})`);
      if (videoTags.overflowing.some((delta) => delta > 1)) desktopFailures.push(`property tag text overflows its box: ${JSON.stringify(videoTags.overflowing)}`);
      if (videoTags.overlaps.length) desktopFailures.push(`property tag boxes overlap: ${JSON.stringify(videoTags.overlaps)}`);
    }
    await capture("254-properties.png");

    const imageTags = await selectAndReadTags(IMAGE_CARD_LABEL);
    if (!imageTags || !imageTags.count) desktopFailures.push(`image property tags never rendered in .details: ${JSON.stringify(imageTags)}`);
    else {
      if (imageTags.count < 4) desktopFailures.push(`image shows ${imageTags.count} property tags, expected at least 4 (${JSON.stringify(imageTags.labels)})`);
      if (imageTags.overflowing.some((delta) => delta > 1)) desktopFailures.push(`image property tag text overflows: ${JSON.stringify(imageTags.overflowing)}`);
      if (imageTags.overlaps.length) desktopFailures.push(`image property tag boxes overlap: ${JSON.stringify(imageTags.overlaps)}`);
    }
    await capture("254-properties-image.png");

    if (desktopFailures.length) throw new Error(`viewer-video-controls desktop phase: ${desktopFailures.join("; ")}`);
    return { screenshots: written, videoTags, imageTags, nativeFsButton: nativeFsButtonRendered ? "rendered despite nofullscreen; its click was reverted by the viewer guard" : "absent (controlsList honored)", sizeLabelNote: `video 大小 cell shows ${JSON.stringify(videoTags?.sizeLabel)} (server never writes a file size)` };
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[viewer-video-controls] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
  } finally {
    if (cdp) cdp.close();
    const pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    if (launched.waiter && launched.waiter.exitCode === null) {
      try { launched.waiter.kill("SIGTERM"); } catch {}
    }
    await rm(guiRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

async function connectCdp(cdpPort, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
        if (target?.webSocketDebuggerUrl) return openCdpSession(target.webSocketDebuggerUrl);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no desktop CDP target on port ${cdpPort}`);
}

function openCdpSession(url) {
  let idSeq = 0;
  const pending = new Map();
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const ready = new Promise((resolveReady, rejectReady) => {
    socket.addEventListener("open", resolveReady, { once: true });
    socket.addEventListener("error", () => rejectReady(new Error("CDP socket failed")), { once: true });
  });
  return {
    async send(method, params = {}) {
      await ready;
      const id = ++idSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse(await readFile(filePath, "utf8"));
      if (health?.product === "mosa") return health;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("desktop health file timeout");
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}
