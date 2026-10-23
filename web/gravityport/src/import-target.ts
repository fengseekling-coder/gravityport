/**
 * The group a gallery drop or paste should import into.
 *
 * The guide promises that files dropped into the gallery land in the group
 * the user is browsing. Only a 我的分组 view carries one: its active key is
 * `group:<名字>`, and a group name may itself contain colons, so only the
 * `group:` prefix is stripped. Every other view (所有素材, 待整理, 收藏,
 * 回收站, Pinterest, and the 智能分组 `source:` keys) imports without a
 * group. An empty return reads as "no group" wherever it is spread into the
 * import options.
 */
export function groupNameForActive(active: string): string {
  return active.startsWith("group:") ? active.slice("group:".length) : ""
}
