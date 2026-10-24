/**
 * Paste-to-import decision logic (pure, no React/DOM).
 *
 * ⌘V and the blank-area menu's 粘贴 both end in one window paste listener;
 * this module owns everything decidable outside React:
 *
 * - pasteImportDisposition: whether a paste event imports, is ignored (text
 *   fields, overlays, no files, a pending cut) or meets the "回收站里不能导入"
 *   toast;
 * - importVisibleInActiveView: whether freshly imported assets show up in the
 *   view they were pasted from, or need the "在「所有素材」里" pointer;
 * - renameSynthesizedPasteFiles: Chromium names raw clipboard image data
 *   image.png, so a paste full of screenshots all share one name — those
 *   files are renamed 粘贴的图片 <时间>.png (Pasted image … in English), with
 *   a " 2"/" 3" suffix when one paste carries several of them.
 *
 * App.tsx only wires these into the listener and the context menu.
 */

export type PasteImportDecision = "import" | "ignore" | "trash-blocked"

export interface PasteImportState {
  /** Focus sits in a text field (search, prompt editor, rename box…): the
   * field pastes text itself and the gallery must not import. */
  targetIsEditable: boolean
  settingsOpen: boolean
  pinterestActive: boolean
  /** A context menu, confirm dialog or rename notice is up. The viewer
   * (大图页) does not count: pasting imports while it is open. */
  hasOverlay: boolean
  /** A cut is pending: ⌘V / the menu 粘贴 first move the cut assets
   * (pasteCut); importing would steal that paste. */
  cutActive: boolean
  trashView: boolean
  hasFiles: boolean
}

/**
 * Order matters: text fields win over a pending cut, overlays silence
 * everything, and an empty clipboard is ignored even in the trash — only a
 * paste that actually carries files gets the 回收站 toast.
 */
export function pasteImportDecision(state: PasteImportState): PasteImportDecision {
  if (state.targetIsEditable) return "ignore"
  if (state.settingsOpen || state.pinterestActive || state.hasOverlay) return "ignore"
  if (state.cutActive) return "ignore"
  if (!state.hasFiles) return "ignore"
  if (state.trashView) return "trash-blocked"
  return "import"
}

export interface PasteVisibilityState {
  active: string
  query: string
  assetType: string
  stackId: string
}

/**
 * Whether an import lands in the view the user pasted from. Favorites, smart
 * groups and any refinement (search term, 图片/视频 filter) cannot show the
 * new assets; an open stack always can; 所有素材 / 待整理 / a 我的分组 view
 * do unless a refinement is active.
 */
export function importVisibleInActiveView(state: PasteVisibilityState): boolean {
  if (state.query.trim() !== "") return false
  if (state.assetType !== "all") return false
  if (state.stackId) return true
  if (state.active === "收藏") return false
  if (state.active.startsWith("source:")) return false
  return true
}

/**
 * Chromium's synthesized name for raw clipboard image data (browser 复制图片,
 * screenshots). Real files copied in Finder / Explorer keep their own name, so
 * exactly this name marks a file without a real path. A genuine file that is
 * itself called image.png gets renamed too — a deliberate trade: the renderer
 * sandbox cannot ask webUtils for paths, and only display names are affected,
 * never bytes.
 */
export const SYNTHESIZED_PASTE_NAME = "image.png"

const PASTE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/bmp": ".bmp",
}

/** Extension for a synthesized paste file: by MIME type when it is known,
 * else by the name it arrived with (almost always .png). */
export function pasteExtensionFor(type: string, fallbackName: string): string {
  const known = PASTE_EXTENSIONS[type.toLowerCase()]
  if (known) return known
  const dot = fallbackName.lastIndexOf(".")
  const fromName = dot > 0 ? fallbackName.slice(dot).toLowerCase() : ""
  return /^(\.[a-z0-9]{1,5})$/.test(fromName) ? fromName : ".png"
}

/** "2026-10-24 05.34.47" — dots keep the name a single valid filename on
 * Windows too. Local time, every field padded. */
export function formatPasteTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
}

/**
 * Display name for one pasted file. index counts the already-renamed files of
 * the same paste, so the second image.png becomes … 47 2.png while files with
 * real names pass through untouched.
 */
export function pasteDisplayName(
  file: { name: string; type?: string },
  index: number,
  language: "zh" | "en",
  now: Date,
): string {
  if (file.name !== SYNTHESIZED_PASTE_NAME) return file.name
  const ext = pasteExtensionFor(file.type || "", file.name)
  const base = language === "en" ? "Pasted image" : "粘贴的图片"
  const suffix = index > 0 ? ` ${index + 1}` : ""
  return `${base} ${formatPasteTimestamp(now)}${suffix}${ext}`
}

/**
 * Rebuild the paste batch with synthesized-name files renamed. File objects
 * are immutable, so renamed files are new File wrappers over the same bytes;
 * everything else is passed through as-is.
 */
export function renameSynthesizedPasteFiles(files: File[], language: "zh" | "en", now: Date): File[] {
  let renamed = 0
  return files.map(file => {
    if (file.name !== SYNTHESIZED_PASTE_NAME) return file
    const named = new File([file], pasteDisplayName(file, renamed, language, now), {
      type: file.type,
      lastModified: file.lastModified,
    })
    renamed += 1
    return named
  })
}
