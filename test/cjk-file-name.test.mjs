// Task 382: CJK file names survive import end to end — the stored file name
// keeps a readable stem (`拖入-甲-<stamp>.png`), the read-only display_name
// drops the machine tail, and search matches the words a user types. ASCII
// names must stay byte-identical with the pre-382 rule (`<id>.png`), and
// every sanitizeFileName output must be idempotent: the /library image routes
// re-sanitize the decoded URL segment on every read and
// normalizeAssetMetadata re-sanitizes `asset` on every save.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";
import { hasNonAsciiStem, sanitizeFileName } from "../lib/asset-file-name.mjs";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { startMosaRuntime } from "../lib/mosa-runtime.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { uniquePngBytes } from "./helpers/unique-image.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const CJK_NAME = "拖入-甲.png";
const PASTE_NAME = "粘贴的图片 2026-10-24 05.34.47.png";
const NFD_GA = "\u304B\u3099"; // か + combining dakuten — decomposed が
const NFC_GA = "\u304C";

// ─── 1) sanitizeFileName contract ────────────────────────────────────────────

// Task 382 §2.5: ASCII-only stems must produce exactly the pre-382 output.
const ASCII_TABLE = [
  ["cat.png", "cat.png"],
  ["my cat.PNG", "my-cat.PNG"],
  ["a..png", "a..png"],
  ["--x--.jpg", "x.jpg"],
  ["Screen Shot 2026-10-01 at 10.00.00.png", "Screen-Shot-2026-10-01-at-10.00.00.png"],
  ["photo", "photo.png"],
  ["dir/sub/pic.webp", "pic.webp"],
  ["a_b-c.d.gif", "a_b-c.d.gif"],
  ["", "asset.png"],
  [" .png", "asset.png"],
];

// Task 382 §2.5: the non-ASCII rules.
const NON_ASCII_TABLE = [
  ["拖入-甲.png", "拖入-甲.png"],
  ["テスト 画像.png", "テスト-画像.png"],
  ["猫<1>:\"?.png", "猫-1.png"],
  ["  .甲乙.  .png", "甲乙.png"],
  [`${"图".repeat(200)}.png`, `${"图".repeat(48)}.png`],
  [`${NFD_GA}.png`, `${NFC_GA}.png`],
];

for (const [label, table] of [["ascii", ASCII_TABLE], ["non-ascii", NON_ASCII_TABLE]]) {
  test(`sanitizeFileName ${label} table, and every output is idempotent`, () => {
    for (const [input, expected] of table) {
      const once = sanitizeFileName(input);
      assert.equal(once, expected, `sanitizeFileName(${JSON.stringify(input)})`);
      assert.equal(sanitizeFileName(once), once, `re-sanitizing ${JSON.stringify(once)} must not change it`);
    }
  });
}

test("hasNonAsciiStem inspects the stem only, not the extension", () => {
  assert.equal(hasNonAsciiStem(CJK_NAME), true);
  assert.equal(hasNonAsciiStem("拖入-甲-mvr0cxl8-1a2b3c4d.png"), true);
  assert.equal(hasNonAsciiStem("cat.png"), false);
  assert.equal(hasNonAsciiStem("拖入-甲"), true); // bare stem, no extension
  assert.equal(hasNonAsciiStem(""), false);
});

// ─── shared helpers ──────────────────────────────────────────────────────────

async function makeSources(dir, seeds) {
  const sources = join(dir, "generated-images");
  await mkdir(sources, { recursive: true });
  const files = [];
  for (const seed of seeds) {
    const filePath = join(sources, `source-${seed}.png`);
    await writeFile(filePath, await uniquePngBytes(seed));
    files.push(filePath);
  }
  return { sources, files };
}

