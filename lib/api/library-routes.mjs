import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizeAssetSort } from "../asset-sort.js";
import { normalizeAssetTimeRange } from "../asset-time-filter.mjs";
import { resolveAllowedFolderPath } from "../server-security.js";
import { galleryCollapsesStacks, gallerySearchFlattens } from "./gallery-stack-view.mjs";
import { requireArrayField, requireBooleanField, requireStringField } from "./request-fields.mjs";
import { readJson, sendJson } from "../http-response.mjs";

export function buildRevealSpawnPlan({ platform = process.platform, revealFile, isFile, resolvedPath }) {
  if (platform === "win32") {
    if (revealFile && isFile) {
      // Explorer requires the quote pair around the path portion specifically:
      //   /select,"C:\\path with spaces\\file.png"
      // With Node's default Windows argument quoting, a spaced path would turn
      // the entire argument into "/select,C:\\...", which Explorer silently
      // misparses and may fall back to Documents. Keep the exact Explorer
      // command-line grammar and disable Node's additional Windows escaping for
      // this already-quoted single argument. shell remains disabled by caller.
      return {
        command: "explorer.exe",
        args: [`/select,"${resolvedPath}"`],
        options: { windowsVerbatimArguments: true },
      };
    }
    return { command: "explorer.exe", args: [resolvedPath], options: {} };
  }
  if (platform === "darwin") {
    return {
      command: "open",
      args: revealFile && isFile ? ["-R", resolvedPath] : [resolvedPath],
      options: {},
    };
  }
  return {
    command: "xdg-open",
    args: [revealFile && isFile ? dirname(resolvedPath) : resolvedPath],
    options: {},
  };
}

