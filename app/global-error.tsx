"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Reports uncaught React render errors (App Router) to Sentry with a stack trace.
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
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
            href="/"
            className="mt-6 inline-block rounded-full bg-terracotta px-8 py-3 text-cream transition-colors hover:bg-terracotta-dark"
          >
            Back to THE WOVENNE
          </a>
        </div>
      </body>
    </html>
  );
}
