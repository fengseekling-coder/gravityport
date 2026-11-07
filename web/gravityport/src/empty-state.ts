// Gallery empty state derivation (pure logic, no React/DOM).

export type EmptyStateKind =
  | "no-results"
  | "trash-empty"
  | "favorites-empty"
  | "unorganized-empty"
  | "group-empty"
  | "stack-empty"
  | "library-empty";

export interface EmptyStateContext {
  loading: boolean;
  error: unknown;
  visibleCount: number;
  active: string;
  query: string;
  assetType: string;
  libraryTotal: unknown;
  insideStack: boolean;
}

export interface EmptyStateResult {
  kind: EmptyStateKind;
  title: string;
  description: string;
  clearAction: boolean;
}

/**
 * Derives which empty state to show based on the current gallery context.
 * Fixed priority: loading/error/results > refinements > fixed views > group > library > fallback.
 */
export function deriveEmptyState(ctx: EmptyStateContext): EmptyStateResult | null {
  const { loading, error, visibleCount, active, query, assetType, libraryTotal, insideStack } = ctx;

  // 1. Show nothing while loading or on fatal error, or when there are visible results
  if (loading || error || visibleCount > 0) return null;

  // 2. Has refinements (search query or asset type filter)
  const hasRefinements = query.trim() !== "" || assetType !== "all";
  if (hasRefinements) {
    return {
      kind: "no-results",
      title: "没有匹配的素材",
      description: "尝试其他搜索词，或清除筛选条件。",
      clearAction: true,
    };
  }

  // 3. Inside a stack with no refinements: the stack itself is empty. The
  // incremental sync normally auto-exits a dead stack (review 中10); this is
  // the fallback for the moment before that lands.
  if (insideStack) {
    return {
      kind: "stack-empty",
      title: "堆叠中没有素材",
      description: "其中的素材已移到回收站或移出堆叠。",
      clearAction: false,
    };
  }

  // 4. Trash
  if (active === "回收站") {
    return {
      kind: "trash-empty",
      title: "回收站中没有素材",
      description: "移到回收站的素材保留 90 天。",
      clearAction: false,
    };
  }

  // 5. Favorites
  if (active === "收藏") {
    return {
      kind: "favorites-empty",
      title: "没有收藏的素材",
      description: "点击素材详情中的心形图标，或右键点击素材并选择「收藏」。",
      clearAction: false,
    };
  }

  // 6. Unorganized
  if (active === "待整理") {
    return {
      kind: "unorganized-empty",
      title: "没有待整理的素材",
      description: "新增的素材先显示在这里。收藏、移到分组、添加标签或标为已整理后，素材将移出待整理。",
      clearAction: false,
    };
  }

  // 7. Inside a group
  if (active.startsWith("group:")) {
    return {
      kind: "group-empty",
      title: "分组中没有素材",
      description: "将素材拖到侧栏中的分组名称上，或右键点击素材并选择「移到分组」。",
      clearAction: false,
    };
  }

  // 8. Library is empty (all assets view, not inside a stack, total is 0)
  if (active === "所有素材" && !insideStack && isZeroLibraryTotal(libraryTotal)) {
    return {
      kind: "library-empty",
      title: "素材库中没有素材",
      description: "将图片、视频或文件夹拖到窗口中，或粘贴剪贴板中的图片或视频，即可导入。",
      clearAction: false,
    };
  }

  // 9. Fallback: no refinements and no results (EMPTY-10: an empty smart
  // group, say) — there is nothing to clear, so tell the user how it fills.
  return {
    kind: "no-results",
    title: "没有素材",
    description: "新收录或导入的素材将显示在这里。",
    clearAction: false,
  };
}

/**
 * Determines if the library total indicates an empty library.
 * Non-finite values (undefined, NaN) should NOT be treated as empty.
 */
function isZeroLibraryTotal(total: unknown): boolean {
  const n = Number(total);
  return isFinite(n) && n === 0;
}
