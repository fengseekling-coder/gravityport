// Task 447: behavior tests for the clipboard, installation-id, full-screen,
// change-library-location and reveal-managed-extension-folder IPC handlers,
// replacing the source-text handler slices in
// test/electron-preload-runtime-contract.test.mjs (442 report 2.10 乙) and
// test/extension-folder-copy-reveal.test.mjs (442 report 2.11). Every handler
// runs against recording fakes; the library and userData directories live
// under os.tmpdir() and the real system clipboard is never touched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { makeFakeIpcMain } from "./helpers/fake-ipc-main.mjs";
import { clipboardImageTarget } from "../desktop/clipboard-image-path.mjs";
import { clipboardImportable } from "../desktop/clipboard-importable.mjs";
import { registerClipboardIpc } from "../desktop/ipc/clipboard.mjs";
import { registerLibraryLocationIpc } from "../desktop/ipc/library-location.mjs";
import { registerMiscIpc } from "../desktop/ipc/misc.mjs";

async function makeTempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// trustedRendererEvent reads a marker off the fake event, so one registration
// covers both the trusted and the untrusted sender in every test below.
const trustedEvent = { trusted: true };
const untrustedEvent = { trusted: false };
const trustByMarker = (event) => event?.trusted === true;

function fakeClipboard({ imageEmpty = true, formats = [] } = {}) {
  const calls = { writeText: [], writeImage: [] };
  return {
    calls,
    readImage: () => ({ isEmpty: () => imageEmpty }),
    read: () => "",
    availableFormats: () => formats,
    has: () => false,
    writeText: (text) => { calls.writeText.push(text); },
    writeImage: (image) => { calls.writeImage.push(image); },
  };
}

function fakeNativeImage() {
  const created = [];
  return {
    created,
    createFromPath: (path) => {
      created.push(path);
      return { isEmpty: () => false };
    },
  };
}

// --- C1: clipboard -------------------------------------------------------

test("clipboard-importable consults clipboardImportable only for trusted senders", async () => {
  const ipc = makeFakeIpcMain();
  const importableCalls = [];
  registerClipboardIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    clipboard: fakeClipboard({ imageEmpty: false }),
    clipboardImportable: (input) => {
      importableCalls.push(input);
      return clipboardImportable(input);
    },
    clipboardImageTarget,
    MAX_CLIPBOARD_TEXT_LENGTH: 1_000_000,
    getLibraryDir: () => "/unused-by-this-handler",
  });
  const handler = ipc.handlers.get("clipboard-importable");
  assert.equal(typeof handler, "function");

  assert.equal(await handler(untrustedEvent), false);
  assert.deepEqual(importableCalls, [], "untrusted senders must not reach clipboardImportable");

  assert.equal(await handler(trustedEvent), true);
  assert.equal(importableCalls.length, 1);
  assert.equal(importableCalls[0].platform, process.platform);
  assert.notEqual(importableCalls[0].clipboard, undefined);

  assert.equal(await handler(trustedEvent), true);
  assert.equal(importableCalls.length, 2);
});

test("clipboard-importable answers false for an empty clipboard", async () => {
  const ipc = makeFakeIpcMain();
  registerClipboardIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    clipboard: fakeClipboard({ imageEmpty: true }),
    clipboardImportable,
    clipboardImageTarget,
    MAX_CLIPBOARD_TEXT_LENGTH: 1_000_000,
    getLibraryDir: () => "/unused-by-this-handler",
  });
  assert.equal(await ipc.handlers.get("clipboard-importable")(trustedEvent), false);
});

test("paste-from-clipboard pastes exactly once and only for trusted senders", async () => {
  const ipc = makeFakeIpcMain();
  registerClipboardIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    clipboard: fakeClipboard(),
    clipboardImageTarget,
    MAX_CLIPBOARD_TEXT_LENGTH: 1_000_000,
    getLibraryDir: () => "/unused-by-this-handler",
  });
  const handler = ipc.handlers.get("paste-from-clipboard");
  const pastes = [];

  assert.equal(await handler({ ...untrustedEvent, sender: { paste: () => pastes.push("untrusted") } }), false);
  assert.deepEqual(pastes, []);

  assert.equal(await handler({ ...trustedEvent, sender: { paste: () => pastes.push("trusted") } }), true);
  assert.deepEqual(pastes, ["trusted"]);
});

