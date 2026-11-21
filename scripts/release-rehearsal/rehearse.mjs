#!/usr/bin/env node
// One-command update-rehearsal wrapper. It replaces the per-version
// hand-edited rehearse-<from>-to-<to>.sh shells: copy the installed app into a
// disposable work dir, extract its asar, launch it isolated, run one update
// step against it, verify the result, and stop the rehearsal app.
//
// Usage:
//   npm run release:rehearse -- --build <build worktree> [options]
//   node scripts/release-rehearsal/rehearse.mjs --build <build worktree> [options]
//
// Options:
//   --build <dir>          required; the build worktree created after tagging
//                          (provides the update ZIP, build identity, asar tool
//                          and, in local mode, --writer-src)
//   --mode local|live      default local: rehearse-update.mjs signs a feed with
//                          the real release key and serves the local update ZIP.
//                          live: rehearse-update-live.mjs talks to the real
//                          production feed and downloads the published ZIP; no
//                          private key is involved.
//   --from-app <path>      default /Applications/GravityPort.app; its file name
//                          becomes the app name used everywhere
//   --to-version x.y.z     default: the version field of <build>/package.json
//   --from-version x.y.z   default: read at runtime from the copied app's
//                          Info.plist (dry run prints 运行时读取)
//   --work-dir <dir>       default <system temp>/gp-rehearsal-local|-live;
//                          it is rm -rf'd at startup, so it must be inside the
//                          system temp directory and must not overlap the real
//                          app, the build tree or $HOME/MOSA Library
//   --port <n>             default 43617; 43517 (the user's own running app)
//                          is refused
//   --private-key <pem>    local mode only: the PATH of the signing key file; or
//                          the environment variable
//                          MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE. The inline
//                          MOSA_RELEASE_MANIFEST_PRIVATE_KEY (key content) is
//                          refused so the key never reaches a command line or
//                          the printed plan. No default path is written here —
//                          the key stays outside the repo
//   --feed-url <url>       default MOSA_UPDATE_FEED_URL from
//                          desktop/update-service.mjs
//   --dry-run              print the plan and exit without executing anything
//
// Safety: nothing outside <work-dir> is written; the cleanup step only kills
// processes that both listen on --port and have --work-dir in their command
// line; no packaged app is launched except the copies inside <work-dir>.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MOSA_UPDATE_FEED_URL } from "../../desktop/update-service.mjs";

const REHEARSAL_PORT_DEFAULT = 43617;
// The port the user's own running app listens on; rehearsals must never take it.
const USER_APP_PORT = 43517;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Placeholder in the plan for a from-version that is only known at runtime
// (read from the copied app's Info.plist after the copy step).
export const RUNTIME_FROM_VERSION = "<runtime: from-version from the copied app>";

const log = (...parts) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...parts);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function strictlyInside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sameOrContains(outer, inner) {
  return outer === inner || strictlyInside(outer, inner);
}

// Lexical resolve plus the realpath when the path exists, so a symlinked
// /Applications or $HOME entry cannot slip past the overlap checks.
function pathVariants(path) {
  const resolved = resolve(path);
  try { return [resolved, realpathSync(resolved)]; } catch { return [resolved]; }
}

// /tmp is a symlink to /private/tmp on macOS; compare against both spellings.
function canonicalTmpAlias(path) {
  return path === "/tmp" ? "/private/tmp" : path.startsWith("/tmp/") ? join("/private/tmp", path.slice(5)) : path;
}

function tmpRoots() {
  const lexical = resolve(tmpdir());
  let real = lexical;
  try { real = realpathSync(lexical); } catch { /* keep the lexical spelling */ }
  return [...new Set([lexical, real, "/tmp", "/private/tmp"])].map(canonicalTmpAlias);
}

// The work dir is rm -rf'd at startup: it must be strictly inside the system
// temp directory and must not equal, contain or sit inside any protected path.
function assertSafeWorkDir(workDir, protectedPaths) {
  const canonical = canonicalTmpAlias(resolve(workDir));
  if (!tmpRoots().some((root) => strictlyInside(root, canonical))) {
    throw new Error(`--work-dir ${workDir} must be inside the system temp directory (${tmpdir()} or /private/tmp) because the rehearsal rm -rf's it at startup`);
  }
  // Both sides go through the same /tmp spelling: on Linux /private/tmp does
  // not exist, so a canonical work dir would otherwise never match a
  // protected path spelled under /tmp.
  for (const protectedPath of protectedPaths) {
    for (const a of pathVariants(canonical).map(canonicalTmpAlias)) {
      for (const b of pathVariants(protectedPath).map(canonicalTmpAlias)) {
        if (sameOrContains(a, b) || sameOrContains(b, a)) {
          throw new Error(`--work-dir ${workDir} must not overlap ${protectedPath} (the rehearsal rm -rf's the work dir at startup)`);
        }
      }
    }
  }
}

