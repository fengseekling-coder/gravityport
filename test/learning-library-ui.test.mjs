// Learning-library UI pure functions (task 459): menu content with the entry
// switch on/off, the learn:<id> view-key parser and the sidebar drop-target
// resolver. The real TypeScript modules (context-menus.ts,
// learning-library-entry.ts) are compiled with tsc and imported — nothing is
// hand-copied.
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
let buildLearningLibraryMenu;
let learningLibraryIdForActive;
let learningLibraryIdFromDropRow;

before(async () => {
  const compileRoot = await mkdtemp(join(tmpdir(), "mosa-learning-ui-"));
  execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
    join(uiRoot, "src", "vite-env.d.ts"),
    join(uiRoot, "src", "context-menus.ts"),
    join(uiRoot, "src", "learning-library-entry.ts"),
    "--outDir", compileRoot,
    "--module", "esnext",
    "--target", "es2022",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
  ], { stdio: "pipe" });
  // learning-library-entry.ts reads import.meta.env.DEV at module load; rewrite
  // it to a constant so plain node can import the compiled file (the
  // version-canvas.test.mjs pattern).
  const entryJs = join(compileRoot, "learning-library-entry.js");
  const { readFile: readCompiled, writeFile: writeCompiled } = await import("node:fs/promises");
  const source = await readCompiled(entryJs, "utf8");
  const rewritten = source.replaceAll("import.meta.env.DEV", "false");
  if (rewritten !== source) await writeCompiled(entryJs, rewritten);
  ({ buildContextMenu, buildGroupMenu, buildLearningLibraryMenu } = await import(join(compileRoot, "context-menus.js")));
  ({ learningLibraryIdForActive, learningLibraryIdFromDropRow } = await import(join(compileRoot, "learning-library-entry.js")));
  after(async () => {
    await rm(compileRoot, { recursive: true, force: true });
  });
});

const LIBRARIES = [
  { id: "ll_aaa", name: "海报风格" },
  { id: "ll_bbb", name: "冷色人像" },
];

const baseCtx = (overrides = {}) => ({
  target: "asset",
  scope: "all",
  selectionCount: 1,
  selectionHasStacks: false,
  anyGrouped: false,
  favorite: false,
  insideStackId: null,
  cutActive: false,
  groups: [{ name: "海报" }],
  pageTotal: 10,
  isMac: true,
  trashCount: 0,
  canCopyFiles: true,
  ...overrides,
});

const flatIds = (entries) => entries.flatMap((entry) => {
  if (entry.kind === "separator") return [];
  if (entry.submenu) return [entry.id, ...entry.submenu.map((item) => item.kind === "separator" ? "|" : item.id)];
  return [entry.id];
});

describe("asset menu", () => {
  it("offers 加入学习库 with a libraries-first submenu and 新建学习库… last (entry on)", () => {
    const menu = buildContextMenu(baseCtx({ learningLibraries: LIBRARIES }));
    const entry = menu.find((item) => item.id === "add-to-learning-library");
    assert.ok(entry, "加入学习库 entry present");
    assert.ok(entry.submenu, "the entry carries a submenu");
    assert.deepEqual(entry.submenu.map((item) => item.kind === "separator" ? "|" : item.id), [
      "add-to-learning-library:ll_aaa",
      "add-to-learning-library:ll_bbb",
      '|',
      "add-to-learning-library:create",
    ], "libraries first, then 新建学习库…");
    assert.equal(entry.submenu.at(-1).label, "新建学习库…");
  });

  it("falls back to a create-only submenu when no library exists yet", () => {
    const menu = buildContextMenu(baseCtx({ learningLibraries: [] }));
    const entry = menu.find((item) => item.id === "add-to-learning-library");
    assert.deepEqual(entry.submenu.map((item) => item.kind === "separator" ? "|" : item.id), ["add-to-learning-library:create"]);
  });

  it("keeps 移出学习库 before 加入学习库 inside a learning-library view only", () => {
    const inView = buildContextMenu(baseCtx({ learningLibraries: LIBRARIES, learningLibraryView: true }));
    const ids = flatIds(inView);
    assert.ok(ids.includes("remove-from-learning-library"), "移出学习库 present in the learn view");
    assert.ok(ids.indexOf("remove-from-learning-library") < ids.indexOf("add-to-learning-library"),
      "移出学习库 sits before 加入学习库");
    const outside = buildContextMenu(baseCtx({ learningLibraries: LIBRARIES }));
    assert.equal(flatIds(outside).includes("remove-from-learning-library"), false,
      "移出学习库 must not appear outside a learn view");
  });

  it("offers none of the learning-library entries with the entry off (field absent)", () => {
    for (const target of ["asset"]) {
      const menu = buildContextMenu(baseCtx({ target }));
      const ids = flatIds(menu);
      for (const id of ["add-to-learning-library", "remove-from-learning-library", "add-to-learning-library:create"]) {
        assert.equal(ids.includes(id), false, `${id} hidden while the entry is off (${target})`);
      }
    }
  });
});

