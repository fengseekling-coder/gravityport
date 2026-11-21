// Stack read/compact and auto-session-stack code for SQLite store (task 414). Pure moves; no behavior changes.
import { randomUUID } from "node:crypto";
import { assetSortName } from "../asset-sort.js";
import { generationSessionTitle } from "../generation-session.mjs";
import { parseJson } from "./rows-util.mjs";
import { now } from "./util.mjs";

// An unnamed stack sorts by its first live (not archived, not trashed)
// member. Shared by the per-write sync and the background backfill so the two
// never disagree: when they did, the backfill rewrote every emptied stack to a
// trashed member's name and broadcast library-backfilled for it (task 356,
// from the 354 investigation).
export const STACK_LIVE_COVER_SORT_NAME_SQL = `COALESCE((
  SELECT a.sort_name
  FROM asset_stack_members sm
  JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
  WHERE sm.project_id = asset_stacks.project_id
    AND sm.stack_id = asset_stacks.id
    AND a.archived = 0
    AND a.deleted_at IS NULL
  ORDER BY sm.position, a.id
  LIMIT 1
), '')`;

/**
 * Attaches the exact ORDER BY tuple the page used to each returned asset, so
 * incremental clients can re-position a changed node without re-listing. For
 * collapsed galleries the tuple is the *node's* sort key (the Stack anchor),
 * not the cover asset row's own values. `ranked` marks relevance-ordered pages
 * (type-intent searches); plain pages pass null so clients know the order is
 * reproducible from the created/name keys alone.
 */
export function annotateGalleryNodeSort(assets, pageRows, { collapsed = false, ranked = false } = {}) {
  assets.forEach((asset, index) => {
    const row = pageRows[index];
    if (!row) return;
    asset.node_sort = {
      createdAt: String((collapsed ? row._node_created_at : row.created_at) ?? ""),
      sortName: String((collapsed ? row._node_sort_name : row.sort_name) ?? ""),
      searchScore: ranked && row._search_score != null ? Number(row._search_score) : null,
    };
  });
}

export function annotateAssetStackCovers(database, assets, projectId, { collapsedNodes = false } = {}) {
  if (!assets.length) return assets;
  if (!database.prepare("SELECT 1 FROM asset_stacks WHERE project_id = ? LIMIT 1").get(projectId)) return assets;
  const ids = assets.map((asset) => asset.id);
  const rows = database.prepare(`
    WITH requested_assets(asset_id) AS (
      SELECT CAST(value AS TEXT) FROM json_each(@assetIds)
    ), requested_members AS MATERIALIZED (
      SELECT sm.asset_id, sm.stack_id, sm.position
      FROM asset_stack_members sm
      JOIN requested_assets requested ON requested.asset_id = sm.asset_id
      WHERE sm.project_id = @projectId
    ), relevant_stacks AS MATERIALIZED (
      SELECT DISTINCT stack_id FROM requested_members
    ), stack_stats AS MATERIALIZED (
      SELECT sm.stack_id,
        COUNT(*) AS member_count,
        MIN(sm.position) AS first_position
      FROM asset_stack_members sm
      JOIN relevant_stacks relevant ON relevant.stack_id = sm.stack_id
      JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
      WHERE sm.project_id = @projectId AND a.deleted_at IS NULL AND a.archived = 0
      GROUP BY sm.stack_id
    )
    SELECT requested.asset_id, requested.stack_id, stats.member_count, s.name
    FROM requested_members requested
    JOIN stack_stats stats ON stats.stack_id = requested.stack_id${collapsedNodes ? "" : " AND stats.first_position = requested.position"}
    JOIN asset_stacks s ON s.project_id = @projectId AND s.id = requested.stack_id
  `).all({ projectId, assetIds: JSON.stringify(ids) });
  const byAssetId = new Map(rows.map((row) => [row.asset_id, row]));
  return assets.map((asset) => {
    const row = byAssetId.get(asset.id);
    if (!row || Number(row.member_count) < 2) return asset;
    return {
      ...asset,
      stack: { id: row.stack_id, count: Number(row.member_count), name: String(row.name || "") },
    };
  });
}

