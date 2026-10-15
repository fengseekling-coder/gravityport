#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const forgeOutDir = resolve(rootDir, process.env.MOSA_FORGE_OUT_DIR || "out");
const binary = packagedExecutablePath({ rootDir, outDir: forgeOutDir });
const ELECTRON_QA_FLAGS = process.platform === "win32" ? ["--disable-gpu"] : [];

if (!existsSync(binary)) throw new Error(`Missing packaged binary: ${binary}`);

const temp = await mkdtemp(join(tmpdir(), "mosa-smoke-"));
const libraryDir = join(temp, "library");
const userData = join(temp, "user-data");
await mkdir(libraryDir, { recursive: true });
await mkdir(userData, { recursive: true });
const expectedIdentity = JSON.parse(await readFile(resolve(rootDir, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
let activeLaunch = null;

try {
  activeLaunch = await launchPackaged({ libraryDir, userData });
  const firstHealth = await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  const renderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  if (!renderer.appShell) throw new Error("Packaged renderer did not mount the MOSA app shell.");
  if (!renderer.preload) throw new Error("Packaged renderer did not expose the Electron preload API.");
  if (!renderer.clientToken) throw new Error("Packaged renderer did not retain the MOSA client capability.");
  await verifyPackagedReadOnlyPointerInput(activeLaunch.origin, activeLaunch.cdpPort);
  console.log("PACKAGED_READ_ONLY_CDP_POINTER_PASS");
  assertPackagedHealth(firstHealth, { libraryDir, expectedIdentity });
  const importedAssetId = await verifyPackagedImport(activeLaunch.origin, renderer.clientToken);
  await verifyPackagedCdpPointerInput(activeLaunch.origin, activeLaunch.cdpPort, importedAssetId);
  console.log("PACKAGED_CDP_POINTER_INPUT_PASS");
  assertPackagedWindowChrome(renderer);

  await stopChild(activeLaunch.child);
  activeLaunch = null;

  activeLaunch = await launchPackaged({ libraryDir, userData });
  const restartHealth = await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  assertPackagedHealth(restartHealth, { libraryDir, expectedIdentity });
  const restartRenderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  if (!restartRenderer.appShell || !restartRenderer.preload) {
    throw new Error("Packaged renderer/preload did not recover after restart.");
  }
  assertPackagedWindowChrome(restartRenderer);
  await verifyPersistedAsset(activeLaunch.origin, importedAssetId);

  console.log(JSON.stringify({
    ok: true,
    storage: restartHealth.storage,
    renderer: true,
    preload: true,
    nativeChrome: true,
    cdpPointerInput: true,
    import: true,
    restartPersistence: true,
  }));
} catch (error) {
  const details = activeLaunch
    ? [activeLaunch.stderr().trim(), activeLaunch.stdout().trim()].filter(Boolean).join("\n")
    : "";
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`, { cause: error });
} finally {
  if (activeLaunch) await stopChild(activeLaunch.child);
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function launchPackaged({ libraryDir: isolatedLibraryDir, userData: isolatedUserData }) {
  const port = await freePort();
  const cdpPort = await freePort();
  const child = spawn(binary, [...ELECTRON_QA_FLAGS, `--user-data-dir=${isolatedUserData}`, `--remote-debugging-port=${cdpPort}`], {
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_LIBRARY_DIR: isolatedLibraryDir,
      MOSA_DESKTOP_PORT: String(port),
      MOSA_USER_DATA: isolatedUserData,
      MOSA_QA_RUN: "1",
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    child,
    cdpPort,
    origin: `http://127.0.0.1:${port}`,
    stdout: collect(child.stdout),
    stderr: collect(child.stderr),
  };
}

function assertPackagedHealth(health, { libraryDir: isolatedLibraryDir, expectedIdentity: identity }) {
  if (health.product !== "mosa") throw new Error("Unexpected packaged product.");
  if (resolve(health.libraryDir) !== resolve(isolatedLibraryDir)) throw new Error("Library isolation failed.");
  if (health.storage !== "sqlite") throw new Error(`Expected sqlite, got ${health.storage}`);
  if (health.gitSha !== identity.gitSha || health.uiFingerprint !== identity.uiFingerprint) {
    throw new Error("Packaged build identity does not match the current source build.");
  }
}

function assertPackagedWindowChrome(renderer) {
  const { chrome } = renderer;
  if (!chrome?.nativeDesktop || chrome.mockTrafficLights !== 0) {
    throw new Error(`Packaged desktop must not render decorative traffic lights: ${JSON.stringify(chrome)}`);
  }
  if (chrome.nativeMacOS !== (process.platform === "darwin")) {
    throw new Error(`Native macOS class does not match the packaged OS: ${JSON.stringify(chrome)}`);
  }
  for (const name of ["brandbarHeight", "toolbarHeight"]) {
    if (chrome[name] !== 56) throw new Error(`Native top-row ${name} must be 56px, got ${chrome[name]}`);
  }
  // An empty isolated Library legitimately renders no inspector. Its header
  // height is asserted after the smoke fixture has appeared in the gallery.
  if (chrome.detailHeadingHeight !== 0 && chrome.detailHeadingHeight !== 56) {
    throw new Error(`Native detail heading must be 56px when visible, got ${chrome.detailHeadingHeight}`);
  }
  if (chrome.firstNavTop < chrome.brandbarHeight) {
    throw new Error(`Sidebar navigation overlaps the titlebar: ${JSON.stringify(chrome)}`);
  }
  // Native buttons end near x=75 (trafficLightPosition 16,18); the title is
  // right-aligned with the nav counts and never starts before x=85.
  if (process.platform === "darwin" && chrome.brandTitleLeft < 80) {
    throw new Error(`GravityPort title overlaps native macOS controls: ${JSON.stringify(chrome)}`);
  }
}

// A strictly read-only old/new-bundle diagnostic. It runs before the mandatory
// identity gate, so even a legacy package can establish whether Chromium
// dispatches mouse events to React without ever passing the packaged smoke.
async function verifyPackagedReadOnlyPointerInput(origin, cdpPort) {
  const socket = await connectRenderer(origin, cdpPort);
  try {
    // Base-navigation order is stable across locales: All, Pinterest, Inbox,
    // Favorites, Trash. Avoid localized labels in Windows CI.
    await clickElement(socket, '.sidebar .main-nav > .nav-row:nth-child(4)');
    await waitForDom(socket, `document.querySelector('.sidebar .main-nav > .nav-row:nth-child(4)')?.getAttribute('aria-current') === 'page'`, "favorites navigation");
    await clickElement(socket, '.sidebar .main-nav > .nav-row:first-child');
    await waitForDom(socket, `document.querySelector('.sidebar .main-nav > .nav-row:first-child')?.getAttribute('aria-current') === 'page'`, "all-assets navigation");
    await clickElement(socket, '.sidebar .user-button');
    await waitForDom(socket, `Boolean(document.querySelector('.settings-modal'))`, "settings opening");
    await clickElement(socket, '.settings-modal .modal-close');
    await waitForDom(socket, `!document.querySelector('.settings-modal')`, "settings closing");
  } finally {
    socket.close();
  }
}

// CDP emits real Chromium pointer input through hit-testing and React events,
// unlike element.click(). It is NOT physical macOS mouse input: that remains a
// separate manual acceptance requirement on an accessible desktop session.
async function verifyPackagedCdpPointerInput(origin, cdpPort, importedAssetId) {
  const socket = await connectRenderer(origin, cdpPort);
  try {
    await evaluate(socket, `(() => {
      window.__mosaPointerSmoke = { downs: 0, clicks: 0, contexts: 0 };
      window.addEventListener('pointerdown', () => window.__mosaPointerSmoke.downs++, true);
      window.addEventListener('click', () => window.__mosaPointerSmoke.clicks++, true);
      window.addEventListener('contextmenu', () => window.__mosaPointerSmoke.contexts++, true);
      return true;
    })()`);
    await clickElement(socket, '.sidebar .main-nav > .nav-row:nth-child(4)');
    await waitForDom(socket, `document.querySelector('.sidebar .main-nav > .nav-row:nth-child(4)')?.getAttribute('aria-current') === 'page'`, "sidebar favorites click");
    await clickElement(socket, '.sidebar .main-nav > .nav-row:first-child');
    await waitForDom(socket, `document.querySelector('.sidebar .main-nav > .nav-row:first-child')?.getAttribute('aria-current') === 'page'`, "sidebar all-assets click");

    await clickElement(socket, '.sidebar .user-button');
    await waitForDom(socket, `Boolean(document.querySelector('.settings-modal'))`, "settings click");
    await clickElement(socket, '.settings-modal .modal-close');
    await waitForDom(socket, `!document.querySelector('.settings-modal')`, "settings close");

    await waitForDom(socket, `Array.from(document.querySelectorAll('.asset-card')).some(card => card.dataset.assetId === ${JSON.stringify(importedAssetId)})`, "imported asset card");
    await waitForDom(socket, `Math.round(document.querySelector('.detail-heading')?.getBoundingClientRect().height || 0) === 56`, "56px detail heading");
    await clickElement(socket, '.asset-card', "left", 2);
    await waitForDom(socket, `Boolean(document.querySelector('.workspace.preview-open'))`, "asset double-click preview");
    await clickElement(socket, '.toolbar-left button');
    await waitForDom(socket, `!document.querySelector('.workspace.preview-open')`, "preview back click");

    await clickElement(socket, '.asset-card', "right");
    await waitForDom(socket, `Boolean(document.querySelector('.context-menu'))`, "asset right-click context menu");
    await clickElement(socket, '.sidebar .main-nav > .nav-row:first-child');
    await waitForDom(socket, `!document.querySelector('.context-menu')`, "context-menu dismissal");

    await clickElement(socket, '.search input');
    await waitForDom(socket, `document.activeElement === document.querySelector('.search input')`, "search focus");
    await sendCdp(socket, "Input.insertText", { text: "mosa-pointer-smoke" });
    await waitForDom(socket, `document.querySelector('.search input')?.value === 'mosa-pointer-smoke'`, "search typing");
    const counters = await evaluate(socket, "window.__mosaPointerSmoke");
    if (counters?.downs < 8 || counters?.clicks < 8 || counters?.contexts < 1) {
      throw new Error(`Pointer event chain did not reach the Renderer DOM: ${JSON.stringify(counters)}`);
    }
  } finally {
    socket.close();
  }
}

async function clickElement(socket, selector, button = "left", clickCount = 1) {
  const point = await evaluate(socket, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { error: 'missing target' };
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    return { x, y, hit: element.contains(document.elementFromPoint(x, y)), width: rect.width, height: rect.height };
  })()`);
  if (!point || !point.hit || point.width <= 0 || point.height <= 0) {
    throw new Error(`CDP target obscured/unhittable ${selector}: ${JSON.stringify(point)}`);
  }
  await sendCdp(socket, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  for (let count = 1; count <= clickCount; count += 1) {
    await sendCdp(socket, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button, buttons: button === "right" ? 2 : 1, clickCount: count });
    await sendCdp(socket, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button, buttons: 0, clickCount: count });
  }
}

async function waitForDom(socket, expression, label, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await evaluate(socket, expression)) return;
    await sleep(100);
  }
  throw new Error(`Packaged CDP pointer input did not activate ${label}`);
}

async function verifyPackagedImport(origin, clientToken) {
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
  const stageResponse = await fetch(`${origin}/api/import/stage`, {
    method: "POST",
    headers: {
      "content-type": "image/png",
      "x-mosa-file-name": encodeURIComponent("packaged-smoke.png"),
      "x-mosa-client-token": clientToken,
    },
    body: bytes,
  });
  if (!stageResponse.ok) throw new Error(`Packaged import staging failed (${stageResponse.status}).`);
  const staged = await stageResponse.json();
  const createResponse = await fetch(`${origin}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mosa-client-token": clientToken },
    body: JSON.stringify({ projectId: "default", imagePath: staged.path, prompt: "packaged smoke import" }),
  });
  if (!createResponse.ok) throw new Error(`Packaged asset creation failed (${createResponse.status}).`);
  const created = await createResponse.json();
  const assetId = created.asset?.id;
  if (!assetId) throw new Error("Packaged asset creation returned no asset id.");
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const assetResponse = await fetch(`${origin}/api/assets/default/${encodeURIComponent(assetId)}`);
    if (assetResponse.ok) {
      const asset = (await assetResponse.json()).asset;
      if (asset?.thumbnail_url) {
        const thumbnail = await fetch(`${origin}${asset.thumbnail_url}`);
        if (thumbnail.ok && String(thumbnail.headers.get("content-type") || "").startsWith("image/")) return assetId;
      }
    }
    await sleep(100);
  }
  throw new Error("Packaged derivative generation did not produce a readable thumbnail.");
}

