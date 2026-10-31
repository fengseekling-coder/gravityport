#!/usr/bin/env node
import "../lib/apply-env-aliases.mjs";

import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_MOSA_DESKTOP_PORT, normalizeMosaPort } from "../lib/runtime-defaults.mjs";
import { probeMosaDesktopStartupHandoff } from "../lib/runtime-handoff.mjs";
import { safeCanonical } from "../lib/runtime-isolation-guard.mjs";
import { pathsEqual } from "../lib/path-safety.mjs";
import { libraryDigest, readLibraryId } from "../lib/library-identity.mjs";
import {
  MosaLibraryLocationFileError,
  MosaLibraryNotFoundError,
  resolveBackgroundLibraryDir,
} from "../lib/library-location.mjs";
import { verifyMosaRuntimeLockProcessIdentity } from "../lib/runtime-lock.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDir, "..");
const serverEntry = join(repositoryRoot, "server.mjs");
const DEFAULT_IDLE_POLL_MS = 5000;
const DEFAULT_TAKEOVER_GRACE_MS = 5000;
const DEFAULT_CONTROLLED_TAKEOVER_GRACE_MS = 30_000;
const DEFAULT_TAKEOVER_POLL_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 1200;
const DEFAULT_SOURCE_CHANGE_SETTLE_MS = 750;
const DEFAULT_HANDOFF_POLL_MS = 250;

// Constant-time digest comparison (see desktop/service-manager.mjs).
function digestsEqual(left, right) {
  const leftBytes = Buffer.from(String(left || ""));
  const rightBytes = Buffer.from(String(right || ""));
  return leftBytes.length === rightBytes.length
    && (leftBytes.length === 0 || timingSafeEqual(leftBytes, rightBytes));
}

/**
 * The library this supervisor watches and starts the runtime for. Same lookup
 * as the MCP server: the desktop location file counts, and nothing is created.
 * Throws MosaLibraryNotFoundError / MosaLibraryLocationFileError when there is
 * no library to attach to; the loop reports that and waits instead of starting.
 */
export function resolveSupervisorLibraryDir({ homeDir = homedir(), envLibraryDir = process.env.MOSA_LIBRARY_DIR } = {}) {
  return resolveBackgroundLibraryDir({ homeDir, envLibraryDir });
}

/** Environment for the runtime this supervisor starts: attach only, never create. */
export function backgroundRuntimeEnv(env = process.env) {
  return { ...env, MOSA_BACKGROUND_RUNTIME: "1" };
}

export function watchOwnedRuntimeSources({
  watchImpl = watch,
  settleMs = DEFAULT_SOURCE_CHANGE_SETTLE_MS,
  sources = [
    { path: join(repositoryRoot, "web", "gravityport", "src"), recursive: true },
    { path: join(repositoryRoot, "lib"), recursive: true },
    { path: serverEntry, recursive: false },
    { path: join(repositoryRoot, "package.json"), recursive: false },
  ],
} = {}) {
  const watchers = [];
  let settleTimer = null;
  let closed = false;
  let resolveChange;
  const promise = new Promise((resolvePromise) => { resolveChange = resolvePromise; });

  const closeHandles = () => {
    for (const watcher of watchers.splice(0)) watcher.close?.();
  };
  const scheduleChange = () => {
    if (closed) return;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      if (closed) return;
      closed = true;
      settleTimer = null;
      closeHandles();
      resolveChange({ reason: "source-change" });
    }, Math.max(50, Number(settleMs) || DEFAULT_SOURCE_CHANGE_SETTLE_MS));
    settleTimer.unref?.();
  };

  for (const source of sources) {
    const watcher = watchImpl(source.path, { recursive: source.recursive === true }, scheduleChange);
    watcher.on?.("error", scheduleChange);
    watchers.push(watcher);
  }

  return {
    promise,
    close() {
      if (closed) return;
      closed = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
      closeHandles();
    },
  };
}

