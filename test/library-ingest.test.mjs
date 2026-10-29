// The ingest gate (lib/library-ingest.mjs) against the real sqlite store —
// temporary-library pattern from web-capture-ingest.test.mjs, no store mocks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../lib/image-pixel-hash.js";
import {
  canUpgradeMetadata,
  createAssetViaGate,
  createIngestLookup,
  findExistingAsset,
  ingestIntoLibrary,
  ingestOwnerOf,
  untrustedCreateSource,
} from "../lib/library-ingest.mjs";
import { ingestWebCapture } from "../lib/web-capture-ingest.js";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

async function noiseImage(width, height, seed, format = "png") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 1) raw[i] = (i * (37 + seed) + (i % 251) + seed * 13) & 255;
  const encoder = sharp(raw, { raw: { width, height, channels: 3 } });
  if (format === "jpeg") return encoder.jpeg({ quality: 80 }).toBuffer();
  return encoder.png().toBuffer();
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createTestStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  return { store, root, libraryDir };
}

async function createAssetFromFile(store, root, name, bytes, extra = {}) {
  const imagePath = join(root, name);
  await writeFile(imagePath, bytes);
  return store.createAsset({
    projectId: "default",
    imagePath,
    assetId: name.replace(/\W+/g, "-").replace(/^-+|-+$/g, ""),
    sourceType: extra.sourceType || "local-file",
    prompt: extra.prompt || "",
    source: {
      content_sha256: sha256(bytes),
      pixel_sha256: extra.pixelHash ?? null,
      pixel_hash_version: extra.pixelHash ? PIXEL_HASH_VERSION : null,
      ...(extra.source || {}),
    },
    business_fields: extra.business_fields || {},
  }, extra.options || {});
}

test("createIngestLookup hits by provider identity, source path, content hash, and pixel hash", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-lookup-");
  const bytes = await noiseImage(48, 64, 21);
  const pixelHash = await safePixelDigest(bytes);
  const identityAsset = await createAssetFromFile(store, root, "identity.png", bytes, {
    source: { provider: "chatgpt", type: "web-chatgpt", provider_asset_id: "file-identity" },
    sourceType: "web-chatgpt",
  });
  const pathAsset = await createAssetFromFile(store, root, "by-path.png", await noiseImage(48, 64, 22), {
    source: { path: join(root, "by-path.png") },
  });
  const contentAsset = await createAssetFromFile(store, root, "by-content.png", await noiseImage(48, 64, 23), {});
  const pixelAsset = await createAssetFromFile(store, root, "by-pixel.png", await noiseImage(48, 64, 24), {
    pixelHash,
  });

  const lookup = createIngestLookup(store, "default");
  const byIdentity = await lookup.byProviderIdentity("chatgpt", "file-identity", "", "image");
  assert.equal(byIdentity?.id, identityAsset.id);
  const byPath = await lookup.bySourcePath(resolve(join(root, "by-path.png")));
  assert.equal(byPath?.id, pathAsset.id);
  const byContent = await lookup.byContentHash(sha256(await noiseImage(48, 64, 23)));
  assert.equal(byContent?.id, contentAsset.id);
  const byPixel = await lookup.byPixelHash(pixelHash);
  assert.equal(byPixel?.id, pixelAsset.id);
  assert.equal(await lookup.byContentHash("0".repeat(64)), null);
});

test("createIngestLookup recomputes a legacy pixel hash before trusting it and writes the fresh hash back", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-legacy-pixel-");
  const bytes = await noiseImage(48, 64, 31);
  const pixelHash = await safePixelDigest(bytes);
  const legacy = await createAssetFromFile(store, root, "legacy.png", bytes, {
    // The asset carries the right hash under an old hash version: the lookup
    // may only trust it after recomputing from the stored original.
    pixelHash,
    source: { pixel_hash_version: "display-pixels-v1" },
  });
  assert.equal(legacy.source.pixel_hash_version, "display-pixels-v1");

  const lookup = createIngestLookup(store, "default");
  const found = await lookup.byPixelHash(pixelHash);
  assert.equal(found?.id, legacy.id, "a legacy-version match is proven against the stored original");
  const refreshed = await store.getAsset("default", legacy.id);
  assert.equal(refreshed.source.pixel_hash_version, PIXEL_HASH_VERSION, "the fresh hash version is written back");
  assert.equal(refreshed.source.pixel_sha256, pixelHash);
});

