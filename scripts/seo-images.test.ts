/**
 * The product photographs Wovenne names to search engines (SEO-6A).
 *
 *   npx tsx scripts/seo-images.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHY THIS EXISTS. Supabase Storage answers every public object with
 * `X-Robots-Tag: none` unless that object was uploaded with a header saying
 * otherwise, and none of ours were. Product JSON-LD and og:image pointed at
 * those raw URLs, so the one image Google is told represents a product was an
 * image it had been told not to index. Google's merchant-listing guidance
 * requires product image URLs to be "crawlable and indexable".
 *
 * The page's own <img> never had the problem: next/image serves the photograph
 * from /_next/image on www.thewovenne.com, with no robots header. So the fix
 * names THAT url in the markup — and this file pins it to Next's real default
 * loader and the real next.config.mjs, so a config change that would turn the
 * markup's image into a 400 fails here instead of in Search Console.
 *
 * INTERIM. /_next/image is a transformation endpoint, not the stable original a
 * product feed should name. See lib/seo productImageUrl.
 *
 * Accessed through the module namespace rather than named imports, so that run
 * against the code before SEO-6A the suite reports each missing behaviour as a
 * FAIL instead of dying at import.
 */
import fs from "node:fs";
import path from "node:path";
import { getImgProps } from "next/dist/shared/lib/get-img-props";
import defaultLoader from "next/dist/shared/lib/image-loader";
import { imageConfigDefault } from "next/dist/shared/lib/image-config";
import nextConfig from "../next.config.mjs";
import * as seo from "../lib/seo";
import { productNode } from "../lib/structuredData";
import { prune } from "../lib/jsonLd";

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
/** A call that may not exist yet (pre-SEO-6A), reported rather than thrown. */
function attempt<T>(fn: () => T): T | "THREW" {
  try {
    return fn();
  } catch {
    return "THREW";
  }
}

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// The storefront's own project, as configured. The helper must never trust a
// hostname merely for ending in supabase.co.
const PROJECT = "https://wxumlixnmwgeqswknhpw.supabase.co";
const PUBLIC = `${PROJECT}/storage/v1/object/public/product-images`;
const MASTER = `${PUBLIC}/products/f9de3ab1b911639e890186d75222557e-v1.jpg`;
const LEGACY = `${PUBLIC}/products/1b56f257-152a-47ba-bfda-0452c48f5188.png`;
const SECOND = `${PUBLIC}/products/b2c5fdb7c17030ee9e11aca621c047d9-v1.jpg`;

type Variant = "jsonLd" | "openGraph";
const api = seo as unknown as {
  productImageUrl?: (src: string, variant: Variant, supabaseUrl?: string) => string;
  PRODUCT_IMAGE_VARIANTS?: Record<Variant, { width: number; quality: number }>;
};
const convert = (src: string, variant: Variant, project: string = PROJECT) =>
  attempt(() => api.productImageUrl!(src, variant, project));

/*
 * THE REFERENCE: Next's own default loader with the real next.config.mjs.
 * NODE_ENV=test skips the loader's dev-only remotePatterns lookup, which
 * needs a bundler; the string it returns is identical. NEXT_DEPLOYMENT_ID is
 * cleared because production serves no `dpl` parameter (verified on the live
 * PDP's <img src>), and the markup must name the same URL the page does.
 */
(process.env as Record<string, string | undefined>).NODE_ENV = "test";
delete process.env.NEXT_DEPLOYMENT_ID;
const images = (nextConfig as { images?: Record<string, unknown> }).images ?? {};
const imgConf = { ...imageConfigDefault, ...images, path: "/_next/image", loader: "default" };
const nextUrl = (src: string, width: number, quality = 75) =>
  `${seo.PRODUCTION_ORIGIN}${defaultLoader({
    config: imgConf as Parameters<typeof defaultLoader>[0]["config"],
    src,
    width,
    quality,
  })}`;

console.log("\n=== THE APPROVED VARIANTS, AGAINST THE REAL CONFIG ===");

check("JSON-LD variant is 1920 @ q75", api.PRODUCT_IMAGE_VARIANTS?.jsonLd, { width: 1920, quality: 75 });
check("Open Graph variant is 1200 @ q75", api.PRODUCT_IMAGE_VARIANTS?.openGraph, { width: 1200, quality: 75 });
const allowed = [...(images.deviceSizes as number[]), ...(images.imageSizes as number[])];
// Next 14.2.5 answers 400 for a width outside these lists.
ok("1920 is a width the optimizer will serve", allowed.includes(1920));
ok("1200 is a width the optimizer will serve", allowed.includes(1200));
// No `qualities` allowlist exists in this Next, so any q is accepted; if one
// is ever added, 75 must be on it.
const qualities = images.qualities as number[] | undefined;
ok("q=75 is permitted", qualities === undefined || qualities.includes(75));

