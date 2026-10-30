// Library Change Journal（SQLite）store 级与 HTTP 契约测试。
// 覆盖：变更记录的 kind 覆盖面、变更与 mutation 的同事务原子性（回滚不留
// journal）、journal 容量边界、跨进程重启的 delta 连续性、gallery-rows 的
// 受影响行映射（折叠 Stack / Stack 视图 / 回收站）以及 delta 路由。
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { createSqliteAssetStore, LIBRARY_CHANGE_JOURNAL_LIMIT } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function createStore(t, name = "library") {
  const root = await mkdtemp(join(tmpdir(), `mosa-library-changes-${name}-`));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const store = createSqliteAssetStore({
    projectRoot: root,
    managerDir: root,
    libraryDir: join(root, name),
    initializeFreshLibrary: true,
  });
  t.after(() => { try { store.close(); } catch { /* already closed */ } });
  await store.ensureProject("default");
  return { store, root, generated, imagePath: join(generated, "pixel.png") };
}

async function createSampleAsset(store, imagePath, assetId, extra = {}) {
  return store.createAsset({ assetId, imagePath, prompt: `prompt ${assetId}`, ...extra });
}

async function journalKinds(store, since = 0) {
  const delta = await store.listLibraryChangesSince("default", since);
  return delta.changes.map((change) => change.kind);
}

test("every core mutation writes a typed journal entry and advances the revision", async (t) => {
  const { store, imagePath } = await createStore(t);

  const assetA = await createSampleAsset(store, imagePath, "chg-a");
  const assetB = await createSampleAsset(store, imagePath, "chg-b");
  assert.deepEqual(await journalKinds(store, 0), ["asset-added", "asset-added"]);

  await store.toggleFavorite("default", assetA.id);
  const delta = await store.listLibraryChangesSince("default", 2);
  assert.equal(delta.currentRevision, 3);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["asset-updated"]);
  assert.deepEqual(delta.changes[0].flags, ["favorite"]);
  assert.equal(delta.complete, true, "since the oldest revision the delta is complete");

  const stack = await store.createAssetStack("default", [assetA.id, assetB.id], { coverAssetId: assetA.id });
  assert.deepEqual(await journalKinds(store, 3), ["stack-created"]);

  const member = await createSampleAsset(store, imagePath, "chg-member");
  await store.addAssetsToStack("default", stack.id, [member.id]);
  const membersDelta = await store.listLibraryChangesSince("default", 4);
  assert.deepEqual(membersDelta.changes.map((change) => change.kind), ["asset-added", "stack-members-changed"]);

  await store.removeAssetsFromStack("default", stack.id, [member.id]);
  await store.reorderAssetStack("default", stack.id, [assetB.id, assetA.id]);
  const reorderDelta = await store.listLibraryChangesSince("default", 6);
  assert.deepEqual(reorderDelta.changes.map((change) => change.kind), ["stack-members-changed", "stack-order-changed"]);

  await store.dissolveAssetStack("default", stack.id);
  const dissolveDelta = await store.listLibraryChangesSince("default", 8);
  assert.deepEqual(dissolveDelta.changes.map((change) => change.kind), ["stack-dissolved"]);
  assert.deepEqual(dissolveDelta.changes[0].assetIds.sort(), [assetA.id, assetB.id], "dissolution names every unmapped member");

  await store.updateMetadata("default", assetA.id, { prompt: "renamed prompt" });
  await store.deleteAsset("default", assetA.id);
  await store.restoreAsset("default", assetA.id);
  await store.deleteAsset("default", assetA.id);
  await store.permanentlyDeleteAsset("default", assetA.id);
  const lifecycleDelta = await store.listLibraryChangesSince("default", 9);
  assert.deepEqual(lifecycleDelta.changes.map((change) => change.kind), [
    "asset-updated",
    "asset-deleted",
    "asset-restored",
    "asset-deleted",
    "asset-permanently-deleted",
  ]);

  await store.createGroup({ projectId: "default", name: "ChGroup" });
  await store.renameGroup("default", "ChGroup", "ChGroup2");
  await store.deleteGroup("default", "ChGroup2", {});
  const groupDelta = await store.listLibraryChangesSince("default", 14);
  assert.deepEqual(groupDelta.changes.map((change) => change.kind), ["group-created", "group-renamed", "group-deleted"]);
});

