/**
 * OS-2 (WP-ORDER-SAFETY-05): order status, stock return, credit notes and
 * admin edits are decided by the database (migration 0078).
 *
 * On a real PostgreSQL 17.6 server (scripts/pg-world.ts), through the real
 * roles: the admin as an aal2 session, settlement as service_role.
 *
 *   CONTROL  a database through 0077 (OS-1, before 0078). D1–D4 are asserted
 *            to REPRODUCE there, so each scenario is proven to reach the defect.
 *   OS-2     a database through 0078: the same scenarios refused, plus every
 *            legitimate path the admin and settlement still need.
 *   PREFLIGHT a database through 0077 seeded with each data anomaly 0078
 *            refuses to apply over, then a clean apply and a refused re-apply.
 *
 * Concurrency scenarios are FORCED to overlap: the first transaction holds its
 * lock and the test waits until Postgres reports the second blocked on it
 * (pg_blocking_pids) before committing. A scenario that never waited fails.
 *
 *   PG_HARNESS_DIR=<dir with node_modules/embedded-postgres@17.6.0-beta.15> \
 *     npx tsx scripts/os2-order-integrity.test.ts
 *
 * Fictional data only. Never touches a real database or Razorpay. Exits
 * non-zero on failure, and on a missing harness (it does not skip silently).
 */
import fs from "node:fs";
import path from "node:path";
import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, makeAdmin, startEngine, type Client, type Engine } from "./pg-world";
import { liveProduct, liveRow, sizesOf } from "./stock-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const truthy = (name: string, v: unknown) => check(name, Boolean(v), true);

type Outcome = { value?: any; error?: string; code?: string };
const outcome = (p: Promise<unknown>): Promise<Outcome> =>
  p.then((value) => ({ value }), (e) => ({ error: (e as Error).message, code: (e as { code?: string }).code }));
const refused = (o: Outcome, fragment: string) => Boolean(o.error && o.error.includes(fragment));

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
  admin2: string;
  customer: string;
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
  const admin = await makeAdmin(root, "owner@example.test");
  const admin2 = await makeAdmin(root, "second-tab@example.test");
  await asRoot(root);
  const customer = (await root.query("insert into auth.users (email) values ('buyer@example.test') returning id")).rows[0].id as string;
  await root.query("insert into profiles (id, email) values ($1, 'buyer@example.test') on conflict (id) do nothing", [customer]);
  return { root, a, b, obs, admin, admin2, customer, pa: await pidOf(a), pb: await pidOf(b) };
}

let seq = 0;
type Line = { id: string; size?: string | null; quantity?: number; price_inr?: number; name?: string };

/** A checkout row as handleCreate writes it: pending, placed, online. */
async function pendingOrder(c: Client, lines: Line[], total = 2500, extra: { shipping?: number; email?: string } = {}) {
  seq += 1;
  const rzp = `order_os2_${process.pid}_${seq}`;
  await asRoot(c);
  const items = lines.map((l) => ({ id: l.id, size: l.size ?? "One Size", quantity: l.quantity ?? 1, price_inr: l.price_inr ?? 2500, name: l.name ?? "Piece" }));
  const { rows } = await c.query(
    `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name,
                         shipping_address, payment_provider, razorpay_order_id)
     values ($1::jsonb, $2, $3, 'pending', 'placed', $4, 'A Buyer',
             '{"line1":"1 Loom Street","city":"Kochi","postal_code":"682001"}'::jsonb, 'razorpay', $5) returning id`,
    [JSON.stringify(items), total, extra.shipping ?? 0, extra.email ?? "buyer@example.test", rzp]
  );
  return { id: rows[0].id as string, rzp, total };
}

/** settle_razorpay_payment as settlement calls it (service_role, OS-1). */
async function settle(c: Client, rzp: string, pay: string, paise = 250000) {
  await asService(c);
  try {
    return (await c.query("select public.settle_razorpay_payment($1, $2, $3, 'INR', 5900, 900, 'captured') r", [rzp, pay, paise])).rows[0].r;
  } finally {
    await asRoot(c);
  }
}

/** A paid online order with its stock taken, exactly as OS-1 settles one. */
async function paidOrder(c: Client, lines: Line[], total = 2500, extra: { shipping?: number; email?: string } = {}) {
  const o = await pendingOrder(c, lines, total, extra);
  const r = await settle(c, o.rzp, `pay_${o.rzp}`, Math.round(total * 100));
  if (r.path !== "settled" || r.stock !== "reserved") throw new Error(`fixture settlement did not reserve: ${JSON.stringify(r)}`);
  return o;
}

/** An in-person order as /api/admin/orders/manual records it (service_role). */
async function inPersonOrder(c: Client, productId: string, size: string | null = "One Size") {
  await asService(c);
  try {
    const items = [{ id: productId, size, quantity: 1, price_inr: 2500, name: "Piece" }];
    const { rows } = await c.query(
      `insert into orders (items, total_inr, shipping_cost_inr, payment_provider, payment_method, payment_status, status,
                           customer_email, customer_name)
       values ($1::jsonb, 2500, 0, 'offline', 'cash', 'paid', 'confirmed', 'walkin@example.test', 'Walk In') returning id`,
      [JSON.stringify(items)]
    );
    const id = rows[0].id as string;
    await c.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify(items.map(({ id, size, quantity }) => ({ id, size, quantity }))), id]);
    await c.query("select public.assign_invoice_number($1)", [id]);
    return id;
  } finally {
    await asRoot(c);
  }
}

async function as<T>(c: Client, who: "admin" | "service" | "root" | { user: string; aal: "aal1" | "aal2" | null } | { staff: string }, w: World, fn: () => Promise<T>, adminId?: string): Promise<T> {
  if (who === "admin") await asAdmin(c, adminId ?? w.admin);
  else if (who === "service") await asService(c);
  else if (who === "root") await asRoot(c);
  else if ("staff" in who) await asStaffPasswordOnly(c, who.staff);
  else await asUser(c, who.user, who.aal);
  try {
    return await fn();
  } finally {
    await asRoot(c);
  }
}

const rpc = (c: Client, sql: string, args: unknown[]) => c.query(sql, args).then((r) => r.rows[0]?.r);
const cancelOrder = (c: Client, id: string, reason: string | null = "Customer changed their mind") =>
  rpc(c, "select public.cancel_order($1, $2) r", [id, reason]);
const cancelUnpaid = (c: Client, id: string, reason: string | null = "Abandoned checkout") =>
  rpc(c, "select public.cancel_unpaid_order($1, $2) r", [id, reason]);
const setStatus = (c: Client, id: string, status: string, reason: string | null = null) =>
  rpc(c, "select public.admin_set_order_status($1, $2, $3) r", [id, status, reason]);

