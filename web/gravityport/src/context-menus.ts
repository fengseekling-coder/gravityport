/**
 * Context menu builder — pure logic, no React or DOM dependencies.
 * Returns menu entries by scenario; the UI renders them and dispatches actions by id.
 */

export type MenuEntry =
  | { kind: "item"; id: string; label: string; icon: string; danger?: boolean; disabled?: boolean; shortcut?: string; submenu?: MenuEntry[] }
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
}

/** Build sectioned menu: drop empty sections, one separator between sections, no leading/trailing/consecutive separators. */
function buildSectionedMenu(sections: (MenuEntry[] | null)[]): MenuEntry[] {
  const items: MenuEntry[] = []
  for (const section of sections) {
    if (!Array.isArray(section) || section.length === 0) continue
    if (items.length > 0) items.push({ kind: "separator" })
    items.push(...section)
  }
  return items
}

export function buildContextMenu(ctx: MenuContext): MenuEntry[] {
  // Trash scope keeps existing behavior (next task handles trash menu)
  if (ctx.scope === "trash") {
    return ctx.target === "asset" ? buildTrashAssetMenu(ctx) : []
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

// Trash asset menu — preserve existing structure
function buildTrashAssetMenu(ctx: MenuContext): MenuEntry[] {
  const heading = ctx.selectionCount > 1 ? [{ kind: "heading" as const, label: `已选 ${ctx.selectionCount} 项` }] : []
  return [
    ...heading,
    { kind: "item", id: "restore", label: "恢复素材", icon: "refresh" },
    { kind: "item", id: "permanent-delete", label: "永久删除", icon: "trash", danger: true },
  ]
}

// Asset menu (not in trash)
function buildAssetMenu(ctx: MenuContext): MenuEntry[] {
  const isMultiple = ctx.selectionCount > 1
  const hasStacks = ctx.selectionHasStacks

  const headingSection = isMultiple ? [[{ kind: "heading" as const, label: `已选 ${ctx.selectionCount} 项` }]] : []

  const openSection = isMultiple ? null : [
    { kind: "item" as const, id: "open-viewer", label: "在查看器中打开", icon: "external", shortcut: "Enter" },
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

  const groupSubmenu: MenuEntry[] = [
    { kind: "item", id: "create-group-with-selection", label: "新建分组并移入", icon: "plus" },
  ]
  if (ctx.groups.length > 0) {
    groupSubmenu.push({ kind: "separator" })
    groupSubmenu.push(...ctx.groups.map(g => ({
      kind: "item" as const,
      id: `add-to-group:${g.name}`,
      label: g.name,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${g.color || "#6366f1"}"/></svg>`,
    })))
  }

  const organizeSection = [
    { kind: "item" as const, id: "toggle-favorite", label: ctx.favorite ? "取消收藏" : "收藏", icon: "heart" },
    { kind: "item" as const, id: "add-to-group", label: "添加分组", icon: "folder", submenu: groupSubmenu },
    { kind: "item" as const, id: "remove-from-group", label: "移除分组", icon: "minus", disabled: !ctx.anyGrouped },
  ]

  const exportSection = hasStacks ? null : [
    { kind: "item" as const, id: "export", label: "导出至", icon: "external" },
  ]

  let stackSection: MenuEntry[] | null = null
  if (ctx.insideStackId) {
    stackSection = [{ kind: "item" as const, id: "remove-from-stack", label: "移出堆叠", icon: "layers" }]
  } else if (isMultiple && !hasStacks) {
    stackSection = [{ kind: "item" as const, id: "stack-selected", label: "堆叠所选", icon: "layers" }]
  }

  const dangerSection = [
    { kind: "item" as const, id: "move-to-trash", label: "移至回收站", icon: "trash", danger: true, shortcut: "⌫" },
  ]

  return buildSectionedMenu([
    ...headingSection,
    openSection,
    copySection,
    organizeSection,
    exportSection,
    stackSection,
    dangerSection,
  ].filter((s): s is MenuEntry[] => s !== null))
}

// Stack card menu
function buildStackMenu(ctx: MenuContext): MenuEntry[] {
  const pasteSection = ctx.cutActive ? [[{ kind: "item" as const, id: "paste-into-stack", label: "粘贴到此堆叠", icon: "copy" }]] : []

  const openSection = [
    { kind: "item" as const, id: "open-stack", label: "打开堆叠", icon: "layers" },
  ]

  const groupSubmenu: MenuEntry[] = [
    { kind: "item", id: "create-group-with-stack", label: "新建分组并移入", icon: "plus" },
  ]
  if (ctx.groups.length > 0) {
    groupSubmenu.push({ kind: "separator" })
    groupSubmenu.push(...ctx.groups.map(g => ({
      kind: "item" as const,
      id: `stack-add-to-group:${g.name}`,
      label: g.name,
      icon: `<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${g.color || "#6366f1"}"/></svg>`,
    })))
  }

  const organizeSection = [
    { kind: "item" as const, id: "stack-add-to-group", label: "添加分组", icon: "folder", submenu: groupSubmenu },
    { kind: "item" as const, id: "stack-remove-from-group", label: "移除分组", icon: "minus" },
  ]

  const manageSection = [
    { kind: "item" as const, id: "rename-stack", label: "重命名堆叠", icon: "edit" },
    { kind: "item" as const, id: "dissolve-stack", label: "解散堆叠", icon: "layers" },
  ]

  const dangerSection = [
    { kind: "item" as const, id: "stack-move-to-trash", label: "移至回收站", icon: "trash", danger: true },
  ]

  return buildSectionedMenu([
    ...pasteSection,
    openSection,
    organizeSection,
    manageSection,
    dangerSection,
  ])
}

// Stack blank area menu
function buildStackBlankMenu(ctx: MenuContext): MenuEntry[] {
  const backSection = [
    { kind: "item" as const, id: "back-to-library", label: "返回素材库", icon: "left" },
  ]

  const pasteSection = ctx.cutActive ? [
    { kind: "item" as const, id: "paste", label: "粘贴", icon: "copy" },
  ] : []

  const manageSection = [
    { kind: "item" as const, id: "rename-stack", label: "重命名堆叠", icon: "edit" },
    { kind: "item" as const, id: "dissolve-stack", label: "解散堆叠", icon: "layers" },
  ]

  const utilSection = [
    { kind: "item" as const, id: "select-all", label: "全选", icon: "grid", shortcut: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘A" : "Ctrl+A", disabled: ctx.pageTotal === 0 },
    { kind: "item" as const, id: "refresh", label: "刷新", icon: "refresh" },
  ]

  return buildSectionedMenu([
    backSection,
    ...(pasteSection.length > 0 ? [pasteSection] : []),
    manageSection,
    utilSection,
  ])
}

// Gallery blank area menu
function buildGalleryBlankMenu(ctx: MenuContext): MenuEntry[] {
  const pasteSection = ctx.cutActive ? [
    { kind: "item" as const, id: "paste", label: "粘贴", icon: "copy" },
  ] : []

  const createSection = [
    { kind: "item" as const, id: "create-group", label: "新建分组", icon: "plus" },
  ]

  const utilSection = [
    { kind: "item" as const, id: "select-all", label: "全选", icon: "grid", shortcut: /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘A" : "Ctrl+A", disabled: ctx.pageTotal === 0 },
    { kind: "item" as const, id: "refresh", label: "刷新素材库", icon: "refresh" },
  ]

  return buildSectionedMenu([
    pasteSection.length > 0 ? [...pasteSection, ...createSection] : createSection,
    utilSection,
  ])
}
