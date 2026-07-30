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
