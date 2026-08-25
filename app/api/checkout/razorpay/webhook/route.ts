import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { settleOrder } from "@/lib/settleOrder";
import {
  settlementTarget,
  verifyWebhookSignature,
  type WebhookEvent,
} from "@/lib/razorpayWebhook";

/**
 * Razorpay tells us a payment succeeded, without asking the customer to.
 *
 * WHY THIS EXISTS. Until now the only thing that marked an order paid was a
 * fetch fired from the customer's browser after the payment modal closed. On a
 * phone that is a fragile place to keep the only copy of a fact: UPI hands the
 * customer to GPay or PhonePe and back, and that app-switch is exactly when a
 * mobile browser may discard the page. When it did, the money had moved and the
 * database never heard — order stuck pending, no stock movement, no email, and
 * a customer holding a receipt for something we had no record of.
 *
 * This is the path that does not depend on the customer coming back. The browser
 * call stays, because it is faster and gives them an immediate confirmation
 * page; this is what makes it an optimisation rather than the only hope.
 *
 * ── Verification, per Razorpay's documentation ──
 *
 * Three details, all of which are easy to get subtly wrong:
 *
 *   1. The signature is HMAC-SHA256 of the RAW REQUEST BODY. Razorpay's docs say
 *      "do not parse or cast the webhook request body" — JSON.parse followed by
 *      JSON.stringify will re-order keys and change whitespace, and the digest
 *      will not match. So the body is read with .text() and parsed only after
 *      the signature is proven.
 *
 *   2. The key is the WEBHOOK SECRET, not the API key secret. They are different
 *      values with different lifecycles; the payment-response signature on the
 *      other route uses the API secret, and swapping them silently fails.
 *
 *   3. The header is x-razorpay-signature.
 *
 * ── Duplicates ──
 *
 * Razorpay documents at-least-once delivery, retried with exponential backoff
 * for 24 hours, and warns that events may arrive out of order. Every duplicate
 * is normal traffic. Two things absorb that: x-razorpay-event-id is recorded
 * before the work so a redelivery is recognised, and settleOrder is idempotent
 * anyway so a duplicate that slips past the id check still changes nothing.
 *
 * ── Always 2xx once we own the event ──
 *
 * A non-2xx makes Razorpay retry, and after 24 hours of failures it disables the
 * webhook entirely. So a bad signature is 400 (it is not ours and never will be),
 * but anything that fails AFTER we have accepted the event returns 200 with the
 * problem logged. Retrying will not fix a recording bug, and losing the endpoint
 * would cost every future order.
 */

// Node, not Edge: the signature check needs node:crypto and settlement uses the
// Supabase service client.
export const runtime = "nodejs";
// Nothing about this response is cacheable, and a cached 200 would be a webhook
// that silently stopped working.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    // Configuration, not traffic. 500 so Razorpay retries — by the time the
    // secret is set, the backoff window may still deliver the event.
    console.error("RAZORPAY_WEBHOOK_SECRET is not set — cannot verify webhooks.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  // RAW. Not request.json(). See note 1 above.
  const raw = await request.text();
  const signature = request.headers.get("x-razorpay-signature") ?? "";

  if (!verifyWebhookSignature(raw, signature, secret)) {
    // Deliberately terse, and deliberately not echoing the signature or body.
    console.error("Rejected a Razorpay webhook with an invalid signature.");
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Only now is this trustworthy enough to parse.
  let event: WebhookEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error("Razorpay webhook passed signature but was not valid JSON.");
    return NextResponse.json({ ok: true, ignored: "unparseable" });
  }

  const eventType = event.event ?? "";
  const eventId = request.headers.get("x-razorpay-event-id");
  const supabase = createServiceClient();

  // Recorded BEFORE the work, so a redelivery that arrives while the first is
  // still running is still recognised — the primary key does the arbitration,
  // not a read we did a moment ago.
  if (eventId) {
    const { error: seen } = await supabase
      .from("razorpay_webhook_events")
      .insert({ event_id: eventId, event_type: eventType });

    if (seen) {
      // 23505 is unique_violation: we have this one already.
      if (seen.code === "23505") {
        return NextResponse.json({ ok: true, duplicate: true });
      }
      // Anything else — table missing because 0058 has not been applied yet, for
      // instance — must not stop a real payment being recorded. settleOrder is
      // idempotent on its own; this table is a shortcut, not the guarantee.
      console.error(`Could not record webhook event ${eventId}: ${seen.message}`);
    }
  }

  const target = settlementTarget(event);
  if (!target.settle) {
    if (target.reason === "incomplete payload") {
      console.error(
        `Razorpay webhook ${eventType} had no usable order/payment pair — nothing settled.`
      );
    }
    return NextResponse.json({ ok: true, ignored: target.reason });
  }

  try {
    const result = await settleOrder(target.razorpayOrderId, target.razorpayPaymentId);
    return NextResponse.json({ ok: true, settled: result.firstSettlement });
  } catch (e) {
    // 200 on purpose. See "Always 2xx once we own the event" above: a retry
    // cannot fix this, and repeated failures would disable the endpoint.
    console.error(`Webhook settlement threw for ${target.razorpayOrderId}:`, e);
    return NextResponse.json({ ok: true, error: "settlement failed" });
  }
}