/**
 * True when the database has 0075's dispatch_order (the post-Step-F release
 * order: 0074–0077 then 0078). Shipping is then dispatch_order and 0075's guard
 * owns the courier fields; before it, the courier and tracking number are saved
 * and admin_set_order_status marks the order shipped. The suite runs on both.
 */
async function hasDispatch(c: Client) {
  return (await c.query("select to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null as v")).rows[0].v === true;
}
let DISPATCH = false;
/** Ship as the admin the connection already is. */
async function ship(c: Client, id: string, reason: string | null = null) {
  if (DISPATCH) return rpc(c, "select public.dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true, false) r", [id]);
  await c.query("update orders set courier_name = 'Speed Post', awb_number = 'EE123456785IN' where id = $1", [id]);
  return setStatus(c, id, "shipped", reason);
}

async function orderRow(c: Client, id: string) {
  await asRoot(c);
  return (await c.query(
    "select status, payment_status, total_inr::text total, shipping_cost_inr::text shipping, needs_review, cancelled_at is not null as cancelled_stamped, shipped_at is not null as shipped_stamped, delivered_at is not null as delivered_stamped, invoice_number, admin_note from orders where id = $1",
    [id]
  )).rows[0];
}
async function notes(c: Client, id: string) {
  await asRoot(c);
  return (await c.query("select kind, amount_inr::text amount from credit_notes where order_id = $1 order by issued_at, credit_note_number", [id])).rows;
}
async function orderMoves(c: Client, id: string) {
  await asRoot(c);
  return (await c.query("select reason, delta, coalesce(size_label, '') size from stock_movements where order_id = $1 order by created_at, reason, size_label", [id])).rows;
}
const shelf = async (c: Client, productId: string) => (await liveRow(c, productId))!.stock_quantity as number;
async function sizeShelf(c: Client, productId: string, label: string) {
  await asRoot(c);
  return (await sizesOf(c, productId))[label];
}
async function events(c: Client, id: string) {
  await asRoot(c);
  return (await c.query(
    "select operation, action, actor_id, actor_email, actor_role, from_status, to_status, from_payment_status, to_payment_status, changes, reason from order_events where order_id = $1 order by id",
    [id]
  )).rows;
}

