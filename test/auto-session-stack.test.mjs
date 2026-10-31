import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";

import { createSqliteAssetStore, CURRENT_SCHEMA_VERSION } from "../lib/sqlite-asset-store.mjs";
import { createWebCaptureIngest } from "../lib/web-capture-ingest.js";
import { handleBridgeRoute } from "../lib/api/bridge-routes.mjs";
import {
  CANONICAL_SOURCE_TYPES,
  GENERATION_SESSION_SOURCE_RULES,
  GENERATION_SESSION_TITLE_MAX_LENGTH,
  generationSessionKey,
  generationSessionTitle,
} from "../lib/generation-session.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");

async function createFixtureStore(t, prefix = "mosa-auto-session-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const projectRoot = join(root, "project");
  const libraryDir = join(root, "library");
  const generatedDir = join(projectRoot, "generated-images");
  await mkdir(generatedDir, { recursive: true });
  const sourcePath = join(generatedDir, "fixture.png");
  await writeFile(sourcePath, ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => store.close());
  return { store, sourcePath, root, projectRoot, libraryDir };
}

function chatgptSource(conversationId, extra = {}) {
  return { type: "web-chatgpt", conversation_id: conversationId, ...extra };
}

async function ingest(store, sourcePath, assetId, createdAt, source) {
  return store.createAsset({ assetId, imagePath: sourcePath, prompt: `fixture ${assetId}`, created_at: createdAt, source });
}

async function stackOf(store, projectId) {
  const page = await store.listAssetPage({ projectId, limit: 0, collapseStacks: true });
  return page.assets.find((asset) => asset.stack)?.stack || null;
}

async function stackNodesOf(store, projectId) {
  const page = await store.listAssetPage({ projectId, limit: 0, collapseStacks: true });
  return page.assets.filter((asset) => asset.stack).map((asset) => asset.stack);
}

// The exclusion table has no store API on purpose; tests read it through a
// second connection, the same pattern the sabotage test uses.
function exclusionRows(libraryDir) {
  const database = new Database(join(libraryDir, "mosa.db"));
  try {
    return database.prepare("SELECT asset_id, session_key FROM auto_stack_exclusions ORDER BY asset_id").all();
  } finally {
    database.close();
  }
}

// --- generationSessionKey: the shared convention (pure functions, no store) ---

test("generationSessionKey extracts the five documented source sessions", () => {
  assert.equal(generationSessionKey({ source: { type: "web-chatgpt", conversation_id: "conv-123" } }), "web-chatgpt:conv-123");
  assert.equal(generationSessionKey({ source: { type: "web-chatgpt" } }), "", "ChatGPT image without conversation_id has no session");
  assert.equal(generationSessionKey({ source: { type: "web-chatgpt", conversation_id: "bad id!" } }), "", "ids outside the id alphabet are rejected");
  assert.equal(generationSessionKey({ source: { type: "web-flow", page_url: "https://flow.google.com/project/P-7_X" } }), "web-flow:P-7_X");
  assert.equal(generationSessionKey({ source: { type: "web-flow", page_url: "https://labs.google/fx/tools/flow/project/P-7_X" } }), "web-flow:P-7_X", "both Flow hosts key on the project id");
  assert.equal(generationSessionKey({ source: { type: "web-flow", page_url: "https://flow.google.com/" } }), "", "Flow homepage has no session");
  assert.equal(generationSessionKey({ source: { type: "web-google-ai-studio", page_url: "https://aistudio.google.com/prompts/ab12cd" } }), "web-google-ai-studio:ab12cd");
  assert.equal(generationSessionKey({ source: { type: "web-google-ai-studio", page_url: "https://aistudio.google.com/prompts/new_chat" } }), "", "AI Studio placeholder prompt is not a session");
  assert.equal(generationSessionKey({ source: { type: "web-gemini", page_url: "https://gemini.google.com/app/gx_1" } }), "web-gemini:gx_1");
  assert.equal(generationSessionKey({ source: { type: "web-gemini" } }), "", "Gemini image without page_url has no session");
  assert.equal(generationSessionKey({ source: { type: "codex-generated", codex_task_id: "task_42" } }), "codex-generated:task_42");
  assert.equal(generationSessionKey({ source: { type: "codex-generated" } }), "");
  assert.equal(generationSessionKey({ source: { type: "grok-generated" } }), "", "Grok carries no session yet");
  assert.equal(generationSessionKey({ source: { provider: "chatgpt", conversation_id: "c-9" } }), "web-chatgpt:c-9", "provider-only sources canonicalise before extraction");
});

test("generationSessionKey applies the generic generation_session_id convention to any source", () => {
  assert.equal(generationSessionKey({ source: { type: "grok-generated", generation_session_id: "gs-1" } }), "grok-generated:gs-1");
  assert.equal(generationSessionKey({ source: { type: "web-chatgpt", conversation_id: "conv-1", generation_session_id: "gs-2" } }), "web-chatgpt:gs-2", "the generic field wins over per-source extraction");
  assert.equal(generationSessionKey({ source: { type: "grok-generated", generation_session_id: "   " } }), "", "blank strings are no session");
  assert.equal(generationSessionKey({ source: { type: "grok-generated", generation_session_id: 42 } }), "", "non-strings are no session");
  assert.equal(generationSessionKey({ source: { type: "grok-generated", generation_session_id: "x".repeat(300) } }), "", "pathological values stay out of the key");
});

test("every canonical source type is classified in the session rule table", () => {
  for (const sourceType of CANONICAL_SOURCE_TYPES) {
    assert.ok(
      GENERATION_SESSION_SOURCE_RULES[sourceType] === "extractor" || GENERATION_SESSION_SOURCE_RULES[sourceType] === "none",
      `${sourceType} must be classified as extractor or none`,
    );
  }
  for (const sourceType of Object.keys(GENERATION_SESSION_SOURCE_RULES)) {
    assert.ok(CANONICAL_SOURCE_TYPES.has(sourceType), `${sourceType} in the rule table must be a canonical source type`);
  }
});

