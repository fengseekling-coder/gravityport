/**
 * GravityPort import pipeline: staged upload, batch creation.
 *
 * This is a pure-logic module with no UI dependencies. It handles:
 * - Staged file upload with controlled concurrency
 * - Batched import-batch calls (max 40 per request)
 * - Automatic cleanup of orphaned staged files on failure
 * - Optional group assignment for successful imports
 * - Full AbortSignal support throughout
 *
 * Folder scanning is handled by ./collect-dropped-files.ts
 */

import { stageImportFile, requestJson, setAssetsGroup, normalizeAsset } from "./mosa-api.js";
import type { ImportExistingLocation, MosaAsset } from "./mosa-api.js";
import { collectDroppedFiles, excludeLibraryFiles } from "./collect-dropped-files.js";

// Re-export for convenience
export { collectDroppedFiles, excludeLibraryFiles };

// ─── Types ────────────────────────────────────────────────────────────────────

export type { ScanProgressOptions, ScanResult } from "./collect-dropped-files";

export interface ImportProgress {
  phase: "importing" | "done"
  total: number
  completed: number
  imported: number
  failed: number
  skipped: number
  /** Task 292: the batch's successful imports, gallery-ready. Empty on the
   * final "done" callback — each batch already delivered its own cards. */
  assets: MosaAsset[]
}

export interface ImportError {
  fileName: string
  reason: string
}

/** A dropped file whose bytes the library already holds outside Trash (task 291). */
export interface AlreadyInLibraryEntry {
  fileName: string
  existingAsset: ImportExistingLocation
}

export interface ImportResult {
  imported: number
  failed: number
  skipped: number
  createdIds: string[]
  errors: ImportError[]
  alreadyInLibrary: AlreadyInLibraryEntry[]
}

