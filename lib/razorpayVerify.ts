import crypto from "crypto";
import { razorpay } from "./razorpay";
import { createServiceClient } from "./supabase";
import { settleLoyalty } from "./settleLoyalty";
import { sendOrderConfirmation } from "./sendOrderConfirmation";

/**
 * What happens once the customer's browser reports a payment.
 *
 * THE BASKET IS READ FROM THE ORDER ROW, NEVER FROM THE REQUEST. handleCreate
 * priced the lines from the database and wrote them to the pending order before
 * the Razorpay modal opened; that row is the record of what was paid for. The
 * payment-response signature binds only Razorpay's order and payment ids — it
 * says nothing about cart contents — so a verify request that carried its own
 * `items` could restate the basket after the money had moved: pay for one
 * piece, verify with three, and the order and the stock movement would say
 * three. This module does not accept items at all.
 *
 * Split out of the route so the post-signature effects can be exercised with
 * a fake database and a fake gateway. Nothing about the behaviour is meant to
 * differ from when it lived inline; the I/O is injected, not redesigned.
 */

/**
 * Is this payment response really from Razorpay?
 *
 * HMAC-SHA256 of `order_id|payment_id` under the API KEY SECRET, per Razorpay's
 * documentation for the checkout handler response. Constant-time compare; a
 * hex digest is fixed-length, so a length mismatch is already a failed
 * signature and timingSafeEqual would throw on unequal buffers anyway.
 */
export function verifyPaymentSignature(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  signature: string | null | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !signature || !razorpayOrderId || !razorpayPaymentId) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest("hex");

  const provided = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuf);
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

export interface VerifiedSettlementResult {
  /** The internal order row settled against, or the thin row inserted. */
  orderId: string | null;
  /** True when reserve_stock refused — the order is flagged for review. */
  stockShort: boolean;
  /** True when no pending row existed and a thin row was recorded instead. */
  orphan: boolean;
}

/**
 * Injected only by tests. Production always takes the defaults — no code path
 * passes these, so nothing about the live behaviour depends on them.
 */
export interface VerifiedSettlementDeps {
  supabase: ReturnType<typeof createServiceClient>;
  gateway: Pick<typeof razorpay, "orders" | "payments">;
  settlePoints: typeof settleLoyalty;
  sendConfirmation: typeof sendOrderConfirmation;
}

/**
 * Settle a payment whose signature has ALREADY been verified.
 *
 * Never throws for a recording problem. The customer has paid; anything that
 * fails after that point is logged and flagged for a human, and none of it is
 * a reason to tell somebody their successful payment failed.
 */
