/**
 * What a product page may say about looking after a piece (SEO-6A).
 *
 *   npx tsx scripts/product-care.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHY THIS EXISTS. Every product without a hand-written care note fell back to
 * one generic list — hand wash, line dry, iron low, "Handcrafted — slight
 * variations are natural, not flaws" — because none of the live fabric labels
 * ("Cotton", "Handloom 120 count mul cotton", "Tissue Cotton") is a key in the
 * fabric table. That put ironing instructions on a gold-plated copper necklace,
 * a craft claim on pieces nobody has verified as handmade, and "Made to last"
 * above all of it. Those statements are read by customers and by every
 * crawler that quotes the page.
 *
 * THE RULE: only the note written for THIS piece. No generic list, no advice
 * generated from a fabric label, nothing for jewellery that was not written for
 * it, and no empty section.
 *
 * Accessed through the module namespace so that, run against the code before
 * SEO-6A, missing behaviour reports as FAIL rather than an import error.
 */
import fs from "node:fs";
import path from "node:path";
import * as care from "../lib/care";

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
function attempt<T>(fn: () => T): T | "THREW" {
  try {
    return fn();
  } catch {
    return "THREW";
  }
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const api = care as unknown as {
  careFor?: (input: { careNote: string | null }) => unknown;
  CARE_BY_FABRIC?: Record<string, string[]>;
  DEFAULT_CARE?: string[];
};
const careOf = (careNote: string | null) => attempt(() => api.careFor!({ careNote }));

console.log("\n=== WHAT CARE A PAGE SHOWS: A WRITTEN NOTE, OR NOTHING ===");

const NOTE = "Dry clean only.\nStore folded in muslin.";
check("a written note is shown", careOf(NOTE), { source: "written", text: NOTE });
check("its paragraph breaks survive", (careOf(NOTE) as { text?: string }).text?.includes("\n"), true);
check("a written note is trimmed", careOf(`  ${NOTE}\n `), { source: "written", text: NOTE });
check("no note → nothing", careOf(null), null);
check("an empty note → nothing", careOf(""), null);
check("a whitespace-only note → nothing", careOf("   \n\t "), null);

/*
 * Kind and fabric are deliberately NOT inputs. Jewellery with no note, a
 * garment with no fabric, a garment with a live label, a garment whose label
 * IS a table key, a product filed nowhere: every one of them gets the same
 * answer as "no note", which is nothing. Passing the fields anyway proves they
 * cannot switch a fallback back on.
 */
const table = api.CARE_BY_FABRIC ?? {};
const probe = (extra: Record<string, unknown>) =>
  attempt(() => (api.careFor as (i: Record<string, unknown>) => unknown)({ careNote: null, ...extra }));
const cases: [string, Record<string, unknown>][] = [
  ["jewellery without a note", { kind: "jewellery", fabric: null }],
  ["garment with missing fabric", { kind: "garment", fabric: null }],
  ["garment, live label \"Cotton\"", { kind: "garment", fabric: "Cotton" }],
  ["garment, live label \"Handloom 120 count mul cotton\"", { kind: "garment", fabric: "Handloom 120 count mul cotton" }],
  ["garment, live label \"Tissue Cotton\"", { kind: "garment", fabric: "Tissue Cotton" }],
  ["garment, unknown fabric", { kind: "garment", fabric: "Silk Blend" }],
  ["unknown category", { kind: "unknown", fabric: null }],
];
for (const key of Object.keys(table)) {
  cases.push([`garment, EXACT table label "${key}" (the table stays dormant)`, { kind: "garment", fabric: key }]);
}
for (const [label, extra] of cases) check(`${label} → nothing`, probe(extra), null);
check("jewellery WITH a written note → the note",
  attempt(() => (api.careFor as (i: Record<string, unknown>) => unknown)({ careNote: NOTE, kind: "jewellery" })),
  { source: "written", text: NOTE });
ok("the dormant table still exists as reference data", Object.keys(table).length > 0);

console.log("\n=== NO UNVERIFIED FALLBACK REMAINS ===");

const lib = read("lib/care.ts");
ok("the generic fallback list is gone", api.DEFAULT_CARE === undefined && !lib.includes("DEFAULT_CARE"));
ok("no 'Handcrafted' claim in the care module", !/handcrafted/i.test(lib));
ok("no 'variations are natural' claim", !/variations are natural/i.test(lib));
const careFn = lib.slice(lib.indexOf("export function careFor"));
ok("careFor never reads the fabric table", careFn.length > 0 && !careFn.includes("CARE_BY_FABRIC"));
ok("careFor has no fabric or kind input", !/fabric|kind/.test(careFn.slice(0, careFn.indexOf("{\n"))));
ok("nothing outside lib/care imports the table",
  ![read("components/product/MaterialCare.tsx"), read("components/product/ProductDetail.tsx")].some((f) => f.includes("CARE_BY_FABRIC")));

const materialCare = read("components/product/MaterialCare.tsx");
ok("MaterialCare no longer says 'Made to last'", !materialCare.includes("Made to last"));
ok("MaterialCare no longer decides care itself", !/CARE_BY_FABRIC|DEFAULT_CARE/.test(materialCare));
ok("MaterialCare renders no list of generated lines", !/careLines|\.map\(\(line\)/.test(materialCare));
ok("MaterialCare renders the written note", materialCare.includes("{care.text}"));

const detail = read("components/product/ProductDetail.tsx");
ok("care comes only from the written note",
  detail.includes("careFor({ careNote: knowledge?.care ?? null })"));
ok("the section is only rendered when there is care to show",
  /\{care && <MaterialCare fabric=\{product\.fabric\} care=\{care\} \/>\}/.test(detail));

console.log("\n=== RELATED PRODUCTS — WORDING ONLY ===");

ok("'More From the Loom' is gone from the product page", !detail.includes("More From the Loom"));
check("one eyebrow for every category", (detail.match(/More to Discover/g) ?? []).length, 1);
ok("the heading is unchanged", detail.includes("You May Also Like"));
ok("the eyebrow is not branched on kind", !/kind[^\n]*More to Discover|More to Discover[^\n]*kind/.test(detail));
ok("the grid still renders the same related list", detail.includes("<ProductGrid products={related} />"));
for (const route of [
  "app/(storefront)/in/[slug]/[child]/[product]/page.tsx",
  "app/(storefront)/in/product/[slug]/page.tsx",
]) {
  ok(`${route}: recommendation query unchanged`,
    read(route).includes("getRelatedProducts(product.category_id, product.slug, 4)"));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
