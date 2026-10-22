#!/usr/bin/env node

// Builds the Windows installer: one .exe that installs the packaged app for
// the current user, adds Start menu and desktop shortcuts, and starts it
// (scripts/windows-installer.nsi). The website offers it for first installs;
// in-app updates keep downloading the update ZIP, and both put the app in
// the same place.
//
// Needs NSIS 3.08 or later: makensis on PATH, in the default NSIS folder on
// Windows, or named by MOSA_MAKENSIS.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { access, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { desktopIconOutputDir, generateDesktopIcons } from "../desktop/icon-assets.mjs";
import { desktopDistributionFromEnvironment, requiresPlatformSigning } from "../lib/release-distribution.mjs";
import { releaseProductNames, resolveReleaseProduct } from "./release-product.mjs";
import { verifyWindowsReleaseFile } from "./verify-windows-release.mjs";
import { windowsSignOptionsFromEnvironment } from "./windows-signing.mjs";

export const MOSA_WINDOWS_INSTALLER_ARCH = "x64";
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const INSTALLER_SCRIPT = join(PROJECT_ROOT, "scripts", "windows-installer.nsi");
const SIGN_SCRIPT = join(PROJECT_ROOT, "scripts", "sign-windows-file.mjs");

function cleanVersion(version) {
  const value = String(version || "").trim();
  if (!VERSION_PATTERN.test(value)) throw new Error("Invalid Windows installer version.");
  return value;
}

export function windowsInstallerArtifactName(version, product = resolveReleaseProduct()) {
  return releaseProductNames(product).windowsInstallerName(cleanVersion(version), MOSA_WINDOWS_INSTALLER_ARCH);
}

export function windowsInstallerArtifactPath({ rootDir, outDir = "out", version, product = resolveReleaseProduct() } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  return resolve(rootDir, outDir, "make", "installer", "win32", MOSA_WINDOWS_INSTALLER_ARCH, windowsInstallerArtifactName(version, product));
}

// Windows file versions are four numbers; a pre-release suffix is dropped
// (0.3.4-rc.1 -> 0.3.4.0). The full version stays in the version strings.
export function windowsInstallerFileVersion(version) {
  const [, major, minor, patch] = VERSION_PATTERN.exec(cleanVersion(version));
  for (const part of [major, minor, patch]) {
    if (Number(part) > 65535) throw new Error("Windows file versions allow at most 65535 per number.");
  }
  return `${Number(major)}.${Number(minor)}.${Number(patch)}.0`;
}

export function findMakensis({ env = process.env, platform = process.platform, fileExists = existsSync } = {}) {
  const configured = String(env.MOSA_MAKENSIS || "").trim();
  if (configured) {
    if (!fileExists(configured)) throw new Error(`MOSA_MAKENSIS does not exist: ${configured}`);
    return configured;
  }
  const paths = platform === "win32" ? win32 : posix;
  const executable = platform === "win32" ? "makensis.exe" : "makensis";
  const searchPath = String(env.PATH ?? env.Path ?? "");
  const candidates = searchPath
    .split(platform === "win32" ? ";" : ":")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .map((dir) => paths.join(dir, executable));
  if (platform === "win32") {
    for (const programFiles of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
      if (programFiles) candidates.push(paths.join(programFiles, "NSIS", "makensis.exe"));
    }
  }
  const found = candidates.find((candidate) => fileExists(candidate));
  if (!found) {
    throw new Error("makensis was not found. Install NSIS 3.08 or later (https://nsis.sourceforge.io/), or set MOSA_MAKENSIS to the makensis executable.");
  }
  return found;
}

