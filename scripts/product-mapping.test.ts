/**
 * Every column the storefront FETCHES must survive into the Product it renders.
 *
 * This exists because it didn't. `video_youtube_id` was added to
 * PRODUCT_SELECT, arrived in the row, and was silently dropped by mapProduct —
 * which builds its result field by field rather than spreading. The product
 * page then checked `product.video_youtube_id`, got undefined, and rendered
 * nothing. Data correct, query correct, page blank.
 *
 * TypeScript could not catch it: Product's customer-facing extras are optional
 * (so cost and sku can stay admin-only), and an optional field that is never
 * assigned type-checks perfectly.
 *
 *   npx tsx scripts/product-mapping.test.ts
 */
import { PRODUCT_SELECT, mapProduct, type ProductVersionRow } from "../lib/products";

let pass = 0;
let fail = 0;
const t = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// Columns that intentionally change name or are consumed rather than copied.
const RENAMED: Record<string, string> = {
  product_id: "id",       // the stable identity id
  category_id: "category_id", // kept, and also resolved to a display name
};

const columns = PRODUCT_SELECT.split(",").map((c) => c.trim()).filter(Boolean);

console.log(`\n=== PRODUCT_SELECT fetches ${columns.length} columns ===`);

// A row with every fetched column set to something recognisable.
const row = Object.fromEntries(
  columns.map((c) => [c, `VALUE_${c}`])
) as unknown as ProductVersionRow;

const mapped = mapProduct(row, new Map()) as unknown as Record<string, unknown>;

console.log("\n=== every fetched column survives into Product ===");
for (const column of columns) {
  const key = RENAMED[column] ?? column;
  const present = key in mapped && mapped[key] !== undefined;
  t(`${column}${RENAMED[column] ? ` → ${RENAMED[column]}` : ""}`, present,
    present ? "" : "FETCHED BUT DROPPED BY mapProduct");
}

console.log("\n=== the specific regression ===");
t(
  "video_youtube_id is carried through",
  mapped.video_youtube_id === "VALUE_video_youtube_id",
  String(mapped.video_youtube_id)
);

// A null video must stay null rather than becoming undefined — the product
// page tests truthiness, and both are falsy, but null is the honest value and
// undefined is what a dropped field looks like.
const withoutVideo = mapProduct(
  { ...(row as unknown as Record<string, unknown>), video_youtube_id: null } as unknown as ProductVersionRow,
  new Map()
) as unknown as Record<string, unknown>;
t("a product with no video maps to null, not undefined",
  withoutVideo.video_youtube_id === null, String(withoutVideo.video_youtube_id));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