export async function handleLibraryRoute({ req, res, url, context }) {
  const { store, grokSessionsDir, supportedMediaExtensions, libraryDir, libraryChangeStream } = context;

  if (req.method === "GET" && url.pathname === "/api/library-events") {
    if (!libraryChangeStream?.attach) {
      sendJson(res, 503, { error: "Library event stream unavailable" });
      return true;
    }
    await libraryChangeStream.attach(req, res, url.searchParams.get("project") || "default");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/projects") {
    sendJson(res, 200, { projects: await store.listProjects() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/navigation") {
    const projectId = url.searchParams.get("project") || "default";
    const navigation = typeof store.listNavigationStats === "function"
      ? await store.listNavigationStats(projectId)
      : await store.listGroups(projectId);
    sendJson(res, 200, { navigation });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/groups") {
    sendJson(res, 200, {
      groups: await store.listGroups(url.searchParams.get("project") || "default"),
    });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/library-revision") {
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, {
      revision: typeof store.libraryRevision === "function" ? await store.libraryRevision(projectId) : null,
    });
    return true;
  }

  // Authoritative revision-delta feed. Clients replay the journaled changes
  // between their applied baseline and the current revision; `complete: false`
  // means the requested baseline has already been pruned and only a full
  // reconciliation can recover the gap.
  if (req.method === "GET" && url.pathname === "/api/library-changes") {
    if (typeof store.listLibraryChangesSince !== "function") {
      sendJson(res, 503, { error: "Library change journal unavailable" });
      return true;
    }
    const projectId = url.searchParams.get("project") || "default";
    const since = Number.parseInt(url.searchParams.get("since") ?? "", 10);
    const delta = await store.listLibraryChangesSince(projectId, Number.isFinite(since) ? since : null);
    // revisionToken mirrors /api/library-revision so clients can keep a full
    // revision token as their baseline while using the integer counter as the
    // delta cursor.
    const revisionToken = typeof store.libraryRevision === "function" ? await store.libraryRevision(projectId) : null;
    sendJson(res, 200, { project: projectId, revisionToken, ...delta });
    return true;
  }

  // Incremental reconciliation fetch: view rows for a bounded set of affected
  // asset ids under the caller's current gallery request semantics. Bounded by
  // the affected id count, never by the library size.
  if (req.method === "POST" && url.pathname === "/api/gallery-rows") {
    if (typeof store.listGalleryRowsForAssets !== "function") {
      sendJson(res, 503, { error: "Gallery row reconciliation unavailable" });
      return true;
    }
    const body = await readJson(req);
    const assetIds = Array.isArray(body?.assetIds) ? body.assetIds.filter((assetId) => typeof assetId === "string" && assetId.trim()) : [];
    if (!assetIds.length) {
      sendJson(res, 400, { error: "assetIds must be a non-empty array" });
      return true;
    }
    if (assetIds.length > 1000) {
      sendJson(res, 413, { error: "Too many assetIds in one request; chunk the reconciliation." });
      return true;
    }
    const request = body?.request && typeof body.request === "object" ? body.request : {};
    const scope = String(request.scope || "all");
    const view = request.view;
    const query = String(request.query || "");
    // Reconciliation must re-evaluate rows under the exact list-endpoint
    // semantics, so time bounds go through the same normalizer the gallery
    // request itself used.
    const timeRange = normalizeAssetTimeRange({
      createdAfter: request.createdAfter,
      createdBefore: request.createdBefore,
    });
    const filters = {
      projectId: body?.projectId || body?.project || request.project || "default",
      query: String(request.query || ""),
      group: String(request.facets?.group || ""),
      category: String(request.facets?.category || ""),
      style: String(request.facets?.style || ""),
      source: String(request.facets?.source || ""),
      conversation: String(request.facets?.conversation || ""),
      generationBatch: String(request.facets?.generationBatch || ""),
      favorite: scope === "favorite",
      unorganized: scope === "unorganized",
      trash: scope === "trash",
      mediaKind: request.mediaKind === "img" || request.mediaKind === "video" ? request.mediaKind : "",
      sort: normalizeAssetSort(request.sort),
      stackId: request.stackId ? String(request.stackId) : undefined,
      collapseStacks: galleryCollapsesStacks({ view, scope, query }),
      // 搜索平铺时封面也不得渲染成堆叠节点；该参数经 listGalleryRowsForAssets
      // 的 filters 展开原样传入其平铺路径的 listAssetPage。
      stackCoverAnnotations: gallerySearchFlattens({ view, scope, query }) ? false : undefined,
      boundaryCursor: request.boundaryCursor ? String(request.boundaryCursor) : undefined,
      createdAfterMs: timeRange.createdAfterMs,
      createdBeforeMs: timeRange.createdBeforeMs,
    };
    const result = await store.listGalleryRowsForAssets(filters, assetIds);
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/groups") {
    const body = await readJson(req);
    // Task 314 ⑤: a wrongly-typed name ({"name":{}}) is a 400, not a store
    // TypeError. An absent name keeps falling through to the store's own
    // GROUP_NAME_REQUIRED contract.
    requireStringField(body, "name", { optional: true, maxLength: 200 });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 201, {
      group: await store.createGroup(body),
    });
    return true;
  }

  // Group ordering is a collection operation, not a pseudo group name. Keep
  // it on a non-colliding route so a real group called "order" remains fully
  // addressable through /api/groups/:name.
  if (req.method === "PATCH" && url.pathname === "/api/group-order") {
    if (typeof store.reorderGroups !== "function") {
      sendJson(res, 503, { error: "Group ordering is unavailable." });
      return true;
    }
    const body = await readJson(req);
    requireArrayField(body, "names", { of: "string", maxLength: 5000 });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, await store.reorderGroups(body.projectId || "default", body.names));
    return true;
  }

  const groupActionMatch = /^\/api\/groups\/([^/]+)\/(merge|stats)$/.exec(url.pathname);
  if (groupActionMatch && req.method === "POST" && groupActionMatch[2] === "merge") {
    if (typeof store.mergeGroups !== "function") {
      sendJson(res, 503, { error: "Group merging is unavailable." });
      return true;
    }
    const body = await readJson(req);
    requireStringField(body, "into", { maxLength: 200 });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    sendJson(res, 200, await store.mergeGroups(
      body.projectId || url.searchParams.get("project") || "default",
      decodeURIComponent(groupActionMatch[1]),
      body.into,
    ));
    return true;
  }
  if (groupActionMatch && req.method === "GET" && groupActionMatch[2] === "stats") {
    if (typeof store.getGroupStats !== "function") {
      sendJson(res, 503, { error: "Group statistics are unavailable." });
      return true;
    }
    sendJson(res, 200, {
      stats: await store.getGroupStats(url.searchParams.get("project") || "default", decodeURIComponent(groupActionMatch[1])),
    });
    return true;
  }

  const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(url.pathname);
  if (groupMatch && req.method === "PATCH") {
    const body = await readJson(req);
    // rename sends { name }, recolor sends { color }; either may be present,
    // but whichever arrives must be a string.
    requireStringField(body, "name", { optional: true, maxLength: 200 });
    requireStringField(body, "color", { optional: true, maxLength: 40 });
    requireStringField(body, "projectId", { optional: true, maxLength: 200 });
    const projectId = body.projectId || url.searchParams.get("project") || "default";
    const groupName = decodeURIComponent(groupMatch[1]);
    if (Object.hasOwn(body, "color") && !Object.hasOwn(body, "name") && typeof store.updateGroupSettings === "function") {
      sendJson(res, 200, {
        group: await store.updateGroupSettings(projectId, groupName, { color: body.color }),
      });
      return true;
    }
    sendJson(res, 200, {
      group: await store.renameGroup(projectId, groupName, body.name),
    });
    return true;
  }
  if (groupMatch && req.method === "DELETE") {
    const projectId = url.searchParams.get("project") || "default";
    const groupName = decodeURIComponent(groupMatch[1]);
    const deleteAssets = url.searchParams.get("deleteAssets") === "true";
    sendJson(res, 200, await store.deleteGroup(projectId, groupName, { deleteAssets }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/library-path") {
    const projectId = url.searchParams.get("project") || "default";
    sendJson(res, 200, {
      path: store.projectDir(projectId),
      codexGeneratedImagesDir: store.codexImagesDir,
      grokSessionsDir,
      storage: store.storageKind || "json",
      libraryDir: context.libraryDir,
      supportedMediaExtensions,
    });
    return true;
  }

  if (req.method !== "POST" || url.pathname !== "/api/open-folder") return false;

  const body = await readJson(req);
  // Task 314 ⑤: open-folder's inputs are a path (string) and a reveal flag
  // (boolean); wrong types are client bugs, answered with 400.
  requireStringField(body, "path", { maxLength: 4096 });
  requireBooleanField(body, "reveal", { optional: true });
  const projects = await store.listProjects();
  const allowedPaths = [
    libraryDir,
    store.managerDir,
    store.codexImagesDir,
    grokSessionsDir,
    ...projects.map((projectId) => store.projectDir(projectId)),
  ].filter(Boolean);

  // Support both file and folder paths
  const requestedPath = body.path;
  const revealFile = body.reveal === true; // If true, reveal the file in Finder

  const resolvedPath = resolveAllowedFolderPath(requestedPath, allowedPaths);

  if (!resolvedPath) {
    sendJson(res, 403, { error: "Path not allowed" });
    return true;
  }

  let pathStat;
  try {
    pathStat = await stat(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendJson(res, 404, { error: "Path does not exist" });
      return true;
    }
    throw error;
  }

  try {
    const { spawn } = await import("node:child_process");
    if (!pathStat.isDirectory() && !(revealFile && pathStat.isFile())) {
      sendJson(res, 400, { error: "Path is not a file or directory" });
      return true;
    }
    const plan = buildRevealSpawnPlan({
      platform: context.platform || process.platform,
      revealFile,
      isFile: pathStat.isFile(),
      resolvedPath,
    });
    const spawnImpl = context.spawnImpl || spawn;
    const child = spawnImpl(plan.command, plan.args, {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      ...plan.options,
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once("spawn", resolveSpawn);
      child.once("error", rejectSpawn);
    });
    child.unref();
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Failed to open library path:", error);
    sendJson(res, 500, { error: "Unable to open this location." });
  }
  return true;
}
