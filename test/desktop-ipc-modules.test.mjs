import assert from "node:assert/strict";
import test from "node:test";
import { registerClipboardIpc } from "../desktop/ipc/clipboard.mjs";
import { registerLibraryLocationIpc } from "../desktop/ipc/library-location.mjs";
import { registerMiscIpc } from "../desktop/ipc/misc.mjs";

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
