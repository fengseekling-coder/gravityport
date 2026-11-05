import "../lib/apply-env-aliases.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSupervisor } from "./web-capture-supervisor.mjs";

export function agentRuntimeEnv({ env = process.env, userDataDir, readFileSync: read = readFileSync } = {}) {
  const result = { ...env, MOSA_BACKGROUND_RUNTIME: "1", ELECTRON_RUN_AS_NODE: "1" };
  for (const [filename, key] of [
    ["web-capture-token", "MOSA_WEB_CAPTURE_TOKEN"],
    ["desktop-client-token", "MOSA_CLIENT_TOKEN"],
  ]) {
    try {
      const value = String(read(join(userDataDir, filename), "utf8")).trim();
      if (!value) throw new Error("empty");
      result[key] = value;
    } catch {
      const error = new Error(`Missing background capture credential: ${filename}`);
      error.code = "BACKGROUND_TOKEN_MISSING";
      throw error;
    }
  }
  // Explicit desktop tokens take precedence over inherited aliases.
  delete result.GRAVITYPORT_WEB_CAPTURE_TOKEN;
  return result;
}

export function readBundleVersion({ execPath, readFileSync: read = readFileSync } = {}) {
  const plistPath = join(dirname(dirname(execPath)), "Info.plist");
  const match = String(read(plistPath, "utf8")).match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match) throw new Error("CFBundleShortVersionString missing");
  return match[1];
}

export function createBundleVersionGuard({ readVersion }) {
  const initial = readVersion();
  return {
    initial,
    changed() {
      try { return readVersion() !== initial; } catch { return true; }
    },
  };
}

export async function runBackgroundCaptureAgent({
  env = process.env,
  execPath = process.execPath,
  appRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  readFileSync: read = readFileSync,
  spawnImpl = spawn,
  supervisor = runSupervisor,
  logger = console,
  exit = (code) => process.exit(code),
  idlePollMs = 5000,
} = {}) {
  if (!env.MOSA_DESKTOP_DATA_DIR) return { exitReason: "not-launched" };
  const guard = createBundleVersionGuard({
    readVersion: () => readBundleVersion({ execPath, readFileSync: read }),
  });
  const result = await supervisor({
    idlePollMs,
    shouldExit: () => guard.changed(),
    spawnRuntime: () => spawnImpl(execPath, [join(appRoot, "desktop", "background-runtime-entry.mjs")], {
      env: agentRuntimeEnv({ env, userDataDir: env.MOSA_DESKTOP_DATA_DIR, readFileSync: read }),
      stdio: "inherit",
    }),
    watchSources: () => ({ promise: new Promise(() => {}), close() {} }),
    logger,
  });
  if (result?.exitReason === "should-exit") exit(75);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBackgroundCaptureAgent();
}
