// GravityPort desktop flow (task 458): Settings → AI page with the real
// desktop shell (desktop/main.mjs + preload) so the five ai-* IPC channels
// run for real: keys land in the flow-local userData (ai-credentials.json),
// never in the library.
//
// The flow starts two fake services on 127.0.0.1 (one answers GET /v1/models
// with two model ids, one always answers 401 with the fake key quoted — the
// way OpenAI's real 401 does — to prove the response body never surfaces).
// Nothing here talks to any real AI provider.
//
// Round 1: without the entry switch the settings nav has no AI row. Round 2:
// localStorage "gravityport.dev.ai-generation"="1" + reload reveals it. Then
// through the real UI: add an OpenAI-format custom service pointing at the
// 200 server, save the fake key (已保存 · 尾号 5678, input cleared), test the
// connection (连接正常 · 可用 2 个模型), remove the service (key cascades),
// repeat against the 401 server (密钥不对或没有权限（401）), delete the key,
// and finally read ai-credentials.json raw bytes in Node: the fake key must
// not appear anywhere.
import { createServer } from "node:http";
import { copyFile, readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopGui } from "../desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath } from "../desktop-runtime-paths.mjs";

export const name = "settings-ai";
export const description = "real desktop shell + real ai-* IPC: nav has no AI without the switch, localStorage switch reveals it, add custom service (127.0.0.1 fake) -> save key (尾号 5678, input cleared) -> test (连接正常 · 可用 2 个模型) -> remove service cascades the key -> 401 server round shows 密钥不对或没有权限（401） -> delete key -> ai-credentials.json bytes never contain the fake key";

const FAKE_KEY = `sk-test-${"0".repeat(30)}5678`;
const FAKE_KEY_BODY = FAKE_KEY.slice("sk-test-".length);

