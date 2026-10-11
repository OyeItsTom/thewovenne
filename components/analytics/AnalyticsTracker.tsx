"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { track, trackPageView } from "@/lib/analyticsClient";

const WHATSAPP_LINK = 'a[href*="wa.me/"], a[href*="api.whatsapp.com"], a[href*="whatsapp.com/send"]';

/**
 * Page views and WhatsApp hand-offs for the whole storefront. Renders nothing.
 *
 * Keyed on the pathname only — not search params, which would force every
 * statically rendered page to bail out to client rendering, and whose
 * contents (search terms, UTM tags) are read once, where they are needed.
 *
 * WhatsApp clicks are caught with one delegated listener rather than by
 * editing every component that links to WhatsApp, so a new link is counted
 * without anyone remembering to wire it.
 */
export default function AnalyticsTracker() {
  const pathname = usePathname();

  useEffect(() => {
    trackPageView();
  }, [pathname]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target.closest(WHATSAPP_LINK) : null;
      if (target) track("whatsapp_click");
    };
    document.addEventListener("click", onClick, { capture: true, passive: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
