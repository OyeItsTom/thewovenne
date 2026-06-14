import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { razorpay } from "@/lib/razorpay";
import { createServiceClient } from "@/lib/supabase";
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
  if (!items || items.length === 0) {
    return NextResponse.json(
      { error: "Your cart is empty." },
      { status: 400 }
    );
  }

  try {
    const amount = Math.round(
      items.reduce((sum, item) => sum + item.price_gbp * item.quantity, 0) *
        100
    );

    const order = await razorpay.orders.create({
      amount,
      currency: "GBP",
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

  const verified = expectedSignature === razorpay_signature;

  if (verified) {
    const supabase = createServiceClient();
    const { error } = await supabase.from("orders").insert({
      total_gbp: items.reduce(
        (sum, item) => sum + item.price_gbp * item.quantity,
        0
      ),
      payment_provider: "razorpay",
      payment_status: "paid",
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        size: item.size,
        quantity: item.quantity,
        price_gbp: item.price_gbp,
      })),
    });

    if (error) {
      console.error("Failed to record Razorpay order:", error.message);
    }
  }

  return NextResponse.json({ verified });
}
