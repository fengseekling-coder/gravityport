// Gallery incremental reconciliation (review 2-6 / task 320) — pure logic.
//
// The server journals every library mutation into library_changes with a
// monotone revision counter. This module turns a batch of journaled changes
// into a minimal row re-fetch, and merges the re-fetched rows into an already
// loaded gallery window so the result equals what a full window reload would
// show — same cards, same order, same totals. No React, no DOM.

import { mergeGalleryRow, type MosaAsset, type MosaLibraryChange } from "./mosa-api"

/** One journaled library change (GET /api/library-changes rows, SSE payloads). */
export type LibraryChange = MosaLibraryChange

/** Every change kind the store writes (lib/sqlite-asset-store.mjs). The sync
 * controller falls back to a full refresh when it meets anything else, and a
 * unit test keeps this set equal to a fresh grep of the store, so a newly
 * added kind turns red here instead of silently re-syncing. */
export const KNOWN_CHANGE_KINDS: ReadonlySet<string> = new Set([
  "asset-added",
  "asset-updated",
  "assets-updated",
  "asset-deleted",
  "asset-restored",
  "asset-permanently-deleted",
  "asset-archived",
  "stack-created",
  "stack-updated",
  "stack-members-changed",
  "stack-cover-changed",
  "stack-order-changed",
  "stack-dissolved",
  "group-created",
  "group-renamed",
  "group-deleted",
  "group-updated",
  "groups-reordered",
  "generation-updated",
  "generation-relation-updated",
  "generation-relation-candidate-updated",
  "generation-relation-deleted",
  "library-changed",
  "library-backfilled",
])

/** Kinds that left the library for good (Trash, permanent delete, archive).
 * Only these move the open viewer off its card; an asset that merely left the
 * current view stays pinned until the viewer closes. */
const GONE_KINDS: ReadonlySet<string> = new Set([
  "asset-deleted",
  "asset-permanently-deleted",
  "asset-archived",
])

/** library-changed is the suppression-ledger announcement; its detail carries
 * exactly these counters. Anything else in the detail means the store grew a
 * new meaning for the kind and this client cannot interpret it. */
const LIBRARY_CHANGED_DETAIL_KEYS = new Set(["suppressionsCleared", "suppressionsRecorded"])

const GENERATION_KIND_PREFIX = "generation-"

export type ClassifyResult = {
  /** Every asset id the batch mentions (entity ids of asset records plus all
   * assetIds arrays). */
  affectedAssetIds: string[]
  /** Derivative-only ids worth re-fetching: only mentioned by
   * flags:["derivatives"] records AND present in the loaded window. Such a
   * change can only swap image URLs, never move cards. */
  derivativeOnlyIds: string[]
  /** Derivative-only ids dropped because their card is not loaded — no
   * request is spent on them. The controller subtracts them from
   * affectedAssetIds before fetching. */
  droppedDerivativeIds: string[]
  affectedStackIds: string[]
  goneAssetIds: string[]
  /** Group renames old name → new name (group-renamed detail.to). */
  groupRenames: Map<string, string>
  deletedGroups: string[]
  dissolvedStacks: string[]
  /** True unless the batch can only have touched derivative URLs (or nothing
   * the sidebar counts). */
  needsNavigation: boolean
  /** Non-null when the batch must not be reconciled incrementally. */
  fullRefreshReason: string | null
}

