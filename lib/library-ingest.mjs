/**
 * The single library ingest gate. Every channel (web capture, the local
 * bridges, MCP, manual import) is responsible for one thing only: obtaining
 * the media bytes and the fields that describe them. Everything that decides
 * how an image enters the library lives here — recognizing an asset that is
 * already archived, allowing only same-owner metadata upgrades, recording
 * occurrences, replacing media upward on the same provider identity, and
 * translating store dedupe outcomes into stable results.
 *
 * The rules this module implements are documented in ARCHITECTURE.md
 * § "一张图的一生：进库机制规矩表"; a PR that changes any rule here changes
 * that section in the same PR.
 */

import { resolve } from "node:path";
import { DEFAULT_PIXEL_HASH_LIMIT, PIXEL_HASH_VERSION, safePixelDigest } from "./image-pixel-hash.js";
import { shouldUpgradePrompt } from "./prompt-rank.mjs";
import { isPromptUserEdited, isThemeUserEdited } from "./user-edit-marker.mjs";

function sourceOf(asset) {
  return asset?.source && typeof asset.source === "object" && !Array.isArray(asset.source) ? asset.source : {};
}

function trimString(value) {
  return String(value ?? "").trim();
}

/**
 * Combined lookup over one project: indexed store queries when the store
 * offers them, a full listing (active plus archived, same as before) as the
 * fallback, and `remember` for assets created earlier in the same scan.
 * `sourcePathKeys` names the extra source keys a channel stores its media
 * path under (Codex: codex_image_path, Grok: grok_media_path, …); the plain
 * `source.path` key is always checked.
 */
export function createIngestLookup(store, projectId, { sourcePathKeys = [] } = {}) {
  let fallbackAssets = null;
  const listed = () => fallbackAssets ||= Promise.all([
    store.listAssets({ projectId }),
    store.listAssets({ projectId, archived: true }).catch(() => []),
  ]).then(([active, archived]) => [...active, ...archived]);
  const remembered = [];
  const pathKeys = ["path", ...sourcePathKeys.filter((key) => key && key !== "path")];

  const matchesPath = (asset, resolvedPath) => pathKeys.some((key) => {
    const value = sourceOf(asset)[key];
    return typeof value === "string" && resolve(value) === resolvedPath;
  });

  return {
    async byProviderIdentity(provider, providerAssetId, logicalOutputId = "", mediaKind = "") {
      const wantedProvider = trimString(provider).toLowerCase();
      const wantedAssetId = trimString(providerAssetId);
      const wantedLogicalOutputId = trimString(logicalOutputId);
      if (!wantedProvider || (!wantedAssetId && !wantedLogicalOutputId)) return null;
      if (typeof store.findAssetByProviderIdentity === "function") {
        return await store.findAssetByProviderIdentity(projectId, wantedProvider, wantedAssetId, wantedLogicalOutputId, mediaKind || undefined) || null;
      }
      return (await listed()).find((asset) => (
        trimString(sourceOf(asset).provider).toLowerCase() === wantedProvider
        && (
          (wantedAssetId && trimString(sourceOf(asset).provider_asset_id) === wantedAssetId)
          || (wantedLogicalOutputId && trimString(sourceOf(asset).logical_output_id) === wantedLogicalOutputId)
        )
      )) || null;
    },

    async bySourcePath(path) {
      const wanted = trimString(path);
      if (!wanted) return null;
      const direct = typeof store.findAssetBySourcePath === "function" ? await store.findAssetBySourcePath(projectId, wanted) : null;
      if (direct) return direct;
      const resolved = resolve(wanted);
      const local = remembered.find((asset) => matchesPath(asset, resolved));
      if (local) return local;
      if (typeof store.findAssetBySourcePath === "function") return null;
      return (await listed()).find((asset) => matchesPath(asset, resolved)) || null;
    },

    async byContentHash(hash) {
      const wanted = trimString(hash);
      if (!wanted) return null;
      const local = remembered.find((asset) => sourceOf(asset).content_sha256 === wanted);
      if (local) return local;
      if (typeof store.findAssetByContentHash === "function") return await store.findAssetByContentHash(projectId, wanted) || null;
      return (await listed()).find((asset) => sourceOf(asset).content_sha256 === wanted) || null;
    },

    // Pixel identity follows the web-capture rule: a match stored with the
    // current pixel-hash version is trusted as-is; a legacy-version match is
    // only accepted after recomputing the stored original's pixel hash, and
    // the fresh hash is written back while we are at it.
    async byPixelHash(hash) {
      const wanted = trimString(hash);
      if (!wanted) return null;
      const local = remembered.find((asset) => sourceOf(asset).pixel_hash_version === PIXEL_HASH_VERSION && sourceOf(asset).pixel_sha256 === wanted);
      if (local) return local;
      const indexedMatch = typeof store.findAssetByPixelHash === "function"
        ? await store.findAssetByPixelHash(projectId, wanted) || null
        : (await listed()).find((asset) => sourceOf(asset).pixel_sha256 === wanted) || null;
      if (indexedMatch && await isTrustedPixelMatch(store, indexedMatch, wanted)) return indexedMatch;
      const candidates = ((typeof store.findAssetsByPixelHash === "function"
        ? await store.findAssetsByPixelHash(projectId, wanted)
        : (await listed()).filter((asset) => sourceOf(asset).pixel_sha256 === wanted)) || [])
        .filter((asset) => asset.id !== indexedMatch?.id);
      for (const candidate of candidates) {
        if (await isTrustedPixelMatch(store, candidate, wanted)) return candidate;
      }
      return null;
    },

    /** Register an asset created during this scan so later candidates find it. */
    remember(asset) {
      if (asset) remembered.push(asset);
    },
  };
}

