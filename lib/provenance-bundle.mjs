import os from "node:os";

export const MOSA_PROVENANCE_BUNDLE_SCHEMA = "mosa.provenance.bundle/1";
export const MOSA_C2PA_ASSERTION_LABEL = "com.azhuilab.mosa.provenance";

// Task 374: Explicit allowlists for provenance export.
// Only explicitly allowlisted keys can enter the exported bundle.
// Keys with no callers in the codebase (provider_name, model_name, model_version, site, capture_method, created_at)
// have been pruned after grep verification.

const ASSET_SOURCE_ALLOWLIST = Object.freeze([
  "type",
  "provider",
  "model",
  "captured_at",
]);

const RECIPE_RIGHTS_ALLOWLIST = Object.freeze([
  "copyright",
  "portrait_consent",
  "redistribution",
  "attribution",
]);

const RECIPE_HISTORY_ALLOWLIST = Object.freeze([
  "project_id",
  "asset_id",
  "active_snapshot_id",
  "snapshots",
]);

const RECIPE_SNAPSHOT_ALWAYS_ALLOWLIST = Object.freeze([
  "snapshot_id",
  "schema_version",
  "project_id",
  "asset_id",
  "recipe_digest",
  "prompt_digest",
  "prompt_status",
  "generation_tool",
  "model",
  "provider",
  "skill",
  "style",
  "ratio",
  "theme",
  "references",
  "provenance",
  "created_at",
]);

const RECIPE_SNAPSHOT_PROMPT_ALLOWLIST = Object.freeze([
  "effective_prompt",
  "user_prompt",
  "negative_prompt",
  "change_summary",
]);

const RECIPE_REFERENCE_ALWAYS_ALLOWLIST = Object.freeze([
  "asset_id",
  "sha256",
  "role",
  "scope",
  "applied",
  "reference_id",
  "mime_type",
  "width",
  "height",
  "allowed_uses",
  "forbidden_uses",
  "rights",
]);

const RECIPE_PROVENANCE_ALWAYS_ALLOWLIST = Object.freeze([
  "source_type",
  "task_id",
  "session_id",
  "capture_context_id",
  "provider_tool_call_id",
  "provider_generation_call_id",
  "provider_response_id",
  "provider_asset_id",
  "verification_level",
]);

const GENERATION_HISTORY_ALWAYS_ALLOWLIST = Object.freeze([
  "project_id",
  "asset_id",
  "generation_ids",
  "context_truncated",
  "events",
  "context_events",
  "relations",
  "relation_candidates",
  "conversations",
  "output_assets",
]);

const GENERATION_EVENT_ALWAYS_ALLOWLIST = Object.freeze([
  "id",
  "project_id",
  "output_asset_id",
  "provider",
  "capture_context_id",
  "provider_tool_call_id",
  "provider_generation_call_id",
  "provider_response_id",
  "provider_asset_id",
  "conversation_id",
  "message_id",
  "turn_index",
  "batch_id",
  "model",
  "prompt_status",
  "prompt_scope",
  "generation_status",
  "capture_channel",
  "verification_level",
  "created_at",
  "parent_generation_ids",
  "child_generation_ids",
  "references",
  "evidence",
]);

const GENERATION_EVENT_PROMPT_ALLOWLIST = Object.freeze([
  "user_prompt",
  "effective_prompt",
]);

const GENERATION_EVIDENCE_ALWAYS_ALLOWLIST = Object.freeze([
  "source",
  "relation_status",
  "generation_status",
  "prompt_scope",
  "note",
  "resolver",
  "signals",
  "parent_provider_asset_id",
  "child_message_id",
  "parent_message_id",
  "safe_id",
]);

const GENERATION_RELATION_ALWAYS_ALLOWLIST = Object.freeze([
  "project_id",
  "child_generation_id",
  "parent_generation_id",
  "relation_type",
  "verification_level",
  "created_at",
  "evidence",
]);

const GENERATION_CANDIDATE_ALWAYS_ALLOWLIST = Object.freeze([
  "project_id",
  "child_generation_id",
  "parent_generation_id",
  "relation_type",
  "confidence",
  "verification_level",
  "status",
  "created_at",
  "updated_at",
  "evidence",
]);

const GENERATION_CONVERSATION_ALWAYS_ALLOWLIST = Object.freeze([
  "provider",
  "conversation_id",
  "turn_count",
  "synced_at",
]);

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The rest of a path: up to a space, quote, bracket, comma or semicolon, or
// Chinese punctuation, so a redaction never swallows the rest of a sentence
// written without spaces.
const PATH_TAIL = String.raw`[^\s"'<>()\[\]{},;，。；：！？、（）【】「」『』]*`;

