/**
 * Type declarations for sqlite-asset-store.mjs
 * This file provides TypeScript types without migrating the implementation.
 */

import type { Database } from 'better-sqlite3';

export interface StoredAsset {
  id: string;
  project_id: string;
  asset: string;
  original_path: string;
  content_sha256: string;
  prompt?: string;
  skill?: string;
  style?: string;
  ratio?: string;
  business_fields?: Record<string, unknown>;
  theme?: string;
  tags?: string[];
  favorite?: boolean;
  archived?: boolean;
  deleted_at?: string | null;
  group?: string;
  category?: string;
  rating?: number;
  parent_asset_id?: string;
  version_change?: string;
  child_asset_ids?: string[];
  created_at?: string;
  updated_at?: string;
  source?: Record<string, unknown>;
  source_type?: string;
  image_path?: string;
  preview_path?: string;
  thumbnail_path?: string;
  /** Dominant colors as hex strings, largest share first; [] when not computed. */
  palette?: string[];
  image_url?: string;
  preview_url?: string;
  thumbnail_url?: string;
  prompt_file?: string;
  recipe_snapshots?: unknown[];
  active_recipe_snapshot_id?: string | null;
  stack?: { id: string; count: number; match_count?: number };
  stack_position?: number;
  [key: string]: unknown;
}

export interface AssetListFilters {
  projectId?: string;
  query?: string;
  source?: string;
  conversation?: string;
  generationBatch?: string;
  category?: string;
  style?: string;
  favorite?: boolean;
  recent?: boolean;
  createdAfterMs?: number;
  createdBeforeMs?: number;
  unorganized?: boolean;
  archived?: boolean;
  trash?: boolean;
  group?: string;
  limit?: number;
  cursor?: string;
  sort?: string;
  mediaKind?: string;
  collapseStacks?: boolean;
  includeTotal?: boolean;
  boundaryCursor?: string;
  assetIds?: string[];
  [key: string]: unknown;
}

export interface AssetPage {
  assets: StoredAsset[];
  page: {
    nextCursor: string | null;
    limit: number;
    sort: string;
    total: number | null;
  };
}

export interface AssetStackSummary {
  id: string;
  count: number;
  cover_asset_id: string;
  created_at?: string;
  updated_at?: string;
}

export interface GroupInfo {
  name: string;
  project_id: string;
  style?: string;
  skill?: string;
  theme?: string;
  count: number;
}

