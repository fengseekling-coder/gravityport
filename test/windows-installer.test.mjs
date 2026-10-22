import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  findMakensis,
  makensisArguments,
  makeWindowsInstaller,
  windowsInstallerArtifactName,
  windowsInstallerArtifactPath,
  windowsInstallerFileVersion,
} from "../scripts/make-windows-installer.mjs";
import { signWindowsFile } from "../scripts/sign-windows-file.mjs";
import { windowsSignOptionsFromEnvironment } from "../scripts/windows-signing.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const THUMBPRINT = "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34";

function installedMakensis() {
  try {
    return findMakensis();
  } catch {
    return "";
  }
}

async function fakeProject({ version = "0.3.4", product = "GravityPort" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-installer-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  const appDir = join(root, "out", `${product}-win32-x64`);
  await mkdir(join(appDir, "resources"), { recursive: true });
  await writeFile(join(appDir, `${product}.exe`), "MZ fake app");
  await writeFile(join(appDir, "resources", "app.asar"), "fake asar");
  return { root, appDir };
}

test("Windows installer names follow the release package names", () => {
  assert.equal(windowsInstallerArtifactName("0.3.4"), "GravityPort-win32-x64-0.3.4.exe");
  assert.equal(windowsInstallerArtifactName("0.3.4-rc.1", "MOSA"), "MOSA-win32-x64-0.3.4-rc.1.exe");
  assert.throws(() => windowsInstallerArtifactName("latest"), /Invalid Windows installer version/);
  const root = resolve("repo-root");
  assert.equal(
    windowsInstallerArtifactPath({ rootDir: root, version: "0.3.4", product: "GravityPort" }),
    join(root, "out", "make", "installer", "win32", "x64", "GravityPort-win32-x64-0.3.4.exe"),
  );
});

test("Windows installer file versions are four numbers without the pre-release suffix", () => {
  assert.equal(windowsInstallerFileVersion("0.3.4"), "0.3.4.0");
  assert.equal(windowsInstallerFileVersion("0.3.4-rc.12"), "0.3.4.0");
  assert.equal(windowsInstallerFileVersion("10.0.07"), "10.0.7.0");
  assert.throws(() => windowsInstallerFileVersion("70000.0.0"), /65535/);
});

test("makensis is found through MOSA_MAKENSIS, PATH, or the default NSIS folder on Windows", () => {
  const present = (paths) => (candidate) => paths.includes(candidate);
  assert.equal(
    findMakensis({ env: { MOSA_MAKENSIS: "/opt/nsis/makensis" }, platform: "linux", fileExists: present(["/opt/nsis/makensis"]) }),
    "/opt/nsis/makensis",
  );
  assert.throws(
    () => findMakensis({ env: { MOSA_MAKENSIS: "/missing/makensis" }, platform: "linux", fileExists: present([]) }),
    /MOSA_MAKENSIS does not exist/,
  );
  assert.equal(
    findMakensis({ env: { PATH: "/usr/local/bin:/usr/bin" }, platform: "linux", fileExists: present(["/usr/bin/makensis"]) }),
    "/usr/bin/makensis",
  );
  assert.equal(
    findMakensis({
      env: { Path: "C:\\Windows\\System32", "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramFiles: "C:\\Program Files" },
      platform: "win32",
      fileExists: present(["C:\\Program Files (x86)\\NSIS\\makensis.exe"]),
    }),
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
  );
  assert.throws(
    () => findMakensis({ env: { PATH: "/usr/bin" }, platform: "linux", fileExists: present([]) }),
    /Install NSIS 3\.08 or later/,
  );
});

test("makensis arguments carry every installer define and refuse values that change the script", () => {
  const args = makensisArguments({
    script: "/repo/scripts/windows-installer.nsi",
    product: "GravityPort",
    version: "0.3.4-rc.1",
    appDir: "C:\\work dir\\out\\GravityPort-win32-x64",
    icon: "C:\\work dir\\out\\.desktop-icons\\mosa-app-icon.ico",
    output: "C:\\work dir\\out\\make\\installer\\win32\\x64\\GravityPort-win32-x64-0.3.4-rc.1.exe",
  });
  assert.deepEqual(args, [
    "-V2",
    "-WX",
    "-INPUTCHARSET", "UTF8",
    "-DPRODUCT=GravityPort",
    "-DVERSION=0.3.4-rc.1",
    "-DVI_VERSION=0.3.4.0",
    "-DAPP_DIR=C:\\work dir\\out\\GravityPort-win32-x64",
    "-DAPP_ICON=C:\\work dir\\out\\.desktop-icons\\mosa-app-icon.ico",
    "-DOUT_FILE=C:\\work dir\\out\\make\\installer\\win32\\x64\\GravityPort-win32-x64-0.3.4-rc.1.exe",
    "/repo/scripts/windows-installer.nsi",
  ]);
  const signed = makensisArguments({
    product: "GravityPort",
    version: "0.3.4",
    appDir: "/a",
    icon: "/i.ico",
    output: "/o.exe",
    sign: { node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\repo\\scripts\\sign-windows-file.mjs" },
  });
  assert.ok(signed.includes("-DSIGN_NODE=C:\\Program Files\\nodejs\\node.exe"));
  assert.ok(signed.includes("-DSIGN_SCRIPT=C:\\repo\\scripts\\sign-windows-file.mjs"));
  for (const appDir of ["C:\\a\"b", "C:\\$PLUGINSDIR", ""]) {
    assert.throws(
      () => makensisArguments({ product: "GravityPort", version: "0.3.4", appDir, icon: "/i.ico", output: "/o.exe" }),
      /Unusable value for the installer's APP_DIR/,
    );
  }
  assert.throws(
    () => makensisArguments({ product: "Other", version: "0.3.4", appDir: "/a", icon: "/i.ico", output: "/o.exe" }),
    /Unsupported release product/,
  );
});

test("the installer script keeps the app one folder below the install root the updater cleans", async () => {
  const script = await readFile(new URL("../scripts/windows-installer.nsi", import.meta.url), "utf8");
  // Per-user, fixed location, no administrator prompt.
  assert.match(script, /^RequestExecutionLevel user$/m);
  assert.match(script, /^InstallDir "\$LOCALAPPDATA\\Programs\\\$\{PRODUCT\}"$/m);
  assert.match(script, /StrCpy \$INSTDIR "\$LOCALAPPDATA\\Programs\\\$\{PRODUCT\}"/);
  // The in-app updater swaps the folder holding the exe and parks copies in
  // .MOSA-update-* beside it; the shortcuts point into app\, and the
  // uninstaller sits beside it.
  assert.match(script, /File \/r "\$\{APP_DIR\}\\\*"/);
  assert.match(script, /SetOutPath "\$INSTDIR\\app"/);
  assert.match(script, /CreateShortcut "\$SMPROGRAMS\\\$\{PRODUCT\}\.lnk" "\$INSTDIR\\app\\\$\{EXE_NAME\}"/);
  assert.match(script, /CreateShortcut "\$DESKTOP\\\$\{PRODUCT\}\.lnk" "\$INSTDIR\\app\\\$\{EXE_NAME\}"/);
  assert.match(script, /WriteUninstaller "\$INSTDIR\\\$\{UNINSTALLER_NAME\}"/);
  assert.match(script, /FindFirst \$0 \$1 "\$INSTDIR\\\.MOSA-update-\*"/);
  // A running copy blocks the folder rename, so neither installing nor
  // uninstalling deletes files from under it, and silent runs give up.
  assert.match(script, /MessageBox MB_RETRYCANCEL\|MB_ICONEXCLAMATION "\$\(AppRunning\)" \/SD IDCANCEL IDRETRY retry\n\s+Abort/);
  assert.match(script, /Function MoveInstalledAppAside[\s\S]*?!insertmacro MoveAppFolderTo "app\.old"[\s\S]*?FunctionEnd/);
  assert.match(script, /Section "Uninstall"[\s\S]*?!insertmacro MoveAppFolderTo "app\.removing"[\s\S]*?SectionEnd/);
  // A stale DisplayVersion would be wrong after the first in-app update.
  assert.doesNotMatch(script, /"DisplayVersion"/);
  // Both languages carry every message.
  for (const name of ["AppRunning", "NeedsWindows10", "KeepsLibrary"]) {
    assert.match(script, new RegExp(`^LangString ${name} \\$\\{LANG_ENGLISH\\} "`, "m"));
    assert.match(script, new RegExp(`^LangString ${name} \\$\\{LANG_SIMPCHINESE\\} "`, "m"));
  }
});

test("Windows installer build reports the file the release manifest and website use", async () => {
  const { root } = await fakeProject();
  try {
    const calls = [];
    const runner = async (command, args, options) => {
      calls.push({ command, args, options });
      const output = args.find((arg) => arg.startsWith("-DOUT_FILE=")).slice("-DOUT_FILE=".length);
      await writeFile(output, "MZ fake installer");
      return { output: "" };
    };
    const result = await makeWindowsInstaller({
      rootDir: root,
      env: { MOSA_RELEASE_DISTRIBUTION: "preview" },
      platform: "linux",
      product: "GravityPort",
      icon: join(root, "icon.ico"),
      makensis: "/usr/bin/makensis",
      runner,
    });
    assert.equal(result.artifactName, "GravityPort-win32-x64-0.3.4.exe");
    assert.equal(result.artifactPath, windowsInstallerArtifactPath({ rootDir: root, version: "0.3.4", product: "GravityPort" }));
    assert.equal(result.size, (await stat(result.artifactPath)).size);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.release_manifest_patch, {
      platforms: { windows: { installer: { file: result.artifactName, size: result.size, sha256: result.sha256 } } },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "/usr/bin/makensis");
    assert.ok(calls[0].args.includes(`-DAPP_DIR=${join(root, "out", "GravityPort-win32-x64")}`));
    assert.equal(calls[0].args.some((arg) => arg.startsWith("-DSIGN_")), false, "preview installers stay unsigned");

    const notExecutable = async (_command, args) => {
      await writeFile(args.find((arg) => arg.startsWith("-DOUT_FILE=")).slice("-DOUT_FILE=".length), "not a PE file");
    };
    await assert.rejects(
      makeWindowsInstaller({ rootDir: root, env: {}, platform: "linux", product: "GravityPort", icon: "/i.ico", makensis: "/m", runner: notExecutable }),
      /not a Windows executable/,
    );
    await assert.rejects(
      makeWindowsInstaller({ rootDir: root, env: {}, platform: "linux", product: "MOSA", icon: "/i.ico", makensis: "/m", runner }),
      /Packaged Windows app not found: .*MOSA-win32-x64/,
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("production installers are signed with the release configuration and verified on Windows", async () => {
  const { root } = await fakeProject();
  try {
    const productionEnv = {
      MOSA_RELEASE_DISTRIBUTION: "production",
      MOSA_WINDOWS_SIGNER_THUMBPRINT: THUMBPRINT,
      WINDOWS_SIGN_HOOK_MODULE_PATH: join(root, "hook.cjs"),
    };
    const runner = async (_command, args) => {
      await writeFile(args.find((arg) => arg.startsWith("-DOUT_FILE=")).slice("-DOUT_FILE=".length), "MZ signed installer");
      return { args };
    };
    const verified = [];
    let lastArgs = [];
    await makeWindowsInstaller({
      rootDir: root,
      env: productionEnv,
      platform: "win32",
      product: "GravityPort",
      icon: "/i.ico",
      makensis: "C:\\NSIS\\makensis.exe",
      runner: async (command, args, options) => {
        lastArgs = args;
        return runner(command, args, options);
      },
      verifySignature: async (input) => { verified.push(input); },
    });
    assert.ok(lastArgs.includes(`-DSIGN_NODE=${process.execPath}`));
    assert.ok(lastArgs.some((arg) => /^-DSIGN_SCRIPT=.*sign-windows-file\.mjs$/.test(arg)));
    assert.equal(verified.length, 1);
    assert.equal(verified[0].expectedThumbprint, THUMBPRINT);
    assert.match(verified[0].file, /GravityPort-win32-x64-0\.3\.4\.exe$/);

    // Missing signing configuration fails before anything is built.
    let built = false;
    await assert.rejects(
      makeWindowsInstaller({
        rootDir: root,
        env: { MOSA_RELEASE_DISTRIBUTION: "production" },
        platform: "win32",
        product: "GravityPort",
        icon: "/i.ico",
        makensis: "C:\\NSIS\\makensis.exe",
        runner: async () => { built = true; },
      }),
      /MOSA_WINDOWS_SIGNER_THUMBPRINT/,
    );
    assert.equal(built, false);
    await assert.rejects(
      makeWindowsInstaller({ rootDir: root, env: productionEnv, platform: "linux", product: "GravityPort", icon: "/i.ico", makensis: "/m", runner }),
      /must be built and verified on Windows/,
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("the signing helper uses the release options and refuses non-production builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-win-sign-"));
  try {
    const file = join(root, "uninstaller.tmp");
    await writeFile(file, "MZ");
    const calls = [];
    const env = {
      MOSA_RELEASE_DISTRIBUTION: "production",
      MOSA_WINDOWS_SIGNER_THUMBPRINT: THUMBPRINT,
      WINDOWS_CERTIFICATE_FILE: "C:\\secrets\\mosa.pfx",
      WINDOWS_CERTIFICATE_PASSWORD: "secret",
    };
    await signWindowsFile(file, { env, signImpl: async (options) => { calls.push(options); } });
    assert.deepEqual(calls, [{ ...windowsSignOptionsFromEnvironment(env), files: [file] }]);
    assert.equal(calls[0].certificateFile, "C:\\secrets\\mosa.pfx");
    await assert.rejects(
      signWindowsFile(file, { env: { MOSA_RELEASE_DISTRIBUTION: "preview" }, signImpl: async () => {} }),
      /production builds only/,
    );
    await assert.rejects(signWindowsFile(join(root, "missing.exe"), { env, signImpl: async () => {} }), /Nothing to sign/);
    assert.equal(windowsSignOptionsFromEnvironment({ MOSA_RELEASE_DISTRIBUTION: "preview" }), null);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

const makensisPath = installedMakensis();
const withMakensis = makensisPath ? test : test.skip;

withMakensis("makensis builds a real installer, and production signs the uninstaller and then the installer", async () => {
  const { root } = await fakeProject({ version: "0.3.4-rc.2" });
  try {
    const preview = await makeWindowsInstaller({
      rootDir: root,
      env: { ...process.env, MOSA_RELEASE_DISTRIBUTION: "preview" },
      product: "GravityPort",
      makensis: makensisPath,
    });
    const bytes = await readFile(preview.artifactPath);
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "MZ");
    assert.ok(bytes.includes(Buffer.from("GravityPort Setup", "utf16le")), "version info names the installer");
    assert.ok(bytes.includes(Buffer.from("0.3.4-rc.2", "utf16le")), "version info carries the full version");

    const signLog = join(root, "signed.log");
    const hook = join(root, "hook.cjs");
    await writeFile(hook, `const fs = require("node:fs");\nmodule.exports = async (file) => { fs.appendFileSync(${JSON.stringify(signLog)}, file + "\\n"); };\n`);
    const verified = [];
    const production = await makeWindowsInstaller({
      rootDir: root,
      env: {
        ...process.env,
        MOSA_RELEASE_DISTRIBUTION: "production",
        MOSA_WINDOWS_SIGNER_THUMBPRINT: THUMBPRINT,
        WINDOWS_SIGN_HOOK_MODULE_PATH: hook,
      },
      // makensis runs here; the Authenticode check itself needs Windows.
      platform: "win32",
      product: "GravityPort",
      makensis: makensisPath,
      verifySignature: async (input) => { verified.push(input.file); },
    });
    const signed = existsSync(signLog) ? (await readFile(signLog, "utf8")).trim().split("\n") : [];
    assert.equal(signed.length, 2, `expected the uninstaller and the installer to be signed, got ${JSON.stringify(signed)}`);
    assert.notEqual(signed[0], production.artifactPath, "the uninstaller is signed before it is packed");
    assert.equal(signed[1], production.artifactPath);
    assert.deepEqual(verified, [production.artifactPath]);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
