import { createLanguageApplier, createT, resolveLocale } from "./i18n-runtime.mjs";
import { createBridgeStatusPoller } from "./bridge-status-poller.mjs";
import { createStatusLiveRegion } from "./status-live-region.mjs";
import {
  FACET_KEYS, LIBRARY_REFRESH_INTERVAL, LIVE_REGION_WRITE_DELAY, SCOPES, SETTINGS_SYNC_DEBOUNCE_MS, SIDEBAR_SOURCE_TYPES, SKELETON_TILE_COUNT, SOURCE_LABEL_KEYS, STATUS_ANNOUNCEMENT_DURATION,
} from "./config.mjs";
import {
  cardShortTitle, debounce, displayAssetTitle, escapeHtml, formatDate, normalizeSort, safeStorageGet, safeStorageSet,
  CONFIRM_MOVE_TO_TRASH_KEY, moveToTrashConfirmSuppressed, setMoveToTrashConfirmSuppressed,
} from "./utils.mjs";
import { createToastManager } from "./toast-manager.mjs";
import { createApiClient, mosaMutationHeaders } from "./api-client.mjs";
import { createConfirmDialog } from "./confirm-dialog.mjs";
import { createImagePreviewViewer } from "./image-preview.mjs";
import { createAssetViewer } from "./asset-view.mjs";
import { createInspectorMarkup, DETAIL_TAGS_VISIBLE_LIMIT, inspectorPaletteSwatches, generationContextRows } from "./inspector-markup.mjs";
import { createInspectorOverlay } from "./inspector-overlay.mjs";
import { assetTags, derivePromptTags, uniqueTags } from "./tag-utils.mjs";
import { pathEllipsisSegments } from "./middle-ellipsis.mjs";
import { createContextMenu } from "./context-menu.mjs";
import { createContextMenuActions } from "./context-menu-actions.mjs";
import { bindContextMenuEvents } from "./context-menu-bindings.mjs";
import { createGallerySelection } from "./gallery-selection.mjs";
import { createAssetStackController } from "./asset-stacks.mjs";
import { createCutPasteController } from "./cut-paste.mjs";
import { createLibraryReconciler } from "./library-reconciliation.mjs";
import { createNavigationHistory } from "./navigation-history.mjs";
import { collectDroppedFiles, createBatchImporter, dropErrorMessage } from "./batch-import.mjs";
import { createNativeAssetDrag } from "./native-asset-drag.mjs";
let libraryRefreshTimer = null;
let settingsSyncTimer = null;
let settingsSyncScheduled = false;
const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

// ===== GravityPort A3：缩略图大小滑杆与画廊列数（任务 70）=====
// 目标卡宽 120–400px、步长 20、默认 200（1440 宽、检视器关闭时约 5 列）；
// 列数 = max(1, min(上限, floor((内容宽 + 列间距) / (目标宽 + 列间距))))。
// 独立导出供契约测试直接求值。
const GALLERY_SIZE_STORAGE_KEY = "mosa.gallery-card-size";
const GALLERY_SIZE_MIN = 120;
const GALLERY_SIZE_MAX = 400;
const GALLERY_SIZE_STEP = 20;
const GALLERY_SIZE_DEFAULT = 200;
const GALLERY_MAX_COLUMNS = 10;

export function computeGalleryColumnCount(contentWidth, targetCardWidth, gap, maxColumns = GALLERY_MAX_COLUMNS) {
  const width = Number(contentWidth);
  const target = Number(targetCardWidth);
  const gapValue = Number(gap) || 0;
  if (!Number.isFinite(width) || width <= 0) return 1;
  if (!Number.isFinite(target) || target <= 0) return 1;
  const cap = Number.isFinite(maxColumns) && maxColumns >= 1 ? Math.floor(maxColumns) : GALLERY_MAX_COLUMNS;
  return Math.max(1, Math.min(cap, Math.floor((width + gapValue) / (target + gapValue))));
}

// 滑杆组三态判定（任务 70 返工 1，用户 10-06 拍板）：能放下时滑杆组中心对准
// 整个窗口的中线（centerX = 窗口中线换算到顶栏坐标系，检视器开关都一样）；
// 放不下（与左右两组各留 12px 呼吸边距）时退让到左组右缘与右组左缘之间的
// 空白里居中；连空白都放不下（空白 < 组宽 + 24）才隐藏。坐标一律是顶栏
// border-box 内的 px：centered/recentered 都返回行内 left（CSS 的 50% 是顶栏
// 中线、不等于窗口中线，只作 JS 跑起来前的兜底），hidden 返回 null（删行内
// 值）。独立导出供契约测试直接求值。
export const TOPBAR_SIZE_GROUP_MARGIN = 12;

export function computeTopbarSizeGroupPlacement(centerX, leftGroupRight, rightGroupLeft, groupWidth, margin = TOPBAR_SIZE_GROUP_MARGIN) {
  if (!Number.isFinite(centerX) || !Number.isFinite(groupWidth) || groupWidth <= 0
    || !Number.isFinite(leftGroupRight) || !Number.isFinite(rightGroupLeft) || rightGroupLeft < leftGroupRight) {
    return { mode: "hidden", left: null };
  }
  if (centerX - groupWidth / 2 >= leftGroupRight + margin && centerX + groupWidth / 2 <= rightGroupLeft - margin) {
    return { mode: "centered", left: centerX };
  }
  if (rightGroupLeft - leftGroupRight - margin * 2 >= groupWidth) {
    return { mode: "recentered", left: (leftGroupRight + rightGroupLeft) / 2 };
  }
  return { mode: "hidden", left: null };
}

function clampGalleryCardSize(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return GALLERY_SIZE_DEFAULT;
  const stepped = Math.round((raw - GALLERY_SIZE_MIN) / GALLERY_SIZE_STEP) * GALLERY_SIZE_STEP + GALLERY_SIZE_MIN;
  return Math.min(GALLERY_SIZE_MAX, Math.max(GALLERY_SIZE_MIN, stepped));
}

let galleryTargetCardWidth = clampGalleryCardSize(safeStorageGet(GALLERY_SIZE_STORAGE_KEY));

function trashRemainingDays(deletedAt) {
  const deletedAtMs = Date.parse(String(deletedAt || ""));
  if (!Number.isFinite(deletedAtMs)) return 0;
  return Math.max(0, Math.ceil((deletedAtMs + TRASH_RETENTION_MS - Date.now()) / (24 * 60 * 60 * 1000)));
}
let libraryEventSource = null;
let sidebarGroupEdit = null;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function assetSourceLabel(asset = {}) {
  const type = String(asset.source?.type || asset.sourceType || "");
  return sourceTypeLabel(type);
}

function sourceTypeLabel(type) {
  const cleanType = String(type || "");
  return SOURCE_LABEL_KEYS[cleanType] ? t(SOURCE_LABEL_KEYS[cleanType]) : (cleanType || t("sourceUnknown"));
}

// 用户中心头像字母：取安装 ID 里第一个英文字母转大写（安装 ID 是 UUID，十六进制
// 字母都落在 a–f）。拿不到 ID（浏览器版、接口缺失、返回空、无字母）一律回落 G。
// 独立导出供契约测试直接求值。
export function userCenterInitial(userId) {
  const match = String(userId ?? "").match(/[a-zA-Z]/);
  return match ? match[0].toUpperCase() : "G";
}

// 桌面版启动后异步取安装 ID：不阻塞启动，先显示 G，拿到后更新头像字母并记忆到
// state（设置「关于」页的用户 ID 行据此渲染；打开着设置弹窗时原地重建一次）。
async function hydrateUserCenter() {
  if (!window.electronAPI?.getUserProfile || !els.userCenterAvatar) return;
  try {
    const profile = await window.electronAPI.getUserProfile();
    const userId = String(profile?.userId || "").trim();
    if (!userId) return;
    state.userProfileId = userId;
    els.userCenterAvatar.textContent = userCenterInitial(userId);
    if (els.settingsMenu && !els.settingsMenu.hidden) renderSettingsMenu({ force: true });
  } catch {
    // 取不到就保持 G；「关于」页不出现用户 ID 行。
  }
}

const preference = safeStorageGet("mosa.ui-language") || "system";
// The inspector docks as a fixed right column only where the desktop layout
// applies. This must match the ≤767px drawer breakpoint (MOBILE_NAVIGATION_QUERY
// and styles.css): docking at 701–767 force-opened the inspector, and the drawer
// stylesheet hides the drawer toggle while the inspector is open, so navigation
// became unreachable in that band.
const INSPECTOR_DOCKED_MEDIA = "(min-width: 768px)";

function isInspectorDocked() {
  return typeof window.matchMedia === "function" && window.matchMedia(INSPECTOR_DOCKED_MEDIA).matches;
}

// ===== 任务 81 返工 1：主题三态（跟随系统 / 浅色 / 深色）。 =====
// 存储沿用 mosa-dark-mode：历史取值 "true"=深色、"false"=浅色 原样有效；
// "system"、缺失或未知值都按「跟随系统」处理（新用户默认跟随系统）。
// state.darkMode 保留为「实际生效的深浅」（跟随系统时由系统外观推导），
// 其余读主题的代码（data-theme、深色专用样式）拿到的永远是 light/dark。
const THEME_SYSTEM = "system";
const systemDarkQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function resolveThemeSetting(raw) {
  if (raw === "true") return "dark";
  if (raw === "false") return "light";
  return THEME_SYSTEM;
}

function themeSettingStorageValue(setting) {
  if (setting === "dark") return "true";
  if (setting === "light") return "false";
  return THEME_SYSTEM;
}

function systemPrefersDark() {
  return Boolean(systemDarkQuery?.matches);
}

function effectiveDarkMode(setting) {
  return setting === "dark" || (setting === THEME_SYSTEM && systemPrefersDark());
}

const initialThemeSetting = resolveThemeSetting(safeStorageGet("mosa-dark-mode"));

const state = {
  project: "default", assets: [], pageTotal: 0, nextCursor: null, loadedPageCount: 0, loadedAssetCount: 0, selectedId: null, selectedIds: new Set(), selectedStackNodes: new Map(), selectionProject: "default", selectionRequestKey: "", detailAsset: null, detailStack: null, versionHistory: null, recipeHistory: null, generationHistory: null, detailOpen: false, detailManuallyClosed: false, detailDirty: false, detailReturnFocus: null, imagePreviewId: null, previewReturnFocus: null, query: "",
  scope: "all", facets: { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" }, sort: normalizeSort(safeStorageGet("mosa.asset-sort")),
  mediaKind: "all",
  groups: { total: 0, favorites: 0, unorganized: 0, trash: 0, sourceTypes: [], groups: [] },
  galleryStatus: "loading", galleryError: null, paginationStatus: "idle", showCardInfo: safeStorageGet("mosa.card-info") === "show", storageKind: "unknown",
  libraryPath: "", libraryRoot: "", codexImagesDir: "", groupSaving: false, libraryMoveInProgress: false, modalReturnFocus: null, languagePreference: preference, locale: resolveLocale(preference),
  dragCounter: 0,
  stagingInProgress: false, // Paste import re-entrancy guard: one clipboard import at a time
  productVersion: "",
  webCaptureStatus: null,
  updateStatus: "idle",
  latestVersion: "",
  updatePublishedAt: "",
  updateCanInstallInApp: false,
  updateDownloadPercent: 0,
  visualModelStatus: null,
  darkMode: effectiveDarkMode(initialThemeSetting), settingsReturnFocus: null,
  // 任务 81 返工 1：主题设置三态（system/light/dark，跟随系统为默认）。darkMode
  // 是它推导出的「实际生效」值；系统外观变化时由 matchMedia 监听实时更新。
  themeSetting: initialThemeSetting,
  // 用户中心：安装 ID（桌面版经 user-profile IPC 取得，浏览器版恒空）。
  userProfileId: "",
  // 设置弹窗当前分类（两栏标签页）。仅会话内记忆，不写本地存储；重建后停留原分类。
  settingsPage: "general",
  sidebarSmartCollapsed: safeStorageGet("mosa.sidebar-smart-collapsed") === "true",
  sidebarManualCollapsed: safeStorageGet("mosa.sidebar-manual-collapsed") === "true",
  detailReturnFocusAssetId: null, previewReturnFocusAssetId: null,
  // 任务 35：检视器「+N」标签展开状态。会话内 UI 状态（同 settingsPage，不写本地存储）：
  // 只在当前检视器、当前素材内保持——切素材在 renderDetail 重置，同素材重渲染（增删标签、
  // 语言切换、后台刷新）保留；由 toggleDetailTagsExpanded 翻转。
  detailTagsExpanded: false,
  imageZoom: 1, imagePanX: 0, imagePanY: 0,
  // Bulk-selection gate. The viewer short-circuits while batch mode is active so
  // Phase 3A / D4：专用大图查看模式最小状态——viewMode 二值（library/asset）+ 进入时的
  // 画廊返回快照。不复刻搜索/筛选/排序状态、不深拷贝 state、无第二套 selectedAsset、无平行 Router。
  viewMode: "library", libraryReturnSnapshot: null,
  activeStackId: "", activeStackSummary: null, stackReturnSnapshot: null,
  assetStackDragCandidate: false,
  // 任务 93：剪切粘贴状态。cutAssetIds 是待移动集合（卡片变淡），cutProjectId
  // 是发起剪切时的项目口径（项目变化即视为取消）；两者都由 cut-paste.mjs 维护。
  cutAssetIds: new Set(), cutProjectId: "",
};

// ===== i18n 运行时（resolveLocale/t/applyLanguage 已提取至 i18n-runtime.mjs）=====
const t = createT({ getLocale: () => state.locale });
const applyLanguage = createLanguageApplier({
  state,
  t,
  refreshUI: () => {
    window.electronAPI?.setLocale?.(state.locale);
    // Locale changes are the only settings update that needs fresh copy.
    // Rebuild without replaying the dialog entrance animation.
    renderSettingsMenu({ force: true });
    if (els.sortSelect) els.sortSelect.value = state.sort;
    renderQuickFilters();
    updateViewTitle();
    renderGrid();
    // Language changes must not destroy an in-progress Inspector draft. The
    // gallery and chrome update immediately; the Inspector adopts the locale
    // on the next safe render after save/discard.
    if (state.detailOpen && !isDetailEditorActive()) renderDetail();
  },
});

const els = {
  searchInput: document.querySelector("#searchInput"), quickFilters: document.querySelector("#quickFilters"),
  typeFilters: document.querySelector(".topbar-type-filters"),
  navHistoryBack: document.querySelector("#navHistoryBack"), navHistoryForward: document.querySelector("#navHistoryForward"),
  topbarSizeGroup: document.querySelector("#topbarSizeGroup"), gallerySizeSlider: document.querySelector("#gallerySizeSlider"), gallerySizeMinus: document.querySelector("#gallerySizeMinus"), gallerySizePlus: document.querySelector("#gallerySizePlus"),
  sidebar: document.querySelector("#appSidebar"), mobileNavToggle: document.querySelector("#mobileNavToggle"), mobileNavClose: document.querySelector("#mobileNavClose"), mobileNavScrim: document.querySelector("#mobileNavScrim"),
  sortSelect: document.querySelector("#sortSelect"),
  categorySelect: document.querySelector("#categorySelect"),
  settingsToggle: document.querySelector("#settingsToggle"), settingsMenu: document.querySelector("#settingsMenu"), userCenterAvatar: document.querySelector("#userCenterAvatar"), sidebarGroupList: document.querySelector("#sidebarGroupList"), sidebarManualGroupList: document.querySelector("#sidebarManualGroupList"), smartGroupsToggle: document.querySelector("#smartGroupsToggle"), assetCategoriesToggle: document.querySelector("#assetCategoriesToggle"), addGroupBtn: document.querySelector("#addGroupBtn"), openInspectorBtn: document.querySelector("#openInspectorBtn"), groupModal: document.querySelector("#groupModal"), closeGroupModal: document.querySelector("#closeGroupModal"), cancelGroupBtn: document.querySelector("#cancelGroupBtn"), saveGroupBtn: document.querySelector("#saveGroupBtn"), groupNameInput: document.querySelector("#groupNameInput"), stackRenameModal: document.querySelector("#stackRenameModal"), stackRenameModalTitle: document.querySelector("#stackRenameModalTitle"), stackRenameModalInput: document.querySelector("#stackRenameInput"), stackRenameModalClose: document.querySelector("#stackRenameModalClose"), cancelStackRenameBtn: document.querySelector("#cancelStackRenameBtn"), saveStackRenameBtn: document.querySelector("#saveStackRenameBtn"), groupStatsModal: document.querySelector("#groupStatsModal"), closeGroupStatsModal: document.querySelector("#closeGroupStatsModal"), groupStatsCloseBtn: document.querySelector("#groupStatsCloseBtn"), groupStatsBody: document.querySelector("#groupStatsBody"), imagePreviewModal: document.querySelector("#imagePreviewModal"), imagePreviewStage: document.querySelector("#imagePreviewStage"), imagePreviewImage: document.querySelector("#imagePreviewImage"), imagePreviewVideo: document.querySelector("#imagePreviewVideo"), imagePreviewTitle: document.querySelector("#imagePreviewTitle"), closeImagePreview: document.querySelector("#closeImagePreview"),
  viewTitle: document.querySelector("#viewTitle"), statusText: document.querySelector("#statusText"), bridgeStatus: document.querySelector("#bridgeStatus"), bridgeStatusLabel: document.querySelector("#bridgeStatusLabel"), bridgeStatusMeta: document.querySelector("#bridgeStatusMeta"), appShell: document.querySelector("#appShell"), assetGrid: document.querySelector("#assetGrid"), detailPanel: document.querySelector("#detailPanel"), toastContainer: document.querySelector("#toastContainer"), toastErrorContainer: document.querySelector("#toastErrorContainer")
};

// #statusText 是唯一的读屏播报区：临时播报（导入进度、拖入提示等）与桥接状态
// 的轮询写入共用；两条写入规则见 status-live-region.mjs。
const statusRegion = createStatusLiveRegion({
  getRegion: () => els.statusText,
  liveRegionWriteDelay: LIVE_REGION_WRITE_DELAY,
  announcementDuration: STATUS_ANNOUNCEMENT_DURATION,
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: (handle) => window.clearTimeout(handle),
});

// asset-view 的导航状态更新由 asset-view.mjs 工厂闭包持有。保持顶层函数声明
// （提升使其在下方 createApiClient 参数求值时可引用），运行时再委托给已初始化的 viewer。
function updateAssetViewNav() {
  assetViewer.updateAssetViewNav();
}

// Data prefetch happens before the next page enters the DOM. Warm only real
// derivatives, never originals, so predictive browsing cannot turn into a
// burst of full-resolution decodes. Keeping a small rolling set gives the next
// viewport immediate pixels while leaving the remaining page to normal lazy
// loading and card virtualization.
const galleryPrewarmImages = new Set();
function prewarmAssetMedia(assets = []) {
  const urls = [];
  for (const asset of assets) {
    if (urls.length >= 24) break;
    if (!asset?.thumbnail_ready || !asset.thumbnail_url || asset.thumbnail_url === asset.image_url) continue;
    urls.push(asset.thumbnail_url);
  }
  urls.forEach((url) => {
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    const release = () => galleryPrewarmImages.delete(image);
    image.addEventListener("load", release, { once: true });
    image.addEventListener("error", release, { once: true });
    galleryPrewarmImages.add(image);
    image.src = url;
  });
}

// ===== API client + data loading（apiFetch 与数据加载已提取至 api-client.mjs，R1 批次 3）=====
const apiClient = createApiClient({
  state,
  els,
  renderSettingsMenu,
  renderDetail,
  renderQuickFilters,
  renderGrid,
  updateViewTitle,
  renderErrorState,
  updateAssetViewNav,
  selectedAsset,
  isDetailEditorActive,
  prewarmAssetMedia,
  refreshSelectedStackInspector,
});
const { apiFetch, loadProjects, loadStats, switchProjectWorkspace, loadAssets, refreshLibraryIfChanged, refreshAssetPageTotalInBackground, performFullGalleryReconciliation, reconcileLibraryRevision, noteLibraryRevision, getLibraryRevisionBaseline, setLibraryDeltaApplier, fetchLibraryChanges, resetAssetPrefetch, requestAssetPage, currentAssetRequest, assetRequestKey, assetListVersion, setGalleryBusy } = apiClient;

// ===== New element references =====
Object.assign(els, {
  dragOverlay: document.querySelector("#dragOverlay"),
  libraryView: document.querySelector("#libraryView"),
  assetView: document.querySelector("#assetView"),
  assetViewBack: document.querySelector("#assetViewBack"),
  assetViewScope: document.querySelector("#assetViewScope"),
  assetViewTitle: document.querySelector("#assetViewTitle"),
  assetViewStage: document.querySelector("#assetViewStage"),
  assetViewImage: document.querySelector("#assetViewImage"),
  assetViewVideo: document.querySelector("#assetViewVideo"),
  assetViewError: document.querySelector("#assetViewError"),
  assetViewControls: document.querySelector("#assetViewControls"),
  assetZoomOut: document.querySelector("#assetZoomOut"),
  assetZoomIn: document.querySelector("#assetZoomIn"),
  assetZoomFit: document.querySelector("#assetZoomFit"),
  // GravityPort A4c（任务 90）：右上「删除 / 全屏」；适合窗口沿用 #assetZoomFit。
  assetViewDelete: document.querySelector("#assetViewDelete"),
  assetViewFullscreen: document.querySelector("#assetViewFullscreen"),
  stackBack: document.querySelector("#stackBack"),
  emptyTrashBtn: document.querySelector("#emptyTrashBtn"),
  assetZoomValue: document.querySelector("#assetZoomValue"),
  assetViewNav: document.querySelector("#assetViewNav"),
  assetViewPrev: document.querySelector("#assetViewPrev"),
  assetViewNext: document.querySelector("#assetViewNext"),
  assetViewPosition: document.querySelector("#assetViewPosition"),
  // Phase 5B / F-15：全应用唯一 ConfirmDialog（替换 window.confirm 的四条确认路径）。
  confirmDialog: document.querySelector("#confirmDialog"),
  confirmDialogCard: document.querySelector("#confirmDialogCard"),
  confirmDialogTitle: document.querySelector("#confirmDialogTitle"),
  confirmDialogDescription: document.querySelector("#confirmDialogDescription"),
  confirmDialogCancel: document.querySelector("#confirmDialogCancel"),
  confirmDialogConfirm: document.querySelector("#confirmDialogConfirm"),
  confirmDialogDontAsk: document.querySelector("#confirmDialogDontAsk"),
  confirmDialogDontAskCheckbox: document.querySelector("#confirmDialogDontAskCheckbox"),
});

function gallerySelectionRects() {
  const grid = els.assetGrid;
  if (!grid || !galleryCardVirtualGeometryById.size || !galleryCardVirtualGeometryColumns.length) return null;
  const styles = getComputedStyle(grid);
  const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
  const gap = Number.parseFloat(styles.getPropertyValue("--gallery-gap")) || Number.parseFloat(styles.columnGap) || 0;
  const columnWidth = galleryCardVirtualColumnWidth || galleryCardColumnWidth(styles);
  const result = [];
  for (const geometry of galleryCardVirtualGeometryById.values()) {
    const left = paddingLeft + geometry.columnIndex * (columnWidth + gap);
    const top = paddingTop + Math.max(0, geometry.rowStart - 1);
    const slotHeight = Math.max(1, geometry.rowEnd - geometry.rowStart);
    const cardHeight = Math.max(1, slotHeight - gap);
    result.push({
      id: geometry.id,
      rect: {
        left,
        right: left + columnWidth,
        top,
        bottom: top + cardHeight,
      },
    });
  }
  return result;
}

const gallerySelection = createGallerySelection({
  els,
  state,
  t,
  announceGalleryStatus,
  currentAssetRequest,
  requestAssetPage,
  apiFetch,
  showToast,
  getCardSelectionRects: gallerySelectionRects,
  getCardSelectionGeometryVersion: () => galleryCardVirtualGeometryRevision,
  getSelectionAsset: (id) => galleryCardVirtualEntries.get(id)?.asset || null,
  getRenderedSelectionCard: (id) => galleryCardVirtualNode(els.assetGrid, id),
});

const batchImporter = createBatchImporter({
  state,
  apiFetch,
  stageFile: stageBrowserFile,
  cleanupStagedFile,
  isSupportedFile: isSupportedImportFile,
  announce: announceGalleryStatus,
  showToast,
  refreshLibrary: async () => {
    await Promise.all([loadStats(), loadAssets()]);
  },
  t,
});

const nativeAssetDrag = createNativeAssetDrag({ els, state, showToast, t });

// 外部修改重画检视器时焦点不能丢：整块 innerHTML 替换前记下焦点控件的稳定
// data-* 描述，重画后按描述找回新按钮；找不到回落 #detailTitle（renderDetail
// 自身的 hadPanelFocus 处理兜底），绝不落到 body。
function detailFocusDescriptor(element) {
  const attributes = {};
  for (const [key, value] of Object.entries(element.dataset || {})) attributes[key] = value;
  return Object.keys(attributes).length ? { attributes } : null;
}

function detailFocusSelectors({ attributes }) {
  const dataName = (key) => key.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
  const selector = (subset) => Object.entries(subset)
    .map(([key, value]) => `[data-${dataName(key)}="${CSS.escape(value)}"]`)
    .join("");
  const candidates = [selector(attributes)];
  // 全属性找不到（外部改了标签值等）时放宽到主 action 属性。
  if (attributes.action) candidates.push(selector({ action: attributes.action }));
  return candidates;
}

function renderDetailPreservingFocus() {
  const panel = els.detailPanel;
  const active = document.activeElement;
  const descriptor = active instanceof HTMLElement && panel?.contains(active)
    ? detailFocusDescriptor(active)
    : null;
  renderDetail();
  if (!descriptor) return;
  for (const selector of detailFocusSelectors(descriptor)) {
    const replacement = panel?.querySelector(selector);
    if (replacement) {
      replacement.focus({ preventScroll: true });
      return;
    }
  }
  (panel?.querySelector("#detailTitle") || panel)?.focus?.({ preventScroll: true });
}

// ===== Library Change 增量 reconciliation =====
// 数据层（library-reconciliation.mjs）负责 classify → fetch affected → reconcile
// → advance revision；本模块注入定向 DOM 提交与渲染回调。普通库变更走这条
// O(affected) 路径；全量重载（performFullGalleryReconciliation）只作为 journal
// gap / 未分类变更 / 显式恢复的 fallback。
const librarySync = createLibraryReconciler({
  state,
  apiFetch,
  currentAssetRequest,
  assetRequestKey,
  assetListVersion,
  getBaselineRevision: getLibraryRevisionBaseline,
  setBaselineRevision: noteLibraryRevision,
  fetchLibraryChanges,
  loadStats,
  performFullReconciliation: performFullGalleryReconciliation,
  commitGalleryChanges: commitIncrementalGalleryChanges,
  gallerySelection,
  renderDetail: () => renderDetailPreservingFocus(),
  isDetailEditorActive,
  refreshSelectedStackInspector,
  refreshSelectedGenerationHistory: async () => {
    const asset = selectedAsset();
    if (asset) await loadGenerationHistory(asset);
  },
  syncViewerAfterGalleryChanges: handleGalleryChangesInViewer,
  refreshPageTotal: refreshAssetPageTotalInBackground,
  resetAssetPrefetch,
});
setLibraryDeltaApplier(({ targetRevision }) => librarySync.reconcileToRevision(targetRevision));

const assetStacks = createAssetStackController({
  els,
  state,
  apiFetch,
  loadAssets,
  performFullGalleryReconciliation,
  librarySync,
  currentAssetRequest,
  renderGrid,
  gallerySelection,
  renderQuickFilters,
  renderTypeFilters,
  renderCategoryFilter,
  setGalleryBusy,
  updateViewTitle,
  showToast,
  closeDetailSurface,
  nativeAssetDrag,
  t,
});

// ===== Dark mode =====
function applyDarkMode() {
  const appearance = state.darkMode ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", appearance);
  // 三态下选中态跟 themeSetting 走（跟随系统选中时，生效外观可能是浅色或深色），
  // 生效外观仍由上面的 data-theme 表达。
  els.settingsMenu?.querySelectorAll("[data-appearance-opt]").forEach((button) => {
    button.classList.toggle("active", button.dataset.appearanceOpt === state.themeSetting);
  });
  // Phase 5A / F-12：aria-checked 与 roving tabindex 必须跟随 .active 视觉态同步。
  syncSegmentedRadios(els.settingsMenu);
}

// 任务 81 返工 1：跟随系统——OS 外观切换时立即跟着变（Electron 的 matchMedia
// 跟随 nativeTheme，浏览器跟随系统），不刷新页面；未选「跟随系统」时不动作。
systemDarkQuery?.addEventListener?.("change", () => {
  if (state.themeSetting !== THEME_SYSTEM) return;
  state.darkMode = systemPrefersDark();
  applyDarkMode();
});

// Phase 5A / F-12：segmented radiogroup 状态同步——aria-checked/tabindex 跟随 .active class，
// 颜色不是唯一选中表达；组内永远保留恰好一个 Tab 停靠点。
// 任务 42：主题预览卡组（.settings-theme-choices）复用同一套同步——组选择器扩一项，
// 按钮统一按 [role="radio"] 取，不复制第二套同步代码（.segmented-btn 本就是 role=radio）。
function syncSegmentedRadios(container) {
  container?.querySelectorAll(".segmented, .settings-theme-choices").forEach((group) => {
    const buttons = [...group.querySelectorAll(".segmented-btn, [role=\"radio\"]")];
    let anyChecked = false;
    let activeIndex = -1;
    for (const button of buttons) {
      const checked = button.classList.contains("active");
      if (checked) {
        anyChecked = true;
        activeIndex = buttons.indexOf(button);
      }
      button.setAttribute("aria-checked", String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    if (!anyChecked && buttons[0]) {
      buttons[0].tabIndex = 0;
      activeIndex = 0;
    }
    group.dataset.activeIndex = String(Math.max(0, activeIndex));
  });
}

function isSupportedImportFile(file) {
  return Boolean(file?.name && /\.(apng|avif|gif|jpe?g|png|svg|webp|m4v|mov|mp4|webm)$/i.test(file.name));
}

async function stageBrowserFile(file) {
  if (!(file instanceof File)) throw new Error(t("fileSelectionFailed"));
  if (!isSupportedImportFile(file)) {
    const error = new Error(t("errorPathUnsupported"));
    error.code = "IMAGE_PATH_UNSUPPORTED_TYPE";
    throw error;
  }
  const response = await fetch("/api/import/stage", {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-mosa-file-name": encodeURIComponent(file.name),
      ...mosaMutationHeaders("POST"),
    },
    body: file,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.path) {
    const error = new Error(payload?.error || t("fileSelectionFailed"));
    error.code = payload?.code || "IMPORT_STAGE_FAILED";
    throw error;
  }
  return payload.path;
}

// P1-2: Cleanup orphaned staged file on import cancel
async function cleanupStagedFile(stagedPath) {
  if (!stagedPath || typeof stagedPath !== "string") return;
  try {
    await apiFetch("/api/import/stage", { method: "DELETE", body: { path: stagedPath } });
  } catch (error) {
    // Non-fatal: log but don't interrupt user flow
    console.warn(`[MOSA] staged file cleanup failed: ${error?.message || error}`);
  }
}

// ===== Drag & Drop =====
function currentDropImportMetadata() {
  const group = String(state.facets.group || "").trim();
  return group ? { group } : {};
}

function setupDragDrop() {
  const library = els.assetGrid?.closest(".library");
  if (!library) return;
  const clearDragAnnouncement = () => announceGalleryStatus(t("dropImportCanceled"));
  const hideDragOverlay = ({ announce = true } = {}) => {
    state.dragCounter = 0;
    if (els.dragOverlay) els.dragOverlay.hidden = true;
    if (announce) clearDragAnnouncement();
  };
  library.addEventListener("dragenter", (e) => {
    // 回收站是只读范围：不显示导入浮层，也不接收任何拖放导入。
    if (state.viewMode !== "library" || state.scope === "trash") return;
    e.preventDefault();
    if (state.dragCounter === 0) {
      state.dragCounter = 1;
      if (els.dragOverlay) els.dragOverlay.hidden = false;
      announceGalleryStatus(t("dropImportReady"), { persist: true });
      return;
    }
    state.dragCounter++;
  });
  library.addEventListener("dragover", (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    if (state.scope === "trash") {
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "copy";
  });
  library.addEventListener("dragleave", (e) => {
    if (state.viewMode !== "library") return;
    e.preventDefault();
    state.dragCounter = Math.max(0, state.dragCounter - 1);
    if (state.dragCounter === 0) hideDragOverlay();
  });
  library.addEventListener("drop", async (e) => {
    // 回收站里不导入；不 preventDefault，让全局守卫拦截浏览器跳转。
    if (state.viewMode !== "library" || state.scope === "trash") return;
    e.preventDefault();
    hideDragOverlay({ announce: false });
    announceGalleryStatus(t("dropImportReceived"), { persist: true });
    let collected = { files: [], unsupported: 0 };
    try {
      let lastScanAnnounce = 0;
      collected = await collectDroppedFiles(e.dataTransfer, {
        isSupported: (name) => isSupportedImportFile({ name }),
        onProgress: (count) => {
          if (count - lastScanAnnounce < 200) return;
          lastScanAnnounce = count;
          announceGalleryStatus(t("batchImportScanning", { count }), { persist: true });
        },
      });
    } catch (error) {
      announceGalleryStatus("");
      showToast(dropErrorMessage(error, t), "error");
      return;
    }
    const { files, unsupported } = collected;
    if (!files.length) {
      // 无文件（或全部格式不支持）：不进入导入流程，清空持久 live region（audit fix batch 1.3）。
      announceGalleryStatus("");
      if (unsupported) showToast(t("errorPathUnsupported"), "error");
      return;
    }
    void batchImporter.enqueue(files, { metadata: currentDropImportMetadata(), skipped: unsupported });
  });
}

// ===== Sidebar group drop import =====
// 从 Finder/资源管理器把文件直接拖到侧边栏手动分组上，松开即导入到该分组。
// stackId 显式传空：即便当前在某个 Stack 里，文件也落到分组根层级而不是 Stack。
// 只响应外部文件拖拽（dataTransfer.types 含 "Files"）；asset-stacks.mjs 的
// 拖卡片入组基于 pointer 事件，不会触发这里的 HTML5 drag 事件，互不影响。
// 拖拽目标仅限 #sidebarManualGroupList 内的 .nav-group-item[data-filter="group"]；
// 智能分组、快捷筛选与"新建分组"编辑框都不是放置目标（全局守卫给出 dropEffect = "none"）。
function setupSidebarGroupDropImport() {
  const list = els.sidebarManualGroupList;
  if (!list) return;
  let highlighted = null;
  const clearHighlight = ({ announce = true } = {}) => {
    if (!highlighted) return;
    highlighted.classList.remove("group-drop-target");
    highlighted = null;
    if (announce) announceGalleryStatus("");
  };
  const dropGroupItem = (event) => {
    // 回收站是只读范围：不做放置目标；非文件拖拽（如页内选择）也不是。
    if (state.scope === "trash") return null;
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return null;
    return event.target instanceof Element
      ? event.target.closest('.nav-group-item[data-filter="group"]')
      : null;
  };
  list.addEventListener("dragenter", (e) => {
    if (!dropGroupItem(e)) return;
    e.preventDefault();
  });
  list.addEventListener("dragover", (e) => {
    const item = dropGroupItem(e);
    if (!item) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    // 高亮跟随命中项切换；在子元素之间移动由 dragleave 的 relatedTarget 守卫，
    // 不会闪烁。进入新分组时向读屏播报目标分组名。
    if (highlighted !== item) {
      clearHighlight({ announce: false });
      highlighted = item;
      item.classList.add("group-drop-target");
      announceGalleryStatus(t("sidebarDropImportReady", { group: String(item.dataset.value || "").trim() }), { persist: true });
    }
  });
  list.addEventListener("dragleave", (e) => {
    // 落点仍在当前高亮项内部（子元素间移动）时不算离开。
    if (highlighted && e.relatedTarget instanceof Node && highlighted.contains(e.relatedTarget)) return;
    clearHighlight();
  });
  list.addEventListener("drop", async (e) => {
    const item = dropGroupItem(e);
    clearHighlight();
    if (!item) return;
    e.preventDefault();
    const group = String(item.dataset.value || "").trim();
    if (!group) return;
    let collected = { files: [], unsupported: 0 };
    try {
      collected = await collectDroppedFiles(e.dataTransfer, {
        isSupported: (name) => isSupportedImportFile({ name }),
      });
    } catch (error) {
      showToast(dropErrorMessage(error, t), "error");
      return;
    }
    const { files, unsupported } = collected;
    if (!files.length) {
      if (unsupported) showToast(t("errorPathUnsupported"), "error");
      return;
    }
    void batchImporter.enqueue(files, { metadata: { group }, stackId: "", skipped: unsupported });
  });
  // 拖放被取消（Esc / 拖回桌面）时清掉高亮与播报。
  window.addEventListener("dragend", () => clearHighlight({ announce: false }));
}

// ===== Global drag/drop guard (P1-1) =====
// Prevent default drag-and-drop navigation in browser mode. Without this,
// dropping a file on non-drop targets (topbar, sidebar, modal backdrop, asset view)
// would navigate the tab to the dropped file's local path, losing all unsaved
// state. Electron has will-navigate protection, but browser mode needs this guard.
function setupGlobalDragGuard() {
  const isAllowedDropTarget = (target) => {
    if (!(target instanceof Element)) return false;
    // 侧边栏手动分组接收外部文件拖放（setupSidebarGroupDropImport 自己
    // preventDefault）；侧边栏其余区域仍被守卫拦截，回收站范围永远不是
    // 放置目标（由守卫给出 dropEffect = "none"）。
    if (state.scope !== "trash"
      && target.closest('#sidebarManualGroupList .nav-group-item[data-filter="group"]')) return true;
    // `.library` also contains the mutually-exclusive large asset view. Only
    // the library mode has a drop handler that calls preventDefault(), so the
    // asset view must stay behind this fallback navigation guard.
    return state.viewMode === "library" && Boolean(target.closest(".library"));
  };
  document.addEventListener("dragover", (e) => {
    // Don't interfere with existing drop targets. Let them call preventDefault
    // themselves as needed. This is a fallback guard only.
    if (e.defaultPrevented) return;
    if (isAllowedDropTarget(e.target)) return;
    // Otherwise prevent default to avoid navigation.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  });

  document.addEventListener("drop", (e) => {
    // Same policy as dragover: only allow drops on known targets.
    if (e.defaultPrevented) return;
    if (isAllowedDropTarget(e.target)) return;
    e.preventDefault();
  });

  // P2-3: Reset drag counter on drop end to prevent stuck overlay when
  // elements are destroyed mid-drag (grid re-render from background refresh).
  window.addEventListener("dragend", () => {
    if (state.dragCounter > 0) {
      state.dragCounter = 0;
      if (els.dragOverlay) els.dragOverlay.hidden = true;
      announceGalleryStatus("");
    }
  });

  // Also reset on window-level drop (dropped outside library while overlay was visible)
  window.addEventListener("drop", () => {
    if (state.dragCounter > 0) {
      state.dragCounter = 0;
      if (els.dragOverlay) els.dragOverlay.hidden = true;
      announceGalleryStatus("");
    }
  }, true); // Capture phase to reset before any other drop handlers
}

// ===== Paste import =====
// Ctrl/Cmd+V imports clipboard images through the same batch pipeline as drag
// and drop. Web and Electron share this handler; the Electron-only context
// menu keeps its native staging path (pasteClipboardImage).
function setupPasteImport() {
  document.addEventListener("paste", (event) => {
    const target = event.target;
    // Never steal paste from a native editor, and never import while another
    // modal/lightbox owns the surface. Image paste remains available from the
    // normal app canvas where it is an intentional import shortcut.
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]")) return;
    // 回收站是只读范围：不允许任何导入（含粘贴）。
    if (state.scope === "trash") return;
    // 浮层（确认框/建组/分组统计/堆叠重命名/设置/大图预览）打开时不导入。
    // settings/preview/groupModal 三项字面量被 frontend-interaction-regressions
    // 的粘贴契约锁定，不能并入 hasBlockingOverlay；统一判定以 hasBlockingOverlay
    // 为权威兜底（额外覆盖分组统计与堆叠重命名）。
    if (confirmDialogState.pending
      || !els.settingsMenu?.hidden
      || !els.imagePreviewModal?.hidden
      || els.groupModal?.classList.contains("open")
      || hasBlockingOverlay()) return;
    // 任务 93：⌘V 分流。剪切状态活着即代表系统剪贴板里仍是本次剪切写入的
    // 内容（失焦/应用内再写剪贴板都会取消剪切，见 cut-paste.mjs），此时 ⌘V
    // 执行「移动」：堆叠内 → 移进当前堆叠，非堆叠画廊视图 → 移出成散图；
    // 回收站在上方守卫直接返回，不会走到这里。没有剪切状态时照旧导入。
    if (cutPaste.isCutActive()) {
      event.preventDefault();
      void cutPaste.pasteCut({});
      return;
    }
    const items = event.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile?.();
      if (file) files.push(file);
    }
    if (!files.length) return;
    event.preventDefault();
    // Screenshot clipboard entries can arrive unnamed; the importer needs a
    // name for the staged copy, so give those a timestamped default.
    const named = files.map((file, index) => (file.name
      ? file
      : new File([file], `pasted-${Date.now()}${index ? `-${index + 1}` : ""}.png`, { type: file.type || "image/png" })));
    void batchImporter.enqueue(named, { metadata: currentDropImportMetadata() });
  });
}

const favoriteRequests = new Set();
async function toggleFavorite(id, event) {
  if (event) event.stopPropagation();
  if (!id) return;
  const currentTarget = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  const targetButton = event?.target instanceof Element
    ? event.target.closest('.card-favorite, [data-action="toggle-favorite"]')
    : null;
  const trigger = currentTarget?.matches?.('.card-favorite, [data-action="toggle-favorite"]')
    ? currentTarget
    : (targetButton instanceof HTMLElement ? targetButton : null);
  const shouldRestoreFocus = trigger && document.activeElement === trigger;
  const triggerWasDetail = Boolean(trigger?.closest?.("#detailPanel"));
  const projectId = state.project;
  const requestKey = `${projectId}\u0000${id}`;
  if (favoriteRequests.has(requestKey)) return;
  favoriteRequests.add(requestKey);
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}/favorite`, { method: "POST" });
    const updated = result.asset || null;
    if (updated && projectId === state.project) {
      const index = state.assets.findIndex((asset) => asset.id === id && asset.project_id === projectId);
      if (index >= 0) state.assets[index] = updated;
      if (state.detailAsset?.id === id && state.detailAsset.project_id === projectId) state.detailAsset = updated;
      // Favorite only bumps updated_at, not the created_at sort order, so the
      // background refresh below skips renderGrid/renderDetail when the result
      // set is unchanged. Patch every visible favorite button here so the star
      // reflects the server response instead of staying stale until a later
      // full render (search/filter/sort/project) rebuilds the grid.
      const favorite = Boolean(updated.favorite);
      const gridButton = els.assetGrid?.querySelector(`.card-favorite[data-fav-id="${CSS.escape(id)}"]`);
      // Only patch the Inspector button when it actually renders this asset;
      // otherwise a favorite toggle on one card would overwrite the star of a
      // different asset currently open in the detail panel. A plain selection
      // keeps state.detailAsset null (the inspector renders from state.assets),
      // so "is the inspector showing this asset" keys off the selection.
      const detailShowsAsset = state.detailOpen && state.selectedId === id && state.project === projectId;
      const detailButton = detailShowsAsset ? els.detailPanel?.querySelector('[data-action="toggle-favorite"]') : null;
      if (trigger instanceof HTMLElement && trigger.isConnected) applyFavoriteButtonState(trigger, favorite);
      if (gridButton instanceof HTMLElement && gridButton !== trigger) applyFavoriteButtonState(gridButton, favorite);
      if (detailButton instanceof HTMLElement && detailButton !== trigger) applyFavoriteButtonState(detailButton, favorite);
    }
    showToast(updated?.favorite ? t("addedToFavorites") : t("removedFromFavorites"), "success");
    // 收藏只影响标记与统计：卡片/Inspector 已就地更新，这里只做统计刷新与
    // 一次 O(1) 的本地 reconcile（favorites 视图下的取消收藏会即时移除卡片），
    // 不再重拉整个已加载窗口；随后到达的 SSE delta 幂等。
    const localReconcile = librarySync.applyLocalChanges([{
      kind: "asset-updated", entityType: "asset", entityId: id, flags: ["favorite"],
    }]).catch((error) => console.warn("Favorite reconcile failed:", error));
    await Promise.allSettled([loadStats(), localReconcile]);
    if (shouldRestoreFocus && projectId === state.project) {
      const replacement = triggerWasDetail
        ? els.detailPanel?.querySelector('[data-action="toggle-favorite"]')
        : els.assetGrid?.querySelector(`.card-favorite[data-fav-id="${CSS.escape(id)}"]`);
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    favoriteRequests.delete(requestKey);
  }
}

function applyFavoriteButtonState(button, favorite) {
  button.classList.toggle("is-fav", favorite);
  button.setAttribute("aria-pressed", String(favorite));
  button.setAttribute("aria-label", t(favorite ? "removeFavorite" : "addFavorite"));
  // The grid card's star is an <svg> whose fill is driven by the .is-fav
  // class (styles.css `.card-favorite.is-fav svg { fill: currentColor }`),
  // so its children stay untouched. The detail button carries two spans
  // (icon glyph + visible label) that must be reconciled in place.
  if (button.classList.contains("card-favorite")) {
    button.setAttribute("title", t(favorite ? "removeFavorite" : "addFavorite"));
    return;
  }
  const icon = button.children[0];
  const label = button.children[1];
  if (icon) icon.textContent = favorite ? "★" : "☆";
  if (label) label.textContent = t(favorite ? "favorited" : "addFavorite");
}

// The design reference intentionally switches navigation at 768px.  Desktop
// keeps the persistent rail; compact web views get a focusable drawer, scrim
// and Escape exit rather than a squeezed desktop sidebar.
const MOBILE_NAVIGATION_QUERY = "(max-width: 767px)";
let mobileNavReturnFocus = null;
function isMobileNavigationViewport() { return window.matchMedia(MOBILE_NAVIGATION_QUERY).matches; }
function setMobileNavOpen(open, { restoreFocus = false } = {}) {
  const mobile = isMobileNavigationViewport();
  const next = mobile && Boolean(open);
  document.body.classList.toggle("mobile-nav-open", next);
  els.mobileNavToggle?.setAttribute("aria-expanded", String(next));
  if (els.mobileNavScrim) els.mobileNavScrim.hidden = !next;
  if (els.sidebar) {
    els.sidebar.toggleAttribute("inert", mobile && !next);
    els.sidebar.setAttribute("aria-hidden", String(mobile && !next));
  }
  if (next) {
    mobileNavReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : els.mobileNavToggle;
    requestAnimationFrame(() => els.mobileNavClose?.focus());
  } else if (restoreFocus && mobileNavReturnFocus instanceof HTMLElement) {
    mobileNavReturnFocus.focus();
    mobileNavReturnFocus = null;
  }
}
function syncMobileNavigation() { setMobileNavOpen(false); }

// IME 组字（composition）期间的键属于输入法本身：拼音输入里 Enter 是“上屏”，
// 不是提交。所有“文本输入框里按 Enter 就提交”的 keydown 处理必须先过这里，
// 命中时直接 return 且不 preventDefault——事件要留给输入法，组字结束后的
// 正常 Enter 行为不变。keyCode 229 兜底部分环境未回填 isComposing 的情况。
function isImeComposing(event) {
  return event.isComposing === true || event.keyCode === 229;
}

// ===== Keyboard Shortcuts =====
// 任务 93：⌘/Ctrl+X 剪切当前选区（或大图页/检视器当前素材）。折叠 Stack 节点
// 不可剪切——与右键菜单的置灰口径一致，⌘X 直接不动作。
function cutFromKeyboard() {
  if (state.scope === "trash") return;
  const selectedIds = state.selectedIds instanceof Set && state.selectedIds.size ? [...state.selectedIds] : [];
  const rootStackNodeGuard = (ids) => state.viewMode === "library"
    && !state.activeStackId
    && (state.assets || []).some((asset) => asset.stack?.id && ids.includes(asset.id));
  if (selectedIds.length) {
    if (rootStackNodeGuard(selectedIds)) return;
    void cutPaste.cutAssetIds(selectedIds);
    return;
  }
  const asset = selectedAsset();
  if (!asset || !(state.viewMode === "asset" || state.detailOpen || state.viewMode === "library")) return;
  if (rootStackNodeGuard([asset.id])) return;
  void cutPaste.cutAssetIds([asset.id]);
}

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    // Phase 5B：ConfirmDialog 打开时页面背景不接收任何键盘操作（Escape 由
    // trapConfirmDialogFocus 消费；不新增第二套全局 Escape 路由）。
    if (confirmDialogState.pending) return;
    // M1 兜底：右键菜单打开期间键盘归菜单独占（菜单本身以捕获阶段消费并阻断
    // 冒泡）。一次 Escape 只关菜单，方向键只移动菜单焦点，不连带关 Inspector
    // 或切换画廊选中。
    // 菜单的 keydown 监听为防“打开事件自关”延迟到 setTimeout(0) 才注册；这个
    // 空窗里的 Escape 会落进下面的 isOpen() 早退被吞——所以在早退之前先关菜单，
    // 语义与菜单自己的 Escape 分支一致（preventDefault + 归还焦点）。
    if (event.key === "Escape" && contextMenu.isOpen()) {
      event.preventDefault();
      contextMenu.hide({ restoreFocus: true });
      return;
    }
    if (contextMenu.isOpen()) return;
    // The gallery owns ⌘/Ctrl+A now that marquee selection is available. Paste
    // is let through in both modes: the document paste handler imports
    // clipboard images, so preventDefault() here would suppress it entirely.
    // 任务 93：⌘/Ctrl+X 走剪切（与右键菜单同一动作）；输入控件不拦截。
    if ((event.metaKey || event.ctrlKey) && (event.key === "a" || event.key === "A" || event.key === "v" || event.key === "V" || event.key === "x" || event.key === "X")) {
      if (event.target.matches?.("input, textarea, select, [contenteditable]")) return;
      if (hasBlockingOverlay()) return;
      if ((event.key === "a" || event.key === "A") && state.viewMode === "library" && state.assets.length) {
        event.preventDefault();
        void gallerySelection.selectAll({ announce: true });
        return;
      }
      if (event.key === "v" || event.key === "V") return;
      if (event.key === "x" || event.key === "X") {
        event.preventDefault();
        void cutFromKeyboard();
        return;
      }
      event.preventDefault();
      return;
    }
    // Modal traps are registered before this application shortcut router. If
    // the topmost layer already consumed Escape, never let the same keystroke
    // also close the mobile navigation underneath it.
    if (event.key === "Escape" && event.defaultPrevented) return;
    if (event.key === "Escape" && document.body.classList.contains("mobile-nav-open")) {
      event.preventDefault();
      setMobileNavOpen(false, { restoreFocus: true });
      return;
    }
    if (event.target.matches?.("input, textarea, select") && event.key !== "Escape") return;
    // Escape in the search box clears the active query (or returns focus to the
    // gallery when already empty) instead of falling through to close the
    // Inspector underneath — matching the search-field reflex, not the modal
    // dismiss reflex. Clearing still honors the dirty-draft guard.
    if (event.key === "Escape" && event.target === els.searchInput) {
      event.preventDefault();
      if (els.searchInput.value) void clearSearchQuery();
      else els.assetGrid?.focus({ preventScroll: true });
      return;
    }
    // GravityPort A3：后退/前进（任务 70）。macOS ⌘[ / ⌘]，其他平台 Alt+← / Alt+→；
    // 输入控件已被上方守卫拦截，contenteditable 在 resolveNavHistoryShortcut 里排除。
    const navHistoryDirection = resolveNavHistoryShortcut(event);
    if (navHistoryDirection !== 0 && !hasBlockingOverlay()) {
      event.preventDefault();
      void navigateGalleryHistory(navHistoryDirection);
      return;
    }
    if (event.key === "/" && state.viewMode === "library" && !hasBlockingOverlay()) { event.preventDefault(); els.searchInput?.focus(); return; }
    if (event.key === "Escape") {
      // Phase 3A 运行时修复：bindEvents 先行注册的 Modal 焦点陷阱已消费本次 Escape
      // （preventDefault）时，本链不得再继续向下穿透（否则会关 Modal 同时退出查看模式）。
      if (event.defaultPrevented) return;
      if (!els.imagePreviewModal?.hidden) { closeImagePreview(); event.preventDefault(); return; }
      if (els.groupModal?.classList.contains("open")) { closeGroupModal(); event.preventDefault(); return; }
      if (els.stackRenameModal?.classList.contains("open")) { closeStackRenameModal(); event.preventDefault(); return; }
      // Escape 先关最上层 Modal，再退出查看模式，不得穿透。
      if (!els.settingsMenu?.hidden) { closePanel(els.settingsMenu, els.settingsToggle); event.preventDefault(); return; }
      // GravityPort A4a：检视器浮层打开时 Esc 只关浮层（焦点回「查看」），不动检视器。
      if (inspectorOverlay.isOpen()) { event.preventDefault(); inspectorOverlay.close(); return; }
      // 任务 93：Esc 优先级是 菜单 > 全屏 > 剪切 > 其他。菜单已在函数开头被
      // 消费；全屏态放行给下方全屏分支；其余情况下有剪切先取消剪切（卡片
      // 恢复正常），再轮到清选区/退层级等既有行为。
      if (cutPaste.isCutActive()
        && !(state.viewMode === "asset" && (assetViewer.isAssetViewFullscreen() || assetViewer.isAssetViewFullscreenSettling()))) {
        event.preventDefault();
        cutPaste.cancelCut({ announce: true });
        return;
      }
      if (state.viewMode === "library" && state.selectedIds?.size) {
        gallerySelection.clear({ announce: true });
        event.preventDefault();
        return;
      }
      if (state.viewMode === "library" && state.detailOpen && isInspectorDocked() && state.activeStackId) {
        event.preventDefault();
        void assetStacks.exitStack();
        return;
      }
      // GravityPort A4c（任务 90）：全屏态 Esc 只退全屏、回到大图页（不直接回画廊）。
      // 真全屏的 Esc 由浏览器消费并经 fullscreenchange 落类；此处兜底 CSS 回退态与
      // 事件时序——退出后的一小段宽限同样吞掉迟到的 Esc，防止连带关掉查看模式。
      if (state.viewMode === "asset" && (assetViewer.isAssetViewFullscreen() || assetViewer.isAssetViewFullscreenSettling())) {
        event.preventDefault();
        void assetViewer.exitAssetViewFullscreen();
        return;
      }
      if (state.viewMode === "asset" || state.detailOpen) { event.preventDefault(); void closeDetailSurface(); return; }
      if (state.activeStackId) { event.preventDefault(); void assetStacks.exitStack(); return; }
    }
    // Native video controls own their keyboard semantics (notably ←/→ seek).
    // Escape was handled above, so all remaining keystrokes can safely stay
    // with the focused <video> instead of becoming MOSA pan/navigation input.
    if (event.target.closest?.("video")) return;
    // Image Preview uses this same application-level keyboard router. Keeping
    // the handler here preserves the existing Escape priority and avoids a
    // second global shortcut manager. Form fields/contenteditable remain native.
    if (!els.imagePreviewModal?.hidden) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest?.("[contenteditable]")) return;
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomImage(IMAGE_PREVIEW_ZOOM_STEP); return; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomImage(-IMAGE_PREVIEW_ZOOM_STEP); return; }
      if (event.key === "0") { event.preventDefault(); resetImageZoom({ announce: true }); return; }
      if (event.key === "ArrowLeft") { event.preventDefault(); panImagePreview(-IMAGE_PREVIEW_PAN_STEP, 0); return; }
      if (event.key === "ArrowRight") { event.preventDefault(); panImagePreview(IMAGE_PREVIEW_PAN_STEP, 0); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); panImagePreview(0, -IMAGE_PREVIEW_PAN_STEP); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); panImagePreview(0, IMAGE_PREVIEW_PAN_STEP); return; }
      return;
    }
    // Phase 3B / 规格 §8：专用大图舞台缩放快捷键——仅 Asset mode 生效；Modal、
    // Lightbox、筛选面板或设置菜单打开时不触发；带 Ctrl/Meta/Alt 时放行（浏览器缩放
    // 等系统快捷键保持原生，不覆盖）；输入控件由链首守卫拦截，此处再排除
    // contenteditable。方向键保留给 Phase 3C，本阶段不占用。
    if (state.viewMode === "asset"
      && !event.ctrlKey && !event.metaKey && !event.altKey
      && els.imagePreviewModal?.hidden
      && !els.groupModal?.classList.contains("open")
      && !els.stackRenameModal?.classList.contains("open")
      && els.settingsMenu?.hidden
      && !event.target.closest?.("[contenteditable]")) {
      if (event.target.matches?.("input, textarea, select")) return; // 输入控件一律不触发 Viewer 快捷键
      // Phase 3C：ArrowLeft/ArrowRight = 上一张/下一张。只在对应方向存在有效素材时
      // preventDefault（边界态放行浏览器原生行为）；不占用 ArrowUp/ArrowDown；导航
      // 经集中式 navigateAssetView（同步、幂等，键盘长按重复触发同路径安全）。
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        if (canNavigateAssetView(direction)) { event.preventDefault(); navigateAssetView(direction); }
        return;
      }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomAssetViewBy(ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }); return; }
      if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomAssetViewBy(1 / ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }); return; }
      if (event.key === "0") { event.preventDefault(); resetAssetViewToHundred(); return; }
      if (event.key === "f" || event.key === "F") { event.preventDefault(); fitAssetView(true); return; }
    }
    const galleryEnterTarget = event.target === els.assetGrid || Boolean(event.target.closest?.(".asset-card-select"));
    const galleryEnterCardId = event.target.closest?.(".asset-card")?.dataset.id || "";
    const galleryEnterAssetId = galleryEnterCardId || state.selectedId || "";
    if (event.key === "Enter"
      && galleryEnterTarget
      && state.viewMode === "library"
      && galleryEnterAssetId
      && !state.selectedIds?.size
      && !hasBlockingOverlay()) {
      const asset = state.assets.find((item) => item.id === galleryEnterAssetId)
        || (galleryEnterAssetId === state.selectedId ? selectedAsset() : null);
      if (asset) {
        event.preventDefault();
        if (!state.activeStackId && asset.stack?.id) void assetStacks.enterStack(asset.stack.id, asset.stack);
        else void openAssetView(asset.id, els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(asset.id)}"] .asset-card-select`));
        return;
      }
    }
    if (state.viewMode === "library" && !state.selectedIds?.size) handleLibraryKeyboardNavigation(event);
  });
}

// ===== Image preview zoom/pan/pinch（已提取至 image-preview.mjs，R1 批次 4）=====
const imagePreview = createImagePreviewViewer({ els, state, t, announceGalleryStatus });
const { resetImageZoom, zoomImage, panImagePreview, setupImageZoomPan,
  reconcileImagePreviewTransform, consumeImagePreviewSuppressedClick,
  IMAGE_PREVIEW_ZOOM_STEP, IMAGE_PREVIEW_PAN_STEP } = imagePreview;
// ===== Inspector markup（检视器区块 markup helper，已提取至 inspector-markup.mjs，R1 批次 4）=====
const inspectorMarkup = createInspectorMarkup({ state, t, referenceRightsMarkup });
const { detailFileSectionMarkup, detailPromptSectionMarkup,
  detailPaletteSectionMarkup, detailReferenceSectionMarkup, detailVersionContextSectionMarkup,
  generationContextBoxMarkup, detailVersionSectionMarkup, detailTagsSectionMarkup, versionPickerMarkup, versionCompareMarkup, versionHistoryMarkup,
  generationHistoryMarkup, recipeHistoryMarkup, isVideoAsset,
  assetMediaPreviewMarkup, stackInspectorMarkup, promptReferencesMarkup } = inspectorMarkup;
// ===== Inspector overlay（GravityPort A4a：参考图 / 版本树浮层控制器）=====
// 任务 73 返工 1：isSuspended 按 hasBlockingOverlay 的既有清单判断「浮层上面还有
// 更高层的弹窗」（确认框、图片预览、建组/分组统计、堆叠重命名、设置——即
// hasBlockingOverlay 排除浮层自身后的全部成员）；为真时浮层的 keydown/pointerdown
// 完全让位，Esc/Tab/点击由上层弹窗自己处理。
const inspectorOverlay = createInspectorOverlay({ panel: els.detailPanel, t, isSuspended: () => hasBlockingOverlay("gpOverlay") });

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====
// 任务 96（A6）：桌面环境注入窗口系统全屏桥（electronAPI 存在才注入）——大图页
// 「全屏」与窗口系统全屏双向同步；浏览器无桥，沿用 Fullscreen API 行为。
const desktopFullscreenBridge = typeof window.electronAPI?.setWindowFullScreen === "function"
  ? { setWindowFullScreen: (flag) => window.electronAPI.setWindowFullScreen(flag === true) }
  : null;
const assetViewer = createAssetViewer({ els, state, t, announceGalleryStatus, selectedAsset, isVideoAsset,
  confirmDetailNavigation, discardDetailDraft, isCurrentDetailSelection, assetRequestKey, currentAssetRequest, requestAssetPage,
  renderGrid, updateViewTitle, showToast, renderDetail, updateSelectedCard, setDetailOpen, setupMasonryLayout,
  desktopFullscreen: desktopFullscreenBridge });
const { renderAssetView, openAssetView, returnToLibrary,
  handleAssetViewImageLoad, handleAssetViewImageError, canNavigateAssetView, navigateAssetView,
  zoomAssetViewBy, fitAssetView, resetAssetViewToHundred, ASSET_VIEW_ZOOM_STEP } = assetViewer;


// ===== Gallery empty states (F-08) =====
// 空态按情况说话（任务 111 的七档固定顺序，命中第一条就用它）。
// 判定集中在 deriveGalleryEmptyState()，清除集中在 resetLibraryRefinements()；
// 不发送任何请求、不复制搜索/筛选算法、不维护第二套 gallery 状态。

/**
 * Centralized empty-state decision. Pure: reads existing state only, never
 * fetches. Fixed priority: loading → fatal error → cards → 七档按序判定：
 * 1. 搜索或筛选无结果（query / mediaKind / 除 group 外的任何 facet——侧栏固定
 *    入口 scope 与分组 facet 是「在哪儿看」，不算筛选，所以在分组里搜不到算
 *    第 1 条，分组里本来就没图算第 5 条）；
 * 2-4. 回收站 / 收藏 / 待整理固定入口的空态；
 * 5. 当前分组里没有图；
 * 6. 「所有素材」且整库总数为 0 的空库；
 * 7. 其余兜底（如某来源下没有图）回到无结果文案。
 * `state.groups.total` is the authoritative whole-library total (the same
 * /api/groups count the sidebar shows); it is loaded before assets on init,
 * on project switch, and refreshed in the background — `state.pageTotal` is
 * only the current result total and must never impersonate the library total.
 */
function deriveGalleryEmptyState() {
  if (state.galleryStatus === "loading") return "none";
  if (state.galleryStatus === "error") return "none";
  if (state.assets.length > 0) return "none";
  const hasRefinements = Boolean(state.query)
    || (state.mediaKind && state.mediaKind !== "all")
    || FACET_KEYS.some((key) => key !== "group" && String(state.facets?.[key] || "") !== "");
  if (hasRefinements) return "no-results";
  if (state.scope === "trash") return "trash-empty";
  if (state.scope === "favorite") return "favorites-empty";
  if (state.scope === "unorganized") return "unorganized-empty";
  if (String(state.facets?.group || "") !== "") return "group-empty";
  if (state.scope === "all" && Number(state.groups?.total || 0) === 0) return "library-empty";
  return "no-results";
}

/** 任务 111：每档空态的标题/说明文案键；clearAction 表示是否带「清除筛选」按钮。 */
const GALLERY_EMPTY_STATE_COPY = {
  "no-results": { titleKey: "noResultsTitle", descriptionKey: "noResultsDescription", clearAction: true },
  "trash-empty": { titleKey: "trashEmptyTitle", descriptionKey: "trashEmptyDescription" },
  "favorites-empty": { titleKey: "favoritesEmptyTitle", descriptionKey: "favoritesEmptyDescription" },
  "unorganized-empty": { titleKey: "unorganizedEmptyTitle", descriptionKey: "unorganizedEmptyDescription" },
  "group-empty": { titleKey: "groupEmptyTitle", descriptionKey: "groupEmptyDescription" },
  "library-empty": { titleKey: "emptyLibraryTitle", descriptionKey: "emptyDropHint" },
};

/** One shell for every empty state; the kind only changes copy and actions. */
function galleryEmptyMarkup() {
  const kind = deriveGalleryEmptyState();
  if (kind === "none") return "";
  // Faithful V2 recovery shell: package glyph + 按档文案（任务 111）。空库档的
  // 说明一句就是原来的拖入提示，不再重复显示第二遍；其余档不显示拖入提示。
  // 「清除筛选」按钮只在无结果档出现（data-action="empty-clear"，行为不变），
  // 回收站等只读档没有按钮。
  const copy = GALLERY_EMPTY_STATE_COPY[kind] || GALLERY_EMPTY_STATE_COPY["no-results"];
  const packageOpenIcon = "<svg class=\"gallery-empty-icon\" width=\"48\" height=\"48\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M12 22v-9\"/><path d=\"M15.17 2.21a1.67 1.67 0 0 1 1.63 0L21 4.57a1.93 1.93 0 0 1 0 3.36L8.82 14.79a1.66 1.66 0 0 1-1.64 0L3 12.43a1.93 1.93 0 0 1 0-3.36z\"/><path d=\"M20 13v3.87a2.06 2.06 0 0 1-1.11 1.83l-6 3.08a1.93 1.93 0 0 1-1.78 0l-6-3.08A2.06 2.06 0 0 1 4 16.87V13\"/><path d=\"M21 12.43a1.93 1.93 0 0 0 0-3.36L8.83 2.21a1.64 1.64 0 0 0-1.63 0L3 4.57a1.93 1.93 0 0 0 0 3.36l12.18 6.86a1.64 1.64 0 0 0 1.63 0z\"/></svg>";
  const clearAction = copy.clearAction
    ? "<div class=\"empty-state-actions\"><button class=\"btn-secondary\" type=\"button\" data-action=\"empty-clear\">" + escapeHtml(t("resetFilters")) + "</button></div>"
    : "";
  return "<div class=\"gallery-empty-state\" data-empty-kind=\"" + kind + "\">" + packageOpenIcon + "<div class=\"empty-state-copy\"><h2>" + escapeHtml(t(copy.titleKey)) + "</h2><p>" + escapeHtml(t(copy.descriptionKey)) + "</p></div>" + clearAction + "</div>";
}

/** Reuses the existing polite live region; never a second announcement system. */
function announceGalleryStatus(message, { persist = false } = {}) {
  statusRegion.announce(message, { persist });
}

/** 任务 111：读屏播报跟着各档标题走（不认识档位就不播）。 */
function announceEmptyState(kind) {
  const copy = kind ? GALLERY_EMPTY_STATE_COPY[kind] : null;
  if (!copy) return;
  announceGalleryStatus(t(copy.titleKey));
}

/**
 * The single refinement reset. Clears query, search input, facets (including
 * the group facet), facet search and scope, then refreshes exactly once.
 * Sort, theme, language, project and every asset/favorite stay
 * untouched. Focus never lands on body: the first card wins, the grid
 * container is the fallback.
 */
async function resetLibraryRefinements() {
  const intent = beginNavigationIntent();
  if (!await authorizeNavigationIntent(intent)) return false;
  discardDetailDraft();
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  // A reset restarts paging, and the viewer result-set semantics changed.
  state.nextCursor = null;
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters(); renderCategoryFilter();
  recordNavigationPosition();
  announceGalleryStatus(t("statusRefinementsCleared"));
  void loadAssets().then((applied) => {
    if (!applied) return;
    const firstCard = els.assetGrid?.querySelector(".asset-card-select");
    if (firstCard) firstCard.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  });
  return true;
}

async function init() {
    applyLanguage();
    applyDarkMode();
    // 用户中心头像：异步取安装 ID，不阻塞启动（先显示 G）。
    void hydrateUserCenter();
    nativeAssetDrag.bind();
    assetStacks.bind();
    gallerySelection.bind();
    cutPaste.bind();
    bindEvents();
    setupDragDrop();
    setupSidebarGroupDropImport();
    setupGlobalDragGuard();
    setupPasteImport();
    setupKeyboardShortcuts();
    setupImageZoomPan();
    // GravityPort A3：初始浏览位置入历史（后退到头=启动时的范围）；滑杆恢复
    // 本地存储值并首次计算列数/滑杆组可见性。
    navHistory.clear();
    navHistory.push(captureNavigationSnapshot());
    syncNavHistoryButtons();
    applyGalleryCardSize(galleryTargetCardWidth);
    syncGallerySizeGroupVisibility();
    renderGrid();
    // 任务 116：老用户「已更名」提示——第一屏渲染完问一次桌面壳，要弹就用唯一
    // 确认弹窗的单按钮形态（详见 maybeShowRenameNotice）。
    void maybeShowRenameNotice();
    // Desktop V2 starts with the Inspector as the third column. Calling the
    // existing state transition before data loading prevents a visible
    // two-column -> three-column jump during startup; an explicit close action
    // can still collapse it afterwards. Mobile starts closed.
    setDetailOpen(false);
    try {
      // Build identity is the readiness gate for the renderer. Do not let
      // stateful library requests commit into a renderer that belongs to a
      // different runtime build.
      await loadProductVersion();
      // Once identity is trusted, the library reads are independent. Wait for
      // all of them to settle before surfacing a failure so a slower successful
      // request can never overwrite the fatal startup state afterwards.
      const initialReads = await Promise.allSettled([loadAssets(), loadStats(), loadProjects()]);
      const rejected = initialReads.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
      if (initialReads[0].value === false) throw state.galleryError || new Error(t("loadFailed"));
      void refreshBridgeStatus();
      bridgeStatusPoller.start();
      startLibraryEventStream();
      // Single interval: dedupe on hot-reload / repeated init() and stop on unload.
      if (libraryRefreshTimer) clearInterval(libraryRefreshTimer);
      // Pagination owns the current gallery request while an append is in flight.
      // Starting the background page-one refresh at the same time would advance
      // api-client's shared request generation and make the append response stale.
      libraryRefreshTimer = setInterval(() => {
        if (!isLoadingMore) void refreshLibraryIfChanged();
      }, LIBRARY_REFRESH_INTERVAL);
      if (shouldAutoCheckForUpdates()) void checkForUpdates({ notify: true, silent: true });
      // QA/诊断钩子：性能脚本用它模拟页面恢复/SSE 重连（revision 对账）并读取
      // 增量同步 baseline；生产页面不依赖此对象。
      window.__mosa = window.__mosa || {};
      window.__mosa.librarySync = {
        baseline: () => getLibraryRevisionBaseline(),
        syncNow: async () => {
          const result = await apiFetch(`/api/library-revision?project=${encodeURIComponent(state.project)}`).catch(() => null);
          if (result?.revision == null) return false;
          return librarySync.reconcileToRevision(result.revision);
        },
      };
      // Post-update rollback is released only after the renderer has completed
      // build-identity validation, loaded its initial library snapshot and
      // initialized live synchronization.
      void window.electronAPI?.reportRendererReady?.();
    } catch (error) {
      renderErrorState(error);
      setStatus(t("statusUnavailable"), "error");
    }
  }

// 任务 116：老用户「已更名」提示（MOSA is now GravityPort）。桌面壳在启动最早期
// 已判定（userData 里的 rename-notice.json），这里只在第一屏渲染完问一次状态。
// - 浏览器直开（无 electronAPI）不弹、不报错。
// - 弹之前同步预检占用：预检与 requestConfirmation 的占用守卫之间没有 await，
//   确认此刻真的会弹出；没弹出来（已有确认框开着）不算已读，下次启动再弹。
// - 单按钮模式：不传 dontAskAgainKey（无「不再提醒」行）、tone 非 danger（主按钮
//   样式）、hideCancel 隐藏取消按钮、焦点落「知道了」。
// - 点按钮、按 Esc、点遮罩关闭都算已读，调确认接口。
async function maybeShowRenameNotice() {
  if (!window.electronAPI?.getRenameNoticeState || !window.electronAPI?.acknowledgeRenameNotice) return;
  try {
    const notice = await window.electronAPI.getRenameNoticeState();
    if (notice?.shouldShow !== true) return;
    if (confirmDialogState.pending || !els.confirmDialog) return;
    // 走到 await 说明弹窗确实打开了（占用时上面已同步预检拦截）；true=点了按钮，
    // false=Esc/遮罩关闭——三种关闭方式都算已读。
    await requestConfirmation({
      title: t("renameNoticeTitle"),
      description: t("renameNoticeBody"),
      confirmLabel: t("renameNoticeConfirm"),
      tone: "warning",
      hideCancel: true,
    });
    void window.electronAPI.acknowledgeRenameNotice();
  } catch {
    // 桌面壳不在或不支持该通道时静默跳过。
  }
}

async function loadProductVersion() {
  const data = await apiFetch("/api/health");
  state.productVersion = String(data?.productVersion || "").trim();
  state.storageKind = String(data?.storage || "unknown");
  const response = await fetch("/build-identity.json", { cache: "no-store" });
  if (response.ok) {
    const uiIdentity = await response.json();
    const identityFields = ["productVersion", "uiFingerprint", "runtimeFingerprint"];
    const mismatched = identityFields.filter((field) => {
      const uiValue = String(uiIdentity?.[field] || "").trim();
      const runtimeValue = String(data?.[field] || "").trim();
      return uiValue && runtimeValue && uiValue !== "unknown" && runtimeValue !== "unknown" && uiValue !== runtimeValue;
    });
    if (mismatched.length) {
      const error = new Error(t("runtimeBuildMismatch"));
      error.code = "MOSA_RUNTIME_BUILD_MISMATCH";
      throw error;
    }
  }
  gallerySelection.syncRenderedSelection({ prune: false });
  renderSettingsMenu();
}

function shouldAutoCheckForUpdates() {
  if (!window.electronAPI?.checkForUpdates) return false;
  const lastChecked = Number(safeStorageGet("mosa.update-last-checked") || 0);
  return !Number.isFinite(lastChecked) || lastChecked <= 0 || Date.now() - lastChecked >= UPDATE_CHECK_INTERVAL_MS;
}

function updateVersionSummary() {
  const current = state.productVersion ? `v${String(state.productVersion).replace(/^v/i, "")}` : t("versionUnknown");
  if (state.updateStatus === "available" && state.latestVersion) {
    const published = state.updatePublishedAt ? ` · ${t("updatePublished", { date: formatDate(state.updatePublishedAt, state.locale) })}` : "";
    return `${current} · ${t("updateAvailable", { version: state.latestVersion })}${published}`;
  }
  if (state.updateStatus === "current") return `${current} · ${t("upToDate")}`;
  if (state.updateStatus === "error") return `${current} · ${t("updateCheckFailed")}`;
  if (state.updateStatus === "unavailable") return `${current} · ${t("updateInstallLocationUnsupported")}`;
  return current;
}

function updateVersionControlMarkup() {
  if (!window.electronAPI?.checkForUpdates) return "";
  if (state.updateStatus === "downloading") {
    const cancelHint = window.electronAPI?.cancelUpdateDownload ? ` · ${t("cancelUpdateDownload")}` : "";
    const action = window.electronAPI?.cancelUpdateDownload ? " data-cancel-update" : " disabled";
    return `<button class="settings-text-action" type="button"${action}>${escapeHtml(t("downloadingUpdate", { percent: state.updateDownloadPercent }) + cancelHint)}</button>`;
  }
  if (state.updateStatus === "available") {
    const key = state.updateCanInstallInApp ? "downloadAndInstall" : "downloadLatest";
    const attr = state.updateCanInstallInApp ? "data-install-update" : "data-download-latest";
    return `<button class="settings-text-action" type="button" ${attr}>${escapeHtml(t(key))}</button>`;
  }
  const label = state.updateStatus === "checking" ? t("checkingForUpdates") : t("checkForUpdates");
  return `<button class="settings-text-action" type="button" data-check-updates${state.updateStatus === "checking" ? " disabled" : ""}>${escapeHtml(label)}</button>`;
}

async function checkForUpdates({ notify = false, silent = false } = {}) {
  const api = window.electronAPI;
  if (!api?.checkForUpdates || state.updateStatus === "checking") return null;
  state.updateStatus = "checking";
  syncSettingsMenuView();
  try {
    const result = await api.checkForUpdates(notify === true);
    if (result?.status === "ok") safeStorageSet("mosa.update-last-checked", String(Date.now()));
    if (result?.currentVersion) state.productVersion = String(result.currentVersion).replace(/^v/i, "");
    if (result?.status === "ok") {
      state.latestVersion = String(result.latestVersion || "").replace(/^v/i, "");
      state.updatePublishedAt = String(result.publishedAt || "");
        state.updateCanInstallInApp = result.canInstallInApp === true;
      state.updateStatus = result.updateAvailable ? "available" : "current";
      if (!silent || (notify && result.updateAvailable)) {
        showToast(result.updateAvailable ? t("updateAvailableToast", { version: state.latestVersion }) : t("upToDate"), "success");
      }
    } else if (result?.status === "disabled") {
      state.updateStatus = "idle";
    } else if (result?.status === "unavailable" && result?.reason === "install-location-unsupported") {
      state.updateStatus = "unavailable";
      if (!silent) showToast(t("updateInstallLocationUnsupported"), "error");
    } else {
      state.updateStatus = "error";
      if (!silent) showToast(t("updateCheckFailed"), "error");
    }
    return result;
  } catch {
    state.updateStatus = "error";
    if (!silent) showToast(t("updateCheckFailed"), "error");
    return null;
  } finally {
    syncSettingsMenuView();
  }
}

function visualModelStatusMarkup() {
  const visual = state.visualModelStatus;
  if (!visual) return `<span class="settings-static-value">${escapeHtml(t("visualModelChecking"))}</span>`;
  const stateKey = visual.state === "ready"
    ? "visualModelReady"
    : visual.state === "runtime-unavailable"
      ? "visualModelRuntimeUnavailable"
      : visual.state === "loading"
        ? "visualModelLoading"
        : visual.state === "error"
          ? "visualModelError"
          : visual.state === "disabled"
            ? "visualModelDisabled"
            : visual.state === "not-installed"
              ? "visualModelNotInstalled"
              : "visualModelUnavailable";
  const pack = visual.active_pack;
  const bytes = Number(pack?.total_bytes || 0);
  const sizeLabel = bytes > 0 ? ` · ${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB` : "";
  const modelLabel = pack ? `${pack.id} · ${pack.revision}${sizeLabel}` : "";
  const distribution = visual.distribution || {};
  const progress = distribution.progress || null;
  const progressPercent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
  const releaseBytes = Number(distribution.release?.total_size || 0);
  const releaseSize = releaseBytes > 0 ? ` · ${(releaseBytes / (1024 * 1024)).toFixed(0)} MB` : "";
  const releaseLabel = !pack && distribution.release
    ? `${distribution.release.id} · ${distribution.release.license?.id || ""}${releaseSize}`
    : "";
  const actions = [];
  if (progress && ["preparing", "downloading", "verifying", "installing"].includes(progress.phase)) {
    actions.push(`<span class="visual-model-progress">${escapeHtml(t(progress.phase === "verifying" ? "visualPackVerifying" : progress.phase === "installing" ? "visualPackInstalling" : "visualPackDownloading"))} ${progressPercent}%</span>`);
    if (window.electronAPI?.cancelVisualPackInstall) actions.push(`<button class="settings-text-action" type="button" data-visual-pack-cancel>${escapeHtml(t("visualPackCancel"))}</button>`);
  } else if ((distribution.action === "install" || distribution.action === "update") && window.electronAPI?.installVisualPack) {
    actions.push(`<button class="settings-text-action" type="button" data-visual-pack-install>${escapeHtml(t(distribution.action === "update" ? "visualPackUpdate" : "visualPackInstall"))}</button>`);
  }
  if (visual.installed && window.electronAPI?.setVisualModelEnabled) {
    actions.push(`<button class="settings-text-action" type="button" data-visual-model-toggle>${escapeHtml(t(visual.enabled ? "visualModelDisable" : "visualModelEnable"))}</button>`);
  }
  if (visual.installed && window.electronAPI?.removeVisualPack) {
    actions.push(`<button class="settings-text-action settings-text-action-danger" type="button" data-visual-pack-remove>${escapeHtml(t("visualPackRemove"))}</button>`);
  }
  const releaseNote = distribution.error
    ? `<span class="visual-model-error">${escapeHtml(t("visualPackReleaseUnavailable"))}</span>`
    : (!visual.installed && distribution.action === "unavailable")
      ? `<span class="visual-model-error">${escapeHtml(t("visualPackNotPublished"))}</span>`
      : "";
  return `<div class="visual-model-status"><strong>${escapeHtml(t(stateKey))}</strong>${modelLabel ? `<span>${escapeHtml(modelLabel)}</span>` : ""}${releaseLabel ? `<span>${escapeHtml(releaseLabel)}</span>` : ""}${releaseNote}${actions.join("")}</div>`;
}

async function refreshVisualModelStatus({ force = false } = {}) {
  if (!window.electronAPI?.getVisualModelState) return null;
  // refreshVisualModelStatus fires on every Visual Pack install / remove / state
  // tick and used to call syncSettingsMenuView unconditionally. That made the
  // hidden Settings panel re-parse its innerHTML on every status update. Burst
  // events are now collapsed into one trailing sync, and the sync is skipped
  // while Settings is hidden — the dialog open path forces a fresh render.
  const runNow = force === true;
  try {
    state.visualModelStatus = await window.electronAPI.getVisualModelState(runNow);
  } catch {
    state.visualModelStatus = { mode: "mosa-local", state: "unavailable", installed: false, enabled: false };
  }
  if (runNow) syncSettingsMenuView();
  else scheduleSettingsMenuSync();
  return state.visualModelStatus;
}

function scheduleSettingsMenuSync() {
  if (settingsSyncScheduled) return;
  settingsSyncScheduled = true;
  settingsSyncTimer = setTimeout(() => {
    settingsSyncScheduled = false;
    settingsSyncTimer = null;
    syncSettingsMenuView();
  }, SETTINGS_SYNC_DEBOUNCE_MS);
}

function syncSettingsMenuView() {
  const menu = els.settingsMenu;
  if (!menu?.querySelector(".settings-modal-card")) return;
  // Hidden Settings panels must not re-parse innerHTML on every library refresh
  // or Visual Pack state tick — the dialog open path calls renderSettingsMenu()
  // which already forces a fresh render from current state.
  if (menu.hidden) return;
  const setRadioState = (selector, selectedValue) => {
    menu.querySelectorAll(selector).forEach((button) => {
      button.classList.toggle("active", button.value === selectedValue || button.dataset.appearanceOpt === selectedValue || button.dataset.cardInfoOpt === selectedValue || button.dataset.confirmTrashOpt === selectedValue || button.dataset.locale === selectedValue);
    });
  };
  setRadioState("[data-appearance-opt]", state.themeSetting);
  setRadioState("[data-card-info-opt]", state.showCardInfo ? "show" : "hide");
  setRadioState("[data-confirm-trash-opt]", moveToTrashConfirmSuppressed() ? "off" : "on");
  setRadioState("[data-locale]", state.locale === "en" ? "en" : "zh");

  const libraryPath = state.libraryRoot || state.libraryPath || state.codexImagesDir || "—";
  const pathNode = menu.querySelector("[data-settings-library-path]");
  if (pathNode) {
    // 任务 110：库路径改「头 + 尾」两段中间省略（末尾保留最关键的库文件夹名），
    // textContent 拼接仍是完整路径，title 悬停显示全路径。
    const librarySegments = pathEllipsisSegments(libraryPath);
    pathNode.innerHTML = `<span class="me-head">${escapeHtml(librarySegments.head)}</span><span class="me-tail">${escapeHtml(librarySegments.tail)}</span>`;
    pathNode.title = libraryPath;
  }
  const storageNode = menu.querySelector("[data-settings-storage-engine]");
  if (storageNode) storageNode.textContent = state.storageKind === "sqlite" ? t("storageEngineValue") : (state.storageKind && state.storageKind !== "unknown" ? state.storageKind : "—");
  const versionNode = menu.querySelector("[data-settings-version]");
  if (versionNode) versionNode.textContent = updateVersionSummary();
  const visualNode = menu.querySelector("[data-settings-visual-model]");
  if (visualNode) visualNode.innerHTML = visualModelStatusMarkup();
  const updateAction = menu.querySelector("[data-settings-update-action]");
  if (updateAction) {
    const markup = updateVersionControlMarkup();
    if (updateAction.innerHTML !== markup) updateAction.innerHTML = markup;
  }
  const changeLibraryButton = menu.querySelector("[data-change-library]");
  if (changeLibraryButton) {
    changeLibraryButton.disabled = state.libraryMoveInProgress;
    changeLibraryButton.textContent = state.libraryMoveInProgress ? t("changingLocation") : t("changeLocation");
  }
  syncSegmentedRadios(menu);
}

function renderSettingsMenu({ force = false } = {}) {
  if (!els.settingsMenu) return;
  const existingDialog = els.settingsMenu.querySelector(".settings-modal-card");
  if (existingDialog && !force) {
    syncSettingsMenuView();
    return;
  }

  const refreshingVisibleDialog = Boolean(existingDialog && !els.settingsMenu.hidden);
  if (refreshingVisibleDialog) els.settingsMenu.setAttribute("data-refreshing", "true");
  // 语言切换等可见重建会销毁焦点节点：先记录焦点"身份"，重建后恢复到原来的位置附近。
  const previousFocus = refreshingVisibleDialog ? describeSettingsFocus(document.activeElement) : null;

  const settingIcon = (path) => `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
  const radio = (selected, attribute, value, label) => `<button class="segmented-btn${selected ? " active" : ""}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" ${attribute}="${value}">${label}</button>`;
  const segmented = (ariaLabel, attribute, selectedValue, options) => {
    const activeIndex = Math.max(0, options.findIndex((option) => option.value === selectedValue));
    const buttons = options.map((option) => radio(option.value === selectedValue, attribute, option.value, option.label)).join("");
    return `<div class="segmented" role="radiogroup" aria-label="${escapeHtml(ariaLabel)}" data-active-index="${activeIndex}"><span class="segmented-thumb" aria-hidden="true"></span>${buttons}</div>`;
  };
  // 任务 42：主题行是 R21 预览卡。语义与分段按钮一致：radiogroup + radio +
  // aria-checked + roving tabindex + data-appearance-opt，状态同步复用
  // syncSegmentedRadios（组选择器扩到 .settings-theme-choices，不另立第二套）。
  // 预览图 aria-hidden，卡的可访问名称来自可见标签；选中除颜色外还有右上角勾号
  // 徽章这个非颜色标志。任务 81 返工 1：三张卡——跟随系统（左半浅色右半深色
  // 预览）/浅色/深色，顺序照稿子，跟随系统在最左。
  const themePreviewInnards = () => `<span class="settings-theme-chrome"><i></i><i></i><i></i></span><span class="settings-theme-body"><span class="settings-theme-nav"><i></i><i></i></span><span class="settings-theme-canvas"><span class="settings-theme-grid"><i></i><i></i><i></i><i></i><i></i><i></i></span></span><span class="settings-theme-aside"></span></span>`;
  const themeChoiceCard = (selected, attribute, value, label) => `<button class="settings-theme-card${selected ? " active" : ""}" type="button" role="radio" aria-checked="${selected}" tabindex="${selected ? 0 : -1}" ${attribute}="${value}">${value === "system"
    ? `<span class="settings-theme-preview settings-theme-preview-system" aria-hidden="true"><span class="settings-theme-half settings-theme-half-light">${themePreviewInnards()}</span><span class="settings-theme-half settings-theme-half-dark">${themePreviewInnards()}</span><span class="settings-theme-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span></span>`
    : `<span class="settings-theme-preview" aria-hidden="true">${themePreviewInnards()}<span class="settings-theme-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span></span>`}<span class="settings-theme-label">${label}</span></button>`;
  const themeChoices = (ariaLabel, attribute, selectedValue, options) => `<div class="settings-theme-choices" role="radiogroup" aria-label="${escapeHtml(ariaLabel)}">${options.map((option) => themeChoiceCard(option.value === selectedValue, attribute, option.value, option.label)).join("")}</div>`;
  // 任务 81：设置行照稿子改为「左名称（可带一行内联小字说明），右控件」，行之间
  // 分隔线；行首图标位按稿子去掉（图标只保留在左栏导航上）。
  const row = (title, subtitle, control = "", extraClass = "") => `<div class="settings-modal-row${extraClass ? ` ${extraClass}` : ""}"><div class="settings-row-copy"><h4>${title}</h4>${subtitle ? `<p>${subtitle}</p>` : ""}</div>${control ? `<div class="settings-row-control">${control}</div>` : ""}</div>`;
  const visualLocale = state.locale === "en" ? "en" : "zh";
  const libraryPathValue = state.libraryRoot || state.libraryPath || state.codexImagesDir || "—";
  const libraryPathSegments = pathEllipsisSegments(libraryPathValue);
  const path = escapeHtml(libraryPathValue);
  const closeIcon = settingIcon("m6 6 12 12M18 6 6 18");
  const storageLabel = state.storageKind === "sqlite" ? t("storageEngineValue") : (state.storageKind && state.storageKind !== "unknown" ? state.storageKind : "—");
  // 任务 81：稿子把素材库行画成「只读路径框 + 框尾内嵌打开按钮」；「更改位置」
  // 稿子没画，按既定决定保留（桌面版渲染在路径框右侧），浏览器版仍只有打开。
  // 任务 110：路径改「头 + 尾」两段中间省略（末尾保留库文件夹名），title 仍全路径。
  const libraryPathBox = `<div class="settings-path-box"><span class="settings-path" data-settings-library-path title="${path}"><span class="me-head">${escapeHtml(libraryPathSegments.head)}</span><span class="me-tail">${escapeHtml(libraryPathSegments.tail)}</span></span><button class="settings-text-action" type="button" data-open-library>${t("settingsOpenLibrary")}</button></div>`;
  const changeLibraryControl = window.electronAPI?.changeLibraryLocation
    ? `<button class="settings-text-action" type="button" data-change-library${state.libraryMoveInProgress ? " disabled" : ""}>${state.libraryMoveInProgress ? t("changingLocation") : t("change")}</button>`
    : "";
  // 任务 81：主题行照稿子只放预览卡（沿用任务 42 的两卡结构与 radio 语义）；
  // 卡片信息、界面语言保持二选一分段按钮，选项顺序照稿子（隐藏｜显示、中文｜EN）。
  const themeRow = `<div class="settings-modal-row settings-theme-row"><div class="settings-row-control">${themeChoices(t("themeMode"), "data-appearance-opt", state.themeSetting, [{ value: "system", label: t("themeSystem") }, { value: "light", label: t("themeLight") }, { value: "dark", label: t("themeDark") }])}</div></div>`;
  const appearanceRows = [
    themeRow,
    row(t("cardInfo"), "", segmented(t("cardInfo"), "data-card-info-opt", state.showCardInfo ? "show" : "hide", [{ value: "hide", label: t("cardInfoHide") }, { value: "show", label: t("cardInfoShow") }])),
    // 任务 94（A4f）：「不再提醒」的找回入口。读写同一个存储键（mosa.confirm-move-to-trash），
    // 渲染时现读现显——确认框里勾选写入后，打开设置即显示「关闭」。
    row(t("confirmMoveToTrashSetting"), "", segmented(t("confirmMoveToTrashSetting"), "data-confirm-trash-opt", moveToTrashConfirmSuppressed() ? "off" : "on", [{ value: "off", label: t("confirmTrashOff") }, { value: "on", label: t("confirmTrashOn") }])),
    row(t("interfaceLanguage"), "", segmented(t("interfaceLanguage"), "data-locale", visualLocale, [{ value: "zh", label: "中文" }, { value: "en", label: "EN" }]))
  ].join("");
  const storageRows = [
    row(t("libraryPath"), "", `${libraryPathBox}${changeLibraryControl}`, "settings-library-row"),
    row(t("storageEngine"), "", `<span class="settings-static-value" data-settings-storage-engine>${escapeHtml(storageLabel)}</span>`),
  ].join("");
  // 任务 109：模型页改「标题一行，说明和状态在下面另起一行」——不再用 row()
  // 的左右两栏（说明与状态此前挤在右栏被截断）；状态节点 data-settings-visual-model
  // 保留，syncSettingsMenuView 仍按它原地刷新。
  const visualRows = `<div class="settings-modal-row settings-visual-model-row"><div class="settings-row-copy"><h4>${t("visualModelTitle")}</h4></div><div class="settings-visual-model-detail"><p>${t("visualModelDescription")}</p><div data-settings-visual-model>${visualModelStatusMarkup()}</div></div></div>`;
  // 任务 109：关于页在版本号上面加一行产品名（复用既有 appTitle 键，不新加文案）。
  const aboutProductRow = `<div class="settings-modal-row settings-about-product-row"><div class="settings-row-copy"><h4 class="settings-about-product-name">${t("appTitle")}</h4></div></div>`;
  const aboutRow = row(t("version"), `<span data-settings-version>${escapeHtml(updateVersionSummary())}</span>`, `<div data-settings-update-action>${updateVersionControlMarkup()}</div>`, "settings-about-row");
  // 用户 ID 行（任务 69）：只在拿到安装 ID 时渲染（浏览器版没有这一行）。
  // 值复用 .settings-path（等宽 + 省略号截断 + title 悬停看全量）；复制复用
  // settings-text-action 与 writeClipboardText，成功提示走既有 toast。
  const userIdRow = state.userProfileId
    ? row(t("userId"), `<span class="settings-path" data-settings-user-id title="${escapeHtml(state.userProfileId)}">${escapeHtml(state.userProfileId)}</span>`, `<button class="settings-text-action" type="button" data-copy-user-id>${escapeHtml(t("copyAction"))}</button>`)
    : "";

  // R21 两栏设置 + 任务 81 GravityPort 重排：左栏大标题 + 分类导航（+ 本地优先
  // 说明），右栏标题栏 + 四个分类页。行内容复用 row()，控件与 data-* 属性不变；
  // 稿子每页只有标题和行，页内不再重复渲染页标题与说明（文案保留在 i18n）。
  const settingsPages = [
    { id: "general", label: t("settingsPageGeneral"), rows: appearanceRows, icon: settingIcon("M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0") },
    { id: "library", label: t("settingsPageLibrary"), rows: storageRows, icon: settingIcon("M3 7.5A2.5 2.5 0 0 1 5.5 5h4l1.7 2h7.3A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-10Z") },
    { id: "visual", label: t("settingsPageVisual"), rows: visualRows, icon: settingIcon("M5 7h14M7 4v6M17 4v6M6 14h12M8 11v6M16 11v6M5 20h14") },
    { id: "about", label: t("settingsPageAbout"), rows: aboutProductRow + aboutRow + userIdRow, icon: settingIcon("M12 10v5M12 7.5v.1M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0") },
  ];
  if (!settingsPages.some((page) => page.id === state.settingsPage)) state.settingsPage = "general";
  const activePage = state.settingsPage;
  const nav = settingsPages.map((page) => {
    const active = page.id === activePage;
    return `<button class="settings-nav-tab${active ? " active" : ""}" type="button" role="tab" id="settings-tab-${page.id}" aria-selected="${active}" aria-controls="settings-page-${page.id}" data-settings-page="${page.id}" tabindex="${active ? 0 : -1}">${page.icon}<span class="settings-nav-tab-label">${page.label}</span></button>`;
  }).join("");
  const panels = settingsPages.map((page) => `<section class="settings-page" role="tabpanel" id="settings-page-${page.id}" aria-labelledby="settings-tab-${page.id}" data-settings-panel="${page.id}"${page.id === activePage ? "" : " hidden"}><div class="settings-group">${page.rows}</div></section>`).join("");
  const activeLabel = settingsPages.find((page) => page.id === activePage)?.label || "";

  els.settingsMenu.innerHTML = `<div class="settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsModalTitle" tabindex="-1"><aside class="settings-modal-sidebar"><div class="settings-modal-brand"><h2 id="settingsModalTitle">${t("settings")}</h2></div><nav class="settings-modal-nav" role="tablist" aria-orientation="vertical" aria-label="${escapeHtml(t("settings"))}">${nav}</nav><div class="settings-modal-foot"><div class="settings-local-first">${settingIcon("M5.5 5.5C5.5 4.1 8.4 3 12 3s6.5 1.1 6.5 2.5S15.6 8 12 8 5.5 6.9 5.5 5.5ZM5.5 5.5v6C5.5 12.9 8.4 14 12 14s6.5-1.1 6.5-2.5v-6M5.5 11.5v6C5.5 18.9 8.4 20 12 20s6.5-1.1 6.5-2.5v-6")}<div class="settings-local-first-copy"><strong>${t("settingsLocalFirst")}</strong><p>${t("settingsLocalFirstDesc")}</p></div></div></div></aside><div class="settings-modal-main"><header class="settings-modal-header"><h2 class="settings-modal-title" data-settings-active-title>${activeLabel}</h2><button class="settings-modal-close" type="button" data-settings-close aria-label="${escapeHtml(t("closeSettings"))}">${closeIcon}</button></header><div class="settings-modal-body">${panels}</div></div></div>`;
  syncSettingsMenuView();
  if (refreshingVisibleDialog) {
    restoreSettingsFocus(previousFocus);
    requestAnimationFrame(() => els.settingsMenu?.removeAttribute("data-refreshing"));
  }
}

// 设置弹窗内焦点的"身份"：导航标签记分类，普通控件记它的 data-* 选择器。
// 重建后由 restoreSettingsFocus 优先回到原控件，其次回到当前分类的标签。
function describeSettingsFocus(element) {
  if (!(element instanceof HTMLElement) || !els.settingsMenu?.contains(element)) return null;
  const tab = element.closest("[data-settings-page]");
  if (tab) return { page: tab.dataset.settingsPage, control: null };
  const attributes = ["data-appearance-opt", "data-card-info-opt", "data-confirm-trash-opt", "data-locale", "data-open-library", "data-copy-user-id", "data-change-library", "data-check-updates", "data-cancel-update", "data-install-update", "data-download-latest", "data-visual-model-toggle", "data-visual-pack-install", "data-visual-pack-cancel", "data-visual-pack-remove", "data-settings-close"];
  for (const attribute of attributes) {
    const value = element.getAttribute(attribute);
    if (value !== null) return { page: state.settingsPage, control: `[${attribute}="${CSS.escape(value)}"]` };
  }
  return { page: state.settingsPage, control: null };
}

function restoreSettingsFocus(previousFocus) {
  if (!previousFocus) return;
  if (previousFocus.control) {
    const control = els.settingsMenu.querySelector(previousFocus.control);
    if (control && !control.closest("[hidden]") && !control.disabled) {
      control.focus();
      return;
    }
  }
  els.settingsMenu.querySelector(`[data-settings-page="${CSS.escape(previousFocus.page)}"]`)?.focus();
}

// 分类切换的唯一入口：同步 aria-selected / roving tabindex / 面板 hidden 与右栏标题。
function activateSettingsPage(pageId) {
  const menu = els.settingsMenu;
  const targetTab = menu?.querySelector(`[data-settings-page="${CSS.escape(pageId)}"]`);
  if (!targetTab) return;
  state.settingsPage = pageId;
  for (const tab of menu.querySelectorAll("[data-settings-page]")) {
    const active = tab === targetTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of menu.querySelectorAll("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== pageId;
  }
  const title = menu.querySelector("[data-settings-active-title]");
  if (title) title.textContent = targetTab.querySelector(".settings-nav-tab-label")?.textContent || targetTab.textContent.trim();
}

const ARROW_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
// Cards in the same masonry column share a left edge to within a rounding error.
const COLUMN_TOLERANCE_PX = 4;
let cachedCardGeometry = null;
let cachedCardGeometryGrid = null;

function invalidateCardGeometryCache() {
  cachedCardGeometry = null;
  cachedCardGeometryGrid = null;
}

/** Rendered card geometry, so navigation follows what the reader can see. */
function cardGeometry() {
  if (cachedCardGeometry && cachedCardGeometryGrid === els.assetGrid) return cachedCardGeometry;
  const cards = [...(els.assetGrid?.querySelectorAll(".asset-card") || [])];
  cachedCardGeometryGrid = els.assetGrid;
  cachedCardGeometry = cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { id: card.dataset.id, left: box.left, top: box.top, bottom: box.bottom, centerX: box.left + box.width / 2, centerY: box.top + box.height / 2 };
  }).filter((entry) => entry.id);
  return cachedCardGeometry;
}

/**
 * A masonry grid places cards in columns of unequal height, so index arithmetic
 * does not describe what is next to what. Left/right move within the visual row
 * and up/down within the visual column, both measured from the rendered boxes.
 */
function neighbourAssetId(key) {
  const cards = cardGeometry();
  const current = cards.find((entry) => entry.id === state.selectedId);
  if (!current) return null;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const wanted = key === "ArrowRight" ? 1 : -1;
    const inDirection = cards.filter((entry) => entry.id !== current.id
      && Math.sign(entry.centerX - current.centerX) === wanted);
    // "Beside" in a staggered layout means the boxes overlap vertically. When
    // nothing overlaps, fall back to the nearest card in that direction.
    const overlapping = inDirection.filter((entry) => entry.top < current.bottom && entry.bottom > current.top);
    const pool = overlapping.length ? overlapping : inDirection;
    if (!pool.length) return null;
    return pool.reduce((best, entry) => {
      const score = Math.abs(entry.centerX - current.centerX) + Math.abs(entry.centerY - current.centerY) * 2;
      return score < best.score ? { id: entry.id, score } : best;
    }, { id: null, score: Infinity }).id;
  }
  const wanted = key === "ArrowDown" ? 1 : -1;
  const sameColumn = cards.filter((entry) => entry.id !== current.id
    && Math.abs(entry.left - current.left) <= COLUMN_TOLERANCE_PX
    && Math.sign(entry.centerY - current.centerY) === wanted);
  if (!sameColumn.length) return null;
  return sameColumn.reduce((best, entry) => {
    const distance = Math.abs(entry.centerY - current.centerY);
    return distance < best.distance ? { id: entry.id, distance } : best;
  }, { id: null, distance: Infinity }).id;
}

function handleLibraryKeyboardNavigation(event) {
  bindKeyboardNav(event);
}

// Gallery arrow navigation is a pure branch of the single application keydown
// router. The name is retained for the Phase 3 contract seam; it does not add a
// second document listener or a second shortcut manager.
function bindKeyboardNav(event) {
  // 浮层（确认框/建组/分组统计/堆叠重命名/设置/大图预览）打开时方向键不归画廊。
  // confirmDialogState.pending 字面量被 confirm-dialog-contract「Escape consumed
  // first」锁定，需与统一判定并排保留。
  if (confirmDialogState.pending || hasBlockingOverlay()) return;
  if (event.target.closest?.("[contenteditable]")) return;
  if (event.target.closest?.("[role='tab']")) return;
  // Phase 3A：箭头键画廊导航仅属库内模式；查看模式下不切换选中资产（上一张/下一张属 Phase 3C）。
  if (state.viewMode !== "library") return;
  if (!ARROW_KEYS.has(event.key) || !state.assets.length) return;
  if (!state.assets.some((asset) => asset.id === state.selectedId)) return;
  const nextId = neighbourAssetId(event.key);
  if (!nextId) return;
  event.preventDefault();
  void selectGalleryNode(nextId, true);
}

// ===== ConfirmDialog（已提取至 confirm-dialog.mjs，R1 批次 3）=====
const confirmDialog = createConfirmDialog({ els, state, t, closePanel });
const { requestConfirmation, requestFollowupConfirmation, closeConfirmDialog, trapConfirmDialogFocus, isConfirmFocusTarget, confirmDialogState } = confirmDialog;

const toastManager = createToastManager({ els, state, t, isConfirmFocusTarget });
function showToast(message, type = "default", options = {}) { return toastManager.show(message, type, options); }
async function writeClipboardText(value) {
  // 任务 93：应用内写剪贴板会使剪切状态失效（剪贴板不再是被剪切的内容）。
  cutPaste?.noteClipboardWrite?.();
  const text = String(value ?? "");
  if (window.electronAPI?.writeClipboardText) {
    const result = await window.electronAPI.writeClipboardText(text);
    if (result?.ok !== true) throw new Error(t("copyFailed"));
    return;
  }
  if (!navigator.clipboard?.writeText) throw new Error(t("copyFailed"));
  await navigator.clipboard.writeText(text);
}

async function clipboardPngBlob(blob) {
  if (blob.type === "image/png") return blob;
  if (typeof createImageBitmap !== "function") throw new Error(t("copyImageFailed"));
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error(t("copyImageFailed"));
    context.drawImage(bitmap, 0, 0);
    return await new Promise((resolvePromise, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) resolvePromise(pngBlob);
        else reject(new Error(t("copyImageFailed")));
      }, "image/png");
    });
  } finally {
    bitmap.close?.();
  }
}

async function writeClipboardImage(asset = {}, options = {}) {
  // 任务 93：「复制图片」取消剪切状态；剪切自身的原图写入（skipCutInvalidation）
  // 不算「再次写剪贴板」。
  if (options.skipCutInvalidation !== true) cutPaste?.noteClipboardWrite?.();
  if (isVideoAsset(asset)) throw new Error(t("copyImageFailed"));
  const imagePath = String(asset.image_path || "").trim();
  if (window.electronAPI?.writeClipboardImage && imagePath) {
    const result = await window.electronAPI.writeClipboardImage(imagePath);
    if (result?.ok !== true) throw new Error(t("copyImageFailed"));
    return;
  }

  const imageUrl = String(asset.image_url || "").trim();
  if (!imageUrl || !navigator.clipboard?.write || typeof ClipboardItem !== "function") {
    throw new Error(t("copyImageFailed"));
  }
  const response = await fetch(imageUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(t("copyImageFailed"));
  const sourceBlob = await response.blob();
  if (!sourceBlob.type.startsWith("image/")) throw new Error(t("copyImageFailed"));
  // Browser clipboard implementations are most interoperable with PNG. This
  // conversion keeps the original image dimensions and pixels; importantly,
  // it starts from image_url (the stored original), never thumbnail_url.
  const clipboardBlob = await clipboardPngBlob(sourceBlob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": clipboardBlob })]);
}
// 只读调试钩子：仅供契约/运行时验证取证（队列位置、remaining、暂停原因），
// 不向 UI 暴露、不参与任何业务决策。
window.__mosaToastDebug = () => toastManager.snapshot();

// ===== Context Menu =====
const contextMenu = createContextMenu();
// 任务 93：剪切粘贴控制器（状态、变淡渲染、移动接口、失焦取消都在 cut-paste.mjs）。
const cutPaste = createCutPasteController({
  state,
  els,
  t,
  apiFetch,
  showToast,
  announceGalleryStatus,
  librarySync,
  loadStats,
  copyOriginalImage: writeClipboardImage,
});
const contextMenuActions = createContextMenuActions({
  state,
  els,
  t,
  apiClient,
  showToast,
  runAction,
  requestConfirmation,
  requestFollowupConfirmation,
  confirmDetailNavigation,
  discardDetailDraft,
  releaseAssetMedia: releaseAssetMediaForDeletion,
  openGroupModal,
  openStackRenameModal,
  loadAssets: (...args) => loadAssets(...args),
  getGroupColor: colorForGroup,
  writeClipboardText,
  copyOriginalImage: writeClipboardImage,
  isVideoAsset,
  pasteClipboardImage: window.electronAPI?.pasteImage ? pasteClipboardImage : null,
  assetStacks,
  cutPaste,
  emptyTrash: emptyTrashWithConfirmation,
  gallerySelection,
});

// 顶栏“清空回收站”按钮与回收站空白处右键菜单共用的同一段确认 + 批量删除。
async function emptyTrashWithConfirmation() {
  if (state.scope !== "trash" || !Number(state.groups?.trash || 0)) return;
  const confirmed = await requestConfirmation({
    title: t("emptyTrashTitle"),
    description: t("emptyTrashDescription"),
    confirmLabel: t("emptyTrash"),
    tone: "danger",
  });
  if (!confirmed) return;
  await runAction(async () => {
    await releaseAssetMediaForDeletion(state.assets);
    const result = await apiFetch("/api/trash", { method: "DELETE", body: { projectId: state.project } });
    if (result.partial) {
      showToast(t("trashPartialDelete", { count: result.failed?.length || 0 }), "error");
    } else {
      showToast(t("trashEmptied"), "success");
    }
    clearDetailSelection();
    gallerySelection.clear();
    await Promise.all([loadStats(), loadAssets()]);
  });
}

async function releaseAssetMediaForDeletion(assets = []) {
  const ids = new Set(assets.map((asset) => asset?.id).filter(Boolean));
  if (!ids.size) return;
  if (state.imagePreviewId && ids.has(state.imagePreviewId)) {
    els.imagePreviewVideo?.pause?.();
    els.imagePreviewVideo?.removeAttribute("src");
    els.imagePreviewVideo?.load?.();
    els.imagePreviewImage?.removeAttribute("src");
  }
  if (state.selectedId && ids.has(state.selectedId)) {
    els.assetViewVideo?.pause?.();
    els.assetViewVideo?.removeAttribute("src");
    els.assetViewVideo?.load?.();
    els.detailPanel?.querySelectorAll("video").forEach((video) => {
      video.pause?.();
      video.removeAttribute("src");
      video.load?.();
    });
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
}

// ===== 大图页删除（GravityPort A4c，任务 90） =====
// 右上「删除」：确认框照既有回收站语义弹；成功后自动落到下一张（末端落上一张、
// 删光回画廊），并弹带「撤销」的 toast——撤销调用现有 restore 端点并回到这张图。
// 翻页/回画廊由 assetViewer.advanceAfterViewerDelete 负责（序列语义与导航同源）；
// 本地对账直接走 librarySync（可 await），撤销回图前 state.assets 已含恢复行。
async function deleteCurrentAssetFromViewer() {
  if (state.viewMode !== "asset") return;
  // 任务 96 返工 1：selectedId 可能被后台刷新竞态洗掉（loadAssets 的过期响应晚于
  // 撤销完成）。删除以「舞台当前显示的图」为准：先从本地列表恢复锚；本地没有
  // （列表整体过期）再回源查一次；确实不在库才提示，绝不静默无反应。
  let asset = selectedAsset();
  if (!asset) {
    const viewedId = assetViewer.currentViewedAssetId();
    if (viewedId) {
      asset = state.assets.find((candidate) => candidate.id === viewedId) || null;
      if (asset) state.selectedId = viewedId;
    }
  }
  if (!asset) {
    const viewedId = assetViewer.currentViewedAssetId();
    const fresh = viewedId
      ? await apiFetch("/api/assets/" + encodeURIComponent(state.project) + "/" + encodeURIComponent(viewedId)).catch(() => null)
      : null;
    asset = fresh?.asset || null;
    if (asset) {
      if (!state.assets.some((candidate) => candidate.id === asset.id)) state.assets = [...state.assets, asset];
      state.selectedId = asset.id;
    }
  }
  if (!asset) {
    showToast(t("assetNoLongerAvailable"), "error");
    return;
  }
  if (!await confirmDetailNavigation()) return;
  // 任务 94（A4f）：勾过「不再提醒」后大图页删除不再弹确认框（草稿守卫照旧在前）。
  if (!moveToTrashConfirmSuppressed()) {
    // 任务 111：按钮写动作（取消 / 移到回收站），不再用「否 / 是」。
    const confirmed = await requestConfirmation({
      title: t("moveToTrashTitle"),
      description: t("moveToTrashDescription"),
      confirmLabel: t("moveToTrash"),
      cancelLabel: t("cancel"),
      tone: "danger",
      dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY,
    });
    if (!confirmed) return;
  }
  const projectId = asset.project_id || state.project;
  const deletedId = asset.id;
  let response = null;
  try {
    response = await apiFetch("/api/assets/batch", {
      method: "POST",
      body: { action: "trash", projectId, assetIds: [deletedId] },
    });
  } catch (error) {
    showToast(error.message, "error");
    return;
  }
  const failed = Boolean(response?.partial) && Array.isArray(response.results)
    && response.results.some((result) => String(result?.id || "") === String(deletedId) && result?.ok === false);
  if (failed) {
    showToast(t("batchPartialResult", { succeeded: 0, failed: 1 }), "error");
    return;
  }
  if (state.detailDirty) discardDetailDraft();
  await releaseAssetMediaForDeletion([asset]);
  assetViewer.advanceAfterViewerDelete();
  await librarySync.applyLocalChanges([{ kind: "asset-deleted", entityType: "asset", entityId: String(deletedId) }]).catch(() => {});
  void loadStats({ background: true }).catch(() => {});
  showToast(t("assetMovedToTrash"), "success", {
    actionLabel: t("undo"),
    duration: 6000,
    onAction: () => { void restoreTrashedAssetFromViewer(projectId, deletedId); },
  });
}

async function restoreTrashedAssetFromViewer(projectId, assetId) {
  try {
    await apiFetch(`/api/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(assetId)}/restore`, { method: "POST" });
  } catch (error) {
    showToast(error.message, "error");
    return;
  }
  await librarySync.applyLocalChanges([{ kind: "asset-restored", entityType: "asset", entityId: String(assetId) }]).catch(() => {});
  void loadStats({ background: true }).catch(() => {});
  if (state.viewMode === "asset") {
    // 大图页内：切回这张图（草稿确认与 openAssetView 同一套语义）。
    if (!await confirmDetailNavigation()) return;
    assetViewer.showAssetInView(assetId);
    return;
  }
  // 已回画廊（删除时删光了序列）：直接在大图页打开这张图。
  void openAssetView(assetId);
}

function isDetailEditorActive() {
  const active = document.activeElement;
  const generationDraft = [...(els.detailPanel?.querySelectorAll("[data-generation-composer]") || [])].some((composer) => {
    const prompt = composer.querySelector("[data-generation-continue-prompt]")?.value.trim();
    const references = composer.querySelector("[data-generation-reference-id]");
    return Boolean(prompt || references);
  });
  return state.detailDirty
    || generationDraft
    || (active instanceof HTMLElement && Boolean(els.detailPanel?.contains(active) && active.closest("[data-edit], [data-version-change], [data-recipe-change], [data-tag-editor], [data-generation-composer]")));
}

function latestAssetSnapshot(projectId, assetId, fallback = null) {
  if (state.detailAsset?.project_id === projectId && state.detailAsset?.id === assetId) return state.detailAsset;
  return state.assets.find((item) => item.project_id === projectId && item.id === assetId) || fallback;
}

function createBridgeStatusPolling() {
  return createBridgeStatusPoller({
    fetchStatus: () => apiFetch("/api/bridges"),
    onSuccess: applyBridgeStatus,
    onError: applyBridgeStatusFailure,
  });
}
let bridgeStatusPoller = createBridgeStatusPolling();

// Stop polling when the page goes away and drop any response that lands afterwards.
window.addEventListener("pagehide", () => {
  bridgeStatusPoller.stop();
  stopLibraryEventStream();
  if (libraryRefreshTimer) {
    clearInterval(libraryRefreshTimer);
    libraryRefreshTimer = null;
  }
});
// M6：隐藏标签页暂停轮询（与 refreshLibraryInBackground 的 document.hidden 守卫
// 对齐）；重新可见时恢复并立即刷新一次，指示灯不落后于真实桥接状态。
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    bridgeStatusPoller.pause();
    stopLibraryEventStream();
  }
  else {
    bridgeStatusPoller.resume();
    void refreshBridgeStatus();
    startLibraryEventStream();
    if (!isLoadingMore) void refreshLibraryIfChanged();
  }
});
// bfcache 恢复（浏览器“后退”）：pagehide 已终止旧轮询实例（stop 是不可逆的
// teardown 守卫），pageshow(persisted) 后页面重新可见，重建新实例继续轮询并
// 恢复库刷新间隔，桥接指示灯不再永久冻结在旧值。
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  bridgeStatusPoller = createBridgeStatusPolling();
  void bridgeStatusPoller.refresh();
  bridgeStatusPoller.start();
  startLibraryEventStream();
  if (!libraryRefreshTimer) {
    libraryRefreshTimer = setInterval(() => {
      if (!isLoadingMore) void refreshLibraryIfChanged();
    }, LIBRARY_REFRESH_INTERVAL);
  }
});

function refreshBridgeStatus() {
  return bridgeStatusPoller.refresh();
}

function stopLibraryEventStream() {
  libraryEventSource?.close?.();
  libraryEventSource = null;
}

function startLibraryEventStream() {
  if (document.hidden || typeof EventSource !== "function") return;
  const project = state.project;
  stopLibraryEventStream();
  const source = new EventSource(`/api/library-events?project=${encodeURIComponent(project)}`);
  libraryEventSource = source;
  source.addEventListener("ready", (event) => {
    if (source !== libraryEventSource || project !== state.project) return;
    try {
      const payload = JSON.parse(event.data || "{}");
      void reconcileLibraryRevision(payload.revision);
    } catch {
      // The periodic revision check remains the fallback.
    }
  });
  source.addEventListener("library-changed", (event) => {
    if (source !== libraryEventSource || project !== state.project || isLoadingMore) return;
    let payload = {};
    try {
      payload = JSON.parse(event.data || "{}");
    } catch {
      // Refresh still proceeds even if an optional event payload is malformed.
    }
    if (payload.fromRevision != null && Array.isArray(payload.changes)) {
      // 事件携带 delta：与本地 baseline 连续时直接增量应用，否则由
      // reconcileToRevision 经权威 delta API 补齐缺口。
      void librarySync.handleLibraryEventPayload(payload);
      return;
    }
    const revision = payload.revision;
    void reconcileLibraryRevision(revision);
  });
}

function applyBridgeStatus({ codex, grok, cowart, webCapture } = {}) {
    state.webCaptureStatus = webCapture || null;
    syncSettingsMenuView();
    // Required bridges only: a Grok-only failure must not force global error status.
    const hasError = codex?.lastError || cowart?.lastError;
    const codexOn = Boolean(codex?.enabled);
    const cowartOn = Boolean(cowart?.enabled);
    const grokOn = Boolean(grok?.enabled);
    const bridgeBusy = Boolean(codex?.busy || grok?.busy || cowart?.busy);
    const importedCount = Number(cowart?.totalImported || 0) + Number(codex?.totalImported || 0) + Number(grok?.totalImported || 0);
    const monitoredCount = Number(cowart?.monitoredCount || 0);
    // Grok is optional: global readiness only requires Codex + Cowart.
    if (hasError) setStatus(t("statusBridgeError"), "error");
    else if (bridgeBusy) setStatus(t("statusBridgeBusy"), "warn");
    else if (codexOn && cowartOn) setStatus(t("statusReady"), "ok");
    else if (codexOn || cowartOn || grokOn) setStatus(t("statusBridgePartial"), "warn");
    else setStatus(t("statusBridgeOff"), "warn");
    if (els.bridgeStatusMeta) {
      const meta = [];
      if (monitoredCount > 0) {
        meta.push(monitoredCount === 1
          ? t("statusWatchingOneCanvas")
          : t("statusWatchingCanvasCount", { count: monitoredCount }));
      }
      if (importedCount > 0) meta.push(t("statusImportedCount", { count: importedCount }));
      if (grok?.lastWarning) meta.push(String(grok.lastWarning));
      if (grok?.lastError) meta.push(String(grok.lastError));
      els.bridgeStatusMeta.textContent = meta.join(" · ");
    }
}

function applyBridgeStatusFailure() {
    if (els.bridgeStatusMeta) els.bridgeStatusMeta.textContent = "";
    setStatus(t("statusUnavailable"), "error");
}

function updateViewTitle() {
  const titles = { all: t("allAssets"), favorite: t("favorites"), unorganized: t("unorganized"), trash: t("trash") };
  const hasFacets = Object.values(state.facets || {}).some(Boolean);
  const hasRefinements = Boolean(state.query || state.scope !== "all" || hasFacets
    || (state.mediaKind && state.mediaKind !== "all"));
  els.viewTitle.textContent = state.activeStackId
    ? (hasRefinements
      ? t("stackMatchCount", {
        matched: state.pageTotal || state.assets.length,
        total: state.activeStackSummary?.count || state.pageTotal || state.assets.length,
      })
      : state.activeStackSummary?.name
        ? t("stackNamedItemCount", {
          name: state.activeStackSummary.name,
          count: state.activeStackSummary?.count || state.pageTotal || state.assets.length,
        })
        : t("stackItemCount", { count: state.activeStackSummary?.count || state.pageTotal || state.assets.length }))
    // An open manual group names itself, like an open Stack does; the asset
    // viewer's scope chip mirrors this title.
    : (state.scope === "all" && String(state.facets?.group || "").trim()) || titles[state.scope] || t("allAssets");
  // Match V2 SearchBar's scope-aware hint without changing the shared search
  // control or any query semantics.
  if (els.searchInput) {
    const activeGroup = String(state.facets.group || "").trim();
    els.searchInput.placeholder = state.activeStackId
      ? t("searchStack")
      : activeGroup
      ? t("searchGroup", { group: activeGroup })
      : state.scope === "favorite"
        ? t("searchFavorite")
        : state.scope === "unorganized"
          ? t("searchUnorganized")
          : state.scope === "trash"
            ? t("searchTrash")
            : t("searchAll");
  }
  if (els.emptyTrashBtn) els.emptyTrashBtn.hidden = state.scope !== "trash" || Number(state.groups?.trash || 0) === 0;
  // GravityPort A3：范围变化总会经过这里（渲染/进出堆叠/语言切换），历史按钮
  // 的 disabled 态与滑杆组的重叠隐藏随之同步。
  syncNavHistoryButtons();
  syncGallerySizeGroupVisibility();
}

async function clearSearchQuery() {
  if (!state.query && !els.searchInput?.value) return false;
  const intent = beginNavigationIntent();
  if (!await authorizeNavigationIntent(intent)) return false;
  discardDetailDraft();
  state.query = "";
  if (els.searchInput) els.searchInput.value = "";
  recordNavigationPosition();
  applyFilterChange();
  return true;
}

let navigationIntentRevision = 0;
function beginNavigationIntent() {
  return {
    revision: ++navigationIntentRevision,
    projectId: state.project,
    selectedId: state.selectedId,
  };
}
function isNavigationIntentCurrent(intent) {
  return Boolean(intent)
    && intent.revision === navigationIntentRevision
    && intent.projectId === state.project
    && intent.selectedId === state.selectedId;
}
async function authorizeNavigationIntent(intent) {
  if (!isNavigationIntentCurrent(intent)) return false;
  if (!await confirmDetailNavigation(null)) return false;
  return isNavigationIntentCurrent(intent);
}

// ===== GravityPort A3：浏览位置历史（任务 70）=====
// 记录范围/来源/分组/分类/搜索的位置变化；排序不算位置。恢复走现有
// applyFilterChange 流程且不产生新记录；在中间位置的新导航由 navigation-history
// 模块截断前进记录。只存内存，上限 50，不写本地存储。
const navHistory = createNavigationHistory();

function captureNavigationSnapshot() {
  return {
    scope: state.scope,
    facets: { ...state.facets },
    mediaKind: state.mediaKind,
    query: state.query,
  };
}

function navigationSnapshotsEqual(a, b) {
  if (!a || !b) return false;
  return a.scope === b.scope
    && a.mediaKind === b.mediaKind
    && a.query === b.query
    && FACET_KEYS.every((key) => (a.facets?.[key] || "") === (b.facets?.[key] || ""));
}

// 堆叠内部不是画廊浏览位置：进出堆叠走 #stackBack，历史按钮在堆叠里禁用。
function recordNavigationPosition() {
  if (state.activeStackId) return;
  const snapshot = captureNavigationSnapshot();
  if (navigationSnapshotsEqual(navHistory.current(), snapshot)) return;
  navHistory.push(snapshot);
  syncNavHistoryButtons();
}

function syncNavHistoryButtons() {
  const inStack = Boolean(state.activeStackId);
  if (els.navHistoryBack) els.navHistoryBack.disabled = inStack || !navHistory.canBack();
  if (els.navHistoryForward) els.navHistoryForward.disabled = inStack || !navHistory.canForward();
}

function restoreNavigationSnapshot(entry) {
  discardDetailDraft();
  state.scope = entry.scope || "all";
  state.facets = Object.fromEntries(FACET_KEYS.map((key) => [key, String(entry.facets?.[key] || "")]));
  state.mediaKind = entry.mediaKind || "all";
  state.query = entry.query || "";
  state.nextCursor = null;
  if (els.searchInput) els.searchInput.value = state.query;
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  syncNavHistoryButtons();
  applyFilterChange();
}

// 先 peek 再过未保存编辑确认（authorizeNavigationIntent），确认通过才消费光标：
// 取消确认时光标不能已经移动。
async function navigateGalleryHistory(direction) {
  if (state.activeStackId) return false;
  const entry = direction < 0 ? navHistory.peekBack() : navHistory.peekForward();
  if (!entry) return false;
  const intent = beginNavigationIntent();
  if (!await authorizeNavigationIntent(intent)) return false;
  if (direction < 0) navHistory.back();
  else navHistory.forward();
  restoreNavigationSnapshot(entry);
  return true;
}

function resolveNavHistoryShortcut(event) {
  if (event.target.closest?.("[contenteditable], video")) return 0;
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent || "");
  if (isMac) {
    if ((event.metaKey || event.ctrlKey) && event.key === "[") return -1;
    if ((event.metaKey || event.ctrlKey) && event.key === "]") return 1;
    return 0;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return -1;
    if (event.key === "ArrowRight") return 1;
  }
  return 0;
}

// ===== GravityPort A3：缩略图大小滑杆 → 画廊列数（任务 70）=====
// --gallery-columns 写在 #assetGrid 行内；≤767px 的固定 2 列媒体查询不受它影响。
// 列数变化后走 scheduleMasonryLayout()（全量重放置：瀑布流几何、框选命中、
// 虚拟窗口同步都由既有管线接管）。
function syncGalleryColumns() {
  const grid = els.assetGrid;
  if (!grid) return;
  const styles = getComputedStyle(grid);
  const gap = Number.parseFloat(styles.getPropertyValue("--gallery-gap")) || Number.parseFloat(styles.columnGap) || 0;
  const paddingX = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
  const next = computeGalleryColumnCount(grid.clientWidth - paddingX, galleryTargetCardWidth, gap);
  if (grid.style.getPropertyValue("--gallery-columns") === String(next)) return;
  grid.style.setProperty("--gallery-columns", String(next));
  scheduleMasonryLayout();
}

function applyGalleryCardSize(value, { persist = false } = {}) {
  galleryTargetCardWidth = clampGalleryCardSize(value);
  if (els.gallerySizeSlider) els.gallerySizeSlider.value = String(galleryTargetCardWidth);
  if (persist) safeStorageSet(GALLERY_SIZE_STORAGE_KEY, String(galleryTargetCardWidth));
  syncGalleryColumns();
}

// 滑杆组三态（居中 / 退让居中 / 隐藏）由 computeTopbarSizeGroupPlacement 判定，
// 居中 = 窗口中线（检视器开关都一样），不挤压右侧控件。hidden（display:none）
// 量不到宽度：先临时摆回布局再量，全程同步、不经过绘制帧，三种状态切换不闪
// 烁。居中/退让都写行内 left（hidden 删掉行内值，不留旧位置）。≤767px 档 CSS
// 直接隐藏，JS 只负责维持 hidden 一致。
function syncGallerySizeGroupVisibility() {
  const group = els.topbarSizeGroup;
  if (!group) return;
  if (isMobileNavigationViewport()) {
    group.hidden = true;
    group.style.removeProperty("left");
    return;
  }
  const wasHidden = group.hidden;
  if (wasHidden) group.hidden = false;
  const barRect = group.parentElement?.getBoundingClientRect();
  // 左右各量「实际内容组」：.topbar-context 是 flex:1 的占位容器（撑满剩余
  // 空间），量它会永远判重叠；.topbar-nav-group 才是按钮簇的真实宽度。
  const leftRect = els.navHistoryBack?.closest(".topbar-nav-group")?.getBoundingClientRect();
  const rightRect = els.searchInput?.closest(".topbar-actions")?.getBoundingClientRect();
  const groupWidth = group.offsetWidth;
  const placement = computeTopbarSizeGroupPlacement(
    barRect ? window.innerWidth / 2 - barRect.left : NaN,
    leftRect && barRect ? leftRect.right - barRect.left : NaN,
    rightRect && barRect ? rightRect.left - barRect.left : NaN,
    groupWidth,
  );
  if (placement.left === null) group.style.removeProperty("left");
  else group.style.left = `${placement.left}px`;
  group.hidden = placement.mode === "hidden";
}

function bindEvents() {
  syncMobileNavigation();
  syncSidebarSectionVisibility();
  els.mobileNavToggle?.addEventListener("click", () => setMobileNavOpen(true));
  els.mobileNavClose?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  els.mobileNavScrim?.addEventListener("click", () => setMobileNavOpen(false, { restoreFocus: true }));
  // GravityPort A3：后退/前进按钮与缩略图大小滑杆（任务 70）。
  els.navHistoryBack?.addEventListener("click", () => { void navigateGalleryHistory(-1); });
  els.navHistoryForward?.addEventListener("click", () => { void navigateGalleryHistory(1); });
  els.gallerySizeSlider?.addEventListener("input", (event) => applyGalleryCardSize(event.target.value, { persist: true }));
  els.gallerySizeMinus?.addEventListener("click", () => applyGalleryCardSize(galleryTargetCardWidth - GALLERY_SIZE_STEP, { persist: true }));
  els.gallerySizePlus?.addEventListener("click", () => applyGalleryCardSize(galleryTargetCardWidth + GALLERY_SIZE_STEP, { persist: true }));
  els.sidebar?.addEventListener("click", (event) => {
    if (!isMobileNavigationViewport()) return;
    if (event.target.closest(".nav-item, .settings-trigger")) setMobileNavOpen(false);
  });
  const commitSearchInput = debounce(async (intent) => {
    const nextQuery = els.searchInput.value;
    if (nextQuery === state.query) return;
    if (!await authorizeNavigationIntent(intent)) {
      if (isNavigationIntentCurrent(intent)) els.searchInput.value = state.query;
      return;
    }
    discardDetailDraft();
    state.query = nextQuery;
    state.nextCursor = null;
    recordNavigationPosition();
    // Phase 3A：结果集语义已变化，退出查看模式（快照 requestKey 随之失效，恢复自动降级）。
    if (state.viewMode === "asset") returnToLibrary();
    clearDetailSelection();
    await loadAssets();
  }, 180);
  els.searchInput?.addEventListener("input", () => {
    // Capture ordering synchronously, before the debounce delay. A later click
    // on a filter/sort/project control must outrank an older search keystroke
    // even if the search callback wakes up afterwards.
    commitSearchInput(beginNavigationIntent());
  });
  els.sortSelect?.addEventListener("change", async () => {
    const nextSort = normalizeSort(els.sortSelect.value);
    if (nextSort === state.sort) return;
    const intent = beginNavigationIntent();
    if (!await authorizeNavigationIntent(intent)) {
      els.sortSelect.value = state.sort;
      return;
    }
    discardDetailDraft();
    state.sort = nextSort;
    safeStorageSet("mosa.asset-sort", state.sort);
    // Cursors are order-specific, so a sort change always restarts from page one.
    state.nextCursor = null;
    // Phase 3A：结果集语义已变化，退出查看模式。
    if (state.viewMode === "asset") returnToLibrary();
    clearDetailSelection();
    void loadAssets();
  });
  els.detailPanel?.addEventListener("click", handleReferenceRightsOpen);
  els.assetGrid?.addEventListener("click", async (event) => {
    if (gallerySelection.handleGridClick(event)) return;
    const favoriteButton = event.target.closest(".card-favorite");
    if (favoriteButton) {
      event.stopPropagation();
      void toggleFavorite(favoriteButton.dataset.favId, event);
      return;
    }
    const selectButton = event.target.closest(".asset-card-select");
    if (selectButton) {
      // A browser emits the second click before dblclick. Let the dedicated
      // dblclick handler own that second activation so one double-click never
      // repeats Inspector selection work immediately before entering Viewer.
      if (event.detail > 1) return;
      const id = selectButton.closest(".asset-card")?.dataset.id;
      if (id && gallerySelection.handleCardClick(event, id)) return;
      if (id) {
        gallerySelection.clear();
        if (state.viewMode !== "library") return;
        void selectGalleryNode(id);
      }
      return;
    }
    const loadMoreButton = event.target.closest('[data-action="load-more"]');
    if (loadMoreButton && state.nextCursor && !isLoadingMore) {
      state.paginationStatus = "idle";
      isLoadingMore = true;
      loadMoreButton.disabled = true;
      void loadAssets({ append: true }).then((applied) => {
        if (!applied && loadMoreButton.isConnected) {
          loadMoreButton.disabled = false;
          showToast(state.galleryError?.message || t("loadFailed"), "error");
        }
      }).finally(() => { isLoadingMore = false; });
      return;
    }
    if (event.target.closest('[data-action="retry"]')) window.location.reload();
    // F-08 空态操作：V2 只有一个中性恢复态，唯一的动作是清除筛选（导入只靠
    // 拖放，由空态提示文案指引）。
    if (event.target.closest('[data-action="empty-clear"]')) { resetLibraryRefinements(); return; }
  });
  els.assetGrid?.addEventListener("dblclick", (event) => {
    const selectButton = event.target.closest(".asset-card-select");
    if (!selectButton) return;
    event.stopPropagation();
    const card = selectButton.closest(".asset-card");
    const id = card?.dataset.id;
    if (!id) return;
    const asset = state.assets.find((item) => item.id === id);
    if (!state.activeStackId && (card?.dataset.stackId || asset?.stack?.id)) {
      if (asset?.stack?.id) void assetStacks.enterStack(asset.stack.id, asset.stack);
      return;
    }
    void openAssetView(id, selectButton);
  });
  els.emptyTrashBtn?.addEventListener("click", () => { void emptyTrashWithConfirmation(); });
  els.openInspectorBtn?.addEventListener("click", openDetailSurfaceManually);
  els.quickFilters?.addEventListener("click", (event) => { const button = event.target.closest("[data-filter]"); if (button) void setFilter(button.dataset.filter); });
  els.smartGroupsToggle?.addEventListener("click", () => setSidebarSectionCollapsed("smart", !state.sidebarSmartCollapsed));
  els.assetCategoriesToggle?.addEventListener("click", () => setSidebarSectionCollapsed("manual", !state.sidebarManualCollapsed));
  els.sidebarGroupList?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]"); if (button) void setFilter(button.dataset.filter, button.dataset.value);
  });
  els.addGroupBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    startSidebarGroupCreate();
  });
  let manualGroupClickTimer = null;
  els.sidebarManualGroupList?.addEventListener("click", (event) => {
    const editorDot = event.target.closest(".sidebar-group-editor-dot[data-group-color]");
    if (editorDot && sidebarGroupEdit && !sidebarGroupEdit.saving) {
      // 单击色点在六个预设间循环，选择随建组/重命名一并提交。
      event.preventDefault();
      event.stopPropagation();
      sidebarGroupEdit.color = cycleGroupColor(sidebarGroupEdit.originalName || "", editorDot.dataset.groupColor);
      editorDot.dataset.groupColor = sidebarGroupEdit.color;
      return;
    }
    if (event.target.closest("[data-sidebar-group-editor]")) return;
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    const filter = button.dataset.filter;
    const value = button.dataset.value;
    const intent = beginNavigationIntent();
    // Keyboard activation has no dblclick ambiguity and should remain
    // immediate. Pointer single-click waits briefly so a real double-click can
    // be claimed exclusively by rename instead of also toggling the filter.
    if (event.detail === 0) {
      void setFilter(filter, value, intent);
      return;
    }
    if (manualGroupClickTimer !== null) window.clearTimeout(manualGroupClickTimer);
    manualGroupClickTimer = window.setTimeout(() => {
      manualGroupClickTimer = null;
      void setFilter(filter, value, intent);
    }, 220);
  });
  els.sidebarManualGroupList?.addEventListener("dblclick", (event) => {
    const button = event.target.closest('[data-filter="group"][data-value]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    if (manualGroupClickTimer !== null) {
      window.clearTimeout(manualGroupClickTimer);
      manualGroupClickTimer = null;
    }
    startSidebarGroupRename(button.dataset.value);
  });
  els.sidebarManualGroupList?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-sidebar-group-input]");
    if (input && sidebarGroupEdit) sidebarGroupEdit.value = input.value;
  });
  els.sidebarManualGroupList?.addEventListener("keydown", (event) => {
    if (!event.target.closest("[data-sidebar-group-input]")) return;
    if (event.key === "Enter") {
      if (isImeComposing(event)) return; // 组字中的 Enter 是上屏，不提交
      event.preventDefault();
      void commitSidebarGroupEdit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelSidebarGroupEdit();
    }
  });
  els.sidebarManualGroupList?.addEventListener("focusout", (event) => {
    if (!event.target.closest("[data-sidebar-group-input]")) return;
    queueMicrotask(() => {
      if (sidebarGroupEdit && !els.sidebarManualGroupList?.contains(document.activeElement)) void commitSidebarGroupEdit();
    });
  });
  window.addEventListener("mosa:begin-sidebar-group-rename", (event) => startSidebarGroupRename(event.detail?.groupName));
  els.typeFilters?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-type]");
    if (!button || button.dataset.type === state.mediaKind) return;
    const intent = beginNavigationIntent();
    if (!await authorizeNavigationIntent(intent)) return;
    discardDetailDraft();
    state.mediaKind = button.dataset.type;
    renderTypeFilters();
    applyFilterChange();
  });
  // V2 FilterBar 分类下拉框：与类型筛选同款约定——只动自己的 facet，能和
  // 类型筛选、来源/分组 facet、搜索叠加；不持久化（类型筛选也不记）。
  els.categorySelect?.addEventListener("change", async (event) => {
    const nextCategory = String(event.target.value || "");
    if ((state.facets.category || "") === nextCategory) return;
    const intent = beginNavigationIntent();
    if (!await authorizeNavigationIntent(intent)) {
      renderCategoryFilter();
      return;
    }
    discardDetailDraft();
    state.facets.category = nextCategory;
    recordNavigationPosition();
    applyFilterChange();
  });
  els.settingsToggle?.addEventListener("click", toggleSettingsModal);
  els.settingsMenu?.addEventListener("change", async (event) => {
    const select = event.target.closest("[data-project-select]");
    if (!select) return;
    const previousProject = state.project;
    if (select.value === previousProject) return;
    const intent = beginNavigationIntent();
    if (!await authorizeNavigationIntent(intent)) {
      select.value = previousProject;
      return;
    }
    if (assetStacks.isBusy()) {
      select.value = previousProject;
      showToast(t("operationInProgress"), "default");
      return;
    }
    const nextProject = select.value;
    try {
      const switched = await switchProjectWorkspace(nextProject, {
        shouldCommit: () => isNavigationIntentCurrent(intent),
      });
      if (!switched) {
        select.value = state.project;
        return;
      }
      discardDetailDraft();
      assetStacks.abandonStackContext();
      clearDetailSelection();
      gallerySelection.clear();
      if (els.searchInput) els.searchInput.value = "";
      // 项目切换是新的工作区：浏览位置历史随之清空（快照不跨项目恢复）。
      navHistory.clear();
      navHistory.push(captureNavigationSnapshot());
      syncNavHistoryButtons();
      // switchProjectWorkspace 已把 facets 清空，下拉框同步回「全部分类」。
      renderCategoryFilter();
      if (state.viewMode === "asset") returnToLibrary();
      startLibraryEventStream();
    } catch (error) {
      select.value = previousProject;
      showToast(error?.message || t("loadFailed"), "error");
    }
  });
  els.settingsMenu?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (event.target === els.settingsMenu || button?.dataset.settingsClose !== undefined) { closeSettingsModal(); return; }
    // 分类导航（两栏设置的 tablist）：点按钮切换当前分类。
    const settingsPageTab = event.target.closest("[data-settings-page]");
    if (settingsPageTab) { activateSettingsPage(settingsPageTab.dataset.settingsPage); return; }
    // Theme segmented buttons
    if (button?.dataset.appearanceOpt) {
      const newTheme = button.dataset.appearanceOpt;
      // 任务 81 返工 1：三态——system/light/dark；darkMode 只存「实际生效」值。
      state.themeSetting = newTheme === "light" || newTheme === "dark" ? newTheme : THEME_SYSTEM;
      state.darkMode = effectiveDarkMode(state.themeSetting);
      safeStorageSet("mosa-dark-mode", themeSettingStorageValue(state.themeSetting));
      applyDarkMode(); // 同步 .active 视觉态与 aria-checked/roving tabindex（Phase 5A / F-12）
      showToast(t("darkModeChanged"), "success");
      return;
    }

    // Card info segmented buttons
    if (button?.dataset.cardInfoOpt) {
      const newCardInfo = button.dataset.cardInfoOpt;
      state.showCardInfo = newCardInfo === "show";
      safeStorageSet("mosa.card-info", state.showCardInfo ? "show" : "hide");
      renderGrid();
      button.parentElement.querySelectorAll(".segmented-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      syncSegmentedRadios(els.settingsMenu); // aria-checked 与 .active 同步（Phase 5A / F-12）
      return;
    }

    // 任务 94：「移至回收站前确认」分段按钮（关闭 = 不再提醒，写入同一存储键）。
    if (button?.dataset.confirmTrashOpt) {
      setMoveToTrashConfirmSuppressed(button.dataset.confirmTrashOpt === "off");
      button.parentElement.querySelectorAll(".segmented-btn").forEach((b) => b.classList.remove("active"));
      button.classList.add("active");
      syncSegmentedRadios(els.settingsMenu);
      return;
    }

    const localeButton = event.target.closest("[data-locale]");
    if (localeButton) {
      return setLanguage(localeButton.dataset.locale);
    }
    const openLibraryButton = event.target.closest("[data-open-library]");
    if (openLibraryButton) runAction(async () => {
      const path = state.libraryRoot || state.libraryPath;
      if (!path) return;
      await apiFetch("/api/open-folder", { method: "POST", body: { path } });
      showToast(t("openInFinder"), "success");
    });
    const copyUserIdButton = event.target.closest("[data-copy-user-id]");
    if (copyUserIdButton && state.userProfileId) {
      runAction(async () => {
        await writeClipboardText(state.userProfileId);
        showToast(t("userIdCopied"), "success");
      });
      return;
    }
    const changeLibraryButton = event.target.closest("[data-change-library]");
    if (changeLibraryButton && window.electronAPI?.changeLibraryLocation && !state.libraryMoveInProgress) {
      void (async () => {
        state.libraryMoveInProgress = true;
        syncSettingsMenuView();
        try {
          const result = await window.electronAPI.changeLibraryLocation();
          if (!result || result.reason === "cancelled") return;
          if (!result.ok) {
            const key = result.reason === "not-empty"
              ? "libraryLocationNeedsEmpty"
              : result.reason === "managed"
                ? "libraryLocationManaged"
                : result.reason === "attached"
                  ? "libraryLocationAttached"
                  : "libraryMoveFailed";
            showToast(t(key), "error");
          }
        } catch {
          showToast(t("libraryMoveFailed"), "error");
        } finally {
          state.libraryMoveInProgress = false;
          syncSettingsMenuView();
        }
      })();
      return;
    }
    const visualToggleButton = event.target.closest("[data-visual-model-toggle]");
    if (visualToggleButton && window.electronAPI?.setVisualModelEnabled) {
      visualToggleButton.disabled = true;
      void runAction(async () => {
        try {
          const nextEnabled = state.visualModelStatus?.enabled !== true;
          state.visualModelStatus = await window.electronAPI.setVisualModelEnabled(nextEnabled);
          syncSettingsMenuView();
          showToast(t(nextEnabled ? "visualModelEnabledToast" : "visualModelDisabledToast"), "success");
        } catch (error) {
          showToast(error?.message || t("visualModelUnavailable"), "error");
          await refreshVisualModelStatus({ force: true });
        }
      });
      return;
    }
    const visualPackInstallButton = event.target.closest("[data-visual-pack-install]");
    if (visualPackInstallButton && window.electronAPI?.installVisualPack) {
      visualPackInstallButton.disabled = true;
      void runAction(async () => {
        try {
          const result = await window.electronAPI.installVisualPack();
          if (result?.state) state.visualModelStatus = result.state;
          syncSettingsMenuView();
          if (result?.ok) showToast(t("visualPackInstalledToast"), "success");
        } catch (error) {
          showToast(error?.message || t("visualPackInstallFailed"), "error");
          await refreshVisualModelStatus({ force: true });
        }
      });
      return;
    }
    const visualPackCancelButton = event.target.closest("[data-visual-pack-cancel]");
    if (visualPackCancelButton && window.electronAPI?.cancelVisualPackInstall) {
      visualPackCancelButton.disabled = true;
      void window.electronAPI.cancelVisualPackInstall();
      return;
    }
    const visualPackRemoveButton = event.target.closest("[data-visual-pack-remove]");
    if (visualPackRemoveButton && window.electronAPI?.removeVisualPack) {
      visualPackRemoveButton.disabled = true;
      void runAction(async () => {
        try {
          const result = await window.electronAPI.removeVisualPack();
          if (result?.cancelled) return;
          if (result?.ok) showToast(t("visualPackRemovedToast"), "success");
        } catch (error) {
          showToast(error?.message || t("visualPackRemoveFailed"), "error");
          await refreshVisualModelStatus({ force: true });
        }
      });
      return;
    }
    const checkUpdatesButton = event.target.closest("[data-check-updates]");
    if (checkUpdatesButton) { void checkForUpdates(); return; }
    const cancelUpdateButton = event.target.closest("[data-cancel-update]");
    if (cancelUpdateButton && window.electronAPI?.cancelUpdateDownload) {
      cancelUpdateButton.disabled = true;
      void window.electronAPI.cancelUpdateDownload();
      return;
    }
    const installUpdateButton = event.target.closest("[data-install-update]");
    if (installUpdateButton && window.electronAPI?.downloadAndInstallUpdate && state.updateStatus !== "downloading") {
      void (async () => {
        state.updateStatus = "downloading";
        state.updateDownloadPercent = 0;
        syncSettingsMenuView();
        try {
          const result = await window.electronAPI.downloadAndInstallUpdate();
          if (result?.status === "current") {
            state.updateStatus = "current";
            showToast(t("upToDate"), "success");
          } else if (result?.status === "cancelled") {
            state.updateStatus = "available";
            state.updateDownloadPercent = 0;
          } else if (result?.status !== "installing") {
            state.updateStatus = "available";
            showToast(t("updateInstallFailed"), "error");
          }
        } catch {
          state.updateStatus = "available";
          showToast(t("updateInstallFailed"), "error");
        } finally {
          syncSettingsMenuView();
        }
      })();
      return;
    }
    const downloadLatestButton = event.target.closest("[data-download-latest]");
    if (downloadLatestButton) {
      void window.electronAPI?.openDownloadPage?.().then((result) => {
        if (!result?.ok) showToast(t("updateCheckFailed"), "error");
      });
    }
  });
  els.closeGroupModal?.addEventListener("click", closeGroupModal);
  els.cancelGroupBtn?.addEventListener("click", closeGroupModal);
  els.groupModal?.addEventListener("click", (event) => { if (event.target === els.groupModal) closeGroupModal(); });
  els.stackRenameModalClose?.addEventListener("click", () => closeStackRenameModal());
  els.cancelStackRenameBtn?.addEventListener("click", () => closeStackRenameModal());
  els.stackRenameModal?.addEventListener("click", (event) => { if (event.target === els.stackRenameModal) closeStackRenameModal(); });
  els.stackRenameModalInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || isImeComposing(event)) return;
    event.preventDefault();
    void saveStackRename();
  });
  els.saveStackRenameBtn?.addEventListener("click", () => { void saveStackRename(); });
  els.groupModal?.addEventListener("click", (event) => {
    const swatch = event.target.closest("[data-group-color]");
    if (swatch) selectGroupColor(swatch.dataset.groupColor);
  });
  els.groupNameInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || isImeComposing(event)) return;
    event.preventDefault();
    void saveGroup();
  });
  els.closeGroupStatsModal?.addEventListener("click", closeGroupStatsModal);
  els.groupStatsCloseBtn?.addEventListener("click", closeGroupStatsModal);
  els.groupStatsModal?.addEventListener("click", (event) => { if (event.target === els.groupStatsModal) closeGroupStatsModal(); });
  window.addEventListener("mosa:show-group-stats", (event) => { void showGroupStats(event.detail?.groupName); });
  // Phase 5B / F-15：ConfirmDialog——Cancel/Confirm 结算唯一 pending Promise；Backdrop 点击只能取消，绝不确认。
  els.confirmDialogCancel?.addEventListener("click", () => closeConfirmDialog(false));
  els.confirmDialogConfirm?.addEventListener("click", () => closeConfirmDialog(true));
  els.confirmDialog?.addEventListener("click", (event) => { if (event.target === els.confirmDialog) closeConfirmDialog(false); });
  els.saveGroupBtn?.addEventListener("click", saveGroup);
  els.closeImagePreview?.addEventListener("click", closeImagePreview);
  els.imagePreviewModal?.addEventListener("click", (event) => { if (event.target === els.imagePreviewModal) closeImagePreview(); });
  els.imagePreviewStage?.addEventListener("click", (event) => {
    if (consumeImagePreviewSuppressedClick()) return;
    if (event.target === els.imagePreviewStage) closeImagePreview();
  });
  els.imagePreviewImage?.addEventListener("load", fitImagePreview);
  // L：灯箱此前完全没有加载失败处理——图片 404 时舞台空白且无任何提示。
  // src 被移除（关闭预览）触发的 error 不属于真失败，需排除。
  els.imagePreviewImage?.addEventListener("error", () => {
    if (!els.imagePreviewModal?.hidden && els.imagePreviewImage?.getAttribute("src")) showToast(t("imageLoadFailed"), "error");
  });
  els.assetViewBack?.addEventListener("click", () => { void closeDetailSurface(); });
  // Phase 3A：Viewer 打开后返回按钮拥有进入焦点。舞台/主图上的普通 mousedown
  // 不应把焦点无意义地清到 BODY；视频元素排除在外，保留原生 controls 交互。
  els.assetViewStage?.addEventListener("mousedown", (event) => {
    if (event.target === els.assetViewStage || event.target === els.assetViewImage) event.preventDefault();
  });
  // Phase 3C：主图 error 走带竞态守卫的命名处理器（旧 error 不得污染新素材错误态）。
  els.assetViewImage?.addEventListener("error", handleAssetViewImageError);
  // Phase 3B：缩放控制条与主图 load 接线（全应用唯一一套缩放控制）。
  els.assetZoomOut?.addEventListener("click", () => zoomAssetViewBy(1 / ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }));
  els.assetZoomIn?.addEventListener("click", () => zoomAssetViewBy(ASSET_VIEW_ZOOM_STEP, 0, 0, { announce: true }));
  els.assetZoomFit?.addEventListener("click", () => fitAssetView(true));
  els.assetViewImage?.addEventListener("load", handleAssetViewImageLoad);
  // Phase 3C：唯一一套上一张/下一张（全应用无第二套导航控件）。
  els.assetViewPrev?.addEventListener("click", () => navigateAssetView(-1));
  els.assetViewNext?.addEventListener("click", () => navigateAssetView(1));
  // GravityPort A4c（任务 90）：右上「删除 / 全屏」与全屏态同步。
  els.assetViewDelete?.addEventListener("click", () => { void deleteCurrentAssetFromViewer(); });
  els.assetViewFullscreen?.addEventListener("click", () => { void assetViewer.toggleAssetViewFullscreen(); });
  document.addEventListener("fullscreenchange", () => assetViewer.syncAssetViewFullscreenClass());
  // 任务 96（A6）：桌面窗口系统全屏变化 → 大图页全屏态跟随（菜单/绿按钮/⌃⌘F/
  // 系统 Esc 退出时查看器一并退出；浏览器无此桥，走上面的 fullscreenchange）。
  window.electronAPI?.onWindowFullScreenChange?.((active) => assetViewer.handleWindowFullScreenChange(active));
  // Settings 的 segmented radiogroup 在持久根节点上统一处理方向键。
  // 绑定在持久的 #settingsMenu 元素上：innerHTML 重建不会叠加监听器（全应用唯一一套）。
  els.settingsMenu?.addEventListener("keydown", handleSettingsMenuKeydown);
  window.addEventListener("resize", () => { syncMobileNavigation(); syncGallerySizeGroupVisibility(); if (state.imagePreviewId) fitImagePreview(); });

  bindContextMenuEvents({
    state,
    els,
    contextMenu,
    contextMenuActions,
    apiFetch,
    loadStats,
    librarySync,
    selectAsset,
    selectGalleryNode,
    openAssetView,
    gallerySelection,
    // 任务 91：大图页右键菜单的当前素材（selectedAsset 兼顾版本切换中的行）。
    getViewerAsset: selectedAsset,
  });
  // Phase 5B：ConfirmDialog 陷阱先于其余陷阱注册——Escape 优先级链最前（preventDefault +
  // stopPropagation，不穿透 Viewer/既有 Modal）；ConfirmDialog 未打开时后续陷阱照常工作。
  document.addEventListener("keydown", trapConfirmDialogFocus);
  document.addEventListener("keydown", trapSettingsModalFocus);
  document.addEventListener("keydown", trapGroupModalFocus);
  document.addEventListener("keydown", trapGroupStatsModalFocus);
  document.addEventListener("keydown", trapImagePreviewFocus);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    // Phase 3A 运行时修复：Modal/Lightbox 焦点陷阱已在先注册的监听器中消费本次 Escape
    // （preventDefault + 关浮层）——本监听器不得再把 detail 抽屉连带关闭（一次 Escape 只退一层）。
    if (event.defaultPrevented) return;
    if (!state.detailOpen) return;
    // Phase 3A：查看模式的 Escape 由 setupKeyboardShortcuts 的优先级链统一处理（先浮层后退出）。
    if (state.viewMode === "asset") return;
    if (els.groupModal?.classList.contains("open") || els.stackRenameModal?.classList.contains("open") || !els.imagePreviewModal?.hidden) return;
    if (!els.settingsMenu?.hidden) return;
    if (isInspectorDocked()) return;
    event.preventDefault();
    void closeDetailSurface();
  });
  bindDesktopIntegration();
}

function bindDesktopIntegration() {
  const api = window.electronAPI;
  if (!api) return;
  // Clipboard image import (Ctrl/Cmd+V) runs through the shared setupPasteImport
  // handler in both modes; only the context-menu entry uses the native staging
  // path below.
  api.onMenuSearch?.(() => { els.searchInput?.focus(); });
  api.onUpdateDownloadProgress?.((progress) => {
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
    state.updateDownloadPercent = percent;
    if (state.updateStatus !== "downloading") state.updateStatus = "downloading";
    syncSettingsMenuView();
  });
  api.onVisualPackProgress?.((progress) => {
    if (!state.visualModelStatus) return;
    state.visualModelStatus.distribution ||= {};
    state.visualModelStatus.distribution.progress = progress || null;
    if (progress && ["preparing", "downloading", "verifying", "installing"].includes(progress.phase)) {
      state.visualModelStatus.distribution.action = "installing";
    }
    syncSettingsMenuView();
  });
}

// Electron context-menu paste: the main process writes the clipboard image to
// a staging path (api.pasteImage), and that path is imported directly through
// /api/assets/create — no modal, no form state. state.stagingInProgress keeps
// a double-triggered paste from creating two assets from one image.
// Returns false only when the clipboard held no image (the caller tells the
// user); null means the attempt was refused or already reported its failure.
async function pasteClipboardImage() {
  // 回收站是只读范围：不允许任何导入。
  if (state.scope === "trash") return null;
  const api = window.electronAPI;
  if (!api?.pasteImage || state.stagingInProgress) return null;
  state.stagingInProgress = true;
  let imagePath = "";
  let result = null;
  try {
    imagePath = await api.pasteImage();
    if (!imagePath) return false;
    result = await apiFetch("/api/assets/create", {
      method: "POST",
      body: {
        projectId: state.project,
        imagePath,
        ...currentDropImportMetadata(),
        ...(state.activeStackId ? { stackId: state.activeStackId } : {}),
      },
    });
  } catch (error) {
    // The staged copy would otherwise linger after a failed import.
    await cleanupStagedFile(imagePath);
    showToast(t("pasteImageSaveFailed"), "error");
    return null;
  } finally {
    state.stagingInProgress = false;
  }
  // The asset already exists here; a failed refresh must not report the
  // import as failed (the library change stream reconciles it later).
  showToast(t("pastedImageImported"), "success");
  await Promise.all([loadStats(), loadAssets()]).catch(() => {});
  return result?.asset?.id || true;
}

function setLanguage(value) {
  state.languagePreference = value;
  safeStorageSet("mosa.ui-language", value);
  applyLanguage();
  requestAnimationFrame(() => {
    if (els.settingsMenu && !els.settingsMenu.hidden) els.settingsMenu.querySelector(`[data-locale="${value === "en" ? "en" : "zh"}"]`)?.focus();
  });
  refreshBridgeStatus();
  showToast(t("languageChanged"), "success");
}

function isSidebarNavigationActive(type, value = "") {
  const hasSourceSelection = Boolean(state.facets.source);
  const hasGroupSelection = Boolean(state.facets.group);
  if (type === "source") {
    return state.scope === "all" && !hasGroupSelection && state.facets.source === value;
  }
  if (type === "group") {
    return state.scope === "all" && !hasSourceSelection && state.facets.group === value;
  }
  return SCOPES.includes(type) && !hasSourceSelection && !hasGroupSelection && state.scope === type;
}

/**
 * The sidebar is navigation, not a facet-builder. Its three visual zones
 * (primary scopes, smart source groups, manual groups) share one selection.
 * Other refinements such as media type/style may still refine that selection.
 */
function setSidebarNavigationState(type, value = "") {
  const navType = type;
  const navValue = value;

  if (navType === "all") {
    state.scope = "all";
    clearFacets();
    return true;
  }

  if (SCOPES.includes(navType)) {
    state.scope = navType;
    clearFacets();
    return true;
  }

  if (navType === "source" || navType === "group") {
    const wasActive = isSidebarNavigationActive(navType, navValue);
    state.scope = "all";
    clearFacets();
    if (!wasActive) state.facets[navType] = navValue;
    return true;
  }

  return false;
}

/** One entry point for the three sidebar navigation zones. */
async function setFilter(type, value = "", intent = beginNavigationIntent()) {
  const valid = type === "all" || SCOPES.includes(type) || type === "source" || type === "group";
  if (!valid) return;
  if (!await authorizeNavigationIntent(intent)) return;
  discardDetailDraft();
  if (!setSidebarNavigationState(type, value)) return;
  recordNavigationPosition();
  applyFilterChange();
}

function clearFacets() {
  for (const key of FACET_KEYS) state.facets[key] = "";
}

function applyFilterChange() {
  // A filter change restarts paging, so any cursor from the previous query is stale.
  state.nextCursor = null;
  // Phase 3A：结果集语义已变化，退出查看模式。
  if (state.viewMode === "asset") returnToLibrary();
  clearDetailSelection();
  renderQuickFilters(); renderTypeFilters(); renderCategoryFilter(); loadAssets();
}

async function showRelatedGenerations(asset, mode) {
  const conversationId = String(asset?.source?.conversation_id || "").trim();
  const messageId = String(asset?.source?.message_id || "").trim();
  if (!conversationId || (mode === "batch" && !messageId)) return;
  const intent = beginNavigationIntent();
  if (!await authorizeNavigationIntent(intent)) return;
  discardDetailDraft();
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  state.facets.conversation = conversationId;
  if (mode === "batch") state.facets.generationBatch = messageId;
  recordNavigationPosition();
  applyFilterChange();
}

function closePanel(panel, trigger, reason = "escape") {
  if (panel === els.settingsMenu) { closeSettingsModal({ restoreFocus: reason !== "outside-pointer" }); return; }
  if (!panel) return;
  panel.hidden = true;
  trigger?.setAttribute("aria-expanded", "false");
}

// Settings keeps native button semantics; segmented radiogroups additionally
// support desktop arrow-key navigation without introducing a second UI state.
// 分类导航（role="tab"）照同一套 roving 写法：↑/↓ 在分类间移动并自动激活，
// Home/End 到首/末；激活走 click 业务路径（activateSettingsPage），不另设状态。
function handleSettingsMenuKeydown(event) {
  const tab = event.target.closest?.('[role="tab"]');
  if (tab) {
    const tabs = [...(tab.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') || [])];
    const index = tabs.indexOf(tab);
    let next = -1;
    // 窄窗口下导航是横向一行，← / → 与 ↓ / ↑ 等价。
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = Math.min(index + 1, tabs.length - 1);
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = Math.max(index - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === -1 || next === index || !tabs[next]) return;
    event.preventDefault();
    event.stopPropagation();
    tabs[next].click();
    tabs[next].focus();
    return;
  }
  const radio = event.target.closest?.('[role="radio"]');
  if (radio) {
    const group = radio.closest('[role="radiogroup"]');
    const buttons = group ? [...group.querySelectorAll('[role="radio"]')] : [];
    const index = buttons.indexOf(radio);
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowDown") next = (index + 1) % buttons.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "ArrowUp") next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    if (next === -1 || !buttons[next]) return;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].click(); // 复用既有主题/密度 click 业务路径，逻辑零分叉
    buttons[next].focus();
    return;
  }
}

function renderQuickFilters() {
  if (!els.quickFilters) return;
  const counts = { all: state.groups.total, favorite: state.groups.favorites, unorganized: state.groups.unorganized, trash: state.groups.trash };
  els.quickFilters.querySelectorAll("[data-filter]").forEach((button) => { const active = isSidebarNavigationActive(button.dataset.filter); button.classList.toggle("active", active); button.setAttribute("aria-pressed", String(active)); button.querySelector(".nav-count").textContent = counts[button.dataset.filter] ?? "—"; });
  renderSidebarGroups();
}

/** V2 FilterBar type filter: sync the 全部/图片/视频 pressed state. */
function renderTypeFilters() {
  els.typeFilters?.querySelectorAll("[data-type]").forEach((button) => {
    const active = button.dataset.type === state.mediaKind;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

/** V2 FilterBar 分类下拉框：把 state.facets.category 同步回控件（facet 被侧栏
 * 导航 / 清除筛选 / 项目切换重置后，下拉框要跟着回到「全部分类」）。 */
function renderCategoryFilter() {
  if (els.categorySelect) els.categorySelect.value = state.facets.category || "";
}

/** The sidebar groups automatic assets by their actual capture / bridge source. */
function renderSidebarGroups() {
  if (!els.sidebarGroupList) return;
  const counts = new Map(Array.isArray(state.groups.sourceTypes) ? state.groups.sourceTypes : []);
  const shown = SIDEBAR_SOURCE_TYPES
    .map((sourceType) => [sourceType, Number(counts.get(sourceType) || 0)])
    .filter(([, count]) => count > 0);
  const items = shown.map(([sourceType, count]) => {
    const active = isSidebarNavigationActive("source", sourceType);
    const label = sourceTypeLabel(sourceType);
    const color = deterministicGroupColor(sourceType);
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="source" data-value="${escapeHtml(sourceType)}" type="button" aria-pressed="${active}" title="${escapeHtml(label)}"><span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><span class="nav-item-text" title="${escapeHtml(label)}">${escapeHtml(label)}</span><span class="nav-count">${count}</span></button></li>`;
  }).join("");
  els.sidebarGroupList.innerHTML = items;

  if (!els.sidebarManualGroupList) return;
  const manualItems = (Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => {
    const groupName = group.name;
    const count = group.count;
    if (sidebarGroupEdit?.mode === "rename" && sidebarGroupEdit.originalName === groupName) {
      return sidebarGroupEditorMarkup(groupName, sidebarGroupEdit.value, colorForGroup(groupName));
    }
    const active = isSidebarNavigationActive("group", groupName);
    const color = colorForGroup(groupName);
    return `<li><button class="nav-item nav-group-item${active ? " active" : ""}" data-filter="group" data-value="${escapeHtml(groupName)}" type="button" aria-pressed="${active}" title="${escapeHtml(groupName)}"><span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span><span class="nav-item-text" title="${escapeHtml(groupName)}">${escapeHtml(groupName)}</span><span class="nav-count">${Number(count || 0)}</span></button></li>`;
  }).join("");
  const createEditor = sidebarGroupEdit?.mode === "create"
    ? sidebarGroupEditorMarkup("", sidebarGroupEdit.value, sidebarGroupEdit.color)
    : "";
  els.sidebarManualGroupList.innerHTML = `${manualItems}${createEditor}`;
  syncSidebarSectionVisibility();
  if (sidebarGroupEdit) requestAnimationFrame(focusSidebarGroupEditor);
}

function syncSidebarSectionVisibility() {
  const sync = (toggle, list, collapsed) => {
    if (list) list.hidden = collapsed;
    if (toggle) toggle.setAttribute("aria-expanded", String(!collapsed));
  };
  sync(els.smartGroupsToggle, els.sidebarGroupList, state.sidebarSmartCollapsed);
  sync(els.assetCategoriesToggle, els.sidebarManualGroupList, state.sidebarManualCollapsed);
}

function setSidebarSectionCollapsed(section, collapsed) {
  if (section === "smart") {
    state.sidebarSmartCollapsed = Boolean(collapsed);
    safeStorageSet("mosa.sidebar-smart-collapsed", String(state.sidebarSmartCollapsed));
  } else if (section === "manual") {
    state.sidebarManualCollapsed = Boolean(collapsed);
    safeStorageSet("mosa.sidebar-manual-collapsed", String(state.sidebarManualCollapsed));
  } else {
    return;
  }
  syncSidebarSectionVisibility();
}

function sidebarGroupEditorMarkup(originalName, value = "", color = GROUP_COLORS[0]) {
  return `<li class="sidebar-group-editor" data-sidebar-group-editor data-original-name="${escapeHtml(originalName)}"><button class="sidebar-group-editor-dot" type="button" data-group-color="${escapeHtml(color)}" data-i18n-aria-label="groupColor" aria-label="${escapeHtml(t("groupColor"))}" title="${escapeHtml(t("groupColor"))}"></button><input class="sidebar-group-editor-input" data-sidebar-group-input type="text" maxlength="80" value="${escapeHtml(value)}" placeholder="${escapeHtml(t("inlineGroupPlaceholder"))}" aria-label="${escapeHtml(t(originalName ? "renameGroup" : "addGroup"))}" /></li>`;
}

function focusSidebarGroupEditor() {
  const input = els.sidebarManualGroupList?.querySelector("[data-sidebar-group-input]");
  if (!(input instanceof HTMLInputElement)) return;
  if (document.activeElement !== input) {
    input.focus();
    input.select();
  }
}

function startSidebarGroupCreate() {
  setSidebarSectionCollapsed("manual", false);
  if (sidebarGroupEdit) return focusSidebarGroupEditor();
  sidebarGroupEdit = { mode: "create", value: "", color: GROUP_COLORS[0], saving: false };
  renderSidebarGroups();
}

function startSidebarGroupRename(groupName) {
  const name = String(groupName || "").trim();
  if (!name) return;
  setSidebarSectionCollapsed("manual", false);
  sidebarGroupEdit = { mode: "rename", originalName: name, value: name, color: colorForGroup(name), saving: false };
  renderSidebarGroups();
}

function cancelSidebarGroupEdit() {
  if (!sidebarGroupEdit || sidebarGroupEdit.saving) return;
  sidebarGroupEdit = null;
  renderSidebarGroups();
}

async function commitSidebarGroupEdit() {
  const draft = sidebarGroupEdit;
  if (!draft || draft.saving) return;
  const input = els.sidebarManualGroupList?.querySelector("[data-sidebar-group-input]");
  const name = String(input?.value ?? draft.value ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (!name) {
    cancelSidebarGroupEdit();
    return;
  }
  if (draft.mode === "rename" && name === draft.originalName) {
    cancelSidebarGroupEdit();
    return;
  }
  draft.value = name;
  draft.saving = true;
  if (input instanceof HTMLInputElement) input.disabled = true;
  try {
    if (draft.mode === "create") {
      const result = await apiFetch("/api/groups", {
        method: "POST",
        body: { projectId: state.project, name, color: draft.color },
      });
      saveGroupColor(result.group.name, draft.color);
      showToast(`${t("groupCreated")}${result.group.name}`, "success");
    } else {
      const originalName = draft.originalName;
      const result = await apiFetch(`/api/groups/${encodeURIComponent(originalName)}`, {
        method: "PATCH",
        body: { projectId: state.project, name },
      });
      const colors = groupColorMap();
      const previousColor = colors[originalName] || draft.color;
      delete colors[originalName];
      colors[result.group.name] = GROUP_COLORS.includes(previousColor) ? previousColor : deterministicGroupColor(result.group.name);
      safeStorageSet(groupColorStorageKey(), JSON.stringify(colors));
      // 编辑器里循环过的色点随重命名一起生效。
      if (GROUP_COLORS.includes(draft.color) && draft.color !== colors[result.group.name]) {
        persistGroupColor(result.group.name, draft.color);
      }
      if (state.facets.group === originalName) state.facets.group = result.group.name;
      showToast(`${t("groupRenamed")}${result.group.name}`, "success");
    }
    sidebarGroupEdit = null;
    await loadStats();
    if (draft.mode === "rename" && state.facets.group) await loadAssets();
  } catch (error) {
    draft.saving = false;
    if (input instanceof HTMLInputElement) input.disabled = false;
    showToast(error?.message || t("groupNameRequired"), "error");
    focusSidebarGroupEditor();
  }
}

let masonryResizeObserver = null;
let masonryObservedGrid = null;
let masonryObservedWidth = 0;
let masonryLayoutFrame = null;
let masonryFullLayoutPending = false;
const masonryPendingCards = new Set();
let galleryMediaObserver = null;
let galleryMediaObservedGrid = null;
let galleryCardVirtualObserver = null;
let galleryCardVirtualObservedGrid = null;
let galleryCardVirtualScrollGrid = null;
let galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
const galleryCardVirtualVisiblePendingChanges = new Map();
const galleryCardVirtualBackgroundPendingChanges = new Map();
let galleryCardVirtualBatchFrame = null;
let galleryCardVirtualWindowFrame = null;
const galleryCardVirtualEntries = new Map();
const galleryCardVirtualNodes = new Map();
const galleryCardVirtualHydratedIds = new Set();
const galleryCardVirtualSpanCache = new Map();
let galleryCardVirtualColumnWidth = 180;
let galleryCardVirtualGeometryColumns = [];
const galleryCardVirtualGeometryById = new Map();
let galleryCardVirtualGeometryRevision = 0;
const GALLERY_CARD_VIRTUAL_THRESHOLD = 40;
const GALLERY_CARD_INITIAL_HYDRATE = 40;
const GALLERY_CARD_DOM_WINDOW_THRESHOLD = 240;
const GALLERY_CARD_DOM_PRELOAD = 1800;

function galleryVirtualSpanKey(assetId, columnWidth = galleryCardVirtualColumnWidth) {
  return `${state.showCardInfo ? "show" : "hide"}\u001f${Math.round(columnWidth)}\u001f${assetId}`;
}

function pruneGalleryVirtualSpanCache(activeIds) {
  const currentPrefix = `${state.showCardInfo ? "show" : "hide"}\u001f${Math.round(galleryCardVirtualColumnWidth)}\u001f`;
  for (const key of galleryCardVirtualSpanCache.keys()) {
    const assetId = key.slice(key.lastIndexOf("\u001f") + 1);
    if (!key.startsWith(currentPrefix) || !activeIds.has(assetId)) galleryCardVirtualSpanCache.delete(key);
  }
}

function galleryCardColumnWidth(styles = null) {
  const grid = els.assetGrid;
  if (!grid) return 180;
  const tracks = (styles || getComputedStyle(grid)).gridTemplateColumns.split(/\s+/).map(Number.parseFloat).filter((value) => Number.isFinite(value) && value > 0);
  if (tracks.length) return tracks[0];
  return Math.max(120, grid.clientWidth / 5);
}

function galleryAssetAspect(asset = {}) {
  const width = Number(asset.width || asset.business_fields?.width);
  const height = Number(asset.height || asset.business_fields?.height);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) return height / width;
  const match = /^\s*(\d+(?:\.\d+)?)\s*[:/x×]\s*(\d+(?:\.\d+)?)\s*$/iu.exec(String(asset.ratio || ""));
  if (match) {
    const ratioWidth = Number(match[1]);
    const ratioHeight = Number(match[2]);
    if (ratioWidth > 0 && ratioHeight > 0) return ratioHeight / ratioWidth;
  }
  return 1;
}

function estimatedGalleryCardSpan(asset) {
  const cached = galleryCardVirtualSpanCache.get(galleryVirtualSpanKey(asset.id));
  if (cached) return cached;
  // Placeholder geometry must follow the same intrinsic aspect ratio as the
  // real media element. Capping tall assets here makes the placeholder shorter
  // than the hydrated card, so the real card can overflow into the next
  // masonry slot. Estimates are allowed to be approximate, but never
  // deliberately shorter than the media ratio we already know.
  const mediaHeight = galleryCardColumnWidth() * Math.max(0.35, galleryAssetAspect(asset));
  // R21 实测：信息区（12 顶距 + 12px/620 标题 + 4 + 10px 元信息 + 12 底部留白）= 61px。
  const infoHeight = state.showCardInfo ? 61 : 0;
  const grid = els.assetGrid;
  const styles = grid ? getComputedStyle(grid) : null;
  const gap = styles ? (Number.parseFloat(styles.getPropertyValue("--gallery-gap")) || Number.parseFloat(styles.columnGap) || 0) : 0;
  return Math.max(48, Math.ceil(mediaHeight + infoHeight + gap));
}

function virtualGalleryCardEntry(entry) {
  const span = estimatedGalleryCardSpan(entry.asset);
  return {
    ...entry,
    renderKey: `${entry.renderKey}\u001fvirtual`,
    animateCard: false,
    markup: `<article class="asset-card asset-card-virtual-placeholder" data-id="${escapeHtml(entry.id)}" data-virtual-span="${span}" aria-hidden="true"><span class="asset-card-virtual-surface"></span></article>`,
  };
}

function shouldHydrateGalleryCard(entry, ordinal) {
  if (state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) return true;
  if (ordinal < GALLERY_CARD_INITIAL_HYDRATE) return true;
  if (entry.id === state.selectedId || galleryCardVirtualHydratedIds.has(entry.id)) return true;
  return false;
}

function replaceVirtualGalleryCards(observerEntries) {
  const replacements = [];
  for (const item of observerEntries) {
    const card = item.target;
    if (!(card instanceof HTMLElement) || !card.isConnected) continue;
    const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
    if (!entry) continue;
    const hydrate = item.isIntersecting;
    if (hydrate && !card.classList.contains("asset-card-virtual-placeholder")) continue;
    if (!hydrate && card.classList.contains("asset-card-virtual-placeholder")) continue;
    if (!hydrate && (card.contains(document.activeElement) || card.classList.contains("selected") || card.matches(".stack-drop-target, .stack-reorder-target"))) continue;

    if (!hydrate) {
      const span = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
      if (Number.isFinite(span) && span > 0) galleryCardVirtualSpanCache.set(galleryVirtualSpanKey(entry.id), span);
    }
    replacements.push({ card, entry, hydrate });
  }
  if (!replacements.length) return;

  const replacementEntries = replacements.map(({ entry, hydrate }) => hydrate ? entry : virtualGalleryCardEntry(entry));
  const createdCards = createAssetCardElements(replacementEntries);
  const hydratedCards = [];
  const changedIds = new Set();
  let changed = false;

  replacements.forEach(({ card, entry, hydrate }) => {
    const replacement = createdCards.get(entry.id);
    if (!replacement) return;
    galleryCardVirtualObserver?.unobserve(card);
    if (card.style.gridColumnStart) replacement.style.gridColumnStart = card.style.gridColumnStart;
    if (card.style.gridRowStart) replacement.style.gridRowStart = card.style.gridRowStart;
    if (hydrate && card.style.gridRowEnd) replacement.style.gridRowEnd = card.style.gridRowEnd;
    if (hydrate) {
      galleryCardVirtualHydratedIds.add(entry.id);
      hydratedCards.push(replacement);
    } else {
      galleryCardVirtualHydratedIds.delete(entry.id);
      releaseObservedGalleryMedia(card);
    }
    card.replaceWith(replacement);
    galleryCardVirtualNodes.set(entry.id, replacement);
    galleryCardVirtualObserver?.observe(replacement);
    changedIds.add(entry.id);
    changed = true;
  });

  // Placeholder geometry is only a scroll-stability estimate. Once a real card
  // is mounted, validate that estimate on the next animation frame. The
  // masonry scheduler batches all hydrated cards and reflows placement only if
  // a measured span actually changed, so correctness no longer depends on
  // metadata being perfect without reintroducing synchronous scroll jank.
  if (hydratedCards.length) {
    setupGalleryMediaVirtualization(hydratedCards);
    hydratedCards.forEach((card) => scheduleMasonryLayout(card));
  }
  if (changed) {
    invalidateCardGeometryCache();
    gallerySelection.syncRenderedSelection({ prune: false, changedIds });
  }
}

function flushGalleryCardVirtualPendingChanges() {
  galleryCardVirtualBatchFrame = null;
  const grid = els.assetGrid;
  if (!grid || (!galleryCardVirtualVisiblePendingChanges.size && !galleryCardVirtualBackgroundPendingChanges.size)) return;
  const batch = [];
  const takeChanges = (pending, limit) => {
    let taken = 0;
    for (const [id, change] of pending) {
      if (taken >= limit) break;
      pending.delete(id);
      if (!change.target?.isConnected) continue;
      batch.push(change);
      taken += 1;
    }
  };
  // Normal scrolling hydrates from the 1200px warm zone before a card becomes
  // visible. If a fast fling outruns that runway, the visible set is still
  // bounded by the viewport, so resolve the complete visible queue in this
  // pre-paint frame. Spreading it across several frames exposes placeholders
  // and makes cards visibly swap/jump while the user is scrolling.
  if (galleryCardVirtualVisiblePendingChanges.size) {
    takeChanges(galleryCardVirtualVisiblePendingChanges, galleryCardVirtualVisiblePendingChanges.size);
  }
  // Eviction must make progress in the same frame as visible hydration. If
  // the background queue waited for the visible queue to empty, a fast scroll
  // would retain every card it ever visited and defeat DOM virtualization.
  takeChanges(galleryCardVirtualBackgroundPendingChanges, 6);
  if (batch.length) replaceVirtualGalleryCards(batch);
  if (galleryCardVirtualVisiblePendingChanges.size || galleryCardVirtualBackgroundPendingChanges.size) {
    galleryCardVirtualBatchFrame = requestAnimationFrame(flushGalleryCardVirtualPendingChanges);
  }
}

function scheduleGalleryCardVirtualPendingChanges() {
  if (galleryCardVirtualBatchFrame !== null || (!galleryCardVirtualVisiblePendingChanges.size && !galleryCardVirtualBackgroundPendingChanges.size)) return;
  galleryCardVirtualBatchFrame = requestAnimationFrame(flushGalleryCardVirtualPendingChanges);
}

function queueGalleryCardVirtualChange(change, visible = false) {
  const card = change?.target;
  const id = card?.dataset?.id || "";
  if (!id) return;
  if (visible) {
    galleryCardVirtualBackgroundPendingChanges.delete(id);
    galleryCardVirtualVisiblePendingChanges.set(id, change);
    return;
  }
  // IntersectionObserver notifications can be delivered after a synchronous
  // indexed scroll check. Never let an older warm-zone notification demote a
  // card that the current viewport has already promoted to visible priority.
  if (galleryCardVirtualVisiblePendingChanges.has(id)) return;
  galleryCardVirtualBackgroundPendingChanges.set(id, change);
}

function galleryCardVirtualLowerBound(column, minRow) {
  let low = 0;
  let high = column.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (column[middle].rowEnd < minRow) low = middle + 1;
    else high = middle;
  }
  return low;
}

function galleryCardVirtualNode(grid, id) {
  const cached = galleryCardVirtualNodes.get(id);
  if (cached?.isConnected && cached.parentElement === grid && cached.dataset.id === id) return cached;
  if (cached) galleryCardVirtualNodes.delete(id);
  const card = grid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
  if (card) galleryCardVirtualNodes.set(id, card);
  return card;
}

function mountGalleryVirtualCard(grid, id, hydrate = false) {
  const entry = galleryCardVirtualEntries.get(id);
  const geometry = galleryCardVirtualGeometryById.get(id);
  if (!entry || !geometry) return null;
  const created = createAssetCardElements([hydrate ? entry : virtualGalleryCardEntry(entry)]).get(id) || null;
  if (!created) return null;
  created.style.gridColumnStart = String(geometry.columnIndex + 1);
  created.style.gridRowStart = String(geometry.rowStart);
  created.style.gridRowEnd = `span ${Math.max(1, geometry.rowEnd - geometry.rowStart)}`;
  const pagination = grid.querySelector(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel, :scope > .gallery-virtual-extent");
  grid.insertBefore(created, pagination || null);
  galleryCardVirtualNodes.set(id, created);
  if (hydrate) {
    galleryCardVirtualHydratedIds.add(id);
    setupGalleryMediaVirtualization([created]);
    scheduleMasonryLayout(created);
  } else {
    galleryCardVirtualHydratedIds.delete(id);
  }
  galleryCardVirtualObserver?.observe(created);
  return created;
}

function galleryVirtualExtentRow() {
  let rowEnd = 1;
  for (const column of galleryCardVirtualGeometryColumns) {
    const last = column.at(-1);
    if (last?.rowEnd > rowEnd) rowEnd = last.rowEnd;
  }
  return rowEnd;
}

function syncGalleryVirtualExtent() {
  const grid = els.assetGrid;
  if (!grid) return;
  let extent = grid.querySelector(":scope > .gallery-virtual-extent");
  if (state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD) {
    extent?.remove();
    return;
  }
  if (!extent) {
    extent = document.createElement("div");
    extent.className = "gallery-virtual-extent";
    extent.setAttribute("aria-hidden", "true");
    grid.append(extent);
  }
  const row = galleryVirtualExtentRow();
  extent.style.gridRowStart = String(row);
  extent.style.gridColumn = "1 / -1";
  grid.querySelectorAll(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel").forEach((element) => {
    element.style.gridRowStart = String(row + 1);
    element.style.gridColumn = "1 / -1";
  });
}

function pruneGalleryCardDomWindow() {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD) {
    syncGalleryVirtualExtent();
    return;
  }
  const minRow = Math.max(0, grid.scrollTop - GALLERY_CARD_DOM_PRELOAD);
  const maxRow = grid.scrollTop + grid.clientHeight + GALLERY_CARD_DOM_PRELOAD;
  grid.querySelectorAll(":scope > .asset-card").forEach((card) => {
    const id = card.dataset.id || "";
    const geometry = galleryCardVirtualGeometryById.get(id);
    if (!geometry || (geometry.rowEnd >= minRow && geometry.rowStart <= maxRow)) return;
    if (id === state.selectedId || card.contains(document.activeElement) || card.matches(".selected, .stack-drop-target, .stack-reorder-target")) return;
    releaseObservedGalleryMedia(card);
    galleryCardVirtualObserver?.unobserve(card);
    galleryCardVirtualHydratedIds.delete(id);
    galleryCardVirtualNodes.delete(id);
    card.remove();
  });
  syncGalleryVirtualExtent();
}

function syncGalleryCardVirtualWindow() {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) return;
  const preload = 1200;
  const minRow = Math.max(0, grid.scrollTop - preload);
  const maxRow = grid.scrollTop + grid.clientHeight + preload;
  const visibleMinRow = grid.scrollTop;
  const visibleMaxRow = grid.scrollTop + grid.clientHeight;
  const desiredVisible = new Map();
  const desiredBackground = new Map();
  // Masonry placement produces ordered, non-overlapping ranges per column.
  // Binary-search those ranges so scroll work is proportional to the viewport
  // instead of to every loaded asset in the library.
  for (const column of galleryCardVirtualGeometryColumns) {
    for (let index = galleryCardVirtualLowerBound(column, minRow); index < column.length; index += 1) {
      const geometry = column[index];
      if (geometry.rowStart > maxRow) break;
      const visible = geometry.rowEnd >= visibleMinRow && geometry.rowStart <= visibleMaxRow;
      const card = galleryCardVirtualNode(grid, geometry.id) || mountGalleryVirtualCard(grid, geometry.id, visible);
      if (visible && card && !card.classList.contains("asset-card-virtual-placeholder")) continue;
      if (!card?.classList.contains("asset-card-virtual-placeholder")) continue;
      const change = { target: card, isIntersecting: true };
      if (visible) desiredVisible.set(geometry.id, change);
      else desiredBackground.set(geometry.id, change);
    }
  }
  for (const id of galleryCardVirtualHydratedIds) {
    const geometry = galleryCardVirtualGeometryById.get(id);
    if (!geometry || (geometry.rowEnd >= minRow && geometry.rowStart <= maxRow)) continue;
    const card = galleryCardVirtualNode(grid, id);
    if (card && !card.classList.contains("asset-card-virtual-placeholder")) {
      desiredBackground.set(id, { target: card, isIntersecting: false });
    }
  }
  for (const id of galleryCardVirtualVisiblePendingChanges.keys()) {
    if (!desiredVisible.has(id)) galleryCardVirtualVisiblePendingChanges.delete(id);
  }
  for (const id of galleryCardVirtualBackgroundPendingChanges.keys()) {
    if (!desiredBackground.has(id)) galleryCardVirtualBackgroundPendingChanges.delete(id);
  }
  desiredVisible.forEach((change, id) => {
    galleryCardVirtualBackgroundPendingChanges.delete(id);
    galleryCardVirtualVisiblePendingChanges.set(id, change);
  });
  desiredBackground.forEach((change, id) => {
    if (!galleryCardVirtualVisiblePendingChanges.has(id)) galleryCardVirtualBackgroundPendingChanges.set(id, change);
  });
  // The scroll callback only updates intent. DOM replacement is frame-budgeted
  // by the scheduler below, keeping the scroll path read-mostly and compositor
  // friendly even during very large jumps.
  scheduleGalleryCardVirtualPendingChanges();
  pruneGalleryCardDomWindow();
}

function scheduleGalleryCardVirtualWindowSync() {
  if (galleryCardVirtualWindowFrame !== null) return;
  galleryCardVirtualWindowFrame = requestAnimationFrame(() => {
    galleryCardVirtualWindowFrame = null;
    syncGalleryCardVirtualWindow();
  });
}

function handleGalleryCardVirtualScroll() {
  const grid = els.assetGrid;
  if (!grid) return;
  if (Math.abs(grid.scrollTop - galleryCardVirtualLastScrollTop) < 64) return;
  galleryCardVirtualLastScrollTop = grid.scrollTop;
  // The indexed lookup is already viewport-bounded, so perform it in the
  // scroll callback instead of risking a stale rAF coalescing a large jump.
  // DOM replacement remains deferred and batched by the hydration scheduler.
  syncGalleryCardVirtualWindow();
}

function setupGalleryCardVirtualization(roots = null) {
  const grid = els.assetGrid;
  if (!grid || state.assets.length < GALLERY_CARD_VIRTUAL_THRESHOLD) {
    galleryCardVirtualObserver?.disconnect();
    galleryCardVirtualObservedGrid = null;
    if (galleryCardVirtualScrollGrid) galleryCardVirtualScrollGrid.removeEventListener("scroll", handleGalleryCardVirtualScroll);
    galleryCardVirtualScrollGrid = null;
    galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
    galleryCardVirtualVisiblePendingChanges.clear();
    galleryCardVirtualBackgroundPendingChanges.clear();
    if (galleryCardVirtualBatchFrame !== null) cancelAnimationFrame(galleryCardVirtualBatchFrame);
    galleryCardVirtualBatchFrame = null;
    if (galleryCardVirtualWindowFrame !== null) cancelAnimationFrame(galleryCardVirtualWindowFrame);
    galleryCardVirtualWindowFrame = null;
    galleryCardVirtualGeometryColumns = [];
    galleryCardVirtualGeometryById.clear();
    galleryCardVirtualGeometryRevision += 1;
    return;
  }
  if ("IntersectionObserver" in window) {
    if (galleryCardVirtualObservedGrid !== grid || !galleryCardVirtualObserver) {
      galleryCardVirtualObserver?.disconnect();
      galleryCardVirtualObservedGrid = grid;
      galleryCardVirtualObserver = new IntersectionObserver((entries) => {
        const bounds = grid.getBoundingClientRect();
        entries.forEach((entry) => {
          const card = entry.target;
          if (!(card instanceof HTMLElement) || !card.isConnected) return;
          const isPlaceholder = card.classList.contains("asset-card-virtual-placeholder");
          if (entry.isIntersecting && isPlaceholder) {
            const rect = entry.boundingClientRect;
            const visible = rect.bottom > bounds.top && rect.top < bounds.bottom;
            queueGalleryCardVirtualChange({ target: card, isIntersecting: true }, visible);
          } else if (!entry.isIntersecting && !isPlaceholder) {
            queueGalleryCardVirtualChange({ target: card, isIntersecting: false });
          }
        });
        scheduleGalleryCardVirtualPendingChanges();
      }, { root: grid, rootMargin: "1200px 0px" });
    }
    const observationRoots = Array.isArray(roots) && roots.length ? roots : [grid];
    observationRoots.forEach((root) => {
      if (!(root instanceof Element)) return;
      const cards = root.matches?.(".asset-card") ? [root] : [...root.querySelectorAll(":scope > .asset-card")];
      cards.forEach((card) => galleryCardVirtualObserver.observe(card));
    });
    // IntersectionObserver is the primary driver, while the indexed scroll
    // lookup is a deterministic correctness guard for large programmatic jumps
    // and compositor timing. It is viewport-bounded, so this does not restore
    // the old O(N) scroll scan.
    if (galleryCardVirtualScrollGrid !== grid) {
      galleryCardVirtualScrollGrid?.removeEventListener("scroll", handleGalleryCardVirtualScroll);
      galleryCardVirtualScrollGrid = grid;
      galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
      galleryCardVirtualScrollGrid.addEventListener("scroll", handleGalleryCardVirtualScroll, { passive: true });
    }
    return;
  }
  galleryCardVirtualObserver?.disconnect();
  galleryCardVirtualObserver = null;
  galleryCardVirtualObservedGrid = grid;
  if (galleryCardVirtualScrollGrid !== grid) {
    galleryCardVirtualScrollGrid?.removeEventListener("scroll", handleGalleryCardVirtualScroll);
    galleryCardVirtualScrollGrid = grid;
    galleryCardVirtualLastScrollTop = Number.NEGATIVE_INFINITY;
    galleryCardVirtualScrollGrid.addEventListener("scroll", handleGalleryCardVirtualScroll, { passive: true });
  }
  handleGalleryCardVirtualScroll();
}

function bindGalleryVideoFrame(video) {
  if (!(video instanceof HTMLVideoElement) || video.dataset.galleryVideoBound === "true") return;
  video.dataset.galleryVideoBound = "true";
  const frame = video.closest(".video-thumb");
  const persistedWidth = Number(frame?.dataset.videoWidth || video.getAttribute("width") || 0);
  const persistedHeight = Number(frame?.dataset.videoHeight || video.getAttribute("height") || 0);
  if (frame instanceof HTMLElement && persistedWidth > 0 && persistedHeight > 0) {
    frame.style.aspectRatio = `${persistedWidth} / ${persistedHeight}`;
  }
  const updateAspect = () => {
    const width = Number(video.videoWidth || 0);
    const height = Number(video.videoHeight || 0);
    if (width <= 0 || height <= 0) return;
    video.setAttribute("width", String(width));
    video.setAttribute("height", String(height));
    video.dataset.knownAspect = "true";
    if (frame instanceof HTMLElement) {
      frame.style.aspectRatio = `${width} / ${height}`;
      frame.dataset.knownAspect = "true";
    }
    const card = video.closest(".asset-card");
    if (card) scheduleMasonryLayout(card);
    // Asking for a frame just after t=0 makes Chromium decode an actual poster
    // while still keeping the element paused and metadata-oriented.
    if (!video.dataset.galleryFrameSeeked) {
      video.dataset.galleryFrameSeeked = "true";
      const duration = Number(video.duration);
      const firstFrameTime = Number.isFinite(duration) && duration > 0
        ? Math.min(0.05, Math.max(0.001, duration / 100))
        : 0.001;
      try { video.currentTime = firstFrameTime; } catch {}
    }
  };
  const revealFrame = () => video.classList.add("is-frame-ready");
  video.addEventListener("loadedmetadata", updateAspect);
  video.addEventListener("loadeddata", revealFrame);
  video.addEventListener("seeked", revealFrame);
  video.addEventListener("error", () => video.classList.remove("is-frame-ready"));
}

// IntersectionObserver keeps strong references to every observed target, so
// media elements inside cards that are replaced or removed must be released;
// otherwise each grid rebuild leaks the previous render's nodes.
function releaseObservedGalleryMedia(card) {
  if (!galleryMediaObserver) return;
  card.querySelectorAll("img, video").forEach((media) => galleryMediaObserver.unobserve(media));
}

// Both observers hold strong references, so every path that wholesale-discard
// gallery DOM (status early-exits, full rebuilds, card replacement) must
// release the card observer and the media observer together before dropping
// the nodes. `root` may be the grid or a single card.
function releaseGalleryObservers(root) {
  if (!root) return;
  const cards = root.matches?.(".asset-card") ? [root] : [...root.querySelectorAll(".asset-card")];
  for (const card of cards) {
    galleryCardVirtualObserver?.unobserve(card);
    releaseObservedGalleryMedia(card);
  }
}

function setupGalleryMediaVirtualization(roots = null) {
  const grid = els.assetGrid;
  if (!grid || !("IntersectionObserver" in window)) return;
  if (galleryMediaObservedGrid !== grid) {
    galleryMediaObserver?.disconnect();
    galleryMediaObservedGrid = grid;
    galleryMediaObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const media = entry.target;
        if (media instanceof HTMLVideoElement) {
          const source = media.dataset.galleryVideoSrc || "";
          if (!source) return;
          if (entry.isIntersecting) {
            if (!media.hasAttribute("src")) {
              media.dataset.galleryUnloaded = "false";
              media.dataset.galleryFrameSeeked = "";
              media.preload = "metadata";
              media.src = source;
              media.load();
            }
            return;
          }
          if (!media.hasAttribute("src")) return;
          media.dataset.galleryUnloaded = "true";
          media.pause();
          media.removeAttribute("src");
          media.load();
          media.classList.remove("is-frame-ready");
          return;
        }
        if (!(media instanceof HTMLImageElement) || media.dataset.knownAspect !== "true") return;
        const source = media.dataset.gallerySrc || "";
        if (entry.isIntersecting) {
          if (media.dataset.galleryUnloaded === "true" && source) {
            media.dataset.galleryUnloaded = "false";
            media.classList.remove("gallery-media-unloaded");
            if (media.dataset.gallerySrcset) media.setAttribute("srcset", media.dataset.gallerySrcset);
            if (media.dataset.gallerySizes) media.setAttribute("sizes", media.dataset.gallerySizes);
            media.src = source;
          }
          return;
        }
        if (!source || media.dataset.galleryUnloaded === "true" || !media.complete || media.naturalWidth <= 0) return;
        media.dataset.galleryUnloaded = "true";
        media.classList.add("gallery-media-unloaded");
        if (media.hasAttribute("srcset")) media.dataset.gallerySrcset = media.getAttribute("srcset") || "";
        if (media.hasAttribute("sizes")) media.dataset.gallerySizes = media.getAttribute("sizes") || "";
        media.removeAttribute("srcset");
        media.removeAttribute("sizes");
        media.removeAttribute("src");
      });
    }, { root: grid, rootMargin: "1200px 0px" });
  }
  const targetRoots = Array.isArray(roots) && roots.length ? roots : [grid];
  targetRoots.forEach((root) => {
    if (!(root instanceof Element)) return;
    const selector = "img.thumb[data-known-aspect='true'][data-gallery-src], video.thumb-video-frame[data-gallery-video-src]";
    const media = root.matches?.(selector)
      ? [root]
      : [...root.querySelectorAll(selector)];
    media.forEach((item) => {
      if (item instanceof HTMLVideoElement) bindGalleryVideoFrame(item);
      if (item.dataset.galleryObserved === "true") return;
      item.dataset.galleryObserved = "true";
      galleryMediaObserver.observe(item);
    });
  });
}

function galleryCardIntrinsicHeight(card) {
  const mediaButton = card.querySelector(":scope > .asset-card-select");
  const info = card.querySelector(":scope > .asset-card-info");
  const mediaHeight = mediaButton instanceof HTMLElement ? mediaButton.getBoundingClientRect().height : 0;
  const infoHeight = info instanceof HTMLElement ? info.getBoundingClientRect().height : 0;
  const contentHeight = mediaHeight + infoHeight;
  return contentHeight > 0 ? contentHeight : (card.getBoundingClientRect().height || 0);
}

function masonryGeometrySpan(grid, geometry) {
  const card = galleryCardVirtualNode(grid, geometry.id);
  let span = card
    ? Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10)
    : galleryCardVirtualSpanCache.get(galleryVirtualSpanKey(geometry.id));
  if (!Number.isFinite(span) || span <= 0) span = geometry.rowEnd - geometry.rowStart;
  if (!Number.isFinite(span) || span <= 0) {
    const entry = galleryCardVirtualEntries.get(geometry.id);
    if (entry) span = estimatedGalleryCardSpan(entry.asset);
  }
  return Math.max(1, Number.isFinite(span) ? Math.ceil(span) : 1);
}

// A hydrated card may reveal a more accurate height than its virtual estimate.
// Re-running shortest-column placement for the entire gallery at that point
// makes later cards hop between columns, which is especially visible while an
// infinite-scroll page is entering the warm zone. Keep the established column
// assignment stable and shift only the affected column from the first changed
// card downward. Full relayouts (resize or structural changes) still
// use placeMasonryCards and are free to rebalance columns.
function reflowPlacedMasonryColumns(grid, cards) {
  const affectedColumns = new Map();
  for (const card of cards) {
    if (!(card instanceof HTMLElement) || !card.dataset.id) return false;
    const geometry = galleryCardVirtualGeometryById.get(card.dataset.id);
    const column = geometry ? galleryCardVirtualGeometryColumns[geometry.columnIndex] : null;
    if (!geometry || !column) return false;
    const index = column.findIndex((item) => item.id === geometry.id);
    if (index < 0) return false;
    const previous = affectedColumns.get(geometry.columnIndex);
    affectedColumns.set(geometry.columnIndex, previous === undefined ? index : Math.min(previous, index));
  }

  for (const [columnIndex, startIndex] of affectedColumns) {
    const column = galleryCardVirtualGeometryColumns[columnIndex];
    let rowStart = startIndex > 0 ? column[startIndex - 1].rowEnd : 1;
    for (let index = startIndex; index < column.length; index += 1) {
      const geometry = column[index];
      const span = masonryGeometrySpan(grid, geometry);
      geometry.rowStart = rowStart;
      geometry.rowEnd = rowStart + span;
      const card = galleryCardVirtualNode(grid, geometry.id);
      if (card) {
        const columnStart = String(columnIndex + 1);
        const nextRowStart = String(geometry.rowStart);
        if (card.style.gridColumnStart !== columnStart) card.style.gridColumnStart = columnStart;
        if (card.style.gridRowStart !== nextRowStart) card.style.gridRowStart = nextRowStart;
        card.style.gridRowEnd = `span ${span}`;
      }
      rowStart = geometry.rowEnd;
    }
  }

  galleryCardVirtualGeometryRevision += 1;
  invalidateCardGeometryCache();
  syncGalleryVirtualExtent();
  if (state.assets.length >= GALLERY_CARD_VIRTUAL_THRESHOLD) {
    pruneGalleryCardDomWindow();
    scheduleGalleryCardVirtualWindowSync();
  }
  return true;
}

function layoutMasonry(cards = null) {
  const grid = els.assetGrid;
  if (!grid) return;
  // Reset and replace horizontal placement in the same synchronous pass.
  // Clearing starts in ResizeObserver leaves fixed-row items on auto columns,
  // and virtual hydration can restore old column indices before the next rAF.
  if (!cards) resetMasonryColumnsForResize(grid);
  const gridStyles = getComputedStyle(grid);
  const galleryGap = Number.parseFloat(gridStyles.getPropertyValue("--gallery-gap")) || Number.parseFloat(gridStyles.columnGap) || 0;
  const virtualColumnWidth = galleryCardColumnWidth(gridStyles);
  const columnWidthChanged = Math.abs(virtualColumnWidth - galleryCardVirtualColumnWidth) >= 0.5;
  galleryCardVirtualColumnWidth = virtualColumnWidth;
  if (columnWidthChanged) galleryCardVirtualSpanCache.clear();
  const targets = cards ? [...cards] : [...grid.querySelectorAll(".asset-card")];
  const measureTargets = [];
  const measurements = [];
  let needsPlacement = !cards;
  let allTargetsUnplaced = Boolean(cards?.length);
  let allTargetsPlaced = Boolean(cards?.length);
  targets.forEach((card) => {
    if (!(card instanceof HTMLElement) || !card.isConnected) return;
    const alreadyPlaced = Boolean(card.style.gridColumnStart && card.style.gridRowStart);
    if (!alreadyPlaced) {
      needsPlacement = true;
      allTargetsPlaced = false;
    }
    else allTargetsUnplaced = false;
    if (card.classList.contains("asset-card-virtual-placeholder")) {
      if (columnWidthChanged) {
        const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
        if (entry) {
          const span = estimatedGalleryCardSpan(entry.asset);
          card.dataset.virtualSpan = String(span);
          card.style.gridRowEnd = `span ${span}`;
        }
      }
      return;
    }
    // Keep the existing grid span pinned while measuring. Removing grid-row-end
    // forces a temporary one-row topology and can make Chromium's scroll anchor
    // react to an intermediate layout that is never meant to be painted.
    // Exposing descendants is enough because the card itself is align-self:start.
    const previousSpan = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
    card.classList.remove("masonry-content-virtualized");
    measureTargets.push([card, previousSpan]);
  });
  // All layout-affecting writes above are complete before the first geometry
  // read, so Chromium performs one layout flush instead of a write/read cycle
  // for every card.
  measureTargets.forEach(([card, previousSpan]) => {
    const height = galleryCardIntrinsicHeight(card);
    if (height) measurements.push([card, Math.ceil(height + galleryGap), previousSpan]);
  });
  const spanChangedCards = [];
  measurements.forEach(([card, span, previousSpan]) => {
    if (!Number.isFinite(previousSpan) || previousSpan !== span) {
      needsPlacement = true;
      spanChangedCards.push(card);
    }
    card.style.gridRowEnd = `span ${span}`;
    if (card.dataset.id) galleryCardVirtualSpanCache.set(galleryVirtualSpanKey(card.dataset.id, virtualColumnWidth), span);
    card.classList.add("masonry-content-virtualized");
  });
  if (!needsPlacement) {
    invalidateCardGeometryCache();
    return;
  }
  if (allTargetsPlaced && spanChangedCards.length && reflowPlacedMasonryColumns(grid, spanChangedCards)) return;
  const columnCount = Math.max(1, gridStyles.gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  const canAppendIncrementally = allTargetsUnplaced
    && galleryCardVirtualGeometryColumns.length === columnCount
    && galleryCardVirtualGeometryById.size > 0
    && targets.every((card) => card instanceof HTMLElement && card.dataset.id && !galleryCardVirtualGeometryById.has(card.dataset.id));
  if (canAppendIncrementally) {
    const columnEnds = galleryCardVirtualGeometryColumns.map((column) => column.at(-1)?.rowEnd || 1);
    targets.forEach((card) => {
      if (!(card instanceof HTMLElement) || !card.isConnected) return;
      let span = Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10);
      if (!Number.isFinite(span) || span <= 0) {
        const entry = galleryCardVirtualEntries.get(card.dataset.id || "");
        if (!entry) return;
        span = estimatedGalleryCardSpan(entry.asset);
        card.style.gridRowEnd = `span ${span}`;
      }
      let columnIndex = 0;
      for (let index = 1; index < columnEnds.length; index += 1) {
        if (columnEnds[index] < columnEnds[columnIndex]) columnIndex = index;
      }
      const rowStart = columnEnds[columnIndex];
      const columnStart = columnIndex + 1;
      card.style.gridColumnStart = String(columnStart);
      card.style.gridRowStart = String(rowStart);
      const id = card.dataset.id;
      const geometry = { id, rowStart, rowEnd: rowStart + span, columnIndex };
      galleryCardVirtualGeometryColumns[columnIndex].push(geometry);
      galleryCardVirtualGeometryById.set(id, geometry);
      columnEnds[columnIndex] += span;
    });
    galleryCardVirtualGeometryRevision += 1;
    invalidateCardGeometryCache();
    syncGalleryVirtualExtent();
    if (state.assets.length >= GALLERY_CARD_VIRTUAL_THRESHOLD) {
      pruneGalleryCardDomWindow();
      scheduleGalleryCardVirtualWindowSync();
    }
    return;
  }
  placeMasonryCards(grid, gridStyles);
}

// Recompute only card placement, not card height. Structural mutations such as
// Trash/removal and sort changes keep the surviving cards' measured spans, so
// re-reading every card's DOM height would add layout work without adding any
// information. A linear placement pass closes holes immediately.
function placeMasonryCards(grid, gridStyles) {
  const columnCount = Math.max(1, gridStyles.gridTemplateColumns.split(/\s+/).filter(Boolean).length);
  const columnEnds = Array(columnCount).fill(1);
  const nextGeometryColumns = Array.from({ length: columnCount }, () => []);
  galleryCardVirtualGeometryById.clear();
  state.assets.forEach((asset) => {
    const id = asset.id;
    const entry = galleryCardVirtualEntries.get(id);
    if (!entry) return;
    const card = galleryCardVirtualNode(grid, id);
    let span = card
      ? Number.parseInt(String(card.style.gridRowEnd || "").replace(/\D+/g, ""), 10)
      : galleryCardVirtualSpanCache.get(galleryVirtualSpanKey(id));
    if (!Number.isFinite(span) || span <= 0) span = estimatedGalleryCardSpan(entry.asset);
    let columnIndex = 0;
    for (let index = 1; index < columnEnds.length; index += 1) {
      if (columnEnds[index] < columnEnds[columnIndex]) columnIndex = index;
    }
    const rowStart = columnEnds[columnIndex];
    const columnStart = columnIndex + 1;
    if (card) {
      if (card.style.gridColumnStart !== String(columnStart)) card.style.gridColumnStart = String(columnStart);
      if (card.style.gridRowStart !== String(rowStart)) card.style.gridRowStart = String(rowStart);
      card.style.gridRowEnd = `span ${span}`;
    }
    const geometry = { id, rowStart, rowEnd: rowStart + span, columnIndex };
    nextGeometryColumns[columnIndex].push(geometry);
    galleryCardVirtualGeometryById.set(id, geometry);
    columnEnds[columnIndex] += span;
  });
  galleryCardVirtualGeometryColumns = nextGeometryColumns;
  galleryCardVirtualGeometryRevision += 1;
  invalidateCardGeometryCache();
  syncGalleryVirtualExtent();
  if (state.assets.length >= GALLERY_CARD_VIRTUAL_THRESHOLD) {
    pruneGalleryCardDomWindow();
    scheduleGalleryCardVirtualWindowSync();
  }
}

function reflowMasonryPlacement() {
  const grid = els.assetGrid;
  if (!grid) return;
  placeMasonryCards(grid, getComputedStyle(grid));
}

function scheduleMasonryLayout(card = null) {
  if (card) masonryPendingCards.add(card);
  else masonryFullLayoutPending = true;
  if (masonryLayoutFrame !== null) return;
  masonryLayoutFrame = requestAnimationFrame(() => {
    masonryLayoutFrame = null;
    if (masonryFullLayoutPending) layoutMasonry();
    else if (masonryPendingCards.size) layoutMasonry([...masonryPendingCards]);
    masonryFullLayoutPending = false;
    masonryPendingCards.clear();
  });
}

function resetMasonryColumnsForResize(grid) {
  // Fixed rows plus auto columns can themselves create implicit tracks: five
  // cards anchored to row 1 cannot auto-place into a new three-column grid.
  // Temporarily overlap cards in the first explicit column to measure their
  // true responsive width. Preserve row spans/scroll height and finish placing
  // every card before returning, so this measuring state is never painted.
  grid.querySelectorAll(":scope > .asset-card").forEach((card) => {
    card.style.gridColumnStart = "1";
  });
}

function setupMasonryLayout(options = {}) {
  const grid = els.assetGrid; if (!grid) return;
  const requestedCards = Array.isArray(options.cards) ? options.cards.filter(Boolean) : null;
  const fullLayout = options.full !== false || !requestedCards;
  const layoutTargets = fullLayout ? null : requestedCards;
  // Known image dimensions reserve the correct media height before bytes load,
  // so one synchronous pass is enough for the first paint. Unknown legacy
  // images repair only their own card after decode instead of forcing an O(N)
  // scan for every image load (the former O(N²) long-gallery hot path).
  layoutMasonry(layoutTargets);
  const mediaRoots = layoutTargets || [grid];
  const pendingMedia = mediaRoots.flatMap((root) => {
    if (!(root instanceof Element)) return [];
    const own = root.matches?.("img.thumb:not([data-known-aspect='true'])") ? [root] : [];
    return [...own, ...root.querySelectorAll("img.thumb:not([data-known-aspect='true'])")];
  });
  pendingMedia.forEach((media) => {
    if (media.dataset.masonryBound === "true") return;
    media.dataset.masonryBound = "true";
    const settle = () => {
      if (media.naturalWidth > 0 && media.naturalHeight > 0) {
        media.setAttribute("width", String(media.naturalWidth));
        media.setAttribute("height", String(media.naturalHeight));
        media.dataset.knownAspect = "true";
        setupGalleryMediaVirtualization([media]);
      }
      const card = media.closest(".asset-card");
      if (card) scheduleMasonryLayout(card);
    };
    if (media.complete) settle();
    else {
      media.addEventListener("load", settle, { once: true });
      media.addEventListener("error", settle, { once: true });
    }
  });
  if ("ResizeObserver" in window && masonryObservedGrid !== grid) {
    masonryResizeObserver?.disconnect();
    masonryObservedGrid = grid;
    masonryObservedWidth = grid.clientWidth;
    masonryResizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width ?? grid.clientWidth;
      if (Math.abs(width - masonryObservedWidth) < 0.5) return;
      masonryObservedWidth = width;
      // GravityPort A3：画廊宽度变化先重算列数（滑杆目标宽不变、内容宽变了），
      // 列数真的变了时 syncGalleryColumns 自己会再排一次 masonry。
      syncGalleryColumns();
      scheduleMasonryLayout();
    });
    masonryResizeObserver.observe(grid);
  }
  setupGalleryMediaVirtualization(layoutTargets || null);
  setupGalleryCardVirtualization(layoutTargets || null);
  setupInfiniteScroll();
}

let infiniteScrollObserver = null;
let isLoadingMore = false;
let infiniteScrollRearmFrame = null;
// Fresh result sets (launch, filter/search/sort/project switches) render while
// the user is parked at scrollTop 0, where the sentinel's resting position is
// an artifact of placeholder heights rather than of the user's position. The
// guard parks the observer on a viewport-only rootMargin until the first real
// scroll; see setupInfiniteScroll.
let infiniteScrollFirstPageGuard = false;
let infiniteScrollScrollGrid = null;

function handleInfiniteScrollFirstScroll() {
  if (!infiniteScrollFirstPageGuard) return;
  const grid = els.assetGrid;
  if (!grid || grid.scrollTop <= 0) return;
  infiniteScrollFirstPageGuard = false;
  setupInfiniteScroll();
}

function bindInfiniteScrollFirstScroll() {
  const grid = els.assetGrid;
  if (!grid || infiniteScrollScrollGrid === grid) return;
  infiniteScrollScrollGrid?.removeEventListener("scroll", handleInfiniteScrollFirstScroll);
  infiniteScrollScrollGrid = grid;
  grid.addEventListener("scroll", handleInfiniteScrollFirstScroll, { passive: true });
}

function sentinelInInfiniteScrollWarmZone(grid, sentinel, preloadDistance) {
  if (!(grid instanceof HTMLElement) || !(sentinel instanceof HTMLElement) || !sentinel.isConnected) return false;
  const gridBounds = grid.getBoundingClientRect();
  const sentinelBounds = sentinel.getBoundingClientRect();
  return sentinelBounds.bottom >= gridBounds.top - preloadDistance
    && sentinelBounds.top <= gridBounds.bottom + preloadDistance;
}

function requestInfiniteScrollAppend(requestKey, preloadDistance) {
  const grid = els.assetGrid;
  const sentinel = grid?.querySelector('[data-sentinel="true"]');
  if (!grid || !sentinel || !state.nextCursor || isLoadingMore || state.paginationStatus === "error"
    || requestKey !== assetRequestKey(currentAssetRequest())) return;
  isLoadingMore = true;
  const fallbackButton = grid.querySelector('[data-action="load-more"]')?.closest(".asset-load-more");
  let appendApplied = false;
  loadAssets({ append: true }).then((applied) => {
    appendApplied = Boolean(applied);
    if (!applied && fallbackButton?.isConnected) fallbackButton.hidden = false;
  }).finally(() => {
    isLoadingMore = false;
    if (!appendApplied || requestKey !== assetRequestKey(currentAssetRequest()) || infiniteScrollRearmFrame !== null) return;
    infiniteScrollRearmFrame = requestAnimationFrame(() => {
      infiniteScrollRearmFrame = null;
      const nextGrid = els.assetGrid;
      const nextSentinel = nextGrid?.querySelector('[data-sentinel="true"]');
      if (nextGrid && nextSentinel && state.nextCursor
        && sentinelInInfiniteScrollWarmZone(nextGrid, nextSentinel, infiniteScrollFirstPageGuard ? 0 : preloadDistance)) {
        requestInfiniteScrollAppend(requestKey, preloadDistance);
      }
    });
  });
}

function setupInfiniteScroll() {
  const requestKey = assetRequestKey(currentAssetRequest());
  infiniteScrollObserver?.disconnect();
  if (infiniteScrollRearmFrame !== null) cancelAnimationFrame(infiniteScrollRearmFrame);
  infiniteScrollRearmFrame = null;
  const grid = els.assetGrid;
  const sentinel = grid?.querySelector('[data-sentinel="true"]');
  if (!grid || !sentinel || !state.nextCursor) return;
  const fallbackButton = grid.querySelector('[data-action="load-more"]')?.closest(".asset-load-more");
  if (state.paginationStatus === "error") {
    if (fallbackButton) fallbackButton.hidden = false;
    return;
  }
  if (!("IntersectionObserver" in window)) {
    if (fallbackButton) fallbackButton.hidden = false;
    return;
  }
  // Data is already prefetched by api-client. The sentinel therefore controls
  // only when cached rows enter the DOM, not when I/O starts. Mount roughly one
  // viewport ahead: early enough to hide a 40-card placeholder commit, but late
  // enough that the first page never auto-appends during launch. The preload
  // margin alone does not guarantee that: launch only stayed on one page because
  // pending-thumb placeholders measure taller than real media, and a fresh
  // result set with real thumbnails can leave the sentinel inside the warm zone
  // before the user scrolls at all. Until the first scroll, the observer (and
  // the post-append rearm check) therefore watch the viewport only, so short
  // result sets still fill the screen; handleInfiniteScrollFirstScroll restores
  // the preload margin afterwards.
  const preloadDistance = Math.max(600, Math.ceil(grid.clientHeight * 0.85));
  const firstPageUnscrolled = grid.scrollTop <= 0;
  infiniteScrollFirstPageGuard = firstPageUnscrolled;
  infiniteScrollObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) requestInfiniteScrollAppend(requestKey, preloadDistance);
    });
  }, { root: grid, rootMargin: `${firstPageUnscrolled ? 0 : preloadDistance}px 0px` });
  infiniteScrollObserver.observe(sentinel);
  bindInfiniteScrollFirstScroll();
}

/**
 * Placeholders sized like real cards, so the first paint is not a fake empty
 * library. Heights come from nth-child rules rather than inline styles.
 */
function gallerySkeletonMarkup() {
  const tiles = Array.from({ length: SKELETON_TILE_COUNT }, () => `<div class="asset-skeleton" aria-hidden="true"></div>`).join("");
  return `<div class="gallery-skeleton" role="status" aria-live="polite"><span class="visually-hidden">${escapeHtml(t("galleryLoading"))}</span>${tiles}</div>`;
}

function assetCardRenderKey(asset, selected) {
  return [
    asset.project_id || state.project,
    asset.id,
    asset.updated_at || "",
    asset.image_url || "",
    asset.thumbnail_url || "",
    asset.preview_url || "",
    asset.favorite ? "1" : "0",
    selected ? "1" : "0",
    asset.group || "",
    asset.version_index || "",
    asset.deleted_at || "",
    state.scope === "trash" ? String(trashRemainingDays(asset.deleted_at)) : "",
    asset.stack?.id || "",
    asset.stack?.count || "",
    asset.stack?.name || "",
    asset.stack?.match_count || "",
    state.cutAssetIds instanceof Set && state.cutAssetIds.has(asset.id) ? "1" : "0",
    state.locale,
  ].join("\u001f");
}

function initializeAssetCardElement(card, renderKey, animateCard) {
  if (!(card instanceof HTMLElement)) return null;
  if (card.classList.contains("asset-card-virtual-placeholder")) {
    const span = Number.parseInt(card.dataset.virtualSpan || "", 10);
    if (Number.isFinite(span) && span > 0) card.style.gridRowEnd = `span ${span}`;
  }
  if (card.classList.contains("is-stack")) {
    const actions = card.querySelector(".card-actions");
    actions?.setAttribute("inert", "");
    actions?.setAttribute("aria-hidden", "true");
  }
  card.dataset.renderKey = renderKey;
  if (animateCard) card.addEventListener("animationend", () => card.classList.remove("card-enter"), { once: true });
  return card;
}

function createAssetCardElements(entries) {
  if (!entries.length) return new Map();
  const template = document.createElement("template");
  template.innerHTML = entries.map((entry) => entry.markup.trim()).join("");
  const cards = [...template.content.children];
  const created = new Map();
  entries.forEach((entry, index) => {
    const card = initializeAssetCardElement(cards[index], entry.renderKey, entry.animateCard);
    if (card) created.set(entry.id, card);
  });
  return created;
}

function galleryPaginationMarkup() {
  if (!state.nextCursor) return "";
  return `<div class="asset-load-more" hidden><button type="button" data-action="load-more">${escapeHtml(t("loadMore"))}</button></div><div class="infinite-scroll-sentinel" data-sentinel="true"></div>`;
}

function removeGalleryPaginationBoundary(grid) {
  grid.querySelectorAll(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel").forEach((element) => element.remove());
}

function insertGalleryPaginationBoundary(grid) {
  if (!state.nextCursor) return;
  const extent = grid.querySelector(":scope > .gallery-virtual-extent");
  if (extent) extent.insertAdjacentHTML("beforebegin", galleryPaginationMarkup());
  else grid.insertAdjacentHTML("beforeend", galleryPaginationMarkup());
}

function reconcileAssetCards(entries) {
  const grid = els.assetGrid;
  if (!grid) return { changedCards: [], replacedFocusedCard: false, structureChanged: false };
  const galleryChild = (element) => element.classList.contains("asset-card")
    || element.classList.contains("asset-load-more")
    || element.classList.contains("infinite-scroll-sentinel")
    || element.classList.contains("gallery-virtual-extent");
  if ([...grid.children].some((element) => !galleryChild(element))) {
    releaseGalleryObservers(grid);
    grid.replaceChildren();
  }

  const existingCardList = [...grid.querySelectorAll(":scope > .asset-card")];
  const existingOrder = existingCardList.map((card) => card.dataset.id || "");
  const desiredOrder = entries.map((entry) => entry.id);
  const structureChanged = existingOrder.length !== desiredOrder.length
    || existingOrder.some((id, index) => id !== desiredOrder[index]);
  const existingCards = new Map(existingCardList.map((card) => [card.dataset.id, card]));
  const keptCards = new Set();
  const desiredCards = [];
  const changedCards = [];
  let replacedFocusedCard = false;
  const entriesNeedingCards = entries.filter((entry) => {
    const card = existingCards.get(entry.id);
    return !card || card.dataset.renderKey !== entry.renderKey;
  });
  const createdCards = createAssetCardElements(entriesNeedingCards);

  for (const entry of entries) {
    let card = existingCards.get(entry.id) || null;
    if (!card || card.dataset.renderKey !== entry.renderKey) {
      const replacement = createdCards.get(entry.id) || null;
      if (!replacement) continue;
      if (card) {
        if (card.contains(document.activeElement)) replacedFocusedCard = true;
        releaseGalleryObservers(card);
        card.replaceWith(replacement);
      }
      card = replacement;
      galleryCardVirtualNodes.set(entry.id, card);
      changedCards.push(card);
    }
    if (card) galleryCardVirtualNodes.set(entry.id, card);
    keptCards.add(card);
    desiredCards.push(card);
  }

  existingCards.forEach((card) => {
    if (!keptCards.has(card)) {
      if (card.contains(document.activeElement)) replacedFocusedCard = true;
      releaseGalleryObservers(card);
      if (card.dataset.id) galleryCardVirtualNodes.delete(card.dataset.id);
      card.remove();
    }
  });
  let cursor = grid.firstElementChild;
  desiredCards.forEach((card) => {
    if (card !== cursor) grid.insertBefore(card, cursor);
    cursor = card.nextElementSibling;
  });
  // Pagination controls are replaceable, but the virtual extent belongs to the
  // masonry virtualization layer. Keeping it mounted preserves the scroll range
  // while a reconciliation is being laid out and avoids an intermediate
  // scrollHeight collapse near the pagination boundary.
  removeGalleryPaginationBoundary(grid);
  insertGalleryPaginationBoundary(grid);
  if (changedCards.length || existingCards.size !== desiredCards.length) invalidateCardGeometryCache();
  return { changedCards, replacedFocusedCard, structureChanged };
}

function appendAssetCards(entries) {
  const grid = els.assetGrid;
  if (!grid) return [];
  // Never tear down the virtual extent during an append. It is the stable
  // representation of the already-laid-out gallery height; removing it even
  // for one synchronous append/layout cycle can clamp scrollTop in Chromium
  // before the new page has received explicit masonry coordinates.
  removeGalleryPaginationBoundary(grid);
  const createdCards = createAssetCardElements(entries);
  const changedCards = entries.map((entry) => createdCards.get(entry.id)).filter(Boolean);
  if (changedCards.length) {
    const extent = grid.querySelector(":scope > .gallery-virtual-extent");
    if (extent) extent.before(...changedCards);
    else grid.append(...changedCards);
    changedCards.forEach((card) => {
      if (card.dataset.id) galleryCardVirtualNodes.set(card.dataset.id, card);
    });
  }
  insertGalleryPaginationBoundary(grid);
  if (changedCards.length) invalidateCardGeometryCache();
  return changedCards;
}

// F-24：入场动画范围经 arguments 传入（loadAssets 在首次加载/追加页时设置），
// 普通重渲染（搜索/筛选/排序/后台刷新）不带参数则不播放；签名保持无参以兼容
// 既有契约测试对 renderGrid 签名的正则锁定。
function renderGrid() {
  // Direct UI-only rerenders (language/state decoration) should keep
  // the current viewport by default. loadAssets explicitly disables this when
  // the result-set semantics changed (search/filter/sort/project).
  const { animate = false, animateFrom = 0, preserveScroll = true } = arguments[0] || {};
  if (!els.assetGrid) return;
  const focusedElement = document.activeElement instanceof HTMLElement && els.assetGrid.contains(document.activeElement)
    ? document.activeElement
    : null;
  const focusedCard = focusedElement?.closest?.(".asset-card");
  const focusedAssetId = focusedCard?.dataset.id || null;
  const focusedAction = focusedElement?.classList.contains("card-favorite")
    ? "favorite"
    : focusedElement?.classList.contains("asset-card-select")
      ? "select"
      : null;
  const cardInfo = state.showCardInfo ? "show" : "hide";
  els.assetGrid.dataset.cardInfo = cardInfo;
  els.assetGrid.dataset.loadedAssets = String(state.assets.length);
  els.assetGrid.dataset.query = state.query;
  const restoreGridFallbackFocus = () => {
    if (!focusedElement) return;
    requestAnimationFrame(() => els.assetGrid?.focus({ preventScroll: true }));
  };
  // Loading, failed, empty and populated are four distinct renders; the empty
  // state is only reachable once a request has actually answered with nothing.
  if (state.galleryStatus === "loading" || state.galleryStatus === "error" || !state.assets.length) galleryCardVirtualNodes.clear();
  // 释放必须先于丢弃；下一行与被契约测试钉住的单行 skeleton 分支保持同条件并列。
  if (state.galleryStatus === "loading") releaseGalleryObservers(els.assetGrid);
  if (state.galleryStatus === "loading") { els.assetGrid.innerHTML = gallerySkeletonMarkup(); restoreGridFallbackFocus(); return; }
  if (state.galleryStatus === "error") {
    const message = state.galleryError?.message || "";
    releaseGalleryObservers(els.assetGrid);
    els.assetGrid.innerHTML = `<div class="error-state"><p>${escapeHtml(t("loadFailed"))}</p><span>${escapeHtml(message)}</span><button type="button" data-action="retry">${escapeHtml(t("retry"))}</button></div>`;
    gallerySelection.syncRenderedSelection();
    restoreGridFallbackFocus();
    return;
  }
  if (!state.assets.length) {
    // F-08：零结果不再一律谎称「素材库为空」——判定由集中式 helper 按
    // 全库总数、query、facets、scope、分组分流，五类空态共用一个壳。
    releaseGalleryObservers(els.assetGrid);
    els.assetGrid.innerHTML = galleryEmptyMarkup();
    gallerySelection.syncRenderedSelection();
    announceEmptyState(els.assetGrid.querySelector(".gallery-empty-state")?.dataset.emptyKind);
    restoreGridFallbackFocus();
    return;
  }
  const isAppendMode = animateFrom > 0;
  const canAppendFast = isAppendMode
    && galleryCardVirtualEntries.size === animateFrom
    && els.assetGrid.dataset.renderedCardInfo === cardInfo;
  const renderAssets = canAppendFast ? state.assets.slice(animateFrom) : state.assets;
  galleryCardVirtualColumnWidth = galleryCardColumnWidth();
  if (!canAppendFast) {
    galleryCardVirtualEntries.clear();
    const currentIds = new Set(state.assets.map((asset) => asset.id));
    pruneGalleryVirtualSpanCache(currentIds);
    for (const id of galleryCardVirtualHydratedIds) {
      if (!currentIds.has(id)) galleryCardVirtualHydratedIds.delete(id);
    }
  }
  // F-24：闭包序号判断入场动画范围（保持 map 回调签名与既有契约一致）。
  let cardOrdinal = canAppendFast ? animateFrom : 0;
  const cards = renderAssets.map((asset) => {
    const ordinal = cardOrdinal;
    const animateCard = animate && cardOrdinal >= animateFrom;
    cardOrdinal += 1;
    return buildRenderedGalleryCard(asset, ordinal, animateCard);
  });
  const domCards = canAppendFast || state.assets.length < GALLERY_CARD_DOM_WINDOW_THRESHOLD
    ? cards
    : cards.filter((entry, index) => {
      const ordinal = index;
      if (ordinal < GALLERY_CARD_INITIAL_HYDRATE || entry.id === state.selectedId) return true;
      const geometry = galleryCardVirtualGeometryById.get(entry.id);
      if (!geometry) return false;
      const minRow = Math.max(0, els.assetGrid.scrollTop - GALLERY_CARD_DOM_PRELOAD);
      const maxRow = els.assetGrid.scrollTop + els.assetGrid.clientHeight + GALLERY_CARD_DOM_PRELOAD;
      return geometry.rowEnd >= minRow && geometry.rowStart <= maxRow;
    });
  // Populated renders are reconciled by asset id. Unchanged cards keep their
  // decoded media and DOM nodes; only changed/new cards are recreated.
  const scrollContainer = els.assetGrid;
  const savedScrollTop = (isAppendMode || preserveScroll) ? scrollContainer.scrollTop : null;
  if (!preserveScroll && !isAppendMode) scrollContainer.scrollTop = 0;
  const previousCardInfo = els.assetGrid.dataset.renderedCardInfo || "";
  const appendChangedCards = canAppendFast ? appendAssetCards(domCards) : null;
  const reconciliation = canAppendFast
    ? { changedCards: appendChangedCards, replacedFocusedCard: false, structureChanged: false }
    : reconcileAssetCards(domCards);
  const { changedCards, replacedFocusedCard, structureChanged } = reconciliation;
  els.assetGrid.dataset.renderedCardInfo = cardInfo;
  const requiresFullMasonry = !canAppendFast && (previousCardInfo !== cardInfo || changedCards.length >= state.assets.length);
  setupMasonryLayout(requiresFullMasonry ? {} : { cards: changedCards, full: false });
  if (!requiresFullMasonry && structureChanged) reflowMasonryPlacement();
  // Keyed incremental reconciliation keeps unchanged card nodes mounted, so
  // Chromium's native scroll anchoring can preserve the actual viewed card
  // when new assets are inserted above it. Writing the old numeric scrollTop
  // after every background refresh would override that correction and create
  // the visible "gallery nudge". Only fall back to numeric restoration when
  // the render replaced the whole populated set and no stable DOM anchor is
  // left for the browser to use.
  const needsNumericScrollRestore = savedScrollTop !== null
    && !canAppendFast
    && changedCards.length >= state.assets.length;
  if (needsNumericScrollRestore) {
    requestAnimationFrame(() => {
      const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
      scrollContainer.scrollTop = Math.min(savedScrollTop, maxScrollTop);
    });
  }
  if (focusedAssetId && focusedAction && (replacedFocusedCard || !focusedElement?.isConnected)) {
    requestAnimationFrame(() => {
      const card = els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(focusedAssetId)}"]`);
      const replacement = focusedAction === "favorite"
        ? card?.querySelector(".card-favorite")
        : card?.querySelector(".asset-card-select");
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    });
  }
  if (canAppendFast) {
    gallerySelection.syncRenderedSelection({
      prune: false,
      changedIds: new Set(changedCards.map((card) => card.dataset.id).filter(Boolean)),
    });
  } else {
    gallerySelection.syncRenderedSelection();
  }
}

// ===== Gallery 卡片构建（renderGrid 与增量提交共用）=====
function buildGalleryCardEntry(asset, ordinal, animateCard) {
  // 自定义堆叠名优先于封面素材标题（服务端只在 ≥2 个活跃成员时标注 stack）。
  const stackName = String(asset.stack?.name || "").trim();
  const title = stackName || cardShortTitle(asset);
  const sourceLabel = assetSourceLabel(asset);
  const date = formatDate(asset.created_at, state.locale);
  const selected = asset.id === state.selectedId;
  const isStack = Boolean(!state.activeStackId && asset.stack?.id && Number(asset.stack?.count) > 1);
  const media = assetMediaPreviewMarkup(asset, "thumb");
  // Short, structured label instead of the full prompt.
  const label = t("cardAccessibleName", { title: title || asset.id, source: sourceLabel, date });
  const stackMatchCount = Math.max(0, Number(asset.stack?.match_count || 0));
  const stackHasPartialMatch = isStack && stackMatchCount > 0 && stackMatchCount < Number(asset.stack.count);
  const stackDescription = isStack
    ? ` aria-description="${escapeHtml(stackHasPartialMatch
      ? t("stackMatchAccessibleName", { label, count: asset.stack.count, matched: stackMatchCount })
      : t("stackAccessibleName", { label, count: asset.stack.count }))}"`
    : "";
  const versionIndex = Number(asset.version_index) || 0;
  // 版本徽章与分组徽章并存：版本家族拆散后，分组在任何只读界面都不再"失踪"。
  const badges = [
    versionIndex > 1 ? t("versionLabelShort", { number: versionIndex }) : "",
    String(asset.group || "").trim(),
  ].filter(Boolean);
  const badgeMarkup = badges.map((badge) => `<span class="asset-card-badge" title="${escapeHtml(badge)}">${escapeHtml(badge)}</span>`).join("");
  const info = `<div class="asset-card-info"><p class="asset-card-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p><p class="asset-card-meta"><span>${escapeHtml(sourceLabel)}</span><span>${escapeHtml(date)}</span>${badgeMarkup}</p></div>`;
  const isFav = asset.favorite;
  const favoriteLabel = isFav ? t("removeFavorite") : t("addFavorite");
  // Phase 1C/1C.1 契约：.card-actions > button.card-action-btn.card-favorite，
  // 业务 class 与 data 属性全部保留（现有事件绑定依赖）；aria-pressed 表达收藏态。
  // 卡片上原有的快捷复制按钮随 R21 去掉：复制提示词在右键菜单和检视器里。
  const favBtn = `<button class="card-action-btn card-favorite${isFav ? " is-fav" : ""}" type="button" data-fav-id="${escapeHtml(asset.id)}" aria-pressed="${Boolean(isFav)}" aria-label="${escapeHtml(favoriteLabel)}" title="${escapeHtml(favoriteLabel)}"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2.5l2.95 5.97 6.59.96-4.77 4.65 1.13 6.57L12 17.57l-5.9 3.08 1.13-6.57-4.77-4.65 6.59-.96L12 2.5z"/></svg></button>`;
  // Trash cards expose restore/permanent-delete through the Trash actions,
  // so do not render the favorite control there at all. Removing the
  // focusable controls from the markup is safer than hiding them with CSS.
  const cardActions = state.scope === "trash" ? "" : `<div class="card-actions">${favBtn}</div>`;
  const stackBadge = isStack
    ? `<span class="asset-stack-count" aria-hidden="true">${stackHasPartialMatch ? `${stackMatchCount}/${Number(asset.stack.count)}` : Number(asset.stack.count)}</span>`
    : "";
  const trashBadge = state.scope === "trash" && asset.deleted_at
    ? `<span class="trash-countdown">${escapeHtml(t("trashDaysRemaining", { count: trashRemainingDays(asset.deleted_at) }))}</span>`
    : "";
  // 任务 93：剪切中的卡片变淡。renderKey 含剪切标记，任何一次重建都会带上。
  const isCut = state.cutAssetIds instanceof Set && state.cutAssetIds.has(asset.id);
  const entry = {
    id: asset.id,
    asset,
    renderKey: assetCardRenderKey(asset, selected),
    animateCard,
    markup: `<article class="asset-card${selected ? " selected" : ""}${isStack ? " is-stack" : ""}${state.scope === "trash" ? " is-trash" : ""}${isVideoAsset(asset) ? " is-video" : ""}${isCut ? " is-cut" : ""}${animateCard ? " card-enter" : ""}" data-id="${escapeHtml(asset.id)}"${isStack ? ` data-stack-id="${escapeHtml(asset.stack.id)}"` : ""} title="${escapeHtml(cardShortTitle(asset))}"><button class="asset-card-select" type="button" aria-pressed="${selected}" aria-label="${escapeHtml(label)}"${stackDescription}>${media}${stackBadge}${trashBadge}<span class="card-check" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 12.5 5 5 10-11"/></svg></span></button>${info}${cardActions}</article>`,
  };
  galleryCardVirtualEntries.set(entry.id, entry);
  return entry;
}

function buildRenderedGalleryCard(asset, ordinal, animateCard) {
  const entry = buildGalleryCardEntry(asset, ordinal, animateCard);
  const hydrateCard = shouldHydrateGalleryCard(entry, ordinal);
  if (hydrateCard) galleryCardVirtualHydratedIds.add(entry.id);
  else galleryCardVirtualHydratedIds.delete(entry.id);
  return hydrateCard ? entry : virtualGalleryCardEntry(entry);
}

// ===== Library Change 增量 DOM 提交 =====
// 只处理受影响卡片：更新=原位替换节点（保留 masonry 放置与虚拟化记账）；
// 插入/重定位=确保节点存在并按 state.assets 的最终顺序移动；删除=摘节点清
// 记账。最后 scheduleMasonryLayout() 全量重放置并级联 extent 同步、窗口剪枝
// 与挂载同步（rAF 合并，O(DOM 窗口) 而非 O(50k markup)）。
function commitIncrementalGalleryChanges(outcome) {
  const grid = els.assetGrid;
  const { updatedIds = [], removedIds = [], insertedIds = [], repositionIds = [] } = outcome || {};
  if (!grid || (!updatedIds.length && !removedIds.length && !insertedIds.length && !repositionIds.length)) return;
  const assetsById = new Map(state.assets.map((asset) => [asset.id, asset]));
  const changedIds = new Set();

  for (const id of updatedIds) {
    const asset = assetsById.get(id);
    const existingNode = asset ? galleryCardVirtualNode(grid, id) : null;
    if (!asset || !existingNode) continue;
    const ordinal = state.assets.indexOf(asset);
    const entry = buildGalleryCardEntry(asset, ordinal, false);
    const hydrate = galleryCardVirtualHydratedIds.has(id);
    const replacement = createAssetCardElements([hydrate ? entry : virtualGalleryCardEntry(entry)]).get(id);
    if (!replacement) continue;
    galleryCardVirtualObserver?.unobserve(existingNode);
    for (const property of ["gridColumnStart", "gridRowStart", "gridRowEnd"]) {
      if (existingNode.style[property]) replacement.style[property] = existingNode.style[property];
    }
    if (hydrate) {
      galleryCardVirtualHydratedIds.add(id);
    } else {
      releaseObservedGalleryMedia(existingNode);
      galleryCardVirtualHydratedIds.delete(id);
    }
    existingNode.replaceWith(replacement);
    galleryCardVirtualNodes.set(id, replacement);
    if (hydrate) {
      setupGalleryMediaVirtualization([replacement]);
      galleryCardVirtualObserver?.observe(replacement);
      scheduleMasonryLayout(replacement);
    }
    changedIds.add(id);
  }

  for (const id of removedIds) {
    const node = galleryCardVirtualNode(grid, id);
    if (node) {
      releaseObservedGalleryMedia(node);
      galleryCardVirtualObserver?.unobserve(node);
      node.remove();
    }
    galleryCardVirtualNodes.delete(id);
    galleryCardVirtualHydratedIds.delete(id);
    galleryCardVirtualEntries.delete(id);
    galleryCardVirtualSpanCache.delete(galleryVirtualSpanKey(id));
  }

  // 插入/重定位：确保 entry 与节点存在，随后立刻按最终顺序移动 DOM。
  // 参照物 = state.assets 中它之后第一张已在 DOM 的卡片；插入/移动后
  // 「grid 子元素相对顺序 = state.assets 相对顺序」的不变量保持成立。
  // 注意：新创建的节点尚未连接 DOM，绝不能经 galleryCardVirtualNode 二次
  // 解析（该 helper 会把未连接的缓存当陈旧条目删掉），必须直接使用本循环
  // 持有的引用。
  for (const id of [...insertedIds, ...repositionIds]) {
    const asset = assetsById.get(id);
    if (!asset) continue;
    const ordinal = state.assets.indexOf(asset);
    const entry = buildGalleryCardEntry(asset, ordinal, false);
    let node = galleryCardVirtualNode(grid, id);
    if (!node) {
      const hydrate = shouldHydrateGalleryCard(entry, ordinal);
      node = createAssetCardElements([hydrate ? entry : virtualGalleryCardEntry(entry)]).get(id);
      if (!node) continue;
      if (hydrate) {
        galleryCardVirtualHydratedIds.add(id);
        setupGalleryMediaVirtualization([node]);
        galleryCardVirtualObserver?.observe(node);
      } else {
        galleryCardVirtualHydratedIds.delete(id);
      }
      galleryCardVirtualNodes.set(id, node);
    }
    let reference = null;
    for (let index = ordinal + 1; index < state.assets.length; index += 1) {
      const sibling = galleryCardVirtualNode(grid, state.assets[index].id);
      if (sibling) { reference = sibling; break; }
    }
    if (!reference) {
      reference = grid.querySelector(":scope > .asset-load-more, :scope > .infinite-scroll-sentinel, :scope > .gallery-virtual-extent");
    }
    grid.insertBefore(node, reference || null);
    changedIds.add(id);
  }

  grid.dataset.loadedAssets = String(state.assets.length);
  invalidateCardGeometryCache();
  // 全量 placement 重建 geometry 两张表，并级联 extent 同步、窗口剪枝与挂载
  // 同步——插入卡片是否值得真实 DOM 由既有的视口窗口逻辑决定。
  scheduleMasonryLayout();
  updateViewTitle();
  gallerySelection.syncRenderedSelection({ prune: false, changedIds });
  if (state.viewMode === "asset") {
    // Viewer 打开期间画廊隐藏：仅记账，返回 Library 时补一次渲染。
    assetViewer.markGalleryDirty();
    updateAssetViewNav();
  }
}

// Viewer（大图查看模式）下的库变更语义（四十四）：session 序列保持稳定，
// 不插入/移除成员；当前查看的素材内容更新时刷新舞台；被删除的素材保留
// 展示（与全量刷新行为一致），导航时按失效 id 跳过。
function handleGalleryChangesInViewer(outcome, classified = null) {
  if (state.viewMode !== "asset") return;
  if (state.selectedId && classified?.assetEvents?.get(state.selectedId)?.kinds.has("updated")) {
    assetViewer.renderAssetView();
  }
  if (outcome && (outcome.insertedIds.length || outcome.removedIds.length || outcome.repositionIds.length)) {
    assetViewer.markGalleryDirty();
  }
}

/** Routed through the state machine so a later re-render cannot resurrect the skeleton. */
function renderErrorState(error, requestId = null, request = null) {
  state.galleryStatus = "error";
  state.galleryError = error instanceof Error ? error : new Error(String(error || ""));
  renderGrid();
  updateViewTitle();
  setGalleryBusy(false, requestId, request);
}

async function selectAsset(id, shouldScroll = false) {
  if (!id) return;
  if (id === state.selectedId) {
    updateSelectedCard();
    if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (!state.detailManuallyClosed && !state.detailOpen) setDetailOpen(true);
    return;
  }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(id)) return;
  // Phase 5B context guard：确认期间 Detail 选择已变化时安全取消，旧确认结果不操作新素材。
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  discardDetailDraft();
  state.selectedId = id; state.detailAsset = null; state.detailStack = null; state.versionHistory = null; state.recipeHistory = null; state.generationHistory = null;
  if (!state.detailManuallyClosed) setDetailOpen(true);
  updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function selectGalleryNode(id, shouldScroll = false) {
  const asset = state.assets.find((item) => item.id === id);
  if (!state.activeStackId && asset?.stack?.id) return selectStackNode(asset, shouldScroll);
  return selectAsset(id, shouldScroll);
}

let stackInspectorRequestSequence = 0;
async function loadStackInspectorMembers(stackId, coverAssetId, { showLoading = true } = {}) {
  const current = state.detailStack;
  if (!current || current.id !== stackId || state.selectedId !== coverAssetId) return false;
  const requestId = ++stackInspectorRequestSequence;
  if (showLoading) {
    state.detailStack = { ...current, loading: true, error: false };
    renderDetail();
  }
  try {
    const members = [];
    const seenCursors = new Set();
    let cursor = "";
    let total = state.detailStack.count;
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Stack inspector pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: state.project, limit: "250" });
      if (cursor) params.set("cursor", cursor);
      if (members.length) params.set("includeTotal", "0");
      const page = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`);
      if (requestId !== stackInspectorRequestSequence || state.selectedId !== coverAssetId || state.detailStack?.id !== stackId) return false;
      members.push(...(page.assets || []));
      if (page.page?.total != null) total = Number(page.page.total) || total;
      cursor = page.page?.nextCursor || "";
      if (!cursor) break;
    }
    state.detailStack = { ...state.detailStack, count: total || members.length, members, loading: false, error: false };
    renderDetail();
    return true;
  } catch {
    if (requestId !== stackInspectorRequestSequence || state.selectedId !== coverAssetId || state.detailStack?.id !== stackId) return false;
    state.detailStack = { ...state.detailStack, loading: false, error: true };
    renderDetail();
    return false;
  }
}

async function refreshSelectedStackInspector() {
  if (!state.detailStack || state.activeStackId) return false;
  const current = state.detailStack;
  const galleryNode = state.assets.find((asset) => asset.stack?.id === current.id);
  if (!galleryNode) {
    clearDetailSelection();
    renderDetail();
    return false;
  }
  state.selectedId = galleryNode.id;
  state.detailStack = {
    ...current,
    coverAssetId: galleryNode.id,
    count: Math.max(0, Number(galleryNode.stack?.count || current.count || 0)),
  };
  updateSelectedCard();
  return loadStackInspectorMembers(current.id, galleryNode.id, { showLoading: false });
}

async function selectStackNode(asset, shouldScroll = false) {
  const stackId = String(asset?.stack?.id || "");
  const coverAssetId = String(asset?.id || "");
  if (!stackId || !coverAssetId || state.activeStackId) return false;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(coverAssetId)) return false;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return false;
  discardDetailDraft();
  state.selectedId = coverAssetId;
  state.detailAsset = null;
  state.detailStack = {
    id: stackId,
    coverAssetId,
    count: Math.max(0, Number(asset.stack?.count || 0)),
    members: [],
    loading: true,
    error: false,
  };
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
  if (!state.detailManuallyClosed) setDetailOpen(true);
  updateSelectedCard();
  if (shouldScroll) els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(coverAssetId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (state.detailManuallyClosed) return true;
  renderDetail();
  // 选中到这里已经完成；成员列表在后台补（它自己收错误、自己核对是否过期）。
  // 不等它：右键选中堆叠封面（任务 111）要在选中完成后立刻弹菜单，不能被一次请求拖住。
  void loadStackInspectorMembers(stackId, coverAssetId, { showLoading: false });
  return true;
}

function clearDetailSelection() {
  stackInspectorRequestSequence += 1;
  state.selectedId = null;
  state.detailAsset = null;
  state.detailStack = null;
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
}

// ===== Inspector auto-save =====
// 检视器配方/参考图权利字段编辑停顿后自动 PATCH，消除"未保存修改时导航弹丢弃确认"的
// 摩擦。标签内联编辑器仍是 submit 即时保存（不改）。
let inspectorSaveTimer = null;
let inspectorSavePromise = null;
let activeInspector = null;
const INSPECTOR_AUTOSAVE_DELAY = 1200;

function scheduleInspectorSave() {
  if (!activeInspector?.panel?.isConnected) return;
  clearTimeout(inspectorSaveTimer);
  inspectorSaveTimer = setTimeout(() => {
    inspectorSaveTimer = null;
    void persistInspectorDraft(activeInspector.panel, activeInspector.asset, activeInspector.renderId);
  }, INSPECTOR_AUTOSAVE_DELAY);
}

function cancelInspectorSave() {
  clearTimeout(inspectorSaveTimer);
  inspectorSaveTimer = null;
}

function setInspectorAutosaveStatus(panel, kind) {
  panel?.querySelectorAll("[data-autosave-status]").forEach((node) => {
    if (kind === "saving") node.textContent = t("saving");
    else if (kind === "saved") node.textContent = t("autoSaved");
    // L1：失败必须落在面板状态位上（不只靠一闪而过的 Toast），dirty 仍保留可重试。
    else if (kind === "error") node.textContent = t("autoSaveFailed");
    else node.textContent = "";
  });
}

// Persist any dirty recipe/reference draft in one PATCH. Returns false on
// failure (dirty kept so a later edit/flush retries); the caller (navigation
// guards) treats false as "do not proceed" rather than silently dropping edits.
async function persistInspectorDraft(panel, asset, renderId) {
  const originProjectId = asset.project_id;
  const originAssetId = asset.id;
  if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return true;
  // An in-flight save owns the wire; reschedule and let it land first.
  if (inspectorSavePromise) { scheduleInspectorSave(); return true; }
  const recipeDirty = Boolean(panel.querySelector('[data-detail-dirty="true"][data-detail-dirty-scope="recipe"]'));
  const referenceDirty = Boolean(panel.querySelector('[data-reference-rights-section][data-reference-dirty="true"]'));
  if (!recipeDirty && !referenceDirty) { state.detailDirty = panelHasDirtyDraft(panel); return true; }
  setInspectorAutosaveStatus(panel, "saving");
  const run = (async () => {
    try {
      const currentAsset = latestAssetSnapshot(originProjectId, originAssetId, asset);
      const body = {};
      let sentRecipeSnapshot = null;
      let sentReferencesSnapshot = null;
      if (recipeDirty) {
        const recipeDraft = readRecipeDraft(panel);
        // 配方保存只读 [data-recipe-change]；说明为空时省略 recipe_change_summary
        //（服务端缺省 "Recipe updated"），不硬编码英文、不创建新版本。
        const changeSummary = panel.querySelector("[data-recipe-change]")?.value.trim() || "";
        Object.assign(body, recipeDraft, { tags: uniqueTags([...assetTags(currentAsset), ...derivePromptTags(recipeDraft)]) }, changeSummary ? { recipe_change_summary: changeSummary } : {});
        sentRecipeSnapshot = JSON.stringify([recipeDraft, changeSummary]);
      }
      if (referenceDirty) {
        const section = panel.querySelector("[data-reference-rights-section]");
        body.references = readReferenceRightsDraft(section, currentAsset);
        sentReferencesSnapshot = JSON.stringify(body.references);
      }
      const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(originAssetId)}`, { method: "PATCH", body });
      if (!isCurrentDetailAction(renderId, originProjectId, originAssetId)) return true;
      state.detailAsset = result.asset;
      const index = state.assets.findIndex((item) => item.id === originAssetId && item.project_id === originProjectId);
      if (index >= 0) state.assets[index] = result.asset;
      // PATCH 在途期间的新输入不在请求体里：只有当前草稿与发出时完全一致才清脏；
      // 有飞行期编辑则保留 dirty 标志并立即补存，否则导航冲刷会把可见编辑当
      // “无草稿”静默丢弃（面板显示已保存，服务器却缺最后几笔输入）。
      const flightEdits = draftChangedDuringFlight(panel, sentRecipeSnapshot, sentReferencesSnapshot);
      if (!flightEdits) {
        if (recipeDirty) clearDetailDirtyScope(panel, "recipe");
        if (referenceDirty) {
          const section = panel.querySelector("[data-reference-rights-section]");
          if (section) delete section.dataset.referenceDirty;
          state.detailDirty = panelHasDirtyDraft(panel);
        }
      }
      setInspectorAutosaveStatus(panel, "saved");
      if (flightEdits) scheduleInspectorSave();
      await loadStats();
      // 保存的素材就地 reconcile：卡片内容、排序位置（如改名）与视图归属
      // （如改分组后不再匹配当前 facet）由增量层处理，不重拉已加载窗口。
      await librarySync.applyLocalChanges([{
        kind: "asset-updated", entityType: "asset", entityId: originAssetId, flags: ["metadata"],
      }]).catch((error) => console.warn("Inspector reconcile failed:", error));
      return true;
    } catch (error) {
      showToast(error.message, "error");
      // Keep the dirty flags so the next edit or flush retries instead of losing data.
      setInspectorAutosaveStatus(panel, "error");
      return false;
    }
  })();
  inspectorSavePromise = run;
  try { return await run; } finally { inspectorSavePromise = null; }
}

// Flush a pending debounced save before navigation/switching. Awaits any
// in-flight PATCH, then runs once more if edits arrived during it.
async function flushInspectorSave() {
  cancelInspectorSave();
  if (inspectorSavePromise) await inspectorSavePromise;
  const ctx = activeInspector;
  if (!ctx?.panel?.isConnected || !panelHasDirtyDraft(ctx.panel)) return true;
  return persistInspectorDraft(ctx.panel, ctx.asset, ctx.renderId);
}

async function confirmDetailNavigation() {
  // 自动保存：导航/切换前冲刷挂起的草稿；失败则返回 false 阻断导航（不静默丢数据）。
  // version/tags 作用域是手动保存语义（没有自动保存兜底）：存在未提交草稿时先显式
  // 确认丢弃，避免点开另一张卡片/关掉 Inspector 就无声清掉已写的变更说明或新标签。
  if (hasManualSaveDraft()) {
    const confirmed = await requestConfirmation({
      title: t("discardChangesTitle"),
      description: t("discardChangesDescription"),
      confirmLabel: t("discardChangesAction"),
      tone: "danger",
    });
    if (!confirmed) return false;
  }
  return flushInspectorSave();
}

// 手动保存作用域（version=另存为新版本的变更说明，tags=标签编辑器输入）的未提交
// 草稿。recipe/reference 由自动保存冲刷兜底，不在此弹确认。
function hasManualSaveDraft() {
  const panel = els.detailPanel;
  if (!panel?.isConnected || !state.detailOpen) return false;
  return Boolean(panel.querySelector('[data-detail-dirty="true"][data-detail-dirty-scope="version"], [data-detail-dirty="true"][data-detail-dirty-scope="tags"]'));
}

function discardDetailDraft() {
  cancelInspectorSave();
  state.detailDirty = false;
  els.detailPanel?.querySelectorAll('[data-detail-dirty="true"]').forEach((field) => {
    delete field.dataset.detailDirty;
    delete field.dataset.detailDirtyScope;
  });
  const rights = els.detailPanel?.querySelector('[data-reference-rights-section][data-reference-dirty="true"]');
  if (rights) delete rights.dataset.referenceDirty;
}

// navigation: true 用于进出堆叠这类程序化导航——关闭检视器但不算「用户手动
// 关闭」，否则之后选中卡片不再自动打开检视器（54-5）。
async function closeDetailSurface({ navigation = false } = {}) {
  if (!await confirmDetailNavigation(null)) return false;
  discardDetailDraft();
  if (state.viewMode === "asset") returnToLibrary();
  else {
    if (!navigation) state.detailManuallyClosed = true;
    setDetailOpen(false, { allowDockedClose: true });
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId && asset.project_id === state.project)) clearDetailSelection();
  }
  return true;
}

function openDetailSurfaceManually() {
  state.detailManuallyClosed = false;
  setDetailOpen(true);
  const stackDetail = state.detailStack?.coverAssetId === state.selectedId ? state.detailStack : null;
  if (stackDetail?.loading && stackDetail.id && state.selectedId) {
    void loadStackInspectorMembers(stackDetail.id, state.selectedId, { showLoading: false });
  }
}

function selectedAsset() {
  return state.assets.find((asset) => asset.id === state.selectedId)
    || (state.detailAsset?.id === state.selectedId ? state.detailAsset : null)
    || state.versionHistory?.versions?.find((asset) => asset.id === state.selectedId)
    || null;
}

let lastSelectedCardId = null;
function updateSelectedCard() {
  if (!els.assetGrid) return;
  const ids = new Set([lastSelectedCardId, state.selectedId].filter(Boolean));
  for (const id of ids) {
    const card = els.assetGrid.querySelector(`:scope > .asset-card[data-id="${CSS.escape(id)}"]`);
    if (!card) continue;
    const selected = id === state.selectedId;
    const multiSelected = Boolean(state.selectedIds?.has(id));
    card.classList.toggle("selected", selected);
    card.querySelector(".asset-card-select")?.setAttribute("aria-pressed", String(selected || multiSelected));
  }
  lastSelectedCardId = state.selectedId || null;
}
function setDetailOpen(open, { allowDockedClose = false } = {}) {
  const wasOpen = state.detailOpen;
  state.detailOpen = Boolean(open);
  if (!state.detailOpen && isInspectorDocked() && !allowDockedClose) state.detailOpen = true;
  els.appShell?.classList.toggle("details-open", state.detailOpen); document.body.classList.toggle("detail-open", state.detailOpen); els.detailPanel?.setAttribute("aria-hidden", String(!state.detailOpen));
  if (els.openInspectorBtn) els.openInspectorBtn.hidden = state.detailOpen;
  // The inspector shell is persistent while browsing assets. Scope the materialize
  // animation to a real closed -> open transition so changing the selected asset
  // never replays a full-panel fade/translate animation.
  els.detailPanel?.classList.toggle("detail-entering", state.detailOpen && !wasOpen);
  if (state.detailOpen) setMobileNavOpen(false);
  // GravityPort A3：检视器开关改变画廊内容宽 → 列数与滑杆组可见性都要重算。
  syncGalleryColumns();
  syncGallerySizeGroupVisibility();
  // 任务 96 返工 2：隐藏窗口（e2e/CI）把 rAF 攒帧批量执行，开合引发的列数/
  // masonry/滚动条变化可能分多帧落地；行内 left 在两帧后再幂等重算一次（值
  // 不变时零副作用），保证收尾几何下滑杆组必在正确位置，不押任何单次帧回调。
  requestAnimationFrame(() => requestAnimationFrame(syncGallerySizeGroupVisibility));
  if (state.detailOpen) {
    if (!wasOpen) {
      const activeEl = document.activeElement;
      state.detailReturnFocus = (activeEl instanceof HTMLElement && activeEl.isConnected) ? activeEl : null;
      state.detailReturnFocusAssetId = activeEl?.closest?.(".asset-card")?.dataset.id || state.selectedId || null;
    }
    const selected = selectedAsset();
    const sameRenderedAsset = Boolean(selected && detailRenderedAssetId === selected.id);
    if (!wasOpen || !sameRenderedAsset || !isDetailEditorActive()) renderDetail();
    // Focus moves only on the closed -> open transition: arrow-key gallery
    // navigation keeps calling setDetailOpen(true) while the drawer is already
    // open, and yanking focus into the drawer each time would break it.
    // Focus synchronously rather than in requestAnimationFrame, which never
    // runs while the window is hidden or frame-throttled.
    if (!wasOpen) els.detailPanel?.querySelector("#detailTitle")?.focus();
  } else {
    // GravityPort A4a：检视器关闭时浮层一并关闭（不还焦点给「查看」——焦点走
    // 检视器既有的 detailReturnFocus 链）。
    inspectorOverlay.close({ restoreFocus: false });
    const returnEl = state.detailReturnFocus;
    const returnAssetId = state.detailReturnFocusAssetId;
    state.detailReturnFocus = null;
    state.detailReturnFocusAssetId = null;
    if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus({ preventScroll: true });
    else {
      const replacement = returnAssetId
        ? els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(returnAssetId)}"] .asset-card-select`)
        : null;
      if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
      else els.assetGrid?.focus({ preventScroll: true });
    }
  }
}

// ===== Asset view（大图查看器，已提取至 asset-view.mjs，R1 批次 4）=====

// 全应用唯一的“浮层打开中”判定：确认框、建组/分组统计、堆叠重命名、设置、
// 大图预览。粘贴导入、⌘A/⌘V、/、Enter 进大图、画廊方向键等后台快捷键守卫
// 一律以这里为准，不许各自维护手写清单。except 传入口自身的浮层名，用于
// “打开前查重”类调用（如 openGroupModal 查 "group"）。
function hasBlockingOverlay(except = "") {
  return [
    ["confirm", Boolean(confirmDialogState.pending)],
    ["group", Boolean(els.groupModal?.classList.contains("open")) || Boolean(els.groupStatsModal?.classList.contains("open"))],
    ["rename", Boolean(els.stackRenameModal?.classList.contains("open"))],
    ["settings", Boolean(els.settingsMenu && !els.settingsMenu.hidden)],
    ["preview", Boolean(els.imagePreviewModal && !els.imagePreviewModal.hidden)],
    // GravityPort A4a：检视器浮层（参考图/版本树）打开时全局快捷键一并静默。
    ["gpOverlay", inspectorOverlay.isOpen()],
  ].some(([name, open]) => name !== except && open);
}
function openSettingsModal() {
  if (!els.settingsMenu || !els.settingsMenu.hidden || hasBlockingOverlay("settings")) return;
  state.settingsReturnFocus = document.activeElement;
  // Settings is rendered on demand so library path/stat changes that landed
  // after startup are always reflected when the user opens this single panel.
  // A pending debounced sync (from a burst of Visual Pack status ticks) is
  // flushed here so the freshly opened dialog is always up to date.
  if (settingsSyncTimer) {
    clearTimeout(settingsSyncTimer);
    settingsSyncTimer = null;
    settingsSyncScheduled = false;
  }
  renderSettingsMenu();
  void refreshVisualModelStatus({ force: true });
  els.settingsMenu.hidden = false;
  els.settingsToggle?.setAttribute("aria-expanded", "true");
  void refreshBridgeStatus();
  requestAnimationFrame(() => els.settingsMenu?.querySelector(".settings-modal-card")?.focus());
}
function closeSettingsModal({ restoreFocus = true } = {}) {
  if (!els.settingsMenu || els.settingsMenu.hidden) return;
  els.settingsMenu.hidden = true;
  els.settingsToggle?.setAttribute("aria-expanded", "false");
  // Cancel any pending debounced Settings sync: the dialog is hidden, so the
  // scheduled innerHTML rebuild has no UI effect and only spends CPU cycles.
  if (settingsSyncTimer) {
    clearTimeout(settingsSyncTimer);
    settingsSyncTimer = null;
    settingsSyncScheduled = false;
  }
  const returnTarget = state.settingsReturnFocus;
  if (restoreFocus && returnTarget instanceof HTMLElement && returnTarget.isConnected) {
    // ≤767px 时「设置」按钮在移动端抽屉里，打开设置时抽屉已收起并 inert，
    // 焦点落不回去；改还给打开抽屉的菜单按钮。
    (returnTarget.closest("[inert]") ? els.mobileNavToggle : returnTarget)?.focus();
  }
  state.settingsReturnFocus = null;
}
function toggleSettingsModal() { if (els.settingsMenu?.hidden) openSettingsModal(); else closeSettingsModal(); }

const GROUP_COLORS = ["#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#ec4899"];

function groupColorStorageKey() { return `mosa.group-colors.${state.project}`; }
function groupColorMap() {
  try {
    const parsed = JSON.parse(safeStorageGet(groupColorStorageKey()) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function deterministicGroupColor(name) {
  let hash = 0;
  for (const character of String(name || "")) hash = ((hash << 5) - hash + character.codePointAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length];
}
function serverGroupColor(name) {
  const record = (Array.isArray(state.groups?.groups) ? state.groups.groups : [])
    .find((group) => group.name === name);
  return GROUP_COLORS.includes(record?.color) ? record.color : "";
}
function colorForGroup(name) {
  // Server record first, then the local palette cache (offline fallback and
  // the pre-color-API era), finally the deterministic swatch.
  const server = serverGroupColor(name);
  if (server) return server;
  const stored = groupColorMap()[name];
  return GROUP_COLORS.includes(stored) ? stored : deterministicGroupColor(name);
}
function saveGroupColor(name, color) {
  const colors = groupColorMap();
  colors[name] = GROUP_COLORS.includes(color) ? color : deterministicGroupColor(name);
  safeStorageSet(groupColorStorageKey(), JSON.stringify(colors));
}
/** Persists a swatch choice to the server (single source of truth) while
 * keeping the localStorage cache warm for offline rendering. */
function persistGroupColor(name, color) {
  saveGroupColor(name, color);
  void apiFetch(`/api/groups/${encodeURIComponent(name)}`, {
    method: "PATCH",
    body: { projectId: state.project, color },
  }).then(() => loadStats({ background: true })).catch(() => {
    // Offline / legacy store: the localStorage cache written above still
    // renders the choice locally.
  });
}
function cycleGroupColor(name, currentColor) {
  const index = GROUP_COLORS.indexOf(currentColor);
  return GROUP_COLORS[(index + 1 + GROUP_COLORS.length) % GROUP_COLORS.length];
}
function selectGroupColor(color) {
  if (!GROUP_COLORS.includes(color)) return;
  els.groupModal?.querySelectorAll("[data-group-color]").forEach((button) => {
    const selected = button.dataset.groupColor === color;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}
function selectedGroupColor() {
  return els.groupModal?.querySelector("[data-group-color][aria-pressed='true']")?.dataset.groupColor || GROUP_COLORS[0];
}
// 建组即分配：从“移动到分组 → 新建分组”打开时暂存回调，创建成功后把
// 当时选中的素材移入新组。回调自带选中上下文校验，失败只提示不影响建组结果。
let pendingGroupCreated = null;
function openGroupModal({ onCreated } = {}) {
  if (state.groupSaving || hasBlockingOverlay("group")) return;
  state.modalReturnFocus = document.activeElement;
  pendingGroupCreated = typeof onCreated === "function" ? onCreated : null;
  els.groupModal?.classList.add("open");
  els.groupModal?.setAttribute("aria-hidden", "false");
  if (els.groupNameInput) els.groupNameInput.value = "";
  selectGroupColor(GROUP_COLORS[0]);
  requestAnimationFrame(() => els.groupNameInput?.focus());
}
function setGroupBusy(busy) {
  state.groupSaving = busy;
  if (els.saveGroupBtn) { els.saveGroupBtn.disabled = busy; els.saveGroupBtn.setAttribute("aria-busy", String(busy)); }
  if (els.closeGroupModal) els.closeGroupModal.disabled = busy;
  if (els.cancelGroupBtn) els.cancelGroupBtn.disabled = busy;
  if (els.groupNameInput) els.groupNameInput.disabled = busy;
  els.groupModal?.querySelectorAll("[data-group-color]").forEach((button) => { button.disabled = busy; });
}
function closeGroupModal({ force = false } = {}) {
  if (state.groupSaving && !force) return false;
  pendingGroupCreated = null;
  els.groupModal?.classList.remove("open");
  els.groupModal?.setAttribute("aria-hidden", "true");
  if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
  return true;
}

// ===== Stack 重命名（右键堆叠 → 重命名）=====
// Promise 式单一输入收集器，与 ConfirmDialog 同款“单 pending”策略：已有弹窗时
// 新请求直接返回 null，两个调用方绝不共享同一个 resolver。名称校验（trim、
// 非空）在此拦截，持久化由调用方注入的 onSubmit 完成并返回是否成功。
const stackRenameState = { pending: false, resolve: null, saving: false, onSubmit: null };
function setStackRenameBusy(busy) {
  stackRenameState.saving = busy;
  if (els.saveStackRenameBtn) { els.saveStackRenameBtn.disabled = busy; els.saveStackRenameBtn.setAttribute("aria-busy", String(busy)); }
  if (els.stackRenameModalClose) els.stackRenameModalClose.disabled = busy;
  if (els.cancelStackRenameBtn) els.cancelStackRenameBtn.disabled = busy;
  if (els.stackRenameModalInput) els.stackRenameModalInput.disabled = busy;
}
function openStackRenameModal({ initialValue = "", confirmLabel = "", onSubmit } = {}) {
  if (stackRenameState.pending || hasBlockingOverlay("rename")) return Promise.resolve(null);
  state.modalReturnFocus = document.activeElement;
  stackRenameState.pending = true;
  stackRenameState.onSubmit = typeof onSubmit === "function" ? onSubmit : null;
  if (els.stackRenameModalTitle) els.stackRenameModalTitle.textContent = t("renameStackTitle");
  if (els.saveStackRenameBtn) els.saveStackRenameBtn.textContent = confirmLabel || t("renameStack");
  if (els.stackRenameModalInput) els.stackRenameModalInput.value = initialValue;
  els.stackRenameModal?.classList.add("open");
  els.stackRenameModal?.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => { els.stackRenameModalInput?.focus(); els.stackRenameModalInput?.select(); });
  return new Promise((resolve) => { stackRenameState.resolve = resolve; });
}
function closeStackRenameModal({ force = false } = {}) {
  if (stackRenameState.saving && !force) return false;
  if (!stackRenameState.pending) return false;
  const { resolve } = stackRenameState;
  stackRenameState.pending = false;
  stackRenameState.resolve = null;
  stackRenameState.onSubmit = null;
  els.stackRenameModal?.classList.remove("open");
  els.stackRenameModal?.setAttribute("aria-hidden", "true");
  if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
  if (resolve) resolve(null);
  return true;
}
async function saveStackRename() {
  if (!stackRenameState.pending || stackRenameState.saving) return;
  const value = els.stackRenameModalInput?.value.trim() || "";
  if (!value) { showToast(t("stackNameRequired"), "error"); return; }
  const onSubmit = stackRenameState.onSubmit;
  setStackRenameBusy(true);
  try {
    // onSubmit 返回 false 表示提交失败（错误已由其内部 toast 呈现），保持弹窗
    // 打开让用户修改；其余结果（含无回调）视为已处理并关闭。
    const succeeded = await onSubmit?.(value);
    if (succeeded !== false) closeStackRenameModal({ force: true });
  } finally {
    setStackRenameBusy(false);
  }
}

// ===== 分组统计（右键分组 → 分组统计；GET /api/groups/:name/stats）=====
function groupStatsFacetMarkup(entries = []) {
  if (!entries.length) return `<span class="empty-copy">${escapeHtml(t("notRecorded"))}</span>`;
  return `<div class="group-stats-tags">${entries.map(([name, count]) => `<span class="group-stats-tag">${escapeHtml(name)}<em>${Number(count || 0)}</em></span>`).join("")}</div>`;
}

function groupStatsMarkup(stats = {}) {
  const rows = [
    [t("groupStatsMembers"), Number(stats.total || 0)],
    [t("groupStatsFavorites"), Number(stats.favorites || 0)],
    [t("groupStatsImages"), Number(stats.images || 0)],
    [t("groupStatsVideos"), Number(stats.videos || 0)],
    [t("groupStatsVersions"), Number(stats.versionChildren || 0)],
    [t("groupStatsTrashed"), Number(stats.trashed || 0)],
  ];
  return `
    <div class="group-stats-overview">${rows.map(([label, value]) => `<div class="group-stats-cell"><strong>${value}</strong><span>${escapeHtml(label)}</span></div>`).join("")}</div>
    <div class="group-stats-facet"><h4>${escapeHtml(t("groupStatsByCategory"))}</h4>${groupStatsFacetMarkup(stats.categories)}</div>
    <div class="group-stats-facet"><h4>${escapeHtml(t("groupStatsBySource"))}</h4>${groupStatsFacetMarkup(stats.sources)}</div>`;
}

async function showGroupStats(groupName) {
  const name = String(groupName || "").trim();
  if (!name || hasBlockingOverlay("group")) return;
  const color = colorForGroup(name);
  if (els.groupStatsBody) els.groupStatsBody.innerHTML = `<p class="empty-copy">${escapeHtml(t("refreshing"))}</p>`;
  state.modalReturnFocus = document.activeElement;
  els.groupStatsModal?.classList.add("open");
  els.groupStatsModal?.setAttribute("aria-hidden", "false");
  const title = els.groupStatsModal?.querySelector("#groupStatsTitle");
  if (title) title.innerHTML = `<span class="nav-group-dot" data-group-color="${escapeHtml(color)}" aria-hidden="true"></span>${escapeHtml(t("groupStatsTitleLabel", { group: name }))}`;
  requestAnimationFrame(() => els.closeGroupStatsModal?.focus());
  try {
    const result = await apiFetch(`/api/groups/${encodeURIComponent(name)}/stats?project=${encodeURIComponent(state.project)}`);
    if (els.groupStatsBody) els.groupStatsBody.innerHTML = groupStatsMarkup(result?.stats || {});
  } catch (error) {
    if (els.groupStatsBody) els.groupStatsBody.innerHTML = `<p class="empty-copy">${escapeHtml(error?.message || t("loadFailed"))}</p>`;
  }
}

function closeGroupStatsModal() {
  els.groupStatsModal?.classList.remove("open");
  els.groupStatsModal?.setAttribute("aria-hidden", "true");
  if (state.modalReturnFocus instanceof HTMLElement) state.modalReturnFocus.focus();
  state.modalReturnFocus = null;
}

function trapGroupStatsModalFocus(event) {
  if (event.defaultPrevented) return;
  if (!els.groupStatsModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeGroupStatsModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.groupStatsModal.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault(); focusable[next].focus();
}

function trapSettingsModalFocus(event) {
  if (event.defaultPrevented) return;
  if (els.settingsMenu?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeSettingsModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.settingsMenu.querySelectorAll("button:not([disabled]):not([tabindex='-1']), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.closest("[hidden]"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault();
  focusable[next].focus();
}

function trapGroupModalFocus(event) {
  if (event.defaultPrevented) return;
  if (!els.groupModal?.classList.contains("open")) return;
  if (event.key === "Escape") { event.preventDefault(); closeGroupModal(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.groupModal.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return; const current = focusable.indexOf(document.activeElement); const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1); event.preventDefault(); focusable[next].focus();
}

async function saveGroup() {
  if (state.groupSaving) return;
  const name = els.groupNameInput?.value.trim() || "";
  if (!name) { showToast(t("groupNameRequired"), "error"); return; }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  const hadDetailDraft = state.detailDirty;
  const onCreated = pendingGroupCreated;
  // 防重窗口先于草稿冲刷的网络往返打开，冲刷期间双击不重复建组。
  setGroupBusy(true);
  try {
    if (hadDetailDraft && !await confirmDetailNavigation(null)) return;
    await runAction(async () => {
      const result = await apiFetch("/api/groups", {
        method: "POST",
        body: { projectId: originProjectId, name, color: selectedGroupColor() },
      });
      if (hadDetailDraft && originProjectId === state.project && originAssetId === state.selectedId) discardDetailDraft();
      saveGroupColor(result.group.name, selectedGroupColor());
      closeGroupModal({ force: true });
      await loadStats();
      showToast(`${t("groupCreated")}${result.group.name}`, "success");
      // “来源”已是当前侧栏的唯一自动分组入口；创建自定义分组不应把用户瞬间
      // 导航到一个尚无素材的空分组。保留当前画廊上下文，新分组会立即出现在
      // 素材右键的“移动到分组”子菜单中。
      clearDetailSelection();
      renderQuickFilters();
      // 建组即分配（从“移动到分组 → 新建分组”进入时）：把打开弹窗时选中的
      // 素材移入新组。回调内部自带选中上下文时效校验。
      if (onCreated) await onCreated(result.group.name);
    });
  } finally {
    setGroupBusy(false);
  }
}

let imagePreviewCleanupTimer = null;
let imagePreviewCleanupHandler = null;

function cancelPendingImagePreviewCleanup() {
  if (imagePreviewCleanupTimer !== null) {
    window.clearTimeout(imagePreviewCleanupTimer);
    imagePreviewCleanupTimer = null;
  }
  if (imagePreviewCleanupHandler && els.imagePreviewModal) {
    els.imagePreviewModal.removeEventListener("transitionend", imagePreviewCleanupHandler);
    imagePreviewCleanupHandler = null;
  }
}

function finalizeImagePreviewClose() {
  cancelPendingImagePreviewCleanup();
  if (!els.imagePreviewModal?.hidden) return;
  els.imagePreviewImage?.removeAttribute("src");
  els.imagePreviewImage.hidden = false;
  els.imagePreviewVideo?.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  resetImageZoom();
  els.imagePreviewImage?.style.removeProperty("width");
  els.imagePreviewImage?.style.removeProperty("height");
  els.imagePreviewStage?.classList.remove("zoomed", "dragging");
  els.imagePreviewStage?.setAttribute("aria-label", t("imagePreviewStage"));
}

function scheduleImagePreviewCleanup() {
  cancelPendingImagePreviewCleanup();
  const modal = els.imagePreviewModal;
  if (!modal?.hidden) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    finalizeImagePreviewClose();
    return;
  }
  const finish = (event) => {
    if (event && (event.target !== modal || event.propertyName !== "opacity")) return;
    finalizeImagePreviewClose();
  };
  imagePreviewCleanupHandler = finish;
  modal.addEventListener("transitionend", finish);
  // Transition events can be skipped when a window is hidden or throttled.
  // Keep cleanup bounded without making the visual path timer-driven.
  imagePreviewCleanupTimer = window.setTimeout(() => finish(), 260);
}

function openImagePreview(id, trigger) {
  if (hasBlockingOverlay("preview")) return;
  const asset = state.assets.find((item) => item.id === id)
    || state.versionHistory?.versions?.find((item) => item.id === id)
    || (state.detailAsset?.id === id ? state.detailAsset : null);
  if (!asset || !els.imagePreviewModal || !els.imagePreviewImage || !els.imagePreviewVideo || !els.imagePreviewTitle) return;
  cancelPendingImagePreviewCleanup();
  state.imagePreviewId = asset.id;
  resetImageZoom();
  state.previewReturnFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  state.previewReturnFocusAssetId = trigger?.closest?.(".asset-card")?.dataset.id || asset.id;
  els.imagePreviewTitle.textContent = displayAssetTitle(asset);
  els.imagePreviewStage?.setAttribute("aria-label", `${t("imagePreviewStage")}: ${els.imagePreviewTitle.textContent}`);
  if (isVideoAsset(asset)) {
    els.imagePreviewImage.hidden = true;
    els.imagePreviewImage.removeAttribute("src");
    els.imagePreviewVideo.hidden = false;
    els.imagePreviewVideo.src = asset.image_url;
    els.imagePreviewModal.hidden = false;
    requestAnimationFrame(() => els.closeImagePreview?.focus());
    return;
  }
  els.imagePreviewVideo.pause();
  els.imagePreviewVideo.removeAttribute("src");
  els.imagePreviewVideo.hidden = true;
  els.imagePreviewImage.hidden = false;
  els.imagePreviewImage.style.removeProperty("width");
  els.imagePreviewImage.style.removeProperty("height");
  els.imagePreviewImage.src = asset.preview_url || asset.image_url;
  els.imagePreviewImage.alt = displayAssetTitle(asset);
  els.imagePreviewModal.hidden = false;
  requestAnimationFrame(fitImagePreview);
  requestAnimationFrame(() => els.closeImagePreview?.focus());
}

function fitImagePreview() {
  const image = els.imagePreviewImage;
  const stage = els.imagePreviewStage;
  if (!state.imagePreviewId || !image?.naturalWidth || !image.naturalHeight || !stage) return;
  const styles = getComputedStyle(stage);
  const availableWidth = stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
  const availableHeight = stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
  const scale = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight);
  image.style.width = `${Math.floor(image.naturalWidth * scale)}px`;
  image.style.height = `${Math.floor(image.naturalHeight * scale)}px`;
  reconcileImagePreviewTransform();
}

function closeImagePreview() {
  if (!els.imagePreviewModal || els.imagePreviewModal.hidden) return;
  els.imagePreviewModal.hidden = true;
  els.imagePreviewVideo?.pause();
  state.imagePreviewId = null;
  const returnEl = state.previewReturnFocus;
  const returnAssetId = state.previewReturnFocusAssetId;
  if (returnEl instanceof HTMLElement && returnEl.isConnected) returnEl.focus({ preventScroll: true });
  else if (state.viewMode === "asset" && els.assetViewBack instanceof HTMLElement) els.assetViewBack.focus({ preventScroll: true });
  else {
    const replacement = returnAssetId
      ? els.assetGrid?.querySelector(`.asset-card[data-id="${CSS.escape(returnAssetId)}"] .asset-card-select`)
      : null;
    if (replacement instanceof HTMLElement) replacement.focus({ preventScroll: true });
    else els.assetGrid?.focus({ preventScroll: true });
  }
  state.previewReturnFocus = null;
  state.previewReturnFocusAssetId = null;
  scheduleImagePreviewCleanup();
}

function trapImagePreviewFocus(event) {
  if (event.defaultPrevented) return;
  if (els.imagePreviewModal?.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeImagePreview(); return; }
  if (event.key !== "Tab") return;
  const focusable = [...els.imagePreviewModal.querySelectorAll("button:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => !element.hasAttribute("hidden"));
  if (!focusable.length) return;
  const current = focusable.indexOf(document.activeElement);
  const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
  event.preventDefault(); focusable[next].focus();
}

let detailRenderSequence = 0;
// Phase 4A：单栏检视器滚动策略——同素材重渲染（语言切换/后台刷新/收藏）保留滚动
// 位置；切换到另一素材（Viewer Previous/Next、画廊选择）显式回顶；检视器 shell 常驻，
// 只替换唯一滚动列的内容，避免切图时整栏 DOM 销毁/重建和入场动画重播；
// Phase 4B 起版本切换由 selectDetailVersion 在重建后显式钳制恢复滚动位置。焦点原本
// 在面板内时焦点恢复优先（浏览器会把聚焦的 #detailTitle 滚入视野）。
let detailRenderedAssetId = null;

function ensureDetailInspectorShell() {
  let inspector = els.detailPanel?.querySelector(":scope > .detail-inspector");
  if (!inspector && els.detailPanel) {
    // GravityPort A4a：外壳追加两个持久槽——底部「素材路径」胶囊（不随内容滚动，
    // 内容由 renderDetailPathbar 按素材填充）与浮层容器（参考图 / 版本树共用，
    // 内容由 renderDetailOverlays 填充；hidden 切换开合，见 inspector-overlay.mjs）。
    els.detailPanel.innerHTML = `<div class="detail-inspector"><div class="detail-inspector-header"><span data-detail-header-label></span><button class="detail-close" type="button" data-action="close-detail" aria-label="${t("close")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="detail-inspector-scroll"></div><div class="detail-pathbar" data-detail-pathbar hidden></div><div class="gp-inspector-overlay" data-gp-overlay role="dialog" aria-modal="true" aria-labelledby="gpInspectorOverlayTitle" tabindex="-1" hidden><div class="gp-inspector-overlay-card"><div class="gp-inspector-overlay-head"><h3 id="gpInspectorOverlayTitle" data-gp-overlay-title></h3><button class="gp-inspector-overlay-close" type="button" data-action="close-inspector-overlay" aria-label="${t("close")}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="gp-inspector-overlay-body" data-gp-overlay-body="reference" hidden></div><div class="gp-inspector-overlay-body" data-gp-overlay-body="version" hidden></div></div></div></div>`;
    inspector = els.detailPanel.querySelector(":scope > .detail-inspector");
    inspector?.querySelector('[data-action="close-detail"]')?.addEventListener("click", () => { void closeDetailSurface(); });
    inspector?.querySelector("[data-detail-pathbar]")?.addEventListener("click", (event) => {
      const button = event.target.closest?.('[data-action="open-asset-location"]');
      if (button) revealAssetAtPath(button.dataset.assetPath || "");
    });
    inspector?.querySelector("[data-gp-overlay]")?.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-action='close-inspector-overlay']")) inspectorOverlay.close();
    });
  }
  const scroller = inspector?.querySelector(".detail-inspector-scroll") || null;
  const headerLabel = inspector?.querySelector("[data-detail-header-label]") || null;
  const closeButton = inspector?.querySelector('[data-action="close-detail"]') || null;
  const pathbar = inspector?.querySelector("[data-detail-pathbar]") || null;
  return { inspector, scroller, headerLabel, closeButton, pathbar };
}

function renderDetailInspectorContent(headerText, markup) {
  const { scroller, headerLabel, closeButton } = ensureDetailInspectorShell();
  if (!scroller || !headerLabel) return null;
  headerLabel.textContent = headerText;
  headerLabel.title = "";
  headerLabel.classList.remove("is-contextual");
  closeButton?.setAttribute("aria-label", t("close"));
  // bindDetailHeaderContext owns this slot for asset details. Clearing it here
  // prevents persistent-shell renders from accumulating stale scroll handlers.
  scroller.onscroll = null;
  scroller.innerHTML = markup;
  return scroller;
}

function renderDetail({ syncAssetView = true } = {}) {
  if (!els.detailPanel) return;
  // Replacing inspector content destroys its inputs; cancel a pending debounced
  // save so it cannot fire against the fresh content. An in-flight PATCH is left to resolve
  // and bail via the stale renderId guard inside persistInspectorDraft.
  cancelInspectorSave();
  activeInspector = null;
  const renderId = ++detailRenderSequence;
  const stackDetail = state.detailStack?.coverAssetId === state.selectedId ? state.detailStack : null;
  const asset = selectedAsset();
  // Re-rendering replaces the whole panel, so a focus that lived inside it
  // would fall back to <body>. Arrow-key gallery browsing re-renders on every
  // step; keep the keyboard anchored on the detail title instead.
  const hadPanelFocus = document.activeElement instanceof HTMLElement && els.detailPanel.contains(document.activeElement);
  if (stackDetail) {
    const previousRenderedId = detailRenderedAssetId;
    detailRenderedAssetId = `stack:${stackDetail.id}`;
    // 堆叠检视器不带素材路径栏；素材浮层随进出堆叠自动关闭。
    inspectorOverlay.close({ restoreFocus: false });
    const { pathbar } = ensureDetailInspectorShell();
    if (pathbar) pathbar.hidden = true;
    const scroller = renderDetailInspectorContent(t("stackInspectorTitle"), stackInspectorMarkup(stackDetail));
    if (scroller && previousRenderedId !== detailRenderedAssetId) scroller.scrollTop = 0;
    bindStackInspectorMediaFallbacks(els.detailPanel);
    return;
  }
  const keepScrollTop = !hadPanelFocus && asset && detailRenderedAssetId === asset.id
    ? els.detailPanel.querySelector(".detail-inspector-scroll")?.scrollTop ?? null
    : null;
  if (!asset) {
    detailRenderedAssetId = null;
    inspectorOverlay.close({ restoreFocus: false });
    const { pathbar } = ensureDetailInspectorShell();
    if (pathbar) pathbar.hidden = true;
    const scroller = renderDetailInspectorContent(t("assetInspector"), `<div class="detail-empty"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><p>${t("noSelection")}</p><span>${t("noSelectionHint")}</span></div>`);
    if (scroller) scroller.scrollTop = 0;
    return;
  }
  // 任务 35：「+N」展开状态只跟随当前素材——换素材渲染（首次打开/从别的素材或空态
  // 切回来）回到折叠；同素材重渲染（detailRenderedAssetId === asset.id）保留现状。
  if (detailRenderedAssetId !== asset.id) {
    state.detailTagsExpanded = false;
    // GravityPort A4a：切换素材时浮层自动关闭（同素材重渲染——收藏/自动保存刷新
    // ——不打断，浮层内容随本次渲染整体重建）。
    inspectorOverlay.close({ restoreFocus: false });
  }
  const cachedHistory = versionHistoryForAsset(asset);
  const cachedRecipeHistory = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  const cachedGenerationHistory = generationHistoryForAsset(asset);
  // Library v2 保持单层详情容器：语义区块直接进入唯一滚动列，不再额外包卡片壳。
  // GravityPort A4a 区块序：头部(file) → 标签(tags) → 色板(palette) → 提示词(prompt)
  // → 参考图(reference) → 版本树与上下文(version)。配方编辑/来源信息/独立分组/
  // 图片位置/独立版本区块已从界面拿掉（helper 保留实现）。
  const scroller = renderDetailInspectorContent(t("assetInspector"), `${detailFileSectionMarkup(asset)}${detailTagsSectionMarkup(asset)}${detailPaletteSectionMarkup(asset)}${detailPromptSectionMarkup(asset)}${detailReferenceSectionMarkup(asset)}${detailVersionContextSectionMarkup(asset, cachedGenerationHistory)}`);
  renderDetailPathbar(asset);
  renderDetailOverlays(asset, cachedHistory, cachedGenerationHistory);
  const previewAspect = els.detailPanel.querySelector("[data-detail-preview-aspect]");
  if (previewAspect?.dataset.detailPreviewAspect) {
    previewAspect.style.setProperty("--detail-preview-aspect", previewAspect.dataset.detailPreviewAspect);
  }
  if (previewAspect?.dataset.detailPreviewNaturalFallback === "true") {
    const image = previewAspect.querySelector("img.detail-image");
    const applyNaturalPreviewAspect = () => {
      if (!image?.naturalWidth || !image.naturalHeight || !previewAspect.isConnected) return;
      const aspect = image.naturalWidth / image.naturalHeight;
      previewAspect.style.setProperty("--detail-preview-aspect", aspect >= 9 / 16
        ? `${image.naturalWidth} / ${image.naturalHeight}`
        : "9 / 16");
    };
    image?.addEventListener("load", applyNaturalPreviewAspect, { once: true });
    if (image?.complete) applyNaturalPreviewAspect();
  }
  if (scroller && keepScrollTop !== null) scroller.scrollTop = keepScrollTop;
  else if (scroller) scroller.scrollTop = 0;
  bindDetailHeaderContext(asset);
  bindDetailEvents(asset, renderId);
  bindReferenceThumbnailFallbacks(els.detailPanel);
  bindVersionPickerEvents();
  bindVersionHistoryEvents(cachedHistory);
  // The compare selects are rebuilt from the cached history on every render,
  // so they need their listeners again (not only after /versions loads).
  bindVersionCompareEvents(cachedHistory, asset.id);
  bindGenerationHistoryEvents(cachedGenerationHistory, asset.id);
  bindGenerationContextEvents();
  bindRecipeHistoryEvents(cachedRecipeHistory, asset);
  detailRenderedAssetId = asset.id;
  if (hadPanelFocus) els.detailPanel.querySelector("#detailTitle")?.focus();
  // Phase 3A：详情内容变化（版本切换/后台刷新/语言切换）时同步查看模式舞台主图。
  if (syncAssetView && state.viewMode === "asset") renderAssetView();
  // P2：该素材的历史已有缓存（同素材重渲染：收藏切换/自动保存后的后台刷新/
  // 语言切换）时不重发两个历史请求；导航换素材时缓存已被清空，照常拉取。
  if (!cachedHistory) void loadVersionHistory(asset);
  if (!cachedRecipeHistory) void loadRecipeHistory(asset);
  if (!cachedGenerationHistory) void loadGenerationHistory(asset);
}

// GravityPort A4a：底部固定「素材路径」胶囊——左边标签、中间单行省略路径（悬停
// title 展示全路径）、右边「打开」（与右键菜单「在 Finder 中显示」同一动作）。
// 堆叠检视器与空态不渲染（renderDetail 的对应分支里 hidden）。路径不存在时「打开」禁用。
// 任务 110：路径改为「头 + 尾」两段中间省略，textContent 拼接仍是完整路径。胶囊里
// 留给路径的位置只有约 116px（11px 字约 19 个字符），尾段只留 12 个字符（文件名的
// 结尾和扩展名），剩下的位置给路径开头；完整文件名在检视器最上面已经有了。
const DETAIL_PATHBAR_TAIL_LENGTH = 12;
function renderDetailPathbar(asset) {
  const { pathbar } = ensureDetailInspectorShell();
  if (!pathbar) return;
  const imagePath = String(asset.image_path || "").trim();
  const pathSegments = pathEllipsisSegments(imagePath, DETAIL_PATHBAR_TAIL_LENGTH);
  pathbar.hidden = false;
  pathbar.innerHTML = `<div class="detail-pathbar-pill"><span class="detail-pathbar-label">${escapeHtml(t("assetPathLabel"))}</span><span class="detail-pathbar-path"${imagePath ? ` title="${escapeHtml(imagePath)}"` : ""}>${imagePath ? `<span class="me-head">${escapeHtml(pathSegments.head)}</span><span class="me-tail">${escapeHtml(pathSegments.tail)}</span>` : `<span class="empty-copy">${escapeHtml(t("notRecorded"))}</span>`}</span><button class="detail-pathbar-open" type="button" data-action="open-asset-location" data-asset-path="${escapeHtml(imagePath)}"${imagePath ? "" : " disabled"} aria-label="${escapeHtml(t("openPathAction"))}">${escapeHtml(t("openPathAction"))}</button></div>`;
}

// 「打开」与右键菜单「在 Finder 中显示」完全同源：同一 /api/open-folder 端点、
// 同样的错误映射与成功提示，不另写打开逻辑（桌面端落到 shell.showItemInFolder，
// 浏览器端走同一服务端行为）。
async function revealAssetAtPath(imagePath) {
  const path = String(imagePath || "").trim();
  if (!path) return;
  await runAction(async () => {
    try {
      await apiFetch("/api/open-folder", {
        method: "POST",
        body: { path, reveal: true },
      });
    } catch (error) {
      if (error.message.includes("Path not allowed")) throw new Error(t("showInFinderPathNotAllowed"));
      if (error.message.includes("does not exist")) throw new Error(t("showInFinderNotFound"));
      throw new Error(t("showInFinderFailed"));
    }
    showToast(t("shownInFinder"), "success");
  });
}

// GravityPort A4a：填充两个浮层主体。参考图浮层 = 参考图权利编辑器（原来源区块
// 内的 data-reference-rights / data-reference-rights-section 结构原样搬入，行为
// 不变）；版本树浮层 = 版本选择器 + 生成树 + 版本对比 + 版本历史（原独立版本区块
// 内容，行为不变）。事件绑定不用在这里做——renderDetail 随后的 panel 级
// bind* 调用按 els.detailPanel 全面板查询，天然覆盖浮层内的 region。每次
// renderDetail 整体重建——浮层打开且焦点在浮层里时，回落到浮层卡片。
function renderDetailOverlays(asset, cachedHistory, cachedGenerationHistory) {
  const referenceBody = inspectorOverlay.body("reference");
  if (referenceBody) {
    referenceBody.innerHTML = `<div class="detail-reference-overlay" data-reference-rights-section><div data-reference-rights>${referenceRightsMarkup(asset)}</div></div>`;
  }
  const versionBody = inspectorOverlay.body("version");
  if (versionBody) {
    versionBody.innerHTML = detailVersionSectionMarkup(asset, cachedHistory, null, cachedGenerationHistory);
  }
  const overlayRoot = els.detailPanel.querySelector("[data-gp-overlay]");
  if (inspectorOverlay.isOpen() && overlayRoot?.contains(document.activeElement)) {
    overlayRoot.focus({ preventScroll: true });
  }
}

function bindDetailHeaderContext(asset) {
  const scroller = els.detailPanel?.querySelector(".detail-inspector-scroll");
  const overview = scroller?.querySelector('[data-inspector-section="file"]');
  const headerLabel = els.detailPanel?.querySelector("[data-detail-header-label]");
  if (!scroller || !overview || !headerLabel) return;
  const assetTitle = displayAssetTitle(asset);
  const syncHeader = () => {
    const overviewPassed = scroller.scrollTop >= overview.offsetTop + overview.offsetHeight - 8;
    headerLabel.textContent = overviewPassed ? assetTitle : t("assetInspector");
    headerLabel.title = overviewPassed ? assetTitle : "";
    headerLabel.classList.toggle("is-contextual", overviewPassed);
  };
  scroller.onscroll = syncHeader;
  syncHeader();
}

let generationHistoryRequestSequence = 0;
function generationHistoryForAsset(asset) {
  const history = state.generationHistory;
  return history?.project_id === asset.project_id && history?.asset_id === asset.id ? history : null;
}
async function loadGenerationHistory(asset, options = {}) {
  const requestId = ++generationHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/generation-history`);
    if (requestId !== generationHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.generationHistory = result.history;
    renderGenerationHistoryRegion(result.history, asset.id, null, options);
    // GravityPort A4a：检视器「版本树与上下文」盒与浮层树共用一次请求，各自刷新。
    renderGenerationContextRegion(result.history, asset.id);
  } catch (error) {
    if (requestId !== generationHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderGenerationHistoryRegion(null, asset.id, error);
    renderGenerationContextRegion(null, asset.id, error);
  }
}
// GravityPort A4a：版本树与上下文盒的异步刷新（markup 与区块渲染共用
// generationContextBoxMarkup，保证两处一致；出错时按空态处理）。
function renderGenerationContextRegion(history, selectedId, error = null) {
  const region = els.detailPanel?.querySelector("[data-generation-context]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="empty-copy detail-version-context-empty">${escapeHtml(t("generationHistoryEmpty"))}</p>`
    : generationContextBoxMarkup(history, selectedId);
}
// 任务 75：版本树与上下文的行是「打开这条生成的输出素材」按钮，复用生成树同一
// 动作（openGenerationOutputAsset），不另写切换逻辑；键盘经原生 button 激活。
// 盒的 innerHTML 会被异步刷新整段替换而 region 元素只在 renderDetail 重建，
// 所以在 region 上做一次事件委托（幂等标记防重复绑定）。
function bindGenerationContextEvents() {
  const region = els.detailPanel?.querySelector("[data-generation-context]");
  if (!region || region.dataset.generationContextRowsBound === "true") return;
  region.dataset.generationContextRowsBound = "true";
  region.addEventListener("click", (event) => {
    const button = event.target.closest?.('button[data-action="open-generation-output"]');
    if (!button || button.disabled || !region.contains(button)) return;
    runAction(() => openGenerationOutputAsset(button.dataset.outputAssetId));
  });
}
function renderGenerationHistoryRegion(history, selectedId, error = null, options = {}) {
  const region = els.detailPanel?.querySelector("[data-generation-history]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="generation-history-status error" role="status">${escapeHtml(t("generationHistoryLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : generationHistoryMarkup(history, selectedId);
  if (error) return;
  bindGenerationHistoryEvents(history, selectedId);
  for (const generationId of options.openGenerationIds || []) {
    const node = region.querySelector(`[data-generation-id="${CSS.escape(String(generationId))}"]`);
    if (node instanceof HTMLDetailsElement) node.open = true;
  }
}

function generationHistoryEvent(history, generationId) {
  return [...(history?.events || []), ...(history?.context_events || [])]
    .find((event) => event.id === generationId) || null;
}

function openGenerationNodeIds(region) {
  return [...(region?.querySelectorAll?.("[data-generation-id][open]") || [])]
    .map((node) => node.dataset.generationId)
    .filter(Boolean);
}

async function openGenerationOutputAsset(outputAssetId) {
  const cleanAssetId = String(outputAssetId || "").trim();
  if (!cleanAssetId || cleanAssetId === state.selectedId) return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(cleanAssetId)) return;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;

  let target = state.assets.find((asset) => asset.id === cleanAssetId && asset.project_id === originProjectId) || null;
  if (!target) {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(originProjectId)}/${encodeURIComponent(cleanAssetId)}`);
    if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
    target = result.asset || null;
  }
  if (!target) throw new Error(t("generationOpenAssetFailed"));

  discardDetailDraft();
  state.selectedId = cleanAssetId;
  state.detailAsset = state.assets.some((asset) => asset.id === cleanAssetId && asset.project_id === originProjectId) ? null : target;
  state.versionHistory = null;
  state.recipeHistory = null;
  state.generationHistory = null;
  setDetailOpen(true);
  updateSelectedCard();
}

async function showGenerationEventContext(history, generationId) {
  const generation = generationHistoryEvent(history, generationId);
  const conversationId = String(generation?.conversation_id || "").trim();
  if (!generation || !conversationId) return;
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(null)) return;
  if (originAssetId !== null && !isCurrentDetailSelection(originProjectId, originAssetId)) return;
  discardDetailDraft();
  state.scope = "all";
  state.mediaKind = "all";
  clearFacets();
  state.facets.conversation = conversationId;
  if (generation.message_id) state.facets.generationBatch = generation.message_id;
  applyFilterChange();
}

function bindGenerationHistoryEvents(history, selectedAssetId) {
  const region = els.detailPanel?.querySelector("[data-generation-history]");
  if (!region || !history || state.selectedId !== selectedAssetId) return;
  if (region.dataset.generationEventsBound === "true") return;
  region.dataset.generationEventsBound = "true";
  region.addEventListener("click", (event) => {
    const activeHistory = state.generationHistory;
    const activeSelectedAssetId = state.selectedId;
    if (!activeHistory || !activeSelectedAssetId) return;
    const button = event.target.closest?.("button[data-action]");
    if (!button || !region.contains(button)) return;
    const action = button.dataset.action;
    if (action === "open-generation-output") {
      runAction(() => openGenerationOutputAsset(button.dataset.outputAssetId));
      return;
    }
    if (action === "view-generation-context") {
      runAction(() => showGenerationEventContext(activeHistory, button.dataset.generationId));
      return;
    }
    if (action === "confirm-generation-relation-candidate") {
      runAction(async () => {
        const childGenerationId = String(button.dataset.childGenerationId || "");
        const parentGenerationId = String(button.dataset.parentGenerationId || "");
        const relationType = String(button.dataset.relationType || "based_on");
        if (!childGenerationId || !parentGenerationId) return;
        const inferred = (activeHistory.relation_candidates || []).find((candidate) => (
          candidate.child_generation_id === childGenerationId
          && candidate.parent_generation_id === parentGenerationId
          && (candidate.suggested_relation_type || candidate.relation_type) === relationType
        ));
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "POST",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: {
                ...(inferred?.evidence || {}),
                source: "asset-inspector-reference-candidate",
                user_confirmed_relation: true,
              },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            await loadGenerationHistory(current, {
              openGenerationIds: [...new Set([
                ...openGenerationNodeIds(region),
                childGenerationId,
                parentGenerationId,
              ])],
            });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "dismiss-generation-relation-candidate") {
      runAction(async () => {
        const childGenerationId = String(button.dataset.childGenerationId || "");
        const parentGenerationId = String(button.dataset.parentGenerationId || "");
        if (!childGenerationId || !parentGenerationId) return;
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relation-candidates", {
            method: "PATCH",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              status: "dismissed",
            },
          });
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "create-generation-relation") {
      const form = button.closest("[data-generation-link-form]");
      if (!form) return;
      runAction(async () => {
        const anchorGenerationId = String(form.dataset.anchorGenerationId || "");
        const candidateGenerationId = String(form.querySelector("[data-generation-link-candidate]")?.value || "");
        const direction = String(form.querySelector("[data-generation-link-direction]")?.value || "candidate-parent");
        const relationType = String(form.querySelector("[data-generation-link-type]")?.value || "edited_from");
        if (!anchorGenerationId || !candidateGenerationId) return;
        const childGenerationId = direction === "candidate-child" ? candidateGenerationId : anchorGenerationId;
        const parentGenerationId = direction === "candidate-child" ? anchorGenerationId : candidateGenerationId;
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "POST",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: { source: "asset-inspector", user_selected_relation: true },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) {
            const openGenerationIds = [...new Set([...openGenerationNodeIds(region), anchorGenerationId, candidateGenerationId])];
            await loadGenerationHistory(current, { openGenerationIds });
          }
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "save-generation-relation") {
      const row = button.closest("[data-generation-relation-row]");
      if (!row) return;
      runAction(async () => {
        const childGenerationId = String(row.dataset.childGenerationId || "");
        const parentGenerationId = String(row.dataset.parentGenerationId || "");
        const previousRelationType = String(row.dataset.previousRelationType || "");
        const relationType = String(row.querySelector("[data-generation-relation-type]")?.value || previousRelationType);
        const existing = (activeHistory.relations || []).find((relation) => relation.child_generation_id === childGenerationId
          && relation.parent_generation_id === parentGenerationId
          && relation.relation_type === previousRelationType);
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "PATCH",
            body: {
              projectId: state.project,
              childGenerationId,
              parentGenerationId,
              previousRelationType,
              relationType,
              verificationLevel: "user_confirmed",
              evidence: { ...(existing?.evidence || {}), source: "asset-inspector", user_confirmed_relation: true },
            },
          });
          showToast(t("generationRelationSaved"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
      return;
    }
    if (action === "delete-generation-relation") {
      const row = button.closest("[data-generation-relation-row]");
      if (!row) return;
      runAction(async () => {
        const originProjectId = state.project;
        const childGenerationId = String(row.dataset.childGenerationId || "");
        const parentGenerationId = String(row.dataset.parentGenerationId || "");
        const relationType = String(row.dataset.previousRelationType || "");
        const confirmed = await requestConfirmation({
          title: t("generationRelationDeleteTitle"),
          description: t("generationRelationDeleteDescription"),
          confirmLabel: t("generationRelationDeleteAction"),
          tone: "warning",
          returnFocus: button,
        });
        if (!confirmed || !isCurrentDetailSelection(originProjectId, activeSelectedAssetId)) {
          // 任务 73 返工 1：取消时确认框已把焦点还给浮层里的删除按钮；确认后生成树
          // 整段重建、原按钮被替换——确认框的兜底焦点会落到浮层外，拉回浮层容器。
          inspectorOverlay.restoreFocusInside();
          return;
        }
        button.disabled = true;
        try {
          await apiFetch("/api/generation-relations", {
            method: "DELETE",
            body: { projectId: originProjectId, childGenerationId, parentGenerationId, relationType },
          });
          showToast(t("generationRelationDeleted"), "success");
          const current = selectedAsset();
          if (current?.id === activeSelectedAssetId) await loadGenerationHistory(current, { openGenerationIds: openGenerationNodeIds(region) });
        } finally {
          if (button.isConnected) button.disabled = false;
          // 同上：确认路径在重建后把焦点拉回浮层（浮层仍开着，绝不落到 body）。
          inspectorOverlay.restoreFocusInside();
        }
      });
    }
  });
}

let versionHistoryRequestSequence = 0;
function versionHistoryForAsset(asset) {
  const history = state.versionHistory;
  if (!history || history.project_id !== asset.project_id) return null;
  return history.versions?.some((version) => version.id === asset.id) ? history : null;
}
async function loadVersionHistory(asset) {
  const requestId = ++versionHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/versions`);
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.versionHistory = result.history;
    renderVersionPickerRegion(result.history, asset.id);
    renderVersionCompareRegion(result.history, asset.id);
    renderVersionHistoryRegion(result.history, asset.id);
  } catch (error) {
    if (requestId !== versionHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderVersionPickerRegion(null, asset.id, error);
    renderVersionCompareRegion(null, asset.id, error);
    renderVersionHistoryRegion(null, asset.id, error);
  }
}
function renderVersionPickerRegion(history, selectedId, error = null) {
  const region = els.detailPanel?.querySelector("[data-version-picker]");
  if (!region || state.selectedId !== selectedId) return;
  const asset = state.detailAsset?.id === selectedId
    ? state.detailAsset
    : history?.versions?.find((version) => version.id === selectedId) || null;
  if (!asset) return;
  const hadFocus = region.contains(document.activeElement);
  region.innerHTML = versionPickerMarkup(asset, history, error);
  bindVersionPickerEvents();
  if (hadFocus) region.querySelector("[data-version-select]")?.focus({ preventScroll: true });
}
function bindVersionPickerEvents() {
  const select = els.detailPanel?.querySelector("[data-version-select]");
  if (!select) return;
  select.addEventListener("change", () => selectDetailVersion(select.value));
}
function renderVersionCompareRegion(history, selectedId, error = null, baseId = "", targetId = "") {
  const region = els.detailPanel?.querySelector("[data-version-compare]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="version-history-status error" role="status">${escapeHtml(t("versionLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : versionCompareMarkup(history, selectedId, baseId, targetId);
  bindVersionCompareEvents(history, selectedId);
}
function bindVersionCompareEvents(history, selectedId) {
  if (!history) return;
  const base = els.detailPanel?.querySelector("[data-version-compare-base]");
  const target = els.detailPanel?.querySelector("[data-version-compare-target]");
  if (!base || !target) return;
  const rerender = (focusTarget) => {
    const baseId = base.value;
    const targetId = target.value;
    renderVersionCompareRegion(history, selectedId, null, baseId, targetId);
    requestAnimationFrame(() => els.detailPanel?.querySelector(focusTarget)?.focus({ preventScroll: true }));
  };
  base.addEventListener("change", () => rerender("[data-version-compare-base]"));
  target.addEventListener("change", () => rerender("[data-version-compare-target]"));
}
function renderVersionHistoryRegion(history, selectedId, error = null) {
  const region = els.detailPanel?.querySelector("[data-version-history]");
  if (!region || state.selectedId !== selectedId) return;
  region.innerHTML = error
    ? `<p class="version-history-status error" role="status">${escapeHtml(t("versionLoadFailed"))}: ${escapeHtml(error.message)}</p>`
    : versionHistoryMarkup(history, selectedId);
  bindVersionHistoryEvents(history);
}
function bindVersionHistoryEvents(history) {
  if (!history) return;
  els.detailPanel?.querySelectorAll("[data-version-id]").forEach((button) => button.addEventListener("click", () => {
    selectDetailVersion(button.dataset.versionId);
  }));
}
async function selectDetailVersion(versionId, options = {}) {
  const focusSelect = options.focusSelect !== false;
  const target = state.versionHistory?.versions?.find((version) => version.id === versionId) || null;
  if (!target) { restoreVersionPickerValue(); return false; }
  if (target.id === state.selectedId) { restoreVersionPickerValue(); return true; }
  const originProjectId = state.project;
  const originAssetId = state.selectedId;
  if (!await confirmDetailNavigation(target.id)) { restoreVersionPickerValue(); return false; }
  // Phase 5B context guard：确认期间 Detail 选择已变化时恢复 select 显示值，不操作新素材。
  if (!isCurrentDetailSelection(originProjectId, originAssetId)) { restoreVersionPickerValue(); return false; }
  discardDetailDraft();
  const previousScrollTop = els.detailPanel?.querySelector(".detail-inspector-scroll")?.scrollTop ?? null;
  state.selectedId = target.id;
  state.detailAsset = target;
  state.recipeHistory = null;
  state.generationHistory = null;
  updateSelectedCard();
  renderDetail();
  const scroller = els.detailPanel?.querySelector(".detail-inspector-scroll");
  if (scroller && previousScrollTop !== null) {
    scroller.scrollTop = Math.min(previousScrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight));
  }
  if (focusSelect) requestAnimationFrame(() => els.detailPanel?.querySelector("[data-version-select]")?.focus({ preventScroll: true }));
  return true;
}
function restoreVersionPickerValue() {
  const select = els.detailPanel?.querySelector("[data-version-select]");
  if (select && state.selectedId) select.value = state.selectedId;
}
let recipeHistoryRequestSequence = 0;
function recipeHistoryForAsset(asset) {
  const history = state.recipeHistory;
  return history?.project_id === asset.project_id && history?.asset_id === asset.id ? history : null;
}
function recipeHistoryFromAsset(asset) {
  if (!Array.isArray(asset.recipe_snapshots) || !asset.recipe_snapshots.length) return null;
  return {
    project_id: asset.project_id,
    asset_id: asset.id,
    active_snapshot_id: asset.active_recipe_snapshot_id || asset.recipe_snapshots.at(-1)?.snapshot_id,
    snapshots: asset.recipe_snapshots,
  };
}
async function loadRecipeHistory(asset) {
  const requestId = ++recipeHistoryRequestSequence;
  const selectedKey = `${asset.project_id}\u0000${asset.id}`;
  try {
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/recipes`);
    if (requestId !== recipeHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    state.recipeHistory = result.history;
    renderRecipeHistoryRegion(result.history, asset);
  } catch (error) {
    if (requestId !== recipeHistoryRequestSequence || `${state.project}\u0000${state.selectedId}` !== selectedKey) return;
    renderRecipeHistoryRegion(null, asset, error);
  }
}
function renderRecipeHistoryRegion(history, asset, error = null) {
  const region = els.detailPanel?.querySelector("[data-recipe-history]");
  if (region) {
    if (!isCurrentDetailSelection(asset.project_id, asset.id)) return;
    region.innerHTML = error
      ? `<p class="recipe-history-status error" role="status">${escapeHtml(t("recipeSnapshotLoadFailed"))}: ${escapeHtml(error.message)}</p>`
      : recipeHistoryMarkup(history);
    bindRecipeHistoryEvents(history, asset);
  }
  // The rights editor reads the active snapshot's references, and the panel is
  // built before this history arrives. Gallery rows deliberately omit recipe
  // relations, so without redrawing here the editor stays empty on first open
  // even when the asset has references.
  // GravityPort A4a：配方快照历史不再有独立界面 region（函数体保留），但参考图
  // 权利编辑器与参考图缩略图盒仍依赖配方历史到位后的这次刷新。
  renderReferenceRightsRegion(asset);
  renderPromptReferencesRegion(asset, error);
}
function renderPromptReferencesRegion(asset, error = null) {
  const region = els.detailPanel?.querySelector("[data-prompt-references]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  region.innerHTML = error
    ? `<div class="detail-reference-row detail-reference-error" role="status"><span class="detail-reference-label">${escapeHtml(t("referenceImage"))}</span><span class="detail-reference-value">${escapeHtml(t("referenceLoadFailed"))}</span></div>`
    : promptReferencesMarkup(asset);
  bindReferenceThumbnailFallbacks(region);
  // GravityPort A4a：整块重建把「查看」按钮换成了新节点，重绑浮层入口。
  bindInspectorOverlayTriggers(els.detailPanel);
}
// GravityPort A4a：浮层「查看」入口的绑定（逐按钮直绑；幂等——重复调用只对
// 尚未绑定的按钮生效）。
function bindInspectorOverlayTriggers(panel) {
  panel?.querySelector('[data-action="open-reference-overlay"]:not([data-overlay-bound])')?.addEventListener("click", (event) => {
    inspectorOverlay.open("reference", t("referenceImage"), event.currentTarget);
  });
  panel?.querySelector('[data-action="open-reference-overlay"]')?.setAttribute("data-overlay-bound", "true");
  panel?.querySelector('[data-action="open-version-overlay"]:not([data-overlay-bound])')?.addEventListener("click", (event) => {
    inspectorOverlay.open("version", t("versionTreeTitle"), event.currentTarget);
  });
  panel?.querySelector('[data-action="open-version-overlay"]')?.setAttribute("data-overlay-bound", "true");
}
function bindReferenceThumbnailFallbacks(root) {
  root?.querySelectorAll?.("[data-reference-thumb-img]").forEach((image) => {
    if (image.dataset.referenceFallbackBound === "1") return;
    image.dataset.referenceFallbackBound = "1";
    image.addEventListener("error", () => {
      image.closest(".detail-reference-thumb")?.classList.add("is-load-error");
      const fallback = image.parentElement?.querySelector?.("[data-reference-thumb-fallback]");
      fallback?.setAttribute("aria-hidden", "false");
    }, { once: true });
  });
}
function bindStackInspectorMediaFallbacks(root) {
  root?.querySelectorAll?.("img[data-stack-fallback-src]").forEach((image) => {
    if (image.dataset.stackFallbackBound === "1") return;
    image.dataset.stackFallbackBound = "1";
    image.addEventListener("error", () => {
      const fallback = String(image.dataset.stackFallbackSrc || "").trim();
      if (!fallback || image.dataset.stackFallbackUsed === "1") return;
      image.dataset.stackFallbackUsed = "1";
      image.removeAttribute("srcset");
      image.src = fallback;
    });
  });
}
function renderReferenceRightsRegion(asset) {
  const region = els.detailPanel?.querySelector("[data-reference-rights]");
  if (!region || !isCurrentDetailSelection(asset.project_id, asset.id)) return;
  const section = region.closest("[data-reference-rights-section]");
  // Never let a late recipe-history response overwrite rights the user has
  // already started editing in this render.
  if (section?.dataset.referenceDirty === "true" || section?.getAttribute("aria-busy") === "true") return;
  const wasOpen = section?.open;
  region.innerHTML = referenceRightsMarkup(asset);
  if (section && wasOpen) section.open = true;
  bindReferenceRightsEvents(els.detailPanel);
}
function bindRecipeHistoryEvents(history, asset) {
  if (!history) return;
  els.detailPanel?.querySelectorAll("[data-recipe-snapshot-id]").forEach((button) => button.addEventListener("click", () => runAction(async () => {
    const snapshot = history.snapshots.find((item) => item.snapshot_id === button.dataset.recipeSnapshotId);
    if (!snapshot) return;
    await writeClipboardText(regenerationInstruction(asset, snapshot));
    showToast(t("instructionCopied"), "success");
  })));
}


function bindDetailEvents(asset, renderId) {
  const panel = els.detailPanel;
  activeInspector = { panel, asset, renderId };
  panel.querySelectorAll("[data-edit], [data-version-change], [data-recipe-change]").forEach((field) => {
    const scope = field.matches("[data-version-change]") ? "version" : "recipe";
    const markDirty = () => {
      field.dataset.detailDirty = "true";
      field.dataset.detailDirtyScope = scope;
      state.detailDirty = true;
      if (scope === "recipe") scheduleInspectorSave();
    };
    field.addEventListener("input", markDirty);
    field.addEventListener("change", markDirty);
  });
  // Phase 4A 区块 2：Detail 内收藏——复用既有 toggleFavorite（同一收藏 API），不切换
  // 素材、不返回 Library；loadAssets 后 renderDetail 重渲染按 asset.favorite 重绘本按钮。
  panel.querySelector('[data-action="toggle-favorite"]')?.addEventListener("click", (event) => toggleFavorite(asset.id, event));
  panel.querySelector('[data-action="add-tag"]')?.addEventListener("click", () => openTagEditor(panel, asset, renderId));
  panel.querySelectorAll('[data-action="remove-tag"]').forEach((button) => {
    button.addEventListener("click", () => removeDetailTag(panel, button, asset, renderId));
  });
  panel.querySelector('[data-action="toggle-tags"]')?.addEventListener("click", () => toggleDetailTagsExpanded(asset, renderId));
  // GravityPort A4a：色块点击复制 hex（aria-label「复制颜色 #…」由 markup 提供）。
  // 数据上色经 CSSOM 写入（markup 无内联 style，沿用既有卫生约束）。
  panel.querySelectorAll('[data-action="copy-swatch"]').forEach((button) => {
    button.style.background = String(button.dataset.swatchColor || "transparent");
    button.addEventListener("click", () => runAction(async () => {
      await writeClipboardText(String(button.dataset.swatchColor || ""));
      showToast(t("copySuccess"), "success");
    }));
  });
  // GravityPort A4a：「查看」打开浮层（参考图 / 版本树与上下文，同一时间只开一个；
  // Esc / 点外面 / 关闭按钮都走 inspector-overlay 控制器，焦点回到触发按钮）。
  // 绑定在 bindInspectorOverlayTriggers：renderPromptReferencesRegion 整块重建
  // 参考图区块后也要重绑（那里不含版本树入口，重复调用无副作用）。
  bindInspectorOverlayTriggers(panel);
  if (!isVideoAsset(asset)) {
    // 任务 36：预览入口是 button（inspector-markup assetMediaPreviewMarkup 的
    // detail 分支），关闭弹窗时 openImagePreview 记录的 returnFocus 就是它，
    // 焦点归还从此真正生效。三条激活路径：
    // - dblclick：鼠标原行为保留（img 上的双击冒泡到入口，currentTarget 是入口）；
    // - keydown Enter/Space：显式处理并 preventDefault（抑制原生 click 免得二次打开）；
    // - click 且 detail===0：程序化 .click() / 辅助技术激活兜底，与键盘同路径。
    // 鼠标单击（detail>=1）不打开，维持任务 36 之前的现状。
    const previewEntry = panel.querySelector(".detail-preview-entry");
    const openPreviewFromEntry = (event) => openImagePreview(asset.id, event.currentTarget);
    previewEntry?.addEventListener("dblclick", openPreviewFromEntry);
    previewEntry?.addEventListener("click", (event) => {
      if (event.detail === 0) openPreviewFromEntry(event);
    });
    previewEntry?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openPreviewFromEntry(event);
    });
  }
  // Prompt / Prompt 2 switch the visible text; copy follows the visible one.
  const promptTexts = { 1: String(asset.prompt || ""), 2: String(asset.source?.generation_request_prompt || "").trim() };
  let activePromptVariant = "1";
  panel.querySelectorAll("[data-prompt-variant]").forEach((tab) => tab.addEventListener("click", () => {
    activePromptVariant = tab.dataset.promptVariant === "2" ? "2" : "1";
    panel.querySelectorAll("[data-prompt-variant]").forEach((other) => {
      const active = other.dataset.promptVariant === activePromptVariant;
      other.classList.toggle("is-active", active);
      other.setAttribute("aria-pressed", String(active));
    });
    panel.querySelectorAll("[data-prompt-panel]").forEach((box) => { box.hidden = box.dataset.promptPanel !== activePromptVariant; });
    const copy = panel.querySelector('[data-action="copy-prompt"]');
    if (copy) copy.disabled = !promptTexts[activePromptVariant];
  }));
  panel.querySelector('[data-action="copy-prompt"]')?.addEventListener("click", () => runAction(async () => { await writeClipboardText(promptTexts[activePromptVariant] || ""); showToast(t("copySuccess"), "success"); }));
  panel.querySelector('[data-action="copy-instruction"]')?.addEventListener("click", () => runAction(async () => { const instruction = String(asset.source?.user_message || asset.business_fields?.user_message || "").trim(); await writeClipboardText(instruction); showToast(t("copySuccess"), "success"); }));
  panel.querySelectorAll('[data-edit="rating"] button').forEach((button) => button.addEventListener("click", () => {
    state.detailDirty = true;
    const rating = button.closest('[data-edit="rating"]');
    rating?.setAttribute("data-detail-dirty", "true");
    rating?.setAttribute("data-detail-dirty-scope", "recipe");
    const value = Number(button.dataset.val);
    panel.querySelectorAll('[data-edit="rating"] button').forEach((star) => { const number = Number(star.dataset.val); const on = number <= value; star.classList.toggle("on", on); star.setAttribute("aria-checked", String(number === value)); star.textContent = on ? "★" : "☆"; });
    scheduleInspectorSave();
  }));
  panel.querySelector('[data-action="save-recipe"]')?.addEventListener("click", () => runAction(() => flushInspectorSave()));

  bindReferenceRightsEvents(panel);
}

const USE_PERMISSION_CYCLE = { undeclared: "allowed", allowed: "forbidden", forbidden: "undeclared" };

function handleReferenceRightsOpen(event) {
  if (!event.target.closest('[data-action="open-reference-rights"]')) return;
  const section = els.detailPanel?.querySelector("[data-reference-rights-section]");
  if (!section) return;
  section.open = true;
  section.scrollIntoView({ block: "nearest" });
  section.querySelector("select")?.focus({ preventScroll: true });
}

function bindReferenceRightsEvents(panel) {
  const section = panel.querySelector("[data-reference-rights-section]");
  if (!section) return;

  // A reference can point at an asset that was since deleted. Without this the
  // thumbnail 404s and leaves an empty box; the strict CSP rules out an inline
  // onerror attribute, so the fallback is bound here.
  section.querySelectorAll(".reference-thumb img").forEach((image) => image.addEventListener("error", () => {
    // textContent 不做 HTML 解析，直接赋原始缩写；先 escapeHtml 会双重转义成 &amp; 之类。
    const initials = String(image.dataset.referenceLabel || "?").slice(0, 2).toUpperCase();
    image.replaceWith(Object.assign(document.createElement("span"), { className: "reference-thumb-empty", ariaHidden: "true", textContent: initials }));
  }));

  section.querySelectorAll("[data-reference-use]").forEach((chip) => chip.addEventListener("click", () => {
    const current = ["allowed", "forbidden", "undeclared"].find((value) => chip.classList.contains(value)) || "undeclared";
    const next = USE_PERMISSION_CYCLE[current];
    chip.classList.remove(current);
    chip.classList.add(next);
    chip.lastElementChild?.remove();
    if (next !== "undeclared") chip.insertAdjacentHTML("beforeend", `<span aria-hidden="true">${next === "allowed" ? "✓" : "✕"}</span>`);
    chip.setAttribute("aria-label", `${t(`use_${chip.dataset.referenceUse}`)} — ${t(`permission_${next}`)}`);
    section.dataset.referenceDirty = "true";
    state.detailDirty = true;
    scheduleInspectorSave();
  }));

  section.querySelectorAll("[data-reference-field]").forEach((field) => field.addEventListener("input", () => {
    section.dataset.referenceDirty = "true";
    state.detailDirty = true;
    refreshReferenceRowState(section, field.dataset.referenceIndex);
    scheduleInspectorSave();
  }));

  section.querySelector('[data-action="save-reference-rights"]')?.addEventListener("click", () => runAction(() => flushInspectorSave()));
}

function panelHasDirtyDraft(panel) {
  if (!panel) return false;
  return Boolean(panel.querySelector('[data-detail-dirty="true"], [data-reference-rights-section][data-reference-dirty="true"]'));
}

function clearDetailDirtyScope(panel, scope) {
  panel?.querySelectorAll(`[data-detail-dirty="true"][data-detail-dirty-scope="${scope}"]`).forEach((field) => {
    delete field.dataset.detailDirty;
    delete field.dataset.detailDirtyScope;
  });
  state.detailDirty = panelHasDirtyDraft(panel);
}

// C1：比较“发出时的请求体快照”与当前 DOM 草稿。不一致说明 PATCH 在途期间用户
// 又编辑了（这些值不在已发出的请求体里），成功返回后不得清脏。读取异常（如
// business_fields 的 JSON 正在写一半、面板已被重建）一律保守视为“已变化”，保数据。
function draftChangedDuringFlight(panel, sentRecipeSnapshot, sentReferencesSnapshot) {
  try {
    if (sentRecipeSnapshot !== null) {
      const changeSummary = panel.querySelector("[data-recipe-change]")?.value.trim() || "";
      if (JSON.stringify([readRecipeDraft(panel), changeSummary]) !== sentRecipeSnapshot) return true;
    }
    if (sentReferencesSnapshot !== null) {
      const section = panel.querySelector("[data-reference-rights-section]");
      if (!section) return false;
      if (JSON.stringify(readReferenceRightsDraft(section, state.detailAsset)) !== sentReferencesSnapshot) return true;
    }
  } catch {
    return true;
  }
  return false;
}

/** Keep one row's status chip in step with its own selects while editing. */
function refreshReferenceRowState(section, index) {
  const badge = section.querySelector(`[data-reference-state="${index}"]`);
  if (!badge) return;
  const rights = {};
  section.querySelectorAll(`[data-reference-index="${index}"][data-reference-field]`).forEach((field) => {
    rights[field.dataset.referenceField] = field.value;
  });
  const tone = referenceRightsTone({ rights });
  badge.className = `recipe-reference-rights ${tone}`;
  badge.textContent = t(`rightsState_${tone}`);
}

/**
 * Rebuild the reference list from the editor.
 *
 * `asset_id`, `sha256`, `role`, `scope`, and `applied` are copied from the
 * snapshot untouched: they are the digest material, so altering one here would
 * turn a rights annotation into a different recipe.
 */
function readReferenceRightsDraft(section, asset) {
  const references = activeRecipeSnapshot(asset)?.references || [];
  return references.map((reference, index) => {
    const rights = { ...reference.rights };
    section.querySelectorAll(`[data-reference-index="${index}"][data-reference-field]`).forEach((field) => {
      rights[field.dataset.referenceField] = field.value;
    });
    const allowed = [];
    const forbidden = [];
    section.querySelectorAll(`[data-reference-index="${index}"][data-reference-use]`).forEach((chip) => {
      if (chip.classList.contains("allowed")) allowed.push(chip.dataset.referenceUse);
      else if (chip.classList.contains("forbidden")) forbidden.push(chip.dataset.referenceUse);
    });
    return {
      asset_id: reference.asset_id,
      sha256: reference.sha256,
      role: reference.role,
      scope: reference.scope,
      applied: reference.applied,
      allowed_uses: allowed,
      forbidden_uses: forbidden,
      rights,
    };
  });
}

const REFERENCE_USES = ["identity", "subject", "world", "space", "composition", "lighting", "wardrobe", "color", "style", "prop"];
const RIGHTS_FIELDS = [
  ["copyright", ["unknown", "owned", "licensed", "third-party"]],
  ["portrait_consent", ["unknown", "granted", "not-required", "denied"]],
  ["redistribution", ["unknown", "allowed", "forbidden"]],
];

/**
 * Build the reference rights editor from the active snapshot.
 *
 * Snapshot references are the normalised copy, so they always carry the rights
 * fields; `asset.references` is whatever the caller last wrote. Editing here
 * writes the whole list back, which is digest-inert and therefore refreshes the
 * existing snapshot instead of creating a version.
 */
function referenceRightsMarkup(asset) {
  const references = activeRecipeSnapshot(asset)?.references || [];
  if (!references.length) return `<p class="empty-copy">${t("noReferences")}</p>`;
  const rows = references.map((reference, index) => {
    const linked = state.assets.find((item) => item.id === reference.asset_id);
    const thumbnail = reference.attachment_url || linked?.thumbnail_url || linked?.image_url;
    const label = reference.asset_id || `${t("referenceHash")} ${String(reference.sha256 || "").slice(0, 8)}`;
    const media = thumbnail
      ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" data-reference-label="${escapeHtml(label)}" />`
      : `<span class="reference-thumb-empty" aria-hidden="true">${escapeHtml(String(label).slice(0, 2).toUpperCase())}</span>`;
    const selects = RIGHTS_FIELDS.map(([field, values]) => `<label class="field"><span>${t(`rights_${field}`)}</span><select data-reference-index="${index}" data-reference-field="${field}">${values.map((value) => `<option value="${value}"${(reference.rights?.[field] || "unknown") === value ? " selected" : ""}>${t(`rightsValue_${value}`)}</option>`).join("")}</select></label>`).join("");
    const chips = REFERENCE_USES.map((use) => {
      const permission = reference.forbidden_uses?.includes(use) ? "forbidden" : reference.allowed_uses?.includes(use) ? "allowed" : "undeclared";
      const mark = permission === "allowed" ? "✓" : permission === "forbidden" ? "✕" : "";
      return `<button type="button" class="use-chip ${permission}" data-reference-index="${index}" data-reference-use="${use}" aria-label="${escapeHtml(`${t(`use_${use}`)} — ${t(`permission_${permission}`)}`)}">${escapeHtml(t(`use_${use}`))}${mark ? `<span aria-hidden="true">${mark}</span>` : ""}</button>`;
    }).join("");
    return `<li class="reference-row" data-reference-row="${index}"><div class="reference-head"><span class="reference-thumb">${media}</span><span class="reference-name"><strong>${escapeHtml(label)}</strong>${reference.role ? `<em>${escapeHtml(reference.role)}</em>` : ""}</span><span class="recipe-reference-rights ${referenceRightsTone(reference)}" data-reference-state="${index}">${escapeHtml(t(`rightsState_${referenceRightsTone(reference)}`))}</span></div><div class="reference-fields">${selects}<label class="field"><span>${t("rights_attribution")}</span><input data-reference-index="${index}" data-reference-field="attribution" value="${escapeHtml(reference.rights?.attribution || "")}" placeholder="${escapeHtml(t("attributionPlaceholder"))}" /></label></div><p class="reference-uses-hint">${t("useChipHint")}</p><div class="use-chips">${chips}</div></li>`;
  }).join("");
  // Phase 4A：Cowart 是检视器唯一实心主操作——深层次级 disclosure 内的保存一律次级。
  return `<ol class="reference-list">${rows}</ol><div class="recipe-save-actions"><button class="recipe-save-btn secondary" type="button" data-action="save-reference-rights">${t("saveRights")}</button><span class="detail-autosave-status" data-autosave-status role="status" aria-live="polite"></span></div>`;
}

/** Single reference status, mirroring lib/reference-rights.mjs precedence. */
function referenceRightsTone(reference) {
  const rights = reference?.rights || {};
  if (rights.portrait_consent === "denied" || rights.redistribution === "forbidden") return "restricted";
  if ([rights.copyright, rights.portrait_consent, rights.redistribution].some((value) => !value || value === "unknown")) return "unresolved";
  return "cleared";
}

function activeRecipeSnapshot(asset) {
  const history = recipeHistoryForAsset(asset) || recipeHistoryFromAsset(asset);
  return history?.snapshots?.find((snapshot) => snapshot.snapshot_id === history.active_snapshot_id)
    || history?.snapshots?.at(-1)
    || null;
}

function regenerationInstruction(asset, snapshot) {
  const recipe = snapshot || {
    effective_prompt: asset.prompt,
    user_prompt: asset.user_prompt || asset.source?.user_prompt || asset.business_fields?.user_prompt,
    negative_prompt: asset.negative_prompt || asset.business_fields?.negative_prompt,
    prompt_status: asset.source?.prompt_status || asset.business_fields?.prompt_status,
    generation_tool: asset.source?.generation_tool || asset.business_fields?.generation_tool,
    model: asset.source?.model || asset.business_fields?.model,
    provider: asset.source?.provider || asset.business_fields?.provider,
    skill: asset.skill,
    style: asset.style,
    ratio: asset.ratio,
    theme: asset.theme,
    references: asset.references || asset.business_fields?.references || [],
    provenance: {},
  };
  const provenance = recipe.provenance || {};
  const source = Object.fromEntries(Object.entries({
    generation_tool: recipe.generation_tool,
    model: recipe.model,
    provider: recipe.provider,
    task_id: provenance.task_id,
    session_id: provenance.session_id,
    capture_context_id: provenance.capture_context_id,
    provider_tool_call_id: provenance.provider_tool_call_id,
    provider_generation_call_id: provenance.provider_generation_call_id,
    provider_response_id: provenance.provider_response_id,
    provider_asset_id: provenance.provider_asset_id,
    verification_level: provenance.verification_level,
    source_recipe_snapshot_id: recipe.snapshot_id,
  }).filter(([, value]) => value));
  return [
    t("generatedInstruction"),
    recipe.snapshot_id ? `source recipe snapshot: ${recipe.snapshot_id}` : "",
    "",
    "tool: asset_version_create",
    `projectId: ${JSON.stringify(asset.project_id)}`,
    `assetId: ${JSON.stringify(asset.id)}`,
    "imagePath: <path returned by image generation>",
    "version_change: <describe the generated result>",
    `prompt: ${JSON.stringify(recipe.effective_prompt || "")}`,
    `user_prompt: ${JSON.stringify(recipe.user_prompt || "")}`,
    `negative_prompt: ${JSON.stringify(recipe.negative_prompt || "")}`,
    `references: ${JSON.stringify(recipe.references || [])}`,
    `skill: ${JSON.stringify(recipe.skill || "")}`,
    `style: ${JSON.stringify(recipe.style || "")}`,
    `ratio: ${JSON.stringify(recipe.ratio || "")}`,
    `theme: ${JSON.stringify(recipe.theme || "")}`,
    `group: ${JSON.stringify(asset.group || "")}`,
    `category: ${JSON.stringify(asset.category || "")}`,
    `business_fields: ${JSON.stringify(asset.business_fields || {})}`,
    `source: ${JSON.stringify(source)}`,
  ].filter((line, index, lines) => line || (index > 0 && lines[index - 1])).join("\n");
}

function openTagEditor(panel, asset, renderId) {
  const section = panel.querySelector('[data-inspector-section="tags"]');
  const list = section?.querySelector("[data-tags-list]");
  const addButton = section?.querySelector('[data-action="add-tag"]');
  if (!section || !list || !addButton || section.querySelector("[data-tag-editor]")) return;
  const editor = document.createElement("form");
  editor.className = "detail-tag-editor";
  editor.dataset.tagEditor = "true";
  editor.innerHTML = `<input type="text" maxlength="32" placeholder="${escapeHtml(t("tagInputPlaceholder"))}" aria-label="${escapeHtml(t("tagInputLabel"))}" /><button class="action-btn secondary" type="submit">${escapeHtml(t("saveTag"))}</button>`;
  addButton.replaceWith(editor);
  const input = editor.querySelector("input");
  const syncTagDraftState = () => {
    const dirty = Boolean(input?.value.trim());
    if (dirty) {
      editor.dataset.detailDirty = "true";
      editor.dataset.detailDirtyScope = "tags";
    } else {
      delete editor.dataset.detailDirty;
      delete editor.dataset.detailDirtyScope;
    }
    state.detailDirty = panelHasDirtyDraft(panel);
  };
  input?.addEventListener("input", syncTagDraftState);
  input?.focus();
  editor.addEventListener("submit", (event) => {
    event.preventDefault();
    if (editor.dataset.saving === "true") return;
    const value = input?.value.trim() || "";
    if (!value) { input?.focus(); return; }
    editor.dataset.saving = "true";
    editor.querySelectorAll("input, button").forEach((control) => { control.disabled = true; });
    runAction(async () => {
      const currentAsset = latestAssetSnapshot(asset.project_id, asset.id, asset);
      const tags = uniqueTags([...assetTags(currentAsset), value]);
      const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`, { method: "PATCH", body: { tags } });
      if (!isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
      state.detailAsset = result.asset;
      const index = state.assets.findIndex((item) => item.id === asset.id);
      if (index >= 0) state.assets[index] = result.asset;
      showToast(t("tagSaved"), "success");
      // 任务 35：折叠时新标签会落到前 9 个之后的隐藏区，先自动展开，保证刚加的
      // 标签立即可见、可删；未过上限时不渲染 +N 按钮，展开标志无视觉影响。
      if (assetTags(result.asset).length > DETAIL_TAGS_VISIBLE_LIMIT) state.detailTagsExpanded = true;
      refreshDetailTagsSection(result.asset, renderId);
      clearDetailDirtyScope(panel, "tags");
    }).finally(() => {
      if (!editor.isConnected) return;
      delete editor.dataset.saving;
      editor.querySelectorAll("input, button").forEach((control) => { control.disabled = false; });
    });
  });
}

// 标签删除：与 openTagEditor 的 submit 同一保存语义——以 latestAssetSnapshot 的 assetTags
// 为基准去掉目标标签后整体 PATCH tags。不弹确认框（标签随时可加回）；保存期间禁用按钮
// 防连点，失败由 runAction 提示、标签保持原样。焦点落到被删位置的下一个标签按钮；
// 没有更多标签时落回「添加标签」。标签编辑器打开时忽略删除，避免重渲染清掉未保存草稿。
function removeDetailTag(panel, button, asset, renderId) {
  const section = panel.querySelector('[data-inspector-section="tags"]');
  if (!section || !button?.isConnected || button.disabled || section.querySelector("[data-tag-editor]")) return;
  const removedIndex = [...section.querySelectorAll('[data-action="remove-tag"]')].indexOf(button);
  const tagValue = button.dataset.tagValue;
  // Every tag write PATCHes the whole list from the current snapshot, so a
  // second write started before this one lands would resurrect this tag.
  // Lock all tag controls in the section until the save settles.
  const tagControls = [...section.querySelectorAll('[data-action="remove-tag"], [data-action="add-tag"]')];
  tagControls.forEach((control) => { control.disabled = true; });
  runAction(async () => {
    const currentAsset = latestAssetSnapshot(asset.project_id, asset.id, asset);
    const target = String(tagValue).trim().toLocaleLowerCase();
    const tags = assetTags(currentAsset).filter((tag) => tag.toLocaleLowerCase() !== target);
    const result = await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}`, { method: "PATCH", body: { tags } });
    if (!isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
    state.detailAsset = result.asset;
    const index = state.assets.findIndex((item) => item.id === asset.id);
    if (index >= 0) state.assets[index] = result.asset;
    showToast(t("tagRemoved"), "success");
    refreshDetailTagsSection(result.asset, renderId);
    const refreshed = panel.querySelector('[data-inspector-section="tags"]');
    const nextFocus = refreshed?.querySelectorAll('[data-action="remove-tag"]')[removedIndex]
      || refreshed?.querySelector('[data-action="add-tag"]');
    nextFocus?.focus();
  }).finally(() => {
    tagControls.forEach((control) => { if (control.isConnected) control.disabled = false; });
  });
}

function refreshDetailTagsSection(asset, renderId) {
  const current = els.detailPanel?.querySelector('[data-inspector-section="tags"]');
  if (!current || !isCurrentDetailAction(renderId, asset.project_id, asset.id)) return;
  const holder = document.createElement("div");
  holder.innerHTML = detailTagsSectionMarkup(asset);
  const replacement = holder.firstElementChild;
  if (!replacement) return;
  current.replaceWith(replacement);
  replacement.querySelector('[data-action="add-tag"]')?.addEventListener("click", () => openTagEditor(els.detailPanel, asset, renderId));
  replacement.querySelectorAll('[data-action="remove-tag"]').forEach((button) => {
    button.addEventListener("click", () => removeDetailTag(els.detailPanel, button, asset, renderId));
  });
  replacement.querySelector('[data-action="toggle-tags"]')?.addEventListener("click", () => toggleDetailTagsExpanded(asset, renderId));
}

// 任务 35：「+N」切换——翻转 state.detailTagsExpanded 后重渲染标签区（与增删标签走
// 同一条 refreshDetailTagsSection 路径），焦点交还给切换按钮本身：重渲染替换了节点，
// 点击与键盘 Enter 激活走同一 handler，aria-expanded 随新节点更新。
function toggleDetailTagsExpanded(asset, renderId) {
  state.detailTagsExpanded = !state.detailTagsExpanded;
  refreshDetailTagsSection(asset, renderId);
  els.detailPanel?.querySelector('[data-action="toggle-tags"]')?.focus();
}

function readRecipeDraft(panel) {
  const businessText = panel.querySelector('[data-edit="business_fields"]').value;
  let businessFields = {};
  try {
    businessFields = businessText.trim() ? JSON.parse(businessText) : {};
  } catch {
    throw new Error(t("invalidJson"));
  }
  return {
    prompt: panel.querySelector('[data-edit="prompt"]').value,
    skill: panel.querySelector('[data-edit="skill"]').value,
    style: panel.querySelector('[data-edit="style"]').value,
    ratio: panel.querySelector('[data-edit="ratio"]').value,
    theme: panel.querySelector('[data-edit="theme"]').value,
    group: panel.querySelector('[data-edit="group"]').value,
    category: panel.querySelector('[data-edit="category"]').value,
    rating: panel.querySelectorAll('[data-edit="rating"] button.on').length,
    business_fields: businessFields,
  };
}

function isCurrentDetailAction(renderId, projectId, assetId) {
  return renderId === detailRenderSequence && isCurrentDetailSelection(projectId, assetId);
}

function isCurrentDetailSelection(projectId, assetId) {
  return state.project === projectId && state.selectedId === assetId;
}

function setStatus(value, stateName = "neutral") {
  // 只在状态文本变化、且没有进行中的播报时才进入读屏播报区；进行中的播报
  // （导入进度等）结束后由恢复写入补播最新持久状态。轮询同值不再重复写入。
  statusRegion.setPersistentStatus(value);
  // The visible label collapses to its dot in a narrow workspace bar, so the text
  // is also carried as a tooltip.
  if (els.bridgeStatus) { els.bridgeStatus.dataset.state = stateName; els.bridgeStatus.title = value; }
  if (els.bridgeStatusLabel) els.bridgeStatusLabel.textContent = value;
}
async function runAction(action) { try { await action(); } catch (error) { showToast(error.message, "error"); } }

// bootstrap：所有顶层工厂（confirmDialog/toastManager/bridgeStatusPoller 等）初始化
// 完成后才启动，避免同步 init 期间引用尚未求值的 const（TDZ）。
init();
