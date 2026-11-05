import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { createAssetStore } from "../lib/asset-store.mjs";
import { hasCompletedSqliteLibrary, sqliteDatabasePath } from "../lib/sqlite-asset-store.mjs";
import { deferTestPathRemoval } from "./test-cleanup.mjs";

// 任务 337：库校验失败要报出真实错误、区分「被占用」和「打不开/已损坏」。
// 所有测试库都建在临时目录，不碰 ~/MOSA Library；hasCompletedSqliteLibrary
// 必须保持只读打开（用「文件字节 + mtime 不变」钉住）。

async function tempHome(t, prefix = "mosa-libverify-") {
  const home = await mkdtemp(join(tmpdir(), prefix));
  deferTestPathRemoval(home, { recursive: true, force: true });
  return home;
}

/** Minimal completed library: exactly what hasCompletedSqliteLibrary reads. */
function seedCompletedLibrary(libraryDir) {
  mkdirSync(libraryDir, { recursive: true });
  const database = new Database(join(libraryDir, "mosa.db"));
  database.exec("CREATE TABLE library_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);");
  database
    .prepare("INSERT INTO library_meta (key, value, updated_at) VALUES ('migration_state', 'completed', ?)")
    .run(new Date().toISOString());
  database.close();
}

/**
 * Hold an exclusive SQLite lock from a worker thread. Resolves `locked` once
 * BEGIN EXCLUSIVE is held and `released` once the worker closed its
 * connection; `worker` lets the test end a hold<0 lock deliberately.
 */
function holdExclusiveLock(t, databasePath, holdMs) {
  const worker = new Worker(new URL("./fixtures/library-lock-holder.mjs", import.meta.url), {
    workerData: { databasePath, holdMs },
  });
  const locked = new Promise((resolvePromise, rejectPromise) => {
    worker.on("message", (message) => { if (message === "locked") resolvePromise(); });
    worker.on("error", rejectPromise);
  });
  const released = new Promise((resolvePromise) => {
    worker.on("message", (message) => { if (message === "released") resolvePromise(); });
  });
  t.after(() => void worker.terminate());
  return { worker, locked, released };
}

/** Capture console.error around one synchronous run. */
function withCapturedConsoleError(run) {
  const records = [];
  const originalError = console.error;
  console.error = (...args) => { records.push(args.map(String).join(" ")); };
  try {
    return { result: run(), records };
  } finally {
    console.error = originalError;
  }
}

test("a corrupted mosa.db reports SQLITE_LIBRARY_UNREADABLE with the real sqlite code and leaves the file untouched", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await mkdir(libraryDir, { recursive: true });
  const databasePath = join(libraryDir, "mosa.db");
  const corruption = randomBytes(100);
  await writeFile(databasePath, corruption);
  const before = await stat(databasePath, { bigint: true });

  const { records } = withCapturedConsoleError(() => {
    assert.throws(
      () => hasCompletedSqliteLibrary(libraryDir),
      (error) => error?.code === "SQLITE_LIBRARY_UNREADABLE"
        && (error.sqliteCode === "SQLITE_NOTADB" || error.sqliteCode === "SQLITE_CORRUPT")
        && error.libraryDir === resolve(libraryDir)
        && error.cause instanceof Error,
    );
  });

  // 只读打开不许动文件：字节和 mtime 都不变。
  assert.deepEqual(await readFile(databasePath), corruption);
  assert.equal((await stat(databasePath, { bigint: true })).mtimeNs, before.mtimeNs);
  // 抛错前正好一条 [MOSA] 日志，带原始 SQLite 错误码。
  assert.equal(records.length, 1, "one [MOSA] log line per verification failure");
  assert.match(records[0], /^\[MOSA\]/);
  assert.match(records[0], /SQLITE_NOTADB|SQLITE_CORRUPT/);
});

