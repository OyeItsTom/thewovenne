/**
 * Product information foundation (migration 0065) — the parts that need no
 * database: the field matrix, the completeness figure, the publish blockers,
 * SEO custom-vs-fallback, alt text, the fact rows the page and the markup
 * share, and the wiring that carries each field from the form to the page.
 *
 *   npx tsx scripts/product-info.test.ts
 *
 * The database half — the publish rule itself, draft/live carry-through, RLS,
 * and agreement between this file's rules and the SQL — is
 * scripts/product-info-db.test.ts. Exits non-zero on failure.
 */
import fs from "node:fs";
import {
  PRODUCT_PROFILES,
  altTextAdvice,
  assessProductInfo,
  effectiveProfile,
  fieldLabel,
  fieldLevel,
  productFactRows,
  publishBlockedMessage,
  publishBlockers,
  type InfoInput,
  type ProductProfile,
} from "../lib/productInfo";
import { PRODUCT_TITLE_SUFFIX, productSeo, productMetaDescription } from "../lib/metadata";
import { productNode } from "../lib/structuredData";
import { prune, serializeJsonLd } from "../lib/jsonLd";
import { productImageAlt } from "../lib/seo";
import { withLiveNote } from "../lib/adminStatus";
import { ADMIN_ONLY_SELECT, BRAND_KNOWLEDGE_SELECT, PRODUCT_SELECT, mapAdminProduct, mapBrandKnowledge, mapProduct } from "../lib/products";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`}`);
}
const read = (p: string) => fs.readFileSync(p, "utf8");

const EMPTY: InfoInput = {
  profile: "saree", name: "", slug: "", price: "", hasCategory: false, description: "",
  fabric: "", colour: "", dimensions: "", blouse_piece: "", finish: "", weave: "", origin: "",
  heritage: "", craft: "", care: "", fit: "", images: [], seo_title: "", meta_description: "",
};
const BASIC: InfoInput = {
  ...EMPTY, name: "Red Saree", slug: "red-saree", price: "2500", hasCategory: true,
  images: [{ url: "a.jpg", alt: "" }],
};

console.log("\n=== the matrix: category-aware levels ===");
check("five product types", PRODUCT_PROFILES.map((p) => p.value), ["saree", "drape", "garment", "jewellery", "general"]);
check("saree: fabric, colour, care required; dimensions, blouse piece recommended; origin, weave optional; fit and finish n/a",
  (["fabric", "colour", "care", "dimensions", "blouse_piece", "origin", "weave", "fit", "finish"] as const).map((k) => fieldLevel(k, "saree")),
  ["required", "required", "required", "recommended", "recommended", "optional", "optional", "na", "na"]);
check("garment: fit recommended, no blouse piece, dimensions optional",
  (["fit", "blouse_piece", "dimensions", "colour"] as const).map((k) => fieldLevel(k, "garment")), ["recommended", "na", "optional", "required"]);
check("jewellery: material required (labelled Material), colour optional, finish + dimensions recommended, no weave",
  [fieldLevel("fabric", "jewellery"), fieldLabel("fabric", "jewellery"), fieldLevel("colour", "jewellery"),
   fieldLevel("finish", "jewellery"), fieldLevel("dimensions", "jewellery"), fieldLevel("weave", "jewellery")],
  ["required", "Material", "optional", "recommended", "recommended", "na"]);
check("drape (dhoti): like a saree without a blouse piece",
  [fieldLevel("fabric", "drape"), fieldLevel("colour", "drape"), fieldLevel("blouse_piece", "drape")], ["required", "required", "na"]);
check("general: only care is required among the facts",
  (["fabric", "colour", "care"] as const).map((k) => fieldLevel(k, "general")), ["recommended", "recommended", "required"]);
for (const p of PRODUCT_PROFILES.map((x) => x.value)) {
  check(`${p}: origin, heritage, craft, SEO title and meta description are optional — never forced`,
    (["origin", "heritage", "craft", "seo_title", "meta_description"] as const).map((k) => fieldLevel(k, p)),
    ["optional", "optional", "optional", "optional", "optional"]);
  check(`${p}: care and main image alt text are required`, [fieldLevel("care", p), fieldLevel("cover_alt", p)], ["required", "required"]);
}

