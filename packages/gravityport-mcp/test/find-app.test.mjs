// Unit tests for findGravityPortApp with a fake exists(): no disk access at
// all. Layouts follow the task order — on macOS the app root is the .app
// directory, on Windows the folder that holds GravityPort.exe; only the
// executable and app.asar itself are probed, never anything inside app.asar.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { findGravityPortApp } from "../lib/find-app.mjs";

function fakeExists(present) {
  const asked = [];
  const exists = (path) => {
    asked.push(path);
    return present.has(path);
  };
  exists.asked = asked;
  return exists;
}

function macLayout(appRoot) {
  const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
  return {
    execPath: join(appRoot, "Contents", "MacOS", "GravityPort"),
    asarPath,
    serverPath: join(asarPath, "mcp", "server.mjs"),
  };
}

function windowsLayout(appRoot) {
  const asarPath = join(appRoot, "resources", "app.asar");
  return {
    execPath: join(appRoot, "GravityPort.exe"),
    asarPath,
    serverPath: join(asarPath, "mcp", "server.mjs"),
  };
}

test("finds the macOS default location", () => {
  const layout = macLayout("/Applications/GravityPort.app");
  const exists = fakeExists(new Set([layout.execPath, layout.asarPath]));
  const result = findGravityPortApp({ platform: "darwin", env: {}, homedir: () => "/home/u", exists });
  assert.deepEqual(result, { execPath: layout.execPath, serverPath: layout.serverPath });
  assert.ok(!exists.asked.some((path) => path.includes("server.mjs")), "never probes inside app.asar");
});

test("falls back to ~/Applications on macOS", () => {
  const layout = macLayout("/home/u/Applications/GravityPort.app");
  const exists = fakeExists(new Set([layout.execPath, layout.asarPath]));
  const result = findGravityPortApp({ platform: "darwin", env: {}, homedir: () => "/home/u", exists });
  assert.deepEqual(result, { execPath: layout.execPath, serverPath: layout.serverPath });
});

test("finds the Windows default location under LOCALAPPDATA", () => {
  const layout = windowsLayout(join("C:\\Users\\u\\AppData\\Local", "Programs", "GravityPort", "app"));
  const exists = fakeExists(new Set([layout.execPath, layout.asarPath]));
  const result = findGravityPortApp({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    homedir: () => "/home/u",
    exists,
  });
  assert.deepEqual(result, { execPath: layout.execPath, serverPath: layout.serverPath });
});

test("GRAVITYPORT_APP_PATH wins over the macOS default", () => {
  const custom = macLayout("/opt/Custom/GravityPort.app");
  const standard = macLayout("/Applications/GravityPort.app");
  const exists = fakeExists(new Set([custom.execPath, custom.asarPath, standard.execPath, standard.asarPath]));
  const result = findGravityPortApp({ platform: "darwin", env: { GRAVITYPORT_APP_PATH: "/opt/Custom/GravityPort.app" }, homedir: () => "/home/u", exists });
  assert.deepEqual(result, { execPath: custom.execPath, serverPath: custom.serverPath });
  assert.ok(!exists.asked.some((path) => path.includes("server.mjs")), "never probes inside app.asar");
});

test("GRAVITYPORT_APP_PATH also works as the Windows exe folder", () => {
  const custom = windowsLayout("D:\\Apps\\GravityPort");
  const exists = fakeExists(new Set([custom.execPath, custom.asarPath]));
  const result = findGravityPortApp({ platform: "win32", env: { GRAVITYPORT_APP_PATH: "D:\\Apps\\GravityPort" }, homedir: () => "/home/u", exists });
  assert.deepEqual(result, { execPath: custom.execPath, serverPath: custom.serverPath });
});

test("an executable without app.asar does not count as installed", () => {
  const layout = macLayout("/Applications/GravityPort.app");
  const exists = fakeExists(new Set([layout.execPath]));
  const result = findGravityPortApp({ platform: "darwin", env: {}, homedir: () => "/home/u", exists });
  assert.equal(result, null);
});

test("app.asar without the executable does not count as installed", () => {
  const layout = windowsLayout(join("C:\\Users\\u\\AppData\\Local", "Programs", "GravityPort", "app"));
  const exists = fakeExists(new Set([layout.asarPath]));
  const result = findGravityPortApp({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    homedir: () => "/home/u",
    exists,
  });
  assert.equal(result, null);
});

test("returns null on other systems", () => {
  const result = findGravityPortApp({ platform: "linux", env: {}, homedir: () => "/home/u", exists: fakeExists(new Set()) });
  assert.equal(result, null);
});

test("a GRAVITYPORT_APP_PATH that is set but missing answers not-found instead of falling back to another install", () => {
  const standard = macLayout("/Applications/GravityPort.app");
  const exists = fakeExists(new Set([standard.execPath, standard.asarPath]));
  const result = findGravityPortApp({ platform: "darwin", env: { GRAVITYPORT_APP_PATH: "/missing/GravityPort.app" }, homedir: () => "/home/u", exists });
  assert.equal(result, null);
});
