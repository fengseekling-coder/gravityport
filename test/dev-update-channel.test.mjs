// Task 479: the development update channel. Development packages read only
// their own signed feed; release packages never accept a development manifest.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL,
  MOSA_DEVELOPMENT_UPDATE_FEED_URL,
  MOSA_RELEASE_DOWNLOAD_BASE_URL,
  MOSA_UPDATE_FEED_URL,
  canUpdateDistribution,
  checkForMosaUpdate,
  compareVersions,
  parseUpdateManifest,
  updateChannelForDistribution,
} from "../desktop/update-service.mjs";
import {
  downloadMacosUpdate,
  launchMacosUpdateHelper,
  macosUpdateDownloadUrl,
  macosUpdateHelperScript,
} from "../desktop/macos-updater.mjs";
import { macReleasePackagingConfig } from "../desktop/forge.config.mjs";
import { devChannelBuildFromEnvironment, requiresMacDeveloperIdSigning } from "../lib/release-distribution.mjs";
import { createReleaseManifestTrust, signReleaseManifest } from "../lib/release-manifest-signature.mjs";
import { verifyMacosReleaseApp } from "../scripts/verify-macos-release.mjs";
import {
  assertDevChannelKey,
  DEV_CHANNEL_MANIFEST_KEY,
  devChannelHistoryKey,
  devChannelNotes,
  devChannelPackageKey,
  devChannelPackageUrl,
  devChannelVersion,
  parseEnvFile,
  selectDevChannelRetention,
} from "../scripts/dev-channel/channel.mjs";
import { loadDevChannelConfig } from "../scripts/dev-channel/publish.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TRUST = createReleaseManifestTrust(publicKey);
const TEAM = "B5ZJT8TRPN";
const DEV_VERSION = "0.3.19-dev.202611272130";

function manifestFor({ version = DEV_VERSION, distribution = "development", teamIdentifier = TEAM, macos = true, macosX64 = false, windows = false } = {}) {
  const mac = (arch) => ({
    platform: "macOS",
    arch,
    appName: "GravityPort.app",
    file: `GravityPort-darwin-${arch}-${version}.zip`,
    size: 4096,
    sha256: "d".repeat(64),
    ...(teamIdentifier ? { teamIdentifier } : {}),
  });
  return {
    version,
    publishedAt: "2026-11-27T21:30:00.000Z",
    notes: { zh: "开发版", en: "Development build" },
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution,
    },
    platforms: {
      ...(macos ? { macos: mac("arm64") } : {}),
      ...(macosX64 ? { macosX64: mac("x64") } : {}),
      ...(windows ? {
        windows: {
          platform: "Windows",
          arch: "x64",
          payloadExeName: "GravityPort.exe",
          file: `GravityPort-win32-x64-${version}.zip`,
          size: 4096,
          sha256: "e".repeat(64),
        },
      } : {}),
    },
  };
}

const signed = (manifest) => signReleaseManifest(manifest, { privateKey, expectedTrust: TRUST });

function feedServing(text) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, text: async () => text };
  };
  return { requests, fetchImpl };
}

test("the build's distribution picks the feed: development reads its own, releases read the public one", () => {
  assert.deepEqual(updateChannelForDistribution("development"), {
    channel: "development",
    feedUrl: MOSA_DEVELOPMENT_UPDATE_FEED_URL,
    downloadBaseUrl: MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL,
  });
  for (const distribution of ["preview", "production", null, undefined, ""]) {
    assert.deepEqual(updateChannelForDistribution(distribution), {
      channel: "release",
      feedUrl: MOSA_UPDATE_FEED_URL,
      downloadBaseUrl: MOSA_RELEASE_DOWNLOAD_BASE_URL,
    }, String(distribution));
  }
  assert.equal(MOSA_DEVELOPMENT_UPDATE_FEED_URL, "https://gravityport.azhuilab.com/releases/gravityport-dev/latest.json");
  assert.equal(MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL, "https://gravityport.azhuilab.com/releases/gravityport-dev/");
  // The development packages never land in the website's downloads/.
  assert.notEqual(MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL, MOSA_RELEASE_DOWNLOAD_BASE_URL);
  assert.throws(() => updateChannelForDistribution("nightly"), /Invalid GravityPort desktop distribution/);
});

