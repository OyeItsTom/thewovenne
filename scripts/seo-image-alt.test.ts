/**
 * What a product's photographs are called — in the gallery, and on a share card.
 *
 *   npx tsx scripts/seo-image-alt.test.ts
 *
 * Exits non-zero on failure.
 *
 * WHY THIS EXISTS. The gallery server-rendered every frame after the cover with
 * alt="", so the HTML a search engine reads described one photograph out of the
 * set, and the thumbnails were "{name} thumbnail {i}". Share cards carried
 * og:image with no og:image:alt at all.
 *
 * THE RULE IS TRUTHFULNESS. The only facts we hold about a photograph are the
 * product it belongs to and its position in the set — product_images has no alt
 * column. So the cover is the product's name, every later image is
 * "{name} — image {i} of {n}", and nothing here may describe a colour, an angle
 * or a detail that nobody checked.
 *
 * The gallery is rendered with react-dom/server, i.e. the same HTML the PDP
 * ships before hydration, not a reading of its source.
 */
import fs from "node:fs";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ImageGallery from "../components/product/ImageGallery";
import { DEFAULT_OG_IMAGE, openGraph, productImageAlt, productImageUrl } from "../lib/seo";
import { accumulateMetadata } from "next/dist/lib/metadata/resolve-metadata";
import { OpenGraphMetadata, TwitterMetadata } from "next/dist/lib/metadata/generate/opengraph";

// tsconfig has jsx "preserve", so tsx compiles the component with the classic
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

const NAME = "Kasavu Cotton Saree";
const PHOTOS = [1, 2, 3, 4].map((n) => `/products/p${n}.jpg`);

