// Library sync controller (review 2-6 / task 320) — pure logic, everything
// injected.
//
// One controller instance owns the gallery's reconciliation baseline: the
// revision counter up to which every change is already merged into the loaded
// window. Any "the library changed" signal — an SSE push, a reconnect, the
// caller's own mutation settling, a freshly committed page — just schedules a
// sync. A sync fetches the journaled changes after the baseline, re-fetches
// the rows they touched under the current gallery request, merges them via
// gallery-reconcile, and only then advances the baseline. Anything that
// cannot be reconciled falls back to a full window reload; that is a normal
// path, not an error.

import {
  classifyChanges,
  reconcileGalleryList,
  viewerAfterReconcile,
  type ClassifyResult,
  type LibraryChange,
  type ReconcileResult,
} from "./gallery-reconcile"

const EMPTY_CLASSIFY: ClassifyResult = {
  affectedAssetIds: [],
  derivativeOnlyIds: [],
  droppedDerivativeIds: [],
  affectedStackIds: [],
  goneAssetIds: [],
  groupRenames: new Map(),
  deletedGroups: [],
  dissolvedStacks: [],
  needsNavigation: false,
  fullRefreshReason: null,
}
import type { MosaAsset, MosaGalleryRows, MosaGalleryRowsQuery, MosaLibraryChangesEnvelope } from "./mosa-api"

/** One gallery view's live snapshot, read at request and again at commit time
 * so a result computed for an older view never lands. */
export type LibrarySyncView = {
  viewKey: string
  generation: number
  nextCursor: string | null
  project: string
  cards: MosaAsset[]
  loadedCardIds: string[]
  query: MosaGalleryRowsQuery
  viewedId: string
  /** The fullscreen viewer is open. Pinning a card that left the view is a
   * viewer-only behavior: the inspector's plain selection must NOT pin —
   * removing a selected member from the stack has to drop its card. */
  viewerOpen: boolean
}

export type LibrarySyncViewerAction =
  | { action: "stay" }
  | { action: "move"; id: string }
  | { action: "close" }

export type LibrarySyncCommit = {
  cards: MosaAsset[]
  removedIds: string[]
  replacedStackCards: Record<string, string>
  /** The view total as of this merge; undefined when no rows were fetched. */
  pageTotal: number | null | undefined
  /** The viewed stack's live summary; undefined when no rows were fetched. */
  stack: MosaGalleryRows["stack"] | undefined
  classify: ClassifyResult
  revision: number
  viewer: LibrarySyncViewerAction
  /** The inspected card was among the touched ids: re-fetch its detail. */
  inspectorRefreshNeeded: boolean
}

export type LibrarySyncFallbackReason =
  | "incomplete"
  | "unknown-kind"
  | "library-backfilled"
  | "library-changed-detail"
  | "too-many-ids"
  | "rows-failed"
  | "data-version-only"

export type LibrarySyncStats = Record<string, number | string>

export interface LibrarySyncHooks {
  onCommit(commit: LibrarySyncCommit): void
  /** `changes` carries the batch the fallback dropped, when one was read:
   * the full reload it triggers can only re-fetch the CURRENT view, so
   * view-exit evidence that only exists in that batch (a viewed group
   * renamed away) must be applied by the caller before the reload. */
  onFallback(reason: LibrarySyncFallbackReason, changes?: readonly LibraryChange[]): void
}

export interface LibrarySyncDeps {
  hooks: () => LibrarySyncHooks
  fetchRevision(project: string): Promise<string>
  fetchChanges(project: string, since: number): Promise<MosaLibraryChangesEnvelope>
  fetchRows(query: MosaGalleryRowsQuery, assetIds: string[], boundaryCursor: string | null, stackIds: string[]): Promise<MosaGalleryRows>
  readMutationState(): { epoch: number; pending: number }
  readView(): LibrarySyncView
  isPaused(): boolean
  /** Test seams. */
  settleIntervalMs?: number
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
  now?: () => number
}

export interface LibrarySyncController {
  /** Fetches the baseline when the view has none yet (first page of a fresh
   * view must be requested against a known revision). */
  ensureBaseline(project: string): Promise<number | null>
  /** A page arrived. `requestedAtBaseline` stands in for a null revision
   * (the server could not serve a stable snapshot). */
  notePageRevision(revision: string | null, requestedAtBaseline: number | null): void
  /** SSE library-changed / ready payload. Reuses the pushed changes when they
   * cover the baseline gap; otherwise the sync fetches /api/library-changes. */
  notePush(payload: {
    revision?: string | null
    fromRevision?: string | null
    complete?: boolean
    changes?: LibraryChange[]
  }): void
  schedule(): void
  /** The viewer closed: a pinned card must reconcile against the view it was
   * kept alive in (it leaves the list if it no longer matches). */
  releaseViewer(): void
  /** The view changed: drop the baseline, the pin and any buffered push. */
  reset(): void
  getBaseline(): number | null
  stats(): LibrarySyncStats
  dispose(): void
}

