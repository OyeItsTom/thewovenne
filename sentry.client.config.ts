import * as Sentry from "@sentry/nextjs";

// Browser-side error monitoring. Only initialises when a real DSN (a URL) is set
// — a placeholder like "your-sentry-dsn" is treated as not configured.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const enabled = typeof dsn === "string" && dsn.startsWith("http");

Sentry.init({
  dsn: enabled ? dsn : undefined,
  enabled,
  // Performance tracing only — error capture is unaffected and stays at 100%.
  // 1.0 traces every request, which burns quota as traffic grows.
  tracesSampleRate: 0.1,
});