test("write-clipboard-text writes only trusted, string, bounded text", async () => {
  const ipc = makeFakeIpcMain();
  const clipboard = fakeClipboard();
  registerClipboardIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    clipboard,
    clipboardImageTarget,
    MAX_CLIPBOARD_TEXT_LENGTH: 1_000_000,
    getLibraryDir: () => "/unused-by-this-handler",
  });
  const handler = ipc.handlers.get("write-clipboard-text");

  assert.deepEqual(await handler(untrustedEvent, "hello"), { ok: false, reason: "unavailable" });
  assert.deepEqual(clipboard.calls.writeText, []);

  assert.deepEqual(await handler(trustedEvent, 42), { ok: false, reason: "invalid" });
  assert.deepEqual(await handler(trustedEvent, "x".repeat(1_000_001)), { ok: false, reason: "invalid" });
  assert.deepEqual(clipboard.calls.writeText, [], "rejected inputs must not reach the clipboard");

  assert.deepEqual(await handler(trustedEvent, "hello"), { ok: true });
  assert.deepEqual(clipboard.calls.writeText, ["hello"]);
});

test("write-clipboard-image copies a library file and refuses out-of-library paths", async (t) => {
  const libraryDir = await makeTempDir(t, "mosa-ipc-handlers-library-");
  mkdirSync(join(libraryDir, "assets"), { recursive: true });
  const imagePath = join(libraryDir, "assets", "picture.png");
  writeFileSync(imagePath, Buffer.from("png-fixture-bytes"));

  const ipc = makeFakeIpcMain();
  const clipboard = fakeClipboard();
  const nativeImage = fakeNativeImage();
  registerClipboardIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    clipboard,
    nativeImage,
    clipboardImageTarget,
    MAX_CLIPBOARD_TEXT_LENGTH: 1_000_000,
    getLibraryDir: () => libraryDir,
  });
  const handler = ipc.handlers.get("write-clipboard-image");

  assert.deepEqual(await handler(untrustedEvent, imagePath), { ok: false, reason: "unavailable" });
  assert.deepEqual(nativeImage.created, []);
  assert.deepEqual(clipboard.calls.writeImage, []);

  const outsidePath = join(tmpdir(), "mosa-ipc-handlers-outside.png");
  const outside = await handler(trustedEvent, outsidePath);
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "not-allowed");
  assert.deepEqual(nativeImage.created, [], "nativeImage must not be touched for out-of-library paths");
  assert.deepEqual(clipboard.calls.writeImage, []);

  assert.deepEqual(await handler(trustedEvent, imagePath), { ok: true });
  assert.equal(nativeImage.created.length, 1);
  assert.equal(existsSync(nativeImage.created[0]), true, "the resolved library file is handed to nativeImage");
  assert.equal(clipboard.calls.writeImage.length, 1);
});

// --- C2: installation-id --------------------------------------------------

test("installation-id answers the read-only id only to trusted senders", async () => {
  const ipc = makeFakeIpcMain();
  registerMiscIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    getInstallationId: () => "installation-1234",
  });
  const handler = ipc.handlers.get("installation-id");
  assert.equal(typeof handler, "function");

  assert.equal(await handler(untrustedEvent), "");
  assert.equal(await handler(trustedEvent), "installation-1234");
});

// --- C3: set-window-full-screen -------------------------------------------

