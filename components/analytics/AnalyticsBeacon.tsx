"use client";

import { useEffect } from "react";
import { trackOncePerPage } from "@/lib/analyticsClient";

type Props =
  | { event: "product_view"; productId: string }
  | { event: "search"; term: string; resultCount: number };

/**
 * One event for the page it is rendered on, at most once per page view —
 * re-renders, hydration and React's double-run effects do not repeat it.
 * Renders nothing, so a server component can drop it in.
 */
export default function AnalyticsBeacon(props: Props) {
  const key =
    props.event === "product_view" ? `product:${props.productId}` : `search:${props.term}`;

  useEffect(() => {
    if (props.event === "product_view") {
      trackOncePerPage(key, "product_view", { product_id: props.productId });
    } else {
      trackOncePerPage(key, "search", { search_term: props.term, result_count: props.resultCount });
    }
    // `key` captures everything the event depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return null;
}
