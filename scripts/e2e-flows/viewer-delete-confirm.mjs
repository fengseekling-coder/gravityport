// GravityPort React UI flow (task 385): a delete request for the asset the
// viewer is showing pops the authorization dialog. Method declared here: the
// Node side plays the MCP client against a REAL spawned mcp/server.mjs
// process (no request files are written by hand) — it initializes with a
// client name and calls asset_trash on the viewed asset; the App must ask
// first.
//
// Round 1 — approval: viewer opens on X, MCP trashes X, the dialog shows
// 「允许 Claude 删除这张素材吗？」with the MCP source line and a countdown;
// clicking 允许删除 trashes X and the viewer steps to the next card.
//
// Round 2 — denial by button and by Escape: the asset stays, the dialog
// closes, and the MCP tool call answers the declined error.
//
// Round 3 — timeout: nobody answers, the dialog closes itself, the timeout
// toast appears, and the MCP call reports user_no_response.
//
// Round 4 — queue order: a pairing request and a deletion request pending at
// once; the pairing dialog shows first and the deletion one only after it is
// decided.
export const name = "viewer-delete-confirm";
export const description = "real MCP process: asset_trash on the viewed asset -> authorization dialog (Claude/MCP, countdown) -> 允许删除 trashes and the viewer steps; 不允许 and Esc keep it; timeout toast; a pending pairing dialog shows before the deletion one";

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";

const DEVELOPMENT_ORIGIN = "chrome-extension://hjcildpmialbefmcdpdooenlojecjpli";
const CAPTURE_TOKEN = "mosa_e2e_viewer_delete_capture_token";
// Task 385: the two dialog screenshots land here (absolute, per the task
// sheet); MOSA_E2E_SHOT_COPY_TO keeps a surviving copy when set.
const SHOT_DIR = join(homedir(), "codex_aigc", "素材", "日志", "385-截图");

// The MCP server runs with its own throwaway HOME and the flow's library —
// the same isolation contract as test/helpers/mcp-server-harness.mjs.
async function startMcpProcess(libraryDir, rootDir) {
  const homeDir = await mkdtemp(join(tmpdir(), "mosa-e2e-viewer-delete-home-"));
  const child = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: rootDir,
    env: {
      ...process.env,
      HOME: homeDir,
      MOSA_PROJECT_DIR: rootDir,
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_QA_RUN: "1",
      // The dialog countdown runs from the server's expiresAt: long enough to
      // answer rounds 1/2 comfortably, short enough that round 3 does not
      // stall the whole run.
      MOSA_DELETE_CONFIRM_TIMEOUT_MS: "30000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handle = { child, stderr: "", nextId: 1, pending: new Map() };
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && handle.pending.has(message.id)) {
        const { resolve } = handle.pending.get(message.id);
        handle.pending.delete(message.id);
        resolve(message);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { handle.stderr += chunk; });
  handle.request = (method, params) => new Promise((resolve, reject) => {
    const id = handle.nextId;
    handle.nextId += 1;
    handle.pending.set(id, { resolve });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (handle.pending.has(id)) {
        handle.pending.delete(id);
        reject(new Error(`MCP request ${method} timed out. stderr: ${handle.stderr.slice(-800)}`));
      }
    }, 120_000);
  });
  handle.callTool = (name, args) => handle.request("tools/call", { name, arguments: args });
  handle.stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const exited = setTimeout(resolve, 5000);
      child.once("exit", () => { clearTimeout(exited); resolve(); });
    });
    await import("node:fs/promises").then((fs) => fs.rm(homeDir, { recursive: true, force: true }).catch(() => {}));
  };
  await handle.request("initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name: "claude-ai", version: "1.0.0" },
  });
  return handle;
}

