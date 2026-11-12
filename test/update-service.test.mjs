import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  MOSA_DOWNLOAD_PAGE_URL,
  MOSA_UPDATE_FEED_URL,
  buildUpdateFeedUrl,
  canInstallUpdateInApp,
  canUpdateDistribution,
  checkForMosaUpdate,
  compareVersions,
  macosUpdateArchForHost,
  parseUpdateManifest,
  reportAnonymousUsage,
} from "../desktop/update-service.mjs";
import { createReleaseManifestTrust, signReleaseManifest } from "../lib/release-manifest-signature.mjs";

test("version comparison follows semver ordering for MOSA releases", () => {
  assert.equal(compareVersions("0.2.1", "0.2.0"), 1);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.2.0-beta.2", "0.2.0-beta.10"), -1);
  assert.equal(compareVersions("0.2.0", "0.2.0-beta.10"), 1);
  assert.throws(() => compareVersions("latest", "0.2.0"), /Invalid MOSA version/);
});

test("0.3.0 release candidates outrank the occupied 0.2.1 line", () => {
  // v0.2.1 was tagged while the 0.2.1-rc series continued past it, so releases
  // continue from 0.3.0 and every 0.2.1 / 0.2.1-rc.34 install must see the update.
  assert.equal(compareVersions("0.3.0-rc.1", "0.2.1"), 1);
  assert.equal(compareVersions("0.3.0-rc.1", "0.2.1-rc.34"), 1);
  assert.equal(compareVersions("0.3.1", "0.3.0-rc.1"), 1);
  assert.equal(compareVersions("0.3.2", "0.3.1"), 1);
  assert.equal(compareVersions("0.3.3", "0.3.2"), 1);
  assert.equal(compareVersions("0.3.4", "0.3.3"), 1);
  assert.equal(compareVersions("0.3.5", "0.3.4"), 1);
  assert.equal(compareVersions("0.3.6", "0.3.5"), 1);
  assert.equal(compareVersions("0.3.7", "0.3.6"), 1);
  assert.equal(compareVersions("0.3.8", "0.3.7"), 1);
  assert.equal(compareVersions("0.3.9", "0.3.8"), 1);
  assert.equal(compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(compareVersions("0.3.11", "0.3.10"), 1);
  assert.equal(compareVersions("0.3.12", "0.3.11"), 1);
});

test("update manifest keeps only bounded release metadata", () => {
  assert.deepEqual(parseUpdateManifest({
    version: "v0.3.0",
    publishedAt: "2026-09-01T10:00:00Z",
    notes: { zh: " 新版 ", en: " New release " },
    url: "https://evil.example/download",
  }), {
    version: "0.3.0",
    publishedAt: "2026-09-01T10:00:00Z",
    notes: { zh: "新版", en: "New release" },
    buildIdentity: null,
    macArtifact: null,
    windowsArtifact: null,
  });
  assert.equal(MOSA_UPDATE_FEED_URL, "https://gravityport.azhuilab.com/releases/gravityport/latest.json");
  assert.equal(MOSA_DOWNLOAD_PAGE_URL, "https://gravityport.azhuilab.com/#download");
});

test("update manifest parses itemized notes up to 3000 characters without truncation", () => {
  const zh = "• 第一条\n• 第二条\n".repeat(120).trim();
  const en = "• First\n• Second\n".repeat(150).trim();
  assert.ok(zh.length > 1200 && zh.length <= 3000, `zh note should sit in the raised window, got ${zh.length}`);
  assert.ok(en.length > 1200 && en.length <= 3000, `en note should sit in the raised window, got ${en.length}`);
  const parsed = parseUpdateManifest({ version: "0.3.0", notes: { zh, en } });
  assert.equal(parsed.notes.zh, zh);
  assert.equal(parsed.notes.en, en);
});

test("anonymous usage tagging keeps the update origin and path fixed", () => {
  const url = new URL(buildUpdateFeedUrl({
    event: "daily_active",
    telemetryVersion: 2,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    platform: "macos",
    arch: "arm64",
    version: "0.2.0",
  }));
  assert.equal(`${url.origin}${url.pathname}`, MOSA_UPDATE_FEED_URL);
  assert.equal(url.searchParams.get("event"), "daily_active");
  assert.equal(url.searchParams.get("telemetry_version"), "2");
  assert.equal(url.searchParams.get("install_id"), "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(url.searchParams.get("platform"), "macos");
  assert.equal(url.searchParams.get("arch"), "arm64");
  assert.equal(url.searchParams.get("version"), "0.2.0");
  assert.equal(buildUpdateFeedUrl({ event: "daily_active", installationId: "not-a-uuid" }), MOSA_UPDATE_FEED_URL);
});

test("anonymous usage reporting uses a bodyless first-party request and requires success", async () => {
  let request = null;
  const telemetry = {
    event: "first_launch",
    telemetryVersion: 2,
    installationId: "123e4567-e89b-42d3-a456-426614174000",
    platform: "windows",
    arch: "x64",
    version: "0.2.0",
  };
  const result = await reportAnonymousUsage({
    anonymousUsage: telemetry,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200 };
    },
  });
  const requestUrl = new URL(request.url);
  assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, MOSA_UPDATE_FEED_URL);
  assert.equal(requestUrl.searchParams.get("install_id"), telemetry.installationId);
  assert.equal(request.options.method, "HEAD");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(result, { reported: true });

  await assert.rejects(
    reportAnonymousUsage({
      anonymousUsage: telemetry,
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
  assert.deepEqual(
    await reportAnonymousUsage({ anonymousUsage: { ...telemetry, installationId: "invalid" } }),
    { reported: false, reason: "invalid-telemetry" },
  );
});

test("update check compares the fixed HTTPS feed against the installed version", async () => {
  let request = null;
  const result = await checkForMosaUpdate({
    currentVersion: "0.2.0",
    anonymousUsage: {
      event: "first_launch",
      telemetryVersion: 2,
      installationId: "123e4567-e89b-42d3-a456-426614174000",
      platform: "windows",
      arch: "x64",
      version: "0.2.0",
    },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          version: "0.2.1",
          publishedAt: "2026-09-01T10:00:00Z",
          notes: { zh: "修复问题", en: "Fixes" },
          build: {
            gitSha: "c".repeat(40),
            uiFingerprint: "d".repeat(64),
            runtimeFingerprint: "e".repeat(64),
            distribution: "preview",
          },
          platforms: {
            macos: {
              platform: "macOS",
              arch: "arm64",
              file: "MOSA-darwin-arm64-0.2.1.zip",
              size: 654321,
              sha256: "b".repeat(64),
            },
            windows: {
              platform: "Windows",
              arch: "x64",
              file: "MOSA-win32-x64-0.2.1.zip",
              size: 123456,
              sha256: "a".repeat(64),
            },
          },
        }),
      };
    },
  });

  const requestUrl = new URL(request.url);
  assert.equal(`${requestUrl.origin}${requestUrl.pathname}`, MOSA_UPDATE_FEED_URL);
  assert.equal(requestUrl.searchParams.get("event"), "first_launch");
  assert.equal(requestUrl.searchParams.get("platform"), "windows");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.redirect, "error");
  assert.equal(result.currentVersion, "0.2.0");
  assert.equal(result.latestVersion, "0.2.1");
  assert.equal(result.updateAvailable, true);
  assert.deepEqual(result.buildIdentity, {
    gitSha: "c".repeat(40),
    uiFingerprint: "d".repeat(64),
    runtimeFingerprint: "e".repeat(64),
    distribution: "preview",
  });
  assert.deepEqual(result.macArtifact, {
    platform: "macOS",
    arch: "arm64",
    appName: "MOSA.app",
    file: "MOSA-darwin-arm64-0.2.1.zip",
    size: 654321,
    sha256: "b".repeat(64),
  });
  assert.deepEqual(result.windowsArtifact, {
    platform: "Windows",
    arch: "x64",
    payloadExeName: "MOSA.exe",
    file: "MOSA-win32-x64-0.2.1.zip",
    size: 123456,
    sha256: "a".repeat(64),
  });
});

