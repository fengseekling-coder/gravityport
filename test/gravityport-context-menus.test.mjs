// GravityPort context menu builder (context-menus.ts) tests.
//
// The builder is pure logic; the real module is compiled with tsc into a temp
// directory and imported from there (gravityport-library-actions.test.mjs
// pattern) — nothing is hand-copied into this file.
import { execFileSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const repositoryRoot = resolve(import.meta.dirname, "..");
const uiRoot = join(repositoryRoot, "web", "gravityport");

let buildContextMenu;
let buildGroupMenu;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-gp-cm-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "context-menus.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  ({ buildContextMenu, buildGroupMenu } = await import(join(compileRoot, "context-menus.js")));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseCtx = (overrides = {}) => ({
  target: "asset",
  scope: "all",
  selectionCount: 1,
  selectionHasStacks: false,
  anyGrouped: false,
  favorite: false,
  insideStackId: null,
  cutActive: false,
  groups: [],
  pageTotal: 10,
  isMac: true,
  ...overrides,
});

const entryId = (entry) => {
  if (entry.kind === "separator") return "|";
  if (entry.kind === "heading") return `HEAD:${entry.label}`;
  return entry.id;
};
const idList = (entries) => entries.map(entryId);
const itemIds = (entries) => entries.filter(entry => entry.kind === "item").map(entry => entry.id);
const findItem = (entries, id) => entries.find(entry => entry.kind === "item" && entry.id === id);

function assertNoBadSeparators(entries, label) {
  const ids = idList(entries);
  assert.notEqual(ids[0], "|", `${label}: leading separator`);
  assert.notEqual(ids[ids.length - 1], "|", `${label}: trailing separator`);
  for (let index = 0; index < ids.length - 1; index += 1) {
    assert.ok(!(ids[index] === "|" && ids[index + 1] === "|"), `${label}: consecutive separators at ${index}`);
  }
}

// ---------------------------------------------------------------------------
// Asset menu
// ---------------------------------------------------------------------------

