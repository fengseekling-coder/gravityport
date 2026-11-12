// GravityPort React UI flow (task 383): the trash toolbar shows what emptying
// would free — one 12px muted line left of the 清空回收站 button, whose number
// matches /api/navigation's trashReclaimableBytes and disappears once the
// trash is emptied.
//
// Two layers (the inspector-reference-ratio split): the web-driver window
// does the functional assertions against the real server; hidden windows
// never paint, so the light/dark 1280px screenshots run against the real
// desktop shell via CDP, where the trash state is rebuilt through real UI
// operations (select -> context menu -> confirm) and the line is emptied for
// real at the end.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "trash-reclaimable-size";
export const description =
  "trash toolbar reclaimable-size line: text equals /api/navigation trashReclaimableBytes (清空可腾出约 {size}), sits left of 清空回收站 at 12px -> desktop screenshots (dark + light, 1280 wide) -> empty trash removes the line and the button";

// Same arithmetic as App.tsx humanSize — kept in sync by the assertions below
// (a drifted copy makes the flow fail loudly instead of passing vacuously).
function humanSize(bytes) {
  if (!bytes || bytes <= 0) return "—";
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export async function run(ctx) {
  await ctx.prepare();
  const server = await ctx.startServer();
  let serverRunning = true;
  try {
    // Three file-copy imports (storage_mode "copy", file_bytes written at
    // import): every trashed byte is reclaimable, so the line's number is the
    // plain sum of the trashed files' sizes.
    const ids = [];
    for (let index = 0; index < 3; index += 1) {
      const created = await ctx.api(server.origin, "POST", "/api/assets/create", {
        projectId: "default",
        imagePath: await ctx.makePng(`trs-${index}.png`, [40 + index * 40, 90, 130]),
        prompt: `trash reclaimable ${index}`,
      });
      ids.push(created.asset.id);
    }

    const result = await ctx.runInPage(server, pageSource(ids));
    if (!result || result.failedSteps?.length) {
      throw new Error(`trash-reclaimable-size page result: ${JSON.stringify(result)}`);
    }
    const expectedLine = `清空可腾出约 ${humanSize(result.navBytes)}`;
    if (result.lineText !== expectedLine) {
      throw new Error(`line text ${JSON.stringify(result.lineText)} != expected ${JSON.stringify(expectedLine)} (nav bytes ${result.navBytes})`);
    }
    if (result.navBytes <= 0) throw new Error(`expected reclaimable bytes > 0 for copy imports, got ${result.navBytes}`);

    // The screenshot layer gets its own single writer: the desktop shell opens
    // the same library directory, so the main server stops first.
    await server.stop();
    serverRunning = false;
    const screenshots = await runDesktopPhase(ctx, ids);
    return { steps: result.steps, navBytes: result.navBytes, lineText: result.lineText, screenshots };
  } finally {
    if (serverRunning) await server.stop().catch(() => {});
  }
}

function pageSource(ids) {
  return `(async () => {
    const ids = ${JSON.stringify(ids)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const steps = [];
    const failedSteps = [];
    const clientToken = () => sessionStorage.getItem('mosa.client-token') || '';
    async function api(path) {
      const response = await fetch(path, { headers: { 'x-mosa-client-token': clientToken() } });
      const text = await response.text();
      if (!response.ok) throw new Error('GET ' + path + ' -> ' + response.status + ': ' + text.slice(0, 200));
      return text ? JSON.parse(text) : null;
    }
    async function waitFor(check, label, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const value = await check();
          if (value) return value;
        } catch (error) { lastError = error; }
        await sleep(120);
      }
      throw new Error('Timed out waiting for ' + label + (lastError ? ': ' + lastError.message : '')
        + ' | cards=' + document.querySelectorAll('.asset-card').length
        + ' | menu=' + (document.querySelector('.context-menu')?.textContent?.trim().slice(0, 120) || ''));
    }
    const card = (id) => document.querySelector('[data-asset-id="' + id + '"]');
    const settled = () => !document.querySelector(".empty-state[role='status']");
    function clickCard(id, modifiers = {}) {
      const node = card(id);
      if (!node) throw new Error('missing card ' + id);
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    }
    function clickLabel(label, scope) {
      const root = scope ? document.querySelector(scope) : document;
      const button = Array.from((root || document).querySelectorAll('button')).find((entry) =>
        entry.textContent.trim() === label
          || Array.from(entry.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === label));
      if (!button) throw new Error('Missing button "' + label + '"');
      button.click();
      return button;
    }
    async function contextMenuOn(node, label) {
      const deadline = Date.now() + 15000;
      return (async () => {
        while (Date.now() < deadline) {
          if (node.isConnected) {
            node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
            const item = [...document.querySelectorAll('.context-menu button')].find((entry) => entry.textContent.trim() === label);
            if (item) return item;
          }
          await sleep(100);
        }
        throw new Error('Timed out waiting for context menu item ' + label);
      })();
    }
    async function step(label, fn) {
      try {
        await fn();
        steps.push(label);
      } catch (error) {
        failedSteps.push(label + ': ' + String(error?.message || error).slice(0, 1600));
      }
    }

    await waitFor(() => settled() && document.querySelectorAll('.asset-card').length === 3, 'seeded gallery with 3 cards');

    await step('move two assets to trash through the real menu', async () => {
      clickCard(ids[0]);
      clickCard(ids[1], { ctrlKey: true });
      await waitFor(() => document.querySelectorAll('.asset-card.asset-selected').length === 2, 'two selection rings');
      await contextMenuOn(card(ids[1]), '移到回收站').then((item) => item.click());
      await waitFor(() => document.querySelector('[role="alertdialog"]'), 'trash confirm dialog');
      clickLabel('移到回收站', '.delete-modal');
      await waitFor(async () => (await api('/api/assets?project=default&trash=1&limit=250')).assets.length === 2,
        'server: two assets in the trash');
    });

    let navBytes = 0;
    await step('the reclaimable line matches /api/navigation and sits left of the button', async () => {
      clickLabel('回收站', '.main-nav');
      await waitFor(() => settled() && document.querySelectorAll('.asset-card').length === 2, 'trash view shows two cards');
      const line = await waitFor(() => document.querySelector('.trash-reclaimable'), 'the .trash-reclaimable line');
      const navigation = await api('/api/navigation?project=default');
      navBytes = Number(navigation.navigation?.trashReclaimableBytes ?? 0);
      const lineText = line.textContent.trim();
      const expected = '清空可腾出约 ' + (navBytes > 0 ? humanSizeCopy(navBytes) : '0 KB');
      if (lineText !== expected) throw new Error('line ' + JSON.stringify(lineText) + ' != ' + JSON.stringify(expected));
      const button = Array.from(document.querySelectorAll('.toolbar-right button'))
        .find((entry) => entry.textContent.trim() === '清空回收站');
      if (!button) throw new Error('清空回收站 button missing');
      const lineRect = line.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      if (lineRect.right > buttonRect.left) {
        throw new Error('line is not left of the button (line right ' + lineRect.right + ' vs button left ' + buttonRect.left + ')');
      }
      const style = getComputedStyle(line);
      if (style.fontSize !== '12px') throw new Error('line font-size ' + style.fontSize + ' != 12px');
      if (line.tagName !== 'SPAN' || line.closest('button')) throw new Error('the line must be plain text, not a button');
      return lineText;
    });

    return { steps, failedSteps, navBytes, lineText: document.querySelector('.trash-reclaimable')?.textContent.trim() || '' };

    function humanSizeCopy(bytes) {
      if (!bytes || bytes <= 0) return '—';
      if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
      if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    }
  })()
  `;
}

async function runDesktopPhase(ctx, ids) {
  const guiRoot = join(ctx.userDataDir, "..", "desktop-gui");
  await mkdir(join(guiRoot, "generated-images"), { recursive: true });
  await mkdir(join(guiRoot, "codex-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "grok-sessions"), { recursive: true });
  await mkdir(join(guiRoot, "cowart-data"), { recursive: true });
  // The desktop shell remembers its bounds in userData; a fresh dir would
  // open at the 1320px default. Seed 1280 wide for the task's screenshot size.
  await writeFile(join(ctx.userDataDir, "window-bounds.json"), JSON.stringify({ width: 1280, height: 800 }));

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
      const diagnostic = await evaluate(`(() => {
        const app = document.querySelector('.app');
        return JSON.stringify({
          url: location.href,
          appClasses: app ? app.className : null,
          bodyChildren: Array.from(document.body.children).map((node) => node.tagName + '.' + String(node.className).split(' ').slice(0, 3).join('.')),
          navButtons: Array.from(document.querySelectorAll('.main-nav button')).map((entry) => entry.textContent.trim()).slice(0, 8),
          cards: document.querySelectorAll('.asset-card').length,
        });
      })()`).catch((error) => `diagnostic failed: ${error.message}`);
      throw new Error(`desktop phase timed out waiting for ${label}; state=${diagnostic}`);
    }
    const capture = async (filename) => {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      if (!shot?.data) throw new Error(`Page.captureScreenshot returned no data for ${filename}`);
      const path = join(shotsDir, filename);
      await writeFile(path, Buffer.from(shot.data, "base64"));
      written.push(path);
      const copyTo = process.env.MOSA_E2E_SHOT_COPY_TO;
      if (copyTo) {
        await mkdir(copyTo, { recursive: true });
        await writeFile(join(copyTo, filename), Buffer.from(shot.data, "base64"));
      }
    };
    const clickButton = (label, scope) => evaluate(`(() => {
      const root = ${JSON.stringify(scope)} ? document.querySelector(${JSON.stringify(scope)}) : document;
      const button = Array.from((root || document).querySelectorAll('button')).find((entry) =>
        entry.textContent.trim() === ${JSON.stringify(label)}
          || Array.from(entry.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === ${JSON.stringify(label)}));
      if (!button) return false;
      button.click();
      return true;
    })()`);

    await waitForValue(`document.querySelectorAll('.asset-card').length >= 1`, "the seeded cards");

    // Rebuild the trash state through the real UI: the remaining asset joins
    // the two already in the trash from the web phase.
    await evaluate(`(() => {
      const card = document.querySelector('[data-asset-id="' + ${JSON.stringify(ids[2])} + '"]');
      if (!card) throw new Error('card not found in the desktop shell');
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    })()`);
    await waitForValue(`document.querySelectorAll('.asset-card.asset-selected').length === 1`, "one selection ring");
    await evaluate(`(() => {
      const card = document.querySelector('[data-asset-id="' + ${JSON.stringify(ids[2])} + '"]');
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 500, clientY: 400 }));
    })()`);
    const menuOpened = await waitForValue(
      `Array.from(document.querySelectorAll('.context-menu button')).some((entry) => entry.textContent.trim() === '移到回收站')`,
      "the trash context menu",
    );
    if (!menuOpened) throw new Error("context menu never offered 移到回收站");
    await evaluate(`(() => {
      Array.from(document.querySelectorAll('.context-menu button'))
        .find((entry) => entry.textContent.trim() === '移到回收站').click();
    })()`);
    await waitForValue(`Boolean(document.querySelector('[role="alertdialog"]'))`, "the trash confirm dialog");
    if (!await clickButton("移到回收站", ".delete-modal")) throw new Error("confirm button missing");
    await waitForValue(
      `(async () => (await (await fetch('/api/assets?project=default&trash=1&limit=250', { headers: { 'x-mosa-client-token': sessionStorage.getItem('mosa.client-token') || '' } })).json()).assets.length === 3)()`,
      "server: three assets in the trash",
      15000,
    );

    if (!await clickButton("回收站", ".main-nav")) throw new Error("回收站 nav button missing");
    await waitForValue(`document.querySelectorAll('.trash-reclaimable').length === 1 && document.querySelectorAll('.asset-card').length === 3`,
      "the trash view with the reclaimable line");

    // Node-side truth: the line's number must equal the live navigation API.
    const navigation = await ctx.api(`http://127.0.0.1:${port}`, "GET", "/api/navigation?project=default");
    const navBytes = Number(navigation.navigation?.trashReclaimableBytes ?? 0);
    const lineText = String(await evaluate(`document.querySelector('.trash-reclaimable').textContent.trim()`));
    const expectedLine = `清空可腾出约 ${humanSize(navBytes)}`;
    if (lineText !== expectedLine) {
      throw new Error(`desktop line ${JSON.stringify(lineText)} != expected ${JSON.stringify(expectedLine)} (nav bytes ${navBytes})`);
    }

    // Light/dark screenshots of the trash toolbar (1280 wide, seeded bounds).
    for (const [appearance, fileName] of [["深色", "383-trash-reclaimable-dark.png"], ["浅色", "383-trash-reclaimable-light.png"]]) {
      await evaluate(`localStorage.setItem("gravityport.preferences", ${JSON.stringify(JSON.stringify({ appearance, cardInfo: false, language: "zh" }))})`);
      // A reload can strand the evaluate on the detached frame; fire and poll.
      evaluate("location.reload()").catch(() => {});
      await waitForValue(`Boolean(document.querySelector('.app'))`, "app shell after reload");
      await waitForValue(
        appearance === "深色"
          ? `document.querySelector('.app').classList.contains('dark')`
          : `!document.querySelector('.app').classList.contains('dark')`,
        `${appearance} theme applied`,
      );
      // Every asset is in the trash here, so the default view is EMPTY — the
      // cards only exist in the trash view. Navigate there first. The nav
      // button's textContent carries the count badge ("回收站3"), so match
      // the label span exactly the way clickButton does.
      await waitForValue(
        `Array.from(document.querySelectorAll('.main-nav button')).some((entry) =>
          Array.from(entry.querySelectorAll(':scope > span')).some((span) => span.textContent.trim() === '回收站'))`,
        "sidebar nav ready after reload",
      );
      if (!await clickButton("回收站", ".main-nav")) throw new Error("回收站 nav button missing after reload");
      await waitForValue(`document.querySelectorAll('.trash-reclaimable').length === 1 && document.querySelectorAll('.asset-card').length === 3`, `the reclaimable line (${appearance})`);
      await sleep(300);
      await capture(fileName);
    }

    // Empty the trash for real: the line and the button must both go away.
    await evaluate(`document.querySelector('.toolbar-empty-trash').click()`);
    await waitForValue(`Boolean(document.querySelector('[role="alertdialog"]'))`, "the empty-trash confirm dialog");
    if (!await clickButton("清空回收站", ".delete-modal")) throw new Error("empty-trash confirm button missing");
    await waitForValue(`!document.querySelector('.trash-reclaimable')`, "the line disappears after emptying");
    await waitForValue(
      `!Array.from(document.querySelectorAll('.toolbar-right button')).some((entry) => entry.textContent.trim() === '清空回收站')`,
      "the 清空回收站 button disappears at zero",
    );
    const emptied = await ctx.api(`http://127.0.0.1:${port}`, "GET", "/api/navigation?project=default");
    if (Number(emptied.navigation?.trash ?? -1) !== 0) throw new Error(`trash not empty after emptying: ${JSON.stringify(emptied.navigation)}`);
    return written;
  } catch (error) {
    const log = await readFile(logFile, "utf8").catch(() => "");
    throw new Error(`${error.message}${log ? `\n[trash-reclaimable-size] main.log tail:\n${log.slice(-2000)}` : ""}`, { cause: error });
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

async function screenshotDir(ctx) {
  // Screenshots are task-report artifacts, not repo files: write into the
  // runner's temp fixtures and let MOSA_E2E_SHOT_COPY_TO name a surviving
  // directory (the task run sets it to the report's log directory).
  const fallback = join(ctx.fixturesDir, "screenshots");
  await mkdir(fallback, { recursive: true });
  return fallback;
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
    socket.addEventListener("open", () => resolveReady(), { once: true });
    socket.addEventListener("error", () => rejectReady(new Error("cdp socket error")), { once: true });
  });
  return ready.then(() => ({
    send(method, params = {}) {
      const id = ++idSeq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`cdp ${method} timed out`));
          }
        }, 15000);
      });
    },
    close() {
      try { socket.close(); } catch {}
    },
  }));
}
