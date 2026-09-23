/**
 * What delivery costs, and who decides it.
 *
 *   npx tsx scripts/shipping-policy.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHAT THIS IS REALLY GUARDING. A shipping page and a till that disagree is
 * worse than having neither, because the customer believes the page and finds
 * out at the moment they are asked to pay. The shop ran for months on ₹120 with
 * Kerala delivered free — a rule that existed only in lib/shipping and in the
 * charge, and that no page ever stated. These assertions pin the published
 * policy to the one function every surface quotes from.
 *
 *   below ₹3,000   ₹99 within Kerala, ₹129 elsewhere in India
 *   ₹3,000 and up  free, anywhere in India
 */
import { DEFAULT_SHIPPING, quoteShipping, type ShippingConfig } from "../lib/shipping";
import fs from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note && ok ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}
function ok(name: string, condition: boolean, note?: string) {
  check(name, condition, true, note);
}

const inIndia = (pin: string) => ({ postal_code: pin, country: "IN" });
const quote = (pin: string, total: number, cfg: ShippingConfig = DEFAULT_SHIPPING) =>
  quoteShipping(inIndia(pin), total, cfg);

console.log("\n=== THE CONFIGURED POLICY ===");

check("rest of India is ₹129", DEFAULT_SHIPPING.flat_rate_inr, 129);
check("free above ₹3,000", DEFAULT_SHIPPING.free_above_inr, 3000);
const kerala = DEFAULT_SHIPPING.regional_rates.find((r) => r.name === "Kerala");
check("Kerala is a PAID region at ₹99", kerala?.rate_inr, 99,
  "not a free region wearing a new label");
check("matched on 67, 68, 69", kerala?.prefixes, ["67", "68", "69"]);
check("and it is the only region configured", DEFAULT_SHIPPING.regional_rates.length, 1);

console.log("\n=== KERALA, BELOW THE THRESHOLD ===");
for (const pin of ["670001", "680001", "690001"]) {
  check(`${pin} → ₹99`, quote(pin, 2999).cost, 99);
}
check("Kochi 682001 → ₹99", quote("682001", 500).cost, 99, "682 sits inside the 68 prefix");
check("the reason names the region", quote("670001", 500).reason, "Delivery to Kerala");
ok("and it is not reported as free", !quote("670001", 500).free);

console.log("\n=== THE REST OF INDIA, BELOW THE THRESHOLD ===");
for (const [place, pin] of [
  ["Haryana", "122001"],
  ["Delhi", "110001"],
  ["Bengaluru", "560001"],
  ["Mumbai", "400001"],
  ["Chennai", "600001"],
] as const) {
  check(`${place} ${pin} → ₹129`, quote(pin, 2999).cost, 129);
}
check("and it reads as standard delivery", quote("110001", 500).reason, "Standard delivery");

console.log("\n=== THE THRESHOLD ===");
check("₹2,999.99 in Kerala is still paid", quote("670001", 2999.99).cost, 99);
check("₹2,999.99 elsewhere is still paid", quote("110001", 2999.99).cost, 129);
check("₹3,000.00 exactly is free in Kerala", quote("670001", 3000).free, true);
check("₹3,000.00 exactly is free elsewhere", quote("110001", 3000).free, true);
check("₹3,000.00 costs nothing", quote("110001", 3000).cost, 0);
check("above the threshold is free", quote("682001", 5000).cost, 0);
ok("the threshold beats the region, not the other way round",
  quote("670001", 3000).free && quote("670001", 2999).cost === 99);

console.log("\n=== AN UNKNOWN DESTINATION IS NEVER GIVEN THE CHEAPER RATE ===");
check("a missing PIN pays the standard rate", quote("", 500).cost, 129);
check("and says so", quote("", 500).reason, "Standard delivery — enter a PIN code");
check("a malformed PIN pays the standard rate", quote("abc", 500).cost, 129);
check("a single digit is not matched loosely", quote("6", 500).cost, 129);
check("punctuation is tolerated, not exploited", quote("670 001", 500).cost, 99,
  "people type spaces and dashes");
ok("no quote below the threshold is ever free",
  [["", 500], ["abc", 500], ["6", 500], ["110001", 2999], ["670001", 2999]].every(
    ([pin, v]) => !quote(String(pin), Number(v)).free
  ),
  "under-charging is a loss on every order; over-quoting corrects itself");