describe("context-menus / asset menu", () => {
  it("single asset: exact entry order and separator positions", () => {
    const entries = buildContextMenu(baseCtx());
    assert.deepEqual(idList(entries), [
      "open-viewer", "show-in-library",
      "|",
      "copy-image", "cut", "copy-prompt", "copy-path",
      "|",
      "toggle-favorite", "add-to-group", "remove-from-group",
      "|",
      "export",
      "|",
      "move-to-trash",
    ]);
    // 「在查看器中打开」 carries the Enter icon and 「移至回收站」 the danger
    // styling, same as the menu it replaces.
    const viewer = findItem(entries, "open-viewer");
    assert.equal(viewer.icon, "external");
    const trash = findItem(entries, "move-to-trash");
    assert.equal(trash.danger, true);
    assert.equal(findItem(entries, "toggle-favorite").label, "收藏");
  });

  it("single favorite asset: label flips to 取消收藏", () => {
    const entries = buildContextMenu(baseCtx({ favorite: true }));
    assert.equal(findItem(entries, "toggle-favorite").label, "取消收藏");
  });

  it("multi-select: heading first, no open section, cut-only copy section", () => {
    const entries = buildContextMenu(baseCtx({ selectionCount: 3 }));
    const ids = idList(entries);
    assert.equal(ids[0], "HEAD:已选 {count} 项", "heading with {count} placeholder comes first");
    assert.equal(ids[1], "|", "one separator after the heading");
    assert.ok(!ids.includes("open-viewer"), "multi-select has no viewer section");
    assert.deepEqual(itemIds(entries).filter(id => id === "cut" || id === "copy-image"), ["cut"],
      "multi-select copy section is cut only");
    assert.ok(ids.includes("HEAD:已选 {count} 项"));
  });

  it("single-select: no heading", () => {
    const entries = buildContextMenu(baseCtx({ selectionCount: 1 }));
    assert.equal(entries.filter(entry => entry.kind === "heading").length, 0);
  });

  it("inside a stack: 移出堆叠 present (single and multi), no 堆叠所选", () => {
    for (const selectionCount of [1, 3]) {
      const entries = buildContextMenu(baseCtx({ insideStackId: "stack-1", selectionCount }));
      assert.ok(itemIds(entries).includes("remove-from-stack"), `count=${selectionCount}`);
      assert.ok(!itemIds(entries).includes("stack-selected"), `count=${selectionCount}`);
    }
  });

  it("root gallery multi-select without stacks: 堆叠所选 present, no 移出堆叠", () => {
    const entries = buildContextMenu(baseCtx({ selectionCount: 2 }));
    assert.ok(itemIds(entries).includes("stack-selected"));
    assert.ok(!itemIds(entries).includes("remove-from-stack"));
  });

  it("selection containing stacks: no stack actions and no export section", () => {
    const entries = buildContextMenu(baseCtx({ selectionCount: 2, selectionHasStacks: true }));
    assert.ok(!itemIds(entries).includes("stack-selected"));
    assert.ok(!itemIds(entries).includes("remove-from-stack"));
    assert.ok(!itemIds(entries).includes("export"));
    // Stack cards cannot be cut (old grammar): the multi-select cut greys out.
    assert.equal(findItem(entries, "cut").disabled, true);
    const plain = buildContextMenu(baseCtx({ selectionCount: 2 }));
    assert.notEqual(findItem(plain, "cut").disabled, true);
  });

  it("移除分组 greys out without grouped assets and enables with one", () => {
    const disabled = findItem(buildContextMenu(baseCtx({ anyGrouped: false })), "remove-from-group");
    assert.equal(disabled.disabled, true);
    const enabled = findItem(buildContextMenu(baseCtx({ anyGrouped: true })), "remove-from-group");
    assert.notEqual(enabled.disabled, true);
  });

  it("添加分组 submenu: 新建分组并移入 first, then every group; no groups → only the create entry", () => {
    const withGroups = findItem(buildContextMenu(baseCtx({
      groups: [{ name: "Group A", color: "#ff0000" }, { name: "Group B" }],
    })), "add-to-group");
    assert.ok(withGroups.submenu, "add-to-group carries a submenu");
    const submenuIds = idList(withGroups.submenu);
    assert.deepEqual(submenuIds, ["add-to-group:create", "|", "add-to-group:Group A", "add-to-group:Group B"]);
    assert.equal(withGroups.submenu[0].label, "新建分组并移入");
    assert.equal(withGroups.submenu[2].label, "Group A");
    assert.equal(withGroups.submenu[2].color, "#ff0000", "group entries carry the color for the dot");
    assert.equal(withGroups.submenu[3].color, undefined, "uncolored groups leave the color empty (UI picks the fallback)");

    const withoutGroups = findItem(buildContextMenu(baseCtx()), "add-to-group");
    assert.deepEqual(idList(withoutGroups.submenu), ["add-to-group:create"]);
    assert.equal(withoutGroups.submenu[0].label, "新建分组并移入");
  });

  it("select-all shortcut follows the platform and greys out on an empty page", () => {
    const mac = findItem(buildContextMenu(baseCtx({ target: "gallery-blank", isMac: true })), "select-all");
    assert.equal(mac.shortcut, "⌘A");
    const windows = findItem(buildContextMenu(baseCtx({ target: "gallery-blank", isMac: false })), "select-all");
    assert.equal(windows.shortcut, "Ctrl+A");
    const empty = findItem(buildContextMenu(baseCtx({ target: "gallery-blank", pageTotal: 0 })), "select-all");
    assert.equal(empty.disabled, true);
  });
});

// ---------------------------------------------------------------------------
// Stack card menu
// ---------------------------------------------------------------------------

describe("context-menus / stack card menu", () => {
  const entries = (overrides = {}) => buildContextMenu(baseCtx({ target: "stack", ...overrides }));

  it("exact entry order: 打开堆叠, 分组, 管理, 回收站", () => {
    assert.deepEqual(idList(entries()), [
      "open-stack",
      "|",
      "stack-add-to-group", "stack-remove-from-group",
      "|",
      "rename-stack", "dissolve-stack",
      "|",
      "stack-move-to-trash",
    ]);
    assert.equal(findItem(entries(), "stack-move-to-trash").danger, true);
  });

  it("cut active: 粘贴到此堆叠 is its own first section", () => {
    const ids = idList(entries({ cutActive: true }));
    assert.equal(ids[0], "paste-into-stack");
    assert.equal(ids[1], "|");
  });

  it("no cut content: 粘贴到此堆叠 absent", () => {
    assert.ok(!itemIds(entries()).includes("paste-into-stack"));
  });

  it("stack group submenu mirrors the asset one", () => {
    const addGroup = findItem(entries({ groups: [{ name: "G1" }] }), "stack-add-to-group");
    assert.deepEqual(idList(addGroup.submenu), ["stack-add-to-group:create", "|", "stack-add-to-group:G1"]);
    assert.equal(addGroup.submenu[0].label, "新建分组并移入");
  });
});

