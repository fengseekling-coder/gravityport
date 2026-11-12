// Backfill and business_fields helpers for SQLite store (task 394). Pure moves; no behavior changes.
import { existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { imageDecoder } from "../image-decode-client.js";
import { orientedImageDimensions } from "../image-dimensions.js";
import { readVideoMetadataFromFile, readVideoMetadataFromFileSync } from "../video-metadata.js";
import { parseBusinessFields, parseJson } from "./rows-util.mjs";
import { DERIVED_MAINTENANCE_BATCH_SIZE, VIDEO_EXTENSIONS } from "./util.mjs";

const ALLOWED_GROUP_COLUMNS = new Set(["category", "style", "group_name"]);

export function countNamedValues(database, projectId, column, limit = 0) {
  if (!ALLOWED_GROUP_COLUMNS.has(column)) throw new Error(`Unsafe column name: ${column}`);
  const rows = database.prepare(`
    SELECT ${column} AS name, COUNT(*) AS count FROM assets
    WHERE project_id = ? AND archived = 0 AND deleted_at IS NULL AND ${column} != ''
    GROUP BY ${column} ORDER BY count DESC, name COLLATE NOCASE${limit ? " LIMIT ?" : ""}
  `).all(...(limit ? [projectId, limit] : [projectId]));
  return rows.map((row) => [row.name, row.count]);
}

// updateMetadata merges business_fields key-by-key, like source: a plain
// object patch carries only the keys it names (a null value deletes its key),
// so a partial write — PATCH body, MCP tool, bridge caller — can never drop
// recorded dimensions it did not mention. Anything else (absent, null, array,
// string) leaves the stored object untouched; there is no whole-column clear.
export function mergeBusinessFieldsPatch(current, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return current;
  const merged = { ...(current || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

// Imports (drag, paste, file picker, folder import) hand the store a bare
// staged path with no business_fields, and videos never reach the derivative
// worker that backfills image dimensions, so width/height/duration_seconds
// must come from the file itself. Only missing keys are filled; whatever the
// caller supplied stays untouched. Unreadable containers (WebM, truncated
// files) return null and change nothing.
export async function missingVideoDimensionFields(imagePath, businessFields) {
  if (!VIDEO_EXTENSIONS.has(extname(imagePath).toLowerCase())) return null;
  const fields = parseBusinessFields(businessFields);
  const positive = (key) => Number(fields[key]) > 0;
  if (positive("width") && positive("height") && positive("duration_seconds")) return null;
  const fileMeta = await readVideoMetadataFromFile(imagePath).catch(() => null);
  if (!fileMeta) return null;
  const merged = { ...fields };
  let changed = false;
  if (!positive("width") && fileMeta.width > 0) {
    merged.width = fileMeta.width;
    changed = true;
  }
  if (!positive("height") && fileMeta.height > 0) {
    merged.height = fileMeta.height;
    changed = true;
  }
  if (!positive("duration_seconds") && fileMeta.durationSeconds !== null && fileMeta.durationSeconds > 0) {
    merged.duration_seconds = fileMeta.durationSeconds;
    changed = true;
  }
  return changed ? merged : null;
}

// Images get their display ratio at insert (task 292): cards are laid out
// from width/height the moment they land, instead of sitting as 1:1 boxes
// until the derivative pass writes the ratio back — a write-back that never
// happens for images beyond the derivative pixel limit. Dimensions come from
// sharp metadata, header only (no pixel decode); deliberately without
// limitInputPixels so oversized images still report their true ratio. The
// EXIF orientation swap is the shared orientedImageDimensions helper — it
// must match completeDerivativeJob exactly or cards change ratio twice. Only
// missing keys are filled; an unreadable or unsupported file returns null and
// changes nothing, never failing the import.
export async function missingImageDimensionFields(imagePath, businessFields) {
  if (VIDEO_EXTENSIONS.has(extname(imagePath).toLowerCase())) return null;
  const fields = parseBusinessFields(businessFields);
  if (Number(fields.width) > 0 && Number(fields.height) > 0) return null;
  const metadata = await imageDecoder.metadata(imagePath, { limitInputPixels: false }).catch(() => null);
  if (!metadata) return null;
  const { width, height } = orientedImageDimensions(metadata);
  const merged = { ...fields };
  let changed = false;
  if (!(Number(merged.width) > 0) && Number.isFinite(width) && width > 0) {
    merged.width = width;
    changed = true;
  }
  if (!(Number(merged.height) > 0) && Number.isFinite(height) && height > 0) {
    merged.height = height;
    changed = true;
  }
  return changed ? merged : null;
}

// Manual imports and Cowart captures hand the store no file size, and the
// property panel's size line reads business_fields.file_bytes. Only a missing
// or non-positive key is filled, from the managed file itself via stat;
// whatever the caller supplied (web capture stores file-read sizes) stays
// untouched. A stat failure must never fail the import, so unreadable files
// change nothing.
export async function missingFileBytesField(imagePath, businessFields) {
  const fields = parseBusinessFields(businessFields);
  if (Number(fields.file_bytes) > 0) return null;
  const stats = await stat(imagePath).catch(() => null);
  if (!stats || !(stats.size > 0)) return null;
  return { ...fields, file_bytes: stats.size };
}

const FILE_BYTES_BACKFILL_MARKER_KEY = "file_bytes_backfill_v1";

// One-time backfill of file_bytes from the original files: rows stored before
// the createAsset fill (manual imports, Cowart captures) carry no size, so the
// property panel's size line shows "—". Trash rows are included. The SQL
// prefilter keeps an 8000-row library from reading every row into JS — only
// rows without a positive file_bytes reach the stat loop. Key-level merge on
// business_fields_json — only file_bytes is written; created_at, updated_at
// and every other key stay byte-identical. Runs from deferred maintenance in
// keyset-paged batches (rule 27): each batch is one BEGIN IMMEDIATE
// transaction holding its own page query, the file stats and the writes — a
// crash mid-pass leaves the marker unwritten and the next open reruns the
// pass (fixed rows drop out of the prefilter, so the rerun only touches what
// is left). The completion marker and the per-project announcement share the
// final transaction; the caller's catch never writes the marker.
export async function backfillFileBytesFromFiles(database, helpers = {}, { batchSize = DERIVED_MAINTENANCE_BATCH_SIZE, onBatchCommitted, onRowsChanged, signal } = {}) {
  const { commitLibraryChanges } = helpers;
  const stats = { assetsUpdated: 0, filesUnreadable: 0 };
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(FILE_BYTES_BACKFILL_MARKER_KEY)) return stats;
  const touchedProjectIds = new Set();
  // CAST("123" AS REAL) = 123 keeps numeric strings out; invalid or
  // non-object JSON and non-numeric values fall through to the JS check.
  const page = database.prepare(`
    SELECT project_id, id, original_path, business_fields_json FROM assets
    WHERE original_path IS NOT NULL AND original_path != ''
      AND (
        business_fields_json IS NULL OR business_fields_json = ''
        OR NOT json_valid(business_fields_json)
        OR json_extract(business_fields_json, '$.file_bytes') IS NULL
        OR CAST(json_extract(business_fields_json, '$.file_bytes') AS REAL) <= 0
      )
      AND (project_id > ? OR (project_id = ? AND id > ?))
    ORDER BY project_id, id
    LIMIT ?
  `);
  const update = database.prepare(
    "UPDATE assets SET business_fields_json = ? WHERE project_id = ? AND id = ?",
  );
  let cursorProject = "";
  let cursorId = "";
  for (;;) {
    if (signal?.aborted) return stats;
    let lastKey = null;
    let pageWasShort = false;
    const updatedBefore = stats.assetsUpdated;
    const processed = database.transaction(() => {
      // Re-checked under the write lock: a concurrent opener may have
      // completed this pass between the pre-read and acquiring the lock.
      if (markerQuery.get(FILE_BYTES_BACKFILL_MARKER_KEY)) return false;
      const rows = page.all(cursorProject, cursorProject, cursorId, batchSize);
      for (const row of rows) {
        const parsed = parseJson(row.business_fields_json, null);
        const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        if (Number(fields.file_bytes) > 0) continue;
        if (!row.original_path || !existsSync(row.original_path)) continue;
        let size = 0;
        try {
          size = statSync(row.original_path).size;
        } catch {
          stats.filesUnreadable += 1;
          continue;
        }
        if (!(size > 0)) {
          stats.filesUnreadable += 1;
          continue;
        }
        update.run(JSON.stringify({ ...fields, file_bytes: size }), row.project_id, row.id);
        stats.assetsUpdated += 1;
        touchedProjectIds.add(row.project_id);
      }
      pageWasShort = rows.length < batchSize;
      lastKey = rows.length ? rows[rows.length - 1] : null;
      if (pageWasShort) {
        // Last page (or none left): the announcement and the completion
        // marker share this transaction, so a crash either reruns the whole
        // pass or commits both together.
        if (stats.assetsUpdated) {
          // One unclassified change per touched project so every open window
          // takes its full-recovery path and re-renders the corrected cards;
          // per-asset events would spam the journal for a one-time sweep.
          commitLibraryChanges?.([...touchedProjectIds].map((projectId) => ({
            projectId,
            kind: "library-backfilled",
            entityType: "asset",
            entityId: "",
            assetIds: [],
            detail: { reason: "file-bytes-backfill-v1", assetsUpdated: stats.assetsUpdated },
          })));
        }
        database.prepare(`
          INSERT INTO library_meta (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(FILE_BYTES_BACKFILL_MARKER_KEY, new Date().toISOString(), new Date().toISOString());
      }
      return true;
    }).immediate();
    if (!processed || !lastKey) break;
    cursorProject = lastKey.project_id;
    cursorId = lastKey.id;
    if (stats.assetsUpdated > updatedBefore && typeof onRowsChanged === "function") {
      onRowsChanged({ changed: stats.assetsUpdated - updatedBefore, projects: [...touchedProjectIds] });
    }
    if (typeof onBatchCommitted === "function") onBatchCommitted();
    if (pageWasShort) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (stats.assetsUpdated > 0) {
    console.warn(`[MOSA] file_bytes_backfill_v1: filled file size on ${stats.assetsUpdated} asset(s) from their files.`);
  }
  return stats;
}

const VIDEO_METADATA_BACKFILL_MARKER_KEY = "video_metadata_backfill_v1";

// One-time backfill of video width/height/duration_seconds from the original
// files (see video-metadata.ts): captures archived before the store read
// files carry null dimensions or a provider-reported duration that does not
// match the video (Jimeng reported 7 s for 6.08 s files), and imports from
// before the per-file read carry no dimensions at all. Trash rows are
// included; images are untouched. Key-level merge on business_fields_json —
// only the three keys named here are written; created_at, updated_at, recipe
// snapshots, stacking and grouping stay byte-identical. Runs from deferred
// maintenance in keyset-paged batches (rule 27), one BEGIN IMMEDIATE
// transaction per batch holding its page query, the file reads and the
// writes; the completion marker and the per-project announcement share the
// final batch's transaction. A crash mid-pass leaves the marker unwritten and
// the next open reruns the pass over what is left; the caller's catch never
// writes the marker.
export async function backfillVideoMetadataFromFiles(database, helpers = {}, { batchSize = DERIVED_MAINTENANCE_BATCH_SIZE, onBatchCommitted, onRowsChanged, signal } = {}) {
  const { commitLibraryChanges } = helpers;
  const stats = { assetsUpdated: 0, filesUnreadable: 0 };
  const markerQuery = database.prepare("SELECT 1 FROM library_meta WHERE key = ?");
  if (markerQuery.get(VIDEO_METADATA_BACKFILL_MARKER_KEY)) return stats;
  const touchedProjectIds = new Set();
  const page = database.prepare(`
    SELECT project_id, id, original_path, business_fields_json FROM assets
    WHERE media_kind = 'video'
      AND (project_id > ? OR (project_id = ? AND id > ?))
    ORDER BY project_id, id
    LIMIT ?
  `);
  const update = database.prepare(
    "UPDATE assets SET business_fields_json = ? WHERE project_id = ? AND id = ?",
  );
  let cursorProject = "";
  let cursorId = "";
  for (;;) {
    if (signal?.aborted) return stats;
    let lastKey = null;
    let pageWasShort = false;
    const updatedBefore = stats.assetsUpdated;
    const processed = database.transaction(() => {
      // Re-checked under the write lock: a concurrent opener may have
      // completed this pass between the pre-read and acquiring the lock.
      if (markerQuery.get(VIDEO_METADATA_BACKFILL_MARKER_KEY)) return false;
      const rows = page.all(cursorProject, cursorProject, cursorId, batchSize);
      for (const row of rows) {
        if (!row.original_path || !existsSync(row.original_path)) continue;
        const fileMeta = readVideoMetadataFromFileSync(row.original_path);
        if (!fileMeta) {
          stats.filesUnreadable += 1;
          console.warn(`[MOSA] video_metadata_backfill_v1: unreadable video file skipped: ${basename(String(row.original_path))}`);
          continue;
        }
        const parsed = parseJson(row.business_fields_json, null);
        const fields = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        const merged = { ...fields };
        let changed = false;
        if (!(Number(fields.width) > 0) && fileMeta.width > 0) {
          merged.width = fileMeta.width;
          changed = true;
        }
        if (!(Number(fields.height) > 0) && fileMeta.height > 0) {
          merged.height = fileMeta.height;
          changed = true;
        }
        const storedDuration = Number(fields.duration_seconds);
        const fileDuration = fileMeta.durationSeconds;
        const durationMissing = !(storedDuration > 0);
        const durationOff = fileDuration !== null && storedDuration > 0 && Math.abs(storedDuration - fileDuration) > 0.5;
        if (fileDuration !== null && fileDuration > 0 && (durationMissing || durationOff)) {
          merged.duration_seconds = fileDuration;
          changed = true;
        }
        if (!changed) continue;
        update.run(JSON.stringify(merged), row.project_id, row.id);
        stats.assetsUpdated += 1;
        touchedProjectIds.add(row.project_id);
      }
      pageWasShort = rows.length < batchSize;
      lastKey = rows.length ? rows[rows.length - 1] : null;
      if (pageWasShort) {
        if (stats.assetsUpdated) {
          // One unclassified change per touched project so every open window
          // takes its full-recovery path and re-renders the corrected cards;
          // per-asset events would spam the journal for a one-time sweep.
          commitLibraryChanges?.([...touchedProjectIds].map((projectId) => ({
            projectId,
            kind: "library-backfilled",
            entityType: "asset",
            entityId: "",
            assetIds: [],
            detail: { reason: "video-metadata-backfill-v1", assetsUpdated: stats.assetsUpdated },
          })));
        }
        database.prepare(`
          INSERT INTO library_meta (key, value, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(VIDEO_METADATA_BACKFILL_MARKER_KEY, new Date().toISOString(), new Date().toISOString());
      }
      return true;
    }).immediate();
    if (!processed || !lastKey) break;
    cursorProject = lastKey.project_id;
    cursorId = lastKey.id;
    if (stats.assetsUpdated > updatedBefore && typeof onRowsChanged === "function") {
      onRowsChanged({ changed: stats.assetsUpdated - updatedBefore, projects: [...touchedProjectIds] });
    }
    if (typeof onBatchCommitted === "function") onBatchCommitted();
    if (pageWasShort) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (stats.assetsUpdated > 0) {
    console.warn(`[MOSA] video_metadata_backfill_v1: filled width/height/duration on ${stats.assetsUpdated} video asset(s) from their files.`);
  }
  return stats;
}
