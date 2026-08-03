import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Marketing triggers.
 *
 * Cart abandonment is deliberately absent. The cart lives in the browser's
 * local storage and never reaches the server, so there is nothing to detect —
 * it would need the cart persisting first, which is a decision about storing
 * what signed-out people browse, not a side effect of a mailing feature.
 */
export type MarketingTrigger = "wishlist_waiting" | "low_stock";

export const TRIGGERS: MarketingTrigger[] = ["wishlist_waiting", "low_stock"];

export interface MarketingTarget {
  user_id: string;
  email: string;
  name: string | null;
  items: { name: string; slug: string; stock: number }[];
}

/**
 * Who would receive this trigger right now.
 *
 * The list comes from marketing_targets() in migration 0031, which is the only
 * authority on eligibility — consented account-holders, excluding anyone
 * contacted with this trigger inside the cooldown.
 */
export async function getMarketingTargets(
  client: SupabaseClient,
  trigger: MarketingTrigger,
  cooldownDays = 7
): Promise<MarketingTarget[]> {
  const { data, error } = await client.rpc("marketing_targets", {
    p_trigger: trigger,
    p_cooldown_days: cooldownDays,
  });
  if (error) {
    console.error("getMarketingTargets:", error.message);
    return [];
  }
  return (data as MarketingTarget[]) ?? [];
}
