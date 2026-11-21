// Task 443: the pending old-library cleanup module. The tests exercise the
// real desktop/library-relocation-cleanup.mjs against throwaway directories
// under os.tmpdir(); trashItem is always an injected fake — the real
// shell.trashItem is never called and nothing outside the temp dirs is
// touched.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PENDING_OLD_LIBRARY_CLEANUP_RECORD,
  recordPendingOldLibraryCleanup,
  settlePendingOldLibraryCleanup,
} from "../desktop/library-relocation-cleanup.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function makeWorkspace(t, { withOldLibrary = true, withNewLibrary = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "mosa-reloc-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userDataDir = join(root, "userData");
  const previousLibraryDir = join(root, "old-library");
  const nextLibraryDir = join(root, "new-library");
  await mkdir(userDataDir, { recursive: true });
  await mkdir(previousLibraryDir, { recursive: true });
  await mkdir(nextLibraryDir, { recursive: true });
  if (withOldLibrary) {
    // The one file that marks a directory as a library (lib/library-location.mjs
    // LIBRARY_DATABASE_FILE) plus one managed media file, as a real copy leaves.
    await writeFile(join(previousLibraryDir, "mosa.db"), "sqlite-placeholder");
    await writeFile(join(previousLibraryDir, "notes.txt"), "not a database");
  }
  if (withNewLibrary) {
    await writeFile(join(nextLibraryDir, "mosa.db"), "sqlite-placeholder");
  }
  return { root, userDataDir, previousLibraryDir, nextLibraryDir };
}

function makeFakeTrash() {
  const calls = [];
  const trashItem = async (path) => {
    calls.push(resolve(String(path)));
    return undefined;
  };
  return { calls, trashItem };
}

async function readRecord(userDataDir) {
  return JSON.parse(await readFile(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD), "utf8"));
}

test("1. a complete record for the active destination trashes the old library once, with the old path, and removes the record", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t);
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  const { calls, trashItem } = makeFakeTrash();
  const logs = [];

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { action: "trashed" });
  assert.deepEqual(calls, [resolve(previousLibraryDir)]);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed after a successful trash");
  assert.equal(existsSync(previousLibraryDir), true, "the injected fake does not delete; only the call is asserted");
  assert.match(logs.join("\n"), /moved to the trash/);
});

test("2. the current library not being the recorded destination removes the record and touches nothing", async (t) => {
  const { root, userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t);
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  const otherLibraryDir = join(root, "unrelated-library");
  await mkdir(otherLibraryDir, { recursive: true });
  await writeFile(join(otherLibraryDir, "mosa.db"), "sqlite-placeholder");
  const { calls, trashItem } = makeFakeTrash();

  const result = await settlePendingOldLibraryCleanup({ userDataDir, currentLibraryDir: otherLibraryDir, trashItem, log: () => {} });

  assert.deepEqual(result, { action: "removed-record", reason: "current-library-mismatch" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(previousLibraryDir), true, "the old library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
});

test("3. the old path aliasing the current library through a symlink is the same location and is never trashed", async (t) => {
  const { userDataDir, nextLibraryDir } = await makeWorkspace(t, { withOldLibrary: false });
  // The recorded old path is a second spelling of the CURRENT library: the
  // same directory reached through a symlink alias. Trashing it would destroy
  // the live library, so path strings alone must not decide here.
  const aliasDir = `${nextLibraryDir}-alias`;
  await symlink(nextLibraryDir, aliasDir);
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir: aliasDir, nextLibraryDir });
  const { calls, trashItem } = makeFakeTrash();

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem,
    log: () => {},
  });

  assert.deepEqual(result, { action: "removed-record", reason: "old-library-overlaps-current" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(nextLibraryDir), true, "the live library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
});

test("4. an old library that contains the current library (the move went into a subfolder) is never trashed", async (t) => {
  const { root, userDataDir, previousLibraryDir } = await makeWorkspace(t);
  // The relocated library lives inside the old library directory.
  const nextLibraryDir = join(previousLibraryDir, "moved-inside");
  await mkdir(nextLibraryDir, { recursive: true });
  await writeFile(join(nextLibraryDir, "mosa.db"), "sqlite-placeholder");
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  const { calls, trashItem } = makeFakeTrash();

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem,
    log: () => {},
  });

  assert.deepEqual(result, { action: "removed-record", reason: "old-library-overlaps-current" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(previousLibraryDir), true, "the containing old library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
});

test("5. an old library that contains no library database is never trashed", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t, { withOldLibrary: false });
  await writeFile(join(previousLibraryDir, "random-download.bin"), "not a library");
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  const { calls, trashItem } = makeFakeTrash();

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem,
    log: () => {},
  });

  assert.deepEqual(result, { action: "removed-record", reason: "old-library-not-a-library" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(previousLibraryDir), true, "the non-library directory must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
});

test("6. an old library that no longer exists removes the record without trashing and without throwing", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t, { withOldLibrary: false });
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  await rm(previousLibraryDir, { recursive: true, force: true });
  const { calls, trashItem } = makeFakeTrash();
  const logs = [];

  const result = await settlePendingOldLibraryCleanup({ userDataDir, currentLibraryDir: nextLibraryDir, trashItem, log: (m) => logs.push(m) });

  assert.deepEqual(result, { action: "removed-record", reason: "old-library-missing" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
  assert.match(logs.join("\n"), /no longer exists/);
});

