import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { removeTestPath as rm } from "./test-cleanup.mjs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { assertPackageLockMatchesManifest } from "./package-lock-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const preloadPath = resolve(root, "desktop", "preload.cjs");
const electronPath = process.platform === "darwin"
  ? resolve(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron")
  : process.platform === "win32"
    ? resolve(root, "node_modules", "electron", "dist", "electron.exe")
    : resolve(root, "node_modules", "electron", "dist", "electron");
const EXPECTED_API_KEYS = [
  "acknowledgeRenameNotice",
  "cancelUpdateDownload",
  "cancelVisualPackInstall",
  "changeLibraryLocation",
  "checkForUpdates",
  "downloadAndInstallUpdate",
  "getRenameNoticeState",
  "getUserProfile",
  "getVisualModelState",
  "installVisualPack",
  "onMenuSearch",
  "onUpdateDownloadProgress",
  "onVisualPackProgress",
  "onWindowFullScreenChange",
  "openDownloadPage",
  "openPinterestAuthorize",
  "pasteImage",
  "removeVisualPack",
  "reportRendererReady",
  "setLocale",
  "setVisualModelEnabled",
  "setWindowFullScreen",
  "startNativeDrag",
  "writeClipboardImage",
  "writeClipboardText",
];
// R1 isolation fix (2026-08-09, approved scope) added qa:web/qa:electron/
// qa:packaged launcher scripts to package.json, so only its dependency
// sections stay pinned (see the dependency assertions below).

const read = (relativePath) => readFile(resolve(root, relativePath), "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sortedApiKeys = (source) => [...source.matchAll(/^  ([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]).sort();

test("preload path, module format, security settings, and API surface are stable", async () => {
  const [main, preload, packageJson, lockfile] = await Promise.all([
    read("desktop/main.mjs"),
    read("desktop/preload.cjs"),
    read("package.json"),
    read("package-lock.json"),
  ]);

  await access(preloadPath);
  await assert.rejects(access(resolve(root, "desktop", "preload.mjs")), { code: "ENOENT" });
  assert.equal(isAbsolute(preloadPath), true);
  assert.equal(extname(preloadPath), ".cjs");
  assert.match(main, /const preloadPath = fileURLToPath\(new URL\("\.\/preload\.cjs", import\.meta\.url\)\);/);
  assert.match(main, /preload: preloadPath/);
  assert.match(main, /webContents\.once\("preload-error"/);
  assert.match(main, /webContents\.on\("render-process-gone"/);
  assert.match(main, /rendererRecoveryAttempts > 2/);
  assert.match(main, /mainWindow\.webContents\.reload\(\)/);
  assert.match(main, /app\.relaunch\(\)/);
  assert.match(main, /webContents\.on\("console-message"/);
  assert.match(main, /MAX_RENDERER_CONSOLE_ERRORS = 32/);
  assert.doesNotMatch(main, /process\.cwd\(\)|join\(__dirname/);
  assert.match(preload, /^const \{ contextBridge, ipcRenderer \} = require\("electron"\);/);
  assert.doesNotMatch(preload, /^\s*import\s/m);

  for (const setting of ["contextIsolation: true", "sandbox: true", "nodeIntegration: false"]) {
    assert.match(main, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${setting} remains enabled`);
  }

  assert.doesNotMatch(preload, /require\s*:/, "require is not exposed as an API key");
  assert.doesNotMatch(preload, /ipcRenderer\s*:/, "ipcRenderer is not exposed as an API value");
  assert.doesNotMatch(preload, /^\s*shell\s*:/m, "shell is not exposed as an API value");
  assert.doesNotMatch(preload, /openExternal|sendSync|\.send\(/, "generic IPC is not exposed");
  // The preload exposes only narrow, named request channels. Update actions
  // accept no URL from the renderer; the main process owns the fixed website.
  // 任务 96（A6）：第 18 条批准通道 set-window-full-screen（大图页全屏与窗口
  // 系统全屏双向同步）；window-full-screen-change 是 ipcRenderer.on 单向广播，
  // 不在 invoke 计数内。任务 116：第 19/20 条 rename-notice-state /
  // acknowledge-rename-notice（老用户「已更名」提示）。任务 135：第 21 条
  // open-pinterest-authorize（Pinterest OAuth 授权页）。
  assert.equal(preload.split("ipcRenderer.invoke").length - 1, 21, "only the twenty-one approved invoke channels remain");
  assert.deepEqual(sortedApiKeys(preload), EXPECTED_API_KEYS);
  assert.match(preload, /setWindowFullScreen: \(flag\) => ipcRenderer\.invoke\("set-window-full-screen", flag === true\)/);
  assert.match(preload, /onWindowFullScreenChange: \(callback\) =>[\s\S]*?ipcRenderer\.on\("window-full-screen-change"/);
  assert.match(preload, /startNativeDrag: \(paths\) => ipcRenderer\.invoke\("start-native-file-drag", paths\)/);
  assert.match(preload, /getUserProfile: \(\) => ipcRenderer\.invoke\("user-profile"\)/);
  // 任务 116：老用户「已更名」提示的取状态/确认通道。
  assert.match(preload, /getRenameNoticeState: \(\) => ipcRenderer\.invoke\("rename-notice-state"\)/);
  assert.match(preload, /acknowledgeRenameNotice: \(\) => ipcRenderer\.invoke\("acknowledge-rename-notice"\)/);
  assert.match(main, /ipcMain\.handle\("rename-notice-state"/);
  assert.match(main, /ipcMain\.handle\("acknowledge-rename-notice"/);
  assert.match(preload, /writeClipboardImage: \(path\) => ipcRenderer\.invoke\("write-clipboard-image", path\)/);
  assert.match(preload, /writeClipboardText: \(text\) => ipcRenderer\.invoke\("write-clipboard-text", text\)/);
  assert.match(preload, /checkForUpdates: \(notify = false\) =>[\s\S]*?ipcRenderer\.invoke\("check-for-updates", notify === true\)/);
  assert.match(preload, /cancelUpdateDownload: \(\) => ipcRenderer\.invoke\("cancel-update-download"\)/);
  assert.match(preload, /downloadAndInstallUpdate: \(\) => ipcRenderer\.invoke\("download-and-install-update"\)/);
  assert.match(preload, /reportRendererReady: \(\) => ipcRenderer\.invoke\("renderer-ready"\)/);
  assert.match(preload, /onUpdateDownloadProgress: \(callback\) =>[\s\S]*?ipcRenderer\.on\("update-download-progress"/);
  assert.match(preload, /openDownloadPage: \(\) => ipcRenderer\.invoke\("open-download-page"\)/);
  assert.match(preload, /openPinterestAuthorize: \(url\) => ipcRenderer\.invoke\("open-pinterest-authorize", url\)/);
  assert.match(preload, /changeLibraryLocation: \(\) => ipcRenderer\.invoke\("change-library-location"\)/);
  assert.match(preload, /getVisualModelState: \(refresh = false\) => ipcRenderer\.invoke\("visual-model-state", refresh === true\)/);
  assert.match(preload, /setVisualModelEnabled: \(enabled\) => ipcRenderer\.invoke\("visual-model-set-enabled", enabled === true\)/);
  assert.match(preload, /installVisualPack: \(\) => ipcRenderer\.invoke\("visual-pack-install"\)/);
  assert.match(preload, /cancelVisualPackInstall: \(\) => ipcRenderer\.invoke\("visual-pack-cancel"\)/);
  assert.match(preload, /removeVisualPack: \(\) => ipcRenderer\.invoke\("visual-pack-remove"\)/);
  assert.match(preload, /onVisualPackProgress: \(callback\) =>[\s\S]*?ipcRenderer\.on\("visual-pack-progress"/);
  assert.doesNotMatch(preload, /openDownloadPage:\s*\([^)]*url/i, "renderer cannot choose an update destination");
  assert.match(main, /MOSA_DOWNLOAD_PAGE_URL/);
  assert.match(main, /ipcMain\.handle\("check-for-updates"/);
  assert.match(main, /ipcMain\.handle\("cancel-update-download"/);
  assert.match(main, /ipcMain\.handle\("renderer-ready"/);
  assert.match(main, /ipcMain\.handle\("download-and-install-update"/);
  assert.match(main, /ipcMain\.handle\("open-download-page"/);
  assert.match(main, /ipcMain\.handle\("open-pinterest-authorize"/);
  assert.match(main, /ipcMain\.handle\("change-library-location"/);
  assert.match(main, /ipcMain\.handle\("visual-model-state"/);
  assert.match(main, /ipcMain\.handle\("visual-model-set-enabled"/);
  assert.match(main, /ipcMain\.handle\("visual-pack-install"/);
  assert.match(main, /ipcMain\.handle\("visual-pack-cancel"/);
  assert.match(main, /ipcMain\.handle\("visual-pack-remove"/);
  // 任务 96（A6）：窗口系统全屏双向同步——渲染层写入通道带主窗口 sender 守卫，
  // enter/leave-full-screen 广播回渲染层。
  assert.match(main, /ipcMain\.handle\("set-window-full-screen"/);
  const windowFullScreenHandler = main.slice(main.indexOf('ipcMain.handle("set-window-full-screen"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("set-window-full-screen"')));
  assert.match(windowFullScreenHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(windowFullScreenHandler, /mainWindow\.setFullScreen\(flag === true\)/);
  assert.match(main, /mainWindow\.on\("enter-full-screen"/);
  assert.match(main, /mainWindow\.on\("leave-full-screen"/);
  assert.equal((main.match(/window-full-screen-change/g) || []).length, 2, "enter/leave-full-screen both broadcast the same channel");
  const relocationHandler = main.slice(main.indexOf('ipcMain.handle("change-library-location"'), main.indexOf('\n\n  // Phase 4C', main.indexOf('ipcMain.handle("change-library-location"')));
  assert.match(relocationHandler, /event\.sender !== mainWindow\.webContents/, "library relocation validates the sender");
  assert.match(relocationHandler, /process\.env\.MOSA_LIBRARY_DIR/, "an explicit environment-managed library cannot be overridden in-app");
  assert.match(relocationHandler, /service\?\.mode !== "owned"/, "attached external runtimes cannot be moved by the desktop shell");
  // Destination inspection (same-dir/nesting/empty-target) and the copy
  // itself (runtime lock skipped, no overwrites, fail-closed cleanup) live in
  // lib/library-relocation.mjs and are pinned behaviorally by
  // test/library-relocation.test.mjs. The handler must still validate before
  // the confirm dialog and keep the copy -> save -> delete ordering.
  assert.match(relocationHandler, /validateRelocationTarget\(\{ currentLibraryDir: libraryDir, nextLibraryDir \}\)/, "the destination must be validated before copying");
  assert.ok(relocationHandler.indexOf("if (!validation.ok) return") > -1
    && relocationHandler.indexOf("if (!validation.ok) return") < relocationHandler.indexOf("await dialog.showMessageBox"),
    "a rejected target aborts before any copy is attempted");
  assert.match(relocationHandler, /await stopOwnedRuntime\(\)/, "SQLite and the runtime lock are closed before migration");
  assert.ok(relocationHandler.indexOf("await copyLibraryForRelocation({") > relocationHandler.indexOf("await stopOwnedRuntime()"),
    "the copy starts only after the runtime stopped");
  assert.ok(relocationHandler.indexOf("saveLibraryDir(nextLibraryDir)") > relocationHandler.indexOf("await copyLibraryForRelocation({"),
    "the persisted location switches only after the copy succeeds");
  assert.ok(relocationHandler.indexOf("await rm(previousLibraryDir") > relocationHandler.indexOf("saveLibraryDir(nextLibraryDir)"),
    "the original library is removed only after a successful copy and preference switch");
  assert.match(main, /ipcMain\.handle\("write-clipboard-text"/);
  const pasteImageHandler = main.slice(main.indexOf('ipcMain.handle("paste-image"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("paste-image"')));
  assert.match(pasteImageHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(main, /event\.sender !== mainWindow\.webContents/);
  assert.match(main, /shell\.openExternal\(MOSA_DOWNLOAD_PAGE_URL\)/);
  assert.match(main, /if \(isolationContext\.qaRun\) return Promise\.resolve\(\{ status: "disabled", currentVersion \}\)/,
    "QA/E2E update checks must stay offline and deterministic");

  // The user-center identity is minted unconditionally at startup: the exact
  // top-level line proves it sits outside every isPackaged/QA/telemetry gate,
  // and its position before app.whenReady() proves it runs before any window.
  assert.match(main, /^const desktopUserId = ensureInstallationId\(\{ userDataDir: desktopDataDir \}\);$/m);
  assert.ok(
    main.indexOf("const desktopUserId = ensureInstallationId({ userDataDir: desktopDataDir })") < main.indexOf("app.whenReady()"),
    "the installation id must be minted before the window lifecycle, outside every packaged/QA/telemetry gate",
  );
  assert.match(main, /ipcMain\.handle\("user-profile"/);
  const userProfileHandler = main.slice(main.indexOf('ipcMain.handle("user-profile"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("user-profile"')));
  assert.match(userProfileHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(userProfileHandler, /return \{ userId: desktopUserId \}/);

  assert.doesNotMatch(preload, /showItemInFolder|show-item-in-folder/);
  assert.doesNotMatch(main, /ipcMain\.handle\("show-item-in-folder"/);

  const clipboardHandler = main.slice(main.indexOf('ipcMain.handle("write-clipboard-text"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("write-clipboard-text"')));
  assert.match(clipboardHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(clipboardHandler, /typeof text !== "string"/);
  assert.match(clipboardHandler, /text\.length > MAX_CLIPBOARD_TEXT_LENGTH/);
  assert.match(clipboardHandler, /clipboard\.writeText\(text\)/);

  const clipboardImageHandler = main.slice(main.indexOf('ipcMain.handle("write-clipboard-image"'), main.indexOf("\n  });", main.indexOf('ipcMain.handle("write-clipboard-image"')));
  assert.match(clipboardImageHandler, /event\.sender !== mainWindow\.webContents/);
  assert.match(clipboardImageHandler, /!isAbsolute\(target\)/);
  assert.match(clipboardImageHandler, /resolveAllowedFolderPath\(target, \[libraryDir\]\)/);
  assert.match(clipboardImageHandler, /nativeImage\.createFromPath\(allowedTarget\)/);
  assert.match(clipboardImageHandler, /clipboard\.writeImage\(image\)/);

  assert.match(main, /minWidth: 960,/);
  assert.match(main, /minHeight: 640,/);
  const manifest = JSON.parse(packageJson);
  assert.equal(sha256(JSON.stringify(manifest.dependencies)), "709481475dca249e75c25f9e0b5e93a685b92cfada8e7e7ab0db8a33653c1843", "package.json dependencies were not changed by this phase");
  assert.equal(sha256(JSON.stringify(manifest.devDependencies)), "11f67ce00f34b4d3dfb9b9ed0dfb428b0368ad5e0a17bd3bafaa40e3c2124fac", "package.json devDependencies were not changed by this phase");
  assertPackageLockMatchesManifest(lockfile, manifest, "package-lock.json must preserve dependency identity");
  assert.doesNotMatch(packageJson, /electron-preload-runtime-contract/);
});

test("packaged preload is present and Forge does not ignore it", async () => {
  const [forge, main] = await Promise.all([read("desktop/forge.config.mjs"), read("desktop/main.mjs")]);
  assert.match(main, /preload\.cjs/);
  assert.doesNotMatch(forge, /preload\.cjs/);
  assert.doesNotMatch(forge, /desktop\/preload/);
});

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function reserveFreePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  assert.ok(port > 0, "a nonzero loopback port is required for runtime isolation");
  return port;
}

async function waitForPort(port, child, getOutput, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const connected = await new Promise((resolvePromise) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolvePromise(true); });
      socket.once("error", () => { socket.destroy(); resolvePromise(false); });
    });
    if (connected) return;
    await wait(100);
  }
  throw new Error(`Electron did not expose CDP before exit=${child.exitCode}\n${getOutput()}`);
}

async function waitForPageTarget(port, child, getOutput, expectedOrigin = "") {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page"
        && target.webSocketDebuggerUrl
        && (!expectedOrigin || String(target.url || "").startsWith(expectedOrigin)));
      if (page) return page;
    } catch {}
    await wait(100);
  }
  throw new Error(`Electron page target was not ready before exit=${child.exitCode}\n${getOutput()}`);
}

async function createCdpClient(webSocketDebuggerUrl) {
  const WebSocketCtor = globalThis.WebSocket;
  assert.equal(typeof WebSocketCtor, "function", "Node must provide WebSocket for the real CDP smoke test");
  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener("open", resolvePromise, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve: resolvePromise, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolvePromise(message.result);
      return;
    }
    for (const listener of listeners.get(message.method) || []) listener(message.params || {});
  });
  return {
    on(method, listener) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(listener);
    },
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolvePromise, reject) => {
        pending.set(id, { resolve: resolvePromise, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const { reject } of pending.values()) reject(new Error("CDP closed"));
      pending.clear();
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Renderer evaluation failed";
    throw new Error(description);
  }
  return result?.result?.value;
}

async function waitForRendererValue(client, expression, predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(client, expression);
    if (predicate(value)) return value;
    await wait(100);
  }
  return evaluate(client, expression);
}

function isKnownCdpSandboxStartupNoise(issue) {
  const text = JSON.stringify(issue);
  return text.includes("node:electron/js2c/sandbox_bundle")
    && text.includes("binding.startupData")
    && text.includes("preloadScripts");
}

test("real Electron preload smoke (opt-in)", { skip: process.env.MOSA_ELECTRON_PRELOAD_SMOKE !== "1" }, async (t) => {
  const libraryDir = await mkdtemp(join(tmpdir(), "mosa-preload-smoke-library-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-preload-smoke-user-data-"));
  const assetsDir = join(libraryDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  const fixturePath = join(assetsDir, "preload-smoke.png");
  await writeFile(fixturePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));

  const [cdpPort, desktopPort] = await Promise.all([reserveFreePort(), reserveFreePort()]);
  const child = spawn(electronPath, [`--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userDataDir}`, root], {
    cwd: root,
    env: {
      ...process.env,
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_USER_DATA: userDataDir,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_DESKTOP_PORT: String(desktopPort),
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
      child.kill("SIGTERM");
      await Promise.race([exited, wait(2000)]);
      if (child.exitCode === null) {
        const forcedExit = new Promise((resolveExit) => child.once("exit", resolveExit));
        child.kill("SIGKILL");
        await Promise.race([forcedExit, wait(2000)]);
      }
    }
    await rm(libraryDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });

  const output = () => `stdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`;
  await waitForPort(cdpPort, child, output);
  const expectedOrigin = `http://127.0.0.1:${desktopPort}`;
  const target = await waitForPageTarget(cdpPort, child, output, expectedOrigin);
  const client = await createCdpClient(target.webSocketDebuggerUrl);
  t.after(() => client.close());
  const rendererIssues = [];
  client.on("Runtime.consoleAPICalled", (params) => {
    if (["error", "assert"].includes(params.type)) rendererIssues.push(params);
  });
  client.on("Runtime.exceptionThrown", (params) => rendererIssues.push(params));
  await client.send("Runtime.enable");
  const state = JSON.parse(await waitForRendererValue(client, `(() => {
    let clientToken = '';
    try { clientToken = String(window.sessionStorage?.getItem?.('mosa.client-token') || ''); } catch {}
    return JSON.stringify({
      href: location.href,
      hasElectronAPI: Boolean(window.electronAPI),
      keys: window.electronAPI ? Object.keys(window.electronAPI).sort() : [],
      functionKeys: window.electronAPI ? Object.keys(window.electronAPI).filter((key) => typeof window.electronAPI[key] === "function").sort() : [],
      finderButtons: document.querySelectorAll('[data-action="show-in-finder"]').length,
      webLinks: document.querySelectorAll('a.original-media-link').length,
      clientToken,
    });
  })()`, (value) => {
    try {
      const ready = JSON.parse(value);
      return String(ready.href || "").startsWith(expectedOrigin)
        && ready.hasElectronAPI === true
        && Boolean(ready.clientToken);
    } catch {
      return false;
    }
  }, 20_000));
  assert.match(state.href, /^http:\/\/127\.0\.0\.1:/, "the real app URL finished loading");
  assert.equal(state.hasElectronAPI, true);
  assert.deepEqual(state.keys, EXPECTED_API_KEYS);
  assert.deepEqual(state.functionKeys, EXPECTED_API_KEYS);
  assert.deepEqual(state.keys, EXPECTED_API_KEYS);
  assert.equal((stderr.match(/\[MOSA\] preload-error/g) || []).length, 0, output());
  assert.doesNotMatch(stderr, /preload.*(error|failed|syntaxerror|ENOENT)/i, output());
  const preloadIssues = rendererIssues.filter((issue) => /preload/i.test(JSON.stringify(issue)) && !isKnownCdpSandboxStartupNoise(issue));
  assert.equal(preloadIssues.length, 0, JSON.stringify(rendererIssues));

  const origin = new URL(state.href).origin;
  assert.equal(new URL(state.href).hash.includes("mosa-client-token="), false,
    "the desktop renderer consumes the runtime capability out of the visible URL fragment");
  const clientToken = state.clientToken;
  assert.ok(clientToken, "the desktop renderer retains the runtime client capability in session storage");
  const createResponse = await fetch(`${origin}/api/assets/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mosa-client-token": clientToken,
    },
    body: JSON.stringify({ projectId: "default", imagePath: fixturePath, prompt: "preload smoke fixture" }),
  });
  assert.equal(createResponse.status, 200, await createResponse.text());
  const cardReady = await waitForRendererValue(client, `document.querySelectorAll('.asset-card').length`, (value) => Number(value) > 0);
  assert.equal(Number(cardReady) > 0, true, "the created asset arrives through the live library refresh path");
  await evaluate(client, `document.querySelector('.asset-card')?.click(); true`);
  const actionState = JSON.parse(await waitForRendererValue(client, `JSON.stringify({
    finderButtons: document.querySelectorAll('[data-action="show-in-finder"]').length,
    webLinks: document.querySelectorAll('a.original-media-link').length,
    pathBars: document.querySelectorAll('.details .library-location').length,
  })`, (value) => {
    try { return JSON.parse(value).pathBars > 0; } catch { return false; }
  }));
  // The path bar rendering proves the React inspector mounted (the asset's
  // real library path lives in the details pane's .library-location bar). The
  // contract test above validates every narrow IPC handler and sender/path
  // guard. This real smoke intentionally stops at preload injection +
  // inspector rendering so CI never invokes Finder or mutates the host
  // clipboard as a side effect of a test run.
  assert.equal(actionState.finderButtons, 0);
  assert.equal(actionState.webLinks, 0);
  assert.equal(actionState.pathBars > 0, true);
});
