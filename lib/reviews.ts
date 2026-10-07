import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase as anonClient } from "./supabase";

/**
 * Product reviews.
 *
 * Who may write a review is enforced by RLS and has_purchased() in migration
 * 0036, not here. Whether a review carries "Verified purchase" is decided by
 * product_reviews_for() (0066) from the author's own paid, delivered order, at
 * read time. Nothing here can set it. Everything in this file is presentation.
 */

export interface Review {
  id: string;
  rating: number;
  body: string;
  author: string;
  created_at: string;
  /**
   * True only when the database found a paid, delivered order for this
   * product under the author's sign-in email. Anything else, including a
   * missing value, means no badge.
   */
  verified: boolean;
}

export interface RatingSummary {
  average: number | null;
  total: number;
}

export async function getReviews(
  productId: string,
  client: SupabaseClient = anonClient
): Promise<Review[]> {
  const { data, error } = await client.rpc("product_reviews_for", {
    p_product_id: productId,
  });
  if (error) {
    console.error("getReviews:", error.message);
    return [];
  }
  return (data ?? []) as Review[];
}

export async function getRating(
  productId: string,
  client: SupabaseClient = anonClient
): Promise<RatingSummary> {
  const { data, error } = await client.rpc("product_rating", {
    p_product_id: productId,
  });
  if (error) {
    console.error("getRating:", error.message);
    return { average: null, total: 0 };
  }
  // The function returns one row; PostgREST gives it back as an array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { average: number | null; total: number }
    | undefined;
  return {
    average: row?.average ?? null,
    total: Number(row?.total ?? 0),
  };
}

/**
 * Eligibility is decided in the browser by ReviewFormGate, not here — asking
 * "did this person buy this?" on the server would make every product page
 * dynamic and cost the ISR caching that makes them fast. This file stays
 * server-side and public: the list and the summary, both identical for
 * everyone who asks.
 */
