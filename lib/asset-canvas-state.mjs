import { HttpError } from "./http-response.mjs";

export const CANVAS_MAX_MARKS = 100;
export const CANVAS_MARK_ID_MAX_LENGTH = 96;
export const CANVAS_MARK_TEXT_MAX_LENGTH = 200;

const PATCH_FIELDS = ["is_final", "marks", "pos_x", "pos_y"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function hasDefinedOwn(object, key) {
  return Object.hasOwn(object, key) && object[key] !== undefined;
}

function normalizeNullableCoord(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateNullableCoord(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "${fieldName}" must be a finite number or null.`);
  }
  return value;
}

function validateSingleMark(raw, index) {
  if (!isPlainObject(raw)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "marks[${index}]" must be an object.`);
  }
  if (typeof raw.x !== "number" || !Number.isFinite(raw.x)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "marks[${index}].x" must be a finite number.`);
  }
  if (typeof raw.y !== "number" || !Number.isFinite(raw.y)) {
    throw new HttpError(400, "INVALID_FIELD", `Field "marks[${index}].y" must be a finite number.`);
  }
  let text = "";
  if (raw.text !== undefined) {
    if (typeof raw.text !== "string") {
      throw new HttpError(400, "INVALID_FIELD", `Field "marks[${index}].text" must be a string.`);
    }
    if (raw.text.length > CANVAS_MARK_TEXT_MAX_LENGTH) {
      throw new HttpError(400, "FIELD_TOO_LONG", `Field "marks[${index}].text" exceeds ${CANVAS_MARK_TEXT_MAX_LENGTH} characters.`);
    }
    text = raw.text;
  }
  const normalized = {
    x: clamp01(raw.x),
    y: clamp01(raw.y),
    text,
  };
  if (raw.id !== undefined) {
    if (typeof raw.id !== "string" || !raw.id.trim()) {
      throw new HttpError(400, "INVALID_FIELD", `Field "marks[${index}].id" must be a non-empty string.`);
    }
    if (raw.id.length > CANVAS_MARK_ID_MAX_LENGTH) {
      throw new HttpError(400, "FIELD_TOO_LONG", `Field "marks[${index}].id" exceeds ${CANVAS_MARK_ID_MAX_LENGTH} characters.`);
    }
    normalized.id = raw.id.trim();
  }
  return normalized;
}

/** Validates a partial PATCH payload for `asset_canvas_state`, returning only defined fields. */
export function validateCanvasStatePatch(input) {
  if (!isPlainObject(input)) {
    throw new HttpError(400, "INVALID_FIELD", "Canvas state patch must be a JSON object.");
  }
  const unknownKeys = Object.keys(input).filter((key) => !PATCH_FIELDS.includes(key));
  if (unknownKeys.length) {
    throw new HttpError(400, "INVALID_FIELD", `Unknown canvas state field: "${unknownKeys[0]}".`);
  }
  const patch = {};
  if (hasDefinedOwn(input, "is_final")) {
    if (typeof input.is_final !== "boolean") {
      throw new HttpError(400, "INVALID_FIELD", 'Field "is_final" must be a boolean.');
    }
    patch.is_final = input.is_final;
  }
  if (hasDefinedOwn(input, "marks")) {
    if (!Array.isArray(input.marks)) {
      throw new HttpError(400, "INVALID_FIELD", 'Field "marks" must be an array.');
    }
    if (input.marks.length > CANVAS_MAX_MARKS) {
      throw new HttpError(400, "FIELD_TOO_MANY", `Field "marks" exceeds ${CANVAS_MAX_MARKS} items.`);
    }
    patch.marks = input.marks.map((mark, index) => validateSingleMark(mark, index));
  }
  if (hasDefinedOwn(input, "pos_x")) {
    patch.pos_x = validateNullableCoord(input.pos_x, "pos_x");
  }
  if (hasDefinedOwn(input, "pos_y")) {
    patch.pos_y = validateNullableCoord(input.pos_y, "pos_y");
  }
  return patch;
}

/** Tolerant mark normalizer used when decoding stored SQLite JSON or JSON store files. */
export function normalizeCanvasMarks(raw) {
  let list = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];
  const marks = [];
  for (let index = 0; index < list.length && marks.length < CANVAS_MAX_MARKS; index += 1) {
    const item = list[index];
    if (!isPlainObject(item)) continue;
    if (typeof item.x !== "number" || !Number.isFinite(item.x)) continue;
    if (typeof item.y !== "number" || !Number.isFinite(item.y)) continue;
    const rawText = typeof item.text === "string" ? item.text.slice(0, CANVAS_MARK_TEXT_MAX_LENGTH) : "";
    const normalized = {
      x: clamp01(item.x),
      y: clamp01(item.y),
      text: rawText,
    };
    if (typeof item.id === "string" && item.id.trim()) {
      normalized.id = item.id.trim().slice(0, CANVAS_MARK_ID_MAX_LENGTH);
    }
    marks.push(normalized);
  }
  return marks;
}

/** Normalizes a stored SQLite row or JSON entry into the canonical API canvas-state shape. */
export function normalizeAssetCanvasState(raw = {}) {
  return {
    is_final: Boolean(raw?.is_final),
    marks: normalizeCanvasMarks(raw?.marks !== undefined ? raw.marks : raw?.marks_json),
    pos_x: normalizeNullableCoord(raw?.pos_x),
    pos_y: normalizeNullableCoord(raw?.pos_y),
    updated_at: typeof raw?.updated_at === "string" ? raw.updated_at : "",
  };
}

/** Applies a validated partial patch onto an existing canvas state without clobbering omitted fields. */
export function mergeAssetCanvasState(current, patch, updatedAt = new Date().toISOString()) {
  const base = normalizeAssetCanvasState(current);
  const nextMarks = Object.hasOwn(patch, "marks")
    ? patch.marks.map((mark) => ({ ...mark }))
    : base.marks.map((mark) => ({ ...mark }));
  return {
    is_final: Object.hasOwn(patch, "is_final") ? patch.is_final : base.is_final,
    marks: nextMarks,
    pos_x: Object.hasOwn(patch, "pos_x") ? patch.pos_x : base.pos_x,
    pos_y: Object.hasOwn(patch, "pos_y") ? patch.pos_y : base.pos_y,
    updated_at: updatedAt,
  };
}

/** Deduplicates and sanitizes a batch of asset IDs for canvas state query/reset. */
export function normalizeCanvasAssetIds(assetIds, sanitizeFn = null) {
  if (!Array.isArray(assetIds)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const rawId of assetIds) {
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const id = typeof sanitizeFn === "function" ? sanitizeFn(rawId, "") : rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  return cleaned;
}
