#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { desktopDistributionFromEnvironment, normalizeDesktopDistribution } from "../lib/release-distribution.mjs";
import { releaseProductNames, resolveReleaseProduct } from "./release-product.mjs";

export const MOSA_WINDOWS_UPDATE_ARCH = "x64";

export function windowsUpdateArtifactName(version, arch = MOSA_WINDOWS_UPDATE_ARCH, product = resolveReleaseProduct()) {
  const cleanVersion = String(version || "").trim();
  const cleanArch = String(arch || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cleanVersion)) throw new Error("Invalid Windows update version.");
  if (cleanArch !== MOSA_WINDOWS_UPDATE_ARCH) throw new Error(`Unsupported Windows update architecture: ${cleanArch}.`);
  return releaseProductNames(product).windowsUpdateZipName(cleanVersion, cleanArch);
}

export function windowsUpdateArtifactPath({ rootDir, outDir = "out", version, arch = MOSA_WINDOWS_UPDATE_ARCH, product = resolveReleaseProduct() } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  return resolve(rootDir, outDir, "make", "zip", "win32", arch, windowsUpdateArtifactName(version, arch, product));
}

export function windowsUpdateZipCommand({ packageDir, output, platform = process.platform } = {}) {
  const source = resolve(String(packageDir || ""));
  const destination = resolve(String(output || ""));
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$source = [IO.Path]::GetFullPath($env:MOSA_WINDOWS_UPDATE_SOURCE)",
      "$destination = [IO.Path]::GetFullPath($env:MOSA_WINDOWS_UPDATE_DESTINATION)",
      "$rootName = [IO.Path]::GetFileName($source.TrimEnd([char]92, [char]47))",
      "$stream = [IO.File]::Open($destination, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)",
      "try {",
      "  $archive = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create, $false)",
      "  try {",
      "    Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object {",
      "      $relative = $_.FullName.Substring($source.Length)",
      "      while ($relative.StartsWith('\\') -or $relative.StartsWith('/')) { $relative = $relative.Substring(1) }",
      "      $entryName = $rootName + '/' + $relative.Replace([char]92, [char]47)",
      "      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null",
      "    }",
      "  } finally { $archive.Dispose() }",
      "} finally { $stream.Dispose() }",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      options: {
        env: {
          ...process.env,
          MOSA_WINDOWS_UPDATE_SOURCE: source,
          MOSA_WINDOWS_UPDATE_DESTINATION: destination,
        },
      },
    };
  }
  return {
    command: "zip",
    args: ["-r", "-y", destination, basename(source)],
    options: { cwd: dirname(source) },
  };
}

export async function makeWindowsUpdateZip({
  rootDir = resolve(fileURLToPath(new URL("..", import.meta.url))),
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  arch = MOSA_WINDOWS_UPDATE_ARCH,
  distribution = desktopDistributionFromEnvironment(process.env),
  platform = process.platform,
  env = process.env,
  product = resolveReleaseProduct(env),
  runner = runCommand,
} = {}) {
  const names = releaseProductNames(product);
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const version = String(packageJson.version || "").trim();
  const artifactName = windowsUpdateArtifactName(version, arch, product);
  const packageDir = resolve(rootDir, outDir, names.windowsPackageDirName);
  await access(join(packageDir, names.windowsExecutableName)).catch(() => {
    throw new Error(`Packaged Windows app not found: ${packageDir}. Run desktop:package:windows first.`);
  });

  const output = windowsUpdateArtifactPath({ rootDir, outDir, version, arch, product });
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  const zipCommand = windowsUpdateZipCommand({ packageDir, output, platform });
  await runner(zipCommand.command, zipCommand.args, zipCommand.options);
  await verifyWindowsUpdateZipLayout({ output, platform, runner, product });

  const metadata = await fileMetadata(output);
  const normalizedDistribution = normalizeDesktopDistribution(distribution);
  return {
    artifactPath: output,
    artifactName,
    version,
    platform: "Windows",
    arch,
    distribution: normalizedDistribution,
    size: metadata.size,
    sha256: metadata.sha256,
    release_manifest_patch: {
      platforms: {
        windows: {
          platform: "Windows",
          arch,
          file: artifactName,
          size: metadata.size,
          sha256: metadata.sha256,
        },
      },
    },
  };
}

export async function verifyWindowsUpdateZipLayout({ output, platform = process.platform, runner = runCommand, product = resolveReleaseProduct() } = {}) {
  const names = releaseProductNames(product);
  const expected = `${names.windowsPackageDirName}/${names.windowsExecutableName}`;
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$archive = [IO.Compression.ZipFile]::OpenRead($env:MOSA_WINDOWS_UPDATE_DESTINATION)",
      "try {",
      `  if (-not ($archive.Entries | Where-Object { $_.FullName -eq '${expected}' })) { throw 'Windows update ZIP is missing ${expected}.' }`,
      "} finally { $archive.Dispose() }",
    ].join("; ");
    await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      env: {
        ...process.env,
        MOSA_WINDOWS_UPDATE_DESTINATION: resolve(output),
      },
    });
    return true;
  }
  const result = await runner("unzip", ["-Z1", resolve(output)]);
  const entries = String(result?.stdout || "").split(/\r?\n/).map((entry) => entry.trim().replaceAll("\\", "/")).filter(Boolean);
  if (!entries.includes(expected)) throw new Error(`Windows update ZIP is missing ${expected}.`);
  return true;
}

async function fileMetadata(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error("Windows update ZIP is empty or invalid.");
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
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => {
      if (code === 0) return resolveRun({ stdout, stderr });
      rejectRun(new Error(`${command} failed: ${stderr.trim() || `exit ${code ?? "?"}${signal ? ` (${signal})` : ""}`}`));
    });
  });
}

async function main() {
  const result = await makeWindowsUpdateZip();
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] Windows update ZIP failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