test("generationSessionTitle reads the documented fallback chain, trims, and caps length", () => {
  assert.equal(generationSessionTitle({ source: { generation_session_title: "  Title A  " } }), "Title A");
  assert.equal(generationSessionTitle({ source: { conversation_title: "Title B" } }), "Title B");
  assert.equal(generationSessionTitle({ source: { page_title: "Title C" } }), "Title C");
  assert.equal(generationSessionTitle({ source: { generation_session_title: "  ", conversation_title: "Fallback" } }), "Fallback", "blank entries fall through");
  assert.equal(generationSessionTitle({ source: { conversation_title: "Keep" } }).length, 4);
  assert.equal(generationSessionTitle({ source: { page_title: "x".repeat(200) } }).length, GENERATION_SESSION_TITLE_MAX_LENGTH);
  assert.equal(generationSessionTitle({ source: {} }), "");
  assert.equal(generationSessionTitle({}), "");
});

// --- ingest-time auto stacking ---

test("same-session ingests stay loose at one image, stack at two with the newest cover, and update cover at three", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "g1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-1"));
  assert.equal(await stackOf(store, "default"), null, "the first image of a session is not stacked");

  await ingest(store, sourcePath, "g2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-1"));
  const stack = await stackOf(store, "default");
  assert.ok(stack, "the second image creates the auto stack");
  assert.equal(stack.count, 2);

  await ingest(store, sourcePath, "g3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-1"));
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.count, 3, "the third image appends instead of forking");
  assert.equal(summary.cover_asset_id, "g3", "the latest ingest is the cover");
  assert.equal(summary.origin, "auto", "stackSummary exposes origin");
  assert.equal(summary.session_key, "web-chatgpt:conv-1", "stackSummary exposes session_key");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["g3", "g2", "g1"],
  );
});

test("a session title names the auto stack when it arrives with a later image", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "n1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-t"));
  await ingest(store, sourcePath, "n2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-t"));
  const stack = await stackOf(store, "default");
  assert.equal(stack.name, "", "no source title yet, so the stack stays unnamed");

  await ingest(store, sourcePath, "n3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-t", { conversation_title: "  Neon Session  " }));
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.name, "Neon Session", "the later image's title backfills the unnamed stack");
});

test("new session images merge into the manual stack already holding the session's first image", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "h1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-m"));
  await ingest(store, sourcePath, "other1", "2026-06-01T12:00:00.000Z", { type: "local-file" });
  const manual = await store.createAssetStack("default", ["h1", "other1"], { coverAssetId: "h1" });
  assert.equal(manual.origin, "manual");

  await ingest(store, sourcePath, "h2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-m"));
  await ingest(store, sourcePath, "h3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-m", { conversation_title: "Manual Title" }));
  assert.equal((await stackNodesOf(store, "default")).length, 1, "no separate auto stack is created");
  const summary = await store.getAssetStack("default", manual.id);
  assert.equal(summary.count, 4, "both new images merged into the manual stack");
  assert.equal(summary.name, "", "a manual stack that also holds a local file keeps its empty name");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", manual.id)).assets.map((asset) => asset.id),
    ["h1", "other1", "h2", "h3"],
    "new images append at the end in ingest order",
  );

  await store.renameAssetStack("default", manual.id, "My Picks");
  await ingest(store, sourcePath, "h4", "2026-06-04T00:00:00.000Z", chatgptSource("conv-m", { conversation_title: "Other Title" }));
  assert.equal((await store.getAssetStack("default", manual.id)).name, "My Picks", "a renamed manual stack keeps its name too");
});

test("an unnamed manual stack holding only one session takes that session's title; a named one keeps its name", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "p1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-p"));
  await ingest(store, sourcePath, "p2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-p"));
  // p2 joined an auto stack on ingest; rebuild the pair as a hand-made stack.
  const [auto] = await stackNodesOf(store, "default");
  await store.dissolveAssetStack("default", auto.id);
  const manual = await store.createAssetStack("default", ["p1", "p2"], { coverAssetId: "p1" });
  assert.equal(manual.origin, "manual");

  await ingest(store, sourcePath, "p3", "2026-06-02T00:00:00.000Z", chatgptSource("conv-p", { conversation_title: "Pure Chat" }));
  const named = await store.getAssetStack("default", manual.id);
  assert.equal(named.count, 3, "the new image merged into the manual stack");
  assert.equal(named.name, "Pure Chat", "a single-session manual stack nobody named picks up the title");

  await store.renameAssetStack("default", manual.id, "Hand Named");
  await ingest(store, sourcePath, "p4", "2026-06-03T00:00:00.000Z", chatgptSource("conv-p", { conversation_title: "Later Title" }));
  assert.equal((await store.getAssetStack("default", manual.id)).name, "Hand Named", "a user-named manual stack is never renamed");
});

test("a mixed manual stack absorbs new images from every session it already holds", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "a1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-a"));
  await ingest(store, sourcePath, "b1", "2026-06-01T06:00:00.000Z", chatgptSource("conv-b"));
  const mixed = await store.createAssetStack("default", ["a1", "b1"], { coverAssetId: "a1" });

  await ingest(store, sourcePath, "b2", "2026-06-01T07:00:00.000Z", chatgptSource("conv-b"));
  await ingest(store, sourcePath, "a2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-a"));
  await ingest(store, sourcePath, "b3", "2026-06-02T06:00:00.000Z", chatgptSource("conv-b"));
  assert.equal((await stackNodesOf(store, "default")).length, 1, "sessions A and B both keep growing the one manual stack");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", mixed.id)).assets.map((asset) => asset.id),
    ["a1", "b1", "b2", "a2", "b3"],
    "each session's new image appends at the end",
  );
});

