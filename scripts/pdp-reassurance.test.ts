/**
 * PDP reassurance — product details, care, delivery & returns, reviews,
 * WhatsApp and photo alt text on the product page.
 *
 *   npx tsx scripts/pdp-reassurance.test.ts
 *
 * Exits non-zero on failure.
 *
 * Renders the REAL ProductReassurance, ImageGallery and ImageViewer to static
 * markup, so what is asserted is what a customer's browser receives — not a
 * paraphrase of it. Everything shown is decided upstream (productFactRows,
 * careFor, policySummary); these checks pin that nothing is composed, padded or
 * claimed on the way to the page.
 */
process.env.NEXT_PUBLIC_WHATSAPP_NUMBER = "919876543210";
process.env.NEXT_PUBLIC_SITE_URL = "https://www.thewovenne.com";

import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ProductReassurance from "../components/product/ProductReassurance";
import ImageGallery from "../components/product/ImageGallery";
import ImageViewer from "../components/product/ImageViewer";
import ProductReviews from "../components/product/ProductReviews";
import { isPlaceholderFact, productFactRows, type FactSource } from "../lib/productInfo";
import { careFor } from "../lib/care";
import { POLICY_PAGES, policySummary, type PolicySummary } from "../lib/policySummary";
import { productNode } from "../lib/structuredData";
import { serializeJsonLd } from "../lib/jsonLd";
import { whatsappProductEnquiry } from "../lib/whatsapp";
import { productImageAlt } from "../lib/seo";

// tsx compiles JSX with the classic transform, which expects React in scope.
// Next supplies it in the real build.
(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, condition: boolean) => check(name, condition, true);
const read = (p: string) => fs.readFileSync(p, "utf8");
const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const none: Omit<FactSource, "profile"> = {
  fabric: null, dimensions: null, blousePiece: null, fit: null, finish: null, weave: null, origin: null,
};
const render = (props: Parameters<typeof ProductReassurance>[0]) =>
  renderToStaticMarkup(createElement(ProductReassurance, props));

// The live published intros on 7 Oct 2026 — what the pages say today.
const SHIPPING_PAGE = {
  slug: "shipping-delivery",
  title: "Shipping & Delivery",
  intro: "We deliver across India. ₹99 to Kerala, ₹129 elsewhere, free on orders of ₹3,000 or more.",
};
const RETURNS_PAGE = {
  slug: "returns-exchanges",
  title: "Returns & Exchanges",
  intro: "We do not accept change-of-mind returns. If an item arrives damaged or incorrect, contact us within 7 days of delivery.",
};
const policies = [policySummary("delivery", SHIPPING_PAGE), policySummary("returns", RETURNS_PAGE)].filter(
  (p): p is PolicySummary => p !== null
);

// ── 1–6. Facts by product type ──────────────────────────────────────────────
console.log("\n=== product details: only stored facts that apply ===");

const sareeFacts = productFactRows({
  ...none, profile: "saree", fabric: "Handloom 120 count mul cotton", dimensions: "5.5 m × 1.15 m",
  blousePiece: "included", finish: "Should not show", weave: "Plain weave", origin: "Balaramapuram, Kerala",
});
check("saree: fabric, weave, dimensions, blouse piece, origin (no finish)",
  sareeFacts.map((f) => f.label), ["Fabric", "Weave / technique", "Dimensions", "Blouse piece", "Origin"]);
const sareeHtml = render({ facts: sareeFacts, care: null, policies: [] });
ok("1. several populated facts all render, labelled", ["Fabric", "Handloom 120 count mul cotton", "5.5 m × 1.15 m", "Included", "Balaramapuram, Kerala"].every((s) => text(sareeHtml).includes(s)));

const garment = productFactRows({ ...none, profile: "garment", fabric: "Linen", fit: "Relaxed; size up for a loose drape", blousePiece: "included", finish: "x" });
check("4. garment: Fabric and Fit & sizing only — no blouse piece, no finish", garment.map((f) => f.label), ["Fabric", "Fit & sizing"]);

const jewellery = productFactRows({ ...none, profile: "jewellery", fabric: "Brass", finish: "14K gold plated", dimensions: "Adjustable", fit: "x", blousePiece: "included" });
check("5. jewellery: Material, Finish, Dimensions", jewellery.map((f) => f.label), ["Material", "Finish", "Dimensions"]);

