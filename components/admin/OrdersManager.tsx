"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, PackageCheck, RefreshCw } from "lucide-react";
import { getBrowserSupabase } from "@/lib/supabase";
import { formatINR } from "@/lib/utils";
import {
  getAllOrders,
  orderRef,
  STATUS_FLOW,
  STATUS_LABEL,
  type Order,
  type OrderStatus,
} from "@/lib/orders";
import InvoiceLink from "@/components/order/InvoiceLink";

/**
 * Every order, and the controls to move one along.
 *
 * Until now a paid order was invisible outside SQL — there was no way to see
 * that money had arrived, let alone mark it sent.
 *
 * Dispatch details are typed in rather than pulled from Shiprocket. Booking
 * happens on Shiprocket's own dashboard, where the courier options and rates
 * already are; this records the outcome. The API integration can replace the
 * typing later without changing what is stored.
 */
export default function OrdersManager() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setOrders(await getAllOrders(getBrowserSupabase()));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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

  /** Stamps the matching timestamp, so "when did it ship?" is answerable. */
  function advanceTo(order: Order, status: OrderStatus) {
    const changes: Partial<Order> = { status };
    if (status === "shipped" && !order.shipped_at)
      changes.shipped_at = new Date().toISOString();
    if (status === "delivered" && !order.delivered_at)
      changes.delivered_at = new Date().toISOString();
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-heading text-2xl text-ink">
          {orders.length} order{orders.length === 1 ? "" : "s"}
        </h2>
        <button
          onClick={load}
          className="inline-flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/50 hover:text-terracotta"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
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

      {orders.map((order) => {
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
                  onAdvance={(s) => advanceTo(order, s)}
                  onPatch={(c) => patch(order, c)}
                />
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

/**
 * Moving an order along, and recording how it was sent.
 *
 * Status only moves forward through the flow, one step at a time, with cancel
 * always available. A free choice of any status invites mis-clicks that are
 * hard to notice — an order silently back at "placed" after dispatch is worse
 * than one that needs two clicks.
 */
function StatusControls({
  order,
  busy,
  onAdvance,
  onPatch,
}: {
  order: Order;
  busy: boolean;
  onAdvance: (s: OrderStatus) => void;
  onPatch: (changes: Partial<Order>) => void;
}) {
  const [courier, setCourier] = useState(order.courier_name ?? "");
  const [awb, setAwb] = useState(order.awb_number ?? "");
  const [cost, setCost] = useState(String(order.shipping_cost_inr ?? 0));
  const [note, setNote] = useState(order.admin_note ?? "");

  const index = STATUS_FLOW.indexOf(order.status);
  const next = index >= 0 && index < STATUS_FLOW.length - 1 ? STATUS_FLOW[index + 1] : null;
  const cancelled = order.status === "cancelled";

  return (
    <div className="space-y-5 rounded-xl bg-linen/40 p-4">
      <div>
        <h4 className="text-xs uppercase tracking-wider text-ink/50">Dispatch</h4>
        <p className="mt-1 text-xs text-ink/50">
          Book on Shiprocket, then record what you chose here. Nothing is booked
          automatically.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label="Courier" value={courier} onChange={setCourier} placeholder="Delhivery" />
          <Field label="AWB / tracking no." value={awb} onChange={setAwb} placeholder="1234567890" />
          <Field label="Shipping cost (₹)" value={cost} onChange={setCost} type="number" />
        </div>
        <Field
          label="Internal note (never shown to the customer)"
          value={note}
          onChange={setNote}
          className="mt-3"
        />
        <button
          onClick={() =>
            onPatch({
              courier_name: courier.trim() || null,
              awb_number: awb.trim() || null,
              shipping_cost_inr: Number(cost) || 0,
              admin_note: note.trim() || null,
            })
          }
          disabled={busy}
          className="mt-3 rounded-full border border-ink/20 px-4 py-2 text-xs text-ink transition-colors hover:border-ink disabled:opacity-40"
        >
          Save dispatch details
        </button>
      </div>

      <div className="border-t border-ink/10 pt-4">
        <h4 className="text-xs uppercase tracking-wider text-ink/50">Status</h4>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {next && !cancelled && (
            <button
              onClick={() => onAdvance(next)}
              disabled={busy || (next === "shipped" && !awb.trim())}
              title={
                next === "shipped" && !awb.trim()
                  ? "Add a tracking number first — the customer sees it on their order."
                  : undefined
              }
              className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-xs font-medium text-cream transition-colors hover:bg-ink-light disabled:opacity-40"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <PackageCheck className="h-3.5 w-3.5" />
              )}
              Mark {STATUS_LABEL[next].toLowerCase()}
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

          {!cancelled && (
            <button
              onClick={() => onAdvance("cancelled")}
              disabled={busy}
              className="text-xs text-terracotta-dark hover:underline disabled:opacity-40"
            >
              Cancel this order
            </button>
          )}
        </div>

        {next === "shipped" && !awb.trim() && (
          <p className="mt-2 text-xs text-ink/50">
            Add a tracking number above before marking it shipped — it&apos;s what
            the customer sees on their order.
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
