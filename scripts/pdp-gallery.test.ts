/**
 * The product-page gallery: swipe on a phone, restrained controls on a pointer.
 *
 * The gesture ARITHMETIC is exercised for real through decideCardGesture, which
 * is the same decision the product cards make and is what the gallery now calls.
 * The presentation half is a source contract — the arrows returning to the
 * photograph on mobile is exactly the regression this is here to catch.
 */
import { readFileSync } from "node:fs";
import { cardImageOffset, decideCardGesture } from "../lib/cardSwipe";

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

const g = readFileSync("components/product/ImageGallery.tsx", "utf8");

console.log("\n=== no arrows on a phone ===");
check("the arrows are hidden by default", g.includes("hidden h-9 w-9"), "expected `hidden` in the arrow class");
check("and only appear from md up", g.includes("md:flex"));
check("they are revealed by hover or focus, not by touch", g.includes("md:group-hover:opacity-100") && g.includes("md:group-focus-within:opacity-100"));
check("the cream discs are gone", !/h-11 w-11/.test(g) && !g.includes("bg-cream/85 text-ink shadow-soft"));
check("one arrow class, so the pair cannot drift", (g.match(/const arrowClass/g) ?? []).length === 1);

console.log("\n=== a swipe moves one image, in the direction asked ===");
check("the gallery reads the shared gesture decision", g.includes("decideCardGesture"));
check("and the shared direction model", g.includes("cardImageOffset"));
check("images translate rather than cross-fade", g.includes("-translate-x-full") && g.includes("translate-x-full") && g.includes("translate-x-0"));
check("the opacity cross-fade is gone", !g.includes("opacity-100\" : \"opacity-0"));

const swipe = (dx: number, index: number, imageCount = 4) =>
  decideCardGesture({ startX: 200, startY: 300, endX: 200 + dx, endY: 300, index, imageCount });

check("a leftward swipe advances by exactly one", swipe(-80, 1).nextIndex === 2);
check("a rightward swipe goes back by exactly one", swipe(80, 1).nextIndex === 0);
check("a long swipe still moves only one", swipe(-400, 1).nextIndex === 2);

console.log("\n=== no wrap at the boundaries ===");
check("the component clamps instead of taking a modulo", g.includes("Math.max(0, Math.min(images.length - 1"), "found a modulo?");
check("no modulo survives in the gallery", !g.includes("% images.length"));
check("swiping back from the first image stays put", swipe(80, 0).nextIndex === 0);
check("swiping on from the last image stays put", swipe(-80, 3).nextIndex === 3);
check("the arrows are disabled at the ends", g.includes("disabled={atStart}") && g.includes("disabled={atEnd}"));

console.log("\n=== the gesture behaves like a hand, not a tripwire ===");
check("a 6px jitter is a tap, not a navigation", swipe(6, 1).kind === "tap" && swipe(6, 1).nextIndex === 1);
const vertical = decideCardGesture({ startX: 200, startY: 300, endX: 208, endY: 460, index: 1, imageCount: 4 });
check("a vertical drag is a scroll, and moves nothing", vertical.kind === "scroll" && vertical.nextIndex === 1);
const diagonalX = decideCardGesture({ startX: 200, startY: 300, endX: 100, endY: 340, index: 1, imageCount: 4 });
check("a mostly-horizontal diagonal follows X", diagonalX.kind === "swipe" && diagonalX.nextIndex === 2);
const diagonalY = decideCardGesture({ startX: 200, startY: 300, endX: 160, endY: 420, index: 1, imageCount: 4 });
check("a mostly-vertical diagonal follows Y", diagonalY.kind === "scroll" && diagonalY.nextIndex === 1);
const cancelled = decideCardGesture({ startX: 200, startY: 300, endX: 60, endY: 300, index: 1, imageCount: 4, cancelled: true });
check("a cancelled pointer changes nothing", cancelled.kind === "cancelled" && cancelled.nextIndex === 1);
const multi = decideCardGesture({ startX: 200, startY: 300, endX: 60, endY: 300, index: 1, imageCount: 4, multiTouch: true });
check("a second finger is ignored", multi.kind === "ignored" && multi.nextIndex === 1);
check("a single-image gallery ignores gestures", swipe(-120, 0, 1).kind === "ignored");

console.log("\n=== the page still scrolls, and pointers are handled honestly ===");
check("vertical scrolling is handed to the page", g.includes("touch-pan-y"));
check("a mouse never starts a gesture", g.includes('event.pointerType === "mouse"'));
check("pointercancel is wired", g.includes("onPointerCancel"));
check("leaving the frame ends the gesture safely", g.includes("finishGesture(e, true)"));
check("multi-touch is detected in the component too", g.includes("multiTouch = true"));

console.log("\n=== nothing that worked before was taken away ===");
check("the thumbnail strip survives", g.includes("View image ${i + 1} of ${images.length}"));
check("thumbnails still drive the main frame", g.includes("onClick={() => setActive(i)}"));
check("thumbnails still report the current one", g.includes("aria-current={active === i}"));
check("arrow keys still work", g.includes('e.key === "ArrowRight"') && g.includes('e.key === "ArrowLeft"'));
check("the frame is still reachable by keyboard", g.includes("tabIndex={0}"));
check("a change is still announced", g.includes('aria-live="polite"'));
check("the counter survives", g.includes("{active + 1} / {images.length}"));
check("the lightbox survives", g.includes("setLightboxOpen(true)"));
check("reduced motion is honoured", g.includes("motion-reduce:transition-none"));

console.log("\n=== no blank frame mid-swipe ===");
check("the cover is still the LCP priority image", g.includes("priority={i === 0}"));
check("neighbours are fetched before they are needed", g.includes('Math.abs(i - active) <= 1 ? "eager" : "lazy"'));

console.log("\n=== the direction model itself ===");
check("an earlier image sits to the left", cardImageOffset(0, 2) === -1);
check("a later image sits to the right", cardImageOffset(3, 2) === 1);
check("the active image sits in frame", cardImageOffset(2, 2) === 0);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
