/**
 * The Razorpay webhook, exercised headlessly.
 *
 * Three layers. The signature helper and settlementTarget are pure and are
 * tested as such. handleRazorpayWebhook is the whole decision from raw bytes
 * to an HTTP status, and is driven with a stub settle to pin the status
 * contract — then with the REAL settleOrder over the shared fake database to
 * prove that a delivery repeated, a payment reported twice under two event
 * ids, or a webhook landing before or after the browser, all leave one
 * decrement and one email. The Next route is a thin adapter over the handler
 * and is exercised once with a real request.
 *
 * The crash window is tested directly: a settlement that dies half way leaves
 * no event row, so the retry does the work. That property is the reason the
 * event row is written AFTER settlement and never before. Run:
 *
 *   npx tsx scripts/razorpay-webhook.test.ts
 *
 * No network, no database, no Razorpay. Exits non-zero on failure.
 */
import crypto from "crypto";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import {
  handleRazorpayWebhook,
  settlementTarget,
  verifyWebhookSignature,
  type WebhookDeps,
} from "../lib/razorpayWebhook";
import { settleOrder, type SettlementResult } from "../lib/settleOrder";
import { POST } from "../app/api/checkout/razorpay/webhook/route";
import { makeWorld } from "./settlement-world";

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

const SECRET = "whsec_test_only";
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

/** A payment.captured event as Razorpay's payloads documentation shows it. */
const captured = (over: Record<string, unknown> = {}, event = "payment.captured") =>
  JSON.stringify({
    entity: "event",
    account_id: "acc_test",
    event,
    contains: ["payment"],
    payload: {
      payment: {
        entity: {
          id: "pay_1",
          entity: "payment",
          amount: 295000,
          currency: "INR",
          status: "captured",
          order_id: "order_1",
          captured: true,
          method: "upi",
          email: "someone@example.com",
          contact: "+910000000000",
          notes: { basket: "ignored" },
          ...over,
        },
      },
    },
    created_at: 1758300000,
  });

/** An order.paid event: both entities, per the orders payloads page. */
const orderPaid = JSON.stringify({
  entity: "event",
  event: "order.paid",
  contains: ["payment", "order"],
  payload: {
    payment: { entity: { id: "pay_1", order_id: "order_1", status: "captured", captured: true } },
    order: { entity: { id: "order_1", status: "paid", amount: 295000, amount_paid: 295000 } },
  },
});

/** A handler call with a stub settle that records what it was given. */
function stubDeps(settleResult: Partial<SettlementResult> | Error = {}, opts: { insertFails?: boolean } = {}) {
  const calls: unknown[] = [];
  const events = new Map<string, string | null>();
  const deps: Partial<WebhookDeps> = {
    settle: async (input) => {
      calls.push(input);
      if (settleResult instanceof Error) throw settleResult;
      return {
        outcome: "settled", paymentStatus: "captured",
        ok: true, orderId: "ord-1", orphan: false, stock: "reserved", emailClaimed: true, flaggedForReview: false,
        ...settleResult,
      };
    },
    supabase: {
      from: (table: string) => {
        if (table !== "razorpay_webhook_events") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => ({ data: events.has(id) ? { event_id: id } : null, error: null }),
            }),
          }),
          insert: async (row: { event_id: string; event_type: string | null }) => {
            if (opts.insertFails) return { error: { code: "42501", message: "permission denied" } };
            if (events.has(row.event_id)) return { error: { code: "23505", message: "pkey" } };
            events.set(row.event_id, row.event_type);
            return { error: null };
          },
        };
      },
    } as unknown as WebhookDeps["supabase"],
  };
  return { deps, calls, events };
}

const request = (rawBody: string, over: Partial<Parameters<typeof handleRazorpayWebhook>[0]> = {}) => ({
  rawBody,
  signature: sign(rawBody),
  eventId: "evt_1",
  secret: SECRET,
  ...over,
});

