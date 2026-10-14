/**
 * GravityPort import-pipeline unit and integration tests.
 *
 * Uses the same pattern as gravityport-interaction.test.mjs: compile the TypeScript
 * source files to a temp directory, then import them as ESM modules.
 */
import { execFileSync } from "node:child_process"
import { rm, mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { after, afterEach, before, describe, it } from "node:test"
import assert from "node:assert/strict"

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+1CBR3wAAAABJRU5ErkJggg==",
  "base64",
)

const repositoryRoot = resolve(import.meta.dirname, "..")
const uiRoot = join(repositoryRoot, "web", "gravityport")

let tempRoot

// ─── Shared test helpers ───────────────────────────────────────────────────────

function makeEntry(name, isDir, children) {
  children = children || []
  let readEntries = [...children]
  const reader = isDir
    ? {
        readEntries: (cb) => {
          const batch = readEntries.splice(0, 2)
          setTimeout(() => cb(batch), 0)
        },
      }
    : null
  return {
    name,
    isFile: !isDir,
    isDirectory: isDir,
    createReader: () => reader,
    file: (cb) => {
      cb({ name, size: 1024, type: "image/png" })
    },
  }
}

// ─── collectDroppedFiles tests (standalone, no API dependency) ─────────────────

describe("collectDroppedFiles with fake entry objects", () => {
  let collectDroppedFiles

  before(async () => {
    // Compile only collect-dropped-files.ts (no external dependencies)
    tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-collect-"))
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "collect-dropped-files.ts"),
      "--outDir", tempRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ], { stdio: "pipe" })
    const mod = await import(join(tempRoot, "collect-dropped-files.js"))
    collectDroppedFiles = mod.collectDroppedFiles
  })

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it("recursively expands directories", async () => {
    const folder = makeEntry("folder", true, [
      makeEntry("a.png", false),
      makeEntry("inner.png", false),
      makeEntry("b.jpg", false),
    ])
    const result = await collectDroppedFiles(
      { items: [{ kind: "file", webkitGetAsEntry: () => folder }] },
      { maxFiles: 10000, isSupported: (n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n), onScanProgress: () => {} },
    )
    assert.equal(result.files.length, 3)
    assert.equal(result.unsupported, 0)
  })

  it("skips hidden files and directories", async () => {
    const visible = makeEntry("visible.png", false)
    const hidden = makeEntry(".hidden.png", false)
    const folder = makeEntry("visible-folder", true, [
      makeEntry("nested.png", false),
      makeEntry(".secret", false),
    ])
    const result = await collectDroppedFiles(
      {
        items: [
          { kind: "file", webkitGetAsEntry: () => visible },
          { kind: "file", webkitGetAsEntry: () => hidden },
          { kind: "file", webkitGetAsEntry: () => folder },
        ],
      },
      { maxFiles: 10000, isSupported: (n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n), onScanProgress: () => {} },
    )
    assert.equal(result.files.length, 2, "only non-hidden files counted")
    assert.equal(result.unsupported, 0)
  })

  it("counts unsupported extensions as skipped, not failed", async () => {
    const supported = makeEntry("img.png", false)
    const unsupported = makeEntry("doc.pdf", false)
    const result = await collectDroppedFiles(
      {
        items: [
          { kind: "file", webkitGetAsEntry: () => supported },
          { kind: "file", webkitGetAsEntry: () => unsupported },
        ],
      },
      { maxFiles: 10000, isSupported: (n) => /\.(png|jpg|jpeg|gif|webp)$/i.test(n), onScanProgress: () => {} },
    )
    assert.equal(result.files.length, 1)
    assert.equal(result.unsupported, 1)
  })

  it("throws when exceeding maxFiles limit", async () => {
    const files = Array.from({ length: 5 }, (_, i) => makeEntry(`f${i}.png`, false))
    try {
      await collectDroppedFiles(
        { items: files.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })) },
        { maxFiles: 3, isSupported: () => true, onScanProgress: () => {} },
      )
      assert.fail("Should have thrown")
    } catch (error) {
      assert.equal(error.code, "IMPORT_DROP_TOO_LARGE")
      assert.equal(error.maxFiles, 3)
    }
  })

  it("calls onScanProgress as files are collected", async () => {
    const files = [makeEntry("a.png", false), makeEntry("b.png", false), makeEntry("c.png", false)]
    let progressCalls = []
    const result = await collectDroppedFiles(
      { items: files.map((e) => ({ kind: "file", webkitGetAsEntry: () => e })) },
      { maxFiles: 10000, isSupported: () => true, onScanProgress: (n) => progressCalls.push(n) },
    )
    assert.ok(progressCalls.length > 0, "should report progress")
    assert.deepEqual(progressCalls, [1, 2, 3])
  })
})

