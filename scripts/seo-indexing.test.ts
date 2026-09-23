/**
 * What we ask Google to index.
 *
 *   npx tsx scripts/seo-indexing.test.ts
 *
 * Exits non-zero on failure.
 *
 * Two kinds of check live here, deliberately labelled apart.
 *
 * BEHAVIOUR — the real rules, exercised through the pure functions that hold
 * them: which URLs are submitted, and which dates may honestly be claimed.
 *
 * SOURCE GUARDS — a handful of assertions about the text of four route files.
 * They exist because the defect they guard was not a logic error: a canonical
 * was written out by hand as `/${parent.slug}/${child.slug}` instead of going
 * through the helper, and the result pointed at a redirect for as long as the
 * page has existed. Nothing in a type or a unit test can catch a correct-looking
 * string; reading the file can. They are cheap, and they fail loudly the moment
 * someone writes a path by hand again.
 */
import fs from "node:fs";
import {
  buildSitemap,
  collectionSlugs,
  stockedChildKeys,
  storedDate,
  type SitemapCategory,
  type SitemapPage,
  type SitemapPost,
  type SitemapProduct,
} from "../lib/sitemapRoutes";
import { categoryHref, productHref } from "../lib/urls";
import { cPath } from "../lib/country";

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

function ok(name: string, condition: boolean, note?: string) {
  check(name, condition, true, note);
}

// ── Fixtures ──────────────────────────────────
// A catalogue shaped like the real one: sarees and dhotis carry everything,
// most sub-categories are still empty, and one section is empty end to end.

const BASE = "https://www.thewovenne.com";

const PRODUCTS: SitemapProduct[] = [
  {
    href: "/in/women/sarees/red-saree",
    created_at: "2026-08-01T10:00:00.000Z",
    category_slug: "sarees",
    category_parent_slug: "women",
    collection: null,
  },
  {
    href: "/in/women/sarees/onam-kasavu",
    created_at: "2026-08-05T10:00:00.000Z",
    category_slug: "sarees",
    category_parent_slug: "women",
    collection: "onam-edit",
  },
  {
    href: "/in/men/dhotis/zari-dhoti",
    created_at: "2026-08-09T10:00:00.000Z",
    category_slug: "dhotis",
    category_parent_slug: "men",
    collection: "onam-edit",
  },
  // Filing incomplete, so it lives at the flat fallback path. It must not make
  // any sub-category look stocked.
  {
    href: "/in/product/unfiled-piece",
    created_at: "2026-08-11T10:00:00.000Z",
    category_slug: null,
    category_parent_slug: null,
    collection: null,
  },
];

const CATEGORIES: SitemapCategory[] = [
  { slug: "women", children: [{ slug: "sarees" }, { slug: "dresses" }, { slug: "blouses" }] },
  { slug: "men", children: [{ slug: "dhotis" }, { slug: "shirts" }] },
  // Visible, linked, crawlable — and entirely empty.
  { slug: "jewellery", children: [{ slug: "chain" }, { slug: "earrings" }] },
];

const PAGES: SitemapPage[] = [
  { slug: "about", published_at: "2026-08-20T09:00:00.000Z" },
  { slug: "faq", published_at: null },
];

const POSTS: SitemapPost[] = [
  { slug: "why-does-linen-crease", created_at: "2026-07-15T08:00:00.000Z" },
];

const entries = buildSitemap({
  base: BASE,
  products: PRODUCTS,
  categories: CATEGORIES,
  pages: PAGES,
  posts: POSTS,
});
const urls = entries.map((e) => e.url);
const has = (path: string) => urls.includes(`${BASE}${path}`);

console.log("\n=== BEHAVIOUR: what the sitemap submits ===");

ok("the storefront root is submitted", has("/in"));
ok("/in/shop is submitted", has("/in/shop"));
ok("/in/journal is submitted", has("/in/journal"));
ok("/in/customer-style is submitted", has("/in/customer-style"), "public, linked, and previously omitted");

