import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

import { createAssetStore } from "../lib/asset-store.mjs";
import { SEARCH_SCOPE_MARKER_KEY, searchableAssetName } from "../lib/asset-search-scope.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==", "base64");
const LEGACY_CREATED = "2024-03-04T00:00:00.000Z";
// The marker the previous whitelist revision wrote; the v3 rebuild runs over
// it and leaves it in place.
const LEGACY_SCOPE_MARKER_KEY = "search_scope_v2";

async function createProjectRoot(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  return root;
}

function openSqliteStore(t, root) {
  const store = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir: join(root, "library"),
  });
  t.after(() => store.close());
  return store;
}

function withRawDatabase(libraryDir, task) {
  const database = new Database(sqliteDatabasePath(libraryDir));
  try {
    return task(database);
  } finally {
    database.close();
  }
}

function markerValue(libraryDir, key) {
  return withRawDatabase(libraryDir, (database) =>
    database.prepare("SELECT value FROM library_meta WHERE key = ?").get(key)?.value || null);
}

async function seedImage(projectRoot, name) {
  const imagePath = join(projectRoot, "generated-images", name);
  await mkdir(dirname(imagePath), { recursive: true });
  await writeFile(imagePath, ONE_PIXEL_PNG);
  return imagePath;
}

test("searchableAssetName strips only the machine-generated name segments", () => {
  const rows = [
    // The task table: every row is one assertion.
    ["sample-01-mv2q2yl0-603cef03.png", "sample-01.png"],
    ["logo-v2-mv2q2yl0-603cef03", "logo-v2"],
    ["scan-20241011-20241012-mv2q2yl0-603cef03", "scan-20241011-20241012"],
    ["logo-mv2q2yl0-603cef03-copy-mv2q3abc-11aa22bb", "logo-copy"],
    ["logo-mv2q2yl0-603cef03-v-mv2q3abc-11aa22bb", "logo-v"],
    ["logo-mv2q2yl0-603cef03-mv2q3abc-11aa22bb-99ff00aa.png", "logo.png"],
    ["web-chatgpt-9acee1ae6579", "web-chatgpt"],
    ["web-flow-video-7779f83b899c", "web-flow-video"],
    ["codex-session-3f9a1c0b7d2e4a55", "codex-session"],
    ["img-20241012.png", "img-20241012.png"],
    ["poster-final.png", "poster-final.png"],
    // Supplementary edges: grok hash tails, stacked copy-of-version markers,
    // case preservation, mid-name UUIDs, a user date kept in front of a hash.
    ["grok-abc123-image-9acee1ae6579", "grok-abc123-image"],
    ["x-v-mv2q2yl0-603cef03-copy-mv2q3abc-11aa22bb", "x-v-copy"],
    ["Sample-01-MV2Q2YL0-603CEF03.PNG", "Sample-01.PNG"],
    ["report-3f9a1c0b-7d2e-4a55-9c1d-2e4a559c1d2e", "report"],
    ["report-20241011-9acee1ae6579", "report-20241011"],
    ["alpha-one-mv2q2yl0-11481916", "alpha-one"],
    ["a--b", "a--b"],
    ["foo-12345678", "foo-12345678"],
    // A user's own "word-date" in front of the real stamp is not a second
    // stamp: only the shapes ingest writes are stripped, and a timestamp word
    // must decode to a moment an asset could have been created at.
    ["birthday-20241012-mv2q2yl0-603cef03", "birthday-20241012"],
    ["my-mountain-20240501-mv2q2yl0-603cef03.png", "my-mountain-20240501.png"],
    ["trip-holidays-20241012", "trip-holidays-20241012"],
    ["trip-zzzzzzzz-20241012", "trip-zzzzzzzz-20241012"],
    // Replace-image on a user "word-date" name keeps the name.
    ["my-mountain-20240501-mv2q2yl0-603cef03-mv2q3abc-11aa22bb-99ff00aa.png", "my-mountain-20240501.png"],
    // Chains of versions / copies, and a copy of a web capture.
    ["x-mv2q2yl0-603cef03-v-mv2q3abc-11aa22bb-v-mv2q3abd-22bb33cc", "x-v-v"],
    ["web-chatgpt-9acee1ae6579-copy-mv2q3abc-11aa22bb", "web-chatgpt-copy"],
    ["codex-session-3f9a1c0b7d2e4a55-1a2b3c4d", "codex-session"],
    ["codex-3f9a1c0b-7d2e-4a55-9c1d-2e4a559c1d2e-ig-poster", "codex-ig-poster"],
    ["my-copy-mv2q2yl0-603cef03", "my-copy"],
    ["", ""],
    [null, ""],
  ];
  for (const [input, want] of rows) {
    assert.equal(searchableAssetName(input), want, JSON.stringify(input));
  }
});