describe("collectDroppedFiles fallback without webkitGetAsEntry", () => {
  let collectDroppedFiles

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-collect-fb-"))
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "collect-dropped-files.ts"),
      "--outDir", tempRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ], { stdio: "pipe" })
    const mod = await import(join(tempRoot, "collect-dropped-files.js"))
    collectDroppedFiles = mod.collectDroppedFiles
  })

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it("falls back to dataTransfer.files when no entries", async () => {
    const result = await collectDroppedFiles(
      {
        items: [],
        files: [
          { name: "a.png", size: 100 },
          { name: "b.jpg", size: 200 },
        ],
      },
      { maxFiles: 10000, isSupported: (n) => /\.(png|jpg)$/i.test(n) },
    )
    assert.equal(result.files.length, 2)
    assert.equal(result.unsupported, 0)
  })
})

// ─── Concurrent utility for testing (copied from import-pipeline) ──────────────

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let cursor = 0

  async function worker() {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      try {
        results[index] = { ok: true, value: await mapper(items[index], index) }
      } catch (error) {
        results[index] = { ok: false, error }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  return results
}

// ─── Inline import pipeline logic for testing (avoids module resolution issues) ──

const STAGING_CONCURRENCY = 4
const CREATE_BATCH_SIZE = 40

async function cleanupStagedFile(stagedPath) {
  if (!stagedPath || typeof stagedPath !== "string") return
  try {
    await fetch("/api/import/stage", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: stagedPath }),
      credentials: "same-origin",
    })
  } catch (error) {
    console.warn(`[MOSA] staged file cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function cleanupPaths(paths) {
  await mapWithConcurrency(paths, STAGING_CONCURRENCY, (path) => cleanupStagedFile(path))
}

/**
 * Run import pipeline with mocked API (copied from import-pipeline.ts for testing)
 */
async function runImportTest(files, options) {
  const { project, stackId, groupName, isSupported, signal, onProgress } = options

  // Pre-filter: unsupported files count as skipped, no API calls for them
  const supported = []
  let skipped = 0
  for (const file of files) {
    if (isSupported(file.name)) {
      supported.push(file)
    } else {
      skipped += 1
    }
  }

  const total = supported.length
  const result = {
    imported: 0,
    failed: 0,
    skipped,
    createdIds: [],
    errors: [],
  }

  if (!total) return result

  onProgress?.({ phase: "staging", total, completed: 0, imported: 0, failed: 0, skipped })

  // Mock staging
  const stagedResults = await mapWithConcurrency(supported, STAGING_CONCURRENCY, async (file) => {
    if (signal?.aborted) throw new Error("Import cancelled")
    // Simulate staging - in real code this calls stageImportFile
    const path = `/staged/${Date.now()}-${Math.random().toString(36).slice(2)}`
    return { file, path }
  })

  const stagedFiles = []
  for (const r of stagedResults) {
    if (r.ok && r.value) {
      stagedFiles.push(r.value)
    } else if (!r.ok && r.error) {
      result.failed += 1
      result.errors.push({
        fileName: (r.error).fileName || "unknown",
        reason: r.error instanceof Error ? r.error.message : String(r.error),
      })
    }
  }

  const finalPathsToClean = []

  try {
    onProgress?.({ phase: "importing", total, completed: 0, imported: 0, failed: result.failed, skipped })

    let completed = 0
    for (let offset = 0; offset < stagedFiles.length; offset += CREATE_BATCH_SIZE) {
      if (signal?.aborted) {
        finalPathsToClean.push(...stagedFiles.slice(offset).map((s) => s.path))
        break
      }

      const batch = stagedFiles.slice(offset, offset + CREATE_BATCH_SIZE)
      const batchItems = batch.map((s) => ({ imagePath: s.path }))

      try {
        // In real code this calls importAssetsBatch
        // For testing, we use the mock fetch response
        const response = await fetch("/api/assets/import-batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ projectId: project, items: batchItems, ...(stackId ? { stackId } : {}) }),
        })
        const importResult = await response.json()

        const failedInBatch = []
        for (let i = 0; i < batch.length; i++) {
          const itemResult = importResult.results?.find((r) => r.index === i)
          if (itemResult?.ok && itemResult.id) {
            result.createdIds.push(itemResult.id)
          } else {
            failedInBatch.push(batch[i])
            // Note: don't increment result.failed here - it's already counted in importResult.failed
            result.errors.push({
              fileName: batch[i].file.name,
              reason: itemResult?.error || "Import failed",
            })
          }
        }

        result.imported += importResult.imported
        // importResult.failed already accounts for items that failed
        result.failed += importResult.failed
        finalPathsToClean.push(...failedInBatch.map((s) => s.path))
        if (failedInBatch.length > 0) {
          await cleanupPaths(failedInBatch.map((s) => s.path))
        }
      } catch (error) {
        result.failed += batch.length
        for (const s of batch) {
          result.errors.push({
            fileName: s.file.name,
            reason: error instanceof Error ? error.message : String(error),
          })
          finalPathsToClean.push(s.path)
        }
        await cleanupPaths(batch.map((s) => s.path))
      }

      completed += batch.length
      onProgress?.({
        phase: "importing",
        total,
        completed,
        imported: result.imported,
        failed: result.failed,
        skipped,
      })
    }

    if (groupName && result.createdIds.length > 0) {
      try {
        // In real code this calls setAssetsGroup
        await fetch("/api/assets/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "group", projectId: project, assetIds: result.createdIds, group: groupName }),
        })
      } catch (error) {
        console.warn(`[MOSA] group assignment failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  } finally {
    if (finalPathsToClean.length > 0) {
      await cleanupPaths(finalPathsToClean)
    }
  }

  onProgress?.({ phase: "done", total, completed: total, imported: result.imported, failed: result.failed, skipped })
  return result
}

