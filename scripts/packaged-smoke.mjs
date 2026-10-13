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
  assertPackagedHealth(firstHealth, { libraryDir, expectedIdentity });
  const renderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  if (!renderer.appShell) throw new Error("Packaged renderer did not mount the MOSA app shell.");
  if (!renderer.preload) throw new Error("Packaged renderer did not expose the Electron preload API.");
  if (!renderer.clientToken) throw new Error("Packaged renderer did not retain the MOSA client capability.");
  const importedAssetId = await verifyPackagedImport(activeLaunch.origin, renderer.clientToken);

  await stopChild(activeLaunch.child);
  activeLaunch = null;

  activeLaunch = await launchPackaged({ libraryDir, userData });
  const restartHealth = await waitForHealth(`${activeLaunch.origin}/api/health`, activeLaunch.child);
  assertPackagedHealth(restartHealth, { libraryDir, expectedIdentity });
  const restartRenderer = await waitForRenderer(activeLaunch.origin, activeLaunch.cdpPort, activeLaunch.child);
  if (!restartRenderer.appShell || !restartRenderer.preload) {
    throw new Error("Packaged renderer/preload did not recover after restart.");
  }
  await verifyPersistedAsset(activeLaunch.origin, importedAssetId);

  console.log(JSON.stringify({
    ok: true,
    storage: restartHealth.storage,
    renderer: true,
    preload: true,
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
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (!response.ok) throw new Error("CDP target list unavailable.");
      const targets = await response.json();
      const target = targets.find((entry) => entry.type === "page" && String(entry.url || "").startsWith(expectedOrigin));
      if (!target?.webSocketDebuggerUrl) throw new Error("MOSA renderer target not ready.");
      socket = await openWebSocket(target.webSocketDebuggerUrl);
      const result = await evaluate(socket, `({
        href: location.href,
        readyState: document.readyState,
        appShell: Boolean(document.querySelector('.app')),
        preload: Boolean(window.electronAPI && typeof window.electronAPI.writeClipboardText === 'function'),
        clientToken: String(window.sessionStorage?.getItem?.('mosa.client-token') || '')
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

function openWebSocket(url) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolveSocket(socket), { once: true });
    socket.addEventListener("error", () => rejectSocket(new Error("CDP websocket failed to open.")), { once: true });
  });
}

function evaluate(socket, expression) {
  return new Promise((resolveEvaluation, rejectEvaluation) => {
    const id = 1;
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error) {
        rejectEvaluation(new Error(message.error.message || "CDP evaluation failed."));
        return;
      }
      if (message.result?.exceptionDetails) {
        rejectEvaluation(new Error(message.result.exceptionDetails.text || "Renderer evaluation failed."));
        return;
      }
      resolveEvaluation(message.result?.result?.value);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
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