test("a shared timestamp prefix matches nothing while readable name parts still match", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-stamp-");
  const store = openSqliteStore(t, root);
  const alpha = await store.createAsset({ imagePath: await seedImage(join(root, "project"), "alpha-one.png"), prompt: "probe one" });
  await store.createAsset({ imagePath: await seedImage(join(root, "project"), "beta-two.png"), prompt: "probe two" });
  const gamma = await store.createAsset({ imagePath: await seedImage(join(root, "project"), "gamma-v2.png"), prompt: "probe three" });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  // Same-moment imports share the base36 timestamp; its first four characters
  // used to pull every one of them out of the library.
  const stampPrefix = alpha.id.slice("alpha-one-".length, "alpha-one-".length + 4);
  assert.equal(stampPrefix.length, 4, "the id carries the expected timestamp shape");
  assert.deepEqual(await hits(stampPrefix), [], "the shared timestamp prefix is machine text");
  assert.deepEqual(await hits("v2"), [gamma.id], "the short word v2 only matches the readable name");
  assert.equal((await hits("alpha")).length, 1, "alpha only matches its own asset");
});

test("a whole pasted id or file name finds exactly that one asset, on page and in totals", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-exact-");
  const store = openSqliteStore(t, root);
  const alpha = await store.createAsset({ imagePath: await seedImage(join(root, "project"), "alpha-one.png"), prompt: "probe one" });
  await store.createAsset({ imagePath: await seedImage(join(root, "project"), "beta-two.png"), prompt: "probe two" });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);
  const total = async (query) => (await store.listAssetPage({ projectId: "default", query })).page.total;

  const fileName = `${alpha.id}.png`;
  for (const whole of [alpha.id, fileName]) {
    assert.deepEqual(await hits(whole), [alpha.id], `whole-string search "${whole}"`);
    assert.equal(await total(whole), 1, `whole-string total for "${whole}"`);
  }
  // One character less than the full file name is no longer a whole string and
  // the machine segments stay out of the indexes, so nothing may match.
  assert.deepEqual(await hits(fileName.slice(0, -1)), [], "the trimmed file name matches nothing");
});

test("the exact whole string also reaches the collapsed-stack page", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-stack-");
  const store = openSqliteStore(t, root);
  const alpha = await store.createAsset({ imagePath: await seedImage(join(root, "project"), "alpha-one.png"), prompt: "probe one" });
  const beta = await store.createAsset({ imagePath: await seedImage(join(root, "project"), "beta-two.png"), prompt: "probe two" });
  await store.createAssetStack("default", [alpha.id, beta.id], { name: "S-Stack" });
  const filters = { projectId: "default", query: `${alpha.id}.png`, collapseStacks: true };
  const page = await store.listAssetPage(filters);
  assert.deepEqual(page.assets.map((entry) => entry.id), [alpha.id], "the pasted file name finds the member node");
  assert.equal(page.page.total, 1, "the collapsed page counts exactly one node");
});

test("web-capture hash fragments stay out while the provider display name matches", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-capture-");
  const store = openSqliteStore(t, root);
  await store.createAsset({
    imagePath: await seedImage(join(root, "project"), "beta-two.png"),
    assetId: "web-chatgpt-9acee1ae6579",
    prompt: "capture probe",
    source: { type: "web-chatgpt", provider: "chatgpt", user_message: "capture probe" },
  });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  assert.deepEqual(await hits("9acee1"), [], "the content-hash fragment is machine text");
  assert.deepEqual(await hits("chatgpt"), ["web-chatgpt-9acee1ae6579"], "provider value and display name still match");
});

