import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const GUI_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LOGNAME",
  "NODE_ENV",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
]);

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function selectGuiEnvironment(sourceEnv) {
  return Object.fromEntries(
    Object.entries(sourceEnv).filter(([key, value]) => {
      if (value == null) return false;
      return GUI_ENV_KEYS.has(key) || key.startsWith("LC_") || key.startsWith("MOSA_") || key.startsWith("ELECTRON_");
    }),
  );
}

export async function createMacGuiLauncher({ rootDir, executable, args, env, cwd, pidFile, logFile, healthUrl, healthFile }) {
  // LSUIElement (agent app) keeps the QA launcher itself out of the Dock and
  // out of the foreground when `open` launches it (task 229); the Electron
  // child manages its own activation policy.
  const appDir = join(rootDir, "MOSA QA Launcher.app");
  const contentsDir = join(appDir, "Contents");
  const macosDir = join(contentsDir, "MacOS");
  const launcherPath = join(macosDir, "launch-mosa-qa");
  await mkdir(macosDir, { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>launch-mosa-qa</string>
  <key>CFBundleIdentifier</key><string>com.azhuilab.mosa.qa-launcher</string>
  <key>CFBundleName</key><string>MOSA QA Launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

  const cleanEnv = selectGuiEnvironment(env);
  const envArgs = Object.entries(cleanEnv).map(([key, value]) => `${key}=${value}`);
  const command = ["/usr/bin/env", "-i", ...envArgs, executable, ...args].map(shellQuote).join(" ");
  const launcher = `#!/bin/sh
set -eu
cd ${shellQuote(cwd)}
${command} >> ${shellQuote(logFile)} 2>&1 &
child_pid=$!
printf '%s' "$child_pid" > ${shellQuote(pidFile)}
(
  attempts=0
  while [ "$attempts" -lt 900 ]; do
    if /usr/bin/curl -fsS --max-time 1 ${shellQuote(healthUrl)} > ${shellQuote(`${healthFile}.tmp`)}; then
      /bin/mv ${shellQuote(`${healthFile}.tmp`)} ${shellQuote(healthFile)}
      exit 0
    fi
    attempts=$((attempts + 1))
    /bin/sleep 0.1
  done
  /bin/rm -f ${shellQuote(`${healthFile}.tmp`)}
) &
wait "$child_pid"
`;

  await writeFile(join(contentsDir, "Info.plist"), plist, "utf8");
  await writeFile(launcherPath, launcher, "utf8");
  await chmod(launcherPath, 0o755);
  return appDir;
}

export function openMacGuiLauncher(appDir) {
  // -g: launch in the background — without it Launch Services hands `open`'s
  // activation intent to the Electron child, which steals the user's focus
  // even though the bundle itself is LSUIElement (task 229).
  return spawn("open", ["-g", "-n", "-W", appDir], {
    stdio: "inherit",
  });
}

export const testing = { shellQuote, xmlEscape };
