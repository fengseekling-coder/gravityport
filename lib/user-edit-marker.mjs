/**
 * Markers for text fields a human actually changed, stored inside the asset's
 * `source`. Automatic pipelines (Codex / Grok reconciliation, web capture
 * prompt upgrades) must never overwrite a value a user typed, so every human
 * entry point stamps these markers and every automatic writer checks them
 * first. Field names are load-bearing: lib/sqlite-asset-store.mjs and the
 * Jimeng deletion sync read them directly.
 */

const TEXT_EDIT_KEYS = ["prompt", "theme", "user_prompt", "negative_prompt", "skill", "style"];

function trimmedText(value) {
  return String(value ?? "").trim();
}

function textChanged(currentValue, nextValue) {
  return trimmedText(currentValue) !== trimmedText(nextValue);
}

/**
 * Compare a human-provided patch against the stored asset and return a patch
 * carrying the edit markers. Only real changes (compared after trimming
 * whitespace, matching how the store normalizes text) gain a marker; a patch
 * that changes no text field is returned untouched. When the patch carries its
 * own `source`, the stored source is merged underneath it and the markers are
 * applied last, so a patch can never wipe an existing marker.
 */
export function withUserEditMarkers(current, patch, nowIso = new Date().toISOString()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const changedKeys = TEXT_EDIT_KEYS.filter(
    (key) => Object.hasOwn(patch, key) && textChanged(current?.[key], patch[key]),
  );
  if (!changedKeys.length) return patch;
  const markers = { user_edited_at: nowIso };
  if (changedKeys.includes("prompt")) markers.prompt_user_edited_at = nowIso;
  if (changedKeys.includes("theme")) markers.theme_user_edited_at = nowIso;
  const currentSource = current?.source && typeof current.source === "object" ? current.source : {};
  const patchSource = patch.source && typeof patch.source === "object" ? patch.source : {};
  return { ...patch, source: { ...currentSource, ...patchSource, ...markers } };
}

/** True when a human edited the prompt through a marked entry point. */
export function isPromptUserEdited(asset) {
  return Boolean(asset?.source?.prompt_user_edited_at);
}

/** True when a human edited the display name (`theme`) through a marked entry point. */
export function isThemeUserEdited(asset) {
  return Boolean(asset?.source?.theme_user_edited_at);
}
