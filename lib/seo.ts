/**
 * Fallback social share image.
 *
 * Next does NOT deep-merge `openGraph`: a route that defines its own replaces
 * the root layout's wholesale, `images` included. So every page that sets
 * openGraph must name an image or it ships with none — which is how /shop,
 * /journal and the category pages ended up with no share preview at all.
 *
 * Relative on purpose — `metadataBase` in app/layout.tsx resolves it against
 * NEXT_PUBLIC_SITE_URL.
 */
export const DEFAULT_OG_IMAGE = "/logo_illustrated.png";

/**
 * Where the shop actually lives, for a customer.
 *
 * The origin is configured per deployment, which is right for a sitemap and
 * wrong for anything a customer keeps. A Preview build has
 * NEXT_PUBLIC_SITE_URL pointing at a *.vercel.app hostname and a local build
 * has nothing at all, so a link composed from the configured value and sent
 * into somebody's WhatsApp thread is a link to a preview that will be torn
 * down, or to a localhost that was never theirs. Those messages outlive the
 * deployment that wrote them.
 *
 * So this is not "the origin we are running on" — it is "the origin a customer
 * must land on", and a hostname that cannot serve the public is replaced rather
 * than emitted. In production the configured value IS the production origin and
 * this returns it unchanged.
 */
export const PRODUCTION_ORIGIN = "https://www.thewovenne.com";

function isPublicOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== "https:" && protocol !== "http:") return false;
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") {
      return false;
    }
    // Preview deployments: real, reachable, and gone in a fortnight.
    if (hostname.endsWith(".vercel.app")) return false;
    return true;
  } catch {
    return false;
  }
}

export function customerOrigin(): string {
  const configured = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return configured && isPublicOrigin(configured) ? configured : PRODUCTION_ORIGIN;
}

/**
 * An absolute URL a customer can be handed, from one of the app's own path
 * helpers — `customerUrl(productHref(product))`, never a hand-written route.
 */
export function customerUrl(path: string): string {
  return new URL(path, `${customerOrigin()}/`).toString();
}

/**
 * The product-photograph sizes approved for naming to search engines and share
 * cards. Each must be one of next.config.mjs's deviceSizes or imageSizes — the
 * optimizer answers 400 for any other width — and scripts/seo-images.test.ts
 * holds them to the real config.
 *
 *   jsonLd     1920 — exactly the `src` the PDP frame already carries, so the
 *                     markup names the file the page shows and Google Images
 *                     already fetches, not a new variant.
 *   openGraph  1200 — already offered in the PDP's srcset, and a fraction of
 *                     the 2–4 MB originals share cards were given before.
 */
export const PRODUCT_IMAGE_VARIANTS = {
  jsonLd: { width: 1920, quality: 75 },
  openGraph: { width: 1200, quality: 75 },
} as const;

export type ProductImageVariant = keyof typeof PRODUCT_IMAGE_VARIANTS;

/**
 * Where a published product photograph lives: the public object route, the
 * product-images bucket, directly inside products/. One segment, a plain file
 * name and an image extension — nothing encoded, nothing nested, no query.
 * Journal images share the bucket but live under journal/, and are not ours to
 * rewrite here.
 */
const PRODUCT_IMAGE_PATH =
  /^\/storage\/v1\/object\/public\/product-images\/products\/[A-Za-z0-9][A-Za-z0-9_-]*\.(?:jpe?g|png|webp)$/;

