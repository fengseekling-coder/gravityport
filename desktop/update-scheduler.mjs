// Main-process update cadence (task 231). The renderer no longer auto-checks:
// this module checks the release manifest shortly after startup and then on a
// fixed interval, downloads a newer release into the existing staging root in
// the background, and announces a verified staged package to the renderer so a
// persistent restart-to-update affordance can be shown. Everything Electron-
// specific is injected, so the cadence logic is unit-testable in isolation.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canInstallUpdateInApp } from "./update-service.mjs";

export const UPDATE_FIRST_CHECK_DELAY_MS = 2 * 60 * 1000;
export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// One gate for every reason a build must never check for or download updates:
// unpackaged dev runs, QA isolation runs, builds without the release public
// key, platforms without an in-app updater, and a macOS install location that
// must not be replaced in place.
export function backgroundUpdateGatesPass({
  isPackaged,
  qaRun,
  releaseManifestTrust,
  platform,
  installLocation,
} = {}) {
  if (!isPackaged || qaRun) return false;
  if (!canInstallUpdateInApp(releaseManifestTrust)) return false;
  if (platform === "darwin") {
    if (!installLocation?.installAppPath || installLocation.supported !== true) return false;
  } else if (platform !== "win32") {
    return false;
  }
  return true;
}

// The system notification for a verified staged package. It lives here because
// desktop/notification-i18n.mjs only carries the pre-existing update copies.
export function updateReadyNotificationCopy(version, language = "zh") {
  if (language === "en") {
    return { title: `GravityPort ${version} is ready`, body: "Restart GravityPort to finish updating." };
  }
  return { title: `GravityPort ${version} 已准备好`, body: "重启 GravityPort 即可完成更新。" };
}

const MAX_NOTIFIED_VERSIONS = 20;

export function createUpdateScheduler({
  gatesPass,
  checkForUpdate,
  artifactForPlatform,
  downloadUpdate,
  isInstallInProgress = () => false,
  // A version whose installs failed twice is not downloaded or announced again;
  // the failure dialog points the user to the download page instead.
  isVersionBlocked = () => false,
  onUpdateReady,
  showReadyNotification,
  stagingRoot,
  notifiedVersionsPath,
  firstCheckDelayMs = UPDATE_FIRST_CHECK_DELAY_MS,
  checkIntervalMs = UPDATE_CHECK_INTERVAL_MS,
  timer = { setTimeout, clearTimeout },
} = {}) {
  let stopped = true;
  let checkTimer = null;
  let cycleInFlight = false;
  let downloadAbort = null;
  let readyUpdate = null;

  function readyPayload() {
    if (!readyUpdate || isVersionBlocked(readyUpdate.version)) return null;
    return { version: readyUpdate.version, notes: readyUpdate.notes };
  }

  async function loadNotifiedVersions() {
    try {
      const parsed = JSON.parse(await readFile(notifiedVersionsPath, "utf8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim());
    } catch {
      return [];
    }
  }

  // A staged package means any release ZIP under the updater staging root; the
  // per-artifact size and SHA-256 decision happens inside downloadUpdate
  // against the freshly fetched manifest.
  async function hasStagedPackage() {
    try {
      const versionDirs = await readdir(stagingRoot, { withFileTypes: true });
      for (const entry of versionDirs) {
        if (!entry.isDirectory()) continue;
        const files = await readdir(join(stagingRoot, entry.name)).catch(() => []);
        if (files.some((name) => name.toLowerCase().endsWith(".zip"))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async function runCycle() {
    if (cycleInFlight || stopped || !gatesPass() || isInstallInProgress()) return;
    cycleInFlight = true;
    downloadAbort = new AbortController();
    try {
      const release = await checkForUpdate();
      if (stopped || !release?.updateAvailable) return;
      if (isVersionBlocked(release.latestVersion)) return;
      if (!artifactForPlatform(release)) return;
      try {
        await downloadUpdate(release, { signal: downloadAbort.signal });
      } catch {
        // A failed background download stays silent: the next scheduled cycle
        // retries, and the renderer is never told about the attempt.
        return;
      }
      if (stopped) return;
      const payload = { version: release.latestVersion, notes: release.notes };
      readyUpdate = payload;
      onUpdateReady(readyPayload());
      const notified = await loadNotifiedVersions();
      if (!notified.includes(payload.version)) {
        try {
          const versions = [...notified, payload.version].slice(-MAX_NOTIFIED_VERSIONS);
          await mkdir(dirname(notifiedVersionsPath), { recursive: true });
          await writeFile(notifiedVersionsPath, JSON.stringify(versions), "utf8");
          showReadyNotification(payload);
        } catch {
          // The announcement waits for a cycle that can persist its marker, so
          // one version is never announced to the user twice.
        }
      }
    } catch {
      // Manifest fetch failures stay silent; the next scheduled cycle retries.
    } finally {
      cycleInFlight = false;
      downloadAbort = null;
    }
  }

  function scheduleNext(delayMs) {
    if (stopped) return;
    checkTimer = timer.setTimeout(async () => {
      await runCycle();
      scheduleNext(checkIntervalMs);
    }, delayMs);
    checkTimer.unref?.();
  }

  return {
    start() {
      if (!stopped) return Promise.resolve();
      if (!gatesPass()) return Promise.resolve();
      stopped = false;
      // A package staged by a previous launch is announced immediately: read
      // the manifest once and let downloadUpdate validate the local file,
      // without waiting for the first timed check.
      return hasStagedPackage().then(async (staged) => {
        if (stopped) return;
        if (staged) await runCycle();
        scheduleNext(firstCheckDelayMs);
      });
    },
    stop() {
      stopped = true;
      if (checkTimer) {
        timer.clearTimeout(checkTimer);
        checkTimer = null;
      }
      downloadAbort?.abort(new Error("Update scheduler stopped."));
      downloadAbort = null;
    },
    // A manual install owns the staging root: abort a background download in
    // flight so the two never write the same directory. The next scheduled
    // cycle runs again (it skips while the install is in progress).
    cancelDownload() {
      downloadAbort?.abort(new Error("Update download taken over by a manual install."));
    },
    readyPayload,
  };
}
