// schema-upgrade-notice.mjs — task 350: the post-upgrade check failure
// dialog. The failed verify verdict keeps the pre-upgrade snapshot, files it
// on the kept list and must show ONE explanation dialog:
// - seeded failed record -> the dialog appears after the first screen with
//   the agreed copy, the reveal button hits /api/open-folder with a path
//   inside .schema-backups (intercepted in-page, no real Finder), clicking
//   the backdrop does nothing, 好 latches the dismissal (GET says no
//   after a service restart);
// - a check that FAILS WHILE THE APP IS OPEN (test-only verify delay) opens
//   the dialog without a restart, via the library-backfilled announcement;
// - two desktop-shell screenshots (zh/en) of the dialog land in the
//   350-dialog-*.png files the task names (kept with MOSA_E2E_SHOT_COPY_TO).
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { createSqliteAssetStore } from "../../lib/sqlite-asset-store.mjs";

export const name = "schema-upgrade-notice";
export const description =
  "task 350 dialog: seeded failed verdict shows the dialog after the first screen (copy, reveal -> /api/open-folder intercepted, backdrop keeps it, 好 latches across restart) -> a live failed check opens it without a restart -> zh/en desktop screenshots";

// Screenshots live in the run's temp root (wiped when the runner exits); a
// report consumer names a surviving copy directory with MOSA_E2E_SHOT_COPY_TO,
// the same convention as sidebar-update-line.
const shotDirFor = (ctx) => join(ctx.libraryDir, "..", "350-shots");
async function keepShotCopy(fileName, data) {
  const copyTo = process.env.MOSA_E2E_SHOT_COPY_TO;
  if (copyTo) await writeFile(join(copyTo, fileName), data).catch(() => {});
}
const VERIFY_KEY = "schema_upgrade_verify";

function verifyRecordValue(libraryDir) {
  const database = new Database(join(libraryDir, "mosa.db"), { readonly: true });
  try {
    return JSON.parse(database.prepare("SELECT value FROM library_meta WHERE key = ?").get(VERIFY_KEY)?.value || "null");
  } finally {
    database.close();
  }
}

function seedFailedRecord(libraryDir) {
  mkdirSync(join(libraryDir, ".schema-backups"), { recursive: true });
  const snapshot = join(libraryDir, ".schema-backups", "mosa-before-v17-from-v16.db");
  const snapshotDatabase = new Database(snapshot);
  snapshotDatabase.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(VERIFY_KEY, JSON.stringify({
      targetVersion: 17,
      status: "failed",
      integrity: "ok",
      foreignKeyViolations: 1,
      foreignKeyBaselineViolations: 0,
      trigger: "upgrade",
      backupPath: snapshot,
      checkedAt: "2026-11-03T00:00:00.000Z",
    }), "2026-11-03T00:00:00.000Z");
  } finally {
    database.close();
  }
  return snapshot;
}

/** One orphan stack member (real asset row, ghost stack) so a live check
 * against a clean baseline copy fails for real. */
async function seedLiveFailure(libraryDir, projectRoot, makePng) {
  mkdirSync(projectRoot, { recursive: true });
  // The fixture must live inside this project root's generated-images: the
  // store only reads ingest sources from its trusted roots.
  const generatedDir = join(projectRoot, "generated-images");
  mkdirSync(generatedDir, { recursive: true });
  const fixture = await makePng("live-check-source.png", [74, 127, 181]);
  const imagePath = join(generatedDir, "live-check.png");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(fixture, imagePath);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  await store.createAsset({ assetId: "live-check-a", imagePath, source: { type: "local-file", path: imagePath } });
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    database.pragma("foreign_keys = OFF");
    database.prepare(`
      INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
      VALUES ('default', 'ghost-stack', 'live-check-a', 0, '2026-11-03T00:00:00.000Z')
    `).run();
    database.pragma("foreign_keys = ON");
    mkdirSync(join(libraryDir, ".schema-backups"), { recursive: true });
    const snapshot = join(libraryDir, ".schema-backups", "mosa-before-v17-from-v16.db");
    const snapshotDatabase = new Database(snapshot);
    snapshotDatabase.close();
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(VERIFY_KEY, JSON.stringify({
      targetVersion: 17,
      status: "pending",
      integrity: null,
      foreignKeyViolations: 0,
      foreignKeyBaselineViolations: 0,
      trigger: "upgrade",
      backupPath: snapshot,
      checkedAt: "2026-11-03T00:00:00.000Z",
    }), "2026-11-03T00:00:00.000Z");
  } finally {
    database.close();
  }
}

