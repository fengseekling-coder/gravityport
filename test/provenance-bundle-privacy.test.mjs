import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

import { exportAssetContentCredential } from "../lib/c2pa-export.mjs";
import { buildAssetProvenanceBundle, MOSA_C2PA_ASSERTION_LABEL } from "../lib/provenance-bundle.mjs";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

function getSystemIdentity() {
  const home = os.homedir();
  let username = "";
  try {
    username = os.userInfo?.()?.username || "";
  } catch {}
  return { home, username };
}

function createPrivacyFixtureStore({
  assetId = "e4-leak-test",
  modelValue = "gpt-4o",
  extraSource = {},
} = {}) {
  const { home, username } = getSystemIdentity();
  const promptText = "A magnificent red lighthouse at sunset";
  const userPromptText = "用户原话: 红色灯塔";
  const linkedPromptText = "用户原话: 关联图原话";

  const asset = {
    id: assetId,
    asset: "e4.png",
    content_sha256: "1".repeat(64),
    pixel_sha256: "2".repeat(64),
    source_type: "web-chatgpt",
    created_at: "2026-11-07T12:00:00.000Z",
    updated_at: "2026-11-07T12:01:00.000Z",
    prompt: promptText,
    user_prompt: userPromptText,
    source: {
      type: "web-chatgpt",
      provider: "chatgpt",
      model: modelValue,
      captured_at: "2026-11-07T12:00:00.000Z",
      // Leaked fields from Issue 2 in Test 372
      codex_generated_images_root: join(home, ".codex", "generated_images"),
      local_file: join(home, "Pictures", "private.png"),
      original_file: join(home, "Desktop", "secret", "e4.png"),
      folder: "Desktop",
      workspace: "secret-client",
      user: username,
      ...extraSource,
    },
    recipe_snapshots: [
      {
        snapshot_id: "recipe-snapshot-1",
        schema_version: "1.0.0",
        project_id: "default",
        asset_id: assetId,
        recipe_digest: "3".repeat(64),
        prompt_digest: "4".repeat(64),
        effective_prompt: promptText,
        user_prompt: userPromptText,
        negative_prompt: "blurry, low quality",
        prompt_status: "submitted",
        generation_tool: "web-ui",
        model: modelValue,
        provider: "chatgpt",
        skill: "",
        style: "",
        ratio: "1:1",
        theme: "",
        references: [],
        provenance: { source_type: "web-chatgpt" },
        change_summary: "Initial recipe change",
        created_at: "2026-11-07T12:00:00.000Z",
      },
    ],
  };

  const generationHistory = {
    project_id: "default",
    asset_id: assetId,
    generation_ids: ["gen-e4-1"],
    events: [
      {
        id: "gen-e4-1",
        project_id: "default",
        output_asset_id: assetId,
        provider: "chatgpt",
        model: modelValue,
        user_prompt: userPromptText,
        effective_prompt: promptText,
        evidence: {
          source: "web-capture",
          relation_status: "unresolved",
          safe_id: "evidence-safe-1",
          // Evidence leakage from Issue 2
          local_file: join(home, "Pictures", "private.png"),
          original_file: join(home, "Desktop", "secret", "e4.png"),
          folder: join(home, "Desktop"),
          workspace: "secret-client",
          user: username,
        },
        created_at: "2026-11-07T12:00:00.000Z",
      },
    ],
    relations: [],
    output_assets: [
      {
        id: "linked-asset-2",
        asset: "linked.png",
        content_sha256: "5".repeat(64),
        user_prompt: linkedPromptText,
        prompt: "Linked asset prompt text",
        source: {
          type: "web-chatgpt",
          user: username,
          local_file: join(home, "Pictures", "linked.png"),
        },
      },
    ],
  };

  const store = {
    async getAsset(project, id) {
      if (id === assetId) return asset;
      throw new Error(`Asset not found: ${id}`);
    },
    async getRecipeSnapshotHistory(project, id) {
      if (id === assetId) {
        return {
          project_id: project,
          asset_id: id,
          active_snapshot_id: "recipe-snapshot-1",
          snapshots: asset.recipe_snapshots,
        };
      }
      return null;
    },
    async getAssetGenerationHistory(project, id) {
      if (id === assetId) return generationHistory;
      return null;
    },
  };

  return { store, promptText, userPromptText, linkedPromptText, home, username };
}

