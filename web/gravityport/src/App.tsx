import { useEffect, useRef, useState } from "react"
import Icon from "./Icon"
import ToolbarSelect from "./ToolbarSelect"
import ColumnControl from "./ColumnControl"
import ImageViewer from "./ImageViewer"
import { translate, type Language } from "./i18n"
import { desktopAPI } from "./desktop"
import {
  fetchAssetPage, fetchAsset, fetchNavigation, fetchLibraryLocation, fetchHealth, fetchVisualStatus,
  toggleAssetFavorite, updateAssetMetadata, moveAssetsToTrash, restoreAsset, setAssetsGroup,
  createGroup, moveAssetsToStack, stageImportFile, importAssetsBatch, openLibraryFolder,
  mosaMutationHeaders, type MosaAsset, type MosaNavigation, type MosaLibraryLocation,
  type MosaVisualStatus, type AssetQuery,
} from "./mosa-api"

type Scope = "all" | "favorite" | "unorganized" | "trash"

function loadPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem("gravityport.preferences") || "{}")
    return {
      appearance: ["跟随系统", "浅色", "深色"].includes(value.appearance) ? value.appearance : "跟随系统",
      cardInfo: value.cardInfo === true,
      language: value.language === "en" ? "en" as const : "zh" as const,
    }
  } catch { return { appearance: "跟随系统", cardInfo: false, language: "zh" as const } }
}

function humanSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—"
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function ratioText(width: number, height: number): string {
  if (!width || !height || width <= 1 || height <= 1) return "—"
  const trim = (value: string) => value.replace(/\.?0+$/, "")
  // Design convention normalizes the shorter side to 1: "1:1.52" portrait,
  // "1.56:1" landscape.
  return width >= height ? `${trim((width / height).toFixed(2))}:1` : `1:${trim((height / width).toFixed(2))}`
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function smartGroupLabel(name: string): string {
  return name.replace(/^web-/, "").replace(/-generated$/, "")
}

const GALLERY_PAGE_SIZE = 100

export default function App() {
  const [assets, setAssets] = useState<MosaAsset[]>([])
  const [navigation, setNavigation] = useState<MosaNavigation | null>(null)
  const [library, setLibrary] = useState<MosaLibraryLocation | null>(null)
  const [health, setHealth] = useState<{ productVersion: string; gitSha: string; distribution: string } | null>(null)
  const [visual, setVisual] = useState<MosaVisualStatus | null>(null)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [importing, setImporting] = useState(false)
  const [loadError, setLoadError] = useState("")
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [pageTotal, setPageTotal] = useState<number | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [project] = useState("default")
  const [assetType, setAssetType] = useState("all")
  const [sortOrder, setSortOrder] = useState("newest")
  const [active, setActive] = useState("所有素材")
  const [stackId, setStackId] = useState("")
  const [stackName, setStackName] = useState("")
  const [selected, setSelected] = useState("")
  const [settings, setSettings] = useState(false)
  const [settingTab, setSettingTab] = useState("常规与外观")
  const [preferences] = useState(loadPreferences)
  const [appearance, setAppearance] = useState<string>(preferences.appearance)
  const [cardInfo, setCardInfo] = useState(preferences.cardInfo)
  const [language, setLanguage] = useState<Language>(preferences.language)
  const tr = (text: string) => translate(text, language)
  const [savedLocally, setSavedLocally] = useState(true)
  useEffect(() => {
    try {
      localStorage.setItem("gravityport.preferences", JSON.stringify({ appearance, cardInfo, language }))
      setSavedLocally(true)
    } catch { setSavedLocally(false) }
    document.documentElement.lang = language === "en" ? "en" : "zh-CN"
  }, [appearance, cardInfo, language])
  // The desktop shell rebuilds its menu and notification language from this.
  useEffect(() => {
    desktopAPI()?.setLocale?.(language === "en" ? "en" : "zh")
  }, [language])
  const [detail, setDetail] = useState(true)
  const [expandedPrompt, setExpandedPrompt] = useState(false)
  const [expandedIntro, setExpandedIntro] = useState(false)
  const [expandedTags, setExpandedTags] = useState(false)
  const [addingTag, setAddingTag] = useState(false)
  const [tagDraft, setTagDraft] = useState("")
  const [tagError, setTagError] = useState("")
  const [expandedRelated, setExpandedRelated] = useState(false)
  const [preview, setPreview] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [query, setQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [columns, setColumns] = useState(5)
  const [toast, setToast] = useState("")
  const [expandedSections, setExpandedSections] = useState([true, true])
  const [skipConfirm, setSkipConfirm] = useState(false)
  const appRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const cutIdsRef = useRef<string[]>([])
  const [systemDark, setSystemDark] = useState(false)
  useEffect(() => {
    setExpandedPrompt(false)
    setExpandedIntro(false)
    setExpandedTags(false)
    setAddingTag(false)
    setTagDraft("")
    setTagError("")
  }, [selected])
  // Search input is debounced so each keystroke does not hit the store; the
  // request sequence guard below still owns stale-response protection.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 180)
    return () => clearTimeout(timer)
  }, [query])
  const scope: Scope = active === "收藏" ? "favorite" : active === "待整理" ? "unorganized" : active === "回收站" ? "trash" : "all"
  const source = active.startsWith("source:") ? active.slice(7) : active === "Pinterest" ? "pinterest" : undefined
  const group = active.startsWith("group:") ? active.slice(6) : undefined
  const mediaKind = assetType === "image" ? "img" : assetType === "video" ? "video" : "all"
  const buildQuery = (cursor?: string): AssetQuery => ({
    project, q: debouncedQuery, scope, mediaKind, sort: sortOrder as AssetQuery["sort"],
    ...(source ? { source } : {}), ...(group ? { group } : {}), ...(stackId ? { stackId } : {}),
    ...(cursor ? { cursor } : {}),
  })
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError("")
    fetchAssetPage(buildQuery(), { signal: controller.signal })
      .then(page => {
        if (controller.signal.aborted) return
        setAssets(page.assets)
        setNextCursor(page.nextCursor)
        setPageTotal(page.total)
        setSelected(old => old && page.assets.some(a => a.id === old) ? old : page.assets[0]?.id || "")
      })
      .catch(error => { if (!controller.signal.aborted) setLoadError(String(error?.message || error)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, active, debouncedQuery, sortOrder, assetType, stackId, refreshKey])
  const refreshNavigation = () => setRefreshKey(value => value + 1)
  useEffect(() => {
    const controller = new AbortController()
    fetchNavigation(project, controller.signal).then(data => {
      if (!controller.signal.aborted) setNavigation(data)
    }).catch(() => {})
    fetchLibraryLocation(project, controller.signal).then(data => {
      if (!controller.signal.aborted && data.path) setLibrary(data)
    }).catch(() => {})
    fetchHealth(controller.signal).then(data => {
      if (!controller.signal.aborted) setHealth(data)
    }).catch(() => {})
    fetchVisualStatus(project, controller.signal).then(data => {
      if (!controller.signal.aborted) setVisual(data)
    }).catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, refreshKey])
  // Live library updates: the runtime broadcasts journaled revisions over SSE;
  // bursts are debounced into one reload of the current view.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stream = new EventSource(`/api/library-events?project=${encodeURIComponent(project)}`)
    stream.addEventListener("library-changed", () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => refreshNavigation(), 300)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stream.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project])
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const sync = () => setSystemDark(media.matches)
    sync()
    media.addEventListener("change", sync)
    return () => media.removeEventListener("change", sync)
  }, [])
  useEffect(() => {
    if (!settings && !deleting) return
    const dialog = appRef.current?.querySelector<HTMLElement>(
      deleting ? '[role="alertdialog"]' : '[role="dialog"]',
    )
    const previous = document.activeElement as HTMLElement | null
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input, select, [tabindex="0"]',
    ) || [])
    controls()[0]?.focus()
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return
      const list = controls()
      const first = list[0]
      const last = list[list.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener("keydown", trap)
    return () => {
      document.removeEventListener("keydown", trap)
      previous?.focus()
    }
  }, [settings, deleting])
  useEffect(() => {
    if (!selected) return
    const controller = new AbortController()
    fetchAsset(project, selected, controller.signal).then(full => {
      if (!controller.signal.aborted) setAssets(old => old.map(item => item.id === full.id ? full : item))
    }).catch(() => {})
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected])
  // Keep two visual states honest while the model pack installs on desktop.
  useEffect(() => {
    const api = desktopAPI()
    if (!api?.onVisualPackProgress) return
    api.onVisualPackProgress(progress => {
      const percent = Number(progress?.percent)
      setModelProgress(Number.isFinite(percent) ? percent : null)
    })
  }, [])
  const asset = assets.find((a) => a.id === selected) || assets[0]
  const currentTags = asset ? asset.tags : []
  const visible = assets
  const notify = (text: string) => setToast(tr(text))
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 2600)
      return () => clearTimeout(timer)
    }
  }, [toast])
  const loadMore = async () => {
    if (!nextCursor || loadingMore || loading) return
    setLoadingMore(true)
    try {
      const page = await fetchAssetPage(buildQuery(nextCursor), { cursor: nextCursor })
      setAssets(old => {
        const seen = new Set(old.map(item => item.id))
        return [...old, ...page.assets.filter(item => !seen.has(item.id))]
      })
      setNextCursor(page.nextCursor)
    } catch (error) { notify(errorMessage(error)) }
    finally { setLoadingMore(false) }
  }
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !nextCursor) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) void loadMore()
    }, { rootMargin: "600px 0px" })
    observer.observe(node)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextCursor, loadingMore, loading])
  const exitStack = () => {
    if (!stackId) return false
    setStackId("")
    setStackName("")
    return true
  }
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (deleting) setDeleting(false)
        else if (menu) setMenu(null)
        else if (settings) setSettings(false)
        else setPreview(false)
      }
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        !(e.target instanceof HTMLInputElement) &&
        !settings && !deleting && assets.length > 0 && active !== "回收站"
      )
        setDeleting(true)
      const inField = e.target instanceof HTMLElement
        && (e.target.isContentEditable || e.target.closest("input, textarea, select"))
      if (inField) return
      if ((e.metaKey || e.ctrlKey) && (e.key === "x" || e.key === "X") && asset) {
        e.preventDefault()
        cutIdsRef.current = [asset.id]
        notify("已剪切")
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V") && cutIdsRef.current.length) {
        e.preventDefault()
        if (!stackId) { notify("粘贴需要在堆叠中进行"); return }
        const ids = [...new Set(cutIdsRef.current)]
        cutIdsRef.current = []
        moveAssetsToStack(project, ids, stackId)
          .then(() => { notify("已粘贴到堆叠"); refreshNavigation() })
          .catch(error => notify(errorMessage(error)))
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, deleting, menu, assets.length, asset, stackId, active, language])
  // Local file import: drag onto the workspace or paste image files. Every file
  // goes through the server's staging endpoint, so rejected types surface as
  // real errors instead of silent drops.
  const importFiles = async (files: File[], groupName?: string): Promise<string[]> => {
    if (!files.length || importing) return []
    const supported = library?.supportedMediaExtensions
    const usable = files.filter(file => {
      if (!supported || !supported.length) return true
      const lower = file.name.toLowerCase()
      return supported.some(ext => lower.endsWith(ext.toLowerCase()))
    })
    if (!usable.length) { notify("导入失败"); return [] }
    setImporting(true)
    notify("正在导入素材")
    try {
      const items: { imagePath: string }[] = []
      for (const file of usable) {
        try { items.push({ imagePath: await stageImportFile(file) }) }
        catch (error) { notify(errorMessage(error)) }
      }
      if (!items.length) return []
      const result = await importAssetsBatch(project, items)
      const createdIds = result.results.filter(item => item.ok !== false && typeof item.id === "string").map(item => item.id as string)
      if (groupName && createdIds.length) {
        try { await setAssetsGroup(project, createdIds, groupName) } catch (error) { notify(errorMessage(error)) }
      }
      if (result.failed) notify("部分素材导入失败")
      else notify("导入完成")
      refreshNavigation()
      return createdIds
    } catch (error) {
      notify(errorMessage(error))
      return []
    } finally {
      setImporting(false)
    }
  }
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (active === "回收站") return
      const files = Array.from(event.clipboardData?.files || [])
      if (files.length) void importFiles(files)
    }
    window.addEventListener("paste", paste)
    return () => window.removeEventListener("paste", paste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importing, library, active])
  const navigateAsset = (direction: number) => {
    if (!visible.length) return
    const index = visible.findIndex(a => a.id === selected)
    setSelected(visible[(index + direction + visible.length) % visible.length].id)
  }
  const toggleFavorite = async () => {
    if (!asset) return
    try {
      const updated = await toggleAssetFavorite(asset.project_id, asset.id)
      setAssets(old => old.map(a => a.id === updated.id ? updated : a))
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const remove = async () => {
    if (!asset) return
    try {
      await moveAssetsToTrash(asset.project_id, [asset.id])
      setDeleting(false)
      setPreview(false)
      setAssets(old => old.filter(a => a.id !== asset.id))
      setSelected(old => old === asset.id ? "" : old)
      notify("素材已移至回收站")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const requestDelete = () => {
    setMenu(null)
    if (skipConfirm) remove()
    else setDeleting(true)
  }
  const restore = async () => {
    if (!asset) return
    try {
      await restoreAsset(asset.project_id, asset.id)
      setMenu(null)
      setPreview(false)
      notify("素材已恢复至素材库")
      refreshNavigation()
    } catch (error) { notify(errorMessage(error)) }
  }
  const assignGroup = (name: string) => {
    if (!asset) return
    setAssetsGroup(asset.project_id, [asset.id], name)
      .then(() => {
        setAssets(old => old.map(a => a.id === asset.id ? { ...a, group: name } : a))
        notify(name ? "已添加到分组" : "已从分组移除")
        refreshNavigation()
      })
      .catch(error => notify(errorMessage(error)))
  }
  const writeText = async (text: string) => {
    const api = desktopAPI()
    if (api?.writeClipboardText) { await api.writeClipboardText(text); return }
    await navigator.clipboard?.writeText(text)
  }
  const copyImage = async () => {
    if (!asset) return
    try {
      const api = desktopAPI()
      if (api?.writeClipboardImage && asset.image_path) {
        await api.writeClipboardImage(asset.image_path)
      } else {
        const response = await fetch(asset.preview_url || asset.image_url, { credentials: "same-origin" })
        const blob = await response.blob()
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
      }
      notify(`${tr("复制图片")} ${tr("完成")}`)
    } catch { notify(tr("复制图片失败")) }
  }
  const exportAsset = () => {
    if (!asset) return
    const link = document.createElement("a")
    link.href = asset.image_url
    link.download = asset.name
    document.body.appendChild(link)
    link.click()
    link.remove()
    notify(`${tr("导出至")} ${tr("完成")}`)
  }
  const revealAssetPath = async () => {
    if (!asset) return
    try {
      await openLibraryFolder(asset.image_path, true)
      return
    } catch { /* fall through to copying the path */ }
    try {
      await writeText(asset.image_path || asset.image_url)
      notify(tr("路径已复制"))
    } catch { notify(tr("无法打开该位置")) }
  }
  const showInLibrary = () => {
    setMenu(null)
    setPreview(false)
    setStackId("")
    setStackName("")
    setQuery("")
    setDebouncedQuery("")
    setActive("所有素材")
    if (asset) setSelected(asset.id)
  }
  const addToActiveGroup = () => {
    if (!asset) return
    if (!group) { notify(tr("请先在左侧选择或新建分组")); return }
    assignGroup(group)
  }
  const installModelPack = async () => {
    const api = desktopAPI()
    if (!api?.installVisualPack) { notify("尚未连接模型服务，暂时无法安装"); return }
    try {
      setModelProgress(0)
      const result = await api.installVisualPack()
      if (result && result.ok === false) {
        notify(String(result.error || tr("模型组件安装失败")))
      } else {
        notify(tr("模型组件已安装"))
      }
    } catch (error) {
      notify(String((error as Error)?.message || tr("模型组件安装失败")))
    } finally {
      setModelProgress(null)
      refreshNavigation()
    }
  }
  const checkForUpdates = async () => {
    const api = desktopAPI()
    if (!api?.checkForUpdates) { notify(tr("网页版请访问官网获取最新版本")); return }
    try {
      await api.checkForUpdates(true)
    } catch (error) {
      notify(String((error as Error)?.message || error))
    }
  }
  const changeLibraryLocation = async () => {
    const api = desktopAPI()
    if (!api?.changeLibraryLocation) { notify(tr("请在桌面版中修改素材库位置")); return }
    try {
      const result = await api.changeLibraryLocation()
      if (result && result.ok === false) {
        notify(String(result.error || tr("无法打开该位置")))
        return
      }
      notify(tr("已保存"))
      refreshNavigation()
    } catch (error) {
      notify(String((error as Error)?.message || error))
    }
  }
  const openStorageLocation = async () => {
    const target = library?.libraryDir || library?.path || ""
    if (!target) return
    try {
      await openLibraryFolder(target)
      notify(tr("已在桌面端打开存储位置"))
    } catch {
      try {
        await writeText(target)
        notify("路径已复制，请在系统文件管理器中打开")
      } catch { notify("浏览器无法直接打开本地文件夹，请手动复制路径") }
    }
  }
  const createNamedGroup = () => {
    // The design's add-group affordance creates an untitled group and activates
    // it; the server owns uniqueness, so colliding auto names bump the index.
    const existing = navigation?.groups.length ?? 0
    const attempt = (index: number) => {
      const name = `新分组 ${index}`
      createGroup(project, name)
        .then(() => {
          setStackId("")
          setActive(`group:${name}`)
          setPreview(false)
          refreshNavigation()
        })
        .catch((error: Error & { code?: string }) => {
          if (error?.code === "GROUP_ALREADY_EXISTS" && index < existing + 20) attempt(index + 1)
          else notify(errorMessage(error))
        })
    }
    attempt(existing + 1)
  }
  const versionBadge = health?.productVersion
    ? `${tr("版本")} ${health.productVersion}${health.distribution === "development" ? ` · ${tr("开发版")}` : ""}`
    : tr("版本")
  const assetPathTail = asset
    ? (asset.image_path || asset.image_url || "").split(/[\\/]/).pop() || ""
    : ""
  const relatedAssets = assets.filter(a => a.id !== (asset?.id || "")).slice(0, expandedRelated ? 6 : 2)

  return (
    <div
      ref={appRef}
      className={`app ${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : ""}`}
      onClick={() => menu && setMenu(null)}
    >
      <aside className="sidebar">
        <div className="brandbar">
          <div className="traffic">
            <i />
            <i />
            <i />
          </div>
          <strong>GravityPort</strong>
        </div>
        <nav className="main-nav" aria-label={tr("素材库")}>
          {["所有素材", "Pinterest", "待整理", "收藏", "回收站"].map(
            (label, i) => (
              <button
                key={label}
                title={tr(label)}
                aria-label={tr(label)}
                aria-current={active === label ? "page" : undefined}
                className={`nav-row ${active === label ? "selected" : ""}`}
                onClick={() => {
                  setStackId("")
                  setStackName("")
                  setActive(label)
                  setPreview(false)
                }}
              >
                {i === 1 ? <span className="brand-icon" aria-hidden="true" /> : <Icon
                  name={i === 2 ? "inbox" : i === 3 ? "heart" : i === 4 ? "trash" : "grid"}
                  size={16}
                />}
                <span>{tr(label)}</span>
                <small>
                  {i === 0
                    ? navigation?.total ?? 0
                    : i === 1
                      ? navigation?.sourceTypes.find(s => s[0] === "pinterest")?.[1] ?? 0
                      : i === 2
                        ? navigation?.unorganized ?? 0
                        : i === 3
                          ? navigation?.favorites ?? 0
                          : navigation?.trash ?? 0}
                </small>
              </button>
            ),
          )}
        </nav>
        {[0, 1].map((section) => (
          <div className="group-section" key={section}>
            <div className="section-label">
              <button
                className="section-toggle"
                aria-label={section === 0 ? tr("智能分组") : tr("我的分组")}
                aria-expanded={expandedSections[section]}
                aria-controls={`sidebar-group-${section}`}
                onClick={() => setExpandedSections(old => old.map((value, i) => i === section ? !value : value))}
              >
                <span>{section === 0 ? tr("智能分组") : tr("我的分组")}</span>
                <Icon name={expandedSections[section] ? "down" : "right"} size={12} />
              </button>
              {section === 1 && <button
                className="add-group"
                aria-label={tr("添加我的分组")}
                title={tr("添加分组")}
                onClick={createNamedGroup}
              ><Icon name="plus" size={16} /></button>}
            </div>
            <nav id={`sidebar-group-${section}`} aria-label={section === 0 ? tr("智能分组") : tr("我的分组")} hidden={!expandedSections[section]}>
            {(section === 0
              ? (navigation?.sourceTypes || []).filter(entry => entry[1] > 0).map(entry => ({ id: `source:${entry[0]}`, name: smartGroupLabel(entry[0]), count: entry[1] }))
              : (navigation?.groups || []).map(entry => ({ id: `group:${entry.name}`, name: entry.name, count: entry.count }))
            ).map((g) => (
              <button
                className={`nav-row group-row ${
                  active === g.id ? "selected" : ""
                }`}
                key={g.id}
                title={tr(g.name)}
                aria-label={tr(g.name)}
                aria-current={active === g.id ? "page" : undefined}
                onClick={() => { setStackId(""); setStackName(""); setActive(g.id); setPreview(false) }}
                onDragOver={event => {
                  if (g.id.startsWith("group:") && !preview && !settings) event.preventDefault()
                }}
                onDrop={event => {
                  if (!g.id.startsWith("group:") || preview || settings) return
                  event.preventDefault()
                  void importFiles(Array.from(event.dataTransfer?.files || []), g.name)
                }}
              >
                <Icon name={section === 0 ? "layers" : "folder"} size={16} />
                <span>{tr(g.name)}</span>
                <small>{g.count}</small>
              </button>
            ))}
            </nav>
          </div>
        ))}
        <button className="user-button" onClick={() => setSettings(true)}>
          <Icon name="user" size={14} />
          <span>{tr("用户中心")}</span>
          <Icon name="settings" size={14} />
        </button>
      </aside>
      <main
        className={`workspace ${preview ? "preview-open" : ""}`}
        onDragOver={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
        }}
        onDrop={event => {
          if (preview || settings || active === "回收站") return
          event.preventDefault()
          void importFiles(Array.from(event.dataTransfer?.files || []))
        }}
      >
        <header className="toolbar">
          <div className="toolbar-left">
            {preview ? (
              <button onClick={() => setPreview(false)}>
                <Icon name="left" size={14} />
                {tr("返回")}</button>
            ) : (
              <>
                <button aria-label={tr("后退")} onClick={() => { if (!exitStack()) setActive("所有素材") }}>
                  <Icon name="left" />
                </button>
                <button
                  aria-label={tr("前进")}
                  onClick={() => notify("已是最新浏览位置")}
                >
                  <Icon name="right" />
                </button>
              </>
            )}
          </div>
          {preview && <div className="viewer-title"><strong>{asset?.name}</strong><span>{Math.max(1, visible.findIndex(a => a.id === asset?.id) + 1)} / {visible.length}</span></div>}
          {!preview && stackId && <div className="viewer-title"><strong>{stackName}</strong><span>{visible.length} {tr("素材")}</span></div>}
          <div className="toolbar-right">
            {preview ? (
              <>
                {active !== "回收站" && <button onClick={requestDelete}>
                  <Icon name="trash" size={12} />
                  {tr("删除")}</button>}
                <button onClick={() => setDetail(!detail)}>
                  <Icon name="info" size={16} />
                  {tr(detail ? "隐藏详情" : "显示详情")}</button>
              </>
            ) : (
              <>
                <ToolbarSelect label={tr("素材类型")} value={assetType} onChange={setAssetType} options={[{ value: "all", label: tr("全部类型") }, { value: "image", label: tr("图片") }, { value: "video", label: tr("视频") }]} />
                <ToolbarSelect label={tr("排序")} value={sortOrder} onChange={setSortOrder} options={[{ value: "newest", label: tr("最新优先") }, { value: "name", label: tr("名称排序") }]} />
                <ColumnControl value={columns} onChange={setColumns} language={language} />
                <label className="search">
                  <input
                    aria-label={tr("搜索素材")}
                    placeholder={tr("搜索素材")}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <Icon name="search" size={12} />
                </label>
                {!detail && <button className="detail-toggle" aria-label={tr("显示详情")} title={tr("显示详情")} aria-expanded={false} onClick={() => setDetail(true)}><Icon name="inspector" size={16} /></button>}
              </>
            )}
          </div>
        </header>
        {preview ? (
          <ImageViewer key={asset?.id} width={asset?.width || 768} height={asset?.height || 1170} src={asset?.preview_url || asset?.image_url} isVideo={asset?.mediaKind === "video"} language={language} disabled={settings || deleting || !!menu} onNavigate={navigateAsset} onContextMenu={(x, y) => setMenu({ x, y })} message={toast} />
        ) : (
          <div
            className="asset-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
          >
            {visible.map((a) => (
              <button
                key={a.id}
                aria-label={`${tr("查看素材")} ${a.stack ? `${tr("堆叠")} ${a.stack.name}` : a.name}`}
                className={`asset-card ${
                  selected === a.id && !settings ? "asset-selected" : ""
                }`}
                style={{ aspectRatio: `${a.width} / ${a.height}` }}
                onClick={() => {
                  if (a.stack) {
                    setStackId(a.stack.id)
                    setStackName(a.stack.name || a.name)
                    setSelected("")
                    return
                  }
                  setSelected(a.id)
                  setDetail(true)
                }}
                onDoubleClick={() => {
                  if (a.stack) return
                  setSelected(a.id)
                  setPreview(true)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (a.stack) return
                  setSelected(a.id)
                  setMenu({ x: e.clientX, y: e.clientY })
                }}
              >
                {a.thumbnail_url ? <img className="black-image" src={a.thumbnail_url} alt="" loading="lazy" /> : <div className="black-image" />}
                {a.stack && (
                  <span className="stack-mark">
                    <Icon name="layers" size={12} />
                    {a.stack.count}
                  </span>
                )}
                {a.favorite && (
                  <span className="favorite-mark">
                    <Icon name="heart" size={12} />
                  </span>
                )}
                {cardInfo && <span className="card-name">{a.stack ? a.stack.name || a.name : a.name}</span>}
              </button>
            ))}
            {loading && <div className="empty-state" role="status">{tr("加载中")}</div>}
            {!loading && loadError && <div className="empty-state" role="alert"><Icon name="info" size={30} /><p>{loadError}</p><button onClick={refreshNavigation}>{tr("重试")}</button></div>}
            {!loading && !loadError && visible.length === 0 && (
              <div className="empty-state">
                <Icon
                  name={active === "回收站" ? "trash" : "search"}
                  size={30}
                />
                <p>
                  {active === "回收站"
                    ? tr("回收站中的素材保留 90 天")
                    : tr("没有找到匹配的素材")}
                </p>
              </div>
            )}
            <div ref={sentinelRef} aria-hidden="true" />
          </div>
        )}
      </main>
      {detail && asset && (
        <aside className="details">
          <div className="detail-heading">
            <strong>{tr("素材详情")}</strong>
            <button aria-label={tr("关闭素材详情")} onClick={() => setDetail(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="asset-summary">
            <button className="summary-image" aria-label={tr("预览当前素材")} onClick={() => setPreview(true)}>{asset.thumbnail_url ? <img src={asset.thumbnail_url} alt="" /> : null}<Icon name="expand" /></button>
            <div className="asset-meta">
              <div className="asset-title">
                <span className="asset-name" title={asset.name}>{asset.name}</span>
                <button
                  className={asset.favorite ? "is-favorite" : ""}
                  aria-label={tr("收藏素材")}
                  aria-pressed={!!asset.favorite}
                  onClick={toggleFavorite}
                >
                  <Icon name="heart" size={13} />
                </button>
              </div>
              <span className="muted">{asset.mediaKind === "video" ? tr("视频 · 本地素材") : tr("图片 · 本地素材")}</span>
              <button className="summary-preview" onClick={() => setPreview(true)}>{tr("打开预览")}<Icon name="right" size={12} /></button>
            </div>
          </div>
          <div className="asset-properties">
              {[
                ["格式", asset.format || "—"],
                ["尺寸", asset.width > 1 && asset.height > 1 ? `${asset.width} × ${asset.height}` : "—"],
                ["比例", ratioText(asset.width, asset.height)],
                ["大小", humanSize(asset.size_bytes)],
              ].map(([label, value]) => (
                <span className="property-tag" key={label} title={`${tr(label)}: ${tr(value)}`} aria-label={`${tr(label)}: ${tr(value)}`}>{tr(value)}</span>
              ))}
          </div>
          <div className="tags">
            {currentTags.slice(0, expandedTags ? currentTags.length : 3).map((t) => (
              <button key={t} onClick={() => notify(`${tr("标签：")}${t}`)}>
                {t}
              </button>
            ))}
            {currentTags.length > 3 && <button className="tags-toggle" aria-expanded={expandedTags} onClick={() => setExpandedTags(!expandedTags)}>{expandedTags ? tr("收起") : `+${currentTags.length - 3}`}</button>}
            {!addingTag && <button className="add-tag" onClick={() => { setAddingTag(true); setTagError("") }}><Icon name="plus" size={12} />{tr("添加标签")}</button>}
            {addingTag && <form className="tag-editor" onSubmit={e => {
              e.preventDefault()
              const tag = tagDraft.trim()
              if (!tag) { setTagError("请输入标签名称"); return }
              if (currentTags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setTagError("标签已存在"); return }
              updateAssetMetadata(asset.project_id, asset.id, { tags: [...currentTags, tag] }).then(updated => {
                setAssets(old => old.map(a => a.id === updated.id ? updated : a))
              }).catch(error => notify(errorMessage(error)))
              setExpandedTags(true)
              setTagDraft("")
              setTagError("")
              setAddingTag(false)
            }}>
              <div className="tag-editor-controls">
                <input aria-label={tr("标签名称")} placeholder={tr("标签名称")} autoFocus maxLength={32} value={tagDraft} aria-invalid={!!tagError} aria-describedby={tagError ? "tag-error" : undefined} onChange={e => { setTagDraft(e.target.value); setTagError("") }} onKeyDown={e => {
                  if (e.key === "Escape") { e.stopPropagation(); setAddingTag(false); setTagDraft(""); setTagError("") }
                  if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault()
                }} />
                <button type="submit" aria-label={tr("保存标签")} title={tr("保存标签")}><Icon name="check" size={16} /></button>
                <button type="button" aria-label={tr("取消")} title={tr("取消")} onClick={() => { setAddingTag(false); setTagDraft(""); setTagError("") }}><Icon name="close" size={16} /></button>
              </div>
              {tagError && <p id="tag-error" role="alert">{tr(tagError)}</p>}
            </form>}
          </div>
          {asset.palette.length > 0 && <div className="palette">
            {asset.palette.map((c) => (
              <button
                key={c}
                title={`${tr("复制颜色")} ${c}`}
                style={{ background: c }}
                aria-label={`${tr("复制颜色")} ${c}`}
                onClick={async () => {
                  try { await writeText(c) } catch { navigator.clipboard?.writeText(c) }
                  notify(`${tr("已复制")} ${c}`)
                }}
              />
            ))}
          </div>}
          <section className="detail-section">
            <div className="field-heading">
              <span>
                {tr("提示词")}<small>{tr("原始信息")}</small>
              </span>
              <button
                aria-label={tr("复制提示词")}
                onClick={async () => {
                  if (!asset.prompt) { notify(tr("无提示词记录")); return }
                  try { await writeText(asset.prompt); notify("提示词已复制") }
                  catch { notify(String(tr("复制失败"))) }
                }}
              >
                <Icon name="copy" size={16} />
              </button>
            </div>
            <div className={`detail-reading ${expandedPrompt ? "expanded" : ""}`}>
              <p id="asset-prompt">{asset.prompt || tr("无提示词记录")}</p>
              <button className="reading-toggle" aria-expanded={expandedPrompt} aria-controls="asset-prompt" onClick={() => setExpandedPrompt(!expandedPrompt)}>{expandedPrompt ? tr("收起") : tr("展开提示词")}<Icon name={expandedPrompt ? "minus" : "down"} size={12} /></button>
            </div>
          </section>
          {asset.introduction && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("内容介绍")}</span>
              <button
                aria-label={tr("复制内容介绍")}
                onClick={async () => {
                  try { await writeText(asset.introduction); notify("内容介绍已复制") }
                  catch { navigator.clipboard?.writeText(asset.introduction) }
                }}
              >
                <Icon name="copy" size={16} />
              </button>
            </div>
            <div className={`detail-reading ${expandedIntro ? "expanded" : ""}`}>
              <p id="asset-introduction">{asset.introduction}</p>
              <button className="reading-toggle" aria-expanded={expandedIntro} aria-controls="asset-introduction" onClick={() => setExpandedIntro(!expandedIntro)}>{expandedIntro ? tr("收起") : tr("展开介绍")}<Icon name={expandedIntro ? "minus" : "down"} size={12} /></button>
            </div>
          </section>}
          {asset.references.length > 0 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("参考图")}</span>
            </div>
            <div className="reference-gallery" aria-label={tr("参考图缩略图")}>
              {asset.references.slice(0, 8).map((reference, index) => {
                const url = reference.attachment_url || reference.thumbnail_url || reference.image_url || ""
                if (!url) return null
                return <button key={reference.reference_id || index} className="reference-thumbnail" aria-label={tr("预览参考图")} onClick={() => window.open(url, "_blank", "noopener")}>
                  <img className="reference-image" src={url} alt="" loading="lazy" />
                </button>
              })}
            </div>
          </section>}
          {relatedAssets.length > 0 && <section className="detail-section">
            <div className="field-heading">
              <span>{tr("相关推荐")}</span>
              <button className="section-action" aria-expanded={expandedRelated} onClick={() => setExpandedRelated(!expandedRelated)}>{expandedRelated ? tr("收起") : tr("更多")}<Icon name="down" size={12} /></button>
            </div>
            {relatedAssets.map((relatedAsset) => (
              <button
                className="related"
                key={relatedAsset.id}
                onClick={() => setSelected(relatedAsset.id)}
              >
                <i />
                <span>
                  {relatedAsset.name}
                  <small>
                    {relatedAsset.format || "—"} · {relatedAsset.width} × {relatedAsset.height}
                  </small>
                </span>
                <Icon name="right" size={11} />
              </button>
            ))}
          </section>}
          <button
            className="library-location"
            onClick={revealAssetPath}
          >
            <strong>{tr("素材路径")}</strong>
            <span title={asset.image_path || asset.image_url}>{assetPathTail ? `…/${assetPathTail}` : "—"}</span>
            <Icon name="external" size={12} />
          </button>
        </aside>
      )}
      {settings && (
        <div
          className="modal-layer"
          onMouseDown={(e) =>
            e.target === e.currentTarget && setSettings(false)
          }
        >
          <div
            className="settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={tr("设置")}
          >
            <aside className="settings-nav">
              <h2>{tr("设置")}</h2>
              {[
                ["常规与外观", "sun"],
                ["存储", "folder"],
                ["模型", "grid"],
                ["MCP", "link"],
                ["关于", "info"],
              ].map(([label, icon]) => (
                <button
                  className={settingTab === label ? "active" : ""}
                  aria-pressed={settingTab === label}
                  key={label}
                  onClick={() => setSettingTab(label)}
                >
                  <Icon name={icon} size={15} />
                  {tr(label === "常规与外观" ? "常规" : label)}
                </button>
              ))}
              <div className="settings-brand">
                GravityPort
                <span>{tr("让灵感，自由停靠。")}</span>
              </div>
            </aside>
            <div className="settings-content">
              <div className="settings-heading">
                <div className="settings-heading-copy">
                  <h3>{tr(settingTab === "常规与外观" ? "常规" : settingTab)}</h3>
                </div>
                <button
                  className="modal-close"
                  aria-label={tr("关闭设置")}
                  onClick={() => setSettings(false)}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
              <div className="settings-page" key={settingTab}>
              {settingTab === "常规与外观" ? (
                <>
                  <section className="settings-section theme-section" aria-label={tr("外观")}>
                  <div className="appearance-options">
                    {["跟随系统", "浅色", "深色"].map((a, i) => (
                      <button
                        key={a}
                        aria-pressed={appearance === a}
                        className={`appearance-option ${
                          appearance === a ? "chosen" : ""
                        }`}
                        onClick={() => setAppearance(a)}
                      >
                        <div className={`theme-preview theme-${i}`}>
                          <div className="mini-sidebar" />
                          <div className="mini-content">
                            <i />
                            <i />
                            <i />
                            <i />
                          </div>
                          {appearance === a && (
                            <span>
                              <Icon name="check" size={10} />
                            </span>
                          )}
                        </div>
                        <span>{tr(a)}</span>
                      </button>
                    ))}
                  </div>
                  </section>
                  <section className="settings-section">
                  <div className="setting-row">
                    <span>{tr("显示素材名称")}</span>
                    <button className={`settings-switch ${cardInfo ? "enabled" : ""}`} role="switch" aria-checked={cardInfo} aria-label={tr("显示素材名称")} onClick={() => setCardInfo(!cardInfo)}><span /></button>
                  </div>
                  </section>
                  <section className="settings-section">
                  <div className="setting-row">
                    <span>{tr("界面语言")}</span>
                    <div className="segmented" role="group" aria-label={tr("界面语言")}>
                      <button className={language === "zh" ? "on" : ""} aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中文</button>
                      <button className={language === "en" ? "on" : ""} aria-pressed={language === "en"} onClick={() => setLanguage("en")}>English</button>
                    </div>
                  </div>
                  </section>
                </>
              ) : settingTab === "存储" ? (
                <>
                  <section className="settings-section">
                    <div className="storage-summary storage-path">
                      <Icon name="folder" size={16} />
                      <div className="storage-description"><strong>{tr("存储位置")}</strong><span title={library?.path || ""}>{library?.path || "—"}</span></div>
                      <div className="storage-actions">
                        <button className="neutral-button" onClick={openStorageLocation}>{tr("打开")}</button>
                        <button className="neutral-button" onClick={changeLibraryLocation}>{tr("修改")}</button>
                      </div>
                    </div>
                  </section>
                  <div className="settings-note"><p>{library ? `${tr("存储类型")}: ${library.storage}` : ""}</p></div>
                </>
              ) : settingTab === "模型" ? (
                <>
                  <section className="settings-section">
                    <div className="model-summary">
                      <div className="model-symbol"><Icon name="layers" size={16} /></div>
                      <div className="model-description"><strong>{tr("本地视觉搜索")}</strong><span title={visual?.available ? tr("模型服务运行中") : tr("尚未连接模型服务")}>
                        {visual?.available
                          ? tr("模型服务运行中")
                          : modelProgress != null
                            ? `${tr("正在安装模型组件")} ${modelProgress}%`
                            : tr("尚未连接模型服务")}
                      </span></div>
                      {!visual?.available && <button className="neutral-button" onClick={installModelPack}>{tr("安装")}</button>}
                    </div>
                  </section>
                  <div className="settings-note"><p>{tr("连接模型服务后即可启用。")}</p></div>
                </>
              ) : settingTab === "MCP" ? (
                <>
                  <section className="settings-section integration-card">
                      <div className="model-symbol"><span className="brand-icon" aria-hidden="true" /></div>
                      <div className="integration-copy">
                        <div className="integration-title"><strong>Pinterest</strong><span>{tr("未连接")}</span></div>
                        <p className="integration-description">{tr("连接 Pinterest MCP 后，可同步收藏与画板。")}</p>
                      </div>
                      <button className="neutral-button" onClick={() => notify("尚未接入 Pinterest MCP 服务，暂时无法连接")}>{tr("连接")}</button>
                  </section>
                </>
              ) : (
                <>
                  <section className="settings-section about-summary">
                    <div className="about-symbol">
                      <img className="app-logo" src={`/assets/gravityport-mark-${appearance === "深色" || (appearance === "跟随系统" && systemDark) ? "dark" : "light"}.svg`} width={40} height={40} alt="" aria-hidden="true" />
                    </div>
                    <div className="about-identity"><h4>GravityPort</h4><span className="settings-badge" title={versionBadge}>{versionBadge}</span></div>
                    <button className="neutral-button about-update" onClick={checkForUpdates}>{tr("检查更新")}</button>
                  </section>
                  <section className="settings-section release-notes" aria-labelledby="release-notes-title">
                    <div className="release-heading"><h4 id="release-notes-title">{tr("本次更新")}</h4><span>{tr("构建信息")}</span></div>
                    <ul>
                      <li>{tr("版本")} {health?.productVersion || "—"}</li>
                      <li>{tr("构建")} {health?.gitSha ? health.gitSha.slice(0, 7) : "—"}</li>
                      <li>{health?.distribution === "development" ? tr("开发版") : tr("正式版")}</li>
                    </ul>
                  </section>
                </>
              )}
              </div>
              {!savedLocally && <div className="settings-footnote" role="status">
                <Icon name="info" size={12} />
                {tr("无法保存偏好，仅在当前会话生效")}
              </div>}
            </div>
          </div>
        </div>
      )}
      {menu && asset && (
        <div
          className="context-menu"
          style={{
            left: Math.min(menu.x, window.innerWidth - 220),
            top: Math.min(menu.y, window.innerHeight - 385),
          }}
        >
          {[
            ["在查看器中打开", "external"],
            ["在素材库中显示", "folder"],
            ["复制图片", "image"],
            ["剪切", "scissors"],
            ["复制提示词", "copy"],
            ["复制路径", "link"],
            [asset.favorite ? "取消收藏" : "收藏", "heart"],
            ["添加分组", "plus"],
            ["移除分组", "folder"],
            ["导出至", "external"],
            [active === "回收站" ? "恢复素材" : "移至回收站", "trash"],
          ].map(([label, icon], i) => (
            <button
              className={`${
                i === 2 || i === 6 || i === 9 ? "menu-divider" : ""
              } ${i === 10 ? "danger" : ""}`}
              key={label}
              onClick={() => {
                setMenu(null)
                if (i === 0) setPreview(true)
                else if (i === 1) showInLibrary()
                else if (i === 2) copyImage()
                else if (i === 3) {
                  cutIdsRef.current = [asset.id]
                  notify("已剪切")
                } else if (i === 4) {
                  if (!asset.prompt) { notify(tr("无提示词记录")); return }
                  writeText(asset.prompt).then(() => notify(`${tr("复制提示词")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
                } else if (i === 5) {
                  writeText(asset.image_path || asset.image_url).then(() => notify(`${tr("复制路径")} ${tr("完成")}`)).catch(() => notify(tr("复制失败")))
                } else if (i === 6) toggleFavorite()
                else if (i === 7) addToActiveGroup()
                else if (i === 8) assignGroup("")
                else if (i === 9) exportAsset()
                else if (active === "回收站") restore()
                else requestDelete()
              }}
            >
              <Icon name={icon} size={14} />
              <span>{tr(String(label))}</span>
              {i === 0 && <small><Icon name="enter" size={12} /></small>}
              {i === 10 && <small><Icon name="backspace" size={12} /></small>}
            </button>
          ))}
        </div>
      )}
      {deleting && (
        <div className="modal-layer delete-layer">
          <div className="delete-modal" role="alertdialog" aria-modal="true">
            <div className="delete-icon">
              <Icon name="trash" size={26} />
            </div>
            <h3>{tr("是否移至回收站？")}</h3>
            <p>{tr("素材会在回收站保留 90 天，期间可以随时还原。")}</p>
            <div className="delete-actions">
              <label>
                <input
                  type="checkbox"
                  checked={skipConfirm}
                  onChange={(e) => setSkipConfirm(e.target.checked)}
                />
                {tr("不再提醒")}</label>
              <button
                className="neutral-button"
                onClick={() => setDeleting(false)}
              >
                {tr("取消")}</button>
              <button className="primary-button" onClick={remove}>
                {tr("移至回收站")}</button>
            </div>
          </div>
        </div>
      )}
      {toast && !preview && (
        <div className="toast" role="status" aria-live="polite">
          <Icon name="info" size={16} />
          {toast}
        </div>
      )}
    </div>
  )
}
