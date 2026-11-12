/**
 * OS-3 (WP-ORDER-SAFETY-10, migration 0080): refund ledger and reconciliation,
 * in the database.
 *
 *   CONTROL   0080 refuses a database without 0079; at 0079 no ledger exists.
 *   BACKFILL  a 0079 database with history (cancelled paid order, payment
 *             captured after cancellation, in-person order, pre-0077 order),
 *             then 0080 applied on top.
 *   LEDGER    obligations, claims, provider evidence, partial and multiple
 *             refunds, duplicates, replays, wrong amounts, wrong payments,
 *             failed / uncertain, uncaptured, write-offs.
 *   GUARDS    nobody edits verified evidence; permissions per role.
 *   CONCUR    the same refund twice at once; two refunds racing the cap.
 *   RECON     runs, checkpoints, completeness, discrepancy lifecycle.
 *   KEEP      OS-1 / OS-2 / OS-2b protections still hold; deletion keeps rows.
 *
 * Real PostgreSQL 17.6 (embedded, throwaway), fictional data, real roles.
 *
 *   PG_HARNESS_DIR=<pgh> npx tsx scripts/os3-refund-ledger.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, startEngine, type Client } from "./pg-world";
import {
  cancelPaid, cancelUnpaid, evidence, ledgerFor, obligationsOf, openDiscrepancies, osWorld, paidOrder,
  enrolApprover, placeOrder, rid, settle, type OsWorld,
} from "./os3-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const err = (p: Promise<unknown>) => p.then(() => "", (e) => (e as Error).message);
const has = (msg: string, part: string) => (msg.includes(part) ? `refused: ${part}` : msg === "" ? "accepted" : msg);
const M0080 = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/0080_os3_refund_ledger_reconciliation.sql"), "utf8");
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

async function claim(c: Client, w: OsWorld, obligation: string, refund: string, note: string | null = null) {
  await asAdmin(c, w.admin);
  try {
    return (await c.query("select public.admin_claim_refund($1, $2, $3) r", [obligation, refund, note])).rows[0].r;
  } finally {
    await asRoot(c);
  }
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIP: embedded-postgres not available (set PG_HARNESS_DIR)");
    process.exit(2);
  }
  console.log(engine.version);
  try {
    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== CONTROL ===");
    {
      await engine.database("ctl78", "0078");
      const c = await engine.connect("ctl78");
      check("0080 refuses a database without 0079", has(await err(c.query(M0080)), "0079"), "refused: 0079");
      await c.end();
      await engine.database("ctl79", "0079");
      const d = await engine.connect("ctl79");
      check("at 0079 there is no refund ledger", (await d.query("select to_regclass('public.refund_obligations') is null v")).rows[0].v, true);
      await d.end();
    }

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== BACKFILL: history at 0079, then 0080 ===");
    {
      await engine.database("bf", "0079");
      const w = await osWorld(engine, "bf");
      const c = w.root;
      const cancelled = await paidOrder(c, w);
      await cancelPaid(c, w, cancelled.id);
      const late = await placeOrder(c, w);
      await cancelUnpaid(c, w, late.id);
      const lateR = await settle(c, late);
      // In person: paid offline, cancelled.
      const offline = await placeOrder(c, w, 1500, "offline");
      await c.query("set session_replication_role = replica");
      await c.query("update orders set payment_status = 'paid', status = 'confirmed' where id = $1", [offline.id]);
      // Settled before 0077 kept a payment id: paid, Razorpay order, no payment id.
      const legacy = await placeOrder(c, w);
      await c.query("update orders set payment_status = 'paid', status = 'confirmed' where id = $1", [legacy.id]);
      await c.query("set session_replication_role = origin");
      await cancelPaid(c, w, offline.id);
      await cancelPaid(c, w, legacy.id);
      check("fixture: payment after cancellation was recorded as owed (0077)", lateR.path, "refund_owed");

      const before = (await c.query("select (select count(*) from credit_notes) cn, (select count(*) from payment_refund_obligations) pro")).rows[0];
      await c.query(M0080);
      const rows = (await c.query("select source, channel, origin, amount_paise, razorpay_payment_id, order_id, funds_basis from refund_obligations order by created_at")).rows;
      check("every credit note and unfulfilled payment became one obligation", rows.length, Number(before.cn) + Number(before.pro));
      check("all labelled backfill_0080", [...new Set(rows.map((r) => r.origin))], ["backfill_0080"]);
      const by = (id: string) => rows.filter((r) => r.order_id === id).map((r) => [r.source, r.channel, Number(r.amount_paise), r.razorpay_payment_id]);
      check("cancelled paid order: credit note, razorpay, full amount, its payment", by(cancelled.id), [["credit_note", "razorpay", 259900, cancelled.pay]]);
      check("payment captured after cancellation: whole payment owed", by(late.id), [["unfulfilled_payment", "razorpay", 259900, late.pay]]);
      check("in-person order: outside Razorpay, no ids", by(offline.id), [["credit_note", "outside_razorpay", 150000, null]]);
      check("pre-0077 order: razorpay, payment unknown", by(legacy.id), [["credit_note", "razorpay", 259900, null]]);
      check("funds basis: captured, captured, manual (unverified), pre-0077 unlinked (WP-12)",
        [cancelled, late, offline, legacy].map((o) => rows.find((r) => r.order_id === o.id)?.funds_basis),
        ["razorpay_captured", "razorpay_captured", "manual_recorded", "razorpay_unlinked"]);
      check("backfill audit rows", Number((await c.query("select count(*) n from payment_refund_events where action = 'obligation_created' and source = 'backfill'")).rows[0].n), rows.length);
      check("applying 0080 again is refused", has(await err(c.query(M0080)), "already applied"), "refused: already applied");

      // The legacy obligation learns its payment from Razorpay's answer.
      const legacyPay = rid("pay");
      const r = await evidence(c, { refund: rid("rfnd"), payment: legacyPay, rzpOrder: legacy.rzp, amount: 259900, payAmount: 259900, source: "admin_verify" });
      check("pre-0077 refund recorded processed", [r.outcome, r.status], ["recorded", "processed"]);
      check("its obligation now carries the payment id", (await obligationsOf(c, legacy.id)).map((o) => o.razorpay_payment_id), [legacyPay]);
      check("…and is now backed by a captured payment", (await obligationsOf(c, legacy.id)).map((o) => o.funds_basis), ["razorpay_captured"]);
      const led = await ledgerFor(c, legacyPay);
      check("ledger: owed 2599, refunded 2599, outstanding 0", [n(led.owed_paise), n(led.refunded_paise), n(led.outstanding_paise)], [259900, 259900, 0]);
      for (const x of [w.root, w.a, w.b]) await x.end();
    }

    // ════════════════════════════════════════════════════════════════════
    await engine.database("os3");
    const w = await osWorld(engine, "os3");
    const c = w.root;

    console.log("\n=== LEDGER: obligations arise by themselves ===");
    const o1 = await paidOrder(c, w);
    const cn = await cancelPaid(c, w, o1.id);
    const ob1 = (await obligationsOf(c, o1.id))[0];
    check("cancel_order → one credit-note obligation, recorded, with the payment", [ob1.source, ob1.origin, ob1.channel, n(ob1.amount_paise), ob1.razorpay_payment_id, ob1.source_id],
      ["credit_note", "recorded", "razorpay", 259900, o1.pay, cn.credit_note.id]);
    check("a credit note is not a refund: outstanding = owed", [n((await ledgerFor(c, o1.pay)).outstanding_paise), n((await ledgerFor(c, o1.pay)).refunded_paise)], [259900, 0]);

    const late = await placeOrder(c, w);
    await cancelUnpaid(c, w, late.id);
    await settle(c, late);
    const obLate = (await obligationsOf(c, late.id))[0];
    check("payment after cancellation → unfulfilled_payment obligation", [obLate.source, n(obLate.amount_paise), obLate.razorpay_payment_id], ["unfulfilled_payment", 259900, late.pay]);

    const twice = await paidOrder(c, w);
    const pay2 = rid("pay");
    await settle(c, twice, pay2);
    const twiceObs = await obligationsOf(c, twice.id);
    check("a second payment on a paid order → its own obligation; the sale stands", [twiceObs.length, twiceObs[0].razorpay_payment_id, twiceObs[0].source], [1, pay2, "unfulfilled_payment"]);
    check("ledger keeps distinct payments apart", [(await ledgerFor(c, twice.pay)), n((await ledgerFor(c, pay2)).owed_paise)], [null, 259900]);

    console.log("\n=== LEDGER: an admin records a refund id; it counts for nothing until Razorpay says so ===");
    const R1 = rid("rfnd");
    check("not a refund id → refused", has(await err(claim(c, w, ob1.id, "pay_ABCDEFGHIJKLMN")), "not a Razorpay refund id"), "refused: not a Razorpay refund id");
    const cl = await claim(c, w, ob1.id, R1, "Refunded from the dashboard by Tom");
    check("claimed", [cl.outcome, cl.status], ["claimed", "claimed"]);
    let led = await ledgerFor(c, o1.pay);
    check("claimed refund: refunded 0, outstanding unchanged, claimed 1", [n(led.refunded_paise), n(led.outstanding_paise), n(led.claimed_count)], [0, 259900, 1]);
    check("the same id again → already recorded", (await claim(c, w, ob1.id, R1)).outcome, "already_recorded");
    check("the same id on another obligation → refused", has(await err(claim(c, w, obLate.id, R1)), "different payment"), "refused: different payment");
    check("note kept", (await c.query("select note from refund_notes where obligation_id = $1", [ob1.id])).rows.map((r) => r.note), ["Refunded from the dashboard by Tom"]);

    console.log("\n=== LEDGER: Razorpay's answers ===");
    let r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "pending", source: "admin_verify", actor: w.admin });
    check("pending: recorded, in flight", [r.outcome, r.status], ["recorded", "pending"]);
    led = await ledgerFor(c, o1.pay);
    check("pending is not refunded: outstanding unchanged, pending 2599", [n(led.refunded_paise), n(led.pending_paise), n(led.outstanding_paise)], [0, 259900, 259900]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "processed" });
    check("processed: recorded", [r.outcome, r.status], ["recorded", "processed"]);
    led = await ledgerFor(c, o1.pay);
    check("verified refunded 2599, outstanding 0", [n(led.refunded_paise), n(led.outstanding_paise)], [259900, 0]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "processed" });
    check("duplicate delivery → unchanged", [r.outcome, r.status], ["unchanged", "processed"]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "pending" });
    check("late 'pending' after processed → kept processed (stale)", [r.outcome, r.status], ["stale_ignored", "processed"]);
    check("one row for the refund", Number((await c.query("select count(*) n from payment_refunds where razorpay_refund_id = $1", [R1])).rows[0].n), 1);
    check("audit trail: claimed, verified×2, unchanged, stale", (await c.query("select action, from_status, to_status from payment_refund_events where razorpay_refund_id = $1 order by id", [R1])).rows.map((x) => `${x.action}:${x.from_status ?? "-"}>${x.to_status}`),
      ["refund_claimed:->claimed", "refund_verified:claimed>pending", "refund_verified:pending>processed", "refund_unchanged:processed>processed", "refund_stale_ignored:processed>processed"]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "failed" });
    check("'failed' after 'processed' → uncertain, discrepancy", [r.outcome, r.status, r.discrepancies.length], ["uncertain", "uncertain", 1]);
    led = await ledgerFor(c, o1.pay);
    check("uncertain counts 0 → outstanding shows again (investigate, never assume)", [n(led.refunded_paise), n(led.outstanding_paise), n(led.uncertain_count)], [0, 259900, 1]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "processed", source: "webhook" });
    check("a webhook cannot clear uncertain", [r.outcome, r.status], ["unchanged", "uncertain"]);
    r = await evidence(c, { refund: R1, payment: o1.pay, rzpOrder: o1.rzp, amount: 259900, payAmount: 259900, status: "processed", source: "admin_verify", actor: w.admin });
    check("an admin's fresh check with consistent evidence settles it", [r.outcome, r.status], ["recorded", "processed"]);

    console.log("\n=== LEDGER: partial and multiple refunds; the cap ===");
    const o2 = await paidOrder(c, w);
    await cancelPaid(c, w, o2.id);
    const ob2 = (await obligationsOf(c, o2.id))[0];
    const P1 = rid("rfnd"), P2 = rid("rfnd"), P3 = rid("rfnd");
    await claim(c, w, ob2.id, P1);
    r = await evidence(c, { refund: P1, payment: o2.pay, rzpOrder: o2.rzp, amount: 100000, payAmount: 259900 });
    led = await ledgerFor(c, o2.pay);
    check("partial 1000 of 2599: outstanding 1599", [r.status, n(led.refunded_paise), n(led.outstanding_paise)], ["processed", 100000, 159900]);
    r = await evidence(c, { refund: P2, payment: o2.pay, rzpOrder: o2.rzp, amount: 159900, payAmount: 259900 });
    led = await ledgerFor(c, o2.pay);
    check("second partial 1599 (webhook, unclaimed): outstanding 0", [r.status, n(led.refunded_paise), n(led.outstanding_paise), n(led.over_refunded_paise)], ["processed", 259900, 0, 0]);
    r = await evidence(c, { refund: P3, payment: o2.pay, rzpOrder: o2.rzp, amount: 100, payAmount: 259900 });
    check("a third refund beyond the capture → uncertain, not counted", [r.status, r.reason?.includes("exceed")], ["uncertain", true]);
    check("refund_exceeds_capture discrepancy open", (await openDiscrepancies(c, "refund_exceeds_capture")).map((d) => d.razorpay_refund_id), [P3]);
    check("ledger still 2599 refunded", n((await ledgerFor(c, o2.pay)).refunded_paise), 259900);
    await c.query("set session_replication_role = origin");
    check("the cap holds for any writer (root inserting directly)", has(await err(c.query(
      `insert into payment_refunds (razorpay_refund_id, razorpay_payment_id, status, amount_paise, currency, payment_amount_paise,
                                    provider_mode, provider_status, last_verified_at)
       values ($1, $2, 'processed', 100, 'INR', 259900, 'test', 'processed', now())`, [rid("rfnd"), o2.pay])), "exceed"), "refused: exceed");

    console.log("\n=== LEDGER: wrong payment, wrong amount, mixed modes, wrong currency ===");
    const o3 = await paidOrder(c, w);
    await cancelPaid(c, w, o3.id);
    const ob3 = (await obligationsOf(c, o3.id))[0];
    const W1 = rid("rfnd");
    await claim(c, w, ob3.id, W1);
    r = await evidence(c, { refund: W1, payment: late.pay, rzpOrder: late.rzp, amount: 259900, payAmount: 259900, source: "admin_verify" });
    check("typed id is on another payment → uncertain, refund_claim_mismatch", [r.status, (await openDiscrepancies(c, "refund_claim_mismatch")).length], ["uncertain", 1]);
    check("…and it settles neither obligation", [n((await ledgerFor(c, o3.pay)).outstanding_paise), n((await ledgerFor(c, late.pay)).refunded_paise)], [259900, 0]);

    const A1 = rid("rfnd");
    await evidence(c, { refund: A1, payment: late.pay, rzpOrder: late.rzp, amount: 100000, payAmount: 259900 });
    r = await evidence(c, { refund: A1, payment: late.pay, rzpOrder: late.rzp, amount: 200000, payAmount: 259900 });
    check("same refund, different amount → uncertain contradiction", [r.status, (await openDiscrepancies(c, "refund_contradiction")).some((d) => d.razorpay_refund_id === A1)], ["uncertain", true]);
    check("the recorded amount is not overwritten", n((await c.query("select amount_paise from payment_refunds where razorpay_refund_id = $1", [A1])).rows[0].amount_paise), 100000);

    const L1 = rid("rfnd");
    r = await evidence(c, { refund: L1, payment: late.pay, rzpOrder: late.rzp, amount: 100, payAmount: 259900, mode: "live" });
    check("a Live refund on a payment with Test refunds → uncertain", r.status, "uncertain");

    const usd = await evidence(c, { refund: rid("rfnd"), payment: late.pay, rzpOrder: late.rzp, amount: 100, payAmount: 259900, currency: "USD" });
    check("non-INR → refused, discrepancy, no row", [usd.outcome, usd.discrepancies.length], ["refused_currency", 1]);

    console.log("\n=== LEDGER: refunds nothing was owed on; uncaptured payments ===");
    const o4 = await paidOrder(c, w);
    r = await evidence(c, { refund: rid("rfnd"), payment: o4.pay, rzpOrder: o4.rzp, amount: 50000, payAmount: 259900 });
    check("refund on an active paid order → recorded, refund_without_obligation", [r.status, (await openDiscrepancies(c, "refund_without_obligation")).map((d) => d.order_id)], ["processed", [o4.id]]);
    check("…and the order is flagged for review; still paid, still open", (await c.query("select needs_review, payment_status, status from orders where id = $1", [o4.id])).rows[0], { needs_review: true, payment_status: "paid", status: "placed" });
    const strangerPay = rid("pay");
    r = await evidence(c, { refund: rid("rfnd"), payment: strangerPay, rzpOrder: rid("order"), amount: 70000, payAmount: 70000 });
    check("refund on a payment whose order Wovenne does not know → recorded, discrepancy, no order",
      [r.status, (await openDiscrepancies(c, "refund_without_obligation")).filter((d) => d.razorpay_payment_id === strangerPay).map((d) => d.order_id)], ["processed", [null]]);
    r = await evidence(c, { refund: rid("rfnd"), payment: rid("pay"), rzpOrder: null, amount: 100, payAmount: 100 });
    check("…and one with no Razorpay order at all", r.status, "processed");
    const before = Number((await c.query("select count(*) n from payment_refunds")).rows[0].n);
    r = await evidence(c, { refund: rid("rfnd"), payment: rid("pay"), rzpOrder: rid("order"), amount: 100, payAmount: 100, captured: false });
    check("automatic refund of an uncaptured payment → ignored, nothing written", [r.outcome, Number((await c.query("select count(*) n from payment_refunds")).rows[0].n)], ["ignored_uncaptured", before]);
    check("bad evidence (unknown status) → refused", has(await err(evidence(c, { refund: rid("rfnd"), payment: o4.pay, rzpOrder: o4.rzp, amount: 1, payAmount: 259900, status: "reversed" })), "unknown refund status"), "refused: unknown refund status");

    console.log("\n=== LEDGER: closing without a refund (write-off: owner / finance approver only, WP-12) ===");
    const o5 = await paidOrder(c, w);
    await cancelPaid(c, w, o5.id);
    const ob5 = (await obligationsOf(c, o5.id))[0];
    const today = new Date().toISOString().slice(0, 10);
    const close = async (id: string, kind: string, reason: string, method: string | null = "bank_transfer",
                         ref: string | null = "UTR HDFC000123", amount: number | null = 200000, on: string | null = today) => {
      await asAdmin(c, w.admin);
      try {
        return (await c.query("select public.admin_close_refund_obligation($1, $2, $3, $4, $5, $6, $7::date) r",
          [id, kind, reason, method, ref, amount, on])).rows[0].r;
      } finally { await asRoot(c); }
    };
    const WHY = "Rest returned by bank transfer after a partial Razorpay refund.";
    check("an admin who is not an enrolled approver cannot close", has(await err(close(ob5.id, "refunded_outside_razorpay", WHY)), "authorised finance approver"), "refused: authorised finance approver");
    await enrolApprover(c, w.admin);
    check("reason under 20 chars → refused", has(await err(close(ob5.id, "refunded_outside_razorpay", "test")), "20 characters"), "refused: 20 characters");
    check("test_mode_payment is not closable by an admin's say-so", has(await err(close(ob5.id, "test_mode_payment", WHY)), "Razorpay's own answer"), "refused: Razorpay's own answer");
    const C1 = rid("rfnd");
    await claim(c, w, ob5.id, C1);
    check("with an unverified refund id → refused", has(await err(close(ob5.id, "refunded_outside_razorpay", WHY)), "still unverified"), "refused: still unverified");
    await evidence(c, { refund: C1, payment: o5.pay, rzpOrder: o5.rzp, amount: 59900, payAmount: 259900 });
    check("amount must equal what is outstanding", has(await err(close(ob5.id, "refunded_outside_razorpay", WHY, "bank_transfer", "UTR HDFC000123", 259900)), "must equal"), "refused: must equal");
    const cr = await close(ob5.id, "refunded_outside_razorpay", WHY);
    check("closes, writing off only what was outstanding (2000)", [cr.outcome, n(cr.written_off_paise)], ["closed", 200000]);
    led = await ledgerFor(c, o5.pay);
    check("ledger: refunded 599 (verified), written off 2000, outstanding 0", [n(led.refunded_paise), n(led.written_off_paise), n(led.outstanding_paise)], [59900, 200000, 0]);
    check("cannot close twice", has(await err(close(ob5.id, "refunded_outside_razorpay", WHY)), "already closed"), "refused: already closed");
    check("closed obligation takes no new refund id", has(await err(claim(c, w, ob5.id, rid("rfnd"))), "closed"), "refused: closed");
    check("close is audited with the approver, method and reference",
      (await c.query("select actor = $2 a, evidence->>'kind' k, evidence->>'method' m, evidence->>'reference' r from payment_refund_events where obligation_id = $1 and action = 'obligation_closed'", [ob5.id, w.admin])).rows[0],
      { a: true, k: "refunded_outside_razorpay", m: "bank_transfer", r: "UTR HDFC000123" });

    console.log("\n=== GUARDS: verified evidence is permanent, for every role ===");
    await asRoot(c);
    check("root cannot change a verified amount", has(await err(c.query("update payment_refunds set amount_paise = 1 where razorpay_refund_id = $1", [P1])), "cannot be changed"), "refused: cannot be changed");
    check("root cannot change the payment", has(await err(c.query("update payment_refunds set razorpay_payment_id = 'pay_ZZZZZZZZZZZZZZ' where razorpay_refund_id = $1", [P1])), "cannot be changed"), "refused: cannot be changed");
    check("root cannot move processed back to pending", has(await err(c.query("update payment_refunds set status = 'pending', provider_status = 'pending' where razorpay_refund_id = $1", [P1])), "cannot move"), "refused: cannot move");
    check("root cannot delete a refund", has(await err(c.query("delete from payment_refunds where razorpay_refund_id = $1", [P1])), "permanent"), "refused: permanent");
    check("root cannot delete an obligation", has(await err(c.query("delete from refund_obligations where id = $1", [ob1.id])), "permanent"), "refused: permanent");
    check("root cannot change an obligation's amount", has(await err(c.query("update refund_obligations set amount_paise = 1 where id = $1", [ob1.id])), "cannot be changed"), "refused: cannot be changed");
    check("root cannot reopen a closed obligation", has(await err(c.query("update refund_obligations set closed_at = null, close_kind = null, close_reason = null, written_off_paise = null where id = $1", [ob5.id])), "cannot be reopened"), "refused: cannot be reopened");
    check("audit trail is append-only", has(await err(c.query("update payment_refund_events set action = 'refund_verified' where id = (select min(id) from payment_refund_events)")), "append-only"), "refused: append-only");
    check("notes are append-only", has(await err(c.query("delete from refund_notes")), "append-only"), "refused: append-only");
    check("a 'processed' row without provider evidence is impossible", has(await err(c.query("insert into payment_refunds (razorpay_refund_id, status, amount_paise) values ($1, 'processed', 100)", [rid("rfnd")])), "check constraint"), "refused: check constraint");

    console.log("\n=== GUARDS: who can do what ===");
    await asAdmin(c, w.admin);
    check("admin: no INSERT on payment_refunds", has(await err(c.query("insert into payment_refunds (razorpay_refund_id, status) values ($1, 'claimed')", [rid("rfnd")])), "permission denied"), "refused: permission denied");
    check("admin: no UPDATE on payment_refunds", has(await err(c.query("update payment_refunds set status = 'processed'")), "permission denied"), "refused: permission denied");
    check("admin: no UPDATE on refund_obligations", has(await err(c.query("update refund_obligations set closed_at = now()")), "permission denied"), "refused: permission denied");
    check("admin: cannot call record_refund_evidence (cannot type 'processed')", has(await err(c.query(
      "select public.record_refund_evidence($1, $2, $3, 100, 'INR', 'processed', now(), null, 259900, 'INR', true, 100, 'test', 'admin_verify')", [rid("rfnd"), o4.pay, o4.rzp])), "permission denied"), "refused: permission denied");
    check("admin: cannot call recon_start", has(await err(c.query("select public.recon_start('test', now() - interval '2 days', now() - interval '1 day', null)")), "permission denied"), "refused: permission denied");
    check("admin reads the ledger", Number((await c.query("select count(*) n from refund_ledger")).rows[0].n) > 0, true);
    await asStaffPasswordOnly(c, w.admin);
    check("staff at aal1: claim refused", has(await err(c.query("select public.admin_claim_refund($1, $2)", [ob3.id, rid("rfnd")])), "Only admins"), "refused: Only admins");
    check("staff at aal1: reads nothing", Number((await c.query("select count(*) n from refund_ledger")).rows[0].n), 0);
    await asUser(c, w.customer, "aal1");
    check("customer: reads no obligations / refunds / discrepancies",
      [Number((await c.query("select count(*) n from refund_obligations")).rows[0].n), Number((await c.query("select count(*) n from payment_refunds")).rows[0].n), Number((await c.query("select count(*) n from payment_reconciliation_discrepancies")).rows[0].n)], [0, 0, 0]);
    check("customer: close refused", has(await err(c.query("select public.admin_close_refund_obligation($1, 'test_mode_payment', 'aaaaaaaaaaaaaaaaaaaaaaaa')", [ob3.id])), "Only admins"), "refused: Only admins");
    await c.query("reset role");
    await c.query("set role anon");
    check("anon: no access to the ledger view", has(await err(c.query("select * from refund_ledger")), "permission denied"), "refused: permission denied");
    await asService(c);
    check("service_role: cannot call admin_claim_refund", has(await err(c.query("select public.admin_claim_refund($1, $2)", [ob3.id, rid("rfnd")])), "permission denied"), "refused: permission denied");
    check("service_role: cannot write the tables directly", has(await err(c.query("update refund_obligations set amount_paise = 1")), "permission denied"), "refused: permission denied");
    check("service_role: cannot call the internal upsert", has(await err(c.query("select public.refund_discrepancy_upsert('amount_mismatch', 'test', null, null, null, null, null, null, null)")), "permission denied"), "refused: permission denied");
    await asRoot(c);
    const fns = [
      "admin_claim_refund(uuid,text,text)", "admin_close_refund_obligation(uuid,text,text,text,text,bigint,date)", "admin_add_refund_note(uuid,bigint,text)",
      "refund_closure_authority()", "record_test_mode_closure(uuid,uuid,text,text,text,text,bigint,text,boolean,text)",
      "refund_closure_approver_is(uuid)", "refund_obligations_duplicate_check()", "refund_closure_approvers_audit()",
      "admin_resolve_discrepancy(bigint,text,text)",
      "record_refund_evidence(text,text,text,bigint,text,text,timestamptz,text,bigint,text,boolean,bigint,text,text,uuid,jsonb)",
      "record_refund_not_found(text,text,text,text,jsonb)", "recon_start(text,timestamptz,timestamptz,uuid,bigint)",
      "recon_checkpoint(bigint,integer,integer,integer,boolean,boolean)", "recon_record_discrepancy(bigint,text,text,text,text,jsonb)",
      "recon_payment_facts(text[],text[])", "recon_finish(bigint,text,text)",
    ];
    const matrix = (await c.query(`select f, has_function_privilege('anon', 'public.' || f, 'EXECUTE') an,
        has_function_privilege('authenticated', 'public.' || f, 'EXECUTE') au, has_function_privilege('service_role', 'public.' || f, 'EXECUTE') sv
      from unnest($1::text[]) f`, [fns])).rows.map((x) => `${x.f.split("(")[0]}:${x.an ? "A" : "-"}${x.au ? "U" : "-"}${x.sv ? "S" : "-"}`);
    check("EXECUTE matrix (anon/authenticated/service)", matrix, [
      "admin_claim_refund:-U-", "admin_close_refund_obligation:-U-", "admin_add_refund_note:-U-",
      "refund_closure_authority:-U-", "record_test_mode_closure:--S", "refund_closure_approver_is:---",
      "refund_obligations_duplicate_check:---", "refund_closure_approvers_audit:---", "admin_resolve_discrepancy:-U-",
      "record_refund_evidence:--S", "record_refund_not_found:--S", "recon_start:--S", "recon_checkpoint:--S",
      "recon_record_discrepancy:--S", "recon_payment_facts:--S", "recon_finish:--S"]);
    const tbl = (await c.query(`select t, has_table_privilege('anon', t, 'SELECT') a_s,
        has_table_privilege('authenticated', t, 'INSERT') or has_table_privilege('authenticated', t, 'UPDATE') or has_table_privilege('authenticated', t, 'DELETE') u_w,
        has_table_privilege('service_role', t, 'INSERT') or has_table_privilege('service_role', t, 'UPDATE') or has_table_privilege('service_role', t, 'DELETE') s_w,
        (select relrowsecurity from pg_class where oid = t::regclass) rls
      from unnest(array['refund_obligations','payment_refunds','payment_refund_events','payment_reconciliation_runs',
                        'payment_reconciliation_discrepancies','refund_notes','refund_closure_approvers']) t`)).rows;
    check("tables: RLS on; anon reads nothing; no direct writes for authenticated or service_role",
      tbl.every((x) => x.rls && !x.a_s && !x.u_w && !x.s_w), true);

    console.log("\n=== CONCUR: the same refund twice at once; two refunds racing the cap ===");
    {
      const o6 = await paidOrder(c, w);
      await cancelPaid(c, w, o6.id);
      const X = rid("rfnd");
      await w.a.query("begin");
      await asService(w.a);
      await w.a.query(`select public.record_refund_evidence($1, $2, $3, 259900, 'INR', 'processed', now(), null, 259900, 'INR', true, 259900, 'test', 'webhook')`, [X, o6.pay, o6.rzp]);
      await asService(w.b);
      const second = w.b.query(`select public.record_refund_evidence($1, $2, $3, 259900, 'INR', 'processed', now(), null, 259900, 'INR', true, 259900, 'test', 'reconciliation') r`, [X, o6.pay, o6.rzp]);
      await new Promise((res) => setTimeout(res, 300));
      const waiting = (await c.query("select count(*) n from pg_locks where not granted")).rows[0].n;
      check("the second delivery waits on the payment lock", Number(waiting) >= 1, true);
      await w.a.query("commit");
      const s = (await second).rows[0].r;
      check("…then sees the first and changes nothing", [s.outcome, s.status], ["unchanged", "processed"]);
      check("one row", Number((await c.query("select count(*) n from payment_refunds where razorpay_refund_id = $1", [X])).rows[0].n), 1);
      await asRoot(w.a); await asRoot(w.b);

      const o7 = await paidOrder(c, w);
      await cancelPaid(c, w, o7.id);
      const Y1 = rid("rfnd"), Y2 = rid("rfnd");
      await w.a.query("begin");
      await asService(w.a);
      await w.a.query(`select public.record_refund_evidence($1, $2, $3, 200000, 'INR', 'processed', now(), null, 259900, 'INR', true, 200000, 'test', 'webhook')`, [Y1, o7.pay, o7.rzp]);
      await asService(w.b);
      const race = w.b.query(`select public.record_refund_evidence($1, $2, $3, 200000, 'INR', 'processed', now(), null, 259900, 'INR', true, 400000, 'test', 'webhook') r`, [Y2, o7.pay, o7.rzp]);
      await new Promise((res) => setTimeout(res, 300));
      await w.a.query("commit");
      const rr = (await race).rows[0].r;
      check("two refunds racing past the capture: the second is uncertain, not counted", [rr.status, n((await ledgerFor(c, o7.pay)).refunded_paise)], ["uncertain", 200000]);
      await asRoot(w.a); await asRoot(w.b);
    }

    console.log("\n=== RECON: runs, checkpoints, completeness ===");
    {
      await asService(c);
      check("a window ending in the future is refused", has(await err(c.query("select public.recon_start('test', now() - interval '1 day', now(), null)")), "15 minutes"), "refused: 15 minutes");
      check("a window over 31 days is refused", has(await err(c.query("select public.recon_start('test', now() - interval '40 days', now() - interval '1 day', null)")), "31 days"), "refused: 31 days");
      check("an unknown mode is refused", has(await err(c.query("select public.recon_start('prod', now() - interval '2 days', now() - interval '1 day', null)")), "mode"), "refused: mode");
      const run = (await c.query("select public.recon_start('test', now() - interval '3 days', now() - interval '1 day', $1) r", [w.admin])).rows[0].r;
      check("one running run per mode", has(await err(c.query("select public.recon_start('test', now() - interval '3 days', now() - interval '1 day', null)")), "already running"), "refused: already running");
      const live = (await c.query("select public.recon_start('live', now() - interval '3 days', now() - interval '1 day', null) r")).rows[0].r;
      check("Test and Live runs are separate", live.provider_mode, "live");
      await c.query("select public.recon_finish($1, 'incomplete', 'test only')", [live.id]);
      await c.query("select public.recon_checkpoint($1, 100, 100, 3, false, false)", [run.id]);
      check("complete is refused before the last page", has(await err(c.query("select public.recon_finish($1, 'complete')", [run.id])), "incomplete, not complete"), "refused: incomplete, not complete");
      const d1 = (await c.query("select public.recon_record_discrepancy($1, 'captured_not_recorded', $2, $3, null, '{\"amount_paise\": 259900}') d", [run.id, o4.pay, o4.rzp])).rows[0].d;
      const d2 = (await c.query("select public.recon_record_discrepancy($1, 'captured_not_recorded', $2, $3, null, '{\"amount_paise\": 259900}') d", [run.id, o4.pay, o4.rzp])).rows[0].d;
      check("the same finding twice → one row, seen twice", [d1 === d2, (await c.query("select times_seen from payment_reconciliation_discrepancies where id = $1", [d1])).rows[0].times_seen], [true, 2]);
      check("refund-only kinds cannot be written by reconciliation", has(await err(c.query("select public.recon_record_discrepancy($1, 'refund_without_obligation', null, null, null, null)", [run.id])), "not by reconciliation"), "refused: not by reconciliation");
      await asRoot(c);
      check("a checkpoint only moves forward", has(await err(c.query("update payment_reconciliation_runs set next_skip = 0 where id = $1", [run.id])), "only moves forward"), "refused: only moves forward");
      await asService(c);
      await c.query("select public.recon_checkpoint($1, 150, 50, 1, true, false)", [run.id]);
      // A claim left unverified for three days (fixture: back-dated).
      const Z = rid("rfnd");
      await claim(c, w, ob3.id, Z);
      await asRoot(c);
      await c.query("set session_replication_role = replica");
      await c.query("update payment_refunds set claimed_at = now() - interval '3 days' where razorpay_refund_id = $1", [Z]);
      await c.query("set session_replication_role = origin");
      await asService(c);
      const fin = (await c.query("select public.recon_finish($1, 'complete') r", [run.id])).rows[0].r;
      check("complete after the last page; stale claim found", [fin.status, (await openDiscrepancies(c, "refund_claim_unverified")).map((d) => d.razorpay_refund_id)], ["complete", [Z]]);
      await asRoot(c);
      check("a finished run cannot be changed", has(await err(c.query("update payment_reconciliation_runs set status = 'running', finished_at = null where id = $1", [run.id])), "finished"), "refused: finished");
      await asService(c);
      const inc = (await c.query("select public.recon_start('test', now() - interval '3 days', now() - interval '1 day', null) r")).rows[0].r;
      await c.query("select public.recon_checkpoint($1, 200, 100, 0, false, false)", [inc.id]);
      await c.query("select public.recon_finish($1, 'incomplete', 'gateway timeout')", [inc.id]);
      const res = (await c.query("select public.recon_start('test', null, null, null, $1) r", [inc.id])).rows[0].r;
      check("resume continues from the checkpoint over the same window", [res.start_skip, res.next_skip, res.window_from === inc.window_from, res.resumed_from], [200, 200, true, inc.id]);
      await c.query("select public.recon_finish($1, 'incomplete', 'stopped by the test')", [res.id]);
      check("a complete run cannot be resumed", has(await err(c.query("select public.recon_start('test', null, null, null, $1)", [run.id])), "cannot be resumed"), "refused: cannot be resumed");

      // Discrepancy lifecycle (admin).
      await asAdmin(c, w.admin);
      check("resolve needs 20+ characters", has(await err(c.query("select public.admin_resolve_discrepancy($1, 'resolved', 'ok')", [d1])), "20 characters"), "refused: 20 characters");
      await c.query("select public.admin_resolve_discrepancy($1, 'resolved', 'Checked in Razorpay: settled by hand, see note.')", [d1]);
      await asService(c);
      const run2 = (await c.query("select public.recon_start('test', now() - interval '3 days', now() - interval '1 day', null) r")).rows[0].r;
      const d3 = (await c.query("select public.recon_record_discrepancy($1, 'captured_not_recorded', $2, $3, null, '{}') d", [run2.id, o4.pay, o4.rzp])).rows[0].d;
      check("seen again after resolved → a new open row (history kept)", [d3 !== d1, (await c.query("select status from payment_reconciliation_discrepancies where id = $1", [d1])).rows[0].status], [true, "resolved"]);
      await asAdmin(c, w.admin);
      await c.query("select public.admin_resolve_discrepancy($1, 'accepted', 'Known Test-mode payment from September; benign.')", [d3]);
      await asService(c);
      const d4 = (await c.query("select public.recon_record_discrepancy($1, 'captured_not_recorded', $2, $3, null, '{}') d", [run2.id, o4.pay, o4.rzp])).rows[0].d;
      check("seen again after accepted → counted on the accepted row, not reopened", [d4 === d3, (await c.query("select status, times_seen from payment_reconciliation_discrepancies where id = $1", [d3])).rows[0]], [true, { status: "accepted", times_seen: 2 }]);
      await c.query("select public.recon_finish($1, 'incomplete', 'done')", [run2.id]);
      await asRoot(c);
      check("a resolved discrepancy cannot be reopened", has(await err(c.query("update payment_reconciliation_discrepancies set status = 'open', resolved_at = null, resolution_note = null where id = $1", [d1])), "cannot be reopened"), "refused: cannot be reopened");
      check("captured_not_recorded flags the order for review", (await c.query("select needs_review from orders where id = $1", [o4.id])).rows[0].needs_review, true);
    }

    console.log("\n=== KEEP: OS-1 / OS-2 / OS-2b protections; deletion keeps the record ===");
    {
      const o8 = await paidOrder(c, w);
      check("a payment still settles an open order (stock, paid, invoice)", (await c.query("select payment_status, invoice_number is not null inv, razorpay_payment_id = $2 p from orders where id = $1", [o8.id, o8.pay])).rows[0], { payment_status: "paid", inv: true, p: true });
      await asAdmin(c, w.admin);
      check("admins still cannot un-pay an order (0078)", has(await err(c.query("update orders set payment_status = 'pending' where id = $1", [o8.id])), "permission denied"), "refused: permission denied");
      await asRoot(c);
      check("a credit note is still capped at the paid total (0078)", has(await err(c.query(
        "insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-TEST-1', $1, 'cancellation', 999999)", [o8.id])), "cannot exceed"), "refused: cannot exceed");
      check("a cancelled order cannot be marked paid (0077)", has(await err(c.query("update orders set payment_status = 'paid' where id = $1", [late.id])), "cancelled order"), "refused: cancelled order");
      check("0077's obligation table still says only 'owed'", (await c.query("select array_agg(distinct state) s from payment_refund_obligations")).rows[0].s, ["owed"]);

      // Staff account removed: the claim stays, without the name.
      const temp = (await c.query("insert into auth.users (email) values ('temp@example.test') returning id")).rows[0].id;
      await c.query("insert into profiles (id, email, is_admin) values ($1, 'temp@example.test', true) on conflict (id) do update set is_admin = true", [temp]);
      const o9 = await paidOrder(c, w);
      await cancelPaid(c, w, o9.id);
      const ob9 = (await obligationsOf(c, o9.id))[0];
      const T = rid("rfnd");
      await asAdmin(c, temp);
      await c.query("select public.admin_claim_refund($1, $2)", [ob9.id, T]);
      await asRoot(c);
      await evidence(c, { refund: T, payment: o9.pay, rzpOrder: o9.rzp, amount: 259900, payAmount: 259900 });
      const delUser = await err(c.query("delete from auth.users where id = $1", [temp]));
      check("staff account deleted", delUser, "");
      check("…refund kept, claimed_by cleared", (await c.query("select status, claimed_by from payment_refunds where razorpay_refund_id = $1", [T])).rows[0], { status: "processed", claimed_by: null });
      // 0079 keeps an invoiced order from being deleted at all; to prove 0080's
      // own behaviour, the fixture removes the sealed invoice copy first
      // (triggers off for that step only), then deletes the order normally.
      await c.query("set session_replication_role = replica");
      await c.query("delete from order_invoice_sealed_parties where order_id = $1", [o9.id]);
      await c.query("delete from order_invoice_snapshots where order_id = $1", [o9.id]);
      await c.query("set session_replication_role = origin");
      const delOrder = await err(c.query("delete from orders where id = $1", [o9.id]));
      check("order deleted (fixture)", delOrder, "");
      check("…obligation and refund kept, order link cleared, Razorpay ids intact",
        [(await c.query("select order_id, razorpay_payment_id from refund_obligations where id = $1", [ob9.id])).rows[0], (await c.query("select order_id, razorpay_payment_id, status from payment_refunds where razorpay_refund_id = $1", [T])).rows[0]],
        [{ order_id: null, razorpay_payment_id: o9.pay }, { order_id: null, razorpay_payment_id: o9.pay, status: "processed" }]);
      check("…and still in the ledger as fully refunded", [n((await ledgerFor(c, o9.pay)).refunded_paise), n((await ledgerFor(c, o9.pay)).outstanding_paise)], [259900, 0]);
    }

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
