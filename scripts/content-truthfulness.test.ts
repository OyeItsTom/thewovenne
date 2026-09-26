/**
 * SEO-5E — what the shop says about itself matches what it stocks.
 *
 *   npx --cache <dir> --yes tsx@4.19.2 scripts/content-truthfulness.test.ts
 *
 * SCOPED, NOT A WORD BAN. "linen" is not forbidden anywhere: the journal has
 * real articles about linen, lib/care knows how to wash it, and the Why Us copy
 * names it as where the collection is heading. What is checked is narrower —
 * that nothing presents the CURRENT shop as a linen, UK-shipping or
 * Kerala-woven business, and that defaults deleting a CMS row falls back to
 * cannot bring those claims back.
 *
 * The page and component files are read as text rather than rendered: they are
 * server/client components with data dependencies, and the question here is
 * only which words ship.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONTENT } from "../lib/content";
import { DEFAULT_SHIPPING } from "../lib/shipping";
import { INSIGHTS_SYSTEM } from "../lib/insights";
import { buildSystemPrompt } from "../lib/chat";
import {
  planAbout,
  planFooter,
  planHero,
  planLookbook,
  planShipping,
  planWhyUs,
  CONTENT_KEYS,
  PAGE_SLUGS,
  STRAPLINE,
  WHY_US_TITLE,
  WHY_US_CARDS,
  LOOKBOOK_HREF,
  lookbookPath,
  ABOUT,
} from "./seo-5e-drafts.mjs";

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
function throws(name: string, fn: () => unknown) {
  try {
    fn();
    check(name, "did not throw", "threw");
  } catch {
    check(name, "threw", "threw");
  }
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
/** Source with comments removed — a comment explaining a removed claim is not the claim. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Claims the current shop cannot make about itself. */
const STALE = [
  /\bflax\b/i,
  /\bUK\b/,
  /united kingdom/i,
  /woven in kerala/i,
  /artisans? across kerala/i,
  /kerala weavers/i,
  /kerala loom/i,
  /direct from the (loom|source)/i,
  /Woven in India/i,
  /Worn for life/i,
];
const staleIn = (text: string) => STALE.filter((re) => re.test(text)).map(String);

// ════════════════════════════════════════════════════════════════════
console.log("\n=== code defaults cannot resurrect a stale claim ===");
const defaults = JSON.stringify(DEFAULT_CONTENT);
check("no stale claim anywhere in DEFAULT_CONTENT", staleIn(defaults), []);
check("no generic linen claim in the hero", /linen/i.test(JSON.stringify(DEFAULT_CONTENT.home_hero)), false);
check("no linen in the footer description", /linen/i.test(DEFAULT_CONTENT.footer.brand_description), false);
check("no linen in the brand story", /linen/i.test(JSON.stringify(DEFAULT_CONTENT.brand_story)), false);
check("the Why Us title is exactly the approved one", DEFAULT_CONTENT.why_linen.title, "Why Us");
check("and the draft spec uses the same title", WHY_US_TITLE, "Why Us");
check("Kerala appears in the brand story only as where the business is",
  DEFAULT_CONTENT.brand_story.body.includes("based in Kerala, India"), true);

console.log("\n=== the approved Why Us cards, exactly ===");
check("default cards are the approved three", DEFAULT_CONTENT.why_linen.cards, WHY_US_CARDS);
check("card 1", DEFAULT_CONTENT.why_linen.cards[0].title, "Chosen piece by piece");
check("card 2", DEFAULT_CONTENT.why_linen.cards[1].title, "Natural fabrics first");
check("card 3", DEFAULT_CONTENT.why_linen.cards[2].title, "Chosen to be worn again");
check("linen is named only as direction, in card 2",
  DEFAULT_CONTENT.why_linen.cards.map((c) => /linen/i.test(c.text)), [false, true, false]);
check("and card 2 says it is becoming, not current",
  DEFAULT_CONTENT.why_linen.cards[1].text.includes("linen becoming a key material as the collection grows"), true);
const whyUs = read("components/home/WhyLinen.tsx");
check("no Leaf icon", /\bLeaf\b/.test(code("components/home/WhyLinen.tsx")), false);
check("Hand, Shirt, Heart in card order", /const ICONS = \[Hand, Shirt, Heart\]/.test(whyUs), true);
check("the CMS key keeps its name", "why_linen" in DEFAULT_CONTENT, true);

console.log("\n=== the latent hero fields ===");
check("eyebrow", DEFAULT_CONTENT.home_hero.eyebrow, "Chosen piece by piece.");
check("heading", DEFAULT_CONTENT.home_hero.heading, "THE WOVENNE");
check("subheading", DEFAULT_CONTENT.home_hero.subheading, "A considered selection of clothing, sarees and jewellery.");
check("CTA unchanged", [DEFAULT_CONTENT.home_hero.cta_label, DEFAULT_CONTENT.home_hero.cta_href], ["Explore the Collection", "/in/shop"]);