test("set-window-full-screen refuses untrusted senders and writes both branches", () => {
  const ipc = makeFakeIpcMain();
  const calls = [];
  let fullScreen = false;
  const window = {
    setFullScreen: (flag) => { calls.push(flag); fullScreen = flag; },
    isFullScreen: () => fullScreen,
  };
  registerMiscIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    getMainWindow: () => window,
  });
  const handler = ipc.handlers.get("set-window-full-screen");
  assert.equal(typeof handler, "function");

  assert.deepEqual(handler(untrustedEvent, true), { ok: false });
  assert.deepEqual(calls, [], "untrusted senders must not reach setFullScreen");

  assert.deepEqual(handler(trustedEvent, false), { ok: true, isFullScreen: false });
  assert.deepEqual(calls, [false]);
  assert.deepEqual(handler(trustedEvent, true), { ok: true, isFullScreen: true });
  assert.deepEqual(calls, [false, true]);
});

// --- C4: change-library-location ------------------------------------------

const RELOCATION_SUCCESS_SEQUENCE = [
  "stopOwnedRuntime",
  "copyLibraryForRelocationGuarded",
  "saveLibraryDir",
  "setLibraryDir",
  "app.relaunch",
  "app.exit(0)",
];

function trackedRelocationSteps(steps) {
  return steps.filter((name) => RELOCATION_SUCCESS_SEQUENCE.includes(name));
}

async function setupLibraryLocation(t, {
  messageBoxResponse = 1,
  validation = { ok: true },
  copyError = null,
  saveError = null,
  service = { mode: "owned" },
} = {}) {
  const oldLibraryDir = await makeTempDir(t, "mosa-relocation-old-");
  const nextLibraryDir = await makeTempDir(t, "mosa-relocation-next-");
  const userDataDir = await makeTempDir(t, "mosa-relocation-userdata-");
  mkdirSync(join(oldLibraryDir, "assets"), { recursive: true });
  writeFileSync(join(oldLibraryDir, "mosa.db"), "sqlite-fixture");

  const steps = [];
  const savedDirs = [];
  const setDirs = [];
  const validateCalls = [];
  const dialogCalls = { openDialog: 0, messageBox: 0 };

  const ipc = makeFakeIpcMain();
  registerLibraryLocationIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    app: {
      relaunch: () => { steps.push("app.relaunch"); },
      exit: (code) => { steps.push(`app.exit(${code})`); },
      getPath: (name) => {
        assert.equal(name, "userData");
        return userDataDir;
      },
    },
    resolve,
    screenGuard: {
      openDialog: async () => {
        dialogCalls.openDialog += 1;
        return { canceled: false, filePaths: [nextLibraryDir] };
      },
      messageBox: async () => {
        dialogCalls.messageBox += 1;
        return { response: messageBoxResponse };
      },
    },
    getDesktopText: (key) => key,
    validateRelocationTarget: async (input) => {
      validateCalls.push(input);
      return validation;
    },
    writeRelocationMarker: async () => { steps.push("writeRelocationMarker"); },
    stopOwnedRuntime: async () => { steps.push("stopOwnedRuntime"); },
    copyLibraryForRelocationGuarded: async () => {
      steps.push("copyLibraryForRelocationGuarded");
      if (copyError) throw copyError;
    },
    removeRelocationMarker: async () => { steps.push("removeRelocationMarker"); },
    relocationFailureReason: () => "copy-failed",
    saveLibraryDir: (dir) => {
      steps.push("saveLibraryDir");
      if (saveError) throw saveError;
      savedDirs.push(dir);
    },
    getMainWindow: () => ({ fakeWindow: true }),
    getCurrentLocale: () => "zh",
    getLibraryDir: () => oldLibraryDir,
    setLibraryDir: (dir) => { steps.push("setLibraryDir"); setDirs.push(dir); },
    getService: () => service,
    setService: () => { steps.push("setService"); },
    pauseLibraryVolumeWatch: () => { steps.push("pauseLibraryVolumeWatch"); },
    resumeLibraryVolumeWatch: () => { steps.push("resumeLibraryVolumeWatch"); },
  });
  const handler = ipc.handlers.get("change-library-location");
  assert.equal(typeof handler, "function");
  return { handler, steps, savedDirs, setDirs, validateCalls, dialogCalls, oldLibraryDir, nextLibraryDir, userDataDir };
}