test("remember makes an asset created during the same scan findable by the next candidate", async (t) => {
  const { store } = await createTestStore(t, "mosa-gate-remember-");
  const lookup = createIngestLookup(store, "default");
  const freshAsset = {
    id: "web-chatgpt-just-created",
    project_id: "default",
    source: {
      content_sha256: "f".repeat(64),
      path: "/tmp/just-created.png",
      pixel_sha256: "e".repeat(64),
      pixel_hash_version: PIXEL_HASH_VERSION,
    },
  };
  lookup.remember(freshAsset);
  assert.equal((await lookup.byContentHash("f".repeat(64)))?.id, freshAsset.id);
  assert.equal((await lookup.bySourcePath("/tmp/just-created.png"))?.id, freshAsset.id);
  assert.equal((await lookup.byPixelHash("e".repeat(64)))?.id, freshAsset.id);
});

test("findExistingAsset walks the requested strategies in order", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-order-");
  const bytes = await noiseImage(48, 64, 41);
  const pixelHash = await safePixelDigest(bytes);
  const identityAsset = await createAssetFromFile(store, root, "order.png", bytes, {
    source: { provider: "chatgpt", type: "web-chatgpt", provider_asset_id: "file-order" },
    sourceType: "web-chatgpt",
    pixelHash,
  });
  const lookup = createIngestLookup(store, "default");
  const identity = {
    provider: "chatgpt",
    providerAssetId: "file-order",
    contentHash: sha256(bytes),
    pixelHash,
  };
  const first = await findExistingAsset(lookup, identity, ["provider-identity", "content", "pixel"]);
  assert.deepEqual({ matchedBy: first.matchedBy, id: first.asset.id }, { matchedBy: "provider-identity", id: identityAsset.id });
  const contentFirst = await findExistingAsset(lookup, identity, ["content", "provider-identity"]);
  assert.deepEqual({ matchedBy: contentFirst.matchedBy, id: contentFirst.asset.id }, { matchedBy: "content", id: identityAsset.id });
  assert.equal(await findExistingAsset(lookup, { provider: "chatgpt" }, ["provider-identity", "content"]), null);
});

test("ingestOwnerOf maps source types to the six owners", () => {
  assert.equal(ingestOwnerOf({ source: { type: "web-chatgpt", provider: "chatgpt" } }), "web:chatgpt");
  assert.equal(ingestOwnerOf({ source: { type: "web-flow" } }), "web:flow", "a web capture without an explicit provider derives it from the source type");
  assert.equal(ingestOwnerOf({ source_type: "codex-generated" }), "codex");
  assert.equal(ingestOwnerOf({ source: { type: "grok-generated" } }), "grok");
  assert.equal(ingestOwnerOf({ source: { type: "cowart-generated" } }), "cowart");
  assert.equal(ingestOwnerOf({ source: { type: "local-file" } }), "manual");
  assert.equal(ingestOwnerOf({ source: { type: "something-else" } }), "other");
  assert.equal(ingestOwnerOf({}), "other");
});

test("canUpgradeMetadata lets only the owning channel upgrade, manual imports are open to all", () => {
  const chatgptAsset = { source: { type: "web-chatgpt", provider: "chatgpt" } };
  assert.equal(canUpgradeMetadata(chatgptAsset, "web:chatgpt"), true);
  assert.equal(canUpgradeMetadata(chatgptAsset, "web:flow"), false);
  assert.equal(canUpgradeMetadata(chatgptAsset, "codex"), false);
  const manualAsset = { source: { type: "local-file" } };
  assert.equal(canUpgradeMetadata(manualAsset, "web:chatgpt"), true, "a local import carries no provenance, any channel may refill it");
  assert.equal(canUpgradeMetadata(manualAsset, "codex"), true);
  assert.equal(canUpgradeMetadata({ source: { type: "codex-generated" } }, "codex"), true);
});