export async function probeMosaOwner({
  port = process.env.MOSA_PORT || DEFAULT_MOSA_DESKTOP_PORT,
  libraryDir = resolveSupervisorLibraryDir(),
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  leaseProbe = () => probeRuntimeLease({ libraryDir }),
  handoffProbe = () => probeMosaDesktopStartupHandoff({ libraryDir }),
} = {}) {
  const normalizedPort = normalizeMosaPort(port, { label: "MOSA supervisor port" });
  const expectedLibraryDir = safeCanonical(libraryDir);
  const handoff = await handoffProbe().catch(() => ({ state: "unavailable" }));
  if (handoff.state === "handoff") return handoff;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`http://127.0.0.1:${normalizedPort}/api/health`, {
      signal: controller.signal,
    });
    if (!response?.ok) {
      const lease = await leaseProbe();
      return lease.state === "starting" ? lease : { state: "conflict", reason: `HTTP ${response?.status || 0}` };
    }
    const health = await response.json();
    if (health?.product !== "mosa") {
      return { state: "conflict", reason: "non-mosa-listener" };
    }
    // Task 314: health publishes libraryDigest instead of the library path.
    // The supervisor knows its library directory and reads the same on-disk
    // id file, so it recomputes the expected digest. A matching digest means
    // the same library; legacy runtimes that still publish libraryDir keep
    // the path comparison below.
    if (typeof health.libraryDigest === "string" && health.libraryDigest) {
      const expectedLibraryId = await readLibraryId(libraryDir);
      const expectedDigest = expectedLibraryId ? libraryDigest(expectedLibraryId, libraryDir) : "";
      if (!expectedDigest || !digestsEqual(health.libraryDigest, expectedDigest)) {
        return { state: "conflict", reason: "different-library" };
      }
    } else if (typeof health.libraryDir === "string") {
      // Canonical comparison so a symlinked alias of the running library still
      // matches (same semantics as the isolation guard).
      if (!pathsEqual(safeCanonical(health.libraryDir), expectedLibraryDir)) {
        return { state: "conflict", reason: "different-library" };
      }
    } else {
      return { state: "conflict", reason: "non-mosa-listener" };
    }
    return { state: "attached", health };
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    const lease = await leaseProbe();
    if (lease.state === "starting") return lease;
    if (code === "ECONNREFUSED") return { state: "unavailable" };
    if (error?.name === "AbortError") return { state: "conflict", reason: "timeout" };
    return { state: "conflict", reason: code || "unverified-listener" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeRuntimeLease({
  libraryDir = resolveSupervisorLibraryDir(),
  readFileImpl = readFile,
  isProcessAlive = defaultIsProcessAlive,
  verifyProcessIdentity = verifyMosaRuntimeLockProcessIdentity,
} = {}) {
  const lockPath = join(resolve(libraryDir), ".mosa-runtime.lock");
  try {
    const owner = JSON.parse(await readFileImpl(lockPath, "utf8"));
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0 || typeof owner?.token !== "string" || !owner.token) {
      return { state: "unavailable" };
    }
    if (!isProcessAlive(owner.pid)) return { state: "unavailable" };
    const identityMatch = await verifyProcessIdentity(owner);
    if (identityMatch === false) return { state: "unavailable" };
    return { state: "starting", owner: { pid: owner.pid } };
  } catch {
    return { state: "unavailable" };
  }
}

