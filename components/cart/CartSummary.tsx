"use client";

import Link from "next/link";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import { buttonClassName } from "@/components/ui/Button";

/**
 * The cart's running total, and the way on to checkout.
 *
 * Payment used to start from here, which meant an order could be paid for with
 * no email and nowhere to send it. Contact and delivery details are collected
 * at /checkout first; the Razorpay call now lives there, after the details
 * exist.
 */
export default function CartSummary() {
  const items = useCartStore((s) => s.items);
  const subtotal = useCartStore((s) => s.subtotal());
  const empty = items.length === 0;

  return (
    <div className="rounded-2xl bg-linen/60 p-6 sm:p-8">
      <div className="flex items-center justify-between font-heading text-xl text-ink">
        <span>Subtotal</span>
        <span>{formatINR(subtotal)}</span>
      </div>
      <p className="mt-1 text-xs text-ink/50">
        Shipping &amp; taxes calculated at checkout.
      </p>

      <div className="mt-6">
        {empty ? (
          <span
            aria-disabled
            className={buttonClassName("primary", "lg", "w-full opacity-40")}
          >
            Continue to checkout
          </span>
        ) : (
          <Link href="/in/checkout" className={buttonClassName("primary", "lg", "w-full")}>
            Continue to checkout
          </Link>
        )}
      </div>
      <p className="mt-3 text-center text-xs text-ink/50">
        Secure payment by Razorpay · UPI · GPay · Cards
      </p>
    </div>
  );
}
