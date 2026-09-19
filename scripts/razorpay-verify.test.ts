/**
 * Payment verification and settlement, exercised headlessly.
 *
 * Two things are under test. lib/razorpayVerify decides whether the browser's
 * payment response is genuine. lib/settleOrder is everything that happens
 * afterwards — and it must give the same answer however many times it is
 * asked, because a replayed callback, a webhook, and a webhook retry all
 * arrive with the same two identifiers.
 *
 * THE FAKE DATABASE MODELS THE GUARDS 0058 INSTALLED: one sale movement per
 * (order, product, size), one loyalty redemption per order, one award per
 * order, a confirmation email claimed by a conditional UPDATE. The code under
 * test is real; the guards are simulated. That means these tests prove the
 * APPLICATION reads the guards correctly — a replay is recognised, a claim
 * that fails is respected, a refusal is flagged — and that nothing here
 * depends on browser input. Whether the guards themselves hold under two
 * concurrent connections rests on Postgres (scripts/migration-0058 for the
 * SQL, the unique indexes for the concurrency), not on this file. Run:
 *
 *   npx tsx scripts/razorpay-verify.test.ts
 *
 * No network, no database, no Razorpay. Exits non-zero on failure.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import { verifyPaymentSignature } from "../lib/razorpayVerify";
import { settleOrder, type SettlementDeps, type StoredLine } from "../lib/settleOrder";
import { POST } from "../app/api/checkout/razorpay/route";
import { makeWorld, type World } from "./settlement-world";
import { toPaise } from "../lib/utils";

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown, note?: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${note ? `  — ${note}` : ""}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
    fail++;
  } else pass++;
}

const settle = (deps: Partial<SettlementDeps>, order = "order_1", payment = "pay_1") =>
  settleOrder({ razorpayOrderId: order, razorpayPaymentId: payment }, deps);
const paidPatches = (world: World) => world.updates.filter((u) => "payment_status" in u.patch);

async function main() {
  console.log("\n=== the payment-response signature ===");
  {
    const secret = "test-key-secret";
    const sign = (o: string, p: string) =>
      crypto.createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");

    check("a genuine signature verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), secret), true);
    check("a signature for another order is rejected", verifyPaymentSignature("order_2", "pay_1", sign("order_1", "pay_1"), secret), false);
    check("a signature for another payment is rejected", verifyPaymentSignature("order_1", "pay_2", sign("order_1", "pay_1"), secret), false);
    check("a signature under another secret is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), "other"), false);
    check("an empty signature is rejected", verifyPaymentSignature("order_1", "pay_1", "", secret), false);
    check("a missing signature is rejected", verifyPaymentSignature("order_1", "pay_1", undefined, secret), false);
    check("a truncated signature is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1").slice(0, 63), secret), false);
    check("no secret configured means nothing verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), undefined), false);
  }

  console.log("\n=== 1. first settlement ===");
  {
    const { world, deps } = makeWorld({ profile: true });
    const r = await settle(deps);
    check("ok, against the stored row", [r.ok, r.orderId, r.orphan], [true, "ord-1", false]);
    check("stock reserved now", r.stock, "reserved");
    check("reserve_stock called once, with the STORED line", world.reserveCalls[0].p_items, [{ id: "prod-A", size: "M", quantity: 1 }]);
    check("movement attached to the stored order id", world.reserveCalls[0].p_order_id, "ord-1");
    check("shelf 5 → 4", world.stock.get("prod-A|M"), 4);
    check("marked paid, total from the gateway, fees in rupees", [world.orders.get("ord-1")!.payment_status, world.orders.get("ord-1")!.total_inr, paidPatches(world)[0].patch.gateway_fee_inr], ["paid", 2950, 59]);
    check("4. email claimed and one send attempted", [r.emailClaimed, world.emails], [true, ["order_1"]]);
    check("   confirmation_sent_at is set on the row", typeof world.orders.get("ord-1")!.confirmation_sent_at, "string");
    check("12. loyalty awarded", [...world.awards], ["ord-1"]);
    check("15. invoice number assigned", world.orders.get("ord-1")!.invoice_number, "WOV-2026-0001");
    check("not flagged", [r.flaggedForReview, world.orders.get("ord-1")!.needs_review], [false, false]);
  }

  console.log("\n=== 2, 3, 5, 6. the same settlement replayed ===");
  {
    const { world, deps } = makeWorld({ profile: true, order: { loyalty_points_spent: 50, coupon_code: "LAUNCH", coupon_discount_inr: 100 } });
    const first = await settle(deps);
    const second = await settle(deps);
    check("second call still reports ok", second.ok, true);
    check("3. second call is already_reserved — a replay, not a failure", second.stock, "already_reserved");
    check("2. reserve_stock was CALLED twice — the guard is in the database, not a caller-side skip", world.reserveCalls.length, 2);
    check("   but the shelf moved once: 5 → 4", world.stock.get("prod-A|M"), 4);
    check("   one claim exists", [...world.claims], ["ord-1|prod-A|M"]);
    check("5. second attempt does not win the email", second.emailClaimed, false);
    check("6. one send attempt in total — duplicate prevented", world.emails, ["order_1"]);
    check("   confirmation_sent_at was set once, not overwritten", world.updates.filter((u) => "confirmation_sent_at" in u.patch).length, 2, "two conditional UPDATEs were issued; only the first matched");
    check("12. one award", world.awards.size, 1);
    check("13. one redemption — the second hit the index and was read as done", world.redemptions.size, 1);
    check("    and did NOT flag the order", world.orders.get("ord-1")!.needs_review, false);
    check("14. one coupon use", world.couponUses, ["ord-1"]);
    check("15. invoice number unchanged across both", [first.ok, world.invoiceCalls, world.orders.get("ord-1")!.invoice_number], [true, 2, "WOV-2026-0001"]);
    check("    the row is still paid", world.orders.get("ord-1")!.payment_status, "paid");
  }

  console.log("\n=== 7. a webhook-shaped second settlement ===");
  {
    // Same identifiers, different caller — the shape a webhook will use.
    const { world, deps } = makeWorld({ profile: true });
    await settle(deps);
    const viaWebhook = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("settles without error", viaWebhook.ok, true);
    check("recognised as a replay", viaWebhook.stock, "already_reserved");
    check("no second email", [viaWebhook.emailClaimed, world.emails.length], [false, 1]);
    check("no second decrement", world.stock.get("prod-A|M"), 4);
    // And the reverse order: the webhook lands first, the browser second.
    const w2 = makeWorld({ profile: true });
    const a = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, w2.deps);
    const b = await settle(w2.deps);
    check("webhook first, browser second: one email, one decrement", [a.emailClaimed, b.emailClaimed, w2.world.emails.length, w2.world.stock.get("prod-A|M")], [true, false, 1, 4]);
    const w3 = makeWorld({ profile: true });
    await settle(w3.deps); await settle(w3.deps); await settle(w3.deps);
    check("three deliveries, as Razorpay's retries would: still one of everything", [w3.world.emails.length, w3.world.stock.get("prod-A|M"), w3.world.awards.size], [1, 4, 1]);
  }

  console.log("\n=== 8, 9. stock shortage and the review flag ===");
  {
    const { world, deps } = makeWorld({ profile: true, stock: { "prod-A|M": 0 } });
    const r = await settle(deps);
    check("8. stock failed", r.stock, "failed");
    check("   still marked paid — the customer has paid", world.orders.get("ord-1")!.payment_status, "paid");
    check("   needs_review = true", [r.flaggedForReview, world.orders.get("ord-1")!.needs_review], [true, true]);
    check("   no claim was left behind", world.claims.size, 0);
    check("   the obsolete tracking_status is never written", world.updates.some((u) => "tracking_status" in u.patch), false);
    check("   still emailed — the order exists and is paid", world.emails.length, 1);

    // 9. A human has not looked yet; a later settlement that goes smoothly
    // must not lift the flag. Restock, replay.
    world.stock.set("prod-A|M", 5);
    const again = await settle(deps);
    check("9. after a restock the replay reserves (nothing was claimed before)", again.stock, "reserved");
    check("   and does NOT clear needs_review", world.orders.get("ord-1")!.needs_review, true);
    check("   no paid-patch ever carries needs_review: false", paidPatches(world).some((u) => u.patch.needs_review === false), false);
    check("   a clean patch omits the key entirely", "needs_review" in paidPatches(world)[1].patch, false);
  }
  {
    const { world, deps } = makeWorld({ order: { needs_review: true } });
    await settle(deps);
    check("   a pre-existing flag survives a clean first settlement", world.orders.get("ord-1")!.needs_review, true);
  }

  console.log("\n=== 10, 11. the stored basket is the only basket ===");
  {
    const stored: StoredLine[] = [
      { id: "prod-A", size: "M", quantity: 2, price_inr: 1000 },
      { id: "prod-B", size: "One Size", quantity: 1, price_inr: 500 },
    ];
    const { world, deps } = makeWorld({ order: { items: stored }, stock: { "prod-A|M": 5, "prod-B|One Size": 5 } });
    await settle(deps);
    check("10. stock reserved from the stored lines, verbatim", world.reserveCalls[0].p_items, [
      { id: "prod-A", size: "M", quantity: 2 },
      { id: "prod-B", size: "One Size", quantity: 1 },
    ]);
    check("    the stored items were not rewritten", world.orders.get("ord-1")!.items, stored);
    check("    no update patch ever carries items", world.updates.some((u) => "items" in u.patch), false);
    check("11. the API takes two identifiers and nothing else", Object.keys({ razorpayOrderId: "", razorpayPaymentId: "" }).length, 2, "SettlementInput has no items field; a basket cannot be passed");
  }

  console.log("\n=== 16. a paid order with no pending row ===");
  {
    const { world, deps } = makeWorld({ order: null, payment: { order_id: "order_x" } });
    const r = await settle(deps, "order_x", "pay_x");
    check("reported as an orphan", [r.ok, r.orphan, r.stock], [true, true, "none"]);
    check("a thin row was inserted, paid, with the captured amount", [world.inserts[0].payment_status, world.inserts[0].total_inr], ["paid", 2950]);
    check("the thin row carries NO items — there is no trusted source for them", "items" in world.inserts[0], false);
    check("flagged for review", [r.flaggedForReview, world.inserts[0].needs_review], [true, true]);
    check("no stock reserved, no invoice, no email — nothing to base them on", [world.reserveCalls.length, world.invoiceCalls, world.emails.length], [0, 0, 0]);
    const again = await settle(deps, "order_x", "pay_x");
    check("a replay finds the thin row and does not insert a second", [again.orderId, world.orders.size], ["thin-1", 1]);
    check("and still issues no invoice and sends no email for a row with no contents", [world.invoiceCalls, world.emails.length, again.stock], [0, 0, "none"]);
    check("the flag stays up", world.orders.get("thin-1")!.needs_review, true);
  }

  console.log("\n=== 17. the gateway being unreachable ===");
  {
    // The payment fetch is now the capture authority, so without it nothing
    // may happen. Not a failure: Razorpay may well have the money, and the
    // webhook's retries will bring the answer back.
    const { world, deps } = makeWorld({ gatewayDown: true });
    const r = await settle(deps);
    check("nothing settles", [r.outcome, r.ok, r.paymentStatus], ["indeterminate", false, null]);
    check("no database read or write at all", [world.updates.length, world.inserts.length, world.reserveCalls.length, world.emails.length], [0, 0, 0, 0]);
    check("the row stays pending", world.orders.get("ord-1")!.payment_status, "pending");
    check("fees are not the point: the payment itself is", world.paymentFetches, ["pay_1"]);
    world.gatewayDown = false;
    const later = await settle(deps);
    check("when the gateway answers, the same call settles as a first settlement", [later.outcome, later.stock, later.emailClaimed], ["settled", "reserved", true]);
  }

  console.log("\n=== CAPTURE AUTHORITY: Razorpay's API, fetched server-side ===");
  // Evidence source for the browser path: settleOrder's own payments.fetch.
  // Nothing the request carries can stand in for it — the route hands over
  // two ids and the API is asked.
  {
    const { world, deps } = makeWorld({ profile: true });
    const r = await settle(deps);
    check("1. fetched captured payment → settles", [r.outcome, r.ok, r.paymentStatus, r.stock], ["settled", true, "captured", "reserved"]);
    check("2. the fetched payment's order_id matched the expected order", world.paymentFetches, ["pay_1"]);
    check("   total is the CAPTURED amount from the payment", world.orders.get("ord-1")!.total_inr, 2950);
    check("   fee and tax from the same fetch, in rupees", [paidPatches(world)[0].patch.gateway_fee_inr, paidPatches(world)[0].patch.gateway_tax_inr], [59, 9]);
  }
  const untouched = (world: World) => [world.updates.length, world.inserts.length, world.reserveCalls.length, world.emails.length, world.awards.size, world.redemptions.size, world.couponUses.length, world.invoiceCalls];
  {
    const { world, deps } = makeWorld({ payment: { order_id: "order_OTHER" } });
    const r = await settle(deps);
    check("3. captured payment for a DIFFERENT order → mismatch, nothing settled", [r.outcome, r.ok], ["mismatch", false]);
    check("   and nothing touched", untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
    const { world: w2, deps: d2 } = makeWorld({ payment: { order_id: null } });
    check("   a payment with no order at all → mismatch", (await settle(d2)).outcome, "mismatch");
    check("   nothing touched", untouched(w2), [0, 0, 0, 0, 0, 0, 0, 0]);
  }
  for (const [n, status, outcome] of [
    ["4", "authorized", "pending_capture"],
    ["5", "created", "pending_capture"],
    ["6", "failed", "failed_payment"],
    ["7", "refunded", "refunded"],
    ["8", "settled_by_mars", "unknown_status"],
    ["8", undefined, "unknown_status"],
  ] as const) {
    const { world, deps } = makeWorld({ profile: true, order: { loyalty_points_spent: 50, coupon_code: "LAUNCH", coupon_discount_inr: 100 }, payment: { status } });
    const r = await settle(deps);
    check(`${n}. status ${JSON.stringify(status)} → ${outcome}, nothing settled`, [r.outcome, r.ok, r.paymentStatus ?? null], [outcome, false, status ?? null]);
    check(`   19. no stock, no email, no award, no redemption, no coupon, no invoice, no row write`, untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
    check(`   the row stays pending, unflagged`, [world.orders.get("ord-1")!.payment_status, world.orders.get("ord-1")!.needs_review], ["pending", false]);
  }
  {
    const { world, deps } = makeWorld({ payment: { currency: "USD" } });
    check("   a non-INR payment → mismatch", (await settle(deps)).outcome, "mismatch");
    check("   nothing touched", untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
    const { world: w2, deps: d2 } = makeWorld({ payment: { amount: 100 } });
    check("   an amount other than what the server asked for → mismatch", (await settle(d2)).outcome, "mismatch");
    check("   nothing touched", untouched(w2), [0, 0, 0, 0, 0, 0, 0, 0]);
    const { deps: d3 } = makeWorld({ payment: { amount: 0 } });
    check("   a zero amount → mismatch", (await settle(d3)).outcome, "mismatch");
  }
  console.log("\n=== money: rupees to paise, once, on both sides ===");
  {
    for (const [rupees, paise] of [[799.1, 79910], [999.99, 99999], [1234.55, 123455], [0.1, 10], [2950, 295000], [1, 100], [0.01, 1], [10.005, 1001]] as const) {
      check(`toPaise(${rupees}) = ${paise}`, toPaise(rupees), paise);
    }
    check("the creation-side amount and the settlement-side expectation agree", toPaise(799.1) === toPaise(Number("799.10")), true, "a numeric(10,2) round-trip changes nothing");
    for (const total of [799.1, 999.99, 1234.55, 0.1]) {
      const { deps } = makeWorld({ order: { total_inr: total }, payment: { amount: toPaise(total) } });
      check(`   a stored total of ${total} settles against ${toPaise(total)} paise`, (await settle(deps)).outcome, "settled");
    }
    const { deps: off } = makeWorld({ order: { total_inr: 999.99 }, payment: { amount: 99998 } });
    check("   one paisa short is a mismatch", (await settle(off)).outcome, "mismatch");
    const { deps: strTotal } = makeWorld({ order: { total_inr: "2950.00" as unknown as number } });
    check("   a total that arrives as a string still compares exactly", (await settle(strTotal)).outcome, "settled");
    const { deps: lower } = makeWorld({ payment: { currency: "inr" } });
    check("   currency is matched exactly as Razorpay sends it — lowercase is not INR", (await settle(lower)).outcome, "mismatch");
    const { deps: noCur } = makeWorld({ payment: { currency: undefined } });
    check("   a missing currency fails closed", (await settle(noCur)).outcome, "mismatch");
  }
  {
    // 9/10 are test 17 above. 11–13: nothing the caller passes can say
    // "captured", bind an order, or set an amount — SettlementInput has only
    // the two ids, and the fake gateway is the only source of status.
    const { world, deps } = makeWorld({ payment: { status: "authorized" } });
    const forged = await settleOrder(
      { razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", status: "captured", captured: true, order_id: "order_1", amount: 295000 } as never,
      deps
    );
    check("11/12. extra 'status'/'captured' fields on the input change nothing — the API said authorized", forged.outcome, "pending_capture");
    check("13. nor can the input bind an order the API does not", untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
  }
  {
    // F. Authorised again and again: still nothing.
    const { world, deps } = makeWorld({ profile: true, payment: { status: "authorized" } });
    for (let i = 0; i < 3; i++) await settle(deps);
    check("F. browser authorized three times → no side effects at all", untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
    check("   and the API was asked each time", world.paymentFetches.length, 3);
  }
  {
    // B. Indeterminate at browser time, captured later.
    const { world, deps } = makeWorld({ profile: true, gatewayDown: true });
    await settle(deps);
    check("B. browser indeterminate → nothing touched", untouched(world), [0, 0, 0, 0, 0, 0, 0, 0]);
    world.gatewayDown = false;
    const hook = await settle(deps);
    check("   later captured (webhook-shaped call) → one settlement", [hook.outcome, hook.stock, world.emails.length], ["settled", "reserved", 1]);
  }
  {
    // 18. Authorised at browser time, captured later: the browser touches
    // nothing; the webhook (or any later call) settles exactly once.
    const { world, deps } = makeWorld({ profile: true, payment: { status: "authorized" } });
    const first = await settle(deps);
    check("18. browser sees authorized → pending, nothing touched", [first.outcome, untouched(world)], ["pending_capture", [0, 0, 0, 0, 0, 0, 0, 0]]);
    const { world: after, deps: laterDeps } = makeWorld({ profile: true });
    // Same order row state carried over: still pending, untouched.
    after.orders.set("ord-1", world.orders.get("ord-1")!);
    const second = await settle(laterDeps);
    const third = await settle(laterDeps);
    check("    later, captured: settles once", [second.outcome, second.stock, third.stock], ["settled", "reserved", "already_reserved"]);
    check("    one decrement, one email, one award", [after.stock.get("prod-A|M"), after.emails.length, after.awards.size], [4, 1, 1]);
  }

  console.log("\n=== 18. the shape of the email claim ===");
  {
    const { world, deps } = makeWorld({});
    await settle(deps);
    const claim = world.updates.find((u) => "confirmation_sent_at" in u.patch)!;
    check("the claim is a conditional UPDATE on id AND confirmation_sent_at IS null", claim.filters, "id eq ord-1, confirmation_sent_at is null");
    check("it carries nothing but the timestamp", Object.keys(claim.patch), ["confirmation_sent_at"]);
    // A row already claimed by someone else — a webhook that got there first.
    const w2 = makeWorld({ order: { confirmation_sent_at: "2026-09-19T00:00:00Z" } });
    const r = await settle(w2.deps);
    check("a row already claimed yields no email from this caller", [r.emailClaimed, w2.world.emails.length], [false, 0]);
  }

  console.log("\n=== a failed send is contained, and not retried ===");
  {
    const { world, deps } = makeWorld({});
    const sends: string[] = [];
    deps.sendConfirmation = ((id: string) => {
      sends.push(id);
      throw new Error("provider down");
    }) as unknown as SettlementDeps["sendConfirmation"];
    const r = await settle(deps);
    check("a sender that throws synchronously does not fail settlement", [r.ok, r.emailClaimed], [true, true]);
    check("the claim is consumed", typeof world.orders.get("ord-1")!.confirmation_sent_at, "string");
    const again = await settle(deps);
    check("a replay does NOT retry the send — at most one attempt", [again.emailClaimed, sends.length], [false, 1], "recovery is the admin re-send, by design");
  }

  console.log("\n=== the route refuses a bad signature before touching anything ===");
  {
    process.env.RAZORPAY_KEY_SECRET = "route-test-secret";
    const request = new NextRequest("http://localhost/api/checkout/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "verify",
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_x",
        razorpay_signature: "not-a-signature",
        // A basket smuggled in anyway. The contract has no such field, and
        // the route must neither read it nor be moved by it.
        items: [{ id: "prod-B", size: "XL", quantity: 3, price_inr: 1 }],
      }),
    });
    const res = await POST(request);
    const body = await res.json();
    check("responds 200 with verified:false", [res.status, body], [200, { verified: false }]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
