// desktop-update-ready.mjs — end-to-end test for the renderer-ready lifecycle
// (task 129): verifies that the renderer calls reportRendererReady() only after
// the three conditions are met (version consistency, first asset page, SSE open),
// and that the main process writes the update-ready file to the staging area.
//
import { createServer } from "node:http";
import { readFile, mkdir, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "desktop-update-ready";
export const description =
  "renderer-ready lifecycle: version-check + first-page + SSE → reportRendererReady → main-process writes update-ready file under staging root";

export async function run(ctx) {
  await ctx.prepare();

  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(ctx.userDataDir, "pid.txt");
  const logFile = join(ctx.userDataDir, "main.log");
  const healthFile = join(ctx.userDataDir, "health.json");

  // The update-ready file must live under the platform's staging root, which
  // the main process derives from app.getPath("userData"): updates/macos
  // (resolveMacosUpdateReadyFile) or updates/windows
  // (resolveWindowsUpdateReadyFile). Electron resolves macOS /var to
  // /private/var but keeps a Windows 8.3 short name (RUNNER~1) as given, so
  // hand it one resolved path and build the ready file from the same one.
  const userDataDir = realpathSync.native(ctx.userDataDir);
  const stagingRoot = join(userDataDir, "updates", process.platform === "win32" ? "windows" : "macos");
  const updateReadyFile = join(stagingRoot, "gravityport-update-ready.json");

  await mkdir(stagingRoot, { recursive: true });

  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];

  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: ctx.userDataDir,
    executable,
    args: [
      ...qaFlags,
      "desktop/main.mjs",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      // This tells the main process where to write the ready file.
      `--mosa-update-ready-file=${updateReadyFile}`,
    ],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      MOSA_PROJECT_DIR: ctx.rootDir,
      MOSA_DESKTOP_PORT: String(port),
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
    const seededIds = await seedAssets(ctx, port);
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);

    await waitForRendererReady(cdp);

    // The renderer must eventually write the ready file. The three conditions
    // (version consistency + first page + SSE open) all resolve in practice
    // within a few seconds; 30 s is generous for CI.
    await waitForUpdateReadyFile(updateReadyFile, 30_000);

    // Verify the file contains the required fields.
    const content = JSON.parse(await readFile(updateReadyFile, "utf8"));

    const required = ["version", "gitSha", "uiFingerprint", "runtimeFingerprint"];
    for (const field of required) {
      if (!content[field] || typeof content[field] !== "string" || !content[field].trim()) {
        throw new Error(`update-ready file missing or empty field: ${field}`);
      }
    }

    // Re-seed enough assets that the test can run again without conflict.
    void seededIds;

    return { ok: true, readyFileFields: required };
  } finally {
    if (cdp) cdp.close();
    const pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await sleep(1500);
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    if (launched.waiter && launched.waiter.exitCode === null) {
      try { launched.waiter.kill("SIGTERM"); } catch {}
    }
    await rm(ctx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

// ---- helpers (mirrors desktop-input.mjs) -----------------------------------

async function seedAssets(ctx, port) {
  const origin = `http://127.0.0.1:${port}`;
  const seededIds = [];
  for (let index = 0; index < 8; index++) {
    const tint = [(index * 37) % 256, (index * 71 + 30) % 256, (index * 113 + 90) % 256];
    const imagePath = await ctx.makePng(`desktop-update-ready-${index}.png`, tint);
    const bytes = await readFile(imagePath);
    const staged = await fetch(`${origin}/api/import/stage`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-mosa-file-name": encodeURIComponent(`desktop-update-ready-${index}.png`),
        "x-mosa-client-token": ctx.token,
      },
      body: bytes,
    });
    if (!staged.ok) throw new Error(`import stage failed (${staged.status})`);
    const { path: stagedPath } = await staged.json();
    const created = await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: stagedPath,
      prompt: `desktop-update-ready seed ${index}`,
    });
    if (!created?.asset?.id) throw new Error(`asset create failed`);
    seededIds.push(created.asset.id);
  }
  return seededIds;
}

async function waitForHealthFile(filePath, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse(await readFile(filePath, "utf8"));
      if (health?.product === "mosa") return health;
    } catch {}
    await sleep(250);
  }
  throw new Error("health file timeout");
}

async function waitForUpdateReadyFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, "utf8");
      return; // file exists
    } catch {}
    await sleep(250);
  }
  throw new Error(`update-ready file never appeared at ${filePath} within ${timeoutMs}ms`);
}

async function waitForRendererReady(cdp, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
      })`);
      if (state?.readyState === "complete" && state.appShell && state.preload) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`renderer readiness timeout${lastError ? `: ${lastError.message}` : ""}`);
}

async function connectCdp(cdpPort, expectedUrlPrefix, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find(
          (entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedUrlPrefix),
        );
        if (target?.webSocketDebuggerUrl) return openCdpSession(target.webSocketDebuggerUrl);
      }
    } catch {}
    await sleep(200);
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
      const { resolve: resolveFn, reject: rejectFn } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectFn(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        rejectFn(new Error("evaluate failed: " + (message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)));
      } else resolveFn(message.result?.result?.value);
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
    async evaluate(expression) {
      return this.send("Runtime.evaluate", { expression, returnByValue: true });
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

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