function configuredStorageHost(supabaseUrl: string | undefined): string | null {
  try {
    const parsed = new URL((supabaseUrl ?? "").trim());
    return parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}

/**
 * A product photograph, as the URL search engines and share cards are given.
 *
 * ── WHY THIS EXISTS ──
 *
 * Supabase Storage sends `X-Robots-Tag: none` with every public object unless
 * that object was uploaded with a header saying otherwise (supabase/storage,
 * src/storage/renderer/renderer.ts). None of ours were. So the raw URL in the
 * Product JSON-LD was a URL Google had been told not to index — and Google's
 * merchant-listing guidance requires product image URLs to be crawlable AND
 * indexable. The same photograph served by next/image from
 * www.thewovenne.com/_next/image carries no such header; it is what the page's
 * own <img> has always used.
 *
 * ── INTERIM, AND SAID SO ──
 *
 * /_next/image is a transformation endpoint whose URL depends on the Next
 * config and version. It is right for markup that is regenerated with every
 * render; it is NOT the stable original a Merchant Center or OpenAI product
 * feed should name. That is a storage-header fix on the originals themselves,
 * which is separate work.
 *
 * ── WHAT IS RECOGNISED, AND NOTHING ELSE ──
 *
 * Only an https URL on THIS project's storage host (exact host, from
 * NEXT_PUBLIC_SUPABASE_URL — never "anything ending in supabase.co"), on the
 * public product-images route, under products/. Private, signed and transform
 * routes, other buckets, other folders, other projects, other hosts, anything
 * with a query, fragment, port, credentials or percent-encoding, and anything
 * that does not parse are returned EXACTLY as given. This builds a URL; it
 * fetches nothing and proxies nothing.
 *
 * `href === src` is the normalisation guard: a URL the parser had to rewrite
 * (dot segments, case, backslashes) is not a stored URL we recognise.
 *
 * ── THE FORMAT IS NEXT'S, NOT OURS ──
 *
 * Next 14.2.5's default loader: `${path}?url=${encodeURIComponent(src)}&w=${w}&q=${q}`,
 * with path "/_next/image". Production sets no NEXT_DEPLOYMENT_ID, so no `dpl`
 * parameter is appended — the live PDP's src has none. The test compares this
 * against the real loader and the real config rather than trusting the copy.
 *
 * On the PRODUCTION origin, like customerUrl in a deployed build: the
 * optimizer's cache for these exact variants lives there.
 */
export function productImageUrl(
  src: string,
  variant: ProductImageVariant,
  supabaseUrl: string | undefined = process.env.NEXT_PUBLIC_SUPABASE_URL
): string {
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_IMAGE_VARIANTS, variant)) {
    throw new Error(`Unapproved product image variant: ${String(variant)}`);
  }
  const { width, quality } = PRODUCT_IMAGE_VARIANTS[variant];

  const host = configuredStorageHost(supabaseUrl);
  if (!host) return src;

  let parsed: URL;
  try {
    parsed = new URL(src);
  } catch {
    return src;
  }
  const recognised =
    parsed.href === src &&
    parsed.protocol === "https:" &&
    parsed.host === host &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    PRODUCT_IMAGE_PATH.test(parsed.pathname);
  if (!recognised) return src;

  return `${PRODUCTION_ORIGIN}/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}

/**
 * The brand, as it is written everywhere a customer sees it.
 *
 * HERE RATHER THAN IN structuredData, because lib/seo is the module without
 * dependants — structuredData imports this file, so the name has to live on
 * this side of the arrow or the two import each other. BRAND_NAME re-exports it
 * so the structured-data callers keep the word they already use.
 */
export const SITE_NAME = "THE WOVENNE";

/**
 * Open Graph, built rather than spelled out.
 *
 * ── THE DEFECT THIS EXISTS TO END ──
 *
 * Next REPLACES `openGraph` wholesale down the chain; it does not merge field
 * by field the way `title` and `description` do. So the moment a route declared
 * an openGraph block of its own — to name a product photograph, say — it also
 * silently dropped the root layout's `type` and `siteName`, and there is
 * nothing in a type or a build to notice. DEFAULT_OG_IMAGE above was the first
 * half of that lesson: pages that set openGraph shipped with no share image at
 * all. This is the second half, and it covers the other two keys.
 *
 * And there is no inheritance to fall back on. Next 14.2.5 carries a
 * `commonOgKeys` list that WOULD fill og:title and og:description from the
 * page's own title and description — and never reads it. (Verified in
 * node_modules/next/dist/lib/metadata/resolve-metadata.js: the constant is
 * declared and used nowhere.) A route that sets no openGraph title therefore
 * emits no og:title, whatever its <title> says.
 *
 * So every route composes its block HERE, and the four keys that must not go
 * missing cannot go missing.
 *
 * ── WHY `type` IS NARROWED TO TWO VALUES ──
 *
 * Open Graph has a `product` vertical and Next 14.2.5 cannot express it. Its
 * OpenGraphType union does not list it, and the generator throws outright —
 * `Invalid OpenGraph type` — on anything outside that union, so a product type
 * would not merely fail tsc, it would fail the render. A product page is a page
 * on a website, which is what "website" says and all it says; the Product
 * facts a search engine actually reads come from the JSON-LD node, not from
 * og:type. See lib/structuredData.
 *
 * The generic is what lets a caller passing "article" get an object the
 * OpenGraphArticle member of Next's union accepts, while a caller passing
 * nothing gets "website".
 */
export function openGraph<T extends "website" | "article" = "website">(input: {
  title: string;
  description?: string;
  /**
   * The page's own storefront path, market-prefixed, from the same helper its
   * canonical uses. Omitted only where a page has no single address.
   */
  path?: string;
  /** Cover first. Falls back to the shared mark when a page has no image. */
  images?: (string | null | undefined)[];
  type?: T;
}): {
  type: T;
  siteName: string;
  title: string;
  description?: string;
  url?: string;
  images: string[];
} {
  const images = (input.images ?? []).filter((src): src is string => Boolean(src));
  return {
    type: (input.type ?? "website") as T,
    siteName: SITE_NAME,
    title: input.title,
    description: input.description,
    /*
     * ABSOLUTE ON THE CUSTOMER ORIGIN, not resolved against metadataBase like
     * the canonical is. og:url is the address a share card carries into
     * somebody's feed, and it outlives the deployment that wrote it — which is
     * the whole argument customerOrigin() makes at the top of this file. In
     * production the two agree exactly.
     */
    url: input.path ? customerUrl(input.path) : undefined,
    images: images.length > 0 ? images : [DEFAULT_OG_IMAGE],
  };
}