export async function settleVerifiedPayment(
  razorpayOrderId: string,
  razorpayPaymentId: string,
  deps?: Partial<VerifiedSettlementDeps>
): Promise<VerifiedSettlementResult> {
  const supabase = deps?.supabase ?? createServiceClient();
  const gateway = deps?.gateway ?? razorpay;
  const settlePoints = deps?.settlePoints ?? settleLoyalty;
  const sendConfirmation = deps?.sendConfirmation ?? sendOrderConfirmation;

  // The order as the SERVER priced it. Read first, because everything below
  // is about this row: the stock that comes out, the id the movement is
  // attached to, the total to fall back to if the gateway cannot be reached.
  const { data: pendingRow } = await supabase
    .from("orders")
    .select("id, items")
    .eq("razorpay_order_id", razorpayOrderId)
    .maybeSingle();
  const pending = (pendingRow as PendingRow | null) ?? null;

  // The recorded total is what Razorpay actually captured, not a recomputation.
  // Re-pricing here could disagree with the create call if a discount window
  // closed in between, and the payment is the fact of record.
  let capturedInr: number | null = null;
  try {
    const order = await gateway.orders.fetch(razorpayOrderId);
    capturedInr = Number(order.amount) / 100;
  } catch (e) {
    console.error("Could not fetch Razorpay order for amount:", e);
  }

  // What Razorpay actually took. Read here, at verification, because it is only
  // knowable once a payment exists — and it is a real cost of every sale that
  // would otherwise never appear in the P&L, quietly overstating profit on
  // every order.
  //
  // Fee and tax stay separate: they are separate lines on Razorpay's settlement,
  // and netting them together loses the input credit once GST registration
  // happens. Both arrive in paise.
  //
  // Never fatal. A fee we could not read is a reporting gap; failing a
  // confirmation the customer has already paid for is not.
  let gatewayFeeInr: number | null = null;
  let gatewayTaxInr: number | null = null;
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

  // Paid, but no pending row. Should not happen — handleCreate writes one
  // before the modal opens — and losing a paid order silently would be far
  // worse than a thin one, so record what we have and shout about it.
  //
  // WHAT WE HAVE IS THE MONEY, NOT THE BASKET. The only description of the
  // goods would be whatever the browser cared to send, and that is exactly
  // the authority this module refuses. So: no items, no stock movement, and
  // the row is flagged for a human to reconcile against Razorpay's record.
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
        needs_review: true,
      })
      .select("id")
      .maybeSingle();
    if (insertError) {
      console.error(`Could not record paid order ${razorpayOrderId}:`, insertError.message);
    }

    await settlePoints(razorpayOrderId);
    void sendConfirmation(razorpayOrderId).catch((e) =>
      console.error("Order confirmation email failed:", e)
    );

    return {
      orderId: (inserted as { id?: string } | null)?.id ?? null,
      stockShort: false,
      orphan: true,
    };
  }

  const lines = Array.isArray(pending.items) ? pending.items : [];

  // Stock comes out HERE, after payment is confirmed, and atomically —
  // reserve_stock decrements with the guard inside the UPDATE, so two buyers
  // racing for the last unit cannot both succeed.
  //
  // The cost of decrementing after payment rather than before is a window of a
  // few seconds in which both can pay. When that happens the customer is NOT
  // failed — they have paid, and refusing their confirmation over our stock
  // arithmetic would be indefensible. The order is flagged instead, so a human
  // can refund or restock deliberately.
  //
  // The lines are the stored ones. A pending row with none is a row we cannot
  // fulfil from, so it is flagged the same way rather than settled as if it
  // held nothing.
  let stockShort = false;
  if (lines.length === 0) {
    stockShort = true;
    console.error(`Paid order ${razorpayOrderId} has no stored lines — flagging for review.`);
  } else {
    try {
      const { error: stockError } = await supabase.rpc("reserve_stock", {
        p_items: lines.map((i) => ({
          id: i.id,
          size: i.size,
          quantity: i.quantity,
        })),
        p_order_id: pending.id,
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

  // UPDATE, not insert: handleCreate already wrote this row with the customer's
  // contact, address and lines. `items` is not rewritten — nothing since
  // creation has better information about what was sold.
  //
  // needs_review is only ever SET here, never cleared. A flag a human has not
  // looked at yet must survive a settlement that happened to go smoothly.
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
    .eq("razorpay_order_id", razorpayOrderId)
    .select("id");

  if (updateError) {
    // The customer has paid — never fail their confirmation over a recording
    // problem. Sentry picks this up from the console error.
    console.error("Failed to mark order paid:", updateError.message);
  } else if (!updated?.length) {
    console.error(`Paid order ${razorpayOrderId}: the pending row vanished before it could be marked paid.`);
  }

  // Points move only after payment, and only through the database functions —
  // both are guarded so a retry cannot pay out twice or spend a balance twice.
  await settlePoints(razorpayOrderId);

  // The coupon use is claimed HERE, not at checkout-start. handleCreate writes
  // a pending row before the customer has paid, and counting a use there would
  // let abandoned payment modals burn a launch code's entire allowance.
  //
  // The trade-off is the same window reserve_stock accepts above: for a few
  // seconds more people can be mid-payment than there are uses left, so a
  // "first 50" can overshoot slightly. Overshooting a promotion is a rounding
  // error. Refusing someone who has already paid is not, so this NEVER fails
  // the confirmation — a use that cannot be claimed is logged and the order
  // stands, because the money has already moved at the discounted price.
  //
  // redeem_coupon() is idempotent per order, so a retried verification counts
  // once.
  const paidOrderId = !updateError && updated?.length ? pending.id : null;
  if (paidOrderId) {
    const { data: order } = await supabase
      .from("orders")
      .select("coupon_code, coupon_discount_inr, customer_email")
      .eq("id", paidOrderId)
      .maybeSingle();

    const used = order as {
      coupon_code?: string | null;
      coupon_discount_inr?: number | null;
      customer_email?: string | null;
    } | null;

    if (used?.coupon_code) {
      const { data: claimed, error: redeemError } = await supabase.rpc("redeem_coupon", {
        p_code: used.coupon_code,
        p_order_id: paidOrderId,
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

    // The invoice NUMBER is assigned now; the PDF is rendered on demand. A
    // number identifies a financial event, so it belongs to the moment the
    // payment succeeded — but rendering a document here would put a PDF
    // between the customer and their confirmation page, which is the same
    // reason the confirmation email is not awaited.
    const { error: invoiceError } = await supabase.rpc("assign_invoice_number", {
      p_order_id: paidOrderId,
    });
    if (invoiceError) {
      console.error(
        `Could not assign an invoice number to paid order ${razorpayOrderId}: ${invoiceError.message}`
      );
    }
  }

  // Sent last, and deliberately not awaited for its success: the customer has
  // paid and their confirmation page must not wait on an email provider, nor
  // fail because one is down. A failure is logged, and the order exists
  // regardless — it can always be re-sent from the admin.
  void sendConfirmation(razorpayOrderId).catch((e) =>
    console.error("Order confirmation email failed:", e)
  );

  return { orderId: pending.id, stockShort, orphan: false };
}
