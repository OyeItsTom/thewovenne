/**
 * What Wovenne tells Google about its products.
 *
 *   npx tsx scripts/seo-structured-data.test.ts
 *
 * Exits non-zero on failure.
 *
 * Every assertion here is really the same assertion: THE MARKUP AGREES WITH THE
 * PAGE. A price that differs from the one on screen, a rating nobody can see,
 * an InStock on something sold out — each is a policy breach as well as a lie,
 * and none of them is visible by reading the page. So they are pinned here.
 *
 * Source guards cover placement: which routes emit which node, and that the
 * business facts deliberately left out have not quietly reappeared.
 */
import fs from "node:fs";
import {
  productNode,
  breadcrumbNode,
  organizationNode,
  aggregateRatingNode,
  BRAND_NAME,
  SITE_URL,
} from "../lib/structuredData";
import { serializeJsonLd, prune } from "../lib/jsonLd";
import { customerUrl } from "../lib/seo";
import { productHref } from "../lib/urls";

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

/**
 * prune() returns a JSON-shaped union, which is the right type for a function
 * whose job is to hand something to JSON.stringify — and awkward for a test
 * that wants to ask whether a key survived. This narrows it once, and throws
 * rather than casting, so "the node pruned away entirely" fails loudly instead
 * of quietly passing an `in` check against nothing.
 */
function pruned(value: unknown): Record<string, unknown> {
  const out = prune(value);
  if (out === undefined || typeof out !== "object" || Array.isArray(out)) {
    throw new Error("expected an object to survive pruning");
  }
  return out as Record<string, unknown>;
}

/**
 * U+2028, built rather than typed. It is invisible in an editor and is a line
 * terminator to a JavaScript parser, so writing it literally into this file is
 * how the fixture for the bug becomes the bug. See lib/jsonLd.
 */
const LINE_SEP = String.fromCharCode(0x2028);

const NO_REVIEWS = { average: null, total: 0 };
const REVIEWED = { average: 4.5, total: 12 };

const base = {
  name: "Red Saree",
  href: "/in/women/sarees/red-saree",
  images: ["https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/product-images/a.jpg"],
  description: "A handloom pure cotton saree in classic ivory.",
  price: 4200,
  soldOut: false,
  rating: NO_REVIEWS,
};

const node = productNode(base);
const offer = node.offers;

console.log("\n=== PRODUCT + OFFER ===");

check("type is Product", node["@type"], "Product");
check("context is schema.org", node["@context"], "https://schema.org");
check("name is the product's own", node.name, "Red Saree");
check("brand is THE WOVENNE", node.brand, { "@type": "Brand", name: "THE WOVENNE" });
check("brand constant is not drifting", BRAND_NAME, "THE WOVENNE");
ok("an Offer exists", offer?.["@type"] === "Offer");
check("price is the number the customer pays", offer.price, 4200);
check("currency is INR", offer.priceCurrency, "INR");
check("images are carried through", node.image, base.images);

console.log("\n=== URL AGREES WITH THE PAGE CANONICAL ===");

const expectedUrl = "https://www.thewovenne.com/in/women/sarees/red-saree";
check("Product.url is the canonical", node.url, expectedUrl);
check("Offer.url is the same URL", offer.url, expectedUrl, "one product, one address");
check(
  "and it is built from the same helper the canonical uses",
  node.url,
  customerUrl(productHref({ slug: "red-saree", category_slug: "sarees", category_parent_slug: "women" }))
);
check(
  "a product with incomplete filing follows its fallback path",
  productNode({ ...base, href: productHref({ slug: "x", category_slug: null, category_parent_slug: null }) }).url,
  "https://www.thewovenne.com/in/product/x"
);

console.log("\n=== AVAILABILITY FOLLOWS THE VISIBLE STOCK VERDICT ===");

check("in stock", offer.availability, "https://schema.org/InStock");
check(
  "sold out",
  productNode({ ...base, soldOut: true }).offers.availability,
  "https://schema.org/OutOfStock"
);
// stockState() is the authority; these mirror the two shapes it resolves.
// A sized piece is buyable when ANY size has stock — see lib/stock.
for (const [label, soldOut, expected] of [
  ["sized, one size left", false, "https://schema.org/InStock"],
  ["sized, every size gone", true, "https://schema.org/OutOfStock"],
  ["sizeless, stock above zero", false, "https://schema.org/InStock"],
  ["sizeless, stock at zero", true, "https://schema.org/OutOfStock"],
] as const) {
  check(label, productNode({ ...base, soldOut }).offers.availability, expected);
}
ok(
  "only the two states Google needs are ever emitted",
  ["https://schema.org/InStock", "https://schema.org/OutOfStock"].includes(offer.availability)
);

console.log("\n=== DESCRIPTION IS THE PRODUCT'S OWN OR ABSENT ===");

check("a real description is used", node.description, base.description);
check(
  "a missing description is OMITTED, not filled with the meta fallback",
  "description" in pruned(productNode({ ...base, description: null })),
  false,
  "a third of the catalogue would otherwise share one sentence"
);
ok(
  "and the generic fallback string appears nowhere in the node",
  !JSON.stringify(productNode({ ...base, description: null })).includes("Authentic handloom linen")
);