ok("/in/cart is NOT submitted", !has("/in/cart"), "a per-visitor utility page wearing the homepage's title");
ok("no checkout URL is submitted", !urls.some((u) => u.includes("/checkout")));
ok("no account URL is submitted", !urls.some((u) => u.includes("/account")));
ok("no search URL is submitted", !urls.some((u) => u.includes("/search")));
ok("no admin or api URL is submitted", !urls.some((u) => u.includes("/admin") || u.includes("/api")));

console.log("\n=== BEHAVIOUR: empty categories are not advertised ===");

ok("a sub-category holding a product is submitted", has("/in/women/sarees"));
ok("its parent is submitted with it", has("/in/women"));
ok("a second stocked section is submitted", has("/in/men") && has("/in/men/dhotis"));

ok("an empty sub-category is NOT submitted", !has("/in/women/dresses"));
ok("nor a second one", !has("/in/women/blouses"));
ok("nor one under another parent", !has("/in/men/shirts"));
ok("a wholly empty section is NOT submitted", !has("/in/jewellery"));
ok("nor any of its children", !has("/in/jewellery/chain") && !has("/in/jewellery/earrings"));

check(
  "an unfiled product marks no sub-category as stocked",
  [...stockedChildKeys(PRODUCTS)].sort(),
  ["men/dhotis", "women/sarees"]
);
ok("the unfiled product is still submitted at its fallback path", has("/in/product/unfiled-piece"),
  "a product is never dropped because its filing is half-finished");

console.log("\n=== BEHAVIOUR: collections ===");

check("collections come from products that are actually visible", collectionSlugs(PRODUCTS), ["onam-edit"]);
ok("the collection page is submitted", has("/in/collection/onam-edit"));
check(
  "a collection appears once however many products carry it",
  urls.filter((u) => u.endsWith("/in/collection/onam-edit")).length,
  1
);
check("collection slugs are sorted, so the file is stable between builds",
  collectionSlugs([
    { ...PRODUCTS[0], collection: "onam-edit" },
    { ...PRODUCTS[0], collection: "deepavali" },
  ]),
  ["deepavali", "onam-edit"]
);

console.log("\n=== BEHAVIOUR: no invented lastModified ===");

const dated = entries.filter((e) => e.lastModified !== undefined);
const knownTimestamps = new Set(
  [...PRODUCTS.map((p) => p.created_at), ...POSTS.map((p) => p.created_at), "2026-08-20T09:00:00.000Z"]
    .map((t) => new Date(t).getTime())
);
ok(
  "every date emitted traces to a stored timestamp",
  dated.every((e) => knownTimestamps.has(e.lastModified!.getTime())),
  "a `new Date()` regression fails here"
);

const at = (path: string) => entries.find((e) => e.url === `${BASE}${path}`);
check("the homepage claims no modification date", at("/in")?.lastModified, undefined);
check("nor /in/shop", at("/in/shop")?.lastModified, undefined);
check("a category claims none", at("/in/women/sarees")?.lastModified, undefined,
  "the sitemap being generated today does not mean the listing changed today");
check("a collection claims none", at("/in/collection/onam-edit")?.lastModified, undefined);
check("a page uses its published_at", at("/in/about")?.lastModified, new Date("2026-08-20T09:00:00.000Z"));
check("an unpublished page claims none", at("/in/faq")?.lastModified, undefined);
check("a product keeps its own date", at("/in/women/sarees/red-saree")?.lastModified,
  new Date("2026-08-01T10:00:00.000Z"));
check("a journal post keeps its own date", at("/in/journal/why-does-linen-crease")?.lastModified,
  new Date("2026-07-15T08:00:00.000Z"));

check("a malformed timestamp yields no date rather than Invalid Date", storedDate("not-a-date"), undefined);
check("an empty timestamp yields no date", storedDate(""), undefined);
check("a null timestamp yields no date", storedDate(null), undefined);

console.log("\n=== BEHAVIOUR: every submitted URL is absolute and /in-prefixed ===");

