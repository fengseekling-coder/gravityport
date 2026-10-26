import { createReferenceAttachmentStore } from "./reference-attachment-store.js";

type HardlinkCapableStore = {
  findOriginalByContentHash: (projectId: string, contentSha256: string) => Promise<string>;
  isReferenceHardlinkMigrationDone: () => Promise<boolean>;
  completeReferenceHardlinkMigration: () => Promise<void>;
};

/**
 * Schedules the one-shot reference hard-link migration for a freshly opened
 * library. Everything here is best-effort: unsupported or missing store
 * capabilities disable the pass, and any failure only logs, because the
 * migration is idempotent and will run again on the next open. Runs detached
 * so opening a library never waits on it.
 */
export function scheduleReferenceHardlinkMigration(store: unknown, libraryDir: string): void {
  const capable = store as Partial<HardlinkCapableStore>;
  if (typeof capable.findOriginalByContentHash !== "function"
    || typeof capable.isReferenceHardlinkMigrationDone !== "function"
    || typeof capable.completeReferenceHardlinkMigration !== "function") return;
  const typed = capable as HardlinkCapableStore;
  const referenceStore = createReferenceAttachmentStore(libraryDir);
  void typed.isReferenceHardlinkMigrationDone()
    .then((done) => (done ? undefined : referenceStore.migrateToHardLinks({
      findOriginalPath: (projectId, contentSha256) => typed.findOriginalByContentHash(projectId, contentSha256),
      isDone: () => typed.isReferenceHardlinkMigrationDone(),
      markDone: () => typed.completeReferenceHardlinkMigration(),
    })))
    .catch((error: unknown) => {
      // A store closed before the pass finished just retries on the next open.
      if (/database connection is not open/i.test(String((error as Error)?.message || ""))) return;
      console.warn(`[MOSA] reference hard-link migration skipped: ${(error as Error)?.message || error}`);
    });
}
