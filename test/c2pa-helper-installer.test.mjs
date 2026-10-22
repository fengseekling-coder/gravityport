import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkForC2paHelperRelease,
  c2paHelperDownloadUrl,
  installC2paHelperPack,
  parseC2paHelperReleaseManifest,
} from "../desktop/c2pa-helper-installer.mjs";
import { MOSA_UPDATE_FEED_URL } from "../desktop/update-service.mjs";
import { createReleaseManifestTrust, signReleaseManifest } from "../lib/release-manifest-signature.mjs";
import { discoverC2paHelperPacks } from "../lib/c2pa-helper-pack.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makePack({ target = "darwin-arm64", version = "0.27.22" } = {}) {
  const executable = target === "win32-x64" ? "bin/c2patool.exe" : "bin/c2patool";
  const binary = Buffer.from(`binary-${version}-${target}`);
  const notice = Buffer.from("MIT OR Apache-2.0 notice\n");
  const files = [
    { path: executable, role: "executable", bytes: binary.length, sha256: sha256(binary) },
    { path: "THIRD_PARTY_NOTICE.txt", role: "notice", bytes: notice.length, sha256: sha256(notice) },
  ];
  const manifest = {
    schema: "mosa.c2pa-helper-pack/1",
    id: "c2patool",
    version,
    target,
    executable,
    upstream: `https://github.com/contentauth/c2pa-rs/releases/tag/c2patool-v${version}`,
    license: { id: "MIT OR Apache-2.0", source: "https://github.com/contentauth/c2pa-rs" },
    files,
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const payloads = new Map([
    ["helper-pack.json", manifestBytes],
    [executable, binary],
    ["THIRD_PARTY_NOTICE.txt", notice],
  ]);
  return {
    manifest,
    payloads,
    release: {
      version,
      target,
      platform: target === "win32-x64" ? "win32" : "darwin",
      arch: target === "win32-x64" ? "x64" : "arm64",
      total_size: files.reduce((sum, entry) => sum + entry.bytes, 0),
      manifest: { size: manifestBytes.length, sha256: sha256(manifestBytes) },
      license: { ...manifest.license },
    },
  };
}

function releaseDocument(pack) {
  return {
    helperPacks: {
      c2patool: {
        [pack.release.target]: {
          version: pack.release.version,
          totalSize: pack.release.total_size,
          manifest: pack.release.manifest,
          license: pack.release.license,
        },
      },
    },
  };
}

function fetchFor(pack, overrides = new Map()) {
  const responses = new Map();
  for (const [path, bytes] of pack.payloads) responses.set(c2paHelperDownloadUrl(pack.release, path), bytes);
  for (const [url, bytes] of overrides) responses.set(url, bytes);
  return async (url) => {
    const bytes = responses.get(String(url));
    if (!bytes) return new Response("missing", { status: 404 });
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.length) } });
  };
}

test("C2PA helper release metadata is platform-bound and uses only the first-party origin", () => {
  const pack = makePack({ target: "win32-x64" });
  const parsed = parseC2paHelperReleaseManifest(releaseDocument(pack), { platform: "win32", arch: "x64" });
  assert.equal(parsed.version, "0.27.22");
  assert.equal(parsed.target, "win32-x64");
  assert.equal(
    c2paHelperDownloadUrl(parsed, "bin/c2patool.exe"),
    "https://gravityport.azhuilab.com/downloads/helper-packs/c2patool/0.27.22/win32-x64/bin/c2patool.exe",
  );
  assert.throws(() => c2paHelperDownloadUrl(parsed, "../escape"), /path is invalid/i);
});

test("C2PA helper release check trusts only the signed MOSA release feed", async () => {
  const pack = makePack();
  const keys = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(keys.publicKey);
  const signed = signReleaseManifest(releaseDocument(pack), { privateKey: keys.privateKey, expectedTrust: trust });
  let requested = "";
  const result = await checkForC2paHelperRelease({
    platform: "darwin",
    arch: "arm64",
    releaseManifestTrust: trust,
    fetchImpl: async (url) => {
      requested = String(url);
      return new Response(JSON.stringify(signed), { status: 200 });
    },
  });
  assert.equal(requested, MOSA_UPDATE_FEED_URL);
  assert.equal(result.release.version, "0.27.22");
});

test("C2PA helper installer verifies pinned files and installs atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-install-"));
  const userDataDir = join(root, "userdata");
  const pack = makePack();
  const progress = [];
  try {
    const installed = await installC2paHelperPack({
      userDataDir,
      release: pack.release,
      fetchImpl: fetchFor(pack),
      statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
      onProgress: (value) => progress.push(value),
    });
    assert.equal(installed.version, "0.27.22");
    assert.match(installed.executable_path, /c2patool$/u);
    assert.equal(progress.at(-1)?.phase, "complete");
    const discovery = await discoverC2paHelperPacks({ userDataDir, platform: "darwin", arch: "arm64" });
    assert.equal(discovery.packs.length, 1);
    assert.equal(discovery.invalid.length, 0);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA helper installer preserves the previous pack when a replacement is tampered", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-helper-rollback-"));
  const userDataDir = join(root, "userdata");
  const oldPack = makePack({ version: "0.27.21" });
  const nextPack = makePack({ version: "0.27.22" });
  try {
    await installC2paHelperPack({
      userDataDir,
      release: oldPack.release,
      fetchImpl: fetchFor(oldPack),
      statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
    });
    const badUrl = c2paHelperDownloadUrl(nextPack.release, nextPack.manifest.executable);
    await assert.rejects(() => installC2paHelperPack({
      userDataDir,
      release: nextPack.release,
      fetchImpl: fetchFor(nextPack, new Map([[badUrl, Buffer.from("tampered")]])),
      statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
    }), /size does not match|SHA-256 verification failed/i);
    const discovery = await discoverC2paHelperPacks({ userDataDir, platform: "darwin", arch: "arm64" });
    assert.deepEqual(discovery.packs.map((entry) => entry.version), ["0.27.21"]);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
