/** Effective-version and literal catalogue rules, without a database. */
import {
  filterEffectiveCatalogueRows,
  mapListingProduct,
  sameCatalogueValue,
  type ProductListingRow,
} from "../lib/products";
import type { Category } from "../lib/types";

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

const parent: Category = {
  id: "parent", name: "Women", slug: "women", parent_id: null,
  is_visible: true, sort_order: 0, created_at: "2026-01-01",
};
const visible: Category = {
  id: "visible", name: "Sarees", slug: "sarees", parent_id: "parent",
  is_visible: true, sort_order: 1, created_at: "2026-01-01",
};
const other: Category = {
  id: "other", name: "Dresses", slug: "dresses", parent_id: "parent",
  is_visible: true, sort_order: 2, created_at: "2026-01-01",
};
const cats = new Map([parent, visible, other].map((c) => [c.id, c]));

function row(
  product_id: string,
  state: "published" | "draft",
  patch: Record<string, unknown> = {}
): ProductListingRow & { fabric: string | null; colour: string | null } {
  return {
    product_id, state, name: product_id, slug: product_id, price_inr: 2000,
    category_id: "visible", stock_quantity: 2, image_url: "cover.jpg",
    is_active: true, created_at: "2026-01-01", discount_type: null,
    discount_value: null, discount_starts_at: null, discount_ends_at: null,
    product_images: [{ url: "cover.jpg", sort_order: 0 }, { url: "detail.jpg", sort_order: 1 }],
    fabric: "Cotton", colour: "Gold", ...patch,
  };
}

const ids = (rows: ProductListingRow[]) => rows.map((r) => r.product_id);
const effective = (
  rows: ProductListingRow[],
  filters: Record<string, unknown>,
  sizes: Set<string> | null = null
) => ids(filterEffectiveCatalogueRows(rows, filters, ["parent", "visible", "other"], cats, sizes));

console.log("\n=== a draft supersedes before filtering ===");
check("draft category stops published category match", effective([
  row("p", "published"), row("p", "draft", { category_id: "other" }),
], { category: "sarees" }), []);
check("draft fabric stops published fabric match", effective([
  row("p", "published"), row("p", "draft", { fabric: "Linen" }),
], { fabric: "Cotton" }), []);
check("draft colour stops published colour match", effective([
  row("p", "published"), row("p", "draft", { colour: "Blue" }),
], { colour: "Gold" }), []);
check("draft price stops published price match", effective([
  row("p", "published"), row("p", "draft", { price_inr: 3000 }),
], { maxPrice: 2500 }), []);
check("inactive draft hides active published row", effective([
  row("p", "published"), row("p", "draft", { is_active: false }),
], {}), []);
check("pending-delete draft hides published row", effective([
  row("p", "published"), row("p", "draft", { pending_delete: true }),
], {}), []);

console.log("\n=== literal values ===");
check("mixed case matches", sameCatalogueValue("Cotton", "cOtToN"), true);
check("surrounding whitespace is ignored", sameCatalogueValue("  Cotton ", " Cotton"), true);
check("percent is literal", sameCatalogueValue("Cotton", "%"), false);
check("underscore is literal", sameCatalogueValue("Cotton", "_"), false);
check("backslash is literal", sameCatalogueValue("Cotton", "\\"), false);
check("literal metacharacters can still be real values", sameCatalogueValue("50%_Cotton\\", "50%_cotton\\"), true);

console.log("\n=== size and public boundaries ===");
check("size set admits multiple matching product ids", effective([
  row("a", "published"), row("b", "published"), row("c", "published"),
], {}, new Set(["a", "b"])), ["a", "b"]);
check("a hidden category cannot pass through a size match", ids(filterEffectiveCatalogueRows([
  row("hidden", "published", { category_id: "hidden-category" }),
], {}, ["visible"], cats, new Set(["hidden"]))), []);
check("published-only input remains published-only", effective([
  row("p", "published"),
], { fabric: "Cotton" }), ["p"]);

console.log("\n=== listing projection and gallery ===");
const mapped = mapListingProduct(row("p", "draft", {
  product_images: [
    { url: "third.jpg", sort_order: 2 },
    { url: "cover.jpg", sort_order: 0 },
    { url: "second.jpg", sort_order: 1 },
  ],
}), cats);
check("cover leads and manual gallery order survives", mapped.images, ["cover.jpg", "second.jpg", "third.jpg"]);
check("rich detail fields are absent from listing data", {
  description: "description" in mapped, video: "video_youtube_id" in mapped,
  fabric: "fabric" in mapped, colour: "colour" in mapped, collection: "collection" in mapped,
}, { description: false, video: false, fabric: false, colour: false, collection: false });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
