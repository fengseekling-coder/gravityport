import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";

export const BACKGROUND_AGENT_LABEL = "com.azhuilab.gravityport.background";
const BLOCKED_ENV = ["MOSA_QA_RUN", "MOSA_USER_DATA", "MOSA_LIBRARY_DIR", "GRAVITYPORT_LIBRARY_DIR", "MOSA_DESKTOP_PORT", "MOSA_RUNTIME_MODE"];

export function shouldManageBackgroundAgent({ platform, isPackaged, env = {} } = {}) {
  return platform === "darwin" && isPackaged === true && BLOCKED_ENV.every(key => !env[key]);
}

function xml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const string = value => `<string>${xml(value)}</string>`;
const key = value => `<key>${xml(value)}</key>`;

export function buildBackgroundAgentPlist({ execPath, agentEntry, userDataDir, logDir }) {
  const args = ["/bin/sh", "-c", '[ -x "$1" ] || exit 0; exec "$1" "$2"', "gravityport-background", execPath, agentEntry];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${key("Label")}${string(BACKGROUND_AGENT_LABEL)}
${key("ProgramArguments")}<array>${args.map(string).join("")}</array>
${key("EnvironmentVariables")}<dict>${key("ELECTRON_RUN_AS_NODE")}${string("1")}${key("MOSA_DESKTOP_DATA_DIR")}${string(userDataDir)}</dict>
${key("KeepAlive")}<dict>${key("SuccessfulExit")}<false/></dict>
${key("RunAtLoad")}<true/>
${key("ProcessType")}${string("Background")}
${key("ThrottleInterval")}<integer>10</integer>
${key("StandardOutPath")}${string(join(logDir, "background.out.log"))}
${key("StandardErrorPath")}${string(join(logDir, "background.err.log"))}
</dict>
</plist>
`;
}

export async function syncBackgroundAgent({ enabled, desiredXml, plistPath, uid, fs, launchctl }) {
  const io = fs || { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync };
  const exists = io.existsSync(plistPath);
  const target = `gui/${uid}`;
  const bootout = async () => { try { await launchctl(["bootout", `${target}/${BACKGROUND_AGENT_LABEL}`]); } catch {} };
  if (!enabled) {
    if (!exists) return { action: "absent", ok: true };
    try {
      await bootout();
      io.unlinkSync(plistPath);
      return { action: "removed", ok: true };
    } catch (error) {
      return { action: "removed", ok: false, error: String(error?.message || error).split("\n")[0] };
    }
  }
  let action = exists ? "updated" : "installed";
  try {
    if (exists && String(io.readFileSync(plistPath, "utf8")) === desiredXml) {
      const kickstart = await launchctl(["kickstart", `${target}/${BACKGROUND_AGENT_LABEL}`]);
      if (kickstart?.code === 0) return { action: "unchanged", ok: true };
      const reloaded = await launchctl(["bootstrap", target, plistPath]);
      if (reloaded?.code !== 0) {
        return { action: "reloaded", ok: false, error: String(reloaded?.stderr || "launchctl bootstrap failed").split("\n")[0] };
      }
      return { action: "reloaded", ok: true };
    }
    await bootout();
    io.mkdirSync(dirname(plistPath), { recursive: true });
    io.writeFileSync(plistPath, desiredXml, { encoding: "utf8", mode: 0o644 });
    const status = await launchctl(["bootstrap", target, plistPath]);
    if (status?.code !== 0) return { action, ok: false, error: String(status?.stderr || "launchctl bootstrap failed").split("\n")[0] };
    return { action, ok: true };
  } catch (error) {
    return { action, ok: false, error: String(error?.message || error).split("\n")[0] };
  }
}

const SETTING_FILE = "background-capture.json";
export function readBackgroundCaptureSetting(userDataDir, fs = { readFileSync }) {
  try {
    const setting = JSON.parse(fs.readFileSync(join(userDataDir, SETTING_FILE), "utf8"));
    return { enabled: typeof setting?.enabled === "boolean" ? setting.enabled : true };
  } catch {
    return { enabled: true };
  }
}

export function writeBackgroundCaptureSetting(userDataDir, enabled, fs = { mkdirSync, writeFileSync, renameSync }) {
  if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
  const file = join(userDataDir, SETTING_FILE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(temp, JSON.stringify({ enabled }), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
}