console.log("\n=== effective type: own, else parent, else general ===");
const cats = [
  { id: "women", parent_id: null, product_profile: "garment" as ProductProfile },
  { id: "sarees", parent_id: "women", product_profile: "saree" as ProductProfile },
  { id: "dresses", parent_id: "women", product_profile: null },
  { id: "jewellery", parent_id: null, product_profile: "jewellery" as ProductProfile },
  { id: "rings", parent_id: "jewellery", product_profile: null },
  { id: "misc", parent_id: null, product_profile: null },
  { id: "misc-child", parent_id: "misc", product_profile: null },
];
check("own type wins", effectiveProfile("sarees", cats), "saree");
check("null inherits the parent", [effectiveProfile("dresses", cats), effectiveProfile("rings", cats)], ["garment", "jewellery"]);
check("no type anywhere, unknown or no category: general",
  [effectiveProfile("misc-child", cats), effectiveProfile("nope", cats), effectiveProfile(null, cats)], ["general", "general", "general"]);

console.log("\n=== 1–3. drafts may be incomplete; publish blockers are exact ===");
const bare = assessProductInfo(BASIC);
check("a bare saree is not publishable, and says exactly why, in form order",
  [bare.publishable, bare.missingRequired], [false, ["Fabric", "Colour", "Care instructions", "Main image alt text"]]);
check("the database-enforced blockers are the same four", publishBlockers(BASIC), ["Fabric", "Colour", "Care instructions", "Main image alt text"]);
check("the blocked message is a sentence with one bullet per field",
  publishBlockedMessage("Red Saree", ["Fabric", "Care instructions"]),
  "Complete these before publishing “Red Saree”:\n• Fabric\n• Care instructions");
check("a nameless product is 'this product', as in SQL", publishBlockedMessage("  ", ["Colour"]).startsWith("Complete these before publishing “this product”"), true);
const done: InfoInput = { ...BASIC, fabric: "Cotton", colour: "Red", care: "Dry clean.", images: [{ url: "a.jpg", alt: "Red saree, draped" }] };
check("with the four filled in, it is publishable", [assessProductInfo(done).publishable, publishBlockers(done)], [true, []]);
check("whitespace is not a value", publishBlockers({ ...done, care: "   " }), ["Care instructions"]);
check("a hidden product is not judged at publish", publishBlockers({ ...BASIC, isActive: false }), []);
check("no photos: cover alt is not asked for (photos are their own requirement)",
  [publishBlockers({ ...done, images: [] }), assessProductInfo({ ...done, images: [] }).missingRequired], [[], ["At least one photo"]]);
check("jewellery blocks on Material only", publishBlockers({ ...BASIC, profile: "jewellery", care: "Keep dry.", images: [{ url: "a", alt: "Ring" }] }), ["Material"]);
check("general blocks on care only", publishBlockers({ ...BASIC, profile: "general", images: [{ url: "a", alt: "x" }] }), ["Care instructions"]);

console.log("\n=== completeness: weighted on useful facts only ===");
const full = assessProductInfo({ ...done, description: "A piece.", dimensions: "5.5 m", blouse_piece: "included" });
check("a saree with every required and recommended field is 100%", full.percent, 100);
check("…without knowing origin, weave or the story (optional is never counted)", [full.optional.map((i) => i.done)].flat().every((d) => !d), true);
const typedOrigin = assessProductInfo({ ...done, origin: "Kerala" });
check("typing an optional origin does not raise the percentage", typedOrigin.percent, assessProductInfo(done).percent);
check("publishable below 100% when only recommended things are missing",
  [assessProductInfo(done).publishable, assessProductInfo(done).percent < 100, assessProductInfo(done).missingRecommended],
  [true, true, ["Description", "Dimensions", "Blouse piece"]]);
check("a second photo with no alt text adds a recommended item, never a blocker",
  [assessProductInfo({ ...done, images: [...done.images, { url: "b", alt: "" }] }).missingRecommended.includes("Alt text on every photo"),
   publishBlockers({ ...done, images: [...done.images, { url: "b", alt: "" }] })], [true, []]);

console.log("\n=== 6–7. SEO: custom values and fallback ===");
const auto = productSeo({ name: "Red Saree", description: null, categoryName: "Sarees", fabric: "Cotton" });
check("blank: the title is the name plus the shop name, marked auto", [auto.title, auto.titleSource, auto.heading], ["Red Saree | THE WOVENNE", "auto", "Red Saree"]);
check("blank: the snippet is exactly what productMetaDescription composed before",
  [auto.description, auto.descriptionSource], [productMetaDescription({ name: "Red Saree", description: null, categoryName: "Sarees", fabric: "Cotton" }), "auto"]);
check("…which has not changed for an unwritten product (no regression)", auto.description, "Red Saree — Cotton. From THE WOVENNE, shipped across India.");
const custom = productSeo({ name: "Red Saree", description: "Long story.", seoTitle: "  Red handloom   cotton saree ", metaDescription: "A red cotton saree,\nwoven by hand." });
check("custom: used as written, whitespace collapsed, shop name added once",
  [custom.title, custom.titleSource, custom.heading], ["Red handloom cotton saree | THE WOVENNE", "custom", "Red handloom cotton saree"]);