export function stackSummary(database, projectId, stackId) {
  const row = database.prepare(`
    SELECT s.id, s.name, s.created_at, s.updated_at, s.origin, s.session_key, s.order_locked,
      SUM(CASE WHEN a.deleted_at IS NULL AND a.archived = 0 THEN 1 ELSE 0 END) AS member_count,
      MIN(CASE WHEN a.deleted_at IS NULL AND a.archived = 0 THEN sm.position ELSE NULL END) AS first_active_position
    FROM asset_stacks s
    LEFT JOIN asset_stack_members sm
      ON sm.project_id = s.project_id AND sm.stack_id = s.id
    LEFT JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE s.project_id = ? AND s.id = ?
    GROUP BY s.project_id, s.id
  `).get(projectId, stackId);
  if (!row) return null;
  const cover = row.first_active_position == null ? null : database.prepare(`
    SELECT asset_id FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = ? AND sm.stack_id = ? AND sm.position = ? AND a.deleted_at IS NULL AND a.archived = 0
    LIMIT 1
  `).get(projectId, stackId, row.first_active_position);
  return {
    id: row.id,
    name: String(row.name || ""),
    count: Number(row.member_count || 0),
    cover_asset_id: cover?.asset_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    origin: String(row.origin || "manual"),
    session_key: String(row.session_key || ""),
    order_locked: Boolean(row.order_locked),
  };
}

export function syncAssetStackCoverSortName(database, projectId, stackId, timestamp = null) {
  const nextUpdatedAt = timestamp || now();
  database.prepare(`
    UPDATE asset_stacks
    SET updated_at = ?,
        sort_name = CASE WHEN name != '' THEN mosa_sort_name(name, '', id) ELSE ${STACK_LIVE_COVER_SORT_NAME_SQL} END
    WHERE project_id = ? AND id = ?
  `).run(nextUpdatedAt, projectId, stackId);
}

export function compactAssetStack(database, projectId, stackId) {
  const rows = database.prepare(`
    SELECT asset_id FROM asset_stack_members
    WHERE project_id = ? AND stack_id = ?
    ORDER BY position, asset_id
  `).all(projectId, stackId);
  if (rows.length <= 1) {
    database.prepare("DELETE FROM asset_stacks WHERE project_id = ? AND id = ?").run(projectId, stackId);
    return { dissolved: true, remainingAssetId: rows[0]?.asset_id || null };
  }
  database.prepare(`
    UPDATE asset_stack_members SET position = position + 1000000
    WHERE project_id = ? AND stack_id = ?
  `).run(projectId, stackId);
  const update = database.prepare(`
    UPDATE asset_stack_members SET position = ?
    WHERE project_id = ? AND stack_id = ? AND asset_id = ?
  `);
  rows.forEach((row, index) => update.run(index, projectId, stackId, row.asset_id));
  syncAssetStackCoverSortName(database, projectId, stackId);
  return { dissolved: false, remainingAssetId: null };
}

// Migration 16 backfills stacks inside the schema transaction, before the
// store's change-journal helper exists; it parks the touched project ids here
// so the freshly opened store can announce one full-refresh change per project.
export const AUTO_STACK_BACKFILL_NOTIFY_KEY = "auto_stack_backfill_pending_v1";

// A user pulling an asset out of any stack — directly, by dissolving the
// stack, or by moving it into another stack — is final: the tombstone outlives
// the stack row so later ingests from the same session never re-stack the
// asset. The recorded key is the ASSET's own session, not the stack's, because
// stacks may mix sessions and manual stacks carry none; assets without a
// session identity are skipped (they are never auto-stacked anyway). No
// foreign key, mirroring automatic_ingest_suppressions: the marker must
// survive the asset row it describes.
export function addAutoStackExclusions(database, projectId, assetIds) {
  const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).filter(Boolean))];
  if (!ids.length) return;
  const timestamp = now();
  const insert = database.prepare(`
    INSERT INTO auto_stack_exclusions (project_id, asset_id, session_key, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, asset_id) DO UPDATE SET
      session_key = excluded.session_key,
      created_at = excluded.created_at
  `);
  const sessionKeyOf = database.prepare("SELECT generation_session_key FROM assets WHERE project_id = ? AND id = ?");
  for (const assetId of ids) {
    const sessionKey = String(sessionKeyOf.get(projectId, assetId)?.generation_session_key || "");
    if (!sessionKey) continue;
    insert.run(projectId, assetId, sessionKey, timestamp);
  }
}

