// Task 447: drives the real download-and-install-update handler from
// desktop/ipc/updates.mjs end to end with recording fakes for every
// dependency the section-A injection surface added, replacing the two
// source-text order tests in test/update-service.test.mjs (442 report 2.21).
// No real network, no real updater helper, no real app.exit — every
// side effect is a recorded fake and every directory lives under tmpdir().
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as posixDirname, join } from "node:path";
import test from "node:test";
import { makeFakeIpcMain } from "./helpers/fake-ipc-main.mjs";
import { macosUpdateInstallPromise, registerUpdateIpc, windowsUpdateInstallPromise } from "../desktop/ipc/updates.mjs";

const FAKE_BUILD_IDENTITY = {
  gitSha: "a".repeat(40),
  uiFingerprint: "b".repeat(64),
  runtimeFingerprint: "c".repeat(64),
  distribution: "production",
};

const MACOS_TRACKED_STEPS = [
  "canInstallUpdateInApp",
  "checkForMosaUpdate",
  "updateFailedTwiceResult",
  "preflightFreeSpace",
  "downloadMacosUpdate",
  "launchMacosUpdateHelper",
  "recordUpdateAttempt",
  "app.exit(0)",
];

const MACOS_INSTALL_SEQUENCE = [
  "canInstallUpdateInApp",
  "checkForMosaUpdate",
  "updateFailedTwiceResult",
  "preflightFreeSpace",
  "downloadMacosUpdate",
  "preflightFreeSpace",
  "launchMacosUpdateHelper",
  "recordUpdateAttempt",
  "app.exit(0)",
];

const WINDOWS_TRACKED_STEPS = [
  "canInstallUpdateInApp",
  "checkForMosaUpdate",
  "updateFailedTwiceResult",
  "preflightFreeSpace",
  "windowsInstallPreflight",
  "downloadWindowsUpdate",
  "launchWindowsUpdateHelper",
  "recordUpdateAttempt",
  "app.exit(0)",
];

const WINDOWS_INSTALL_SEQUENCE = [
  "canInstallUpdateInApp",
  "checkForMosaUpdate",
  "updateFailedTwiceResult",
  "preflightFreeSpace",
  "windowsInstallPreflight",
  "downloadWindowsUpdate",
  "preflightFreeSpace",
  "windowsInstallPreflight",
  "launchWindowsUpdateHelper",
  "recordUpdateAttempt",
  "app.exit(0)",
];

function trackedSteps(steps, tracked) {
  return steps.filter((name) => tracked.includes(name));
}

// The handler reads process.execPath through the non-injectable
// windowsInstalledExeName (and dirname) for the Windows install folder, so the
// Windows tests borrow a packaged-looking execPath for the duration of the
// call and restore it immediately after. Tests in one file run sequentially,
// so nothing else observes the temporary value.
async function withWindowsExecPath(run) {
  const originalExecPath = process.execPath;
  process.execPath = "/fake/GravityPort.exe";
  try {
    return await run();
  } finally {
    process.execPath = originalExecPath;
  }
}

