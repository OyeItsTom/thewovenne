"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { Clock, MessageCircle, ShieldAlert } from "lucide-react";
import { buttonClassName } from "@/components/ui/Button";
import { fadeUp, staggerContainer } from "@/lib/motion";
import { whatsappHref } from "@/lib/whatsapp";
import {
  holdCopyFor,
  isSafeGatewayRef,
  parseHoldState,
  readPaymentHold,
  writePaymentHold,
  type PaymentHold,
} from "@/lib/paymentOutcome";

/**
 * THE CART IS NOT CLEARED HERE, ON PURPOSE. Nothing has been recorded for
 * these outcomes — no stock has moved and no order is confirmed — so emptying
 * the bag would throw away a basket for a payment that may never land. It
 * stays exactly as it was; what is withheld is the ability to pay for it
 * again, which CheckoutGate and CheckoutForm both enforce off the same hold.
 *
 * NO PAYMENT ACTION APPEARS ON THIS PAGE. Not a pay button, not a retry, not
 * "return to cart" — the cart route leads one click onward to checkout, so it
 * is not offered while the hold stands. The only things here are a way to
 * reach us and a way to keep browsing.
 */
export default function PendingPaymentNotice() {
  const params = useSearchParams();
  const reduced = useReducedMotion();
  const container = staggerContainer(reduced);
  const item = fadeUp(reduced);

  const urlState = parseHoldState(params.get("state"));
  const rawRef = params.get("ref");
  const urlRef = isSafeGatewayRef(rawRef) ? rawRef : null;

  // The URL is what the redirect wrote at the time; the stored hold is what we
  // still stand behind. Starting null keeps hydration clean, so the first
  // paint uses the URL and the effect below corrects it.
  const [hold, setHold] = useState<PaymentHold | null>(null);

  // Landing here with no hold recorded — a link reopened later, a browser that
  // refused localStorage when the redirect was made — re-arms one. Someone
  // reading this page is someone whose payment may be in flight, and checkout
  // must be shut for them too.
  useEffect(() => {
    const existing = readPaymentHold();
    if (existing) {
      setHold(existing);
      return;
    }
    writePaymentHold({ state: urlState, ref: urlRef, at: Date.now() });
    setHold(readPaymentHold());
  }, [urlState, urlRef]);

  const state = hold?.state ?? urlState;
  const reference = hold?.ref ?? urlRef;
  // A hold too old to quote says so. The page still offers no way to pay.
  const copy = holdCopyFor(state, hold?.stale ?? false);

  const waHref = whatsappHref(
    reference
      ? `Hi, I need help with a payment to THE WOVENNE. My payment reference is ${reference}.`
      : "Hi, I need help with a payment to THE WOVENNE that I could not get confirmed."
  );

  const confirming = copy.tone === "confirming";
  const Icon = confirming ? Clock : ShieldAlert;

  return (
    <div className="container-wovenne section-padding flex min-h-[60vh] flex-col items-center justify-center text-center">
      <motion.div
        initial="hidden"
        animate="visible"
        variants={container}
        className="flex w-full max-w-xl flex-col items-center"
      >
        <motion.div
          variants={item}
          className={`flex h-20 w-20 items-center justify-center rounded-full ${
            confirming ? "bg-linen" : "bg-terracotta/10"
          }`}
        >
          <Icon
            aria-hidden
            className={`h-10 w-10 ${confirming ? "text-ink/50" : "text-terracotta"}`}
            strokeWidth={1.5}
          />
        </motion.div>

        <motion.h1
          variants={item}
          className="mt-6 font-heading text-4xl text-ink sm:text-5xl"
        >
          {copy.title}
        </motion.h1>

        <motion.p
          variants={item}
          className="mt-4 text-base leading-relaxed text-ink/70"
        >
          {copy.body}
        </motion.p>

        <motion.p
          variants={item}
          className="mt-3 text-sm leading-relaxed text-ink/60"
        >
          {copy.next}
        </motion.p>

        {reference && (
          <motion.div
            variants={item}
            className="mt-8 w-full rounded-2xl border border-ink/10 bg-linen/40 px-5 py-4"
          >
            <p className="eyebrow">Payment reference</p>
            {/* Selectable and unbroken — it gets copied into a message to us. */}
            <p className="mt-2 select-all break-all font-mono text-sm text-ink">
              {reference}
            </p>
          </motion.div>
        )}

        <motion.p
          variants={item}
          className="mt-6 text-sm text-ink/60"
        >
          Your bag has been left exactly as it was. Please don&rsquo;t start a
          second payment — if the first one went through, you would be charged
          twice.
        </motion.p>

        <motion.div
          variants={item}
          className="mt-8 flex flex-col gap-3 sm:flex-row"
        >
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClassName("primary", "lg")}
            >
              <MessageCircle className="h-5 w-5" /> Message us on WhatsApp
            </a>
          )}
          {/* Deliberately the shop, not the cart: the cart carries a checkout
              button, and nothing on this page should lead towards paying. */}
          <Link href="/in/shop" className={buttonClassName("outline", "lg")}>
            Continue Browsing
          </Link>
        </motion.div>

        {!waHref && (
          <motion.p variants={item} className="mt-6 text-xs text-ink/50">
            Our contact details are at the bottom of this page. Please quote the
            reference above.
          </motion.p>
        )}
      </motion.div>
    </div>
  );
}
