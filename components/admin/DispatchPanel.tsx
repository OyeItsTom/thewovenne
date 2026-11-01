"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, PackageCheck } from "lucide-react";
import { orderRef, type Order } from "@/lib/orders";
import { checkConsignment, INDIA_POST_LABEL } from "@/lib/couriers/indiaPost";
import type { ShipmentEmailView } from "@/lib/shipmentEmailState";

/**
 * Dispatching to India Post Speed Post (WP-EMAIL-E3c).
 *
 * DISPATCH MEANS THE PARCEL HAS BEEN HANDED OVER, not that a number exists:
 * the customer is emailed "we've handed your order to India Post" the moment
 * this is confirmed, so the admin says so explicitly, every time.
 *
 * Nothing here is the authority. The number is checked as it is typed so the
 * admin sees a problem early; the route checks it again, and dispatch_order()
 * in the database decides paid, status, address and the one email. The only
 * thing this screen adds is the admin's confirmation of an unusual number —
 * sent as that exact number, so it cannot carry over to an edited one.
 */

export interface DispatchDone {
  outcome: "dispatched" | "already_dispatched";
  consignment: string;
  email: ShipmentEmailView;
}

const REFUSED: Record<string, string> = {
  empty: "Enter the consignment number from the India Post booking receipt.",
  too_long: "That is longer than any consignment number (30 characters at most).",
  invalid_characters: "Letters and digits only — spaces and hyphens are removed for you.",
};

export function hasCompleteAddress(order: Order): boolean {
  const a = order.shipping_address;
  return Boolean(a && a.line1?.trim() && a.city?.trim() && a.postal_code?.trim());
}

