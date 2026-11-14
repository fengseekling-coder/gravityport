// Asset-record helpers for SQLite store (task 407). Pure moves; no behavior changes.
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";
import {
  assetStoreError,
  automaticIngestDuplicateError,
  automaticImportSuppressedError,
} from "../asset-version-history.mjs";
import { createdAtTimestamp } from "../recent-window.js";
import { buildRecipeSnapshot, normalizeSnapshotReferences } from "../recipe-snapshot.js";
import { assetSortName } from "../asset-sort.js";
import { canonicalSourceTypeOf, generationSessionKey } from "../generation-session.mjs";
import {
  searchableAssetName,
  searchableBusinessObjectText,
  searchableSourceObjectText,
} from "../asset-search-scope.mjs";
import { normalizeAssetMetadata, unknownFields } from "./metadata.mjs";
import { paletteJsonToHexes, parseJson } from "./rows-util.mjs";
import { searchableText } from "./search-sql.mjs";
import {
  automaticIngestIdentityKey,
  automaticIngestIdentityKind,
  normalizeSuppressionHashes,
} from "./suppression.mjs";
import { canonicalGroupName, mediaKindOf, sanitizeId, shortStamp } from "./util.mjs";
import {
  ensureAssetSearchDoc,
  replaceAssetShortTerms,
  syncAssetFtsEntry,
} from "./search-index.mjs";

function tagsSearchText(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((tag) => String(tag || "").trim())
    .filter(Boolean)
    .join("\u001f");
}

export const REPLACED_MEDIA_TRASH_REASON = "replaced-by-better-version";
// Prompt metadata never travels with a media replacement: an empty incoming
// prompt must not downgrade the stored one, and a better prompt may only land
// through maybeUpgradePrompt in the ingest layer.
const REPLACEMENT_PRESERVED_KEYS = new Set(["prompt_status", "prompt_source", "prompt_priority", "prompt_scope", "user_message"]);

function isEmptyValue(value) {
  return value === null || value === undefined || value === "";
}

/**
 * Replacement merge rule: incoming empty values ("", null) never erase stored
 * non-empty ones, non-empty incoming values win, and prompt fields are left to
 * the existing stored values entirely.
 */