console.log("\n=== A RECOGNISED PRODUCT PHOTOGRAPH ===");

check("1920 variant is exactly Next's loader output", convert(MASTER, "jsonLd"), nextUrl(MASTER, 1920));
check("1200 variant is exactly Next's loader output", convert(MASTER, "openGraph"), nextUrl(MASTER, 1200));
check("an older upload is recognised too", convert(LEGACY, "jsonLd"), nextUrl(LEGACY, 1920));
check(
  "the literal URL, spelled out",
  convert(MASTER, "jsonLd"),
  "https://www.thewovenne.com/_next/image?url=https%3A%2F%2Fwxumlixnmwgeqswknhpw.supabase.co%2Fstorage%2Fv1%2Fobject%2Fpublic%2Fproduct-images%2Fproducts%2Ff9de3ab1b911639e890186d75222557e-v1.jpg&w=1920&q=75"
);
check("stable: same input, same output", convert(MASTER, "jsonLd"), convert(MASTER, "jsonLd"));

const converted = convert(MASTER, "jsonLd");
const parsed = converted === "THREW" ? null : attempt(() => new URL(converted));
ok("the result is an absolute URL", parsed !== null && parsed !== "THREW");
if (parsed && parsed !== "THREW") {
  check("on the production origin", parsed.origin, "https://www.thewovenne.com");
  check("at the optimizer path", parsed.pathname, "/_next/image");
  check("the source survives encoding exactly", parsed.searchParams.get("url"), MASTER);
  check("no deployment parameter", parsed.searchParams.has("dpl"), false);
}

/*
 * THE MARKUP NAMES THE PAGE'S OWN IMAGE. The PDP frame's `src` is what a client
 * that ignores srcset fetches — and what Google Images already knows. The
 * JSON-LD variant must be that exact file, so it adds no new optimizer variant
 * for the JPEG a crawler receives.
 */
const frameSizes = /PDP_FRAME_SIZES\s*=\s*"([^"]+)"/.exec(read("components/product/ImageGallery.tsx"))?.[1];
ok("found the PDP frame's sizes declaration", Boolean(frameSizes));
const { props: frame } = getImgProps(
  { src: MASTER, alt: "", fill: true, sizes: frameSizes } as Parameters<typeof getImgProps>[0],
  { defaultLoader, imgConf } as unknown as Parameters<typeof getImgProps>[1]
);
check("JSON-LD image === the PDP frame's src", convert(MASTER, "jsonLd"), `${seo.PRODUCTION_ORIGIN}${frame.src}`);
ok("the og width is one the PDP frame already offers", (frame.srcSet ?? "").includes("&w=1200&"));

console.log("\n=== EVERYTHING ELSE IS LEFT ALONE ===");

