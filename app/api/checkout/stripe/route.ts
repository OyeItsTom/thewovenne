import { NextRequest, NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import type { CartItem } from "@/lib/store";

export async function POST(request: NextRequest) {
  try {
    const { items } = (await request.json()) as { items: CartItem[] };

    if (!items || items.length === 0) {
      return NextResponse.json(
        { error: "Your cart is empty." },
        { status: 400 }
      );
    }

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";

    const line_items = items.map((item) => ({
      price_data: {
        currency: "gbp",
        product_data: {
          name: `${item.name} (${item.size})`,
          images: item.image_url ? [item.image_url] : undefined,
        },
        unit_amount: Math.round(item.price_gbp * 100),
      },
      quantity: item.quantity,
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: `${siteUrl}/checkout/success`,
      cancel_url: `${siteUrl}/checkout/cancel`,
      shipping_address_collection: { allowed_countries: ["GB"] },
      metadata: {
        items: JSON.stringify(
          items.map((item) => ({
            id: item.id,
            name: item.name,
            size: item.size,
            quantity: item.quantity,
            price_gbp: item.price_gbp,
          }))
        ),
      },
    });

    return NextResponse.json({ url: session.url });
  } catch (error) {
    console.error("Stripe checkout error:", error);
    return NextResponse.json(
      { error: "Could not create checkout session." },
      { status: 500 }
    );
  }
}
