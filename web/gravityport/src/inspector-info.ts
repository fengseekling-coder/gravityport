/**
 * Inspector information module: reference images, source description, and prompt notices.
 * Pure logic without React, DOM, or network calls.
 */

import type { MosaAsset, MosaReference, MosaRecipeHistory } from "./mosa-api"

const SOURCE_LABEL_MAP: Record<string, string> = {
  "codex-generated": "Codex",
  "cowart-generated": "Cowart",
  "grok-generated": "Grok",
  "web-chatgpt": "ChatGPT 网页版",
  "web-gemini": "Gemini 网页版",
  "web-flow": "Flow 网页版",
  "web-google-ai-studio": "Google AI Studio 网页版",
  "web-jimeng": "即梦网页版",
  "web-midjourney": "Midjourney 网页版",
  "local-file": "手动导入",
}

type ResolvedReference = {
  key: string
  label: string
  thumbnailUrl: string
  openUrl: string
  index: number
}

type ResolvedReferences = {
  items: ResolvedReference[]
  total: number
} | null

type SourceDescription = {
  kindLabel: string
  sourceLabel: string
  dateLabel: string
  groupLabel: string
}

type PromptNotice = {
  key: "webPromptUnavailable" | "geminiVisibleUserPromptUnverified" | "flowProviderVisiblePromptUnverified" | "googleAiStudioVisibleUserPromptUnverified" | "jimengVisiblePromptUnverified" | "midjourneyVisiblePromptUnverified"
  text: string
} | null

/**
 * Resolve reference images for the asset.
 * Returns null when still loading (web-* sources without recipe history yet),
 * or an object with items (up to 8) and total count.
 */
export function resolveReferences(
  asset: MosaAsset,
  recipeHistory: MosaRecipeHistory | null | undefined,
  libraryAssets: MosaAsset[]
): ResolvedReferences {
  // The server stamps the history with its owner. A history left over from the
  // previously selected asset (same project, other id) counts as not fetched yet,
  // so callers must pass null only for a fetch that answered for this asset.
  const owned = recipeHistory as (MosaRecipeHistory & { asset_id?: string; project_id?: string }) | null | undefined
  const fetched = owned === null
    || (owned !== undefined && owned.asset_id === asset.id && owned.project_id === asset.project_id)

  let references: MosaReference[]

  if (fetched && owned?.snapshots?.length) {
    // Use active snapshot or last one
    const snapshots = owned.snapshots
    const snapshot = snapshots.find(s => s.snapshot_id === owned.active_snapshot_id) || snapshots[snapshots.length - 1]
    references = Array.isArray(snapshot?.references) ? snapshot.references : []
  } else {
    const sourceRefs = asset.source?.references
    const direct = asset.references?.length ? asset.references : Array.isArray(sourceRefs) ? sourceRefs as MosaReference[] : []
    const sourceType = String(asset.source?.type || (asset as MosaAsset & { source_type?: string }).source_type || "")
    // Web captures keep their references in the recipe snapshot: until the
    // history arrives, an empty list means "loading", not "none".
    if (!direct.length && !fetched && /^web-/.test(sourceType)) return null
    references = direct
  }

  const total = references.length
  const items = references.slice(0, 8).map((ref, index) => {
    // Find linked asset in library
    const linkedAsset = ref.asset_id ? libraryAssets.find(a => a.id === ref.asset_id) : null
    
    // Thumbnail priority: linked asset thumbnail > attachment_url > linked asset image_url > empty
    let thumbnailUrl = ""
    if (linkedAsset?.thumbnail_url) {
      thumbnailUrl = linkedAsset.thumbnail_url
    } else if (ref.attachment_url) {
      thumbnailUrl = ref.attachment_url
    } else if (linkedAsset?.image_url) {
      thumbnailUrl = linkedAsset.image_url
    }

    const label = ref.role || `参考图 ${index + 1}`
    const openUrl = linkedAsset?.image_url || ref.image_url || ref.attachment_url || ""

    return {
      key: ref.reference_id || `ref-${index}`,
      label,
      thumbnailUrl,
      openUrl,
      index: index + 1,
    }
  })

  return { items, total }
}

/**
 * Describe the asset source, kind, date, and group.
 */
