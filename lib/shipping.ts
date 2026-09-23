import type { ShippingAddress } from "./orderDetails";
import { supabase } from "./supabase";

/**
 * What delivery costs.
 *
 * Three facts, in one place: a standard rate, a list of regions that pay
 * something different, and the order value above which nobody pays anything.
 * Deliberately not weight-based — that needs a weight on every product and
 * turns every quote into a calculation that can be subtly wrong. This is a
 * lookup: either right, or obviously wrong.
 */

/** A postal region that pays something other than the standard rate. */
export interface RegionalRate {
  /** The operator's label. Shown to nobody — it is so the admin list reads. */
  name: string;
  /** PIN prefixes this rate covers. Longest match wins. */
  prefixes: string[];
  /** What delivery costs here, below the free-delivery threshold. */
  rate_inr: number;
}

export interface ShippingConfig {
  /** What most of India pays below the threshold. */
  flat_rate_inr: number;
  /** Free anywhere above this order value. 0 disables it. */
  free_above_inr: number;
  /** Regions charged something else. Empty means one rate for everywhere. */
  regional_rates: RegionalRate[];
  note: string;
}

/**
 * The published policy: ₹99 in Kerala, ₹129 elsewhere in India, free at ₹3,000.
 *
 * ── WHY PIN PREFIXES AND NOT THE STATE FIELD ──
 *
 * The checkout DOES collect a state, and pricing off it would be the obvious
 * design. It is free text: one input, a 100-character limit, no list to choose
 * from and no validation (components/cart/CheckoutForm, lib/orderDetails). So
 * "Kerala", "kerala", "KL", "Kerela" and "" are all things a real customer
 * types, and pricing off that would make a typo change the price — and would
 * let anyone pay ₹99 by typing one word. The PIN is format-checked, and it is
 * what the courier actually reads.
 *
 * The prefixes are an OPERATIONAL APPROXIMATION of a state boundary, not the
 * boundary itself. 67, 68 and 69 cover Kerala; the one known overlap is
 * Lakshadweep, whose 682xxx codes are administered through Kochi and so fall
 * inside 68. Those addresses get Kerala's ₹99. The error is small, in the
 * customer's favour, and can be narrowed later with an explicit exclusion if it
 * ever matters.
 *
 * ── free_pin_prefixes IS GONE ──
 *
 * It used to deliver 67/68/69 free, which is no longer the policy — Kerala now
 * pays ₹99. The field is not merely re-pointed but REMOVED, because a stored
 * `shipping` row in site_content still carrying it would otherwise keep making
 * Kerala free while this file looked correct. Nothing reads it now, so a stale
 * value is inert rather than dangerous. Nothing else in the codebase depended
 * on it; a test pins that a stale value cannot resurrect free delivery.
 *
 * THESE ARE DEFAULTS. getShippingConfig() merges the stored row over them, so a
 * value saved in Admin → Settings wins — including a stale flat_rate_inr.
 */
export const DEFAULT_SHIPPING: ShippingConfig = {
  flat_rate_inr: 129,
  free_above_inr: 3000,
  regional_rates: [{ name: "Kerala", prefixes: ["67", "68", "69"], rate_inr: 99 }],
  note: "₹99 in Kerala, ₹129 elsewhere in India, free on orders of ₹3,000 or more.",
};

export async function getShippingConfig(): Promise<ShippingConfig> {
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", "shipping")
    .maybeSingle();

  if (error || !data?.value) return DEFAULT_SHIPPING;
  // Merged over the defaults so a partially-edited config cannot leave a
  // required field undefined and make shipping NaN. A key the config no longer
  // has — free_pin_prefixes — rides along and is read by nobody.
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
  // 1 — the threshold beats everywhere. Nobody pays above it.
  if (config.free_above_inr > 0 && goodsTotal >= config.free_above_inr) {
    return {
      cost: 0,
      free: true,
      reason: `Free — orders over ₹${config.free_above_inr.toLocaleString("en-IN")}`,
    };
  }

  // Digits only: people type "682 001" and "682-001".
  const pin = (address.postal_code ?? "").replace(/\D/g, "");

  // 2 — a region with its own rate. LONGEST PREFIX WINS, the same rule the
  // delivery zones in lib/delivery use, so the two prefix systems cannot
  // develop different ideas of which region an address is in.
  const region = pin ? matchRegion(pin, config.regional_rates) : null;
  if (region) {
    return { cost: region.rate_inr, free: region.rate_inr === 0, reason: `Delivery to ${region.name}` };
  }

  // 3 — everywhere else, and everything unrecognised.
  //
  // An empty or malformed PIN lands HERE rather than in a region: it quotes the
  // standard rate rather than the cheaper one. Under-charging is a loss on every
  // order; over-quoting corrects itself the moment a real PIN is typed.
  return {
    cost: config.flat_rate_inr,
    free: false,
    reason: pin ? "Standard delivery" : "Standard delivery — enter a PIN code",
  };
}

/** The most specific region a PIN falls in, or null. */
function matchRegion(pin: string, rates: RegionalRate[]): RegionalRate | null {
  let best: RegionalRate | null = null;
  let bestLength = -1;
  for (const rate of rates) {
    for (const prefix of rate.prefixes) {
      if (prefix && pin.startsWith(prefix) && prefix.length > bestLength) {
        best = rate;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