test("Task 374: provenance export without includePrompts excludes paths, username, and prompts (Test 1 & 2)", async () => {
  const { store, promptText, userPromptText, linkedPromptText, home, username } = createPrivacyFixtureStore();
  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
  const serialized = JSON.stringify(exported);
  const bundleSerialized = JSON.stringify(exported.bundle);

  // Assert includes_prompts is false
  assert.equal(exported.bundle.includes_prompts, false, "includes_prompts must be false when not passed");

  // Assert absence of local home directory, username, and /Users/
  assert.equal(serialized.includes(home), false, "serialized bundle must not contain os.homedir()");
  assert.equal(bundleSerialized.includes(username), false, "bundle must not contain username");
  // The only occurrence of username in the outer structure might be within the fixed reverse-DNS label "com.azhuilab.mosa.provenance"
  const payloadWithoutLabel = serialized.replaceAll(MOSA_C2PA_ASSERTION_LABEL, "");
  if (username) {
    assert.equal(payloadWithoutLabel.includes(username), false, "serialized payload must not contain username outside fixed label");
  }
  assert.equal(serialized.includes("/Users/"), false, "serialized bundle must not contain /Users/");

  // Assert absence of prompt and user words
  assert.equal(serialized.includes(promptText), false, "serialized bundle must not contain effective prompt");
  assert.equal(serialized.includes(userPromptText), false, "serialized bundle must not contain user prompt");
  assert.equal(serialized.includes(linkedPromptText), false, "serialized bundle must not contain linked asset prompt");

  // Assert that non-allowlisted keys are not exported
  assert.equal(serialized.includes('"folder"'), false, "folder must not be in export");
  assert.equal(serialized.includes('"workspace"'), false, "workspace must not be in export");
  assert.equal(serialized.includes('"user"'), false, "user must not be in export");
  assert.equal(serialized.includes('"local_file"'), false, "local_file must not be in export");
  assert.equal(serialized.includes('"original_file"'), false, "original_file must not be in export");
  assert.equal(serialized.includes('"codex_generated_images_root"'), false, "codex_generated_images_root must not be in export");
});

test("Task 374: provenance export with includePrompts: true includes prompts but still excludes paths and username (Test 3)", async () => {
  const { store, promptText, userPromptText, home, username } = createPrivacyFixtureStore();
  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test", { includePrompts: true });
  const serialized = JSON.stringify(exported);
  const bundleSerialized = JSON.stringify(exported.bundle);

  // Assert includes_prompts is true
  assert.equal(exported.bundle.includes_prompts, true, "includes_prompts must be true");

  // Assert prompts are present
  assert.ok(serialized.includes(promptText), "prompts must be present when includePrompts is true");
  assert.ok(serialized.includes(userPromptText), "user prompt must be present when includePrompts is true");

  // Assert local paths and username are still NOT present
  assert.equal(serialized.includes(home), false, "serialized bundle must not contain os.homedir()");
  assert.equal(bundleSerialized.includes(username), false, "bundle must not contain username");
  const payloadWithoutLabel = serialized.replaceAll(MOSA_C2PA_ASSERTION_LABEL, "");
  if (username) {
    assert.equal(payloadWithoutLabel.includes(username), false, "serialized payload must not contain username outside fixed label");
  }
  assert.equal(serialized.includes("/Users/"), false, "serialized bundle must not contain /Users/");
  assert.equal(serialized.includes('"folder"'), false, "folder must not be in export even with includePrompts");
});

test("Task 374: un-allowlisted key brand_new_field in source is dropped (Test 4)", async () => {
  const { store } = createPrivacyFixtureStore({
    extraSource: { brand_new_field: "x" },
  });
  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
  assert.equal("brand_new_field" in exported.bundle.asset.source, false, "brand_new_field must be dropped");
  assert.equal(JSON.stringify(exported).includes("brand_new_field"), false);
});

test("Task 374: allowlisted key with path value is dropped by value fallback (Test 5)", async () => {
  const { username } = getSystemIdentity();
  const pathValue = `/Users/${username || "user"}/models/custom-model`;
  const { store } = createPrivacyFixtureStore({
    modelValue: pathValue,
  });
  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
  assert.equal("model" in exported.bundle.asset.source, false, "model with path value must be dropped by value fallback");
  assert.equal(JSON.stringify(exported).includes("/models/custom-model"), false);
});

