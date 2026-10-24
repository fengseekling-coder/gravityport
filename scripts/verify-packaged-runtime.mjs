#!/usr/bin/env node

import { extractFile, getRawHeader } from "@electron/asar";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { resolveDesktopPackagingTarget } from "../desktop/forge.config.mjs";
import { releaseProductNames, resolveReleaseProduct } from "./release-product.mjs";
import { LICENSES_DIR_NAME, verifyPackagedLicenses } from "./third-party-licenses.mjs";

const rootDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NATIVE_BINARY_PATTERN = /\.(?:node|dylib|dll)$/iu;
export const PACKAGED_MCP_SERVER = "mcp/server.mjs";
const RELATIVE_IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.{1,2}\/[^"']+)["']/gu;

/**
 * Every packaged module the bundled MCP server reaches through relative
 * imports. A missing one means AI clients would get a server that cannot start.
 */
export function missingMcpServerModules(packagedPaths, readModule) {
  const available = new Set(packagedPaths);
  const missing = [];
  const seen = new Set();
  const pending = [PACKAGED_MCP_SERVER];
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    if (!available.has(path)) {
      missing.push(path);
      continue;
    }
    for (const [, specifier] of String(readModule(path)).matchAll(RELATIVE_IMPORT_PATTERN)) {
      pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
    }
  }
  return missing.sort();
}

function packageResourcesDir({ outDir, target, product = resolveReleaseProduct() }) {
  const names = releaseProductNames(product);
  const packageDir = join(outDir, `${names.product}-${target.platform}-${target.arch}`);
  if (target.platform === "darwin") {
    return join(packageDir, names.macAppBundleName, "Contents", "Resources");
  }
  if (target.platform === "win32") {
    return join(packageDir, "resources");
  }
  throw new Error(`Unsupported packaged runtime target: ${target.id}.`);
}

