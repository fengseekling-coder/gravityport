import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";

import {
  buildMosaC2paManifest,
  exportAssetContentCredential,
  C2PA_SIGNING_MODES,
  C2PA_TRAINED_ALGORITHMIC_MEDIA,
  exportContentCredential,
  inspectContentCredential,
  sanitizedC2paEnvironment,
} from "../lib/c2pa-export.mjs";
import { buildAssetProvenanceBundle, MOSA_C2PA_ASSERTION_LABEL } from "../lib/provenance-bundle.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function generatedProvenance() {
  return {
    bundle: {
      schema: "mosa.provenance.bundle/1",
      exported_at: "2026-09-25T00:00:00.000Z",
      project_id: "default",
      asset: {
        id: "asset-1",
        file_name: "asset-1.jpg",
        content_sha256: "a".repeat(64),
        pixel_sha256: "b".repeat(64),
        source_type: "web-chatgpt",
        created_at: "2026-09-24T01:02:03.000Z",
      },
      recipe_history: null,
      generation_history: { generation_ids: ["generation-1"], events: [] },
    },
    c2pa_assertion: {
      label: MOSA_C2PA_ASSERTION_LABEL,
      schema: "mosa.c2pa.assertion/1",
    },
  };
}

test("C2PA manifest records AI source type and embeds the MOSA provenance assertion without key material", () => {
  const manifest = buildMosaC2paManifest({
    provenance: generatedProvenance(),
    productVersion: "0.2.1",
    title: "/private/library/asset-1.jpg",
  });
  assert.equal(manifest.claim_generator, "GravityPort/0.2.1");
  assert.deepEqual(manifest.claim_generator_info, [{ name: "GravityPort", version: "0.2.1" }]);
  assert.equal(manifest.title, "asset-1.jpg");
  assert.equal(manifest.assertions[0].label, "c2pa.actions.v2");
  assert.equal(manifest.assertions[0].data.actions[0].action, "c2pa.created");
  assert.equal(manifest.assertions[0].data.actions[0].digitalSourceType, C2PA_TRAINED_ALGORITHMIC_MEDIA);
  assert.equal(manifest.assertions[1].label, MOSA_C2PA_ASSERTION_LABEL);
  assert.equal(manifest.assertions[1].data.provenance.asset.id, "asset-1");
  assert.equal(JSON.stringify(manifest).includes("private_key"), false);
  assert.equal(JSON.stringify(manifest).includes("sign_cert"), false);
});

test("C2PA manifest refuses to guess a digital source type for provenance with unknown origin", () => {
  const provenance = generatedProvenance();
  provenance.bundle.asset.source_type = "local-file";
  provenance.bundle.generation_history = { generation_ids: [], events: [] };
  assert.throws(() => buildMosaC2paManifest({ provenance }), (error) => error?.code === "C2PA_DIGITAL_SOURCE_TYPE_UNKNOWN");
});

test("provenance bundle strips signing keys, API credentials, local paths, and URLs before C2PA export", async () => {
  const store = {
    async getAsset() {
      return {
        id: "asset-secret-test",
        asset: "asset-secret-test.jpg",
        source_type: "codex-generated",
        content_sha256: "a".repeat(64),
        image_path: "/private/library/asset-secret-test.jpg",
        source: {
          type: "codex-generated",
          private_key: "never-export-this",
          api_key: "never-export-this-either",
          source_url: "https://signed.example.invalid/private",
          source_path: "/private/source/file.jpg",
          provider_asset_id: "safe-provider-id",
        },
      };
    },
    async getRecipeSnapshotHistory() { return null; },
    async getAssetGenerationHistory() {
      return {
        generation_ids: ["g1"],
        events: [{ id: "g1", evidence: { access_key: "secret", safe_id: "evidence-1" } }],
        relations: [],
      };
    },
  };
  const provenance = await buildAssetProvenanceBundle(store, "default", "asset-secret-test");
  const serialized = JSON.stringify(provenance);
  assert.equal(serialized.includes("never-export-this"), false);
  assert.equal(serialized.includes("signed.example.invalid"), false);
  assert.equal(serialized.includes("/private/source"), false);
  assert.equal(serialized.includes("\"access_key\""), false);
  assert.match(serialized, /safe-provider-id/);
  assert.match(serialized, /evidence-1/);
});

