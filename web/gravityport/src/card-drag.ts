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