export async function run(ctx) {
  await ctx.prepare();
  await mkdir(shotDirFor(ctx), { recursive: true });

  // ---- Round 1: seeded failed record — dialog, reveal intercept, latch ----
  const server1 = await ctx.startServer();
  await server1.stop(); // bootstrap the library, then seed the failed verdict
  const snapshot = seedFailedRecord(ctx.libraryDir);
  if (!existsSync(snapshot)) throw new Error("the seeded snapshot file is missing");

  const server = await ctx.startServer();
  try {
    const result = await ctx.runInPage(server, pageSource());
    if (result?.__pageError) throw new Error(`schema-upgrade-notice page error: ${result.__pageError}`);
    if (result.shown !== true) throw new Error(`the dialog did not appear: ${JSON.stringify(result)}`);
    if (!result.title.includes("素材库升级检查未通过")) throw new Error(`wrong dialog title: ${result.title}`);
    if (!result.body.includes("备份已保留，请勿删除") || !result.body.includes("「设置 > 反馈」")) {
      throw new Error(`wrong dialog body: ${result.body}`);
    }
    if (result.revealCalled !== true) throw new Error("the reveal-copy button did not call /api/open-folder");
    if (!String(result.revealPath || "").includes(".schema-backups")) {
      throw new Error(`the reveal path is not inside .schema-backups: ${result.revealPath}`);
    }
    if (result.reveal !== true) throw new Error("the reveal call did not pass reveal: true");
    if (result.backdropStillOpen !== true) throw new Error("clicking the backdrop closed the dialog");
    if (result.ackClosed !== true) throw new Error("好 did not close the dialog");

    // The acknowledgement latched on the record (same live server).
    const noticeAfter = await ctx.api(server.origin, "GET", "/api/schema-upgrade-notice");
    if (noticeAfter.shouldShow !== false) throw new Error(`the acknowledgement did not latch: ${JSON.stringify(noticeAfter)}`);
  } finally {
    await server.stop();
  }

  // A restart does not show it again.
  const serverRestart = await ctx.startServer();
  try {
    const result = await ctx.runInPage(serverRestart, pageSource({ expectDialog: false }));
    if (result?.__pageError) throw new Error(`restart page error: ${result.__pageError}`);
    if (result.shownAgain === true) throw new Error("the dialog re-showed after the acknowledgement");
  } finally {
    await serverRestart.stop();
  }

  // ---- Round 2: the check fails while the App is open (no restart) ----
  const liveLibrary = join(ctx.libraryDir, "..", "live-library");
  const liveProjectRoot = `${liveLibrary}-project`;
  await mkdir(liveLibrary, { recursive: true });
  await mkdir(liveProjectRoot, { recursive: true });
  const bootstrapServer = await ctx.startServer({ libraryDir: liveLibrary });
  await bootstrapServer.stop();
  await seedLiveFailure(liveLibrary, liveProjectRoot, (name, color) => ctx.makePng(name, color));

  const liveServer = await ctx.startServer({
    libraryDir: liveLibrary,
    env: { MOSA_TEST_SCHEMA_VERIFY_DELAY_MS: "6000" },
  });
  try {
    const result = await ctx.runInPage(liveServer, pageSource({ liveWait: true }));
    if (result?.__pageError) throw new Error(`live page error: ${result.__pageError}`);
    if (result.shown !== true) throw new Error(`the live-failure dialog did not appear without a restart: ${JSON.stringify(result)}`);
    if (result.escClosed !== true) throw new Error("Esc did not close the live dialog");
  } finally {
    await liveServer.stop();
  }
  rmSync(liveLibrary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  rmSync(liveProjectRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });

  // ---- Round 3: zh/en desktop screenshots of the dialog ----
  const executable = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const shots = {};
  for (const language of ["zh", "en"]) {
    const libraryDir = join(ctx.libraryDir, "..", `shots-${language}-library`);
    const userDataDir = join(ctx.userDataDir, "..", `shots-${language}-user-data`);
    await mkdir(libraryDir, { recursive: true });
    await mkdir(userDataDir, { recursive: true });
    const bootServer = await ctx.startServer({ libraryDir });
    await bootServer.stop();
    seedFailedRecord(libraryDir);
    shots[language] = await captureDesktopDialog({
      ctx, executable, libraryDir, userDataDir, language,
      fileName: `350-dialog-${language}.png`,
    });
    rmSync(libraryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  }

  return {
    dialogShown: true,
    revealIntercepted: true,
    latched: true,
    liveFailureWithoutRestart: true,
    screenshots: shots,
  };
}

// ---- Round helpers ----------------------------------------------------------

function pageSource({ expectDialog = true, liveWait = false } = {}) {
  return `(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check, label, timeoutMs = ${liveWait ? 30000 : 15000}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await check();
      if (last) return last;
      await sleep(120);
    }
    throw new Error('Timed out waiting for ' + label);
  }
  const dialog = () => Array.from(document.querySelectorAll('.delete-modal'))
    .find((node) => node.querySelector('#schema-upgrade-notice-title')) || null;
  const dialogText = () => dialog() ? dialog().textContent.replace(/\\s+/g, ' ').trim() : null;
  const result = { shown: false, shownAgain: false, title: '', body: '', revealCalled: false, revealPath: '', reveal: false, backdropStillOpen: false, ackClosed: false, escClosed: false };
  try {
    await waitFor(() => document.querySelector('.app'), 'app shell');
    await waitFor(() => document.querySelector('.asset-card, .empty-state, .gallery, main'), 'first screen');
    ${liveWait ? `
    // Live-failure round: the record starts pending, so nothing may show
    // while the check is still running (6s delay + maintenance start).
    await sleep(2500);
    if (dialog()) throw new Error('the dialog showed while the check was still pending');
    await waitFor(() => dialog(), 'schema-upgrade notice dialog', 30000);
    result.shown = true;
    result.title = (dialog().querySelector('h3') || {}).textContent || '';
    result.body = (dialog().querySelector('p') || {}).textContent || '';
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await sleep(400);
    result.escClosed = !dialog();
    ` : expectDialog ? `
    await waitFor(() => dialog(), 'schema-upgrade notice dialog', 15000);
    result.shown = true;
    result.title = (dialog().querySelector('h3') || {}).textContent || '';
    result.body = (dialog().querySelector('p') || {}).textContent || '';
    // Intercept /api/open-folder: record the call, answer ok, never spawn Finder.
    if (!window.__origFetch) window.__origFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/api/open-folder')) {
        result.revealCalled = true;
        try {
          const parsed = JSON.parse((init && init.body) || '{}');
          result.revealPath = parsed.path || '';
          result.reveal = parsed.reveal === true;
        } catch {}
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return window.__origFetch(input, init);
    };
    const revealButton = Array.from(dialog().querySelectorAll('button'))
      // macOS says 访达 (Finder), Windows says 资源管理器 (File Explorer).
      .find((node) => ['在访达中显示备份', '在文件资源管理器中显示备份'].some((label) => node.textContent.includes(label)));
    if (!revealButton) throw new Error('reveal button missing: ' + dialog().textContent.slice(0, 200));
    revealButton.click();
    await sleep(600);
    if (!dialog()) throw new Error('the reveal click closed the dialog');
    // Clicking the backdrop must keep the dialog open.
    const layer = dialog().closest('.modal-layer');
    layer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(300);
    result.backdropStillOpen = Boolean(dialog());
    // 好 closes it and latches the acknowledgement.
    const ackButton = Array.from(dialog().querySelectorAll('button'))
      .find((node) => node.textContent.trim() === '好');
    if (!ackButton) throw new Error('好 button missing');
    ackButton.click();
    await sleep(400);
    result.ackClosed = !dialog();
    ` : `
    // Restart round: the acknowledgement must hold — no dialog may appear.
    await sleep(2500);
    result.shownAgain = Boolean(dialog());
    `};
    return result;
  } catch (error) {
    return { __pageError: String((error && error.message) || error), ...result };
  }
})()`;
}

