import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_MANIFEST_BACKUP_KEY_ID,
  RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH,
  createReleaseManifestTrust,
  releaseManifestBackupTrustFromRepository,
  releaseManifestTrustSet,
  signReleaseManifest,
  verifyReleaseManifestSignature,
} from "../lib/release-manifest-signature.mjs";

test("release manifest signatures bind every published field to a pinned Ed25519 key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(publicKey);
  const manifest = signReleaseManifest({
    version: "0.2.1-rc.23",
    build: {
      gitSha: "a".repeat(40),
      uiFingerprint: "b".repeat(64),
      runtimeFingerprint: "c".repeat(64),
    },
    platforms: {
      macos: { file: "MOSA-darwin-arm64-0.2.1-rc.23.zip", size: 123, sha256: "d".repeat(64) },
    },
  }, { privateKey, expectedTrust: trust });

  assert.equal(manifest.signature.algorithm, "ed25519");
  assert.equal(manifest.signature.keyId, trust.keyId);
  assert.equal(verifyReleaseManifestSignature(manifest, trust), true);
  assert.throws(
    () => verifyReleaseManifestSignature({ ...manifest, version: "0.2.1-rc.24" }, trust),
    /verification failed/,
  );
});

test("release manifest signatures reject an untrusted signing key", () => {
  const trusted = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(trusted.publicKey);
  assert.throws(
    () => signReleaseManifest({ version: "0.2.1-rc.23" }, {
      privateKey: attacker.privateKey,
      expectedTrust: trust,
    }),
    /does not match packaged trust key/,
  );
});

test("release manifest verification accepts the primary or backup key and refuses any other", () => {
  const primary = generateKeyPairSync("ed25519");
  const backup = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  const primaryTrust = createReleaseManifestTrust(primary.publicKey);
  const backupTrust = createReleaseManifestTrust(backup.publicKey);
  const group = releaseManifestTrustSet(primaryTrust, backupTrust);
  const unsigned = { version: "0.3.8", build: { gitSha: "a".repeat(40) } };

  const byPrimary = signReleaseManifest(unsigned, { privateKey: primary.privateKey });
  const byBackup = signReleaseManifest(unsigned, { privateKey: backup.privateKey });
  const byOutsider = signReleaseManifest(unsigned, { privateKey: outsider.privateKey });

  assert.equal(verifyReleaseManifestSignature(byPrimary, group), true);
  assert.equal(verifyReleaseManifestSignature(byBackup, group), true);
  assert.throws(() => verifyReleaseManifestSignature(byOutsider, group), /not trusted by this GravityPort build/);
  // A single-key trust (the pre-backup shape) must still refuse a backup-signed manifest.
  assert.throws(() => verifyReleaseManifestSignature(byBackup, primaryTrust), /not trusted by this GravityPort build/);
  assert.equal(verifyReleaseManifestSignature(byPrimary, primaryTrust), true);
  assert.throws(() => verifyReleaseManifestSignature({ ...byBackup, version: "0.3.9" }, group), /verification failed/);
  assert.throws(() => verifyReleaseManifestSignature(byBackup, []), /not trusted by this GravityPort build/);
});

test("release manifest signing accepts a backup key only when it is in the pinned trust set", () => {
  const primary = generateKeyPairSync("ed25519");
  const backup = generateKeyPairSync("ed25519");
  const outsider = generateKeyPairSync("ed25519");
  const group = releaseManifestTrustSet(
    createReleaseManifestTrust(primary.publicKey),
    createReleaseManifestTrust(backup.publicKey),
  );
  const unsigned = { version: "0.3.8" };

  const signed = signReleaseManifest(unsigned, { privateKey: backup.privateKey, expectedTrust: group });
  assert.equal(verifyReleaseManifestSignature(signed, group), true);
  assert.throws(
    () => signReleaseManifest(unsigned, { privateKey: outsider.privateKey, expectedTrust: group }),
    /does not match packaged trust key/,
  );
});

test("release manifest trust set drops empty entries and collapses duplicate keys", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(publicKey);
  assert.equal(releaseManifestTrustSet(trust, null, undefined, trust).length, 1);
  assert.deepEqual(releaseManifestTrustSet(null, undefined), []);
});

test("the committed backup public key is the pinned backup key id", async () => {
  const repositoryRoot = new URL("..", import.meta.url).pathname;
  assert.equal(releaseManifestBackupTrustFromRepository(repositoryRoot).keyId, RELEASE_MANIFEST_BACKUP_KEY_ID);

  const swappedRoot = await mkdtemp(join(tmpdir(), "mosa-backup-key-swap-"));
  try {
    await mkdir(join(swappedRoot, "scripts", "release-keys"), { recursive: true });
    const otherPem = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    await writeFile(join(swappedRoot, RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH), otherPem, "utf8");
    assert.throws(() => releaseManifestBackupTrustFromRepository(swappedRoot), /does not match the expected/);
  } finally {
    await rm(swappedRoot, { recursive: true, force: true });
  }
});