test("generation events and relation mutations participate in the library journal", async (t) => {
  const { store, imagePath } = await createStore(t);
  const parentAsset = await createSampleAsset(store, imagePath, "generation-parent");
  const childAsset = await createSampleAsset(store, imagePath, "generation-child");
  const baseline = Number.parseInt(await store.libraryRevision(), 10);

  const parent = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: parentAsset.id,
    provider: "chatgpt",
    capture_context_id: "journal-parent",
    effective_prompt: "parent",
    verification_level: "observed",
  });
  const child = await store.recordGenerationEvent({
    project_id: "default",
    output_asset_id: childAsset.id,
    provider: "chatgpt",
    capture_context_id: "journal-child",
    effective_prompt: "child",
    verification_level: "observed",
  });
  await store.recordGenerationRelation({
    project_id: "default",
    child_generation_id: child.id,
    parent_generation_id: parent.id,
    relation_type: "edited_from",
    verification_level: "observed",
  });

  const delta = await store.listLibraryChangesSince("default", baseline);
  assert.deepEqual(delta.changes.map((change) => change.kind), [
    "generation-updated",
    "generation-updated",
    "generation-relation-updated",
  ]);
  assert.deepEqual(delta.changes[0].assetIds, [parentAsset.id]);
  assert.deepEqual(new Set(delta.changes[2].assetIds), new Set([parentAsset.id, childAsset.id]));
});

test("a rolled-back mutation leaves no journal row behind (same-transaction guarantee)", async (t) => {
  const { store, imagePath } = await createStore(t);
  await createSampleAsset(store, imagePath, "atom-a");
  const archived = await createSampleAsset(store, imagePath, "atom-archived", { archived: true });
  const before = await store.libraryRevision();

  // createAssetStack 校验到 archived 成员时整个事务回滚，journal 不得留下痕迹。
  await assert.rejects(
    store.createAssetStack("default", ["atom-a", archived.id], { coverAssetId: "atom-a" }),
    /Archived asset cannot be stacked/,
  );
  assert.equal(await store.libraryRevision(), before, "revision is untouched by the failed mutation");
  assert.deepEqual(await journalKinds(store, 2), [], "no journal rows for a rolled-back mutation");
});

test("journal retention stays bounded and old revisions report an explicit gap", async (t) => {
  const { store, imagePath } = await createStore(t);
  const database = new Database(join(store.libraryDir, "mosa.db"));
  // 直接批量灌入超限的历史行（模拟长期运行），下一次 mutation 触发剪枝。
  const insert = database.prepare(`
    INSERT INTO library_changes (project_id, revision, kind, entity_type, entity_id, created_at)
    VALUES ('default', ?, 'asset-updated', 'asset', 'history', '2026-01-01')
  `);
  database.transaction(() => {
    for (let index = 1; index <= LIBRARY_CHANGE_JOURNAL_LIMIT + 500; index += 1) insert.run(index);
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES ('library_revision', ?, '2026-01-01')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(LIBRARY_CHANGE_JOURNAL_LIMIT + 500));
  })();
  database.close();

  // 一次真实 mutation 触发同事务剪枝。
  await store.createGroup({ projectId: "default", name: "PruneTrigger" });
  const state = await store.libraryChangeState("default");
  const delta = await store.listLibraryChangesSince("default", 1);
  assert.equal(delta.complete, false, "a pruned baseline reports the gap instead of a truncated delta");
  assert.equal(state.revision >= LIBRARY_CHANGE_JOURNAL_LIMIT, true);
  const pruned = new Database(join(store.libraryDir, "mosa.db"));
  const count = pruned.prepare("SELECT COUNT(*) AS count FROM library_changes").get().count;
  pruned.close();
  assert.ok(count <= LIBRARY_CHANGE_JOURNAL_LIMIT, `journal is bounded (${count})`);
});

