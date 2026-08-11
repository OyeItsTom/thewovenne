import type { ShippingAddress } from "./orderDetails";
import { supabase } from "./supabase";

/**
 * What delivery costs.
 *
 * Two tiers by PIN prefix, plus a free-over threshold. Deliberately not
 * weight-based: that needs a weight on every product and turns every quote into
 * a calculation that can be subtly wrong. This is a lookup — it is either right
 * or obviously wrong, which at this volume is worth more than precision.
 */

export interface ShippingConfig {
  /** PIN code prefixes delivered free. Kerala is 67, 68, 69. */
  free_pin_prefixes: string[];
  flat_rate_inr: number;
  /** Free anywhere above this order value. 0 disables it. */
  free_above_inr: number;
  note: string;
  /**
   * Working days before an order leaves. 0 means "we have not decided yet", and
   * NOTHING IS SHOWN — the product page omits the dispatch line entirely rather
   * than guessing.
   *
   * Here so the number has somewhere to live the day it becomes a real
   * commitment. It is a promise to a customer, so it has to come from the
   * business, not from a plausible-sounding default.
   */
  dispatch_days: number;
}

export const DEFAULT_SHIPPING: ShippingConfig = {
  free_pin_prefixes: ["67", "68", "69"],
  flat_rate_inr: 120,
  free_above_inr: 3000,
  note: "Free delivery across Kerala, and on orders over the threshold.",
  dispatch_days: 0,
};

export async function getShippingConfig(): Promise<ShippingConfig> {
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();

  if (error || !data?.value) return DEFAULT_SHIPPING;
  // Merged over the defaults so a partially-edited config cannot leave a
  // required field undefined and make shipping NaN.
  return { ...DEFAULT_SHIPPING, ...(data.value as object) } as ShippingConfig;
}

export interface ShippingQuote {
  cost: number;
  free: boolean;
  reason: string;
}

/**
 * Quote one delivery.
 *
 * Called on the server at checkout, so a modified request cannot zero it —
 * the same rule as product pricing. The client runs it too, purely so the
 * customer sees the number before paying.
 */
export function quoteShipping(
  address: Pick<ShippingAddress, "postal_code" | "country">,
  goodsTotal: number,
  config: ShippingConfig
): ShippingQuote {
  if (config.free_above_inr > 0 && goodsTotal >= config.free_above_inr) {
    return {
      cost: 0,
      free: true,
      reason: `Free — orders over ₹${config.free_above_inr.toLocaleString("en-IN")}`,
    };
  }

  // Digits only: people type "682 001" and "682-001".
  const pin = (address.postal_code ?? "").replace(/\D/g, "");
  const nearby = config.free_pin_prefixes.some((p) => pin.startsWith(p));

  if (pin && nearby) {
    return { cost: 0, free: true, reason: "Free — delivery in our home region" };
  }

  // An empty or unrecognised PIN quotes the paid rate rather than assuming
  // free. Under-charging is a loss on every order; over-quoting corrects itself
  // the moment a real PIN is typed.
  return {
    cost: config.flat_rate_inr,
    free: false,
    reason: pin ? "Standard delivery" : "Standard delivery — enter a PIN code",
  };
}