test("the development channel is closed in both directions", () => {
  assert.equal(canUpdateDistribution("development", "development"), true);
  assert.equal(canUpdateDistribution("development", "preview"), false);
  assert.equal(canUpdateDistribution("development", "production"), false);
  assert.equal(canUpdateDistribution("preview", "development"), false);
  assert.equal(canUpdateDistribution("production", "development"), false);
  assert.equal(canUpdateDistribution(null, "development"), false);
  // Release tracks are unchanged.
  assert.equal(canUpdateDistribution(null, "preview"), true);
  assert.equal(canUpdateDistribution("preview", "production"), true);
  assert.equal(canUpdateDistribution("production", "preview"), false);
});

test("development manifests pin the team identifier and carry no Windows package", () => {
  const parsed = parseUpdateManifest(manifestFor());
  assert.equal(parsed.buildIdentity.distribution, "development");
  assert.equal(parsed.macArtifact.teamIdentifier, TEAM);
  assert.equal(parsed.macArtifact.file, `GravityPort-darwin-arm64-${DEV_VERSION}.zip`);
  assert.throws(() => parseUpdateManifest(manifestFor({ teamIdentifier: "" })), /Development macOS packages require a release team identifier/);
  assert.throws(() => parseUpdateManifest(manifestFor({ macosX64: true, teamIdentifier: "" })), /team identifier/);
  assert.throws(() => parseUpdateManifest(manifestFor({ windows: true })), /do not carry Windows packages/);
  // Preview manifests may still omit it (unchanged behavior).
  assert.equal(parseUpdateManifest(manifestFor({ version: "0.3.19", distribution: "preview", teamIdentifier: "" })).macArtifact.teamIdentifier, undefined);
});

test("a development build reads only the development feed and is offered newer development packages", async () => {
  const { requests, fetchImpl } = feedServing(JSON.stringify(signed(manifestFor())));
  const result = await checkForMosaUpdate({
    currentVersion: "0.3.19-dev.202611270900",
    currentDistribution: "development",
    releaseManifestTrust: TRUST,
    // Usage parameters never ride on the development feed.
    anonymousUsage: {
      event: "daily_active",
      telemetryVersion: 2,
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      platform: "macos",
      arch: "arm64",
      version: "0.3.19-dev.202611270900",
    },
    macArch: "arm64",
    platform: "darwin",
    fetchImpl,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, MOSA_DEVELOPMENT_UPDATE_FEED_URL);
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.distributionAllowed, true);
  assert.equal(result.channel, "development");
  assert.equal(result.downloadBaseUrl, MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL);
  assert.equal(result.latestVersion, DEV_VERSION);

  // The same package is not offered again, and an older one never is.
  for (const currentVersion of [DEV_VERSION, "0.3.19-dev.202611280000"]) {
    const again = await checkForMosaUpdate({
      currentVersion, currentDistribution: "development", releaseManifestTrust: TRUST, platform: "darwin",
      fetchImpl: feedServing(JSON.stringify(signed(manifestFor()))).fetchImpl,
    });
    assert.equal(again.updateAvailable, false, currentVersion);
  }
});

test("a development build refuses a release manifest even when it is signed and newer", async () => {
  for (const distribution of ["preview", "production"]) {
    const { requests, fetchImpl } = feedServing(JSON.stringify(signed(manifestFor({ version: "0.4.0", distribution }))));
    const result = await checkForMosaUpdate({
      currentVersion: "0.3.18",
      currentDistribution: "development",
      releaseManifestTrust: TRUST,
      platform: "darwin",
      fetchImpl,
    });
    assert.equal(requests[0].url, MOSA_DEVELOPMENT_UPDATE_FEED_URL, distribution);
    assert.equal(result.distributionAllowed, false, distribution);
    assert.equal(result.updateAvailable, false, distribution);
  }
});

test("release builds read the public feed and refuse a development manifest", async () => {
  for (const currentDistribution of ["preview", "production", null]) {
    const { requests, fetchImpl } = feedServing(JSON.stringify(signed(manifestFor())));
    const result = await checkForMosaUpdate({
      currentVersion: "0.3.18",
      currentDistribution,
      releaseManifestTrust: TRUST,
      platform: "darwin",
      fetchImpl,
    });
    assert.equal(requests[0].url, MOSA_UPDATE_FEED_URL, String(currentDistribution));
    assert.equal(result.channel, "release");
    assert.equal(result.downloadBaseUrl, MOSA_RELEASE_DOWNLOAD_BASE_URL);
    assert.equal(result.distributionAllowed, false, String(currentDistribution));
    assert.equal(result.updateAvailable, false, String(currentDistribution));
  }
});

