import { razorpay } from "./razorpay";
import { createServiceClient } from "./supabase";
import { settleLoyalty } from "./settleLoyalty";
import { sendOrderConfirmation } from "./sendOrderConfirmation";

/**
 * Everything that happens once a payment is known to be real.
 *
 * WHY THIS IS A FUNCTION AND NOT A ROUTE. There are two ways to learn that a
 * payment succeeded — the customer's browser calling back after the modal
 * closes, and Razorpay's webhook — and they must have identical effects. Two
 * copies of this logic would drift, and the drift would only show up on the
 * rarer path, which is the one nobody watches.
 *
 * SAFE TO RUN MORE THAN ONCE, and it will be: Razorpay documents at-least-once
 * webhook delivery with retries for 24 hours, so a second settlement of the same
 * order is normal operation, not an error. Every effect below is idempotent, and
 * every one of those guarantees lives in the database rather than here:
 *
 *   stock       stock_movements_one_sale_per_line  (0058)
 *   redemption  loyalty_ledger_one_redemption_per_order  (0058)
 *   award       loyalty_ledger_one_award_per_order  (0029)
 *   coupon      redeem_coupon() is idempotent per order  (0037)
 *   email       confirmation_sent_at, claimed atomically  (0058)
 *   order row   an UPDATE to fixed values — writing it twice is writing it once
 *
 * There is deliberately no `if (already paid) return` at the top. That is a
 * check-then-act, and the case this function exists to survive is two settlements
 * arriving together — where both would pass the check. The guarantees have to be
 * where the concurrency is.
 *
 * NEVER THROWS FOR A RECORDING PROBLEM. The customer has paid. Anything that
 * fails after that point is logged and flagged for a human; none of it is a
 * reason to tell somebody their successful payment failed.
 */

interface OrderRow {
  id: string;
  items: Array<{ id: string; size: string; quantity: number }> | null;
  payment_status: string | null;
}

export interface SettlementResult {
  /** False only when there was nothing to settle against and nothing could be recorded. */
  ok: boolean;
  /** True when this call did the work; false when it found it already done. */
  firstSettlement: boolean;
  orderId: string | null;
  /** Set when stock could not be taken — the order is flagged for review. */
  stockShort: boolean;
}

/**
 * Injected only by tests. Production always takes the defaults — there is no
 * code path that passes these, so nothing about the live behaviour depends on
 * them being right.
 */
export interface SettlementDeps {
  supabase: ReturnType<typeof createServiceClient>;
  gateway: Pick<typeof razorpay, "orders" | "payments">;
  sendConfirmation: typeof sendOrderConfirmation;
  settlePoints: typeof settleLoyalty;
}