// A local path that starts a word (string start, space, quote or separator
// before it). The word start keeps URLs out: the "s://" of https:// or the
// "/home/" of example.com/home/ follow letters, so they never match.
const WORD_START_LOCAL_PATH = String.raw`(?<![^\s"'(\[=:,;<（【「『，：])(?:~[\\/]|\/(?:users|home|volumes)\/|[a-z]:[\\/]|\\\\)` + PATH_TAIL;

function isSensitiveLocalString(value) {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;

  // 1. Starts with local filesystem path indicators: /, ~, file:, \\, or Windows drive letter (e.g. C:\ or C:/)
  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:[/\\]/.test(trimmed)
  ) {
    return true;
  }

  // 2. Contains os.homedir() anywhere
  try {
    const home = os.homedir?.();
    if (home && typeof home === "string" && home.length > 0 && value.includes(home)) {
      return true;
    }
  } catch {}

  // 3. Anywhere, any case: /Users/, /home/, /Volumes/, \Users\ or file://;
  // or a drive (D:\) or ~/ path that starts a word.
  if (
    /\/(?:users|home|volumes)\//i.test(value) ||
    /\\users\\/i.test(value) ||
    /file:\/\//i.test(value) ||
    new RegExp(WORD_START_LOCAL_PATH, "i").test(value)
  ) {
    return true;
  }

  // 4. Contains os.userInfo().username as a standalone word (if length >= 3) or exact match (if length < 3)
  try {
    const user = os.userInfo?.()?.username;
    if (user && typeof user === "string" && user.length > 0) {
      if (user.length >= 3) {
        const re = new RegExp(`(?<![a-zA-Z0-9])${escapeRegExp(user)}(?![a-zA-Z0-9])`, "i");
        if (re.test(value)) {
          return true;
        }
      } else if (trimmed === user || value === user) {
        return true;
      }
    }
  } catch {}

  return false;
}

