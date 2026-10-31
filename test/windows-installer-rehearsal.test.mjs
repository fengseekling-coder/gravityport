// Installs the real Windows installer the way a user would, then upgrades and
// uninstalls it. Opt-in (MOSA_WINDOWS_INSTALLER_REHEARSAL=1) and Windows only:
// it uses the per-user install location, Start menu, desktop and registry of
// the account running it, so it refuses to start when GravityPort is already
// installed there. CI runs it after `npm run desktop:installer:windows`.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildMcpClientConfig } from "../lib/mcp-client-config.mjs";
import { windowsInstallerArtifactPath } from "../scripts/make-windows-installer.mjs";
import { releaseProductNames, resolveReleaseProduct } from "../scripts/release-product.mjs";

const execFileAsync = promisify(execFile);
const MAY_RUN_HERE = process.platform === "win32" && process.env.MOSA_WINDOWS_INSTALLER_REHEARSAL === "1";
const scope = MAY_RUN_HERE ? test : test.skip;

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const outDir = process.env.MOSA_FORGE_OUT_DIR || "out";
const product = resolveReleaseProduct();
const names = releaseProductNames(product);

async function powershell(command) {
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command,
  ], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Runs an installer or uninstaller and returns its exit code.
function run(file, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, { stdio: "ignore", windowsHide: true });
    child.once("error", rejectRun);
    child.once("exit", (code) => resolveRun(code));
  });
}

async function treeDigest(dir) {
  const entries = new Map();
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        const hash = createHash("sha256").update(await readFile(path)).digest("hex");
        entries.set(relative(dir, path).replaceAll("\\", "/"), hash);
      }
    }
  }
  await walk(dir);
  return entries;
}

async function waitUntil(check, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(message);
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

// The last few thousand characters a child printed, for failure messages.
function recentOutput(...streams) {
  let text = "";
  for (const stream of streams) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => { text = (text + chunk).slice(-4000); });
  }
  return () => text;
}

// Ends every program started from dir (the app, its helper processes, an MCP
// server) and waits until none is left.
// Diagnostics for a refused upgrade: every process that has a module loaded
// from `dir` or mentions it on its command line, wherever its executable is.
// Only called after a failure, so its cost never slows a passing run.
async function describeProcessesHolding(dir) {
  const prefix = psLiteral(`${dir}\\`);
  try {
    return await powershell(
      "$byModule = Get-Process | Where-Object { try { @($_.Modules | Where-Object { $_.FileName -and "
      + `$_.FileName.StartsWith(${prefix}, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0 } catch { $false } } `
      + "| ForEach-Object { 'module: ' + $_.ProcessName + ' pid=' + $_.Id + ' path=' + $_.Path }; "
      + "$byCommand = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and "
      + `$_.CommandLine.IndexOf(${psLiteral(dir)}, [StringComparison]::OrdinalIgnoreCase) -ge 0 } `
      + "| ForEach-Object { 'command line: ' + $_.Name + ' pid=' + $_.ProcessId + ' exe=' + $_.ExecutablePath }; "
      + "(@($byModule) + @($byCommand)) -join [Environment]::NewLine",
    ) || "(no process found; likely antivirus or the search indexer)";
  } catch (error) {
    return `(could not list processes: ${error?.message || error})`;
  }
}

// The installer gives a held app folder about two seconds before a silent run
// gives up. On CI runners, antivirus can keep scanning the freshly installed
// files for longer than that after our own processes are gone. Waits until the
// folder can actually be renamed (moved aside and straight back), so the
// upgrade step tests the installer rather than the scanner, and fails with the
// holders listed if something keeps it for the whole timeout.
async function waitUntilFolderCanMove(dir, timeoutMs = 30_000) {
  const probe = `${dir}.rehearsal-probe`;
  const started = Date.now();
  for (;;) {
    try {
      await rename(dir, probe);
    } catch {
      if (Date.now() - started >= timeoutMs) {
        assert.fail(`${dir} stayed held for ${timeoutMs} ms after every program from it stopped:\n${await describeProcessesHolding(dir)}`);
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      continue;
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(probe, dir);
        break;
      } catch (error) {
        if (attempt >= 20) throw new Error(`could not move ${probe} back to ${dir}: ${error?.message || error}`);
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      }
    }
    return Date.now() - started;
  }
}

async function stopEverythingRunningFrom(dir) {
  const fromDir = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
    + `$_.ExecutablePath.StartsWith(${psLiteral(`${dir}\\`)}, [StringComparison]::OrdinalIgnoreCase) }`;
  await waitUntil(async () => {
    const found = await powershell(
      `$found = @(${fromDir}); $found | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $found.Count`,
    );
    return found === "0";
  }, `programs started from ${dir} keep running`);
}

