/**
 * Webhook authenticity and event routing.
 *
 * These are the decisions that stand between "Razorpay says this order is paid"
 * and the database believing it. Getting any of them wrong is either a payment
 * that never records or an endpoint anyone can forge into marking orders paid,
 * so they are tested against the three details Razorpay's documentation is
 * explicit about: raw body, webhook secret, constant-time compare.
 *
 *   npx tsx scripts/razorpay-webhook.test.ts
 *
 * WHAT THIS DOES NOT COVER: that stock moves exactly once. That guarantee lives
 * in a partial unique index (0058) and cannot be demonstrated without a
 * database — see scripts/settlement-idempotency.test.ts for what is provable
 * here and OWNER TESTING in the PR for what is not.
 *
 * Exits non-zero on failure.
 */
import crypto from "crypto";
import {
  verifyWebhookSignature,
  settlementTarget,
  SETTLING_EVENTS,
} from "../lib/razorpayWebhook";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note && ok ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

const SECRET = "whsec_test_2f8c1a";
const OTHER_SECRET = "whsec_test_rotated";
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body).digest("hex");

const body = JSON.stringify({
  event: "payment.captured",
  payload: {
    payment: { entity: { id: "pay_ABC123", order_id: "order_XYZ789" } },
  },
});

console.log("\n=== signature verification ===");

check("a genuine signature verifies", verifyWebhookSignature(body, sign(body), SECRET), true);

check(
  "a tampered body is rejected",
  verifyWebhookSignature(body.replace("pay_ABC123", "pay_EVIL999"), sign(body), SECRET),
  false,
  "the amount or ids cannot be edited in flight"
);

check(
  "a signature from a different secret is rejected",
  verifyWebhookSignature(body, sign(body, OTHER_SECRET), SECRET),
  false,
  "guards against pointing this at the API key secret by mistake"
);

check("an empty signature is rejected", verifyWebhookSignature(body, "", SECRET), false);
check("a null signature is rejected", verifyWebhookSignature(body, null, SECRET), false);

check(
  "a missing secret rejects rather than accepting everything",
  verifyWebhookSignature(body, sign(body), ""),
  false,
  "an unset env var must never mean 'allow'"
);

check(
  "a short signature is rejected without throwing",
  verifyWebhookSignature(body, "abc", SECRET),
  false,
  "timingSafeEqual throws on unequal lengths — the length test has to come first"
);

check(
  "a signature of the right length but wrong value is rejected",
  verifyWebhookSignature(body, "0".repeat(64), SECRET),
  false
);

console.log("\n=== the raw body is what gets hashed ===");

// Razorpay: "Do not parse or cast the webhook request body." A JSON round-trip
// is the exact mistake that instruction is warning about — it reorders keys and
// drops whitespace, and the digest moves with it.
const reordered = JSON.stringify(JSON.parse(body), ["payload", "event"]);
check(
  "a re-serialised body does not verify against the original signature",
  verifyWebhookSignature(reordered, sign(body), SECRET),
  false,
  "proves the route must use .text(), never .json()"
);

const spaced = JSON.stringify(JSON.parse(body), null, 2);
check(
  "whitespace changes break the signature",
  verifyWebhookSignature(spaced, sign(body), SECRET),
  false
);

check(
  "the same bytes always verify",
  verifyWebhookSignature(body, sign(body), SECRET) &&
    verifyWebhookSignature(body, sign(body), SECRET),
  true,
  "verification has no state and is safe to repeat"
);

console.log("\n=== which events settle ===");

check("payment.captured settles", settlementTarget(JSON.parse(body)).settle, true);

check(
  "order.paid settles when a payment entity is present",
  settlementTarget({
    event: "order.paid",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
  }),
  { settle: true, razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }
);

check(
  "both documented capture events are handled",
  [...SETTLING_EVENTS].sort(),
  ["order.paid", "payment.captured"]
);

check(
  "payment.authorized does NOT settle",
  settlementTarget({
    event: "payment.authorized",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
  }),
  { settle: false, reason: "ignored event payment.authorized" },
  "authorised is not captured — money has not moved"
);

check(
  "payment.failed does NOT settle",
  settlementTarget({
    event: "payment.failed",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
  }),
  { settle: false, reason: "ignored event payment.failed" },
  "an unsuccessful payment must never create a paid order"
);

check(
  "refund.processed does NOT settle",
  settlementTarget({
    event: "refund.processed",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1" } } },
  }),
  { settle: false, reason: "ignored event refund.processed" }
);

check(
  "an event with no type is declined",
  settlementTarget({}),
  { settle: false, reason: "no event type" }
);

console.log("\n=== the payload must identify both halves ===");

check(
  "order.paid with no payment entity is declined",
  settlementTarget({ event: "order.paid", payload: { order: { entity: { id: "order_1" } } } }),
  { settle: false, reason: "incomplete payload" },
  "an order id alone cannot say which payment paid it"
);

check(
  "a payment with no order_id is declined",
  settlementTarget({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_1" } } },
  }),
  { settle: false, reason: "incomplete payload" }
);

check(
  "an empty payload is declined",
  settlementTarget({ event: "payment.captured" }),
  { settle: false, reason: "incomplete payload" }
);

check(
  "the order id comes from the payment entity, not the order entity, when both exist",
  settlementTarget({
    event: "payment.captured",
    payload: {
      payment: { entity: { id: "pay_1", order_id: "order_FROM_PAYMENT" } },
      order: { entity: { id: "order_FROM_ORDER" } },
    },
  }),
  { settle: true, razorpayOrderId: "order_FROM_PAYMENT", razorpayPaymentId: "pay_1" },
  "the payment's own view of which order it paid is the authoritative one"
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
