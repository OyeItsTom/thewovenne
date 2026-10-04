/**
 * Listings order products by when the PRODUCT was added, not when it was edited.
 *
 *   npx tsx scripts/listing-order.test.ts
 *
 * Exits non-zero on failure.
 *
 * THE DEFECT. Every storefront listing ordered by product_versions.created_at.
 * Editing a product forks a draft stamped now(), and publishing promotes it, so
 * a description fix made a piece "new": on 1 Oct 2026 the Tennis Choker
 * Necklace, added in August, went from 8th to 1st on /in/shop and the home rail
 * after a whitespace-and-wording edit.
 *
 * THE FIX. Order by the identity row's products.created_at, embedded as
 * products(created_at) and ordered as `products(created_at).desc.nullslast`,
 * then product_id. Production PostgREST was checked to accept and honour that
 * order (read-only, 1 Oct 2026). The version's created_at is still what the
 * product carries, because the sitemap's lastModified wants "when this content
 * last changed".
 *
 * The real query functions run unchanged against an in-memory PostgREST double
 * that applies filters, to-one embed ordering, nulls placement and limits the
 * way PostgREST does. No database is touched.
 */
import fs from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAllProducts,
  getCatalogue,
  getFeaturedProducts,
  getProductsByCategoryIds,
  getProductsByCollection,
} from "../lib/products";
import { buildSitemap } from "../lib/sitemapRoutes";
import type { ReadCtx } from "../lib/readCtx";

type Row = Record<string, any>;
type Op =
  | { kind: "eq" | "in" | "lte"; column: string; value: any }
  | { kind: "order"; column: string; ascending: boolean; nullsFirst?: boolean }
  | { kind: "limit" | "range"; from: number; to: number };

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (ok) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

const categories: Row[] = [
  { category_id: "women", state: "published", name: "Women", slug: "women", parent_id: null, is_visible: true, sort_order: 0, created_at: "2026-01-01" },
  { category_id: "sarees", state: "published", name: "Sarees", slug: "sarees", parent_id: "women", is_visible: true, sort_order: 1, created_at: "2026-01-01" },
  { category_id: "jewellery", state: "published", name: "Jewellery", slug: "jewellery", parent_id: null, is_visible: true, sort_order: 2, created_at: "2026-01-01" },
  { category_id: "necklace", state: "published", name: "Necklace", slug: "necklace", parent_id: "jewellery", is_visible: true, sort_order: 3, created_at: "2026-01-01" },
];

/** One published version. `added` is products.created_at; `versioned` is the version's own. */
function version(id: string, added: string | null, versioned: string, patch: Row = {}): Row {
  return {
    product_id: id, state: "published", pending_delete: false, name: id, slug: id,
    description: null, price_inr: 1000, category_id: "sarees", fabric: "Cotton", colour: null,
    stock_quantity: 1, image_url: `${id}.jpg`, is_active: true, created_at: versioned,
    collection: null, video_youtube_id: null, discount_type: null, discount_value: null,
    discount_starts_at: null, discount_ends_at: null,
    product_images: [{ url: `${id}.jpg`, sort_order: 0 }],
    // A left embed: RLS hiding the identity row yields null, not a missing product.
    products: added === null ? null : { created_at: added },
    ...patch,
  };
}

const products: Row[] = [
  // Added 18 Aug; its content was edited and republished on 1 Oct. Under the old
  // order this was first everywhere.
  version("necklace", "2026-08-18T07:37:50Z", "2026-10-01T17:06:44Z", { category_id: "necklace", price_inr: 699, stock_quantity: 1 }),
  version("ring", "2026-08-18T07:21:45Z", "2026-08-20T13:45:23Z", { category_id: "necklace", price_inr: 459 }),
  // Genuinely the newest product.
  version("new-saree", "2026-09-20T09:00:00Z", "2026-09-20T09:00:00Z", { collection: "onam-edit" }),
  // Two products added at the same instant: product_id decides.
  version("tie-b", "2026-08-15T00:00:00Z", "2026-08-15T00:00:00Z", { collection: "onam-edit" }),
  version("tie-a", "2026-08-15T00:00:00Z", "2026-09-30T00:00:00Z", { collection: "onam-edit" }),
  version("old-saree", "2026-08-13T12:11:18Z", "2026-08-20T14:04:06Z", { price_inr: 1550, stock_quantity: 0, collection: "onam-edit" }),
  // Identity row hidden from this reader: still listed, last.
  version("orphan", null, "2026-10-01T00:00:00Z"),
];
// An admin's open draft of the necklace (preview only): same identity, newer version again.
const drafts: Row[] = [
  version("necklace", "2026-08-18T07:37:50Z", "2026-10-02T08:00:00Z", { state: "draft", category_id: "necklace", name: "necklace (draft)" }),
];

