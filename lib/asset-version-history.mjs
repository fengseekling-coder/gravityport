const VERSION_RELATION_FIELDS = ["parent_asset_id", "parentAssetId", "child_asset_ids"];
const VERSION_EDITABLE_FIELDS = [
  "prompt",
  "user_prompt",
  "negative_prompt",
  "references",
  "skill",
  "style",
  "ratio",
  "business_fields",
  "theme",
  "tags",
  "favorite",
  "group",
  "category",
  "rating",
];

const ERROR_STATUS = Object.freeze({
  ASSET_NOT_FOUND: 404,
  ASSET_NOT_TRASHED: 409,
  ASSET_ALREADY_EXISTS: 409,
  INVALID_ASSET_CURSOR: 400,
  INVALID_VERSION_CHANGE: 400,
  VERSION_RELATION_IMMUTABLE: 400,
  VERSION_PARENT_NOT_FOUND: 409,
  VERSION_PROJECT_MISMATCH: 409,
  VERSION_CYCLE: 409,
  VERSION_HISTORY_TOO_LARGE: 409,
  VERSION_PARENT_HAS_CHILDREN: 409,
  // Import rejections the UI has to attribute to the image-path field. Without a
  // code the client could only pattern-match English prose to place the error.
  IMAGE_PATH_REQUIRED: 400,
  IMAGE_PATH_NOT_FOUND: 400,
  IMAGE_PATH_UNSUPPORTED_TYPE: 400,
  IMAGE_PATH_NOT_READABLE: 400,
  AUTOMATIC_IMPORT_SUPPRESSED: 409,
  AUTOMATIC_INGEST_DUPLICATE: 409,
  STACK_NOT_FOUND: 404,
  STACK_NEEDS_MULTIPLE_ASSETS: 400,
  STACK_COVER_NOT_MEMBER: 400,
  STACK_ASSET_ARCHIVED: 409,
  ASSET_ALREADY_STACKED: 409,
  STACK_ORDER_MISMATCH: 400,
  STACK_NAME_EMPTY: 400,
  GROUP_NAME_REQUIRED: 400,
  GROUP_ALREADY_EXISTS: 409,
  GROUP_NOT_FOUND: 404,
});

export class AssetStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "AssetStoreError";
    this.code = code;
    this.statusCode = ERROR_STATUS[code] || 500;
  }
}

export function assetStoreError(code, message, options) {
  return new AssetStoreError(code, message, options);
}

export function automaticImportSuppressedError() {
  return assetStoreError(
    "AUTOMATIC_IMPORT_SUPPRESSED",
    "Automatic import suppressed after a manual deletion.",
  );
}

export function automaticIngestDuplicateError(assetId, identityKind = "content") {
  const error = assetStoreError(
    "AUTOMATIC_INGEST_DUPLICATE",
    `Automatic import already exists: ${assetId}`,
  );
  error.assetId = String(assetId || "");
  error.identityKind = identityKind === "pixel" ? "pixel" : "content";
  return error;
}

export function assetNotFoundError(assetId) {
  return assetStoreError("ASSET_NOT_FOUND", `Asset not found: ${assetId}`);
}

export function assetAlreadyExistsError(assetId) {
  return assetStoreError("ASSET_ALREADY_EXISTS", `Asset already exists: ${assetId}`);
}

export function requireVersionChange(input = {}) {
  const value = String(input.version_change ?? input.changeSummary ?? "").trim();
  if (!value) throw assetStoreError("INVALID_VERSION_CHANGE", "Version change summary is required.");
  return value;
}

export function assertMutableVersionPatch(patch = {}) {
  const field = VERSION_RELATION_FIELDS.find((key) => Object.hasOwn(patch, key));
  if (field) throw assetStoreError("VERSION_RELATION_IMMUTABLE", `Version relationship field is read-only: ${field}`);
}

