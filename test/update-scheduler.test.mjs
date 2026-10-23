import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_FIRST_CHECK_DELAY_MS,
  backgroundUpdateGatesPass,
  createUpdateScheduler,
  updateReadyNotificationCopy,
} from "../desktop/update-scheduler.mjs";
import { createReleaseManifestTrust } from "../lib/release-manifest-signature.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const RELEASE = Object.freeze({
  updateAvailable: true,
  latestVersion: "0.3.5",
  notes: { zh: "修复了一些问题。", en: "Fixed some issues." },
  macArtifact: { file: "MOSA-darwin-arm64-0.3.5.zip" },
  windowsArtifact: { file: "MOSA-win32-x64-0.3.5.zip" },
});

// A stand-in for the event loop: scheduled callbacks are kept in a map and
// fired explicitly, so the cadence is tested without real waiting. A fire()
// call only runs the callbacks pending at call time — timers scheduled while
// firing (the next chained tick) wait for a later fire, like a real clock.
function manualTimers() {
  const pending = new Map();
  let sequence = 0;
  return {
    setTimeout(fn, ms) {
      const id = ++sequence;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    scheduledCount() {
      return pending.size;
    },
    async fire(maxMs) {
      const due = [...pending.entries()].filter(([, entry]) => entry.ms <= maxMs);
      for (const [id, entry] of due) {
        if (!pending.has(id)) continue;
        pending.delete(id);
        await entry.fn();
      }
    },
  };
}

function baseSchedulerOverrides(timers) {
  return {
    gatesPass: () => true,
    checkForUpdate: async () => RELEASE,
    artifactForPlatform: (release) => release.macArtifact,
    downloadUpdate: async () => ({ zipPath: "/staging/zip" }),
    isInstallInProgress: () => false,
    onUpdateReady: () => {},
    showReadyNotification: () => {},
    firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
    checkIntervalMs: UPDATE_CHECK_INTERVAL_MS,
    timer: timers,
  };
}

test("background update gates refuse unpackaged, QA, untrusted and unsupported-location builds", () => {
  const trust = createReleaseManifestTrust(generateKeyPairSync("ed25519").publicKey);
  const base = { isPackaged: true, qaRun: false, releaseManifestTrust: trust, platform: "darwin", installLocation: { installAppPath: "/Applications/GravityPort.app", supported: true } };
  assert.equal(backgroundUpdateGatesPass(base), true);
  assert.equal(backgroundUpdateGatesPass({ ...base, isPackaged: false }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, qaRun: true }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, qaRun: "1" }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, releaseManifestTrust: null }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, releaseManifestTrust: "garbage" }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, installLocation: { installAppPath: null, supported: false } }), false);
  assert.equal(backgroundUpdateGatesPass({ ...base, installLocation: { installAppPath: "/Applications/GravityPort.app", supported: false } }), false);
  // Windows has no install-location gate; other gates still apply.
  assert.equal(backgroundUpdateGatesPass({ ...base, platform: "win32", installLocation: null }), true);
  assert.equal(backgroundUpdateGatesPass({ ...base, platform: "linux" }), false);
});

test("update-ready notification copy exists for both languages", () => {
  assert.deepEqual(updateReadyNotificationCopy("0.3.5", "zh"), { title: "GravityPort 0.3.5 已准备好", body: "重启 GravityPort 即可完成更新。" });
  assert.deepEqual(updateReadyNotificationCopy("0.3.5", "en"), { title: "GravityPort 0.3.5 is ready", body: "Restart GravityPort to finish updating." });
});

test("gated builds never schedule a check or touch the manifest", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let checks = 0;
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    gatesPass: () => false,
    checkForUpdate: async () => {
      checks += 1;
      return RELEASE;
    },
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  await timers.fire(UPDATE_CHECK_INTERVAL_MS * 5);
  assert.equal(checks, 0);
  assert.equal(scheduler.readyPayload(), null);
});

test("first check runs after the initial delay, then on the interval; each version is announced once", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let checks = 0;
  const ready = [];
  const notifications = [];
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    checkForUpdate: async () => {
      checks += 1;
      return RELEASE;
    },
    onUpdateReady: (payload) => ready.push(payload),
    showReadyNotification: (payload) => notifications.push(payload.version),
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  assert.equal(checks, 0, "nothing runs before the first scheduled tick");
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS - 1);
  assert.equal(checks, 0);
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  assert.equal(checks, 1);
  assert.deepEqual(ready, [{ version: "0.3.5", notes: RELEASE.notes }]);
  assert.deepEqual(notifications, ["0.3.5"]);
  assert.deepEqual(JSON.parse(await readFile(join(root, "notified.json"), "utf8")), ["0.3.5"]);

  // The interval cycle re-checks but must not announce the same version again.
  await timers.fire(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks, 2);
  assert.equal(ready.length, 2);
  assert.deepEqual(notifications, ["0.3.5"]);

  // A newer release announces again.
  const second = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    checkForUpdate: async () => ({ ...RELEASE, latestVersion: "0.3.6" }),
    onUpdateReady: (payload) => ready.push(payload),
    showReadyNotification: (payload) => notifications.push(payload.version),
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await second.start();
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  assert.deepEqual(notifications, ["0.3.5", "0.3.6"]);
  scheduler.stop();
  second.stop();
});

