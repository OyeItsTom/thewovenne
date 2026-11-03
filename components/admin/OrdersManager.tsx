"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import {
  getAllOrders,
  orderRef,
  STATUS_LABEL,
  type Order,
  type OrderStatus,
} from "@/lib/orders";
import InvoiceLink from "@/components/order/InvoiceLink";
import { paymentMethodLabel } from "@/lib/paymentMethods";
import DispatchPanel, { DispatchRecord, type DispatchDone } from "@/components/admin/DispatchPanel";
import { shipmentEmailView, type ShipmentEmailRow, type ShipmentEmailView } from "@/lib/shipmentEmailState";

/**
 * Every order, and the controls to move one along.
 *
 * Until now a paid order was invisible outside SQL — there was no way to see
 * that money had arrived, let alone mark it sent.
 *
 * Dispatch is India Post Speed Post only, through DispatchPanel and
 * /api/admin/orders/dispatch (WP-EMAIL-E3c): the database's dispatch_order()
 * is the only way an order becomes shipped, and it records one shipping email.
 * Courier and consignment are never edited from here (0075 refuses it).
 */
/**
 * Which orders are on screen.
 *
 * CANCELLED IS ITS OWN VIEW AND IS NOT IN ANY OTHER. It used to sit in one long
 * list among the live ones, struck through and easy to miss — and a cancelled
 * order looks exactly like work still to do until you read the pill. It is not
 * hidden: every view carries its count, so nothing appears to have vanished.
 */
type Filter = "open" | "delivered" | "cancelled" | "attention" | "all";

const FILTER_LABEL: Record<Filter, string> = {
  open: "To fulfil",
  delivered: "Delivered",
  cancelled: "Cancelled",
  attention: "Needs attention",
  all: "All",
};

const OPEN_STATUSES: OrderStatus[] = ["placed", "confirmed", "shipped"];

function matches(order: Order, filter: Filter): boolean {
  switch (filter) {
    case "open":
      return OPEN_STATUSES.includes(order.status);
    case "delivered":
      return order.status === "delivered";
    case "cancelled":
      return order.status === "cancelled";
    case "attention":
      return order.needs_review;
    case "all":
      return true;
  }
}

