export function parseAssetTimeBound(value, { label = "Asset time filter" } = {}) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value);
  // Task 377 (user rule 2026-11-08): a date-only bound ("2026-11-07") means
  // local midnight of that day — Date.parse would read it as UTC midnight,
  // hours away from the machine the user is sitting at. Date-times without an
  // offset already parse as local, and values carrying Z or ±hh:mm keep their
  // explicit zone. A rolled-over calendar date (2026-02-30) fails the
  // round-trip and falls through to Date.parse, which rejects it as before.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  let timestamp = NaN;
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const local = new Date(year, month - 1, day);
    if (local.getFullYear() === year && local.getMonth() === month - 1 && local.getDate() === day) {
      timestamp = local.getTime();
    }
  } else {
    timestamp = Date.parse(text);
  }
  if (!Number.isFinite(timestamp)) {
    const error = new Error(`${label} must be a valid ISO-8601 date/time.`);
    error.statusCode = 400;
    error.code = "ASSET_TIME_FILTER_INVALID";
    error.expose = true;
    throw error;
  }
  return timestamp;
}

export function normalizeAssetTimeRange({ createdAfter, createdBefore } = {}) {
  const createdAfterMs = parseAssetTimeBound(createdAfter, { label: "createdAfter" });
  const createdBeforeMs = parseAssetTimeBound(createdBefore, { label: "createdBefore" });
  if (createdAfterMs != null && createdBeforeMs != null && createdAfterMs > createdBeforeMs) {
    const error = new Error("createdAfter must not be later than createdBefore.");
    error.statusCode = 400;
    error.code = "ASSET_TIME_RANGE_INVALID";
    error.expose = true;
    throw error;
  }
  return { createdAfterMs, createdBeforeMs };
}
