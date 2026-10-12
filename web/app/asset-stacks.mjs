import { dragGhostCount, dragIdsForCard } from "./drag-gesture.mjs";

const STACK_DRAG_THRESHOLD_PX = 8;

function emptyFacets() {
  return { source: "", group: "", category: "", style: "", conversation: "", generationBatch: "" };
}

function moveBlockBefore(items, movingIds, targetId) {
  return moveBlockRelative(items, movingIds, targetId, "before");
}

function moveBlockRelative(items, movingIds, targetId, placement = "before") {
  const moving = new Set(movingIds);
  const block = items.filter((id) => moving.has(id));
  const rest = items.filter((id) => !moving.has(id));
  let targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) targetIndex = rest.length;
  else if (placement === "after") targetIndex += 1;
  rest.splice(targetIndex, 0, ...block);
  return rest;
}

function stackViewIsUnfiltered(state) {
  if (!state.activeStackId) return false;
  if (state.query || state.scope !== "all" || (state.mediaKind && state.mediaKind !== "all")) return false;
  if (Object.values(state.facets || {}).some(Boolean)) return false;
  // Reorder sends the complete member order as one atomic replacement. With
  // paged Stacks, only allow the gesture after every member has been loaded so
  // a partial page can never overwrite or reject the unseen tail.
  return !state.nextCursor && state.assets.length >= Number(state.pageTotal || state.assets.length);
}

