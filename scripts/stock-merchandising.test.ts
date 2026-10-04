/**
 * Stock-aware merchandising (Premium UX PR 3): promotions show only pieces that
 * can be bought, listings keep sold-out pieces after the buyable ones, and the
 * new-arrivals rail stays ordered by each product's ORIGINAL creation date.
 *
 *   npx tsx scripts/stock-merchandising.test.ts
 *
 * Exits non-zero on failure. No database is touched: getRelatedProducts runs
 * against an in-memory PostgREST double, and CuratedForYou is rendered with
 * react-dom/server.
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPurchasable, promotable } from "../lib/merchandising";
import { curate } from "../lib/curated";
import { orderForDiscovery } from "../lib/catalogueDiscovery";
import { getRelatedProducts } from "../lib/products";
import { stockState } from "../lib/stock";
import type { ReadCtx } from "../lib/readCtx";
import type { Product } from "../lib/types";
import CuratedForYou from "../components/home/CuratedForYou";

(globalThis as { React?: typeof React }).React = React;

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${good ? "PASS" : "FAIL"}  ${name}`);
  if (good) pass++;
  else {
    fail++;
    console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}
const ok = (name: string, condition: boolean) => check(name, condition, true);
const read = (p: string) => fs.readFileSync(p, "utf8");
const ids = (list: { id: string }[]) => list.map((p) => p.id);

function item(id: string, stock: number, patch: Partial<Product> = {}): Product {
  return {
    id, name: id, slug: id, description: "", price_inr: 1500, category_id: "sarees",
    category: "Sarees", category_slug: "sarees", category_parent_slug: "women",
    fabric: "Cotton", colour: "Off-white", stock_quantity: stock, image_url: `/${id}.jpg`,
    is_active: true, created_at: "2026-01-01T00:00:00Z", collection: null,
    discount_type: null, discount_value: null, discount_starts_at: null, discount_ends_at: null,
    images: [`/${id}.jpg`], ...patch,
  } as Product;
}

// ── 1. the rule ──────────────────────────────────────────────────────────────

console.log("\n=== what may be promoted ===");
const MIXED = [item("a", 1), item("b-sold", 0), item("c", 2), item("d-sold", 0), item("e", 1)];
const allIn = [item("a", 1), item("b", 3), item("c", 1)];
const allOut = [item("a", 0), item("b", 0)];
const oneIn = [item("a", 0), item("b", 1), item("c", 0)];

check("mixed: only buyable pieces, arrival order kept", ids(promotable(MIXED)), ["a", "c", "e"]);
check("all available: nothing removed", ids(promotable(allIn)), ["a", "b", "c"]);
check("all sold out: nothing to promote", ids(promotable(allOut)), []);
check("one available: a row of one", ids(promotable(oneIn)), ["b"]);
check("limit caps the row after removing sold-out pieces", ids(promotable(MIXED, 2)), ["a", "c"]);
check("fewer than the limit: shorter, never padded", ids(promotable(oneIn, 4)), ["b"]);
ok("an inactive piece is never promoted, whatever its stock", !isPurchasable(item("x", 5, { is_active: false })));
ok("negative stock (oversold) counts as sold out", !isPurchasable(item("x", -1)));
// Sized products: migration 0056 keeps the version's stock_quantity equal to
// the sum of its sizes by trigger, so S:0 M:0 reads 0 and S:0 M:2 reads 2.
ok("sized, every size gone (sum 0): not promoted", !isPurchasable(item("sized-out", 0)));
ok("sized, one size left (sum 2): promoted", isPurchasable(item("sized-in", 2)));
check("the promotion rule and the card's Sold out label agree on every fixture",
  [...MIXED, ...allOut, item("neg", -1)].every((p) => isPurchasable(p) === !stockState(p.stock_quantity).soldOut), true);
ok("the 0056 derivation this relies on is still in the migrations",
  read("supabase/migrations/0056_sized_stock_is_derived.sql").includes("product_size_total"));

// ── 2. the new-arrivals rail ─────────────────────────────────────────────────

console.log("\n=== From the Latest Weave ===");
// Live shape on 4 Oct 2026: 33 products, newest first by products.created_at;
// five of the twelve newest were sold out.
const LIVE = [1, 1, 2, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1]
  .map((stock, i) => item(`p${String(i + 1).padStart(2, "0")}`, stock));
const guest = curate(LIVE, null);
check("guest rail: twelve pieces", guest.products.length, 12);
check("guest rail: none sold out", guest.products.filter((p) => !isPurchasable(p)).length, 0);
check("guest rail: the twelve newest BUYABLE pieces, in catalogue order",
  ids(guest.products), ["p01", "p02", "p03", "p04", "p06", "p07", "p08", "p13", "p14", "p15", "p16", "p17"]);
check("guest rail is labelled new arrivals", guest.reason, "new");
check("all sold out: empty rail", curate(allOut, null).products, []);
check("one available: a rail of one", ids(curate(oneIn, null).products), ["b"]);
check("deterministic: same input, same rail", ids(curate(LIVE, null).products), ids(guest.products));

// ORIGINAL creation date, not the latest edit. getAllProducts returns products
// ordered by products(created_at); a later VERSION date (an edit) must not move
// a piece up. curate() never re-sorts, so a recently edited old piece stays put.
const edited = [
  item("newest", 1, { created_at: "2026-08-01T00:00:00Z" }),
  item("old-but-edited", 1, { created_at: "2026-10-03T00:00:00Z" }),
];
check("a recent edit (newer version date) does not reorder the rail",
  ids(curate(edited, null).products), ["newest", "old-but-edited"]);
const products = read("lib/products.ts");
ok("getAllProducts still orders by the product's own creation date",
  /export async function getAllProducts[\s\S]*?\.order\(NEWEST_PRODUCT_FIRST, BY_NEWEST_PRODUCT\)/.test(products) &&
  products.includes('const NEWEST_PRODUCT_FIRST = "products(created_at)"'));
ok("no random ordering anywhere in the rail", !/Math\.random/.test(read("lib/curated.ts") + read("lib/merchandising.ts")));

console.log("\n=== the personalised rail ===");
const shelf = [
  item("red-1", 1, { colour: "Red" }),
  item("red-sold", 0, { colour: "Red" }),
  item("red-2", 1, { colour: "Red" }),
  item("plain-1", 1, { category_id: "rings", fabric: null, colour: null }),
  item("plain-2", 1, { category_id: "rings", fabric: null, colour: null }),
  item("saved-sold", 0, { colour: "Red" }),
];
const personal = curate(shelf, new Set(["saved-sold"]));
ok("a sold-out saved piece still shapes taste", personal.reason === "personal");
check("…but nothing sold out is offered", personal.products.filter((p) => !isPurchasable(p)).length, 0);
check("matches first, then buyable padding", ids(personal.products), ["red-1", "red-2", "plain-1", "plain-2"]);
// The old +1 for being in stock made every in-stock piece a "match".
const unrelated = curate(
  [item("x1", 1, { category_id: "rings", fabric: null, colour: null }), item("x2", 1, { category_id: "rings", fabric: null, colour: null }), item("saved", 1, { colour: "Red" })],
  new Set(["saved"])
);
check("pieces sharing nothing with the wishlist do not make the row 'personal'", unrelated.reason, "new");
// q5 is saved and sits inside the newest twelve; only q0/q1 share s1's colour.
const big = Array.from({ length: 20 }, (_, i) =>
  item(`q${i}`, 1, { category_id: i === 5 ? "earrings" : "sarees", fabric: null, colour: i < 2 ? "Red" : i === 5 ? "Green" : null }));
const s1 = item("s1", 1, { category_id: "necklace", fabric: null, colour: "Red" });
const savedTwo = curate([...big, s1], new Set(["q5", "s1"]));
check("…and that row really is personal (two colour matches)", savedTwo.reason, "personal");
check("personal row is as long as the guest row when the shelf allows (so it can swap in)",
  savedTwo.products.length, curate([...big, s1], null).products.length);

console.log("\n=== an empty rail renders nothing ===");
check("CuratedForYou with no products renders no section",
  renderToStaticMarkup(React.createElement(CuratedForYou, { set: { products: [], reason: "new", basedOn: 0 } })), "");
ok("the rail's subtitle says the pieces are still available",
  read("components/home/CuratedForYou.tsx").includes("The most recent additions still available."));

// ── 3. related products ──────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const CATS: Row[] = [
  ["women", "Women", null, 0], ["sarees", "Sarees", "women", 1], ["rings", "Rings", "women", 2],
].map(([id, name, parent, sort]) => ({
  category_id: id, state: "published", name, slug: id, parent_id: parent,
  is_visible: true, sort_order: sort, created_at: "2026-01-01",
}));
function versionRow(id: string, stock: number, made: string, patch: Row = {}): Row {
  return {
    product_id: id, name: id, slug: id, description: null, price_inr: 1500, category_id: "sarees",
    fabric: "Cotton", colour: "Off-white", stock_quantity: stock, image_url: `/${id}.jpg`,
    is_active: true, created_at: "2026-10-01T00:00:00Z", collection: null, video_youtube_id: null,
    discount_type: null, discount_value: null, discount_starts_at: null, discount_ends_at: null,
    product_images: [], products: { created_at: made }, state: "published", ...patch,
  };
}
const orderCalls: string[] = [];
class Q implements PromiseLike<{ data: Row[]; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sorts: { col: string; asc: boolean }[] = [];
  private cap = Infinity;
  constructor(private rows: Row[], private table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, v: unknown[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  limit(n: number) { this.cap = n; return this; }
  order(col: string, opts: { ascending?: boolean } = {}) {
    if (this.table === "product_versions") orderCalls.push(`${col}:${opts.ascending === false ? "desc" : "asc"}`);
    this.sorts.push({ col, asc: opts.ascending !== false });
    return this;
  }
  private value(r: Row, col: string) {
    return col === "products(created_at)" ? (r.products as { created_at: string } | null)?.created_at ?? "" : String(r[col] ?? "");
  }
  then<A = { data: Row[]; error: null }, B = never>(
    ok1?: ((v: { data: Row[]; error: null }) => A | PromiseLike<A>) | null,
    ko?: ((e: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B> {
    const rows = this.rows
      .filter((r) => this.filters.every((f) => f(r)))
      .sort((a, b) => {
        for (const s of this.sorts) {
          const c = this.value(a, s.col).localeCompare(this.value(b, s.col));
          if (c) return s.asc ? c : -c;
        }
        return 0;
      })
      .slice(0, this.cap);
    return Promise.resolve({ data: rows, error: null }).then(ok1, ko);
  }
}
const ctxFor = (rows: Row[]): ReadCtx => ({
  client: { from: (t: string) => new Q(t === "category_versions" ? CATS : rows, t) } as unknown as SupabaseClient,
  preview: false,
});

async function relatedChecks() {
  console.log("\n=== You May Also Like ===");
  // Stored in an order that is NOT newest-first, so an unordered query would show.
  const SAREES = [
    versionRow("s-old", 1, "2026-07-29"),
    versionRow("s-sold-new", 0, "2026-08-20"),
    versionRow("s-mid", 1, "2026-08-13"),
    versionRow("current", 1, "2026-08-14"),
    versionRow("s-new", 1, "2026-08-18"),
    versionRow("s-sold-2", 0, "2026-08-19"),
    versionRow("s-older", 1, "2026-07-01"),
    versionRow("s-oldest", 1, "2026-06-01"),
    versionRow("s-off", 3, "2026-08-21", { is_active: false }),
    versionRow("ring", 1, "2026-08-22", { category_id: "rings" }),
  ];
  const related = await getRelatedProducts("sarees", "current", 4, ctxFor(SAREES));
  check("mixed: sold-out pieces left out, newest product first, four at most",
    ids(related), ["s-new", "s-mid", "s-old", "s-older"]);
  ok("the current product is never its own recommendation", !ids(related).includes("current"));
  ok("never reaches into another category to fill the row", !ids(related).includes("ring"));
  ok("query is ordered by the product's creation date, newest first",
    orderCalls.includes("products(created_at):desc"));

  const fourSoldFirst = [
    versionRow("x1", 0, "2026-08-20"), versionRow("x2", 0, "2026-08-19"),
    versionRow("x3", 0, "2026-08-18"), versionRow("x4", 0, "2026-08-17"),
    versionRow("x5", 1, "2026-08-01"),
  ];
  check("four sold-out newest pieces do not crowd out a buyable one (no LIMIT before the stock check)",
    ids(await getRelatedProducts("sarees", "current", 4, ctxFor(fourSoldFirst))), ["x5"]);

  const allSold = [versionRow("y1", 0, "2026-08-01"), versionRow("y2", 0, "2026-08-02"), versionRow("current", 1, "2026-08-03")];
  check("all others sold out: empty, so the section is not rendered",
    await getRelatedProducts("sarees", "current", 4, ctxFor(allSold)), []);
  check("only the current piece in the category: empty",
    await getRelatedProducts("sarees", "current", 4, ctxFor([versionRow("current", 1, "2026-08-03")])), []);
  check("no category: empty", await getRelatedProducts(null, "current", 4, ctxFor(SAREES)), []);

  const detail = read("components/product/ProductDetail.tsx");
  ok("the product page hides the section when there is nothing to recommend",
    detail.includes("{related.length > 0 && ("));
}

// ── 4. listings keep sold-out pieces ─────────────────────────────────────────

function listingChecks() {
  console.log("\n=== listings: in stock first, sold out after, never dropped ===");
  // onam-edit on 4 Oct 2026, newest first: Floral Set (1), Floral Saree (0), Violet (1), Parrot (1).
  const onam = [item("floral-set", 1), item("floral-saree", 0), item("violet", 1), item("parrot", 1)];
  check("collection order: buyable newest-first, then sold out", ids(orderForDiscovery(onam, null)),
    ["floral-set", "violet", "parrot", "floral-saree"]);
  check("all sold out: every piece still listed", ids(orderForDiscovery(allOut, null)), ["a", "b"]);
  ok("the collection page orders through orderForDiscovery",
    read("app/(storefront)/in/collection/[slug]/page.tsx").includes("orderForDiscovery(products, null)"));
  ok("the shop still orders through orderForDiscovery (PR 2, unchanged)",
    read("app/(storefront)/in/shop/page.tsx").includes("orderForDiscovery(matched, filters.sort)"));
  ok("category pages still order through orderForDiscovery (PR 2, unchanged)",
    read("components/shop/CategoryFilters.tsx").includes("orderForDiscovery("));
  ok("collection queries still return sold-out pieces (no stock filter in SQL)",
    !/getProductsByCollection[\s\S]*?\.gt\("stock_quantity"/.test(products));
}

// ── 5. cache ────────────────────────────────────────────────────────────────

function cacheChecks() {
  console.log("\n=== cache / revalidation ===");
  // A sale changes stock_quantity; these pages pick it up on their next ISR
  // regeneration. Nothing here adds a cache of its own.
  for (const page of [
    "app/(storefront)/in/page.tsx",
    "app/(storefront)/in/product/[slug]/page.tsx",
    "app/(storefront)/in/[slug]/[child]/[product]/page.tsx",
    "app/(storefront)/in/collection/[slug]/page.tsx",
  ]) {
    ok(`${page} revalidates every 60s`, read(page).includes("export const revalidate = 60;"));
  }
  ok("the merchandising rule holds no state of its own", !/unstable_cache|new Map\(|let /.test(read("lib/merchandising.ts")));
}

// ── 6. PR 3 polish: material block and contrast ──────────────────────────────

function polishChecks() {
  console.log("\n=== material-first PDP, quiet text that still reads ===");
  const detail = read("components/product/ProductDetail.tsx");
  const block = detail.slice(detail.indexOf("{(product.fabric || care) && ("), detail.indexOf("</dl>"));
  ok("the material block renders only when there is a stored fact to show", detail.includes("{(product.fabric || care) && ("));
  ok("it shows the stored fabric value as-is", block.includes("{product.fabric}"));
  ok("it never shows colour (stored colour is not yet reliable)", !/product\.colour/.test(block));
  ok("the care row only appears when a care note was written, and links to it",
    block.includes("{care && (") && block.includes('href="#material-care"'));
  const care = read("components/product/MaterialCare.tsx");
  ok("the care section unfolds when reached by that link", care.includes('window.location.hash === "#material-care"'));
  ok("…and clears the sticky header when scrolled to", care.includes('id="material-care" className="scroll-mt-28'));
  const quiet = [
    ["card was-price", "components/shop/ProductCard.tsx", /text-ink\/45 line-through/],
    ["PDP was-price", "components/product/ProductDetail.tsx", /text-ink\/40 line-through/],
    ["PDP breadcrumb", "components/product/ProductDetail.tsx", /Breadcrumb" className="mb-8 text-xs text-ink\/50/],
    ["sub-category breadcrumb", "app/(storefront)/in/[slug]/[child]/page.tsx", /Breadcrumb" className="text-xs text-ink\/50/],
    ["heritage/craft labels", "components/product/BrandKnowledgePanel.tsx", /text-ink\/(45|50)/],
    ["care labels", "components/product/MaterialCare.tsx", /text-ink\/(50|55)/],
    ["rail subtitle", "components/home/CuratedForYou.tsx", /text-ink\/55/],
    ["pincode placeholder", "components/product/DeliveryEstimator.tsx", /placeholder:text-ink\/35/],
  ] as const;
  for (const [name, file, low] of quiet) ok(`${name}: no sub-4.5:1 ink tint left`, !low.test(read(file)));
  const why = read("components/home/WhyLinen.tsx");
  ok("Why Us: hairline columns, no filled beige panels", why.includes("border-t border-ink/10") && !why.includes("bg-linen/60"));
  ok("Why Us: still no environmental iconography", !/\bLeaf\b|Sprout|Recycle/.test(why.replace(/No Leaf/g, "")));
}

async function main() {
  await relatedChecks();
  listingChecks();
  cacheChecks();
  polishChecks();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
