/**
 * Task 452 — Settings → 连接: text mapping for the 本机 AI 工具 card.
 *
 * Pure functions so the status and reason/fix tables are unit-testable
 * without rendering React. All returned strings are the Chinese keys the
 * i18n table looks up at render time; placeholders stay in the keys and are
 * filled after translate(), matching the repo pattern (translate then fill).
 * Error messages from the bridges are never shown raw — the reason/fix table
 * turns them into wording, the original text only rides in the 复制详细信息
 * payload for feedback.
 */

import type { Language } from "./i18n.js"
import type {
  MosaBridgeCowartStatus,
  MosaBridgeDiscoveryStatus,
  MosaBridgeToolStatus,
  MosaBridgesStatus,
} from "./mosa-api.js"

export type BridgeBadgeTone = "muted" | "ok" | "warn" | "bad"

/** One 原因 + 怎么办 group under a row. Warnings only carry the note. */
export type BridgeIssueLine = {
  /** 原因 line in --ui-danger; null on warning rows. */
  dangerKey: string | null
  dangerParams: Record<string, string>
  /** 怎么办 (errors) or 警告说明 (warnings) line in --ui-secondary. */
  noteKey: string
  noteParams: Record<string, string>
}

export type BridgeRowView = {
  key: "codex" | "grok" | "cowart"
  nameKey: string
  badgeKey: string
  badgeParams: Record<string, string>
  tone: BridgeBadgeTone
  lines: BridgeIssueLine[]
  /** Plain-text payload the 复制详细信息 button puts on the clipboard. */
  detailText: string
}

/**
 * "14:02" when the import landed today; otherwise the date stays visible,
 * 「11月18日 14:02」 in Chinese and "Nov 18, 14:02" in English — the same
 * clock shape VersionCanvas uses for round times.
 */
export function bridgeReceivedTime(iso: string | null, nowMs: number, language: Language): string {
  if (!iso) return ""
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ""
  const clock = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
  const now = new Date(nowMs)
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()) {
    return clock
  }
  if (language === "en") {
    return `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()}, ${clock}`
  }
  return `${at.getMonth() + 1}月${at.getDate()}日 ${clock}`
}

/** 「重新打开 GravityPort；仍然失败时…」 — the generic 未知原因 row. */
const GENERIC_FIX_KEY = "重新打开 GravityPort；仍然失败时，复制详细信息并发送到「反馈」。"

const STATUS_TABLE_FIX_KEYS = {
  diskFull: "腾出磁盘空间后会自动恢复收录。",
  busy: "稍后会自动重试。",
} as const

/**
 * The reason/fix table from task 452, keyed by lastErrorCode. Unknown codes
 * and code-less errors land on the generic row.
 */
function toolErrorLine(toolKey: string, dir: string, code: string | null): BridgeIssueLine {
  if (code === "EACCES" || code === "EPERM") {
    return {
      dangerKey: "无法读取 {tool} 的文件夹（没有权限）",
      dangerParams: { tool: toolKey },
      noteKey: "允许 GravityPort 访问 {dir}，问题解决后会自动恢复收录。",
      noteParams: { dir },
    }
  }
  if (code === "ENOSPC") {
    return {
      dangerKey: "无法保存新图片（磁盘空间不足）",
      dangerParams: {},
      noteKey: STATUS_TABLE_FIX_KEYS.diskFull,
      noteParams: {},
    }
  }
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return {
      dangerKey: "素材库暂时无法写入",
      dangerParams: {},
      noteKey: STATUS_TABLE_FIX_KEYS.busy,
      noteParams: {},
    }
  }
  return {
    dangerKey: code ? "无法收录 {tool} 的新图片（{code}）" : "无法收录 {tool} 的新图片",
    dangerParams: { tool: toolKey, code: code || "" },
    noteKey: GENERIC_FIX_KEY,
    noteParams: {},
  }
}

function toolWarningLine(): BridgeIssueLine {
  return {
    dangerKey: null,
    dangerParams: {},
    noteKey: "有些图片的提示词没有读到，图片照常收录。",
    noteParams: {},
  }
}

/**
 * Feedback payload for one Codex/Grok row: tool name, the raw error (or
 * warning) text, the last scan stamp, and the folders involved — one item
 * per line, nothing translated.
 */
