/**
 * The delivery estimator's rules.
 *
 * These matter more than most tests here because the estimator makes a promise
 * on a product page that the checkout then has to honour. The single thing this
 * suite is really guarding is that it CANNOT DISAGREE WITH CHECKOUT: the cost
 * side is not computed here at all, it is delegated to quoteShipping, and the
 * assertions below check the delegation rather than re-deriving the arithmetic.
 *
 *   npx tsx scripts/delivery-estimator.test.ts
 *
 * Exits non-zero on failure.
 */
import {
  resolveDelivery,
  isValidPostalFormat,
  normalisePostal,
  postalLabel,
  postalIsNumeric,
  DEFAULT_DELIVERY,
  type DeliveryConfig,
} from "../lib/delivery";
import { DEFAULT_SHIPPING, quoteShipping, type ShippingConfig } from "../lib/shipping";

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

const shipping: ShippingConfig = { ...DEFAULT_SHIPPING };

const delivery: DeliveryConfig = {
  ...DEFAULT_DELIVERY,
  default_min_days: 4,
  default_max_days: 7,
  zones: [
    { name: "Kerala", prefixes: ["67", "68", "69"], min_days: 2, max_days: 3 },
    { name: "Ernakulam city", prefixes: ["682"], min_days: 1, max_days: 2 },
  ],
  unserviceable_prefixes: ["19"],
};

const ask = (postalCode: string, orderValueInr: number, cfg = delivery) =>
  resolveDelivery({ market: "in", postalCode, orderValueInr, delivery: cfg, shipping });

console.log("\n=== postal format is not serviceability ===");

check("a well-formed pincode passes format", isValidPostalFormat("in", "682001"), true);
check("spaces and dashes are tolerated", isValidPostalFormat("in", "682 001"), true);
check("five digits is not a pincode", isValidPostalFormat("in", "68200"), false);
check("seven digits is not a pincode", isValidPostalFormat("in", "6820012"), false);
check("a pincode cannot start with 0", isValidPostalFormat("in", "082001"), false);
check("letters are not a pincode", isValidPostalFormat("in", "SW1A1AA"), false);
check("empty is not a pincode", isValidPostalFormat("in", ""), false);
check(
  "999999 is well-formed and nowhere",
  isValidPostalFormat("in", "999999"),
  true,
  "format says nothing about whether a courier goes there"
);
check("normalising strips punctuation", normalisePostal("in", "682-001"), "682001");

console.log("\n=== the market decides the wording ===");
check("India says Pincode", postalLabel("in"), "Pincode");
check("India uses a numeric keypad", postalIsNumeric("in"), true);
check(
  "an unknown market falls back to Postcode rather than throwing",
  postalLabel("gb" as never),
  "Postcode"
);

console.log("\n=== serviceability ===");

check("an excluded prefix is refused", ask("190001", 500).status, "unserviceable");
check(
  "exclusion beats a zone that also matches",
  resolveDelivery({
    market: "in",
    postalCode: "682001",
    orderValueInr: 500,
    delivery: { ...delivery, unserviceable_prefixes: ["682"] },
    shipping,
  }).status,
  "unserviceable",
  "a hole inside a served region is still a hole"
);
check("a malformed pincode is invalid, not unserviceable", ask("68", 500).status, "invalid");
check(
  "the estimator switched off answers unavailable",
  ask("682001", 500, { ...delivery, estimator_enabled: false }).status,
  "unavailable"
);
check(
  "switched off wins even over a bad pincode",
  ask("nonsense", 500, { ...delivery, estimator_enabled: false }).status,
  "unavailable",
  "nothing is disclosed while the feature is off"
);

console.log("\n=== days come from the most specific zone ===");

const kerala = ask("670001", 500);
check("a Kerala pincode gets the Kerala range", kerala.status === "serviceable" && kerala.days, {
  min: 2,
  max: 3,
});
const ernakulam = ask("682001", 500);
check(
  "682 beats 68 — longest prefix wins",
  ernakulam.status === "serviceable" && ernakulam.days,
  { min: 1, max: 2 }
);
const elsewhere = ask("560001", 500);
check(
  "an unzoned pincode gets the default range",
  elsewhere.status === "serviceable" && elsewhere.days,
  { min: 4, max: 7 }
);

console.log("\n=== no invented times ===");

const noDays = ask("560001", 500, { ...delivery, default_min_days: 0, default_max_days: 0 });
check("with no range configured, days are null", noDays.status === "serviceable" && noDays.days, null);
check(
  "and the fallback wording is offered instead",
  noDays.status === "serviceable" && noDays.fallbackNote,
  DEFAULT_DELIVERY.fallback_note
);
check(
  "the stock config promises no delivery time at all",
  DEFAULT_DELIVERY.default_min_days === 0 && DEFAULT_DELIVERY.default_max_days === 0,
  true,
  "a day range is a business commitment, not a default"
);
const backwards = ask("560001", 500, { ...delivery, default_min_days: 9, default_max_days: 2 });
check(
  "a reversed range is treated as unset rather than shown backwards",
  backwards.status === "serviceable" && backwards.days,
  null
);

console.log("\n=== the money is quoteShipping's answer, not a second opinion ===");

for (const [label, pin, value] of [
  ["Kerala, below threshold", "670001", 500],
  ["elsewhere, below threshold", "560001", 500],
  ["elsewhere, above threshold", "560001", 5000],
  ["Kerala, above threshold", "682001", 5000],
] as const) {
  const mine = ask(pin, value);
  const theirs = quoteShipping({ postal_code: pin, country: "IN" }, value, shipping);
  check(
    `${label}: cost and free match quoteShipping exactly`,
    mine.status === "serviceable" && { cost: mine.cost, free: mine.free },
    { cost: theirs.cost, free: theirs.free },
    "the PDP cannot contradict the till"
  );
}

console.log("\n=== the free-delivery threshold is only mentioned when it helps ===");

const under = ask("560001", 500);
check(
  "below the threshold, the threshold is offered",
  under.status === "serviceable" && under.freeAboveInr,
  3000
);
const over = ask("560001", 5000);
check(
  "above it, there is nothing to mention",
  over.status === "serviceable" && over.freeAboveInr,
  null
);
const alreadyFree = ask("670001", 500);
check(
  "already free by region — the threshold is noise",
  alreadyFree.status === "serviceable" && alreadyFree.freeAboveInr,
  null,
  "telling somebody how to get what they already have is clutter"
);
check(
  "a disabled threshold is never mentioned",
  (() => {
    const r = resolveDelivery({
      market: "in",
      postalCode: "560001",
      orderValueInr: 500,
      delivery,
      shipping: { ...shipping, free_above_inr: 0 },
    });
    return r.status === "serviceable" && r.freeAboveInr;
  })(),
  null
);

console.log("\n=== zone naming ===");
check("the matched zone is named for the admin", kerala.status === "serviceable" && kerala.zoneName, "Kerala");
check(
  "an unzoned pincode names nothing",
  elsewhere.status === "serviceable" && elsewhere.zoneName,
  null
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
