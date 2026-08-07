import { createServiceClient } from "./supabase";

/**
 * Coupon validation and discount arithmetic.
 *
 * The rules are split into a PURE function (evaluateCoupon) and a thin database
 * lookup (applyCoupon). Everything that decides how much money comes off an
 * order lives in the pure half, so it can be exercised without a database, a
 * payment provider, or an order — which matters, because the shop has no orders
 * yet and the first real test of this arithmetic would otherwise be a customer.
 *
 * NEVER TRUST THE BROWSER. applyCoupon re-reads the coupon from the database
 * and recomputes the discount from the server-priced subtotal, exactly as
 * priceCart re-prices the items. The code the customer types is a claim about
 * which promotion they want, not about what it is worth.
 */

export interface CouponRow {
  id: string;
  code: string;
  discount_type: "percent" | "flat";
  discount_value: number;
  min_order_inr: number | null;
  expires_at: string | null;
  max_uses: number | null;
  times_used: number;
  once_per_customer: boolean;
  is_active: boolean;
}

export type CouponRejection =
  | "not_found"
  | "inactive"
  | "expired"
  | "exhausted"
  | "below_minimum"
  | "already_used";

export interface CouponEvaluation {
  ok: boolean;
  /** Whole rupees off the goods subtotal. Zero whenever ok is false. */
  discount: number;
  reason: CouponRejection | null;
  /** Customer-facing. Deliberately specific where that helps them act. */
  message: string | null;
  code: string | null;
}

const REJECTION_MESSAGE: Record<CouponRejection, string> = {
  // A withdrawn code and a code that never existed read the same on purpose.
  // Distinguishing them turns the checkout box into a way to enumerate which
  // promotions exist.
  not_found: "That code isn't valid. Check it and try again.",
  inactive: "That code isn't valid. Check it and try again.",
  expired: "That code has expired.",
  exhausted: "That code has been fully claimed.",
  below_minimum: "", // filled in with the threshold, which the customer can act on
  already_used: "You've already used that code.",
};

/** Rupees, whole. Money is never carried as a fraction here. */
function rupees(value: number): number {
  return Math.max(0, Math.floor(value));
}

/**
 * Decide what a coupon is worth against a subtotal.
 *
 * `subtotal` is the GOODS subtotal from priceCart — before shipping, before
 * loyalty points, and before any coupon. Shipping is excluded because a
 * discount on delivery is a different promotion from a discount on cloth, and
 * conflating them makes the free-shipping threshold incoherent.
 */
export function evaluateCoupon(
  coupon: CouponRow | null,
  ctx: { subtotal: number; now?: Date; alreadyUsedByCustomer?: boolean }
): CouponEvaluation {
  const reject = (reason: CouponRejection, message?: string): CouponEvaluation => ({
    ok: false,
    discount: 0,
    reason,
    message: message ?? REJECTION_MESSAGE[reason],
    code: coupon?.code ?? null,
  });

  if (!coupon) return reject("not_found");
  if (!coupon.is_active) return reject("inactive");

  const now = ctx.now ?? new Date();
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) {
    return reject("expired");
  }

  // Read here as well as inside redeem_coupon(). This one is for the customer,
  // so they are told at checkout rather than after paying; the one in the
  // database is the one that actually holds under concurrency.
  if (coupon.max_uses !== null && coupon.times_used >= coupon.max_uses) {
    return reject("exhausted");
  }

  if (coupon.once_per_customer && ctx.alreadyUsedByCustomer) {
    return reject("already_used");
  }

  // Compared against the subtotal BEFORE the discount — a threshold measured
  // after the discount it triggers is circular.
  if (coupon.min_order_inr !== null && ctx.subtotal < coupon.min_order_inr) {
    return reject(
      "below_minimum",
      `That code needs an order of ₹${Math.ceil(coupon.min_order_inr).toLocaleString("en-IN")} or more.`
    );
  }

  const raw =
    coupon.discount_type === "percent"
      ? (ctx.subtotal * coupon.discount_value) / 100
      : coupon.discount_value;

  // Never more than the goods are worth. A flat ₹500 off a ₹300 order takes
  // ₹300, not ₹500 — shipping and loyalty are settled separately and must not
  // be paid for out of a goods discount.
  const discount = Math.min(rupees(raw), rupees(ctx.subtotal));

  if (discount <= 0) {
    return reject("below_minimum", "That code doesn't reduce this order.");
  }

  return { ok: true, discount, reason: null, message: null, code: coupon.code };
}

/**
 * Look a code up and evaluate it, server-side.
 *
 * Uses the service client: coupons are admin-only under RLS, and the checkout
 * needs to read one without handing customers the ability to list them.
 */
export async function applyCoupon(
  code: string,
  subtotal: number,
  email: string
): Promise<CouponEvaluation> {
  const normalised = (code ?? "").trim().toUpperCase();
  if (!normalised) {
    return { ok: false, discount: 0, reason: "not_found", message: REJECTION_MESSAGE.not_found, code: null };
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("coupons")
    .select(
      "id, code, discount_type, discount_value, min_order_inr, expires_at, max_uses, times_used, once_per_customer, is_active"
    )
    .eq("code", normalised)
    .maybeSingle();

  if (error) {
    console.error("applyCoupon lookup:", error.message);
    return {
      ok: false,
      discount: 0,
      reason: "not_found",
      message: "We couldn't check that code just now. Please try again.",
      code: null,
    };
  }

  const coupon = (data as CouponRow | null) ?? null;

  // Only asked when the coupon actually cares, to keep a second query off every
  // checkout that uses an unrestricted code.
  let alreadyUsedByCustomer = false;
  if (coupon?.once_per_customer && email) {
    const { count } = await supabase
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("coupon_id", coupon.id)
      .eq("customer_email", email.trim().toLowerCase());
    alreadyUsedByCustomer = (count ?? 0) > 0;
  }

  return evaluateCoupon(coupon, { subtotal, alreadyUsedByCustomer });
}