export function mergeReplacementObject(current, incoming) {
  const merged = { ...(current && typeof current === "object" ? current : {}) };
  if (!incoming || typeof incoming !== "object") return merged;
  for (const [key, value] of Object.entries(incoming)) {
    if (REPLACEMENT_PRESERVED_KEYS.has(key)) continue;
    if (isEmptyValue(value) && !isEmptyValue(merged[key])) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * Moves the replaced original and its three derivatives onto an independent
 * trashed snapshot asset: a fresh id (`<id>-replaced-<stamp>`), the old
 * prompt/source/pixel metadata, cleared provider ids (it must never answer a
 * provider-identity or deletion-sync lookup again), and no curation state.
 * Files are renamed before the caller's transaction; `rollback()` restores the
 * original names if that transaction fails, so the swap stays all-or-nothing.
 */
export async function stageReplacedMediaSnapshot(database, store, projectId, row, current, { timestamp, cleanAssetId }) {
  const imagesDir = store.imagesDir(projectId);
  const oldOriginal = String(row.original_path || "");
  const originalExt = extname(oldOriginal) || extname(String(row.asset || "")) || ".png";
  const derivativeMoves = [
    { column: "preview_path", kind: "preview" },
    { column: "medium_path", kind: "medium" },
    { column: "thumbnail_path", kind: "thumbnail" },
  ].map(({ column }) => {
    const from = String(row[column] || "");
    // Derivative files are named `<asset id>.webp` inside their own directory
    // (previews/, mediums/, thumbnails/), so the rename only swaps the name.
    return from ? { column, from, dir: dirname(from) } : null;
  }).filter(Boolean);

  let snapshotId = "";
  for (let attempt = 0; attempt < 5 && !snapshotId; attempt += 1) {
    const candidate = sanitizeId(`${cleanAssetId}-replaced-${shortStamp()}`, "asset");
    const rowTaken = database.prepare("SELECT 1 FROM assets WHERE project_id = ? AND id = ?").get(projectId, candidate);
    if (rowTaken) continue;
    const targets = [
      join(imagesDir, `${candidate}${originalExt}`),
      ...derivativeMoves.map((move) => join(move.dir, `${candidate}.webp`)),
    ];
    if (targets.some((target) => existsSync(target))) continue;
    snapshotId = candidate;
  }
  if (!snapshotId) throw assetStoreError("REPLACEMENT_SNAPSHOT_COLLISION", "Could not allocate a Trash snapshot id for the replaced media.");

  const moves = [
    { from: oldOriginal, to: join(imagesDir, `${snapshotId}${originalExt}`), column: "original_path" },
    ...derivativeMoves.map((move) => ({ from: move.from, to: join(move.dir, `${snapshotId}.webp`), column: move.column })),
  ].filter((move) => move.from);

  const applied = [];
  const moveOne = async (move) => {
    try {
      await rename(move.from, move.to);
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    applied.push(move);
    return true;
  };
  try {
    for (const move of moves) {
      // A missing file (derivatives never generated, video poster pending)
      // just leaves that column null; only real I/O failures abort.
      if (!await moveOne(move)) continue;
    }
  } catch (error) {
    for (const move of [...applied].reverse()) await rename(move.to, move.from).catch(() => {});
    throw error;
  }

  const movedByColumn = new Map(applied.map((move) => [move.column, move.to]));
  const derivativePaths = {
    preview: movedByColumn.get("preview_path") || null,
    medium: movedByColumn.get("medium_path") || null,
    thumbnail: movedByColumn.get("thumbnail_path") || null,
  };
  const { deleted_at: _deletedAt, ...currentWithoutDeletedAt } = current;
  const snapshotMetadata = normalizeAssetMetadata({
    ...currentWithoutDeletedAt,
    id: snapshotId,
    project_id: projectId,
    asset: basename(movedByColumn.get("original_path") || `${snapshotId}${originalExt}`),
    image_path: movedByColumn.get("original_path") || join(imagesDir, `${snapshotId}${originalExt}`),
    tags: [],
    favorite: false,
    rating: 0,
    group: "",
    category: "",
    parent_asset_id: null,
    child_asset_ids: [],
    version_change: "",
    archived: false,
    created_at: current.created_at,
    updated_at: timestamp,
    source: {
      ...(current.source || {}),
      provider_asset_id: null,
      logical_output_id: null,
    },
    trash_reason: { code: REPLACED_MEDIA_TRASH_REASON, at: timestamp },
  });
  return {
    id: snapshotId,
    metadata: snapshotMetadata,
    searchText: searchableText(snapshotMetadata),
    derivativePaths,
    async rollback() {
      for (const move of [...applied].reverse()) await rename(move.to, move.from).catch(() => {});
    },
  };
}

export function saveAsset(database, metadata, options = {}, helpers = {}) {
  // Align the stored casing before anything is persisted so the membership
  // join, the facet filter, and the sidebar row stay one logical group. Runs
  // ahead of the asset INSERT: every caller (import, metadata edit, restore,
  // duplication) funnels through here.
  if (metadata.group) {
    metadata.group = canonicalGroupName(database, metadata.project_id, metadata.group) || metadata.group;
  }
  const source = metadata.source || {};
  const searchText = searchableText(metadata);
  const tagsText = tagsSearchText(metadata.tags);
  const sourceGroup = canonicalSourceTypeOf(metadata);
  const businessSearchText = searchableBusinessObjectText(metadata.business_fields);
  const sourceSearchText = searchableSourceObjectText(source, sourceGroup);
  const sourcePath = source.path == null ? "" : String(source.path);
  const mediaKind = mediaKindOf(metadata);
  const conversationId = source.conversation_id == null ? "" : String(source.conversation_id);
  const generationBatch = source.message_id == null ? "" : String(source.message_id);
  const sessionKey = generationSessionKey(metadata);
  const unknownMetadata = unknownFields(metadata);
  const write = database.transaction(() => {
    if (options.rejectAutomaticIngestDuplicate) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestDuplicate);
      let duplicate = null;
      let duplicateKind = "content";
      if (hashes.content_sha256) {
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_hash_idx
          WHERE project_id = ? AND content_sha256 = ? AND deleted_at IS NULL
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.content_sha256);
      }
      if (!duplicate && hashes.pixel_sha256) {
        duplicateKind = "pixel";
        duplicate = database.prepare(`
          SELECT id FROM assets INDEXED BY assets_project_pixel_hash_idx
          WHERE project_id = ? AND pixel_sha256 = ?
            AND deleted_at IS NULL
            AND (? = '' OR json_extract(source_json, '$.pixel_hash_version') = ?)
          ORDER BY archived ASC, created_at DESC, id DESC
          LIMIT 1
        `).get(metadata.project_id, hashes.pixel_sha256, hashes.pixel_hash_version, hashes.pixel_hash_version);
      }
      if (duplicate) {
        throw automaticIngestDuplicateError(duplicate.id, duplicateKind);
      }
    }
    if (options.rejectAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.rejectAutomaticIngestSuppression);
      const suppression = database.prepare(`
        SELECT 1
        FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
        LIMIT 1
      `).get(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
      if (suppression) throw automaticImportSuppressedError();
      // Same-site identity list, re-checked inside the transaction so a
      // deletion committing between the preflight lookup and this insert still
      // blocks the arrival (same lock discipline as the byte/pixel list).
      const identityKey = automaticIngestIdentityKey(metadata.project_id, metadata);
      if (identityKey) {
        const identitySuppression = database.prepare(`
          SELECT 1
          FROM automatic_ingest_identity_suppressions
          WHERE project_id = ? AND logical_output_id = ? AND media_kind = ?
          LIMIT 1
        `).get(metadata.project_id, identityKey, automaticIngestIdentityKind(mediaKind));
        if (identitySuppression) throw automaticImportSuppressedError();
      }
    }
    database.prepare("INSERT OR IGNORE INTO projects (id, created_at) VALUES (?, ?)").run(metadata.project_id, metadata.created_at);
    // Task 348: read the pre-write row before the upsert. The stored
    // search_text is what the existing short-term rows were built from (the
    // delete-by-old-terms shape needs it), deleted_at decides the trash
    // invariant, and the doc id is allocated here on first write — once
    // assigned it never changes, so a trash/restore cycle keeps it.
    const storedSearchRow = database.prepare("SELECT deleted_at, search_text FROM assets WHERE project_id = ? AND id = ?")
      .get(metadata.project_id, metadata.id);
    ensureAssetSearchDoc(database, metadata.project_id, metadata.id);
    const updateOnConflict = options.insertOnly ? "" : `
      ON CONFLICT(project_id, id) DO UPDATE SET
        prompt = excluded.prompt, skill = excluded.skill, style = excluded.style, ratio = excluded.ratio,
        business_fields_json = excluded.business_fields_json, theme = excluded.theme, favorite = excluded.favorite,
        archived = excluded.archived, group_name = excluded.group_name, category = excluded.category, rating = excluded.rating,
        parent_asset_id = excluded.parent_asset_id, version_change = excluded.version_change, source_type = excluded.source_type,
        pixel_sha256 = excluded.pixel_sha256, source_json = excluded.source_json, source_path = excluded.source_path,
        provider_asset_id = excluded.provider_asset_id, logical_output_id = excluded.logical_output_id,
        metadata_json = excluded.metadata_json, search_text = excluded.search_text,
        tags_text = excluded.tags_text, business_search_text = excluded.business_search_text, source_search_text = excluded.source_search_text,
        media_kind = excluded.media_kind, source_group = excluded.source_group,
        conversation_id = excluded.conversation_id, generation_batch = excluded.generation_batch,
        generation_session_key = excluded.generation_session_key,
        created_at = excluded.created_at, created_at_epoch = excluded.created_at_epoch, updated_at = excluded.updated_at,
        sort_name = excluded.sort_name
    `;
    database.prepare(`
      INSERT INTO assets (
        project_id, id, asset, original_path, preview_path, thumbnail_path, content_sha256, pixel_sha256, prompt, skill, style, ratio,
        business_fields_json, theme, favorite, archived, group_name, category, rating, parent_asset_id, version_change,
        source_type, source_json, source_path, provider_asset_id, logical_output_id, metadata_json, search_text, tags_text, business_search_text, source_search_text, media_kind, source_group,
        conversation_id, generation_batch, generation_session_key,
        created_at, created_at_epoch, updated_at, sort_name
      ) VALUES (
        @project_id, @id, @asset, @image_path, NULL, NULL, @content_sha256, @pixel_sha256, @prompt, @skill, @style, @ratio,
        @business_fields_json, @theme, @favorite, @archived, @group_name, @category, @rating, @parent_asset_id, @version_change,
        @source_type, @source_json, @source_path, @provider_asset_id, @logical_output_id, @metadata_json, @search_text, @tags_text, @business_search_text, @source_search_text, @media_kind, @source_group,
        @conversation_id, @generation_batch, @generation_session_key,
        @created_at, @created_at_epoch, @updated_at, @sort_name
      )
      ${updateOnConflict}
    `).run({
      project_id: metadata.project_id,
      id: metadata.id,
      asset: metadata.asset,
      image_path: metadata.image_path,
      content_sha256: source.content_sha256 || "",
      pixel_sha256: source.pixel_sha256 || "",
      prompt: metadata.prompt,
      skill: metadata.skill,
      style: metadata.style,
      ratio: metadata.ratio,
      business_fields_json: JSON.stringify(metadata.business_fields),
      theme: metadata.theme,
      favorite: metadata.favorite ? 1 : 0,
      archived: metadata.archived ? 1 : 0,
      group_name: metadata.group,
      category: metadata.category,
      rating: metadata.rating,
      parent_asset_id: metadata.parent_asset_id,
      version_change: metadata.version_change,
      source_type: String(source.type || "local-file"),
      source_json: JSON.stringify(source),
      source_path: sourcePath,
      provider_asset_id: String(source.provider_asset_id || ""),
      logical_output_id: String(source.logical_output_id || ""),
      metadata_json: JSON.stringify(unknownMetadata),
      search_text: searchText,
      tags_text: tagsText,
      business_search_text: businessSearchText,
      source_search_text: sourceSearchText,
      media_kind: mediaKind,
      source_group: sourceGroup,
      conversation_id: conversationId,
      generation_batch: generationBatch,
      generation_session_key: sessionKey,
      created_at: metadata.created_at,
      created_at_epoch: createdAtTimestamp(metadata.created_at),
      updated_at: metadata.updated_at,
      sort_name: assetSortName(metadata),
    });
    database.prepare("DELETE FROM asset_tags WHERE project_id = ? AND asset_id = ?").run(metadata.project_id, metadata.id);
    const insertTag = database.prepare("INSERT OR IGNORE INTO tags (id, normalized_name, name) VALUES (?, ?, ?)");
    const relateTag = database.prepare("INSERT OR IGNORE INTO asset_tags (project_id, asset_id, tag_id) VALUES (?, ?, ?)");
    for (const tag of metadata.tags) {
      const normalized = tag.trim().toLocaleLowerCase();
      if (!normalized) continue;
      const tagId = `tag-${createHash("sha256").update(normalized).digest("hex").slice(0, 20)}`;
      insertTag.run(tagId, normalized, tag.trim());
      relateTag.run(metadata.project_id, metadata.id, tagId);
    }
    if (metadata.group) {
      // Casing is already canonical (normalized at the top of saveAsset);
      // this only materializes a brand-new group row at the tail position.
      const nextPosition = database.prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next FROM groups WHERE project_id = ?",
      ).get(metadata.project_id).next;
      database.prepare(
        "INSERT OR IGNORE INTO groups (project_id, name, created_at, position, color) VALUES (?, ?, ?, ?, '')",
      ).run(metadata.project_id, metadata.group, metadata.created_at, nextPosition);
    }
    database.prepare(`
      INSERT INTO asset_versions (project_id, asset_id, parent_asset_id, change_summary, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id, asset_id) DO UPDATE SET
        parent_asset_id = excluded.parent_asset_id,
        change_summary = excluded.change_summary,
        created_at = excluded.created_at
    `).run(metadata.project_id, metadata.id, metadata.parent_asset_id, metadata.version_change, metadata.created_at);
    // The upsert above never touches deleted_at, so the stored row is the
    // authority on whether this save must stay out of the search index.
    const storedDeletedAt = storedSearchRow?.deleted_at || null;
    syncAssetFtsEntry(database, metadata.project_id, metadata.id, searchText, storedDeletedAt);
    replaceAssetShortTerms(database, metadata.project_id, metadata.id, storedSearchRow?.search_text || "", searchText, storedDeletedAt);
    if (options.recipeSnapshot) insertRecipeSnapshot(database, options.recipeSnapshot);
    if (options.enqueueDerivative) {
      database.prepare(`
        INSERT INTO derivative_jobs (project_id, asset_id, status, attempts, created_at, updated_at)
        VALUES (?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(project_id, asset_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at
      `).run(metadata.project_id, metadata.id, metadata.updated_at, metadata.updated_at);
    }
    if (options.clearAutomaticIngestSuppression) {
      const hashes = normalizeSuppressionHashes(options.clearAutomaticIngestSuppression);
      database.prepare(`
        DELETE FROM automatic_ingest_suppressions
        WHERE project_id = ?
          AND ((? != '' AND content_sha256 = ?)
            OR (? != '' AND pixel_sha256 = ? AND (? = '' OR pixel_hash_version = ?)))
      `).run(
        metadata.project_id,
        hashes.content_sha256,
        hashes.content_sha256,
        hashes.pixel_sha256,
        hashes.pixel_sha256,
        hashes.pixel_hash_version,
        hashes.pixel_hash_version,
      );
      // A non-automatic arrival under a provider identity also lifts the
      // identity list (manual web capture re-admits the id it carries).
      const identityKey = automaticIngestIdentityKey(metadata.project_id, metadata);
      if (identityKey) {
        database.prepare(`
          DELETE FROM automatic_ingest_identity_suppressions
          WHERE project_id = ? AND logical_output_id = ? AND media_kind = ?
        `).run(metadata.project_id, identityKey, automaticIngestIdentityKind(mediaKind));
      }
    }
    if (Array.isArray(options.libraryChanges) && options.libraryChanges.length) {
      // The commit helper is store-instance state (transaction-wrapped); callers
      // inside createSqliteAssetStore pass it so the journal rows land in the
      // same transaction as the asset write.
      if (typeof helpers.commitLibraryChanges !== "function") {
        throw new Error("saveAsset requires commitLibraryChanges to record its library change.");
      }
      helpers.commitLibraryChanges(options.libraryChanges);
    }
  });
  // The suppression lookup and the insert must share one write lock. Otherwise
  // a deletion can commit its suppression between the preflight lookup and the
  // asset row insert, which would resurrect a deleted automatic capture.
  if (options.rejectAutomaticIngestSuppression) write.immediate();
  else write();
}