// Open the viewer on the card, then wait for the authorization dialog and
// return what it shows. `click` is the button label to press, or null to
// leave the dialog up (timeout round).
function viewerDialogSource({ phase, assetId }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    const modal = () => document.querySelector('.authorization-modal');
    const lines = () => Array.from(modal()?.querySelectorAll('p') || []).map((node) => node.textContent.trim());
    const result = {};
    await waitFor(() => document.querySelector('.app'), 'app shell');

    if ('${phase}' !== 'queue') {
      // Open the viewer on the requested card with a real double click.
      let card = null;
      try {
        card = await waitFor(() => document.querySelector('.asset-card[data-asset-id="${assetId}"]'), 'the card');
      } catch (error) {
        const cards = Array.from(document.querySelectorAll('.asset-card')).map((node) => node.dataset.assetId);
        throw new Error(error.message + ' | cards=' + JSON.stringify(cards)
          + ' | gallery=' + JSON.stringify((document.querySelector('.gallery') || document.body).textContent.slice(0, 200)));
      }
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await waitFor(() => document.querySelector('.viewer-title'), 'viewer opened');
      result.viewerName = document.querySelector('.viewer-title strong')?.textContent || '';
    }

    await waitFor(() => modal(), 'authorization dialog', 30000);
    result.title = modal().querySelector('h3')?.textContent.trim() || '';
    result.consequence = lines()[0] || '';
    result.source = lines()[1] || '';
    result.countdownShown = lines().some((line) => /秒内不回应将视为不允许/.test(line));
    result.focusedIsDeny = document.activeElement?.textContent.trim() === '不允许';

    if ('${phase}' === 'approve') {
      const allow = Array.from(modal().querySelectorAll('button')).find((b) => b.textContent.trim() === '允许删除');
      if (!allow) throw new Error('允许删除 button missing');
      allow.click();
      await waitFor(() => !modal(), 'dialog closes after 允许删除');
      await waitFor(() => {
        const name = document.querySelector('.viewer-title strong')?.textContent || '';
        return Boolean(name) && name !== result.viewerName;
      }, 'viewer stepped to the next card');
      result.viewerNameAfter = document.querySelector('.viewer-title strong')?.textContent || '';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await waitFor(() => !document.querySelector('.viewer-title'), 'viewer closed');
      return result;
    }
    if ('${phase}' === 'deny' || '${phase}' === 'esc') {
      if ('${phase}' === 'deny') {
        const deny = Array.from(modal().querySelectorAll('button')).find((b) => b.textContent.trim() === '不允许');
        deny.click();
      } else {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
      await waitFor(() => !modal(), 'dialog closes');
      result.viewerNameAfter = document.querySelector('.viewer-title strong')?.textContent || '';
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await waitFor(() => !document.querySelector('.viewer-title'), 'viewer closed');
      return result;
    }
    // phase === 'timeout': nobody answers; the countdown closes the dialog and
    // the toast appears. Record the decision traffic so a missing toast is
    // attributable: client POST vs server-side flip.
    window.__decisionCalls = [];
    window.__pageErrors = [];
    window.addEventListener('error', (event) => window.__pageErrors.push(String(event.message)));
    window.addEventListener('unhandledrejection', (event) => window.__pageErrors.push('rejection: ' + String(event.reason && event.reason.message || event.reason)));
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/live-deletion-requests')) {
        window.__decisionCalls.push({ url: String(url), method: (init && init.method) || 'GET', at: Date.now() });
      }
      return window.__origFetch(input, init);
    };
    const toastSeen = [];
    const observer = new MutationObserver(() => {
      const node = document.querySelector('.toast');
      if (node) toastSeen.push({ at: Date.now(), text: node.textContent.trim() });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await waitFor(() => !modal(), 'dialog closes itself on timeout', 60000);
    // The toast may lag the close by a beat (server flip -> SSE -> refetch);
    // poll briefly and report what the queue showed if it never comes.
    result.toast = '';
    for (let waited = 0; waited < 3000; waited += 100) {
      result.toast = document.querySelector('.toast')?.textContent.trim() || '';
      if (result.toast) break;
      await sleep(100);
    }
    observer.disconnect();
    if (!result.toast) {
      let queueState = null;
      try {
        const token = sessionStorage.getItem('mosa.client-token') || '';
        const response = await window.__origFetch('/api/live-deletion-requests', { headers: { 'x-mosa-client-token': token } });
        queueState = JSON.stringify(await response.json());
      } catch (error) { queueState = 'ERR ' + error.message; }
      throw new Error('timeout toast never appeared | toastsSeen=' + JSON.stringify(toastSeen)
        + ' | errors=' + JSON.stringify(window.__pageErrors)
        + ' | calls=' + JSON.stringify(window.__decisionCalls) + ' | queue=' + queueState);
    }
    result.viewerNameAfter = document.querySelector('.viewer-title strong')?.textContent || '';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => !document.querySelector('.viewer-title'), 'viewer closed');
    return result;
  })()`;
}

// Round 4: the viewer opens on the card, then both requests are pending — the
// pairing dialog must show first; 允许连接 hands over to the deletion dialog.
function queueOrderSource({ assetId }) {
  return `(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(check, label, timeoutMs = 30000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const value = check();
        if (value) return value;
        await sleep(100);
      }
      throw new Error('Timed out waiting for ' + label);
    }
    await waitFor(() => document.querySelector('.app'), 'app shell');
    const card = await waitFor(() => document.querySelector('.asset-card[data-asset-id="${assetId}"]'), 'the card');
    card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await waitFor(() => document.querySelector('.viewer-title'), 'viewer opened');
    await waitFor(() => document.querySelector('.authorization-modal'), 'authorization dialog');
    const modal = document.querySelector('.authorization-modal');
    const pairingTitle = modal.querySelector('h3')?.textContent.trim() || '';
    // One dialog at a time: the pairing head must be the ONLY modal up — a
    // second (deletion) modal would mean the two queues render unmerged.
    const modalCount = document.querySelectorAll('.authorization-modal').length;
    if (modalCount !== 1) throw new Error('the pairing dialog must render alone, got ' + modalCount);
    if (pairingTitle !== '允许这个浏览器扩展连接 GravityPort 吗？') {
      throw new Error('the pairing dialog must show first, got: ' + pairingTitle);
    }
    const allow = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent.trim() === '允许连接');
    if (!allow) throw new Error('允许连接 button missing');
    allow.click();
    // The queue hands over seamlessly (both rows are already loaded), so the
    // modal element never disappears — wait for the deletion title instead.
    await waitFor(() => document.querySelector('.authorization-modal h3')?.textContent.trim() === '允许 Claude 删除这张素材吗？', 'deletion dialog follows');
    const deleteTitle = document.querySelector('.authorization-modal h3')?.textContent.trim() || '';
    if (deleteTitle !== '允许 Claude 删除这张素材吗？') {
      throw new Error('the deletion dialog must follow the pairing one, got: ' + deleteTitle);
    }
    // Deny it in this same page: a follow-up driver page launches fresh and
    // could miss the deletion dialog's 30 s window.
    const deny = Array.from(document.querySelector('.authorization-modal').querySelectorAll('button'))
      .find((b) => b.textContent.trim() === '不允许');
    if (!deny) throw new Error('不允许 button missing');
    deny.click();
    await waitFor(() => !document.querySelector('.authorization-modal'), 'deletion dialog closes');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await waitFor(() => !document.querySelector('.viewer-title'), 'viewer closed');
    return { pairingTitle, deleteTitle, denied: true };
  })()`;
}

// The page opens the viewer and then waits for the dialog; the MCP call may
// only fire once the viewer's presence report has actually landed (the MCP
// server checks viewer.json at call time — an early call would trash directly
// without asking). Each runInPage is a fresh page, so every round is one
// self-contained page source plus this Node-side handshake.
// Waits until the presence record names `assetId`. A bare existence check is
// not enough: the record a previous round (or the stopped flow service) left
// behind still exists, so the MCP call could race the new viewer's report and
// find nobody viewing the asset — it then trashes without asking (PR #343,
// Windows e2e 1/2, round 5 light screenshot).
async function waitForViewerFile(libraryDir, { assetId, timeoutMs = 10_000 } = {}) {
  const { readFile } = await import("node:fs/promises");
  const path = join(libraryDir, ".live", "viewer.json");
  const deadline = Date.now() + timeoutMs;
  let last = "(missing)";
  while (Date.now() < deadline) {
    try {
      const record = JSON.parse(await readFile(path, "utf8"));
      last = JSON.stringify({ assetId: record?.assetId, pid: record?.pid });
      if (!assetId || record?.assetId === assetId) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the viewer presence file never named ${assetId || "any asset"}: ${path} last=${last}`);
}

