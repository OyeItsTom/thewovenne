import crypto from "crypto";
import { createServiceClient } from "./supabase";
import { settleOrder, type SettlementResult } from "./settleOrder";

/**
 * Razorpay tells us a payment succeeded, without asking the customer to.
 *
 * WHY THIS EXISTS. The browser callback after the payment modal closes is a
 * fragile place to keep the only copy of a fact: UPI hands the customer to
 * GPay or PhonePe and back, and that app-switch is exactly when a mobile
 * browser may discard the page. When it does, the money has moved and the
 * database never hears — order stuck pending, no stock movement, no
 * confirmation. This is the path that does not depend on the customer coming
 * back. Both paths end in the same place, lib/settleOrder, with the same two
 * identifiers.
 *
 * Everything here that is a decision rather than I/O is a plain function, so
 * the route can stay thin and the three details that are easy to get wrong —
 * raw body, webhook secret, constant-time compare — sit next to their tests.
 *
 * ── The contract, per Razorpay's documentation (checked 19 Sep 2026) ──
 *
 *   header      X-Razorpay-Signature — HMAC-SHA256 of the RAW request body
 *               under the WEBHOOK secret. "Do not parse or cast the webhook
 *               request body": a JSON round-trip reorders keys and changes
 *               whitespace, and the digest moves with it.
 *   event id    x-razorpay-event-id, unique per event; the same event may be
 *               delivered more than once (at-least-once semantics).
 *   retries     any non-2xx, or no answer within 5 seconds, is a delivery
 *               failure; retried with exponential backoff for 24 hours, after
 *               which the endpoint is disabled and the account emailed.
 *   events      payment.captured and order.paid both carry
 *               payload.payment.entity with status "captured", captured true
 *               and order_id. payment.authorized is a snapshot of the
 *               AUTHORISED state and says nothing about capture.
 *
 * ── Duplicates, and the crash window ──
 *
 * The event id is recorded in razorpay_webhook_events AFTER a settlement
 * succeeds, and means "this delivery's work is done". It is deliberately not
 * inserted first as a claim: a claim written before the work, followed by a
 * crash before the work finished, would make every retry look like a
 * duplicate and the order would never settle — the dedupe table turned into a
 * lost-work marker. Recorded afterwards, a crash leaves nothing behind and the
 * retry does the work. The read before settling is an optimisation that skips
 * gateway calls for a delivery already completed; correctness never depends on
 * it, because settleOrder is safe to run again (0058).
 */

/** Events that mean money has been captured. Razorpay fires both; either settles. */
export const SETTLING_EVENTS = ["payment.captured", "order.paid"] as const;

/**
 * Is this webhook really from Razorpay?
 *
 * HMAC-SHA256 of the RAW body under the WEBHOOK secret. Not the API key
 * secret used for the payment-response signature on the checkout route:
 * different values, different lifecycles, swapped easily and failing silently
 * when they are.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined
): boolean {
  if (!secret || !signature || typeof rawBody !== "string") return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  // A hex digest is fixed-length, so unequal lengths are already a failed
  // signature — and timingSafeEqual throws rather than returning false when
  // the buffers differ in size, so the length test has to come first.
  const provided = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (provided.length !== expectedBuf.length) return false;

  return crypto.timingSafeEqual(provided, expectedBuf);
}

export interface WebhookEvent {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string; status?: string; captured?: boolean } };
    order?: { entity?: { id?: string; status?: string } };
  };
}

export type SettlementTarget =
  | { settle: true; razorpayOrderId: string; razorpayPaymentId: string }
  | { settle: false; reason: string };

/**
 * What, if anything, this (already verified) event asks us to settle.
 *
 * Only the two identifiers settleOrder takes come out of here. Nothing else in
 * the payload — amounts, customer details, notes — is read, because settlement
 * works from the order row Wovenne stored and from what it asks Razorpay's
 * API itself; a webhook cannot describe a basket or choose a customer.
 *
 * Declines are reasons rather than throws, because the route answers 200 to
 * all of them: an event we do not act on is not an error, and a non-2xx would
 * have Razorpay retry it for 24 hours and then disable the endpoint.
 *
 * BOTH IDENTIFIERS ARE REQUIRED, and the payment must say it is captured. The
 * payment id is what the fee lookup needs, and an order id on its own cannot
 * say which payment paid it. An event named payment.captured whose entity
 * does not read captured is not one we understand, and is left alone.
 */
export function settlementTarget(event: WebhookEvent): SettlementTarget {
  const type = event?.event ?? "";
  if (!SETTLING_EVENTS.includes(type as (typeof SETTLING_EVENTS)[number])) {
    return { settle: false, reason: type ? `ignored event ${type}` : "no event type" };
  }

  const payment = event.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id ?? event.payload?.order?.entity?.id;
  const razorpayPaymentId = payment?.id;

  if (!razorpayOrderId || !razorpayPaymentId) {
    return { settle: false, reason: "incomplete payload" };
  }
  if (payment?.status !== "captured") {
    return { settle: false, reason: `payment not captured (${payment?.status ?? "no status"})` };
  }

  return { settle: true, razorpayOrderId, razorpayPaymentId };
}

