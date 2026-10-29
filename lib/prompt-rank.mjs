/**
 * The single prompt-quality ranking shared by every ingest channel (web
 * capture, the local bridges, MCP, manual import). Higher wins. The table is
 * mirrored in the browser extension (extensions/chatgpt-web-capture/
 * background.js `promptPayloadRank` and content.js `promptQuality`), which
 * cannot import this module; test/prompt-rank-consistency.test.mjs keeps the
 * copies in lockstep, so change them in the same PR.
 *
 * Ingested prompt text is only ever upgraded, never downgraded: a candidate
 * replaces the stored prompt when its rank scores strictly higher. The score
 * is priority × 1e6 + level × 1e4 + text length (length capped at 5000), so a
 * caller-assigned priority outranks the status level, and a longer text
 * outranks a shorter one within the same level.
 */

export const PROMPT_STATUS_RANK = {
  "not-available": 0,
  "not-available-in-session": 0,
  "image-generation-prompt-unavailable": 0,
  "user-message": 1,
  "provider-visible-prompt": 1,
  "session-user-prompt": 1,
  "task-user-prompt": 1,
  "canvas-alt-text-only": 1,
  "visible-caption": 2,
  "generation-tool-prompt": 3,
  "image-generation-revised-prompt": 3,
  "user-edited": 4,
};

/** Any status missing from the table ranks as unavailable. */
export function promptStatusLevel(status) {
  return PROMPT_STATUS_RANK[String(status || "").trim()] ?? 0;
}

/**
 * Score a prompt candidate: status level, plus text length as the tie-breaker
 * within a level, plus the caller-assigned priority above everything.
 */
export function promptRank(status, text, priority = 0) {
  const base = promptStatusLevel(status);
  return Math.max(0, Number(priority) || 0) * 1_000_000
    + base * 10000
    + Math.min(String(text || "").trim().length, 5000);
}

/**
 * Whether an incoming prompt candidate may replace the stored one. An empty
 * candidate never replaces anything; otherwise the candidate must score
 * strictly higher. Length is part of the score, so a longer text wins within
 * the same status and priority. Past the 5000-character cap the scores tie,
 * so a tie still upgrades when the text is more than 40 characters longer.
 */
export function shouldUpgradePrompt(current, next) {
  const nextPrompt = String(next?.prompt || "").trim();
  if (!nextPrompt) return false;
  const currentPrompt = String(current?.prompt || "").trim();
  const nextScore = promptRank(next?.status, nextPrompt, next?.priority);
  const currentScore = promptRank(current?.status, currentPrompt, current?.priority);
  return nextScore > currentScore
    || (nextScore === currentScore && nextPrompt.length > currentPrompt.length + 40);
}