test("a package staged by a previous launch is announced immediately at startup", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const stagingRoot = join(root, "updates", "macos");
  await mkdir(join(stagingRoot, "0.3.5"), { recursive: true });
  await writeFile(join(stagingRoot, "0.3.5", "MOSA-darwin-arm64-0.3.5.zip"), Buffer.from("staged"));
  let checks = 0;
  const ready = [];
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    checkForUpdate: async () => {
      checks += 1;
      return RELEASE;
    },
    onUpdateReady: (payload) => ready.push(payload),
    stagingRoot,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  assert.equal(checks, 1, "startup validates the staged package without waiting for the timer");
  assert.deepEqual(ready, [{ version: "0.3.5", notes: RELEASE.notes }]);
  assert.equal(scheduler.readyPayload().version, "0.3.5");
  scheduler.stop();
});

test("a failed background download stays silent and the next cycle retries", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let attempts = 0;
  const ready = [];
  const notifications = [];
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    downloadUpdate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network unavailable");
      return { zipPath: "/staging/zip" };
    },
    onUpdateReady: (payload) => ready.push(payload),
    showReadyNotification: (payload) => notifications.push(payload.version),
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  assert.equal(attempts, 1);
  assert.deepEqual(ready, [], "a failed download never reaches the renderer");
  assert.deepEqual(notifications, []);
  assert.equal(scheduler.readyPayload(), null);
  await timers.fire(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(attempts, 2);
  assert.deepEqual(ready, [{ version: "0.3.5", notes: RELEASE.notes }]);
  assert.deepEqual(notifications, ["0.3.5"]);
  scheduler.stop();
});

test("a version already announced in a previous session skips the system notification but still readies", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const notifiedPath = join(root, "notified.json");
  await writeFile(notifiedPath, JSON.stringify(["0.3.5"]), "utf8");
  const ready = [];
  const notifications = [];
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    onUpdateReady: (payload) => ready.push(payload),
    showReadyNotification: (payload) => notifications.push(payload.version),
    stagingRoot: root,
    notifiedVersionsPath: notifiedPath,
  });
  await scheduler.start();
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  assert.deepEqual(ready, [{ version: "0.3.5", notes: RELEASE.notes }]);
  assert.deepEqual(notifications, []);
  scheduler.stop();
});

test("a manual install that owns the staging root pauses the background cycle", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let checks = 0;
  let installing = true;
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    checkForUpdate: async () => {
      checks += 1;
      return RELEASE;
    },
    isInstallInProgress: () => installing,
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  await timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  assert.equal(checks, 0, "no cycle while an install is in progress");
  installing = false;
  await timers.fire(UPDATE_CHECK_INTERVAL_MS);
  assert.equal(checks, 1);
  scheduler.stop();
});

test("stop() cancels the pending timer and the in-flight download", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let aborted = null;
  let checks = 0;
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    checkForUpdate: async () => {
      checks += 1;
      return RELEASE;
    },
    downloadUpdate: async (_release, { signal }) => {
      aborted = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  await scheduler.start();
  const fired = timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  while (!aborted) await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  scheduler.stop();
  await fired;
  assert.ok(aborted?.aborted, "the in-flight download is aborted on stop");
  assert.equal(timers.scheduledCount(), 0, "no timer survives stop()");
  assert.equal(checks, 1);
});

test("cancelDownload() aborts the in-flight background download but keeps the cadence", async (t) => {
  const timers = manualTimers();
  const root = await mkdtemp(join(tmpdir(), "mosa-update-sched-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  let signalSeen = null;
  let ready = 0;
  const scheduler = createUpdateScheduler({
    ...baseSchedulerOverrides(timers),
    downloadUpdate: async (_release, { signal }) => {
      signalSeen = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    onUpdateReady: () => { ready += 1; },
    stagingRoot: root,
    notifiedVersionsPath: join(root, "notified.json"),
  });
  t.after(() => scheduler.stop());
  await scheduler.start();
  const fired = timers.fire(UPDATE_FIRST_CHECK_DELAY_MS);
  while (!signalSeen) await new Promise((resolveWait) => setTimeout(resolveWait, 0));
  scheduler.cancelDownload();
  await fired;
  assert.ok(signalSeen.aborted, "the background download is aborted");
  assert.equal(ready, 0, "an aborted download never announces update-ready");
  assert.equal(timers.scheduledCount(), 1, "the next scheduled check survives");
});
