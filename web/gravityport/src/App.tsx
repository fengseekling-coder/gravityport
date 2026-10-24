import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import ColumnControl from "./ColumnControl"
import ImageViewer from "./ImageViewer"
import { PinterestView } from "./PinterestView"
import { PinterestConnectionCard } from "./PinterestConnectionCard"
import { McpClientConfigCard } from "./McpClientConfigCard"
import { WebCaptureStatusCard } from "./WebCaptureStatusCard"
import { FeedbackPanel } from "./FeedbackPanel"
import type { PinterestStatus } from "./pinterest-api"
import { translate, type Language } from "./i18n"
import { buildContextMenu, buildGroupMenu, type MenuContext, type MenuEntry } from "./context-menus"
import { createStack, renameStack, dissolveStack, removeAssetsFromStack, addAssetsToStack, reorderStack, assignStackToGroup, trashStack, restoreAssets, permanentlyDeleteAssets, emptyTrash, listStackMemberIds, listStackMemberPaths } from "./library-actions"
import {
  dragIdsForCard, dragGhostCount, pointOutsideWindow, nativeDragPaths,
  createNativeDragController, moveBlockRelative, stackMemberPaths, undoPlanForStackDrop, planStackMerge,
  collectDragOutPaths, type DragOutUnit,
  type StackUndoPlan,
} from "./card-drag"
import { runImport, collectDroppedFiles, excludeLibraryFiles } from "./import-pipeline"
import { groupNameForActive } from "./import-target"
import { importVisibleInActiveView, pasteImportDecision, renameSynthesizedPasteFiles } from "./paste-import"
import { trashRemainingDays } from "./trash-ui"
import { desktopAPI, type UpdateReadyState } from "./desktop"
import { focusSelection, logicalSelection, pruneSelection, replaceSelection, toggleModifierSelection } from "./selection"
import { boxFromPoints, boxesIntersect, marqueeAutoScrollDelta, marqueeAutoScrollStep, marqueeSelection, masonryCardBoxes, MARQUEE_AUTO_SCROLL_TICK_MS, MARQUEE_DRAG_THRESHOLD_PX, type Box } from "./marquee"
import { promptEditorActive, resolvePromptSaveTarget, type PromptEditTarget } from "./prompt-edit"
import { isEditableTarget } from "./keyboard"
import { galleryKeyAction, isFocusSearchKey, neighbourAssetId } from "./gallery-keys"
import { generationTreeRows, generationDisplay, relatedChoices, type GenerationDisplay } from "./version-tree"
import { computeConversationRounds, conversationRoundRows, roundCompareSelection, roundLine, type ConversationRoundRow } from "./conversation-rounds"
import VersionCompare, { type VersionCompareEntry } from "./version-compare"
import { sanitizeAssetForExport, relationTypes } from "./feature-parity"
import { aspectRatioLabel, describeSource, promptNotice, resolveReferences } from "./inspector-info"
import { SMART_SOURCE_GROUPS, vendorLabelFor, visibleTags, removeTagFromStored, fitTagsInTwoLines } from "./tag-display"
import {
  buildMasonryModel, galleryImageSizes, galleryModelSignature, locateMasonryWindow, masonryCardCss, masonryExtentCss,
  type MasonryModel,
} from "./gallery-window"
import { readStoredColumns, resolveInitialColumns, writeStoredColumns } from "./gallery-columns"
import {
  buildScrollRecord, GalleryScrollMemory, listChangedInPlace, resolveRestoredScrollTop, revealCardScrollTop,
  type GalleryScrollRecord,
} from "./gallery-scroll-memory"
import { deriveEmptyState } from "./empty-state"
import { describeGroupStats } from "./group-stats"
import { createResyncOnReconnect } from "./live-sync-resync"
import {
  checkVersionConsistency,
  createReadyGate,
  fill,
  mapUpdateResult,
  buildUpdateText,
  type UpdateUiState,
} from "./app-lifecycle"
import { buildReleaseNoteBlocks } from "./release-notes-view"
import {
  fetchAssetPage, fetchAsset, fetchNavigation, fetchLibraryLocation, fetchHealth,
  fetchProjects, fetchAssetVersions, fetchAssetGenerationHistory, setAssetsFavorite,
  toggleAssetFavorite, updateAssetMetadata, moveAssetsToTrash, setAssetsGroup,
  createGroup, renameGroup, recolorGroup, reorderGroups, fetchGroupStats, deleteGroupKeepingAssets, mergeGroups, fetchRawGroupAssets,
  moveAssetsToStack, openLibraryFolder,
  mosaMutationHeaders, mergeAssetDetail, galleryImageSrcSet, type MosaAsset, type MosaNavigation, type MosaLibraryLocation,
  type AssetQuery, type MosaVersionRow, type MosaGenerationHistory, type MosaRecipeHistory,
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

/** Inspector header line "kind · source · date". Whole-sentence templates keep
 *  the kind word singular — the bare "图片" key is the filter buttons' plural. */
function inspectorHeaderLine(info: ReturnType<typeof describeSource>, tr: (text: string) => string): string {
  const kind = info.kindLabel === "视频" ? "视频" : "图片"
  const template = info.dateLabel ? `${kind} · {source} · {date}` : `${kind} · {source}`
  return tr(template).replace("{source}", tr(info.sourceLabel)).replace("{date}", info.dateLabel)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// Task 146 card dragging.
const CARD_DRAG_THRESHOLD_PX = 8
const NATIVE_DRAG_MAX_FILES = 512
// Pinterest browsing (tasks 135/138/147). The sidebar row and Settings → 连接
// are shown, the row marked 暂未开放 until a connection lands; false hides
// both while the view, the connection card, and the local token API stay.
const PINTEREST_ENTRY = true

type CardDragGesture = {
  pointerId: number
  startX: number; startY: number; lastX: number; lastY: number
  pressedId: string
  dragIds: string[]
  /** Root-gallery stack cards among the dragged cards (their stack ids): each
   *  stack travels as one unit, to the sidebar or out of the window. */
  stackIds: string[]
  insideStack: boolean
  dragging: boolean
  /** True while a hand-off with stacks waits for their member paths. */
  awaitingPaths: boolean
  frame: number | null
  pathsOverLimit: boolean
  nativeController: ReturnType<typeof createNativeDragController>
  membersAbort: AbortController | null
  membersPromise: Promise<{ paths: string[]; overLimit: boolean }> | null
}
type CardDragFinish = { dragIds: string[]; pressedId: string; stackIds: string[]; insideStack: boolean }

type CardDropTarget = { cardId: string; placement: "before" | "after"; mode: "stack-target" | "reorder" }
type CardSideTarget = { kind: "group"; name: string } | { kind: "ungrouped" }

function sideDropTargetAt(x: number, y: number): CardSideTarget | null {
  const element = document.elementFromPoint(x, y)
  const groupRow = element?.closest?.("[data-drop-group]")
  if (groupRow) {
    const name = groupRow.getAttribute("data-drop-group") || ""
    return name ? { kind: "group", name } : null
  }
  if (element?.closest?.("[data-drop-ungroup]")) return { kind: "ungrouped" }
  return null
}

function cardElementAt(x: number, y: number): HTMLElement | null {
  return document.elementFromPoint(x, y)?.closest?.(".asset-card:not(.asset-card-virtual-placeholder)") || null
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

// Videos never get a generated thumbnail (the app ships no frame extractor),
// so their thumbnail_url falls back to the mp4 itself and an <img> shows a
// broken icon. Let the browser paint an early frame of the video instead.
const VIDEO_URL_PATTERN = /\.(?:mp4|mov|webm|m4v)(?:[?#].*)?$/i
function isVideoUrl(url: string | null | undefined): boolean {
  return !!url && VIDEO_URL_PATTERN.test(url)
}

function ThumbMedia({ src, ...img }: { src: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  if (isVideoUrl(src)) {
    return <video className={img.className} src={src.includes("#") ? src : `${src}#t=0.1`} muted playsInline preload="metadata" tabIndex={-1} aria-hidden="true" draggable={false} />
  }
  return <img src={src} {...img} />
}

function VideoMark() {
  return <span className="video-mark"><Icon name="play" size={12} /></span>
}

// Task 148: one row renderer shared by the version-tree list above and every
// block of the expanded 「查看」 region below. The list rows keep the exact DOM
// they had before the extraction (the version-history e2e drives it).
type InspectorRowSpec = {
  key: string
  thumbnailUrl?: string | null
  emptyThumb?: boolean
  title: string
  detail?: string
  isCurrent?: boolean
  selected?: boolean
  showChevron?: boolean
  staticRow?: boolean
  rowClassName?: string
  indent?: number
  onClick?: () => void
}

function InspectorRow(spec: InspectorRowSpec) {
  const className = [
    "related",
    spec.isCurrent ? "is-current" : "",
    spec.staticRow ? "row-static" : "",
    spec.rowClassName || "",
  ].filter(Boolean).join(" ")
  const style = spec.indent ? { marginLeft: spec.indent * 14 } : undefined
  const row = (
    <>
      <i className={spec.emptyThumb ? "row-thumb-empty" : undefined}>
        {!spec.emptyThumb && spec.thumbnailUrl ? <ThumbMedia src={spec.thumbnailUrl} alt="" loading="lazy" /> : null}
      </i>
      <span>{spec.title}<small>{spec.detail || ""}</small></span>
      {spec.showChevron === false ? null : <Icon name="right" size={11} />}
    </>
  )
  if (spec.staticRow) return <div className={className} key={spec.key} style={style}>{row}</div>
  return (
    <button
      className={className}
      key={spec.key}
      aria-pressed={spec.selected === true ? true : undefined}
      style={style}
      onClick={spec.onClick}
    >{row}</button>
  )
}

// One generation record as a 36px thumbnail for the upstream → downstream pair
// rows; records that resolve to no asset render the gray placeholder frame.
function RelationThumb({ display, onClick, label }: { display: GenerationDisplay; onClick?: () => void; label?: string }) {
  const thumb = display.known && display.asset
    ? <i>{display.asset.thumbnail_url ? <ThumbMedia src={display.asset.thumbnail_url} alt="" loading="lazy" /> : null}</i>
    : <i className="row-thumb-empty" />
  if (!onClick) return <span className="relation-thumb-frame">{thumb}</span>
  return <button className="relation-thumb-link" title={label} aria-label={label} onClick={onClick}>{thumb}</button>
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
  // Sidebar Pinterest count = boards loaded by PinterestView (null until the
  // view has reported, or after a disconnect).
  const [pinterestBoards, setPinterestBoards] = useState<{ count: number; complete: boolean } | null>(null)
  // A connect/disconnect from Settings remounts PinterestView so it rereads
  // the status instead of showing boards of an account that is gone.
  const [pinterestViewKey, setPinterestViewKey] = useState(0)
  const pinterestConnectedRef = useRef<boolean | null>(null)
  const onPinterestStatus = (status: PinterestStatus) => {
    const connected = status.connected && !status.needsReconnect
    if (pinterestConnectedRef.current !== null && pinterestConnectedRef.current !== connected) setPinterestViewKey(k => k + 1)
    pinterestConnectedRef.current = connected
    if (!connected) setPinterestBoards(null)
  }
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
  // Collapsed tag-row capacity: how many items (vendor name + visible tags)
  // fit on two lines with "+N" and "添加标签" at the end. Measured, not guessed.
  const [tagFitCount, setTagFitCount] = useState(0)
  const tagsRowRef = useRef<HTMLDivElement>(null)
  const tagsMeasureRef = useRef<HTMLDivElement>(null)
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [tagError, setTagError] = useState("")
  const [preview, setPreview] = useState(false)
  // Task 177: in-app viewer fullscreen (window stays a window — the OS
  // fullscreen API is deliberately untouched). Never persisted: it resets
  // whenever the viewer closes.
  const [viewerFullscreen, setViewerFullscreen] = useState(false)
  // The context menu carries its target with it: stack menus act on the
  // right-clicked stack without touching the selection, so the handlers read
  // the menu state instead of guessing from the focused asset.
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[]; target: MenuContext["target"] | "group"; selectionCount: number; stackId: string; stackName: string; stackCount: number; groupName?: string } | null>(null)
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
  // Task 231 — the main process owns update checks and staged a verified
  // package; the sidebar and the about panel keep a restart-to-update button.
  const [updateReady, setUpdateReady] = useState<UpdateReadyState | null>(null)
  const [restartPending, setRestartPending] = useState(false)
  // Rename notice (task 116): shown once at first-screen render.
  const [renameNoticeOpen, setRenameNoticeOpen] = useState(false)
  const [versions, setVersions] = useState<MosaVersionRow[] | null>(null)
  const [generationHistory, setGenerationHistory] = useState<MosaGenerationHistory | null>(null)
  const [relationBusy, setRelationBusy] = useState(false)
  const [relationDrafts, setRelationDrafts] = useState<Record<string, string>>({})
  const [newRelation, setNewRelation] = useState<{ anchor: string; other: string; direction: string; type: string } | null>(null)
  // Task 148: the related-generation picker shows six rows until expanded.
  const [showAllRelationChoices, setShowAllRelationChoices] = useState(false)
  // undefined: the recipe history has not answered for this asset yet;
  // null: it answered with none. Web captures keep their references there.
  const [recipeHistory, setRecipeHistory] = useState<MosaRecipeHistory | null | undefined>(undefined)
  const [versionTreeOpen, setVersionTreeOpen] = useState(false)
  // The version compare keeps its selection inside the block (task 217); the
  // blocks remount per asset, so switching assets resets both to defaults.
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
  // Task 152 scroll restore. committedViewKeyRef is the view key of the cards
  // actually displayed: the load effect's viewKeyRef flips the moment a switch
  // starts, while the grid still shows the old view — recording against it
  // there would file the old cards' position under the new view (browser
  // clamp-scrolls during the swap would poison it too). liveScrollRef holds
  // the freshest record of the displayed view; the load effect folds it into
  // the table when the view changes. pendingScrollRestoreRef is the restore
  // the next committed load owes: every cross-view switch sets it, a preview
  // open re-arms it for the close.
  const scrollMemoryRef = useRef<GalleryScrollMemory>(new GalleryScrollMemory(30))
  const committedViewKeyRef = useRef("")
  const liveScrollRef = useRef<{ key: string; record: GalleryScrollRecord } | null>(null)
  const pendingScrollRestoreRef = useRef<{ viewKey: string; reveal: boolean } | null>(null)
  const restoringScrollRef = useRef(false)
  // The bottom-right "back to top" button shows once the gallery is more than
  // one screen down.
  const [showToTop, setShowToTop] = useState(false)
  // The view identity the current selection was made in (same key as the
  // load effect's viewKey); a mismatch resets the selection.
  const selectionViewKeyRef = useRef("")
  // One-shot inspection target ("show in library") that survives the
  // selection reset of the view change it causes.
  const pendingInspectRef = useRef("")
  const cutIdsRef = useRef<string[]>([])
  // One-up token per blank-menu open: the async clipboard answer may only
  // patch the menu that asked for it, never one opened later in its place.
  const blankMenuTokenRef = useRef(0)
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
  // The Pinterest row browses the user's live boards (PinterestView), not
  // local assets; the gallery underneath stays mounted but out of reach.
  const pinterestActive = PINTEREST_ENTRY && active === "Pinterest"
  const source = active.startsWith("source:") ? active.slice(7) : undefined
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
    // Task 152 scroll restore: a real view switch owes the next committed load
    // a restore (recorded position, or the top when the view was never
    // visited). Before the key is overwritten, fold the displayed view's live
    // record — the last scrolled anchor plus the still-current loaded count
    // and focused card — into the memory table. Recording keys off the
    // committed view key, not this one: until the new data commits, the grid
    // still shows the outgoing view.
    const isViewSwitch = viewKeyRef.current !== viewKey
    if (isViewSwitch) {
      const leavingKey = committedViewKeyRef.current
      const live = liveScrollRef.current
      if (leavingKey) {
        // No live record means the view was never scrolled (it sits at the
        // top): still remember it, or its focused card is lost on return.
        const base = live && live.key === leavingKey
          ? live.record
          : { anchorId: "", anchorOffset: 0, scrollTop: 0, loaded: 0, selected: "" }
        // switchProject empties assets before this effect runs; the record's
        // own loaded count is still the one the leaving view displayed.
        scrollMemoryRef.current.set(leavingKey, {
          ...base,
          loaded: assetsRef.current.length || base.loaded,
          // A focus the app picked is not remembered as the user's: coming
          // back lands on the first card again, still implicit.
          selected: selectionRef.current.selected === implicitFocusRef.current ? "" : selectionRef.current.selected,
        })
      }
      liveScrollRef.current = null
      if (leavingKey) pendingScrollRestoreRef.current = { viewKey, reveal: false }
    }
    viewKeyRef.current = viewKey
    // Selection is bound to the view it was made in. A project, search,
    // filter, sort or stack change resets it here — before anything loads —
    // so Delete/favorite/group can never reach assets that the current view
    // no longer shows. Pagination and same-view refreshes keep the entries
    // that are still visible (pruned after the fetch below). A pending
    // explicit inspection ("show in library") survives the reset once.
    if (selectionViewKeyRef.current !== viewKey) {
      selectionViewKeyRef.current = viewKey
      // Task 152: a view remembered with a focused card re-inspects it instead
      // of falling back to the first card; "show in library" still wins.
      const preserve = pendingInspectRef.current
        || scrollMemoryRef.current.get(viewKey)?.selected
        || ""
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
        // Follow-up pages until `target` items are collected — shared by the
        // same-view window refresh and the scroll restore (a remembered view
        // must come back with at least the window it was left with, or the
        // remembered anchor card would not exist yet).
        const followUpPages = async (target: number) => {
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
        if (windowRefresh) {
          await followUpPages(Math.max(assetsRef.current.length, GALLERY_PAGE_SIZE))
        } else if (isViewSwitch) {
          const remembered = scrollMemoryRef.current.get(viewKey)
          const target = Math.max(GALLERY_PAGE_SIZE, remembered?.loaded ?? 0)
          if (target > collected.length) await followUpPages(target)
        }
        if (controller.signal.aborted) return
        // Cross-page selections outrun the loaded window, so only ids the
        // PREVIOUS window contained can be re-judged against the fresh one:
        // a member that left the view is dropped, off-page members are kept
        // (no information about them changed).
        const previousIds = new Set(assetsRef.current.map(item => item.id))
        // The displayed view becomes this key only now — scroll recording and
        // restore consumption key off it, so anything still in flight files
        // under the outgoing view.
        committedViewKeyRef.current = viewKey
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
          // The first card, or a kept focus that was already the app's pick,
          // stays implicit (see implicitFocusRef).
          const implicit = !pruned.selectedIds.length
            && (!pruned.selected || pruned.selected === implicitFocusRef.current)
          applySelection(pruned.selectedIds, fallback, implicit)
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
  // Opening the preview unmounts the grid: re-arm the restore so closing it —
  // even after the viewer paged and re-focused — returns to the pre-preview
  // position and only reveals the focused card (task 152).
  useEffect(() => {
    if (!preview) return
    pendingScrollRestoreRef.current = { viewKey: committedViewKeyRef.current, reveal: true }
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
  // Task 231 — the main process checks for updates on its own cadence now.
  // The renderer only mirrors the "verified package staged" state: query it
  // once (the window may have opened after the announcement) and subscribe for
  // live announcements; the button never disappears on its own.
  useEffect(() => {
    const api = desktopAPI()
    if (!api?.getUpdateReady) return
    api.getUpdateReady().then(payload => {
      if (payload?.version) setUpdateReady(payload)
    }).catch(() => {})
    api.onUpdateReady?.(payload => {
      if (payload?.version) setUpdateReady(payload)
    })
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
    fetchAssetVersions(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setVersions(history && history.versions.length > 1 ? history.versions : null)
    }).catch(() => {})
    fetchAssetGenerationHistory(project, selected, controller.signal).then(history => {
      if (!controller.signal.aborted) setGenerationHistory(history)
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
  assetsRef.current = assets
  const asset = assets.find((a) => a.id === selected) || assets[0]
  // 版本树（任务 144）：有对话时行来自对话轮次计算——默认当前素材前后共三行，
  // 「查看」展开全部；无对话时列表回退到 events（rounds.rows 为空）。
  const versionRounds = useMemo(
    () => computeConversationRounds(generationHistory, asset?.id || ""),
    [generationHistory, asset?.id],
  )
  const currentTags = asset ? asset.tags : []
  // Source type read the same way inspector-info reads it; the smart-group
  // sources get a vendor chip first, everything else just shows stored tags.
  const tagSourceType = asset ? String(asset.source?.type || (asset as MosaAsset & { source_type?: string }).source_type || "") : ""
  const tagVendor = vendorLabelFor(tagSourceType)
  const tagItems = [...(tagVendor ? [tagVendor] : []), ...visibleTags(currentTags, tagSourceType)]
  const tagItemsKey = tagItems.join("\n")
  const collapsedTagCount = expandedTags ? tagItems.length : Math.max(1, Math.min(tagFitCount, tagItems.length))
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
  // Collapsed tag-row fitting: measure every item's natural width in a hidden
  // copy of the row, then solve how many fit on two lines with "+N" and
  // "添加标签" trailing. Re-runs when the container resizes, the tags change,
  // or the fit count itself moves — the "+N" label width depends on it, and
  // the sequence converges because a shorter label never fits fewer items.
  useLayoutEffect(() => {
    const row = tagsRowRef.current
    const measureLayer = tagsMeasureRef.current
    if (!row || !measureLayer || expandedTags) return
    const solve = () => {
      const gapValue = Number.parseFloat(getComputedStyle(row).columnGap)
      const itemWidths = Array.from(measureLayer.querySelectorAll<HTMLElement>("[data-tag-measure-item]")).map(el => el.offsetWidth)
      const toggleWidth = measureLayer.querySelector<HTMLElement>("[data-tag-measure-toggle]")?.offsetWidth ?? 0
      const addWidth = measureLayer.querySelector<HTMLElement>("[data-tag-measure-add]")?.offsetWidth ?? 0
      setTagFitCount(fitTagsInTwoLines({
        itemWidths,
        containerWidth: row.clientWidth,
        gap: Number.isFinite(gapValue) ? gapValue : 0,
        toggleWidth,
        addWidth,
      }))
    }
    solve()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(solve)
    observer.observe(row)
    return () => observer.disconnect()
  }, [expandedTags, tagItemsKey, tagFitCount])
  // The same refresh the blank-area 刷新 menu entries run: a visible notice
  // plus a navigation-key reload of the current view.
  const refreshCurrentView = () => {
    notify(tr("正在刷新..."))
    refreshNavigation()
  }
  // Translate, then fill the named placeholders ({count}, {completed}, …).
  const fillNamed = (text: string, values: Record<string, string | number>) => fill(tr(text), values)
  // roundLine's translate callback: optional params, filled after translation.
  const roundText = (text: string, params?: Record<string, string | number>) => (params ? fillNamed(text, params) : tr(text))
  // Task 148: the right-hand text of a confirmed/proposed relation pair — the
  // two validated turns when both exist, otherwise both prompts clipped to 12
  // characters. Generation ids never appear here.
  const relationPairLine = (upstream: GenerationDisplay, downstream: GenerationDisplay): string => {
    if (upstream.turnIndex != null && downstream.turnIndex != null) {
      return `${fillNamed(tr("第 {n} 轮"), { n: upstream.turnIndex })} → ${fillNamed(tr("第 {n} 轮"), { n: downstream.turnIndex })}`
    }
    const clip = (display: GenerationDisplay) => (display.prompt ? display.prompt.slice(0, 12) : tr("无提示词记录"))
    return `${clip(upstream)} → ${clip(downstream)}`
  }
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
  }, [nextCursor, loadingMore, loading, preview])
  // The grid is its own scroll container; a scroll-position check makes
  // pagination deterministic even where IntersectionObserver timing is not.
  // The same handler re-derives the mounted gallery window. preview rides the
  // dep list like the observers above: the grid remounts on every preview
  // toggle, and a page pulled from inside the viewer changes nextCursor while
  // the grid is unmounted — without re-running here, the fresh grid would
  // keep no pagination listener at all.
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
  }, [nextCursor, loadingMore, loading, preview])
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
  // Task 152: capture the displayed view's live position as the user scrolls
  // (every event: a throttle would drop the final position of a short flick;
  // recording resumes only after a restore has settled).
  const recordLiveGalleryScroll = () => {
    if (restoringScrollRef.current) return
    const grid = gridRef.current
    const key = committedViewKeyRef.current
    if (!grid || !key) return
    const model = galleryRowModel()
    if (!model || !model.placements.length) return
    const record = buildScrollRecord(model, assetsRef.current.map(item => item.id), grid.scrollTop,
      assetsRef.current.length, selectionRef.current.selected)
    if (record) liveScrollRef.current = { key, record }
  }
  const recordLiveGalleryScrollRef = useRef<() => void>(() => {})
  recordLiveGalleryScrollRef.current = recordLiveGalleryScroll
  // Settle an owed restore once the grid displays the target view's data and
  // the masonry model matches it — in the layout pass, before first paint, so
  // the restored position is the only one the user ever sees. The virtual
  // window re-derives from the restored (or revealed) position, so the landing
  // shows real cards instead of placeholders.
  const consumeGalleryScrollRestore = () => {
    const pending = pendingScrollRestoreRef.current
    const grid = gridRef.current
    if (!pending || !grid) return
    if (pending.viewKey !== committedViewKeyRef.current) return
    const ids = assetsRef.current.map(item => item.id)
    if (!ids.length) {
      pendingScrollRestoreRef.current = null
      return
    }
    const model = galleryRowModel()
    if (!model || model.placements.length !== ids.length) return
    pendingScrollRestoreRef.current = null
    const live = liveScrollRef.current
    // The live record (still scrolling after a restore, or freshly fetched
    // pages) is fresher than the table entry for the displayed view.
    const record = live && live.key === pending.viewKey
      ? live.record
      : scrollMemoryRef.current.get(pending.viewKey)
    // The masonry extent (the spacer that carries the real scroll height)
    // commits one render late: updateGalleryWindow above queued the new
    // window state inside this same layout pass, and the scroller's full
    // height — without which the browser clamps any large scrollTop to 0 —
    // only exists after React's synchronous re-render. Apply the restore in
    // this frame's animation callback: still before the first paint, so no
    // top-of-gallery flash ever reaches the screen. The guard stays up until
    // the callback has written the restored position.
    restoringScrollRef.current = true
    requestAnimationFrame(() => {
      try {
        if (committedViewKeyRef.current !== pending.viewKey) return
        // First visit to this view: start at the top explicitly instead of
        // inheriting whatever the outgoing content left in the scroller.
        const maxScrollTop = grid.scrollHeight - grid.clientHeight
        grid.scrollTop = record ? resolveRestoredScrollTop(model, ids, record, grid.clientHeight, maxScrollTop) : 0
        if (pending.reveal) {
          // Also when the view sat untouched at the top: a card paged to in
          // the viewer still has to come into view.
          const index = ids.indexOf(selectionRef.current.selected)
          if (index >= 0) grid.scrollTop = revealCardScrollTop(model, index, grid.scrollTop, grid.clientHeight, undefined, maxScrollTop)
        }
        // Re-read scrollTop: the browser may have clamped the write.
        const landed = buildScrollRecord(model, ids, grid.scrollTop, ids.length, selectionRef.current.selected)
        liveScrollRef.current = landed ? { key: pending.viewKey, record: landed } : null
        setShowToTop(grid.scrollTop > grid.clientHeight)
        updateGalleryWindow()
      } finally {
        restoringScrollRef.current = false
      }
    })
  }
  // Task 197: a list change inside the displayed view (trash, undo, stack
  // edits, live arrivals) must leave the user where they were reading. The
  // position has been seen to jump up around the commit that drops a card
  // (once, in a real library; cause not pinned down). The position is read
  // during render, before React touches the DOM (a scroll-event record can be
  // stale: hidden windows throttle scroll events and animation frames), and
  // written back after the list commits, again once the masonry window (one
  // render late) commits, and once more in the next frame. Cards before a
  // removed one keep their placement, so the same scrollTop is the same view.
  const scrollBeforeListRef = useRef<{ assets: MosaAsset[]; scrollTop: number } | null>(null)
  if (scrollBeforeListRef.current?.assets !== assets) {
    scrollBeforeListRef.current = { assets, scrollTop: gridRef.current?.scrollTop ?? 0 }
  }
  const pendingHoldRef = useRef<{ viewKey: string; scrollTop: number } | null>(null)
  const applyGalleryHold = () => {
    const hold = pendingHoldRef.current
    const grid = gridRef.current
    if (!hold || !grid) return
    if (committedViewKeyRef.current !== hold.viewKey) { pendingHoldRef.current = null; return }
    const target = Math.min(hold.scrollTop, Math.max(0, grid.scrollHeight - grid.clientHeight))
    if (Math.abs(grid.scrollTop - target) > 1) grid.scrollTop = target
    recordLiveGalleryScroll()
    setShowToTop(grid.scrollTop > grid.clientHeight)
  }
  // The ids the last layout pass laid out, with the view they belonged to.
  const laidOutListRef = useRef<{ viewKey: string; ids: string[] }>({ viewKey: "", ids: [] })
  useLayoutEffect(() => {
    const viewKey = committedViewKeyRef.current
    const ids = assets.map(item => item.id)
    const previous = laidOutListRef.current
    laidOutListRef.current = { viewKey, ids }
    const owed = pendingScrollRestoreRef.current
    const before = scrollBeforeListRef.current?.scrollTop ?? 0
    // A restore owed to the viewer closing (reveal) keeps priority; at the
    // top there is nothing to hold.
    const hold = viewKey && previous.viewKey === viewKey && listChangedInPlace(previous.ids, ids)
      && !owed?.reveal && before > 0
    if (hold) {
      // A plain restore still owed to this view is stale: the user has
      // scrolled here since, and it would land on an anchor the change moved.
      if (owed?.viewKey === viewKey) pendingScrollRestoreRef.current = null
      pendingHoldRef.current = { viewKey, scrollTop: before }
    }
    updateGalleryWindow()
    consumeGalleryScrollRestore()
    if (hold) {
      applyGalleryHold()
      const held = pendingHoldRef.current
      requestAnimationFrame(() => {
        if (pendingHoldRef.current !== held) return
        applyGalleryHold()
        pendingHoldRef.current = null
        updateGalleryWindow()
      })
    }
    // preview toggles remount the grid, so the window must be re-derived for
    // the fresh (top-of-gallery) scroll position — and any restore owed by the
    // toggle settles before the first paint.
  }, [assets, columns, windowingActive, preview])
  // The masonry window for a changed list commits one render after the list:
  // only then does the scroller have its full extent, so re-apply a held
  // position here, still before paint.
  useLayoutEffect(() => {
    applyGalleryHold()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryWindow])
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
  // Task 152: the recording listener rides the same element, which remounts
  // on preview and Pinterest toggles — rebind alongside them.
  useEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const onScroll = () => {
      recordLiveGalleryScrollRef.current()
      setShowToTop(grid.scrollTop > grid.clientHeight)
    }
    grid.addEventListener("scroll", onScroll, { passive: true })
    setShowToTop(grid.scrollTop > grid.clientHeight)
    return () => grid.removeEventListener("scroll", onScroll)
  }, [preview, pinterestActive])
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
  // The card the app focused on its own (a view's first card after a load or
  // a trash move), not one the user picked. The inspector still shows it, but
  // it never joins a ⌘-click batch or answers the Delete key: after trashing
  // cards deep in the gallery the focus falls back to the newest card, out of
  // sight at the top, and the next ⌘-click batch used to carry it into the
  // trash too.
  const implicitFocusRef = useRef("")
  const applySelection = (nextIds: string[], nextSelected: string, implicit = false) => {
    selectionRevisionRef.current += 1
    implicitFocusRef.current = implicit && !nextIds.length ? nextSelected : ""
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
      const range = assets.slice(from, to + 1).map(a => a.id)
      applySelection(range, replaceSelection(range, selectionRef.current.selected))
      return
    }
    if (event.metaKey || event.ctrlKey) {
      // The inspected card is the implicit selection: the first ⌘-click adds
      // to it instead of replacing it — unless the app picked it, not the user.
      const { selectedIds: current, selected: focused } = selectionRef.current
      const base = !current.length && focused === implicitFocusRef.current ? [] : logicalSelection(current, focused)
      const toggled = toggleModifierSelection(base, focused, id)
      applySelection(toggled.selectedIds, toggled.selected)
      anchorIndexRef.current = index
      return
    }
    anchorIndexRef.current = index
    applySelection([], id)
    setDetail(true)
  }
  // Select-all takes stack cards too: a root-gallery stack card stands for
  // the whole stack in every batch action (splitSelectionStacks).
  const selectAllLoaded = () => {
    const ids = assets.map(a => a.id).filter(Boolean)
    applySelection(ids, replaceSelection(ids, selectionRef.current.selected))
  }
  // What a cross-page select-all learned about the cards it fetched but the
  // grid has not loaded: which ids are stack covers (and of which stack), and
  // each card's file path for a drag out of the window. Bound to the view it
  // was fetched in; a loaded card always wins over this snapshot.
  const selectAllPagesRef = useRef<{ viewKey: string; stackOf: Map<string, string>; pathOf: Map<string, string> } | null>(null)
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
      const stackOf = new Map<string, string>()
      const pathOf = new Map<string, string>()
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
          if (!item.id || seen.has(item.id)) continue
          seen.add(item.id)
          collected.push(item.id)
          if (item.stack?.id && !stackId) stackOf.set(item.id, item.stack.id)
          if (item.image_path) pathOf.set(item.id, item.image_path)
        }
        setToast({ text: `${tr("正在全选")} ${collected.length}${page.total ? ` / ${page.total}` : "…"}` })
        morePages = Boolean(page.nextCursor)
        if (!morePages) break
        cursor = page.nextCursor ?? undefined
      }
      if (controller.signal.aborted || viewKeyRef.current !== requestViewKey
        || selectionRevisionRef.current !== startRevision) return
      if (collected.length) {
        selectAllPagesRef.current = { viewKey: requestViewKey, stackOf, pathOf }
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
  // Marquee selection: a drag that starts on the grid background or on an
  // unselected card selects every card (stacks included) whose box hits the rubber
  // band; a press on a highlighted card drags the selection instead (task 155:
  // left mouse only, no modifier needed). Shift-drag starts an additive
  // marquee even on a selected card. Near the grid's top or bottom edge the
  // sweep auto-scrolls, and hits come from the masonry model, so cards the
  // virtualized window has unmounted still join the selection.
  const galleryWindowRef = useRef(galleryWindow)
  galleryWindowRef.current = galleryWindow
  const marqueeRef = useRef<{ pointerId: number } | null>(null)
  const cardIsSelected = (id: string) =>
    Boolean(id) && logicalSelection(selectionRef.current.selectedIds, selectionRef.current.selected).includes(id)
  const onGridPointerDown = (event: React.PointerEvent) => {
    const grid = gridRef.current
    if (!grid || marqueeRef.current || event.button !== 0 || event.pointerType === "touch" || preview || settings) return
    const startCard = (event.target as HTMLElement).closest<HTMLElement>(".asset-card")
    if (startCard && !event.shiftKey && cardIsSelected(startCard.dataset.assetId || "")) return
    // A leftover native text selection would keep painting cards blue in DOM
    // order, which has nothing to do with where they sit in the masonry.
    window.getSelection()?.removeAllRanges()
    const gesture = { pointerId: event.pointerId }
    marqueeRef.current = gesture
    const pressX = event.clientX
    const pressY = event.clientY
    // Shift adds to the selection — never to a focus the app picked itself
    // (see implicitFocusRef).
    const { selectedIds: heldIds, selected: heldFocus } = selectionRef.current
    const base = !event.shiftKey ? []
      : !heldIds.length && heldFocus === implicitFocusRef.current ? [] : logicalSelection(heldIds, heldFocus)
    const startId = startCard?.dataset.assetId || ""
    const toContent = (clientX: number, clientY: number) => {
      const bounds = grid.getBoundingClientRect()
      return {
        x: Math.min(Math.max(clientX, bounds.left), bounds.right) - bounds.left + grid.scrollLeft,
        y: Math.min(Math.max(clientY, bounds.top), bounds.bottom) - bounds.top + grid.scrollTop,
      }
    }
    const origin = toContent(pressX, pressY)
    let dragging = false
    let lastX = pressX
    let lastY = pressY
    let timer = 0
    let lastTick = 0
    let candidates: { id: string; box: Box }[] = []
    let candidatesKey: unknown = null
    const refreshCandidates = () => {
      const items = assetsRef.current
      const win = galleryWindowRef.current
      const key = win && win.model.placements.length === items.length ? win.model : items
      if (key === candidatesKey) return
      candidatesKey = key
      const bounds = grid.getBoundingClientRect()
      const domBox = (node: HTMLElement): Box => {
        const r = node.getBoundingClientRect()
        const left = r.left - bounds.left + grid.scrollLeft
        const top = r.top - bounds.top + grid.scrollTop
        return { left, top, right: left + r.width, bottom: top + r.height }
      }
      const mounted = Array.from(grid.querySelectorAll<HTMLElement>(".asset-card:not(.asset-card-virtual-placeholder)"))
      if (key === items) {
        candidates = mounted.filter(node => node.dataset.assetId)
          .map(node => ({ id: node.dataset.assetId!, box: domBox(node) }))
        return
      }
      const model = win!.model
      const styles = getComputedStyle(grid)
      const contentWidth = grid.clientWidth - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0)
      const boxes = masonryCardBoxes(model, (contentWidth - (model.columns - 1) * model.gap) / model.columns)
      // Anchor the model origin on a mounted card so grid padding and the
      // containing block never shift the boxes off the rendered cards.
      let dx = 0
      let dy = 0
      const anchor = mounted.find(node => node.dataset.assetId)
      const anchorIndex = anchor ? items.findIndex(a => a.id === anchor.dataset.assetId) : -1
      if (anchor && anchorIndex >= 0) {
        const box = domBox(anchor)
        dx = box.left - boxes[anchorIndex].left
        dy = box.top - boxes[anchorIndex].top
      }
      candidates = items.flatMap((a, index) => !a.id ? [] : [{
        id: a.id,
        box: { left: boxes[index].left + dx, top: boxes[index].top + dy, right: boxes[index].right + dx, bottom: boxes[index].bottom + dy },
      }])
    }
    const update = () => {
      refreshCandidates()
      const current = toContent(lastX, lastY)
      const rect = boxFromPoints(origin.x, origin.y, current.x, current.y)
      const bounds = grid.getBoundingClientRect()
      const clipX = (x: number) => Math.min(Math.max(bounds.left + x - grid.scrollLeft, bounds.left), bounds.right)
      const clipY = (y: number) => Math.min(Math.max(bounds.top + y - grid.scrollTop, bounds.top), bounds.bottom)
      setMarquee({ x0: clipX(origin.x), y0: clipY(origin.y), x1: clipX(current.x), y1: clipY(current.y) })
      const hits = candidates.filter(entry => boxesIntersect(entry.box, rect)).map(entry => entry.id)
      const ids = marqueeSelection({ base, startId, hits })
      applySelection(ids, replaceSelection(ids, selectionRef.current.selected))
    }
    const autoScroll = () => {
      timer = 0
      if (marqueeRef.current !== gesture) return
      const bounds = grid.getBoundingClientRect()
      const step = marqueeAutoScrollStep(lastY, bounds.top, bounds.bottom)
      if (!step) return
      const now = performance.now()
      const before = grid.scrollTop
      grid.scrollTop += marqueeAutoScrollDelta(step, lastTick ? now - lastTick : MARQUEE_AUTO_SCROLL_TICK_MS)
      lastTick = now
      if (grid.scrollTop !== before) update()
      timer = window.setTimeout(autoScroll, MARQUEE_AUTO_SCROLL_TICK_MS)
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== gesture.pointerId || marqueeRef.current !== gesture) return
      lastX = e.clientX
      lastY = e.clientY
      if (!dragging) {
        if (Math.hypot(lastX - pressX, lastY - pressY) < MARQUEE_DRAG_THRESHOLD_PX) return
        dragging = true
      }
      e.preventDefault()
      update()
      if (!timer) { lastTick = 0; timer = window.setTimeout(autoScroll, MARQUEE_AUTO_SCROLL_TICK_MS) }
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== gesture.pointerId) return
      if (timer) window.clearTimeout(timer)
      timer = 0
      // A sweep that started on a card can end on that same card, and the
      // click the browser then fires must not reselect it (or Shift-range from
      // it). A sweep from the background never clicks a card.
      if (dragging && startCard) suppressCardDragClickRef.current = true
      marqueeRef.current = null
      setMarquee(null)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
  // Batch helpers: every action in the context menu applies to the whole
  // selection once more than one card is marked.
  const selectionIds = logicalSelection(selectedIds, selected)
  const selectionSet = new Set(selectionIds)
  const batchIds = selectionIds
  // Root-gallery stack cards in a batch, keyed by their cover asset id. Inside
  // a stack view every card is a plain member. Ids a cross-page select-all
  // picked up beyond the loaded pages resolve through its snapshot.
  const pagesSnapshot = () => {
    const snapshot = selectAllPagesRef.current
    return snapshot && snapshot.viewKey === viewKeyRef.current ? snapshot : null
  }
  const stackOfCard = () => {
    const loaded = new Map(assetsRef.current.map(item => [item.id, item]))
    const stackOf = pagesSnapshot()?.stackOf
    return (id: string): string => {
      if (stackId) return ""
      const item = loaded.get(id)
      return item ? item.stack?.id || "" : stackOf?.get(id) || ""
    }
  }
  const splitSelectionStacks = (ids: string[]) => {
    const plainIds: string[] = []
    const stackIds: string[] = []
    const stackOf = stackOfCard()
    for (const id of ids) {
      const stack = stackOf(id)
      if (stack) { if (!stackIds.includes(stack)) stackIds.push(stack) } else plainIds.push(id)
    }
    return { plainIds, stackIds }
  }
  // File paths for a batch, in selection order with each root-gallery stack
  // card expanded to its members (all pages, stack order), duplicates
  // collapsed. Shared by the system drag-out and the menu's copy actions.
  const batchFilePaths = (ids: string[], { limit = Number.POSITIVE_INFINITY, signal }: { limit?: number; signal?: AbortSignal } = {}) => {
    const loaded = new Map(assetsRef.current.map(item => [item.id, item]))
    const pathOf = pagesSnapshot()?.pathOf
    const stackOf = stackOfCard()
    const units: DragOutUnit[] = ids.map(id => {
      const stack = stackOf(id)
      return stack ? { kind: "stack", stackId: stack } : { kind: "asset", path: loaded.get(id)?.image_path || pathOf?.get(id) || "" }
    })
    return stackFilePaths(units, signal, limit)
  }
  const stackFilePaths = (units: DragOutUnit[], signal?: AbortSignal, limit = Number.POSITIVE_INFINITY) =>
    collectDragOutPaths(units, id => listStackMemberPaths(project, id, signal).then(members => stackMemberPaths(members)), { limit })
  // Group assignment for a batch: plain cards in one request, each stack card
  // through the stack's own endpoint (all members follow). The outcome counts
  // one per stack, like a plain card.
  const assignBatchToGroup = async (targetProject: string, ids: string[], name: string) => {
    const { plainIds, stackIds } = splitSelectionStacks(ids)
    const assignStacks = async () => {
      let failed = 0
      let firstError = ""
      for (const id of stackIds) {
        try { await assignStackToGroup(targetProject, id, name) } catch (error) { failed += 1; firstError ||= errorMessage(error) }
      }
      return { succeeded: stackIds.length - failed, failed, firstError }
    }
    const [plain, stacks] = await Promise.all([
      plainIds.length ? setAssetsGroup(targetProject, plainIds, name) : Promise.resolve({ succeeded: 0, failed: 0, firstError: "" }),
      assignStacks(),
    ])
    return {
      succeeded: plain.succeeded + stacks.succeeded,
      failed: plain.failed + stacks.failed,
      firstError: plain.firstError || stacks.firstError,
      stackCount: stackIds.length,
    }
  }
  const clearSelectionAndReload = () => { clearSelection(); refreshNavigation() }
  // ─── Card dragging (task 146): press a card and move ≥8px to drag. Drop on
  // ─── another card to build/join a stack (6s undo), on a sidebar group row /
  // ─── 待整理 to regroup, leave the window to hand off to the system drag, or
  // ─── reorder inside an unfiltered stack view. All mutable gesture state
  // ─── lives in refs; the highlight states only update when the target
  // ─── actually changes, so a moving pointer never re-renders the gallery.
  const cardDragRef = useRef<CardDragGesture | null>(null)
  const cardDragMutationRef = useRef(false)
  const suppressCardDragClickRef = useRef(false)
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const dropRef = useRef<CardDropTarget | null>(null)
  const sideDropRef = useRef<CardSideTarget | null>(null)
  const cardDragMoveRef = useRef<(event: PointerEvent) => void>(() => {})
  const cardDragUpRef = useRef<(event: PointerEvent) => void>(() => {})
  const cardDragCancelRef = useRef<(drag: CardDragGesture) => void>(() => {})
  const cardDragFinishRef = useRef<(drop: CardDropTarget | null, side: CardSideTarget | null, gesture: CardDragFinish) => void>(() => {})
  const [cardDropTarget, setCardDropTarget] = useState<CardDropTarget | null>(null)
  const [cardDropSide, setCardDropSide] = useState<CardSideTarget | null>(null)
  const [cardDragGhost, setCardDragGhost] = useState<{ src: string; count: number } | null>(null)
  const setCardDrop = (next: CardDropTarget | null) => {
    const prev = dropRef.current
    if (prev?.cardId === next?.cardId && prev?.placement === next?.placement && prev?.mode === next?.mode) return
    dropRef.current = next
    setCardDropTarget(next)
  }
  const setSideDrop = (next: CardSideTarget | null) => {
    if (JSON.stringify(sideDropRef.current) === JSON.stringify(next)) return
    sideDropRef.current = next
    setCardDropSide(next)
  }
  const cancelCardDrag = (drag: CardDragGesture) => {
    if (drag.frame !== null) { cancelAnimationFrame(drag.frame); drag.frame = null }
    drag.membersAbort?.abort()
    cardDragRef.current = null
    setCardDrop(null)
    setSideDrop(null)
    setCardDragGhost(null)
    document.body.classList.remove("gp-card-dragging")
  }
  const clearCardDragVisuals = () => {
    setCardDrop(null)
    setSideDrop(null)
    document.body.classList.remove("gp-card-dragging")
  }
  const onCardDragPointerDown = (a: MosaAsset, event: React.PointerEvent<HTMLButtonElement>) => {
    if (cardDragMutationRef.current || active === "回收站" || preview || settings) return
    if (event.button !== 0 || event.pointerType === "touch" || event.shiftKey) return
    const pressedId = a.id
    if (!pressedId) return
    // Only a highlighted card drags (task 155): a press on an unselected card
    // is a marquee, owned by onGridPointerDown.
    if (!cardIsSelected(pressedId)) return
    const insideStack = Boolean(stackId)
    // Inside a stack every card is a reorder candidate. In the root gallery
    // the whole selection drags; each stack card in it stands for its whole
    // stack (never just its cover).
    const dragIds = insideStack ? [pressedId] : dragIdsForCard(new Set(selectionIds), pressedId)
    const stackOf = stackOfCard()
    const stackIds = insideStack ? [] : [...new Set(dragIds.map(stackOf).filter(Boolean))]
    const nativeController = createNativeDragController({
      api: desktopAPI(),
      onError: () => notify(tr("当前素材无法拖出到其他应用")),
    })
    let pathsOverLimit = false
    let membersAbort: AbortController | null = null
    let membersPromise: Promise<{ paths: string[]; overLimit: boolean }> | null = null
    if (nativeController.supported()) {
      // Paths in selection order; cards a cross-page select-all fetched but
      // the grid has not loaded come from its snapshot.
      const loaded = new Map(assetsRef.current.map(item => [item.id, item]))
      const pathOf = pagesSnapshot()?.pathOf
      const pathOfCard = (id: string) => loaded.get(id)?.image_path || pathOf?.get(id) || ""
      if (stackIds.length) {
        // Start fetching the stacks' member paths on press (all pages, stack
        // order, deduplicated) so leaving the window never waits on the
        // network longer than it must; the gesture is abandoned silently if
        // the button is released while the fetch is still running.
        const abort = new AbortController()
        membersAbort = abort
        membersPromise = batchFilePaths(dragIds, { limit: NATIVE_DRAG_MAX_FILES, signal: abort.signal })
        membersPromise.catch(() => {})
      } else {
        const paths = nativeDragPaths(dragIds.map(id => ({ id, image_path: pathOfCard(id) })), dragIds)
        if (paths.length > NATIVE_DRAG_MAX_FILES) { paths.length = NATIVE_DRAG_MAX_FILES; pathsOverLimit = true }
        nativeController.begin(dragIds, paths)
      }
    }
    cardDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY,
      pressedId, dragIds, stackIds, insideStack,
      dragging: false, awaitingPaths: false, frame: null, pathsOverLimit,
      nativeController, membersAbort, membersPromise,
    }
    // Keep the gesture alive while the pointer leaves the window — that is the
    // moment the system drag takes over, and it needs the moves to detect it.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* window listeners keep the gesture alive */ }
  }
  const handOffToNativeDrag = (drag: CardDragGesture, event: PointerEvent): boolean => {
    const controller = drag.nativeController
    if (drag.awaitingPaths) return true
    if (!controller.supported() || !pointOutsideWindow(event, window)) return false
    if (!drag.stackIds.length) {
      if (!controller.startIfOutside(event, window)) return false
      if (drag.pathsOverLimit) notify(tr("一次最多拖出 512 个文件，已带出前 512 个"))
      cancelCardDrag(drag)
      suppressCardDragClickRef.current = true
      return true
    }
    // Hand-off with stacks: wait for the member paths (prefetch started on
    // press); a release during the wait aborts the fetch and the gesture
    // quietly.
    drag.awaitingPaths = true
    clearCardDragVisuals()
    drag.membersPromise?.then(({ paths, overLimit }) => {
      if (cardDragRef.current !== drag) return
      if (!paths.length || !controller.begin(drag.dragIds, paths) || !controller.startIfOutside(event, window)) {
        notify(tr("当前素材无法拖出到其他应用"))
      } else if (overLimit) {
        notify(tr("一次最多拖出 512 个文件，已带出前 512 个"))
      }
      cancelCardDrag(drag)
      suppressCardDragClickRef.current = true
    }).catch(() => {
      if (cardDragRef.current !== drag) return
      notify(tr("当前素材无法拖出到其他应用"))
      cancelCardDrag(drag)
      suppressCardDragClickRef.current = true
    })
    return true
  }
  // Reorder is only safe when the stack view shows the complete membership in
  // its canonical order (no search term, "all" types, no pending page): the
  // PATCH replaces the whole order, and a partial view would drop the tail.
  const stackReorderAllowed = () => {
    if (!stackId) return false
    if (debouncedQuery || assetType !== "all") return false
    if (nextCursor) return false
    return assets.length >= (pageTotal ?? assets.length)
  }
  const flushCardDragMove = (drag: CardDragGesture) => {
    if (!drag.dragging || drag.awaitingPaths || cardDragRef.current !== drag) return
    const x = drag.lastX
    const y = drag.lastY
    if (ghostRef.current) ghostRef.current.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`
    // Sidebar targets win over gallery cards. Inside a stack the sidebar does
    // not accept drops at all (same as the legacy gallery).
    const side = drag.insideStack ? null : sideDropTargetAt(x, y)
    if (side) {
      setSideDrop(side)
      setCardDrop(null)
      return
    }
    setSideDrop(null)
    const card = cardElementAt(x, y)
    if (!card) { setCardDrop(null); return }
    const cardId = card.getAttribute("data-asset-id") || ""
    if (!cardId) { setCardDrop(null); return }
    // A drag carrying stacks merges into the card under it (task 196), but
    // never into one of its own cards.
    if (drag.stackIds.length && drag.dragIds.includes(cardId)) { setCardDrop(null); return }
    if (drag.insideStack) {
      // Reorder insertion line; no line while over the dragged cards. With a
      // search term or an incomplete view the drag only serves the hand-off.
      if (!stackReorderAllowed() || drag.dragIds.includes(cardId)) { setCardDrop(null); return }
      const rect = card.getBoundingClientRect()
      const placement: "before" | "after" = x < rect.left + rect.width / 2 ? "before" : "after"
      setCardDrop({ cardId, placement, mode: "reorder" })
      return
    }
    setCardDrop({ cardId, placement: "before", mode: "stack-target" })
  }
  cardDragMoveRef.current = (event: PointerEvent) => {
    const drag = cardDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.lastX = event.clientX
    drag.lastY = event.clientY
    if (!drag.dragging) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < CARD_DRAG_THRESHOLD_PX) return
      drag.dragging = true
      document.body.classList.add("gp-card-dragging")
      const pressed = assetsRef.current.find(item => item.id === drag.pressedId)
      setCardDragGhost({
        src: pressed?.thumbnail_url || "",
        count: dragGhostCount({ assetIds: drag.dragIds }),
      })
    }
    if (handOffToNativeDrag(drag, event)) return
    event.preventDefault()
    if (drag.frame === null) drag.frame = requestAnimationFrame(() => { drag.frame = null; flushCardDragMove(drag) })
  }
  cardDragCancelRef.current = cancelCardDrag
  cardDragUpRef.current = (event: PointerEvent) => {
    const drag = cardDragRef.current
    if (!drag || event.pointerId !== drag.pointerId) return
    // A fast release can land before the coalesced frame runs: resolve the
    // latest pointer position synchronously so the drop target is never lost.
    if (drag.frame !== null) { cancelAnimationFrame(drag.frame); drag.frame = null }
    flushCardDragMove(drag)
    const completed = drag.dragging && !drag.awaitingPaths
    const drop = dropRef.current
    const side = sideDropRef.current
    const gesture: CardDragFinish = { dragIds: [...drag.dragIds], pressedId: drag.pressedId, stackIds: [...drag.stackIds], insideStack: drag.insideStack }
    cancelCardDrag(drag)
    if (!completed) return
    suppressCardDragClickRef.current = true
    cardDragFinishRef.current(drop, side, gesture)
  }
  useEffect(() => {
    const move = (event: PointerEvent) => cardDragMoveRef.current(event)
    const up = (event: PointerEvent) => cardDragUpRef.current(event)
    const cancel = (event: PointerEvent) => {
      const drag = cardDragRef.current
      if (drag && event.pointerId === drag.pointerId) cardDragCancelRef.current(drag)
    }
    const blur = () => {
      const drag = cardDragRef.current
      if (drag) cardDragCancelRef.current(drag)
    }
    const click = (event: MouseEvent) => {
      // The browser fires a synthetic click after pointerup; a finished drag
      // must not turn it into "select the pressed card".
      if (!suppressCardDragClickRef.current) return
      suppressCardDragClickRef.current = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    // A hand-off to the system drag never gets its pointerup or click back,
    // so a pending suppression must not outlive the gesture: the next real
    // press starts fresh and its click goes through.
    const press = () => { suppressCardDragClickRef.current = false }
    window.addEventListener("pointerdown", press, true)
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", cancel)
    window.addEventListener("blur", blur)
    window.addEventListener("click", click, true)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", cancel)
      window.removeEventListener("blur", blur)
      window.removeEventListener("click", click, true)
      window.removeEventListener("pointerdown", press, true)
    }
  }, [])
  const runStackUndo = async (undo: StackUndoPlan | null) => {
    if (!undo) return
    try {
      if (undo.kind === "dissolve-stack") await dissolveStack(undo.project, undo.stackId)
      else if (undo.kind === "remove-from-stack") await removeAssetsFromStack(undo.project, undo.stackId, undo.assetIds)
      else {
        // Unmerge: loosen everything the merge moved, then rebuild each
        // dragged stack with its old order, cover (first member) and name.
        if (undo.createdStackId) await dissolveStack(undo.project, undo.createdStackId)
        else if (undo.movedIds.length) {
          const loosened = await moveAssetsToStack(undo.project, undo.movedIds, null)
          if (loosened.failed) throw new Error(loosened.firstError || tr("撤销失败"))
        }
        for (const source of undo.sources) {
          if (source.memberIds.length < 2) continue
          const rebuilt = await createStack(undo.project, source.memberIds, source.memberIds[0])
          if (source.name && rebuilt.name !== source.name) await renameStack(undo.project, rebuilt.id, source.name)
        }
      }
      notify(tr("已撤销"))
      refreshCurrentView()
    } catch (error) { notify(errorMessage(error)) }
  }
  const runSideDrop = async (side: CardSideTarget, gesture: CardDragFinish) => {
    const groupName = side.kind === "group" ? side.name : ""
    cardDragMutationRef.current = true
    try {
      if (gesture.dragIds.length === 1 && gesture.stackIds.length === 1) {
        await assignStackToGroup(project, gesture.stackIds[0], groupName)
        notify(groupName ? fillNamed("堆叠已移动到「{group}」", { group: groupName }) : tr("堆叠已移出分组"))
      } else if (gesture.stackIds.length) {
        // A selection with stacks: every stack moves whole, plain cards as
        // themselves; the count is one per card, like the menu's batch.
        const outcome = await assignBatchToGroup(project, gesture.dragIds, groupName)
        if (!outcome.succeeded) { notify(outcome.firstError || tr(groupName ? "添加分组失败" : "移除分组失败")); return }
        notify(outcome.failed
          ? (groupName
              ? tr("已加入分组 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
              : tr("已从分组移除 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed)))
          : groupName
            ? fillNamed("已把 {count} 项移到「{group}」", { count: outcome.succeeded, group: groupName })
            : fillNamed("已把 {count} 项移出分组", { count: outcome.succeeded }))
      } else {
        const outcome = await setAssetsGroup(project, gesture.dragIds, groupName)
        if (!outcome.succeeded) { notify(outcome.firstError || tr(groupName ? "添加分组失败" : "移除分组失败")); return }
        notify(groupName
          ? fillNamed("已把 {count} 个素材移到「{group}」", { count: outcome.succeeded, group: groupName })
          : fillNamed("已把 {count} 个素材移出分组", { count: outcome.succeeded }))
      }
      applySelection([], "")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
    finally { cardDragMutationRef.current = false }
  }
  // Task 196: a drag carrying stacks merges. Onto a stack card, every
  // dragged stack's members (each in its own order) and the plain cards join
  // after the target's own members; the target keeps its name and cover.
  // Onto a plain card, they all form a new stack with that card as cover.
  // The server dissolves a stack once it is moved empty.
  const runStackMergeDrop = async (drop: CardDropTarget, gesture: CardDragFinish) => {
    if (!drop.cardId || gesture.dragIds.includes(drop.cardId)) return
    const targetAsset = assetsRef.current.find(item => item.id === drop.cardId)
    if (!targetAsset) return
    const originProject = targetAsset.project_id || project
    const stackOfCard = new Map<string, { id: string; name: string }>()
    for (const item of assetsRef.current) {
      if (item.stack?.id && gesture.dragIds.includes(item.id)) stackOfCard.set(item.id, { id: item.stack.id, name: item.stack.name || "" })
    }
    cardDragMutationRef.current = true
    try {
      const stackIds = [...new Set([...stackOfCard.values()].map(stack => stack.id))]
      const membersOf = new Map(await Promise.all(stackIds.map(async id => [id, await listStackMemberIds(originProject, id)] as const)))
      const { movedIds, sources } = planStackMerge(gesture.dragIds, stackOfCard, membersOf)
      const targetStack = targetAsset.stack?.id ? targetAsset.stack : null
      if (targetStack) {
        const outcome = await moveAssetsToStack(originProject, movedIds, targetStack.id)
        if (!outcome.succeeded) { notify(outcome.firstError || tr("合并堆叠失败")); return }
        const moved = movedIds.filter(id => !outcome.failedIds.includes(id))
        const undo: StackUndoPlan = { kind: "unmerge", project: originProject, movedIds: moved, sources }
        notifyWithAction(outcome.failed
          ? tr("已合并 X 项，Y 项失败").replace("X", String(outcome.succeeded)).replace("Y", String(outcome.failed))
          : targetStack.name
            ? fillNamed("已合并到堆叠「{name}」，共 {count} 项", { name: targetStack.name, count: moved.length })
            : fillNamed("已合并到堆叠，共 {count} 项", { count: moved.length }), {
          label: tr("撤销"),
          run: () => { void runStackUndo(undo) },
        })
      } else {
        // A new stack only takes loose assets: free the dragged stacks' members
        // first (their stacks dissolve), then stack everything on the target.
        const sourceIds = sources.flatMap(source => source.memberIds)
        const loosened = await moveAssetsToStack(originProject, sourceIds, null)
        if (loosened.failed) {
          notify(loosened.firstError || tr("合并堆叠失败"))
          refreshNavigation()
          return
        }
        const ids = [drop.cardId, ...movedIds]
        const stack = await createStack(originProject, ids, drop.cardId)
        const undo: StackUndoPlan = { kind: "unmerge", project: originProject, movedIds: [], sources, createdStackId: stack.id }
        notifyWithAction(fillNamed("已堆叠 {count} 项素材", { count: ids.length }), {
          label: tr("撤销"),
          run: () => { void runStackUndo(undo) },
        })
      }
      applySelection([], "")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)); refreshNavigation() }
    finally { cardDragMutationRef.current = false }
  }
  const runRootStackDrop = async (drop: CardDropTarget, gesture: CardDragFinish) => {
    if (gesture.stackIds.length) { void runStackMergeDrop(drop, gesture); return }
    if (!drop.cardId || gesture.dragIds.includes(drop.cardId)) return
    // Dropping a multi-selection back onto one of its own members is a common
    // tiny mouse-jitter path — treat it as a no-op instead of surprising the
    // user with a new stack.
    const targetAsset = assetsRef.current.find(item => item.id === drop.cardId)
    if (!targetAsset) return
    // The undo closes over the project the drop ran in, even if the user has
    // switched away by the time the button is pressed.
    const originProject = targetAsset.project_id || project
    cardDragMutationRef.current = true
    try {
      const targetStackId = targetAsset.stack?.id || ""
      if (targetStackId) {
        const toAdd = gesture.dragIds.filter(id => id !== drop.cardId)
        if (!toAdd.length) return
        await addAssetsToStack(originProject, targetStackId, toAdd)
        const undo = undoPlanForStackDrop({ kind: "added-to-stack", project: originProject, stackId: targetStackId, addedIds: toAdd, coverId: drop.cardId })
        notifyWithAction(fillNamed("已向堆叠加入 {count} 项素材", { count: toAdd.length }), {
          label: tr("撤销"),
          run: () => { void runStackUndo(undo) },
        })
      } else {
        const ids = [...gesture.dragIds, drop.cardId]
        const stack = await createStack(originProject, ids, drop.cardId)
        const undo = undoPlanForStackDrop({ kind: "created-stack", project: originProject, stackId: stack.id })
        notifyWithAction(fillNamed("已堆叠 {count} 项素材", { count: ids.length }), {
          label: tr("撤销"),
          run: () => { void runStackUndo(undo) },
        })
      }
      applySelection([], "")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
    finally { cardDragMutationRef.current = false }
  }
  const runReorderDrop = async (drop: CardDropTarget, gesture: { dragIds: string[] }) => {
    if (!drop.cardId || gesture.dragIds.includes(drop.cardId) || !stackReorderAllowed()) return
    const currentIds = assetsRef.current.map(item => item.id)
    const nextIds = moveBlockRelative(currentIds, gesture.dragIds, drop.cardId, drop.placement)
    if (nextIds.length === currentIds.length && nextIds.every((id, i) => id === currentIds[i])) return
    cardDragMutationRef.current = true
    try {
      await reorderStack(project, stackId, nextIds)
      refreshNavigation()
    } catch (error) {
      // A concurrent membership change can make the drag snapshot stale
      // between pointerdown and PATCH; reload the stack and ask for a new drag
      // instead of leaking the server's validation prose.
      if ((error as { code?: string })?.code === "STACK_ORDER_MISMATCH") {
        notify(tr("堆叠内容已发生变化，已刷新，请重新拖动排序"))
        refreshNavigation()
      } else notify(errorMessage(error))
    } finally { cardDragMutationRef.current = false }
  }
  cardDragFinishRef.current = (drop, side, gesture) => {
    if (side) { void runSideDrop(side, gesture); return }
    if (!drop) return
    if (gesture.insideStack) void runReorderDrop(drop, gesture)
    else void runRootStackDrop(drop, gesture)
  }
  const cardDropClassFor = (id: string) => {
    const drop = cardDropTarget
    if (drop?.cardId !== id) return ""
    if (drop.mode === "reorder") {
      return drop.placement === "before" ? "stack-reorder-target stack-reorder-before" : "stack-reorder-target stack-reorder-after"
    }
    return "card-drop-target"
  }
  // ⌘F / Ctrl+F, "/" and the desktop menu's Find all land here. The viewer
  // hides the toolbar, so Find from the viewer closes it first.
  const searchInputRef = useRef<HTMLInputElement>(null)
  const focusSearchRef = useRef<() => void>(() => {})
  focusSearchRef.current = () => {
    if (settings || pinterestActive) return
    if (preview) setPreview(false)
    window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, preview ? 50 : 0)
  }
  useEffect(() => {
    desktopAPI()?.onMenuSearch?.(() => focusSearchRef.current())
  }, [])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A live card drag consumes Escape on its own: cancel the gesture,
        // leave selection and dialogs alone.
        if (cardDragRef.current) {
          // The release after a cancelled drag must not select the pressed card.
          if (cardDragRef.current.dragging) suppressCardDragClickRef.current = true
          cancelCardDrag(cardDragRef.current)
          return
        }
        selectAllAbortRef.current?.abort()
        pendingSelectAllRef.current = null
        if (renameNoticeOpen) dismissRenameNotice()
        else if (deleting) setDeleting(false)
        else if (menu) setMenu(null)
        // Fullscreen sits above the viewer in the chain: Esc first leaves the
        // in-app fullscreen, and only a second Esc closes the viewer itself.
        else if (viewerFullscreen) setViewerFullscreen(false)
        else if (settings) setSettings(false)
        else if (preview) setPreview(false)
        else if (selectedIds.length || selected) applySelection([], "")
      }
      // Find works from inside a text field too (the desktop menu's Find is
      // the same key and arrives through onMenuSearch instead).
      if (isFocusSearchKey(e, {
        viewIsLibrary: !preview && !settings && !pinterestActive,
        hasBlockingOverlay: Boolean(menu || deleting || renameNoticeOpen),
        targetIsTextEntry: isEditableTarget(e.target),
        platform: isMacPlatform() ? "mac" : "other",
      })) {
        e.preventDefault()
        focusSearchRef.current()
        return
      }
      // Text surfaces own select-all, delete, cut and paste: Backspace in the
      // prompt editor, ⌘A in the search field and typing anywhere must never
      // trigger a gallery shortcut.
      if (isEditableTarget(e.target)) return
      // The Pinterest view hides the gallery: ⌘A then Delete there must not
      // select and trash library assets nobody can see.
      if (pinterestActive) return
      // Gallery keyboard navigation: arrows move the inspected card by its
      // on-screen neighbours, Enter opens it (or enters its stack). Off while
      // the viewer, Settings, a menu or a dialog is up, and for a batch.
      const plainKey = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      const galleryIdle = !preview && !settings && !menu && !deleting && !renameNoticeOpen
      if (plainKey && galleryIdle && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const grid = gridRef.current
        const current = selectionRef.current.selected || asset?.id || ""
        if (!grid || !current || selectionRef.current.selectedIds.length > 1) return
        const cards = Array.from(grid.querySelectorAll<HTMLElement>("[data-asset-id]")).map(element => {
          const rect = element.getBoundingClientRect()
          return { id: element.dataset.assetId || "", element, left: rect.left, top: rect.top, bottom: rect.bottom,
            centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 }
        }).filter(card => card.id)
        // Nothing inspected yet: the first arrow press lands on that card.
        const next = selectionRef.current.selected ? neighbourAssetId(cards, current, e.key) : current
        if (!next) return
        e.preventDefault()
        anchorIndexRef.current = assets.findIndex(a => a.id === next)
        applySelection([], next)
        cards.find(card => card.id === next)?.element.scrollIntoView({ block: "nearest" })
        return
      }
      if (plainKey && galleryIdle && e.key === "Enter") {
        // A focused toolbar or sidebar button keeps Enter for itself.
        const target = e.target instanceof HTMLElement ? e.target : null
        if (target?.closest("button, a, [role='menuitem']") && !target.closest("[data-asset-id]")) return
        const action = galleryKeyAction(e, {
          viewIsLibrary: true,
          hasSelection: selectionRef.current.selectedIds.length > 1,
          targetIsTextEntry: false,
          insideStack: Boolean(stackId),
          currentAsset: asset ? { stackId: asset.stack?.id } : null,
        })
        if (action === "none" || !asset) return
        e.preventDefault()
        if (action === "enter-stack" && asset.stack) goTo({ stackId: asset.stack.id, stackName: asset.stack.name || asset.name })
        else {
          focusAsset(asset.id)
          setPreview(true)
        }
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault()
        void selectAllAcrossPages()
        return
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !settings && !deleting && selectionIds.length > 0 && active !== "回收站"
        && (preview || selectedIds.length > 0 || selected !== implicitFocusRef.current)
      )
        // Same entry as the menu's 移至回收站: 不再提醒 skips the dialog.
        requestDelete()
      // Stack cards cannot be cut (the menu greys 剪切 out for them too).
      if ((e.metaKey || e.ctrlKey) && (e.key === "x" || e.key === "X") && selectionIds.length
        && !splitSelectionStacks(selectionIds).stackIds.length) {
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
  }, [settings, deleting, menu, viewerFullscreen, assets, asset, stackId, active, language, selectedIds, selected, selectionIds, preview, skipConfirm, renameNoticeOpen])
  // Fullscreen belongs to the open viewer, never outlives it: the back button,
  // Esc, a view switch, a project switch or a deleted asset all close the
  // viewer through setPreview(false), and the next viewer opens windowed.
  useEffect(() => {
    if (!preview) setViewerFullscreen(false)
  }, [preview])
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
  // toast and nothing imports. Files that already live in the library (a card
  // dragged out of the window and dropped back) are skipped, never re-imported.
  const importDroppedFiles = (dataTransfer: DataTransfer | null, groupName?: string) => {
    const topLevel = Array.from(dataTransfer?.files || [])
    const scan = collectDroppedFiles(dataTransfer, {
      onScanProgress: count => notify(fillNamed("正在扫描拖入的文件…已找到 {count} 个", { count })),
    })
    const flagLibrary = desktopAPI()?.libraryFileFlags
    const flags: Promise<boolean[]> = flagLibrary && topLevel.length
      ? flagLibrary(topLevel).catch(() => [])
      : Promise.resolve([])
    void Promise.all([scan, flags])
      .then(([result, flagged]) => {
        const { files, skipped } = excludeLibraryFiles(result.files, topLevel.filter((_, index) => flagged[index] === true))
        if (skipped && !files.length) {
          notify(fillNamed("{count} 个文件已在素材库中，没有重复导入", { count: skipped }))
          return
        }
        return importFiles(files, groupName)
      })
      .catch(error => notify(errorMessage(error)))
  }
  // Paste-to-import continuation (task 239): mirrors importDroppedFiles —
  // folders expand through the entry scan when the paste offers entries,
  // library files are skipped, raw image data is renamed — then points at
  // 「所有素材」 when the current view cannot show the fresh imports.
  const runPasteImport = async (topFiles: File[], entryScan: ReturnType<typeof collectDroppedFiles> | null) => {
    try {
      let scanned = topFiles
      let folderNotice = false
      if (entryScan) {
        scanned = (await entryScan).files
      } else {
        // Paste DataTransfers carry no entries (the entry API is drag-only):
        // a pasted folder arrives as one unreadable File. A one-byte read
        // probe separates folders from real files; folders cannot expand in
        // a paste, so they are skipped with a pointer to drag import.
        const unreadable = await Promise.all(topFiles.map(file =>
          file.slice(0, 1).arrayBuffer().then(() => false, () => true)))
        folderNotice = unreadable.some(Boolean)
        const files = topFiles.filter((_, index) => !unreadable[index])
        if (!files.length) {
          if (folderNotice) notify(tr("文件夹请拖进窗口导入"))
          return
        }
        scanned = files
      }
      const flagLibrary = desktopAPI()?.libraryFileFlags
      const flags: Promise<boolean[]> = flagLibrary && scanned.length
        ? flagLibrary(scanned).catch(() => [])
        : Promise.resolve([])
      const flagged = await flags
      const { files: kept, skipped } = excludeLibraryFiles(scanned, scanned.filter((_, index) => flagged[index] === true))
      if (skipped && !kept.length) {
        notify(fillNamed("{count} 个文件已在素材库中，没有重复导入", { count: skipped }))
        return
      }
      const createdIds = await importFiles(renameSynthesizedPasteFiles(kept, language, new Date()), groupNameForActive(active))
      if (createdIds.length && !importVisibleInActiveView({ active, query: debouncedQuery, assetType, stackId })) {
        notify(fillNamed("已导入 {count} 个，在「所有素材」里", { count: createdIds.length }))
      } else if (folderNotice) {
        notify(tr("文件夹请拖进窗口导入"))
      }
    } catch (error) {
      notify(errorMessage(error))
    }
  }
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const dataTransfer = event.clipboardData
      const topFiles = Array.from(dataTransfer?.files || [])
      const decision = pasteImportDecision({
        targetIsEditable: isEditableTarget(event.target),
        settingsOpen: settings,
        pinterestActive,
        hasOverlay: Boolean(menu || deleting || renameNoticeOpen || permanentDeleteIds || emptyTrashConfirm
          || groupDeleteConfirm || groupMerge || groupRename || stackRename || stackDissolveConfirm
          || stackTrashConfirm || groupStats || groupCreateWithSelection),
        cutActive: cutIdsRef.current.length > 0,
        trashView: active === "回收站",
        hasFiles: topFiles.length > 0,
      })
      if (decision !== "import") {
        if (decision === "trash-blocked") notify(tr("回收站里不能导入"))
        return
      }
      // collectDroppedFiles reads dataTransfer.items synchronously — inside
      // the paste event tick only, exactly like the drop handler.
      const entryScan = Array.from(dataTransfer?.items || [])
        .some(item => { try { return Boolean(item.webkitGetAsEntry?.()) } catch { return false } })
        ? collectDroppedFiles(dataTransfer, {
          onScanProgress: count => notify(fillNamed("正在扫描拖入的文件…已找到 {count} 个", { count })),
        })
        : null
      void runPasteImport(topFiles, entryScan)
    }
    window.addEventListener("paste", paste)
    return () => window.removeEventListener("paste", paste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing, library, active, project, stackId, settings, pinterestActive, menu, deleting, renameNoticeOpen,
    permanentDeleteIds, emptyTrashConfirm, groupDeleteConfirm, groupMerge, groupRename, stackRename,
    stackDissolveConfirm, stackTrashConfirm, groupStats, groupCreateWithSelection, language, debouncedQuery, assetType])
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
    const selection = selectionIds
    if (!selection.length) return
    // The undo restores against the project the deletion ran in, even if the
    // user has switched projects by the time the button is pressed.
    const originProject = asset?.project_id ?? project
    try {
      // A stack card in the selection stands for the whole stack: trash every
      // member (as the single-stack menu does), so undo restores all of them.
      const { plainIds, stackIds } = splitSelectionStacks(selection)
      const memberIds = (await Promise.all(stackIds.map(id => listStackMemberIds(originProject, id)))).flat()
      const ids = [...new Set([...plainIds, ...memberIds])]
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
  // 不再提醒 only skips plain moves: a selection holding a stack card takes
  // every member with it, so it always confirms.
  const requestDelete = () => {
    setMenu(null)
    if (skipConfirm && !splitSelectionStacks(selectionIds).stackIds.length) remove()
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
    if (api?.writeClipboardText) {
      // The bridge refuses oversized text (a huge path list) with ok: false.
      const result = await api.writeClipboardText(text) as { ok?: boolean } | undefined
      if (result?.ok === false) throw new Error("clipboard write refused")
      return
    }
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
  // Several files onto the system clipboard (task 198): what pastes into
  // Finder, Explorer, chat apps and web pages as that many files. A single
  // card's 复制图片 above still copies the pixels.
  const copyFiles = async (collect: (limit: number) => Promise<{ paths: string[]; overLimit: boolean }>) => {
    const api = desktopAPI()
    if (!api?.writeClipboardFiles) return
    try {
      const { paths, overLimit } = await collect(NATIVE_DRAG_MAX_FILES)
      const result = paths.length ? await api.writeClipboardFiles(paths) : null
      const count = Number(result?.count) || 0
      if (!result?.ok || !count) { notify(tr("复制图片失败")); return }
      const skipped = Number(result.skipped) || 0
      if (overLimit) notify(fillNamed("最多复制 {limit} 张，已复制前 {count} 张", { limit: NATIVE_DRAG_MAX_FILES, count }))
      else if (skipped) notify(fillNamed("已复制 {count} 张，{skipped} 张找不到", { count, skipped }))
      else notify(fillNamed("已复制 {count} 张图片", { count }))
    } catch { notify(tr("复制图片失败")) }
  }
  // Paths as text, one per line, same order and expansion as the files.
  const copyPaths = async (collect: () => Promise<{ paths: string[] }>) => {
    try {
      const { paths } = await collect()
      if (!paths.length) { notify(tr("复制失败")); return }
      await writeText(paths.join("\n"))
      notify(fillNamed("已复制 {count} 条路径", { count: paths.length }))
    } catch { notify(tr("复制失败")) }
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
      selectionHasStacks: splitSelectionStacks(ids).stackIds.length > 0,
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
      canCopyFiles: typeof desktopAPI()?.writeClipboardFiles === "function",
      // Asset and stack-card menus never offer paste-to-import: the blank-area
      // menus own it (task 239).
      clipboardImportable: false,
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
      canCopyFiles: typeof desktopAPI()?.writeClipboardFiles === "function",
      clipboardImportable: false,
    }
    const entries = translateMenuEntries(buildContextMenu(ctx), 0)
    setMenu({ x, y, entries, target: "stack", selectionCount: 0, stackId: stack.id, stackName: stack.name || cardName, stackCount: stack.count })
  }

  const openBlankMenu = (x: number, y: number) => {
    const inStack = Boolean(stackId)
    // Task 239: with a pending cut the blank-area 粘贴 moves the cut assets
    // (id "paste"); otherwise, when the main process reports importable
    // clipboard content, it offers paste-import. The clipboard query is
    // async — the menu opens without the entry and patches itself in when
    // the answer is yes; it never waits for the query.
    const api = desktopAPI()
    const clipboardImportable = active !== "回收站"
      && typeof api?.clipboardImportable === "function"
      && typeof api?.pasteFromClipboard === "function"
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
      canCopyFiles: typeof api?.writeClipboardFiles === "function",
      clipboardImportable: false,
    }
    const entries = translateMenuEntries(buildContextMenu(ctx), 0)
    // An empty builder result (stack surfaces inside the trash) opens nothing.
    if (!entries.length) return
    setMenu({ x, y, entries, target: ctx.target, selectionCount: 0, stackId, stackName, stackCount: assets.length })
    if (!clipboardImportable || !api) return
    const token = ++blankMenuTokenRef.current
    api.clipboardImportable!().then(importable => {
      if (!importable) return
      setMenu(current => {
        if (!current || current.target !== ctx.target || blankMenuTokenRef.current !== token) return current
        return { ...current, entries: translateMenuEntries(buildContextMenu({ ...ctx, clipboardImportable: true }), 0) }
      })
    }).catch(() => {})
  }

  const openGroupMenu = (name: string, x: number, y: number) => {
    const names = (navigation?.groups || []).map(item => item.name)
    const entries = translateMenuEntries(buildGroupMenu({ index: names.indexOf(name), groupCount: names.length, exporting: Boolean(exportingGroup) }), 0)
    setMenu({ x, y, entries, target: "group", selectionCount: 0, stackId: "", stackName: "", stackCount: 0, groupName: name })
  }

  // Sidebar group menu — every action reads the group the menu was opened on.
  const runGroupMenuAction = (name: string, id: string) => {
    if (id === "group-rename") setGroupRename({ original: name, draft: name })
    else if (id === "group-move-up" || id === "group-move-down") {
      const names = (navigation?.groups || []).map(item => item.name)
      const index = names.indexOf(name)
      const target = index + (id === "group-move-up" ? -1 : 1)
      if (index < 0 || target < 0 || target >= names.length) return
      ;[names[index], names[target]] = [names[target], names[index]]
      reorderGroups(project, names).then(refreshNavigation).catch(error => notify(errorMessage(error)))
    }
    else if (id.startsWith("group-color:")) {
      recolorGroup(project, name, id.slice("group-color:".length)).then(refreshNavigation).catch(error => notify(errorMessage(error)))
    }
    else if (id === "group-stats") {
      fetchGroupStats(project, name).then(result => setGroupStats({ name, values: result.stats })).catch(error => notify(errorMessage(error)))
    }
    else if (id === "group-export") {
      if (exportingGroup) return
      const originProject = project
      setExportingGroup(name)
      fetchRawGroupAssets(originProject, name).then(records => {
        const payload = { exportedAt: new Date().toISOString(), project: originProject, group: name,
          assets: records.map(sanitizeAssetForExport) }
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }))
        try {
          const link = document.createElement("a")
          link.href = url
          link.download = `gravityport-group-${name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group"}.json`
          document.body.appendChild(link)
          link.click()
          link.remove()
        } finally { window.setTimeout(() => URL.revokeObjectURL(url), 30_000) }
      }).catch(error => notify(errorMessage(error))).finally(() => setExportingGroup(""))
    }
    else if (id === "group-merge") {
      const other = navigation?.groups.find(item => item.name !== name)
      if (other) setGroupMerge({ source: name, target: other.name })
    }
    else if (id === "group-delete") setGroupDeleteConfirm(name)
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
    assignBatchToGroup(asset.project_id, batchIds, name)
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
    if (target.target === "group") { if (target.groupName) runGroupMenuAction(target.groupName, id); return }
    const ids = [...batchIds]
    // Asset menu
    if (id === "open-viewer") setPreview(true)
    else if (id === "show-in-library") showInLibrary()
    else if (id === "copy-image") {
      if (ids.length > 1) void copyFiles(limit => batchFilePaths(ids, { limit }))
      else void copyImage()
    }
    else if (id === "cut") {
      cutIdsRef.current = ids
      notify("已剪切")
    }
    else if (id === "copy-prompt") {
      if (!asset?.prompt) { notify(tr("无提示词记录")); return }
      writeText(asset.prompt).then(() => notify(`${tr("复制提示词")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
    }
    else if (id === "copy-path" && ids.length > 1) void copyPaths(() => batchFilePaths(ids))
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
    else if (id === "stack-copy-images") void copyFiles(limit => stackFilePaths([{ kind: "stack", stackId: target.stackId }], undefined, limit))
    else if (id === "stack-copy-paths") void copyPaths(() => stackFilePaths([{ kind: "stack", stackId: target.stackId }]))
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
    // Task 239: the main process performs one webContents.paste(); the window
    // paste listener above does the importing — ⌘V and the menu share one path.
    else if (id === "paste-import") void desktopAPI()?.pasteFromClipboard?.()
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
  const checkForUpdates = async () => {
    const api = desktopAPI()
    if (!api?.checkForUpdates) { notify(tr("网页版请访问官网获取最新版本")); return }
    if (updateState.phase === "checking") return
    setUpdateState({ phase: "checking" })
    try {
      const result = await api.checkForUpdates(true)
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
    setUpdateState({ phase: "downloading", percent: 0, latestVersion: updateState.latestVersion, publishedAt: updateState.publishedAt, canInstallInApp: updateState.canInstallInApp, notes: updateState.notes })
    try {
      await api.downloadAndInstallUpdate()
    } catch (error) {
      setUpdateState(current => current.phase === "downloading"
        ? { phase: "available", latestVersion: current.latestVersion || "", publishedAt: current.publishedAt || "", canInstallInApp: current.canInstallInApp !== false, notes: current.notes }
        : current)
      notify(tr("更新失败，请稍后重试"))
    }
  }
  // Task 231 — restart into the staged, verified update. The install flow
  // re-reads the manifest and re-verifies the package in the main process; on
  // success it relaunches the new version, so the promise only resolves when
  // something kept this window alive.
  const restartToUpdate = async () => {
    const api = desktopAPI()
    if (!api?.downloadAndInstallUpdate) return
    if (restartPending) return
    setRestartPending(true)
    try {
      const result = await api.downloadAndInstallUpdate() as { status?: string } | undefined
      if (result?.status === "installing") return
      setRestartPending(false)
      if (result?.status !== "cancelled") notify(tr("更新失败，请稍后重试"))
    } catch {
      setRestartPending(false)
      notify(tr("更新失败，请稍后重试"))
    }
  }
  const cancelUpdateDownload = () => {
    desktopAPI()?.cancelUpdateDownload?.()
    setUpdateState(current => current.phase === "downloading"
      ? { phase: "available", latestVersion: current.latestVersion || "", publishedAt: current.publishedAt || "", canInstallInApp: current.canInstallInApp !== false, notes: current.notes }
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
  const sourceInfo = asset ? describeSource(asset, language) : null
  const headerLine = sourceInfo ? inspectorHeaderLine(sourceInfo, tr) : ""
  const promptNoticeInfo = asset ? promptNotice(asset) : null
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
  // The one set of card event handlers shared by both render paths (mount-all
  // branch and windowed card()), including the drag-gesture entry point.
  const cardEventHandlers = (a: MosaAsset) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => onCardDragPointerDown(a, event),
    onClick: (event: React.MouseEvent) => {
      // Stacks behave like plain cards here: one click
      // selects (the inspector shows the cover). The second
      // press of a double-click must not re-run selection —
      // the dblclick handler owns entering the stack.
      if (event.detail > 1) return
      selectCard(a.id, event)
    },
    onDoubleClick: () => {
      if (a.stack) {
        // No selection reset here: the load effect resets the selection on the
        // view change anyway, and leaving this view first records the cover
        // card as the focused one so coming back re-inspects it (task 152).
        goTo({ stackId: a.stack.id, stackName: a.stack.name || a.name })
        return
      }
      focusAsset(a.id)
      setPreview(true)
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      // Right-clicking outside the multi-selection re-targets the
      // context menu to the clicked card; inside it, the whole
      // selection stays the action target. Stack cards follow the
      // same grammar: alone, they get the stack menu (open, rename,
      // dissolve, act on that stack); inside a multi-selection they
      // get the batch menu, so trash and group actions take the
      // whole selection. Trash keeps its restore menu, but stack
      // cards stay inert there.
      if (a.stack && active === "回收站") return
      const inMultiSelection = selectedIds.includes(a.id) && batchIds.length > 1
      if (!selectedIds.includes(a.id)) applySelection([], a.id)
      else focusAsset(a.id)
      if (a.stack && !inMultiSelection) {
        openStackMenu(a.stack, a.name, e.clientX, e.clientY)
        return
      }
      openAssetMenu(a, e.clientX, e.clientY)
    },
  })

  return (
    <div
      ref={appRef}
      className={`app ${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : ""} ${nativeChromeClass} ${preview && viewerFullscreen ? "viewer-fullscreen" : ""}`}
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
          {["所有素材", "Pinterest", "待整理", "收藏", "回收站"].filter(label => PINTEREST_ENTRY || label !== "Pinterest").map(
            (label) => (
              <button
                key={label}
                title={tr(label)}
                aria-label={tr(label)}
                aria-current={active === label ? "page" : undefined}
                className={`nav-row ${active === label ? "selected" : ""} ${label === "待整理" && cardDropSide?.kind === "ungrouped" ? "side-drop-target" : ""}`}
                {...(label === "待整理" ? { "data-drop-ungroup": "" } : {})}
                onClick={() => {
                  goTo({ active: label, stackId: "", stackName: "" })
                  setSelectedIds([])
                }}
              >
                {label === "Pinterest" ? <span className="brand-icon" aria-hidden="true" /> : <Icon
                  name={label === "待整理" ? "inbox" : label === "收藏" ? "heart" : label === "回收站" ? "trash" : "grid"}
                  size={16}
                />}
                <span>{tr(label)}</span>
                <small>
                  {label === "所有素材"
                    ? navigation?.total ?? 0
                    : label === "Pinterest"
                      // Pinterest stays in Trial access (1,000 calls a day shared
                      // by every user) until Standard access is approved, so the
                      // count slot says so until boards have been loaded.
                      ? pinterestBoards ? `${pinterestBoards.count}${pinterestBoards.complete ? "" : "+"}` : <span className="nav-soon">{tr("暂未开放")}</span>
                      : label === "待整理"
                        ? navigation?.unorganized ?? 0
                        : label === "收藏"
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
                } ${g.id.startsWith("group:") && cardDropSide?.kind === "group" && cardDropSide.name === g.name ? "side-drop-target" : ""}`}
                key={g.id}
                title={tr(g.name)}
                aria-label={tr(g.name)}
                aria-current={active === g.id ? "page" : undefined}
                {...(g.id.startsWith("group:") ? { "data-drop-group": g.name } : {})}
                onClick={() => { goTo({ active: g.id, stackId: "", stackName: "" }); setSelectedIds([]) }}
                onContextMenu={event => {
                  if (section !== 1) return
                  event.preventDefault()
                  openGroupMenu(g.name, event.clientX, event.clientY)
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
        {updateReady && (
          <button
            className="user-button"
            style={{ marginTop: "var(--space-2)" }}
            disabled={restartPending}
            title={fill(tr("重启并更新到 v{version}"), { version: updateReady.version || "" })}
            onClick={restartToUpdate}
          >
            <Icon name="enter" size={14} />
            <span>{fill(tr("重启并更新到 v{version}"), { version: updateReady.version || "" })}</span>
          </button>
        )}
      </aside>
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
          }}><h3>{tr("重命名分组")}</h3><input autoFocus value={groupRename.draft} maxLength={80} onChange={event => setGroupRename(old => old ? { ...old, draft: event.target.value } : old)} /><div className="group-dialog-actions"><button type="button" className="neutral-button" onClick={() => setGroupRename(null)}>{tr("取消")}</button><button type="submit" className="primary-button">{tr("保存")}</button></div></form>}
          {groupDeleteConfirm && <><h3>{tr("删除分组")}</h3><p>{tr("仅删除分组，保留其中全部素材。")}</p><div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupDeleteConfirm(null)}>{tr("取消")}</button><button className="primary-button" onClick={() => {
            const name = groupDeleteConfirm
            deleteGroupKeepingAssets(project, name).then(() => {
              if (active === `group:${name}`) goTo({ active: "所有素材" })
              refreshNavigation(); setGroupDeleteConfirm(null)
            }).catch(error => notify(errorMessage(error)))
          }}>{tr("删除分组")}</button></div></>}
          {groupMerge && <><h3>{tr("合并分组")}</h3><p>{groupMerge.source} →</p><select value={groupMerge.target} onChange={event => setGroupMerge(old => old ? { ...old, target: event.target.value } : old)}>{navigation?.groups.filter(item => item.name !== groupMerge.source).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select><div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupMerge(null)}>{tr("取消")}</button><button className="primary-button" onClick={() => {
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
              <div className="group-dialog-actions"><button className="neutral-button" onClick={() => setGroupStats(null)}>{tr("关闭")}</button></div>
            </>
          })()}
        </div>
      </div>}

      {/* Stack rename dialog */}
      {stackRename && (
        <div className="group-dialog-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setStackRename(null) }}>
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
                <button type="button" className="neutral-button" onClick={() => setStackRename(null)}>{tr("取消")}</button>
                <button type="submit" className="primary-button">{tr("保存")}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Stack dissolve confirmation */}
      {stackDissolveConfirm && (
        <div className="modal-layer delete-layer" onClick={event => { if (event.target === event.currentTarget) setStackDissolveConfirm(null) }}>
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
        <div className="modal-layer delete-layer" onClick={event => { if (event.target === event.currentTarget) setStackTrashConfirm(null) }}>
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
        <div className="group-dialog-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) setGroupCreateWithSelection(null) }}>
          <div className="group-dialog" role="dialog" aria-modal="true" aria-label={tr("新建分组并移入")}>
            <form onSubmit={event => {
              event.preventDefault()
              const name = groupCreateWithSelection.draft.trim()
              if (!name) return
              const target = groupCreateWithSelection
              createGroup(project, name)
                .then(() => {
                  if (target.target === "stack" && target.targetStackId) return assignStackToGroup(project, target.targetStackId, name).then(() => {})
                  return assignBatchToGroup(project, [...batchIds], name).then(outcome => {
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
                <button type="button" className="neutral-button" onClick={() => setGroupCreateWithSelection(null)}>{tr("取消")}</button>
                <button type="submit" className="primary-button">{tr("保存")}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <main
        className={`workspace ${preview ? "preview-open" : ""}`}
        onDragOver={event => {
          if (preview || settings || active === "回收站" || pinterestActive) return
          event.preventDefault()
        }}
        onDrop={event => {
          if (preview || settings || active === "回收站" || pinterestActive) return
          event.preventDefault()
          importDroppedFiles(event.dataTransfer, groupNameForActive(active))
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
            ) : pinterestActive ? null : (
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
                    ref={searchInputRef}
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
          <ImageViewer key={asset?.id} width={asset?.width || 768} height={asset?.height || 1170} src={asset?.preview_url || asset?.image_url} isVideo={asset?.mediaKind === "video"} language={language} disabled={settings || deleting || !!menu} fullscreen={viewerFullscreen} onNavigate={navigateAsset} onToggleFullscreen={() => setViewerFullscreen(v => !v)} onContextMenu={(x, y) => { if (asset) openAssetMenu(asset, x, y) }} message={toast?.text ?? ""} />
        ) : pinterestActive ? (
          <PinterestView
            key={pinterestViewKey}
            language={language}
            onOpenSettings={() => { setSettingTab("连接"); setSettings(true) }}
            onBoardCountChange={(count, complete) => setPinterestBoards({ count, complete })}
          />
        ) : (
          <>
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
                    className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""} ${cardDropClassFor(a.id)}`}
                    style={{ aspectRatio: `${a.width} / ${a.height}` }}
                    {...cardEventHandlers(a)}
                  >
                    {a.thumbnail_url ? <ThumbMedia className="black-image" src={a.thumbnail_url} srcSet={galleryImageSrcSet(a) || undefined} sizes="240px" alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="black-image" />}
                    {a.mediaKind === "video" && <VideoMark />}
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
                  className={`asset-card ${selectionSet.has(a.id) && !settings ? "asset-selected" : ""} ${cardDropClassFor(a.id)}`}
                  style={placementStyle(globalIndex)}
                  {...cardEventHandlers(a)}
                >
                  {a.thumbnail_url ? <ThumbMedia className="black-image" src={a.thumbnail_url} srcSet={galleryImageSrcSet(a) || undefined} sizes={galleryImageSizes(model.placements[globalIndex]?.width ?? model.columnWidth)} alt="" loading="lazy" decoding="async" draggable={false} /> : <div className="black-image" />}
                  {a.mediaKind === "video" && <VideoMark />}
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
          {showToTop && (
            <button
              className="gallery-to-top"
              aria-label={tr("回到顶部")}
              title={tr("回到顶部")}
              onClick={() => gridRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            >
              <Icon name="to-top" size={16} />
            </button>
          )}
          </>
        )}
      </main>
      {detail && asset && !(pinterestActive && !preview) && (
        <aside className="details">
          <div className="detail-heading">
            <strong>{tr("素材详情")}</strong>
            <button aria-label={tr("关闭素材详情")} onClick={() => setDetail(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="asset-summary">
            <button className="summary-image" aria-label={tr("预览当前素材")} onClick={() => setPreview(true)}>{asset.thumbnail_url ? <ThumbMedia src={asset.thumbnail_url} alt="" /> : null}{asset.mediaKind === "video" && <VideoMark />}<Icon name="expand" /></button>
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
              <span className="muted">{headerLine}</span>
              <button className="summary-preview" onClick={() => setPreview(true)}>{tr("打开预览")}<Icon name="right" size={12} /></button>
            </div>
          </div>
          <div className="asset-properties">
              {[
                ["格式", asset.format || "—"],
                ["尺寸", asset.width > 1 && asset.height > 1 ? `${asset.width} × ${asset.height}` : "—"],
                ["比例", aspectRatioLabel(asset.width, asset.height)],
                ["大小", humanSize(asset.size_bytes)],
              ].map(([label, value]) => (
                <span className="property-tag" key={label} title={`${tr(label)}: ${tr(value)}`} aria-label={`${tr(label)}: ${tr(value)}`}>{tr(value)}</span>
              ))}
              {sourceInfo?.groupLabel ? (
                <span className="property-tag" title={`${tr("分组")}: ${sourceInfo.groupLabel}`} aria-label={`${tr("分组")}: ${sourceInfo.groupLabel}`}>{sourceInfo.groupLabel}</span>
              ) : null}
          </div>
          <div className="tags" ref={tagsRowRef}>
            {(expandedTags ? tagItems : tagItems.slice(0, collapsedTagCount)).map((t, index) => (
              index === 0 && tagVendor ? (
                <span className="tag-chip tag-vendor" key={`vendor-${t}`}>{t}</span>
              ) : (
                <span className="tag-chip" key={`tag-${t}`}>
                  <span>{t}</span>
                  <button aria-label={`${tr("移除标签")} ${t}`} title={`${tr("移除标签")} ${t}`}
                    onClick={() => {
                      const remaining = removeTagFromStored(currentTags, t)
                      updateAssetMetadata(asset.project_id, asset.id, { tags: remaining })
                        .then(updated => setAssets(old => old.map(item => item.id === updated.id ? mergeAssetDetail(item, updated) : item)))
                        .catch(error => notify(errorMessage(error)))
                    }}>×</button>
                </span>
              )
            ))}
            {expandedTags
              ? <button className="tags-toggle" aria-expanded="true" onClick={() => setExpandedTags(false)}>{tr("收起")}</button>
              : (collapsedTagCount < tagItems.length && <button className="tags-toggle" aria-expanded="false" onClick={() => setExpandedTags(true)}>{`+${tagItems.length - collapsedTagCount}`}</button>)}
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
            {/* Measuring twin last: document-order lookups of .add-tag / .tags-toggle
             * must reach the live controls, never these inert copies. */}
            <div className="tags-measure" aria-hidden="true" ref={tagsMeasureRef}>
              {tagItems.map((t, index) => (
                <span className={`tag-chip${index === 0 && tagVendor ? " tag-vendor" : ""}`} data-tag-measure-item key={`measure-${index}-${t}`}>
                  {t}
                  {!(index === 0 && tagVendor) && <button tabIndex={-1}>×</button>}
                </span>
              ))}
              <button className="tags-toggle" data-tag-measure-toggle>{`+${Math.max(0, tagItems.length - collapsedTagCount)}`}</button>
              <button className="add-tag" data-tag-measure-add><Icon name="plus" size={12} />{tr("添加标签")}</button>
            </div>
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
              <>
                <ReadingText
                  id="asset-prompt"
                  text={shownPrompt || tr(promptNoticeInfo?.key === "webPromptUnavailable" ? "网页来源未暴露原始生图提示词" : "无提示词记录")}
                  expanded={expandedPrompt}
                  onToggle={() => setExpandedPrompt(!expandedPrompt)}
                  expandLabel={tr("展开提示词")}
                  collapseLabel={tr("收起")}
                />
                {promptVariant === 1 && promptNoticeInfo && promptNoticeInfo.key !== "webPromptUnavailable" && (
                  <p className="prompt-provenance">{tr(promptNoticeInfo.text)}</p>
                )}
              </>
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
              {(() => {
                // The badge is the conversation's captured-image count
                // (context mode); truncated counts stay hidden. Plain mode
                // keeps the raw event count.
                const badgeCount = versionRounds.mode === "context"
                  ? versionRounds.images
                  : generationHistory?.events?.length || 0
                if (versionRounds.mode !== "context" && !badgeCount) return null
                return <span className="field-actions">
                  {badgeCount ? <span className="settings-badge">{badgeCount}</span> : null}
                  <button className="section-action" aria-expanded={versionTreeOpen} onClick={() => setVersionTreeOpen(!versionTreeOpen)}>{tr(versionTreeOpen ? "收起" : "查看")}</button>
                </span>
              })()}
            </div>
            {/* One list for the generation records: the record IS the version
                tree entry — its output's thumbnail on the left, prompt on the
                first line and the conversation-rounds text on the second.
                Conversation mode lists every captured image of the current
                ChatGPT conversation (three around this asset by default, all
                when expanded); the current row is highlighted and inert, the
                others jump to that image. Plain mode keeps the events list
                with the time/provider/model line. */}
            <div className="version-list" aria-label={tr("版本树")}>
              {versionRounds.mode === "context"
                ? (versionTreeOpen ? conversationRoundRows(generationHistory, asset?.id || "") : versionRounds.rows).map((row) => {
                  const output = row.outputAsset || (row.isCurrent ? asset : undefined)
                  return InspectorRow({
                    key: String(row.outputAsset?.id || row.event.id || row.event.output_asset_id),
                    thumbnailUrl: output?.thumbnail_url,
                    isCurrent: row.isCurrent,
                    title: (row.event.effective_prompt || row.event.user_prompt || tr("无提示词记录")).slice(0, 60),
                    detail: roundLine(row, versionRounds, roundText),
                    onClick: () => { if (!row.isCurrent && row.outputAsset?.id) selectHistoryAsset(row.outputAsset.id) },
                  })
                })
                : (generationHistory?.events || []).slice(0, versionTreeOpen ? undefined : 3).map((event, index) => {
                  const output = event.output_asset_id
                    ? generationHistory?.output_assets?.find(item => item.id === event.output_asset_id)
                      || (asset && asset.id === event.output_asset_id ? asset : undefined)
                    : undefined
                  return InspectorRow({
                    key: String(event.id || index),
                    thumbnailUrl: output?.thumbnail_url,
                    title: (event.effective_prompt || event.user_prompt || tr("无提示词记录")).slice(0, 60),
                    detail: `${timeLabel(event.created_at)}${event.provider ? ` · ${event.provider}` : ""}${event.model ? ` · ${event.model}` : ""}${event.turn_index != null ? ` · ${tr("轮次")} ${event.turn_index}` : ""}`,
                    onClick: () => { if (event.output_asset_id) selectHistoryAsset(event.output_asset_id) },
                  })
                })}
              {!generationHistory?.events?.length && <span className="muted">{tr("暂无生成关系")}</span>}
            </div>
            {versionTreeOpen && (() => {
              // Every block below renders the same thumbnail rows as the list
              // above; no gen- id may reach this region (task 148).
              const currentAssetId = asset?.id || ""
              const anchorRecordIds = (() => {
                const seen = new Set<string>()
                return [
                  ...(generationHistory?.events || []),
                  ...(generationHistory?.context_events || []),
                ].filter((event) => {
                  const id = String(event.id || "")
                  if (!id || seen.has(id)) return false
                  seen.add(id)
                  return String(event.output_asset_id || "") === currentAssetId
                }).sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || ""))
                  || String(left.id || "").localeCompare(String(right.id || "")))
              })()
              const fallbackAnchorId = String(anchorRecordIds[0]?.id || generationHistory?.events?.[0]?.id || "")
              // The picker rows are asset-keyed (relatedChoices returns no
              // generation ids); resolve the clicked asset back to its earliest
              // generation record here — ids live in state, never in a row.
              const generationIdForAsset = (assetId: string) => {
                const seen = new Set<string>()
                for (const event of [...(generationHistory?.events || []), ...(generationHistory?.context_events || [])]) {
                  const id = String(event.id || "")
                  if (!id || seen.has(id)) continue
                  seen.add(id)
                  if (String(event.output_asset_id || "") === assetId) return id
                }
                return ""
              }
              const candidateList = (generationHistory?.relation_candidates || [])
                .filter(candidate => candidate.status !== "dismissed" && candidate.status !== "confirmed")
              const jumpToDisplay = (display: GenerationDisplay) => (
                display.known && display.asset && !display.isCurrent ? () => selectHistoryAsset(display.asset!.id) : undefined
              )
              const turnLine = (turnIndex: number | null) => (turnIndex != null ? fillNamed(tr("第 {n} 轮"), { n: turnIndex }) : "")
              return <div className="version-tree" role="region" aria-label={tr("完整版本树")}>
                {(() => {
                  // 任务 217：对话模式也能任选两轮并排对比。有输出图的轮次
                  // 不足两个时不出这块；默认目标 = 当前素材那一轮、基准 =
                  // 它的上一轮（当前在第一轮时改为第一轮 vs 第二轮）。
                  const selection = roundCompareSelection(conversationRoundRows(generationHistory, asset?.id || ""), asset?.id || "")
                  if (!selection) return null
                  const roundEntry = (row: ConversationRoundRow): VersionCompareEntry => {
                    const output = row.outputAsset
                    return {
                      id: String(output?.id || ""),
                      label: row.turnIndex !== null ? fillNamed(tr("第 {n} 轮"), { n: row.turnIndex }) : tr("无轮次"),
                      imageUrl: output?.medium_url || output?.preview_url || output?.image_url || "",
                      values: {
                        "尺寸": output ? `${output.width} × ${output.height}` : "",
                        "用户指令": row.event.user_prompt || "",
                        "提示词": row.event.effective_prompt || "",
                      },
                    }
                  }
                  return <VersionCompare
                    key={`rounds-${asset?.id || ""}`}
                    language={language}
                    captions
                    fields={["尺寸", "用户指令", "提示词"]}
                    entries={selection.options.map(roundEntry)}
                    defaultBaseId={String(selection.base.outputAsset?.id || "")}
                    defaultTargetId={String(selection.target.outputAsset?.id || "")}
                  />
                })()}
                <h4>{tr("生成关系")}</h4>
                {generationTreeRows(generationHistory).map(({ event, depth, parentIds, relationTypes }) => {
                  const display = generationDisplay(generationHistory, event.id, asset)
                  const ancestry = !parentIds.length
                    ? tr("根节点")
                    : relationTypes[0] === "edited_from" ? tr("改自上一张") : tr(String(relationTypes[0] || "derived_from"))
                  return InspectorRow({
                    key: `tree-${event.id}`,
                    rowClassName: "generation-tree-row",
                    indent: depth,
                    emptyThumb: !display.known,
                    thumbnailUrl: display.asset?.thumbnail_url,
                    isCurrent: display.isCurrent,
                    title: display.known ? (display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录")) : tr("不在这段对话里的生成记录"),
                    detail: `${ancestry}${display.turnIndex != null ? ` · ${turnLine(display.turnIndex)}` : ""}`,
                    staticRow: !display.known,
                    onClick: jumpToDisplay(display),
                  })
                })}
                {(generationHistory?.relations || []).map(relation => {
                  const key = `${relation.child_generation_id}|${relation.parent_generation_id}|${relation.relation_type}`
                  const locked = relation.verification_level === "provider_verified"
                  const upstream = generationDisplay(generationHistory, relation.parent_generation_id, asset)
                  const downstream = generationDisplay(generationHistory, relation.child_generation_id, asset)
                  return <div className="generation-relation-editor" key={key}>
                    <span className="relation-pair-row">
                      <RelationThumb display={upstream} />
                      <Icon name="right" size={12} />
                      <RelationThumb display={downstream} />
                      <small>{relationPairLine(upstream, downstream)}</small>
                    </span>
                    <select disabled={locked || relationBusy} aria-label={tr("关系类型")} value={relationDrafts[key] || relation.relation_type} onChange={event => setRelationDrafts(old => ({ ...old, [key]: event.target.value }))}>
                      {relationTypes.map(type => <option key={type} value={type}>{tr(type)}</option>)}
                    </select>
                    {locked ? <small>{tr("提供方验证关系不可修改")}</small> : <>
                      <button disabled={relationBusy} onClick={() => void mutateRelation(() => editGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, previousRelationType: relation.relation_type, relationType: relationDrafts[key] || relation.relation_type, evidence: relation.evidence }))}>{tr("保存关系")}</button>
                      <button disabled={relationBusy} onClick={() => { if (window.confirm(tr("确认删除这条生成关系？"))) void mutateRelation(() => removeGenerationRelation(project, { childGenerationId: relation.child_generation_id, parentGenerationId: relation.parent_generation_id, relationType: relation.relation_type })) }}>{tr("删除关系")}</button>
                    </>}
                  </div>
                })}
                {candidateList.length > 0 && <h4>{tr("候选关系")}</h4>}
                {candidateList.map(candidate => {
                  const upstream = generationDisplay(generationHistory, candidate.parent_generation_id, asset)
                  const downstream = generationDisplay(generationHistory, candidate.child_generation_id, asset)
                  return <div className="generation-relation-editor generation-candidate-card" key={`${candidate.child_generation_id}|${candidate.parent_generation_id}`}>
                    <span className="relation-pair-row">
                      <RelationThumb display={upstream} onClick={jumpToDisplay(upstream)} label={tr("查看素材")} />
                      <Icon name="right" size={12} />
                      <RelationThumb display={downstream} onClick={jumpToDisplay(downstream)} label={tr("查看素材")} />
                      <small>{relationPairLine(upstream, downstream)}</small>
                    </span>
                    <small>{fillNamed(tr("把握 {percent}%"), { percent: Math.round((candidate.confidence || 0) * 100) })}</small>
                    <button disabled={relationBusy} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: candidate.child_generation_id, parentGenerationId: candidate.parent_generation_id, relationType: candidate.suggested_relation_type || "derived_from", evidence: candidate.evidence }))}>{tr("确认关系")}</button>
                    <button disabled={relationBusy} onClick={() => void mutateRelation(() => dismissGenerationCandidate(project, candidate.child_generation_id, candidate.parent_generation_id))}>{tr("忽略候选")}</button>
                  </div>
                })}
                {!!generationHistory?.events?.length && <div className="generation-relation-editor">
                  <button disabled={relationBusy} onClick={() => {
                    setNewRelation({ anchor: fallbackAnchorId, other: "", direction: "candidate-parent", type: "edited_from" })
                    setShowAllRelationChoices(false)
                  }}>{tr("添加生成关系")}</button>
                  {newRelation && (() => {
                    const choices = relatedChoices(generationHistory, newRelation.anchor, asset)
                    const visibleChoices = showAllRelationChoices ? choices : choices.slice(0, 6)
                    return <div className="generation-relation-create">
                      {anchorRecordIds.length > 1
                        ? <div className="relation-choice-list" aria-label={tr("当前生成")}>
                          {anchorRecordIds.map(record => {
                            const display = generationDisplay(generationHistory, String(record.id), asset)
                            return InspectorRow({
                              key: `anchor-${record.id}`,
                              thumbnailUrl: display.asset?.thumbnail_url,
                              isCurrent: display.isCurrent,
                              selected: newRelation.anchor === String(record.id),
                              title: display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录"),
                              detail: turnLine(display.turnIndex),
                              showChevron: false,
                              onClick: () => setNewRelation(old => old ? { ...old, anchor: String(record.id) } : old),
                            })
                          })}
                        </div>
                        : (() => {
                          const display = generationDisplay(generationHistory, newRelation.anchor, asset)
                          return InspectorRow({
                            key: "anchor-current",
                            thumbnailUrl: display.asset?.thumbnail_url ?? asset?.thumbnail_url,
                            isCurrent: true,
                            title: display.prompt ? display.prompt.slice(0, 60) : tr("无提示词记录"),
                            detail: turnLine(display.turnIndex),
                            showChevron: false,
                            staticRow: true,
                          })
                        })()}
                      <div className="relation-choice-list" aria-label={tr("关联生成")}>
                        {choices.length === 0
                          ? <span className="muted">{tr("这段对话里没有别的图可以关联")}</span>
                          : <>
                            {visibleChoices.map(choice => InspectorRow({
                              key: `choice-${choice.asset.id}`,
                              thumbnailUrl: choice.asset.thumbnail_url,
                              selected: newRelation.other === generationIdForAsset(String(choice.asset.id)),
                              title: choice.prompt ? choice.prompt.slice(0, 60) : tr("无提示词记录"),
                              detail: turnLine(choice.turnIndex),
                              showChevron: false,
                              onClick: () => setNewRelation(old => old ? { ...old, other: generationIdForAsset(String(choice.asset.id)) } : old),
                            }))}
                            {choices.length > 6 && <button className="relation-show-all" onClick={() => setShowAllRelationChoices(!showAllRelationChoices)}>
                              {showAllRelationChoices ? tr("收起") : fillNamed(tr("显示全部 {count} 张"), { count: choices.length })}
                            </button>}
                          </>}
                      </div>
                      <select aria-label={tr("关系方向")} value={newRelation.direction} onChange={event => setNewRelation(old => old ? { ...old, direction: event.target.value } : old)}><option value="candidate-parent">{tr("关联项为上游")}</option><option value="candidate-child">{tr("关联项为下游")}</option></select>
                      <select aria-label={tr("关系类型")} value={newRelation.type} onChange={event => setNewRelation(old => old ? { ...old, type: event.target.value } : old)}>{relationTypes.map(type => <option value={type} key={type}>{tr(type)}</option>)}</select>
                      <button disabled={relationBusy || !newRelation.other || newRelation.other === newRelation.anchor} onClick={() => void mutateRelation(() => createGenerationRelation(project, { childGenerationId: newRelation.direction === "candidate-child" ? newRelation.other : newRelation.anchor, parentGenerationId: newRelation.direction === "candidate-child" ? newRelation.anchor : newRelation.other, relationType: newRelation.type }))}>{tr("确认添加")}</button>
                    </div>
                  })()}
                </div>}
                <h4>{tr("版本历史")}</h4>
                {(versions || []).map(v => InspectorRow({
                  key: `version-${v.id}`,
                  thumbnailUrl: v.thumbnail_url,
                  // The inspector shows `asset` (the first card when nothing is
                  // selected), so that is the current version; it does not jump.
                  isCurrent: v.id === asset?.id,
                  title: `${tr("版本")} ${v.version_index}`,
                  detail: [v.version_change || "", timeLabel(v.created_at)].filter(Boolean).join(" · "),
                  onClick: v.id === asset?.id ? undefined : () => selectHistoryAsset(v.id),
                }))}
                {versions && versions.length > 1 && <VersionCompare
                  key={`family-${asset?.id || ""}`}
                  language={language}
                  fields={["尺寸", "提示词", "版本"]}
                  entries={versions.map(v => ({
                    id: v.id,
                    label: `${tr("版本")} ${v.version_index}`,
                    imageUrl: v.medium_url || v.preview_url || v.image_url,
                    values: {
                      "尺寸": `${v.width} × ${v.height}`,
                      "提示词": v.prompt,
                      "版本": v.version_change || "",
                    },
                  }))}
                  defaultBaseId={versions[0].id}
                  defaultTargetId={versions[versions.length - 1].id}
                />}
              </div>
            })()}
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
                ["连接", "link"],
                ["反馈", "message"],
                ["关于", "info"],
              ].filter(([label]) => (PINTEREST_ENTRY || label !== "连接")).map(([label, icon]) => (
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
              ) : settingTab === "连接" ? (
                <>
                  <PinterestConnectionCard language={language} onStatusChange={onPinterestStatus} />
                  <McpClientConfigCard language={language} />
                  <WebCaptureStatusCard language={language} />
                </>
              ) : settingTab === "反馈" ? (
                <FeedbackPanel language={language} />
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
                      // Task 231 — a verified staged package wins: both entry
                      // points restart into it instead of re-downloading.
                      if (updateReady) {
                        return <button className="neutral-button about-update" onClick={restartToUpdate} disabled={restartPending}>{tr("重启并更新")}</button>
                      }
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
                  {(() => {
                    const blocks = buildReleaseNoteBlocks({
                      productVersion: health?.productVersion || "",
                      distribution: health?.distribution || "",
                      language,
                      t: tr,
                      updateState,
                    })
                    return (
                      <>
                        {blocks.map((block, index) => (
                          <section key={`${index}-${block.title}`} className="settings-section release-notes" aria-label={block.title}>
                            <div className="release-heading">
                              <h4>{block.title}</h4>
                              {block.date ? <span>{block.date}</span> : null}
                            </div>
                            <ul>
                              {block.lines.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}
                            </ul>
                          </section>
                        ))}
                        <section className="settings-section release-notes">
                          <p className="release-meta">
                            {tr("版本")} {health?.productVersion || "—"} · {tr("构建")} {health?.gitSha ? health.gitSha.slice(0, 7) : "—"} · {health?.distribution === "development" ? tr("开发版") : tr("正式版")}
                          </p>
                        </section>
                      </>
                    )
                  })()}
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
      {cardDragGhost && (
        <div className="card-drag-ghost" ref={ghostRef} aria-hidden="true">
          {cardDragGhost.src
            ? <ThumbMedia src={cardDragGhost.src} alt="" draggable={false} />
            : <span className="card-drag-ghost-fallback" />}
          {cardDragGhost.count > 1 && <span className="card-drag-ghost-count">{cardDragGhost.count}</span>}
        </div>
      )}
    </div>
  )
}
