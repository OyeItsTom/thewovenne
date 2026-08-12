import type { Country } from "./country";
import {
  getShippingConfig,
  quoteShipping,
  type ShippingConfig,
} from "./shipping";

/**
 * What a customer can be told about delivery before they buy.
 *
 * ONE RULE SOURCE, NOT TWO. The money side of this is not recalculated here —
 * it calls quoteShipping(), the same pure function the checkout route charges
 * from. A second implementation of "is this free?" is how a product page ends
 * up promising something the till then contradicts, and the customer believes
 * the page.
 *
 * What this ADDS on top of quoteShipping is the two things it has no opinion
 * about: whether we deliver somewhere at all, and how long it takes. Neither
 * exists anywhere in the current system, so both are configuration with no
 * default value — see DEFAULT_DELIVERY below.
 *
 * THE SEAM FOR A REAL COURIER. getDeliveryQuote() takes a market, a postal code
 * and an order value, and returns a verdict. Today it resolves from admin rules.
 * When a provider such as Shiprocket exists, it becomes the other branch of this
 * one function and nothing above it changes — not the API route, not the
 * component, not the checkout. There is no Shiprocket code here and none is
 * implied; the shape is simply one a provider can fill.
 */

/** A postal-code region with its own delivery promise. */
export interface DeliveryZone {
  /** Shown to nobody — an operator's label, so the admin list is readable. */
  name: string;
  /** Postal-code prefixes this zone covers. Longest match wins. */
  prefixes: string[];
  /** Working-day range. 0/0 means "not established" and no time is shown. */
  min_days: number;
  max_days: number;
}

export interface DeliveryConfig {
  /** Off means the estimator does not render and its endpoint declines. */
  estimator_enabled: boolean;
  /** Separate from the above so it can be tested live before customers see it. */
  estimator_on_pdp: boolean;
  /** Fallback range when no zone matches but the place IS served. 0/0 = unknown. */
  default_min_days: number;
  default_max_days: number;
  zones: DeliveryZone[];
  /**
   * Prefixes we do not deliver to. Checked BEFORE zones, so an exclusion inside
   * a served region still wins.
   */
  unserviceable_prefixes: string[];
  /** Shown when the rules cannot produce a trustworthy time. Never invented. */
  fallback_note: string;
}

/**
 * NO DELIVERY TIMES BY DEFAULT, deliberately.
 *
 * "3–5 working days" is a promise to a customer. It is not in the database, it
 * is not in any config, and it is not something to guess from a plausible
 * industry norm. Every day value here is 0 until somebody with the courier
 * relationship sets it, and while it is 0 the estimator says what it can prove
 * — whether we deliver there and what it costs — and falls back on time.
 */
export const DEFAULT_DELIVERY: DeliveryConfig = {
  estimator_enabled: true,
  estimator_on_pdp: true,
  default_min_days: 0,
  default_max_days: 0,
  zones: [],
  unserviceable_prefixes: [],
  fallback_note: "Delivery time confirmed at checkout.",
};

export type DeliveryVerdict =
  | {
      status: "serviceable";
      /** Null when no day range is configured for this place. */
      days: { min: number; max: number } | null;
      cost: number;
      free: boolean;
      /** Why it is free or charged, in the customer's words. */
      reason: string;
      /** Set when it is NOT free but a threshold exists that would make it so. */
      freeAboveInr: number | null;
      zoneName: string | null;
      /** Shown instead of a day range when days are unset. */
      fallbackNote: string | null;
    }
  | { status: "unserviceable" }
  | { status: "invalid" }
  | { status: "unavailable" };

/** Per-market postal-code shape. Format only — see the note on validate(). */
const POSTAL_RULES: Record<Country, { label: string; pattern: RegExp; digitsOnly: boolean }> = {
  in: { label: "Pincode", pattern: /^[1-9][0-9]{5}$/, digitsOnly: true },
};

export function postalLabel(market: Country): string {
  return POSTAL_RULES[market]?.label ?? "Postcode";
}

export function postalIsNumeric(market: Country): boolean {
  return POSTAL_RULES[market]?.digitsOnly ?? false;
}

/**
 * Does this LOOK like a postal code for this market?
 *
 * FORMAT ONLY, AND THAT IS THE POINT. A well-formed pincode is not a promise
 * that a courier goes there — 999999 is a valid shape and nowhere at all. This
 * exists to catch typing mistakes before a request is made; serviceability is
 * decided separately, by rules or one day by a courier.
 */
