// Misc IPC handlers moved out of desktop/main.mjs registerIPC (task 396). Pure moves; no behavior changes.

export function registerMiscIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    access,
    join,
    dirname,
    mkdirSync,
    writeFileSync,
    shell,
    app,
    managedBrowserExtensionTarget,
    backgroundCaptureSupported,
    readBackgroundCaptureSetting,
    writeBackgroundCaptureSetting,
    syncPackagedBackgroundAgent,
    desktopDataDir,
    buildMenu,
    evaluateMacosInstallLocation,
    buildMcpClientConfig,
    appRoot,
    LIBRARY_LOCATION_PATH,
    acknowledgeRenameNotice,
    macosUpdateReadyFile,
    windowsUpdateReadyFile,
    expectedServiceIdentity,
    releaseBridgesAfterUpdateReady,
    screenGuard,
    openExternalLinkByPolicy,
    updateDialogText,
    showSystemDialog,
    getService,
    getRenameNotice,
    setRenameNotice,
    getCurrentLocale,
    setCurrentLocale,
    getMainWindow,
  } = deps;
  ipcMain.handle("reveal-managed-extension-folder", async (event) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    const manifestPath = join(managedBrowserExtensionTarget, "manifest.json");
    try {
      await access(manifestPath);
      // Select the extension folder itself in its parent: that folder is what
      // Chrome's 加载已解压的扩展程序 asks for. Selecting manifest.json opened
      // the folder's contents and hid which folder to pick.
      shell.showItemInFolder(managedBrowserExtensionTarget);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle("background-capture-state", async (event) => {
    if (!trustedRendererEvent(event)) return { supported: false, enabled: false };
    return {
      supported: backgroundCaptureSupported(),
      enabled: readBackgroundCaptureSetting(desktopDataDir).enabled,
    };
  });

  ipcMain.handle("set-background-capture", async (event, enabled) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    if (typeof enabled !== "boolean") return { ok: false };
    const previous = readBackgroundCaptureSetting(desktopDataDir).enabled;
    if (!backgroundCaptureSupported()) return { ok: false, enabled: previous };
    try {
      writeBackgroundCaptureSetting(desktopDataDir, enabled);
      const result = await syncPackagedBackgroundAgent(enabled);
      if (!result.ok) {
        writeBackgroundCaptureSetting(desktopDataDir, previous);
        await syncPackagedBackgroundAgent(previous);
        return { ok: false, enabled: previous };
      }
      return { ok: true, enabled };
    } catch (error) {
      console.warn(`[MOSA] background capture agent: settings failed: ${error?.message || error}`);
      try { writeBackgroundCaptureSetting(desktopDataDir, previous); } catch {}
      return { ok: false, enabled: previous };
    }
  });

  ipcMain.handle("set-locale", async (event, locale) => {
    if (!trustedRendererEvent(event)) return false;
    if (locale !== "zh" && locale !== "en") return false;
    if (locale === getCurrentLocale()) return true;
    setCurrentLocale(locale);
    buildMenu();
    return true;
  });

  // Settings → Connections: a ready-to-paste config that runs the bundled MCP
  // server with this executable in Node mode. It names the library-location
  // file rather than the library, so moving the library keeps it valid.
  ipcMain.handle("mcp-client-config", async (event) => {
    if (!trustedRendererEvent(event)) return { available: false };
    let installWarning = null;
    if (process.platform === "darwin" && app.isPackaged) {
      const location = evaluateMacosInstallLocation(process.execPath);
      if (location.reason === "app-translocation" || !String(location.installAppPath || "").startsWith("/Applications/")) {
        installWarning = "not-in-applications";
      }
    }
    return {
      available: true,
      platform: process.platform,
      installWarning,
      ...buildMcpClientConfig({
        platform: process.platform,
        execPath: process.execPath,
        serverPath: join(appRoot, "mcp", "server.mjs"),
        libraryLocationFile: LIBRARY_LOCATION_PATH,
        managedLibraryDir: process.env.MOSA_LIBRARY_DIR || "",
      }),
    };
  });

  // 审查 3-6 甲（任务 318）:the user-profile channel is gone — the installation
  // ID stays in the main process (anonymous-usage bookkeeping) and is never
  // handed to the renderer.

  // Task 311: the client credential no longer travels in the URL fragment. The
  // renderer asks once before its first request; the main process answers only
  // when the invoke comes from the main window's main frame while that frame
  // sits on the origin of the service this launch verified (an owned runtime,
  // or one that passed the challenge) — trustedRendererEvent enforces all four
  // conditions together with the service reference.
  ipcMain.handle("get-client-token", (event) => {
    if (!trustedRendererEvent(event)) return "";
    return getService()?.clientToken || "";
  });

  // 任务 116：老用户「已更名」提示。状态在启动最早期已判定（见 renameNotice），
  // 这里只读快照；确认写 acknowledged 并同步内存快照，写失败只记日志（下次
  // 启动还会弹，符合「没确认就算未读」）。
  ipcMain.handle("rename-notice-state", async (event) => {
    if (!trustedRendererEvent(event)) {
      return { shouldShow: false, state: getRenameNotice().state, persisted: getRenameNotice().persisted };
    }
    return { ...getRenameNotice() };
  });

  ipcMain.handle("acknowledge-rename-notice", async (event) => {
    if (!trustedRendererEvent(event)) return false;
    acknowledgeRenameNotice({
      userDataDir: desktopDataDir,
      log: (line) => console.warn(`[MOSA] ${line}`),
    });
    setRenameNotice({ shouldShow: false, state: "acknowledged", persisted: true });
    return true;
  });

  ipcMain.handle("renderer-ready", async (event) => {
    if (!trustedRendererEvent(event)) return false;
    if (!getService()) return false;
    const updateReadyFiles = [macosUpdateReadyFile, windowsUpdateReadyFile].filter(Boolean);
    for (const readyFile of updateReadyFiles) {
      try {
        mkdirSync(dirname(readyFile), { recursive: true });
        writeFileSync(readyFile, JSON.stringify({
          version: app.getVersion(),
          gitSha: expectedServiceIdentity.gitSha,
          uiFingerprint: expectedServiceIdentity.uiFingerprint,
          runtimeFingerprint: expectedServiceIdentity.runtimeFingerprint,
          distribution: expectedServiceIdentity.distribution,
          readyAt: new Date().toISOString(),
          port: getService().port,
        }), "utf8");
      } catch (error) {
        console.error(`[MOSA] unable to report post-update readiness: ${error?.message || error}`);
        releaseBridgesAfterUpdateReady();
        return false;
      }
    }
    releaseBridgesAfterUpdateReady();
    return true;
  });

  ipcMain.handle("open-pinterest-authorize", async (event, url) => {
    if (!trustedRendererEvent(event)) return { ok: false };

    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || parsed.hostname !== "www.pinterest.com" || parsed.pathname !== "/oauth/") {
        return { ok: false };
      }
      await screenGuard.openExternal(url);
      return { ok: true };
    } catch (error) {
      console.warn(`[MOSA] unable to open Pinterest authorize page: ${error?.message || error}`);
      return { ok: false };
    }
  });

  // 任务 147:打开 Pinterest Pin / 外链的普通网址(窗口 setWindowOpenHandler 全拒,
  // 渲染层没有别的出站通道);只认主窗口。审查 3-6 甲（任务 318）:目的地按用途
  // 限域名(externalLinkDecision),白名单外的 http/https 先弹系统确认框,用户
  // 取消不算失败({ ok: true, opened: false }),网址校验在 open-external-link.mjs。
  ipcMain.handle("open-external-link", async (event, url) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    return openExternalLinkByPolicy({
      url,
      dialogText: updateDialogText,
      confirmDialog: (options) => showSystemDialog(options),
      openExternal: (href) => screenGuard.openExternal(href),
      warn: (line) => console.warn(line),
    });
  });

  // 任务 96（A6）：渲染层写窗口系统全屏（大图页「全屏」双向同步）。只接受主窗口
  // 自己的调用；flag 不是 true 就退全屏（与 preload 的 `flag === true` 归一口径一致）。
  ipcMain.handle("set-window-full-screen", (event, flag) => {
    if (!trustedRendererEvent(event)) return { ok: false };
    getMainWindow().setFullScreen(flag === true);
    return { ok: true, isFullScreen: getMainWindow().isFullScreen() };
  });

}
