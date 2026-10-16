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
 * scrolling and incremental page hydration. With `spanWide`, landscape cards
 * occupy 2–3 adjacent columns (wanted by `masonrySpanFor`), narrowing one
 * span level at a time to the widest span whose placement window is level
 * within `SPAN_LEVEL_TOLERANCE` and whose crest stays within
 * `SPAN_RISE_TOLERANCE` of the shortest column's bottom, and everything
 * else still occupies one. */
export type MasonryPlacement = {
  left: number
  top: number
  width: number
  height: number
  /** First column the card occupies. */
  column: number
  /** Columns the card spans (1 for the plain shortest-column flow). */
  span: number
  /** Position as multiples of the column-width unit U (see masonryCardCss):
   * top = U·topUnits + topGaps·gap, height = U·heightUnits + heightGaps·gap.
   * For single-column cards topUnits/topGaps are the accumulated ratios and
   * card count above this item in its column. */
  topUnits: number
  topGaps: number
  heightUnits: number
  heightGaps: number
  ratio: number
}

export type MasonryModel = {
  placements: MasonryPlacement[]
  totalHeight: number
  columns: number
  columnWidth: number
  gap: number
  spanWide: boolean
  /** Per-column bottom edge in the same coefficients: bottom[c] =
   * U·bottomUnits[c] + bottomGaps[c]·gap (trailing inter-card gap included). */
  bottomUnits: number[]
  bottomGaps: number[]
}

/** How many columns a card spans given its height/width ratio: aspect ratio
 * (width/height) ≥ 2.6 → 3 columns, ≥ 1.6 → 2, otherwise 1 — never more
 * than `columns`; non-finite or non-positive ratios stay single-column. */
export function masonrySpanFor(heightRatio: number, columns: number): number {
  const safeColumns = Math.max(1, Math.floor(columns))
  const ratio = Number.isFinite(heightRatio) && heightRatio > 0 ? heightRatio : 1
  const wideRatio = 1 / 2.6
  const tallRatio = 1 / 1.6
  let span = 1
  if (ratio <= wideRatio) span = 3
  else if (ratio <= tallRatio) span = 2
  return Math.min(span, safeColumns)
}

/** Largest share of the column width a spanned card may leave as new void —
 * the sum of crest-minus-bottom over its covered columns — while keeping its
 * span; more uneven windows make the card step its span down instead. */
export const SPAN_LEVEL_TOLERANCE = 0.12

/** Largest share of the column width a spanned card's placement window may
 * rise above the shortest column's bottom (window crest minus the global
 * minimum bottom) while keeping its span; a card parked higher strands the
 * shortest columns — nothing later backfills them — so the card steps its
 * span down instead and a smaller span fills them in. */
export const SPAN_RISE_TOLERANCE = 0.5

