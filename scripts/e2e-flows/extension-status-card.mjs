// GravityPort React UI flow (task 225, extended by task 310): Settings → 连接
// browser extension card.
//
// Web-driver round (task 225): a seeded capture carrying extensionVersion
// makes the card read 已连接 with the version. The extension then reports a
// pending: 2 queue through the capture-plugin status route; clicking the
// card's 刷新 reveals the 重试 row, and clicking 重试 must hit
// POST /api/web-capture/retry for real — the server's retryRequestId has to
// come back exactly one higher.
//
// Desktop-shell round (task 310): the extension reports a nearly-full offline
// queue (storageBytes ≥ 90%, evicted > 0, urlOnly > 0) and the card must show
// the three storage hint lines; after a clean report none of them may remain.
// A CDP screenshot of the hinted card is saved to tasks/logs/310-card.png.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { signalProcessTree } from "../process-tree.mjs";

export const name = "extension-status-card";
export const description = "capture with extensionVersion -> card 已连接 + version -> extension reports pending:2 -> 刷新 shows 重试 -> click -> retryRequestId +1; then a nearly-full offline queue shows the three storage hints (screenshot) and a clean report hides them";

const CAPTURE_TOKEN = "mosa_e2e_extension_card_token";
const CAPTURED_VERSION = "0.15.37";
const HINTED_QUEUE = {
  pending: 12,
  failed: 0,
  storageBytes: 480 * 1024 * 1024,
  storageLimitBytes: 512 * 1024 * 1024,
  urlOnly: 3,
  evicted: 2,
  items: [],
};
const CLEAN_QUEUE = {
  pending: 12,
  failed: 0,
  storageBytes: 0,
  storageLimitBytes: 512 * 1024 * 1024,
  urlOnly: 0,
  evicted: 0,
  items: [],
};

