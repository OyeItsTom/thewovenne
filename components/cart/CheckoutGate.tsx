"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Heart, PackageSearch, Truck, ShieldAlert } from "lucide-react";
import CheckoutForm from "@/components/cart/CheckoutForm";
import { buttonClassName } from "@/components/ui/Button";
import type { ShippingConfig } from "@/lib/shipping";
import type { CheckoutIdentity } from "@/lib/checkoutIdentity";
import {
  holdCopyFor,
  holdHref,
  readPaymentHold,
  type PaymentHold,
} from "@/lib/paymentOutcome";

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
  const [hold, setHold] = useState<PaymentHold | null>(null);

  // A PAYMENT THAT MAY HAVE LANDED CLOSES THIS SCREEN, AND TIME DOES NOT
  // REOPEN IT. Only a settlement or Razorpay reporting the payment failed
  // lifts the hold; an old one goes quiet (stale copy) but still blocks.
  //
  // Both ways back here are covered: a browser Back from the pending page
  // re-renders this component, and a restore from the back/forward cache does
  // not, which is what `pageshow` is for.
  //
  // It starts null so the first client render matches the server's and
  // hydration is clean. That leaves a frame in which the form is on screen,
  // which is why CheckoutForm.handlePay re-reads the hold synchronously before
  // it will start a charge — this half is what the customer sees, that half is
  // what actually stops them.
  useEffect(() => {
    const sync = () => setHold(readPaymentHold());
    sync();
    window.addEventListener("pageshow", sync);
    return () => window.removeEventListener("pageshow", sync);
  }, []);

  if (hold) {
    // Stale drops the specific claim, never the block — see holdCopyFor.
    const copy = holdCopyFor(hold.state, hold.stale);
    return (
      <div className="mt-10 rounded-2xl border border-terracotta/30 bg-terracotta/5 p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <ShieldAlert
            aria-hidden
            className="mt-0.5 h-5 w-5 shrink-0 text-terracotta"
            strokeWidth={1.75}
          />
          <div>
            <h2 className="font-heading text-xl text-ink">{copy.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink/70">
              {copy.body}
            </p>
            <p className="mt-3 text-sm leading-relaxed text-ink/60">
              Checkout is paused until we have confirmed it, so you cannot be
              charged twice by accident.
            </p>
            {/* A link to the explanation, never to a payment. */}
            <Link
              href={holdHref(hold.state, hold.ref)}
              className={buttonClassName("primary", "lg", "mt-5 w-full sm:w-auto")}
            >
              See what to do next
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