test("the development channel offers an update only to a host it carries a package for", async () => {
  const check = (platform, macArch) => checkForMosaUpdate({
    currentVersion: "0.3.18",
    currentDistribution: "development",
    releaseManifestTrust: TRUST,
    platform,
    macArch,
    fetchImpl: feedServing(JSON.stringify(signed(manifestFor()))).fetchImpl,
  });
  assert.equal((await check("darwin", "arm64")).updateAvailable, true);
  // No Intel package and no Windows package in the development feed.
  assert.equal((await check("darwin", "x64")).updateAvailable, false);
  assert.equal((await check("win32")).updateAvailable, false);
  assert.equal((await check("linux")).updateAvailable, false);
});

test("a development feed with a broken signature is refused", async () => {
  const document = signed(manifestFor());
  await assert.rejects(checkForMosaUpdate({
    currentVersion: "0.3.18",
    currentDistribution: "development",
    releaseManifestTrust: TRUST,
    platform: "darwin",
    fetchImpl: feedServing(JSON.stringify({ ...document, version: "0.3.19-dev.209912312359" })).fetchImpl,
  }), /signature verification failed/);
});

test("macOS packages download only from the two first-party bases", async () => {
  const artifact = { file: `GravityPort-darwin-arm64-${DEV_VERSION}.zip` };
  assert.equal(
    macosUpdateDownloadUrl(artifact, { downloadBaseUrl: MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL }),
    `https://gravityport.azhuilab.com/releases/gravityport-dev/GravityPort-darwin-arm64-${DEV_VERSION}.zip`,
  );
  assert.equal(macosUpdateDownloadUrl(artifact), `https://gravityport.azhuilab.com/downloads/GravityPort-darwin-arm64-${DEV_VERSION}.zip`);
  for (const downloadBaseUrl of [
    "https://evil.example/",
    "https://gravityport.azhuilab.com/releases/gravityport/",
    "http://gravityport.azhuilab.com/downloads/",
  ]) {
    assert.throws(() => macosUpdateDownloadUrl(artifact, { downloadBaseUrl }), /Unsupported macOS update download location/, downloadBaseUrl);
  }

  const root = await mkdtemp(join(tmpdir(), "gp-479-dev-download-"));
  try {
    const bytes = Buffer.from("development-update-zip");
    const requested = [];
    await downloadMacosUpdate({
      artifact: {
        platform: "macOS",
        arch: "arm64",
        appName: "GravityPort.app",
        file: `GravityPort-darwin-arm64-${DEV_VERSION}.zip`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        teamIdentifier: TEAM,
      },
      version: DEV_VERSION,
      stagingRoot: root,
      downloadBaseUrl: MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL,
      fetchImpl: async (url) => {
        requested.push(String(url));
        return { ok: true, status: 200, headers: { get: () => String(bytes.length) }, body: Readable.from([bytes]) };
      },
    });
    assert.deepEqual(requested, [`${MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL}GravityPort-darwin-arm64-${DEV_VERSION}.zip`]);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("the macOS helper installs a development package only with a pinned team identifier", async () => {
  const invocations = [];
  const spawnImpl = (command, args) => {
    invocations.push(args);
    const child = new EventEmitter();
    child.pid = 4321;
    child.kill = () => true;
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  const root = await mkdtemp(join(tmpdir(), "gp-479-dev-helper-"));
  try {
    const base = {
      zipPath: join(root, `GravityPort-darwin-arm64-${DEV_VERSION}.zip`),
      installAppPath: "/Applications/GravityPort.app",
      version: DEV_VERSION,
      expectedIdentity: { gitSha: "a".repeat(40), uiFingerprint: "b".repeat(64), runtimeFingerprint: "c".repeat(64), distribution: "development" },
      processId: 1234,
      libraryDir: "/tmp/gp-479-library",
      appName: "GravityPort.app",
      createUpdateHandoff: async () => ({}),
      spawnImpl,
    };
    await assert.rejects(launchMacosUpdateHelper(base), /development updates require a release team identifier/);
    await launchMacosUpdateHelper({ ...base, expectedTeamIdentifier: TEAM });
    const args = invocations.at(-1);
    assert.equal(args[args.length - 4], "development");
    assert.equal(args[args.length - 2], TEAM);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
  // The helper's branch without a team identifier still accepts preview
  // payloads only, so a development payload can never take it.
  const script = macosUpdateHelperScript();
  assert.match(script, /elif \[ "\$EXPECTED_DISTRIBUTION" = "production" \]; then\n  false\nelse\n  \[ "\$EXPECTED_DISTRIBUTION" = "preview" \]\nfi/);
});

test("MOSA_DEV_CHANNEL=1 is the only way to sign a development build with Developer ID", () => {
  assert.equal(devChannelBuildFromEnvironment({}), false);
  assert.equal(devChannelBuildFromEnvironment({ MOSA_DEV_CHANNEL: "" }), false);
  assert.equal(devChannelBuildFromEnvironment({ MOSA_DEV_CHANNEL: "1" }), true);
  assert.equal(devChannelBuildFromEnvironment({ MOSA_DEV_CHANNEL: "1", MOSA_RELEASE_DISTRIBUTION: "development" }), true);
  for (const value of ["0", "true", " 1"]) {
    assert.throws(() => devChannelBuildFromEnvironment({ MOSA_DEV_CHANNEL: value }), /MOSA_DEV_CHANNEL must be unset or 1/, value);
  }
  for (const distribution of ["preview", "production"]) {
    assert.throws(() => devChannelBuildFromEnvironment({ MOSA_DEV_CHANNEL: "1", MOSA_RELEASE_DISTRIBUTION: distribution }), /only applies to development builds/);
  }
  assert.equal(requiresMacDeveloperIdSigning("development"), false);
  assert.equal(requiresMacDeveloperIdSigning("development", { devChannel: true }), true);
  assert.equal(requiresMacDeveloperIdSigning("preview", { devChannel: false }), true);

  const credentials = {
    MOSA_MACOS_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123456)",
    MOSA_MACOS_SIGN_KEYCHAIN: "/Users/example/Library/Keychains/gravityport-signing.keychain-db",
    APPLE_TEAM_ID: "TEAM123456",
    MOSA_NOTARY_KEYCHAIN_PROFILE: "gravityport-notary",
  };
  assert.throws(() => macReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "development", MOSA_DEV_CHANNEL: "1" }), /MOSA release build requires/);
  const config = macReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "development", MOSA_DEV_CHANNEL: "1", ...credentials });
  assert.equal(config.osxSign.identity, credentials.MOSA_MACOS_SIGN_IDENTITY);
  assert.equal(config.osxSign.optionsForFile("/tmp/GravityPort.app").hardenedRuntime, true);
  assert.deepEqual(config.osxNotarize, { keychainProfile: "gravityport-notary" });
  // Signing credentials in the environment alone never turn a local package
  // into a notarized one.
  assert.equal(macReleasePackagingConfig({ MOSA_RELEASE_DISTRIBUTION: "development", ...credentials }).osxSign.identity, "-");
});