console.log("\n=== the strapline is \"Chosen piece by piece.\" ===");
const layout = read("app/layout.tsx");
check("site title carries the new strapline", layout.includes('const SITE_TITLE = "THE WOVENNE | Chosen piece by piece.";'), true);
check("footer description leads with it", DEFAULT_CONTENT.footer.brand_description.startsWith("Chosen piece by piece."), true);
for (const f of [
  "lib/emails/orderConfirmation.ts",
  "lib/emails/orderCancelled.ts",
  "lib/emails/marketing.ts",
  "lib/emails/styleRejected.ts",
  "components/product/BrandKnowledgePanel.tsx",
]) {
  const src = read(f);
  check(`${f}: old strapline gone`, /Woven in India|Worn for life/.test(src), false);
  check(`${f}: new strapline present, with its full stop`, src.includes(STRAPLINE), true);
}
check("the draft spec's strapline is the approved one", STRAPLINE, "Chosen piece by piece.");
check("the hero eyebrow is the strapline, full stop included", DEFAULT_CONTENT.home_hero.eyebrow, STRAPLINE);

// DEFERRED, NOT MISSED. Invoices and credit notes are rendered on demand, so a
// tagline change would restyle documents already issued. They keep the old
// tagline until a separate financial-document branding decision.
for (const f of ["components/invoice/InvoiceDocument.tsx", "components/invoice/CreditNoteDocument.tsx"]) {
  check(`${f}: tagline deliberately unchanged in SEO-5E`, read(f).includes("Woven in India · Worn for life"), true);
}

console.log("\n=== the journal index ===");
const journal = code("app/(storefront)/in/journal/page.tsx");
check("no \"our Kerala weavers\"", /our Kerala weavers/i.test(journal), false);
check("no \"Kerala loom\"", /Kerala loom/i.test(journal), false);
check("approved meta description",
  journal.includes('"Notes on fabric, craft, clothing care and the pieces we choose, from THE WOVENNE."'), true);
check("approved standfirst",
  journal.replace(/\s+/g, " ").includes("Notes on fabric and craft, how to care for what you own, and the pieces we choose."), true);

console.log("\n=== search suggests terms the catalogue answers ===");
const searchPage = read("app/(storefront)/in/search/page.tsx");
const searchField = read("components/shop/SearchField.tsx");
check("search page hint", searchPage.includes("Try a fabric, a detail, or a kind of piece — saree, mul cotton, zari."), true);
check("search field placeholder", searchField.includes('placeholder="Saree, mul cotton, zari…"'), true);
check("no zero-result examples", /linen|indigo/i.test(searchPage + searchField), false);

console.log("\n=== checkout success names no product or fabric ===");
const success = read("app/(storefront)/in/checkout/success/page.tsx");
check("no \"your linen\"", /your linen/i.test(success), false);
check("no loom", /\bloom\b/i.test(success), false);
check("approved sentence", success.replace(/\s+/g, " ").includes("Your order is one step closer to its journey to your door."), true);

console.log("\n=== the AI prompts describe the shop as it is ===");
// The prompt the model actually receives, built both ways a customer can
// arrive — not the source text around it.
const prompt = buildSystemPrompt("- Parrot Green Mul Cotton Saree (parrot-green-mul-cotton-saree)", null, false);
const signedInPrompt = buildSystemPrompt("", "Order WOV-1", true);
check("prompt built", prompt.length > 500, true);
check("signed-in prompt carries the same truthfulness block",
  signedInPrompt.includes("TRUTHFULNESS — these outrank everything above them"), true);
check("chat: no stale identity", staleIn(prompt), []);
check("chat: not a linen label", /selling authentic, handcrafted Indian linen/i.test(prompt), false);
check("chat: no \"OG product\" promise", /OG product/.test(prompt), false);
check("chat: curated clothing + saree label", prompt.includes("a curated clothing and saree label"), true);
check("chat: small jewellery range", prompt.includes("small selected jewellery range"), true);
check("chat: product data overrides the brand",
  /product data your tools return is the truth[\s\S]*overrides any description of the brand/.test(prompt), true);
check("chat: no linen unless the product says so", prompt.includes("There is no linen in the shop unless a product's own fabric field says linen"), true);
check("chat: jewellery is not a textile", prompt.includes("Jewellery is not a textile"), true);
check("chat: never invent material or origin", prompt.includes("Never invent a material, composition, weave or origin"), true);
check("chat: handloom/Kerala/pure/100% are factual claims",
  prompt.includes('"Handloom", "Kerala", "pure" and "100%" are factual claims'), true);
