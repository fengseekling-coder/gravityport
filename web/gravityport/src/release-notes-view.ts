/**
 * Release-notes-view.ts — pure logic that turns release-notes.json plus the
 * update-check state into the About page's note blocks. No React, no DOM.
 *
 * The repository-root release-notes.json is bundled in at build time so the
 * About page can always answer "what changed in this version" without going
 * online; notes for a not-yet-installed version arrive through the update
 * check instead. Each block renders as ordered groups (新增/优化/修复/其他,
 * headings following the interface language); a group with an empty heading
 * has no section heading. Notes arriving through the update manifest carry a
 * category prefix per line (old App versions render that flat list verbatim),
 * which is restored into groups here.
 */

import releaseNotesData from "../../../release-notes.json"
import { fill } from "./app-lifecycle"

type SectionKey = "new" | "improved" | "fixed" | "other"

const SECTION_KEYS: SectionKey[] = ["new", "improved", "fixed", "other"]

/** Chinese section headings; the interface language resolves them via t(). */
const SECTION_HEADINGS: Record<SectionKey, string> = {
  new: "新增",
  improved: "优化",
  fixed: "修复",
  other: "其他",
}

/** Category prefixes the update manifest uses, per section, both languages
 * (Chinese full-width colon, English colon + space). */
const SECTION_PREFIXES: { key: SectionKey; prefix: string }[] = [
  { key: "new", prefix: "新增：" },
  { key: "improved", prefix: "优化：" },
  { key: "fixed", prefix: "修复：" },
  { key: "other", prefix: "其他：" },
  { key: "new", prefix: "New: " },
  { key: "improved", prefix: "Improved: " },
  { key: "fixed", prefix: "Fixed: " },
  { key: "other", prefix: "Other: " },
]

/** One language of a release entry: a legacy flat list or sectioned lines. */
export type NotesLanguageValue = string[] | { new?: string[]; improved?: string[]; fixed?: string[]; other?: string[] }

export interface ReleaseNotesData {
  schema: number
  unreleased?: { zh?: NotesLanguageValue; en?: NotesLanguageValue }
  releases?: { version?: string; date?: string; zh?: NotesLanguageValue; en?: NotesLanguageValue }[]
}

/** The subset of UpdateUiState the About page needs, kept structural for tests. */
export interface UpdateNotesState {
  phase: string
  latestVersion?: string
  publishedAt?: string
  notes?: { zh?: string; en?: string }
}

export interface ReleaseNoteGroup {
  /** Section heading in the interface language; empty when the group has none. */
  heading: string
  lines: string[]
}

export interface ReleaseNoteBlock {
  title: string
  /** Display date (formatted for the interface language); empty when none. */
  date: string
  groups: ReleaseNoteGroup[]
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
    groups: groupsFromManifestLines(lines, t),
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
    const groups = entryGroups(data.unreleased, language, t)
    return {
      title: t("下个版本（开发中）"),
      date: "",
      groups: groups.length > 0 ? groups : [{ heading: "", lines: [t("还没有记录")] }],
    }
  }
  const version = String(productVersion ?? "").trim()
  const entry = findRelease(data, version)
  return {
    title: fill(t("当前版本 {version} 更新内容"), { version: version || "—" }),
    date: entry?.date ? formatDate(entry.date, language) : "",
    groups: entry ? entryGroups(entry, language, t) : [{ heading: "", lines: [t("这个版本没有更新说明")] }],
  }
}

/** One language of a recorded entry (current version or unreleased) as groups,
 * falling back to the other language when this one has nothing. */
function entryGroups(
  entry: { zh?: NotesLanguageValue; en?: NotesLanguageValue } | undefined,
  language: "zh" | "en",
  t: (text: string) => string,
): ReleaseNoteGroup[] {
  const primary = groupsFromValue(language === "en" ? entry?.en : entry?.zh, t)
  if (primary.length > 0) return primary
  return groupsFromValue(language === "en" ? entry?.zh : entry?.en, t)
}

/** Normalizes one language value (legacy flat list or sectioned) into groups. */
function groupsFromValue(value: NotesLanguageValue | undefined, t: (text: string) => string): ReleaseNoteGroup[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [{ heading: "", lines: [...value] }] : []
  }
  if (!value || typeof value !== "object") return []
  const groups: ReleaseNoteGroup[] = []
  for (const key of SECTION_KEYS) {
    const lines = (value as Record<SectionKey, string[] | undefined>)[key]
    if (Array.isArray(lines) && lines.length > 0) {
      groups.push({ heading: t(SECTION_HEADINGS[key]), lines: [...lines] })
    }
  }
  return groups
}

/** Manifest lines → groups. Lines carrying a known category prefix restore
 * their section; the rest (including legacy flat notes) land in one
 * heading-less group that comes first. Headings follow the interface language
 * through t(), so notes in the other language still get localized headings. */
function groupsFromManifestLines(lines: string[], t: (text: string) => string): ReleaseNoteGroup[] {
  const plain: string[] = []
  const byKey = new Map<SectionKey, string[]>()
  for (const line of lines) {
    const match = SECTION_PREFIXES.find(({ prefix }) => line.startsWith(prefix))
    if (match) {
      const bucket = byKey.get(match.key) ?? []
      bucket.push(line.slice(match.prefix.length).trim())
      byKey.set(match.key, bucket)
    } else {
      plain.push(line)
    }
  }
  const groups: ReleaseNoteGroup[] = []
  if (plain.length > 0) groups.push({ heading: "", lines: plain })
  for (const key of SECTION_KEYS) {
    const sectionLines = byKey.get(key)
    if (sectionLines && sectionLines.length > 0) {
      groups.push({ heading: t(SECTION_HEADINGS[key]), lines: sectionLines })
    }
  }
  return groups
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
