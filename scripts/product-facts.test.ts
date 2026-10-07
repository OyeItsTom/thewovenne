/**
 * Product facts, held consistent across the page, the meta tags and the
 * Product markup (Natural Fabric programme, product facts + SEO completeness).
 *
 *   npx tsx scripts/product-facts.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHY THIS EXISTS. The audit behind it found every surface already agreeing
 * with the database on all 33 public product pages, and two places where a
 * stored fact was not shown faithfully:
 *
 *   - two descriptions are written as two paragraphs, and the page printed them
 *     as one run-on paragraph while the markup kept both;
 *   - the Admin form told the owner that an empty Care note makes the page show
 *     "the general advice for this fabric", which has not been true since
 *     SEO-6A removed every fallback (lib/care).
 *
 * The fixtures are the stored values of real products, copied from a read-only
 * export on 4 Oct 2026. They are inputs to pure functions here; nothing reads
 * or writes the database.
 *
 * It also pins the things this work deliberately did NOT do: no description is
 * composed for the 26 products without one, the Fabric value is the stored
 * sentence and not the shorter filter facet, and the two Tissue sarees still
 * say what is stored ("Cotton") until the owner answers.
 */
import fs from "node:fs";
import path from "node:path";
import { productDescriptionText, productMetaDescription } from "../lib/metadata";
import { breadcrumbNode, productNode } from "../lib/structuredData";
import { careFor } from "../lib/care";
import { effectivePrice } from "../lib/pricing";
import { stockState } from "../lib/stock";
import { productHref } from "../lib/urls";
import { openGraph } from "../lib/seo";
import { serializeJsonLd } from "../lib/jsonLd";

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
function ok(name: string, condition: boolean) {
  check(name, condition, true);
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── Fixtures: stored values, verbatim ─────────────────────────

interface Stored {
  slug: string;
  name: string;
  description: string | null;
  fabric: string | null;
  colour: string | null;
  price_inr: number;
  discount_type: "percent" | "flat" | null;
  discount_value: number | null;
  stock_quantity: number;
  parent: string;
  child: string;
  childName: string;
  parentName: string;
  care: string | null;
}

const FLORAL_DESCRIPTION =
  "A handloom pure cotton Kasavu saree in classic ivory, finished with a rich pure zari border with white and yellow floral embroidery. It adds a graceful contemporary touch while retaining the timeless elegance of traditional Kerala Kasavu.\n\nLight, elegant and beautifully understated, this saree is perfect for Onam, Vishu, weddings, temple occasions and festive celebrations.";

const STORED: Stored[] = [
  {
    slug: "floral-embroidered-handloom-cotton-kasavu-saree",
    name: "Floral Embroidered Handloom Cotton Kasavu Saree",
    description: FLORAL_DESCRIPTION,
    fabric: "Cotton",
    colour: "Off-white",
    price_inr: 1550,
    discount_type: null,
    discount_value: null,
    stock_quantity: 0,
    parent: "women",
    child: "sarees",
    parentName: "Women",
    childName: "Sarees",
    care: "Dry clean recommended to preserve the pure zari and embroidery. Store folded in a cool, dry place, preferably wrapped in soft cotton or muslin. Avoid direct contact with perfumes and moisture. Iron on low to medium heat from the reverse side and avoid ironing directly over the embroidery and zari.",
  },
  {
    slug: "black-line-border",
    name: "Black Line Border Saree",
    description: null,
    fabric: "Handloom 120 count mul cotton",
    colour: "Off-white",
    price_inr: 1399,
    discount_type: null,
    discount_value: null,
    stock_quantity: 1,
    parent: "women",
    child: "sarees",
    parentName: "Women",
    childName: "Sarees",
    care: null,
  },
  {
    slug: "tissue-elephant-emb",
    name: "Tissue Elephant Emb",
    description: null,
    fabric: "Cotton",
    colour: "Off-white",
    price_inr: 3299,
    discount_type: null,
    discount_value: null,
    stock_quantity: 1,
    parent: "women",
    child: "sarees",
    parentName: "Women",
    childName: "Sarees",
    care: null,
  },
  {
    slug: "tissue-fancy-red-thick-border",
    name: "Tissue Fancy - Red thick Border",
    description: null,
    fabric: "Cotton",
    colour: "Off-white",
    price_inr: 1599,
    discount_type: null,
    discount_value: null,
    stock_quantity: 1,
    parent: "women",
    child: "sarees",
    parentName: "Women",
    childName: "Sarees",
    care: null,
  },
  {
    slug: "couple-open-adjustable-detachable-ring",
    name: "Couple Ring | 14K Gold Plated | Adjustable Detachable Ring",
    description:
      "A detachable couple ring crafted from copper, 14K gold plated, with a synthetic cubic zirconia inlay.",
    fabric: null,
    colour: null,
    price_inr: 459,
    discount_type: "percent",
    discount_value: 15,
    stock_quantity: 1,
    parent: "jewellery",
    child: "rings",
    parentName: "Jewellery",
    childName: "Rings",
    care: null,
  },
];

const bySlug = (slug: string) => STORED.find((p) => p.slug === slug)!;

/** What ProductDetail + the route pass to each builder, mirrored. */
function surfaces(p: Stored) {
  const href = productHref({
    slug: p.slug,
    category_slug: p.child,
    category_parent_slug: p.parent,
  });
  const { price } = effectivePrice({
    price_inr: p.price_inr,
    discount_type: p.discount_type,
    discount_value: p.discount_value,
    discount_starts_at: null,
    discount_ends_at: null,
  } as Parameters<typeof effectivePrice>[0]);
  const stock = stockState(p.stock_quantity, []);
  const node = productNode({
    name: p.name,
    href,
    images: ["https://www.thewovenne.com/_next/image?url=x&w=1200&q=75"],
    description: p.description,
    fabric: p.fabric,
    price,
    soldOut: stock.soldOut,
    rating: { average: null, total: 0 },
    priceValidUntil: null,
  });
  // Through the real serialiser, so pruning is part of what is checked.
  const ld = JSON.parse(serializeJsonLd(node)!);
  const meta = productMetaDescription({
    name: p.name,
    description: p.description,
    categoryName: p.childName,
    fabric: p.fabric,
  });
  const og = openGraph({ title: p.name, description: meta, path: href, images: ["x"], imageAlt: p.name });
  const visibleDescription = productDescriptionText(p.description);
  const crumbs = JSON.parse(
    serializeJsonLd(
      breadcrumbNode([
        { name: p.parentName, path: `/${p.parent}` },
        { name: p.childName, path: `/${p.parent}/${p.child}` },
        { name: p.name },
      ])
    )!
  );
  return { href, price, stock, ld, meta, og, visibleDescription, crumbs };
}

// ── Approved description reuse ────────────────────────────────

console.log("\nApproved description: the same text on the page and in the markup");
{
  const s = surfaces(bySlug("floral-embroidered-handloom-cotton-kasavu-saree"));
  check("page prints the stored description, paragraph break included", s.visibleDescription, FLORAL_DESCRIPTION);
  check("Product markup carries the same stored text", s.ld.description, FLORAL_DESCRIPTION);
  ok("meta description is drawn from it, collapsed to one line", Boolean(s.meta?.startsWith("A handloom pure cotton Kasavu saree")) && !s.meta!.includes("\n"));
  check("og:description is the meta description", s.og.description, s.meta);
}
{
  const s = surfaces(bySlug("couple-open-adjustable-detachable-ring"));
  check("jewellery: short description reused whole in meta", s.meta, bySlug("couple-open-adjustable-detachable-ring").description);
  check("jewellery: same text in the markup", s.ld.description, bySlug("couple-open-adjustable-detachable-ring").description);
}

// ── Missing description handling ──────────────────────────────

console.log("\nNo description: nothing composed for the page or the markup");
for (const slug of ["black-line-border", "tissue-elephant-emb", "tissue-fancy-red-thick-border"]) {
  const s = surfaces(bySlug(slug));
  check(`${slug}: page prints no description`, s.visibleDescription, null);
  ok(`${slug}: Product markup has no description`, !("description" in s.ld));
  ok(`${slug}: meta is the name + stored fabric stand-in`, s.meta!.startsWith(`${bySlug(slug).name} — ${bySlug(slug).fabric}`));
}
{
  check("whitespace-only description is no description on the page", productDescriptionText("  \n\n "), null);
  const node = JSON.parse(
    serializeJsonLd(
      productNode({
        name: "X",
        href: "/in/women/sarees/x",
        images: [],
        description: "  \n ",
        price: 1,
        soldOut: false,
        rating: { average: null, total: 0 },
      })
    )!
  );
  ok("…and none in the markup either: the two agree", !("description" in node));
  check("leading/trailing whitespace trimmed, inner breaks kept", productDescriptionText("\n One.\n\nTwo. \n"), "One.\n\nTwo.");
}

// ── Fabric fidelity + unresolved products ─────────────────────

console.log("\nFabric: the stored sentence, never the filter facet");
{
  const s = surfaces(bySlug("black-line-border"));
  check("material is the stored value, not \"Mul Cotton\"", s.ld.material, "Handloom 120 count mul cotton");
}
for (const slug of ["tissue-elephant-emb", "tissue-fancy-red-thick-border"]) {
  check(`${slug}: unresolved, still stored "Cotton" everywhere`, surfaces(bySlug(slug)).ld.material, "Cotton");
}
ok("jewellery has no material", !("material" in surfaces(bySlug("couple-open-adjustable-detachable-ring")).ld));
ok("no colour, size, origin or care property in Product markup", STORED.every((p) => {
  const ld = surfaces(p).ld;
  return !["color", "colour", "size", "countryOfOrigin", "countryOfAssembly", "review"].some((k) => k in ld);
}));

// ── Offer: price, currency, availability, URL ─────────────────

console.log("\nOffer: effective price, availability, canonical URL");
{
  const ring = surfaces(bySlug("couple-open-adjustable-detachable-ring"));
  check("ring: price is the discounted price (459 − 15%)", ring.ld.offers.price, 390);
  check("currency", ring.ld.offers.priceCurrency, "INR");
  check("ring: in stock", ring.ld.offers.availability, "https://schema.org/InStock");
  check("canonical path", ring.href, "/in/jewellery/rings/couple-open-adjustable-detachable-ring");
  check("Product url = Offer url = og:url", [ring.ld.url, ring.ld.offers.url], [ring.og.url, ring.og.url]);
  check("og image alt is the name", ring.og.images, [{ url: "x", alt: bySlug("couple-open-adjustable-detachable-ring").name }]);
  const floral = surfaces(bySlug("floral-embroidered-handloom-cotton-kasavu-saree"));
  check("stock 0: OutOfStock", floral.ld.offers.availability, "https://schema.org/OutOfStock");
  check("undiscounted: stored price", floral.ld.offers.price, 1550);
  check("brand", floral.ld.brand, { "@type": "Brand", name: "THE WOVENNE" });
}

// ── Breadcrumb ────────────────────────────────────────────────

console.log("\nBreadcrumb markup matches the visible trail");
{
  const s = surfaces(bySlug("black-line-border"));
  check(
    "three crumbs, last one the page, unlinked",
    s.crumbs.itemListElement.map((c: { name: string; item?: string }) => [c.name, c.item ?? null]),
    [
      ["Women", "https://www.thewovenne.com/in/women"],
      ["Sarees", "https://www.thewovenne.com/in/women/sarees"],
      ["Black Line Border Saree", null],
    ]
  );
}

// ── Heritage / Craft / Care ───────────────────────────────────

console.log("\nCare: only what was written for the piece");
check("written note is shown verbatim", careFor({ careNote: bySlug("floral-embroidered-handloom-cotton-kasavu-saree").care }), {
  source: "written",
  text: bySlug("floral-embroidered-handloom-cotton-kasavu-saree").care,
});
check("no note: no care at all (no fabric fallback)", careFor({ careNote: null }), null);
check("blank note: no care at all", careFor({ careNote: "   " }), null);

// ── Source: what the page and the Admin actually say ──────────

console.log("\nSource checks");
const detail = read("components/product/ProductDetail.tsx");
ok("PDP prints the trimmed description through productDescriptionText", detail.includes("const description = productDescriptionText(product.description);"));
ok("PDP description keeps owner paragraph breaks (whitespace-pre-line)", /whitespace-pre-line[^"]*"\s*>\s*\{description\}/.test(detail));
ok("PDP no longer prints the raw column", !detail.includes("{product.description}"));
ok("Product markup still takes the stored description, not a composed one", detail.includes("description: product.description,"));
ok("Product markup still takes the stored fabric", detail.includes("fabric: product.fabric,"));
ok("visible Fabric row prints the stored value",
  detail.includes("fabric: product.fabric,") && read("components/product/ProductReassurance.tsx").includes("{row.value}"));

const modal = read("components/admin/ProductModal.tsx");
ok("Admin no longer promises general fabric care advice", !/general (fabric care )?advice/.test(modal));
ok("Admin says an empty note means no care advice", modal.includes("Empty: the product page shows no care advice for this piece."));

const panel = read("components/product/BrandKnowledgePanel.tsx");
ok("Heritage/Craft panel renders nothing when neither note exists", panel.includes("if (!heritage && !craft) return null;"));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