// The stack a session's images belong to: across every stack in the project
// (manual and auto alike), the one holding the most active members of this
// session wins; ties go to the oldest stack, then the smallest id. Driven by
// the assets(project_id, generation_session_key) index and the member table's
// (project_id, asset_id) primary key — no library-wide scan. The INDEXED BY
// pin is deliberate (same rationale as findAssetByContentHash above): left to
// choose, the planner could satisfy these queries from any project index and
// then filter the session key per row, which turns every ingest's stacking
// lookup into a project-wide scan on large libraries (audit 261 mid-24). A
// dropped index now fails loudly instead of silently degrading. Shared by the
// ingest path and the migration backfill.
export function targetStackForSession(database, projectId, sessionKey) {
  return database.prepare(`
    SELECT sm.stack_id AS id, s.origin, s.name, s.name_locked, COUNT(*) AS session_member_count
    FROM assets a INDEXED BY assets_project_session_key_idx
    JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
    WHERE a.project_id = ? AND a.generation_session_key = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
    GROUP BY sm.stack_id
    ORDER BY session_member_count DESC, s.created_at, s.id
    LIMIT 1
  `).get(projectId, sessionKey) || null;
}

// Keeps unlocked auto stacks (`origin = 'auto'`, `order_locked = 0`) ordered
// newest-first across every retained member (including trashed ones) so the
// active member with minimum position is always the latest image.
export function sortUnlockedAutoStack(database, projectId, stackId) {
  const stack = database.prepare(`
    SELECT origin, order_locked FROM asset_stacks
    WHERE project_id = ? AND id = ?
  `).get(projectId, stackId);
  if (!stack || stack.origin !== "auto" || Number(stack.order_locked) !== 0) return false;
  const rows = database.prepare(`
    SELECT sm.asset_id, sm.position
    FROM asset_stack_members sm
    LEFT JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = ? AND sm.stack_id = ?
    ORDER BY COALESCE(a.created_at, '') DESC, sm.asset_id ASC
  `).all(projectId, stackId);
  if (!rows.length) return false;
  if (rows.every((row, index) => Number(row.position) === index)) return false;
  database.prepare(`
    UPDATE asset_stack_members SET position = position + 1000000
    WHERE project_id = ? AND stack_id = ?
  `).run(projectId, stackId);
  const update = database.prepare(`
    UPDATE asset_stack_members SET position = ?
    WHERE project_id = ? AND stack_id = ? AND asset_id = ?
  `);
  rows.forEach((row, index) => update.run(index, projectId, stackId, row.asset_id));
  return true;
}

