/**
 * App-lifecycle.ts — Pure logic for version-consistency checking and update
 * result mapping. No React, no DOM, no side effects.
 */

// ---------------------------------------------------------------------------
// Version consistency check
// ---------------------------------------------------------------------------

export interface HealthData {
  productVersion?: string
  uiFingerprint?: string
  runtimeFingerprint?: string
  [key: string]: unknown
}

export interface BuildIdentity {
  productVersion?: string
  uiFingerprint?: string
  runtimeFingerprint?: string
  [key: string]: unknown
}

/**
 * Compares build-identity.json (no-store fetch) against /api/health runtime
 * data. Returns `null` when all compared fields match (or are empty/unknown),
 * or an Error when at least one field differs.
 *
 * Fields that are empty or "unknown" on either side are skipped.
 */
export async function checkVersionConsistency(
  fetchHealth: () => Promise<HealthData>,
  fetchBuildIdentity: () => Promise<BuildIdentity>,
): Promise<Error | null> {
  const identityFields: (keyof BuildIdentity)[] = [
    "productVersion",
    "uiFingerprint",
    "runtimeFingerprint",
  ];

  const [health, buildIdentity] = await Promise.all([
    fetchHealth().catch((): HealthData => ({})),
    fetchBuildIdentity().catch((): BuildIdentity => ({})),
  ]);

  const mismatched: string[] = [];

  for (const field of identityFields) {
    const uiValue = String(buildIdentity?.[field] ?? "").trim();
    const runtimeValue = String(health?.[field] ?? "").trim();

    // Skip if either side is absent or unknown
    if (!uiValue || !runtimeValue || uiValue === "unknown" || runtimeValue === "unknown") {
      continue;
    }

    if (uiValue !== runtimeValue) {
      mismatched.push(String(field));
    }
  }

  if (mismatched.length > 0) {
    const err = new Error("version mismatch");
    (err as Error & { code: string }).code = "MOSA_RUNTIME_BUILD_MISMATCH";
    return err;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Update result mapping
// ---------------------------------------------------------------------------

export type UpdateCheckResult = {
  status?: string
  updateAvailable?: boolean
  canInstallInApp?: boolean
  currentVersion?: string
  latestVersion?: string
  publishedAt?: string
  reason?: string
  notes?: { zh?: string; en?: string }
}

export type UpdateUiState =
  | { phase: "idle" | "checking" }
  | { phase: "current" }
  | { phase: "available"; latestVersion: string; publishedAt: string; canInstallInApp: boolean; notes?: { zh?: string; en?: string } }
  | { phase: "downloading"; percent: number; latestVersion?: string; publishedAt?: string; canInstallInApp?: boolean; notes?: { zh?: string; en?: string } }
  | { phase: "unavailable"; reason: "install-location-unsupported" }
  | { phase: "error" | "disabled" }

export type ReadyGate = {
  markVersionOk: () => void
  markFirstPageOk: () => void
  markSseOpen: () => void
}

/** Creates a one-shot gate for the three renderer readiness conditions. */
export function createReadyGate(onReady: () => void): ReadyGate {
  const ready = { version: false, firstPage: false, sse: false }
  let reported = false
  const check = () => {
    if (reported || !ready.version || !ready.firstPage || !ready.sse) return
    reported = true
    onReady()
  }
  return {
    markVersionOk: () => { ready.version = true; check() },
    markFirstPageOk: () => { ready.firstPage = true; check() },
    markSseOpen: () => { ready.sse = true; check() },
  }
}

export interface UpdateTextResult {
  /** Displayed in the about panel version badge */
  badgeText: string
  /** Primary button label, or null to hide it. */
  buttonLabel: string | null
  /** Optional secondary action, used to cancel a download. */
  secondaryLabel?: string
  /** Whether the primary button triggers download+install. */
  downloadAndInstall: boolean
  /** Whether the primary button is disabled. */
  buttonDisabled: boolean
}

/**
 * Maps a raw checkForUpdates result to the UI state machine.
 * Result `status` values:
 *   "ok"        — check succeeded; updateAvailable tells if an upgrade is present
 *   "disabled"  — update checking is disabled (e.g. dev mode)
 *   "unavailable" — platform not supported or install location is wrong
 */
export function mapUpdateResult(result: UpdateCheckResult): UpdateUiState {
  if (result?.status === "ok") {
    if (result.updateAvailable) {
      return {
        phase: "available",
        latestVersion: String(result.latestVersion ?? "").replace(/^v/i, ""),
        publishedAt: String(result.publishedAt ?? ""),
        canInstallInApp: result.canInstallInApp === true,
        notes: sanitizeUpdateNotes(result.notes),
      };
    }
    return { phase: "current" };
  }
  if (result?.status === "unavailable") {
    if (result?.reason === "install-location-unsupported") {
      return { phase: "unavailable", reason: "install-location-unsupported" };
    }
    return { phase: "error" };
  }
  if (result?.status === "disabled") {
    return { phase: "disabled" };
  }
  return { phase: "error" };
}

export type InstallResultFeedback = {
  installing: boolean
  nextPhase: "available" | "current" | "unavailable"
  toast: "failed" | "current" | "move-to-applications" | null
}

// The main process has already shown its own system dialog for these three
// codes, so the renderer adds no toast on top of them.
const DIALOG_ALREADY_SHOWN_CODES = new Set([
  "PREFLIGHT_DISK_SPACE",
  "PREFLIGHT_INSTALL_DIR_NOT_WRITABLE",
  "UPDATE_FAILED_TWICE",
])

/**
 * Maps a downloadAndInstallUpdate result to what the UI should do next
 * (task 302): whether the app is quitting to install, which phase the update
 * state moves to, and whether a renderer toast is still needed.
 */
export function installResultFeedback(result: { status?: string; code?: unknown; reason?: unknown } | null | undefined): InstallResultFeedback {
  const status = typeof result?.status === "string" ? result.status : undefined;
  if (status === "installing") return { installing: true, nextPhase: "available", toast: null };
  if (status === "cancelled") return { installing: false, nextPhase: "available", toast: null };
  if (status === "current") return { installing: false, nextPhase: "current", toast: "current" };
  if (status === "unavailable" && result?.reason === "install-location-unsupported") {
    return { installing: false, nextPhase: "unavailable", toast: "move-to-applications" };
  }
  if (status === "error" && typeof result?.code === "string" && DIALOG_ALREADY_SHOWN_CODES.has(result.code)) {
    return { installing: false, nextPhase: "available", toast: null };
  }
  return { installing: false, nextPhase: "available", toast: "failed" };
}

/** Keeps only string-valued notes languages; drops the field when both are absent. */
function sanitizeUpdateNotes(notes: UpdateCheckResult["notes"]): { zh?: string; en?: string } | undefined {
  if (!notes || typeof notes !== "object") return undefined;
  const zh = typeof notes.zh === "string" && notes.zh.trim() ? notes.zh : undefined;
  const en = typeof notes.en === "string" && notes.en.trim() ? notes.en : undefined;
  if (!zh && !en) return undefined;
  return { ...(zh ? { zh } : {}), ...(en ? { en } : {}) };
}

/** Translates a Chinese source string and fills its named placeholders. */
type TranslateFn = (text: string) => string

export function fill(text: string, values: Record<string, string | number>): string {
  // Only names present in `values` are replaced; any other {placeholder}
  // stays visible instead of silently turning into an empty string.
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match)
}

// Same shape as the old about panel's formatDate: "2026年10月14日" / "Oct 14, 2026".
function readableDate(value: string, language: "zh" | "en"): string {
  if (!value) return ""
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(date)
}

/**
 * Builds the text/label pack for the update section of the about panel.
 *
 * @param currentVersion  Raw product version string (e.g. "1.2.3")
 * @param state          Current UI state machine value
 * @param downloadPercent 0–100, only used when phase === "downloading"
 * @param t              Translation function (key -> translated string, optionally {param} substitution)
 */
export function buildUpdateText(
  currentVersion: string,
  state: UpdateUiState,
  downloadPercent: number,
  t: TranslateFn,
  language: "zh" | "en" = "zh",
): UpdateTextResult {
  const versionLabel = currentVersion
    ? `v${String(currentVersion).replace(/^v/i, "")}`
    : t("版本信息不可用");

  if (state.phase === "idle" || state.phase === "checking") {
    return {
      badgeText: versionLabel,
      buttonLabel: t(state.phase === "checking" ? "正在检查…" : "检查更新"),
      buttonDisabled: state.phase === "checking",
      downloadAndInstall: false,
    };
  }

  if (state.phase === "downloading") {
    return {
      badgeText: versionLabel,
      buttonLabel: fill(t("正在下载 {percent}%"), { percent: downloadPercent }),
      secondaryLabel: t("取消下载"),
      buttonDisabled: true,
      downloadAndInstall: false,
    };
  }

  if (state.phase === "current") {
    return {
      badgeText: `${versionLabel} · ${t("已是最新版本")}`,
      buttonLabel: t("检查更新"),
      buttonDisabled: false,
      downloadAndInstall: false,
    };
  }

  if (state.phase === "available") {
    const published = state.publishedAt
      ? ` · ${fill(t("发布于 {date}"), { date: readableDate(state.publishedAt, language) })}`
      : "";
    const versionStr = state.latestVersion
      ? fill(t("可更新至 v{version}"), { version: state.latestVersion })
      : "";
    return {
      badgeText: `${versionLabel} · ${versionStr}${published}`,
      buttonLabel: state.canInstallInApp ? t("下载并更新") : t("前往官网下载"),
      buttonDisabled: false,
      downloadAndInstall: state.canInstallInApp,
    };
  }

  if (state.phase === "unavailable") {
    return {
      badgeText: `${versionLabel} · ${t("请先把 App 拖进『应用程序』文件夹再更新")}`,
      buttonLabel: null,
      buttonDisabled: false,
      downloadAndInstall: false,
    };
  }

  return {
    badgeText: `${versionLabel} · ${t("暂时无法检查更新")}`,
    buttonLabel: t("检查更新"),
    buttonDisabled: false,
    downloadAndInstall: false,
  };
}
