// GravityPort React UI flow (task 307): the inspector's reference thumbnails
// keep the source aspect ratio instead of being squeezed into a square.
//
// Two layers, because they need different windows:
// - Web-driver windows (ctx.runInPage) assert the layout contract: each
//   reference <img> box ratio matches its natural ratio within 3% (vertical
//   900x1600 and horizontal 1600x900 seeds), the thumbnail height equals
//   --space-16, and an ultra-wide 3600x900 reference caps at 2x height with
//   object-fit: contain (whole image visible, never distorted).
// - Hidden web-driver windows never paint, so the task-report screenshot runs
//   against the real desktop shell via CDP (the viewer-video-controls way).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

const HOST_LABEL = "ref-ratio-host";
const RATIO_TOLERANCE = 0.03;
const CAP_TOLERANCE = 0.01;
const SEEDS = [
  { role: "参考图 1", width: 900, height: 1600 },
  { role: "参考图 2", width: 1600, height: 900 },
  { role: "参考图 3", width: 3600, height: 900 },
];

export const name = "inspector-reference-ratio";
export const description = "host asset with three linked references (900x1600 vertical, 1600x900 horizontal, 3600x900 ultra-wide) -> thumbnails keep the source ratio within 3%, height equals --space-16, ultra-wide capped at 2x with object-fit: contain -> desktop screenshot";

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    const linked = [];
    for (const seed of SEEDS) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`ref-ratio-${seed.width}x${seed.height}.png`, [181, 68, 74], { width: seed.width, height: seed.height }),
        prompt: `reference ratio ${seed.width}x${seed.height}`,
      });
      linked.push({ id: created.asset.id, seed });
    }
    const host = await ctx.api(server.origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: await ctx.makePng(`${HOST_LABEL}.png`, [96, 74, 155], { width: 640, height: 640 }),
      prompt: "reference ratio host",
      references: linked.map((entry, index) => ({
        reference_id: `ref-ratio-${index + 1}`,
        asset_id: entry.id,
        role: entry.seed.role,
      })),
    });

    // The inspector only renders references that carry a thumbnailUrl, and
    // before the derivative worker runs that field falls back to the original
    // file. Wait until every linked asset has its real thumbnail.
    for (const entry of linked) {
      await waitForThumbnailReady(ctx, server, entry);
    }

    const result = await ctx.runInPage(server, pageSource());
    if (result?.__pageError) throw new Error(`inspector-reference-ratio page error: ${result.__pageError}`);
    assertPageResult(result);

    // The screenshot layer gets its own single writer: the desktop shell opens
    // the same library directory, so the main server stops first.
    await server.stop();
    serverRunning = false;
    const screenshot = await runDesktopPhase(ctx);
    return { ok: true, space16: result.space16, measurements: result.measurements, screenshot };
  } finally {
    if (serverRunning) await server.stop().catch(() => {});
  }
}

async function waitForThumbnailReady(ctx, server, entry) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const detail = await ctx.api(server.origin, "GET", `/api/assets/default/${encodeURIComponent(entry.id)}`);
    if (detail?.asset?.thumbnail_ready === true) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`asset ${entry.id} (${entry.seed.role}) never got a thumbnail — derivative worker did not run`);
}

function withinTolerance(value, target, tolerance) {
  return Math.abs(value - target) <= tolerance * target;
}

