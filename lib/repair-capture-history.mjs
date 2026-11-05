/**
 * One-time repair for capture history damaged by the pre-#142 re-observation
 * bug: re-identifying an already-archived ChatGPT image overwrote its user
 * message with a random nearby turn and appended an unidentified generation
 * event per capture. Runs once per library, gated by the
 * `repair_capture_user_message_v1` marker in library_meta, entirely inside one
 * transaction so a crash leaves both the data and the marker untouched.
 *
 * Search text assembly comes from lib/asset-search-scope.mjs (the whitelist
 * authority) and generation-session.mjs (the canonical source classifier) —
 * the store injects only its own internals (full metadata loading, FTS sync,
 * relation-candidate recomputation) so this module adds no exports to that
 * file.
 */

import { canonicalSourceTypeOf } from "./generation-session.mjs";
import { searchableBusinessObjectText, searchableSourceObjectText } from "./asset-search-scope.mjs";

const REPAIR_MARKER_KEY = "repair_capture_user_message_v1";

export function repairCaptureHistory(database, helpers = {}) {
  const {
    commitLibraryChanges,
    syncRelationCandidates,
    loadMetadata,
    searchableText,
    syncAssetFtsEntry,
    replaceAssetShortTerms,
  } = helpers;
  const alreadyRepaired = database.prepare("SELECT value FROM library_meta WHERE key = ?").get(REPAIR_MARKER_KEY);
  const stats = { userMessagesRestored: 0, eventsRemoved: 0 };
  if (alreadyRepaired) return stats;

  const perProject = new Map();
  const countFor = (projectId) => {
    let entry = perProject.get(projectId);
    if (!entry) perProject.set(projectId, (entry = { userMessagesRestored: 0, eventsRemoved: 0 }));
    return entry;
  };

  // BEGIN IMMEDIATE, not the default deferred transaction: the read snapshot
  // must not upgrade to a write mid-transaction. In WAL mode that upgrade
  // returns SQLITE_BUSY (BUSY_SNAPSHOT) immediately — busy_timeout never
  // applies — whenever another process (MCP/CLI on the same library) commits
  // between the SELECTs and the first UPDATE. Same rationale as the
  // derivative claim/complete transactions.
  database.transaction(() => {
    // 2a: restore the user message from the earliest non-empty recipe
    // snapshot. A current message that equals the snapshot or is a longer
    // completion of it (starts with it after trimming) is legitimate and
    // stays; everything else was a wrong-turn overwrite.
    // Full rows, not a narrow column list: loadMetadata (rowToAsset) rebuilds
    // the metadata whose search text gets rewritten below, so it needs every
    // column (prompt, theme, group, category, metadata_json, …). Selecting a
    // subset would silently blank those fields in the rebuilt search text.
    const rows = database.prepare(`
      SELECT * FROM assets
      WHERE source_type = 'web-chatgpt' AND deleted_at IS NULL
    `).all();
    const earliestSnapshot = database.prepare(`
      SELECT user_prompt FROM recipe_snapshots
      WHERE project_id = ? AND asset_id = ? AND TRIM(user_prompt) != ''
      ORDER BY created_at ASC, snapshot_id ASC
      LIMIT 1
    `);
    const updateSearchColumns = database.prepare(`
      UPDATE assets
      SET source_json = ?, business_fields_json = ?, search_text = ?, source_search_text = ?, business_search_text = ?
      WHERE project_id = ? AND id = ?
    `);
    for (const row of rows) {
      const snapshot = earliestSnapshot.get(row.project_id, row.id);
      const restored = String(snapshot?.user_prompt || "");
      if (!restored || !restored.trim()) continue;
      let source;
      let businessFields;
      try {
        source = JSON.parse(row.source_json || "{}");
        businessFields = JSON.parse(row.business_fields_json || "{}");
      } catch {
        continue;
      }
      if (!source || typeof source !== "object") continue;
      const current = source.user_message == null ? "" : String(source.user_message);
      if (current === restored) continue;
      const trimmedCurrent = current.trim();
      if (trimmedCurrent.startsWith(restored) && trimmedCurrent.length > restored.length) continue;
      source.user_message = restored;
      if (businessFields && typeof businessFields === "object" && Object.hasOwn(businessFields, "user_message")) {
        businessFields.user_message = restored;
      }
      const metadata = loadMetadata(row);
      metadata.source = source;
      metadata.business_fields = businessFields && typeof businessFields === "object" ? businessFields : {};
      const searchText = searchableText(metadata);
      updateSearchColumns.run(
        JSON.stringify(source),
        JSON.stringify(businessFields ?? {}),
        searchText,
        searchableSourceObjectText(source, canonicalSourceTypeOf(metadata)),
        searchableBusinessObjectText(metadata.business_fields),
        row.project_id,
        row.id,
      );
      syncAssetFtsEntry(row.project_id, row.id, searchText, row.deleted_at);
      replaceAssetShortTerms(row.project_id, row.id, row.search_text, searchText, row.deleted_at);
      countFor(row.project_id).userMessagesRestored += 1;
      stats.userMessagesRestored += 1;
    }

    // 2b: drop unidentified duplicate generation events. Keep events that a
    // user-confirmed relation references; require an identified sibling so a
    // lone unidentified event (the only record of a generation) survives.
    // Candidates pointing at a removed event cascade via foreign key, then the
    // per-project recomputation below re-derives the surviving pairs.
    const removed = database.prepare(`
      DELETE FROM generation_events
      WHERE provider = 'chatgpt'
        AND provider_generation_call_id = ''
        AND capture_context_id = ''
        AND message_id = ''
        AND provider_asset_id = ''
        AND EXISTS (
          SELECT 1 FROM generation_events identified
          WHERE identified.project_id = generation_events.project_id
            AND identified.output_asset_id = generation_events.output_asset_id
            AND (identified.provider_generation_call_id != '' OR identified.capture_context_id != ''
              OR identified.message_id != '' OR identified.provider_asset_id != '')
        )
        AND NOT EXISTS (
          SELECT 1 FROM generation_relations relation
          WHERE relation.project_id = generation_events.project_id
            AND (relation.child_generation_id = generation_events.id OR relation.parent_generation_id = generation_events.id)
        )
      RETURNING project_id
    `).all();
    for (const { project_id: projectId } of removed) {
      countFor(projectId).eventsRemoved += 1;
      stats.eventsRemoved += 1;
    }
    const removedProjects = [...new Set(removed.map((row) => row.project_id))];
    for (const projectId of removedProjects) syncRelationCandidates(database, projectId);

    // 2c: one full-refresh announcement per affected project; the client takes
    // its full-recovery path on this unknown kind, same as library-backfilled.
    if (perProject.size) {
      commitLibraryChanges([...perProject].map(([projectId, counts]) => ({
        projectId,
        kind: "library-repaired",
        entityType: "library",
        entityId: "",
        assetIds: [],
        detail: { reason: "repair-capture-user-message-v1", ...counts },
      })));
    }

    database.prepare(`
      INSERT INTO library_meta (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(REPAIR_MARKER_KEY, new Date().toISOString(), new Date().toISOString());
  }).immediate();

  // stderr, not stdout: the MCP server and CLI speak JSON on stdout, so a
  // startup log line there would corrupt the protocol channel.
  // Only libraries that actually needed fixing log a line; fresh libraries
  // and re-openings stay silent (stderr — stdout is the MCP/CLI JSON channel).
  if (stats.userMessagesRestored + stats.eventsRemoved > 0) {
    console.warn(`[MOSA] repair_capture_user_message_v1: restored ${stats.userMessagesRestored} user message(s), removed ${stats.eventsRemoved} duplicate generation event(s).`);
  }
  return stats;
}
