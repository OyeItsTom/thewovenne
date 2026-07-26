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
    remotePatterns: [
      {
        protocol: "https",
        hostname: "placehold.co",
      },
      {
        // Product photos uploaded to Supabase Storage.
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
