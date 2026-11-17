export const CURATION_NOTE_MAX_LENGTH = 4000;

export function normalizeAssetCuration(input = {}) {
  return {
    curated: input.curated === true,
    curation_note: String(input.curation_note ?? input.note ?? "").trim().slice(0, CURATION_NOTE_MAX_LENGTH),
  };
}

/** PATCH semantics: a field the caller leaves out keeps its stored value, so
 * saving only a note never clears 整理好 (and vice versa). */
export function mergeAssetCuration(current = {}, input = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  return normalizeAssetCuration({
    curated: has("curated") ? input.curated : current?.curated === true,
    curation_note: has("curation_note") ? input.curation_note : has("note") ? input.note : current?.curation_note,
  });
}
