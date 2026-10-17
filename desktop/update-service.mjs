import { verifyReleaseManifestSignature } from "../lib/release-manifest-signature.mjs";
import { normalizeDesktopDistribution } from "../lib/release-distribution.mjs";

// Both release products (MOSA transition build and GravityPort) check this
// new feed path; the legacy /releases/latest.json path stays frozen for
// already-shipped clients and never receives the renamed releases.
export const MOSA_UPDATE_FEED_URL = "https://mosa.azhuilab.com/releases/gravityport/latest.json";
export const MOSA_DOWNLOAD_PAGE_URL = "https://mosa.azhuilab.com/";

const UPDATE_MANIFEST_MAX_BYTES = 16 * 1024;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USAGE_EVENTS = new Set(["first_launch", "daily_active"]);
const USAGE_PLATFORMS = new Set(["macos", "windows", "other"]);
const USAGE_TELEMETRY_VERSION = 2;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
export const MACOS_TEAM_IDENTIFIER_PATTERN = /^[A-Z0-9]{10}$/;
export const MACOS_UPDATE_APP_NAMES = Object.freeze(["MOSA.app", "GravityPort.app"]);

// The manifest app name is bound to the update package filename: MOSA.app
// ships as MOSA-darwin-arm64-<version>.zip and GravityPort.app ships as
// GravityPort-darwin-arm64-<version>.zip. Anything else is rejected.
export function macosUpdateFileNameForAppName(appName, version) {
  if (!MACOS_UPDATE_APP_NAMES.includes(appName)) throw new Error("Invalid macOS update app name.");
  return `${appName.slice(0, -4)}-darwin-arm64-${version}.zip`;
}

function normalizeMacosTeamIdentifier(value) {
  const teamIdentifier = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!teamIdentifier) return "";
  if (!MACOS_TEAM_IDENTIFIER_PATTERN.test(teamIdentifier)) throw new Error("Invalid macOS release team identifier.");
  return teamIdentifier;
}

export const WINDOWS_UPDATE_EXE_NAMES = Object.freeze(["MOSA.exe", "GravityPort.exe"]);
export const WINDOWS_SIGNER_THUMBPRINT_PATTERN = /^[0-9A-F]{40}$/;

// The manifest payload executable is bound to the update package filename:
// MOSA.exe ships as MOSA-win32-x64-<version>.zip and GravityPort.exe ships as
// GravityPort-win32-x64-<version>.zip. Anything else is rejected.
export function windowsUpdateFileNameForPayloadExeName(payloadExeName, version) {
  if (!WINDOWS_UPDATE_EXE_NAMES.includes(payloadExeName)) throw new Error("Invalid Windows update payload executable name.");
  return `${payloadExeName.slice(0, -4)}-win32-x64-${version}.zip`;
}

export function normalizeWindowsUpdatePayloadExeName(value) {
  const exeName = value == null || String(value).trim() === "" ? "MOSA.exe" : String(value).trim();
  if (!WINDOWS_UPDATE_EXE_NAMES.includes(exeName)) throw new Error("Invalid Windows update payload executable name.");
  return exeName;
}

function normalizeWindowsSignerThumbprint(value) {
  const thumbprint = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!thumbprint) return "";
  if (!WINDOWS_SIGNER_THUMBPRINT_PATTERN.test(thumbprint)) throw new Error("Invalid Windows release signer thumbprint.");
  return thumbprint;
}

function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value || "").trim());
  if (!match) return null;
  return {
    version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4] ? `-${match[4]}` : ""}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) > Number(b) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a > b ? 1 : -1;
  }
  return 0;
}

