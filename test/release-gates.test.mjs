import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { createReleaseManifestTrust, releaseManifestBackupTrustFromRepository } from "../lib/release-manifest-signature.mjs";
import { assertReleaseProvenance } from "../scripts/check-release-provenance.mjs";
import {
  assertMacosReleaseSignature,
  parseCodesignDetails,
  verifyMacosReleaseApp,
} from "../scripts/verify-macos-release.mjs";
import { assertWindowsReleaseSignature, verifyWindowsReleasePackage } from "../scripts/verify-windows-release.mjs";

const SHA = "a".repeat(40);
const IDENTITY = "Developer ID Application: Example Studio (TEAM123456)";
const RELEASE_TRUST = createReleaseManifestTrust(generateKeyPairSync("ed25519").publicKey);
const BACKUP_TRUST = releaseManifestBackupTrustFromRepository(new URL("..", import.meta.url).pathname);

test("release provenance requires clean, tagged, remotely reachable immutable source", () => {
  const base = {
    version: "0.2.1-rc.22",
    head: SHA,
    status: "",
    tags: ["v0.2.1-rc.22"],
    remoteBranches: ["origin/release/0.2.1-rc.22"],
    remoteTagSha: SHA,
    buildIdentity: {
      productVersion: "0.2.1-rc.22",
      gitSha: SHA,
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
      releaseManifestTrust: RELEASE_TRUST,
      releaseManifestBackupTrust: BACKUP_TRUST,
    },
  };
  assert.equal(assertReleaseProvenance(base).tag, "v0.2.1-rc.22");
  assert.equal(assertReleaseProvenance(base).distribution, "preview");
  assert.throws(() => assertReleaseProvenance({ ...base, status: " M app/app.mjs" }), /clean Git worktree/);
  assert.throws(() => assertReleaseProvenance({ ...base, tags: [] }), /immutable tag/);
  assert.throws(() => assertReleaseProvenance({ ...base, remoteBranches: [] }), /push it before building/);
  assert.throws(() => assertReleaseProvenance({ ...base, remoteTagSha: "d".repeat(40) }), /Remote release tag/);
  assert.throws(() => assertReleaseProvenance({ ...base, buildIdentity: { ...base.buildIdentity, gitSha: "d".repeat(40) } }), /does not match HEAD/);
});

test("macOS release signature rejects ad-hoc, wrong team, wrong identity, and non-hardened apps", () => {
  const details = parseCodesignDetails([
    "Identifier=com.azhuilab.mosa",
    "CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=10+7 location=embedded",
    `Authority=${IDENTITY}`,
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
    "TeamIdentifier=TEAM123456",
  ].join("\n"));
  assert.equal(assertMacosReleaseSignature(details, { teamId: "TEAM123456", identity: IDENTITY }), true);
  assert.throws(() => assertMacosReleaseSignature({ ...details, Signature: "adhoc" }, { teamId: "TEAM123456", identity: IDENTITY }), /ad-hoc/);
  assert.throws(() => assertMacosReleaseSignature({ ...details, TeamIdentifier: "OTHER" }, { teamId: "TEAM123456", identity: IDENTITY }), /TeamIdentifier/);
  assert.throws(() => assertMacosReleaseSignature({ ...details, authorities: ["Developer ID Application: Other (TEAM123456)"] }, { teamId: "TEAM123456", identity: IDENTITY }), /signing identity/);
  assert.throws(() => assertMacosReleaseSignature({ ...details, CodeDirectory: "flags=0x0(none)" }, { teamId: "TEAM123456", identity: IDENTITY }), /Hardened Runtime/);
});

