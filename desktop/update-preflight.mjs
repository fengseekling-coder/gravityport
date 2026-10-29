// Checks run before an in-app update starts: free disk space, a writable install
// folder, and (Windows) whether another program still holds the install files.
// Everything here is a pure function or takes its I/O as an argument, so the
// rules can be tested without a real install.
import { execFile } from "node:child_process";
import { mkdir as defaultMkdir, rm as defaultRm, statfs as defaultStatfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
export const UPDATE_PREFLIGHT_HEADROOM_BYTES = 256 * MiB;

// The App's update package unpacks to about 2.5x its ZIP size (measured on the
// 0.3.7 macOS and Windows packages). The Mac helper now renames the unpacked
// app instead of copying it, so the install step needs one unpacked copy and
// the 3x budget leaves room for the parked previous app.
export function requiredDownloadBytes(artifactSize) {
  return Number(artifactSize) + UPDATE_PREFLIGHT_HEADROOM_BYTES;
}

export function requiredInstallBytes(artifactSize) {
  return Number(artifactSize) * 3 + UPDATE_PREFLIGHT_HEADROOM_BYTES;
}

/** Free space available to unprivileged users on the volume holding `dir`. */
export async function checkFreeSpace({ dir, requiredBytes, statfs = defaultStatfs }) {
  const info = await statfs(dir);
  const availableBytes = Number(info.bavail) * Number(info.bsize);
  return { ok: availableBytes >= requiredBytes, availableBytes, requiredBytes };
}

/** "1.2 GB" above a gigabyte, otherwise whole megabytes ("850 MB"). */
export function formatBytesForDialog(bytes) {
  const value = Number(bytes);
  if (value >= GiB) return `${(value / GiB).toFixed(1)} GB`;
  return `${Math.round(value / MiB)} MB`;
}

/**
 * The install folder's parent must accept a new entry: the helper moves the old
 * install aside there. Probes with a throwaway directory, removed right after.
 */
export async function checkWindowsInstallDirWritable({
  installDir,
  mkdir = defaultMkdir,
  rm = defaultRm,
  randomId = () => randomUUID(),
} = {}) {
  const probe = join(dirname(installDir), `.MOSA-write-probe-${randomId()}`);
  try {
    await mkdir(probe);
    await rm(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// Windows installs must sit in a subdirectory. A drive-root install would make
// the prefix below match every process on that drive, so refuse it outright.
function installDirPrefix(installDir) {
  const trimmed = String(installDir).replace(/[\\/]+$/, "");
  if (!/[\\/]/.test(trimmed)) {
    throw new Error(`MOSA update requires a subdirectory install, not a drive root: ${installDir}`);
  }
  return `${trimmed}\\`;
}

/**
 * Processes whose executable lives inside the install folder, excluding this
 * process and everything it started (GravityPort's own renderer, GPU and local
 * service processes are the same exe). What remains is usually an AI assistant's
 * MCP server holding the install files open.
 */
export function findExternalInstallProcesses({ installDir, selfPid, processes }) {
  const prefix = installDirPrefix(installDir).toLowerCase();
  const childrenByParent = new Map();
  for (const entry of processes) {
    const siblings = childrenByParent.get(entry.ParentProcessId) || [];
    siblings.push(entry.ProcessId);
    childrenByParent.set(entry.ParentProcessId, siblings);
  }
  const ownTree = new Set([selfPid]);
  const queue = [selfPid];
  while (queue.length > 0) {
    for (const childId of childrenByParent.get(queue.shift()) || []) {
      if (ownTree.has(childId)) continue;
      ownTree.add(childId);
      queue.push(childId);
    }
  }
  return processes.filter((entry) => (
    !ownTree.has(entry.ProcessId)
    && typeof entry.ExecutablePath === "string"
    && entry.ExecutablePath.toLowerCase().startsWith(prefix)
  ));
}

/** Lists every process with its parent and executable path via PowerShell/CIM. */
export async function listWindowsProcesses({ runPowerShell = runPowerShellCommand } = {}) {
  // UTF-8 output so install paths with non-ASCII folder names (a Chinese user
  // name, for example) still match; the console code page would mangle them.
  const output = await runPowerShell(
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
      + "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress",
  );
  const parsed = JSON.parse(String(output || "[]") || "[]");
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.filter((entry) => entry && Number.isInteger(entry.ProcessId));
}

/**
 * Whether another program (typically an AI assistant's MCP server) is holding
 * the install folder. If the process list cannot be read, the check passes and
 * the helper's own wait still applies.
 */
export async function checkWindowsInstallProcesses({ installDir, selfPid, listProcesses = listWindowsProcesses }) {
  let processes;
  try {
    processes = await listProcesses();
  } catch {
    return { ok: true, blockingProcessIds: [], unknown: true };
  }
  const blocking = findExternalInstallProcesses({ installDir, selfPid, processes });
  return { ok: blocking.length === 0, blockingProcessIds: blocking.map((entry) => entry.ProcessId), unknown: false };
}

function runPowerShellCommand(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 15_000, maxBuffer: 16 * MiB },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout || ""))),
    );
  });
}
