#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { desktopDistributionFromEnvironment, normalizeDesktopDistribution, requiresPlatformSigning } from "../lib/release-distribution.mjs";
import { releaseProductNames, resolveReleaseProduct } from "./release-product.mjs";
import { verifyMacosReleaseApp } from "./verify-macos-release.mjs";

export const MOSA_MAC_UPDATE_ARCH = "arm64";

export function macosUpdateArtifactName(version, arch = MOSA_MAC_UPDATE_ARCH, product = resolveReleaseProduct()) {
  const cleanVersion = String(version || "").trim();
  const cleanArch = String(arch || "").trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cleanVersion)) throw new Error("Invalid macOS update version.");
  if (cleanArch !== MOSA_MAC_UPDATE_ARCH) throw new Error(`Unsupported macOS update architecture: ${cleanArch}.`);
  return releaseProductNames(product).macosUpdateZipName(cleanVersion, cleanArch);
}

export function macosUpdateArtifactPath({ rootDir, outDir = "out", version, arch = MOSA_MAC_UPDATE_ARCH, product = resolveReleaseProduct() } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  return resolve(rootDir, outDir, "make", "update", "darwin", arch, macosUpdateArtifactName(version, arch, product));
}

export async function makeMacosUpdateZip({
  rootDir = resolve(fileURLToPath(new URL("..", import.meta.url))),
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  arch = MOSA_MAC_UPDATE_ARCH,
  distribution = desktopDistributionFromEnvironment(process.env),
  env = process.env,
  product = resolveReleaseProduct(env),
  runner = runCommand,
} = {}) {
  const names = releaseProductNames(product);
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const version = String(packageJson.version || "").trim();
  const artifactName = macosUpdateArtifactName(version, arch, product);
  const appPath = resolve(rootDir, outDir, `${product}-darwin-${arch}`, names.macAppBundleName);
  await access(join(appPath, "Contents", "MacOS", names.macExecutableName)).catch(() => {
    throw new Error(`Packaged macOS app not found: ${appPath}. Run desktop:package first.`);
  });
  const normalizedDistribution = normalizeDesktopDistribution(distribution);
  if (normalizedDistribution !== "development") {
    await verifyMacosReleaseApp({ appPath, env, runner, staple: false, distribution: normalizedDistribution });
  }

  const output = macosUpdateArtifactPath({ rootDir, outDir, version, arch, product });
  await mkdir(dirname(output), { recursive: true });
  await rm(output, { force: true });
  await runner("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, output]);
  const metadata = await fileMetadata(output);
  const result = {
    artifactPath: output,
    artifactName,
    version,
    platform: "macOS",
    arch,
    distribution: normalizedDistribution,
    size: metadata.size,
    sha256: metadata.sha256,
    release_manifest_patch: {
      platforms: {
        macos: {
          platform: "macOS",
          arch,
          file: artifactName,
          size: metadata.size,
          sha256: metadata.sha256,
        },
      },
    },
  };
  return result;
}

async function fileMetadata(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0) throw new Error("macOS update ZIP is empty or invalid.");
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return { size: info.size, sha256: hash.digest("hex") };
}

export function runCommand(command, args, { cwd = process.cwd() } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
  const result = await makeMacosUpdateZip();
  console.log(JSON.stringify(result, null, 2));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] macOS update ZIP failed: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
