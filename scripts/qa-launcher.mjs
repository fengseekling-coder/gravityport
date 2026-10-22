#!/usr/bin/env node
import "../lib/apply-env-aliases.mjs";
/**
 * Unified MOSA QA launcher.
 *
 * Usage:
 *   node scripts/qa-launcher.mjs --type web       [--keep] [--no-build] [--cdp-port <port>]
 *   node scripts/qa-launcher.mjs --type electron  [--keep] [--no-build] [--cdp-port <port>]
 *   node scripts/qa-launcher.mjs --type packaged  [--keep] [--no-build] [--cdp-port <port>]
 *   node scripts/qa-launcher.mjs --stop <pidfile>
 *
 * Creates a temporary, isolated root directory and starts a MOSA QA instance
 * with all isolation parameters explicitly set.  The `--keep` flag prevents
 * automatic cleanup on exit so the evidence can be inspected.
 *
 * Always uses MOSA_RUNTIME_MODE=qa so the runtime isolation guard is active.
 * Electron instances receive --user-data-dir=<temp userData> so the actual
 * userData (app.getPath("userData")) matches the expected value.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { launchDesktopGui } from "./desktop-gui-launcher.mjs";
import { ensureElectronExecutablePath, packagedExecutablePath } from "./desktop-runtime-paths.mjs";
import { signalProcessTree } from "./process-tree.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const REPO_ROOT = resolve(__dirname, "..");
const PORT_FILE = "qa-port.txt";
const CDP_PORT_FILE = "qa-cdp-port.txt";
const PID_FILE = "qa-pid.txt";
const GUI_LOG_FILE = "gui-main.log";
const GUI_HEALTH_FILE = "gui-health.json";
const QA_DISABLED_BRIDGES = "cowart,cowartDiscovery,codex,grok";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { type: null, keep: false, noBuild: false, stop: null, cdpPort: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--type") opts.type = args[++i];
    else if (args[i] === "--keep") opts.keep = true;
    else if (args[i] === "--no-build") opts.noBuild = true;
    else if (args[i] === "--stop") opts.stop = args[++i];
    else if (args[i] === "--cdp-port") opts.cdpPort = parseInt(args[++i], 10);
  }
  return opts;
}

function printUsage() {
  console.error("Usage: node scripts/qa-launcher.mjs --type web|electron|packaged [--keep] [--no-build] [--cdp-port <port>]");
  console.error("       node scripts/qa-launcher.mjs --stop <pidfile>");
  process.exit(1);
}

async function findFreePort() {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolvePort(port));
    });
  });
}

async function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, host, () => {
      server.close(() => resolvePort(true));
    });
  });
}

async function setupIsolatedRoot() {
  const root = await mkdtemp(join(tmpdir(), "mosa-qa-"));
  const libraryDir = join(root, "library");
  const userData = join(root, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  return { root, libraryDir, userData };
}

async function waitForHealth(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        return body;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms`);
}

async function waitForHealthFile(filePath, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      // The GUI-side health probe has not completed yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`GUI health check timed out after ${timeoutMs}ms`);
}

async function writePidFile(dir, pid) {
  await writeFile(join(dir, PID_FILE), String(pid), "utf-8");
}

async function writePortFile(dir, port) {
  await writeFile(join(dir, PORT_FILE), String(port), "utf-8");
}

async function writeCdpPortFile(dir, port) {
  if (port) await writeFile(join(dir, CDP_PORT_FILE), String(port), "utf-8");
}

async function waitForPid(pidFilePath, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pid = parseInt(await readFile(pidFilePath, "utf8"), 10);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {
      // LaunchServices has not started the temporary app yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`GUI process PID was not written within ${timeoutMs}ms`);
}

async function launchGuiProcess(rootDir, executable, args, env, healthUrl) {
  const pidFile = join(rootDir, PID_FILE);
  const logFile = join(rootDir, GUI_LOG_FILE);
  const healthFile = join(rootDir, GUI_HEALTH_FILE);
  const launched = await launchDesktopGui({
    platform: process.platform,
    rootDir,
    executable,
    args,
    env,
    cwd: REPO_ROOT,
    pidFile,
    logFile,
    healthUrl,
    healthFile,
  });
  const waiter = launched.waiter;
  waiter.on("error", (error) => {
    console.error(`Failed to launch MOSA desktop QA: ${error.message}`);
  });
  const pid = launched.pid || await waitForPid(pidFile);
  return { waiter, pid, logFile, healthFile };
}

async function stopByPidFile(pidFilePath) {
  try {
    const pid = parseInt(await readFile(pidFilePath, "utf-8"), 10);
    console.log(`Stopping PID ${pid}...`);
    try {
      const signaled = await signalProcessTree(pid);
      if (!signaled) {
        console.log("Process already exited.");
        try { await rm(pidFilePath); } catch {}
        return;
      }
    } catch (e) {
      if (e.code === "ESRCH") {
        console.log("Process already exited.");
        try { await rm(pidFilePath); } catch {}
        return;
      }
      console.error(`Failed to signal PID ${pid}: ${e.message}`);
      process.exit(1);
    }
    // Wait for the process to exit by polling
    const start = Date.now();
    while (Date.now() - start < 10_000) {
      try {
        process.kill(pid, 0); // Test if process exists
        await new Promise((r) => setTimeout(r, 200));
      } catch {
        // Process exited
        console.log(`PID ${pid} exited.`);
        break;
      }
    }
    // Check if still running
    try {
      process.kill(pid, 0);
      console.error(`PID ${pid} did not exit within 10s, sending SIGKILL`);
      await signalProcessTree(pid, { force: true }).catch(() => {});
    } catch {
      // Exited
    }
    // Read port file and verify port is free
    const portFilePath = join(dirname(pidFilePath), PORT_FILE);
    try {
      const portStr = await readFile(portFilePath, "utf-8");
      const port = parseInt(portStr.trim(), 10);
      await new Promise((r) => setTimeout(r, 500));
      const free = await isPortFree(port);
      console.log(`Port ${port}: ${free ? "FREE (released)" : "STILL IN USE"}`);
    } catch {}
    try { await rm(pidFilePath); } catch {}
  } catch (e) {
    console.error(`Cannot read pid file: ${pidFilePath} (${e.message})`);
    process.exit(1);
  }
}

async function build() {
  console.log("Building before launch...");
  const build = spawn("npm", ["run", "build"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
    env: { ...process.env, MOSA_RUNTIME_MODE: undefined },
  });
  await new Promise((resolveBuild, reject) => {
    build.on("exit", (code) => {
      if (code === 0) resolveBuild();
      else reject(new Error(`npm run build exited with ${code}`));
    });
  });
}

async function launchWeb(rootDir, libraryDir, userData, servicePort, cdpPort, noBuild) {
  if (!noBuild) await build();

  const env = {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_PORT: String(servicePort),
    MOSA_USER_DATA: userData,
    MOSA_QA_RUN: "1",
    MOSA_DISABLE_BRIDGES: QA_DISABLED_BRIDGES,
  };

  console.log(`Launching Web QA (servicePort ${servicePort}, libraryDir ${libraryDir})`);
  const child = spawn("node", ["server.mjs"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env,
  });

  await writePidFile(rootDir, child.pid);
  await writePortFile(rootDir, servicePort);
  if (cdpPort) await writeCdpPortFile(rootDir, cdpPort);

  const health = await waitForHealth(`http://127.0.0.1:${servicePort}/api/health`);
  console.log(`Health: product=${health.product}, libraryDir=${health.libraryDir}`);

  return { child, health, rootDir, servicePort, cdpPort };
}

async function launchElectron(rootDir, libraryDir, userData, servicePort, cdpPort, noBuild) {
  if (!noBuild) await build();

  const env = {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_DESKTOP_PORT: String(servicePort),
    MOSA_USER_DATA: userData,
    MOSA_QA_RUN: "1",
    MOSA_DISABLE_BRIDGES: QA_DISABLED_BRIDGES,
  };

  const electronArgs = ["desktop/main.mjs"];
  // Pass --user-data-dir so app.getPath("userData") returns the isolated dir
  electronArgs.push("--user-data-dir=" + userData);
  if (cdpPort) {
    electronArgs.push("--remote-debugging-port=" + cdpPort);
  }

  console.log(`Launching Electron QA (servicePort ${servicePort}, libraryDir ${libraryDir}, userData ${userData})`);
  const executable = ensureElectronExecutablePath({ rootDir: REPO_ROOT });
  if (!existsSync(executable)) {
    throw new Error(`Electron binary was not installed correctly at ${executable}.`);
  }
  const healthUrl = `http://127.0.0.1:${servicePort}/api/health`;
  const gui = await launchGuiProcess(rootDir, executable, electronArgs, env, healthUrl);
  await writePortFile(rootDir, servicePort);
  if (cdpPort) await writeCdpPortFile(rootDir, cdpPort);

  const health = await waitForHealthFile(gui.healthFile);
  console.log(`Health: product=${health.product}, libraryDir=${health.libraryDir}`);

  return { child: gui.waiter, pid: gui.pid, health, rootDir, servicePort, cdpPort, logFile: gui.logFile };
}

async function launchPackaged(rootDir, libraryDir, userData, servicePort, cdpPort, noBuild) {
  if (!noBuild) await build();

  const packagedBinary = packagedExecutablePath({ rootDir: REPO_ROOT });
  if (!existsSync(packagedBinary)) {
    throw new Error(`Packaged binary not found at ${packagedBinary}. Run \`npm run desktop:package\` first.`);
  }

  const env = {
    ...process.env,
    MOSA_RUNTIME_MODE: "qa",
    MOSA_LIBRARY_DIR: libraryDir,
    MOSA_DESKTOP_PORT: String(servicePort),
    MOSA_USER_DATA: userData,
    MOSA_QA_RUN: "1",
    MOSA_DISABLE_BRIDGES: QA_DISABLED_BRIDGES,
  };

  const appArgs = [];
  appArgs.push("--user-data-dir=" + userData);
  if (cdpPort) {
    appArgs.push("--remote-debugging-port=" + cdpPort);
  }

  console.log(`Launching Packaged Electron QA (servicePort ${servicePort}, libraryDir ${libraryDir}, userData ${userData})`);
  const healthUrl = `http://127.0.0.1:${servicePort}/api/health`;
  const gui = await launchGuiProcess(rootDir, packagedBinary, appArgs, env, healthUrl);
  await writePortFile(rootDir, servicePort);
  if (cdpPort) await writeCdpPortFile(rootDir, cdpPort);

  const health = await waitForHealthFile(gui.healthFile);
  console.log(`Health: product=${health.product}, libraryDir=${health.libraryDir}`);

  return { child: gui.waiter, pid: gui.pid, health, rootDir, servicePort, cdpPort, logFile: gui.logFile };
}

async function main() {
  const opts = parseArgs();

  if (opts.stop) {
    await stopByPidFile(opts.stop);
    return;
  }

  if (!opts.type || !["web", "electron", "packaged"].includes(opts.type)) {
    printUsage();
  }

  const { root, libraryDir, userData } = await setupIsolatedRoot();
  const servicePort = await findFreePort();
  const cdpPort = opts.cdpPort || (opts.type !== "web" ? await findFreePort() : null);

  console.log("=== MOSA QA Launcher ===");
  console.log(`  root:        ${root}`);
  console.log(`  libraryDir:  ${libraryDir}`);
  console.log(`  userData:    ${userData}`);
  console.log(`  servicePort: ${servicePort}`);
  console.log(`  cdpPort:     ${cdpPort || "N/A"}`);
  console.log(`  type:        ${opts.type}`);
  console.log("");

  let result;
  if (opts.type === "web") {
    result = await launchWeb(root, libraryDir, userData, servicePort, cdpPort, opts.noBuild);
  } else if (opts.type === "electron") {
    result = await launchElectron(root, libraryDir, userData, servicePort, cdpPort, opts.noBuild);
  } else if (opts.type === "packaged") {
    result = await launchPackaged(root, libraryDir, userData, servicePort, cdpPort, opts.noBuild);
  }

  console.log("");
  console.log("=== QA Launcher Summary ===");
  console.log(`  PID:         ${result?.pid || result?.child?.pid || "N/A"}`);
  console.log(`  root:        ${result?.rootDir}`);
  console.log(`  servicePort: ${result?.servicePort}`);
  console.log(`  cdpPort:     ${result?.cdpPort || "N/A"}`);
  console.log(`  libraryDir:  ${libraryDir}`);
  console.log(`  userData:    ${userData}`);
  if (result?.logFile) console.log(`  GUI log:     ${result.logFile}`);
  console.log(`  PID file:    ${join(result.rootDir, PID_FILE)}`);
  console.log(`  To stop:     node scripts/qa-launcher.mjs --stop ${join(result.rootDir, PID_FILE)}`);

  // If --keep is not set, wait for the child to exit, then clean up
  if (result?.child && !opts.keep) {
    console.log("Waiting for QA process to exit...");
    await new Promise((resolveExit) => {
      result.child.on("exit", () => resolveExit());
    });
    // Clean up temp directory
    try { await rm(root, { recursive: true, force: true }); } catch {}
    console.log("Cleaned up " + root);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
