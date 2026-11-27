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

// Task 479: a development build is normally a local ad-hoc package. The
// maintainer's development update channel (scripts/dev-channel/publish.mjs)
// opts in with MOSA_DEV_CHANNEL=1: the build stays "development" (it reads the
// development feed) but is Developer ID signed and notarized like a release,
// so the in-app updater's team-identifier check holds from one package to the
// next. Only the exact string "1" counts, and only for a development build.
export function devChannelBuildFromEnvironment(env = process.env) {
  const value = env.MOSA_DEV_CHANNEL;
  if (value === undefined || value === "") return false;
  if (value !== "1") throw new Error(`MOSA_DEV_CHANNEL must be unset or 1 (got: ${JSON.stringify(value)}).`);
  if (desktopDistributionFromEnvironment(env) !== "development") {
    throw new Error("MOSA_DEV_CHANNEL=1 only applies to development builds (MOSA_RELEASE_DISTRIBUTION unset or development).");
  }
  return true;
}

export function requiresPlatformSigning(distribution) {
  return normalizeDesktopDistribution(distribution) === "production";
}

export function requiresMacDeveloperIdSigning(distribution, { devChannel = false } = {}) {
  const normalized = normalizeDesktopDistribution(distribution);
  if (normalized === "development") return devChannel === true;
  return normalized === "preview" || normalized === "production";
}
