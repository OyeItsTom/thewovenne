import { NextRequest, NextResponse } from "next/server";
import { createCheckout, type CreatePayload } from "@/lib/checkoutCreate";
import { verifyPaymentSignature } from "@/lib/razorpayVerify";
import { settleOrder } from "@/lib/settleOrder";

// The create half lives in lib/checkoutCreate (LS-1), so the amount sent to
// Razorpay can be tested against a fake gateway. The contract is unchanged.

/**
 * Deliberately carries NO basket. The lines were priced and stored when the
 * order was created; a verify that described the goods again would let the
 * browser restate them after paying. See lib/razorpayVerify.
 */
interface VerifyPayload {
  action: "verify";
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as CreatePayload | VerifyPayload;

  if (body.action === "create") {
    return handleCreate(body);
  }

  if (body.action === "verify") {
    return handleVerify(body);
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}

async function handleCreate(body: CreatePayload) {
  const { status, body: out } = await createCheckout(body);
  return NextResponse.json(out, { status });
}

async function handleVerify({
  razorpay_order_id,
  razorpay_payment_id,
  razorpay_signature,
}: VerifyPayload) {
  const verified = verifyPaymentSignature(
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    process.env.RAZORPAY_KEY_SECRET
  );

  if (!verified) {
    return NextResponse.json({ verified: false });
  }

  // The signature proves this order id and payment id were issued together
  // by Razorpay — nothing more. Whether the payment is CAPTURED is decided in
  // lib/settleOrder by asking Razorpay's API, the same way the webhook path
  // is decided; the request has named which pair to ask about, and nothing
  // else it says is trusted. Replaying this request is safe: every effect is
  // guarded in the database.
  const settled = await settleOrder({
    razorpayOrderId: razorpay_order_id,
    razorpayPaymentId: razorpay_payment_id,
  });

  // Three things the page must be able to tell apart, and `verified` alone
  // cannot: the signature was genuine in every case below.
  //
  //   outcome "settled"                     captured, recorded — confirm.
  //   outcome "pending_capture" |
  //           "indeterminate"               Razorpay has the payment (or could
  //                                         not be asked); confirmation is
  //                                         still to come, by webhook. The
  //                                         customer must NOT pay again.
  //   anything else                         not settled, and a retry will not
  //                                         change it — failed, refunded, or a
  //                                         payment that does not belong to
  //                                         this order.
  return NextResponse.json({
    verified: true,
    outcome: settled.outcome,
    recorded: settled.ok,
  });
}
