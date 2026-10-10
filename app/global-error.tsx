"use client";

import { useEffect } from "react";

// Reports uncaught React render errors (App Router) to Sentry with a stack
// trace — only when a DSN is configured; otherwise it's a no-op.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
    if (!dsn || !dsn.startsWith("http")) return;
    // webpackExports: name the ONE function used. A bare import() hands back
    // the whole module namespace, so webpack has to keep every export of
    // @sentry/nextjs — and since the browser SDK is one concatenated module
    // shared with sentry.client.config, that kept all of browser tracing and
    // the feedback widget in the Sentry chunk EVERY page loads, not just in
    // this rarely-reached error page.
    import(/* webpackExports: ["captureException"] */ "@sentry/nextjs").then(
      (Sentry) => Sentry.captureException(error)
    );
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-cream px-6 text-center">
        <div>
          <p className="font-script text-2xl text-terracotta">A loose thread</p>
          <h1 className="mt-2 font-heading text-4xl text-ink">
            Something came undone
          </h1>
          <p className="mt-3 text-ink/60">
            We&apos;ve been notified. Please refresh, or head back to the shop.
          </p>
          <a
            href="/in"
            className="mt-6 inline-block rounded-full bg-terracotta-dark px-8 py-3 text-cream transition-colors hover:bg-terracotta-deep"
          >
            Back to THE WOVENNE
          </a>
        </div>
      </body>
    </html>
  );
}
