// ===== Phase 5B / F-15：全应用唯一 ConfirmDialog（提取自 app.js，REFACTORING-PLAN R1 批次 3）=====
// els/state/t/closePanel 经 createConfirmDialog 工厂注入；单 pending Promise、焦点/Escape
// 生命周期、焦点恢复策略与原先完全一致；confirmDialogState 随闭包迁移并原样暴露。
// 任务 94（A4f）：requestConfirmation 可选 dontAskAgainKey——传入才显示「不再提醒」
// 勾选框，只有点「是」且勾选时写入该键（"off"）；否/Esc/遮罩一律不记，每次打开都未勾选。
// 任务 116：requestConfirmation 可选 hideCancel——单按钮提示弹窗（老用户「已更名」
// 提示）用，取消按钮整颗隐藏（hidden 属性；按钮类自带 display，靠 styles.css 里
// .confirm-dialog-actions [hidden] 那条规则才真正不显示），打开焦点落确认按钮；
// 关闭时由 closeConfirmDialog 统一恢复 hidden=false，普通确认框行为与以前完全一致。

import { safeStorageSet } from "./utils.mjs";

export function createConfirmDialog({ els, state, t, closePanel }) {
  // ===== Confirm Dialog（Phase 5B / F-15） =====
  // 全应用唯一 ConfirmDialog。业务只传文案、tone 与可选的显式焦点返回目标；
  // 不持久化到 state/localStorage/素材数据，不建确认队列或第二套 Modal Manager。
  const confirmDialogState = { pending: false, resolve: null, returnFocus: null, triggerElement: null, dontAskAgainKey: null, hideCancel: false };

  // 单 pending 策略：已有确认显示时，新请求直接返回 false——不排队、第二个请求不覆盖
  // 第一个 resolver，两个不同业务绝不共享同一确认结果（重复快速点击不叠加第二个 Modal）。
  function requestConfirmation({ title = "", description = "", confirmLabel = "", cancelLabel = "", tone = "danger", returnFocus = null, dontAskAgainKey = "", hideCancel = false } = {}) {
    if (confirmDialogState.pending || !els.confirmDialog) return Promise.resolve(false);
    // 打开前保存当前焦点元素，并关闭 Settings，避免两个 modal surface 叠加。
    confirmDialogState.triggerElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closePanel(els.settingsMenu, els.settingsToggle, "confirm-dialog");
    // 3）填充标题/说明/按钮文案与 tone；4）打开 overlay。
    if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = title;
    if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = description;
    if (els.confirmDialogConfirm) {
      els.confirmDialogConfirm.textContent = confirmLabel;
      // tone：danger → DestructiveButton 红色 outline；warning → primary 层级（品牌蓝），不误用归档红色语义。
      els.confirmDialogConfirm.classList.toggle("btn-danger", tone === "danger");
      els.confirmDialogConfirm.classList.toggle("btn-primary", tone !== "danger");
    }
    if (els.confirmDialogCancel) {
      els.confirmDialogCancel.textContent = cancelLabel || t("cancel");
      // 单按钮提示模式：取消按钮用 hidden 整颗拿掉（无障碍与 Tab 都跳过）。
      els.confirmDialogCancel.hidden = hideCancel === true;
    }
    confirmDialogState.hideCancel = hideCancel === true;
    if (els.confirmDialogCard) els.confirmDialogCard.dataset.tone = tone === "danger" ? "danger" : "warning";
    // 「不再提醒」行只对传入 dontAskAgainKey 的调用出现，且每次打开都是未勾选。
    confirmDialogState.dontAskAgainKey = typeof dontAskAgainKey === "string" && dontAskAgainKey ? dontAskAgainKey : null;
    if (els.confirmDialogDontAsk) {
      els.confirmDialogDontAsk.hidden = !confirmDialogState.dontAskAgainKey;
      if (els.confirmDialogDontAskCheckbox) els.confirmDialogDontAskCheckbox.checked = false;
    }
    confirmDialogState.pending = true;
    confirmDialogState.returnFocus = returnFocus instanceof HTMLElement ? returnFocus : null;
    // The dialog sits outside #appShell; inert keeps the complete application
    // background out of assistive-technology and keyboard navigation while it is open.
    els.appShell?.setAttribute("inert", "");
    els.confirmDialog.classList.add("open");
    els.confirmDialog.setAttribute("aria-hidden", "false");
    return new Promise((resolve) => {
      confirmDialogState.resolve = resolve;
      // 默认焦点：双按钮落 Cancel——破坏性操作不得默认聚焦确认按钮；单按钮提示
      // 模式只有确认按钮可点，焦点落「知道了」。焦点不落容器或 body。
      requestAnimationFrame(() => { if (confirmDialogState.pending) (confirmDialogState.hideCancel ? els.confirmDialogConfirm : els.confirmDialogCancel)?.focus(); });
    });
  }

  async function requestFollowupConfirmation(options = {}) {
    // A follow-up must not reopen the same transitioning overlay in the same
    // frame. Give the closed state two paints so the next dialog is guaranteed
    // to materialize as a distinct confirmation instead of being swallowed by
    // the discrete display/opacity transition.
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    return requestConfirmation(options);
  }

  function closeConfirmDialog(result) {
    if (!confirmDialogState.pending) return;
    const { resolve } = confirmDialogState;
    confirmDialogState.pending = false;
    confirmDialogState.resolve = null;
    // 「不再提醒」只在点「是」时生效；否/Esc/遮罩（result=false）不写存储。
    if (result === true && confirmDialogState.dontAskAgainKey && els.confirmDialogDontAskCheckbox?.checked) {
      safeStorageSet(confirmDialogState.dontAskAgainKey, "off");
    }
    confirmDialogState.dontAskAgainKey = null;
    // 焦点恢复目标先取走引用再清状态；恢复在下方 inert 移除后同步执行。
    const returnFocus = confirmDialogState.returnFocus;
    const triggerElement = confirmDialogState.triggerElement;
    confirmDialogState.returnFocus = null;
    confirmDialogState.triggerElement = null;
    els.confirmDialog?.classList.remove("open");
    els.confirmDialog?.setAttribute("aria-hidden", "true");
    els.appShell?.removeAttribute("inert");
    // 清理临时文案与 tone，单一 Dialog 壳回到静态空壳（勾选行同样复位为隐藏未勾选；
    // 单按钮模式隐藏过的取消按钮恢复显示，下一次普通确认框与以前完全一样）。
    if (els.confirmDialogTitle) els.confirmDialogTitle.textContent = "";
    if (els.confirmDialogDescription) els.confirmDialogDescription.textContent = "";
    if (els.confirmDialogConfirm) {
      els.confirmDialogConfirm.textContent = "";
      els.confirmDialogConfirm.classList.remove("btn-danger");
      els.confirmDialogConfirm.classList.add("btn-primary");
    }
    if (els.confirmDialogCancel) els.confirmDialogCancel.hidden = false;
    confirmDialogState.hideCancel = false;
    delete els.confirmDialogCard?.dataset.tone;
    if (els.confirmDialogDontAsk) {
      els.confirmDialogDontAsk.hidden = true;
      if (els.confirmDialogDontAskCheckbox) els.confirmDialogDontAskCheckbox.checked = false;
    }
    // 任务 96 返工 2：焦点恢复同步执行（inert 已移除，目标活着就直接聚焦）。
    // 隐藏窗口（e2e/CI）会把 rAF 节流到秒级，恢复不能押在某一次帧回调上——
    // Esc 后焦点必须即刻回到触发按钮，不依赖任何后续帧真的会跑。
    restoreConfirmDialogFocus(returnFocus, triggerElement);
    if (resolve) resolve(result); // Confirm=true；Cancel/Escape/Backdrop=false；resolver 只结算一次
  }

  // 焦点恢复目标必须仍连接、非 disabled、非 hidden 且可见；body 不在候选之列。
  function isConfirmFocusTarget(element) {
    return element instanceof HTMLElement && element.isConnected && !element.disabled && !element.hidden && element.offsetParent !== null;
  }

  // 焦点恢复分两步：先同步尝试（closeConfirmDialog 在移除 inert 之后调用，此时
  // 目标按钮活着就直接聚焦）；同步不可用（目标正待重建替换等）时留一次 rAF 兜底。
  function restoreConfirmDialogFocus(returnFocus, triggerElement) {
    if (restoreFocusInto(returnFocus, triggerElement)) return;
    requestAnimationFrame(() => { restoreFocusInto(returnFocus, triggerElement); });
  }

  function restoreFocusInto(returnFocus, triggerElement) {
    // 优先级 1）业务显式 returnFocus；2）打开前的 activeElement。
    for (const candidate of [returnFocus, triggerElement]) {
      if (isConfirmFocusTarget(candidate)) { candidate.focus(); return true; }
    }
    // 3）安全区：查看模式的返回按钮或搜索框，绝不落回 body。
    const fallback = state.viewMode === "asset" ? els.assetViewBack : els.searchInput;
    if (isConfirmFocusTarget(fallback)) { fallback.focus(); return true; }
    return false;
  }

  function trapConfirmDialogFocus(event) {
    if (!confirmDialogState.pending) return;
    if (event.key === "Escape") {
      // Escape 优先级链最前：消费后不穿透 Viewer/既有 Modal/锚定浮层（后续监听器
      // 经 defaultPrevented 检查，与既有 Modal 陷阱同先例）。
      event.preventDefault();
      event.stopPropagation();
      closeConfirmDialog(false);
      return;
    }
    if (event.key !== "Tab") return;
    // Tab 在 Cancel/Confirm 之间正/反向循环（单按钮模式下 hidden 的取消按钮不在
    // 循环内）；Enter/Space 保持聚焦原生按钮的默认行为，无全局 Enter 自动确认。
    const focusable = [els.confirmDialogCancel, els.confirmDialogConfirm].filter((button) => button && !button.disabled && !button.hidden);
    if (!focusable.length) return;
    const current = focusable.indexOf(document.activeElement);
    const next = event.shiftKey ? (current <= 0 ? focusable.length - 1 : current - 1) : (current === focusable.length - 1 ? 0 : current + 1);
    event.preventDefault();
    focusable[next].focus();
  }

  return {
    requestConfirmation, requestFollowupConfirmation, closeConfirmDialog, trapConfirmDialogFocus, isConfirmFocusTarget, confirmDialogState,
  };
}