test("update manifest rejects a Windows artifact that is not bound to the release version", () => {
  assert.throws(() => parseUpdateManifest({
    version: "0.3.0",
    platforms: {
      windows: {
        platform: "Windows",
        arch: "x64",
        file: "MOSA-win32-x64-0.2.9.zip",
        size: 123,
        sha256: "b".repeat(64),
      },
    },
  }), /artifact identity/);
});

test("Windows artifacts declare their payload executable name bound to the package prefix", () => {
  const manifestFor = (file, payloadExeName) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "c".repeat(40),
      uiFingerprint: "d".repeat(64),
      runtimeFingerprint: "e".repeat(64),
      distribution: "preview",
    },
    platforms: {
      windows: {
        platform: "Windows",
        arch: "x64",
        ...(payloadExeName ? { payloadExeName } : {}),
        file,
        size: 123,
        sha256: "b".repeat(64),
      },
    },
  }).windowsArtifact;

  assert.deepEqual(manifestFor("MOSA-win32-x64-0.3.0.zip"), {
    platform: "Windows",
    arch: "x64",
    payloadExeName: "MOSA.exe",
    file: "MOSA-win32-x64-0.3.0.zip",
    size: 123,
    sha256: "b".repeat(64),
  });
  assert.deepEqual(manifestFor("GravityPort-win32-x64-0.3.0.zip", "GravityPort.exe"), {
    platform: "Windows",
    arch: "x64",
    payloadExeName: "GravityPort.exe",
    file: "GravityPort-win32-x64-0.3.0.zip",
    size: 123,
    sha256: "b".repeat(64),
  });
  // A payload exe name that disagrees with the filename prefix is refused, as
  // are values outside the two-name whitelist and anything carrying a path
  // separator.
  assert.throws(() => manifestFor("GravityPort-win32-x64-0.3.0.zip"), /artifact identity/);
  assert.throws(() => manifestFor("MOSA-win32-x64-0.3.0.zip", "Evil.exe"), /payload executable/);
  assert.throws(() => manifestFor("MOSA-win32-x64-0.3.0.zip", "../MOSA.exe"), /payload executable/);
  assert.throws(() => manifestFor("MOSA-win32-x64-0.3.0.zip", "sub/MOSA.exe"), /payload executable/);
  assert.throws(() => manifestFor("MOSA-win32-x64-0.3.0.zip", "sub\\MOSA.exe"), /payload executable/);
});