test("the stack holding the most session images wins; ties go to the older stack", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  // Four unstacked same-session images: each pair auto-stacks first, then the
  // user pulls both out (which also excludes them) to distribute them by hand.
  await ingest(store, sourcePath, "w1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-w"));
  await ingest(store, sourcePath, "w2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-w"));
  await store.removeAssetsFromStack("default", (await stackNodesOf(store, "default"))[0].id, ["w1", "w2"]);
  await ingest(store, sourcePath, "w3", "2026-06-01T02:00:00.000Z", chatgptSource("conv-w"));
  await ingest(store, sourcePath, "w4", "2026-06-01T03:00:00.000Z", chatgptSource("conv-w"));
  await store.removeAssetsFromStack("default", (await stackNodesOf(store, "default"))[0].id, ["w3", "w4"]);
  await ingest(store, sourcePath, "o1", "2026-06-01T12:00:00.000Z", { type: "local-file" });
  await ingest(store, sourcePath, "o2", "2026-06-01T13:00:00.000Z", { type: "local-file" });
  const minority = await store.createAssetStack("default", ["w1", "o1"], { coverAssetId: "w1" });
  const majority = await store.createAssetStack("default", ["w2", "w3", "w4", "o2"], { coverAssetId: "w2" });

  await ingest(store, sourcePath, "w5", "2026-06-02T00:00:00.000Z", chatgptSource("conv-w"));
  assert.deepEqual(
    (await store.listAssetStackAssets("default", majority.id)).assets.map((asset) => asset.id),
    ["w2", "w3", "w4", "o2", "w5"],
    "the stack with three session images absorbs the new one",
  );
  assert.deepEqual(
    (await store.listAssetStackAssets("default", minority.id)).assets.map((asset) => asset.id),
    ["w1", "o1"],
    "the stack with one session image is untouched",
  );

  // Same shape at one image each, across a different session: the older stack
  // wins. Pin the created_at so the tie-break never hinges on millisecond
  // timing of the two createAssetStack calls.
  await ingest(store, sourcePath, "t1", "2026-06-02T01:00:00.000Z", chatgptSource("conv-t"));
  await ingest(store, sourcePath, "t2", "2026-06-02T02:00:00.000Z", chatgptSource("conv-t"));
  await store.removeAssetsFromStack("default", (await stackNodesOf(store, "default"))[0].id, ["t1", "t2"]);
  await ingest(store, sourcePath, "p1", "2026-06-02T12:00:00.000Z", { type: "local-file" });
  await ingest(store, sourcePath, "p2", "2026-06-02T13:00:00.000Z", { type: "local-file" });
  const older = await store.createAssetStack("default", ["t1", "p1"], { coverAssetId: "t1" });
  const newer = await store.createAssetStack("default", ["t2", "p2"], { coverAssetId: "t2" });
  const pin = new Database(join(libraryDir, "mosa.db"));
  try {
    pin.prepare("UPDATE asset_stacks SET created_at = '2020-01-01T00:00:00.000Z' WHERE project_id = 'default' AND id = ?").run(older.id);
  } finally {
    pin.close();
  }

  await ingest(store, sourcePath, "t3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-t"));
  assert.deepEqual(
    (await store.listAssetStackAssets("default", older.id)).assets.map((asset) => asset.id),
    ["t1", "p1", "t3"],
    "an even split goes to the older stack",
  );
  assert.deepEqual(
    (await store.listAssetStackAssets("default", newer.id)).assets.map((asset) => asset.id),
    ["t2", "p2"],
    "the younger stack is untouched",
  );
});

test("removing an image from an auto stack excludes it, while later session images keep joining", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "r1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-r"));
  await ingest(store, sourcePath, "r2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-r"));
  await ingest(store, sourcePath, "r3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-r"));
  const stack = await stackOf(store, "default");

  await store.removeAssetsFromStack("default", stack.id, ["r1"]);
  await ingest(store, sourcePath, "r4", "2026-06-04T00:00:00.000Z", chatgptSource("conv-r"));
  assert.deepEqual(
    (await store.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["r4", "r3", "r2"],
    "the removed image never returns; the new image still joins",
  );

  await store.dissolveAssetStack("default", stack.id);
  await ingest(store, sourcePath, "r5", "2026-06-05T00:00:00.000Z", chatgptSource("conv-r"));
  assert.equal(await stackOf(store, "default"), null, "after a dissolve, one new image alone does not restack the old members");

  await ingest(store, sourcePath, "r6", "2026-06-06T00:00:00.000Z", chatgptSource("conv-r"));
  const rebuilt = await stackOf(store, "default");
  assert.ok(rebuilt, "two fresh session images stack again");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", rebuilt.id)).assets.map((asset) => asset.id),
    ["r6", "r5"],
    "the rebuilt stack holds only post-dissolve images",
  );
});

test("removing a session image from a manual stack excludes it, and the stack still absorbs new images", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await ingest(store, sourcePath, "v1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-v"));
  await ingest(store, sourcePath, "other1", "2026-06-01T12:00:00.000Z", { type: "local-file" });
  const manual = await store.createAssetStack("default", ["v1", "other1"], { coverAssetId: "v1" });
  await ingest(store, sourcePath, "v2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-v"));
  assert.deepEqual(
    (await store.listAssetStackAssets("default", manual.id)).assets.map((asset) => asset.id),
    ["v1", "other1", "v2"],
  );

  await store.removeAssetsFromStack("default", manual.id, ["v1"]);
  assert.deepEqual(
    exclusionRows(libraryDir),
    [{ asset_id: "v1", session_key: "web-chatgpt:conv-v" }],
    "the removed image is tombstoned under its own session key",
  );

  await ingest(store, sourcePath, "v3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-v"));
  assert.deepEqual(
    (await store.listAssetStackAssets("default", manual.id)).assets.map((asset) => asset.id),
    ["other1", "v2", "v3"],
    "the removed image never returns; the new image still joins the manual stack",
  );
  assert.equal((await stackNodesOf(store, "default")).length, 1, "no separate auto stack is created");
  const page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  assert.ok(page.assets.find((asset) => asset.id === "v1" && !asset.stack), "the removed image stays loose");
});