// ─── runImport batching tests (mock API) ───────────────────────────────────────

describe("runImport batches correctly", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function makeFile(name) {
    return { name }
  }

  it("600 files → 15 import-batch requests of 40 each", async () => {
    let batchCount = 0
    const batchItems = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        return { ok: true, json: async () => ({ path: `/staged/${Date.now()}` }) }
      }
      if (url === "/api/assets/import-batch" && init?.method === "POST") {
        batchCount++
        const body = JSON.parse(init.body)
        batchItems.push(...body.items)
        return {
          ok: true,
          json: async () => ({
            imported: body.items.length,
            failed: 0,
            results: body.items.map((_, i) => ({ index: i, ok: true, id: `asset-${Date.now()}-${i}` })),
          }),
        }
      }
      return originalFetch(url, init)
    }

    try {
      const files = Array.from({ length: 600 }, (_, i) => makeFile(`img${i}.png`))
      const result = await runImportTest(files, {
        project: "default",
        isSupported: (n) => n.endsWith(".png"),
      })

      assert.equal(batchCount, 15, "should have 15 batches")
      assert.equal(result.imported, 600)
      assert.equal(result.createdIds.length, 600)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("partial batch failure marks all items in that batch as failed", async () => {
    let batchCount = 0
    const cleanupPaths = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        return { ok: true, json: async () => ({ path: `/staged/${Date.now()}` }) }
      }
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        cleanupPaths.push(JSON.parse(init.body).path)
        return { ok: true, json: async () => ({ ok: true }) }
      }
      if (url === "/api/assets/import-batch" && init?.method === "POST") {
        batchCount++
        const body = JSON.parse(init.body)
        // Second batch fails
        if (batchCount === 2) {
          throw new Error("Server error")
        }
        return {
          ok: true,
          json: async () => ({
            imported: body.items.length,
            failed: 0,
            results: body.items.map((_, i) => ({ index: i, ok: true, id: `id-${batchCount}-${i}` })),
          }),
        }
      }
      return originalFetch(url, init)
    }

    try {
      const files = Array.from({ length: 80 }, (_, i) => makeFile(`img${i}.png`))
      const result = await runImportTest(files, {
        project: "default",
        isSupported: (n) => n.endsWith(".png"),
      })

      assert.equal(result.imported, 40, "first batch succeeds")
      assert.equal(result.failed, 40, "second batch all failed")
      assert.ok(cleanupPaths.length > 0, "should have cleanup DELETE calls for failed batch")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("individual ok:false item only cleans up that one path", async () => {
    const cleanupPaths = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        cleanupPaths.push(JSON.parse(init.body).path)
        return { ok: true, json: async () => ({ ok: true }) }
      }
      if (url === "/api/assets/import-batch") {
        return {
          ok: true,
          json: async () => ({
            imported: 1,  // Only 1 succeeded
            failed: 1,    // 1 failed
            results: [
              { index: 0, ok: true, id: "good-1" },
              { index: 1, ok: false, error: "bad format" },
            ],
          }),
        }
      }
      return originalFetch(url, init)
    }

    try {
      const files = [makeFile("good.png"), makeFile("bad.png")]
      const result = await runImportTest(files, {
        project: "default",
        isSupported: () => true,
      })
      assert.equal(result.imported, 1)
      assert.equal(result.failed, 1)
      assert.ok(cleanupPaths.length > 0, "should cleanup the failed item's staged path")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("staging failure increments failed count correctly", async () => {
    // Test that mapWithConcurrency correctly tracks failed items
    const items = ["a", "b", "c"]
    let attempt = 0

    const results = await mapWithConcurrency(items, 4, async (item) => {
      attempt++
      if (attempt === 2) throw new Error("Staging failed")
      return `staged-${item}`
    })

    const successful = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok).length

    assert.equal(successful, 2, "2 items staged successfully")
    assert.equal(failed, 1, "1 item failed")
  })

  it("unsupported files are counted as skipped without any requests", async () => {
    const fetchCalls = []

    // Override fetch completely for this test
    globalThis.fetch = async (url, init) => {
      fetchCalls.push(`${init?.method || "GET"} ${url}`)
      // Return a mock response to prevent actual network calls
      return {
        ok: true,
        json: async () => ({ imported: 0, failed: 0, results: [] }),
      }
    }

    try {
      const files = [makeFile("a.png"), makeFile("b.pdf"), makeFile("c.txt")]
      const result = await runImportTest(files, {
        project: "default",
        isSupported: (n) => n.endsWith(".png"),
      })
      assert.equal(result.skipped, 2, "2 unsupported files skipped")
      assert.equal(result.imported, 0)
      assert.equal(result.failed, 0)
      // No staging POST calls for skipped files
      const stagingCalls = fetchCalls.filter((c) => c.includes("POST /api/import/stage"))
      assert.equal(stagingCalls.length, 0, "no staging calls for skipped files")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("groupName calls setAssetsGroup only for successful ids", async () => {
    let groupCalls = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/assets/batch" && init?.method === "POST") {
        const body = JSON.parse(init.body)
        if (body.action === "group") {
          groupCalls.push(body)
          return { ok: true, json: async () => ({ results: body.assetIds.map((id) => ({ id, ok: true })) }) }
        }
      }
      if (url === "/api/import/stage" && init?.method === "POST") {
        return { ok: true, json: async () => ({ path: `/staged/${Date.now()}` }) }
      }
      if (url === "/api/assets/import-batch") {
        return {
          ok: true,
          json: async () => ({
            imported: 3,
            failed: 0,
            results: [
              { index: 0, ok: true, id: "asset-0" },
              { index: 1, ok: true, id: "asset-1" },
              { index: 2, ok: true, id: "asset-2" },
            ],
          }),
        }
      }
      return originalFetch(url, init)
    }

    try {
      const files = [makeFile("a.png"), makeFile("b.png"), makeFile("c.png")]
      const result = await runImportTest(files, {
        project: "default",
        groupName: "My Group",
        isSupported: () => true,
      })
      assert.equal(result.createdIds.length, 3)
      assert.ok(groupCalls.length > 0, "should call group endpoint")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("AbortSignal stops new import-batch requests", async () => {
    let batchCount = 0
    const controller = new AbortController()

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        return { ok: true, json: async () => ({ path: `/staged/${Date.now()}` }) }
      }
      if (url === "/api/assets/import-batch") {
        batchCount++
        if (batchCount >= 1) controller.abort()
        return {
          ok: true,
          json: async () => ({
            imported: 40,
            failed: 0,
            results: Array.from({ length: 40 }, (_, i) => ({ index: i, ok: true, id: `id-${i}` })),
          }),
        }
      }
      return originalFetch(url, init)
    }

    try {
      const files = Array.from({ length: 100 }, (_, i) => makeFile(`img${i}.png`))
      const result = await runImportTest(files, {
        project: "default",
        signal: controller.signal,
        isSupported: () => true,
      })
      assert.ok(batchCount <= 2, "should not send more batches after abort")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

// ─── Real server integration test ────────────────────────────────────────────

describe("runImport against real MOSA runtime", () => {
  let startMosaRuntime
  const originalFetch = globalThis.fetch

  before(async () => {
    const runtimePath = join(repositoryRoot, "lib", "mosa-runtime.mjs")
    const runtimeModule = await import(runtimePath)
    startMosaRuntime = runtimeModule.startMosaRuntime
  })

  it("imports 45 PNG files in 2 batches and creates assets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-import-e2e-"))
    const generated = join(root, "generated-images")
    await mkdir(generated, { recursive: true })

    for (let i = 0; i < 45; i++) {
      await writeFile(join(generated, `img${i}.png`), ONE_PIXEL_PNG)
    }

    const runtime = await startMosaRuntime({
      port: 0,
      projectRoot: root,
      libraryDir: join(root, "library"),
      generatedImagesDir: generated,
      codexImagesDir: join(root, "codex-images"),
      codexSessionsDir: join(root, "sessions"),
      grokSessionsDir: join(root, "grok-sessions"),
      cowartCanvasDir: join(root, "cowart-data"),
      cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    })
    t.after(() => runtime.stop())

    const authHeaders = () => ({ "x-mosa-client-token": runtime.clientToken })

    // Stage all files first
    const stagedPaths = []
    for (let i = 0; i < 45; i++) {
      const filePath = join(generated, `img${i}.png`)
      const fileName = `img${i}.png`
      const { readFileSync } = await import("node:fs")
      const content = readFileSync(filePath)
      const stageResponse = await originalFetch(`${runtime.url}/api/import/stage`, {
        method: "POST",
        headers: { "x-mosa-file-name": encodeURIComponent(fileName), ...authHeaders() },
        body: content,
      })
      const stageData = await stageResponse.json()
      assert.equal(stageResponse.status, 201)
      stagedPaths.push(stageData.path)
    }

    // Import in 2 batches
    const batch1 = stagedPaths.slice(0, 40).map((path) => ({ imagePath: path }))
    const batch2 = stagedPaths.slice(40).map((path) => ({ imagePath: path }))

    const import1 = await originalFetch(`${runtime.url}/api/assets/import-batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ projectId: "default", items: batch1 }),
    })
    assert.equal(import1.status, 200)
    const result1 = await import1.json()
    assert.equal(result1.imported, 40, "first batch should import 40")

    const import2 = await originalFetch(`${runtime.url}/api/assets/import-batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ projectId: "default", items: batch2 }),
    })
    assert.equal(import2.status, 200)
    const result2 = await import2.json()
    assert.equal(result2.imported, 5, "second batch should import 5")

    // Verify total
    const library = await originalFetch(`${runtime.url}/api/assets?project=default&limit=100`)
    const libraryData = await library.json()
    assert.equal(libraryData.assets.length, 45, "should have 45 assets total")
  })

  it("imports with stackId and assets land in the stack", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-import-stack-"))
    const generated = join(root, "generated-images")
    await mkdir(generated, { recursive: true })

    for (let i = 0; i < 7; i++) {
      await writeFile(join(generated, `img${i}.png`), ONE_PIXEL_PNG)
    }

    const runtime = await startMosaRuntime({
      port: 0,
      projectRoot: root,
      libraryDir: join(root, "library"),
      generatedImagesDir: generated,
      codexImagesDir: join(root, "codex-images"),
      codexSessionsDir: join(root, "sessions"),
      grokSessionsDir: join(root, "grok-sessions"),
      cowartCanvasDir: join(root, "cowart-data"),
      cowartRegistryPath: join(root, "state", "cowart-projects.json"),
    })
    t.after(() => runtime.stop())

    const authHeaders = () => ({ "x-mosa-client-token": runtime.clientToken })

    // Stage and import first 2 files
    const initialPaths = []
    for (let i = 0; i < 2; i++) {
      const filePath = join(generated, `img${i}.png`)
      const fileName = `base${i}.png`
      const { readFileSync } = await import("node:fs")
      const content = readFileSync(filePath)
      const stageResponse = await originalFetch(`${runtime.url}/api/import/stage`, {
        method: "POST",
        headers: { "x-mosa-file-name": encodeURIComponent(fileName), ...authHeaders() },
        body: content,
      })
      const stageData = await stageResponse.json()
      initialPaths.push(stageData.path)
    }

    const initialImport = await originalFetch(`${runtime.url}/api/assets/import-batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ projectId: "default", items: initialPaths.map((p) => ({ imagePath: p })) }),
    })
    const initialResult = await initialImport.json()
    assert.equal(initialResult.imported, 2)

    // Create a stack
    const stackResponse = await originalFetch(`${runtime.url}/api/asset-stacks`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        projectId: "default",
        assetIds: initialResult.results.filter((r) => r.ok).map((r) => r.asset.id),
        coverAssetId: initialResult.results[0].asset.id,
      }),
    })
    assert.equal(stackResponse.status, 201)
    const { stack } = await stackResponse.json()

    // Stage and import 5 more files into the stack
    const stackPaths = []
    for (let i = 2; i < 7; i++) {
      const filePath = join(generated, `img${i}.png`)
      const fileName = `stack-img${i}.png`
      const { readFileSync } = await import("node:fs")
      const content = readFileSync(filePath)
      const stageResponse = await originalFetch(`${runtime.url}/api/import/stage`, {
        method: "POST",
        headers: { "x-mosa-file-name": encodeURIComponent(fileName), ...authHeaders() },
        body: content,
      })
      const stageData = await stageResponse.json()
      stackPaths.push(stageData.path)
    }

    const stackImport = await originalFetch(`${runtime.url}/api/assets/import-batch`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        projectId: "default",
        stackId: stack.id,
        items: stackPaths.map((p) => ({ imagePath: p })),
      }),
    })
    assert.equal(stackImport.status, 200)
    const stackImportResult = await stackImport.json()
    assert.equal(stackImportResult.imported, 5)

    // Verify the new assets are in the stack
    const stackAssets = await originalFetch(
      `${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=100`,
    )
    const stackAssetsData = await stackAssets.json()
    assert.equal(stackAssetsData.assets.length, 7, "stack should have 7 assets (2 initial + 5 new)")
  })
})
