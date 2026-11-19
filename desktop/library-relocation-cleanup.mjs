// Task 443 (审查低1 ②): after a library relocation the old library is no
// longer deleted inside the move handler. The handler records a pending
// cleanup (this module), the app restarts on the new location, and only once
// that launch has proven the relocated library actually opens
// (desktop/main.mjs, after ensureDesktopService()) is the old library moved
// to the system trash. Everything here is fail-closed: any doubt about the
// record, the paths, or what the old directory is leaves the old library
// exactly where it is.

import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { LIBRARY_DATABASE_FILE } from "../lib/library-location.mjs";
import { containsOrEquals, sameLocation } from "../lib/library-relocation.mjs";

// Written under the userData directory; consumed by settlePendingOldLibraryCleanup
// on the next launch.
export const PENDING_OLD_LIBRARY_CLEANUP_RECORD = "pending-old-library-cleanup.json";

function recordPathFor(userDataDir) {
  return join(userDataDir, PENDING_OLD_LIBRARY_CLEANUP_RECORD);
}

/**
 * Record that a relocation left an old library behind which may be trashed
 * once the relocated library has proven it opens.
 *
 * The record is written atomically: a temporary file is fsynced and renamed
 * onto the final name, so a crash mid-write can never leave a half-written
 * record that reads back as complete. Throws only on write failures; the
 * caller treats those as "keep the old library" and restarts anyway.
 */
export async function recordPendingOldLibraryCleanup({ userDataDir, previousLibraryDir, nextLibraryDir } = {}) {
  if (!userDataDir) throw new Error("The userData directory is required.");
  if (!previousLibraryDir) throw new Error("The previous library directory is required.");
  if (!nextLibraryDir) throw new Error("The next library directory is required.");
  const recordPath = recordPathFor(userDataDir);
  const temporaryPath = `${recordPath}.tmp`;
  const payload = {
    previousLibraryDir: resolve(String(previousLibraryDir)),
    nextLibraryDir: resolve(String(nextLibraryDir)),
    recordedAt: new Date().toISOString(),
  };
  try {
    const handle = await open(temporaryPath, "w");
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, recordPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Trash the recorded old library when every safety condition holds.
 *
 * Called once per launch after the local service has opened the library at
 * the current location. All of these must hold before anything is trashed:
 * the record reads back with complete fields; the current library is the
 * recorded destination; the old path still exists, is a distinct directory
 * that neither contains nor is contained by the current library; and it
 * contains the library database file. Any other outcome — including a
 * trashItem failure — touches nothing: judged-unsafe outcomes remove the
 * record (the decision is final for that path pair), a trashItem failure
 * keeps the record so the next launch can retry. Never throws.
 */
export async function settlePendingOldLibraryCleanup({ userDataDir, currentLibraryDir, trashItem, log = () => {} } = {}) {
  const recordPath = recordPathFor(userDataDir);
  try {
    let raw;
    try {
      raw = await readFile(recordPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { action: "none" };
      // The record cannot be read at all: remove it, touch nothing (task 443).
      await rm(recordPath, { force: true }).catch(() => {});
      log(`pending old-library cleanup record could not be read (${error?.message || error}); the old library was left untouched and the record removed`);
      return { action: "removed-record", reason: "unreadable-record" };
    }

    const removeRecord = () => rm(recordPath, { force: true });

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      await removeRecord();
      log("pending old-library cleanup record is not valid JSON; the old library was left untouched and the record removed");
      return { action: "removed-record", reason: "unreadable-record" };
    }

    const previousLibraryDir = typeof record?.previousLibraryDir === "string" ? record.previousLibraryDir : "";
    const nextLibraryDir = typeof record?.nextLibraryDir === "string" ? record.nextLibraryDir : "";
    const recordedAt = typeof record?.recordedAt === "string" ? record.recordedAt : "";
    if (!previousLibraryDir || !nextLibraryDir || !recordedAt) {
      await removeRecord();
      log("pending old-library cleanup record is incomplete; the old library was left untouched and the record removed");
      return { action: "removed-record", reason: "incomplete-record" };
    }

    if (!currentLibraryDir) {
      await removeRecord();
      log("the current library directory is unknown; the old library was left untouched and the record removed");
      return { action: "removed-record", reason: "no-current-library" };
    }

    // The current library must be the recorded destination: otherwise the
    // relocation this record describes never became the active library.
    if (!await sameLocation(currentLibraryDir, nextLibraryDir)) {
      await removeRecord();
      log(`the current library is not the recorded destination (${nextLibraryDir}); the old library ${previousLibraryDir} was left untouched and the record removed`);
      return { action: "removed-record", reason: "current-library-mismatch" };
    }

    const oldLibraryInfo = await stat(previousLibraryDir).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (!oldLibraryInfo) {
      await removeRecord();
      log(`the recorded old library ${previousLibraryDir} no longer exists; the record was removed`);
      return { action: "removed-record", reason: "old-library-missing" };
    }

    // The old path must be a distinct directory: same location or mutual
    // containment would put the live library into the trash.
    if (await sameLocation(previousLibraryDir, currentLibraryDir)
      || await containsOrEquals(previousLibraryDir, currentLibraryDir)
      || await containsOrEquals(currentLibraryDir, previousLibraryDir)) {
      await removeRecord();
      log(`the recorded old library ${previousLibraryDir} overlaps the current library; the old library was left untouched and the record removed`);
      return { action: "removed-record", reason: "old-library-overlaps-current" };
    }

    // The old path must look like a library, not just any folder.
    const databaseInfo = await stat(join(previousLibraryDir, LIBRARY_DATABASE_FILE)).catch((error) => {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    });
    if (!databaseInfo?.isFile()) {
      await removeRecord();
      log(`the recorded old library ${previousLibraryDir} has no ${LIBRARY_DATABASE_FILE}; it does not look like a library, so it was left untouched and the record removed`);
      return { action: "removed-record", reason: "old-library-not-a-library" };
    }

    try {
      await trashItem(previousLibraryDir);
    } catch (error) {
      log(`moving the old library ${previousLibraryDir} to the trash failed (${error?.message || error}); the record is kept for the next launch`);
      return { action: "kept-record", reason: "trash-failed" };
    }
    await removeRecord();
    log(`the old library ${previousLibraryDir} was moved to the trash now that the relocated library has opened`);
    return { action: "trashed" };
  } catch (error) {
    // Anything unexpected (unreadable filesystem state, a failing check)
    // keeps the record and the old library for the next launch.
    log(`pending old-library cleanup could not run (${error?.message || error}); the old library was left untouched and the record kept`);
    return { action: "kept-record", reason: "unexpected-error" };
  }
}