export async function run(ctx) {
  await ctx.prepare();
  const guiRoot = join(ctx.userDataDir, "..", "settings-ai-gui");
  await mkdir(guiRoot, { recursive: true });

  // Two fake services, both strictly on 127.0.0.1, both closed in finally.
  const modelIds = ["flow-model-a", "flow-model-b"];
  const server200 = await startFakeService((req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: modelIds.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  const server401 = await startFakeService((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    // Poisoned with the fake key, like a real OpenAI 401: the UI must never
    // echo this body, so the flow also asserts the status line lacks it.
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${FAKE_KEY}.` } }));
  });

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

  const waiter = launched.waiter;
  let cdp = null;
  try {
    await waitForHealthFile(healthFile);
    // Seed through the desktop service's own staging endpoint: the staged
    // copy lives inside its project roots, which /api/assets/create requires.
    const origin = `http://127.0.0.1:${port}`;
    const pngPath = await ctx.makePng("settings-ai-seed.png", [104, 137, 191]);
    const staged = await fetch(`${origin}/api/import/stage`, {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-mosa-file-name": encodeURIComponent("settings-ai-seed.png"),
        "x-mosa-client-token": ctx.token,
      },
      body: await readFile(pngPath),
    });
    if (!staged.ok) throw new Error(`import stage failed (${staged.status})`);
    const { path } = await staged.json();
    await ctx.api(origin, "POST", "/api/assets/create", {
      projectId: "default",
      imagePath: path,
      prompt: "settings ai seed",
    });
    cdp = await connectCdp(cdpPort, `http://127.0.0.1:${port}`);
    await waitForRendererReady(cdp);
    await waitFor(cdp, `document.querySelectorAll('.asset-card').length === 1`, "seeded gallery");

    // Round 1: no switch — settings nav has no AI row.
    await openSettings(cdp, "settings open");
    const navWithoutSwitch = await cdp.evaluate(`(() => ({
      labels: Array.from(document.querySelectorAll('.settings-nav button')).map((button) => button.textContent.trim()),
      hasAi: Array.from(document.querySelectorAll('.settings-nav button')).some((button) => button.textContent.trim() === 'AI'),
    }))()`);
    if (navWithoutSwitch.hasAi) throw new Error(`switch off but nav shows AI: ${JSON.stringify(navWithoutSwitch.labels)}`);
    await clickCenter(cdp, `document.querySelector('.settings-modal .modal-close')`);
    await waitFor(cdp, `!document.querySelector('.settings-modal')`, "settings closed");

    // Round 2: set the switch and reload — AI_SETTINGS_ENTRY is evaluated at
    // module load, so the page must reload for it to take effect.
    await cdp.evaluate(`localStorage.setItem('gravityport.dev.ai-generation', '1')`);
    await cdp.evaluate(`location.reload()`);
    await waitForRendererReady(cdp);
    await waitFor(cdp, `document.querySelectorAll('.asset-card').length === 1`, "gallery after reload");
    await openSettings(cdp, "settings open again");
    await waitFor(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).some((button) => button.textContent.trim() === 'AI')`, "AI nav row appears");
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.settings-nav button')).find((button) => button.textContent.trim() === 'AI')`);
    await waitFor(cdp, `document.querySelectorAll('.settings-modal .ai-card').length === 3`, "three AI cards");
    await waitFor(cdp,
      `document.querySelector('.ai-panel-desc')?.textContent.includes('密钥只保存在本机')`,
      "panel privacy line");
    const cardTitles = await cdp.evaluate(`Array.from(document.querySelectorAll('.settings-modal .ai-card > .settings-card-head strong, .settings-modal .ai-card .settings-card-head strong')).map((el) => el.textContent.trim()).slice(0, 3)`);
    if (!cardTitles.some((title) => title.includes("分析和汇总"))) throw new Error(`first card title: ${JSON.stringify(cardTitles)}`);

    // --- Round 3: custom service -> save key -> test OK ---
    const fakeKeyRecord = { savedShown: false, inputCleared: false, testOk: false, testMessage: null };
    await addCustomService(cdp, `http://127.0.0.1:${server200.port}/v1`);
    await saveKey(cdp, FAKE_KEY);
    await waitFor(cdp,
      `Array.from(document.querySelectorAll('.ai-key-saved')).some((el) => el.textContent.includes('尾号 5678'))`,
      "已保存 · 尾号 5678");
    fakeKeyRecord.savedShown = true;
    // 保存成功后输入框立刻清空：行切到已保存态（输入框消失），点「更换」
    // 重开的输入框必须是空值。
    const inputsAfterSave = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-key-input')).map((el) => el.value)`);
    if (inputsAfterSave.length !== 0) throw new Error(`save succeeded but a key input still holds text: ${JSON.stringify(inputsAfterSave)}`);
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card .ai-key-row .settings-action-btn')).find((el) => el.textContent.trim() === '更换')`);
    await waitFor(cdp, `Boolean(document.querySelector('.ai-card .ai-key-input'))`, "更换 reopens the key input");
    // 同一家在三块共用一把：三张卡的密钥行一起进入编辑态，每个输入框都必须是空值。
    const reopened = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-card .ai-key-input')).map((el) => el.value)`);
    if (reopened.length < 1 || reopened.some((value) => value !== "")) throw new Error(`reopened key inputs not all empty: ${JSON.stringify(reopened)}`);
    fakeKeyRecord.inputCleared = true;
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card')).map((card) => card.querySelector('.ai-test-row .settings-action-btn')).find(Boolean)`);
    await waitFor(cdp,
      `Array.from(document.querySelectorAll('.ai-status-line')).some((el) => el.textContent.includes('连接正常 · 可用 2 个模型'))`,
      "test connection ok line");
    fakeKeyRecord.testOk = true;
    const okLine = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()).join(' | ')`);
    if (okLine.includes(FAKE_KEY)) throw new Error(`status line leaks the fake key: ${okLine}`);
    fakeKeyRecord.testMessage = okLine;

    // Artifacts for the task report: the userData files exactly as this flow
    // left them (credential with the QA ciphertext, settings with the last
    // test's model list). Flow-local only; nothing in the library.
    const artifactsDir = join(ctx.rootDir, "tasks", "logs", "458-settings-ai");
    await mkdir(artifactsDir, { recursive: true });
    await copyFile(join(ctx.userDataDir, "ai-credentials.json"), join(artifactsDir, "ai-credentials.json"));
    await copyFile(join(ctx.userDataDir, "ai-settings.json"), join(artifactsDir, "ai-settings.json"));

    // Model dropdown now carries the fake service's two ids (from lastTests).
    const modelOptions = await cdp.evaluate(`(() => {
      const trigger = Array.from(document.querySelectorAll('.ai-card .ai-model-row .toolbar-select span')).map((el) => el.textContent.trim());
      return trigger;
    })()`);
    if (!modelOptions.some((text) => text && text !== "未选择")) throw new Error(`model dropdowns empty after test: ${JSON.stringify(modelOptions)}`);

    // --- Round 4: remove this service (key cascades), repeat with the 401 server ---
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card')).map((card) => card.querySelector('.ai-row .settings-action-btn')).find((el) => el && el.textContent.trim() === '删除此服务')`);
    await waitFor(cdp, `!document.querySelector('.ai-key-saved') && !document.querySelector('.ai-key-input')`, "service removed: card falls back to 未选择");

    await addCustomService(cdp, `http://127.0.0.1:${server401.port}/v1`);
    await saveKey(cdp, FAKE_KEY);
    await waitFor(cdp,
      `Array.from(document.querySelectorAll('.ai-key-saved')).some((el) => el.textContent.includes('尾号 5678'))`,
      "401 service key saved");
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card')).map((card) => card.querySelector('.ai-test-row .settings-action-btn')).find(Boolean)`);
    await waitFor(cdp,
      `Array.from(document.querySelectorAll('.ai-status-line')).some((el) => el.textContent.includes('密钥不对或没有权限（401）'))`,
      "401 failure line");
    const failLine = await cdp.evaluate(`Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()).join(' | ')`);
    if (failLine.includes(FAKE_KEY) || failLine.includes("Incorrect API key")) {
      throw new Error(`failure line leaks the response body: ${failLine}`);
    }

    // --- Round 5: delete the key -> the password input comes back ---
    await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card')).map((card) => card.querySelector('.ai-key-row')).map((row) => Array.from(row.querySelectorAll('.settings-action-btn')).find((el) => el.textContent.trim() === '删除')).find(Boolean)`);
    await waitFor(cdp, `!document.querySelector('.ai-key-saved') && Boolean(document.querySelector('.ai-key-input'))`, "key deleted: input row back");

    // Final byte check on the real userData file: the fake key survives nowhere.
    const credentialPath = join(ctx.userDataDir, "ai-credentials.json");
    const raw = await readFile(credentialPath, "utf8");
    if (raw.includes(FAKE_KEY) || raw.includes(FAKE_KEY_BODY)) {
      throw new Error(`ai-credentials.json contains the fake key (raw bytes): ${JSON.stringify(raw.slice(0, 400))}`);
    }
    const settingsRaw = await readFile(join(ctx.userDataDir, "ai-settings.json"), "utf8");
    if (settingsRaw.includes(FAKE_KEY)) throw new Error("ai-settings.json contains the fake key");

    console.log(`[e2e] flow ${name} ok: ${JSON.stringify({ ...fakeKeyRecord, services: server200.url, failing: server401.url })}`);
    return;
  } finally {
    if (cdp) cdp.close();
    if (waiter.exitCode === null) waiter.kill("SIGTERM");
    await server200.close();
    await server401.close();
    await rm(guiRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function addCustomService(cdp, baseUrl) {
  // 服务下拉 → 添加其它服务… → 名称/地址 → 添加。分析的卡是第一张 .ai-card。
  await clickCenter(cdp, `document.querySelector('.ai-card .ai-row .toolbar-select')`);
  await waitFor(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).some((el) => el.textContent.includes('添加其它服务'))`, "add-service option");
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.toolbar-select-menu .toolbar-select-option')).find((el) => el.textContent.includes('添加其它服务'))`);
  await waitFor(cdp, `Boolean(document.querySelector('.ai-add-form'))`, "add form open");
  await clickCenter(cdp, `document.querySelector('.ai-add-form input.ai-text-input')`);
  await cdp.send("Input.insertText", { text: "Flow 假服务" });
  await clickCenter(cdp, `document.querySelector('.ai-add-form input[type="url"]')`);
  await cdp.send("Input.insertText", { text: baseUrl });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-add-actions .settings-action-btn')).find((el) => el.textContent.trim() === '添加')`);
  await waitFor(cdp, `!document.querySelector('.ai-add-form')`, "add form closed");
  await waitFor(cdp,
    `Array.from(document.querySelectorAll('.ai-card .ai-row .toolbar-select span')).some((el) => el.textContent.trim() === 'Flow 假服务')`,
    "custom service selected in the card");
}

async function saveKey(cdp, key) {
  await clickCenter(cdp, `document.querySelector('.ai-card .ai-key-input')`);
  await cdp.send("Input.insertText", { text: key });
  await clickCenter(cdp, `Array.from(document.querySelectorAll('.ai-card .ai-key-row .settings-action-btn')).find((el) => el.textContent.trim() === '保存')`);
}

async function waitForRendererReady(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await cdp.evaluate(`({
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.aiGetState === 'function'),
      })`);
      if (state?.readyState === "complete" && state.appShell && state.preload) return;
    } catch {}
    await sleep(150);
  }
  throw new Error("desktop renderer readiness timeout (aiGetState missing from preload?)");
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(${expression})`)) return;
    await sleep(150);
  }
  const snapshot = await cdp.evaluate(`(() => ({
    nav: Array.from(document.querySelectorAll('.settings-nav button')).map((button) => button.textContent.trim()),
    cards: document.querySelectorAll('.ai-card').length,
    saved: Array.from(document.querySelectorAll('.ai-key-saved')).map((el) => el.textContent.trim()),
    status: Array.from(document.querySelectorAll('.ai-status-line')).map((el) => el.textContent.trim()),
    selects: Array.from(document.querySelectorAll('.ai-card .toolbar-select > span')).map((el) => el.textContent.trim()),
    errors: Array.from(document.querySelectorAll('.ai-error-line')).map((el) => el.textContent.trim()),
  }))()`.replace(/\n\s*/g, " ")).catch(() => ({}));
  throw new Error(`timeout waiting for ${label}; state=${JSON.stringify(snapshot)}`);
}

async function centerOf(cdp, elementExpression) {
  const point = await cdp.evaluate(`(() => {
    const el = ${elementExpression};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  if (!point) throw new Error(`element not found: ${elementExpression}`);
  return point;
}

// 刷新后左下角的用户按钮要等它真能接住点击再点：PR #357 第四轮 macOS CI
// 在刷新后点了一下、设置窗口没开，单点一次又不核对，只剩一句超时。先等它
// 看得见、中心点落在它自己身上；点了 3 秒没开，记下点上去的是什么再点一次。
async function openSettings(cdp, label) {
  const button = `document.querySelector('.user-button')`;
  await waitFor(cdp, `(() => {
    const el = ${button};
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return Boolean(hit && (hit === el || el.contains(hit)));
  })()`, `${label}: user button clickable`);
  await clickCenter(cdp, button);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(`Boolean(document.querySelector('.settings-modal'))`)) return;
    await sleep(150);
  }
  const probe = await cdp.evaluate(`(() => {
    const el = ${button};
    const r = el ? el.getBoundingClientRect() : null;
    const hit = r ? document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) : null;
    return { rect: r ? [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] : null, hit: hit ? hit.tagName.toLowerCase() + '.' + String(hit.className || '').trim().split(/\\s+/).join('.') : null, active: document.activeElement?.tagName || null };
  })()`);
  console.log(`[e2e] settings-ai ${label}: first click did not open settings, retrying once ${JSON.stringify(probe)}`);
  await clickCenter(cdp, button);
  await waitFor(cdp, `document.querySelector('.settings-modal')`, label);
}

async function clickCenter(cdp, elementExpression) {
  const point = await centerOf(cdp, elementExpression);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
}

async function waitForHealthFile(filePath, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = JSON.parse(await readFile(filePath, "utf8"));
      if (health?.product === "mosa") return health;
    } catch {}
    await sleep(250);
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
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else if (message.result?.exceptionDetails) {
        reject(new Error("evaluate failed: " + (message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text)));
      } else resolve(message.result?.result?.value);
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

function startFakeService(handler) {
  return new Promise((resolveService) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveService({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
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
