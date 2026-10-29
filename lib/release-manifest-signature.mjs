import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_MANIFEST_SIGNATURE_ALGORITHM = "ed25519";
export const RELEASE_MANIFEST_BACKUP_KEY_ID = "3f5eb959cc022cfe8a532fb9dc17b44bdd46b243778943a3dacf728c83f1f5ec";
export const RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH = "scripts/release-keys/release-manifest-backup-public.pem";
const KEY_ID_PATTERN = /^[0-9a-f]{64}$/;

function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Release manifest contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new Error("Release manifest contains an unsupported JSON value.");
}

function asEd25519PublicKey(value) {
  const key = value?.type === "public" ? value : createPublicKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release manifest public key must be Ed25519.");
  return key;
}

function asEd25519PrivateKey(value) {
  const key = value?.type === "private" ? value : createPrivateKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release manifest private key must be Ed25519.");
  return key;
}

function publicKeyIdentity(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}

function publicKeyPem(publicKey) {
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

export function createReleaseManifestTrust(publicKeyInput) {
  if (!publicKeyInput) throw new Error("Release manifest public key is required.");
  const publicKey = asEd25519PublicKey(publicKeyInput);
  return Object.freeze({
    algorithm: RELEASE_MANIFEST_SIGNATURE_ALGORITHM,
    keyId: publicKeyIdentity(publicKey),
    publicKeyPem: publicKeyPem(publicKey),
  });
}

export function normalizeReleaseManifestTrust(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release manifest trust metadata is missing.");
  }
  if (String(value.algorithm || "").toLowerCase() !== RELEASE_MANIFEST_SIGNATURE_ALGORITHM) {
    throw new Error("Release manifest trust algorithm must be Ed25519.");
  }
  const expectedKeyId = String(value.keyId || "").trim().toLowerCase();
  if (!KEY_ID_PATTERN.test(expectedKeyId)) throw new Error("Release manifest trust key id is invalid.");
  const normalized = createReleaseManifestTrust(String(value.publicKeyPem || ""));
  if (normalized.keyId !== expectedKeyId) throw new Error("Release manifest public key does not match its key id.");
  return normalized;
}

/**
 * Builds the set of trusted release-manifest keys: the primary key plus the
 * offline backup key. Empty entries are skipped; duplicates (same keyId) collapse.
 */
export function releaseManifestTrustSet(...trusts) {
  const byKeyId = new Map();
  for (const trust of trusts) {
    if (!trust) continue;
    const normalized = normalizeReleaseManifestTrust(trust);
    if (!byKeyId.has(normalized.keyId)) byKeyId.set(normalized.keyId, normalized);
  }
  return [...byKeyId.values()];
}

/**
 * Reads the backup public key committed to the repository and checks that its
 * keyId is the one this build expects. Throws if the file was swapped.
 */
export function releaseManifestBackupTrustFromRepository(rootDir) {
  const trust = createReleaseManifestTrust(readFileSync(join(rootDir, RELEASE_MANIFEST_BACKUP_PUBLIC_KEY_PATH), "utf8"));
  if (trust.keyId !== RELEASE_MANIFEST_BACKUP_KEY_ID) {
    throw new Error(`Release manifest backup public key id ${trust.keyId} does not match the expected ${RELEASE_MANIFEST_BACKUP_KEY_ID}.`);
  }
  return trust;
}

export function releaseManifestSigningBytes(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Release manifest must be a JSON object.");
  }
  const unsigned = { ...manifest };
  delete unsigned.signature;
  return Buffer.from(canonicalJson(unsigned), "utf8");
}

export function signReleaseManifest(manifest, { privateKey, expectedTrust = null } = {}) {
  const signer = asEd25519PrivateKey(privateKey);
  const trust = createReleaseManifestTrust(createPublicKey(signer));
  if (expectedTrust) {
    const expected = (Array.isArray(expectedTrust) ? expectedTrust : [expectedTrust]).map(normalizeReleaseManifestTrust);
    if (!expected.some((item) => item.keyId === trust.keyId)) {
      const keyIds = expected.map((item) => item.keyId).join(", ");
      throw new Error(`Release manifest signing key ${trust.keyId} does not match packaged trust key ${keyIds}.`);
    }
  }
  const signature = cryptoSign(null, releaseManifestSigningBytes(manifest), signer).toString("base64url");
  return {
    ...manifest,
    signature: {
      algorithm: RELEASE_MANIFEST_SIGNATURE_ALGORITHM,
      keyId: trust.keyId,
      value: signature,
    },
  };
}

/**
 * Verifies a signed manifest against one trusted key or a list of trusted keys.
 * The key is picked by the signature's keyId; a keyId outside the list is rejected.
 */
export function verifyReleaseManifestSignature(manifest, trustInput) {
  const trusts = (Array.isArray(trustInput) ? trustInput : [trustInput]).map(normalizeReleaseManifestTrust);
  const signature = manifest?.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
    throw new Error("Release manifest signature is missing.");
  }
  if (String(signature.algorithm || "").toLowerCase() !== RELEASE_MANIFEST_SIGNATURE_ALGORITHM) {
    throw new Error("Release manifest signature algorithm is invalid.");
  }
  const keyId = String(signature.keyId || "").trim().toLowerCase();
  const trust = trusts.find((item) => item.keyId === keyId);
  if (!trust) throw new Error("Release manifest signature key is not trusted by this GravityPort build.");
  const encoded = String(signature.value || "").trim();
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(encoded)) throw new Error("Release manifest signature value is invalid.");
  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64url");
  } catch {
    throw new Error("Release manifest signature value is invalid.");
  }
  if (bytes.length !== 64) throw new Error("Release manifest signature value is invalid.");
  const publicKey = asEd25519PublicKey(trust.publicKeyPem);
  if (!cryptoVerify(null, releaseManifestSigningBytes(manifest), publicKey, bytes)) {
    throw new Error("Release manifest signature verification failed.");
  }
  return true;
}

export function releaseManifestTrustFromEnvironment(env = process.env) {
  const inline = String(env.MOSA_RELEASE_MANIFEST_PUBLIC_KEY || "").trim();
  const file = String(env.MOSA_RELEASE_MANIFEST_PUBLIC_KEY_FILE || "").trim();
  if (inline && file) throw new Error("Configure only one release manifest public-key source.");
  if (!inline && !file) return null;
  return createReleaseManifestTrust(inline || readFileSync(file, "utf8"));
}

export function releaseManifestPrivateKeyFromEnvironment(env = process.env) {
  const inline = String(env.MOSA_RELEASE_MANIFEST_PRIVATE_KEY || "").trim();
  const file = String(env.MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE || "").trim();
  if (inline && file) throw new Error("Configure only one release manifest private-key source.");
  if (!inline && !file) throw new Error(
    "Release manifest signing requires MOSA_RELEASE_MANIFEST_PRIVATE_KEY or MOSA_RELEASE_MANIFEST_PRIVATE_KEY_FILE.",
  );
  return inline || readFileSync(file, "utf8");
}