test("Windows production manifests pin a signer thumbprint and preview may omit it", () => {
  const manifestFor = (distribution, signerThumbprint) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "c".repeat(40),
      uiFingerprint: "d".repeat(64),
      runtimeFingerprint: "e".repeat(64),
      distribution,
    },
    platforms: {
      windows: {
        platform: "Windows",
        arch: "x64",
        file: "MOSA-win32-x64-0.3.0.zip",
        size: 123,
        sha256: "b".repeat(64),
        ...(signerThumbprint ? { signerThumbprint } : {}),
      },
    },
  });

  const production = manifestFor("production", "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34");
  assert.equal(production.buildIdentity.distribution, "production");
  assert.equal(production.windowsArtifact.signerThumbprint, "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34");
  assert.throws(() => manifestFor("production", ""), /signer thumbprint/);
  assert.throws(() => manifestFor("production", undefined), /signer thumbprint/);
  assert.throws(() => manifestFor("production", "nothex"), /signer thumbprint/);
  assert.throws(() => manifestFor("production", "Z".repeat(40)), /signer thumbprint/);
  assert.equal(manifestFor("preview", "").windowsArtifact.signerThumbprint, undefined);
  assert.equal(manifestFor("preview", "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34").windowsArtifact.signerThumbprint, "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34");
});

test("update manifest rejects a macOS artifact that is not bound to the release version", () => {
  assert.throws(() => parseUpdateManifest({
    version: "0.3.0",
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.2.9.zip",
        size: 123,
        sha256: "b".repeat(64),
      },
    },
  }), /artifact identity/);
});

