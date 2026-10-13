/**
 * Gallery window geometry. The CSS grid lays cards out row by row with
 * `aspect-ratio` sizing, so a row's height is the tallest card ratio in it —
 * deterministic from (column width, gap, ratios). The window keeps only rows
 * near the viewport mounted (real cards in the hydrate zone, same-geometry
 * placeholders in the warm zone) while top/bottom spacers preserve the full
 * scroll extent.
 */

export type GalleryRowModel = {
  columns: number
  /** Content height of each row, excluding the gap. */
  rowHeight: number[]
  /** Top edge of each row (length = rows + 1; last entry = content end + gap). */
  rowOffset: number[]
  /** Full scrollable content height, gaps between rows included. */
  totalHeight: number
  gap: number
}

export function buildGalleryRowModel(
  heightRatios: number[],
  columns: number,
  colWidth: number,
  gap: number,
): GalleryRowModel {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeGap = Math.max(0, gap)
  const rowHeight: number[] = []
  for (let index = 0; index < heightRatios.length; index += safeColumns) {
    let tallest = 0
    for (let item = index; item < Math.min(index + safeColumns, heightRatios.length); item += 1) {
      tallest = Math.max(tallest, heightRatios[item] * colWidth)
    }
    rowHeight.push(tallest)
  }
  const rowOffset: number[] = [0]
  for (const height of rowHeight) rowOffset.push(rowOffset[rowOffset.length - 1] + height + safeGap)
  const totalHeight = Math.max(0, rowOffset[rowOffset.length - 1] - safeGap)
  return { columns: safeColumns, rowHeight, rowOffset, totalHeight, gap: safeGap }
}

export type GalleryRowRange = { startRow: number; endRow: number }

/** Rows whose vertical extent intersects [top, bottom]; null when none. */
export function rowsIntersecting(model: GalleryRowModel, top: number, bottom: number): GalleryRowRange | null {
  const lastRow = model.rowHeight.length - 1
  if (lastRow < 0) return null
  const lo = Math.max(0, Math.min(top, model.totalHeight))
  const hi = Math.max(0, Math.min(bottom, model.totalHeight))
  if (hi < lo) return null
  let start = 0
  while (start <= lastRow && model.rowOffset[start] + model.rowHeight[start] <= lo) start += 1
  if (start > lastRow) return null
  let end = start
  while (end < lastRow && model.rowOffset[end + 1] < hi) end += 1
  return { startRow: start, endRow: end }
}

/** Warm window around the viewport: the viewport rows always stay mounted,
 * the range grows toward the warm zone and is capped at `maxRows`. */
export function locateGalleryWindow(
  model: GalleryRowModel,
  scrollTop: number,
  viewportHeight: number,
  warmupPx: number,
  maxRows: number,
): GalleryRowRange | null {
  const view = rowsIntersecting(model, scrollTop, scrollTop + Math.max(0, viewportHeight))
  if (!view) return null
  const lastRow = model.rowHeight.length - 1
  const desired = rowsIntersecting(model, scrollTop - warmupPx, scrollTop + viewportHeight + warmupPx)
    ?? view
  const room = maxRows - (view.endRow - view.startRow + 1)
  if (room <= 0) return view
  // Grow symmetrically around the viewport, within both the warm zone and
  // the mounted-cards budget.
  const before = Math.min(Math.ceil(room / 2), view.startRow, view.startRow - desired.startRow)
  const after = Math.min(Math.floor(room / 2), lastRow - view.endRow, desired.endRow - view.endRow)
  return { startRow: view.startRow - Math.max(0, before), endRow: view.endRow + Math.max(0, after) }
}

/** Spacer heights that keep the scroll extent exact while only
 * [startRow, endRow] is mounted (0 means "omit this spacer"). */
export function gallerySpacerHeights(
  model: GalleryRowModel,
  startRow: number,
  endRow: number,
): { top: number; bottom: number } {
  const lastRow = model.rowHeight.length - 1
  const top = startRow <= 0 ? 0 : Math.max(0, model.rowOffset[startRow] - model.gap)
  const bottom = endRow >= lastRow ? 0 : Math.max(0, model.totalHeight - model.rowOffset[endRow + 1])
  return { top, bottom }
}