// The signing key is only ever named by path (--private-key, then
// MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE). The repository's
// MOSA_RELEASE_MANIFEST_PRIVATE_KEY holds the key itself; using it here would
// put the key on a command line and in the dry-run output, so it is refused.
export function resolvePrivateKeyPath(argValue, env = process.env) {
  if (argValue) return argValue;
  const file = String(env.MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE || "").trim();
  if (file) return file;
  if (String(env.MOSA_RELEASE_MANIFEST_PRIVATE_KEY || "").trim()) {
    throw new Error("MOSA_RELEASE_MANIFEST_PRIVATE_KEY holds the key itself; the rehearsal takes only a key file path: pass --private-key <pem> or set MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE");
  }
  return undefined;
}

// Turns the parsed options into the ordered step list. Throws (before any
// step runs) when an option is missing, malformed or unsafe.
export function buildRehearsalPlan(options) {
  const build = resolve(options.build ?? "");
  if (!options.build) throw new Error("--build is required (the build worktree created after tagging)");

  const mode = options.mode ?? "local";
  if (mode !== "local" && mode !== "live") throw new Error(`--mode must be "local" or "live", got ${JSON.stringify(mode)}`);

  const port = Number(options.port ?? REHEARSAL_PORT_DEFAULT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer between 1 and 65535, got ${JSON.stringify(options.port)}`);
  }
  if (port === USER_APP_PORT) {
    throw new Error(`--port ${USER_APP_PORT} is the port of the user's own running app; rehearsals must use an isolated port (the default is ${REHEARSAL_PORT_DEFAULT})`);
  }

  const fromApp = resolve(options.fromApp ?? "/Applications/GravityPort.app");
  const appName = basename(fromApp);

  let toVersion = options.toVersion;
  if (toVersion === undefined) {
    let parsed;
    try { parsed = JSON.parse(readFileSync(join(build, "package.json"), "utf8")); }
    catch (error) { throw new Error(`--to-version was not given and ${join(build, "package.json")} could not be read: ${error.message}`); }
    toVersion = parsed?.version;
    if (typeof toVersion !== "string") throw new Error(`--to-version was not given and ${join(build, "package.json")} has no version field`);
  }
  if (!VERSION_PATTERN.test(toVersion)) throw new Error(`--to-version must be x.y.z, got ${JSON.stringify(toVersion)}`);

  const privateKey = options.privateKey;
  if (mode === "local" && !privateKey) {
    throw new Error("local mode needs the path of the release manifest signing key: pass --private-key <pem> or set MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE");
  }

  const workDir = resolve(options.workDir ?? join(tmpdir(), mode === "live" ? "gp-rehearsal-live" : "gp-rehearsal-local"));
  assertSafeWorkDir(workDir, [fromApp, build, join(homedir(), "MOSA Library")]);

  const feedUrl = options.feedUrl ?? MOSA_UPDATE_FEED_URL;
  const rootDir = join(workDir, "root");
  const fromSrcDir = join(workDir, "from-src");
  const copiedApp = join(rootDir, "Applications", appName);
  const copiedInfoPlist = join(copiedApp, "Contents", "Info.plist");
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const fromVersionArg = options.fromVersion ?? RUNTIME_FROM_VERSION;

  const steps = [
    {
      id: "clean-work-dir", kind: "shell", description: "empty the rehearsal work dir",
      command: "/bin/rm", args: ["-rf", workDir],
    },
    {
      id: "make-work-dirs", kind: "shell", description: "create the rehearsal layout",
      command: "/bin/mkdir", args: ["-p", join(rootDir, "Applications"), join(rootDir, "server"), fromSrcDir],
    },
    {
      id: "copy-from-app", kind: "shell", description: `copy ${fromApp} into the rehearsal root`,
      command: "/usr/bin/ditto", args: [fromApp, copiedApp],
    },
    {
      id: "read-from-version", kind: "shell", description: "read the copied app's version",
      command: "/usr/libexec/PlistBuddy", args: ["-c", "Print CFBundleShortVersionString", copiedInfoPlist],
      capture: "fromVersion",
    },
    {
      id: "extract-asar", kind: "shell", description: "extract the copied app's asar",
      command: join(build, "node_modules", ".bin", "asar"),
      args: ["extract", join(copiedApp, "Contents", "Resources", "app.asar"), fromSrcDir],
    },
    {
      id: "copy-from-identity", kind: "shell", description: "copy the from-app's build identity",
      command: "/bin/cp",
      args: [join(fromSrcDir, "web", "gravityport", "dist", "build-identity.json"), join(rootDir, "from-identity.json")],
    },
    {
      id: "launch-isolated-app", kind: "shell", description: "launch the copied app isolated (own user data, library, port)",
      command: join(scriptsDir, "launch-isolated.sh"), args: [copiedApp],
      env: { REHEARSAL_ROOT: rootDir, REHEARSAL_PORT: String(port) },
    },
    {
      id: "wait-for-health", kind: "wait-health", description: "wait for the isolated app to answer /api/health",
      command: "/usr/bin/curl", args: ["-fsS", "-o", "/dev/null", `http://127.0.0.1:${port}/api/health`],
      attempts: 60, intervalMs: 1000,
    },
    {
      id: "rehearse-update", kind: "node",
      description: mode === "live" ? "run rehearse-update-live.mjs against the real feed" : "run rehearse-update.mjs against the locally signed feed",
      command: "node",
      args: [
        join(scriptsDir, mode === "live" ? "rehearse-update-live.mjs" : "rehearse-update.mjs"),
        "--from-src", fromSrcDir,
        ...(mode === "local" ? ["--writer-src", build] : []),
        "--root", rootDir,
        "--from-version", fromVersionArg,
        "--to-version", toVersion,
        ...(mode === "local" ? ["--zip", join(build, "out", "make", "update", "darwin", "arm64", `GravityPort-darwin-arm64-${toVersion}.zip`), "--identity", join(build, "web", "gravityport", "dist", "build-identity.json")] : []),
        "--app-name", appName,
        ...(mode === "live" ? ["--install-app", appName] : []),
        "--feed-url", feedUrl,
        ...(mode === "local" ? ["--private-key", privateKey] : []),
        "--port", String(port),
      ],
    },
    {
      id: "read-installed-version", kind: "shell", description: "read the installed app's version",
      command: "/usr/libexec/PlistBuddy", args: ["-c", "Print CFBundleShortVersionString", copiedInfoPlist],
    },
    {
      id: "verify-signature", kind: "shell", description: "gatekeeper-assess the installed app",
      command: "/usr/sbin/spctl", args: ["-a", "-vv", copiedApp],
    },
    {
      id: "stop-rehearsal-app", kind: "stop-rehearsal-app",
      description: "stop the rehearsal app (only processes listening on the port with this work dir in their command line)",
      port, workDir,
    },
  ];

  return {
    mode, build, fromApp, appName, toVersion,
    fromVersion: options.fromVersion ?? null,
    fromVersionSource: options.fromVersion === undefined ? "runtime" : "arg",
    workDir, rootDir, port, feedUrl,
    zipPath: join(build, "out", "make", "update", "darwin", "arm64", `GravityPort-darwin-arm64-${toVersion}.zip`),
    identityPath: join(build, "web", "gravityport", "dist", "build-identity.json"),
    asarBin: join(build, "node_modules", ".bin", "asar"),
    privateKeyPath: privateKey ?? null,
    steps,
  };
}

