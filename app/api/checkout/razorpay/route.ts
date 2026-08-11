import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { razorpay } from "@/lib/razorpay";
import { createServiceClient } from "@/lib/supabase";
import { priceCart } from "@/lib/checkoutPricing";
import { validateOrderDetails } from "@/lib/orderDetails";
import { getShippingConfig, quoteShipping } from "@/lib/shipping";
import { planRedemption } from "@/lib/loyalty";
import { applyCoupon } from "@/lib/coupons";
import { settleOrder } from "@/lib/settleOrder";
import type { CartItem } from "@/lib/store";

interface CreatePayload {
  action: "create";
  items: CartItem[];
  details: unknown;
  /** Points the customer asked to spend. Validated and clamped server-side. */
  redeemPoints?: number;
  /** The code typed at checkout. Re-read and re-priced server-side. */
  couponCode?: string;
}

interface VerifyPayload {
  action: "verify";
  items: CartItem[];
  redeemPoints?: number;
  couponCode?: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as CreatePayload | VerifyPayload;

  if (body.action === "create") {
    return handleCreate(body);
  }

  if (body.action === "verify") {
    return handleVerify(body);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

async function handleCreate({ items, details: rawDetails, redeemPoints, couponCode }: CreatePayload) {
  // Validated here, not just in the form: the form runs in a browser the
  // customer controls, and an order with no deliverable address is worse than
  // a rejected checkout.
  const { details, error: detailsError } = validateOrderDetails(rawDetails);
  if (detailsError || !details) {
    return NextResponse.json({ error: detailsError }, { status: 400 });
  }

  // The cart comes from the browser, so its prices are a claim, not a fact.
  // Re-price from the database — this is what decides the amount charged, and
  // the client's own price_inr is ignored entirely.
  const { items: priced, total, error } = await priceCart(items);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  // Re-read and recomputed from the server-priced subtotal. The code is the
  // customer's claim about WHICH promotion they want; what it is worth is
  // decided here, like every other number on this order.
  //
  // A bad code does not fail the checkout. The customer is told at the point
  // they enter it, and an expired code discovered at payment time should not
  // throw away an order they still want at full price.
  const coupon = couponCode
    ? await applyCoupon(couponCode, total, details.email)
    : null;
  const couponDiscount = coupon?.ok ? coupon.discount : 0;

  // Quoted here, not taken from the request. The browser shows the customer a
  // figure, but this is the one they are charged — the same rule as prices.
  //
  // Quoted on the PRE-COUPON subtotal, deliberately. Free delivery over the
  // threshold is a promise about the size of the order someone placed, and
  // re-testing it after a discount means applying a code can make a delivery
  // charge appear — which reads as a penalty for using the promotion. The cost
  // is that a large enough coupon can carry free shipping below the threshold.
  const shippingConfig = await getShippingConfig();
  const shipping = quoteShipping(details.address, total, shippingConfig);

  // Coupon first, then points, so the points are spent against what is actually
  // left to pay. Passing the pre-coupon total here would let someone redeem
  // points they cannot use and watch the balance disappear into a floor.
  const afterCoupon = Math.max(total - couponDiscount, 0);

  // Redemption is recomputed here from the customer's real balance. The number
  // the browser sent is a request, not a fact — treating it as one would let
  // anyone mint a discount.
  const redemption = await planRedemption(details.email, redeemPoints ?? 0, afterCoupon);
  if (redemption.error) {
    return NextResponse.json({ error: redemption.error }, { status: 400 });
  }

  // Floored at ₹1: Razorpay will not create an order for zero, and a fully
  // discounted basket still has to become a payment to become an order.
  const grandTotal = Math.max(
    afterCoupon + shipping.cost - redemption.discount,
    1
  );

  try {
    // Razorpay expects the amount in the smallest unit — paise for INR.
    const amount = Math.round(grandTotal * 100);

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `wovenne_${Date.now()}`,
    });

    // Recorded BEFORE payment. If the customer abandons the modal we still know
    // who they were and what they wanted, and verify then updates this row
    // rather than inserting a second one for the same order.
    const supabase = createServiceClient();
    const row = {
      razorpay_order_id: order.id,
      customer_email: details.email,
      customer_name: details.name,
      customer_phone: details.phone,
      shipping_address: details.address,
      total_inr: grandTotal,
      shipping_cost_inr: shipping.cost,
      loyalty_points_spent: redemption.points,
      loyalty_discount_inr: redemption.discount,
      // Recorded even though total_inr is already net of it, so the invoice can
      // show the line and the admin can see which promotion won the order.
      coupon_code: coupon?.ok ? coupon.code : null,
      coupon_discount_inr: couponDiscount,
      // Snapshotted, not looked up later: what these pieces cost US as at this
      // sale, so a renegotiated cost cannot rewrite historical margin.
      //
      // A line with NO recorded cost adds nothing to this total, which means
      // the P&L will read it as pure margin. That is a real overstatement and
      // it is not hidden: the per-line cost_price_inr is preserved as null in
      // `items` below, so a report can find the orders it cannot trust and say
      // so. The alternative — refusing to sell an uncosted piece — would fail
      // checkouts over a bookkeeping gap.
      cogs_inr: priced.reduce(
        (sum, i) => sum + (i.cost_price_inr ?? 0) * i.quantity,
        0
      ),
      payment_provider: "razorpay",
      payment_status: "pending",
      items: priced.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_inr: item.price_inr,
        cost_price_inr: item.cost_price_inr,
        sku: item.sku,
      })),
    };

    let { error: insertError } = await supabase
      .from("orders")
      .insert({ ...row, delivery_updates: details.delivery_updates });

    // Deploy-ordering insurance, and it now guards two migrations rather than
    // one. This code ships the moment a PR merges; migrations are applied by
    // hand afterwards, so there is always a window where a column this insert
    // names does not exist yet — and an unknown column fails the whole insert,
    // which would mean NOBODY CAN CHECK OUT until the migration runs.
    //
    // Losing a channel preference (0034) or the record of which coupon won the
    // order (0037) is a far smaller harm than losing the order itself. The
    // AMOUNT is never at risk: grandTotal is already computed and already sent
    // to Razorpay, so a customer who used a valid code still pays the
    // discounted price even if this row cannot say so.
    const missingColumn = (e: typeof insertError, column: string) =>
      e?.code === "PGRST204" || new RegExp(column).test(e?.message ?? "");

    if (missingColumn(insertError, "delivery_updates")) {
      console.error(
        "orders.delivery_updates missing — run migration 0034. Recording the order without it."
      );
      ({ error: insertError } = await supabase.from("orders").insert(row));
    }

    if (missingColumn(insertError, "cogs_inr")) {
      console.error(
        "orders.cogs_inr missing — run migration 0038. Recording the order without cost capture; " +
          "this order will show no COGS in the P&L and cannot be backfilled."
      );
      const { cogs_inr, ...withoutCost } = row;
      void cogs_inr;
      ({ error: insertError } = await supabase.from("orders").insert(withoutCost));
    }

    if (missingColumn(insertError, "coupon_(code|discount_inr)")) {
      console.error(
        "orders.coupon_* missing — run migration 0037. Recording the order without the coupon record; " +
          `the customer was still charged the discounted amount (₹${grandTotal}).`
      );
      const { coupon_code, coupon_discount_inr, ...withoutCoupon } = row;
      void coupon_code;
      void coupon_discount_inr;
      ({ error: insertError } = await supabase.from("orders").insert(withoutCoupon));
    }

    if (insertError) {
      // Better to stop than to take money for an order we cannot ship.
      console.error("Could not record pending order:", insertError.message);
      return NextResponse.json(
        { error: "Could not start checkout. Please try again." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      orderId: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      // Echoed back so the page can show what was actually applied, which may
      // be less than asked for if the balance moved.
      redeemed: { points: redemption.points, discount: redemption.discount },
      // Echoed so the page can show what was applied — or say why it was not.
      coupon: coupon
        ? { ok: coupon.ok, code: coupon.code, discount: couponDiscount, message: coupon.message }
        : null,
      // Saves the customer retyping what they just gave us.
      prefill: {
        name: details.name,
        email: details.email,
        contact: details.phone,
      },
    });
  } catch (error) {
    console.error("Razorpay order creation error:", error);
    return NextResponse.json(
      { error: "Could not create Razorpay order." },
      { status: 500 }
    );
  }
}

async function handleVerify({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}: VerifyPayload) {
  // The payment-response signature, which uses the API KEY SECRET and the
  // `order_id|payment_id` pair. Not to be confused with the webhook signature in
  // ./webhook/route.ts, which is HMAC of the raw body under a different secret.
  const expectedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");

  // timingSafeEqual needs equal-length buffers; a hex digest is fixed-length,
  // so a length mismatch is already a failed signature.
  const provided = Buffer.from(razorpay_signature ?? "", "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  const verified =
    provided.length === expected.length &&
    crypto.timingSafeEqual(provided, expected);

  if (!verified) {
    return NextResponse.json({ verified: false });
  }

  // Everything past this point is shared with the webhook — see lib/settleOrder.
  //
  // `items` is accepted in the payload for backwards compatibility and then
  // ignored. Settlement reads the lines the SERVER priced at creation, so a
  // basket cannot be restated after payment, and so this path and the webhook
  // (which has no browser to ask) settle from the same source.
  //
  // Replaying this request is safe: every effect is guarded in the database.
  await settleOrder(razorpay_order_id, razorpay_payment_id);

  return NextResponse.json({ verified: true });
}