async function verifyPersistedAsset(origin, assetId) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const response = await fetch(`${origin}/api/assets/default/${encodeURIComponent(assetId)}`);
    if (response.ok) {
      const asset = (await response.json()).asset;
      if (asset?.id === assetId && asset?.prompt === "packaged smoke import" && asset.thumbnail_url) {
        const thumbnail = await fetch(`${origin}${asset.thumbnail_url}`);
        if (thumbnail.ok && String(thumbnail.headers.get("content-type") || "").startsWith("image/")) return true;
      }
    }
    await sleep(100);
  }
  throw new Error("Packaged asset was not readable after application restart.");
}

function freePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(url, childProcess) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited early.");
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("Packaged app health timeout.");
}

async function waitForRenderer(expectedOrigin, cdpPort, childProcess) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    if (childProcess.exitCode !== null) throw new Error("Packaged app exited before the renderer was ready.");
    let socket = null;
    try {
      socket = await connectRenderer(expectedOrigin, cdpPort);
      const result = await evaluate(socket, `({
        href: location.href,
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
        clientToken: String(window.sessionStorage?.getItem?.('mosa.client-token') || ''),
        chrome: (() => {
          const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
          return {
            nativeDesktop: document.querySelector('.app')?.classList.contains('native-desktop'),
            nativeMacOS: document.querySelector('.app')?.classList.contains('native-darwin'),
            mockTrafficLights: document.querySelectorAll('.sidebar .traffic i').length,
            brandbarHeight: Math.round(rect('.brandbar')?.height || 0),
            toolbarHeight: Math.round(rect('.toolbar')?.height || 0),
            detailHeadingHeight: Math.round(rect('.detail-heading')?.height || 0),
            brandTitleLeft: Math.round(rect('.brandbar strong')?.left || 0),
            firstNavTop: Math.round(rect('.main-nav')?.top || 0),
          };
        })()
      })`);
      if (result?.appShell && result?.preload && result?.clientToken && result.readyState !== "loading") return result;
    } catch {
      // The renderer and CDP endpoint become available a little after the
      // runtime health endpoint. Keep polling until both are genuinely ready.
    } finally {
      socket?.close();
    }
    await sleep(100);
  }
  throw new Error("Packaged renderer readiness timeout.");
}

