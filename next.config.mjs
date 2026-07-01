import { withSentryConfig } from "@sentry/nextjs";

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
};

// Sentry wrapping is a no-op at runtime without a DSN; source-map upload only
// runs when SENTRY_AUTH_TOKEN (+ org/project) are set in the build environment.
export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
});