// Opens the installed app as scripts/packaged-smoke.mjs opens the packaged
// one: with its own library, settings folder and port, so nothing of the
// account's own GravityPort is touched. It starts outside the app folder, so
// only the files the app itself keeps open hold that folder.
async function openInstalledApp(exe, sandbox) {
  const port = await freePort();
  const libraryDir = join(sandbox, "library");
  const userData = join(sandbox, "user-data");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(userData, { recursive: true });
  const child = spawn(exe, ["--disable-gpu", `--user-data-dir=${userData}`], {
    cwd: sandbox,
    env: {
      ...process.env,
      MOSA_RUNTIME_MODE: "qa",
      MOSA_QA_RUN: "1",
      MOSA_LIBRARY_DIR: libraryDir,
      MOSA_USER_DATA: userData,
      MOSA_DESKTOP_PORT: String(port),
      MOSA_DISABLE_BRIDGES: "cowart,cowartDiscovery,codex,grok",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let failure = null;
  child.once("error", (error) => { failure = error; });
  const output = recentOutput(child.stdout, child.stderr);
  const answers = () => fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.ok, () => false);
  try {
    await waitUntil(async () => {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`it quit with exit code ${child.exitCode}`);
      return answers();
    }, "it did not answer within 90 seconds", 90_000);
  } catch (error) {
    throw new Error(`The installed app did not open: ${error.message}\n${output()}`, { cause: error });
  }
  return { libraryDir, answers };
}

// Starts the installed app's bundled MCP server with the command an AI
// assistant such as Claude runs (Settings shows it), and waits until it
// answers `initialize`.
async function startInstalledMcpServer({ exe, appDir, libraryDir, sandbox }) {
  const config = buildMcpClientConfig({
    platform: "win32",
    execPath: exe,
    serverPath: join(appDir, "resources", "app.asar", "mcp", "server.mjs"),
    managedLibraryDir: libraryDir,
  });
  const home = join(sandbox, "mcp-home");
  await mkdir(home, { recursive: true });
  const systemEnv = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP"]
    .filter((name) => process.env[name])
    .map((name) => [name, process.env[name]]));
  const child = spawn(config.command, config.args, {
    cwd: home,
    env: { ...systemEnv, HOME: home, USERPROFILE: home, ...config.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let failure = null;
  child.once("error", (error) => { failure = error; });
  const errors = recentOutput(child.stderr);
  let received = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { received += chunk; });
  const answered = () => received.split("\n").slice(0, -1).some((line) => {
    try {
      return JSON.parse(line).id === 1;
    } catch {
      return false;
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  try {
    await waitUntil(() => {
      if (failure) throw failure;
      if (child.exitCode !== null) throw new Error(`it quit with exit code ${child.exitCode}`);
      return answered();
    }, "it did not answer within 30 seconds", 30_000);
  } catch (error) {
    throw new Error(`The installed MCP server did not start: ${error.message}\n${errors()}`, { cause: error });
  }
  return child;
}

scope("the Windows installer installs, refuses to touch a running copy, upgrades, and uninstalls", async () => {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const installer = windowsInstallerArtifactPath({ rootDir, outDir, version: packageJson.version, product });
  const packageDir = join(rootDir, outDir, names.windowsPackageDirName);
  assert.ok(existsSync(installer), `Build the installer first (npm run desktop:installer:windows): ${installer}`);

  const installRoot = join(process.env.LOCALAPPDATA, "Programs", product);
  const appDir = join(installRoot, "app");
  const exe = join(appDir, names.windowsExecutableName);
  const uninstaller = join(installRoot, `Uninstall ${product}.exe`);
  const desktop = await powershell("[Environment]::GetFolderPath('Desktop')");
  const startMenuShortcut = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", `${product}.lnk`);
  const desktopShortcut = join(desktop, `${product}.lnk`);
  const uninstallKey = `HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${product}`;
  assert.equal(existsSync(installRoot), false, `${product} is already installed for this account; the rehearsal will not touch it.`);

  const sandbox = await mkdtemp(join(tmpdir(), "mosa-installer-rehearsal-"));
  try {
    // First install.
    assert.equal(await run(installer, ["/S"]), 0, "silent install exit code");
    const packaged = await treeDigest(packageDir);
    const installed = await treeDigest(appDir);
    assert.deepEqual([...installed.keys()].sort(), [...packaged.keys()].sort(), "installed files match the package");
    for (const [path, hash] of packaged) assert.equal(installed.get(path), hash, `installed ${path} matches the package`);
    assert.ok(existsSync(uninstaller), "uninstaller beside the app folder");
    for (const shortcut of [startMenuShortcut, desktopShortcut]) {
      const target = await powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut(${psLiteral(shortcut)}).TargetPath`);
      assert.equal(target.toLowerCase(), exe.toLowerCase(), `${shortcut} opens the installed app`);
    }
    // Only the key's own values: Get-ItemProperty adds PowerShell's PS*
    // properties, which ConvertTo-Json cannot serialize cleanly.
    const entry = JSON.parse(await powershell(
      `$key = Get-Item -LiteralPath ${psLiteral(uninstallKey)}; $values = [ordered]@{}; `
      + "foreach ($name in $key.GetValueNames()) { $values[$name] = $key.GetValue($name) }; $values | ConvertTo-Json -Compress",
    ));
    assert.equal(entry.DisplayName, product);
    assert.equal(entry.InstallLocation.toLowerCase(), installRoot.toLowerCase());
    assert.equal(entry.UninstallString.toLowerCase(), `"${uninstaller}"`.toLowerCase());
    assert.equal(entry.DisplayVersion, undefined, "no version that in-app updates would leave stale");

    // While the installed app is open, installing over it and uninstalling it
    // are both refused; silent runs give up and leave it running untouched.
    const app = await openInstalledApp(exe, sandbox);
    assert.equal(await run(installer, ["/S"]), 2, "installing over the open app is refused");
    assert.equal(await run(uninstaller, ["/S", `_?=${installRoot}`]), 2, "uninstalling the open app is refused");
    assert.ok(existsSync(exe), "the open app stays in place");
    assert.equal(existsSync(join(installRoot, "app.old")), false);
    assert.equal(existsSync(join(installRoot, "app.removing")), false);
    assert.ok(await app.answers(), "the open app keeps running");
    await stopEverythingRunningFrom(installRoot);

    // The same while only an AI assistant's MCP server runs from the app.
    const mcpServer = await startInstalledMcpServer({ exe, appDir, libraryDir: app.libraryDir, sandbox });
    assert.equal(await run(installer, ["/S"]), 2, "installing under a running MCP server is refused");
    assert.ok(existsSync(exe) && mcpServer.exitCode === null, "the MCP server keeps running");
    mcpServer.stdin.end();
    await stopEverythingRunningFrom(installRoot);

    // Installing again replaces the whole app folder, like a version change.
    const leftover = join(appDir, "from-an-older-version.txt");
    await writeFile(leftover, "older");
    const heldMs = await waitUntilFolderCanMove(appDir);
    console.log(`app folder free to move after ${heldMs} ms`);
    const upgradeExit = await run(installer, ["/S"]);
    if (upgradeExit !== 0) {
      assert.fail(`upgrade exit code ${upgradeExit} (2 = the app folder could not be renamed). Holding ${appDir}:\n${await describeProcessesHolding(appDir)}`);
    }
    assert.equal(existsSync(leftover), false, "files from the previous copy are gone");
    assert.equal(existsSync(join(installRoot, "app.old")), false, "the previous copy is removed");
    assert.deepEqual(await treeDigest(appDir), packaged, "the upgraded copy matches the package");

    // The in-app updater parks the previous version beside app\.
    await mkdir(join(installRoot, ".MOSA-update-rehearsal", "previous"), { recursive: true });
    await writeFile(join(installRoot, ".MOSA-update-rehearsal", "previous", names.windowsExecutableName), "previous");

    // The uninstaller copies itself to %TEMP% and returns at once.
    assert.equal(await run(uninstaller, ["/S"]), 0, "silent uninstall exit code");
    await waitUntil(async () => !existsSync(installRoot), "the install folder is removed");
    assert.equal(existsSync(startMenuShortcut), false, "Start menu shortcut removed");
    assert.equal(existsSync(desktopShortcut), false, "desktop shortcut removed");
    assert.equal(await powershell(`Test-Path -LiteralPath ${psLiteral(uninstallKey)}`), "False", "Settings > Apps entry removed");
  } finally {
    await stopEverythingRunningFrom(installRoot).catch(() => {});
    if (existsSync(installRoot)) await rm(installRoot, { recursive: true, force: true }).catch(() => {});
    await rm(startMenuShortcut, { force: true }).catch(() => {});
    await rm(desktopShortcut, { force: true }).catch(() => {});
    await powershell(`Remove-Item -LiteralPath ${psLiteral(uninstallKey)} -Recurse -ErrorAction SilentlyContinue`).catch(() => {});
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
});

scope("the installed app folder is what the in-app updater replaces", async () => {
  const { windowsUpdateTransactionParentDir } = await import("../desktop/windows-updater.mjs");
  const exe = join(process.env.LOCALAPPDATA, "Programs", product, "app", names.windowsExecutableName);
  assert.equal(windowsUpdateTransactionParentDir(exe), join(process.env.LOCALAPPDATA, "Programs", product));
  assert.ok((await stat(join(rootDir, "scripts", "windows-installer.nsi"))).isFile());
});
