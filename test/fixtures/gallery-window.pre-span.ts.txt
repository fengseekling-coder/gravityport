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

/** Cache key for a built row model. Every input the geometry depends on is
 * folded in exactly: asset count, column count, column width, and the
 * quantized ratios in position order. A positional weighted checksum here
 * once folded distinct layouts into one number ([3,1,2,1] and [2,3,1,1] both
 * weigh 15), so one row's cached heights served the other's geometry; the
 * joined key is injective, so equal keys imply equal geometry. */
export function galleryModelSignature(
  ratios: number[],
  columns: number,
  colWidth: number,
): string {
  const parts = new Array<string>(ratios.length)
  for (let index = 0; index < ratios.length; index += 1) {
    parts[index] = String(Math.round(ratios[index] * 1000))
  }
  return `${ratios.length}|${columns}|${Math.round(colWidth)}|${parts.join(",")}`
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

/** True shortest-column masonry. Cards retain their own image aspect ratio;
 * their vertical starts are independent of the tallest card in a CSS row.
 * A stable input order, unchanged by viewport windowing, avoids jumps during
 * scrolling and incremental page hydration. */
export type MasonryPlacement = {
  left: number
  top: number
  width: number
  height: number
  column: number
  /** Accumulated source height ratios and card count above this item. */
  precedingRatio: number
  precedingCount: number
  ratio: number
}

export type MasonryModel = {
  placements: MasonryPlacement[]
  totalHeight: number
  columns: number
  columnWidth: number
  gap: number
  columnRatios: number[]
  columnCounts: number[]
}

export function buildMasonryModel(
  heightRatios: number[], columns: number, columnWidth: number, gap: number,
): MasonryModel {
  const count = Math.max(1, Math.floor(columns))
  const safeWidth = Math.max(1, columnWidth)
  const safeGap = Math.max(0, gap)
  const bottoms = Array<number>(count).fill(0)
  const columnRatios = Array<number>(count).fill(0)
  const columnCounts = Array<number>(count).fill(0)
  const placements: MasonryPlacement[] = []
  for (const ratio of heightRatios) {
    let column = 0
    for (let index = 1; index < count; index += 1) {
      if (bottoms[index] < bottoms[column]) column = index
    }
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
    const height = safeWidth * safeRatio
    placements.push({ left: column * (safeWidth + safeGap), top: bottoms[column],
      width: safeWidth, height, column, precedingRatio: columnRatios[column],
      precedingCount: columnCounts[column], ratio: safeRatio })
    columnRatios[column] += safeRatio
    columnCounts[column] += 1
    bottoms[column] += height + safeGap
  }
  return {
    placements, columns: count, columnWidth: safeWidth, gap: safeGap,
    totalHeight: placements.length ? Math.max(...bottoms) - safeGap : 0,
    columnRatios, columnCounts,
  }
}

/** CSS container units keep already-mounted cards geometrically correct in
 * background Electron windows where ResizeObserver/React may be throttled.
 * CSS handles width changes instantly; JS only reassigns shortest columns. */
export function masonryCardCss(model: MasonryModel, index: number) {
  const place = model.placements[index]
  const inline = `(100cqw - ${(model.columns - 1) * model.gap}px)`
  return {
    left: `calc(${inline} * ${place.column / model.columns} + ${place.column * model.gap}px)`,
    top: `calc(${inline} * ${place.precedingRatio / model.columns} + ${place.precedingCount * model.gap}px)`,
    width: `calc(${inline} / ${model.columns})`,
    height: `calc(${inline} * ${place.ratio / model.columns})`,
  }
}

export function masonryExtentCss(model: MasonryModel): string {
  if (!model.placements.length) return "0px"
  const inline = `(100cqw - ${(model.columns - 1) * model.gap}px)`
  const endings = model.columnRatios.map((ratio, index) =>
    `calc(${inline} * ${ratio / model.columns} + ${Math.max(0, model.columnCounts[index] - 1) * model.gap}px)`)
  return `max(${endings.join(", ")})`
}

/** Return the indexes occupying a buffered viewport without mounting the full
 * Library. Visible cards are always prioritized ahead of warm preloads. */
export function locateMasonryWindow(
  model: MasonryModel, scrollTop: number, viewportHeight: number,
  overscan: number, maxCards: number,
): number[] {
  const viewBottom = scrollTop + Math.max(0, viewportHeight)
  const minY = scrollTop - Math.max(0, overscan)
  const maxY = viewBottom + Math.max(0, overscan)
  const candidates: { index: number; distance: number }[] = []
  for (let index = 0; index < model.placements.length; index += 1) {
    const { top, height } = model.placements[index]
    if (top + height < minY || top > maxY) continue
    candidates.push({ index, distance: top > viewBottom ? top - viewBottom
      : top + height < scrollTop ? scrollTop - top - height : 0 })
  }
  if (candidates.length > maxCards) {
    candidates.sort((a, b) => a.distance - b.distance || a.index - b.index)
    candidates.length = Math.max(1, maxCards)
  }
  return candidates.map(item => item.index).sort((a, b) => a - b)
}
