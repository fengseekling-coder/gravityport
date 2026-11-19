// Update IPC handlers (check, ready state, download/install, cancel, download page) moved out of desktop/main.mjs registerIPC (task 406). Pure moves; no behavior changes.
import { mkdir } from "node:fs/promises";
import { canInstallUpdateInApp as defaultCanInstallUpdateInApp, checkForMosaUpdate as defaultCheckForMosaUpdate, macosUpdateArchForHost, MOSA_DOWNLOAD_PAGE_URL } from "../update-service.mjs";
import { recordUpdateAttempt as defaultRecordUpdateAttempt } from "../update-failures.mjs";
import { requiredDownloadBytes, requiredInstallBytes } from "../update-preflight.mjs";
import { downloadMacosUpdate as defaultDownloadMacosUpdate, launchMacosUpdateHelper as defaultLaunchMacosUpdateHelper } from "../macos-updater.mjs";
import { downloadWindowsUpdate as defaultDownloadWindowsUpdate, launchWindowsUpdateHelper as defaultLaunchWindowsUpdateHelper, windowsInstalledExeName } from "../windows-updater.mjs";

export let macosUpdateInstallPromise = null;
let macosUpdateDownloadController = null;
export let windowsUpdateInstallPromise = null;
let windowsUpdateDownloadController = null;

