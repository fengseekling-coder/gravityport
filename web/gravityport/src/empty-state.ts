// Gallery empty state derivation (pure logic, no React/DOM).

export type EmptyStateKind =
  | "no-results"
  | "trash-empty"
  | "favorites-empty"
  | "unorganized-empty"
  | "group-empty"
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
      title: "没有找到匹配的素材",
      description: "试试别的搜索词，或清除筛选条件",
      clearAction: true,
    };
  }

  // 3. Trash
  if (active === "回收站") {
    return {
      kind: "trash-empty",
      title: "回收站是空的",
      description: "移到回收站的素材会在这里保留 90 天",
      clearAction: false,
    };
  }

  // 4. Favorites
  if (active === "收藏") {
    return {
      kind: "favorites-empty",
      title: "还没有收藏",
      description: "点素材上的星标，把常用的图收在这里",
      clearAction: false,
    };
  }

  // 5. Unorganized
  if (active === "待整理") {
    return {
      kind: "unorganized-empty",
      title: "都整理好了",
      description: "还没有分组的素材会出现在这里",
      clearAction: false,
    };
  }

  // 6. Inside a group
  if (active.startsWith("group:")) {
    return {
      kind: "group-empty",
      title: "这个分组还没有素材",
      description: "把图片拖到左侧的分组名上，或在素材上右键「添加分组」",
      clearAction: false,
    };
  }

  // 7. Library is empty (all assets view, not inside a stack, total is 0)
  if (active === "所有素材" && !insideStack && isZeroLibraryTotal(libraryTotal)) {
    return {
      kind: "library-empty",
      title: "素材库还是空的",
      description: "把图片或文件夹拖进窗口，或直接粘贴剪贴板图片即可导入",
      clearAction: false,
    };
  }

  // 8. Fallback: no-results
  return {
    kind: "no-results",
    title: "没有找到匹配的素材",
    description: "试试别的搜索词，或清除筛选条件",
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