export async function run(ctx) {
  await ctx.prepare();
  // The capture-plugin ingest routes need a web-capture bearer token; the e2e
  // server env inherits this process's env (qaEnvironment spreads process.env).
  const previousCaptureToken = process.env.MOSA_WEB_CAPTURE_TOKEN;
  process.env.MOSA_WEB_CAPTURE_TOKEN = CAPTURE_TOKEN;
  const server = await ctx.startServer();
  try {
    const seeded = await fetch(`${server.origin}/api/ingest/web-capture`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${CAPTURE_TOKEN}` },
      body: JSON.stringify({
        provider: "chatgpt",
        imageBase64: (await noiseJpeg()).toString("base64"),
        mimeType: "image/jpeg",
        prompt: "extension status card flow",
        promptStatus: "generation-tool-prompt",
        extensionVersion: CAPTURED_VERSION,
      }),
    });
    if (!seeded.ok) {
      throw new Error(`seed capture failed: HTTP ${seeded.status}: ${(await seeded.text()).slice(0, 200)}`);
    }

    const before = await statusSnapshot(server);
    const round = await ctx.runInPage(server, pageSource());
    const problems = [];
    if (round?.connectedText !== "已连接") problems.push(`state line ${JSON.stringify(round?.connectedText)}`);
    if (round?.versionShown !== CAPTURED_VERSION) problems.push(`version shown ${JSON.stringify(round?.versionShown)}`);
    if (round?.retryBeforeRefresh !== false) problems.push("retry row visible before the extension reported a queue");
    if (round?.retryAfterRefresh !== true) problems.push("retry row missing after 刷新 with pending: 2");
    // The row's full text also contains the button label, hence startsWith.
    if (!String(round?.pendingText || "").startsWith("等待重试 2 张")) problems.push(`pending text ${JSON.stringify(round?.pendingText)}`);
    if (round?.retryRequestIdBefore !== before) problems.push(`in-page retryRequestId ${round?.retryRequestIdBefore} != Node-side ${before}`);
    if (round?.retriedShown !== true) problems.push("已让扩展重试 confirmation missing after the click");
    if (round?.retryRequestIdAfter !== before + 1) {
      problems.push(`retryRequestId after click ${round?.retryRequestIdAfter} != ${before + 1}`);
    }
    if (problems.length) throw new Error(`extension-status-card: ${problems.join("; ")}`);
    const webRound = { retryRequestId: round.retryRequestIdAfter, seededCapture: true };

    const desktopRound = await runDesktopHintRound(ctx);
    return { ...webRound, desktopHints: desktopRound };
  } finally {
    if (previousCaptureToken === undefined) delete process.env.MOSA_WEB_CAPTURE_TOKEN;
    else process.env.MOSA_WEB_CAPTURE_TOKEN = previousCaptureToken;
    await server.stop();
  }
}

// Desktop-shell round: its own quiet QA app, its own service, the queue
// reported from inside its renderer (the bridge state is in-memory, so the
// report must reach the same runtime that renders the card).
async function runDesktopHintRound(ctx) {
  const electronBinary = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const servicePort = await freePort();
  const cdpPort = await freePort();
  // One dir per round: a reused dir would serve stale health/pid files from a
  // previous crashed round and a leftover launcher process would keep Launch
  // Services from starting the new bundle instance.
  const runDir = join(ctx.rootDir, "tasks", "logs", `extension-card-desktop-run-${process.pid}-${Date.now().toString(36)}`);
  await stopLeftoverDesktopLaunchers();
  const userDataDir = join(runDir, "user-data");
  const libraryDir = join(runDir, "library");
  const codexDir = join(runDir, "codex-images");
  await Promise.all([
    mkdir(userDataDir, { recursive: true }),
    mkdir(libraryDir, { recursive: true }),
    mkdir(codexDir, { recursive: true }),
    mkdir(join(ctx.rootDir, "tasks", "logs"), { recursive: true }),
  ]);
  const pidFile = join(runDir, "pid.txt");
  const logFile = join(runDir, "main.log");
  const healthFile = join(runDir, "health.json");
  // 约定二之二.4: feedback goes to the black hole; the values are logged.
  const env = {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_QA_RUN: "1",
    MOSA_CLIENT_TOKEN: ctx.token,
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_USER_DATA: userDataDir,
    MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
    MOSA_PROJECT_DIR: runDir,
    CODEX_GENERATED_IMAGES_DIR: codexDir,
    MOSA_FEEDBACK_URL: "http://127.0.0.1:9",
    MOSA_FEEDBACK_TIMEOUT_MS: "3000",
    MOSA_DESKTOP_PORT: String(servicePort),
  };
  console.log(`[e2e] extension-status-card desktop round: MOSA_FEEDBACK_URL=${env.MOSA_FEEDBACK_URL} MOSA_FEEDBACK_TIMEOUT_MS=${env.MOSA_FEEDBACK_TIMEOUT_MS}`);

  const ELECTRON_QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: runDir,
    executable: electronBinary,
    args: [...ELECTRON_QA_FLAGS, "desktop/main.mjs", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env,
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${servicePort}/api/health`,
    healthFile,
  });
  let pid = null;
  let cdp = null;
  try {
    pid = launched.pid || await waitForPid(pidFile);
    const health = await waitForHealthFile(healthFile);
    if (health?.product !== "mosa" || health?.storage !== "sqlite") {
      throw new Error(`desktop QA runtime is not MOSA/sqlite: ${JSON.stringify(health)}`);
    }
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${servicePort}`);
    await waitForRendererReady(cdp);
    await pinChineseLanguage(cdp);

    const hinted = await cdp.evaluate(desktopPageSource(CAPTURE_TOKEN, "hinted"));
    const problems = [];
    if (hinted?.full !== true) problems.push("离线空间快满 hint missing");
    if (hinted?.evicted !== true) problems.push("因离线空间不足 hint missing");
    if (hinted?.urlOnly !== true) problems.push("只存了网址 hint missing");
    if (problems.length) throw new Error(`extension-status-card desktop hints: ${problems.join("; ")}`);

    const screenshot = await cdp.command("Page.captureScreenshot", { format: "png" });
    const screenshotPath = join(ctx.rootDir, "tasks", "logs", "310-card.png");
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));

    const cleaned = await cdp.evaluate(desktopPageSource(CAPTURE_TOKEN, "clean"));
    if (cleaned?.hintsGone !== true) throw new Error("extension-status-card desktop: storage hints did not hide after the clean report");
    return { hinted: true, hintsGone: true, screenshot: "tasks/logs/310-card.png" };
  } finally {
    cdp?.close();
    if (pid) await stopPid(pid);
    if (launched.waiter?.exitCode === null) launched.waiter.kill("SIGTERM");
  }
}

// The desktop profile is fresh, so the UI language follows navigator.language;
// pin Chinese (the copy this flow matches) before the card is read, the same
// way the web driver does. A reload cannot ride an evaluate() promise, so the
// Node side reloads through CDP and re-waits for the renderer.
async function pinChineseLanguage(cdp) {
  const needsPin = await cdp.evaluate(`(() => {
    try {
      if (localStorage.getItem("mosa.ui-language") === "zh") return false;
      localStorage.setItem("mosa.ui-language", "zh");
      return true;
    } catch {
      return false;
    }
  })()`);
  if (needsPin !== true) return;
  await cdp.command("Page.reload");
  await sleep(500);
  await waitForRendererReady(cdp);
}

function desktopPageSource(token, phase) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = await check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const report = async (queue) => {
      const response = await fetch('/api/ingest/web-capture-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ${token}' },
        body: JSON.stringify(queue),
      });
      if (!response.ok) throw new Error('POST web-capture-status -> HTTP ' + response.status);
      return response.json();
    };
    const cardText = () => document.querySelector('.web-capture-status-card')?.textContent || '';

    if ('${phase}' === 'hinted') {
      await report(${JSON.stringify(HINTED_QUEUE)});
      await waitFor(() => document.querySelector('.app'), 'app shell');
      document.querySelector('.user-button').click();
      await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
      const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '连接');
      if (!nav) throw new Error('连接 nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
      nav.click();
      await waitFor(() => document.querySelector('.web-capture-status-card'), 'extension status card');
      await waitFor(() => cardText().includes('离线空间快满'), 'nearly-full hint');
      // Bring the card's hint lines into the viewport for the screenshot.
      document.querySelector('.web-capture-status-card').scrollIntoView({ block: 'start' });
      await sleep(300);
      return {
        full: cardText().includes('扩展的离线空间快满了（已用 480MB / 512MB），打开 GravityPort 后会自动补收'),
        evicted: cardText().includes('有 2 张因离线空间不足只保留了网址或被移除，网址过期后可能收不回来'),
        urlOnly: cardText().includes('3 张只存了网址，网址过期后可能收不回来'),
      };
    }
    await report(${JSON.stringify(CLEAN_QUEUE)});
    document.querySelector('.web-capture-status-card .web-capture-refresh').click();
    await waitFor(() => !cardText().includes('离线空间快满')
      && !cardText().includes('因离线空间不足')
      && !cardText().includes('只存了网址'), 'storage hints gone after clean report');
    return { hintsGone: true };
  })()
  `;
}

async function statusSnapshot(server) {
  const response = await fetch(`${server.origin}/api/web-capture`);
  if (!response.ok) throw new Error(`GET /api/web-capture failed: HTTP ${response.status}`);
  const body = await response.json();
  return Number(body?.bridge?.retryRequestId || 0);
}

async function noiseJpeg() {
  const width = 720;
  const height = 960;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 37 + (i % 251)) & 255;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
}

function pageSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const bridgeStatus = async () => {
      const response = await fetch('/api/web-capture', { cache: 'no-store' });
      if (!response.ok) throw new Error('GET /api/web-capture -> HTTP ' + response.status);
      return (await response.json()).bridge || {};
    };
    const reportQueue = async () => {
      const response = await fetch('/api/ingest/web-capture-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ${CAPTURE_TOKEN}' },
        body: JSON.stringify({
          pending: 2,
          failed: 0,
          items: [
            { id: 'e2e-item-1', provider: 'chatgpt', mediaKind: 'image', promptStatus: 'user-message', generationStatus: 'failed', attempts: 2, lastError: 'stale url', createdAt: 1, updatedAt: 2 },
            { id: 'e2e-item-2', provider: 'chatgpt', mediaKind: 'image', promptStatus: 'not-available', generationStatus: 'unknown', attempts: 1, lastError: '', createdAt: 3, updatedAt: 4 },
          ],
        }),
      });
      if (!response.ok) throw new Error('POST web-capture-status -> HTTP ' + response.status);
      return response.json();
    };

    await waitFor(() => document.querySelector('.app'), 'app shell');
    document.querySelector('.user-button').click();
    await waitFor(() => document.querySelector('.settings-modal'), 'settings open');
    const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === '连接');
    if (!nav) throw new Error('连接 nav missing: ' + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join('|'));
    nav.click();
    await waitFor(() => document.querySelector('.web-capture-status-card'), 'extension status card');

    const stateLine = () => document.querySelector('.web-capture-status-card .web-capture-state')?.textContent.trim() || '';
    await waitFor(() => stateLine() === '已连接', '已连接 state line');
    const rows = () => Array.from(document.querySelectorAll('.web-capture-status-card .web-capture-row')).map((el) => el.textContent.trim());
    await waitFor(() => rows().some((text) => text.includes('${CAPTURED_VERSION}')), 'version row');

    const retryButton = () => document.querySelector('.web-capture-status-card .web-capture-retry');
    const retryBeforeRefresh = Boolean(retryButton());

    const requestIdBefore = Number((await bridgeStatus()).retryRequestId || 0);
    await reportQueue();

    document.querySelector('.web-capture-status-card .web-capture-refresh').click();
    await waitFor(() => retryButton(), 'retry row after refresh');
    const cardText = () => document.querySelector('.web-capture-status-card').textContent;
    await waitFor(() => cardText().includes('等待重试 2 张'), 'pending count row');
    const pendingText = rows().find((text) => text.includes('等待重试')) || '';
    const requestIdAfterRefresh = Number((await bridgeStatus()).retryRequestId || 0);
    if (requestIdAfterRefresh !== requestIdBefore) {
      throw new Error('retryRequestId changed before the retry click: ' + requestIdAfterRefresh);
    }

    retryButton().click();
    await waitFor(() => document.querySelector('.web-capture-status-card .web-capture-retried'), '已让扩展重试 confirmation');
    const retriedShown = document.querySelector('.web-capture-status-card .web-capture-retried')?.textContent.trim() === '已让扩展重试';
    await waitFor(async () => Number((await bridgeStatus()).retryRequestId || 0) === requestIdBefore + 1, 'server retryRequestId +1');

    return {
      connectedText: stateLine(),
      versionShown: '${CAPTURED_VERSION}',
      retryBeforeRefresh,
      retryAfterRefresh: true,
      pendingText,
      retryRequestIdBefore: requestIdBefore,
      retriedShown,
      retryRequestIdAfter: Number((await bridgeStatus()).retryRequestId || 0),
    };
  })()
  `;
}

// ---- Local helpers mirroring the runner's desktop plumbing (the flow ctx
// does not expose a desktop launcher or CDP) ----

function sleep(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForPid(filePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number.parseInt(await readFile(filePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    await sleep(100);
  }
  throw new Error(`PID timeout: ${filePath}`);
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(filePath, "utf8")); } catch {}
    await sleep(100);
  }
  throw new Error(`Health file timeout: ${filePath}`);
}

async function connectCdp(port, expectedUrlPrefix, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix));
      }
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error(`No Electron CDP target found on ${port}`);
  return openCdpSession(target.webSocketDebuggerUrl);
}

async function openCdpSession(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message || "CDP command failed"));
    else request.resolve(message.result);
  });

  function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await command("Runtime.enable");
  return {
    command,
    async evaluate(expression) {
      const response = await command("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (response.exceptionDetails) {
        const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Renderer evaluation failed";
        throw new Error(description);
      }
      return response.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
      })`);
      if (state?.readyState === 'complete' && state.appShell && state.preload) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`Desktop renderer readiness timeout${lastError ? `: ${lastError.message}` : ''}`);
}

// Only this flow's own leftovers are matched: the launcher executable inside
// this flow's tasks/logs marker directory. Started by earlier rounds of this
// same flow on this machine, so killing them stays within "only your own".
async function stopLeftoverDesktopLaunchers() {
  const { execFile } = await import("node:child_process");
  const list = await new Promise((resolve) => {
    execFile("ps", ["-eo", "pid=,args="], (error, stdout) => resolve(error ? "" : String(stdout)));
  });
  for (const line of list.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const args = match[2];
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (!args.includes("extension-card-desktop-run") || !args.includes("launch-mosa-qa")) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await sleep(500);
}

async function stopPid(pid) {
  if (!(await signalProcessTree(pid))) return;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await sleep(100);
  }
  await signalProcessTree(pid, { force: true }).catch(() => {});
}
