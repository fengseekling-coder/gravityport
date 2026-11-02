#!/usr/bin/env node
import "../lib/apply-env-aliases.mjs";

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";
import { QUIET_QA_MARKER_FILENAME } from "../desktop/quiet-qa-screen.mjs";
import { launchServicesApplicationType, launchServicesFrontAsn, QuietWatchdog } from "./packaged-quiet-watchdog.mjs";
import { buildMcpClientConfig } from "../lib/mcp-client-config.mjs";
import { copyLibraryForRelocation } from "../lib/library-relocation.mjs";
import { libraryDigest, readLibraryId } from "../lib/library-identity.mjs";

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
// Task 346: the packaged smoke must run quiet (no visible window, no Dock
// icon, no focus steal). The launcher writes the token marker that the
// packaged quiet gate (desktop/quiet-qa-screen.mjs) reads at startup, and
// passes the matching switch on every launch below.
const quietToken = randomBytes(16).toString("hex");
await writeFile(join(userData, QUIET_QA_MARKER_FILENAME), `${JSON.stringify({ token: quietToken })}\n`);
const watchdog = new QuietWatchdog({ intervalMs: 500, log: (line) => console.log(line) });
const expectedIdentity = JSON.parse(await readFile(resolve(rootDir, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
let activeLaunch = null;

try {
  if (process.platform === "darwin") {
    await watchdog.compile();
    console.log(`QUIET_WATCHDOG_INITIAL_FRONT ${JSON.stringify(launchServicesFrontAsn())}`);
  }

  activeLaunch = await launchPackaged({ libraryDir, userData });
  watchdog.track(activeLaunch.child.pid, "packaged-smoke-launch-1");
  const firstHealth = await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  const renderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  assertQuietEvidence(activeLaunch, "launch 1");
  assertNotForegroundType(activeLaunch.child.pid, "launch 1");
  if (!renderer.appShell) throw new Error("Packaged renderer did not mount the MOSA app shell.");
  if (!renderer.preload) throw new Error("Packaged renderer did not expose the Electron preload API.");
  if (!renderer.clientToken) throw new Error("Packaged renderer did not retain the MOSA client capability.");
  await verifyPackagedReadOnlyPointerInput(activeLaunch.origin, activeLaunch.cdpPort);
  console.log("PACKAGED_READ_ONLY_CDP_POINTER_PASS");
  await assertPackagedHealth(firstHealth, { libraryDir, expectedIdentity });
  const importedAssetId = await verifyPackagedImport(activeLaunch.origin, renderer.clientToken);
  await verifyPackagedCdpPointerInput(activeLaunch.origin, activeLaunch.cdpPort, importedAssetId);
  console.log("PACKAGED_CDP_POINTER_INPUT_PASS");
  assertPackagedWindowChrome(renderer);

  await stopChild(activeLaunch.child);
  activeLaunch = null;

  activeLaunch = await launchPackaged({ libraryDir, userData });
  watchdog.track(activeLaunch.child.pid, "packaged-smoke-launch-2");
  const restartHealth = await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  await assertPackagedHealth(restartHealth, { libraryDir, expectedIdentity });
  const restartRenderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  assertQuietEvidence(activeLaunch, "launch 2");
  assertNotForegroundType(activeLaunch.child.pid, "launch 2");
  if (!restartRenderer.appShell || !restartRenderer.preload) {
    throw new Error("Packaged renderer/preload did not recover after restart.");
  }
  assertPackagedWindowChrome(restartRenderer);
  await verifyPersistedAsset(activeLaunch.origin, importedAssetId, renderer.clientToken);
  const mcpConfig = await readPackagedMcpConfig(activeLaunch.origin, activeLaunch.cdpPort);
  await stopChild(activeLaunch.child);
  activeLaunch = null;
  await verifyBundledMcp({ mcpConfig, importedAssetId });
  console.log("PACKAGED_BUNDLED_MCP_PASS");

  // Task 346 reverse checks, still under the watchdog: the gate must reject a
  // quiet attempt whose marker is missing or carries a different token, by
  // exiting non-zero before any window or write. A launch WITHOUT the switch
  // is deliberately never tested here — it would really show a window.
  await verifyQuietGateRejections({ watchdog, quietToken });
  console.log("PACKAGED_QUIET_GATE_REVERSE_PASS");

  watchdog.assertClean();
  console.log(JSON.stringify({
    ok: true,
    storage: restartHealth.storage,
    renderer: true,
    preload: true,
    nativeChrome: true,
    cdpPointerInput: true,
    import: true,
    restartPersistence: true,
    bundledMcp: true,
    quietWatchdog: watchdog.summary(),
  }));
} catch (error) {
  const details = activeLaunch
    ? [activeLaunch.stderr().trim(), activeLaunch.stdout().trim()].filter(Boolean).join("\n")
    : "";
  throw new Error(`${error instanceof Error ? error.message : String(error)}${details ? `\n${details}` : ""}`, { cause: error });
} finally {
  if (activeLaunch) await stopChild(activeLaunch.child);
  await watchdog.stop();
  console.log(`QUIET_WATCHDOG_SUMMARY ${JSON.stringify(watchdog.summary())}`);
  await rm(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

async function launchPackaged({ libraryDir: isolatedLibraryDir, userData: isolatedUserData }) {
  const port = await freePort();
  const cdpPort = await freePort();
  const child = spawn(binary, [...ELECTRON_QA_FLAGS, `--user-data-dir=${isolatedUserData}`, `--remote-debugging-port=${cdpPort}`, `--gravityport-qa-quiet=${quietToken}`], {
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

// Task 346: positive quiet evidence straight from the app's own stderr. The
// matched lines are echoed so the smoke log carries the proof it asserts.
function assertQuietEvidence(launch, label) {
  const stderrText = launch.stderr();
  const quietLine = stderrText.split("\n").find((line) => line.includes("QA_QUIET: packaged on"));
  const showWindowLine = stderrText.split("\n").find((line) => line.includes("QA_UI_SUPPRESSED: showWindow"));
  if (!quietLine) {
    throw new Error(`[${label}] packaged quiet stderr evidence missing "QA_QUIET: packaged on".`);
  }
  if (!showWindowLine) {
    throw new Error(`[${label}] packaged quiet stderr evidence missing "QA_UI_SUPPRESSED: showWindow".`);
  }
  console.log(`QUIET_EVIDENCE ${label}: ${quietLine.trim()}`);
  console.log(`QUIET_EVIDENCE ${label}: ${showWindowLine.trim()}`);
}

// Corroborating per-launch Launch Services view; the per-sample activation
// policy inside the watchdog stays authoritative.
function assertNotForegroundType(pid, label) {
  const appType = launchServicesApplicationType(pid);
  console.log(`QUIET_WATCHDOG_LAUNCH_SERVICES_TYPE ${label} pid=${pid} type=${JSON.stringify(appType)}`);
  if (appType === "Foreground") {
    throw new Error(`[${label}] the app under test registered as a foreground-type app (ApplicationType=Foreground).`);
  }
}

// Reverse quiet-gate checks: the switch present but the marker missing, or
// the marker carrying a different token. The app must reject the startup
// (non-zero exit, QA_STARTUP_FAILED on stderr) inside 30 seconds.
async function verifyQuietGateRejections({ watchdog, quietToken }) {
  const wrongToken = quietToken.slice(0, 31) + (quietToken.endsWith("a") ? "b" : "a");
  const cases = [
    { label: "marker-missing", markerToken: null },
    { label: "token-mismatch", markerToken: wrongToken },
  ];
  for (const testCase of cases) {
    const reverseUserData = join(temp, `quiet-gate-reverse-${testCase.label}`, "user-data");
    const reverseLibrary = join(temp, `quiet-gate-reverse-${testCase.label}`, "library");
    await mkdir(reverseUserData, { recursive: true });
    await mkdir(reverseLibrary, { recursive: true });
    if (testCase.markerToken) {
      await writeFile(join(reverseUserData, QUIET_QA_MARKER_FILENAME), `${JSON.stringify({ token: testCase.markerToken })}\n`);
    }
    const port = await freePort();
    const child = spawn(binary, [...ELECTRON_QA_FLAGS, `--user-data-dir=${reverseUserData}`, `--gravityport-qa-quiet=${quietToken}`], {
      env: {
        ...process.env,
        MOSA_RUNTIME_MODE: "qa",
        MOSA_LIBRARY_DIR: reverseLibrary,
        MOSA_DESKTOP_PORT: String(port),
        MOSA_USER_DATA: reverseUserData,
        MOSA_QA_RUN: "1",
        MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    watchdog.track(child.pid, `quiet-gate-reverse-${testCase.label}`);
    const stderrText = collect(child.stderr);
    const outcome = await Promise.race([
      onceExit(child).then(() => ({ code: child.exitCode })),
      sleep(30000).then(() => ({ code: "timeout" })),
    ]);
    if (outcome.code === "timeout") {
      await signalProcessTree(child.pid, { force: true });
      throw new Error(`Quiet gate reverse case ${testCase.label} did not exit within 30s.`);
    }
    if (outcome.code === 0) {
      throw new Error(`Quiet gate reverse case ${testCase.label} exited 0 instead of failing its gate.`);
    }
    const stderr = stderrText();
    if (!stderr.includes(`QA_STARTUP_FAILED: packaged-quiet-gate ${testCase.label}`)) {
      throw new Error(`Quiet gate reverse case ${testCase.label} stderr missed its QA_STARTUP_FAILED reason. stderr: ${stderr.slice(0, 800)}`);
    }
    console.log(`QUIET_GATE_REVERSE ${testCase.label} exit=${outcome.code}`);
  }
}

async function assertPackagedHealth(health, { libraryDir: isolatedLibraryDir, expectedIdentity: identity }) {
  if (health.product !== "mosa") throw new Error("Unexpected packaged product.");
  // Task 314: health publishes a library digest instead of the path.
  if ("libraryDir" in health) throw new Error("Health must not publish the library path.");
  const expectedDigest = libraryDigest(await readLibraryId(isolatedLibraryDir), isolatedLibraryDir);
  if (!expectedDigest || health.libraryDigest !== expectedDigest) throw new Error("Library isolation failed.");
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
    // The close button moves while the modal animates in; a click aimed
    // mid-animation can land where the button no longer is.
    await waitForDom(socket, `document.querySelector('.modal-layer')?.getAnimations({ subtree: true }).every((animation) => animation.playState !== 'running')`, "settings open animation");
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
    // Task 314: reads require the client capability too, so node-side fetches
    // present the same header the renderer holds.
    const assetResponse = await fetch(`${origin}/api/assets/default/${encodeURIComponent(assetId)}`, {
      headers: { "x-mosa-client-token": clientToken },
    });
    if (assetResponse.ok) {
      const asset = (await assetResponse.json()).asset;
      if (asset?.thumbnail_url) {
        const thumbnail = await fetch(`${origin}${asset.thumbnail_url}`, {
          headers: { "x-mosa-client-token": clientToken },
        });
        if (thumbnail.ok && String(thumbnail.headers.get("content-type") || "").startsWith("image/")) return assetId;
      }
    }
    await sleep(100);
  }
  throw new Error("Packaged derivative generation did not produce a readable thumbnail.");
}

async function verifyPersistedAsset(origin, assetId, clientToken) {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const response = await fetch(`${origin}/api/assets/default/${encodeURIComponent(assetId)}`, {
      headers: { "x-mosa-client-token": clientToken },
    });
    if (response.ok) {
      const asset = (await response.json()).asset;
      if (asset?.id === assetId && asset?.prompt === "packaged smoke import" && asset.thumbnail_url) {
        const thumbnail = await fetch(`${origin}${asset.thumbnail_url}`, {
          headers: { "x-mosa-client-token": clientToken },
        });
        if (thumbnail.ok && String(thumbnail.headers.get("content-type") || "").startsWith("image/")) return true;
      }
    }
    await sleep(100);
  }
  throw new Error("Packaged asset was not readable after application restart.");
}

// Settings → 连接 hands AI clients this config. It must point at the package
// under test, and running it exactly as written must reach the library.
async function readPackagedMcpConfig(origin, cdpPort) {
  const socket = await connectRenderer(origin, cdpPort);
  try {
    const config = await evaluate(socket, "window.electronAPI.getMcpClientConfig()");
    if (!config?.available) throw new Error("Packaged app did not offer an MCP client config.");
    if (await realpath(config.command) !== await realpath(binary)) {
      throw new Error(`MCP config command is not the packaged executable: ${config.command}`);
    }
    const serverPath = config.args?.[0] || "";
    const expectedServerSuffix = ["app.asar", "mcp", "server.mjs"].join(sep);
    if (config.args?.length !== 1 || !serverPath.endsWith(expectedServerSuffix) || !serverPath.startsWith(forgeOutDir)) {
      throw new Error(`MCP config does not run the packaged server: ${JSON.stringify(config.args)}`);
    }
    if (config.env?.ELECTRON_RUN_AS_NODE !== "1") throw new Error("MCP config must run the executable in Node mode.");
    // The smoke launch pins MOSA_LIBRARY_DIR, so the config names that library
    // directly, under its GravityPort name.
    if (resolve(config.env.GRAVITYPORT_LIBRARY_DIR || "") !== resolve(libraryDir)) {
      throw new Error(`MCP config names the wrong library: ${JSON.stringify(config.env)}`);
    }
    return config;
  } finally {
    socket.close();
  }
}

async function verifyBundledMcp({ mcpConfig, importedAssetId }) {
  const home = join(temp, "mcp-home");
  await mkdir(home, { recursive: true });
  const search = async (config) => {
    const server = startMcpClientProcess(config, home);
    try {
      const init = await server.request("initialize", { protocolVersion: "2025-11-25" });
      if (init.result?.serverInfo?.name !== "GravityPort MCP") throw new Error(`Bundled MCP did not initialize: ${JSON.stringify(init)}`);
      const tools = await server.request("tools/list");
      if (!tools.result?.tools?.some((tool) => tool.name === "asset_search")) throw new Error("Bundled MCP does not list asset_search.");
      const found = await server.request("tools/call", { name: "asset_search", arguments: { query: "packaged smoke import" } });
      const ids = (found.result?.structuredContent?.results || []).map((entry) => entry.asset?.id ?? entry.id);
      if (!ids.includes(importedAssetId)) throw new Error(`Bundled MCP asset_search missed the imported asset: ${JSON.stringify(found)}`);
    } catch (error) {
      throw new Error(`${error.message}\n${server.stderr()}`, { cause: error });
    } finally {
      await server.stop();
    }
  };

  await search(mcpConfig);

  // A user who moved the library: the desktop copies it and records the new
  // place in library-location.json, which the default config follows.
  const movedLibraryDir = join(temp, "moved", "Art Library");
  await mkdir(movedLibraryDir, { recursive: true });
  await copyLibraryForRelocation({ sourceLibraryDir: libraryDir, destinationLibraryDir: movedLibraryDir });
  const locationFile = join(temp, "moved-user-data", "library-location.json");
  await mkdir(join(temp, "moved-user-data"), { recursive: true });
  await writeFile(locationFile, `${JSON.stringify({ path: movedLibraryDir })}\n`);
  await rm(libraryDir, { recursive: true, force: true });
  await search(buildMcpClientConfig({
    platform: process.platform,
    execPath: mcpConfig.command,
    serverPath: mcpConfig.args[0],
    libraryLocationFile: locationFile,
  }));
}

// Spawns the server the way an MCP client does: the configured command, args
// and env on top of a minimal system environment, from an unrelated directory.
function startMcpClientProcess(config, home) {
  const systemEnv = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]));
  const child = spawn(config.command, config.args, {
    cwd: home,
    env: { ...systemEnv, HOME: home, USERPROFILE: home, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = collect(child.stderr);
  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      responses.set(message.id, message);
    }
  });
  let nextId = 1;
  return {
    stderr,
    async request(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        if (responses.has(id)) return responses.get(id);
        if (child.exitCode !== null) throw new Error(`Bundled MCP exited (${child.exitCode}) before answering ${method}.`);
        await sleep(20);
      }
      throw new Error(`Bundled MCP did not answer ${method}.`);
    },
    async stop() {
      child.stdin.end();
      await stopChild(child);
    },
  };
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
