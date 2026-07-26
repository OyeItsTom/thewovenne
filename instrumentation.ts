// Sentry is loaded only when a real DSN (a URL) is configured. Nothing here
// statically imports @sentry/nextjs, so with no DSN the SDK never enters the
// bundle. A placeholder like "your-sentry-dsn" counts as not configured.
const isDsn = (v?: string) => typeof v === "string" && v.startsWith("http");
const sentryEnabled =
  isDsn(process.env.SENTRY_DSN) || isDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

export async function register() {
  if (!sentryEnabled) return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Captures errors thrown in nested React Server Components — no-op without a DSN.
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  if (!sentryEnabled) return;
  const Sentry = await import("@sentry/nextjs");
  return Sentry.captureRequestError(...args);
}