export function watchDesktopStartupHandoff({
  probe = () => probeMosaDesktopStartupHandoff({
    libraryDir: resolveSupervisorLibraryDir(),
  }),
  pollMs = DEFAULT_HANDOFF_POLL_MS,
} = {}) {
  let closed = false;
  let timer = null;
  let resolveWatch;
  const promise = new Promise((resolvePromise) => { resolveWatch = resolvePromise; });

  const schedule = () => {
    if (closed) return;
    timer = setTimeout(check, Math.max(25, Number(pollMs) || DEFAULT_HANDOFF_POLL_MS));
  };
  const check = async () => {
    if (closed) return;
    try {
      const status = await probe();
      if (status.state === "handoff") {
        closed = true;
        timer = null;
        resolveWatch(status);
        return;
      }
    } catch {}
    schedule();
  };
  void check();

  return {
    promise,
    close() {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export async function waitForReplacementOwner({
  probe = probeMosaOwner,
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  graceMs = DEFAULT_TAKEOVER_GRACE_MS,
  pollMs = DEFAULT_TAKEOVER_POLL_MS,
} = {}) {
  const checks = Math.max(1, Math.ceil(Math.max(0, Number(graceMs) || 0) / Math.max(1, Number(pollMs) || 1)));
  for (let index = 0; index < checks; index += 1) {
    const status = await probe();
    if (status.state !== "unavailable") return status;
    if (index + 1 < checks) await sleep(pollMs);
  }
  return { state: "unavailable" };
}

export async function runSupervisor({
  probe = () => probeMosaOwner(),
  spawnRuntime = () => spawn(process.execPath, [serverEntry], {
    cwd: repositoryRoot,
    env: backgroundRuntimeEnv(),
    stdio: "inherit",
  }),
  watchSources = () => watchOwnedRuntimeSources(),
  watchHandoff = () => watchDesktopStartupHandoff(),
  sleep = (delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)),
  idlePollMs = DEFAULT_IDLE_POLL_MS,
  takeoverGraceMs = DEFAULT_TAKEOVER_GRACE_MS,
  controlledTakeoverGraceMs = DEFAULT_CONTROLLED_TAKEOVER_GRACE_MS,
  takeoverPollMs = DEFAULT_TAKEOVER_POLL_MS,
  logger = console,
  signalTarget = process,
} = {}) {
  let stopping = false;
  let child = null;
  let lastIdleReason = "";
  let lastHandoffAt = 0;

  // A library that cannot be found (or whose location file is unreadable) is a
  // state, not a crash: the loop logs it once and checks again later.
  const probeOwner = async () => {
    try {
      return await probe();
    } catch (error) {
      if (error instanceof MosaLibraryNotFoundError || error instanceof MosaLibraryLocationFileError) {
        return { state: "library-missing", reason: error.message };
      }
      throw error;
    }
  };

  const stop = () => {
    stopping = true;
    if (child && child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  };
  signalTarget.once?.("SIGINT", stop);
  signalTarget.once?.("SIGTERM", stop);

  try {
    while (!stopping) {
      const current = await probeOwner();
      if (current.state === "attached" || current.state === "starting" || current.state === "handoff") {
        if (current.state === "handoff") lastHandoffAt = Date.now();
        if (lastIdleReason !== current.state) {
          logger.info?.(current.state === "attached"
            ? "[MOSA supervisor] another verified MOSA runtime owns this library; standing by."
            : current.state === "starting"
              ? "[MOSA supervisor] another active MOSA runtime owns the library lock and is starting; standing by."
              : "[MOSA supervisor] MOSA Desktop is starting and has requested runtime handoff; standing by.");
        }
        lastIdleReason = current.state;
        await sleep(idlePollMs);
        continue;
      }
      if (current.state === "library-missing") {
        const reason = `library-missing:${current.reason}`;
        if (lastIdleReason !== reason) {
          logger.warn?.(`[MOSA supervisor] ${current.reason}; not starting the background runtime and not creating a library. Checking again in ${idlePollMs} ms.`);
        }
        lastIdleReason = reason;
        await sleep(idlePollMs);
        continue;
      }
      if (current.state === "conflict") {
        const reason = `conflict:${current.reason || "unknown"}`;
        if (lastIdleReason !== reason) logger.warn?.(`[MOSA supervisor] port is occupied by an unverified or different runtime (${current.reason || "unknown"}); standing by.`);
        lastIdleReason = reason;
        await sleep(idlePollMs);
        continue;
      }

      lastIdleReason = "";
      const handoffCooldownMs = lastHandoffAt + Math.max(0, Number(controlledTakeoverGraceMs) || 0) - Date.now();
      if (handoffCooldownMs > 0) {
        const handoff = await probeOwner().catch(() => ({ state: "unavailable" }));
        if (handoff.state === "handoff") {
          lastHandoffAt = Date.now();
          lastIdleReason = "handoff";
          await sleep(idlePollMs);
          continue;
        }
        if (lastIdleReason !== "desktop-handoff-cooldown") {
          logger.info?.("[MOSA supervisor] waiting for the desktop startup handoff to acquire the library lock.");
          lastIdleReason = "desktop-handoff-cooldown";
        }
        await sleep(handoffCooldownMs);
        continue;
      }
      child = spawnRuntime();
      logger.info?.(`[MOSA supervisor] started background runtime PID ${child.pid || "unknown"}.`);
      const sourceWatch = watchSources();
      const handoffWatch = watchHandoff();
      const exitPromise = waitForChildExit(child).then((exit) => ({ type: "exit", exit }));
      const outcome = await Promise.race([
        exitPromise,
        sourceWatch.promise.then(() => ({ type: "source-change" })),
        handoffWatch.promise.then((handoff) => ({ type: "desktop-handoff", handoff })),
      ]);
      sourceWatch.close?.();
      handoffWatch.close?.();

      if (outcome.type === "desktop-handoff") {
        if (!stopping && child.exitCode == null && child.signalCode == null) {
          logger.info?.(`[MOSA supervisor] desktop startup handoff detected for PID ${outcome.handoff?.owner?.pid || "unknown"}; yielding background runtime.`);
          child.kill("SIGTERM");
        }
        await exitPromise;
        child = null;
        if (stopping) break;
        lastHandoffAt = Date.now();
        continue;
      }

      if (outcome.type === "source-change") {
        if (!stopping && child.exitCode == null && child.signalCode == null) {
          logger.info?.("[MOSA supervisor] source changed; restarting the owned background runtime.");
          child.kill("SIGTERM");
        }
        await exitPromise;
        child = null;
        if (stopping) break;
        // Re-enter through probe instead of spawning blindly. A desktop app
        // may have acquired the library lock while the old source runtime was
        // shutting down, and the cooperative ownership rule must still win.
        continue;
      }

      const exit = outcome.exit;
      child = null;
      if (stopping) break;

      const replacement = await waitForReplacementOwner({
        probe: probeOwner,
        sleep,
        graceMs: exit?.signal === "SIGTERM" ? controlledTakeoverGraceMs : takeoverGraceMs,
        pollMs: takeoverPollMs,
      });
      if (replacement.state === "library-missing") continue;
      if (replacement.state === "attached" || replacement.state === "starting") {
        logger.info?.("[MOSA supervisor] background runtime yielded to another verified MOSA owner.");
        continue;
      }
      if (replacement.state === "conflict") {
        logger.warn?.(`[MOSA supervisor] background runtime exited and the port is now occupied (${replacement.reason || "unknown"}); standing by.`);
        continue;
      }
      logger.warn?.(`[MOSA supervisor] background runtime exited (${formatExit(exit)}); restarting after takeover grace.`);
    }
  } finally {
    signalTarget.off?.("SIGINT", stop);
    signalTarget.off?.("SIGTERM", stop);
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill("SIGTERM");
      await waitForChildExit(child).catch(() => {});
    }
  }
}

function waitForChildExit(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, rejectExit) => {
    const onError = (error) => {
      cleanup();
      rejectExit(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolveExit({ code, signal });
    };
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function formatExit(exit) {
  if (exit?.signal) return `signal ${exit.signal}`;
  return `code ${exit?.code ?? "unknown"}`;
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runSupervisor();
}