const untouched: [string, string][] = [
  ["malformed URL", "not a url"],
  ["empty string", ""],
  ["protocol-relative", "//wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/product-images/products/a.jpg"],
  ["plain http", MASTER.replace("https://", "http://")],
  ["another Supabase project", MASTER.replace("wxumlixnmwgeqswknhpw", "someoneelse123456789")],
  ["a lookalike host", MASTER.replace(".supabase.co", ".supabase.co.evil.example")],
  ["an unrelated host", "https://placehold.co/600x800.jpg"],
  ["the first-party logo", "/logo_illustrated.png"],
  ["an absolute first-party image", "https://www.thewovenne.com/logo_illustrated.png"],
  ["a private (authenticated) object", `${PROJECT}/storage/v1/object/authenticated/product-images/products/a.jpg`],
  ["a signed object", `${PROJECT}/storage/v1/object/sign/product-images/products/a.jpg?token=x`],
  ["the transform endpoint", `${PROJECT}/storage/v1/render/image/public/product-images/products/a.jpg`],
  ["an unexpected bucket", `${PROJECT}/storage/v1/object/public/style-photos/a.jpg`],
  ["a journal image in the right bucket", `${PUBLIC}/journal/1b56f257-152a-47ba-bfda-0452c48f5188.png`],
  ["a staging upload", `${PUBLIC}/staging/abc.jpg`],
  ["a nested path", `${PUBLIC}/products/nested/a.jpg`],
  ["dot-dot traversal", `${PUBLIC}/products/../journal/a.png`],
  ["percent-encoded traversal", `${PUBLIC}/products/%2e%2e/journal/a.png`],
  ["encoded slash", `${PUBLIC}/products/a%2Fb.jpg`],
  ["a query string", `${MASTER}?download=1`],
  ["a fragment", `${MASTER}#x`],
  ["credentials in the URL", MASTER.replace("https://", "https://user:pw@")],
  ["an explicit port", MASTER.replace(".supabase.co", ".supabase.co:8443")],
  ["not an image extension", `${PUBLIC}/products/a.svg`],
  ["no extension", `${PUBLIC}/products/a`],
  ["upper-case host (not how stored URLs look)", MASTER.replace("wxumlixnmwgeqswknhpw", "WXUMLIXNMWGEQSWKNHPW")],
  ["already optimized", convert(MASTER, "jsonLd") as string],
];
for (const [label, src] of untouched) {
  check(`${label} → unchanged`, convert(src, "jsonLd"), src);
}
check("no configured project → nothing is recognised", convert(MASTER, "jsonLd", ""), MASTER);
check("a malformed configured project → nothing is recognised", convert(MASTER, "jsonLd", "nope"), MASTER);
check(
  "the configured project is compared by exact host",
  convert(MASTER, "jsonLd", "https://wxumlixnmwgeqswknhpw.supabase.co.evil.example"),
  MASTER
);
check("a trailing slash on the configured project is fine", convert(MASTER, "jsonLd", `${PROJECT}/`), nextUrl(MASTER, 1920));
check(
  "an unapproved variant is refused, not guessed",
  convert(MASTER, "hero" as Variant),
  "THREW"
);

console.log("\n=== PRODUCT JSON-LD ===");

const gallery = [MASTER, LEGACY, SECOND];
const jsonLdImages = gallery.map((src) => convert(src, "jsonLd"));
const base = {
  name: "Red saree",
  href: "/in/women/sarees/red-saree",
  description: null,
  price: 1399,
  soldOut: false,
  rating: { average: null, total: 0 },
  fabric: "Handloom 120 count mul cotton",
};
const before = prune(productNode({ ...base, images: gallery })) as Record<string, unknown>;
const after = prune(productNode({ ...base, images: jsonLdImages as string[] })) as Record<string, unknown>;

check("image count preserved", (after.image as string[]).length, gallery.length);
check("cover first, order preserved", after.image, gallery.map((src) => nextUrl(src, 1920)));
ok("no image in the markup is a raw Supabase URL", !(after.image as string[]).some((u) => u.includes("supabase.co/storage")));
ok("every image is an absolute https URL", (after.image as string[]).every((u) => u.startsWith("https://www.thewovenne.com/")));
const { image: _a, ...restAfter } = after;
const { image: _b, ...restBefore } = before;
check("everything but `image` is byte-identical — Product and Offer unchanged", restAfter, restBefore);
check("Product keys are exactly the truthful set", Object.keys(after).sort(),
  ["@context", "@type", "brand", "image", "material", "name", "offers", "url"]);
for (const invented of ["color", "sku", "gtin", "gtin13", "mpn", "countryOfOrigin", "aggregateRating", "review", "itemCondition"]) {
  ok(`no ${invented}`, !(invented in after));
}

console.log("\n=== WHERE IT IS WIRED ===");

const detail = read("components/product/ProductDetail.tsx");
const childRoute = read("app/(storefront)/in/[slug]/[child]/[product]/page.tsx");
const flatRoute = read("app/(storefront)/in/product/[slug]/page.tsx");
ok("ProductDetail maps JSON-LD images through the helper",
  /images:\s*images\.map\(\(src\)\s*=>\s*productImageUrl\(src,\s*"jsonLd"\)\)/.test(detail));
ok("the gallery still renders the stored URLs", /<ImageGallery images=\{images\}/.test(detail));
for (const [label, route] of [["canonical route", childRoute], ["flat route", flatRoute]] as const) {
  ok(`${label}: og:image goes through the helper`,
    /images:\s*\[product\.image_url \? productImageUrl\(product\.image_url, "openGraph"\) : null\]/.test(route));
  ok(`${label}: og:image is still the cover (image_url)`, route.includes("product.image_url"));
}
ok("no route hand-builds an optimizer URL", ![detail, childRoute, flatRoute].some((s) => s.includes("/_next/image")));
ok("next.config.mjs is not the fix", !read("next.config.mjs").includes("X-Robots-Tag"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