export function classifyChanges(
  changes: readonly LibraryChange[],
  { loadedCardIds }: { loadedCardIds?: readonly string[] } = {},
): ClassifyResult {
  const loaded = new Set(loadedCardIds ?? [])
  const affected = new Set<string>()
  const derivativeMentioned = new Set<string>()
  const ordinaryMentioned = new Set<string>()
  const affectedStackIds = new Set<string>()
  const gone = new Set<string>()
  const groupRenames = new Map<string, string>()
  const deletedGroups = new Set<string>()
  const dissolvedStacks = new Set<string>()
  let needsNavigation = false
  let fullRefreshReason: string | null = null

  for (const change of changes) {
    if (fullRefreshReason) break
    if (!KNOWN_CHANGE_KINDS.has(change.kind)) {
      fullRefreshReason = `unknown-kind:${change.kind}`
      break
    }
    if (change.kind === "library-backfilled") {
      fullRefreshReason = "library-backfilled"
      break
    }
    if (change.kind === "library-changed") {
      const detailKeys = Object.keys(change.detail || {})
      if (!detailKeys.every(key => LIBRARY_CHANGED_DETAIL_KEYS.has(key))) {
        fullRefreshReason = "library-changed-detail"
        break
      }
      needsNavigation = true
      continue
    }
    const isDerivativeBatch = change.kind === "assets-updated"
      && Array.isArray(change.flags) && change.flags.includes("derivatives")
    const recordIds = new Set<string>()
    if (change.entityType === "asset" && change.entityId) recordIds.add(change.entityId)
    for (const assetId of Array.isArray(change.assetIds) ? change.assetIds : []) {
      if (typeof assetId === "string" && assetId) recordIds.add(assetId)
    }
    if (isDerivativeBatch) {
      for (const id of recordIds) derivativeMentioned.add(id)
    } else {
      for (const id of recordIds) ordinaryMentioned.add(id)
      if (change.kind.startsWith(GENERATION_KIND_PREFIX)) continue
      // Anything beyond derivative churn and generation bookkeeping can move
      // the sidebar counts.
      needsNavigation = true
    }
    for (const id of recordIds) affected.add(id)
    if (change.entityType === "stack" && change.entityId) {
      affectedStackIds.add(change.entityId)
      if (change.kind === "stack-dissolved") dissolvedStacks.add(change.entityId)
    }
    if (GONE_KINDS.has(change.kind)) {
      for (const id of recordIds) gone.add(id)
    }
    if (change.kind === "group-renamed") {
      const to = typeof change.detail?.to === "string" ? change.detail.to : ""
      if (change.entityId && to) groupRenames.set(change.entityId, to)
    }
    if (change.kind === "group-deleted" && change.entityId) deletedGroups.add(change.entityId)
  }

  // A full-refresh batch skips the per-id bookkeeping entirely.
  if (fullRefreshReason) {
    return {
      affectedAssetIds: [], derivativeOnlyIds: [], droppedDerivativeIds: [],
      affectedStackIds: [], goneAssetIds: [], groupRenames: new Map(),
      deletedGroups: [], dissolvedStacks: [], needsNavigation: true, fullRefreshReason,
    }
  }

  const derivativeOnlyRaw = [...derivativeMentioned].filter(id => !ordinaryMentioned.has(id))
  const derivativeOnlyIds: string[] = []
  const droppedDerivativeIds: string[] = []
  for (const id of derivativeOnlyRaw) {
    if (loaded.has(id)) derivativeOnlyIds.push(id)
    else droppedDerivativeIds.push(id)
  }
  return {
    affectedAssetIds: [...affected],
    derivativeOnlyIds,
    droppedDerivativeIds,
    affectedStackIds: [...affectedStackIds],
    goneAssetIds: [...gone],
    groupRenames,
    deletedGroups: [...deletedGroups],
    dissolvedStacks: [...dissolvedStacks],
    needsNavigation,
    fullRefreshReason: null,
  }
}

/** One dead-stack verdict for both paths that can observe the stack (355):
 * the incremental commit's summary and a full reload's page summary. `null`
 * means the stack row is gone; count 0 means it survives with no live
 * members — a full reload gets a 200 empty page, not STACK_NOT_FOUND, so the
 * load-failure branch never fires and the verdict comes from here. `undefined`
 * is "no evidence this sync" (no rows were fetched) and stays alive. */
export function stackViewDead(stack: { count: number } | null | undefined): boolean {
  return stack === null || (stack != null && stack.count === 0)
}

/** The viewed group was renamed inside a batch the client is about to drop:
 * a full-refresh record (library-backfilled, unknown kind, …) aborts
 * classifyChanges before the rename bookkeeping, and the full reload the
 * fallback triggers can only re-fetch the CURRENT view — so the follow has
 * to be resolved from the dropped records before the reload. Resolves the
 * rename chain from `currentName` across `changes`; returns null when the
 * current group was not renamed, when the chain loops, or when the final
 * name was itself deleted in the same batch (the reload then falls back to
 * 所有素材 through the sidebar liveness check). Pure; unit-tested. */
export function followedGroupRename(
  changes: readonly LibraryChange[],
  currentName: string,
): string | null {
  if (!currentName) return null
  const renames = new Map<string, string>()
  const deleted = new Set<string>()
  for (const change of changes) {
    if (change.kind === "group-renamed") {
      const to = typeof change.detail?.to === "string" ? change.detail.to : ""
      if (change.entityId && to) renames.set(change.entityId, to)
    } else if (change.kind === "group-deleted" && change.entityId) {
      deleted.add(change.entityId)
    }
  }
  let target: string = currentName
  const seen = new Set<string>([target])
  while (renames.has(target)) {
    const next = renames.get(target) as string
    // A loop (including one that returns to the current name) cannot be
    // resolved from a same-batch rename table — decline the follow; the
    // reload's liveness check still lands somewhere safe.
    if (seen.has(next)) return null
    target = next
    seen.add(target)
  }
  if (target === currentName || deleted.has(target)) return null
  return target
}