function toolDetailText(toolLabel: string, status: MosaBridgeToolStatus): string {
  const lines = [toolLabel]
  if (status.lastError) {
    lines.push(`lastErrorCode: ${status.lastErrorCode || "(none)"}`)
    lines.push(`lastError: ${status.lastError}`)
  } else if (status.lastWarning) {
    lines.push(`lastWarning: ${status.lastWarning}`)
  }
  lines.push(`lastScanAt: ${status.lastScanAt || "(never)"}`)
  if (status.imagesDir) lines.push(`imagesDir: ${status.imagesDir}`)
  if (status.sessionsDir) lines.push(`sessionsDir: ${status.sessionsDir}`)
  return lines.join("\n")
}

function loadingRow(key: BridgeRowView["key"], nameKey: string): BridgeRowView {
  return { key, nameKey, badgeKey: "正在加载…", badgeParams: {}, tone: "muted", lines: [], detailText: "" }
}

/**
 * Codex and Grok share the row ladder from the task table: 已停用 → 无法收录
 * → 未找到生图记录 → 警告 → 正在收录.
 */
function toolRow(
  key: BridgeRowView["key"],
  nameKey: string,
  toolKey: string,
  status: MosaBridgeToolStatus,
  nowMs: number,
  language: Language,
  homeDir: string,
): BridgeRowView {
  if (!status.enabled) {
    return { key, nameKey, badgeKey: "已停用", badgeParams: {}, tone: "muted", lines: [], detailText: "" }
  }
  if (status.lastError) {
    const dir = key === "codex"
      ? commonParentOf(status.imagesDir, status.sessionsDir) || status.imagesDir || status.sessionsDir
      : status.sessionsDir
    return {
      key,
      nameKey,
      badgeKey: "无法收录",
      badgeParams: {},
      tone: "bad",
      lines: [toolErrorLine(toolKey, homeRelativePath(dir, homeDir), status.lastErrorCode)],
      detailText: toolDetailText(nameKey, status),
    }
  }
  if (status.sourceFound === false) {
    return { key, nameKey, badgeKey: "未找到生图记录", badgeParams: {}, tone: "muted", lines: [], detailText: "" }
  }
  if (status.lastWarning) {
    return {
      key,
      nameKey,
      badgeKey: "正在收录 · 部分提示词未读到",
      badgeParams: {},
      tone: "warn",
      lines: [toolWarningLine()],
      detailText: toolDetailText(nameKey, status),
    }
  }
  const received = bridgeReceivedTime(status.lastImportedAt, nowMs, language)
  if (status.lastImportedAt && received) {
    return {
      key,
      nameKey,
      badgeKey: "正在收录 · 最近收到 {time}",
      badgeParams: { time: received },
      tone: "ok",
      lines: [],
      detailText: "",
    }
  }
  return { key, nameKey, badgeKey: "正在收录", badgeParams: {}, tone: "ok", lines: [], detailText: "" }
}

/**
 * Cowart's row: the manager carries per-canvas errors, so several 原因 +
 * 怎么办 groups may stack under one row while the copy button stays single
 * and copies every canvas. Discovery errors fold in as a generic group.
 */
function cowartRow(cowart: MosaBridgeCowartStatus, discovery: MosaBridgeDiscoveryStatus): BridgeRowView {
  if (!cowart.enabled) {
    return { key: "cowart", nameKey: "Cowart 画布", badgeKey: "已停用", badgeParams: {}, tone: "muted", lines: [], detailText: "" }
  }
  const erroredCanvases = cowart.sources.filter((source) => source.lastError)
  const healthyCanvases = cowart.sources.filter((source) => !source.lastError).length
  const discoveryFailed = Boolean(discovery.lastError)
  if (erroredCanvases.length > 0 || discoveryFailed) {
    const lines: BridgeIssueLine[] = erroredCanvases.map((source) => canvasErrorLine(source))
    if (discoveryFailed) lines.push({
      dangerKey: discovery.lastErrorCode ? "无法收录 {tool} 的新图片（{code}）" : "无法收录 {tool} 的新图片",
      dangerParams: { tool: "Cowart", code: discovery.lastErrorCode || "" },
      noteKey: GENERIC_FIX_KEY,
      noteParams: {},
    })
    // 只部分画布出错时点数进徽标；全部出错或只有发现流程出错时保持一句话。
    const partial = erroredCanvases.length > 0 && healthyCanvases > 0
    return {
      key: "cowart",
      nameKey: "Cowart 画布",
      badgeKey: partial ? "{count} 个画布无法收录" : "无法收录",
      badgeParams: partial ? { count: String(erroredCanvases.length) } : {},
      tone: "bad",
      lines,
      detailText: cowartDetailText(cowart, discovery),
    }
  }
  if (cowart.registeredCount === 0) {
    return { key: "cowart", nameKey: "Cowart 画布", badgeKey: "还没有画布", badgeParams: {}, tone: "muted", lines: [], detailText: "" }
  }
  return {
    key: "cowart",
    nameKey: "Cowart 画布",
    badgeKey: "正在收录 · {count} 个画布",
    badgeParams: { count: String(cowart.monitoredCount) },
    tone: "ok",
    lines: [],
    detailText: "",
  }
}

