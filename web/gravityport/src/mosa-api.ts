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
  medium_url: string
  thumbnail_ready: boolean
  medium_ready: boolean
  preview_ready: boolean
  image_path: string
  prompt: string
  prompt2: string
  user_instruction: string
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
  sha256?: string
  role?: string
  scope?: string[]
  applied?: boolean
  rights?: { copyright?: string; portrait_consent?: string; redistribution?: string; attribution?: string }
  allowed_uses?: string[]
  forbidden_uses?: string[]
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
      // A live library view must never read a cached navigation/history page:
      // the asset list changes under the user's feet.
      cache: "no-store",
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
  throw new Error("GravityPort session authorization expired")
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
    medium_url: String(input.medium_url || input.preview_url || image_url),
    thumbnail_ready: input.thumbnail_ready !== false,
    medium_ready: input.medium_ready !== false && Boolean(input.medium_url),
    preview_ready: input.preview_ready !== false && Boolean(input.preview_url),
    image_path: path,
    prompt: String(input.prompt || ""),
    prompt2: String(source.generation_request_prompt || fields.generation_request_prompt || ""),
    user_instruction: String(source.user_message || fields.user_message || ""),
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

/** Derivative widths depend on source aspect ratio: 400/960/1600 are LONGEST
 * edges, not widths. Correct descriptors let Retina choose a sharp rendition
 * without eagerly fetching every original at Library scale. */
export function galleryImageSrcSet(asset: MosaAsset): string {
  const longest = Math.max(asset.width, asset.height, 1)
  const ratio = asset.width / longest
  const items = [
    [asset.thumbnail_url, asset.thumbnail_ready, 400],
    [asset.medium_url, asset.medium_ready, 960],
    [asset.preview_url, asset.preview_ready, 1600],
  ] as const
  const seen = new Set<string>()
  return items.filter(([url, ready]) => url && ready && url !== asset.image_url)
    .filter(([url]) => { if (seen.has(url)) return false; seen.add(url); return true })
    .map(([url, , edge]) => `${url} ${Math.max(1, Math.min(asset.width, Math.round(edge * ratio)))}w`)
    .join(", ")
}

/** The detail endpoints (single GET, PATCH, favorite) answer with the raw asset
 * row and carry no stack-cover annotation; merging such a detail over a grid
 * row must keep the gallery page's node annotation, or the inspected stack
 * silently loses its badge in the grid. */
export function mergeAssetDetail(previous: MosaAsset | undefined, full: MosaAsset): MosaAsset {
  if (!previous?.stack || full.stack) return full
  return { ...full, stack: previous.stack }
}