test("Task 374: live mcp/server.mjs asset_provenance_export without includePrompts excludes sensitive data (Test 6)", async (t) => {
  const { home, username } = getSystemIdentity();
  const workspace = await createMcpWorkspace(t);
  const imagePath = await writePngFixture(join(workspace.imagesDir, "leak-fixture.png"), { color: "#123456" });

  const promptText = "Real MCP prompt for lighthouse";
  const userPromptText = "用户真实原话: 红色灯塔";

  const server = startMcpServer(t, workspace);

  // Create asset via tool
  await server.callToolStrict("asset_create", {
    assetId: "e4-mcp-leak",
    imagePath,
    prompt: promptText,
  });

  // Inject leak fields directly into SQLite source_json
  const db = new Database(join(workspace.libraryDir, "mosa.db"));
  const sourcePayload = JSON.stringify({
    type: "web-chatgpt",
    provider: "chatgpt",
    model: "gpt-4o",
    captured_at: "2026-11-07T12:00:00.000Z",
    codex_generated_images_root: join(home, ".codex", "generated_images"),
    local_file: join(home, "Pictures", "private.png"),
    original_file: join(home, "Desktop", "secret", "e4.png"),
    folder: "Desktop",
    workspace: "secret-client",
    user: username,
    user_prompt: userPromptText,
  });
  db.prepare("UPDATE assets SET source_json = ? WHERE project_id = 'default' AND id = 'e4-mcp-leak'").run(sourcePayload);
  db.close();

  const result = await server.callToolStrict("asset_provenance_export", { assetId: "e4-mcp-leak" });
  const serialized = JSON.stringify(result);
  const bundleSerialized = JSON.stringify(result.structuredContent.bundle);

  assert.equal(result.structuredContent.bundle.includes_prompts, false, "includes_prompts must be false by default");
  assert.equal(serialized.includes(home), false, "MCP export must not contain os.homedir()");
  assert.equal(bundleSerialized.includes(username), false, "MCP bundle must not contain username");
  const payloadWithoutLabel = serialized.replaceAll(MOSA_C2PA_ASSERTION_LABEL, "");
  if (username) {
    assert.equal(payloadWithoutLabel.includes(username), false, "MCP export must not contain username outside fixed label");
  }
  assert.equal(serialized.includes("/Users/"), false, "MCP export must not contain /Users/");
  assert.equal(serialized.includes(promptText), false, "MCP export must not contain promptText");
  assert.equal(serialized.includes(userPromptText), false, "MCP export must not contain userPromptText");
  assert.equal(serialized.includes('"folder"'), false, "folder must not be in MCP export");
});

