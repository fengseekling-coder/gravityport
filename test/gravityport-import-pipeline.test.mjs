/**
 * GravityPort import-pipeline unit and integration tests.
 *
 * Compiles TypeScript modules to temp directory and tests the real implementation.
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

// ─── runImport unit tests (mocked fetch) ───────────────────────────────────────

describe("runImport with mocked fetch", () => {
  let runImport
  const originalFetch = globalThis.fetch

  before(async () => {
    // Compile all three modules together
    tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-import-"))
    
    // Create package.json to enable ESM module resolution
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ type: "module" }))
    
    // Minimal globalThis stubs for mosa-api.ts compilation and runtime
    globalThis.window = globalThis.window || {}
    globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    globalThis.sessionStorage = globalThis.sessionStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    globalThis.document = globalThis.document || { cookie: "" }
    globalThis.location = globalThis.location || { hash: "", pathname: "/", search: "" }
    globalThis.history = globalThis.history || { replaceState: () => {} }
    
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "mosa-api.ts"),
      join(uiRoot, "src", "collect-dropped-files.ts"),
      join(uiRoot, "src", "import-pipeline.ts"),
      "--outDir", tempRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ], { stdio: "pipe" })
    
    // Use file:// URL with cache-busting query to force fresh import
    const modPath = `file://${join(tempRoot, "import-pipeline.js")}?t=${Date.now()}`
    const mod = await import(modPath)
    runImport = mod.runImport
  })

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })


  it("600 files → 15 batches of 40 each, stage→import per batch", async () => {
    let stagingCallCount = 0
    let batchCallCount = 0
    const batchSizes = []

    // Mock fetch BEFORE calling runImport
    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        stagingCallCount++
        const data = { path: `/staged/${stagingCallCount}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch" && init?.method === "POST") {
        batchCallCount++
        const body = JSON.parse(init.body)
        batchSizes.push(body.items.length)
        const data = {
          imported: body.items.length,
          failed: 0,
          results: body.items.map((_, i) => ({ index: i, ok: true, asset: { id: `asset-${batchCallCount}-${i}` } })),
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        const data = { ok: true }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/batch" && init?.method === "POST") {
        const body = JSON.parse(init.body)
        const data = { results: body.assetIds?.map((id) => ({ id, ok: true })) || [] }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      throw new Error(`Unexpected fetch call: ${url} ${init?.method}`)
    }

    const files = Array.from({ length: 600 }, (_, i) => new globalThis.File([`img${i}`], `img${i}.png`, { type: "image/png" }))
    const result = await runImport(files, {
      project: "default",
      isSupported: (n) => n.endsWith(".png"),
    })

    assert.equal(stagingCallCount, 600, `should stage all 600 files (got ${stagingCallCount})`)
    assert.equal(batchCallCount, 15, "should have 15 import batches")
    assert.deepEqual(batchSizes, Array(15).fill(40), "each batch should have 40 items")
    assert.equal(result.imported, 600, `result.imported should be 600, got ${result.imported}`)
    assert.equal(result.createdIds.length, 600)
  })

  it("batch with 3 files, 1 fails (ok:false) → failed===1, imported===2", async () => {
    const cleanupPaths = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        const data = { path: `/staged/${Date.now()}-${Math.random()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        cleanupPaths.push(JSON.parse(init.body).path)
        const data = { ok: true }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        const data = {
          imported: 2,
          failed: 1,
          results: [
            { index: 0, ok: true, asset: { id: "id-0" } },
            { index: 1, ok: false, error: "bad format" },
            { index: 2, ok: true, asset: { id: "id-2" } },
          ],
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [
      new globalThis.File(["a"], "a.png", { type: "image/png" }),
      new globalThis.File(["bad"], "bad.png", { type: "image/png" }),
      new globalThis.File(["c"], "c.png", { type: "image/png" }),
    ]
    const result = await runImport(files, {
      project: "default",
      isSupported: () => true,
    })

    assert.equal(result.imported, 2, "2 items succeeded")
    assert.equal(result.failed, 1, "1 item failed")
    assert.equal(result.createdIds.length, 2)
    assert.equal(cleanupPaths.length, 1, "exactly 1 cleanup DELETE call for the failed item")
  })

  it("staging failure includes fileName in error", async () => {
    let attemptCount = 0

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        attemptCount++
        if (attemptCount === 2) {
          const data = { error: "disk full" }
          return { ok: false, status: 500, json: async () => data, text: async () => JSON.stringify(data) }
        }
        const data = { path: `/staged/${attemptCount}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        const body = JSON.parse(init.body)
        const data = {
          imported: body.items.length,
          failed: 0,
          results: body.items.map((_, i) => ({ index: i, ok: true, asset: { id: `id-${i}` } })),
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [
      new globalThis.File(["good1"], "good1.png", { type: "image/png" }),
      new globalThis.File(["fail"], "fail-staging.png", { type: "image/png" }),
      new globalThis.File(["good2"], "good2.png", { type: "image/png" }),
    ]
    const result = await runImport(files, {
      project: "default",
      isSupported: () => true,
    })

    assert.equal(result.failed, 1)
    assert.equal(result.imported, 2)
    const stagingError = result.errors.find((e) => e.fileName === "fail-staging.png")
    assert.ok(stagingError, "staging failure should have fileName")
    assert.ok(stagingError.reason.includes("500") || stagingError.reason.includes("disk full"))
  })

  it("failed paths are cleaned up exactly once (no duplicates)", async () => {
    const cleanupCalls = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        const data = { path: `/staged/${Date.now()}-${Math.random()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        const path = JSON.parse(init.body).path
        cleanupCalls.push(path)
        const data = { ok: true }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        const data = {
          imported: 0,
          failed: 2,
          results: [
            { index: 0, ok: false, error: "error A" },
            { index: 1, ok: false, error: "error B" },
          ],
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [
      new globalThis.File(["a"], "a.png", { type: "image/png" }),
      new globalThis.File(["b"], "b.png", { type: "image/png" }),
    ]
    await runImport(files, {
      project: "default",
      isSupported: () => true,
    })

    // Each failed path should be cleaned up exactly once
    const uniquePaths = new Set(cleanupCalls)
    assert.equal(cleanupCalls.length, uniquePaths.size, "no duplicate cleanup calls")
    assert.equal(uniquePaths.size, 2, "both failed paths cleaned up")
  })

  it("unsupported files are skipped without staging or importing", async () => {
    const stagingCalls = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        stagingCalls.push(init.headers["x-mosa-file-name"])
        const data = { path: `/staged/${Date.now()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        const body = JSON.parse(init.body)
        const data = {
          imported: body.items.length,
          failed: 0,
          results: body.items.map((_, i) => ({ index: i, ok: true, asset: { id: `id-${i}` } })),
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [
      new globalThis.File(["a"], "a.png", { type: "image/png" }),
      new globalThis.File(["b"], "b.pdf", { type: "application/pdf" }),
      new globalThis.File(["c"], "c.txt", { type: "text/plain" }),
      new globalThis.File(["d"], "d.png", { type: "image/png" }),
    ]
    const result = await runImport(files, {
      project: "default",
      isSupported: (n) => n.endsWith(".png"),
    })

    assert.equal(result.skipped, 2, "2 unsupported files skipped")
    assert.equal(result.imported, 2, "2 supported files imported")
    assert.equal(stagingCalls.length, 2, "only supported files staged")
  })

  it("stackId is sent to server in request body", async () => {
    let capturedBody = null

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        const data = { path: `/staged/${Date.now()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        capturedBody = JSON.parse(init.body)
        const data = {
          imported: 1,
          failed: 0,
          results: [{ index: 0, ok: true, asset: { id: "asset-in-stack" } }],
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [new globalThis.File(["img"], "img.png", { type: "image/png" })]
    await runImport(files, {
      project: "default",
      stackId: "stack-123",
      isSupported: () => true,
    })

    assert.ok(capturedBody, "import-batch request body captured")
    assert.equal(capturedBody.stackId, "stack-123", "stackId must be in request body")
  })

  it("groupName calls setAssetsGroup only for successful ids", async () => {
    let groupCalls = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/assets/batch" && init?.method === "POST") {
        const body = JSON.parse(init.body)
        if (body.action === "group") {
          groupCalls.push(body)
          const data = { results: body.assetIds.map((id) => ({ id, ok: true })) }
          return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
        }
      }
      if (url === "/api/import/stage" && init?.method === "POST") {
        const data = { path: `/staged/${Date.now()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        const body = JSON.parse(init.body)
        const data = {
          imported: body.items.length,
          failed: 0,
          results: body.items.map((_, i) => ({ index: i, ok: true, asset: { id: `asset-${i}` } })),
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = [
      new globalThis.File(["a"], "a.png", { type: "image/png" }),
      new globalThis.File(["b"], "b.png", { type: "image/png" }),
      new globalThis.File(["c"], "c.png", { type: "image/png" }),
    ]
    const result = await runImport(files, {
      project: "default",
      groupName: "My Group",
      isSupported: () => true,
    })

    assert.equal(result.createdIds.length, 3)
    assert.ok(groupCalls.length > 0, "should call group endpoint")
    assert.equal(groupCalls[0].group, "My Group")
    assert.deepEqual(groupCalls[0].assetIds, result.createdIds)
  })

  it("AbortSignal stops new batches", async () => {
    let batchCount = 0
    const controller = new AbortController()

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        const data = { path: `/staged/${Date.now()}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/assets/import-batch") {
        batchCount++
        if (batchCount >= 1) controller.abort()
        const body = JSON.parse(init.body)
        const data = {
          imported: body.items.length,
          failed: 0,
          results: body.items.map((_, i) => ({ index: i, ok: true, asset: { id: `id-${batchCount}-${i}` } })),
        }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      const data = {}
      return { ok: false, status: 404, json: async () => data, text: async () => JSON.stringify(data) }
    }

    const files = Array.from({ length: 100 }, (_, i) => new globalThis.File([`img${i}`], `img${i}.png`, { type: "image/png" }))
    const result = await runImport(files, {
      project: "default",
      signal: controller.signal,
      isSupported: () => true,
    })

    assert.ok(batchCount <= 2, "should not send more batches after abort")
    assert.ok(result.imported < 100, "should not import all files")
  })

  it("cancelling while staging cleans up the batch and counts nothing as failed", async () => {
    const controller = new AbortController()
    let staged = 0
    let batches = 0
    const deleted = []

    globalThis.fetch = async (url, init) => {
      if (url === "/api/import/stage" && init?.method === "POST") {
        staged += 1
        if (staged === 6) controller.abort()
        const data = { path: `/staged/${staged}` }
        return { ok: true, json: async () => data, text: async () => JSON.stringify(data) }
      }
      if (url === "/api/import/stage" && init?.method === "DELETE") {
        deleted.push(JSON.parse(init.body).path)
        return { ok: true, json: async () => ({}), text: async () => "{}" }
      }
      if (url === "/api/assets/import-batch") batches += 1
      return { ok: false, status: 404, json: async () => ({}), text: async () => "{}" }
    }

    const files = Array.from({ length: 40 }, (_, i) => new globalThis.File([`img${i}`], `img${i}.png`, { type: "image/png" }))
    const result = await runImport(files, { project: "default", signal: controller.signal, isSupported: () => true })

    assert.equal(batches, 0, "no assets are created after cancelling")
    assert.equal(result.failed, 0)
    assert.equal(result.imported, 0)
    assert.equal(deleted.length, staged, "every staged file is cleaned up")
    assert.deepEqual([...deleted].sort(), Array.from({ length: staged }, (_, i) => `/staged/${i + 1}`).sort())
  })
})

// ─── Real server integration test ────────────────────────────────────────────

describe("runImport against real MOSA runtime", () => {
  let startMosaRuntime
  let runImport
  const originalFetch = globalThis.fetch

  before(async () => {
    const runtimePath = join(repositoryRoot, "lib", "mosa-runtime.mjs")
    const runtimeModule = await import(runtimePath)
    startMosaRuntime = runtimeModule.startMosaRuntime

    // Compile modules for runImport
    tempRoot = await mkdtemp(join(tmpdir(), "mosa-gp-import-e2e-"))
    
    // Create package.json to enable ESM module resolution
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ type: "module" }))
    
    globalThis.window = globalThis.window || {}
    globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    globalThis.sessionStorage = globalThis.sessionStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    globalThis.document = globalThis.document || { cookie: "" }
    globalThis.location = globalThis.location || { hash: "", pathname: "/", search: "" }
    globalThis.history = globalThis.history || { replaceState: () => {} }
    
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "mosa-api.ts"),
      join(uiRoot, "src", "collect-dropped-files.ts"),
      join(uiRoot, "src", "import-pipeline.ts"),
      "--outDir", tempRoot,
      "--module", "esnext",
      "--target", "es2022",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
    ], { stdio: "pipe" })
    
    const mod = await import(join(tempRoot, "import-pipeline.js"))
    runImport = mod.runImport
  })

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
  })

  it("imports 45 PNG files and creates assets", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-import-real-"))
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

    // Override fetch to use runtime URL
    globalThis.fetch = (url, init) => {
      const fullUrl = url.startsWith("/") ? `${runtime.url}${url}` : url
      const headers = { ...init?.headers, "x-mosa-client-token": runtime.clientToken }
      return originalFetch(fullUrl, { ...init, headers })
    }

    const { readFileSync } = await import("node:fs")
    const files = []
    for (let i = 0; i < 45; i++) {
      const filePath = join(generated, `img${i}.png`)
      const content = readFileSync(filePath)
      files.push(new globalThis.File([content], `img${i}.png`, { type: "image/png" }))
    }

    const result = await runImport(files, {
      project: "default",
      isSupported: () => true,
    })

    assert.equal(result.imported, 45, "should import all 45 files")
    assert.equal(result.failed, 0)
    assert.equal(result.createdIds.length, 45)

    // Verify in library
    const library = await originalFetch(`${runtime.url}/api/assets?project=default&limit=100`)
    const libraryData = await library.json()
    assert.equal(libraryData.assets.length, 45, "should have 45 assets in library")

    globalThis.fetch = originalFetch
  })

  it("imports with stackId and assets land in the stack", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "mosa-import-stack-real-"))
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

    const authHeaders = () => ({ "x-mosa-client-token": runtime.clientToken, "content-type": "application/json" })

    // Import first 2 files
    const { readFileSync } = await import("node:fs")
    const initialFiles = []
    for (let i = 0; i < 2; i++) {
      const filePath = join(generated, `img${i}.png`)
      const content = readFileSync(filePath)
      initialFiles.push(new globalThis.File([content], `base${i}.png`, { type: "image/png" }))
    }

    globalThis.fetch = (url, init) => {
      const fullUrl = url.startsWith("/") ? `${runtime.url}${url}` : url
      const headers = { ...init?.headers, "x-mosa-client-token": runtime.clientToken }
      return originalFetch(fullUrl, { ...init, headers })
    }

    const initialResult = await runImport(initialFiles, {
      project: "default",
      isSupported: () => true,
    })
    assert.equal(initialResult.imported, 2)

    // Create a stack
    const stackResponse = await originalFetch(`${runtime.url}/api/asset-stacks`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        projectId: "default",
        assetIds: initialResult.createdIds,
        coverAssetId: initialResult.createdIds[0],
      }),
    })
    assert.equal(stackResponse.status, 201)
    const { stack } = await stackResponse.json()

    // Import 5 more files into the stack
    const stackFiles = []
    for (let i = 2; i < 7; i++) {
      const filePath = join(generated, `img${i}.png`)
      const content = readFileSync(filePath)
      stackFiles.push(new globalThis.File([content], `stack-img${i}.png`, { type: "image/png" }))
    }

    const stackImportResult = await runImport(stackFiles, {
      project: "default",
      stackId: stack.id,
      isSupported: () => true,
    })
    assert.equal(stackImportResult.imported, 5)

    // Verify the new assets are in the stack
    const stackAssets = await originalFetch(
      `${runtime.url}/api/asset-stacks/${encodeURIComponent(stack.id)}/assets?project=default&limit=100`,
    )
    const stackAssetsData = await stackAssets.json()
    assert.equal(stackAssetsData.assets.length, 7, "stack should have 7 assets (2 initial + 5 new)")

    globalThis.fetch = originalFetch
  })
})

// ─── excludeLibraryFiles: a card dragged out and dropped back ────────────────

describe("excludeLibraryFiles", () => {
  let excludeLibraryFiles
  let root

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "mosa-gp-exclude-"))
    execFileSync(join(repositoryRoot, "node_modules", ".bin", "tsc"), [
      join(uiRoot, "src", "collect-dropped-files.ts"),
      "--outDir", root, "--module", "esnext", "--target", "es2022",
      "--moduleResolution", "bundler", "--skipLibCheck",
    ], { stdio: "pipe" })
    excludeLibraryFiles = (await import(join(root, "collect-dropped-files.js"))).excludeLibraryFiles
  })

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  const file = (name, bytes, lastModified) => new File([new Uint8Array(bytes)], name, { lastModified })

  it("drops scanned copies of library files and keeps the rest", () => {
    const dropped = file("web-chatgpt-1.png", 10, 1000)
    // Entry-scanned File objects are new instances with the same metadata.
    const scanned = [file("web-chatgpt-1.png", 10, 1000), file("new.png", 10, 1000)]
    const result = excludeLibraryFiles(scanned, [dropped])
    assert.equal(result.skipped, 1)
    assert.deepEqual(result.files.map((f) => f.name), ["new.png"])
  })

  it("does not treat a same-named file of a different size or time as a library file", () => {
    const library = [file("a.png", 10, 1000)]
    const result = excludeLibraryFiles([file("a.png", 11, 1000), file("a.png", 10, 2000)], library)
    assert.equal(result.skipped, 0)
    assert.equal(result.files.length, 2)
  })

  it("skips everything when every dropped file came from the library", () => {
    const library = [file("a.png", 3, 1), file("b.png", 4, 2)]
    const result = excludeLibraryFiles([file("a.png", 3, 1), file("b.png", 4, 2)], library)
    assert.equal(result.skipped, 2)
    assert.equal(result.files.length, 0)
  })

  it("is a no-op without library files", () => {
    const scanned = [file("a.png", 3, 1)]
    const result = excludeLibraryFiles(scanned, [])
    assert.equal(result.skipped, 0)
    assert.equal(result.files, scanned)
  })
})