test("a development-channel app is verified to the release standard", async () => {
  const identity = "Developer ID Application: Example Studio (TEAM123456)";
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args].slice(0, 3));
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return {
        stdout: "",
        stderr: [
          "Identifier=com.azhuilab.mosa",
          "CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=10+7 location=embedded",
          `Authority=${identity}`,
          "TeamIdentifier=TEAM123456",
        ].join("\n"),
      };
    }
    return { stdout: "", stderr: "" };
  };
  const env = { MOSA_RELEASE_DISTRIBUTION: "development", MOSA_DEV_CHANNEL: "1", APPLE_TEAM_ID: "TEAM123456", MOSA_MACOS_SIGN_IDENTITY: identity };
  const result = await verifyMacosReleaseApp({ appPath: ".", env, runner });
  assert.equal(result.distribution, "development");
  assert.equal(result.teamId, "TEAM123456");
  assert.deepEqual(calls, [
    ["/usr/bin/codesign", "--verify", "--deep"],
    ["/usr/bin/codesign", "-dv", "--verbose=4"],
    ["/usr/bin/xcrun", "stapler", "validate"],
    ["/usr/sbin/spctl", "-a", "-vv"],
  ]);
  // Without the switch a development app is not a release artifact.
  await assert.rejects(
    verifyMacosReleaseApp({ appPath: ".", env: { MOSA_RELEASE_DISTRIBUTION: "development" }, runner }),
    /Release artifacts must use preview or production/,
  );
  await assert.rejects(
    verifyMacosReleaseApp({ appPath: ".", env, runner, distribution: "preview" }),
    /must carry the development distribution/,
  );
});

