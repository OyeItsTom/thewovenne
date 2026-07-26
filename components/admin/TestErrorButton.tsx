"use client";

/**
 * Fires a client-side error so you can confirm Sentry is capturing events.
 * If NEXT_PUBLIC_SENTRY_DSN is set, this throw will appear in your Sentry issues.
 */
export default function TestErrorButton() {
  return (
    <button
      onClick={() => {
        throw new Error("THE WOVENNE — Sentry test error (admin dashboard)");
      }}
      className="rounded-full border border-terracotta px-4 py-2 text-sm text-terracotta transition-colors hover:bg-terracotta hover:text-cream"
    >
      Trigger test error
    </button>
  );
}