test("macosUpdateArchForHost picks the manifest entry from the host architecture and Rosetta state", () => {
  assert.equal(macosUpdateArchForHost({ arch: "arm64", runningUnderARM64Translation: false }), "arm64");
  assert.equal(macosUpdateArchForHost({ arch: "arm64", runningUnderARM64Translation: true }), "arm64");
  // An Intel package running under Rosetta is an accidental Intel install on
  // an Apple-silicon Mac; its next update moves it back to the arm64 package.
  assert.equal(macosUpdateArchForHost({ arch: "x64", runningUnderARM64Translation: true }), "arm64");
  assert.equal(macosUpdateArchForHost({ arch: "x64", runningUnderARM64Translation: false }), "x64");
  assert.equal(macosUpdateArchForHost({ arch: "ia32", runningUnderARM64Translation: false }), null);
  assert.equal(macosUpdateArchForHost({}), null);
});

test("update manifests carry a separate macosX64 entry and an Intel host reads it", () => {
  const manifestFor = (macArch) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
      macosX64: {
        platform: "macOS",
        arch: "x64",
        file: "MOSA-darwin-x64-0.3.0.zip",
        size: 456,
        sha256: "e".repeat(64),
      },
    },
  }, { macArch });

  assert.deepEqual(manifestFor("arm64").macArtifact, {
    platform: "macOS",
    arch: "arm64",
    appName: "MOSA.app",
    file: "MOSA-darwin-arm64-0.3.0.zip",
    size: 123,
    sha256: "d".repeat(64),
  });
  assert.deepEqual(manifestFor("x64").macArtifact, {
    platform: "macOS",
    arch: "x64",
    appName: "MOSA.app",
    file: "MOSA-darwin-x64-0.3.0.zip",
    size: 456,
    sha256: "e".repeat(64),
  });
  // A GravityPort x64 entry reads back the same way under the other app name.
  const gravity = parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        appName: "GravityPort.app",
        file: "GravityPort-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
      macosX64: {
        platform: "macOS",
        arch: "x64",
        appName: "GravityPort.app",
        file: "GravityPort-darwin-x64-0.3.0.zip",
        size: 456,
        sha256: "e".repeat(64),
      },
    },
  }, { macArch: "x64" });
  assert.equal(gravity.macArtifact.file, "GravityPort-darwin-x64-0.3.0.zip");
  assert.equal(gravity.macArtifact.arch, "x64");
});

test("macosX64 entries are held to the x64 filename and architecture", () => {
  const manifestFor = (macosX64, macArch = "arm64") => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
      ...(macosX64 ? { macosX64 } : {}),
    },
  }, { macArch });

  // An arm64-named ZIP posing as the x64 package is refused.
  assert.throws(() => manifestFor({
    platform: "macOS",
    arch: "x64",
    file: "MOSA-darwin-arm64-0.3.0.zip",
    size: 456,
    sha256: "e".repeat(64),
  }), /artifact identity/);
  // So is an entry that claims the wrong architecture.
  assert.throws(() => manifestFor({
    platform: "macOS",
    arch: "arm64",
    file: "MOSA-darwin-x64-0.3.0.zip",
    size: 456,
    sha256: "e".repeat(64),
  }), /artifact identity/);
});

test("a broken macosX64 entry fails the whole manifest even for arm64 readers", () => {
  assert.throws(() => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
      macosX64: {
        platform: "macOS",
        arch: "x64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 456,
        sha256: "e".repeat(64),
      },
    },
  }, { macArch: "arm64" }), /artifact identity/);
  // Broken in a different way (bad digest) is caught the same way.
  assert.throws(() => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
      macosX64: {
        platform: "macOS",
        arch: "x64",
        file: "MOSA-darwin-x64-0.3.0.zip",
        size: 456,
        sha256: "zz".repeat(32),
      },
    },
  }, { macArch: "arm64" }), /digest/);
});

