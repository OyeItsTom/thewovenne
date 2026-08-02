"use client";

import { useState } from "react";
import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import { EMPTY_ADDRESS, type OrderDetails } from "@/lib/orderDetails";
import Button from "@/components/ui/Button";

/**
 * Contact and delivery details, then payment.
 *
 * The fields are validated again on the server — this form's job is to make
 * getting it right easy, not to be the thing that guarantees it.
 */

interface RazorpayPaymentResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void };
  }
}

const EMPTY: OrderDetails = {
  email: "",
  name: "",
  phone: "",
  address: { ...EMPTY_ADDRESS },
};

export default function CheckoutForm() {
  const router = useRouter();
  const items = useCartStore((s) => s.items);
  const clearCart = useCartStore((s) => s.clearCart);
  const [form, setForm] = useState<OrderDetails>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = items.reduce((sum, i) => sum + i.price_inr * i.quantity, 0);

  const set = (field: keyof Omit<OrderDetails, "address">) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  const setAddr = (field: keyof OrderDetails["address"]) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, address: { ...f.address, [field]: e.target.value } }));

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/checkout/razorpay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create", items, details: form }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start checkout");

      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        order_id: data.orderId,
        name: "THE WOVENNE",
        description: "Order payment",
        theme: { color: "#C2714F" },
        // Already typed above — no reason to ask twice.
        prefill: data.prefill,
        handler: async (response: RazorpayPaymentResponse) => {
          const verifyRes = await fetch("/api/checkout/razorpay", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "verify", items, ...response }),
          });
          const verifyData = await verifyRes.json();
          if (verifyData.verified) {
            clearCart();
            router.push("/checkout/success");
          } else {
            router.push("/checkout/cancel");
          }
        },
        modal: { ondismiss: () => setLoading(false) },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="mt-10 rounded-2xl border border-ink/10 bg-linen/40 p-10 text-center">
        <p className="font-heading text-2xl text-ink">Your cart is empty</p>
        <Link
          href="/shop"
          className="mt-4 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
        >
          Browse the collection
        </Link>
      </div>
    );
  }

  return (
    <>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="lazyOnload" />

      <form onSubmit={handlePay} className="mt-10 space-y-8">
        <section className="space-y-4">
          <h2 className="font-heading text-xl text-ink">Contact</h2>
          <Field
            label="Email"
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
            hint="Your order confirmation and tracking updates go here."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full name" required autoComplete="name" value={form.name} onChange={set("name")} />
            <Field label="Phone" type="tel" required autoComplete="tel" value={form.phone} onChange={set("phone")} />
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="font-heading text-xl text-ink">Delivery address</h2>
          <Field label="Address" required autoComplete="address-line1" value={form.address.line1} onChange={setAddr("line1")} />
          <Field label="Apartment, suite, etc. (optional)" autoComplete="address-line2" value={form.address.line2} onChange={setAddr("line2")} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Town / city" required autoComplete="address-level2" value={form.address.city} onChange={setAddr("city")} />
            <Field label="State" autoComplete="address-level1" value={form.address.state} onChange={setAddr("state")} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="PIN / postcode" required autoComplete="postal-code" value={form.address.postal_code} onChange={setAddr("postal_code")} />
            <Field label="Country" required autoComplete="country-name" value={form.address.country} onChange={setAddr("country")} />
          </div>
        </section>

        <div className="rounded-xl border border-ink/10 bg-linen/40 p-5">
          <div className="flex items-center justify-between font-body text-lg text-ink">
            <span>Total</span>
            <span>{formatINR(subtotal)}</span>
          </div>
          <p className="mt-1 text-xs text-ink/50">
            {items.reduce((n, i) => n + i.quantity, 0)} item
            {items.reduce((n, i) => n + i.quantity, 0) === 1 ? "" : "s"} · the
            final amount is confirmed by our server before payment.
          </p>
        </div>

        {error && (
          <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
            {error}
          </p>
        )}

        {/* No account required — guests check out and are never added to any
            mailing list by doing so. */}
        <Button type="submit" size="lg" className="w-full" disabled={loading}>
          {loading ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Opening payment…
            </span>
          ) : (
            `Pay ${formatINR(subtotal)}`
          )}
        </Button>

        <p className="text-center text-xs text-ink/50">
          Payment is handled by Razorpay. Card details never touch our servers.
        </p>
      </form>
    </>
  );
}

function Field({
  label,
  hint,
  ...props
}: {
  label: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-ink/70">{label}</span>
      <input
        {...props}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2.5 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
      {hint && <span className="mt-1 block text-xs text-ink/50">{hint}</span>}
    </label>
  );
}
