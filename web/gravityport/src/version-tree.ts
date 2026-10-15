import type { MosaGenerationEvent, MosaGenerationHistory } from "./mosa-api"

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
