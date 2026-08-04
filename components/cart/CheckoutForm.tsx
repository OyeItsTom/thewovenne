"use client";

import { useState } from "react";
import Script from "next/script";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { useCartStore } from "@/lib/store";
import { formatINR } from "@/lib/utils";
import { type OrderDetails, type DeliveryChannel } from "@/lib/orderDetails";
import { quoteShipping, type ShippingConfig } from "@/lib/shipping";
import type { CheckoutIdentity } from "@/lib/checkoutIdentity";
import Button from "@/components/ui/Button";

/**
 * Contact and delivery details, then payment.
 *
 * The fields are validated again on the server — this form's job is to make
 * getting it right easy, not to be the thing that guarantees it.
 *
 * A SIGNED-IN CUSTOMER IS NOT ASKED WHO THEY ARE. Name and email come from the
 * account and are shown as a fact, not a field: re-typing them invites a typo
 * that sends the receipt to an address the account cannot see. What is still
 * asked is what genuinely varies per parcel — where it goes, and the number
 * the courier should ring.
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

export default function CheckoutForm({
  shipping: shippingConfig,
  identity,
}: {
  shipping: ShippingConfig;
  identity: CheckoutIdentity;
}) {
  const router = useRouter();
  const items = useCartStore((s) => s.items);
  const clearCart = useCartStore((s) => s.clearCart);
  const [form, setForm] = useState<OrderDetails>({
    email: identity.email,
    name: identity.name,
    phone: identity.phone,
    address: { ...identity.address },
    delivery_updates: "email",
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const subtotal = items.reduce((sum, i) => sum + i.price_inr * i.quantity, 0);
  // Same function the server charges with, so what is shown and what is taken
  // cannot drift. The server still decides.
  const shipping = quoteShipping(form.address, subtotal, shippingConfig);
  const grandTotal = subtotal + shipping.cost;

  const set = (field: keyof Omit<OrderDetails, "address">) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  const setAddr = (field: keyof OrderDetails["address"]) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, address: { ...f.address, [field]: e.target.value } }));

  const setChannel = (delivery_updates: DeliveryChannel) =>
    setForm((f) => ({ ...f, delivery_updates }));

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
            router.push("/in/checkout/success");
          } else {
            router.push("/in/checkout/cancel");
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
          href="/in/shop"
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

          {identity.signedIn ? (
            <>
              {/* Shown, not asked. The account already holds these, and the
                  receipt has to reach the address the account can see. */}
              <div className="rounded-xl border border-ink/10 bg-linen/40 px-4 py-3.5 text-sm">
                <p className="text-ink">{identity.name || "Your account"}</p>
                <p className="mt-0.5 text-ink/60">{identity.email}</p>
                <p className="mt-2 text-xs text-ink/50">
                  From your account.{" "}
                  <Link
                    href="/in/account/settings"
                    className="border-b border-ink/30 pb-px hover:text-ink"
                  >
                    Change your name
                  </Link>
                </p>
              </div>
              <Field
                label="Phone"
                type="tel"
                required
                autoComplete="tel"
                value={form.phone}
                onChange={set("phone")}
                hint="For the courier, if they need to reach you on the day."
              />
            </>
          ) : (
            <>
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
            </>
          )}
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

          {identity.prefilledFromLastOrder && (
            <p className="text-xs text-ink/50">
              Filled in from your last order — change anything that&apos;s
              different this time.
            </p>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-heading text-xl text-ink">Delivery updates</h2>
          <p className="text-sm text-ink/60">
            How you&apos;d like to hear as your order moves.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <ChannelOption
              value="email"
              checked={form.delivery_updates === "email"}
              onChange={setChannel}
              title="Email"
              blurb="Sent to the address on this order."
            />
            <ChannelOption
              value="whatsapp"
              checked={form.delivery_updates === "whatsapp"}
              onChange={setChannel}
              title="WhatsApp"
              // Says plainly that this is a preference, not a promise. A
              // channel that cannot send yet must not imply a message is
              // coming — that is worse than not offering it.
              blurb="Coming soon — we'll note your preference and email you meanwhile."
            />
          </div>

          <p className="text-xs text-ink/50">
            Your order confirmation always arrives by email either way — it is
            your receipt.
          </p>
        </section>

        <div className="rounded-xl border border-ink/10 bg-linen/40 p-5">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink/60">Items</dt>
              <dd className="text-ink">{formatINR(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink/60">Delivery</dt>
              <dd className={shipping.free ? "text-terracotta" : "text-ink"}>
                {shipping.free ? "Free" : formatINR(shipping.cost)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-ink/10 pt-2 font-body text-lg text-ink">
              <dt>Total</dt>
              <dd>{formatINR(grandTotal)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink/50">{shipping.reason}</p>
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
            `Pay ${formatINR(grandTotal)}`
          )}
        </Button>

        <p className="text-center text-xs text-ink/50">
          Payment is handled by Razorpay. Card details never touch our servers.
        </p>
      </form>
    </>
  );
}

function ChannelOption({
  value,
  checked,
  onChange,
  title,
  blurb,
}: {
  value: DeliveryChannel;
  checked: boolean;
  onChange: (v: DeliveryChannel) => void;
  title: string;
  blurb: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition-colors ${
        checked
          ? "border-terracotta bg-terracotta/5"
          : "border-ink/15 bg-white hover:border-ink/30"
      }`}
    >
      <input
        type="radio"
        name="delivery_updates"
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        className="mt-1 h-4 w-4 shrink-0 accent-terracotta"
      />
      <span className="block">
        <span className="block text-sm font-medium text-ink">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink/55">
          {blurb}
        </span>
      </span>
    </label>
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
