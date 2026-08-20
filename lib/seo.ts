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
