/** Inspector tag-row display logic: vendor name first, system tags hidden,
 * stored tags untouched underneath, and the two-line fit calculation for the
 * collapsed row. Pure logic — no DOM, no imports. */

/** Same curated capture/bridge groups as the sidebar "智能分组". Manual
 * imports and arbitrary historical source names are not smart groups. */
export const SMART_SOURCE_GROUPS = [
  ["web-chatgpt", "ChatGPT"], ["web-gemini", "Gemini"],
  ["web-flow", "Flow"], ["web-google-ai-studio", "Google AI Studio"],
  ["codex-generated", "Codex"], ["grok-generated", "Grok"],
  ["cowart-generated", "Cowart"],
] as const

// Ingest-written bookkeeping tags that never belong in the visible row.
const SYSTEM_TAGS = new Set(["web-capture", "auto-archived", "manual-capture"])

/** Vendor display name for an asset source type (sidebar "智能分组" naming);
 * null for sources outside the smart groups, which show no vendor name. */
export function vendorLabelFor(sourceType: string): string | null {
  const source = String(sourceType || "")
  const group = SMART_SOURCE_GROUPS.find(([key]) => key === source)
  return group ? group[1] : null
}

/** Tags shown after the vendor name: stored order kept, system tags and the
 * stored tag duplicating the vendor name (case-insensitive) removed, and
 * case-insensitive duplicates collapsed to the first occurrence. */
export function visibleTags(storedTags: string[], sourceType: string): string[] {
  const vendor = vendorLabelFor(sourceType)
  const hidden = new Set(SYSTEM_TAGS)
  if (vendor) {
    // Ingest writes the provider key ("google-ai-studio"), not the display
    // name ("Google AI Studio"); hide both spellings.
    hidden.add(vendor.toLocaleLowerCase())
    hidden.add(String(sourceType).toLocaleLowerCase().replace(/^web-/, "").replace(/-generated$/, ""))
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of Array.isArray(storedTags) ? storedTags : []) {
    const key = String(tag).toLocaleLowerCase()
    if (!key || hidden.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(tag)
  }
  return result
}

/** Remove one visible tag from the full stored list — hidden system tags and
 * the original order survive, because the delete button only ever names a
 * visible tag and the write-back must go through the complete stored list.
 * Case-insensitive duplicates go too: visibleTags collapsed them into the one
 * label the user clicked, so leaving one behind would make × look broken. */
export function removeTagFromStored(storedTags: string[], tag: string): string[] {
  const list = Array.isArray(storedTags) ? storedTags : []
  const key = String(tag).toLocaleLowerCase()
  return list.filter(item => String(item).toLocaleLowerCase() !== key)
}

export type TagFitInput = {
  /** Natural (nowrap) widths of every row item in order; itemWidths[0] is the
   * vendor name when the asset has one — a plain item for fitting purposes. */
  itemWidths: number[]
  containerWidth: number
  gap: number
  toggleWidth: number
  addWidth: number
}

/** How many items the collapsed row shows: as many as fit on two lines with
 * the "+N" toggle (only when items are folded) and the "添加标签" button
 * still at the end of the last used line. Everything fits → all items, no
 * toggle. A container too narrow for even the vendor still shows 1 item.
 * Zero/negative/invalid widths never throw. */
export function fitTagsInTwoLines({ itemWidths, containerWidth, gap, toggleWidth, addWidth }: TagFitInput): number {
  const widths = (Array.isArray(itemWidths) ? itemWidths : []).map(width => (Number.isFinite(width) ? Math.max(0, width) : 0))
  const total = widths.length
  if (!total) return 0
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0
  if (!(width > 0)) return 1
  const spacing = Number.isFinite(gap) ? Math.max(0, gap) : 0
  const foldedTail = Number.isFinite(toggleWidth) ? Math.max(0, toggleWidth) : 0
  const tail = Number.isFinite(addWidth) ? Math.max(0, addWidth) : 0

  // Flex-wrap the shown items, then "+N" (only when folded) and "添加标签",
  // greedily like the browser does; false once a third line would be needed.
  // The trailing buttons may wrap onto line 2 on their own.
  const fits = (count: number): boolean => {
    const sequence = widths.slice(0, count)
    if (count < total) sequence.push(foldedTail)
    sequence.push(tail)
    let x = 0
    let line = 1
    for (const itemWidth of sequence) {
      if (itemWidth > width) return false
      const next = x === 0 ? itemWidth : x + spacing + itemWidth
      if (next <= width) { x = next; continue }
      if (line >= 2) return false
      line = 2
      x = itemWidth
    }
    return true
  }

  for (let count = total; count >= 2; count--) {
    if (fits(count)) return count
  }
  return 1
}
