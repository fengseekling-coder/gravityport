import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { registerClipboardIpc } from "../desktop/ipc/clipboard.mjs";
import { registerLibraryLocationIpc } from "../desktop/ipc/library-location.mjs";
import { registerMiscIpc } from "../desktop/ipc/misc.mjs";
import { macosUpdateInstallPromise, registerUpdateIpc, windowsUpdateInstallPromise } from "../desktop/ipc/updates.mjs";

function makeFakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    channels: () => [...handlers.keys()],
    handle(channel, fn) {
      assert.equal(handlers.has(channel), false, `duplicate IPC channel: ${channel}`);
      assert.equal(typeof fn, "function", `handler for ${channel} must be a function`);
      handlers.set(channel, fn);
    },
  };
}

test("registerClipboardIpc, registerMiscIpc, and registerLibraryLocationIpc register their exact channel sets", () => {
  const clipboardIpc = makeFakeIpcMain();
  registerClipboardIpc({ ipcMain: clipboardIpc });
  assert.deepEqual(clipboardIpc.channels(), [
    "paste-image",
    "clipboard-importable",
    "paste-from-clipboard",
    "write-clipboard-text",
    "write-clipboard-image",
    "start-native-file-drag",
    "write-clipboard-files",
    "library-file-flags",
  ]);

  const miscIpc = makeFakeIpcMain();
  registerMiscIpc({ ipcMain: miscIpc });
  assert.deepEqual(miscIpc.channels(), [
    "reveal-managed-extension-folder",
    "background-capture-state",
    "set-background-capture",
    "set-locale",
    "mcp-client-config",
    "get-client-token",
    "rename-notice-state",
    "acknowledge-rename-notice",
    "renderer-ready",
    "open-pinterest-authorize",
    "open-external-link",
    "set-window-full-screen",
  ]);

  const libraryLocationIpc = makeFakeIpcMain();
  registerLibraryLocationIpc({ ipcMain: libraryLocationIpc });
  assert.deepEqual(libraryLocationIpc.channels(), [
    "change-library-location",
  ]);
});

test("set-window-full-screen reads the current window through getMainWindow on each call", () => {
  const miscIpc = makeFakeIpcMain();
  const makeFakeWindow = (name) => {
    const calls = [];
    let fullScreen = false;
    return {
      name,
      calls,
      setFullScreen(flag) {
        calls.push(flag);
        fullScreen = flag;
      },
      isFullScreen() {
        return fullScreen;
      },
    };
  };

  const windowA = makeFakeWindow("A");
  const windowB = makeFakeWindow("B");
  let currentWindow = windowA;

  registerMiscIpc({
    ipcMain: miscIpc,
    trustedRendererEvent: () => true,
    getMainWindow: () => currentWindow,
  });

  const handler = miscIpc.handlers.get("set-window-full-screen");
  assert.equal(typeof handler, "function");

  const firstResult = handler({}, true);
  assert.deepEqual(firstResult, { ok: true, isFullScreen: true });
  assert.deepEqual(windowA.calls, [true]);
  assert.deepEqual(windowB.calls, []);

  currentWindow = windowB;
  const secondResult = handler({}, true);
  assert.deepEqual(secondResult, { ok: true, isFullScreen: true });
  assert.deepEqual(windowA.calls, [true]);
  assert.deepEqual(windowB.calls, [true]);
});

test("registerUpdateIpc registers exactly the five update channels in the original order", () => {
  const updateIpc = makeFakeIpcMain();
  registerUpdateIpc({ ipcMain: updateIpc });
  assert.deepEqual(updateIpc.channels(), [
    "check-for-updates",
    "get-update-ready",
    "download-and-install-update",
    "cancel-update-download",
    "open-download-page",
  ]);
});

test("update install state exports as live bindings and cancel-update-download tolerates no active download", async () => {
  // The four module-level update variables moved here from main.mjs (task 406).
  // main.mjs reads the two install promises through these live exports, so the
  // initial values must be the same null the handlers reset them to.
  assert.equal(macosUpdateInstallPromise, null);
  assert.equal(windowsUpdateInstallPromise, null);
  const updateIpc = makeFakeIpcMain();
  registerUpdateIpc({
    ipcMain: updateIpc,
    trustedRendererEvent: () => true,
    macosUpdateDownloadController: null,
    windowsUpdateDownloadController: null,
  });
  const handler = updateIpc.handlers.get("cancel-update-download");
  assert.equal(typeof handler, "function");
  const result = await handler({});
  assert.deepEqual(result, { ok: false });
});

test("registerUpdateIpc never snapshots the window outside a handler", () => {
  const source = readFileSync(new URL("../desktop/ipc/updates.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /const \w+ = getMainWindow\(\)/);
  // Every window access sits inside the per-download onProgress callbacks, so
  // a window rebuilt mid-download is still picked up on the next progress
  // event. A behavior test would need a full staged release download (real
  // manifest signature, real network fetch), which cannot be faked cheaply;
  // the source nail plus the deps-based getMainWindow() calls carry this
  // check the same way the set-window-full-screen test does for misc.mjs.
  assert.match(source, /getMainWindow\(\)\.webContents\.send\("update-download-progress", progress\)/);
});
