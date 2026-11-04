/**
 * OS-1 (WP-ORDER-SAFETY-02): a captured payment never revives a cancelled order.
 *
 * On a real PostgreSQL 17.6 server (scripts/pg-world.ts), through the real
 * roles: settlement as service_role, the admin as an aal2 session.
 *
 *   CONTROL  a database through 0073 (before 0077), driven with the call
 *            sequence lib/settleOrder used before OS-1 — reserve_stock, mark
 *            paid, assign_invoice_number, claim the confirmation, each its own
 *            transaction. D5 and D6 are asserted to REPRODUCE there, so the
 *            scenarios are proven to reach the defect.
 *   OS-1     a database through 0077: the same scenarios through
 *            settle_razorpay_payment, plus the old call sequence again (the
 *            deploy window: 0077 applied, old code still running).
 *
 * Concurrency scenarios are FORCED to overlap: the first transaction holds its
 * lock and the test waits until Postgres reports the second blocked on it
 * (pg_blocking_pids) before committing. A scenario that never waited fails.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres@17.6.0-beta.15> \
 *     npx tsx scripts/os1-settlement.test.ts
 *
 * Fictional data only. Never touches a real database or Razorpay. Exits
 * non-zero on failure, and on a missing harness (it does not skip silently).
 */
import { asAdmin, asRoot, asService, asUser, makeAdmin, startEngine, type Client, type Engine } from "./pg-world";
import { liveProduct, liveRow, movements } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

type Outcome = { value?: unknown; error?: string; code?: string };
const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then((value) => ({ value }), (e) => ({ error: (e as Error).message, code: (e as { code?: string }).code }));

