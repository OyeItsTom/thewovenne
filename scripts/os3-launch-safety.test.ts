/**
 * OS-3 launch-safety corrections (WP-ORDER-SAFETY-12, 0080 as amended), in the
 * database.
 *
 *   DUPLICATE  one captured payment cannot become two liabilities through
 *              different paths: replays, late captures, second payments,
 *              partial and multiple credit notes, a forced duplicate.
 *   MANUAL     a manual order "paid" by assertion is never captured money; a
 *              repayment outside Razorpay needs method, reference, amount, date.
 *   AUTHORITY  only an enrolled owner / finance approver (who is still an aal2
 *              admin) closes without a verified refund; nobody but the
 *              database owner enrols one; enrolment is audited.
 *   TESTMODE   a Test-mode payment is closed only on Razorpay's answer under
 *              Test keys, one obligation at a time, never as "refunded".
 *
 * Real PostgreSQL 17.6 (embedded, throwaway), fictional data, real roles.
 *
 *   PG_HARNESS_DIR=<pgh> npx tsx scripts/os3-launch-safety.test.ts
 */
import { asAdmin, asRoot, asService, asStaffPasswordOnly, makeAdmin, startEngine, type Client } from "./pg-world";
import {
  cancelPaid, cancelUnpaid, enrolApprover, evidence, ledgerFor, obligationsOf, openDiscrepancies, osWorld, paidOrder,
  placeOrder, rid, settle, type OsWorld, type Placed,
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
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

async function close(c: Client, who: string, id: string, kind: string, reason: string,
                     method: string | null, ref: string | null, amount: number | null, on: string | null) {
  await asAdmin(c, who);
  try {
    return (await c.query("select public.admin_close_refund_obligation($1, $2, $3, $4, $5, $6, $7::date) r",
      [id, kind, reason, method, ref, amount, on])).rows[0].r;
  } finally {
    await asRoot(c);
  }
}

interface TestModeFacts {
  actor: string | null;
  mode?: string;
  payment: string;
  order: string;
  amount: number;
  captured?: boolean;
  currency?: string;
  reason?: string;
}
async function testModeClose(c: Client, ob: string, f: TestModeFacts) {
  await asService(c);
  try {
    return (await c.query(
      `select public.record_test_mode_closure($1, $2, $3, $4, $5, $6, $7, $8, $9, 'captured') r`,
      [ob, f.actor, f.reason ?? "Razorpay Test-mode payment from pre-launch testing; never real money.",
       f.mode ?? "test", f.payment, f.order, f.amount, f.currency ?? "INR", f.captured ?? true])).rows[0].r;
  } finally {
    await asRoot(c);
  }
}

/** An order recorded as paid in person (the manual-order route's insert). */
async function manualPaidOrder(c: Client, w: OsWorld, total = 1500): Promise<Placed> {
  const o = await placeOrder(c, w, total, "offline");
  await c.query("set session_replication_role = replica");
  await c.query("update orders set payment_status = 'paid', status = 'confirmed', payment_method = 'cash' where id = $1", [o.id]);
  await c.query("set session_replication_role = origin");
  return o;
}

/** A Razorpay order settled before 0077: paid, no payment id kept. */
async function legacyPaidOrder(c: Client, w: OsWorld): Promise<Placed> {
  const o = await placeOrder(c, w);
  await c.query("set session_replication_role = replica");
  await c.query("update orders set payment_status = 'paid', status = 'confirmed' where id = $1", [o.id]);
  await c.query("set session_replication_role = origin");
  return o;
}

/** A return credit note, issued the way the returns path does (internal function, as the owner). */
async function returnNote(c: Client, w: OsWorld, orderId: string, inr: number) {
  await asRoot(c);
  return c.query(
    `insert into credit_notes (credit_note_number, order_id, invoice_number, kind, amount_inr, reason, items, issued_by)
     values ('CN-T-' || nextval('credit_note_number_seq'), $1, null, 'return', $2, 'Returned item (fictional)', null, $3)`,
    [orderId, inr, w.admin]);
}

async function invariant(c: Client) {
  await asRoot(c);
  return (await c.query(`select count(*) filter (where sources > 1)::int dual, count(*) filter (where owed > captured)::int excess
      from (select razorpay_payment_id, count(distinct source) sources, sum(amount_paise) owed, max(captured_paise) captured
              from refund_obligations where razorpay_payment_id is not null group by 1) x`)).rows[0];
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIP: embedded-postgres not available (set PG_HARNESS_DIR)");
    process.exit(2);
  }
  console.log(engine.version);
  try {
    await engine.database("ls12");
    const w = await osWorld(engine, "ls12");
    const c = w.root;
    const clerk = await makeAdmin(c, "clerk@example.test"); // an ordinary second admin, never enrolled

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== DUPLICATE: one payment, one liability ===");
    {
      const a = await paidOrder(c, w);
      await cancelPaid(c, w, a.id);
      const r = await settle(c, a);
      check("replay of the settling payment after cancellation → old news", r.path, "already_settled_cancelled");
      check("…still exactly one obligation, the credit note's", (await obligationsOf(c, a.id)).map((o) => o.source), ["credit_note"]);
      const r2 = await settle(c, a);
      check("a second retry changes nothing", [r2.path, (await obligationsOf(c, a.id)).length], ["already_settled_cancelled", 1]);

      const b = await placeOrder(c, w);
      await cancelUnpaid(c, w, b.id);
      const rb = await settle(c, b);
      check("capture after an unpaid cancellation → whole payment owed (0077)", rb.path, "refund_owed");
      check("…and no credit note can be added on top (order was never paid)",
        has(await err(cancelPaid(c, w, b.id)), "already cancelled"), "refused: already cancelled");
      await asRoot(c);
      check("…a direct credit note is refused too",
        has(await err(c.query("insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-T-X1', $1, 'return', 10)", [b.id])), "never paid"),
        "refused: never paid");
      const rb2 = await settle(c, b);
      check("…a retry of that capture does not add a second obligation", [rb2.path, (await obligationsOf(c, b.id)).length], ["refund_owed", 1]);

      const d = await paidOrder(c, w);
      const P2 = rid("pay");
      check("a second capture on a paid order → owed whole, separately", (await settle(c, d, P2)).path, "refund_owed");
      await cancelPaid(c, w, d.id);
      const obs = (await obligationsOf(c, d.id)).map((o) => [o.source, o.razorpay_payment_id === d.pay ? "P1" : o.razorpay_payment_id === P2 ? "P2" : "?", n(o.amount_paise), o.funds_basis]);
      check("cancellation → P1 credit note + P2 whole payment, each on its own payment", obs,
        [["unfulfilled_payment", "P2", 259900, "razorpay_captured"], ["credit_note", "P1", 259900, "razorpay_captured"]]);
      const l1 = await ledgerFor(c, d.pay);
      const l2 = await ledgerFor(c, P2);
      check("ledger owes each payment exactly what it captured", [n(l1.owed_paise), n(l1.captured_paise), n(l2.owed_paise), n(l2.captured_paise)], [259900, 259900, 259900, 259900]);

      const e = await paidOrder(c, w);
      await returnNote(c, w, e.id, 1000);
      await returnNote(c, w, e.id, 1599);
      check("a third credit note past the order total is refused (0078 cap)",
        has(await err(returnNote(c, w, e.id, 1)), "cannot exceed"), "refused: cannot exceed");
      const le = await ledgerFor(c, e.pay);
      check("two partial credit notes → one payment owed 2599 of 2599", [n(le.obligation_count), n(le.owed_paise), n(le.captured_paise)], [2, 259900, 259900]);
      const R1 = rid("rfnd");
      await evidence(c, { refund: R1, payment: e.pay, rzpOrder: e.rzp, amount: 100000, payAmount: 259900 });
      await evidence(c, { refund: R1, payment: e.pay, rzpOrder: e.rzp, amount: 100000, payAmount: 259900 });
      await evidence(c, { refund: rid("rfnd"), payment: e.pay, rzpOrder: e.rzp, amount: 159900, payAmount: 259900 });
      const le2 = await ledgerFor(c, e.pay);
      check("partial refunds, one replayed: refunded 2599, outstanding 0, obligations unchanged",
        [n(le2.refunded_paise), n(le2.outstanding_paise), n(le2.obligation_count)], [259900, 0, 2]);

      check("no payment owed from two sources, none owed more than captured", await invariant(c), { dual: 0, excess: 0 });
      check("no duplicate_obligation discrepancy on genuine history", (await openDiscrepancies(c, "duplicate_obligation")).length, 0);

      // Reconciliation records discrepancies; it never creates obligations.
      const before = n((await c.query("select count(*) n from refund_obligations")).rows[0].n);
      await asService(c);
      const run = (await c.query("select public.recon_start('test', now() - interval '2 days', now() - interval '1 day', null) r")).rows[0].r;
      const runId = typeof run === "object" && run !== null ? (run as { run_id?: number; id?: number }).run_id ?? (run as { id?: number }).id : run;
      await c.query("select public.recon_record_discrepancy($1, 'captured_not_recorded', $2, $3, null, '{}'::jsonb)", [runId, d.pay, d.rzp]);
      await asRoot(c);
      check("a reconciliation run adds no obligation", n((await c.query("select count(*) n from refund_obligations")).rows[0].n), before);

      // Defence in depth: a path that WOULD owe the settling payment twice.
      const f = await paidOrder(c, w);
      await cancelPaid(c, w, f.id);
      await asRoot(c);
      await c.query(
        `insert into payment_refund_obligations (order_id, razorpay_order_id, razorpay_payment_id, amount_paise, currency, provider_status, reason,
                                                 order_status_at_capture, order_payment_status_at_capture, order_total_paise_at_capture)
         values ($1, $2, $3, 259900, 'INR', 'captured', 'second_payment', 'cancelled', 'paid', 259900)`, [f.id, f.rzp, f.pay]);
      const dd = await openDiscrepancies(c, "duplicate_obligation");
      check("forced duplicate on one payment → duplicate_obligation discrepancy", dd.map((x) => x.razorpay_payment_id), [f.pay]);
      check("…which records both sources and owed > captured", [n(dd[0].details.sources), n(dd[0].details.owed_paise), n(dd[0].details.captured_paise)], [2, 519800, 259900]);
      check("…and flags the order for review", (await c.query("select needs_review from orders where id = $1", [f.id])).rows[0].needs_review, true);
      check("…and the ledger shows it as needing investigation", (n((await ledgerFor(c, f.pay))?.open_discrepancies) ?? 0) > 0, true);
    }

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== MANUAL: recorded as paid is not money received ===");
    let manualOb: string;
    {
      const m = await manualPaidOrder(c, w);
      await cancelPaid(c, w, m.id);
      const ob = (await obligationsOf(c, m.id))[0];
      manualOb = ob.id;
      check("credit note on a manual order → outside Razorpay, basis manual_recorded",
        [ob.channel, ob.funds_basis, ob.razorpay_payment_id], ["outside_razorpay", "manual_recorded", null]);
      const led = (await c.query("select * from refund_ledger where $1 = any(obligation_ids)", [ob.id])).rows[0];
      check("ledger carries the basis so the screen can say 'manual payment, unverified'", led.funds_bases, ["manual_recorded"]);
      await asAdmin(c, w.admin);
      check("a Razorpay refund id cannot settle it",
        has(await err(c.query("select public.admin_claim_refund($1, $2)", [ob.id, rid("rfnd")]))," not taken through Razorpay"), "refused:  not taken through Razorpay");
      await asRoot(c);
      check("ordinary admin: free-text closure refused",
        has(await err(close(c, clerk, ob.id, "refunded_outside_razorpay", "Gave the customer cash back at the stall.", null, null, null, null)), "authorised finance approver"),
        "refused: authorised finance approver");
    }

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== AUTHORITY: owner / finance approvers only ===");
    {
      await asRoot(c);
      check("approvers ship empty", n((await c.query("select count(*) n from refund_closure_approvers")).rows[0].n), 0);
      await asAdmin(c, w.admin);
      check("an admin cannot enrol themself", has(await err(c.query("insert into refund_closure_approvers (user_id, authorised_by, note) values (auth.uid(), 'me', 'I approve myself for this, honestly.')")), "permission denied"), "refused: permission denied");
      check("an admin cannot even read the approvers", has(await err(c.query("select * from refund_closure_approvers")), "permission denied"), "refused: permission denied");
      check("refund_closure_authority(): false before enrolment", (await c.query("select public.refund_closure_authority() v")).rows[0].v, false);
      await asService(c);
      check("service_role cannot enrol anyone", has(await err(c.query("insert into refund_closure_approvers (user_id, authorised_by, note) values ($1, 'svc', 'Service role trying to enrol.')", [w.admin])), "permission denied"), "refused: permission denied");
      await asRoot(c);
      await enrolApprover(c, w.admin);
      check("enrolment is audited (database_owner)", (await c.query("select action, source, actor = $1 a from payment_refund_events where action like 'closure_approver%'", [w.admin])).rows, [{ action: "closure_approver_added", source: "database_owner", a: true }]);
      check("an approver row cannot be edited", has(await err(c.query("update refund_closure_approvers set note = 'changed note, quite long enough' where user_id = $1", [w.admin])), "never edited"), "refused: never edited");
      await asAdmin(c, w.admin);
      check("refund_closure_authority(): true for the enrolled aal2 admin", (await c.query("select public.refund_closure_authority() v")).rows[0].v, true);
      await asStaffPasswordOnly(c, w.admin);
      check("…false at aal1 (password only)", (await c.query("select public.refund_closure_authority() v")).rows[0].v, false);
      await asAdmin(c, clerk);
      check("…false for the ordinary admin", (await c.query("select public.refund_closure_authority() v")).rows[0].v, false);
      await asRoot(c);

      // An approver who stops being an admin loses the authority.
      const ex = await makeAdmin(c, "former@example.test");
      await enrolApprover(c, ex);
      await c.query("set session_replication_role = replica");
      await c.query("update profiles set is_admin = false where id = $1", [ex]);
      await c.query("set session_replication_role = origin");
      await asService(c);
      const g = await paidOrder(c, w);
      await cancelPaid(c, w, g.id);
      const gob = (await obligationsOf(c, g.id))[0];
      check("an enrolled approver who is no longer an admin cannot close Test-mode",
        has(await err(testModeClose(c, gob.id, { actor: ex, payment: g.pay, order: g.rzp, amount: 259900 })), "authorised finance approver"),
        "refused: authorised finance approver");
      await asRoot(c);
      await c.query("delete from refund_closure_approvers where user_id = $1", [ex]);
      check("removal is audited", n((await c.query("select count(*) n from payment_refund_events where action = 'closure_approver_removed' and actor = $1", [ex])).rows[0].n), 1);
    }

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== MANUAL: repayment outside Razorpay needs evidence ===");
    {
      const WHY = "Customer refunded in person after cancelling at the stall.";
      const tries: [string, unknown[], string][] = [
        ["no reference", ["refunded_outside_razorpay", WHY, "cash", null, 150000, today], "evidence reference"],
        ["no method", ["refunded_outside_razorpay", WHY, null, "Receipt R-0042", 150000, today], "how the money was returned"],
        ["unknown method", ["refunded_outside_razorpay", WHY, "cheque", "Receipt R-0042", 150000, today], "how the money was returned"],
        ["no date", ["refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", 150000, null], "date the money was returned"],
        ["future date", ["refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", 150000, tomorrow], "date the money was returned"],
        ["before the order existed", ["refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", 150000, "2020-01-01"], "before the order existed"],
        ["no amount", ["refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", null, today], "must equal"],
        ["wrong amount", ["refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", 100000, today], "must equal"],
        ["short reason", ["refunded_outside_razorpay", "cash back", "cash", "Receipt R-0042", 150000, today], "20 characters"],
        ["unknown kind", ["refunded", WHY, "cash", "Receipt R-0042", 150000, today], "Say why"],
      ];
      for (const [label, args, part] of tries) {
        const [kind, reason, method, ref, amount, on] = args as [string, string, string | null, string | null, number | null, string | null];
        check(`approver, ${label} → refused`, has(await err(close(c, w.admin, manualOb, kind, reason, method, ref, amount, on)), part), `refused: ${part}`);
      }
      const r = await close(c, w.admin, manualOb, "refunded_outside_razorpay", WHY, "cash", "Receipt R-0042", 150000, today);
      check("approver with method, reference, amount, date → closed", [r.outcome, n(r.written_off_paise)], ["closed", 150000]);
      const ob = (await c.query("select * from refund_obligations where id = $1", [manualOb])).rows[0];
      check("…the repayment details are kept", [ob.close_kind, ob.close_method, ob.close_reference, n(ob.close_amount_paise), ob.closed_by === w.admin],
        ["refunded_outside_razorpay", "cash", "Receipt R-0042", 150000, true]);
      const led = (await c.query("select * from refund_ledger where $1 = any(obligation_ids)", [manualOb])).rows[0];
      check("…ledger: written off, NOT verified refunded", [n(led.refunded_paise), n(led.written_off_paise), n(led.outstanding_paise), led.close_kinds], [0, 150000, 0, ["refunded_outside_razorpay"]]);
      check("…the details cannot be edited afterwards", has(await err(c.query("update refund_obligations set close_reference = 'Receipt R-9999' where id = $1", [manualOb])), "cannot be reopened"), "refused: cannot be reopened");

      // A manual order where no money ever came.
      const m2 = await manualPaidOrder(c, w, 900);
      await cancelPaid(c, w, m2.id);
      const ob2 = (await obligationsOf(c, m2.id))[0];
      const NONE = "Order keyed in before payment; the customer never paid. Till report checked.";
      check("no_funds_received with a repayment amount → refused", has(await err(close(c, w.admin, ob2.id, "no_funds_received", NONE, null, "Till report 2026-11-10", 90000, null)), "no repayment method"), "refused: no repayment method");
      check("no_funds_received without an evidence reference → refused", has(await err(close(c, w.admin, ob2.id, "no_funds_received", NONE, null, null, null, null)), "evidence reference"), "refused: evidence reference");
      check("ordinary admin: no_funds_received refused", has(await err(close(c, clerk, ob2.id, "no_funds_received", NONE, null, "Till report 2026-11-10", null, null)), "authorised finance approver"), "refused: authorised finance approver");
      const r2 = await close(c, w.admin, ob2.id, "no_funds_received", NONE, null, "Till report 2026-11-10", null, null);
      check("approver: no_funds_received on a manual order → closed", r2.outcome, "closed");

      const p = await paidOrder(c, w);
      await cancelPaid(c, w, p.id);
      const pob = (await obligationsOf(c, p.id))[0];
      check("no_funds_received on Razorpay-captured money → refused",
        has(await err(close(c, w.admin, pob.id, "no_funds_received", NONE, null, "Till report 2026-11-10", null, null)), "Razorpay captured this money"),
        "refused: Razorpay captured this money");
      check("customer-style direct UPDATE still refused", has(await err((async () => { await asAdmin(c, w.admin); try { await c.query("update refund_obligations set closed_at = now() where id = $1", [pob.id]); } finally { await asRoot(c); } })()), "permission denied"), "refused: permission denied");
    }

    // ════════════════════════════════════════════════════════════════════
    console.log("\n=== TESTMODE: only on Razorpay's answer under Test keys ===");
    {
      const t = await paidOrder(c, w);
      await cancelPaid(c, w, t.id);
      const tob = (await obligationsOf(c, t.id))[0];
      const ok: TestModeFacts = { actor: w.admin, payment: t.pay, order: t.rzp, amount: 259900 };
      await asAdmin(c, w.admin);
      check("an admin session cannot call record_test_mode_closure", has(await err(c.query(
        "select public.record_test_mode_closure($1, $2, 'Razorpay Test-mode payment; never real money.', 'test', $3, $4, 259900, 'INR', true, 'captured')",
        [tob.id, w.admin, t.pay, t.rzp])), "permission denied"), "refused: permission denied");
      await asRoot(c);
      check("actor not an approver → refused", has(await err(testModeClose(c, tob.id, { ...ok, actor: clerk })), "authorised finance approver"), "refused: authorised finance approver");
      check("no actor → refused", has(await err(testModeClose(c, tob.id, { ...ok, actor: null })), "authorised finance approver"), "refused: authorised finance approver");
      check("Live mode → refused", has(await err(testModeClose(c, tob.id, { ...ok, mode: "live" })), "under Test keys"), "refused: under Test keys");
      check("not captured → refused", has(await err(testModeClose(c, tob.id, { ...ok, captured: false })), "captured INR payment"), "refused: captured INR payment");
      check("another order's payment → refused", has(await err(testModeClose(c, tob.id, { ...ok, order: rid("order") })), "belongs to order"), "refused: belongs to order");
      check("another payment → refused", has(await err(testModeClose(c, tob.id, { ...ok, payment: rid("pay") })), "This obligation is for payment"), "refused: This obligation is for payment");
      check("captured less than owed → refused", has(await err(testModeClose(c, tob.id, { ...ok, amount: 1000 })), "investigate"), "refused: investigate");
      check("short reason → refused", has(await err(testModeClose(c, tob.id, { ...ok, reason: "test" })), "20 characters"), "refused: 20 characters");
      await asAdmin(c, w.admin);
      await c.query("select public.admin_claim_refund($1, $2)", [tob.id, rid("rfnd")]);
      await asRoot(c);
      check("with an unverified refund id on the payment → refused", has(await err(testModeClose(c, tob.id, ok)), "still unverified"), "refused: still unverified");

      const t2 = await paidOrder(c, w);
      await cancelPaid(c, w, t2.id);
      const t3 = await paidOrder(c, w);
      await cancelPaid(c, w, t3.id);
      const t2ob = (await obligationsOf(c, t2.id))[0];
      const r = await testModeClose(c, t2ob.id, { actor: w.admin, payment: t2.pay, order: t2.rzp, amount: 259900 });
      check("approver + Razorpay Test-mode evidence → closed", [r.outcome, n(r.written_off_paise)], ["closed", 259900]);
      const ob = (await c.query("select * from refund_obligations where id = $1", [t2ob.id])).rows[0];
      check("…evidence kept: mode test, payment, captured", [ob.close_kind, ob.close_evidence.provider_mode, ob.close_evidence.payment_id, ob.close_evidence.captured], ["test_mode_payment", "test", t2.pay, true]);
      const led = await ledgerFor(c, t2.pay);
      check("…ledger: closed without a verified refund (refunded 0)", [n(led.refunded_paise), n(led.written_off_paise), n(led.outstanding_paise), led.close_kinds], [0, 259900, 0, ["test_mode_payment"]]);
      check("…one at a time: the other Test order is still owed", n((await ledgerFor(c, t3.pay)).outstanding_paise), 259900);
      check("…cannot be closed twice", has(await err(testModeClose(c, t2ob.id, { actor: w.admin, payment: t2.pay, order: t2.rzp, amount: 259900 })), "already closed"), "refused: already closed");
      check("…audited as an approver closure with the provider's answer",
        (await c.query("select actor = $2 a, evidence->>'kind' k, evidence->'provider'->>'provider_mode' m from payment_refund_events where obligation_id = $1 and action = 'obligation_closed'", [t2ob.id, w.admin])).rows[0],
        { a: true, k: "test_mode_payment", m: "test" });

      // A pre-0077 order: the Test-mode check learns its payment, once.
      const lg = await legacyPaidOrder(c, w);
      await cancelPaid(c, w, lg.id);
      const lob = (await obligationsOf(c, lg.id))[0];
      check("pre-0077 cancelled order → razorpay_unlinked", [lob.funds_basis, lob.razorpay_payment_id], ["razorpay_unlinked", null]);
      const LP = rid("pay");
      const lr = await testModeClose(c, lob.id, { actor: w.admin, payment: LP, order: lg.rzp, amount: 259900 });
      const lob2 = (await obligationsOf(c, lg.id))[0];
      check("…closed, and linked to the payment Razorpay named", [lr.outcome, lob2.razorpay_payment_id, lob2.funds_basis], ["closed", LP, "razorpay_captured"]);

      // …but never onto a payment already owed separately.
      const lg2 = await legacyPaidOrder(c, w);
      await cancelPaid(c, w, lg2.id);
      const l2ob = (await obligationsOf(c, lg2.id))[0];
      const PX = rid("pay");
      await asRoot(c);
      await c.query(
        `insert into payment_refund_obligations (order_id, razorpay_order_id, razorpay_payment_id, amount_paise, currency, provider_status, reason,
                                                 order_status_at_capture, order_payment_status_at_capture, order_total_paise_at_capture)
         values ($1, $2, $3, 259900, 'INR', 'captured', 'second_payment', 'cancelled', 'paid', 259900)`, [lg2.id, lg2.rzp, PX]);
      check("legacy link onto a payment already owed separately → refused",
        has(await err(testModeClose(c, l2ob.id, { actor: w.admin, payment: PX, order: lg2.rzp, amount: 259900 })), "already recorded against another obligation"),
        "refused: already recorded against another obligation");
      check("…the legacy obligation is untouched", (await obligationsOf(c, lg2.id)).filter((o) => o.source === "credit_note").map((o) => [o.razorpay_payment_id, o.funds_basis, o.closed_at]), [[null, "razorpay_unlinked", null]]);

      const m3 = await manualPaidOrder(c, w, 700);
      await cancelPaid(c, w, m3.id);
      const m3ob = (await obligationsOf(c, m3.id))[0];
      check("basis cannot be forged by root UPDATE (manual → captured)", has(await err(c.query("update refund_obligations set funds_basis = 'razorpay_captured' where id = $1", [m3ob.id])), "changes only when Razorpay names"), "refused: changes only when Razorpay names");
      check("…nor by also inventing a payment id", has(await err(c.query("update refund_obligations set funds_basis = 'razorpay_captured', razorpay_payment_id = $2 where id = $1", [m3ob.id, rid("pay")])), "cannot be changed once known"), "refused: cannot be changed once known");
      check("basis cannot go back (captured → unlinked)", has(await err(c.query("update refund_obligations set funds_basis = 'razorpay_unlinked' where id = $1", [lob2.id])), "changes only when Razorpay names"), "refused: changes only when Razorpay names");
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