// ---- Round 5 helpers: desktop-shell screenshots (the schema-upgrade-notice
// pattern, task 350 — a hidden background Electron window via CDP). ----------

// Ask the OS for a port that is free right now. Random picks in the 4xxxx
// range collided with the ephemeral ports the runner hands to other servers
// (Windows starts that range at 49152), so the app could not bind and the
// CDP target never appeared.
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectCdp(cdpPort, expectedUrlPrefix, timeoutMs = 30000) {
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
      } else resolveFn(message.result);
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
      const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
      return result?.result?.value;
    },
    close() {
      try { socket.close(); } catch {}
    },
  };
}

async function waitForExpression(cdp, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
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
  throw new Error(`Timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

/**
 * One screenshot: a hidden desktop shell on the flow's library, the viewer
 * opened on the card via a real double click, the MCP ask filed through the
 * same real MCP process, then a 1280-wide CDP capture of the dialog.
 */
async function captureDialogShot({ ctx, theme, cardId, mcp, serverEnv }) {
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  // Next to the run's own temp library — the runner wipes that root, so no
  // shell residue ever lands in the repository.
  const userDataDir = join(ctx.libraryDir, "..", `385-shots-${theme}-user-data`);
  mkdirSync(userDataDir, { recursive: true });
  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(userDataDir, "pid.txt");
  const logFile = join(userDataDir, "main.log");
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: userDataDir,
    executable,
    args: [...qaFlags, "desktop/main.mjs", `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${cdpPort}`],
    env: {
      ...serverEnv,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_LIBRARY_DIR: ctx.libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_PROJECT_DIR: ctx.rootDir,
      MOSA_DESKTOP_PORT: String(port),
    },
    cwd: ctx.rootDir,
    pidFile,
    logFile,
    healthUrl: `http://127.0.0.1:${port}/api/health`,
    healthFile: join(userDataDir, "health.json"),
  });
  let cdp = null;
  try {
    cdp = await connectCdp(cdpPort, "http://127.0.0.1").catch(async (error) => {
      // Keep the shell's own log next to the screenshots: a failed CDP attach
      // without it is undiagnosable after the runner wipes the temp root.
      const { copyFile } = await import("node:fs/promises");
      await mkdir(SHOT_DIR, { recursive: true });
      await copyFile(logFile, join(SHOT_DIR, `385-desktop-${theme}-main.log`)).catch(() => {});
      throw error;
    });
    await waitForExpression(cdp, "Boolean(document.querySelector('.app'))", "app shell", 60000);
    // The preference must exist before the App mounts; a reload lands the theme.
    await cdp.evaluate(`localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance: ${JSON.stringify(theme === "dark" ? "深色" : "浅色")} }))`);
    cdp.evaluate("location.reload()").catch(() => {});
    await waitForExpression(cdp, "Boolean(document.querySelector('.app'))", "app shell after reload", 60000);
    await waitForExpression(
      cdp,
      `Boolean(document.querySelector('.asset-card[data-asset-id="${cardId}"]'))`,
      "the card",
      30000,
    );
    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const card = document.querySelector('.asset-card[data-asset-id="${cardId}"]');
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      for (let waited = 0; waited < 10000 && !document.querySelector('.viewer-title'); waited += 100) await sleep(100);
      return Boolean(document.querySelector('.viewer-title'));
    })()`);
    await waitForViewerFile(ctx.libraryDir, { assetId: cardId });
    const call = mcp.callTool("asset_trash", { assetId: cardId });
    await waitForExpression(cdp, "Boolean(document.querySelector('.authorization-modal'))", "authorization dialog", 30000);
    await waitForExpression(
      cdp,
      "document.querySelector('.authorization-modal h3')?.textContent === '允许 Claude 删除这张素材吗？'",
      "the deletion dialog title",
      10000,
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${theme}`);
    await mkdir(SHOT_DIR, { recursive: true });
    const fileName = theme === "dark" ? "385-授权确认框-深色.png" : "385-授权确认框-浅色.png";
    const data = Buffer.from(shot.data, "base64");
    await writeFile(join(SHOT_DIR, fileName), data);
    const copyTo = process.env.MOSA_E2E_SHOT_COPY_TO;
    if (copyTo) await writeFile(join(copyTo, fileName), data).catch(() => {});
    // Answer 不允许 so the MCP call resolves and the library stays untouched.
    await cdp.evaluate(`(() => {
      const deny = Array.from(document.querySelector('.authorization-modal').querySelectorAll('button'))
        .find((b) => b.textContent.trim() === '不允许');
      deny.click();
      return true;
    })()`);
    const answered = await call;
    if (answered.result?.isError !== true) throw new Error(`the screenshot round's deny did not answer: ${JSON.stringify(answered.result || answered.error).slice(0, 200)}`);
    return { file: join(SHOT_DIR, fileName), bytes: data.length };
  } finally {
    if (cdp) cdp.close();
    let pid = 0;
    try { pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10) || 0; } catch { pid = 0; }
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGTERM"); } catch {}
      for (let wait = 0; wait < 6; wait += 1) {
        await sleep(500);
        let alive = true;
        try { process.kill(pid, 0); } catch { alive = false; }
        if (!alive) break;
      }
      try { process.kill(pid, 0); process.kill(pid, "SIGKILL"); } catch {}
    }
    if (launched.waiter && launched.waiter.exitCode === null) {
      try { launched.waiter.kill("SIGTERM"); } catch {}
    }
  }
}

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer({
    env: {
      MOSA_WEB_CAPTURE_TOKEN: CAPTURE_TOKEN,
      MOSA_WEB_CAPTURE_ORIGINS: `${DEVELOPMENT_ORIGIN}`,
      MOSA_WEB_CAPTURE_PAIR: "auto",
    },
  });
  let mcp = null;
  try {
    const created = [];
    for (let i = 1; i <= 4; i += 1) {
      const asset = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`viewer-delete-${String(i).padStart(2, "0")}.png`, [74, 127, 181]),
        prompt: `viewer delete confirm ${i}`,
      });
      created.push(asset.asset);
    }
    // Newest-first gallery: round 1 watches created[0], stepping lands on created[1].
    mcp = await startMcpProcess(ctx.libraryDir, ctx.rootDir);

    // ── Round 1: allow — the asset trashes and the viewer steps. ──
    const x = created[0].id;
    const page1 = ctx.runInPage(server, viewerDialogSource({ phase: "approve", assetId: x }));
    await waitForViewerFile(ctx.libraryDir, { assetId: x });
    const call1 = mcp.callTool("asset_trash", { assetId: x });
    const approval = await page1;
    const problems = [];
    if (approval.title !== "允许 Claude 删除这张素材吗？") problems.push(`title ${JSON.stringify(approval.title)}`);
    if (approval.consequence !== "允许后，这张素材会被移进回收站。") problems.push(`consequence ${JSON.stringify(approval.consequence)}`);
    if (approval.source !== "来自：Claude（MCP）") problems.push(`source ${JSON.stringify(approval.source)}`);
    if (approval.countdownShown !== true) problems.push("no countdown line");
    if (approval.focusedIsDeny !== true) problems.push("initial focus is not 不允许");
    if (!approval.viewerNameAfter || approval.viewerNameAfter === approval.viewerName) problems.push("viewer did not step");
    if (problems.length) throw new Error(`approval round: ${problems.join("; ")}`);
    const answered1 = await call1;
    if (answered1.error || answered1.result?.isError) throw new Error(`asset_trash failed after allow: ${JSON.stringify(answered1).slice(0, 300)}`);
    if (!String(answered1.result?.content?.[0]?.text || "").includes("已移到回收站")) {
      throw new Error(`allow did not trash: ${JSON.stringify(answered1.result).slice(0, 300)}`);
    }

    // ── Round 2a: deny by button — the asset stays. ──
    const y = created[1].id;
    const page2a = ctx.runInPage(server, viewerDialogSource({ phase: "deny", assetId: y }));
    await waitForViewerFile(ctx.libraryDir, { assetId: y });
    const call2a = mcp.callTool("asset_trash", { assetId: y });
    const denial = await page2a;
    if (denial.title !== "允许 Claude 删除这张素材吗？") throw new Error(`deny round title: ${denial.title}`);
    if (denial.viewerNameAfter !== denial.viewerName) throw new Error("the denied asset must stay in the viewer");
    const answered2a = await call2a;
    if (answered2a.result?.isError !== true || answered2a.result?.structuredContent?.reason !== "user_denied") {
      throw new Error(`deny round MCP answer: ${JSON.stringify(answered2a.result || answered2a.error).slice(0, 300)}`);
    }

    // ── Round 2b: deny by Escape. ──
    const w = created[2].id;
    const page2b = ctx.runInPage(server, viewerDialogSource({ phase: "esc", assetId: w }));
    await waitForViewerFile(ctx.libraryDir, { assetId: w });
    const call2b = mcp.callTool("asset_trash", { assetId: w });
    const escape = await page2b;
    if (escape.viewerNameAfter !== escape.viewerName) throw new Error("the Esc-denied asset must stay in the viewer");
    const answered2b = await call2b;
    if (answered2b.result?.isError !== true || answered2b.result?.structuredContent?.reason !== "user_denied") {
      throw new Error(`esc round MCP answer: ${JSON.stringify(answered2b.result || answered2b.error).slice(0, 300)}`);
    }

    // ── Round 3: timeout — dialog closes itself, toast appears. ──
    const z = created[3].id;
    const page3 = ctx.runInPage(server, viewerDialogSource({ phase: "timeout", assetId: z }));
    await waitForViewerFile(ctx.libraryDir, { assetId: z });
    const call3 = mcp.callTool("asset_trash", { assetId: z });
    const timeout = await page3;
    if (timeout.toast !== "已拒绝 Claude 的删除请求（超时）") {
      throw new Error(`timeout toast: ${JSON.stringify(timeout.toast)}`);
    }
    if (timeout.viewerNameAfter !== timeout.viewerName) throw new Error("the timed-out asset must stay in the viewer");
    const answered3 = await call3;
    if (answered3.result?.isError !== true || answered3.result?.structuredContent?.reason !== "user_no_response") {
      throw new Error(`timeout round MCP answer: ${JSON.stringify(answered3.result || answered3.error).slice(0, 300)}`);
    }

    // ── Round 4: one pairing request and one deletion request at once — the
    // pairing dialog shows first, the deletion one after it is decided. ──
    const v = z; // still live: round 3 kept it
    const page4 = ctx.runInPage(server, queueOrderSource({ assetId: v }));
    await waitForViewerFile(ctx.libraryDir, { assetId: v });
    const pairAsk = await fetch(`${server.origin}/api/web-capture/pair`, {
      method: "POST",
      headers: { origin: DEVELOPMENT_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ extensionVersion: "0.15.45" }),
    });
    if (pairAsk.status !== 202) throw new Error(`POST /pair expected 202, got ${pairAsk.status}`);
    const call4 = mcp.callTool("asset_trash", { assetId: v });
    // queueOrderSource denies the deletion dialog in its own page (a follow-up
    // driver page could miss the 30 s window) and returns only then.
    const queue = await page4;
    const answered4 = await call4;
    if (answered4.result?.isError !== true || answered4.result?.structuredContent?.reason !== "user_denied") {
      throw new Error(`queue round MCP answer: ${JSON.stringify(answered4.result || answered4.error).slice(0, 300)}`);
    }

    // ── Round 5: light/dark dialog screenshots (1280 wide) via the hidden
    // desktop shell. The flow's service holds the library lock, so it stops
    // first; the desktop shell starts its own runtime on the same library and
    // the still-running MCP process asks through the shared .live/ files. ──
    await server.stop();
    const shots = {};
    for (const [theme, cardId] of [["light", created[1].id], ["dark", created[2].id]]) {
      shots[theme] = await captureDialogShot({
        ctx, theme, cardId, mcp,
        serverEnv: { ...process.env, MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok" },
      });
    }

    return {
      approval: { title: approval.title, source: approval.source, steppedTo: approval.viewerNameAfter },
      denial: { keptInViewer: denial.viewerNameAfter === denial.viewerName },
      escape: { keptInViewer: escape.viewerNameAfter === escape.viewerName },
      timeout: { toast: timeout.toast },
      queue: { pairingTitle: queue.pairingTitle, deleteTitle: queue.deleteTitle },
      screenshots: shots,
    };
  } finally {
    if (mcp) await mcp.stop();
    await server.stop();
  }
}