async function pidOf(c: Client): Promise<number> {
  return (await c.query("select pg_backend_pid() p")).rows[0].p as number;
}
async function waitsOn(observer: Client, waiter: number, holder: number, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await observer.query("select pg_blocking_pids($1) b", [waiter]);
    if ((rows[0]?.b as number[] | undefined)?.includes(holder)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

interface World {
  root: Client;
  a: Client;
  b: Client;
  obs: Client;
  admin: string;
  pa: number;
  pb: number;
}

async function world(engine: Engine, db: string): Promise<World> {
  const root = await engine.connect(db);
  const a = await engine.connect(db);
  const b = await engine.connect(db);
  const obs = await engine.connect(db);
  for (const c of [a, b]) {
    await c.query("set statement_timeout = '20s'");
    await c.query("set lock_timeout = '15s'");
  }
  const admin = await makeAdmin(root);
  return { root, a, b, obs, admin, pa: await pidOf(a), pb: await pidOf(b) };
}

let seq = 0;
/** A checkout row as handleCreate writes it: pending, one stored line, ₹2,500. */
async function pendingOrder(c: Client, productId: string, opts: { size?: string | null; total?: number; items?: unknown } = {}) {
  seq += 1;
  const rzp = `order_os1_${process.pid}_${seq}`;
  await asRoot(c);
  const items = opts.items ?? [{ id: productId, size: opts.size ?? "One Size", quantity: 1, price_inr: 2500, name: "Piece" }];
  const { rows } = await c.query(
    `insert into orders (items, total_inr, payment_status, status, customer_email, payment_provider, razorpay_order_id)
     values ($1::jsonb, $2, 'pending', 'placed', 'buyer@example.test', 'razorpay', $3) returning id`,
    [JSON.stringify(items), opts.total ?? 2500, rzp]
  );
  return { id: rows[0].id as string, rzp };
}

/** settle_razorpay_payment as settlement calls it (service_role). */
async function settleNew(
  c: Client,
  rzp: string,
  pay: string,
  over: Partial<{ amount: number | null; currency: string | null; status: string | null; fee: number | null; tax: number | null }> = {}
) {
  await asService(c);
  try {
    return (await c.query("select public.settle_razorpay_payment($1, $2, $3, $4, $5, $6, $7) r", [
      rzp,
      pay,
      "amount" in over ? over.amount : 250000,
      "currency" in over ? over.currency : "INR",
      "fee" in over ? over.fee : 5900,
      "tax" in over ? over.tax : 900,
      "status" in over ? over.status : "captured",
    ])).rows[0].r as Record<string, unknown>;
  } finally {
    await asRoot(c);
  }
}

/** The pre-OS-1 settlement: four separate calls, as lib/settleOrder made them. */
async function settleOld(c: Client, orderId: string, productId: string) {
  await asService(c);
  const step = async (sql: string, args: unknown[]) => (await outcome(c.query(sql, args))).error ?? null;
  try {
    return {
      reserve: await step("select public.reserve_stock($1::jsonb, $2)", [
        JSON.stringify([{ id: productId, size: "One Size", quantity: 1 }]), orderId]),
      paid: await step("update orders set payment_status = 'paid', total_inr = 2500, gateway_fee_inr = 59, gateway_tax_inr = 9 where id = $1", [orderId]),
      invoice: await step("select public.assign_invoice_number($1)", [orderId]),
      claim: await step("update orders set confirmation_sent_at = now() where id = $1 and confirmation_sent_at is null", [orderId]),
    };
  } finally {
    await asRoot(c);
  }
}

async function adminCancelUnpaid(c: Client, admin: string, orderId: string) {
  await asAdmin(c, admin);
  try {
    return (await outcome(c.query("update orders set status = 'cancelled' where id = $1", [orderId]))).error ?? null;
  } finally {
    await asRoot(c);
  }
}

async function cancelOrder(c: Client, admin: string, orderId: string) {
  await asAdmin(c, admin);
  try {
    return await outcome(c.query("select public.cancel_order($1, 'OS-1 test') r", [orderId]).then((r) => r.rows[0].r));
  } finally {
    await asRoot(c);
  }
}

async function state(c: Client, orderId: string, productId: string, hasPaymentId = true) {
  await asRoot(c);
  const o = (await c.query(
    `select status, payment_status, invoice_number is not null as invoiced, needs_review,
            confirmation_sent_at is not null as confirmed, total_inr::text as total
            ${hasPaymentId ? ", razorpay_payment_id" : ""}
       from orders where id = $1`,
    [orderId]
  )).rows[0];
  const ms = (await movements(c, productId)).filter((m) => m.order_id === orderId);
  return {
    status: o.status as string,
    payment: o.payment_status as string,
    invoiced: o.invoiced as boolean,
    review: o.needs_review as boolean,
    confirmed: o.confirmed as boolean,
    paymentId: (o.razorpay_payment_id ?? null) as string | null,
    sales: ms.filter((m) => m.reason === "sale").length,
    returns: ms.filter((m) => m.reason === "cancellation").length,
    shelf: (await liveRow(c, productId))!.stock_quantity,
  };
}

async function obligations(c: Client, orderId: string) {
  await asRoot(c);
  return (await c.query(
    `select razorpay_payment_id, amount_paise::int, currency, gateway_fee_paise::int fee, gateway_tax_paise::int tax,
            provider_status, reason, order_status_at_capture, order_payment_status_at_capture, state, times_seen
       from payment_refund_obligations where order_id = $1 order by first_seen_at`,
    [orderId]
  )).rows;
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.error("FAIL: PG_HARNESS_DIR is not set or embedded-postgres is missing — nothing was tested.");
    process.exit(2);
  }
  try {
    console.log(`Engine: ${engine.version}`);
    if (!/PostgreSQL 17\.6/.test(engine.version)) console.log("  NOTE: not PostgreSQL 17.6 — production runs 17.6.");
    await engine.database("os1_old", "0073");
    await engine.database("os1_new");
    const old = await world(engine, "os1_old");
    const w = await world(engine, "os1_new");

    // ════ CONTROL: the defects reproduce before 0077 ════
    console.log("\nCONTROL (through 0073, pre-OS-1 settlement sequence)");
    {
      const p = await liveProduct(old.root, old.admin, { stock: 3 });
      const o = await pendingOrder(old.root, p.productId);
      check("D5 setup: admin cancels the unpaid order", await adminCancelUnpaid(old.root, old.admin, o.id), null);
      const steps = await settleOld(old.root, o.id, p.productId);
      check("D5 REPRODUCES: every settlement step succeeds on the cancelled order", steps, { reserve: null, paid: null, invoice: null, claim: null });
      const s = await state(old.root, o.id, p.productId, false);
      check("D5 REPRODUCES: cancelled yet paid, invoiced, confirmed, stock taken", [s.status, s.payment, s.invoiced, s.confirmed, s.sales, s.shelf], ["cancelled", "paid", true, true, 1, 2]);
      const again = await cancelOrder(old.root, old.admin, o.id);
      check("D5 REPRODUCES: cancel_order then refuses, so no credit note can follow", again.error, "That order is already cancelled");
    }
    {
      const p = await liveProduct(old.root, old.admin, { stock: 0 });
      const o = await pendingOrder(old.root, p.productId);
      await settleOld(old.root, o.id, p.productId); // sold out: paid, no stock taken
      check("D6 setup: cancel_order on the paid, stock-less order", (await cancelOrder(old.root, old.admin, o.id)).error ?? null, null);
      await old.root.query("update product_versions set stock_quantity = 1 where product_id = $1 and state = 'published'", [p.productId]);
      const steps = await settleOld(old.root, o.id, p.productId);
      const s = await state(old.root, o.id, p.productId, false);
      check("D6 REPRODUCES: a settlement retry takes stock for the cancelled order", [steps.reserve, s.sales, s.shelf], [null, 1, 0]);
    }

    // ════ OS-1: the same scenarios through settle_razorpay_payment ════
    console.log("\nOS-1 — D5: payment captured after cancellation");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      check("admin can still cancel an unpaid order", await adminCancelUnpaid(w.root, w.admin, o.id), null);
      const r = await settleNew(w.root, o.rzp, "pay_late_1");
      check("path refund_owed, first sighting", [r.path, r.reason, r.first], ["refund_owed", "captured_after_cancellation", true]);
      const s = await state(w.root, o.id, p.productId);
      check("order stays cancelled and unpaid; no invoice, no confirmation, no stock; flagged", s,
        { status: "cancelled", payment: "pending", invoiced: false, review: true, confirmed: false, paymentId: null, sales: 0, returns: 0, shelf: 3 });
      check("obligation records the provider evidence and why", await obligations(w.root, o.id), [{
        razorpay_payment_id: "pay_late_1", amount_paise: 250000, currency: "INR", fee: 5900, tax: 900, provider_status: "captured",
        reason: "captured_after_cancellation", order_status_at_capture: "cancelled", order_payment_status_at_capture: "pending", state: "owed", times_seen: 1,
      }]);
      const r2 = await settleNew(w.root, o.rzp, "pay_late_1");
      const r3 = await settleNew(w.root, o.rzp, "pay_late_1");
      check("duplicate/delayed deliveries: same obligation, counted, not first", [r2.path, r2.first, r3.first, (await obligations(w.root, o.id)).map((x) => x.times_seen)], ["refund_owed", false, false, [3]]);
      check("…and still nothing else changed", await state(w.root, o.id, p.productId),
        { status: "cancelled", payment: "pending", invoiced: false, review: true, confirmed: false, paymentId: null, sales: 0, returns: 0, shelf: 3 });
      // The admin re-opens the order by hand (possible until OS-2) — the owed payment must not become a sale.
      await asAdmin(w.root, w.admin);
      await w.root.query("update orders set status = 'placed', needs_review = false where id = $1", [o.id]);
      await asRoot(w.root);
      const r4 = await settleNew(w.root, o.rzp, "pay_late_1");
      const s4 = await state(w.root, o.id, p.productId);
      check("re-opened by hand, a replay of the owed payment is still owed: no stock, not paid, re-flagged", [r4.path, s4.payment, s4.sales, s4.invoiced, s4.review], ["refund_owed", "pending", 0, false, true]);
      // A further capture in a later session (a "restart"): same answer.
      const fresh = await engine.connect("os1_new");
      const r5 = await settleNew(fresh, o.rzp, "pay_late_1");
      await fresh.end();
      check("replay from a new connection after restart is idempotent", [r5.path, r5.first, (await obligations(w.root, o.id)).length], ["refund_owed", false, 1]);
    }

    console.log("\nOS-1 — D6: settlement retry after a paid order was cancelled");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 0 });
      const o = await pendingOrder(w.root, p.productId);
      const r = await settleNew(w.root, o.rzp, "pay_d6");
      check("first settlement: sold out → paid, flagged, no stock", [r.path, r.stock, r.flagged, String(r.stock_error).startsWith("SOLD_OUT")], ["settled", "failed", true, true]);
      const c = await cancelOrder(w.root, w.admin, o.id);
      check("cancel_order: credit note, nothing to return", [Boolean((c.value as { credit_note?: unknown })?.credit_note), (c.value as { stock_returned?: boolean })?.stock_returned], [true, false]);
      await w.root.query("update product_versions set stock_quantity = 1 where product_id = $1 and state = 'published'", [p.productId]);
      const again = await settleNew(w.root, o.rzp, "pay_d6");
      const s = await state(w.root, o.id, p.productId);
      check("retry of the same payment: already_settled_cancelled, no stock taken", [again.path, s.sales, s.shelf, s.status], ["already_settled_cancelled", 0, 1, "cancelled"]);
      const direct = await outcome((async () => { await asService(w.root); try { return await w.root.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), o.id]); } finally { await asRoot(w.root); } })());
      check("reserve_stock itself refuses a cancelled order (any caller)", [direct.code, (direct.error ?? "").startsWith("ORDER_CANCELLED:")], ["55000", true]);
    }

    console.log("\nOS-1 — deploy window: 0077 applied, the OLD settlement code still running");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await adminCancelUnpaid(w.root, w.admin, o.id);
      const steps = await settleOld(w.root, o.id, p.productId);
      check("old reserve refused (ORDER_CANCELLED)", (steps.reserve ?? "").startsWith("ORDER_CANCELLED:"), true);
      check("old mark-paid refused", (steps.paid ?? "").startsWith("A cancelled order cannot be marked paid"), true);
      check("old invoice refused", steps.invoice, "A cancelled order is not issued an invoice.");
      check("old confirmation claim refused", steps.claim, "A cancelled order is not sent an order confirmation.");
      const s = await state(w.root, o.id, p.productId);
      check("nothing changed on the cancelled order (the webhook's 500 retries until new code records it)", [s.payment, s.invoiced, s.confirmed, s.sales, s.shelf], ["pending", false, false, 0, 3]);
    }

    console.log("\nOS-1 — normal payments are unchanged");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      const r = await settleNew(w.root, o.rzp, "pay_ok_1");
      check("settled: reserved, not flagged, invoice issued", [r.path, r.stock, r.flagged, typeof r.invoice_number, r.invoice_error], ["settled", "reserved", false, "string", null]);
      await asRoot(w.root);
      const row = (await w.root.query("select total_inr::text t, gateway_fee_inr::text f, gateway_tax_inr::text x from orders where id = $1", [o.id])).rows[0];
      check("captured total, fee and tax recorded as before", [row.t, row.f, row.x], ["2500.00", "59.00", "9.00"]);
      const s = await state(w.root, o.id, p.productId);
      check("paid, payment id recorded, one sale, shelf 3 → 2", [s.status, s.payment, s.paymentId, s.sales, s.shelf, s.review], ["placed", "paid", "pay_ok_1", 1, 2, false]);
      const r2 = await settleNew(w.root, o.rzp, "pay_ok_1");
      const s2 = await state(w.root, o.id, p.productId);
      check("replay (verify + webhook): already_reserved, same invoice, no second sale", [r2.path, r2.stock, r2.invoice_number, s2.sales, s2.shelf], ["settled", "already_reserved", r.invoice_number, 1, 2]);
      await asService(w.root);
      const claim = (await w.root.query("update orders set confirmation_sent_at = now() where id = $1 and confirmation_sent_at is null returning id", [o.id])).rowCount;
      await asRoot(w.root);
      check("confirmation claim on an open paid order still works", claim, 1);
      const c = await cancelOrder(w.root, w.admin, o.id);
      const cn = c.value as { credit_note?: { invoice_number?: string }; stock_returned?: boolean };
      check("cancel_order on it: credit note names the invoice, stock back", [cn?.credit_note?.invoice_number, cn?.stock_returned], [r.invoice_number, true]);
      const s3 = await state(w.root, o.id, p.productId);
      check("cancelled paid order keeps paid, invoice and confirmation", [s3.status, s3.payment, s3.invoiced, s3.confirmed, s3.shelf], ["cancelled", "paid", true, true, 3]);
      const r3 = await settleNew(w.root, o.rzp, "pay_ok_1");
      const s4 = await state(w.root, o.id, p.productId);
      check("late replay after cancel_order: already_settled_cancelled, no stock taken, no obligation", [r3.path, s4.sales, s4.returns, s4.shelf, (await obligations(w.root, o.id)).length], ["already_settled_cancelled", 1, 1, 3, 0]);
    }
    {
      const p = await liveProduct(w.root, w.admin, { sizes: [{ label: "S", stock_quantity: 2 }, { label: "M", stock_quantity: 1 }] });
      const o = await pendingOrder(w.root, p.productId, { size: "M" });
      const r = await settleNew(w.root, o.rzp, "pay_sized");
      const m = (await w.root.query("select stock_quantity from product_sizes where product_id = $1 and label = 'M'", [p.productId])).rows[0].stock_quantity;
      check("sized product: the stored size is decremented", [r.path, r.stock, m], ["settled", "reserved", 0]);
    }
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId, { items: [] });
      const r = await settleNew(w.root, o.rzp, "pay_nolines");
      const s = await state(w.root, o.id, p.productId);
      check("no stored lines: paid and flagged, no stock, no invoice (as before)", [r.path, r.stock, r.flagged, s.payment, s.review, s.invoiced], ["settled", "none", true, "paid", true, false]);
    }
    {
      // An order settled before 0077 has no payment id. A replay fills it and changes nothing else.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await settleNew(w.root, o.rzp, "pay_hist");
      // Simulate a pre-0077 row: the guard (rightly) refuses clearing the id, so
      // the fixture bypasses triggers for this one statement.
      await w.root.query("set session_replication_role = replica");
      await w.root.query("update orders set razorpay_payment_id = null where id = $1", [o.id]);
      await w.root.query("set session_replication_role = origin");
      const r = await settleNew(w.root, o.rzp, "pay_hist");
      const s = await state(w.root, o.id, p.productId);
      check("historical paid order (no payment id): replay settles idempotently and records the id", [r.path, r.stock, s.paymentId, s.sales, s.shelf], ["settled", "already_reserved", "pay_hist", 1, 2]);
    }

    console.log("\nOS-1 — a second, different payment");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await settleNew(w.root, o.rzp, "pay_first");
      const r = await settleNew(w.root, o.rzp, "pay_second");
      const s = await state(w.root, o.id, p.productId);
      const ob = await obligations(w.root, o.id);
      check("second payment on a paid order: refund owed, order otherwise unchanged", [r.path, r.reason, s.paymentId, s.sales, s.shelf, s.review], ["refund_owed", "second_payment", "pay_first", 1, 2, true]);
      check("…with its evidence", ob.map((x) => [x.razorpay_payment_id, x.reason, x.order_payment_status_at_capture]), [["pay_second", "second_payment", "paid"]]);
      await cancelOrder(w.root, w.admin, o.id);
      const r2 = await settleNew(w.root, o.rzp, "pay_third");
      check("a different payment after cancel_order: refund owed (second_payment)", [r2.path, r2.reason], ["refund_owed", "second_payment"]);
    }

    console.log("\nOS-1 — evidence that is missing or not a capture fails closed");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      const bad: [string, Partial<{ amount: number | null; currency: string | null; status: string | null }>, string][] = [
        ["authorized", { status: "authorized" }, "22023"],
        ["no status", { status: null }, "22023"],
        ["USD", { currency: "USD" }, "22023"],
        ["zero amount", { amount: 0 }, "22023"],
        ["no amount", { amount: null }, "22023"],
      ];
      for (const [label, over, code] of bad) {
        const r = await outcome(settleNew(w.root, o.rzp, "pay_bad", over));
        check(`refused: ${label}`, r.code, code);
      }
      check("refused: empty payment id", (await outcome(settleNew(w.root, o.rzp, " "))).code, "22023");
      const mm = await settleNew(w.root, o.rzp, "pay_mm", { amount: 249900 });
      check("amount that differs from the stored total: mismatch", mm.path, "mismatch");
      const none = await settleNew(w.root, "order_does_not_exist", "pay_none");
      check("unknown Razorpay order: no_order (settleOrder records a thin flagged row, as before)", none.path, "no_order");
      const s = await state(w.root, o.id, p.productId);
      check("after all refusals: nothing written", [s.payment, s.sales, s.shelf, s.review, (await obligations(w.root, o.id)).length], ["pending", 0, 3, false, 0]);
    }

    console.log("\nOS-1 — failure injection");
    {
      // Invoice numbering fails inside the transaction: payment still recorded, error reported, no invoice.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      const was = (await w.root.query("select last_value::bigint v, is_called from invoice_number_seq")).rows[0];
      await w.root.query("alter sequence invoice_number_seq maxvalue 1000");
      await w.root.query("select setval('invoice_number_seq', 1000, true)");
      const r = await settleNew(w.root, o.rzp, "pay_noinv");
      await w.root.query("alter sequence invoice_number_seq no maxvalue");
      await w.root.query("select setval('invoice_number_seq', $1, $2)", [was.v, was.is_called]);
      const s = await state(w.root, o.id, p.productId);
      check("invoice failure is reported, not fatal: paid, stock taken, no invoice", [r.path, String(r.invoice_error).includes("maximum value"), s.payment, s.sales, s.invoiced], ["settled", true, "paid", 1, false]);
      const r2 = await settleNew(w.root, o.rzp, "pay_noinv");
      check("the replay issues the missing invoice", [r2.path, typeof r2.invoice_number], ["settled", "string"]);
    }
    {
      // The database fails mid-settlement (lock timeout): one transaction, so nothing at all is written; a retry succeeds.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await w.b.query("begin");
      await w.b.query("select 1 from orders where id = $1 for update", [o.id]);
      await w.a.query("set lock_timeout = '300ms'");
      const r = await outcome(settleNew(w.a, o.rzp, "pay_fail"));
      await w.a.query("set lock_timeout = '15s'");
      await w.b.query("rollback");
      const s = await state(w.root, o.id, p.productId);
      check("database failure after capture: error, and no partial write", [r.code, s.payment, s.sales, s.shelf, s.invoiced], ["55P03", "pending", 0, 3, false]);
      const r2 = await settleNew(w.root, o.rzp, "pay_fail");
      check("retry after the failure settles normally", [r2.path, r2.stock], ["settled", "reserved"]);
    }

    console.log("\nOS-1 — concurrency (forced overlap)");
    {
      // Cancellation first, holding its lock; settlement waits, then sees cancelled.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await asAdmin(w.a, w.admin);
      await w.a.query("begin");
      await w.a.query("update orders set status = 'cancelled' where id = $1", [o.id]);
      const pending = outcome(settleNew(w.b, o.rzp, "pay_race_1"));
      check("settlement blocked on the cancelling transaction", await waitsOn(w.obs, w.pb, w.pa), true);
      await w.a.query("commit");
      await asRoot(w.a);
      const r = (await pending).value as Record<string, unknown>;
      const s = await state(w.root, o.id, p.productId);
      check("cancel committed first → refund owed, nothing fulfilled", [r?.path, s.status, s.payment, s.sales, s.invoiced], ["refund_owed", "cancelled", "pending", 0, false]);
    }
    {
      // Settlement first, holding its lock; the admin's plain cancel waits, then is refused (paid, no credit note).
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await asService(w.a);
      await w.a.query("begin");
      await w.a.query("select public.settle_razorpay_payment($1, 'pay_race_2', 250000, 'INR', 5900, 900, 'captured')", [o.rzp]);
      await asAdmin(w.b, w.admin);
      const pending = outcome(w.b.query("update orders set status = 'cancelled' where id = $1", [o.id]));
      check("plain cancel blocked on the settling transaction", await waitsOn(w.obs, w.pb, w.pa), true);
      await w.a.query("commit");
      await asRoot(w.a);
      const r = await pending;
      await asRoot(w.b);
      check("capture committed first → plain cancel refused (0049: needs a credit note)", (r.error ?? "").startsWith("A paid order cannot be cancelled directly"), true);
      const s = await state(w.root, o.id, p.productId);
      check("…and the order is a normal paid order", [s.status, s.payment, s.sales, s.invoiced], ["placed", "paid", 1, true]);
    }
    {
      // Settlement and cancel_order at the same moment: cancel_order waits, then credits a paid order and returns its stock.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await asService(w.a);
      await w.a.query("begin");
      const inv = (await w.a.query("select public.settle_razorpay_payment($1, 'pay_race_3', 250000, 'INR', 5900, 900, 'captured') r", [o.rzp])).rows[0].r.invoice_number;
      await asAdmin(w.b, w.admin);
      const pending = outcome(w.b.query("select public.cancel_order($1, 'race') r", [o.id]).then((x) => x.rows[0].r));
      check("cancel_order blocked on the settling transaction", await waitsOn(w.obs, w.pb, w.pa), true);
      await w.a.query("commit");
      await asRoot(w.a);
      const r = (await pending).value as { credit_note?: { invoice_number?: string }; stock_returned?: boolean };
      await asRoot(w.b);
      const s = await state(w.root, o.id, p.productId);
      check("simultaneous capture + cancel_order: credit note against the invoice, stock back once", [r?.credit_note?.invoice_number, r?.stock_returned, s.sales, s.returns, s.shelf], [inv, true, 1, 1, 3]);
      await asService(w.root);
      const claim = await outcome(w.root.query("update orders set confirmation_sent_at = now() where id = $1 and confirmation_sent_at is null", [o.id]));
      await asRoot(w.root);
      check("a confirmation claimed after that cancellation is refused", claim.error, "A cancelled order is not sent an order confirmation.");
    }
    {
      // Browser verify and webhook at once, same payment.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await asService(w.a);
      await w.a.query("begin");
      const first = (await w.a.query("select public.settle_razorpay_payment($1, 'pay_race_4', 250000, 'INR', 5900, 900, 'captured') r", [o.rzp])).rows[0].r;
      const pending = outcome(settleNew(w.b, o.rzp, "pay_race_4"));
      check("second settlement blocked on the first", await waitsOn(w.obs, w.pb, w.pa), true);
      await w.a.query("commit");
      await asRoot(w.a);
      const second = (await pending).value as Record<string, unknown>;
      const s = await state(w.root, o.id, p.productId);
      check("verify + webhook together: one sale, one invoice", [first.stock, second?.stock, second?.invoice_number === first.invoice_number, s.sales, s.shelf], ["reserved", "already_reserved", true, 1, 2]);
    }
    {
      // Two deliveries for a cancelled order at once: one obligation, seen twice.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await adminCancelUnpaid(w.root, w.admin, o.id);
      await asService(w.a);
      await w.a.query("begin");
      await w.a.query("select public.settle_razorpay_payment($1, 'pay_race_5', 250000, 'INR', 5900, 900, 'captured')", [o.rzp]);
      const pending = outcome(settleNew(w.b, o.rzp, "pay_race_5"));
      check("duplicate delivery blocked on the first", await waitsOn(w.obs, w.pb, w.pa), true);
      await w.a.query("commit");
      await asRoot(w.a);
      const second = (await pending).value as Record<string, unknown>;
      check("concurrent duplicates on a cancelled order: one obligation, seen twice", [second?.path, second?.first, (await obligations(w.root, o.id)).map((x) => x.times_seen)], ["refund_owed", false, [2]]);
    }

    console.log("\nOS-1 — in-person (manual) orders and the cancellation guard");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      await asRoot(w.root);
      const id = (await w.root.query(
        `insert into orders (items, total_inr, payment_status, status, customer_email, payment_method)
         values ($1::jsonb, 2500, 'paid', 'confirmed', 'stall@example.test', 'cash') returning id`,
        [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1, price_inr: 2500 }])]
      )).rows[0].id as string;
      await asService(w.root);
      const res = await outcome(w.root.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), id]));
      const inv = await outcome(w.root.query("select public.assign_invoice_number($1) n", [id]));
      await asRoot(w.root);
      check("manual order: reserve_stock and invoice unchanged", [res.error ?? null, typeof (inv.value as { rows: { n: string }[] })?.rows?.[0]?.n], [null, "string"]);
      const c = await cancelOrder(w.root, w.admin, id);
      check("manual order: cancel_order still credits and returns stock", (c.value as { stock_returned?: boolean })?.stock_returned, true);
    }
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await asAdmin(w.root, w.admin);
      const both = await outcome(w.root.query("update orders set status = 'cancelled', payment_status = 'paid' where id = $1", [o.id]));
      await asRoot(w.root);
      // 0049's guard fires first (triggers run in name order) and refuses it as
      // "paid without a credit note"; 0077's guard would refuse it next.
      check("cancelled-and-paid in one admin UPDATE is refused", [both.code, (both.error ?? "").startsWith("A paid order cannot be cancelled directly")], ["P0001", true]);
      await asRoot(w.root);
      await w.root.query("alter table orders disable trigger orders_cancel_guard");
      await asAdmin(w.root, w.admin);
      const only0077 = await outcome(w.root.query("update orders set status = 'cancelled', payment_status = 'paid' where id = $1", [o.id]));
      await asRoot(w.root);
      await w.root.query("alter table orders enable trigger orders_cancel_guard");
      check("…and 0077's guard refuses it on its own", [only0077.code, (only0077.error ?? "").startsWith("A cancelled order cannot be marked paid")], ["55000", true]);
    }

    console.log("\nOS-1 — refund-owed integrity (final review)");
    // The operator's reconciliation queries (report §4), verbatim.
    const RECON_OWED = `select r.razorpay_payment_id, r.reason, r.amount_paise::int, r.order_total_paise_at_capture::int as expected
                          from payment_refund_obligations r where r.state = 'owed' and r.razorpay_order_id = $1 order by r.first_seen_at`;
    const RECON_UNCOUNTED = `select o.razorpay_payment_id, o.status, o.payment_status from orders o
                              where o.razorpay_payment_id is not null and o.payment_status is distinct from 'paid' and o.razorpay_order_id = $1`;
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await adminCancelUnpaid(w.root, w.admin, o.id);
      const a = await settleNew(w.root, o.rzp, "pay_dist_a");
      const b = await settleNew(w.root, o.rzp, "pay_dist_b", { amount: 260000 });
      await settleNew(w.root, o.rzp, "pay_dist_a");
      await asRoot(w.root);
      check("two distinct late payments: two obligations, each its own payment id and amount (one differs from the total)",
        [a.path, b.path, (await w.root.query(RECON_OWED, [o.rzp])).rows],
        ["refund_owed", "refund_owed", [
          { razorpay_payment_id: "pay_dist_a", reason: "captured_after_cancellation", amount_paise: 250000, expected: 250000 },
          { razorpay_payment_id: "pay_dist_b", reason: "captured_after_cancellation", amount_paise: 260000, expected: 250000 },
        ]]);
      check("…and the repeat of pay_dist_a counted on its own row only", (await obligations(w.root, o.id)).map((x) => [x.razorpay_payment_id, x.times_seen]), [["pay_dist_a", 2], ["pay_dist_b", 1]]);
      const contra = await outcome(settleNew(w.root, o.rzp, "pay_dist_a", { amount: 999900 }));
      check("a repeat with different evidence for the same payment id is refused (55000), nothing changed",
        [contra.code, (await obligations(w.root, o.id)).map((x) => [x.razorpay_payment_id, x.amount_paise, x.times_seen])],
        ["55000", [["pay_dist_a", 250000, 2], ["pay_dist_b", 260000, 1]]]);
      const s = await state(w.root, o.id, p.productId);
      check("no sale from any of them", [s.status, s.payment, s.sales, s.shelf, s.invoiced], ["cancelled", "pending", 0, 3, false]);

      // Ordinary order edits cannot make an obligation disappear.
      await asAdmin(w.root, w.admin);
      await w.root.query("update orders set needs_review = false, admin_note = 'checked', status = 'placed' where id = $1", [o.id]);
      const del = await outcome(w.root.query("delete from orders where id = $1", [o.id]));
      await asRoot(w.root);
      check("admin clears the flag and edits the order: obligations still listed", (await w.root.query(RECON_OWED, [o.rzp])).rows.length, 2);
      check("admin cannot delete an order", del.code, "42501");
      await asService(w.root);
      await w.root.query("delete from orders where id = $1", [o.id]);
      await asRoot(w.root);
      check("even if the order row is deleted, the obligations survive with their Razorpay ids",
        (await w.root.query("select order_id, razorpay_order_id from payment_refund_obligations where razorpay_payment_id in ('pay_dist_a','pay_dist_b')")).rows.map((r) => [r.order_id, r.razorpay_order_id]),
        [[null, o.rzp], [null, o.rzp]]);
    }
    {
      // The settling payment id is evidence: no role may change or clear it.
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await settleNew(w.root, o.rzp, "pay_fixed");
      await asAdmin(w.root, w.admin);
      const byAdmin = [
        await outcome(w.root.query("update orders set razorpay_payment_id = 'pay_other' where id = $1", [o.id])),
        await outcome(w.root.query("update orders set razorpay_payment_id = null where id = $1", [o.id])),
      ].map((x) => x.code);
      await asService(w.root);
      const bySvc = (await outcome(w.root.query("update orders set razorpay_payment_id = null where id = $1", [o.id]))).code;
      await asRoot(w.root);
      check("payment id cannot be changed or cleared by an admin or service_role", [byAdmin, bySvc, (await state(w.root, o.id, p.productId)).paymentId], [["55000", "55000"], "55000", "pay_fixed"]);

      // Marking the order unpaid (still possible for an admin until OS-2, D4)
      // must not hide the captured money from reconciliation.
      await asAdmin(w.root, w.admin);
      await w.root.query("update orders set payment_status = 'pending' where id = $1", [o.id]);
      await asRoot(w.root);
      check("an order un-paid by hand still shows its captured payment in the reconciliation query",
        (await w.root.query(RECON_UNCOUNTED, [o.rzp])).rows, [{ razorpay_payment_id: "pay_fixed", status: "placed", payment_status: "pending" }]);
    }

    console.log("\nOS-1 — permissions");
    {
      const p = await liveProduct(w.root, w.admin, { stock: 3 });
      const o = await pendingOrder(w.root, p.productId);
      await adminCancelUnpaid(w.root, w.admin, o.id);
      await settleNew(w.root, o.rzp, "pay_perm");
      const { rows: u } = await w.root.query("insert into auth.users (email) values ('shopper@example.test') returning id");
      await w.root.query("insert into profiles (id, email, is_admin) values ($1, 'shopper@example.test', false) on conflict (id) do nothing", [u[0].id]);
      const call = "select public.settle_razorpay_payment('x', 'y', 1, 'INR', null, null, 'captured')";

      await w.root.query("set role anon");
      check("anon cannot call settle_razorpay_payment", (await outcome(w.root.query(call))).code, "42501");
      check("anon cannot read obligations", (await outcome(w.root.query("select * from payment_refund_obligations"))).code, "42501");
      await asRoot(w.root);

      await asAdmin(w.root, w.admin);
      check("admin cannot call settle_razorpay_payment", (await outcome(w.root.query(call))).code, "42501");
      check("admin reads the obligation", (await w.root.query("select count(*)::int n from payment_refund_obligations where order_id = $1", [o.id])).rows[0].n, 1);
      check("admin cannot insert, update or delete obligations", [
        (await outcome(w.root.query("insert into payment_refund_obligations (razorpay_order_id, razorpay_payment_id, amount_paise, currency, provider_status, reason, order_status_at_capture, order_payment_status_at_capture) values ('a','b',1,'INR','captured','second_payment','placed','paid')"))).code,
        (await outcome(w.root.query("update payment_refund_obligations set times_seen = 99"))).code,
        (await outcome(w.root.query("delete from payment_refund_obligations"))).code,
      ], ["42501", "42501", "42501"]);
      await asRoot(w.root);

      await asUser(w.root, u[0].id, "aal1");
      check("a customer sees no obligations", (await w.root.query("select count(*)::int n from payment_refund_obligations")).rows[0].n, 0);
      await asRoot(w.root);

      await asService(w.root);
      check("service_role can read but not write obligations directly", [
        (await w.root.query("select count(*)::int n from payment_refund_obligations where order_id = $1", [o.id])).rows[0].n,
        (await outcome(w.root.query("update payment_refund_obligations set state = 'owed'"))).code,
      ], [1, "42501"]);
      await asRoot(w.root);

      const states = (await w.root.query("select pg_get_constraintdef(oid) d from pg_constraint where conname = 'payment_refund_obligations_state_check'")).rows[0].d;
      check("no obligation can be marked refunded (only 'owed' exists)", states, "CHECK ((state = 'owed'::text))");
    }

    for (const x of [old, w]) for (const c of [x.root, x.a, x.b, x.obs]) await c.end();
  } finally {
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
