import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseUpdateManifest } from "../desktop/update-service.mjs";
import {
  createReleaseManifestTrust,
  releaseManifestBackupTrustFromRepository,
  verifyReleaseManifestSignature,
} from "../lib/release-manifest-signature.mjs";
import { prepareDesktopReleaseManifest, resolveManifestNotes } from "../scripts/prepare-desktop-release-manifest.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

// The backup key is public and committed; only its public half is read here.
const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;

async function fixtureArtifacts(version) {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-manifest-"));
  const mac = join(root, `MOSA-darwin-arm64-${version}.zip`);
  const windows = join(root, `MOSA-win32-x64-${version}.zip`);
  await writeFile(mac, `mac-${version}`);
  await writeFile(windows, `windows-${version}`);
  return { root, mac, windows };
}

const RELEASE_KEYS = generateKeyPairSync("ed25519");
const RELEASE_TRUST = createReleaseManifestTrust(RELEASE_KEYS.publicKey);
const BACKUP_TRUST = releaseManifestBackupTrustFromRepository(REPOSITORY_ROOT);

function buildIdentity(version) {
  return {
    productVersion: version,
    gitSha: "a".repeat(40),
    uiFingerprint: "b".repeat(64),
    runtimeFingerprint: "c".repeat(64),
    distribution: "preview",
    releaseManifestTrust: RELEASE_TRUST,
    releaseManifestBackupTrust: BACKUP_TRUST,
  };
}

function signingOptions(version) {
  return {
    buildIdentity: buildIdentity(version),
    signingPrivateKey: RELEASE_KEYS.privateKey,
  };
}

