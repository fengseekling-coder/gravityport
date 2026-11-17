// Compact result builders for the MCP server's asset_list / asset_search answers (task 440). Pure moves; no behavior changes.

// Task 376: asset_list / asset_search answers carry a fixed slim field set
// instead of the full rowToAsset payload (recipe snapshots, palette, runtime
// URLs and paths made a 100-asset page ~220KB). Full detail stays on
// asset_get. Field sources (mirroring rowToAsset in lib/sqlite-asset-store.mjs
// and the shared mediaKindOf rule at lib/sqlite-asset-store.mjs:109):
//   id ← asset.id; file_name ← asset.asset (the managed file name, the same
//   key provenance-bundle.mjs exports as file_name); media_kind ← the shared
//   mediaKindOf rule (source.media_kind || business_fields.media_kind, then
//   the file extension); width/height ← business_fields.width/height;
//   prompt_excerpt ← prompt (first 80 characters, "…" when cut, "" when the
//   asset has no prompt); group ← asset.group; tags/rating/favorite/
//   created_at/image_path carry over; stack ← the attachStackToAssets summary
//   reduced to { id, name }, the key dropped when the asset is unstacked.
// A field whose value is missing on the asset (a video without dimensions, an
// empty tag list, rating 0, favorite false) is omitted, never placeholdered.
const PROMPT_EXCERPT_CHARACTERS = 80;
const COMPACT_QUERY_ECHO_CHARACTERS = 200;
const COMPACT_LIST_DEFAULT_LIMIT = 20;
const COMPACT_LIST_MAX_LIMIT = 100;
const COMPACT_MEDIA_IMAGE_EXTENSIONS = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const COMPACT_MEDIA_VIDEO_EXTENSIONS = new Set([".m4v", ".mov", ".mp4", ".webm"]);

function excerptCharacters(value, maxCharacters) {
  const text = typeof value === "string" ? value : "";
  const chars = Array.from(text);
  return chars.length > maxCharacters ? `${chars.slice(0, maxCharacters).join("")}…` : text;
}

function compactMediaKind(asset) {
  const kind = asset?.source?.media_kind || asset?.business_fields?.media_kind;
  if (kind === "video" || kind === "image") return kind;
  const match = /\.([a-z0-9]+)(?:$|\?)/i.exec(String(asset?.image_path || ""));
  const ext = match ? `.${match[1].toLowerCase()}` : "";
  if (COMPACT_MEDIA_VIDEO_EXTENSIONS.has(ext)) return "video";
  if (COMPACT_MEDIA_IMAGE_EXTENSIONS.has(ext)) return "image";
  return "unknown";
}

export function compactAsset(asset) {
  if (!asset || typeof asset !== "object") return asset;
  const compact = { id: asset.id };
  if (asset.asset) compact.file_name = asset.asset;
  compact.media_kind = compactMediaKind(asset);
  const width = Number(asset.business_fields?.width);
  if (Number.isFinite(width) && width > 0) compact.width = width;
  const height = Number(asset.business_fields?.height);
  if (Number.isFinite(height) && height > 0) compact.height = height;
  compact.prompt_excerpt = excerptCharacters(asset.prompt, PROMPT_EXCERPT_CHARACTERS);
  if (asset.group) compact.group = asset.group;
  if (Array.isArray(asset.tags) && asset.tags.length) compact.tags = [...asset.tags];
  const rating = Number(asset.rating);
  if (Number.isFinite(rating) && rating > 0) compact.rating = rating;
  if (asset.favorite === true) compact.favorite = true;
  compact.created_at = asset.created_at;
  if (asset.stack && typeof asset.stack === "object") {
    compact.stack = { id: asset.stack.id, name: asset.stack.name };
  }
  if (asset.image_path) compact.image_path = asset.image_path;
  return compact;
}

export function compactListLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return COMPACT_LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), COMPACT_LIST_MAX_LIMIT);
}

// Task 376: the readable content text leads with the bilingual summary (and,
// when a next page exists, the paging hint on the same line), then one line
// per asset on this page: `<id> · <file_name>`.
export function compactResultText({ search, total, count, nextCursor, assets }) {
  const summary = search
    ? `找到 ${total} 张，这页 ${count} 张。/ ${total} matches, ${count} on this page.`
    : `共 ${total} 张，这页 ${count} 张。/ ${total} assets, ${count} on this page.`;
  const more = nextCursor ? " 还有更多，传 cursor 翻页。/ More results: pass cursor." : "";
  const lines = [`${summary}${more}`, ...assets.map((asset) => `${asset?.id} · ${asset?.file_name ?? ""}`)];
  return lines.join("\n");
}
