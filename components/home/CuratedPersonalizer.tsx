"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import CuratedForYou from "./CuratedForYou";
import type { CuratedSet } from "@/lib/curated";

/**
 * Shows the cached curated set, then quietly improves it for signed-in
 * customers whose wishlist gives us something to work with.
 *
 * THE SERVER-RENDERED SET IS ALWAYS WHAT PAINTS FIRST. That is the whole
 * point: the homepage is cached again and answers in milliseconds, and nobody
 * waits on a personalisation query to see the page. Guests never fetch
 * anything at all.
 *
 * NO LAYOUT SHIFT BY CONSTRUCTION. A swap only happens when the replacement
 * holds the same number of cards as what is already on screen, and the cards
 * are fixed-ratio, so the grid cannot change height. CLS measured 0 on this
 * page and this must not be what breaks it.
 */
export default function CuratedPersonalizer({
  initial,
}: {
  initial: CuratedSet;
}) {
  const [set, setSet] = useState<CuratedSet>(initial);

  useEffect(() => {
    let active = true;

    (async () => {
      // Ask the browser's own session first — one local read, no network — so
      // a guest never triggers a request.
      const {
        data: { user },
      } = await getBrowserSupabase().auth.getUser();
      if (!user || !active) return;

      try {
        const res = await fetch("/api/curated");
        if (!res.ok || !active) return;
        const next = (await res.json()) as CuratedSet;

        // Same count or nothing. A shorter personalised set would shorten the
        // grid and shift everything below it.
        if (
          active &&
          next.reason === "personal" &&
          next.products?.length === initial.products.length
        ) {
          setSet(next);
        }
      } catch {
        // The cached set is already on screen and is a perfectly good answer.
        // A failed upgrade is not worth telling anyone about.
      }
    })();

    return () => {
      active = false;
    };
  }, [initial.products.length]);

  return <CuratedForYou set={set} />;
}
