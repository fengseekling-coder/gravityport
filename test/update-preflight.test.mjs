import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkFreeSpace,
  checkWindowsInstallDirWritable,
  checkWindowsInstallProcesses,
  findExternalInstallProcesses,
  formatBytesForDialog,
  listWindowsProcesses,
  requiredDownloadBytes,
  requiredInstallBytes,
} from "../desktop/update-preflight.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const MiB = 1024 * 1024;
// The 0.3.7 macOS package (132,335,591 bytes, measured) and its install budget.
const MAC_PACKAGE_BYTES = 132_335_591;

function statfsFor(freeBytes) {
  return async () => ({ bsize: 4096, bavail: Math.floor(freeBytes / 4096) });
}

test("the install budget is three unpacked copies plus headroom; the download needs the package plus headroom", () => {
  assert.equal(requiredInstallBytes(MAC_PACKAGE_BYTES), MAC_PACKAGE_BYTES * 3 + 256 * MiB);
  assert.equal(requiredDownloadBytes(MAC_PACKAGE_BYTES), MAC_PACKAGE_BYTES + 256 * MiB);
  assert.equal(formatBytesForDialog(requiredInstallBytes(MAC_PACKAGE_BYTES)), "635 MB");
});

test("the install volume is refused at 600 MB free and allowed at 700 MB free", async () => {
  const requiredBytes = requiredInstallBytes(MAC_PACKAGE_BYTES);
  const tight = await checkFreeSpace({ dir: "/Applications", requiredBytes, statfs: statfsFor(600 * MiB) });
  assert.equal(tight.ok, false);
  assert.equal(tight.availableBytes, Math.floor((600 * MiB) / 4096) * 4096);
  const roomy = await checkFreeSpace({ dir: "/Applications", requiredBytes, statfs: statfsFor(700 * MiB) });
  assert.equal(roomy.ok, true);
});

test("the download volume is checked the same way", async () => {
  const requiredBytes = requiredDownloadBytes(MAC_PACKAGE_BYTES);
  assert.equal((await checkFreeSpace({ dir: "/staging", requiredBytes, statfs: statfsFor(300 * MiB) })).ok, false);
  assert.equal((await checkFreeSpace({ dir: "/staging", requiredBytes, statfs: statfsFor(500 * MiB) })).ok, true);
});

test("free space reports GB with one decimal and smaller sizes in whole MB", () => {
  assert.equal(formatBytesForDialog(1.2 * 1024 * MiB), "1.2 GB");
  assert.equal(formatBytesForDialog(850 * MiB), "850 MB");
});

const INSTALL_DIR = "C:\\Users\\Example\\AppData\\Local\\Programs\\GravityPort";

function proc(ProcessId, ParentProcessId, ExecutablePath) {
  return { ProcessId, ParentProcessId, ExecutablePath };
}

test("GravityPort's own process tree is never counted as an external install holder", () => {
  const self = 100;
  const exe = `${INSTALL_DIR}\\GravityPort.exe`;
  const processes = [
    proc(50, 1, "C:\\Windows\\explorer.exe"),
    proc(self, 50, exe),
    proc(101, self, exe),
    proc(102, self, exe),
    proc(103, 101, exe),
  ];
  assert.deepEqual(findExternalInstallProcesses({ installDir: INSTALL_DIR, selfPid: self, processes }), []);
});

test("an MCP server started by an AI assistant is found even when the path case differs", () => {
  const self = 100;
  const processes = [
    proc(self, 50, `${INSTALL_DIR}\\GravityPort.exe`),
    proc(101, self, `${INSTALL_DIR}\\GravityPort.exe`),
    proc(200, 180, "C:\\Users\\Example\\AppData\\Local\\Programs\\claude.exe"),
    proc(201, 200, "c:\\users\\example\\appdata\\local\\programs\\gravityport\\gravityport.EXE"),
  ];
  const found = findExternalInstallProcesses({ installDir: INSTALL_DIR, selfPid: self, processes });
  assert.deepEqual(found.map((entry) => entry.ProcessId), [201]);
});

test("a process outside the install folder or without a path is ignored", () => {
  const processes = [
    proc(300, 1, "C:\\Other\\GravityPort.exe"),
    proc(301, 1, null),
    proc(302, 1, "C:\\Users\\Example\\AppData\\Local\\Programs\\GravityPortOld\\GravityPort.exe"),
  ];
  assert.deepEqual(findExternalInstallProcesses({ installDir: INSTALL_DIR, selfPid: 1, processes }), []);
});

test("an install at a drive root is refused like the helper refuses it", () => {
  assert.throws(
    () => findExternalInstallProcesses({ installDir: "C:\\", selfPid: 1, processes: [] }),
    /subdirectory install/,
  );
});

test("a failed process listing never blocks the update", async () => {
  const result = await checkWindowsInstallProcesses({
    installDir: INSTALL_DIR,
    selfPid: 1,
    listProcesses: async () => {
      throw new Error("powershell unavailable");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.unknown, true);
});

test("the process check blocks when an external holder is listed", async () => {
  const result = await checkWindowsInstallProcesses({
    installDir: INSTALL_DIR,
    selfPid: 100,
    listProcesses: async () => [proc(101, 200, `${INSTALL_DIR}\\GravityPort.exe`)],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockingProcessIds, [101]);
});

test("the process listing parses CIM output for one or many processes and skips junk rows", async () => {
  const single = await listWindowsProcesses({
    runPowerShell: async () => JSON.stringify({ ProcessId: 7, ParentProcessId: 1, ExecutablePath: null }),
  });
  assert.deepEqual(single, [{ ProcessId: 7, ParentProcessId: 1, ExecutablePath: null }]);
  const many = await listWindowsProcesses({
    runPowerShell: async () => JSON.stringify([{ ProcessId: 8, ParentProcessId: 1, ExecutablePath: "x" }, { nothing: true }]),
  });
  assert.deepEqual(many.map((entry) => entry.ProcessId), [8]);
});

test("the install folder's parent is writable only when a probe directory can be made and removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-preflight-writable-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const writable = await checkWindowsInstallDirWritable({ installDir: join(root, "GravityPort") });
  assert.equal(writable, true);
  const refused = await checkWindowsInstallDirWritable({
    installDir: "Z:\\Read Only\\GravityPort",
    mkdir: async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  });
  assert.equal(refused, false);
});