const MAX_FETCH_IDS = 2000
const DATA_VERSION_FALLBACK_THROTTLE_MS = 10_000
const DEFAULT_SETTLE_INTERVAL_MS = 250
const SETTLE_POLL_CAP = 120

/** Let React commit pending renders before reading the view snapshot: the
 * provider reads render-bound refs, and a sync triggered by a page commit
 * (notePageRevision runs inside the load's setState batch) would otherwise
 * snapshot the OUTGOING render — stale project and cards — and its commit
 * check could pass while comparing equally-stale values (caught by
 * project-switch e2e: the merge wiped the freshly loaded project window). */
const yieldToRender = () => new Promise<void>((resolveYield) => { setTimeout(resolveYield, 0) })

/** The snapshot-vs-current freshness gate, shared by the main path and the
 * viewer-close release path. Beyond the identity checks, the list CONTENT is
 * compared card OBJECT by card OBJECT: a page commit between snapshot and
 * check changes assetsRef without moving viewKey/generation/cursor, and a
 * detail merge (fetchAsset, a GET — not a mutation) swaps one card object for
 * a newer one in place. Merging over either would overwrite the fresh window
 * (320 补充 3/5). */
const snapshotIsStale = (view: LibrarySyncView, fresh: LibrarySyncView, mutationEpoch: number, freshEpoch: number): boolean => {
  if (fresh.viewKey !== view.viewKey) return true
  if (fresh.generation !== view.generation) return true
  if (fresh.nextCursor !== view.nextCursor) return true
  if (freshEpoch !== mutationEpoch) return true
  if (fresh.cards.length !== view.cards.length) return true
  for (let index = 0; index < view.cards.length; index += 1) {
    if (fresh.cards[index] !== view.cards[index]) return true
  }
  return false
}


function parseRevisionCounter(token: unknown): number | null {
  const value = Number.parseInt(String(token ?? "").split(":")[0] ?? "", 10)
  return Number.isFinite(value) && value >= 0 ? value : null
}

function parseRevisionDataVersion(token: unknown): string | null {
  const segments = String(token ?? "").split(":")
  return segments.length > 1 && segments[1] ? segments[1] : null
}

