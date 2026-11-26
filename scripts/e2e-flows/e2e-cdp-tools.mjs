// GravityPort e2e self-test for scripts/e2e-flows/_cdp.mjs (task 469):
// launches a minimal hidden Electron window (MOSA_QA_RUN=1, no Dock, no focus,
// no App server), loads about:blank, injects synthetic DOM fixtures, and
// exercises every contract of _cdp.mjs:
// - clickCenter on a normal button
// - covered target -> reason=covered with hit=div.cover
// - display:none -> reason=zero-size; visibility:hidden -> reason=hidden
// - off-screen target in a tall page -> auto-scrolls into view and clicks
// - moving target (600ms CSS transition) -> waits until settled; 300ms timeout
//   throws reason=moving
// - waitFor timeout -> includes scene= with dialog[open] and .toast text
// - clickAndWait without retryOnce (does not retry) vs with retryOnce (logs
//   [e2e-retry] and succeeds on second click)
// - dispatchMouse without reason -> throws
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";
import { signalProcessTree } from "../process-tree.mjs";
import {
  clickAndWait,
  clickCenter,
  connectCdp,
  dispatchMouse,
  doubleClick,
  hover,
  waitFor,
} from "./_cdp.mjs";

export const name = "e2e-cdp-tools";
export const description = "self-test _cdp.mjs against a minimal hidden Electron about:blank window: normal click, covered/zero-size/hidden rejection, off-screen scroll-and-click, moving-target stability wait & timeout, waitFor scene dump, clickAndWait retryOnce, dispatchMouse reason guard";

const QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];

const MINIMAL_WINDOW_SCRIPT = `
import { app, BrowserWindow } from "electron";
import { resolve } from "node:path";

const positional = process.argv.slice(1).filter((arg) => !arg.startsWith("-")).slice(1);
const [targetUrl, userDataDir] = positional;
if (!targetUrl || !userDataDir) {
  console.error("usage: electron cdp-tools-window.mjs <url> <userDataDir>");
  process.exit(2);
}
if (process.platform === "darwin") app.dock?.hide();
app.setPath("userData", resolve(userDataDir));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  win.on("closed", () => app.quit());
  await win.loadURL(targetUrl);
  console.log("CDP_TOOLS_WINDOW_READY");
}).catch((error) => {
  console.error(error?.stack || error);
  app.exit(1);
});
`;

function assert(condition, message) {
  if (!condition) throw new Error(`e2e-cdp-tools assertion failed: ${message}`);
}

async function assertRejects(fn, pattern, label) {
  let caught = null;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  if (!caught) throw new Error(`e2e-cdp-tools expected failure (${label}), but succeeded`);
  const message = String(caught?.message || caught);
  if (pattern && !pattern.test(message)) {
    throw new Error(`e2e-cdp-tools (${label}) error did not match ${pattern}: ${message}`);
  }
  return message;
}

