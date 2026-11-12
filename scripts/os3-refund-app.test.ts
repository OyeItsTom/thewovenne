/**
 * OS-3 (WP-ORDER-SAFETY-10), application side: the real lib/refundLedger,
 * lib/razorpayWebhook and lib/paymentReconciliation against a FAKE Razorpay
 * and the REAL 0080 functions in a throwaway PostgreSQL 17.6.
 *
 *   VERIFY   ask-and-record: success, not found, timeout, 5xx, unknown status,
 *            wrong id in the answer, database down, unconfigured mode.
 *   WEBHOOK  signed refund.* events: record, replay, payload mismatch, bad
 *            signature, provider down, not found, uncaptured auto-refund.
 *   RECON    captured-but-unrecorded, unknown order, amount mismatch, refund
 *            not in ledger, pagination, provider failure + resume, malformed
 *            items, reruns, and proof that nothing but reads reached Razorpay
 *            and nothing but discrepancies changed in Wovenne.
 *   STATIC   no code path in the app can create a Razorpay refund.
 *
 *   PG_HARNESS_DIR=<pgh> npx tsx scripts/os3-refund-app.test.ts
 *
 * No network, no credentials, no Production.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asRoot, startEngine, type Client } from "./pg-world";
import {
  cancelPaid, cancelUnpaid, enrolApprover, fakeRazorpay, ledgerFor, obligationsOf, openDiscrepancies, osWorld, paidOrder,
  pgRpc, placeOrder, rid, settle, type FakeRazorpay,
} from "./os3-world";
import { providerModeFromKey, verifyAndRecordRefund, type RefundLedgerDeps } from "../lib/refundLedger";
import { handleRazorpayWebhook, type WebhookDeps } from "../lib/razorpayWebhook";
import { classifyCaptured, runReconciliation, type ReconcileDeps } from "../lib/paymentReconciliation";
import { closeTestModeObligation, type TestModeDeps } from "../lib/refundClosure";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const SECRET = "whsec_test_only_os3";
function signed(body: object, eventId: string | null) {
  const raw = JSON.stringify(body);
  return { rawBody: raw, signature: crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex"), eventId, secret: SECRET };
}
function refundEvent(type: string, refund: { id: string; payment_id: string; amount: number; currency?: string; status: string }, captured = true) {
  return {
    entity: "event", account_id: "acc_TEST", event: type, contains: ["refund", "payment"],
    payload: {
      refund: { entity: { entity: "refund", currency: "INR", ...refund } },
      payment: { entity: { id: refund.payment_id, captured } },
    },
    created_at: 1762600000,
  };
}

/** razorpay_webhook_events through the real table, as service_role. */
function eventsTable(c: Client) {
  return {
    from(table: string) {
      if (table !== "razorpay_webhook_events") throw new Error(`unexpected table ${table}`);
      let id: string | null = null;
      const q = {
        select() { return q; },
        eq(_col: string, v: string) { id = v; return q; },
        async maybeSingle() {
          const r = await c.query("select event_id from razorpay_webhook_events where event_id = $1", [id]);
          return { data: r.rows[0] ?? null, error: null };
        },
        async insert(row: { event_id: string; event_type: string | null }) {
          try {
            await c.query("set role service_role");
            await c.query("insert into razorpay_webhook_events (event_id, event_type) values ($1, $2)", [row.event_id, row.event_type]);
            return { error: null };
          } catch (e) {
            return { error: { code: (e as { code?: string }).code, message: (e as Error).message } };
          } finally {
            await asRoot(c);
          }
        },
      };
      return q;
    },
  } as unknown as WebhookDeps["supabase"];
}