function makeDeps({ steps, attempts, stagingRoot, userDataDir, overrides = {} }) {
  const deps = {
    ipcMain: makeFakeIpcMain(),
    trustedRendererEvent: () => true,
    app: {
      isPackaged: true,
      getVersion: () => "1.0.0",
      runningUnderARM64Translation: false,
      relaunch: () => { steps.push("app.relaunch"); },
      exit: (code) => { steps.push(`app.exit(${code})`); },
      getPath: (name) => {
        assert.equal(name, "userData");
        return userDataDir;
      },
    },
    dirname: posixDirname,
    desktopDataDir: userDataDir,
    expectedServiceIdentity: { releaseManifestTrust: { fakeTrust: true }, distribution: "production" },
    evaluateMacosInstallLocation: () => ({ installAppPath: "/fake/Applications/GravityPort.app", supported: true }),
    screenGuard: {},
    stopOwnedRuntime: async () => { steps.push("stopOwnedRuntime"); },
    getMainWindow: () => null,
    getLibraryDir: () => "/fake/library",
    runUpdateCheck: async () => { throw new Error("runUpdateCheck must not run in this test"); },
    updateScheduler: {
      cancelDownload: () => { steps.push("updateScheduler.cancelDownload"); },
      stop: () => { steps.push("updateScheduler.stop"); },
      readyPayload: () => null,
    },
    systemNetworkFetch: async () => { throw new Error("no network fetch may run in this test"); },
    releaseManifestVerificationTrusts: () => ({ fakeTrust: true }),
    updateFailedTwiceResult: async () => { steps.push("updateFailedTwiceResult"); return null; },
    preflightFreeSpace: async () => { steps.push("preflightFreeSpace"); return true; },
    windowsInstallPreflight: async () => { steps.push("windowsInstallPreflight"); return null; },
    stopBridgeNotificationPoll: () => { steps.push("stopBridgeNotificationPoll"); },
    stopAnonymousUsageLifecycle: () => { steps.push("stopAnonymousUsageLifecycle"); },
    releaseDesktopStartupHandoff: async () => { steps.push("releaseDesktopStartupHandoff"); },
    MACOS_UPDATE_STAGING_ROOT: stagingRoot,
    WINDOWS_UPDATE_STAGING_ROOT: stagingRoot,
    isolationContext: { qaRun: false },
    setShuttingDown: () => { steps.push("setShuttingDown"); },
    // Task 447 section-A injection surface: recording fakes by default.
    canInstallUpdateInApp: () => { steps.push("canInstallUpdateInApp"); return true; },
    checkForMosaUpdate: async (input) => {
      steps.push("checkForMosaUpdate");
      assert.equal(input.fetchImpl, deps.systemNetworkFetch);
      assert.equal(input.currentVersion, "1.0.0");
      assert.equal(input.currentDistribution, "production");
      return {
        updateAvailable: true,
        latestVersion: "1.1.0",
        currentVersion: "1.0.0",
        buildIdentity: FAKE_BUILD_IDENTITY,
        macArtifact: {
          file: "GravityPort-darwin-arm64-1.1.0.zip",
          size: 1234,
          sha256: "d".repeat(64),
          appName: "GravityPort.app",
          arch: "arm64",
          teamIdentifier: "",
        },
        windowsArtifact: {
          file: "GravityPort-win32-x64-1.1.0.zip",
          size: 1234,
          sha256: "d".repeat(64),
          payloadExeName: "GravityPort.exe",
          signerThumbprint: "E".repeat(40),
        },
      };
    },
    recordUpdateAttempt: async (payload) => {
      steps.push("recordUpdateAttempt");
      attempts.push(payload);
    },
    downloadMacosUpdate: async () => {
      steps.push("downloadMacosUpdate");
      return { zipPath: join(stagingRoot, "GravityPort-darwin-arm64-1.1.0.zip") };
    },
    launchMacosUpdateHelper: async () => { steps.push("launchMacosUpdateHelper"); },
    downloadWindowsUpdate: async () => {
      steps.push("downloadWindowsUpdate");
      return { zipPath: join(stagingRoot, "GravityPort-win32-x64-1.1.0.zip") };
    },
    launchWindowsUpdateHelper: async () => { steps.push("launchWindowsUpdateHelper"); },
    ...overrides,
  };
  return deps;
}

async function setupUpdateIpc(t, { platform: platformName = "darwin", overrides = {} } = {}) {
  const stagingRoot = await mkdtemp(join(tmpdir(), "mosa-update-flow-staging-"));
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-update-flow-userdata-"));
  t.after(async () => {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const steps = [];
  const attempts = [];
  const deps = makeDeps({ steps, attempts, stagingRoot, userDataDir, overrides: { platform: platformName, ...overrides } });
  registerUpdateIpc(deps);
  const handler = deps.ipcMain.handlers.get("download-and-install-update");
  assert.equal(typeof handler, "function");
  return { steps, attempts, handler };
}

function assertNoDownloadOrExit(steps) {
  const offenders = steps.filter((name) => name.startsWith("download")
    || name.startsWith("launch")
    || name.startsWith("recordUpdateAttempt")
    || name.startsWith("app.exit"));
  assert.deepEqual(offenders, [], "no download, helper launch, attempt record or exit may happen");
}

test("darwin install flow runs the whole macOS sequence in order and exits", async (t) => {
  const { steps, attempts, handler } = await setupUpdateIpc(t);
  const result = await handler({});
  assert.deepEqual(result, { status: "installing", latestVersion: "1.1.0" });
  assert.deepEqual(trackedSteps(steps, MACOS_TRACKED_STEPS), MACOS_INSTALL_SEQUENCE);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].platform, "macos");
  assert.equal(attempts[0].version, "1.1.0");
  assert.equal(macosUpdateInstallPromise, null);
});

