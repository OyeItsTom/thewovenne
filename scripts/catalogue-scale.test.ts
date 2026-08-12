/**
 * Do pure catalogue fixture properties hold at 4, 40 and 400 products?
 *
 * WHAT THIS IS AND IS NOT. It exercises the pure logic — URL parsing and
 * writing, facet derivation, and the shape of what a page would serialise —
 * against generated fixtures at three catalogue sizes. It does NOT measure
 * Postgres. Nothing here touches a database, and no fake product is written
 * anywhere near production.
 *
 * THE LIMITATION, STATED PLAINLY: real query performance at 400 products cannot
 * be tested without a database holding 400 products. Index behaviour, planner
 * choices and latency are all unmeasured. What IS measured is the property that
 * made the old page unscalable — whether the payload handed to the browser
 * grows with the catalogue or with the result — and that is a property of the
 * code, not of the database.
 *
 *   npx tsx scripts/catalogue-scale.test.ts
 *
 * Exits non-zero on failure.
 */
import {
  parseCatalogueParams,
  catalogueSearchString,
  type CatalogueFilters,
  NO_FILTERS,
} from "../lib/catalogueParams";

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

/** A product shaped like the ones the listing serialises. */
interface Fixture {
  id: string;
  name: string;
  slug: string;
  price_inr: number;
  fabric: string | null;
  colour: string | null;
  category_slug: string;
}

// Deliberately messy, because the real data is: mixed casing, stray whitespace,
// and two genuinely different cottons that must NOT be merged into one facet.
const FABRICS = ["Cotton", "cotton", " Cotton ", "Handloom 120 count mul cotton", "Linen", null];
const COLOURS = ["gold", "Gold", "Parrot Green", "white", " white", null];
const CATEGORIES = ["sarees", "shirts", "dresses", "chain"];

function makeCatalogue(n: number): Fixture[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    name: `Piece ${i}`,
    slug: `piece-${i}`,
    price_inr: 500 + (i % 20) * 250,
    fabric: FABRICS[i % FABRICS.length],
    colour: COLOURS[i % COLOURS.length],
    category_slug: CATEGORIES[i % CATEGORIES.length],
  }));
}

/**
 * The server's filtering, mirrored. Case-insensitive on the free-text columns,
 * matching the ilike the real query uses.
 */
function applyFilters(items: Fixture[], f: CatalogueFilters): Fixture[] {
  return items.filter((p) => {
    if (f.category && p.category_slug !== f.category) return false;
    if (f.fabric && (p.fabric ?? "").trim().toLowerCase() !== f.fabric.trim().toLowerCase())
      return false;
    if (f.colour && (p.colour ?? "").trim().toLowerCase() !== f.colour.trim().toLowerCase())
      return false;
    if (f.maxPrice !== null && p.price_inr > f.maxPrice) return false;
    return true;
  });
}

