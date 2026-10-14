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
  key: "webPromptUnavailable" | "geminiVisibleUserPromptUnverified" | "flowProviderVisiblePromptUnverified" | "googleAiStudioVisibleUserPromptUnverified"
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
  // Check if recipeHistory belongs to this asset
  const historyMatches = recipeHistory && 
    (asset.id === (recipeHistory as MosaRecipeHistory & { asset_id?: string }).asset_id ||
     asset.project_id === (recipeHistory as MosaRecipeHistory & { project_id?: string }).project_id)
  
  let references: MosaReference[] | null = null

  if (historyMatches && recipeHistory?.snapshots?.length) {
    // Use active snapshot or last one
    const activeId = recipeHistory.active_snapshot_id || recipeHistory.snapshots[recipeHistory.snapshots.length - 1]?.snapshot_id
    const snapshot = recipeHistory.snapshots.find(s => s.snapshot_id === activeId) || recipeHistory.snapshots[recipeHistory.snapshots.length - 1]
    references = snapshot?.references || []
  } else if (recipeHistory !== undefined) {
    // recipeHistory has been fetched (could be null or no snapshots)
    references = asset.references || []
  } else {
    // recipeHistory is undefined (not fetched yet)
    const sourceType = String(asset.source?.type || (asset as MosaAsset & { source_type?: string }).source_type || "")
    if (/^web-/.test(sourceType)) {
      return null // Still loading
    }
    references = asset.references || []
  }

  if (!references || !Array.isArray(references)) {
    references = []
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
  const isWebSource = /^web-(?:chatgpt|gemini|flow|google-ai-studio)$/.test(sourceType)
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
  }

  return null
}