// makensis takes each define as one argument, so values may contain spaces.
// A quote or a $ would change what the script means, so neither is allowed.
function defineArgument(name, value) {
  const text = String(value ?? "");
  if (!text || /["$\r\n]/.test(text)) throw new Error(`Unusable value for the installer's ${name}: ${JSON.stringify(text)}`);
  return `-D${name}=${text}`;
}

export function makensisArguments({
  script = INSTALLER_SCRIPT,
  product,
  version,
  appDir,
  icon,
  output,
  sign = null,
} = {}) {
  return [
    "-V2",
    "-WX",
    "-INPUTCHARSET", "UTF8",
    defineArgument("PRODUCT", releaseProductNames(product).product),
    defineArgument("VERSION", cleanVersion(version)),
    defineArgument("VI_VERSION", windowsInstallerFileVersion(version)),
    defineArgument("APP_DIR", appDir),
    defineArgument("APP_ICON", icon),
    defineArgument("OUT_FILE", output),
    ...(sign ? [defineArgument("SIGN_NODE", sign.node), defineArgument("SIGN_SCRIPT", sign.script)] : []),
    script,
  ];
}

export async function makeWindowsInstaller({
  rootDir = PROJECT_ROOT,
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  env = process.env,
  platform = process.platform,
  product = resolveReleaseProduct(env),
  icon = "",
  makensis = "",
  runner = runCommand,
  verifySignature = verifyWindowsReleaseFile,
} = {}) {
  const names = releaseProductNames(product);
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const version = cleanVersion(packageJson.version);
  const artifactName = windowsInstallerArtifactName(version, product);
  const appDir = resolve(rootDir, outDir, names.windowsPackageDirName);
  await access(join(appDir, names.windowsExecutableName)).catch(() => {
    throw new Error(`Packaged Windows app not found: ${appDir}. Run desktop:package:windows first.`);
  });

  // Production installers carry the release signature, like the app inside.
  const production = requiresPlatformSigning(desktopDistributionFromEnvironment(env));
  if (production) windowsSignOptionsFromEnvironment(env);
  const sign = production ? { node: process.execPath, script: SIGN_SCRIPT } : null;

  const iconPath = icon || (await generateDesktopIcons({ outputDir: desktopIconOutputDir({ outDir, projectRoot: rootDir }) })).ico;
  const output = windowsInstallerArtifactPath({ rootDir, outDir, version, product });
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await runner(makensis || findMakensis({ env, platform }), makensisArguments({
    product,
    version,
    appDir,
    icon: iconPath,
    output,
    sign,
  }), { env });

  await assertWindowsExecutable(output);
  if (production) {
    if (platform !== "win32") throw new Error("Production Windows installers must be built and verified on Windows.");
    await verifySignature({ file: output, expectedThumbprint: env.MOSA_WINDOWS_SIGNER_THUMBPRINT });
  }
  const metadata = await fileMetadata(output);
  return {
    artifactPath: output,
    artifactName,
    version,
    platform: "Windows",
    arch: MOSA_WINDOWS_INSTALLER_ARCH,
    size: metadata.size,
    sha256: metadata.sha256,
    // The release manifest writer adds this with --windows-installer; the
    // website links it for first installs.
    release_manifest_patch: {
      platforms: {
        windows: {
          installer: {
            file: artifactName,
            size: metadata.size,
            sha256: metadata.sha256,
          },
        },
      },
    },
  };
}

async function assertWindowsExecutable(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size <= 0) throw new Error(`makensis did not write the installer: ${path}`);
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(2);
    await handle.read(header, 0, 2, 0);
    if (header.toString("latin1") !== "MZ") throw new Error(`The installer is not a Windows executable: ${path}`);
  } finally {
    await handle.close();
  }
}

async function fileMetadata(path) {
  const info = await stat(path);
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return { size: info.size, sha256: hash.digest("hex") };
}

export function runCommand(command, args, { cwd = process.cwd(), env = process.env } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) return resolveRun({ output });
      const tail = output.trim().split(/\r?\n/).slice(-20).join("\n");
      rejectRun(new Error(`${command} failed (${signal || `exit ${code ?? "?"}`}):\n${tail}`));
    });
  });
}

async function main() {
  const result = await makeWindowsInstaller();
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] Windows installer failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