ok("all absolute on the configured origin", urls.every((u) => u.startsWith(`${BASE}/`)));
ok("all country-prefixed", urls.every((u) => u === `${BASE}/in` || u.startsWith(`${BASE}/in/`)),
  "a bare path would only 308 elsewhere");
ok("none ends in a trailing slash", urls.every((u) => !u.endsWith("/")));
check("no URL is submitted twice", urls.length, new Set(urls).size);

check(
  "a trailing slash on the configured origin does not double up",
  buildSitemap({ base: `${BASE}/`, products: [], categories: [], pages: [], posts: [] })[0].url,
  `${BASE}/in`
);

console.log("\n=== BEHAVIOUR: the path helpers canonicals are built from ===");

check("a sub-category href carries the market", categoryHref("women", "sarees"), "/in/women/sarees");
check("and matches what the sitemap submits", categoryHref("women", "sarees"), cPath("/women/sarees"));
check("the shop canonical is the clean path", cPath("/shop"), "/in/shop");
check(
  "a filed product's href is unchanged",
  productHref({ slug: "red-saree", category_slug: "sarees", category_parent_slug: "women" }),
  "/in/women/sarees/red-saree"
);
check(
  "an unfiled product still falls back to the flat path",
  productHref({ slug: "red-saree", category_slug: null, category_parent_slug: null }),
  "/in/product/red-saree"
);

console.log("\n=== SOURCE GUARDS: canonicals go through a helper, never a literal ===");

const read = (p: string) => fs.readFileSync(p, "utf8");
const childRoute = read("app/(storefront)/in/[slug]/[child]/page.tsx");
const shopRoute = read("app/(storefront)/in/shop/page.tsx");
const productRoute = read("app/(storefront)/in/[slug]/[child]/[product]/page.tsx");
const legacyProductRoute = read("app/(storefront)/in/product/[slug]/page.tsx");

ok("the sub-category canonical uses categoryHref",
  childRoute.includes("canonical: categoryHref(parent.slug, child.slug)"));
ok("and no hand-written unprefixed path survives in it",
  !/canonical:\s*`\/\$\{parent\.slug\}/.test(childRoute),
  "this exact literal is the defect being guarded");
ok("the shop canonical is the unfiltered path", shopRoute.includes('canonical: cPath("/shop")'));
ok("the product canonical still uses productHref, untouched",
  productRoute.includes("canonical: productHref(product)"));
ok("and so does the legacy flat product route",
  legacyProductRoute.includes("canonical: productHref(product)"));

console.log("\n=== SOURCE GUARDS: utility routes are not indexable ===");

const cartLayout = read("app/(storefront)/in/cart/layout.tsx");
const successLayout = read("app/(storefront)/in/checkout/success/layout.tsx");
const cancelLayout = read("app/(storefront)/in/checkout/cancel/layout.tsx");

ok("the cart is noindex, follow",
  cartLayout.includes("robots: { index: false, follow: true }"),
  "nothing to index, but its product links are worth following");
ok("checkout success is noindex, nofollow",
  successLayout.includes("robots: { index: false, follow: false }"));
ok("checkout cancel is noindex, nofollow",
  cancelLayout.includes("robots: { index: false, follow: false }"));
ok("each carries a title of its own rather than inheriting the homepage's",
  [cartLayout, successLayout, cancelLayout].every((f) => /title:\s*"[^"]+\| THE WOVENNE"/.test(f)));

for (const [name, file] of [
  ["checkout", "app/(storefront)/in/checkout/page.tsx"],
  ["checkout/pending", "app/(storefront)/in/checkout/pending/page.tsx"],
  ["search", "app/(storefront)/in/search/page.tsx"],
  ["login", "app/(storefront)/in/login/page.tsx"],
  ["account/orders", "app/(storefront)/in/account/orders/page.tsx"],
  ["account/wishlist", "app/(storefront)/in/account/wishlist/page.tsx"],
] as const) {
  ok(`${name} keeps the noindex it already had`, /robots:\s*\{\s*index:\s*false/.test(read(file)));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
