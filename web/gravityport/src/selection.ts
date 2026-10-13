/**
 * Selection model shared by the gallery cards, the context menu and every
 * batch action. `selectedIds` is the authoritative multi-selection;
 * `selected` is the inspected (single) asset. The invariant the UI and the
 * actions both rely on: whenever `selectedIds` is non-empty, `selected` is a
 * member of it, so the highlighted cards and the batch target set can never
 * drift apart.
 */

export function logicalSelection(selectedIds: string[], selected: string): string[] {
  if (selectedIds.length) return selectedIds
  return selected ? [selected] : []
}

/** Ctrl/⌘ click: toggle the card in the multi-selection and keep the
 * inspector focused on a member of the resulting set. */
export function toggleModifierSelection(
  selectedIds: string[],
  selected: string,
  id: string,
): { selectedIds: string[]; selected: string } {
  const next = selectedIds.includes(id)
    ? selectedIds.filter(existing => existing !== id)
    : [...selectedIds, id]
  let nextSelected = selected
  if (next.includes(id)) nextSelected = id
  else if (selected === id) nextSelected = next[next.length - 1] ?? ""
  return { selectedIds: next, selected: nextSelected }
}

/** Marquee/select-all replace the multi-selection wholesale; the inspector
 * must land inside the new set (or nowhere when the set is empty). */
export function replaceSelection(selectedIds: string[], selected: string): string {
  return selectedIds.includes(selected) ? selected : selectedIds[0] ?? ""
}

/** Same-view refresh (pagination / SSE window reload): keep only the selection
 * entries still present in the freshly loaded view. Selections pointing at
 * assets that left the view are dropped instead of lurking as hidden batch
 * targets; `changed` lets the caller skip state updates when nothing moved. */
export function pruneSelection(
  selectedIds: string[],
  selected: string,
  isValid: (id: string) => boolean,
): { selectedIds: string[]; selected: string; changed: boolean } {
  const nextIds = selectedIds.filter(isValid)
  const nextSelected = isValid(selected) ? selected : ""
  return {
    selectedIds: nextIds,
    selected: nextSelected,
    changed: nextIds.length !== selectedIds.length || nextSelected !== selected,
  }
}
