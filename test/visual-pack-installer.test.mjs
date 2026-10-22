import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  checkForVisualPackRelease,
  cleanupVisualPackStaging,
  installVisualPack,
  parseVisualPackReleaseManifest,
  removeVisualPack,
  visualPackDownloadUrl,
  visualPackTarget,
} from "../desktop/visual-pack-installer.mjs";
import { MOSA_UPDATE_FEED_URL } from "../desktop/update-service.mjs";
import { createReleaseManifestTrust, signReleaseManifest } from "../lib/release-manifest-signature.mjs";
import { discoverVisualModelPacks } from "../lib/visual-model-pack.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const target = visualPackTarget();

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function runtimeTargetParts() {
  if (target === "darwin-arm64") return { platform: "darwin", arch: "arm64", library: "libonnxruntime.1.30.0.dylib" };
  if (target === "win32-x64") return { platform: "win32", arch: "x64", library: "onnxruntime.dll" };
  return null;
}

function makePack(revision = "r1") {
  const runtime = runtimeTargetParts();
  if (!runtime) return null;
  const payloads = new Map([
    ["model/model.bin", Buffer.from(`model-${revision}`)],
    ["tokenizer/tokenizer.json", Buffer.from('{"version":"1.0"}')],
    ["runtime/node_modules/onnxruntime-node/package.json", Buffer.from('{"name":"onnxruntime-node","version":"1.30.0","main":"dist/index.js"}')],
    ["runtime/node_modules/onnxruntime-node/dist/index.js", Buffer.from("module.exports = {};\n")],
    ["runtime/node_modules/onnxruntime-common/package.json", Buffer.from('{"name":"onnxruntime-common","version":"1.30.0","main":"dist/cjs/index.js"}')],
    ["runtime/node_modules/onnxruntime-common/dist/cjs/index.js", Buffer.from("module.exports = {};\n")],
    ["runtime/node_modules/@huggingface/tokenizers/package.json", Buffer.from('{"name":"@huggingface/tokenizers","version":"0.2.0","main":"dist/tokenizers.cjs"}')],
    ["runtime/node_modules/@huggingface/tokenizers/dist/tokenizers.cjs", Buffer.from("exports.Tokenizer = class {};\n")],
    [`runtime/node_modules/onnxruntime-node/bin/napi-v6/${runtime.platform}/${runtime.arch}/onnxruntime_binding.node`, Buffer.from("native-binding")],
    [`runtime/node_modules/onnxruntime-node/bin/napi-v6/${runtime.platform}/${runtime.arch}/${runtime.library}`, Buffer.from("native-runtime")],
  ]);
  const files = [...payloads.entries()].map(([path, data]) => ({
    path,
    role: path === "model/model.bin" ? "model" : path === "tokenizer/tokenizer.json" ? "tokenizer" : path.includes("/bin/") ? "runtime-native" : "runtime-js",
    bytes: data.length,
    sha256: sha256(data),
  }));
  const manifest = {
    schema: "mosa.visual-model-pack/1",
    id: "siglip2-test",
    revision,
    model_type: "image-text-embedding",
    embedding_dimension: 768,
    license: {
      id: "apache-2.0",
      source: "https://example.invalid/license",
      commercial_product_use: true,
    },
    preprocessing: { image_size: 224, max_text_tokens: 64 },
    runtime: {
      provider: "onnxruntime-node",
      version: "1.30.0",
      tokenizer_version: "0.2.0",
      platform: runtime.platform,
      arch: runtime.arch,
      root: "runtime",
    },
    files,
  };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  payloads.set("model-pack.json", manifestData);
  return {
    manifest,
    payloads,
    release: {
      id: manifest.id,
      revision,
      platform: runtime.platform,
      arch: runtime.arch,
      target,
      total_size: files.reduce((sum, file) => sum + file.bytes, 0),
      manifest: { size: manifestData.length, sha256: sha256(manifestData) },
      license: { id: manifest.license.id, source: manifest.license.source },
    },
  };
}

function releaseDocument(pack) {
  return {
    visualPacks: {
      [target]: {
        id: pack.release.id,
        revision: pack.release.revision,
        totalSize: pack.release.total_size,
        manifest: { ...pack.release.manifest },
        license: { ...pack.release.license },
      },
    },
  };
}

function fetchForPack(pack, overrides = new Map()) {
  const responses = new Map();
  for (const [path, data] of pack.payloads) responses.set(visualPackDownloadUrl(pack.release, path), data);
  for (const [url, data] of overrides) responses.set(url, data);
  return async (url) => {
    const data = responses.get(String(url));
    if (!data) return new Response("missing", { status: 404 });
    return new Response(data, { status: 200, headers: { "content-length": String(data.length) } });
  };
}

test("Visual Pack release metadata is platform-bound and uses the fixed first-party origin", { skip: !target }, () => {
  const pack = makePack();
  const parsed = parseVisualPackReleaseManifest(releaseDocument(pack), {
    platform: pack.release.platform,
    arch: pack.release.arch,
  });
  assert.equal(parsed.target, target);
  assert.equal(parsed.id, "siglip2-test");
  assert.equal(parsed.total_size, pack.release.total_size);
  assert.equal(
    visualPackDownloadUrl(parsed, "runtime/node_modules/onnxruntime-node/package.json"),
    `https://gravityport.azhuilab.com/downloads/visual-packs/siglip2-test/r1/${target}/runtime/node_modules/onnxruntime-node/package.json`,
  );
  assert.throws(() => visualPackDownloadUrl(parsed, "../escape"), /path is invalid/);
});

