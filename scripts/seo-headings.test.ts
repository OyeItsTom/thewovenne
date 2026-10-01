/**
 * Heading levels on the product and listing pages, and the journal's share image.
 *
 *   npx tsx scripts/seo-headings.test.ts
 *
 * Exits non-zero on failure.
 *
 * HEADINGS. The PDP went h1 → h3 ("Quantity", "Delivery", "Size") → h2
 * ("Reviews"). Shop and category pages went h1 → h3 (filter groups, product
 * names) with no h2 between. Nothing was missing on the page, only the levels
 * were wrong, so the fix changes the tags and nothing else: no words added, no
 * hidden headings, and the classes stay as they were. The base layer gives h1–h6
 * the same font-heading and nothing else (app/globals.css), so the look does not
 * move.
 *
 * JOURNAL og:image named the raw storage original, which Supabase serves with
 * `X-Robots-Tag: none`. It now names the /_next/image copy the article's own
 * <img> already loads, through the same checks productImageUrl uses.
 *
 * The components are rendered with react-dom/server, the HTML a crawler and a
 * screen reader get before hydration. The meta tags go through Next 14.2.5's
 * own resolver and generators.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { accumulateMetadata } from "next/dist/lib/metadata/resolve-metadata";
import { OpenGraphMetadata } from "next/dist/lib/metadata/generate/opengraph";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import defaultLoader from "next/dist/shared/lib/image-loader";
import { imageConfigDefault } from "next/dist/shared/lib/image-config";
import nextConfig from "../next.config.mjs";
import ProductGrid from "../components/shop/ProductGrid";
import FilterSidebar from "../components/shop/FilterSidebar";
import SizeSelector from "../components/product/SizeSelector";
import AddToCart from "../components/product/AddToCart";
import DeliveryEstimator from "../components/product/DeliveryEstimator";
import { DEFAULT_OG_IMAGE, journalImageUrl, openGraph, productImageUrl } from "../lib/seo";
import type { ProductListing } from "../lib/types";

// tsconfig has jsx "preserve", so tsx compiles components with the classic
// transform, which expects React in scope. Next supplies it in the real build.
(globalThis as { React?: typeof React }).React = React;

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
// The wishlist heart on every card calls useRouter. A router that does nothing
// is all a server render needs; no navigation happens here.
const noop = () => {};
const ROUTER = { back: noop, forward: noop, refresh: noop, push: noop, replace: noop, prefetch: noop };
const render = (el: React.ReactElement) =>
  renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: ROUTER as never }, el));
const read = (p: string) => fs.readFileSync(p, "utf8");

/** Every heading, in document order, as "h2:Text". */
function outline(html: string): string[] {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map(
    ([, level, body]) => `h${level}:${body.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim()}`
  );
}
/** The class attribute of each heading, in order — to prove the look is untouched. */
function headingClasses(html: string): string[] {
  return [...html.matchAll(/<h[1-6]\b[^>]*class="([^"]*)"/g)].map((m) => m[1]);
}
/** No level skipped on the way down, starting from the page's h1. */
function noSkips(levels: number[]): boolean {
  return levels.every((l, i) => i === 0 || l <= levels[i - 1] + 1);
}

const PRODUCT: ProductListing = {
  id: "p1",
  name: "Micro Check - Red",
  slug: "micro-check-red",
  price_inr: 2400,
  category_id: "c1",
  category: "Sarees",
  category_slug: "sarees",
  category_parent_slug: "women",
  stock_quantity: 3,
  image_url: "/products/p1.jpg",
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
  discount_type: null,
  discount_value: null,
  discount_starts_at: null,
  discount_ends_at: null,
  images: ["/products/p1.jpg"],
} as ProductListing;
const SECOND = { ...PRODUCT, id: "p2", name: "Tennis Choker Necklace", slug: "tennis-choker-necklace" };

console.log("\n=== product cards: the level comes from where the grid sits ===");
const listing = render(createElement(ProductGrid, { products: [PRODUCT, SECOND], headingLevel: 2 }));
const related = render(createElement(ProductGrid, { products: [PRODUCT, SECOND] }));
check("a listing grid's cards are h2", outline(listing), ["h2:Micro Check - Red", "h2:Tennis Choker Necklace"]);
check("by default (under 'You May Also Like', the home rails) they stay h3", outline(related), [
  "h3:Micro Check - Red",
  "h3:Tennis Choker Necklace",
]);
check("the card name's classes are identical at both levels", headingClasses(listing), headingClasses(related));
ok("a card renders no h1", !/<h1\b/.test(listing + related));

