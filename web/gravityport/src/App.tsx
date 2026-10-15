import { useEffect, useLayoutEffect, useRef, useState } from "react"
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import ColumnControl from "./ColumnControl"
import ImageViewer from "./ImageViewer"
import { translate, type Language } from "./i18n"
import { buildContextMenu, type MenuContext, type MenuEntry } from "./context-menus"
import { createStack, renameStack, dissolveStack, removeAssetsFromStack, assignStackToGroup, trashStack, restoreAssets, permanentlyDeleteAssets, emptyTrash } from "./library-actions"
import { runImport, collectDroppedFiles } from "./import-pipeline"
import { trashRemainingDays } from "./trash-ui"
import { desktopAPI } from "./desktop"
import { focusSelection, logicalSelection, pruneSelection, replaceSelection, toggleModifierSelection } from "./selection"
import { promptEditorActive, resolvePromptSaveTarget, type PromptEditTarget } from "./prompt-edit"
import { isEditableTarget } from "./keyboard"
import { generationTreeRows } from "./version-tree"
import { sanitizeAssetForExport, relationTypes } from "./feature-parity"
import { resolveReferences } from "./inspector-info"
import {
  buildMasonryModel, galleryImageSizes, galleryModelSignature, locateMasonryWindow, masonryCardCss, masonryExtentCss,
  type MasonryModel,
} from "./gallery-window"
import { readStoredColumns, resolveInitialColumns, writeStoredColumns } from "./gallery-columns"
import { deriveEmptyState } from "./empty-state"
import { describeGroupStats } from "./group-stats"
import { createResyncOnReconnect } from "./live-sync-resync"
import { applyVisualPackProgress, describeVisualModel, visualModelActionLabel, type VisualModelAction, type VisualModelStatus } from "./visual-model"
import {
  checkVersionConsistency,
  createReadyGate,
  fill,
  mapUpdateResult,
  buildUpdateText,
  shouldAutoCheckForUpdates,
  recordUpdateCheck,
  type UpdateUiState,
} from "./app-lifecycle"
import {
  fetchAssetPage, fetchAsset, fetchNavigation, fetchLibraryLocation, fetchHealth, fetchVisualStatus, fetchSimilarAssets,
  fetchProjects, fetchAssetVersions, fetchAssetGenerationHistory, setAssetsFavorite,
  toggleAssetFavorite, updateAssetMetadata, moveAssetsToTrash, setAssetsGroup,
  createGroup, renameGroup, recolorGroup, reorderGroups, fetchGroupStats, deleteGroupKeepingAssets, mergeGroups, fetchRawGroupAssets,
  moveAssetsToStack, openLibraryFolder,
  mosaMutationHeaders, mergeAssetDetail, galleryImageSrcSet, type MosaAsset, type MosaNavigation, type MosaLibraryLocation,
  type MosaVisualStatus, type AssetQuery, type MosaVersionRow, type MosaGenerationHistory, type MosaRecipeHistory,
  fetchAssetRecipes, createGenerationRelation, editGenerationRelation, removeGenerationRelation, dismissGenerationCandidate,
} from "./mosa-api"

type Scope = "all" | "favorite" | "unorganized" | "trash"

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

/** Inspector text that shows its first five lines and offers to expand only
 *  when there is more to show. */
function ReadingText({ id, text, expanded, onToggle, expandLabel, collapseLabel }: {
  id: string
  text: string
  expanded: boolean
  onToggle: () => void
  expandLabel: string
  collapseLabel: string
}) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const paragraph = ref.current
    if (!paragraph || expanded) return
    const measure = () => setOverflows(paragraph.scrollHeight > paragraph.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(paragraph)
    return () => observer.disconnect()
  }, [text, expanded])
  return (
    <div className={`detail-reading five-lines ${expanded ? "expanded" : ""}`}>
      <p id={id} ref={ref}>{text}</p>
      {overflows && <button className="reading-toggle" aria-expanded={expanded} aria-controls={id} onClick={onToggle}>{expanded ? collapseLabel : expandLabel}<Icon name={expanded ? "minus" : "down"} size={12} /></button>}
    </div>
  )
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

/** Same curated capture/bridge groups as the pre-React MOSA sidebar. Manual
 * imports and arbitrary historical source names are not smart groups. */
const SMART_SOURCE_GROUPS = [
  ["web-chatgpt", "ChatGPT"], ["web-gemini", "Gemini"],
  ["web-flow", "Flow"], ["web-google-ai-studio", "Google AI Studio"],
  ["codex-generated", "Codex"], ["grok-generated", "Grok"],
  ["cowart-generated", "Cowart"],
] as const

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

/** One toast action button (task 142): the undo affordance on trash toasts. */
type ToastAction = { label: string; run: () => void }

type ToastState = { text: string; action?: ToastAction; duration?: number } | null

/** One row of the context menu. A row with a submenu expands it on hover or
 * keyboard focus; near the right window edge the submenu flips to the left,
 * and a submenu taller than the window shifts up and scrolls internally. */
const MENU_SUBMENU_WIDTH = 200

