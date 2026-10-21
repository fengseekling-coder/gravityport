import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { macFilenamesPlist, WINDOWS_SET_CLIPBOARD_SCRIPT, writeClipboardFiles } from "../desktop/clipboard-files.mjs";

test("macOS plist lists every path in order and escapes XML", () => {
  const plist = macFilenamesPlist(["/lib/一 a.png", "/lib/b&<c>.png"]);
  assert.match(plist, /<plist version="1\.0"><array><string>\/lib\/一 a\.png<\/string><string>\/lib\/b&amp;&lt;c&gt;\.png<\/string><\/array><\/plist>$/);
});

test("macOS writes NSFilenamesPboardType after clearing the clipboard", async () => {
  const calls = [];
  const clipboard = {
    clear: () => calls.push(["clear"]),
    writeBuffer: (format, buffer) => calls.push([format, buffer.toString("utf8")]),
  };
  assert.equal(await writeClipboardFiles(["/lib/a.png", "/lib/b.png"], { platform: "darwin", clipboard }), true);
  assert.deepEqual(calls.map(([name]) => name), ["clear", "NSFilenamesPboardType"]);
  assert.equal(calls[1][1], macFilenamesPlist(["/lib/a.png", "/lib/b.png"]));
});

test("Windows runs a constant PowerShell script; the paths travel in a temp JSON file", async () => {
  const paths = ["C:\\lib\\一 a.png", "C:\\lib\\b'; Remove-Item x; '.png"];
  let seen = null;
  const run = async (file, args, options) => {
    const listFile = options.env.GRAVITYPORT_CLIPBOARD_FILES;
    seen = { file, args, options, listFile, list: JSON.parse(readFileSync(listFile, "utf8")) };
  };
  assert.equal(await writeClipboardFiles(paths, { platform: "win32", run }), true);
  assert.equal(seen.file, "powershell.exe");
  assert.deepEqual(seen.args, ["-NoProfile", "-NonInteractive", "-STA", "-Command", WINDOWS_SET_CLIPBOARD_SCRIPT]);
  assert.ok(seen.args.every((arg) => !arg.includes("lib")), "no path reaches the command line");
  assert.deepEqual(seen.list, paths);
  assert.ok(seen.options.timeout > 0);
  assert.equal(existsSync(seen.listFile), false, "the temp list is removed afterwards");
});

test("Windows removes the temp list when PowerShell fails", async () => {
  let listFile = "";
  const run = async (_file, _args, options) => {
    listFile = options.env.GRAVITYPORT_CLIPBOARD_FILES;
    throw new Error("powershell failed");
  };
  await assert.rejects(writeClipboardFiles(["C:\\lib\\a.png"], { platform: "win32", run }), /powershell failed/);
  assert.equal(existsSync(listFile), false);
});

test("other platforms and empty lists write nothing", async () => {
  const clipboard = { clear: () => assert.fail("no write"), writeBuffer: () => assert.fail("no write") };
  assert.equal(await writeClipboardFiles(["/lib/a.png"], { platform: "linux", clipboard }), false);
  assert.equal(await writeClipboardFiles([], { platform: "darwin", clipboard }), false);
});
