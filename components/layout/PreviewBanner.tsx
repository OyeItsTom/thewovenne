"use client";

import { usePathname } from "next/navigation";

/**
 * Marks the page as showing unpublished work.
 *
 * Deliberately loud — the whole risk of preview mode is forgetting you are in
 * it and concluding the site says something it does not. It sticks to the top
 * so it stays visible while scrolling, and exiting returns to the same page so
 * the two versions can be compared directly.
 */
export default function PreviewBanner() {
  const pathname = usePathname();

  return (
    <div className="sticky top-0 z-[60] bg-ink text-cream">
      <div className="container-wovenne flex flex-wrap items-center justify-between gap-2 py-2 text-xs">
        <span>
          <strong className="font-medium">Preview</strong> — showing unpublished
          changes. Customers still see the live site.
        </span>
        <a
          href={`/api/preview/exit?path=${encodeURIComponent(pathname)}`}
          className="rounded-full border border-cream/30 px-3 py-1 uppercase tracking-widest transition-colors hover:bg-cream hover:text-ink"
        >
          Exit preview
        </a>
      </div>
    </div>
  );
}