function MenuRow({ entry, onAction }: { entry: Extract<MenuEntry, { kind: "item" }>; onAction: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [flip, setFlip] = useState(false)
  const [shiftUp, setShiftUp] = useState(0)
  const buttonRef = useRef<HTMLButtonElement>(null)
  // Leaving the row starts a short close timer so the pointer can travel the
  // gap to the submenu (and cross back over the flipped side) without
  // collapsing it; entering either part cancels the timer.
  const closeTimer = useRef<number | null>(null)
  useEffect(() => () => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current) }, [])
  const scheduleClose = () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), 250)
  }
  const cancelClose = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null }
  }
  const expand = () => {
    cancelClose()
    if (!entry.submenu?.length) return
    const rect = buttonRef.current?.getBoundingClientRect()
    if (rect) {
      setFlip(rect.right + MENU_SUBMENU_WIDTH + 8 > window.innerWidth)
      // The submenu must clear the window bottom before its real height can
      // be measured; the row count bounds it well enough for the shift.
      const estimatedHeight = entry.submenu.length * 32 + 8
      setShiftUp(Math.max(0, rect.bottom + estimatedHeight - window.innerHeight + 8))
    }
    setOpen(true)
  }
  const iconFor = (item: Extract<MenuEntry, { kind: "item" }>) => item.color
    ? <span className="group-color-dot" style={{ background: item.color || "#8b8b93" }} />
    : item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu-icon-slot" />
  return (
    <div className="menu-row" onMouseLeave={scheduleClose}>
      <button
        ref={buttonRef}
        role="menuitem"
        aria-haspopup={entry.submenu ? "menu" : undefined}
        aria-expanded={entry.submenu ? open : undefined}
        className={entry.danger ? "danger" : ""}
        disabled={entry.disabled}
        onClick={entry.submenu
          ? () => { if (open) setOpen(false); else expand() }
          : () => onAction(entry.id)}
        onMouseEnter={expand}
        onFocus={expand}
        onBlur={event => {
          // Pressing a submenu item moves focus off this button before the
          // click lands; closing here would unmount the item mid-click.
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
        aria-label={entry.label}
      >
        {iconFor(entry)}
        <span>{entry.label}</span>
        {entry.shortcut && <small>{entry.shortcut}</small>}
        {!entry.shortcut && entry.id === "open-viewer" && <small><Icon name="enter" size={12} /></small>}
        {entry.id === "move-to-trash" && <small><Icon name="backspace" size={12} /></small>}
        {entry.submenu && <small><Icon name="right" size={12} /></small>}
      </button>
      {open && entry.submenu && (
        <div
          className={`context-submenu${flip ? " flip" : ""}`}
          role="menu"
          style={shiftUp ? { top: -4 - shiftUp } : undefined}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          {entry.submenu.map((sub, index) => {
            if (sub.kind === "separator") return <div key={`sep-${index}`} className="menu-divider" />
            if (sub.kind === "heading") return <div key={`head-${index}`} className="menu-heading">{sub.label}</div>
            return (
              <button
                key={sub.id}
                role="menuitem"
                className={sub.danger ? "danger" : ""}
                disabled={sub.disabled}
                onClick={() => { setOpen(false); onAction(sub.id) }}
              >
                {iconFor(sub)}
                <span>{sub.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** localStorage for the remembered column count; blocked storage (privacy
 * mode, denied access) just means the choice is not remembered. */
function columnsStorage(): { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void } {
  try { return window.localStorage } catch { return { getItem: () => null, setItem: () => {} } }
}

export default function App() {
  // macOS already draws the native window buttons with titleBarStyle=hiddenInset;
  // Windows also owns its native caption buttons. Only the browser mockup
  // needs the decorative circles from the original GravityPort design.
  const desktop = desktopAPI()
  const nativeChromeClass = desktop && navigator.platform.startsWith("Mac")
    ? "native-desktop native-darwin"
    : desktop ? "native-desktop" : ""
  const [assets, setAssets] = useState<MosaAsset[]>([])
  const [navigation, setNavigation] = useState<MosaNavigation | null>(null)
  const [library, setLibrary] = useState<MosaLibraryLocation | null>(null)
  const [health, setHealth] = useState<{ productVersion: string; gitSha: string; distribution: string } | null>(null)
  const [visual, setVisual] = useState<MosaVisualStatus | null>(null)
  // Desktop-side visual model state (install / enable / progress), shown on the
  // settings 模型 tab; null until the desktop bridge answers.
  const [visualModel, setVisualModel] = useState<VisualModelStatus | null>(null)
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
  const [promptVariant, setPromptVariant] = useState<1 | 2>(1)
  const [expandedIntro, setExpandedIntro] = useState(false)
  const [expandedInstruction, setExpandedInstruction] = useState(false)
  const [expandedTags, setExpandedTags] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [tagError, setTagError] = useState("")
  const [expandedRelated, setExpandedRelated] = useState(false)
  const [preview, setPreview] = useState(false)
  // The context menu carries its target with it: stack menus act on the
  // right-clicked stack without touching the selection, so the handlers read
  // the menu state instead of guessing from the focused asset.
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; target: MenuContext["target"]; selectionCount: number; stackId: string; stackName: string; stackCount: number } | null>(null)
  // The menu clamps into the window by its real rendered size, not a row
  // estimate: the effect measures after mount and corrects before paint.
  const menuRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!menu) { setMenuPos(null); return }
    const node = menuRef.current
    setMenuPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - (node?.offsetWidth || 192) - 8)),
      top: Math.max(8, Math.min(menu.y, window.innerHeight - (node?.offsetHeight || 320) - 8)),
    })
  }, [menu])
  const [deleting, setDeleting] = useState(false)
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [columns, setColumns] = useState(() => resolveInitialColumns(readStoredColumns(columnsStorage()), window.innerWidth))
  const [toast, setToast] = useState<ToastState>(null)
  const [expandedSections, setExpandedSections] = useState([true, true])
  const [groupMenu, setGroupMenu] = useState<{ name: string; x: number; y: number } | null>(null)
  const [groupRename, setGroupRename] = useState<{ original: string; draft: string } | null>(null)
  const [stackRename, setStackRename] = useState<{ stackId: string; initialName: string; draft: string } | null>(null)
  const [stackDissolveConfirm, setStackDissolveConfirm] = useState<{ stackId: string; stackCount: number } | null>(null)
  const [stackTrashConfirm, setStackTrashConfirm] = useState<{ stackId: string; stackCount: number } | null>(null)
  // Task 142: the trash's own confirmations — permanent delete carries the ids
  // captured at menu time; neither shares state with the move-to-trash dialog
  // and neither honors the 「不再提醒」 suppression.
  const [permanentDeleteIds, setPermanentDeleteIds] = useState<string[] | null>(null)
  const [emptyTrashConfirm, setEmptyTrashConfirm] = useState(false)
  const [groupCreateWithSelection, setGroupCreateWithSelection] = useState<{ target: "asset" | "stack"; targetStackId?: string; draft: string } | null>(null)
  const [groupCreateError, setGroupCreateError] = useState("")
  const [groupStats, setGroupStats] = useState<{ name: string; values: Record<string, unknown> } | null>(null)
  const [groupDeleteConfirm, setGroupDeleteConfirm] = useState<string | null>(null)
  const [groupMerge, setGroupMerge] = useState<{ source: string; target: string } | null>(null)
  const [exportingGroup, setExportingGroup] = useState("")
  const [skipConfirm, setSkipConfirm] = useState(preferences.skipTrashConfirm)
  // 「不再提醒」persists across sessions like the preference it is.
  useEffect(() => {
    try { localStorage.setItem("gravityport.skip-trash-confirm", skipConfirm ? "1" : "0") } catch { /* session-only */ }
  }, [skipConfirm])
  // Update check state machine (app-lifecycle).
  const [updateState, setUpdateState] = useState<UpdateUiState>({ phase: "idle" })
  // Rename notice (task 116): shown once at first-screen render.
  const [renameNoticeOpen, setRenameNoticeOpen] = useState(false)
  const [versions, setVersions] = useState<MosaVersionRow[] | null>(null)
  const [generationHistory, setGenerationHistory] = useState<MosaGenerationHistory | null>(null)
  const [relationBusy, setRelationBusy] = useState(false)
  const [relationDrafts, setRelationDrafts] = useState<Record<string, string>>({})
  const [newRelation, setNewRelation] = useState<{ anchor: string; other: string; direction: string; type: string } | null>(null)
  // undefined: the recipe history has not answered for this asset yet;
  // null: it answered with none. Web captures keep their references there.
  const [recipeHistory, setRecipeHistory] = useState<MosaRecipeHistory | null | undefined>(undefined)
  const [similarAssets, setSimilarAssets] = useState<MosaAsset[]>([])
  const [versionTreeOpen, setVersionTreeOpen] = useState(false)
  const [compareBaseId, setCompareBaseId] = useState("")
  const [compareTargetId, setCompareTargetId] = useState("")
  // The prompt draft is bound to one concrete asset; it never outlives the
  // asset (or project) it was opened for.
  const [promptEdit, setPromptEdit] = useState<PromptEditTarget & { draft: string } | null>(null)
  const [savingPromptId, setSavingPromptId] = useState<string | null>(null)
  // Masonry placements retain each original image's intrinsic aspect ratio.
  // Only items intersecting the viewport's warm/hydrate bands are mounted.
  const [galleryWindow, setGalleryWindow] = useState<{
    model: MasonryModel; mounted: number[]; hydrated: number[];
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
  const readyGateRef = useRef<ReturnType<typeof createReadyGate> | null>(null)
  if (!readyGateRef.current) {
    readyGateRef.current = createReadyGate(() => {
      desktopAPI()?.reportRendererReady?.().catch(() => {})
    })
  }
  const versionOkRef = useRef(false)
  const firstPageOkRef = useRef(false)
  const sseOpenRef = useRef(false)
  const deletingRef = useRef(deleting)
  const settingsRef = useRef(settings)
  const renameNoticeRef = useRef(renameNoticeOpen)
  deletingRef.current = deleting
  settingsRef.current = settings
  renameNoticeRef.current = renameNoticeOpen
  const dismissRenameNotice = () => {
    setRenameNoticeOpen(false)
    desktopAPI()?.acknowledgeRenameNotice?.().catch(() => {})
  }

  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    setExpandedPrompt(false)
    setRecipeHistory(undefined)
    setRelationDrafts({})
    setNewRelation(null)
    setPromptVariant(1)
    setExpandedIntro(false)
    setExpandedInstruction(false)
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
      // A select-all started in the old view is stale now: drop it so the
      // post-load prune below can seat the new view's implicit single card.
      selectAllAbortRef.current?.abort()
      pendingSelectAllRef.current = null
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
          // A fixed 30-page ceiling silently truncated a 4,249-item loaded
          // gallery to 3,100 items on every same-view SSE refresh. Derive the
          // work budget from the previously loaded window instead, allowing
          // partial/duplicate pages without permitting an unbounded loop.
          const maxFollowupPages = Math.max(30, Math.ceil(target / GALLERY_PAGE_SIZE) * 2)
          const seenIds = new Set(collected.map(item => item.id))
          const seenCursors = new Set<string>()
          let cursor: string | undefined = page.nextCursor ?? undefined
          let followupPages = 0
          while (cursor && collected.length < target) {
            if (followupPages >= maxFollowupPages || seenCursors.has(cursor)) {
              throw new Error("Gallery refresh pagination could not restore the previously loaded window")
            }
            seenCursors.add(cursor)
            followupPages += 1
            // Fetch only the remaining window tail. Fetching a full final
            // page overshot the old window size (4,249 -> 4,250) and would
            // make the next cursor skip unseen results if we sliced locally.
            page = await fetchAssetPage(buildQuery(cursor), {
              cursor, limit: Math.min(GALLERY_PAGE_SIZE, target - collected.length),
              signal: controller.signal,
            })
            if (controller.signal.aborted) return
            for (const item of page.assets) {
              if (seenIds.has(item.id)) continue
              seenIds.add(item.id)
              collected.push(item)
            }
            cursor = page.nextCursor ?? undefined
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
        // A background refresh must not touch the selection while a
        // select-all is running or queued: applySelection bumps the selection
        // revision, which the select-all loop reads as "the user took over"
        // and silently drops the whole run. The commit replaces the selection
        // wholesale anyway; a real view switch is reset above, not here.
        const selectAllBusy = selectAllInFlightRef.current || pendingSelectAllRef.current !== null
        if (!selectAllBusy && (pruned.changed || (!pruned.selectedIds.length && !pruned.selected))) {
          const fallback = pruned.selected
            || (pruned.selectedIds.length ? pruned.selectedIds[0] : collected[0]?.id)
            || ""
          applySelection(pruned.selectedIds, fallback)
        }
        lastGoodProjectRef.current = project
        if (!firstPageOkRef.current) {
          firstPageOkRef.current = true
          readyGateRef.current?.markFirstPageOk()
        }
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
  // SSE stream setup (combined with sseConnectedRef tracking).
  useEffect(() => {
    // Reconnects refresh once too: a library-changed event sent while the
    // stream was down is never replayed.
    const resync = createResyncOnReconnect({ onResync: () => refreshNavigation() })
    const stream = new EventSource(`/api/library-events?project=${encodeURIComponent(project)}`)
    stream.addEventListener("open", () => {
      resync.handleOpen()
      if (sseOpenRef.current) return
      sseOpenRef.current = true
      readyGateRef.current?.markSseOpen()
    })
    stream.addEventListener("library-changed", () => resync.handleChange())
    return () => {
      resync.dispose()
      stream.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])
  // Version-consistency check: runs once at startup. On mismatch, the gallery
  // shows an error state and reportRendererReady is never called so the
  // main-process update machinery does not roll back the installed update.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const mismatch = await checkVersionConsistency(
        () => fetchHealth().then(d => d ?? {}),
        () => fetch("/build-identity.json", { cache: "no-store" }).then(r => r.ok ? r.json() : {}),
      )
      if (cancelled) return
      if (mismatch) {
        setLoadError(tr("界面与本地服务版本不一致。请退出旧版 GravityPort 后重新打开当前版本。"))
        return
      }
      if (!versionOkRef.current) {
        versionOkRef.current = true
        readyGateRef.current?.markVersionOk()
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Silent auto-check for updates every 24 hours.
  useEffect(() => {
    if (!shouldAutoCheckForUpdates(key => localStorage.getItem(key))) return
    const api = desktopAPI()
    if (!api?.checkForUpdates) return
    api.checkForUpdates(false).then(result => {
      recordUpdateCheck((key, value) => localStorage.setItem(key, value))
      if (result?.updateAvailable) {
        notify(fill(tr("发现新版本 v{version}"), { version: String(result.latestVersion ?? "").replace(/^v/i, "") }))
      }
    }).catch(() => {})
  }, [])
  // Listen for update download progress.
  useEffect(() => {
    const api = desktopAPI()
    if (!api?.onUpdateDownloadProgress) return
    api.onUpdateDownloadProgress(progress => {
      const pct = Number(progress?.percent)
      setUpdateState(current => current.phase === "downloading"
        ? { ...current, percent: Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0 }
        : current)
    })
  }, [])
  // Task 116 — Rename notice: fire once at first-screen render after the initial
  // load completes. Skips silently in browser (no electronAPI). Waits until the
  // gallery has actually rendered (loading=false) so we know whether another
  // alertdialog is already open; does not count as read if another modal is open.
  useEffect(() => {
    if (loading || !desktopAPI()?.getRenameNoticeState) return
    // The notice must fire after the first asset page resolves. Without a
    // loading check, the modal could open before any other dialog's state is
    // readable and the synchronous pre-check in maybeShowRenameNotice would be
    // too early.
    const api = desktopAPI()
    api?.getRenameNoticeState?.().then(notice => {
      if (notice?.shouldShow !== true) return
      // Guard against dialogs that opened while the async state request was pending.
      if (deletingRef.current || settingsRef.current || renameNoticeRef.current) return
      setRenameNoticeOpen(true)
    }).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])
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
    setGenerationHistory(null)
    setSimilarAssets([])
    fetchAssetVersions(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setVersions(history && history.versions.length > 1 ? history.versions : null)
    }).catch(() => {})
    fetchAssetGenerationHistory(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setGenerationHistory(history)
    }).catch(() => {})
    fetchSimilarAssets(project, selected, controller.signal).then(items => {
      if (!controller.signal.aborted) setSimilarAssets(items)
    }).catch(() => {})
    fetchAssetRecipes(project, selected, controller.signal).then(history => {
      if (controller.signal.aborted) return
      setRecipeHistory(history)
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
  const relationSelectionRef = useRef("")
  relationSelectionRef.current = `${project}\u0000${selected}`
  const mutateRelation = async (action: () => Promise<unknown>) => {
    if (relationBusy || !selected) return
    const identity = relationSelectionRef.current
    setRelationBusy(true)
    try {
      await action()
      if (identity !== relationSelectionRef.current) return
      const history = await fetchAssetGenerationHistory(project, selected)
      if (identity === relationSelectionRef.current) {
        setGenerationHistory(history)
        setRelationDrafts({})
        setNewRelation(null)
      }
    } catch (error) { if (identity === relationSelectionRef.current) notify(errorMessage(error)) }
    finally { setRelationBusy(false) }
  }
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
      setVisualModel(old => applyVisualPackProgress(
        old,
        progress && typeof progress.phase === "string" ? { phase: progress.phase, percent } : null,
      ))
    })
  }, [])
  const refreshVisualModel = () => {
    const api = desktopAPI()
    if (!api?.getVisualModelState) return Promise.resolve()
    return api.getVisualModelState(true)
      .then(state => setVisualModel(state as unknown as VisualModelStatus))
      .catch(() => {})
  }
  useEffect(() => {
    if (settings && settingTab === "模型") void refreshVisualModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, settingTab])
  assetsRef.current = assets
  const asset = assets.find((a) => a.id === selected) || assets[0]
  const currentTags = asset ? asset.tags : []
  const visible = assets
  const notify = (text: string) => setToast({ text: tr(text) })
  const notifyWithAction = (text: string, action: ToastAction, duration = 6000) =>
    setToast({ text: tr(text), action, duration })
  useEffect(() => {
    // An import in progress holds the toast on screen; the timer resumes with
    // the toast's own duration once the import settles. A newer toast replaces
    // the old one together with its timer (the effect re-runs on the object).
    if (!toast || importing) return
    const timer = setTimeout(() => setToast(null), toast.duration ?? 2600)
    return () => clearTimeout(timer)
  }, [toast, importing])
  // The same refresh the blank-area 刷新 menu entries run: a visible notice
  // plus a navigation-key reload of the current view.
  const refreshCurrentView = () => {
    notify(tr("正在刷新..."))
    refreshNavigation()
  }
  // Translate, then fill the named placeholders ({count}, {completed}, …).
  const fillNamed = (text: string, values: Record<string, string | number>) => fill(tr(text), values)
  // Batch outcomes share one toast grammar: any failure → the existing
  // 「…X 项，Y 项失败」 line; full success → single or counted text.
  const notifyBatchOutcome = (doneCount: number, failed: number, texts: { single: string; multi: string; partial: string }) => {
    if (failed) notify(tr(texts.partial).replace("X", String(doneCount)).replace("Y", String(failed)))
    else notify(doneCount > 1 ? fillNamed(texts.multi, { count: doneCount }) : texts.single)
  }
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
  // Above the threshold only masonry items near the viewport stay mounted.
  const windowingActive = assets.length > GALLERY_MOUNT_ALL_THRESHOLD
  const rowModelRef = useRef<{ key: string; model: MasonryModel } | null>(null)
  const updateGalleryWindowRef = useRef<() => void>(() => {})
  const galleryRowModel = (): MasonryModel | null => {
    const grid = gridRef.current
    if (!grid) return null
    const styles = getComputedStyle(grid)
    const tracks = styles.gridTemplateColumns.split(/\s+/).map(value => Number.parseFloat(value)).filter(Number.isFinite)
    const colWidth = tracks[0] || 0
    if (!(colWidth > 0)) return null
    const gap = Number.parseFloat(styles.columnGap) || 0
    const ratios = assets.map(a => a.height / a.width)
    const signature = galleryModelSignature(ratios, tracks.length, colWidth) + `|${gap}`
    if (rowModelRef.current?.key === signature) return rowModelRef.current.model
    const model = buildMasonryModel(ratios, tracks.length, colWidth, gap, { spanWide: true })
    rowModelRef.current = { key: signature, model }
    return model
  }
  const updateGalleryWindow = () => {
    const grid = gridRef.current
    if (!grid) return
    const model = galleryRowModel()
    if (!model) return
    if (!windowingActive || model.placements.length === 0) {
      if (model.placements.length === 0) {
        setGalleryWindow(old => old === null ? old : null)
        return
      }
      const full = model.placements.map((_, index) => index)
      setGalleryWindow(old => (
        old && old.model === model
          ? old : { model, mounted: full, hydrated: full }
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
    const mounted = locateMasonryWindow(model, scrollTop, grid.clientHeight,
      GALLERY_WINDOW_WARMUP_PX, GALLERY_MAX_MOUNTED_CARDS)
    const hydrated = locateMasonryWindow(model, scrollTop, grid.clientHeight,
      GALLERY_HYDRATE_WARMUP_PX, GALLERY_MAX_HYDRATED_CARDS)
    const same = (left: number[], right: number[]) =>
      left.length === right.length && left.every((value, index) => value === right[index])
    setGalleryWindow(old => (
      old && old.model === model
        && same(old.mounted, mounted) && same(old.hydrated, hydrated)
        ? old : { model, mounted, hydrated }
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
    // Mounted card coordinates are CSS container-relative, so native window
    // resizes cannot leave a stale absolute pixel width while Electron is
    // backgrounded. JS only recalculates shortest columns and virtual range.
    const onResize = () => updateGalleryWindowRef.current()
    const observer = new ResizeObserver(onResize)
    observer.observe(grid)
    window.addEventListener("resize", onResize)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", onResize)
    }
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
    setVersions(null); setGenerationHistory(null)
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
    setToast({ text: tr("正在全选") })
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
        setToast({ text: `${tr("正在全选")} ${collected.length}${page.total ? ` / ${page.total}` : "…"}` })
        morePages = Boolean(page.nextCursor)
        if (!morePages) break
        cursor = page.nextCursor ?? undefined
      }
      if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
        || selectionRevisionRef.current !== startRevision) return
      if (collected.length) {
        applySelection(collected, replaceSelection(collected, selectionRef.current.selected))
        setToast({ text: (morePages
          ? tr("结果过大，已选前 N 项")
          : tr("已选 N 项")).replace("N", String(collected.length)) })
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
        if (renameNoticeOpen) dismissRenameNotice()
        else if (deleting) setDeleting(false)
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
        // Same entry as the menu paste: inside a stack the cut assets move
        // into it, anywhere else they move back out to loose assets.
        pasteCut(stackId || null)
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, deleting, menu, assets, asset, stackId, active, language, selectedIds, selected, selectionIds])
  // Local file import through the staged pipeline (task 130): 40-file batches
  // of stage → create → cleanup, optional target stack and group, live
  // progress in the toast.
  const importFiles = async (files: File[], groupName?: string): Promise<string[]> => {
    if (!files.length) return []
    if (importing) { notify("正在导入，请稍候"); return [] }
    const supported = library?.supportedMediaExtensions
    const isSupported = (name: string) => {
      if (!supported || !supported.length) return true
      const lower = name.toLowerCase()
      return supported.some(ext => lower.endsWith(ext.toLowerCase()))
    }
    setImporting(true)
    try {
      const result = await runImport(files, {
        project,
        ...(stackId ? { stackId } : {}),
        ...(groupName ? { groupName } : {}),
        isSupported,
        onProgress: progress => {
          notify(fillNamed("正在导入 {completed}/{total} · 成功 {imported} · 失败 {failed}", {
            completed: progress.completed, total: progress.total, imported: progress.imported, failed: progress.failed,
          }))
        },
      })
      const firstReason = result.errors[0]?.reason
      if (!result.imported && !result.failed) notify("导入失败")
      else if (result.failed) notify(firstReason ? `${tr("部分素材导入失败")}：${firstReason}` : tr("部分素材导入失败"))
      else if (result.skipped) notify(fillNamed("有 {count} 个文件格式不支持，已跳过", { count: result.skipped }))
      else notify("导入完成")
      // The navigation key reloads the current view too (inside a stack, the
      // stack's members), without a 正在刷新 toast replacing the result above.
      refreshNavigation()
      return result.createdIds
    } catch (error) {
      notify(errorMessage(error))
      return []
    } finally {
      setImporting(false)
    }
  }
  // Drop entry: collectDroppedFiles must be invoked synchronously inside the
  // drop handler — dataTransfer.items die after the event tick — and the scan
  // promise is awaited afterwards. A folder over the scan limit surfaces as a
  // toast and nothing imports.
  const importDroppedFiles = (dataTransfer: DataTransfer | null, groupName?: string) => {
    const scan = collectDroppedFiles(dataTransfer, {
      onScanProgress: count => notify(fillNamed("正在扫描拖入的文件…已找到 {count} 个", { count })),
    })
    void scan
      .then(result => importFiles(result.files, groupName))
      .catch(error => notify(errorMessage(error)))
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
  }, [importing, library, active, project, stackId])
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
    // The undo restores against the project the deletion ran in, even if the
    // user has switched projects by the time the button is pressed.
    const originProject = asset?.project_id ?? project
    try {
      const outcome = await moveAssetsToTrash(originProject, ids)
      setDeleting(false)
      setPreview(false)
      if (!outcome.succeeded) {
        notify(outcome.firstError || tr("素材未能移至回收站"))
        return
      }
      // Only rows the server confirmed leave the grid; a partial chunk
      // failure keeps the rest selectable and says so.
      const movedIds = ids.filter(id => !outcome.failedIds.includes(id))
      const moved = new Set(movedIds)
      setAssets(old => old.filter(a => !moved.has(a.id)))
      applySelection([], moved.has(selectionRef.current.selected) ? "" : selectionRef.current.selected)
      // A partial failure still offers undo for the rows that did move.
      notifyWithAction(outcome.failed
        ? tr("已移至回收站 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
        : "素材已移至回收站", {
        label: tr("撤销"),
        run: () => { void undoTrashMove(originProject, movedIds) },
      })
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  // Undo for a move-to-trash: restore exactly the ids the server confirmed
  // moving, then reload whatever view is current (the user may have navigated
  // anywhere, or into another project, in the meantime).
  const undoTrashMove = async (originProject: string, ids: string[]) => {
    if (!ids.length) return
    try {
      const outcome = await restoreAssets(originProject, ids)
      refreshCurrentView()
      notifyBatchOutcome(ids.filter(id => !outcome.failedIds.includes(id)).length, outcome.failed, {
        single: "素材已恢复至素材库", multi: "已恢复 {count} 个素材", partial: "已恢复 X 项，Y 项失败",
      })
    } catch (error) { notify(errorMessage(error)) }
  }
  const requestDelete = () => {
    setMenu(null)
    if (skipConfirm) remove()
    else setDeleting(true)
  }
  // Restore the selection (or just the focused asset when nothing else is
  // selected) back into the library; confirmed rows leave the trash view.
  const restoreSelection = async () => {
    const ids = selectionIds.length ? [...selectionIds] : asset ? [asset.id] : []
    if (!ids.length) return
    try {
      const outcome = await restoreAssets(asset?.project_id ?? project, ids)
      setMenu(null)
      setPreview(false)
      notifyBatchOutcome(ids.filter(id => !outcome.failedIds.includes(id)).length, outcome.failed, {
        single: "素材已恢复至素材库", multi: "已恢复 {count} 个素材", partial: "已恢复 X 项，Y 项失败",
      })
      applySelection([], "")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  // Permanent delete from trash: the viewer closes first when it is showing a
  // victim, so a playing video file cannot hold the media open mid-delete.
  const confirmPermanentDelete = async () => {
    const ids = permanentDeleteIds || []
    setPermanentDeleteIds(null)
    if (!ids.length) return
    if (preview && asset && ids.includes(asset.id)) setPreview(false)
    try {
      const outcome = await permanentlyDeleteAssets(project, ids)
      if (!outcome.succeeded) { notify(outcome.firstError || "永久删除失败"); return }
      const deleted = new Set(ids.filter(id => !outcome.failedIds.includes(id)))
      setAssets(old => old.filter(a => !deleted.has(a.id)))
      applySelection([], deleted.has(selectionRef.current.selected) ? "" : selectionRef.current.selected)
      notifyBatchOutcome(deleted.size, outcome.failed, {
        single: "素材已永久删除", multi: "已永久删除 {count} 个素材", partial: "已永久删除 X 项，Y 项失败",
      })
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const confirmEmptyTrash = async () => {
    setEmptyTrashConfirm(false)
    try {
      const result = await emptyTrash(project)
      const failedCount = Array.isArray(result.failed) ? result.failed.length : 0
      if (result.partial) notify(fillNamed("{count} 个素材暂时无法永久删除，稍后会重试", { count: failedCount }))
      else notify("回收站已清空")
      applySelection([], "")
      setAssets([])
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

  // ===== Context menu: open helpers, shared paste, action dispatch =====

  // Translate the builder's Chinese source labels once at open time (and fill
  // the {count} placeholders the selection heading and trash labels carry);
  // the renderer just prints the labels.
  const translateMenuEntries = (entries: MenuEntry[], selectionCount: number): MenuEntry[] =>
    entries.map(entry => {
      if (entry.kind === "item") {
        return { ...entry, label: fillNamed(entry.label, { count: selectionCount }), submenu: entry.submenu ? translateMenuEntries(entry.submenu, selectionCount) : undefined }
      }
      if (entry.kind === "heading") return { ...entry, label: fillNamed(entry.label, { count: selectionCount }) }
      return entry
    })

  const menuGroups = () => (navigation?.groups || []).map(item => ({ name: item.name, color: item.color }))
  const isMacPlatform = () => navigator.platform.startsWith("Mac")

  // Right-clicking outside the multi-selection targets the clicked card
  // alone; inside it, the whole selection stays the action target.
  const openAssetMenu = (clicked: MosaAsset, x: number, y: number) => {
    const ids = selectedIds.includes(clicked.id) ? [...batchIds] : [clicked.id]
    const loaded = assets.filter(entry => ids.includes(entry.id))
    const ctx: MenuContext = {
      target: "asset",
      scope: active === "回收站" ? "trash" : "all",
      selectionCount: ids.length,
      selectionHasStacks: loaded.some(entry => entry.stack),
      anyGrouped: ids.length > 1
        ? loaded.some(entry => Boolean(entry.group)) || loaded.length !== ids.length
        : Boolean(clicked.group),
      favorite: Boolean(clicked.favorite),
      insideStackId: stackId || null,
      cutActive: cutIdsRef.current.length > 0,
      groups: menuGroups(),
      pageTotal: pageTotal ?? assets.length,
      isMac: isMacPlatform(),
      trashCount: navigation?.trash ?? 0,
    }
    const entries = translateMenuEntries(buildContextMenu(ctx), ctx.selectionCount)
    setMenu({ x, y, entries, target: "asset", selectionCount: ctx.selectionCount, stackId: "", stackName: "", stackCount: 0 })
  }

  // Right-clicking a stack card never changes the selection: the menu acts on
  // this stack alone, so its target rides along in the menu state.
  const openStackMenu = (stack: NonNullable<MosaAsset["stack"]>, cardName: string, x: number, y: number) => {
    const ctx: MenuContext = {
      target: "stack",
      scope: "all",
      selectionCount: 0,
      selectionHasStacks: false,
      anyGrouped: false,
      favorite: false,
      insideStackId: null,
      cutActive: cutIdsRef.current.length > 0,
      groups: menuGroups(),
      pageTotal: assets.length,
      isMac: isMacPlatform(),
      trashCount: navigation?.trash ?? 0,
    }
    const entries = translateMenuEntries(buildContextMenu(ctx), 0)
    setMenu({ x, y, entries, target: "stack", selectionCount: 0, stackId: stack.id, stackName: stack.name || cardName, stackCount: stack.count })
  }

  const openBlankMenu = (x: number, y: number) => {
    const inStack = Boolean(stackId)
    const ctx: MenuContext = {
      target: inStack ? "stack-blank" : "gallery-blank",
      scope: active === "回收站" ? "trash" : "all",
      selectionCount: 0,
      selectionHasStacks: false,
      anyGrouped: false,
      favorite: false,
      insideStackId: stackId || null,
      cutActive: cutIdsRef.current.length > 0,
      groups: menuGroups(),
      pageTotal: pageTotal ?? assets.length,
      isMac: isMacPlatform(),
      trashCount: navigation?.trash ?? 0,
    }
    const entries = translateMenuEntries(buildContextMenu(ctx), 0)
    // An empty builder result (stack surfaces inside the trash) opens nothing.
    if (!entries.length) return
    setMenu({ x, y, entries, target: ctx.target, selectionCount: 0, stackId, stackName, stackCount: assets.length })
  }

  // Shared paste: ⌘V and both menu paste entries move the cut ids into the
  // target stack, or back out to loose assets when the target is null.
  const pasteCut = (targetStackId: string | null) => {
    const ids = [...new Set(cutIdsRef.current)]
    if (!ids.length) return
    cutIdsRef.current = []
    moveAssetsToStack(project, ids, targetStackId)
      .then(outcome => {
        if (!outcome.succeeded) { notify(outcome.firstError || tr("粘贴失败")); return }
        notify(outcome.failed
          ? tr("已粘贴 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
          : targetStackId ? tr("已粘贴到堆叠") : tr("已移出堆叠"))
        refreshNavigation()
      })
      .catch(error => notify(errorMessage(error)))
  }

  // Batch group assignment for the asset menu (add via submenu, remove, and
  // the trash menu's flat add-to-group, which still needs the sidebar group).
  const assignSelectionToGroup = (name: string) => {
    if (!asset) return
    setAssetsGroup(asset.project_id, [...batchIds], name)
      .then(outcome => {
        if (!outcome.succeeded) { notify(outcome.firstError || tr(name ? "添加分组失败" : "移除分组失败")); return }
        setSelectedIds([])
        notify(outcome.failed
          ? (name
              ? tr("已加入分组 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
              : tr("已从分组移除 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
          : name ? tr("已添加到分组") : tr("已从分组移除"))
        refreshNavigation()
      })
      .catch(error => notify(errorMessage(error)))
  }

  const runMenuAction = (id: string) => {
    const target = menu
    setMenu(null)
    if (!target) return
    const ids = [...batchIds]
    // Asset menu
    if (id === "open-viewer") setPreview(true)
    else if (id === "show-in-library") showInLibrary()
    else if (id === "copy-image") void copyImage()
    else if (id === "cut") {
      cutIdsRef.current = ids
      notify("已剪切")
    }
    else if (id === "copy-prompt") {
      if (!asset?.prompt) { notify(tr("无提示词记录")); return }
      writeText(asset.prompt).then(() => notify(`${tr("复制提示词")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
    }
    else if (id === "copy-path") {
      if (!asset) return
      writeText(asset.image_path || asset.image_url).then(() => notify(`${tr("复制路径")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
    }
    else if (id === "toggle-favorite") {
      if (ids.length > 1 && asset) {
        setAssetsFavorite(asset.project_id, ids, !asset.favorite)
          .then(outcome => {
            if (!outcome.succeeded) { notify(outcome.firstError || tr("收藏失败")); return }
            setSelectedIds([])
            if (outcome.failed) {
              notify(tr("已收藏 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
            }
            refreshNavigation()
          })
          .catch(error => notify(errorMessage(error)))
      } else void toggleFavorite()
    }
    else if (id === "add-to-group") {
      // The trash menu keeps the old flat entry: it still needs the group
      // picked in the sidebar.
      if (!group) { notify(tr("请先在左侧选择或新建分组")); return }
      assignSelectionToGroup(group)
    }
    else if (id === "add-to-group:create" || id === "stack-add-to-group:create") {
      // Must be matched before the add-to-group: prefix or the ":create"
      // suffix would be taken for a literal group name.
      const forStack = id.startsWith("stack-")
      setGroupCreateError("")
      setGroupCreateWithSelection({
        target: forStack ? "stack" : "asset",
        targetStackId: forStack ? target.stackId : undefined,
        draft: `新分组 ${(navigation?.groups.length ?? 0) + 1}`,
      })
    }
    else if (id.startsWith("add-to-group:")) assignSelectionToGroup(id.slice("add-to-group:".length))
    else if (id === "remove-from-group") assignSelectionToGroup("")
    else if (id === "export") exportAsset()
    else if (id === "restore-selection") void restoreSelection()
    else if (id === "permanent-delete") setPermanentDeleteIds(ids)
    else if (id === "empty-trash") {
      if ((navigation?.trash ?? 0) > 0) setEmptyTrashConfirm(true)
    }
    else if (id === "move-to-trash") requestDelete()
    else if (id === "remove-from-stack") {
      if (!stackId) return
      removeAssetsFromStack(project, stackId, ids)
        .then(() => {
          notify(fill(tr("已从堆叠移出 {count} 项素材"), { count: ids.length }))
          applySelection([], "")
          refreshNavigation()
        })
        .catch(error => notify(errorMessage(error)))
    }
    else if (id === "stack-selected") {
      createStack(project, ids, asset?.id || ids[0] || "")
        .then(() => {
          notify(fill(tr("已堆叠 {count} 项素材"), { count: ids.length }))
          applySelection([], "")
          refreshNavigation()
        })
        .catch(error => notify(errorMessage(error)))
    }
    // Stack menu — every action reads the stack the menu was opened on.
    else if (id === "open-stack") goTo({ stackId: target.stackId, stackName: target.stackName })
    else if (id === "paste-into-stack") pasteCut(target.stackId)
    else if (id.startsWith("stack-add-to-group:")) {
      const groupName = id.slice("stack-add-to-group:".length)
      assignStackToGroup(project, target.stackId, groupName)
        .then(() => {
          notify(fill(tr("堆叠已移动到「{group}」"), { group: groupName }))
          refreshNavigation()
        })
        .catch(error => notify(errorMessage(error)))
    }
    else if (id === "stack-remove-from-group") {
      assignStackToGroup(project, target.stackId, "")
        .then(() => {
          notify(tr("堆叠已移出分组"))
          refreshNavigation()
        })
        .catch(error => notify(errorMessage(error)))
    }
    else if (id === "rename-stack") setStackRename({ stackId: target.stackId, initialName: target.stackName, draft: target.stackName })
    else if (id === "dissolve-stack") setStackDissolveConfirm({ stackId: target.stackId, stackCount: target.stackCount })
    else if (id === "stack-move-to-trash") setStackTrashConfirm({ stackId: target.stackId, stackCount: target.stackCount })
    // Blank-area menus
    else if (id === "back-to-library") goTo({ stackId: "", stackName: "" })
    else if (id === "paste") pasteCut(target.target === "stack-blank" ? target.stackId : null)
    else if (id === "create-group") createNamedGroup()
    else if (id === "select-all") void selectAllAcrossPages()
    else if (id === "refresh" || id === "refresh-library") refreshCurrentView()
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
      void refreshVisualModel()
    }
  }
  const runVisualModelAction = async (action: VisualModelAction) => {
    const api = desktopAPI()
    if (!api) return
    try {
      if (action === "install" || action === "update") {
        await installModelPack()
        return
      }
      if (action === "cancel") await api.cancelVisualPackInstall?.()
      else if (action === "enable" || action === "disable") {
        const state = await api.setVisualModelEnabled?.(action === "enable")
        if (state) setVisualModel(state as unknown as VisualModelStatus)
        refreshNavigation()
      } else if (action === "remove") {
        const result = await api.removeVisualPack?.() as { ok?: boolean; cancelled?: boolean } | undefined
        if (result?.ok) notify(tr("视觉能力包已删除，GravityPort 正在重启"))
      }
    } catch (error) {
      notify(String((error as Error)?.message || tr("视觉能力包删除失败")))
    } finally {
      void refreshVisualModel()
    }
  }
  const checkForUpdates = async () => {
    const api = desktopAPI()
    if (!api?.checkForUpdates) { notify(tr("网页版请访问官网获取最新版本")); return }
    if (updateState.phase === "checking") return
    setUpdateState({ phase: "checking" })
    try {
      const result = await api.checkForUpdates(true)
      recordUpdateCheck((key, value) => localStorage.setItem(key, value))
      const state = mapUpdateResult(result ?? {})
      setUpdateState(state)
      if (state.phase === "current") {
        notify(tr("已是最新版本"))
      } else if (state.phase === "available") {
        notify(fill(tr("发现新版本 v{version}"), { version: state.latestVersion }))
      } else if (state.phase === "unavailable") {
        notify(tr("请先把 App 拖进『应用程序』文件夹再更新"))
      } else if (state.phase === "error") {
        notify(tr("暂时无法检查更新"))
      }
    } catch (error) {
      setUpdateState({ phase: "error" })
      notify(String((error as Error)?.message || tr("暂时无法检查更新")))
    }
  }
  const downloadAndInstallUpdate = async () => {
    const api = desktopAPI()
    if (!api?.downloadAndInstallUpdate) return
    if (updateState.phase === "downloading") return
    if (updateState.phase !== "available") return
    setUpdateState({ phase: "downloading", percent: 0, latestVersion: updateState.latestVersion, publishedAt: updateState.publishedAt, canInstallInApp: updateState.canInstallInApp })
    try {
      await api.downloadAndInstallUpdate()
    } catch (error) {
      setUpdateState(current => current.phase === "downloading"
        ? { phase: "available", latestVersion: current.latestVersion || "", publishedAt: current.publishedAt || "", canInstallInApp: current.canInstallInApp !== false }
        : current)
      notify(tr("更新失败，请稍后重试"))
    }
  }
  const cancelUpdateDownload = () => {
    desktopAPI()?.cancelUpdateDownload?.()
    setUpdateState(current => current.phase === "downloading"
      ? { phase: "available", latestVersion: current.latestVersion || "", publishedAt: current.publishedAt || "", canInstallInApp: current.canInstallInApp !== false }
      : current)
  }
  const openDownloadPage = () => {
    desktopAPI()?.openDownloadPage?.().then(result => {
      if (!result?.ok) notify(tr("暂时无法检查更新"))
    }).catch(() => notify(tr("暂时无法检查更新")))
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
  const shownPrompt = promptVariant === 2 ? asset?.prompt2 || "" : asset?.prompt || ""
  const relatedAssets = similarAssets.slice(0, expandedRelated ? 6 : 2)
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
      className={`app ${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : ""} ${nativeChromeClass}`}
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
              ? SMART_SOURCE_GROUPS.map(([source, name]) => ({
                  id: `source:${source}`, name,
                  count: navigation?.sourceTypes.find(entry => entry[0] === source)?.[1] ?? 0,
                })).filter(entry => entry.count > 0)
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
                onContextMenu={event => {
                  if (section !== 1) return
                  event.preventDefault()
                  setGroupMenu({ name: g.name, x: event.clientX, y: event.clientY })
                }}
                onDragOver={event => {
                  if (g.id.startsWith("group:") && !preview && !settings) event.preventDefault()
                }}
                onDrop={event => {
                  if (!g.id.startsWith("group:") || preview || settings) return
                  event.preventDefault()
                  importDroppedFiles(event.dataTransfer, g.name)
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
      {groupMenu && <>
        <div className="group-menu-dismiss" onClick={() => setGroupMenu(null)} aria-hidden="true" />
        <div className="group-manage-menu" role="menu" style={{ left: Math.min(groupMenu.x, window.innerWidth - 220), top: Math.min(groupMenu.y, window.innerHeight - 310) }}>
          <strong>{groupMenu.name}</strong>
          <button role="menuitem" onClick={() => { setGroupRename({ original: groupMenu.name, draft: groupMenu.name }); setGroupMenu(null) }}>{tr("重命名分组")}</button>
          {([[-1, "上移分组"], [1, "下移分组"]] as const).map(([step, label]) => <button role="menuitem" key={label} onClick={() => {
            const names = (navigation?.groups || []).map(item => item.name)
            const index = names.indexOf(groupMenu.name)
            const target = index + step
            setGroupMenu(null)
            if (index < 0 || target < 0 || target >= names.length) return
            ;[names[index], names[target]] = [names[target], names[index]]
            reorderGroups(project, names).then(refreshNavigation).catch(error => notify(errorMessage(error)))
          }}>{tr(label)}</button>)}
          <div className="group-color-choices" role="group" aria-label={tr("分组颜色")}>
            {["#E06C75", "#D19A66", "#98C379", "#61AFEF", "#C678DD", "#56B6C2"].map(color => <button key={color} style={{ background: color }} aria-label={`${tr("分组颜色")} ${color}`} onClick={() => {
              recolorGroup(project, groupMenu.name, color).then(refreshNavigation).catch(error => notify(errorMessage(error)))
              setGroupMenu(null)
            }} />)}
          </div>
          <button role="menuitem" onClick={() => {
            const name = groupMenu.name
            setGroupMenu(null)
            fetchGroupStats(project, name).then(result => setGroupStats({ name, values: result.stats })).catch(error => notify(errorMessage(error)))
          }}>{tr("分组统计")}</button>
          <button role="menuitem" disabled={Boolean(exportingGroup)} onClick={() => {
            const name = groupMenu.name
            const originProject = project
            setGroupMenu(null)
            setExportingGroup(name)
            fetchRawGroupAssets(originProject, name).then(records => {
              const payload = { exportedAt: new Date().toISOString(), project: originProject, group: name,
                assets: records.map(sanitizeAssetForExport) }
              const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
              try {
                const link = document.createElement("a")
                link.href = url
                link.download = `mosa-group-${name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group"}.json`
                document.body.appendChild(link)
                link.click()
                link.remove()
              } finally { window.setTimeout(() => URL.revokeObjectURL(url), 30_000) }
            }).catch(error => notify(errorMessage(error))).finally(() => setExportingGroup(""))
          }}>{tr("导出分组")}</button>
          {navigation?.groups.some(item => item.name !== groupMenu.name) && <button role="menuitem" onClick={() => {
            const other = navigation?.groups.find(item => item.name !== groupMenu.name)
            if (other) setGroupMerge({ source: groupMenu.name, target: other.name })
            setGroupMenu(null)
          }}>{tr("合并分组")}</button>}
          <button role="menuitem" onClick={() => { setGroupDeleteConfirm(groupMenu.name); setGroupMenu(null) }}>{tr("删除分组")}</button>
        </div>
      </>}
      {(groupRename || groupDeleteConfirm || groupMerge || groupStats) && <div className="group-dialog-backdrop" role="presentation">
        <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("分组管理")}>
          {groupRename && <form onSubmit={event => {
            event.preventDefault()
            const name = groupRename.draft.trim()
            if (!name || name === groupRename.original) { setGroupRename(null); return }
            renameGroup(project, groupRename.original, name).then(() => {
              if (active === `group:${groupRename.original}`) goTo({ active: `group:${name}` })
              refreshNavigation(); setGroupRename(null)
            }).catch(error => notify(errorMessage(error)))
          }}><h3>{tr("重命名分组")}</h3><input autoFocus value={groupRename.draft} maxLength={80} onChange={event => setGroupRename(old => old ? { ...old, draft: event.target.value } : old)} /><div className="group-dialog-actions"><button type="button" onClick={() => setGroupRename(null)}>{tr("取消")}</button><button type="submit">{tr("保存")}</button></div></form>}
          {groupDeleteConfirm && <><h3>{tr("删除分组")}</h3><p>{tr("仅删除分组，保留其中全部素材。")}</p><div className="group-dialog-actions"><button onClick={() => setGroupDeleteConfirm(null)}>{tr("取消")}</button><button onClick={() => {
            const name = groupDeleteConfirm
            deleteGroupKeepingAssets(project, name).then(() => {
              if (active === `group:${name}`) goTo({ active: "所有素材" })
              refreshNavigation(); setGroupDeleteConfirm(null)
            }).catch(error => notify(errorMessage(error)))
          }}>{tr("删除分组")}</button></div></>}
          {groupMerge && <><h3>{tr("合并分组")}</h3><p>{groupMerge.source} →</p><select value={groupMerge.target} onChange={event => setGroupMerge(old => old ? { ...old, target: event.target.value } : old)}>{navigation?.groups.filter(item => item.name !== groupMerge.source).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select><div className="group-dialog-actions"><button onClick={() => setGroupMerge(null)}>{tr("取消")}</button><button onClick={() => {
            const { source, target } = groupMerge
            mergeGroups(project, source, target).then(() => {
              if (active === `group:${source}`) goTo({ active: `group:${target}` })
              refreshNavigation(); setGroupMerge(null)
            }).catch(error => notify(errorMessage(error)))
          }}>{tr("确认合并")}</button></div></>}
          {groupStats && (() => {
            const described = describeGroupStats(groupStats.values)
            return <>
              <h3>{tr("分组统计")} · {groupStats.name}</h3>
              <div className="group-stats-data">
                {described.overview.map(item => <p key={item.label}>{tr(item.label)}: {item.value}</p>)}
                {described.facets.map(facet => <div key={facet.title} className="group-stats-facet">
                  <strong>{tr(facet.title)}</strong>
                  {facet.entries.length
                    ? facet.entries.map(entry => <p key={entry.name}>{entry.name}: {entry.count}</p>)
                    : <p>{tr(facet.emptyText)}</p>}
                </div>)}
              </div>
              <button onClick={() => setGroupStats(null)}>{tr("关闭")}</button>
            </>
          })()}
        </div>
      </div>}

      {/* Stack rename dialog */}
      {stackRename && (
        <div className="group-dialog-backdrop" role="presentation" onClick={() => setStackRename(null)}>
          <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("重命名堆叠")}>
            <form onSubmit={event => {
              event.preventDefault()
              const name = stackRename.draft.trim()
              if (!name) return
              renameStack(project, stackRename.stackId, name)
                .then(() => {
                  notify(tr("堆叠已重命名"))
                  setAssets(old => old.map(a => a.stack && a.stack.id === stackRename.stackId ? { ...a, stack: { ...a.stack, name } } : a))
                  if (stackId === stackRename.stackId) setStackName(name)
                  setStackRename(null)
                  refreshNavigation()
                })
                .catch(error => notify(errorMessage(error)))
            }}>
              <h3>{tr("重命名堆叠")}</h3>
              <input autoFocus value={stackRename.draft} maxLength={80} onChange={event => setStackRename(old => old ? { ...old, draft: event.target.value } : old)} />
              <div className="group-dialog-actions">
                <button type="button" onClick={() => setStackRename(null)}>{tr("取消")}</button>
                <button type="submit">{tr("保存")}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stack dissolve confirmation */}
      {stackDissolveConfirm && (
        <div className="modal-layer delete-layer" onClick={() => setStackDissolveConfirm(null)}>
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon"><Icon name="layers" size={26} /></div>
            <h3>{tr("解散这个堆叠？")}</h3>
            <p>{tr("仅解除素材之间的堆叠关系，不会删除或归档任何素材。")}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setStackDissolveConfirm(null)}>{tr("取消")}</button>
              <button className="primary-button" onClick={() => {
                const target = stackDissolveConfirm
                setStackDissolveConfirm(null)
                dissolveStack(project, target.stackId)
                  .then(result => {
                    // The server echoes the members it released; the toast
                    // counts those, not the stale menu-time count.
                    notify(fill(tr("已解散堆叠 · {count} 个素材已恢复为独立素材"), { count: result.assetIds.length }))
                    setAssets(old => old.map(a => a.stack && a.stack.id === target.stackId ? { ...a, stack: null } : a))
                    if (stackId === target.stackId) goTo({ stackId: "", stackName: "" })
                    refreshNavigation()
                  })
                  .catch(error => notify(errorMessage(error)))
              }}>{tr("解散堆叠")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Stack move-to-trash confirmation — a stack always confirms, the
      "不再提醒" suppression only ever covered plain assets. */}
      {stackTrashConfirm && (
        <div className="modal-layer delete-layer" onClick={() => setStackTrashConfirm(null)}>
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon"><Icon name="trash" size={26} /></div>
            <h3>{tr("将这个堆叠移到回收站？")}</h3>
            <p>{fill(tr("其中的 {count} 个素材也会一起移到回收站。你可以之后从回收站恢复。"), { count: stackTrashConfirm.stackCount })}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setStackTrashConfirm(null)}>{tr("取消")}</button>
              <button className="primary-button" onClick={() => {
                const target = stackTrashConfirm
                setStackTrashConfirm(null)
                trashStack(project, target.stackId)
                  .then(outcome => {
                    if (outcome.failed) {
                      notify(tr("已移至回收站 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
                    } else if (outcome.succeeded) {
                      notify(fill(tr("堆叠已移到回收站，共 {count} 个素材"), { count: outcome.succeeded }))
                    }
                    const failedIds = new Set(outcome.failedIds)
                    setAssets(old => old.filter(a => !(a.stack && a.stack.id === target.stackId && !failedIds.has(a.id))))
                    if (stackId === target.stackId) goTo({ stackId: "", stackName: "" })
                    refreshNavigation()
                  })
                  .catch(error => notify(errorMessage(error)))
              }}>{tr("移至回收站")}</button>
            </div>
          </div>
        </div>
      )}

      {/* Create a group and move the menu's target into it. A server rejection
      (duplicate name) shows inside the dialog and keeps it open. */}
      {groupCreateWithSelection && (
        <div className="group-dialog-backdrop" role="presentation" onClick={() => setGroupCreateWithSelection(null)}>
          <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("新建分组并移入")}>
            <form onSubmit={event => {
              event.preventDefault()
              const name = groupCreateWithSelection.draft.trim()
              if (!name) return
              const target = groupCreateWithSelection
              createGroup(project, name)
                .then(() => {
                  if (target.target === "stack" && target.targetStackId) return assignStackToGroup(project, target.targetStackId, name).then(() => {})
                  return setAssetsGroup(project, [...batchIds], name).then(outcome => {
                    if (!outcome.succeeded) throw new Error(outcome.firstError || tr("添加分组失败"))
                  })
                })
                .then(() => {
                  notify(target.target === "stack"
                    ? fill(tr("堆叠已移动到「{group}」"), { group: name })
                    : tr("已添加到分组"))
                  if (target.target === "asset") setSelectedIds([])
                  setGroupCreateWithSelection(null)
                  refreshNavigation()
                })
                .catch(error => setGroupCreateError(errorMessage(error)))
            }}>
              <h3>{tr("新建分组并移入")}</h3>
              <input autoFocus value={groupCreateWithSelection.draft} maxLength={80} onChange={event => {
                setGroupCreateError("")
                setGroupCreateWithSelection(old => old ? { ...old, draft: event.target.value } : old)
              }} />
              {groupCreateError && <p className="group-dialog-error" role="alert">{groupCreateError}</p>}
              <div className="group-dialog-actions">
                <button type="button" onClick={() => setGroupCreateWithSelection(null)}>{tr("取消")}</button>
                <button type="submit">{tr("保存")}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <main
        className={`workspace ${preview ? "preview-open" : ""}`}
        onDragOver={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
        }}
        onDrop={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
          importDroppedFiles(event.dataTransfer)
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
                {active === "回收站" && (navigation?.trash ?? 0) > 0 && (
                  <button className="toolbar-empty-trash" onClick={() => setEmptyTrashConfirm(true)}>
                    <Icon name="trash" size={12} />
                    {tr("清空回收站")}
                  </button>
                )}
                <ToolbarSelect label={tr("素材类型")} value={assetType} onChange={setAssetType} options={[{ value: "all", label: tr("全部类型") }, { value: "image", label: tr("图片") }, { value: "video", label: tr("视频") }]} />
                <ToolbarSelect label={tr("排序")} value={sortOrder} onChange={setSortOrder} options={[{ value: "newest", label: tr("最新优先") }, { value: "name", label: tr("名称排序") }]} />
                <ColumnControl value={columns} onChange={value => { setColumns(value); writeStoredColumns(columnsStorage(), value) }} language={language} />
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
          <ImageViewer key={asset?.id} width={asset?.width || 768} height={asset?.height || 1170} src={asset?.preview_url || asset?.image_url} isVideo={asset?.mediaKind === "video"} language={language} disabled={settings || deleting || !!menu} onNavigate={navigateAsset} onContextMenu={(x, y) => { if (asset) openAssetMenu(asset, x, y) }} message={toast?.text ?? ""} />
        ) : (
          <div
            ref={gridRef}
            className="asset-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
            data-loaded-assets={assets.length}
            onPointerDown={onGridPointerDown}
            onContextMenu={(e) => {
              // Blank-area menu: cards handle their own contextmenu, and the
              // viewer and the settings dialog suppress it. In the trash the
              // blank menu offers select-all / empty-trash instead.
              if ((e.target as HTMLElement).closest(".asset-card") || preview || settings) return
              e.preventDefault()
              openBlankMenu(e.clientX, e.clientY)
            }}
          >
            {(() => {
              const model = galleryWindow?.model ?? null
              // Sorting, changing project, or reloading a page can replace
              // the asset list BEFORE useLayoutEffect recomputes the masonry
              // window. Old mounted indexes then address missing assets and
              // crash React, leaving #root completely empty. Never render a
              // window belonging to a different loaded list size.
              const win = model && model.placements.length === assets.length ? galleryWindow : null
              if (!model || !win) {
                if (assets.length > GALLERY_MOUNT_ALL_THRESHOLD) {
                  return <div className="gallery-window-spacer" style={{ gridColumn: "1 / -1", minHeight: "100%" }} aria-hidden="true" />
                }
                return assets.map((a) => (
                  <button
                    key={a.id}
                    data-asset-id={a.id}
                    aria-label={`${tr("查看素材")} ${a.stack ? `${tr("堆叠")} ${a.stack.name}` : a.name}`}
                    className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""}`}
                    style={{ aspectRatio: `${a.width} / ${a.height}` }}
                    onClick={(event) => {
                      // Stacks behave like plain cards here: one click
                      // selects (the inspector shows the cover). The second
                      // press of a double-click must not re-run selection —
                      // the dblclick handler owns entering the stack.
                      if (event.detail > 1) return
                      selectCard(a.id, event)
                    }}
                    onDoubleClick={() => {
                      if (a.stack) {
                        goTo({ stackId: a.stack.id, stackName: a.stack.name || a.name })
                        applySelection([], "")
                        return
                      }
                      focusAsset(a.id)
                      setPreview(true)
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // Right-clicking outside the multi-selection re-targets the
                      // context menu to the clicked card; inside it, the whole
                      // selection stays the action target. Stack cards follow the
                      // same grammar — the stack menu still acts on that stack
                      // alone through its own target. Trash keeps its restore
                      // menu, but stack cards stay inert there.
                      if (a.stack && active === "回收站") return
                      if (!selectedIds.includes(a.id)) applySelection([], a.id)
                      else focusAsset(a.id)
                      if (a.stack) {
                        openStackMenu(a.stack, a.name, e.clientX, e.clientY)
                        return
                      }
                      openAssetMenu(a, e.clientX, e.clientY)
                    }}
                  >
                    {a.thumbnail_url ? <img className="black-image" src={a.thumbnail_url} srcSet={galleryImageSrcSet(a) || undefined} sizes="240px" alt="" loading="lazy" decoding="async" /> : <div className="black-image" />}
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
                    {active === "回收站" && a.deleted_at && (
                      <span className="trash-countdown">{fillNamed("{count} 天后删除", { count: trashRemainingDays(a.deleted_at, Date.now()) })}</span>
                    )}
                    {cardInfo && <span className="card-name">{a.stack ? a.stack.name || a.name : a.name}</span>}
                  </button>
                ))
              }
              const hydrated = new Set(win.hydrated)
              const placementStyle = (index: number): React.CSSProperties => {
                return { position: "absolute", ...masonryCardCss(model, index),
                  aspectRatio: `${assets[index].width} / ${assets[index].height}` }
              }
              const card = (a: MosaAsset, globalIndex: number) => (
                <button
                  key={a.id}
                  data-asset-id={a.id}
                  aria-label={`${tr("查看素材")} ${a.stack ? `${tr("堆叠")} ${a.stack.name}` : a.name}`}
                  className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""}`}
                  style={placementStyle(globalIndex)}
                  onClick={(event) => {
                    // Stacks behave like plain cards here: one click
                    // selects (the inspector shows the cover). The second
                    // press of a double-click must not re-run selection —
                    // the dblclick handler owns entering the stack.
                    if (event.detail > 1) return
                    selectCard(a.id, event)
                  }}
                  onDoubleClick={() => {
                    if (a.stack) {
                      goTo({ stackId: a.stack.id, stackName: a.stack.name || a.name })
                      applySelection([], "")
                      return
                    }
                    focusAsset(a.id)
                    setPreview(true)
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    // Right-clicking outside the multi-selection re-targets the
                    // context menu to the clicked card; inside it, the whole
                    // selection stays the action target. Stack cards follow the
                    // same grammar — the stack menu still acts on that stack
                    // alone through its own target. Trash keeps its restore
                    // menu, but stack cards stay inert there.
                    if (a.stack && active === "回收站") return
                    if (!selectedIds.includes(a.id)) applySelection([], a.id)
                    else focusAsset(a.id)
                    if (a.stack) {
                      openStackMenu(a.stack, a.name, e.clientX, e.clientY)
                      return
                    }
                    openAssetMenu(a, e.clientX, e.clientY)
                    }}
                >
                  {a.thumbnail_url ? <img className="black-image" src={a.thumbnail_url} srcSet={galleryImageSrcSet(a) || undefined} sizes={galleryImageSizes(model.placements[globalIndex]?.width ?? model.columnWidth)} alt="" loading="lazy" decoding="async" /> : <div className="black-image" />}
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
                  {active === "回收站" && a.deleted_at && (
                    <span className="trash-countdown">{fillNamed("{count} 天后删除", { count: trashRemainingDays(a.deleted_at, Date.now()) })}</span>
                  )}
                  {cardInfo && <span className="card-name">{a.stack ? a.stack.name || a.name : a.name}</span>}
                </button>
              )
              return <>
                <div className="gallery-window-spacer" style={{ gridColumn: "1 / -1", height: masonryExtentCss(model) }} aria-hidden="true" />
                {win.mounted.map(index => hydrated.has(index)
                  ? card(assets[index], index)
                  : (
                    <div
                      key={assets[index].id}
                      className="asset-card asset-card-virtual-placeholder"
                      data-asset-id={assets[index].id}
                      aria-hidden="true"
                      style={placementStyle(index)}
                    />
                  ))}
              </>
            })()}
            {loading && <div className="empty-state" role="status">{tr("加载中")}</div>}
            {!loading && loadError && <div className="empty-state" role="alert"><Icon name="info" size={30} /><p>{loadError}</p><button onClick={refreshNavigation}>{tr("重试")}</button></div>}
            {!loading && !loadError && visible.length === 0 && (
              (() => {
                const empty = deriveEmptyState({
                  loading, error: loadError, visibleCount: visible.length, active, query: debouncedQuery,
                  assetType, libraryTotal: navigation?.total, insideStack: Boolean(stackId),
                })
                if (!empty) return null
                const icon = empty.kind === "trash-empty" ? "trash"
                  : empty.kind === "favorites-empty" ? "heart"
                  : empty.kind === "library-empty" ? "plus"
                  : empty.kind === "no-results" ? "search" : "folder"
                return (
                  <div className="empty-state">
                    <Icon name={icon} size={30} />
                    <p>{tr(empty.title)}</p>
                    <small>{tr(empty.description)}</small>
                    {empty.clearAction && <button className="neutral-button" onClick={() => goTo({ query: "", assetType: "all" })}>{tr("清除筛选")}</button>}
                  </div>
                )
              })()
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
              <span className="tag-chip" key={t}>
                <span>{t}</span>
                <button aria-label={`${tr("移除标签")} ${t}`} title={`${tr("移除标签")} ${t}`}
                  onClick={() => {
                    const remaining = currentTags.filter(tag => tag !== t)
                    updateAssetMetadata(asset.project_id, asset.id, { tags: remaining })
                      .then(updated => setAssets(old => old.map(item => item.id === updated.id ? mergeAssetDetail(item, updated) : item)))
                      .catch(error => notify(errorMessage(error)))
                  }}>×</button>
              </span>
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
              <span className="prompt-tabs" role="group" aria-label={tr("提示词")}>
                {asset.prompt2 ? <>
                  <button className={promptVariant === 1 ? "active" : ""} aria-pressed={promptVariant === 1} onClick={() => { setPromptVariant(1); setExpandedPrompt(false) }}>{tr("提示词1")}</button>
                  <button className={promptVariant === 2 ? "active" : ""} aria-pressed={promptVariant === 2} onClick={() => { setPromptVariant(2); setExpandedPrompt(false); setPromptEdit(null) }}>{tr("提示词2")}</button>
                </> : tr("提示词")}
              </span>
              <span className="field-actions">
                {promptVariant === 1 && !promptEditorActive(promptEdit, project, asset?.id) && <button className="section-action" onClick={startPromptEdit}>{tr("编辑")}</button>}
                <button
                  aria-label={tr("复制提示词")}
                  onClick={async () => {
                    if (!shownPrompt) { notify(tr("无提示词记录")); return }
                    try { await writeText(shownPrompt); notify("提示词已复制") }
                    catch { notify(String(tr("复制失败"))) }
                  }}
                >
                  <Icon name="copy" size={16} />
                </button>
              </span>
            </div>
            {promptVariant === 1 && promptEditorActive(promptEdit, project, asset?.id) && promptEdit ? (
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
              <ReadingText
                id="asset-prompt"
                text={shownPrompt || tr("无提示词记录")}
                expanded={expandedPrompt}
                onToggle={() => setExpandedPrompt(!expandedPrompt)}
                expandLabel={tr("展开提示词")}
                collapseLabel={tr("收起")}
              />
            )}
          </section>
          <section className="detail-section user-instruction-section">
            <div className="field-heading">
              <span>{tr("用户指令")}</span>
              <button aria-label={tr("复制用户指令")} disabled={!asset.user_instruction}
                onClick={() => writeText(asset.user_instruction).then(() => notify(tr("已复制"))).catch(() => notify(tr("复制失败")))}>
                <Icon name="copy" size={16} />
              </button>
            </div>
            <ReadingText
              id="asset-instruction"
              text={asset.user_instruction || tr("未提供用户指令")}
              expanded={expandedInstruction}
              onToggle={() => setExpandedInstruction(!expandedInstruction)}
              expandLabel={tr("展开用户指令")}
              collapseLabel={tr("收起")}
            />
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
          {(() => {
            const references = resolveReferences(asset, recipeHistory, assets)?.items.filter(item => item.thumbnailUrl) || []
            if (!references.length) return null
            return <section className="detail-section">
              <div className="field-heading">
                <span>{tr("参考图")}</span>
              </div>
              <div className="reference-gallery" aria-label={tr("参考图缩略图")}>
                {references.map(reference => <button key={reference.key} className="reference-thumbnail" title={reference.label} aria-label={tr("预览参考图")} onClick={() => window.open(reference.openUrl || reference.thumbnailUrl, "_blank", "noopener")}>
                  <img className="reference-image" src={reference.thumbnailUrl} alt="" loading="lazy" />
                </button>)}
              </div>
            </section>
          })()}
          <section className="detail-section">
            <div className="field-heading">
              <span>{tr("版本树")}</span>
              {!!generationHistory?.events?.length && <span className="field-actions">
                <span className="settings-badge">{generationHistory.events.length}</span>
                <button className="section-action" aria-expanded={versionTreeOpen} onClick={() => setVersionTreeOpen(!versionTreeOpen)}>{tr(versionTreeOpen ? "收起" : "查看")}</button>
              </span>}
            </div>
            {/* One list for the generation records: the record IS the version
                tree entry — its output's thumbnail on the left, prompt and
                time/provider/model on the right. */}
            <div className="version-list" aria-label={tr("版本树")}>
              {(generationHistory?.events || []).slice(0, versionTreeOpen ? undefined : 3).map((event, index) => {
                const output = event.output_asset_id
                  ? generationHistory?.output_assets?.find(item => item.id === event.output_asset_id)
                    || (asset && asset.id === event.output_asset_id ? asset : undefined)
                  : undefined
                return <button
                  className="related"
                  key={event.id || index}
                  onClick={() => { if (event.output_asset_id) selectHistoryAsset(event.output_asset_id) }}
                >
                  <i>{output?.thumbnail_url ? <img src={output.thumbnail_url} alt="" loading="lazy" /> : null}</i>
                  <span>
                    {(event.effective_prompt || event.user_prompt || tr("无提示词记录")).slice(0, 60)}
                    <small>
                      {timeLabel(event.created_at)}{event.provider ? ` · ${event.provider}` : ""}{event.model ? ` · ${event.model}` : ""}{event.turn_index != null ? ` · ${tr("轮次")} ${event.turn_index}` : ""}
                    </small>
                  </span>
                  <Icon name="right" size={11} />
                </button>
              })}
              {!generationHistory?.events?.length && <span className="muted">{tr("暂无生成关系")}</span>}
            </div>
            {versionTreeOpen && <div className="version-tree" role="region" aria-label={tr("完整版本树")}>
              <h4>{tr("生成关系")}</h4>
              {generationTreeRows(generationHistory).map(({ event, depth, parentIds, relationTypes }) => {
                return <button key={event.id} className="related generation-tree-row" style={{ marginLeft: depth * 14 }} onClick={() => { if (event.output_asset_id) selectHistoryAsset(event.output_asset_id) }}>
                  <span><strong>{event.provider || tr("生成记录")}{event.model ? ` · ${event.model}` : ""}</strong>
                    <small>{parentIds.length ? `${tr("关联上游")} ${parentIds.length}${relationTypes.length ? ` · ${relationTypes.join(", ")}` : ""}` : tr("根节点")}{event.turn_index != null ? ` · ${tr("轮次")} ${event.turn_index}` : ""}</small>
                    <small>{event.effective_prompt || event.user_prompt || ""}</small></span>
                </button>
              })}
              {(generationHistory?.relations || []).map(relation => {
                const key = `${relation.child_generation_id}|${relation.parent_generation_id}|${relation.relation_type}`
                const locked = relation.verification_level === "provider_verified"
                return <div className="generation-relation-editor" key={key}>
                  <span>{relation.parent_generation_id} → {relation.child_generation_id}</span>
                  <select disabled={locked || relationBusy} aria-label={tr("关系类型")} value={relationDrafts[key] || relation.relation_type} onChange={event => setRelationDrafts(old => ({ ...old, [key]: event.target.value }))}>
                    {relationTypes.map(type => <option key={type} value={type}>{tr(type)}</option>)}
                  </select>
                  {locked ? <small>{tr("提供方验证关系不可修改")}</small> : <>
                    <button disabled={relationBusy} onClick={() => void mutateRelation(() => editGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, previousRelationType: relation.relation_type, relationType: relationDrafts[key] || relation.relation_type, evidence: relation.evidence }))}>{tr("保存关系")}</button>
                    <button disabled={relationBusy} onClick={() => { if (window.confirm(tr("确认删除这条生成关系？"))) void mutateRelation(() => removeGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, relationType: relation.relation_type })) }}>{tr("删除关系")}</button>
                  </>}
                </div>
              })}
              {(generationHistory?.relation_candidates || []).filter(candidate => candidate.status !== "dismissed" && candidate.status !== "confirmed").map(candidate => <div className="generation-relation-editor" key={`${candidate.child_generation_id}|${candidate.parent_generation_id}`}>
                <span>{tr("候选关系")}: {candidate.parent_generation_id} → {candidate.child_generation_id} ({Math.round((candidate.confidence || 0) * 100)}%)</span>
                <button disabled={relationBusy} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: candidate.child_generation_id, parentGenerationId: candidate.parent_generation_id, relationType: candidate.suggested_relation_type || "derived_from", evidence: candidate.evidence }))}>{tr("确认关系")}</button>
                <button disabled={relationBusy} onClick={() => void mutateRelation(() => dismissGenerationCandidate(project, candidate.child_generation_id, candidate.parent_generation_id))}>{tr("忽略候选")}</button>
              </div>)}
              {!!generationHistory?.events?.length && <div className="generation-relation-editor">
                <button disabled={relationBusy} onClick={() => setNewRelation({ anchor: generationHistory.events[0].id, other: generationHistory.events.find(item => item.id !== generationHistory.events[0].id)?.id || "", direction: "candidate-parent", type: "edited_from" })}>{tr("添加生成关系")}</button>
                {newRelation && <div className="generation-relation-create">
                  <select aria-label={tr("当前生成")} value={newRelation.anchor} onChange={event => setNewRelation(old => old ? { ...old, anchor: event.target.value } : old)}>{generationHistory.events.map(event => <option value={event.id} key={event.id}>{event.provider || "Generation"} · {event.id.slice(0, 10)}</option>)}</select>
                  <select aria-label={tr("关联生成")} value={newRelation.other} onChange={event => setNewRelation(old => old ? { ...old, other: event.target.value } : old)}>{[...generationHistory.events, ...(generationHistory.context_events || [])].filter(event => event.id !== newRelation.anchor).map(event => <option key={event.id} value={event.id}>{event.provider || "Generation"} · {event.id.slice(0, 10)}</option>)}</select>
                  <select aria-label={tr("关系方向")} value={newRelation.direction} onChange={event => setNewRelation(old => old ? { ...old, direction: event.target.value } : old)}><option value="candidate-parent">{tr("关联项为上游")}</option><option value="candidate-child">{tr("关联项为下游")}</option></select>
                  <select aria-label={tr("关系类型")} value={newRelation.type} onChange={event => setNewRelation(old => old ? { ...old, type: event.target.value } : old)}>{relationTypes.map(type => <option value={type} key={type}>{tr(type)}</option>)}</select>
                  <button disabled={relationBusy || !newRelation.other || newRelation.other === newRelation.anchor} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: newRelation.direction === "candidate-child" ? newRelation.other : newRelation.anchor, parentGenerationId: newRelation.direction === "candidate-child" ? newRelation.anchor : newRelation.other, relationType: newRelation.type }))}>{tr("确认添加")}</button>
                </div>}
              </div>}
              {!!generationHistory?.context_events?.length && <><h4>{tr("同对话候选")}</h4>{generationHistory.context_events.map(event => <div key={event.id} className="related"><span>{event.provider || tr("生成记录")}<small>{event.effective_prompt || event.user_prompt || ""}</small></span></div>)}</>}
              <h4>{tr("版本历史")}</h4>
              {(versions || []).map(v => <button key={v.id} className="related" onClick={() => selectHistoryAsset(v.id)}><span>{tr("版本")} {v.version_index}<small>{v.version_change || ""} · {timeLabel(v.created_at)}</small></span></button>)}
              {versions && versions.length > 1 && <div className="version-compare">
                <h4>{tr("版本对比")}</h4>
                <div className="version-compare-selectors">
                  <select aria-label={tr("基准版本")} value={versions.some(v => v.id === compareBaseId) ? compareBaseId : versions[0].id} onChange={event => setCompareBaseId(event.target.value)}>{versions.map(v => <option key={v.id} value={v.id}>{tr("版本")} {v.version_index}</option>)}</select>
                  <select aria-label={tr("目标版本")} value={versions.some(v => v.id === compareTargetId) ? compareTargetId : versions[versions.length - 1].id} onChange={event => setCompareTargetId(event.target.value)}>{versions.map(v => <option key={v.id} value={v.id}>{tr("版本")} {v.version_index}</option>)}</select>
                </div>
                {(() => {
                  const before = versions.find(v => v.id === compareBaseId) || versions[0]
                  const after = versions.find(v => v.id === compareTargetId) || versions[versions.length - 1]
                  return <>
                    <div className="version-compare-images">{[before, after].map(v => <img key={v.id} alt={`${tr("版本")} ${v.version_index}`} src={v.medium_url || v.preview_url || v.image_url} loading="lazy" />)}</div>
                    <div className="version-compare-fields">{([
                      ["尺寸", `${before.width} × ${before.height}`, `${after.width} × ${after.height}`],
                      ["提示词", before.prompt, after.prompt],
                      ["版本", before.version_change || "", after.version_change || ""],
                    ] as const).map(([field, left, right]) => <div key={field} className={left !== right ? "changed" : ""}><strong>{tr(field)}</strong><span>{left || "—"}</span><span>{right || "—"}</span></div>)}</div>
                  </>
                })()}
              </div>}
            </div>}
          </section>
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
                desktopAPI()?.getVisualModelState ? (() => {
                  const api = desktopAPI()
                  const described = describeVisualModel(visualModel, {
                    install: Boolean(api?.installVisualPack),
                    cancel: Boolean(api?.cancelVisualPackInstall),
                    remove: Boolean(api?.removeVisualPack),
                    toggle: Boolean(api?.setVisualModelEnabled),
                  })
                  return <>
                    <section className="settings-section">
                      <div className="model-summary">
                        <div className="model-symbol"><Icon name="layers" size={16} /></div>
                        <div className="model-description model-description-stacked">
                          <strong>{tr("本地视觉搜索")}</strong>
                          <span>{tr(described.label)}</span>
                          {described.details.map(detail => <span key={detail}>{detail}</span>)}
                          {described.progress && <span>{tr(described.progress.phaseLabel)} {described.progress.percent}%</span>}
                          {described.note && <span className="visual-model-error">{tr(described.note)}</span>}
                        </div>
                        <div className="storage-actions">
                          {described.actions.map(action => (
                            <button key={action} className="neutral-button" onClick={() => void runVisualModelAction(action)}>
                              {tr(visualModelActionLabel(action))}
                            </button>
                          ))}
                        </div>
                      </div>
                    </section>
                  </>
                })() : (
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
                )
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
                    <div className="about-identity">
                      <h4>GravityPort</h4>
                      {(() => {
                        const text = buildUpdateText(
                          health?.productVersion || "",
                          updateState,
                          updateState.phase === "downloading" ? updateState.percent : 0,
                          tr,
                          language,
                        )
                        return <span className="settings-badge" title={text.badgeText}>{text.badgeText}</span>
                      })()}
                    </div>
                    {(() => {
                      const text = buildUpdateText(
                        health?.productVersion || "",
                        updateState,
                        updateState.phase === "downloading" ? updateState.percent : 0,
                        tr,
                        language,
                      )
                      if (text.buttonLabel === null) return null
                      if (text.downloadAndInstall) {
                        return <button className="neutral-button about-update" onClick={downloadAndInstallUpdate} disabled={text.buttonDisabled}>{text.buttonLabel}</button>
                      }
                      if (text.secondaryLabel) {
                        return <div className="about-update about-update-actions">
                          <button className="neutral-button" disabled>{text.buttonLabel}</button>
                          <button className="neutral-button" onClick={cancelUpdateDownload}>{text.secondaryLabel}</button>
                        </div>
                      }
                      if (updateState.phase === "available" && !text.downloadAndInstall) {
                        return <button className="neutral-button about-update" onClick={openDownloadPage}>{text.buttonLabel}</button>
                      }
                      return <button className="neutral-button about-update" onClick={checkForUpdates} disabled={text.buttonDisabled}>{text.buttonLabel}</button>
                    })()}
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
      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          role="menu"
          style={{ left: menuPos?.left ?? menu.x, top: menuPos?.top ?? menu.y }}
          onClick={event => {
            // Rows close themselves through their action; a click on the
            // menu's own padding dismisses it. Neither may reach the app-wide
            // click-away, which would close the menu out from under a submenu.
            event.stopPropagation()
            if (event.target === event.currentTarget) setMenu(null)
          }}
        >
          {menu.entries.map((entry, index) => {
            if (entry.kind === "separator") return <div key={`sep-${index}`} className="menu-divider" />
            if (entry.kind === "heading") return <div key={`head-${index}`} className="menu-heading">{entry.label}</div>
            return <MenuRow key={entry.id} entry={entry} onAction={runMenuAction} />
          })}
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
      {permanentDeleteIds && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{permanentDeleteIds.length > 1 ? fillNamed("永久删除 {count} 个素材？", { count: permanentDeleteIds.length }) : tr("永久删除这个素材？")}</h3>
            <p>{tr("永久删除后无法恢复。")}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setPermanentDeleteIds(null)}>
                {tr("取消")}</button>
              <button className="primary-button" onClick={confirmPermanentDelete}>
                {tr("永久删除")}</button>
            </div>
          </div>
        </div>
      )}
      {emptyTrashConfirm && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{tr("清空回收站？")}</h3>
            <p>{tr("回收站中的所有素材都会被永久删除，且无法恢复。")}</p>
            <div className="delete-actions">
              <button className="neutral-button" onClick={() => setEmptyTrashConfirm(false)}>
                {tr("取消")}</button>
              <button className="primary-button" onClick={confirmEmptyTrash}>
                {tr("清空回收站")}</button>
            </div>
          </div>
        </div>
      )}
      {renameNoticeOpen && (
        <div className="modal-layer" onClick={(e) => { if (e.target === e.currentTarget) dismissRenameNotice() }}>
          <div className="delete-modal" role="alertdialog" aria-modal="true" aria-labelledby="rename-notice-title">
            <div className="delete-icon">
              <Icon name="info" size={26} />
            </div>
            <h3 id="rename-notice-title">{tr("MOSA 现已更名为 GravityPort")}</h3>
            <p>{tr("只是换了名字。你的素材、设置和浏览器插件都在原处，不需要做任何操作。")}</p>
            <div className="delete-actions">
              <button
                className="primary-button"
                onClick={dismissRenameNotice}
              >
                {tr("知道了")}
              </button>
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
          {toast.text}
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => { const run = toast.action!.run; setToast(null); run() }}
            >{toast.action.label}</button>
          )}
        </div>
      )}
    </div>
  )
}
