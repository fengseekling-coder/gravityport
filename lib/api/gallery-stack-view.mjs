// Shared rule deciding whether a gallery request renders stacks as one
// logical node. A non-empty search query always lists every matching image on
// its own; stacks come back only once the query is cleared. Every other
// filter (category, favorites, scopes, …) keeps the collapsing behavior —
// except a learning-library view (task 459), where every member is shown as
// its own card, stacks unfolded.
// Both the gallery list endpoint and the incremental gallery-rows
// reconciliation route their `collapseStacks` decision through here, so the
// list and live sync can never disagree about stacking.

export function galleryCollapsesStacks({ view, scope, query, learningLibrary } = {}) {
  if (view !== "gallery") return false;
  if (scope === "trash") return false;
  if (learningLibrary) return false;
  return String(query ?? "").trim() === "";
}

// True when the request would collapse stacks but a non-empty search query
// flattens it. The routes use this to also suppress stack-cover annotations
// (`stackCoverAnnotations: false`), so a matching cover is listed as a plain
// image instead of rendering as a stack node in the flattened gallery.
export function gallerySearchFlattens({ view, scope, query } = {}) {
  if (view !== "gallery") return false;
  if (scope === "trash") return false;
  return String(query ?? "").trim() !== "";
}
