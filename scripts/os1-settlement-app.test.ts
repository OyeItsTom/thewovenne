/**
 * OS-1 (WP-ORDER-SAFETY-02), application side: the real settleOrder, webhook
 * handler and checkout hold logic, against the settlement-world fake and FAKE
 * Razorpay payment objects. settle_razorpay_payment is MODELLED in the fake;
 * scripts/os1-settlement.test.ts proves the real function in PostgreSQL.
 *
 *   npx tsx scripts/os1-settlement-app.test.ts
 *
 * No network, no database, no Razorpay. Exits non-zero on failure.
 */
import crypto from "node:crypto";
import { settleOrder } from "../lib/settleOrder";
import { handleRazorpayWebhook, type WebhookDeps } from "../lib/razorpayWebhook";
import { HOLD_COPY, resolvePaymentOutcome, parseHoldState } from "../lib/paymentOutcome";
import { makeWorld } from "./settlement-world";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
  if (ok) pass++;
  else fail++;
}
const tick = () => new Promise((r) => setTimeout(r, 20));

const SECRET = "whsec_test_only";
const body = (paymentId = "pay_1") =>
  JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: "order_1", status: "captured", amount: 295000, currency: "INR" } } },
  });
const request = (raw: string, eventId: string) => ({
  rawBody: raw,
  signature: crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex"),
  eventId,
  secret: SECRET,
});