/** Identity fields findExistingAsset understands, one per match strategy. */
export async function findExistingAsset(lookup, identity = {}, order = ["provider-identity", "source-path", "content", "pixel"]) {
  for (const matchedBy of order) {
    if (matchedBy === "provider-identity") {
      const asset = await lookup.byProviderIdentity(identity.provider, identity.providerAssetId, identity.logicalOutputId, identity.mediaKind);
      if (asset) return { asset, matchedBy };
    } else if (matchedBy === "source-path") {
      const asset = await lookup.bySourcePath(identity.sourcePath);
      if (asset) return { asset, matchedBy };
    } else if (matchedBy === "content") {
      const asset = await lookup.byContentHash(identity.contentHash);
      if (asset) return { asset, matchedBy };
    } else if (matchedBy === "pixel") {
      const asset = await lookup.byPixelHash(identity.pixelHash);
      if (asset) return { asset, matchedBy };
    }
  }
  return null;
}

/**
 * Which ingest channel owns an archived asset, derived from its source type.
 * Owners decide metadata upgrades: the channel that archived an asset is the
 * only one that upgrades its prompts (manual local imports carry no source
 * information and are the one exception).
 */
export function ingestOwnerOf(asset) {
  const source = sourceOf(asset);
  const sourceType = trimString(asset?.source_type || source.type).toLowerCase();
  if (sourceType.startsWith("web-")) {
    const provider = trimString(source.provider).toLowerCase() || sourceType.slice("web-".length);
    return `web:${provider}`;
  }
  if (sourceType === "codex-generated") return "codex";
  if (sourceType === "grok-generated") return "grok";
  if (sourceType === "cowart-generated") return "cowart";
  if (sourceType === "local-file") return "manual";
  return "other";
}

/**
 * Whether `incomingOwner` may upgrade metadata on an already-archived asset:
 * only its own channel — or anything, when the library copy came from a local
 * import that carries no provenance at all.
 */
export function canUpgradeMetadata(existing, incomingOwner) {
  const owner = ingestOwnerOf(existing);
  return owner === incomingOwner || owner === "manual";
}

