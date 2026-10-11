import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { releaseProductNames, resolveReleaseProduct } from "./release-product.mjs";

export function electronExecutablePath({ rootDir, platform = process.platform } = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const dist = join(resolve(rootDir), "node_modules", "electron", "dist");
  if (platform === "darwin") return join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  if (platform === "win32") return join(dist, "electron.exe");
  if (platform === "linux") return join(dist, "electron");
  throw new Error(`Unsupported Electron QA platform: ${platform}`);
}

export function ensureElectronExecutablePath({
  rootDir,
  platform = process.platform,
  loadElectron,
} = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const expected = electronExecutablePath({ rootDir, platform });
  const loader = typeof loadElectron === "function"
    ? loadElectron
    : () => createRequire(join(resolve(rootDir), "package.json"))("electron");
  const value = String(loader() || "").trim();
  if (!value) throw new Error("Electron package did not resolve an executable path.");
  const actual = resolve(value);
  if (actual !== resolve(expected)) {
    throw new Error(`Electron executable path mismatch: expected ${expected}, resolved ${actual}.`);
  }
  return actual;
}

export function packagedExecutablePath({
  rootDir,
  outDir,
  platform = process.platform,
  arch = platform === "win32" ? "x64" : "arm64",
  product = resolveReleaseProduct(),
} = {}) {
  if (!rootDir) throw new Error("rootDir is required.");
  const names = releaseProductNames(product);
  const outputRoot = resolve(outDir || join(rootDir, "out"));
  if (platform === "darwin" && arch === "arm64") {
    return join(outputRoot, names.macosPackageDirName, names.macAppBundleName, "Contents", "MacOS", names.macExecutableName);
  }
  if (platform === "win32" && arch === "x64") {
    return join(outputRoot, names.windowsPackageDirName, names.windowsExecutableName);
  }
  throw new Error(`Unsupported packaged MOSA target: ${platform}-${arch}`);
}
