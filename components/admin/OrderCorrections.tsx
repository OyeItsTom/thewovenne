"use client";

import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";
import type { Order } from "@/lib/orders";

/**
 * The three corrections an admin can make to an order, each through its own
 * database function with a mandatory reason (0078, WP-ORDER-SAFETY-06):
 *
 *   - "Not delivered after all": a dispatched order marked delivered by
 *     mistake goes back to shipped (admin_correct_order_status).
 *   - "Correct delivery details": name, phone and delivery address before
 *     dispatch (admin_correct_order_contact). Never the email, the state or
 *     the country; the replaced values are kept in a correction log.
 *   - "Back on the shelf": a cancelled IN-PERSON order is not restocked when it
 *     is cancelled, because nothing records whether the piece was handed over.
 *     The admin states it is on the shelf and the stock comes back, once
 *     (admin_return_in_person_stock).
 *
 * None of them changes an amount, a payment, the invoice number or a credit
 * note, and none re-opens a cancelled order. Each is offered only where the
 * database would accept it; the database still decides.
 */
type Mode = "undeliver" | "contact" | "shelf";

const MIN_REASON = 10;

export default function OrderCorrections({
  order,
  busy,
  onDone,
}: {
  order: Order;
  busy: boolean;
  onDone: (message: string | null, error: string | null) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [reason, setReason] = useState("");
  const [working, setWorking] = useState(false);
  const addr = order.shipping_address;
  const [name, setName] = useState(order.customer_name ?? "");
  const [phone, setPhone] = useState(order.customer_phone ?? "");
  const [line1, setLine1] = useState(addr?.line1 ?? "");
  const [line2, setLine2] = useState(addr?.line2 ?? "");
  const [city, setCity] = useState(addr?.city ?? "");
  const [pin, setPin] = useState(addr?.postal_code ?? "");

  const dispatched = Boolean(order.shipped_at) || order.status === "shipped" || order.status === "delivered";
  const canUndeliver = order.status === "delivered" && Boolean(order.shipped_at);
  const canContact = order.status !== "cancelled" && !dispatched && !order.delivered_at;
  const canShelf =
    order.status === "cancelled" && order.payment_provider === "offline" && !order.shipped_at && !order.delivered_at;

  if (!canUndeliver && !canContact && !canShelf) return null;

  const reasonOk = reason.trim().length >= MIN_REASON;

  function open(next: Mode) {
    setMode(mode === next ? null : next);
    setReason("");
  }

  async function submit() {
    if (!mode || !reasonOk) return;
    setWorking(true);
    const supabase = getBrowserSupabase();
    try {
      if (mode === "undeliver") {
        const { error } = await supabase.rpc("admin_correct_order_status", {
          p_order_id: order.id,
          p_reason: reason.trim(),
        });
        if (error) throw new Error(error.message);
        await onDone("Corrected: the order is back to shipped. The change and your reason are in its history.", null);
      } else if (mode === "contact") {
        const changed = <T,>(next: T, prev: T | null | undefined) => (next === (prev ?? "") ? null : next);
        const address: Record<string, string> = {};
        if (line1.trim() !== (addr?.line1 ?? "")) address.line1 = line1;
        if (line2.trim() !== (addr?.line2 ?? "")) address.line2 = line2;
        if (city.trim() !== (addr?.city ?? "")) address.city = city;
        if (pin.trim() !== (addr?.postal_code ?? "")) address.postal_code = pin;
        const { data, error } = await supabase.rpc("admin_correct_order_contact", {
          p_order_id: order.id,
          p_name: changed(name.trim(), order.customer_name),
          p_phone: changed(phone.trim(), order.customer_phone),
          p_address: Object.keys(address).length > 0 ? address : null,
          p_reason: reason.trim(),
        });
        if (error) throw new Error(error.message);
        const outcome = (data as { outcome?: string } | null)?.outcome;
        await onDone(
          outcome === "unchanged"
            ? "Nothing to correct: those are the details already on the order."
            : "Delivery details corrected. The previous values and your reason are kept in the correction log; the invoice keeps the details it was issued with. If the PIN changed, the order is now held for a delivery review.",
          null
        );
      } else {
        const { data, error } = await supabase.rpc("admin_return_in_person_stock", {
          p_order_id: order.id,
          p_reason: reason.trim(),
        });
        if (error) throw new Error(error.message);
        const result = data as { outcome?: string; stock_note?: string | null } | null;
        await onDone(
          result?.outcome === "returned"
            ? ["Stock returned to the shelf count, with your name and reason on it.", result.stock_note].filter(Boolean).join(" ")
            : result?.stock_note ?? "Nothing to return: this order's stock is already back, or it never took any.",
          null
        );
      }
      setMode(null);
      setReason("");
    } catch (e) {
      await onDone(null, e instanceof Error ? e.message : "That correction was refused.");
    } finally {
      setWorking(false);
    }
  }

  const disabled = busy || working;

  return (
    <div className="mt-4 border-t border-ink/10 pt-4" data-testid="order-corrections">
      <h4 className="text-xs uppercase tracking-wider text-ink/50">Corrections</h4>
      <div className="mt-2 flex flex-wrap gap-3">
        {canUndeliver && (
          <button type="button" onClick={() => open("undeliver")} disabled={disabled} aria-expanded={mode === "undeliver"}
            className="text-xs text-terracotta-dark hover:underline disabled:opacity-40">
            Not delivered after all
          </button>
        )}
        {canContact && (
          <button type="button" onClick={() => open("contact")} disabled={disabled} aria-expanded={mode === "contact"}
            className="text-xs text-terracotta-dark hover:underline disabled:opacity-40">
            Correct delivery details
          </button>
        )}
        {canShelf && (
          <button type="button" onClick={() => open("shelf")} disabled={disabled} aria-expanded={mode === "shelf"}
            className="text-xs text-terracotta-dark hover:underline disabled:opacity-40">
            Back on the shelf
          </button>
        )}
      </div>

      {mode && (
        <div className="mt-3 space-y-3 rounded-lg bg-linen/60 p-3 text-sm">
          {mode === "undeliver" && (
            <p className="text-xs text-ink/60">
              Moves this order back to <strong>shipped</strong> and clears its delivery time. Use it only
              when &ldquo;Mark delivered&rdquo; was pressed by mistake. Nothing else changes.
            </p>
          )}
          {mode === "shelf" && (
            <p className="text-xs text-ink/60">
              Only if the piece is <strong>physically back on the shelf</strong>. This order was taken in
              person, so the app cannot tell whether it was handed over; your statement and name are
              recorded on the stock movement. Stock comes back once.
            </p>
          )}
          {mode === "contact" && (
            <>
              <p className="text-xs text-ink/60">
                Before dispatch only. The email, state ({addr?.state || "none"}) and country
                ({addr?.country || "none"}) cannot be changed here. The delivery charge is not
                re-quoted. The previous values are kept in the correction log.
              </p>
              {/* OS-2b (0079): what the database will do with this correction. */}
              {pin.replace(/\D/g, "") !== (addr?.postal_code ?? "").replace(/\D/g, "") && (
                <p className="text-xs text-terracotta-dark" data-testid="pin-change-advisory">
                  Changing the PIN holds this order: it cannot be dispatched until a delivery review records that the
                  courier serves the new PIN, the State and city it belongs to, and the courier cost.
                </p>
              )}
              {order.invoice_number && (
                <p className="text-xs text-ink/60">
                  Invoice {order.invoice_number} keeps the details it was issued with; this changes only where the
                  parcel goes.
                </p>
              )}
              {order.invoice_snapshot?.source === "row_at_migration" && (
                <p className="text-xs text-ink/60">
                  This invoice predates issue records: its printed details are the order as found when issue records began, not
                  proven to be what was originally issued.
                </p>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <Input label="Name" value={name} onChange={setName} />
                <Input label="Phone" value={phone} onChange={setPhone} />
                <Input label="Address line 1" value={line1} onChange={setLine1} />
                <Input label="Address line 2" value={line2} onChange={setLine2} />
                <Input label="City" value={city} onChange={setCity} />
                <Input label="PIN code" value={pin} onChange={setPin} />
              </div>
            </>
          )}
          <Input
            label={`Reason (required, at least ${MIN_REASON} characters, kept with the change)`}
            value={reason}
            onChange={setReason}
          />
          <div className="flex gap-3">
            <button type="button" onClick={submit} disabled={disabled || !reasonOk}
              className="rounded-full bg-ink px-4 py-2 text-xs text-cream disabled:opacity-40">
              {mode === "undeliver" ? "Correct to shipped" : mode === "contact" ? "Save correction" : "Return the stock"}
            </button>
            <button type="button" onClick={() => setMode(null)} disabled={working}
              className="text-xs text-ink/60 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}