console.log("\n=== filters: h2 in the sidebar, h3 under the drawer's own h2 ===");
const filterProps = {
  options: {
    categoryGroups: [{ name: "Women", children: [{ name: "Sarees", slug: "sarees" }] }],
    fabrics: ["Cotton"],
    colours: ["Red"],
    sizes: ["M"],
  },
  filters: { category: null, fabric: null, colour: null, size: null, maxPrice: null },
  onChange: () => {},
  onClose: () => {},
};
const closed = render(createElement(FilterSidebar, { ...filterProps, isOpen: false } as never));
check("desktop sidebar groups are h2, straight under the page's h1", outline(closed), [
  "h2:Category",
  "h2:Size",
  "h2:Fabric",
  "h2:Colour",
  "h2:Price",
]);
const open = render(createElement(FilterSidebar, { ...filterProps, isOpen: true } as never));
check("the open drawer: its own h2, then the same groups as h3", outline(open), [
  "h2:Category",
  "h2:Size",
  "h2:Fabric",
  "h2:Colour",
  "h2:Price",
  "h2:Filters",
  "h3:Category",
  "h3:Size",
  "h3:Fabric",
  "h3:Colour",
  "h3:Price",
]);
check(
  "the group heading classes are unchanged at both levels",
  [...new Set(headingClasses(open).filter((c) => c !== "font-heading text-2xl text-ink"))],
  ["font-heading text-lg text-ink"]
);
const words = (html: string) => outline(html).map((h) => h.slice(3));
check("no heading text was added or removed", words(closed), ["Category", "Size", "Fabric", "Colour", "Price"]);

console.log("\n=== the listing page as it is composed: h1, then h2 ===");
// The same order the shop and category templates render: the h1, the sidebar,
// the grid, then the footer's two h2s.
const shopOutline = ["h1:Shop All", ...outline(closed), ...outline(listing), "h2:Explore", "h2:Connect"];
const shopLevels = shopOutline.map((h) => Number(h[1]));
ok("no level is skipped on a listing page", noSkips(shopLevels));
check("exactly one h1", shopLevels.filter((l) => l === 1).length, 1);
const rootCategory = ["h1:Jewellery", ...outline(listing), "h2:Explore", "h2:Connect"];
ok("no level is skipped on a root category with no filters", noSkips(rootCategory.map((h) => Number(h[1]))));

console.log("\n=== the product page's purchase column ===");
const sizes = render(
  createElement(SizeSelector, {
    sizes: [{ id: "s1", product_id: "p1", size: "M", stock_quantity: 2 }],
    selected: "M",
    onSelect: () => {},
  } as never)
);
const quantity = render(createElement(AddToCart, { product: PRODUCT, size: "" } as never));
const delivery = render(createElement(DeliveryEstimator, { market: "IN", orderValueInr: 2400 } as never));
check("Size is h2", outline(sizes), ["h2:Size"]);
check("Quantity is h2", outline(quantity).filter((h) => h.endsWith("Quantity")), ["h2:Quantity"]);
check("Delivery is h2", outline(delivery).filter((h) => h.endsWith("Delivery")), ["h2:Delivery"]);
const purchaseClass = "font-heading text-sm uppercase tracking-wider text-ink/60";
ok(
  "and all three keep the classes they had",
  [sizes, quantity, delivery].every((h) => headingClasses(h).includes(purchaseClass))
);
// The PDP as the live page orders it: h1, the purchase column, then the
// sections that already had their own h2s, then the footer.
const pdp = ["h1:Micro Check - Red", ...outline(sizes), "h2:Quantity", "h2:Delivery", "h2:Reviews", "h2:You May Also Like", ...outline(related), "h2:Explore", "h2:Connect"];
const pdpLevels = pdp.map((h) => Number(h[1]));
ok("no level is skipped on the product page", noSkips(pdpLevels));
check("exactly one h1 on the product page", pdpLevels.filter((l) => l === 1).length, 1);
ok(
  "the product page wires the related grid at the default level",
  read("components/product/ProductDetail.tsx").includes("<ProductGrid products={related} />")
);

console.log("\n=== which grids are h2, by source ===");
for (const [file, expected] of [
  ["components/shop/ShopFilters.tsx", 1],
  ["components/shop/CategoryFilters.tsx", 2],
  ["app/(storefront)/in/[slug]/page.tsx", 1],
] as const) {
  check(`${file}: every grid passes headingLevel={2}`, (read(file).match(/<ProductGrid [^>]*headingLevel=\{2\}/g) ?? []).length, expected);
  check(`${file}: and no grid is left at the default`, (read(file).match(/<ProductGrid (?![^>]*headingLevel)[^>]*\/>/g) ?? []).length, 0);
}
ok(
  "no h1 was added anywhere in the changed components",
  ["components/shop/ProductCard.tsx", "components/shop/FilterSidebar.tsx", "components/product/AddToCart.tsx", "components/product/DeliveryEstimator.tsx", "components/product/SizeSelector.tsx"].every(
    (f) => !/<h1\b|"h1"/.test(read(f))
  )
);
ok("no sr-only heading was introduced", !/<h[1-6][^>]*sr-only/.test(listing + open + sizes + quantity + delivery));