function collectAsarFiles(directory, prefix = "", files = []) {
  for (const [name, entry] of Object.entries(directory?.files || {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry && typeof entry === "object" && "files" in entry) {
      collectAsarFiles(entry, path, files);
      continue;
    }
    if (entry && typeof entry === "object" && !("link" in entry)) {
      files.push({ path, entry });
    }
  }
  return files;
}

function parseJsonBuffer(buffer, description) {
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid ${description}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireNativeEntry(nativeEntries, predicate, description) {
  const entry = nativeEntries.find(predicate);
  if (!entry) throw new Error(`Packaged runtime is missing ${description}.`);
  return entry;
}

export function packagedAsarPath({
  projectRoot = rootDir,
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  platform,
  arch,
  product = resolveReleaseProduct(),
} = {}) {
  const target = resolveDesktopPackagingTarget({ platform, arch, env: {}, argv: [] });
  const outputRoot = resolve(projectRoot, outDir);
  return join(packageResourcesDir({ outDir: outputRoot, target, product }), "app.asar");
}

export async function verifyPackagedRuntime({
  projectRoot = rootDir,
  outDir = process.env.MOSA_FORGE_OUT_DIR || "out",
  platform,
  arch,
  product = resolveReleaseProduct(),
} = {}) {
  const target = resolveDesktopPackagingTarget({ platform, arch, env: {}, argv: [] });
  const asarPath = packagedAsarPath({ projectRoot, outDir, platform: target.platform, arch: target.arch, product });
  await access(asarPath).catch(() => {
    throw new Error(`Packaged ASAR not found: ${asarPath}`);
  });

  const { header } = getRawHeader(asarPath);
  const files = collectAsarFiles(header);
  const nativeEntries = files.filter(({ path }) => NATIVE_BINARY_PATTERN.test(path));
  if (!nativeEntries.length) {
    throw new Error(`Packaged runtime ${target.id} contains no native binaries; refusing to accept the package.`);
  }

  const packedNativeEntries = nativeEntries.filter(({ entry }) => entry.unpacked !== true);
  if (packedNativeEntries.length) {
    throw new Error(
      `Native binaries must be unpacked from app.asar: ${packedNativeEntries.map(({ path }) => path).join(", ")}`,
    );
  }

  const unpackedRoot = `${asarPath}.unpacked`;
  for (const { path } of nativeEntries) {
    const diskPath = join(unpackedRoot, ...path.split("/"));
    const info = await stat(diskPath).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`Unpacked native binary is missing from disk: ${path}`);
    }
    if (info.size <= 0) {
      throw new Error(`Unpacked native binary is empty on disk: ${path}`);
    }
  }

  requireNativeEntry(
    nativeEntries,
    ({ path }) => path === `node_modules/better-sqlite3/prebuilds/${target.sqlitePrebuild}`,
    `better-sqlite3 runtime ${target.sqlitePrebuild}`,
  );
  for (const packageName of target.sharpPackages) {
    const prefix = `node_modules/@img/${packageName}/`;
    requireNativeEntry(
      nativeEntries,
      ({ path }) => path.startsWith(prefix),
      `Sharp native runtime @img/${packageName}`,
    );
  }
  // Local visual search was removed: its runtime must never creep back into
  // the bundle, not even as a transitive dependency.
  const forbiddenVisualRuntimePrefixes = [
    "node_modules/onnxruntime-node/",
    "node_modules/onnxruntime-common/",
    "node_modules/@huggingface/tokenizers/",
  ];
  const bundledVisualRuntime = files.find(({ path }) => forbiddenVisualRuntimePrefixes.some((prefix) => path.startsWith(prefix)));
  if (bundledVisualRuntime) {
    throw new Error(`Removed visual runtime must stay out of ${releaseProductNames(product).macAppBundleName}: ${bundledVisualRuntime.path}`);
  }
  const unpackedOnnxDir = join(unpackedRoot, "node_modules", "onnxruntime-node");
  const unpackedOnnx = await stat(unpackedOnnxDir).catch(() => null);
  if (unpackedOnnx) throw new Error(`Removed ONNX Runtime must stay out of ${releaseProductNames(product).macAppBundleName} unpacked resources.`);

  const missingMcpModules = missingMcpServerModules(
    files.map(({ path }) => path),
    (path) => extractFile(asarPath, path).toString("utf8"),
  );
  if (missingMcpModules.length) {
    throw new Error(`Bundled MCP server is incomplete; missing from app.asar: ${missingMcpModules.join(", ")}`);
  }

  const sourceIdentity = JSON.parse(await readFile(resolve(projectRoot, "web", "gravityport", "dist", "build-identity.json"), "utf8"));
  const packagedIdentity = parseJsonBuffer(extractFile(asarPath, join("web", "gravityport", "dist", "build-identity.json")), "packaged build identity");
  if (!isDeepStrictEqual(packagedIdentity, sourceIdentity)) {
    throw new Error("Packaged build identity does not match the current source build identity.");
  }

  const sourceManifest = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8"));
  const packagedManifest = parseJsonBuffer(extractFile(asarPath, "package.json"), "packaged package.json");
  if (packagedManifest.name !== sourceManifest.name || packagedManifest.version !== sourceManifest.version) {
    throw new Error(
      `Packaged manifest identity mismatch: expected ${sourceManifest.name}@${sourceManifest.version}, `
      + `got ${packagedManifest.name || "(missing)"}@${packagedManifest.version || "(missing)"}.`,
    );
  }

  await verifyPackagedLicenses(join(dirname(asarPath), LICENSES_DIR_NAME));

  return {
    asarPath,
    target: target.id,
    nativeBinaries: nativeEntries.map(({ path }) => path),
    productVersion: packagedIdentity.productVersion,
    gitSha: packagedIdentity.gitSha,
  };
}

async function main() {
  const target = resolveDesktopPackagingTarget({ env: {}, argv: process.argv.slice(2) });
  const result = await verifyPackagedRuntime({ platform: target.platform, arch: target.arch });
  console.log(
    `[MOSA] Packaged runtime verified: ${result.target}; ${result.nativeBinaries.length} native binaries unpacked; `
    + `${result.productVersion} ${result.gitSha}`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[MOSA] Packaged runtime verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
