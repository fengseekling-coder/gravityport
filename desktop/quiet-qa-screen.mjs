// Task 325: Screen guard for QA test runs.
// When running unpackaged with MOSA_QA_RUN, all visual interactions (error dialogs,
// message boxes, directory pickers, system notifications, external browser links,
// native drags, window focus and show) are suppressed to avoid popping up on the user's
// screen. Fatal failures write QA_STARTUP_FAILED: to stderr and exit non-zero;
// non-fatal UI interactions write QA_UI_SUPPRESSED: to stderr and return cancellation/noop.

/**
 * Returns true only for unpackaged QA test runs across all platforms.
 * Packaged apps (isPackaged === true) never enter quiet QA mode.
 */
export function isQuietQaRun({ env = process.env, isPackaged = false } = {}) {
  return Boolean(env && env.MOSA_QA_RUN) && !isPackaged;
}

function sanitizeUrlForLog(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

/**
 * Creates a screen guard that intercepts dialogs, notifications, external URLs,
 * dragging, and window presentation.
 */
export function createScreenGuard({
  quiet = false,
  quietWindow = quiet,
  electron = {},
  log,
  windowMode = "p1",
} = {}) {
  const writeLog = typeof log === "function"
    ? log
    : (line) => process.stderr.write(String(line) + "\n");

  return {
    errorBox(title, body) {
      if (quiet) {
        const firstLine = String(body ?? "").split(/\r?\n/)[0];
        writeLog(`QA_STARTUP_FAILED: ${title} | ${firstLine}`);
        return;
      }
      electron.dialog?.showErrorBox(title, body);
    },

    messageBox(ownerOrOptions, maybeOptions) {
      const owner = maybeOptions !== undefined ? ownerOrOptions : null;
      const options = (maybeOptions !== undefined ? maybeOptions : ownerOrOptions) || {};
      if (quiet) {
        const title = options.title || options.message || "dialog";
        writeLog(`QA_UI_SUPPRESSED: messageBox ${title}`);
        const cancelId = options.cancelId ?? 0;
        return Promise.resolve({ response: cancelId });
      }
      if (owner) {
        return electron.dialog?.showMessageBox(owner, options);
      }
      return electron.dialog?.showMessageBox(options);
    },

    openDialog(ownerOrOptions, maybeOptions) {
      const owner = maybeOptions !== undefined ? ownerOrOptions : null;
      const options = (maybeOptions !== undefined ? maybeOptions : ownerOrOptions) || {};
      if (quiet) {
        const title = options.title || "openDialog";
        writeLog(`QA_UI_SUPPRESSED: openDialog ${title}`);
        return Promise.resolve({ canceled: true, filePaths: [] });
      }
      if (owner) {
        return electron.dialog?.showOpenDialog(owner, options);
      }
      return electron.dialog?.showOpenDialog(options);
    },

    openExternal(url) {
      if (quiet) {
        writeLog(`QA_UI_SUPPRESSED: openExternal ${sanitizeUrlForLog(url)}`);
        return Promise.resolve();
      }
      return electron.shell?.openExternal(url);
    },

    notify({ title, body, silent = true, onClick } = {}) {
      if (quiet) {
        writeLog(`QA_UI_SUPPRESSED: notification ${title || ""}`);
        return null;
      }
      if (electron.Notification && typeof electron.Notification.isSupported === "function") {
        if (!electron.Notification.isSupported()) return null;
      }
      if (!electron.Notification) return null;
      const notification = new electron.Notification({ title, body, silent });
      if (typeof onClick === "function") {
        notification.on("click", onClick);
      }
      notification.show();
      return notification;
    },

    startDrag(webContents, options) {
      if (quiet) {
        const file = options?.file || options?.files?.[0] || "file";
        writeLog(`QA_UI_SUPPRESSED: startDrag ${file}`);
        return;
      }
      webContents?.startDrag(options);
    },

    showWindow(win) {
      if (quietWindow) {
        writeLog("QA_UI_SUPPRESSED: showWindow");
        if (windowMode === "p2") {
          win?.setOpacity?.(0);
          win?.setIgnoreMouseEvents?.(true);
          win?.setHasShadow?.(false);
          win?.showInactive?.();
        }
        // In P1: window was created with show:false and remains completely hidden
        return;
      }
      win?.show?.();
    },

    focusWindow(win) {
      if (quietWindow) {
        writeLog("QA_UI_SUPPRESSED: focusWindow");
        return;
      }
      if (win?.isMinimized?.()) win.restore?.();
      win?.focus?.();
    },
  };
}