async function waitForHealth(step) {
  for (let attempt = 1; attempt <= step.attempts; attempt += 1) {
    const probe = spawnSync(step.command, step.args, { stdio: "ignore" });
    if (probe.status === 0) { log(`from app up after ${attempt}s`); return; }
    await sleep(step.intervalMs);
  }
  throw new Error(`the isolated from-app never answered ${step.args[step.args.length - 1]} within ${step.attempts} attempts`);
}

// Same rule as the old shells: only a process that listens on the rehearsal
// port AND carries the work dir in its command line gets SIGTERM.
function stopRehearsalApp(step) {
  const listed = spawnSync("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:" + step.port, "-sTCP:LISTEN"], { encoding: "utf8" });
  const pids = (listed.stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => /^\d+$/.test(line));
  for (const pid of pids) {
    if (Number(pid) <= 1) continue;
    const ps = spawnSync("/bin/ps", ["-o", "pid=,command=", "-p", pid], { encoding: "utf8" });
    if (!(ps.stdout ?? "").includes(step.workDir)) continue;
    process.kill(Number(pid), "SIGTERM");
    log("stopped rehearsal app", pid);
  }
}

// Unlike the old shells, a failing step after the launch still stops the
// rehearsal app (same port + work-dir rule), so no isolated copy is left
// running on the rehearsal port.
async function runPlan(plan) {
  const stopStep = plan.steps.find((step) => step.kind === "stop-rehearsal-app");
  let launched = false;
  try {
    await runSteps(plan, () => { launched = true; });
  } catch (error) {
    if (launched && stopStep) {
      log("step failed; stopping the rehearsal app before exiting");
      stopRehearsalApp(stopStep);
    }
    throw error;
  }
}

