/**
 * Admin Products list — search, filters and sort (lib/adminProductView).
 *
 *   npx --cache <dir> --yes tsx@4.19.2 scripts/admin-product-view.test.ts
 *
 * The rows below mirror the live catalogue's shape, including the two dates:
 * product_created_at (the product's age) and created_at (its latest version,
 * re-stamped by every edit). Their orders deliberately disagree, so a sort that
 * reads the wrong one fails here.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_VIEW,
  NOT_SET,
  applyProductView,
  isDefaultView,
  optionsFor,
  type ProductView,
} from "../lib/adminProductView";
import type { Product } from "../lib/types";

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

function row(p: Partial<Product> & Pick<Product, "id" | "name">): Product {
  return {
    slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    description: null,
    price_inr: 1000,
    category_id: "c",
    category: "Sarees",
    category_slug: "sarees",
    category_parent_slug: "women",
    fabric: "Cotton",
    colour: "Off-white",
    stock_quantity: 1,
    image_url: null,
    is_active: true,
    created_at: "2026-10-01T00:00:00Z",
    product_created_at: "2026-08-01T00:00:00Z",
    collection: null,
    discount_type: null,
    discount_value: null,
    discount_starts_at: null,
    discount_ends_at: null,
    ...p,
  } as Product;
}

// created_at = latest version (edits re-stamp it); product_created_at = age.
const P: Product[] = [
  row({ id: "1", name: "Magenta Border with Green Lines Saree", slug: "magenta-w-green-lines-border", fabric: "Handloom 120 count mul cotton", price_inr: 1599, stock_quantity: 1, product_created_at: "2026-08-10T00:00:00Z", created_at: "2026-10-03T06:20:00Z" }),
  row({ id: "2", name: "Pink Tie-Dye Saree with Gold Zari Border", slug: "zari-tie-dye-pin", colour: "Off-white", price_inr: 1599, stock_quantity: 1, product_created_at: "2026-08-12T00:00:00Z", created_at: "2026-10-03T06:22:00Z" }),
  row({ id: "3", name: "Red Micro Check Saree", slug: "micro-check-red", price_inr: 1599, stock_quantity: 0, product_created_at: "2026-08-05T00:00:00Z", created_at: "2026-10-03T05:00:00Z" }),
  row({ id: "4", name: "Maroon temple border", slug: "maroon-temple-border", fabric: "Handloom 120 count mul cotton", is_active: false, price_inr: 1599, stock_quantity: 1, product_created_at: "2026-08-14T00:00:00Z", created_at: "2026-08-14T00:00:00Z" }),
  row({ id: "5", name: "Tennis Choker Necklace", slug: "tennis-choker-necklace", category: "Necklace", category_slug: "necklace", category_parent_slug: "jewellery", fabric: null, colour: null, price_inr: 699, stock_quantity: 1, product_created_at: "2026-08-18T07:37:00Z", created_at: "2026-10-03T05:10:00Z" }),
  row({ id: "6", name: "Two-Line Check Saree", slug: "two-line-check", price_inr: 1550, stock_quantity: 0, product_created_at: "2026-08-02T00:00:00Z", created_at: "2026-10-03T06:28:00Z", collection: "onam-edit" }),
  row({ id: "7", name: "Off-White Dhoti with Gold Zari Border", slug: "zari-dhoti", category: "Dhoti", category_slug: "dhotis", category_parent_slug: "men", colour: null, price_inr: 1299, stock_quantity: 2, product_created_at: "2026-08-08T00:00:00Z", created_at: "2026-10-03T06:21:00Z" }),
  row({ id: "8", name: "Green and Violet Tie-Dye Saree", slug: "tie-dye-green-and-violet", colour: "off-white", price_inr: 1599, stock_quantity: 1, product_created_at: null, created_at: "2026-10-03T06:27:00Z" }),
];
const DRAFTS = new Set(["3"]);
const v = (over: Partial<ProductView>): ProductView => ({ ...DEFAULT_VIEW, ...over });
const names = (rows: Product[]) => rows.map((r) => r.name);
const ids = (rows: Product[]) => rows.map((r) => r.id);
const run = (over: Partial<ProductView>) => applyProductView(P, v(over), DRAFTS);

console.log("\nSearch");
check("1. exact name", names(run({ query: "Red Micro Check Saree" })), ["Red Micro Check Saree"]);
check("2. partial name", names(run({ query: "micro" })), ["Red Micro Check Saree"]);
check("3. case-insensitive", ids(run({ query: "MAGENTA" })), ["1"]);
check("4. fabric (name or Fabric contains cotton)", ids(run({ query: "mul cotton", sort: "name-asc" })), ["1", "4"]);
check("   plain “cotton” finds every cotton product (all but the necklace)", run({ query: "cotton" }).some((p) => p.id === "5") || run({ query: "cotton" }).length !== 7, false);
check("5. colour (stored Off-white / off-white, plus the Off-White Dhoti by name)", ids(run({ query: "off-white", sort: "name-asc" })).sort(), ["1", "2", "3", "4", "6", "7", "8"]);
check("6. slug", ids(run({ query: "zari-tie-dye-pin" })), ["2"]);
check("   tie-dye finds both tie-dye sarees", ids(run({ query: "tie-dye", sort: "name-asc" })), ["8", "2"]);
check("   category / parent searchable", ids(run({ query: "jewellery" })), ["5"]);
check("   collection searchable", ids(run({ query: "onam" })), ["6"]);
check("   “hidden” does NOT match a hidden product by status", ids(run({ query: "hidden" })), []);
check("   several words must all match", ids(run({ query: "gold dhoti" })), ["7"]);

console.log("\nFilters");
check("7. Hidden", ids(run({ status: "hidden" })), ["4"]);
check("   Active excludes the hidden product", run({ status: "active" }).some((p) => p.id === "4"), false);
check("   Active count", run({ status: "active" }).length, 7);
check("   Unpublished changes = products with a pending draft", ids(run({ status: "unpublished" })), ["3"]);
check("8. In stock", run({ stock: "in" }).every((p) => p.stock_quantity > 0) && run({ stock: "in" }).length === 6, true);
check("9. Out of stock", ids(run({ stock: "out", sort: "name-asc" })), ["3", "6"]);
check("10. Fabric", ids(run({ fabric: "Handloom 120 count mul cotton", sort: "name-asc" })), ["1", "4"]);
check("    Fabric “Not set”", ids(run({ fabric: NOT_SET })), ["5"]);
check("11. Colour (case-insensitive: Off-white = off-white)", run({ colour: "Off-white" }).length, 6);
check("    Colour “Not set”", ids(run({ colour: NOT_SET, sort: "name-asc" })), ["7", "5"]);
check("12. Category", ids(run({ category: "Dhoti" })), ["7"]);
const fab = optionsFor(P, (p) => p.fabric);
check("    options derived from the rows, deduped, sorted", fab, { values: ["Cotton", "Handloom 120 count mul cotton"], hasEmpty: true });
check("    colour options collapse case", optionsFor(P, (p) => p.colour), { values: ["Off-white"], hasEmpty: true });
check("    category options", optionsFor(P, (p) => p.category).values, ["Dhoti", "Necklace", "Sarees"]);

console.log("\nSort");
check("13. Name A–Z", names(run({ sort: "name-asc" }))[0], "Green and Violet Tie-Dye Saree");
check("14. Name Z–A", names(run({ sort: "name-desc" }))[0], "Two-Line Check Saree");
check("15. Price low → high", run({ sort: "price-asc" }).map((p) => p.price_inr).slice(0, 3), [699, 1299, 1550]);
check("    Price high → low", run({ sort: "price-desc" })[run({}).length - 1].price_inr, 699);
check("16. Stock low → high", run({ sort: "stock-asc" }).map((p) => p.stock_quantity).slice(0, 2), [0, 0]);
check("    Stock high → low", run({ sort: "stock-desc" })[0].id, "7");
// Version dates and product dates disagree on purpose.
check("17. Newest product uses products.created_at (Tennis, 18 Aug), not the version date", run({ sort: "newest" })[0].id, "5");
check("    Oldest product = Two-Line (2 Aug), though its version is the most recently edited", run({ sort: "oldest" })[0].id, "6");
check("    unknown creation date sorts last both ways", [run({ sort: "newest" }).at(-1)?.id, run({ sort: "oldest" }).at(-1)?.id], ["8", "8"]);
check("18. Recently edited uses the version date (Two-Line, 06:28)", run({ sort: "recent" })[0].id, "6");
check("    …and is the default", ids(run({})), ids(run({ sort: "recent" })));

console.log("\nCombined, clear, empty");
check("19. search + filter + sort together", names(run({ query: "check", stock: "out", sort: "name-asc" })), ["Red Micro Check Saree", "Two-Line Check Saree"]);
check("    changing sort keeps the filters", names(run({ query: "check", stock: "out", sort: "name-desc" })), ["Two-Line Check Saree", "Red Micro Check Saree"]);
const busy = v({ query: "x", status: "hidden", fabric: "Cotton", colour: NOT_SET, stock: "out", sort: "price-asc", category: "Dhoti" });
check("20. Clear filters restores the default view", [isDefaultView(busy), isDefaultView(DEFAULT_VIEW), ids(applyProductView(P, DEFAULT_VIEW, DRAFTS))], [false, true, ids(run({}))]);
check("    whitespace-only search counts as default", isDefaultView(v({ query: "   " })), true);
check("21. no match → empty list (the page shows the empty-state message)", run({ query: "zzzz" }), []);

console.log("\nSafety");
const before = JSON.stringify(P);
const frozen = Object.freeze(P.map((p) => Object.freeze({ ...p })));
const out = applyProductView(frozen, v({ sort: "name-asc" }), DRAFTS);
check("22. total count unchanged by any view", [P.length, run({}).length], [8, 8]);
check("    input array and rows never mutated (frozen input works)", [JSON.stringify(P) === before, out !== (frozen as unknown)], [true, true]);
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const lib = code(fs.readFileSync(path.join(__dirname, "../lib/adminProductView.ts"), "utf8"));
const ui = code(fs.readFileSync(path.join(__dirname, "../components/admin/ProductListControls.tsx"), "utf8"));
const page = fs.readFileSync(path.join(__dirname, "../app/(admin)/admin/dashboard/products/page.tsx"), "utf8");
check("23. view logic has no database, network or write calls", /supabase|fetch\(|\.update\(|\.insert\(|\.delete\(|\.rpc\(|\.from\(\s*["']/.test(lib), false);
check("    controls have no database, network or write calls", /supabase|fetch\(|\.update\(|\.insert\(|\.delete\(|\.rpc\(|\.from\(\s*["']/.test(ui), false);
check("    every control button is type=button", (ui.match(/<button\b/g) ?? []).length === (ui.match(/type="button"/g) ?? []).length, true);
check("    the page still loads products exactly once", (page.match(/getAdminProducts\(/g) ?? []).length, 1);
const products = fs.readFileSync(path.join(__dirname, "../lib/products.ts"), "utf8");
check("    product_created_at is set only by the admin mapper", (products.match(/product_created_at/g) ?? []).length, 1);
check("    …inside mapAdminProduct", /export function mapAdminProduct[\s\S]*?product_created_at[\s\S]*?\n}/.test(products), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
