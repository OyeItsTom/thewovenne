import { withSentryConfig } from "@sentry/nextjs";

// Sentry is fully optional: it only turns on when a *real* DSN is configured
// (a URL, not the "your-sentry-dsn" placeholder from .env.local.example). With
// no DSN we export the plain Next config — no Sentry webpack instrumentation —
// so `npm run dev` compiles cleanly and Framer Motion animations render.
const isDsn = (v) => typeof v === "string" && v.startsWith("http");
const sentryEnabled =
  isDsn(process.env.SENTRY_DSN) || isDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    /*
     * WHY THESE THREE VALUES EXIST.
     *
     * Vercel charges Image Optimization in 8 KB CACHE WRITE UNITS, on every
     * cache MISS and every STALE re-write. So the bill is driven by the SIZE of
     * what is produced and HOW OFTEN it is produced again — not by how many
     * photographs there are. Measured against one real 8160×6120 product
     * photograph on this site:
     *
     *     w=384    41 KB      6 units
     *     w=640   122 KB     15 units
     *     w=828   212 KB     26 units
     *     w=1200  459 KB     57 units
     *     w=1920  1.1 MB    139 units
     *     w=3840  3.3 MB    404 units      ← 0.4% of a month, for ONE image
     *
     * Nothing on this site can display 3840. It was reachable only because it
     * is a Next default, and because Next names the LARGEST candidate in each
     * image's `src` attribute — which is what any client that ignores srcset
     * fetches. With 110 photographs in the catalogue, one crawl at that
     * fallback is ~44,000 write units.
     */

    /*
     * THIRTY-ONE DAYS, AND IT IS SAFE BECAUSE THE URLS ARE IMMUTABLE.
     *
     * Next's optimizer keeps an entry for max(upstream max-age, this). Supabase
     * serves these photographs with max-age=3600, so every variant went stale
     * hourly and was re-optimized — paying its full write cost again, forever,
     * for bytes that had not changed.
     *
     * They cannot change. Both upload paths in this codebase
     * (lib/storage.ts and components/style/StyleSubmissionForm.tsx) write to a
     * fresh `crypto.randomUUID()` filename with `upsert: false`, so an existing
     * object cannot be overwritten — replacing a photograph produces a new URL,
     * which is a new cache key. No code path deletes storage objects either.
     *
     * The one caveat is operational rather than architectural: overwriting an
     * object by hand in the Supabase dashboard would leave the old bytes cached
     * here for up to 31 days. Upload a new image instead, which is what the
     * admin already does.
     */
    minimumCacheTTL: 2678400,

    /*
     * The widest slot Wovenne actually has. Product cards are 148–272 CSS px,
     * the PDP frame is ~592, the hero is 38rem, and the only full-bleed image
     * on the site has a 1672px SOURCE — narrower than this ceiling, so nothing
     * is lost by removing 2048 and 3840. 1920 remains for a retina PDP frame
     * and a 1920 desktop; it is now also the `src` fallback, at 139 units
     * instead of 404.
     */
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],

    /*
     * Every entry earns its place, and none is a near-duplicate:
     *   64  — both logos at 1x          256 — PDP thumbnail 2x, card 1x (small)
     *   96  — footer logo at 2x         384 — PDP thumbnail 3x, card 1x (mid)
     *  128  — navbar logo 2x, thumb 1x
     * Dropping 16/32/48 costs nothing: no surface renders below 40 CSS px.
     * These never widen a card's srcset — a `vw`-based `sizes` only admits
     * candidates at or above deviceSizes[0] × the smallest percentage.
     */
    imageSizes: [64, 96, 128, 256, 384],

    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
      {
        // YouTube's own thumbnails, for a customer's video submission. Needed
        // even though that <Image> is `unoptimized`: if anyone ever removes that
        // prop the optimizer starts validating the host, and a missing entry is
        // a runtime error on a page that was working.
        protocol: "https",
        hostname: "i.ytimg.com",
      },
      {
        // Product photos, and customers' style photographs, in Supabase Storage.
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  experimental: {
    // Keep Sentry's server SDK (and its ESM-only deps) external so the dev
    // server doesn't try to bundle/require them — this is the Next 14 name for
    // what Next 15 calls `serverExternalPackages`.
    serverComponentsExternalPackages: ["@sentry/nextjs"],
  },
};

export default sentryEnabled
  ? withSentryConfig(nextConfig, {
      silent: true,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
    })
  : nextConfig;