test("development versions sort after the release they come from and after each other", () => {
  assert.equal(devChannelVersion("0.3.18", new Date(Date.UTC(2026, 10, 27, 21, 30, 59))), "0.3.19-dev.202611272130");
  assert.equal(devChannelVersion("1.9.9", new Date(Date.UTC(2027, 0, 2, 3, 4))), "1.9.10-dev.202701020304");
  assert.throws(() => devChannelVersion("0.3.19-dev.202611272130"), /must be x\.y\.z/);
  assert.throws(() => devChannelVersion("v0.3.18"), /must be x\.y\.z/);
  const first = devChannelVersion("0.3.18", new Date(Date.UTC(2026, 10, 27, 21, 30)));
  const second = devChannelVersion("0.3.18", new Date(Date.UTC(2026, 10, 28, 1, 5)));
  const afterRelease = devChannelVersion("0.3.19", new Date(Date.UTC(2026, 10, 28, 2, 0)));
  assert.equal(compareVersions(first, "0.3.18"), 1);
  assert.equal(compareVersions(second, first), 1);
  assert.equal(compareVersions(afterRelease, "0.3.19"), 1);
  assert.equal(compareVersions(afterRelease, second), 1);
  assert.equal(parseUpdateManifest(manifestFor({ version: first })).version, first);
});

test("the publisher writes and deletes only development-channel keys", () => {
  for (const key of [
    DEV_CHANNEL_MANIFEST_KEY,
    devChannelPackageKey(DEV_VERSION),
    devChannelHistoryKey(DEV_VERSION, new Date(Date.UTC(2026, 10, 27, 21, 30, 5))),
    devChannelHistoryKey(null, new Date(Date.UTC(2026, 10, 27, 21, 30, 5))),
  ]) {
    assert.equal(assertDevChannelKey(key), key);
  }
  assert.equal(devChannelHistoryKey(DEV_VERSION, new Date(Date.UTC(2026, 10, 27, 21, 30, 5))), `releases/gravityport-dev/history/latest-20261127T213005Z-${DEV_VERSION}.json`);
  for (const key of [
    "releases/gravityport/latest.json",
    "releases/latest.json",
    `downloads/GravityPort-darwin-arm64-${DEV_VERSION}.zip`,
    "downloads/GravityPort-darwin-arm64-0.3.18.zip",
    "releases/gravityport-dev/../gravityport/latest.json",
    "releases/gravityport-dev/GravityPort-darwin-arm64-0.3.18.zip",
    "releases/gravityport-dev/GravityPort-darwin-x64-0.3.19-dev.202611272130.zip",
    "releases/gravityport-dev/history/latest.json",
    "releases/gravityport-dev/",
    "",
  ]) {
    assert.throws(() => assertDevChannelKey(key), /Refusing to touch/, key);
  }
  assert.equal(devChannelPackageUrl(DEV_VERSION), `${MOSA_DEVELOPMENT_DOWNLOAD_BASE_URL}GravityPort-darwin-arm64-${DEV_VERSION}.zip`);
});

test("retention keeps the newest packages and history and never strays outside the channel", () => {
  const packages = ["202611200000", "202611210000", "202611220000", "202611230000", "202611240000"]
    .map((stamp) => devChannelPackageKey(`0.3.19-dev.${stamp}`));
  const history = Array.from({ length: 12 }, (_, index) => devChannelHistoryKey(DEV_VERSION, new Date(Date.UTC(2026, 10, 1 + index))));
  const foreign = [
    "releases/gravityport/latest.json",
    "releases/gravityport-dev/notes.txt",
    "releases/gravityport-dev/GravityPort-darwin-arm64-0.3.18.zip",
  ];
  const doomed = selectDevChannelRetention([...packages, ...history, ...foreign, DEV_CHANNEL_MANIFEST_KEY]);
  assert.deepEqual(doomed.filter((key) => key.endsWith(".zip")).sort(), packages.slice(0, 2).sort());
  assert.deepEqual(doomed.filter((key) => key.includes("/history/")).sort(), history.slice(0, 2).sort());
  assert.ok(!doomed.some((key) => foreign.includes(key) || key === DEV_CHANNEL_MANIFEST_KEY));

  // A protected key (the package the new feed names) survives even when it
  // would fall outside the window; a 0.4.0 development package outranks the
  // 0.3.19 ones.
  const newer = devChannelPackageKey("0.4.1-dev.202601010000");
  const kept = selectDevChannelRetention([...packages, newer], { keepPackages: 1, protectedKeys: [packages[0]] });
  assert.ok(!kept.includes(packages[0]));
  assert.ok(!kept.includes(newer));
  assert.equal(kept.length, packages.length - 1);
});