export async function fetchProjects(signal?: AbortSignal): Promise<string[]> {
  const data = await requestJson<{ projects?: unknown }>(`/api/projects`, { signal })
  return asStringArray(data?.projects)
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

export type MosaWebCaptureQueueItem = {
  id: string
  provider: string
  mediaKind: "image" | "video"
  promptStatus: string
  generationStatus: string
  attempts: number
  lastError: string
}

/** GET /api/web-capture — the bridge snapshot behind the Settings → 连接
 * extension card. Field names follow lib/web-capture-ingest.ts status(). */
export type MosaWebCaptureStatus = {
  enabled: boolean
  tokenConfigured: boolean
  lastIngestAt: string | null
  lastExtensionVersion: string
  totalImported: number
  lastError: string | null
  queue: { reportedAt: string | null; pending: number; failed: number; items: MosaWebCaptureQueueItem[] }
  retryRequestId: number
}

function normalizeWebCaptureStatus(input: JsonValue): MosaWebCaptureStatus {
  const queue = (input.queue && typeof input.queue === "object" ? input.queue : {}) as JsonValue
  const items = Array.isArray(queue.items) ? queue.items : []
  const serverTime = (value: unknown): string | null =>
    typeof value === "string" && value && Number.isFinite(Date.parse(value)) ? value : null
  return {
    enabled: input.enabled === true,
    tokenConfigured: input.tokenConfigured === true,
    lastIngestAt: serverTime(input.lastIngestAt),
    lastExtensionVersion: String(input.lastExtensionVersion || ""),
    totalImported: Math.max(0, Number(input.totalImported || 0)),
    lastError: typeof input.lastError === "string" && input.lastError ? input.lastError : null,
    queue: {
      reportedAt: serverTime(queue.reportedAt),
      pending: Math.max(0, Number(queue.pending || 0)),
      failed: Math.max(0, Number(queue.failed || 0)),
      items: items.map((row: unknown) => {
        const item = (row && typeof row === "object" && !Array.isArray(row) ? row : {}) as JsonValue
        return {
          id: String(item.id || ""),
          provider: String(item.provider || ""),
          mediaKind: item.mediaKind === "video" ? "video" : "image",
          promptStatus: String(item.promptStatus || ""),
          generationStatus: String(item.generationStatus || ""),
          attempts: Math.max(0, Number(item.attempts || 0)),
          lastError: String(item.lastError || ""),
        }
      }),
    },
    retryRequestId: Math.max(0, Number(input.retryRequestId || 0)),
  }
}

export async function fetchWebCaptureStatus(signal?: AbortSignal): Promise<MosaWebCaptureStatus> {
  const data = await requestJson<{ bridge?: JsonValue }>("/api/web-capture", { signal })
  return normalizeWebCaptureStatus(data.bridge || {})
}

/** POST /api/web-capture/retry — asks the paired extension to replay its
 * queue. Returns the server's retryRequestId so callers can tell rounds apart. */
export async function requestWebCaptureRetry(): Promise<number> {
  const data = await requestJson<{ retryRequestId?: number }>("/api/web-capture/retry", { method: "POST" })
  return Math.max(0, Number(data.retryRequestId || 0))
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

export async function updateAssetMetadata(project: string, id: string, patch: { tags?: string[]; prompt?: string; references?: MosaReference[] }) {
  const result = await requestJson<{ asset?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}`, {
    method: "PATCH", body: patch as JsonValue,
  })
  return normalizeAsset(result.asset || {}, project)
}

type BatchResult = { id: string; ok?: boolean; error?: string }

/** What the server actually confirmed for a batch action. Callers must speak
 * in these counts — a partial failure is never allowed to look like success. */
export type BatchOutcome = {
  total: number
  succeeded: number
  failed: number
  /** Ids without a server confirmation; local state may only drop the rest. */
  failedIds: string[]
  firstError: string
}

const emptyOutcome = (total: number): BatchOutcome =>
  ({ total, succeeded: 0, failed: 0, failedIds: [], firstError: "" })

// One /api/assets/batch request caps at 1000 ids (the server answers 413
// ASSET_BATCH_TOO_LARGE above that) and /api/asset-stacks/move at 2000, so
// cross-page select-alls are submitted in sequential chunks.
const BATCH_CHUNK_SIZE = 1000
const STACK_MOVE_CHUNK_SIZE = 2000

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function runBatchAction(project: string, action: "favorite" | "trash" | "group", assetIds: string[], extra: JsonValue = {}): Promise<BatchOutcome> {
  const ids = [...new Set(assetIds)]
  if (!ids.length) return emptyOutcome(0)
  const failedIds = new Set<string>()
  let firstError = ""
  // Every chunk is attempted: a failed chunk never masks the others, and the
  // counts only grow by rows the server confirmed — never by assumption.
  for (let offset = 0; offset < ids.length; offset += BATCH_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + BATCH_CHUNK_SIZE)
    try {
      const result = await requestJson<{ results?: BatchResult[] }>("/api/assets/batch", {
        method: "POST",
        body: { action, projectId: project, assetIds: chunk, ...extra },
      })
      const results = Array.isArray(result.results) ? result.results : []
      const confirmed = new Set<string>()
      for (const item of results) {
        if (typeof item?.id !== "string") continue
        confirmed.add(item.id)
        if (item.ok === false) {
          failedIds.add(item.id)
          if (!firstError) firstError = item.error || "Some assets could not be updated"
        }
      }
      // Rows the response stayed silent about were not confirmed either.
      for (const id of chunk) {
        if (!confirmed.has(id) && !failedIds.has(id)) {
          failedIds.add(id)
          if (!firstError) firstError = "Some assets could not be updated"
        }
      }
    } catch (error) {
      const message = failureMessage(error)
      for (const id of chunk) failedIds.add(id)
      if (!firstError) firstError = message
    }
  }
  return {
    total: ids.length,
    succeeded: ids.length - failedIds.size,
    failed: failedIds.size,
    failedIds: [...failedIds],
    firstError,
  }
}

export async function moveAssetsToTrash(project: string, ids: string[]): Promise<BatchOutcome> {
  return runBatchAction(project, "trash", ids)
}

export async function setAssetsGroup(project: string, ids: string[], group: string): Promise<BatchOutcome> {
  return runBatchAction(project, "group", ids, { group })
}

export async function setAssetsFavorite(project: string, ids: string[], favorite: boolean): Promise<BatchOutcome> {
  return runBatchAction(project, "favorite", ids, { favorite })
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

export function renameGroup(project: string, name: string, nextName: string) {
  return requestJson<{ group: { name: string } }>(`/api/groups/${e(name)}`, {
    method: "PATCH", body: { projectId: project, name: nextName },
  })
}

export function recolorGroup(project: string, name: string, color: string) {
  return requestJson<{ group: { name: string; color: string } }>(`/api/groups/${e(name)}`, {
    method: "PATCH", body: { projectId: project, color },
  })
}

export function reorderGroups(project: string, names: string[]) {
  return requestJson<JsonValue>("/api/group-order", { method: "PATCH", body: { projectId: project, names } })
}

export function fetchGroupStats(project: string, name: string) {
  return requestJson<{ stats: JsonValue }>(`/api/groups/${e(name)}/stats?project=${e(project)}`)
}

export function deleteGroupKeepingAssets(project: string, name: string) {
  return requestJson<JsonValue>(`/api/groups/${e(name)}?project=${e(project)}`, { method: "DELETE" })
}

export function mergeGroups(project: string, source: string, target: string) {
  return requestJson<JsonValue>(`/api/groups/${e(source)}/merge`, {
    method: "POST", body: { projectId: project, into: target },
  })
}

export async function fetchRawGroupAssets(project: string, group: string, signal?: AbortSignal): Promise<JsonValue[]> {
  const seenCursors = new Set<string>()
  const seenIds = new Set<string>()
  const assets: JsonValue[] = []
  let cursor = ""
  for (;;) {
    if (signal?.aborted) throw new Error("Group export cancelled")
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("Group export pagination stalled")
      seenCursors.add(cursor)
    }
    const params = new URLSearchParams({ project, group, limit: "100" })
    if (cursor) params.set("cursor", cursor)
    const data = await requestJson<{ assets?: JsonValue[]; page?: { nextCursor?: string | null } }>(`/api/assets?${params}`, { signal })
    if (!Array.isArray(data.assets)) throw new Error("Group export returned no asset list")
    for (const item of data.assets) {
      const id = String(item?.id || "")
      if (id && seenIds.has(id)) continue
      if (id) seenIds.add(id)
      assets.push(item)
    }
    cursor = String(data.page?.nextCursor || "")
    if (!cursor) return assets
  }
}

export async function moveAssetsToStack(project: string, assetIds: string[], targetStackId: string | null): Promise<BatchOutcome> {
  const ids = [...new Set(assetIds)]
  if (!ids.length) return emptyOutcome(0)
  const failedIds = new Set<string>()
  let firstError = ""
  // Same discipline as the asset batch: sequential chunks at the server's
  // per-request cap, each attempted, nothing reported that was not confirmed.
  for (let offset = 0; offset < ids.length; offset += STACK_MOVE_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + STACK_MOVE_CHUNK_SIZE)
    try {
      await requestJson<JsonValue>("/api/asset-stacks/move", {
        method: "POST", body: { project, assetIds: chunk, targetStackId },
      })
    } catch (error) {
      const message = failureMessage(error)
      for (const id of chunk) failedIds.add(id)
      if (!firstError) firstError = message
    }
  }
  return {
    total: ids.length,
    succeeded: ids.length - failedIds.size,
    failed: failedIds.size,
    failedIds: [...failedIds],
    firstError,
  }
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

export type MosaVersionRow = MosaAsset & {
  version_index: number
  version_depth: number
  version_change?: string
}

export type MosaVersionHistory = {
  root_asset_id: string
  selected_asset_id: string
  versions: MosaVersionRow[]
}

export type MosaGenerationEvent = {
  id: string
  output_asset_id?: string
  provider?: string
  model?: string
  turn_index?: number | null
  conversation_id?: string
  turn_synced_at: string
  user_prompt?: string
  effective_prompt?: string
  created_at?: string
  [key: string]: unknown
}

export type MosaGenerationRelation = { child_generation_id: string; parent_generation_id: string; relation_type: string; verification_level?: string; evidence?: JsonValue }
export type MosaGenerationCandidate = { child_generation_id: string; parent_generation_id: string; suggested_relation_type?: string; confidence?: number; status?: string; evidence?: JsonValue }
export type MosaGenerationConversation = { provider?: string; conversation_id?: string; turn_count?: number; synced_at?: string }

export type MosaGenerationHistory = {
  events: MosaGenerationEvent[]
  context_events?: MosaGenerationEvent[]
  output_assets?: MosaAsset[]
  relations?: MosaGenerationRelation[]
  relation_candidates?: MosaGenerationCandidate[]
  conversations?: MosaGenerationConversation[]
  context_truncated?: boolean
}

export type RelationEdit = { childGenerationId: string; parentGenerationId: string; relationType: string; previousRelationType?: string; evidence?: JsonValue }
export function createGenerationRelation(project: string, edit: RelationEdit) {
  return requestJson<{ relation: MosaGenerationRelation }>("/api/generation-relations", { method: "POST", body: { projectId: project, ...edit, verificationLevel: "user_confirmed", evidence: { ...(edit.evidence || {}), source: "gravityport-inspector", user_confirmed_relation: true } } })
}
export function editGenerationRelation(project: string, edit: RelationEdit) {
  return requestJson<{ relation: MosaGenerationRelation }>("/api/generation-relations", { method: "PATCH", body: { projectId: project, ...edit, verificationLevel: "user_confirmed", evidence: { ...(edit.evidence || {}), source: "gravityport-inspector", user_confirmed_relation: true } } })
}
export function removeGenerationRelation(project: string, edit: RelationEdit) {
  return requestJson<{ relation: MosaGenerationRelation }>("/api/generation-relations", { method: "DELETE", body: { projectId: project, childGenerationId: edit.childGenerationId, parentGenerationId: edit.parentGenerationId, relationType: edit.relationType } })
}
export function dismissGenerationCandidate(project: string, childGenerationId: string, parentGenerationId: string) {
  return requestJson<{ candidate: MosaGenerationCandidate }>("/api/generation-relation-candidates", { method: "PATCH", body: { projectId: project, childGenerationId, parentGenerationId, status: "dismissed" } })
}
export type MosaRecipeHistory = { active_snapshot_id?: string; snapshots: { snapshot_id: string; references?: MosaReference[] }[] }
export async function fetchAssetRecipes(project: string, id: string, signal?: AbortSignal): Promise<MosaRecipeHistory | null> {
  try {
    const data = await requestJson<{ history?: MosaRecipeHistory }>(`/api/assets/${e(project)}/${e(id)}/recipes`, { signal })
    return data.history || null
  } catch (error) {
    if ((error as Error & { code?: string }).code === "ASSET_RECIPE_HISTORY_UNAVAILABLE") return null
    throw error
  }
}

export async function fetchAssetVersions(project: string, id: string, signal?: AbortSignal): Promise<MosaVersionHistory | null> {
  try {
    const data = await requestJson<{ history?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}/versions`, { signal })
    const history = (data.history || {}) as JsonValue
    const versions = Array.isArray(history.versions) ? history.versions as JsonValue[] : []
    return {
      root_asset_id: String(history.root_asset_id || ""),
      selected_asset_id: String(history.selected_asset_id || ""),
      versions: versions.map(row => ({
        ...normalizeAsset(row, project),
        version_index: Number((row as JsonValue).version_index ?? 0),
        version_depth: Number((row as JsonValue).version_depth ?? 0),
        version_change: (row as JsonValue).version_change ? String((row as JsonValue).version_change) : undefined,
      })),
    }
  } catch (error) {
    // Stores without the capability answer 501; a version-less library is a
    // normal state, so the caller renders no section instead of an error.
    if ((error as Error & { code?: string }).code === "ASSET_VERSION_HISTORY_UNAVAILABLE") return null
    if (String((error as Error).message).includes("501")) return null
    throw error
  }
}