export async function run(ctx) {
  const workRoot = await mkdtemp(join(tmpdir(), "mosa-e2e-cdp-tools-"));
  const userDataDir = join(workRoot, "user-data");
  const windowScript = join(workRoot, "cdp-tools-window.mjs");
  await mkdir(userDataDir, { recursive: true });
  await writeFile(windowScript, MINIMAL_WINDOW_SCRIPT, "utf8");

  const electronBinary = ensureElectronExecutablePath({ rootDir: ctx.rootDir });
  const cdpPort = await freePort();
  const child = spawn(electronBinary, [
    ...QA_FLAGS,
    `--remote-debugging-port=${cdpPort}`,
    windowScript,
    "about:blank",
    userDataDir,
  ], {
    cwd: ctx.rootDir,
    env: { ...process.env, MOSA_QA_RUN: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

  let cdp = null;
  const results = {};
  try {
    await waitForReadyLine(stdoutChunks, stderrChunks);
    cdp = await connectCdp(cdpPort, "about:blank");

    // 1. Normal button: clickCenter increments count to exactly 1.
    await cdp.evaluate(`(() => {
      document.body.innerHTML = '<button id="btn-normal" style="width:120px;height:40px;">Normal</button>';
      window.__normalClicks = 0;
      document.querySelector('#btn-normal').addEventListener('click', () => { window.__normalClicks += 1; });
    })()`);
    await clickCenter(cdp, `document.querySelector('#btn-normal')`, { label: "normal button" });
    const normalClicks = await cdp.evaluate(`window.__normalClicks`);
    assert(normalClicks === 1, `normal button clicks=${normalClicks}, expected 1`);
    results.normalClick = normalClicks;

    // 2. Covered by div.cover: throws reason=covered with div.cover in hit.
    await cdp.evaluate(`(() => {
      document.body.innerHTML =
        '<div style="position:relative;width:200px;height:60px;">'
        + '<button id="btn-covered" style="position:absolute;inset:0;width:200px;height:60px;">Under</button>'
        + '<div class="cover" style="position:absolute;inset:0;z-index:10;background:rgba(0,0,0,0.5);">Blocker</div>'
        + '</div>';
    })()`);
    const coveredErr = await assertRejects(
      () => clickCenter(cdp, `document.querySelector('#btn-covered')`, { label: "covered button", timeoutMs: 400 }),
      /reason=covered[\s\S]*hit=div\.cover/,
      "covered button",
    );
    results.coveredError = coveredErr;

    // 3a. display:none -> reason=zero-size.
    // 3b. visibility:hidden -> reason=hidden.
    await cdp.evaluate(`(() => {
      document.body.innerHTML =
        '<button id="btn-none" style="display:none;width:100px;height:40px;">None</button>'
        + '<button id="btn-hidden" style="visibility:hidden;width:100px;height:40px;">Hidden</button>';
    })()`);
    const zeroSizeErr = await assertRejects(
      () => clickCenter(cdp, `document.querySelector('#btn-none')`, { label: "display-none button", timeoutMs: 350 }),
      /reason=zero-size/,
      "display:none button",
    );
    const hiddenErr = await assertRejects(
      () => clickCenter(cdp, `document.querySelector('#btn-hidden')`, { label: "visibility-hidden button", timeoutMs: 350 }),
      /reason=hidden/,
      "visibility:hidden button",
    );
    results.zeroSizeError = zeroSizeErr;
    results.hiddenError = hiddenErr;

    // 4. Outside viewport on a tall page: auto-scrolls into view and clicks (count === 1).
    await cdp.evaluate(`(() => {
      document.body.style.margin = '0';
      document.body.innerHTML =
        '<div style="height:2400px;">tall spacer</div>'
        + '<button id="btn-far" style="width:140px;height:44px;">Far Button</button>';
      window.__farClicks = 0;
      document.querySelector('#btn-far').addEventListener('click', () => { window.__farClicks += 1; });
      window.scrollTo(0, 0);
    })()`);
    const farBeforeY = await cdp.evaluate(`document.querySelector('#btn-far').getBoundingClientRect().top`);
    assert(farBeforeY > 1000, `far button should start off-screen, got top=${farBeforeY}`);
    await clickCenter(cdp, `document.querySelector('#btn-far')`, { label: "off-screen button" });
    const farClicks = await cdp.evaluate(`window.__farClicks`);
    assert(farClicks === 1, `off-screen button clicks=${farClicks}, expected 1`);
    results.offscreenClick = farClicks;

    // 5. Moving target (CSS transition 600ms linear):
    // 5a. Waits until transition finishes (does not click during first 600ms), then clicks (count === 1).
    await cdp.evaluate(`(() => {
      window.scrollTo(0, 0);
      document.body.innerHTML =
        '<button id="btn-moving" style="position:fixed;top:80px;left:40px;width:120px;height:44px;transform:translateX(0px);transition:transform 600ms linear;">Move</button>';
      window.__moveClicks = 0;
      window.__moveClickElapsed = null;
      const btn = document.querySelector('#btn-moving');
      btn.addEventListener('click', () => {
        window.__moveClicks += 1;
        window.__moveClickElapsed = performance.now() - window.__moveStart;
      });
      void btn.offsetWidth;
      window.__moveStart = performance.now();
      btn.style.transform = 'translateX(320px)';
    })()`);
    await clickCenter(cdp, `document.querySelector('#btn-moving')`, { label: "moving button", timeoutMs: 3000 });
    const moveResult = await cdp.evaluate(`({ clicks: window.__moveClicks, elapsed: Math.round(window.__moveClickElapsed) })`);
    assert(moveResult.clicks === 1, `moving button clicks=${moveResult.clicks}, expected 1`);
    assert(
      moveResult.elapsed >= 550,
      `moving button was clicked too early (${moveResult.elapsed}ms < 550ms) during 600ms transition`,
    );
    results.movingWait = moveResult;

    // 5b. With timeoutMs=300 during a 600ms transition -> throws reason=moving without clicking.
    await cdp.evaluate(`(() => {
      document.body.innerHTML =
        '<button id="btn-moving-timeout" style="position:fixed;top:80px;left:40px;width:120px;height:44px;transform:translateX(0px);transition:transform 600ms linear;">MoveTimeout</button>';
      window.__moveTimeoutClicks = 0;
      const btn = document.querySelector('#btn-moving-timeout');
      btn.addEventListener('click', () => { window.__moveTimeoutClicks += 1; });
      void btn.offsetWidth;
      btn.style.transform = 'translateX(320px)';
    })()`);
    const movingTimeoutErr = await assertRejects(
      () => clickCenter(cdp, `document.querySelector('#btn-moving-timeout')`, { label: "moving timeout button", timeoutMs: 300 }),
      /reason=moving/,
      "moving button 300ms timeout",
    );
    const moveTimeoutClicks = await cdp.evaluate(`window.__moveTimeoutClicks`);
    assert(moveTimeoutClicks === 0, `moving timeout button must not be clicked, got ${moveTimeoutClicks}`);
    results.movingTimeoutError = movingTimeoutErr;

    // 6. waitFor timeout: error carries scene= with injected dialog[open] and .toast text.
    await cdp.evaluate(`(() => {
      document.body.innerHTML =
        '<dialog open>测试弹窗现场469</dialog>'
        + '<div class="toast">测试提示条现场469</div>';
    })()`);
    const waitErr = await assertRejects(
      () => waitFor(cdp, `false`, "impossible condition", 300),
      /scene=[\s\S]*测试弹窗现场469[\s\S]*测试提示条现场469/,
      "waitFor timeout scene",
    );
    results.waitForTimeoutError = waitErr;

    // 7a. clickAndWait without retryOnce: first click swallowed -> does not retry, times out.
    await cdp.evaluate(`(() => {
      document.body.innerHTML = '<button id="btn-flaky-no" style="width:140px;height:44px;">FlakyNo</button>';
      window.__flakyNoClicks = 0;
      window.__flakyNoDone = false;
      document.querySelector('#btn-flaky-no').addEventListener('click', () => {
        window.__flakyNoClicks += 1;
        if (window.__flakyNoClicks >= 2) window.__flakyNoDone = true;
      });
    })()`);
    const noRetryErr = await assertRejects(
      () => clickAndWait(cdp, `document.querySelector('#btn-flaky-no')`, `window.__flakyNoDone === true`, "flaky without retry", { timeoutMs: 600 }),
      /timed out waiting for flaky without retry/,
      "clickAndWait without retryOnce",
    );
    const flakyNoClicks = await cdp.evaluate(`window.__flakyNoClicks`);
    assert(flakyNoClicks === 1, `clickAndWait without retryOnce must only click once, got ${flakyNoClicks}`);
    results.clickAndWaitNoRetry = { clicks: flakyNoClicks, error: noRetryErr };

    // 7b. clickAndWait with retryOnce: logs [e2e-retry] after 3s and succeeds on second click.
    await cdp.evaluate(`(() => {
      document.body.innerHTML = '<button id="btn-flaky-yes" style="width:140px;height:44px;">FlakyYes</button>';
      window.__flakyYesClicks = 0;
      window.__flakyYesDone = false;
      document.querySelector('#btn-flaky-yes').addEventListener('click', () => {
        window.__flakyYesClicks += 1;
        if (window.__flakyYesClicks >= 2) window.__flakyYesDone = true;
      });
    })()`);
    const retryLogs = [];
    const origLog = console.log;
    console.log = (...args) => {
      retryLogs.push(args.map(String).join(" "));
      origLog(...args);
    };
    try {
      await clickAndWait(
        cdp,
        `document.querySelector('#btn-flaky-yes')`,
        `window.__flakyYesDone === true`,
        "flaky with retry",
        { retryOnce: "自测模拟首次点击被吞", timeoutMs: 8000 },
      );
    } finally {
      console.log = origLog;
    }
    const flakyYesClicks = await cdp.evaluate(`window.__flakyYesClicks`);
    assert(flakyYesClicks === 2, `clickAndWait with retryOnce expected 2 clicks, got ${flakyYesClicks}`);
    const retryLine = retryLogs.find((line) => line.startsWith("[e2e-retry]"));
    assert(
      Boolean(retryLine && retryLine.includes("flaky with retry") && retryLine.includes("自测模拟首次点击被吞") && retryLine.includes("hit=")),
      `missing expected [e2e-retry] log line, saw: ${JSON.stringify(retryLogs)}`,
    );
    results.clickAndWaitRetry = { clicks: flakyYesClicks, retryLine };

    // 8. dispatchMouse without reason: throws.
    const noReasonErr = await assertRejects(
      () => dispatchMouse(cdp, { type: "mouseMoved", x: 10, y: 10 }),
      /reason/i,
      "dispatchMouse missing options",
    );
    const emptyReasonErr = await assertRejects(
      () => dispatchMouse(cdp, { type: "mouseMoved", x: 10, y: 10 }, { reason: "   " }),
      /reason/i,
      "dispatchMouse blank reason",
    );
    results.dispatchMouseGuard = { noReasonErr, emptyReasonErr };

    // 9. Bonus sanity for doubleClick and hover exports.
    await cdp.evaluate(`(() => {
      document.body.innerHTML = '<button id="btn-extra" style="width:140px;height:44px;">Extra</button>';
      window.__dbl = 0;
      window.__hovered = 0;
      const btn = document.querySelector('#btn-extra');
      btn.addEventListener('dblclick', () => { window.__dbl += 1; });
      btn.addEventListener('mouseenter', () => { window.__hovered += 1; });
    })()`);
    await hover(cdp, `document.querySelector('#btn-extra')`, { label: "hover button" });
    await doubleClick(cdp, `document.querySelector('#btn-extra')`, { label: "dblclick button" });
    const extra = await cdp.evaluate(`({ dbl: window.__dbl, hovered: window.__hovered })`);
    assert(extra.hovered >= 1 && extra.dbl === 1, `hover/doubleClick mismatch: ${JSON.stringify(extra)}`);
    results.hoverAndDoubleClick = extra;

    console.log(`[e2e-cdp-tools] all assertions passed: ${JSON.stringify({
      normalClick: results.normalClick,
      offscreenClick: results.offscreenClick,
      movingWait: results.movingWait,
      clickAndWaitNoRetryClicks: results.clickAndWaitNoRetry.clicks,
      clickAndWaitRetryClicks: results.clickAndWaitRetry.clicks,
      retryLine: results.clickAndWaitRetry.retryLine,
      hoverAndDoubleClick: results.hoverAndDoubleClick,
    })}`);
    return { ok: true, ...results };
  } finally {
    cdp?.close();
    await stopChildProcess(child);
    await rm(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }).catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForReadyLine(stdoutChunks, stderrChunks, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (stdoutChunks.join("").includes("CDP_TOOLS_WINDOW_READY")) return;
    await sleep(100);
  }
  throw new Error(
    `cdp-tools window never became ready: stdout=${stdoutChunks.join("").slice(-500)} stderr=${stderrChunks.join("").slice(-1200)}`,
  );
}

async function stopChildProcess(child) {
  const pid = child.pid;
  if (!pid || pid <= 1) return;
  if (!(await signalProcessTree(pid))) child.kill("SIGTERM");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && child.exitCode === null) await sleep(100);
  if (child.exitCode === null) await signalProcessTree(pid, { force: true }).catch(() => {});
}
