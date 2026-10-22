// Installs the real Windows installer the way a user would, then upgrades and
// uninstalls it. Opt-in (MOSA_WINDOWS_INSTALLER_REHEARSAL=1) and Windows only:
// it uses the per-user install location, Start menu, desktop and registry of
// the account running it, so it refuses to start when GravityPort is already
// installed there. CI runs it after `npm run desktop:installer:windows`.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

  let probe = null;
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
    const entry = JSON.parse(await powershell(`Get-ItemProperty -LiteralPath ${psLiteral(uninstallKey)} | ConvertTo-Json -Compress`));
    assert.equal(entry.DisplayName, product);
    assert.equal(entry.InstallLocation.toLowerCase(), installRoot.toLowerCase());
    assert.equal(entry.UninstallString.toLowerCase(), `"${uninstaller}"`.toLowerCase());
    assert.equal(entry.DisplayVersion, undefined, "no version that in-app updates would leave stale");

    // A program running from the app folder blocks both installing over it
    // and uninstalling it; silent runs give up and leave it untouched.
    const probeExe = join(appDir, "lock-probe.exe");
    await copyFile(join(process.env.SystemRoot, "System32", "PING.EXE"), probeExe);
    probe = spawn(probeExe, ["-n", "120", "127.0.0.1"], { stdio: "ignore", windowsHide: true });
    await new Promise((resolveSpawn, rejectSpawn) => {
      probe.once("spawn", resolveSpawn);
      probe.once("error", rejectSpawn);
    });
    assert.equal(await run(installer, ["/S"]), 2, "install over a running copy is aborted");
    assert.ok(existsSync(exe) && existsSync(probeExe), "the running copy is left as it was");
    assert.equal(existsSync(join(installRoot, "app.old")), false);
    assert.equal(await run(uninstaller, ["/S", `_?=${installRoot}`]), 2, "uninstalling a running copy is aborted");
    assert.ok(existsSync(exe) && existsSync(probeExe), "the running copy survives the refused uninstall");
    probe.kill();
    await new Promise((resolveExit) => (probe.exitCode !== null ? resolveExit() : probe.once("exit", resolveExit)));
    probe = null;

    // Installing again replaces the whole app folder, like a version change.
    assert.equal(await run(installer, ["/S"]), 0, "upgrade exit code");
    assert.equal(existsSync(probeExe), false, "files from the previous copy are gone");
    assert.equal(existsSync(join(installRoot, "app.old")), false, "the previous copy is removed");
    assert.ok(existsSync(exe));

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
    if (probe) probe.kill();
    if (existsSync(installRoot)) await rm(installRoot, { recursive: true, force: true }).catch(() => {});
    await rm(startMenuShortcut, { force: true }).catch(() => {});
    await rm(desktopShortcut, { force: true }).catch(() => {});
    await powershell(`Remove-Item -LiteralPath ${psLiteral(uninstallKey)} -Recurse -ErrorAction SilentlyContinue`).catch(() => {});
  }
});

scope("the installed app folder is what the in-app updater replaces", async () => {
  const { windowsUpdateTransactionParentDir } = await import("../desktop/windows-updater.mjs");
  const exe = join(process.env.LOCALAPPDATA, "Programs", product, "app", names.windowsExecutableName);
  assert.equal(windowsUpdateTransactionParentDir(exe), join(process.env.LOCALAPPDATA, "Programs", product));
  assert.ok((await stat(join(rootDir, "scripts", "windows-installer.nsi"))).isFile());
});
