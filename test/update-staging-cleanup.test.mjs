import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupStaleUpdateStagingDirs, selectStaleUpdateStagingDirs } from "../desktop/update-staging-cleanup.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("selects only strictly older version directories for removal", () => {
  const selected = selectStaleUpdateStagingDirs(
    ["0.3.1", "0.3.2-rc.4", "0.3.3", "0.3.3-rc.25", "0.3.4-rc.1", "not-a-version", "0.3.2.zip"],
    "0.3.3-rc.26",
  );
  assert.deepEqual(selected.sort(), ["0.3.1", "0.3.2-rc.4", "0.3.3-rc.25"].sort());
});

test("cleanup keeps the current and pending downloads and drops only consumed ones", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-update-staging-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const macosRoot = join(root, "macos");
  const windowsRoot = join(root, "windows");
  for (const [stagingRoot, versions] of [
    [macosRoot, ["0.3.1", "0.3.2-rc.4", "0.3.2"]],
    [windowsRoot, ["0.3.0"]],
  ]) {
    for (const version of versions) {
      await mkdir(join(stagingRoot, version), { recursive: true });
      await writeFile(join(stagingRoot, version, "update.zip"), "payload");
    }
  }
  await writeFile(join(macosRoot, "notes.txt"), "not a version directory");

  const { removed, failed } = await cleanupStaleUpdateStagingDirs({
    stagingRoots: [macosRoot, windowsRoot, join(root, "missing-platform")],
    currentVersion: "0.3.2",
  });

  assert.deepEqual(failed, []);
  assert.equal(removed.length, 3, `removed: ${JSON.stringify(removed)}`);
  // The consumed 0.3.1 and 0.3.2-rc.4 downloads are gone; the running
  // version's own directory and everything unparsable or newer stay.
  assert.deepEqual((await readdir(macosRoot)).sort(), ["0.3.2", "notes.txt"]);
  assert.deepEqual(await readdir(windowsRoot), []);
});

test("a staging root that cannot be listed is skipped without failing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-update-staging-file-"));
  deferTestPathRemoval(root, { recursive: true, force: true });
  const filePath = join(root, "not-a-directory");
  await writeFile(filePath, "a file where a staging root would be");

  const { removed, failed } = await cleanupStaleUpdateStagingDirs({
    stagingRoots: [filePath],
    currentVersion: "0.3.2",
  });

  assert.deepEqual(removed, []);
  assert.deepEqual(failed, []);
});
