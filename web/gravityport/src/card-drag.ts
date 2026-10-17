export function dragIdsForCard(selectedIds: Set<string>, assetId: string): string[] {
  if (selectedIds.size > 1 && selectedIds.has(assetId)) return [...selectedIds];
  return assetId ? [assetId] : [];
}

export function dragGhostCount(drag: { stackId?: string; assetIds?: string[] }): number {
  if (drag?.stackId) return 1;
  return Math.max(1, Array.isArray(drag?.assetIds) ? drag.assetIds.length : 0);
}

export function dragGestureOwner(
  event: { shiftKey?: boolean },
  opts: { startsOnCard?: boolean }
): "marquee" | "internal-asset" {
  if (!opts.startsOnCard) return "marquee";
  if (event?.shiftKey) return "marquee";
  return "internal-asset";
}

export function pointOutsideWindow(
  point: { screenX?: number; screenY?: number },
  metrics: { screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number },
  margin = 2
): boolean {
  const screenX = Number(point?.screenX);
  const screenY = Number(point?.screenY);
  const left = Number(metrics?.screenX);
  const top = Number(metrics?.screenY);
  const width = Number(metrics?.outerWidth);
  const height = Number(metrics?.outerHeight);
  if (![screenX, screenY, left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return false;
  const right = left + width;
  const bottom = top + height;
  return screenX < left - margin
    || screenX > right + margin
    || screenY < top - margin
    || screenY > bottom + margin;
}

export function nativeDragPaths(
  assets: { id: string; image_path?: string }[],
  ids: string[]
): string[] {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const path = String(assetsById.get(id)?.image_path || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Stack reorder + drop-undo planning (task 146)
// ---------------------------------------------------------------------------

/**
 * Move the block of `movingIds` (original relative order preserved) to sit
 * before/after `targetId` in `items`. A target that is itself part of the
 * moving block, or one that does not exist at all, parks the block at the end —
 * the caller compares the result against the input and skips the request when
 * nothing moved.
 */
export function moveBlockRelative(
  items: string[],
  movingIds: string[],
  targetId: string,
  placement: "before" | "after" = "before"
): string[] {
  const moving = new Set(movingIds);
  const block = items.filter((id) => moving.has(id));
  const rest = items.filter((id) => !moving.has(id));
  let targetIndex = rest.indexOf(targetId);
  if (targetIndex < 0) targetIndex = rest.length;
  else if (placement === "after") targetIndex += 1;
  rest.splice(targetIndex, 0, ...block);
  return rest;
}

/**
 * File paths of a stack's members, in stack order, for handing to the system
 * drag: duplicate paths collapse to one, members without a path are skipped.
 * Input is the pages fetched by library-actions' listStackMemberPaths.
 */
export function stackMemberPaths(members: { id?: string; imagePath?: string }[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const member of Array.isArray(members) ? members : []) {
    const path = String(member?.imagePath || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

/** One dragged card on its way out of the window: a plain card's file, or a
 *  root-gallery stack card whose members are fetched on demand. */
export type DragOutUnit = { kind: "asset"; path: string } | { kind: "stack"; stackId: string };

/**
 * File paths for a system drag of a mixed selection, in selection order with
 * each stack expanded in place (its members in stack order). Duplicate paths
 * collapse, empty ones are skipped. Stack members are fetched a few stacks at
 * a time and the walk stops as soon as more than `limit` paths are known, so a
 * select-all over a huge library never fetches every stack; `overLimit` says
 * the result was cut to the first `limit`.
 */
export async function collectDragOutPaths(
  units: DragOutUnit[],
  fetchStackPaths: (stackId: string) => Promise<string[]>,
  { limit = 512, concurrency = 4 }: { limit?: number; concurrency?: number } = {}
): Promise<{ paths: string[]; overLimit: boolean }> {
  const paths: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const path = String(value || "").trim();
    if (!path || seen.has(path)) return;
    seen.add(path);
    paths.push(path);
  };
  let index = 0;
  while (index < units.length && paths.length <= limit) {
    const chunk: DragOutUnit[] = [];
    let stacks = 0;
    while (index < units.length && (units[index].kind !== "stack" || stacks < concurrency)) {
      if (units[index].kind === "stack") stacks += 1;
      chunk.push(units[index]);
      index += 1;
    }
    const lists = await Promise.all(chunk.map((unit) => unit.kind === "stack" ? fetchStackPaths(unit.stackId) : Promise.resolve([unit.path])));
    for (const list of lists) for (const path of list) add(path);
  }
  const overLimit = paths.length > limit;
  return { paths: overLimit ? paths.slice(0, limit) : paths, overLimit };
}

/** What actually happened when a root-gallery card drop landed. */
export type StackDropRecord = {
  kind: "created-stack" | "added-to-stack";
  project: string;
  stackId: string;
  /** Only for added-to-stack: the ids this gesture really added. */
  addedIds?: string[];
  /** Only for added-to-stack: the drop-target card (stack cover) to exclude. */
  coverId?: string;
};

/** The undo a stack drop offers: dissolve the new stack, or move out exactly
 *  what was added — never the cover that was already there. */
export type StackUndoPlan =
  | { kind: "dissolve-stack"; project: string; stackId: string }
  | { kind: "remove-from-stack"; project: string; stackId: string; assetIds: string[] };

export function undoPlanForStackDrop(drop: StackDropRecord): StackUndoPlan | null {
  if (!drop || !drop.project || !drop.stackId) return null;
  if (drop.kind === "created-stack") {
    return { kind: "dissolve-stack", project: drop.project, stackId: drop.stackId };
  }
  const coverId = drop.coverId ? String(drop.coverId) : "";
  const assetIds = [...new Set((Array.isArray(drop.addedIds) ? drop.addedIds : [])
    .map((id) => String(id || ""))
    .filter((id) => id && id !== coverId && id !== drop.stackId))];
  if (!assetIds.length) return null;
  return { kind: "remove-from-stack", project: drop.project, stackId: drop.stackId, assetIds };
}

export interface NativeDragAPI {
  startNativeDrag?: (paths: string[]) => Promise<{ ok?: boolean } | unknown>;
}

export function createNativeDragController({
  api,
  onError,
}: {
  api?: NativeDragAPI | null;
  onError: () => void;
}) {
  let candidate: { assetIds: string[]; paths: string[] } | null = null;
  let nativeDragInFlight = false;

  function supported(): boolean {
    return typeof api?.startNativeDrag === "function";
  }

  function clearCandidate(): void {
    candidate = null;
  }

  function begin(assetIds: string[], paths: string[]): boolean {
    if (!supported()) return false;
    if (!paths.length) return false;
    clearCandidate();
    candidate = { assetIds: [...assetIds], paths: [...paths] };
    return true;
  }

  function startIfOutside(
    point: { screenX?: number; screenY?: number },
    metrics: { screenX?: number; screenY?: number; outerWidth?: number; outerHeight?: number }
  ): boolean {
    if (!candidate || nativeDragInFlight || !supported()) return false;
    if (!pointOutsideWindow(point, metrics)) return false;
    const paths = [...candidate.paths];
    clearCandidate();
    if (!paths.length) {
      onError();
      return false;
    }
    nativeDragInFlight = true;
    Promise.resolve(api!.startNativeDrag!(paths))
      .then((result) => {
        if (result && typeof result === "object" && "ok" in result && result.ok === false) {
          onError();
        }
      })
      .catch(() => onError())
      .finally(() => { nativeDragInFlight = false; });
    return true;
  }

  return { begin, startIfOutside, clearCandidate, supported };
}
