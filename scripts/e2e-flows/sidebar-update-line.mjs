// sidebar-update-line.mjs — task 253: the sidebar update reminder is one
// polished single-line button ABOVE the 用户中心 button.
//
// The App subscribes to getUpdateReady/onUpdateReady exactly once on mount,
// and the real preload defines window.electronAPI as a non-configurable
// property, so a renderer-side fake can never reach the subscription
// (Electron also strips --require/NODE_OPTIONS hooks from its main process).
// The QA doubles therefore land inside the real main process through its
// inspector (--inspect): the flow sets a breakpoint on the get-update-ready
// handler in desktop/main.mjs, and when the App's mount-time query hits it,
// the flow evaluates a replacement ON that call frame — the frame's scope is
// the only place outside desktop/ where ipcMain is reachable — registering
// QA doubles for the two update channels ("9.9.9" staged; install reports
// {status:"installing"} and counts calls on globalThis.__e2eUpdateLine).
// The renderer runs fully production code and cannot tell the doubles from
// the real main process; a second reload makes the mount-time subscription
// query the doubles.
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "sidebar-update-line";
export const description =
  "sidebar update-ready line: single-row reminder above 用户中心 (position, 32px, one line, zh/en copy) -> click restarts (install called once, disabled, 正在更新…) -> null config renders nothing";

// desktop/main.mjs, the first line inside the get-update-ready handler body
// (0-based for Debugger.setBreakpointByUrl, i.e. the handler line + 1): the
// first paused frame evaluates the swap with ipcMain in scope. Located from
// the source so edits elsewhere in main.mjs never move it off the handler.
const GET_UPDATE_READY_BREAKPOINT_LINE = await (async () => {
  const source = await readFile(new URL("../../desktop/main.mjs", import.meta.url), "utf8");
  const handlerIndex = source.split("\n").findIndex((line) => line.includes('ipcMain.handle("get-update-ready"'));
  if (handlerIndex < 0) throw new Error("get-update-ready handler not found in desktop/main.mjs");
  return handlerIndex + 1;
})();

const REPLACE_HANDLERS_ON_FRAME = `(() => {
  globalThis.__e2eUpdateLine = { config: { version: "9.9.9" }, installs: 0 };
  ipcMain.removeHandler("get-update-ready");
  ipcMain.handle("get-update-ready", async () => globalThis.__e2eUpdateLine.config);
  ipcMain.removeHandler("download-and-install-update");
  ipcMain.handle("download-and-install-update", async () => {
    globalThis.__e2eUpdateLine.installs += 1;
    return { status: "installing" };
  });
  return "replaced";
})()`;

