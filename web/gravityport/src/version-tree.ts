import type { MosaAsset, MosaGenerationEvent, MosaGenerationHistory } from "./mosa-api"
// The explicit .js suffix keeps this import resolvable in Node ESM: the unit
// test compiles this module with tsc and imports the emitted file directly.
import { conversationRoundRows } from "./conversation-rounds.js"

export type GenerationTreeRow = {
  event: MosaGenerationEvent
  depth: number
  parentIds: string[]
  relationTypes: string[]
}

/** Rebuild the confirmed generation DAG without mistaking same-conversation
 * candidates for proven parent-child relationships. Cycles are bounded by a
 * visited set, and multi-parent events are displayed once. */
export function generationTreeRows(history: MosaGenerationHistory | null): GenerationTreeRow[] {
  if (!history?.events?.length) return []
  const events = history.events
  const byId = new Map(events.map(event => [event.id, event]))
  const parentIds = new Map<string, string[]>()
  const types = new Map<string, string[]>()
  for (const event of events) {
    parentIds.set(event.id, Array.isArray(event.parent_generation_ids)
      ? (event.parent_generation_ids as unknown[]).filter((id): id is string => typeof id === "string") : [])
    types.set(event.id, [])
  }
  for (const relation of history.relations || []) {
    const parents = parentIds.get(relation.child_generation_id)
    if (!parents) continue
    if (!parents.includes(relation.parent_generation_id)) parents.push(relation.parent_generation_id)
    types.get(relation.child_generation_id)?.push(relation.relation_type || "derived_from")
  }
  const children = new Map<string, string[]>()
  for (const event of events) {
    for (const parent of parentIds.get(event.id) || []) {
      if (!byId.has(parent)) continue
      const siblings = children.get(parent) || []
      siblings.push(event.id)
      children.set(parent, siblings)
    }
  }
  const ordered: GenerationTreeRow[] = []
  const visited = new Set<string>()
  const visit = (event: MosaGenerationEvent, depth: number) => {
    if (visited.has(event.id)) return
    visited.add(event.id)
    ordered.push({ event, depth: Math.min(depth, 8), parentIds: parentIds.get(event.id) || [], relationTypes: types.get(event.id) || [] })
    for (const childId of children.get(event.id) || []) {
      const child = byId.get(childId)
      if (child) visit(child, depth + 1)
    }
  }
  for (const event of events) {
    if (!(parentIds.get(event.id) || []).some(id => byId.has(id))) visit(event, 0)
  }
  for (const event of events) visit(event, 0)
  return ordered
}

// 任务 148：查看展开区全部改成缩略图行。下面两个函数把「生成编号」解析成
// 能直接渲染的素材行——界面上任何地方都不再出现 gen- 开头的内部编号。
//
// 轮次一律用 144 校验过的 conversationRoundRows 结果（按素材 id 对上）：对不上、
// 不是对话来的就为 null（宁可不显示，也不显示可能错的数字；绝不直接用
// event.turn_index）。

export type GenerationDisplay = {
  known: boolean
  asset: MosaAsset | null
  prompt: string
  turnIndex: number | null
  isCurrent: boolean
}

export function generationDisplay(
  history: MosaGenerationHistory | null | undefined,
  generationId: string,
  currentAsset: Pick<MosaAsset, "id"> | null | undefined,
): GenerationDisplay {
  const unknown: GenerationDisplay = { known: false, asset: null, prompt: "", turnIndex: null, isCurrent: false }
  const event = eventsById(history).get(String(generationId || ""))
  if (!event) return unknown
  const prompt = promptOf(event)
  const asset = outputAssetOf(history, event, currentAsset)
  if (!asset) return { ...unknown, prompt }
  const currentId = String(currentAsset?.id || "")
  return {
    known: true,
    asset,
    prompt,
    turnIndex: validatedTurnIndexes(history, currentId).get(String(asset.id)) ?? null,
    isCurrent: currentId !== "" && String(asset.id) === currentId,
  }
}

