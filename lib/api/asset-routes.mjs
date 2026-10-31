import { normalizeAssetTimeRange } from "../asset-time-filter.mjs";
import { normalizeAssetSort } from "../asset-sort.js";
import { galleryCollapsesStacks, gallerySearchFlattens } from "./gallery-stack-view.mjs";
import { requireArrayField, requireStringField } from "./request-fields.mjs";
import { readJson, sendJson } from "../http-response.mjs";
import { createAssetViaGate } from "../library-ingest.mjs";
import { withUserEditMarkers } from "../user-edit-marker.mjs";
import {
  ImportStagingError,
  importStagingDir,
  isWithinStagingRoot,
  MAX_STREAMED_IMPORT_BYTES,
  removeStagedImport,
  stageReadableForImport,
} from "../import-staging.mjs";

const referencePruneStates = new WeakMap();
const MAX_BATCH_ASSET_IDS = 1000;
const MAX_STACK_MOVE_ASSET_IDS = 2000;

// Import-resolve requests run one at a time. Each action verifies live rows and
// then mutates; two overlapping requests (two import reviews auto-trashing a
// pixel-identical pair, each seeing the other as "the library copy") could
// otherwise both pass verification before either trash lands.
let importResolveTail = Promise.resolve();
function runImportResolveExclusively(task) {
  const run = importResolveTail.then(task, task);
  importResolveTail = run.catch(() => {});
  return run;
}
const MAX_IMPORT_BATCH_ITEMS = 250;
// Renderer poster frames are 400px-class JPEG/WebP from a canvas: well under
// 1 MB. 8 MB leaves room for odd encoders while still bounding the buffer the
// server holds in memory.
const MAX_VIDEO_POSTER_BYTES = 8 * 1024 * 1024;

