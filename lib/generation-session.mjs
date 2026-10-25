/**
 * Generation-session identity: the shared convention that groups images
 * produced inside one chat/session (ChatGPT conversation, Flow project,
 * Codex task, …) so the asset store can stack them automatically.
 *
 * The canonical source-type classifier lives here too, because a session key
 * is always namespaced by it ("<canonical source>:<session id>") and both the
 * store's source facet and this convention must never disagree about the
 * source of a row.
 */

export const CANONICAL_SOURCE_TYPES = new Set([
  "web-chatgpt", "web-gemini", "web-flow", "web-google-ai-studio",
  "web-jimeng", "web-midjourney",
  "codex-generated", "grok-generated", "cowart-generated",
]);

export function canonicalSourceTypeOf(asset = {}) {
  const sourceType = String(asset?.source?.type || asset?.source_type || asset?.sourceType || "local-file");
  if (CANONICAL_SOURCE_TYPES.has(sourceType)) return sourceType;
  const provider = String(asset?.source?.provider || asset?.business_fields?.provider || "").toLowerCase();
  const generationTool = String(asset?.source?.generation_tool || asset?.business_fields?.generation_tool || "").toLowerCase();
  if (provider === "chatgpt") return "web-chatgpt";
  if (provider === "gemini") return "web-gemini";
  if (provider === "flow") return "web-flow";
  if (provider === "google-ai-studio") return "web-google-ai-studio";
  if (provider === "jimeng") return "web-jimeng";
  if (provider === "midjourney") return "web-midjourney";
  if (generationTool === "codex") return "codex-generated";
  if (generationTool === "grok") return "grok-generated";
  if (generationTool === "cowart") return "cowart-generated";
  return sourceType;
}

/**
 * Every canonical source type must be classified explicitly: "extractor" means
 * generationSessionKey() knows how to pull the session id for this source,
 * "none" means the source carries no session identity yet. New sources must
 * pick one — a source missing from this table fails the coverage test instead
 * of silently never stacking.
 */
export const GENERATION_SESSION_SOURCE_RULES = Object.freeze({
  "web-chatgpt": "extractor",
  "web-gemini": "extractor",
  "web-flow": "extractor",
  "web-google-ai-studio": "extractor",
  "web-jimeng": "extractor",
  "web-midjourney": "extractor",
  "codex-generated": "extractor",
  "grok-generated": "none",
  "cowart-generated": "none",
});

// Extracted ids are opaque web/codex identifiers; anything outside this
// alphabet (URLs, embedded JSON, whitespace) is treated as "no session" rather
// than as an unusable key.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const SESSION_ID_MAX_LENGTH = 128;
// The generic convention is adapter-controlled, so any non-blank string is
// accepted; the cap only keeps a pathological value out of the index.
const GENERIC_SESSION_ID_MAX_LENGTH = 256;
export const GENERATION_SESSION_TITLE_MAX_LENGTH = 80;

// Both Flow hosts embed the same project id under /project/, so keying on the
// id alone merges the two URL shapes into one session.
const PAGE_URL_SESSION_PATTERNS = new Map([
  ["web-flow", /\/project\/([A-Za-z0-9_-]+)/],
  ["web-google-ai-studio", /\/prompts\/([A-Za-z0-9_-]+)/],
  ["web-gemini", /\/app\/([A-Za-z0-9_-]+)/],
]);

// AI Studio's untitled-chat placeholder is a URL state, not a session.
function isPlaceholderSessionId(value) {
  return value === "new_chat" || value.startsWith("new_chat_") || value.startsWith("new_chat-");
}

function normalizedSessionId(value, { maxLength, pattern }) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return "";
  return pattern && !pattern.test(trimmed) ? "" : trimmed;
}