test("createAssetViaGate translates the store's dedupe outcomes into skipped results", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-translations-");
  const bytes = await noiseImage(48, 64, 51);
  const imagePath = join(root, "translated.png");
  await writeFile(imagePath, bytes);
  const baseInput = {
    projectId: "default",
    imagePath,
    assetId: "gate-translated",
    sourceType: "local-file",
    source: { content_sha256: sha256(bytes) },
  };

  // One copy in the library: every dedupe outcome names it.
  await store.createAsset({ ...baseInput }, { ingestMode: "manual" });

  // Automatic re-ingest of known bytes is a transactional duplicate.
  const duplicate = await createAssetViaGate(store, { ...baseInput, assetId: "gate-dup" }, { ingestMode: "automatic" });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.skipped.reason, "already-archived-same-content");
  assert.equal(duplicate.skipped.duplicateId, "gate-translated");

  // Manual import with the dedupe switch reports where the copy lives.
  const inLibrary = await createAssetViaGate(store, { ...baseInput, assetId: "gate-in-library" }, {
    ingestMode: "manual",
    skipIdenticalBytes: true,
  });
  assert.equal(inLibrary.ok, false);
  assert.equal(inLibrary.skipped.reason, "already-in-library");
  assert.equal(inLibrary.skipped.existingAsset.id, "gate-translated");

  // Asset id collision + retry with a fresh id succeeds.
  const retried = await createAssetViaGate(store, { ...baseInput }, {
    ingestMode: "manual",
    retryAssetId: () => "gate-translated-second",
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.asset.id, "gate-translated-second");

  // Without a retry id the collision surfaces as before.
  await assert.rejects(
    () => createAssetViaGate(store, { ...baseInput, assetId: "gate-translated" }, { ingestMode: "manual" }),
    (error) => error.code === "ASSET_ALREADY_EXISTS",
  );

  // Other errors propagate untouched.
  await assert.rejects(
    () => createAssetViaGate(store, { ...baseInput, assetId: "gate-missing", imagePath: join(root, "does-not-exist.png") }, { ingestMode: "manual" }),
    (error) => !(["AUTOMATIC_IMPORT_SUPPRESSED", "AUTOMATIC_INGEST_DUPLICATE", "ALREADY_IN_LIBRARY", "ASSET_ALREADY_EXISTS"].includes(error?.code)),
  );
});

test("createAssetViaGate skips an automatic ingest suppressed after a manual deletion", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-suppressed-");
  const bytes = await noiseImage(48, 64, 52);
  const imagePath = join(root, "suppressed.png");
  await writeFile(imagePath, bytes);
  const input = {
    projectId: "default",
    imagePath,
    assetId: "gate-suppressed",
    sourceType: "local-file",
    source: { content_sha256: sha256(bytes) },
  };
  const asset = await store.createAsset({ ...input }, { ingestMode: "automatic" });
  await store.deleteAsset("default", asset.id);
  const suppressed = await createAssetViaGate(store, { ...input, assetId: "gate-suppressed-2" }, { ingestMode: "automatic" });
  assert.equal(suppressed.ok, false);
  assert.equal(suppressed.skipped.reason, "suppressed-after-delete");
});

test("untrustedCreateSource strips the caller-claimed hashes", () => {
  const clean = untrustedCreateSource({
    provider: "codex",
    content_sha256: "a".repeat(64),
    pixel_sha256: "b".repeat(64),
    pixel_hash_version: "display-pixels-v2",
    codex_image_path: "/tmp/codex-image.png",
  });
  assert.deepEqual(clean, { provider: "codex", codex_image_path: "/tmp/codex-image.png" });
  assert.deepEqual(untrustedCreateSource(null), {});
  assert.deepEqual(untrustedCreateSource("not-an-object"), {});
});

