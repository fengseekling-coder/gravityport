/**
 * Context menu builder — pure logic, no React or DOM dependencies.
 *
 * buildContextMenu(ctx) returns the menu entries for one scenario; App.tsx
 * renders them and dispatches actions by entry id. Labels are the Chinese
 * source strings the UI passes through tr(); the multi-selection heading keeps
 * its {count} placeholder so the UI can fill() it. Group entries carry the
 * group color in `color` for the dot the UI renders.
 */

export type MenuEntry =
  | { kind: "item"; id: string; label: string; icon?: string; danger?: boolean; disabled?: boolean; shortcut?: string; submenu?: MenuEntry[]; color?: string }
  | { kind: "separator" }
  | { kind: "heading"; label: string }

export type MenuContext = {
  target: "asset" | "stack" | "stack-blank" | "gallery-blank"
  scope: "all" | "trash"
  selectionCount: number
  selectionHasStacks: boolean
  anyGrouped: boolean
  favorite: boolean
  insideStackId: string | null
  cutActive: boolean
  groups: { name: string; color?: string }[]
  pageTotal: number
  isMac: boolean
  /** Assets currently in the trash; 清空回收站 greys out at zero. */
  trashCount: number
}

/** Drop empty sections and join the rest with one separator each, so the
 * result never opens, ends, or repeats with a separator. */
function buildSectionedMenu(sections: (MenuEntry[] | null | undefined)[]): MenuEntry[] {
  const items: MenuEntry[] = []
  for (const section of sections) {
    if (!Array.isArray(section) || section.length === 0) continue
    if (items.length) items.push({ kind: "separator" })
    items.push(...section)
  }
  return items
}

const groupSubmenu = (prefix: string, groups: MenuContext["groups"]): MenuEntry[] => {
  const entries: MenuEntry[] = [
    { kind: "item", id: `${prefix}:create`, label: "新建分组并移入" },
  ]
  if (groups.length) {
    entries.push({ kind: "separator" })
    entries.push(...groups.map(group => ({
      kind: "item" as const,
      id: `${prefix}:${group.name}`,
      label: group.name,
      color: group.color,
    })))
  }
  return entries
}

const selectAllEntry = (ctx: MenuContext): MenuEntry => ({
  kind: "item",
  id: "select-all",
  label: "全选",
  icon: "grid",
  shortcut: ctx.isMac ? "⌘A" : "Ctrl+A",
  disabled: ctx.pageTotal === 0,
})

export function buildContextMenu(ctx: MenuContext): MenuEntry[] {
  // Trash scope has its own menu: restore/permanent-delete on cards,
  // select-all/empty-trash on blank ground. Stack surfaces stay inert there.
  if (ctx.scope === "trash") {
    if (ctx.target === "stack" || ctx.target === "stack-blank") return []
    if (ctx.target === "gallery-blank") {
      return buildSectionedMenu([
        [selectAllEntry(ctx)],
        [
          { kind: "item", id: "empty-trash", label: "清空回收站", icon: "trash", danger: true, disabled: ctx.trashCount === 0 },
        ],
      ])
    }
    const isMultiple = ctx.selectionCount > 1
    const headingSection: MenuEntry[] | null = isMultiple
      ? [{ kind: "heading", label: "已选 {count} 项" }]
      : null
    return buildSectionedMenu([
      headingSection,
      [
        ...(isMultiple ? [] : [{ kind: "item" as const, id: "open-viewer", label: "在查看器中打开", icon: "external" }]),
        { kind: "item" as const, id: "copy-path", label: "复制路径", icon: "link" },
      ],
      [
        { kind: "item" as const, id: "restore-selection", label: isMultiple ? "恢复 {count} 个素材" : "恢复", icon: "inbox" },
      ],
      [
        { kind: "item" as const, id: "permanent-delete", label: isMultiple ? "永久删除 {count} 个素材" : "永久删除", icon: "trash", danger: true },
      ],
    ])
  }

  switch (ctx.target) {
    case "asset":
      return buildAssetMenu(ctx)
    case "stack":
      return buildStackMenu(ctx)
    case "stack-blank":
      return buildStackBlankMenu(ctx)
    case "gallery-blank":
      return buildGalleryBlankMenu(ctx)
    default:
      return []
  }
}

