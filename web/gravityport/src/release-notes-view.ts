/**
 * Release-notes-view.ts — pure logic that turns release-notes.json plus the
 * update-check state into the About page's note blocks. No React, no DOM.
 *
 * The repository-root release-notes.json is bundled in at build time so the
 * About page can always answer "what changed in this version" without going
 * online; notes for a not-yet-installed version arrive through the update
 * check instead.
 */

import releaseNotesData from "../../../release-notes.json"
import { fill } from "./app-lifecycle"

export interface ReleaseNotesData {
  schema: number
  unreleased?: { zh?: string[]; en?: string[] }
  releases?: { version?: string; date?: string; zh?: string[]; en?: string[] }[]
}

/** The subset of UpdateUiState the About page needs, kept structural for tests. */
export interface UpdateNotesState {
  phase: string
  latestVersion?: string
  publishedAt?: string
  notes?: { zh?: string; en?: string }
}

export interface ReleaseNoteBlock {
  title: string
  /** Display date (formatted for the interface language); empty when none. */
  date: string
  lines: string[]
}

/**
 * Builds the About page's note blocks, newest first:
 *   - "What's new in {next version}" when an update is available/downloadable
 *     and its notes (either language) say anything,
 *   - then the current version: its recorded notes, or — on development
 *     builds — what is recorded for the next version so far.
 */
export function buildReleaseNoteBlocks({
  productVersion,
  distribution = "",
  language = "zh",
  t,
  updateState = null,
  data = releaseNotesData as ReleaseNotesData,
}: {
  productVersion: string
  distribution?: string
  language?: "zh" | "en"
  t: (text: string) => string
  updateState?: UpdateNotesState | null
  data?: ReleaseNotesData
}): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = []
  const next = nextVersionBlock(updateState, language, t)
  if (next) blocks.push(next)
  blocks.push(currentVersionBlock({ productVersion, distribution, language, t, data }))
  return blocks
}

function nextVersionBlock(
  updateState: UpdateNotesState | null,
  language: "zh" | "en",
  t: (text: string) => string,
): ReleaseNoteBlock | null {
  if (updateState?.phase !== "available" && updateState?.phase !== "downloading") return null
  const version = String(updateState.latestVersion ?? "").trim()
  const lines = manifestNoteLines(updateState.notes, language)
  if (!version || lines.length === 0) return null
  return {
    title: fill(t("新版本 {version} 更新内容"), { version }),
    date: formatDate(updateState.publishedAt ?? "", language),
    lines,
  }
}

function currentVersionBlock({
  productVersion,
  distribution,
  language,
  t,
  data,
}: {
  productVersion: string
  distribution: string
  language: "zh" | "en"
  t: (text: string) => string
  data: ReleaseNotesData
}): ReleaseNoteBlock {
  if (distribution === "development") {
    const lines = languageLines(data.unreleased, language)
    return {
      title: t("下个版本（开发中）"),
      date: "",
      lines: lines.length > 0 ? lines : [t("还没有记录")],
    }
  }
  const version = String(productVersion ?? "").trim()
  const entry = findRelease(data, version)
  return {
    title: fill(t("当前版本 {version} 更新内容"), { version: version || "—" }),
    date: entry?.date ? formatDate(entry.date, language) : "",
    lines: entry ? languageLines(entry, language) : [t("这个版本没有更新说明")],
  }
}

/** Splits a manifest note blob into sentences, one per line, bullets stripped. */
function manifestNoteLines(
  notes: { zh?: string; en?: string } | undefined,
  language: "zh" | "en",
): string[] {
  const primary = splitNoteLines(language === "en" ? notes?.en : notes?.zh)
  if (primary.length > 0) return primary
  return splitNoteLines(language === "en" ? notes?.zh : notes?.en)
}

function splitNoteLines(text: string | undefined): string[] {
  const raw = typeof text === "string" ? text.trim() : ""
  if (!raw) return []
  if (!/\r?\n/.test(raw)) {
    const single = raw.replace(/^[\s•\-*]+/, "").trim()
    return single ? [single] : []
  }
  return raw
    .split(/\r?\n/)
    .map(line => line.replace(/^[\s•\-*]+/, "").trim())
    .filter(line => line.length > 0)
}

function languageLines(
  entry: { zh?: string[]; en?: string[] } | undefined,
  language: "zh" | "en",
): string[] {
  const primary = entry?.[language === "en" ? "en" : "zh"]
  if (Array.isArray(primary) && primary.length > 0) return [...primary]
  const fallback = entry?.[language === "en" ? "zh" : "en"]
  return Array.isArray(fallback) ? [...fallback] : []
}

function findRelease(data: ReleaseNotesData, version: string) {
  const wanted = version.replace(/^v/i, "")
  if (!wanted) return undefined
  return (data.releases ?? []).find(release => String(release?.version ?? "").replace(/^v/i, "") === wanted)
}

// Same shape as the about panel's update badge date: "2026年10月16日" / "Oct 16, 2026".
// Date-only values (release-notes.json "date") parse as local midnight so the
// shown calendar day cannot shift with the viewer's timezone.
function formatDate(value: string, language: "zh" | "en"): string {
  if (!value) return ""
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", { year: "numeric", month: "short", day: "numeric" }).format(date)
}