console.log("\n=== THE OLD RULES CANNOT COME BACK ===");
ok("no free_pin_prefixes field exists", !("free_pin_prefixes" in DEFAULT_SHIPPING));
check("no ₹120 rate survives", DEFAULT_SHIPPING.flat_rate_inr === 120, false);
ok("no region is free below the threshold",
  DEFAULT_SHIPPING.regional_rates.every((r) => r.rate_inr > 0));

// The dangerous stored-config case, exercised rather than assumed. A site_content
// row saved before this policy still carries free_pin_prefixes; nothing reads the
// key now, so the value is data rather than a rule.
const stale = { ...DEFAULT_SHIPPING, free_pin_prefixes: ["67", "68", "69"] } as never;
check("a stale free_pin_prefixes cannot make Kerala free", quote("670001", 2999, stale).cost, 99);
check("nor anywhere else", quote("110001", 2999, stale).cost, 129);
ok("and it is still not reported as free", !quote("670001", 2999, stale).free);

// The other half of the stale-row problem, which a code default CANNOT fix.
const staleRate: ShippingConfig = { ...DEFAULT_SHIPPING, flat_rate_inr: 120 };
check("a stale flat_rate_inr DOES still win — Admin must be set", quote("110001", 500, staleRate).cost, 120,
  "the stored row overrides the default; this is why the checklist matters");

console.log("\n=== LONGEST PREFIX WINS ===");
const layered: ShippingConfig = {
  ...DEFAULT_SHIPPING,
  regional_rates: [
    { name: "Kerala", prefixes: ["67", "68", "69"], rate_inr: 99 },
    { name: "Kochi city", prefixes: ["682"], rate_inr: 49 },
  ],
};
check("682 beats 68", quote("682001", 500, layered).cost, 49);
check("680 falls to the broader region", quote("680001", 500, layered).cost, 99);
check("an unmatched PIN still pays standard", quote("110001", 500, layered).cost, 129);
check("the escape hatch works: a costlier sub-region can be carved out",
  quote("682551", 500, {
    ...DEFAULT_SHIPPING,
    regional_rates: [
      { name: "Kerala", prefixes: ["67", "68", "69"], rate_inr: 99 },
      { name: "Lakshadweep", prefixes: ["6825"], rate_inr: 129 },
    ],
  }).cost,
  129,
  "documented route out of the Lakshadweep overlap, if it ever matters");

console.log("\n=== ONE QUOTE, EVERY SURFACE ===");

const read = (p: string) => fs.readFileSync(p, "utf8");
ok("the checkout route quotes from quoteShipping",
  read("app/api/checkout/razorpay/route.ts").includes("quoteShipping(details.address, total, shippingConfig)"));
ok("the delivery endpoint resolves through the same module",
  read("app/api/delivery/check/route.ts").includes("getDeliveryQuote"));
ok("and getDeliveryQuote delegates the money to quoteShipping, not a second opinion",
  read("lib/delivery.ts").includes("quoteShipping("));
ok("the checkout form shows the same function's answer",
  read("components/cart/CheckoutForm.tsx").includes("quoteShipping(form.address, subtotal, shippingConfig)"));
ok("nothing computes a shipping cost by hand",
  !read("components/cart/CheckoutForm.tsx").includes("flat_rate_inr") &&
  !read("app/api/checkout/razorpay/route.ts").includes("flat_rate_inr"));

console.log("\n=== PRICING REGIONS AND DELIVERY-TIME ZONES STAY SEPARATE ===");
ok("the shipping config holds no day ranges",
  !JSON.stringify(DEFAULT_SHIPPING).includes("days"));
ok("the delivery config still promises no time by default",
  read("lib/delivery.ts").includes("default_min_days: 0") &&
  read("lib/delivery.ts").includes("default_max_days: 0"),
  "a day range is a business commitment, set in Admin — not a code default");
ok("the admin editor no longer offers a free-prefix field",
  !read("components/admin/DeliverySettingsEditor.tsx").includes("Free-delivery pincode prefixes"));
ok("and does offer a regional charge editor",
  read("components/admin/DeliverySettingsEditor.tsx").includes("Regional delivery charges") &&
  read("components/admin/DeliverySettingsEditor.tsx").includes("Delivery charge here, ₹"));
ok("the delivery-time zone editor is retained",
  read("components/admin/DeliverySettingsEditor.tsx").includes("Zone name (for you, not customers)"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
