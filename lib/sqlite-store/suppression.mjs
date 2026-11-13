// Automatic ingest suppression helpers for SQLite store (task 394). Pure moves; no behavior changes.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { PIXEL_HASH_VERSION, safePixelDigest } from "../image-pixel-hash.js";
import {
  DEFAULT_PROJECT_ID,
  mediaKindOf,
  now,
  sanitizeProjectId,
} from "./util.mjs";

export function normalizeHash(value) {
  const hash = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", rejectHash);
    stream.once("end", resolveHash);
  });
  return hash.digest("hex");
}

export function normalizeSuppressionHashes(input = {}) {
  return {
    content_sha256: normalizeHash(input.content_sha256 ?? input.contentSha256),
    pixel_sha256: normalizeHash(input.pixel_sha256 ?? input.pixelSha256),
    pixel_hash_version: String(input.pixel_hash_version ?? input.pixelHashVersion ?? "").trim(),
  };
}

// Site-identity suppression key (task 300). Web captures store
// source.logical_output_id already composed by web-capture-ingest's
// logicalCaptureKey (`<project>\u001f<provider>\u001fasset:<providerAssetId>`);
// rows without one but with a provider asset id on a web-* source compose the
// same shape here. The two sides must agree byte for byte — a capture keyed by
// the ingest side must hit the suppression recorded from the deleted row.
export function automaticIngestIdentityKey(projectId, assetLike) {
  const source = assetLike?.source && typeof assetLike.source === "object" && !Array.isArray(assetLike.source) ? assetLike.source : {};
  const logicalOutputId = String(source.logical_output_id || "").trim();
  if (logicalOutputId) return logicalOutputId;
  const providerAssetId = String(source.provider_asset_id || "").trim();
  const sourceType = String(assetLike?.source_type || assetLike?.sourceType || source.type || "").trim().toLowerCase();
  if (!providerAssetId || !sourceType.startsWith("web-")) return "";
  const provider = String(source.provider || "").trim().toLowerCase() || sourceType.slice("web-".length);
  return `${projectId}\u001f${provider}\u001fasset:${providerAssetId}`;
}

// The identity list only distinguishes video from image; anything unknown
// counts as the image default so a key never forks on an unsettled kind.
export function automaticIngestIdentityKind(mediaKind) {
  return mediaKind === "video" ? "video" : "image";
}

// Identity-list writers for the deletion lifecycle. Callers run them inside
// their own transaction so the list commits atomically with the row change.
export function recordIdentitySuppressionRow(database, projectId, assetLike, { deletedAt, reason = "user-deleted" }) {
  const key = automaticIngestIdentityKey(projectId, assetLike);
  if (!key) return;
  database.prepare(`
    INSERT INTO automatic_ingest_identity_suppressions (project_id, logical_output_id, media_kind, deleted_at, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_id, logical_output_id, media_kind) DO UPDATE SET
      deleted_at = excluded.deleted_at,
      reason = excluded.reason
  `).run(projectId, key, automaticIngestIdentityKind(mediaKindOf(assetLike)), deletedAt, reason);
}

export function clearIdentitySuppressionRow(database, projectId, assetLike) {
  const key = automaticIngestIdentityKey(projectId, assetLike);
  if (!key) return;
  database.prepare(`
    DELETE FROM automatic_ingest_identity_suppressions
    WHERE project_id = ? AND logical_output_id = ? AND media_kind = ?
  `).run(projectId, key, automaticIngestIdentityKind(mediaKindOf(assetLike)));
}

export function normalizeSuppressionRecord(input = {}) {
  return {
    project_id: sanitizeProjectId(input.project_id || DEFAULT_PROJECT_ID),
    ...normalizeSuppressionHashes(input),
    deleted_at: String(input.deleted_at || now()),
    reason: String(input.reason || "user-deleted").trim().slice(0, 120) || "user-deleted",
  };
}

export function suppressionRowToObject(row) {
  return {
    project_id: row.project_id,
    content_sha256: row.content_sha256,
    pixel_sha256: row.pixel_sha256,
    pixel_hash_version: row.pixel_hash_version || "",
    deleted_at: row.deleted_at,
    reason: row.reason,
  };
}

export async function contentHashForAsset(asset, filesToUnlink) {
  const recorded = normalizeHash(asset.source?.content_sha256);
  if (recorded) return recorded;
  const originalPath = filesToUnlink.find((filePath) => filePath === asset.image_path) || "";
  if (!originalPath) return "";
  try {
    return await sha256File(originalPath);
  } catch {
    return "";
  }
}

export async function automaticSuppressionIdentityForAsset(asset, managedPaths) {
  const contentHash = await contentHashForAsset(asset, managedPaths);
  const storedPixelHash = normalizeHash(asset.source?.pixel_sha256);
  const storedPixelHashVersion = String(asset.source?.pixel_hash_version || "").trim();
  const recomputedPixelHash = (!storedPixelHash || storedPixelHashVersion !== PIXEL_HASH_VERSION) && asset.image_path
    ? await safePixelDigest(asset.image_path).catch(() => "")
    : "";
  const pixelHash = storedPixelHashVersion === PIXEL_HASH_VERSION && storedPixelHash
    ? storedPixelHash
    : (recomputedPixelHash || storedPixelHash);
  const pixelHashVersion = recomputedPixelHash
    ? PIXEL_HASH_VERSION
    : (pixelHash ? storedPixelHashVersion : "");
  return { contentHash, pixelHash, pixelHashVersion };
}