// Appends rows to an existing stack, then re-sorts newest-first when the stack
// is an unlocked auto stack. A session title only names a stack nobody named
// (sessionTitleMayNameStack below). `commitLibraryChanges` is omitted by the
// backfill, which announces the whole sweep once at the end.
function appendSessionAssetsToStack(database, projectId, stackId, sessionKey, orderedRows, title, options = {}) {
  if (!orderedRows.length) return null;
  const stack = database.prepare(`
    SELECT id, origin, name, name_locked FROM asset_stacks
    WHERE project_id = ? AND id = ?
  `).get(projectId, stackId);
  if (!stack) return null;
  const previousCoverAssetId = typeof options.commitLibraryChanges === "function"
    ? (stackSummary(database, projectId, stackId)?.cover_asset_id || "")
    : "";
  const timestamp = options.timestamp || now();
  const insertMember = database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  let nextPosition = Number(database.prepare(`
    SELECT COALESCE(MAX(position), -1) + 1 AS next_position
    FROM asset_stack_members WHERE project_id = ? AND stack_id = ?
  `).get(projectId, stackId).next_position);
  const appendedIds = [];
  for (const row of orderedRows) {
    insertMember.run(projectId, stackId, row.id, nextPosition, timestamp);
    appendedIds.push(row.id);
    nextPosition += 1;
  }
  sortUnlockedAutoStack(database, projectId, stackId);
  database.prepare("UPDATE asset_stacks SET updated_at = ? WHERE project_id = ? AND id = ?")
    .run(timestamp, projectId, stackId);
  let renamed = false;
  if (sessionTitleMayNameStack(database, projectId, stack, sessionKey, title)) {
    database.prepare("UPDATE asset_stacks SET name = ?, sort_name = ? WHERE project_id = ? AND id = ?")
      .run(title, assetSortName({ theme: title, asset: "", id: stackId }), projectId, stackId);
    renamed = true;
  }
  if (typeof options.commitLibraryChanges === "function") {
    const coverAssetId = stackSummary(database, projectId, stackId)?.cover_asset_id || "";
    const coverChanged = Boolean(previousCoverAssetId && coverAssetId && coverAssetId !== previousCoverAssetId);
    options.commitLibraryChanges([{
      projectId,
      kind: coverChanged ? "stack-cover-changed" : "stack-members-changed",
      entityType: "stack",
      entityId: stackId,
      assetIds: coverChanged
        ? [...new Set([...appendedIds, previousCoverAssetId, coverAssetId].filter(Boolean))]
        : appendedIds,
      detail: coverChanged ? { coverAssetId, previousCoverAssetId } : { coverAssetId },
    }]);
    if (renamed) {
      options.commitLibraryChanges([{ projectId, kind: "stack-updated", entityType: "stack", entityId: stackId, assetIds: appendedIds }]);
    }
  }
  return stackId;
}

// The one naming rule for session titles, shared by the ingest append path and
// applySessionTitle: the title must exist, the stack must be unnamed and not
// user-locked, and it is either an auto stack or a manual stack whose every
// active member came from this one session — a stack mixing sessions or other
// sources keeps its (empty) name. `stack` is the asset_stacks row carrying
// id/origin/name/name_locked.
export function sessionTitleMayNameStack(database, projectId, stack, sessionKey, title) {
  if (!title) return false;
  if (Number(stack.name_locked)) return false;
  if (String(stack.name || "")) return false;
  return stack.origin === "auto" || stackHoldsOnlySession(database, projectId, stack.id, sessionKey);
}

function stackHoldsOnlySession(database, projectId, stackId, sessionKey) {
  if (!sessionKey) return false;
  return !database.prepare(`
    SELECT 1 FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = ? AND sm.stack_id = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
      AND a.generation_session_key != ?
    LIMIT 1
  `).get(projectId, stackId, sessionKey);
}

