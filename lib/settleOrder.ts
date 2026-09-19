import { razorpay } from "./razorpay";
import { createServiceClient } from "./supabase";
import { settleLoyalty } from "./settleLoyalty";
import { sendOrderConfirmation } from "./sendOrderConfirmation";

/**
 * Everything that happens once a Razorpay payment is known to be real.
 *
 * ONE FUNCTION, HOWEVER THE NEWS ARRIVES. Today the customer's browser calls
 * back after the payment modal closes; Razorpay's webhook is the next path,
 * and it will call this with the same two identifiers. Two copies of this
 * logic would drift, and the drift would show up on the rarer path — the one
 * nobody watches.
 *
 * SAFE TO RUN MORE THAN ONCE, and it will be: a replayed browser callback, a
 * webhook arriving after the browser already settled, a webhook retried for
 * 24 hours. Every effect below is idempotent, and every one of those
 * guarantees lives in the database (migration 0058) rather than here:
 *
 *   stock       stock_movements_one_sale_per_line — reserve_stock claims a
 *               movement per line and reports a repeat as already_reserved
 *   redemption  loyalty_ledger_one_redemption_per_order
 *   award       loyalty_ledger_one_award_per_order (0029)
 *   coupon      redeem_coupon() is idempotent per order (0037)
 *   invoice     assign_invoice_number() returns the existing number (0037)
 *   email       orders.confirmation_sent_at, claimed by a conditional UPDATE
 *               (prevents a duplicate send; does not guarantee delivery)
 *   order row   an UPDATE to fixed values — writing it twice is writing it once
 *
 * There is deliberately no `if (already paid) return` at the top. That is a
 * check-then-act, and the case this exists to survive is two settlements
 * arriving together, where both would pass the check. The guarantees are
 * where the concurrency is.
 *
 * THE BASKET IS THE STORED ONE. handleCreate priced the lines from the
 * database and wrote them to the pending row before the modal opened. This
 * function takes no items and reads none from anywhere but that row; the
 * payment-response signature binds Razorpay's ids, not cart contents, and a
 * webhook has no browser to ask anyway.
 *
 * NEVER THROWS FOR A RECORDING PROBLEM. The customer has paid. Anything that
 * fails after that point is logged and flagged for a human; none of it is a
 * reason to tell somebody their successful payment failed.
 *
 * WHAT THIS DOES NOT PROVE: that the payment was CAPTURED. The signature (or,
 * later, the webhook event) says Razorpay issued this payment against this
 * order; whether it is captured or merely authorised is a separate question
 * this function does not yet ask. payment_status is written exactly as the
 * verified flow always wrote it.
 */

export interface SettlementInput {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}

/** A line as handleCreate stored it. Only the fields settlement needs. */
export interface StoredLine {
  id: string;
  size: string;
  quantity: number;
  price_inr: number;
}

interface PendingRow {
  id: string;
  items: StoredLine[] | null;
}

export type StockOutcome =
  /** Stock came out on this call. */
  | "reserved"
  /** A repeat: every line was already claimed for this order. Nothing moved. */
  | "already_reserved"
  /** reserve_stock refused (short, unknown size, …). Flagged for review. */
  | "failed"
  /** No stored lines to reserve from. Flagged for review. */
  | "none";

export interface SettlementResult {
  /** An order row was found or recorded and marked paid. */
  ok: boolean;
  /** The internal order row settled against, or the thin row inserted. */
  orderId: string | null;
  /** No pending row existed; a thin, flagged row was recorded instead. */
  orphan: boolean;
  stock: StockOutcome;
  /** True when THIS call won the confirmation claim and attempted the send. */
  emailClaimed: boolean;
  /** True when this call set needs_review (it never clears it). */
  flaggedForReview: boolean;
}

/**
 * Injected only by tests. Production always takes the defaults — no code path
 * passes these, so nothing about the live behaviour depends on them.
 */