function importTargetStackId(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Capability guards surface as 501 with the real message, mirroring the
// generation routes. A plain Error would be reclassified as an opaque 500 by
// the runtime's internal-error boundary on stores without the capability.
function requireStoreCapability(store, method, message, code) {
  if (typeof store?.[method] === "function") return;
  const error = new Error(message);
  error.statusCode = 501;
  error.code = code;
  error.expose = true;
  throw error;
}

function requireAssetStacks(store, methods) {
  for (const method of methods) {
    requireStoreCapability(store, method, "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
  }
}

async function assertImportTargetStack(store, projectId, stackId) {
  if (!stackId) return;
  requireAssetStacks(store, ["getAssetStack", "addAssetsToStack"]);
  await store.getAssetStack(projectId, stackId);
}

function importStagingRoots(store, context) {
  return [importStagingDir(store.assetsRoot), context?.importStagingRoot]
    .filter((root, index, roots) => root && roots.indexOf(root) === index);
}

async function cleanupImportedStagingPath(store, context, imagePath) {
  for (const stagingRoot of importStagingRoots(store, context)) {
    if (!isWithinStagingRoot(stagingRoot, imagePath)) continue;
    const result = await removeStagedImport(stagingRoot, imagePath);
    if (!result.ok && result.reason !== "no-op" && result.reason !== "already-removed") {
      console.warn(`[MOSA] import-staging cleanup: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
    }
    return result;
  }
  return { ok: true, reason: "outside-staging-root" };
}

function scheduleReferencePrune(store, webCaptureIngest, projectId) {
  if (!store || typeof webCaptureIngest?.pruneReferences !== "function") return;
  let state = referencePruneStates.get(store);
  if (!state) {
    state = { projects: new Set(), timer: null };
    referencePruneStates.set(store, state);
  }
  state.projects.add(projectId);
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const projects = [...state.projects];
    state.projects.clear();
    void Promise.all(projects.map(async (queuedProjectId) => {
      try {
        const referencedIds = typeof store.listReferencedAttachmentIds === "function"
          ? await store.listReferencedAttachmentIds(queuedProjectId)
          : await referencedAttachmentIds(store, queuedProjectId);
        await webCaptureIngest.pruneReferences(queuedProjectId, referencedIds);
      } catch (error) {
        if (/database connection is not open/i.test(String(error?.message || error))) return;
        console.warn(`[MOSA] reference attachment cleanup failed: ${error?.message || error}`);
      }
    }));
  }, 75);
  state.timer.unref?.();
}

function decodedUploadFileName(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(value).slice(0, 512);
  } catch {
    return "";
  }
}

function importStagingHttpError(error) {
  if (!(error instanceof ImportStagingError)) return null;
  if (error.code === "STAGING_FILE_TOO_LARGE") {
    return { status: 413, error: "Selected file is too large to import.", code: error.code };
  }
  if (error.code === "STAGING_UNSUPPORTED_TYPE") {
    return { status: 400, error: "Selected file type is not supported.", code: error.code };
  }
  if (error.code === "STAGING_FILE_EMPTY") {
    return { status: 400, error: "Selected file is empty.", code: error.code };
  }
  return { status: 400, error: "Selected file could not be prepared for import.", code: error.code };
}

async function readStableAssetSnapshot(store, projectId, loadPage) {
  if (typeof store.libraryRevision !== "function") return loadPage();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = String(await store.libraryRevision(projectId));
    const page = await loadPage();
    const after = String(await store.libraryRevision(projectId));
    if (before === after) return { ...page, revision: after };
  }
  return { ...(await loadPage()), revision: null };
}

export async function handleAssetRoute({ req, res, url, context }) {
  const { store, derivativeWorker, webCaptureIngest } = context;

  if (req.method === "POST" && url.pathname === "/api/import/stage") {
    const fileName = decodedUploadFileName(req.headers["x-mosa-file-name"]);
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_STREAMED_IMPORT_BYTES) {
      sendJson(res, 413, { error: "Selected file is too large to import.", code: "STAGING_FILE_TOO_LARGE" });
      return true;
    }
    try {
      const stagingRoot = importStagingDir(store.assetsRoot);
      const path = await stageReadableForImport({ readable: req, fileName, stagingRoot });
      sendJson(res, 201, { path });
    } catch (error) {
      const mapped = importStagingHttpError(error);
      if (!mapped) throw error;
      sendJson(res, mapped.status, { error: mapped.error, code: mapped.code });
    }
    return true;
  }

  // Cleanup orphaned staged file on import modal cancel (P1-2)
  if (req.method === "DELETE" && url.pathname === "/api/import/stage") {
    const body = await readJson(req);
    const stagedPath = body?.path;
    if (!stagedPath || typeof stagedPath !== "string") {
      sendJson(res, 400, { error: "Missing or invalid staged path." });
      return true;
    }
    try {
      const stagingRoot = importStagingDir(store.assetsRoot);
      // Clean up both roots: server staging and Electron staging if available
      const electronStagingRoot = context.importStagingRoot;
      const stagingRoots = electronStagingRoot && electronStagingRoot !== stagingRoot
        ? [stagingRoot, electronStagingRoot]
        : [stagingRoot];
      for (const root of stagingRoots) {
        if (isWithinStagingRoot(root, stagedPath)) {
          const result = await removeStagedImport(root, stagedPath);
          // Log non-fatal failures but don't fail the request
          if (!result.ok && result.reason !== "already-removed") {
            console.warn(`[MOSA] staged file cleanup failed for ${stagedPath}: ${result.reason}${result.error ? ` (${result.error})` : ""}`);
          }
        }
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, { error: "Failed to clean up staged file.", code: error?.code || "STAGING_CLEANUP_FAILED" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/import-batch") {
    const body = await readJson(req);
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length || items.length > MAX_IMPORT_BATCH_ITEMS) {
      sendJson(res, 400, {
        error: `Batch import requires 1-${MAX_IMPORT_BATCH_ITEMS} items.`,
        code: "IMPORT_BATCH_SIZE_INVALID",
      });
      return true;
    }
    const projectId = String(body?.projectId || "default");
    const stackId = importTargetStackId(body?.stackId);
    await assertImportTargetStack(store, projectId, stackId);
    const trustedSourceRoots = Array.isArray(context.trustedSourceRoots) ? context.trustedSourceRoots : [];
    const results = [];
    const importedAssetIds = [];
    let imported = 0;
    let failed = 0;
    let alreadyInLibrary = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const input = item && typeof item === "object" ? item : {};
      const imagePath = typeof input.imagePath === "string" ? input.imagePath : "";
      // Creation goes through the shared ingest gate (lib/library-ingest.mjs,
      // ARCHITECTURE.md §8); the manual-import channel opts into the
      // identical-bytes skip, whose outcome the gate translates for us.
      let created;
      try {
        created = await createAssetViaGate(store, { ...input, projectId }, { trustedSourceRoots, ingestMode: "manual", skipIdenticalBytes: true });
      } catch (error) {
        failed += 1;
        results.push({
          index,
          ok: false,
          code: typeof error?.code === "string" ? error.code : "IMPORT_FAILED",
          error: error?.message || "Import failed.",
        });
        continue;
      }
      if (created.ok) {
        results.push({ index, ok: true, asset: created.asset });
        importedAssetIds.push(created.asset.id);
        imported += 1;
        // Remove the staged upload only after the import succeeded. On failure
        // the staged bytes stay for a retry; the startup orphan sweep
        // (cleanupOrphanStagedFiles) reclaims them if the client never does.
        if (imagePath) await cleanupImportedStagingPath(store, context, imagePath);
        continue;
      }
      // Task 291: identical bytes the library already holds (outside Trash)
      // are skipped, not failed — the route reports where the existing copy
      // lives so the import review can offer to move it into the target.
      if (created.skipped.reason === "already-in-library") {
        results.push({ index, ok: true, skipped: "already-in-library", existingAsset: created.skipped.existingAsset });
        alreadyInLibrary += 1;
        if (imagePath) await cleanupImportedStagingPath(store, context, imagePath);
        continue;
      }
      failed += 1;
      results.push({
        index,
        ok: false,
        code: "IMPORT_FAILED",
        error: `Unexpected ingest outcome: ${created.skipped.reason}.`,
      });
    }
    if (stackId && importedAssetIds.length) {
      await store.addAssetsToStack(projectId, stackId, importedAssetIds);
    }
    if (imported) derivativeWorker.wake();
    sendJson(res, 200, {
      imported,
      failed,
      alreadyInLibrary,
      results,
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/import/similar-check") {
    requireStoreCapability(store, "similarCheckState", "Import dedupe is unavailable.", "IMPORT_DEDUPE_UNAVAILABLE");
    const body = await readJson(req);
    const projectId = String(body?.projectId || "default");
    const assetIds = Array.isArray(body?.assetIds)
      ? body.assetIds.filter((assetId) => typeof assetId === "string" && assetId.trim())
      : [];
    if (assetIds.length > MAX_BATCH_ASSET_IDS) {
      sendJson(res, 413, {
        error: `assetIds exceeds the ${MAX_BATCH_ASSET_IDS}-asset batch limit`,
        code: "ASSET_BATCH_TOO_LARGE",
      });
      return true;
    }
    // Read-only on purpose: the import review polls this until pending drains,
    // then acts through /api/import/resolve.
    sendJson(res, 200, await store.similarCheckState(projectId, assetIds));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/import/resolve") {
    requireStoreCapability(store, "replaceAssetMedia", "Import dedupe is unavailable.", "IMPORT_DEDUPE_UNAVAILABLE");
    const body = await readJson(req);
    const projectId = String(body?.projectId || "default");
    const actions = Array.isArray(body?.actions) ? body.actions : [];
    if (actions.length > MAX_BATCH_ASSET_IDS) {
      sendJson(res, 413, {
        error: `actions exceeds the ${MAX_BATCH_ASSET_IDS}-action batch limit`,
        code: "ASSET_BATCH_TOO_LARGE",
      });
      return true;
    }
    const results = await runImportResolveExclusively(async () => {
    const results = [];
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index] && typeof actions[index] === "object" ? actions[index] : {};
      const kind = String(action.kind || "");
      try {
        if (kind === "trash-new" || kind === "replace-with-new") {
          // The review UI is not authority: every mutation re-verifies against
          // live rows first, so a stale prompt (the pair already trashed
          // elsewhere, a "sharper" image that is smaller) is rejected with a
          // code and nothing moves (task 291 rework §6).
          const verdict = await store.verifyImportResolve(projectId, action);
          if (!verdict.ok) {
            results.push({ index, ok: false, kind, code: verdict.code, error: "Import resolve action rejected by server-side verification." });
            continue;
          }
          if (kind === "trash-new") {
            // Both the user-confirmed duplicates and the auto-trashed
            // pixel-identical copies land here; only the trash reason differs.
            const reason = action.reason === "duplicate-import:identical" ? "duplicate-import:identical" : "duplicate-import:user";
            await store.deleteAsset(projectId, String(action.newAssetId), { reason });
            results.push({ index, ok: true, kind });
          } else {
            // Task 280 discipline: the existing asset keeps its curation and
            // gains the new pixels; its previous media moves to Trash as a
            // snapshot (replaceAssetMedia copies), and the freshly imported row
            // — whose bytes were copied, not moved — goes to Trash as well.
            const newAssetId = String(action.newAssetId);
            const existingAssetId = String(action.existingAssetId);
            const newAsset = await store.getAsset(projectId, newAssetId);
            const pixelDigest = await store.cachedPerceptualPixelDigest(projectId, newAssetId).catch(() => "");
            await store.replaceAssetMedia(projectId, existingAssetId, {
              imagePath: newAsset.image_path,
              content_sha256: newAsset.content_sha256,
              ...(pixelDigest ? { pixel_sha256: pixelDigest } : {}),
            });
            await store.deleteAsset(projectId, newAssetId, { reason: "duplicate-import:user" });
            results.push({ index, ok: true, kind });
          }
        } else if (kind === "keep") {
          results.push({ index, ok: true, kind });
        } else {
          results.push({ index, ok: false, kind, code: "IMPORT_RESOLVE_UNKNOWN_ACTION", error: `Unknown import resolve action: ${kind}` });
        }
      } catch (error) {
        results.push({
          index,
          ok: false,
          kind,
          code: typeof error?.code === "string" ? error.code : "IMPORT_RESOLVE_FAILED",
          error: error?.message || "Import resolve failed.",
        });
      }
    }
    return results;
    });
    derivativeWorker?.wake?.();
    sendJson(res, results.some((result) => !result.ok) ? 207 : 200, { results });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/asset-stacks") {
    requireStoreCapability(store, "createAssetStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const body = await readJson(req);
    requireArrayField(body, "assetIds", { of: "string", maxLength: MAX_STACK_MOVE_ASSET_IDS });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    const stack = await store.createAssetStack(body.projectId || "default", body.assetIds, { coverAssetId: body.coverAssetId });
    sendJson(res, 201, { stack });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/asset-stacks/move") {
    requireStoreCapability(store, "moveAssetsToStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const body = await readJson(req);
    const assetIds = Array.isArray(body?.assetIds) ? body.assetIds : [];
    if (!assetIds.length || assetIds.length > MAX_STACK_MOVE_ASSET_IDS) {
      sendJson(res, 400, {
        error: `assetIds must contain 1-${MAX_STACK_MOVE_ASSET_IDS} assets.`,
        code: "STACK_MOVE_BATCH_SIZE_INVALID",
      });
      return true;
    }
    const targetStackId = body?.targetStackId == null ? null : String(body.targetStackId);
    sendJson(res, 200, await store.moveAssetsToStack(String(body?.project || "default"), assetIds, targetStackId));
    return true;
  }

  const stackAssetsMatch = /^\/api\/asset-stacks\/([^/]+)\/assets$/.exec(url.pathname);
  const stackOrderMatch = /^\/api\/asset-stacks\/([^/]+)\/order$/.exec(url.pathname);
  const stackGroupMatch = /^\/api\/asset-stacks\/([^/]+)\/group$/.exec(url.pathname);
  const stackMatch = /^\/api\/asset-stacks\/([^/]+)$/.exec(url.pathname);
  if (stackAssetsMatch && req.method === "GET") {
    requireStoreCapability(store, "listAssetStackAssets", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const requestedLimit = Number(url.searchParams.get("limit"));
    const apiLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 250)
      : 100;
    const filters = {
      query: url.searchParams.get("q") || "",
      group: url.searchParams.get("group") || "",
      category: url.searchParams.get("category") || "",
      style: url.searchParams.get("style") || "",
      source: url.searchParams.get("source") || "",
      conversation: url.searchParams.get("conversation") || "",
      generationBatch: url.searchParams.get("generationBatch") || "",
      favorite: url.searchParams.get("favorite") === "1",
      recent: url.searchParams.get("recent") === "1",
      unorganized: url.searchParams.get("unorganized") === "1",
      mediaKind: url.searchParams.get("mediaKind") === "img" || url.searchParams.get("mediaKind") === "video" ? url.searchParams.get("mediaKind") : "",
      sort: url.searchParams.get("sort") || "manual",
      limit: apiLimit,
      cursor: url.searchParams.get("cursor") || undefined,
      includeTotal: url.searchParams.get("includeTotal") !== "0",
    };
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, await readStableAssetSnapshot(
      store,
      projectId,
      () => store.listAssetStackAssets(projectId, stackId, filters),
    ));
    return true;
  }
  if (stackAssetsMatch && req.method === "POST") {
    requireStoreCapability(store, "addAssetsToStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const body = await readJson(req);
    requireArrayField(body, "assetIds", { of: "string", maxLength: MAX_STACK_MOVE_ASSET_IDS });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, { stack: await store.addAssetsToStack(body.projectId || "default", stackId, body.assetIds) });
    return true;
  }
  if (stackAssetsMatch && req.method === "DELETE") {
    requireStoreCapability(store, "removeAssetsFromStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const stackId = decodeURIComponent(stackAssetsMatch[1]);
    const body = await readJson(req);
    requireArrayField(body, "assetIds", { of: "string", maxLength: MAX_STACK_MOVE_ASSET_IDS });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, await store.removeAssetsFromStack(body.projectId || "default", stackId, body.assetIds));
    return true;
  }
  if (stackOrderMatch && req.method === "PATCH") {
    requireStoreCapability(store, "reorderAssetStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const stackId = decodeURIComponent(stackOrderMatch[1]);
    const body = await readJson(req);
    requireArrayField(body, "assetIds", { of: "string", maxLength: MAX_STACK_MOVE_ASSET_IDS });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, { stack: await store.reorderAssetStack(body.projectId || "default", stackId, body.assetIds) });
    return true;
  }
  if (stackGroupMatch && req.method === "POST") {
    requireStoreCapability(store, "assignAssetStackToGroup", "Asset stack grouping is unavailable.", "ASSET_STACK_GROUPING_UNAVAILABLE");
    const body = await readJson(req);
    if (body.group != null && typeof body.group !== "string") {
      sendJson(res, 400, { error: "group must be a string" });
      return true;
    }
    const stackId = decodeURIComponent(stackGroupMatch[1]);
    sendJson(res, 200, {
      stack: await store.assignAssetStackToGroup(
        body.projectId || "default",
        stackId,
        String(body.group || ""),
      ),
    });
    return true;
  }
  if (stackMatch && req.method === "GET") {
    requireStoreCapability(store, "getAssetStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    sendJson(res, 200, { stack: await store.getAssetStack(url.searchParams.get("project") || "default", decodeURIComponent(stackMatch[1])) });
    return true;
  }
  if (stackMatch && req.method === "PATCH") {
    requireStoreCapability(store, "renameAssetStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const body = await readJson(req);
    requireStringField(body, "name", { maxLength: 200 });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, { stack: await store.renameAssetStack(body.projectId || "default", decodeURIComponent(stackMatch[1]), body.name) });
    return true;
  }
  if (stackMatch && req.method === "DELETE") {
    requireStoreCapability(store, "dissolveAssetStack", "Asset stacks are unavailable.", "ASSET_STACKS_UNAVAILABLE");
    const body = await readJson(req);
    sendJson(res, 200, await store.dissolveAssetStack(body.projectId || "default", decodeURIComponent(stackMatch[1])));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/assets") {
    const requestedLimit = Number(url.searchParams.get("limit"));
    const apiLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 250)
      : 100;
    const timeRange = normalizeAssetTimeRange({
      createdAfter: url.searchParams.get("createdAfter"),
      createdBefore: url.searchParams.get("createdBefore"),
    });
    const view = url.searchParams.get("view");
    const scope = url.searchParams.get("trash") === "1" ? "trash" : "all";
    const query = url.searchParams.get("q") || "";
    const filters = {
      projectId: url.searchParams.get("project") || "default",
      query: url.searchParams.get("q") || "",
      group: url.searchParams.get("group") || "",
      category: url.searchParams.get("category") || "",
      style: url.searchParams.get("style") || "",
      source: url.searchParams.get("source") || "",
      conversation: url.searchParams.get("conversation") || "",
      generationBatch: url.searchParams.get("generationBatch") || "",
      favorite: url.searchParams.get("favorite") === "1",
      recent: url.searchParams.get("recent") === "1",
      unorganized: url.searchParams.get("unorganized") === "1",
      trash: url.searchParams.get("trash") === "1",
      mediaKind: url.searchParams.get("mediaKind") === "img" || url.searchParams.get("mediaKind") === "video" ? url.searchParams.get("mediaKind") : "",
      sort: normalizeAssetSort(url.searchParams.get("sort")),
      limit: apiLimit,
      cursor: url.searchParams.get("cursor") || undefined,
      collapseStacks: galleryCollapsesStacks({ view, scope, query }),
      // 搜索平铺时封面也不得渲染成堆叠节点：让 store 跳过封面注解。
      stackCoverAnnotations: gallerySearchFlattens({ view, scope, query }) ? false : undefined,
      includeTotal: url.searchParams.get("includeTotal") !== "0",
      createdAfterMs: timeRange.createdAfterMs,
      createdBeforeMs: timeRange.createdBeforeMs,
    };
    const page = await readStableAssetSnapshot(store, filters.projectId, () => (
      typeof store.listAssetPage === "function"
        ? store.listAssetPage(filters)
        : store.listAssets(filters).then((assets) => ({ assets, page: { total: 0, nextCursor: null } }))
    ));
    sendJson(res, 200, page);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/assets/create") {
    const requestBody = await readJson(req);
    const projectId = String(requestBody?.projectId || "default");
    const stackId = importTargetStackId(requestBody?.stackId);
    await assertImportTargetStack(store, projectId, stackId);
    const body = { ...(requestBody || {}) };
    delete body.stackId;
    // BUG-01 fix: the desktop shell's import staging root is trusted for
    // creation via the runtime context; Web/server runs pass an empty array.
    const trustedSourceRoots = Array.isArray(context.trustedSourceRoots) ? context.trustedSourceRoots : [];
    // No identical-bytes skip here (task 291): the app's imports all go
    // through import-batch, and this single-create API keeps its contract of
    // always answering with a new { asset } — scripts and tests seed the same
    // file several times on purpose, like MCP's asset_create. The shared
    // ingest gate (lib/library-ingest.mjs) handles creation; without the skip
    // opt-in it always builds a new asset.
    const created = await createAssetViaGate(store, body, { trustedSourceRoots, ingestMode: "manual" });
    const asset = created.asset;
    try {
      if (stackId) await store.addAssetsToStack(projectId, stackId, [asset.id]);
      sendJson(res, 200, { asset });
      derivativeWorker.wake();
    } finally {
      // The store has copied the bytes into the library, so either staging flavor
      // can be removed now. Browser uploads are staged below assetsRoot (already a
      // trusted store root); Electron may also provide its explicit staging root.
      // Only a path proven to be inside a staging root is ever considered.
      void cleanupImportedStagingPath(store, context, body.imagePath);
    }
    return true;
  }

  const assetMatch = /^\/api\/assets\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  const archiveMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/archive$/.exec(url.pathname);
  if (archiveMatch && req.method === "POST") {
    requireStoreCapability(store, "archiveAsset", "Asset archival is unavailable.", "ASSET_ARCHIVAL_UNAVAILABLE");
    sendJson(res, 200, { asset: await store.archiveAsset(decodeURIComponent(archiveMatch[1]), decodeURIComponent(archiveMatch[2])) });
    return true;
  }

  const duplicateMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/duplicate$/.exec(url.pathname);
  if (duplicateMatch && req.method === "POST") {
    requireStoreCapability(store, "duplicateAsset", "Asset duplication is unavailable.", "ASSET_DUPLICATION_UNAVAILABLE");
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.duplicateAsset(decodeURIComponent(duplicateMatch[1]), decodeURIComponent(duplicateMatch[2]), body) });
    derivativeWorker.wake();
    return true;
  }

  const versionsMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/versions$/.exec(url.pathname);
  if (versionsMatch && req.method === "GET") {
    requireStoreCapability(store, "getAssetVersionHistory", "Asset version history is unavailable.", "ASSET_VERSION_HISTORY_UNAVAILABLE");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    sendJson(res, 200, { history: await store.getAssetVersionHistory(projectId, assetId) });
    return true;
  }
  if (versionsMatch && req.method === "POST") {
    requireStoreCapability(store, "createAssetVersion", "Asset version creation is unavailable.", "ASSET_VERSION_CREATE_UNAVAILABLE");
    const projectId = decodeURIComponent(versionsMatch[1]);
    const assetId = decodeURIComponent(versionsMatch[2]);
    const body = await readJson(req);
    sendJson(res, 201, { asset: await store.createAssetVersion(projectId, assetId, body) });
    derivativeWorker.wake();
    return true;
  }

  const recipesMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/recipes$/.exec(url.pathname);
  if (recipesMatch && req.method === "GET") {
    requireStoreCapability(store, "getRecipeSnapshotHistory", "Recipe snapshot history is unavailable.", "ASSET_RECIPE_HISTORY_UNAVAILABLE");
    const projectId = decodeURIComponent(recipesMatch[1]);
    const assetId = decodeURIComponent(recipesMatch[2]);
    sendJson(res, 200, { history: await store.getRecipeSnapshotHistory(projectId, assetId) });
    return true;
  }

  const curationMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/curation$/.exec(url.pathname);
  if (curationMatch && req.method === "PATCH") {
    requireStoreCapability(store, "updateCuration", "Asset curation is unavailable.", "ASSET_CURATION_UNAVAILABLE");
    const body = await readJson(req);
    sendJson(res, 200, { asset: await store.updateCuration(decodeURIComponent(curationMatch[1]), decodeURIComponent(curationMatch[2]), body) });
    return true;
  }

  // Video poster upload (task 248). Only the Electron renderer can decode
  // video, so it extracts the frame and posts the encoded image here; the
  // store validates + re-encodes it to the thumbnail tier. Raw-body upload,
  // same shape as import staging. Mutation auth (client token + same-origin)
  // is enforced by the runtime for every non-GET /api/ route.
  const posterMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/poster$/.exec(url.pathname);
  if (posterMatch && req.method === "POST") {
    requireStoreCapability(store, "saveVideoPoster", "Video poster upload is unavailable.", "VIDEO_POSTER_UNAVAILABLE");
    const contentType = String(req.headers["content-type"] || "");
    if (!/^image\/(jpeg|png|webp)\b/i.test(contentType)) {
      sendJson(res, 400, { error: "Video poster must be an image/jpeg, image/png or image/webp upload.", code: "VIDEO_POSTER_BAD_TYPE" });
      return true;
    }
    const contentLength = Number(req.headers["content-length"] || 0);
    if (contentLength > MAX_VIDEO_POSTER_BYTES) {
      sendJson(res, 413, { error: "Video poster upload is too large.", code: "VIDEO_POSTER_TOO_LARGE" });
      return true;
    }
    const chunks = [];
    let received = 0;
    let overflow = false;
    for await (const chunk of req) {
      received += chunk.length;
      if (received > MAX_VIDEO_POSTER_BYTES) {
        overflow = true;
        continue; // drain the rest so the response is never cut mid-body
      }
      chunks.push(chunk);
    }
    if (overflow) {
      sendJson(res, 413, { error: "Video poster upload is too large.", code: "VIDEO_POSTER_TOO_LARGE" });
      return true;
    }
    const asset = await store.saveVideoPoster(
      decodeURIComponent(posterMatch[1]),
      decodeURIComponent(posterMatch[2]),
      Buffer.concat(chunks),
    );
    sendJson(res, 201, { asset });
    return true;
  }

  if (assetMatch && req.method === "GET") {
    const projectId = decodeURIComponent(assetMatch[1]);
    const assetId = decodeURIComponent(assetMatch[2]);
    // Stores that track dominant colors backfill them on first open; older or
    // JSON stores without the capability answer exactly as before.
    const asset = typeof store.ensureAssetPalette === "function"
      ? await store.ensureAssetPalette(projectId, assetId)
      : await store.getAsset(projectId, assetId);
    sendJson(res, 200, { asset });
    return true;
  }

  if (assetMatch && req.method === "PATCH") {
    const projectId = decodeURIComponent(assetMatch[1]);
    const assetId = decodeURIComponent(assetMatch[2]);
    const body = await readJson(req);
    // Task 314 ⑤: the human-edit fields are strings / a string array; a
    // wrongly-typed field is a client bug (400), not a store TypeError.
    // `references` (array of recipe objects) and any other keys stay
    // unvalidated here — their shape is owned by the store.
    requireStringField(body, "prompt", { optional: true, maxLength: 100_000 });
    requireStringField(body, "name", { optional: true, maxLength: 512 });
    requireArrayField(body, "tags", { optional: true, of: "string", maxLength: 200 });
    // Human entry point: stamp user-edit markers so automatic prompt/theme
    // writers never overwrite what was typed here.
    const current = await store.getAsset(projectId, assetId);
    sendJson(res, 200, { asset: await store.updateMetadata(projectId, assetId, withUserEditMarkers(current, body)) });
    return true;
  }

  if (assetMatch && req.method === "DELETE") {
    requireStoreCapability(store, "deleteAsset", "Asset deletion is unavailable.", "ASSET_DELETE_UNAVAILABLE");
    const projectId = decodeURIComponent(assetMatch[1]);
    const assetId = decodeURIComponent(assetMatch[2]);
    const result = await store.deleteAsset(projectId, assetId);
    sendJson(res, 200, { result });
    return true;
  }

  const restoreMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/restore$/.exec(url.pathname);
  if (restoreMatch && req.method === "POST") {
    requireStoreCapability(store, "restoreAsset", "Trash restore is unavailable.", "ASSET_TRASH_RESTORE_UNAVAILABLE");
    const projectId = decodeURIComponent(restoreMatch[1]);
    const assetId = decodeURIComponent(restoreMatch[2]);
    const asset = await store.restoreAsset(projectId, assetId);
    derivativeWorker?.wake?.();
    sendJson(res, 200, { asset });
    return true;
  }

  const permanentMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/permanent$/.exec(url.pathname);
  if (permanentMatch && req.method === "DELETE") {
    requireStoreCapability(store, "permanentlyDeleteAsset", "Permanent deletion is unavailable.", "ASSET_PERMANENT_DELETE_UNAVAILABLE");
    const projectId = decodeURIComponent(permanentMatch[1]);
    const assetId = decodeURIComponent(permanentMatch[2]);
    const result = await store.permanentlyDeleteAsset(projectId, assetId);
    scheduleReferencePrune(store, webCaptureIngest, projectId);
    sendJson(res, 200, { result });
    return true;
  }

  if (req.method === "DELETE" && url.pathname === "/api/trash") {
    requireStoreCapability(store, "emptyTrash", "Empty Trash is unavailable.", "ASSET_EMPTY_TRASH_UNAVAILABLE");
    const body = await readJson(req);
    const projectId = body?.projectId || "default";
    const result = await store.emptyTrash(projectId);
    if (result.removed && typeof webCaptureIngest?.pruneReferences === "function") {
      try {
        const referencedIds = typeof store.listReferencedAttachmentIds === "function"
          ? await store.listReferencedAttachmentIds(projectId)
          : await referencedAttachmentIds(store, projectId);
        await webCaptureIngest.pruneReferences(projectId, referencedIds);
      } catch (error) {
        console.warn(`[MOSA] reference attachment cleanup failed: ${error?.message || error}`);
      }
    }
    sendJson(res, 200, result);
    return true;
  }

  const favoriteMatch = /^\/api\/assets\/([^/]+)\/([^/]+)\/favorite$/.exec(url.pathname);
  if (favoriteMatch && req.method === "POST") {
    requireStoreCapability(store, "toggleFavorite", "Favorite toggling is unavailable.", "ASSET_FAVORITE_UNAVAILABLE");
    const projectId = decodeURIComponent(favoriteMatch[1]);
    const assetId = decodeURIComponent(favoriteMatch[2]);
    const updated = await store.toggleFavorite(projectId, assetId);
    sendJson(res, 200, { asset: updated });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/api/assets/batch") return false;

  const body = await readJson(req);
  const { action, assetIds } = body;
  if (!["favorite", "archive", "trash", "group", "curate"].includes(action)) {
    sendJson(res, 400, { error: `Unknown batch action: ${action}` });
    return true;
  }
  if (!Array.isArray(assetIds) || !assetIds.length || assetIds.some((assetId) => typeof assetId !== "string" || !assetId.trim())) {
    sendJson(res, 400, { error: "assetIds must be a non-empty array" });
    return true;
  }
  if (assetIds.length > MAX_BATCH_ASSET_IDS) {
    sendJson(res, 413, {
      error: `assetIds exceeds the ${MAX_BATCH_ASSET_IDS}-asset batch limit`,
      code: "ASSET_BATCH_TOO_LARGE",
    });
    return true;
  }
  if (action === "group" && body.group != null && typeof body.group !== "string") {
    sendJson(res, 400, { error: "group must be a string" });
    return true;
  }
  const projectId = body.projectId || "default";
  const uniqueAssetIds = [...new Set(assetIds)];
  const groupValue = action === "group" ? String(body.group || "") : "";
  // Resolve every asset before mutating one, so a malformed selection cannot
  // report a complete-looking batch after only its first few rows changed.
  // Only Favorite and Trash need the current rows. Group/archive can mutate by
  // ID directly, which keeps large Select All operations from doing thousands
  // of redundant point reads before the first write.
  const currentAssets = action === "favorite" || action === "trash"
    ? await Promise.all(uniqueAssetIds.map((assetId) => store.getAsset(projectId, assetId)))
    : [];
  const favoriteValue = action === "favorite" && typeof body.favorite === "boolean" ? body.favorite : true;

  if (action === "group" && typeof store.assignAssetsToGroup === "function") {
    // One transactional membership rewrite instead of N full-row metadata
    // rewrites: a Select All move stays proportional to the selection.
    const assigned = await store.assignAssetsToGroup(projectId, uniqueAssetIds, groupValue);
    const results = assigned.results.map((entry) => (
      entry.ok === false ? entry : { id: entry.id, group: entry.group }
    ));
    sendJson(res, assigned.partial ? 207 : 200, { results, partial: Boolean(assigned.partial) });
    return true;
  }

  if (action === "curate") {
    // "标为已整理" (task 304): one transaction writes the curated flag only.
    // The flag defaults to true; an undo sends curated: false.
    const curated = body.curated == null ? true : body.curated;
    if (typeof curated !== "boolean") {
      sendJson(res, 400, { error: "curated must be a boolean" });
      return true;
    }
    const marked = await store.setAssetsCurated(projectId, uniqueAssetIds, curated);
    sendJson(res, marked.partial ? 207 : 200, { results: marked.results, partial: marked.partial });
    return true;
  }

  if (action === "trash") {
    // Versions must enter Trash from leaves toward their parents. Within each
    // independent depth we use bounded concurrency: one HTTP mutation stays
    // fast for large selections without creating an unbounded burst of file
    // hashing/I/O, and a parent is never checked while its selected child is
    // still active.
    const assetsById = new Map(currentAssets.map((asset) => [asset.id, asset]));
    const selectedIds = new Set(uniqueAssetIds);
    const depthCache = new Map();
    const depthOf = (assetId, visiting = new Set()) => {
      if (depthCache.has(assetId)) return depthCache.get(assetId);
      if (visiting.has(assetId)) return 0;
      const parentId = assetsById.get(assetId)?.parent_asset_id;
      if (!parentId || !selectedIds.has(parentId)) {
        depthCache.set(assetId, 0);
        return 0;
      }
      const nextVisiting = new Set(visiting);
      nextVisiting.add(assetId);
      const depth = depthOf(parentId, nextVisiting) + 1;
      depthCache.set(assetId, depth);
      return depth;
    };
    const idsByDepth = new Map();
    for (const assetId of uniqueAssetIds) {
      const depth = depthOf(assetId);
      if (!idsByDepth.has(depth)) idsByDepth.set(depth, []);
      idsByDepth.get(depth).push(assetId);
    }

    const resultById = new Map();
    let failures = 0;
    for (const depth of [...idsByDepth.keys()].sort((a, b) => b - a)) {
      const idsAtDepth = idsByDepth.get(depth);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < idsAtDepth.length) {
          const assetId = idsAtDepth[nextIndex];
          nextIndex += 1;
          try {
            const deleted = await store.deleteAsset(projectId, assetId);
            resultById.set(assetId, { id: assetId, trashed: true, deleted_at: deleted?.deleted_at || null });
          } catch (error) {
            failures += 1;
            resultById.set(assetId, { id: assetId, ok: false, code: error?.code || "BATCH_ITEM_FAILED", error: error instanceof Error ? error.message : String(error) });
          }
        }
      };
      const workerCount = Math.min(6, idsAtDepth.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    }
    const results = uniqueAssetIds.map((assetId) => resultById.get(assetId));
    sendJson(res, failures ? 207 : 200, { results, partial: failures > 0 });
    return true;
  }

  const results = [];
  let failures = 0;
  for (let index = 0; index < uniqueAssetIds.length; index += 1) {
    const assetId = uniqueAssetIds[index];
    try {
      if (action === "favorite") {
        const current = currentAssets[index];
        const updated = Boolean(current.favorite) === favoriteValue
          ? current
          : await store.toggleFavorite(projectId, assetId);
        results.push({ id: assetId, favorite: Boolean(updated.favorite) });
      } else if (action === "archive") {
        await store.archiveAsset(projectId, assetId);
        results.push({ id: assetId, archived: true });
      } else {
        await store.updateMetadata(projectId, assetId, { group: groupValue });
        results.push({ id: assetId, group: groupValue });
      }
    } catch (error) {
      failures += 1;
      results.push({ id: assetId, ok: false, code: error?.code || "BATCH_ITEM_FAILED", error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (action === "archive") derivativeWorker.wake();
  sendJson(res, failures ? 207 : 200, { results, partial: failures > 0 });
  return true;
}

async function referencedAttachmentIds(store, projectId) {
  const [active, archived, events] = await Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }),
    typeof store.listGenerationEvents === "function" ? store.listGenerationEvents(projectId) : Promise.resolve([]),
  ]);
  const ids = new Set();
  for (const owner of [...active, ...archived, ...events]) {
    for (const reference of Array.isArray(owner?.references) ? owner.references : []) {
      const id = String(reference?.reference_id || reference?.asset_id || "").trim();
      if (id) ids.add(id);
    }
  }
  return ids;
}