/**
 * Only `references_json` is refreshed on conflict, and only so that rights
 * recorded after archival reach the stored snapshot. Every other column is part
 * of the frozen recipe and must stay immutable. See `refreshReferenceRights` in
 * `lib/recipe-snapshot.mjs`; the previous `INSERT OR IGNORE` silently discarded
 * those annotations.
 */
function insertRecipeSnapshot(database, snapshot) {
  database.prepare(`
    INSERT INTO recipe_snapshots (
      project_id, asset_id, snapshot_id, schema_version, recipe_digest, prompt_digest,
      effective_prompt, user_prompt, negative_prompt, prompt_status, generation_tool,
      model, provider, skill, style, ratio, theme, references_json, provenance_json,
      change_summary, created_at
    ) VALUES (
      @project_id, @asset_id, @snapshot_id, @schema_version, @recipe_digest, @prompt_digest,
      @effective_prompt, @user_prompt, @negative_prompt, @prompt_status, @generation_tool,
      @model, @provider, @skill, @style, @ratio, @theme, @references_json, @provenance_json,
      @change_summary, @created_at
    )
    ON CONFLICT (project_id, asset_id, snapshot_id) DO UPDATE SET
      references_json = excluded.references_json
  `).run({
    ...snapshot,
    references_json: JSON.stringify(snapshot.references || []),
    provenance_json: JSON.stringify(snapshot.provenance || {}),
  });
}

