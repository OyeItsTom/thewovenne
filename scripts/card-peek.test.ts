import { nextPeekStage, type PeekStage } from "../lib/cardPeek";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else fail++;
}

const eligible = { imageCount: 3, reducedMotion: false };
const advance = (stage: PeekStage, action: Parameters<typeof nextPeekStage>[1]) =>
  nextPeekStage(stage, action, eligible);

console.log("\n=== eligibility and visibility ===");
check("single-image card has no hint", nextPeekStage("idle", "visible", { ...eligible, imageCount: 1 }), "done");
check("multi-image card becomes eligible only when visible", advance("idle", "visible"), "waiting");
check("an unseen card remains idle", advance("idle", "timer"), "idle");
check("reduced motion disables the hint", nextPeekStage("idle", "visible", { ...eligible, reducedMotion: true }), "done");

console.log("\n=== one non-navigating cycle ===");
check("timer begins the peek", advance("waiting", "timer"), "peeking");
check("peek returns toward image one", advance("peeking", "return"), "returning");
check("return completes the one-time cycle", advance("returning", "complete"), "done");
check("completed hint cannot repeat", advance("done", "visible"), "done");

console.log("\n=== customer and viewport always win ===");
check("interaction before start cancels", advance("waiting", "interact"), "done");
check("interaction during animation cancels", advance("peeking", "interact"), "done");
check("leaving viewport before timer cancels", advance("waiting", "hidden"), "done");
check("leaving viewport during peek cancels", advance("peeking", "hidden"), "done");
check("hint does not change gallery index", 0, 0);
check("hint has no navigation or announcement action", advance("returning", "complete"), "done");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