export function buildMasonryModel(
  heightRatios: number[], columns: number, columnWidth: number, gap: number,
  options?: { spanWide?: boolean },
): MasonryModel {
  const count = Math.max(1, Math.floor(columns))
  const safeWidth = Math.max(1, columnWidth)
  const safeGap = Math.max(0, gap)
  const spanWide = options?.spanWide === true
  const bottoms = Array<number>(count).fill(0)
  const bottomUnits = Array<number>(count).fill(0)
  const bottomGaps = Array<number>(count).fill(0)
  const placements: MasonryPlacement[] = []
  for (const ratio of heightRatios) {
    const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
    let span = spanWide ? masonrySpanFor(safeRatio, count) : 1
    let column = 0
    let crest = 0
    let crestColumn = 0
    // A spanned card always rests on its window's crest, so placing it on an
    // uneven window leaves a permanent void under each shorter covered column
    // (later cards never backfill). A window qualifies only when that void —
    // the sum of crest-minus-bottom over the covered columns — stays within
    // SPAN_LEVEL_TOLERANCE × columnWidth, and when the crest itself stays
    // within SPAN_RISE_TOLERANCE × columnWidth of the shortest column's
    // bottom — a card parked higher starves that column for good. Otherwise
    // the card steps its span down one column at a time. Span 1 always
    // qualifies (void is 0), so a fully narrowed card falls through to the
    // plain shortest-column scan.
    let levelled = false
    if (spanWide && span > 1) {
      const tolerance = SPAN_LEVEL_TOLERANCE * safeWidth
      const riseLimit = SPAN_RISE_TOLERANCE * safeWidth
      for (; span > 1; span -= 1) {
        let placed = false
        const shortest = Math.min(...bottoms)
        for (let start = 0; start + span <= count; start += 1) {
          let windowCrest = bottoms[start]
          let windowCrestColumn = start
          for (let covered = start + 1; covered < start + span; covered += 1) {
            if (bottoms[covered] > windowCrest) { windowCrest = bottoms[covered]; windowCrestColumn = covered }
          }
          let waste = 0
          for (let covered = start; covered < start + span; covered += 1) {
            waste += windowCrest - bottoms[covered]
          }
          if (waste > tolerance) continue
          if (windowCrest - shortest > riseLimit) continue
          if (!placed || windowCrest < crest) { column = start; crest = windowCrest; crestColumn = windowCrestColumn }
          placed = true
        }
        if (placed) { levelled = true; break }
      }
    }
    if (!levelled) {
      // Leftmost start column whose whole span-window has the lowest crest.
      // For span 1 this is the plain shortest-column scan; comparing the real
      // window maximum keeps spanned cards from covering a taller neighbour.
      // The window starting at column 0 is measured the same way — its crest is
      // its tallest column, not column 0 — and the CSS top coefficients come from
      // the column that sets the crest.
      for (let start = 0; start + span <= count; start += 1) {
        let windowCrest = bottoms[start]
        let windowCrestColumn = start
        for (let covered = start + 1; covered < start + span; covered += 1) {
          if (bottoms[covered] > windowCrest) { windowCrest = bottoms[covered]; windowCrestColumn = covered }
        }
        if (start === 0 || windowCrest < crest) { column = start; crest = windowCrest; crestColumn = windowCrestColumn }
      }
    }
    const width = span * safeWidth + (span - 1) * safeGap
    const height = width * safeRatio
    const heightUnits = safeRatio * span
    const heightGaps = safeRatio * (span - 1)
    placements.push({ left: column * (safeWidth + safeGap), top: crest,
      width, height, column, span, topUnits: bottomUnits[crestColumn],
      topGaps: bottomGaps[crestColumn], heightUnits, heightGaps, ratio: safeRatio })
    const restedUnits = bottomUnits[crestColumn] + heightUnits
    const restedGaps = bottomGaps[crestColumn] + heightGaps + 1
    for (let covered = column; covered < column + span; covered += 1) {
      bottoms[covered] = crest + (height + safeGap)
      bottomUnits[covered] = restedUnits
      bottomGaps[covered] = restedGaps
    }
  }
  return {
    placements, columns: count, columnWidth: safeWidth, gap: safeGap, spanWide,
    totalHeight: placements.length ? Math.max(...bottoms) - safeGap : 0,
    bottomUnits, bottomGaps,
  }
}

/** CSS container units keep already-mounted cards geometrically correct in
 * background Electron windows where ResizeObserver/React may be throttled.
 * CSS handles width changes instantly; JS only reassigns columns. Every
 * offset is U·coefficients + gap counts with U = the column-width unit
 * (100cqw − (columns−1)·gap) / columns, so spanned and single-column cards
 * share one coordinate system. */
export function masonryCardCss(model: MasonryModel, index: number) {
  const place = model.placements[index]
  const unit = `(100cqw - ${(model.columns - 1) * model.gap}px) / ${model.columns}`
  return {
    left: `calc(${unit} * ${place.column} + ${place.column * model.gap}px)`,
    top: `calc(${unit} * ${place.topUnits} + ${place.topGaps * model.gap}px)`,
    width: `calc(${unit} * ${place.span} + ${(place.span - 1) * model.gap}px)`,
    height: `calc(${unit} * ${place.heightUnits} + ${place.heightGaps * model.gap}px)`,
  }
}

export function masonryExtentCss(model: MasonryModel): string {
  if (!model.placements.length) return "0px"
  const unit = `(100cqw - ${(model.columns - 1) * model.gap}px) / ${model.columns}`
  const endings = model.bottomUnits.map((units, index) =>
    `calc(${unit} * ${units} + ${Math.max(0, model.bottomGaps[index] - 1) * model.gap}px)`)
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

/** <img sizes> hint for a card: ask for 1.5× the rendered card width so on
 * 2× displays the browser steps up to the next thumbnail tier instead of
 * showing the smallest one. Degenerate widths fall back to the 240px tier. */
export function galleryImageSizes(cardWidthPx: number): string {
  if (!Number.isFinite(cardWidthPx) || cardWidthPx <= 0) return "240px"
  return `${Math.max(1, Math.round(cardWidthPx * 1.5))}px`
}