export function registerUpdateIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    app,
    dirname,
    desktopDataDir,
    expectedServiceIdentity,
    evaluateMacosInstallLocation,
    screenGuard,
    stopOwnedRuntime,
    getMainWindow,
    getLibraryDir,
    runUpdateCheck,
    updateScheduler,
    systemNetworkFetch,
    releaseManifestVerificationTrusts,
    updateFailedTwiceResult,
    preflightFreeSpace,
    windowsInstallPreflight,
    stopBridgeNotificationPoll,
    stopAnonymousUsageLifecycle,
    releaseDesktopStartupHandoff,
    MACOS_UPDATE_STAGING_ROOT,
    WINDOWS_UPDATE_STAGING_ROOT,
    isolationContext,
    setShuttingDown,
    // Task 447: module-level imports turned into overridable deps so behavior
    // tests can drive the install flow with recording fakes. Defaults keep the
    // production wiring identical (main.mjs still passes none of these).
    canInstallUpdateInApp = defaultCanInstallUpdateInApp,
    checkForMosaUpdate = defaultCheckForMosaUpdate,
    recordUpdateAttempt = defaultRecordUpdateAttempt,
    downloadMacosUpdate = defaultDownloadMacosUpdate,
    launchMacosUpdateHelper = defaultLaunchMacosUpdateHelper,
    downloadWindowsUpdate = defaultDownloadWindowsUpdate,
    launchWindowsUpdateHelper = defaultLaunchWindowsUpdateHelper,
    platform = process.platform,
  } = deps;
  ipcMain.handle("check-for-updates", async (event, notify = false) => {
    if (!trustedRendererEvent(event)) return { status: "unavailable", currentVersion: app.getVersion() };
    return runUpdateCheck({ notify: notify === true });
  });

  // Task 231: the renderer mirrors the main process's "verified package is
  // staged" state — queried once on mount (the window may open after the
  // announcement) and pushed live through the update-ready event.
  ipcMain.handle("get-update-ready", (event) => {
    if (!trustedRendererEvent(event)) return null;
    return updateScheduler.readyPayload();
  });

  ipcMain.handle("download-and-install-update", async (event) => {
    if (!trustedRendererEvent(event)) return { status: "unavailable", currentVersion: app.getVersion() };
    if (!app.isPackaged || isolationContext.qaRun) {
      return { status: "unsupported", currentVersion: app.getVersion() };
    }
    if (!canInstallUpdateInApp(expectedServiceIdentity.releaseManifestTrust)) {
      return { status: "unsupported", reason: "release-manifest-untrusted", currentVersion: app.getVersion() };
    }
    if (platform === "darwin") {
      if (macosUpdateInstallPromise) return macosUpdateInstallPromise;
      updateScheduler.cancelDownload();
      macosUpdateInstallPromise = (async () => {
        const controller = new AbortController();
        macosUpdateDownloadController = controller;
        try {
          const release = await checkForMosaUpdate({
            fetchImpl: systemNetworkFetch,
            currentVersion: app.getVersion(),
            currentDistribution: expectedServiceIdentity.distribution,
            releaseManifestTrust: releaseManifestVerificationTrusts(),
            macArch: macosUpdateArchForHost({ arch: process.arch, runningUnderARM64Translation: app.runningUnderARM64Translation }),
          });
          if (!release.updateAvailable) return { status: "current", currentVersion: release.currentVersion };
          if (!release.macArtifact) return { status: "unavailable", currentVersion: release.currentVersion };
          const blocked = await updateFailedTwiceResult(release.latestVersion, release.currentVersion);
          if (blocked) return blocked;
          const installLocation = evaluateMacosInstallLocation(process.execPath);
          if (!installLocation.installAppPath) return { status: "unsupported", currentVersion: release.currentVersion };
          if (!installLocation.supported) {
            // Gatekeeper translocation or a non-writable install directory:
            // never try an in-place replacement from there.
            return {
              status: "unavailable",
              reason: "install-location-unsupported",
              currentVersion: release.currentVersion,
            };
          }
          await mkdir(MACOS_UPDATE_STAGING_ROOT, { recursive: true }).catch(() => {});
          if (!(await preflightFreeSpace({
            dir: MACOS_UPDATE_STAGING_ROOT,
            requiredBytes: requiredDownloadBytes(release.macArtifact.size),
          }))) return { status: "error", code: "PREFLIGHT_DISK_SPACE", currentVersion: release.currentVersion };
          const download = await downloadMacosUpdate({
            fetchImpl: systemNetworkFetch,
            artifact: release.macArtifact,
            version: release.latestVersion,
            stagingRoot: MACOS_UPDATE_STAGING_ROOT,
            signal: controller.signal,
            onProgress: (progress) => {
              if (!getMainWindow() || getMainWindow().isDestroyed()) return;
              getMainWindow().webContents.send("update-download-progress", progress);
            },
          });
          if (macosUpdateDownloadController === controller) macosUpdateDownloadController = null;
          if (!(await preflightFreeSpace({
            dir: dirname(installLocation.installAppPath),
            requiredBytes: requiredInstallBytes(release.macArtifact.size),
          }))) return { status: "error", code: "PREFLIGHT_DISK_SPACE", currentVersion: release.currentVersion };
          await launchMacosUpdateHelper({
            zipPath: download.zipPath,
            installAppPath: installLocation.installAppPath,
            version: release.latestVersion,
            expectedIdentity: release.buildIdentity,
            appName: release.macArtifact.appName,
            expectedTeamIdentifier: release.macArtifact.teamIdentifier || "",
            expectedArch: release.macArtifact.arch,
            processId: process.pid,
            libraryDir: getLibraryDir(),
          });
          // Recorded before the App exits so the next launch can tell whether
          // the new version came up (see settleUpdateAttempt).
          await recordUpdateAttempt({ userDataDir: desktopDataDir, version: release.latestVersion, platform: "macos" });
          setShuttingDown(true);
          stopBridgeNotificationPoll();
          stopAnonymousUsageLifecycle();
          updateScheduler.stop();
          await stopOwnedRuntime();
          await releaseDesktopStartupHandoff();
          app.exit(0);
          return { status: "installing", latestVersion: release.latestVersion };
        } catch (error) {
          if (controller.signal.aborted) {
            return { status: "cancelled", currentVersion: app.getVersion() };
          }
          console.warn(`[MOSA] macOS update failed: ${error?.message || error}`);
          return { status: "error", currentVersion: app.getVersion(), code: "MACOS_UPDATE_FAILED" };
        } finally {
          if (macosUpdateDownloadController === controller) macosUpdateDownloadController = null;
        }
      })().finally(() => { macosUpdateInstallPromise = null; });
      return macosUpdateInstallPromise;
    }
    if (platform !== "win32") {
      return { status: "unsupported", currentVersion: app.getVersion() };
    }
    if (windowsUpdateInstallPromise) return windowsUpdateInstallPromise;
    updateScheduler.cancelDownload();
    windowsUpdateInstallPromise = (async () => {
      const controller = new AbortController();
      windowsUpdateDownloadController = controller;
      try {
      // Re-read the first-party manifest in the trusted main process instead of
      // accepting a renderer-supplied URL, filename or digest.
      const release = await checkForMosaUpdate({
        fetchImpl: systemNetworkFetch,
        currentVersion: app.getVersion(),
        currentDistribution: expectedServiceIdentity.distribution,
        releaseManifestTrust: releaseManifestVerificationTrusts(),
        macArch: macosUpdateArchForHost({ arch: process.arch, runningUnderARM64Translation: app.runningUnderARM64Translation }),
      });
      if (!release.updateAvailable) return { status: "current", currentVersion: release.currentVersion };
      if (!release.windowsArtifact) return { status: "unavailable", currentVersion: release.currentVersion };
      // Old installs keep MOSA.exe, new installs keep GravityPort.exe, and
      // every relaunch path stays on the current name. An unrecognized
      // executable name must stop the update before anything is downloaded
      // or replaced.
      const installedExeName = windowsInstalledExeName();
      if (!installedExeName) return { status: "unsupported", currentVersion: release.currentVersion };
      const blocked = await updateFailedTwiceResult(release.latestVersion, release.currentVersion);
      if (blocked) return blocked;
      const installDir = dirname(process.execPath);
      await mkdir(WINDOWS_UPDATE_STAGING_ROOT, { recursive: true }).catch(() => {});
      if (!(await preflightFreeSpace({
        dir: WINDOWS_UPDATE_STAGING_ROOT,
        requiredBytes: requiredDownloadBytes(release.windowsArtifact.size),
      }))) return { status: "error", code: "PREFLIGHT_DISK_SPACE", currentVersion: release.currentVersion };
      const beforeDownload = await windowsInstallPreflight(installDir, release.currentVersion);
      if (beforeDownload) return beforeDownload;
      const download = await downloadWindowsUpdate({
        fetchImpl: systemNetworkFetch,
        artifact: release.windowsArtifact,
        version: release.latestVersion,
        stagingRoot: WINDOWS_UPDATE_STAGING_ROOT,
        signal: controller.signal,
        onProgress: (progress) => {
          if (!getMainWindow() || getMainWindow().isDestroyed()) return;
          getMainWindow().webContents.send("update-download-progress", progress);
        },
      });
      if (windowsUpdateDownloadController === controller) windowsUpdateDownloadController = null;
      // The download took time: check the folder and the running assistants again.
      if (!(await preflightFreeSpace({
        dir: dirname(installDir),
        requiredBytes: requiredInstallBytes(release.windowsArtifact.size),
      }))) return { status: "error", code: "PREFLIGHT_DISK_SPACE", currentVersion: release.currentVersion };
      const beforeLaunch = await windowsInstallPreflight(installDir, release.currentVersion);
      if (beforeLaunch) return beforeLaunch;
      await launchWindowsUpdateHelper({
        zipPath: download.zipPath,
        installDir,
        currentExeName: installedExeName,
        payloadExeName: release.windowsArtifact.payloadExeName,
        signerThumbprint: release.windowsArtifact.signerThumbprint || "",
        version: release.latestVersion,
        expectedIdentity: release.buildIdentity,
        processId: process.pid,
      });
      await recordUpdateAttempt({ userDataDir: desktopDataDir, version: release.latestVersion, platform: "windows" });

      // Give the external helper exclusive ownership of the replacement only
      // after MOSA has drained its local service and released SQLite/runtime locks.
      setShuttingDown(true);
      stopBridgeNotificationPoll();
      stopAnonymousUsageLifecycle();
      updateScheduler.stop();
      await stopOwnedRuntime();
      app.exit(0);
      return { status: "installing", latestVersion: release.latestVersion };
      } catch (error) {
        if (controller.signal.aborted) {
          return { status: "cancelled", currentVersion: app.getVersion() };
        }
        console.warn(`[MOSA] Windows update failed: ${error?.message || error}`);
        return { status: "error", currentVersion: app.getVersion(), code: "WINDOWS_UPDATE_FAILED" };
      } finally {
        if (windowsUpdateDownloadController === controller) windowsUpdateDownloadController = null;
      }
    })().finally(() => { windowsUpdateInstallPromise = null; });
    return windowsUpdateInstallPromise;
  });

  ipcMain.handle("cancel-update-download", async (event) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const controller = platform === "darwin" ? macosUpdateDownloadController : windowsUpdateDownloadController;
    if (!controller || controller.signal.aborted) return { ok: false };
    controller.abort(new Error("GravityPort update download cancelled by the user."));
    return { ok: true };
  });

  ipcMain.handle("open-download-page", async (event) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    try {
      await screenGuard.openExternal(MOSA_DOWNLOAD_PAGE_URL);
      return { ok: true };
    } catch (error) {
      console.warn(`[MOSA] unable to open download page: ${error?.message || error}`);
      return { ok: false };
    }
  });
}