export interface RunImportOptions {
  project: string
  stackId?: string
  groupName?: string
  isSupported: (name: string) => boolean
  signal?: AbortSignal
  onProgress?: (progress: ImportProgress) => void
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGING_CONCURRENCY = 4
const CREATE_BATCH_SIZE = 40

// ─── Concurrent utility ────────────────────────────────────────────────────────

interface ConcurrentResult<T> {
  ok: boolean
  value?: T
  error?: unknown
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<ConcurrentResult<R>[]> {
  const results = new Array<ConcurrentResult<R>>(items.length)
  let cursor = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await mapper(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  )
  return results
}

// ─── Staged file cleanup ───────────────────────────────────────────────────────

async function cleanupStagedFile(stagedPath: string): Promise<void> {
  if (!stagedPath || typeof stagedPath !== "string") return
  try {
    await fetch("/api/import/stage", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: stagedPath }),
      credentials: "same-origin",
    })
  } catch (error) {
    // Non-fatal: log but don't interrupt
    console.warn(`[MOSA] staged file cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function cleanupPaths(paths: string[]): Promise<void> {
  // Deduplicate paths to avoid cleaning the same file twice
  const uniquePaths = Array.from(new Set(paths))
  await mapWithConcurrency(uniquePaths, STAGING_CONCURRENCY, (path) => cleanupStagedFile(path))
}

// ─── Batch import ─────────────────────────────────────────────────────────────

/**
 * Run the full import pipeline: stage files, batch-create assets, cleanup on failure.
 *
 * Process files in batches of 40: stage 40 files (concurrency 4) → import batch → cleanup failures → next batch.
 * This avoids accumulating thousands of staged files and provides incremental progress.
 *
 * @param files - File objects to import
 * @param options.project - Target project id
 * @param options.stackId - Optional stack id to add imported assets to
 * @param options.groupName - Optional group name to assign to created assets
 * @param options.isSupported - Filter function for supported file names
 * @param options.signal - AbortSignal to cancel the operation
 * @param options.onProgress - Progress callback
 */
export async function runImport(
  files: File[],
  options: RunImportOptions,
): Promise<ImportResult> {
  const {
    project,
    stackId,
    groupName,
    isSupported,
    signal,
    onProgress,
  } = options

  // Separate supported and unsupported files
  const supported: File[] = []
  let skipped = 0
  for (const file of files) {
    if (isSupported(file.name)) {
      supported.push(file)
    } else {
      skipped += 1
    }
  }

  const total = supported.length
  const result: ImportResult = {
    imported: 0,
    failed: 0,
    skipped,
    createdIds: [],
    errors: [],
    alreadyInLibrary: [],
  }

  if (!total) return result

  // Process in batches: stage 40 files → import → cleanup → repeat
  let completed = 0
  for (let offset = 0; offset < supported.length; offset += CREATE_BATCH_SIZE) {
    // Check signal before starting a new batch
    if (signal?.aborted) break

    const batchFiles = supported.slice(offset, offset + CREATE_BATCH_SIZE)

    // ── Stage batch (concurrency 4) ──
    const stagedResults = await mapWithConcurrency(batchFiles, STAGING_CONCURRENCY, async (file, index) => {
      if (signal?.aborted) throw Object.assign(new Error("Import cancelled"), { cancelled: true })
      try {
        const path = await stageImportFile(file)
        return { file, path }
      } catch (error) {
        // Attach fileName to staging errors
        const err = error instanceof Error ? error : new Error(String(error))
        Object.assign(err, { fileName: file.name })
        throw err
      }
    })

    // Separate successful and failed staging results
    const stagedItems: { file: File; path: string }[] = []
    for (let i = 0; i < stagedResults.length; i++) {
      const r = stagedResults[i]
      if (r.ok && r.value) {
        stagedItems.push(r.value)
      } else if (!r.ok && r.error) {
        // A file skipped because the user cancelled is not a failure.
        if ((r.error as { cancelled?: boolean }).cancelled) continue
        result.failed += 1
        result.errors.push({
          fileName: (r.error as Error & { fileName?: string }).fileName || batchFiles[i].name,
          reason: r.error instanceof Error ? r.error.message : String(r.error),
        })
      }
    }

    // Cancelled while staging: drop what this batch staged instead of
    // creating assets the user no longer wants.
    if (signal?.aborted) {
      await cleanupPaths(stagedItems.map((s) => s.path))
      break
    }

    // ── Import batch ──
    // Task 292: this batch's successes as gallery-ready assets, so the caller
    // can put the cards on screen before the next batch returns.
    const batchAssets: MosaAsset[] = []
    if (stagedItems.length > 0) {
      const batchItems = stagedItems.map((s) => ({ imagePath: s.path, fileName: s.file.name }))
      const requestBody: {
        projectId: string
        items: { imagePath: string; fileName: string }[]
        stackId?: string
      } = {
        projectId: project,
        items: batchItems,
      }
      if (stackId) requestBody.stackId = stackId

      try {
        type ImportBatchResponse = {
          imported: number
          failed: number
            results: Array<{
              index: number
              ok: boolean
              asset?: Record<string, unknown>
              skipped?: "already-in-library"
              existingAsset?: ImportExistingLocation
              error?: string
            }>
        }
        const importResult = await requestJson<ImportBatchResponse>("/api/assets/import-batch", {
          method: "POST",
          body: requestBody,
        })

        // Track per-item results
        const failedPaths: string[] = []
        let batchImported = 0
        let batchFailed = 0

        for (let i = 0; i < stagedItems.length; i++) {
          const itemResult = importResult.results?.find((r) => r.index === i)
          const rawAsset = itemResult?.asset
          if (itemResult?.ok && rawAsset && typeof rawAsset.id === "string" && rawAsset.id) {
            result.createdIds.push(rawAsset.id)
            batchAssets.push(normalizeAsset(rawAsset, project))
            batchImported += 1
          } else if (itemResult?.ok && itemResult.skipped === "already-in-library" && itemResult.existingAsset) {
            // Task 291: identical bytes skipped by the server; the staged file
            // was already cleaned up there.
            result.alreadyInLibrary.push({
              fileName: stagedItems[i].file.name,
              existingAsset: itemResult.existingAsset,
            })
          } else {
            failedPaths.push(stagedItems[i].path)
            result.errors.push({
              fileName: stagedItems[i].file.name,
              reason: itemResult?.error || "Import failed",
            })
            batchFailed += 1
          }
        }

        result.imported += batchImported
        result.failed += batchFailed

        // Cleanup only the failed items
        if (failedPaths.length > 0) {
          await cleanupPaths(failedPaths)
        }
      } catch (error) {
        // Entire batch request failed — count all items as failed and clean up all paths
        result.failed += stagedItems.length
        for (const item of stagedItems) {
          result.errors.push({
            fileName: item.file.name,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
        await cleanupPaths(stagedItems.map((s) => s.path))
      }
    }

    completed += batchFiles.length
    onProgress?.({
      phase: "importing",
      total,
      completed,
      imported: result.imported,
      failed: result.failed,
      skipped,
      assets: batchAssets,
    })
  }

  // ── Group assignment ──
  if (groupName && result.createdIds.length > 0) {
    try {
      await setAssetsGroup(project, result.createdIds, groupName)
    } catch (error) {
      console.warn(`[MOSA] group assignment failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  onProgress?.({ phase: "done", total, completed, imported: result.imported, failed: result.failed, skipped, assets: [] })
  return result
}