test("an Intel host without an Intel package in the manifest reports no update instead of erroring", () => {
  const release = parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
    },
  }, { macArch: "x64" });
  assert.equal(release.macArtifact, null);
  // A caller that passes no architecture keeps reading the arm64 entry.
  assert.equal(parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
    },
  }).macArtifact.file, "MOSA-darwin-arm64-0.3.0.zip");
});

test("production manifests pin the team identifier on both macOS architectures", () => {
  const manifestFor = (macosX64) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "production",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
        teamIdentifier: "B5ZJT8TRPN",
      },
      ...(macosX64 ? { macosX64 } : {}),
    },
  });
  assert.equal(manifestFor({
    platform: "macOS",
    arch: "x64",
    file: "MOSA-darwin-x64-0.3.0.zip",
    size: 456,
    sha256: "e".repeat(64),
    teamIdentifier: "B5ZJT8TRPN",
  }).macArtifact.teamIdentifier, "B5ZJT8TRPN");
  assert.throws(() => manifestFor({
    platform: "macOS",
    arch: "x64",
    file: "MOSA-darwin-x64-0.3.0.zip",
    size: 456,
    sha256: "e".repeat(64),
  }), /team identifier/);
});

test("same or older website versions never report an update", async () => {
  for (const version of ["0.2.0", "0.1.9"]) {
    const result = await checkForMosaUpdate({
      currentVersion: "0.2.0",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version }) }),
    });
    assert.equal(result.updateAvailable, false, version);
  }
});

test("trusted update checks reject a release feed whose signed metadata was changed", async () => {
  const keys = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(keys.publicKey);
  const signed = signReleaseManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file: "MOSA-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
      },
    },
  }, { privateKey: keys.privateKey, expectedTrust: trust });

  const accepted = await checkForMosaUpdate({
    currentVersion: "0.2.0",
    releaseManifestTrust: trust,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(signed) }),
  });
  assert.equal(accepted.latestVersion, "0.3.0");

  await assert.rejects(
    checkForMosaUpdate({
      currentVersion: "0.2.0",
      releaseManifestTrust: trust,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ...signed, version: "0.3.1" }),
      }),
    }),
    /signature verification failed/,
  );
});

test("distribution tracks stay isolated after legacy builds join preview", () => {
  assert.equal(canUpdateDistribution("development", "preview"), true);
  assert.equal(canUpdateDistribution("preview", "preview"), true);
  assert.equal(canUpdateDistribution("production", "production"), true);
  // The transition release intentionally bridges preview users into the later
  // Developer-ID-signed production channel; the manifest pins the team id.
  assert.equal(canUpdateDistribution("preview", "production"), true);
  assert.equal(canUpdateDistribution("production", "preview"), false);
});

test("macOS manifests accept both app names and bind the artifact filename to them", () => {
  const manifestFor = (file, extra = {}) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        file,
        size: 123,
        sha256: "d".repeat(64),
        ...extra,
      },
    },
  });

  assert.deepEqual(manifestFor("MOSA-darwin-arm64-0.3.0.zip").macArtifact, {
    platform: "macOS",
    arch: "arm64",
    appName: "MOSA.app",
    file: "MOSA-darwin-arm64-0.3.0.zip",
    size: 123,
    sha256: "d".repeat(64),
  });
  assert.deepEqual(manifestFor("GravityPort-darwin-arm64-0.3.0.zip", { appName: "GravityPort.app" }).macArtifact, {
    platform: "macOS",
    arch: "arm64",
    appName: "GravityPort.app",
    file: "GravityPort-darwin-arm64-0.3.0.zip",
    size: 123,
    sha256: "d".repeat(64),
  });
  // An appName that disagrees with the filename prefix is refused, as are
  // unknown names and names carrying path separators.
  assert.throws(() => manifestFor("GravityPort-darwin-arm64-0.3.0.zip"), /artifact identity/);
  assert.throws(() => manifestFor("MOSA-darwin-arm64-0.3.0.zip", { appName: "Evil.app" }), /app name/);
  assert.throws(() => manifestFor("MOSA-darwin-arm64-0.3.0.zip", { appName: "../Evil.app" }), /app name/);
  assert.throws(() => manifestFor("MOSA-darwin-arm64-0.3.0.zip", { appName: "sub/MOSA.app" }), /app name/);
});