test("release manifest emits only unified platforms schema and drops legacy Visual Packs", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      ...signingOptions(version),
      previousManifest: {
        version: "0.2.1-rc.15",
        artifacts: { mac: { url: "legacy" }, windows: { url: "legacy" } },
        platforms: { windows: { file: "MOSA-win32-x64-0.2.1-rc.15.zip" } },
        visualPacks: {
          "darwin-arm64": {
            id: "siglip2-base-patch16-224",
            revision: "model-revision",
            totalSize: 123,
            manifest: { size: 42, sha256: "a".repeat(64) },
            license: { id: "apache-2.0", source: "https://example.com/license" },
          },
        },
      },
      publishedAt: "2026-09-19T01:00:00Z",
      notes: { zh: "rc.16", en: "rc.16" },
    });
    assert.equal(result.version, version);
    assert.deepEqual(result.build, {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
    });
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    assert.deepEqual(Object.keys(result.platforms), ["macos"]);
    assert.equal("artifacts" in result, false);
    assert.equal("visualPacks" in result, false);
    assert.equal(result.platforms.macos.file, `MOSA-darwin-arm64-${version}.zip`);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.file, result.platforms.macos.file);
    assert.equal(parsed.windowsArtifact, null);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest includes Windows only when a same-version real artifact is supplied", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      windowsArtifactPath: files.windows,
      ...signingOptions(version),
      publishedAt: "2026-09-19T01:00:00Z",
      notes: { zh: "rc.16 中文说明", en: "rc.16 English notes" },
    });
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.file, `MOSA-darwin-arm64-${version}.zip`);
    assert.equal(parsed.windowsArtifact.file, `MOSA-win32-x64-${version}.zip`);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest refuses stale artifact versions instead of publishing a mixed-version feed", async () => {
  const files = await fixtureArtifacts("0.2.1-rc.15");
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version: "0.2.1-rc.16",
        macArtifactPath: files.mac,
        ...signingOptions("0.2.1-rc.16"),
        publishedAt: "2026-09-19T01:00:00Z",
      }),
      /filename must be MOSA-darwin-arm64-0\.2\.1-rc\.16\.zip/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest requires explicit bilingual notes and never inherits previous release notes", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  const previousManifest = {
    version: "0.2.1-rc.15",
    notes: { zh: "旧版中文说明", en: "Previous English notes" },
  };
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "新版本中文说明", en: "   " },
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        previousManifest,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "   ", en: "New release English notes" },
      }),
      /notes\.zh and notes\.en must both be non-empty/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest refuses missing or mismatched build identity", async () => {
  const version = "0.2.1-rc.16";
  const files = await fixtureArtifacts(version);
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /build identity is required/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions("0.2.1-rc.15"),
        publishedAt: "2026-09-19T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /does not match/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest writes the GravityPort app name and its bound artifact filename", async () => {
  const version = "0.3.0";
  const files = await fixtureArtifacts(version);
  const mac = join(files.root, `GravityPort-darwin-arm64-${version}.zip`);
  await writeFile(mac, `mac-gravityport-${version}`);
  try {
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: mac,
      macAppName: "GravityPort.app",
      ...signingOptions(version),
      publishedAt: "2026-10-09T01:00:00Z",
      notes: { zh: "说明", en: "Notes" },
    });
    assert.equal(result.platforms.macos.appName, "GravityPort.app");
    assert.equal(result.platforms.macos.file, `GravityPort-darwin-arm64-${version}.zip`);
    assert.equal(result.platforms.macos.teamIdentifier, undefined);
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.appName, "GravityPort.app");
    assert.equal(parsed.macArtifact.file, `GravityPort-darwin-arm64-${version}.zip`);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest requires and pins the production team identifier", async () => {
  const version = "0.3.0";
  const files = await fixtureArtifacts(version);
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        ...signingOptions(version),
        // build identity flipped to production for this call
        buildIdentity: { ...buildIdentity(version), distribution: "production" },
        signingPrivateKey: RELEASE_KEYS.privateKey,
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /teamIdentifier/,
    );
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      macTeamIdentifier: "abcd1234ef",
      buildIdentity: { ...buildIdentity(version), distribution: "production" },
      signingPrivateKey: RELEASE_KEYS.privateKey,
      publishedAt: "2026-10-09T01:00:00Z",
      notes: { zh: "说明", en: "Notes" },
    });
    assert.equal(result.platforms.macos.teamIdentifier, "ABCD1234EF");
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.macArtifact.teamIdentifier, "ABCD1234EF");
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        macTeamIdentifier: "bad-team",
        buildIdentity: { ...buildIdentity(version), distribution: "production" },
        signingPrivateKey: RELEASE_KEYS.privateKey,
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /teamIdentifier is invalid/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        macAppName: "Evil.app",
        ...signingOptions(version),
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /Invalid macOS release app name/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest writes the Windows payload exe name and its bound artifact filename", async () => {
  const version = "0.3.0";
  const files = await fixtureArtifacts(version);
  const windows = join(files.root, `GravityPort-win32-x64-${version}.zip`);
  await writeFile(windows, `windows-gravityport-${version}`);
  try {
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      windowsArtifactPath: windows,
      windowsPayloadExeName: "GravityPort.exe",
      ...signingOptions(version),
      publishedAt: "2026-10-09T01:00:00Z",
      notes: { zh: "说明", en: "Notes" },
    });
    assert.equal(result.platforms.windows.payloadExeName, "GravityPort.exe");
    assert.equal(result.platforms.windows.file, `GravityPort-win32-x64-${version}.zip`);
    assert.equal(result.platforms.windows.signerThumbprint, undefined);
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.windowsArtifact.payloadExeName, "GravityPort.exe");
    assert.equal(parsed.windowsArtifact.file, `GravityPort-win32-x64-${version}.zip`);
    // A payload exe name outside the whitelist is refused, and the bound
    // filename is derived from the payload name, so a MOSA-named zip cannot
    // ride along with a GravityPort declaration.
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        windowsArtifactPath: windows,
        windowsPayloadExeName: "Evil.exe",
        ...signingOptions(version),
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /Invalid Windows release payload executable name/,
    );
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        windowsArtifactPath: files.windows,
        windowsPayloadExeName: "GravityPort.exe",
        ...signingOptions(version),
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /filename must be GravityPort-win32-x64-0\.3\.0\.zip/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest lists the Windows installer beside the update ZIP it ships with", async () => {
  const version = "0.3.4";
  const files = await fixtureArtifacts(version);
  const windows = join(files.root, `GravityPort-win32-x64-${version}.zip`);
  const installer = join(files.root, `GravityPort-win32-x64-${version}.exe`);
  const installerBytes = `MZ installer ${version}`;
  await writeFile(windows, `windows-gravityport-${version}`);
  await writeFile(installer, installerBytes);
  const release = {
    version,
    macArtifactPath: files.mac,
    windowsPayloadExeName: "GravityPort.exe",
    ...signingOptions(version),
    publishedAt: "2026-10-22T01:00:00Z",
    notes: { zh: "说明", en: "Notes" },
  };
  try {
    const result = await prepareDesktopReleaseManifest({ ...release, windowsArtifactPath: windows, windowsInstallerPath: installer });
    assert.deepEqual(result.platforms.windows.installer, {
      file: `GravityPort-win32-x64-${version}.exe`,
      size: Buffer.byteLength(installerBytes),
      sha256: createHash("sha256").update(installerBytes).digest("hex"),
    });
    assert.equal(result.platforms.windows.file, `GravityPort-win32-x64-${version}.zip`);
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true, "the signature covers the installer entry");
    // Installed apps keep updating from the ZIP; the installer is for the website.
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.windowsArtifact.file, `GravityPort-win32-x64-${version}.zip`);
    assert.equal(parsed.windowsArtifact.installer, undefined);

    const withoutInstaller = await prepareDesktopReleaseManifest({ ...release, windowsArtifactPath: windows });
    assert.equal(Object.hasOwn(withoutInstaller.platforms.windows, "installer"), false);

    await assert.rejects(
      prepareDesktopReleaseManifest({ ...release, windowsInstallerPath: installer }),
      /A Windows installer ships with its update ZIP/,
    );
    // The installer name follows the payload exe name, like the ZIP.
    const misnamed = join(files.root, `MOSA-win32-x64-${version}.exe`);
    await writeFile(misnamed, installerBytes);
    await assert.rejects(
      prepareDesktopReleaseManifest({ ...release, windowsArtifactPath: windows, windowsInstallerPath: misnamed }),
      /filename must be GravityPort-win32-x64-0\.3\.4\.exe/,
    );
    const empty = join(files.root, "empty", `GravityPort-win32-x64-${version}.exe`);
    await mkdir(join(files.root, "empty"));
    await writeFile(empty, "");
    await assert.rejects(
      prepareDesktopReleaseManifest({ ...release, windowsArtifactPath: windows, windowsInstallerPath: empty }),
      /missing or empty/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

test("release manifest requires and pins the production Windows signer thumbprint", async () => {
  const version = "0.3.0";
  const files = await fixtureArtifacts(version);
  try {
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        macTeamIdentifier: "ABCD1234EF",
        windowsArtifactPath: files.windows,
        buildIdentity: { ...buildIdentity(version), distribution: "production" },
        signingPrivateKey: RELEASE_KEYS.privateKey,
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /platforms\.windows signerThumbprint/,
    );
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      macTeamIdentifier: "ABCD1234EF",
      windowsArtifactPath: files.windows,
      windowsSignerThumbprint: "ab12cd34ab12cd34ab12cd34ab12cd34ab12cd34",
      buildIdentity: { ...buildIdentity(version), distribution: "production" },
      signingPrivateKey: RELEASE_KEYS.privateKey,
      publishedAt: "2026-10-09T01:00:00Z",
      notes: { zh: "说明", en: "Notes" },
    });
    assert.equal(result.platforms.windows.signerThumbprint, "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34");
    assert.equal(verifyReleaseManifestSignature(result, RELEASE_TRUST), true);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.windowsArtifact.signerThumbprint, "AB12CD34AB12CD34AB12CD34AB12CD34AB12CD34");
    await assert.rejects(
      prepareDesktopReleaseManifest({
        version,
        macArtifactPath: files.mac,
        macTeamIdentifier: "ABCD1234EF",
        windowsArtifactPath: files.windows,
        windowsSignerThumbprint: "bad-thumbprint",
        buildIdentity: { ...buildIdentity(version), distribution: "production" },
        signingPrivateKey: RELEASE_KEYS.privateKey,
        publishedAt: "2026-10-09T01:00:00Z",
        notes: { zh: "说明", en: "Notes" },
      }),
      /signerThumbprint is invalid/,
    );
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Notes from release-notes.json (task 164)
// ---------------------------------------------------------------------------

