// Library-location IPC handler moved out of desktop/main.mjs registerIPC (task 396). Pure moves; no behavior changes.

export function registerLibraryLocationIpc(deps) {
  const {
    ipcMain,
    trustedRendererEvent,
    app,
    resolve,
    rm,
    screenGuard,
    getDesktopText,
    validateRelocationTarget,
    writeRelocationMarker,
    stopOwnedRuntime,
    copyLibraryForRelocationGuarded,
    removeRelocationMarker,
    relocationFailureReason,
    saveLibraryDir,
    getMainWindow,
    getCurrentLocale,
    getLibraryDir,
    setLibraryDir,
    getService,
    setService,
  } = deps;
  ipcMain.handle("change-library-location", async (event) => {
    if (!trustedRendererEvent(event)) return { ok: false, reason: "unavailable" };
    // An explicit environment override is an administrator/developer contract;
    // do not let a renderer preference silently fight it on the next launch.
    if (process.env.MOSA_LIBRARY_DIR) return { ok: false, reason: "managed" };
    if (getService()?.mode !== "owned") return { ok: false, reason: "attached" };

    // 任务 359（NATIVE-16）：选择器文字进 notification-i18n 表。
    const selection = await screenGuard.openDialog(getMainWindow(), {
      title: getDesktopText("chooseLibraryLocationTitle", getCurrentLocale()),
      buttonLabel: getDesktopText("chooseLibraryLocationButton", getCurrentLocale()),
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths?.[0]) return { ok: false, reason: "cancelled" };

    const nextLibraryDir = resolve(selection.filePaths[0]);
    const validation = await validateRelocationTarget({ currentLibraryDir: getLibraryDir(), nextLibraryDir });
    if (!validation.ok) return { ok: false, reason: validation.reason };

    // 任务 359（NATIVE-17）：确认框文字进 notification-i18n 表。
    const confirmation = await screenGuard.messageBox(getMainWindow(), {
      type: "question",
      title: getDesktopText("moveLibraryTitle", getCurrentLocale()),
      message: getDesktopText("moveLibraryMessage", getCurrentLocale()),
      detail: getDesktopText("moveLibraryDetail", getCurrentLocale()),
      buttons: [getDesktopText("moveLibraryCancel", getCurrentLocale()), getDesktopText("moveLibraryRestart", getCurrentLocale())],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { ok: false, reason: "cancelled" };

    const previousLibraryDir = getLibraryDir();
    // The marker goes down before the runtime stops: the desktop MCP checks it
    // before every tools/call, so from here on no MCP write can vanish with
    // the old library. A marker that cannot be written means the move cannot
    // be guarded, so it never starts.
    try {
      await writeRelocationMarker({ libraryDir: previousLibraryDir, pid: process.pid });
    } catch (error) {
      console.error(`[MOSA] library relocation marker could not be written: ${error?.stack || error}`);
      return { ok: false, reason: "copy-failed" };
    }
    try {
      await stopOwnedRuntime();
      setService(null);
      // The runtime lock has been released by stopOwnedRuntime(), and the copy
      // skips the lock file and the relocation marker. The guarded copy also
      // settles in-flight MCP writes, verifies the source database was not
      // touched mid-copy, and removes the marker when it fails.
      await copyLibraryForRelocationGuarded({
        sourceLibraryDir: previousLibraryDir,
        destinationLibraryDir: nextLibraryDir,
      });
      saveLibraryDir(nextLibraryDir);
    } catch (error) {
      // The move is off; without this the MCP would refuse the old library forever.
      await removeRelocationMarker({ libraryDir: previousLibraryDir }).catch(() => {});
      console.error(`[MOSA] library relocation failed: ${error?.stack || error}`);
      setLibraryDir(previousLibraryDir);
      app.relaunch();
      app.exit(1);
      // 任务 389（低18 ②）：空间不足、没有权限各回一句自己的话，其余照旧
      // copy-failed；上面的收尾（删标记、还原、relaunch）不因原因而变。
      return { ok: false, reason: relocationFailureReason(error) };
    }

    // The new copy and persisted location are now complete. Failure to remove
    // the old directory must never roll back by deleting the new authoritative
    // copy; at worst the user is left with a harmless duplicate to remove.
    setLibraryDir(nextLibraryDir);
    await rm(previousLibraryDir, { recursive: true, force: true }).catch((error) => {
      console.warn(`[MOSA] new library is active but the old directory could not be removed: ${error?.message || error}`);
    });
    app.relaunch();
    app.exit(0);
    return { ok: true, restarting: true };
  });
}
