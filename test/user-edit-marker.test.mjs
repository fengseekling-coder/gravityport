import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createMcpWorkspace, startMcpServer, writePngFixture } from "./helpers/mcp-server-harness.mjs";
import { isPromptUserEdited, isThemeUserEdited, withUserEditMarkers } from "../lib/user-edit-marker.mjs";

test("withUserEditMarkers stamps prompt and user markers only on real text changes", () => {
  const current = { prompt: "A flat red square", theme: "red square", source: { provider: "chatgpt" } };
  const patched = withUserEditMarkers(current, { prompt: "USER EDIT: A flat red square" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.prompt, "USER EDIT: A flat red square");
  assert.equal(patched.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.theme_user_edited_at, undefined);
  assert.equal(patched.source.provider, "chatgpt", "stored source must survive the merge");
  assert.deepEqual(current.source, { provider: "chatgpt" }, "input must not be mutated");
});

test("withUserEditMarkers treats whitespace-only differences as unchanged", () => {
  const current = { prompt: "A flat red square", theme: "t", source: {} };
  const patch = { prompt: "  A flat red square  " };
  assert.equal(withUserEditMarkers(current, patch, "2026-10-28T00:00:00.000Z"), patch);
});

test("withUserEditMarkers ignores non-text fields like tags and references", () => {
  const current = { prompt: "p", theme: "t", source: {} };
  const patch = { tags: ["new-tag"], favorite: true };
  assert.equal(withUserEditMarkers(current, patch, "2026-10-28T00:00:00.000Z"), patch);
});

test("withUserEditMarkers stamps theme marker and user marker for a rename", () => {
  const patched = withUserEditMarkers({ prompt: "p", theme: "old" }, { theme: "狐狸（我改的）" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.theme_user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, undefined);
});

test("withUserEditMarkers stamps only user_edited_at for other text fields", () => {
  const patched = withUserEditMarkers({ prompt: "p", skill: "photo" }, { skill: "illustration" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, undefined);
  assert.equal(patched.source.theme_user_edited_at, undefined);
});

test("withUserEditMarkers merges patch source above stored source, markers last", () => {
  const current = { prompt: "old", source: { provider: "chatgpt", prompt_status: "user-message", prompt_user_edited_at: "2020-01-01T00:00:00.000Z" } };
  const patched = withUserEditMarkers(current, { prompt: "newer", source: { prompt_status: "generation-tool-prompt" } }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.provider, "chatgpt");
  assert.equal(patched.source.prompt_status, "generation-tool-prompt", "patch source wins over stored source");
  assert.equal(patched.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z", "markers are applied after patch source");
});

test("withUserEditMarkers handles a missing current asset", () => {
  const patched = withUserEditMarkers(null, { prompt: "first prompt" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z");
});

test("isPromptUserEdited and isThemeUserEdited read the source markers", () => {
  assert.equal(isPromptUserEdited({ source: { prompt_user_edited_at: "2026-10-28T00:00:00.000Z" } }), true);
  assert.equal(isPromptUserEdited({ source: {} }), false);
  assert.equal(isPromptUserEdited(null), false);
  assert.equal(isThemeUserEdited({ source: { theme_user_edited_at: "2026-10-28T00:00:00.000Z" } }), true);
  assert.equal(isThemeUserEdited({ source: { prompt_user_edited_at: "2026-10-28T00:00:00.000Z" } }), false);
  assert.equal(isThemeUserEdited({}), false);
});

test("asset_update_metadata stamps user-edit markers through the MCP server", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", {});

  const imagePath = await writePngFixture(join(workspace.imagesDir, "mcp-edit.png"));
  const created = await server.callToolStrict("asset_create", {
    assetId: "mcp-edit",
    imagePath,
    prompt: "A flat red square",
  });
  assert.equal(created.structuredContent.asset.source.prompt_user_edited_at, undefined);

  const updated = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-edit",
    prompt: "USER EDIT: A flat red square",
  });
  assert.ok(updated.structuredContent.asset.source.prompt_user_edited_at, "update_metadata must stamp the prompt marker");
  assert.ok(updated.structuredContent.asset.source.user_edited_at);

  const renamed = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-edit",
    theme: "狐狸（我改的）",
  });
  assert.ok(renamed.structuredContent.asset.source.theme_user_edited_at, "update_metadata must stamp the theme marker");
  assert.ok(renamed.structuredContent.asset.source.prompt_user_edited_at, "earlier prompt marker must survive");

  const tagged = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-edit",
    tags: ["just-a-tag"],
  });
  assert.equal(typeof tagged.structuredContent.asset.source.user_edited_at, "string");
  const promptMarkerFromTagEdit = tagged.structuredContent.asset.source.prompt_user_edited_at;
  assert.ok(promptMarkerFromTagEdit, "marker from the earlier text edit is retained");

  const reattached = await server.callToolStrict("asset_attach_prompt", {
    assetId: "mcp-edit",
    prompt: "Attached by the assistant",
  });
  assert.ok(reattached.structuredContent.asset.source.prompt_user_edited_at);
});

test("a tag-only update_metadata stamps no user-edit markers", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", {});

  const imagePath = await writePngFixture(join(workspace.imagesDir, "mcp-tag.png"));
  await server.callToolStrict("asset_create", {
    assetId: "mcp-tag",
    imagePath,
    prompt: "A flat red square",
  });
  const tagged = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-tag",
    tags: ["only-tags"],
  });
  assert.equal(tagged.structuredContent.asset.source.prompt_user_edited_at, undefined);
  assert.equal(tagged.structuredContent.asset.source.theme_user_edited_at, undefined);
  assert.equal(tagged.structuredContent.asset.source.user_edited_at, undefined);
});