export interface SettlementDeps {
  supabase: ReturnType<typeof createServiceClient>;
  gateway: Pick<typeof razorpay, "orders" | "payments">;
  settlePoints: typeof settleLoyalty;
  sendConfirmation: typeof sendOrderConfirmation;
}

export async function settleOrder(
  { razorpayOrderId, razorpayPaymentId }: SettlementInput,
  deps?: Partial<SettlementDeps>
): Promise<SettlementResult> {
  const supabase = deps?.supabase ?? createServiceClient();
  const gateway = deps?.gateway ?? razorpay;
  const settlePoints = deps?.settlePoints ?? settleLoyalty;
  const sendConfirmation = deps?.sendConfirmation ?? sendOrderConfirmation;

  // The order as the SERVER priced it. Read first, because everything below
  // is about this row: the stock that comes out, the id the movements are
  // attached to, the total to fall back to if the gateway cannot be reached.
  const { data: pendingRow } = await supabase
    .from("orders")
    .select("id, items")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();
  const pending = (pendingRow as PendingRow | null) ?? null;

  // What Razorpay actually took, and what it cost us to take it. Read from
  // the gateway rather than recomputed: a discount window that closed between
  // creation and payment would make a recomputation disagree with the money,
  // and the money is the fact of record.
  //
  // NEVER FATAL. If the order cannot be fetched, total_inr falls back to the
  // stored lines (what the server priced at creation — the same figure it
  // sent to Razorpay). If the payment cannot be fetched, the fee and tax are
  // recorded as unknown (null): a reporting gap in the P&L, not a reason to
  // fail a confirmation somebody has paid for. Neither read is a capture
  // check; see the header.
  let capturedInr: number | null = null;
  let gatewayFeeInr: number | null = null;
  let gatewayTaxInr: number | null = null;
  try {
    const order = await gateway.orders.fetch(razorpayOrderId);
    capturedInr = Number(order.amount) / 100;
  } catch (e) {
    console.error(`Could not fetch Razorpay order ${razorpayOrderId} for amount:`, e);
  }
  try {
    const payment = await gateway.payments.fetch(razorpayPaymentId);
    if (payment?.fee !== undefined && payment.fee !== null) {
      gatewayFeeInr = Number(payment.fee) / 100;
    }
    if (payment?.tax !== undefined && payment.tax !== null) {
      gatewayTaxInr = Number(payment.tax) / 100;
    }
  } catch (e) {
    console.error(
      `Could not read Razorpay fees for payment ${razorpayPaymentId} — this order will show no gateway cost:`,
      e
    );
  }

  // ── No pending row ──
  // Should not happen — handleCreate writes one before the modal opens — and
  // losing a paid order silently would be far worse than a thin one, so
  // record what we have and shout about it.
  //
  // WHAT WE HAVE IS THE MONEY, NOT THE BASKET. Nothing trustworthy describes
  // the goods, so: no items, no stock movement, no invoice, no email (there
  // is no address to send one to), and the row is flagged for a human to
  // reconcile against Razorpay's record. A concurrent settlement may have
  // inserted the row a moment ago — the unique index on razorpay_order_id
  // (0020) makes that a conflict, and the re-read below picks it up.
  if (!pending) {
    console.error(
      `Paid order ${razorpayOrderId} had no pending row — recording without contact details or items.`
    );
    const { data: inserted, error: insertError } = await supabase
      .from("orders")
      .insert({
        razorpay_order_id: razorpayOrderId,
        payment_provider: "razorpay",
        payment_status: "paid",
        total_inr: capturedInr,
        gateway_fee_inr: gatewayFeeInr,
        gateway_tax_inr: gatewayTaxInr,
        needs_review: true,
      })
      .select("id")
      .maybeSingle();

    let orderId = (inserted as { id?: string } | null)?.id ?? null;
    if (insertError || !orderId) {
      const { data: reread } = await supabase
        .from("orders")
        .select("id")
        .eq("razorpay_order_id", razorpayOrderId)
        .maybeSingle();
      orderId = (reread as { id?: string } | null)?.id ?? null;
      if (!orderId) {
        console.error(
          `Could not record paid order ${razorpayOrderId}: ${insertError?.message ?? "no row returned"}`
        );
      }
    }

    return {
      ok: orderId !== null,
      orderId,
      orphan: true,
      stock: "none",
      emailClaimed: false,
      flaggedForReview: orderId !== null,
    };
  }

  const orderId = pending.id;
  const lines = Array.isArray(pending.items) ? pending.items : [];

  // ── Stock ──
  // After payment, never before: decrementing at checkout-start would let an
  // abandoned modal hold stock nobody bought.
  //
  // reserve_stock (0058) merges the lines, claims one movement per line and
  // decrements — or, on a repeat, finds the claims taken and moves nothing,
  // reporting already_reserved. Only an ERROR means stock could not be taken
  // for a first settlement: the customer has paid, so the order is flagged
  // rather than refused. A pending row with no lines is flagged the same way;
  // it cannot be fulfilled from.
  let stock: StockOutcome = "none";
  if (lines.length === 0) {
    console.error(`Paid order ${razorpayOrderId} has no stored lines — flagging for review.`);
  } else {
    try {
      const { data, error: stockError } = await supabase.rpc("reserve_stock", {
        p_items: lines.map((i) => ({ id: i.id, size: i.size, quantity: i.quantity })),
        p_order_id: orderId,
      });
      if (stockError) {
        stock = "failed";
        console.error(
          `Stock could not be reserved for paid order ${razorpayOrderId}: ${stockError.message}`
        );
      } else {
        const r = (data ?? {}) as { reserved?: number; already_reserved?: number };
        stock = Number(r.reserved ?? 0) > 0 ? "reserved" : "already_reserved";
      }
    } catch (e) {
      stock = "failed";
      console.error("reserve_stock threw:", e);
    }
  }
  const stockShort = stock === "failed" || stock === "none";
  // A row with no lines — a thin orphan row being replayed, or a pending row
  // that somehow lost its items — gets marked paid and flagged, and nothing
  // else: no invoice number, no coupon use and no confirmation for an order
  // that cannot say what it contains. Those follow once a human has repaired
  // the row.
  const hasLines = lines.length > 0;

  // ── The order row ──
  // UPDATE, not insert: handleCreate wrote the customer's contact, address
  // and lines. `items` is not rewritten — nothing since creation has better
  // information about what was sold.
  //
  // needs_review is only ever SET here, never cleared. A flag a human has not
  // looked at yet must survive a later settlement that happened to go
  // smoothly — a replay that reserves nothing is exactly such a settlement.
  const paidPatch: Record<string, unknown> = {
    payment_status: "paid",
    total_inr:
      capturedInr ??
      lines.reduce((sum, item) => sum + Number(item.price_inr) * item.quantity, 0),
    gateway_fee_inr: gatewayFeeInr,
    gateway_tax_inr: gatewayTaxInr,
  };
  if (stockShort) paidPatch.needs_review = true;

  const { data: updated, error: updateError } = await supabase
    .from("orders")
    .update(paidPatch)
    .eq("id", orderId)
    .select("id");

  const markedPaid = !updateError && Boolean(updated?.length);
  if (updateError) {
    // The customer has paid — never fail their confirmation over a recording
    // problem. Sentry picks this up from the console error.
    console.error(`Failed to mark order ${razorpayOrderId} paid:`, updateError.message);
  } else if (!markedPaid) {
    console.error(`Paid order ${razorpayOrderId}: the pending row vanished before it could be marked paid.`);
  }

  // ── Points ──
  // Guarded per order in the database on both sides — the award since 0029,
  // the redemption since 0058 — so a repeat neither pays out twice nor spends
  // a balance twice. settleLoyalty reads that guard as "already done".
  await settlePoints(razorpayOrderId, { supabase });

  // ── Coupon and invoice ──
  // Both are claimed HERE, not at checkout-start, so abandoned modals burn
  // neither a launch code's allowance nor an invoice number. redeem_coupon()
  // counts once per order; assign_invoice_number() returns the number it
  // already issued. Neither fails the confirmation: the money has moved at
  // the discounted price, and a number that could not be issued is a note
  // for whoever reconciles, not a problem to push back at the customer.
  if (markedPaid && hasLines) {
    const { data: order } = await supabase
      .from("orders")
      .select("coupon_code, coupon_discount_inr, customer_email")
      .eq("id", orderId)
      .maybeSingle();

    const used = order as {
      coupon_code?: string | null;
      coupon_discount_inr?: number | null;
      customer_email?: string | null;
    } | null;

    if (used?.coupon_code) {
      const { data: claimed, error: redeemError } = await supabase.rpc("redeem_coupon", {
        p_code: used.coupon_code,
        p_order_id: orderId,
        p_email: used.customer_email ?? "",
        p_discount: used.coupon_discount_inr ?? 0,
      });
      if (redeemError) {
        console.error(
          `Could not record coupon ${used.coupon_code} for paid order ${razorpayOrderId}: ${redeemError.message}`
        );
      } else if (claimed === false) {
        // Exhausted or withdrawn between checkout and payment. The customer
        // keeps their discount — they were charged it — and this is a note for
        // whoever reconciles the promotion, not a problem to push back at them.
        console.error(
          `Coupon ${used.coupon_code} could not be claimed for paid order ${razorpayOrderId} ` +
            `(exhausted or withdrawn mid-payment). Discount was honoured.`
        );
      }
    }

    const { error: invoiceError } = await supabase.rpc("assign_invoice_number", {
      p_order_id: orderId,
    });
    if (invoiceError) {
      console.error(
        `Could not assign an invoice number to paid order ${razorpayOrderId}: ${invoiceError.message}`
      );
    }
  }

  // ── Confirmation email: at most one send attempt ──
  // CLAIMED, NOT CHECKED. This UPDATE matches only while the column is still
  // null, so of two settlements arriving together — a browser callback and a
  // webhook, or the same callback replayed — exactly one gets a row back and
  // only that one attempts the send. The other sees nothing and stays quiet.
  // A check-then-act here would send two; an in-memory flag would not survive
  // a second server.
  //
  // WHAT THIS GUARANTEES, AND WHAT IT DOES NOT. It prevents a duplicate: the
  // customer is never emailed twice for one order. It does not guarantee
  // delivery: the claim is taken before the send, so if the provider then
  // fails, the column is already set and no replay will try again. Recovery
  // today is the manual re-send from the admin. Anything stronger — a retry
  // that cannot double-send — needs a durable outbox or an idempotency key
  // the provider honours, and is deliberately not built here.
  let emailClaimed = false;
  if (markedPaid && hasLines) {
    const { data: won, error: claimError } = await supabase
      .from("orders")
      .update({ confirmation_sent_at: new Date().toISOString() })
      .eq("id", orderId)
      .is("confirmation_sent_at", null)
      .select("id");

    if (claimError) {
      console.error(
        `Could not claim the confirmation email for ${razorpayOrderId}: ${claimError.message}`
      );
    }
    emailClaimed = Boolean(won?.length);
  }

  if (emailClaimed) {
    // Not awaited: the customer's confirmation page must not wait on an email
    // provider, nor fail because one is down. Wrapped so that a synchronous
    // throw, or a sender that did not return a promise, is caught the same
    // way as a rejection — the payment is recorded by now, and nothing about
    // the email may turn that into an error for the caller.
    void Promise.resolve()
      .then(() => sendConfirmation(razorpayOrderId))
      .catch((e) => console.error(`Order confirmation email failed for ${razorpayOrderId}:`, e));
  }

  return {
    ok: markedPaid,
    orderId,
    orphan: false,
    stock,
    emailClaimed,
    flaggedForReview: stockShort && markedPaid,
  };
}
