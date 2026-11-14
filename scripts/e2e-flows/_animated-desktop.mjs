// Shared desktop-shell harness for the task 412 animated-media flows. The
// QA desktop shell is the only instance whose pages are reachable over CDP
// (the web-driver window has no debugging port), and quiet QA mode renders it
// hidden with background throttling off (task 325/346), so animated images
// keep playing while the flow screenshots them. Everything here follows the
// viewer-video-controls desktop phase: launch by pid, stop by pid, no
// pkill/killall.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

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
    const evaluate = async (expression) => {
      const response = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (response?.exceptionDetails) throw new Error("evaluate failed: " + (response.exceptionDetails.exception?.description || response.exceptionDetails.text));
      return response?.result?.value;
    };
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
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse" });
    };
    const pointOf = async (selector) => {
      const point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`element not found: ${selector}`);
      return point;
    };
    const doubleClick = async (point) => {
      const press = { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" };
      await cdp.send("Input.dispatchMouseEvent", { ...press });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
      await cdp.send("Input.dispatchMouseEvent", { ...press, clickCount: 2 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 2, pointerType: "mouse" });
      await sleep(250);
    };
    // Screenshot of a page-region only, always inside the isolated instance.
    const captureRect = async (rect, filePath) => {
      const shot = await cdp.send("Page.captureScreenshot", {
        format: "png",
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 },
      });
      if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${filePath}`);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from(shot.data, "base64"));
      return filePath;
    };
    const result = await work({ origin, evaluate, waitForValue, sleep, mouseMove, pointOf, doubleClick, captureRect, cdp });
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
