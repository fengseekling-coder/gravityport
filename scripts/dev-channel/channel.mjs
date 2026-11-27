// Pure rules of the development update channel (task 479), shared by
// scripts/dev-channel/publish.mjs and its tests. Nothing here touches the
// network, Git or the file system.
//
// R2 layout (bucket gravityport-releases, served by gp-edge under /releases/*):
//   releases/gravityport-dev/latest.json                          signed feed
//   releases/gravityport-dev/GravityPort-darwin-arm64-<v>.zip       update packages
//   releases/gravityport-dev/history/latest-<UTC>-<v>.json          replaced feeds
// The publisher writes and deletes only keys of exactly these shapes; anything
// else (downloads/, the public releases/gravityport/ feed) is out of reach.

import { compareVersions, MOSA_DEVELOPMENT_UPDATE_FEED_URL, MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL } from "../../desktop/update-service.mjs";

export const DEV_CHANNEL_PREFIX = "releases/gravityport-dev/";
export const DEV_CHANNEL_MANIFEST_KEY = `${DEV_CHANNEL_PREFIX}latest.json`;
export const DEV_CHANNEL_HISTORY_PREFIX = `${DEV_CHANNEL_PREFIX}history/`;
export const DEV_CHANNEL_KEEP_PACKAGES = 3;
export const DEV_CHANNEL_KEEP_HISTORY = 10;
export const DEV_CHANNEL_APP_NAME = "GravityPort.app";

const VERSION_CORE = String.raw`\d+\.\d+\.\d+`;
const DEV_VERSION = String.raw`${VERSION_CORE}-dev\.\d{12}`;
export const DEV_VERSION_PATTERN = new RegExp(`^${DEV_VERSION}$`);
const PACKAGE_KEY_PATTERN = new RegExp(`^releases/gravityport-dev/GravityPort-darwin-arm64-(${DEV_VERSION})\\.zip$`);
const HISTORY_KEY_PATTERN = new RegExp(`^releases/gravityport-dev/history/latest-\\d{8}T\\d{6}Z-(${DEV_VERSION}|none)\\.json$`);

// The feed URL the published manifest must be readable from, and the URL a
// package key is downloaded from. Both derive from the App's own constants so
// the publisher and the client can never disagree on the location.
export const DEV_CHANNEL_FEED_URL = MOSA_DEVELOPMENT_UPDATE_FEED_URL;
export function devChannelPackageUrl(version) {
  return new URL(encodeURIComponent(devChannelPackageFile(version)), MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL).toString();
}

function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}

// <next patch>-dev.<UTC yyyymmddHHMM>: main at 0.3.18 builds 0.3.19-dev.202611272130.
// Two packages built from the same package.json version must still compare
// as older/newer, or the App would never offer the second one and the
// background capture agent (which restarts when CFBundleShortVersionString
// changes) would keep running the old code. UTC keeps the stamp monotonic
// across daylight-saving changes.
export function devChannelVersion(baseVersion, date = new Date()) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(baseVersion || "").trim());
  if (!match) throw new Error(`package.json version must be x.y.z to derive a development version (got ${JSON.stringify(baseVersion)}).`);
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error("Invalid build time for the development version.");
  const stamp = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}`;
  return `${Number(match[1])}.${Number(match[2])}.${Number(match[3]) + 1}-dev.${stamp}`;
}

export function assertDevChannelVersion(version) {
  const clean = String(version || "").trim();
  if (!DEV_VERSION_PATTERN.test(clean)) {
    throw new Error(`Development versions look like 0.3.19-dev.202611272130 (got ${JSON.stringify(version)}).`);
  }
  return clean;
}

export function devChannelPackageFile(version) {
  return `GravityPort-darwin-arm64-${assertDevChannelVersion(version)}.zip`;
}

export function devChannelPackageKey(version) {
  return `${DEV_CHANNEL_PREFIX}${devChannelPackageFile(version)}`;
}

export function devChannelHistoryKey(previousVersion, date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const label = previousVersion ? assertDevChannelVersion(previousVersion) : "none";
  return `${DEV_CHANNEL_HISTORY_PREFIX}latest-${stamp}-${label}.json`;
}

// Every key the publisher writes or deletes goes through here first.
export function assertDevChannelKey(key) {
  const clean = String(key || "");
  if (clean === DEV_CHANNEL_MANIFEST_KEY || PACKAGE_KEY_PATTERN.test(clean) || HISTORY_KEY_PATTERN.test(clean)) return clean;
  throw new Error(`Refusing to touch ${JSON.stringify(clean)}: the development channel only writes under ${DEV_CHANNEL_PREFIX}.`);
}

// Which keys retention removes, given every key listed under the channel
// prefix. Keeps the newest packages and history files plus anything the caller
// protects (the package the new feed names). Keys of any other shape are
// never returned, whatever the listing contained.
export function selectDevChannelRetention(keys, {
  keepPackages = DEV_CHANNEL_KEEP_PACKAGES,
  keepHistory = DEV_CHANNEL_KEEP_HISTORY,
  protectedKeys = [],
} = {}) {
  const protect = new Set(protectedKeys);
  const packages = [];
  const history = [];
  for (const key of new Set(keys)) {
    const packageMatch = PACKAGE_KEY_PATTERN.exec(key);
    if (packageMatch) packages.push({ key, version: packageMatch[1] });
    else if (HISTORY_KEY_PATTERN.test(key)) history.push(key);
  }
  packages.sort((left, right) => compareVersions(right.version, left.version));
  history.sort().reverse();
  const doomed = [
    ...packages.slice(keepPackages).map((entry) => entry.key),
    ...history.slice(keepHistory),
  ].filter((key) => !protect.has(key) && key !== DEV_CHANNEL_MANIFEST_KEY);
  return doomed.map(assertDevChannelKey);
}

// Update notes shown in the App's update prompt. Commit subjects are the
// maintainer's own record of what changed; they stay in English.
export function devChannelNotes({ version, gitSha, commits = [], maxCommits = 20 } = {}) {
  const shortSha = String(gitSha || "").slice(0, 7);
  const lines = commits
    .map((subject) => String(subject || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, maxCommits)
    .map((subject) => `- ${subject.length > 120 ? `${subject.slice(0, 117)}...` : subject}`);
  const more = commits.length > maxCommits ? [`- … (+${commits.length - maxCommits})`] : [];
  const body = [...lines, ...more].join("\n");
  const zh = [`开发版 ${version}，构建自 main 提交 ${shortSha}。`, body ? `自上一开发版以来的提交：\n${body}` : ""].filter(Boolean).join("\n\n");
  const en = [`Development build ${version} from main commit ${shortSha}.`, body ? `Commits since the previous development build:\n${body}` : ""].filter(Boolean).join("\n\n");
  return { zh: zh.slice(0, 3000), en: en.slice(0, 3000) };
}

// KEY=value lines, "#" comments and blank lines ignored; surrounding quotes
// are not interpreted (the same format the website's release.env uses).
export function parseEnvFile(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}
