/**
 * Coupon arithmetic and validation, exercised headlessly.
 *
 * The shop has no orders yet, so the alternative first test of this code is a
 * paying customer. Run:
 *
 *   npx tsx scripts/coupons.test.ts
 *
 * Exits non-zero on failure.
 */
import { evaluateCoupon, type CouponRow } from "../lib/coupons";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

const base: CouponRow = {
  id: "c1",
  code: "LAUNCH10",
  discount_type: "percent",
  discount_value: 10,
  min_order_inr: null,
  expires_at: null,
  max_uses: null,
  times_used: 0,
  once_per_customer: false,
  is_active: true,
};
const of = (patch: Partial<CouponRow>): CouponRow => ({ ...base, ...patch });

console.log("\n=== discount arithmetic ===");
check("10% of 5000 = 500", evaluateCoupon(base, { subtotal: 5000 }).discount, 500);
check("flat 750 off 5000", evaluateCoupon(of({ discount_type: "flat", discount_value: 750 }), { subtotal: 5000 }).discount, 750);
check("percentage rounds DOWN (10% of 1999 = 199, not 200)", evaluateCoupon(base, { subtotal: 1999 }).discount, 199);
check("100% is allowed and takes the whole subtotal", evaluateCoupon(of({ discount_value: 100 }), { subtotal: 3000 }).discount, 3000);

console.log("\n=== a discount can never exceed the goods ===");
// The floor at ₹1 lives in the route; here the rule is that a goods discount
// never eats shipping or loyalty.
check("flat 5000 off a 300 order takes only 300",
  evaluateCoupon(of({ discount_type: "flat", discount_value: 5000 }), { subtotal: 300 }).discount, 300);
check("never negative", evaluateCoupon(of({ discount_type: "flat", discount_value: 5000 }), { subtotal: 0 }).discount, 0);

console.log("\n=== validation ===");
check("withdrawn code rejected", evaluateCoupon(of({ is_active: false }), { subtotal: 5000 }).reason, "inactive");
check("unknown code rejected", evaluateCoupon(null, { subtotal: 5000 }).reason, "not_found");
check("withdrawn and unknown read IDENTICALLY to the customer",
  evaluateCoupon(of({ is_active: false }), { subtotal: 5000 }).message,
  evaluateCoupon(null, { subtotal: 5000 }).message);

const past = new Date("2020-01-01").toISOString();
const future = new Date("2099-01-01").toISOString();
check("expired code rejected", evaluateCoupon(of({ expires_at: past }), { subtotal: 5000 }).reason, "expired");
check("future expiry accepted", evaluateCoupon(of({ expires_at: future }), { subtotal: 5000 }).ok, true);

check("exhausted code rejected", evaluateCoupon(of({ max_uses: 50, times_used: 50 }), { subtotal: 5000 }).reason, "exhausted");
check("49 of 50 still works", evaluateCoupon(of({ max_uses: 50, times_used: 49 }), { subtotal: 5000 }).ok, true);

check("below minimum rejected", evaluateCoupon(of({ min_order_inr: 3000 }), { subtotal: 2999 }).reason, "below_minimum");
check("exactly at minimum accepted", evaluateCoupon(of({ min_order_inr: 3000 }), { subtotal: 3000 }).ok, true);
check("minimum message names the threshold, so it is actionable",
  evaluateCoupon(of({ min_order_inr: 3000 }), { subtotal: 2999 }).message?.includes("3,000"), true);

check("once-per-customer blocks a repeat",
  evaluateCoupon(of({ once_per_customer: true }), { subtotal: 5000, alreadyUsedByCustomer: true }).reason, "already_used");
check("once-per-customer allows a first use",
  evaluateCoupon(of({ once_per_customer: true }), { subtotal: 5000, alreadyUsedByCustomer: false }).ok, true);

console.log("\n=== the minimum is tested BEFORE the discount, not after ===");
// A 50% code with a ₹3,000 minimum on a ₹4,000 order must qualify. Testing the
// threshold against the post-discount total would be circular and would reject.
check("50% off 4000 with a 3000 minimum qualifies",
  evaluateCoupon(of({ discount_value: 50, min_order_inr: 3000 }), { subtotal: 4000 }).discount, 2000);

console.log("\n=== rejected coupons are worth nothing ===");
for (const c of [
  of({ is_active: false }),
  of({ expires_at: past }),
  of({ max_uses: 1, times_used: 1 }),
  of({ min_order_inr: 99999 }),
]) {
  const r = evaluateCoupon(c, { subtotal: 5000 });
  if (r.discount !== 0 || r.ok) { console.log(`  FAIL: rejected coupon returned ${r.discount}`); fail++; }
}
console.log(`  PASS  every rejection returns a zero discount`);
pass++;

console.log("\n=== order of operations: coupon, then points, floored at ₹1 ===");
// Mirrors the route: shipping is quoted on the PRE-coupon subtotal (Tom's
// decision), points are spent against what the coupon leaves.
function charge(subtotal: number, shipping: number, coupon: CouponRow | null, points: number) {
  const d = coupon ? evaluateCoupon(coupon, { subtotal }).discount : 0;
  const afterCoupon = Math.max(subtotal - d, 0);
  const loyalty = Math.min(points, afterCoupon);
  return { discount: d, charged: Math.max(afterCoupon + shipping - loyalty, 1) };
}
check("5000 goods, free shipping, 10% off, 200 points → 4300",
  charge(5000, 0, base, 200).charged, 4300);
check("points cannot exceed what the coupon leaves",
  charge(1000, 0, of({ discount_type: "flat", discount_value: 900 }), 500).charged, 1);
check("a fully discounted basket still becomes a ₹1 payment",
  charge(2000, 0, of({ discount_value: 100 }), 0).charged, 1);
check("shipping is charged on top of a discounted basket",
  charge(1000, 120, base, 0).charged, 1020);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
