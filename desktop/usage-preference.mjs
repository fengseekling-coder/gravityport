import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const USAGE_PREFERENCE_FILE = "usage-preference.json";
const DEFAULT_USAGE_PREFERENCE = Object.freeze({ enabled: true, noticeAcknowledgedAt: null });

export function readUsagePreference(userDataDir, fs = { readFileSync }) {
  try {
    const value = JSON.parse(fs.readFileSync(join(userDataDir, USAGE_PREFERENCE_FILE), "utf8"));
    if (typeof value?.enabled !== "boolean" || !(
      value.noticeAcknowledgedAt === null ||
      (typeof value.noticeAcknowledgedAt === "number" && Number.isFinite(value.noticeAcknowledgedAt) && value.noticeAcknowledgedAt > 0)
    )) return { ...DEFAULT_USAGE_PREFERENCE };
    return { enabled: value.enabled, noticeAcknowledgedAt: value.noticeAcknowledgedAt };
  } catch {
    return { ...DEFAULT_USAGE_PREFERENCE };
  }
}

export function writeUsagePreference(userDataDir, preference, fs = { mkdirSync, writeFileSync, renameSync }) {
  if (typeof preference?.enabled !== "boolean" || !(
    preference.noticeAcknowledgedAt === null ||
    (typeof preference.noticeAcknowledgedAt === "number" && Number.isFinite(preference.noticeAcknowledgedAt) && preference.noticeAcknowledgedAt > 0)
  )) throw new TypeError("invalid usage preference");
  const file = join(userDataDir, USAGE_PREFERENCE_FILE);
  const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(temporaryFile, JSON.stringify({
    enabled: preference.enabled,
    noticeAcknowledgedAt: preference.noticeAcknowledgedAt,
  }), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryFile, file);
}

export function usageReportAllowed({ envDisabled, preference }) {
  return !envDisabled && preference?.enabled === true &&
    typeof preference.noticeAcknowledgedAt === "number" &&
    Number.isFinite(preference.noticeAcknowledgedAt) && preference.noticeAcknowledgedAt > 0;
}
