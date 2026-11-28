// Shared desktop-shell harness for the task 412 animated-media flows. The
// QA desktop shell is the only instance whose pages are reachable over CDP
// (the web-driver window has no debugging port), and quiet QA mode renders it
// hidden with background throttling off (task 325/346), so animated images
// keep playing while the flow screenshots them. Everything here follows the
// viewer-video-controls desktop phase: launch by pid, stop by pid, no
// pkill/killall.
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { writeFlowArtifact } from "./_artifacts.mjs";
import { connectCdp, dispatchMouse, pointOf as cdpPointOf } from "./_cdp.mjs";

export async function runDesktopShell(ctx, work) {
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
      MOSA_FEEDBACK_URL: "http://127.0.0.1:9",
      MOSA_FEEDBACK_TIMEOUT_MS: "3000",
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
  try {
    await waitForHealthFile(healthFile);
    const origin = `http://127.0.0.1:${port}`;
    cdp = await connectCdp(cdpPort, origin);
    await cdp.send("Page.enable");
    const evaluate = (expression) => cdp.evaluate(expression);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitForValue = async (expression, label, timeoutMs = 30000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await evaluate(expression).catch(() => null);
        if (value) return value;
        await sleep(150);
      }
      const state = await evaluate(`(() => ({
        cards: document.querySelectorAll('.asset-card').length,
        viewer: Boolean(document.querySelector('.image-viewer')),
        viewerSrc: document.querySelector('.viewer-image')?.getAttribute('src') || null,
      }))()`).catch(() => null);
      throw new Error(`desktop shell timed out waiting for ${label}; state=${JSON.stringify(state)}`);
    };
    // Trusted pointer move (a real hover: fires pointerenter/pointerleave).
    const mouseMove = async (point) => {
      await dispatchMouse(
        cdp,
        { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse" },
        { reason: "hover over card center or park pointer at neutral coordinates to test animated hover motion" },
      );
    };
    const elementPoint = (selector) => cdpPointOf(cdp, `document.querySelector(${JSON.stringify(selector)})`, { label: selector });
    const doubleClickPoint = async (point) => {
      const reason = "double-click validated card center to open animated GIF viewer";
      const press = { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
      await dispatchMouse(cdp, { ...press }, { reason });
      await dispatchMouse(cdp, { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" }, { reason });
      await dispatchMouse(cdp, { ...press, clickCount: 2 }, { reason });
      await dispatchMouse(cdp, { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 2, pointerType: "mouse" }, { reason });
      await sleep(250);
    };
    // Screenshot of a page-region only, always inside the isolated instance.
    const captureRect = async (rect, fileName) => {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${fileName}`);
      return writeFlowArtifact(ctx, fileName, Buffer.from(shot.data, "base64"));
    };
    const result = await work({ origin, evaluate, waitForValue, sleep, mouseMove, pointOf: elementPoint, doubleClick: doubleClickPoint, captureRect, cdp });
    return result;
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[desktop main.log tail]\n${log.slice(-2000)}` : ""}`, { cause: error });
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
