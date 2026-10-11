export const MOSA_DESKTOP_DISTRIBUTIONS = Object.freeze(["development", "preview", "production"]);

export function normalizeDesktopDistribution(value, { defaultValue = "development", releaseOnly = false } = {}) {
  const normalized = String(value || defaultValue).trim().toLowerCase();
  if (!MOSA_DESKTOP_DISTRIBUTIONS.includes(normalized)) {
    throw new Error(`Invalid GravityPort desktop distribution: ${normalized || "(empty)"}.`);
  }
  if (releaseOnly && normalized === "development") {
    throw new Error("Release artifacts must use preview or production distribution mode.");
  }
  return normalized;
}

export function desktopDistributionFromEnvironment(env = process.env, options = {}) {
  return normalizeDesktopDistribution(env.MOSA_RELEASE_DISTRIBUTION, options);
}

export function requiresPlatformSigning(distribution) {
  return normalizeDesktopDistribution(distribution) === "production";
}