export interface SqliteAssetStore {
  listAssets(filters: AssetListFilters): Promise<StoredAsset[]>;
  listAssetPage(filters: AssetListFilters): Promise<AssetPage>;
  getAssetStack(projectId: string, stackId: string): Promise<AssetStackSummary>;
  listAssetStackAssets(projectId: string, stackId: string, filters?: AssetListFilters): Promise<{ stack: AssetStackSummary; assets: StoredAsset[]; page: { total: number | null; nextCursor: string | null; limit: number; sort: string } }>;
  createAssetStack(projectId: string, assetIds: string[], options?: { coverAssetId?: string }): Promise<AssetStackSummary>;
  addAssetsToStack(projectId: string, stackId: string, assetIds: string[]): Promise<AssetStackSummary>;
  applySessionTitle(projectId: string, sessionKey: string, title: string): Promise<{ stackId: string; renamed: boolean }>;
  reorderAssetStack(projectId: string, stackId: string, assetIds: string[]): Promise<AssetStackSummary>;
  removeAssetsFromStack(projectId: string, stackId: string, assetIds: string[]): Promise<{ dissolved: boolean; remainingAssetId: string | null; stack: AssetStackSummary | null }>;
  moveAssetsToStack(projectId: string, assetIds: string[], targetStackId: string | null): Promise<{ target: AssetStackSummary | null; sources: Array<{ stackId: string; dissolved: boolean; remainingAssetId: string | null }>; movedAssetIds: string[] }>;
  dissolveAssetStack(projectId: string, stackId: string): Promise<{ id: string; assetIds: string[]; dissolved: true }>;
  getAsset(projectId: string, assetId: string): Promise<StoredAsset | null>;
  ensureAssetPalette(projectId: string, assetId: string): Promise<StoredAsset | null>;
  /** Task 291 manual-import dedupe: per-batch similarity state. Read-only except the lazy pixel-digest cache column. */
  similarCheckState(projectId: string, assetIds: string[]): Promise<{
    pending: string[];
    unchecked: string[];
    identical: Array<{ newAssetId: string; existingAssetId: string }>;
    matches: Array<{ newAssetId: string; existingAssetId: string; distance: number; newWidth: number; newHeight: number; existingWidth: number; existingHeight: number; clearer: boolean }>;
  }>;
  /** One-shot background backfill of perceptual hashes from published thumbnails; no-op once done. */
  startPerceptualHashBackfill(): void;
  /** Cached display-pixel digest ("", never computed) — forwarded to replaceAssetMedia on "replace with sharper". */
  cachedPerceptualPixelDigest(projectId: string, assetId: string): Promise<string>;
  /** Server-side re-verification for /api/import/resolve; { ok: false, code } rejects without touching anything. */
  verifyImportResolve(projectId: string, action: Record<string, unknown>): Promise<{ ok: boolean; code?: string }>;
  createAsset(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<StoredAsset>;
  updateMetadata(projectId: string, assetId: string, metadata: Record<string, unknown>): Promise<StoredAsset>;
  updateCuration(projectId: string, assetId: string, input: Record<string, unknown>): Promise<StoredAsset>;
  /** Batch "标为已整理": writes only the curated flag; reports the prior flag and whether the asset was organized before. */
  setAssetsCurated(
    projectId: string,
    assetIds: string[],
    curated: boolean,
  ): Promise<{
    results: Array<
      | { id: string; curated: boolean; previous_curated: boolean; was_organized: boolean }
      | { id: string; ok: false; code: string; error: string }
    >;
    partial: boolean;
  }>;
  replaceAssetMedia(projectId: string, assetId: string, input: Record<string, unknown>, options?: Record<string, unknown>): Promise<StoredAsset>;
  toggleFavorite(projectId: string, assetId: string): Promise<StoredAsset>;
  assetFileInfo(projectId: string, fileName: string): Promise<{ size: number }>;
  assetReadStream(projectId: string, fileName: string, options?: { start?: number; end?: number }): Promise<NodeJS.ReadableStream>;
  archiveAsset(projectId: string, assetId: string): Promise<StoredAsset>;
  deleteAsset(projectId: string, assetId: string, context?: { reason?: string }): Promise<Record<string, unknown>>;
  restoreAsset(projectId: string, assetId: string): Promise<StoredAsset>;
  permanentlyDeleteAsset(projectId: string, assetId: string): Promise<Record<string, unknown>>;
  purgeExpiredTrash(options?: { nowMs?: number; retentionMs?: number }): Promise<{ due: number; removed: number; failed: number }>;
  emptyTrash(projectId?: string): Promise<{ removed: number; failed: Array<Record<string, unknown>>; partial: boolean }>;
  cleanupPermanentDeletionStaging(): Promise<{ removed: number; failed: number }>;
  cleanupOrphanedManagedFiles(options?: { olderThanMs?: number; includeDerivatives?: boolean }): Promise<{ removed: number; failed: number }>;
  cleanupOrphanedDerivativeFiles(options?: { olderThanMs?: number }): Promise<{ removed: number; failed: number }>;
  isAssetActive(projectId: string, assetId: string): Promise<boolean>;
  withAssetLifecycleLock<T>(projectId: string, assetId: string, task: () => Promise<T>): Promise<T>;
  duplicateAsset(projectId: string, assetId: string): Promise<StoredAsset>;
  createVersion(projectId: string, parentId: string, params: Record<string, unknown>): Promise<StoredAsset>;
  versionHistory(projectId: string, assetId: string): Promise<unknown>;
  recordGenerationEvent(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  applyGenerationMessageBindings(input: Record<string, unknown>): Promise<{ matched: number; updated: number; unchanged: number; conflicts: number; unmatched: number }>;
  listGenerationEvents(projectId: string, filters?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  recordGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  deleteGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateGenerationRelation(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateGenerationRelationCandidate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getGenerationLineage(projectId: string, generationId: string): Promise<Record<string, unknown>>;
  getAssetGenerationHistory(projectId: string, assetId: string): Promise<Record<string, unknown>>;
  listGroups(projectId: string): Promise<GroupInfo[]>;
  listNavigationStats(projectId: string): Promise<Record<string, unknown>>;
  createGroup(projectId: string, name: string): Promise<void>;
  renameGroup(projectId: string, groupName: string, nextGroupName: string): Promise<Record<string, unknown>>;
  deleteGroup(projectId: string, groupName: string, options?: { deleteAssets?: boolean }): Promise<Record<string, unknown>>;
  findAssetByContentHash(projectId: string, contentHash: string): Promise<StoredAsset | null>;
  /** Absolute original path inside this library whose content hash matches, or "" — trash rows included, live rows preferred. Callers must re-hash the file before trusting it. */
  findOriginalByContentHash(projectId: string, contentHash: string): Promise<string>;
  isReferenceHardlinkMigrationDone(): Promise<boolean>;
  completeReferenceHardlinkMigration(): Promise<void>;
  findAssetBySourcePath(projectId: string, sourcePath: string): Promise<StoredAsset | null>;
  /** Provider-identity lookup for media replacement: `mediaKind` ("image" | "video") pins the media type, copies and versions never match. */
  findAssetByProviderIdentity(projectId: string, provider: string, providerAssetId?: string, logicalOutputId?: string, mediaKind?: string): Promise<StoredAsset | null>;
  findAssetByPixelHash(projectId: string, pixelHash: string): Promise<StoredAsset | null>;
  libraryRevision(projectId?: string): Promise<string>;
  libraryChangeState(projectId?: string): Promise<{ revision: number; oldestRevision: number | null }>;
  listLibraryChangesSince(projectId: string, sinceRevision: number, options?: { limit?: number }): Promise<{ sinceRevision: number | null; currentRevision: number; oldestRevision: number | null; complete: boolean; changes: Array<Record<string, unknown>> }>;
  listGalleryRowsForAssets(filters: Record<string, unknown>, assetIds: string[]): Promise<{ rows: StoredAsset[]; rowByAssetId: Record<string, string>; afterCursorRowIds?: string[] }>;
  findAutomaticIngestSuppression(projectId: string, hashes: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  listAutomaticIngestSuppressions(projectId: string): Promise<Array<Record<string, unknown>>>;
  clearAutomaticIngestSuppression(projectId: string, hashes: Record<string, unknown>): Promise<number>;
  recordAutomaticIngestSuppression(projectId: string, record: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  recentAssets(options: { projectId: string; hoursAgo: number; limit: number }): Promise<StoredAsset[]>;
  queueDerivative(projectId: string, assetId: string, kind: string): Promise<void>;
  saveVideoPoster(projectId: string, assetId: string, image: Buffer): Promise<StoredAsset>;
  readDerivative(projectId: string, assetId: string, kind: string): Promise<{ stream: NodeJS.ReadableStream; fileName: string }>;
  close(): void;
  storage: string;
  libraryDir?: string;
  assetsRoot?: string;
  db?: Database;
  [key: string]: unknown;
}

export interface SqliteAssetStoreOptions {
  projectRoot: string;
  managerDir: string;
  libraryDir: string;
}

export function createSqliteAssetStore(options: SqliteAssetStoreOptions): SqliteAssetStore;
export const TRASH_RETENTION_MS: number;