export function isValidPostalFormat(market: Country, raw: string): boolean {
  const rule = POSTAL_RULES[market];
  if (!rule) return false;
  const cleaned = rule.digitsOnly ? raw.replace(/\D/g, "") : raw.trim().toUpperCase();
  return rule.pattern.test(cleaned);
}

export function normalisePostal(market: Country, raw: string): string {
  const rule = POSTAL_RULES[market];
  if (!rule) return raw.trim();
  return rule.digitsOnly ? raw.replace(/\D/g, "") : raw.trim().toUpperCase();
}

export async function getDeliveryConfig(): Promise<DeliveryConfig> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase
    .from("site_content")
    .select("value")
    .eq("key", "delivery")
    .maybeSingle();

  // Merged over defaults for the same reason getShippingConfig does it: a
  // half-edited row must not leave a required field undefined and turn a
  // comparison silently false.
  if (error || !data?.value) return DEFAULT_DELIVERY;
  return { ...DEFAULT_DELIVERY, ...(data.value as object) } as DeliveryConfig;
}

/** Longest matching prefix wins, so a specific zone beats a broad one. */
function matchZone(zones: DeliveryZone[], postal: string): DeliveryZone | null {
  let best: DeliveryZone | null = null;
  let bestLen = -1;
  for (const zone of zones) {
    for (const prefix of zone.prefixes) {
      if (postal.startsWith(prefix) && prefix.length > bestLen) {
        best = zone;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}

/**
 * The whole question, answered on the server.
 *
 * `orderValueInr` is what the customer would be buying — on a product page that
 * is one item's price. It is passed to quoteShipping unchanged so the threshold
 * rule behaves identically to checkout.
 *
 * Configs are arguments rather than fetched inside, so this stays pure and
 * testable and so a caller that already has them does not read twice.
 */
export function resolveDelivery({
  market,
  postalCode,
  orderValueInr,
  delivery,
  shipping,
}: {
  market: Country;
  postalCode: string;
  orderValueInr: number;
  delivery: DeliveryConfig;
  shipping: ShippingConfig;
}): DeliveryVerdict {
  if (!delivery.estimator_enabled) return { status: "unavailable" };
  if (!isValidPostalFormat(market, postalCode)) return { status: "invalid" };

  const postal = normalisePostal(market, postalCode);

  // Exclusions first: a hole inside a served region is still a hole.
  if (delivery.unserviceable_prefixes.some((p) => postal.startsWith(p))) {
    return { status: "unserviceable" };
  }

  // THE MONEY COMES FROM quoteShipping, NOT FROM HERE. Same function, same
  // config, same arguments shape as checkout.
  const quote = quoteShipping(
    { postal_code: postal, country: market.toUpperCase() },
    orderValueInr,
    shipping
  );

  const zone = matchZone(delivery.zones, postal);
  const min = zone ? zone.min_days : delivery.default_min_days;
  const max = zone ? zone.max_days : delivery.default_max_days;
  const haveDays = min > 0 && max > 0 && max >= min;

  return {
    status: "serviceable",
    days: haveDays ? { min, max } : null,
    cost: quote.cost,
    free: quote.free,
    reason: quote.reason,
    // Only worth mentioning when it would actually change this order.
    freeAboveInr:
      !quote.free && shipping.free_above_inr > 0 ? shipping.free_above_inr : null,
    zoneName: zone?.name ?? null,
    fallbackNote: haveDays ? null : delivery.fallback_note,
  };
}

/**
 * The seam a courier plugs into.
 *
 * Async and provider-shaped on purpose. Today it loads both configs and answers
 * from rules; a Shiprocket branch would sit inside this function and return the
 * same DeliveryVerdict, leaving the API route and the component untouched.
 */
export async function getDeliveryQuote({
  market,
  postalCode,
  orderValueInr,
}: {
  market: Country;
  postalCode: string;
  orderValueInr: number;
}): Promise<DeliveryVerdict> {
  const [delivery, shipping] = await Promise.all([
    getDeliveryConfig(),
    getShippingConfig(),
  ]);
  return resolveDelivery({ market, postalCode, orderValueInr, delivery, shipping });
}