test("macOS production manifests pin a team identifier and preview may omit it", () => {
  const manifestFor = (distribution, teamIdentifier) => parseUpdateManifest({
    version: "0.3.0",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution,
    },
    platforms: {
      macos: {
        platform: "macOS",
        arch: "arm64",
        appName: "GravityPort.app",
        file: "GravityPort-darwin-arm64-0.3.0.zip",
        size: 123,
        sha256: "d".repeat(64),
        ...(teamIdentifier ? { teamIdentifier } : {}),
      },
    },
  });

  const production = manifestFor("production", "ABCDEF1234");
  assert.equal(production.buildIdentity.distribution, "production");
  assert.equal(production.macArtifact.teamIdentifier, "ABCDEF1234");
  assert.throws(() => manifestFor("production", ""), /team identifier/);
  assert.throws(() => manifestFor("production", undefined), /team identifier/);
  assert.throws(() => manifestFor("production", "tooshort"), /team identifier/);
  assert.throws(() => manifestFor("production", "TOO_LONG_TEAM_ID"), /team identifier/);
  assert.equal(manifestFor("preview", "").macArtifact.teamIdentifier, undefined);
  assert.equal(manifestFor("preview", "ABCDEF1234").macArtifact.teamIdentifier, "ABCDEF1234");
});

test("in-app update install requires the packaged release manifest trust", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(publicKey);
  assert.equal(canInstallUpdateInApp(trust), true);
  assert.equal(canInstallUpdateInApp(null), false);
  assert.equal(canInstallUpdateInApp(undefined), false);
  assert.equal(canInstallUpdateInApp({}), false);
  assert.equal(canInstallUpdateInApp({ ...trust, keyId: "0".repeat(64) }), false);
});

test("desktop main refuses in-app installs and offers the download page without manifest trust", () => {
  const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('ipcMain.handle("download-and-install-update"'));
  const guard = handler.indexOf("canInstallUpdateInApp(expectedServiceIdentity.releaseManifestTrust)");
  assert.ok(guard > 0, "download-and-install-update must check the manifest trust");
  assert.ok(guard < handler.indexOf("downloadMacosUpdate("), "the trust check must run before any download");
  assert.match(source, /canInstallInApp: app\.isPackaged && canInstallUpdateInApp\(expectedServiceIdentity\.releaseManifestTrust\)/);
});

test("desktop main runs install preflight before any download and records the attempt only after the helper starts", () => {
  const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf('ipcMain.handle("download-and-install-update"'));
  const end = handler.indexOf('ipcMain.handle("', 10) > 0 ? handler.indexOf('ipcMain.handle("', 10) : handler.length;
  const body = handler.slice(0, end);
  const twice = body.indexOf("updateFailedTwiceResult(");
  assert.ok(twice > 0, "a version that failed twice is refused before download");
  assert.ok(twice < body.indexOf("downloadMacosUpdate("), "the failed-twice check runs before the macOS download");
  assert.ok(twice < body.indexOf("downloadWindowsUpdate("), "the failed-twice check runs before the Windows download");
  assert.ok(body.indexOf("preflightFreeSpace({") < body.indexOf("downloadMacosUpdate("), "download space is checked before the macOS download");
  assert.ok(body.indexOf("windowsInstallPreflight(installDir") < body.indexOf("downloadWindowsUpdate("), "Windows folder and MCP checks run before the Windows download");
  assert.ok(body.indexOf("launchMacosUpdateHelper(") < body.indexOf("recordUpdateAttempt({ userDataDir: desktopDataDir, version: release.latestVersion, platform: \"macos\" })"));
  assert.ok(body.indexOf("launchWindowsUpdateHelper(") < body.indexOf("platform: \"windows\""));
  assert.ok(body.indexOf("platform: \"windows\"") < body.indexOf("app.exit(0)", body.indexOf("launchWindowsUpdateHelper(")), "the Windows attempt is recorded before the App exits");
});
