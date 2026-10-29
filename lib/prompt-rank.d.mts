/**
 * Type surface of lib/prompt-rank.mjs consumed from TypeScript sources
 * (web-capture-ingest.ts and the ingest gate). The .mjs module is plain
 * JavaScript by design, so this hand-maintained declaration keeps the shared
 * prompt ranking typed without duplicating logic.
 */

/**
 * The single prompt-quality table shared by every ingest channel. Keys are
 * prompt_status values; values are levels where a higher number wins. The
 * browser extension mirrors this table (see the .mjs header); a consistency
 * test keeps the copies in lockstep.
 */
export declare const PROMPT_STATUS_RANK: Record<string, number>;

/** Table lookup that ranks unknown statuses as unavailable (0). */
export declare function promptStatusLevel(status: unknown): number;

/**
 * Score a prompt candidate: caller priority × 1e6 + status level × 1e4 +
 * trimmed text length (capped at 5000).
 */
export declare function promptRank(status: unknown, text: unknown, priority?: number): number;

/** A prompt candidate considered for replacing the stored one. */
export interface PromptCandidate {
  prompt?: unknown;
  status?: unknown;
  priority?: number;
}

/**
 * Whether the candidate may replace the stored prompt: an empty candidate
 * never replaces, otherwise it must score strictly higher than the stored one.
 */
export declare function shouldUpgradePrompt(
  current: PromptCandidate | null | undefined,
  next: PromptCandidate | null | undefined,
): boolean;