// A pixel match stored under the current hash version is trusted as-is; a
// legacy-version candidate must prove itself against a freshly computed
// digest of its stored original, and the fresh hash is written back.
async function isTrustedPixelMatch(store, asset, pixelHash) {
  const source = sourceOf(asset);
  if (source.pixel_hash_version === PIXEL_HASH_VERSION) return true;
  const imagePath = typeof asset.image_path === "string" ? asset.image_path : "";
  if (!imagePath) return false;
  const trusted = await safePixelDigest(imagePath, { limitInputPixels: DEFAULT_PIXEL_HASH_LIMIT }).then((hash) => hash === pixelHash, () => false);
  if (!trusted) return false;
  if (typeof store.updateMetadata === "function") {
    const nextSource = { ...source, pixel_sha256: pixelHash, pixel_hash_version: PIXEL_HASH_VERSION };
    await store.updateMetadata(asset.project_id, asset.id, { source: nextSource }).then(() => { asset.source = nextSource; }, () => {});
  }
  return true;
}

function captureOccurrenceKey(value) {
  return [
    value.provider,
    value.type,
    value.page_url,
    value.conversation_id,
    value.message_id,
    value.generation_context_id,
    value.capture_mode,
  ].map((part) => String(part || "")).join("|");
}

/**
 * Record one observation of an already-archived asset. The same observation
 * (by provider/type/page/conversation/message/context/mode key) is recorded
 * only once; at most 40 occurrences are kept.
 */
export async function recordIngestOccurrence(store, existing, occurrence) {
  if (!occurrence || typeof occurrence !== "object" || typeof store.updateMetadata !== "function") return null;
  const current = Array.isArray(sourceOf(existing).capture_occurrences)
    ? sourceOf(existing).capture_occurrences.filter((entry) => Boolean(entry && typeof entry === "object"))
    : [];
  const key = captureOccurrenceKey(occurrence);
  if (current.some((entry) => captureOccurrenceKey(entry) === key)) return existing;
  return store.updateMetadata(existing.project_id, existing.id, {
    source: {
      ...(sourceOf(existing)),
      capture_occurrences: [...current, occurrence].slice(-40),
    },
  });
}

// The first user instruction archived for an image wins: re-observations of
// an already archived capture often carry the message of a different
// conversation turn (virtual scrolling shows only partial history), so an
// unrelated message must never replace the archived one. Only an empty slot
// or a strict extension of the archived text may update it.
export function mergedUserMessage(current, incoming) {
  const existing = trimString(current);
  const next = trimString(incoming);
  if (!existing) return next;
  if (!next) return existing;
  if (next.startsWith(existing) && next.length > existing.length) return next;
  return existing;
}

/**
 * Upgrade the prompt (and its provenance) on an already-archived asset from a
 * recaptured candidate, under the shared rank table (lib/prompt-rank.mjs).
 * Callers pass `deriveTheme` to keep their own name algorithm; without it the
 * theme is left untouched. A prompt a human edited through a marked entry
 * point is never rewritten — only the user's own instruction may still fill in.
 */