console.log("\n=== RATINGS ONLY WHERE THERE ARE REVIEWS ===");

check("no reviews, no aggregateRating", aggregateRatingNode(NO_REVIEWS), undefined);
check("total 0 with an average present is still nothing", aggregateRatingNode({ average: 4, total: 0 }), undefined);
check("a total without an average is nothing", aggregateRatingNode({ average: null, total: 3 }), undefined);
check(
  "genuine reviews produce a rating",
  aggregateRatingNode(REVIEWED),
  { "@type": "AggregateRating", ratingValue: 4.5, reviewCount: 12 }
);
ok(
  "an unreviewed product carries no rating key at all",
  !("aggregateRating" in pruned(node)),
  "no ratingValue: 0, no reviewCount: 0"
);
ok("a reviewed product does", "aggregateRating" in pruned(productNode({ ...base, rating: REVIEWED })));

console.log("\n=== IDENTIFIERS AND SHAPES DELIBERATELY ABSENT ===");

const reviewed = JSON.stringify(productNode({ ...base, rating: REVIEWED }));
for (const forbidden of ["gtin", "gtin8", "gtin13", "mpn", "sku", "ProductGroup", "hasVariant", "AggregateOffer", "itemCondition"]) {
  ok(`no ${forbidden}`, !reviewed.includes(forbidden));
}
check("offers is a single Offer, not an array", Array.isArray(node.offers), false);

console.log("\n=== priceValidUntil ===");

check("absent with no discount running", "priceValidUntil" in pruned(node.offers), false);
check(
  "present while a discount is running",
  productNode({ ...base, priceValidUntil: "2026-12-01T00:00:00.000Z" }).offers.priceValidUntil,
  "2026-12-01T00:00:00.000Z"
);
check(
  "absent when the discount has no end date",
  "priceValidUntil" in pruned(productNode({ ...base, priceValidUntil: null }).offers),
  false
);

console.log("\n=== BREADCRUMBLIST ===");

const productCrumbs = breadcrumbNode([
  { name: "Women", path: "/women" },
  { name: "Sarees", path: "/women/sarees" },
  { name: "Red Saree" },
]);
check("type is BreadcrumbList", productCrumbs?.["@type"], "BreadcrumbList");
check("positions run 1..n in order", productCrumbs?.itemListElement.map((i) => i.position), [1, 2, 3]);
check("names match the visible trail", productCrumbs?.itemListElement.map((i) => i.name), ["Women", "Sarees", "Red Saree"]);
check(
  "links are absolute and /in-prefixed",
  productCrumbs?.itemListElement.map((i) => i.item),
  [
    "https://www.thewovenne.com/in/women",
    "https://www.thewovenne.com/in/women/sarees",
    undefined,
  ]
);
check("the last crumb carries no item — it is this page", productCrumbs?.itemListElement[2].item, undefined);
ok("every item is a ListItem", productCrumbs!.itemListElement.every((i) => i["@type"] === "ListItem"));
ok(
  "no Home level is invented",
  !JSON.stringify(productCrumbs).includes('"Home"'),
  "the visible breadcrumb starts at the section"
);

const childCrumbs = breadcrumbNode([{ name: "Women", path: "/women" }, { name: "Sarees" }]);
check("a sub-category trail is two deep", childCrumbs?.itemListElement.length, 2);
check("with the parent linked", childCrumbs?.itemListElement[0].item, "https://www.thewovenne.com/in/women");
check("and the current page unlinked", childCrumbs?.itemListElement[1].item, undefined);
check("an empty trail produces no node", breadcrumbNode([]), undefined);

console.log("\n=== ORGANIZATION ===");

const org = organizationNode();
check("OnlineStore, the subtype Google names for ecommerce", org["@type"], "OnlineStore");
check("name", org.name, "THE WOVENNE");
check("url is the site root, not a market inside it", org.url, "https://www.thewovenne.com/");
check("SITE_URL constant agrees", SITE_URL, "https://www.thewovenne.com/");
check("logo is absolute and public", org.logo, "https://www.thewovenne.com/logo_illustrated.png");
check("email is the customer address", org.email, "hello@thewovenne.com");
check("telephone", org.telephone, "+91 7736749305");
check("address is the confirmed trading address", org.address, {
  "@type": "PostalAddress",
  streetAddress: "Anns Building",
  addressLocality: "Kidangara",
  addressRegion: "Kerala",
  postalCode: "686102",
  addressCountry: "IN",
});
const orgJson = JSON.stringify(org);
ok("admin@ never reaches the storefront — it is the operator's own login",
  !orgJson.includes("admin@thewovenne.com"));
ok("no sameAs: the Instagram link is admin-editable content, not a fixed fact",
  !orgJson.includes("sameAs"));