check("chat: no scarcity marketing",
  /exclusive, rare, limited edition, selling fast or a last chance/.test(prompt), true);
check("chat: availability from tools", prompt.includes("Availability comes only from a tool call made now"), true);
check("chat: India only", prompt.includes("ships within India only"), true);
check("insights: no linen shop", /linen/i.test(INSIGHTS_SYSTEM), false);
check("insights: approved positioning",
  INSIGHTS_SYSTEM.startsWith("You are the analytics assistant for THE WOVENNE, a curated clothing, saree and jewellery shop based in Kerala, India. You are speaking to one of the owners inside their admin panel."), true);
const greeting = read("components/chat/AskWovenne.tsx");
check("AskWovenne: no UK shipping", /\bUK\b/.test(greeting), false);
check("AskWovenne: India shipping", greeting.includes("shipping within India"), true);

console.log("\n=== shipping default matches the policy ===");
check("note", DEFAULT_SHIPPING.note, "₹99 in Kerala, ₹129 elsewhere in India, free on orders of ₹3,000 or more.");
check("rates behind it", [DEFAULT_SHIPPING.flat_rate_inr, DEFAULT_SHIPPING.regional_rates[0].rate_inr, DEFAULT_SHIPPING.free_above_inr], [129, 99, 3000]);

// ════════════════════════════════════════════════════════════════════
console.log("\n=== CMS draft planners (what --apply would write) ===");
const hero = planHero({ eyebrow: "Woven in India · Worn for life", heading: "X", subheading: "linen", cta_label: "Shop", cta_href: "/in/shop" }).next;
check("hero: text replaced, CTA kept", hero, {
  eyebrow: "Chosen piece by piece.", heading: "THE WOVENNE",
  subheading: "A considered selection of clothing, sarees and jewellery.", cta_label: "Shop", cta_href: "/in/shop",
});
check("why us: linen title becomes the approved one", planWhyUs({ title: "Why linen", cards: [] }).next.title, "Why Us");
check("why us: any other title becomes the approved one too", planWhyUs({ title: "Why us", cards: [] }).next.title, "Why Us");
check("why us: cards replaced", planWhyUs({ title: "Why linen", cards: [{ title: "Kinder to the earth", text: "Flax" }] }).next.cards, WHY_US_CARDS);

// The link exactly as production stores it (read from the live homepage after
// #154), and the section around it as the lookbook editor shapes it.
const LIVE_LOOKBOOK_HREF = "https://www.thewovenne.com/in/women/sarees/mul-cotton";
const look = {
  sections: [
    { id: "a", enabled: true, layout: "split-2", images: [
      { image_url: "u1", image_url_mobile: "u1m", href: LIVE_LOOKBOOK_HREF, alt: "" },
      { image_url: "u2", image_url_mobile: "", href: "/in/shop", alt: "Shop" },
    ] },
  ],
};
type Look = typeof look;
const withHref = (href: string): Look => ({
  sections: [{ ...look.sections[0], images: [{ ...look.sections[0].images[0], href }, look.sections[0].images[1]] }],
});
const lookNext = planLookbook(look).next as Look;
check("lookbook: the live absolute URL is recognised and repointed", lookNext.sections[0].images[0].href, LOOKBOOK_HREF);
check("lookbook: the destination is exactly the approved relative path", LOOKBOOK_HREF, "/women/sarees/parrot-green-mul-cotton-saree");
check("lookbook: relative so adminHref adds /in", LOOKBOOK_HREF.startsWith("/in/"), false);
check("lookbook: approved alt", lookNext.sections[0].images[0].alt, "Parrot green handloom mul cotton saree");
check("lookbook: the image's other fields untouched",
  { ...lookNext.sections[0].images[0], href: null, alt: null }, { ...look.sections[0].images[0], href: null, alt: null });
check("lookbook: other images untouched", lookNext.sections[0].images[1], look.sections[0].images[1]);
check("lookbook: section id, layout and enabled untouched",
  { ...lookNext.sections[0], images: null }, { ...look.sections[0], images: null });
check("lookbook: the input is not mutated", look.sections[0].images[0].href, LIVE_LOOKBOOK_HREF);

console.log("\n=== lookbook: equivalent spellings of the SAME link are accepted ===");
for (const href of [
  "/in/women/sarees/mul-cotton",
  "/women/sarees/mul-cotton",
  "/in/women/sarees/mul-cotton/",
  "https://www.thewovenne.com/women/sarees/mul-cotton",
  "  https://www.thewovenne.com/in/women/sarees/mul-cotton  ",
]) {
  check(`accepted: ${JSON.stringify(href)}`, (planLookbook(withHref(href)).next as Look).sections[0].images[0].href, LOOKBOOK_HREF);
}
check("normalised path of the live URL", lookbookPath(LIVE_LOOKBOOK_HREF), "/women/sarees/mul-cotton");