export function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  if (!left || !right) throw new Error("Invalid MOSA version.");
  for (let index = 0; index < left.parts.length; index += 1) {
    if (left.parts[index] === right.parts[index]) continue;
    return left.parts[index] > right.parts[index] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function canUpdateDistribution(currentDistribution, targetDistribution) {
  if (!currentDistribution) return true;
  const current = normalizeDesktopDistribution(currentDistribution);
  const target = normalizeDesktopDistribution(targetDistribution, { defaultValue: "preview", releaseOnly: true });
  if (current === target) return true;
  // The rename ships a transition release that lets every existing preview
  // user cross into the later Developer-ID-signed production channel in place.
  // Trust stays anchored to the signed manifest: production manifests must pin
  // platforms.macos.teamIdentifier and the macOS helper verifies the payload
  // against it, so this bridge never accepts an arbitrary developer signature.
  // The reverse direction stays closed: a production install must never
  // silently downgrade back to preview.
  if (current === "preview" && target === "production") return true;
  return current === "development" && target === "preview";
}

function cleanNote(value) {
  return typeof value === "string" ? value.trim().slice(0, 3000) : "";
}

function parseBuildIdentity(value) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid release build identity.");
  const gitSha = typeof value.gitSha === "string" ? value.gitSha.trim().toLowerCase() : "";
  const uiFingerprint = typeof value.uiFingerprint === "string" ? value.uiFingerprint.trim().toLowerCase() : "";
  const runtimeFingerprint = typeof value.runtimeFingerprint === "string" ? value.runtimeFingerprint.trim().toLowerCase() : "";
  const distribution = normalizeDesktopDistribution(value.distribution, { defaultValue: "preview", releaseOnly: true });
  if (!GIT_SHA_PATTERN.test(gitSha)) throw new Error("Invalid release git SHA.");
  if (!SHA256_PATTERN.test(uiFingerprint)) throw new Error("Invalid release UI fingerprint.");
  if (!SHA256_PATTERN.test(runtimeFingerprint)) throw new Error("Invalid release runtime fingerprint.");
  return { gitSha, uiFingerprint, runtimeFingerprint, distribution };
}