export async function fetchAssetGenerationHistory(project: string, id: string, signal?: AbortSignal): Promise<MosaGenerationHistory | null> {
  try {
    const data = await requestJson<{ history?: JsonValue }>(`/api/assets/${e(project)}/${e(id)}/generation-history`, { signal })
    const history = (data.history || {}) as JsonValue
    const events = Array.isArray(history.events) ? history.events as JsonValue[] : []
    const contextEvents = Array.isArray(history.context_events) ? history.context_events as JsonValue[] : []
    const outputAssets = Array.isArray(history.output_assets) ? history.output_assets as JsonValue[] : []
    return {
      events: events.map(row => normalizeGenerationEvent(row)),
      context_events: contextEvents.map(row => normalizeGenerationEvent(row)),
      output_assets: outputAssets.map(row => normalizeAsset(row, project)),
      relations: Array.isArray(history.relations) ? history.relations as MosaGenerationHistory["relations"] : [],
      relation_candidates: Array.isArray(history.relation_candidates) ? history.relation_candidates as MosaGenerationCandidate[] : [],
      conversations: Array.isArray(history.conversations) ? history.conversations as MosaGenerationConversation[] : [],
      context_truncated: history.context_truncated === true,
    }
  } catch (error) {
    if (String((error as Error).message).includes("501")) return null
    if ((error as Error & { code?: string }).code === "GENERATION_HISTORY_UNAVAILABLE") return null
    if (String((error as Error).message).includes("404")) return null
    throw error
  }
}

function normalizeGenerationEvent(row: JsonValue): MosaGenerationEvent {
  return {
    ...row,
    id: String(row.id || ""),
    output_asset_id: row.output_asset_id ? String(row.output_asset_id) : undefined,
    provider: row.provider ? String(row.provider) : undefined,
    model: row.model ? String(row.model) : undefined,
    turn_index: row.turn_index == null ? null : Number(row.turn_index),
    conversation_id: row.conversation_id ? String(row.conversation_id) : "",
    turn_synced_at: row.turn_synced_at ? String(row.turn_synced_at) : "",
    user_prompt: row.user_prompt ? String(row.user_prompt) : undefined,
    effective_prompt: row.effective_prompt ? String(row.effective_prompt) : undefined,
    created_at: row.created_at ? String(row.created_at) : undefined,
  }
}

export async function openLibraryFolder(path: string, revealFile = false) {
  return requestJson<{ ok?: boolean }>("/api/open-folder", {
    method: "POST", body: { path, reveal: revealFile },
  })
}

// Take the transient token immediately, not only on a later mutation.
if (typeof window !== "undefined") takeBootstrapToken()