console.log("\n=== lookbook: anything else is a refusal, not a guess ===");
for (const href of [
  "https://evil.example/in/women/sarees/mul-cotton",
  "https://www.thewovenne.com.evil.example/in/women/sarees/mul-cotton",
  "https://www.thewovenne.com@evil.example/in/women/sarees/mul-cotton",
  "//evil.example/in/women/sarees/mul-cotton",
  "/\\evil.example/in/women/sarees/mul-cotton",
  "http://www.thewovenne.com/in/women/sarees/mul-cotton",
  "https://thewovenne.vercel.app/in/women/sarees/mul-cotton",
  "https://www.thewovenne.com/in/women/sarees/mul-cotton?ref=x",
  "https://www.thewovenne.com/in/women/sarees/mul-cotton#top",
  "https://www.thewovenne.com/in/women/sarees/pink-border-handloom-mul-cotton-saree",
  "/in/women/sarees/mul-cotton-saree",
  "/in/men/shirts/mul-cotton",
  "/mul-cotton",
  "/in/women/sarees/parrot-green-mul-cotton-saree",
  "javascript:alert(1)",
  "",
]) {
  throws(`refused: ${JSON.stringify(href)}`, () => planLookbook(withHref(href)));
}
throws("refuses when the link is not there", () => planLookbook({ sections: [] }));
throws("refuses two images carrying the link", () =>
  planLookbook({ sections: [{ ...look.sections[0], images: [look.sections[0].images[0], look.sections[0].images[0]] }] }));

check("shipping: only the note changes",
  planShipping({ flat_rate_inr: 129, free_above_inr: 3000, regional_rates: [], note: "Free in Kerala" }).next,
  { flat_rate_inr: 129, free_above_inr: 3000, regional_rates: [], note: "₹99 in Kerala, ₹129 elsewhere in India, free on orders of ₹3,000 or more." });
check("footer: stale description replaced",
  planFooter({ brand_description: "Woven in India. Worn for life. Authentic handloom linen … in the UK." })?.next.brand_description.startsWith("Chosen piece by piece."), true);
check("footer: clean description left alone", planFooter({ brand_description: "Chosen piece by piece." }), null);

const about = planAbout({
  body: [
    { type: "heading", text: "Our story" },
    { type: "paragraph", text: "THE WOVENNE works directly with handloom artisans across Kerala." },
    { type: "paragraph", text: "Every piece is chosen." },
  ],
});
check("about: meta", about.next.meta_description, ABOUT.meta_description);
check("about: intro", about.next.intro, "A considered selection of clothing, sarees and jewellery, chosen piece by piece rather than stocked for volume.");
check("about: opening paragraph replaced", about.next.body[1].text, ABOUT.opening);
check("about: other blocks untouched", [about.next.body[0], about.next.body[2]], [
  { type: "heading", text: "Our story" }, { type: "paragraph", text: "Every piece is chosen." },
]);
check("about: no supplier origin invented", /\bwoven\b|artisan|weaver|made in/i.test(ABOUT.opening + ABOUT.intro + ABOUT.meta_description), false);
throws("about: refuses if the opening is not the Kerala claim", () =>
  planAbout({ body: [{ type: "paragraph", text: "Something the owner wrote." }] }));

console.log("\n=== the draft script cannot touch a product ===");
// Stock on an unsized product lives on the version row, and publishing a
// draft copies the draft's stock over the live one — a product draft opened
// here could resurrect a sold qty-1 piece. So the script has no product path
// at all, and this pins that it stays that way.
const script = code("scripts/seo-5e-drafts.mjs");
check("no product table or RPC", /product_versions|product_images|product_sizes|ensure_product_draft|create_product_draft|\bproducts\b/.test(script), false);
check("no publish or discard RPC", /publish_one|publish_all|publish_site_content|discard_one|discard_drafts/.test(script), false);
check("no direct write to a published value", /set\s+value\s*=/.test(script), false);
check("page writes are pinned to draft rows", /where id = \$\$\{cols\.length \+ 1\} and state = 'draft'/.test(script), true);
check("content writes name draft_value only", /update site_content set draft_value = \$1::jsonb where key = \$2/.test(script), true);
check("the content targets are exactly the approved keys", CONTENT_KEYS, ["home_hero", "why_linen", "lookbook", "shipping", "footer"]);
check("the page targets are exactly About and Privacy", PAGE_SLUGS, ["about", "privacy-policy"]);
check("a named actor is required", /pass --as <your admin email>/.test(script), true);
check("dry run is the default", /process\.argv\.includes\("--apply"\)/.test(script), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