export default function DispatchPanel({
  order,
  disabled,
  onDone,
}: {
  order: Order;
  disabled: boolean;
  onDone: (result: DispatchDone) => void;
}) {
  const [raw, setRaw] = useState("");
  const [handedOver, setHandedOver] = useState(false);
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [step, setStep] = useState<"edit" | "review">("edit");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverNote, setServerNote] = useState<string | null>(null);

  const paid = order.payment_status === "paid";
  const addressOk = hasCompleteAddress(order);
  const inPerson = order.payment_provider !== "razorpay";
  const check = checkConsignment(raw);
  const touched = raw.trim().length > 0;
  const unusual = check.ok && check.needsConfirmation;
  const unusualConfirmed = unusual && confirmedFor === check.value;
  const ready = check.ok && handedOver && (!unusual || unusualConfirmed) && paid && addressOk;

  if (!paid) {
    return (
      <Shell>
        <p className="mt-2 text-sm text-ink/60">
          Dispatch opens once the order is paid. An unpaid order cannot be sent.
        </p>
      </Shell>
    );
  }
  if (!addressOk) {
    return (
      <Shell>
        <p className="mt-2 flex items-start gap-2 text-sm text-terracotta-dark">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          This order has no complete delivery address (street, city and PIN), so it
          cannot be dispatched.
        </p>
      </Shell>
    );
  }

  async function submit() {
    if (!check.ok) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/orders/dispatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderId: order.id,
          consignment: check.value,
          confirmUnusual: unusualConfirmed ? check.value : null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        onDone({ outcome: data.outcome, consignment: data.consignment, email: data.email });
        return;
      }
      if (res.status === 409 && data?.needsConfirmation) {
        // The server's check disagreed with this screen's: show its reason and
        // ask again rather than dispatching on a confirmation it did not get.
        setConfirmedFor(null);
        setServerNote(data.note ?? data.error ?? null);
        setStep("edit");
        return;
      }
      setError(data?.error ?? "The dispatch was not recorded. Refresh to see the order as it is.");
    } catch {
      setError("No answer from the server. Refresh before trying again — it may have gone through.");
    } finally {
      setSending(false);
    }
  }

  if (step === "review" && check.ok) {
    return (
      <Shell>
        <div
          role="group"
          aria-labelledby={`dispatch-summary-${order.id}`}
          className="mt-3 rounded-lg border border-ink/15 bg-white p-4"
        >
          <p id={`dispatch-summary-${order.id}`} className="text-xs uppercase tracking-wider text-ink/50">
            Confirm dispatch
          </p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink/60">Order</dt>
            <dd className="text-ink">{orderRef(order.id)}</dd>
            <dt className="text-ink/60">Deliver to</dt>
            <dd className="text-ink">
              {order.customer_name || "—"}, {order.shipping_address?.city} {order.shipping_address?.postal_code}
            </dd>
            <dt className="text-ink/60">Shipping partner</dt>
            <dd className="text-ink">{INDIA_POST_LABEL}</dd>
            <dt className="text-ink/60">Consignment</dt>
            <dd className="font-mono text-lg tracking-wider text-ink">{check.value}</dd>
          </dl>
          {unusual && (
            <p className="mt-3 text-xs text-terracotta-dark">
              You confirmed this number although it is not in the usual Speed Post format.
            </p>
          )}
          <p className="mt-3 text-sm text-ink/70">
            {inPerson
              ? "In-person order: no email will be sent."
              : order.customer_email
                ? `${order.customer_email} will be emailed once, with this number and a link to India Post's tracking page.`
                : "This order has no email address, so nobody will be told."}
          </p>
          <p className="mt-2 text-xs text-ink/50">
            This records that the parcel has been handed to India Post. The number cannot
            be edited afterwards.
          </p>
          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-terracotta/10 px-3 py-2 text-sm text-terracotta-dark">
              {error}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              onClick={submit}
              disabled={sending || disabled}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
            >
              {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PackageCheck className="h-3.5 w-3.5" />}
              Confirm dispatch
            </button>
            <button
              onClick={() => setStep("edit")}
              disabled={sending}
              className="rounded-full border border-ink/20 px-4 py-2 text-xs text-ink hover:border-ink disabled:opacity-40"
            >
              Back
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <p className="mt-1 text-xs text-ink/50">
        Do this when the parcel has been handed over at the post office — the customer
        is told it is on its way.
      </p>
      {order.needs_review && (
        <p className="mt-2 flex items-start gap-2 text-xs text-terracotta-dark">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This order is flagged for review. Resolve that before sending it.
        </p>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="text-sm">
          <span className="text-xs font-medium text-ink/60">Shipping partner</span>
          <p className="mt-1 rounded-lg border border-ink/10 bg-linen/60 px-3 py-2 text-sm text-ink">
            {INDIA_POST_LABEL}
          </p>
        </div>
        <label className="block text-sm">
          <span className="text-xs font-medium text-ink/60">Consignment number</span>
          <input
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setServerNote(null);
            }}
            placeholder="EE123456785IN"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={touched && !check.ok}
            aria-describedby={`consignment-help-${order.id}`}
            className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 font-mono text-sm uppercase tracking-wider text-ink focus:border-terracotta focus:outline-none"
          />
        </label>
      </div>

      <div id={`consignment-help-${order.id}`} aria-live="polite" className="mt-2 text-xs">
        {touched && !check.ok && <p className="text-terracotta-dark">{REFUSED[check.reason]}</p>}
        {check.ok && !unusual && (
          <p className="text-ink/60">
            <span className="font-mono">{check.value}</span> — a valid Speed Post number.
          </p>
        )}
        {unusual && (
          <div className="rounded-lg border border-terracotta/40 bg-terracotta/5 p-3 text-terracotta-dark">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-mono">{check.value}</span>: {check.note}
              </span>
            </p>
            <label className="mt-2 flex items-start gap-2 text-ink">
              <input
                type="checkbox"
                checked={unusualConfirmed}
                onChange={(e) => setConfirmedFor(e.target.checked ? check.value : null)}
                className="mt-0.5"
              />
              <span>I have checked this number against the India Post receipt and it is correct.</span>
            </label>
          </div>
        )}
        {serverNote && <p className="mt-2 text-terracotta-dark">The server asked for confirmation: {serverNote}</p>}
      </div>

      <label className="mt-3 flex items-start gap-2 text-sm text-ink">
        <input type="checkbox" checked={handedOver} onChange={(e) => setHandedOver(e.target.checked)} className="mt-1" />
        <span>The parcel has been handed to India Post.</span>
      </label>

      <button
        onClick={() => {
          setError(null);
          setStep("review");
        }}
        disabled={!ready || disabled}
        className="mt-3 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
      >
        <PackageCheck className="h-3.5 w-3.5" />
        Review dispatch
      </button>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wider text-ink/50">Dispatch</h4>
      {children}
    </div>
  );
}

/** A dispatched order: what was recorded, and what happened to the email. */
export function DispatchRecord({ order, email }: { order: Order; email: ShipmentEmailView | null }) {
  const tone =
    email?.state === "accepted"
      ? "text-ink"
      : email?.state === "needs_attention" || email?.state === "no_recipient"
        ? "text-terracotta-dark"
        : "text-ink/70";
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wider text-ink/50">Dispatch</h4>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink/60">Shipping partner</dt>
        <dd className="text-ink">{order.courier_name || "—"}</dd>
        <dt className="text-ink/60">Consignment</dt>
        <dd className="font-mono tracking-wider text-ink">{order.awb_number || "—"}</dd>
        <dt className="text-ink/60">Dispatched</dt>
        <dd className="text-ink">
          {order.shipped_at
            ? new Date(order.shipped_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
            : "—"}
        </dd>
      </dl>
      {email && (
        <p className={`mt-2 text-xs ${tone}`}>
          {email.label}
          {email.detail ? ` — ${email.detail}` : ""}
        </p>
      )}
      <p className="mt-2 text-xs text-ink/50">
        The courier and number are fixed once dispatched. Corrections are not available here yet.
      </p>
    </div>
  );
}
