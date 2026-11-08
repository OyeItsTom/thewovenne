import { NextRequest, NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/razorpayWebhook";

/**
 * Razorpay's server-to-server notifications: a payment was captured
 * (payment.captured / order.paid), or a refund changed (refund.*, OS-3).
 *
 * Thin on purpose: the raw bytes, two headers and the secret go to
 * lib/razorpayWebhook, which decides everything and answers with a status.
 * Settlement itself is lib/settleOrder — the same function the browser
 * callback uses — so a payment reported both ways is recorded once. A refund
 * event is only a trigger: lib/refundLedger asks Razorpay's API about the
 * refund and records that answer.
 */

// Node, not Edge: the signature check needs node:crypto and settlement uses
// the Supabase service client.
export const runtime = "nodejs";
// Nothing about this response is cacheable, and a cached 200 would be a
// webhook that silently stopped working.
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // RAW. Not request.json(): the signature is computed over these exact
  // bytes, and Razorpay's documentation says not to parse or cast them first.
  const rawBody = await request.text();

  const outcome = await handleRazorpayWebhook({
    rawBody,
    signature: request.headers.get("x-razorpay-signature"),
    eventId: request.headers.get("x-razorpay-event-id"),
    secret: process.env.RAZORPAY_WEBHOOK_SECRET,
  });

  return NextResponse.json(outcome.body, { status: outcome.status });
}