test("macOS release verification staples first, then validates notarization and Gatekeeper", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return {
        stdout: "",
        stderr: [
          "Identifier=com.azhuilab.mosa",
          "CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=10+7 location=embedded",
          `Authority=${IDENTITY}`,
          "TeamIdentifier=TEAM123456",
        ].join("\n"),
      };
    }
    return { stdout: "", stderr: "" };
  };
  await verifyMacosReleaseApp({
    appPath: ".",
    env: { APPLE_TEAM_ID: "TEAM123456", MOSA_MACOS_SIGN_IDENTITY: IDENTITY },
    runner,
    staple: true,
  });
  assert.deepEqual(calls.map((call) => call.slice(0, 3)), [
    ["/usr/bin/codesign", "--verify", "--deep"],
    ["/usr/bin/codesign", "-dv", "--verbose=4"],
    ["/usr/bin/xcrun", "stapler", "staple"],
    ["/usr/bin/xcrun", "stapler", "validate"],
    ["/usr/sbin/spctl", "-a", "-vv"],
  ]);
});

test("macOS preview verification requires only a valid packaged code signature", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/usr/bin/codesign" && args[0] === "-dv") {
      return { stdout: "", stderr: "Identifier=com.azhuilab.mosa\nSignature=adhoc\n" };
    }
    return { stdout: "", stderr: "" };
  };
  const result = await verifyMacosReleaseApp({
    appPath: ".",
    env: {},
    runner,
    distribution: "preview",
  });
  assert.equal(result.distribution, "preview");
  assert.equal(result.bundleId, "com.azhuilab.mosa");
  assert.deepEqual(calls.map((call) => call[0]), ["/usr/bin/codesign", "/usr/bin/codesign"]);
});

test("Windows release signature requires a valid Authenticode signer pinned by thumbprint", () => {
  const thumbprint = "A".repeat(40);
  assert.equal(assertWindowsReleaseSignature({
    status: "Valid",
    thumbprint,
    subject: "CN=Example Studio",
  }, thumbprint), true);
  assert.throws(() => assertWindowsReleaseSignature({
    status: "NotSigned",
    thumbprint,
    subject: "CN=Example Studio",
  }, thumbprint), /Authenticode status/);
  assert.throws(() => assertWindowsReleaseSignature({
    status: "Valid",
    thumbprint: "B".repeat(40),
    subject: "CN=Other Studio",
  }, thumbprint), /does not match/);
});

test("Windows release verification covers every executable and native payload", async () => {
  const thumbprint = "A".repeat(40);
  let command = "";
  const result = await verifyWindowsReleasePackage({
    packageDir: ".",
    expectedThumbprint: thumbprint,
    powershell: async (value) => {
      command = value;
      return JSON.stringify([
        { path: "MOSA.exe", status: "Valid", thumbprint, subject: "CN=Example Studio" },
        { path: "resources\\app.asar.unpacked\\native.node", status: "Valid", thumbprint, subject: "CN=Example Studio" },
      ]);
    },
  });
  assert.equal(result.files, 2);
  assert.match(command, /\.exe/);
  assert.match(command, /\.dll/);
  assert.match(command, /\.node/);
});

test("release provenance refuses a build without the pinned backup manifest key", () => {
  const base = {
    version: "0.3.8",
    head: SHA,
    status: "",
    tags: ["v0.3.8"],
    remoteBranches: ["origin/release/0.3.8"],
    remoteTagSha: SHA,
    buildIdentity: {
      productVersion: "0.3.8",
      gitSha: SHA,
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
      distribution: "preview",
      releaseManifestTrust: RELEASE_TRUST,
    },
  };
  assert.throws(() => assertReleaseProvenance(base), /missing releaseManifestBackupTrust/);
  assert.throws(
    () => assertReleaseProvenance({ ...base, buildIdentity: { ...base.buildIdentity, releaseManifestBackupTrust: RELEASE_TRUST } }),
    /must carry key id/,
  );
  assert.equal(
    assertReleaseProvenance({ ...base, buildIdentity: { ...base.buildIdentity, releaseManifestBackupTrust: BACKUP_TRUST } }).tag,
    "v0.3.8",
  );
});
