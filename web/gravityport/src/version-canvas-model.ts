import { conversationRoundRows } from "./conversation-rounds"
import {
  createGenerationRelation,
  dismissGenerationCandidate,
  type MosaAsset,
  type MosaGenerationCandidate,
  type MosaGenerationHistory,
} from "./mosa-api"

function readVersionCanvasEntry(): boolean {
  if (import.meta.env.DEV) return true
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem("gravityport.dev.version-canvas") === "1"
  } catch {
    return false
  }
}

// 任务 421：版本树画布入口开关；正式构建（DEV=false）默认关闭，
// 仅在开发模式或写入 localStorage "gravityport.dev.version-canvas"="1" 时开启。
export const VERSION_CANVAS_ENTRY: boolean = readVersionCanvasEntry()

// Keep in sync with LOVART_BASE_IMAGE_RESOLVER in lib/generation-history.mjs.
export const LOVART_BASE_IMAGE_RESOLVER = "lovart-base-image-v1"

export type CanvasMark = {
  x: number
  y: number
  text: string
}
export type CanvasNode = {
  id: string
  assetId: string
  name: string
  image: string
  round: number | null
  column: number
  prompt: string
  provider: string
  time: string
  /** Raw generation time (ISO), for the round headers on the board. */
  createdAt: string
  width: number
  height: number
  x: number
  y: number
  final: boolean
  note: string
  marks: CanvasMark[]
}
export type CanvasEdge = {
  id: string
  from: string
  to: string
  parentGenerationId: string
  childGenerationId: string
  type: string
  suggested: boolean
  confidence?: number
  evidence?: MosaGenerationCandidate["evidence"]
}
export type CanvasDocument = {
  title: string
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export const NODE_WIDTH = 204
export const NODE_HEIGHT = 272
export const COLUMN_GAP = 286

/** UI 审查 11-16：卡片贴着图片比例收缩，放在原来 204×272 的格子正中；
 *  格子位置、行列不变，连线和两侧的点改接到卡片实际的边上。没有尺寸的按整格。 */
export function nodeBox(node: Pick<CanvasNode, "x" | "y" | "width" | "height">) {
  const ratio = node.width > 0 && node.height > 0 ? node.width / node.height : NODE_WIDTH / NODE_HEIGHT
  const width = Math.round(Math.min(NODE_WIDTH, NODE_HEIGHT * ratio))
  const height = Math.round(Math.min(NODE_HEIGHT, width / ratio))
  return {
    x: node.x + Math.round((NODE_WIDTH - width) / 2),
    y: node.y + Math.round((NODE_HEIGHT - height) / 2),
    width,
    height,
  }
}

export function canvasFromHistory(
  history: MosaGenerationHistory | null,
  current: MosaAsset,
  formatTime?: (value?: string) => string,
): CanvasDocument {
  const assets = new Map(
    (history?.output_assets || []).map((asset) => [asset.id, asset]),
  )
  assets.set(current.id, current)
  const rounds = new Map(
    conversationRoundRows(history, current.id)
      .filter((row) => row.outputAsset)
      .map((row) => [row.outputAsset!.id, row.turnIndex]),
  )
  const events = [
    ...new Map(
      [...(history?.events || []), ...(history?.context_events || [])].map(
        (event) => [event.id, event],
      ),
    ).values(),
  ]
    .filter(
      (event) =>
        event.output_asset_id &&
        assets.has(event.output_asset_id) &&
        !assets.get(event.output_asset_id)!.deleted_at,
    )
    .sort(
      (a, b) =>
        (a.created_at || "").localeCompare(b.created_at || "") ||
        (a.id || "").localeCompare(b.id || ""),
    )
  const columns = new Map<string, number>()
  const columnRows = new Map<number, number>()
  const seenAssets = new Set<string>()
  const generationToNode = new Map<string, string>()
  const nodes: CanvasNode[] = []
  for (const event of events) {
    const asset = assets.get(event.output_asset_id!)!
    generationToNode.set(event.id, asset.id)
    if (seenAssets.has(asset.id)) continue
    seenAssets.add(asset.id)
    // Only an actual message ID groups images; timestamps never invent rounds.
    const key = event.message_id
      ? `${event.provider}:${event.conversation_id}:${event.message_id}`
      : event.id
    if (!columns.has(key)) columns.set(key, columns.size)
    const column = columns.get(key)!
    const row = columnRows.get(column) || 0
    columnRows.set(column, row + 1)
    nodes.push({
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      image:
        asset.medium_url ||
        asset.preview_url ||
        asset.thumbnail_url ||
        asset.image_url,
      round: rounds.get(asset.id) ?? null,
      column,
      prompt: event.user_prompt || event.effective_prompt || "",
      provider: event.provider || "",
      time: formatTime ? formatTime(event.created_at) : "",
      createdAt: event.created_at || "",
      width: asset.width,
      height: asset.height,
      x: 30 + column * COLUMN_GAP,
      y: 98 + row * (NODE_HEIGHT + 48),
      final: false,
      note: (asset.id === current.id ? current.note : asset.note) || "",
      marks: [],
    })
  }
  if (!nodes.length) {
    nodes.push({
      id: current.id,
      assetId: current.id,
      name: current.name,
      image:
        current.medium_url ||
        current.preview_url ||
        current.thumbnail_url ||
        current.image_url,
      round: null,
      column: 0,
      prompt: current.prompt || "",
      provider: "",
      time: "",
      createdAt: "",
      width: current.width,
      height: current.height,
      x: 30,
      y: 98,
      final: false,
      note: current.note || "",
      marks: [],
    })
  }
  const edges: CanvasEdge[] = []
  const addEdge = (edge: {
    from: string | undefined
    to: string | undefined
    parentGenerationId: string
    childGenerationId: string
    type: string
    suggested: boolean
    confidence?: number
    evidence?: MosaGenerationCandidate["evidence"]
  }) => {
    const { from, to } = edge
    if (
      !from ||
      !to ||
      from === to ||
      !seenAssets.has(from) ||
      !seenAssets.has(to)
    )
      return
    if (edges.some((item) => item.from === from && item.to === to)) return
    edges.push({
      id: `${from}:${to}`,
      from,
      to,
      parentGenerationId: edge.parentGenerationId,
      childGenerationId: edge.childGenerationId,
      type: edge.type,
      suggested: edge.suggested,
      confidence: edge.confidence,
      evidence: edge.evidence,
    })
  }
  for (const relation of [...(history?.relations || []), ...(history?.context_relations || [])]) {
    const isLovartAutoBaseImage =
      relation.verification_level === "observed" &&
      relation.evidence?.resolver === LOVART_BASE_IMAGE_RESOLVER
    if (
      !["provider_verified", "user_confirmed"].includes(
        relation.verification_level || "",
      ) &&
      !isLovartAutoBaseImage
    )
      continue
    addEdge({
      from: generationToNode.get(relation.parent_generation_id),
      to: generationToNode.get(relation.child_generation_id),
      parentGenerationId: relation.parent_generation_id,
      childGenerationId: relation.child_generation_id,
      type: relation.relation_type,
      suggested: false,
      evidence: relation.evidence,
    })
  }
  const best =
    new Map<string, MosaGenerationCandidate>()
  for (const candidate of [...(history?.relation_candidates || []), ...(history?.context_relation_candidates || [])]) {
    if (candidate.status !== "suggested") continue
    const childAssetId = generationToNode.get(candidate.child_generation_id)
    if (!childAssetId) continue
    const previous = best.get(childAssetId)
    if (!previous || (candidate.confidence || 0) > (previous.confidence || 0))
      best.set(childAssetId, candidate)
  }
  for (const candidate of best.values()) {
    addEdge({
      from: generationToNode.get(candidate.parent_generation_id),
      to: generationToNode.get(candidate.child_generation_id),
      parentGenerationId: candidate.parent_generation_id,
      childGenerationId: candidate.child_generation_id,
      type: candidate.suggested_relation_type || "edited_from",
      suggested: true,
      confidence: candidate.confidence,
      evidence: candidate.evidence,
    })
  }
  return { title: current.name, nodes, edges }
}

export async function submitCanvasCandidateAction(
  project: string,
  edge: Pick<CanvasEdge, "childGenerationId" | "parentGenerationId" | "type" | "evidence">,
  confirm: boolean,
): Promise<unknown> {
  if (confirm) {
    return createGenerationRelation(project, {
      childGenerationId: edge.childGenerationId,
      parentGenerationId: edge.parentGenerationId,
      relationType: edge.type || "derived_from",
      evidence: edge.evidence,
    })
  }
  return dismissGenerationCandidate(project, edge.childGenerationId, edge.parentGenerationId)
}

// Dragging from a card's side dot onto another card links the two. The right
// dot drags forward (the dropped card is the child), the left dot drags back
// (the dropped card is the parent). A suggested edge for the same pair is
// confirmed instead of duplicated; a pair that already has a confirmed edge in
// either direction, or a card without a generation record, is refused.
export type CanvasLinkPlan =
  | { kind: "self" }
  | { kind: "exists" }
  | { kind: "missing" }
  | { kind: "confirm"; edge: CanvasEdge }
  | { kind: "create"; parentId: string; childId: string; parentGenerationId: string; childGenerationId: string }

export const CANVAS_LINK_TYPE = "edited_from"

export function planCanvasLink(
  nodes: Pick<CanvasNode, "id" | "assetId">[],
  edges: CanvasEdge[],
  fromId: string,
  toId: string,
  side: "in" | "out",
  generationIdForAsset: (assetId: string) => string,
): CanvasLinkPlan {
  if (!toId || fromId === toId) return { kind: "self" }
  const parentId = side === "out" ? fromId : toId
  const childId = side === "out" ? toId : fromId
  const between = edges.filter(
    (edge) =>
      (edge.from === parentId && edge.to === childId) ||
      (edge.from === childId && edge.to === parentId),
  )
  if (between.some((edge) => !edge.suggested)) return { kind: "exists" }
  const suggested = between.find((edge) => edge.suggested && edge.from === parentId && edge.to === childId)
  if (suggested) return { kind: "confirm", edge: suggested }
  const parent = nodes.find((item) => item.id === parentId)
  const child = nodes.find((item) => item.id === childId)
  const parentGenerationId = parent ? generationIdForAsset(parent.assetId) : ""
  const childGenerationId = child ? generationIdForAsset(child.assetId) : ""
  if (!parentGenerationId || !childGenerationId) return { kind: "missing" }
  return { kind: "create", parentId, childId, parentGenerationId, childGenerationId }
}

export async function submitCanvasLink(
  project: string,
  plan: Extract<CanvasLinkPlan, { kind: "confirm" | "create" }>,
): Promise<unknown> {
  if (plan.kind === "confirm") return submitCanvasCandidateAction(project, plan.edge, true)
  return createGenerationRelation(project, {
    childGenerationId: plan.childGenerationId,
    parentGenerationId: plan.parentGenerationId,
    relationType: CANVAS_LINK_TYPE,
    evidence: { canvas_link: true },
  })
}

export function finalPathIds(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): Set<string> {
  const ids = new Set(nodes.filter((node) => node.final).map((node) => node.id))
  const visit = (id: string) => {
    for (const edge of edges) {
      if (edge.to === id && !edge.suggested && !ids.has(edge.from)) {
        ids.add(edge.from)
        visit(edge.from)
      }
    }
  }
  for (const id of [...ids]) visit(id)
  return ids
}

export function edgeCurve(from: CanvasNode, to: CanvasNode): string {
  const fromBox = nodeBox(from)
  const x1 = fromBox.x + fromBox.width
  const y1 = from.y + NODE_HEIGHT / 2
  const x2 = nodeBox(to).x
  const y2 = to.y + NODE_HEIGHT / 2
  // Longer branches run below intermediate cards instead of through their images.
  if (to.column - from.column > 1) {
    const bottom = Math.max(from.y, to.y) + NODE_HEIGHT + 30
    return `M ${x1} ${y1} C ${x1 + 38} ${y1}, ${x1 + 28} ${bottom}, ${x1 + 64} ${bottom} L ${x2 - 52} ${bottom} Q ${x2 - 20} ${bottom} ${x2 - 20} ${bottom - 32} L ${x2 - 20} ${y2 + 24} Q ${x2 - 20} ${y2} ${x2} ${y2}`
  }
  return `M ${x1} ${y1} C ${x1 + 42} ${y1}, ${x2 - 42} ${y2}, ${x2} ${y2}`
}