test("delta continuity survives a store restart (crash-safe journal)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-changes-restart-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const libraryDir = join(root, "library");
  const options = { projectRoot: root, managerDir: root, libraryDir, initializeFreshLibrary: true };

  const first = createSqliteAssetStore(options);
  await first.ensureProject("default");
  await createSampleAsset(first, join(generated, "pixel.png"), "restart-a");
  const revisionBefore = Number.parseInt(await first.libraryRevision(), 10);
  first.close();

  const second = createSqliteAssetStore(options);
  t.after(() => { try { second.close(); } catch { /* already closed */ } });
  assert.equal(Number.parseInt(await second.libraryRevision(), 10), revisionBefore, "revision counter persists with the journal");
  const delta = await second.listLibraryChangesSince("default", 0);
  assert.deepEqual(delta.changes.map((change) => change.kind), ["asset-added"]);
  await createSampleAsset(second, join(generated, "pixel.png"), "restart-b");
  const delta2 = await second.listLibraryChangesSince("default", 1);
  assert.deepEqual(delta2.changes.map((change) => change.kind), ["asset-added"]);
});

test("an empty project treats another project's global revision as a complete empty delta", async (t) => {
  const { store } = await createStore(t);
  await store.ensureProject("other-project");
  await store.createGroup({ projectId: "other-project", name: "OtherGroup" });

  const delta = await store.listLibraryChangesSince("default", 0);
  assert.equal(delta.complete, true);
  assert.deepEqual(delta.changes, []);
  assert.ok(Number(delta.currentRevision) >= 1, "the shared revision may advance outside the requested project");
});

test("listGalleryRowsForAssets maps affected members to their stack node under gallery semantics", async (t) => {
  const { store, imagePath } = await createStore(t);
  const cover = await createSampleAsset(store, imagePath, "rows-cover");
  const member = await createSampleAsset(store, imagePath, "rows-member");
  const stray = await createSampleAsset(store, imagePath, "rows-stray");
  await store.createAssetStack("default", [cover.id, member.id], { coverAssetId: cover.id });

  const collapsed = await store.listGalleryRowsForAssets(
    { projectId: "default", collapseStacks: true, sort: "newest" },
    [member.id, stray.id],
  );
  assert.deepEqual(collapsed.rowByAssetId, { [member.id]: cover.id, [stray.id]: stray.id },
    "a stacked member resolves to the stack's node (cover) row");
  assert.deepEqual(collapsed.rows.map((asset) => asset.id), [stray.id, cover.id], "newest-first node order");
  assert.ok(collapsed.rows.find((asset) => asset.id === cover.id)?.node_sort?.createdAt, "rows carry their node sort tuple");
  assert.equal(collapsed.rows.find((asset) => asset.id === cover.id)?.stack.count, 2);

  // 折叠视图成员被过滤但其他成员仍匹配时，节点行保留且 match_count 反映
  // 真实匹配数（这正是 id 过滤不能直接下推到 matched CTE 的原因）。
  await store.updateMetadata("default", member.id, { group: "Hidden" });
  const filtered = await store.listGalleryRowsForAssets(
    { projectId: "default", collapseStacks: true, sort: "newest", group: "Hidden" },
    [cover.id],
  );
  assert.deepEqual(filtered.rows.map((asset) => asset.id), [member.id],
    "the stack node still belongs to the group view through its matching member");
  assert.equal(filtered.rows[0].stack.match_count, 1, "match count covers ALL matching members, not only affected ones");

  // 受影响行不再匹配当前请求（无任何匹配成员/自身不匹配）时不返回行：
  // 客户端据此把已加载的该卡片移除。
  const absent = await store.listGalleryRowsForAssets(
    { projectId: "default", collapseStacks: true, sort: "newest", group: "Hidden" },
    [stray.id],
  );
  assert.equal(absent.rows.length, 0);
  assert.equal(absent.rowByAssetId[stray.id], stray.id, "the mapping routes the affected asset even when its row vanished");

  // Stack 内视图：按成员行返回并带 stack_position。
  const inside = await store.listGalleryRowsForAssets(
    { projectId: "default", sort: "manual", stackId: (await store.listAssetPage({ projectId: "default", collapseStacks: true, limit: 10 })).assets.find((asset) => asset.stack)?.stack.id },
    [member.id],
  );
  assert.deepEqual(inside.rows.map((asset) => asset.id), [member.id]);
  assert.equal(typeof inside.rows[0].stack_position, "number");

  // 回收站视图走平铺路径。
  await store.deleteAsset("default", stray.id);
  const trash = await store.listGalleryRowsForAssets(
    { projectId: "default", sort: "newest", trash: true },
    [stray.id],
  );
  assert.deepEqual(trash.rows.map((asset) => asset.id), [stray.id]);
  assert.equal(trash.rows[0].deleted_at != null, true);
});