export async function upgradePrompt(store, existing, incoming = {}, { deriveTheme } = {}) {
  if (typeof store.updateMetadata !== "function") return null;
  const nextPrompt = trimString(incoming.prompt);
  const userMessage = String(incoming.userMessage || incoming.user_message || "").trim();
  const currentUserMessage = trimString(sourceOf(existing).user_message || existing.business_fields?.user_message);
  if (!nextPrompt) {
    const merged = mergedUserMessage(currentUserMessage, userMessage);
    // Keeping the archived instruction is a no-op: writing metadata here would
    // add a recipe snapshot for every repeated observation of the same image.
    if (merged === currentUserMessage) return null;
    return store.updateMetadata(existing.project_id, existing.id, {
      source: {
        ...(sourceOf(existing)),
        prompt_source: incoming.promptSource || sourceOf(existing).prompt_source || null,
        user_message: merged,
      },
      business_fields: {
        ...(existing.business_fields || {}),
        prompt_source: incoming.promptSource || existing.business_fields?.prompt_source || null,
        user_message: merged,
      },
    });
  }

  const currentPrompt = trimString(existing.prompt);
  const currentStatus = String(
    sourceOf(existing).prompt_status
      || existing.business_fields?.prompt_status
      || (currentPrompt ? "user-message" : "not-available"),
  );
  const nextStatus = incoming.promptStatus || "user-message";
  const currentPriority = Number(sourceOf(existing).prompt_priority || existing.business_fields?.prompt_priority) || 0;
  const nextPriority = Math.max(0, Number(incoming.promptPriority) || 0);
  if (!shouldUpgradePrompt(
    { prompt: currentPrompt, status: currentStatus, priority: currentPriority },
    { prompt: nextPrompt, status: nextStatus, priority: nextPriority },
  )) {
    return null;
  }

  // A prompt a human typed through a marked entry point wins over every
  // recapture. The page's status/priority describe a prompt we are not
  // keeping, so only the user's own words may still fill in; writing the rest
  // would rewrite the asset on every repeated observation of the same image.
  if (isPromptUserEdited(existing)) {
    const merged = mergedUserMessage(currentUserMessage, userMessage);
    if (merged === currentUserMessage) return null;
    return store.updateMetadata(existing.project_id, existing.id, {
      source: { ...(sourceOf(existing)), user_message: merged },
      business_fields: { ...(existing.business_fields || {}), user_message: merged },
    });
  }

  // The theme is derived from the page prompt, so it is only written alongside
  // a prompt that is actually being upgraded, and never over a user rename.
  return store.updateMetadata(existing.project_id, existing.id, {
    prompt: nextPrompt,
    ...(isThemeUserEdited(existing) || typeof deriveTheme !== "function"
      ? {}
      : { theme: deriveTheme(nextPrompt, incoming.provider || sourceOf(existing).provider) }),
    source: {
      ...(sourceOf(existing)),
      prompt_status: nextStatus,
      prompt_source: incoming.promptSource || sourceOf(existing).prompt_source || null,
      prompt_priority: nextPriority,
      prompt_scope: normalizePromptScope(incoming.promptScope) || sourceOf(existing).prompt_scope || null,
      user_message: mergedUserMessage(sourceOf(existing).user_message, incoming.userMessage) || null,
      model: incoming.model || sourceOf(existing).model || null,
    },
    business_fields: {
      ...(existing.business_fields || {}),
      prompt_status: nextStatus,
      prompt_source: incoming.promptSource || existing.business_fields?.prompt_source || null,
      prompt_priority: nextPriority,
      prompt_scope: normalizePromptScope(incoming.promptScope) || existing.business_fields?.prompt_scope || null,
      user_message: mergedUserMessage(existing.business_fields?.user_message, incoming.userMessage) || null,
    },
  });
}

const GENERATION_STATUSES = new Set(["unknown", "in_progress", "partial", "completed", "failed", "cancelled"]);

/** Normalize a provider-reported generation status to the canonical set. */
export function normalizeGenerationStatus(value) {
  const raw = trimString(value).toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    complete: "completed", succeeded: "completed", success: "completed", done: "completed", finished: "completed",
    failure: "failed", error: "failed", errored: "failed", rejected: "failed", timeout: "failed", timed_out: "failed",
    canceled: "cancelled", aborted: "cancelled", stopped: "cancelled",
    incomplete: "partial", running: "in_progress", generating: "in_progress", streaming: "in_progress", pending: "in_progress", queued: "in_progress",
  };
  const normalized = aliases[raw] || raw || "unknown";
  return GENERATION_STATUSES.has(normalized) ? normalized : "unknown";
}

