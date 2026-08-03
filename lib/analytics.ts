import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The admin's read-only view of the numbers.
 *
 * Every call goes to a fixed aggregate function in migration 0025 — never a
 * query assembled here. The AI insights chat will call the same six, which is
 * what keeps it unable to read a customer row: the capability does not exist,
 * rather than being something the model is asked not to do.
 */

export interface Summary {
  days: number;
  orders: number;
  revenue: number;
  goods: number;
  shipping: number;
  aov: number;
  awaiting_dispatch: number;
  needs_review: number;
}

export interface RevenuePoint {
  bucket: string;
  goods: number;
  shipping: number;
  orders: number;
}

export interface TopProduct {
  name: string;
  units: number;
  revenue: number;
}

export interface LowStockRow {
  name: string;
  size: string | null;
  stock: number;
}

export interface WishlistRow {
  name: string;
  saves: number;
}

export interface SignupPoint {
  bucket: string;
  signups: number;
}

export type Bucket = "day" | "week" | "month";

async function call<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  fallback: T
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    console.error(`${fn}:`, error.message);
    return fallback;
  }
  return (data as T) ?? fallback;
}

const EMPTY_SUMMARY: Summary = {
  days: 0,
  orders: 0,
  revenue: 0,
  goods: 0,
  shipping: 0,
  aov: 0,
  awaiting_dispatch: 0,
  needs_review: 0,
};

export const getSummary = (c: SupabaseClient, days = 30) =>
  call<Summary>(c, "analytics_summary", { p_days: days }, EMPTY_SUMMARY);

export const getRevenue = (c: SupabaseClient, bucket: Bucket = "day", days = 30) =>
  call<RevenuePoint[]>(c, "analytics_revenue", { p_bucket: bucket, p_days: days }, []);

export const getTopProducts = (c: SupabaseClient, days = 30, limit = 10) =>
  call<TopProduct[]>(c, "analytics_top_products", { p_days: days, p_limit: limit }, []);

export const getLowStock = (c: SupabaseClient, threshold = 3) =>
  call<LowStockRow[]>(c, "analytics_low_stock", { p_threshold: threshold }, []);

export const getWishlistCounts = (c: SupabaseClient, limit = 10) =>
  call<WishlistRow[]>(c, "analytics_wishlist", { p_limit: limit }, []);

export const getSignups = (c: SupabaseClient, days = 30) =>
  call<SignupPoint[]>(c, "analytics_signups", { p_days: days }, []);

/** How many days each range covers, per bucket. */
export const RANGE_DAYS: Record<Bucket, number> = {
  day: 30,
  week: 84,
  month: 365,
};
