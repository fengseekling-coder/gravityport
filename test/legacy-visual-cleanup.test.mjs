import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cleanupLegacyVisualData, LEGACY_VISUAL_DATA_DIRS, LEGACY_VISUAL_DATA_FILES } from "../desktop/legacy-visual-cleanup.mjs";

async function makeUserData(t) {
  const root = await mkdtemp(join(tmpdir(), "mosa-legacy-visual-"));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return root;
}

test("startup cleanup removes every legacy visual data location the app once created", async (t) => {
  const userDataDir = await makeUserData(t);
  await mkdir(join(userDataDir, "visual-model-packs", "siglip2-base-patch16-224-r1-darwin-arm64"), { recursive: true });
  await writeFile(join(userDataDir, "visual-model-packs", "siglip2-base-patch16-224-r1-darwin-arm64", "model-pack.json"), "{}");
  await mkdir(join(userDataDir, "visual-pack-staging", "transaction"), { recursive: true });
  await mkdir(join(userDataDir, "visual-relationship-indexes", "library-key"), { recursive: true });
  await writeFile(join(userDataDir, "visual-model-settings.json"), "{}");

  const removed = await cleanupLegacyVisualData({ userDataDir });
  assert.deepEqual([...removed].sort(), [...LEGACY_VISUAL_DATA_DIRS, ...LEGACY_VISUAL_DATA_FILES].sort());
  for (const entry of [...LEGACY_VISUAL_DATA_DIRS, ...LEGACY_VISUAL_DATA_FILES]) {
    assert.equal(existsSync(join(userDataDir, entry)), false, `${entry} must be gone`);
  }
});

test("startup cleanup leaves unrelated userData files and reports nothing removed", async (t) => {
  const userDataDir = await makeUserData(t);
  const keepPath = join(userDataDir, "Preferences");
  await writeFile(keepPath, "{}");
  await mkdir(join(userDataDir, "updates"), { recursive: true });

  const removed = await cleanupLegacyVisualData({ userDataDir });
  assert.deepEqual(removed, []);
  assert.equal(existsSync(keepPath), true, "unrelated userData files stay");
  assert.equal(existsSync(join(userDataDir, "updates")), true, "update staging stays");
});

test("startup cleanup is idempotent and requires a userData directory", async (t) => {
  const userDataDir = await makeUserData(t);
  await mkdir(join(userDataDir, "visual-model-packs"), { recursive: true });
  await cleanupLegacyVisualData({ userDataDir });
  const second = await cleanupLegacyVisualData({ userDataDir });
  assert.deepEqual(second, []);
  await assert.rejects(() => cleanupLegacyVisualData({}), /requires the Electron userData directory/);
});

test("the swept list covers exactly the directories visual-pack-remove and the runtime used", async (t) => {
  // Contract pin: the sweeper must keep matching the names the removed
  // installer/runtime actually used, so a rename here fails loudly instead of
  // silently leaving bytes on user machines.
  assert.deepEqual([...LEGACY_VISUAL_DATA_DIRS], ["visual-model-packs", "visual-pack-staging", "visual-relationship-indexes"]);
  assert.deepEqual([...LEGACY_VISUAL_DATA_FILES], ["visual-model-settings.json"]);
  const mainSource = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /void cleanupLegacyVisualData\(\)\.catch/);
});
