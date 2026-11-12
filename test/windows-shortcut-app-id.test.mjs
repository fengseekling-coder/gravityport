// 任务 389（中15）：ensureWindowsShortcutAppId 的四种结果与平台门。
// shell 用假对象记录调用，不碰真的快捷方式；darwin 下一次都不调。
import assert from "node:assert/strict";
import test from "node:test";
import { ensureWindowsShortcutAppId } from "../desktop/windows-shortcut-app-id.mjs";

const APP_ID = "com.azhuilab.mosa";

function fakeShell({ readResult, readError, writeError } = {}) {
  const calls = { read: [], write: [] };
  return {
    calls,
    readShortcutLink(path) {
      calls.read.push(path);
      if (readError) throw readError;
      return readResult;
    },
    writeShortcutLink(path, operation, options) {
      calls.write.push({ path, operation, options });
      if (writeError) throw writeError;
      return true;
    },
  };
}

test("win32: a shortcut with a different identity is rewritten with update", async () => {
  const shell = fakeShell({ readResult: { appUserModelId: "old.identity" } });
  const results = await ensureWindowsShortcutAppId({
    platform: "win32",
    shell,
    shortcutPaths: ["C:\\Users\\x\\Desktop\\GravityPort.lnk"],
    appUserModelId: APP_ID,
  });
  assert.deepEqual(results, { "C:\\Users\\x\\Desktop\\GravityPort.lnk": "updated" });
  assert.deepEqual(shell.calls.read, ["C:\\Users\\x\\Desktop\\GravityPort.lnk"]);
  assert.deepEqual(shell.calls.write, [{
    path: "C:\\Users\\x\\Desktop\\GravityPort.lnk",
    operation: "update",
    options: { appUserModelId: APP_ID },
  }]);
});

test("win32: a shortcut already carrying the identity is left alone", async () => {
  const shell = fakeShell({ readResult: { appUserModelId: APP_ID } });
  const results = await ensureWindowsShortcutAppId({
    platform: "win32",
    shell,
    shortcutPaths: ["C:\\Start\\GravityPort.lnk"],
    appUserModelId: APP_ID,
  });
  assert.deepEqual(results, { "C:\\Start\\GravityPort.lnk": "already" });
  assert.equal(shell.calls.write.length, 0, "no rewrite when the identity already matches");
});

test("win32: an unreadable shortcut reports missing and never writes", async () => {
  const shell = fakeShell({ readError: Object.assign(new Error("shortcut not found"), { code: "ENOENT" }) });
  const results = await ensureWindowsShortcutAppId({
    platform: "win32",
    shell,
    shortcutPaths: ["C:\\Pinned\\GravityPort.lnk"],
    appUserModelId: APP_ID,
  });
  assert.deepEqual(results, { "C:\\Pinned\\GravityPort.lnk": "missing" });
  assert.equal(shell.calls.write.length, 0);
});

test("win32: a failing rewrite reports failed and keeps going through the remaining paths", async () => {
  const shell = {
    calls: { read: [], write: [] },
    readShortcutLink(path) {
      shell.calls.read.push(path);
      if (path === "C:\\Desktop\\GravityPort.lnk") return { appUserModelId: "" };
      return { appUserModelId: APP_ID };
    },
    writeShortcutLink() {
      shell.calls.write.push("write");
      throw new Error("access denied (simulated)");
    },
  };
  const results = await ensureWindowsShortcutAppId({
    platform: "win32",
    shell,
    shortcutPaths: ["C:\\Desktop\\GravityPort.lnk", "C:\\Start\\GravityPort.lnk"],
    appUserModelId: APP_ID,
  });
  assert.deepEqual(results, {
    "C:\\Desktop\\GravityPort.lnk": "failed",
    "C:\\Start\\GravityPort.lnk": "already",
  }, "the failing path does not stop the loop");
  assert.equal(shell.calls.write.length, 1);
});

test("darwin: the shell is never touched and the result is empty", async () => {
  const shell = fakeShell({ readResult: { appUserModelId: "whatever" } });
  const results = await ensureWindowsShortcutAppId({
    platform: "darwin",
    shell,
    shortcutPaths: ["/Applications/GravityPort.app"],
    appUserModelId: APP_ID,
  });
  assert.deepEqual(results, {});
  assert.equal(shell.calls.read.length, 0);
  assert.equal(shell.calls.write.length, 0);
});