const general = productFactRows({ ...none, profile: "general", origin: "Kerala", finish: "x", fit: "x", blousePiece: "included" });
check("6. general: only what exists and applies", general.map((f) => f.label), ["Origin"]);

const sparse = productFactRows({ ...none, profile: "saree", fabric: "Cotton" });
const sparseHtml = render({ facts: sparse, care: null, policies });
check("2. almost no optional facts: one row, no empty headings", sparse.map((f) => f.label), ["Fabric"]);
ok("…and no Care fold without a care note", !text(sparseHtml).includes("Care"));
check("an empty product (no facts, care or policy) renders nothing at all", render({ facts: [], care: null, policies: [] }), "");
const jewelleryNothing = render({ facts: productFactRows({ ...none, profile: "jewellery" }), care: null, policies });
ok("a jewellery piece with no stored facts shows no Product details fold", !jewelleryNothing.includes("Product details") && jewelleryNothing.includes("Delivery &amp; returns"));

console.log("\n=== 7–8. blanks and placeholders never print ===");
const blanks = productFactRows({ ...none, profile: "saree", fabric: "  ", dimensions: "", origin: "\n", weave: null });
check("7. blank values are not rows", blanks, []);
for (const filler of ["UNKNOWN", "Unknown", "n/a", "N/A", "NA", "-", "—", "–", "?", "TBD", "none", "null", " - "]) {
  ok(`8. "${filler}" is a placeholder`, isPlaceholderFact(filler));
}
for (const real of ["Not included", "Natural dye", "Kerala", "Na Pali silk", "Unknown origin story"]) {
  ok(`"${real}" is a real value, not a placeholder`, !isPlaceholderFact(real));
}
const unknowns = productFactRows({ ...none, profile: "saree", fabric: "Cotton", origin: "UNKNOWN", dimensions: "-", weave: "N/A" });
check("8. UNKNOWN / dash / N/A rows are dropped", unknowns.map((f) => f.label), ["Fabric"]);
ok("8. …and never reach the page", !/unknown|N\/A/i.test(text(render({ facts: unknowns, care: null, policies: [] }))));

console.log("\n=== 9. care only when stored ===");
check("no note → no care", careFor({ careNote: null }), null);
check("whitespace → no care", careFor({ careNote: "   " }), null);
check("'N/A' → no care", careFor({ careNote: "N/A" }), null);
const written = "Hand wash separately in cold water.\nDry in the shade.";
const careHtml = render({ facts: sparse, care: careFor({ careNote: written }), policies: [] });
ok("9. the stored note renders verbatim inside a Care fold", careHtml.includes(">Care<") && careHtml.includes(written));
ok("9. no generated advice is added around it", text(careHtml).replace(text(written), "").replace(/Product details|Fabric|Cotton|Care/g, "").trim() === "");

