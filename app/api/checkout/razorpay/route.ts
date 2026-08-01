import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { razorpay } from "@/lib/razorpay";
import { createServiceClient } from "@/lib/supabase";
import { priceCart } from "@/lib/checkoutPricing";
import type { CartItem } from "@/lib/store";

interface CreatePayload {
  action: "create";
  items: CartItem[];
}

interface VerifyPayload {
  action: "verify";
  items: CartItem[];
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

async function handleCreate({ items }: CreatePayload) {
  // The cart comes from the browser, so its prices are a claim, not a fact.
  // Re-price from the database — this is what decides the amount charged, and
  // the client's own price_inr is ignored entirely.
  const { total, error } = await priceCart(items);
  if (error) {
    return NextResponse.json({ error }, { status: 400 });
  }

  try {
    // Razorpay expects the amount in the smallest unit — paise for INR.
    const amount = Math.round(total * 100);

    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `wovenne_${Date.now()}`,
    });

    return NextResponse.json({
      orderId: order.id,
      amount: Number(order.amount),
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
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
  const { error: insertError } = await supabase.from("orders").insert({
    total_inr:
      capturedInr ??
      priced.reduce((sum, item) => sum + item.price_inr * item.quantity, 0),
    payment_provider: "razorpay",
    payment_status: "paid",
    items: priced.map((item) => ({
      id: item.id,
      name: item.name,
      size: item.size,
      quantity: item.quantity,
      price_inr: item.price_inr,
    })),
  });

  if (insertError) {
    // The customer has paid — never fail their confirmation over a recording
    // problem. Sentry picks this up from the console error.
    console.error("Failed to record Razorpay order:", insertError.message);
  }
  if (error) {
    console.error("Order recorded with unpriced items:", error);
  }

  return NextResponse.json({ verified: true });
}
