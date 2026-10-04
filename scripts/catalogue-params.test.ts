/**
 * The catalogue's URL contract.
 *
 * These are the rules that make a filtered listing a place rather than a mood:
 * the same URL must always mean the same thing, the same filters must always
 * produce the same URL, and a mangled link must show the catalogue rather than
 * an error.
 *
 *   npx tsx scripts/catalogue-params.test.ts
 *
 * Exits non-zero on failure.
 */
import {
  parseCatalogueParams,
  catalogueSearchString,
  catalogueHref,
  catalogueQuery,
  isUnfiltered,
  searchParamsRecord,
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

console.log("\n=== reading a URL ===");

check("an empty URL is the plain catalogue", parseCatalogueParams({}), NO_FILTERS);
check("and that reads as unfiltered", isUnfiltered(parseCatalogueParams({})), true);

check(
  "every filter is picked up",
  parseCatalogueParams({
    category: "sarees",
    fabric: "Cotton",
    colour: "gold",
    size: "M",
    maxPrice: "2500",
  }),
  { category: "sarees", fabric: ["Cotton"], colour: ["gold"], size: "M", maxPrice: 2500, inStock: false, sort: null }
);

check("whitespace is trimmed", parseCatalogueParams({ colour: "  gold  " }).colour, ["gold"]);
check("an empty value is absent, not empty-string", parseCatalogueParams({ colour: "" }).colour, []);
check("a whitespace-only value is absent", parseCatalogueParams({ colour: "   " }).colour, []);
check("an empty single-valued key is still null", parseCatalogueParams({ size: "" }).size, null);

console.log("\n=== fabric and colour are lists (PR #175) ===");

check(
  "a repeated fabric is every value, sorted",
  parseCatalogueParams({ fabric: ["Mul Cotton", "Cotton"] }).fabric,
  ["Cotton", "Mul Cotton"],
  "the same choice in any order is the same URL"
);
check(
  "a repeated colour is every value, sorted",
  parseCatalogueParams({ colour: ["Red", "Off-white"] }).colour,
  ["Off-white", "Red"]
);
check(
  "duplicates differing only by case collapse to one",
  parseCatalogueParams({ colour: ["Red", "red", " RED "] }).colour,
  ["Red"]
);
check(
  "a stored fabric sentence reads as its facet — old links keep working",
  parseCatalogueParams({ fabric: "Handloom 120 count mul cotton" }).fabric,
  ["Mul Cotton"]
);
check(
  "…and the old spelling plus the facet are one choice, not two",
  parseCatalogueParams({ fabric: ["Handloom 120 count mul cotton", "mul cotton"] }).fabric,
  ["Mul Cotton"]
);
check(
  "an unknown fabric passes through as typed, never guessed into a group",
  parseCatalogueParams({ fabric: "Linen" }).fabric,
  ["Linen"]
);
check(
  "at most eight values per list",
  parseCatalogueParams({ colour: Array.from({ length: 20 }, (_, i) => `c${String(i).padStart(2, "0")}`) }).colour.length,
  8
);
check(
  "single-valued keys still take the first value when repeated",
  parseCatalogueParams({ size: ["M", "L"], category: ["sarees", "dhotis"] }),
  { ...NO_FILTERS, size: "M", category: "sarees" }
);
check(
  "searchParamsRecord keeps repeated keys as arrays",
  searchParamsRecord(new URLSearchParams("fabric=Cotton&fabric=Mul+Cotton&colour=Red")),
  { fabric: ["Cotton", "Mul Cotton"], colour: "Red" }
);
check(
  "catalogueQuery hands the cache sorted lists, so order is never a separate key",
  catalogueQuery({ ...NO_FILTERS, fabric: ["Mul Cotton", "Cotton"], colour: ["Red", "Off-white"] }),
  { category: null, fabric: ["Cotton", "Mul Cotton"], colour: ["Off-white", "Red"], size: null, maxPrice: null, inStock: false }
);

console.log("\n=== a mangled URL shows the catalogue, not an error ===");

check(
  "a repeated single-valued key takes the first value",
  parseCatalogueParams({ maxPrice: ["1500", "9000"] }).maxPrice,
  1500,
  "a repeated price is a crafted URL, not a customer"
);
check("a fractional price is whole rupees", parseCatalogueParams({ maxPrice: "1999.6" }).maxPrice, 2000);
check("a non-numeric price is ignored", parseCatalogueParams({ maxPrice: "cheap" }).maxPrice, null);
check("a negative price is ignored", parseCatalogueParams({ maxPrice: "-500" }).maxPrice, null);
check("a zero price is ignored", parseCatalogueParams({ maxPrice: "0" }).maxPrice, null, "0 is not a ceiling anyone means");
check(
  "an absurd price is capped rather than rejected",
  parseCatalogueParams({ maxPrice: "999999999999" }).maxPrice,
  100_000_000
);
check(
  "an over-long value is truncated before it reaches a query",
  parseCatalogueParams({ fabric: "x".repeat(500) }).fabric[0]?.length,
  80
);
check(
  "unknown keys are ignored entirely",
  parseCatalogueParams({ colour: "gold", sneaky: "1", page: "9" }),
  { ...NO_FILTERS, colour: ["gold"] },
  "including keys later work will add — they simply do not exist yet"
);

console.log("\n=== writing a URL ===");

check("nothing set produces no query string", catalogueSearchString(NO_FILTERS), "");
check("and a bare path", catalogueHref("/in/shop", NO_FILTERS), "/in/shop");

const someFilters = {
  category: "sarees",
  fabric: [],
  colour: ["gold"],
  size: null,
  maxPrice: 2500,
  inStock: false,
  sort: null,
};
check(
  "only the set filters appear",
  catalogueSearchString(someFilters),
  "category=sarees&colour=gold&maxPrice=2500"
);
check("and the href joins them on", catalogueHref("/in/shop", someFilters), "/in/shop?category=sarees&colour=gold&maxPrice=2500");

check(
  "key order is fixed, not object order",
  catalogueSearchString({
    sort: null,
    inStock: false,
    maxPrice: 2500,
    size: null,
    colour: ["gold"],
    fabric: [],
    category: "sarees",
  }),
  "category=sarees&colour=gold&maxPrice=2500",
    "deterministic writing; full faceted SEO policy is separate work"
);

check(
  "values that need escaping are escaped",
  catalogueSearchString({ ...NO_FILTERS, fabric: ["Tissue Cotton"] }),
  "fabric=Tissue+Cotton"
);
check(
  "a list is written as repeated keys, in sorted order",
  catalogueSearchString({ ...NO_FILTERS, fabric: ["Mul Cotton", "Cotton"], colour: ["Red", "Off-white"] }),
  "fabric=Cotton&fabric=Mul+Cotton&colour=Off-white&colour=Red"
);

console.log("\n=== a URL survives the round trip ===");

for (const original of [
  NO_FILTERS,
  { ...NO_FILTERS, colour: ["gold"] },
  { ...NO_FILTERS, category: "sarees", maxPrice: 1500 },
  { category: "shirts", fabric: ["Cotton"], colour: ["white"], size: "M", maxPrice: 3500, inStock: true, sort: "price-desc" as const },
  { ...NO_FILTERS, fabric: ["Mul Cotton"] },
  { ...NO_FILTERS, fabric: ["Cotton", "Mul Cotton", "Tissue Cotton"], colour: ["Off-white", "Red"], maxPrice: 2000 },
]) {
  const search = catalogueSearchString(original);
  const params = searchParamsRecord(new URLSearchParams(search));
  check(
    `round trip: ${search || "(empty)"}`,
    parseCatalogueParams(params),
    original,
    "what is written can be read back unchanged"
  );
}

console.log("\n=== isUnfiltered ===");
check("any single filter counts as filtered", isUnfiltered({ ...NO_FILTERS, size: "M" }), false);
check("a price alone counts as filtered", isUnfiltered({ ...NO_FILTERS, maxPrice: 1500 }), false);
check("one colour in a list counts as filtered", isUnfiltered({ ...NO_FILTERS, colour: ["Red"] }), false);
check("an empty list does not", isUnfiltered({ ...NO_FILTERS, fabric: [] }), true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
