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

export const relationTypes = ["edited_from", "variant_of", "derived_from", "based_on"] as const
