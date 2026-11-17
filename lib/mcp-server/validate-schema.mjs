// Tool argument schema validation for the MCP server (task 440). Pure moves; no behavior changes.

export function validateSchema(schema, value, path) {
  if (!schema || typeof schema !== "object") return "";
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((candidate) => !validateSchema(candidate, value, path))) return "";
    return `${path} does not match any allowed shape.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `${path} must be one of: ${schema.enum.join(", ")}.`;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) return `${path}.${required} is required.`;
    }
    const properties = schema.properties || {};
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(value).find((key) => !Object.hasOwn(properties, key));
      if (unknown) return `${path}.${unknown} is not allowed.`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key)) continue;
      const error = validateSchema(child, value[key], `${path}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    for (let index = 0; index < value.length; index += 1) {
      const error = validateSchema(schema.items, value[index], `${path}[${index}]`);
      if (error) return error;
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") return `${path} must be a string.`;
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} must contain at least ${schema.minLength} characters.`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} must contain at most ${schema.maxLength} characters.`;
    if (typeof schema.pattern === "string") {
      let pattern;
      try { pattern = new RegExp(schema.pattern); }
      catch { return `${path} has an invalid schema pattern.`; }
      if (!pattern.test(value)) return `${path} must match ${schema.pattern}.`;
    }
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") return `${path} must be a boolean.`;
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value)) return `${path} must be an integer.`;
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a finite number.`;
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items.`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items.`;
  }
  if (typeof value === "number") {
    if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${path} must be >= ${schema.minimum}.`;
    if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${path} must be <= ${schema.maximum}.`;
  }
  return "";
}