async function stageAndImport(runtime, fileName, filePath, fileBytes) {
  const staged = await fetch(`${runtime.url}/api/import/stage`, {
    method: "POST",
    headers: { "x-mosa-file-name": encodeURIComponent(fileName), "content-type": "application/octet-stream" },
    body: fileBytes ?? (await readFile(filePath)),
  });
  assert.equal(staged.status, 201, `staging ${fileName} failed: ${staged.status}`);
  const stagedPath = (await staged.json()).path;
  const batch = await fetch(`${runtime.url}/api/assets/import-batch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", items: [{ imagePath: stagedPath, fileName }] }),
  });
  assert.equal(batch.status, 200, `importing ${fileName} failed: ${batch.status}`);
  const body = await batch.json();
  assert.equal(body.imported, 1, `importing ${fileName}: ${JSON.stringify(body.results)}`);
  return body.results[0].asset;
}

async function listApiAssets(runtime, search = "") {
  const response = await fetch(`${runtime.url}/api/assets?project=default&limit=250${search ? `&q=${encodeURIComponent(search)}` : ""}`);
  assert.equal(response.status, 200);
  return (await response.json()).assets;
}

// ─── 2) SQLite backend through the real import entry ─────────────────────────

test("sqlite: CJK import keeps the readable name, serves the original bytes, searches, and survives prompt edits and duplicates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-cjk-sqlite-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const { sources, files } = await makeSources(dir, [11, 12, 13, 14]);
  const runtime = await startMosaRuntime({
    port: 0,
    projectRoot: dir,
    libraryDir: join(dir, "library"),
    assetsRoot: join(dir, "assets"),
    generatedImagesDir: sources,
    codexImagesDir: join(dir, "codex-images"),
    codexSessionsDir: join(dir, "sessions"),
    grokSessionsDir: join(dir, "grok-sessions"),
    cowartCanvasDir: join(dir, "cowart-data"),
    cowartRegistryPath: join(dir, "state", "cowart-projects.json"),
  });
  t.after(() => runtime.stop());

  const asset = await stageAndImport(runtime, CJK_NAME, files[0]);
  // Stored name: readable stem + stamp, ASCII-only id.
  assert.match(asset.asset, /^拖入-甲-.+\.png$/, `asset: ${asset.asset}`);
  assert.equal(basename(asset.image_path), asset.asset);
  assert.match(asset.id, /^[A-Za-z0-9-]+$/, `id must stay ASCII: ${asset.id}`);
  assert.notEqual(asset.id, asset.asset);

  // The managed file exists under the readable name and serves identical bytes.
  const imageUrl = `${runtime.url}${asset.image_url}`;
  const imageResponse = await fetch(imageUrl);
  assert.equal(imageResponse.status, 200, `GET ${asset.image_url} -> ${imageResponse.status}`);
  assert.ok(Buffer.from(await imageResponse.arrayBuffer()).equals(await readFile(files[0])), "served bytes differ from the source file");

  // The list API carries the display name plus the untouched real names.
  const listed = (await listApiAssets(runtime)).find((item) => item.id === asset.id);
  assert.ok(listed, "imported asset missing from /api/assets");
  assert.equal(listed.display_name, CJK_NAME);
  assert.equal(listed.asset, asset.asset);
  assert.equal(listed.image_path, asset.image_path);
  const detailed = (await (await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`)).json()).asset;
  assert.equal(detailed.display_name, CJK_NAME);
  assert.equal(detailed.asset, asset.asset);

  // Search finds it by the full name, the prefix word, and the single char.
  for (const term of ["拖入-甲", "拖入", "甲"]) {
    const hits = await listApiAssets(runtime, term);
    assert.ok(hits.some((item) => item.id === asset.id), `search "${term}" did not find ${asset.id} (got ${hits.length} rows)`);
  }

  // A prompt edit re-runs normalizeAssetMetadata: the stored name must survive.
  const patched = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "改一次提示词" }),
  });
  assert.equal(patched.status, 200);
  const updated = (await patched.json()).asset;
  assert.equal(updated.asset, asset.asset, "prompt edit changed the stored file name");
  assert.equal(updated.display_name, CJK_NAME);

  // Duplicating copies the readable stem into the new stored name.
  const duplicated = await fetch(`${runtime.url}/api/assets/default/${encodeURIComponent(asset.id)}/duplicate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(duplicated.status, 201);
  const duplicate = (await duplicated.json()).asset;
  assert.match(duplicate.asset, /^拖入-甲-.+\.png$/, `duplicate asset: ${duplicate.asset}`);
  assert.equal(duplicate.display_name, CJK_NAME);

  // The pasted-screenshot shape keeps its timestamp and stays searchable.
  const pasted = await stageAndImport(runtime, PASTE_NAME, files[1]);
  assert.match(pasted.asset, /^粘贴的图片-2026-10-24-.+\.png$/, `pasted asset: ${pasted.asset}`);
  assert.equal(pasted.display_name, "粘贴的图片-2026-10-24-05.34.47.png");
  const pasteHits = await listApiAssets(runtime, "粘贴的图片");
  assert.ok(pasteHits.some((item) => item.id === pasted.id), `search "粘贴的图片" did not find ${pasted.id}`);

  // English names keep the pre-382 rule exactly: file name = <id>.png.
  const cat = await stageAndImport(runtime, "cat.png", files[2]);
  assert.equal(cat.asset, `${cat.id}.png`);
  assert.equal(cat.display_name, "cat.png");

  // A legacy asset whose name was stripped pre-382 displays as asset.png.
  const database = new Database(sqliteDatabasePath(join(dir, "library")));
  try {
    database.prepare("UPDATE assets SET asset = 'asset-mvr0cxl8-1a2b3c4d.png' WHERE id = ?").run(cat.id);
  } finally {
    database.close();
  }
  const legacy = (await listApiAssets(runtime)).find((item) => item.id === cat.id);
  assert.equal(legacy.display_name, "asset.png");
  assert.equal(legacy.asset, "asset-mvr0cxl8-1a2b3c4d.png");
});

test("sqlite: media replacement keeps the readable stem for CJK assets and <id>-… for ASCII assets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-cjk-replace-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const { sources, files } = await makeSources(dir, [21, 22, 23]);
  const store = createSqliteAssetStore({
    projectRoot: dir,
    managerDir: join(dir, "mosa"),
    libraryDir: join(dir, "library"),
    initializeFreshLibrary: true,
  });
  t.after(() => store.close());

  const cjk = await store.createAsset({ imagePath: files[0], fileName: CJK_NAME });
  const cjkReplacement = await store.replaceAssetMedia("default", cjk.id, { imagePath: files[1] });
  assert.match(cjkReplacement.asset, /^拖入-甲-.+\.png$/, `replaced CJK asset: ${cjkReplacement.asset}`);
  assert.notEqual(cjkReplacement.asset, cjk.asset);

  const ascii = await store.createAsset({ imagePath: files[1], fileName: "cat.png" }, { skipIdenticalBytes: false });
  const asciiReplacement = await store.replaceAssetMedia("default", ascii.id, { imagePath: files[2] });
  assert.match(asciiReplacement.asset, new RegExp(`^${ascii.id}(-[0-9a-z]+){3}\\.png$`), `replaced ASCII asset: ${asciiReplacement.asset}`);
});

// ─── 3) JSON backend ─────────────────────────────────────────────────────────

test("json: CJK imports keep the readable stem, ASCII stays <id>.png, replacements follow the same rule", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mosa-cjk-json-"));
  deferTestPathRemoval(dir, { recursive: true, force: true });
  const { sources, files } = await makeSources(join(dir, "project"), [31, 32, 33, 34]);
  const store = createJsonAssetStore({ projectRoot: join(dir, "project"), managerDir: join(dir, "project", "mosa") });

  const cjk = await store.createAsset({ imagePath: files[0], fileName: CJK_NAME });
  assert.match(cjk.asset, /^拖入-甲-.+\.png$/, `asset: ${cjk.asset}`);
  assert.match(cjk.id, /^[A-Za-z0-9-]+$/, `id must stay ASCII: ${cjk.id}`);
  assert.equal(cjk.display_name, CJK_NAME);

  const cat = await store.createAsset({ imagePath: files[1], fileName: "cat.png" });
  assert.equal(cat.asset, `${cat.id}.png`);
  assert.equal(cat.display_name, "cat.png");

  const replaced = await store.replaceAssetMedia("default", cjk.id, { imagePath: files[2] });
  const afterCjk = await store.getAsset("default", cjk.id);
  assert.match(afterCjk.asset, /^拖入-甲-.+\.png$/, `replaced CJK asset: ${afterCjk.asset ?? replaced.asset}`);

  const asciiReplaced = await store.replaceAssetMedia("default", cat.id, { imagePath: files[3] });
  const afterAscii = await store.getAsset("default", cat.id);
  assert.match(afterAscii.asset, new RegExp(`^${cat.id}(-[0-9a-z]+){3}\\.png$`), `replaced ASCII asset: ${afterAscii.asset ?? asciiReplaced.asset}`);

  // Legacy row: hand-set the stored name the way pre-382 libraries hold it.
  const metadataPath = join(store.metadataDir("default"), `${cat.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.asset = "asset-mvr0cxl8-1a2b3c4d.png";
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  const legacy = await store.getAsset("default", cat.id);
  assert.equal(legacy.display_name, "asset.png");
  assert.equal(legacy.asset, "asset-mvr0cxl8-1a2b3c4d.png");
  const listed = await store.listAssets({ projectId: "default" });
  assert.ok(listed.every((item) => typeof item.display_name === "string" && item.display_name.length > 0), `list rows missing display_name: ${JSON.stringify(listed.map((item) => item.display_name))}`);
  assert.equal(listed.find((item) => item.id === cjk.id).display_name, CJK_NAME);
});