export function createLibrarySync(deps: LibrarySyncDeps): LibrarySyncController {
  const setTimeoutImpl = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimeoutImpl = deps.clearTimeoutImpl ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const now = deps.now ?? (() => Date.now())
  const settleIntervalMs = deps.settleIntervalMs ?? DEFAULT_SETTLE_INTERVAL_MS

  let baseline: number | null = null
  let running = false
  let pendingRerun = false
  let pendingAfterPause = false
  let rowsFailures = 0
  let lastDataVersion: string | null = null
  let lastDataVersionFallbackAt = -Infinity
  let settleTimer: unknown = null
  let settlePolls = 0
  // The latest usable SSE delta: consumed by the next sync instead of a
  // library-changes request (only when its fromRevision ≤ baseline).
  let pushBuffer: { counter: number; fromCounter: number; changes: LibraryChange[] } | null = null
  // The card the open viewer keeps alive although the view dropped it.
  const pinned = new Set<string>()
  // Ids waiting for their post-viewer-close re-reconciliation (the journal
  // delta for them is already merged; only their own rows need a re-check).
  let pendingRelease: string[] = []
  const stats: LibrarySyncStats = { syncs: 0 }
  let lastError = ""
  const noteBaseline = (value: number | null) => {
    baseline = value
  }

  const count = (key: string) => {
    stats[key] = (Number(stats[key]) || 0) + 1
  }

  const fallback = (reason: LibrarySyncFallbackReason, changes?: readonly LibraryChange[]) => {
    count(reason)
    pushBuffer = null
    rowsFailures = 0
    pinned.clear()
    // The full reload re-establishes the baseline from the fresh page.
    noteBaseline(null)
    deps.hooks().onFallback(reason, changes)
  }

  const waitForMutationsToSettle = () => {
    if (settleTimer != null) return
    const tick = () => {
      settleTimer = null
      if (deps.readMutationState().pending > 0) {
        settlePolls += 1
        if (settlePolls > SETTLE_POLL_CAP) {
          settlePolls = 0
          schedule()
          return
        }
        settleTimer = setTimeoutImpl(tick, settleIntervalMs)
        return
      }
      settlePolls = 0
      schedule()
    }
    settleTimer = setTimeoutImpl(tick, settleIntervalMs)
  }

  const run = async () => {
    if (running) {
      pendingRerun = true
      return
    }
    if (deps.isPaused()) {
      pendingAfterPause = true
      return
    }
    if (baseline == null) return
    running = true
    try {
      await yieldToRender()
      for (;;) {
        pendingRerun = false
        let view = deps.readView()
        let mutation = deps.readMutationState()
        if (mutation.pending > 0) {
          waitForMutationsToSettle()
          break
        }
        // Viewer-close release: re-run the kept card(s) through a rows fetch
        // even though their journal delta is already merged — the view's
        // verdict on them is the rows response, not the journal.
        if (pendingRelease.length && baseline != null) {
          const releaseIds = pendingRelease
          pendingRelease = []
          count("viewer-releases")
          try {
            const releaseRows = await deps.fetchRows(view.query, releaseIds, view.nextCursor, [])
            await yieldToRender()
            const freshNow = deps.readView()
            const freshMutationNow = deps.readMutationState()
            // 320 补充 3：作废或出错时把编号放回 pendingRelease，下一次同步
            // （第 4 条保证会有）再查；与主路径共用同一套新鲜度判断。
            if (snapshotIsStale(view, freshNow, mutation.epoch, freshMutationNow.epoch)) {
              pendingRelease = [...pendingRelease, ...releaseIds]
              count("release-discards")
              // 320 补充 4：release 的作废同样要重跑——被 release 核对的卡还
              // 挂在 pendingRelease 里，下一次同步会再查。
              pendingRerun = true
              break
            }
            if (freshMutationNow.pending === 0) {
              const merged = reconcileGalleryList(view.cards, releaseRows, {
                requestedIds: releaseIds,
                affectedStackIds: [],
                sort: view.query.sort,
                stackView: Boolean(view.query.stackId),
              })
              const nextReleaseIds = merged.cards.map(card => card.id)
              const releaseViewer = viewerAfterReconcile({
                previousIds: view.cards.map(card => card.id),
                nextIds: nextReleaseIds,
                viewedId: view.viewedId,
                goneIds: [],
                pinned: [],
              })
              deps.hooks().onCommit({
                cards: merged.cards,
                removedIds: merged.removedIds,
                replacedStackCards: merged.replacedStackCards,
                pageTotal: releaseRows.total,
                stack: releaseRows.stack,
                classify: EMPTY_CLASSIFY,
                revision: baseline,
                viewer: releaseViewer.action === "stay" && releaseViewer.pin ? { action: "stay" } : releaseViewer,
                inspectorRefreshNeeded: false,
              })
            } else {
              // 修改请求还没返回：这轮不查，放回等下一轮。
              pendingRelease = [...pendingRelease, ...releaseIds]
            }
          } catch {
            count("rows-request-errors")
            pendingRelease = [...pendingRelease, ...releaseIds]
          }
          // 320 返工 1 (A)：release 结束后不要 break，同一轮继续走下面的变更路径。
          // 更新 view 与 mutation，保证随后的变更合并与作废判断基于 release 后的最新快照。
          view = deps.readView()
          mutation = deps.readMutationState()
          if (mutation.pending > 0) {
            waitForMutationsToSettle()
            break
          }
        }
        // Changes from the push when the push covers the gap, else the API.
        let envelope: MosaLibraryChangesEnvelope
        if (pushBuffer && pushBuffer.fromCounter <= baseline) {
          count("push-deltas")
          const fromBaseline = baseline
          envelope = {
            sinceRevision: fromBaseline,
            currentRevision: pushBuffer.counter,
            oldestRevision: null,
            complete: true,
            changes: pushBuffer.changes.filter(change => change.revision > fromBaseline),
          }
          pushBuffer = null
        } else {
          count("change-requests")
          pushBuffer = null
          try {
            envelope = await deps.fetchChanges(view.project, baseline)
          } catch {
            // The connection itself is unhappy; a full reload would fail the
            // same way. Wait for the next trigger (push, reconnect, mutation).
            count("change-request-errors")
            break
          }
        }
        if (!envelope.complete) {
          fallback("incomplete", envelope.changes)
          break
        }
        if (envelope.currentRevision <= baseline) {
          count("no-new-changes")
          break
        }

        const classify = classifyChanges(envelope.changes, { loadedCardIds: view.loadedCardIds })
        if (classify.fullRefreshReason) {
          fallback(
            classify.fullRefreshReason === "library-backfilled" ? "library-backfilled"
              : classify.fullRefreshReason === "library-changed-detail" ? "library-changed-detail"
                : "unknown-kind",
            envelope.changes,
          )
          break
        }
        const dropped = new Set(classify.droppedDerivativeIds)
        const fetchIds = classify.affectedAssetIds.filter(id => !dropped.has(id))
        if (fetchIds.length > MAX_FETCH_IDS) {
          fallback("too-many-ids", envelope.changes)
          break
        }

        let rows: MosaGalleryRows | null = null
        // Affected stacks ride along: a cover swap changes the node's identity
        // without the new cover id appearing in any journaled assetIds list.
        const affectedStacks = classify.affectedStackIds.filter(stackId => stackId !== view.query.stackId)
        if (fetchIds.length || affectedStacks.length) {
          try {
            rows = await deps.fetchRows(view.query, fetchIds, view.nextCursor, affectedStacks)
          } catch {
            count("rows-request-errors")
            rowsFailures += 1
            if (rowsFailures >= 2) {
              fallback("rows-failed", envelope.changes)
            } else {
              schedule()
            }
            break
          }
          rowsFailures = 0
        }

        // Let any render triggered while the requests were in flight commit,
        // so the freshness check compares against the LATEST view, not an
        // equally-stale snapshot.
        await yieldToRender()
        // The gallery moved under the in-flight request (view switch, window
        // reload, pagination, the user's own mutation): discard everything —
        // baseline stays, whichever mover ran will schedule its own sync.
        const fresh = deps.readView()
        const freshMutation = deps.readMutationState()
        // 320 补充 4：作废不是终点——触发作废的那次变更还在基线之后，而
        // 「动了画面的那一方」不一定会再排同步（无关 POST 也顶 epoch）。
        // 记一次重跑：视图已切换时 reset 过 baseline，重跑会直接返回。
        const stale = snapshotIsStale(view, fresh, mutation.epoch, freshMutation.epoch)
        if (stale) count("stale-discards")
        if (stale) {
          pendingRerun = true
          break
        }
        if (freshMutation.pending > 0) {
          waitForMutationsToSettle()
          break
        }

        const previousIds = view.cards.map(card => card.id)
        // Pins expire when the card really left the library; the viewer
        // decision below re-pins the viewed card if it merely left the view.
        const goneSet = new Set(classify.goneAssetIds)
        for (const id of [...pinned]) {
          if (goneSet.has(id)) pinned.delete(id)
        }
        const pinsBefore = new Set(pinned)
        // Pre-pin the viewed card for the merge itself: the pin decision runs
        // after the reconcile, but the merge is what would drop the card. A
        // stack node never pre-pins (a cover swap must replace it, and the
        // viewer follows through replacedStackCards); a gone card never does.
        const viewedCard = view.cards.find(card => card.id === view.viewedId)
        const prePins = new Set(pinsBefore)
        if (view.viewerOpen && view.viewedId && !goneSet.has(view.viewedId) && !viewedCard?.stack) {
          prePins.add(view.viewedId)
        }
        const reconcile = rows
          ? reconcileGalleryList(view.cards, rows, {
            requestedIds: fetchIds,
            affectedStackIds: classify.affectedStackIds,
            sort: view.query.sort,
            stackView: Boolean(view.query.stackId),
            pinnedIds: [...prePins],
          })
          : { cards: [...view.cards], removedIds: [] as string[], replacedStackCards: {} as Record<string, string> }
        const nextIds = reconcile.cards.map(card => card.id)
        // A pin expires once the card matches the view again (it has a fresh
        // row); a rowless pinned card stays until the viewer closes.
        const freshRowIds = new Set((rows?.rows ?? []).map(row => row.id))
        for (const id of [...pinned]) {
          if (freshRowIds.has(id)) pinned.delete(id)
        }
        const mappedViewedId = reconcile.replacedStackCards[view.viewedId] ?? view.viewedId
        const viewer = viewerAfterReconcile({
          previousIds,
          nextIds,
          viewedId: mappedViewedId,
          goneIds: classify.goneAssetIds,
          pinned: [...pinned],
        })
        // Only the card the viewer is on can be pinned, and only while it
        // lacks a fresh row — its presence in the list IS the pin.
        if (view.viewerOpen && viewer.action === "stay") {
          // The pre-pin kept the viewed card in the merge: carry it into the
          // persistent pin set so the viewer-close release re-checks it.
          if (viewer.pin || (prePins.has(mappedViewedId) && !freshRowIds.has(mappedViewedId))) {
            pinned.add(mappedViewedId)
          } else {
            pinned.delete(mappedViewedId)
          }
        } else {
          // Viewer closed (or the viewed card stepped): nothing stays pinned.
          pinned.clear()
        }
        for (const id of [...pinned]) {
          if (id !== mappedViewedId) pinned.delete(id)
        }

        deps.hooks().onCommit({
          cards: reconcile.cards,
          removedIds: reconcile.removedIds,
          replacedStackCards: reconcile.replacedStackCards,
          pageTotal: rows ? rows.total : undefined,
          stack: rows ? rows.stack : undefined,
          classify,
          revision: envelope.currentRevision,
          viewer,
          inspectorRefreshNeeded: fetchIds.includes(mappedViewedId)
            || classify.derivativeOnlyIds.includes(mappedViewedId),
        })
        noteBaseline(envelope.currentRevision)
        count("syncs")
        if (!pendingRerun) break
        count("reruns")
      }
    } catch (error) {
      // The controller must never die silently: an unexpected shape or a
      // caller hook bug surfaces in stats() (and therefore in e2e reads).
      lastError = error instanceof Error ? error.message : String(error)
      count("errors")
      running = false
      schedule()
      return
    } finally {
      running = false
      if (pendingRerun || pendingAfterPause) {
        pendingRerun = false
        pendingAfterPause = false
        schedule()
      }
    }
  }

  const schedule = () => {
    if (running) {
      pendingRerun = true
      return
    }
    if (deps.isPaused()) {
      pendingAfterPause = true
      return
    }
    if (baseline == null) return
    void run()
  }

  const noteToken = (token: unknown) => {
    const dataVersion = parseRevisionDataVersion(token)
    if (dataVersion == null) return
    lastDataVersion = dataVersion
  }

  return {
    async ensureBaseline(project) {
      if (baseline != null) return baseline
      try {
        const token = await deps.fetchRevision(project)
        const counter = parseRevisionCounter(token)
        noteToken(token)
        if (counter != null && baseline == null) noteBaseline(counter)
      } catch {
        // The first page's own revision provides the baseline instead.
      }
      return baseline
    },
    notePageRevision(revision, requestedAtBaseline) {
      noteToken(revision)
      const counter = parseRevisionCounter(revision)
      const candidate = counter == null ? requestedAtBaseline : counter
      if (candidate == null || !Number.isFinite(candidate)) return
      // Take the MINIMUM on purpose: replaying an already-merged change is
      // idempotent, skipping one is not.
      noteBaseline(baseline == null ? candidate : Math.min(baseline, candidate))
      schedule()
    },
    notePush(payload) {
      const counter = parseRevisionCounter(payload.revision)
      const dataVersion = parseRevisionDataVersion(payload.revision)
      const previousDataVersion = lastDataVersion
      noteToken(payload.revision)
      if (counter == null) return
      // Counter did not move but the file was written by another connection
      // that never journalled: only a full reload sees those rows. Throttled.
      if (baseline != null && counter <= baseline
        && dataVersion != null && previousDataVersion != null && dataVersion !== previousDataVersion
        && now() - lastDataVersionFallbackAt >= DATA_VERSION_FALLBACK_THROTTLE_MS) {
        lastDataVersionFallbackAt = now()
        fallback("data-version-only")
        return
      }
      if (payload.complete === true && Array.isArray(payload.changes) && payload.fromRevision != null) {
        const fromCounter = parseRevisionCounter(payload.fromRevision)
        if (fromCounter != null) pushBuffer = { counter, fromCounter, changes: payload.changes }
      }
    },
    schedule,
    releaseViewer() {
      if (!pinned.size) return
      pendingRelease = [...pinned]
      pinned.clear()
      schedule()
    },
    reset() {
      noteBaseline(null)
      pushBuffer = null
      rowsFailures = 0
      pendingRerun = false
      pendingAfterPause = false
      pinned.clear()
      if (settleTimer != null) {
        clearTimeoutImpl(settleTimer)
        settleTimer = null
        settlePolls = 0
      }
    },
    getBaseline() {
      return baseline
    },
    stats() {
      const snapshot: LibrarySyncStats = { ...stats }
      if (lastError) snapshot.lastError = lastError
      if (running) snapshot.inFlight = 1
      if (settleTimer != null) snapshot.settleWaiting = 1
      if (pendingAfterPause) snapshot.pendingAfterPause = 1
      if (pendingRerun) snapshot.pendingRerun = 1
      if (deps.isPaused()) snapshot.paused = 1
      return snapshot
    },
    dispose() {
      if (settleTimer != null) {
        clearTimeoutImpl(settleTimer)
        settleTimer = null
      }
    },
  }
}
