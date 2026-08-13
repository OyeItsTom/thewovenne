/** Product-card tap/swipe boundary, exercised without a browser. */
import { cardImageOffset, decideCardGesture, type SwipeInput } from "../lib/cardSwipe";

let pass = 0;
let fail = 0;
function check(name: string, input: Partial<SwipeInput>, expected: unknown) {
  const actual = decideCardGesture({
    startX: 100, startY: 100, endX: 100, endY: 100,
    index: 1, imageCount: 3, ...input,
  });
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

const at1 = (kind: string, suppressClick: boolean, nextIndex = 1) =>
  ({ kind, nextIndex, suppressClick });

console.log("\n=== tap versus page movement ===");
check("tap permits PDP click", {}, at1("tap", false));
check("small finger jitter remains a tap", { endX: 106, endY: 108 }, at1("tap", false));
check("vertical scroll remains page movement", { endX: 108, endY: 170 }, at1("scroll", false));
check("diagonal movement where vertical wins", { endX: 130, endY: 165 }, at1("scroll", false));
check("ambiguous movement suppresses an accidental PDP click", { endX: 124, endY: 118 }, at1("ignored", true));

console.log("\n=== committed horizontal movement ===");
check("swipe left advances exactly one", { endX: 45, endY: 105 }, at1("swipe", true, 2));
check("swipe right goes back exactly one", { endX: 155, endY: 96 }, at1("swipe", true, 0));
check("diagonal movement where horizontal wins", { endX: 40, endY: 125 }, at1("swipe", true, 2));
check("swipe suppresses PDP click", { endX: 30 }, at1("swipe", true, 2));

console.log("\n=== boundaries and refusals ===");
check("first image does not wrap", { index: 0, endX: 160 }, { kind: "swipe", nextIndex: 0, suppressClick: true });
check("last image does not wrap", { index: 2, endX: 40 }, { kind: "swipe", nextIndex: 2, suppressClick: true });
check("single-image product ignores swipe", { index: 0, imageCount: 1, endX: 40 }, { kind: "ignored", nextIndex: 0, suppressClick: false });
check("multi-touch is ignored", { multiTouch: true, endX: 40 }, at1("ignored", false));
check("pointer cancellation clears without navigation", { cancelled: true, endX: 40 }, at1("cancelled", false));

console.log("\n=== symmetric visual direction ===");
const visualChecks = [
  ["left swipe: old image exits left", cardImageOffset(0, 1), -1],
  ["left swipe: next image settles in frame", cardImageOffset(1, 1), 0],
  ["right swipe: old image exits right", cardImageOffset(1, 0), 1],
  ["right swipe: previous image settles in frame", cardImageOffset(0, 0), 0],
] as const;
for (const [name, actual, expected] of visualChecks) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