export async function run(ctx) {
  await ctx.prepare();
  const port = await freePort();
  const cdpPort = await freePort();
  const inspectorPort = await freePort();
  const pidFile = join(ctx.userDataDir, "pid.txt");
  const logFile = join(ctx.userDataDir, "main.log");
  const healthFile = join(ctx.userDataDir, "health.json");
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: ctx.userDataDir,
    executable,
    args: [
      ...qaFlags,
      "desktop/main.mjs",
      `--user-data-dir=${ctx.userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--inspect=${inspectorPort}`,
    ],
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
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });

  let cdp = null;
  let main = null;
  let failed = false;
  const screenshots = {};
  try {
    await waitForHealthFile(healthFile);
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
    main = await connectMainInspector(inspectorPort);
    await waitForExpression(cdp, "Boolean(document.querySelector('.app'))", "app shell");
    // Renderer-side preferences start unset: the language defaults to zh.
    await cdp.evaluate(`localStorage.removeItem("gravityport.preferences")`);
    try {
      await installUpdateDoubles(cdp, main);
    } catch (error) {
      // Was the main process left frozen on the breakpoint (events lost), or
      // is the renderer itself gone? The answer changes the fix.
      const mainState = await Promise.race([
        main.evaluate("1+1").then(() => "main responsive (NOT paused)"),
        new Promise(resolve => setTimeout(() => resolve("main FROZEN (paused, paused-event lost)"), 3000)),
      ]).catch(() => "main unreachable");
      throw new Error(`${error.message}; diagnostic: ${mainState}`);
    }
    // After the swap the App must mount again for its one-time subscription
    // to query the doubles.
    await reloadAndSettle(cdp);

    // Round 1 (zh): the row exists, sits above 用户中心, is a 32px single
    // line with a 6px dot, and the sidebar gains no horizontal scrollbar.
    await waitForExpression(cdp, "Boolean(document.querySelector('.update-ready-line'))", "update-ready line");
    const zh = await cdp.evaluate(inspectLine());
    assertOk(zh.present, "update-ready line present");
    assertOk(zh.userTop !== null && zh.top < zh.userTop, `line above 用户中心 (top ${zh.top} < 用户中心 ${zh.userTop})`);
    assertOk(Math.abs(zh.height - 32) <= 1, `line height 32±1 (got ${zh.height})`);
    assertOk(zh.oneLine, `label stays on one line (scrollHeight ${zh.labelScroll} <= clientHeight ${zh.labelClient})`);
    assertOk(zh.sidebarScrollWidth <= zh.sidebarClientWidth, `sidebar has no horizontal scrollbar (${zh.sidebarScrollWidth} > ${zh.sidebarClientWidth})`);
    assertEqual(zh.text, "新版本 9.9.9", "zh label");
    assertEqual(zh.action, "重启更新", "zh action");
    assertEqual(zh.title, "重启并更新到 v9.9.9", "zh title");
    assertEqual(zh.ariaLabel, "重启并更新到 v9.9.9", "zh aria-label");
    assertEqual(zh.disabled, false, "line enabled before click");
    assertOk(zh.dotSize !== null && zh.dotSize[0] === 6 && zh.dotSize[1] === 6, `6px dot (got ${JSON.stringify(zh.dotSize)})`);

    // Round 2 (en): the same row reads v9.9.9 ready / Restart after switching
    // the interface language from the settings UI, then back to zh.
    await switchLanguage(cdp, "en");
    const en = await cdp.evaluate(inspectLine());
    assertEqual(en.text, "v9.9.9 ready", "en label");
    assertEqual(en.action, "Restart", "en action");
    assertEqual(en.title, "Restart to update to v9.9.9", "en title");
    await switchLanguage(cdp, "zh");

    // Screenshots for the task report (dark + light), row still idle.
    screenshots.dark = await shotWithAppearance(cdp, ctx.fixturesDir, "253-dark.png", "深色");
    screenshots.light = await shotWithAppearance(cdp, ctx.fixturesDir, "253-light.png", "浅色");

    // Round 3 (click): install called exactly once, the row disables and reads
    // 正在更新…, and the cursor is no longer a pointer.
    await cdp.evaluate(`document.querySelector('.update-ready-line').click()`);
    await waitForExpression(
      cdp,
      `(() => { const line = document.querySelector('.update-ready-line'); return Boolean(line && line.disabled && line.querySelector('.update-ready-action').textContent.trim() === "正在更新…"); })()`,
      "pending state (disabled + 正在更新…)",
    );
    const clicked = await cdp.evaluate(`(() => {
      const line = document.querySelector('.update-ready-line');
      return { cursor: getComputedStyle(line).cursor };
    })()`);
    const installs = await main.evaluate(`globalThis.__e2eUpdateLine.installs`);
    assertEqual(installs, 1, `downloadAndInstallUpdate called once (got ${installs})`);
    assertOk(clicked.cursor !== "pointer", `disabled row must not show a pointer (got ${clicked.cursor})`);

    // Round 4 (null): with the main process answering null the row renders
    // nothing after a fresh mount.
    await main.evaluate(`globalThis.__e2eUpdateLine.config = null`);
    await reloadAndSettle(cdp);
    const absent = await cdp.evaluate(`({ present: Boolean(document.querySelector('.update-ready-line')) })`);
    assertEqual(absent.present, false, "no reminder row when getUpdateReady answers null");

    return { ok: true, rounds: 4, screenshots };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (cdp) cdp.close();
    if (main) main.close();
    const pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => "0"), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      await sleep(1500);
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    if (launched.waiter && launched.waiter.exitCode === null) {
      try { launched.waiter.kill("SIGTERM"); } catch {}
    }
    // Keep the scene (main.log with renderer crash lines) when it failed.
    if (!failed) await rm(ctx.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
    else process.stderr.write(`[flow] failed run kept for diagnosis: ${ctx.userDataDir}\n`);
  }
}

