/**
 * Type surface of lib/library-ingest.mjs consumed from TypeScript sources
 * (web-capture-ingest.ts; the local bridges follow in the ingest-gate
 * rollout). The .mjs module is plain JavaScript by design, so this
 * hand-maintained declaration keeps the ingest gate typed without
 * duplicating logic.
 */

/** Asset shape as seen by the ingest gate; only the read keys are named. */
export interface IngestAsset {
  id: string;
  project_id: string;
  prompt?: string;
  theme?: string;
  source?: Record<string, unknown>;
  business_fields?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Structural store surface the gate needs; every lookup method is optional. */
export interface IngestStore {
  createAsset(input: Record<string, unknown>, options?: Record<string, unknown>): Promise<IngestAsset>;
  listAssets(filters: Record<string, unknown>): Promise<IngestAsset[]>;
  updateMetadata?(projectId: string, assetId: string, patch: Record<string, unknown>): Promise<IngestAsset>;
  findAssetByContentHash?(projectId: string, contentHash: string): Promise<IngestAsset | null>;
  findAssetByPixelHash?(projectId: string, pixelHash: string): Promise<IngestAsset | null>;
  findAssetsByPixelHash?(projectId: string, pixelHash: string): Promise<IngestAsset[]>;
  findAssetByProviderIdentity?(projectId: string, provider: string, providerAssetId?: string, logicalOutputId?: string, mediaKind?: string): Promise<IngestAsset | null>;
  findAssetBySourcePath?(projectId: string, path: string): Promise<IngestAsset | null>;
  getAsset?(projectId: string, assetId: string): Promise<IngestAsset | null>;
  [key: string]: unknown;
}

/** What the caller knows about one candidate, per match strategy. */
export interface IngestIdentity {
  provider?: string;
  providerAssetId?: string;
  logicalOutputId?: string;
  mediaKind?: string;
  sourcePath?: string;
  /** Extra source keys a channel stores its media path under (source.path is always checked). */
  sourcePathKeys?: string[];
}

/** Prompt candidate for metadata upgrades; camelCase and snake_case accepted. */
export interface IngestPromptInput {
  prompt?: string;
  promptStatus?: string;
  userMessage?: string;
  user_message?: string;
  promptSource?: string;
  promptPriority?: number;
  promptScope?: string;
  model?: string;
  provider?: string;
}

/** Same-provider-id replacement evidence handed to isProviderMediaUpgrade. */
export interface ProviderMediaUpgradeInput {
  pixels: number;
  mediaVariant: string;
  generationStatus: string;
}

/** Media the caller prepares lazily, right before create/replace needs it. */
export interface IngestPreparedMedia {
  assetInput?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Everything one ingestIntoLibrary call needs; hooks are caller-defined. */
export interface IngestRequest {
  projectId?: string;
  identity?: IngestIdentity;
  /** Match strategies to try, in order; defaults to provider-identity, source-path, content, pixel. */
  findExistingOrder?: string[];
  contentHash?: string;
  pixelHash?: string;
  /** Owner of the incoming capture, as produced by ingestOwnerOf (e.g. "web:chatgpt"). */
  incomingOwner?: string;
  /** Observation recorded on an already-archived asset. */
  occurrence?: Record<string, unknown>;
  /** Prompt candidate for metadata upgrades. */
  prompt?: IngestPromptInput;
  /** Caller's name algorithm; the theme is only written alongside a real prompt upgrade. */
  deriveTheme?: (prompt: string, provider?: unknown) => string;
  /** Presence enables the same-provider-id replacement branch. */
  mediaUpgrade?: ProviderMediaUpgradeInput;
  /** Lazy media preparation (temp file, asset input), invoked only for create/replace. */
  prepareMedia?: () => Promise<IngestPreparedMedia>;
  /** Same-provider-id replacement; temp-file handling stays with the caller. */
  replaceMedia?: (existing: IngestAsset, prepared: IngestPreparedMedia | null) => Promise<IngestAsset>;
  /** Fresh asset id for one collision retry; omit to never retry. */
  retryAssetId?: (input: Record<string, unknown>) => string;
  /** Merges generation recipe / references on an already-archived asset. */
  onExistingRecipe?: (existing: IngestAsset, metadataUpgradeAllowed: boolean) => Promise<{ asset?: IngestAsset; merged?: boolean } | IngestAsset | null>;
  /** Runs after the prompt upgrade (request prompt, session title, generation record). */
  onExistingObserved?: (asset: IngestAsset) => Promise<IngestAsset | null>;
  /** Runs once after a new asset is created (generation record). */
  onCreated?: (asset: IngestAsset) => unknown;
  ingestMode?: string;
  trustedSourceRoots?: string[];
  /** Dedupes identical bytes only when the caller explicitly opts in. */
  skipIdenticalBytes?: boolean;
}

/** Result of one ingestIntoLibrary call; reason strings are load-bearing. */
export interface IngestGateResult {
  status: string;
  reason?: string;
  asset?: IngestAsset;
  contentHash: string;
  upgraded?: boolean;
  recipeMerged?: boolean;
  replacedAssetId?: string;
  existingAsset?: Record<string, unknown>;
}

/**
 * Combined lookup over one project: indexed store queries when available,
 * an active+archived listing as fallback, and `remember` for assets created
 * during the same scan.
 */
export interface IngestLookup {
  byProviderIdentity(provider: string, providerAssetId?: string, logicalOutputId?: string, mediaKind?: string): Promise<IngestAsset | null>;
  bySourcePath(path: string): Promise<IngestAsset | null>;
  byContentHash(hash: string): Promise<IngestAsset | null>;
  byPixelHash(hash: string): Promise<IngestAsset | null>;
  remember(asset: IngestAsset): void;
}

export declare function createIngestLookup(
  store: IngestStore,
  projectId: string,
  options?: { sourcePathKeys?: string[] },
): IngestLookup;

/** First hit across the requested strategies, or null. */
export declare function findExistingAsset(
  lookup: IngestLookup,
  identity: IngestIdentity & { contentHash?: string; pixelHash?: string },
  order?: string[],
): Promise<{ asset: IngestAsset; matchedBy: string } | null>;

/** Which ingest channel archived an asset (web:<provider>, codex, grok, cowart, manual, other). */
export declare function ingestOwnerOf(asset: IngestAsset | null | undefined): string;

/** Whether incomingOwner may upgrade metadata on an already-archived asset. */
export declare function canUpgradeMetadata(existing: IngestAsset | null | undefined, incomingOwner: string): boolean;

/** Records one observation per occurrence key; at most 40 are kept. */
export declare function recordIngestOccurrence(
  store: IngestStore,
  existing: IngestAsset,
  occurrence: Record<string, unknown>,
): Promise<IngestAsset | null>;

/**
 * Upgrades the prompt (and provenance) from a recaptured candidate under the
 * shared rank table; a user-edited prompt is never rewritten. Returns the
 * updated asset, or null when nothing changed.
 */
export declare function upgradePrompt(
  store: IngestStore,
  existing: IngestAsset,
  incoming?: IngestPromptInput,
  options?: { deriveTheme?: (prompt: string, provider?: unknown) => string },
): Promise<IngestAsset | null>;

/** Same-provider-id media replacement may only ever move upward. */
export declare function isProviderMediaUpgrade(
  existing: IngestAsset,
  incoming?: ProviderMediaUpgradeInput,
): boolean;

/** "original" or "preview"; anything else normalizes to "". */
export declare function normalizeMediaVariant(value: unknown): string;

/** Normalizes prompt_scope to one of the known scopes (or ""). */
export declare function normalizePromptScope(value: unknown): string;

/** Normalizes a provider-reported generation status to the canonical set. */
export declare function normalizeGenerationStatus(value: unknown): string;

/**
 * The first user instruction archived for an image wins: only an empty slot
 * or a strict extension of the archived text may update it.
 */
export declare function mergedUserMessage(current: unknown, incoming: unknown): string;

export type GateCreateResult =
  | { ok: true; asset: IngestAsset }
  | {
    ok: false;
    skipped: {
      reason: string;
      duplicateId?: string;
      identityKind?: string;
      existingAsset?: Record<string, unknown>;
    };
    error: unknown;
  };

/**
 * Creates an asset through the gate: one collision retry with a caller-derived
 * id (when retryAssetId is given), and store dedupe outcomes translated into
 * skipped results.
 */
export declare function createAssetViaGate(
  store: IngestStore,
  input: Record<string, unknown>,
  options?: {
    ingestMode?: string;
    trustedSourceRoots?: string[];
    skipIdenticalBytes?: boolean;
    retryAssetId?: (input: Record<string, unknown>) => string;
  },
): Promise<GateCreateResult>;

/** Copy of source metadata with caller-claimed hash keys removed. */
export declare function untrustedCreateSource(source: unknown): Record<string, unknown>;

/** The ingest gate itself; see ARCHITECTURE.md §8 for the rules. */
export declare function ingestIntoLibrary(
  store: IngestStore,
  request?: IngestRequest,
): Promise<IngestGateResult>;
