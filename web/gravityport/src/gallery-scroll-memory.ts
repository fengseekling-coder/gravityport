/**
 * Per-view gallery scroll memory (task 152): returning to a view the user has
 * already visited this session restores where they left off. Records live in
 * memory only — never in the library, localStorage or settings — and each one
 * anchors on the card at the viewport's top edge rather than on scrollTop
 * alone, so a changed column count or freshly inserted rows still land the
 * same card at the same offset. All geometry is read straight from the
 * masonry model's placements; callers keep DOM concerns (padding conversion,
 * programmatic scrollTop writes) on their side.
 */

import type { MasonryModel } from "./gallery-window"

/** One view's leaving state. anchorId/anchorOffset carry the position,
 * scrollTop is the fallback when the anchor card is gone, loaded is the
 * loaded-window size to re-fetch before restoring, selected is the focused
 * card to re-inspect. */
export type GalleryScrollRecord = {
  anchorId: string
  /** anchor card top minus scrollTop; negative when the card straddles the top edge. */
  anchorOffset: number
  scrollTop: number
  loaded: number
  selected: string
}

export type GalleryScrollAnchor = { anchorId: string; anchorOffset: number }

/** `maxScrollTop`, when given, is the scroller's real limit (scrollHeight −
 * clientHeight): container padding makes it exceed the model's extent, and
 * clamping to the model then lands short of a position the user really held. */
function clampScrollTop(value: number, model: MasonryModel, viewportHeight: number, maxScrollTop?: number): number {
  const max = Number.isFinite(maxScrollTop)
    ? Math.max(0, maxScrollTop as number)
    : Math.max(0, model.totalHeight - Math.max(0, viewportHeight))
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, value))
}

/** The card sitting at the viewport's top edge — intersecting it, or the
 * closest one below — with the smallest top (smallest index on ties). Returns
 * null only for an empty model or a scrollTop past every card's bottom. */
export function pickScrollAnchor(model: MasonryModel, ids: string[], scrollTop: number): GalleryScrollAnchor | null {
  let best: GalleryScrollAnchor | null = null
  let bestTop = 0
  for (let index = 0; index < model.placements.length; index += 1) {
    const placement = model.placements[index]
    if (placement.top + placement.height <= scrollTop) continue
    // placements follow the input order, so strict "<" keeps the smaller
    // index on equal tops.
    if (best && placement.top >= bestTop) continue
    bestTop = placement.top
    best = { anchorId: ids[index] ?? "", anchorOffset: placement.top - scrollTop }
  }
  return best
}

/** Where to scroll a rebuilt view so the recorded anchor card sits at the
 * recorded offset again. Falls back to the recorded scrollTop when the anchor
 * card no longer exists, and clamps into the valid range. */
export function resolveRestoredScrollTop(
  model: MasonryModel, ids: string[], record: GalleryScrollRecord, viewportHeight: number, maxScrollTop?: number,
): number {
  const index = ids.indexOf(record.anchorId)
  const raw = index >= 0
    ? model.placements[index].top - record.anchorOffset
    : record.scrollTop
  return clampScrollTop(raw, model, viewportHeight, maxScrollTop)
}

/** Minimal scroll that fits card `index` fully into the viewport: no movement
 * when it is already fully visible, its bottom edge just inside the bottom
 * edge (plus margin) when it hangs below, its top edge just inside the top
 * edge (plus margin) when it sits above. A card taller than the viewport
 * aligns its top edge. */
export function revealCardScrollTop(
  model: MasonryModel, index: number, scrollTop: number, viewportHeight: number, margin = 8, maxScrollTop?: number,
): number {
  const placement = model.placements[index]
  if (!placement) return clampScrollTop(scrollTop, model, viewportHeight, maxScrollTop)
  const view = Math.max(0, viewportHeight)
  const top = placement.top
  const bottom = placement.top + placement.height
  if (top >= scrollTop && bottom <= scrollTop + view) return clampScrollTop(scrollTop, model, viewportHeight, maxScrollTop)
  const target = placement.height > view
    ? top - margin
    : bottom > scrollTop + view
      ? bottom + margin - view
      : top - margin
  return clampScrollTop(target, model, viewportHeight, maxScrollTop)
}

/** Snapshot of a view's live position: anchor card, fallback scrollTop,
 * loaded-window size and focused card. Null only when there is nothing to
 * anchor on (no cards laid out yet). */
export function buildScrollRecord(
  model: MasonryModel, ids: string[], scrollTop: number, loaded: number, selected: string,
): GalleryScrollRecord | null {
  const anchor = pickScrollAnchor(model, ids, scrollTop)
  if (!anchor) return null
  return { ...anchor, scrollTop, loaded, selected }
}

/** LRU table of per-view records, capped at `limit` entries. Reads and writes
 * both count as use; the entry not used longest is dropped when full. */
export class GalleryScrollMemory {
  private entries = new Map<string, GalleryScrollRecord>()

  constructor(private readonly limit = 30) {}

  /** The view's record, marking it most-recently-used. */
  get(viewKey: string): GalleryScrollRecord | null {
    const record = this.entries.get(viewKey)
    if (!record) return null
    this.entries.delete(viewKey)
    this.entries.set(viewKey, record)
    return record
  }

  /** Store (or replace) a view's record, marking it most-recently-used and
   * evicting the least-recently-used entry past the limit. */
  set(viewKey: string, record: GalleryScrollRecord): void {
    this.entries.delete(viewKey)
    this.entries.set(viewKey, record)
    while (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}

/** True when the same view's list changed other than by a page appended at
 * the end (trash, undo, stack edits, live arrivals): the caller then holds the
 * scroll position instead of letting the rebuilt layout move it. An identical
 * list (a same-view refresh) and pure appends (pagination) are not changes. */
export function listChangedInPlace(previousIds: readonly string[], ids: readonly string[]): boolean {
  if (ids.length < previousIds.length) return true
  for (let index = 0; index < previousIds.length; index += 1) {
    if (previousIds[index] !== ids[index]) return true
  }
  return false
}