test("dissolving a manual stack keeps its session members from being re-stacked", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await ingest(store, sourcePath, "d1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-d"));
  await ingest(store, sourcePath, "other1", "2026-06-01T12:00:00.000Z", { type: "local-file" });
  const manual = await store.createAssetStack("default", ["d1", "other1"], { coverAssetId: "d1" });
  await ingest(store, sourcePath, "d2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-d"));
  await ingest(store, sourcePath, "d3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-d"));

  await store.dissolveAssetStack("default", manual.id);
  assert.deepEqual(
    exclusionRows(libraryDir),
    [
      { asset_id: "d1", session_key: "web-chatgpt:conv-d" },
      { asset_id: "d2", session_key: "web-chatgpt:conv-d" },
      { asset_id: "d3", session_key: "web-chatgpt:conv-d" },
    ],
    "every session member is tombstoned under its own key; session-less images are not",
  );

  await ingest(store, sourcePath, "d4", "2026-06-04T00:00:00.000Z", chatgptSource("conv-d"));
  assert.equal(await stackOf(store, "default"), null, "one new image alone does not restack anything");

  await ingest(store, sourcePath, "d5", "2026-06-05T00:00:00.000Z", chatgptSource("conv-d"));
  const rebuilt = await stackOf(store, "default");
  assert.ok(rebuilt, "two fresh images build a new auto stack");
  assert.equal((await store.getAssetStack("default", rebuilt.id)).origin, "auto");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", rebuilt.id)).assets.map((asset) => asset.id),
    ["d5", "d4"],
    "the dissolved stack's members stay out of the rebuilt stack",
  );
});

test("images without a session identity leave no exclusions behind", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await ingest(store, sourcePath, "e1", "2026-06-01T00:00:00.000Z", { type: "local-file" });
  await ingest(store, sourcePath, "e2", "2026-06-01T01:00:00.000Z", { type: "local-file" });
  await ingest(store, sourcePath, "e3", "2026-06-01T02:00:00.000Z", { type: "local-file" });
  const manual = await store.createAssetStack("default", ["e1", "e2", "e3"], { coverAssetId: "e1" });

  await store.removeAssetsFromStack("default", manual.id, ["e1"]);
  await store.dissolveAssetStack("default", manual.id);
  assert.deepEqual(exclusionRows(libraryDir), [], "no session key, no tombstone");
});

test("permanently deleting an asset clears its auto-stack exclusion so a re-import can stack", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await ingest(store, sourcePath, "p1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-p"));
  await ingest(store, sourcePath, "p2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-p"));
  await ingest(store, sourcePath, "p3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-p"));
  const stack = await stackOf(store, "default");
  assert.ok(stack, "three session images auto-stack");
  await store.removeAssetsFromStack("default", stack.id, ["p1"]);
  assert.deepEqual(exclusionRows(libraryDir), [{ asset_id: "p1", session_key: "web-chatgpt:conv-p" }]);

  await store.deleteAsset("default", "p1");
  await store.permanentlyDeleteAsset("default", "p1");
  assert.deepEqual(exclusionRows(libraryDir), [], "permanent delete removes the exclusion tombstone");

  // Web capture derives asset ids from content, so re-importing the same file
  // reuses the id; with the tombstone gone it must stack again.
  await ingest(store, sourcePath, "p1", "2026-06-05T00:00:00.000Z", chatgptSource("conv-p"));
  const rebuilt = await stackOf(store, "default");
  assert.ok(rebuilt, "the surviving stack absorbs the re-imported image");
  assert.deepEqual(
    (await store.listAssetStackAssets("default", rebuilt.id)).assets.map((asset) => asset.id),
    ["p1", "p3", "p2"],
    "the re-imported image joins the stack it was once pulled out of",
  );
});

test("a renamed auto stack keeps its name even when later images carry a session title", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "k1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-k"));
  await ingest(store, sourcePath, "k2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-k"));
  const stack = await stackOf(store, "default");
  await store.renameAssetStack("default", stack.id, "My Curated Set");

  await ingest(store, sourcePath, "k3", "2026-06-03T00:00:00.000Z", chatgptSource("conv-k", { conversation_title: "Auto Title" }));
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.name, "My Curated Set", "name_locked wins over the incoming session title");
});

test("different sessions never mix, and both Flow hosts merge into one session", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "fa1", "2026-06-01T00:00:00.000Z", { type: "web-flow", page_url: "https://flow.google.com/project/P1" });
  await ingest(store, sourcePath, "fb1", "2026-06-01T06:00:00.000Z", { type: "web-chatgpt", conversation_id: "conv-x" });
  assert.equal(await stackOf(store, "default"), null, "one image per session stays loose");

  await ingest(store, sourcePath, "fa2", "2026-06-02T00:00:00.000Z", { type: "web-flow", page_url: "https://labs.google/fx/tools/flow/project/P1" });
  const flowStack = await stackOf(store, "default");
  const flowSummary = await store.getAssetStack("default", flowStack.id);
  assert.equal(flowSummary.session_key, "web-flow:P1", "the two Flow URL shapes share one session");
  assert.deepEqual((await store.listAssetStackAssets("default", flowStack.id)).assets.map((asset) => asset.id), ["fa2", "fa1"]);

  await ingest(store, sourcePath, "fb2", "2026-06-02T06:00:00.000Z", chatgptSource("conv-x"));
  const page = await store.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  const stackSummaries = await Promise.all(
    page.assets.filter((asset) => asset.stack).map((asset) => store.getAssetStack("default", asset.stack.id)),
  );
  const stackKeys = stackSummaries.map((summary) => summary.session_key).sort();
  assert.deepEqual(stackKeys, ["web-chatgpt:conv-x", "web-flow:P1"], "each session owns exactly one stack node");
  assert.equal((await store.listAssetStackAssets("default", flowStack.id)).assets.length, 2, "no cross-session members");
});

test("the generic convention auto-stacks a source that has no dedicated extractor", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "gs1", "2026-06-01T00:00:00.000Z", { type: "grok-generated", generation_session_id: "grok-s1" });
  await ingest(store, sourcePath, "gs2", "2026-06-02T00:00:00.000Z", { type: "grok-generated", generation_session_id: "grok-s1" });
  const stack = await stackOf(store, "default");
  assert.ok(stack, "two same-session grok images stack via the generic convention");
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.session_key, "grok-generated:grok-s1", "filling generation_session_id is all a new source needs");
});

test("a failed auto-stack write still leaves the asset ingested", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "x1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-x-fail"));
  // Sabotage the exclusion probe so the stacking step throws after the asset
  // row committed; ingest must survive and stacking is skipped wholesale.
  const sabotage = new Database(join(store.libraryDir, "mosa.db"));
  sabotage.exec("DROP TABLE auto_stack_exclusions");
  sabotage.close();

  const created = await ingest(store, sourcePath, "x2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-x-fail"));
  assert.equal(created.id, "x2");
  const raw = await store.listAssets({ projectId: "default" });
  assert.deepEqual(raw.map((asset) => asset.id).sort(), ["x1", "x2"], "the ingest itself succeeded");
  assert.equal(await stackOf(store, "default"), null, "stacking was skipped instead of failing the ingest");
});

