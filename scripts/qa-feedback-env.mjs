// QA instances must never report feedback to the real collector. Unless the
// caller already set an address or timeout, point the child at a blackhole
// (port 9 refuses connections) with a short timeout.
export const QA_FEEDBACK_URL = "http://127.0.0.1:9";
export const QA_FEEDBACK_TIMEOUT_MS = "3000";

export function qaFeedbackEnv(env = process.env) {
  return {
    MOSA_FEEDBACK_URL: String(env.MOSA_FEEDBACK_URL || "").trim() ? env.MOSA_FEEDBACK_URL : QA_FEEDBACK_URL,
    MOSA_FEEDBACK_TIMEOUT_MS: String(env.MOSA_FEEDBACK_TIMEOUT_MS || "").trim() ? env.MOSA_FEEDBACK_TIMEOUT_MS : QA_FEEDBACK_TIMEOUT_MS,
  };
}