export function createAssetStackController({
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
  recordStackEntry,
  registerStackExit,
  syncNavHistoryButtons,
}) {
  let pointer = null;
  let ghost = null;
  let dropTarget = null;
  let dropPlacement = "";
  let dropGroupTarget = null;
  let mutationInFlight = false;
  let suppressClickAfterDrag = false;
  let pointerMoveFrame = null;

  function clearDropTarget() {
    dropTarget?.classList.remove("stack-drop-target", "stack-reorder-target", "stack-reorder-before", "stack-reorder-after");
    dropTarget = null;
    dropPlacement = "";
    dropGroupTarget?.classList.remove("group-drop-target");
    dropGroupTarget = null;
  }

  function removeGhost() {
    ghost?.remove();
    ghost = null;
    document.body.classList.remove("asset-stack-dragging");
    clearDropTarget();
  }

  function releasePointerCapture(pointerId) {
    if (!els.assetGrid || pointerId == null) return;
    try {
      if (els.assetGrid.hasPointerCapture?.(pointerId)) els.assetGrid.releasePointerCapture(pointerId);
    } catch {
      // Pointer capture may already have been released by the browser/OS.
    }
  }

  function cancelPointerGesture({ releaseCapture = true } = {}) {
    const hadPointer = Boolean(pointer);
    const pointerId = pointer?.id;
    pointer = null;
    if (pointerMoveFrame !== null) cancelAnimationFrame(pointerMoveFrame);
    pointerMoveFrame = null;
    state.assetStackDragCandidate = false;
    nativeAssetDrag?.clearCandidate?.();
    if (releaseCapture && pointerId != null) releasePointerCapture(pointerId);
    removeGhost();
    return hadPointer;
  }

  function suppressSyntheticClick() {
    suppressClickAfterDrag = true;
    window.setTimeout(() => { suppressClickAfterDrag = false; }, 0);
  }

  function createGhost(drag) {
    if (ghost?.isConnected) return ghost;
    // A collapsed Stack is one logical draggable node even when its cover is
    // part of a larger batch selection. Sidebar drop moves the Stack as a unit.
    const count = dragGhostCount(drag);
    const sourceCard = drag?.assetId
      ? els.assetGrid?.querySelector(`:scope > .asset-card[data-id="${CSS.escape(drag.assetId)}"]`)
      : null;
    const sourceButton = sourceCard?.querySelector(".asset-card-select");
    const sourceMedia = sourceButton?.querySelector(".thumb");
    ghost = document.createElement("div");
    ghost.className = "asset-stack-drag-ghost";
    ghost.setAttribute("aria-hidden", "true");

    const preview = document.createElement("div");
    preview.className = "asset-stack-drag-preview";
    const sourceRect = sourceButton?.getBoundingClientRect?.();
    if (sourceRect?.width > 0 && sourceRect?.height > 0) {
      const ratio = sourceRect.width / sourceRect.height;
      const previewWidth = ratio >= 1 ? 96 : Math.max(56, Math.round(112 * ratio));
      const previewHeight = ratio >= 1 ? Math.max(56, Math.round(96 / ratio)) : 112;
      preview.style.width = `${previewWidth}px`;
      preview.style.height = `${previewHeight}px`;
    }
    if (sourceMedia) {
      const media = sourceMedia.cloneNode(true);
      media.removeAttribute?.("id");
      media.querySelectorAll?.("[id]").forEach((node) => node.removeAttribute("id"));
      if (media instanceof HTMLImageElement) {
        media.loading = "eager";
        media.draggable = false;
      }
      media.querySelectorAll?.("img").forEach((image) => {
        image.loading = "eager";
        image.draggable = false;
      });
      preview.append(media);
    }
    ghost.append(preview);
    if (count > 1) {
      ghost.classList.add("is-multi");
      const badge = document.createElement("span");
      badge.className = "asset-stack-drag-count";
      badge.textContent = String(count);
      ghost.append(badge);
    }
    document.body.append(ghost);
    requestAnimationFrame(() => ghost?.classList.add("is-visible"));
    return ghost;
  }

  function syncChrome() {
    const inside = Boolean(state.activeStackId);
    // 任务 123：在 <body> 上暴露「在不在堆叠里」，窄屏样式（露出后退=退出）
    // 与 e2e 都用它判断。唯一写点：进/出/放弃堆叠上下文都经 syncChrome。
    if (inside) document.body.setAttribute("data-in-stack", "true");
    else document.body.removeAttribute("data-in-stack");
    if (els.sortSelect) els.sortSelect.closest(".sort-control")?.toggleAttribute("hidden", inside);
    renderQuickFilters();
    updateViewTitle();
  }

  function setMutationBusy(busy) {
    mutationInFlight = Boolean(busy);
    // 任务 123：堆叠返回按钮删除后，「操作进行中禁用堆叠退出」的规矩搬到后退
    // 按钮上；可用性统一由 syncNavHistoryButtons 判定（堆叠里看 busy，根位置
    // 看历史光标），这里不再直写 disabled。
    if (typeof syncNavHistoryButtons === "function") syncNavHistoryButtons();
    if (!mutationInFlight) {
      gallerySelection.syncRenderedSelection({ prune: false });
    }
  }

  async function runStackMutation(task) {
    if (mutationInFlight) return false;
    setMutationBusy(true);
    try {
      return await task();
    } catch (error) {
      showToast?.(error?.message || String(error), "error");
      return false;
    } finally {
      setMutationBusy(false);
    }
  }

  // recordHistory=false 供「前进=重进历史里的堆叠」使用：那条记录已在历史里，
  // 成功后由调用方前移光标，不再新增（任务 123 规则 11）。
  async function enterStack(stackId, initialSummary = null, { recordHistory = true } = {}) {
    if (!stackId || state.activeStackId) return false;
    // 导航进入堆叠不是用户手动关闭检视器（54-5）。
    if (typeof closeDetailSurface === "function" && !await closeDetailSurface({ navigation: true })) return false;
    const selectionSnapshot = gallerySelection.snapshotSelection?.() || {
      selectedIds: [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())],
      stackNodes: [...(state.selectedStackNodes instanceof Map ? state.selectedStackNodes : new Map())],
      anchorId: "",
    };
    // Root gallery 快照：请求语义之外的整个已加载数据窗口（含数组引用、
    // 分页状态与 revision 时刻）原内存保留。逗留期间库同步把累计 delta 应用到
    // 快照（数据）并在退出时回放，root 窗口不再重新下载（二十二）。
    state.stackReturnSnapshot = {
      query: state.query,
      scope: state.scope,
      facets: { ...state.facets },
      sort: state.sort,
      mediaKind: state.mediaKind,
      scrollTop: els.assetGrid?.scrollTop || 0,
      selectedId: state.selectedId || "",
      selectedIds: [...selectionSnapshot.selectedIds],
      selectedStackNodes: [...selectionSnapshot.stackNodes],
      selectionAnchorId: selectionSnapshot.anchorId || "",
      loadedPageCount: Math.max(1, Number(state.loadedPageCount) || 1),
      loadedAssetCount: Math.max(0, Number(state.loadedAssetCount) || 0),
      stackId,
      rootView: {
        request: currentAssetRequest
          ? { ...currentAssetRequest(), stackId: "" }
          : null,
        assets: state.assets,
        pageTotal: state.pageTotal,
        nextCursor: state.nextCursor,
        loadedPageCount: Math.max(1, Number(state.loadedPageCount) || 1),
        loadedAssetCount: Math.max(0, Number(state.loadedAssetCount) || 0),
        pending: [],
        degraded: false,
      },
    };
    state.activeStackId = stackId;
    state.activeStackSummary = initialSummary ? { ...initialSummary, id: stackId } : null;
    // Keep the root search/filter context when opening a Stack. Root gallery
    // search can match hidden members, so clearing refinements here made users
    // lose the exact member(s) that caused the Stack to appear. Any refinements
    // changed while inside are still discarded on exit in favor of this root
    // snapshot, preserving the previous navigation contract.
    state.selectedId = null;
    gallerySelection.clear();
    syncChrome();
    const loaded = await loadAssets({ preserveScroll: false });
    if (!loaded) return false;
    // 任务 123 规则 1：成功进入堆叠记一条「当前根位置 + 这个堆叠」；确认被
    // 取消或加载失败走到上面 return false，都不记。
    if (recordHistory && typeof recordStackEntry === "function") recordStackEntry(stackId);
    syncChrome();
    els.assetGrid?.focus({ preventScroll: true });
    return true;
  }

  async function restoreRootFromSnapshot(snapshot) {
    const root = snapshot.rootView;
    if (!root || root.degraded) return false;
    state.assets = root.assets;
    state.pageTotal = Number(root.pageTotal) || 0;
    state.nextCursor = root.nextCursor || null;
    state.loadedPageCount = Math.max(1, Number(root.loadedPageCount) || 1);
    state.loadedAssetCount = Math.max(0, Number(root.loadedAssetCount) || 0);
    state.galleryStatus = "ready";
    state.galleryError = null;
    // 堆叠内的请求可能还没返回：它已不是当前请求，按设计不会清 aria-busy，
    // 而快照恢复不再发请求，所以这里必须自己结束忙碌态，否则画廊永久显示加载中。
    if (typeof setGalleryBusy === "function") setGalleryBusy(false);
    // 回放逗留期间积压的 delta（幂等；此时 currentAssetRequest 已恢复为 root 请求）。
    // 提交由下方的整体 renderGrid 完成，这里只做数据 reconcile。
    if (typeof librarySync?.applyRootSnapshotPendingChanges === "function") {
      const applied = await librarySync.applyRootSnapshotPendingChanges(root);
      if (applied === false) return false;
    }
    // 与 loadAssets 相同的选中项/Inspector 快照清理语义。
    if (state.detailAsset && state.assets.some((asset) => asset.id === state.detailAsset.id && asset.project_id === state.detailAsset.project_id)) state.detailAsset = null;
    if (state.selectedId && !state.assets.some((asset) => asset.id === state.selectedId)
      && !(state.detailAsset?.id === state.selectedId)) state.selectedId = null;
    return true;
  }

  // 任务 123：所有退出入口（后退按钮、⌘[、Esc、右键菜单、堆叠消失）共用
  // 这一处实现，历史光标登记只写在这里，不接在某个按钮上。
  // 保留 `async function exitStack() {` 字面签名：gallery-observer-release
  // 契约测试以它为切片锚点。
  async function exitStack() {
    return runStackExit({ stackMissing: false });
  }

  // 堆叠已不存在的退出（解散、成员移空、active-stack-missing）：光标退回根
  // 位置后丢弃堆叠记录，前进按钮保持灰（任务 123 规则 9）。
  async function exitMissingStack() {
    return runStackExit({ stackMissing: true });
  }

  async function runStackExit({ stackMissing = false } = {}) {
    if (!state.activeStackId) return false;
    // 导航退出堆叠不是用户手动关闭检视器（54-5）。确认被取消时这里直接返回，
    // 历史光标不动（先 peek、确认通过再消费，任务 123 规则 4）。
    if (typeof closeDetailSurface === "function" && !await closeDetailSurface({ navigation: true })) return false;
    const exitedStackId = state.activeStackId;
    const snapshot = state.stackReturnSnapshot || {};
    state.activeStackId = "";
    state.activeStackSummary = null;
    state.stackReturnSnapshot = null;
    state.query = snapshot.query || "";
    state.scope = snapshot.scope || "all";
    state.facets = { ...emptyFacets(), ...(snapshot.facets || {}) };
    state.sort = snapshot.sort || state.sort;
    state.mediaKind = snapshot.mediaKind || "all";
    state.selectedId = null;
    gallerySelection.clear();
    if (els.searchInput) els.searchInput.value = state.query;
    if (els.sortSelect) els.sortSelect.value = state.sort;
    // 快照恢复了 mediaKind/facets 状态，但类型按钮与分类下拉要显式重渲染，
    // 否则控件仍显示堆叠内的选择且点击同值按钮被 handler 早退（54-3）。
    if (typeof renderTypeFilters === "function") renderTypeFilters();
    if (typeof renderCategoryFilter === "function") renderCategoryFilter();
    syncChrome();
    // 任务 123 规则 8/9：所有退出入口的唯一历史登记点。确认（closeDetailSurface）
    // 已在上面通过，这里才消费光标；确认被取消的路径到不了这里。
    if (typeof registerStackExit === "function") registerStackExit({ stackId: exitedStackId, stackMissing });
    let loaded = await restoreRootFromSnapshot(snapshot);
    if (!loaded) {
      // 快照缺失或已 degraded（journal gap 等）：全量恢复是最后手段。
      loaded = typeof performFullGalleryReconciliation === "function"
        ? await performFullGalleryReconciliation({ background: false })
        : await loadAssets({ preserveScroll: false });
    }
    if (loaded) {
      // 选中恢复必须同步落地。此前 state.selectedId 在下方 rAF 尾巴里改写:
      // Windows 的隐藏窗口把 rAF 攒到任意后续帧批量执行,恢复一旦落在导航
      // intent 的创建(input 事件)与校验(debounce 回调)之间,
      // isNavigationIntentCurrent 的 selectedId 比对就会失配,用户刚输入的
      // 搜索被静默丢弃——画廊停在旧结果且不忙。这里按 root 视图语义用数据
      // (而非延迟帧的 DOM 查询)先算出返回行,再渲染;rAF 只保留滚动、
      // 焦点与多选高亮这些纯 DOM 恢复。
      const assets = state.assets || [];
      const stackNodeId = snapshot.stackId
        ? (assets.find((asset) => asset.stack?.id === snapshot.stackId)?.id || "")
        : "";
      const snapshotSelectedId = snapshot.selectedId && assets.some((asset) => asset.id === snapshot.selectedId)
        ? snapshot.selectedId
        : "";
      const returnCardId = stackNodeId || snapshotSelectedId;
      if (returnCardId) state.selectedId = returnCardId;
      renderGrid({ preserveScroll: true });
      updateViewTitle();
      requestAnimationFrame(() => {
        if (!els.assetGrid) return;
        const maxScrollTop = Math.max(0, els.assetGrid.scrollHeight - els.assetGrid.clientHeight);
        els.assetGrid.scrollTop = Math.min(Number(snapshot.scrollTop || 0), maxScrollTop);
        const returnCard = returnCardId
          ? els.assetGrid.querySelector(`.asset-card[data-id="${CSS.escape(returnCardId)}"]`)
          : null;
        const visibleIds = new Set((state.assets || []).map((asset) => asset.id));
        gallerySelection.restoreSelection({
          selectedIds: snapshot.selectedIds || [],
          stackNodes: snapshot.selectedStackNodes || [],
          anchorId: snapshot.selectionAnchorId || "",
        }, { allowedIds: visibleIds });
        returnCard?.querySelector(".asset-card-select")?.focus({ preventScroll: true });
        if (!returnCard) els.assetGrid.focus({ preventScroll: true });
      });
    }
    syncChrome();
    return loaded;
  }

  async function createStackFromSelection(coverAssetId = "") {
    if (state.activeStackId || state.scope === "trash" || state.storageKind !== "sqlite") return false;
    if (gallerySelection.hasSelectedStacks?.()) return false;
    const selectedIds = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (selectedIds.length < 2) return false;
    const coverId = coverAssetId && selectedIds.includes(coverAssetId)
      ? coverAssetId
      : (state.assets.find((asset) => state.selectedIds.has(asset.id))?.id || selectedIds[0]);
    return runStackMutation(async () => {
      const result = await apiFetch("/api/asset-stacks", {
        method: "POST",
        body: { projectId: state.project, assetIds: selectedIds, coverAssetId: coverId },
      });
      gallerySelection.clear();
      // 本地增量：N 张成员卡 → 1 张 Stack 节点卡；随后到达的 SSE delta 幂等。
      await librarySync.applyLocalChanges([{
        kind: "stack-created",
        entityType: "stack",
        entityId: result?.stack?.id || "",
        assetIds: selectedIds,
        detail: { coverAssetId: coverId },
      }]);
      showToast?.(t("stackCreated", { count: selectedIds.length }), "success");
      return true;
    });
  }

  async function removeSelectedFromStack() {
    if (!state.activeStackId) return false;
    const ids = [...(state.selectedIds instanceof Set ? state.selectedIds : new Set())];
    if (!ids.length) return false;
    // root 里 Stack 节点的行 id 就是封面成员。移出封面后服务端会改派封面，
    // 原节点行消失、新封面成为节点行；本地变化要和服务端日志一样带上新旧封面，
    // 否则 root 只拿到被移出成员的独立行，Stack 节点要等 SSE 才能回来。
    const previousCoverId = String(state.activeStackSummary?.cover_asset_id || "");
    return runStackMutation(async () => {
      const result = await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/assets`, {
        method: "DELETE",
        body: { projectId: state.project, assetIds: ids },
      });
      gallerySelection.clear();
      if (result.dissolved) {
        await librarySync.applyLocalChanges([{
          kind: "stack-dissolved",
          entityType: "stack",
          entityId: state.activeStackId,
          assetIds: [...(result.assetIds || ids)],
        }]);
        showToast?.(t("stackDissolved"), "success");
        // 解散后的退出：堆叠已不存在，历史里的堆叠记录要一并丢掉（任务 123 规则 9）。
        await exitMissingStack();
        return true;
      }
      // Stack 视图内：受影响成员行就地 reconcile（移除的成员从视图消失，
      // Stack 计数同步），root 快照由增量层并行更新。
      const coverId = String(result.stack?.cover_asset_id || "");
      await librarySync.applyLocalChanges([{
        kind: "stack-members-changed",
        entityType: "stack",
        entityId: state.activeStackId,
        assetIds: [...new Set([...ids, previousCoverId, coverId].filter(Boolean))],
      }]);
      showToast?.(t("stackAssetsRemoved", { count: ids.length }), "success");
      return true;
    });
  }

  function beginPointer(event) {
    if (mutationInFlight) return;
    if (state.scope === "trash") return;
    if (!state.activeStackId && state.storageKind !== "sqlite") return;
    if (event.button !== 0 || event.isPrimary === false || event.pointerType === "touch") return;
    // Shift-drag belongs to additive marquee selection even when the pointer
    // begins on an already batch-selected card.
    if (event.shiftKey) return;
    if (event.target.closest?.(".card-action-btn, input, textarea, select, [contenteditable], a[href]")) return;
    const card = event.target.closest?.(".asset-card");
    if (!card) return;
    const assetId = card.dataset.id;
    if (!assetId) return;
    // A card press owns the drag gesture immediately, even before that card has
    // been single-click selected. This removes the extra "click once, then
    // drag" step and, more importantly, prevents an unselected card drag from
    // falling through to gallery marquee selection. dragIdsForCard() still
    // preserves an existing multi-selection when the pressed card belongs to it.
    const candidateIds = dragIdsForCard(state, assetId);
    const draggedAsset = state.assets.find((asset) => asset.id === assetId);
    const draggedStackId = !state.activeStackId ? String(draggedAsset?.stack?.id || "") : "";
    if (state.activeStackId) {
      if (!stackViewIsUnfiltered(state)) return;
    } else {
      // A collapsed Stack is a logical node. It may be dragged to a sidebar
      // navigation group, but never into another Stack or as only its cover.
      if (!draggedStackId && candidateIds.some((id) => state.assets.find((asset) => asset.id === id)?.stack?.id)) return;
    }
    pointer = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      assetId,
      assetIds: candidateIds,
      stackId: draggedStackId,
      dragging: false,
    };
    state.assetStackDragCandidate = true;
    if (!pointer.stackId) nativeAssetDrag?.begin?.(pointer);
  }

  function targetCardAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    return element?.closest?.(".asset-card") || null;
  }

  // 拖拽入组：侧边栏分组项（data-filter="group"）与“待整理”项都是合法投放目标。
  // 命中分组即高亮；松手后走批量归属接口。
  function targetGroupAt(clientX, clientY) {
    const element = document.elementFromPoint(clientX, clientY);
    const item = element?.closest?.('[data-filter="group"][data-value], [data-filter="unorganized"]');
    return item;
  }

  function flushPointerMove() {
    pointerMoveFrame = null;
    if (!pointer?.dragging) return;
    const clientX = pointer.lastX;
    const clientY = pointer.lastY;
    const marker = createGhost(pointer);
    marker.style.transform = `translate3d(${clientX + 14}px, ${clientY + 14}px, 0)`;
    // 侧边栏目标优先于画廊卡片：指针进入侧边栏后分组目标接管高亮，
    // 同时清掉画廊卡片的高亮残留。
    const groupItem = state.activeStackId ? null : targetGroupAt(clientX, clientY);
    if (groupItem) {
      const next = groupItem.dataset.filter === "group" ? groupItem.dataset.value : "";
      const changed = dropGroupTarget !== groupItem || dropGroupTarget?.dataset.value !== next;
      if (changed) clearDropTarget();
      dropGroupTarget = groupItem;
      groupItem.classList.add("group-drop-target");
      return;
    }
    if (dropGroupTarget) clearDropTarget();
    if (pointer.stackId) return;
    const target = targetCardAt(clientX, clientY);
    if (target !== dropTarget) clearDropTarget();
    if (!target) return;
    const targetId = target.dataset.id;
    if (!targetId) return;
    if (state.activeStackId) {
      if (pointer.assetIds.includes(targetId)) return;
      dropTarget = target;
      target.classList.add("stack-reorder-target");
      const rect = target.getBoundingClientRect();
      dropPlacement = clientX < rect.left + rect.width / 2 ? "before" : "after";
      target.classList.add(dropPlacement === "after" ? "stack-reorder-after" : "stack-reorder-before");
      return;
    }
    const targetAsset = state.assets.find((asset) => asset.id === targetId);
    if (!targetAsset) return;
    dropTarget = target;
    target.classList.add("stack-drop-target");
  }

  function movePointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    pointer.lastX = event.clientX;
    pointer.lastY = event.clientY;
    if (!pointer.dragging) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < STACK_DRAG_THRESHOLD_PX) return;
      if (!pointer.stackId && nativeAssetDrag?.startIfOutside?.(event)) {
        suppressSyntheticClick();
        event.preventDefault();
        cancelPointerGesture();
        return;
      }
      pointer.dragging = true;
      try { els.assetGrid?.setPointerCapture(event.pointerId); } catch { /* Window-level listeners keep the gesture alive. */ }
      document.body.classList.add("asset-stack-dragging");
    }
    if (!pointer.stackId && nativeAssetDrag?.startIfOutside?.(event)) {
      suppressSyntheticClick();
      event.preventDefault();
      cancelPointerGesture();
      return;
    }
    event.preventDefault();
    if (pointerMoveFrame === null) pointerMoveFrame = requestAnimationFrame(flushPointerMove);
  }

  async function finishRootDrop(targetId, drag) {
    const targetAsset = state.assets.find((asset) => asset.id === targetId);
    if (!targetAsset) return false;
    const movingIds = [...drag.assetIds];
    if (targetAsset.stack?.id) {
      const toAdd = movingIds.filter((id) => id !== targetId);
      if (!toAdd.length) return false;
      await apiFetch(`/api/asset-stacks/${encodeURIComponent(targetAsset.stack.id)}/assets`, {
        method: "POST",
        body: { projectId: state.project, assetIds: toAdd },
      });
      gallerySelection.clear();
      await librarySync.applyLocalChanges([{
        kind: "stack-members-changed",
        entityType: "stack",
        entityId: targetAsset.stack.id,
        assetIds: toAdd,
      }]);
      showToast?.(t("stackAssetsAdded", { count: toAdd.length }), "success");
      return true;
    }
    // Dropping a multi-selection back onto one of its own members is a common
    // tiny mouse-jitter path. Treat it as a no-op instead of unexpectedly
    // creating a new Stack from the selection.
    if (movingIds.includes(targetId)) return false;
    const ids = [...movingIds, targetId];
    if (ids.length < 2) return false;
    const result = await apiFetch("/api/asset-stacks", {
      method: "POST",
      body: { projectId: state.project, assetIds: ids, coverAssetId: targetId },
    });
    gallerySelection.clear();
    await librarySync.applyLocalChanges([{
      kind: "stack-created",
      entityType: "stack",
      entityId: result?.stack?.id || "",
      assetIds: ids,
      detail: { coverAssetId: targetId },
    }]);
    showToast?.(t("stackCreated", { count: ids.length }), "success");
    return true;
  }

  async function finishReorder(targetId, drag, placement) {
    if (!targetId || drag.assetIds.includes(targetId)) return false;
    const currentIds = state.assets.map((asset) => asset.id);
    const nextIds = moveBlockRelative(currentIds, drag.assetIds, targetId, placement);
    if (nextIds.join("\u001f") === currentIds.join("\u001f")) return false;
    try {
      await apiFetch(`/api/asset-stacks/${encodeURIComponent(state.activeStackId)}/order`, {
        method: "PATCH",
        body: { projectId: state.project, assetIds: nextIds },
      });
    } catch (error) {
      if (error?.code !== "STACK_ORDER_MISMATCH") throw error;
      // A concurrent membership change can legitimately make the drag snapshot
      // stale between pointerdown and PATCH. Refresh from the server and surface
      // a recovery message instead of leaking the store's validation prose.
      await loadAssets({ preserveScroll: true });
      const staleOrderError = new Error(t("stackOrderChanged"));
      staleOrderError.code = error.code;
      throw staleOrderError;
    }
    await librarySync.applyLocalChanges([{
      kind: "stack-order-changed",
      entityType: "stack",
      entityId: state.activeStackId,
      assetIds: nextIds,
    }]);
    return true;
  }

  function endPointer(event, { canceled = false } = {}) {
    if (!pointer || pointer.id !== event.pointerId) return;
    // A synthetic/test gesture (and a very fast real gesture) can deliver
    // pointerup before the coalesced animation frame runs. Resolve the latest
    // pointer position synchronously so the drop target is never lost.
    if (pointerMoveFrame !== null) {
      cancelAnimationFrame(pointerMoveFrame);
      pointerMoveFrame = null;
      flushPointerMove();
    }
    const drag = pointer;
    const completed = drag.dragging;
    const targetId = dropTarget?.dataset.id || "";
    const placement = dropPlacement;
    const groupTarget = dropGroupTarget;
    pointer = null;
    state.assetStackDragCandidate = false;
    releasePointerCapture(drag.id);
    removeGhost();
    if (!completed || canceled) {
      return;
    }
    suppressSyntheticClick();
    event.preventDefault();
    // 侧边栏投放优先：分组项 → 移入该组；“待整理”项 → 移出分组。
    if (groupTarget) {
      const item = groupTarget;
      const filter = item.dataset.filter;
      const value = filter === "group" ? item.dataset.value : "";
      void runStackMutation(() => drag.stackId
        ? finishStackGroupDrop(drag.stackId, value)
        : finishGroupDrop(drag.assetIds, value));
      return;
    }
    if (!targetId) return;
    void runStackMutation(() => state.activeStackId
      ? finishReorder(targetId, drag, placement)
      : finishRootDrop(targetId, drag));
  }

  /** 批量改归属 + 本地增量（assets-updated 带 group 标志）。 */
  async function finishGroupDrop(assetIds, groupName) {
    if (!assetIds.length) return false;
    await apiFetch("/api/assets/batch", {
      method: "POST",
      body: { action: "group", projectId: state.project, assetIds: [...assetIds], group: groupName },
    });
    gallerySelection.clear();
    await librarySync.applyLocalChanges([{
      kind: "assets-updated",
      entityType: "asset-batch",
      entityId: "group-assignment",
      assetIds: [...assetIds],
      flags: ["group"],
    }]);
    showToast(groupName
      ? t("moveToGroupCount", { count: assetIds.length, group: groupName })
      : t("removeFromGroupCount", { count: assetIds.length }), "success");
    return true;
  }

  async function finishStackGroupDrop(stackId, groupName) {
    if (!stackId) return false;
    const response = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/group`, {
      method: "POST",
      body: { projectId: state.project, group: groupName },
    });
    const assetIds = Array.isArray(response?.stack?.assetIds) ? response.stack.assetIds : [];
    gallerySelection.clear();
    if (assetIds.length) {
      await librarySync.applyLocalChanges([{
        kind: "assets-updated",
        entityType: "asset-batch",
        entityId: "group-assignment",
        assetIds,
        flags: ["group"],
      }]);
    }
    showToast(groupName
      ? t("stackMovedToGroup", { group: groupName })
      : t("stackRemovedFromGroup"), "success");
    return true;
  }

  function abandonStackContext() {
    cancelPointerGesture();
    state.activeStackId = "";
    state.activeStackSummary = null;
    state.stackReturnSnapshot = null;
    gallerySelection.clear();
    syncChrome();
  }

  function isBusy() {
    return mutationInFlight;
  }

  function bind() {
    els.assetGrid?.addEventListener("pointerdown", beginPointer);
    els.assetGrid?.addEventListener("click", (event) => {
      if (!suppressClickAfterDrag) return;
      suppressClickAfterDrag = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, { capture: true });
    els.assetGrid?.addEventListener("lostpointercapture", () => {
      if (pointer?.dragging) cancelPointerGesture({ releaseCapture: false });
    });
    window.addEventListener("pointermove", movePointer, { passive: false });
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", (event) => endPointer(event, { canceled: true }));
    window.addEventListener("blur", () => { cancelPointerGesture(); });
    // 任务 123：堆叠返回按钮已删除——退出堆叠统一走后退按钮 / ⌘[ / Esc / 右键
    // 菜单，全部经 exitStack 登记历史。堆叠因不存在而消失时丢掉堆叠记录。
    window.addEventListener("mosa:active-stack-missing", (event) => {
      if (!state.activeStackId || event.detail?.stackId !== state.activeStackId) return;
      void exitMissingStack();
    });
    window.addEventListener("mosa:open-stack", (event) => {
      if (state.activeStackId || !event.detail?.stackId) return;
      void enterStack(event.detail.stackId, event.detail.stack || null);
    });
    syncChrome();
  }

  return {
    bind,
    enterStack,
    exitStack,
    exitMissingStack,
    createStackFromSelection,
    removeSelectedFromStack,
    abandonStackContext,
    isBusy,
    syncChrome,
  };
}

export { moveBlockBefore, moveBlockRelative };
