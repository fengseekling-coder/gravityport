/**
 * GravityPort -> MOSA service boundary.
 *
 * Only HTTP contracts and data normalization live here. It imports no styles,
 * DOM helpers, UI state machines or sample assets. The React view in the
 * supplied design project remains the sole owner of the interface. Every
 * endpoint below exists in lib/api/*.mjs; nothing here may fabricate a
 * successful result for a missing backend capability.
 */
export type MosaAsset = {
  id: string
  project_id: string
  name: string
  favorite: boolean
  width: number
  height: number
  mediaKind: "image" | "video"
  image_url: string
  thumbnail_url: string
  preview_url: string
  image_path: string
  prompt: string
  introduction: string
  tags: string[]
  palette: string[]
  group: string
  theme: string
  created_at: string
  updated_at: string
  size_bytes: number | null
  format: string
  deleted_at: string | null
  child_asset_ids: string[]
  stack: { id: string; count: number; name: string; match_count?: number } | null
  source: Record<string, unknown>
  references: MosaReference[]
}

export type MosaReference = {
  reference_id?: string
  asset_id?: string
  attachment_url?: string
  thumbnail_url?: string
  image_url?: string
  [key: string]: unknown
}

export type MosaNavigation = {
  total: number
  favorites: number
  unorganized: number
  trash: number
  sourceTypes: [string, number][]
  groups: { name: string; count: number; color: string }[]
}

export type MosaLibraryLocation = {
  path: string
  libraryDir: string
  codexGeneratedImagesDir: string
  storage: string
  supportedMediaExtensions: string[]
}

export type MosaVisualStatus = {
  available: boolean
  reason?: string
  [key: string]: unknown
}

export type AssetQuery = {
  project: string
  q: string
  sort: "newest" | "oldest" | "name"
  scope: "all" | "favorite" | "unorganized" | "trash"
  mediaKind: "all" | "img" | "video"
  source?: string
  group?: string
  stackId?: string
  cursor?: string
}

export type AssetPage = {
  assets: MosaAsset[]
  nextCursor: string | null
  total: number | null
  revision: string | null
}

type JsonValue = Record<string, unknown>

let token = ""
function takeBootstrapToken(): string {
  if (token) return token
  try {
    const params = new URLSearchParams(location.hash.slice(1))
    token = params.get("mosa-client-token")?.trim()
      || sessionStorage.getItem("mosa.client-token")?.trim()
      || ""
    if (params.has("mosa-client-token")) {
      if (token) sessionStorage.setItem("mosa.client-token", token)
      params.delete("mosa-client-token")
      history.replaceState(null, "", location.pathname + location.search
        + (params.toString() ? "#" + params.toString() : ""))
    }
  } catch { token = "" }
  return token
}

let sessionRefreshPromise: Promise<boolean> | null = null
function refreshBrowserSession(): Promise<boolean> {
  if (!sessionRefreshPromise) {
    sessionRefreshPromise = fetch("/", { credentials: "same-origin", cache: "no-store" })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => { sessionRefreshPromise = null })
  }
  return sessionRefreshPromise
}

export async function requestJson<T>(path: string, {
  method = "GET",
  body,
  signal,
}: {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: JsonValue
  signal?: AbortSignal
} = {}): Promise<T> {
  const isMutation = method !== "GET"
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers: Record<string, string> = {}
    if (body) headers["content-type"] = "application/json"
    const clientToken = takeBootstrapToken()
    if (isMutation && clientToken) headers["x-mosa-client-token"] = clientToken
    const result = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
      signal,
    })
    const raw = await result.text()
    let data: JsonValue = {}
    try { data = raw ? JSON.parse(raw) as JsonValue : {} }
    catch {
      // 200 with a non-JSON body (proxy/gateway error page) must surface as an
      // error, never as an empty success the gallery would read as "no assets".
      if (!result.ok) throw new Error(result.statusText || `HTTP ${result.status}`)
      throw new Error(`Invalid JSON response: HTTP ${result.status}`)
    }
    if (result.ok) return data as T
    if (attempt === 0 && isMutation && data.code === "MOSA_CLIENT_UNAUTHORIZED"
      && await refreshBrowserSession()) continue
    const error = new Error(String(data.error || result.statusText || `HTTP ${result.status}`))
    if (typeof data.code === "string") (error as Error & { code?: string }).code = data.code
    throw error
  }
  throw new Error("MOSA session authorization expired")
}

const e = encodeURIComponent

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Server response carries names and properties in both normalized columns and
 * persisted business_fields; do not fabricate missing metadata. */
