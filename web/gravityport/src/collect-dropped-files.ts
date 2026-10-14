/**
 * GravityPort drag-and-drop folder scanning.
 *
 * Uses webkitGetAsEntry() to recursively expand folders.
 * Hidden files (starting with ".") are skipped.
 * Unsupported extensions are counted separately and do not count against the maxFiles limit.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScanProgressOptions {
  maxFiles?: number
  isSupported?: (name: string) => boolean
  onScanProgress?: (count: number) => void
}

export interface ScanResult {
  files: File[]
  unsupported: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_DROP_FILES = 10_000

// ─── Error factory ────────────────────────────────────────────────────────────

function dropTooLargeError(maxFiles: number) {
  const error = new Error(`Too many files were dropped. Maximum is ${maxFiles}.`)
  ;(error as Error & { code: string; maxFiles: number }).code = "IMPORT_DROP_TOO_LARGE"
  ;(error as Error & { code: string; maxFiles: number }).maxFiles = maxFiles
  return error
}

// ─── Directory reading ───────────────────────────────────────────────────────

function readDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject))
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

// ─── Recursive visitor ───────────────────────────────────────────────────────

interface ScanContext {
  maxFiles: number
  isSupported: ((name: string) => boolean) | undefined
  onProgress: ((count: number) => void) | undefined
  unsupported: number
}

async function visitEntry(
  entry: FileSystemEntry,
  files: File[],
  scan: ScanContext,
): Promise<void> {
  if (!entry) return

  // Skip hidden files/directories
  if (entry.name.startsWith(".")) return

  if (entry.isFile) {
    if (scan.isSupported && !scan.isSupported(entry.name)) {
      scan.unsupported += 1
      return
    }
    if (files.length >= scan.maxFiles) throw dropTooLargeError(scan.maxFiles)
    files.push(await fileFromEntry(entry as FileSystemFileEntry))
    scan.onProgress?.(files.length)
    return
  }

  if (!entry.isDirectory) return
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  while (true) {
    const entries = await readDirectoryEntries(reader)
    if (!entries.length) break
    for (const child of entries) await visitEntry(child, files, scan)
  }
}

/**
 * Recursively collect dropped files from a DataTransfer object.
 *
 * Uses webkitGetAsEntry() to expand folders. Hidden files (starting with ".")
 * are skipped. Unsupported extensions are counted separately and do not count
 * against the maxFiles limit.
 *
 * @param dataTransfer - The drop event's DataTransfer object
 * @param options.maxFiles - Maximum supported files before throwing (default 10,000)
 * @param options.isSupported - Optional filter function for supported file names
 * @param options.onScanProgress - Called with the current file count during scanning
 */
export async function collectDroppedFiles(
  dataTransfer: DataTransfer | null,
  options: ScanProgressOptions = {},
): Promise<ScanResult> {
  const { maxFiles = DEFAULT_MAX_DROP_FILES, isSupported, onScanProgress } = options

  // Step 1: Collect all entries synchronously during the drop event
  const items = Array.from(dataTransfer?.items || [])
  const entries = items
    .filter((item) => item?.kind === "file")
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean) as FileSystemEntry[]

  if (entries.length) {
    // Step 2: Asynchronously expand directories and collect files
    const files: File[] = []
    const scan: ScanContext = { maxFiles, isSupported, onProgress: onScanProgress, unsupported: 0 }
    for (const entry of entries) await visitEntry(entry, files, scan)
    return { files, unsupported: scan.unsupported }
  }

  // Fallback: no webkitGetAsEntry support — use dataTransfer.files directly
  const dropped = Array.from(dataTransfer?.files || [])
  const files: File[] = []
  let unsupported = 0
  for (const file of dropped) {
    if (isSupported && !isSupported(file.name)) {
      unsupported += 1
      continue
    }
    files.push(file)
  }
  if (files.length > maxFiles) throw dropTooLargeError(maxFiles)
  return { files, unsupported }
}