test("win32 install flow runs the whole Windows sequence in order and exits", async (t) => {
  const { steps, attempts, handler } = await setupUpdateIpc(t, { platform: "win32" });
  const result = await withWindowsExecPath(() => handler({}));
  assert.deepEqual(result, { status: "installing", latestVersion: "1.1.0" });
  assert.deepEqual(trackedSteps(steps, WINDOWS_TRACKED_STEPS), WINDOWS_INSTALL_SEQUENCE);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].platform, "windows");
  assert.equal(attempts[0].version, "1.1.0");
  assert.equal(windowsUpdateInstallPromise, null);
});

test("darwin refuses the install without manifest trust and downloads nothing", async (t) => {
  const { steps, handler } = await setupUpdateIpc(t, { overrides: { canInstallUpdateInApp: () => false } });
  const result = await handler({});
  assert.deepEqual(result, { status: "unsupported", reason: "release-manifest-untrusted", currentVersion: "1.0.0" });
  assertNoDownloadOrExit(steps);
});

test("win32 refuses the install without manifest trust and downloads nothing", async (t) => {
  const { steps, handler } = await setupUpdateIpc(t, { platform: "win32", overrides: { canInstallUpdateInApp: () => false } });
  const result = await handler({});
  assert.deepEqual(result, { status: "unsupported", reason: "release-manifest-untrusted", currentVersion: "1.0.0" });
  assertNoDownloadOrExit(steps);
});

test("darwin returns the failed-twice interception result and downloads nothing", async (t) => {
  const blocked = { status: "unsupported", reason: "update-failed-twice", currentVersion: "1.0.0" };
  const { steps, handler } = await setupUpdateIpc(t, { overrides: { updateFailedTwiceResult: async () => blocked } });
  const result = await handler({});
  assert.deepEqual(result, blocked);
  assertNoDownloadOrExit(steps);
});

test("win32 returns the failed-twice interception result and downloads nothing", async (t) => {
  const blocked = { status: "unsupported", reason: "update-failed-twice", currentVersion: "1.0.0" };
  const { steps, handler } = await setupUpdateIpc(t, { platform: "win32", overrides: { updateFailedTwiceResult: async () => blocked } });
  const result = await withWindowsExecPath(() => handler({}));
  assert.deepEqual(result, blocked);
  assertNoDownloadOrExit(steps);
});

test("darwin stops before the download when the staging preflight fails", async (t) => {
  const { steps, handler } = await setupUpdateIpc(t, { overrides: { preflightFreeSpace: async () => false } });
  const result = await handler({});
  assert.deepEqual(result, { status: "error", code: "PREFLIGHT_DISK_SPACE", currentVersion: "1.0.0" });
  assertNoDownloadOrExit(steps);
});

test("win32 stops before the download when the folder preflight fails", async (t) => {
  const beforeDownload = { status: "unsupported", reason: "install-dir-not-writable", currentVersion: "1.0.0" };
  const { steps, handler } = await setupUpdateIpc(t, { platform: "win32", overrides: { windowsInstallPreflight: async () => beforeDownload } });
  const result = await withWindowsExecPath(() => handler({}));
  assert.deepEqual(result, beforeDownload);
  assertNoDownloadOrExit(steps);
});

test("untrusted renderer gets unavailable and nothing is called on darwin", async (t) => {
  const { steps, handler } = await setupUpdateIpc(t, { overrides: { trustedRendererEvent: () => false } });
  const result = await handler({});
  assert.deepEqual(result, { status: "unavailable", currentVersion: "1.0.0" });
  assert.deepEqual(steps, []);
});

test("untrusted renderer gets unavailable and nothing is called on win32", async (t) => {
  const { steps, handler } = await setupUpdateIpc(t, { platform: "win32", overrides: { trustedRendererEvent: () => false } });
  const result = await handler({});
  assert.deepEqual(result, { status: "unavailable", currentVersion: "1.0.0" });
  assert.deepEqual(steps, []);
});