test("a v2-marked library rebuilds once more under the v3 rules", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-v3-");
  const libraryDir = join(root, "library");
  const bootstrap = createSqliteAssetStore({
    projectRoot: join(root, "project"),
    managerDir: join(root, "project", "mosa"),
    libraryDir,
  });
  const seeded = await bootstrap.createAsset({ imagePath: await seedImage(join(root, "project"), "alpha-one.png"), prompt: "probe one" });
  bootstrap.close();
  // Roll the library back to the previous revision: the v2 marker is set and
  // search_text / FTS still carry the raw id and file name with the stamp.
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      const legacyText = `${seeded.id} ${seeded.asset} probe one`;
      database.prepare("UPDATE assets SET search_text = ? WHERE id = ?").run(legacyText, seeded.id);
      database.prepare("DELETE FROM asset_fts WHERE project_id = 'default' AND asset_id = ?").run(seeded.id);
      database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)").run(seeded.id, legacyText);
      database.prepare("DELETE FROM library_meta WHERE key = ?").run(SEARCH_SCOPE_MARKER_KEY);
      database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)")
        .run(LEGACY_SCOPE_MARKER_KEY, LEGACY_CREATED, LEGACY_CREATED);
    })();
  });
  const stampPrefix = seeded.id.slice("alpha-one-".length, "alpha-one-".length + 4);

  const store = openSqliteStore(t, root);
  // Task 347: the rebuild runs from deferred maintenance after the open.
  await store.startDeferredMaintenance();
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);
  assert.ok(markerValue(libraryDir, SEARCH_SCOPE_MARKER_KEY), "the v3 marker is written");
  assert.ok(markerValue(libraryDir, LEGACY_SCOPE_MARKER_KEY), "the old v2 marker is left in place");
  assert.deepEqual(await hits(stampPrefix), [], "the timestamp prefix leaves search after the rebuild");
  assert.deepEqual(await hits("alpha"), [seeded.id], "the readable name still matches");
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT search_text FROM assets WHERE id = ?").get(seeded.id);
    assert.doesNotMatch(row.search_text, new RegExp(`${seeded.id}`), "the rebuilt text carries no raw id");
    assert.match(row.search_text, /alpha-one/, "the rebuilt text keeps the readable name");
  });

  // A raw edit after the rebuild must survive untouched: the v3 marker makes
  // every later open a no-op. (Probed on the stored column: a raw UPDATE
  // cannot keep the FTS row in sync, so search is the wrong probe.)
  withRawDatabase(libraryDir, (database) => {
    database.transaction(() => {
      const row = database.prepare("SELECT search_text FROM assets WHERE id = ?").get(seeded.id);
      database.prepare("UPDATE assets SET search_text = ? WHERE id = ?").run(`${row.search_text} zzq9-again`, seeded.id);
    })();
  });
  store.close();
  openSqliteStore(t, root);
  withRawDatabase(libraryDir, (database) => {
    const row = database.prepare("SELECT search_text FROM assets WHERE id = ?").get(seeded.id);
    assert.match(row.search_text, /zzq9-again/, "no second rebuild once the v3 marker is set");
  });
  assert.ok(markerValue(libraryDir, SEARCH_SCOPE_MARKER_KEY), "the v3 marker stays");
});

test("the in-memory JSON store scores the same searchable names", async (t) => {
  const root = await createProjectRoot(t, "mosa-search-name-json-");
  const projectRoot = join(root, "project");
  const store = createAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
  assert.equal(store.storageKind, "json");
  const alpha = await store.createAsset({ imagePath: await seedImage(projectRoot, "alpha-one.png"), prompt: "probe one" });
  await store.createAsset({ imagePath: await seedImage(projectRoot, "beta-two.png"), prompt: "probe two" });
  const gamma = await store.createAsset({ imagePath: await seedImage(projectRoot, "gamma-v2.png"), prompt: "probe three" });
  const hits = async (query) => (await store.listAssets({ projectId: "default", query })).map((entry) => entry.id);

  const stampPrefix = alpha.id.slice("alpha-one-".length, "alpha-one-".length + 4);
  assert.deepEqual(await hits(stampPrefix), [], "timestamp prefix matches nothing");
  assert.deepEqual(await hits("v2"), [gamma.id], "readable name tail matches");
  assert.deepEqual(await hits("alpha"), [alpha.id], "readable name head matches");
  assert.deepEqual(await hits(alpha.id), [alpha.id], "whole id hits via the exact comparison");
  assert.deepEqual(await hits(`${alpha.id}.png`), [alpha.id], "whole file name hits via the exact comparison");
  assert.deepEqual(await hits(`${alpha.id}.pn`), [], "the trimmed file name matches nothing");
  await store.close?.();
});