function assertPageResult(result) {
  const problems = [];
  const expect = (condition, message) => { if (condition !== true) problems.push(message); };
  expect(result?.space16 > 0, `--space-16 did not resolve (${JSON.stringify(result?.space16)})`);
  const items = result?.measurements || [];
  // Pair by the seeded role (the thumbnail's title), not by DOM order: the
  // gallery's render order is not part of this task's contract.
  const byTitle = new Map(items.map((item) => [item.title, item]));
  expect(items.length === SEEDS.length, `expected ${SEEDS.length} reference images, got ${items.length}: ${JSON.stringify(items)}`);
  for (const seed of SEEDS) {
    const item = byTitle.get(seed.role);
    if (!item) {
      problems.push(`${seed.role} missing among thumbnails ${JSON.stringify(items.map((entry) => entry.title))}`);
      continue;
    }
    const naturalRatio = item.naturalWidth / item.naturalHeight;
    const seededRatio = seed.width / seed.height;
    const boxRatio = item.boxWidth / item.boxHeight;
    // The seed itself is non-square; the thumbnail must preserve that ratio,
    // or every later box-ratio check would compare against the wrong target.
    expect(withinTolerance(naturalRatio, seededRatio, RATIO_TOLERANCE), `${seed.role} natural ratio ${naturalRatio.toFixed(4)} drifts from the seeded ${seededRatio.toFixed(4)} (${item.naturalWidth}x${item.naturalHeight})`);
    // The 2x cap intentionally clamps ultra-wide boxes below their natural
    // ratio (object-fit: contain letterboxes the content instead), so the
    // box-vs-natural check only applies to seeds within the cap.
    if (naturalRatio <= 2) {
      expect(withinTolerance(boxRatio, naturalRatio, RATIO_TOLERANCE), `${seed.role} displayed box ratio ${boxRatio.toFixed(4)} differs from natural ${naturalRatio.toFixed(4)} beyond 3% (${JSON.stringify(item)})`);
    }
    expect(Math.abs(item.buttonHeight - result.space16) <= 0.5, `${seed.role} thumbnail height ${item.buttonHeight} is not --space-16 (${result.space16})`);
    expect(item.objectFit === "contain", `${seed.role} object-fit is ${JSON.stringify(item.objectFit)}`);
  }
  const wide = byTitle.get("参考图 3");
  if (wide) {
    expect(wide.buttonWidth <= wide.buttonHeight * 2 + 0.5, `ultra-wide thumbnail width ${wide.buttonWidth} exceeds 2x height ${wide.buttonHeight}`);
    expect(withinTolerance(wide.buttonWidth / wide.buttonHeight, 2, CAP_TOLERANCE), `ultra-wide thumbnail is not capped at 2:1 (${wide.buttonWidth}x${wide.buttonHeight})`);
  }
  if (problems.length) throw new Error(`inspector-reference-ratio: ${problems.join("; ")}`);
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
    const hostCard = () => cards().find((c) => (c.getAttribute('aria-label') || '').includes('${HOST_LABEL}'));
    await waitFor(() => (cards().length === ${SEEDS.length + 1} && hostCard()) || null, 'the four seeded cards');

    hostCard().click();
    const images = await waitFor(() => {
      const gallery = document.querySelector('.reference-gallery');
      if (!gallery) return null;
      const imgs = Array.from(gallery.querySelectorAll('img.reference-image'));
      if (imgs.length !== ${SEEDS.length}) return null;
      return imgs.every((img) => img.complete && img.naturalWidth > 0) ? imgs : null;
    }, '${SEEDS.length} loaded reference images');

    const space16 = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--space-16')) || 0;
    const measurements = images.map((img) => {
      const rect = img.getBoundingClientRect();
      const button = img.closest('.reference-thumbnail');
      const buttonRect = button ? button.getBoundingClientRect() : null;
      const round = (value) => Math.round(value * 100) / 100;
      return {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        boxWidth: round(rect.width),
        boxHeight: round(rect.height),
        buttonWidth: buttonRect ? round(buttonRect.width) : null,
        buttonHeight: buttonRect ? round(buttonRect.height) : null,
        objectFit: getComputedStyle(img).objectFit,
        title: button ? button.title : '',
      };
    });
    return { space16, measurements };
  })()
  `;
}

// The screenshot lands in ../../tasks/logs next to the worktree (never inside
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
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
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

    await waitForValue(`document.querySelectorAll('.asset-card').length >= ${SEEDS.length + 1}`, "the four seeded cards");

    // Open the inspector on the host card with one trusted click (retried: the
    // click can land before the grid finishes settling its handlers).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const point = await evaluate(`(() => {
        const card = Array.from(document.querySelectorAll('.asset-card')).find((c) => (c.getAttribute('aria-label') || '').includes('${HOST_LABEL}'));
        if (!card) return null;
        const r = card.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error("host card not found in the desktop shell");
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none" });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      const opened = await waitForValue(`(() => {
        const gallery = document.querySelector('.reference-gallery');
        if (!gallery) return false;
        const imgs = Array.from(gallery.querySelectorAll('img.reference-image'));
        return imgs.length === ${SEEDS.length} && imgs.every((img) => img.complete && img.naturalWidth > 0);
      })()`, "the reference gallery with loaded thumbnails", 8000).catch(() => false);
      if (opened) break;
      if (attempt === 2) throw new Error("the reference gallery never opened in the desktop shell");
      await sleep(500);
    }
    await sleep(300);
    await capture("307-reference.png");
    return { screenshots: written };
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[inspector-reference-ratio] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
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