export interface WebhookRequest {
  /** The body exactly as received. Never parsed before the signature check. */
  rawBody: string;
  signature: string | null;
  eventId: string | null;
  secret: string | undefined;
}

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

/** Injected only by tests. Production always takes the defaults. */
export interface WebhookDeps {
  supabase: ReturnType<typeof createServiceClient>;
  settle: (input: { razorpayOrderId: string; razorpayPaymentId: string }) => Promise<SettlementResult>;
}

/**
 * The whole decision, from raw bytes to an HTTP status.
 *
 *   400  the signature does not verify. Not ours, or the secret is wrong; a
 *        retry will not change that, and the 24-hour failure window ends in
 *        an alert email, which is the right outcome for a misconfigured secret.
 *   500  the secret is not configured, a settlement we should have made
 *        could not be made, or a settlement was made but its completion
 *        record could not be written. All are OURS to fix and all are worth
 *        retrying: by the time the backoff delivers again, the secret may be
 *        set or the database back. settleOrder is safe to run again, so a
 *        retry can only help.
 *
 * NO EVENT ID (header missing or empty): the payment is still settled — the
 * signature and the captured payload are what make it trustworthy, not the
 * dedupe header — and no completion record is written, so every re-delivery
 * settles again. That is safe because settling again is a no-op; it merely
 * costs the gateway round-trips a recorded event would have skipped.
 *   200  everything else — settled, already done, an event we ignore, a
 *        payload we cannot use. A retry of any of those would be identical
 *        traffic, and refusing it would only cost the endpoint.
 */
export async function handleRazorpayWebhook(
  req: WebhookRequest,
  deps?: Partial<WebhookDeps>
): Promise<WebhookOutcome> {
  if (!req.secret) {
    // Configuration, not traffic. Fail closed, and retryable.
    console.error("RAZORPAY_WEBHOOK_SECRET is not set — cannot verify webhooks.");
    return { status: 500, body: { error: "Webhook not configured" } };
  }

  if (!verifyWebhookSignature(req.rawBody, req.signature, req.secret)) {
    // Deliberately terse, and deliberately not echoing the signature or body.
    console.error("Rejected a Razorpay webhook with an invalid signature.");
    return { status: 400, body: { error: "Invalid signature" } };
  }

  // Only now is this trustworthy enough to parse.
  let event: WebhookEvent;
  try {
    event = JSON.parse(req.rawBody) as WebhookEvent;
  } catch {
    console.error("Razorpay webhook passed signature but was not valid JSON.");
    return { status: 200, body: { ok: true, ignored: "unparseable" } };
  }
  if (!event || typeof event !== "object") {
    return { status: 200, body: { ok: true, ignored: "not an object" } };
  }

  const target = settlementTarget(event);
  if (!target.settle) {
    if (target.reason === "incomplete payload") {
      console.error(
        `Razorpay webhook ${event.event ?? "?"} had no usable order/payment pair — nothing settled.`
      );
    }
    return { status: 200, body: { ok: true, ignored: target.reason } };
  }

  const supabase = deps?.supabase ?? createServiceClient();
  const settle = deps?.settle ?? settleOrder;

  // Already completed? Skip the gateway round-trips. A miss here is never
  // wrong — it just means the work runs again, and the work is idempotent.
  if (req.eventId) {
    const { data: seen } = await supabase
      .from("razorpay_webhook_events")
      .select("event_id")
      .eq("event_id", req.eventId)
      .maybeSingle();
    if (seen) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
  }

  let result: SettlementResult;
  try {
    result = await settle({
      razorpayOrderId: target.razorpayOrderId,
      razorpayPaymentId: target.razorpayPaymentId,
    });
  } catch (e) {
    console.error(`Webhook settlement threw for ${target.razorpayOrderId}:`, e);
    return { status: 500, body: { error: "settlement failed" } };
  }
  if (!result.ok) {
    // Nothing was recorded. Ask for the retry rather than pretend.
    console.error(`Webhook settlement could not record ${target.razorpayOrderId}.`);
    return { status: 500, body: { error: "settlement not recorded" } };
  }

  // Done. Record the delivery so a repeat can be answered without the work.
  //
  // If that record cannot be written, say so with a 500 rather than claim it
  // was. The settlement is already in the database, so the re-delivery this
  // provokes is harmless — it runs the same idempotent work and tries the
  // record again — and a table that stays broken surfaces as the 24-hour
  // failure alert instead of being hidden behind a false 200.
  //
  // 23505 is the one benign failure: a concurrent delivery of the same event
  // finished first. Both did the same idempotent work; both may say so.
  if (req.eventId) {
    const { error } = await supabase
      .from("razorpay_webhook_events")
      .insert({ event_id: req.eventId, event_type: event.event ?? null });
    if (error && error.code !== "23505") {
      console.error(`Could not record webhook event ${req.eventId}: ${error.message}`);
      return { status: 500, body: { error: "event not recorded" } };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      settled: true,
      stock: result.stock,
      orphan: result.orphan,
    },
  };
}