console.log("\n=== journal og:image ===");
const PROJECT = "https://wxumlixnmwgeqswknhpw.supabase.co";
const JOURNAL = `${PROJECT}/storage/v1/object/public/product-images/journal/64cd6c93-0b53-4791-b44d-480b4861a466.png`;
const PRODUCT_SRC = `${PROJECT}/storage/v1/object/public/product-images/products/f9de3ab1b911639e890186d75222557e-v1.jpg`;

const images = (nextConfig as { images?: Record<string, unknown> }).images ?? {};
const imgConf = { ...imageConfigDefault, ...images, path: "/_next/image", loader: "default" };
// As scripts/seo-images.test.ts does: Next's real default loader, at the exact
// width, against the real config.
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
delete process.env.NEXT_DEPLOYMENT_ID;
const realSrc = (src: string, width: number, quality: number) =>
  defaultLoader({ config: imgConf as Parameters<typeof defaultLoader>[0]["config"], src, width, quality });
const expected = `https://www.thewovenne.com${realSrc(JOURNAL, 1200, 75)}`;
check("a journal cover becomes the optimizer's 1200 / q75 URL, byte for byte Next's loader", journalImageUrl(JOURNAL, PROJECT), expected);
ok("it is on the production origin and names the stored original", expected.startsWith("https://www.thewovenne.com/_next/image?url=" + encodeURIComponent(JOURNAL)));
check("a product photo is NOT rewritten by the journal helper", journalImageUrl(PRODUCT_SRC, PROJECT), PRODUCT_SRC);
check("a journal photo is NOT rewritten by the product helper", productImageUrl(JOURNAL, "openGraph", PROJECT), JOURNAL);
check(
  "the product helper is unchanged: same URL as before for the same input",
  productImageUrl(PRODUCT_SRC, "openGraph", PROJECT),
  `https://www.thewovenne.com/_next/image?url=${encodeURIComponent(PRODUCT_SRC)}&w=1200&q=75`
);
for (const [label, src] of [
  ["another project's host", JOURNAL.replace("wxumlixnmwgeqswknhpw", "otherproject")],
  ["a nested journal path", `${PROJECT}/storage/v1/object/public/product-images/journal/a/b.png`],
  ["a query string", `${JOURNAL}?v=2`],
  ["a signed object", JOURNAL.replace("/object/public/", "/object/sign/")],
  ["a relative path", "/journal/a.png"],
  ["not a URL", "not a url"],
] as const) {
  check(`left exactly as given: ${label}`, journalImageUrl(src, PROJECT), src);
}
check("with no configured storage host, nothing is rewritten", journalImageUrl(JOURNAL, undefined), JOURNAL);

async function journalTags(imageUrl: string | null): Promise<string> {
  const resolved = await accumulateMetadata(
    [
      [{ metadataBase: new URL("https://www.thewovenne.com") }, null],
      [
        {
          openGraph: openGraph({
            type: "article",
            title: "Why Does Linen Crease?",
            images: [imageUrl ? journalImageUrl(imageUrl, PROJECT) : null],
          }),
        },
        null,
      ],
    ] as never,
    { pathname: "/in/journal/why-does-linen-crease", trailingSlash: false, isStandaloneMode: false } as never
  );
  return renderToStaticMarkup(createElement(OpenGraphMetadata, { openGraph: resolved.openGraph })).replace(/&amp;/g, "&");
}

async function main() {
  const withCover = await journalTags(JOURNAL);
  const withoutCover = await journalTags(null);
  console.log("\n  article with a cover:   " + (withCover.match(/<meta property="og:image"[^>]*>/) ?? [""])[0]);
  console.log("  article without one:    " + (withoutCover.match(/<meta property="og:image"[^>]*>/) ?? [""])[0] + "\n");
  ok("og:image names the optimizer URL", withCover.includes(`<meta property="og:image" content="${expected}"/>`));
  ok("og:image no longer names the raw original", !withCover.includes(`content="${JOURNAL}"`));
  ok("an article with no cover still falls back to the shared mark", withoutCover.includes(`<meta property="og:image" content="https://www.thewovenne.com${DEFAULT_OG_IMAGE}"/>`));
  ok("og:type is still article", withCover.includes('<meta property="og:type" content="article"/>'));

  const route = read("app/(storefront)/in/journal/[slug]/page.tsx");
  ok("the journal route wires the helper", route.includes("images: [post.image_url ? journalImageUrl(post.image_url) : null],"));
  ok("the article's own <img> still loads the stored URL", route.includes("src={post.image_url}"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
