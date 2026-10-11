import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";

import { normalizeEmbedding, topKNormalizedEmbeddings } from "./embedding-search.mjs";

export const VISUAL_RELATIONSHIP_INDEX_SCHEMA = 1;

export function visualRelationshipIndexRoot(userDataDir) {
  const root = String(userDataDir || "").trim();
  if (!root) throw visualIndexError("USER_DATA_REQUIRED", "Desktop userData directory is required for the visual relationship index.");
  return join(resolve(root), "visual-relationship-indexes");
}

export function visualRelationshipLibraryKey(libraryDir) {
  const library = String(libraryDir || "").trim();
  if (!library) throw visualIndexError("LIBRARY_DIR_REQUIRED", "Library directory is required for the visual relationship index.");
  return createHash("sha256").update(resolve(library)).digest("hex").slice(0, 24);
}

export function visualRelationshipIndexPath({ userDataDir, libraryDir }) {
  return join(
    visualRelationshipIndexRoot(userDataDir),
    visualRelationshipLibraryKey(libraryDir),
    "visual-relationships.sqlite",
  );
}

export function createVisualRelationshipIndex(options = {}) {
  const databasePath = resolve(options.databasePath || visualRelationshipIndexPath(options));
  mkdirSync(resolve(databasePath, ".."), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  initializeSchema(database);

  const cache = new Map();

  const api = {
    databasePath,

    upsertEmbedding(projectId, assetId, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const asset = normalizeId(assetId, "asset");
      const model = normalizeModelIdentity(input);
      const contentSha256 = normalizeSha256(input.contentSha256);
      const vector = normalizedVector(input.vector, model.dimension);
      const timestamp = new Date().toISOString();
      database.prepare(`
        INSERT INTO visual_embeddings (
          project_id, asset_id, model_id, model_revision, dimension,
          content_sha256, vector_blob, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, asset_id, model_id, model_revision) DO UPDATE SET
          dimension = excluded.dimension,
          content_sha256 = excluded.content_sha256,
          vector_blob = excluded.vector_blob,
          updated_at = excluded.updated_at
      `).run(
        project,
        asset,
        model.id,
        model.revision,
        model.dimension,
        contentSha256,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        timestamp,
        timestamp,
      );
      cache.delete(cacheKey(project, model));
      return {
        project_id: project,
        asset_id: asset,
        model_id: model.id,
        model_revision: model.revision,
        dimension: model.dimension,
        content_sha256: contentSha256,
        updated_at: timestamp,
      };
    },

    embeddingState(projectId, assetId, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const asset = normalizeId(assetId, "asset");
      const model = normalizeModelIdentity(input);
      const row = database.prepare(`
        SELECT dimension, content_sha256, updated_at
        FROM visual_embeddings
        WHERE project_id = ? AND asset_id = ? AND model_id = ? AND model_revision = ?
      `).get(project, asset, model.id, model.revision);
      if (!row) return { state: "missing", project_id: project, asset_id: asset, ...modelOutput(model) };
      if (Number(row.dimension) !== model.dimension) {
        return { state: "stale", reason: "dimension", project_id: project, asset_id: asset, ...modelOutput(model), updated_at: row.updated_at };
      }
      const contentSha256 = input.contentSha256 == null ? "" : normalizeSha256(input.contentSha256);
      if (contentSha256 && row.content_sha256 !== contentSha256) {
        return { state: "stale", reason: "content", project_id: project, asset_id: asset, ...modelOutput(model), updated_at: row.updated_at };
      }
      return { state: "current", project_id: project, asset_id: asset, ...modelOutput(model), updated_at: row.updated_at };
    },

    similarToAsset(projectId, assetId, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const asset = normalizeId(assetId, "asset");
      const model = normalizeModelIdentity(input);
      const row = database.prepare(`
        SELECT vector_blob
        FROM visual_embeddings
        WHERE project_id = ? AND asset_id = ? AND model_id = ? AND model_revision = ?
      `).get(project, asset, model.id, model.revision);
      if (!row) throw visualIndexError("EMBEDDING_NOT_FOUND", "No visual embedding exists for the requested asset and model.");
      return querySimilar(project, decodeVector(row.vector_blob, model.dimension), {
        ...input,
        model,
        excludeAssetIds: [...new Set([asset, ...(input.excludeAssetIds || [])])],
      });
    },

    querySimilar(projectId, vector, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const model = normalizeModelIdentity(input);
      return querySimilar(project, normalizedVector(vector, model.dimension), { ...input, model });
    },

    indexStatus(projectId, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const model = normalizeModelIdentity(input);
      const row = database.prepare(`
        SELECT COUNT(*) AS count, MIN(updated_at) AS oldest_at, MAX(updated_at) AS newest_at
        FROM visual_embeddings
        WHERE project_id = ? AND model_id = ? AND model_revision = ?
      `).get(project, model.id, model.revision);
      return {
        project_id: project,
        ...modelOutput(model),
        count: Number(row?.count || 0),
        oldest_at: row?.oldest_at || null,
        newest_at: row?.newest_at || null,
      };
    },

    deleteAsset(projectId, assetId) {
      const project = normalizeId(projectId || "default", "project");
      const asset = normalizeId(assetId, "asset");
      const result = database.prepare("DELETE FROM visual_embeddings WHERE project_id = ? AND asset_id = ?").run(project, asset);
      invalidateProjectCache(cache, project);
      return Number(result.changes || 0);
    },

    clearModel(projectId, input = {}) {
      const project = normalizeId(projectId || "default", "project");
      const model = normalizeModelIdentity(input);
      const result = database.prepare(`
        DELETE FROM visual_embeddings
        WHERE project_id = ? AND model_id = ? AND model_revision = ?
      `).run(project, model.id, model.revision);
      cache.delete(cacheKey(project, model));
      return Number(result.changes || 0);
    },

    pruneAssets(projectId, assetIds) {
      const project = normalizeId(projectId || "default", "project");
      const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map((value) => normalizeId(value, "asset")))];
      if (!ids.length) return 0;
      const result = database.prepare(`
        DELETE FROM visual_embeddings
        WHERE project_id = ?
          AND asset_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      `).run(project, JSON.stringify(ids));
      invalidateProjectCache(cache, project);
      return Number(result.changes || 0);
    },

    close() {
      // WAL note: this database opens with `journal_mode = WAL` (see createVisualRelationshipIndex()).
      // better-sqlite3's close() performs a final implicit WAL checkpoint, but we issue an
      // explicit TRUNCATE here so the WAL file is collapsed before we drop the connection.
      // That guarantees the next opener starts on a fresh WAL and avoids leaving a stale
      // `-wal` file behind when the runtime is replaced during an in-place update.
      try {
        database.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // pragma is a no-op if the WAL is already empty or the journal mode has changed.
      }
      cache.clear();
      database.close();
    },
  };

  function querySimilar(project, vector, input) {
    const model = input.model || normalizeModelIdentity(input);
    const limit = normalizeLimit(input.limit, 20, 250);
    const minScore = normalizeScore(input.minScore);
    const excluded = new Set((input.excludeAssetIds || []).map((value) => normalizeId(value, "asset")));
    const loaded = loadModelMatrix(database, cache, project, model);
    if (!loaded.ids.length) return [];
    const requested = Math.min(loaded.ids.length, Math.max(limit + excluded.size, limit));
    const ranked = topKNormalizedEmbeddings(loaded.matrix, model.dimension, vector, requested);
    const result = [];
    for (const item of ranked) {
      const id = loaded.ids[item.index];
      if (!id || excluded.has(id) || item.score < minScore) continue;
      result.push({
        asset_id: id,
        score: Number(item.score.toFixed(6)),
        model_id: model.id,
        model_revision: model.revision,
      });
      if (result.length >= limit) break;
    }
    return result;
  }

  return api;
}

function initializeSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS visual_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS visual_embeddings (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_revision TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      vector_blob BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id, model_id, model_revision),
      CHECK (dimension > 0)
    );
    CREATE INDEX IF NOT EXISTS visual_embeddings_model_idx
      ON visual_embeddings(project_id, model_id, model_revision, asset_id);
  `);
  const current = database.prepare("SELECT value FROM visual_index_meta WHERE key = 'schema_version'").get();
  if (current && Number(current.value) > VISUAL_RELATIONSHIP_INDEX_SCHEMA) {
    throw visualIndexError("SCHEMA_NEWER", "Visual relationship index schema is newer than this GravityPort build supports.");
  }
  database.prepare(`
    INSERT INTO visual_index_meta (key, value) VALUES ('schema_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(VISUAL_RELATIONSHIP_INDEX_SCHEMA));
}

function loadModelMatrix(database, cache, projectId, model) {
  const key = cacheKey(projectId, model);
  const cached = cache.get(key);
  if (cached) return cached;
  const rows = database.prepare(`
    SELECT asset_id, dimension, vector_blob
    FROM visual_embeddings
    WHERE project_id = ? AND model_id = ? AND model_revision = ?
    ORDER BY asset_id
  `).all(projectId, model.id, model.revision);
  const ids = [];
  const matrix = new Float32Array(rows.length * model.dimension);
  let count = 0;
  for (const row of rows) {
    if (Number(row.dimension) !== model.dimension) continue;
    const vector = decodeVector(row.vector_blob, model.dimension);
    matrix.set(vector, count * model.dimension);
    ids.push(row.asset_id);
    count += 1;
  }
  const loaded = {
    ids,
    matrix: count === rows.length ? matrix : matrix.slice(0, count * model.dimension),
  };
  cache.set(key, loaded);
  return loaded;
}