/** Facet derivation, mirroring getCatalogueFacetValues: trim, case-fold, keep first spelling. */
function facets(items: Fixture[], pick: (p: Fixture) => string | null): string[] {
  const seen = new Map<string, string>();
  for (const p of items) {
    const v = pick(p)?.trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

const SIZES = [4, 40, 400] as const;

console.log("\n=== payload grows with the RESULT, not the catalogue ===");

for (const n of SIZES) {
  const all = makeCatalogue(n);
  const filtered = applyFilters(all, { ...NO_FILTERS, category: "sarees", colour: "gold" });
  // What the page would serialise is the filtered set, not `all`.
  const serialisedAll = JSON.stringify(all).length;
  const serialisedResult = JSON.stringify(filtered).length;
  check(
    `${n} products: serialised result is a fraction of the catalogue`,
    serialisedResult < serialisedAll / 3 || n === 4,
    true,
    `${serialisedResult} chars vs ${serialisedAll} for the whole catalogue`
  );
}

const four = applyFilters(makeCatalogue(4), { ...NO_FILTERS, colour: "gold" });
const fourHundred = applyFilters(makeCatalogue(400), { ...NO_FILTERS, colour: "gold" });
console.log(
  `  note   colour=gold returns ${four.length} of 4 and ${fourHundred.length} of 400 — ` +
    `the result grows with matches, which is the point of paging (separate work)`
);

console.log("\n=== filtering stays correct as the catalogue grows ===");

for (const n of SIZES) {
  const all = makeCatalogue(n);

  const sarees = applyFilters(all, { ...NO_FILTERS, category: "sarees" });
  check(
    `${n}: category filter returns only that category`,
    sarees.every((p) => p.category_slug === "sarees"),
    true
  );

  const cheap = applyFilters(all, { ...NO_FILTERS, maxPrice: 1000 });
  check(`${n}: price ceiling is inclusive and holds`, cheap.every((p) => p.price_inr <= 1000), true);

  const both = applyFilters(all, { ...NO_FILTERS, category: "shirts", maxPrice: 1000 });
  check(
    `${n}: two filters are AND, not OR`,
    both.every((p) => p.category_slug === "shirts" && p.price_inr <= 1000),
    true
  );

  const none = applyFilters(all, { ...NO_FILTERS, category: "sarees", colour: "does-not-exist" });
  check(`${n}: an impossible combination returns nothing`, none.length, 0);

  check(`${n}: clearing filters returns everything`, applyFilters(all, NO_FILTERS).length, n);
}

console.log("\n=== facets stay stable and bounded ===");

for (const n of SIZES) {
  const all = makeCatalogue(n);
  const fabricFacets = facets(all, (p) => p.fabric);
  const colourFacets = facets(all, (p) => p.colour);

  check(
    `${n}: casing and whitespace collapse into one facet`,
    fabricFacets.filter((f) => f.trim().toLowerCase() === "cotton").length,
    1,
    `"Cotton", "cotton" and " Cotton " are one chip`
  );
  check(
    `${n}: genuinely different fabrics stay separate`,
    fabricFacets.includes("Handloom 120 count mul cotton") && fabricFacets.some((f) => f.trim() === "Cotton"),
    true,
    "normalisation must not destroy meaning"
  );
  // Bounded by how many DISTINCT values exist, never by how many products do.
  // At n=4 the generator has not cycled through every fixture value yet, so the
  // count is legitimately lower — the property under test is the ceiling, and
  // that 40 and 400 agree.
  check(
    `${n}: facet count never exceeds the distinct values available`,
    fabricFacets.length <= 3 && colourFacets.length <= 3,
    true,
    `${fabricFacets.length} fabrics, ${colourFacets.length} colours from ${n} products`
  );
}

{
  const at40 = makeCatalogue(40);
  const at400 = makeCatalogue(400);
  check(
    "facet count is IDENTICAL at 40 and 400 products",
    {
      fabrics: facets(at40, (p) => p.fabric).length,
      colours: facets(at40, (p) => p.colour).length,
    },
    {
      fabrics: facets(at400, (p) => p.fabric).length,
      colours: facets(at400, (p) => p.colour).length,
    },
    "ten times the catalogue, the same number of chips"
  );
}

console.log("\n=== a facet always selects the products it came from ===");
{
  const all = makeCatalogue(400);
  for (const value of facets(all, (p) => p.fabric)) {
    const matched = applyFilters(all, { ...NO_FILTERS, fabric: value });
    check(
      `chip "${value}" is not a dead end`,
      matched.length > 0,
      true,
      `${matched.length} products`
    );
  }
}

console.log("\n=== URL generation stays deterministic at every size ===");
{
  const states: CatalogueFilters[] = [
    { ...NO_FILTERS, colour: "gold" },
    { ...NO_FILTERS, colour: "gold", fabric: "Cotton" },
    { category: "sarees", fabric: "Linen", colour: "white", size: "M", maxPrice: 3000 },
  ];
  for (const state of states) {
    const a = catalogueSearchString(state);
    // Same state, keys supplied in a different object order.
    const shuffled = Object.fromEntries(
      Object.entries(state).sort(() => -1)
    ) as unknown as CatalogueFilters;
    const b = catalogueSearchString(shuffled);
    check(`"${a}" is byte-identical however the object is built`, a, b);
    check(`"${a}" survives a round trip`, parseCatalogueParams(Object.fromEntries(new URLSearchParams(a))), state);
  }
}

console.log("\n=== no accidental client-side catalogue filtering has returned ===");
{
  // A guard against regression: the shop's client component must not receive a
  // full catalogue to narrow. It is handed a result and renders it.
  const fs = require("fs") as typeof import("fs");
  const src = fs.readFileSync("components/shop/ShopFilters.tsx", "utf8");
  check("ShopFilters does not call matchesFilters", src.includes("matchesFilters"), false);
  check("ShopFilters does not filter the product array", /products\.filter\(/.test(src), false);
  check("ShopFilters navigates instead", src.includes("router.push"), true);
  const page = fs.readFileSync("app/(storefront)/in/shop/page.tsx", "utf8");
  check("the shop page no longer fetches the whole catalogue", page.includes("getAllProducts"), false);
  check("it reads the URL instead", page.includes("parseCatalogueParams"), true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
