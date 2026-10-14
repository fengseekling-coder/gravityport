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

import { stageImportFile, importAssetsBatch, setAssetsGroup } from "./mosa-api";
import { collectDroppedFiles } from "./collect-dropped-files";

// Re-export for convenience
export { collectDroppedFiles };

// ─── Types ────────────────────────────────────────────────────────────────────

export type { ScanProgressOptions, ScanResult } from "./collect-dropped-files";

export interface ImportProgress {
  phase: "staging" | "importing" | "done"
  total: number
  completed: number
  imported: number
  failed: number
  skipped: number
}

export interface ImportError {
  fileName: string
  reason: string
}

export interface ImportResult {
  imported: number
  failed: number
  skipped: number
  createdIds: string[]
  errors: ImportError[]
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
  await mapWithConcurrency(paths, STAGING_CONCURRENCY, (path) => cleanupStagedFile(path))
}

// ─── Batch import ─────────────────────────────────────────────────────────────

/**
 * Run the full import pipeline: stage files, batch-create assets, cleanup on failure.
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
  }

  if (!total) return result

  // ── Staging phase ──
  onProgress?.({ phase: "staging", total, completed: 0, imported: 0, failed: 0, skipped })

  // Stage all files concurrently (4 at a time)
  const stagedResults = await mapWithConcurrency(supported, STAGING_CONCURRENCY, async (file) => {
    // Check signal before each staging call
    if (signal?.aborted) throw new Error("Import cancelled")
    const path = await stageImportFile(file)
    return { file, path }
  })

  // Collect successfully staged files and count failures
  const stagedFiles: { file: File; path: string }[] = []
  for (const r of stagedResults) {
    if (r.ok && r.value) {
      stagedFiles.push(r.value)
    } else if (!r.ok && r.error) {
      result.failed += 1
      result.errors.push({
        fileName: (r.error as Error & { fileName?: string }).fileName || "unknown",
        reason: r.error instanceof Error ? r.error.message : String(r.error),
      })
    }
  }

  // Track paths that need cleanup
  const finalPathsToClean: string[] = []

  try {
    // ── Import phase ──
    onProgress?.({ phase: "importing", total, completed: 0, imported: 0, failed: result.failed, skipped })

    let completed = 0
    for (let offset = 0; offset < stagedFiles.length; offset += CREATE_BATCH_SIZE) {
      // Check signal before starting a new batch
      if (signal?.aborted) {
        // Clean up all staged files that haven't been imported
        finalPathsToClean.push(...stagedFiles.slice(offset).map((s) => s.path))
        break
      }

      const batch = stagedFiles.slice(offset, offset + CREATE_BATCH_SIZE)
      const batchItems = batch.map((s) => ({ imagePath: s.path }))

      // Add stackId if provided
      const requestBody: { projectId: string; items: { imagePath: string }[]; stackId?: string } = {
        projectId: project,
        items: batchItems,
      }
      if (stackId) requestBody.stackId = stackId

      try {
        const importResult = await importAssetsBatch(project, batchItems)

        // Track successfully imported paths for cleanup tracking
        const failedInBatch: { file: File; path: string }[] = []

        for (let i = 0; i < batch.length; i++) {
          const itemResult = importResult.results?.find((r) => r.index === i)
          if (itemResult?.ok && itemResult.id) {
            result.createdIds.push(itemResult.id)
          } else {
            failedInBatch.push(batch[i])
            result.failed += 1
            result.errors.push({
              fileName: batch[i].file.name,
              reason: itemResult?.error || "Import failed",
            })
          }
        }

        result.imported += importResult.imported
        result.failed += importResult.failed

        // Collect paths that need cleanup (failed in batch)
        finalPathsToClean.push(...failedInBatch.map((s) => s.path))

        // Cleanup paths that failed at the individual item level
        if (failedInBatch.length > 0) {
          await cleanupPaths(failedInBatch.map((s) => s.path))
        }
      } catch (error) {
        // Entire batch request failed — all paths in this batch need cleanup
        result.failed += batch.length
        for (const s of batch) {
          result.errors.push({
            fileName: s.file.name,
            reason: error instanceof Error ? error.message : String(error),
          })
          finalPathsToClean.push(s.path)
        }
        // Cleanup all paths from the failed batch
        await cleanupPaths(batch.map((s) => s.path))
      }

      completed += batch.length
      onProgress?.({
        phase: "importing",
        total,
        completed,
        imported: result.imported,
        failed: result.failed,
        skipped,
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
  } finally {
    // Final cleanup: any paths that were staged but not successfully imported
    if (finalPathsToClean.length > 0) {
      await cleanupPaths(finalPathsToClean)
    }
  }

  onProgress?.({ phase: "done", total, completed: total, imported: result.imported, failed: result.failed, skipped })
  return result
}
