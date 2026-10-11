import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import {
  DEFAULT_MOSA_DESKTOP_PORT,
  DEFAULT_MOSA_DISCOVERY_PORTS,
  MOSA_RESERVED_PRODUCTION_PORTS,
  normalizeMosaPort,
} from "../lib/runtime-defaults.mjs";
import { validateRuntimeIsolation, safeCanonical } from "../lib/runtime-isolation-guard.mjs";
import { pathsEqual } from "../lib/path-safety.mjs";
import { defaultLibraryDir, legacyDefaultLibraryDir, resolveLibraryLocation } from "../lib/library-location.mjs";
import { verifyMosaRuntimeLockProcessIdentity } from "../lib/runtime-lock.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_UPGRADE_STOP_TIMEOUT_MS = 5000;
const DEFAULT_UPGRADE_STOP_POLL_MS = 100;
const RUNTIME_LOCK_FILE_NAME = ".mosa-runtime.lock";

export class MosaServiceConflictError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "MosaServiceConflictError";
  }
}

export class MosaServiceBuildMismatchError extends MosaServiceConflictError {
  constructor({ details, expectedIdentity, mismatches }) {
    const runningVersion = normalizedIdentityValue(details?.productVersion);
    const expectedVersion = normalizedIdentityValue(expectedIdentity?.productVersion);
    const runningLabel = runningVersion === "unknown" ? "another build" : `v${runningVersion}`;
    const expectedLabel = expectedVersion === "unknown" ? "This GravityPort build" : `GravityPort v${expectedVersion}`;
    super(`${expectedLabel} found ${runningLabel} of the local GravityPort service using the same library. Quit the previous GravityPort instance and reopen this version.`);
    this.name = "MosaServiceBuildMismatchError";
    this.code = "MOSA_SERVICE_BUILD_MISMATCH";
    this.service = Object.freeze({ ...details });
    this.expectedIdentity = Object.freeze({ ...expectedIdentity });
    this.mismatches = Object.freeze(mismatches.map((item) => Object.freeze({ ...item })));
    const versionComparison = compareMosaVersions(expectedVersion, runningVersion);
    this.upgradeEligible = versionComparison === 1;
    // Source development commonly keeps one package version across several
    // commits. A verified same-version runtime with a different build identity
    // is stale for an explicit source desktop launch even though semver cannot
    // order those two builds.
    this.sameVersionReplacementEligible = versionComparison === 0;
  }
}

export class MosaServiceLibraryMismatchError extends MosaServiceConflictError {
  constructor({ port, expectedLibraryDir, actualLibraryDir }) {
    super(`Port ${port} is already serving a different GravityPort library. Quit the other GravityPort instance before opening this library.`);
    this.name = "MosaServiceLibraryMismatchError";
    this.code = "MOSA_SERVICE_LIBRARY_MISMATCH";
    this.port = port;
    this.expectedLibraryDir = resolve(expectedLibraryDir);
    this.actualLibraryDir = resolve(actualLibraryDir);
  }
}

export function shouldAllowStaleServiceUpgrade({ isPackaged, qaRun, explicitPort } = {}) {
  return isPackaged === true && !qaRun && !explicitPort;
}

export function shouldAllowSameVersionServiceReplacement({ isPackaged, qaRun, explicitPort } = {}) {
  return isPackaged !== true && !qaRun && !explicitPort;
}

/**
 * Attaches to a verified local MOSA service or starts one that this process
 * owns. Existing processes are left alone by default; the packaged desktop
 * may explicitly opt into the narrow older-version retirement path below.
 *
 * `options.isolationContext` carries the QA runtime parameters that
 * desktop/main.mjs resolved once (runtimeMode, qaRun, expected/actual
 * userData, production default, argv, runtimeKind) and forwards them to the
 * guard and into startMosaRuntime. Propagation never falls back to
 * process.env inside this layer.
 */
