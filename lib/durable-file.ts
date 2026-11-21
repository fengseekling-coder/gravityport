// Durable file and directory sync helpers (task 450).
//
// Originals (in images/) and reference attachments (plus their index.json) are
// persisted before their metadata is committed to SQLite or index.json. Syncing
// the file contents and parent directory entry first ensures a sudden power
// loss or kernel panic cannot leave a committed record pointing at an empty or
// truncated file.
//
// On macOS, Node's FileHandle.sync() calls libuv uv_fs_fsync, which uses
// F_FULLFSYNC (flushing through the drive cache to permanent media rather than
// plain fsync at ~0.15ms). That costs ~3.8-3.9ms per file plus ~0.1ms for the
// parent directory (~4ms per imported image).
//
// On Windows, FlushFileBuffers requires a writable handle ("r+"). If copyFile
// carried a read-only attribute from the source file, opening with "r+" fails
// with EPERM/EACCES; syncFile returns false in that Windows-only open case
// instead of failing the import. Windows also does not allow opening a
// directory for fsync (and NTFS journals directory metadata updates itself), so
// syncDirectory returns false without opening the directory on win32.

import { open, type FileHandle } from "node:fs/promises";

type SyncOptions = {
  platform?: NodeJS.Platform;
};

export async function syncFile(filePath: string, options?: SyncOptions): Promise<boolean> {
  const platform = options?.platform ?? process.platform;
  const isWindows = platform === "win32";
  let handle: FileHandle;
  try {
    handle = await open(filePath, isWindows ? "r+" : "r");
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (isWindows && (code === "EPERM" || code === "EACCES")) {
      return false;
    }
    throw error;
  }
  try {
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(dirPath: string, options?: SyncOptions): Promise<boolean> {
  const platform = options?.platform ?? process.platform;
  if (platform === "win32") return false;
  const handle = await open(dirPath, "r");
  try {
    await handle.sync();
    return true;
  } finally {
    await handle.close();
  }
}
