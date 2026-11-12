// Utility helpers for SQLite store (task 394). Pure moves; no behavior changes.
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInside } from "../path-safety.mjs";
import { assetStoreError } from "../asset-version-history.mjs";

export const IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);
export const MEDIA_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS]);
// Shared with the gallery's isVideoAsset rule: explicit media_kind wins, then the
// file extension. Exposed to SQL via mosa_media_kind for the V2 type filter.
export function mediaKindOf(asset = {}) {
  const kind = asset?.source?.media_kind || asset?.business_fields?.media_kind;
  if (kind === "video") return "video";
  if (kind === "image") return "image";
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}
export const DEFAULT_PROJECT_ID = "default";
export const DERIVED_MAINTENANCE_BATCH_SIZE = 500;

export function normalizeParentAssetId(value) {
  return value ? sanitizeId(value, "asset") : null;
}

export function sanitizeProjectId(value) { return sanitizeId(value || DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID); }
export function sanitizeId(value, fallback) { return String(value || fallback).replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || fallback; }
export function slugName(value) { return sanitizeId(String(value || "asset").replace(/\.[^.]+$/, ""), "asset").slice(0, 56); }
export function shortStamp() { return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`; }
export function uniqueArray(values) { return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))]; }
export function normalizeGroupName(value) { return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80); }

export function normalizeGroupColor(value) {
  const color = String(value || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : "";
}

/**
 * Resolves a requested group name to the stored spelling of an existing
 * (case-insensitively equal) group row. Every assignment write path funnels
 * through this so `assets.group_name` and `groups.name` never diverge by case
 * alone — the sidebar count join and the gallery facet filter both compare
 * `group_name` with SQLite's default BINARY collation.
 */
export function canonicalGroupName(database, projectId, name) {
  const normalized = normalizeGroupName(name);
  if (!normalized) return "";
  const row = database.prepare(
    "SELECT name FROM groups WHERE project_id = ? AND name = ? COLLATE NOCASE",
  ).get(sanitizeProjectId(projectId || DEFAULT_PROJECT_ID), normalized);
  return row ? row.name : "";
}
export function resolveRequiredPath(value, label) { if (!value || typeof value !== "string") throw assetStoreError("IMAGE_PATH_REQUIRED", `${label} is required.`); return resolve(value); }
/** A missing file is an ordinary form mistake, not a 500. */
export async function statForImport(requestedPath) {
  try {
    return await lstat(requestedPath);
  } catch (error) {
    if (error?.code === "ENOENT") throw assetStoreError("IMAGE_PATH_NOT_FOUND", `imagePath does not exist: ${requestedPath}`);
    throw error;
  }
}
export function isSafeChildPath(parent, child) { return isPathInside(parent, child); }
export function now() { return new Date().toISOString(); }
