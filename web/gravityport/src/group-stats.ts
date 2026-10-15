// Group statistics description (pure logic, no React/DOM).

export interface GroupStatsEntry {
  name: string;
  count: number;
}

export interface GroupStatsFacet {
  title: string;
  entries: GroupStatsEntry[];
  emptyText: string;
}

export interface GroupStatsOverview {
  label: string;
  value: number;
}

export interface GroupStatsDescription {
  overview: GroupStatsOverview[];
  facets: GroupStatsFacet[];
}

interface RawGroupStats {
  total?: unknown;
  favorites?: unknown;
  images?: unknown;
  videos?: unknown;
  versionChildren?: unknown;
  trashed?: unknown;
  categories?: unknown;
  sources?: unknown;
}

/** Returns user-facing description of group statistics for display. */
export function describeGroupStats(stats: unknown): GroupStatsDescription {
  const raw: RawGroupStats = typeof stats === "object" && stats !== null ? stats : {};

  const overview = buildOverview(raw);
  const facets = buildFacets(raw);

  return { overview, facets };
}

function toFinite(value: unknown): number {
  const n = Number(value);
  return isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function buildOverview(raw: RawGroupStats): GroupStatsOverview[] {
  return [
    { label: "素材总数", value: toFinite(raw.total) },
    { label: "收藏", value: toFinite(raw.favorites) },
    { label: "图片", value: toFinite(raw.images) },
    { label: "视频", value: toFinite(raw.videos) },
    { label: "版本条目", value: toFinite(raw.versionChildren) },
    { label: "回收站中", value: toFinite(raw.trashed) },
  ];
}

function buildFacets(raw: RawGroupStats): GroupStatsFacet[] {
  const categories = parseFacet(raw.categories);
  const sources = parseFacet(raw.sources);

  return [
    { title: "按分类", entries: categories, emptyText: "未记录" },
    { title: "按来源", entries: sources, emptyText: "未记录" },
  ];
}

function parseFacet(raw: unknown): GroupStatsEntry[] {
  if (!Array.isArray(raw)) return [];

  const entries: GroupStatsEntry[] = [];

  for (const item of raw) {
    // Only [string, number] pairs are facet entries; anything else is noise.
    if (!Array.isArray(item) || item.length < 2) continue;
    if (typeof item[0] !== "string" || typeof item[1] !== "number" || !Number.isFinite(item[1])) continue;
    const name = item[0].trim();
    if (name === "") continue;
    entries.push({ name, count: toFinite(item[1]) });
  }

  // Sort: count descending, then name ascending
  entries.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.name.localeCompare(b.name);
  });

  return entries;
}
