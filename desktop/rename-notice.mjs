// 老用户「已更名」提示的判定与确认（任务 116）：纯函数、目录全部由参数传入、
// 不读环境。判断在启动最早期调用——早于本次启动往 userData 写任何东西（尤其
// 早于 anonymous-usage.json 的创建、早于素材库的创建），所以判定读到的是升级
// 前留下的痕迹：userData 里已有 anonymous-usage.json，或已有 library-location.json
// （老版本 0.2.1-rc.12 起挪素材库时写；只在用户挪库时写、启动路径从不写，
// 专接「挪过库、又关了匿名统计」的老用户），或老素材库目录仍存在，即老用户。
// 两个 userData 信号不碰家目录；隔离实例（QA/测试）由调用方把 legacyLibraryDir
// 传空，这里就绝不去看真实家目录。读写失败都不允许让 App 起不来：读失败按「标记不存在」处理，
// 写失败记一行日志继续。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LIBRARY_LOCATION_FILE } from "../lib/library-location.mjs";
import { ANONYMOUS_USAGE_PROFILE_FILE } from "./anonymous-usage.mjs";

export const RENAME_NOTICE_MARKER_FILE = "rename-notice.json";
export const RENAME_NOTICE_MARKER_VERSION = 1;
export const RENAME_NOTICE_STATES = Object.freeze(["pending", "acknowledged", "not-needed"]);

function markerPath(userDataDir) {
  return join(userDataDir, RENAME_NOTICE_MARKER_FILE);
}

// 标记不存在、读不出、不是对象、版本不对或 state 不在集合内，一律返回 null
// ——调用方按「没有标记」走老用户判定，绝不抛错。
function readMarkerState(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version !== RENAME_NOTICE_MARKER_VERSION) return null;
    return RENAME_NOTICE_STATES.includes(parsed.state) ? parsed.state : null;
  } catch {
    return null;
  }
}

function writeMarkerState(userDataDir, state, log) {
  const path = markerPath(userDataDir);
  const temporaryPath = `${path}.tmp`;
  try {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify({ version: RENAME_NOTICE_MARKER_VERSION, state })}\n`, "utf8");
    renameSync(temporaryPath, path);
    return true;
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch {}
    log?.(`rename notice marker write failed: ${error?.message || error}`);
    return false;
  }
}

/**
 * 启动最早期调用一次。返回 { shouldShow, state, persisted }：
 * - 标记存在且合法：pending → 要弹；acknowledged / not-needed → 不弹（不重写）。
 * - 标记不存在或损坏：userData 里已有 anonymous-usage.json 或 library-location.json，
 *   或 legacyLibraryDir 非空且存在 → 老用户，写 pending 并要弹；否则新用户，
 *   写 not-needed 不弹。
 * - legacyLibraryDir 传空（隔离实例）时只看 userData，绝不碰家目录。
 */
export function evaluateRenameNoticeState({ userDataDir, legacyLibraryDir = "", log = null } = {}) {
  try {
    if (!userDataDir) return { shouldShow: false, state: "not-needed", persisted: false };
    const existing = readMarkerState(markerPath(userDataDir));
    if (existing) {
      return { shouldShow: existing === "pending", state: existing, persisted: true };
    }
    const usageProfileExists = existsSync(join(userDataDir, ANONYMOUS_USAGE_PROFILE_FILE));
    const libraryLocationExists = existsSync(join(userDataDir, LIBRARY_LOCATION_FILE));
    // 空字符串一律当「不看」：隔离实例由此与真实家目录彻底脱钩。
    const legacyLibraryExists = Boolean(legacyLibraryDir) && existsSync(legacyLibraryDir);
    const state = usageProfileExists || libraryLocationExists || legacyLibraryExists ? "pending" : "not-needed";
    const persisted = writeMarkerState(userDataDir, state, log);
    return { shouldShow: state === "pending", state, persisted };
  } catch (error) {
    log?.(`rename notice evaluation failed: ${error?.message || error}`);
    return { shouldShow: false, state: "not-needed", persisted: false };
  }
}

/** 用户点「知道了」（或按 Esc / 点遮罩关闭）后调用：写 acknowledged，以后不再弹。 */
export function acknowledgeRenameNotice({ userDataDir, log = null } = {}) {
  if (!userDataDir) return false;
  return writeMarkerState(userDataDir, "acknowledged", log);
}