test("change-library-location refuses untrusted, env-managed and attached runtimes before any dialog", async (t) => {
  const untrusted = await setupLibraryLocation(t);
  assert.deepEqual(await untrusted.handler(untrustedEvent), { ok: false, reason: "unavailable" });
  assert.deepEqual(untrusted.dialogCalls, { openDialog: 0, messageBox: 0 });
  assert.deepEqual(untrusted.steps, []);

  const managed = await setupLibraryLocation(t);
  const originalEnv = process.env.MOSA_LIBRARY_DIR;
  // The handler reads the env override at call time; set and restore inside
  // the test body so the later sub-cases never see it.
  t.after(() => {
    if (originalEnv === undefined) delete process.env.MOSA_LIBRARY_DIR;
    else process.env.MOSA_LIBRARY_DIR = originalEnv;
  });
  try {
    process.env.MOSA_LIBRARY_DIR = join(tmpdir(), "mosa-relocation-managed-");
    assert.deepEqual(await managed.handler(trustedEvent), { ok: false, reason: "managed" });
  } finally {
    if (originalEnv === undefined) delete process.env.MOSA_LIBRARY_DIR;
    else process.env.MOSA_LIBRARY_DIR = originalEnv;
  }
  assert.deepEqual(managed.dialogCalls, { openDialog: 0, messageBox: 0 });

  const attached = await setupLibraryLocation(t, { service: { mode: "attached" } });
  assert.deepEqual(await attached.handler(trustedEvent), { ok: false, reason: "attached" });
  assert.deepEqual(attached.dialogCalls, { openDialog: 0, messageBox: 0 });
});

test("change-library-location aborts on a rejected target without confirm dialog, stop or copy", async (t) => {
  const { handler, steps, validateCalls, dialogCalls, oldLibraryDir, nextLibraryDir } = await setupLibraryLocation(t, {
    validation: { ok: false, reason: "not-empty" },
  });
  assert.deepEqual(await handler(trustedEvent), { ok: false, reason: "not-empty" });
  assert.deepEqual(dialogCalls, { openDialog: 1, messageBox: 0 }, "the folder picker runs, the confirm dialog never does");
  assert.deepEqual(validateCalls, [{ currentLibraryDir: oldLibraryDir, nextLibraryDir }]);
  assert.equal(steps.includes("stopOwnedRuntime"), false);
  assert.equal(steps.includes("copyLibraryForRelocationGuarded"), false);
  assert.equal(steps.includes("saveLibraryDir"), false);
});

test("change-library-location cancels cleanly when the user declines the confirm dialog", async (t) => {
  const { handler, steps, dialogCalls } = await setupLibraryLocation(t, { messageBoxResponse: 0 });
  assert.deepEqual(await handler(trustedEvent), { ok: false, reason: "cancelled" });
  assert.deepEqual(dialogCalls, { openDialog: 1, messageBox: 1 });
  assert.equal(steps.includes("writeRelocationMarker"), false);
  assert.equal(steps.includes("stopOwnedRuntime"), false);
  assert.equal(steps.includes("copyLibraryForRelocationGuarded"), false);
});

test("change-library-location moves the library and records the pending old-library cleanup", async (t) => {
  const { handler, steps, savedDirs, setDirs, oldLibraryDir, nextLibraryDir, userDataDir } = await setupLibraryLocation(t);
  assert.deepEqual(await handler(trustedEvent), { ok: true, restarting: true });

  assert.deepEqual(trackedRelocationSteps(steps), RELOCATION_SUCCESS_SEQUENCE);
  assert.deepEqual(savedDirs, [nextLibraryDir], "the persisted location switches to the new library");
  assert.deepEqual(setDirs, [nextLibraryDir], "the in-memory library switches to the new library");

  // Task 443: the old library is only trashed after the next launch proves
  // the relocated library opens — the handler itself must leave it in place.
  assert.equal(existsSync(oldLibraryDir), true, "the old library directory still exists");
  assert.equal(existsSync(join(oldLibraryDir, "mosa.db")), true);

  const recordPath = join(userDataDir, "pending-old-library-cleanup.json");
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.equal(record.previousLibraryDir, resolve(oldLibraryDir));
  assert.equal(record.nextLibraryDir, resolve(nextLibraryDir));
});