const TERMINAL_GENERATION_STATUSES = new Set(["completed", "failed", "cancelled"]);

function storedGenerationStatus(asset) {
  return normalizeGenerationStatus(sourceOf(asset).generation_status ?? asset.business_fields?.generation_status);
}

function storedPixelCount(asset) {
  const width = Number(asset.business_fields?.width ?? sourceOf(asset).width) || 0;
  const height = Number(asset.business_fields?.height ?? sourceOf(asset).height) || 0;
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * "Same provider id arrived again" may only ever replace media upward
 * (user rule 2026-10-28): a preview or an equal/smaller re-encode must never
 * destroy archived pixels. A provisional capture holds the slot for its
 * terminal result, an archived preview may be replaced by the original, and an
 * archived original only yields to strictly more pixels. When dimensions are
 * unreadable the conservative branch applies — an unreadable *incoming* image
 * never upgrades, while unreadable *stored* dimensions cannot prove a
 * downgrade of a provisional capture, so the terminal result still lands.
 */
export function isProviderMediaUpgrade(existing, incoming = {}) {
  if (!TERMINAL_GENERATION_STATUSES.has(incoming.generationStatus)) return false;
  const existingTerminal = TERMINAL_GENERATION_STATUSES.has(storedGenerationStatus(existing));
  const existingVariant = normalizeMediaVariant(sourceOf(existing).media_variant);
  const existingPixels = storedPixelCount(existing);
  if (incoming.mediaVariant === "preview") {
    // Only a strictly larger preview may replace a preview; an archived
    // original must never be downgraded to a preview.
    return existingTerminal && existingVariant === "preview"
      && incoming.pixels > 0 && existingPixels > 0 && incoming.pixels > existingPixels;
  }
  if (!existingTerminal) {
    return incoming.pixels === 0 || existingPixels === 0 || incoming.pixels >= existingPixels;
  }
  if (existingVariant === "preview") return true;
  return incoming.pixels > 0 && existingPixels > 0 && incoming.pixels > existingPixels;
}

/** "original" or "preview"; anything else is an unknown variant. */
export function normalizeMediaVariant(value) {
  const variant = trimString(value).toLowerCase();
  return variant === "original" || variant === "preview" ? variant : "";
}

const PROMPT_SCOPES = new Set(["output", "attempt", "message", ""]);

/** Normalize a prompt_scope to one of the known scopes (or ""). */
export function normalizePromptScope(value) {
  const scope = trimString(value).toLowerCase();
  return PROMPT_SCOPES.has(scope) ? scope : "";
}

function errorCode(error) {
  return error && typeof error === "object" ? (error.code ?? null) : null;
}

function isAutomaticImportSuppressed(error) {
  return errorCode(error) === "AUTOMATIC_IMPORT_SUPPRESSED";
}

function isAutomaticIngestDuplicate(error) {
  return errorCode(error) === "AUTOMATIC_INGEST_DUPLICATE";
}

function isAssetAlreadyExistsError(error) {
  return errorCode(error) === "ASSET_ALREADY_EXISTS";
}

function isAlreadyInLibraryError(error) {
  return errorCode(error) === "ALREADY_IN_LIBRARY";
}

/**
 * Create a library asset through the gate: asset-id collisions retry once
 * with a caller-derived fresh id (only when the caller did not pin an id —
 * the caller expresses that by passing `retryAssetId` or not), and the
 * store's dedupe outcomes are translated into skipped results instead of
 * raw errors. `ingestMode`, `trustedSourceRoots` and `skipIdenticalBytes`
 * are passed through verbatim; whether bytes dedupe is the caller's explicit
 * choice, never inferred from the ingest mode.
 */
export async function createAssetViaGate(store, input, options = {}) {
  const passthrough = {};
  if (options.ingestMode !== undefined) passthrough.ingestMode = options.ingestMode;
  if (options.trustedSourceRoots !== undefined) passthrough.trustedSourceRoots = options.trustedSourceRoots;
  if (options.skipIdenticalBytes !== undefined) passthrough.skipIdenticalBytes = options.skipIdenticalBytes;
  try {
    return { ok: true, asset: await store.createAsset(input, passthrough) };
  } catch (error) {
    let failure = error;
    if (isAssetAlreadyExistsError(failure) && typeof options.retryAssetId === "function") {
      const retryId = trimString(options.retryAssetId(input));
      if (retryId && retryId !== trimString(input?.assetId)) {
        try {
          return { ok: true, asset: await store.createAsset({ ...input, assetId: retryId }, passthrough) };
        } catch (retryError) {
          failure = retryError;
        }
      }
    }
    if (isAutomaticImportSuppressed(failure)) {
      return { ok: false, skipped: { reason: "suppressed-after-delete" }, error: failure };
    }
    if (isAutomaticIngestDuplicate(failure)) {
      return {
        ok: false,
        skipped: {
          reason: failure.identityKind === "pixel" ? "already-archived-same-pixels" : "already-archived-same-content",
          duplicateId: trimString(failure.assetId),
          identityKind: failure.identityKind === "pixel" ? "pixel" : "content",
        },
        error: failure,
      };
    }
    if (isAlreadyInLibraryError(failure)) {
      return { ok: false, skipped: { reason: "already-in-library", existingAsset: failure.existingAsset }, error: failure };
    }
    throw failure;
  }
}

const UNTRUSTED_SOURCE_HASH_KEYS = ["content_sha256", "pixel_sha256", "pixel_hash_version"];

/**
 * Source metadata for channels that must not trust hashes claimed by their
 * caller: the store recomputes them. Returns a copy with the hash keys
 * removed.
 */
export function untrustedCreateSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const clean = { ...source };
  for (const key of UNTRUSTED_SOURCE_HASH_KEYS) delete clean[key];
  return clean;
}

