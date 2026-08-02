"use client";

/**
 * Marks the page as showing unpublished work.
 *
 * Deliberately loud — the whole risk of preview mode is forgetting you are in
 * it and concluding the site says something it does not. It sticks to the top
 * so it stays visible while scrolling.
 */
export default function PreviewBanner() {
  return (
    <div className="sticky top-0 z-[60] bg-ink text-cream">
      <div className="container-wovenne flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
        <span>
          <strong className="font-medium">Preview</strong> — showing unpublished
          changes. Customers still see the live site.
        </span>
        {/* Back to the admin, not back to this page. Preview is something you
            enter FROM the admin to check work before publishing, so leaving it
            means returning to the decision you left — staying on the storefront
            just drops you on a page you were only visiting to inspect. */}
        <a
          href="/api/preview/exit?path=/admin"
          className="rounded-full border border-cream/30 px-3 py-1 uppercase tracking-widest transition-colors hover:bg-cream hover:text-ink"
        >
          Exit preview
        </a>
      </div>
    </div>
  );
}
