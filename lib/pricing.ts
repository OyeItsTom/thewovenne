import type { Product } from "./types";

/**
 * What a product costs right now.
 *
 * This mirrors public.effective_price() in supabase/migrations/0016 — same
 * rounding, same window rule, same ₹1 floor. It exists for DISPLAY only. The
 * amount a customer is actually charged is resolved server-side from the
 * database in app/api/checkout/razorpay, because anything computed in the
 * browser can be edited before it is sent.
 *
 * If the two ever disagree, the SQL version is correct by definition.
 */

export type DiscountType = "percent" | "flat";

export interface Discounted {
  /** What to charge and to show large. */
  price: number;
  /** The pre-discount price, present only when a discount is active. */
  wasPrice: number | null;
  active: boolean;
}

export function effectivePrice(
  product: Pick<
    Product,
    | "price_inr"
    | "discount_type"
    | "discount_value"
    | "discount_starts_at"
    | "discount_ends_at"
  >,
  now: Date = new Date()
): Discounted {
  const base = Math.round(product.price_inr);
  const { discount_type: type, discount_value: value } = product;

  if (!type || value == null || value <= 0) {
    return { price: base, wasPrice: null, active: false };
  }

  const starts = product.discount_starts_at
    ? new Date(product.discount_starts_at)
    : null;
  const ends = product.discount_ends_at
    ? new Date(product.discount_ends_at)
    : null;

  // Outside its window a discount is simply not there — no "starting soon" or
  // "just ended" state, which would be noise on a quiet storefront.
  if (starts && now < starts) return { price: base, wasPrice: null, active: false };
  if (ends && now >= ends) return { price: base, wasPrice: null, active: false };

  const raw =
    type === "percent" ? base * (1 - value / 100) : base - value;
  // Floor at ₹1: Razorpay rejects a zero amount, and a free order should be a
  // deliberate decision rather than the result of a mistyped discount.
  const price = Math.max(Math.round(raw), 1);

  if (price >= base) return { price: base, wasPrice: null, active: false };
  return { price, wasPrice: base, active: true };
}

type PricedProduct = Parameters<typeof effectivePrice>[0];

/**
 * THE customer-facing price: what the card shows, what "Price: low to high"
 * sorts by, and what "Under ₹1,500" compares against — one rule, so the
 * number on screen and the filter can never contradict each other.
 *
 * Before this the filter compared the stored base price: a saree at ₹1,699
 * shown as ₹1,299 was missing from "Under ₹1,500" while its card said ₹1,299.
 *
 * Display and discovery only, like effectivePrice. Checkout still charges what
 * public.effective_price() resolves server-side; stored prices are untouched.
 */
export function shownPrice(product: PricedProduct, now: Date = new Date()): number {
  return effectivePrice(product, now).price;
}

/**
 * Whether a product sits under a price ceiling, by its shown price. Inclusive,
 * as the database's `lte` was: a piece shown at exactly ₹1,500 is in
 * "Under ₹1,500". No ceiling means everything passes.
 */
export function withinPriceCeiling(
  product: PricedProduct,
  maxPrice: number | null | undefined,
  now: Date = new Date()
): boolean {
  return maxPrice == null || shownPrice(product, now) <= maxPrice;
}

/** Whole-rupee saving, for the understated "Save ₹x" line. */
export function savingAmount(d: Discounted): number {
  return d.wasPrice == null ? 0 : d.wasPrice - d.price;
}
