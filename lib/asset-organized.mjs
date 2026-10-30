/**
 * "整理过" (task 304): the one list that says the user has organized an asset
 * here. The unorganized inbox (lib/sqlite-asset-store.mjs), the provider
 * deletion sync (lib/provider-deletion-sync.mjs) and "标为已整理" all read this
 * single SQL expression, so the two meanings of the word cannot drift apart.
 *
 * Organized means any one of: favorited or rated, placed in a group, carrying
 * a user tag, a member of a manual stack, marked 整理好 (`curated`), given a
 * curation note, or edited by hand (prompt or name). Automatic stacks do not
 * count, and archiving does not count.
 *
 * System tags are the ones the capture pipeline writes by itself, so they never
 * count as user tags: the fixed capture tags, the asset's own source name
 * (`web-jimeng` → `jimeng`, `codex-generated` → `codex`), and "image" or
 * "video" when it matches the asset's own media kind. A "video" tag on an image
 * is still a user tag.
 */

const FIXED_SYSTEM_TAGS = ["web-capture", "auto-archived", "manual-capture"];
const MEDIA_SYSTEM_TAGS = ["image", "video"];

// Trims the same whitespace JavaScript's String#trim does, for JSON text fields.
function trimmedText(expression) {
  return `TRIM(COALESCE(${expression}, ''), ' ' || char(9) || char(10) || char(13))`;
}

// The asset's own source name: web-jimeng → jimeng, codex-generated → codex.
function ownSourceNameSql(sourceColumn) {
  const lowered = `LOWER(COALESCE(${sourceColumn}, ''))`;
  const unprefixed = `(CASE WHEN ${lowered} LIKE 'web-%' THEN SUBSTR(${lowered}, 5) ELSE ${lowered} END)`;
  return `(CASE WHEN ${unprefixed} LIKE '%-generated' THEN SUBSTR(${unprefixed}, 1, LENGTH(${unprefixed}) - 10) ELSE ${unprefixed} END)`;
}

/**
 * SQL boolean expression: true when the asset counts as organized. `alias`
 * names the assets row in the surrounding query. The expression is never NULL
 * (every term is coalesced), so `NOT <expression>` is safe to use as a filter.
 */
export function assetOrganizedSql(alias = "a") {
  const column = (name) => `${alias}.${name}`;
  const systemTagList = FIXED_SYSTEM_TAGS.map((name) => `'${name}'`).join(", ");
  const mediaTagList = MEDIA_SYSTEM_TAGS.map((name) => `'${name}'`).join(", ");
  const sourceName = ownSourceNameSql(column("source_type"));
  return `(
    COALESCE(${column("favorite")}, 0) = 1
    OR COALESCE(${column("rating")}, 0) > 0
    OR COALESCE(TRIM(${column("group_name")}), '') <> ''
    OR EXISTS (
      SELECT 1
      FROM asset_tags org_at
      JOIN tags org_t ON org_t.id = org_at.tag_id
      WHERE org_at.project_id = ${column("project_id")}
        AND org_at.asset_id = ${column("id")}
        AND LOWER(org_t.name) NOT IN (${systemTagList})
        AND LOWER(org_t.name) <> ${sourceName}
        AND NOT (LOWER(org_t.name) IN (${mediaTagList}) AND LOWER(org_t.name) = LOWER(COALESCE(${column("media_kind")}, '')))
    )
    OR EXISTS (
      SELECT 1
      FROM asset_stack_members org_sm
      JOIN asset_stacks org_s ON org_s.project_id = org_sm.project_id AND org_s.id = org_sm.stack_id
      WHERE org_sm.project_id = ${column("project_id")}
        AND org_sm.asset_id = ${column("id")}
        AND org_s.origin = 'manual'
    )
    OR COALESCE(json_extract(${column("metadata_json")}, '$.curated') IN (1, 'true'), 0) = 1
    OR ${trimmedText(`json_extract(${column("metadata_json")}, '$.curation_note')`)} <> ''
    OR ${trimmedText(`json_extract(${column("source_json")}, '$.user_edited_at')`)} <> ''
    OR ${trimmedText(`json_extract(${column("source_json")}, '$.prompt_user_edited_at')`)} <> ''
  )`;
}
