// Single source of truth for the release packaging product switch.
//
// One source tree produces two package sets:
//   - "MOSA"        — the transition build published to move existing users
//                     onto the new update feed (MOSA.app / MOSA.exe).
//   - "GravityPort" — the renamed product (GravityPort.app / GravityPort.exe).
//
// The switch only owns packaging names. Everything else stays shared and
// identical between the two products: UI strings, bundle id
// com.azhuilab.mosa, the packaged package.json name "mosa", the userData
// directory, and the update feed URL. MOSA_RELEASE_PRODUCT is unset for
// GravityPort; any value other than the two product names is an error rather
// than a silent fallback to the default.

export const RELEASE_PRODUCTS = Object.freeze(["MOSA", "GravityPort"]);
export const DEFAULT_RELEASE_PRODUCT = "GravityPort";

export function resolveReleaseProduct(env = process.env) {
  const value = env.MOSA_RELEASE_PRODUCT;
  if (value === undefined) return DEFAULT_RELEASE_PRODUCT;
  if (!RELEASE_PRODUCTS.includes(value)) {
    throw new Error(
      `Unsupported MOSA_RELEASE_PRODUCT: ${JSON.stringify(value)}. `
      + `Expected exactly ${RELEASE_PRODUCTS.map((name) => JSON.stringify(name)).join(" or ")}, or leave it unset for ${DEFAULT_RELEASE_PRODUCT}.`,
    );
  }
  return value;
}

export function releaseProductNames(product = resolveReleaseProduct()) {
  if (!RELEASE_PRODUCTS.includes(product)) {
    throw new Error(`Unsupported release product: ${JSON.stringify(product)}. Expected ${RELEASE_PRODUCTS.join(" or ")}.`);
  }
  return Object.freeze({
    product,
    macAppBundleName: `${product}.app`,
    macExecutableName: product,
    windowsExecutableName: `${product}.exe`,
    macosPackageDirName: `${product}-darwin-arm64`,
    windowsPackageDirName: `${product}-win32-x64`,
    macosUpdateZipName: (version, arch = "arm64") => `${product}-darwin-${arch}-${version}.zip`,
    windowsUpdateZipName: (version, arch = "x64") => `${product}-win32-${arch}-${version}.zip`,
    // First installs download this one-file installer; in-app updates keep
    // using the update ZIP above.
    windowsInstallerName: (version, arch = "x64") => `${product}-win32-${arch}-${version}.exe`,
    macosDmgName: (version, arch = "arm64") => `${product}-darwin-${arch}-${version}.dmg`,
  });
}

export function resolveReleaseProductNames(env = process.env) {
  return releaseProductNames(resolveReleaseProduct(env));
}
