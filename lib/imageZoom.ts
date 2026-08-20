/**
 * Pure zoom and pan arithmetic for the product-image viewer.
 *
 * The component records points and renders a transform; every decision about
 * how far you may zoom, where the image is allowed to sit, and whether a drag
 * moves the picture or changes it lives here, where it can be tested without a
 * browser — the same split lib/cardSwipe already makes for the card gallery.
 */

import { TAP_SLOP, decideCardGesture } from "./cardSwipe";

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
  floor = ZOOM_FLOOR,
  ceiling = ZOOM_CEILING,
}: {
  naturalWidth: number;
  displayedWidth: number;
  dpr?: number;
  /** Callers may narrow the range; the defaults are the viewer's own. */
  floor?: number;
  ceiling?: number;
}): number {
  if (!naturalWidth || !displayedWidth || displayedWidth <= 0) return floor;
  const detail = naturalWidth / (displayedWidth * Math.max(dpr, 1));
  if (!Number.isFinite(detail)) return floor;
  return Math.min(ceiling, Math.max(floor, detail));
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
 * A TAP IS RECOGNISED FIRST, AT EVERY ZOOM LEVEL. This ordering is the whole
 * bug fix. The previous version answered "pan" for anything at all while the
 * photograph was magnified — which is true of a DRAG and false of a TAP, and it
 * made the double-tap that zooms back out unreachable: every release while
 * zoomed was classified as a pan, so the caller returned before it could ever
 * see a second tap. Zoom in worked, zoom out could not, and no amount of timing
 * or touch-action would have changed it.
 *
 * So: a release that did not move is a tap, whatever the zoom. Only once we
 * know the finger actually travelled does zoom decide the meaning.
 *
 * ZOOMED, A TRAVELLING DRAG ALWAYS PANS. Once you are in close on a border,
 * dragging sideways to follow it must not throw you onto the next photograph.
 *
 * FITTED, IT IS THE GALLERY'S OWN DECISION — decideCardGesture, the same
 * function the product cards and the PDP gallery use, so the axis bias, the
 * 36px threshold and the clamp at the ends are defined once for the site.
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
  if (input.cancelled || input.multiTouch) return { kind: "none" };

  const dx = input.endX - input.startX;
  const dy = input.endY - input.startY;
  // Before anything else, and deliberately independent of decideCardGesture,
  // which reports "ignored" for a single-image product and would otherwise
  // deny those products a double-tap.
  if (Math.abs(dx) <= TAP_SLOP && Math.abs(dy) <= TAP_SLOP) return { kind: "tap" };

  if (input.zoom > MIN_ZOOM + 0.01) return { kind: "pan" };

  const decision = decideCardGesture({
    startX: input.startX,
    startY: input.startY,
    endX: input.endX,
    endY: input.endY,
    index: input.index,
    imageCount: input.imageCount,
  });

  if (decision.kind === "swipe") return { kind: "navigate", nextIndex: decision.nextIndex };
  return { kind: "none" };
}

/**
 * Where the photograph must sit so the point you asked about stays put.
 *
 * The stage scales about its centre, so a point p lands at
 *   screen = centre + (p - centre) * zoom + offset
 * Holding that fixed across a zoom change gives
 *   offset' = offset + (p - centre) * (zoom - zoom')
 * which is the whole of it. Double-clicking embroidery in the lower right
 * therefore enlarges around the embroidery instead of the middle of the frame.
 *
 * Bounded by the same clamp as a drag, so a focal zoom cannot park the picture
 * somewhere a drag would not have been allowed to reach — and returning to
 * fitted is exactly (0, 0), never a residue of wherever you happened to click.
 */
export function focalPan({
  pointerX,
  pointerY,
  stageWidth,
  stageHeight,
  fromZoom,
  toZoom,
  offsetX,
  offsetY,
}: {
  pointerX: number;
  pointerY: number;
  stageWidth: number;
  stageHeight: number;
  fromZoom: number;
  toZoom: number;
  offsetX: number;
  offsetY: number;
}): { x: number; y: number } {
  if (toZoom <= MIN_ZOOM + 0.01) return { x: 0, y: 0 };
  if (!stageWidth || !stageHeight) return { x: 0, y: 0 };
  const shiftX = (pointerX - stageWidth / 2) * (fromZoom - toZoom);
  const shiftY = (pointerY - stageHeight / 2) * (fromZoom - toZoom);
  return clampPan({
    x: Number.isFinite(shiftX) ? offsetX + shiftX : offsetX,
    y: Number.isFinite(shiftY) ? offsetY + shiftY : offsetY,
    zoom: toZoom,
    frameWidth: stageWidth,
    frameHeight: stageHeight,
  });
}

/**
 * The zoom the viewer settles on, with fitted meaning EXACTLY fitted.
 *
 * A pinch that drifts to 1.004 leaves a scale that is not 1 and a transform
 * that is not identity — invisible, and enough to keep a stale pan alive and to
 * make the next gesture read as "still zoomed". Anything within a hair of the
 * fit becomes the fit.
 */
export function settleZoom(zoom: number, max: number): number {
  const z = clampZoom(zoom, max);
  return z <= MIN_ZOOM + 0.01 ? MIN_ZOOM : z;
}

/**
 * The width the viewer asks the optimizer for.
 *
 * PINNED TO THE CEILING next.config.mjs ALREADY SETS, and asserted equal to it
 * in scripts/image-optimization.test.ts, so this cannot drift from the config
 * and cannot widen it. #132 removed 2048 and 3840 because nothing could display
 * them; this reaches the top of what survived and stops.
 *
 * A PIXEL WIDTH, NOT A vw EXPRESSION, FOR TWO REASONS.
 *
 * SELECTION. Both forms emit the same candidate list — Next offers every
 * configured width whenever `sizes` is set on a `fill` image — but they choose
 * differently, and the choice is what gets fetched. `1920px` asks for 1920 on
 * every device. `200vw` asks for twice the viewport, which on a 320px phone at
 * dpr 1 is 640: a screen-sized file handed to a magnifier.
 *
 * AND MEASUREMENT, which is less obvious and easier to break. `naturalWidth` is
 * DENSITY-CORRECTED for a srcset with `w` descriptors: the product page's frame
 * loads a real 1200px file and reports `naturalWidth === 390`, because 1200
 * across a 390px slot is treated as a 3.08x image. Every zoom ceiling
 * in this module is a ratio of naturalWidth to drawn pixels, so reading it off
 * a vw-sized layer would understate the available detail by the device's own
 * density and quietly cap the magnifier. A fixed px `sizes` gives a density of
 * 1, and therefore a naturalWidth that is a true pixel count.
 *
 * Asking for the largest variant is the point. The viewer exists for what you
 * see AFTER you magnify, so sizing the request to the fitted image would mean
 * every zoom was an enlargement of a screen-sized file.
 */
export const ZOOM_REQUEST_WIDTH = 1920;

export function viewerSizes(): string {
  return `${ZOOM_REQUEST_WIDTH}px`;
}

/**
 * Which double gesture the device gets.
 *
 * NOT A WIDTH. An iPad Pro reports a 1024px viewport and has no mouse; a small
 * laptop window reports 900px and has one. A fine pointer gets the browser's own
 * `dblclick`, which is reliable and needs no timing code; a finger gets the
 * hand-rolled double-tap, because mobile browsers delay or withhold `dblclick`
 * where they reserve it for their own page zoom.
 *
 * Both drive the SAME zoom state — there is one scale and one offset in this
 * viewer, never a separate one per input.
 */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";
