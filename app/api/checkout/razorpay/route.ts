import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { razorpay } from "@/lib/razorpay";
import { createServiceClient } from "@/lib/supabase";
import { priceCart } from "@/lib/checkoutPricing";
import { validateOrderDetails } from "@/lib/orderDetails";
import { getShippingConfig, quoteShipping } from "@/lib/shipping";
import { planRedemption } from "@/lib/loyalty";
import { settleLoyalty } from "@/lib/settleLoyalty";
import { sendOrderConfirmation } from "@/lib/sendOrderConfirmation";
import type { CartItem } from "@/lib/store";

interface CreatePayload {
  action: "create";
  items: CartItem[];
  details: unknown;
  /** Points the customer asked to spend. Validated and clamped server-side. */
  redeemPoints?: number;
}

interface VerifyPayload {
  action: "verify";
  items: CartItem[];
  redeemPoints?: number;
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

async function handleCreate({ items, details: rawDetails, redeemPoints }: CreatePayload) {
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

  // Quoted here, not taken from the request. The browser shows the customer a
  // figure, but this is the one they are charged — the same rule as prices.
  const shippingConfig = await getShippingConfig();
  const shipping = quoteShipping(details.address, total, shippingConfig);

  // Redemption is recomputed here from the customer's real balance. The number
  // the browser sent is a request, not a fact — treating it as one would let
  // anyone mint a discount.
  const redemption = await planRedemption(details.email, redeemPoints ?? 0, total);
  if (redemption.error) {
    return NextResponse.json({ error: redemption.error }, { status: 400 });
  }

  const grandTotal = Math.max(total + shipping.cost - redemption.discount, 1);

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
      payment_provider: "razorpay",
      payment_status: "pending",
      items: priced.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_inr: item.price_inr,
      })),
    };

    let { error: insertError } = await supabase
      .from("orders")
      .insert({ ...row, delivery_updates: details.delivery_updates });

    // Deploy-ordering insurance. If this code reaches production before
    // migration 0034 does, delivery_updates is an unknown column and the
    // insert fails — which would mean NOBODY CAN CHECK OUT until the migration
    // runs. Losing the customer's channel preference is a far smaller harm than
    // losing the order, so it retries without it and the order still lands.
    if (insertError?.code === "PGRST204" || /delivery_updates/.test(insertError?.message ?? "")) {
      console.error(
        "orders.delivery_updates missing — run migration 0034. Recording the order without it."
      );
      ({ error: insertError } = await supabase.from("orders").insert(row));
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
  let stockShort = false;
  try {
    const { error: stockError } = await supabase.rpc("reserve_stock", {
      p_items: priced.map((i) => ({
        id: i.id,
        size: i.size,
        quantity: i.quantity,
      })),
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
      items: priced.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_inr: item.price_inr,
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
      })),
    });
  }
  if (error) {
    console.error("Order recorded with unpriced items:", error);
  }

  // Points move only after payment, and only through the database functions —
  // both are guarded so a retry cannot pay out twice or spend a balance twice.
  await settleLoyalty(razorpay_order_id);

  // Sent last, and deliberately not awaited for its success: the customer has
  // paid and their confirmation page must not wait on an email provider, nor
  // fail because one is down. A failure is logged, and the order exists
  // regardless — it can always be re-sent from the admin.
  void sendOrderConfirmation(razorpay_order_id).catch((e) =>
    console.error("Order confirmation email failed:", e)
  );

  return NextResponse.json({ verified: true });
}
