#!/usr/bin/env node
// Development update channel publisher (task 479): one command builds the
// maintainer's AI-enabled development package from main, signs and notarizes
// it with Developer ID, writes a manifest signed with the release key and
// uploads both to releases/gravityport-dev/ on R2, where packaged development
// builds look for updates (desktop/update-service.mjs).
//
// Usage:
//   npm run dev-channel:publish -- [options]
//   node scripts/dev-channel/publish.mjs [options]
//
// Options:
//   --ref <commit-ish>   what to build (default origin/main, fetched first).
//                        Publishing only accepts commits already on origin/main.
//   --build-dir <dir>    the dedicated build worktree (default
//                        ../gravityport-devbuild next to this checkout;
//                        created with `git worktree add --detach` when absent,
//                        moved to the commit otherwise, own npm ci)
//   --build-only         build, sign, notarize and write the signed manifest
//                        locally; nothing on R2 is read or written. Accepts any
//                        commit (rehearsals, a first manual install).
//   --skip-build         reuse the package already in --build-dir (its HEAD is
//                        the commit) instead of building
//   --version <v>        override the derived x.y.z-dev.yyyymmddHHMM version
//   --force              publish even when the feed already serves this commit
//   --dry-run            print the plan; reads R2 but never builds, signs,
//                        uploads or deletes anything (with --skip-build it also
//                        signs the manifest into a temporary file and checks it)
//
// Machine-specific settings stay outside the repository, one KEY=value per
// line; variables already in the environment win:
//   ~/.config/mosa/release.env      MOSA_RELEASE_R2_ENDPOINT, MOSA_RELEASE_R2_BUCKET,
//                                   MOSA_RELEASE_R2_ACCESS_KEY_ID (the secret comes
//                                   from the keychain via r2-client.mjs)
//   ~/.config/mosa/dev-channel.env  MOSA_MACOS_SIGN_IDENTITY, MOSA_MACOS_SIGN_KEYCHAIN,
//                                   MOSA_MACOS_SIGN_KEYCHAIN_PASSWORD_FILE (optional,
//                                   silent unlock), APPLE_TEAM_ID,
//                                   MOSA_NOTARY_KEYCHAIN_PROFILE,
//                                   MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE,
//                                   MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE,
//                                   MOSA_RELEASE_R2_CLIENT (default
//                                   ../gravityport-website/scripts/r2-client.mjs)
// Keys are only ever named by path. The private key is read in this process to
// sign the manifest and never printed or passed to the build.
//
// Heavy work (npm ci, packaging, notarization) runs here; start it through the
// project's queue script with a log file.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  assertDevChannelKey,
  assertDevChannelVersion,
  DEV_CHANNEL_APP_NAME,
  DEV_CHANNEL_FEED_URL,
  DEV_CHANNEL_MANIFEST_KEY,
  DEV_CHANNEL_PREFIX,
  devChannelHistoryKey,
  devChannelNotes,
  devChannelPackageFile,
  devChannelPackageKey,
  devChannelPackageUrl,
  devChannelVersion,
  parseEnvFile,
  selectDevChannelRetention,
} from "./channel.mjs";
import { compareVersions, parseUpdateManifest } from "../../desktop/update-service.mjs";
import {
  createReleaseManifestTrust,
  releaseManifestBackupTrustFromRepository,
  releaseManifestTrustSet,
  verifyReleaseManifestSignature,
} from "../../lib/release-manifest-signature.mjs";

const SCRIPT_REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const AI_SWITCH_KEY = "gravityport.dev.ai-generation";

const log = (...parts) => console.log(`[dev-channel ${new Date().toISOString().slice(11, 19)}]`, ...parts);
class PublishError extends Error {}
const die = (message) => { throw new PublishError(message); };

