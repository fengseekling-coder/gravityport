// E2E flow (任务 116): the one-time rename notice in the real desktop shell.
// The web driver has no preload (no electronAPI), so this flow launches
// desktop/main.mjs exactly like the built-in electron round does.
// - Round A (zh): userData pre-seeded with anonymous-usage.json BEFORE the first
//   launch -> the notice pops on the first screen; title/body/button match the
//   pinned copy character for character, exactly one visible button, focus on it;
//   clicking 知道了 closes it and rename-notice.json flips to acknowledged;
//   relaunching the SAME userData never pops again.
// - Round B (en): a second fresh old-user userData gets the English copy;
//   dismissing with Escape also acknowledges.
// - Round C: a fresh userData with no old-user signal never pops and records
//   state "not-needed" (the real startup order decides before anything writes).

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { signalProcessTree } from "../process-tree.mjs";

export const name = "rename-notice";
export const description = "old-user userData -> one-time rename notice (zh + en, single button) -> acknowledge (click / Esc) -> restart stays quiet; fresh userData never pops";

const ZH_COPY = {
  title: "MOSA 现已更名为 GravityPort",
  body: "只是换了名字。你的素材、设置和浏览器插件都在原处，不需要做任何操作。",
  button: "知道了",
};
const EN_COPY = {
  title: "MOSA is now GravityPort",
  body: "Only the name has changed. Your library, settings, and browser extension are right where you left them. There is nothing you need to do.",
  button: "Got it",
};
const DISABLED_BRIDGES = "cowart,cowartDiscovery,codex,grok";
const MARKER_FILE = "rename-notice.json";
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function run(ctx) {
  await ctx.prepare();
  const electronBinary = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const flowRoot = dirname(ctx.userDataDir);
  const generatedDir = join(flowRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });

  // Round A (zh): click the button to acknowledge, then restart the same userData.
  const zhUserData = ctx.userDataDir;
  await seedOldUser(zhUserData);
  let shell = await launchShell(ctx, electronBinary, generatedDir, { userDataDir: zhUserData, lang: "zh-CN", tag: "zh-1" });
  try {
    assertNotice(await shell.cdp.evaluate(noticeProbeSource()), ZH_COPY, "zh");
    const ack = await shell.cdp.evaluate(acknowledgeByButtonSource());
    if (ack?.closed !== true) throw new Error(`Rename notice did not close after the button click: ${JSON.stringify(ack)}`);
  } finally {
    await stopShell(shell);
  }
  const acknowledged = await readMarkerState(zhUserData, "acknowledged");
  if (acknowledged.version !== 1 || acknowledged.state !== "acknowledged") {
    throw new Error(`Marker after the button click should be {version:1, acknowledged}, got ${JSON.stringify(acknowledged)}`);
  }

  shell = await launchShell(ctx, electronBinary, generatedDir, { userDataDir: zhUserData, lang: "zh-CN", tag: "zh-2" });
  try {
    const quiet = await shell.cdp.evaluate(quietProbeSource(5000));
    if (quiet?.popped !== false) throw new Error(`Rename notice popped again after being acknowledged: ${JSON.stringify(quiet)}`);
  } finally {
    await stopShell(shell);
  }

  // Round B (en): Escape counts as read too.
  const enUserData = join(flowRoot, "user-data-en");
  await seedOldUser(enUserData);
  shell = await launchShell(ctx, electronBinary, generatedDir, { userDataDir: enUserData, lang: "en-US", tag: "en-1" });
  try {
    assertNotice(await shell.cdp.evaluate(noticeProbeSource()), EN_COPY, "en");
    const ack = await shell.cdp.evaluate(acknowledgeByEscapeSource());
    if (ack?.closed !== true) throw new Error(`Rename notice did not close after Escape: ${JSON.stringify(ack)}`);
  } finally {
    await stopShell(shell);
  }
  const acknowledgedEn = await readMarkerState(enUserData, "acknowledged");
  if (acknowledgedEn.state !== "acknowledged") {
    throw new Error(`Marker after Escape should be acknowledged, got ${JSON.stringify(acknowledgedEn)}`);
  }

  // Round C: fresh userData (new user) — never pops, marker records not-needed.
  const freshUserData = join(flowRoot, "user-data-fresh");
  shell = await launchShell(ctx, electronBinary, generatedDir, { userDataDir: freshUserData, lang: "zh-CN", tag: "fresh-1" });
  try {
    const quiet = await shell.cdp.evaluate(quietProbeSource(5000));
    if (quiet?.popped !== false) throw new Error(`Rename notice popped for a fresh userData: ${JSON.stringify(quiet)}`);
  } finally {
    await stopShell(shell);
  }
  const freshMarker = await readMarkerState(freshUserData, "not-needed");
  if (freshMarker.version !== 1 || freshMarker.state !== "not-needed") {
    throw new Error(`Fresh userData should record {version:1, not-needed}, got ${JSON.stringify(freshMarker)}`);
  }

  return { zhRoundAcked: acknowledged.state, enRoundAcked: acknowledgedEn.state, freshState: freshMarker.state };
}

async function seedOldUser(userDataDir) {
  await mkdir(userDataDir, { recursive: true });
  await writeFile(join(userDataDir, "anonymous-usage.json"), `${JSON.stringify({
    schemaVersion: 2,
    installationId: randomUUID(),
    firstReportedAt: 1,
    lastReportedAt: 1,
    lastReportedDay: "2026-10-10",
  }, null, 2)}\n`, "utf8");
}

