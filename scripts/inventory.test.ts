/**
 * lib/inventory.ts — what the admin sends when it changes stock — and the
 * places in the app that used to write stock into a draft.
 *
 * Pure and offline: no database. What the database does with these payloads
 * is proven by scripts/stock-integrity.test.ts and stock-concurrency.test.ts.
 *
 *   npx tsx scripts/inventory.test.ts
 */
import fs from "node:fs";
import { sizeChanges, stockErrorMessage, type LoadedSize } from "../lib/inventory";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        got      ${JSON.stringify(actual)}\n        expected ${JSON.stringify(expected)}`}`);
}
const throws = (fn: () => unknown) => {
  try {
    fn();
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

const loaded: LoadedSize[] = [
  { id: "s", label: "S", stock_quantity: 1 },
  { id: "m", label: "M", stock_quantity: 0 },
  { id: "l", label: "L", stock_quantity: 2 },
];
const same = () => loaded.map((l) => ({ ...l }));

console.log("\n=== sizeChanges ===");
check("nothing touched → no call at all", sizeChanges(loaded, same()), []);
check("a product with no sizes, still none → no call", sizeChanges([], []), []);
check("one count changed: every size goes with what was seen; untouched ones unchanged",
  sizeChanges(loaded, same().map((r) => (r.id === "l" ? { ...r, stock_quantity: 5 } : r))),
  [
    { label: "S", stock_quantity: 1, expected: 1 },
    { label: "M", stock_quantity: 0, expected: 0 },
    { label: "L", stock_quantity: 5, expected: 2 },
  ]);
check("reordering alone is a change (positions are saved), counts all untouched",
  sizeChanges(loaded, [same()[2], same()[0], same()[1]]).map((c) => [c.label, "stock_quantity" in c && "expected" in c && c.stock_quantity === c.expected]),
  [["L", true], ["S", true], ["M", true]]);
check("removing a size sends its seen count, first",
  sizeChanges(loaded, same().filter((r) => r.id !== "m")),
  [
    { label: "M", remove: true, expected: 0 },
    { label: "S", stock_quantity: 1, expected: 1 },
    { label: "L", stock_quantity: 2, expected: 2 },
  ]);
check("adding a size sends no expected",
  sizeChanges(loaded, [...same(), { label: "XL", stock_quantity: 3 }]).at(-1),
  { label: "XL", stock_quantity: 3 });
check("removed and re-added under the same name is one edit, checked against what was seen",
  sizeChanges(loaded, [...same().filter((r) => r.id !== "m"), { label: "m", stock_quantity: 4 }]),
  [
    { label: "S", stock_quantity: 1, expected: 1 },
    { label: "L", stock_quantity: 2, expected: 2 },
    { label: "m", stock_quantity: 4, expected: 0 },
  ]);
check("a rename is a removal of the old size and a new size",
  sizeChanges(loaded, same().map((r) => (r.id === "l" ? { ...r, label: "Large" } : r))),
  [
    { label: "L", remove: true, expected: 2 },
    { label: "S", stock_quantity: 1, expected: 1 },
    { label: "M", stock_quantity: 0, expected: 0 },
    { label: "Large", stock_quantity: 2 },
  ]);
check("a change of case only is the same size",
  sizeChanges(loaded, same().map((r) => (r.id === "s" ? { ...r, label: "s" } : r)))[0],
  { label: "s", stock_quantity: 1, expected: 1 });
check("two sizes swapping names swap counts, each checked",
  sizeChanges(loaded, same().map((r) => (r.id === "s" ? { ...r, label: "L" } : r.id === "l" ? { ...r, label: "S" } : r))),
  [
    { label: "L", stock_quantity: 1, expected: 2 },
    { label: "M", stock_quantity: 0, expected: 0 },
    { label: "S", stock_quantity: 2, expected: 1 },
  ]);
check("blank rows are dropped, as before", sizeChanges([], [{ label: "  ", stock_quantity: 3 }]), []);
check("a duplicate is refused before anything is sent",
  throws(() => sizeChanges(loaded, [...same(), { label: "m", stock_quantity: 1 }])), '"m" is listed twice.');
check("junk and negatives become 0, as the form always did",
  sizeChanges([], [{ label: "XL", stock_quantity: -4 }, { label: "XXL", stock_quantity: Number("x") }]),
  [{ label: "XL", stock_quantity: 0 }, { label: "XXL", stock_quantity: 0 }]);

console.log("\n=== stockErrorMessage ===");
check("unsized stale", stockErrorMessage("STOCK_CHANGED:0").live, 0);
check("unsized stale says nothing was overwritten", /not overwritten/.test(stockErrorMessage("STOCK_CHANGED:0").message), true);
check("sized stale names the size and the figure",
  [stockErrorMessage("STOCK_CHANGED:M:3").live, /Size M now has 3/.test(stockErrorMessage("STOCK_CHANGED:M:3").message)], [3, true]);
check("a size removed by someone else", /Size L was removed/.test(stockErrorMessage("STOCK_CHANGED:L:gone").message), true);
check("sized product in the table", /size by size/.test(stockErrorMessage("SIZED_PRODUCT").message), true);
check("duplicate", stockErrorMessage("DUPLICATE_SIZE:XL").message, '"XL" is listed twice.');
check("negative", stockErrorMessage("NEGATIVE_STOCK:XL").message, "Stock for XL can't be below zero.");
check("an old tab", /out of date/.test(stockErrorMessage("EXPECTED_REQUIRED:S").message), true);
check("anything else passes through", stockErrorMessage("Only admins can edit stock").message, "Only admins can edit stock");

// ── The app no longer writes stock into a draft ──
console.log("\n=== no descriptive save carries stock ===");
const modal = fs.readFileSync("components/admin/ProductModal.tsx", "utf8");
const payload = modal.slice(modal.indexOf("const payload = {"), modal.indexOf("setSaving(true);"));
check("ProductModal: the draft payload has no stock_quantity", /stock_quantity/.test(payload), false);
check("ProductModal: only a NEW product's draft gets stock (opening stock)",
  /isEdit\s*\?\s*payload\s*:\s*\{ \.\.\.payload, is_active: true, stock_quantity:/.test(modal), true);
check("ProductModal: an existing product's stock goes through setProductStock with the opened figure",
  /setProductStock\(\s*client,\s*savedProductId,\s*product!\.stock_quantity,/.test(modal), true);
check("ProductModal: sizes are saved against what was loaded", /saveProductSizes\(client, savedProductId, loadedSizes, sizes\)/.test(modal), true);

const table = fs.readFileSync("components/admin/ProductTable.tsx", "utf8");
check("ProductTable: the stock editor no longer patches the draft", /updateProduct\(product, \{ stock_quantity/.test(table), false);
check("ProductTable: it adjusts live stock against the row's figure",
  /setProductStock\(\s*getBrowserSupabase\(\),\s*product\.id,\s*product\.stock_quantity,/.test(table), true);

const imp = fs.readFileSync("app/api/admin/import/route.ts", "utf8");
check("import: an update's draft fields exclude stock",
  /:\s*\["name", "price_inr", "cost_price_inr", "hsn_code", "fabric", "colour"\]/.test(imp), true);
check("import: update stock goes through setProductStock with the preview's figure",
  /setProductStock\(supabase, productId, seen, Number\(target\)/.test(imp), true);
check("import: reads the shelf, not the products mirror, for the preview",
  /from\("product_versions"\)\s*\.select\("product_id, state, stock_quantity"\)/.test(imp), true);

const products = fs.readFileSync("lib/products.ts", "utf8");
check("admin list shows published stock over a draft's copy", /liveStock\.set\(row\.product_id, row\.stock_quantity\)/.test(products), true);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