export async function startMosaService(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizeMosaPort(options.port ?? DEFAULT_MOSA_DESKTOP_PORT, { label: "MOSA desktop port" });
  const libraryDir = options.libraryDir
    ? resolve(options.libraryDir)
    : resolveLibraryLocation({ homeDir: homedir() }).libraryDir;
  const isolation = options.isolationContext || {};

  // ---- Runtime isolation guard: fail closed before any production write ----
  const guard = validateRuntimeIsolation({
    libraryDir: options.libraryDir,
    port,
    runtimeMode: isolation.runtimeMode ?? options.runtimeMode ?? process.env.MOSA_RUNTIME_MODE,
    qaRun: isolation.qaRun ?? options.qaRun ?? process.env.MOSA_QA_RUN,
    userData: isolation.expectedUserData ?? options.userData ?? process.env.MOSA_USER_DATA,
    actualUserData: isolation.actualUserData ?? options.actualUserData,
    argv: isolation.argv ?? options.argv ?? process.argv,
    defaultUserData: isolation.productionDefaultUserData,
    runtimeKind: isolation.runtimeKind,
    productionLibraryDir: [legacyDefaultLibraryDir(homedir()), defaultLibraryDir(homedir())],
    productionPorts: MOSA_RESERVED_PRODUCTION_PORTS,
  });
  if (!guard.ok) {
    throw new Error(`ISOLATION_GUARD_REJECTED: ${guard.field} ${guard.reason}`);
  }

  const discoveryPorts = Array.isArray(options.discoveryPorts) && options.discoveryPorts.length
    ? options.discoveryPorts.map((candidate) => normalizeMosaPort(candidate, { label: "GravityPort discovery port" }))
    : DEFAULT_MOSA_DISCOVERY_PORTS;
  const candidatePorts = options.allowPortFallback
    ? [...new Set([port, ...discoveryPorts])]
    : [port];
  let lastConflict = null;
  let identityMismatch = null;
  const availablePorts = [];

  const initialProbes = await Promise.all(candidatePorts.map(async (candidatePort) => {
    const probeOptions = {
      host,
      port: candidatePort,
      libraryDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.probeTimeoutMs,
    };
    return { candidatePort, initial: await probeMosaService(probeOptions) };
  }));

  for (const { candidatePort, initial } of initialProbes) {
    if (initial.state === "attached") {
      const identityConflict = serviceIdentityConflict(initial, options.expectedIdentity);
      if (!identityConflict) {
        if (options.preferOwnedRuntime === true && candidatePort === port) {
          const retireService = options.retireVerifiedService || retireVerifiedMosaService;
          const retired = await retireService(initial, {
            host,
            expectedIdentity: options.expectedIdentity,
            fetchImpl: options.fetchImpl,
            probeTimeoutMs: options.probeTimeoutMs,
          });
          if (retired) {
            availablePorts.push(candidatePort);
            continue;
          }
        }
        return attachedService(initial, options.clientToken);
      }
      lastConflict = identityConflict;
      identityMismatch = identityConflict;
      continue;
    }
    if (initial.state === "conflict") {
      lastConflict = initial.error;
      if (candidatePort === port
        && options.failOnPrimaryLibraryMismatch === true
        && initial.error instanceof MosaServiceLibraryMismatchError) {
        throw initial.error;
      }
      continue;
    }
    availablePorts.push(candidatePort);
  }

  // A verified MOSA for this exact library is already alive, but it does not
  // match the desktop build. A packaged upgrade may retire an *older* verified
  // MOSA owner for this same library, then retry once. QA/dev callers stay
  // fail-closed unless they explicitly opt in, and same/newer builds are never
  // terminated automatically.
  if (identityMismatch) {
    const olderUpgradeAllowed = options.allowStaleServiceUpgrade === true
      && identityMismatch.upgradeEligible === true;
    const authOnlyMismatch = identityMismatch.mismatches.length > 0
      && identityMismatch.mismatches.every((item) => item.field === "clientAuthFingerprint");
    const sameVersionReplacementAllowed = identityMismatch.sameVersionReplacementEligible === true
      && (options.allowSameVersionServiceReplacement === true || (authOnlyMismatch && Boolean(options.clientToken)));
    if ((olderUpgradeAllowed || sameVersionReplacementAllowed)
      && hasCompleteServiceIdentity(identityMismatch.expectedIdentity)) {
      const upgradeService = options.upgradeService || retireOlderMosaService;
      const retired = await upgradeService(identityMismatch, {
        host,
        fetchImpl: options.fetchImpl,
        probeTimeoutMs: options.probeTimeoutMs,
        allowSameVersionReplacement: sameVersionReplacementAllowed,
      });
      if (retired) {
        // Retirement transfers ownership to this desktop launch. Start the
        // target runtime immediately instead of waiting for an external
        // KeepAlive process that may not exist. If another supervisor wins the
        // port/library race, fail closed unless that owner reports the exact
        // target identity, in which case attaching is equivalent ownership.
        try {
          const runtime = await (options.startRuntime || startMosaRuntime)({
            ...(options.runtimeOptions || {}),
            clientToken: options.clientToken || options.runtimeOptions?.clientToken,
            port: identityMismatch.service.port,
            libraryDir,
            isolationContext: options.isolationContext,
            importStagingRoot: options.importStagingRoot ?? null,
          });
          return ownedService(runtime);
        } catch (error) {
          const retry = await (options.upgradeProbeImpl || probeMosaService)({
            host,
            port: identityMismatch.service.port,
            libraryDir,
            fetchImpl: options.fetchImpl,
            timeoutMs: options.probeTimeoutMs,
          });
          if (retry.state === "attached") {
            const retryConflict = serviceIdentityConflict(retry, options.expectedIdentity);
            if (!retryConflict) return attachedService(retry, options.clientToken);
            throw retryConflict;
          }
          if (retry.state === "conflict") throw retry.error;
          throw error;
        }
      }
    }
    throw identityMismatch;
  }

  for (const candidatePort of availablePorts) {
    const probeOptions = {
      host,
      port: candidatePort,
      libraryDir,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.probeTimeoutMs,
    };

    try {
      const runtime = await (options.startRuntime || startMosaRuntime)({
        ...(options.runtimeOptions || {}),
        clientToken: options.clientToken || options.runtimeOptions?.clientToken,
        port: candidatePort,
        libraryDir,
        isolationContext: options.isolationContext,
        importStagingRoot: options.importStagingRoot ?? null,
      });
      return ownedService(runtime);
    } catch (error) {
      const retry = await probeMosaService(probeOptions);
      if (retry.state === "attached") {
        const identityConflict = serviceIdentityConflict(retry, options.expectedIdentity);
        if (!identityConflict) return attachedService(retry, options.clientToken);
        lastConflict = identityConflict;
        continue;
      }
      if (retry.state === "conflict") {
        lastConflict = retry.error;
        continue;
      }
      if (error?.code === "EADDRINUSE") continue;
      throw error;
    }
  }

  if (lastConflict) throw lastConflict;
  throw new MosaServiceConflictError("No GravityPort desktop discovery port is available.");
}

