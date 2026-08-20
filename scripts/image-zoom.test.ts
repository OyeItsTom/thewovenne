/**
 * The product-image viewer: its arithmetic, and the contract of the component
 * that renders it.
 *
 * The zoom/pan model is exercised for real — every clamp, bound and gesture
 * decision is a pure function and is called here. The parts that only exist as
 * markup (dialog semantics, the conditional mount that keeps the zoom variant
 * off the wire, scroll lock) are asserted against the source, because those are
 * exactly the lines a later edit would quietly drop.
 */
import { readFileSync } from "node:fs";
import {
  DOUBLE_TAP_ZOOM,
  MIN_ZOOM,
  ZOOM_CEILING,
  ZOOM_FLOOR,
  FINE_POINTER_QUERY,
  LENS_MAX_DIAMETER,
  LENS_MAX_MAGNIFICATION,
  LENS_MIN_DIAMETER,
  LENS_MIN_MAGNIFICATION,
  ZOOM_REQUEST_WIDTH,
  clampPan,
  clampZoom,
  decideViewerGesture,
  doubleTapZoom,
  lensDiameterFor,
  lensGeometry,
  lensMagnificationFor,
  maxZoomFor,
  panBounds,
  pinchZoom,
  pointDistance,
  viewerSizes,
} from "../lib/imageZoom";

let pass = 0;
let fail = 0;
function check(name: string, condition: boolean, detail?: string) {
  console.log(`  ${condition ? "PASS" : "FAIL"}  ${name}`);
  if (condition) pass++;
  else {
    fail++;
    if (detail) console.log(`        ${detail}`);
  }
}
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