test("resolveManifestNotes fills missing languages from release-notes.json, one bullet per sentence", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-notes-source-"));
  try {
    const sourcePath = join(root, "release-notes.json");
    await writeFile(sourcePath, JSON.stringify({
      schema: 2,
      unreleased: { zh: ["占位"], en: ["Placeholder"] },
      releases: [
        { version: "0.4.0", date: "2026-10-17", zh: ["第一条说明", "第二条说明"], en: ["First note", "Second note"] },
      ],
    }), "utf8");
    assert.deepEqual(
      resolveManifestNotes({ version: "0.4.0", releaseNotesPath: sourcePath }),
      { zh: "• 第一条说明\n• 第二条说明", en: "• First note\n• Second note" },
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("resolveManifestNotes prefixes sectioned entries so old App versions read the flat list", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-notes-source-"));
  try {
    const sourcePath = join(root, "release-notes.json");
    await writeFile(sourcePath, JSON.stringify({
      schema: 2,
      unreleased: { zh: ["占位"], en: ["Placeholder"] },
      releases: [
        { version: "0.4.0", date: "2026-10-17", zh: { new: ["第一条"], fixed: ["修复条"] }, en: { new: ["First note"], fixed: ["Fixed note"] } },
      ],
    }), "utf8");
    assert.deepEqual(
      resolveManifestNotes({ version: "0.4.0", releaseNotesPath: sourcePath }),
      { zh: "• 新增：第一条\n• 修复：修复条", en: "• New: First note\n• Fixed: Fixed note" },
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("resolveManifestNotes prefers explicit CLI notes and never reads the file for them", async () => {
  assert.deepEqual(
    resolveManifestNotes({ notesZh: "手写中文", notesEn: "Handwritten English", version: "9.9.9", releaseNotesPath: join(tmpdir(), "mosa-no-such-release-notes.json") }),
    { zh: "手写中文", en: "Handwritten English" },
  );
});

test("resolveManifestNotes fails with the gate error when the version has no entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-release-notes-source-"));
  try {
    const sourcePath = join(root, "release-notes.json");
    await writeFile(sourcePath, JSON.stringify({
      schema: 2,
      unreleased: { zh: ["占位"], en: ["Placeholder"] },
      releases: [{ version: "0.4.0", date: "2026-10-17", zh: ["说明"], en: ["Note"] }],
    }), "utf8");
    assert.throws(
      () => resolveManifestNotes({ version: "0.5.0", releaseNotesPath: sourcePath }),
      /release-notes\.json 缺少 0\.5\.0 的更新说明/,
    );
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("release manifest keeps 2500-character notes intact on write and on parse", async () => {
  const version = "0.2.1-rc.34";
  const files = await fixtureArtifacts(version);
  const zh = "中文更新说明。".repeat(400).slice(0, 2500);
  const en = "Long release note. ".repeat(200).slice(0, 2500);
  try {
    assert.equal(zh.length, 2500);
    assert.equal(en.length, 2500);
    const result = await prepareDesktopReleaseManifest({
      version,
      macArtifactPath: files.mac,
      ...signingOptions(version),
      publishedAt: "2026-10-17T01:00:00Z",
      notes: { zh, en },
    });
    assert.equal(result.notes.zh, zh);
    assert.equal(result.notes.en, en);
    const parsed = parseUpdateManifest(result);
    assert.equal(parsed.notes.zh, zh);
    assert.equal(parsed.notes.en, en);
  } finally {
    await removeTestPath(files.root, { recursive: true, force: true });
  }
});