async function main() {
  console.log("\n=== settleOrder: payment captured after cancellation (D5) ===");
  {
    const { world, deps } = makeWorld({ order: { status: "cancelled" }, profile: true });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    await tick();
    const row = world.orders.get("ord-1")!;
    check("outcome order_cancelled, not ok, flagged", [r.outcome, r.ok, r.flaggedForReview, r.stock, r.emailClaimed], ["order_cancelled", false, true, "none", false]);
    check("order stays cancelled and unpaid; flagged; no invoice", [row.status, row.payment_status, row.needs_review, row.invoice_number], ["cancelled", "pending", true, null]);
    check("no stock, invoice call, email, points, coupon or analytics-relevant write", [world.reserveCalls.length, world.invoiceCalls, world.emails.length, world.awards.size, world.redemptions.size, world.couponUses.length], [0, 0, 0, 0, 0, 0]);
    check("one obligation with the captured amount", [...world.obligations.values()].map((o) => [o.razorpay_payment_id, o.amount_paise, o.reason, o.state]), [["pay_1", 295000, "captured_after_cancellation", "owed"]]);
    check("the payment was fetched from Razorpay first (the only capture authority)", world.paymentFetches, ["pay_1"]);
    check("evidence passed to the database is Razorpay's, not the request's", world.settleCalls.map((c) => [c.p_amount_paise, c.p_currency, c.p_fee_paise, c.p_tax_paise, c.p_provider_status]), [[295000, "INR", 5900, 900, "captured"]]);
    const again = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("a repeat: same outcome, not re-flagged by this call, one obligation seen twice", [again.outcome, again.flaggedForReview, [...world.obligations.values()].map((o) => o.times_seen)], ["order_cancelled", false, [2]]);
  }

  console.log("\n=== settleOrder: cancelled order, captured amount differs from the order ===");
  {
    const { world, deps } = makeWorld({ order: { status: "cancelled" }, payment: { amount: 300000 } });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("still recorded as owed (not dropped as a mismatch), with the captured amount", [r.outcome, [...world.obligations.values()].map((o) => o.amount_paise)], ["order_cancelled", [300000]]);
    const open = makeWorld({ payment: { amount: 300000 } });
    const r2 = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, open.deps);
    check("an OPEN order with a different amount is still a mismatch, nothing touched", [r2.outcome, open.world.updates.length, open.world.reserveCalls.length, open.world.obligations.size], ["mismatch", 0, 0, 0]);
  }

  console.log("\n=== settleOrder: replay for a paid order cancelled afterwards (D6) ===");
  {
    const { world, deps } = makeWorld({ order: { status: "cancelled", payment_status: "paid", razorpay_payment_id: "pay_1", invoice_number: "WOV-2026-0009" } });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("order_cancelled, nothing reserved, no obligation, invoice untouched", [r.outcome, world.reserveCalls.length, world.obligations.size, world.orders.get("ord-1")!.invoice_number, world.emails.length], ["order_cancelled", 0, 0, "WOV-2026-0009", 0]);
  }

  console.log("\n=== settleOrder: a normal payment is unchanged ===");
  {
    const { world, deps } = makeWorld({ profile: true });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    await tick();
    const row = world.orders.get("ord-1")!;
    check("settled, reserved, email claimed, not flagged", [r.outcome, r.ok, r.stock, r.emailClaimed, r.flaggedForReview], ["settled", true, "reserved", true, false]);
    check("paid, payment id, invoice, one email, points awarded", [row.payment_status, row.razorpay_payment_id, row.invoice_number, world.emails.length, world.awards.size], ["paid", "pay_1", "WOV-2026-0001", 1, 1]);
    const second = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_2" }, deps);
    check("a different second payment on the paid order: order_cancelled path (refund owed), nothing re-done", [second.outcome, world.obligations.get("pay_2")?.reason, world.reserveCalls.length, world.emails.length], ["order_cancelled", "second_payment", 1, 1]);
  }

  console.log("\n=== settleOrder: the database call fails ===");
  {
    const { world, deps } = makeWorld({});
    const rpc = (deps.supabase as unknown as { rpc: (f: string, a: unknown) => Promise<unknown> }).rpc;
    (deps.supabase as unknown as { rpc: unknown }).rpc = async (f: string, a: unknown) =>
      f === "settle_razorpay_payment" ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } } : rpc(f, a);
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("not recorded: outcome 'unrecorded' (never 'settled'), nothing else attempted",
      [r.outcome, r.ok, r.emailClaimed, world.invoiceCalls, world.emails.length, world.orders.get("ord-1")!.payment_status], ["unrecorded", false, false, 0, 0, "pending"]);
    check("…the browser is held (not success, not 'payment failed', no pay button)",
      resolvePaymentOutcome({ verified: true, outcome: r.outcome, recorded: r.ok }), { action: "hold", state: "unrecorded" });
  }
  {
    // Loyalty: points the customer chose to spend must not move before the payment is recorded.
    const { world, deps } = makeWorld({ order: { loyalty_points_spent: 400 }, profile: true });
    const rpc = (deps.supabase as unknown as { rpc: (f: string, a: unknown) => Promise<unknown> }).rpc;
    (deps.supabase as unknown as { rpc: unknown }).rpc = async (f: string, a: unknown) =>
      f === "settle_razorpay_payment" ? { data: null, error: { code: "08006", message: "connection failure" } } : rpc(f, a);
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("database failure: no points redeemed or awarded", [r.outcome, world.redemptions.size, world.awards.size], ["unrecorded", 0, 0]);
    (deps.supabase as unknown as { rpc: unknown }).rpc = rpc;
    const again = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    await tick();
    check("the retry records it and only then moves points (once)", [again.outcome, again.ok, world.redemptions.size, world.awards.size], ["settled", true, 1, 1]);
  }
  {
    // The pending row vanished between the read and the lock: also unrecorded, not settled.
    const { world, deps } = makeWorld({});
    const rpc = (deps.supabase as unknown as { rpc: (f: string, a: unknown) => Promise<unknown> }).rpc;
    (deps.supabase as unknown as { rpc: unknown }).rpc = async (f: string, a: unknown) =>
      f === "settle_razorpay_payment" ? { data: { path: "no_order" }, error: null } : rpc(f, a);
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("row vanished under the lock → unrecorded", [r.outcome, r.ok, world.emails.length], ["unrecorded", false, 0]);
  }
  {
    // Orphan path whose insert also fails → unrecorded.
    const { deps } = makeWorld({ order: null });
    const sb = deps.supabase as unknown as { from: (t: string) => unknown };
    const from = sb.from.bind(sb);
    sb.from = (t: string) => {
      const q = from(t) as { insert: unknown };
      if (t === "orders") q.insert = () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "08006", message: "down" } }) }) });
      return q;
    };
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("no pending row and the thin row cannot be written → unrecorded", [r.outcome, r.ok, r.orphan], ["unrecorded", false, true]);
  }

  console.log("\n=== webhook ===");
  {
    const { world, deps } = makeWorld({ order: { status: "cancelled" } });
    const wdeps: Partial<WebhookDeps> = {
      supabase: deps.supabase as WebhookDeps["supabase"],
      settle: (input) => settleOrder(input, deps),
    };
    const r = await handleRazorpayWebhook(request(body(), "evt_a"), wdeps);
    check("captured event for a cancelled order → 200, not settled, outcome order_cancelled", [r.status, r.body.settled, r.body.outcome], [200, false, "order_cancelled"]);
    check("…the obligation is recorded before the 200", world.obligations.size, 1);
    const r2 = await handleRazorpayWebhook(request(body(), "evt_b"), wdeps);
    check("a delayed duplicate (new event id) → 200 again, same obligation", [r2.status, [...world.obligations.values()][0].times_seen], [200, 2]);
    const failing = makeWorld({ order: { status: "cancelled" } });
    (failing.deps.supabase as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { code: "08006", message: "connection failure" } });
    const r3 = await handleRazorpayWebhook(request(body(), "evt_c"), {
      supabase: failing.deps.supabase as WebhookDeps["supabase"],
      settle: (input) => settleOrder(input, failing.deps),
    });
    check("database down → 500 so Razorpay retries (nothing silently dropped)", [r3.status, failing.world.webhookEvents.size], [500, 0]);
    const down = makeWorld({ order: { status: "cancelled" }, gatewayDown: true });
    const r4 = await handleRazorpayWebhook(request(body(), "evt_d"), {
      supabase: down.deps.supabase as WebhookDeps["supabase"],
      settle: (input) => settleOrder(input, down.deps),
    });
    check("Razorpay API timeout → 500 deferred, nothing recorded", [r4.status, down.world.obligations.size, down.world.settleCalls.length], [500, 0, 0]);
    const ambiguous = makeWorld({ order: { status: "cancelled" }, payment: { status: "authorized" } });
    const r5 = await handleRazorpayWebhook(request(body(), "evt_e"), {
      supabase: ambiguous.deps.supabase as WebhookDeps["supabase"],
      settle: (input) => settleOrder(input, ambiguous.deps),
    });
    check("API says authorized (ambiguous) → 500 deferred, no obligation yet", [r5.status, ambiguous.world.obligations.size], [500, 0]);
  }

  console.log("\n=== checkout page ===");
  {
    check("verify outcome order_cancelled → hold page, never success or retry", resolvePaymentOutcome({ verified: true, outcome: "order_cancelled" }), { action: "hold", state: "order_cancelled" });
    check("the hold state round-trips through the URL", parseHoldState("order_cancelled"), "order_cancelled");
    const copy = HOLD_COPY.order_cancelled;
    const text = `${copy.title} ${copy.body} ${copy.next}`;
    check("copy is the owner-approved message, word for word", [copy.title, copy.body, copy.next], ["Your order was already cancelled when we received your payment.", "Your order will not be dispatched, and a full refund is due. Our team will review the payment and arrange the refund. Please do not make another payment for this order.", "If you need assistance, please contact Wovenne."]);
    check("copy tells them not to pay again", /do not make another payment/i.test(text), true);
    const u = HOLD_COPY.unrecorded;
    const ut = `${u.title} ${u.body} ${u.next}`;
    check("unrecorded copy: tells them not to pay again", /do not make another payment/i.test(ut), true);
    check("unrecorded copy: claims neither success nor failure, nor dispatch", /\b(success|successful|confirmed order|has been placed|failed|was not taken|dispatch(ed)? (soon|today)|on its way)\b/i.test(ut), false);
    check("copy never says a refund was made, started or when it lands", /refunded|refund (has|was) been|within \d|working days|on its way/i.test(text), false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