async function main() {
  console.log("\n=== SIGNATURE ===");
  {
    const body = captured();
    check("1. a genuine signature verifies", verifyWebhookSignature(body, sign(body), SECRET), true);
    check("2. the wrong secret is rejected", verifyWebhookSignature(body, sign(body, "other"), SECRET), false);
    check("   the API key secret is not the webhook secret", verifyWebhookSignature(body, sign(body, "rzp_key_secret"), SECRET), false);
    check("3. an altered body is rejected", verifyWebhookSignature(body.replace("295000", "1"), sign(body), SECRET), false);
    check("4. an empty signature is rejected", verifyWebhookSignature(body, "", SECRET), false);
    check("5. a missing signature is rejected", verifyWebhookSignature(body, null, SECRET), false);
    check("6. a malformed (short) signature is rejected", verifyWebhookSignature(body, "abc", SECRET), false);
    check("   a malformed (long) signature is rejected", verifyWebhookSignature(body, sign(body) + "00", SECRET), false);
    check("   a same-length wrong signature is rejected", verifyWebhookSignature(body, "f".repeat(64), SECRET), false);
    check("   no secret means nothing verifies", verifyWebhookSignature(body, sign(body), undefined), false);
    check("   an empty secret means nothing verifies", verifyWebhookSignature(body, sign(body), ""), false);
    // 7. RAW, not re-serialised. Pretty-print the same JSON: same object,
    // different bytes, different digest. A verifier that parsed first would
    // accept the second body with the first body's signature.
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    check("7. the same JSON with different whitespace does NOT verify under the compact signature", verifyWebhookSignature(pretty, sign(body), SECRET), false);
    check("   but verifies under its own — the raw bytes are what is signed", verifyWebhookSignature(pretty, sign(pretty), SECRET), true);
    check("   unicode in the body is signed as UTF-8", verifyWebhookSignature(captured({ email: "साड़ी@example.com" }), sign(captured({ email: "साड़ी@example.com" })), SECRET), true);
  }

  console.log("\n=== EVENT EXTRACTION ===");
  {
    check("8. payment.captured → both ids", settlementTarget(JSON.parse(captured())), { settle: true, razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" });
    check("9. order.paid → both ids, from the payment entity", settlementTarget(JSON.parse(orderPaid)), { settle: true, razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" });
    check("   order.paid with no payment entity → nothing to settle (needs the payment id)", settlementTarget({ event: "order.paid", payload: { order: { entity: { id: "order_1" } } } }), { settle: false, reason: "incomplete payload" });
    check("10. payment.authorized is NOT settled — authorised is not captured", settlementTarget(JSON.parse(captured({ status: "authorized", captured: false }, "payment.authorized"))), { settle: false, reason: "ignored event payment.authorized" });
    check("    payment.failed is ignored", settlementTarget({ event: "payment.failed" }).settle, false);
    check("    refund.processed is ignored", settlementTarget({ event: "refund.processed" }).settle, false);
    check("    no event type", settlementTarget({}), { settle: false, reason: "no event type" });
    check("11. missing order id → no settlement", settlementTarget(JSON.parse(captured({ order_id: undefined }))), { settle: false, reason: "incomplete payload" });
    check("12. missing payment id → no settlement", settlementTarget(JSON.parse(captured({ id: undefined }))), { settle: false, reason: "incomplete payload" });
    check("    a payment.captured whose entity is not captured is left alone", settlementTarget(JSON.parse(captured({ status: "authorized" }))).settle, false);
    check("    nothing but the two ids comes out", Object.keys(settlementTarget(JSON.parse(captured()))).sort(), ["razorpayOrderId", "razorpayPaymentId", "settle"]);
  }

  console.log("\n=== ROUTE (handler with a stub settle) ===");
  {
    const bad = stubDeps();
    const r = await handleRazorpayWebhook(request(captured(), { signature: "not-a-signature" }), bad.deps);
    check("13. invalid signature → 400", r.status, 400);
    check("    no settlement, no event row", [bad.calls.length, bad.events.size], [0, 0]);
    check("    the response carries no secret and no body", JSON.stringify(r.body).includes(SECRET) || JSON.stringify(r.body).includes("pay_1"), false);

    const noSecret = stubDeps();
    const r2 = await handleRazorpayWebhook(request(captured(), { secret: undefined }), noSecret.deps);
    check("14. missing secret → 500, fail closed (Razorpay will retry until it is set)", r2.status, 500);
    check("    and touches nothing", [noSecret.calls.length, noSecret.events.size], [0, 0]);
    const emptySecret = await handleRazorpayWebhook(request(captured(), { secret: "" }), stubDeps().deps);
    check("    empty secret is the same as missing", emptySecret.status, 500);

    const unsupported = stubDeps();
    const body = captured({ status: "authorized", captured: false }, "payment.authorized");
    const r3 = await handleRazorpayWebhook(request(body), unsupported.deps);
    check("15. valid unsupported event → 200, acknowledged", [r3.status, r3.body.ignored], [200, "ignored event payment.authorized"]);
    check("    no settlement", unsupported.calls.length, 0);
    check("    no event row either — nothing was done for it", unsupported.events.size, 0);

    const good = stubDeps();
    const r4 = await handleRazorpayWebhook(request(captured()), good.deps);
    check("16. valid supported event → settleOrder exactly once", good.calls.length, 1);
    check("    with the two gateway identifiers and NOTHING else", good.calls[0], { razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" });
    check("    200 settled", [r4.status, r4.body.ok, r4.body.settled], [200, true, true]);
    check("    event row recorded AFTER settlement", [...good.events.keys()], ["evt_1"]);

    const thrown = stubDeps(new Error("database unreachable"));
    const r5 = await handleRazorpayWebhook(request(captured()), thrown.deps);
    check("17. settleOrder throws → 500 so Razorpay retries", r5.status, 500);
    check("    no event row — the retry must not be mistaken for a duplicate", thrown.events.size, 0);
    check("    the error text is generic", r5.body, { error: "settlement failed" });

    const notRecorded = stubDeps({ ok: false, orderId: null });
    const r6 = await handleRazorpayWebhook(request(captured()), notRecorded.deps);
    check("    settleOrder ok:false → 500, not a false success", r6.status, 500);
    check("    and no event row", notRecorded.events.size, 0);

    // What settleOrder's own API fetch says wins over what the event said.
    for (const [outcome, status, expect] of [
      ["indeterminate", null, 500],
      ["pending_capture", "authorized", 500],
      ["failed_payment", "failed", 500],
      ["unknown_status", "weird", 500],
      ["refunded", "refunded", 200],
      ["mismatch", "captured", 200],
    ] as const) {
      const d = stubDeps({ ok: false, outcome, paymentStatus: status, orderId: null, stock: "none", emailClaimed: false });
      const r = await handleRazorpayWebhook(request(captured()), d.deps);
      check(`    API says ${outcome} → ${expect}${expect === 500 ? " (contradiction or unknown: retry)" : " (later state or permanent: acknowledged, not settled)"}`, [r.status, r.body.settled ?? null, d.events.size], [expect, expect === 200 ? false : null, 0]);
    }

    const malformed = stubDeps();
    const junk = "{not json";
    const r7 = await handleRazorpayWebhook(request(junk), malformed.deps);
    check("18. verified but unparseable → 200 ignored (a retry would be identical bytes)", [r7.status, r7.body.ignored], [200, "unparseable"]);
    const r8 = await handleRazorpayWebhook(request(captured({ order_id: undefined })), malformed.deps);
    check("    verified but missing ids → 200 ignored", [r8.status, r8.body.ignored], [200, "incomplete payload"]);
    const r9 = await handleRazorpayWebhook(request("null"), malformed.deps);
    check("    verified JSON null → 200 ignored", r9.status, 200);
    check("    none of those settled", malformed.calls.length, 0);

    const noId = stubDeps();
    const r10 = await handleRazorpayWebhook(request(captured(), { eventId: null }), noId.deps);
    check("    no event-id header → still settles (idempotency is settleOrder's), records nothing", [r10.status, noId.calls.length, noId.events.size], [200, 1, 0]);
    const emptyId = stubDeps();
    const r11 = await handleRazorpayWebhook(request(captured(), { eventId: "" }), emptyId.deps);
    check("    empty event-id header is treated the same", [r11.status, emptyId.calls.length, emptyId.events.size], [200, 1, 0]);
    const r12 = await handleRazorpayWebhook(request(captured(), { eventId: null }), noId.deps);
    check("    and a re-delivery without an id settles again rather than being refused", [r12.status, noId.calls.length], [200, 2]);

    const recordFails = stubDeps({}, { insertFails: true });
    const r13 = await handleRazorpayWebhook(request(captured()), recordFails.deps);
    check("    settled but the event row cannot be written → 500, not a false claim", [r13.status, r13.body], [500, { error: "event not recorded" }]);
    check("    the settlement itself still happened", recordFails.calls.length, 1);
    const r14 = await handleRazorpayWebhook(request(captured()), recordFails.deps);
    check("    the re-delivery settles again (idempotently) and tries the record again", [r14.status, recordFails.calls.length], [500, 2]);
  }

  console.log("\n=== IDEMPOTENCY / DELIVERY (real settleOrder over the fake database) ===");
  const realDeps = (world: ReturnType<typeof makeWorld>) => ({
    supabase: world.deps.supabase as WebhookDeps["supabase"],
    settle: (input: { razorpayOrderId: string; razorpayPaymentId: string }) => settleOrder(input, world.deps),
  });
  {
    const w = makeWorld({ profile: true });
    const deps = realDeps(w);
    const first = await handleRazorpayWebhook(request(captured()), deps);
    const second = await handleRazorpayWebhook(request(captured()), deps);
    check("19. first delivery settles", [first.status, first.body.settled, first.body.stock], [200, true, "reserved"]);
    check("    second delivery of the same event id → 200 duplicate, without touching the gateway", [second.status, second.body.duplicate, w.world.reserveCalls.length], [200, true, 1]);
    check("    one decrement, one email, one award", [w.world.stock.get("prod-A|M"), w.world.emails.length, w.world.awards.size], [4, 1, 1]);
    check("    one event row", [...w.world.webhookEvents.keys()], ["evt_1"]);
  }
  {
    const w = makeWorld({ profile: true });
    const deps = realDeps(w);
    const a = await handleRazorpayWebhook(request(captured(), { eventId: "evt_captured" }), deps);
    const b = await handleRazorpayWebhook(request(orderPaid, { eventId: "evt_order_paid" }), deps);
    check("20. payment.captured then order.paid — two event ids, one payment", [a.body.stock, b.body.stock], ["reserved", "already_reserved"]);
    check("    both acknowledged 200", [a.status, b.status], [200, 200]);
    check("    one decrement, one email", [w.world.stock.get("prod-A|M"), w.world.emails.length], [4, 1]);
    check("    both events recorded as done", [...w.world.webhookEvents.keys()], ["evt_captured", "evt_order_paid"]);
  }
  {
    const w = makeWorld({ profile: true });
    const browser = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, w.deps);
    const hook = await handleRazorpayWebhook(request(captured()), realDeps(w));
    check("21. browser first, webhook second: webhook sees a replay", [browser.stock, hook.body.stock], ["reserved", "already_reserved"]);
    check("    one decrement, one email, and the browser won the email", [w.world.stock.get("prod-A|M"), w.world.emails.length, browser.emailClaimed], [4, 1, true]);
  }
  {
    const w = makeWorld({ profile: true });
    const hook = await handleRazorpayWebhook(request(captured()), realDeps(w));
    const browser = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, w.deps);
    check("22. webhook first, browser second: browser sees a replay", [hook.body.stock, browser.stock], ["reserved", "already_reserved"]);
    check("    one decrement, one email, and the webhook won the email", [w.world.stock.get("prod-A|M"), w.world.emails.length, browser.emailClaimed], [4, 1, false]);
  }
  {
    // A paid order nobody created a pending row for: the webhook records a
    // thin flagged row and acknowledges — the money is on record, a human
    // reconciles the goods.
    const w = makeWorld({ order: null, profile: false, payment: { order_id: "order_x" } });
    const r = await handleRazorpayWebhook(request(captured({ order_id: "order_x", id: "pay_x" })), realDeps(w));
    check("    an orphan payment is recorded thin, flagged, and acknowledged", [r.status, r.body.orphan, w.world.inserts[0]?.needs_review, "items" in (w.world.inserts[0] ?? {})], [200, true, true, false]);
  }

  {
    // Two copies of the SAME event at once: both SELECTs miss, both settle,
    // one INSERT wins and the other gets 23505. Interleaved by starting both
    // before either awaits, so neither sees the other's completion record.
    const w = makeWorld({ profile: true, order: { loyalty_points_spent: 50, coupon_code: "LAUNCH", coupon_discount_inr: 100 } });
    const deps = realDeps(w);
    const [a, b] = await Promise.all([
      handleRazorpayWebhook(request(captured()), deps),
      handleRazorpayWebhook(request(captured()), deps),
    ]);
    check("    two concurrent copies of one event: both acknowledged", [a.status, b.status], [200, 200]);
    check("    neither was answered from the completion record (both did the work)", [a.body.duplicate, b.body.duplicate], [undefined, undefined]);
    check("    one decrement, one email attempt, one award, one redemption, one coupon use, one invoice", [
      w.world.stock.get("prod-A|M"), w.world.emails.length, w.world.awards.size, w.world.redemptions.size, w.world.couponUses.length, w.world.orders.get("ord-1")!.invoice_number,
    ], [4, 1, 1, 1, 1, "WOV-2026-0001"]);
    check("    one completion record", w.world.webhookEvents.size, 1);
  }

  console.log("\n=== CAPTURE AUTHORITY on the webhook path ===");
  // Evidence source: the verified event is the TRIGGER; settleOrder's own
  // payments.fetch is the authority, same as the browser path.
  {
    const w = makeWorld({ profile: true, payment: { status: "authorized" } });
    const r = await handleRazorpayWebhook(request(captured()), realDeps(w));
    check("event says captured but the API says authorized → 500 deferred, nothing touched", [r.status, w.world.reserveCalls.length, w.world.emails.length, w.world.webhookEvents.size], [500, 0, 0, 0]);
    check("the API was asked", w.world.paymentFetches, ["pay_1"]);
    w.world.gatewayDown = false;
    // Razorpay later captures; the retry finds it captured.
    (w.deps.gateway as { payments: { fetch: (id: string) => Promise<unknown> } }).payments.fetch = async (id: string) => ({
      id, order_id: "order_1", status: "captured", captured: true, amount: 295000, currency: "INR", fee: 5900, tax: 900,
    });
    const retry = await handleRazorpayWebhook(request(captured()), realDeps(w));
    check("18. the retry after capture settles exactly once", [retry.status, retry.body.stock, w.world.stock.get("prod-A|M"), w.world.emails.length], [200, "reserved", 4, 1]);
  }
  {
    const w = makeWorld({ profile: true, payment: { order_id: "order_OTHER" } });
    const r = await handleRazorpayWebhook(request(captured()), realDeps(w));
    check("event's ids do not match the API's binding → 200 not settled, nothing touched", [r.status, r.body.settled, r.body.outcome, w.world.reserveCalls.length], [200, false, "mismatch", 0]);
  }
  {
    const w = makeWorld({ profile: true, gatewayDown: true });
    const r = await handleRazorpayWebhook(request(captured()), realDeps(w));
    check("API unreachable → 500 deferred, nothing touched, no event row", [r.status, w.world.updates.length, w.world.webhookEvents.size], [500, 0, 0]);
  }

  console.log("\n=== CRASH WINDOW ===");
  {
    // 23. The settlement dies half way — after stock came out, before the
    // rest. No event row exists, so the retry is not mistaken for a
    // duplicate; it runs settleOrder again, which finishes the job
    // idempotently: stock already claimed, email now claimed.
    const w = makeWorld({ profile: true });
    let crashOnce = true;
    const deps = {
      supabase: w.deps.supabase as WebhookDeps["supabase"],
      settle: async (input: { razorpayOrderId: string; razorpayPaymentId: string }) => {
        if (crashOnce) {
          crashOnce = false;
          // Simulate dying after the stock claim: do that part for real, then throw.
          await w.deps.supabase!.rpc("reserve_stock", {
            p_items: [{ id: "prod-A", size: "M", quantity: 1 }],
            p_order_id: "ord-1",
          });
          throw new Error("process died");
        }
        return settleOrder(input, w.deps);
      },
    };
    const crashed = await handleRazorpayWebhook(request(captured()), deps);
    check("23. the crashed delivery answers 500 — Razorpay will retry", crashed.status, 500);
    check("    stock had already come out", w.world.stock.get("prod-A|M"), 4);
    check("    but NO event row was written — the table holds completions, never claims", w.world.webhookEvents.size, 0);
    check("    and the order is still pending, unemailed", [w.world.orders.get("ord-1")!.payment_status, w.world.emails.length], ["pending", 0]);
    const retry = await handleRazorpayWebhook(request(captured()), deps);
    check("    the retry is NOT treated as a duplicate", retry.body.duplicate, undefined);
    check("    it settles: stock already reserved, order paid, email sent", [retry.status, retry.body.stock, w.world.orders.get("ord-1")!.payment_status, w.world.emails.length], [200, "already_reserved", "paid", 1]);
    check("    no second decrement", w.world.stock.get("prod-A|M"), 4);
    check("    only now is the event recorded", [...w.world.webhookEvents.keys()], ["evt_1"]);
  }
  {
    // Structural: in the source, the insert into razorpay_webhook_events
    // comes AFTER the settle call, and nothing inserts before it.
    const src = fs.readFileSync(path.join(__dirname, "../lib/razorpayWebhook.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function handleRazorpayWebhook"));
    const iSettle = fn.indexOf("await settle(");
    const iInsert = fn.indexOf(".insert({ event_id");
    const iSelect = fn.indexOf('.select("event_id")');
    check("    structurally: the event row is inserted after settlement", iSettle > 0 && iInsert > iSettle, true);
    check("    structurally: the pre-settlement read is a select, never an insert", iSelect > 0 && iSelect < iSettle, true);
    check("    structurally: exactly one insert into the events table", (fn.match(/\.insert\(/g) ?? []).length, 1);
  }

  console.log("\n=== SECURITY ===");
  {
    const src = fs.readFileSync(path.join(__dirname, "../lib/razorpayWebhook.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function handleRazorpayWebhook"));
    check("signature is checked before JSON.parse", fn.indexOf("verifyWebhookSignature(") < fn.indexOf("JSON.parse("), true);
    check("the raw body is never logged", /console\.(error|log|warn)\([^)]*rawBody/.test(fn), false);
    check("the signature is never logged", /console\.(error|log|warn)\([^)]*req\.signature/.test(fn), false);
    check("the secret is never logged or returned", /console\.(error|log|warn)\([^)]*secret\b/.test(fn) || /body: \{[^}]*secret/.test(fn), false);
    // A payload that tries to smuggle a basket and a customer: settleOrder
    // receives only the ids, and the recorded order keeps its stored lines.
    const w = makeWorld({});
    const smuggled = captured({
      notes: { items: [{ id: "prod-B", quantity: 99 }] },
      email: "attacker@example.com",
      amount: 1,
    });
    const r = await handleRazorpayWebhook(request(smuggled), realDeps(w));
    check("a payload cannot inject a basket: stock reserved from the STORED line", [r.status, w.world.reserveCalls[0].p_items], [200, [{ id: "prod-A", size: "M", quantity: 1 }]]);
    check("nor choose the customer: the stored email is untouched", w.world.orders.get("ord-1")!.customer_email, "a@b.c");
    check("nor the amount: total is what the gateway API reports", w.world.orders.get("ord-1")!.total_inr, 2950);
    const routeSrc = fs
      .readFileSync(path.join(__dirname, "../app/api/checkout/razorpay/webhook/route.ts"), "utf8")
      .replace(/^\s*\/\/.*$/gm, "");
    check("the route reads the RAW text, not request.json()", routeSrc.includes("request.text()") && !routeSrc.includes("request.json()"), true);
    check("the route runs on Node with caching disabled", routeSrc.includes('runtime = "nodejs"') && routeSrc.includes('dynamic = "force-dynamic"'), true);
    check("the events table is written with the service client (RLS + grants keep anon out — see migration-0058 tests)", src.includes("createServiceClient()"), true);
  }

  console.log("\n=== the Next route, end to end ===");
  {
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    const body = captured();
    const bad = await POST(new NextRequest("http://localhost/api/checkout/razorpay/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "nope", "x-razorpay-event-id": "evt_route" },
      body,
    }));
    check("a bad signature is a 400 from the real route", [bad.status, await bad.json()], [400, { error: "Invalid signature" }]);
    const ignored = await POST(new NextRequest("http://localhost/api/checkout/razorpay/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": sign(captured({}, "payment.failed")) },
      body: captured({}, "payment.failed"),
    }));
    check("an ignored event is a 200 from the real route, with no database configured", [ignored.status, (await ignored.json()).ignored], [200, "ignored event payment.failed"]);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const unset = await POST(new NextRequest("http://localhost/api/checkout/razorpay/webhook", {
      method: "POST",
      headers: { "x-razorpay-signature": sign(body) },
      body,
    }));
    check("no secret configured is a 500 from the real route", unset.status, 500);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
