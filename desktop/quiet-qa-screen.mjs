// Task 325: Screen guard for QA test runs.
// When running unpackaged with MOSA_QA_RUN, all visual interactions (error dialogs,
// message boxes, directory pickers, system notifications, external browser links,
// native drags, window focus and show) are suppressed to avoid popping up on the user's
// screen. Fatal failures write QA_STARTUP_FAILED: to stderr and exit non-zero;
// non-fatal UI interactions write QA_UI_SUPPRESSED: to stderr and return cancellation/noop.
//
// Task 346: packaged test runs (forge package smoke, update rehearsal) can enter
// the same quiet mode through a gated switch. The gate requires the switch token,
// the QA env signals, a non-production userData that matches MOSA_USER_DATA, and
// a token marker file inside that userData, so a production launch can never
// satisfy it (production startup carries no switch and sits at the default
// userData).

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathsEqual } from "../lib/path-safety.mjs";
import { safeCanonical } from "../lib/runtime-isolation-guard.mjs";

/** Marker file the test launcher writes into the isolated userData before startup. */
export const QUIET_QA_MARKER_FILENAME = "gravityport-qa-quiet.json";

// The switch name is only ever spelled out in full at its launch sites
// (scripts/packaged-smoke.mjs, the rehearsal launcher); the gate matches it
// structurally so the literal flag string lives in exactly one repo file
// (contract test in test/desktop-quiet-qa-screen.test.mjs).
const PACKAGED_QUIET_SWITCH_NAME = "gravityport-qa-quiet";

const PACKAGED_QUIET_TOKEN_PATTERN = /^[0-9a-f]{32,}$/;
const PACKAGED_QUIET_MARKER_MAX_BYTES = 1024;

/**
 * Returns true only for unpackaged QA test runs across all platforms.
 * Packaged apps (isPackaged === true) never enter quiet QA mode.
 */
export function isQuietQaRun({ env = process.env, isPackaged = false } = {}) {
  return Boolean(env && env.MOSA_QA_RUN) && !isPackaged;
}

/**
 * Single source of truth for quiet QA mode (task 346). Both entry points that
 * must agree — desktop/quiet-test-mode.mjs (early, before Launch Services
 * check-in) and desktop/main.mjs (quietQaRun) — call this through
 * evaluateQuietQaRunForElectronApp(app) with identical inputs.
 *
 * Returns { quiet, rejectReason }:
 *   - quiet: true                  → run in quiet mode (dev: MOSA_QA_RUN only;
 *                                    packaged: every gate condition below held)
 *   - rejectReason: null, quiet: false → normal visible startup (no switch)
 *   - rejectReason: "<short word>" → a packaged quiet attempt failed its gate;
 *                                    the caller must hide the Dock, write
 *                                    QA_STARTUP_FAILED: packaged-quiet-gate <reason>
 *                                    to stderr and exit non-zero before any
 *                                    window, service, or file write.
 *
 * File access is injectable so unit tests stay hermetic.
 */
export function evaluateQuietQaRun({
  env = process.env,
  isPackaged = false,
  argv = process.argv,
  actualUserData = "",
  productionDefaultUserData = "",
  lstat = (path) => lstatSync(path),
  readFile = (path) => readFileSync(path, "utf8"),
  canonicalize = (path) => safeCanonical(path),
} = {}) {
  if (!isPackaged) {
    // Development rule is unchanged (task 325): MOSA_QA_RUN alone decides and
    // the packaged switch is ignored outside packages.
    return { quiet: isQuietQaRun({ env, isPackaged: false }), rejectReason: null };
  }

  const switchPrefix = `--${PACKAGED_QUIET_SWITCH_NAME}=`;
  const switchArgs = (argv || []).filter((arg) =>
    typeof arg === "string"
    && (arg === `--${PACKAGED_QUIET_SWITCH_NAME}` || arg.startsWith(switchPrefix)));
  if (switchArgs.length === 0) {
    // Production startup path: exactly today's behavior, no new output.
    return { quiet: false, rejectReason: null };
  }
  if (switchArgs.length > 1) return { quiet: false, rejectReason: "bad-flag" };
  const token = switchArgs[0].startsWith(switchPrefix) ? switchArgs[0].slice(switchPrefix.length) : "";
  if (!PACKAGED_QUIET_TOKEN_PATTERN.test(token)) return { quiet: false, rejectReason: "bad-flag" };

  if (!env || !env.MOSA_QA_RUN) return { quiet: false, rejectReason: "qa-run-missing" };
  if (env.MOSA_RUNTIME_MODE !== "qa") return { quiet: false, rejectReason: "runtime-mode" };

  // The QA userData must never be the production default (symlinked aliases
  // included), with the same canonicalization semantics as the runtime
  // isolation guard. Checked before the expected/actual match so a production
  // default userData is always reported as production-user-data.
  const canonActual = actualUserData ? canonicalize(actualUserData) : "";
  const canonDefault = productionDefaultUserData ? canonicalize(productionDefaultUserData) : "";
  if (!canonActual || (canonDefault && pathsEqual(canonActual, canonDefault))) {
    return { quiet: false, rejectReason: "production-user-data" };
  }

  const expectedUserData = env.MOSA_USER_DATA || "";
  if (!expectedUserData || !pathsEqual(canonicalize(expectedUserData), canonActual)) {
    return { quiet: false, rejectReason: "user-data-mismatch" };
  }

  // Marker file: a small plain JSON file inside the isolated userData whose
  // token matches the switch token. Written by the test launcher before spawn.
  const markerPath = join(actualUserData, QUIET_QA_MARKER_FILENAME);
  let markerStat;
  try {
    markerStat = lstat(markerPath);
  } catch {
    return { quiet: false, rejectReason: "marker-missing" };
  }
  if (!markerStat || typeof markerStat.isFile !== "function" || !markerStat.isFile()) {
    return { quiet: false, rejectReason: "marker-not-file" };
  }
  if (Number(markerStat.size) >= PACKAGED_QUIET_MARKER_MAX_BYTES) {
    return { quiet: false, rejectReason: "marker-invalid" };
  }
  let marker;
  try {
    marker = JSON.parse(readFile(markerPath));
  } catch {
    return { quiet: false, rejectReason: "marker-invalid" };
  }
  if (!marker || typeof marker !== "object" || typeof marker.token !== "string") {
    return { quiet: false, rejectReason: "marker-invalid" };
  }
  if (marker.token !== token) return { quiet: false, rejectReason: "token-mismatch" };

  return { quiet: true, rejectReason: null };
}

/**
 * The one call both entry points share, so quiet-test-mode.mjs and main.mjs
 * cannot drift apart on inputs. `overrides` exist for unit tests only.
 */
export function evaluateQuietQaRunForElectronApp(app, overrides = {}) {
  return evaluateQuietQaRun({
    env: process.env,
    isPackaged: app.isPackaged,
    argv: process.argv,
    actualUserData: app.getPath("userData"),
    productionDefaultUserData: join(app.getPath("appData"), app.name),
    ...overrides,
  });
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