test("C2PA production mode requires an external signer and never consumes local signer secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-policy-"));
  const input = join(root, "input.jpg");
  const output = join(root, "output.jpg");
  await writeFile(input, "fixture");
  try {
    await assert.rejects(() => exportContentCredential({
      inputPath: input,
      outputPath: output,
      provenance: generatedProvenance(),
      signingMode: C2PA_SIGNING_MODES.production,
      toolRunner: async () => { throw new Error("must not run"); },
    }), (error) => error?.code === "C2PA_PRODUCTION_SIGNER_REQUIRED");

    const clean = sanitizedC2paEnvironment({
      PATH: "/bin",
      C2PA_PRIVATE_KEY: "secret-key",
      C2PA_SIGN_CERT: "cert",
      C2PATOOL_SETTINGS: "/tmp/unsafe.toml",
    });
    assert.deepEqual(clean, { PATH: "/bin" });
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA production mode preflights the signer before invoking c2patool and reports only public signer metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-production-"));
  const input = join(root, "input.jpg");
  const output = join(root, "output.jpg");
  const signer = join(root, "signer");
  await writeFile(input, "original-bytes");
  await writeFile(signer, "signer-fixture");
  const calls = [];
  try {
    const result = await exportContentCredential({
      inputPath: input,
      outputPath: output,
      provenance: generatedProvenance(),
      signingMode: C2PA_SIGNING_MODES.production,
      signerPath: signer,
      c2paToolPath: "/fake/c2patool",
      signerPreflight: async ({ signerPath }) => {
        assert.equal(signerPath, signer);
        return {
          ok: true,
          executable: signer,
          algorithm: "es256",
          certificate_chain_length: 1,
          certificate_sha256: "c".repeat(64),
          certificate_subject: "CN=MOSA Signer",
          certificate_issuer: "CN=MOSA Test CA",
          certificate_valid_from: "Jan 1 00:00:00 2026 GMT",
          certificate_valid_to: "Jan 1 00:00:00 2027 GMT",
          tsa_url: null,
          reserve_size: 16384,
        };
      },
      toolRunner: async (_binary, args, options) => {
        calls.push({ args, options });
        if (options.operation === "sign") {
          assert.deepEqual(args.slice(-2), ["--signer-path", signer]);
          await copyFile(input, output);
          return { stdout: "", stderr: "" };
        }
        return {
          stdout: JSON.stringify({
            active_manifest: "urn:c2pa:production-test",
            manifests: {
              "urn:c2pa:production-test": {
                assertions: [{ label: MOSA_C2PA_ASSERTION_LABEL, data: {} }],
              },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(result.signing.mode, C2PA_SIGNING_MODES.production);
    assert.equal(result.signing.trust, "external-signer-not-trust-verified");
    assert.equal(result.signing.preflight.algorithm, "es256");
    assert.equal(result.signing.preflight.certificate_sha256, "c".repeat(64));
    assert.equal(JSON.stringify(result.signing).includes("PRIVATE KEY"), false);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA export writes only a new output file and verifies that the MOSA assertion is present", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-runner-"));
  const input = join(root, "input.jpg");
  const output = join(root, "output.jpg");
  await writeFile(input, "original-bytes");
  const calls = [];
  try {
    const result = await exportContentCredential({
      inputPath: input,
      outputPath: output,
      provenance: generatedProvenance(),
      c2paToolPath: "/fake/c2patool",
      toolRunner: async (_binary, args, options) => {
        calls.push({ args, options });
        if (options.operation === "sign") {
          const manifestPath = args[args.indexOf("--manifest") + 1];
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          assert.equal(manifest.assertions[1].label, MOSA_C2PA_ASSERTION_LABEL);
          await copyFile(input, output);
          return { stdout: "", stderr: "development test signer" };
        }
        return {
          stdout: JSON.stringify({
            active_manifest: "urn:c2pa:test",
            manifests: {
              "urn:c2pa:test": {
                assertions: [
                  { label: "c2pa.actions.v2", data: {} },
                  { label: MOSA_C2PA_ASSERTION_LABEL, data: {} },
                ],
              },
            },
          }),
          stderr: "",
        };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(result.signing.mode, C2PA_SIGNING_MODES.development);
    assert.equal(result.signing.trust, "development-test-certificate");
    assert.equal(result.verification.hasActiveManifest, true);
    assert.equal(result.verification.hasMosaAssertion, true);
    assert.equal(String(await readFile(input)), "original-bytes");
    assert.equal(String(await readFile(output)), "original-bytes");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

test("C2PA export refuses to overwrite the source or an existing destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-path-"));
  const input = join(root, "input.jpg");
  const output = join(root, "output.jpg");
  await writeFile(input, "source");
  await writeFile(output, "existing");
  try {
    await assert.rejects(() => exportContentCredential({
      inputPath: input,
      outputPath: input,
      provenance: generatedProvenance(),
    }), (error) => error?.code === "C2PA_OUTPUT_MUST_DIFFER");
    await assert.rejects(() => exportContentCredential({
      inputPath: input,
      outputPath: output,
      provenance: generatedProvenance(),
    }), (error) => error?.code === "C2PA_OUTPUT_EXISTS");
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

const REAL_C2PA_TOOL = resolveRealC2paTool();
test("real c2patool development certificate embeds and re-reads the MOSA assertion", { skip: !REAL_C2PA_TOOL }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-real-"));
  const input = join(root, "input.jpg");
  const output = join(root, "signed.jpg");
  await sharp({ create: { width: 24, height: 24, channels: 3, background: "#d52d2d" } }).jpeg().toFile(input);
  try {
    const result = await exportContentCredential({
      inputPath: input,
      outputPath: output,
      provenance: generatedProvenance(),
      productVersion: "test",
      signingMode: C2PA_SIGNING_MODES.development,
      c2paToolPath: REAL_C2PA_TOOL,
    });
    assert.equal(result.verification.hasMosaAssertion, true);
    assert.ok((await stat(output)).size > (await stat(input)).size);
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});

function resolveRealC2paTool() {
  const explicit = String(process.env.MOSA_C2PATOOL_TEST_PATH || "").trim();
  const binary = explicit || "c2patool";
  const probe = spawnSync(binary, ["-V"], { stdio: "ignore", windowsHide: true });
  return probe.status === 0 ? binary : "";
}

test("asset-level C2PA export resolves media and provenance through the store", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-asset-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const input = join(root, "asset-1.jpg");
  const output = join(root, "signed.jpg");
  await writeFile(input, "original-bytes");
  const seenAssetIds = [];
  const store = {
    async getAsset(project, assetId) {
      seenAssetIds.push({ project, assetId });
      return { id: assetId, image_path: input, source_type: "web-chatgpt" };
    },
  };
  const result = await exportAssetContentCredential({
    store,
    assetId: "asset-1",
    outputPath: output,
    c2paToolPath: "/fake/c2patool",
    toolRunner: async (_binary, _args, options) => {
      if (options.operation === "sign") {
        await copyFile(input, output);
        return { stdout: "", stderr: "development test signer" };
      }
      return {
        stdout: JSON.stringify({
          active_manifest: "urn:c2pa:test",
          manifests: { "urn:c2pa:test": { assertions: [{ label: MOSA_C2PA_ASSERTION_LABEL, data: {} }] } },
        }),
        stderr: "",
      };
    },
  });
  assert.equal(seenAssetIds[0].project, "default");
  assert.ok(seenAssetIds.every(({ assetId }) => assetId === "asset-1"));
  assert.equal(result.outputPath, output);
  assert.equal(await readFile(output, "utf8"), "original-bytes");
});

test("asset-level C2PA export fails closed when the asset has no managed media", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-asset-missing-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const store = { async getAsset() { return { id: "asset-2", image_path: "" }; } };
  await assert.rejects(
    exportAssetContentCredential({ store, assetId: "asset-2", outputPath: join(root, "out.jpg") }),
    (error) => error?.code === "C2PA_ASSET_MEDIA_MISSING",
  );
});

test("content credentials written under the legacy MOSA claim generator still pass the existing inspection flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "mosa-c2pa-legacy-name-"));
  const assetPath = join(root, "legacy.jpg");
  await writeFile(assetPath, "legacy-bytes");
  try {
    const inspection = await inspectContentCredential({
      assetPath,
      c2paToolPath: "/fake/c2patool",
      toolRunner: async () => ({
        stdout: JSON.stringify({
          active_manifest: "urn:c2pa:legacy-mosa",
          manifests: {
            "urn:c2pa:legacy-mosa": {
              claim_generator: "MOSA/0.2.1",
              claim_generator_info: [{ name: "MOSA", version: "0.2.1" }],
              assertions: [
                { label: MOSA_C2PA_ASSERTION_LABEL, data: { schema: "mosa.provenance.bundle/1" } },
              ],
            },
          },
        }),
        stderr: "",
      }),
    });
    assert.equal(inspection.hasActiveManifest, true);
    assert.equal(inspection.hasMosaAssertion, true);
    assert.ok(inspection.assertionLabels.includes(MOSA_C2PA_ASSERTION_LABEL));
  } finally {
    await removeTestPath(root, { recursive: true, force: true });
  }
});