export function normalizeAsset(input: JsonValue, project = "default"): MosaAsset {
  const fields = (input.business_fields || {}) as JsonValue
  const source = (input.source || {}) as Record<string, unknown>
  const path = String(input.image_path || input.asset || "")
  const kind = String(source.media_kind || fields.media_kind || input.media_kind || "")
  const width = positive(input.width ?? fields.width, 1)
  const height = positive(input.height ?? fields.height, 1)
  const refs = input.references
  const image_url = String(input.image_url || "")
  const stackRaw = (input.stack && typeof input.stack === "object" ? input.stack : null) as JsonValue | null
  const sizeRaw = Number(input.size_bytes ?? fields.file_bytes ?? fields.size_bytes)
  return {
    id: String(input.id || ""),
    project_id: String(input.project_id || project),
    name: String(input.name || input.title || path.split(/[\\/]/).pop() || input.id || ""),
    favorite: input.favorite === true,
    width, height,
    mediaKind: kind === "video" || (/\.(?:mp4|mov|webm|m4v)$/i.test(path) && kind !== "image") ? "video" : "image",
    image_url,
    thumbnail_url: String(input.thumbnail_url || image_url),
    preview_url: String(input.preview_url || input.medium_url || image_url),
    image_path: path,
    prompt: String(input.prompt || ""),
    introduction: String(fields.introduction || fields.description || input.description || ""),
    tags: asStringArray(input.tags),
    palette: asStringArray(input.palette),
    group: String(input.group || ""),
    theme: String(input.theme || ""),
    created_at: String(input.created_at || ""),
    updated_at: String(input.updated_at || ""),
    size_bytes: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null,
    format: path.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() || "",
    deleted_at: input.deleted_at ? String(input.deleted_at) : null,
    child_asset_ids: asStringArray(input.child_asset_ids),
    stack: stackRaw ? {
      id: String(stackRaw.id || ""),
      count: Number(stackRaw.count || 0),
      name: String(stackRaw.name || ""),
      ...(stackRaw.match_count != null ? { match_count: Number(stackRaw.match_count) || 0 } : {}),
    } : null,
    source,
    references: Array.isArray(refs) ? refs as MosaReference[] : [],
  }
}

export async function fetchNavigation(project: string, signal?: AbortSignal): Promise<MosaNavigation> {
  const data = await requestJson<{ navigation?: JsonValue }>(`/api/navigation?project=${e(project)}`, { signal })
  const navigation = data.navigation || {}
  const rawSources = Array.isArray(navigation.sourceTypes) ? navigation.sourceTypes : []
  const rawGroups = Array.isArray(navigation.groups) ? navigation.groups : []
  return {
    total: Number(navigation.total || 0),
    favorites: Number(navigation.favorites || 0),
    unorganized: Number(navigation.unorganized || 0),
    trash: Number(navigation.trash || 0),
    sourceTypes: rawSources.filter(Array.isArray).map((entry: unknown[]) => [
      String(entry[0] || ""), Number(entry[1] || 0),
    ]),
    groups: rawGroups.map((entry: unknown) => {
      if (Array.isArray(entry)) return { name: String(entry[0] || ""), count: Number(entry[1] || 0), color: "" }
      const item = entry as JsonValue
      return { name: String(item.name || ""), count: Number(item.count || 0), color: String(item.color || "") }
    }).filter(group => group.name),
  }
}

export async function fetchLibraryLocation(project: string, signal?: AbortSignal): Promise<MosaLibraryLocation> {
  const data = await requestJson<JsonValue>(`/api/library-path?project=${e(project)}`, { signal })
  return {
    path: String(data.path || ""),
    libraryDir: String(data.libraryDir || ""),
    codexGeneratedImagesDir: String(data.codexGeneratedImagesDir || ""),
    storage: String(data.storage || "json"),
    supportedMediaExtensions: asStringArray(data.supportedMediaExtensions),
  }
}

export async function fetchHealth(signal?: AbortSignal) {
  const data = await requestJson<JsonValue>("/api/health", { signal })
  return {
    productVersion: String(data.productVersion || ""),
    gitSha: String(data.gitSha || ""),
    uiFingerprint: String(data.uiFingerprint || ""),
    distribution: String(data.distribution || ""),
  }
}

export async function fetchVisualStatus(project: string, signal?: AbortSignal): Promise<MosaVisualStatus> {
  const data = await requestJson<{ visual?: JsonValue }>(`/api/visual/status?project=${e(project)}`, { signal })
  return (data.visual || {}) as MosaVisualStatus
}

function buildAssetParams(q: AssetQuery, options: { limit: number; cursor?: string; includeTotal?: boolean }) {
  const params = new URLSearchParams({
    project: q.project, q: q.q, sort: q.sort, limit: String(options.limit),
  })
  if (options.includeTotal === false) params.set("includeTotal", "0")
  if (q.scope === "favorite") params.set("favorite", "1")
  if (q.scope === "unorganized") params.set("unorganized", "1")
  if (q.scope === "trash") params.set("trash", "1")
  if (q.mediaKind !== "all") params.set("mediaKind", q.mediaKind)
  if (q.source) params.set("source", q.source)
  if (q.group) params.set("group", q.group)
  if (options.cursor) params.set("cursor", options.cursor)
  return params
}

