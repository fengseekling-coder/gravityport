// Trash reason (task 280): `deleteAsset` accepts an optional `context.reason`
// that lands in `metadata_json.trash_reason = { code, at }`, `restoreAsset`
// clears it again, and the media-replacement snapshot records
// "replaced-by-better-version" on its own. The inspector's reason text
// resolver (web TS) is compiled with the project's tsc like
// gravityport-inspector-info.test.mjs does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import sharp from "sharp";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let inspectorInfoModule;
let compileRoot;
before(async () => {
  compileRoot = await mkdtemp(join(tmpdir(), "mosa-trash-reason-ui-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "inspector-info.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  inspectorInfoModule = await import(join(compileRoot, "inspector-info.js"));
});
after(async () => {
  await rm(compileRoot, { recursive: true, force: true });
});

async function createTestStore(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const libraryDir = join(root, "library");
  await mkdir(libraryDir, { recursive: true });
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: root, libraryDir });
  t.after(() => store.close?.());
  await store.ensureProject("default");
  return { store, libraryDir };
}

async function createLocalAsset(store, libraryDir, name) {
  // createAsset refuses sources outside the library roots, so stage the file
  // inside the temporary library (an ingest pipeline is not involved here).
  const staged = join(libraryDir, "staged");
  await mkdir(staged, { recursive: true });
  const source = join(staged, name);
  await writeFile(source, await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer());
  return store.createAsset({ projectId: "default", imagePath: source, fileName: name });
}

describe("deleteAsset trash_reason", () => {
  it("stays absent when no reason is passed and restore still works", async (t) => {
    const { store, libraryDir } = await createTestStore(t, "mosa-trash-reason-plain-");
    const asset = await createLocalAsset(store, libraryDir, "plain.png");
    await store.deleteAsset("default", asset.id);
    const trashed = await store.getAsset("default", asset.id);
    assert.ok(trashed.deleted_at);
    assert.ok(!trashed.trash_reason);
    const restored = await store.restoreAsset("default", asset.id);
    assert.equal(restored.deleted_at, null);
    assert.ok(!restored.trash_reason);
  });

  it("records { code, at } for a passed reason and restoreAsset clears it", async (t) => {
    const { store, libraryDir } = await createTestStore(t, "mosa-trash-reason-code-");
    const asset = await createLocalAsset(store, libraryDir, "coded.png");
    await store.deleteAsset("default", asset.id, { reason: "provider-deleted:jimeng" });
    const trashed = await store.getAsset("default", asset.id);
    assert.equal(trashed.trash_reason?.code, "provider-deleted:jimeng");
    assert.ok(trashed.trash_reason?.at);
    const restored = await store.restoreAsset("default", asset.id);
    assert.equal(restored.deleted_at, null);
    assert.ok(!restored.trash_reason);
    // Re-trashing with another reason overwrites the previous one.
    await store.deleteAsset("default", asset.id, { reason: "replaced-by-better-version" });
    const again = await store.getAsset("default", asset.id);
    assert.equal(again.trash_reason?.code, "replaced-by-better-version");
    await store.restoreAsset("default", asset.id);
    const cleared = await store.getAsset("default", asset.id);
    assert.ok(!cleared.trash_reason);
  });
});

describe("trashReasonNotice (inspector-info)", () => {
  const assetWith = (fields) => ({ deleted_at: "2026-10-28T10:00:00.000Z", trash_reason: null, ...fields });

  it("maps the two known codes to their notice text", () => {
    const replaced = inspectorInfoModule.trashReasonNotice(assetWith({ trash_reason: { code: "replaced-by-better-version", at: "2026-10-28T10:00:00.000Z" } }));
    assert.equal(replaced?.text, "已被同一张图的更清晰版本替换");
    const jimeng = inspectorInfoModule.trashReasonNotice(assetWith({ trash_reason: { code: "provider-deleted:jimeng", at: "2026-10-28T10:00:00.000Z" } }));
    assert.equal(jimeng?.text, "因在即梦网站中删除而移入回收站");
  });

  it("stays silent for unknown codes and live assets", () => {
    assert.equal(inspectorInfoModule.trashReasonNotice(assetWith({ trash_reason: { code: "something-else", at: "2026-10-28T10:00:00.000Z" } })), null);
    assert.equal(inspectorInfoModule.trashReasonNotice(assetWith({ deleted_at: null, trash_reason: { code: "replaced-by-better-version", at: "x" } })), null);
    assert.equal(inspectorInfoModule.trashReasonNotice(assetWith({})), null);
  });
});
