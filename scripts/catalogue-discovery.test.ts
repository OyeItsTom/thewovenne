/**
 * Storefront discovery (Premium UX PR 2): counts, order, the In stock filter,
 * chosen-filter chips, which categories are offered, and the listing's markup.
 *
 *   npx tsx scripts/catalogue-discovery.test.ts
 *
 * Exits non-zero on failure. No database is touched: the real query functions
 * run against an in-memory PostgREST double, and the real components are
 * rendered with react-dom/server.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import {
  NO_FILTERS,
  catalogueHref,
  catalogueQuery,
  catalogueSearchString,
  isUnfiltered,
  parseCatalogueParams,
  searchParamsRecord,
  type CatalogueFilters,
} from "../lib/catalogueParams";
import {
  SORT_OPTIONS,
  activeFilters,
  clearedFilters,
  offersAvailability,
  orderForDiscovery,
  resultCountLabel,
  withoutFilter,
} from "../lib/catalogueDiscovery";
import { priceSliderRange } from "../lib/priceSlider";
import { matchesFilters } from "../lib/productFilters";
import { effectivePrice, shownPrice, withinPriceCeiling } from "../lib/pricing";
import { getCatalogue, filterEffectiveCatalogueRows } from "../lib/products";
import { getNavCategoryTree, getVisibleCategoryTree } from "../lib/categories";
import { stockedChildrenOf } from "../lib/metadata";
import type { ReadCtx } from "../lib/readCtx";
import type { Category, Product, ProductListing } from "../lib/types";
import FilterSidebar, { hasFilterOptions } from "../components/shop/FilterSidebar";
import CatalogueListing from "../components/shop/CatalogueListing";

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

// ── fixtures ─────────────────────────────────────────────────────────────────

function item(id: string, price: number, stock: number, patch: Partial<Product> = {}): Product {
  return {
    id, name: id, slug: id, description: "", price_inr: price, category_id: "sarees",
    category: "Sarees", category_slug: "sarees", category_parent_slug: "women",
    fabric: "Cotton", colour: "Off-white", stock_quantity: stock, image_url: `/${id}.jpg`,
    is_active: true, created_at: "2026-01-01T00:00:00Z", collection: null,
    discount_type: null, discount_value: null, discount_starts_at: null, discount_ends_at: null,
    images: [`/${id}.jpg`], ...patch,
  } as Product;
}

// Arrival order = newest first, as every catalogue query returns it.
const MIXED = [
  item("n1", 1599, 2),
  item("n2-sold", 1250, 0),
  item("n3", 1399, 1, { fabric: "Handloom 120 count mul cotton" }),
  item("n4-sold", 1550, 0, { colour: "Red" }),
  item("n5", 3299, 4, { colour: "Red" }),
  item("n6", 1399, 5),
];
const ids = (list: { id: string }[]) => list.map((p) => p.id);

// ── 1. URL contract ──────────────────────────────────────────────────────────

console.log("\n=== the URL carries availability and sort, additively ===");
check("an empty URL is still the plain catalogue", parseCatalogueParams({}), NO_FILTERS);
check("availability=in-stock is read", parseCatalogueParams({ availability: "in-stock" }).inStock, true);
check("any other availability value is ignored", parseCatalogueParams({ availability: "yes" }).inStock, false);
check("a known sort is read", parseCatalogueParams({ sort: "price-asc" }).sort, "price-asc");
check("sort=newest is the default, so it reads as null", parseCatalogueParams({ sort: "newest" }).sort, null);
check("an unknown sort is ignored, not an error", parseCatalogueParams({ sort: "popular" }).sort, null);
check("In stock counts as a filter", isUnfiltered({ ...NO_FILTERS, inStock: true }), false);
check("a sort alone is NOT a filter", isUnfiltered({ ...NO_FILTERS, sort: "price-desc" }), true);
check(
  "keys are written in a fixed order, sort last",
  catalogueSearchString({ ...NO_FILTERS, sort: "price-asc", inStock: true, fabric: ["Cotton"] }),
  "fabric=Cotton&availability=in-stock&sort=price-asc"
);
check("the default state is still the bare path", catalogueHref("/in/women/sarees", NO_FILTERS), "/in/women/sarees");
for (const state of [
  { ...NO_FILTERS, inStock: true },
  { ...NO_FILTERS, sort: "price-desc" as const },
  { ...NO_FILTERS, colour: ["Red"], inStock: true, sort: "price-asc" as const },
  { ...NO_FILTERS, colour: ["Off-white", "Red"], fabric: ["Cotton", "Mul Cotton"], maxPrice: 2000 },
]) {
  const search = catalogueSearchString(state);
  check(`round trip: ${search}`, parseCatalogueParams(searchParamsRecord(new URLSearchParams(search))), state);
}
check(
  "the query key never contains the sort",
  Object.keys(catalogueQuery({ ...NO_FILTERS, sort: "price-asc" })).includes("sort"),
  false
);
check(
  "two sorts of one filter state share one query key",
  JSON.stringify(catalogueQuery({ ...NO_FILTERS, colour: ["Red"], sort: "price-asc" })),
  JSON.stringify(catalogueQuery({ ...NO_FILTERS, colour: ["Red"], sort: null }))
);

// ── 2. ordering ──────────────────────────────────────────────────────────────

console.log("\n=== order: what can be bought first, the chosen sort inside each group ===");
check("default (newest): in stock in arrival order, then sold out in arrival order",
  ids(orderForDiscovery(MIXED, null)), ["n1", "n3", "n5", "n6", "n2-sold", "n4-sold"]);
check("price low→high applies within each group",
  ids(orderForDiscovery(MIXED, "price-asc")), ["n3", "n6", "n1", "n5", "n2-sold", "n4-sold"]);
check("price high→low applies within each group",
  ids(orderForDiscovery(MIXED, "price-desc")), ["n5", "n1", "n3", "n6", "n4-sold", "n2-sold"]);
check("equal prices keep arrival order (stable)",
  ids(orderForDiscovery(MIXED, "price-asc")).filter((id) => id === "n3" || id === "n6"), ["n3", "n6"]);
const allIn = MIXED.filter((p) => p.stock_quantity > 0);
check("all in stock: the default order is untouched", ids(orderForDiscovery(allIn, null)), ids(allIn));
const allOut = MIXED.map((p) => ({ ...p, stock_quantity: 0 }));
check("all sold out: the default order is untouched", ids(orderForDiscovery(allOut, null)), ids(MIXED));
check("all sold out: price sort still applies", ids(orderForDiscovery(allOut, "price-asc"))[0], "n2-sold");
for (const sort of [null, "price-asc", "price-desc"] as const) {
  const out = orderForDiscovery(MIXED, sort);
  check(`no product lost or duplicated (${sort ?? "newest"})`, [...ids(out)].sort(), [...ids(MIXED)].sort());
}
ok("ordering does not mutate its input", ids(MIXED)[0] === "n1" && ids(MIXED)[1] === "n2-sold");
const discounted = [
  item("full", 1500, 1),
  item("on-sale", 2000, 1, { discount_type: "percent", discount_value: 50 } as Partial<Product>),
];
check("price sort uses the price the card shows (a live discount counts)",
  ids(orderForDiscovery(discounted, "price-asc")), ["on-sale", "full"]);
check("negative stock reads as sold out, like the card",
  ids(orderForDiscovery([item("neg", 100, -1), item("pos", 200, 1)], null)), ["pos", "neg"]);
check("three customer sorts, no invented 'Recommended'",
  SORT_OPTIONS.map((o) => o.label), ["Newest", "Price: low to high", "Price: high to low"]);

// ── 3. filtering + counts ────────────────────────────────────────────────────

console.log("\n=== filtering and counting ===");
const run = (f: CatalogueFilters) => MIXED.filter((p) => matchesFilters(p, f, {}));
check("no filters: everything", run(NO_FILTERS).length, 6);
check("single filter (colour)", ids(run({ ...NO_FILTERS, colour: ["red"] })), ["n4-sold", "n5"]);
check("In stock drops exactly the sold-out pieces", ids(run({ ...NO_FILTERS, inStock: true })), ["n1", "n3", "n5", "n6"]);
check("multiple filters are AND (Red + In stock)", ids(run({ ...NO_FILTERS, colour: ["Red"], inStock: true })), ["n5"]);
check("several values in ONE group are OR (Red or Off-white)",
  ids(run({ ...NO_FILTERS, colour: ["Red", "Off-white"] })).length,
  MIXED.filter((p) => ["red", "off-white"].includes((p.colour ?? "").toLowerCase())).length);
check("…and still AND across groups (Red or Off-white, In stock)",
  run({ ...NO_FILTERS, colour: ["Red", "Off-white"], inStock: true }).every((p) => p.stock_quantity > 0), true);
check("an impossible combination is empty", run({ ...NO_FILTERS, colour: ["Red"], fabric: ["Silk"] }).length, 0);
check("clear all returns everything", run(clearedFilters({ ...NO_FILTERS, colour: ["Red"], inStock: true })).length, 6);
check("clear all keeps the chosen sort", clearedFilters({ ...NO_FILTERS, colour: ["Red"], sort: "price-asc" }), { ...NO_FILTERS, sort: "price-asc" });
check("count, unfiltered", resultCountLabel(30, 30), "30 products");
check("count, filtered", resultCountLabel(8, 30), "8 of 30 products");
check("count, one product", resultCountLabel(1, 1), "1 product");
check("count, empty result", resultCountLabel(0, 30), "0 of 30 products");
check("count, empty listing", resultCountLabel(0, 0), "0 products");

console.log("\n=== the In stock filter in the catalogue query ===");
{
  // Effective-row filter (the preview path) — same rule.
  const rows = [
    { product_id: "x", state: "published", is_active: true, category_id: "sarees", stock_quantity: 0, price_inr: 1 },
    { product_id: "y", state: "published", is_active: true, category_id: "sarees", stock_quantity: 3, price_inr: 1 },
  ] as never[];
  const cats = new Map<string, Category>([["sarees", { id: "sarees", slug: "sarees" } as Category]]);
  check("preview path: In stock keeps only rows with stock",
    filterEffectiveCatalogueRows(rows, { inStock: true }, ["sarees"], cats, null).map((r: { product_id: string }) => r.product_id), ["y"]);
  check("preview path: without it, both",
    filterEffectiveCatalogueRows(rows, {}, ["sarees"], cats, null).length, 2);
}

// ── 3b. one price rule: shown = sorted = filtered ───────────────────────────

console.log("\n=== the price a customer sees is the price every control uses ===");
const DAY = 86_400_000;
const past = new Date(Date.now() - 10 * DAY).toISOString();
const soon = new Date(Date.now() + 10 * DAY).toISOString();
const yesterday = new Date(Date.now() - DAY).toISOString();
// Tom's example: stored ₹1,699, shown ₹1,299 (flat ₹400 off, live window).
const SALE = item("sale-1699", 1699, 3, { discount_type: "flat", discount_value: 400, discount_starts_at: past, discount_ends_at: soon } as Partial<Product>);
const PLAIN_1450 = item("plain-1450", 1450, 3);
const PLAIN_1599 = item("plain-1599", 1599, 3);
const EXPIRED = item("expired-1699", 1699, 3, { discount_type: "flat", discount_value: 400, discount_starts_at: past, discount_ends_at: yesterday } as Partial<Product>);
const NOT_STARTED = item("future-1699", 1699, 3, { discount_type: "flat", discount_value: 400, discount_starts_at: soon, discount_ends_at: null } as Partial<Product>);
const EXACT = item("exact-1500", 2000, 3, { discount_type: "percent", discount_value: 25 } as Partial<Product>);
const PRICED = [SALE, PLAIN_1450, PLAIN_1599, EXPIRED, NOT_STARTED, EXACT];
const under = (max: number) => ids(PRICED.filter((p) => matchesFilters(p, { ...NO_FILTERS, maxPrice: max }, {})));

check("1. no discount: shown price is the stored price", shownPrice(PLAIN_1450), 1450);
check("2. active discount: shown price is the card's price", [shownPrice(SALE), effectivePrice(SALE).price, effectivePrice(SALE).wasPrice], [1299, 1299, 1699]);
check("3. ₹1,699 shown at ₹1,299 IS within 'Up to ₹1,500'", under(1500).includes("sale-1699"), true);
check("3. …and a plain ₹1,599 is not", under(1500).includes("plain-1599"), false);
check("6. boundary: shown at exactly ₹1,500 is within 'Up to ₹1,500' (inclusive, as before)", [shownPrice(EXACT), under(1500).includes("exact-1500")], [1500, true]);
check("6. …and not within 'Up to ₹1,499'", under(1499).includes("exact-1500"), false);
check("7. an expired discount does not count", [shownPrice(EXPIRED), under(1500).includes("expired-1699")], [1699, false]);
check("7. a discount not yet started does not count", [shownPrice(NOT_STARTED), under(1500).includes("future-1699")], [1699, false]);
check("'Up to ₹1,500' is exactly the cards showing ₹1,500 or less", under(1500).sort(), ["exact-1500", "plain-1450", "sale-1699"]);
check("4. low→high sorts by the shown price",
  ids(orderForDiscovery(PRICED, "price-asc")), ["sale-1699", "plain-1450", "exact-1500", "plain-1599", "expired-1699", "future-1699"]);
check("5. high→low sorts by the shown price (equal prices keep arrival order)",
  ids(orderForDiscovery(PRICED, "price-desc")), ["expired-1699", "future-1699", "plain-1599", "exact-1500", "plain-1450", "sale-1699"]);
check("the slider's range is computed from shown prices (₹1,299 sale is the low end, not ₹1,699)",
  priceSliderRange(PRICED.map((p) => shownPrice(p))), { min: 1300, max: 1700, step: 100, lowest: 1299, highest: 1699 });
check("withinPriceCeiling: no ceiling passes everything", PRICED.every((p) => withinPriceCeiling(p, null)), true);
{
  const rows = PRICED.map((p) => ({ product_id: p.id, state: "published", is_active: true, category_id: "sarees",
    stock_quantity: 3, price_inr: p.price_inr, discount_type: p.discount_type, discount_value: p.discount_value,
    discount_starts_at: p.discount_starts_at, discount_ends_at: p.discount_ends_at })) as never[];
  const cats = new Map<string, Category>([["sarees", { id: "sarees", slug: "sarees" } as Category]]);
  check("preview path filters by the shown price too",
    filterEffectiveCatalogueRows(rows, { maxPrice: 1500 }, ["sarees"], cats, null).map((r: { product_id: string }) => r.product_id).sort(),
    ["exact-1500", "plain-1450", "sale-1699"]);
}
const priceSrc = read("lib/products.ts") + read("lib/productFilters.ts") + read("lib/catalogueDiscovery.ts");
ok("no listing compares the stored price_inr against a ceiling any more",
  !/lte\("price_inr"/.test(priceSrc) && !/price_inr > filters\.maxPrice/.test(priceSrc));
ok("every surface goes through the one helper",
  read("lib/products.ts").includes("withinPriceCeiling(") && read("lib/productFilters.ts").includes("withinPriceCeiling(") &&
  read("lib/catalogueDiscovery.ts").includes("shownPrice(") &&
  read("app/(storefront)/in/shop/page.tsx").includes("priceSliderRange(scope.map((p) => shownPrice(p)))") &&
  read("components/shop/CategoryFilters.tsx").includes("priceSliderRange(products.map((p) => shownPrice(p)))"));

// ── 4. options worth offering ────────────────────────────────────────────────

console.log("\n=== only options that narrow ===");
const LIVE_PRICES = [459, 699, 1250, 1299, 1299, 1399, 1450, 1499, 1550, 1599, 3299];
check("shop: the track runs from the cheapest piece to the dearest, in ₹100 stops",
  priceSliderRange(LIVE_PRICES), { min: 500, max: 3300, step: 100, lowest: 459, highest: 3299 });
check("jewellery (₹459, ₹699): a ₹500 or ₹600 ceiling does narrow", priceSliderRange([459, 699])?.min, 500);
check("one product: nothing to narrow, no slider", priceSliderRange([1299]), null);
check("every price inside one step: nothing to narrow", priceSliderRange([1210, 1290]), null);
check("In stock is offered on a mixed shelf", offersAvailability(MIXED), true);
check("…not when everything is in stock (a no-op)", offersAvailability(allIn), false);
check("…not when everything is sold out (always empty)", offersAvailability(allOut), false);
check("…not on an empty shelf", offersAvailability([]), false);

// ── 5. chips ─────────────────────────────────────────────────────────────────

console.log("\n=== chosen filters as chips ===");
check("no chips by default", activeFilters(NO_FILTERS), []);
check("a sort is not a chip", activeFilters({ ...NO_FILTERS, sort: "price-asc" }), []);
const chosen: CatalogueFilters = { ...NO_FILTERS, inStock: true, category: "sarees", fabric: ["Cotton", "Mul Cotton"], colour: ["Off-white"], maxPrice: 1500 };
check("chips in panel order, one per value, facet names as labels",
  activeFilters(chosen, (s) => (s === "sarees" ? "Sarees" : null)).map((c) => c.label),
  ["In stock", "Cotton", "Mul Cotton", "Off-white", "Up to ₹1,500", "Sarees"]);
check("a size chip is named by its group", activeFilters({ ...NO_FILTERS, size: "6" }, () => null, "Ring size").map((c) => c.label), ["Ring size 6"]);
check("an unknown category slug still gets a removable chip",
  activeFilters({ ...NO_FILTERS, category: "shirts" }).map((c) => c.label), ["shirts"]);
check("removing one value's chip removes only that value",
  withoutFilter(chosen, "fabric", "Cotton"), { ...chosen, fabric: ["Mul Cotton"] });
check("…regardless of case", withoutFilter(chosen, "fabric", "mul cotton").fabric, ["Cotton"]);
check("removing a single-valued chip clears it", withoutFilter(chosen, "category"), { ...chosen, category: null });
check("removing In stock sets it false, not null", withoutFilter(chosen, "inStock").inStock, false);
check("removing every chip one by one reaches the unfiltered state",
  isUnfiltered(activeFilters(chosen).reduce((f, c) => withoutFilter(f, c.key, c.value), chosen)), true);

// ── 6. category eligibility ──────────────────────────────────────────────────

console.log("\n=== categories offered = categories with something in them ===");
type Row = Record<string, unknown>;
const CATS: Row[] = [
  ["men", "Men", null, 0], ["shirts", "Shirts", "men", 1], ["dhotis", "Dhoti", "men", 2],
  ["women", "Women", null, 3], ["sarees", "Sarees", "women", 4], ["dresses", "Dresses", "women", 5],
  ["home", "Home", "women", 6, false],
  ["jewellery", "Jewellery", null, 7], ["necklace", "Necklace", "jewellery", 8], ["rings", "Rings", "jewellery", 9], ["chain", "Chain", "jewellery", 10],
  ["kids", "Kids", null, 11], ["kids-tops", "Tops", "kids", 12],
].map(([id, name, parent, sort, visible]) => ({
  category_id: id, state: "published", name, slug: id, parent_id: parent,
  is_visible: visible ?? true, sort_order: sort, created_at: "2026-01-01",
}));
const PRODUCT_ROWS: Row[] = [
  { product_id: "s1", state: "published", is_active: true, category_id: "sarees" },
  { product_id: "s2", state: "published", is_active: true, category_id: "sarees" },
  { product_id: "d1", state: "published", is_active: true, category_id: "dhotis" },
  { product_id: "n1", state: "published", is_active: true, category_id: "necklace" },
  { product_id: "r1", state: "published", is_active: true, category_id: "rings" },
  { product_id: "dr", state: "draft", is_active: true, category_id: "dresses" },
  { product_id: "off", state: "published", is_active: false, category_id: "chain" },
  { product_id: "h1", state: "published", is_active: true, category_id: "home" },
];
class Q implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  constructor(private rows: Row[]) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  order() { return this; }
  then<A = { data: Row[]; error: null }, B = never>(
    ok1?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    ko?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    return Promise.resolve({ data: this.rows.filter((r) => this.filters.every((f) => f(r))), error: null }).then(ok1, ko);
  }
}
const navClient = {
  from: (t: string) => new Q(t === "category_versions" ? CATS : PRODUCT_ROWS),
} as unknown as SupabaseClient;
const navCtx: ReadCtx = { client: navClient, preview: false };

async function categoryChecks() {
  const visible = await getVisibleCategoryTree(navCtx);
  const eligible = await getNavCategoryTree(navCtx);
  const shape = (tree: typeof eligible) => tree.map((p) => `${p.slug}:${p.children.map((c) => c.slug).join(",")}`);
  check("before: the merely-visible tree offered empty shelves",
    shape(visible), ["men:shirts,dhotis", "women:sarees,dresses", "jewellery:necklace,rings,chain", "kids:kids-tops"]);
  check("after: the eligible tree (header, shop filter, section links) offers only stocked shelves",
    shape(eligible), ["men:dhotis", "women:sarees", "jewellery:necklace,rings"]);
  ok("a draft-only product does not make a shelf eligible", !shape(eligible).join().includes("dresses"));
  ok("an inactive product does not either", !shape(eligible).join().includes("chain"));
  ok("a hidden sub-category stays out even with a product", !shape(eligible).join().includes("home"));
  ok("a section with no stocked shelf is dropped entirely", !shape(eligible).some((s) => s.startsWith("kids")));
  check("section links: Men has one shelf, so no links are shown", (stockedChildrenOf(eligible, "men") ?? []).length > 1, false);
  check("section links: Jewellery offers Necklace and Rings",
    (stockedChildrenOf(eligible, "jewellery") ?? []).map((c) => c.name), ["Necklace", "Rings"]);
  check("a failed read stays 'unknown', so no section links and no noindex claim", stockedChildrenOf([], "men"), null);

  // The real getCatalogue with the In stock filter, against the same double
  // extended with gt/lte — proves the DB path, not only the in-memory one.
  const listingRows: Row[] = ["a", "b", "c"].map((id, i) => ({
    product_id: id, state: "published", is_active: true, category_id: "sarees", name: id, slug: id,
    price_inr: 1000 + i, stock_quantity: id === "b" ? 0 : 2, image_url: null, created_at: "2026-01-01",
    discount_type: null, discount_value: null, discount_starts_at: null, discount_ends_at: null,
    product_images: [], products: { created_at: `2026-01-0${3 - i}` },
  }));
  class LQ extends Q {
    private extra: ((r: Row) => boolean)[] = [];
    gt(c: string, v: number) { this.extra.push((r) => (r[c] as number) > v); return this; }
    lte(c: string, v: number) { this.extra.push((r) => (r[c] as number) <= v); return this; }
    range() { return this; }
    then<A = { data: Row[]; error: null }, B = never>(
      ok1?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
      ko?: ((e: unknown) => B | PromiseLike<B>) | null
    ): PromiseLike<A | B> {
      return super.then((res) => ({ ...res, data: res.data.filter((r) => this.extra.every((f) => f(r))) })).then(ok1, ko);
    }
  }
  const listClient = {
    from: (t: string) => new LQ(t === "category_versions" ? CATS : listingRows),
  } as unknown as SupabaseClient;
  const ctx: ReadCtx = { client: listClient, preview: false };
  check("getCatalogue: no filter returns all three", (await getCatalogue({}, {}, ctx)).products.length, 3);
  check("getCatalogue: In stock drops the sold-out row in the query",
    (await getCatalogue({ inStock: true }, {}, ctx)).products.map((p) => p.id).sort(), ["a", "c"]);
  check("getCatalogue: inStock false is the same as absent",
    (await getCatalogue({ inStock: false }, {}, ctx)).products.length, 3);
  // Row "a" stored ₹1,000 → shown ₹1,000; "c" stored ₹1,002. Give "c" a sale and
  // a ceiling only the sale clears.
  listingRows[2].price_inr = 1699;
  Object.assign(listingRows[2], { discount_type: "flat", discount_value: 400 });
  check("getCatalogue (database path): a ₹1,699 piece shown at ₹1,299 is under ₹1,500",
    (await getCatalogue({ maxPrice: 1500 }, {}, ctx)).products.map((p) => p.id).sort(), ["a", "b", "c"]);
  check("getCatalogue: and is excluded under ₹1,200", (await getCatalogue({ maxPrice: 1200 }, {}, ctx)).products.map((p) => p.id).sort(), ["a", "b"]);
  check("getCatalogue: paging applies after the price ceiling",
    (await getCatalogue({ maxPrice: 1500 }, { limit: 1, offset: 1 }, ctx)).products.length, 1);
}

// ── 7. rendered markup ───────────────────────────────────────────────────────

const noop = () => {};
const ROUTER = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: ROUTER as never }, el));
const asListing = (p: Product) => p as unknown as ProductListing;
const OPTIONS = {
  categoryGroups: [{ name: "Women", children: [{ name: "Sarees", slug: "sarees" }, { name: "Dupattas", slug: "dupattas" }] }],
  fabrics: ["Cotton", "Mul Cotton"],
  colours: ["Off-white", "Red"],
  sizes: [],
  priceRange: { min: 1300, max: 1700, step: 100, lowest: 1299, highest: 1699 },
  availability: true,
};

function markupChecks() {
  console.log("\n=== the listing as rendered ===");
  const plain = render(createElement(CatalogueListing, {
    products: orderForDiscovery(MIXED, null).map(asListing), total: 6,
    filters: NO_FILTERS, options: OPTIONS, onChange: noop,
  }));
  ok("unfiltered: the count reads '6 products'", plain.includes(">6 products<"));
  ok("the count is a polite status region", /role="status"[^>]*>6 products</.test(plain));
  ok("unfiltered: no chips, no Clear all", !plain.includes("Remove filter") && !plain.includes("Clear all"));
  ok("a labelled native sort control", /<label[^>]*>[\s\S]*Sort[\s\S]*<select/.test(plain));
  ok("the sort shows Newest by default", /<option value="newest" selected="">Newest<\/option>/.test(plain));
  ok("a Filters button for phones, announced as opening a dialog", /aria-haspopup="dialog"[^>]*>[\s\S]*?Filters/.test(plain));
  ok("an Availability group with In stock, as a checkbox",
    /<h3><button[^>]*aria-expanded="false"[^>]*><span[^>]*>Availability<\/span>/.test(plain) && /type="checkbox"[\s\S]*?In stock/.test(plain));
  ok("multi-choice options are real checkboxes (In stock, 2 fabrics, 2 colours)", (plain.match(/type="checkbox"/g) ?? []).length === 5);
  const plainAside = plain.slice(plain.indexOf("<aside"), plain.indexOf("</aside>"));
  ok("one-of options (the 2 categories) expose their state with aria-pressed",
    (plainAside.match(/aria-pressed="false"/g) ?? []).length === 2);
  ok("sold-out cards follow every in-stock card in the markup",
    plain.indexOf("n6") < plain.indexOf("n2-sold") && plain.indexOf("n5") < plain.indexOf("n4-sold"));

  const filtered: CatalogueFilters = { ...NO_FILTERS, colour: ["Red"], inStock: true };
  const narrowed = render(createElement(CatalogueListing, {
    products: orderForDiscovery(run(filtered), null).map(asListing), total: 6,
    filters: filtered, options: OPTIONS, onChange: noop,
  }));
  ok("filtered: '1 of 6 products'", narrowed.includes(">1 of 6 products<"));
  ok("filtered: one removable chip per filter",
    narrowed.includes('aria-label="Remove filter: In stock"') && narrowed.includes('aria-label="Remove filter: Red"'));
  ok("filtered: Clear all appears", narrowed.includes(">Clear all</button>"));
  ok("the chosen options read as checked", (narrowed.match(/checked=""/g) ?? []).length === 2);
  ok("each collapsed group says what is chosen in it",
    /Availability<\/span>[\s\S]*?>In stock<\/span>/.test(narrowed) && /Colour<\/span>[\s\S]*?>Red<\/span>/.test(narrowed));
  ok("the Filters button says how many are applied", narrowed.includes("(2)") && narrowed.includes(", 2 applied"));

  const empty = render(createElement(CatalogueListing, {
    products: [], total: 6, filters: { ...NO_FILTERS, colour: ["Red"], fabric: ["Silk"] }, options: OPTIONS, onChange: noop,
  }));
  ok("empty result: one clear message", empty.includes("No products match these filters."));
  ok("empty result: one way out, and no substitute products", empty.includes(">Clear filters</button>") && !empty.includes("<article"));

  const bare = render(createElement(CatalogueListing, {
    products: [asListing(item("j1", 459, 1))], total: 1, filters: NO_FILTERS,
    options: { categoryGroups: [], fabrics: [], colours: [], sizes: [], priceRange: null, availability: false },
    onChange: noop,
  }));
  ok("nothing to filter: no Filters button and no sidebar", !bare.includes("aria-haspopup") && !bare.includes("<aside"));
  ok("…but still the same count and sort", bare.includes(">1 product<") && bare.includes("<select"));

  console.log("\n=== mobile drawer state ===");
  const drawer = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: filtered, onChange: noop, isOpen: true, onClose: noop,
    resultLabel: "1 product", onClearAll: noop,
  }));
  ok("the drawer is a modal dialog", /role="dialog" aria-modal="true"/.test(drawer));
  ok("named by its own heading", /aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"[^>]*>Filters<\/h2>/.test(drawer));
  ok("focusable as a target, never as a Tab stop", /role="dialog"[^>]*tabindex="-1"/.test(drawer));
  ok("a named close button", drawer.includes('aria-label="Close filters"'));
  ok("Clear all inside the drawer when something is chosen", drawer.includes(">Clear all</button>"));
  ok("the close action states what it will show", drawer.includes(">Show 1 product</button>"));
  const drawerClean = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: NO_FILTERS, onChange: noop, isOpen: true, onClose: noop, onClearAll: noop,
  }));
  ok("no Clear all in the drawer when nothing is chosen", !drawerClean.includes("Clear all"));
  const closed = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: NO_FILTERS, onChange: noop, isOpen: false, onClose: noop,
  }));
  ok("closed: no dialog in the page", !closed.includes('role="dialog"'));
  ok("hasFilterOptions: false for an empty option set",
    hasFilterOptions({ categoryGroups: [], fabrics: [], colours: [], sizes: [], priceRange: null, availability: false }) === false);
  ok("hasFilterOptions: true when only availability is offered",
    hasFilterOptions({ categoryGroups: [], fabrics: [], colours: [], sizes: [], priceRange: null, availability: true }));
  const sharedLink = render(createElement(FilterSidebar, {
    options: OPTIONS, filters: { ...NO_FILTERS, maxPrice: 5000, colour: ["red"] },
    onChange: noop, isOpen: false, onClose: noop,
  }));
  ok("a ceiling from a shared link stays visible in the Price group's summary", /Price<\/span>[\s\S]*?>Up to ₹5,000<\/span>/.test(sharedLink));
  ok("a lower-case colour from a shared link shows its option checked", /checked=""[^>]*\/>[\s\S]{0,400}?Red</.test(sharedLink));
  ok("chosen options are white on ink, not white on terracotta (3.64:1)",
    !read("components/shop/FilterSidebar.tsx").includes("bg-terracotta text-cream"));
  ok("the drawer reuses the shared trap decision (lib/focusTrap)",
    /from "\.\/focusTrap"/.test(read("lib/useDialogFocus.ts")) && read("components/shop/FilterSidebar.tsx").includes("useDialogFocus("));
}

// ── 8. SEO/routing assumptions ───────────────────────────────────────────────

function seoChecks() {
  console.log("\n=== canonical and routing assumptions hold ===");
  const shop = read("app/(storefront)/in/shop/page.tsx");
  ok("shop canonical stays the bare /shop for every filter and sort", /alternates: \{ canonical: cPath\("\/shop"\) \}/.test(shop));
  ok("the shop still never fetches every product for the client", !shop.includes("getAllProducts"));
  const child = read("app/(storefront)/in/[slug]/[child]/page.tsx");
  ok("sub-category canonical is still the clean category URL", child.includes("alternates: { canonical: categoryHref(parent.slug, child.slug) }"));
  ok("sub-category robots still decided by emptyCategoryRobots", child.includes("robots: emptyCategoryRobots(stocked)"));
  ok("sub-category routes still resolve against the VISIBLE tree (no route removed)",
    /async function resolve[\s\S]*getVisibleCategoryTree\(\)/.test(child) && child.includes("generateStaticParams"));
  const section = read("app/(storefront)/in/[slug]/page.tsx");
  ok("section routes still resolve against the visible tree", /async function resolve[\s\S]*getVisibleCategoryTree\(\)/.test(section));
  ok("section products still come from every visible child (no product lost)",
    section.includes("getProductsByCategoryIds(category.children.map((c) => c.id))"));
  ok("category pages are still ISR (revalidate = 60), not per-request",
    /export const revalidate = 60;/.test(section) && /export const revalidate = 60;/.test(child));
  ok("category listings never read searchParams (that would make them dynamic)",
    !/searchParams/.test(section.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")) && !/searchParams/.test(child.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
  const cat = read("components/shop/CategoryFilters.tsx");
  ok("category filter state is written with replaceState (Back leaves the page, as before)",
    cat.includes("window.history.replaceState") && !cat.includes("pushState"));
  const storefront = read("lib/storefront.ts");
  ok("the shop's Category filter reads the eligible tree, like the header",
    /const cachedCategoryTree = unstable_cache\(\s*async \(\) => categories\.getNavCategoryTree\(ANON_CTX\)/.test(storefront) &&
      /if \(ctx\.preview\) return categories\.getNavCategoryTree\(ctx\)/.test(storefront));
  ok("the header still reads the same tree", read("components/layout/Navbar.tsx").includes("await getNavCategoryTree()"));
  const sitemap = read("lib/sitemapRoutes.ts");
  ok("the sitemap does not read the discovery tree", !sitemap.includes("getCatalogueCategoryTree"));
}

async function main() {
  await categoryChecks();
  markupChecks();
  seoChecks();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