// ════════════════════════════════════════════════════════════════════════════
// CONTROL: 0001–0077. The defects must reproduce.
// ════════════════════════════════════════════════════════════════════════════
async function control(engine: Engine) {
  console.log("\nCONTROL (through 0077 — OS-1 applied, OS-2 not)");
  await engine.database("os2_control", "0077");
  const w = await world(engine, "os2_control");
  const { root } = w;
  const p = await liveProduct(root, w.admin, { stock: 5 });

  // D1 — cancel a shipped order: the stock goes back on the shelf.
  const d1 = await paidOrder(root, [{ id: p.productId }]);
  DISPATCH = await hasDispatch(root);
  await as(root, "admin", w, () => DISPATCH
    ? root.query("select public.dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true, false)", [d1.id])
    : root.query("update orders set status = 'shipped', awb_number = 'AWB1', shipped_at = now() where id = $1", [d1.id]));
  const d1Before = await shelf(root, p.productId);
  const d1Cancel = await as(root, "admin", w, () => outcome(cancelOrder(root, d1.id)));
  check("D1 REPRODUCES: a shipped order can be cancelled", d1Cancel.error ?? null, null);
  check("D1 REPRODUCES: its stock came back on the shelf", (await shelf(root, p.productId)) - d1Before, 1);
  check("D1 REPRODUCES: and a full credit note was issued", (await notes(root, d1.id)).map((n) => n.amount), ["2500.00"]);

  // D2 — re-open a cancelled order and cancel it again.
  const d2 = await paidOrder(root, [{ id: p.productId }]);
  await as(root, "admin", w, () => cancelOrder(root, d2.id));
  const d2Before = await shelf(root, p.productId);
  const reopen = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'confirmed' where id = $1", [d2.id])));
  check("D2 REPRODUCES: an admin re-opens a cancelled order with a plain UPDATE", reopen.error ?? null, null);
  const again = await as(root, "admin", w, () => outcome(cancelOrder(root, d2.id)));
  check("D2 REPRODUCES: and cancels it again", again.error ?? null, null);
  check("D2 REPRODUCES: a second credit note", (await notes(root, d2.id)).length, 2);
  check("D2 REPRODUCES: a second restock — inventory invented", (await shelf(root, p.productId)) - d2Before, 1);

  // D3 — issue_credit_note directly, without a cap.
  const d3 = await paidOrder(root, [{ id: p.productId }]);
  for (let i = 0; i < 3; i++) {
    await as(root, "admin", w, () => root.query("select public.issue_credit_note($1, 'return', 2500, 'probe', null)", [d3.id]));
  }
  check("D3 REPRODUCES: three ₹2,500 notes on a ₹2,500 order", (await notes(root, d3.id)).map((n) => n.amount), ["2500.00", "2500.00", "2500.00"]);

  // D4 — admins rewrite the money columns, and nothing records it.
  const d4 = await paidOrder(root, [{ id: p.productId }], 2500, { shipping: 100 });
  const d4w = await as(root, "admin", w, () => outcome(root.query(
    "update orders set payment_status = 'refunded', total_inr = 1, shipping_cost_inr = 0, items = '[]'::jsonb where id = $1", [d4.id])));
  check("D4 REPRODUCES: an admin rewrites payment_status, total, delivery charge and items", d4w.error ?? null, null);
  const d4r = await orderRow(root, d4.id);
  check("D4 REPRODUCES: the paid order now reads 'refunded', ₹1, delivery ₹0", [d4r.payment_status, d4r.total, d4r.shipping], ["refunded", "1.00", "0.00"]);
  const d4un = await paidOrder(root, [{ id: p.productId }]);
  await as(root, "admin", w, () => root.query("update orders set payment_status = 'pending' where id = $1", [d4un.id]));
  const d4c = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'cancelled' where id = $1", [d4un.id])));
  check("D4 REPRODUCES: un-paid, then cancelled by a plain UPDATE — no credit note, stock stays out",
    [d4c.error ?? null, (await notes(root, d4un.id)).length, (await orderMoves(root, d4un.id)).map((m) => m.reason)], [null, 0, ["sale"]]);
  check("D4 REPRODUCES: no order audit table exists", (await root.query("select to_regclass('public.order_events') t")).rows[0].t, null);

  // D2 at the service layer: nothing stops a server-side re-open either.
  const sv = await paidOrder(root, [{ id: p.productId }]);
  await as(root, "admin", w, () => cancelOrder(root, sv.id));
  const svr = await as(root, "service", w, () => outcome(root.query("update orders set status = 'placed' where id = $1", [sv.id])));
  check("D2 REPRODUCES (service_role): a cancelled order re-opened server-side", svr.error ?? null, null);

  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

// ════════════════════════════════════════════════════════════════════════════
// OS-2: 0001–0078.
// ════════════════════════════════════════════════════════════════════════════
async function os2(engine: Engine) {
  console.log("\nOS-2 (through 0078)");
  await engine.database("os2_new");
  const w = await world(engine, "os2_new");
  const { root, a, b, obs } = w;
  DISPATCH = await hasDispatch(root);
  console.log(DISPATCH ? "  (0075 present: shipping is dispatch_order)" : "  (no 0075: shipping through admin_set_order_status)");
  const p = await liveProduct(root, w.admin, { stock: 20 });

  // ── 1. Unpaid cancellation ──
  console.log("\n 1. unpaid cancellation");
  const u = await pendingOrder(root, [{ id: p.productId }]);
  const plainCancel = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'cancelled' where id = $1", [u.id])));
  check("an admin cannot cancel by plain UPDATE any more (permission denied)", plainCancel.code, "42501");
  const paidOnly = await as(root, "admin", w, () => outcome(cancelOrder(root, u.id)));
  truthy("cancel_order still refuses an unpaid order", refused(paidOnly, "never paid"));
  const uc = await as(root, "admin", w, () => cancelUnpaid(root, u.id, "Abandoned checkout"));
  check("cancel_unpaid_order cancels it", uc.outcome, "cancelled");
  const ur = await orderRow(root, u.id);
  check("status cancelled, still pending, cancelled_at stamped", [ur.status, ur.payment_status, ur.cancelled_stamped], ["cancelled", "pending", true]);
  check("no credit note and no stock movement", [(await notes(root, u.id)).length, (await orderMoves(root, u.id)).length], [0, 0]);
  const ue = (await events(root, u.id)).filter((e) => e.operation === "update");
  check("audited: one update event, action, actor, reason, from → to",
    ue.map((e) => [e.action, e.actor_id, e.actor_role, e.from_status, e.to_status, e.reason]),
    [["cancel_unpaid_order", w.admin, "authenticated", "placed", "cancelled", "Abandoned checkout"]]);
  check("the actor's email is recorded", ue[0].actor_email, "owner@example.test");
  const uAgain = await as(root, "admin", w, () => outcome(cancelUnpaid(root, u.id)));
  truthy("a repeat is refused (already cancelled)", refused(uAgain, "already cancelled"));
  check("…and leaves no second event", (await events(root, u.id)).filter((e) => e.operation === "update").length, 1);

  // An unpaid order that still holds stock (an interrupted pre-OS-1 settlement).
  const ul = await pendingOrder(root, [{ id: p.productId, quantity: 2 }], 5000);
  await as(root, "service", w, () => root.query("select public.reserve_stock($1::jsonb, $2)", [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 2 }]), ul.id]));
  const ulBefore = await shelf(root, p.productId);
  const ulc = await as(root, "admin", w, () => cancelUnpaid(root, ul.id));
  check("an unpaid order's own stock comes back, once", [ulc.stock_returned, (await shelf(root, p.productId)) - ulBefore], [true, 2]);
  check("movements: sale −2, cancellation +2", (await orderMoves(root, ul.id)).map((m) => [m.reason, m.delta]), [["sale", -2], ["cancellation", 2]]);

  // ── 2. Paid, unshipped cancellation ──
  console.log("\n 2. paid, not dispatched");
  const pd = await paidOrder(root, [{ id: p.productId }]);
  const pdBefore = await shelf(root, p.productId);
  const viaUnpaid = await as(root, "admin", w, () => outcome(cancelUnpaid(root, pd.id)));
  truthy("cancel_unpaid_order refuses a paid order", refused(viaUnpaid, "is paid"));
  const pc = await as(root, "admin", w, () => cancelOrder(root, pd.id, "Out of stock at the loom"));
  check("cancel_order: credit note for the total, stock returned",
    [pc.credit_note?.amount_inr, pc.credit_note?.kind, pc.stock_returned, pc.completed_existing_cancellation], [2500, "cancellation", true, false]);
  check("the shelf is back by exactly one", (await shelf(root, p.productId)) - pdBefore, 1);
  const pr = await orderRow(root, pd.id);
  check("status cancelled, payment stays paid (the refund is a separate step)", [pr.status, pr.payment_status, pr.cancelled_stamped], ["cancelled", "paid", true]);
  const pe = (await events(root, pd.id)).filter((e) => e.action === "cancel_order");
  check("audited with action, actor and reason", pe.map((e) => [e.actor_id, e.from_status, e.to_status, e.reason]),
    [[w.admin, "placed", "cancelled", "Out of stock at the loom"]]);
  const pAgain = await as(root, "admin", w, () => outcome(cancelOrder(root, pd.id)));
  truthy("a repeat is refused", refused(pAgain, "already cancelled"));
  check("still one credit note and one cancellation movement",
    [(await notes(root, pd.id)).length, (await orderMoves(root, pd.id)).filter((m) => m.reason === "cancellation").length], [1, 1]);

  // ── 3. Multi-line, quantities and variants ──
  console.log("\n 3. multi-line / quantity / size variants");
  const sized = await liveProduct(root, w.admin, { sizes: [{ label: "S", stock_quantity: 6 }, { label: "M", stock_quantity: 6 }] });
  const plain = await liveProduct(root, w.admin, { stock: 10 });
  const mixed = await paidOrder(root, [
    { id: sized.productId, size: "S", quantity: 2 },
    { id: sized.productId, size: "M", quantity: 1 },
    { id: plain.productId, quantity: 3 },
  ], 15000);
  check("settlement took S−2, M−1, plain−3", [await sizeShelf(root, sized.productId, "S"), await sizeShelf(root, sized.productId, "M"), await shelf(root, plain.productId)], [4, 5, 7]);
  const mc = await as(root, "admin", w, () => cancelOrder(root, mixed.id));
  check("cancel returns exactly what each line took", [mc.stock_returned, await sizeShelf(root, sized.productId, "S"), await sizeShelf(root, sized.productId, "M"), await shelf(root, plain.productId)], [true, 6, 6, 10]);
  check("one cancellation movement per line, matching quantities",
    (await orderMoves(root, mixed.id)).filter((m) => m.reason === "cancellation").map((m) => [m.size, m.delta]).sort(),
    [["", 3], ["M", 1], ["S", 2]].sort());

  // A line whose basket was edited after the sale (impossible now; built as root)
  // still returns only what the movements say was taken.
  const edited = await paidOrder(root, [{ id: plain.productId, quantity: 1 }]);
  await asRoot(root);
  await root.query("set session_replication_role = replica");
  await root.query("update orders set items = jsonb_set(items, '{0,quantity}', '5') where id = $1", [edited.id]);
  await root.query("set session_replication_role = origin");
  const eBefore = await shelf(root, plain.productId);
  await as(root, "admin", w, () => cancelOrder(root, edited.id));
  check("stock back = what the sale movement took (1), not what the edited basket says (5)", (await shelf(root, plain.productId)) - eBefore, 1);

  // ── 4. Shipped and delivered ──
  console.log("\n 4. shipped / delivered cancellation attempts");
  const sh = await paidOrder(root, [{ id: p.productId }]);
  const noAwb = await as(root, "admin", w, () => outcome(setStatus(root, sh.id, "shipped")));
  if (DISPATCH) truthy("with 0075, admin_set_order_status sends shipping to dispatch_order", refused(noAwb, "dispatching it"));
  else truthy("shipping without a saved tracking number is refused", refused(noAwb, "tracking number"));
  await as(root, "admin", w, () => ship(root, sh.id, "Handed to the post office"));
  check("then it ships", (await orderRow(root, sh.id)).status, "shipped");
  const shBefore = await shelf(root, p.productId);
  const shc = await as(root, "admin", w, () => outcome(cancelOrder(root, sh.id)));
  truthy("D1 FIXED: cancel_order refuses a shipped order", refused(shc, "dispatched or delivered"));
  check("…no stock back, no credit note, still shipped",
    [(await shelf(root, p.productId)) - shBefore, (await notes(root, sh.id)).length, (await orderRow(root, sh.id)).status], [0, 0, "shipped"]);
  truthy("cancel_unpaid_order refuses it too", refused(await as(root, "admin", w, () => outcome(cancelUnpaid(root, sh.id))), "is paid"));
  const shStock = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, $2, 'cancellation')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), sh.id])));
  truthy("a direct release_stock 'cancellation' for a dispatched order is refused", refused(shStock, "dispatched"));
  check("delivered", (await as(root, "admin", w, () => setStatus(root, sh.id, "delivered"))).status, "delivered");
  truthy("cancel_order refuses a delivered order", refused(await as(root, "admin", w, () => outcome(cancelOrder(root, sh.id))), "dispatched or delivered"));
  const back = await as(root, "admin", w, () => outcome(setStatus(root, sh.id, "shipped")));
  truthy("a delivered order does not move back", Boolean(back.error) && (await orderRow(root, sh.id)).status === "delivered");

  // ── 5. Re-opening a cancelled order ──
  console.log("\n 5. re-opening a cancelled order");
  const ro = pd.id; // cancelled in 2
  const roBefore = await shelf(root, p.productId);
  const roAdmin = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'confirmed' where id = $1", [ro])));
  check("D2 FIXED: an admin UPDATE of status is permission denied", roAdmin.code, "42501");
  truthy("admin_set_order_status refuses it", refused(await as(root, "admin", w, () => outcome(setStatus(root, ro, "confirmed"))), "cannot be reopened"));
  const roSvc = await as(root, "service", w, () => outcome(root.query("update orders set status = 'confirmed' where id = $1", [ro])));
  truthy("service_role cannot re-open it", refused(roSvc, "cannot be reopened"));
  const roRoot = await outcome(root.query("update orders set status = 'placed' where id = $1", [ro]));
  truthy("nor can the database owner", refused(roRoot, "cannot be reopened"));
  const roSpoof = await as(root, "service", w, async () => {
    await root.query("begin");
    await root.query("select set_config('wovenne.order_transition', 'on', true)");
    const r = await outcome(root.query("update orders set status = 'confirmed' where id = $1", [ro]));
    await root.query("rollback");
    return r;
  });
  truthy("not even with the order-function setting forged", refused(roSpoof, "cannot be reopened"));
  check("no second credit note, no second restock", [(await notes(root, ro)).length, (await shelf(root, p.productId)) - roBefore], [1, 0]);

  // ── 6. Concurrent cancellation (forced overlap) ──
  console.log("\n 6. two tabs cancel at once");
  const cc = await paidOrder(root, [{ id: p.productId }]);
  const ccBefore = await shelf(root, p.productId);
  await asAdmin(a, w.admin);
  await asAdmin(b, w.admin2);
  await a.query("begin");
  await cancelOrder(a, cc.id, "tab A");
  const second = outcome(cancelOrder(b, cc.id, "tab B"));
  check("tab B waited on tab A's row lock", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  const sres = await second;
  truthy("tab B is refused: already cancelled", refused(sres, "already cancelled"));
  check("one credit note, one restock", [(await notes(root, cc.id)).length, (await shelf(root, p.productId)) - ccBefore], [1, 1]);
  await asRoot(a);
  await asRoot(b);

  // ── 7. Double stock restoration ──
  console.log("\n 7. stock comes back once, only what was taken");
  const svcAgain = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, $2, 'cancellation')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), cc.id])));
  truthy("a second 'cancellation' release for the same line is refused", Boolean(svcAgain.error));
  const open = await paidOrder(root, [{ id: p.productId, quantity: 1 }]);
  const tooMuch = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, $2, 'cancellation')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 3 }]), open.id])));
  truthy("more than the sale took is refused", refused(tooMuch, "Only stock this order took"));
  const ret = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, $2, 'return')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), open.id])));
  truthy("an order-linked 'return' needs a verified receipt (OS-6) and is refused", refused(ret, "received and checked"));
  const never = await pendingOrder(root, [{ id: p.productId }]);
  const nv = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, $2, 'cancellation')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }]), never.id])));
  truthy("an order that never took stock cannot be given any", refused(nv, "Only stock this order took"));
  const restock = await as(root, "service", w, () => outcome(root.query("select public.release_stock($1::jsonb, null, 'restock')",
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1 }])])));
  check("a shelf restock not tied to an order is unaffected", restock.error ?? null, null);

  // ── 8. Credit notes ──
  console.log("\n 8. credit notes");
  const cn = await paidOrder(root, [{ id: p.productId }]);
  const direct = await as(root, "admin", w, () => outcome(root.query("select public.issue_credit_note($1, 'return', 100, 'x', null)", [cn.id])));
  check("D3 FIXED: an admin cannot call issue_credit_note directly", direct.code, "42501");
  const directSvc = await as(root, "service", w, () => outcome(root.query("select public.issue_credit_note($1, 'return', 100, 'x', null)", [cn.id])));
  check("nor can service_role", directSvc.code, "42501");
  // Partial notes as a future return workflow would write them (built as root).
  const ins = (kind: string, amount: number) => outcome(root.query(
    "insert into credit_notes (credit_note_number, order_id, kind, amount_inr, reason) values ('CN-T-' || nextval('credit_note_number_seq'), $1, $2, $3, 'partial')",
    [cn.id, kind, amount]));
  await asRoot(root);
  check("a first partial note (₹1,000)", (await ins("return", 1000)).error ?? null, null);
  check("a second partial note (₹1,000)", (await ins("return", 1000)).error ?? null, null);
  truthy("a third (₹600) would exceed ₹2,500 and is refused", refused(await ins("return", 600), "cannot exceed"));
  const rest = await as(root, "admin", w, () => cancelOrder(root, cn.id));
  check("cancel_order credits only the ₹500 still creditable", rest.credit_note?.amount_inr, 500);
  check("total credited = the paid total, never more", (await notes(root, cn.id)).reduce((s, n) => s + Number(n.amount), 0), 2500);
  const dupe = await outcome(root.query(
    "insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-T-DUPE', $1, 'cancellation', 1)", [pd.id]));
  truthy("a second cancellation note for an order is refused", Boolean(dupe.error));
  const editNote = await outcome(root.query("update credit_notes set amount_inr = 1 where order_id = $1", [cn.id]));
  truthy("an issued credit note cannot be edited", refused(editNote, "permanent"));
  const delNote = await as(root, "service", w, () => outcome(root.query("delete from credit_notes where order_id = $1", [cn.id])));
  truthy("…or deleted (service_role)", refused(delNote, "permanent"));
  const unpaidNote = await outcome(root.query(
    "insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-T-UNPAID', $1, 'return', 1)", [never.id]));
  truthy("no credit note on an unpaid order", refused(unpaidNote, "never paid"));
  // Concurrent partial notes: the order row lock serialises them.
  const race = await paidOrder(root, [{ id: p.productId }]);
  await a.query("begin");
  await a.query("insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-RACE-A', $1, 'return', 2000)", [race.id]);
  const raceB = outcome(b.query("insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-RACE-B', $1, 'return', 2000)", [race.id]));
  check("the second note waited on the first", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  truthy("…and is refused: together they exceed the total", refused(await raceB, "cannot exceed"));

  // ── 9. Direct admin and API bypass attempts ──
  console.log("\n 9. direct bypass attempts");
  const by = await paidOrder(root, [{ id: p.productId }], 2500, { shipping: 100 });
  for (const [col, val] of [["payment_status", "'pending'"], ["total_inr", "1"], ["items", "'[]'::jsonb"], ["shipping_cost_inr", "0"],
    ["invoice_number", "'WOV-FAKE'"], ["status", "'delivered'"], ["cancelled_at", "now()"], ["razorpay_payment_id", "null"],
    ["customer_email", "'x@example.test'"], ["shipping_address", "null"]] as const) {
    const r = await as(root, "admin", w, () => outcome(root.query(`update orders set ${col} = ${val} where id = $1`, [by.id])));
    check(`D4 FIXED: admin UPDATE of ${col} is permission denied`, r.code, "42501");
  }
  const allowed = await as(root, "admin", w, () => outcome(root.query(
    "update orders set admin_note = 'Called the customer', needs_review = false, courier_actual_cost_inr = 80 where id = $1 returning id", [by.id])));
  check("admin_note, needs_review and the courier's actual cost still save", allowed.value?.rowCount, 1);
  const aal1 = await as(root, { staff: w.admin }, w, () => outcome(root.query("update orders set admin_note = 'aal1' where id = $1 returning id", [by.id])));
  check("a password-only (aal1) staff session changes nothing", aal1.value?.rowCount ?? aal1.code, 0);
  const cust = await as(root, { user: w.customer, aal: "aal1" }, w, () => outcome(root.query("update orders set admin_note = 'me' where id = $1 returning id", [by.id])));
  check("a customer changes nothing on their own order", cust.value?.rowCount ?? cust.code, 0);
  await root.query("set role anon");
  const anon = await outcome(root.query("update orders set admin_note = 'anon' where id = $1", [by.id]));
  await asRoot(root);
  check("anon is permission denied", anon.code, "42501");
  for (const [fn, args] of [["admin_set_order_status($1, 'confirmed', null)", [by.id]], ["cancel_unpaid_order($1, null)", [by.id]], ["cancel_order($1, null)", [by.id]]] as const) {
    await root.query("set role anon");
    const an = await outcome(root.query(`select public.${fn}`, [...args]));
    await asRoot(root);
    check(`anon cannot execute ${fn.split("(")[0]}`, an.code, "42501");
    const cu = await as(root, { user: w.customer, aal: "aal1" }, w, () => outcome(root.query(`select public.${fn}`, [...args])));
    truthy(`a customer is refused by ${fn.split("(")[0]}`, refused(cu, "Not authorised") || refused(cu, "Only admins"));
    const st = await as(root, { staff: w.admin }, w, () => outcome(root.query(`select public.${fn}`, [...args])));
    truthy(`aal1 staff are refused by ${fn.split("(")[0]}`, refused(st, "Not authorised") || refused(st, "Only admins"));
  }
  const svc = (sql: string) => as(root, "service", w, () => outcome(root.query(sql, [by.id])));
  truthy("service_role cannot un-pay a paid order", refused(await svc("update orders set payment_status = 'pending' where id = $1"), "stays paid"));
  truthy("service_role cannot write 'refunded' on a paid order", refused(await svc("update orders set payment_status = 'refunded' where id = $1"), "stays paid"));
  const pendingOne = await pendingOrder(root, [{ id: p.productId }]);
  const chk = await as(root, "service", w, () => outcome(root.query("update orders set payment_status = 'refunded' where id = $1", [pendingOne.id])));
  truthy("…nor any value outside pending | paid (CHECK)", refused(chk, "orders_payment_status_check"));
  truthy("service_role cannot change a paid total", refused(await svc("update orders set total_inr = 1 where id = $1"), "cannot be changed"));
  truthy("…or the delivery charge on the invoice", refused(await svc("update orders set shipping_cost_inr = 0 where id = $1"), "cannot be changed"));
  check("…but the gateway's fee on a paid order can still be corrected server-side (a cost, not the charge)",
    (await svc("update orders set gateway_fee_inr = 61 where id = $1")).error ?? null, null);
  truthy("…or change status outside an order function", refused(await svc("update orders set status = 'confirmed' where id = $1"), "only through the order functions"));
  const inv = (await orderRow(root, by.id)).invoice_number as string;
  truthy("an issued invoice number is permanent", refused(await svc("update orders set invoice_number = 'WOV-OTHER' where id = $1"), "permanent"));
  check("…and the row is untouched", [(await orderRow(root, by.id)).invoice_number, (await orderRow(root, by.id)).total, (await orderRow(root, by.id)).shipping], [inv, "2500.00", "100.00"]);
  const ev = await as(root, "admin", w, () => outcome(root.query("insert into order_events (order_id, actor_role, operation, action) values ($1, 'x', 'update', 'forged')", [by.id])));
  check("order_events: an admin cannot write one", ev.code, "42501");
  const evs = await svc("delete from order_events where order_id = $1");
  check("order_events: service_role cannot delete them", evs.code, "42501");
  const evu = await as(root, "admin", w, () => outcome(root.query("update order_events set reason = 'x' where order_id = $1", [by.id])));
  check("order_events: an admin cannot edit them", evu.code, "42501");
  const evc = await as(root, { user: w.customer, aal: "aal1" }, w, () => root.query("select count(*)::int n from order_events where order_id = $1", [by.id]));
  check("order_events: a customer reads none, even for their own order", evc.rows[0].n, 0);
  const eva = await as(root, "admin", w, () => root.query("select count(*)::int n from order_events where order_id = $1", [by.id]));
  truthy("order_events: an admin reads them", eva.rows[0].n > 0);

  // ── 10. Legitimate admin updates and the whole life of an order ──
  console.log("\n 10. legitimate updates and audit completeness");
  const life = await pendingOrder(root, [{ id: p.productId }]);
  const unpaidConfirm = await as(root, "admin", w, () => outcome(setStatus(root, life.id, "confirmed")));
  truthy("an unpaid order is not confirmed", refused(unpaidConfirm, "Only a paid order"));
  await settle(root, life.rzp, `pay_${life.rzp}`);
  check("confirm", (await as(root, "admin", w, () => setStatus(root, life.id, "confirmed"))).status, "confirmed");
  check("confirm again is a no-op", (await as(root, "admin", w, () => setStatus(root, life.id, "confirmed"))).outcome, "unchanged");
  truthy("an online order is not delivered before it ships", refused(await as(root, "admin", w, () => outcome(setStatus(root, life.id, "delivered"))), "after it has been dispatched"));
  truthy("'cancelled' is not a status this function sets", refused(await as(root, "admin", w, () => outcome(setStatus(root, life.id, "cancelled"))), "cancel_unpaid_order or cancel_order"));
  await as(root, "admin", w, () => root.query("update orders set needs_review = true where id = $1", [life.id]));
  if (!DISPATCH) await as(root, "admin", w, () => root.query("update orders set awb_number = 'EE123456785IN', courier_name = 'Speed Post' where id = $1", [life.id]));
  truthy("a flagged order does not ship", refused(await as(root, "admin", w, () => outcome(ship(root, life.id))), "flagged for review"));
  await as(root, "admin", w, () => root.query("update orders set needs_review = false where id = $1", [life.id]));
  await as(root, "admin", w, () => ship(root, life.id));
  await as(root, "admin", w, () => setStatus(root, life.id, "delivered", "Signed for"));
  const lr = await orderRow(root, life.id);
  check("shipped and delivered are stamped once", [lr.status, lr.shipped_stamped, lr.delivered_stamped], ["delivered", true, true]);
  const le = await events(root, life.id);
  check("every step has exactly one audit event, in order",
    le.map((e) => [e.operation, e.action, e.actor_role, e.to_status, e.to_payment_status]),
    [
      ["insert", "insert", "postgres", "placed", "pending"],
      ["update", "update", "service_role", "placed", "paid"],
      ["update", "update", "service_role", "placed", "paid"],
      ["update", "admin_set_order_status", "authenticated", "confirmed", "paid"],
      ...(DISPATCH
        ? [["update", "update", "authenticated", "confirmed", "paid"],
           ["update", "update", "authenticated", "confirmed", "paid"],
           ["update", "dispatch_order", "authenticated", "shipped", "paid"]]
        : [["update", "update", "authenticated", "confirmed", "paid"],
           ["update", "update", "authenticated", "confirmed", "paid"],
           ["update", "update", "authenticated", "confirmed", "paid"],
           ["update", "admin_set_order_status", "authenticated", "shipped", "paid"]]),
      ["update", "admin_set_order_status", "authenticated", "delivered", "paid"],
    ]);
  check("settlement's events have no human actor", le.filter((e) => e.actor_role === "service_role").map((e) => e.actor_id), [null, null]);
  check("the delivery reason is kept", le[le.length - 1].reason, "Signed for");
  truthy("the settle event records the money that moved",
    le[1].changes.payment_status?.to === "paid" && le[1].changes.razorpay_payment_id?.to === `pay_${life.rzp}`);
  // Anonymisation by the customer: recorded as changed, never copied.
  const del = await paidOrder(root, [{ id: p.productId }], 2500, { email: "leaving@example.test" });
  await as(root, "admin", w, () => setStatus(root, del.id, "confirmed"));
  await asRoot(root);
  const leaving = (await root.query("insert into auth.users (email) values ('leaving@example.test') returning id")).rows[0].id as string;
  await root.query("insert into profiles (id, email) values ($1, 'leaving@example.test') on conflict (id) do update set email = excluded.email", [leaving]);
  // Their order must be delivered first (0033).
  const delBlocked = await as(root, { user: leaving, aal: "aal1" }, w, () => root.query("select public.delete_my_account() r"));
  check("account deletion still waits for an undelivered order", delBlocked.rows[0].r.ok, false);
  await as(root, "admin", w, () => ship(root, del.id));
  await as(root, "admin", w, () => setStatus(root, del.id, "delivered"));
  const gone = await as(root, { user: leaving, aal: "aal1" }, w, () => root.query("select public.delete_my_account() r"));
  check("then the customer's account deletion anonymises the paid order", [gone.rows[0].r.ok, gone.rows[0].r.orders_anonymised], [true, 1]);
  const anonEvent = (await events(root, del.id)).at(-1)!;
  check("…audited as the customer, contact details marked changed, never copied",
    [anonEvent.actor_id, anonEvent.changes.customer_email, anonEvent.changes.shipping_address, JSON.stringify(anonEvent.changes).includes("leaving@example.test")],
    [leaving, { changed: true }, { changed: true }, false]);
  const noPii = await root.query("select count(*)::int n from order_events where changes::text ilike '%@example.test%' or changes::text ilike '%Loom Street%'");
  check("no audit row anywhere holds an email address or street", noPii.rows[0].n, 0);

  // ── 11. In-person orders ──
  console.log("\n 11. in-person orders");
  const ip = await inPersonOrder(root, p.productId);
  const ipBefore = await shelf(root, p.productId);
  const ipc = await as(root, "admin", w, () => cancelOrder(root, ip, "Returned at the counter before collection"));
  check("a confirmed in-person order cancels: credit note, stock back", [ipc.credit_note?.amount_inr, (await shelf(root, p.productId)) - ipBefore], [2500, 1]);
  const ip2 = await inPersonOrder(root, p.productId);
  check("handed over in person: confirmed → delivered", (await as(root, "admin", w, () => setStatus(root, ip2, "delivered"))).status, "delivered");
  truthy("…and then it is not cancellable", refused(await as(root, "admin", w, () => outcome(cancelOrder(root, ip2))), "dispatched or delivered"));

  // ── 12. Cancellation during dispatch (forced overlap) ──
  console.log("\n 12. cancellation racing dispatch");
  const r1 = await paidOrder(root, [{ id: p.productId }]);
  await asAdmin(a, w.admin);
  await asAdmin(b, w.admin2);
  await a.query("begin");
  await ship(a, r1.id);
  const lateCancel = outcome(cancelOrder(b, r1.id));
  check("the cancel waited on the shipment", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  truthy("ship first → the cancel is refused (dispatched)", refused(await lateCancel, "dispatched or delivered"));
  check("…no credit note, no stock movement back", [(await notes(root, r1.id)).length, (await orderMoves(root, r1.id)).map((m) => m.reason)], [0, ["sale"]]);
  const r2 = await paidOrder(root, [{ id: p.productId }]);
  await a.query("begin");
  await cancelOrder(a, r2.id);
  const lateShip = outcome(ship(b, r2.id));
  check("the shipment waited on the cancel", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  const ls2 = await lateShip;
  truthy("cancel first → the shipment is refused", refused(ls2, "cannot be reopened") || refused(ls2, "cancelled order cannot be dispatched"));
  check("…the order stays cancelled", (await orderRow(root, r2.id)).status, "cancelled");
  await asRoot(a);
  await asRoot(b);

  // ── 13. Cancellation racing settlement (with OS-1) ──
  console.log("\n 13. cancellation racing settlement");
  const s1 = await pendingOrder(root, [{ id: p.productId }]);
  const s1Before = await shelf(root, p.productId);
  await asAdmin(a, w.admin);
  await a.query("begin");
  await cancelUnpaid(a, s1.id);
  const lateSettle = outcome(settle(b, s1.rzp, `pay_${s1.rzp}`));
  check("settlement waited on the unpaid cancel", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  const ls = (await lateSettle).value;
  check("cancel first → OS-1 records the payment as owed back", [ls?.path, ls?.reason], ["refund_owed", "captured_after_cancellation"]);
  const s1r = await orderRow(root, s1.id);
  check("…the order stays cancelled and unpaid, flagged, no stock taken",
    [s1r.status, s1r.payment_status, s1r.needs_review, (await shelf(root, p.productId)) - s1Before], ["cancelled", "pending", true, 0]);
  const s2 = await pendingOrder(root, [{ id: p.productId }]);
  await asService(a);
  await a.query("begin");
  await a.query("select public.settle_razorpay_payment($1, $2, 250000, 'INR', 5900, 900, 'captured')", [s2.rzp, `pay_${s2.rzp}`]);
  await asAdmin(b, w.admin);
  const lateUnpaid = outcome(cancelUnpaid(b, s2.id));
  check("the unpaid cancel waited on settlement", await waitsOn(obs, w.pb, w.pa), true);
  await a.query("commit");
  truthy("settle first → the unpaid cancel is refused (the order is paid now)", refused(await lateUnpaid, "is paid"));
  const s2c = await outcome(cancelOrder(b, s2.id));
  check("…and cancel_order then cancels it with a credit note and the stock back", [s2c.value?.credit_note?.amount_inr, s2c.value?.stock_returned], [2500, true]);
  await asRoot(a);
  await asRoot(b);

  // ── 14. Historical cases ──
  console.log("\n 14. historical cases");
  // The 9 Aug 2026 shape: a paid order cancelled by the old bypass button —
  // no credit note — and here with its sale movement still out.
  await asRoot(root);
  const hist = (await root.query(
    `insert into orders (items, total_inr, payment_status, status, cancelled_at, payment_provider, payment_method, customer_email)
     values ($1::jsonb, 2500, 'paid', 'cancelled', now() - interval '90 days', 'offline', 'cash', 'old@example.test') returning id`,
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1, price_inr: 2500, name: "Piece" }])])).rows[0].id as string;
  await root.query("insert into stock_movements (product_id, size_label, delta, reason, order_id) values ($1, 'One Size', -1, 'sale', $2)", [p.productId, hist]);
  const histReopen = await as(root, "admin", w, () => outcome(setStatus(root, hist, "confirmed")));
  truthy("the 9 Aug repair path (re-open, then cancel) is refused now", refused(histReopen, "cannot be reopened"));
  const hBefore = await shelf(root, p.productId);
  const hc = await as(root, "admin", w, () => cancelOrder(root, hist, "Repair: cancelled without a credit note"));
  check("cancel_order completes it in place: credit note, stock back, still cancelled",
    [hc.completed_existing_cancellation, hc.credit_note?.amount_inr, (await shelf(root, p.productId)) - hBefore, (await orderRow(root, hist)).status],
    [true, 2500, 1, "cancelled"]);
  check("…the status and cancelled_at were not touched (no update event)", (await events(root, hist)).filter((e) => e.operation === "update").length, 0);
  truthy("a second repair is refused", refused(await as(root, "admin", w, () => outcome(cancelOrder(root, hist))), "already cancelled"));
  // Without a sale movement (exactly 9 Aug): a note, and no stock invented.
  const hist2 = (await root.query(
    `insert into orders (items, total_inr, payment_status, status, payment_provider, customer_email)
     values ($1::jsonb, 2500, 'paid', 'cancelled', 'offline', 'old@example.test') returning id`,
    [JSON.stringify([{ id: p.productId, size: "One Size", quantity: 1, price_inr: 2500, name: "Piece" }])])).rows[0].id as string;
  const h2Before = await shelf(root, p.productId);
  const h2 = await as(root, "admin", w, () => cancelOrder(root, hist2));
  check("no sale movement → a credit note, and no stock invented", [h2.credit_note?.amount_inr, h2.stock_returned, (await shelf(root, p.productId)) - h2Before], [2500, false, 0]);
  // Old orders keep working: an order from before 0078 shows as one insert-less history.
  check("old orders have no back-filled events (history is not rewritten)", (await events(root, hist2)).filter((e) => e.operation !== "insert").length, 0);

  // ── 15. Failure injection and rollback ──
  console.log("\n 15. failure injection");
  const f1 = await paidOrder(root, [{ id: p.productId }]);
  const f1Before = await shelf(root, p.productId);
  await asRoot(root);
  await root.query(`create function public.t_fail() returns trigger language plpgsql as $$ begin raise exception 'INJECTED'; end $$`);
  await root.query("create trigger t_fail before insert on credit_notes for each row execute function public.t_fail()");
  const f1c = await as(root, "admin", w, () => outcome(cancelOrder(root, f1.id)));
  truthy("a failing credit note fails the whole cancellation", refused(f1c, "INJECTED"));
  const f1r = await orderRow(root, f1.id);
  check("…nothing moved: still placed and paid, stock still out, no note, no event",
    [f1r.status, f1r.payment_status, (await shelf(root, p.productId)) - f1Before, (await notes(root, f1.id)).length,
     (await events(root, f1.id)).filter((e) => e.action === "cancel_order").length], ["placed", "paid", 0, 0, 0]);
  await root.query("drop trigger t_fail on credit_notes");
  await root.query("create trigger t_fail before insert on order_events for each row execute function public.t_fail()");
  const f2 = await as(root, "admin", w, () => outcome(setStatus(root, f1.id, "confirmed")));
  truthy("no audit row → no status change (the change and its record commit together)", refused(f2, "INJECTED") && (await orderRow(root, f1.id)).status === "placed");
  const f3 = await as(root, "admin", w, () => outcome(cancelOrder(root, f1.id)));
  check("…and no cancellation either: no note, no stock back", [refused(f3, "INJECTED"), (await notes(root, f1.id)).length, (await shelf(root, p.productId)) - f1Before], [true, 0, 0]);
  await root.query("drop trigger t_fail on order_events");
  await root.query("drop function public.t_fail()");
  const f4 = await as(root, "admin", w, () => cancelOrder(root, f1.id));
  check("once the fault is gone the same cancel works", [f4.credit_note?.amount_inr, (await shelf(root, p.productId)) - f1Before], [2500, 1]);

  // ── 16. Mixed version: the pre-OS-2 screen against 0078 ──
  console.log("\n 16. old admin screen against 0078 (deploy window)");
  const mv = await paidOrder(root, [{ id: p.productId }]);
  const oldAdvance = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'confirmed' where id = $1", [mv.id])));
  check("old 'Mark confirmed' (plain UPDATE) fails loudly, permission denied — not silently", oldAdvance.code, "42501");
  const oldSave = await as(root, "admin", w, () => outcome(root.query(
    "update orders set courier_name = 'X', awb_number = 'Y', shipping_cost_inr = 0, admin_note = 'n' where id = $1", [mv.id])));
  check("old 'Save dispatch details' (sends the delivery charge) fails loudly", oldSave.code, "42501");
  check("…and changed nothing", [(await orderRow(root, mv.id)).status, (await orderRow(root, mv.id)).admin_note], ["placed", null]);
  const oldNote = await as(root, "admin", w, () => outcome(root.query("update orders set shipping_cost_inr = 0, admin_note = 'n' where id = $1", [mv.id])));
  check("post-Step-F 'Save cost and note' (sends the delivery charge) fails loudly", oldNote.code, "42501");
  const oldDeliver = await as(root, "admin", w, () => outcome(root.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [mv.id])));
  check("post-Step-F 'Mark delivered' (plain UPDATE) fails loudly", oldDeliver.code, "42501");
  const oldReview = await as(root, "admin", w, () => outcome(root.query("update orders set needs_review = false where id = $1 returning id", [mv.id])));
  check("old 'Clear the review flag' still works", oldReview.value?.rowCount, 1);
  const oldCancel = await as(root, "admin", w, () => outcome(cancelOrder(root, mv.id)));
  check("the old cancel route's RPC still works", oldCancel.value?.credit_note?.amount_inr, 2500);

  // ── 17. Posture of the new objects ──
  console.log("\n 17. privileges");
  await asRoot(root);
  const priv = (await root.query(`
    select has_table_privilege('authenticated', 'public.orders', 'UPDATE') t_upd,
           array(select column_name::text from information_schema.column_privileges
                  where table_schema = 'public' and table_name = 'orders' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1) cols,
           has_function_privilege('authenticated', 'public.issue_credit_note(uuid, text, numeric, text, jsonb)', 'EXECUTE') icn,
           has_table_privilege('service_role', 'public.orders', 'UPDATE') svc_upd,
           has_table_privilege('service_role', 'public.order_events', 'INSERT') ev_ins`)).rows[0];
  check("authenticated: no table UPDATE on orders, exactly five columns",
    [priv.t_upd, priv.cols], [false, ["admin_note", "awb_number", "courier_actual_cost_inr", "courier_name", "needs_review"]]);
  check("issue_credit_note not executable by authenticated", priv.icn, false);
  check("service_role keeps its UPDATE (settlement), gains nothing on order_events", [priv.svc_upd, priv.ev_ins], [true, false]);

  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

