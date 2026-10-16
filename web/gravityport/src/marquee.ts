import type { MasonryModel } from "./gallery-window"

// Marquee selection geometry (task 155). Boxes live in grid content
// coordinates (viewport offset + scroll), so a sweep that auto-scrolls keeps
// its origin and still reaches cards the virtualized window has unmounted.

/** Movement before a press becomes a marquee; a shorter Shift press on a
 * card stays a Shift-click range selection. */
export const MARQUEE_DRAG_THRESHOLD_PX = 4
/** Distance from the grid's top/bottom edge where a sweep auto-scrolls. */
export const MARQUEE_AUTO_SCROLL_EDGE_PX = 48
/** Auto-scroll speed per 16ms tick at the very edge (or beyond it). */
export const MARQUEE_AUTO_SCROLL_MAX_PX = 24

export type Box = { left: number; top: number; right: number; bottom: number }

export function boxFromPoints(x0: number, y0: number, x1: number, y1: number): Box {
  return { left: Math.min(x0, x1), top: Math.min(y0, y1), right: Math.max(x0, x1), bottom: Math.max(y0, y1) }
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** Scroll delta for a pointer at `y` inside a grid spanning [top, bottom]:
 * negative near the top edge, positive near the bottom, 0 in between; the
 * speed ramps up linearly across the edge band. */
export function marqueeAutoScrollStep(
  y: number, top: number, bottom: number,
  edge = MARQUEE_AUTO_SCROLL_EDGE_PX, max = MARQUEE_AUTO_SCROLL_MAX_PX,
): number {
  if (![y, top, bottom].every(Number.isFinite) || bottom <= top || edge <= 0) return 0
  const ramp = (depth: number) => Math.ceil(max * Math.min(1, depth / edge))
  if (y < top + edge) return -ramp(top + edge - y)
  if (y > bottom - edge) return ramp(y - (bottom - edge))
  return 0
}

/** Auto-scroll ticks on a timer, not requestAnimationFrame: a hidden or
 * occluded window may never run frames. Each tick scrolls for the time that
 * actually passed (at least one tick, at most four), so the speed does not
 * depend on the refresh rate or on timer throttling. */
export const MARQUEE_AUTO_SCROLL_TICK_MS = 16

export function marqueeAutoScrollDelta(step: number, elapsedMs: number): number {
  if (!step || !Number.isFinite(step)) return 0
  const ms = Number.isFinite(elapsedMs) ? elapsedMs : MARQUEE_AUTO_SCROLL_TICK_MS
  const clamped = Math.min(Math.max(ms, MARQUEE_AUTO_SCROLL_TICK_MS), MARQUEE_AUTO_SCROLL_TICK_MS * 4)
  return Math.round(step * clamped / MARQUEE_AUTO_SCROLL_TICK_MS)
}

/** Every card's box relative to the masonry origin, for a column unit `unit`
 * in px — the same formula masonryCardCss() hands to CSS calc(). */
export function masonryCardBoxes(model: MasonryModel, unit: number): Box[] {
  return model.placements.map(place => {
    const left = unit * place.column + place.column * model.gap
    const top = unit * place.topUnits + place.topGaps * model.gap
    const width = unit * place.span + (place.span - 1) * model.gap
    const height = unit * place.heightUnits + place.heightGaps * model.gap
    return { left, top, right: left + width, bottom: top + height }
  })
}

/** The selection a sweep commits: a plain marquee is exactly the swept cards;
 * an additive (Shift) marquee keeps the selection it started from, and a
 * marquee that starts on a card always includes that card. */
export function marqueeSelection(opts: { base: string[]; startId: string; hits: string[] }): string[] {
  return [...new Set([...opts.base, ...(opts.startId ? [opts.startId] : []), ...opts.hits])]
}
