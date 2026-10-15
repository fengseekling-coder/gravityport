// Visual model settings UI description (pure logic, no React/DOM).

export interface VisualPackProgress {
  phase: "preparing" | "downloading" | "verifying" | "installing" | string;
  percent: number;
}

export interface VisualPackRelease {
  id: string;
  total_size: number;
  license?: { id: string };
}

export interface VisualModelDistribution {
  action?: string;
  progress?: VisualPackProgress | null;
  release?: VisualPackRelease;
  error?: unknown;
}

export interface VisualModelStatus {
  state: string;
  installed: boolean;
  enabled: boolean;
  active_pack?: { id: string; revision: string; total_bytes: number };
  distribution?: VisualModelDistribution;
}

export interface VisualModelCaps {
  install: boolean;
  cancel: boolean;
  remove: boolean;
  toggle: boolean;
}

export type VisualModelAction =
  | "install"
  | "update"
  | "cancel"
  | "enable"
  | "disable"
  | "remove";

export interface VisualModelDescription {
  label: string;
  details: string[];
  progress: { phaseLabel: string; percent: number } | null;
  note: string;
  actions: VisualModelAction[];
}

// ---------------------------------------------------------------------------
// describeVisualModel
// ---------------------------------------------------------------------------

/** Returns user-facing description of a visual model status for the settings UI. */
export function describeVisualModel(
  status: VisualModelStatus | null,
  caps: VisualModelCaps,
): VisualModelDescription {
  if (status === null) {
    return { label: "正在检查本地视觉模型…", details: [], progress: null, note: "", actions: [] };
  }

  const label = getStateLabel(status.state);
  const details = buildDetails(status);
  const progress = buildProgress(status, caps);
  const note = buildNote(status);
  const actions = buildActions(status, caps);

  return { label, details, progress, note, actions };
}

function getStateLabel(state: string): string {
  switch (state) {
    case "ready":
      return "已启用，可用于视觉搜索与相似关系";
    case "runtime-unavailable":
      return "模型已安装，但当前构建尚无可用本地推理运行时";
    case "loading":
      return "正在启动本地推理运行时…";
    case "error":
      return "本地视觉模型加载失败，请重新安装或更换模型包";
    case "disabled":
      return "已安装，尚未启用";
    case "not-installed":
      return "未安装视觉模型";
    default:
      return "本地视觉能力不可用";
  }
}

function buildDetails(status: VisualModelStatus): string[] {
  const lines: string[] = [];

  if (status.active_pack) {
    const { id, revision, total_bytes } = status.active_pack;
    const bytes = Number(total_bytes || 0);
    const sizeLabel = bytes > 0 ? ` · ${formatBytes(bytes)}` : "";
    lines.push(`${id} · ${revision}${sizeLabel}`);
  } else if (status.distribution?.release) {
    const rel = status.distribution.release;
    const bytes = Number(rel.total_size || 0);
    const sizeLabel = bytes > 0 ? ` · ${(bytes / (1024 * 1024)).toFixed(0)} MB` : "";
    lines.push(`${rel.id} · ${rel.license?.id || ""}${sizeLabel}`);
  }

  return lines;
}

function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  const decimals = bytes >= 100 * 1024 * 1024 ? 0 : 1;
  return `${mb.toFixed(decimals)} MB`;
}

function buildProgress(
  status: VisualModelStatus,
  caps: VisualModelCaps,
): { phaseLabel: string; percent: number } | null {
  const progress = status.distribution?.progress || null;
  if (!progress) return null;

  const phase = progress.phase;
  if (!["preparing", "downloading", "verifying", "installing"].includes(phase)) return null;

  const rawPercent = Number(progress.percent);
  const percent = Math.max(0, Math.min(100, Math.round(isNaN(rawPercent) ? 0 : rawPercent)));

  const phaseLabel = getPhaseLabel(phase);
  return { phaseLabel, percent };
}

function getPhaseLabel(phase: string): string {
  switch (phase) {
    case "verifying":
      return "正在校验";
    case "installing":
      return "正在安装";
    default:
      return "正在下载";
  }
}

function buildNote(status: VisualModelStatus): string {
  const dist = status.distribution;
  if (dist?.error) return "暂时无法获取视觉能力包发布信息";
  if (!status.installed && dist?.action === "unavailable") {
    return "当前平台暂未发布可安装的视觉能力包";
  }
  return "";
}

function buildActions(status: VisualModelStatus, caps: VisualModelCaps): VisualModelAction[] {
  const actions: VisualModelAction[] = [];
  const progress = status.distribution?.progress || null;

  // During an active download only Cancel replaces Install/Update; whether
  // the cancel bridge exists or not, Install must not reappear mid-download.
  // Toggle and Remove stay available, as in the old settings panel.
  const inProgress = Boolean(
    progress && ["preparing", "downloading", "verifying", "installing"].includes(progress.phase),
  );
  const action = status.distribution?.action;
  if (inProgress) {
    if (caps.cancel) actions.push("cancel");
  } else if ((action === "install" || action === "update") && caps.install) {
    actions.push(action as VisualModelAction);
  }

  // Toggle enable/disable
  if (status.installed && caps.toggle) {
    actions.push(status.enabled ? "disable" : "enable");
  }

  // Remove
  if (status.installed && caps.remove) {
    actions.push("remove");
  }

  return actions;
}

// ---------------------------------------------------------------------------
// applyVisualPackProgress
// ---------------------------------------------------------------------------

/**
 * Applies a visual pack progress update to a visual model status.
 * Returns a new object (does not mutate the original).
 * When phase is in the active set, forces distribution.action to "installing".
 */
export function applyVisualPackProgress(
  status: VisualModelStatus | null,
  progress: VisualPackProgress | null,
): VisualModelStatus | null {
  if (status === null) return null;

  const result: VisualModelStatus = { ...status };
  result.distribution = { ...(status.distribution || {}) };

  result.distribution.progress = progress;

  if (
    progress &&
    ["preparing", "downloading", "verifying", "installing"].includes(progress.phase)
  ) {
    result.distribution.action = "installing";
  }

  return result;
}

// ---------------------------------------------------------------------------
// visualModelActionLabel
// ---------------------------------------------------------------------------

/** Returns the UI label for a visual model action button. */
export function visualModelActionLabel(action: VisualModelAction): string {
  switch (action) {
    case "install":
      return "安装视觉能力包";
    case "update":
      return "更新视觉能力包";
    case "cancel":
      return "取消";
    case "enable":
      return "启用";
    case "disable":
      return "停用";
    case "remove":
      return "删除视觉能力包";
  }
}
