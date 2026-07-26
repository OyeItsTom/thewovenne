import * as Sentry from "@sentry/nextjs";

// Edge runtime error monitoring (middleware, edge routes). Real DSN only.
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const enabled = typeof dsn === "string" && dsn.startsWith("http");

Sentry.init({
  dsn: enabled ? dsn : undefined,
  enabled,
  tracesSampleRate: 1.0,
});
