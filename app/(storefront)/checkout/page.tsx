import type { Metadata } from "next";
import CheckoutGate from "@/components/cart/CheckoutGate";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getShippingConfig } from "@/lib/shipping";
import { getCheckoutIdentity } from "@/lib/checkoutIdentity";

/**
 * Where the order gets a destination.
 *
 * A separate step rather than fields bolted onto the cart drawer: an address
 * is the most demanding thing a customer types, and a cramped panel is where
 * people mistype a postcode or give up.
 */
export const metadata: Metadata = {
  title: "Checkout | THE WOVENNE",
  // Nothing here should ever be indexed or followed.
  robots: { index: false, follow: false },
};

// Depends on who is asking — a signed-in customer sees their own details
// filled in, so this can never be cached.
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const supabase = createRSCClient();
  const [shipping, identity] = await Promise.all([
    getShippingConfig(),
    getCheckoutIdentity(supabase),
  ]);

  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto max-w-2xl">
        <p className="eyebrow">Almost there</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink">Checkout</h1>
        <p className="mt-4 text-sm text-ink/60">
          We need these details to send your order and keep you updated on it.
        </p>

        <CheckoutGate shipping={shipping} identity={identity} />
      </div>
    </div>
  );
}
