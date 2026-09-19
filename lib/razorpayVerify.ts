import crypto from "crypto";

/**
 * Is the browser's payment response really from Razorpay?
 *
 * This module answers only that. What happens after a genuine signature —
 * stock, the order row, points, coupon, invoice, email — lives in
 * lib/settleOrder, shared with every other way of learning that a payment
 * succeeded, and takes nothing from the request but Razorpay's two ids. The
 * signature binds those ids and nothing else, which is exactly why no basket
 * is accepted here: a verify that described the goods again could restate
 * them after the money had moved.
 */

/**
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