// ─── 4) Frontend normalizeAsset ───────────────────────────────────────────────

test("frontend normalizeAsset prefers display_name and falls back to the path's last segment", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "mosa-cjk-ui-"));
  deferTestPathRemoval(tempRoot, { recursive: true, force: true });
  const outDir = join(tempRoot, "out");
  await mkdir(outDir, { recursive: true });
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(repositoryRoot, "web", "gravityport", "src", "mosa-api.ts"),
    "--outDir", outDir,
    "--rootDir", join(repositoryRoot, "web", "gravityport", "src"),
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "es2022",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  const { normalizeAsset } = await import(pathToFileURL(join(outDir, "mosa-api.js")));

  const withDisplay = normalizeAsset({ display_name: "cat.png", image_path: "/x/cat-mvr0cxl8-1a2b3c4d.png" });
  assert.equal(withDisplay.name, "cat.png");

  const cjk = normalizeAsset({ display_name: "拖入-甲.png", image_path: "/x/拖入-甲-mvr0cxl8-1a2b3c4d.png" });
  assert.equal(cjk.name, "拖入-甲.png");

  const withoutDisplay = normalizeAsset({ image_path: "/x/cat-mvr0cxl8-1a2b3c4d.png" });
  assert.equal(withoutDisplay.name, "cat-mvr0cxl8-1a2b3c4d.png");

  const emptyDisplay = normalizeAsset({ display_name: "", image_path: "/x/legacy-asset.png" });
  assert.equal(emptyDisplay.name, "legacy-asset.png");
});
