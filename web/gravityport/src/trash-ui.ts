/**
 * Trash UI helpers — pure logic, no React or DOM dependencies.
 *
 * The retention window mirrors the server's 90-day trash policy; the countdown
 * granularity is whole days, rounded up, never negative.
 */

const TRASH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days left before a trashed asset is purged, rounded up, minimum 0.
 * `nowMs` comes from the caller so tests can pin the clock. */
export function trashRemainingDays(deletedAt: string | null, nowMs: number): number {
  const deletedAtMs = Date.parse(String(deletedAt || ""))
  if (!Number.isFinite(deletedAtMs)) return 0
  return Math.max(0, Math.ceil((deletedAtMs + TRASH_RETENTION_MS - nowMs) / DAY_MS))
}