// Creates the session's auto stack from at least two eligible members, ordered
// newest-first so the latest image is the cover.
function createAutoSessionStack(database, projectId, sessionKey, orderedRows, title, options = {}) {
  if (orderedRows.length < 2) return null;
  // Defensive: the partial unique index allows exactly one auto stack per
  // session, so a leftover auto row whose members are all trashed absorbs the
  // rows instead of crashing the write (the active-member target rule above
  // deliberately does not see it).
  const orphan = database.prepare(`
    SELECT id FROM asset_stacks WHERE project_id = ? AND session_key = ? AND origin = 'auto'
    ORDER BY created_at, id LIMIT 1
  `).get(projectId, sessionKey);
  if (orphan) return appendSessionAssetsToStack(database, projectId, orphan.id, sessionKey, orderedRows, title, options);
  const timestamp = options.timestamp || now();
  const stackId = `stack-${randomUUID()}`;
  const newestFirstRows = [...orderedRows].sort((left, right) => {
    const leftTime = String(left.created_at || "");
    const rightTime = String(right.created_at || "");
    if (leftTime !== rightTime) return rightTime > leftTime ? 1 : -1;
    const leftId = String(left.id || "");
    const rightId = String(right.id || "");
    return leftId < rightId ? -1 : (leftId > rightId ? 1 : 0);
  });
  const coverRow = newestFirstRows[0];
  database.prepare(`
    INSERT INTO asset_stacks (project_id, id, created_at, updated_at, sort_created_at, sort_name, name, origin, session_key, name_locked, order_locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'auto', ?, 0, 0)
  `).run(
    projectId,
    stackId,
    timestamp,
    timestamp,
    String(coverRow.created_at || timestamp),
    title ? assetSortName({ theme: title, asset: "", id: stackId }) : String(coverRow.sort_name || ""),
    title || "",
    sessionKey,
  );
  const insertMember = database.prepare(`
    INSERT INTO asset_stack_members (project_id, stack_id, asset_id, position, added_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  newestFirstRows.forEach((row, index) => insertMember.run(projectId, stackId, row.id, index, timestamp));
  sortUnlockedAutoStack(database, projectId, stackId);
  if (typeof options.commitLibraryChanges === "function") {
    const coverAssetId = stackSummary(database, projectId, stackId)?.cover_asset_id || coverRow.id;
    options.commitLibraryChanges([{
      projectId, kind: "stack-created", entityType: "stack", entityId: stackId,
      assetIds: newestFirstRows.map((row) => row.id), detail: { coverAssetId },
    }]);
  }
  return stackId;
}

// Active, unstacked, non-excluded members of one session, oldest first — the
// eligibility rule both the ingest path and the backfill apply.
function autoStackSessionCandidates(database, projectId, sessionKey) {
  return database.prepare(`
    SELECT a.id, a.created_at, a.sort_name, a.source_json
    FROM assets a INDEXED BY assets_project_session_key_idx
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    WHERE a.project_id = ? AND a.generation_session_key = ?
      AND a.archived = 0 AND a.deleted_at IS NULL
      AND sm.asset_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.created_at, a.id
  `).all(projectId, sessionKey);
}

// Runs right after a successful createAsset commit, in its own transaction so a
// stacking failure can never roll the ingest back (createAsset logs and moves
// on). Existing membership and exclusions win: the function is a no-op for an
// asset the user has already organised or deliberately pulled out.
export function autoStackAssetAfterInsert(database, projectId, assetId, { commitLibraryChanges }) {
  const asset = database.prepare(`
    SELECT id, created_at, sort_name, archived, deleted_at, generation_session_key, source_json
    FROM assets WHERE project_id = ? AND id = ?
  `).get(projectId, assetId);
  if (!asset || asset.archived || asset.deleted_at) return null;
  const sessionKey = String(asset.generation_session_key || "");
  if (!sessionKey) return null;
  if (database.prepare("SELECT 1 FROM auto_stack_exclusions WHERE project_id = ? AND asset_id = ?").get(projectId, assetId)) return null;
  const title = generationSessionTitle({ source: parseJson(asset.source_json, {}) });
  const apply = database.transaction(() => {
    const membership = database.prepare("SELECT stack_id FROM asset_stack_members WHERE project_id = ? AND asset_id = ?").get(projectId, assetId);
    if (membership) return null;
    // A stack already holding this session's images absorbs the new image
    // whatever its origin; only a session with no stack yet follows the
    // two-image rule for creating an auto stack.
    const target = targetStackForSession(database, projectId, sessionKey);
    if (target) {
      return appendSessionAssetsToStack(database, projectId, target.id, sessionKey, [asset], title, { commitLibraryChanges });
    }
    const candidates = autoStackSessionCandidates(database, projectId, sessionKey);
    if (candidates.length < 2) return null;
    const groupTitle = title
      || candidates.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean)
      || "";
    return createAutoSessionStack(database, projectId, sessionKey, candidates, groupTitle, { commitLibraryChanges });
  });
  return apply.immediate();
}

// Migration 16: one pass over every session in the library, executed inside the
// numbered-migration transaction (no nested transaction here). All stacks are
// built from a single ordered snapshot of eligible assets — no per-stack
// rescans — and the only journal entry is one full-refresh notification per
// touched project, parked in library_meta for the store to commit after open.
export function backfillAutoSessionStacks(database, timestamp) {
  const rows = database.prepare(`
    SELECT a.project_id, a.id, a.created_at, a.sort_name, a.generation_session_key, a.source_json
    FROM assets a
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    WHERE a.archived = 0 AND a.deleted_at IS NULL AND a.generation_session_key != ''
      AND sm.asset_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.project_id, a.generation_session_key, a.created_at, a.id
  `).all();
  if (!rows.length) return;
  const touchedProjects = new Set();
  let currentKey = null;
  let group = [];
  const flushGroup = () => {
    if (group.length) {
      const projectId = group[0].project_id;
      const sessionKey = group[0].generation_session_key;
      const title = group.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean) || "";
      // A stack already holding this session's images (a manual stack at
      // migration time) absorbs every loose image at any count, in ingest-time
      // order; sessions no stack touched follow the ≥2 auto-stack rule.
      const target = targetStackForSession(database, projectId, sessionKey);
      const stackId = target
        ? appendSessionAssetsToStack(database, projectId, target.id, sessionKey, group, title, { timestamp })
        : createAutoSessionStack(database, projectId, sessionKey, group, title, { timestamp });
      if (stackId) touchedProjects.add(projectId);
    }
    group = [];
  };
  for (const row of rows) {
    const key = `${row.project_id}\u0000${row.generation_session_key}`;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    group.push(row);
  }
  flushGroup();
  if (touchedProjects.size) {
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(AUTO_STACK_BACKFILL_NOTIFY_KEY, JSON.stringify([...touchedProjects]), timestamp);
  }
}

// Migration 17: Jimeng's session id changed from the per-generation record id
// to the conversation window (the workspace query param in the page address),
// so already-ingested Jimeng assets re-key into one session per window.
// ensureGenerationSessionColumn has already re-derived the asset keys inside
// this open; this pass moves the regrouped assets into their window's auto
// stack with the ingest-time rules (reuse of the same helpers, no parallel
// rule set). User organisation always wins: assets in manual stacks, in
// renamed (name_locked) auto stacks, or excluded via auto_stack_exclusions
// are never moved. Only an unlocked auto stack keyed by an old Jimeng record
// id gives its members up; it is then compacted under the existing stack rules
// (empty or single-member stacks dissolve). Ingest only ever files an asset
// into its own session's stack, so a Jimeng asset inside another source's
// auto stack got there by the user moving it — that placement is the user's
// organisation and stays. Runs inside the numbered-migration transaction; the only journal
// entry is the shared backfill notify key, merged with any list migration 16
// parked for this same open (a v15 library runs both migrations at once).
export function regroupJimengWorkspaceStacks(database, timestamp) {
  // Task 350 (audit 5-2 #9): Trash holds no exception — a Jimeng capture that
  // was trashed when the upgrade ran must still rejoin its session stack, or
  // restoring it later strands it outside the stack it belongs to. Live
  // filtering happens wherever the gallery reads stacks, not here.
  const rows = database.prepare(`
    SELECT a.project_id, a.id, a.created_at, a.sort_name, a.generation_session_key AS session_key, a.source_json,
      s.id AS stack_id, s.origin AS stack_origin, s.session_key AS stack_session_key, s.name_locked AS stack_name_locked
    FROM assets a
    LEFT JOIN asset_stack_members sm ON sm.project_id = a.project_id AND sm.asset_id = a.id
    LEFT JOIN asset_stacks s ON s.project_id = sm.project_id AND s.id = sm.stack_id
    WHERE a.generation_session_key LIKE 'web-jimeng:%'
      AND NOT EXISTS (
        SELECT 1 FROM auto_stack_exclusions x
        WHERE x.project_id = a.project_id AND x.asset_id = a.id
      )
    ORDER BY a.project_id, a.generation_session_key, a.created_at, a.id
  `).all();
  if (!rows.length) return;
  const deleteMembership = database.prepare(
    "DELETE FROM asset_stack_members WHERE project_id = ? AND asset_id = ? AND stack_id = ?",
  );
  const autoStackForSession = database.prepare(`
    SELECT id FROM asset_stacks
    WHERE project_id = ? AND session_key = ? AND origin = 'auto'
    ORDER BY created_at, id
    LIMIT 1
  `);
  const touchedProjects = new Set();
  const emptiedStacks = new Set();
  let currentKey = null;
  let group = [];
  const flushGroup = () => {
    if (group.length) {
      const projectId = group[0].project_id;
      const sessionKey = group[0].session_key;
      // Movable: loose, or held by an unlocked auto stack of an old Jimeng
      // record session. Members already in this session's auto stack, and
      // members of manual, renamed, or other-source stacks, keep their place.
      const movable = group.filter((row) => !row.stack_id
        || (row.stack_origin === "auto" && !Number(row.stack_name_locked)
          && String(row.stack_session_key || "").startsWith("web-jimeng:")
          && row.stack_session_key !== sessionKey));
      let changed = false;
      for (const row of movable) {
        if (!row.stack_id) continue;
        deleteMembership.run(projectId, row.id, row.stack_id);
        emptiedStacks.add(`${projectId}\u0000${row.stack_id}`);
        changed = true;
      }
      if (movable.length) {
        const title = group.map((row) => generationSessionTitle({ source: parseJson(row.source_json, {}) })).find(Boolean) || "";
        const existing = autoStackForSession.get(projectId, sessionKey);
        const stackId = existing
          ? appendSessionAssetsToStack(database, projectId, existing.id, sessionKey, movable, title, { timestamp })
          : createAutoSessionStack(database, projectId, sessionKey, movable, title, { timestamp });
        changed = changed || Boolean(stackId);
      }
      if (changed) touchedProjects.add(projectId);
    }
    group = [];
  };
  for (const row of rows) {
    const key = `${row.project_id}\u0000${row.session_key}`;
    if (key !== currentKey) {
      flushGroup();
      currentKey = key;
    }
    group.push(row);
  }
  flushGroup();
  for (const stackKey of emptiedStacks) {
    const separator = stackKey.indexOf("\u0000");
    compactAssetStack(database, stackKey.slice(0, separator), stackKey.slice(separator + 1));
  }
  if (touchedProjects.size) {
    const parked = parseJson(
      database.prepare("SELECT value FROM library_meta WHERE key = ?").get(AUTO_STACK_BACKFILL_NOTIFY_KEY)?.value || "[]",
      [],
    );
    const merged = [...new Set([...(Array.isArray(parked) ? parked : []), ...touchedProjects])];
    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(AUTO_STACK_BACKFILL_NOTIFY_KEY, JSON.stringify(merged), timestamp);
  }
}

/** A stack sorts by its newest member's date, so a stack that gains a fresh
 * capture moves up with it instead of staying where its oldest cover sat.
 * Members in the trash do not count while any member is still live. */
// Exported for tests: the EXPLAIN QUERY PLAN assertions pin the plan of the
// exact expression the store runs (audit 261 mid-8).
export const STACK_SORT_CREATED_AT_SQL = `COALESCE((
    SELECT MAX(a.created_at)
    FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    -- The unary plus keeps the planner off assets_project_deleted_idx: with the
    -- bare column it walked the trash-time index per stack, making the sweep
    -- quadratic in stack members (audit 261 mid-8). "+deleted_at IS NULL" is
    -- still exact (NULL stays NULL, trash rows stay excluded) but only the
    -- member-table join and the assets primary key are usable.
    WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id AND +a.deleted_at IS NULL
  ), (
    SELECT MAX(a.created_at)
    FROM asset_stack_members sm
    JOIN assets a ON a.project_id = sm.project_id AND a.id = sm.asset_id
    WHERE sm.project_id = asset_stacks.project_id AND sm.stack_id = asset_stacks.id
  ), NULLIF(sort_created_at, ''), created_at)`;

export function refreshStackSortCreatedAt(database, projectId, stackId) {
  database.prepare(`UPDATE asset_stacks SET sort_created_at = ${STACK_SORT_CREATED_AT_SQL} WHERE project_id = ? AND id = ?`)
    .run(projectId, stackId);
}
