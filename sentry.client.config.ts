import * as Sentry from "@sentry/nextjs";

// Browser-side error monitoring. Only initialises when a real DSN (a URL) is set
// — a placeholder like "your-sentry-dsn" is treated as not configured.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const enabled = typeof dsn === "string" && dsn.startsWith("http");

// Errors only. Browser performance tracing is compiled out of the bundle (see
// the webpack block in next.config.mjs), so there is no tracesSampleRate here:
// error capture is unaffected and stays at 100%.
Sentry.init({
  dsn: enabled ? dsn : undefined,
  enabled,
});