async function captureDesktopDialog({ ctx, executable, libraryDir, userDataDir, language, fileName }) {
  const port = await freePort();
  const cdpPort = await freePort();
  const pidFile = join(userDataDir, "pid.txt");
  const logFile = join(userDataDir, "main.log");
  const healthFile = join(userDataDir, "health.json");
  const qaFlags = process.platform === "win32" ? ["--disable-gpu"] : [];
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir: userDataDir,
    executable,
    args: [
      ...qaFlags,
      "desktop/main.mjs",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
    ],
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_CLIENT_TOKEN: ctx.token,
      MOSA_LIBRARY_DIR: libraryDir,
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
  let failed = false;
  try {
    // Readiness gate = the CDP page target itself: the desktop renderer only
    // reaches the app shell once its runtime is serving, whatever port the
    // service ended up on. The launcher's own health-file mirror proved
    // unreliable under the e2e runner, so nothing depends on it here.
    cdp = await connectCdp(cdpPort, "http://127.0.0.1");
    await waitForExpression(cdp, "Boolean(document.querySelector('.app'))", "app shell", 60000);
    if (language === "en") {
      // The language preference must be in place before the App mounts; the
      // dialog opens after the first screen, so a reload lands it in English.
      await cdp.evaluate(`localStorage.setItem("gravityport.preferences", JSON.stringify({ language: "en" }))`);
      cdp.evaluate("location.reload()").catch(() => {});
      await waitForExpression(cdp, "Boolean(document.querySelector('.app'))", "app shell after reload");
    }
    const titleWait = language === "en" ? "Library upgrade check failed" : "素材库升级检查未通过";
    await waitForExpression(
      cdp,
      `Boolean(Array.from(document.querySelectorAll('.delete-modal h3')).find((node) => node.textContent === ${JSON.stringify(titleWait)}))`,
      `dialog title (${language})`,
      30000,
    );
    await waitForExpression(cdp, "document.querySelector('.app') && document.readyState === 'complete'", "window settled");
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${language}`);
    const filePath = join(shotDirFor(ctx), fileName);
    const data = Buffer.from(shot.data, "base64");
    await writeFile(filePath, data);
    await keepShotCopy(fileName, data);
    return filePath;
  } catch (error) {
    failed = true;
    // Keep the scene for diagnosis: copy the desktop main log next to the
    // screenshots instead of losing it with the run root.
    try {
      const { copyFile } = await import("node:fs/promises");
      const logName = `350-desktop-${language}-main.log`;
      await copyFile(logFile, join(shotDirFor(ctx), logName));
      if (process.env.MOSA_E2E_SHOT_COPY_TO) await copyFile(logFile, join(process.env.MOSA_E2E_SHOT_COPY_TO, logName));
    } catch { /* best effort */ }
    throw error;
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

async function waitForExpression(cdp, expression, label, timeoutMs = 20000) {
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