async function runSteps(plan, onLaunch) {
  const captured = {};
  for (const step of plan.steps) {
    log(step.id, "--", step.description);
    if (step.id === "launch-isolated-app") onLaunch();
    if (step.kind === "wait-health") { await waitForHealth(step); continue; }
    if (step.kind === "stop-rehearsal-app") { stopRehearsalApp(step); continue; }
    const args = step.args.map((value) => {
      if (value !== RUNTIME_FROM_VERSION) return value;
      if (captured.fromVersion === undefined) throw new Error(`step ${step.id} needs the from-version that the read-from-version step captures`);
      return captured.fromVersion;
    });
    const result = spawnSync(step.command, args, {
      stdio: step.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      env: step.env ? { ...process.env, ...step.env } : process.env,
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`step ${step.id} exited with code ${result.status}`);
    if (step.capture) {
      captured[step.capture] = (result.stdout ?? "").trim();
      log(step.capture, captured[step.capture]);
    }
  }
}

const displayValue = (value) => (value === RUNTIME_FROM_VERSION ? "运行时读取" : String(value));
const displayArg = (value) => {
  const text = displayValue(value);
  return /\s/.test(text) ? JSON.stringify(text) : text;
};

function printPlan(plan) {
  console.log("dry run: nothing is executed; this is the plan");
  console.log("mode:", plan.mode);
  console.log("build:", plan.build);
  console.log("from app:", `${plan.fromApp} (app name ${plan.appName})`);
  console.log("from version:", plan.fromVersion ? plan.fromVersion : "运行时读取 (read from the copied app's Info.plist)");
  console.log("to version:", plan.toVersion);
  console.log("work dir:", plan.workDir);
  console.log("port:", String(plan.port));
  if (plan.mode === "local") {
    console.log("zip:", plan.zipPath);
    console.log("identity:", plan.identityPath);
  }
  console.log("asar:", plan.asarBin);
  console.log("feed url:", plan.feedUrl);
  if (plan.mode === "local") console.log("private key:", plan.privateKeyPath);
  console.log("steps:");
  plan.steps.forEach((step, index) => {
    const command = step.command
      ? `${step.command} ${step.args.map(displayArg).join(" ")}`
      : `${step.description} (port ${step.port}; command line must contain the work dir)`;
    const suffix = step.env ? ` (env ${Object.entries(step.env).map(([key, value]) => `${key}=${displayValue(value)}`).join(" ")})` : "";
    console.log(`  ${index + 1}. ${step.id}: ${command}${suffix}`.trimEnd());
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      build: { type: "string" },
      mode: { type: "string" },
      "from-app": { type: "string" },
      "to-version": { type: "string" },
      "from-version": { type: "string" },
      "work-dir": { type: "string" },
      port: { type: "string" },
      "private-key": { type: "string" },
      "feed-url": { type: "string" },
      "dry-run": { type: "boolean" },
    },
  });
  let plan;
  try {
    plan = buildRehearsalPlan({
      build: values.build,
      mode: values.mode,
      fromApp: values["from-app"],
      toVersion: values["to-version"],
      fromVersion: values["from-version"],
      workDir: values["work-dir"],
      port: values.port,
      privateKey: values.mode === "live" ? undefined : resolvePrivateKeyPath(values["private-key"]),
      feedUrl: values["feed-url"],
    });
  } catch (error) {
    console.error(`rehearse: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (values["dry-run"]) { printPlan(plan); return; }
  await runPlan(plan);
}

// Only act as the CLI when executed directly; importing the module (tests)
// must not run main().
function isMainModule() {
  if (process.argv[1] === undefined) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainModule()) {
  main().catch((error) => {
    console.error("rehearse:", error?.message ?? error);
    process.exitCode = 1;
  });
}