export function pickVersionOverrides(input = {}) {
  return Object.fromEntries(VERSION_EDITABLE_FIELDS.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
}

export function derivedAssetSource(source, relation, assetId) {
  const {
    content_sha256: _contentHash,
    copied_at: _copiedAt,
    duplicated_from: _duplicatedFrom,
    storage_linked_at: _storageLinkedAt,
    storage_mode: _storageMode,
    versioned_from: _versionedFrom,
    provider_asset_id: derivedFromProviderAssetId,
    logical_output_id: _logicalOutputId,
    ...provenance
  } = source && typeof source === "object" ? source : {};
  // Task 281: duplicates and versions no longer claim the original's provider
  // identity — neither the source keys nor the columns derived from them — so
  // provider deletion sync can only ever match the original itself. The
  // original's item id stays on the derivative as provenance only.
  const next = { ...provenance, [relation]: assetId };
  const derivedFrom = String(derivedFromProviderAssetId || "").trim();
  if (derivedFrom) next.derived_from_provider_asset_id = derivedFrom;
  return next;
}

export function versionParentError(parentAssetId, foreignProjects = []) {
  const projects = [...new Set(foreignProjects.filter(Boolean).map(String))];
  if (projects.length) {
    return assetStoreError(
      "VERSION_PROJECT_MISMATCH",
      `Version parent ${parentAssetId} belongs to another project: ${projects.join(", ")}`,
    );
  }
  return assetStoreError("VERSION_PARENT_NOT_FOUND", `Version parent not found: ${parentAssetId}`);
}

export function buildAssetVersionHistory({
  projectId,
  selectedAssetId,
  assets,
  foreignProjectsByAssetId = new Map(),
  maxVersions = 5000,
}) {
  const assetMap = new Map((assets || []).map((asset) => [asset.id, asset]));
  const selected = assetMap.get(selectedAssetId);
  if (!selected) throw assetNotFoundError(selectedAssetId);

  const ancestorIds = new Set();
  let root = selected;
  while (root) {
    if (ancestorIds.has(root.id)) throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${root.id}`);
    ancestorIds.add(root.id);
    if (!root.parent_asset_id) break;
    const parent = assetMap.get(root.parent_asset_id);
    if (!parent) throw versionParentError(root.parent_asset_id, foreignProjects(foreignProjectsByAssetId, root.parent_asset_id));
    root = parent;
  }

  const childrenByParent = new Map();
  for (const asset of assetMap.values()) {
    if (!asset.parent_asset_id || !assetMap.has(asset.parent_asset_id)) continue;
    const children = childrenByParent.get(asset.parent_asset_id) || [];
    children.push(asset);
    childrenByParent.set(asset.parent_asset_id, children);
  }
  for (const children of childrenByParent.values()) children.sort(compareVersionAssets);

  const versions = [];
  const active = new Set();
  const visited = new Set();
  const visit = (asset, depth) => {
    if (active.has(asset.id)) throw assetStoreError("VERSION_CYCLE", `Version cycle detected at asset: ${asset.id}`);
    if (visited.has(asset.id)) return;
    if (versions.length >= maxVersions) {
      throw assetStoreError("VERSION_HISTORY_TOO_LARGE", `Version history exceeds ${maxVersions} assets.`);
    }
    active.add(asset.id);
    visited.add(asset.id);
    const children = childrenByParent.get(asset.id) || [];
    versions.push({
      ...asset,
      child_asset_ids: children.map((child) => child.id),
      version_depth: depth,
      version_index: versions.length + 1,
    });
    for (const child of children) visit(child, depth + 1);
    active.delete(asset.id);
  };
  visit(root, 0);

  return {
    project_id: projectId,
    root_asset_id: root.id,
    selected_asset_id: selectedAssetId,
    versions,
  };
}

function foreignProjects(value, assetId) {
  if (value instanceof Map) return value.get(assetId) || [];
  return value?.[assetId] || [];
}

function compareVersionAssets(left, right) {
  return String(left.created_at || "").localeCompare(String(right.created_at || ""))
    || String(left.id || "").localeCompare(String(right.id || ""));
}
