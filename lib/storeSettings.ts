import { supabase } from "./supabase";

/**
 * Settings an admin can change without a deploy.
 *
 * Lives in site_content beside the shipping and campaign config, so it inherits
 * the same editing surface. Read on the server wherever it decides behaviour —
 * a toggle the browser respects is a suggestion, not a switch.
 */

export interface StoreSettings {
  /** Hides the storefront concierge entirely, widget and endpoint both. */
  ask_wovenne_enabled: boolean;
  /** A customer is VIP at EITHER threshold — see lib/segments.ts. */
  vip_min_orders: number;
  vip_min_spend_inr: number;
  /** Loyalty ships off; nothing accrues or redeems until this is true. */
  loyalty_enabled: boolean;
  loyalty_points_per_inr: number;
  loyalty_inr_per_point: number;
  loyalty_min_redeem: number;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  ask_wovenne_enabled: true,
  vip_min_orders: 3,
  vip_min_spend_inr: 15000,
  loyalty_enabled: false,
  loyalty_points_per_inr: 1,
  loyalty_inr_per_point: 0.25,
  loyalty_min_redeem: 200,
};

export async function getStoreSettings(): Promise<StoreSettings> {
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", "store_settings")
    .maybeSingle();

  if (error || !data?.value) return DEFAULT_SETTINGS;
  // Merged over defaults so a half-edited row cannot leave a required setting
  // undefined and make a comparison silently false.
  return { ...DEFAULT_SETTINGS, ...(data.value as object) } as StoreSettings;
}