// Jimeng's conversation window lives in the page address, not in the capture
// conversation id: ?workspace=<window id> on the generate page. The capture
// conversation id is one history record (one generation), which would stack
// every generation separately. workspace=0 is the site's "no window open yet"
// state, not a window id.
const JIMENG_SESSION_HOST = "jimeng.jianying.com";
const JIMENG_SESSION_PATHS = new Set(["/ai-tool/generate"]);

function jimengWorkspaceSessionId(pageUrl) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return "";
  }
  if (url.hostname !== JIMENG_SESSION_HOST || !JIMENG_SESSION_PATHS.has(url.pathname)) return "";
  const workspace = url.searchParams.get("workspace") || "";
  if (!/^\d+$/.test(workspace) || workspace === "0") return "";
  return normalizedSessionId(workspace, { maxLength: SESSION_ID_MAX_LENGTH, pattern: SESSION_ID_PATTERN });
}

const SESSION_EXTRACTORS = {
  "web-chatgpt": (source) => normalizedSessionId(source.conversation_id, { maxLength: SESSION_ID_MAX_LENGTH, pattern: SESSION_ID_PATTERN }),
  "web-flow": (source) => extractPageUrlSession(source.page_url, "web-flow"),
  "web-google-ai-studio": (source) => extractPageUrlSession(source.page_url, "web-google-ai-studio"),
  // Jimeng keys on the conversation window when the page address carries one,
  // falling back to the per-generation record id; Midjourney keys on the
  // imagine job. Both fallbacks arrive as capture conversation ids.
  "web-jimeng": (source) => jimengWorkspaceSessionId(source.page_url)
    || normalizedSessionId(source.conversation_id, { maxLength: SESSION_ID_MAX_LENGTH, pattern: SESSION_ID_PATTERN }),
  "web-midjourney": (source) => normalizedSessionId(source.conversation_id, { maxLength: SESSION_ID_MAX_LENGTH, pattern: SESSION_ID_PATTERN }),
  "web-gemini": (source) => extractPageUrlSession(source.page_url, "web-gemini"),
  "codex-generated": (source) => normalizedSessionId(source.codex_task_id, { maxLength: SESSION_ID_MAX_LENGTH, pattern: SESSION_ID_PATTERN }),
};

function extractPageUrlSession(pageUrl, sourceType) {
  if (typeof pageUrl !== "string") return "";
  const match = PAGE_URL_SESSION_PATTERNS.get(sourceType).exec(pageUrl);
  const id = match?.[1] || "";
  if (!id || isPlaceholderSessionId(id)) return "";
  return id;
}

function sourceObjectOf(asset) {
  return asset?.source && typeof asset.source === "object" ? asset.source : {};
}

/**
 * "<canonical source type>:<session id>", or "" when the asset carries no
 * session identity. The generic convention runs first: any source whose
 * `source.generation_session_id` is a non-blank string is keyed by it, so new
 * adapters only have to fill that field to opt into automatic stacking.
 */
export function generationSessionKey(asset = {}) {
  const source = sourceObjectOf(asset);
  const sourceType = canonicalSourceTypeOf(asset);
  const genericId = normalizedSessionId(source.generation_session_id, { maxLength: GENERIC_SESSION_ID_MAX_LENGTH });
  if (genericId) return `${sourceType}:${genericId}`;
  const extract = SESSION_EXTRACTORS[sourceType];
  const id = extract ? extract(source) : "";
  return id ? `${sourceType}:${id}` : "";
}

/**
 * Session display title for auto-stacked groups. The capture plugin does not
 * send titles yet; the lookup order is already the contract future adapters
 * fill in.
 */
export function generationSessionTitle(asset = {}) {
  const source = sourceObjectOf(asset);
  for (const key of ["generation_session_title", "conversation_title", "page_title"]) {
    if (typeof source[key] !== "string") continue;
    const trimmed = source[key].trim();
    if (trimmed) return trimmed.slice(0, GENERATION_SESSION_TITLE_MAX_LENGTH);
  }
  return "";
}
