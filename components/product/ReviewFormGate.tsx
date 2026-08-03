"use client";

import { useEffect, useState } from "react";
import ReviewForm from "./ReviewForm";
import { getBrowserSupabase } from "@/lib/supabase";

/**
 * Decides, in the browser, whether to offer the review form.
 *
 * IT RUNS CLIENT-SIDE TO PROTECT THE CACHE. Product pages are statically
 * rendered and revalidated every 60s, which is most of why they are fast and
 * indexable. Asking "has this particular person bought this?" on the server
 * would make every product page dynamic for everybody, to render a form almost
 * nobody sees.
 *
 * This is presentation only. The rule itself is RLS plus has_purchased() in
 * migration 0036 — someone who forges their way past this component still
 * cannot write a row.
 */
export default function ReviewFormGate({ productId }: { productId: string }) {
  const [state, setState] = useState<{
    ready: boolean;
    canReview: boolean;
    existing: { id: string; rating: number; body: string } | null;
  }>({ ready: false, canReview: false, existing: null });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const supabase = getBrowserSupabase();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) setState({ ready: true, canReview: false, existing: null });
        return;
      }

      const [{ data: purchased }, { data: mine }] = await Promise.all([
        supabase.rpc("has_purchased", { p_product_id: productId }),
        supabase
          .from("product_reviews")
          .select("id, rating, body")
          .eq("product_id", productId)
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);

      if (cancelled) return;
      setState({
        ready: true,
        canReview: purchased === true,
        existing: (mine as { id: string; rating: number; body: string } | null) ?? null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [productId]);

  // Nothing while deciding, and nothing for people who cannot review. No
  // skeleton: a placeholder that resolves to nothing 99 times out of 100 is
  // just a flicker on every product page.
  if (!state.ready || !state.canReview) return null;

  return <ReviewForm productId={productId} existing={state.existing} />;
}