test("7. an unparsable record removes the record, trashes nothing, and does not throw", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t);
  await writeFile(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD), "{ this is not json", "utf8");
  const { calls, trashItem } = makeFakeTrash();
  const logs = [];

  const result = await settlePendingOldLibraryCleanup({ userDataDir, currentLibraryDir: nextLibraryDir, trashItem, log: (m) => logs.push(m) });

  assert.deepEqual(result, { action: "removed-record", reason: "unreadable-record" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(previousLibraryDir), true, "the old library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
  assert.match(logs.join("\n"), /not valid JSON/);
});

test("8. a failing trashItem keeps the record, keeps the old library, and logs the reason", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t);
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });
  const logs = [];
  const failingTrashItem = async () => {
    throw new Error("trash volume unavailable");
  };

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem: failingTrashItem,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { action: "kept-record", reason: "trash-failed" });
  assert.equal(existsSync(previousLibraryDir), true, "the old library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), true, "the record must be kept so the next launch retries");
  assert.match(logs.join("\n"), /trash volume unavailable/);
});

test("9. the recorded file round-trips: atomic write, no temporary leftovers, and the fields settle reads back", async (t) => {
  const { userDataDir, previousLibraryDir, nextLibraryDir } = await makeWorkspace(t);
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir });

  const entries = await readdir(userDataDir);
  assert.deepEqual(entries.filter((name) => name.startsWith(PENDING_OLD_LIBRARY_CLEANUP_RECORD)), [PENDING_OLD_LIBRARY_CLEANUP_RECORD], "no temporary file may remain");

  const record = await readRecord(userDataDir);
  assert.equal(record.previousLibraryDir, resolve(previousLibraryDir));
  assert.equal(record.nextLibraryDir, resolve(nextLibraryDir));
  assert.match(record.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  // The very record just written is accepted by settle without re-recording.
  const { calls, trashItem } = makeFakeTrash();
  const result = await settlePendingOldLibraryCleanup({ userDataDir, currentLibraryDir: nextLibraryDir, trashItem, log: () => {} });
  assert.deepEqual(result, { action: "trashed" });
  assert.deepEqual(calls, [resolve(previousLibraryDir)]);
});

test("10. the current library containing the old library (the move went to the parent folder) is never trashed", async (t) => {
  const { root, userDataDir, previousLibraryDir } = await makeWorkspace(t);
  // The relocated library is a PARENT of the old library directory.
  const nextLibraryDir = join(root, "parent-library");
  await mkdir(nextLibraryDir, { recursive: true });
  await writeFile(join(nextLibraryDir, "mosa.db"), "sqlite-placeholder");
  const oldInside = join(nextLibraryDir, "old-inside");
  await mkdir(oldInside, { recursive: true });
  await writeFile(join(oldInside, "mosa.db"), "sqlite-placeholder");
  await recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir: oldInside, nextLibraryDir });
  const { calls, trashItem } = makeFakeTrash();

  const result = await settlePendingOldLibraryCleanup({
    userDataDir,
    currentLibraryDir: nextLibraryDir,
    trashItem,
    log: () => {},
  });

  assert.deepEqual(result, { action: "removed-record", reason: "old-library-overlaps-current" });
  assert.deepEqual(calls, [], "trashItem must not be called");
  assert.equal(existsSync(oldInside), true, "the contained old library must stay");
  assert.equal(existsSync(join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD)), false, "the record must be removed");
});

test("11. the relocation handler records a pending cleanup instead of deleting the old library, and main.mjs settles once after the service opens", () => {
  // Wiring nail (task 443 reverse verification 3): no existing test drives
  // the change-library-location success path, so this source nail is what
  // turns "the handler went back to rm()ing the old library" red.
  const handlerSource = readFileSync(join(repositoryRoot, "desktop", "ipc", "library-location.mjs"), "utf8");
  assert.match(handlerSource, /recordPendingOldLibraryCleanup\(\{/);
  assert.doesNotMatch(handlerSource, /rm\(previousLibraryDir/, "the handler must not delete the old library itself");
  assert.doesNotMatch(handlerSource, /app\.relaunch\(\);\s*app\.exit\(0\);\s*return \{ ok: true, restarting: true \};\s*\}\s*$/, "the record write must sit between setLibraryDir and the relaunch");

  const mainSource = readFileSync(join(repositoryRoot, "desktop", "main.mjs"), "utf8");
  assert.match(mainSource, /settlePendingOldLibraryCleanupOnce\(\);/);
  // The settle call must sit immediately after ensureDesktopService() returns:
  // a thrown open (the relocated library does not open) must never reach it.
  assert.match(mainSource, /const activeService = await ensureDesktopService\(\);[\s\S]*?settlePendingOldLibraryCleanupOnce\(\);/);
  assert.match(mainSource, /trashItem: \(path\) => shell\.trashItem\(path\)/);
});