test("gallery page rows carry the server order tuple for client-side repositioning", async (t) => {
  const { store, imagePath } = await createStore(t);
  await createSampleAsset(store, imagePath, "sort-a", { created_at: "2026-01-01T00:00:00.000Z" });
  await createSampleAsset(store, imagePath, "sort-b", { created_at: "2026-02-01T00:00:00.000Z" });
  const page = await store.listAssetPage({ projectId: "default", sort: "newest" });
  assert.deepEqual(page.assets.map((asset) => asset.id), ["sort-b", "sort-a"]);
  assert.equal(page.assets[0].node_sort.createdAt, "2026-02-01T00:00:00.000Z");
  const byName = await store.listAssetPage({ projectId: "default", sort: "name" });
  assert.deepEqual(byName.assets.map((asset) => asset.id), ["sort-a", "sort-b"]);
  assert.equal(byName.assets[0].node_sort.sortName.length > 0, true);
});

test("gallery rows classify affected assets against the existing keyset boundary", async (t) => {
  const { store, imagePath } = await createStore(t, "cursor-boundary");
  await createSampleAsset(store, imagePath, "cursor-a", { created_at: "2026-01-01T00:00:00.000Z" });
  await createSampleAsset(store, imagePath, "cursor-b", { created_at: "2026-02-01T00:00:00.000Z" });
  await createSampleAsset(store, imagePath, "cursor-c", { created_at: "2026-03-01T00:00:00.000Z" });
  await createSampleAsset(store, imagePath, "cursor-d", { created_at: "2026-04-01T00:00:00.000Z" });

  const first = await store.listAssetPage({ projectId: "default", sort: "newest", limit: 2, collapseStacks: true });
  assert.deepEqual(first.assets.map((asset) => asset.id), ["cursor-d", "cursor-c"]);
  assert.ok(first.page.nextCursor);

  const belowBoundary = await store.listGalleryRowsForAssets(
    { projectId: "default", collapseStacks: true, sort: "newest", boundaryCursor: first.page.nextCursor },
    ["cursor-b"],
  );
  assert.deepEqual(belowBoundary.afterCursorRowIds, ["cursor-b"], "rows after the immutable prefix boundary are deferred to append");

  const database = new Database(join(store.libraryDir, "mosa.db"));
  database.prepare("UPDATE assets SET created_at = ?, created_at_epoch = ? WHERE project_id = 'default' AND id = 'cursor-d'")
    .run("2025-12-01T00:00:00.000Z", Date.parse("2025-12-01T00:00:00.000Z"));
  database.close();

  const moved = await store.listGalleryRowsForAssets(
    { projectId: "default", collapseStacks: true, sort: "newest", boundaryCursor: first.page.nextCursor },
    ["cursor-d"],
  );
  assert.deepEqual(moved.afterCursorRowIds, ["cursor-d"], "an already-loaded row that crosses the boundary is identified for removal from the prefix");

  const continuation = await store.listAssetPage({
    projectId: "default",
    sort: "newest",
    limit: 10,
    collapseStacks: true,
    cursor: first.page.nextCursor,
  });
  assert.deepEqual(continuation.assets.map((asset) => asset.id), ["cursor-b", "cursor-a", "cursor-d"],
    "the original keyset cursor remains a valid continuation after the row moved across it");
});

