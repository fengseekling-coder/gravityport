import { existsSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_DATABASE_FILE } from "../lib/library-location.mjs";

export const DEFAULT_LIBRARY_VOLUME_WATCH_INTERVAL_MS = 3000;
export const DEFAULT_LIBRARY_CLOSE_TIMEOUT_MS = 5000;

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Checks whether the library directory and its SQLite database file are still
 * reachable on disk (e.g., before an external drive is unplugged or ejected).
 */
export function isLibraryPresent(libraryDir, { exists = existsSync } = {}) {
  if (!libraryDir) return false;
  return Boolean(exists(libraryDir) && exists(join(libraryDir, LIBRARY_DATABASE_FILE)));
}

/**
 * Watches the active library directory on a fixed interval in the main process.
 * When the directory or mosa.db disappears, stops capture/polling, closes the
 * runtime/store (swallowing I/O errors from the vanished volume), surfaces the
 * existing missing-library dialog, and exits cleanly.
 */
export function createLibraryVolumeWatch({
  intervalMs = DEFAULT_LIBRARY_VOLUME_WATCH_INTERVAL_MS,
  closeTimeoutMs = DEFAULT_LIBRARY_CLOSE_TIMEOUT_MS,
  exists = existsSync,
  stopCaptureAndPolling,
  closeLibrary,
  showMissingDialog,
  exit,
  log = console,
} = {}) {
  let watchedLibraryDir = "";
  let timer = null;
  let paused = false;
  let stopped = false;
  let handlingMissing = false;
  let checkInFlight = false;

  function clearTimer() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function checkNow() {
    if (stopped || paused || handlingMissing || checkInFlight || !watchedLibraryDir) {
      return false;
    }
    checkInFlight = true;
    try {
      if (isLibraryPresent(watchedLibraryDir, { exists })) {
        return false;
      }
      handlingMissing = true;
      clearTimer();
      const missingDir = watchedLibraryDir;
      log?.warn?.(`[MOSA] library directory is no longer available (${missingDir}); closing library and exiting.`);
      // Every step below may hit the vanished volume; none of them may keep
      // the app from showing the dialog and exiting.
      try {
        await stopCaptureAndPolling?.(missingDir);
      } catch (error) {
        log?.warn?.(`[MOSA] stopping capture after volume disconnect failed (continuing): ${error?.message || error}`);
      }
      try {
        await withTimeout(closeLibrary?.(missingDir), closeTimeoutMs);
      } catch (error) {
        log?.warn?.(`[MOSA] closing library after volume disconnect failed (continuing): ${error?.message || error}`);
      }
      try {
        await showMissingDialog?.(missingDir);
      } catch (error) {
        log?.warn?.(`[MOSA] missing-library dialog failed (continuing): ${error?.message || error}`);
      }
      exit?.(0);
      return true;
    } finally {
      checkInFlight = false;
    }
  }

  function start(libraryDir) {
    if (!libraryDir || handlingMissing) return;
    watchedLibraryDir = libraryDir;
    stopped = false;
    paused = false;
    clearTimer();
    const delayMs = Math.max(50, Number(intervalMs) || DEFAULT_LIBRARY_VOLUME_WATCH_INTERVAL_MS);
    timer = setInterval(() => {
      void checkNow();
    }, delayMs);
    timer.unref?.();
  }

  function pause() {
    paused = true;
    clearTimer();
  }

  function resume(nextLibraryDir) {
    if (stopped || handlingMissing) return;
    start(nextLibraryDir || watchedLibraryDir);
  }

  function stop() {
    stopped = true;
    clearTimer();
  }

  return {
    start,
    pause,
    resume,
    stop,
    checkNow,
  };
}
