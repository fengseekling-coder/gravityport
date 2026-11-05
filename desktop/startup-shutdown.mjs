// Task 341: reportStartupFailure() used to await stopOwnedRuntime() and
// releaseDesktopStartupHandoff() with no deadline. A wedged shutdown left
// GravityPort processes lingering behind the startup-failure dialog, and the
// next launch then tripped over them with a "library verification failed"
// error. Both shutdown steps now race a 5-second budget each; an overrunning
// step is named in the log, and the process always exits afterwards.

export const STARTUP_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Runs the named shutdown steps concurrently, bounds each one by `timeoutMs`,
 * and always calls `exit(1)` once every step has either finished or timed out.
 * Returns the names of the steps that timed out (resolved after exit has been
 * requested). A step that rejects is shutdown noise — logged, not fatal.
 */
export async function runStartupShutdownExit({ steps, timeoutMs = STARTUP_SHUTDOWN_TIMEOUT_MS, exit, log = console }) {
  const outcomes = await Promise.all(steps.map(async ([name, step]) => {
    const timedOut = await Promise.race([
      Promise.resolve().then(step).then(
        () => false,
        (error) => {
          log.warn(`[MOSA] startup shutdown step "${name}" failed: ${error?.message || error}`);
          return false;
        },
      ),
      new Promise((resolveTimeout) => {
        // Deliberately NOT unref'd: this timer is what guarantees exit when a
        // step wedges — if it were the last live handle, an unref'd timer
        // would let the process drain and exit without ever forcing exit(1).
        setTimeout(() => resolveTimeout(true), timeoutMs);
      }),
    ]);
    if (timedOut) {
      log.error(`[MOSA] startup shutdown step "${name}" timed out after ${timeoutMs}ms; forcing exit`);
    }
    return timedOut ? name : null;
  }));
  exit(1);
  return outcomes.filter(Boolean);
}
