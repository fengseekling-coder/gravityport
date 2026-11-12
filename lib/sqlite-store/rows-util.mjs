// Row parsing and error helpers for SQLite store (task 394). Pure moves; no behavior changes.
export function isSqliteDuplicateError(error) {
  return ["SQLITE_CONSTRAINT_PRIMARYKEY", "SQLITE_CONSTRAINT_UNIQUE"].includes(error?.code);
}

export function parseBusinessFields(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function parseJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

// palette_json stores [{hex, ratio}] sorted by share; assets expose just the
// hex strings in that order. NULL, malformed, and never-computed rows all read
// as [] so callers cannot distinguish "not yet computed" from "no colors".
export function paletteJsonToHexes(value) {
  const parsed = parseJson(value, null);
  if (!Array.isArray(parsed)) return [];
  const hexes = [];
  for (const entry of parsed) {
    const hex = entry && typeof entry === "object" ? String(entry.hex || "") : "";
    if (/^#[0-9A-F]{6}$/.test(hex)) hexes.push(hex);
  }
  return hexes;
}