export async function fetchAssetPage(q: AssetQuery, options: { limit?: number; cursor?: string; includeTotal?: boolean; signal?: AbortSignal } = {}): Promise<AssetPage> {
  const params = buildAssetParams(q, { limit: options.limit ?? 100, cursor: options.cursor, includeTotal: options.includeTotal })
  const path = q.stackId
    ? `/api/asset-stacks/${e(q.stackId)}/assets?${params}`
    : `/api/assets?${params}&view=gallery`
  const data = await requestJson<JsonValue>(path, { signal: options.signal })
  const page = (data.page && typeof data.page === "object" ? data.page : {}) as JsonValue
  return {
    assets: (Array.isArray(data.assets) ? data.assets : []).map(item => normalizeAsset(item as JsonValue, q.project)),
    nextCursor: page.nextCursor ? String(page.nextCursor) : null,
    total: page.total == null || !Number.isFinite(Number(page.total)) ? null : Number(page.total),
    revision: data.revision == null ? null : String(data.revision),
  }
}

export async function fetchAsset(project: string, id: string, signal?: AbortSignal) {
  const data = await requestJson<{ asset?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}`, { signal })
  return normalizeAsset(data.asset || {}, project)
}

export async function toggleAssetFavorite(project: string, id: string) {
  const result = await requestJson<{ asset?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}/favorite`, { method: "POST" })
  return normalizeAsset(result.asset || {}, project)
}

export async function updateAssetMetadata(project: string, id: string, patch: { tags?: string[]; prompt?: string }) {
  const result = await requestJson<{ asset?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}`, {
    method: "PATCH", body: patch as JsonValue,
  })
  return normalizeAsset(result.asset || {}, project)
}

type BatchResult = { id: string; ok?: boolean; error?: string }

async function batchAction(project: string, action: "favorite" | "trash" | "group", assetIds: string[], extra: JsonValue = {}): Promise<BatchResult[]> {
  const result = await requestJson<{ results?: BatchResult[]; partial?: boolean }>("/api/assets/batch", {
    method: "POST",
    body: { action, projectId: project, assetIds, ...extra },
  })
  const results = Array.isArray(result.results) ? result.results : []
  const failure = results.find(item => item.ok === false)
  if (failure) throw new Error(failure.error || "Some assets could not be updated")
  return results
}

export async function moveAssetsToTrash(project: string, ids: string[]) {
  if (!ids.length) return
  await batchAction(project, "trash", ids)
}

export async function setAssetsGroup(project: string, ids: string[], group: string) {
  if (!ids.length) return
  await batchAction(project, "group", ids, { group })
}

export async function restoreAsset(project: string, id: string) {
  const result = await requestJson<{ asset?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}/restore`, { method: "POST" })
  return normalizeAsset(result.asset || {}, project)
}

export async function createGroup(project: string, name: string) {
  return requestJson<{ group: { name: string } }>("/api/groups", {
    method: "POST", body: { projectId: project, name },
  })
}

export async function moveAssetsToStack(project: string, assetIds: string[], targetStackId: string | null) {
  return requestJson<JsonValue>("/api/asset-stacks/move", {
    method: "POST", body: { project, assetIds, targetStackId },
  })
}

/** Mutation headers for callers that must stream a raw body (import staging). */
export function mosaMutationHeaders(method = "POST"): Record<string, string> {
  const verb = String(method || "GET").toUpperCase()
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return {}
  const clientToken = takeBootstrapToken()
  return clientToken ? { "x-mosa-client-token": clientToken } : {}
}

export async function stageImportFile(file: File): Promise<string> {
  const result = await fetch("/api/import/stage", {
    method: "POST",
    headers: { "x-mosa-file-name": encodeURIComponent(file.name), ...mosaMutationHeaders("POST") },
    body: file,
    credentials: "same-origin",
  })
  const data = await result.json().catch(() => ({})) as JsonValue
  if (!result.ok) throw new Error(String(data.error || `HTTP ${result.status}`))
  return String(data.path || "")
}

export async function importAssetsBatch(project: string, items: { imagePath: string }[]) {
  const result = await requestJson<{ imported?: number; failed?: number; results?: { index: number; ok: boolean; asset?: JsonValue; error?: string }[] }>("/api/assets/import-batch", {
    method: "POST",
    body: { projectId: project, items },
  })
  // The route reports each created row as `asset`; flatten to plain ids.
  const results = (result.results || []).map(item => ({
    index: item.index,
    ok: item.ok !== false,
    ...(typeof item.asset?.id === "string" ? { id: item.asset.id } : {}),
    ...(item.error ? { error: item.error } : {}),
  }))
  return { imported: Number(result.imported || 0), failed: Number(result.failed || 0), results }
}

export async function openLibraryFolder(path: string, revealFile = false) {
  return requestJson<{ ok?: boolean }>("/api/open-folder", {
    method: "POST", body: { path, reveal: revealFile },
  })
}

// Take the transient token immediately, not only on a later mutation.
if (typeof window !== "undefined") takeBootstrapToken()
