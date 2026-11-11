/**
 * Locates an installed GravityPort desktop app for the MCP launcher.
 *
 * Returns { execPath, serverPath } for the first candidate that holds both
 * files, or null when none does. Only the executable and the app.asar archive
 * itself are probed: app.asar is a packed file, so a plain Node existsSync
 * answers false for anything inside it — server.mjs must never be checked
 * directly.
 */

import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { join } from "node:path";

/** macOS app root is the .app directory. */
function macOsCandidate(appRoot) {
  const asarPath = join(appRoot, "Contents", "Resources", "app.asar");
  return {
    execPath: join(appRoot, "Contents", "MacOS", "GravityPort"),
    asarPath,
    serverPath: join(asarPath, "mcp", "server.mjs"),
  };
}

/** Windows app root is the folder that holds GravityPort.exe. */
function windowsCandidate(appRoot) {
  const asarPath = join(appRoot, "resources", "app.asar");
  return {
    execPath: join(appRoot, "GravityPort.exe"),
    asarPath,
    serverPath: join(asarPath, "mcp", "server.mjs"),
  };
}

function useIfInstalled(exists, candidate) {
  if (exists(candidate.execPath) && exists(candidate.asarPath)) {
    return { execPath: candidate.execPath, serverPath: candidate.serverPath };
  }
  return null;
}

export function findGravityPortApp({
  platform = process.platform,
  env = process.env,
  homedir = osHomedir,
  exists = existsSync,
} = {}) {
  // GRAVITYPORT_APP_PATH is the user's own answer to "where is the app":
  // on macOS the .app directory, on Windows the folder that holds
  // GravityPort.exe. Once it is set it is authoritative — a path without both
  // files answers "not found" so the launcher can point at the problem,
  // instead of silently starting a different installation from /Applications
  // or %LOCALAPPDATA%. GravityPort ships for macOS and Windows only, so on
  // any other platform the answer is null either way.
  const override = typeof env?.GRAVITYPORT_APP_PATH === "string" ? env.GRAVITYPORT_APP_PATH : "";
  if (override) {
    if (platform === "darwin") return useIfInstalled(exists, macOsCandidate(override));
    if (platform === "win32") return useIfInstalled(exists, windowsCandidate(override));
    return null;
  }
  if (platform === "darwin") {
    for (const appRoot of ["/Applications/GravityPort.app", join(homedir(), "Applications", "GravityPort.app")]) {
      const found = useIfInstalled(exists, macOsCandidate(appRoot));
      if (found) return found;
    }
    return null;
  }
  if (platform === "win32") {
    const localAppData = typeof env?.LOCALAPPDATA === "string" ? env.LOCALAPPDATA : "";
    if (!localAppData) return null;
    return useIfInstalled(exists, windowsCandidate(join(localAppData, "Programs", "GravityPort", "app")));
  }
  return null;
}
