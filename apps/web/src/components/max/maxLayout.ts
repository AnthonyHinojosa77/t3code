/**
 * MAX's phone/computer split. T3's sidebar breakpoint is width-only, and a phone held sideways
 * is wider than that breakpoint while still being a phone: it has a coarse pointer and little
 * height. Both halves of this query must stay identical to the `PHONE` media query in
 * `council.css`; the MAX walkthrough (`e2e/max/walkthrough.mjs`) checks that before it builds.
 */
export const MAX_PHONE_MAX_WIDTH = 767;
export const MAX_LANDSCAPE_MAX_HEIGHT = 500;
export const MAX_PHONE_LAYOUT_QUERY = `(max-width: ${MAX_PHONE_MAX_WIDTH}px), (pointer: coarse) and (max-height: ${MAX_LANDSCAPE_MAX_HEIGHT}px)`;

/** The same decision as the media query, for code and tests that know the viewport. */
export function isPhoneLayout(viewport: {
  readonly width: number;
  readonly height: number;
  readonly coarsePointer: boolean;
}): boolean {
  return (
    viewport.width <= MAX_PHONE_MAX_WIDTH ||
    (viewport.coarsePointer && viewport.height <= MAX_LANDSCAPE_MAX_HEIGHT)
  );
}
