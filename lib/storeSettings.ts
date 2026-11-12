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
  /**
   * Loyalty ships off; nothing accrues or redeems until this is true.
   * LS-1 (0081): held false for launch by the database; see discountSwitches.
   */
  loyalty_enabled: boolean;
  /**
   * LS-1 (0081): no coupon discount is applied anywhere unless this is true.
   * Held false for launch by the database; switching it on is a release.
   */
  coupons_enabled: boolean;
  loyalty_points_per_inr: number;
  loyalty_inr_per_point: number;
  loyalty_min_redeem: number;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  ask_wovenne_enabled: true,
  vip_min_orders: 3,
  vip_min_spend_inr: 15000,
  loyalty_enabled: false,
  coupons_enabled: false,
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

  if (error || !data?.value || typeof data.value !== "object") return DEFAULT_SETTINGS;
  // Merged over defaults so a half-edited row cannot leave a required setting
  // undefined and make a comparison silently false.
  const merged = { ...DEFAULT_SETTINGS, ...(data.value as object) } as StoreSettings;
  // The two money switches are read strictly: only a real `true` is on. A
  // string "true", a 1, or anything else a hand edit leaves behind is OFF —
  // the same reading as discount_switch_on() in the database (0081).
  merged.loyalty_enabled = isSwitchOn(merged.loyalty_enabled);
  merged.coupons_enabled = isSwitchOn(merged.coupons_enabled);
  return merged;
}

/** Strict: only the boolean `true` turns a money switch on. */
export function isSwitchOn(value: unknown): boolean {
  return value === true;
}

export interface DiscountSwitches {
  loyalty: boolean;
  coupons: boolean;
}

/** Both off. What any failure to read the settings means (LS-1). */
export const DISCOUNTS_OFF: DiscountSwitches = Object.freeze({ loyalty: false, coupons: false });

/**
 * Whether checkout may apply loyalty points or a coupon. FAILS CLOSED: an
 * unreadable, missing or malformed setting — or any throw — answers "off".
 * Decides money, so it is read on the server for every checkout, never cached
 * and never taken from the browser.
 */
export async function getDiscountSwitches(
  read: () => Promise<StoreSettings> = getStoreSettings
): Promise<DiscountSwitches> {
  try {
    const s = await read();
    return { loyalty: isSwitchOn(s?.loyalty_enabled), coupons: isSwitchOn(s?.coupons_enabled) };
  } catch {
    return DISCOUNTS_OFF;
  }
}