export function backfillRecipeSnapshots(database) {
  const rows = database.prepare(`
    SELECT a.* FROM assets a
    LEFT JOIN recipe_snapshots r ON r.project_id = a.project_id AND r.asset_id = a.id
    WHERE r.snapshot_id IS NULL
    ORDER BY a.project_id, a.created_at, a.id
  `).all();
  for (const row of rows) {
    const asset = recipeAssetFromRow(row);
    insertRecipeSnapshot(database, buildRecipeSnapshot(asset, {
      createdAt: row.updated_at || row.created_at,
      changeSummary: row.version_change || "Backfilled current recipe",
    }));
  }
}

export function sqliteRecipeHistory(database, assetRow) {
  const snapshots = database.prepare(`
    SELECT * FROM recipe_snapshots
    WHERE project_id = ? AND asset_id = ?
    ORDER BY created_at, rowid
  `).all(assetRow.project_id, assetRow.id).map(snapshotRowToObject);
  const current = buildRecipeSnapshot(recipeAssetFromRow(assetRow));
  const active = snapshots.find((snapshot) => snapshot.recipe_digest === current.recipe_digest)
    || snapshots.at(-1)
    || current;
  return {
    project_id: assetRow.project_id,
    asset_id: assetRow.id,
    active_snapshot_id: active.snapshot_id,
    snapshots: snapshots.length ? snapshots : [current],
  };
}

