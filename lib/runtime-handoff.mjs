import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  readMosaRuntimeProcessIdentity,
  verifyMosaRuntimeLockProcessIdentity,
} from "./runtime-lock.js";

export const MOSA_DESKTOP_STARTUP_HANDOFF_FILE = ".mosa-desktop-starting.json";
export const MOSA_DESKTOP_STARTUP_HANDOFF_SCHEMA = "mosa.desktop-startup-handoff/1";
// Cover Desktop's bounded 30s drain wait plus its own runtime startup. The
// supervisor must not reclaim the library just as that wait finishes.
export const DEFAULT_DESKTOP_STARTUP_HANDOFF_TTL_MS = 90_000;
export const DEFAULT_MACOS_UPDATE_HELPER_HANDOFF_TTL_MS = 90_000;
const MAX_DESKTOP_STARTUP_HANDOFF_FUTURE_MS = 120_000;

export function mosaDesktopStartupHandoffPath(libraryDir) {
  const root = String(libraryDir || "").trim();
  if (!root) throw new Error("GravityPort desktop startup handoff requires a library directory.");
  return join(resolve(root), MOSA_DESKTOP_STARTUP_HANDOFF_FILE);
}

export async function createMosaDesktopStartupHandoff({
  libraryDir,
  pid = process.pid,
  ttlMs = DEFAULT_DESKTOP_STARTUP_HANDOFF_TTL_MS,
  now = () => Date.now(),
  readProcessIdentity = readMosaRuntimeProcessIdentity,
  randomUUIDImpl = randomUUID,
} = {}) {
  const markerPath = mosaDesktopStartupHandoffPath(libraryDir);
  const identity = await readProcessIdentity(pid);
  if (!identity) throw new Error("GravityPort desktop startup handoff could not verify the desktop process identity.");
  const ttl = Math.min(MAX_DESKTOP_STARTUP_HANDOFF_FUTURE_MS, Math.max(1_000, Number(ttlMs) || DEFAULT_DESKTOP_STARTUP_HANDOFF_TTL_MS));
  const createdMs = now();
  const token = randomUUIDImpl();
  const marker = {
    schema: MOSA_DESKTOP_STARTUP_HANDOFF_SCHEMA,
    token,
    pid,
    processIdentity: identity,
    createdAt: new Date(createdMs).toISOString(),
    expiresAt: new Date(createdMs + ttl).toISOString(),
  };
  await mkdir(dirname(markerPath), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(markerPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      return handoffLease({ markerPath, marker });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await probeMosaDesktopStartupHandoff({ libraryDir, now });
      if (existing.state === "handoff") {
        throw new Error(`Another verified GravityPort desktop startup is already claiming this library (PID ${existing.owner.pid}).`);
      }
      const retiredPath = `${markerPath}.stale-${randomUUIDImpl()}`;
      try {
        await rename(markerPath, retiredPath);
        await unlink(retiredPath).catch(() => {});
      } catch (renameError) {
        if (renameError?.code !== "ENOENT") throw renameError;
      }
    }
  }
  throw new Error(`Could not create GravityPort desktop startup handoff marker at ${markerPath}.`);
}

export async function createMosaMacosUpdateHelperHandoff(options = {}) {
  return createMosaDesktopStartupHandoff({
    ...options,
    ttlMs: options.ttlMs ?? DEFAULT_MACOS_UPDATE_HELPER_HANDOFF_TTL_MS,
  });
}

export async function probeMosaDesktopStartupHandoff({
  libraryDir,
  now = () => Date.now(),
  readFileImpl = readFile,
  unlinkImpl = unlink,
  isProcessAlive = defaultIsProcessAlive,
  verifyProcessIdentity = verifyMosaRuntimeLockProcessIdentity,
} = {}) {
  const markerPath = mosaDesktopStartupHandoffPath(libraryDir);
  let marker;
  try {
    marker = JSON.parse(await readFileImpl(markerPath, "utf8"));
  } catch {
    return { state: "unavailable" };
  }
  if (!validMarkerShape(marker)) {
    await unlinkImpl(markerPath).catch(() => {});
    return { state: "unavailable" };
  }
  const nowMs = now();
  const createdMs = Date.parse(marker.createdAt);
  const expiresMs = Date.parse(marker.expiresAt);
  if (!Number.isFinite(createdMs)
    || !Number.isFinite(expiresMs)
    || expiresMs <= nowMs
    || expiresMs > nowMs + MAX_DESKTOP_STARTUP_HANDOFF_FUTURE_MS) {
    await unlinkImpl(markerPath).catch(() => {});
    return { state: "unavailable" };
  }
  if (!isProcessAlive(marker.pid)) {
    await unlinkImpl(markerPath).catch(() => {});
    return { state: "unavailable" };
  }
  const identityMatch = await verifyProcessIdentity(marker);
  if (identityMatch !== true) {
    if (identityMatch === false) await unlinkImpl(markerPath).catch(() => {});
    return { state: "unavailable" };
  }
  return {
    state: "handoff",
    owner: {
      pid: marker.pid,
      createdAt: marker.createdAt,
      expiresAt: marker.expiresAt,
    },
  };
}

function handoffLease({ markerPath, marker }) {
  let released = false;
  return {
    markerPath,
    owner: Object.freeze({ ...marker }),
    async release() {
      if (released) return false;
      released = true;
      let current;
      try {
        current = JSON.parse(await readFile(markerPath, "utf8"));
      } catch {
        return false;
      }
      if (current?.token !== marker.token) return false;
      try {
        await unlink(markerPath);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
  };
}

function validMarkerShape(marker) {
  return marker?.schema === MOSA_DESKTOP_STARTUP_HANDOFF_SCHEMA
    && typeof marker.token === "string" && marker.token.length >= 8
    && Number.isInteger(marker.pid) && marker.pid > 0
    && typeof marker.processIdentity === "string" && marker.processIdentity.length > 0
    && typeof marker.createdAt === "string"
    && typeof marker.expiresAt === "string";
}

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