export type RelatedChoice = {
  asset: MosaAsset
  prompt: string
  turnIndex: number | null
}

// 「添加生成关系」可选的图：events + context_events 去掉 anchor、去重（同一条
// 记录与同一张素材都只出一行）、去掉没有对应素材的、去掉在回收站的、去掉当前
// 素材自己的记录；按轮次升序，没轮次的排最后、按时间。
//
// 返回值刻意不带生成编号——调用方（App）自己从 history 里把素材 id 解析回
// 生成号，保证这个函数返回的任何字符串都不可能把 gen- 编号带进界面。
export function relatedChoices(
  history: MosaGenerationHistory | null | undefined,
  anchorGenerationId: string,
  currentAsset: Pick<MosaAsset, "id"> | null | undefined,
): RelatedChoice[] {
  const anchorId = String(anchorGenerationId || "")
  const currentId = String(currentAsset?.id || "")
  const turns = validatedTurnIndexes(history, currentId)
  const seenEvents = new Set<string>()
  const seenAssets = new Set<string>()
  const choices: (RelatedChoice & { createdAt: string })[] = []
  for (const event of historyEvents(history)) {
    const id = String(event.id || "")
    if (!id || id === anchorId || seenEvents.has(id)) continue
    seenEvents.add(id)
    const asset = outputAssetOf(history, event, currentAsset)
    if (!asset) continue
    const assetKey = String(asset.id)
    if (assetKey === currentId || String(asset.deleted_at || "") !== "" || seenAssets.has(assetKey)) continue
    seenAssets.add(assetKey)
    choices.push({
      asset,
      prompt: promptOf(event),
      turnIndex: turns.get(assetKey) ?? null,
      createdAt: String(event.created_at || ""),
    })
  }
  return choices.sort((left, right) => {
    if (left.turnIndex !== null && right.turnIndex !== null) return left.turnIndex - right.turnIndex
    if (left.turnIndex !== null) return -1
    if (right.turnIndex !== null) return 1
    return left.createdAt.localeCompare(right.createdAt) || String(left.asset.id).localeCompare(String(right.asset.id))
  }).map(({ asset, prompt, turnIndex }) => ({ asset, prompt, turnIndex }))
}

function eventsById(history: MosaGenerationHistory | null | undefined): Map<string, MosaGenerationEvent> {
  const byId = new Map<string, MosaGenerationEvent>()
  for (const event of historyEvents(history)) {
    const id = String(event.id || "")
    if (id && !byId.has(id)) byId.set(id, event)
  }
  return byId
}

function historyEvents(history: MosaGenerationHistory | null | undefined): MosaGenerationEvent[] {
  return [
    ...(Array.isArray(history?.events) ? history.events : []),
    ...(Array.isArray(history?.context_events) ? history.context_events : []),
  ].filter((event) => event && String(event.id || "").trim())
}

// 当前素材自己的产物条目不在 output_assets 里时用传入的素材补（144 的写法）。
function outputAssetOf(
  history: MosaGenerationHistory | null | undefined,
  event: MosaGenerationEvent,
  currentAsset: Pick<MosaAsset, "id"> | null | undefined,
): MosaAsset | null {
  const assetId = String(event.output_asset_id || "")
  if (!assetId) return null
  if (currentAsset && String(currentAsset.id) === assetId) return currentAsset as MosaAsset
  return (Array.isArray(history?.output_assets) ? history.output_assets : [])
    .find((asset) => asset && String(asset.id || "") === assetId) || null
}

function validatedTurnIndexes(
  history: MosaGenerationHistory | null | undefined,
  currentAssetId: string,
): Map<string, number | null> {
  return new Map(conversationRoundRows(history, currentAssetId)
    .filter((row) => row.outputAsset)
    .map((row) => [String(row.outputAsset!.id), row.turnIndex]))
}

function promptOf(event: MosaGenerationEvent): string {
  return String(event.effective_prompt || event.user_prompt || "")
}
