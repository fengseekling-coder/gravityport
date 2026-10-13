/**
 * Prompt editor draft binding. A draft always belongs to one concrete
 * (project, asset) pair; switching assets or projects invalidates it instead
 * of letting it flow into whatever asset happens to be inspected next.
 */

export type PromptEditTarget = { project: string; assetId: string }

export function promptEditorActive(
  edit: PromptEditTarget | null,
  project: string,
  assetId: string | undefined,
): boolean {
  return !!edit && edit.project === project && !!assetId && edit.assetId === assetId
}

/** Resolve the one asset a pending draft may be written to. Returns null when
 * the bound asset is no longer on screen (different project or another asset
 * is selected), so a save can never hit the wrong row. */
export function resolvePromptSaveTarget<P extends { id: string; project_id: string }>(
  edit: PromptEditTarget | null,
  assets: P[],
): P | null {
  if (!edit) return null
  return assets.find(asset => asset.id === edit.assetId && asset.project_id === edit.project) ?? null
}