function run(command, args, { cwd = SCRIPT_REPO, env = process.env, capture = true, input } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: capture ? ["pipe", "pipe", "pipe"] : ["ignore", "inherit", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    die(`${command} ${args.slice(0, 3).join(" ")} exited with ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return capture ? result.stdout : "";
}

const git = (args, cwd = SCRIPT_REPO) => run("git", args, { cwd }).trim();

function realpathOrSelf(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

// --- configuration ----------------------------------------------------------

export function loadDevChannelConfig(env = process.env, files = [
  join(homedir(), ".config", "mosa", "release.env"),
  join(homedir(), ".config", "mosa", "dev-channel.env"),
]) {
  const fromFiles = {};
  for (const file of files) {
    if (existsSync(file)) Object.assign(fromFiles, parseEnvFile(readFileSync(file, "utf8")));
  }
  const value = (key, fallback = "") => String(env[key] ?? fromFiles[key] ?? fallback).trim();
  return {
    signIdentity: value("MOSA_MACOS_SIGN_IDENTITY"),
    signKeychain: value("MOSA_MACOS_SIGN_KEYCHAIN"),
    signKeychainPasswordFile: value("MOSA_MACOS_SIGN_KEYCHAIN_PASSWORD_FILE"),
    teamId: value("APPLE_TEAM_ID").toUpperCase(),
    notaryProfile: value("MOSA_NOTARY_KEYCHAIN_PROFILE"),
    publicKeyFile: value("MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE"),
    privateKeyFile: value("MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE"),
    r2Endpoint: value("MOSA_RELEASE_R2_ENDPOINT"),
    r2Bucket: value("MOSA_RELEASE_R2_BUCKET", "gravityport-releases"),
    r2AccessKeyId: value("MOSA_RELEASE_R2_ACCESS_KEY_ID"),
    r2Client: value("MOSA_RELEASE_R2_CLIENT", join(dirname(SCRIPT_REPO), "gravityport-website", "scripts", "r2-client.mjs")),
  };
}

function requireConfig(config, keys) {
  const names = {
    signIdentity: "MOSA_MACOS_SIGN_IDENTITY",
    signKeychain: "MOSA_MACOS_SIGN_KEYCHAIN",
    teamId: "APPLE_TEAM_ID",
    notaryProfile: "MOSA_NOTARY_KEYCHAIN_PROFILE",
    publicKeyFile: "MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE",
    privateKeyFile: "MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE",
    r2Endpoint: "MOSA_RELEASE_R2_ENDPOINT",
    r2AccessKeyId: "MOSA_RELEASE_R2_ACCESS_KEY_ID",
    r2Client: "MOSA_RELEASE_R2_CLIENT",
  };
  const missing = keys.filter((key) => !config[key]).map((key) => names[key]);
  if (missing.length) die(`missing settings: ${missing.join(", ")} (environment or ~/.config/mosa/dev-channel.env)`);
  for (const key of ["publicKeyFile", "privateKeyFile", "r2Client", "signKeychain"]) {
    if (keys.includes(key) && !existsSync(config[key])) die(`${names[key]} points at a missing file: ${config[key]}`);
  }
  if (keys.includes("teamId") && !/^[A-Z0-9]{10}$/.test(config.teamId)) die("APPLE_TEAM_ID must be a 10-character team identifier.");
}

// --- R2 (through the website repository's r2-client.mjs) -------------------

function r2Env(config) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MOSA_RELEASE_R2_ENDPOINT: config.r2Endpoint,
    MOSA_RELEASE_R2_BUCKET: config.r2Bucket,
    MOSA_RELEASE_R2_ACCESS_KEY_ID: config.r2AccessKeyId,
  };
  if (process.env.MOSA_RELEASE_R2_SECRET_ACCESS_KEY) env.MOSA_RELEASE_R2_SECRET_ACCESS_KEY = process.env.MOSA_RELEASE_R2_SECRET_ACCESS_KEY;
  return env;
}

function r2(config, command, ...args) {
  const result = spawnSync(process.execPath, [config.r2Client, command, ...args], {
    env: r2Env(config), encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) die(`R2 ${command} ${args.join(" ")} failed (exit ${result.status}): ${(result.stderr || "").trim()}`);
  return result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function r2Write(config, command, ...keysAndFiles) {
  // put <file> <key> | copy <source> <destination> | delete <key>
  const targetKey = command === "delete" ? keysAndFiles[0] : keysAndFiles[1];
  assertDevChannelKey(targetKey);
  return r2(config, command, ...keysAndFiles);
}

function readRemoteState(config, trusts) {
  const work = mkdtempSync(join(tmpdir(), "gp-dev-channel-"));
  try {
    const target = join(work, "latest.json");
    const [got] = r2(config, "get", DEV_CHANNEL_MANIFEST_KEY, target);
    let previous = null;
    if (got?.status === 200) {
      const text = readFileSync(target, "utf8");
      const document = JSON.parse(text);
      verifyReleaseManifestSignature(document, trusts);
      const parsed = parseUpdateManifest(document);
      if (parsed.buildIdentity?.distribution !== "development") die(`${DEV_CHANNEL_MANIFEST_KEY} is not a development manifest; refusing to replace it.`);
      previous = { version: parsed.version, gitSha: parsed.buildIdentity.gitSha, publishedAt: parsed.publishedAt };
    }
    const keys = r2(config, "list", DEV_CHANNEL_PREFIX).map((entry) => entry.key);
    return { previous, keys };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// --- build tree -------------------------------------------------------------

function commonGitDir(dir) {
  return realpathOrSelf(resolve(dir, git(["rev-parse", "--git-common-dir"], dir)));
}

function prepareBuildTree(buildDir, sha) {
  if (!existsSync(buildDir)) {
    log("creating build worktree", buildDir, "at", sha.slice(0, 12));
    git(["worktree", "add", "--detach", buildDir, sha]);
    return;
  }
  if (commonGitDir(buildDir) !== commonGitDir(SCRIPT_REPO)) die(`${buildDir} is not a worktree of this repository.`);
  // The previous run's version stamp is the only change this script makes.
  git(["checkout", "--", "package.json"], buildDir);
  const status = git(["status", "--porcelain", "--untracked-files=no"], buildDir);
  if (status) die(`${buildDir} has local changes; the build tree must stay clean:\n${status}`);
  git(["checkout", "--quiet", "--detach", sha], buildDir);
  log("build worktree", buildDir, "now at", sha.slice(0, 12));
}

function writeBuildVersion(buildDir, version) {
  const path = join(buildDir, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function buildEnvironment(config) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^MOSA_RELEASE_MANIFEST_PRIVATE_KEY/.test(key) || /^MOSA_RELEASE_R2_/.test(key)) delete env[key];
  }
  delete env.MOSA_FORGE_OUT_DIR;
  return {
    ...env,
    PATH: `${dirname(process.execPath)}:${env.PATH || ""}`,
    GRAVITYPORT_LOCAL_AI: "1",
    MOSA_RELEASE_PRODUCT: "GravityPort",
    MOSA_RELEASE_DISTRIBUTION: "development",
    MOSA_DEV_CHANNEL: "1",
    MOSA_QA_RUN: "1",
    MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE: config.publicKeyFile,
    MOSA_MACOS_SIGN_IDENTITY: config.signIdentity,
    MOSA_MACOS_SIGN_KEYCHAIN: config.signKeychain,
    APPLE_TEAM_ID: config.teamId,
    MOSA_NOTARY_KEYCHAIN_PROFILE: config.notaryProfile,
  };
}

function unlockSigningKeychain(config) {
  if (!config.signKeychainPasswordFile) {
    log("no MOSA_MACOS_SIGN_KEYCHAIN_PASSWORD_FILE; the signing keychain must already be unlocked");
    return;
  }
  const password = readFileSync(config.signKeychainPasswordFile, "utf8").replace(/\r?\n$/, "");
  const result = spawnSync("/usr/bin/security", ["unlock-keychain", "-p", password, config.signKeychain], { stdio: "ignore" });
  if (result.status !== 0) die("unlocking the signing keychain failed");
  log("signing keychain unlocked");
}

function buildPaths(buildDir, version) {
  return {
    appPath: join(buildDir, "out", "GravityPort-darwin-arm64", DEV_CHANNEL_APP_NAME),
    zipPath: join(buildDir, "out", "make", "update", "darwin", "arm64", devChannelPackageFile(version)),
    identityPath: join(buildDir, "web", "gravityport", "dist", "build-identity.json"),
    manifestPath: join(buildDir, "out", "make", "dev-channel", "latest.json"),
  };
}

async function verifyBuiltPackage({ buildDir, sha, version, config, primaryTrust }) {
  const paths = buildPaths(buildDir, version);
  for (const path of [paths.appPath, paths.zipPath, paths.identityPath]) {
    if (!existsSync(path)) die(`build output is missing: ${path}`);
  }
  const identity = JSON.parse(readFileSync(paths.identityPath, "utf8"));
  if (identity.productVersion !== version) die(`build identity version ${identity.productVersion} is not ${version}`);
  if (identity.gitSha !== sha) die(`build identity gitSha ${identity.gitSha} is not ${sha}`);
  if (identity.distribution !== "development") die(`build identity distribution ${identity.distribution} is not development`);
  if (identity.releaseManifestTrust?.keyId !== primaryTrust.keyId) die("build identity does not carry the release manifest public key");

  const { extractFile } = await import(pathToFileURL(join(buildDir, "node_modules", "@electron", "asar", "lib", "asar.js")).href);
  const asarPath = join(paths.appPath, "Contents", "Resources", "app.asar");
  const packagedIdentity = JSON.parse(extractFile(asarPath, join("web", "gravityport", "dist", "build-identity.json")).toString("utf8"));
  for (const field of ["productVersion", "gitSha", "uiFingerprint", "runtimeFingerprint", "distribution"]) {
    if (packagedIdentity[field] !== identity[field]) die(`packaged build identity ${field} differs from the build tree`);
  }
  // A local AI build compiles the localStorage switch away (see
  // web/gravityport/local-build-flags.mjs); released builds still carry it.
  if (readFileSync(asarPath).includes(AI_SWITCH_KEY)) die("the package still contains the AI switch key: GRAVITYPORT_LOCAL_AI=1 did not reach the build");

  const plistVersion = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", join(paths.appPath, "Contents", "Info.plist")]).trim();
  if (plistVersion !== version) die(`CFBundleShortVersionString ${plistVersion} is not ${version}`);
  const codesign = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", paths.appPath], { encoding: "utf8" });
  const team = /^TeamIdentifier=(.+)$/m.exec(`${codesign.stdout}\n${codesign.stderr}`)?.[1]?.trim();
  if (team !== config.teamId) die(`the app is signed for team ${team || "(none)"}, expected ${config.teamId}`);
  run("/usr/bin/xcrun", ["stapler", "validate", paths.appPath]);
  log("package verified", { version, gitSha: sha.slice(0, 12), team, ai: "on", trust: primaryTrust.keyId.slice(0, 8) });
  return { ...paths, identity };
}

// --- manifest -----------------------------------------------------------------

function commitSubjects(sha, previousSha) {
  const ancestor = previousSha
    && spawnSync("git", ["merge-base", "--is-ancestor", previousSha, sha], { cwd: SCRIPT_REPO }).status === 0;
  const range = ancestor ? [`${previousSha}..${sha}`] : ["-n", "20", sha];
  return git(["log", "--no-merges", "--format=%s", ...range]).split("\n").filter(Boolean);
}

async function writeSignedManifest({ buildDir, sha, version, config, identity, zipPath, previous, outputPath }) {
  const writer = await import(pathToFileURL(join(buildDir, "scripts", "prepare-desktop-release-manifest.mjs")).href);
  const manifest = await writer.prepareDesktopReleaseManifest({
    version,
    macArtifactPath: zipPath,
    macAppName: DEV_CHANNEL_APP_NAME,
    macTeamIdentifier: config.teamId,
    buildIdentity: identity,
    signingPrivateKey: readFileSync(config.privateKeyFile, "utf8"),
    publishedAt: new Date().toISOString(),
    notes: devChannelNotes({ version, gitSha: sha, commits: commitSubjects(sha, previous?.gitSha) }),
    channel: "development",
    env: { APPLE_TEAM_ID: config.teamId },
  });
  writer.assertManifestWithinClientLimit(manifest);
  mkdirSync(dirname(outputPath), { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(outputPath, text);

  // Read it back the way the clients will, with the build's own update code:
  // an older development package must be offered the update, a release build
  // must not.
  const service = await import(pathToFileURL(join(buildDir, "desktop", "update-service.mjs")).href);
  const trusts = releaseManifestTrustSet(identity.releaseManifestTrust, identity.releaseManifestBackupTrust);
  const served = (expectedUrl) => async (url) => (String(url) === expectedUrl
    ? new Response(text, { status: 200, headers: { "content-type": "application/json" } })
    : new Response("not found", { status: 404 }));
  const older = previous?.version && compareVersions(previous.version, version) < 0 ? previous.version : version.replace(/-dev\.\d+$/, "-dev.000000000000");
  const asDevelopment = await service.checkForMosaUpdate({
    currentVersion: older, currentDistribution: "development", releaseManifestTrust: trusts,
    macArch: "arm64", platform: "darwin", fetchImpl: served(DEV_CHANNEL_FEED_URL),
  });
  if (!asDevelopment.updateAvailable || asDevelopment.macArtifact?.file !== devChannelPackageFile(version)
    || asDevelopment.downloadBaseUrl !== service.MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL) {
    die("a development build would not be offered this manifest");
  }
  const asRelease = await service.checkForMosaUpdate({
    currentVersion: "0.0.1", currentDistribution: "preview", releaseManifestTrust: trusts,
    macArch: "arm64", platform: "darwin", fetchImpl: served(service.MOSA_UPDATE_FEED_URL),
  });
  if (asRelease.updateAvailable) die("a release build would accept this development manifest");
  log("signed manifest", outputPath, `${Buffer.byteLength(text)} bytes, keyId ${manifest.signature.keyId.slice(0, 8)}`);
  return { manifest, text };
}

// --- publish ------------------------------------------------------------------

async function publish({ config, version, zipPath, manifestPath, manifestText, previous, keys }) {
  const zipKey = devChannelPackageKey(version);
  const zipSize = statSync(zipPath).size;
  const zipSha = sha256File(zipPath);

  r2Write(config, "put", zipPath, zipKey);
  const [zipHead] = r2(config, "head", zipKey);
  if (zipHead?.status !== 200 || zipHead.size !== zipSize || zipHead.metaSha256 !== zipSha) {
    die(`R2 does not hold the uploaded package intact: ${JSON.stringify(zipHead)}`);
  }
  log("uploaded", zipKey, `${zipSize} bytes`);

  if (previous) {
    const historyKey = devChannelHistoryKey(previous.version);
    r2Write(config, "copy", DEV_CHANNEL_MANIFEST_KEY, historyKey);
    log("kept the previous feed as", historyKey);
  }
  // The feed goes last: no reader ever sees a feed naming a missing package.
  r2Write(config, "put", manifestPath, DEV_CHANNEL_MANIFEST_KEY);
  const [manifestHead] = r2(config, "head", DEV_CHANNEL_MANIFEST_KEY);
  if (manifestHead?.status !== 200 || manifestHead.size !== Buffer.byteLength(manifestText)) {
    die(`R2 does not hold the uploaded feed intact: ${JSON.stringify(manifestHead)}`);
  }
  log("uploaded", DEV_CHANNEL_MANIFEST_KEY);

  // What the Apps will actually read, through gp-edge.
  const live = await fetch(`${DEV_CHANNEL_FEED_URL}?v=${Date.now()}`, { headers: { "cache-control": "no-cache" } });
  const liveText = live.ok ? await live.text() : "";
  if (liveText !== manifestText) die(`${DEV_CHANNEL_FEED_URL} does not serve the uploaded feed (HTTP ${live.status})`);
  const livePackage = await fetch(devChannelPackageUrl(version), { method: "HEAD" });
  if (!livePackage.ok || Number(livePackage.headers.get("content-length")) !== zipSize) {
    die(`${devChannelPackageUrl(version)} does not serve the uploaded package (HTTP ${livePackage.status})`);
  }
  log("live feed and package verified");

  const listed = r2(config, "list", DEV_CHANNEL_PREFIX).map((entry) => entry.key);
  const doomed = selectDevChannelRetention([...new Set([...keys, ...listed])], { protectedKeys: [zipKey] })
    .filter((key) => listed.includes(key));
  for (const key of doomed) {
    r2Write(config, "delete", key);
    log("retention removed", key);
  }
  return { zipKey, zipSize, zipSha, removed: doomed };
}

// --- main ---------------------------------------------------------------------

function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      ref: { type: "string" },
      "build-dir": { type: "string" },
      "build-only": { type: "boolean" },
      "skip-build": { type: "boolean" },
      version: { type: "string" },
      force: { type: "boolean" },
      "dry-run": { type: "boolean" },
      // Internal: set when the outer run hands over to the build tree's own copy.
      "handoff-sha": { type: "string" },
      help: { type: "boolean" },
    },
  });
  return values;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
    console.log(lines.slice(0, lines.findIndex((line) => !line.startsWith("//"))).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    return;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") die("the development channel is built on an Apple-silicon Mac (arm64 only).");
  if (options["build-only"] && options["skip-build"]) die("--build-only and --skip-build do not combine");
  const dryRun = Boolean(options["dry-run"]);
  const buildOnly = Boolean(options["build-only"]);
  const skipBuild = Boolean(options["skip-build"]);
  const buildDir = resolve(options["build-dir"] || join(dirname(SCRIPT_REPO), "gravityport-devbuild"));
  const config = loadDevChannelConfig();
  requireConfig(config, [
    "teamId", "publicKeyFile", "privateKeyFile",
    ...(skipBuild ? [] : ["signIdentity", "signKeychain", "notaryProfile"]),
    ...(buildOnly ? [] : ["r2Endpoint", "r2AccessKeyId", "r2Client"]),
  ]);
  const primaryTrust = createReleaseManifestTrust(readFileSync(config.publicKeyFile, "utf8"));
  const trusts = releaseManifestTrustSet(primaryTrust, releaseManifestBackupTrustFromRepository(SCRIPT_REPO));

  // 1. what to build
  const handoff = options["handoff-sha"];
  let sha;
  if (skipBuild) {
    sha = git(["rev-parse", "HEAD"], buildDir);
  } else if (handoff) {
    sha = handoff;
    if (realpathOrSelf(SCRIPT_REPO) !== realpathOrSelf(buildDir)) die("--handoff-sha is internal to the build tree's own run");
    if (git(["rev-parse", "HEAD"], buildDir) !== sha) die("the build tree is not at the handed-over commit");
  } else {
    git(["fetch", "--quiet", "origin"]);
    sha = git(["rev-parse", "--verify", `${options.ref || "origin/main"}^{commit}`]);
  }
  const onMain = spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { cwd: SCRIPT_REPO }).status === 0;
  if (!buildOnly && !onMain) die(`${sha.slice(0, 12)} is not on origin/main; only merged commits are published (use --build-only for a local package).`);
  const baseVersion = JSON.parse(skipBuild
    ? readFileSync(join(buildDir, "package.json"), "utf8")
    : git(["show", `${sha}:package.json`])).version;
  const version = assertDevChannelVersion(options.version
    || (skipBuild ? baseVersion : devChannelVersion(baseVersion)));
  log("commit", sha, onMain ? "(on origin/main)" : "(not on origin/main)", "version", version);

  // 2. what the channel serves now
  let remote = { previous: null, keys: [] };
  if (!buildOnly) {
    remote = readRemoteState(config, trusts);
    log("feed now", remote.previous ? `${remote.previous.version} (${remote.previous.gitSha.slice(0, 12)})` : "(empty)", `${remote.keys.length} keys under ${DEV_CHANNEL_PREFIX}`);
    if (remote.previous?.gitSha === sha && !options.force) {
      log("the feed already serves this commit; nothing to publish (pass --force to publish it again)");
      return;
    }
    if (remote.previous && compareVersions(version, remote.previous.version) <= 0) {
      die(`version ${version} is not newer than the published ${remote.previous.version}`);
    }
  }

  if (dryRun) {
    const zipKey = devChannelPackageKey(version);
    console.log("dry run: nothing is built, signed, uploaded or deleted");
    console.log("build dir:", buildDir, skipBuild ? "(reused as is)" : existsSync(buildDir) ? "(moved to the commit, npm ci)" : "(git worktree add --detach, npm ci)");
    if (!skipBuild) {
      console.log("build:", "npm run desktop:release:development with GRAVITYPORT_LOCAL_AI=1 MOSA_RELEASE_DISTRIBUTION=development MOSA_DEV_CHANNEL=1 MOSA_QA_RUN=1");
      console.log("signing:", `${config.signIdentity} (keychain ${config.signKeychain}), notary profile ${config.notaryProfile}`);
    }
    console.log("manifest key:", primaryTrust.keyId);
    if (!buildOnly) {
      console.log("upload:", zipKey);
      if (remote.previous) console.log("history:", `${DEV_CHANNEL_MANIFEST_KEY} -> ${devChannelHistoryKey(remote.previous.version)}`);
      console.log("upload:", DEV_CHANNEL_MANIFEST_KEY, "(last)");
      const doomed = selectDevChannelRetention([...remote.keys, zipKey], { protectedKeys: [zipKey] }).filter((key) => remote.keys.includes(key));
      console.log("retention removes:", doomed.length ? `\n  ${doomed.join("\n  ")}` : "(nothing)");
    }
    if (skipBuild) {
      const built = await verifyBuiltPackage({ buildDir, sha, version, config, primaryTrust });
      const work = mkdtempSync(join(tmpdir(), "gp-dev-channel-dry-"));
      try {
        await writeSignedManifest({ buildDir, sha, version, config, identity: built.identity, zipPath: built.zipPath, previous: remote.previous, outputPath: join(work, "latest.json") });
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }
    return;
  }

  // 3. build (handing over to the build tree's own copy of this script, so the
  //    commit being shipped also drives its own build and manifest)
  if (!skipBuild) {
    if (!handoff) {
      // Also when this is the build tree's own copy: Node has already loaded
      // it, and the moved copy is the one that runs next.
      prepareBuildTree(buildDir, sha);
      const inner = join(buildDir, "scripts", "dev-channel", "publish.mjs");
      if (!existsSync(inner)) die(`${sha.slice(0, 12)} predates the development channel (no scripts/dev-channel/publish.mjs)`);
      const args = [inner, "--handoff-sha", sha, "--version", version, "--build-dir", buildDir];
      if (buildOnly) args.push("--build-only");
      if (options.force) args.push("--force");
      log("handing over to", inner);
      const result = spawnSync(process.execPath, args, { cwd: buildDir, stdio: "inherit", env: process.env });
      if (result.status !== 0) die(`the build tree's run failed (exit ${result.status ?? result.signal})`);
      return;
    }
    log("npm ci");
    run("npm", ["ci"], { cwd: buildDir, env: buildEnvironment(config), capture: false });
    writeBuildVersion(buildDir, version);
    unlockSigningKeychain(config);
    log("npm run desktop:release:development (package, sign, notarize, smoke, update ZIP)");
    run("npm", ["run", "desktop:release:development"], { cwd: buildDir, env: buildEnvironment(config), capture: false });
  }

  // 4. verify the package, sign the feed
  const built = await verifyBuiltPackage({ buildDir, sha, version, config, primaryTrust });
  const { text } = await writeSignedManifest({
    buildDir, sha, version, config, identity: built.identity, zipPath: built.zipPath, previous: remote.previous, outputPath: built.manifestPath,
  });
  if (buildOnly) {
    log("build only: nothing uploaded", { app: built.appPath, zip: built.zipPath, manifest: built.manifestPath });
    return;
  }

  // 5. publish
  const result = await publish({
    config, version, zipPath: built.zipPath, manifestPath: built.manifestPath, manifestText: text, previous: remote.previous, keys: remote.keys,
  });
  log("published", { version, gitSha: sha.slice(0, 12), feed: DEV_CHANNEL_FEED_URL, package: result.zipKey, removed: result.removed.length });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`[dev-channel] failed: ${error instanceof PublishError ? error.message : error?.stack || error}`);
    process.exitCode = 1;
  });
}
