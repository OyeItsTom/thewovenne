import crypto from "crypto";

/**
 * The parts of webhook handling that are decisions rather than I/O.
 *
 * Split out so they can be tested without a database, a network or a payment.
 * The route is then thin enough to read in one go, and the three details that
 * are easy to get wrong — raw body, webhook secret, constant-time compare —
 * live in one place with tests pointed at them.
 */

/** Events that mean money has been captured. Razorpay fires both; either settles. */
export const SETTLING_EVENTS = ["payment.captured", "order.paid"] as const;

/**
 * Is this webhook really from Razorpay?
 *
 * HMAC-SHA256 of the RAW body under the WEBHOOK secret, per Razorpay's
 * documentation, which explicitly says not to parse or cast the body first —
 * a JSON round-trip reorders keys and changes whitespace, and the digest moves
 * with it.
 *
 * Note the secret here is NOT the API key secret used for the payment-response
 * signature on the checkout route. Different values, different lifecycles; they
 * are swapped easily and fail silently when they are.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string
): boolean {
  if (!secret || !signature) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  // A hex digest is fixed-length, so unequal lengths are already a failed
  // signature — and timingSafeEqual throws rather than returning false when the
  // buffers differ in size, so the length test has to come first.
  const provided = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuf);
}

export interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string } };
    order?: { entity?: { id?: string } };
  };
}

export type SettlementTarget =
  | { settle: true; razorpayOrderId: string; razorpayPaymentId: string }
  | { settle: false; reason: string };

/**
 * What, if anything, this event asks us to settle.
 *
 * Returns a reason rather than throwing for everything it declines, because the
 * route answers 200 to all of them — an event we do not act on is not an error,
 * and a non-2xx would have Razorpay retry it for 24 hours and then disable the
 * endpoint.
 *
 * BOTH IDENTIFIERS ARE REQUIRED. order.paid can arrive without a payment entity;
 * the payment id is what the fee lookup needs, and an order id on its own cannot
 * say which payment paid it.
 */
export function settlementTarget(event: WebhookEvent): SettlementTarget {
  const type = event.event ?? "";
  if (!SETTLING_EVENTS.includes(type as (typeof SETTLING_EVENTS)[number])) {
    return { settle: false, reason: type ? `ignored event ${type}` : "no event type" };
  }

  const payment = event.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id ?? event.payload?.order?.entity?.id;
  const razorpayPaymentId = payment?.id;

  if (!razorpayOrderId || !razorpayPaymentId) {
    return { settle: false, reason: "incomplete payload" };
  }

  return { settle: true, razorpayOrderId, razorpayPaymentId };
}
