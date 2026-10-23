import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const LOCK_FILE_NAME = ".mosa-runtime.lock";
const execFileAsync = promisify(execFile);

interface LockOwner {
  token: string;
  pid: number;
  createdAt: string;
  processIdentity?: string;
}

interface Lease {
  lockPath: string;
  owner: LockOwner;
  release(): Promise<boolean>;
}

export async function acquireMosaRuntimeLock(options: { libraryDir?: string; lockFileName?: string } = {}): Promise<Lease> {
  const libraryDir = options.libraryDir ? resolve(options.libraryDir) : null;
  if (!libraryDir) throw new Error("GravityPort runtime lock requires a library directory.");
  const lockPath = resolve(libraryDir, options.lockFileName || LOCK_FILE_NAME);
  await mkdir(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const owner: LockOwner = {
        token,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        processIdentity: await readMosaRuntimeProcessIdentity(process.pid) || undefined,
      };
      try {
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await removeLockIfOwned(lockPath, token);
        throw error;
      }
      let released = false;
      return {
        lockPath,
        owner,
        async release(): Promise<boolean> {
          if (released) return false;
          released = true;
          await handle.close().catch(() => {});
          return removeLockIfOwned(lockPath, token);
        },
      };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      const owner = await readLockOwner(lockPath);
      if (!owner) throw new Error(`GravityPort runtime lock at ${lockPath} is incomplete or malformed. Stop the existing GravityPort runtime or remove the stale lock after confirming no runtime is active.`);
      if (await lockOwnerIsActive(owner)) throw activeRuntimeError(lockPath, owner);
      const retiredPath = `${lockPath}.stale-${randomUUID()}`;
      try {
        await rename(lockPath, retiredPath);
      } catch (renameError: unknown) {
        if ((renameError as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw renameError;
      }
      await unlink(retiredPath).catch(() => {});
    }
  }
  const owner = await readLockOwner(lockPath);
  if (owner && await lockOwnerIsActive(owner)) throw activeRuntimeError(lockPath, owner);
  throw new Error(`Could not acquire the GravityPort runtime lock at ${lockPath}.`);
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8"));
    if (typeof parsed?.token !== "string" || !Number.isInteger(parsed?.pid) || parsed.pid <= 0) return null;
    if (parsed.processIdentity != null && typeof parsed.processIdentity !== "string") return null;
    return parsed as LockOwner;
  } catch {
    return null;
  }
}

async function removeLockIfOwned(lockPath: string, token: string): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner || owner.token !== token) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function lockOwnerIsActive(owner: LockOwner): Promise<boolean> {
  if (!isProcessAlive(owner.pid)) return false;
  const identityMatch = await verifyMosaRuntimeLockProcessIdentity(owner);
  return identityMatch !== false;
}

export async function verifyMosaRuntimeLockProcessIdentity(owner: {
  pid?: number;
  processIdentity?: string;
}): Promise<boolean | null> {
  if (!Number.isInteger(owner?.pid) || Number(owner.pid) <= 0 || !owner.processIdentity) return null;
  const currentIdentity = await readMosaRuntimeProcessIdentity(Number(owner.pid));
  if (!currentIdentity) return null;
  return currentIdentity === owner.processIdentity;
}

export async function readMosaRuntimeProcessIdentity(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "win32") {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        timeout: 3000,
        encoding: "utf8",
      });
      const value = stdout.trim();
      return value ? `win-start:${value}` : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 3000,
      encoding: "utf8",
    });
    const value = stdout.trim().replace(/\s+/g, " ");
    return value ? `unix-start:${value}` : null;
  } catch {
    return null;
  }
}

function activeRuntimeError(lockPath: string, owner: LockOwner): Error {
  return new Error(`GravityPort runtime already active for this library (PID ${owner.pid}; lock ${lockPath}). Stop that runtime or choose a different GRAVITYPORT_LIBRARY_DIR.`);
}
