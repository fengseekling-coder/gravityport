// Task 377 helper: parses the fixed sample bounds through the real
// parseAssetTimeBound in whatever timezone the parent set (TZ must be chosen
// before node starts, so the parent spawns this file as a child). Prints one
// JSON line; a thrown "not-a-date" style rejection is reported as null.
import { parseAssetTimeBound } from "../../lib/asset-time-filter.mjs";

function tryParse(value) {
  try {
    return parseAssetTimeBound(value);
  } catch {
    return null;
  }
}

process.stdout.write(`${JSON.stringify({
  dateOnlyMs: tryParse("2026-11-07"),
  utcZMs: tryParse("2026-11-07T00:00:00.000Z"),
  naiveLocalNoonMs: tryParse("2026-11-07T12:00:00"),
  rolledDayMs: tryParse("2026-02-30"),
  notADateMs: tryParse("not-a-date"),
  numberPassthroughMs: tryParse(1234567890),
})}\n`);