test("a valid SQLite database without library_meta still reports SQLITE_LIBRARY_UNREADABLE and stays untouched", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await mkdir(libraryDir, { recursive: true });
  const databasePath = join(libraryDir, "mosa.db");
  const empty = new Database(databasePath);
  empty.close();
  const bytesBefore = await readFile(databasePath);

  const { records } = withCapturedConsoleError(() => {
    assert.throws(
      () => hasCompletedSqliteLibrary(libraryDir),
      (error) => error?.code === "SQLITE_LIBRARY_UNREADABLE" && /^SQLITE_/.test(error.sqliteCode),
    );
  });

  assert.deepEqual(await readFile(databasePath), bytesBefore);
  assert.equal(records.length, 1);
  assert.match(records[0], /^\[MOSA\]/);
});

test("createAssetStore propagates the unreadable error instead of opening anything", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  await mkdir(libraryDir, { recursive: true });
  await writeFile(join(libraryDir, "mosa.db"), randomBytes(100));

  assert.throws(
    () => createAssetStore({ projectRoot: home, managerDir: home, libraryDir, explicitLibraryDir: libraryDir }),
    (error) => error?.code === "SQLITE_LIBRARY_UNREADABLE" && error.sqliteCode === "SQLITE_NOTADB",
  );
  // 没有退回 JSON 库、也没有建出托管媒体或别的存储痕迹。
  assert.equal(existsSync(join(libraryDir, "assets")), false);
});

test("a lock held past the retry budget reports SQLITE_LIBRARY_BUSY in about 3 seconds, then success once released", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  seedCompletedLibrary(libraryDir);
  const { worker, locked, released } = holdExclusiveLock(t, sqliteDatabasePath(libraryDir), -1);
  await locked;

  const { records } = withCapturedConsoleError(() => {
    const startedAt = Date.now();
    assert.throws(
      () => hasCompletedSqliteLibrary(libraryDir),
      (error) => error?.code === "SQLITE_LIBRARY_BUSY"
        && error.sqliteCode === "SQLITE_BUSY"
        && error.libraryDir === resolve(libraryDir),
    );
    const elapsed = Date.now() - startedAt;
    // 重试预算：syncSleep 合计 3000ms；timeout: 0 让每条尝试立即失败。
    assert.ok(elapsed >= 2500, `expected the retry budget to be spent, took ${elapsed}ms`);
    assert.ok(elapsed < 6000, `expected about 3 seconds, took ${elapsed}ms`);
  });
  assert.equal(records.length, 1, "exactly one [MOSA] log line after the retries give up");
  assert.match(records[0], /SQLITE_BUSY/);

  // 锁放掉之后，同样的调用恢复正常返回 true，也不再记失败日志。
  worker.postMessage("release");
  await released;
  await once(worker, "exit");
  const { result, records: recordsAfterRelease } = withCapturedConsoleError(() => hasCompletedSqliteLibrary(libraryDir));
  assert.equal(result, true);
  assert.deepEqual(recordsAfterRelease, []);
});

test("a lock released mid-retry lets the verification succeed without throwing", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  seedCompletedLibrary(libraryDir);
  const { locked } = holdExclusiveLock(t, sqliteDatabasePath(libraryDir), 500);
  await locked;

  // 主线程阻塞在同步重试里时，worker 自己的 500ms 定时器照常触发并放锁。
  const { result, records } = withCapturedConsoleError(() => hasCompletedSqliteLibrary(libraryDir));
  assert.equal(result, true);
  assert.deepEqual(records, [], "no failure log when a retry succeeds");
});

test("a healthy completed library verifies true and logs nothing", async (t) => {
  const home = await tempHome(t);
  const libraryDir = join(home, "lib");
  seedCompletedLibrary(libraryDir);

  const { result, records } = withCapturedConsoleError(() => hasCompletedSqliteLibrary(libraryDir));
  assert.equal(result, true);
  assert.deepEqual(records, []);
});