// ---------------------------------------------------------------------------
// Blank-area menus
// ---------------------------------------------------------------------------

describe("context-menus / stack blank menu", () => {
  const entries = (overrides = {}) => buildContextMenu(baseCtx({ target: "stack-blank", insideStackId: "stack-1", ...overrides }));

  it("exact entry order: 返回素材库, 堆叠管理, 全选/刷新", () => {
    assert.deepEqual(idList(entries()), [
      "back-to-library",
      "|",
      "rename-stack", "dissolve-stack",
      "|",
      "select-all", "refresh",
    ]);
  });

  it("cut active: 粘贴 appears after 返回素材库; absent without cut content", () => {
    assert.deepEqual(idList(entries({ cutActive: true })).slice(0, 3), ["back-to-library", "|", "paste"]);
    assert.ok(!itemIds(entries()).includes("paste"));
  });

  it("全选 greys out on an empty stack", () => {
    assert.equal(findItem(entries({ pageTotal: 0 }), "select-all").disabled, true);
    assert.notEqual(findItem(entries({ pageTotal: 3 }), "select-all").disabled, true);
  });
});

describe("context-menus / gallery blank menu", () => {
  const entries = (overrides = {}) => buildContextMenu(baseCtx({ target: "gallery-blank", ...overrides }));

  it("exact entry order: 新建分组 with optional 粘贴, then 全选/刷新素材库", () => {
    assert.deepEqual(idList(entries()), [
      "create-group",
      "|",
      "select-all", "refresh-library",
    ]);
    assert.deepEqual(idList(entries({ cutActive: true })), [
      "paste", "create-group",
      "|",
      "select-all", "refresh-library",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Trash scope: the dedicated trash menu (task 142)
// ---------------------------------------------------------------------------

describe("context-menus / trash scope", () => {
  const trashCtx = (overrides = {}) => baseCtx({ scope: "trash", trashCount: 3, ...overrides });

  it("single asset: exact entry order and separator positions", () => {
    const entries = buildContextMenu(trashCtx());
    assert.deepEqual(idList(entries), [
      "open-viewer", "copy-path",
      "|",
      "restore-selection",
      "|",
      "permanent-delete",
    ]);
    assert.equal(findItem(entries, "open-viewer").icon, "external");
    const restore = findItem(entries, "restore-selection");
    assert.equal(restore.label, "恢复");
    const permanent = findItem(entries, "permanent-delete");
    assert.equal(permanent.label, "永久删除");
    assert.equal(permanent.danger, true);
  });

  it("multi-select: heading with {count}, no 在查看器中打开, counted labels", () => {
    const entries = buildContextMenu(trashCtx({ selectionCount: 2 }));
    const ids = idList(entries);
    assert.equal(ids[0], "HEAD:已选 {count} 项", "heading comes first");
    assert.equal(ids[1], "|", "one separator after the heading");
    assert.ok(!ids.includes("open-viewer"), "multi-select has no viewer entry");
    assert.equal(findItem(entries, "restore-selection").label, "恢复 {count} 个素材");
    assert.equal(findItem(entries, "permanent-delete").label, "永久删除 {count} 个素材");
  });

  it("blank area: 全选 + 清空回收站, greying out on an empty trash", () => {
    const entries = buildContextMenu(trashCtx({ target: "gallery-blank" }));
    assert.deepEqual(idList(entries), ["select-all", "|", "empty-trash"]);
    const emptyTrashItem = findItem(entries, "empty-trash");
    assert.equal(emptyTrashItem.danger, true);
    assert.notEqual(emptyTrashItem.disabled, true, "enabled while the trash holds assets");
    const empty = buildContextMenu(trashCtx({ target: "gallery-blank", trashCount: 0 }));
    assert.equal(findItem(empty, "empty-trash").disabled, true, "trashCount 0 greys out 清空回收站");
  });

  it("stack card and stack blank surfaces return no entries", () => {
    assert.deepEqual(buildContextMenu(trashCtx({ target: "stack" })), []);
    assert.deepEqual(buildContextMenu(trashCtx({ target: "stack-blank", insideStackId: "s" })), []);
  });

  it("gallery actions never appear in the trash menu", () => {
    for (const selectionCount of [1, 3]) {
      const ids = itemIds(buildContextMenu(trashCtx({ selectionCount })));
      for (const banned of ["cut", "toggle-favorite", "add-to-group", "export", "move-to-trash", "restore", "show-in-library", "copy-image", "copy-prompt"]) {
        assert.ok(!ids.includes(banned), `count=${selectionCount} leaked ${banned}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Separator hygiene across every scenario
// ---------------------------------------------------------------------------

describe("context-menus / separator hygiene", () => {
  const scenarios = [
    { label: "asset single", ctx: { target: "asset", selectionCount: 1 } },
    { label: "asset single in stack", ctx: { target: "asset", selectionCount: 1, insideStackId: "s" } },
    { label: "asset multi", ctx: { target: "asset", selectionCount: 4 } },
    { label: "asset multi with groups", ctx: { target: "asset", selectionCount: 4, cutActive: true, groups: [{ name: "G" }], anyGrouped: true } },
    { label: "asset multi with stacks", ctx: { target: "asset", selectionCount: 4, selectionHasStacks: true } },
    { label: "stack card", ctx: { target: "stack" } },
    { label: "stack card with cut", ctx: { target: "stack", cutActive: true } },
    { label: "stack blank", ctx: { target: "stack-blank", insideStackId: "s" } },
    { label: "stack blank with cut", ctx: { target: "stack-blank", insideStackId: "s", cutActive: true, pageTotal: 0 } },
    { label: "gallery blank", ctx: { target: "gallery-blank" } },
    { label: "gallery blank with cut", ctx: { target: "gallery-blank", cutActive: true } },
    { label: "trash asset", ctx: { target: "asset", scope: "trash" } },
  ];

  for (const scenario of scenarios) {
    it(`no leading/trailing/consecutive separators: ${scenario.label}`, () => {
      assertNoBadSeparators(buildContextMenu(baseCtx(scenario.ctx)), scenario.label);
    });
  }
});

describe("buildGroupMenu (sidebar 我的分组)", () => {
  const groupCtx = (overrides = {}) => ({ name: "polish", index: 1, groupCount: 3, exporting: false, ...overrides });
  const itemIds = (entries) => entries.filter((e) => e.kind === "item").map((e) => e.id);

  it("heads the menu with the group name and puts delete last as danger", () => {
    const entries = buildGroupMenu(groupCtx());
    assert.deepEqual(entries[0], { kind: "heading", label: "polish" });
    assert.deepEqual(itemIds(entries), [
      "group-rename", "group-move-up", "group-move-down", "group-color",
      "group-stats", "group-export", "group-merge", "group-delete",
    ]);
    const last = entries.at(-1);
    assert.equal(last.id, "group-delete");
    assert.equal(last.danger, true);
    assert.ok(entries.every((e, i) => e.kind !== "separator" || (entries[i - 1]?.kind === "item" && entries[i + 1]?.kind === "item")));
  });

  it("offers the six group colors as a submenu with color dots", () => {
    const color = buildGroupMenu(groupCtx()).find((e) => e.id === "group-color");
    assert.equal(color.submenu.length, 6);
    assert.ok(color.submenu.every((e) => e.id === `group-color:${e.color}` && /^#[0-9A-F]{6}$/.test(e.color)));
  });

  it("disables moves at the ends, hides merge for a lone group, disables export while exporting", () => {
    const first = buildGroupMenu(groupCtx({ index: 0 }));
    assert.equal(first.find((e) => e.id === "group-move-up").disabled, true);
    assert.equal(first.find((e) => e.id === "group-move-down").disabled, false);
    const lastGroup = buildGroupMenu(groupCtx({ index: 2 }));
    assert.equal(lastGroup.find((e) => e.id === "group-move-down").disabled, true);
    const lone = buildGroupMenu(groupCtx({ index: 0, groupCount: 1, exporting: true }));
    assert.ok(!itemIds(lone).includes("group-merge"));
    assert.equal(lone.find((e) => e.id === "group-export").disabled, true);
  });
});