check("custom: the snippet wins over the description", [custom.description, custom.descriptionSource], ["A red cotton saree, woven by hand.", "custom"]);
check("whitespace-only custom values fall back", [productSeo({ name: "X", description: "Words.", seoTitle: "  ", metaDescription: " " }).titleSource,
  productSeo({ name: "X", description: "Words.", seoTitle: "  ", metaDescription: " " }).description], ["auto", "Words."]);
check("the suffix is the brand", PRODUCT_TITLE_SUFFIX, " | THE WOVENNE");
for (const route of ["app/(storefront)/in/[slug]/[child]/[product]/page.tsx", "app/(storefront)/in/product/[slug]/page.tsx"]) {
  const src = read(route);
  check(`${route.split("/in/")[1]}: generateMetadata uses productSeo with the stored custom values`,
    [/productSeo\(\{[\s\S]*seoTitle: product\.seo_title,[\s\S]*metaDescription: product\.meta_description/.test(src), /title: seo\.title/.test(src),
     /title: seo\.heading/.test(src), /productMetaDescription\(\{/.test(src)], [true, true, true, false]);
}

console.log("\n=== 8. alt text ===");
check("written alt text is used as written", productImageAlt("Red Saree", 0, 3, "  Red saree, draped  "), "Red saree, draped");
check("blank falls back exactly as before (cover = name)", [productImageAlt("Red Saree", 0, 3, null), productImageAlt("Red Saree", 0, 3, " ")], ["Red Saree", "Red Saree"]);
check("later photos fall back to 'name — image i of n'", productImageAlt("Red Saree", 2, 3, ""), "Red Saree — image 3 of 3");
check("advice: a file name is flagged", altTextAdvice("IMG_2041.jpg", { productName: "Red", others: [] }) !== null, true);
check("advice: a duplicate of another photo's text is flagged", altTextAdvice("Red saree draped", { productName: "Red", others: ["red saree draped"] }) !== null, true);
check("advice: just the product name is flagged", altTextAdvice("Red Saree", { productName: "Red Saree", others: [] }) !== null, true);
check("advice: a real description passes, blank says nothing",
  [altTextAdvice("Close-up of the zari border", { productName: "Red Saree", others: ["Draped"] }), altTextAdvice("", { productName: "x", others: [] })], [null, null]);
const modal = read("components/admin/ProductModal.tsx");
check("the form writes alt_text with each photo, NULL when blank", /alt_text: photo\.alt\.trim\(\) \|\| null/.test(modal), true);
check("the form loads each photo's alt text from the draft gallery", /alt: p\.alt \?\? ""/.test(modal), true);
const gallery = read("components/product/ImageGallery.tsx");
check("the storefront gallery passes each photo's own alt", (gallery.match(/productImageAlt\(alt, i, images\.length, alts\?\.\[i\]\)/g) ?? []).length, 2);

console.log("\n=== 11. structured data: stored facts only, never empty ===");
const facts = productFactRows({ profile: "saree", fabric: "Handloom cotton", dimensions: " 5.5 m × 1.15 m ", blousePiece: "included",
  fit: "Relaxed", finish: "Gold plated", weave: "", origin: null });
check("fact rows: only stored, only applicable to the type, in order, trimmed",
  facts.map((f) => [f.label, f.value]), [["Fabric", "Handloom cotton"], ["Dimensions", "5.5 m × 1.15 m"], ["Blouse piece", "Included"]]);
check("jewellery says Material and Finish", productFactRows({ profile: "jewellery", fabric: "Brass", dimensions: null, blousePiece: "included",
  fit: null, finish: "14K gold plated", weave: "Handloom", origin: null }).map((f) => f.label), ["Material", "Finish"]);
const node = (f: typeof facts) => productNode({ name: "Red Saree", href: "/in/women/sarees/red-saree", images: [], description: null,
  price: 2500, soldOut: false, rating: { average: null, total: 0 }, fabric: "Handloom cotton", facts: f });
check("additionalProperty restates the rows (fabric stays in material, not repeated)",
  node(facts).additionalProperty, [{ "@type": "PropertyValue", name: "Dimensions", value: "5.5 m × 1.15 m" },
                                   { "@type": "PropertyValue", name: "Blouse piece", value: "Included" }]);
check("…material is the fabric row", node(facts).material, "Handloom cotton");
check("no facts: no additionalProperty key at all", Object.keys(prune(node([])) as object).includes("additionalProperty"), false);
check("a blank row never reaches the markup", node([{ key: "origin", label: "Origin", value: "  " }]).additionalProperty, undefined);
check("no colour property in the markup (stored colour is not yet reliable)", /"color"/.test(serializeJsonLd(node(facts)) ?? ""), false);
const detail = read("components/product/ProductDetail.tsx");
check("the page renders the SAME rows it hands the markup", [/facts\.map\(\(row\)/.test(detail), /\n\s+facts,\n/.test(detail)], [true, true]);

console.log("\n=== the field carries from form to database to page ===");
for (const col of ["dimensions", "blouse_piece", "fit_note", "finish", "weave", "origin", "seo_title", "meta_description"]) {
  check(`${col}: in the form state, the save payload and the saved-row select`,
    [new RegExp(`\\n  ${col}: "",`).test(modal), new RegExp(`\\n      ${col}: `).test(modal), modal.includes(`${col}, `) || modal.includes(`${col} `)],
    [true, true, true]);
}
check("seo_title and meta_description are on the storefront product query", ["seo_title", "meta_description"].every((c) => PRODUCT_SELECT.includes(c)), true);
check("the facts are NOT on the storefront listing query", ["dimensions", "origin", "weave"].some((c) => PRODUCT_SELECT.includes(c)), false);
check("the admin query and the knowledge read carry every fact",
  ["dimensions", "blouse_piece", "fit_note", "finish", "weave", "origin"].every((c) => ADMIN_ONLY_SELECT.includes(c) && BRAND_KNOWLEDGE_SELECT.includes(c)), true);
const row = { product_id: "p", name: "n", slug: "s", description: null, price_inr: 1, category_id: null, fabric: null, colour: null,
  stock_quantity: 1, image_url: null, is_active: true, created_at: "", collection: null, discount_type: null, discount_value: null,
  discount_starts_at: null, discount_ends_at: null, video_youtube_id: null, seo_title: "T", meta_description: "M" };
check("mapProduct copies the SEO columns (the allow-list)", [mapProduct(row, new Map()).seo_title, mapProduct(row, new Map()).meta_description], ["T", "M"]);
const admin = mapAdminProduct({ ...row, state: "draft", pending_delete: false, cost_price_inr: null, sku: null, heritage_note: null,
  craft_note: null, care_note: null, dimensions: "D", blouse_piece: "not_included", fit_note: "F", finish: "Fi", weave: "W", origin: "O" }, new Map());
check("mapAdminProduct copies every fact, so opening a product never blanks one on save",
  [admin.dimensions, admin.blouse_piece, admin.fit_note, admin.finish, admin.weave, admin.origin], ["D", "not_included", "F", "Fi", "W", "O"]);
check("mapBrandKnowledge reads the facts, trims, and drops a bad blouse value",
  mapBrandKnowledge({ product_id: "p", name: "n", slug: "s", heritage_note: null, craft_note: null, care_note: null,
    dimensions: " 5 m ", blouse_piece: "maybe", fit_note: null, finish: null, weave: "", origin: "Kerala" }).facts,
  { dimensions: "5 m", blousePiece: null, fit: null, finish: null, weave: null, origin: "Kerala" });

console.log("\n=== 13. the #181 save/publish wording is kept ===");
check("the button still says Save draft", /\{saving \? "Saving draft…" : "Save draft"\}/.test(modal), true);
check("the saved message is still draftSavedMessage, with the blockers appended only when there are some",
  [/draftSavedMessage\(\{ noun: "product"/.test(modal), /blockers\.length \? ` Before it can be published, complete:/.test(modal)], [true, true]);
check("a single-line refusal keeps the note on the same line", withLiveNote("Publish its category first."), "Publish its category first. Customers still see the previous live version.");
check("a bulleted refusal gets the note as its own paragraph", withLiveNote("Complete these:\n• Fabric"), "Complete these:\n• Fabric\n\nCustomers still see the previous live version.");
check("both publish surfaces render line breaks", [/whitespace-pre-line/.test(read("components/admin/PublishBar.tsx")), /whitespace-pre-line/.test(read("components/admin/PublishQueue.tsx"))], [true, true]);

console.log("\n=== migration 0065 is the next one and touches no AI object ===");
const migs = fs.readdirSync("supabase/migrations").filter((f) => /^\d{4}_/.test(f));
check("0065 exists once", migs.filter((f) => f.startsWith("0065_")), ["0065_product_information.sql"]);
const sql = read("supabase/migrations/0065_product_information.sql");
check("0065 adds no AI table, function or column", /\b(ai_|chat_|eval_)\w+/.test(sql), false);
check("0065 backfills no product fact", /update\s+public\.product_versions/i.test(sql), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
