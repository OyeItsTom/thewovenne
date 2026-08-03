"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import AuthMessage from "./AuthMessage";
import { setDefaultAddress } from "@/lib/customerAuth";
import { EMPTY_ADDRESS, type ShippingAddress } from "@/lib/orderDetails";

/**
 * Where this customer's orders usually go.
 *
 * ONE ADDRESS, NOT A BOOK — the reasoning is in migration 0035. It exists to
 * save typing, so it is offered at checkout as a starting point and stays
 * fully editable there.
 *
 * It cannot change an order already placed: every order copies the address it
 * was placed with. Said plainly at the foot of the panel, because "update
 * address" is exactly the phrase someone reaches for when they meant "redirect
 * the parcel I just bought", and letting them believe that worked would be the
 * expensive kind of misunderstanding.
 */
export default function DeliveryAddress({
  address,
  phone,
}: {
  address: Record<string, string> | null;
  phone: string | null;
}) {
  const [form, setForm] = useState<ShippingAddress>({
    ...EMPTY_ADDRESS,
    ...(address ?? {}),
  });
  const [tel, setTel] = useState(phone ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (field: keyof ShippingAddress) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [field]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);

    const result = await setDefaultAddress({ ...form }, tel.trim());
    setBusy(false);
    if (result.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } else {
      setError(result.error);
    }
  }

  return (
    <section className="rounded-2xl border border-ink/10 bg-cream p-6">
      <h2 className="font-heading text-xl text-ink">Delivery address</h2>
      <p className="mt-1.5 text-sm text-ink/60">
        Saved and filled in for you next time you check out.
      </p>

      <form onSubmit={save} className="mt-5 space-y-4">
        <Field label="Address" autoComplete="address-line1" value={form.line1} onChange={set("line1")} />
        <Field label="Apartment, suite, etc. (optional)" autoComplete="address-line2" value={form.line2} onChange={set("line2")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Town / city" autoComplete="address-level2" value={form.city} onChange={set("city")} />
          <Field label="State" autoComplete="address-level1" value={form.state} onChange={set("state")} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="PIN / postcode" autoComplete="postal-code" value={form.postal_code} onChange={set("postal_code")} />
          <Field label="Country" autoComplete="country-name" value={form.country} onChange={set("country")} />
        </div>
        <Field
          label="Phone"
          type="tel"
          autoComplete="tel"
          value={tel}
          onChange={(e) => setTel(e.target.value)}
          hint="For the courier, if they need to reach you on the day."
        />

        <div className="flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={busy}>
            {busy ? (
              <span className="inline-flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Saving…
              </span>
            ) : (
              "Save address"
            )}
          </Button>
          {saved && !busy && <span className="text-sm text-ink/60">Saved.</span>}
        </div>

        {error && <AuthMessage tone="error">{error}</AuthMessage>}
      </form>

      <p className="mt-5 border-t border-ink/10 pt-4 text-xs leading-relaxed text-ink/50">
        Changing this won&apos;t move an order that&apos;s already on its way —
        each order keeps the address it was placed with. To redirect something
        already bought, contact us.
      </p>
    </section>
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