// Register the QA doubles inside the running main process: breakpoint on the
// get-update-ready handler body, let the App's next mount-time query hit it,
// then evaluate the swap on that paused frame (the only place ipcMain is in
// scope without touching desktop/). The interrupted query still answers null
// — a final reload makes the App ask the doubles.
async function installUpdateDoubles(cdp, main) {
  await main.send("Debugger.enable");
  const breakpoint = await main.send("Debugger.setBreakpointByUrl", {
    urlRegex: ".*desktop/main\\.mjs$",
    lineNumber: GET_UPDATE_READY_BREAKPOINT_LINE,
    columnNumber: 0,
  });
  const paused = waitForPaused(main);
  try {
    await reloadAndSettle(cdp);
    const params = await paused;
    const probe = await main.send("Debugger.evaluateOnCallFrame", {
      callFrameId: params.callFrames[0].callFrameId,
      expression: "(typeof ipcMain === 'object' && typeof ipcMain.handle === 'function') ? 'main-frame' : 'other'",
      returnByValue: true,
    });
    if (probe.result?.value !== "main-frame") {
      throw new Error(`breakpoint hit an unexpected frame (${probe.result?.value}) — desktop/main.mjs moved?`);
    }
    const swap = await main.send("Debugger.evaluateOnCallFrame", {
      callFrameId: params.callFrames[0].callFrameId,
      expression: REPLACE_HANDLERS_ON_FRAME,
      returnByValue: true,
    });
    if (swap.result?.value !== "replaced") {
      throw new Error("registering the QA doubles failed: " + JSON.stringify(swap.result?.value));
    }
  } finally {
    // Never leave the main process frozen, whatever went wrong above.
    if (breakpoint.breakpointId) await main.send("Debugger.removeBreakpoint", { breakpointId: breakpoint.breakpointId }).catch(() => {});
    await main.send("Debugger.resume").catch(() => {});
  }
}

function inspectLine() {
  return `(() => {
    const line = document.querySelector('.update-ready-line');
    if (!line) return { present: false };
    const user = document.querySelector('.user-button');
    const sidebar = document.querySelector('.sidebar');
    const label = line.querySelector('.update-ready-label');
    const action = line.querySelector('.update-ready-action');
    const dot = line.querySelector('.update-ready-dot');
    const rect = line.getBoundingClientRect();
    const dotRect = dot ? dot.getBoundingClientRect() : null;
    return {
      present: true,
      top: rect.top,
      userTop: user ? user.getBoundingClientRect().top : null,
      height: rect.height,
      oneLine: label ? label.scrollHeight <= label.clientHeight : line.scrollHeight <= line.clientHeight,
      labelScroll: label ? label.scrollHeight : line.scrollHeight,
      labelClient: label ? label.clientHeight : line.clientHeight,
      sidebarScrollWidth: sidebar.scrollWidth,
      sidebarClientWidth: sidebar.clientWidth,
      text: label ? label.textContent.replace(/\\s+/g, " ").trim() : "",
      action: action ? action.textContent.trim() : null,
      title: line.getAttribute("title"),
      ariaLabel: line.getAttribute("aria-label"),
      disabled: line.disabled,
      cursor: getComputedStyle(line).cursor,
      dotSize: dotRect ? [dotRect.width, dotRect.height] : null,
    };
  })()`;
}

// Open the settings dialog from the 用户中心 button, flip the language on the
// 常规 page, and close the dialog with Escape — the same path a user takes.
async function switchLanguage(cdp, target) {
  await cdp.evaluate(`document.querySelector('.user-button').click()`);
  await waitForExpression(cdp, "Boolean(document.querySelector('.settings-modal'))", "settings open");
  const navTitle = target === "en" ? "常规" : "General";
  const buttonTitle = target === "en" ? "English" : "中文";
  await cdp.evaluate(`(() => {
    const nav = Array.from(document.querySelectorAll('.settings-nav button')).find((b) => b.textContent.trim() === ${JSON.stringify(navTitle)});
    if (!nav) throw new Error("general nav missing: " + Array.from(document.querySelectorAll('.settings-nav button')).map((b) => b.textContent.trim()).join("|"));
    nav.click();
  })()`);
  await waitForExpression(
    cdp,
    `Array.from(document.querySelectorAll('.settings-content .segmented button')).some((b) => b.textContent.trim() === ${JSON.stringify(buttonTitle)})`,
    "language segmented control",
  );
  await cdp.evaluate(`(() => {
    Array.from(document.querySelectorAll('.settings-content .segmented button')).find((b) => b.textContent.trim() === ${JSON.stringify(buttonTitle)}).click();
  })()`);
  await waitForExpression(
    cdp,
    target === "en"
      ? `Array.from(document.querySelectorAll('.settings-nav button')).some((b) => b.textContent.trim() === "General")`
      : `Array.from(document.querySelectorAll('.settings-nav button')).some((b) => b.textContent.trim() === "常规")`,
    `ui language switched to ${target}`,
  );
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await waitForExpression(cdp, `!document.querySelector('.settings-modal')`, "settings closed");
}

