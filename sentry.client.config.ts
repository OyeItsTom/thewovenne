import * as Sentry from "@sentry/nextjs";

// Browser-side error monitoring. Only initialises when a real DSN (a URL) is set
// — a placeholder like "your-sentry-dsn" is treated as not configured.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const enabled = typeof dsn === "string" && dsn.startsWith("http");

Sentry.init({
  dsn: enabled ? dsn : undefined,
  enabled,
  tracesSampleRate: 1.0,
});
