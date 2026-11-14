// Task 416 (audit 建1 journal_size_limit): the store's open must set the WAL
// size cap so one long write burst cannot grow the -wal file indefinitely.
// journal_size_limit is a per-connection pragma, so the read-back has to run
// on the very connection the store opened: the test wraps Database.pragma to
// record the statements and capture that connection (recording only — every
// pragma still executes unchanged).
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSqliteAssetStore } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

test("opening the store sets journal_size_limit to 64 MiB on its own connection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mosa-journal-limit-"));
  t.after(() => { try { rm(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  deferTestPathRemoval(root, { recursive: true, force: true });

  const originalPragma = Database.prototype.pragma;
  const statements = [];
  let storeConnection = null;
  t.mock.method(Database.prototype, "pragma", function (name, options) {
    const result = originalPragma.call(this, name, options);
    statements.push(String(name));
    if (String(name).startsWith("journal_size_limit") && !storeConnection) storeConnection = this;
    return result;
  });

  const libraryDir = join(root, "library");
  const store = createSqliteAssetStore({ projectRoot: root, managerDir: join(root, "manager"), libraryDir });
  t.after(() => store.close());

  assert.ok(
    statements.includes("journal_size_limit = 67108864"),
    `the open ran the pragma; statements seen: ${statements.filter((name) => name.startsWith("journal")).join(", ")}`,
  );
  assert.ok(storeConnection, "the pragma ran on the store's own connection");
  assert.equal(storeConnection.pragma("journal_size_limit", { simple: true }), 67108864, "reading the pragma back gives the 64 MiB cap");
  assert.equal(storeConnection.pragma("journal_mode", { simple: true }), "wal", "the WAL mode the cap belongs to is still set");
});