async function connectRenderer(expectedOrigin, cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
  if (!response.ok) throw new Error("CDP target list unavailable.");
  const targets = await response.json();
  const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedOrigin));
  if (!target?.webSocketDebuggerUrl) throw new Error("MOSA renderer target not ready.");
  return openWebSocket(target.webSocketDebuggerUrl);
}

function openWebSocket(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolveSocket(socket), { once: true });
    socket.addEventListener("error", () => rejectSocket(new Error("CDP websocket failed to open.")), { once: true });
  });
}

function sendCdp(socket, method, params) {
  return new Promise((resolveCommand, rejectCommand) => {
    const id = 1;
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error) {
        rejectCommand(new Error(message.error.message || `CDP ${method} failed.`));
        return;
      }
      resolveCommand(message.result);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(socket, expression) {
  const result = await sendCdp(socket, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Renderer evaluation failed.");
  }
  return result?.result?.value;
}

async function stopChild(childProcess) {
  if (childProcess.exitCode !== null || childProcess.signalCode) return;
  const exited = onceExit(childProcess);
  await signalProcessTree(childProcess.pid);
  if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])) return;
  if (childProcess.exitCode === null && !childProcess.signalCode) {
    await signalProcessTree(childProcess.pid, { force: true });
  }
  await Promise.race([exited, sleep(5000)]);
}

function onceExit(childProcess) {
  return new Promise((resolveExit) => childProcess.once("exit", resolveExit));
}

function collect(stream) {
  let value = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => { value += chunk; });
  return () => value;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