// ─── ordering ────────────────────────────────────────────────────────────────

/** Unicode code point comparison — what SQLite's TEXT memcmp (UTF-8 byte
 * order) produces. JS's `<` compares UTF-16 units and misorders astral
 * characters (emoji) against U+E000..U+FFFF; localeCompare is worse still. */
export function compareCodePointStrings(a: string, b: string): number {
  if (a === b) return 0
  const shared = Math.min(a.length, b.length)
  let index = 0
  while (index < shared) {
    const ca = a.codePointAt(index) as number
    const cb = b.codePointAt(index) as number
    if (ca !== cb) return ca < cb ? -1 : 1
    index += ca > 0xffff ? 2 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

function nodeSortField(asset: MosaAsset, field: "createdAt" | "sortName"): string {
  const value = asset.node_sort?.[field]
  if (typeof value === "string") return value
  if (field === "createdAt") return String(asset.created_at || "")
  return ""
}

function searchScoreOf(asset: MosaAsset): number | null {
  const score = asset.node_sort?.searchScore
  return score == null || !Number.isFinite(Number(score)) ? null : Number(score)
}

/** Mirrors the server's gallery ORDER BY exactly (see
 * isGalleryRowAfterCursor / the collapsed page's orderBy):
 * search score DESC first, then the sort's key, id breaking ties. */
export function compareGalleryNodes(
  a: MosaAsset,
  b: MosaAsset,
  { sort, stackView }: { sort: string; stackView: boolean },
): number {
  if (stackView && sort === "manual") {
    const pa = Number.isFinite(Number(a.stack_position)) ? Number(a.stack_position) : Number.MAX_SAFE_INTEGER
    const pb = Number.isFinite(Number(b.stack_position)) ? Number(b.stack_position) : Number.MAX_SAFE_INTEGER
    if (pa !== pb) return pa - pb
    return compareCodePointStrings(a.id, b.id)
  }
  const scoreA = searchScoreOf(a)
  const scoreB = searchScoreOf(b)
  if (scoreA != null || scoreB != null) {
    // SQLite sorts NULL last in DESC; a missing score is that NULL.
    const va = scoreA ?? -Infinity
    const vb = scoreB ?? -Infinity
    if (va !== vb) return vb - va
  }
  if (sort === "name") {
    const byName = compareCodePointStrings(nodeSortField(a, "sortName"), nodeSortField(b, "sortName"))
    if (byName) return byName
    return compareCodePointStrings(a.id, b.id)
  }
  const byCreated = sort === "oldest"
    ? compareCodePointStrings(nodeSortField(a, "createdAt"), nodeSortField(b, "createdAt"))
    : compareCodePointStrings(nodeSortField(b, "createdAt"), nodeSortField(a, "createdAt"))
  if (byCreated) return byCreated
  return sort === "oldest"
    ? compareCodePointStrings(a.id, b.id)
    : compareCodePointStrings(b.id, a.id)
}

// ─── row merge ───────────────────────────────────────────────────────────────

export type GalleryRowsResponse = {
  rows: MosaAsset[]
  rowByAssetId: Record<string, string>
  afterCursorRowIds: string[]
  total: number | null
  stack: { id: string; name: string; count: number; cover_asset_id: string | null } | null
}

export type ReconcileOptions = {
  requestedIds: readonly string[]
  affectedStackIds: readonly string[]
  sort: string
  stackView: boolean
  /** The card the viewer keeps alive although the view no longer lists it.
   * Never removed by the merge; dropped again the moment it is gone from the
   * library or a fresh row replaces it. */
  pinnedIds?: readonly string[]
}

export type ReconcileResult = {
  cards: MosaAsset[]
  removedIds: string[]
  /** Same stack, different cover: old card id → new card id, so the open
   * viewer and the selection can follow the stack to its new card. */
  replacedStackCards: Record<string, string>
}

/** Merges a gallery-rows response into the loaded window. Cards outside
 * afterCursorRowIds land at their comparator position; unaffected cards keep
 * their relative order; the result never carries a duplicate id. */
export function reconcileGalleryList(
  cards: readonly MosaAsset[],
  response: GalleryRowsResponse,
  options: ReconcileOptions,
): ReconcileResult {
  const { requestedIds, affectedStackIds, sort, stackView } = options
  const pinned = new Set(options.pinnedIds ?? [])
  const oldById = new Map(cards.map(card => [card.id, card]))
  const removeIds = new Set<string>()
  for (const id of requestedIds) removeIds.add(id)
  for (const nodeId of Object.values(response.rowByAssetId || {})) removeIds.add(nodeId)
  const touchedStackIds = new Set(affectedStackIds)
  for (const row of response.rows) {
    if (row.stack?.id) touchedStackIds.add(row.stack.id)
  }
  for (const card of cards) {
    if (card.stack?.id && touchedStackIds.has(card.stack.id)) removeIds.add(card.id)
  }

  const afterCursor = new Set(response.afterCursorRowIds || [])
  const freshRows = (response.rows || []).filter(row => !afterCursor.has(row.id))
  const rowIds = new Set(freshRows.map(row => row.id))
  // A pinned card only survives removal when nothing fresh replaces it: a
  // fresh row re-merges through the insert path below (correct position), a
  // rowless one stays exactly where it was so the viewer's card keeps its
  // place in the list until the viewer closes.
  const kept = cards.filter(card => !removeIds.has(card.id) || (pinned.has(card.id) && !rowIds.has(card.id)))

  // Same stack, new cover: the old cover card is removed and the fresh row
  // takes its place — record the mapping for the viewer/selection follow.
  const replacedStackCards: Record<string, string> = {}
  for (const card of cards) {
    if (!card.stack?.id || !removeIds.has(card.id)) continue
    if (rowIds.has(card.id)) continue
    for (const row of freshRows) {
      if (row.stack?.id === card.stack.id && row.id !== card.id) {
        replacedStackCards[card.id] = row.id
        break
      }
    }
  }

  // Stable two-way merge: `kept` is already in server order, so each fresh
  // row binary-searches into place without disturbing unaffected cards. A row
  // whose card was kept (a pinned card that matches the view again) updates
  // in place instead of duplicating.
  const result: MosaAsset[] = [...kept]
  const resultIndexById = new Map(result.map((card, index) => [card.id, index]))
  for (const row of freshRows) {
    const merged = mergeGalleryRow(oldById.get(row.id), row)
    const existingIndex = resultIndexById.get(row.id)
    if (existingIndex != null) {
      result[existingIndex] = merged
      continue
    }
    let low = 0
    let high = result.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (compareGalleryNodes(result[mid], merged, { sort, stackView }) < 0) low = mid + 1
      else high = mid
    }
    result.splice(low, 0, merged)
    for (const [id, index] of resultIndexById) {
      if (index >= low) resultIndexById.set(id, index + 1)
    }
    resultIndexById.set(row.id, low)
  }

  const resultIds = new Set(result.map(card => card.id))
  const removedIds = cards.filter(card => !resultIds.has(card.id)).map(card => card.id)
  return { cards: result, removedIds, replacedStackCards }
}

// ─── viewer and focus ────────────────────────────────────────────────────────

export type ViewerAfterReconcileResult =
  | { action: "stay"; pin?: boolean }
  | { action: "move"; id: string }
  | { action: "close" }

/** What the open viewer does after a merge. `viewedId` must already be
 * followed through replacedStackCards by the caller. A card that merely left
 * the view stays (pinned) until the viewer closes; a deleted card steps to
 * the card now sitting at its old position — the viewer's next — or to the
 * previous card when it was the last one. */
export function viewerAfterReconcile({
  previousIds,
  nextIds,
  viewedId,
  goneIds,
  pinned,
}: {
  previousIds: readonly string[]
  nextIds: readonly string[]
  viewedId: string
  goneIds: readonly string[]
  pinned: readonly string[]
}): ViewerAfterReconcileResult {
  if (!viewedId) return { action: "close" }
  if (nextIds.includes(viewedId)) return { action: "stay" }
  if (pinned.includes(viewedId)) return { action: "stay" }
  const gone = new Set(goneIds)
  if (gone.has(viewedId)) {
    if (!nextIds.length) return { action: "close" }
    const originalIndex = previousIds.indexOf(viewedId)
    if (originalIndex < 0) return { action: "move", id: nextIds[0] }
    return { action: "move", id: nextIds[Math.min(originalIndex, nextIds.length - 1)] }
  }
  // Still in the library, no longer in this view: keep showing it.
  return { action: "stay", pin: true }
}

/** Where the gallery's implicit focus (the inspector's card) lands when its
 * card left the list. Follows the same index rule as the viewer; empty list
 * or unknown card clears the focus. */
export function focusAfterRemoval(
  previousIds: readonly string[],
  nextIds: readonly string[],
  focusedId: string,
): string {
  if (focusedId && nextIds.includes(focusedId)) return focusedId
  if (!nextIds.length) return ""
  const originalIndex = previousIds.indexOf(focusedId)
  if (originalIndex < 0) return ""
  return nextIds[Math.min(originalIndex, nextIds.length - 1)]
}
