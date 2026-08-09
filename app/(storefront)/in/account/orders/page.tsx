import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { createRSCClient } from "@/lib/supabaseRSC";
import { getMyOrders, orderRef, STATUS_LABEL, STATUS_BLURB } from "@/lib/orders";
import { formatINR } from "@/lib/utils";
import { buttonClassName } from "@/components/ui/Button";
import OrderStatusTrail from "@/components/account/OrderStatusTrail";
import InvoiceLink from "@/components/order/InvoiceLink";

export const metadata: Metadata = {
  title: "Your orders | THE WOVENNE",
  robots: { index: false, follow: false },
};

// Personal and changes as orders move — never cached.
export const dynamic = "force-dynamic";

/**
 * A customer's own order history.
 *
 * Everything shown is a fact we hold: what was bought, what was paid, where it
 * is going, and the courier reference once one exists. No courier movement, no
 * "out for delivery" — we know when a parcel was handed over, not where it is,
 * and inventing that is how a tracking page loses trust.
 */
export default async function OrdersPage() {
  const supabase = createRSCClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware turns guests away; this is the belt to its braces, because a
  // page listing someone's purchases should not rest on one check.
  if (!user) {
    return (
      <div className="container-wovenne section-padding text-center">
        <h1 className="font-heading text-display-sm text-ink">Your orders</h1>
        <p className="mx-auto mt-4 max-w-sm text-sm text-ink/60">
          Log in to see your order history.
        </p>
        <Link href="/in/login?from=/in/account/orders" className={buttonClassName("primary", "lg", "mt-8")}>
          Log in
        </Link>
      </div>
    );
  }

  // No email filter: the RLS policy from 0023 matches on auth.email() from the
  // JWT. Filtering here as well would imply the policy were optional.
  const orders = await getMyOrders(supabase);

  // Credit notes against those orders, so a cancellation is downloadable here
  // and not only in the email that announced it. Read with the customer's own
  // client — 0043 lets them see notes against their own orders and nobody
  // else's, so no id filtering is done here either.
  //
  // A failure is not fatal, exactly as the admin invoice list treats it: an
  // order history should not become a stack trace because a migration is
  // pending. The orders simply come back without a credit note link.
  const { data: creditRows } = await supabase
    .from("credit_notes")
    .select("id, credit_note_number, order_id, amount_inr")
    .order("issued_at", { ascending: false });

  const creditsByOrder = new Map<
    string,
    { id: string; credit_note_number: string; amount_inr: number }[]
  >();
  for (const row of (creditRows ?? []) as {
    id: string;
    credit_note_number: string;
    order_id: string | null;
    amount_inr: number | string;
  }[]) {
    if (!row.order_id) continue;
    const list = creditsByOrder.get(row.order_id) ?? [];
    list.push({
      id: row.id,
      credit_note_number: row.credit_note_number,
      amount_inr: Number(row.amount_inr ?? 0),
    });
    creditsByOrder.set(row.order_id, list);
  }

  // No sidebar, no page padding and no "Your account" eyebrow here: the account
  // layout supplies all three. This page predated that layout and still carried
  // its own, so selecting Orders rendered the whole menu a second time inside
  // the content area.
  return (
    <div>
      <h1 className="font-heading text-display-sm text-ink">Your orders</h1>

      <div className="mt-8">
        {orders.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-ink/60">
              No orders yet. Anything you buy will appear here, with its progress.
            </p>
            <Link
              href="/in/shop"
              className="mt-6 inline-block border-b border-terracotta pb-1 text-xs uppercase tracking-widest text-terracotta"
            >
              Browse the collection
            </Link>
          </div>
        ) : (
          <div className="space-y-6">
            {orders.map((order) => {
              const goods = order.total_inr - order.shipping_cost_inr;
              const credits = creditsByOrder.get(order.id) ?? [];
              return (
                <section
                  key={order.id}
                  className="rounded-2xl border border-ink/10 bg-cream p-6"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-wider text-ink/50">
                        {orderRef(order.id)} ·{" "}
                        {new Date(order.created_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })}
                      </p>
                      <p className="mt-1 font-heading text-xl text-ink">
                        {formatINR(order.total_inr)}
                      </p>
                    </div>
                    <span className="rounded-full bg-linen px-3 py-1 text-xs text-ink">
                      {STATUS_LABEL[order.status]}
                    </span>
                  </div>

                  <p className="mt-3 text-sm text-ink/70">
                    {STATUS_BLURB[order.status]}
                  </p>

                  {order.status !== "cancelled" && (
                    <OrderStatusTrail status={order.status} />
                  )}

                  {order.awb_number && (
                    <div className="mt-5 rounded-lg bg-linen/60 px-4 py-3 text-sm">
                      <p className="text-ink">
                        Tracking number{" "}
                        <strong className="font-medium">{order.awb_number}</strong>
                        {order.courier_name && (
                          <span className="text-ink/60"> · {order.courier_name}</span>
                        )}
                      </p>
                      {/* Deliberately not a link: we store the reference, not a
                          courier-specific tracking URL, and guessing one that
                          404s is worse than none. */}
                      <p className="mt-1 text-xs text-ink/50">
                        Track this with {order.courier_name || "the courier"} using
                        the number above.
                      </p>
                    </div>
                  )}

                  <div className="mt-6 grid gap-6 border-t border-ink/10 pt-5 sm:grid-cols-2">
                    <div>
                      <h2 className="text-xs uppercase tracking-wider text-ink/50">
                        Items
                      </h2>
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
                      <dl className="mt-3 space-y-1 border-t border-ink/10 pt-2 text-sm">
                        <div className="flex justify-between">
                          <dt className="text-ink/60">Items</dt>
                          <dd>{formatINR(goods)}</dd>
                        </div>
                        <div className="flex justify-between">
                          <dt className="text-ink/60">Delivery</dt>
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
                      <h2 className="text-xs uppercase tracking-wider text-ink/50">
                        Delivering to
                      </h2>
                      <address className="mt-2 text-sm not-italic leading-relaxed text-ink/80">
                        {[
                          order.customer_name,
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
                      <p className="mt-3 text-xs text-ink/50">
                        Payment {order.payment_status}
                      </p>
                      <InvoiceLink
                        orderId={order.id}
                        paid={order.payment_status === "paid"}
                        invoiceNumber={order.invoice_number}
                      />
                      {/* The invoice stays exactly as issued and the credit note
                          sits beside it, which is the pair a customer's records
                          need. Offered here as well as in the cancellation email,
                          because an email is easy to lose. */}
                      {credits.map((c) => (
                        <a
                          key={c.id}
                          href={`/api/credit-note/${c.id}`}
                          className="mt-2 flex items-center gap-1.5 text-xs uppercase tracking-wider text-ink/55 transition-colors hover:text-terracotta"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Credit note {c.credit_note_number} · −
                          {formatINR(c.amount_inr)}
                        </a>
                      ))}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