console.log("\n=== 10–11. delivery and returns quote the live pages ===");
const [delivery, returns] = policies;
check("10. delivery summary IS the Shipping & Delivery intro", delivery.summary, SHIPPING_PAGE.intro);
check("10. …links to that page", delivery.href, "/in/shipping-delivery");
check("10. …and the link names it", delivery.linkText, "Read the Shipping & Delivery policy");
check("11. returns summary IS the Returns & Exchanges intro", returns.summary, RETURNS_PAGE.intro);
check("11. …links to that page", returns.href, "/in/returns-exchanges");
check("11. …and the link names it", returns.linkText, "Read the Returns & Exchanges policy");
const policyHtml = render({ facts: [], care: null, policies });
ok("10–11. both render, in full, with their links", policyHtml.includes(SHIPPING_PAGE.intro) && policyHtml.includes(RETURNS_PAGE.intro.replace(/'/g, "&#x27;"))
  && policyHtml.includes('href="/in/shipping-delivery"') && policyHtml.includes('href="/in/returns-exchanges"'));
check("no published page → no delivery row", policySummary("delivery", null), null);
check("a page with no intro → no row (nothing composed instead)", policySummary("returns", { ...RETURNS_PAGE, intro: null }), null);
check("a blank intro → no row", policySummary("returns", { ...RETURNS_PAGE, intro: "  " }), null);
check("the wrong page cannot stand in for the policy", policySummary("delivery", RETURNS_PAGE), null);
check("the slugs are the live policy pages", POLICY_PAGES, { delivery: "shipping-delivery", returns: "returns-exchanges" });
const policyLib = read("lib/policySummary.ts");
ok("policySummary holds no policy wording of its own", !/₹|\d+\s*days?|free|refund|exchange|return within/i.test(
  policyLib.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"returns-exchanges"|"Returns"|returns:/g, "")));
const detail = read("components/product/ProductDetail.tsx");
ok("the PDP reads the PUBLISHED pages (default anonymous context)",
  detail.includes("getPageBySlug(POLICY_PAGES.delivery)") && detail.includes("getPageBySlug(POLICY_PAGES.returns)"));

console.log("\n=== 12. verified purchase ===");
const review = { id: "r1", rating: 5, body: "Beautiful weave, true to the photos.", author: "Asha", created_at: "2026-09-01T00:00:00Z", verified: true };
const withReview = renderToStaticMarkup(createElement(ProductReviews, { productId: "p", reviews: [review], rating: { average: 5, total: 1 } }));
const unverified = renderToStaticMarkup(createElement(ProductReviews, { productId: "p", reviews: [{ ...review, verified: false }], rating: { average: 5, total: 1 } }));
const empty = renderToStaticMarkup(createElement(ProductReviews, { productId: "p", reviews: [], rating: { average: null, total: 0 } }));
check("12. one verified review → exactly one Verified purchase label", (withReview.match(/Verified purchase/g) ?? []).length, 1);
ok("12. an unverified review → no Verified purchase label (0066)", !/Verified purchase/.test(unverified) && text(unverified).includes(review.body));
ok("12. no reviews → no Verified label, no stars, no count", !/Verified purchase|★|0\.0|0 reviews/.test(empty));
ok("12. the empty state is honest", text(empty).includes("No reviews yet"));
ok("12. insert is gated by has_purchased in RLS (0036)",
  /create policy "Verified purchasers may review"[\s\S]*has_purchased\(product_id\)/.test(read("supabase/migrations/0036_product_reviews.sql")));
ok("12. the rating link only shows with a real count", detail.includes("rating.total > 0 && rating.average !== null"));

console.log("\n=== 13–15. WhatsApp names this exact piece ===");
const product = { name: "Parrot Green Handloom Mul Cotton Saree", slug: "parrot-green-handloom-mul-cotton-saree", category_slug: "sarees", category_parent_slug: "women" };
const wa = whatsappProductEnquiry(product)!;
const msg = decodeURIComponent(wa.slice(wa.indexOf("?text=") + 6));
ok("13. the message names the product", msg.includes("Parrot Green Handloom Mul Cotton Saree"));
ok("14. the message carries the exact canonical URL", msg.includes("https://www.thewovenne.com/in/women/sarees/parrot-green-handloom-mul-cotton-saree"));
const urls = msg.match(/https?:\/\/\S+/g) ?? [];
check("15. exactly one link in the message", urls.length, 1);
ok("15. no admin path, query string, fragment, tracking or id in it", !/\/admin|\?|#|utm_|[0-9a-f]{8}-[0-9a-f]{4}/i.test(urls[0] ?? "?"));
ok("15. no email, phone or price in the message", !/@|₹|\+?\d{10}/.test(msg));
const options = read("components/product/ProductOptions.tsx");
ok("the sticky bar's WhatsApp uses the same product enquiry", options.includes("whatsappProductEnquiry(product)") && options.includes("href={waHref}"));
ok("…with an accessible name naming the piece", options.includes("aria-label={`Ask about ${product.name} on WhatsApp`}"));
ok("…and the bar respects the home-indicator inset", options.includes("env(safe-area-inset-bottom)"));
const css = read("app/globals.css");
ok("the generic floating button stands down on product pages",
  /@supports selector\(:has\(\*\)\)[\s\S]*body:has\(\[data-pdp\]\) \[data-whatsapp-float\][\s\S]*display: none/.test(css));
ok("…the floating button carries the marker", read("components/layout/WhatsAppButton.tsx").includes("data-whatsapp-float"));
ok("…the product page declares itself", detail.includes("<div data-pdp "));
ok("…and the bar's fallback clearance returns to the gutter", /\[data-sticky-cta\][\s\S]*padding-right: 1rem/.test(css) && options.includes("data-sticky-cta"));

console.log("\n=== 16–18. photo alt text ===");
const PHOTOS = ["/products/a.jpg", "/products/b.jpg"];
const NAME = "Red Saree";
const ALT0 = "Red cotton saree draped, showing the gold zari border";
const gallery = renderToStaticMarkup(createElement(ImageGallery, { images: PHOTOS, alt: NAME, alts: [ALT0, null] }));
ok("16. the published alt is used on the gallery frame", gallery.includes(`alt="${ALT0}"`));
ok("17. a photo with no alt keeps the safe fallback", gallery.includes(`alt="${NAME} — image 2 of 2"`));
const viewer = (index: number) => renderToStaticMarkup(createElement(ImageViewer, {
  images: PHOTOS, alt: NAME, alts: [ALT0, null], index, onIndexChange: () => {}, onClose: () => {}, baseSizes: "100vw",
}));
ok("18. zoom viewer uses the written alt for photo 1", viewer(0).includes(`alt="${ALT0}"`));
ok("18. zoom viewer falls back for photo 2", viewer(1).includes(`alt="${NAME} — image 2 of 2"`));
ok("18. the zoom detail layer stays decorative (no double reading)", viewer(0).includes('alt="" aria-hidden="true"'));
check("productImageAlt agrees with both", [productImageAlt(NAME, 0, 2, ALT0), productImageAlt(NAME, 1, 2, null)], [ALT0, `${NAME} — image 2 of 2`]);
ok("alt text never appears as visible copy in the reassurance block", !render({ facts: sareeFacts, care: null, policies }).includes(ALT0));

console.log("\n=== 19. structured data: no empty, no UNKNOWN, no colour ===");
const node = productNode({
  name: NAME, href: "/in/women/sarees/red-saree", images: [], description: null, price: 2500, soldOut: false,
  rating: { average: null, total: 0 }, fabric: "Cotton", facts: unknowns,
});
const ld = serializeJsonLd(node) ?? "";
ok("19. no empty string anywhere in the Product node", !/:""|:\[\]|:\{\}/.test(ld));
ok("19. no UNKNOWN / placeholder value", !/unknown|"-"|N\/A/i.test(ld));
ok("19. no colour", !/"color"/.test(ld));
ok("19. no additionalProperty when only placeholders were stored", !ld.includes("additionalProperty"));

console.log("\n=== 20. no unsupported claims or badges introduced ===");
const reassuranceSrc = read("components/product/ProductReassurance.tsx");
const shown = text(render({ facts: sareeFacts, care: careFor({ careNote: written }), policies }));
const BANNED = /handmade|handwoven|artisan|sustainab|eco-friendly|organic|ethical|authentic|certif|guarantee|hassle|easy returns|secure checkout|premium quality|100%|next-day|ships in 24|worldwide/i;
ok("20. the rendered block adds no claim beyond the stored and published text", !BANNED.test(
  shown.replace(SHIPPING_PAGE.intro, "").replace(RETURNS_PAGE.intro, "").replace(text(written), "")
    .replace(/Handloom 120 count mul cotton|Balaramapuram, Kerala|Plain weave/g, "")));
ok("20. the component source writes none of those words", !BANNED.test(reassuranceSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "")));
ok("20. no badge/icon-row component was added to the PDP", !/TrustBadge|Badge|ShieldCheck|BadgeCheck|Truck/.test(detail + reassuranceSrc));

console.log("\n=== accessibility & weight ===");
ok("native <details>/<summary>: keyboard and expanded state come from the browser", reassuranceSrc.includes("<details") && reassuranceSrc.includes("<summary"));
ok("the reassurance block is a server component (no 'use client')", !reassuranceSrc.includes('"use client"'));
ok("the chevron is decorative", /<ChevronDown\s+aria-hidden/.test(reassuranceSrc));
ok("summaries are at least 44px tall", reassuranceSrc.includes("min-h-[44px]"));
ok("Product details opens by default; the others are folded", /title="Product details" open/.test(reassuranceSrc) && !/title="Care" open|title="Delivery & returns" open/.test(reassuranceSrc));
ok("motion is reduced when asked", reassuranceSrc.includes("motion-reduce:transition-none"));
ok("MaterialCare (a client component) is gone", !fs.existsSync("components/product/MaterialCare.tsx"));
ok("the PDP renders ProductReassurance with the shared rows", detail.includes("<ProductReassurance facts={facts} care={care} policies={policies} />"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
