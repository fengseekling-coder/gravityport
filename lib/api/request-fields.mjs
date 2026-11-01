import { HttpError } from "../http-response.mjs";

/**
 * Request-body field validation (task 314, finding ⑤): mutation routes that
 * treat a body field as a string, an array, or a boolean must answer 400 with
 * a stable code when the type is wrong, never leak a TypeError as a 500.
 * Validation is minimal on purpose — presence and type only; semantic rules
 * stay with the stores that own them.
 */

function receivedTypeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function invalidField(name, expected, value) {
  return new HttpError(400, "INVALID_FIELD", `Field "${name}" must be ${expected} (received ${receivedTypeName(value)}).`);
}

/**
 * Returns the string value of body[name]. With `optional`, a missing or null
 * field yields "" instead of failing; a present field must still be a string.
 * `maxLength` bounds the accepted length (0 = unbounded) so oversized strings
 * are refused at the boundary rather than stored.
 */
export function requireStringField(body, name, { optional = false, maxLength = 0 } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null) {
    if (optional) return "";
    throw invalidField(name, "a string", value);
  }
  if (typeof value !== "string") throw invalidField(name, "a string", value);
  if (maxLength && value.length > maxLength) {
    throw new HttpError(400, "FIELD_TOO_LONG", `Field "${name}" exceeds ${maxLength} characters.`);
  }
  return value;
}

/**
 * Returns body[name] as a validated array. With `of: "string"` every item
 * must be a string; `maxLength` bounds the item count (0 = unbounded).
 */
export function requireArrayField(body, name, { optional = false, of = "", maxLength = 0 } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null) {
    if (optional) return [];
    throw invalidField(name, "an array", value);
  }
  if (!Array.isArray(value)) throw invalidField(name, "an array", value);
  if (maxLength && value.length > maxLength) {
    throw new HttpError(400, "FIELD_TOO_MANY", `Field "${name}" exceeds ${maxLength} items.`);
  }
  if (of === "string" && value.some((item) => typeof item !== "string")) {
    throw invalidField(`${name}[]`, "a string", value.find((item) => typeof item !== "string"));
  }
  return value;
}

/** Returns body[name] as a boolean. With `optional`, a missing field yields undefined. */
export function requireBooleanField(body, name, { optional = false } = {}) {
  const value = body?.[name];
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw invalidField(name, "a boolean", value);
  }
  if (typeof value !== "boolean") throw invalidField(name, "a boolean", value);
  return value;
}