// Persist the wanted appearance, reload, and wait until the app picked it up
// before capturing the window (the screenshots ride the flow's fixtures dir).
async function shotWithAppearance(cdp, dir, fileName, appearance) {
  await setPreferences(cdp, { appearance });
  await reloadAndSettle(cdp);
  await waitForExpression(cdp, "Boolean(document.querySelector('.update-ready-line'))", `update-ready line (${appearance})`);
  const wantsDark = appearance === "深色";
  await waitForExpression(
    cdp,
    wantsDark
      ? `Boolean(document.querySelector('.app') && document.querySelector('.app').classList.contains('dark'))`
      : `Boolean(document.querySelector('.app') && !document.querySelector('.app').classList.contains('dark'))`,
    `${appearance} theme applied`,
  );
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const filePath = join(dir, fileName);
  await writeFile(filePath, Buffer.from(shot.data, "base64"));
  // The runner wipes its temp root (screenshots included) when it exits, so a
  // report consumer can name a surviving copy directory for this run.
  const copyTo = process.env.MOSA_E2E_SHOT_COPY_TO;
  if (copyTo) await writeFile(join(copyTo, fileName), Buffer.from(shot.data, "base64")).catch(() => {});
  return filePath;
}

async function setPreferences(cdp, overrides) {
  const value = { appearance: "跟随系统", cardInfo: false, language: "zh", ...overrides };
  await cdp.evaluate(`localStorage.setItem("gravityport.preferences", ${JSON.stringify(JSON.stringify(value))})`);
}

async function reloadAndSettle(cdp) {
  // In the GUI-launcher (Launch Services) environment a CDP Page.reload kills
  // the hidden window's renderer; a plain in-page location.reload() is a
  // normal navigation and survives. The evaluate's own answer dies with the
  // navigation — fire it and poll the DOM instead of awaiting it.
  cdp.evaluate("location.reload()").catch(() => {});
  await waitForExpression(cdp, `Boolean(document.querySelector('.app'))`, "app shell after reload");
}

async function waitForExpression(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      // A reload can strand an evaluate on the detached frame forever; drop
      // stalled calls and keep polling instead of waiting on them.
      const value = await Promise.race([
        cdp.evaluate(expression),
        new Promise((_, reject) => setTimeout(() => reject(new Error("evaluate stalled")), 1500)),
      ]);
      if (value === true) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertOk(condition, label) {
  if (!condition) throw new Error(label);
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

// The main-process inspector (launched with --inspect) speaks the same JSON
// WS protocol; its /json/list only exposes the node target.
async function connectMainInspector(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === "node" && entry.webSocketDebuggerUrl);
        if (target) return openCdpSession(target.webSocketDebuggerUrl);
      }
    } catch {}
    await sleep(200);
  }
  throw new Error(`no main-process inspector target on port ${port}`);
}

function waitForPaused(session, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("no Debugger.paused within " + timeoutMs + "ms — did the App query get-update-ready?"));
    }, timeoutMs);
    const off = session.onEvent((message) => {
      if (message.method !== "Debugger.paused") return;
      clearTimeout(timer);
      off();
      resolve(message.params);
    });
  });
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
  const eventHandlers = new Set();
  const socket = new WebSocket(url);
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve: resolveFn, reject: rejectFn } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectFn(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        rejectFn(new Error("evaluate failed: " + (message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)));
      } else resolveFn(message.result);
      return;
    }
    if (message.method) for (const handler of eventHandlers) handler(message);
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
      const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
      return result?.result?.value;
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => eventHandlers.delete(handler);
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