export function describeSource(asset: MosaAsset, language: "zh" | "en"): SourceDescription {
  // Kind label
  const kindLabel = asset.mediaKind === "video" ? "视频" : "图片"

  // Source label
  const sourceType = String(asset.source?.type || (asset as MosaAsset & { source_type?: string }).source_type || "")
  let sourceLabel = SOURCE_LABEL_MAP[sourceType] || sourceType || "未知来源"

  // Date label
  let dateLabel = ""
  if (asset.created_at) {
    try {
      const date = new Date(asset.created_at)
      if (!isNaN(date.getTime())) {
        const locale = language === "zh" ? "zh-CN" : "en"
        dateLabel = new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
        }).format(date)
      }
    } catch {
      // Invalid date, leave empty
    }
  }

  // Group label
  const groupLabel = String(asset.group || "").trim()

  return {
    kindLabel,
    sourceLabel,
    dateLabel,
    groupLabel,
  }
}

/**
 * Generate prompt notice for web sources or unverified prompts.
 */
export function promptNotice(asset: MosaAsset): PromptNotice {
  const source = asset.source || {}
  const sourceType = String(source.type || (asset as MosaAsset & { source_type?: string }).source_type || "")
  const promptStatus = String((source as Record<string, unknown>).prompt_status || "")
  const provider = String((source as Record<string, unknown>).provider || "")

  // Check if web source with no prompt available
  const isWebSource = /^web-(?:chatgpt|gemini|flow|google-ai-studio|jimeng|midjourney)$/.test(sourceType)
  const promptUnavailable = isWebSource && promptStatus === "not-available"

  if (!asset.prompt && promptUnavailable) {
    return {
      key: "webPromptUnavailable",
      text: "网页来源未暴露原始生图提示词",
    }
  }

  // Check if provider-visible prompt (unverified)
  if (asset.prompt && promptStatus === "provider-visible-prompt") {
    if (provider === "gemini" || sourceType === "web-gemini") {
      return {
        key: "geminiVisibleUserPromptUnverified",
        text: "Gemini 页面可见用户提示词（未验证为实际生图提示词）",
      }
    }
    if (provider === "google-ai-studio" || sourceType === "web-google-ai-studio") {
      return {
        key: "googleAiStudioVisibleUserPromptUnverified",
        text: "Google AI Studio 页面可见用户提示词（未验证为实际生图提示词）",
      }
    }
    if (provider === "flow" || sourceType === "web-flow") {
      return {
        key: "flowProviderVisiblePromptUnverified",
        text: "Flow 页面可见提示词（未验证为实际生图提示词）",
      }
    }
    if (provider === "jimeng" || sourceType === "web-jimeng") {
      return {
        key: "jimengVisiblePromptUnverified",
        text: "即梦页面可见提示词（未验证为实际生图提示词）",
      }
    }
    if (provider === "midjourney" || sourceType === "web-midjourney") {
      return {
        key: "midjourneyVisiblePromptUnverified",
        text: "Midjourney 页面可见提示词（未验证为实际生图提示词）",
      }
    }
  }

  return null
}

/** Named aspect ratios the inspector prefers, written width:height. */
const NAMED_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [4, 5], [5, 4], [3, 4], [4, 3], [2, 3], [3, 2],
  [9, 16], [16, 9], [1, 2], [2, 1], [9, 21], [21, 9],
]
/** How far (relative) a size may sit from a named ratio and still take its name. */
export const RATIO_NAME_TOLERANCE = 0.01

/** Inspector 比例 label, width first: the closest named ratio within
 * RATIO_NAME_TOLERANCE (941×1672 → "9:16", 1920×1080 → "16:9"); otherwise the
 * shorter side normalized to 1 ("1:1.52" portrait, "1.56:1" landscape). */
export function aspectRatioLabel(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) return "—"
  const actual = width / height
  let best: readonly [number, number] | null = null
  let bestError = Infinity
  for (const named of NAMED_RATIOS) {
    const error = Math.abs(actual / (named[0] / named[1]) - 1)
    if (error <= RATIO_NAME_TOLERANCE && error < bestError) { best = named; bestError = error }
  }
  if (best) return `${best[0]}:${best[1]}`
  const trim = (value: string) => value.replace(/\.?0+$/, "")
  return width >= height ? `${trim(actual.toFixed(2))}:1` : `1:${trim((height / width).toFixed(2))}`
}

/** Inspector 时长 label for videos, rounded to whole seconds: 6.08 → "0:06",
 * 65 → "1:05", 3723 → "1:02:03". Hours only appear from one hour on. */
export function formatVideoDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, "0")
  const ss = String(secs).padStart(2, "0")
  return hours ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`
}
