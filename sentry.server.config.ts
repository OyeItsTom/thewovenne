import * as Sentry from "@sentry/nextjs";

// Server (Node.js runtime) error monitoring. Only initialises with a real DSN.
const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;
const enabled = typeof dsn === "string" && dsn.startsWith("http");

Sentry.init({
  dsn: enabled ? dsn : undefined,
  enabled,
  // Performance tracing only — error capture is unaffected and stays at 100%.
  // 1.0 traces every request, which burns quota as traffic grows.
  tracesSampleRate: 0.1,
});
