/**
 * Feedback data layer (task 158) — independent of React.
 *
 * GET /api/feedback/diagnostics backs the settings panel preview and the
 * "automatically attached" app summary; POST /api/feedback/submit forwards
 * the form to the collection service through the local runtime. Error copy
 * is keyed by the route codes in lib/api/feedback-routes.mjs.
 */

import { requestJson } from "./mosa-api.js";

export type FeedbackKind = "bug" | "idea" | "other"

export type FeedbackAppInfo = {
  product: string
  version: string
  gitSha?: string
  platform: "macos" | "windows" | "other"
  osVersion: string
  arch: string
}

export type FeedbackDiagnostics = {
  app: FeedbackAppInfo
  diagnostics: { text: string; lines: number; bytes: number }
}

export type FeedbackSubmission = {
  kind: FeedbackKind
  message: string
  contact: string
  locale: "zh" | "en"
  /** The exact text the user previewed; omitted when the box is unchecked. */
  diagnostics?: string
}

export function fetchFeedbackDiagnostics(signal?: AbortSignal): Promise<FeedbackDiagnostics> {
  return requestJson<FeedbackDiagnostics>("/api/feedback/diagnostics", { signal })
}

export function submitFeedback(submission: FeedbackSubmission, signal?: AbortSignal): Promise<{ ok: true; id: string }> {
  const body: Record<string, unknown> = {
    kind: submission.kind,
    message: submission.message,
    contact: submission.contact,
    locale: submission.locale,
  }
  if (submission.diagnostics) body.diagnostics = submission.diagnostics
  return requestJson<{ ok: true; id: string }>("/api/feedback/submit", { method: "POST", body, signal })
}

/** The zh copy for a submit failure; empty when the request was aborted. */
export function feedbackErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return ""
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  switch (code) {
    case "FEEDBACK_OFFLINE": return "发送失败：连不上服务器，请检查网络后重试。"
    case "FEEDBACK_RATE_LIMITED": return "发送得太频繁了，请稍后再试。"
    case "FEEDBACK_TOO_LARGE": return "内容太长了，请去掉诊断日志或删减内容后重试。"
    case "FEEDBACK_INVALID": return "内容不符合要求，请检查后重试。"
    default: return "发送失败，请稍后再试。"
  }
}