// --- migration backfill ---

async function seedLegacyV15Library(t) {
  const { store, sourcePath, root, projectRoot, libraryDir } = await createFixtureStore(t, "mosa-auto-session-backfill-");
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = "2026-05-01T00:00:00.000Z";
  database.prepare("UPDATE library_meta SET value = '15' WHERE key = 'schema_version'").run();
  const insert = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/legacy', 'hash', '', '', '', '', '{}', '',
      0, 0, '', '', 0, '', 'web-chatgpt', @source, '{}', '',
      '', '', 'web-chatgpt', 'image', 'web-chatgpt', @conversation, '',
      @created, @epoch, @created, @id
    )
  `);
  const addAsset = (id, createdAt, source) => insert.run({
    id,
    asset: `${id}.png`,
    source: JSON.stringify(source),
    conversation: source.conversation_id || "",
    created: createdAt,
    epoch: Date.parse(createdAt),
  });
  database.transaction(() => {
    addAsset("b1", "2026-05-01T00:00:00.000Z", chatgptSource("conv-b1", { conversation_title: "Backfilled Chat" }));
    addAsset("b2", "2026-05-01T01:00:00.000Z", chatgptSource("conv-b1"));
    addAsset("b3", "2026-05-01T02:00:00.000Z", chatgptSource("conv-b1"));
    addAsset("solo", "2026-05-02T00:00:00.000Z", chatgptSource("conv-solo"));
    addAsset("trashed1", "2026-05-03T00:00:00.000Z", chatgptSource("conv-trash"));
    addAsset("trashed2", "2026-05-03T01:00:00.000Z", chatgptSource("conv-trash"));
    database.prepare("UPDATE assets SET deleted_at = '2026-05-04T00:00:00.000Z' WHERE id = 'trashed2'").run();
    addAsset("manual1", "2026-05-05T00:00:00.000Z", chatgptSource("conv-manual"));
    addAsset("manual2", "2026-05-05T01:00:00.000Z", chatgptSource("conv-manual"));
    database.prepare("INSERT INTO asset_stacks (project_id, id, created_at, updated_at) VALUES ('default', 'stack-manual', ?, ?)").run(timestamp, timestamp);
    database.prepare("INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at) VALUES ('default', 'stack-manual', 'manual1', 0, ?)").run(timestamp);
    database.prepare("INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at) VALUES ('default', 'stack-manual', 'manual2', 1, ?)").run(timestamp);
  })();
  database.close();
  return { root, projectRoot, libraryDir };
}

test("the migration backfill stacks qualifying sessions once and leaves manual stacks and trash alone", async (t) => {
  const { root, projectRoot, libraryDir } = await seedLegacyV15Library(t);
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());

  const delta = await reopened.listLibraryChangesSince("default", 0);
  assert.ok(
    delta.changes.some((change) => change.kind === "library-backfilled"),
    "the backfill announces one full-refresh change",
  );

  const manual = await reopened.getAssetStack("default", "stack-manual");
  assert.equal(manual.origin, "manual", "the pre-existing manual stack keeps manual origin");
  assert.deepEqual((await reopened.listAssetStackAssets("default", "stack-manual")).assets.map((asset) => asset.id), ["manual1", "manual2"]);

  const page = await reopened.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  const stackNodes = page.assets.filter((asset) => asset.stack);
  const autoNode = stackNodes.find((asset) => asset.stack.id !== "stack-manual");
  assert.ok(autoNode, "the qualifying session was backfilled into an auto stack");
  assert.equal(autoNode.stack.count, 3);
  const summary = await reopened.getAssetStack("default", autoNode.stack.id);
  assert.equal(summary.origin, "auto");
  assert.equal(summary.session_key, "web-chatgpt:conv-b1");
  assert.equal(summary.name, "Backfilled Chat", "the backfilled stack picks up the session title");
  assert.deepEqual(
    (await reopened.listAssetStackAssets("default", autoNode.stack.id)).assets.map((asset) => asset.id),
    ["b3", "b2", "b1"],
  );

  const raw = await reopened.listAssets({ projectId: "default", trash: true });
  assert.ok(raw.some((asset) => asset.id === "trashed2"), "trashed images stay out of the backfill but exist");
  assert.equal((await reopened.listAssetPage({ projectId: "default", query: "conv-solo", limit: 0 })).assets.length, 0);
  const soloNode = page.assets.find((asset) => asset.id === "solo");
  assert.ok(soloNode && !soloNode.stack, "a single-image session is not stacked");
  const trashedNode = page.assets.find((asset) => asset.id === "trashed1");
  assert.ok(trashedNode && !trashedNode.stack, "a session whose other image is trashed is not stacked");

  reopened.close();
  const again = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const secondDelta = await again.listLibraryChangesSince("default", 0);
  assert.equal(
    secondDelta.changes.filter((change) => change.kind === "library-backfilled").length,
    1,
    "reopening the library does not run the backfill twice",
  );
  assert.equal((await again.getAssetStack("default", autoNode.stack.id)).count, 3);
  again.close();
});

test("the backfill appends to an auto stack that predates it instead of forking a duplicate", async (t) => {
  const { store, sourcePath, libraryDir, projectRoot } = await createFixtureStore(t, "mosa-auto-session-backfill-append-");
  await ingest(store, sourcePath, "p1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-p"));
  await ingest(store, sourcePath, "p2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-p"));
  const stack = await stackOf(store, "default");
  store.close();

  // Park an eligible unstacked member of the same session as a legacy row, then
  // force the backfill gate to run again on the next open.
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = "2026-05-01T00:00:00.000Z";
  database.prepare("UPDATE library_meta SET value = '15' WHERE key = 'schema_version'").run();
  database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', 'p0', 'p0.png', '/legacy', 'hash2', '', '', '', '', '{}', '',
      0, 0, '', '', 0, '', 'web-chatgpt', '{"type":"web-chatgpt","conversation_id":"conv-p"}', '{}', '',
      '', '', 'web-chatgpt', 'image', 'web-chatgpt', 'conv-p', '',
      '2026-05-31T00:00:00.000Z', 0, '2026-05-31T00:00:00.000Z', 'p0'
    )
  `).run();
  database.prepare("UPDATE assets SET created_at_epoch = ? WHERE id = 'p0'").run(Date.parse("2026-05-31T00:00:00.000Z"));
  database.prepare("DELETE FROM library_changes").run();
  database.close();

  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());
  assert.deepEqual(
    (await reopened.listAssetStackAssets("default", stack.id)).assets.map((asset) => asset.id),
    ["p2", "p1", "p0"],
    "the backfill joins the existing session stack (re-sorted newest-first) instead of creating a second one",
  );
});

