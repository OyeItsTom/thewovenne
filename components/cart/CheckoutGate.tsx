"use client";

import { useState } from "react";
import Link from "next/link";
import { Heart, PackageSearch, Truck } from "lucide-react";
import CheckoutForm from "@/components/cart/CheckoutForm";
import { buttonClassName } from "@/components/ui/Button";
import type { ShippingConfig } from "@/lib/shipping";
import type { CheckoutIdentity } from "@/lib/checkoutIdentity";

/**
 * The fork a guest meets before the checkout form.
 *
 * IT IS A CHOICE, NOT A GATE. Forcing an account is the single most reliable
 * way to lose a sale that was otherwise made — someone who has chosen a piece
 * and reached for their card should never be asked to invent a password first.
 * So "Continue as guest" is a real, equal option, and it is listed first.
 *
 * IT SHARES ITS WORDING AND ICONS WITH GuestAccountModal on purpose — the same
 * three choices described two different ways reads as two different features.
 *
 * Button colours match the modal exactly: terracotta on "Create account", ink
 * on "Sign in", outline on "Continue as guest". One action, one colour,
 * wherever it appears — an accent that means "create an account" here and
 * "skip creating an account" one screen earlier teaches nothing.
 *
 * Guest is still a real, prominent, full-size button and still listed first.
 * It gives up the accent colour, not its standing.
 *
 * The account side gets the reasons rather than the insistence: what an account
 * does for them, in their terms. Signed-in customers never see this screen at
 * all — they are already past the question.
 */
export default function CheckoutGate({
  shipping,
  identity,
}: {
  shipping: ShippingConfig;
  identity: CheckoutIdentity;
}) {
  const [asGuest, setAsGuest] = useState(false);

  if (identity.signedIn || asGuest) {
    return <CheckoutForm shipping={shipping} identity={identity} />;
  }

  return (
    <div className="mt-10 space-y-4">
      <div className="rounded-2xl border border-ink/10 bg-cream p-6 sm:p-7">
        <h2 className="font-heading text-xl text-ink">Continue as guest</h2>
        <p className="mt-2 text-sm text-ink/60">
          No account needed. Your order confirmation and delivery updates go to
          the email you enter next.
        </p>
        <button
          type="button"
          onClick={() => setAsGuest(true)}
          className={buttonClassName("outline", "lg", "mt-5 w-full sm:w-auto")}
        >
          Continue as guest
        </button>
      </div>

      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-6 sm:p-7">
        <h2 className="font-heading text-xl text-ink">Create an account</h2>
        <p className="mt-2 text-sm text-ink/70">
          Create an account to track your orders, save items to your wishlist,
          and check out faster next time.
        </p>

        <ul className="mt-4 space-y-2.5 text-sm text-ink/60">
          <li className="flex items-start gap-2.5">
            <PackageSearch aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Follow every order from payment to doorstep
          </li>
          <li className="flex items-start gap-2.5">
            <Heart aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Keep a wishlist of the pieces you&apos;re considering
          </li>
          <li className="flex items-start gap-2.5">
            <Truck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-terracotta" />
            Save your address for faster checkout next time
          </li>
        </ul>

        <div className="mt-5 flex flex-wrap gap-3">
          {/* ?from= brings them back here with the cart intact, rather than
              landing them on the homepage to find their way back. */}
          <Link
            href="/in/signup?from=/in/checkout"
            className={buttonClassName("primary", "lg")}
          >
            Create account
          </Link>
          <Link
            href="/in/login?from=/in/checkout"
            className={buttonClassName("secondary", "lg")}
          >
            Sign in
          </Link>
        </div>
      </div>

      <p className="text-center text-xs text-ink/50">
        Your basket is saved either way.
      </p>
    </div>
  );
}