describe("stack menu", () => {
  it("offers 加入学习库 with the stack prefix (entry on)", () => {
    const menu = buildContextMenu(baseCtx({ target: "stack", learningLibraries: LIBRARIES }));
    const entry = menu.find((item) => item.id === "stack-add-to-learning-library");
    assert.ok(entry, "加入学习库 present on stack menus");
    assert.deepEqual(entry.submenu.map((item) => item.kind === "separator" ? "|" : item.id), [
      "stack-add-to-learning-library:ll_aaa",
      "stack-add-to-learning-library:ll_bbb",
      '|',
      "stack-add-to-learning-library:create",
    ]);
  });

  it("offers no stack learning-library entry with the entry off", () => {
    const menu = buildContextMenu(baseCtx({ target: "stack" }));
    assert.equal(flatIds(menu).includes("stack-add-to-learning-library"), false);
  });
});

describe("group menu", () => {
  it("offers 全部加入学习库 next to 分组统计 (entry on)", () => {
    const menu = buildGroupMenu({ index: 0, groupCount: 1, exporting: false, learningLibraries: LIBRARIES });
    const entry = menu.find((item) => item.id === "group-add-to-learning-library");
    assert.ok(entry, "全部加入学习库 present");
    assert.deepEqual(entry.submenu.map((item) => item.kind === "separator" ? "|" : item.id), [
      "group-add-to-learning-library:ll_aaa",
      "group-add-to-learning-library:ll_bbb",
      '|',
      "group-add-to-learning-library:create",
    ]);
  });

  it("offers no 全部加入学习库 with the entry off", () => {
    const menu = buildGroupMenu({ index: 0, groupCount: 1, exporting: false });
    assert.equal(flatIds(menu).includes("group-add-to-learning-library"), false);
  });
});

describe("learning-library row menu", () => {
  it("has exactly 重命名学习库… then the dangerous 删除学习库 last", () => {
    const menu = buildLearningLibraryMenu();
    const items = menu.filter((entry) => entry.kind === "item");
    assert.deepEqual(items.map((item) => item.id), ["learning-library-rename", "learning-library-delete"]);
    const last = items.at(-1);
    assert.equal(last.danger, true, "删除学习库 is the dangerous last row");
    assert.equal(last.icon, "trash");
  });
});

describe("learn:<id> view-key parsing", () => {
  it("strips the learn: prefix once and reads every other view as empty", () => {
    assert.equal(learningLibraryIdForActive("learn:ll_abc123"), "ll_abc123");
    for (const active of ["所有素材", "待整理", "收藏", "回收站", "Pinterest", "source:chatgpt", "group:风景", "learn:", ""]) {
      assert.equal(learningLibraryIdForActive(active), "", `active=${JSON.stringify(active)}`);
    }
  });

  it("does not treat group keys with colons as learn keys", () => {
    assert.equal(learningLibraryIdForActive("group:a:b"), "");
  });
});

describe("learning-library drop-target resolution", () => {
  const row = (id) => ({
    closest: (selector) => {
      assert.equal(selector, "[data-drop-learning-library]");
      return { getAttribute: (name) => (name === "data-drop-learning-library" ? id : null) };
    },
  });

  it("returns the row's library id when the pointer lands on a learning-library row", () => {
    assert.equal(learningLibraryIdFromDropRow(row("ll_xyz")), "ll_xyz");
  });

  it("returns empty for cards, group rows and null elements (no library row in the chain)", () => {
    const noLibrary = { closest: () => null };
    assert.equal(learningLibraryIdFromDropRow(noLibrary), "");
    assert.equal(learningLibraryIdFromDropRow(null), "");
    assert.equal(learningLibraryIdFromDropRow(undefined), "");
    const blankRow = { closest: () => ({ getAttribute: () => "" }) };
    assert.equal(learningLibraryIdFromDropRow(blankRow), "", "a row without an id is no target");
  });
});