function normalizedVector(value, dimension) {
  let vector;
  if (value instanceof Float32Array) vector = new Float32Array(value);
  else if (Array.isArray(value)) vector = Float32Array.from(value);
  else throw visualIndexError("VECTOR_REQUIRED", "Visual embedding vector must be an array or Float32Array.");
  if (vector.length !== dimension) {
    throw visualIndexError("VECTOR_DIMENSION_MISMATCH", "Visual embedding vector length does not match the model dimension.");
  }
  let magnitude = 0;
  for (const number of vector) {
    if (!Number.isFinite(number)) throw visualIndexError("VECTOR_INVALID", "Visual embedding vector contains a non-finite value.");
    magnitude += number * number;
  }
  if (!(magnitude > 0)) throw visualIndexError("VECTOR_ZERO", "Visual embedding vector must not be all zeroes.");
  return normalizeEmbedding(vector);
}

function decodeVector(blob, dimension) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.byteLength !== dimension * Float32Array.BYTES_PER_ELEMENT) {
    throw visualIndexError("VECTOR_STORAGE_INVALID", "Stored visual embedding has an invalid byte length.");
  }
  const copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return new Float32Array(copy);
}

function normalizeModelIdentity(input) {
  const source = input?.model && typeof input.model === "object" ? input.model : input;
  const id = normalizeModelPart(source?.id || source?.modelId, "model id");
  const revision = normalizeModelPart(source?.revision || source?.modelRevision, "model revision");
  const dimension = Number(source?.dimension);
  if (!Number.isInteger(dimension) || dimension <= 0 || dimension > 8192) {
    throw visualIndexError("MODEL_DIMENSION_INVALID", "Visual model dimension must be an integer between 1 and 8192.");
  }
  return { id, revision, dimension };
}

function modelOutput(model) {
  return {
    model_id: model.id,
    model_revision: model.revision,
    dimension: model.dimension,
  };
}

function normalizeModelPart(value, label) {
  const candidate = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9._/-]{0,191}$/i.test(candidate) || candidate.includes("..")) {
    throw visualIndexError("MODEL_IDENTITY_INVALID", "Visual " + label + " is invalid.");
  }
  return candidate;
}

function normalizeId(value, label) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 256) throw visualIndexError("ID_INVALID", "Visual index " + label + " id is invalid.");
  return candidate;
}

function normalizeSha256(value) {
  const candidate = String(value || "").trim().toLowerCase();
  if (candidate && !/^[0-9a-f]{64}$/.test(candidate)) {
    throw visualIndexError("SHA256_INVALID", "Visual embedding content SHA-256 is invalid.");
  }
  return candidate;
}

function normalizeLimit(value, fallback, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(number)));
}

function normalizeScore(value) {
  if (value == null || value === "") return -1;
  const number = Number(value);
  if (!Number.isFinite(number) || number < -1 || number > 1) {
    throw visualIndexError("SCORE_INVALID", "Visual similarity minimum score must be between -1 and 1.");
  }
  return number;
}

function cacheKey(projectId, model) {
  return projectId + "\0" + model.id + "\0" + model.revision + "\0" + model.dimension;
}

function invalidateProjectCache(cache, projectId) {
  const prefix = projectId + "\0";
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function visualIndexError(code, message) {
  const error = new Error(message);
  error.code = "VISUAL_RELATIONSHIP_" + code;
  return error;
}
