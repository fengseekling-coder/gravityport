/**
 * Context Menu Actions for MOSA
 * Defines all context menu items and their actions
 */

import { sanitizeAssetForExport, moveToTrashConfirmSuppressed, CONFIRM_MOVE_TO_TRASH_KEY } from "./utils.mjs";

export function createContextMenuActions({ state, els, t, apiClient, showToast, runAction, requestConfirmation, requestFollowupConfirmation, confirmDetailNavigation, discardDetailDraft, releaseAssetMedia, openGroupModal, openStackRenameModal, loadAssets, getGroupColor, writeClipboardText, copyOriginalImage, isVideoAsset, pasteClipboardImage, assetStacks, cutPaste, emptyTrash, gallerySelection }) {
  const { apiFetch } = apiClient;
  // getGroupColor falls back to the deterministic palette so call sites can rely
  // on a single source of truth for group colors (mirrors app.mjs colorForGroup).
  const resolveGroupColor = typeof getGroupColor === "function" ? getGroupColor : () => "#6366f1";
  // Mirrors the server's MAX_BATCH_ASSET_IDS cap on /api/assets/batch.
  const MAX_STACK_TRASH_BATCH = 1000;

  // Same-origin download of a stored media file; the browser/Electron save
  // dialog picks the destination, so no server-side export surface is needed.
  function downloadAssetFile(asset) {
    if (!asset?.image_url) return;
    const link = document.createElement("a");
    link.href = asset.image_url;
    link.download = asset.asset || asset.id;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadJson(fileName, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function safeFileToken(value) {
    return String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  }

  async function confirmSelectedAssetMutation(assets = []) {
    const touchesCurrent = assets.some((asset) => asset?.project_id === state.project && asset?.id === state.selectedId);
    if (!touchesCurrent || !state.detailDirty || typeof confirmDetailNavigation !== "function") return true;
    return confirmDetailNavigation(null);
  }

  function commitSelectedAssetMutation(assets = []) {
    const touchesCurrent = assets.some((asset) => asset?.project_id === state.project && asset?.id === state.selectedId);
    if (touchesCurrent && state.detailDirty && typeof discardDetailDraft === "function") discardDetailDraft();
  }

  function reconcileBatchMutation(assets = [], response = {}) {
    if (!response?.partial) return { succeeded: assets, failed: [] };
    const results = Array.isArray(response.results) ? response.results : [];
    const byId = new Map(results.map((result) => [String(result?.id || ""), result]));
    const succeeded = [];
    const failed = [];
    for (const asset of assets) {
      const result = byId.get(String(asset?.id || ""));
      if (result && result.ok !== false) succeeded.push(asset);
      else failed.push(asset);
    }
    return { succeeded, failed };
  }

  // 任务 94（A4f）：撤销右键移入回收站——只恢复这次成功移走的那几张，逐张走
  // 现有 restore 端点（与回收站范围「还原」菜单同一事件面：refresh-assets 带
  // restoredAssetIds）。全成功不再追加提示（撤销动作本身就是反馈）；有失败照
  // 既有批量口径提示 batchPartialResult。
  async function restoreTrashedSelection(projectId, ids = []) {
    const restored = [];
    let failed = 0;
    for (const id of ids) {
      try {
        await apiFetch(`/api/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(id)}/restore`, { method: "POST" });
        restored.push(id);
      } catch {
        failed += 1;
      }
    }
    if (failed) showToast(t("batchPartialResult", { succeeded: restored.length, failed }), "error");
    if (restored.length) {
      window.dispatchEvent(new CustomEvent("mosa:refresh-assets", { detail: { restoredAssetIds: restored } }));
    }
  }

  function logicalSelectionCount(selectedAssets = [], options = {}) {
    const count = Number(options.selectionCount);
    return Number.isFinite(count) && count > 0 ? count : Math.max(1, selectedAssets.length);
  }

  async function selectedMutationContext(asset, selectedAssets = [], options = {}) {
    const count = logicalSelectionCount(selectedAssets, options);
    const selectionContext = typeof gallerySelection?.captureActionContext === "function"
      ? gallerySelection.captureActionContext()
      : null;
    if (count > 1 && typeof gallerySelection?.resolveSelectedAssetIds === "function") {
      const resolved = await gallerySelection.resolveSelectedAssetIds(selectionContext || undefined);
      if (resolved?.ids?.length) return { ...resolved, selectionContext };
      if (resolved === null) return null;
    }
    return { projectId: selectionContext?.projectId || state.project, ids: [asset.id], selectionContext };
  }

  function mutationContextIsCurrent(context) {
    if (!context) return false;
    if (context.projectId !== state.project) return false;
    return !context.selectionContext
      || typeof gallerySelection?.isActionContextCurrent !== "function"
      || gallerySelection.isActionContextCurrent(context.selectionContext);
  }

  function mutationAssetsForIds(ids = [], projectId = state.project) {
    const loaded = new Map((state.assets || []).map((entry) => [entry.id, entry]));
    return ids.map((id) => loaded.get(id) || { id, project_id: projectId });
  }

  async function applyGroupMutation(projectId, ids, group) {
    return apiFetch("/api/assets/batch", {
      method: "POST",
      body: { action: "group", projectId, assetIds: ids, group },
    });
  }

  async function applyStackGroupMutation(projectId, stackId, group) {
    return apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/group`, {
      method: "POST",
      body: { projectId, group },
    });
  }

  function selectionHasGroupedAsset(asset, selectedAssets = [], options = {}) {
    const count = logicalSelectionCount(selectedAssets, options);
    if (count > 1) {
      const selection = selectedAssets.length ? selectedAssets : [];
      if (selection.some((entry) => String(entry?.group || "").trim())) return true;
      // 折叠 Stack / 跨页选择无法在此刻展开校验时保留入口可用。
      return selection.length !== count;
    }
    return Boolean(String(asset?.group || "").trim());
  }

  /**
   * 版本家族防拆散提示：移动家族的一部分（而非全部）时软确认一次。
   * 家族成员可以合法分属不同分组（删除分组时服务端才硬拦），但多数拆散
   * 是无意的——这里只在已加载行里能判定时提示，不为此发额外请求。
   */
  async function confirmVersionFamilySplit(ids = []) {
    const selected = new Set(ids.map(String));
    const loaded = state.assets || [];
    const straddle = loaded.some((entry) => {
      const parentId = String(entry?.parent_asset_id || "");
      if (parentId && selected.has(entry.id) && !selected.has(parentId)) return true;
      return parentId && !selected.has(entry.id) && selected.has(parentId);
    });
    if (!straddle) return true;
    return requestConfirmation({
      title: t("versionSplitTitle"),
      description: t("versionSplitDescription"),
      confirmLabel: t("versionSplitConfirm"),
      cancelLabel: t("cancel"),
      tone: "warning",
    });
  }

  // Full manifest of one group via the existing paged asset query. Never cap a
  // user's export by an arbitrary asset count: cursor-loop detection provides
  // the safety bound without silently truncating large libraries.
  async function fetchGroupAssets(groupName, projectId = state.project) {
    const collected = [];
    const seenAssetIds = new Set();
    const seenCursors = new Set();
    let cursor = "";
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Group export pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: projectId, group: groupName, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result = await apiFetch(`/api/assets?${params}`);
      for (const asset of result.assets || []) {
        const id = String(asset?.id || "");
        if (id && seenAssetIds.has(id)) continue;
        if (id) seenAssetIds.add(id);
        collected.push(asset);
      }
      cursor = result.page?.nextCursor || "";
      if (!cursor) break;
    }
    return collected;
  }

  /**
   * Get navigation item context menu
   */
  function getNavItemMenu(item, type) {
    const items = [];

    if (type === "group") {
      const otherGroups = (Array.isArray(state.groups.groups) ? state.groups.groups : [])
        .filter((group) => group.name !== item.name);
      const order = (Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => group.name);
      const orderIndex = order.indexOf(item.name);
      items.push(
        {
          label: t("moveGroupUp"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 15 6-6 6 6"/></svg>',
          disabled: orderIndex <= 0,
          action: async () => {
            await runAction(async () => {
              const next = order.slice();
              [next[orderIndex - 1], next[orderIndex]] = [next[orderIndex], next[orderIndex - 1]];
              await apiFetch("/api/group-order", { method: "PATCH", body: { projectId: state.project, names: next } });
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
            });
          },
        },
        {
          label: t("moveGroupDown"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m6 9 6 6 6-6"/></svg>',
          disabled: orderIndex < 0 || orderIndex >= order.length - 1,
          action: async () => {
            await runAction(async () => {
              const next = order.slice();
              [next[orderIndex], next[orderIndex + 1]] = [next[orderIndex + 1], next[orderIndex]];
              await apiFetch("/api/group-order", { method: "PATCH", body: { projectId: state.project, names: next } });
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
            });
          },
        },
        { separator: true },
        {
          label: t("renameGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:rename-group", { detail: { groupName: item.name } }));
          },
        },
        {
          // 单一分组成员模型下“复制分组”不可能复制成员（一个素材只能属于一个
          // 分组），真正有用的是把成员并入另一组并删除当前组。
          label: t("mergeGroupInto"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h13M13 17H3"/><path d="m17 4 3 3-3 3"/><path d="m7 14-3 3 3 3"/></svg>',
          disabled: !otherGroups.length,
          submenu: otherGroups.map((group) => ({
            label: group.name,
            icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${resolveGroupColor(group.name)}"/></svg>`,
            action: async () => {
              const confirmed = await requestConfirmation({
                title: t("mergeGroupTitle", { from: item.name, into: group.name }),
                description: t("mergeGroupDescription", { from: item.name, into: group.name, count: Number(item.count || 0) }),
                confirmLabel: t("mergeGroupConfirm"),
                tone: "warning",
              });
              if (!confirmed) return;
              await runAction(async () => {
                const result = await apiFetch(`/api/groups/${encodeURIComponent(item.name)}/merge`, {
                  method: "POST",
                  body: { projectId: state.project, into: group.name },
                });
                // 本窗口正在浏览被并入的分组时直接跟随到目标分组；跨窗口由
                // journal 的 group-deleted + mergedInto 详情重定向。过滤器语义
                // 变化必须整视图重载，行级增量覆盖不了目标组原有成员。
                if (state.facets.group === item.name) {
                  state.facets.group = result.into || group.name;
                  state.nextCursor = null;
                  await loadAssets?.();
                }
                showToast(t("groupMerged", { into: result.into || group.name, count: result.movedAssets || 0 }), "success");
                window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
              });
            },
          })),
        },
        {
          label: t("exportGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5-5 5 5"/><path d="M12 5v12"/></svg>',
          action: async () => {
            await runAction(async () => {
              const projectId = state.project;
              const assets = await fetchGroupAssets(item.name, projectId);
              // 导出文件可能被分享：素材对象先剥掉本机路径与 /library/ 链接
              //（sanitizeAssetForExport），顶层 exportedAt/project/group 不变。
              downloadJson(`mosa-group-${safeFileToken(item.name)}.json`, {
                exportedAt: new Date().toISOString(),
                project: projectId,
                group: item.name,
                assets: assets.map((asset) => sanitizeAssetForExport(asset)),
              });
              showToast(t("exportStarted"), "success");
            });
          },
        },
        { separator: true },
        {
          label: t("groupStats"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v18h18"/><path d="m7 16 4-4 4 4 6-6"/></svg>',
          action: async () => {
            window.dispatchEvent(new CustomEvent("mosa:show-group-stats", { detail: { groupName: item.name } }));
          },
        },
        { separator: true },
        {
          label: t("deleteGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
          danger: true,
          action: async () => {
            try {
              const confirmed = await requestConfirmation({
                title: t("deleteGroupTitle"),
                description: t("deleteGroupDescription"),
                confirmLabel: t("deleteGroup"),
                tone: "danger",
              });
              if (!confirmed) return;

              const deleteAssets = await requestFollowupConfirmation({
                title: t("deleteGroupAssetsTitle"),
                description: t("deleteGroupAssetsDescription"),
                confirmLabel: t("deleteGroupAssetsAction"),
                cancelLabel: t("keepGroupAssetsAction"),
                tone: "danger",
              });

              const selectedGroupAsset = state.selectedId
                ? state.assets.find((asset) => asset?.id === state.selectedId && asset?.group === item.name)
                : null;
              if (selectedGroupAsset && !(await confirmSelectedAssetMutation([selectedGroupAsset]))) return;

              const params = new URLSearchParams({ project: state.project });
              if (deleteAssets) params.set("deleteAssets", "true");
              await apiFetch(`/api/groups/${encodeURIComponent(item.name)}?${params}`, {
                method: "DELETE",
              });
              if (selectedGroupAsset) commitSelectedAssetMutation([selectedGroupAsset]);
              showToast(t(deleteAssets ? "groupAndAssetsDeleted" : "groupDeleted"), "success");

              // Clear group filter if the deleted group was active. The filter
              // semantics changed, so the gallery reloads under the widened
              // scope instead of reconciling only the affected rows.
              const filterWasActive = state.facets.group === item.name;
              if (filterWasActive) {
                state.facets.group = "";
                state.nextCursor = null;
              }

              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              if (filterWasActive) await loadAssets?.();
              else window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
            } catch (error) {
              console.error("Delete group error:", error);
              showToast(error.message || t("deleteFailed"), "error");
            }
          },
        }
      );
    }

    return items;
  }

  /**
   * Complete active-member manifest of one stack via the existing paged stack
   * query — the same cursor-loop safety bound as fetchGroupAssets(). Only
   * active (non-trashed, non-archived) members are returned, which is exactly
   * the set "move this stack to Trash" must submit.
   */
  async function fetchStackMemberIds(stackId, projectId = state.project) {
    const collected = [];
    const seenAssetIds = new Set();
    const seenCursors = new Set();
    let cursor = "";
    while (true) {
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error("Stack member pagination stalled.");
        seenCursors.add(cursor);
      }
      const params = new URLSearchParams({ project: projectId, limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const result = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}/assets?${params}`);
      for (const member of result.assets || []) {
        const id = String(member?.id || "");
        if (id && !seenAssetIds.has(id)) {
          seenAssetIds.add(id);
          collected.push(id);
        }
      }
      cursor = result.page?.nextCursor || "";
      if (!cursor) break;
    }
    return collected;
  }

  // ===== 统一分区拼装（方案第二节）=====
  // 所有素材菜单的分区都从这里走：空分区整段不出现；只在两段之间补分隔线，
  // 因此天然没有连续、开头或结尾的分隔线。
  function buildSectionedMenu(sections) {
    const items = [];
    for (const section of sections) {
      if (!Array.isArray(section) || !section.length) continue;
      if (items.length) items.push({ separator: true });
      items.push(...section);
    }
    return items;
  }

  // 选区信息表头：只在多选时出现，纯展示不可点（context-menu.mjs 按 heading
  // 渲染，数量同时进菜单 aria-label）。
  function selectionHeadingItem(count) {
    return { heading: t("batchSelected", { count }) };
  }

  function selectAllMenuItem() {
    return {
      label: t("selectAll"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>',
      shortcut: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘A" : "Ctrl+A",
      disabled: !state.pageTotal,
      action: async () => {
        await gallerySelection?.selectAll?.({ announce: true });
      },
    };
  }

  function deselectAllMenuItem() {
    return {
      label: t("deselectAll"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
      shortcut: "Esc",
      action: async () => {
        gallerySelection?.clear?.({ announce: true });
      },
    };
  }

  // 任务 93：剪切（91 的占位项启用）。单张、多选都能用；多选里混有折叠
  // Stack 节点时置灰（堆叠卡片本身不可剪切——要搬里面的图先进堆叠再剪）。
  // 动作与 ⌘/Ctrl+X 走同一控制器入口（cut-paste.mjs cutAssetIds）。
  function cutMenuItem(contextAsset, contextSelectedAssets, contextOptions, { disabled = false } = {}) {
    return {
      label: t("cut"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12"/></svg>',
      disabled: disabled || typeof cutPaste?.cutAssetIds !== "function",
      action: async () => {
        const context = await selectedMutationContext(contextAsset, contextSelectedAssets, contextOptions);
        if (!context) return;
        await cutPaste.cutAssetIds(context.ids, { projectId: context.projectId });
      },
    };
  }

  // 任务 93：剪切内容就绪时，堆叠卡片菜单最前面的「粘贴到此堆叠」（自成一组）。
  function pasteIntoStackMenuItem(stackId, stackName) {
    return {
      label: t("pasteIntoStack"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      action: async () => {
        await cutPaste.pasteCut({ stackId, stackName });
      },
    };
  }

  // ===== 堆叠卡片菜单与堆叠内部空白处菜单共用的堆叠操作 =====
  // 重命名：确认弹窗由共享 rename modal 收集，持久化与刷新只有这一份。
  function openStackRenameDialog({ stackId, initialName, onRenamed } = {}) {
    openStackRenameModal?.({
      initialValue: String(initialName || ""),
      confirmLabel: t("renameStack"),
      onSubmit: async (nextName) => {
        let succeeded = false;
        await runAction(async () => {
          await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}`, {
            method: "PATCH",
            body: { projectId: state.project, name: nextName },
          });
          succeeded = true;
          showToast(t("stackRenamed"), "success");
          // Node rows re-render through the incremental path; the member ids
          // let every open window refresh its node card.
          window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
            detail: { stackUpdated: { id: stackId } },
          }));
          if (onRenamed) await onRenamed(nextName);
        });
        return succeeded;
      },
    });
  }

  // 解散：确认 + DELETE + 计数 toast + 增量刷新只有这一份。堆叠内部空白处
  // 通过 onDissolved 接 exitMissingStack 退回素材库（堆叠已不存在，历史登记
  // 按「丢失堆叠记录」处理，任务 123）。
  async function confirmAndDissolveStack({ stackId, stackCount = 0, onDissolved } = {}) {
    const confirmed = await requestConfirmation({
      title: t("dissolveStackTitle"),
      description: t("dissolveStackDescription"),
      confirmLabel: t("dissolveStack"),
      tone: "warning",
    });
    if (!confirmed) return false;
    await runAction(async () => {
      const result = await apiFetch(`/api/asset-stacks/${encodeURIComponent(stackId)}`, {
        method: "DELETE",
        body: { projectId: state.project },
      });
      // The server echoes the member ids it released; prefer that over
      // the possibly stale menu-time count.
      const releasedCount = Array.isArray(result?.assetIds) && result.assetIds.length ? result.assetIds.length : stackCount;
      showToast(t("stackDissolvedCount", { count: releasedCount }), "success");
      window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
        detail: { stackDissolved: { id: stackId } },
      }));
      if (onDissolved) await onDissolved();
    });
    return true;
  }

  // 堆叠 mutation（拖拽/建堆/移出）进行中的置灰口径：菜单构建时读控制器的
  // mutationInFlight，与原底部栏按钮的禁用口径一致。
  const stackMutationInFlight = () => Boolean(assetStacks?.isBusy?.());

  /**
   * Get single asset context menu
   */
  function getAssetMenu(asset, selectedAssets = [], options = {}) {
    if (state.scope === "trash") {
      const selectionCount = logicalSelectionCount(selectedAssets, options);
      const isMultiple = selectionCount > 1;
      return buildSectionedMenu([
        ...(isMultiple ? [[selectionHeadingItem(selectionCount)]] : []),
        [
        {
          label: selectionCount > 1 ? t("restoreAssets", { count: selectionCount }) : t("restoreAsset"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8v5h5"/><path d="M5.5 13a7 7 0 1 0 2-7"/></svg>',
          action: async () => {
            await runAction(async () => {
              const context = await selectedMutationContext(asset, selectedAssets, options);
              if (!context || !mutationContextIsCurrent(context)) return;
              const { ids, projectId } = context;
              const assets = mutationAssetsForIds(ids, projectId);
              for (const item of assets) {
                await apiFetch(`/api/assets/${encodeURIComponent(item.project_id)}/${encodeURIComponent(item.id)}/restore`, { method: "POST" });
              }
              if (!mutationContextIsCurrent(context)) return;
              showToast(assets.length > 1 ? t("assetsRestored", { count: assets.length }) : t("assetRestored"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                detail: { restoredAssetIds: assets.map((item) => item.id) },
              }));
            });
          },
        },
        ],
        ...(isMultiple ? [[selectAllMenuItem(), deselectAllMenuItem()]] : []),
        [
        {
          label: t("permanentDelete"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4h8v2m2 0-1 15H7L6 6"/><path d="M10 10v7M14 10v7"/></svg>',
          danger: true,
          action: async () => {
            const context = await selectedMutationContext(asset, selectedAssets, options);
            if (!context || !mutationContextIsCurrent(context)) return;
            const { ids, projectId } = context;
            const assets = mutationAssetsForIds(ids, projectId);
            const confirmed = await requestConfirmation({
              title: assets.length > 1 ? t("permanentDeleteAssetsTitle", { count: assets.length }) : t("permanentDeleteTitle"),
              description: t("permanentDeleteDescription"),
              confirmLabel: t("permanentDelete"),
              tone: "danger",
            });
            if (!confirmed || !mutationContextIsCurrent(context)) return;
            await runAction(async () => {
              await releaseAssetMedia?.(assets);
              const failed = [];
              for (const item of assets) {
                try {
                  await apiFetch(`/api/assets/${encodeURIComponent(item.project_id)}/${encodeURIComponent(item.id)}/permanent`, { method: "DELETE" });
                } catch (error) {
                  failed.push({ assetId: item.id, error });
                }
              }
              if (!mutationContextIsCurrent(context)) return;
              if (failed.length) showToast(t("trashPartialDelete", { count: failed.length }), "error");
              else showToast(assets.length > 1 ? t("assetsPermanentlyDeleted", { count: assets.length }) : t("assetPermanentlyDeleted"), "success");
              window.dispatchEvent(new CustomEvent("mosa:refresh-groups"));
              window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                detail: { permanentlyDeletedAssetIds: assets.filter((item) => !failed.some((entry) => entry.assetId === item.id)).map((item) => item.id) },
              }));
            });
          },
        },
        ],
      ]);
    }
    // Collapsed Stack node. Management actions follow the shared asset-menu
    // grammar: routine actions on top, structural actions after one separator,
    // the destructive action last with the shared danger styling. Dissolve and
    // Trash are deliberately different operations: dissolve only removes the
    // grouping, while Trash sends every active member through the ordinary
    // per-asset Trash mutation. The stack row and its memberships are NOT
    // trashed — asset_stacks has no deleted state — they are retained so that
    // restoring members rebuilds the stack; the node disappears from the
    // gallery purely because no active member remains.
    if (options.stackNode && asset?.stack?.id && logicalSelectionCount(selectedAssets, options) === 1) {
      const stackId = asset.stack.id;
      const stackCount = Math.max(0, Number(asset.stack.count || 0));
      const moveStackToGroup = (groupName) => async () => {
        const projectId = state.project;
        await runAction(async () => {
          const response = await applyStackGroupMutation(projectId, stackId, groupName);
          const assetIds = Array.isArray(response?.stack?.assetIds) ? response.stack.assetIds : [];
          showToast(
            groupName ? t("stackMovedToGroup", { group: groupName }) : t("stackRemovedFromGroup"),
            "success",
          );
          window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
            detail: { projectId, updatedAssetIds: assetIds, groupChanged: true },
          }));
        });
      };
      // 任务 93：剪切内容就绪时，菜单最前面多一段「粘贴到此堆叠」（移进这个堆叠）。
      return buildSectionedMenu([
        ...(cutPaste?.isCutActive?.() ? [[pasteIntoStackMenuItem(stackId, asset.stack.name)]] : []),
        [
          {
            label: t("openStack"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16v12H4z"/><path d="m9 10 3 3 3-3"/></svg>',
            action: async () => {
              window.dispatchEvent(new CustomEvent("mosa:open-stack", { detail: { stackId, stack: asset.stack } }));
            },
          },
        ],
        [
          {
            label: t("addToGroup"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
            submenu: [
              {
                label: t("createGroupWithSelection"),
                action: async () => {
                  const projectId = state.project;
                  openGroupModal?.({
                    onCreated: async (groupName) => {
                      if (projectId !== state.project) return;
                      const response = await applyStackGroupMutation(projectId, stackId, groupName);
                      const assetIds = Array.isArray(response?.stack?.assetIds) ? response.stack.assetIds : [];
                      showToast(t("stackMovedToGroup", { group: groupName }), "success");
                      window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                        detail: { projectId, updatedAssetIds: assetIds, groupChanged: true },
                      }));
                    },
                  });
                },
              },
              { separator: true },
              ...(Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => ({
                label: group.name,
                icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${resolveGroupColor(group.name)}"/></svg>`,
                action: moveStackToGroup(group.name),
              })),
            ],
          },
          {
            label: t("removeFromGroup"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m9 12 6 0"/></svg>',
            action: moveStackToGroup(""),
          },
        ],
        [
          {
            label: t("renameStack"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
            disabled: typeof openStackRenameModal !== "function",
            action: () => openStackRenameDialog({ stackId, initialName: asset.stack.name }),
          },
          {
            label: t("dissolveStack"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h8M8 12h8M8 17h8"/><path d="M4 7h.01M4 12h.01M4 17h.01"/></svg>',
            action: () => confirmAndDissolveStack({ stackId, stackCount }),
          },
        ],
        [
          {
            label: t("moveToTrash"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
          danger: true,
          action: async () => {
            // Freeze the source project before the first await. The user may
            // navigate while a confirmation dialog or a large multi-batch Trash
            // operation is in flight; the mutation must keep targeting the
            // Stack that opened this menu instead of following later UI state.
            const projectId = state.project;
            const confirmed = await requestConfirmation({
              title: t("stackTrashTitle"),
              description: t("stackTrashDescription", { count: stackCount }),
              confirmLabel: t("moveToTrash"),
              tone: "danger",
            });
            if (!confirmed) return;
            await runAction(async () => {
              // Trash reuses the ordinary per-asset trash mutation: members
              // keep their stack membership while trashed, so restoring them
              // rebuilds the stack without any extra bookkeeping.
              const memberIds = await fetchStackMemberIds(stackId, projectId);
              if (!memberIds.length) return;
              const assets = mutationAssetsForIds(memberIds, projectId);
              if (!await confirmSelectedAssetMutation(assets)) return;
              let failed = 0;
              let processed = 0;
              let interrupted = null;
              const trashedIds = [];
              for (let index = 0; index < memberIds.length; index += MAX_STACK_TRASH_BATCH) {
                const chunk = memberIds.slice(index, index + MAX_STACK_TRASH_BATCH);
                try {
                  const response = await apiFetch("/api/assets/batch", {
                    method: "POST",
                    body: { action: "trash", projectId, assetIds: chunk },
                  });
                  const outcome = reconcileBatchMutation(chunk.map((id) => ({ id, project_id: projectId })), response);
                  processed += chunk.length;
                  failed += outcome.failed.length;
                  trashedIds.push(...outcome.succeeded.map((entry) => entry.id));
                  commitSelectedAssetMutation(outcome.succeeded);
                } catch (error) {
                  // A thrown request is different from a 207 response: the
                  // current chunk may have committed server-side before the
                  // client lost the response, so its outcome is unknown rather
                  // than safely retryable. Stop here and report the known and
                  // unresolved counts without claiming all-or-nothing failure.
                  interrupted = error;
                  break;
                }
              }
              if (trashedIds.length) {
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                  detail: { projectId, removedAssetIds: trashedIds },
                }));
              }
              if (interrupted) {
                showToast(t("stackTrashInterrupted", {
                  succeeded: trashedIds.length,
                  failed,
                  unresolved: Math.max(0, memberIds.length - processed),
                }), "error");
                return;
              }
              if (failed) showToast(t("batchPartialResult", { succeeded: memberIds.length - failed, failed }), "error");
              else showToast(t("stackMovedToTrash", { count: memberIds.length }), "success");
            });
          },
        },
        ],
      ]);
    }
    const selectionCount = logicalSelectionCount(selectedAssets, options);
    const isMultiple = selectionCount > 1;
    const includesStackNodes = Boolean(isMultiple && gallerySelection?.hasSelectedStacks?.());
    // 多选收藏看整个选区：全部已收藏才显示“取消收藏”，否则一律把全部设为收藏，
    // 不再以右键命中的那一张的状态决定方向。单选时选区就是这一张，规则自然
    // 退化为原有的按素材切换。
    const favoriteNext = !(selectedAssets.length > 0 && selectedAssets.every((entry) => entry.favorite));

    // 分区内容（不适用的分区以 null 整段隐藏，顺序见 buildSectionedMenu）。
    const openSection = !isMultiple
      ? [
          {
            label: t("openInViewer"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
            action: async () => {
              window.dispatchEvent(new CustomEvent("mosa:open-asset-view", { detail: { assetId: asset.id } }));
            },
          },
          {
            label: t("showInFinder"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.27 6.96 8.73 5.04 8.73-5.04M12 22.08V12"/></svg>',
            action: async () => {
              await runAction(async () => {
                try {
                  await apiFetch("/api/open-folder", {
                    method: "POST",
                    body: { path: asset.image_path, reveal: true },
                  });
                } catch (error) {
                  if (error.message.includes("Path not allowed")) throw new Error(t("showInFinderPathNotAllowed"));
                  if (error.message.includes("does not exist")) throw new Error(t("showInFinderNotFound"));
                  throw new Error(t("showInFinderFailed"));
                }
                showToast(t("shownInFinder"), "success");
              });
            },
          },
        ]
      : null;

    // 任务 93：复制段。单张保持「复制图片/剪切/复制提示词/复制路径」（剪切
    // 从占位转正）；多选整段只有「剪切」——多选也能剪切，但选区含折叠 Stack
    // 节点时置灰（堆叠卡片不可剪切）。
    const copySection = !isMultiple
      ? [
          {
            label: t("copyImage"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 2-2 5 5"/></svg>',
            disabled: typeof copyOriginalImage !== "function" || Boolean(isVideoAsset?.(asset)) || !(asset.image_path || asset.image_url),
            action: async () => {
              try {
                await copyOriginalImage(asset);
                showToast(t("imageCopied"), "success");
              } catch {
                showToast(t("copyImageFailed"), "error");
              }
            },
          },
          cutMenuItem(asset, selectedAssets, options),
          {
            label: t("copyPrompt"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
            disabled: !asset.prompt,
            action: async () => {
              try {
                await writeClipboardText(asset.prompt || "");
                showToast(t("promptCopied"), "success");
              } catch {
                showToast(t("copyFailed"), "error");
              }
            },
          },
          {
            label: t("copyPath"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
            action: async () => {
              // SQLite store uses image_path (and inspector markup does the same);
              // keep the contract consistent across every call site.
              try {
                await writeClipboardText(asset.image_path);
                showToast(t("pathCopied"), "success");
              } catch {
                showToast(t("copyFailed"), "error");
              }
            },
          },
        ]
      : [cutMenuItem(asset, selectedAssets, options, { disabled: includesStackNodes })];

    // Favorite toggle（整选区方向：全已收藏 → 取消收藏，否则 → 添加到收藏）
    const favoriteItem = {
      label: favoriteNext ? t("addToFavorites") : t("removeFromFavorites"),
      icon: favoriteNext
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>',
      action: async () => {
        const context = await selectedMutationContext(asset, selectedAssets, options);
        if (!context || !mutationContextIsCurrent(context)) return;
        const { ids, projectId } = context;
        const assets = mutationAssetsForIds(ids, projectId);
        await runAction(async () => {
          if (isMultiple) {
            const response = await apiFetch("/api/assets/batch", {
              method: "POST",
              body: {
                action: "favorite",
                projectId,
                assetIds: ids,
                favorite: favoriteNext,
              },
            });
            if (!mutationContextIsCurrent(context)) return;
            const outcome = reconcileBatchMutation(assets, response);
            if (outcome.failed.length) {
              showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
            } else {
              showToast(t("favoriteUpdatedMultiple"), "success");
            }
            } else {
              await apiFetch(`/api/assets/${encodeURIComponent(asset.project_id)}/${encodeURIComponent(asset.id)}/favorite`, {
                method: "POST",
              });
              if (!mutationContextIsCurrent(context)) return;
              showToast(asset.favorite ? t("removedFromFavorites") : t("addedToFavorites"), "success");
            }
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
              detail: { updatedAssetIds: isMultiple ? ids : [asset.id] },
            }));
        });
      },
    };

    // Add to group submenu（任务 91：文案照稿子改「添加分组」，子菜单沿用；
    // 「移除分组」按稿子提为顶层项，移出分组的动作与置灰口径不变。）
    const moveSelectionToGroup = (groupName) => async () => {
      const context = await selectedMutationContext(asset, selectedAssets, options);
      if (!context || !mutationContextIsCurrent(context)) return;
      const { ids, projectId } = context;
      const assets = mutationAssetsForIds(ids, projectId);
      if (!await confirmSelectedAssetMutation(assets)) return;
      if (!await confirmVersionFamilySplit(ids)) return;
      if (!mutationContextIsCurrent(context)) return;
      await runAction(async () => {
        const response = await applyGroupMutation(projectId, ids, groupName);
        if (!mutationContextIsCurrent(context)) return;
        const outcome = reconcileBatchMutation(assets, response);
        commitSelectedAssetMutation(assets);
        if (outcome.failed.length) showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
        else showToast(groupName ? t("movedToGroup") : t("removedFromGroup"), "success");
        window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
          detail: { updatedAssetIds: outcome.succeeded.map((entry) => entry.id), groupChanged: true },
        }));
      });
    };
    const organizeSection = [
      favoriteItem,
      {
      label: t("addToGroup"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
      submenu: [
        {
          // 建组即分配：弹窗创建成功后把当前选中的素材直接移入新分组，
          // 不再让用户回到画廊右键第二轮。
          label: t("createGroupWithSelection"),
          action: async () => {
            const context = await selectedMutationContext(asset, selectedAssets, options);
            if (!context) return;
            const { ids, projectId } = context;
            openGroupModal?.({
              onCreated: async (groupName) => {
                if (projectId !== state.project) return;
                const assets = mutationAssetsForIds(ids, projectId);
                const response = await applyGroupMutation(projectId, ids, groupName);
                const outcome = reconcileBatchMutation(assets, response);
                commitSelectedAssetMutation(assets);
                if (outcome.failed.length) showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error");
                else showToast(t("movedToGroup"), "success");
                window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
                  detail: { updatedAssetIds: outcome.succeeded.map((entry) => entry.id), groupChanged: true },
                }));
              },
            });
          },
        },
        { separator: true },
        ...(Array.isArray(state.groups.groups) ? state.groups.groups : []).map((group) => {
          const groupName = group.name;
          // Source of truth for group colors lives in app.mjs colorForGroup so
          // the saved palette and the rendered swatch never diverge.
          const savedColor = resolveGroupColor(groupName);
          return {
            label: groupName,
            icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${savedColor}"/></svg>`,
            action: moveSelectionToGroup(groupName),
          };
        }),
      ],
      },
      {
        // 移出分组：后端批量接口传空分组名即解除归属。任务 91 把它从子菜单
        // 提为顶层项（稿子分组 3 的第三项），置灰口径沿用原子菜单项。
        label: t("removeFromGroup"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m9 12 6 0"/></svg>',
        disabled: !selectionHasGroupedAsset(asset, selectedAssets, options),
        action: moveSelectionToGroup(""),
      },
    ];
    // 任务 91：右键专属的堆叠操作（全应用仅此入口）照稿子 5 组之后、「移至
    // 回收站」之前自成一组，只在用得上时出现：堆叠内部是「移出堆叠」（单/
    // 多选都有），根画廊多选是「堆叠所选」。选区含折叠 Stack 节点时两者都不
    // 出现（不支持堆叠套堆叠）。
    let stackSection = null;
    if (state.activeStackId) {
      stackSection = [{
        label: t("removeFromStack"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M4.5 17.5h5"/></svg>',
        disabled: stackMutationInFlight(),
        action: async () => {
          await assetStacks?.removeSelectedFromStack?.();
        },
      }];
    } else if (isMultiple && !includesStackNodes) {
      stackSection = [{
        label: t("stackSelected"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
        disabled: state.storageKind !== "sqlite" || stackMutationInFlight(),
        action: async () => {
          await assetStacks?.createStackFromSelection?.();
        },
      }];
    }

    // 任务 91：导出自成一组（稿子「导出至」）。「查看版本历史」从菜单拿掉：
    // 检视器（点卡片 / 卡片「查看」）就是版本树入口，代码与 i18n key 保留。
    // 选区含折叠 Stack 节点时导出整段不出现（不支持导出堆叠），不再置灰。
    const exportSection = includesStackNodes ? null : [
      {
        label: t("exportTo"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5-5 5 5"/><path d="M12 5v12"/></svg>',
        disabled: isMultiple && selectedAssets.length !== selectionCount,
        action: async () => {
          const assets = isMultiple ? selectedAssets : [asset];
          await runAction(async () => {
            for (const a of assets) {
              downloadAssetFile(a);
            }
            showToast(isMultiple ? t("exportStartedMultiple") : t("exportStarted"), "success");
          });
        },
      },
    ];

    // Danger zone
    const moveToTrashItem =
      {
        label: t("moveToTrash"),
        icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
        danger: true,
        action: async () => {
          const context = await selectedMutationContext(asset, selectedAssets, options);
          if (!context || !mutationContextIsCurrent(context)) return;
          const { ids, projectId } = context;
          const assets = mutationAssetsForIds(ids, projectId);
          // 任务 94（A4f）：勾过「不再提醒」后右键单张/多选直接移入回收站；整组
          // 堆叠的「移至回收站」不走这里（永远确认）。其余守卫照旧。
          if (!moveToTrashConfirmSuppressed()) {
            // 任务 111：按钮写动作（取消 / 移到回收站），不再用「否 / 是」。
            const confirmed = await requestConfirmation({
              title: ids.length > 1 ? t("moveAssetsToTrashTitle", { count: ids.length }) : t("moveToTrashTitle"),
              description: t("moveToTrashDescription"),
              confirmLabel: t("moveToTrash"),
              cancelLabel: t("cancel"),
              tone: "danger",
              dontAskAgainKey: CONFIRM_MOVE_TO_TRASH_KEY,
            });
            if (!confirmed || !mutationContextIsCurrent(context)) return;
          }
          if (!await confirmSelectedAssetMutation(assets)) return;
          if (!mutationContextIsCurrent(context)) return;

          await runAction(async () => {
            const response = await apiFetch("/api/assets/batch", {
              method: "POST",
              body: {
                action: "trash",
                projectId,
                assetIds: ids,
              },
            });
            // 任务 108：服务器已经移走了，结果必须交代给用户。实时同步可能比这次
            // 响应先到、先刷新画廊并改掉选区版本，此时选区上下文已「过期」，但撤销
            // 提示和画廊对账仍要做；只有用户已切到别的素材库才不再交代。
            if (context.projectId !== state.project) return;
            const outcome = reconcileBatchMutation(assets, response);
            commitSelectedAssetMutation(outcome.succeeded);
            if (outcome.failed.length) {
              // 部分失败：成功移走的那几张同样可以撤销。
              showToast(t("batchPartialResult", { succeeded: outcome.succeeded.length, failed: outcome.failed.length }), "error", outcome.succeeded.length ? {
                actionLabel: t("undo"),
                duration: 6000,
                onAction: () => { void restoreTrashedSelection(projectId, outcome.succeeded.map((entry) => entry.id)); },
              } : undefined);
            } else {
              // 任务 94：与大图页删除同样的「已移至回收站 · 撤销」toast（6 秒），
              // 不论这次有没有弹确认框都弹；撤销只恢复本次成功移走的。
              showToast(isMultiple ? t("assetsMovedToTrash", { count: assets.length }) : t("assetMovedToTrash"), "success", {
                actionLabel: t("undo"),
                duration: 6000,
                onAction: () => { void restoreTrashedSelection(projectId, outcome.succeeded.map((entry) => entry.id)); },
              });
            }
            window.dispatchEvent(new CustomEvent("mosa:refresh-assets", {
              detail: { removedAssetIds: outcome.succeeded.map((entry) => entry.id) },
            }));
          });
        },
      };

    // 统一分区（任务 91 稿子顺序）：选区信息 → 打开 → 复制 → 收藏与分组 →
    // 导出 → 堆叠（仅适用时）→ 危险。全选/取消选择从素材菜单拿掉（⌘A / Esc
    // 键盘入口保留）；「查看版本历史」同批拿掉（检视器有版本树入口）。
    return buildSectionedMenu([
      isMultiple ? [selectionHeadingItem(selectionCount)] : null,
      openSection,
      copySection,
      organizeSection,
      exportSection,
      stackSection,
      [moveToTrashItem],
    ]);
  }

  /**
   * Get empty grid context menu — 三种空白处场景（右键菜单统一方案第三节）：
   * 画廊空白 / 堆叠内部空白 / 回收站空白，各自只保留适用分区。
   */
  function getEmptyGridMenu() {
    // 空白处粘贴项（任务 93 分流）：剪切内容就绪 → 「粘贴」执行移动（堆叠内
    // 进当前堆叠；非堆叠画廊视图移出成散图，目标判定与 ⌘V 同一入口）；
    // 没有剪切内容 → 原有「从剪贴板粘贴」导入。回收站是只读范围：两者都不
    // 提供（拖拽与 Ctrl/Cmd+V 导入同样被禁用）。
    const pasteItem = state.scope === "trash" ? [] : (cutPaste?.isCutActive?.() ? [{
      label: t("pasteCut"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      action: async () => {
        await cutPaste.pasteCut({});
      },
    }] : [{
      label: t("pasteFromClipboard"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      disabled: typeof pasteClipboardImage !== "function",
      action: async () => {
        const pasted = await pasteClipboardImage?.();
        if (pasted === false) showToast(t("clipboardNoImage"), "default");
      },
    }]);
    const refreshItem = {
      label: t("refreshLibrary"),
      icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6m12-4a9 9 0 0 1-15 6.7L3 16"/></svg>',
      action: async () => {
        window.dispatchEvent(new CustomEvent("mosa:refresh-assets"));
        showToast(t("refreshing"), "default");
      },
    };

    // 回收站空白：全选、刷新 ｜ 清空回收站（危险，确认弹窗照旧）。“添加分组”
    // 在回收站没有意义，不再出现；顶栏“清空回收站”按钮保留。
    if (state.scope === "trash") {
      return buildSectionedMenu([
        [
          selectAllMenuItem(),
          refreshItem,
        ],
        [
          {
            label: t("emptyTrash"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/></svg>',
            danger: true,
            disabled: typeof emptyTrash !== "function" || !Number(state.groups?.trash || 0),
            action: async () => {
              await emptyTrash?.();
            },
          },
        ],
      ]);
    }

    // 堆叠内部空白：返回素材库 ｜ 粘贴（进当前堆叠）｜ 当前堆叠的重命名与
    // 解散（复用堆叠卡片菜单的共用实现）｜ 全选、刷新。堆叠里没有“新建分组”。
    if (state.activeStackId) {
      const stackId = state.activeStackId;
      return buildSectionedMenu([
        [
          {
            label: t("backToLibrary"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 18-6-6 6-6"/></svg>',
            disabled: typeof assetStacks?.exitStack !== "function",
            action: async () => {
              await assetStacks?.exitStack?.();
            },
          },
        ],
        [
          ...pasteItem,
        ],
        [
          {
            label: t("renameStack"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
            disabled: typeof openStackRenameModal !== "function" || stackMutationInFlight(),
            action: () => openStackRenameDialog({
              stackId,
              initialName: state.activeStackSummary?.name,
              onRenamed: (nextName) => {
                if (state.activeStackSummary) state.activeStackSummary = { ...state.activeStackSummary, name: nextName };
                assetStacks?.syncChrome?.();
              },
            }),
          },
          {
            label: t("dissolveStack"),
            icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 7h8M8 12h8M8 17h8"/><path d="M4 7h.01M4 12h.01M4 17h.01"/></svg>',
            disabled: stackMutationInFlight(),
            action: () => confirmAndDissolveStack({
              stackId,
              stackCount: Math.max(0, Number(state.activeStackSummary?.count || state.assets.length || 0)),
              // 任务 123：解散后的退出是「堆叠已不存在」——光标退回根位置并丢掉
              // 堆叠记录，前进按钮保持灰；与普通退出（返回素材库）的登记区分开。
              onDissolved: () => assetStacks?.exitMissingStack?.(),
            }),
          },
        ],
        [
          selectAllMenuItem(),
          refreshItem,
        ],
      ]);
    }

    // 画廊空白：粘贴、新建分组 ｜ 全选、刷新素材库。
    return buildSectionedMenu([
      [
        ...pasteItem,
        {
          label: t("createGroup"),
          icon: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6M9 14h6"/></svg>',
          action: async () => {
            openGroupModal?.();
          },
        },
      ],
      [
        selectAllMenuItem(),
        refreshItem,
      ],
    ]);
  }

  return {
    getNavItemMenu,
    getAssetMenu,
    getEmptyGridMenu,
  };
}