export async function probeMosaService(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = normalizeMosaPort(options.port ?? DEFAULT_MOSA_DESKTOP_PORT, { label: "MOSA desktop port" });
  const libraryDir = options.libraryDir
    ? resolve(options.libraryDir)
    : resolveLibraryLocation({ homeDir: homedir() }).libraryDir;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(100, Number(options.timeoutMs))
    : DEFAULT_PROBE_TIMEOUT_MS;
  const url = `http://${host}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(`${url}/api/health`, { signal: controller.signal });
    let health;
    if (response.ok) {
      health = await response.json();
    } else if (response.status === 404) {
      health = await probeLegacyMosaIdentity({ url, fetchImpl, signal: controller.signal });
    } else {
      return conflict(`Port ${port} is occupied by a service that is not a healthy GravityPort runtime.`, null, { retryable: true });
    }
    if (health?.product !== "mosa" || typeof health.libraryDir !== "string") {
      return conflict(`Port ${port} is occupied by a service that is not GravityPort.`);
    }
    // Compare canonicalized paths so a symlinked alias of the running
    // library still matches (same semantics as the isolation guard).
    if (!pathsEqual(safeCanonical(health.libraryDir), safeCanonical(libraryDir))) {
      return {
        state: "conflict",
        error: new MosaServiceLibraryMismatchError({
          port,
          expectedLibraryDir: libraryDir,
          actualLibraryDir: health.libraryDir,
        }),
        retryable: false,
      };
    }
    return {
      state: "attached",
      url,
      port,
      libraryDir,
      storage: typeof health.storage === "string" ? health.storage : "unknown",
      serviceProtocolVersion: typeof health.serviceProtocolVersion === "string" ? health.serviceProtocolVersion : "unknown",
      productVersion: typeof health.productVersion === "string" ? health.productVersion : "unknown",
      gitSha: typeof health.gitSha === "string" ? health.gitSha : "unknown",
      uiFingerprint: typeof health.uiFingerprint === "string" ? health.uiFingerprint : "unknown",
      runtimeFingerprint: typeof health.runtimeFingerprint === "string" ? health.runtimeFingerprint : "unknown",
      clientAuthFingerprint: typeof health.clientAuthFingerprint === "string" ? health.clientAuthFingerprint : "unknown",
    };
  } catch (error) {
    if (isConnectionRefused(error)) return { state: "unavailable" };
    const reason = error?.name === "AbortError"
      ? `Port ${port} did not respond before the GravityPort probe timed out.`
      : `Port ${port} is occupied but could not be verified as GravityPort.`;
    return conflict(reason, error, { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retire a verified older MOSA runtime so a packaged desktop upgrade can take
 * ownership of the same library. The compatibility path is intentionally
 * narrow: the live service, semantic version, and library lock must all agree
 * before SIGTERM is sent, and we never escalate to SIGKILL.
 */
export async function retireOlderMosaService(conflict, options = {}) {
  if (!isRetirableServiceMismatch(conflict, options)) return false;
  const service = conflict.service;
  if (!service || !Number.isInteger(service.port) || typeof service.libraryDir !== "string") return false;

  const readFileImpl = options.readFileImpl || readFile;
  const lockPath = join(service.libraryDir, RUNTIME_LOCK_FILE_NAME);
  const owner = await readRuntimeLockOwner(lockPath, readFileImpl);
  if (!owner || owner.pid === process.pid) return false;

  const probeImpl = options.probeImpl || probeMosaService;
  const probeOptions = {
    host: options.host || DEFAULT_HOST,
    port: service.port,
    libraryDir: service.libraryDir,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.probeTimeoutMs,
  };
  const current = await probeImpl(probeOptions);
  if (current.state !== "attached" || !sameReportedServiceIdentity(current, service)) return false;
  const currentConflict = serviceIdentityConflict(current, conflict.expectedIdentity);
  if (!isRetirableServiceMismatch(currentConflict, options)) return false;

  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  if (!isProcessAlive(owner.pid)) return false;
  const verifyProcessIdentity = options.verifyProcessIdentity || verifyMosaRuntimeLockProcessIdentity;
  if (await verifyProcessIdentity(owner) === false) return false;
  const terminateProcess = options.terminateProcess || ((pid) => process.kill(pid, "SIGTERM"));
  try {
    terminateProcess(owner.pid);
  } catch {
    return false;
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_UPGRADE_STOP_TIMEOUT_MS);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_UPGRADE_STOP_POLL_MS);
  const maxChecks = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const sleepImpl = options.sleepImpl || ((delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)));

  for (let check = 0; check < maxChecks; check += 1) {
    const alive = isProcessAlive(owner.pid);
    const status = await probeImpl(probeOptions);
    if (!alive && (status.state === "unavailable" || (status.state === "conflict" && status.retryable === true))) return true;
    if (status.state === "conflict" && status.retryable !== true) return false;
    if (status.state === "attached") {
      // A KeepAlive launch agent can restart the local source runtime as soon
      // as the older owner exits. That is safe to accept only when the
      // replacement already reports this desktop build's complete identity;
      // the caller will probe again and attach to it on the retry.
      if (!serviceIdentityConflict(status, conflict.expectedIdentity)) return true;
      // Any other new owner is not the service we verified before signaling.
      // Never continue polling or signal a second process in that case.
      if (!sameReportedServiceIdentity(status, service)) return false;
    }
    if (check + 1 < maxChecks) await sleepImpl(pollMs);
  }
  return false;
}

/**
 * An explicit packaged desktop startup handoff may prefer owning the primary
 * local runtime instead of attaching to a verified KeepAlive/source runtime
 * that reports the exact same build identity. The live service, library lock,
 * PID/start identity, and requested build must all agree before one SIGTERM is
 * sent. Never escalate to SIGKILL.
 */
export async function retireVerifiedMosaService(service, options = {}) {
  if (!service || !Number.isInteger(service.port) || typeof service.libraryDir !== "string") return false;
  if (options.expectedIdentity && serviceIdentityConflict(service, options.expectedIdentity)) return false;

  const readFileImpl = options.readFileImpl || readFile;
  const lockPath = join(service.libraryDir, RUNTIME_LOCK_FILE_NAME);
  const owner = await readRuntimeLockOwner(lockPath, readFileImpl);
  if (!owner || owner.pid === process.pid) return false;

  const probeImpl = options.probeImpl || probeMosaService;
  const probeOptions = {
    host: options.host || DEFAULT_HOST,
    port: service.port,
    libraryDir: service.libraryDir,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.probeTimeoutMs,
  };
  const current = await probeImpl(probeOptions);
  if (current.state !== "attached" || !sameReportedServiceIdentity(current, service)) return false;
  if (options.expectedIdentity && serviceIdentityConflict(current, options.expectedIdentity)) return false;

  const isProcessAlive = options.isProcessAlive || defaultIsProcessAlive;
  if (!isProcessAlive(owner.pid)) return false;
  const verifyProcessIdentity = options.verifyProcessIdentity || verifyMosaRuntimeLockProcessIdentity;
  if (await verifyProcessIdentity(owner) !== true) return false;
  const terminateProcess = options.terminateProcess || ((pid) => process.kill(pid, "SIGTERM"));
  try {
    terminateProcess(owner.pid);
  } catch {
    return false;
  }

  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_UPGRADE_STOP_TIMEOUT_MS);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_UPGRADE_STOP_POLL_MS);
  const maxChecks = Math.max(1, Math.ceil(timeoutMs / pollMs));
  const sleepImpl = options.sleepImpl || ((delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)));
  for (let check = 0; check < maxChecks; check += 1) {
    const alive = isProcessAlive(owner.pid);
    const status = await probeImpl(probeOptions);
    if (!alive && (status.state === "unavailable" || (status.state === "conflict" && status.retryable === true))) return true;
    if (status.state === "attached") {
      // The original owner can still answer health while draining. Matching
      // build identity does not mean its library lock has been released.
      if (!sameReportedServiceIdentity(status, service)) return false;
    }
    if (status.state === "conflict" && status.retryable !== true) return false;
    if (check + 1 < maxChecks) await sleepImpl(pollMs);
  }
  return false;
}

async function probeLegacyMosaIdentity({ url, fetchImpl, signal }) {
  const [libraryResponse, bridgesResponse] = await Promise.all([
    fetchImpl(`${url}/api/library-path`, { signal }),
    fetchImpl(`${url}/api/bridges`, { signal }),
  ]);
  if (!libraryResponse.ok || !bridgesResponse.ok) return null;

  const [library, bridges] = await Promise.all([
    libraryResponse.json(),
    bridgesResponse.json(),
  ]);
  const hasLibraryContract = typeof library?.libraryDir === "string"
    && typeof library?.path === "string"
    && typeof library?.storage === "string";
  const hasBridgeContract = bridges && typeof bridges === "object"
    && bridges.codex && typeof bridges.codex === "object"
    && bridges.cowart && typeof bridges.cowart === "object";
  if (!hasLibraryContract || !hasBridgeContract) return null;

  return {
    product: "mosa",
    libraryDir: library.libraryDir,
    storage: library.storage,
  };
}

function attachedService(details, clientToken = "") {
  return {
    mode: "attached",
    url: details.url,
    port: details.port,
    libraryDir: details.libraryDir,
    storage: details.storage,
    productVersion: details.productVersion || "unknown",
    gitSha: details.gitSha || "unknown",
    uiFingerprint: details.uiFingerprint || "unknown",
    runtimeFingerprint: details.runtimeFingerprint || "unknown",
    clientToken,
    stop: async () => {},
  };
}

function ownedService(runtime) {
  let stopPromise = null;
  return {
    mode: "owned",
    url: runtime.url,
    port: runtime.port,
    libraryDir: runtime.libraryDir,
    storage: runtime.storage,
    productVersion: runtime.productVersion,
    gitSha: runtime.gitSha,
    uiFingerprint: runtime.uiFingerprint,
    runtimeFingerprint: runtime.runtimeFingerprint,
    clientToken: runtime.clientToken,
    stop() {
      if (!stopPromise) stopPromise = runtime.stop();
      return stopPromise;
    },
  };
}

function conflict(message, cause, { retryable = false } = {}) {
  return { state: "conflict", error: new MosaServiceConflictError(message, { cause }), retryable };
}

function serviceIdentityConflict(details, expectedIdentity) {
  if (!expectedIdentity || typeof expectedIdentity !== "object") return null;
  const fields = ["serviceProtocolVersion", "productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint", "clientAuthFingerprint"];
  const mismatches = [];
  for (const field of fields) {
    const expected = normalizedIdentityValue(expectedIdentity[field]);
    const actual = normalizedIdentityValue(details[field]);
    if (expected === "unknown") continue;
    if (actual === "unknown") {
      mismatches.push({ field, expected, actual });
      continue;
    }
    if (expected !== actual) mismatches.push({ field, expected, actual });
  }
  if (!mismatches.length) return null;
  return new MosaServiceBuildMismatchError({ details, expectedIdentity, mismatches });
}

export function compareMosaVersions(left, right) {
  const leftVersion = parseMosaVersion(left);
  const rightVersion = parseMosaVersion(right);
  if (!leftVersion || !rightVersion) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (leftVersion[key] > rightVersion[key]) return 1;
    if (leftVersion[key] < rightVersion[key]) return -1;
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function parseMosaVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || "").trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  const prerelease = match[4] ? match[4].split(".") : [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && !Number.isSafeInteger(Number(part))))) return null;
  return { major, minor, patch, prerelease };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= left.length) return -1;
    if (index >= right.length) return 1;
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function normalizedIdentityValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function hasCompleteServiceIdentity(identity) {
  return ["productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint"]
    .every((field) => normalizedIdentityValue(identity?.[field]) !== "unknown");
}

function sameReportedServiceIdentity(left, right) {
  return ["serviceProtocolVersion", "productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint"]
    .every((field) => normalizedIdentityValue(left?.[field]) === normalizedIdentityValue(right?.[field]));
}

function isRetirableServiceMismatch(conflict, options = {}) {
  if (!(conflict instanceof MosaServiceBuildMismatchError)) return false;
  if (conflict.upgradeEligible === true) return true;
  return options.allowSameVersionReplacement === true
    && conflict.sameVersionReplacementEligible === true;
}

async function readRuntimeLockOwner(lockPath, readFileImpl) {
  try {
    const parsed = JSON.parse(await readFileImpl(lockPath, "utf8"));
    if (typeof parsed?.token !== "string" || !parsed.token || !Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    if (parsed.processIdentity != null && typeof parsed.processIdentity !== "string") return null;
    return {
      token: parsed.token,
      pid: parsed.pid,
      ...(parsed.processIdentity ? { processIdentity: parsed.processIdentity } : {}),
    };
  } catch {
    return null;
  }
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isConnectionRefused(error) {
  return error?.cause?.code === "ECONNREFUSED" || error?.code === "ECONNREFUSED";
}
