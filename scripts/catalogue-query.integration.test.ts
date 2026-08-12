/**
 * Integration coverage for the real getCatalogue query orchestration.
 *
 * It uses a deterministic in-memory PostgREST client double: no production row
 * is written, while the production query function, effective-version logic,
 * projections, scoping and chained query operators all execute unchanged.
 * This is not a PostgreSQL performance benchmark or an RLS proof.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCatalogue } from "../lib/products";
import type { ReadCtx } from "../lib/readCtx";

type Row = Record<string, any>;
type Op = { kind: "eq" | "in" | "gt" | "lte" | "order" | "range"; column?: string; value?: any; values?: any[]; ascending?: boolean; from?: number; to?: number };

const categories: Row[] = [
  { category_id: "parent", state: "published", name: "Women", slug: "women", parent_id: null, is_visible: true, sort_order: 0, created_at: "2026-01-01" },
  { category_id: "sarees", state: "published", name: "Sarees", slug: "sarees", parent_id: "parent", is_visible: true, sort_order: 1, created_at: "2026-01-01" },
  { category_id: "dresses", state: "published", name: "Dresses", slug: "dresses", parent_id: "parent", is_visible: true, sort_order: 2, created_at: "2026-01-01" },
  { category_id: "hidden", state: "published", name: "Hidden", slug: "hidden", parent_id: "parent", is_visible: false, sort_order: 3, created_at: "2026-01-01" },
];

function product(product_id: string, patch: Row = {}): Row {
  return {
    product_id, state: "published", pending_delete: false, name: product_id,
    slug: product_id, description: "not sent by the public listing", price_inr: 2000,
    category_id: "sarees", fabric: " Cotton ", colour: "Gold", stock_quantity: 2,
    image_url: `${product_id}-cover.jpg`, is_active: true, created_at: "2026-01-01T00:00:00Z",
    collection: null, video_youtube_id: "abcdefghijk", discount_type: null,
    discount_value: null, discount_starts_at: null, discount_ends_at: null,
    product_images: [{ url: `${product_id}-cover.jpg`, sort_order: 0 }, { url: `${product_id}-detail.jpg`, sort_order: 1 }],
    ...patch,
  };
}

const products = [
  product("a"),
  product("b", { category_id: "dresses", fabric: "Linen", colour: "Blue", price_inr: 3000 }),
  product("hidden-product", { category_id: "hidden" }),
  product("draft-only", { state: "draft", fabric: "Silk" }),
  product("a", { state: "draft", category_id: "dresses", fabric: "Linen", colour: "Blue", price_inr: 3500, image_url: "a-draft.jpg", product_images: [{ url: "a-draft.jpg", sort_order: 0 }] }),
];
const sizes = [
  { product_id: "a", label: " M ", stock_quantity: 2 },
  { product_id: "b", label: "m", stock_quantity: 1 },
  { product_id: "hidden-product", label: "M", stock_quantity: 9 },
  { product_id: "draft-only", label: "S", stock_quantity: 9 },
  { product_id: "a", label: "s", stock_quantity: 1 },
];

class Query implements PromiseLike<{ data: Row[]; error: null }> {
  private ops: Op[] = [];
  constructor(private table: string) {}
  select(_columns: string) { return this; }
  eq(column: string, value: any) { this.ops.push({ kind: "eq", column, value }); return this; }
  in(column: string, values: any[]) { this.ops.push({ kind: "in", column, values }); return this; }
  gt(column: string, value: any) { this.ops.push({ kind: "gt", column, value }); return this; }
  lte(column: string, value: any) { this.ops.push({ kind: "lte", column, value }); return this; }
  order(column: string, opts: { ascending: boolean }) { this.ops.push({ kind: "order", column, ascending: opts.ascending }); return this; }
  range(from: number, to: number) { this.ops.push({ kind: "range", from, to }); return this; }
  then<TResult1 = { data: Row[]; error: null }, TResult2 = never>(
    resolve?: ((value: { data: Row[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    reject?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    try {
      let rows: Row[] = [...(this.table === "category_versions" ? categories : this.table === "product_sizes" ? sizes : products)];
      for (const op of this.ops) {
        if (op.kind === "eq") rows = rows.filter((r) => r[op.column!] === op.value);
        if (op.kind === "in") rows = rows.filter((r) => op.values!.includes(r[op.column!]));
        if (op.kind === "gt") rows = rows.filter((r) => r[op.column!] > op.value);
        if (op.kind === "lte") rows = rows.filter((r) => r[op.column!] <= op.value);
        if (op.kind === "order") rows.sort((a, b) => {
          const cmp = String(a[op.column!]).localeCompare(String(b[op.column!]));
          return op.ascending ? cmp : -cmp;
        });
        if (op.kind === "range") rows = rows.slice(op.from, op.to! + 1);
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    } catch (error) {
      return Promise.reject(error).then(resolve, reject);
    }
  }
}

const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
const publicCtx: ReadCtx = { client, preview: false };
const previewCtx: ReadCtx = { client, preview: true };

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else { fail++; console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`); }
}
const ids = (result: Awaited<ReturnType<typeof getCatalogue>>) => result.products.map((p) => p.id);

async function main() {
console.log("\n=== production query orchestration ===");
check("normal literal filter trims and folds case", ids(await getCatalogue({ fabric: "cotton" }, {}, publicCtx)), ["a"]);
check("percent cannot broaden a filter", ids(await getCatalogue({ fabric: "%" }, {}, publicCtx)), []);
check("underscore cannot broaden a filter", ids(await getCatalogue({ fabric: "_" }, {}, publicCtx)), []);
check("multiple filters are AND", ids(await getCatalogue({ category: "dresses", fabric: "linen", maxPrice: 3000 }, {}, publicCtx)), ["b"]);
check("zero results stay zero", ids(await getCatalogue({ colour: "missing" }, {}, publicCtx)), []);
check("size is case-insensitive and trims both sides", ids(await getCatalogue({ size: " m " }, {}, publicCtx)), ["a", "b"]);
check("another size casing matches", ids(await getCatalogue({ size: "S" }, {}, publicCtx)), ["a"]);
check("hidden and draft-only rows cannot leak through sizes", ids(await getCatalogue({ size: "M" }, {}, publicCtx)), ["a", "b"]);

console.log("\n=== public versus preview ===");
check("public sees the published row only", ids(await getCatalogue({ category: "sarees", fabric: "cotton" }, {}, publicCtx)), ["a"]);
check("preview draft that moved category removes published match", ids(await getCatalogue({ category: "sarees", fabric: "cotton" }, {}, previewCtx)), []);
const previewDraft = await getCatalogue({ category: "dresses", fabric: "linen" }, {}, previewCtx);
check("preview sees the effective draft", ids(previewDraft), ["a", "b"]);
check("preview gallery comes from the draft", previewDraft.products.find((p) => p.id === "a")?.images, ["a-draft.jpg"]);

console.log("\n=== deterministic order and listing payload ===");
check("equal timestamps use product id ascending", ids(await getCatalogue({}, {}, publicCtx)), ["a", "b"]);
const listed = (await getCatalogue({}, {}, publicCtx)).products[0];
check("listing excludes rich fields", {
  description: "description" in listed, video: "video_youtube_id" in listed,
  fabric: "fabric" in listed, colour: "colour" in listed, collection: "collection" in listed,
}, { description: false, video: false, fabric: false, colour: false, collection: false });
check("listing preserves the manual card gallery", listed.images, ["a-cover.jpg", "a-detail.jpg"]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