async function seedLegacyV15LibraryWithManualTargets(t) {
  const { store, sourcePath, root, projectRoot, libraryDir } = await createFixtureStore(t, "mosa-auto-session-backfill-target-");
  store.close();
  const database = new Database(join(libraryDir, "mosa.db"));
  const timestamp = "2026-05-01T00:00:00.000Z";
  database.prepare("UPDATE library_meta SET value = '15' WHERE key = 'schema_version'").run();
  const insert = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/legacy', 'hash', '', '', '', '', '{}', '',
      0, 0, '', '', 0, '', 'web-chatgpt', @source, '{}', '',
      '', '', 'web-chatgpt', 'image', 'web-chatgpt', @conversation, '',
      @created, @epoch, @created, @id
    )
  `);
  const addAsset = (id, createdAt, source) => insert.run({
    id,
    asset: `${id}.png`,
    source: JSON.stringify(source),
    conversation: source.conversation_id || "",
    created: createdAt,
    epoch: Date.parse(createdAt),
  });
  database.transaction(() => {
    // Session A: two images already stacked, five loose — seeded out of
    // chronological order so the append order proves the created_at sort, and
    // one carries a title the manual stack must refuse.
    addAsset("a1", "2026-05-01T00:00:00.000Z", chatgptSource("conv-a"));
    addAsset("a2", "2026-05-01T01:00:00.000Z", chatgptSource("conv-a"));
    addAsset("a3", "2026-05-01T10:00:00.000Z", chatgptSource("conv-a", { conversation_title: "A Chat" }));
    addAsset("a4", "2026-05-01T12:00:00.000Z", chatgptSource("conv-a"));
    addAsset("a5", "2026-05-01T09:00:00.000Z", chatgptSource("conv-a"));
    addAsset("a6", "2026-05-01T13:00:00.000Z", chatgptSource("conv-a"));
    addAsset("a7", "2026-05-01T11:00:00.000Z", chatgptSource("conv-a"));
    // Session B: one stacked member, one loose image — a single loose image
    // still merges when a target stack exists.
    addAsset("b1", "2026-05-02T00:00:00.000Z", chatgptSource("conv-b"));
    addAsset("b2", "2026-05-02T05:00:00.000Z", chatgptSource("conv-b"));
    // Session C: never touched a manual stack, two loose images.
    addAsset("c1", "2026-05-02T06:00:00.000Z", chatgptSource("conv-c", { conversation_title: "Fresh Chat" }));
    addAsset("c2", "2026-05-02T07:00:00.000Z", chatgptSource("conv-c"));
    // Session D: never touched a manual stack, one loose image.
    addAsset("d1", "2026-05-02T08:00:00.000Z", chatgptSource("conv-d"));

    database.prepare("INSERT INTO asset_stacks (project_id, id, created_at, updated_at) VALUES ('default', 'stack-manual-target', ?, ?)").run(timestamp, timestamp);
    const member = database.prepare("INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at) VALUES ('default', 'stack-manual-target', ?, ?, ?)");
    member.run("a1", 0, timestamp);
    member.run("a2", 1, timestamp);
    member.run("b1", 2, timestamp);
  })();
  database.close();
  return { root, projectRoot, libraryDir };
}

test("the backfill merges a session into the manual stack already holding its images", async (t) => {
  const { root, projectRoot, libraryDir } = await seedLegacyV15LibraryWithManualTargets(t);
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  t.after(() => reopened.close());

  const manual = await reopened.getAssetStack("default", "stack-manual-target");
  assert.equal(manual.origin, "manual");
  assert.equal(manual.count, 9, "both targeted sessions merged every loose image into the manual stack");
  assert.equal(manual.name, "", "a manual stack mixing sessions A and B stays unnamed even though A carries a title");
  assert.deepEqual(
    (await reopened.listAssetStackAssets("default", "stack-manual-target")).assets.map((asset) => asset.id),
    ["a1", "a2", "b1", "a5", "a3", "a7", "a4", "a6", "b2"],
    "appended at the end in ingest-time order, single-image sessions included",
  );

  const page = await reopened.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  const stackNodes = page.assets.filter((asset) => asset.stack);
  assert.equal(stackNodes.length, 2, "only the manual stack and session C's fresh auto stack exist");
  const autoNode = stackNodes.find((asset) => asset.stack.id !== "stack-manual-target");
  const autoSummary = await reopened.getAssetStack("default", autoNode.stack.id);
  assert.equal(autoSummary.origin, "auto");
  assert.equal(autoSummary.session_key, "web-chatgpt:conv-c", "sessions without a manual target still follow the ≥2 rule");
  assert.equal(autoSummary.name, "Fresh Chat");
  assert.deepEqual((await reopened.listAssetStackAssets("default", autoNode.stack.id)).assets.map((asset) => asset.id), ["c2", "c1"]);
  const soloNode = page.assets.find((asset) => asset.id === "d1");
  assert.ok(soloNode && !soloNode.stack, "a single-image session with no manual target stays loose");
});

// --- performance (50k-style budget probe at 5k scale, same gate as performance.test.mjs) ---

test("5k-library backfill and single ingest stay fast with session keys", { skip: process.env.MOSA_PERF_TEST !== "1" }, async (t) => {
  const { store, libraryDir, projectRoot } = await createFixtureStore(t, "mosa-auto-session-perf-");
  store.close();

  // Build a v15-shaped library: 5000 ChatGPT images across 500 conversations,
  // raw-written without session keys, plus a manual stack slice.
  const database = new Database(join(libraryDir, "mosa.db"));
  const insert = database.prepare(`
    INSERT INTO assets (
      project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio, business_fields_json, theme,
      favorite, archived, group_name, category, rating, version_change, source_type, source_json, metadata_json, search_text,
      tags_text, business_search_text, source_search_text, media_kind, source_group, conversation_id, generation_batch,
      created_at, created_at_epoch, updated_at, sort_name
    ) VALUES (
      'default', @id, @asset, '/perf', 'hash', 'perf fixture', '', '', '', '{}', '',
      0, 0, '', '', 0, '', 'web-chatgpt', @source, '{}', '',
      '', '', 'web-chatgpt', 'image', 'web-chatgpt', @conversation, '',
      @created, @epoch, @created, @id
    )
  `);
  const base = Date.parse("2026-05-01T00:00:00.000Z");
  database.transaction(() => {
    for (let index = 0; index < 5000; index += 1) {
      const conversation = `conv-${index % 500}`;
      const created = new Date(base + index * 60_000).toISOString();
      insert.run({
        id: `perf-${index}`,
        asset: `perf-${index}.png`,
        source: JSON.stringify({ type: "web-chatgpt", conversation_id: conversation }),
        conversation,
        created,
        epoch: base + index * 60_000,
      });
    }
    // Ten conversations already live in manual stacks (five members each): the
    // backfill must merge their remaining loose images into those stacks, and
    // the ingest probe below must reach conv-7 through the manual-target rule.
    for (let stackIndex = 0; stackIndex < 10; stackIndex += 1) {
      database.prepare("INSERT INTO asset_stacks (project_id, id, created_at, updated_at) VALUES ('default', ?, ?, ?)")
        .run(`stack-manual-${stackIndex}`, "2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
      const member = database.prepare("INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at) VALUES ('default', ?, ?, ?, ?)");
      for (let memberIndex = 0; memberIndex < 5; memberIndex += 1) {
        member.run(`stack-manual-${stackIndex}`, `perf-${stackIndex + memberIndex * 500}`, memberIndex, "2026-04-01T00:00:00.000Z");
      }
    }
  })();
  database.prepare("UPDATE library_meta SET value = '15' WHERE key = 'schema_version'").run();
  database.close();

  const backfillStarted = performance.now();
  const reopened = createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir });
  const backfillMs = performance.now() - backfillStarted;
  t.after(() => reopened.close());
  const stacked = await reopened.listAssetPage({ projectId: "default", limit: 0, collapseStacks: true });
  assert.equal(stacked.assets.filter((asset) => asset.stack).length, 500, "every conversation collapsed into exactly one stack node");

  const imagePath = join(projectRoot, "generated-images", "fixture.png");
  const sessionIngestStarted = performance.now();
  await reopened.createAsset({
    assetId: "perf-new-session",
    imagePath,
    prompt: "perf new session",
    source: { type: "web-chatgpt", conversation_id: "conv-7" },
  });
  const sessionIngestMs = performance.now() - sessionIngestStarted;
  const afterJoinNode = stacked.assets.find((asset) => asset.id === "perf-7");
  assert.ok(afterJoinNode?.stack, "conversation 7 collapsed into one node");
  const afterJoin = await reopened.getAssetStack("default", afterJoinNode.stack.id);
  assert.equal(afterJoin.count, 11, "the new ingest joined the existing session stack");
  assert.equal(afterJoin.origin, "manual", "the ingest reached conv-7 through its pre-existing manual stack");

  const freshIngestStarted = performance.now();
  await reopened.createAsset({
    assetId: "perf-loose",
    imagePath,
    prompt: "perf loose",
    source: { type: "local-file" },
  });
  const freshIngestMs = performance.now() - freshIngestStarted;

  t.diagnostic(`5k backfill open=${backfillMs.toFixed(1)}ms session ingest=${sessionIngestMs.toFixed(1)}ms plain ingest=${freshIngestMs.toFixed(1)}ms`);
  assert.ok(backfillMs < 3000, `5k backfill open ${backfillMs.toFixed(1)}ms exceeded 3000ms`);
  assert.ok(sessionIngestMs < 500, `session ingest ${sessionIngestMs.toFixed(1)}ms exceeded 500ms`);
  assert.ok(freshIngestMs < 500, `plain ingest ${freshIngestMs.toFixed(1)}ms exceeded 500ms`);
});

// --- applySessionTitle: naming an existing stack from a reported title (77) ---

test("applySessionTitle names an unnamed auto stack and announces one stack-updated change", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t);
  await ingest(store, sourcePath, "n1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-apply-auto"));
  await ingest(store, sourcePath, "n2", "2026-06-02T00:00:00.000Z", chatgptSource("conv-apply-auto"));
  const stack = await stackOf(store, "default");
  assert.equal(stack.name, "", "precondition: the auto stack has no name yet");
  const sortNameBefore = new Database(join(libraryDir, "mosa.db"))
    .prepare("SELECT sort_name FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stack.id).sort_name;

  const revisionBefore = (await store.listLibraryChangesSince("default", 0)).currentRevision;
  const outcome = await store.applySessionTitle("default", "web-chatgpt:conv-apply-auto", "  Reported Title  ");
  assert.deepEqual(outcome, { stackId: stack.id, renamed: true });
  const summary = await store.getAssetStack("default", stack.id);
  assert.equal(summary.name, "Reported Title");

  const row = new Database(join(libraryDir, "mosa.db"))
    .prepare("SELECT name, sort_name FROM asset_stacks WHERE project_id = 'default' AND id = ?").get(stack.id);
  assert.notEqual(row.sort_name, sortNameBefore, "sort_name is recomputed with the name");
  assert.equal(row.name, "Reported Title");

  const changes = (await store.listLibraryChangesSince("default", revisionBefore)).changes
    .filter((change) => change.kind === "stack-updated");
  assert.equal(changes.length, 1, "exactly one stack-updated announcement");
  assert.equal(changes[0].entityId, stack.id);
});

test("applySessionTitle names an unnamed manual stack that holds only this session", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "q1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-apply-manual"));
  await ingest(store, sourcePath, "q2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-apply-manual"));
  const [auto] = await stackNodesOf(store, "default");
  await store.dissolveAssetStack("default", auto.id);
  const manual = await store.createAssetStack("default", ["q1", "q2"], { coverAssetId: "q1" });

  const outcome = await store.applySessionTitle("default", "web-chatgpt:conv-apply-manual", "Single Session");
  assert.deepEqual(outcome, { stackId: manual.id, renamed: true });
  assert.equal((await store.getAssetStack("default", manual.id)).name, "Single Session");
});

test("applySessionTitle refuses a manual stack mixing sessions, a locked name, and any existing name", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  // Mixed manual stack.
  await ingest(store, sourcePath, "m1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-apply-mixed"));
  await ingest(store, sourcePath, "stranger", "2026-06-01T06:00:00.000Z", { type: "local-file" });
  const mixed = await store.createAssetStack("default", ["m1", "stranger"], { coverAssetId: "m1" });
  assert.deepEqual(
    await store.applySessionTitle("default", "web-chatgpt:conv-apply-mixed", "Mixed Chat"),
    { stackId: mixed.id, renamed: false },
    "a mixed manual stack keeps its empty name",
  );
  assert.equal((await store.getAssetStack("default", mixed.id)).name, "");

  // User-renamed (locked) stack.
  await ingest(store, sourcePath, "l1", "2026-06-02T00:00:00.000Z", chatgptSource("conv-apply-locked"));
  await ingest(store, sourcePath, "l2", "2026-06-02T01:00:00.000Z", chatgptSource("conv-apply-locked"));
  const locked = await stackOf(store, "default");
  await store.renameAssetStack("default", locked.id, "Hand Named");
  assert.deepEqual(
    await store.applySessionTitle("default", "web-chatgpt:conv-apply-locked", "Reported Title"),
    { stackId: locked.id, renamed: false },
    "name_locked freezes reported titles too",
  );
  assert.equal((await store.getAssetStack("default", locked.id)).name, "Hand Named");

  // Auto stack that already carries a session title (unlocked but named).
  await ingest(store, sourcePath, "t1", "2026-06-03T00:00:00.000Z", chatgptSource("conv-apply-named", { conversation_title: "First Title" }));
  await ingest(store, sourcePath, "t2", "2026-06-03T01:00:00.000Z", chatgptSource("conv-apply-named"));
  const named = (await stackNodesOf(store, "default")).find((node) => node.id !== locked.id && node.id !== mixed.id);
  assert.equal((await store.getAssetStack("default", named.id)).name, "First Title");
  assert.deepEqual(
    await store.applySessionTitle("default", "web-chatgpt:conv-apply-named", "Second Title"),
    { stackId: named.id, renamed: false },
    "a stack that already has a name is never re-named",
  );
  assert.equal((await store.getAssetStack("default", named.id)).name, "First Title");
});

test("applySessionTitle with no target stack, no session key, or no title does nothing", async (t) => {
  const { store, sourcePath } = await createFixtureStore(t);
  await ingest(store, sourcePath, "z1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-apply-none"));
  await ingest(store, sourcePath, "z2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-apply-none"));
  const stack = await stackOf(store, "default");

  assert.deepEqual(
    await store.applySessionTitle("default", "web-chatgpt:conv-never-seen", "Ghost Chat"),
    { stackId: "", renamed: false },
    "no stack holds this session yet",
  );
  assert.deepEqual(await store.applySessionTitle("default", "", "No Session"), { stackId: "", renamed: false });
  assert.deepEqual(await store.applySessionTitle("default", "web-chatgpt:conv-apply-none", "   "), { stackId: "", renamed: false });
  assert.equal((await store.getAssetStack("default", stack.id)).name, "", "the named session's stack stayed unnamed");
});

// --- the /api/ingest/web-capture-session-title bridge route ---

function sessionTitleJsonRequest(body, headers = {}) {
  const req = new EventEmitter();
  req.method = "POST";
  // Task 314: the capture routes reserve the declared Content-Length before
  // reading, so the fake request declares its real body size.
  req.headers = { "content-length": String(Buffer.byteLength(JSON.stringify(body))), ...headers };
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function stubJsonResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(payload = "") {
      this.body += payload;
    },
  };
}

test("the session-title route names stacks with a token and rejects missing tokens and bad ids", async (t) => {
  const { store, sourcePath, libraryDir } = await createFixtureStore(t, "mosa-session-title-route-");
  await ingest(store, sourcePath, "r1", "2026-06-01T00:00:00.000Z", chatgptSource("conv-apply-route"));
  await ingest(store, sourcePath, "r2", "2026-06-01T01:00:00.000Z", chatgptSource("conv-apply-route"));
  const stack = await stackOf(store, "default");
  const capture = createWebCaptureIngest({
    store,
    libraryDir,
    projectId: "default",
    token: "route-secret",
    allowedOrigins: ["chrome-extension://example-extension"],
  });
  const url = new URL("http://127.0.0.1:43517/api/ingest/web-capture-session-title");
  const call = async (body, headers = {}) => {
    const routeResponse = stubJsonResponse();
    const claimed = await handleBridgeRoute({
      req: sessionTitleJsonRequest(body, headers),
      res: routeResponse,
      url,
      context: { store, webCaptureIngest: capture },
    });
    return { claimed, routeResponse };
  };

  await assert.rejects(
    call({ provider: "chatgpt", conversationId: "conv-apply-route", title: "No Token" }),
    (error) => error.statusCode === 401,
    "a missing bearer token is unauthorized",
  );
  await assert.rejects(
    call({ provider: "chatgpt", conversationId: "not a conversation id!", title: "Bad Id" }, { authorization: "Bearer route-secret" }),
    (error) => error.statusCode === 400,
    "an unusable conversation id is a client error",
  );
  await assert.rejects(
    call({ provider: "flow", conversationId: "conv-apply-route", title: "Wrong Provider" }, { authorization: "Bearer route-secret" }),
    (error) => error.statusCode === 400,
    "only chatgpt carries a reported title today",
  );

  const { claimed, routeResponse: res } = await call(
    { provider: "chatgpt", conversationId: "conv-apply-route", title: "Route Named" },
    { authorization: "Bearer route-secret" },
  );
  assert.equal(claimed, true, "the route claims its path");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { stackId: stack.id, renamed: true });
  assert.equal((await store.getAssetStack("default", stack.id)).name, "Route Named");
});