/*
 * MERCHANT POLICY IS THE ORGANISATION'S, NOT THE PRODUCT'S. Google takes
 * hasMerchantReturnPolicy and hasShippingService at organisation level, where
 * one statement covers the whole catalogue. Repeating them on every Product
 * would restate the same policy 33 times per crawl, and — worse — create a
 * second place for it to be true, which is how a shipping rule ends up saying
 * one thing on the shop and another in the markup.
 */
const productJson = JSON.stringify(productNode({ ...base, rating: REVIEWED }));
ok("a Product carries no return policy of its own",
  !productJson.includes("hasMerchantReturnPolicy"));
ok("a Product carries no shipping service of its own",
  !productJson.includes("hasShippingService"));
ok("nor any postal address or contact details",
  !productJson.includes("PostalAddress") && !productJson.includes("telephone"));

console.log("\n=== JSON SAFETY ===");

const nasty = productNode({
  ...base,
  name: 'Saree </script><img src=x onerror="alert(1)">',
  description: `He said "handloom" & <b>meant</b> it — 100% cotton${LINE_SEP}next line`,
});
const serialized = serializeJsonLd(nasty)!;
ok("no literal </script> survives", !serialized.toLowerCase().includes("</script"));
ok("no raw < survives", !serialized.includes("<"));
ok("no raw > survives", !serialized.includes(">"));
ok("no raw & survives", !serialized.includes("&"));
ok("no raw U+2028 survives", !serialized.includes(LINE_SEP));
ok("it is still valid JSON", (() => { try { JSON.parse(serialized); return true; } catch { return false; } })());
check(
  "and it parses back to the original text, unchanged",
  JSON.parse(serialized).name,
  'Saree </script><img src=x onerror="alert(1)">',
  "escaping is transport-only; Google reads the true value"
);
check("quotes survive a round trip", JSON.parse(serialized).description.includes('"handloom"'), true);

console.log("\n=== PRUNING: NOTHING EMPTY IS EVER CLAIMED ===");

check("undefined is dropped", prune({ a: undefined }), undefined);
check("null is dropped", prune({ a: null }), undefined);
check("NaN is dropped", prune({ a: NaN }), undefined);
check("Infinity is dropped", prune({ a: Infinity }), undefined);
check("an empty string is dropped", prune({ a: "   " }), undefined);
check("an empty object is dropped", prune({ a: {} }), undefined);
check("an empty array is dropped", prune({ a: [] }), undefined);
check("zero is KEPT — it is a value", prune({ a: 0 }), { a: 0 });
check("false is KEPT", prune({ a: false }), { a: false });
check("strings are trimmed", prune({ a: "  x  " }), { a: "x" });
check("a node that prunes to nothing serialises to null", serializeJsonLd({ a: null }), null);
ok("no NaN or undefined can reach the output", !JSON.stringify(prune(productNode({ ...base, price: NaN }))).includes("NaN"));

console.log("\n=== SOURCE GUARDS: placement ===");

const read = (p: string) => fs.readFileSync(p, "utf8");
const detail = read("components/product/ProductDetail.tsx");
const childRoute = read("app/(storefront)/in/[slug]/[child]/page.tsx");
const home = read("app/(storefront)/in/page.tsx");
const hierarchical = read("app/(storefront)/in/[slug]/[child]/[product]/page.tsx");
const legacy = read("app/(storefront)/in/product/[slug]/page.tsx");

ok("ProductDetail emits the Product node", detail.includes("productNode("));
ok("ProductDetail emits the breadcrumb", detail.includes("breadcrumbNode("));
ok("the hierarchical product route renders ProductDetail", hierarchical.includes("<ProductDetail"));
ok("the legacy flat product route renders it too", legacy.includes("<ProductDetail"),
  "one implementation, so both routes cannot describe a product differently");
ok("availability reads the sizes-aware stock verdict", detail.includes("stockState(product.stock_quantity, sizes)"));
ok("the rating passed is the one the page renders", detail.includes("rating,"));
ok("the sub-category route emits a breadcrumb", childRoute.includes("breadcrumbNode("));
ok("the home page emits the organization node", home.includes("organizationNode()"));

for (const [name, file] of [
  ["ProductDetail", detail],
  ["sub-category route", childRoute],
  ["hierarchical product route", hierarchical],
  ["legacy product route", legacy],
] as const) {
  ok(`${name} does not emit an organization node`, !file.includes("organizationNode"),
    "Google asks for it once, not on every page");
}
ok("only one file emits organizationNode", home.includes("organizationNode") && !detail.includes("organizationNode"));
ok("no hand-written ld+json anywhere but the JsonLd component",
  !detail.includes("application/ld+json") && !childRoute.includes("application/ld+json") && !home.includes("application/ld+json"));
ok("the JsonLd component routes through the escaping helper",
  read("components/seo/JsonLd.tsx").includes("serializeJsonLd"));

console.log("\n=== NO DUPLICATE NODES ON ONE PAGE ===");

const pdpTypes = [productNode(base)["@type"], productCrumbs!["@type"]];
check("a PDP emits Product + BreadcrumbList, each once", pdpTypes.length, new Set(pdpTypes).size);
const homeTypes = [organizationNode()["@type"]];
check("the home page emits one node", homeTypes.length, new Set(homeTypes).size);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