test("the channel that archived an asset upgrades it; another site only records an occurrence", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-owner-web-");
  const tempRoot = join(root, ".web-capture-tmp");
  const bytes = await noiseImage(720, 960, 61);

  const chatgpt = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: bytes.toString("base64"),
      mimeType: "image/png",
      prompt: "A caption the chat model wrote",
      prompt_status: "visible-caption",
      generation_status: "completed",
      conversationId: "owner-web-conversation",
    },
  });
  assert.equal(chatgpt.status, "imported");
  assert.equal(chatgpt.asset.prompt, "A caption the chat model wrote");

  // Flow recaptures the very same bytes with a strictly higher-ranked prompt:
  // it may record its occurrence, but must not touch the prompt.
  const flow = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "flow",
      imageBase64: bytes.toString("base64"),
      mimeType: "image/png",
      prompt: "A generation tool prompt Flow saw",
      prompt_status: "generation-tool-prompt",
      generation_status: "completed",
      pageUrl: "https://flow.example/page",
    },
  });
  assert.equal(flow.status, "skipped");
  assert.equal(flow.upgraded, false);
  assert.equal(flow.asset.id, chatgpt.asset.id);
  assert.equal(flow.asset.prompt, "A caption the chat model wrote", "another site's higher-ranked prompt does not rewrite the asset");
  assert.deepEqual(
    flow.asset.source.capture_occurrences.map((entry) => entry.provider),
    ["chatgpt", "flow"],
  );

  // Control: the same bytes imported locally first (no provenance, no prompt)
  // are refilled by the ChatGPT capture.
  const controlBytes = await noiseImage(720, 960, 62);
  const controlPath = join(root, "manual-first.png");
  await writeFile(controlPath, controlBytes);
  await store.createAsset({
    projectId: "default",
    imagePath: controlPath,
    assetId: "manual-first",
    sourceType: "local-file",
    source: { content_sha256: sha256(controlBytes), type: "local-file" },
    business_fields: {},
  }, { ingestMode: "manual" });
  const refilled = await ingestWebCapture({
    store,
    tempRoot,
    projectId: "default",
    input: {
      provider: "chatgpt",
      imageBase64: controlBytes.toString("base64"),
      mimeType: "image/png",
      prompt: "A prompt for the manually imported image",
      prompt_status: "generation-tool-prompt",
      generation_status: "completed",
      conversationId: "owner-manual-conversation",
    },
  });
  assert.equal(refilled.status, "skipped");
  assert.equal(refilled.upgraded, true);
  assert.equal(refilled.asset.id, "manual-first");
  assert.equal(refilled.asset.prompt, "A prompt for the manually imported image", "a local import gets its prompt refilled");
});

test("ingestIntoLibrary creates through the gate and adopts a transactional duplicate", async (t) => {
  const { store, root } = await createTestStore(t, "mosa-gate-race-");
  const bytes = await noiseImage(48, 64, 71);
  const imagePath = join(root, "race.png");
  await writeFile(imagePath, bytes);
  const contentHash = sha256(bytes);
  const assetInput = {
    projectId: "default",
    imagePath,
    sourceType: "local-file",
    source: { content_sha256: contentHash },
  };
  const hooks = [];
  const request = {
    projectId: "default",
    identity: {},
    contentHash,
    incomingOwner: "manual",
    occurrence: { provider: "probe", type: "local-file", page_url: null, conversation_id: null, message_id: null, generation_context_id: null, capture_mode: "manual" },
    prompt: null,
    prepareMedia: async () => ({ assetInput: { ...assetInput, assetId: "gate-race" } }),
    onExistingRecipe: async (existing) => { hooks.push(["recipe", existing.id]); return { asset: existing, merged: false }; },
    onExistingObserved: async (asset) => { hooks.push(["observed", asset.id]); return asset; },
    onCreated: async (asset) => { hooks.push(["created", asset.id]); },
    ingestMode: "manual",
  };

  const first = await ingestIntoLibrary(store, request);
  assert.equal(first.status, "imported");
  assert.equal(first.asset.id, "gate-race");
  assert.deepEqual(hooks, [["created", "gate-race"]]);

  // A racing capture that missed the pre-check (no content strategy) hits the
  // store's transactional duplicate: the gate adopts the stored asset and runs
  // the observation hooks exactly like a recognized duplicate.
  hooks.length = 0;
  const raced = await ingestIntoLibrary(store, {
    ...request,
    findExistingOrder: ["provider-identity"],
    prepareMedia: async () => ({ assetInput: { ...assetInput, assetId: "gate-race-2" } }),
    ingestMode: "automatic",
  });
  assert.equal(raced.status, "skipped");
  assert.equal(raced.reason, "already-archived-same-content");
  assert.equal(raced.asset.id, "gate-race");
  assert.deepEqual(hooks.map(([name]) => name), ["recipe", "observed"]);

  // The manual dedupe switch reports where the stored copy lives.
  const inLibrary = await ingestIntoLibrary(store, {
    ...request,
    findExistingOrder: ["provider-identity"],
    prepareMedia: async () => ({ assetInput: { ...assetInput, assetId: "gate-race-3" } }),
    skipIdenticalBytes: true,
  });
  assert.equal(inLibrary.status, "skipped");
  assert.equal(inLibrary.reason, "already-in-library");
  assert.equal(inLibrary.existingAsset.id, "gate-race");
});
