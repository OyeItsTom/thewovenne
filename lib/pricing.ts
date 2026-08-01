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

/** Whole-rupee saving, for the understated "Save ₹x" line. */
export function savingAmount(d: Discounted): number {
  return d.wasPrice == null ? 0 : d.wasPrice - d.price;
}
