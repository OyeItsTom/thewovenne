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
  floor = ZOOM_FLOOR,
  ceiling = ZOOM_CEILING,
}: {
  naturalWidth: number;
  displayedWidth: number;
  dpr?: number;
  /** The lens and the touch zoom want different ranges from the same ratio. */
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
 * across a 390px slot is treated as a 3.08x image. Every zoom and lens ceiling
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

/* ------------------------------------------------------------------ the lens */

/**
 * What counts as a device that can hold a magnifying glass.
 *
 * NOT A WIDTH. An iPad Pro reports a 1024px viewport and has no mouse; a small
 * laptop window reports 900px and has one. Asking the pointer itself is the only
 * question that gets both right — `hover: hover` rules out devices that merely
 * simulate a hover on tap, and `pointer: fine` rules out a fingertip, which
 * cannot aim a 180px lens at a thread.
 *
 * Watched rather than read once, because it genuinely changes under you: pairing
 * a mouse with a tablet flips it mid-session.
 */
export const FINE_POINTER_QUERY = "(hover: hover) and (pointer: fine)";

/**
 * The lens is sized from the stage, not fixed.
 *
 * A 180px circle over a 600px photograph is a considered detail; the same circle
 * over a 320px one is a porthole covering most of the picture. A share of the
 * stage keeps the proportion — and therefore the restraint — the same
 * everywhere, within bounds that stop it becoming either a dot or a takeover.
 */
export const LENS_MIN_DIAMETER = 120;
export const LENS_MAX_DIAMETER = 220;
export const LENS_STAGE_SHARE = 0.34;

export function lensDiameterFor(stageWidth: number): number {
  if (!stageWidth || stageWidth <= 0) return LENS_MIN_DIAMETER;
  const wanted = stageWidth * LENS_STAGE_SHARE;
  const bounded = Math.min(LENS_MAX_DIAMETER, Math.max(LENS_MIN_DIAMETER, wanted));
  // On a genuinely small stage the bounds could still exceed it; never allow a
  // lens wider than the thing it is inspecting.
  return Math.min(bounded, stageWidth);
}

/**
 * How much the lens magnifies.
 *
 * Lower floor than the touch zoom, higher demand for honesty: a lens sits on top
 * of a photograph the customer can already see, so its whole value is that the
 * pixels inside it are REAL. It magnifies what the loaded file actually holds
 * and stops — this is the same detail ratio the touch zoom uses, read against a
 * narrower range.
 */
export const LENS_MIN_MAGNIFICATION = 1.8;
export const LENS_MAX_MAGNIFICATION = 3;

export function lensMagnificationFor({
  naturalWidth,
  stageWidth,
  dpr = 1,
}: {
  naturalWidth: number;
  stageWidth: number;
  dpr?: number;
}): number {
  return maxZoomFor({
    naturalWidth,
    displayedWidth: stageWidth,
    dpr,
    floor: LENS_MIN_MAGNIFICATION,
    ceiling: LENS_MAX_MAGNIFICATION,
  });
}

export interface LensGeometry {
  centerX: number;
  centerY: number;
  diameter: number;
  backgroundWidth: number;
  backgroundHeight: number;
  backgroundX: number;
  backgroundY: number;
}

/**
 * Where the lens sits, and which part of the photograph shows inside it.
 *
 * TWO THINGS HAVE TO AGREE. The stage draws the photograph with `object-cover`
 * at 3:4 — the same crop the product page uses — and the lens draws the same
 * file as a CSS background. If the background were simply stretched to the
 * stage, a source that is not 3:4 would be subtly distorted inside the circle
 * and match nothing around it. So the cover crop is reproduced here: scale to
 * whichever axis binds, then discard the overflow evenly from both sides.
 *
 * THE CENTRE IS CLAMPED, AND THE VIEW FOLLOWS THE CENTRE. Clamping keeps the
 * circle inside the picture, which is what stops a crescent of backdrop
 * appearing at the edges. Anchoring the magnified view to the clamped centre
 * rather than the raw pointer is what keeps the lens FULL of photograph: within
 * half a lens of an edge the two part company, and the alternative would be
 * empty space inside the glass.
 */
export function lensGeometry({
  pointerX,
  pointerY,
  stageWidth,
  stageHeight,
  naturalWidth,
  naturalHeight,
  magnification,
  diameter,
}: {
  pointerX: number;
  pointerY: number;
  stageWidth: number;
  stageHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  magnification: number;
  diameter: number;
}): LensGeometry {
  const d = Math.min(diameter, stageWidth, stageHeight);
  const r = d / 2;
  const clamp = (v: number, min: number, max: number) =>
    max < min ? (min + max) / 2 : Math.min(Math.max(v, min), max);

  const centerX = clamp(pointerX, r, stageWidth - r);
  const centerY = clamp(pointerY, r, stageHeight - r);

  // Reproduce `object-cover`, so the glass and the picture under it agree.
  const coverScale =
    naturalWidth > 0 && naturalHeight > 0
      ? Math.max(stageWidth / naturalWidth, stageHeight / naturalHeight)
      : 1;
  const drawnWidth = (naturalWidth || stageWidth) * coverScale;
  const drawnHeight = (naturalHeight || stageHeight) * coverScale;
  const cropX = (drawnWidth - stageWidth) / 2;
  const cropY = (drawnHeight - stageHeight) / 2;

  return {
    centerX,
    centerY,
    diameter: d,
    backgroundWidth: drawnWidth * magnification,
    backgroundHeight: drawnHeight * magnification,
    // Put the stage point under the lens centre at the centre of the circle.
    backgroundX: r - (centerX + cropX) * magnification,
    backgroundY: r - (centerY + cropY) * magnification,
  };
}
