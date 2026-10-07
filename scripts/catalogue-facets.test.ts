/**
 * Facet hygiene (Natural Fabric PR #175): what a customer browses by, which
 * filter groups are worth showing, and sizes that only make sense inside one
 * kind of thing.
 *
 *   npx tsx scripts/catalogue-facets.test.ts
 *
 * Exits non-zero on failure. No database is touched: the real query functions
 * run against an in-memory PostgREST double, and the real panel is rendered
 * with react-dom/server.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FABRIC_FACETS,
  colourOptions,
  fabricFacet,
  fabricOptions,
  matchesColour,
  matchesFabric,
  narrowingOptions,
  singleSubCategory,
  sizeGroupTitle,
} from "../lib/catalogueFacets";
import { NO_FILTERS, type CatalogueFilters } from "../lib/catalogueParams";
import { availableSizes, matchesFilters } from "../lib/productFilters";
import { facetOptionsFor, filterEffectiveCatalogueRows, getCatalogue } from "../lib/products";
import type { ReadCtx } from "../lib/readCtx";
import type { Category, Product } from "../lib/types";
import FilterSidebar, {
  groupSummary,
  hasFilterOptions,
  panelGroups,
  type FilterOptions,
} from "../components/shop/FilterSidebar";

(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}`);
  if (good) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, condition: boolean) => check(name, condition, true);
const read = (p: string) => fs.readFileSync(p, "utf8");

// The three stored values the PR #174 audit found, exactly as stored.
const COTTON = "Cotton";
const MUL = "Handloom 120 count mul cotton";
const TISSUE = "Tissue Cotton";

// ── 1. the fabric map ────────────────────────────────────────────────────────

console.log("\n=== stored fabric → browsing facet ===");
check("Cotton → Cotton", fabricFacet(COTTON), "Cotton");
check("Handloom 120 count mul cotton → Mul Cotton", fabricFacet(MUL), "Mul Cotton");
check("Tissue Cotton → Tissue Cotton", fabricFacet(TISSUE), "Tissue Cotton");
check("case and spacing do not matter", fabricFacet("  handloom  120 COUNT mul   cotton "), "Mul Cotton");
check("no fabric (jewellery) → no facet", [fabricFacet(null), fabricFacet(""), fabricFacet("   ")], [null, null, null]);
check("an unknown value passes through as typed", fabricFacet("Pure Linen"), "Pure Linen");
check("NOT a pattern: a value merely containing 'mul cotton' is left alone",
  fabricFacet("Mul cotton blend with silk"), "Mul cotton blend with silk");
check("NOT a pattern: plain Cotton is never folded into Mul Cotton", fabricFacet("cotton"), "Cotton");
check("the facets, in their order", [...FABRIC_FACETS], ["Cotton", "Mul Cotton", "Tissue Cotton"]);
check("options from the live catalogue's values: three facets in fixed order",
  fabricOptions([MUL, COTTON, TISSUE, MUL, COTTON, null, null]), ["Cotton", "Mul Cotton", "Tissue Cotton"]);
check("unknown facets follow the known ones alphabetically",
  fabricOptions(["Silk", MUL, "Khadi", COTTON]), ["Cotton", "Mul Cotton", "Khadi", "Silk"]);
check("colours: distinct without regard to case, alphabetical",
  colourOptions(["Off-white", "off-white ", "Red", "Parrot Green", null, "Violet"]), ["Off-white", "Parrot Green", "Red", "Violet"]);

console.log("\n=== matching by facet ===");
ok("Mul Cotton matches the stored sentence", matchesFabric(MUL, ["Mul Cotton"]));
ok("the stored sentence as a choice (an old link) matches too", matchesFabric(MUL, [MUL]));
ok("Mul Cotton does not match plain Cotton", !matchesFabric(COTTON, ["Mul Cotton"]));
ok("Cotton does not match Mul Cotton or Tissue Cotton", !matchesFabric(MUL, ["Cotton"]) && !matchesFabric(TISSUE, ["Cotton"]));
ok("any of several (Cotton or Mul Cotton)", matchesFabric(COTTON, ["Cotton", "Mul Cotton"]) && matchesFabric(MUL, ["Cotton", "Mul Cotton"]));
ok("no fabric never matches a chosen fabric", !matchesFabric(null, ["Cotton"]));
ok("no choice matches everything, jewellery included", matchesFabric(null, []) && matchesFabric(MUL, []));
ok("colours: case-insensitive, any of several", matchesColour("Off-white", ["red", "OFF-WHITE"]) && !matchesColour("Violet", ["Red"]));
ok("colours: none recorded never matches a chosen colour", !matchesColour(null, ["Red"]));

// ── 2. product data is not touched ───────────────────────────────────────────

console.log("\n=== stored values stay exactly as stored ===");
{
  const product = { fabric: MUL, colour: "Off-white" };
  const before = JSON.stringify(product);
  fabricFacet(product.fabric);
  matchesFabric(product.fabric, ["Mul Cotton"]);
  fabricOptions([product.fabric]);
  check("mapping reads a product, never changes it", JSON.stringify(product), before);
}
const facetsSrc = read("lib/catalogueFacets.ts");
ok("the facet module has no database, network or write path",
  !/supabase|fetch\(|\.update\(|\.insert\(|\.upsert\(|\.rpc\(/.test(facetsSrc) && !/^import /m.test(facetsSrc));
ok("the product page still prints the stored fabric itself",
  // Since #187 the fabric row is rendered by ProductReassurance from productFactRows.
  read("components/product/ProductDetail.tsx").includes("fabric: product.fabric,") &&
  read("components/product/ProductReassurance.tsx").includes("{row.value}") &&
  !read("components/product/ProductDetail.tsx").includes("catalogueFacets"));
ok("JSON-LD material is still the stored fabric, untouched",
  read("lib/structuredData.ts").includes("material: input.fabric?.trim() || undefined") &&
  !read("lib/structuredData.ts").includes("catalogueFacets"));
ok("meta descriptions and Ask Wovenne still read the stored fabric",
  !read("lib/metadata.ts").includes("catalogueFacets") && !read("lib/chatTools.ts").includes("catalogueFacets"));
// An invariant, not a pinned number: facets are derived in code, so no
// migration — present or future — should be about them.
ok("no migration ships with this change",
  !fs.readdirSync("supabase/migrations").some((f) => /facet/i.test(f) || /facet/i.test(read(`supabase/migrations/${f}`))));

// ── 3. group eligibility ─────────────────────────────────────────────────────

console.log("\n=== a group shows only if it can narrow ===");
check("0 options: hidden", narrowingOptions([]), []);
check("1 option: hidden (a no-op)", narrowingOptions(["Cotton"]), []);
check("2 options: shown", narrowingOptions(["Cotton", "Mul Cotton"]), ["Cotton", "Mul Cotton"]);
check("1 option that is already CHOSEN stays, so it can be undone", narrowingOptions(["Cotton"], ["Cotton"]), ["Cotton"]);
check("a chosen value no longer offered is kept on show", narrowingOptions(["Cotton", "Mul Cotton"], ["Silk"]), ["Cotton", "Mul Cotton", "Silk"]);
check("…matched without regard to case", narrowingOptions(["Cotton", "Red"], ["cotton"]), ["Cotton", "Red"]);

const NOTHING: FilterOptions = { categoryGroups: [], fabrics: [], colours: [], sizes: [], priceRange: null, availability: false };

// The live catalogue, by listing (PR #174 inventory).
const DHOTI: FilterOptions = { ...NOTHING, fabrics: fabricOptions([COTTON]), colours: colourOptions([null]) };
check("Men/Dhoti: Fabric 'Cotton' alone is not offered", panelGroups(DHOTI).fabrics, []);
ok("Men/Dhoti: with nothing else to choose, no panel at all", !hasFilterOptions(DHOTI));
const JEWELLERY: FilterOptions = {
  ...NOTHING, fabrics: fabricOptions([null, null]), colours: colourOptions([null, null]),
  priceRange: { min: 400, max: 600, step: 100, lowest: 390, highest: 559 },
};
check("Jewellery: no Fabric group (no fabric data)", panelGroups(JEWELLERY).fabrics, []);
check("Jewellery: no Colour group", panelGroups(JEWELLERY).colours, []);
ok("Jewellery: Price still narrows (₹390 ring vs ₹559 necklace)", panelGroups(JEWELLERY).price !== null);
const SAREES: FilterOptions = {
  ...NOTHING, availability: true,
  fabrics: fabricOptions([COTTON, MUL, TISSUE, MUL]),
  colours: colourOptions(["Off-white", "Parrot Green", "Red", "Violet"]),
};
check("Sarees: Fabric offers the three facets", panelGroups(SAREES).fabrics, ["Cotton", "Mul Cotton", "Tissue Cotton"]);
check("Sarees: Colour offers the four colours", panelGroups(SAREES).colours.length, 4);
const ONE_SHELF: FilterOptions = { ...NOTHING, categoryGroups: [{ name: "Men", children: [{ name: "Dhoti", slug: "dhotis" }] }] };
check("Category with a single shelf is a no-op too", panelGroups(ONE_SHELF).categoryGroups, []);
check("…unless it is the one chosen", panelGroups(ONE_SHELF, { ...NO_FILTERS, category: "dhotis" }).categoryGroups.length, 1);
ok("Availability shown only when offered (some sold out, some not)", !panelGroups(NOTHING).availability && panelGroups(SAREES).availability);
ok("…or when already chosen from a link", panelGroups(NOTHING, { ...NO_FILTERS, inStock: true }).availability);

console.log("\n=== collapsed summaries ===");
check("nothing chosen: no summary", groupSummary([]), null);
check("one chosen: its name", groupSummary(["Mul Cotton"]), "Mul Cotton");
check("several chosen: a count, never a list", groupSummary(["Cotton", "Mul Cotton"]), "2 selected");
check("five chosen: still a count", groupSummary(["a", "b", "c", "d", "e"]), "5 selected");

// ── 4. sizes are category-aware ──────────────────────────────────────────────

console.log("\n=== sizes only inside one sub-category ===");
const p = (id: string, slug: string, name: string) =>
  ({ id, category_slug: slug, category: name } as Pick<Product, "id" | "category_slug" | "category">);
const RING = p("ring", "rings", "Rings");
const NECKLACE = p("tennis", "necklace", "Necklace");
const SAREE = p("saree", "sarees", "Sarees");
const SIZES = { ring: [{ id: "s", product_id: "ring", label: "6", sort_order: 0, stock_quantity: 1, created_at: "" }] };
check("the whole shop spans several sub-categories: no size scale", singleSubCategory([RING, NECKLACE, SAREE]), null);
check("Jewellery (rings + necklace): still no single scale", singleSubCategory([RING, NECKLACE]), null);
check("Rings alone: one sub-category", singleSubCategory([RING]), { slug: "rings", name: "Rings" });
check("an empty listing has no sub-category", singleSubCategory([]), null);
check("Ring size inside Rings", sizeGroupTitle("Rings"), "Ring size");
check("plain Size anywhere else", [sizeGroupTitle("Shirts"), sizeGroupTitle(null), sizeGroupTitle("Earrings")], ["Size", "Size", "Size"]);
// What CategoryFilters computes for each listing.
const sizesFor = (products: Pick<Product, "id" | "category_slug" | "category">[]) =>
  singleSubCategory(products) ? availableSizes(products, SIZES) : [];
check("the ring's 6 never reaches the shop-wide Size filter", sizesFor([RING, NECKLACE, SAREE]), []);
check("…nor the Jewellery section's", sizesFor([RING, NECKLACE]), []);
check("inside Rings it is offered as a ring size", sizesFor([RING]), ["6"]);
const RINGS_PANEL: FilterOptions = { ...NOTHING, sizes: sizesFor([RING]), sizeTitle: sizeGroupTitle("Rings") };
check("…but ONE ring size cannot narrow one ring, so the group stays hidden today", panelGroups(RINGS_PANEL).sizes, []);
check("with a second size in stock it would appear", panelGroups({ ...RINGS_PANEL, sizes: ["6", "7"] }).sizes, ["6", "7"]);
ok("the size record itself is only read", !/product_sizes[\s\S]{0,80}\.(update|delete|insert|upsert)\(/.test(read("lib/catalogueFacets.ts") + read("lib/productFilters.ts")));
ok("the shop offers sizes only once a sub-category is chosen",
  read("components/shop/ShopFilters.tsx").includes("sizes: sizeScope ? availableSizes(products, sizesByProduct) : []") &&
  read("app/(storefront)/in/shop/page.tsx").includes("sizeScope={chosenCategory?.name ?? null}"));
ok("a sub-category/section page offers sizes only when it is one sub-category",
  read("components/shop/CategoryFilters.tsx").includes("sizes: only ? availableSizes(products, sizesByProduct) : []"));
{
  // A ?size=6 link on the shop still filters (the URL means what it says) and
  // its chip can still be removed — it is just never OFFERED there.
  const chosen = panelGroups(NOTHING, { ...NO_FILTERS, size: "6" });
  check("a size from a shared link stays visible, chosen, so it can be undone", chosen.sizes, ["6"]);
}

// ── 5. filtering, both paths ─────────────────────────────────────────────────

console.log("\n=== filtering by facet: client path ===");
const item = (id: string, fabric: string | null, colour: string | null) =>
  ({ id, fabric, colour, price_inr: 1000, stock_quantity: 1, category_slug: "sarees", discount_type: null,
     discount_value: null, discount_starts_at: null, discount_ends_at: null } as unknown as Product);
const SHELF = [item("c1", COTTON, "Off-white"), item("m1", MUL, "Off-white"), item("m2", MUL, "Violet"),
  item("t1", TISSUE, "Off-white"), item("j1", null, null)];
const run = (f: CatalogueFilters) => SHELF.filter((x) => matchesFilters(x, f, {})).map((x) => x.id);
check("Mul Cotton → both mul sarees", run({ ...NO_FILTERS, fabric: ["Mul Cotton"] }), ["m1", "m2"]);
check("Cotton + Mul Cotton → union", run({ ...NO_FILTERS, fabric: ["Cotton", "Mul Cotton"] }), ["c1", "m1", "m2"]);
check("Mul Cotton AND Violet → one", run({ ...NO_FILTERS, fabric: ["Mul Cotton"], colour: ["Violet"] }), ["m2"]);
check("Tissue Cotton → the one stored as Tissue Cotton only", run({ ...NO_FILTERS, fabric: ["Tissue Cotton"] }), ["t1"]);
check("zero results is possible and honest", run({ ...NO_FILTERS, fabric: ["Tissue Cotton"], colour: ["Violet"] }), []);

console.log("\n=== filtering by facet: preview path ===");
{
  const rows = SHELF.map((x) => ({ product_id: x.id, state: "published", is_active: true, category_id: "sarees",
    stock_quantity: 1, price_inr: 1000, fabric: x.fabric, colour: x.colour })) as never[];
  const cats = new Map<string, Category>([["sarees", { id: "sarees", slug: "sarees" } as Category]]);
  const ids = (f: Parameters<typeof filterEffectiveCatalogueRows>[1]) =>
    filterEffectiveCatalogueRows(rows, f, ["sarees"], cats, null).map((r: { product_id: string }) => r.product_id);
  check("preview: Mul Cotton", ids({ fabric: ["Mul Cotton"] }), ["m1", "m2"]);
  check("preview: a bare string is a one-item list (older callers)", ids({ fabric: "Mul Cotton" }), ["m1", "m2"]);
  check("preview: the legacy stored sentence still matches", ids({ fabric: MUL }), ["m1", "m2"]);
  check("preview: an empty list filters nothing", ids({ fabric: [] }).length, 5);
}

console.log("\n=== filtering by facet: database path ===");
type Row = Record<string, unknown>;
class Q implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  gt(c: string, v: number) { this.filters.push((r) => (r[c] as number) > v); return this; }
  order() { return this; }
  range() { return this; }
  then<A = { data: Row[]; error: null }, B = never>(
    ok1?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    ko?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows.filter((r) => this.filters.every((f) => f(r))), error: null }).then(ok1, ko);
  }
}
const CATS: Row[] = [
  { category_id: "women", state: "published", name: "Women", slug: "women", parent_id: null, is_visible: true, sort_order: 0, created_at: "2026-01-01" },
  { category_id: "sarees", state: "published", name: "Sarees", slug: "sarees", parent_id: "women", is_visible: true, sort_order: 1, created_at: "2026-01-01" },
];
const LISTING: Row[] = SHELF.map((x, i) => ({
  product_id: x.id, state: "published", is_active: true, category_id: "sarees", name: x.id, slug: x.id,
  price_inr: 1000 + i, stock_quantity: 2, image_url: null, created_at: "2026-01-01", fabric: x.fabric, colour: x.colour,
  discount_type: null, discount_value: null, discount_starts_at: null, discount_ends_at: null,
  product_images: [], products: { created_at: `2026-01-0${9 - i}` },
}));
const ctx: ReadCtx = {
  client: { from: (t: string) => new Q(t === "category_versions" ? CATS : LISTING) } as unknown as SupabaseClient,
  preview: false,
};

console.log("\n=== facet options for a scope ===");
const FACET_ROWS = [
  { fabric: COTTON, colour: null, category_id: "dhotis" },
  { fabric: MUL, colour: "Off-white", category_id: "sarees" },
  { fabric: TISSUE, colour: "Violet", category_id: "sarees" },
  { fabric: null, colour: null, category_id: "rings" },
];
check("the whole shop", facetOptionsFor(FACET_ROWS), { fabrics: ["Cotton", "Mul Cotton", "Tissue Cotton"], colours: ["Off-white", "Violet"] });
check("narrowed to Dhoti: only what Dhoti holds", facetOptionsFor(FACET_ROWS, "dhotis"), { fabrics: ["Cotton"], colours: [] });
check("narrowed to Rings: nothing", facetOptionsFor(FACET_ROWS, "rings"), { fabrics: [], colours: [] });
ok("the facet cache key moved with its shape, so a stale entry is never misread",
  read("lib/storefront.ts").includes('["catalogue-facets-v2"]'));

// ── 6. the panel as rendered ─────────────────────────────────────────────────

const noop = () => {};
const render = (el: React.ReactElement) => renderToStaticMarkup(el);
function panelChecks() {
  console.log("\n=== accordion semantics ===");
  const OPTIONS: FilterOptions = { ...SAREES, priceRange: { min: 1300, max: 3300, step: 100, lowest: 1250, highest: 3299 } };
  const html = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: { ...NO_FILTERS, fabric: ["Mul Cotton"] }, onChange: noop, isOpen: false, onClose: noop, onClearAll: noop,
  }));
  const buttons = [...html.matchAll(/<h3><button type="button" aria-expanded="(true|false)" aria-controls="([^"]+)"[^>]*><span[^>]*>([^<]+)<\/span>/g)];
  check("every group is a disclosure button inside an h3, in order",
    buttons.map((b) => b[3]), ["Availability", "Fabric", "Colour", "Price"]);
  ok("all start collapsed", buttons.every((b) => b[1] === "false"));
  ok("each controls a panel that exists and is hidden",
    buttons.every((b) => new RegExp(`<div id="${b[2].replace(/[:]/g, "\\:")}" hidden=""`).test(html)));
  ok("Fabric is placed straight after Availability", buttons[1]?.[3] === "Fabric");
  ok("the collapsed Fabric group names the one chosen facet", /Fabric<\/span>[\s\S]*?>Mul Cotton<\/span>/.test(html));
  ok("the desktop sidebar is labelled by a visible 'Filters' heading",
    /<aside aria-labelledby="([^"]+)"[\s\S]*?<h2 id="\1"[^>]*>Filters<\/h2>/.test(html));
  ok("Clear all sits in the sidebar header when something is chosen", /Filters<\/h2><button[^>]*>Clear all<\/button>/.test(html));
  ok("options are labelled checkboxes: the label is the row", /<label[^>]*><span[^>]*><input type="checkbox"[^>]*\/>[\s\S]*?Mul Cotton<\/span><\/label>/.test(html));
  ok("the chosen facet's checkbox is checked", /<input type="checkbox"[^>]*checked=""[^>]*\/><svg[\s\S]*?Mul Cotton/.test(html));
  ok("no pill styling left on options (rounded-full borders per option)", !/rounded-full border px-4 py-2/.test(read("components/shop/FilterSidebar.tsx")));
  ok("no leaf/eco/texture decoration in the panel", !/\b(Leaf|Sprout|eco|organic|sustainab\w*)\b/i.test(read("components/shop/FilterSidebar.tsx")));
  ok("unchecked boxes and round marks use ink-muted (5.56:1), not a faint ink tint",
    (read("components/shop/FilterSidebar.tsx").match(/border-ink-muted/g) ?? []).length >= 2 &&
    !/border-ink\/35/.test(read("components/shop/FilterSidebar.tsx")));
  ok("options are 44px tall on touch screens", (read("components/shop/FilterSidebar.tsx").match(/min-h-\[44px\][^"]*lg:min-h-\[36px\]/g) ?? []).length === 2);

  const drawer = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: NO_FILTERS, onChange: noop, isOpen: true, onClose: noop, resultLabel: "30 products",
  }));
  const dialog = drawer.slice(drawer.indexOf('role="dialog"'));
  ok("the drawer holds the same accordion", (dialog.match(/aria-expanded="false"/g) ?? []).length === 4);
  ok("the drawer still says what closing it will show", dialog.includes(">Show 30 products</button>"));
}

async function databaseChecks() {
  const ids = async (f: Parameters<typeof getCatalogue>[0]) =>
    (await getCatalogue(f, {}, ctx)).products.map((x) => x.id).sort();
  check("database: Mul Cotton", await ids({ fabric: ["Mul Cotton"] }), ["m1", "m2"]);
  check("database: Cotton + Tissue Cotton", await ids({ fabric: ["Cotton", "Tissue Cotton"] }), ["c1", "t1"]);
  check("database: Off-white or Violet, Mul Cotton", await ids({ fabric: ["Mul Cotton"], colour: ["Off-white", "Violet"] }), ["m1", "m2"]);
  check("database: the legacy sentence as a bare string", await ids({ fabric: MUL }), ["m1", "m2"]);
  check("database: nothing chosen, everything", (await ids({})).length, 5);
}

databaseChecks()
  .then(() => panelChecks())
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