/** Source with comments removed — the file explains what it avoids, in prose. */
function codeOf(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const viewer = readFileSync("components/product/ImageViewer.tsx", "utf8");
const viewerCode = codeOf(viewer);
const gallery = readFileSync("components/product/ImageGallery.tsx", "utf8");
const css = readFileSync("app/globals.css", "utf8");

console.log("\n=== opening and closing ===");
check("the gallery mounts a viewer", gallery.includes("<ImageViewer"));
check("a tap on the photograph opens it", gallery.includes('if (decision.kind === "tap") setViewerOpen(true);'));
check("a click opens it, for pointer users", gallery.includes("const onFrameClick"));
check("a swipe does NOT open it", gallery.includes('suppressClick.current = decision.kind !== "tap";'));
check("the hover cue opens it without also firing the frame", gallery.includes("e.stopPropagation(); setViewerOpen(true);"));
check("closing is wired back to the gallery", gallery.includes("onClose={() => setViewerOpen(false)}"));
check("Escape closes", viewer.includes('e.key === "Escape"') && viewer.includes("onClose();"));
check("there is an accessible close label", viewer.includes('aria-label="Close closer look"'));

console.log("\n=== the selected image is preserved and synchronised ===");
check("the viewer is told which image is showing", gallery.includes("index={active}"));
check("and reports a change back to the gallery", gallery.includes("onIndexChange={setActive}"));
check("so the thumbnails follow it", gallery.includes("onClick={() => setActive(i)}"));
check("opening does not touch the index", !/setViewerOpen\(true\)[^;]*setActive/.test(gallery));

console.log("\n=== zoom clamps ===");
check("fitted is the floor", clampZoom(0.2, 3) === MIN_ZOOM);
check("a negative zoom cannot happen", clampZoom(-5, 3) === MIN_ZOOM);
check("NaN falls back to fitted", clampZoom(NaN, 3) === MIN_ZOOM);
check("the maximum is respected", clampZoom(99, 2.5) === 2.5);
check("a max below 1 cannot invert the range", clampZoom(2, 0.5) === MIN_ZOOM);
check("the design floor is 2x", ZOOM_FLOOR === 2);
check("the design ceiling is 3x", ZOOM_CEILING === 3);
check("no meaningless 8x is reachable", clampZoom(8, ZOOM_CEILING) === 3);

console.log("\n=== the ceiling follows the source, not a wish ===");
// A 1920 variant on a 1920 monitor at 1x: real detail to give.
check("a large source on a 1x screen earns more than the floor",
  near(maxZoomFor({ naturalWidth: 1920, displayedWidth: 700, dpr: 1 }), 2.74),
  String(maxZoomFor({ naturalWidth: 1920, displayedWidth: 700, dpr: 1 })));
check("but never beyond the 3x ceiling",
  maxZoomFor({ naturalWidth: 1920, displayedWidth: 300, dpr: 1 }) === ZOOM_CEILING);
// A ~1100px catalogue photograph on a retina laptop: already past 1:1.
check("a small source still offers the 2x floor",
  maxZoomFor({ naturalWidth: 1086, displayedWidth: 688, dpr: 2 }) === ZOOM_FLOOR);
check("a phone at dpr 3 with a large source gets the floor",
  maxZoomFor({ naturalWidth: 1920, displayedWidth: 390, dpr: 3 }) === ZOOM_FLOOR);
check("a missing natural width is safe", maxZoomFor({ naturalWidth: 0, displayedWidth: 500 }) === ZOOM_FLOOR);
check("a zero-width frame is safe", maxZoomFor({ naturalWidth: 1920, displayedWidth: 0 }) === ZOOM_FLOOR);

console.log("\n=== pan only when zoomed ===");
const fitted = panBounds({ zoom: 1, frameWidth: 400, frameHeight: 800 });
check("fitted, there is no slack at all", fitted.maxX === 0 && fitted.maxY === 0);
const pinned = clampPan({ x: 250, y: -400, zoom: 1, frameWidth: 400, frameHeight: 800 });
check("so a fitted image cannot be dragged anywhere", pinned.x === 0 && pinned.y === 0);
const zoomed = panBounds({ zoom: 2, frameWidth: 400, frameHeight: 800 });
check("at 2x the slack is half the overflow", zoomed.maxX === 200 && zoomed.maxY === 400);
const held = clampPan({ x: 9999, y: -9999, zoom: 2, frameWidth: 400, frameHeight: 800 });
check("and the image can never be flung off screen", held.x === 200 && held.y === -400);
check("a pan inside the bounds is left alone",
  clampPan({ x: 40, y: -30, zoom: 2, frameWidth: 400, frameHeight: 800 }).x === 40);
check("NaN offsets are neutralised",
  clampPan({ x: NaN, y: NaN, zoom: 2, frameWidth: 400, frameHeight: 800 }).x === 0);

console.log("\n=== a swipe changes the image only when fitted ===");
const swipeArgs = { startX: 300, startY: 400, endX: 100, endY: 400, index: 1, imageCount: 4 };
const atFit = decideViewerGesture({ zoom: 1, ...swipeArgs });
check("fitted, a horizontal drag navigates", atFit.kind === "navigate" && atFit.kind === "navigate" && atFit.nextIndex === 2);
const whileZoomed = decideViewerGesture({ zoom: 2, ...swipeArgs });
check("ZOOMED, the very same drag pans instead", whileZoomed.kind === "pan");
check("a hair above 1x already counts as zoomed",
  decideViewerGesture({ zoom: 1.02, ...swipeArgs }).kind === "pan");
check("floating-point 1.0 still counts as fitted",
  decideViewerGesture({ zoom: 1.000001, ...swipeArgs }).kind === "navigate");

console.log("\n=== boundaries, jitter and stray fingers ===");
check("no wrap forward",
  decideViewerGesture({ zoom: 1, ...swipeArgs, index: 3, imageCount: 4 }).kind === "navigate" &&
  (decideViewerGesture({ zoom: 1, ...swipeArgs, index: 3, imageCount: 4 }) as { nextIndex: number }).nextIndex === 3);
check("no wrap backward",
  (decideViewerGesture({ zoom: 1, startX: 100, startY: 400, endX: 300, endY: 400, index: 0, imageCount: 4 }) as { nextIndex: number }).nextIndex === 0);
check("a tap is reported as a tap",
  decideViewerGesture({ zoom: 1, startX: 200, startY: 300, endX: 204, endY: 302, index: 1, imageCount: 4 }).kind === "tap");
check("a vertical drag changes nothing",
  decideViewerGesture({ zoom: 1, startX: 200, startY: 300, endX: 206, endY: 460, index: 1, imageCount: 4 }).kind === "none");
check("a second finger never navigates",
  decideViewerGesture({ zoom: 1, ...swipeArgs, multiTouch: true }).kind === "none");
check("a cancelled pointer never navigates",
  decideViewerGesture({ zoom: 1, ...swipeArgs, cancelled: true }).kind === "none");
check("a single-image product cannot navigate",
  decideViewerGesture({ zoom: 1, ...swipeArgs, index: 0, imageCount: 1 }).kind === "none");

console.log("\n=== pinch ===");
check("spreading the fingers magnifies",
  near(pinchZoom({ startDistance: 100, currentDistance: 200, startZoom: 1, max: 3 }), 2));
check("closing them returns toward the fit",
  pinchZoom({ startDistance: 200, currentDistance: 50, startZoom: 2, max: 3 }) === MIN_ZOOM);
check("a pinch cannot exceed the computed maximum",
  pinchZoom({ startDistance: 100, currentDistance: 900, startZoom: 1, max: 2.5 }) === 2.5);
check("a pinch cannot shrink below the fit",
  pinchZoom({ startDistance: 100, currentDistance: 1, startZoom: 1, max: 3 }) === MIN_ZOOM);
check("a zero starting distance cannot divide by zero",
  pinchZoom({ startDistance: 0, currentDistance: 100, startZoom: 1.5, max: 3 }) === 1.5);
check("it is ratio-based, so a paused pinch does not drift",
  near(pinchZoom({ startDistance: 100, currentDistance: 150, startZoom: 2, max: 3 }), 3));
check("distance is euclidean", pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 }) === 5);