test("derivative completions coalesce into one durable batch revision instead of one revision per asset", async (t) => {
  const { store, imagePath } = await createStore(t, "derivative-hints");
  const assets = await Promise.all([
    createSampleAsset(store, imagePath, "derivative-a"),
    createSampleAsset(store, imagePath, "derivative-b"),
    createSampleAsset(store, imagePath, "derivative-c"),
  ]);
  const before = await store.libraryRevision();
  const beforeCounter = Number.parseInt(before, 10);

  for (const asset of assets) {
    await store.completeDerivativeJob({ project_id: "default", asset_id: asset.id }, {
      previewPath: join(store.previewsDir("default"), `${asset.id}.webp`),
      mediumPath: join(store.mediumsDir("default"), `${asset.id}.webp`),
      thumbnailPath: join(store.thumbnailsDir("default"), `${asset.id}.webp`),
      width: 1,
      height: 1,
    });
  }

  const raw = new Database(join(store.libraryDir, "mosa.db"));
  const counterBeforeFlush = Number(raw.prepare("SELECT value FROM library_meta WHERE key = 'library_revision'").get().value);
  const rowsBeforeFlush = Number(raw.prepare("SELECT COUNT(*) AS count FROM library_changes WHERE revision > ?").get(beforeCounter).count || 0);
  const pendingBeforeFlush = Number(raw.prepare("SELECT COUNT(*) AS count FROM pending_derivative_changes").get().count || 0);
  raw.close();
  assert.equal(counterBeforeFlush, beforeCounter, "completion writes are buffered until the next revision observation");
  assert.equal(rowsBeforeFlush, 0, "no one-row-per-thumbnail journal flood is produced");
  assert.equal(pendingBeforeFlush, assets.length, "pending readiness survives a runtime crash before journal flush");

  const after = await store.libraryRevision();
  assert.equal(Number.parseInt(after, 10), beforeCounter + 1, "all pending derivative ids consume one durable revision");
  const delta = await store.listLibraryChangesSince("default", beforeCounter);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0].kind, "assets-updated");
  assert.deepEqual(delta.changes[0].flags, ["derivatives"]);
  assert.deepEqual(delta.changes[0].assetIds.sort(), assets.map((asset) => asset.id).sort());
});

test("pending derivative readiness survives a store restart and flushes into the normal delta protocol", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-derivative-pending-restart-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  const imagePath = join(generated, "pixel.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const options = { projectRoot: root, managerDir: root, libraryDir: join(root, "library"), initializeFreshLibrary: true };

  const first = createSqliteAssetStore(options);
  await first.ensureProject("default");
  const asset = await createSampleAsset(first, imagePath, "pending-restart");
  const baseline = Number.parseInt(await first.libraryRevision(), 10);
  await first.completeDerivativeJob({ project_id: "default", asset_id: asset.id }, {
    previewPath: join(first.previewsDir("default"), `${asset.id}.webp`),
    mediumPath: join(first.mediumsDir("default"), `${asset.id}.webp`),
    thumbnailPath: join(first.thumbnailsDir("default"), `${asset.id}.webp`),
    width: 1,
    height: 1,
  });
  first.close();

  const second = createSqliteAssetStore(options);
  t.after(() => { try { second.close(); } catch { /* already closed */ } });
  const revision = Number.parseInt(await second.libraryRevision(), 10);
  assert.equal(revision, baseline + 1);
  const delta = await second.listLibraryChangesSince("default", baseline);
  assert.equal(delta.complete, true);
  assert.equal(delta.changes.length, 1);
  assert.equal(delta.changes[0].kind, "assets-updated");
  assert.deepEqual(delta.changes[0].assetIds, [asset.id]);
});

test("more than one derivative chunk still advances only one revision", async (t) => {
  const { store, imagePath } = await createStore(t, "derivative-storm");
  const assets = [];
  for (let index = 0; index < 501; index += 1) {
    assets.push(await createSampleAsset(store, imagePath, `storm-${String(index).padStart(3, "0")}`));
  }
  const baseline = Number.parseInt(await store.libraryRevision(), 10);

  for (const asset of assets) {
    await store.completeDerivativeJob({ project_id: "default", asset_id: asset.id }, {
      previewPath: join(store.previewsDir("default"), `${asset.id}.webp`),
      mediumPath: join(store.mediumsDir("default"), `${asset.id}.webp`),
      thumbnailPath: join(store.thumbnailsDir("default"), `${asset.id}.webp`),
      width: 1,
      height: 1,
    });
  }

  const revision = Number.parseInt(await store.libraryRevision(), 10);
  assert.equal(revision, baseline + 1, "501 completions are one semantic revision, not 501 revisions");
  const delta = await store.listLibraryChangesSince("default", baseline);
  assert.equal(delta.complete, true);
  assert.equal(delta.changes.length, 2, "501 ids are encoded as two bounded journal rows");
  assert.equal(delta.changes.every((change) => change.kind === "assets-updated"), true);
  assert.equal(delta.changes.reduce((sum, change) => sum + change.assetIds.length, 0), 501);
});

