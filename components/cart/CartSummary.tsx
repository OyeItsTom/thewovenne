"use client";

import { useState } from "react";
import Script from "next/script";
import { useCartStore } from "@/lib/store";
import { formatGBP } from "@/lib/utils";
import Button from "@/components/ui/Button";

interface RazorpayPaymentResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  order_id: string;
  name: string;
  description?: string;
  theme?: { color: string };
  handler: (response: RazorpayPaymentResponse) => void;
  modal?: { ondismiss?: () => void };
}

interface RazorpayInstance {
  open: () => void;
}

declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export default function CartSummary() {
  const items = useCartStore((s) => s.items);
  const subtotal = useCartStore((s) => s.subtotal());
  const clearCart = useCartStore((s) => s.clearCart);
  const [loading, setLoading] = useState<"stripe" | "razorpay" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleStripeCheckout = async () => {
    setError(null);
    setLoading("stripe");
    try {
      const res = await fetch("/api/checkout/stripe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.error || "Could not start checkout");
      }
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(null);
    }
  };

  const handleRazorpayCheckout = async () => {
    setError(null);
    setLoading("razorpay");
    try {
      const res = await fetch("/api/checkout/razorpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", items }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Could not start checkout");
      }

      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        order_id: data.orderId,
        name: "THE WOVENNE",
        description: "Order payment",
        theme: { color: "#C2714F" },
        handler: async (response) => {
          const verifyRes = await fetch("/api/checkout/razorpay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "verify", items, ...response }),
          });
          const verifyData = await verifyRes.json();
          if (verifyData.verified) {
            clearCart();
            window.location.href = "/checkout/success";
          } else {
            window.location.href = "/checkout/cancel";
          }
        },
        modal: {
          ondismiss: () => setLoading(null),
        },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(null);
    }
  };

  return (
    <>
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="lazyOnload"
      />
      <div className="rounded-2xl bg-linen/60 p-6 sm:p-8">
        <div className="flex items-center justify-between font-heading text-xl text-ink">
          <span>Subtotal</span>
          <span>{formatGBP(subtotal)}</span>
        </div>
        <p className="mt-1 text-xs text-ink/50">
          Shipping &amp; taxes calculated at checkout.
        </p>

        {error && <p className="mt-4 text-sm text-terracotta-dark">{error}</p>}

        <div className="mt-6 space-y-3">
          <Button
            onClick={handleStripeCheckout}
            disabled={loading !== null}
            size="lg"
            className="w-full"
          >
            {loading === "stripe" ? "Redirecting…" : "Pay with Card (Stripe)"}
          </Button>
          <Button
            onClick={handleRazorpayCheckout}
            disabled={loading !== null}
            variant="secondary"
            size="lg"
            className="w-full"
          >
            {loading === "razorpay" ? "Opening…" : "Pay via Razorpay"}
          </Button>
        </div>
      </div>
    </>
  );
}
