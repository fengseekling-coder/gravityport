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
    fetchHealth().catch(() => ({})),
    fetchBuildIdentity().catch(() => ({})),
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
  status: string
  updateAvailable?: boolean
  canInstallInApp?: boolean
  currentVersion?: string
  latestVersion?: string
  publishedAt?: string
  reason?: string
}

export type UpdateUiState =
  | { phase: "idle" | "checking" }
  | { phase: "current" }
  | { phase: "available"; latestVersion: string; publishedAt: string; canInstallInApp: boolean }
  | { phase: "downloading"; percent: number }
  | { phase: "unavailable"; reason: "install-location-unsupported" }
  | { phase: "error" | "disabled" }

export interface UpdateTextResult {
  /** Displayed in the about panel version badge */
  badgeText: string
  /** Short label for the update button, or null to hide the button */
  buttonLabel: string | null
  /** Whether the button triggers download+install (true) or external link (false) */
  downloadAndInstall: boolean
  /** Whether the button is disabled */
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

/** Translation function: key -> translated string, optionally with {param} substitution. */
type TranslateFn = (key: string, params?: Record<string, string | number>) => string

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
): UpdateTextResult {
  const versionLabel = currentVersion
    ? `v${String(currentVersion).replace(/^v/i, "")}`
    : t("versionUnknown");

  if (state.phase === "idle" || state.phase === "checking") {
    return {
      badgeText: versionLabel,
      buttonLabel:
        state.phase === "checking"
          ? t("checkingForUpdates")
          : t("checkForUpdates"),
      buttonDisabled: state.phase === "checking",
      downloadAndInstall: false,
    };
  }

  if (state.phase === "downloading") {
    const cancelHint = ` · ${t("cancelUpdateDownload")}`;
    const downloadingRaw = t("downloadingUpdate", { percent: downloadPercent });
    return {
      badgeText: versionLabel,
      buttonLabel: `${downloadingRaw}${cancelHint}`,
      buttonDisabled: false,
      downloadAndInstall: false,
    };
  }

  if (state.phase === "current") {
    return {
      badgeText: `${versionLabel} · ${t("upToDate")}`,
      buttonLabel: t("checkForUpdates"),
      buttonDisabled: false,
      downloadAndInstall: false,
    };
  }

  if (state.phase === "available") {
    const published = state.publishedAt
      ? ` · ${t("updatePublished", { date: state.publishedAt })}`
      : "";
    const versionStr = state.latestVersion
      ? t("updateAvailable", { version: state.latestVersion })
      : "";
    return {
      badgeText: `${versionLabel} · ${versionStr}${published}`,
      buttonLabel: state.canInstallInApp
        ? t("downloadAndInstall")
        : t("downloadLatest"),
      buttonDisabled: false,
      downloadAndInstall: state.canInstallInApp,
    };
  }

  if (state.phase === "unavailable") {
    return {
      badgeText: `${versionLabel} · ${t("updateInstallLocationUnsupported")}`,
      buttonLabel: null,
      buttonDisabled: false,
      downloadAndInstall: false,
    };
  }

  // error | disabled
  return {
    badgeText: `${versionLabel} · ${t("updateCheckFailed")}`,
    buttonLabel: t("checkForUpdates"),
    buttonDisabled: false,
    downloadAndInstall: false,
  };
}

// ---------------------------------------------------------------------------
// 24-hour auto-check interval
// ---------------------------------------------------------------------------

const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_LAST_CHECKED_KEY = "mosa.update-last-checked";

/**
 * Returns true when a silent auto-check should run right now, based on the
 * last-checked timestamp stored under mosa.update-last-checked.
 * Treats a missing or invalid timestamp as "never checked" (always true).
 */
export function shouldAutoCheckForUpdates(getStored: (key: string) => string | null): boolean {
  const raw = getStored(UPDATE_LAST_CHECKED_KEY);
  const lastChecked = Number(raw || "0");
  return !Number.isFinite(lastChecked) || lastChecked <= 0 || Date.now() - lastChecked >= UPDATE_CHECK_INTERVAL_MS;
}

/** Persists the current timestamp as the last-checked marker. */
export function recordUpdateCheck(setStored: (key: string, value: string) => void): void {
  setStored(UPDATE_LAST_CHECKED_KEY, String(Date.now()));
}