test("Visual Pack release checks use only the fixed first-party release feed", { skip: !target }, async () => {
  const pack = makePack();
  const keys = generateKeyPairSync("ed25519");
  const trust = createReleaseManifestTrust(keys.publicKey);
  const signedRelease = signReleaseManifest(releaseDocument(pack), {
    privateKey: keys.privateKey,
    expectedTrust: trust,
  });
  let requestedUrl = "";
  let requestedOptions = null;
  const result = await checkForVisualPackRelease({
    platform: pack.release.platform,
    arch: pack.release.arch,
    releaseManifestTrust: trust,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedOptions = options;
      return new Response(JSON.stringify(signedRelease), { status: 200 });
    },
  });
  assert.equal(requestedUrl, MOSA_UPDATE_FEED_URL);
  assert.equal(requestedOptions.redirect, "error");
  assert.equal(result.release.id, pack.release.id);
  assert.equal(result.release.license.id, "apache-2.0");

  await assert.rejects(
    checkForVisualPackRelease({
      platform: pack.release.platform,
      arch: pack.release.arch,
      releaseManifestTrust: trust,
      fetchImpl: async () => new Response(JSON.stringify({
        ...signedRelease,
        visualPacks: {
          ...signedRelease.visualPacks,
          [target]: { ...signedRelease.visualPacks[target], revision: "tampered" },
        },
      }), { status: 200 }),
    }),
    /signature verification failed/,
  );
});

test("Visual Pack installer downloads pinned files, verifies them, installs atomically, and removes by model id", { skip: !target }, async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-pack-install-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const pack = makePack();
  const progress = [];
  const installed = await installVisualPack({
    userDataDir,
    release: pack.release,
    fetchImpl: fetchForPack(pack),
    statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
    onProgress: (entry) => progress.push(entry),
  });
  assert.equal(installed.id, pack.release.id);
  assert.equal(installed.revision, pack.release.revision);
  assert.equal(installed.runtime.platform, pack.release.platform);
  assert.equal(progress.at(-1)?.phase, "complete");
  assert.equal(progress.at(-1)?.percent, 100);

  const discovery = await discoverVisualModelPacks({ userDataDir });
  assert.equal(discovery.packs.length, 1);
  assert.equal(discovery.invalid.length, 0);

  const removed = await removeVisualPack({ userDataDir, id: pack.release.id });
  assert.equal(removed.removed, 1);
  assert.equal((await discoverVisualModelPacks({ userDataDir })).packs.length, 0);
});

test("Visual Pack installer leaves the previous revision intact when a new download fails verification", { skip: !target }, async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-pack-rollback-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const oldPack = makePack("r1");
  await installVisualPack({
    userDataDir,
    release: oldPack.release,
    fetchImpl: fetchForPack(oldPack),
    statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
  });

  const nextPack = makePack("r2");
  const badUrl = visualPackDownloadUrl(nextPack.release, "model/model.bin");
  await assert.rejects(
    installVisualPack({
      userDataDir,
      release: nextPack.release,
      fetchImpl: fetchForPack(nextPack, new Map([[badUrl, Buffer.from("tampered-model")]])),
      statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
    }),
    /size does not match|SHA-256 verification failed/,
  );
  const discovery = await discoverVisualModelPacks({ userDataDir });
  assert.deepEqual(discovery.packs.map((pack) => pack.revision), ["r1"]);
});

test("Visual Pack installer fails before download when free disk space is insufficient", { skip: !target }, async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-pack-space-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const pack = makePack();
  let fetchCalls = 0;
  await assert.rejects(
    installVisualPack({
      userDataDir,
      release: pack.release,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("unexpected");
      },
      statfsImpl: async () => ({ bavail: 1, bsize: 4096 }),
    }),
    /Not enough free disk space/,
  );
  assert.equal(fetchCalls, 0);
});

test("Visual Pack startup cleanup restores an interrupted previous revision swap", { skip: !target }, async (t) => {
  const userDataDir = await mkdtemp(join(tmpdir(), "mosa-visual-pack-recover-"));
  deferTestPathRemoval(userDataDir, { recursive: true, force: true });
  const pack = makePack("r3");
  const installed = await installVisualPack({
    userDataDir,
    release: pack.release,
    fetchImpl: fetchForPack(pack),
    statfsImpl: async () => ({ bavail: 10_000_000, bsize: 4096 }),
  });
  const transactionName = `${pack.release.id}-${pack.release.revision}-${target}`;
  const transactionRoot = join(userDataDir, "visual-pack-staging", transactionName);
  const previousDir = join(transactionRoot, "previous");
  await mkdir(transactionRoot, { recursive: true });
  await rename(installed.pack_dir, previousDir);

  const result = await cleanupVisualPackStaging({ userDataDir });
  assert.equal(result.recovered, 1);
  const discovery = await discoverVisualModelPacks({ userDataDir });
  assert.equal(discovery.packs.length, 1);
  assert.equal(discovery.packs[0].revision, "r3");
});