function snapshotRowToObject(row) {
  return {
    snapshot_id: row.snapshot_id,
    schema_version: row.schema_version,
    project_id: row.project_id,
    asset_id: row.asset_id,
    recipe_digest: row.recipe_digest,
    prompt_digest: row.prompt_digest,
    effective_prompt: row.effective_prompt,
    user_prompt: row.user_prompt,
    negative_prompt: row.negative_prompt,
    prompt_status: row.prompt_status,
    generation_tool: row.generation_tool,
    model: row.model,
    provider: row.provider,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    theme: row.theme,
    // Normalised on read so a snapshot written before the rights matrix comes
    // back with the same shape the JSON store produces. Without this, "nobody
    // has reviewed this reference yet" would be absent from SQLite rows rather
    // than visibly unknown, and the two stores would disagree.
    references: normalizeSnapshotReferences(parseJson(row.references_json, [])),
    provenance: parseJson(row.provenance_json, {}),
    change_summary: row.change_summary,
    created_at: row.created_at,
  };
}

function recipeAssetFromRow(row) {
  const metadata = parseJson(row.metadata_json, {});
  return {
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    prompt: row.prompt,
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    version_change: row.version_change,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source: parseJson(row.source_json, {}),
  };
}

export function rowToAsset(database, row, options = {}) {
  const metadata = parseJson(row.metadata_json, {});
  const source = parseJson(row.source_json, {});
  const includeRelations = options.includeRelations !== false;
  const asset = {
    ...metadata,
    id: row.id,
    project_id: row.project_id,
    asset: row.asset,
    image_path: row.original_path,
    prompt_path: null,
    prompt: row.prompt,
    content_sha256: row.content_sha256 || "",
    pixel_sha256: row.pixel_sha256 || "",
    skill: row.skill,
    style: row.style,
    ratio: row.ratio,
    business_fields: parseJson(row.business_fields_json, {}),
    theme: row.theme,
    tags: [],
    favorite: Boolean(row.favorite),
    archived: Boolean(row.archived),
    deleted_at: row.deleted_at || null,
    group: row.group_name,
    category: row.category,
    rating: row.rating,
    parent_asset_id: row.parent_asset_id,
    version_change: row.version_change,
    child_asset_ids: [],
    created_at: row.created_at,
    updated_at: row.updated_at,
    source,
    preview_path: row.preview_path,
    medium_path: row.medium_path,
    thumbnail_path: row.thumbnail_path,
    // Dominant colors as plain hex strings, largest share first. The full
    // {hex, ratio} entries stay internal: callers only need the swatch order.
    palette: paletteJsonToHexes(row.palette_json),
  };
  if (!includeRelations) return withRuntimeUrls(asset);

  const recipe = sqliteRecipeHistory(database, row);
  asset.tags = database.prepare(`
    SELECT t.name FROM tags t JOIN asset_tags at ON at.tag_id = t.id
    WHERE at.project_id = ? AND at.asset_id = ? ORDER BY t.name COLLATE NOCASE
  `).all(row.project_id, row.id).map((tag) => tag.name);
  asset.child_asset_ids = database.prepare("SELECT asset_id FROM asset_versions WHERE project_id = ? AND parent_asset_id = ? ORDER BY created_at, asset_id").all(row.project_id, row.id).map((child) => child.asset_id);
  asset.recipe_snapshots = recipe.snapshots;
  asset.active_recipe_snapshot_id = recipe.active_snapshot_id;
  return withRuntimeUrls(asset);
}

