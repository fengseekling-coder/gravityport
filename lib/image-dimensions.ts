// Shared image-dimension math (task 292).
//
// createAsset reads width/height from the file header at import time and
// completeDerivativeJob writes them again from the derivative pass. Both
// must apply EXIF orientation identically, or every card would visibly
// change ratio a second time when its derivatives finish. Keep this the
// single definition of the swap.

export interface OrientedImageMetadata {
  width?: number;
  height?: number;
  orientation?: number | string;
}

export interface OrientedImageDimensions {
  width: number;
  height: number;
}

/** Display dimensions for a stored image: EXIF orientations 5-8 record the
 * pixels rotated 90°, so the stored grid's width/height swap on display.
 * Values pass through Number() — missing metadata yields NaN, and callers
 * guard on finiteness/positivity before writing. */
export function orientedImageDimensions(metadata: OrientedImageMetadata | null | undefined): OrientedImageDimensions {
  const orientation = Number(metadata?.orientation) || 1;
  const swapsAxes = orientation >= 5 && orientation <= 8;
  return {
    width: swapsAxes ? Number(metadata?.height) : Number(metadata?.width),
    height: swapsAxes ? Number(metadata?.width) : Number(metadata?.height),
  };
}
