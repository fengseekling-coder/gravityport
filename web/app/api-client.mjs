// API client + data loading（提取自 app.js，REFACTORING-PLAN R1 批次 3，附录 A #14）：
// apiFetch 与全部数据加载函数移入本模块；state、els 与渲染回调经 createApiClient 工厂注入。
// 请求语义/游标/顺序守卫与原先完全一致；请求序号等模块级状态随闭包迁移。
import { FACET_KEYS, GALLERY_INITIAL_PAGE_SIZE, GALLERY_PAGE_SIZE } from "./config.mjs";

let cachedClientToken;
let browserSessionRefreshPromise = null;

function mosaClientToken() {
  if (cachedClientToken !== undefined) return cachedClientToken;
  cachedClientToken = "";
  if (typeof window === "undefined") return cachedClientToken;
  try {
    const params = new URLSearchParams(String(window.location.hash || "").replace(/^#/, ""));
    const fragmentToken = String(params.get("mosa-client-token") || "").trim();
    const storedToken = String(window.sessionStorage?.getItem?.("mosa.client-token") || "").trim();
    cachedClientToken = fragmentToken || storedToken;
    if (fragmentToken) {
      window.sessionStorage?.setItem?.("mosa.client-token", fragmentToken);
      params.delete("mosa-client-token");
      const suffix = params.toString();
      window.history?.replaceState?.(null, "", `${window.location.pathname}${window.location.search}${suffix ? `#${suffix}` : ""}`);
    }
  } catch {
    cachedClientToken = "";
  }
  return cachedClientToken;
}

export function mosaMutationHeaders(method = "POST") {
  const verb = String(method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return {};
  const token = mosaClientToken();
  return token ? { "x-mosa-client-token": token } : {};
}

async function refreshMosaBrowserSession() {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  if (browserSessionRefreshPromise) return browserSessionRefreshPromise;
  browserSessionRefreshPromise = fetch("/", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  }).then((response) => response.ok).catch(() => false).finally(() => {
    browserSessionRefreshPromise = null;
  });
  return browserSessionRefreshPromise;
}

export function createApiClient(deps) {
  // Consume the one-time bootstrap capability as soon as the client is
  // constructed. Keeping it in the URL fragment until the first mutation
  // leaves the capability unnecessarily visible for the lifetime of a
  // read-only browsing session. mosaClientToken() persists it to
  // sessionStorage and removes only its own fragment key.
  mosaClientToken();
  const {
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
  } = deps;

  async function apiFetch(path, options = {}) {
    const method = options.method || "GET";
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...mosaMutationHeaders(method),
        ...(options.headers || {}),
      };
      const response = await fetch(path, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
        credentials: "same-origin",
      });
      const raw = await response.text();
      let payload = {};
      try { payload = raw ? JSON.parse(raw) : {}; }
      catch {
        // 200 + 非法 JSON（反代/网关错误页）不得伪装成空结果——否则画廊会渲染
        // “没有找到匹配的素材”空态而非错误态。HTTP/2 下 statusText 恒为空串，
        // 错误消息退回状态码文本。
        if (!response.ok) throw new Error(response.statusText || `HTTP ${response.status}`);
        throw new Error(`Invalid JSON response (HTTP ${response.status})`);
      }
      if (response.ok) return payload;
      // A source/background runtime can be restarted while a browser tab stays
      // open. Its old cookie/header capability then becomes stale even though
      // the page is still the trusted same-origin MOSA UI. Refresh the
      // HttpOnly browser session from the root document and retry exactly once;
      // unrelated 401s and persistent auth failures still surface normally.
      if (attempt === 0 && isMutation && payload.code === "MOSA_CLIENT_UNAUTHORIZED"
        && await refreshMosaBrowserSession()) {
        continue;
      }
      // Carry the server's machine-readable code so callers can attribute a
      // failure to a specific form field instead of matching on prose.
      const error = new Error(payload.error || response.statusText);
      if (payload.code) error.code = payload.code;
      throw error;
    }
    throw new Error("GravityPort request failed after authentication refresh.");
  }

  async function loadProjects() {
    await apiFetch("/api/projects");
    renderSettingsMenu();
  }

  let statsRequestSequence = 0;
  async function loadStats(options = {}) {
    const requestId = ++statsRequestSequence;
    const project = state.project;
    const [library, result] = await Promise.all([
      options.background
        ? Promise.resolve(null)
        : apiFetch(`/api/library-path?project=${encodeURIComponent(project)}`).catch(() => null),
      apiFetch(`/api/navigation?project=${encodeURIComponent(project)}`)
    ]);
    if (requestId !== statsRequestSequence || project !== state.project) return false;

    if (library) {
      state.libraryPath = library.path || "";
      state.libraryRoot = library.libraryDir || "";
      state.codexImagesDir = library.codexGeneratedImagesDir || "";
    }
    const nextGroups = navigationStateFromPayload(result);
    const changed = JSON.stringify(nextGroups) !== JSON.stringify(state.groups);
    state.groups = nextGroups;
    if (!options.background || changed) {
      renderQuickFilters();
      const assetsBelongToProject = !state.assets.length
        || state.assets.every((asset) => (asset.project_id || project) === project);
      if (state.galleryStatus !== "loading" && assetsBelongToProject) updateViewTitle();
    }
    return true;
  }

  function navigationStateFromPayload(result = {}) {
    const rawGroups = result.navigation || {};
    const groups = (Array.isArray(rawGroups.groups) ? rawGroups.groups : []).map((entry, index) => {
      if (Array.isArray(entry)) {
        return {
          name: String(entry[0] || ""),
          count: Number(entry[1] || 0),
          color: "",
          position: index,
        };
      }
      return {
        name: String(entry?.name || ""),
        count: Number(entry?.count || 0),
        color: String(entry?.color || ""),
        position: Number(entry?.position ?? index),
      };
    }).filter((entry) => entry.name);
    return {
      total: Number(rawGroups.total || 0),
      favorites: Number(rawGroups.favorites || 0),
      unorganized: Number(rawGroups.unorganized || 0),
      trash: Number(rawGroups.trash || 0),
      sourceTypes: Array.isArray(rawGroups.sourceTypes) ? rawGroups.sourceTypes : [],
      groups,
    };
  }

  // Project switching is a transaction, not a sequence of state mutations.
  // Fetch the complete destination workspace against an explicit request first;
  // only after every required request succeeds do we replace project-scoped
  // state. A failed switch therefore leaves the old project and its gallery
  // paired, instead of exposing old cards under a new project id.
  async function switchProjectWorkspace(project, options = {}) {
    const projectId = String(project || "").trim();
    if (!projectId || projectId === state.project) return true;
    assetRequestController?.abort();
    assetRequestController = null;
    assetRequestSequence += 1;
    setGalleryBusy(false);
    const request = {
      project: projectId,
      query: "",
      scope: "all",
      mediaKind: "all",
      facets: Object.fromEntries(FACET_KEYS.map((key) => [key, ""])),
      sort: state.sort,
      stackId: "",
    };
    const [library, navigation, assetsResult] = await Promise.all([
      apiFetch(`/api/library-path?project=${encodeURIComponent(projectId)}`).catch(() => null),
      apiFetch(`/api/navigation?project=${encodeURIComponent(projectId)}`),
      requestAssetPage(request, { limit: GALLERY_INITIAL_PAGE_SIZE }),
    ]);
    if (typeof options.shouldCommit === "function" && !options.shouldCommit()) return false;

    resetAssetPrefetch();
    state.project = projectId;
    state.query = "";
    state.scope = "all";
    state.mediaKind = "all";
    state.facets = { ...request.facets };
    state.activeStackId = "";
    state.activeStackSummary = null;
    state.stackReturnSnapshot = null;
    state.selectedId = null;
    state.selectedIds = new Set();
    state.selectedStackNodes = new Map();
    state.selectionProject = projectId;
    state.selectionRequestKey = "";
    state.detailAsset = null;
    state.detailStack = null;
    state.versionHistory = null;
    state.recipeHistory = null;
    state.generationHistory = null;
    state.assets = assetsResult.assets || [];
    state.loadedAssetCount = state.assets.length;
    state.loadedPageCount = 1;
    state.pageTotal = Number.isFinite(Number(assetsResult.page?.total)) ? Number(assetsResult.page.total) : state.assets.length;
    state.nextCursor = assetsResult.page?.nextCursor || null;
    state.galleryStatus = "ready";
    state.galleryError = null;
    state.paginationStatus = "idle";
    state.groups = navigationStateFromPayload(navigation);
    state.libraryPath = library?.path || "";
    state.libraryRoot = library?.libraryDir || "";
    state.codexImagesDir = library?.codexGeneratedImagesDir || "";
    renderQuickFilters();
    renderSettingsMenu();
    renderGrid({ preserveScroll: false });
    updateViewTitle();
    lastCommittedAssetRequestKey = assetRequestKey(request);
    noteLibraryRevision(assetsResult.revision);
    if (state.nextCursor) void prefetchNextAssetPage();
    return true;
  }

  let assetRequestSequence = 0;
  let assetRequestController = null;
  let assetPrefetchGeneration = 0;
  const assetPrefetchTasks = new Map();
  const prefetchedAssetPages = new Map();
  // Tracks the last result-set semantics that successfully committed to the
  // gallery. Refreshes of the same query/scope/sort must keep the user's
  // viewport; genuine result-set changes (search/filter/sort/project) start at
  // the top. This centralizes scroll policy instead of relying on individual
  // mutation handlers to remember to restore scroll after a full card rebuild.
  let lastCommittedAssetRequestKey = null;

  // BUG-10（Batch 2A）：Gallery 与 Viewer 边界按需加载共用同一分页请求语义——参数构造
  // 与请求发起都收敛到这两个 helper，避免两套查询规则漂移。Viewer 只允许在进入时捕获的
  // 只读查询快照上取页，绝不读取运行中已变化的筛选状态；游标必须与发出时的排序同行。
  function buildAssetPageParams(request, options = {}) {
    const params = new URLSearchParams({ project: request.project, q: request.query });
    params.set("limit", String(Math.min(250, Math.max(1, Number(options.limit) || GALLERY_PAGE_SIZE))));
    if (options.includeTotal === false) params.set("includeTotal", "0");
    // The sort is resolved by the store across the whole query, so the cursor must
    // travel with the same order it was issued under.
    params.set("sort", request.sort);
    if (options.cursor) params.set("cursor", options.cursor);
    if (request.scope === "favorite") params.set("favorite", "1");
    else if (request.scope === "unorganized") params.set("unorganized", "1");
    else if (request.scope === "trash") params.set("trash", "1");
    if (request.mediaKind && request.mediaKind !== "all") params.set("mediaKind", request.mediaKind);
    for (const key of FACET_KEYS) {
      if (request.facets[key]) params.set(key, request.facets[key]);
    }
    return params;
  }

  function requestAssetPage(request, options = {}) {
    const params = buildAssetPageParams(request, options);
    const fetchOptions = options.signal ? { signal: options.signal } : undefined;
    if (request.stackId) return apiFetch(`/api/asset-stacks/${encodeURIComponent(request.stackId)}/assets?${params}`, fetchOptions);
    // `/api/assets` remains the raw asset collection for exports and other
    // data-oriented callers. The gallery opts into Stack collapsing explicitly
    // so visual organisation never changes the meaning of the underlying API.
    params.set("view", "gallery");
    return apiFetch(`/api/assets?${params}`, fetchOptions);
  }

  function requestAssetTotal(request) {
    const params = buildAssetPageParams(request);
    params.set("limit", "1");
    if (request.stackId) return apiFetch(`/api/asset-stacks/${encodeURIComponent(request.stackId)}/assets?${params}`);
    params.set("view", "gallery");
    return apiFetch(`/api/assets?${params}`);
  }

  function resetAssetPrefetch() {
    assetPrefetchGeneration += 1;
    assetPrefetchTasks.forEach((task) => task.controller.abort());
    assetPrefetchTasks.clear();
    prefetchedAssetPages.clear();
  }

  function takePrefetchedAssetPage(request, cursor) {
    const requestKey = assetRequestKey(request);
    const entry = prefetchedAssetPages.get(cursor);
    if (!entry || entry.requestKey !== requestKey) return null;
    prefetchedAssetPages.delete(cursor);
    const result = entry.result;
    return result;
  }

  async function waitForPrefetchedAssetPage(request, cursor) {
    const requestKey = assetRequestKey(request);
    let result = takePrefetchedAssetPage(request, cursor);
    if (result) return result;
    const task = assetPrefetchTasks.get(cursor);
    if (!task || task.requestKey !== requestKey) return null;
    await task.promise;
    result = takePrefetchedAssetPage(request, cursor);
    return result;
  }

  /**
   * Keep two complete gallery pages ready ahead of the viewport. The first
   * buffer eliminates ordinary boundary waits; the second absorbs a very fast
   * trackpad/scrollbar run without forcing the user onto the SQLite/HTTP path.
   * The cache is cursor-keyed and reset transactionally whenever result-set
   * semantics or the library revision changes.
   */
  async function prefetchAssetPageChain(request, cursor, depth, generation) {
    if (!cursor || depth <= 0 || generation !== assetPrefetchGeneration) return false;
    const requestKey = assetRequestKey(request);
    let result = prefetchedAssetPages.get(cursor)?.requestKey === requestKey
      ? prefetchedAssetPages.get(cursor).result
      : null;
    if (!result) {
      let task = assetPrefetchTasks.get(cursor);
      if (!task || task.requestKey !== requestKey) {
        const controller = new AbortController();
        task = { requestKey, cursor, controller, promise: null };
        task.promise = requestAssetPage(request, { cursor, includeTotal: false, signal: controller.signal })
          .then((page) => {
            if (controller.signal.aborted || generation !== assetPrefetchGeneration) return null;
            if (requestKey !== assetRequestKey(currentAssetRequest())) return null;
            prefetchedAssetPages.set(cursor, { requestKey, result: page });
            prewarmAssetMedia?.(page.assets || []);
            return page;
          })
          .catch(() => null)
          .finally(() => {
            if (assetPrefetchTasks.get(cursor) === task) assetPrefetchTasks.delete(cursor);
          });
        assetPrefetchTasks.set(cursor, task);
      }
      result = await task.promise;
    }
    if (!result || generation !== assetPrefetchGeneration) return false;
    const nextCursor = result.page?.nextCursor || null;
    if (nextCursor && depth > 1) await prefetchAssetPageChain(request, nextCursor, depth - 1, generation);
    return true;
  }

  function prefetchNextAssetPage() {
    const cursor = state.nextCursor;
    if (!cursor || document.hidden) return Promise.resolve(false);
    const request = currentAssetRequest();
    return prefetchAssetPageChain(request, cursor, 2, assetPrefetchGeneration);
  }

  // Gallery busy is owned by the single results container. A completion may clear
  // the attribute only when its request generation and request key are still current;
  // a stale response can never make a newer search/filter request look idle.
  function isCurrentAssetRequest(requestId, request) {
    if (requestId !== assetRequestSequence) return false;
    return assetRequestKey(request) === assetRequestKey(currentAssetRequest());
  }

  function setGalleryBusy(busy, requestId = null, request = null) {
    if (!els.assetGrid) return false;
    if (!busy && requestId !== null && !isCurrentAssetRequest(requestId, request)) return false;
    els.assetGrid.setAttribute("aria-busy", String(Boolean(busy)));
    return true;
  }

  async function loadAssets(options = {}) {
    assetRequestController?.abort();
    const controller = new AbortController();
    assetRequestController = controller;
    const requestId = ++assetRequestSequence;
    const request = currentAssetRequest();
    const requestKey = assetRequestKey(request);
    const appendCursor = options.append ? state.nextCursor : null;
    if (!options.append) {
      resetAssetPrefetch();
      state.paginationStatus = "idle";
    } else {
      state.paginationStatus = "loading";
    }
    const preserveScroll = options.preserveScroll
      ?? (options.append || lastCommittedAssetRequestKey === requestKey);
    setGalleryBusy(true, requestId, request);
    let result;
    try {
      result = options.append && appendCursor
        ? await waitForPrefetchedAssetPage(request, appendCursor)
        : null;
      if (!result) {
        result = await requestAssetPage(request, {
          cursor: appendCursor,
          includeTotal: !options.append,
          limit: options.append ? GALLERY_PAGE_SIZE : GALLERY_INITIAL_PAGE_SIZE,
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (!isCurrentAssetRequest(requestId, request)) return false;
      if (request.stackId && error?.code === "STACK_NOT_FOUND") {
        setGalleryBusy(false, requestId, request);
        window.dispatchEvent(new CustomEvent("mosa:active-stack-missing", { detail: { stackId: request.stackId } }));
        return false;
      }
      // Loading the next page is additive. A transient failure must never
      // replace already-loaded cards or discard the user's browsing context.
      if (options.append && state.assets.length) {
        state.galleryError = error;
        state.paginationStatus = "error";
        setGalleryBusy(false, requestId, request);
        return false;
      }
      // Background refreshes must not replace a usable gallery with an error
      // screen, but their busy lifecycle still ends at the failed request.
      if (options.background && state.assets.length) {
        setGalleryBusy(false, requestId, request);
        return false;
      }
      renderErrorState(error, requestId, request);
      return false;
    }
    if (!isCurrentAssetRequest(requestId, request)) return false;

    const previousAssets = state.assets;
    const previousSelected = selectedAsset();
    const incomingAssets = result.assets || [];
    const existingAssetKeys = options.append
      ? new Set(state.assets.map((asset) => `${asset.project_id || request.project}\u001f${asset.id}`))
      : null;
    const uniqueIncomingAssets = options.append
      ? incomingAssets.filter((asset) => {
        const key = `${asset.project_id || request.project}\u001f${asset.id}`;
        if (existingAssetKeys.has(key)) return false;
        existingAssetKeys.add(key);
        return true;
      })
      : incomingAssets;
    const nextAssets = options.append ? [...state.assets, ...uniqueIncomingAssets] : incomingAssets;
    const nextSelected = nextAssets.find((asset) => asset.id === state.selectedId)
      || (state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project ? state.detailAsset : null);
    const assetsChanged = options.append
      ? uniqueIncomingAssets.length > 0
      : assetListVersion(previousAssets) !== assetListVersion(nextAssets);
    const selectedChanged = assetVersion(previousSelected) !== assetVersion(nextSelected);
    // A mutation can remove the edited asset from the current result set
    // without deleting the asset itself, e.g. un-favoriting while scoped to
    // Favorites. Keep a snapshot of that asset as the Inspector's source of
    // truth until the user saves or explicitly discards the draft. Otherwise
    // selectedId becomes null while the old editable DOM is still visible.
    const preserveDirtySelection = Boolean(state.detailOpen && state.detailDirty && previousSelected
      && previousSelected.project_id === request.project
      && !nextAssets.some((asset) => asset.id === previousSelected.id && asset.project_id === previousSelected.project_id));
    state.assets = nextAssets;
    state.loadedAssetCount = nextAssets.length;
    if (options.append) state.paginationStatus = "idle";
    if (request.stackId && result.stack) state.activeStackSummary = result.stack;
    // The request answered, so an empty result is now genuinely an empty library.
    state.galleryStatus = "ready";
    state.galleryError = null;
    const reportedTotal = result.page?.total;
    if (reportedTotal !== null && reportedTotal !== undefined && Number.isFinite(Number(reportedTotal))) {
      state.pageTotal = Number(reportedTotal);
    } else if (!options.append) {
      state.pageTotal = nextAssets.length;
    }
    state.nextCursor = result.page?.nextCursor || null;
    state.loadedPageCount = options.append ? state.loadedPageCount + 1 : 1;
    if (preserveDirtySelection) state.detailAsset = previousSelected;
    if (state.detailAsset?.project_id !== request.project) state.detailAsset = null;
    if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
    // 任务 96 返工 1：大图页打开期间不按结果集剪选中——后台刷新的响应可能晚于
    // 撤销完成（请求发出时图还在回收站），列表不含它只是过期快照，洗掉 selectedId
    // 会让大图页当前图失锚（再点删除/检视器静默失效）。选中图真正被删的场景走
    // applyChangesInner 的 postReconcileActive 剪枝，不经这里。
    if (state.selectedId && state.viewMode !== "asset" && !state.assets.some((asset) => asset.id === state.selectedId)
      && !(state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project)
      && !(state.detailStack && state.assets.some((asset) => asset.stack?.id === state.detailStack.id))) state.selectedId = null;
    if (!options.background || assetsChanged) {
      // Entry motion is a first-paint affordance only. Infinite-scroll pages
      // join the existing masonry without a reveal animation so pagination
      // never announces itself visually.
      renderGrid({ animate: !options.append && previousAssets.length === 0,
        animateFrom: options.append ? previousAssets.length : 0,
        preserveScroll,
      });
      updateViewTitle();
    }
    lastCommittedAssetRequestKey = requestKey;
    // A same-result mutation (favorite/tag/background refresh) may rebuild the
    // gallery, but it must never rebuild the Inspector while a local draft is
    // active. Doing so would replace the editable DOM and silently discard the
    // user's unsaved values.
    if (state.detailOpen && !isDetailEditorActive()
      && (!options.background || !state.selectedId || selectedChanged)) renderDetail();
    // Phase 3C：后台刷新不重新排序 session 序列，但有效性可能变化——仅同步导航边界
    // 与位置（缺失 ID 在导航时跳过，总数基于当前有效 ID 重算）。
    if (state.viewMode === "asset") updateAssetViewNav();
    if (!options.append && state.loadedPageCount <= 1) noteLibraryRevision(result.revision);
    setGalleryBusy(false, requestId, request);
    if (state.nextCursor) void prefetchNextAssetPage();
    return true;
  }

  let libraryRefreshInFlight = false;
  let backgroundTotalRequestSequence = 0;

  /**
   * When the user has loaded more than one page, replacing the card list would
   * throw away those pages (and can move their scroll position). The gallery
   * still needs the exact current result total, though, so fetch one row using
   * the same query and update only its count. This leaves cards, cursors, and
   * loadedPageCount untouched.
   */
  async function refreshAssetPageTotalInBackground() {
    const requestId = ++backgroundTotalRequestSequence;
    const request = currentAssetRequest();
    let result;
    try {
      result = await requestAssetTotal(request);
    } catch {
      return false;
    }
    if (requestId !== backgroundTotalRequestSequence
      || assetRequestKey(request) !== assetRequestKey(currentAssetRequest())) return false;

    const total = Number(result.page?.total);
    if (!Number.isFinite(total)) return false;
    let titleChanged = false;
    // Inside a Stack the title prefers the Stack summary count, captured on
    // entry; membership changes made in place must refresh it too, or the
    // title keeps the old member count.
    if (request.stackId && result.stack && result.stack.count !== state.activeStackSummary?.count) {
      state.activeStackSummary = { ...state.activeStackSummary, ...result.stack };
      titleChanged = true;
    }
    if (state.pageTotal !== total) {
      state.pageTotal = total;
      titleChanged = true;
    }
    if (titleChanged) updateViewTitle();
    return true;
  }

  async function performFullGalleryReconciliation(options = {}) {
    assetRequestController?.abort();
    const controller = new AbortController();
    assetRequestController = controller;
    const requestId = ++assetRequestSequence;
    const request = currentAssetRequest();
    const requestKey = assetRequestKey(request);
    // Full reconciliation is the LAST-RESORT path, not the normal library
    // change flow: it re-fetches the whole loaded window (journal gap, query
    // contract change, unrecoverable state mismatch). Read the window in
    // MAX-size keyset batches and count the total only on the first page, so a
    // fully-loaded 50k gallery costs ~200 requests instead of ~1250. Incremental
    // changes go through the library reconciliation layer instead.
    const RELOAD_PAGE_LIMIT = 250;
    // Track the loaded row count explicitly: state.assets holds the ACTIVE view
    // (inside a Stack it lists members, not the root gallery), so it cannot
    // size the root reload on Stack exit. loadedAssetCount is committed by every
    // gallery load/append and snapshotted by the Stack navigation.
    const loadedRowCount = Math.max(1, Number(state.loadedAssetCount)
      || (Number(state.loadedPageCount) || 1) * GALLERY_PAGE_SIZE);
    const pageCount = Math.max(1, Math.ceil(loadedRowCount / RELOAD_PAGE_LIMIT) + 1);
    const background = options.background !== false;
    setGalleryBusy(true, requestId, request);

    // Fetch the whole currently-loaded window off-DOM first. The old flow
    // committed page 1 immediately and then appended pages one by one, which
    // temporarily collapsed scrollHeight and could clamp a deep scroll
    // position. This snapshot stays private until every requested page is
    // ready, then the gallery is committed exactly once.
    const pages = [];
    let result = options.firstResult || null;
    let cursor = null;
    try {
      for (let page = 0; page < pageCount; page += 1) {
        if (!result) result = await requestAssetPage(request, {
          cursor,
          limit: RELOAD_PAGE_LIMIT,
          includeTotal: page === 0 ? undefined : false,
          signal: controller.signal,
        });
        if (!isCurrentAssetRequest(requestId, request)) return false;
        pages.push(result);
        const nextCursor = result.page?.nextCursor || null;
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
        result = null;
      }
    } catch {
      if (isCurrentAssetRequest(requestId, request)) setGalleryBusy(false, requestId, request);
      return false;
    }
    if (!isCurrentAssetRequest(requestId, request)) return false;

    const previousAssets = state.assets;
    const previousSelected = selectedAsset();
    const seen = new Set();
    const nextAssets = [];
    for (const page of pages) {
      for (const asset of page.assets || []) {
        const key = `${asset.project_id || request.project}\u001f${asset.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nextAssets.push(asset);
      }
    }
    const lastPage = pages.at(-1) || {};
    const firstPage = pages[0] || {};
    const nextSelected = nextAssets.find((asset) => asset.id === state.selectedId)
      || (state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project ? state.detailAsset : null);
    const selectedChanged = assetVersion(previousSelected) !== assetVersion(nextSelected);
    const assetsChanged = assetListVersion(previousAssets) !== assetListVersion(nextAssets);
    const preserveDirtySelection = Boolean(state.detailOpen && state.detailDirty && previousSelected
      && previousSelected.project_id === request.project
      && !nextAssets.some((asset) => asset.id === previousSelected.id && asset.project_id === previousSelected.project_id));

    state.assets = nextAssets;
    state.loadedAssetCount = nextAssets.length;
    if (request.stackId && firstPage.stack) state.activeStackSummary = firstPage.stack;
    state.galleryStatus = "ready";
    state.galleryError = null;
    state.pageTotal = Number(firstPage.page?.total || nextAssets.length);
    state.nextCursor = lastPage.page?.nextCursor || null;
    state.loadedPageCount = Math.max(1, pages.length);
    if (preserveDirtySelection) state.detailAsset = previousSelected;
    if (state.detailAsset?.project_id !== request.project) state.detailAsset = null;
    if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
    // 任务 96 返工 1：大图页打开期间不按结果集剪选中——后台刷新的响应可能晚于
    // 撤销完成（请求发出时图还在回收站），列表不含它只是过期快照，洗掉 selectedId
    // 会让大图页当前图失锚（再点删除/检视器静默失效）。选中图真正被删的场景走
    // applyChangesInner 的 postReconcileActive 剪枝，不经这里。
    if (state.selectedId && state.viewMode !== "asset" && !state.assets.some((asset) => asset.id === state.selectedId)
      && !(state.detailAsset?.id === state.selectedId && state.detailAsset.project_id === request.project)
      && !(state.detailStack && state.assets.some((asset) => asset.stack?.id === state.detailStack.id))) state.selectedId = null;

    if (!background || assetsChanged) {
      renderGrid({ animate: previousAssets.length === 0, preserveScroll: true });
      updateViewTitle();
    }
    lastCommittedAssetRequestKey = requestKey;
    if (state.detailOpen && !isDetailEditorActive()
      && (!background || !state.selectedId || selectedChanged)) renderDetail();
    if (state.viewMode === "asset") updateAssetViewNav();
    setGalleryBusy(false, requestId, request);
    return true;
  }

  async function refreshLoadedAssetsInBackground() {
    return performFullGalleryReconciliation({ background: true });
  }

  async function refreshLibraryInBackground() {
    if (document.hidden || libraryRefreshInFlight) return false;
    libraryRefreshInFlight = true;
    try {
      const [statsRefreshed, assetsRefreshed] = await Promise.all([
        loadStats({ background: true }),
        state.loadedPageCount > 1 ? refreshLoadedAssetsInBackground() : loadAssets({ background: true }),
      ]);
      // Both loaders use `false` as their stale/failed/no-commit signal. Do not
      // advance the revision baseline unless the visible gallery and its
      // navigation stats actually reconciled to the advertised revision.
      return statsRefreshed !== false && assetsRefreshed !== false;
    } catch {
      // A transient refresh failure should not interrupt the active library view.
      return false;
    } finally {
      libraryRefreshInFlight = false;
    }
  }

  let lastLibraryRevision = null;
  let libraryRevisionInFlight = false;
  // The incremental reconciliation layer (library-reconciliation.mjs) owns the
  // normal "revision changed" path; api-client keeps the baseline and falls
  // back to the full-window refresh only while no reconciler is wired.
  let libraryDeltaApplier = null;
  function setLibraryDeltaApplier(applier) {
    libraryDeltaApplier = typeof applier === "function" ? applier : null;
  }
  function noteLibraryRevision(revision) {
    if (revision == null) return;
    lastLibraryRevision = String(revision);
  }
  function getLibraryRevisionBaseline() {
    return lastLibraryRevision;
  }
  async function fetchLibraryChanges(sinceRevision) {
    const params = new URLSearchParams({ project: state.project });
    const since = Number.parseInt(String(sinceRevision ?? ""), 10);
    if (Number.isFinite(since)) params.set("since", String(since));
    return apiFetch(`/api/library-changes?${params}`);
  }
  async function reconcileLibraryRevision(revision) {
    if (revision == null) return false;
    const nextRevision = String(revision);
    if (nextRevision === lastLibraryRevision) return false;
    resetAssetPrefetch();
    if (!libraryDeltaApplier) return false;
    let applied = false;
    try {
      applied = await libraryDeltaApplier({ baselineRevision: lastLibraryRevision, targetRevision: nextRevision }) !== false;
    } catch {
      applied = false;
    }
    // The applier advances the baseline only after a successful apply; a
    // failure keeps the old baseline so the next event/poll retries. The
    // loaded-window reload is never part of this path — it lives behind the
    // reconciler's explicit full-recovery fallback (journal gap only).
    if (applied) await refreshSelectedStackInspector?.();
    return applied;
  }
  async function refreshLibraryIfChanged() {
    if (document.hidden || libraryRevisionInFlight) return false;
    libraryRevisionInFlight = true;
    try {
      const project = state.project;
      const result = await apiFetch(`/api/library-revision?project=${encodeURIComponent(project)}`);
      if (project !== state.project) return false;
      const revision = result?.revision == null ? null : String(result.revision);
      return reconcileLibraryRevision(revision);
    } catch {
      return false;
    } finally {
      libraryRevisionInFlight = false;
    }
  }

  function currentAssetRequest() {
    return {
      project: state.project,
      query: state.query,
      scope: state.scope,
      mediaKind: state.mediaKind,
      facets: { ...state.facets },
      sort: state.activeStackId ? "manual" : state.sort,
      stackId: state.activeStackId || "",
    };
  }

  function assetRequestKey(request) {
    return JSON.stringify([request.project, request.stackId || "", request.query, request.scope, request.mediaKind || "all", ...FACET_KEYS.map((key) => request.facets[key] || ""), request.sort]);
  }

  function assetListVersion(assets) {
    return assets.map((asset) => [
      asset.project_id || state.project,
      asset.id,
      asset.updated_at || "",
      asset.image_url || "",
      asset.thumbnail_url || "",
      asset.preview_url || "",
      asset.favorite ? "1" : "0",
      asset.group || "",
      asset.version_index || "",
      asset.stack?.id || "",
      asset.stack?.count || "",
      asset.stack?.name || "",
      asset.stack?.match_count || "",
      asset.deleted_at || "",
    ].join("\u001f")).join("|");
  }

  function assetVersion(asset) {
    return asset ? `${asset.id}:${asset.updated_at || ""}` : "";
  }

  return {
    apiFetch, loadProjects, loadStats, switchProjectWorkspace, loadAssets, refreshLibraryInBackground, refreshLibraryIfChanged,
    refreshAssetPageTotalInBackground, refreshLoadedAssetsInBackground, performFullGalleryReconciliation,
    buildAssetPageParams, requestAssetPage, requestAssetTotal, currentAssetRequest, assetRequestKey, assetListVersion, assetVersion,
    noteLibraryRevision, getLibraryRevisionBaseline, setLibraryDeltaApplier, fetchLibraryChanges,
    reconcileLibraryRevision, prefetchNextAssetPage, resetAssetPrefetch, setGalleryBusy,
  };
}