/**
 * Derivative routes serve with a one-year immutable cache and the derivative
 * file names are keyed by asset id, so a media replacement would keep serving
 * the previous pixels forever. The content version (content_sha256 prefix)
 * in `?v=` changes whenever the bytes change. Original URLs need no version:
 * a replacement always writes the original under a new file name, and the
 * fallback must stay equal to image_url for renderer comparisons.
 */
function contentVersionParam(asset) {
  const hash = String(asset?.content_sha256 || "").trim();
  return hash ? `?v=${encodeURIComponent(hash.slice(0, 12))}` : "";
}

function withRuntimeUrls(asset) {
  const base = `/library/${encodeURIComponent(asset.project_id)}`;
  const original = `${base}/images/${encodeURIComponent(asset.asset)}`;
  const version = contentVersionParam(asset);
  return {
    ...asset,
    // Task 382: read-only display name — the search-scope view of the stored
    // file name with machine-generated segments removed. Not persisted, not
    // searchable, never used for ordering (sort_name stays the sort key).
    display_name: searchableAssetName(asset.asset) || asset.asset,
    image_url: original,
    preview_url: asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp${version}` : original,
    medium_url: asset.medium_path ? `${base}/mediums/${encodeURIComponent(asset.id)}.webp${version}` : (asset.preview_path ? `${base}/previews/${encodeURIComponent(asset.id)}.webp${version}` : original),
    thumbnail_url: asset.thumbnail_path ? `${base}/thumbnails/${encodeURIComponent(asset.id)}.webp${version}` : original,
    preview_ready: Boolean(asset.preview_path),
    medium_ready: Boolean(asset.medium_path),
    thumbnail_ready: Boolean(asset.thumbnail_path),
    prompt_file: null,
  };
}

// Stay far below SQLite's bound-parameter ceiling so one statement per chunk
// covers any page size without risking "too many SQL variables".
const TAG_LOOKUP_BATCH_SIZE = 500;

/**
 * List pages build assets with `rowToAsset(..., { includeRelations: false })`,
 * which leaves `tags` empty for speed. The inspector edits tags straight from
 * that list payload, so an empty array would make its next save overwrite the
 * real tags with nothing. Refill them for the whole page in batched queries —
 * never per asset. Ordering matches the includeRelations branch exactly
 * (`ORDER BY t.name COLLATE NOCASE`); each asset lands in exactly one chunk,
 * so per-chunk ordering still yields the full per-asset order.
 */
export function attachAssetTags(database, projectId, assets) {
  if (!Array.isArray(assets) || !assets.length) return assets;
  const tagsByAssetId = new Map(assets.map((asset) => [asset.id, []]));
  const ids = [...tagsByAssetId.keys()];
  for (let start = 0; start < ids.length; start += TAG_LOOKUP_BATCH_SIZE) {
    const batch = ids.slice(start, start + TAG_LOOKUP_BATCH_SIZE);
    const rows = database.prepare(`
      SELECT at.asset_id AS asset_id, t.name AS name
      FROM asset_tags at JOIN tags t ON t.id = at.tag_id
      WHERE at.project_id = ? AND at.asset_id IN (${batch.map(() => "?").join(",")})
      ORDER BY t.name COLLATE NOCASE
    `).all(projectId, ...batch);
    for (const row of rows) tagsByAssetId.get(row.asset_id)?.push(row.name);
  }
  for (const asset of assets) asset.tags = tagsByAssetId.get(asset.id) || [];
  return assets;
}