test("a large derivative storm stays O(chunks): one revision, ceil(n/500) journal rows, no retention gap", async (t) => {
  // Default 5,000 keeps the committed suite fast; MOSA_DERIVATIVE_STORM_SIZE
  // scales the same scenario (e.g. 20000) without changing any assertion.
  const stormSize = Math.max(1, Number.parseInt(process.env.MOSA_DERIVATIVE_STORM_SIZE || "5000", 10));
  const { store, imagePath } = await createStore(t, "derivative-storm-large");
  const anchor = await createSampleAsset(store, imagePath, "storm-anchor");
  const baseline = Number.parseInt(await store.libraryRevision(), 10);
  assert.ok(baseline >= 1);

  // Seed the storm fixture rows directly in one SQLite transaction (same
  // canonical row shape as the GUI QA seed): the unit under test is the
  // completion → durable pending → batched flush protocol, not N file imports.
  const database = new Database(join(store.libraryDir, "mosa.db"));
  try {
    const timestamp = new Date().toISOString();
    const timestampEpoch = Date.parse(timestamp);
    const insertAsset = database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, content_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating,
        version_change, source_type, source_json, metadata_json, search_text, tags_text,
        business_search_text, source_search_text, media_kind, source_group, conversation_id,
        generation_batch, created_at, created_at_epoch, updated_at, sort_name
      ) VALUES (
        'default', @id, @asset, @original_path, @content_sha256, @prompt, '', '', '',
        '{"width":1024,"height":1024}', '', 0, 0, '', '', 0,
        '', 'derivative-storm', '{"type":"derivative-storm"}', '{}', @prompt, '',
        '1024 1024', 'derivative-storm', 'image', 'derivative-storm', '', '',
        @created_at, @created_at_epoch, @updated_at, @sort_name
      )
    `);
    const insertFts = database.prepare("INSERT INTO asset_fts (project_id, asset_id, content) VALUES ('default', ?, ?)");
    database.transaction(() => {
      for (let index = 0; index < stormSize; index += 1) {
        const id = `storm-${String(index).padStart(6, "0")}`;
        const prompt = `derivative storm fixture ${index}`;
        insertAsset.run({
          id,
          asset: `${id}.png`,
          original_path: imagePath,
          content_sha256: `storm-${index}`,
          prompt,
          created_at: timestamp,
          created_at_epoch: timestampEpoch,
          updated_at: timestamp,
          sort_name: id,
        });
        insertFts.run(id, prompt);
      }
    })();
  } finally {
    database.close();
  }

  const stormAssets = (await store.listAssets({ projectId: "default", sort: "oldest" }))
    .map((asset) => asset.id)
    .filter((id) => id !== anchor.id);
  assert.equal(stormAssets.length, stormSize, `storm fixture seeded ${stormAssets.length} of ${stormSize}`);

  for (const assetId of stormAssets) {
    await store.completeDerivativeJob({ project_id: "default", asset_id: assetId }, {
      previewPath: join(store.previewsDir("default"), `${assetId}.webp`),
      mediumPath: join(store.mediumsDir("default"), `${assetId}.webp`),
      thumbnailPath: join(store.thumbnailsDir("default"), `${assetId}.webp`),
      width: 1,
      height: 1,
    });
  }

  const raw = new Database(join(store.libraryDir, "mosa.db"));
  const pendingBeforeFlush = Number(raw.prepare("SELECT COUNT(*) AS count FROM pending_derivative_changes").get().count || 0);
  const journalBeforeFlush = Number(raw.prepare("SELECT COUNT(*) AS count FROM library_changes WHERE revision > ?").get(baseline).count || 0);
  raw.close();
  assert.equal(journalBeforeFlush, 0, "no per-asset journal flood before the flush");
  assert.equal(pendingBeforeFlush, stormSize, "every completion is durably pending before the flush");

  const revision = Number.parseInt(await store.libraryRevision(), 10);
  assert.equal(revision, baseline + 1, `${stormSize} completions advance exactly one revision, not ${stormSize}`);

  const delta = await store.listLibraryChangesSince("default", baseline);
  const expectedChunks = Math.ceil(stormSize / 500);
  assert.equal(delta.complete, true, "no journal retention gap at storm scale");
  assert.equal(delta.changes.length, expectedChunks, `journal rows equal ceil(${stormSize}/500) = ${expectedChunks}`);
  assert.equal(delta.changes.every((change) => change.kind === "assets-updated" && change.flags.includes("derivatives")), true);
  assert.equal(delta.changes.every((change) => change.assetIds.length <= 500), true, "each journal row stays within the 500-id bound");
  const flushedIds = delta.changes.flatMap((change) => change.assetIds).sort();
  assert.deepEqual(flushedIds, [...stormAssets].sort(), "flush covers every storm asset exactly once");

  const rawAfter = new Database(join(store.libraryDir, "mosa.db"));
  const pendingAfter = Number(rawAfter.prepare("SELECT COUNT(*) AS count FROM pending_derivative_changes").get().count || 0);
  rawAfter.close();
  assert.equal(pendingAfter, 0, "the durable pending table is drained by the flush");

  // The client reconciles affected ids through the gallery-rows API, which is
  // chunked at 1000 ids per request; every chunk must resolve every id.
  const resolved = new Set();
  for (let offset = 0; offset < stormAssets.length; offset += 1000) {
    const chunk = stormAssets.slice(offset, offset + 1000);
    const { rowByAssetId } = await store.listGalleryRowsForAssets({ projectId: "default", sort: "oldest" }, chunk);
    for (const assetId of Object.keys(rowByAssetId)) resolved.add(assetId);
  }
  assert.equal(resolved.size, stormSize, "chunked gallery-rows resolves every affected id exactly once");
});

test("library-changes and gallery-rows routes serve the incremental contract over HTTP", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-library-changes-http-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const generated = join(root, "generated-images");
  await mkdir(generated, { recursive: true });
  await writeFile(join(generated, "pixel.png"), ONE_PIXEL_PNG);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: root,
    libraryDir: join(root, "library"),
    generatedImagesDir: generated,
    codexImagesDir: join(root, "codex-images"),
    codexSessionsDir: join(root, "sessions"),
    grokSessionsDir: join(root, "grok-sessions"),
    cowartCanvasDir: join(root, "cowart-data"),
    cowartRegistryPath: join(root, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const create = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assetId: "http-a", imagePath: join(generated, "pixel.png"), prompt: "http" }),
  });
  assert.equal(create.status, 200);

  const delta = await (await fetch(`${runtime.url}/api/library-changes?project=default&since=0`)).json();
  assert.equal(delta.complete, true);
  assert.ok(delta.revisionToken, "the delta carries the full revision token for client baselines");
  assert.deepEqual(delta.changes.map((change) => change.kind), ["asset-added"]);
  assert.equal(delta.changes[0].entityId, "http-a");

  const rows = await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "default",
      request: { query: "", scope: "all", mediaKind: "all", facets: {}, sort: "newest", view: "gallery" },
      assetIds: ["http-a", "missing"],
    }),
  });
  assert.equal(rows.status, 200);
  const rowsBody = await rows.json();
  assert.deepEqual(rowsBody.rows.map((asset) => asset.id), ["http-a"]);
  // 恒等映射无条件包含：缺失行的 id 也在映射里（absence 即“不再匹配”信号）。
  assert.deepEqual(rowsBody.rowByAssetId, { "http-a": "http-a", missing: "missing" });
  assert.ok(rowsBody.rows[0].node_sort);

  const otherCreate = await fetch(`${runtime.url}/api/assets/create`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "other-project", assetId: "http-other", imagePath: join(generated, "pixel.png"), prompt: "other" }),
  });
  assert.equal(otherCreate.status, 200);
  const otherRows = await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: "other-project",
      request: { query: "", scope: "all", mediaKind: "all", facets: {}, sort: "newest", view: "gallery" },
      assetIds: ["http-other"],
    }),
  });
  assert.equal(otherRows.status, 200);
  assert.deepEqual((await otherRows.json()).rows.map((asset) => asset.id), ["http-other"],
    "the incremental HTTP contract honors the reconciler's top-level project field");

  const oversized = await fetch(`${runtime.url}/api/gallery-rows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: "default", request: {}, assetIds: Array.from({ length: 1001 }, (_, index) => `id-${index}`) }),
  });
  assert.equal(oversized.status, 413, "reconciliation chunks are bounded per request");
});
