import { useEffect, useLayoutEffect, useRef, useState } from "react"
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import ColumnControl from "./ColumnControl"
import ImageViewer from "./ImageViewer"
import { translate, type Language } from "./i18n"
import { desktopAPI } from "./desktop"
import { focusSelection, logicalSelection, pruneSelection, replaceSelection, toggleModifierSelection } from "./selection"
import { promptEditorActive, resolvePromptSaveTarget, type PromptEditTarget } from "./prompt-edit"
import { isEditableTarget } from "./keyboard"
import {
  buildGalleryRowModel, galleryModelSignature, gallerySpacerHeights, locateGalleryWindow,
  type GalleryRowModel, type GalleryRowRange,
} from "./gallery-window"
import {
  fetchAssetPage, fetchAsset, fetchNavigation, fetchLibraryLocation, fetchHealth, fetchVisualStatus,
  fetchProjects, fetchAssetVersions, fetchAssetGenerationHistory, setAssetsFavorite,
  toggleAssetFavorite, updateAssetMetadata, moveAssetsToTrash, restoreAsset, setAssetsGroup,
  createGroup, moveAssetsToStack, stageImportFile, importAssetsBatch, openLibraryFolder,
  mosaMutationHeaders, mergeAssetDetail, type MosaAsset, type MosaNavigation, type MosaLibraryLocation,
  type MosaVisualStatus, type AssetQuery, type MosaVersionRow, type MosaGenerationEvent,
} from "./mosa-api"

type Scope = "all" | "favorite" | "unorganized" | "trash"

// 任务 127：macOS 桌面端原生红黄绿按钮落在窗口左上 (trafficLightPosition 16,18)，
// 品牌栏需要为它们预留安全区。仅在 Electron 桌面 + macOS 时成立；浏览器与
// Windows（保留原生标题栏）都不需要。
const MAC_DESKTOP = typeof navigator !== "undefined"
  && Boolean(desktopAPI())
  && /^Mac/.test(navigator.platform || "")

function loadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem("gravityport.preferences") || "{}")
    return {
      appearance: ["跟随系统", "浅色", "深色"].includes(value.appearance) ? value.appearance : "跟随系统",
      cardInfo: value.cardInfo === true,
      language: value.language === "en" ? "en" as const : "zh" as const,
      skipTrashConfirm: localStorage.getItem("gravityport.skip-trash-confirm") === "1",
    }
  } catch {
    return { appearance: "跟随系统", cardInfo: false, language: "zh" as const, skipTrashConfirm: false }
  }
}

function humanSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—"
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function ratioText(width: number, height: number): string {
  if (!width || !height || width <= 1 || height <= 1) return "—"
  const trim = (value: string) => value.replace(/\.?0+$/, "")
  // Design convention normalizes the shorter side to 1: "1:1.52" portrait,
  // "1.56:1" landscape.
  return width >= height ? `${trim((width / height).toFixed(2))}:1` : `1:${trim((height / width).toFixed(2))}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function smartGroupLabel(name: string): string {
  return name.replace(/^web-/, "").replace(/-generated$/, "")
}

const GALLERY_PAGE_SIZE = 100
// Virtualization thresholds mirror the gallery QA budgets: below this many
// loaded assets every card mounts; above it only the viewport window stays in
// the DOM (real cards in the hydrate zone, same-geometry placeholders in the
// warm zone) and top/bottom spacers preserve the scroll extent.
const GALLERY_MOUNT_ALL_THRESHOLD = 320
const GALLERY_WINDOW_WARMUP_PX = 1200
const GALLERY_HYDRATE_WARMUP_PX = 400
const GALLERY_MAX_MOUNTED_CARDS = 380
const GALLERY_MAX_HYDRATED_CARDS = 320

type NavSnapshot = {
  active: string
  stackId: string
  stackName: string
  query: string
  sortOrder: string
  assetType: string
}

export default function App() {
  const [assets, setAssets] = useState<MosaAsset[]>([])
  const [navigation, setNavigation] = useState<MosaNavigation | null>(null)
  const [library, setLibrary] = useState<MosaLibraryLocation | null>(null)
  const [health, setHealth] = useState<{ productVersion: string; gitSha: string; distribution: string } | null>(null)
  const [visual, setVisual] = useState<MosaVisualStatus | null>(null)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pageTotal, setPageTotal] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [project, setProject] = useState("default")
  const [projects, setProjects] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [navHistory, setNavHistory] = useState<{ stack: NavSnapshot[]; index: number }>(() => ({
    stack: [{ active: "所有素材", stackId: "", stackName: "", query: "", sortOrder: "newest", assetType: "all" }],
    index: 0,
  }))
  const [assetType, setAssetType] = useState("all")
  const [sortOrder, setSortOrder] = useState("newest")
  const [active, setActive] = useState("所有素材")
  const [stackId, setStackId] = useState("")
  const [stackName, setStackName] = useState("")
  const [selected, setSelected] = useState("")
  const [settings, setSettings] = useState(false)
  const [settingTab, setSettingTab] = useState("常规与外观")
  const [preferences] = useState(loadPreferences)
  const [appearance, setAppearance] = useState<string>(preferences.appearance)
  const [cardInfo, setCardInfo] = useState(preferences.cardInfo)
  const [language, setLanguage] = useState<Language>(preferences.language)
  const tr = (text: string) => translate(text, language)
  const [savedLocally, setSavedLocally] = useState(true)
  useEffect(() => {
    try {
      localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance, cardInfo, language }))
      setSavedLocally(true)
    } catch { setSavedLocally(false) }
    document.documentElement.lang = language === "en" ? "en" : "zh-CN"
  }, [appearance, cardInfo, language])
  // The desktop shell rebuilds its menu and notification language from this.
  useEffect(() => {
    desktopAPI()?.setLocale?.(language === "en" ? "en" : "zh")
  }, [language])
  const [detail, setDetail] = useState(true)
  const [expandedPrompt, setExpandedPrompt] = useState(false)
  const [expandedIntro, setExpandedIntro] = useState(false)
  const [expandedTags, setExpandedTags] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [tagError, setTagError] = useState("")
  const [expandedRelated, setExpandedRelated] = useState(false)
  const [preview, setPreview] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [columns, setColumns] = useState(5)
  const [toast, setToast] = useState("")
  const [expandedSections, setExpandedSections] = useState([true, true])
  const [skipConfirm, setSkipConfirm] = useState(preferences.skipTrashConfirm)
  // 「不再提醒」persists across sessions like the preference it is.
  useEffect(() => {
    try { localStorage.setItem("gravityport.skip-trash-confirm", skipConfirm ? "1" : "0") } catch { /* session-only */ }
  }, [skipConfirm])
  const [versions, setVersions] = useState<MosaVersionRow[] | null>(null)
  const [generations, setGenerations] = useState<MosaGenerationEvent[] | null>(null)
  // The prompt draft is bound to one concrete asset; it never outlives the
  // asset (or project) it was opened for.
  const [promptEdit, setPromptEdit] = useState<PromptEditTarget & { draft: string } | null>(null)
  const [savingPromptId, setSavingPromptId] = useState<string | null>(null)
  // Gallery windowing: which rows stay mounted and which hydrate real cards.
  // The row model rides in the state so a pure geometry change (window
  // resized, same row range) still re-renders the spacers with the new pixel
  // heights — range equality alone would leave the DOM at the old geometry.
  const [galleryWindow, setGalleryWindow] = useState<{
    model: GalleryRowModel; mount: GalleryRowRange; hydrate: GalleryRowRange;
  } | null>(null)
  const appRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const assetsRef = useRef<MosaAsset[]>([])
  const viewKeyRef = useRef("")
  // The view identity the current selection was made in (same key as the
  // load effect's viewKey); a mismatch resets the selection.
  const selectionViewKeyRef = useRef("")
  // One-shot inspection target ("show in library") that survives the
  // selection reset of the view change it causes.
  const pendingInspectRef = useRef("")
  const cutIdsRef = useRef<string[]>([])
  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    setExpandedPrompt(false)
    setExpandedIntro(false)
    setExpandedTags(false)
    setAddingTag(false)
    setTagDraft("")
    setTagError("")
    // A draft belongs to the asset it was opened for: selecting another asset
    // discards it instead of letting it drain into the new selection.
    setPromptEdit(null)
  }, [selected])
  // Search input is debounced so each keystroke does not hit the store; the
  // request sequence guard below still owns stale-response protection.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 180)
    return () => clearTimeout(timer)
  }, [query])
  const scope: Scope = active === "收藏" ? "favorite" : active === "待整理" ? "unorganized" : active === "回收站" ? "trash" : "all"
  const source = active.startsWith("source:") ? active.slice(7) : active === "Pinterest" ? "pinterest" : undefined
  const group = active.startsWith("group:") ? active.slice(6) : undefined
  const mediaKind = assetType === "image" ? "img" : assetType === "video" ? "video" : "all"
  const buildQuery = (cursor?: string): AssetQuery => ({
    project, q: debouncedQuery, scope, mediaKind, sort: sortOrder as AssetQuery["sort"],
    ...(source ? { source } : {}), ...(group ? { group } : {}), ...(stackId ? { stackId } : {}),
    ...(cursor ? { cursor } : {}),
  })
  const pendingViewerReloadRef = useRef(false)
  // Project-switch transaction: the last project whose gallery actually
  // loaded, plus the view snapshot to restore when a later switch fails.
  const lastGoodProjectRef = useRef(project)
  const projectRevertRef = useRef<(() => void) | null>(null)
  const projectRevertKeyRef = useRef("")
  // In-flight background work that a view change invalidates. The load
  // effect's cleanup aborts all of them, so a stale response can never land.
  const paginationAbortRef = useRef<AbortController | null>(null)
  const selectAllAbortRef = useRef<AbortController | null>(null)
  // Bumped on every committed gallery (re)load; pagination compares it so a
  // window that reloaded under an in-flight page discards that page.
  const loadGenerationRef = useRef(0)
  useEffect(() => {
    const controller = new AbortController()
    // The viewer is a modal surface: background churn (derivative completions
    // arriving over SSE) must not collapse its loaded window or move the
    // selection under the user. One refresh is queued for when it closes.
    if (preview) { pendingViewerReloadRef.current = true; controller.abort(); return }
    // A same-view refresh (SSE churn while previews render) must re-fetch the
    // WHOLE loaded window: collapsing back to the first page would throw away
    // the user's scrolled pages every time a preview lands.
    const viewKey = JSON.stringify([project, active, debouncedQuery, sortOrder, assetType, stackId])
    const windowRefresh = viewKeyRef.current === viewKey && assetsRef.current.length > GALLERY_PAGE_SIZE
    viewKeyRef.current = viewKey
    // Selection is bound to the view it was made in. A project, search,
    // filter, sort or stack change resets it here — before anything loads —
    // so Delete/favorite/group can never reach assets that the current view
    // no longer shows. Pagination and same-view refreshes keep the entries
    // that are still visible (pruned after the fetch below). A pending
    // explicit inspection ("show in library") survives the reset once.
    if (selectionViewKeyRef.current !== viewKey) {
      selectionViewKeyRef.current = viewKey
      const preserve = pendingInspectRef.current
      pendingInspectRef.current = ""
      applySelection([], preserve)
      anchorIndexRef.current = -1
    }
    setLoading(true)
    setLoadError("")
    const run = async () => {
      try {
        let page = await fetchAssetPage(buildQuery(), { signal: controller.signal })
        let collected = page.assets
        if (windowRefresh) {
          const target = Math.max(assetsRef.current.length, GALLERY_PAGE_SIZE)
          let cursor: string | undefined = page.nextCursor ?? undefined
          let guard = 0
          while (page.nextCursor && collected.length < target && guard < 30) {
            guard += 1
            page = await fetchAssetPage(buildQuery(cursor), { cursor, signal: controller.signal })
            const seen = new Set(collected.map(item => item.id))
            collected = [...collected, ...page.assets.filter(item => !seen.has(item.id))]
            if (!page.nextCursor) break
            cursor = page.nextCursor
          }
        }
        if (controller.signal.aborted) return
        // Cross-page selections outrun the loaded window, so only ids the
        // PREVIOUS window contained can be re-judged against the fresh one:
        // a member that left the view is dropped, off-page members are kept
        // (no information about them changed).
        const previousIds = new Set(assetsRef.current.map(item => item.id))
        setAssets(collected)
        setNextCursor(page.nextCursor)
        setPageTotal(page.total)
        loadGenerationRef.current += 1
        // Keep only the selection entries the fresh view still contains; the
        // inspector re-lands on a member of the surviving selection, or —
        // when the view change emptied it — on the view's first card, the
        // design's implicit single selection.
        const validIds = new Set(collected.map(item => item.id))
        const kept = selectionRef.current
        const pruned = pruneSelection(
          kept.selectedIds,
          kept.selected,
          id => validIds.has(id) || !previousIds.has(id),
        )
        if (pruned.changed || (!pruned.selectedIds.length && !pruned.selected)) {
          const fallback = pruned.selected
            || (pruned.selectedIds.length ? pruned.selectedIds[0] : collected[0]?.id)
            || ""
          applySelection(pruned.selectedIds, fallback)
        }
        lastGoodProjectRef.current = project
      } catch (error) {
        if (controller.signal.aborted) return
        // A failed load for a freshly switched-to project is a failed switch:
        // restore the last project that actually loaded, with its view state.
        if (project !== lastGoodProjectRef.current) {
          revertProjectSwitch()
          return
        }
        setLoadError(errorMessage(error))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void run()
    return () => {
      controller.abort()
      paginationAbortRef.current?.abort()
      // A background refresh (same view) must not cancel the user's explicit
      // selection work: the cross-page select-all and a history select carry
      // their own view/intent/revision guards, so they land safely or discard
      // themselves — aborting them here only dropped in-flight actions
      // whenever a derivative landed mid-click.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, active, debouncedQuery, sortOrder, assetType, stackId, refreshKey])
  useEffect(() => {
    if (preview || !pendingViewerReloadRef.current) return
    pendingViewerReloadRef.current = false
    refreshNavigation()
  }, [preview])
  const refreshNavigation = () => setRefreshKey(value => value + 1)
  const lastMetaProjectRef = useRef("")
  useEffect(() => {
    const controller = new AbortController()
    // Project-scoped metadata is dropped the moment the project changes —
    // before any request is issued. If a fetch then fails or is slow, the UI
    // shows empty counters and no library path, never the previous project's.
    if (lastMetaProjectRef.current !== project) {
      lastMetaProjectRef.current = project
      setNavigation(null)
      setLibrary(null)
      setVisual(null)
    }
    fetchProjects(controller.signal).then(list => {
      if (!controller.signal.aborted) setProjects(list)
    }).catch(() => {})
    fetchNavigation(project, controller.signal).then(data => {
      if (!controller.signal.aborted) setNavigation(data)
    }).catch(() => {})
    fetchLibraryLocation(project, controller.signal).then(data => {
      if (!controller.signal.aborted && data.path) setLibrary(data)
    }).catch(() => {})
    fetchHealth(controller.signal).then(data => {
      if (!controller.signal.aborted) setHealth(data)
    }).catch(() => {})
    fetchVisualStatus(project, controller.signal).then(data => {
      if (!controller.signal.aborted) setVisual(data)
    }).catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, refreshKey])
  // Live library updates: the runtime broadcasts journaled revisions over SSE;
  // bursts are debounced into one reload of the current view.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stream = new EventSource(`/api/library-events?project=${encodeURIComponent(project)}`)
    stream.addEventListener("library-changed", () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => refreshNavigation(), 300)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stream.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setSystemDark(media.matches)
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])
  useEffect(() => {
    if (!settings && !deleting) return
    const dialog = appRef.current?.querySelector<HTMLElement>(
      deleting ? '[role="alertdialog"]' : '[role="dialog"]',
    )
    const previous = document.activeElement as HTMLElement | null
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, select, [tabindex="0"]',
    ) || [])
    controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const list = controls()
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener("keydown", trap)
    return () => {
      document.removeEventListener("keydown", trap)
      previous?.focus()
    }
  }, [settings, deleting])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    fetchAsset(project, selected, controller.signal).then(full => {
      if (!controller.signal.aborted) setAssets(old => old.map(item => item.id === full.id ? mergeAssetDetail(item, full) : item))
    }).catch(() => {})
    setVersions(null)
    setGenerations(null)
    fetchAssetVersions(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setVersions(history && history.versions.length > 1 ? history.versions : null)
    }).catch(() => {})
    fetchAssetGenerationHistory(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setGenerations(history && history.events.length ? history.events : null)
    }).catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected])
  // History/round switching: an in-flight response is invalidated by a newer
  // history click, any explicit focus switch, a selection takeover, or a view
  // change — the guards below discard it, so a late response can neither
  // append its asset to, nor move the selection of, a view it no longer
  // belongs to. Background same-view refreshes leave it alone: an explicit
  // click must not be silently dropped by unrelated churn.
  const historySelectAbortRef = useRef<AbortController | null>(null)
  const historyIntentRef = useRef(0)
  const selectHistoryAsset = (id: string) => {
    if (!id) return
    // Invalidation runs on every history click, including a re-click of the
    // currently focused version: the latest intent is "stay here", so an
    // in-flight fetch for another version must never retake the focus (or
    // collapse the batch) afterwards.
    historyIntentRef.current += 1
    historySelectAbortRef.current?.abort()
    historySelectAbortRef.current = null
    if (id === selected) return
    const requestViewKey = viewKeyRef.current
    const requestIntent = historyIntentRef.current
    const requestRevision = selectionRevisionRef.current
    const controller = new AbortController()
    historySelectAbortRef.current = controller
    fetchAsset(project, id, controller.signal).then(full => {
      if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
        || historyIntentRef.current !== requestIntent
        || selectionRevisionRef.current !== requestRevision) return
      setAssets(old => old.some(item => item.id === full.id) ? old.map(item => item.id === full.id ? mergeAssetDetail(item, full) : item) : [...old, full])
      // The revision guard above pins the selection to the click-time one, so
      // focusSelection resolves against exactly the state the user acted on:
      // a version focused from a multi-selection collapses the batch onto it
      // instead of leaving hidden A/B members as batch targets.
      const committed = focusSelection(selectionRef.current.selectedIds, selectionRef.current.selected, id)
      applySelection(committed.selectedIds, committed.selected)
    }).catch(error => {
      if (!controller.signal.aborted) notify(errorMessage(error))
    })
  }
  // Keep two visual states honest while the model pack installs on desktop.
  useEffect(() => {
    const api = desktopAPI()
    if (!api?.onVisualPackProgress) return
    api.onVisualPackProgress(progress => {
      const percent = Number(progress?.percent)
      setModelProgress(Number.isFinite(percent) ? percent : null)
    })
  }, [])
  assetsRef.current = assets
  const asset = assets.find((a) => a.id === selected) || assets[0]
  const currentTags = asset ? asset.tags : []
  const visible = assets
  const notify = (text: string) => setToast(tr(text))
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 2600)
      return () => clearTimeout(timer)
    }
  }, [toast])
  // The in-flight lock lives in a ref: the render-state flag is stale inside
  // same-tick re-entrancy (scroll listener + IntersectionObserver firing
  // together), which used to send duplicate page requests with one cursor.
  const loadingMoreRef = useRef(false)
  const fetchNextPage = async (): Promise<MosaAsset[] | null> => {
    if (!nextCursor || loadingMoreRef.current || loading) return null
    // The request is pinned to the view it was issued for: a project, search,
    // filter or sort change (or a same-view window reload) aborts it outright
    // and the post-await checks discard anything that still slipped through,
    // so a late page can never merge into — or move the cursor of — a view it
    // no longer belongs to.
    const requestViewKey = viewKeyRef.current
    const requestGeneration = loadGenerationRef.current
    const requestCursor = nextCursor
    const controller = new AbortController()
    paginationAbortRef.current = controller
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const page = await fetchAssetPage(buildQuery(requestCursor), { cursor: requestCursor, signal: controller.signal })
      if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
        || loadGenerationRef.current !== requestGeneration) return null
      // Compute outside setState: the updater runs at render time, long after
      // the viewer needs the merged list to step across the boundary.
      const seen = new Set(assetsRef.current.map(item => item.id))
      const merged = [...assetsRef.current, ...page.assets.filter(item => !seen.has(item.id))]
      setAssets(merged)
      setNextCursor(page.nextCursor)
      return merged
    } catch (error) {
      if (!controller.signal.aborted) notify(errorMessage(error))
      return null
    }
    finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }
  const loadMore = () => { void fetchNextPage() }
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !nextCursor) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore()
    }, { rootMargin: "600px 0px" })
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore, loading])
  // The grid is its own scroll container; a scroll-position check makes
  // pagination deterministic even where IntersectionObserver timing is not.
  // The same handler re-derives the mounted gallery window.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || !nextCursor) return
    const onScroll = () => {
      updateGalleryWindowRef.current()
      if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 400) void loadMore()
    }
    grid.addEventListener("scroll", onScroll, { passive: true })
    onScroll()
    return () => grid.removeEventListener("scroll", onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore, loading])
  // ── gallery windowing ──
  // Above the mount-all threshold only rows near the viewport stay in the DOM:
  // real cards in the hydrate zone, same-geometry placeholders in the warm
  // zone, and top/bottom spacers keep the scroll extent exact.
  const windowingActive = assets.length > GALLERY_MOUNT_ALL_THRESHOLD
  const rowModelRef = useRef<{ key: string; model: GalleryRowModel } | null>(null)
  const updateGalleryWindowRef = useRef<() => void>(() => {})
  const galleryRowModel = (): GalleryRowModel | null => {
    const grid = gridRef.current
    if (!grid) return null
    const styles = getComputedStyle(grid)
    const tracks = styles.gridTemplateColumns.split(/\s+/).map(value => Number.parseFloat(value)).filter(Number.isFinite)
    const colWidth = tracks[0] || 0
    if (!(colWidth > 0)) return null
    const gap = Number.parseFloat(styles.rowGap) || 0
    const ratios = assets.map(a => a.height / a.width)
    const signature = galleryModelSignature(ratios, columns, colWidth)
    if (rowModelRef.current?.key === signature) return rowModelRef.current.model
    const model = buildGalleryRowModel(ratios, columns, colWidth, gap)
    rowModelRef.current = { key: signature, model }
    return model
  }
  const updateGalleryWindow = () => {
    const grid = gridRef.current
    if (!grid) return
    const model = galleryRowModel()
    if (!model) return
    // Below the mount-all threshold every row stays mounted; the model still
    // drives the render, so cards of a mixed-ratio row all get the row's
    // exact height instead of leaving holes under shorter media.
    if (!windowingActive || model.rowHeight.length === 0) {
      if (model.rowHeight.length === 0) {
        setGalleryWindow(old => old === null ? old : null)
        return
      }
      const full = { startRow: 0, endRow: model.rowHeight.length - 1 }
      setGalleryWindow(old => (
        old && old.model === model
          && old.mount.startRow === full.startRow && old.mount.endRow === full.endRow
          ? old : { model, mount: full, hydrate: full }
      ))
      return
    }
    // A content-shrinking change (narrower window, a smaller loaded window)
    // leaves the browser's scrollTop beyond the new content end until the
    // spacers shrink — deriving there finds no rows and would leave a dead
    // window of placeholders. Derive for the clamped position the browser is
    // about to land on instead.
    const maxScroll = Math.max(0, model.totalHeight - grid.clientHeight)
    const scrollTop = Math.min(grid.scrollTop, maxScroll)
    const mount = locateGalleryWindow(
      model, scrollTop, grid.clientHeight, GALLERY_WINDOW_WARMUP_PX,
      Math.max(1, Math.floor(GALLERY_MAX_MOUNTED_CARDS / model.columns)),
    )
    const hydrate = mount
      ? locateGalleryWindow(
          model, scrollTop, grid.clientHeight, GALLERY_HYDRATE_WARMUP_PX,
          Math.max(1, Math.floor(GALLERY_MAX_HYDRATED_CARDS / model.columns)),
        ) ?? mount
      : null
    if (!mount || !hydrate) return
    setGalleryWindow(old => (
      old && old.model === model
        && old.mount.startRow === mount.startRow && old.mount.endRow === mount.endRow
        && old.hydrate.startRow === hydrate.startRow && old.hydrate.endRow === hydrate.endRow
        ? old : { model, mount, hydrate }
    ))
  }
  updateGalleryWindowRef.current = updateGalleryWindow
  useLayoutEffect(() => {
    updateGalleryWindow()
    // preview toggles remount the grid, so the window must be re-derived for
    // the fresh (top-of-gallery) scroll position.
  }, [assets, columns, windowingActive, preview])
  // The observer is bound to the grid element, which remounts when the
  // preview opens/closes: re-run the binding on every preview toggle or the
  // fresh grid keeps no size observer and window updates go blind.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => updateGalleryWindowRef.current())
    observer.observe(grid)
    return () => observer.disconnect()
  }, [preview])
  // The window must follow the scroll position even after pagination is done
  // (nextCursor exhausted): a gallery-wide jump otherwise lands the viewport
  // on nothing but spacer rows.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const onScroll = () => updateGalleryWindowRef.current()
    grid.addEventListener("scroll", onScroll, { passive: true })
    return () => grid.removeEventListener("scroll", onScroll)
  }, [preview])
  // Project switching is a transaction: everything project-scoped reloads
  // through the project-keyed effects, view-scoped state resets first, and a
  // failed load for the new project restores the previous project verbatim.
  const revertProjectSwitch = () => {
    const revert = projectRevertRef.current
    projectRevertRef.current = null
    if (!revert) {
      setLoadError(tr("项目切换失败"))
      return
    }
    // The restored view is the SAME view that was interrupted: prime the
    // view keys so the reload treats it as a same-view refresh and keeps the
    // snapshot's selection instead of resetting it.
    viewKeyRef.current = projectRevertKeyRef.current
    selectionViewKeyRef.current = projectRevertKeyRef.current
    revert()
    notify("项目切换失败，已恢复原项目")
  }
  const switchProject = (next: string) => {
    if (!next || next === project) return
    // Only a switch away from a project that actually loaded replaces the
    // restorable snapshot; bailing out of a project that never loaded keeps
    // the older snapshot so rapid switching still restores the last good view.
    if (project === lastGoodProjectRef.current) {
      const snapshot = {
        project, navHistory, stackId, stackName, active, query, debouncedQuery,
        sortOrder, assetType, selected, selectedIds, preview,
      }
      projectRevertKeyRef.current = JSON.stringify([
        snapshot.project, snapshot.active, snapshot.debouncedQuery,
        snapshot.sortOrder, snapshot.assetType, snapshot.stackId,
      ])
      projectRevertRef.current = () => {
        setNavHistory(snapshot.navHistory)
        setStackId(snapshot.stackId); setStackName(snapshot.stackName)
        setActive(snapshot.active); setQuery(snapshot.query); setDebouncedQuery(snapshot.debouncedQuery)
        setSortOrder(snapshot.sortOrder); setAssetType(snapshot.assetType)
        applySelection(snapshot.selectedIds, snapshot.selected)
        setPreview(snapshot.preview)
        setLoadError("")
        setProject(snapshot.project)
      }
    }
    setNavHistory({ stack: [{ active: "所有素材", stackId: "", stackName: "", query: "", sortOrder, assetType }], index: 0 })
    setStackId(""); setStackName(""); setActive("所有素材")
    setQuery(""); setDebouncedQuery("")
    applySelection([], "")
    setVersions(null); setGenerations(null)
    setPromptEdit(null)
    // Old-project rows must never linger under the new project, not even
    // while the new project's first page is still in flight.
    setAssets([]); setNextCursor(null)
    setLoadError("")
    pendingViewerReloadRef.current = false
    setPreview(false)
    setProject(next)
  }
  const exitStack = () => {
    if (!stackId) return false
    goTo({ stackId: "", stackName: "" })
    return true
  }
  // ── navigation history ──
  // goTo records the TARGET snapshot (deduped) and applies it, so the current
  // state at each stack position is what back/forward restores.
  const goTo = (partial: Partial<NavSnapshot>) => {
    setNavHistory(old => {
      const stack = old.stack.slice(0, old.index + 1)
      const next: NavSnapshot = { active, stackId, stackName, query: debouncedQuery, sortOrder, assetType, ...partial }
      if (stack[old.index] && JSON.stringify(stack[old.index]) === JSON.stringify(next)) return old
      stack.push(next)
      return { stack, index: stack.length - 1 }
    })
    if (partial.stackId !== undefined) { setStackId(partial.stackId); setStackName(partial.stackName ?? "") }
    if (partial.active !== undefined) setActive(partial.active)
    if (partial.query !== undefined) { setQuery(partial.query); setDebouncedQuery(partial.query) }
    if (partial.sortOrder !== undefined) setSortOrder(partial.sortOrder)
    if (partial.assetType !== undefined) setAssetType(partial.assetType)
    setPreview(false)
  }
  const navigateHistory = (direction: -1 | 1) => {
    const next = navHistory.index + direction
    if (next < 0) {
      // The design's back arrow also resets a filtered workspace at the
      // history's edge.
      goTo({ active: "所有素材", stackId: "", stackName: "", query: "" })
      return
    }
    if (next >= navHistory.stack.length) {
      notify("已是最新浏览位置")
      return
    }
    const snap = navHistory.stack[next]
    applySelection([], selectionRef.current.selected)
    setNavHistory(old => ({ ...old, index: next }))
    setStackId(snap.stackId); setStackName(snap.stackName)
    setActive(snap.active); setQuery(snap.query); setDebouncedQuery(snap.query)
    setSortOrder(snap.sortOrder); setAssetType(snap.assetType)
    setPreview(false)
  }
  // A settled search commit records its own entry; applying a history entry
  // reproduces its snapshot verbatim, so the dedupe keeps the stack clean.
  useEffect(() => {
    goTo({ query: debouncedQuery })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery])

  // ── multi-selection ──
  const anchorIndexRef = useRef<number>(-1)
  // Mirror of the current selection so consecutive same-tick interactions
  // (rapid ctrl-clicks) compose instead of reading stale render state. The
  // revision counter rises on every commit; long-running selection work
  // (cross-page select-all) compares it to detect a user taking over.
  const selectionRef = useRef({ selectedIds: [] as string[], selected: "" })
  const selectionRevisionRef = useRef(0)
  selectionRef.current = { selectedIds, selected }
  const applySelection = (nextIds: string[], nextSelected: string) => {
    selectionRevisionRef.current += 1
    selectionRef.current = { selectedIds: nextIds, selected: nextSelected }
    setSelectedIds(nextIds)
    setSelected(nextSelected)
  }
  const clearSelection = () => applySelection([], selectionRef.current.selected)
  // Every explicit focus switch outside the version fetch (related
  // recommendation, double-click preview, viewer arrows, right-click refocus)
  // commits through here: the inspector lands on an asset the batch selection
  // contains, and an in-flight history fetch is invalidated. The invalidation
  // also covers a re-click of the current focus (right-clicking the
  // inspected card keeps its menu's batch target honest): the latest intent
  // is "stay here", so a late version response can never retake the focus or
  // collapse the batch afterwards.
  const focusAsset = (id: string) => {
    if (!id) return
    historyIntentRef.current += 1
    historySelectAbortRef.current?.abort()
    historySelectAbortRef.current = null
    if (id === selectionRef.current.selected) return
    const next = focusSelection(selectionRef.current.selectedIds, selectionRef.current.selected, id)
    applySelection(next.selectedIds, next.selected)
  }
  const selectCard = (id: string, event: React.MouseEvent) => {
    const index = assets.findIndex(a => a.id === id)
    if (event.shiftKey && anchorIndexRef.current >= 0) {
      const [from, to] = [Math.min(anchorIndexRef.current, index), Math.max(anchorIndexRef.current, index)]
      const range = assets.slice(from, to + 1).filter(a => !a.stack).map(a => a.id)
      applySelection(range, replaceSelection(range, selectionRef.current.selected))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      const toggled = toggleModifierSelection(selectionRef.current.selectedIds, selectionRef.current.selected, id)
      applySelection(toggled.selectedIds, toggled.selected)
      anchorIndexRef.current = index
      return
    }
    anchorIndexRef.current = index
    applySelection([], id)
    setDetail(true)
  }
  const selectAllLoaded = () => {
    const ids = assets.filter(a => !a.stack).map(a => a.id)
    applySelection(ids, replaceSelection(ids, selectionRef.current.selected))
  }
  // Cross-page select-all: when the view still has unloaded pages, the whole
  // filtered result is fetched (250 per page, like the previous gallery) and
  // selected in one commit. Any selection change, view change or Escape
  // cancels it mid-flight; when everything is already loaded it reduces to
  // the synchronous path above. A ⌘A landing while a load is in flight is
  // queued for the settled view instead of being silently swallowed — bound
  // to the view identity and selection revision it was pressed in, so a
  // same-view refresh lets it through while a project, search, filter, sort
  // or stack switch (or any selection takeover) invalidates the stale intent.
  const selectAllInFlightRef = useRef(false)
  const pendingSelectAllRef = useRef<{ viewKey: string; revision: number } | null>(null)
  const selectAllAcrossPages = async () => {
    if (selectAllInFlightRef.current) return
    if (loading) {
      pendingSelectAllRef.current = { viewKey: viewKeyRef.current, revision: selectionRevisionRef.current }
      return
    }
    if (!nextCursor) { selectAllLoaded(); return }
    const requestViewKey = viewKeyRef.current
    const startRevision = selectionRevisionRef.current
    const controller = new AbortController()
    selectAllAbortRef.current = controller
    selectAllInFlightRef.current = true
    setToast(tr("正在全选"))
    try {
      const collected: string[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      // The page cap bounds the fetch. When the loop exits with pages still
      // outstanding, the commit below must announce a truncated selection —
      // never a completed select-all of a result it did not see.
      let morePages = false
      let guard = 0
      while (guard < 200) {
        guard += 1
        const page = await fetchAssetPage(buildQuery(cursor), {
          cursor, limit: 250, includeTotal: !cursor, signal: controller.signal,
        })
        if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
          || selectionRevisionRef.current !== startRevision) return
        for (const item of page.assets) {
          if (item.stack || seen.has(item.id)) continue
          seen.add(item.id)
          collected.push(item.id)
        }
        setToast(`${tr("正在全选")} ${collected.length}${page.total ? ` / ${page.total}` : "…"}`)
        morePages = Boolean(page.nextCursor)
        if (!morePages) break
        cursor = page.nextCursor
      }
      if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
        || selectionRevisionRef.current !== startRevision) return
      if (collected.length) {
        applySelection(collected, replaceSelection(collected, selectionRef.current.selected))
        setToast((morePages
          ? tr("结果过大，已选前 N 项")
          : tr("已选 N 项")).replace("N", String(collected.length)))
      }
    } catch (error) {
      if (!controller.signal.aborted) notify(errorMessage(error))
    } finally {
      if (selectAllAbortRef.current === controller) selectAllAbortRef.current = null
      selectAllInFlightRef.current = false
    }
  }
  // A ⌘A queued behind an in-flight load fires once the view settles — but
  // only if the settled view is still the one it was pressed in and no
  // selection takeover happened meanwhile. A switched view simply consumes
  // the stale intent: the queue never selects a gallery the user moved away
  // from.
  useEffect(() => {
    const pending = pendingSelectAllRef.current
    if (loading || !pending) return
    pendingSelectAllRef.current = null
    if (pending.viewKey !== viewKeyRef.current
      || selectionRevisionRef.current !== pending.revision) return
    void selectAllAcrossPages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])
  // Marquee selection: pointer drag across the grid background selects every
  // plain card whose box intersects the rubber band.
  const marqueeRef = useRef<{ x0: number; y0: number } | null>(null)
  const onGridPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0 || preview || settings || (event.target as HTMLElement).closest(".asset-card")) return
    marqueeRef.current = { x0: event.clientX, y0: event.clientY }
    setMarquee({ x0: event.clientX, y0: event.clientY, x1: event.clientX, y1: event.clientY })
    const move = (e: PointerEvent) => {
      const start = marqueeRef.current
      if (!start) return
      setMarquee({ x0: start.x0, y0: start.y0, x1: e.clientX, y1: e.clientY })
      const rect = { left: Math.min(start.x0, e.clientX), right: Math.max(start.x0, e.clientX), top: Math.min(start.y0, e.clientY), bottom: Math.max(start.y0, e.clientY) }
      const hits = Array.from(document.querySelectorAll<HTMLElement>(".asset-card:not(.asset-card-virtual-placeholder)"))
        .filter(node => !node.querySelector(".stack-mark"))
        .filter(node => {
          const box = node.getBoundingClientRect()
          return box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
        })
        .map(node => node.dataset.assetId)
        .filter((id): id is string => Boolean(id))
      const unique = [...new Set(hits)]
      applySelection(unique, replaceSelection(unique, selectionRef.current.selected))
    }
    const up = () => {
      marqueeRef.current = null
      setMarquee(null)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }
  // Batch helpers: every action in the context menu applies to the whole
  // selection once more than one card is marked.
  const selectionIds = logicalSelection(selectedIds, selected)
  const selectionSet = new Set(selectionIds)
  const batchIds = selectionIds
  const clearSelectionAndReload = () => { clearSelection(); refreshNavigation() }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        selectAllAbortRef.current?.abort()
        pendingSelectAllRef.current = null
        if (deleting) setDeleting(false)
        else if (menu) setMenu(null)
        else if (settings) setSettings(false)
        else if (preview) setPreview(false)
        else if (selectedIds.length || selected) applySelection([], "")
      }
      // Text surfaces own select-all, delete, cut and paste: Backspace in the
      // prompt editor, ⌘A in the search field and typing anywhere must never
      // trigger a gallery shortcut.
      if (isEditableTarget(e.target)) return
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault()
        void selectAllAcrossPages()
        return
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !settings && !deleting && selectionIds.length > 0 && active !== "回收站"
      )
        setDeleting(true)
      if ((e.metaKey || e.ctrlKey) && (e.key === "x" || e.key === "X") && selectionIds.length) {
        e.preventDefault()
        cutIdsRef.current = [...selectionIds]
        notify("已剪切")
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
        if (!cutIdsRef.current.length) return
        e.preventDefault()
        if (!stackId) { notify("粘贴需要在堆叠中进行"); return }
        const ids = [...new Set(cutIdsRef.current)]
        cutIdsRef.current = []
        moveAssetsToStack(project, ids, stackId)
          .then(outcome => {
            if (!outcome.succeeded) { notify(outcome.firstError || tr("粘贴失败")); return }
            notify(outcome.failed
              ? tr("已粘贴 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
              : tr("已粘贴到堆叠"))
            refreshNavigation()
          })
          .catch(error => notify(errorMessage(error)))
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, deleting, menu, assets, asset, stackId, active, language, selectedIds, selected, selectionIds])
  // Local file import: drag onto the workspace or paste image files. Every file
  // goes through the server's staging endpoint, so rejected types surface as
  // real errors instead of silent drops.
  const importFiles = async (files: File[], groupName?: string): Promise<string[]> => {
    if (!files.length || importing) return []
    const supported = library?.supportedMediaExtensions
    const usable = files.filter(file => {
      if (!supported || !supported.length) return true
      const lower = file.name.toLowerCase()
      return supported.some(ext => lower.endsWith(ext.toLowerCase()))
    })
    if (!usable.length) { notify("导入失败"); return [] }
    setImporting(true)
    notify("正在导入素材")
    try {
      const items: { imagePath: string }[] = []
      for (const file of usable) {
        try { items.push({ imagePath: await stageImportFile(file) }) }
        catch (error) { notify(errorMessage(error)) }
      }
      if (!items.length) return []
      const result = await importAssetsBatch(project, items)
      const createdIds = result.results.filter(item => item.ok !== false && typeof item.id === "string").map(item => item.id as string)
      if (groupName && createdIds.length) {
        try {
          const outcome = await setAssetsGroup(project, createdIds, groupName)
          if (outcome.failed) {
            notify(tr("已加入分组 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
          }
        } catch (error) { notify(errorMessage(error)) }
      }
      if (result.failed) notify("部分素材导入失败")
      else notify("导入完成")
      refreshNavigation()
      return createdIds
    } catch (error) {
      notify(errorMessage(error))
      return []
    } finally {
      setImporting(false)
    }
  }
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (active === "回收站") return
      const files = Array.from(event.clipboardData?.files || [])
      if (files.length) void importFiles(files)
    }
    window.addEventListener("paste", paste)
    return () => window.removeEventListener("paste", paste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing, library, active])
  const navigateAsset = async (direction: number) => {
    if (!visible.length) return
    const index = visible.findIndex(a => a.id === selected)
    const nextIndex = index + direction
    if (nextIndex >= visible.length && nextCursor) {
      // Cross the pagination boundary: the viewer pulls the next page and
      // steps straight into it.
      const merged = await fetchNextPage()
      if (merged && merged.length > visible.length) {
        focusAsset(merged[visible.length].id)
      }
      return
    }
    focusAsset(visible[(nextIndex + visible.length) % visible.length].id)
  }
  const toggleFavorite = async () => {
    if (!asset) return
    try {
      const updated = await toggleAssetFavorite(asset.project_id, asset.id)
      setAssets(old => old.map(a => a.id === updated.id ? mergeAssetDetail(a, updated) : a))
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const remove = async () => {
    // The selection is bound to the current view (reset on view change,
    // pruned on same-view refresh), so it is a legitimate batch target even
    // when it spans pages that are not loaded into the grid.
    const ids = selectionIds
    if (!ids.length) return
    try {
      const outcome = await moveAssetsToTrash(asset?.project_id ?? project, ids)
      setDeleting(false)
      setPreview(false)
      if (!outcome.succeeded) {
        notify(outcome.firstError || tr("素材未能移至回收站"))
        return
      }
      // Only rows the server confirmed leave the grid; a partial chunk
      // failure keeps the rest selectable and says so.
      const trashed = new Set(ids.filter(id => !outcome.failedIds.includes(id)))
      setAssets(old => old.filter(a => !trashed.has(a.id)))
      applySelection([], trashed.has(selectionRef.current.selected) ? "" : selectionRef.current.selected)
      notify(outcome.failed
        ? tr("已移至回收站 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
        : tr("素材已移至回收站"))
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const requestDelete = () => {
    setMenu(null)
    if (skipConfirm) remove()
    else setDeleting(true)
  }
  const restore = async () => {
    if (!asset) return
    try {
      await restoreAsset(asset.project_id, asset.id)
      setMenu(null)
      setPreview(false)
      notify("素材已恢复至素材库")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const assignGroup = (name: string) => {
    if (!asset) return
    setAssetsGroup(asset.project_id, [asset.id], name)
      .then(outcome => {
        if (!outcome.succeeded) { notify(outcome.firstError || tr(name ? "添加分组失败" : "移除分组失败")); return }
        setAssets(old => old.map(a => a.id === asset.id ? { ...a, group: name } : a))
        notify(name ? "已添加到分组" : "已从分组移除")
        refreshNavigation()
      })
      .catch(error => notify(errorMessage(error)))
  }
  const writeText = async (text: string) => {
    const api = desktopAPI()
    if (api?.writeClipboardText) { await api.writeClipboardText(text); return }
    await navigator.clipboard?.writeText(text)
  }
  const copyImage = async () => {
    if (!asset) return
    try {
      const api = desktopAPI()
      if (api?.writeClipboardImage && asset.image_path) {
        await api.writeClipboardImage(asset.image_path)
      } else {
        const response = await fetch(asset.preview_url || asset.image_url, { credentials: "same-origin" })
        const blob = await response.blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      }
      notify(`${tr("复制图片")} ${tr("完成")}`)
    } catch { notify(tr("复制图片失败")) }
  }
  const exportAsset = () => {
    if (!asset) return
    const link = document.createElement("a")
    link.href = asset.image_url
    link.download = asset.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    notify(`${tr("导出至")} ${tr("完成")}`)
  }
  const revealAssetPath = async () => {
    if (!asset) return
    try {
      await openLibraryFolder(asset.image_path, true)
      return
    } catch { /* fall through to copying the path */ }
    try {
      await writeText(asset.image_path || asset.image_url)
      notify(tr("路径已复制"))
    } catch { notify(tr("无法打开该位置")) }
  }
  const showInLibrary = () => {
    setMenu(null)
    setPreview(false)
    setStackId("")
    setStackName("")
    setQuery("")
    setDebouncedQuery("")
    setActive("所有素材")
    if (asset) {
      // The filter reset is a view change, which resets the selection; hand
      // the target through so the inspector still lands on this asset.
      pendingInspectRef.current = asset.id
      applySelection([], asset.id)
    }
  }
  const addToActiveGroup = () => {
    if (!asset) return
    if (!group) { notify(tr("请先在左侧选择或新建分组")); return }
    assignGroup(group)
  }
  const installModelPack = async () => {
    const api = desktopAPI()
    if (!api?.installVisualPack) { notify("尚未连接模型服务，暂时无法安装"); return }
    try {
      setModelProgress(0)
      const result = await api.installVisualPack()
      if (result && result.ok === false) {
        notify(String(result.error || tr("模型组件安装失败")))
      } else {
        notify(tr("模型组件已安装"))
      }
    } catch (error) {
      notify(String((error as Error)?.message || tr("模型组件安装失败")))
    } finally {
      setModelProgress(null)
      refreshNavigation()
    }
  }
  const checkForUpdates = async () => {
    const api = desktopAPI()
    if (!api?.checkForUpdates) { notify(tr("网页版请访问官网获取最新版本")); return }
    try {
      await api.checkForUpdates(true)
    } catch (error) {
      notify(String((error as Error)?.message || error))
    }
  }
  const changeLibraryLocation = async () => {
    const api = desktopAPI()
    if (!api?.changeLibraryLocation) { notify(tr("请在桌面版中修改素材库位置")); return }
    try {
      const result = await api.changeLibraryLocation()
      if (result && result.ok === false) {
        notify(String(result.error || tr("无法打开该位置")))
        return
      }
      notify(tr("已保存"))
      refreshNavigation()
    } catch (error) {
      notify(String((error as Error)?.message || error))
    }
  }
  const openStorageLocation = async () => {
    const target = library?.libraryDir || library?.path || ""
    if (!target) return
    try {
      await openLibraryFolder(target)
      notify(tr("已在桌面端打开存储位置"))
    } catch {
      try {
        await writeText(target)
        notify("路径已复制，请在系统文件管理器中打开")
      } catch { notify("浏览器无法直接打开本地文件夹，请手动复制路径") }
    }
  }
  const createNamedGroup = () => {
    // The design's add-group affordance creates an untitled group and activates
    // it; the server owns uniqueness, so colliding auto names bump the index.
    const existing = navigation?.groups.length ?? 0
    const attempt = (index: number) => {
      const name = `新分组 ${index}`
      createGroup(project, name)
        .then(() => {
          setStackId("")
          setActive(`group:${name}`)
          setPreview(false)
          refreshNavigation()
        })
        .catch((error: Error & { code?: string }) => {
          if (error?.code === "GROUP_ALREADY_EXISTS" && index < existing + 20) attempt(index + 1)
          else notify(errorMessage(error))
        })
    }
    attempt(existing + 1)
  }
  const versionBadge = health?.productVersion
    ? `${tr("版本")} ${health.productVersion}${health.distribution === "development" ? ` · ${tr("开发版")}` : ""}`
    : tr("版本")
  const assetPathTail = asset
    ? (asset.image_path || asset.image_url || "").split(/[\\/]/).pop() || ""
    : ""
  const relatedAssets = assets.filter(a => a.id !== (asset?.id || "")).slice(0, expandedRelated ? 6 : 2)
  const startPromptEdit = () => {
    if (!asset) return
    setPromptEdit({ project: asset.project_id, assetId: asset.id, draft: asset.prompt || "" })
  }
  const savePrompt = () => {
    const target = promptEdit
    if (!target || savingPromptId === target.assetId) return
    // The write goes to the bound asset only; if that asset is no longer the
    // one on screen the editor is already gone and there is nothing to save.
    const current = resolvePromptSaveTarget(target, assetsRef.current)
    if (!current) { setPromptEdit(null); return }
    const next = target.draft.trim()
    if (next === current.prompt) { setPromptEdit(null); return }
    setSavingPromptId(target.assetId)
    updateAssetMetadata(target.project, target.assetId, { prompt: next }).then(updated => {
      setAssets(old => old.map(a => a.id === updated.id ? mergeAssetDetail(a, updated) : a))
      setPromptEdit(old => old && old.assetId === target.assetId && old.project === target.project ? null : old)
      notify("已保存")
    }).catch(error => notify(errorMessage(error))).finally(() => {
      setSavingPromptId(old => old === target.assetId ? null : old)
    })
  }
  const timeLabel = (value?: string) => (value ? value.slice(0, 10) : "")

  return (
    <div
      ref={appRef}
      className={`app ${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : ""} ${MAC_DESKTOP ? "mac-desktop" : ""}`}
      onClick={() => menu && setMenu(null)}
    >
      <aside className="sidebar">
        <div className="brandbar">
          <strong>GravityPort</strong>
        </div>
        {projects.length > 1 && (
          <div className="sidebar-project">
            <ToolbarSelect
              label={tr("项目")}
              value={project}
              onChange={switchProject}
              options={projects.map(p => ({ value: p, label: p }))}
            />
          </div>
        )}
        <nav className="main-nav" aria-label={tr("素材库")}>
          {["所有素材", "Pinterest", "待整理", "收藏", "回收站"].map(
            (label, i) => (
              <button
                key={label}
                title={tr(label)}
                aria-label={tr(label)}
                aria-current={active === label ? "page" : undefined}
                className={`nav-row ${active === label ? "selected" : ""}`}
                onClick={() => {
                  goTo({ active: label, stackId: "", stackName: "" })
                  setSelectedIds([])
                }}
              >
                {i === 1 ? <span className="brand-icon" aria-hidden="true" /> : <Icon
                  name={i === 2 ? "inbox" : i === 3 ? "heart" : i === 4 ? "trash" : "grid"}
                  size={16}
                />}
                <span>{tr(label)}</span>
                <small>
                  {i === 0
                    ? navigation?.total ?? 0
                    : i === 1
                      ? navigation?.sourceTypes.find(s => s[0] === "pinterest")?.[1] ?? 0
                      : i === 2
                        ? navigation?.unorganized ?? 0
                        : i === 3
                          ? navigation?.favorites ?? 0
                          : navigation?.trash ?? 0}
                </small>
              </button>
            ),
          )}
        </nav>
        {[0, 1].map((section) => (
          <div className="group-section" key={section}>
            <div className="section-label">
              <button
                className="section-toggle"
                aria-label={section === 0 ? tr("智能分组") : tr("我的分组")}
                aria-expanded={expandedSections[section]}
                aria-controls={`sidebar-group-${section}`}
                onClick={() => setExpandedSections(old => old.map((value, i) => i === section ? !value : value))}
              >
                <span>{section === 0 ? tr("智能分组") : tr("我的分组")}</span>
                <Icon name={expandedSections[section] ? "down" : "right"} size={12} />
              </button>
              {section === 1 && <button
                className="add-group"
                aria-label={tr("添加我的分组")}
                title={tr("添加分组")}
                onClick={createNamedGroup}
              ><Icon name="plus" size={16} /></button>}
            </div>
            <nav id={`sidebar-group-${section}`} aria-label={section === 0 ? tr("智能分组") : tr("我的分组")} hidden={!expandedSections[section]}>
            {(section === 0
              ? (navigation?.sourceTypes || []).filter(entry => entry[1] > 0).map(entry => ({ id: `source:${entry[0]}`, name: smartGroupLabel(entry[0]), count: entry[1] }))
              : (navigation?.groups || []).map(entry => ({ id: `group:${entry.name}`, name: entry.name, count: entry.count }))
            ).map((g) => (
              <button
                className={`nav-row group-row ${
                  active === g.id ? "selected" : ""
                }`}
                key={g.id}
                title={tr(g.name)}
                aria-label={tr(g.name)}
                aria-current={active === g.id ? "page" : undefined}
                onClick={() => { goTo({ active: g.id, stackId: "", stackName: "" }); setSelectedIds([]) }}
                onDragOver={event => {
                  if (g.id.startsWith("group:") && !preview && !settings) event.preventDefault()
                }}
                onDrop={event => {
                  if (!g.id.startsWith("group:") || preview || settings) return
                  event.preventDefault()
                  void importFiles(Array.from(event.dataTransfer?.files || []), g.name)
                }}
              >
                <Icon name={section === 0 ? "layers" : "folder"} size={16} />
                <span>{tr(g.name)}</span>
                <small>{g.count}</small>
              </button>
            ))}
            </nav>
          </div>
        ))}
        <button className="user-button" onClick={() => setSettings(true)}>
          <Icon name="user" size={14} />
          <span>{tr("用户中心")}</span>
          <Icon name="settings" size={14} />
        </button>
      </aside>
      <main
        className={`workspace ${preview ? "preview-open" : ""}`}
        onDragOver={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
        }}
        onDrop={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
          void importFiles(Array.from(event.dataTransfer?.files || []))
        }}
      >
        <header className="toolbar">
          <div className="toolbar-left">
            {preview ? (
              <button onClick={() => setPreview(false)}>
                <Icon name="left" size={14} />
                {tr("返回")}</button>
            ) : (
              <>
                <button aria-label={tr("后退")} onClick={() => navigateHistory(-1)}>
                  <Icon name="left" />
                </button>
                <button
                  aria-label={tr("前进")}
                  onClick={() => navigateHistory(1)}
                >
                  <Icon name="right" />
                </button>
              </>
            )}
          </div>
          {preview && <div className="viewer-title"><strong>{asset?.name}</strong><span>{Math.max(1, visible.findIndex(a => a.id === asset?.id) + 1)} / {visible.length}</span></div>}
          {!preview && stackId && <div className="viewer-title"><strong>{stackName}</strong><span>{visible.length} {tr("素材")}</span></div>}
          <div className="toolbar-right">
            {preview ? (
              <>
                {active !== "回收站" && <button onClick={requestDelete}>
                  <Icon name="trash" size={12} />
                  {tr("删除")}</button>}
                <button onClick={() => setDetail(!detail)}>
                  <Icon name="info" size={16} />
                  {tr(detail ? "隐藏详情" : "显示详情")}</button>
              </>
            ) : (
              <>
                <ToolbarSelect label={tr("素材类型")} value={assetType} onChange={setAssetType} options={[{ value: "all", label: tr("全部类型") }, { value: "image", label: tr("图片") }, { value: "video", label: tr("视频") }]} />
                <ToolbarSelect label={tr("排序")} value={sortOrder} onChange={setSortOrder} options={[{ value: "newest", label: tr("最新优先") }, { value: "name", label: tr("名称排序") }]} />
                <ColumnControl value={columns} onChange={setColumns} language={language} />
                <label className="search">
                  <input
                    aria-label={tr("搜索素材")}
                    placeholder={tr("搜索素材")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <Icon name="search" size={12} />
                </label>
                {!detail && <button className="detail-toggle" aria-label={tr("显示详情")} title={tr("显示详情")} aria-expanded={false} onClick={() => setDetail(true)}><Icon name="inspector" size={16} /></button>}
              </>
            )}
          </div>
        </header>
        {preview ? (
          <ImageViewer key={asset?.id} width={asset?.width || 768} height={asset?.height || 1170} src={asset?.preview_url || asset?.image_url} isVideo={asset?.mediaKind === "video"} language={language} disabled={settings || deleting || !!menu} onNavigate={navigateAsset} onContextMenu={(x, y) => setMenu({ x, y })} message={toast} />
        ) : (
          <div
            ref={gridRef}
            className="asset-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
            data-loaded-assets={assets.length}
            onPointerDown={onGridPointerDown}
          >
            {(() => {
              const model = galleryWindow?.model ?? null
              const win = model ? galleryWindow : null
              if (!model || !win) {
                return assets.map((a) => (
                  <button
                    key={a.id}
                    data-asset-id={a.id}
                    aria-label={`${tr("查看素材")} ${a.stack ? `${tr("堆叠")} ${a.stack.name}` : a.name}`}
                    className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""}`}
                    style={{ aspectRatio: `${a.width} / ${a.height}` }}
                    onClick={(event) => {
                      if (a.stack) {
                        goTo({ stackId: a.stack.id, stackName: a.stack.name || a.name })
                        applySelection([], "")
                        return
                      }
                      selectCard(a.id, event)
                    }}
                    onDoubleClick={() => {
                      if (a.stack) return
                      focusAsset(a.id)
                      setPreview(true)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      if (a.stack) return
                      // Right-clicking outside the multi-selection re-targets the
                      // context menu to the clicked card; inside it, the whole
                      // selection stays the action target.
                      if (!selectedIds.includes(a.id)) applySelection([], a.id)
                      else focusAsset(a.id)
                      setMenu({ x: e.clientX, y: e.clientY })
                    }}
                  >
                    {a.thumbnail_url ? <img className="black-image" src={a.thumbnail_url} alt="" loading="lazy" /> : <div className="black-image" />}
                    {a.stack && (
                      <span className="stack-mark">
                        <Icon name="layers" size={12} />
                        {a.stack.count}
                      </span>
                    )}
                    {a.favorite && (
                      <span className="favorite-mark">
                        <Icon name="heart" size={12} />
                      </span>
                    )}
                    {cardInfo && <span className="card-name">{a.stack ? a.stack.name || a.name : a.name}</span>}
                  </button>
                ))
              }
              const items = assets.slice(win.mount.startRow * model.columns, (win.mount.endRow + 1) * model.columns)
              const hydratedIds = new Set(assets
                .slice(win.hydrate.startRow * model.columns, (win.hydrate.endRow + 1) * model.columns)
                .map(a => a.id))
              const spacers = gallerySpacerHeights(model, win.mount.startRow, win.mount.endRow)
              // Every card of a row gets the row's exact height (the tallest
              // ratio): shorter media fills its row instead of leaving holes.
              const rowHeightOf = (globalIndex: number) =>
                model.rowHeight[Math.floor(globalIndex / model.columns)]
              const card = (a: MosaAsset, globalIndex: number) => (
                <button
                  key={a.id}
                  data-asset-id={a.id}
                  aria-label={`${tr("查看素材")} ${a.stack ? `${tr("堆叠")} ${a.stack.name}` : a.name}`}
                  className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""}`}
                  style={{ height: rowHeightOf(globalIndex) }}
                  onClick={(event) => {
                    if (a.stack) {
                      goTo({ stackId: a.stack.id, stackName: a.stack.name || a.name })
                      applySelection([], "")
                      return
                    }
                    selectCard(a.id, event)
                  }}
                  onDoubleClick={() => {
                    if (a.stack) return
                    focusAsset(a.id)
                    setPreview(true)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    if (a.stack) return
                    // Right-clicking outside the multi-selection re-targets the
                    // context menu to the clicked card; inside it, the whole
                    // selection stays the action target.
                    if (!selectedIds.includes(a.id)) applySelection([], a.id)
                    else focusAsset(a.id)
                    setMenu({ x: e.clientX, y: e.clientY })
                    }}
                >
                  {a.thumbnail_url ? <img className="black-image" src={a.thumbnail_url} alt="" loading="lazy" /> : <div className="black-image" />}
                  {a.stack && (
                    <span className="stack-mark">
                      <Icon name="layers" size={12} />
                      {a.stack.count}
                    </span>
                  )}
                  {a.favorite && (
                    <span className="favorite-mark">
                      <Icon name="heart" size={12} />
                    </span>
                  )}
                  {cardInfo && <span className="card-name">{a.stack ? a.stack.name || a.name : a.name}</span>}
                </button>
              )
              return <>
                {spacers.top > 0 && <div className="gallery-window-spacer" style={{ gridColumn: "1 / -1", height: spacers.top }} aria-hidden="true" />}
                {items.map((a, localIndex) => hydratedIds.has(a.id)
                  ? card(a, win.mount.startRow * model.columns + localIndex)
                  : (
                    <div
                      key={a.id}
                      className="asset-card asset-card-virtual-placeholder"
                      data-asset-id={a.id}
                      aria-hidden="true"
                      style={{ height: rowHeightOf(win.mount.startRow * model.columns + localIndex) }}
                    />
                  ))}
                {spacers.bottom > 0 && <div className="gallery-window-spacer" style={{ gridColumn: "1 / -1", height: spacers.bottom }} aria-hidden="true" />}
              </>
            })()}
            {loading && <div className="empty-state" role="status">{tr("加载中")}</div>}
            {!loading && loadError && <div className="empty-state" role="alert"><Icon name="info" size={30} /><p>{loadError}</p><button onClick={refreshNavigation}>{tr("重试")}</button></div>}
            {!loading && !loadError && visible.length === 0 && (
              <div className="empty-state">
                <Icon
                  name={active === "回收站" ? "trash" : "search"}
                  size={30}
                />
                <p>
                  {active === "回收站"
                    ? tr("回收站中的素材保留 90 天")
                    : tr("没有找到匹配的素材")}
                </p>
              </div>
            )}
            <div ref={sentinelRef} aria-hidden="true" />
          </div>
        )}
      </main>
      {detail && asset && (
        <aside className="details">
          <div className="detail-heading">
            <strong>{tr("素材详情")}</strong>
            <button aria-label={tr("关闭素材详情")} onClick={() => setDetail(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="asset-summary">
            <button className="summary-image" aria-label={tr("预览当前素材")} onClick={() => setPreview(true)}>{asset.thumbnail_url ? <img src={asset.thumbnail_url} alt="" /> : null}<Icon name="expand" /></button>
            <div className="asset-meta">
              <div className="asset-title">
                <span className="asset-name" title={asset.name}>{asset.name}</span>
                <button
                  className={asset.favorite ? "is-favorite" : ""}
                  aria-label={tr("收藏素材")}
                  aria-pressed={!!asset.favorite}
                  onClick={toggleFavorite}
                >
                  <Icon name="heart" size={13} />
                </button>
              </div>
              <span className="muted">{asset.mediaKind === "video" ? tr("视频 · 本地素材") : tr("图片 · 本地素材")}</span>
              <button className="summary-preview" onClick={() => setPreview(true)}>{tr("打开预览")}<Icon name="right" size={12} /></button>
            </div>
          </div>
          <div className="asset-properties">
              {[
                ["格式", asset.format || "—"],
                ["尺寸", asset.width > 1 && asset.height > 1 ? `${asset.width} × ${asset.height}` : "—"],
                ["比例", ratioText(asset.width, asset.height)],
                ["大小", humanSize(asset.size_bytes)],
              ].map(([label, value]) => (
                <span className="property-tag" key={label} title={`${tr(label)}: ${tr(value)}`} aria-label={`${tr(label)}: ${tr(value)}`}>{tr(value)}</span>
              ))}
          </div>
          <div className="tags">
            {currentTags.slice(0, expandedTags ? currentTags.length : 3).map((t) => (
              <button key={t} onClick={() => notify(`${tr("标签：")}${t}`)}>
                {t}
              </button>
            ))}
            {currentTags.length > 3 && <button className="tags-toggle" aria-expanded={expandedTags} onClick={() => setExpandedTags(!expandedTags)}>{expandedTags ? tr("收起") : `+${currentTags.length - 3}`}</button>}
            {!addingTag && <button className="add-tag" onClick={() => { setAddingTag(true); setTagError("") }}><Icon name="plus" size={12} />{tr("添加标签")}</button>}
            {addingTag && <form className="tag-editor" onSubmit={e => {
              e.preventDefault()
              const tag = tagDraft.trim()
              if (!tag) { setTagError("请输入标签名称"); return }
              if (currentTags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setTagError("标签已存在"); return }
              updateAssetMetadata(asset.project_id, asset.id, { tags: [...currentTags, tag] }).then(updated => {
                setAssets(old => old.map(a => a.id === updated.id ? mergeAssetDetail(a, updated) : a))
              }).catch(error => notify(errorMessage(error)))
              setExpandedTags(true)
              setTagDraft("")
              setTagError("")
              setAddingTag(false)
            }}>
              <div className="tag-editor-controls">
                <input aria-label={tr("标签名称")} placeholder={tr("标签名称")} autoFocus maxLength={32} value={tagDraft} aria-invalid={!!tagError} aria-describedby={tagError ? "tag-error" : undefined} onChange={e => { setTagDraft(e.target.value); setTagError("") }} onKeyDown={e => {
                  if (e.key === "Escape") { e.stopPropagation(); setAddingTag(false); setTagDraft(""); setTagError("") }
                  if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault()
                }} />
                <button type="submit" aria-label={tr("保存标签")} title={tr("保存标签")}><Icon name="check" size={16} /></button>
                <button type="button" aria-label={tr("取消")} title={tr("取消")} onClick={() => { setAddingTag(false); setTagDraft(""); setTagError("") }}><Icon name="close" size={16} /></button>
              </div>
              {tagError && <p id="tag-error" role="alert">{tr(tagError)}</p>}
            </form>}
          </div>
          {asset.palette.length > 0 && <div className="palette">
            {asset.palette.map((c) => (
              <button
                key={c}
                title={`${tr("复制颜色")} ${c}`}
                style={{ background: c }}
                aria-label={`${tr("复制颜色")} ${c}`}
                onClick={async () => {
                  try { await writeText(c) } catch { navigator.clipboard?.writeText(c) }
                  notify(`${tr("已复制")} ${c}`)
                }}
              />
            ))}
          </div>}
          <section className="detail-section">
            <div className="field-heading">
              <span>
                {tr("提示词")}<small>{tr("原始信息")}</small>
              </span>
              <span className="field-actions">
                {!promptEditorActive(promptEdit, project, asset?.id) && <button className="section-action" onClick={startPromptEdit}>{tr("编辑")}</button>}
                <button
                  aria-label={tr("复制提示词")}
                  onClick={async () => {
                    if (!asset.prompt) { notify(tr("无提示词记录")); return }
                    try { await writeText(asset.prompt); notify("提示词已复制") }
                    catch { notify(String(tr("复制失败"))) }
                  }}
                >
                  <Icon name="copy" size={16} />
                </button>
              </span>
            </div>
            {promptEditorActive(promptEdit, project, asset?.id) && promptEdit ? (
              <div className="prompt-editor">
                <textarea
                  className="detail-editor"
                  aria-label={tr("编辑提示词")}
                  value={promptEdit.draft}
                  autoFocus
                  rows={6}
                  onChange={e => setPromptEdit(old => old ? { ...old, draft: e.target.value } : old)}
                  onKeyDown={e => {
                    if (e.key === "Escape") { e.stopPropagation(); setPromptEdit(null) }
                  }}
                />
                <div className="prompt-editor-actions">
                  <button className="neutral-button" onClick={() => setPromptEdit(null)}>{tr("取消")}</button>
                  <button
                    className="primary-button"
                    onClick={savePrompt}
                    disabled={(!promptEdit.draft.trim() && !asset.prompt) || savingPromptId === promptEdit.assetId}
                  >{tr("保存")}</button>
                </div>
              </div>
            ) : (
              <div className={`detail-reading ${expandedPrompt ? "expanded" : ""}`}>
                <p id="asset-prompt">{asset.prompt || tr("无提示词记录")}</p>
                <button className="reading-toggle" aria-expanded={expandedPrompt} aria-controls="asset-prompt" onClick={() => setExpandedPrompt(!expandedPrompt)}>{expandedPrompt ? tr("收起") : tr("展开提示词")}<Icon name={expandedPrompt ? "minus" : "down"} size={12} /></button>
              </div>
            )}
          </section>
          {asset.introduction && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("内容介绍")}</span>
              <button
                aria-label={tr("复制内容介绍")}
                onClick={async () => {
                  try { await writeText(asset.introduction); notify("内容介绍已复制") }
                  catch { navigator.clipboard?.writeText(asset.introduction) }
                }}
              >
                <Icon name="copy" size={16} />
              </button>
            </div>
            <div className={`detail-reading ${expandedIntro ? "expanded" : ""}`}>
              <p id="asset-introduction">{asset.introduction}</p>
              <button className="reading-toggle" aria-expanded={expandedIntro} aria-controls="asset-introduction" onClick={() => setExpandedIntro(!expandedIntro)}>{expandedIntro ? tr("收起") : tr("展开介绍")}<Icon name={expandedIntro ? "minus" : "down"} size={12} /></button>
            </div>
          </section>}
          {asset.references.length > 0 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("参考图")}</span>
            </div>
            <div className="reference-gallery" aria-label={tr("参考图缩略图")}>
              {asset.references.slice(0, 8).map((reference, index) => {
                const url = reference.attachment_url || reference.thumbnail_url || reference.image_url || ""
                if (!url) return null
                return <button key={reference.reference_id || index} className="reference-thumbnail" aria-label={tr("预览参考图")} onClick={() => window.open(url, "_blank", "noopener")}>
                  <img className="reference-image" src={url} alt="" loading="lazy" />
                </button>
              })}
            </div>
          </section>}
          {versions && versions.length > 1 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("版本")}</span>
              <span className="settings-badge">{versions.length}</span>
            </div>
            <div className="version-list" aria-label={tr("版本")}>
              {versions.map(v => (
                <button
                  className="related"
                  key={v.id}
                  onClick={() => selectHistoryAsset(v.id)}
                >
                  {v.id === selected
                    ? <Icon name="check" size={12} />
                    : <i>{v.thumbnail_url ? <img src={v.thumbnail_url} alt="" loading="lazy" /> : null}</i>}
                  <span>
                    {tr("版本")} {v.version_index}
                    <small>
                      {v.version_change || ""} {v.format || "—"} · {v.width} × {v.height} · {timeLabel(v.created_at)}
                    </small>
                  </span>
                  <Icon name="right" size={11} />
                </button>
              ))}
            </div>
          </section>}
          {generations && generations.length > 0 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("生成记录")}</span>
              <span className="settings-badge">{generations.length}</span>
            </div>
            <div className="version-list" aria-label={tr("生成记录")}>
              {generations.slice(0, expandedRelated ? 8 : 3).map((event, index) => (
                <button
                  className="related"
                  key={event.id || index}
                  onClick={() => { if (event.output_asset_id) selectHistoryAsset(event.output_asset_id) }}
                >
                  <i />
                  <span>
                    {(event.effective_prompt || event.user_prompt || tr("无提示词记录")).slice(0, 60)}
                    <small>
                      {timeLabel(event.created_at)}{event.provider ? ` · ${event.provider}` : ""}{event.model ? ` · ${event.model}` : ""}{event.turn_index != null ? ` · ${tr("轮次")} ${event.turn_index}` : ""}
                    </small>
                  </span>
                  <Icon name="right" size={11} />
                </button>
              ))}
            </div>
          </section>}
          {relatedAssets.length > 0 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("相关推荐")}</span>
              <button className="section-action" aria-expanded={expandedRelated} onClick={() => setExpandedRelated(!expandedRelated)}>{expandedRelated ? tr("收起") : tr("更多")}<Icon name="down" size={12} /></button>
            </div>
            {relatedAssets.map((relatedAsset) => (
              <button
                className="related"
                key={relatedAsset.id}
                onClick={() => focusAsset(relatedAsset.id)}
              >
                <i>{relatedAsset.thumbnail_url ? <img src={relatedAsset.thumbnail_url} alt="" loading="lazy" /> : null}</i>
                <span>
                  {relatedAsset.name}
                  <small>
                    {relatedAsset.format || "—"} · {relatedAsset.width} × {relatedAsset.height}
                  </small>
                </span>
                <Icon name="right" size={11} />
              </button>
            ))}
          </section>}
          <button
            className="library-location"
            onClick={revealAssetPath}
          >
            <strong>{tr("素材路径")}</strong>
            <span title={asset.image_path || asset.image_url}>{assetPathTail ? `…/${assetPathTail}` : "—"}</span>
            <Icon name="external" size={12} />
          </button>
        </aside>
      )}
      {settings && (
        <div
          className="modal-layer"
          onMouseDown={(e) =>
            e.target === e.currentTarget && setSettings(false)
          }
        >
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr("设置")}
          >
            <aside className="settings-nav">
              <h2>{tr("设置")}</h2>
              {[
                ["常规与外观", "sun"],
                ["存储", "folder"],
                ["模型", "grid"],
                ["MCP", "link"],
                ["关于", "info"],
              ].map(([label, icon]) => (
                <button
                  className={settingTab === label ? "active" : ""}
                  aria-pressed={settingTab === label}
                  key={label}
                  onClick={() => setSettingTab(label)}
                >
                  <Icon name={icon} size={15} />
                  {tr(label === "常规与外观" ? "常规" : label)}
                </button>
              ))}
              <div className="settings-brand">
                GravityPort
                <span>{tr("让灵感，自由停靠。")}</span>
              </div>
            </aside>
            <div className="settings-content">
              <div className="settings-heading">
                <div className="settings-heading-copy">
                  <h3>{tr(settingTab === "常规与外观" ? "常规" : settingTab)}</h3>
                </div>
                <button
                  className="modal-close"
                  aria-label={tr("关闭设置")}
                  onClick={() => setSettings(false)}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              <div className="settings-page" key={settingTab}>
              {settingTab === "常规与外观" ? (
                <>
                  <section className="settings-section theme-section" aria-label={tr("外观")}>
                  <div className="appearance-options">
                    {["跟随系统", "浅色", "深色"].map((a, i) => (
                      <button
                        key={a}
                        aria-pressed={appearance === a}
                        className={`appearance-option ${
                          appearance === a ? "chosen" : ""
                        }`}
                        onClick={() => setAppearance(a)}
                      >
                        <div className={`theme-preview theme-${i}`}>
                          <div className="mini-sidebar" />
                          <div className="mini-content">
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                          {appearance === a && (
                            <span>
                              <Icon name="check" size={10} />
                            </span>
                          )}
                        </div>
                        <span>{tr(a)}</span>
                      </button>
                    ))}
                  </div>
                  </section>
                  <section className="settings-section">
                  <div className="setting-row">
                    <span>{tr("显示素材名称")}</span>
                    <button className={`settings-switch ${cardInfo ? "enabled" : ""}`} role="switch" aria-checked={cardInfo} aria-label={tr("显示素材名称")} onClick={() => setCardInfo(!cardInfo)}><span /></button>
                  </div>
                  </section>
                  <section className="settings-section">
                  <div className="setting-row">
                    <span>{tr("界面语言")}</span>
                    <div className="segmented" role="group" aria-label={tr("界面语言")}>
                      <button className={language === "zh" ? "on" : ""} aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中文</button>
                      <button className={language === "en" ? "on" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
                    </div>
                  </div>
                  </section>
                </>
              ) : settingTab === "存储" ? (
                <>
                  <section className="settings-section">
                    <div className="storage-summary storage-path">
                      <Icon name="folder" size={16} />
                      <div className="storage-description"><strong>{tr("存储位置")}</strong><span title={library?.path || ""}>{library?.path || "—"}</span></div>
                      <div className="storage-actions">
                        <button className="neutral-button" onClick={openStorageLocation}>{tr("打开")}</button>
                        <button className="neutral-button" onClick={changeLibraryLocation}>{tr("修改")}</button>
                      </div>
                    </div>
                  </section>
                  <div className="settings-note"><p>{library ? `${tr("存储类型")}: ${library.storage}` : ""}</p></div>
                </>
              ) : settingTab === "模型" ? (
                <>
                  <section className="settings-section">
                    <div className="model-summary">
                      <div className="model-symbol"><Icon name="layers" size={16} /></div>
                      <div className="model-description"><strong>{tr("本地视觉搜索")}</strong><span title={visual?.available ? tr("模型服务运行中") : tr("尚未连接模型服务")}>
                        {visual?.available
                          ? tr("模型服务运行中")
                          : modelProgress != null
                            ? `${tr("正在安装模型组件")} ${modelProgress}%`
                            : tr("尚未连接模型服务")}
                      </span></div>
                      {!visual?.available && <button className="neutral-button" onClick={installModelPack}>{tr("安装")}</button>}
                    </div>
                  </section>
                  <div className="settings-note"><p>{tr("连接模型服务后即可启用。")}</p></div>
                </>
              ) : settingTab === "MCP" ? (
                <>
                  <section className="settings-section integration-card">
                      <div className="model-symbol"><span className="brand-icon" aria-hidden="true" /></div>
                      <div className="integration-copy">
                        <div className="integration-title"><strong>Pinterest</strong><span>{tr("未连接")}</span></div>
                        <p className="integration-description">{tr("连接 Pinterest MCP 后，可同步收藏与画板。")}</p>
                      </div>
                      <button className="neutral-button" onClick={() => notify("尚未接入 Pinterest MCP 服务，暂时无法连接")}>{tr("连接")}</button>
                  </section>
                </>
              ) : (
                <>
                  <section className="settings-section about-summary">
                    <div className="about-symbol">
                      <img className="app-logo" src={`/assets/gravityport-mark-${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : "light"}.svg`} width={40} height={40} alt="" aria-hidden="true" />
                    </div>
                    <div className="about-identity"><h4>GravityPort</h4><span className="settings-badge" title={versionBadge}>{versionBadge}</span></div>
                    <button className="neutral-button about-update" onClick={checkForUpdates}>{tr("检查更新")}</button>
                  </section>
                  <section className="settings-section release-notes" aria-labelledby="release-notes-title">
                    <div className="release-heading"><h4 id="release-notes-title">{tr("本次更新")}</h4><span>{tr("构建信息")}</span></div>
                    <ul>
                      <li>{tr("版本")} {health?.productVersion || "—"}</li>
                      <li>{tr("构建")} {health?.gitSha ? health.gitSha.slice(0, 7) : "—"}</li>
                      <li>{health?.distribution === "development" ? tr("开发版") : tr("正式版")}</li>
                    </ul>
                  </section>
                </>
              )}
              </div>
              {!savedLocally && <div className="settings-footnote" role="status">
                <Icon name="info" size={12} />
                {tr("无法保存偏好，仅在当前会话生效")}
              </div>}
            </div>
          </div>
        </div>
      )}
      {menu && asset && (
        <div
          className="context-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 385),
          }}
        >
          {[
            ["在查看器中打开", "external"],
            ["在素材库中显示", "folder"],
            ["复制图片", "image"],
            ["剪切", "scissors"],
            ["复制提示词", "copy"],
            ["复制路径", "link"],
            [asset.favorite ? "取消收藏" : "收藏", "heart"],
            ["添加分组", "plus"],
            ["移除分组", "folder"],
            ["导出至", "external"],
            [active === "回收站" ? "恢复素材" : "移至回收站", "trash"],
          ].map(([label, icon], i) => (
            <button
              className={`${
                i === 2 || i === 6 || i === 9 ? "menu-divider" : ""
              } ${i === 10 ? "danger" : ""}`}
              key={label}
              onClick={() => {
                setMenu(null)
                const batch = batchIds.length > 1
                const batchIdsAll = [...batchIds]
                if (i === 0) setPreview(true)
                else if (i === 1) showInLibrary()
                else if (i === 2) copyImage()
                else if (i === 3) {
                  cutIdsRef.current = batchIdsAll
                  notify("已剪切")
                } else if (i === 4) {
                  if (!asset.prompt) { notify(tr("无提示词记录")); return }
                  writeText(asset.prompt).then(() => notify(`${tr("复制提示词")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
                } else if (i === 5) {
                  writeText(asset.image_path || asset.image_url).then(() => notify(`${tr("复制路径")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
                } else if (i === 6) {
                  if (batch) {
                    setAssetsFavorite(asset.project_id, batchIdsAll, !asset.favorite)
                      .then(outcome => {
                        if (!outcome.succeeded) { notify(outcome.firstError || tr("收藏失败")); return }
                        setSelectedIds([])
                        if (outcome.failed) {
                          notify(tr("已收藏 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
                        }
                        refreshNavigation()
                      })
                      .catch(error => notify(errorMessage(error)))
                  } else toggleFavorite()
                } else if (i === 7) {
                  if (!group) { notify(tr("请先在左侧选择或新建分组")); return }
                  setAssetsGroup(asset.project_id, batchIdsAll, group)
                    .then(outcome => {
                      if (!outcome.succeeded) { notify(outcome.firstError || tr("添加分组失败")); return }
                      setSelectedIds([])
                      notify(outcome.failed
                        ? tr("已加入分组 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
                        : tr("已添加到分组"))
                      refreshNavigation()
                    })
                    .catch(error => notify(errorMessage(error)))
                } else if (i === 8) {
                  setAssetsGroup(asset.project_id, batchIdsAll, "")
                    .then(outcome => {
                      if (!outcome.succeeded) { notify(outcome.firstError || tr("移除分组失败")); return }
                      setSelectedIds([])
                      notify(outcome.failed
                        ? tr("已从分组移除 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
                        : tr("已从分组移除"))
                      refreshNavigation()
                    })
                    .catch(error => notify(errorMessage(error)))
                } else if (i === 9) exportAsset()
                else if (active === "回收站") restore()
                else requestDelete()
              }}
            >
              <Icon name={icon} size={14} />
              <span>{tr(String(label))}</span>
              {i === 0 && <small><Icon name="enter" size={12} /></small>}
              {i === 10 && <small><Icon name="backspace" size={12} /></small>}
            </button>
          ))}
        </div>
      )}
      {deleting && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{tr("是否移至回收站？")}</h3>
            <p>{tr("素材会在回收站保留 90 天，期间可以随时还原。")}</p>
            <div className="delete-actions">
              <label>
                <input
                  type="checkbox"
                  checked={skipConfirm}
                  onChange={(e) => setSkipConfirm(e.target.checked)}
                />
                {tr("不再提醒")}</label>
              <button
                className="neutral-button"
                onClick={() => setDeleting(false)}
              >
                {tr("取消")}</button>
              <button className="primary-button" onClick={remove}>
                {tr("移至回收站")}</button>
            </div>
          </div>
        </div>
      )}
      {marquee && (
        <div
          className="marquee-rect"
          aria-hidden="true"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}
      {toast && !preview && (
        <div className="toast" role="status" aria-live="polite">
          <Icon name="info" size={16} />
          {toast}
        </div>
      )}
    </div>
  )
}
