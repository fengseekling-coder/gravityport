// Feedback submission configuration (task 158), following lib/pinterest/config.mjs.

const DEFAULT_FEEDBACK_URL = "https://gravityport.azhuilab.com/api/feedback";
const DEFAULT_FEEDBACK_TIMEOUT_MS = 15000;

export function getFeedbackCollectUrl() {
  const value = String(process.env.MOSA_FEEDBACK_URL || "").trim();
  return value || DEFAULT_FEEDBACK_URL;
}

export function getFeedbackTimeoutMs() {
  const parsed = Number(process.env.MOSA_FEEDBACK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FEEDBACK_TIMEOUT_MS;
}