console.log("\n=== double tap toggles, it does not cycle ===");
check("fitted, it magnifies", doubleTapZoom(1, 3) === DOUBLE_TAP_ZOOM);
check("magnified, it returns to the fit", doubleTapZoom(2, 3) === MIN_ZOOM);
check("it never exceeds a low maximum", doubleTapZoom(1, 1.5) === 1.5);
check("it is a toggle, so twice is where you started", doubleTapZoom(doubleTapZoom(1, 3), 3) === MIN_ZOOM);

console.log("\n=== dialog semantics and focus ===");
check("it is a modal dialog", viewer.includes('role="dialog"') && viewer.includes('aria-modal="true"'));
check("it is labelled", viewer.includes("aria-label={`${alt} — closer look`}"));
check("focus moves into it on open", viewer.includes("closeRef.current?.focus()"));
check("the opener is captured", viewer.includes("const opener = document.activeElement"));
check("and focused again on close", viewer.includes("opener?.focus?.()"));
check("Tab is trapped", viewer.includes('e.key !== "Tab"') && viewer.includes("last.focus()") && viewer.includes("first.focus()"));
check("Shift+Tab is trapped too", viewer.includes("e.shiftKey"));
check("focus landing outside is pulled back", viewer.includes('document.addEventListener("focusin", onFocusIn)'));
check("focus FALLING TO BODY is caught too, which focusin cannot see", viewer.includes('document.addEventListener("focusout", restore)'));
check("both guards are cleaned up", viewer.includes('removeEventListener("focusin"') && viewer.includes('removeEventListener("focusout"'));
check("keyboard Left/Right change image", viewer.includes('e.key === "ArrowRight"') && viewer.includes('e.key === "ArrowLeft"'));
check("position is announced", viewer.includes('aria-live="polite"') && viewer.includes("Image {index + 1} of {images.length}"));
check("alt text is preserved", viewer.includes("alt={alt}"));
check("focus is visible on every control", (viewer.match(/focus-visible:ring/g) ?? []).length >= 3);

console.log("\n=== body scroll lock, and its cleanup ===");
check("the page is locked while open", viewer.includes('document.body.style.overflow = "hidden"'));
check("the previous value is remembered", viewer.includes("const previousOverflow = document.body.style.overflow"));
check("and restored, not blanked", viewer.includes("document.body.style.overflow = previousOverflow"));
check("lock and focus restore share one effect, so they cannot desync",
  viewer.indexOf("previousOverflow") < viewer.indexOf("opener?.focus?.()"));

console.log("\n=== no zoom-sized image is fetched until it is asked for ===");
check("the viewer is mounted conditionally", gallery.includes("{viewerOpen && ("));
check("so nothing of it renders while closed", !gallery.includes("<ImageViewer\n          images={images}\n          alt={alt}\n          index={active}\n          onIndexChange={setActive}\n          onClose={() => setViewerOpen(false)}\n        />\n      )}\n      <ImageViewer"));
check("the PDP frame keeps its own responsive sizes",
  gallery.includes('export const PDP_FRAME_SIZES = "(min-width: 1024px) 50vw, 100vw";'));
