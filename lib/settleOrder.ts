import { razorpay } from "./razorpay";
import { createServiceClient } from "./supabase";
import { settleLoyalty } from "./settleLoyalty";
import { sendOrderConfirmation } from "./sendOrderConfirmation";
import { toPaise } from "./utils";

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
 * NOTHING IS FULFILLED UNTIL RAZORPAY'S API SAYS THE PAYMENT IS CAPTURED.
 * Whoever calls this — the browser route with a genuine checkout signature,
 * the webhook with a genuine captured event — this function fetches the
 * payment from Razorpay itself and requires: status "captured", the payment's
 * order_id equal to the order being settled, INR, and the amount equal to
 * what the server asked for at creation. That single fetch is the authority
 * for every caller, so there is no "trust me, it's captured" input for anyone
 * to forge, and the two paths cannot drift. An authorised-but-uncaptured
 * payment (funds held, not settled to us, auto-refunded by Razorpay if never
 * captured) touches nothing and is reported as pending_capture; it is not a
 * failure and the customer must not be told to pay again. A payment that
 * cannot be fetched touches nothing either — indeterminate, try later — and
 * the webhook's retries will bring it back.
 *
 * Capture policy (auto or manual) is a dashboard setting this code does not
 * assume and does not change: nothing here captures a payment.
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
  total_inr: number | null;
}

/** The fields of a fetched Razorpay payment that decide anything here. */
interface GatewayPayment {
  id?: string;
  order_id?: string | null;
  status?: string;
  amount?: number | string;
  currency?: string;
  fee?: number | string | null;
  tax?: number | string | null;
}

export type SettlementOutcome =
  /** Captured, bound to this order, and recorded. */
  | "settled"
  /** Razorpay holds the money but has not captured it yet. Nothing touched. */
  | "pending_capture"
  /** Razorpay reports the payment failed. Nothing touched. */
  | "failed_payment"
  /** Razorpay reports the payment refunded. Nothing touched. */
  | "refunded"
  /** The fetched payment does not belong to this order, currency or amount. Nothing touched. */
  | "mismatch"
  /** A status this code does not know. Nothing touched. */
  | "unknown_status"
  /** Razorpay could not be asked. Nothing touched; ask again later. */
  | "indeterminate";

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
  outcome: SettlementOutcome;
  /** What Razorpay's API said the payment's status was, or null if unreachable. */
  paymentStatus: string | null;
  /** Settled: an order row was found or recorded and marked paid. */
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
  gateway: Pick<typeof razorpay, "payments">;
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

  const nothing = (outcome: SettlementOutcome, paymentStatus: string | null): SettlementResult => ({
    outcome,
    paymentStatus,
    ok: false,
    orderId: null,
    orphan: false,
    stock: "none",
    emailClaimed: false,
    flaggedForReview: false,
  });

  // ── The payment, from Razorpay ──
  // Asked first, before the database is touched, because nothing below is
  // allowed to happen unless the answer is "captured". This is the one
  // gateway call: the payment is the money, so its amount is the total, its
  // fee and tax are the gateway cost, and its order_id is the binding.
  let payment: GatewayPayment;
  try {
    payment = (await gateway.payments.fetch(razorpayPaymentId)) as GatewayPayment;
  } catch (e) {
    console.error(`Could not fetch Razorpay payment ${razorpayPaymentId} — settlement deferred:`, e);
    return nothing("indeterminate", null);
  }

  const status = typeof payment?.status === "string" ? payment.status : null;
  switch (status) {
    case "captured":
      break;
    case "authorized":
    case "created":
      // Held, or still in flight. Razorpay will fire payment.captured when it
      // captures (auto or by hand), and the webhook settles then.
      return nothing("pending_capture", status);
    case "failed":
      return nothing("failed_payment", status);
    case "refunded":
      return nothing("refunded", status);
    default:
      console.error(`Razorpay payment ${razorpayPaymentId} has an unrecognised status — not settling.`);
      return nothing("unknown_status", status);
  }

  // ── The binding ──
  // The checkout signature says this order id and payment id were issued
  // together; Razorpay's own record of the payment must agree, in INR. A
  // disagreement is not a customer problem to work around — it is a request
  // that should not exist, and it settles nothing.
  if (payment.order_id !== razorpayOrderId) {
    console.error(
      `Razorpay payment ${razorpayPaymentId} belongs to ${payment.order_id ?? "no order"}, not ${razorpayOrderId} — not settling.`
    );
    return nothing("mismatch", status);
  }
  if (payment.currency !== "INR") {
    console.error(`Razorpay payment ${razorpayPaymentId} is in ${payment.currency ?? "no currency"}, not INR — not settling.`);
    return nothing("mismatch", status);
  }
  const paidPaise = Number(payment.amount);
  if (!Number.isFinite(paidPaise) || paidPaise <= 0) {
    console.error(`Razorpay payment ${razorpayPaymentId} has no usable amount — not settling.`);
    return nothing("mismatch", status);
  }
  const capturedInr = paidPaise / 100;
  const gatewayFeeInr = payment.fee === undefined || payment.fee === null ? null : Number(payment.fee) / 100;
  const gatewayTaxInr = payment.tax === undefined || payment.tax === null ? null : Number(payment.tax) / 100;

  // ── The order as the SERVER priced it ──
  // Everything below is about this row: the stock that comes out, the id the
  // movements are attached to, and the amount the server asked Razorpay for.
  const { data: pendingRow } = await supabase
    .from("orders")
    .select("id, items, total_inr")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();
  const pending = (pendingRow as PendingRow | null) ?? null;

  // The amount captured must be the amount the server asked for. Razorpay
  // enforces this for a standard order, so a difference means the row or the
  // request is not what it seems — and settling a basket for money that does
  // not match it is exactly the thing this file exists to refuse.
  if (pending && pending.total_inr !== null && pending.total_inr !== undefined) {
    // Same helper the checkout route used to ask for the amount, so the two
    // sides cannot disagree by rounding.
    const askedPaise = toPaise(Number(pending.total_inr));
    if (askedPaise !== paidPaise) {
      console.error(
        `Razorpay payment ${razorpayPaymentId} captured ${paidPaise} paise but order ${pending.id} asked for ${askedPaise} — not settling.`
      );
      return nothing("mismatch", status);
    }
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
      outcome: "settled",
      paymentStatus: status,
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
    // What Razorpay captured — checked above to equal what the server asked.
    total_inr: capturedInr,
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
    outcome: "settled",
    paymentStatus: status,
    ok: markedPaid,
    orderId,
    orphan: false,
    stock,
    emailClaimed,
    flaggedForReview: stockShort && markedPaid,
  };
}