function addRefund(f: FakeRazorpay, o: { pay: string; rzp: string; totalPaise: number }, amount: number, status = "processed", id = rid("rfnd")) {
  f.refunds.set(id, { id, entity: "refund", amount, currency: "INR", payment_id: o.pay, created_at: 1762600000, status, speed_processed: "normal" });
  const prev = f.payments.get(o.pay);
  f.payments.set(o.pay, {
    id: o.pay, amount: o.totalPaise, currency: "INR", status: "captured", captured: true, order_id: o.rzp,
    amount_refunded: ((prev?.amount_refunded as number | undefined) ?? 0) + amount, created_at: prev?.created_at,
  });
  return id;
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIP: embedded-postgres not available (set PG_HARNESS_DIR)");
    process.exit(2);
  }
  try {
    await engine.database("app");
    const w = await osWorld(engine, "app");
    const c = w.root;
    const rpcConn = await engine.connect("app");
    const rpc = pgRpc(rpcConn);
    const f = fakeRazorpay();
    const ledger = (over: Partial<RefundLedgerDeps> = {}): RefundLedgerDeps => ({ provider: f.provider, rpc, mode: "test", timeoutMs: 200, ...over });

    console.log("\n=== VERIFY: mode comes from the server's key, never the request ===");
    check("rzp_live_ → live, rzp_test_ → test, anything else → null",
      [providerModeFromKey("rzp_live_abc"), providerModeFromKey("rzp_test_abc"), providerModeFromKey("rzp_placeholder"), providerModeFromKey(undefined)],
      ["live", "test", null, null]);

    console.log("\n=== VERIFY: ask Razorpay, record its answer ===");
    const o1 = await paidOrder(c, w);
    await cancelPaid(c, w, o1.id);
    const R1 = addRefund(f, o1, 259900, "pending");
    let v = await verifyAndRecordRefund(R1, { source: "admin_verify", actor: w.admin }, ledger());
    check("pending recorded", v.ok && [v.outcome, v.status], ["recorded", "pending"]);
    check("Razorpay was asked for the refund, then its payment", f.calls.slice(-2), [`GET refund ${R1}`, `GET payment ${o1.pay}`]);
    f.refunds.get(R1)!.status = "processed";
    v = await verifyAndRecordRefund(R1, { source: "admin_verify", actor: w.admin }, ledger());
    check("processed recorded; ledger outstanding 0", [v.ok && v.status, n((await ledgerFor(c, o1.pay)).outstanding_paise)], ["processed", 0]);

    console.log("\n=== VERIFY: failures write nothing ===");
    const count = async () => Number((await c.query("select count(*) n from payment_refunds")).rows[0].n);
    const events = async () => Number((await c.query("select count(*) n from payment_refund_events")).rows[0].n);
    const o2 = await paidOrder(c, w);
    await cancelPaid(c, w, o2.id);
    const R2 = addRefund(f, o2, 100000);
    let before = [await count(), await events()];
    f.failNext = ["timeout"];
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("timeout → indeterminate, nothing written", [v.ok, !v.ok && v.kind, await count(), await events()], [false, "indeterminate", ...before]);
    f.failNext = ["500"];
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("Razorpay 5xx → indeterminate, nothing written", [!v.ok && v.kind, await count()], ["indeterminate", before[0]]);
    f.failNext = [];
    f.refunds.get(R2)!.status = "reversed";
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("an unknown refund status → invalid, nothing written", [!v.ok && v.kind, await count()], ["invalid", before[0]]);
    f.refunds.get(R2)!.status = "processed";
    f.refunds.get(R2)!.id = rid("rfnd");
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("Razorpay answers with a different id → invalid", [!v.ok && v.kind], ["invalid"]);
    f.refunds.get(R2)!.id = R2;
    f.refunds.get(R2)!.amount = 100000.5;
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("a non-integer amount → invalid", [!v.ok && v.kind], ["invalid"]);
    f.refunds.get(R2)!.amount = 100000;
    f.failNext = [];
    const realPay = f.payments.get(o2.pay)!;
    f.payments.set(o2.pay, { ...realPay, captured: "yes" as unknown as boolean });
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("a malformed payment → invalid", [!v.ok && v.kind, await count()], ["invalid", before[0]]);
    f.payments.set(o2.pay, realPay);
    const down = async () => ({ data: null, error: { message: "connection refused", code: "08006" } });
    v = await verifyAndRecordRefund(R2, { source: "webhook" }, ledger({ rpc: down }));
    check("database down → unrecorded", [!v.ok && v.kind, await count()], ["unrecorded", before[0]]);
    const callsBefore = f.calls.length;
    v = await verifyAndRecordRefund(R2, { source: "webhook" }, ledger({ mode: null }));
    check("unconfigured mode → refused before asking Razorpay", [!v.ok && v.kind, f.calls.length], ["unconfigured", callsBefore]);
    v = await verifyAndRecordRefund("rfnd_bad id", { source: "webhook" }, ledger());
    check("a malformed id → refused before asking Razorpay", [!v.ok && v.kind, f.calls.length], ["bad_id", callsBefore]);
    const ghost = rid("rfnd");
    v = await verifyAndRecordRefund(ghost, { source: "admin_verify" }, ledger());
    check("Razorpay does not know the id → not_found, discrepancy recorded, no refund row",
      [!v.ok && v.kind, !v.ok && v.discrepancyRecorded, (await openDiscrepancies(c, "refund_not_found")).map((d) => d.razorpay_refund_id), await count()],
      ["not_found", true, [ghost], before[0]]);
    v = await verifyAndRecordRefund(R2, { source: "admin_verify" }, ledger());
    check("and once Razorpay answers, it records", v.ok && v.status, "processed");

    console.log("\n=== WEBHOOK: signed refund events ===");
    const wdeps = (over: Partial<RefundLedgerDeps> = {}): Partial<WebhookDeps> => ({
      supabase: eventsTable(rpcConn),
      refunds: ledger(over),
      settle: async () => { throw new Error("a refund event must never settle"); },
    });
    const o3 = await paidOrder(c, w);
    await cancelPaid(c, w, o3.id);
    const R3 = addRefund(f, o3, 259900, "processed");
    const ev1 = rid("rfnd").replace("rfnd_", "evt_");
    let out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R3, payment_id: o3.pay, amount: 259900, status: "processed" }), ev1), wdeps());
    check("refund.processed → 200, recorded processed", [out.status, out.body.refund, out.body.status], [200, "recorded", "processed"]);
    check("event id recorded after the work", Number((await c.query("select count(*) n from razorpay_webhook_events where event_id = $1", [ev1])).rows[0].n), 1);
    const callsNow = f.calls.length;
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R3, payment_id: o3.pay, amount: 259900, status: "processed" }), ev1), wdeps());
    check("replay of the same event → duplicate, Razorpay not asked", [out.status, out.body.duplicate, f.calls.length], [200, true, callsNow]);
    out = await handleRazorpayWebhook(signed(refundEvent("refund.created", { id: R3, payment_id: o3.pay, amount: 259900, status: "pending" }), rid("rfnd").replace("rfnd_", "evt_")), wdeps());
    check("refund.created arriving late (API says processed) → unchanged", [out.status, out.body.refund, out.body.status], [200, "unchanged", "processed"]);
    out = await handleRazorpayWebhook({ ...signed(refundEvent("refund.processed", { id: R3, payment_id: o3.pay, amount: 1, status: "processed" }), "evt_FORGED000001"), signature: "0".repeat(64) }, wdeps());
    check("bad signature → 400, nothing done", [out.status, Number((await c.query("select count(*) n from razorpay_webhook_events where event_id = 'evt_FORGED000001'")).rows[0].n)], [400, 0]);

    const o4 = await paidOrder(c, w);
    await cancelPaid(c, w, o4.id);
    const R4 = addRefund(f, o4, 100000, "processed");
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R4, payment_id: o4.pay, amount: 259900, status: "processed" }), rid("rfnd").replace("rfnd_", "evt_")), wdeps());
    check("payload claims 2599, API says 1000 → API amount kept, mismatch recorded",
      [out.status, n((await ledgerFor(c, o4.pay)).refunded_paise), (await openDiscrepancies(c, "webhook_payload_mismatch")).map((d) => d.razorpay_refund_id)],
      [200, 100000, [R4]]);
    check("…and exactly which discrepancies that delivery opened",
      (await openDiscrepancies(c)).filter((d) => d.razorpay_payment_id === o4.pay).map((d) => d.kind).sort(), ["webhook_payload_mismatch"]);

    const o5 = await paidOrder(c, w);
    await cancelPaid(c, w, o5.id);
    const R5 = addRefund(f, o5, 259900);
    const ev5 = "evt_PROVIDERDOWN1";
    f.failNext = ["500"];
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R5, payment_id: o5.pay, amount: 259900, status: "processed" }), ev5), wdeps());
    check("Razorpay API down → 500, event NOT recorded (retry will do the work)",
      [out.status, Number((await c.query("select count(*) n from razorpay_webhook_events where event_id = $1", [ev5])).rows[0].n), (await ledgerFor(c, o5.pay)).refunded_paise], [500, 0, "0"]);
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R5, payment_id: o5.pay, amount: 259900, status: "processed" }), ev5), wdeps());
    check("…the retry records it", [out.status, out.body.refund, n((await ledgerFor(c, o5.pay)).outstanding_paise)], [200, "recorded", 0]);
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: R5, payment_id: o5.pay, amount: 259900, status: "processed" }), "evt_DBDOWN000001"), wdeps({ rpc: down }));
    check("database down → 500", out.status, 500);
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: rid("rfnd"), payment_id: o5.pay, amount: 1, status: "processed" }), "evt_OTHERMODE001"), wdeps());
    check("a refund Razorpay cannot find in this mode → 200, recorded as a discrepancy", [out.status, out.body.refund, out.body.recorded], [200, "not_found", true]);
    const auto = { id: rid("pay"), rzp: rid("order"), totalPaise: 50000, pay: "" };
    auto.pay = auto.id;
    const RA = rid("rfnd");
    f.refunds.set(RA, { id: RA, entity: "refund", amount: 50000, currency: "INR", payment_id: auto.pay, status: "processed" });
    f.payments.set(auto.pay, { id: auto.pay, amount: 50000, currency: "INR", status: "refunded", captured: false, order_id: auto.rzp, amount_refunded: 50000 });
    out = await handleRazorpayWebhook(signed(refundEvent("refund.processed", { id: RA, payment_id: auto.pay, amount: 50000, status: "processed" }, false), "evt_AUTOREFUND01"), wdeps());
    check("automatic refund of an uncaptured payment → 200, ignored", [out.status, out.body.refund, Number((await c.query("select count(*) n from payment_refunds where razorpay_refund_id = $1", [RA])).rows[0].n)], [200, "ignored_uncaptured", 0]);
    out = await handleRazorpayWebhook(signed({ event: "refund.processed", payload: { refund: { entity: { id: "nope" } } } }, "evt_BADPAYLOAD01"), wdeps());
    check("a refund event without a usable id → 200 ignored", [out.status, out.body.ignored], [200, "incomplete refund payload"]);

    console.log("\n=== RECON: what Razorpay captured vs what Wovenne recorded ===");
    // A fixed window three days ago; every fake payment is created inside it.
    const T0 = Math.floor(Date.now() / 1000) - 3 * 86400;
    const inWindow = (i: number) => T0 + 60 * i;
    const g = fakeRazorpay();
    let ti = 0;
    const put = (id: string, rzp: string | null, amount: number, captured = true, refunded = 0) =>
      g.payments.set(id, { id, amount, currency: "INR", status: captured ? "captured" : "failed", captured, order_id: rzp, amount_refunded: refunded, created_at: inWindow(++ti) });

    const okSale = await paidOrder(c, w);                                   put(okSale.pay, okSale.rzp, okSale.totalPaise);
    const lost = await placeOrder(c, w);                                    put(lost.pay, lost.rzp, lost.totalPaise); // captured; DB never heard (OS-1 risk)
    const stranger = rid("order"), strangerPay = rid("pay");                put(strangerPay, stranger, 120000);
    const wrongAmt = await paidOrder(c, w);                                 put(wrongAmt.pay, wrongAmt.rzp, wrongAmt.totalPaise + 100);
    const refundedQuietly = await paidOrder(c, w);                          put(refundedQuietly.pay, refundedQuietly.rzp, refundedQuietly.totalPaise, true, 50000);
    const owed = await placeOrder(c, w); await cancelUnpaid(c, w, owed.id); await settle(c, owed); put(owed.pay, owed.rzp, owed.totalPaise);
    const failedPay = rid("pay");                                           put(failedPay, okSale.rzp, 1000, false);
    for (let i = 0; i < 2; i++) { const s = await paidOrder(c, w); put(s.pay, s.rzp, s.totalPaise); }

    const snap = async () => (await c.query(`select
        (select md5(string_agg(id::text || status || payment_status || coalesce(razorpay_payment_id,'') || total_inr::text || coalesce(invoice_number,''), ',' order by id)) from orders) o,
        (select count(*) from stock_movements) sm, (select count(*) from credit_notes) cn,
        (select count(*) from refund_obligations) ob, (select count(*) from payment_refunds) pr,
        (select count(*) from payment_refund_obligations) pro`)).rows[0];
    const before0 = await snap();
    const rdeps = (over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({ provider: g.lister, rpc, mode: "test", timeoutMs: 500, ...over });
    const win = { from: new Date((T0 - 60) * 1000), to: new Date((T0 + 3600) * 1000) };

    let res = await runReconciliation({ ...win, pageSize: 3, maxPages: 2, actor: w.admin }, rdeps());
    check("page budget used → incomplete, checkpoint at 6", [res.status, res.pages, res.nextSkip, res.ok], ["incomplete", 2, 6, false]);
    const firstRun = res.runId;
    res = await runReconciliation({ resumeFrom: firstRun, pageSize: 3, maxPages: 5 }, rdeps());
    check("resume finishes the window → complete", [res.status, res.ok, res.payments], ["complete", true, 3]);
    const byKind = async () => (await openDiscrepancies(c)).filter((d) => Number(d.first_run_id) === firstRun || Number(d.first_run_id) === res.runId)
      .map((d) => `${d.kind}:${d.razorpay_payment_id}`).sort();
    check("findings: the lost payment, the unknown order, the amount, the quiet refund", await byKind(), [
      `amount_mismatch:${wrongAmt.pay}`, `captured_not_recorded:${lost.pay}`, `captured_unknown_order:${strangerPay}`, `refund_not_in_ledger:${refundedQuietly.pay}`,
    ].sort());
    check("the lost payment's order is flagged for review, and stays unpaid", (await c.query("select needs_review, payment_status, status from orders where id = $1", [lost.id])).rows[0], { needs_review: true, payment_status: "pending", status: "placed" });
    const after0 = await snap();
    check("nothing settled, refunded, restocked, credited or owed by reconciliation", [after0.o === before0.o, after0.sm, after0.cn, after0.ob, after0.pr, after0.pro],
      [true, before0.sm, before0.cn, before0.ob, before0.pr, before0.pro]);
    check("Razorpay was only ever listed", [...g.touched].sort(), ["lister.listPayments"]);
    check("…and no refund or payment was fetched", g.calls.every((x) => x.startsWith("LIST payments")), true);

    const rowsBefore = Number((await c.query("select count(*) n from payment_reconciliation_discrepancies")).rows[0].n);
    res = await runReconciliation({ ...win, pageSize: 100, maxPages: 1 }, rdeps());
    check("a full rerun → complete, no new discrepancy rows, the same ones seen again",
      [res.status, Number((await c.query("select count(*) n from payment_reconciliation_discrepancies")).rows[0].n), (await c.query("select times_seen from payment_reconciliation_discrepancies where razorpay_payment_id = $1 and kind = 'captured_not_recorded'", [lost.pay])).rows[0].times_seen],
      ["complete", rowsBefore, 2]);

    g.listFailAtSkip = 3;
    res = await runReconciliation({ ...win, pageSize: 3, maxPages: 5 }, rdeps());
    check("Razorpay fails mid-way → incomplete, never complete; checkpoint kept", [res.status, res.nextSkip, res.ok], ["incomplete", 3, false]);
    res = await runReconciliation({ resumeFrom: res.runId, pageSize: 3, maxPages: 5 }, rdeps());
    check("…resumed from skip 3 to the end", [res.status, res.payments], ["complete", 6]);

    g.payments.set("broken", { id: rid("pay"), amount: "lots", currency: "INR", captured: true, created_at: inWindow(++ti) } as never);
    res = await runReconciliation({ ...win, pageSize: 100, maxPages: 1 }, rdeps());
    check("a payment without key fields → recorded, run incomplete", [res.status, (await openDiscrepancies(c, "provider_data_incomplete")).length], ["incomplete", 1]);
    g.payments.delete("broken");
    res = await runReconciliation({ resumeFrom: res.runId, pageSize: 100, maxPages: 1 }, rdeps());
    check("resuming a run with bad data re-reads the whole window", [res.status, res.payments], ["complete", 9]);
    const blank = await runReconciliation({ ...win, pageSize: 100, maxPages: 1 }, rdeps({ provider: { listPayments: async () => ({}) } }));
    check("a response without items → incomplete", blank.status, "incomplete");
    res = await runReconciliation({ ...win }, rdeps({ mode: null }));
    check("unconfigured mode → not started", res.status, "not_started");
    res = await runReconciliation({ from: new Date(Date.now() - 3600_000), to: new Date() }, rdeps());
    check("a window ending now → not started (must end 15 minutes ago)", [res.status, res.message.includes("15 minutes")], ["not_started", true]);
    const stopped = await runReconciliation({ ...win, pageSize: 3, maxPages: 3 }, rdeps({ rpc: async (fn, a) => (fn === "recon_checkpoint" ? { data: null, error: { message: "connection lost" } } : rpc(fn, a)) }));
    check("database lost mid-run → failed, resumable", [stopped.status, stopped.ok], ["failed", false]);
    check("a failed run can be resumed", (await runReconciliation({ resumeFrom: stopped.runId, pageSize: 100, maxPages: 1 }, rdeps())).status, "complete");

    console.log("\n=== RECON: classification (pure) ===");
    const facts = { orders: [{ razorpay_order_id: "order_L", id: "x", status: "confirmed", payment_status: "paid", razorpay_payment_id: null, total_paise: 1000 }], unfulfilled: [], refunds: [{ razorpay_payment_id: "pay_L", counted_paise: 500, processed_paise: 500 }] };
    check("pre-0077 paid order, same amount → nothing to report", classifyCaptured({ id: "pay_L", amount: 1000, order_id: "order_L", amount_refunded: 500, status: "captured" }, facts), []);
    check("ledger says more refunded than Razorpay → ledger_exceeds_provider",
      classifyCaptured({ id: "pay_L", amount: 1000, order_id: "order_L", amount_refunded: 0, status: "captured" }, facts).map((x) => x.kind), ["ledger_exceeds_provider"]);

    console.log("\n=== TESTMODE (WP-12): closed only on Razorpay's answer under Test keys ===");
    {
      const tm = fakeRazorpay();
      const orderPayments = new Map<string, unknown[]>();
      const tmCalls: string[] = [];
      const tdeps = (over: Partial<TestModeDeps> = {}): TestModeDeps => ({
        provider: {
          fetchPayment: (id) => { tmCalls.push(`GET payment ${id}`); return tm.provider.fetchPayment(id); },
          async fetchOrderPayments(id) {
            tmCalls.push(`GET order ${id} payments`);
            const failure = tm.failNext.shift();
            if (failure === "500") throw Object.assign(new Error("Internal"), { statusCode: 500 });
            if (failure === "404") throw Object.assign(new Error("nf"), { statusCode: 400, error: { code: "BAD_REQUEST_ERROR" } });
            return { entity: "collection", count: (orderPayments.get(id) ?? []).length, items: orderPayments.get(id) ?? [] } as never;
          },
        },
        rpc, mode: "test", timeoutMs: 200, ...over,
      });
      const why = "Pre-launch order paid with Razorpay Test keys; never real money.";
      const t = await paidOrder(c, w);
      await cancelPaid(c, w, t.id);
      const tob = (await obligationsOf(c, t.id))[0];
      const input = { obligationId: tob.id, actor: w.admin, reason: why, paymentId: t.pay as string | null, razorpayOrderId: t.rzp };
      tm.payments.set(t.pay, { id: t.pay, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: t.rzp, amount_refunded: 0 });

      let r = await closeTestModeObligation(input, tdeps({ mode: "live" }));
      check("Live keys → refused before asking Razorpay", [r.ok, !r.ok && r.kind, tmCalls.length], [false, "not_test_keys", 0]);
      r = await closeTestModeObligation(input, tdeps({ mode: null }));
      check("unknown key mode → refused", [r.ok, !r.ok && r.kind], [false, "not_test_keys"]);
      r = await closeTestModeObligation(input, tdeps());
      check("Test keys, but the actor is not an enrolled approver → database refuses", [r.ok, !r.ok && r.kind, !r.ok && r.message.includes("authorised finance approver")], [false, "refused", true]);
      await enrolApprover(c, w.admin);
      tm.failNext.push("500");
      r = await closeTestModeObligation(input, tdeps());
      check("Razorpay down → indeterminate, nothing closed", [r.ok, !r.ok && r.kind, (await obligationsOf(c, t.id))[0].closed_at], [false, "indeterminate", null]);
      tm.failNext.push("timeout");
      r = await closeTestModeObligation(input, tdeps());
      check("Razorpay hangs → indeterminate (timeout)", [r.ok, !r.ok && r.kind], [false, "indeterminate"]);
      tm.failNext.push("404");
      r = await closeTestModeObligation(input, tdeps());
      check("Test mode does not know the payment (maybe Live) → not_found, nothing closed", [r.ok, !r.ok && r.kind], [false, "not_found"]);
      tm.payments.set(t.pay, { id: t.pay, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: rid("order"), amount_refunded: 0 });
      r = await closeTestModeObligation(input, tdeps());
      check("payment on another order → refused", [r.ok, !r.ok && r.kind], [false, "refused"]);
      tm.payments.set(t.pay, { id: t.pay, amount: "259900", currency: "INR", captured: true, order_id: t.rzp } as never);
      r = await closeTestModeObligation(input, tdeps());
      check("malformed answer → invalid, nothing closed", [r.ok, !r.ok && r.kind], [false, "invalid"]);
      tm.payments.set(t.pay, { id: t.pay, amount: 259900, currency: "INR", status: "authorized", captured: false, order_id: t.rzp, amount_refunded: 0 });
      r = await closeTestModeObligation(input, tdeps());
      check("not captured → database refuses", [r.ok, !r.ok && r.kind], [false, "refused"]);
      tm.payments.set(t.pay, { id: t.pay, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: t.rzp, amount_refunded: 0 });
      r = await closeTestModeObligation(input, tdeps());
      check("captured Test-mode payment → closed", [r.ok, r.ok && r.writtenOffPaise], [true, 259900]);
      const led = await ledgerFor(c, t.pay);
      check("…ledger: closed, not refunded", [n(led.refunded_paise), n(led.written_off_paise), n(led.outstanding_paise)], [0, 259900, 0]);
      check("…only GETs were made", tmCalls.every((x) => x.startsWith("GET ")), true);

      // Pre-0077: no payment id; the order's payments decide.
      await c.query("set session_replication_role = replica");
      const lg = await placeOrder(c, w);
      await c.query("update orders set payment_status = 'paid', status = 'confirmed' where id = $1", [lg.id]);
      await c.query("set session_replication_role = origin");
      await cancelPaid(c, w, lg.id);
      const lob = (await obligationsOf(c, lg.id))[0];
      const lin = { obligationId: lob.id, actor: w.admin, reason: why, paymentId: null, razorpayOrderId: lg.rzp };
      orderPayments.set(lg.rzp, []);
      r = await closeTestModeObligation(lin, tdeps());
      check("pre-0077, no captured payment on the order → not_found", [r.ok, !r.ok && r.kind], [false, "not_found"]);
      const A = rid("pay");
      const B = rid("pay");
      orderPayments.set(lg.rzp, [
        { id: A, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: lg.rzp, amount_refunded: 0 },
        { id: B, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: lg.rzp, amount_refunded: 0 },
      ]);
      r = await closeTestModeObligation(lin, tdeps());
      check("pre-0077, two captured payments → ambiguous, nothing closed", [r.ok, !r.ok && r.kind, (await obligationsOf(c, lg.id))[0].closed_at], [false, "ambiguous", null]);
      orderPayments.set(lg.rzp, [
        { id: A, amount: 259900, currency: "INR", status: "failed", captured: false, order_id: lg.rzp, amount_refunded: 0 },
        { id: B, amount: 259900, currency: "INR", status: "captured", captured: true, order_id: lg.rzp, amount_refunded: 0 },
      ]);
      r = await closeTestModeObligation(lin, tdeps());
      const lob2 = (await obligationsOf(c, lg.id))[0];
      check("pre-0077, one captured payment → linked and closed", [r.ok, lob2.razorpay_payment_id, lob2.funds_basis, lob2.close_kind], [true, B, "razorpay_captured", "test_mode_payment"]);
    }

    console.log("\n=== STATIC: the Refunds screen uses the six agreed labels (O3-5) ===");
    {
      const ui = fs.readFileSync(path.join(process.cwd(), "components/admin/RefundsManager.tsx"), "utf8");
      const six = ["Refund owed", "Awaiting verification", "Refund pending", "Verified refunded", "Refund failed or uncertain", "Closed without verified refund"];
      check("all six labels are defined", six.filter((l) => !ui.includes(`"${l}"`)), []);
      check("the old labels are gone", ["\"Owed\"", "Refund id not yet confirmed", "Refunded (Razorpay: processed)", "Investigate — do not refund again"].filter((l) => ui.includes(l)), []);
      check("closure controls are shown only to an approver (and the database enforces it)", [ui.includes('supabase.rpc("refund_closure_authority")'), ui.includes("setCanClose(a.data === true)"), ui.includes("canClose &&")], [true, true, true]);
      check("no Test-mode option in the free-form closure", ui.includes('<option value="test_mode_payment"'), false);
    }

    console.log("\n=== STATIC: nothing in the app can create a refund ===");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(process.cwd(), "lib"));
    walk(path.join(process.cwd(), "app"));
    walk(path.join(process.cwd(), "components"));
    const offenders = files.filter((p) => /\.(refund|capture)\s*\(|refunds\.create|payments\.refund/.test(fs.readFileSync(p, "utf8")));
    const calls = files.flatMap((p) => (fs.readFileSync(p, "utf8").match(/razorpay\.(\w+)\.(\w+)\(/g) ?? []).map((m) => `${path.basename(p)}:${m}`));
    check("no refund-creating or capturing call anywhere in lib/, app/, components/", offenders.map((p) => path.relative(process.cwd(), p)), []);
    // LS-1 moved checkout's orders.create from the route into lib/checkoutCreate.
    check("every direct Razorpay SDK call: checkout's orders.create and OS-3's four reads", [...new Set(calls)].sort(), [
      "checkoutCreate.ts:razorpay.orders.create(",
      "refundProviders.ts:razorpay.orders.fetchPayments(", "refundProviders.ts:razorpay.payments.all(",
      "refundProviders.ts:razorpay.payments.fetch(", "refundProviders.ts:razorpay.refunds.fetch(",
    ]);

    await rpcConn.end();
    for (const x of [w.root, w.a, w.b]) await x.end();
  } finally {
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
