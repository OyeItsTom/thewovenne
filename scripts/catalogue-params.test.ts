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
  isUnfiltered,
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
  { category: "sarees", fabric: "Cotton", colour: "gold", size: "M", maxPrice: 2500 }
);

check("whitespace is trimmed", parseCatalogueParams({ colour: "  gold  " }).colour, "gold");
check("an empty value is absent, not empty-string", parseCatalogueParams({ colour: "" }).colour, null);
check("a whitespace-only value is absent", parseCatalogueParams({ colour: "   " }).colour, null);

console.log("\n=== a mangled URL shows the catalogue, not an error ===");

check(
  "a repeated key takes the first value",
  parseCatalogueParams({ colour: ["gold", "white"] }).colour,
  "gold",
  "a repeated key is a crafted URL, not a customer"
);
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
  parseCatalogueParams({ fabric: "x".repeat(500) }).fabric?.length,
  80
);
check(
  "unknown keys are ignored entirely",
  parseCatalogueParams({ colour: "gold", sneaky: "1", page: "9" }),
  { ...NO_FILTERS, colour: "gold" },
  "including keys later work will add — they simply do not exist yet"
);

console.log("\n=== writing a URL ===");

check("nothing set produces no query string", catalogueSearchString(NO_FILTERS), "");
check("and a bare path", catalogueHref("/in/shop", NO_FILTERS), "/in/shop");

const someFilters = {
  category: "sarees",
  fabric: null,
  colour: "gold",
  size: null,
  maxPrice: 2500,
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
    maxPrice: 2500,
    size: null,
    colour: "gold",
    fabric: null,
    category: "sarees",
  }),
  "category=sarees&colour=gold&maxPrice=2500",
    "deterministic writing; full faceted SEO policy is separate work"
);

check(
  "values that need escaping are escaped",
  catalogueSearchString({ ...NO_FILTERS, fabric: "Handloom 120 count mul cotton" }),
  "fabric=Handloom+120+count+mul+cotton"
);

console.log("\n=== a URL survives the round trip ===");

for (const original of [
  NO_FILTERS,
  { ...NO_FILTERS, colour: "gold" },
  { ...NO_FILTERS, category: "sarees", maxPrice: 1500 },
  { category: "shirts", fabric: "Cotton", colour: "white", size: "M", maxPrice: 3500 },
  { ...NO_FILTERS, fabric: "Handloom 120 count mul cotton" },
]) {
  const search = catalogueSearchString(original);
  const params = Object.fromEntries(new URLSearchParams(search).entries());
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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
