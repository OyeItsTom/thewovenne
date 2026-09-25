/**
 * The merchant policy, in code and in markup, saying what the pages say.
 *
 *   npx tsx scripts/merchant-policy.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHAT THIS IS REALLY GUARDING. A shipping page and a till that disagree is
 * worse than having neither: the customer believes the page, and finds out at
 * the moment they are asked to pay. The shop shipped for months with ₹120 and a
 * free-Kerala rule that existed only in lib/shipping and in the charge — no
 * page ever said it. These assertions pin the published policy to the three
 * places that must now agree: the default config the till quotes from, the
 * structured data Google reads, and the copy on the page.
 *
 * The third of those lives in the CMS, so it cannot be asserted from here. What
 * CAN be asserted is that nothing in the code contradicts it, and that the
 * numbers only exist in one place.
 */
import {
  organizationNode,
  PUBLIC_EMAIL,
  PUBLIC_PHONE,
  POSTAL_ADDRESS,
  STANDARD_SHIPPING_INR,
  KERALA_SHIPPING_INR,
  FREE_SHIPPING_THRESHOLD_INR,
  SHIPPING_COUNTRY,
} from "../lib/structuredData";
import { DEFAULT_SHIPPING, quoteShipping } from "../lib/shipping";
import { serializeJsonLd } from "../lib/jsonLd";

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

const org = organizationNode();
const json = JSON.stringify(org);
const ship = org.hasShippingService;
const ret = org.hasMerchantReturnPolicy;
const inIndia = (pin: string) => ({ postal_code: pin, country: "IN" });

console.log("\n=== PUBLIC CONTACT ===");

check("customer email is hello@", PUBLIC_EMAIL, "hello@thewovenne.com");
check("phone", PUBLIC_PHONE, "+91 7736749305");
check("address", POSTAL_ADDRESS, {
  "@type": "PostalAddress",
  streetAddress: "Anns Building",
  addressLocality: "Kidangara",
  addressRegion: "Kerala",
  postalCode: "686102",
  addressCountry: "IN",
});
ok("admin@ appears nowhere in the storefront markup", !json.includes("admin@thewovenne.com"),
  "it is the operator's own login — migration 0008");
ok("no invented business hours", !/openingHours|hoursAvailable/i.test(json));
ok("no invented tax or company identifiers", !/vatID|taxID|iso6523|naics|\bCIN\b|GSTIN/i.test(json));

console.log("\n=== THE SCHEMA'S NUMBERS ARE THE TILL'S NUMBERS ===");

/*
 * ONLY THE AGREEMENT IS TESTED HERE. What the till charges for any given PIN
 * and basket is scripts/shipping-policy.test.ts's job, and repeating it would
 * mean two suites that can disagree about the same rule. What this file owns is
 * narrower and belongs with the markup: that the constants the schema is built
 * from are the same ones lib/shipping quotes from, so the free tier Google is
 * told about is the free tier a customer actually gets.
 */
check("the threshold the schema states is the threshold the till uses",
  FREE_SHIPPING_THRESHOLD_INR, DEFAULT_SHIPPING.free_above_inr);
check("the rest-of-India constant tracks the till", STANDARD_SHIPPING_INR, DEFAULT_SHIPPING.flat_rate_inr);
check("the Kerala constant tracks the configured region", KERALA_SHIPPING_INR,
  DEFAULT_SHIPPING.regional_rates.find((r) => r.name === "Kerala")?.rate_inr);
check("and the free tier really is free at that threshold",
  quoteShipping(inIndia("110001"), FREE_SHIPPING_THRESHOLD_INR, DEFAULT_SHIPPING).free, true,
  "the one claim the markup makes, checked against the function that honours it");

console.log("\n=== SHIPPING SCHEMA CLAIMS ONLY WHAT IS TRUE EVERYWHERE ===");

check("it is a ShippingService", ship["@type"], "ShippingService");
check("exactly one condition — the free tier", ship.shippingConditions.length, 1);
const freeBand = ship.shippingConditions[0];
check("free at the threshold and above", freeBand.shippingRate,
  { "@type": "MonetaryAmount", value: 0, currency: "INR" });
check("band starts at ₹3,000", freeBand.orderValue.minValue, 3000);
check("with no upper bound", "maxValue" in freeBand.orderValue, false);
check("destination is India", freeBand.shippingDestination[0].addressCountry, "IN");
check("shipping country is India", SHIPPING_COUNTRY, "IN");

console.log("\n  — and claims NOTHING below the threshold —");
ok("no ₹129 nationwide claim", !json.includes('"value":129') && !json.includes('"value": 129'));
ok("no ₹99 nationwide claim", !json.includes('"value":99') && !json.includes('"value": 99'));
// Scoped to the SHIPPING node, not the whole organisation: the business's own
// postal address legitimately carries addressRegion "Kerala" and a postalCode,
// and that is a statement about where the shop is, not about where it delivers
// cheaply. Only the shipping node is claiming a destination.
const shipJson = JSON.stringify(ship);
ok("no India sub-region targeting Google cannot read",
  !shipJson.includes("addressRegion") &&
  !shipJson.includes("postalCode") &&
  !shipJson.includes("postalCodePrefix"),
  "addressRegion and postalCode are unsupported for IN");
ok("no region named as a shipping destination", !shipJson.includes("Kerala"));
ok("the business address still states its own region",
  JSON.stringify(org.address).includes("Kerala"),
  "where the shop IS, not where it ships cheaply");

console.log("\n  — nothing international is claimed —");
for (const c of ["GB", "AE", "US", "worldwide", "Worldwide", "International"]) {
  ok(`no ${c}`, !json.includes(c));
}

console.log("\n  — no delivery-time claim, because the working week is unconfirmed —");
ok("no handlingTime", !json.includes("handlingTime"));
ok("no transitTime", !json.includes("transitTime"));
ok("no businessDays invented", !json.includes("businessDays"));
ok("no cutoffTime invented", !json.includes("cutoffTime"));

console.log("\n=== RETURNS: NOT PERMITTED, AND NOT A 7-DAY WINDOW ===");

check("category is MerchantReturnNotPermitted", ret.returnPolicyCategory,
  "https://schema.org/MerchantReturnNotPermitted");
check("applicable country", ret.applicableCountry, "IN");
check("it links to the returns page at its PUBLISHED slug", ret.merchantReturnLink,
  "https://www.thewovenne.com/in/returns-exchanges",
  "the CMS slugged it from the title 'Returns & Exchanges'");
ok("and not at the slug this was first written against",
  !JSON.stringify(ret).includes('"https://www.thewovenne.com/in/returns"'));
check("no merchantReturnDays — the category does not take one", "merchantReturnDays" in ret, false,
  "the 7 days are a window to REPORT a fault, not to return anything for any reason");
ok("no 7-day return window is advertised", !json.includes('"merchantReturnDays":7') && !json.includes("MerchantReturnFiniteReturnWindow"));
ok("no 28-day or 30-day generic policy", !/\b(28|30|60)\b/.test(JSON.stringify(ret)));
ok("no refund-timing promise anywhere", !/refundTime|returnShippingFees|restocking/i.test(json));

console.log("\n=== THE WHOLE NODE IS STILL SAFE AND VALID ===");

const serialized = serializeJsonLd(org)!;
ok("valid JSON", (() => { try { JSON.parse(serialized); return true; } catch { return false; } })());
ok("no raw < > or &", !/[<>&]/.test(serialized));
check("round-trips", JSON.parse(serialized).email, "hello@thewovenne.com");
check("still exactly one node type", org["@type"], "OnlineStore");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