test("change-library-location leaves everything in place when the guarded copy fails", async (t) => {
  const { handler, steps, savedDirs, setDirs, oldLibraryDir, userDataDir } = await setupLibraryLocation(t, {
    copyError: new Error("copy failed: disk full"),
  });
  assert.deepEqual(await handler(trustedEvent), { ok: false, reason: "copy-failed" });

  assert.deepEqual(savedDirs, [], "the persisted location never switches on a failed copy");
  assert.deepEqual(setDirs, [oldLibraryDir], "the in-memory library is restored to the old location");
  assert.equal(steps.includes("removeRelocationMarker"), true, "the relocation marker is removed again");
  assert.equal(steps.includes("app.exit(1)"), true, "the app restarts with a failure exit code");
  assert.equal(existsSync(oldLibraryDir), true, "the old library directory still exists");
  assert.equal(existsSync(join(userDataDir, "pending-old-library-cleanup.json")), false, "no pending cleanup record is written");
});

test("change-library-location writes no pending cleanup record when saving the new location fails", async (t) => {
  // Replaces the 443 source-order nail "the pending cleanup record is written
  // only after the copy succeeded and the preference switched".
  const { handler, steps, savedDirs, setDirs, oldLibraryDir, userDataDir } = await setupLibraryLocation(t, {
    saveError: new Error("settings write failed"),
  });
  assert.deepEqual(await handler(trustedEvent), { ok: false, reason: "copy-failed" });

  assert.equal(steps.includes("copyLibraryForRelocationGuarded"), true);
  assert.deepEqual(savedDirs, []);
  assert.deepEqual(setDirs, [oldLibraryDir], "the in-memory library is restored to the old location");
  assert.equal(steps.includes("app.exit(0)"), false);
  assert.equal(existsSync(oldLibraryDir), true, "the old library directory still exists");
  assert.equal(existsSync(join(userDataDir, "pending-old-library-cleanup.json")), false, "no pending cleanup record is written");
});

// --- C5: reveal-managed-extension-folder ----------------------------------

test("reveal-managed-extension-folder shows the extension folder itself, not manifest.json", async () => {
  const ipc = makeFakeIpcMain();
  const shown = [];
  const accessCalls = [];
  const extensionDir = "/fake/Application Support/mosa/browser-extension/chrome";
  registerMiscIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    join,
    shell: { showItemInFolder: (path) => { shown.push(path); } },
    access: async (path) => { accessCalls.push(path); },
    managedBrowserExtensionTarget: extensionDir,
  });
  const handler = ipc.handlers.get("reveal-managed-extension-folder");
  assert.equal(typeof handler, "function");

  assert.deepEqual(await handler(untrustedEvent), { ok: false });
  assert.deepEqual(shown, []);

  assert.deepEqual(await handler(trustedEvent), { ok: true });
  assert.deepEqual(accessCalls, [join(extensionDir, "manifest.json")]);
  assert.deepEqual(shown, [extensionDir]);
  assert.notEqual(shown[0], join(extensionDir, "manifest.json"));
});

test("reveal-managed-extension-folder fails closed when the manifest is missing", async () => {
  const ipc = makeFakeIpcMain();
  const shown = [];
  registerMiscIpc({
    ipcMain: ipc,
    trustedRendererEvent: trustByMarker,
    join,
    shell: { showItemInFolder: (path) => { shown.push(path); } },
    access: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    managedBrowserExtensionTarget: "/fake/Application Support/mosa/browser-extension/chrome",
  });
  assert.deepEqual(await ipc.handlers.get("reveal-managed-extension-folder")(trustedEvent), { ok: false });
  assert.deepEqual(shown, []);
});
