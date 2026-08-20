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
  clampPan,
  clampZoom,
  containedWidth,
  decideViewerGesture,
  doubleTapZoom,
  maxZoomFor,
  panBounds,
  pinchZoom,
  pointDistance,
  ZOOM_REQUEST_WIDTH,
  viewerSizes,
  wheelZoom,
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

const viewer = readFileSync("components/product/ImageViewer.tsx", "utf8");
const gallery = readFileSync("components/product/ImageGallery.tsx", "utf8");

console.log("\n=== opening and closing ===");
check("the gallery mounts a viewer", gallery.includes("<ImageViewer"));
check("a tap on the photograph opens it", gallery.includes('if (decision.kind === "tap") setViewerOpen(true);'));
check("a click opens it, for pointer users", gallery.includes("const onFrameClick"));
check("a swipe does NOT open it", gallery.includes('suppressClick.current = decision.kind !== "tap";'));
check("the hover cue opens it without also firing the frame", gallery.includes("e.stopPropagation(); setViewerOpen(true);"));
check("closing is wired back to the gallery", gallery.includes("onClose={() => setViewerOpen(false)}"));
check("Escape closes", viewer.includes('e.key === "Escape"') && viewer.includes("onClose();"));
check("there is an accessible close label", viewer.includes('aria-label="Close image viewer"'));

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

console.log("\n=== the drawn size accounts for letterboxing ===");
// 3:4 portrait in a 1440x800 landscape frame is limited by height.
check("a portrait photo in a landscape frame is height-limited",
  containedWidth({ naturalWidth: 1200, naturalHeight: 1600, frameWidth: 1440, frameHeight: 800 }) === 600);
check("a photo narrower than the frame is not stretched",
  containedWidth({ naturalWidth: 1200, naturalHeight: 1600, frameWidth: 300, frameHeight: 800 }) === 300);
check("degenerate input falls back to the frame",
  containedWidth({ naturalWidth: 0, naturalHeight: 0, frameWidth: 500, frameHeight: 500 }) === 500);

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

console.log("\n=== wheel and trackpad ===");
check("scrolling up magnifies", wheelZoom({ zoom: 1, deltaY: -100, max: 3 }) > 1);
check("scrolling down reduces", wheelZoom({ zoom: 2, deltaY: 100, max: 3 }) < 2);
check("the wheel obeys the same ceiling", wheelZoom({ zoom: 2.9, deltaY: -5000, max: 3 }) === 3);
check("the wheel obeys the same floor", wheelZoom({ zoom: 1.1, deltaY: 5000, max: 3 }) === MIN_ZOOM);

console.log("\n=== double tap toggles, it does not cycle ===");
check("fitted, it magnifies", doubleTapZoom(1, 3) === DOUBLE_TAP_ZOOM);
check("magnified, it returns to the fit", doubleTapZoom(2, 3) === MIN_ZOOM);
check("it never exceeds a low maximum", doubleTapZoom(1, 1.5) === 1.5);
check("it is a toggle, so twice is where you started", doubleTapZoom(doubleTapZoom(1, 3), 3) === MIN_ZOOM);

console.log("\n=== dialog semantics and focus ===");
check("it is a modal dialog", viewer.includes('role="dialog"') && viewer.includes('aria-modal="true"'));
check("it is labelled", viewer.includes("aria-label={`${alt} — full screen`}"));
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
  gallery.includes('sizes="(min-width: 1024px) 50vw, 100vw"'));
check("the viewer asks for a zoom-sized variant instead", viewer.includes("sizes={viewerSizes()}"));
check("that request names one width, not a vw expression", viewerSizes() === "1920px");
check("and it is the configured ceiling", ZOOM_REQUEST_WIDTH === 1920);

console.log("\n=== restraint: no marketplace furniture ===");
check("no zoom percentage label", !/\{Math\.round\(zoom \* 100\)\}/.test(viewer) && !viewer.includes("% zoom"));
check("no plus/minus zoom buttons", !viewer.includes("ZoomIn") && !viewer.includes("ZoomOut") && !viewer.includes("Minus"));
check("no magnifier overlay lens", !viewer.includes("lens") && !viewer.includes("magnifier"));
check("no card frame or lift shadow", !viewer.includes("shadow-lift") && !viewer.includes("rounded-2xl bg-cream"));
check("it does not reuse the cream Modal", !viewer.includes('from "@/components/ui/Modal"'));
check("the gallery no longer uses the Modal lightbox", !gallery.includes("Modal"));
check("navigation is restrained and revealed, not permanent", viewer.includes("opacity-0") && viewer.includes("md:group-hover:opacity-100"));
check("the counter is quiet", viewer.includes("text-white/55") && viewer.includes("{index + 1} / {images.length}"));

console.log("\n=== reduced motion ===");
check("the preference is read", viewer.includes('"(prefers-reduced-motion: reduce)"'));
check("and removes the transition", viewer.includes('reduced && "transition-none"'));
check("a drag is never smoothed, or it lags the finger", viewer.includes("!dragging && !reduced &&"));

console.log("\n=== single-image and multi-image products ===");
check("nav and counter are conditional on more than one image", (viewer.match(/hasMany && \(/g) ?? []).length === 2);
check("hasMany is honest", viewer.includes("const hasMany = images.length > 1;"));
check("a single image still opens and still zooms", !viewer.includes("if (images.length < 2) return null"));

console.log("\n=== gestures do not fight the system ===");
check("the frame owns its touches while open", viewer.includes("touch-none"));
check("pointer capture keeps a drag attached", viewer.includes("setPointerCapture"));
check("pointercancel is handled", viewer.includes("onPointerCancel"));
check("a pinch never also navigates", viewer.includes("if (multi) return;"));
check("a stray single tap does not close the viewer", !/onClick=\{onClose\}[\s\S]{0,80}absolute inset-0/.test(viewer));
check("changing image resets the magnification", viewer.includes("reset();") && viewer.includes("onIndexChange(next)"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
