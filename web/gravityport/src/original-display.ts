// Task 413: which media URLs this Chromium renderer can actually decode.
//
// TIFF and HEIC/HEIF originals never render in an <img> (no browser decoder),
// so the viewer keeps their 1600px preview and cards show the empty-card
// placeholder while the derivative is still missing. The extension list is the
// task 413 members of IMAGE_EXTENSIONS in lib/library-location.mjs (the single
// source); renderer code must not import lib/, so the list lives here — one
// definition for both the viewer and the cards — with that pointer as its only
// anchor.

const ORIGINAL_UNDISPLAYABLE_PATTERN = /\.(?:tiff?|heic|heif)(?:[?#].*)?$/i

/** Whether the browser can render this original URL inside <img>. */
export function browserCanDisplayOriginal(url: string | null | undefined): boolean {
  return !!url && !ORIGINAL_UNDISPLAYABLE_PATTERN.test(url)
}

/** Whether this URL must render the empty-card placeholder instead of <img>. */
export function needsImagePlaceholder(url: string | null | undefined): boolean {
  return !!url && ORIGINAL_UNDISPLAYABLE_PATTERN.test(url)
}
