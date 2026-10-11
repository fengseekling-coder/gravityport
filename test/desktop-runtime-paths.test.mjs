import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { electronExecutablePath, ensureElectronExecutablePath, packagedExecutablePath } from "../scripts/desktop-runtime-paths.mjs";

const rootDir = join("workspace", "mosa");

test("desktop runtime paths resolve macOS executables without leaking into Windows", () => {
  assert.equal(
    electronExecutablePath({ rootDir, platform: "darwin" }),
    join(process.cwd(), rootDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  );
  // The default release product is GravityPort; the MOSA transition build is
  // reachable under the same switch.
  assert.equal(
    packagedExecutablePath({ rootDir, platform: "darwin", arch: "arm64" }),
    join(process.cwd(), rootDir, "out", "GravityPort-darwin-arm64", "GravityPort.app", "Contents", "MacOS", "GravityPort"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir, platform: "darwin", arch: "arm64", product: "MOSA" }),
    join(process.cwd(), rootDir, "out", "MOSA-darwin-arm64", "MOSA.app", "Contents", "MacOS", "MOSA"),
  );
});

test("desktop runtime paths resolve Windows x64 executables", () => {
  assert.equal(
    electronExecutablePath({ rootDir, platform: "win32" }),
    join(process.cwd(), rootDir, "node_modules", "electron", "dist", "electron.exe"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir, platform: "win32", arch: "x64" }),
    join(process.cwd(), rootDir, "out", "GravityPort-win32-x64", "GravityPort.exe"),
  );
  assert.equal(
    packagedExecutablePath({ rootDir, platform: "win32", arch: "x64", product: "MOSA" }),
    join(process.cwd(), rootDir, "out", "MOSA-win32-x64", "MOSA.exe"),
  );
});

test("packaged runtime paths reject unapproved targets", () => {
  assert.throws(() => packagedExecutablePath({ rootDir, platform: "win32", arch: "arm64" }), /Unsupported packaged MOSA target/);
  assert.throws(() => electronExecutablePath({ rootDir, platform: "freebsd" }), /Unsupported Electron QA platform/);
});

test("Electron QA preflight resolves the package executable and rejects path drift", () => {
  const expected = electronExecutablePath({ rootDir, platform: "darwin" });
  assert.equal(ensureElectronExecutablePath({
    rootDir,
    platform: "darwin",
    loadElectron: () => expected,
  }), expected);
  assert.throws(() => ensureElectronExecutablePath({
    rootDir,
    platform: "darwin",
    loadElectron: () => join(process.cwd(), "unexpected", "Electron"),
  }), /path mismatch/);
});
