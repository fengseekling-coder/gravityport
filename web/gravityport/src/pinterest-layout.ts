/**
 * Pinterest masonry layout — pure functions, no React and no DOM.
 *
 * Pins are distributed shortest-column-first so appending a page never moves
 * an already-placed Pin: each placement depends only on the placements before
 * it. CSS `columns` is deliberately avoided because it reflows every column
 * when the next page lands.
 */

import type { PinterestPin } from "./pinterest-api.js";

/** Height/width ratio used for column balance; 1:1 when dimensions are missing. */
export function pinAspectRatio(pin: PinterestPin): number {
  const dims = pin.thumbnail;
  if (dims && dims.width > 0 && dims.height > 0) {
    return dims.height / dims.width;
  }
  return 1;
}

/**
 * Distribute pins into columns shortest-column-first; ties go to the lower
 * column index. columnCount of 0, negative, or non-finite values means 1.
 */
export function layoutPinColumns(pins: PinterestPin[], columnCount: number): PinterestPin[][] {
  const count =
    typeof columnCount === "number" && Number.isFinite(columnCount) && columnCount >= 1
      ? Math.floor(columnCount)
      : 1;
  const columns: PinterestPin[][] = Array.from({ length: count }, () => []);
  const heights = new Array<number>(count).fill(0);

  for (const pin of pins) {
    let shortest = 0;
    for (let i = 1; i < count; i++) {
      if (heights[i] < heights[shortest]) shortest = i;
    }
    columns[shortest].push(pin);
    heights[shortest] += pinAspectRatio(pin);
  }

  return columns;
}

/** Column count for a container width with a 220px minimum column width. */
export function pinterestColumnCount(containerWidth: number): number {
  return Math.max(1, Math.floor(containerWidth / 220));
}