test("development notes name the commit and list what changed, within the client limit", () => {
  const notes = devChannelNotes({ version: DEV_VERSION, gitSha: "1bbd16c27d0f8acd", commits: ["feat: one", "fix:   two  "] });
  assert.equal(notes.zh, `开发版 ${DEV_VERSION}，构建自 main 提交 1bbd16c。\n\n自上一开发版以来的提交：\n- feat: one\n- fix: two`);
  assert.equal(notes.en, `Development build ${DEV_VERSION} from main commit 1bbd16c.\n\nCommits since the previous development build:\n- feat: one\n- fix: two`);
  assert.equal(devChannelNotes({ version: DEV_VERSION, gitSha: "abc1234", commits: [] }).en, `Development build ${DEV_VERSION} from main commit abc1234.`);
  const many = devChannelNotes({ version: DEV_VERSION, gitSha: "abc1234", commits: Array.from({ length: 50 }, (_, index) => `${index} ${"x".repeat(200)}`) });
  assert.ok(many.zh.length <= 3000 && many.en.length <= 3000);
  assert.match(many.en, /\(\+30\)$/);
});

test("publisher settings come from the environment first, then the local files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gp-479-config-"));
  try {
    const release = join(dir, "release.env");
    const channel = join(dir, "dev-channel.env");
    await writeFile(release, "# local only\nMOSA_RELEASE_R2_ENDPOINT=https://example.r2.cloudflarestorage.com\nMOSA_RELEASE_R2_ACCESS_KEY_ID=file-id\nnot a line\n");
    await writeFile(channel, "APPLE_TEAM_ID=b5zjt8trpn\nMOSA_MACOS_SIGN_IDENTITY=Developer ID Application: Example (B5ZJT8TRPN)\n");
    const config = loadDevChannelConfig({ MOSA_RELEASE_R2_ACCESS_KEY_ID: "env-id" }, [release, channel, join(dir, "missing.env")]);
    assert.equal(config.r2Endpoint, "https://example.r2.cloudflarestorage.com");
    assert.equal(config.r2AccessKeyId, "env-id");
    assert.equal(config.r2Bucket, "gravityport-releases");
    assert.equal(config.teamId, "B5ZJT8TRPN");
    assert.equal(config.signIdentity, "Developer ID Application: Example (B5ZJT8TRPN)");
    assert.match(config.r2Client, /gravityport-website\/scripts\/r2-client\.mjs$/);
    assert.deepEqual(parseEnvFile("A=1\n# B=2\n lower=3\nC = four \n=5\n"), { A: "1", C: "four" });
  } finally {
    await removeTestPath(dir, { recursive: true, force: true });
  }
});

test("desktop main passes the channel's download base and keeps development builds out of usage counts", async () => {
  const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const ipc = await readFile(new URL("../desktop/ipc/updates.mjs", import.meta.url), "utf8");
  for (const source of [main, ipc]) {
    assert.match(source, /downloadMacosUpdate\(\{[^}]*downloadBaseUrl: release\.downloadBaseUrl,/s);
  }
  assert.equal((main.match(/expectedServiceIdentity\.distribution === "development"/g) || []).length, 2);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const script = pkg.scripts["desktop:release:development"];
  assert.match(script, /MOSA_RELEASE_DISTRIBUTION=development MOSA_DEV_CHANNEL=1 electron-forge package --platform darwin --arch arm64/);
  assert.match(script, /MOSA_DEV_CHANNEL=1 node scripts\/verify-macos-release\.mjs/);
  assert.match(script, /MOSA_DEV_CHANNEL=1 node scripts\/make-macos-update-zip\.mjs$/);
  // The AI switch is the publisher's business, never a checked-in script's.
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /GRAVITYPORT_LOCAL_AI/);
});