/** Every <img> in the markup, as its attributes. Enough HTML for our own output. */
function imgs(html: string): Record<string, string>[] {
  return [...html.matchAll(/<img\b([^>]*?)\/?>/g)].map(([, attrs]) =>
    Object.fromEntries([...attrs.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map(([, k, v]) => [k, v]))
  );
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"');

console.log("\n=== the alt helper ===");
check("the cover is the product's name", productImageAlt(NAME, 0, 4), NAME);
check("a later image says which one it is", productImageAlt(NAME, 1, 4), `${NAME} — image 2 of 4`);
check("the last one too", productImageAlt(NAME, 3, 4), `${NAME} — image 4 of 4`);
check("a single photograph is just the name", productImageAlt(NAME, 0, 1), NAME);

console.log("\n=== the gallery, as the server renders it ===");
const html = renderToStaticMarkup(createElement(ImageGallery, { images: PHOTOS, alt: NAME }));
const all = imgs(html);
const frames = all.slice(0, PHOTOS.length);
const thumbs = all.slice(PHOTOS.length);
check("one frame and one thumbnail per photograph", [frames.length, thumbs.length], [4, 4]);

check("the cover frame's alt is unchanged: the product name", decode(frames[0].alt), NAME);
check(
  "every later frame has a non-empty, positional alt",
  frames.slice(1).map((f) => decode(f.alt)),
  [`${NAME} — image 2 of 4`, `${NAME} — image 3 of 4`, `${NAME} — image 4 of 4`]
);
ok("no frame has an empty alt", frames.every((f) => f.alt !== undefined && f.alt !== ""));
check(
  "the alts say nothing but the name and the position",
  frames.every((f) => decode(f.alt).replace(NAME, "").replace(/^ — image \d+ of \d+$/, "") === ""),
  true
);

check("the showing frame is exposed to assistive tech", frames[0]["aria-hidden"], "false");
check(
  "the frames slid out of view stay hidden from screen readers",
  frames.slice(1).map((f) => f["aria-hidden"]),
  ["true", "true", "true"]
);

check(
  "thumbnails carry the same truthful alts",
  thumbs.map((t) => decode(t.alt)),
  [NAME, `${NAME} — image 2 of 4`, `${NAME} — image 3 of 4`, `${NAME} — image 4 of 4`]
);
ok("no thumbnail still says 'thumbnail N'", !/thumbnail \d/.test(html));
check(
  "thumbnail buttons keep their 'View image i of n' labels",
  [...html.matchAll(/aria-label="(View image \d+ of \d+)"/g)].map((m) => m[1]),
  ["View image 1 of 4", "View image 2 of 4", "View image 3 of 4", "View image 4 of 4"]
);
ok("the frame group keeps its position label", decode(html).includes(`aria-label="${NAME} — image 1 of 4"`));
ok("the live region still announces the position", /role="status"[^>]*>Image (?:<!-- -->)?1(?:<!-- -->)? of (?:<!-- -->)?4</.test(html));
ok("the full-screen cue keeps its label", decode(html).includes(`aria-label="View ${NAME} full screen"`));

console.log("\n=== what must not have moved ===");
check("frame src order is the stored order", frames.map((f) => decode(f.src).includes("p" + (frames.indexOf(f) + 1))), [true, true, true, true]);
check("only the cover is preloaded/eager-priority", frames.map((f) => f.fetchpriority ?? null), ["high", null, null, null]);
check("loading is unchanged: neighbour eager, far frames lazy", frames.map((f) => f.loading ?? null), [null, "eager", "lazy", "lazy"]);
check("frame sizes are unchanged", [...new Set(frames.map((f) => f.sizes))], ["(min-width: 1024px) 50vw, 100vw"]);
check("thumbnail sizes are unchanged", [...new Set(thumbs.map((t) => t.sizes))], ["120px"]);

console.log("\n=== one photograph, and none ===");
const single = imgs(renderToStaticMarkup(createElement(ImageGallery, { images: [PHOTOS[0]], alt: NAME })));
check("a single photograph: one frame, no strip, alt is the name", single.map((i) => decode(i.alt)), [NAME]);
const none = renderToStaticMarkup(createElement(ImageGallery, { images: [], alt: NAME }));
ok("no photographs: the placeholder, no <img>", none.includes("Photography coming soon") && imgs(none).length === 0);

console.log("\n=== share cards ===");
const COVER = "https://www.thewovenne.com/_next/image?url=x&w=1200&q=75";
check(
  "a product's own image carries its name as og:image:alt",
  openGraph({ title: NAME, images: [COVER], imageAlt: NAME }).images,
  [{ url: COVER, alt: NAME }]
);
check(
  "the og:image URL is the one it was given",
  (openGraph({ title: NAME, images: [COVER], imageAlt: NAME }).images[0] as { url: string }).url,
  COVER
);
check(
  "a product with no image falls back to the shared mark, WITHOUT the product's name",
  openGraph({ title: NAME, images: [null], imageAlt: NAME }).images,
  [DEFAULT_OG_IMAGE]
);
check("a blank alt adds nothing", openGraph({ title: NAME, images: [COVER], imageAlt: "  " }).images, [COVER]);
check("pages that pass no alt are unchanged", openGraph({ title: "t", images: [COVER] }).images, [COVER]);
check("pages with no image are unchanged", openGraph({ title: "t" }).images, [DEFAULT_OG_IMAGE]);

console.log("\n=== the tags Next actually writes ===");
/**
 * The <meta> tags, through Next 14.2.5's own resolver and generators — the
 * route's metadata merged under a root that only sets metadataBase, exactly as
 * a product route sits under app/layout. This is where twitter:image:alt comes
 * from: no route sets `twitter`, and Next fills it from openGraph.
 */
async function metaTags(openGraphBlock: ReturnType<typeof openGraph>): Promise<string> {
  const resolved = await accumulateMetadata(
    [
      [{ metadataBase: new URL("https://www.thewovenne.com") }, null],
      [{ title: `${NAME} | THE WOVENNE`, openGraph: openGraphBlock }, null],
    ] as never,
    { pathname: "/in/women/sarees/kasavu", trailingSlash: false, isStandaloneMode: false } as never
  );
  return decode(
    renderToStaticMarkup(
      createElement(
        React.Fragment,
        null,
        createElement(OpenGraphMetadata, { openGraph: resolved.openGraph }),
        createElement(TwitterMetadata, { twitter: resolved.twitter })
      )
    )
  );
}
const STORED =
  "https://wxumlixnmwgeqswknhpw.supabase.co/storage/v1/object/public/product-images/products/f9de3ab1b911639e890186d75222557e-v1.jpg";
const ogUrl = productImageUrl(STORED, "openGraph", "https://wxumlixnmwgeqswknhpw.supabase.co");
async function main() {
const withImage = await metaTags(openGraph({ title: NAME, images: [ogUrl], imageAlt: NAME }));
const withoutImage = await metaTags(openGraph({ title: NAME, images: [null], imageAlt: NAME }));
console.log("\n  product with a cover:\n    " + withImage.replace(/></g, ">\n    <") + "\n");
console.log("  product without one:\n    " + withoutImage.replace(/></g, ">\n    <") + "\n");

ok("og:image is the optimizer URL, unchanged", withImage.includes(`<meta property="og:image" content="${ogUrl}"/>`));
ok("og:image:alt is the product name", withImage.includes(`<meta property="og:image:alt" content="${NAME}"/>`));
ok("twitter:image is the same URL", withImage.includes(`<meta name="twitter:image" content="${ogUrl}"/>`));
ok("twitter:image:alt is the product name", withImage.includes(`<meta name="twitter:image:alt" content="${NAME}"/>`));
ok("no imageless product gets an og:image:alt", !withoutImage.includes("image:alt"));
ok(
  "an imageless product still falls back to the shared mark",
  withoutImage.includes(`<meta property="og:image" content="https://www.thewovenne.com${DEFAULT_OG_IMAGE}"/>`)
);

console.log("\n=== where it is wired ===");
for (const route of [
  "app/(storefront)/in/[slug]/[child]/[product]/page.tsx",
  "app/(storefront)/in/product/[slug]/page.tsx",
]) {
  const src = fs.readFileSync(route, "utf8");
  ok(`${route}: og image alt is the product name`, src.includes("imageAlt: product.name,"));
  ok(
    `${route}: og:image selection is untouched`,
    src.includes('images: [product.image_url ? productImageUrl(product.image_url, "openGraph") : null],')
  );
}
ok("the gallery is still given the product name", fs.readFileSync("components/product/ProductDetail.tsx", "utf8").includes("<ImageGallery images={images} alt={product.name} />"));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
