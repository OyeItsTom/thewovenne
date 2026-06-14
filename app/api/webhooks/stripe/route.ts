import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase";
import type { OrderItem } from "@/lib/types";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (error) {
    console.error("Stripe webhook signature verification failed:", error);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;

    let items: OrderItem[] = [];
    try {
      items = session.metadata?.items
        ? JSON.parse(session.metadata.items)
        : [];
    } catch {
      items = [];
    }

    const supabase = createServiceClient();
    const { error } = await supabase.from("orders").insert({
      customer_email: session.customer_details?.email ?? null,
      total_gbp: (session.amount_total ?? 0) / 100,
      payment_provider: "stripe",
      payment_status: "paid",
      items,
    });

    if (error) {
      console.error("Failed to record Stripe order:", error.message);
    }
  }

  return NextResponse.json({ received: true });
}
