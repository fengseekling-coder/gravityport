#!/usr/bin/env node
/**
 * Dev launcher for `desktop:start`.
 *
 * Windows uses Electron's normal direct launch path. On macOS 26.x, launching
 * a GUI app (Electron) as a child of another GUI
 * app (ChatGPT/Codex) causes `_RegisterApplication` to abort() before any
 * JS runs.  Spotlight being disabled also breaks the `open` LaunchServices
 * path (kLSNoExecutableErr).
 *
 * This launcher tries three strategies in order:
 * 1. `open -n` on a temporary .app wrapper (LaunchServices path) — works
 *    when Spotlight is enabled.
 * 2. `osascript` → Terminal.app `do script` — works when Terminal is
 *    already running in the loginwindow session.
 * 3. Direct binary execution — last resort; will crash if launched from
 *    within ChatGPT/Codex.
 *
 * Production defaults are preserved: no QA isolation env, no
 * --user-data-dir override, no temporary library dir.
 */

import { existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { getBuildIdentity } from "../lib/build-identity.mjs";
import { MOSA_SERVICE_PROTOCOL_VERSION } from "../lib/version-identities.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(__dirname, "..");

const ELECTRON_BIN = process.platform === "darwin"
  ? join(
      REPO_ROOT,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    )
  : process.platform === "win32"
    ? join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe")
    : "";

const DESKTOP_SCRIPT = "desktop/main.mjs";
const HEALTH_URL = "http://127.0.0.1:43517/api/health";
const HEALTH_TIMEOUT_MS = 30_000;
const EXPECTED_SERVICE_IDENTITY = Object.freeze({
  ...getBuildIdentity(join(REPO_ROOT, "web", "gravityport", "dist")),
  serviceProtocolVersion: MOSA_SERVICE_PROTOCOL_VERSION,
});

function healthMatchesCurrentBuild(health) {
  if (health?.product !== "mosa") return false;
  return ["serviceProtocolVersion", "productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint"]
    .every((field) => typeof health?.[field] === "string" && health[field] === EXPECTED_SERVICE_IDENTITY[field]);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

/**
 * Strategy 1: wrap in a temp .app and `open -n`.
 * Requires Spotlight/LaunchServices to be functional.
 */
function tryOpenViaLaunchServices() {
  const rootDir = mkdtempSync(join(tmpdir(), "mosa-desktop-"));
  const appDir = join(rootDir, "MOSA Dev.app");
  const contentsDir = join(appDir, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const launcherPath = join(macosDir, "launch-mosa-dev");
  const logFile = join(rootDir, "desktop.log");

  mkdirSync(macosDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch-mosa-dev</string>
  <key>CFBundleIdentifier</key><string>com.azhuilab.mosa.dev-launcher</string>
  <key>CFBundleName</key><string>MOSA Dev</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
</dict>
</plist>
`;

  const launcher = `#!/bin/sh
set -eu
cd ${shellQuote(REPO_ROOT)}
exec ${shellQuote(ELECTRON_BIN)} ${shellQuote(DESKTOP_SCRIPT)} >> ${shellQuote(logFile)} 2>&1
`;

  writeFileSync(join(contentsDir, "Info.plist"), plist, "utf8");
  writeFileSync(launcherPath, launcher, "utf8");
  chmodSync(launcherPath, 0o755);

  try {
    // No `-W`: it blocks until the launched app exits, so a healthy GUI launch
    // would always outlive any exec timeout and be misreported as failure —
    // then re-launched by the fallback strategies. Plain `open -n` returns
    // once LaunchServices accepts the handoff; waitForHealth gates readiness.
    execFileSync("open", ["-n", appDir], {
      stdio: "inherit",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strategy 2: use osascript to tell Terminal.app to run the command.
 * Only works if Terminal is already running in the loginwindow session.
 */
function tryOpenViaTerminal() {
  const cmd = `cd ${shellQuote(REPO_ROOT)} && ${shellQuote(ELECTRON_BIN)} ${shellQuote(DESKTOP_SCRIPT)}`;
  const script = `tell application "Terminal" to do script ${shellQuote(cmd)}`;
  try {
    execFileSync("osascript", ["-e", script], {
      stdio: "inherit",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Strategy 3: direct binary execution (last resort).
 */
function launchDirect() {
  const child = spawn(ELECTRON_BIN, [DESKTOP_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
  return new Promise((resolveExit) => {
    child.on("exit", () => resolveExit());
  });
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!ELECTRON_BIN) {
    throw new Error(`desktop:start supports macOS and Windows only; current platform is ${process.platform}.`);
  }
  if (!existsSync(ELECTRON_BIN)) {
    throw new Error(
      `Electron binary not found at ${ELECTRON_BIN}. Run \`npm ci\` first.`,
    );
  }

  // Check if MOSA is already running.
  try {
    const res = await fetch(HEALTH_URL);
    if (res.ok) {
      const health = await res.json();
      if (healthMatchesCurrentBuild(health)) {
        console.log(`MOSA is already running (pid unknown, libraryDir=${health.libraryDir}).`);
        console.log(`Health: ${JSON.stringify(health)}`);
        return;
      }
      console.log("A stale MOSA local service is running; launching the current desktop build so it can perform a verified handoff.");
    }
  } catch {
    // not running, proceed to launch
  }

  console.log("Launching MOSA desktop...");

  if (process.platform === "win32") {
    console.log("  Using the native Windows Electron launch path...");
    await launchDirect();
    return;
  }

  // Strategy 1: LaunchServices `open -n` on a temp .app wrapper.
  console.log("  Trying LaunchServices (open -n)...");
  if (tryOpenViaLaunchServices()) {
    const ok = await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS);
    if (ok) {
      console.log("MOSA launched via LaunchServices.");
      return;
    }
    console.log("  LaunchServices opened but health check failed.");
  } else {
    console.log("  LaunchServices failed (Spotlight disabled or kLSNoExecutableErr).");
  }

  // Strategy 2: osascript → Terminal.app.
  console.log("  Trying osascript → Terminal.app...");
  if (tryOpenViaTerminal()) {
    const ok = await waitForHealth(HEALTH_URL, HEALTH_TIMEOUT_MS);
    if (ok) {
      console.log("MOSA launched via Terminal.app.");
      return;
    }
    console.log("  Terminal.app command sent but health check failed.");
  } else {
    console.log("  osascript failed (Terminal not running or HIServices error).");
  }

  // Strategy 3: direct binary execution (may crash if in ChatGPT process tree).
  console.log("  Falling back to direct binary execution...");
  console.log("  WARNING: If this crashes with SIGABRT, launch from Terminal.app instead:");
  console.log(`    cd ${REPO_ROOT} && npx electron ${DESKTOP_SCRIPT}`);
  await launchDirect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
