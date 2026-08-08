import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { razorpay } from "@/lib/razorpay";
import { createServiceClient } from "@/lib/supabase";
import { priceCart } from "@/lib/checkoutPricing";
import { validateOrderDetails } from "@/lib/orderDetails";
import { getShippingConfig, quoteShipping } from "@/lib/shipping";
import { planRedemption } from "@/lib/loyalty";
import { applyCoupon } from "@/lib/coupons";
import { settleLoyalty } from "@/lib/settleLoyalty";
import { sendOrderConfirmation } from "@/lib/sendOrderConfirmation";
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
  items,
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}: VerifyPayload) {
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

  // Line items are re-priced rather than taken from the request, for the same
  // reason as above: the order record should say what was actually sold.
  const { items: priced, error } = await priceCart(items);

  // The recorded total is what Razorpay actually captured, not a recomputation.
  // Re-pricing here could disagree with the create call if a discount window
  // closed in between, and the payment is the fact of record.
  let capturedInr: number | null = null;
  try {
    const order = await razorpay.orders.fetch(razorpay_order_id);
    capturedInr = Number(order.amount) / 100;
  } catch (e) {
    console.error("Could not fetch Razorpay order for amount:", e);
  }

  // What Razorpay actually took. Read here, at verification, because it is only
  // knowable once a payment exists — and it is a real cost of every sale that
  // would otherwise never appear in the P&L, quietly overstating profit on
  // every order.
  //
  // Fee and tax stay separate: they are separate lines on Razorpay's settlement,
  // and netting them together loses the input credit once GST registration
  // happens. Both arrive in paise.
  //
  // Never fatal. A fee we could not read is a reporting gap; failing a
  // confirmation the customer has already paid for is not.
  let gatewayFeeInr: number | null = null;
  let gatewayTaxInr: number | null = null;
  try {
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (payment?.fee !== undefined && payment.fee !== null) {
      gatewayFeeInr = Number(payment.fee) / 100;
    }
    if (payment?.tax !== undefined && payment.tax !== null) {
      gatewayTaxInr = Number(payment.tax) / 100;
    }
  } catch (e) {
    console.error(
      `Could not read Razorpay fees for payment ${razorpay_payment_id} — this order will show no gateway cost:`,
      e
    );
  }

  const supabase = createServiceClient();

  // Stock comes out HERE, after payment is confirmed, and atomically —
  // reserve_stock decrements with the guard inside the UPDATE, so two buyers
  // racing for the last unit cannot both succeed.
  //
  // The cost of decrementing after payment rather than before is a window of a
  // few seconds in which both can pay. When that happens the customer is NOT
  // failed — they have paid, and refusing their confirmation over our stock
  // arithmetic would be indefensible. The order is flagged instead, so a human
  // can refund or restock deliberately.
  // Read BEFORE the stock comes out: reserve_stock records a movement per line
  // and that movement is far more useful attached to the order that caused it —
  // particularly for a return, which has to know what to put back and why.
  const { data: pendingRow } = await supabase
    .from("orders")
    .select("id")
    .eq("razorpay_order_id", razorpay_order_id)
    .maybeSingle();
  const orderRowId = (pendingRow as { id?: string } | null)?.id ?? null;

  let stockShort = false;
  try {
    const { error: stockError } = await supabase.rpc("reserve_stock", {
      p_items: priced.map((i) => ({
        id: i.id,
        size: i.size,
        quantity: i.quantity,
      })),
      p_order_id: orderRowId,
    });
    if (stockError) {
      stockShort = true;
      console.error(
        `Stock could not be reserved for paid order ${razorpay_order_id}: ${stockError.message}`
      );
    }
  } catch (e) {
    stockShort = true;
    console.error("reserve_stock threw:", e);
  }

  // UPDATE, not insert: handleCreate already wrote this row with the customer's
  // contact and address. Inserting here would leave two rows for one order, the
  // paid one missing the details needed to ship it.
  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update({
      payment_status: "paid",
      // Surfaces in the admin as an order needing attention rather than one
      // quietly shipped from stock that was not there.
      tracking_status: stockShort ? "needs_review" : null,
      total_inr:
        capturedInr ??
        priced.reduce((sum, item) => sum + item.price_inr * item.quantity, 0),
      gateway_fee_inr: gatewayFeeInr,
      gateway_tax_inr: gatewayTaxInr,
      items: priced.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_inr: item.price_inr,
        cost_price_inr: item.cost_price_inr,
        sku: item.sku,
      })),
    })
    .eq("razorpay_order_id", razorpay_order_id)
    .select("id");

  if (updateError) {
    // The customer has paid — never fail their confirmation over a recording
    // problem. Sentry picks this up from the console error.
    console.error("Failed to mark order paid:", updateError.message);
  } else if (!updated?.length) {
    // Paid, but no pending row to update. Should not happen, and losing a paid
    // order silently would be far worse than a duplicate, so record what we
    // have and shout about it.
    console.error(
      `Paid order ${razorpay_order_id} had no pending row — recording without contact details.`
    );
    await supabase.from("orders").insert({
      razorpay_order_id,
      payment_provider: "razorpay",
      payment_status: "paid",
      total_inr: capturedInr,
      items: priced.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_inr: item.price_inr,
        cost_price_inr: item.cost_price_inr,
        sku: item.sku,
      })),
    });
  }
  if (error) {
    console.error("Order recorded with unpriced items:", error);
  }

  // Points move only after payment, and only through the database functions —
  // both are guarded so a retry cannot pay out twice or spend a balance twice.
  await settleLoyalty(razorpay_order_id);

  // The coupon use is claimed HERE, not at checkout-start. handleCreate writes
  // a pending row before the customer has paid, and counting a use there would
  // let abandoned payment modals burn a launch code's entire allowance.
  //
  // The trade-off is the same window reserve_stock accepts above: for a few
  // seconds more people can be mid-payment than there are uses left, so a
  // "first 50" can overshoot slightly. Overshooting a promotion is a rounding
  // error. Refusing someone who has already paid is not, so this NEVER fails
  // the confirmation — a use that cannot be claimed is logged and the order
  // stands, because the money has already moved at the discounted price.
  //
  // redeem_coupon() is idempotent per order, so a retried verification counts
  // once.
  const paidOrderId = updated?.[0]?.id ?? null;
  if (paidOrderId) {
    const { data: order } = await supabase
      .from("orders")
      .select("coupon_code, coupon_discount_inr, customer_email")
      .eq("id", paidOrderId)
      .maybeSingle();

    const used = order as {
      coupon_code?: string | null;
      coupon_discount_inr?: number | null;
      customer_email?: string | null;
    } | null;

    if (used?.coupon_code) {
      const { data: claimed, error: redeemError } = await supabase.rpc("redeem_coupon", {
        p_code: used.coupon_code,
        p_order_id: paidOrderId,
        p_email: used.customer_email ?? "",
        p_discount: used.coupon_discount_inr ?? 0,
      });
      if (redeemError) {
        console.error(
          `Could not record coupon ${used.coupon_code} for paid order ${razorpay_order_id}: ${redeemError.message}`
        );
      } else if (claimed === false) {
        // Exhausted or withdrawn between checkout and payment. The customer
        // keeps their discount — they were charged it — and this is a note for
        // whoever reconciles the promotion, not a problem to push back at them.
        console.error(
          `Coupon ${used.coupon_code} could not be claimed for paid order ${razorpay_order_id} ` +
            `(exhausted or withdrawn mid-payment). Discount was honoured.`
        );
      }
    }

    // The invoice NUMBER is assigned now; the PDF is rendered on demand. A
    // number identifies a financial event, so it belongs to the moment the
    // payment succeeded — but rendering a document here would put a PDF
    // between the customer and their confirmation page, which is the same
    // reason the confirmation email is not awaited.
    const { error: invoiceError } = await supabase.rpc("assign_invoice_number", {
      p_order_id: paidOrderId,
    });
    if (invoiceError) {
      console.error(
        `Could not assign an invoice number to paid order ${razorpay_order_id}: ${invoiceError.message}`
      );
    }
  }

  // Sent last, and deliberately not awaited for its success: the customer has
  // paid and their confirmation page must not wait on an email provider, nor
  // fail because one is down. A failure is logged, and the order exists
  // regardless — it can always be re-sent from the admin.
  void sendOrderConfirmation(razorpay_order_id).catch((e) =>
    console.error("Order confirmation email failed:", e)
  );

  return NextResponse.json({ verified: true });
}
