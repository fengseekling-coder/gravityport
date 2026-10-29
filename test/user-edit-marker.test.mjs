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
  // A hand-edited prompt is a user edit: the status describes the new prompt,
  // so the caller's (or the page's) prompt_status no longer wins.
  assert.equal(patched.source.prompt_status, "user-edited");
  assert.equal(patched.business_fields.prompt_status, "user-edited");
  assert.equal(patched.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z", "markers are applied after patch source");
});

test("withUserEditMarkers handles a missing current asset", () => {
  const patched = withUserEditMarkers(null, { prompt: "first prompt" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z");
});

test("a hand-edited prompt records prompt_status user-edited in source and business_fields", () => {
  const current = {
    prompt: "site prompt",
    source: { provider: "chatgpt", prompt_status: "generation-tool-prompt" },
    business_fields: { prompt_status: "generation-tool-prompt", user_message: "做一张海报", width: 1024 },
  };
  const patched = withUserEditMarkers(current, { prompt: "USER EDIT: my own poster" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_status, "user-edited");
  assert.equal(patched.business_fields.prompt_status, "user-edited");
  assert.equal(patched.business_fields.user_message, "做一张海报", "other business fields survive");
  assert.equal(patched.business_fields.width, 1024);
  assert.ok(patched.source.prompt_user_edited_at);
  assert.ok(patched.source.user_edited_at);
});

test("clearing the prompt is not a hand edit: marker drops, status returns to not-available", () => {
  const current = {
    prompt: "site prompt",
    source: { provider: "chatgpt", prompt_status: "user-edited", prompt_user_edited_at: "2020-01-01T00:00:00.000Z", user_edited_at: "2020-01-01T00:00:00.000Z" },
    business_fields: { prompt_status: "user-edited", width: 512 },
  };
  const patched = withUserEditMarkers(current, { prompt: "   " }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, null, "the stale marker is cleared");
  assert.equal(patched.source.prompt_status, "not-available");
  assert.equal(patched.business_fields.prompt_status, "not-available");
  assert.equal(patched.business_fields.width, 512);
  assert.equal(patched.source.user_edited_at, "2020-01-01T00:00:00.000Z", "clearing only the prompt stamps no fresh user_edited_at");
  const previousThemeMarker = undefined;
  assert.equal(patched.source.theme_user_edited_at, previousThemeMarker);
});

test("clearing the prompt alongside a real text change still stamps the other edit", () => {
  const current = { prompt: "site prompt", theme: "old name", source: { prompt_status: "user-edited", prompt_user_edited_at: "2020-01-01T00:00:00.000Z" } };
  const patched = withUserEditMarkers(current, { prompt: "", theme: "my name" }, "2026-10-28T00:00:00.000Z");
  assert.equal(patched.source.prompt_user_edited_at, null, "the prompt marker still clears");
  assert.equal(patched.source.prompt_status, "not-available");
  assert.equal(patched.source.theme_user_edited_at, "2026-10-28T00:00:00.000Z", "the rename is a real edit");
  assert.equal(patched.source.user_edited_at, "2026-10-28T00:00:00.000Z");
});

test("callers cannot set or clear the edit markers through the patch source", () => {
  const current = { prompt: "site prompt", source: { provider: "chatgpt", prompt_user_edited_at: "2020-01-01T00:00:00.000Z", user_edited_at: "2020-01-01T00:00:00.000Z" } };
  // A tag-only patch that tries to wipe the markers changes nothing about them.
  const untouched = withUserEditMarkers(current, { tags: ["x"], source: { prompt_user_edited_at: null, user_edited_at: null } }, "2026-10-28T00:00:00.000Z");
  assert.equal(untouched.source.prompt_user_edited_at, "2020-01-01T00:00:00.000Z");
  assert.equal(untouched.source.user_edited_at, "2020-01-01T00:00:00.000Z");
  // Even a real prompt edit cannot smuggle marker values through the source.
  const edited = withUserEditMarkers(current, { prompt: "new", source: { prompt_user_edited_at: "1999-01-01T00:00:00.000Z", theme_user_edited_at: "1999-01-01T00:00:00.000Z" } }, "2026-10-28T00:00:00.000Z");
  assert.equal(edited.source.prompt_user_edited_at, "2026-10-28T00:00:00.000Z");
  assert.equal(edited.source.theme_user_edited_at, undefined);
});

test("a whitespace-equal prompt patch keeps the stored markers and applies no status change", () => {
  const current = { prompt: "site prompt", source: { prompt_status: "generation-tool-prompt", prompt_user_edited_at: "2020-01-01T00:00:00.000Z" } };
  const patch = { prompt: "  site prompt  ", source: { prompt_status: "user-edited" } };
  const patched = withUserEditMarkers(current, patch, "2026-10-28T00:00:00.000Z");
  assert.equal(patched, patch, "no text change and no marker keys: patch returned untouched");
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

test("update_metadata records the hand edit as prompt_status user-edited and cannot clear markers through source", async (t) => {
  const workspace = await createMcpWorkspace(t);
  const server = startMcpServer(t, workspace);
  await server.request("initialize", {});

  const imagePath = await writePngFixture(join(workspace.imagesDir, "mcp-marker.png"));
  await server.callToolStrict("asset_create", {
    assetId: "mcp-marker",
    imagePath,
    prompt: "A flat red square",
  });
  const edited = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-marker",
    prompt: "USER EDIT: my own square",
  });
  assert.ok(edited.structuredContent.asset.source.prompt_user_edited_at);
  assert.equal(edited.structuredContent.asset.source.prompt_status, "user-edited", "the recipe snapshot must stop calling it the site's prompt");
  assert.equal(edited.structuredContent.asset.business_fields.prompt_status, "user-edited");

  // The MCP tool schema cannot carry a `source` at all, so a marker wipe can
  // only be attempted by callers that pass raw patches (HTTP PATCH); the
  // marker-ignoring rule itself is covered in the pure withUserEditMarkers
  // tests above. Here: a later metadata edit must keep both the marker and
  // the user-edited status.
  const later = await server.callToolStrict("asset_update_metadata", {
    assetId: "mcp-marker",
    tags: ["just-a-tag"],
  });
  assert.ok(later.structuredContent.asset.source.prompt_user_edited_at);
  assert.ok(later.structuredContent.asset.source.user_edited_at);
  assert.equal(later.structuredContent.asset.source.prompt_status, "user-edited");
});