export async function settleOrder(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  deps?: Partial<SettlementDeps>
): Promise<SettlementResult> {
  const supabase = deps?.supabase ?? createServiceClient();
  const gateway = deps?.gateway ?? razorpay;
  const sendConfirmation = deps?.sendConfirmation ?? sendOrderConfirmation;
  const settlePoints = deps?.settlePoints ?? settleLoyalty;

  // The order as the SERVER priced it, not as the browser describes it now.
  // handleCreate already wrote these lines after re-pricing from the database;
  // re-reading a client's `items` at settlement time would let the basket be
  // restated after payment, and the webhook has no client to ask anyway.
  const { data: existing } = await supabase
    .from("orders")
    .select("id, items, payment_status")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();

  let order = existing as OrderRow | null;
  const alreadyPaid = order?.payment_status === "paid";

  // What Razorpay actually took, and what it cost us to take it. Read from the
  // gateway rather than recomputed: a discount window that closed between
  // creation and payment would make a recomputation disagree with the money,
  // and the money is the fact of record.
  //
  // Never fatal. A figure we could not read is a reporting gap; failing a
  // confirmation the customer has already paid for is not.
  let capturedInr: number | null = null;
  let gatewayFeeInr: number | null = null;
  let gatewayTaxInr: number | null = null;
  try {
    const rzpOrder = await gateway.orders.fetch(razorpayOrderId);
    capturedInr = Number(rzpOrder.amount) / 100;
  } catch (e) {
    console.error(`Could not fetch Razorpay order ${razorpayOrderId} for amount:`, e);
  }
  try {
    const payment = await gateway.payments.fetch(razorpayPaymentId);
    if (payment?.fee != null) gatewayFeeInr = Number(payment.fee) / 100;
    if (payment?.tax != null) gatewayTaxInr = Number(payment.tax) / 100;
  } catch (e) {
    console.error(
      `Could not read Razorpay fees for payment ${razorpayPaymentId} — this order will show no gateway cost:`,
      e
    );
  }

  // Paid, with no row to attach it to. Should not happen — handleCreate writes
  // one before the modal opens — but losing a paid order silently is far worse
  // than a thin one, so record what we have and shout about it.
  //
  // Inserted BEFORE stock is touched, so the movement has an order to belong to
  // and the uniqueness guard has something to key on.
  if (!order) {
    console.error(
      `Paid order ${razorpayOrderId} had no pending row — recording without contact details.`
    );
    const { data: inserted, error: insertError } = await supabase
      .from("orders")
      .insert({
        razorpay_order_id: razorpayOrderId,
        payment_provider: "razorpay",
        payment_status: "paid",
        total_inr: capturedInr,
      })
      .select("id, items, payment_status")
      .maybeSingle();

    if (insertError || !inserted) {
      // A concurrent settlement may have inserted it a moment ago — the unique
      // index on razorpay_order_id (0020) is what makes that a conflict rather
      // than a second row. Re-read before giving up.
      const { data: reread } = await supabase
        .from("orders")
        .select("id, items, payment_status")
        .eq("razorpay_order_id", razorpayOrderId)
        .maybeSingle();
      order = reread as OrderRow | null;
      if (!order) {
        console.error(
          `Could not record paid order ${razorpayOrderId}: ${insertError?.message ?? "no row returned"}`
        );
        return { ok: false, firstSettlement: false, orderId: null, stockShort: false };
      }
    } else {
      order = inserted as OrderRow;
    }
  }

  const orderId = order.id;
  const lines = Array.isArray(order.items) ? order.items : [];

  // ── Stock ──
  // After payment, never before. Decrementing at checkout-start would let an
  // abandoned modal hold stock nobody bought.
  //
  // Idempotent since 0058: the movement row is inserted before the decrement and
  // is unique per line per order, so a repeat settlement takes nothing.
  let stockShort = false;
  if (lines.length > 0) {
    try {
      const { error: stockError } = await supabase.rpc("reserve_stock", {
        p_items: lines.map((i) => ({ id: i.id, size: i.size, quantity: i.quantity })),
        p_order_id: orderId,
      });
      if (stockError) {
        stockShort = true;
        console.error(
          `Stock could not be reserved for paid order ${razorpayOrderId}: ${stockError.message}`
        );
      }
    } catch (e) {
      stockShort = true;
      console.error("reserve_stock threw:", e);
    }
  }

  // ── The order row ──
  // UPDATE, not insert: handleCreate wrote the customer's contact and address,
  // and a second row would be the paid one missing everything needed to ship it.
  //
  // `items` is not rewritten here. It was priced by the server at creation and
  // nothing since has better information about what was sold.
  const paidPatch: Record<string, unknown> = {
    payment_status: "paid",
    gateway_fee_inr: gatewayFeeInr,
    gateway_tax_inr: gatewayTaxInr,
  };
  if (capturedInr != null) paidPatch.total_inr = capturedInr;
  // Only ever set, never cleared: a repeat settlement that happens to reserve no
  // stock must not lift a review flag a human has not looked at yet.
  if (stockShort) paidPatch.tracking_status = "needs_review";

  const { error: updateError } = await supabase
    .from("orders")
    .update(paidPatch)
    .eq("razorpay_order_id", razorpayOrderId);

  if (updateError) {
    console.error(`Failed to mark order ${razorpayOrderId} paid:`, updateError.message);
  }

  // ── Points ──
  // Guarded per order in the database on both sides since 0058, so a retry
  // neither pays out twice nor spends a balance twice.
  await settlePoints(razorpayOrderId);

  // ── Coupon ──
  // Claimed here rather than at checkout-start, so abandoned payment modals do
  // not burn a launch code's allowance. redeem_coupon() is idempotent per order.
  const { data: orderMeta } = await supabase
    .from("orders")
    .select("coupon_code, coupon_discount_inr, customer_email")
    .eq("id", orderId)
    .maybeSingle();

  const meta = orderMeta as {
    coupon_code?: string | null;
    coupon_discount_inr?: number | null;
    customer_email?: string | null;
  } | null;

  if (meta?.coupon_code) {
    const { data: claimed, error: redeemError } = await supabase.rpc("redeem_coupon", {
      p_code: meta.coupon_code,
      p_order_id: orderId,
      p_email: meta.customer_email ?? "",
      p_discount: meta.coupon_discount_inr ?? 0,
    });
    if (redeemError) {
      console.error(
        `Could not record coupon ${meta.coupon_code} for paid order ${razorpayOrderId}: ${redeemError.message}`
      );
    } else if (claimed === false) {
      console.error(
        `Coupon ${meta.coupon_code} could not be claimed for paid order ${razorpayOrderId} ` +
          `(exhausted or withdrawn mid-payment). Discount was honoured.`
      );
    }
  }

  // ── Invoice number ──
  // The number identifies a financial event, so it belongs to the moment payment
  // succeeded. The PDF is still rendered on demand.
  const { error: invoiceError } = await supabase.rpc("assign_invoice_number", {
    p_order_id: orderId,
  });
  if (invoiceError) {
    console.error(
      `Could not assign an invoice number to paid order ${razorpayOrderId}: ${invoiceError.message}`
    );
  }

  // ── Confirmation email ──
  // Claimed, not checked. This UPDATE only matches while the column is still
  // null, so of two settlements arriving together exactly one gets a row back
  // and exactly one email is sent. A check-then-act here would send two.
  const { data: claimedEmail } = await supabase
    .from("orders")
    .update({ confirmation_sent_at: new Date().toISOString() })
    .eq("id", orderId)
    .is("confirmation_sent_at", null)
    .select("id");

  const wonTheEmail = Boolean(claimedEmail?.length);

  if (wonTheEmail) {
    // Not awaited: the customer's confirmation page must not wait on an email
    // provider, nor fail because one is down.
    void sendConfirmation(razorpayOrderId).catch((e) =>
      console.error("Order confirmation email failed:", e)
    );
  }

  return {
    ok: true,
    // Reported from what was actually true before this call, for logging and
    // tests. Nothing branches on it — every effect above is safe either way.
    firstSettlement: !alreadyPaid,
    orderId,
    stockShort,
  };
}