function redactPromptString(value) {
  if (typeof value !== "string") return undefined;
  let result = value;

  // 1. Redact os.homedir() and any trailing path segment up to whitespace or quote
  try {
    const home = os.homedir?.();
    if (home && typeof home === "string" && home.length > 0) {
      const homeRe = new RegExp(`${escapeRegExp(home)}(?:[/\\\\]${PATH_TAIL})?`, "g");
      result = result.replace(homeRe, "[redacted]");
    }
  } catch {}

  // 2. Redact embedded or leading local path patterns up to whitespace or quote
  // Paths must start a word here, so URLs in a prompt stay as written.
  result = result.replace(new RegExp(String.raw`file:\/\/` + PATH_TAIL, "gi"), "[redacted]");
  result = result.replace(new RegExp(WORD_START_LOCAL_PATH, "gi"), "[redacted]");
  result = result.replace(new RegExp(String.raw`\\users\\` + PATH_TAIL, "gi"), "[redacted]");
  if (/^(?:\/|~|file:)[^\s"']*/i.test(result.trim())) {
    result = result.replace(/^\s*(?:\/|~|file:)[^\s"']*/i, "[redacted]");
  }

  // 3. Redact os.userInfo().username as standalone word (length >= 3) or exact match (length < 3)
  try {
    const user = os.userInfo?.()?.username;
    if (user && typeof user === "string" && user.length > 0) {
      if (user.length >= 3) {
        const userRe = new RegExp(`(?<![a-zA-Z0-9])${escapeRegExp(user)}(?![a-zA-Z0-9])`, "gi");
        result = result.replace(userRe, "[redacted]");
      } else if (result.trim() === user || result === user) {
        result = "[redacted]";
      }
    }
  } catch {}

  return result;
}

function sanitizeLeaf(val) {
  if (typeof val === "string") {
    return isSensitiveLocalString(val) ? undefined : val;
  }
  if (typeof val === "number" || typeof val === "boolean") {
    return val;
  }
  if (Array.isArray(val)) {
    return val.filter(
      (item) =>
        (typeof item === "string" && !isSensitiveLocalString(item)) ||
        typeof item === "number" ||
        typeof item === "boolean",
    );
  }
  return undefined;
}

function isForbiddenKey(key) {
  const normalized = String(key || "").toLowerCase();
  if (/token|secret|authorization|cookie|password|private[_-]?key|sign[_-]?cert|api[_-]?key|access[_-]?key|credential/.test(normalized)) {
    return true;
  }
  if (/(^|_)(path|url|uri)$/.test(normalized) || normalized.endsWith("_path") || normalized.endsWith("_url")) {
    return true;
  }
  return false;
}

export async function buildAssetProvenanceBundle(store, projectId, assetId, { includePrompts = false } = {}) {
  if (!store || typeof store.getAsset !== "function") throw new Error("Provenance export requires an asset store.");
  const project = String(projectId || "default");
  const asset = await store.getAsset(project, assetId);
  const [recipes, generationHistory] = await Promise.all([
    typeof store.getRecipeSnapshotHistory === "function"
      ? store.getRecipeSnapshotHistory(project, assetId)
      : Promise.resolve(null),
    typeof store.getAssetGenerationHistory === "function"
      ? store.getAssetGenerationHistory(project, assetId)
      : fallbackGenerationHistory(store, project, assetId),
  ]);

  const bundle = {
    schema: MOSA_PROVENANCE_BUNDLE_SCHEMA,
    exported_at: new Date().toISOString(),
    project_id: project,
    includes_prompts: Boolean(includePrompts),
    asset: sanitizeAsset(asset, includePrompts),
    recipe_history: sanitizeRecipeHistory(recipes, includePrompts),
    generation_history: sanitizeGenerationHistory(generationHistory, includePrompts),
  };
  return {
    bundle,
    c2pa_assertion: {
      label: MOSA_C2PA_ASSERTION_LABEL,
      schema: "mosa.c2pa.assertion/1",
      data: bundle,
      signed: false,
      note: "Assertion payload only. A C2PA SDK/signer must bind and sign it before it becomes a Content Credential.",
    },
  };
}

async function fallbackGenerationHistory(store, projectId, assetId) {
  const events = typeof store.listGenerationEvents === "function"
    ? await store.listGenerationEvents(projectId, { assetId })
    : [];
  return { asset_id: assetId, generation_ids: events.map((event) => event.id), events, relations: [] };
}

function sanitizeSafeString(val) {
  if (val == null) return "";
  const s = String(val);
  return isSensitiveLocalString(s) ? "" : s;
}

function sanitizeSource(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const output = {};
  for (const key of ASSET_SOURCE_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const val = source[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    const cleaned = sanitizeLeaf(val);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeAsset(asset, includePrompts = false) {
  if (!asset || typeof asset !== "object") return null;
  const source = sanitizeSource(asset?.source);
  const out = {
    id: sanitizeSafeString(asset?.id),
    file_name: sanitizeSafeString(asset?.asset || asset?.file_name),
    content_sha256: sanitizeSafeString(asset?.content_sha256),
    pixel_sha256: sanitizeSafeString(asset?.pixel_sha256),
    created_at: sanitizeSafeString(asset?.created_at),
    updated_at: sanitizeSafeString(asset?.updated_at),
    source_type: sanitizeSafeString(asset?.source_type || asset?.sourceType || asset?.source?.type),
    source,
  };
  if (includePrompts) {
    if (typeof asset?.prompt === "string" && asset.prompt) {
      out.prompt = redactPromptString(asset.prompt);
    }
    if (typeof asset?.user_prompt === "string" && asset.user_prompt) {
      out.user_prompt = redactPromptString(asset.user_prompt);
    }
    if (Array.isArray(asset?.recipe_snapshots)) {
      out.recipe_snapshots = asset.recipe_snapshots
        .map((s) => sanitizeRecipeSnapshot(s, includePrompts))
        .filter(Boolean);
    }
  }
  return out;
}

function sanitizeRightsObject(rights) {
  if (!rights || typeof rights !== "object" || Array.isArray(rights)) return {};
  const output = {};
  for (const key of RECIPE_RIGHTS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(rights, key)) continue;
    const val = rights[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    const cleaned = sanitizeLeaf(val);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeReference(ref) {
  if (!ref || typeof ref !== "object") return null;
  const output = {};
  for (const key of RECIPE_REFERENCE_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(ref, key)) continue;
    const val = ref[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "rights") {
      output.rights = sanitizeRightsObject(val);
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  return output;
}

function sanitizeRecipeProvenance(prov) {
  if (!prov || typeof prov !== "object" || Array.isArray(prov)) return {};
  const output = {};
  for (const key of RECIPE_PROVENANCE_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(prov, key)) continue;
    const val = prov[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    const cleaned = sanitizeLeaf(val);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeRecipeSnapshot(snapshot, includePrompts = false) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const output = {};
  for (const key of RECIPE_SNAPSHOT_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
    const val = snapshot[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "references") {
      output.references = Array.isArray(val) ? val.map(sanitizeReference).filter(Boolean) : [];
    } else if (key === "provenance") {
      output.provenance = sanitizeRecipeProvenance(val);
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  if (includePrompts) {
    for (const key of RECIPE_SNAPSHOT_PROMPT_ALLOWLIST) {
      if (!Object.prototype.hasOwnProperty.call(snapshot, key)) continue;
      const val = snapshot[key];
      if (val == null) continue;
      if (isForbiddenKey(key)) continue;
      if (typeof val === "string") {
        output[key] = redactPromptString(val);
      }
    }
  }
  return output;
}

function sanitizeRecipeHistory(history, includePrompts = false) {
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const output = {};
  for (const key of RECIPE_HISTORY_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(history, key)) continue;
    const val = history[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "snapshots") {
      output.snapshots = Array.isArray(val)
        ? val.map((s) => sanitizeRecipeSnapshot(s, includePrompts)).filter(Boolean)
        : [];
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  return output;
}

function sanitizeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return {};
  const output = {};
  for (const key of GENERATION_EVIDENCE_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(evidence, key)) continue;
    const val = evidence[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    const cleaned = sanitizeLeaf(val);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeGenerationEvent(event, includePrompts = false) {
  if (!event || typeof event !== "object") return null;
  const output = {};
  for (const key of GENERATION_EVENT_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(event, key)) continue;
    const val = event[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "references") {
      output.references = Array.isArray(val) ? val.map(sanitizeReference).filter(Boolean) : [];
    } else if (key === "evidence") {
      output.evidence = sanitizeEvidence(val);
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  if (includePrompts) {
    for (const key of GENERATION_EVENT_PROMPT_ALLOWLIST) {
      if (!Object.prototype.hasOwnProperty.call(event, key)) continue;
      const val = event[key];
      if (val == null) continue;
      if (isForbiddenKey(key)) continue;
      if (typeof val === "string") {
        output[key] = redactPromptString(val);
      }
    }
  }
  return output;
}

function sanitizeGenerationRelation(rel) {
  if (!rel || typeof rel !== "object") return null;
  const output = {};
  for (const key of GENERATION_RELATION_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(rel, key)) continue;
    const val = rel[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "evidence") {
      output.evidence = sanitizeEvidence(val);
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  return output;
}

function sanitizeGenerationCandidate(cand) {
  if (!cand || typeof cand !== "object") return null;
  const output = {};
  for (const key of GENERATION_CANDIDATE_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(cand, key)) continue;
    const val = cand[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "evidence") {
      output.evidence = sanitizeEvidence(val);
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  return output;
}

function sanitizeGenerationConversation(conv) {
  if (!conv || typeof conv !== "object") return null;
  const output = {};
  for (const key of GENERATION_CONVERSATION_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(conv, key)) continue;
    const val = conv[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    const cleaned = sanitizeLeaf(val);
    if (cleaned !== undefined) output[key] = cleaned;
  }
  return output;
}

function sanitizeGenerationHistory(history, includePrompts = false) {
  if (!history || typeof history !== "object" || Array.isArray(history)) return null;
  const output = {};
  for (const key of GENERATION_HISTORY_ALWAYS_ALLOWLIST) {
    if (!Object.prototype.hasOwnProperty.call(history, key)) continue;
    const val = history[key];
    if (val == null) continue;
    if (isForbiddenKey(key)) continue;
    if (key === "events") {
      output.events = Array.isArray(val) ? val.map((e) => sanitizeGenerationEvent(e, includePrompts)).filter(Boolean) : [];
    } else if (key === "context_events") {
      output.context_events = Array.isArray(val) ? val.map((e) => sanitizeGenerationEvent(e, includePrompts)).filter(Boolean) : [];
    } else if (key === "relations") {
      output.relations = Array.isArray(val) ? val.map(sanitizeGenerationRelation).filter(Boolean) : [];
    } else if (key === "relation_candidates") {
      output.relation_candidates = Array.isArray(val) ? val.map(sanitizeGenerationCandidate).filter(Boolean) : [];
    } else if (key === "conversations") {
      output.conversations = Array.isArray(val) ? val.map(sanitizeGenerationConversation).filter(Boolean) : [];
    } else if (key === "output_assets") {
      output.output_assets = Array.isArray(val) ? val.map((a) => sanitizeAsset(a, includePrompts)).filter(Boolean) : [];
    } else {
      const cleaned = sanitizeLeaf(val);
      if (cleaned !== undefined) output[key] = cleaned;
    }
  }
  return output;
}