function parseWindowsArtifact(value, version) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Windows update artifact.");
  const payloadExeName = normalizeWindowsUpdatePayloadExeName(value.payloadExeName);
  const expectedFile = windowsUpdateFileNameForPayloadExeName(payloadExeName, version);
  const file = typeof value.file === "string" ? value.file.trim() : "";
  const size = Number(value.size);
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "";
  const signerThumbprint = normalizeWindowsSignerThumbprint(value.signerThumbprint);
  if (value.platform !== "Windows" || value.arch !== "x64" || file !== expectedFile) {
    throw new Error("Invalid Windows update artifact identity.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1_500_000_000) {
    throw new Error("Invalid Windows update artifact size.");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid Windows update artifact digest.");
  return {
    platform: "Windows",
    arch: "x64",
    payloadExeName,
    file,
    size,
    sha256,
    ...(signerThumbprint ? { signerThumbprint } : {}),
  };
}

function parseMacArtifact(value, version) {
  if (value == null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid macOS update artifact.");
  const appName = typeof value.appName === "string" && value.appName.trim() ? value.appName.trim() : "MOSA.app";
  if (appName.includes("/") || appName.includes("\\")) throw new Error("Invalid macOS update app name.");
  const expectedFile = macosUpdateFileNameForAppName(appName, version);
  const file = typeof value.file === "string" ? value.file.trim() : "";
  const size = Number(value.size);
  const sha256 = typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : "";
  const teamIdentifier = normalizeMacosTeamIdentifier(value.teamIdentifier);
  if (value.platform !== "macOS" || value.arch !== "arm64" || file !== expectedFile) {
    throw new Error("Invalid macOS update artifact identity.");
  }
  if (!Number.isSafeInteger(size) || size <= 0 || size > 1_500_000_000) {
    throw new Error("Invalid macOS update artifact size.");
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid macOS update artifact digest.");
  return {
    platform: "macOS",
    arch: "arm64",
    appName,
    file,
    size,
    sha256,
    ...(teamIdentifier ? { teamIdentifier } : {}),
  };
}

export function parseUpdateManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid update manifest.");
  const parsedVersion = parseVersion(input.version);
  if (!parsedVersion) throw new Error("Invalid update manifest version.");
  const publishedAt = typeof input.publishedAt === "string" && input.publishedAt.length <= 64
    ? input.publishedAt.trim()
    : "";
  const notes = typeof input.notes === "string"
    ? { zh: cleanNote(input.notes), en: cleanNote(input.notes) }
    : {
        zh: cleanNote(input.notes?.zh),
        en: cleanNote(input.notes?.en),
      };
  const macArtifact = parseMacArtifact(input.platforms?.macos, parsedVersion.version);
  const windowsArtifact = parseWindowsArtifact(input.platforms?.windows, parsedVersion.version);
  const buildIdentity = parseBuildIdentity(input.build);
  if ((macArtifact || windowsArtifact) && !buildIdentity) {
    throw new Error("Update artifacts require release build identity.");
  }
  // Production trust is anchored to the manifest: the pinned team identifier
  // is what the macOS installer verifies the payload against. Preview may omit
  // it because those builds are ad-hoc signed.
  if (buildIdentity?.distribution === "production" && macArtifact && !macArtifact.teamIdentifier) {
    throw new Error("Production macOS releases require a release team identifier.");
  }
  // Windows production trust mirrors macOS: the pinned signer thumbprint is
  // what the installer verifies every payload signature against. Preview may
  // omit it because those builds ship unsigned.
  if (buildIdentity?.distribution === "production" && windowsArtifact && !windowsArtifact.signerThumbprint) {
    throw new Error("Production Windows releases require a release signer thumbprint.");
  }
  return {
    version: parsedVersion.version,
    publishedAt,
    notes,
    buildIdentity,
    macArtifact,
    windowsArtifact,
  };
}

export function buildUpdateFeedUrl(anonymousUsage = null) {
  if (!anonymousUsage || typeof anonymousUsage !== "object" || Array.isArray(anonymousUsage)) return MOSA_UPDATE_FEED_URL;
  const event = String(anonymousUsage.event || "");
  const telemetryVersion = Number(anonymousUsage.telemetryVersion);
  const installationId = String(anonymousUsage.installationId || "");
  const platform = String(anonymousUsage.platform || "");
  const arch = String(anonymousUsage.arch || "");
  const version = String(anonymousUsage.version || "");
  if (!USAGE_EVENTS.has(event)
    || telemetryVersion !== USAGE_TELEMETRY_VERSION
    || !INSTALLATION_ID_PATTERN.test(installationId)
    || !USAGE_PLATFORMS.has(platform)
    || !/^[0-9A-Za-z._-]{1,24}$/.test(arch)
    || !VERSION_PATTERN.test(version)) return MOSA_UPDATE_FEED_URL;

  const url = new URL(MOSA_UPDATE_FEED_URL);
  url.searchParams.set("event", event);
  url.searchParams.set("telemetry_version", String(USAGE_TELEMETRY_VERSION));
  url.searchParams.set("install_id", installationId);
  url.searchParams.set("platform", platform);
  url.searchParams.set("arch", arch);
  url.searchParams.set("version", version.replace(/^v/i, ""));
  return url.toString();
}

export async function reportAnonymousUsage({ anonymousUsage, fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Usage report fetch is unavailable.");
  const url = buildUpdateFeedUrl(anonymousUsage);
  if (url === MOSA_UPDATE_FEED_URL) return { reported: false, reason: "invalid-telemetry" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    // Usage reporting is intentionally independent from update-manifest parsing.
    // A HEAD request reaches the same first-party endpoint (and therefore the
    // existing Nginx usage log) without downloading the manifest body. This
    // lets every packaged MOSA build report a stable anonymous installation ID
    // regardless of whether the app was obtained from the website, GitHub, or
    // a directly shared package.
    const response = await fetchImpl(url, {
      method: "HEAD",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Usage report returned HTTP ${response?.status || 0}.`);
    return { reported: true };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkForMosaUpdate({
  currentVersion,
  currentDistribution = null,
  anonymousUsage = null,
  releaseManifestTrust = null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const current = parseVersion(currentVersion);
  if (!current) throw new Error("Invalid current MOSA version.");
  if (typeof fetchImpl !== "function") throw new Error("Update fetch is unavailable.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(buildUpdateFeedUrl(anonymousUsage), {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response?.ok) throw new Error(`Update feed returned HTTP ${response?.status || 0}.`);
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > UPDATE_MANIFEST_MAX_BYTES) throw new Error("Update manifest is too large.");
    const document = JSON.parse(text);
    if (releaseManifestTrust) verifyReleaseManifestSignature(document, releaseManifestTrust);
    const release = parseUpdateManifest(document);
    const distributionAllowed = !release.buildIdentity
      || canUpdateDistribution(currentDistribution, release.buildIdentity.distribution);
    return {
      currentVersion: current.version,
      latestVersion: release.version,
      updateAvailable: compareVersions(release.version, current.version) > 0 && distributionAllowed,
      distributionAllowed,
      publishedAt: release.publishedAt,
      notes: release.notes,
      buildIdentity: release.buildIdentity,
      macArtifact: release.macArtifact,
      windowsArtifact: release.windowsArtifact,
    };
  } finally {
    clearTimeout(timeout);
  }
}