check("the viewer asks for a zoom-sized variant instead", viewer.includes("sizes={viewerSizes()}"));
// A px `sizes` also gives the detail layer a density of 1, which is what makes
// its naturalWidth a true pixel count — every zoom/lens ceiling reads that
// number, and a vw form would understate it by the device's density.
check("that request names one width, not a vw expression", viewerSizes() === "1920px");
check("it is a px value, so naturalWidth is not density-corrected", /^\d+px$/.test(viewerSizes()));
check("the zoom ceiling is measured off the detail layer, not the base",
  viewer.includes("naturalWidth: detail.naturalWidth"));
check("and it is the configured ceiling", ZOOM_REQUEST_WIDTH === 1920);

console.log("\n=== restraint: no marketplace furniture ===");
check("no zoom percentage label", !/\{Math\.round\(zoom \* 100\)\}/.test(viewer) && !viewer.includes("% zoom"));
check("no plus/minus zoom buttons", !viewer.includes("ZoomIn") && !viewer.includes("ZoomOut") && !viewer.includes("Minus"));
// The lens is now the DESKTOP INSTRUMENT and is required. What stays banned is
// the marketplace arrangement: a magnified panel parked beside the photograph.
check("no magnified panel beside the photograph", !/side-?panel|zoom-?panel|magnifier-?box/i.test(viewerCode));
check("no card frame or lift shadow", !viewer.includes("shadow-lift") && !viewer.includes("rounded-2xl bg-cream"));
check("it does not reuse the cream Modal", !viewer.includes('from "@/components/ui/Modal"'));
check("the gallery no longer uses the Modal lightbox", !gallery.includes("Modal"));
check("navigation is restrained and revealed, not permanent", viewer.includes("opacity-0") && viewer.includes("group-hover:opacity-100"));
check("the counter is quiet", viewer.includes("text-white/70") && viewer.includes("{index + 1} / {images.length}"));

console.log("\n=== reduced motion ===");
check("the preference is read", viewer.includes('"(prefers-reduced-motion: reduce)"'));
check("and removes the transition", viewer.includes('reduced && "transition-none"'));
check("a drag is never smoothed, or it lags the finger", viewer.includes("!dragging && !reduced &&"));