async function findStoredAssetById(store, projectId, assetId) {
  if (typeof store.getAsset !== "function" || !assetId) return null;
  try {
    return (await store.getAsset(projectId, assetId)) || null;
  } catch {
    return null;
  }
}

/**
 * The ingest gate itself. Order of operations for one candidate:
 *
 * 1. recognize an already-archived asset (findExistingAsset over the
 *    requested strategies);
 * 2. optional same-provider-id media upgrade — provider-identity hit with
 *    different bytes, the caller supplies `mediaUpgrade` and `replaceMedia`,
 *    and isProviderMediaUpgrade allows it;
 * 3. already archived — record the occurrence, run the caller's recipe hook,
 *    upgrade the prompt only when canUpgradeMetadata allows, run the caller's
 *    observation hook, and return the stored asset;
 * 4. new — create through createAssetViaGate; if the store's transactional
 *    dedupe raced us to the same bytes, adopt the stored asset through step 3;
 *    otherwise run the caller's created hook and return imported.
 */
export async function ingestIntoLibrary(store, request = {}) {
  const projectId = trimString(request.projectId) || "default";
  const identity = request.identity && typeof request.identity === "object" ? request.identity : {};
  const contentHash = trimString(request.contentHash);
  const pixelHash = trimString(request.pixelHash);
  const incomingOwner = trimString(request.incomingOwner);
  const lookup = createIngestLookup(store, projectId, { sourcePathKeys: identity.sourcePathKeys });
  const order = Array.isArray(request.findExistingOrder) && request.findExistingOrder.length
    ? request.findExistingOrder
    : ["provider-identity", "source-path", "content", "pixel"];
  let recipeMerged = false;

  const finishExisting = async (existing, { viaReplacement = false, replacedAssetId = "" } = {}) => {
    let current = existing;
    if (request.occurrence && typeof request.occurrence === "object") {
      current = (await recordIngestOccurrence(store, current, request.occurrence)) || current;
    }
    // The recipe hook decides how observation fields merge; it also receives
    // whether this channel is allowed to touch the asset's metadata at all.
    const recipe = request.onExistingRecipe
      ? await request.onExistingRecipe(current, incomingOwner ? canUpgradeMetadata(current, incomingOwner) : false)
      : null;
    if (recipe && typeof recipe === "object") {
      current = recipe.asset || current;
      recipeMerged = Boolean(recipe.merged);
    }
    let upgraded = null;
    if (incomingOwner && request.prompt && typeof request.prompt === "object" && canUpgradeMetadata(current, incomingOwner)) {
      upgraded = await upgradePrompt(store, current, request.prompt, { deriveTheme: request.deriveTheme });
      if (upgraded) current = upgraded;
    }
    if (request.onExistingObserved) {
      current = (await request.onExistingObserved(current)) || current;
    }
    const sameBytes = trimString(sourceOf(current).content_sha256) === contentHash;
    const reason = viaReplacement
      ? "logical-output-media-upgraded"
      : upgraded
        ? "already-archived-prompt-upgraded"
        : recipeMerged
          ? "already-archived-recipe-merged"
          : sameBytes
            ? "already-archived-same-content"
            : "already-archived-same-pixels";
    return {
      status: viaReplacement ? "imported" : "skipped",
      reason,
      asset: current,
      contentHash,
      upgraded: Boolean(upgraded),
      recipeMerged,
      ...(viaReplacement ? { replacedAssetId } : {}),
    };
  };

  const found = await findExistingAsset(lookup, {
    provider: identity.provider,
    providerAssetId: identity.providerAssetId,
    logicalOutputId: identity.logicalOutputId,
    mediaKind: identity.mediaKind,
    sourcePath: identity.sourcePath,
    contentHash,
    pixelHash,
  }, order);

  if (found) {
    if (found.matchedBy === "provider-identity" && request.mediaUpgrade && typeof request.replaceMedia === "function") {
      const existing = found.asset;
      const existingHash = trimString(sourceOf(existing).content_sha256);
      if (existingHash !== contentHash && isProviderMediaUpgrade(existing, request.mediaUpgrade)) {
        const prepared = typeof request.prepareMedia === "function" ? await request.prepareMedia() : null;
        const replaced = await request.replaceMedia(existing, prepared);
        lookup.remember(replaced);
        return finishExisting(replaced || existing, { viaReplacement: true, replacedAssetId: existing.id });
      }
    }
    return finishExisting(found.asset);
  }

  const prepared = typeof request.prepareMedia === "function" ? await request.prepareMedia() : null;
  const created = await createAssetViaGate(store, prepared?.assetInput ?? {}, {
    ingestMode: request.ingestMode,
    trustedSourceRoots: request.trustedSourceRoots,
    skipIdenticalBytes: request.skipIdenticalBytes,
    retryAssetId: request.retryAssetId,
  });
  if (created.ok) {
    const asset = created.asset;
    lookup.remember(asset);
    if (request.onCreated) await request.onCreated(asset);
    return { status: "imported", asset, contentHash };
  }

  const skipped = created.skipped;
  if (skipped.reason === "suppressed-after-delete") {
    return { status: "skipped", reason: "suppressed-after-delete", contentHash };
  }
  if (skipped.reason === "already-in-library") {
    return { status: "skipped", reason: "already-in-library", existingAsset: skipped.existingAsset, contentHash };
  }
  // The store's transactional dedupe raced an identical capture into the
  // library: adopt the stored asset exactly like a recognized duplicate.
  let duplicate = null;
  if (skipped.duplicateId) duplicate = await findStoredAssetById(store, projectId, skipped.duplicateId);
  if (!duplicate) duplicate = await lookup.byContentHash(contentHash);
  if (!duplicate && pixelHash) duplicate = await lookup.byPixelHash(pixelHash);
  if (duplicate) return finishExisting(duplicate);
  throw created.error;
}
