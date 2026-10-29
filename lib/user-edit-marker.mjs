/**
 * Markers for text fields a human actually changed, stored inside the asset's
 * `source`. Automatic pipelines (Codex / Grok reconciliation, web capture
 * prompt upgrades) must never overwrite a value a user typed, so every human
 * entry point stamps these markers and every automatic writer checks them
 * first. Field names are load-bearing: lib/sqlite-asset-store.mjs and the
 * Jimeng deletion sync read them directly.
 *
 * Alongside the markers this module owns the prompt_status of a hand edit:
 * a really-changed (non-empty) prompt becomes status "user-edited" so recipe
 * snapshots no longer describe it as the site's prompt, and clearing the
 * prompt is not an edit at all — the marker is removed, the status returns to
 * not-available, and the next capture of the same image refills the prompt
 * from the site. Callers can never set or clear the markers themselves; the
 * final marker values are always decided here.
 */

const TEXT_EDIT_KEYS = ["prompt", "theme", "user_prompt", "negative_prompt", "skill", "style"];

// The marker keys a caller may never write; withUserEditMarkers strips them
// from the patch's source in every path.
const MARKER_KEYS = ["prompt_user_edited_at", "theme_user_edited_at", "user_edited_at"];

function trimmedText(value) {
  return String(value ?? "").trim();
}

function textChanged(currentValue, nextValue) {
  return trimmedText(currentValue) !== trimmedText(nextValue);
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sourceWithoutCallerMarkers(patchSource) {
  if (!patchSource || typeof patchSource !== "object" || Array.isArray(patchSource)) return {};
  const clean = { ...patchSource };
  for (const key of MARKER_KEYS) delete clean[key];
  return clean;
}

/**
 * Compare a human-provided patch against the stored asset and return a patch
 * carrying the edit markers. Only real changes (compared after trimming
 * whitespace, matching how the store normalizes text) gain a marker; a patch
 * that changes no text field keeps the stored markers and loses any marker
 * keys the patch tried to set. Clearing the prompt (empty after trimming) is
 * not an edit: it removes the prompt marker, resets the prompt status to
 * not-available, and stamps no user_edited_at unless another text field also
 * changed. When the patch carries its own `source`, the stored source is
 * merged underneath it and the marker/status values are applied last.
 */
export function withUserEditMarkers(current, patch, nowIso = new Date().toISOString()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const currentSource = plainObject(current?.source);
  const patchSource = plainObject(patch.source);
  const callerMarkerKeys = MARKER_KEYS.filter((key) => Object.hasOwn(patchSource, key));
  const changedKeys = TEXT_EDIT_KEYS.filter(
    (key) => Object.hasOwn(patch, key) && textChanged(current?.[key], patch[key]),
  );
  if (!changedKeys.length) {
    if (!callerMarkerKeys.length) return patch;
    // No text change, so the markers simply keep their stored values.
    return { ...patch, source: { ...currentSource, ...sourceWithoutCallerMarkers(patchSource) } };
  }
  const promptCleared = changedKeys.includes("prompt") && !trimmedText(patch.prompt);
  const markers = {};
  if (promptCleared) {
    // Clearing the prompt is not a hand edit: drop the marker and the status,
    // so a later capture of the same image refills the prompt from the site.
    markers.prompt_user_edited_at = null;
    markers.prompt_status = "not-available";
  } else if (changedKeys.includes("prompt")) {
    markers.prompt_user_edited_at = nowIso;
    markers.prompt_status = "user-edited";
  }
  if (changedKeys.includes("theme")) markers.theme_user_edited_at = nowIso;
  // Clearing only the prompt stamps no user_edited_at; any other text change
  // in the same patch still does.
  if (changedKeys.some((key) => key !== "prompt" || !promptCleared)) markers.user_edited_at = nowIso;
  const result = { ...patch, source: { ...currentSource, ...sourceWithoutCallerMarkers(patchSource), ...markers } };
  if (changedKeys.includes("prompt")) {
    result.business_fields = {
      ...plainObject(current?.business_fields),
      ...plainObject(patch.business_fields),
      prompt_status: promptCleared ? "not-available" : "user-edited",
    };
  }
  return result;
}

/** True when a human edited the prompt through a marked entry point. */
export function isPromptUserEdited(asset) {
  return Boolean(asset?.source?.prompt_user_edited_at);
}

/** True when a human edited the display name (`theme`) through a marked entry point. */
export function isThemeUserEdited(asset) {
  return Boolean(asset?.source?.theme_user_edited_at);
}
