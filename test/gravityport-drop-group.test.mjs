/**
 * GravityPort drop-into-group: the pure mapping from the active view key to
 * the group a gallery drop or paste imports into (task 224).
 *
 * Compiles the real TypeScript source and imports it — no reimplementation.
 */
import { execFileSync } from "node:child_process"
import { rm, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, before, describe, it } from "node:test"
import assert from "node:assert/strict"

const repositoryRoot = resolve(import.meta.dirname, "..")
const uiRoot = join(repositoryRoot, "web", "gravityport")

describe("groupNameForActive", () => {
  let groupNameForActive
  let tempRoot

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-drop-group-"))
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "import-target.ts"),
      "--outDir", tempRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ], { stdio: "pipe" })
    ;({ groupNameForActive } = await import(join(tempRoot, "import-target.js")))
  })

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it("returns the group name of a 我的分组 view", () => {
    assert.equal(groupNameForActive("group:风景"), "风景")
  })

  it("keeps colons that belong to the group name", () => {
    assert.equal(groupNameForActive("group:a:b"), "a:b")
  })

  it("returns no group for every other view", () => {
    for (const active of ["所有素材", "待整理", "收藏", "回收站", "Pinterest", "source:chatgpt", ""]) {
      assert.equal(groupNameForActive(active), "", `active=${JSON.stringify(active)}`)
    }
  })

  it("reads the degenerate group: key as no group", () => {
    assert.equal(groupNameForActive("group:"), "")
  })
})
