import type { Metadata } from "next";
import CheckoutForm from "@/components/cart/CheckoutForm";
import { getShippingConfig } from "@/lib/shipping";

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

export default async function CheckoutPage() {
  const shipping = await getShippingConfig();

  return (
    <div className="container-wovenne section-padding">
      <div className="mx-auto max-w-2xl">
        <p className="eyebrow">Almost there</p>
        <h1 className="mt-3 font-heading text-display-sm text-ink">Checkout</h1>
        <p className="mt-4 text-sm text-ink/60">
          We need these details to send your order and keep you updated on it.
        </p>
        <CheckoutForm shipping={shipping} />
      </div>
    </div>
  );
}
