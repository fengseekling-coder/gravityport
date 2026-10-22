import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SCHEMA_UPGRADE_MARKER_NAME,
  markPendingSchemaUpgrade,
  schemaUpgradeMarkerPath,
} from "../desktop/update-schema-marker.mjs";
import { CURRENT_SCHEMA_VERSION } from "../lib/sqlite-asset-store.mjs";
import { removeTestPath } from "./test-cleanup.mjs";

async function fixture(t, { schemaVersion = null, completed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gp-schema-marker-"));
  t.after(() => removeTestPath(root, { recursive: true, force: true }));
  const libraryDir = join(root, "library");
  const stagingDir = join(root, "updates", "macos", "0.3.3");
  await mkdir(libraryDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });
  if (schemaVersion !== null) {
    const database = new Database(join(libraryDir, "mosa.db"));
    database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, '2026-10-22T00:00:00.000Z')");
    insert.run("schema_version", String(schemaVersion));
    insert.run("migration_state", completed ? "completed" : "in-progress");
    database.close();
  }
  return { libraryDir, readyFile: join(stagingDir, "update-ready.json") };
}

test("an update launch that is about to upgrade the schema leaves a marker next to the ready file", async (t) => {
  const { libraryDir, readyFile } = await fixture(t, { schemaVersion: CURRENT_SCHEMA_VERSION - 1 });
  const result = markPendingSchemaUpgrade({ readyFile, libraryDir, now: () => new Date("2026-10-22T10:00:00.000Z") });
  assert.deepEqual(result, { marked: true, from: CURRENT_SCHEMA_VERSION - 1, to: CURRENT_SCHEMA_VERSION });
  const markerPath = schemaUpgradeMarkerPath(readyFile);
  assert.equal(markerPath, join(readyFile, "..", SCHEMA_UPGRADE_MARKER_NAME));
  assert.deepEqual(JSON.parse(readFileSync(markerPath, "utf8")), {
    from: CURRENT_SCHEMA_VERSION - 1,
    to: CURRENT_SCHEMA_VERSION,
    at: "2026-10-22T10:00:00.000Z",
  });
});

test("a library already on the current schema gets no marker", async (t) => {
  const { libraryDir, readyFile } = await fixture(t, { schemaVersion: CURRENT_SCHEMA_VERSION });
  assert.equal(markPendingSchemaUpgrade({ readyFile, libraryDir }).marked, false);
  assert.equal(existsSync(schemaUpgradeMarkerPath(readyFile)), false);
});

test("a missing or not yet migrated library gets no marker", async (t) => {
  const missing = await fixture(t);
  assert.deepEqual(markPendingSchemaUpgrade(missing), { marked: false, reason: "no-sqlite-library" });
  const legacy = await fixture(t, { schemaVersion: 1, completed: false });
  assert.deepEqual(markPendingSchemaUpgrade(legacy), { marked: false, reason: "no-sqlite-library" });
  assert.equal(existsSync(schemaUpgradeMarkerPath(missing.readyFile)), false);
  assert.equal(existsSync(schemaUpgradeMarkerPath(legacy.readyFile)), false);
});

test("an unreadable library never blocks startup and leaves no marker", async (t) => {
  const { libraryDir, readyFile } = await fixture(t, { schemaVersion: CURRENT_SCHEMA_VERSION - 1 });
  const failed = markPendingSchemaUpgrade({
    readyFile,
    libraryDir,
    readSchemaVersion: () => { throw new Error("disk went away"); },
  });
  assert.deepEqual(failed, { marked: false, reason: "error" });

  const corrupt = await fixture(t);
  await writeFile(join(corrupt.libraryDir, "mosa.db"), "not a database", "utf8");
  assert.deepEqual(markPendingSchemaUpgrade(corrupt), { marked: false, reason: "error" });
  assert.equal(existsSync(schemaUpgradeMarkerPath(readyFile)), false);
});

test("an ordinary launch without a ready file never checks the library", async (t) => {
  const { libraryDir } = await fixture(t, { schemaVersion: CURRENT_SCHEMA_VERSION - 1 });
  let read = false;
  const result = markPendingSchemaUpgrade({ readyFile: null, libraryDir, readSchemaVersion: () => { read = true; return 1; } });
  assert.deepEqual(result, { marked: false, reason: "not-an-update-launch" });
  assert.equal(read, false);
});

test("desktop main marks a pending upgrade before starting the service and holds bridges until readiness", () => {
  const source = readFileSync(new URL("../desktop/main.mjs", import.meta.url), "utf8");
  const ensure = source.slice(source.indexOf("async function ensureDesktopService()"));
  const mark = ensure.indexOf("markPendingSchemaUpgrade({ readyFile: updateReadyFile, libraryDir })");
  assert.ok(mark > 0 && mark < ensure.indexOf("await startMosaService({"), "the marker is written before the runtime can upgrade the library");
  assert.match(ensure, /bridgeStartupGate: bridgesAfterUpdateReady/);
  const ready = source.slice(source.indexOf('ipcMain.handle("renderer-ready"'));
  const write = ready.indexOf("writeFileSync(readyFile");
  const release = ready.indexOf("releaseBridgesAfterUpdateReady();");
  assert.ok(write > 0 && release > write, "bridges are released only after the ready file is written");
  assert.match(source, /setTimeout\(resolveGate, UPDATE_READY_BRIDGE_FALLBACK_MS\)/, "a fallback releases the bridges even without readiness");
});
