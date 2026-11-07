import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { deferTestPathRemoval } from "./test-cleanup.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJsonAssetStore } from "../lib/asset-store.mjs";
import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { mp4Bytes } from "./helpers/managed-media.mjs";

const ONE_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3QAAAABJRU5ErkJggg==", "base64");

// V2 FilterBar type filter (全部/图片/视频): the server-side mediaKind filter must
// classify by explicit media_kind first, then by file extension, identically in
// both stores, and the page total must agree with the filtered page.
for (const kind of ["sqlite", "json"]) {
  test(`${kind} store mediaKind filter splits images and videos`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `mosa-type-filter-${kind}-`));
    deferTestPathRemoval(root, { recursive: true, force: true });
    const projectRoot = join(root, "project");
    const mediaDir = join(projectRoot, "generated-images");
    await mkdir(mediaDir, { recursive: true });
    const pngPath = join(mediaDir, "fixture.png");
    const mp4Path = join(mediaDir, "fixture.mp4");
    await writeFile(pngPath, ONE_PIXEL_PNG);
    await writeFile(mp4Path, mp4Bytes());
    const store = kind === "sqlite"
      ? createSqliteAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa"), libraryDir: join(root, "library") })
      : createJsonAssetStore({ projectRoot, managerDir: join(projectRoot, "mosa") });
    if (kind === "sqlite") t.after(() => store.close());

    await store.createAsset({ assetId: "plain-image", imagePath: pngPath });
    await store.createAsset({ assetId: "plain-video", imagePath: mp4Path });
    // Explicit media_kind overrides the extension (a png that is really a video frame).
    await store.createAsset({ assetId: "forced-video", imagePath: pngPath, source: { type: "local-file", media_kind: "video" } });

    const all = await store.listAssetPage({ projectId: "default", limit: 100 });
    assert.equal(all.page.total, 3);
    const images = await store.listAssetPage({ projectId: "default", limit: 100, mediaKind: "img" });
    assert.deepEqual(images.assets.map((asset) => asset.id).sort(), ["plain-image"]);
    assert.equal(images.page.total, 1);
    const videos = await store.listAssetPage({ projectId: "default", limit: 100, mediaKind: "video" });
    assert.deepEqual(videos.assets.map((asset) => asset.id).sort(), ["forced-video", "plain-video"]);
    assert.equal(videos.page.total, 2);
  });
}
