import { desktopDistributionFromEnvironment, requiresPlatformSigning } from "../lib/release-distribution.mjs";
import { resolveReleaseProduct } from "./release-product.mjs";

/**
 * Authenticode options for @electron/windows-sign, read from the release
 * environment. Forge signs the packaged app with them (desktop/forge.config.mjs)
 * and the installer build signs its uninstaller and installer with the same
 * ones (scripts/sign-windows-file.mjs). Only production builds sign; every
 * other distribution returns null.
 */
export function windowsSignOptionsFromEnvironment(env = process.env) {
  const distribution = desktopDistributionFromEnvironment(env);
  if (!requiresPlatformSigning(distribution)) return null;

  const signerThumbprint = String(env.MOSA_WINDOWS_SIGNER_THUMBPRINT || "").replace(/\s+/g, "").toUpperCase();
  if (!/^[0-9A-F]{40,64}$/.test(signerThumbprint)) {
    throw new Error("MOSA Windows release build requires MOSA_WINDOWS_SIGNER_THUMBPRINT.");
  }

  const certificateFile = String(env.WINDOWS_CERTIFICATE_FILE || "").trim();
  const certificatePassword = String(env.WINDOWS_CERTIFICATE_PASSWORD || "").trim();
  const signToolPath = String(env.WINDOWS_SIGNTOOL_PATH || "").trim();
  const signWithParams = String(env.WINDOWS_SIGN_WITH_PARAMS || "").trim();
  const hookModulePath = String(env.WINDOWS_SIGN_HOOK_MODULE_PATH || "").trim();
  const certificateMode = Boolean(certificateFile && certificatePassword);
  const customMode = Boolean(signWithParams || hookModulePath);
  if (!certificateMode && !customMode) {
    throw new Error(
      "MOSA Windows release build requires a signing source: WINDOWS_CERTIFICATE_FILE + WINDOWS_CERTIFICATE_PASSWORD, "
      + "WINDOWS_SIGN_WITH_PARAMS, or WINDOWS_SIGN_HOOK_MODULE_PATH.",
    );
  }

  return {
    continueOnError: false,
    hashes: ["sha256"],
    description: resolveReleaseProduct(env),
    website: "https://gravityport.azhuilab.com/",
    ...(certificateFile ? { certificateFile } : {}),
    ...(certificatePassword ? { certificatePassword } : {}),
    ...(signToolPath ? { signToolPath } : {}),
    ...(signWithParams ? { signWithParams } : {}),
    ...(hookModulePath ? { hookModulePath } : {}),
  };
}
