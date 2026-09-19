import { NextRequest, NextResponse } from "next/server";
import { handleRazorpayWebhook } from "@/lib/razorpayWebhook";

/**
 * Razorpay's server-to-server notification that a payment was captured.
 *
 * Thin on purpose: the raw bytes, two headers and the secret go to
 * lib/razorpayWebhook, which decides everything and answers with a status.
 * Settlement itself is lib/settleOrder — the same function the browser
 * callback uses — so a payment reported both ways is recorded once.
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
