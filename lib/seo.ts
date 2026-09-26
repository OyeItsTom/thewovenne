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
