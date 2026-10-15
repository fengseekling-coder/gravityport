/**
 * Test suite for context-menus.ts
 * Compiles TypeScript to temp directory and imports the result, matching gravityport-library-actions.test.mjs pattern.
 */

import { describe, it, before } from "node:test"
import assert from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"

let buildContextMenu

before(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "gravityport-cm-test-"))
  try {
    execSync(`npx tsc web/gravityport/src/context-menus.ts --outDir ${tmp} --module esnext --target esnext --moduleResolution bundler --esModuleInterop --skipLibCheck`, { cwd: process.cwd(), stdio: "inherit" })
    const module = await import(join(tmp, "context-menus.js"))
    buildContextMenu = module.buildContextMenu
  } finally {
    rmSync(tmp, { recursive: true })
  }
})

describe("context-menus / buildContextMenu", () => {
  describe("asset menu (non-trash)", () => {
    it("has correct order and separators", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.map(e => e.kind === "separator" ? "|" : e.kind === "heading" ? `HEAD:${e.label}` : e.id)
      
      // Should have view actions, copy actions, favorite, group actions, trash
      assert(ids.includes("open-in-viewer"), "Missing open-in-viewer")
      assert(ids.includes("copy-image"), "Missing copy-image")
      assert(ids.includes("favorite"), "Missing favorite")
      assert(ids.includes("add-group"), "Missing add-group")
      assert(ids.includes("trash"), "Missing trash")
      
      // No leading/trailing/consecutive separators
      assert(ids[0] !== "|", "Leading separator")
      assert(ids[ids.length - 1] !== "|", "Trailing separator")
      for (let i = 0; i < ids.length - 1; i++) {
        assert(!(ids[i] === "|" && ids[i + 1] === "|"), `Consecutive separators at ${i}`)
      }
    })

    it("has heading when multi-select", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 3,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const headings = items.filter(e => e.kind === "heading")
      assert.strictEqual(headings.length, 1, "Should have one heading for multi-select")
      assert(headings[0].label.includes("3"), "Heading should show selection count")
    })

    it("no heading when single-select", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const headings = items.filter(e => e.kind === "heading")
      assert.strictEqual(headings.length, 0, "Single-select should have no heading")
    })

    it("has 'move-out' when inside stack", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: "stack-123",
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("move-out"), "Should have move-out when inside stack")
      assert(!ids.includes("create-stack"), "Should not have create-stack when inside stack")
    })

    it("has 'create-stack' when multi-select, not in stack, no stacks in selection", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 2,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("create-stack"), "Should have create-stack")
      assert(!ids.includes("move-out"), "Should not have move-out")
    })

    it("no stack actions when selection has stacks", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 2,
        selectionHasStacks: true,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(!ids.includes("create-stack"), "Should not have create-stack when selection has stacks")
      assert(!ids.includes("export"), "Should not have export when selection has stacks")
    })

    it("has 'remove-group' disabled when no grouped assets", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const removeGroup = items.find(e => e.kind === "item" && e.id === "remove-group")
      assert(removeGroup, "Should have remove-group")
      assert.strictEqual(removeGroup.disabled, true, "remove-group should be disabled when no grouped assets")
    })

    it("has 'add-group' submenu with new group + groups", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [
          { name: "Group A", color: "#ff0000" },
          { name: "Group B", color: "#00ff00" },
        ],
        pageTotal: 10,
      })
      
      const addGroup = items.find(e => e.kind === "item" && e.id === "add-group")
      assert(addGroup, "Should have add-group")
      assert(addGroup.submenu, "add-group should have submenu")
      assert(addGroup.submenu.length > 0, "add-group submenu should not be empty")
      
      const submenuIds = addGroup.submenu.filter(e => e.kind === "item").map(e => e.id)
      assert(submenuIds.includes("create-group-with-selection"), "Submenu should have create-group-with-selection")
      assert(submenuIds.includes("group:Group A"), "Submenu should have Group A")
      assert(submenuIds.includes("group:Group B"), "Submenu should have Group B")
    })

    it("has 'add-group' submenu with only new group when no groups", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "library",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const addGroup = items.find(e => e.kind === "item" && e.id === "add-group")
      assert(addGroup.submenu, "add-group should have submenu")
      const items_in_submenu = addGroup.submenu.filter(e => e.kind === "item")
      assert.strictEqual(items_in_submenu.length, 1, "Submenu should have only one item")
      assert.strictEqual(items_in_submenu[0].id, "create-group-with-selection", "Only item should be create-group-with-selection")
    })
  })

  describe("stack card menu", () => {
    it("has paste when cut active", () => {
      const items = buildContextMenu({
        target: "stack",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: true,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("paste-into-stack"), "Should have paste-into-stack when cut active")
      assert.strictEqual(ids[0], "paste-into-stack", "paste-into-stack should be first")
    })

    it("no paste when no cut", () => {
      const items = buildContextMenu({
        target: "stack",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(!ids.includes("paste-into-stack"), "Should not have paste-into-stack when no cut")
    })

    it("has core stack actions", () => {
      const items = buildContextMenu({
        target: "stack",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("open-stack"), "Should have open-stack")
      assert(ids.includes("rename-stack"), "Should have rename-stack")
      assert(ids.includes("dissolve-stack"), "Should have dissolve-stack")
      assert(ids.includes("trash"), "Should have trash")
    })
  })

  describe("stack blank menu", () => {
    it("has back to library", () => {
      const items = buildContextMenu({
        target: "stack-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: "stack-123",
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("back-to-library"), "Should have back-to-library")
    })

    it("has paste when cut active", () => {
      const items = buildContextMenu({
        target: "stack-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: "stack-123",
        cutActive: true,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("paste"), "Should have paste when cut active")
    })

    it("no paste when no cut", () => {
      const items = buildContextMenu({
        target: "stack-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: "stack-123",
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(!ids.includes("paste"), "Should not have paste when no cut")
    })

    it("has select-all disabled when page empty", () => {
      const items = buildContextMenu({
        target: "stack-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: "stack-123",
        cutActive: false,
        groups: [],
        pageTotal: 0,
      })
      
      const selectAll = items.find(e => e.kind === "item" && e.id === "select-all")
      assert(selectAll, "Should have select-all")
      assert.strictEqual(selectAll.disabled, true, "select-all should be disabled when page empty")
    })
  })

  describe("gallery blank menu", () => {
    it("has paste when cut active", () => {
      const items = buildContextMenu({
        target: "gallery-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: true,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("paste"), "Should have paste when cut active")
    })

    it("no paste when no cut", () => {
      const items = buildContextMenu({
        target: "gallery-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(!ids.includes("paste"), "Should not have paste when no cut")
    })

    it("has create-group and utils", () => {
      const items = buildContextMenu({
        target: "gallery-blank",
        scope: "library",
        selectionCount: 0,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      const ids = items.filter(e => e.kind === "item").map(e => e.id)
      assert(ids.includes("create-group"), "Should have create-group")
      assert(ids.includes("select-all"), "Should have select-all")
      assert(ids.includes("refresh"), "Should have refresh")
    })
  })

  describe("trash scope", () => {
    it("returns similar menu for trash", () => {
      const items = buildContextMenu({
        target: "asset",
        scope: "trash",
        selectionCount: 1,
        selectionHasStacks: false,
        anyGrouped: false,
        favorite: false,
        insideStackId: null,
        cutActive: false,
        groups: [],
        pageTotal: 10,
      })
      
      // Should still have some actions, preserving existing behavior
      assert(items.length > 0, "Should have items in trash")
    })
  })

  describe("no bad separators", () => {
    const scenarios = [
      { target: "asset", selectionCount: 1, cutActive: false, groups: [] },
      { target: "asset", selectionCount: 3, cutActive: true, groups: [{ name: "G1" }] },
      { target: "stack", selectionCount: 0, cutActive: false, groups: [] },
      { target: "stack", selectionCount: 0, cutActive: true, groups: [] },
      { target: "stack-blank", selectionCount: 0, cutActive: false, groups: [] },
      { target: "gallery-blank", selectionCount: 0, cutActive: false, groups: [] },
    ]

    for (const scenario of scenarios) {
      it(`no bad separators for ${scenario.target} (count=${scenario.selectionCount}, cut=${scenario.cutActive})`, () => {
        const items = buildContextMenu({
          ...scenario,
          scope: "library",
          selectionHasStacks: false,
          anyGrouped: false,
          favorite: false,
          insideStackId: null,
          pageTotal: 10,
        })
        
        const ids = items.map(e => e.kind === "separator" ? "|" : "x")
        
        // No leading separator
        if (ids.length > 0) {
          assert(ids[0] !== "|", `Leading separator in ${scenario.target}`)
        }
        
        // No trailing separator
        if (ids.length > 0) {
          assert(ids[ids.length - 1] !== "|", `Trailing separator in ${scenario.target}`)
        }
        
        // No consecutive separators
        for (let i = 0; i < ids.length - 1; i++) {
          assert(!(ids[i] === "|" && ids[i + 1] === "|"), `Consecutive separators at ${i} in ${scenario.target}`)
        }
      })
    }
  })
})