console.log("\n=== single-image and multi-image products ===");
check("nav and counter are conditional on more than one image", (viewer.match(/hasMany && \(/g) ?? []).length === 1);
check("hasMany is honest", viewer.includes("const hasMany = images.length > 1;"));
check("a single image still opens and still zooms", !viewer.includes("if (images.length < 2) return null"));

console.log("\n=== gestures do not fight the system ===");
// Regression: gating this on `zoomed` let the browser claim the touch at 1x and
// cancel the pointer stream — pinch never started and a swipe arrived cancelled.
check("a touchscreen stage owns its gestures at EVERY zoom level",
  viewer.includes('!finePointer && "touch-none"') && !viewer.includes('zoomed && "touch-none"'));
check("pointer capture keeps a drag attached", viewer.includes("setPointerCapture"));
check("pointercancel is handled", viewer.includes("onPointerCancel"));
check("a pinch never also navigates", viewer.includes("if (multi) return;"));
check("a stray single tap does not close the viewer", !/onClick=\{onClose\}[\s\S]{0,80}absolute inset-0/.test(viewer));
check("changing image resets the magnification", viewer.includes("reset();") && viewer.includes("onIndexChange(next)"));

console.log("\n=== it is a POPUP on the product page, not a full-screen image view ===");
check("the product page stays visible behind a restrained backdrop", viewer.includes("bg-ink/45 backdrop-blur-sm"));
check("no opaque ground filling the viewport", !viewer.includes('className="group fixed inset-0 z-[70] flex flex-col bg-ink"'));
check("the stage is a centred box, not the whole screen", viewer.includes('"fixed inset-0 z-[70] flex items-center justify-center"'));
check("the photograph no longer stretches to the viewport", !viewer.includes("relative flex-1"));
check("the stage keeps the PDP's own 3:4 crop", viewer.includes("aspect-[3/4]") && viewer.includes("object-cover"));
check("it uses the PDP's own linen backing, not a black gallery", viewer.includes("bg-linen") && !viewer.includes("bg-black"));
check("the stage is sized by the shared utility", viewer.includes("inspect-stage"));
check("which is defined once, in CSS", css.includes(".inspect-stage"));
check("the width satisfies BOTH axes, so 3:4 survives a tall phone",
  css.includes("width: min(calc(100vw - 1rem), calc((100dvh - 1rem) * 3 / 4))"));
check("desktop keeps deliberate margins", css.includes("calc(100vw - 8rem)") && css.includes("calc((100dvh - 6rem) * 3 / 4)"));
check("mobile takes nearly the whole width available", css.includes("calc(100vw - 1rem)"));
check("dvh, with a vh fallback declared first",
  css.indexOf("calc((100vh - 1rem) * 3 / 4)") < css.indexOf("calc((100dvh - 1rem) * 3 / 4)"));
check("safe areas are respected", viewer.includes("env(safe-area-inset-top)") && viewer.includes("env(safe-area-inset-bottom)"));
check("nothing navigates", !viewer.includes("router.push") && !viewer.includes("window.location") && !viewer.includes("<a "));

console.log("\n=== it opens immediately, on an image the browser already has ===");
check("the first layer uses the PDP frame's own sizes", viewer.includes("sizes={baseSizes}"));
check("which the gallery passes in, so they cannot drift", gallery.includes("baseSizes={PDP_FRAME_SIZES}"));
check("and the frame itself uses that same constant", gallery.includes("sizes={PDP_FRAME_SIZES}"));
check("the constant is exported once", gallery.includes('export const PDP_FRAME_SIZES = "(min-width: 1024px) 50vw, 100vw";'));
check("the base layer is eager", viewer.includes('key={`base-${src}`}') && viewer.includes("priority"));
check("no spinner takes over the photograph", !/spinner|animate-spin/i.test(viewerCode));
check("no blank state gates the opening", !viewer.includes("if (!detailReady) return null"));

console.log("\n=== the detail copy arrives quietly, afterwards ===");
check("a second layer requests the inspection variant", viewer.includes("sizes={viewerSizes()}"));
check("it is transparent until it has decoded", viewer.includes('detailReady ? "opacity-100" : "opacity-0"'));
check("and fades rather than swapping", viewer.includes("transition-opacity duration-300"));
check("it is decorative to a screen reader", viewer.includes('alt=""') && viewer.includes('aria-hidden="true"'));
check("readiness is tied to the CURRENT image", viewer.includes("const detailReady = detail?.src === src;"));
check("only the current image is rendered at all", !viewer.includes("images.map("));

console.log("\n=== the desktop lens ===");
check("capability is asked of the pointer, not the viewport", FINE_POINTER_QUERY === "(hover: hover) and (pointer: fine)");
check("and it is watched for change", viewer.includes('pointer?.addEventListener?.("change"'));
check("the listener is cleaned up", viewer.includes('pointer?.removeEventListener?.("change"'));
check("the lens only exists for a fine pointer", viewer.includes("if (!finePointer || !lens) return null;"));
check("and only tracks an actual mouse", viewer.includes('e.pointerType !== "mouse"'));
check("leaving the photograph removes it", viewer.includes("setLens(null); finish(e, true);"));
check("a fine pointer never starts a drag", viewer.includes('if (finePointer && e.pointerType === "mouse") return;'));
check("the base photograph never moves for a mouse", !viewer.includes("onWheel") && !viewer.includes("wheelZoom"));
check("no lens chrome beyond a hairline", viewer.includes("ring-1 ring-white/40") && !viewer.includes("shadow-lift"));
check("the lens says nothing to a screen reader", /lensView && detailReady && \(\s*<div\s*aria-hidden="true"/.test(viewer));

console.log("\n=== lens diameter is responsive and bounded ===");
check("a wide stage gets a considered circle", Math.abs(lensDiameterFor(600) - 204) < 0.001);
check("it never exceeds the maximum", lensDiameterFor(2000) === LENS_MAX_DIAMETER);
check("nor falls below the minimum", lensDiameterFor(200) === LENS_MIN_DIAMETER);
check("and never exceeds the stage itself", lensDiameterFor(80) === 80);
check("a zero stage is safe", lensDiameterFor(0) === LENS_MIN_DIAMETER);

console.log("\n=== lens magnification follows real detail ===");
check("a 1920 variant on a 600px stage at 1x earns real magnification",
  Math.abs(lensMagnificationFor({ naturalWidth: 1920, stageWidth: 600, dpr: 1 }) - 3) < 0.001);
check("a retina stage gets less, honestly",
  lensMagnificationFor({ naturalWidth: 1920, stageWidth: 600, dpr: 2 }) === LENS_MIN_MAGNIFICATION);
check("a ~1100px source cannot pretend", lensMagnificationFor({ naturalWidth: 1086, stageWidth: 600, dpr: 2 }) === LENS_MIN_MAGNIFICATION);
check("nothing exceeds the lens ceiling", lensMagnificationFor({ naturalWidth: 9999, stageWidth: 100, dpr: 1 }) === LENS_MAX_MAGNIFICATION);
check("the lens ceiling is not absurd", LENS_MAX_MAGNIFICATION <= 3);

console.log("\n=== magnified coordinates correspond to the pointer ===");
const STAGE = { stageWidth: 600, stageHeight: 800, naturalWidth: 1200, naturalHeight: 1600, magnification: 2, diameter: 200 };
const mid = lensGeometry({ pointerX: 300, pointerY: 400, ...STAGE });
check("the lens centres on the pointer", mid.centerX === 300 && mid.centerY === 400);
// The stage is 600x800 and the source 1200x1600 — same 3:4 ratio, so cover
// scales by 0.5 with no crop, and the magnified layer is 1200x1600 at 2x.
check("the background is the covered image, magnified", mid.backgroundWidth === 1200 && mid.backgroundHeight === 1600);
check("the point under the pointer lands at the lens centre",
  mid.backgroundX === 100 - 300 * 2 && mid.backgroundY === 100 - 400 * 2,
  `${mid.backgroundX},${mid.backgroundY}`);
// Moving the pointer right by 50 must move the magnified content left by 50*M.
const right = lensGeometry({ pointerX: 350, pointerY: 400, ...STAGE });
check("moving the pointer moves the view by exactly magnification x",
  mid.backgroundX - right.backgroundX === 100, String(mid.backgroundX - right.backgroundX));

console.log("\n=== the lens stays inside the photograph ===");
const inside = (g: { centerX: number; centerY: number; diameter: number }) =>
  g.centerX - g.diameter / 2 >= -0.001 &&
  g.centerY - g.diameter / 2 >= -0.001 &&
  g.centerX + g.diameter / 2 <= 600.001 &&
  g.centerY + g.diameter / 2 <= 800.001;
for (const [px, py, label] of [[0, 0, "top-left"], [600, 0, "top-right"], [0, 800, "bottom-left"], [600, 800, "bottom-right"], [-50, -50, "outside"], [9999, 9999, "far outside"]] as [number, number, string][]) {
  check(`${label} corner keeps the circle in bounds`, inside(lensGeometry({ pointerX: px, pointerY: py, ...STAGE })));
}
check("a lens wider than the stage is shrunk to fit",
  lensGeometry({ pointerX: 10, pointerY: 10, ...STAGE, diameter: 5000 }).diameter === 600);

console.log("\n=== the lens reproduces object-cover, so it cannot distort ===");
// A 4:5 source in a 3:4 stage: cover binds on width, and the crop is vertical.
const crop = lensGeometry({ pointerX: 300, pointerY: 400, stageWidth: 600, stageHeight: 800, naturalWidth: 1200, naturalHeight: 1500, magnification: 2, diameter: 200 });
check("the magnified layer keeps the source's aspect ratio",
  Math.abs(crop.backgroundWidth / crop.backgroundHeight - 1200 / 1500) < 0.0001);
// 1200x1500 into 600x800: height is the binding axis (800/1500 > 600/1200), so
// the covered image is 640x800 and the crop is taken from the SIDES.
check("the covered width exceeds the stage, as object-cover does",
  Math.abs(crop.backgroundWidth / 2 - 640) < 0.001, String(crop.backgroundWidth / 2));
check("and the covered height matches it exactly",
  Math.abs(crop.backgroundHeight / 2 - 800) < 0.001);
check("the side crop is taken evenly, shifting the view by half of it",
  Math.abs(crop.backgroundX - (100 - (300 + 20) * 2)) < 0.001, String(crop.backgroundX));
check("and the unbound axis is not shifted at all",
  Math.abs(crop.backgroundY - (100 - 400 * 2)) < 0.001, String(crop.backgroundY));
check("a degenerate source does not divide by zero",
  Number.isFinite(lensGeometry({ pointerX: 10, pointerY: 10, ...STAGE, naturalWidth: 0, naturalHeight: 0 }).backgroundX));

console.log("\n=== reopening starts fitted ===");
check("navigating resets zoom, pan and lens", viewer.includes("setZoom(MIN_ZOOM);") && viewer.includes("setOffset({ x: 0, y: 0 });") && viewer.includes("setLens(null);"));
check("zoom state is local to the mount, so a fresh open is fitted", viewer.includes("useState(MIN_ZOOM)"));
check("the gallery unmounts it on close", gallery.includes("{viewerOpen && ("));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