export default function OrdersManager() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("open");
  const [emails, setEmails] = useState<Record<string, ShipmentEmailRow>>({});

  const load = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const all = await getAllOrders(supabase);
    setOrders(all);
    // What happened to each shipping email (0075). Admin-only; if it cannot be
    // read the screen still works, it just says nothing about the email.
    const dispatched = all.filter((o) => o.status === "shipped" || o.status === "delivered").map((o) => o.id).slice(0, 500);
    if (dispatched.length === 0) {
      setEmails({});
      return;
    }
    const { data, error: statusError } = await supabase.rpc("shipment_email_status", { p_order_ids: dispatched });
    if (statusError || !Array.isArray(data)) return;
    setEmails(
      Object.fromEntries((data as (ShipmentEmailRow & { order_id: string })[]).map((r) => [r.order_id, r]))
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Cancel, which is never an edit of the invoice.
   *
   * THROUGH A ROUTE RATHER THAN THE RPC DIRECTLY, and the difference is the
   * customer. cancel_order() does everything the books need — credit note,
   * stock back, status, timestamp, all or none — and nothing the customer
   * needs; a browser cannot send email, so the call moved server-side and the
   * cancellation email goes out where the cancellation happens.
   */
  async function cancel(order: Order) {
    const reason = window.prompt(
      `Cancel order ${orderRef(order.id)}?\n\nThis issues a CREDIT NOTE against invoice ${order.invoice_number ?? "(none)"}, returns the stock, and emails the customer with the credit note attached. The invoice itself is never changed or deleted.\n\nReason (shown to the customer, optional):`
    );
    if (reason === null) return;

    setBusy(order.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/orders/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, reason: reason || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Could not cancel that order.");

      // Every part of the outcome is said out loud. Stock that could not be
      // returned, and a customer who was not told, are both things an admin
      // should be handed rather than left to notice.
      setNotice(
        [
          `${data.creditNoteNumber ?? "Credit note"} issued.`,
          data.stockNote ?? (data.stockReturned ? "Stock returned." : null),
          data.emailed
            ? "The customer has been emailed the credit note."
            : `The customer was NOT emailed — ${data.emailProblem ?? "no reason given"}`,
        ]
          .filter(Boolean)
          .join(" ")
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel that order.");
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function patch(order: Order, changes: Partial<Order>) {
    setBusy(order.id);
    setError(null);
    const { error: updateError } = await getBrowserSupabase()
      .from("orders")
      .update(changes)
      .eq("id", order.id);
    setBusy(null);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    await load();
  }

  /**
   * Stamps the matching timestamp. Never "shipped": that is dispatch_order(),
   * through DispatchPanel, and 0075 refuses it as a plain update.
   */
  function advanceTo(order: Order, status: Exclude<OrderStatus, "shipped">) {
    const changes: Partial<Order> = { status };
    if (status === "delivered" && !order.delivered_at)
      changes.delivered_at = new Date().toISOString();
    // Only ever an unpaid order by the time this runs — a paid one goes through
    // cancel() and its credit note. Stamped here as well as by 0049's trigger so
    // the column is right whether or not that migration has been applied yet.
    if (status === "cancelled" && !order.cancelled_at)
      changes.cancelled_at = new Date().toISOString();
    return patch(order, changes);
  }

  if (orders === null) return <p className="text-ink/60">Loading orders…</p>;

  if (orders.length === 0) {
    return (
      <div className="rounded-2xl border border-ink/10 bg-linen/40 p-10 text-center">
        <p className="font-heading text-2xl text-ink">No orders yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink/60">
          Paid orders appear here the moment they complete, with the customer&apos;s
          address and what they bought.
        </p>
      </div>
    );
  }

  const flagged = orders.filter((o) => o.needs_review).length;
  const counts = Object.fromEntries(
    (Object.keys(FILTER_LABEL) as Filter[]).map((f) => [
      f,
      orders.filter((o) => matches(o, f)).length,
    ])
  ) as Record<Filter, number>;
  const shown = orders.filter((o) => matches(o, filter));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">
          {/* Says which view is on screen, rather than a count that would look
              like the whole shop's order book. */}
          {shown.length} {FILTER_LABEL[filter].toLowerCase()}
          {filter === "all" ? "" : ` · ${orders.length} in total`}
        </h2>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/50 hover:text-terracotta"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {(Object.keys(FILTER_LABEL) as Filter[]).map((f) => {
          const active = f === filter;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={active}
              className={
                active
                  ? "rounded-full bg-ink px-4 py-1.5 text-xs text-cream"
                  : "rounded-full border border-ink/15 px-4 py-1.5 text-xs text-ink/70 transition-colors hover:border-ink/40"
              }
            >
              {FILTER_LABEL[f]} ({counts[f]})
            </button>
          );
        })}
      </div>

      {flagged > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {flagged} order{flagged === 1 ? "" : "s"} need attention — payment
          succeeded but stock couldn&apos;t be reserved. Refund or restock before
          shipping.
        </p>
      )}

      {error && (
        <p className="rounded-lg bg-terracotta/10 px-4 py-3 text-sm text-terracotta-dark">
          {error}
        </p>
      )}

      {notice && (
        <p className="rounded-lg bg-linen px-4 py-3 text-sm text-ink">{notice}</p>
      )}

      {shown.length === 0 && (
        <p className="rounded-2xl border border-ink/10 bg-linen/40 p-8 text-center text-sm text-ink/60">
          Nothing under {FILTER_LABEL[filter].toLowerCase()}.
        </p>
      )}

      {shown.map((order) => {
        const open = openId === order.id;
        const working = busy === order.id;
        const goods = order.total_inr - order.shipping_cost_inr;

        return (
          <section
            key={order.id}
            className={
              order.needs_review
                ? "rounded-2xl border border-terracotta/40 bg-cream p-5"
                : "rounded-2xl border border-ink/10 bg-cream p-5"
            }
          >
            <button
              onClick={() => setOpenId(open ? null : order.id)}
              className="flex w-full flex-wrap items-start justify-between gap-3 text-left"
            >
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-wider text-ink/50">
                  {orderRef(order.id)} ·{" "}
                  {new Date(order.created_at).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </p>
                <h3 className="font-heading text-xl text-ink">
                  {order.customer_name || order.customer_email || "Unknown customer"}
                </h3>
                <p className="mt-1 text-sm text-ink/60">
                  {order.items.length} item{order.items.length === 1 ? "" : "s"} ·{" "}
                  {formatINR(order.total_inr)}
                  {order.needs_review && (
                    <span className="ml-2 text-terracotta-dark">· needs review</span>
                  )}
                </p>
              </div>
              <StatusPill status={order.status} paid={order.payment_status === "paid"} />
            </button>

            {open && (
              <div className="mt-5 space-y-6 border-t border-ink/10 pt-5">
                <div className="grid gap-6 sm:grid-cols-2">
                  <div>
                    <h4 className="text-xs uppercase tracking-wider text-ink/50">
                      What they bought
                    </h4>
                    <ul className="mt-2 space-y-1 text-sm text-ink">
                      {order.items.map((item, i) => (
                        <li key={i} className="flex justify-between gap-3">
                          <span>
                            {item.name}
                            {item.size && item.size !== "One Size" && (
                              <span className="text-ink/50"> · {item.size}</span>
                            )}
                            <span className="text-ink/50"> × {item.quantity}</span>
                          </span>
                          <span className="whitespace-nowrap">
                            {formatINR(item.price_inr * item.quantity)}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <dl className="mt-3 space-y-1 border-t border-ink/10 pt-3 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-ink/60">Goods</dt>
                        <dd>{formatINR(goods)}</dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-ink/60">Shipping</dt>
                        <dd>
                          {order.shipping_cost_inr > 0
                            ? formatINR(order.shipping_cost_inr)
                            : "Free"}
                        </dd>
                      </div>
                      <div className="flex justify-between font-medium">
                        <dt>Paid</dt>
                        <dd>{formatINR(order.total_inr)}</dd>
                      </div>
                    </dl>
                  </div>

                  <div>
                    <h4 className="text-xs uppercase tracking-wider text-ink/50">
                      Deliver to
                    </h4>
                    <address className="mt-2 text-sm not-italic leading-relaxed text-ink">
                      {order.customer_name}
                      <br />
                      {[
                        order.shipping_address?.line1,
                        order.shipping_address?.line2,
                        order.shipping_address?.city,
                        order.shipping_address?.state,
                        order.shipping_address?.postal_code,
                        order.shipping_address?.country,
                      ]
                        .filter(Boolean)
                        .map((line, i) => (
                          <span key={i}>
                            {line}
                            <br />
                          </span>
                        ))}
                    </address>
                    <p className="mt-2 text-sm text-ink/60">
                      {order.customer_phone}
                      <br />
                      {order.customer_email}
                    </p>
                    <p className="mt-3 text-xs text-ink/50">
                      Payment: {order.payment_status}
                      {order.payment_provider ? ` · ${order.payment_provider}` : ""}
                    </p>
                    <InvoiceLink
                      orderId={order.id}
                      paid={order.payment_status === "paid"}
                      invoiceNumber={order.invoice_number}
                    />
                  </div>
                </div>

                <StatusControls
                  order={order}
                  busy={working}
                  email={
                    order.status === "shipped" || order.status === "delivered"
                      ? shipmentEmailView(emails[order.id] ?? null, { inPerson: order.payment_provider !== "razorpay" })
                      : null
                  }
                  onAdvance={(s) => advanceTo(order, s)}
                  onPatch={(c) => patch(order, c)}
                  onDispatched={async (r) => {
                    setError(null);
                    setNotice(dispatchNotice(order, r));
                    await load();
                  }}
                />

                {/* Paid and not already cancelled. An unpaid order has nothing
                    to credit — it is cancelled outright in the controls above —
                    and a cancelled one is already done. */}
                {order.payment_status === "paid" && order.status !== "cancelled" && (
                  <div className="mt-4 border-t border-ink/10 pt-4">
                    <button
                      onClick={() => cancel(order)}
                      disabled={working}
                      className="text-xs uppercase tracking-wider text-terracotta-dark transition-colors hover:underline disabled:opacity-40"
                    >
                      Cancel &amp; issue credit note
                    </button>
                    <p className="mt-1.5 text-xs text-ink/50">
                      Issues a credit note against{" "}
                      {order.invoice_number ?? "this order"}, returns the stock,
                      and emails the customer with the credit note attached. The
                      invoice itself is never changed or deleted.
                      {" "}Paid by {paymentMethodLabel(order.payment_method)}.
                    </p>
                  </div>
                )}

                {order.status === "cancelled" && (
                  <p className="mt-4 border-t border-ink/10 pt-4 text-xs text-ink/50">
                    Cancelled
                    {order.cancelled_at
                      ? ` on ${new Date(order.cancelled_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}`
                      : ""}
                    . The credit note is listed against this order under
                    Invoices, and the original invoice still stands as issued.
                  </p>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function StatusPill({ status, paid }: { status: OrderStatus; paid: boolean }) {
  const tone =
    status === "delivered"
      ? "bg-ink text-cream"
      : status === "shipped"
        ? "bg-terracotta text-cream"
        : status === "cancelled"
          ? "bg-ink/10 text-ink/50 line-through"
          : "bg-linen text-ink";
  return (
    <span className="flex shrink-0 items-center gap-2">
      {!paid && (
        <span className="rounded-full bg-ink/5 px-2 py-1 text-[10px] uppercase tracking-wider text-ink/50">
          unpaid
        </span>
      )}
      <span className={`rounded-full px-3 py-1 text-xs ${tone}`}>
        {STATUS_LABEL[status]}
      </span>
    </span>
  );
}

/** What the admin is told after a dispatch: the facts, then the email outcome. */
function dispatchNotice(order: Order, r: DispatchDone): string {
  const head =
    r.outcome === "already_dispatched"
      ? `${orderRef(order.id)} was already dispatched with ${r.consignment}; nothing was changed.`
      : `${orderRef(order.id)} dispatched with India Post — Speed Post, ${r.consignment}.`;
  return `${head} ${r.email.label}${r.email.detail ? ` — ${r.email.detail}` : "."}`;
}

/**
 * Moving an order along.
 *
 * Status only moves forward, one step at a time, with cancel always available.
 * A free choice of any status invites mis-clicks that are hard to notice — an
 * order silently back at "placed" after dispatch is worse than one that needs
 * two clicks.
 *
 * "SHIPPED" IS NOT A BUTTON. A paid order is dispatched through DispatchPanel,
 * which says the parcel has been handed to India Post and emails the customer
 * once; the database refuses every other way into shipped (0075), and refuses
 * "delivered" for an online order that was never dispatched. An in-person
 * order can be marked delivered directly — it was handed over at the stall.
 */
function StatusControls({
  order,
  busy,
  email,
  onAdvance,
  onPatch,
  onDispatched,
}: {
  order: Order;
  busy: boolean;
  email: ShipmentEmailView | null;
  onAdvance: (s: Exclude<OrderStatus, "shipped">) => void;
  onPatch: (changes: Partial<Order>) => void;
  onDispatched: (r: DispatchDone) => void;
}) {
  const [cost, setCost] = useState(String(order.shipping_cost_inr ?? 0));
  const [note, setNote] = useState(order.admin_note ?? "");

  const cancelled = order.status === "cancelled";
  const inPerson = order.payment_provider !== "razorpay";
  const dispatchable = !cancelled && (order.status === "placed" || order.status === "confirmed");
  const dispatched = order.status === "shipped" || order.status === "delivered";

  // The one plain status step available from here, if any.
  const next: Exclude<OrderStatus, "shipped"> | null =
    cancelled
      ? null
      : order.status === "placed"
        ? "confirmed"
        : order.status === "shipped"
          ? "delivered"
          : order.status === "confirmed" && inPerson && order.payment_status === "paid"
            ? "delivered"
            : null;

  return (
    <div className="space-y-5 rounded-xl bg-linen/40 p-4">
      {dispatchable && (
        <DispatchPanel order={order} disabled={busy} onDone={onDispatched} />
      )}
      {dispatched && <DispatchRecord order={order} email={email} />}

      <div className={dispatchable || dispatched ? "border-t border-ink/10 pt-4" : undefined}>
        <h4 className="text-xs uppercase tracking-wider text-ink/50">Shipping cost and note</h4>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Shipping cost (₹)" value={cost} onChange={setCost} type="number" />
          <Field
            label="Internal note (never shown to the customer)"
            value={note}
            onChange={setNote}
            className="sm:col-span-2"
          />
        </div>
        <button
          onClick={() =>
            onPatch({
              shipping_cost_inr: Number(cost) || 0,
              admin_note: note.trim() || null,
            })
          }
          disabled={busy}
          className="mt-3 rounded-full border border-ink/20 px-4 py-2 text-xs text-ink transition-colors hover:border-ink disabled:opacity-40"
        >
          Save cost and note
        </button>
      </div>

      <div className="border-t border-ink/10 pt-4">
        <h4 className="text-xs uppercase tracking-wider text-ink/50">Status</h4>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {next && (
            <button
              onClick={() => onAdvance(next)}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" />
              )}
              {next === "delivered" && order.status === "confirmed"
                ? "Mark delivered (handed over in person)"
                : `Mark ${STATUS_LABEL[next].toLowerCase()}`}
            </button>
          )}

          {order.needs_review && (
            <button
              onClick={() => onPatch({ needs_review: false })}
              disabled={busy}
              className="rounded-full border border-ink/20 px-4 py-2 text-xs text-ink hover:border-ink disabled:opacity-40"
            >
              Clear the review flag
            </button>
          )}

          {/* UNPAID ONLY, and this is the fix for a real hole rather than a
              tidy-up. This button set status = 'cancelled' with a plain UPDATE.
              On a paid order that produced the exact state credit notes exist to
              prevent: no credit note, so the P&L still counted the revenue; no
              stock returned; no cancelled_at; and an invoice left standing for
              money being given back. It sat directly above the correct control,
              looked like the obvious one, and was one click.

              A paid order now goes through "Cancel & issue credit note" below,
              and 0049 refuses the plain UPDATE in the database so removing the
              button is not the only thing standing between the two. */}
          {!cancelled && order.payment_status !== "paid" && (
            <button
              onClick={() => onAdvance("cancelled")}
              disabled={busy}
              className="text-xs text-terracotta-dark hover:underline disabled:opacity-40"
            >
              Cancel this unpaid order
            </button>
          )}
        </div>

        {!cancelled && order.payment_status === "paid" && (
          <p className="mt-2 text-xs text-ink/50">
            To cancel this order, use &ldquo;Cancel &amp; issue credit note&rdquo;
            below. It is paid, so undoing it means issuing a credit note — the
            invoice cannot be edited away.
          </p>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  className,
  ...props
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  className?: string;
  // value/onChange are ours; without omitting them the spread's native
  // signatures collide with the string-based ones above.
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  return (
    <label className={`block text-sm ${className ?? ""}`}>
      <span className="text-xs font-medium text-ink/60">{label}</span>
      <input
        {...props}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink focus:border-terracotta focus:outline-none"
      />
    </label>
  );
}
