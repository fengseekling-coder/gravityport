/**
 * Library-level actions: trash management and asset-stack operations.
 *
 * All requests go through mosa-api.ts (requestJson / BatchOutcome / moveAssetsToTrash).
 * Error codes thrown by the server (e.g. ASSET_STACKS_UNAVAILABLE) are preserved
 * on the thrown Error via requestJson and are never swallowed.
 *
 * API contract is derived from lib/api/asset-routes.mjs:
 *   · /api/asset-stacks/move        — body uses `project`
 *   · every other stack endpoint    — body uses `projectId`
 *   · /api/assets/{project}/{id}/restore  — project is in the URL path, no body
 *   · /api/assets/{project}/{id}/permanent — project is in the URL path, no body
 *   · /api/trash                   — body uses `projectId`
 */

import {
  requestJson,
  moveAssetsToTrash,
  type BatchOutcome,
} from "./mosa-api.js";

const e = encodeURIComponent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a BatchOutcome from a list of ids and a per-item error map. */
function buildOutcome(total: number, ids: string[], itemErrors: Map<string, string>): BatchOutcome {
  const failedIds = [...itemErrors.keys()];
  return {
    total,
    succeeded: total - failedIds.length,
    failed: failedIds.length,
    failedIds,
    firstError: failedIds.length > 0 ? itemErrors.get(failedIds[0]) ?? "" : "",
  };
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

/**
 * Restore one or more assets from the trash.
 * Each asset is restored independently; one failure does not block the rest.
 */
export async function restoreAssets(
  project: string,
  ids: string[],
): Promise<BatchOutcome> {
  const uniqueIds = [...new Set(ids)];
  const itemErrors = new Map<string, string>();

  for (const id of uniqueIds) {
    try {
      await requestJson(`/api/assets/${e(project)}/${e(id)}/restore`, { method: "POST" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      itemErrors.set(id, msg);
    }
  }

  return buildOutcome(uniqueIds.length, uniqueIds, itemErrors);
}

/**
 * Permanently delete one or more assets from the trash.
 * Each asset is deleted independently; one failure does not block the rest.
 */
export async function permanentlyDeleteAssets(
  project: string,
  ids: string[],
): Promise<BatchOutcome> {
  const uniqueIds = [...new Set(ids)];
  const itemErrors = new Map<string, string>();

  for (const id of uniqueIds) {
    try {
      await requestJson(`/api/assets/${e(project)}/${e(id)}/permanent`, { method: "DELETE" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      itemErrors.set(id, msg);
    }
  }

  return buildOutcome(uniqueIds.length, uniqueIds, itemErrors);
}

/** Empty the entire trash for a project. Returns the server's raw result. */
export async function emptyTrash(project: string): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>("/api/trash", {
    method: "DELETE",
    body: { projectId: project },
  });
}

// ---------------------------------------------------------------------------
// Stack — individual mutations
// ---------------------------------------------------------------------------

export type StackInfo = {
  id: string;
  name: string;
  count: number;
};

/** Create a new asset stack from a list of assets. */
export async function createStack(
  project: string,
  ids: string[],
  coverAssetId?: string,
): Promise<StackInfo> {
  const result = await requestJson<{ stack?: Record<string, unknown> }>("/api/asset-stacks", {
    method: "POST",
    body: { projectId: project, assetIds: ids, ...(coverAssetId ? { coverAssetId } : {}) },
  });
  const stack = result.stack;
  if (!stack || typeof stack !== "object") throw new Error("Server returned no stack");
  return {
    id: String(stack.id ?? ""),
    name: String(stack.name ?? ""),
    count: Number(stack.count ?? 0),
  };
}

/**
 * Rename an existing stack.
 * Throws synchronously if the trimmed name is empty — no request is sent.
 */
export function renameStack(
  project: string,
  stackId: string,
  name: string,
): Promise<StackInfo> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Stack name cannot be empty");
  return requestJson<{ stack?: Record<string, unknown> }>(`/api/asset-stacks/${e(stackId)}`, {
    method: "PATCH",
    body: { projectId: project, name: trimmed },
  }).then((result) => {
    const stack = result.stack;
    if (!stack || typeof stack !== "object") throw new Error("Server returned no stack");
    return {
      id: String(stack.id ?? ""),
      name: String(stack.name ?? ""),
      count: Number(stack.count ?? 0),
    };
  });
}

/** Dissolve a stack — its member assets remain in the library. */
export async function dissolveStack(
  project: string,
  stackId: string,
): Promise<{ assetIds: string[] }> {
  return requestJson<{ assetIds?: string[] }>(`/api/asset-stacks/${e(stackId)}`, {
    method: "DELETE",
    body: { projectId: project },
  }).then((result) => ({ assetIds: Array.isArray(result.assetIds) ? result.assetIds : [] }));
}

/** Add assets to an existing stack. */
export async function addAssetsToStack(
  project: string,
  stackId: string,
  ids: string[],
): Promise<StackInfo> {
  const result = await requestJson<{ stack?: Record<string, unknown> }>(
    `/api/asset-stacks/${e(stackId)}/assets`,
    { method: "POST", body: { projectId: project, assetIds: ids } },
  );
  const stack = result.stack;
  if (!stack || typeof stack !== "object") throw new Error("Server returned no stack");
  return {
    id: String(stack.id ?? ""),
    name: String(stack.name ?? ""),
    count: Number(stack.count ?? 0),
  };
}

/** Remove assets from a stack. */
export async function removeAssetsFromStack(
  project: string,
  stackId: string,
  ids: string[],
): Promise<unknown> {
  return requestJson(`/api/asset-stacks/${e(stackId)}/assets`, {
    method: "DELETE",
    body: { projectId: project, assetIds: ids },
  });
}

/** Reorder the members of a stack. The full member list must be supplied. */
export async function reorderStack(
  project: string,
  stackId: string,
  orderedIds: string[],
): Promise<StackInfo> {
  const result = await requestJson<{ stack?: Record<string, unknown> }>(
    `/api/asset-stacks/${e(stackId)}/order`,
    { method: "PATCH", body: { projectId: project, assetIds: orderedIds } },
  );
  const stack = result.stack;
  if (!stack || typeof stack !== "object") throw new Error("Server returned no stack");
  return {
    id: String(stack.id ?? ""),
    name: String(stack.name ?? ""),
    count: Number(stack.count ?? 0),
  };
}

/**
 * Assign a stack to a group (or remove it from one by passing "").
 * The server treats an empty string as "ungrouped".
 */
export async function assignStackToGroup(
  project: string,
  stackId: string,
  group: string,
): Promise<StackInfo> {
  const result = await requestJson<{ stack?: Record<string, unknown> }>(
    `/api/asset-stacks/${e(stackId)}/group`,
    { method: "POST", body: { projectId: project, group } },
  );
  const stack = result.stack;
  if (!stack || typeof stack !== "object") throw new Error("Server returned no stack");
  return {
    id: String(stack.id ?? ""),
    name: String(stack.name ?? ""),
    count: Number(stack.count ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Stack — list members (pagination)
// ---------------------------------------------------------------------------

/**
 * Retrieve all member asset IDs of a stack by paging through the
 * /api/asset-stacks/{id}/assets endpoint with limit=250.
 *
 * Detects cursor loops (same cursor appearing twice) and throws to prevent
 * infinite loops.  AbortSignal is respected on each page request.
 */
export async function listStackMemberIds(
  project: string,
  stackId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const seenCursors = new Set<string>();
  const memberIds: string[] = [];
  let cursor = "";

  for (;;) {
    if (signal?.aborted) throw new Error("listStackMemberIds aborted");
    if (cursor) {
      if (seenCursors.has(cursor)) {
        throw new Error("listStackMemberIds: cursor repeated — possible infinite pagination loop");
      }
      seenCursors.add(cursor);
    }

    const params = new URLSearchParams({ project, limit: "250" });
    if (cursor) params.set("cursor", cursor);

    const data = await requestJson<{
      assets?: Record<string, unknown>[];
      page?: { nextCursor?: string | null };
    }>(`/api/asset-stacks/${e(stackId)}/assets?${params.toString()}`, { signal });

    if (Array.isArray(data.assets)) {
      for (const asset of data.assets) {
        const id = String(asset?.id ?? "");
        if (id) memberIds.push(id);
      }
    }

    const nextCursor = data.page?.nextCursor;
    cursor = nextCursor != null ? String(nextCursor) : "";
    if (!cursor) break;
  }

  return memberIds;
}

// ---------------------------------------------------------------------------
// Stack — compound operations
// ---------------------------------------------------------------------------

/**
 * Move an entire stack to the trash.
 *
 * Implementation mirrors the original UI approach: enumerate every member via
 * listStackMemberIds, then hand them to moveAssetsToTrash.
 * Members retain their stack membership while trashed, so restoring them
 * will automatically restore the stack relationship.
 *
 * Returns the combined BatchOutcome from moveAssetsToTrash.
 */
export async function trashStack(
  project: string,
  stackId: string,
): Promise<BatchOutcome> {
  const memberIds = await listStackMemberIds(project, stackId);
  if (!memberIds.length) {
    return { total: 0, succeeded: 0, failed: 0, failedIds: [], firstError: "" };
  }
  return moveAssetsToTrash(project, memberIds);
}