test("Task 374: exportAssetContentCredential without includePrompts writes assertion without prompt (Test 7)", async (t) => {
  const root = await mkdtemp(join(os.tmpdir(), "mosa-c2pa-privacy-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const input = join(root, "source.jpg");
  const output = join(root, "signed.jpg");
  await writeFile(input, "image-binary-data");

  const secretPrompt = "Top secret prompt text that must not leak";
  const store = {
    async getAsset(project, assetId) {
      return {
        id: assetId,
        image_path: input,
        source_type: "web-chatgpt",
        prompt: secretPrompt,
        source: {
          type: "web-chatgpt",
          provider: "chatgpt",
          model: "gpt-4o",
        },
      };
    },
  };

  let capturedManifest = null;
  await exportAssetContentCredential({
    store,
    assetId: "asset-c2pa-priv",
    outputPath: output,
    c2paToolPath: "/fake/c2patool",
    toolRunner: async (_binary, args, options) => {
      if (options.operation === "sign") {
        const manifestIdx = args.indexOf("--manifest");
        if (manifestIdx >= 0) {
          capturedManifest = JSON.parse(await readFile(args[manifestIdx + 1], "utf8"));
        }
        await copyFile(input, output);
        return { stdout: "", stderr: "test signer" };
      }
      return {
        stdout: JSON.stringify({
          active_manifest: "urn:c2pa:test",
          manifests: {
            "urn:c2pa:test": {
              assertions: [
                {
                  label: MOSA_C2PA_ASSERTION_LABEL,
                  data: {
                    schema: "mosa.provenance.bundle/1",
                    provenance: capturedManifest?.assertions?.find((a) => a.label === MOSA_C2PA_ASSERTION_LABEL)?.data?.provenance,
                  },
                },
              ],
            },
          },
        }),
        stderr: "",
      };
    },
  });

  assert.ok(capturedManifest, "Manifest must have been generated");
  const serializedManifest = JSON.stringify(capturedManifest);
  assert.equal(serializedManifest.includes(secretPrompt), false, "manifest must not contain prompt when includePrompts is false");

  const assertion = capturedManifest.assertions.find((a) => a.label === MOSA_C2PA_ASSERTION_LABEL);
  assert.ok(assertion, "Provenance assertion must exist");
  assert.equal(assertion.data.provenance.includes_prompts, false);
  assert.equal("prompt" in assertion.data.provenance.asset, false, "asset.prompt must not be present");
});

test("Task 374 Rework 1 (Test 1): Scene C reproduction — generation_record with object in evidence.signals via live mcp/server.mjs", async (t) => {
  const { home, username } = getSystemIdentity();
  const workspace = await createMcpWorkspace(t);
  const imagePath = await writePngFixture(join(workspace.imagesDir, "scene-c-fixture.png"), { color: "#224466" });

  const server = startMcpServer(t, workspace);

  await server.callToolStrict("asset_create", {
    assetId: "scene-c-asset",
    imagePath,
    prompt: "Scene C test prompt",
  });

  await server.callToolStrict("generation_record", {
    outputAssetId: "scene-c-asset",
    provider: "chatgpt",
    model: "gpt-4o",
    evidence: {
      note: "probe",
      signals: [
        { where: `${home}/Desktop/nested.png`, user: username },
        "plain-signal",
      ],
    },
  });

  const checkExport = (result) => {
    const serialized = JSON.stringify(result);
    const payloadWithoutLabel = serialized.replaceAll(MOSA_C2PA_ASSERTION_LABEL, "");
    assert.equal(serialized.includes(home), false, "Export must not contain os.homedir()");
    assert.equal(serialized.includes("/Users/"), false, "Export must not contain /Users/");
    if (username) {
      const userRe =
        username.length >= 3
          ? new RegExp(`(?<![a-zA-Z0-9])${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-zA-Z0-9])`, "i")
          : new RegExp(`^${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      assert.equal(userRe.test(payloadWithoutLabel), false, "Export must not contain standalone username");
    }
    const events = result.structuredContent.bundle.generation_history.events;
    assert.equal(events.length, 1);
    assert.deepEqual(
      events[0].evidence.signals,
      ["plain-signal"],
      "evidence.signals must drop object items and keep only plain-signal",
    );
  };

  const defaultResult = await server.callToolStrict("asset_provenance_export", {
    assetId: "scene-c-asset",
  });
  checkExport(defaultResult);

  const withPromptsResult = await server.callToolStrict("asset_provenance_export", {
    assetId: "scene-c-asset",
    includePrompts: true,
  });
  checkExport(withPromptsResult);
});

test("Task 374 Rework 1 (Test 2): Object-in-array dropped across sanitizeGenerationEvent, sanitizeGenerationHistory, and sanitizeEvidence", async () => {
  const { home } = getSystemIdentity();
  const base = createPrivacyFixtureStore();
  const leakedObj = { path: `${home}/x.png` };

  const store = {
    ...base.store,
    async getAssetGenerationHistory(project, id) {
      const hist = await base.store.getAssetGenerationHistory(project, id);
      return {
        ...hist,
        // 1. sanitizeGenerationHistory generic array field: generation_ids
        generation_ids: [leakedObj, "keep-me"],
        events: [
          {
            ...hist.events[0],
            // 2. sanitizeGenerationEvent generic array field: parent_generation_ids
            parent_generation_ids: [leakedObj, "keep-me"],
            evidence: {
              ...hist.events[0].evidence,
              // 3. sanitizeEvidence generic array field: signals
              signals: [leakedObj, "keep-me"],
            },
          },
        ],
      };
    },
  };

  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
  const serialized = JSON.stringify(exported);

  assert.equal(serialized.includes("x.png"), false, "Export must not contain leaked object path");
  // Verify each of the 3 sanitizer outputs kept only "keep-me"
  // 1. sanitizeGenerationHistory -> generation_ids
  assert.deepEqual(exported.bundle.generation_history.generation_ids, ["keep-me"]);
  // 2. sanitizeGenerationEvent -> parent_generation_ids
  assert.deepEqual(exported.bundle.generation_history.events[0].parent_generation_ids, ["keep-me"]);
  // 3. sanitizeEvidence -> signals
  assert.deepEqual(exported.bundle.generation_history.events[0].evidence.signals, ["keep-me"]);
});

test("Task 374 Rework 1 (Test 3): Embedded paths in middle of string are blocked by value fallback", async () => {
  const base = createPrivacyFixtureStore();
  const samples = [
    "saved to /Users/someone/a.png",
    "/home/bob/x.png",
    "C:\\Users\\bob\\x.png",
  ];

  for (const sample of samples) {
    const store = {
      ...base.store,
      async getAssetGenerationHistory(project, id) {
        const hist = await base.store.getAssetGenerationHistory(project, id);
        return {
          ...hist,
          events: [
            {
              ...hist.events[0],
              evidence: {
                ...hist.events[0].evidence,
                note: sample,
              },
            },
          ],
        };
      },
    };

    const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
    const ev = exported.bundle.generation_history.events[0].evidence;
    assert.equal("note" in ev, false, `evidence.note must be dropped when value is "${sample}"`);
    assert.equal(JSON.stringify(exported).includes(sample), false);
  }
});

test("Task 374 Rework 1 (Test 4): Standalone word username is blocked while embedded letter substring is preserved", async (t) => {
  const { username } = getSystemIdentity();
  if (!username || username.length < 3) {
    t.skip(`Skipped standalone word boundary test because username "${username}" has length < 3`);
    return;
  }

  const base = createPrivacyFixtureStore();
  const makeStoreWithNote = (noteValue) => ({
    ...base.store,
    async getAssetGenerationHistory(project, id) {
      const hist = await base.store.getAssetGenerationHistory(project, id);
      return {
        ...hist,
        events: [
          {
            ...hist.events[0],
            evidence: {
              ...hist.events[0].evidence,
              note: noteValue,
            },
          },
        ],
      };
    },
  });

  // Case A: "<username>_photo" -> "_" is not [a-zA-Z0-9], so username is a standalone word -> must be dropped
  const exportedDrop = await buildAssetProvenanceBundle(
    makeStoreWithNote(`${username}_photo`),
    "default",
    "e4-leak-test",
  );
  assert.equal(
    "note" in exportedDrop.bundle.generation_history.events[0].evidence,
    false,
    `evidence.note "${username}_photo" must be dropped`,
  );

  // Case B: "x<username>y" -> bounded by ASCII letters -> not a standalone word -> must be preserved
  const safeSubstring = `x${username}y`;
  const exportedKeep = await buildAssetProvenanceBundle(
    makeStoreWithNote(safeSubstring),
    "default",
    "e4-leak-test",
  );
  assert.equal(
    exportedKeep.bundle.generation_history.events[0].evidence.note,
    safeSubstring,
    `evidence.note "${safeSubstring}" must be preserved`,
  );
});

test("Task 374 Rework 1 (Test 5): Prompt with embedded path redacts path to [redacted] instead of dropping whole prompt", async () => {
  const { home } = getSystemIdentity();
  const base = createPrivacyFixtureStore();
  const promptWithRef = `画一张海报，参考 ${home}/Desktop/ref.png`;
  const expectedRedacted = "画一张海报，参考 [redacted]";

  const store = {
    ...base.store,
    async getAsset(project, id) {
      const a = await base.store.getAsset(project, id);
      return {
        ...a,
        prompt: promptWithRef,
        user_prompt: promptWithRef,
        recipe_snapshots: [
          {
            ...a.recipe_snapshots[0],
            effective_prompt: promptWithRef,
            user_prompt: promptWithRef,
          },
        ],
      };
    },
    async getRecipeSnapshotHistory(project, id) {
      const r = await base.store.getRecipeSnapshotHistory(project, id);
      return {
        ...r,
        snapshots: [
          {
            ...r.snapshots[0],
            effective_prompt: promptWithRef,
            user_prompt: promptWithRef,
          },
        ],
      };
    },
    async getAssetGenerationHistory(project, id) {
      const h = await base.store.getAssetGenerationHistory(project, id);
      return {
        ...h,
        events: [
          {
            ...h.events[0],
            effective_prompt: promptWithRef,
            user_prompt: promptWithRef,
          },
        ],
      };
    },
  };

  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test", { includePrompts: true });
  const serialized = JSON.stringify(exported);

  assert.equal(serialized.includes(home), false, "Export must not contain homedir");
  assert.equal(serialized.includes("ref.png"), false, "Export must not contain ref.png");
  assert.equal(exported.bundle.asset.prompt, expectedRedacted);
  assert.equal(exported.bundle.asset.user_prompt, expectedRedacted);
  assert.equal(exported.bundle.recipe_history.snapshots[0].effective_prompt, expectedRedacted);
  assert.equal(exported.bundle.generation_history.events[0].effective_prompt, expectedRedacted);
});

test("Task 374 Rework 1 (Test 6): sanitizeRightsObject enforces RECIPE_RIGHTS_ALLOWLIST", async () => {
  const base = createPrivacyFixtureStore();
  const store = {
    ...base.store,
    async getRecipeSnapshotHistory(project, id) {
      const r = await base.store.getRecipeSnapshotHistory(project, id);
      return {
        ...r,
        snapshots: [
          {
            ...r.snapshots[0],
            references: [
              {
                asset_id: "ref-asset-1",
                role: "style",
                rights: {
                  copyright: "owned",
                  folder: "secret-folder",
                },
              },
            ],
          },
        ],
      };
    },
  };

  const exported = await buildAssetProvenanceBundle(store, "default", "e4-leak-test");
  const exportedRights = exported.bundle.recipe_history.snapshots[0].references[0].rights;

  assert.deepEqual(exportedRights, { copyright: "owned" }, "rights must only keep allowlisted keys");
  assert.equal("folder" in exportedRights, false, "un-allowlisted key folder in rights must be dropped");
  assert.equal(JSON.stringify(exported).includes("secret-folder"), false);
});

function storeWithEvidenceNote(base, note) {
  return {
    ...base.store,
    async getAssetGenerationHistory(project, id) {
      const hist = await base.store.getAssetGenerationHistory(project, id);
      return {
        ...hist,
        events: [{ ...hist.events[0], evidence: { ...hist.events[0].evidence, note } }],
      };
    },
  };
}

function storeWithPrompt(base, prompt) {
  return {
    ...base.store,
    async getAsset(project, id) {
      const asset = await base.store.getAsset(project, id);
      return { ...asset, prompt };
    },
  };
}

test("Task 374 review: lower-case user folders, volumes and drive paths inside a sentence are dropped", async () => {
  const base = createPrivacyFixtureStore();
  for (const note of [
    "saved to /users/bob/x.png",
    "saved to /Volumes/Ext/a.png",
    "saved to D:\\photos\\a.png",
    "path=d:/photos/a.png",
  ]) {
    const exported = await buildAssetProvenanceBundle(storeWithEvidenceNote(base, note), "default", "e4-leak-test");
    const evidence = exported.bundle.generation_history.events[0].evidence;
    assert.equal("note" in evidence, false, `evidence.note must be dropped for "${note}"`);
  }
  // Non-prompt fields drop on any /home/ etc. (safe side); a plain URL and
  // ordinary slashes must not trip the drive-path rule.
  const kept = "see https://example.com/guide 16:9, open 24/7";
  const exported = await buildAssetProvenanceBundle(storeWithEvidenceNote(base, kept), "default", "e4-leak-test");
  assert.equal(exported.bundle.generation_history.events[0].evidence.note, kept, "a note with only a URL and slashes in text is kept");
});

test("Task 374 review: URLs in an exported prompt stay as written while local paths are redacted", async () => {
  const base = createPrivacyFixtureStore();
  const cases = [
    ["参考 https://example.com/a.png 16:9 比例", "参考 https://example.com/a.png 16:9 比例"],
    ["see https://example.com/home/x.png and http://site.test/Users/y", "see https://example.com/home/x.png and http://site.test/Users/y"],
    ["参考 D:\\photos\\a.png 和 /Volumes/Ext/b.png", "参考 [redacted] 和 [redacted]"],
    ["refs: (/users/bob/c.png), \"C:/work/d.png\"", "refs: ([redacted]), \"[redacted]\""],
    ["参考 /Users/bob/a.png，画一张海报", "参考 [redacted]，画一张海报"],
  ];
  for (const [prompt, expected] of cases) {
    const exported = await buildAssetProvenanceBundle(storeWithPrompt(base, prompt), "default", "e4-leak-test", { includePrompts: true });
    assert.equal(exported.bundle.asset.prompt, expected, `prompt "${prompt}"`);
  }
});