function canvasErrorLine(source: { projectDir: string; lastError: string | null; lastErrorCode: string | null }): BridgeIssueLine {
  const canvas = lastPathSegment(source.projectDir)
  if (source.lastErrorCode === "project-missing" || source.lastErrorCode === "canvas-missing") {
    return {
      dangerKey: "找不到画布「{canvas}」的文件夹",
      dangerParams: { canvas },
      noteKey: "画布被移动或删除后无法继续收录。",
      noteParams: {},
    }
  }
  return {
    dangerKey: "无法收录画布「{canvas}」（{reason}）",
    dangerParams: { canvas, reason: source.lastErrorCode || "" },
    noteKey: "这个画布的文件夹位置不安全，已停止收录。",
    noteParams: {},
  }
}

function cowartDetailText(cowart: MosaBridgeCowartStatus, discovery: MosaBridgeDiscoveryStatus): string {
  const lines = ["Cowart 画布"]
  for (const source of cowart.sources) {
    if (!source.lastError) continue
    lines.push(`canvas: ${source.projectDir}`)
    lines.push(`lastErrorCode: ${source.lastErrorCode || "(none)"}`)
    lines.push(`lastError: ${source.lastError}`)
  }
  if (discovery.lastError) {
    lines.push(`discovery lastErrorCode: ${discovery.lastErrorCode || "(none)"}`)
    lines.push(`discovery lastError: ${discovery.lastError}`)
  }
  lines.push(`lastScanAt: ${cowart.lastScanAt || "(never)"}`)
  return lines.join("\n")
}

/**
 * The three fixed rows of the 本机 AI 工具 card. `undefined` renders the
 * loading ladder; the fetch-failed case is handled by the card itself.
 */
export function bridgeRowViews(status: MosaBridgesStatus | undefined, nowMs: number, language: Language): BridgeRowView[] {
  if (!status) {
    return [
      loadingRow("codex", "Codex"),
      loadingRow("grok", "Grok"),
      loadingRow("cowart", "Cowart 画布"),
    ]
  }
  return [
    toolRow("codex", "Codex", "Codex", status.codex, nowMs, language, status.homeDir),
    toolRow("grok", "Grok", "Grok", status.grok, nowMs, language, status.homeDir),
    cowartRow(status.cowart, status.cowartDiscovery),
  ]
}

/**
 * Shows a path under the user's home directory as "~/…" (display only; the
 * copy-details payload keeps the full path). Paths elsewhere, or an unknown
 * home directory, come back unchanged.
 */
export function homeRelativePath(path: string, homeDir: string): string {
  if (!path || !homeDir) return path
  const home = homeDir.replace(/[\\/]+$/, "")
  if (!home) return path
  if (path === home) return "~"
  const next = path.charAt(home.length)
  if (path.startsWith(home) && (next === "/" || next === "\\")) return `~${path.slice(home.length)}`
  return path
}

/** Deepest directory containing both paths, or "" when either is missing. */
export function commonParentOf(left: string, right: string): string {
  if (!left || !right) return ""
  const separator = left.includes("\\") || right.includes("\\") ? "\\" : "/"
  const leftParts = left.split(/[\\/]/)
  const rightParts = right.split(/[\\/]/)
  const shared: string[] = []
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] !== rightParts[index]) break
    shared.push(leftParts[index])
  }
  return shared.join(separator)
}

function lastPathSegment(path: string): string {
  const parts = String(path || "").split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || String(path || "")
}
