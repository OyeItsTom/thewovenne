/**
 * The cart ownership rule — the one that stops one customer's cart reaching
 * another on a shared device. Exercised headlessly, because reproducing it in a
 * browser needs two customer accounts and the real leak is a state transition,
 * not a screen.
 *
 * The project has no test runner, so this is a plain script rather than a suite:
 *
 *   npx tsx scripts/cart-ownership.test.ts
 *
 * Exits non-zero on failure, so it can go into CI whenever there is one.
 */
import { decideCart } from "../lib/cartOwner";

const A = "user-aaa";
const B = "user-bbb";
let pass = 0, fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        expected ${JSON.stringify(expected)}`); console.log(`        actual   ${JSON.stringify(actual)}`); fail++; } else pass++;
}

console.log("\n=== the leak you reported: A logs out, B (or a guest) arrives ===");

const loggedOut = decideCart(A, null);
check("A signs out → cart emptied and disowned",
  { clear: loggedOut.clear, claim: loggedOut.claim }, { clear: true, claim: null });
check("A signs out → nothing may be uploaded",
  loggedOut.mayUpload, false);

const bArrives = decideCart(A, B);
check("B signs in on A's device → A's items cleared",
  bArrives.clear, true);
check("B signs in on A's device → cart becomes B's",
  bArrives.claim, B);
check("B signs in on A's device → B's own cart may be restored",
  bArrives.mayRestore, true);

console.log("\n=== the behaviours the log says are deliberate, still intact ===");

const guestSignsIn = decideCart(null, A);
check("guest cart carried into their own sign-in (not cleared)",
  guestSignsIn.clear, false);
check("guest cart becomes theirs",
  guestSignsIn.claim, A);

const sameUser = decideCart(A, A);
check("same customer returning → cart kept",
  sameUser.clear, false);
check("same customer returning → may restore if empty",
  sameUser.mayRestore, true);

console.log("\n=== a plain guest must keep their cart ===");
// Regression guard. This runs on every page load for a signed-out visitor, so
// clearing here would mean a guest could never hold a cart at all.
const guestOut = decideCart(null, null);
check("guest who was never signed in keeps their cart",
  guestOut.clear, false);
check("guest cart is never uploaded",
  guestOut.mayUpload, false);

console.log("\n=== full matrix (no case falls through) ===");
for (const [stored, session] of [[null, null], [null, A], [A, null], [A, A], [A, B]]) {
  const d = decideCart(stored, session);
  const label = `stored=${stored ?? "guest"} session=${session ?? "none"}`;
  console.log(`  ${label.padEnd(34)} clear=${String(d.clear).padEnd(5)} claim=${String(d.claim).padEnd(10)} — ${d.reason}`);
  if (typeof d.clear !== "boolean" || d.mayRestore === undefined) { console.log("    FAIL: incomplete decision"); fail++; }
}

// The one invariant that matters: a cart is NEVER kept across two different
// identities. Every path either clears it or is the same person / a guest
// adopting their own.
console.log("\n=== invariant: items never survive an identity change ===");
for (const [stored, session] of [[A, B], [A, null], [null, null]]) {
  const d = decideCart(stored, session);
  const identityChanged = stored !== session;
  const safe = !identityChanged || d.clear || stored === null;
  check(`stored=${stored ?? "guest"} → session=${session ?? "none"} is safe`, safe, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