const recorded: Op[][] = [];

class Query implements PromiseLike<{ data: Row[]; error: null }> {
  private ops: Op[] = [];
  constructor(private table: string) {
    if (table === "product_versions") recorded.push(this.ops);
  }
  select(_columns: string) { this.selected = _columns; return this; }
  selected = "";
  eq(column: string, value: any) { this.ops.push({ kind: "eq", column, value }); return this; }
  in(column: string, value: any[]) { this.ops.push({ kind: "in", column, value }); return this; }
  lte(column: string, value: any) { this.ops.push({ kind: "lte", column, value }); return this; }
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this.ops.push({ kind: "order", column, ascending: opts.ascending ?? true, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n: number) { this.ops.push({ kind: "limit", from: 0, to: n - 1 }); return this; }
  range(from: number, to: number) { this.ops.push({ kind: "range", from, to }); return this; }
  then<T1 = { data: Row[]; error: null }, T2 = never>(
    resolve?: ((v: { data: Row[]; error: null }) => T1 | PromiseLike<T1>) | null,
    reject?: ((r: any) => T2 | PromiseLike<T2>) | null
  ): PromiseLike<T1 | T2> {
    let rows: Row[] =
      this.table === "category_versions" ? [...categories]
      : this.table === "product_versions" ? [...products, ...drafts]
      : [];
    const orders = this.ops.filter((o): o is Extract<Op, { kind: "order" }> => o.kind === "order");
    for (const op of this.ops) {
      if (op.kind === "eq") rows = rows.filter((r) => r[op.column] === op.value);
      if (op.kind === "in") rows = rows.filter((r) => op.value.includes(r[op.column]));
      if (op.kind === "lte") rows = rows.filter((r) => r[op.column] <= op.value);
    }
    // All ORDER BY terms together, as SQL applies them — not one sort per call.
    // "rel(col)" reads a to-one embed; PostgREST's default for DESC is NULLS
    // FIRST, so nullsFirst: false is what puts a missing value last.
    const valueOf = (r: Row, column: string) => {
      const path = /^(\w+)\((\w+)\)$/.exec(column);
      return path ? r[path[1]]?.[path[2]] ?? null : r[column] ?? null;
    };
    rows.sort((a, b) => {
      for (const o of orders) {
        const va = valueOf(a, o.column);
        const vb = valueOf(b, o.column);
        if (va === vb) continue;
        const nullsFirst = o.nullsFirst ?? !o.ascending;
        if (va === null) return nullsFirst ? -1 : 1;
        if (vb === null) return nullsFirst ? 1 : -1;
        const cmp = String(va).localeCompare(String(vb));
        return o.ascending ? cmp : -cmp;
      }
      return 0;
    });
    for (const op of this.ops) {
      if (op.kind === "limit" || op.kind === "range") rows = rows.slice(op.from, op.to + 1);
    }
    if (orders.some((o) => o.column.includes("(") && !this.selected.includes(o.column))) {
      // A real PostgREST refuses to order by an embed that is not selected.
      return Promise.resolve({ data: [], error: { message: "embed not selected" } as never }).then(resolve as never, reject);
    }
    return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
  }
}

const client = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
const publicCtx: ReadCtx = { client, preview: false };
const previewCtx: ReadCtx = { client, preview: true };
const ids = (list: { id: string }[]) => list.map((p) => p.id);

// The expected order, by products.created_at: newest product first, ties by id,
// a hidden identity last. The necklace stays BEHIND the genuinely newer saree.
const ALL = ["new-saree", "necklace", "ring", "tie-a", "tie-b", "old-saree", "orphan"];
const SAREES = ["new-saree", "tie-a", "tie-b", "old-saree", "orphan"];
const JEWELLERY = ["necklace", "ring"];
const ONAM = ["new-saree", "tie-a", "tie-b", "old-saree"];
// What the old order (version created_at desc) produced, for contrast.
const OLD_ORDER_FIRST = "necklace";

async function main() {
  console.log("\n=== a content edit does not make a product new ===");
  const shop = await getCatalogue({}, {}, publicCtx);
  check("shop: original-date order", ids(shop.products), ALL);
  check("shop: the edited necklace is NOT first", shop.products[0].id !== OLD_ORDER_FIRST, true);
  check("shop: a genuinely newer product still leads", shop.products[0].id, "new-saree");
  check("shop: the necklace keeps its place behind the newer product", ids(shop.products).indexOf("necklace"), 1);
  check("shop: equal creation dates break by product id", ids(shop.products).slice(3, 5), ["tie-a", "tie-b"]);
  check("shop: a product whose identity row is hidden is kept, and sorts last", ids(shop.products).at(-1), "orphan");
  check("shop paging slices the same order", ids((await getCatalogue({}, { limit: 3, offset: 1 }, publicCtx)).products), ["necklace", "ring", "tie-a"]);

  console.log("\n=== every listing path ===");
  check("sub-category (sarees)", ids((await getCatalogue({ category: "sarees" }, {}, publicCtx)).products), SAREES);
  check("sub-category (necklace)", ids((await getCatalogue({ category: "necklace" }, {}, publicCtx)).products), JEWELLERY);
  check("root category (getProductsByCategoryIds)", ids(await getProductsByCategoryIds(["sarees"], publicCtx)), SAREES);
  check("root category, jewellery", ids(await getProductsByCategoryIds(["necklace"], publicCtx)), JEWELLERY);
  check("collection (getProductsByCollection)", ids(await getProductsByCollection("onam-edit", publicCtx)), ONAM);
  const all = await getAllProducts(publicCtx);
  check("getAllProducts — the home rail's source", ids(all), ALL);
  check("home rail for guests = getAllProducts' first 12, unsorted again", ids(all.slice(0, 12)), ALL);
  check("featured (getFeaturedProducts, limit 3)", ids(await getFeaturedProducts(3, publicCtx)), ["new-saree", "necklace", "ring"]);
  const preview = await getCatalogue({}, {}, previewCtx);
  check("admin preview: an open draft does not move the product either", ids(preview.products), ALL);
  check("admin preview: and it shows the draft", preview.products.find((p) => p.id === "necklace")?.name, "necklace (draft)");

  console.log("\n=== the query PostgREST receives ===");
  const orderOps = recorded.map((ops) => ops.filter((o) => o.kind === "order"));
  check(
    "every listing query orders by products(created_at) desc nulls last, then product_id",
    orderOps.every((o) => JSON.stringify(o) === JSON.stringify([
      { kind: "order", column: "products(created_at)", ascending: false, nullsFirst: false },
      { kind: "order", column: "product_id", ascending: true },
    ])),
    true
  );
  check("no listing query orders by the version's created_at", orderOps.flat().some((o) => (o as { column: string }).column === "created_at"), false);

  console.log("\n=== what must not change ===");
  const necklace = all.find((p) => p.id === "necklace")!;
  check("the product still carries the VERSION's created_at (sitemap lastModified)", necklace.created_at, "2026-10-01T17:06:44Z");
  const sitemap = buildSitemap({
    base: "https://www.thewovenne.com",
    products: [{ href: "/in/jewellery/necklace/necklace", created_at: necklace.created_at, category_slug: "necklace", category_parent_slug: "jewellery", collection: null }],
    categories: [],
    pages: [],
    posts: [],
  } as never);
  check(
    "sitemap lastModified for the edited product is still the content-change date",
    sitemap.find((e) => e.url.endsWith("/necklace/necklace"))?.lastModified?.toISOString(),
    "2026-10-01T17:06:44.000Z"
  );
  check("price is the stored price", necklace.price_inr, 699);
  check("stock is the stored stock", necklace.stock_quantity, 1);
  check("a sold-out piece is still listed (no stock filter added)", ids(shop.products).includes("old-saree"), true);
  check("names, slugs and images come from the version", [necklace.name, necklace.slug, necklace.image_url], ["necklace", "necklace", "necklace.jpg"]);

  console.log("\n=== source guards ===");
  const src = fs.readFileSync("lib/products.ts", "utf8");
  const ordersByVersionDate = [...src.matchAll(/\.order\("created_at"/g)].length;
  check("exactly one version-date order remains, in the ADMIN product list", ordersByVersionDate, 1);
  check("and it is getAdminProducts", /getAdminProducts[\s\S]*?\.order\("created_at", \{ ascending: false \}\)/.test(src.split("export async function getFeaturedProducts")[0]), true);
  // Was deferred here ("still no ORDER BY"); Premium UX PR 3 orders it by the
  // product's creation date and caps it after the stock check, not in SQL.
  const related = src.slice(src.indexOf("export async function getRelatedProducts"));
  check("getRelatedProducts orders by the product's own creation date, newest first",
    related.includes(".order(NEWEST_PRODUCT_FIRST, BY_NEWEST_PRODUCT)") && !related.includes(".limit("), true);
  const curated = fs.readFileSync("lib/curated.ts", "utf8");
  // PR 3: sold-out pieces are removed first (promotable only removes, never
  // re-ranks), so the rail is still getAllProducts' order.
  check("the home rail takes getAllProducts' order as-is",
    curated.includes("const buyable = promotable(all);") && curated.includes("const newest = buyable.slice(0, TARGET);") &&
    !/\.sort\(/.test(fs.readFileSync("lib/merchandising.ts", "utf8")), true);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
