/** Group manifests may leave the local machine. Recursively remove runtime
 * URLs and filesystem locations while preserving user-authored text. */
const privateKey = /(_path|_url|_dir)$/
export function sanitizeAssetForExport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAssetForExport)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !privateKey.test(key) && key !== "path" && key !== "prompt_file",
  ).map(([key, item]) => [key, sanitizeAssetForExport(item)]))
}

export const referenceUses = ["identity", "subject", "world", "space", "composition", "lighting", "wardrobe", "color", "style", "prop"] as const
export const relationTypes = ["edited_from", "variant_of", "derived_from", "based_on"] as const

export function referencePermission(reference: { allowed_uses?: string[]; forbidden_uses?: string[] }, use: string): "allowed" | "forbidden" | "undeclared" {
  if (reference.forbidden_uses?.includes(use)) return "forbidden"
  if (reference.allowed_uses?.includes(use)) return "allowed"
  return "undeclared"
}

export function setReferencePermission<T extends { allowed_uses?: string[]; forbidden_uses?: string[] }>(reference: T, use: string, permission: "allowed" | "forbidden" | "undeclared"): T {
  return { ...reference,
    allowed_uses: [...new Set([...(reference.allowed_uses || []).filter(item => item !== use), ...(permission === "allowed" ? [use] : [])])].sort(),
    forbidden_uses: [...new Set([...(reference.forbidden_uses || []).filter(item => item !== use), ...(permission === "forbidden" ? [use] : [])])].sort(),
  }
}