function buildAssetMenu(ctx: MenuContext): MenuEntry[] {
  const isMultiple = ctx.selectionCount > 1
  const hasStacks = ctx.selectionHasStacks

  const headingSection: MenuEntry[] | null = isMultiple
    ? [{ kind: "heading", label: "已选 {count} 项" }]
    : null

  const openSection = isMultiple ? null : [
    { kind: "item" as const, id: "open-viewer", label: "在查看器中打开", icon: "external" },
    { kind: "item" as const, id: "show-in-library", label: "在素材库中显示", icon: "folder" },
  ]

  const copySection = isMultiple
    ? [{ kind: "item" as const, id: "cut", label: "剪切", icon: "scissors", disabled: hasStacks }]
    : [
        { kind: "item" as const, id: "copy-image", label: "复制图片", icon: "image" },
        { kind: "item" as const, id: "cut", label: "剪切", icon: "scissors" },
        { kind: "item" as const, id: "copy-prompt", label: "复制提示词", icon: "copy" },
        { kind: "item" as const, id: "copy-path", label: "复制路径", icon: "link" },
      ]

  const organizeSection: MenuEntry[] = [
    { kind: "item", id: "toggle-favorite", label: ctx.favorite ? "取消收藏" : "收藏", icon: "heart" },
    { kind: "item", id: "add-to-group", label: "添加分组", icon: "plus", submenu: groupSubmenu("add-to-group", ctx.groups) },
    { kind: "item", id: "remove-from-group", label: "移除分组", icon: "folder", disabled: !ctx.anyGrouped },
  ]

  // A selection containing stack nodes exports nothing (old grammar): the
  // whole section disappears instead of greying out.
  const exportSection = hasStacks ? null : [
    { kind: "item" as const, id: "export", label: "导出至", icon: "external" },
  ]

  // Stack section only when it applies: inside a stack → move out (single and
  // multi); root gallery multi → stack the selection; a selection with stack
  // nodes supports neither.
  let stackSection: MenuEntry[] | null = null
  if (ctx.insideStackId) {
    stackSection = [{ kind: "item" as const, id: "remove-from-stack", label: "移出堆叠", icon: "layers" }]
  } else if (isMultiple && !hasStacks) {
    stackSection = [{ kind: "item" as const, id: "stack-selected", label: "堆叠所选", icon: "layers" }]
  }

  const dangerSection = [
    { kind: "item" as const, id: "move-to-trash", label: "移至回收站", icon: "trash", danger: true },
  ]

  return buildSectionedMenu([
    headingSection,
    openSection,
    copySection,
    organizeSection,
    exportSection,
    stackSection,
    dangerSection,
  ])
}

function buildStackMenu(ctx: MenuContext): MenuEntry[] {
  const pasteSection: MenuEntry[] = ctx.cutActive
    ? [{ kind: "item" as const, id: "paste-into-stack", label: "粘贴到此堆叠", icon: "copy" }]
    : []

  return buildSectionedMenu([
    pasteSection,
    [
      { kind: "item" as const, id: "open-stack", label: "打开堆叠", icon: "layers" },
    ],
    [
      { kind: "item" as const, id: "stack-add-to-group", label: "添加分组", icon: "plus", submenu: groupSubmenu("stack-add-to-group", ctx.groups) },
      { kind: "item" as const, id: "stack-remove-from-group", label: "移除分组", icon: "folder" },
    ],
    [
      { kind: "item" as const, id: "rename-stack", label: "重命名堆叠" },
      { kind: "item" as const, id: "dissolve-stack", label: "解散堆叠" },
    ],
    [
      { kind: "item" as const, id: "stack-move-to-trash", label: "移至回收站", icon: "trash", danger: true },
    ],
  ])
}

function buildStackBlankMenu(ctx: MenuContext): MenuEntry[] {
  const pasteSection: MenuEntry[] = ctx.cutActive
    ? [{ kind: "item" as const, id: "paste", label: "粘贴", icon: "copy" }]
    : []

  return buildSectionedMenu([
    [{ kind: "item" as const, id: "back-to-library", label: "返回素材库", icon: "left" }],
    pasteSection,
    [
      { kind: "item" as const, id: "rename-stack", label: "重命名堆叠" },
      { kind: "item" as const, id: "dissolve-stack", label: "解散堆叠" },
    ],
    [
      selectAllEntry(ctx),
      { kind: "item" as const, id: "refresh", label: "刷新" },
    ],
  ])
}

function buildGalleryBlankMenu(ctx: MenuContext): MenuEntry[] {
  const pasteSection: MenuEntry[] = ctx.cutActive
    ? [{ kind: "item" as const, id: "paste", label: "粘贴", icon: "copy" }]
    : []

  return buildSectionedMenu([
    [
      ...pasteSection,
      { kind: "item" as const, id: "create-group", label: "新建分组", icon: "plus" },
    ],
    [
      selectAllEntry(ctx),
      { kind: "item" as const, id: "refresh-library", label: "刷新素材库" },
    ],
  ])
}
