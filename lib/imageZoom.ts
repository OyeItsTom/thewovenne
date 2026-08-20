/**
 * Pure zoom and pan arithmetic for the product-image viewer.
 *
 * The component records points and renders a transform; every decision about
 * how far you may zoom, where the image is allowed to sit, and whether a drag
 * moves the picture or changes it lives here, where it can be tested without a
 * browser — the same split lib/cardSwipe already makes for the card gallery.
 */

import { decideCardGesture } from "./cardSwipe";

/** Fitted to the screen. There is no reason to shrink a photograph further. */
export const MIN_ZOOM = 1;

/**
 * The range the viewer is allowed to offer.
 *
 * FLOOR, because a viewer you cannot zoom is a lightbox with extra steps, and
 * the fitted image is letterboxed on most screens — 2x still reveals weave that
 * the fit does not, even where it passes 1:1 with the source.
 *
 * CEILING, because past this you are magnifying the optimizer's pixels rather
 * than the cloth. 8x digital zoom is a marketplace feature; it shows noise and
 * implies detail that was never photographed.
 */
export const ZOOM_FLOOR = 2;
export const ZOOM_CEILING = 3;

/** What a double-tap or double-click jumps to, when it zooms in. */
export const DOUBLE_TAP_ZOOM = 2;

/**
 * How far this particular photograph can be magnified before it stops showing
 * anything new.
 *
 * `naturalWidth` is the width of the variant the browser actually loaded, and
 * it is an honest number: Next's optimizer does NOT enlarge: a 1122px source
 * asked for w=1920 comes back 1122px. So this ratio says exactly how many
 * source pixels are available per pixel currently on screen, and 1.0 is where
 * genuine detail runs out.
 *
 * That raw ratio is not what gets returned, because it varies from 0.8 to 2.2
 * across this catalogue and a magnifier whose limit changes per photograph
 * feels broken rather than honest. It is clamped into [2, 3]: every photograph
 * zooms the same 2x, and only a screen with pixels to spare and a source with
 * detail to give is allowed further. The floor does mean a ~1100px photograph
 * on a retina laptop is being enlarged past 1:1 — that is a limit of the
 * photography, and no image configuration can fix it.
 */
export function maxZoomFor({
  naturalWidth,
  displayedWidth,
  dpr = 1,
}: {
  naturalWidth: number;
  displayedWidth: number;
  dpr?: number;
}): number {
  if (!naturalWidth || !displayedWidth || displayedWidth <= 0) return ZOOM_FLOOR;
  const detail = naturalWidth / (displayedWidth * Math.max(dpr, 1));
  if (!Number.isFinite(detail)) return ZOOM_FLOOR;
  return Math.min(ZOOM_CEILING, Math.max(ZOOM_FLOOR, detail));
}

/**
 * How wide the photograph is actually DRAWN inside the frame.
 *
 * `object-contain` letterboxes: a 3:4 photograph in a landscape viewport is
 * limited by height, and is narrower than the frame it sits in. Measuring the
 * frame instead would overstate the drawn size and understate how much source
 * detail is left, so the magnifier would stop short of what the file can show.
 */
export function containedWidth({
  naturalWidth,
  naturalHeight,
  frameWidth,
  frameHeight,
}: {
  naturalWidth: number;
  naturalHeight: number;
  frameWidth: number;
  frameHeight: number;
}): number {
  if (!naturalWidth || !naturalHeight || !frameWidth || !frameHeight) return frameWidth || 0;
  return Math.min(frameWidth, (frameHeight * naturalWidth) / naturalHeight);
}

export function clampZoom(zoom: number, max: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(Math.max(zoom, MIN_ZOOM), Math.max(max, MIN_ZOOM));
}

/**
 * How far the image may be dragged, so it can never be flung off the screen.
 *
 * At 1x there is no slack at all and the offset is pinned to zero, which is
 * what stops a fitted photograph drifting when somebody swipes to change image.
 * Zoomed, the slack is half the overflow on each axis: the image edge can reach
 * the frame edge and no further, so there is never a band of empty backdrop
 * down one side.
 */
export function panBounds({
  zoom,
  frameWidth,
  frameHeight,
}: {
  zoom: number;
  frameWidth: number;
  frameHeight: number;
}): { maxX: number; maxY: number } {
  const scale = Math.max(zoom, MIN_ZOOM);
  return {
    maxX: Math.max(0, (frameWidth * scale - frameWidth) / 2),
    maxY: Math.max(0, (frameHeight * scale - frameHeight) / 2),
  };
}

