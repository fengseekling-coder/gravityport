/** Gallery column-count choice: the slider options, the viewport-derived
 * default, and its localStorage persistence. Kept free of React/DOM globals
 * so the geometry tests can compile it standalone with tsc. */

export const columnOptions = [2, 3, 4, 5, 6, 8]

export const GALLERY_COLUMNS_STORAGE_KEY = "gravityport.galleryColumns"

type ColumnsStorage = {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** Column count for a gallery without a usable stored choice: the long-standing
 * viewport default — 4 columns wide, 3 under 1400px, 2 under 900px. */
export function resolveInitialColumns(stored: string | null, viewportWidth: number): number {
  const parsed = stored === null ? Number.NaN : Number(stored)
  if (columnOptions.includes(parsed)) return parsed
  if (!(Number.isFinite(viewportWidth) && viewportWidth > 0)) return 4
  if (viewportWidth >= 1400) return 4
  if (viewportWidth >= 900) return 3
  return 2
}

/** Stored raw choice, or null when absent or unreadable (private mode etc.). */
export function readStoredColumns(storage: ColumnsStorage): string | null {
  try {
    return storage.getItem(GALLERY_COLUMNS_STORAGE_KEY)
  } catch {
    return null
  }
}

/** Persist a choice; ignores values outside the slider options and swallows
 * write failures (quota, privacy mode) — the choice just won't survive. */
export function writeStoredColumns(storage: ColumnsStorage, value: number): void {
  if (!columnOptions.includes(value)) return
  try {
    storage.setItem(GALLERY_COLUMNS_STORAGE_KEY, String(value))
  } catch {
    // unreadable storage must never break the column switch
  }
}
