export function resolveNavHistoryShortcut(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; targetIsEditable?: boolean },
  platform: "mac" | "other"
): -1 | 0 | 1 {
  if (event.targetIsEditable) return 0;
  if (platform === "mac") {
    if ((event.metaKey || event.ctrlKey) && event.key === "[") return -1;
    if ((event.metaKey || event.ctrlKey) && event.key === "]") return 1;
    return 0;
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.key === "ArrowLeft") return -1;
    if (event.key === "ArrowRight") return 1;
  }
  return 0;
}

export function isFocusSearchKey(
  event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean },
  ctx: { viewIsLibrary: boolean; hasBlockingOverlay: boolean; targetIsTextEntry: boolean; platform: "mac" | "other" }
): boolean {
  if (ctx.hasBlockingOverlay) return false;
  if (!ctx.viewIsLibrary) return false;

  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return !ctx.targetIsTextEntry;
  }

  // ⌘F (macOS) or Ctrl+F (other platforms) works from inside a text field too,
  // matching the desktop menu's Find. Ctrl+F on macOS stays the caret shortcut.
  if ((event.key === "f" || event.key === "F") && !event.altKey && !event.shiftKey) {
    return ctx.platform === "mac"
      ? Boolean(event.metaKey) && !event.ctrlKey
      : Boolean(event.ctrlKey) && !event.metaKey;
  }

  return false;
}

const COLUMN_TOLERANCE_PX = 4;

export function neighbourAssetId(
  cards: { id: string; left: number; top: number; bottom: number; centerX: number; centerY: number }[],
  currentId: string,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
): string | null {
  const current = cards.find((entry) => entry.id === currentId);
  if (!current) return null;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const wanted = key === "ArrowRight" ? 1 : -1;
    const inDirection = cards.filter((entry) => entry.id !== current.id
      && Math.sign(entry.centerX - current.centerX) === wanted);
    // "Beside" in a staggered layout means the boxes overlap vertically. When
    // nothing overlaps, fall back to the nearest card in that direction.
    const overlapping = inDirection.filter((entry) => entry.top < current.bottom && entry.bottom > current.top);
    const pool = overlapping.length ? overlapping : inDirection;
    if (!pool.length) return null;
    return pool.reduce((best, entry) => {
      const score = Math.abs(entry.centerX - current.centerX) + Math.abs(entry.centerY - current.centerY) * 2;
      return score < best.score ? { id: entry.id, score } : best;
    }, { id: null as string | null, score: Infinity }).id;
  }

  const wanted = key === "ArrowDown" ? 1 : -1;
  const sameColumn = cards.filter((entry) => entry.id !== current.id
    && Math.abs(entry.left - current.left) <= COLUMN_TOLERANCE_PX
    && Math.sign(entry.centerY - current.centerY) === wanted);
  if (!sameColumn.length) return null;
  return sameColumn.reduce((best, entry) => {
    const distance = Math.abs(entry.centerY - current.centerY);
    return distance < best.distance ? { id: entry.id, distance } : best;
  }, { id: null as string | null, distance: Infinity }).id;
}

export function galleryKeyAction(
  event: { key: string },
  ctx: {
    viewIsLibrary: boolean;
    hasSelection: boolean;
    targetIsTextEntry: boolean;
    insideStack?: boolean;
    currentAsset?: { stackId?: string } | null;
  }
): "open" | "enter-stack" | "none" {
  if (event.key !== "Enter") return "none";
  if (!ctx.viewIsLibrary) return "none";
  if (ctx.hasSelection) return "none";
  if (ctx.targetIsTextEntry) return "none";
  if (!ctx.currentAsset) return "none";
  
  // Inside a stack its cover still carries the stack summary; Enter opens it.
  if (ctx.currentAsset.stackId && !ctx.insideStack) return "enter-stack";
  return "open";
}