export function clampPan({
  x,
  y,
  zoom,
  frameWidth,
  frameHeight,
}: {
  x: number;
  y: number;
  zoom: number;
  frameWidth: number;
  frameHeight: number;
}): { x: number; y: number } {
  const { maxX, maxY } = panBounds({ zoom, frameWidth, frameHeight });
  const fix = (v: number, max: number) =>
    !Number.isFinite(v) ? 0 : Math.min(Math.max(v, -max), max);
  return { x: fix(x, maxX), y: fix(y, maxY) };
}

/** Distance between two touch points, for a pinch. */
export function pointDistance(
  a: { x: number; y: number },
  b: { x: number; y: number }
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Where a pinch has got to: the zoom it started from, scaled by how much the
 * fingers have spread since. Ratio-based rather than delta-based, so a pinch
 * that starts, pauses and continues does not accumulate error.
 */
export function pinchZoom({
  startDistance,
  currentDistance,
  startZoom,
  max,
}: {
  startDistance: number;
  currentDistance: number;
  startZoom: number;
  max: number;
}): number {
  if (!startDistance || startDistance <= 0) return clampZoom(startZoom, max);
  return clampZoom((currentDistance / startDistance) * startZoom, max);
}

/** A wheel notch or a trackpad pinch, as a multiplier on the current zoom. */
export function wheelZoom({
  zoom,
  deltaY,
  max,
}: {
  zoom: number;
  deltaY: number;
  max: number;
}): number {
  // Exponential, so a notch feels the same at 1x as at 2.5x.
  return clampZoom(zoom * Math.exp(-deltaY / 260), max);
}

/** A double-tap toggles: fitted ⇄ magnified, never a third state to discover. */
export function doubleTapZoom(zoom: number, max: number): number {
  return zoom > MIN_ZOOM + 0.01 ? MIN_ZOOM : clampZoom(DOUBLE_TAP_ZOOM, max);
}

export type ViewerGesture =
  | { kind: "pan" }
  | { kind: "navigate"; nextIndex: number }
  | { kind: "tap" }
  | { kind: "none" };

/**
 * What a one-finger drag means.
 *
 * ZOOMED, IT ALWAYS PANS. This is the rule that stops the viewer feeling
 * possessed: once you are in close on a border, dragging sideways to follow
 * that border must not throw you onto the next photograph.
 *
 * FITTED, IT IS THE GALLERY'S OWN DECISION — decideCardGesture, the same
 * function the product cards and the PDP gallery use, so the slop, the axis
 * bias, the 36px threshold, the multi-touch rejection and the clamp at the ends
 * are defined once for the whole site rather than three times.
 */
export function decideViewerGesture(input: {
  zoom: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  index: number;
  imageCount: number;
  cancelled?: boolean;
  multiTouch?: boolean;
}): ViewerGesture {
  if (input.zoom > MIN_ZOOM + 0.01) return { kind: "pan" };

  const decision = decideCardGesture({
    startX: input.startX,
    startY: input.startY,
    endX: input.endX,
    endY: input.endY,
    index: input.index,
    imageCount: input.imageCount,
    cancelled: input.cancelled,
    multiTouch: input.multiTouch,
  });

  if (decision.kind === "swipe") return { kind: "navigate", nextIndex: decision.nextIndex };
  if (decision.kind === "tap") return { kind: "tap" };
  return { kind: "none" };
}

/**
 * The width the viewer asks the optimizer for.
 *
 * PINNED TO THE CEILING next.config.mjs ALREADY SETS, and asserted equal to it
 * in scripts/image-optimization.test.ts, so this cannot drift from the config
 * and cannot widen it. #132 removed 2048 and 3840 because nothing could display
 * them; this reaches the top of what survived and stops.
 *
 * A PIXEL WIDTH, NOT A vw EXPRESSION. Both emit the same candidate list — Next
 * offers every configured width whenever `sizes` is set on a `fill` image — but
 * they SELECT differently, and selection is what gets fetched. `1920px` asks for
 * 1920 on every device. `200vw` asks for twice the viewport, which on a 320px
 * phone at dpr 1 is 640: a screen-sized file handed to a magnifier. The px form
 * is the only one that means "the largest variant" everywhere.
 *
 * Asking for the largest variant is the point. The viewer exists for what you
 * see AFTER you magnify, so sizing the request to the fitted image would mean
 * every zoom was an enlargement of a screen-sized file.
 */
export const ZOOM_REQUEST_WIDTH = 1920;

export function viewerSizes(): string {
  return `${ZOOM_REQUEST_WIDTH}px`;
}
