export const COPYRIGHT_STATES = Object.freeze(["unknown", "owned", "licensed", "third-party"]);
export const PORTRAIT_CONSENT_STATES = Object.freeze(["unknown", "granted", "not-required", "denied"]);
export const REDISTRIBUTION_STATES = Object.freeze(["unknown", "allowed", "forbidden"]);

export interface ReferenceRights {
  copyright: string;
  portrait_consent: string;
  redistribution: string;
  attribution: string;
  [key: string]: unknown;
}

export function defaultReferenceRights(): ReferenceRights {
  return { copyright: "unknown", portrait_consent: "unknown", redistribution: "unknown", attribution: "" };
}

export function normalizeUse(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeUseList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeUse).filter(Boolean))].sort();
}

export function normalizeReferenceRights(value: unknown): ReferenceRights {
  const source = isObject(value) ? value : {};
  return {
    copyright: pickState(source.copyright, COPYRIGHT_STATES),
    portrait_consent: pickState(source.portrait_consent ?? source.consent, PORTRAIT_CONSENT_STATES, CONSENT_BOOLEANS),
    redistribution: pickState(source.redistribution ?? source.redistribution_allowed, REDISTRIBUTION_STATES),
    attribution: String(source.attribution ?? "").trim(),
  };
}

/**
 * An explicit false portrait-consent declaration means denied, not unknown.
 * Keep this separate from the generic allowed/forbidden boolean vocabulary.
 */
const CONSENT_BOOLEANS = Object.freeze({ true: "granted", false: "denied" });
const DEFAULT_BOOLEANS = Object.freeze({ true: "allowed", false: "forbidden" });

function pickState(
  value: unknown,
  allowed: readonly string[],
  booleans: Readonly<Record<string, string>> = DEFAULT_BOOLEANS,
): string {
  if (typeof value === "boolean") {
    const mapped = booleans[String(value)];
    return allowed.includes(mapped) ? mapped : "unknown";
  }
  const normalized = normalizeUse(value);
  return allowed.includes(normalized) ? normalized : "unknown";
}

/** Resolve one reference to cleared, restricted, or unresolved. */
export function referenceRightsStatus(reference: unknown): "cleared" | "restricted" | "unresolved" {
  const source = isObject(reference) ? reference : {};
  const rights = normalizeReferenceRights(source.rights ?? source);
  if (rights.portrait_consent === "denied" || rights.redistribution === "forbidden") return "restricted";
  const stated = [rights.copyright, rights.portrait_consent, rights.redistribution];
  if (stated.some((state) => state === "unknown")) return "unresolved";
  return "cleared";
}

/** Resolve a permitted-use declaration without guessing when it is absent. */
export function referenceUsePermission(reference: unknown, use: unknown): "forbidden" | "allowed" | "undeclared" {
  const target = normalizeUse(use);
  if (!target || !isObject(reference)) return "undeclared";
  if (normalizeUseList(reference.forbidden_uses).includes(target)) return "forbidden";
  const allowed = normalizeUseList(reference.allowed_uses);
  if (allowed.includes(target)) return "allowed";
  if (allowed.length) return "forbidden";
  return "undeclared";
}

export function isReferenceCleared(reference: unknown): boolean {
  return referenceRightsStatus(reference) === "cleared";
}

export function summarizeReferenceRights(references: unknown): {
  total: number;
  cleared: number;
  restricted: number;
  unresolved: number;
} {
  const list = Array.isArray(references) ? references : [];
  const summary = { total: list.length, cleared: 0, restricted: 0, unresolved: 0 };
  for (const reference of list) summary[referenceRightsStatus(reference)] += 1;
  return summary;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