// ════════════════════════════════════════════════════════════════════════════
// PREFLIGHT: 0078 refuses to apply over data it would contradict.
// ════════════════════════════════════════════════════════════════════════════
async function preflight(engine: Engine) {
  console.log("\nPREFLIGHT (0077 database, anomalies seeded, 0078 applied by hand)");
  await engine.database("os2_pf", "0077");
  const root = await engine.connect("os2_pf");
  const admin = await makeAdmin(root);
  const p = await liveProduct(root, admin, { stock: 5 });
  await asRoot(root);
  const sql = fs.readFileSync(path.join(process.cwd(), "supabase", "migrations", "0078_order_transitions_and_credit_limits.sql"), "utf8");
  const apply = async () => {
    await root.query("begin");
    const r = await outcome(root.query(sql));
    await root.query(r.error ? "rollback" : "commit");
    return r;
  };
  const mk = async (status: string, pay: string) => (await root.query(
    "insert into orders (items, total_inr, payment_status, status) values ('[]'::jsonb, 2500, $2, $1) returning id", [status, pay])).rows[0].id as string;

  const bad = await mk("placed", "refunded");
  truthy("refuses while a payment_status is not pending/paid", refused(await apply(), "payment_status other than pending/paid"));
  await root.query("delete from orders where id = $1", [bad]);

  const twice = await mk("cancelled", "paid");
  await root.query("insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-PF-1', $1, 'cancellation', 1000), ('CN-PF-2', $1, 'cancellation', 1000)", [twice]);
  truthy("refuses while an order has two cancellation notes (D2)", refused(await apply(), "more than one cancellation credit note"));
  await root.query("delete from credit_notes where order_id = $1", [twice]);

  const over = await mk("confirmed", "paid");
  await root.query("insert into credit_notes (credit_note_number, order_id, kind, amount_inr) values ('CN-PF-3', $1, 'return', 2000), ('CN-PF-4', $1, 'return', 2000)", [over]);
  truthy("refuses while an order is credited beyond its total (D3)", refused(await apply(), "credited for more than their total"));
  await root.query("delete from credit_notes where order_id = $1", [over]);

  const rs = await mk("cancelled", "paid");
  await root.query("insert into stock_movements (product_id, size_label, delta, reason, order_id) values ($1, 'One Size', 1, 'cancellation', $2), ($1, 'One Size', 1, 'cancellation', $2)", [p.productId, rs]);
  truthy("refuses while a line was restocked by cancellation twice (D2)", refused(await apply(), "restocked by cancellation more than once"));
  await root.query("delete from stock_movements where order_id = $1", [rs]);

  check("applies cleanly once the data is clean", (await apply()).error ?? null, null);
  truthy("a second apply is refused (already applied)", refused(await apply(), "already applied"));
  await root.end();
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.error("FAIL: PG_HARNESS_DIR is not set or embedded-postgres is missing — this suite needs a real PostgreSQL.");
    process.exit(2);
  }
  console.log(engine.version);
  if (!engine.version.startsWith("PostgreSQL 17.6")) {
    console.error(`FAIL: expected PostgreSQL 17.6 (production), got ${engine.version}`);
    await engine.stop();
    process.exit(2);
  }
  try {
    await control(engine);
    await os2(engine);
    await preflight(engine);
  } catch (e) {
    failed++;
    console.error("\nFAIL  the suite threw:", e);
  } finally {
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