async function launchShell(ctx, electronBinary, generatedDir, { userDataDir, lang, tag }) {
  const runDir = join(dirname(ctx.userDataDir), `shell-${tag}`);
  await mkdir(runDir, { recursive: true });
  const pidFile = join(runDir, "pid.txt");
  const logFile = join(runDir, "main.log");
  const healthFile = join(runDir, "health.json");
  const port = await freePort();
  const cdpPort = await freePort();
  const args = ["desktop/main.mjs", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`];
  if (lang) args.push(`--lang=${lang}`);
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: runDir,
    executable: electronBinary,
    args,
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_DISABLE_BRIDGES: DISABLED_BRIDGES,
      MOSA_PROJECT_DIR: ctx.rootDir,
      CODEX_GENERATED_IMAGES_DIR: generatedDir,
      MOSA_DESKTOP_PORT: String(port),
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile,
  });
  const stop = async () => {
    let pid = launched.pid;
    if (!pid) {
      for (let i = 0; i < 100 && !pid; i += 1) {
        pid = Number.parseInt(await readFile(pidFile, "utf8").catch(() => ""), 10) || null;
        if (!pid) await sleep(100);
      }
    }
    if (pid) await signalProcessTree(pid).catch(() => {});
    if (launched.waiter?.exitCode === null) launched.waiter.kill("SIGTERM");
  };
  try {
    const health = await waitForHealthFile(healthFile);
    if (health?.product !== "mosa") throw new Error(`unexpected health product: ${health?.product}`);
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    await stop();
    throw new Error(`rename-notice desktop shell failed to launch (${tag})\n${log}`, { cause: error });
  }
  const cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
  await waitForRendererReady(cdp);
  return { cdp, stop, logFile };
}

async function stopShell(shell) {
  shell.cdp.close();
  await shell.stop();
}

function assertNotice(probe, copy, label) {
  const expectedLang = label === "zh" ? "zh-CN" : "en";
  const problems = [];
  if (probe?.opened !== true) problems.push("dialog did not open");
  if (probe?.lang !== expectedLang) problems.push(`document lang ${JSON.stringify(probe?.lang)} != ${expectedLang}`);
  if (probe?.title !== copy.title) problems.push(`title ${JSON.stringify(probe?.title)}`);
  if (probe?.body !== copy.body) problems.push(`body ${JSON.stringify(probe?.body)}`);
  if (probe?.button !== copy.button) problems.push(`button ${JSON.stringify(probe?.button)}`);
  if (probe?.visibleButtons !== 1) problems.push(`visibleButtons ${JSON.stringify(probe?.visibleButtons)}`);
  if (probe?.cancelHidden !== true) problems.push("cancel button still visible");
  if (probe?.dontAskHidden !== true) problems.push("dont-ask row visible");
  if (probe?.focusOnConfirm !== true) problems.push("focus not on the confirm button");
  if (probe?.confirmIsPrimary !== true || probe?.tone === "danger") problems.push("confirm button is not the primary tone");
  if (problems.length) {
    throw new Error(`Rename notice (${label}) mismatch: ${problems.join("; ")} — ${JSON.stringify(probe)}`);
  }
}

async function readMarkerState(userDataDir, expectedState) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const parsed = JSON.parse(await readFile(join(userDataDir, MARKER_FILE), "utf8"));
      if (parsed?.state === expectedState) return parsed;
    } catch {}
    await sleep(100);
  }
  throw new Error(`${MARKER_FILE} never reached state ${expectedState} under ${userDataDir}`);
}

// ===== In-page probes =====

function noticeProbeSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let opened = false;
    for (let i = 0; i < 200; i += 1) {
      if (document.querySelector('#confirmDialog')?.classList.contains('open') === true) { opened = true; break; }
      await sleep(100);
    }
    const cancel = document.querySelector('#confirmDialogCancel');
    const confirm = document.querySelector('#confirmDialogConfirm');
    return {
      opened,
      lang: document.documentElement.lang,
      title: document.querySelector('#confirmDialogTitle')?.textContent || '',
      body: document.querySelector('#confirmDialogDescription')?.textContent || '',
      button: confirm?.textContent || '',
      // Rendered visibility, not the hidden attribute: an author display rule on the
      // button class would keep a [hidden] button on screen.
      visibleButtons: [confirm, cancel].filter((b) => b && getComputedStyle(b).display !== 'none' && b.getClientRects().length > 0).length,
      cancelHidden: Boolean(cancel) && cancel.hidden === true && getComputedStyle(cancel).display === 'none' && cancel.getClientRects().length === 0,
      dontAskHidden: document.querySelector('#confirmDialogDontAsk')?.hidden !== false,
      focusOnConfirm: document.activeElement === confirm,
      confirmIsPrimary: confirm?.classList.contains('btn-primary') === true,
      tone: document.querySelector('#confirmDialogCard')?.dataset.tone || '',
    };
  })()`;
}

function acknowledgeByButtonSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.querySelector('#confirmDialogConfirm')?.click();
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#confirmDialog')?.classList.contains('open') !== true) {
        return { closed: true };
      }
      await sleep(100);
    }
    return { closed: false };
  })()`;
}

function acknowledgeByEscapeSource() {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector('#confirmDialog')?.classList.contains('open') !== true) {
        return { closed: true };
      }
      await sleep(100);
    }
    return { closed: false };
  })()`;
}

function quietProbeSource(settleMs) {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < ${Math.floor(settleMs / 100)}; i += 1) {
      if (document.querySelector('#confirmDialog')?.classList.contains('open') === true) return { popped: true };
      await sleep(100);
    }
    return { popped: false };
  })()`;
}

// ===== Local infra helpers (the built-in rounds keep theirs private) =====

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

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('#appShell')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
      })`);
      if (state?.readyState === 'complete' && state.appShell && state.preload) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("rename-notice renderer readiness timeout");
}

async function openCdpSession(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => rejectOpen(new Error("CDP websocket failed to open")), { once: true });
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
