// 任务 337 fixture: holds an exclusive SQLite lock on mosa.db from a worker
// thread, so the main thread can block inside the synchronous
// hasCompletedSqliteLibrary while the lock stays held (Atomics.wait blocks the
// main thread only; the worker keeps running). holdMs >= 0 releases
// (ROLLBACK + close) after that many milliseconds; holdMs < 0 keeps the lock
// until the test sends "release". The worker reports progress on parentPort:
// "locked" right after BEGIN EXCLUSIVE, "released" after the connection
// closed.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

// Releasing must end the worker: close the MessagePort after "released" or
// the open port keeps the worker's event loop alive and `once(exit)` waits
// forever in the test.
function release() {
  database.exec("ROLLBACK");
  database.close();
  parentPort.postMessage("released");
  parentPort.close();
}

const database = new Database(workerData.databasePath);
database.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
parentPort.postMessage("locked");
if (workerData.holdMs >= 0) {
  setTimeout(release, workerData.holdMs);
} else {
  parentPort.on("message", (message) => {
    if (message === "release") release();
  });
}
