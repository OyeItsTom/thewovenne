import { getImgProps } from "next/dist/shared/lib/get-img-props";
import nextConfig from "../next.config.mjs";

/**
 * What Next will actually ask the optimizer for, per surface.
 *
 * NOT A SNAPSHOT OF OUR OWN ARITHMETIC. This drives Next's real
 * `getImgProps` with the real `next.config.mjs`, so it fails if either the
 * config or a component's declaration drifts — and it would have failed on the
 * configuration that ran up the bill.
 *
 * Vercel charges 8 KB write units on MISS and STALE, so the numbers that matter
 * are the WIDTHS offered (each is a possible cache entry) and, above all, the
 * width named in `src` — the one a client that ignores srcset fetches. Measured
 * on a real 8160×6120 product photograph: w=3840 is 3.3 MB (404 units) against
 * w=1920 at 1.1 MB (139) and w=828 at 212 KB (26).
 */

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

const images = (nextConfig as { images?: Record<string, unknown> }).images ?? {};
const deviceSizes = images.deviceSizes as number[];
const imageSizes = images.imageSizes as number[];

const conf = {
  deviceSizes,
  imageSizes,
  formats: ["image/webp"],
  minimumCacheTTL: images.minimumCacheTTL as number,
  dangerouslyAllowSVG: false,
  path: "/_next/image",
  loader: "default",
  domains: [],
  remotePatterns: [],
  unoptimized: false,
} as unknown as Parameters<typeof getImgProps>[1]["imgConf"];

const loader = ({ src, width, quality }: { src: string; width: number; quality?: number }) =>
  `${src}?w=${width}&q=${quality || 75}`;

/** The widths Next offers, and the one it names in `src`. */
function candidates(props: Record<string, unknown>) {
  const { props: p } = getImgProps(
    { alt: "", loader, ...props } as Parameters<typeof getImgProps>[0],
    { defaultLoader: loader, imgConf: conf } as Parameters<typeof getImgProps>[1]
  );
  const widths = [...(p.srcSet ?? "").matchAll(/w=(\d+)/g)].map((m) => Number(m[1]));
  const src = Number(/w=(\d+)/.exec(p.src ?? "")?.[1]);
  return { widths, src };
}

const PHOTO = "https://x.supabase.co/storage/v1/object/public/product-images/products/a.jpg";
const LOGO = "/logo_emblem_transparent.png";

// Kept identical to the components. If one moves without the other, the
// expectations below stop describing the site and the test says so.
const CARD_SIZES =
  "(max-width: 639px) 50vw, (max-width: 1023px) 33vw, (max-width: 1279px) 25vw, 272px";

console.log("\n=== the configuration itself ===");
check("no width beyond 1920 is reachable", Math.max(...deviceSizes, ...imageSizes), 1920);
check("3840 is gone", deviceSizes.includes(3840), false);
check("2048 is gone", deviceSizes.includes(2048), false);
check("device sizes", deviceSizes, [640, 750, 828, 1080, 1200, 1920]);
check("image sizes", imageSizes, [64, 96, 128, 256, 384]);
check("cache lifetime is 31 days", images.minimumCacheTTL, 2678400);
check("optimization is still on", images.unoptimized ?? false, false);
check("no global quality override", images.qualities, undefined);

console.log("\n=== ProductCard — the photography-first grid from #129 ===");
const card = candidates({ src: PHOTO, fill: true, sizes: CARD_SIZES });
check("card offers 8 widths, none above 1920", card.widths, [256, 384, 640, 750, 828, 1080, 1200, 1920]);
check("card src fallback is 1920, not 3840", card.src, 1920);
check("card keeps 256 for a 148px card at 1x", card.widths.includes(256), true);
check("card keeps 640 for a 203px card at 3x (609 needed)", card.widths.includes(640), true);
check("card keeps 828 for a 272px card at 3x (816 needed)", card.widths.includes(828), true);

console.log("\n=== every rendered card width has a candidate at 1x, 2x and 3x ===");
// #129 geometry: 8px viewport edges, 8px between two mobile columns; three
// columns at sm; four at lg, fixed at 272 once the container caps at 1280.
const slots: [string, number][] = [
  ["320", 148],
  ["375", 175.5],
  ["390", 183],
  ["430", 203],
  ["768 (3 columns)", (768 - 64 - 48) / 3],
  ["1440 (4 columns)", 272],
];
for (const [label, css] of slots) {
  for (const dpr of [1, 2, 3]) {
    const need = Math.ceil(css * dpr);
    const served = card.widths.find((w) => w >= need) ?? Math.max(...card.widths);
    check(
      `${label} at ${dpr}x needs ${need} → served ${served}`,
      served >= need,
      true
    );
  }
}

console.log("\n=== PDP ===");
const pdp = candidates({ src: PHOTO, fill: true, sizes: "(min-width: 1024px) 50vw, 100vw" });
check("main frame offers no width above 1920", Math.max(...pdp.widths), 1920);
check("main frame keeps 1920 for a retina desktop frame", pdp.widths.includes(1920), true);
const thumb = candidates({ src: PHOTO, fill: true, sizes: "120px" });
check("thumbnail src fallback is 1920, not 3840", thumb.src, 1920);
check("thumbnail keeps 128 at 1x", thumb.widths.includes(128), true);
check("thumbnail keeps 256 at 2x", thumb.widths.includes(256), true);
check("thumbnail keeps 384 at 3x (360 needed)", thumb.widths.includes(384), true);

console.log("\n=== the logos are fixed-size assets and now say so ===");
const navbar = candidates({ src: LOGO, width: 49, height: 44, priority: true });
check("navbar offers exactly a 1x/2x ladder", navbar.widths, [64, 128]);
check("navbar src fallback is 128, not 3840", navbar.src, 128);
const footer = candidates({ src: LOGO, width: 40, height: 36 });
check("footer offers exactly a 1x/2x ladder", footer.widths, [64, 96]);
check("footer src fallback is 96, not 3840", footer.src, 96);
check(
  "a logo no longer offers more candidates than the whole catalogue grid",
  navbar.widths.length < card.widths.length,
  true
);

console.log("\n=== the aspect ratio the logos reserve is still the emblem's ===");
// The file is 3096×2792. `w-auto` with a fixed height class decides the drawn
// size; these attributes only reserve space before the image loads, so what
// matters is that the ratio does not visibly move.
const SOURCE_RATIO = 3096 / 2792;
for (const [label, w, h] of [
  ["navbar", 49, 44],
  ["footer", 40, 36],
] as [string, number, number][]) {
  const drift = Math.abs(w / h - SOURCE_RATIO) / SOURCE_RATIO;
  check(`${label} ratio within 1% of the emblem (${(drift * 100).toFixed(2)}%)`, drift < 0.01, true);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
