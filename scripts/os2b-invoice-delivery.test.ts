/**
 * OS-2b (WP-ORDER-SAFETY-08, migration 0079): the issued invoice keeps what it
 * said, and a corrected delivery PIN is reviewed before dispatch.
 *
 *   CONTROL  database through 0078: D-1 and D-2 reproduce with the real builders.
 *   OS2B     the full migration set (0079 included): the same scenarios hold.
 *   BACKFILL a 0078 database with history, then 0079 applied on top.
 *   PURE     the builders' fallbacks and the delivery rules (TS only).
 *   ISSUER   (WP-09) seller identity and tax treatment frozen per document.
 *   RETAIN   (WP-09) sealed details: logged owner reads, rule-gated purge.
 *
 * Works with or without 0074–0076: dispatch is dispatch_order (0075) when it
 * exists, otherwise admin_set_order_status('shipped').
 *
 * Real PostgreSQL 17.6 (embedded, throwaway), fictional data, real roles:
 * admin = aal2 with a live session row; settlement = service_role; customer =
 * aal1 through RLS. No courier, payment, email or Production access.
 *
 *   PG_HARNESS_DIR=<pgh> npx tsx scripts/os2b-invoice-delivery.test.ts
 */
import fs from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { asAdmin, asRoot, asService, asUser, makeAdmin, startEngine, type Client, type Engine } from "./pg-world";
import { liveProduct } from "./stock-world";
import { buildInvoice, ISSUER, issuerRenderable } from "../lib/invoice";
import { buildCreditNote } from "../lib/creditNote";
import InvoiceDocument from "../components/invoice/InvoiceDocument";
import { DEFAULT_SHIPPING, quoteShipping } from "../lib/shipping";
import { DEFAULT_DELIVERY, resolveDelivery, isValidPostalFormat } from "../lib/delivery";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const err = (p: Promise<unknown>) => p.then(() => "", (e) => (e as Error).message);
const refusedWith = (msg: string, part: string) => (msg.includes(part) ? `refused: ${part}` : msg === "" ? "accepted" : msg);

const KOCHI = { line1: "1 Loom Street", line2: "", city: "Kochi", state: "Kerala", postal_code: "682001", country: "India" };

let seq = 0;
async function paidOrder(c: Client, productId: string, shipping = 99) {
  seq += 1;
  const rzp = `order_os2b_${process.pid}_${seq}`;
  await asRoot(c);
  const items = [{ id: productId, size: "One Size", quantity: 1, price_inr: 2500, name: "Piece" }];
  const total = 2500 + shipping;
  const id = (await c.query(
    `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name,
                         customer_phone, shipping_address, payment_provider, razorpay_order_id)
     values ($1::jsonb, $2, $3, 'pending', 'placed', 'buyer@example.test', 'A Buyer', '+91 90000 00001', $4::jsonb, 'razorpay', $5)
     returning id`,
    [JSON.stringify(items), total, shipping, JSON.stringify(KOCHI), rzp])).rows[0].id as string;
  await asService(c);
  const r = (await c.query("select public.settle_razorpay_payment($1, $2, $3, 'INR', 5900, 900, 'captured') r",
    [rzp, `pay_${rzp}`, total * 100])).rows[0].r;
  await asRoot(c);
  if (r.path !== "settled") throw new Error(`fixture did not settle: ${JSON.stringify(r)}`);
  return id;
}

const correct = (c: Client, id: string, addr: object | null, reason = "Customer emailed: the PIN was wrong", name: string | null = null) =>
  c.query("select public.admin_correct_order_contact($1, $2, null, $3::jsonb, $4) r",
    [id, name, addr === null ? null : JSON.stringify(addr), reason]).then((r) => r.rows[0].r);

/** Dispatch the way this database does it: dispatch_order (0075) or admin_set_order_status. */
async function ship(c: Client, id: string) {
  const has = (await c.query("select to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null v")).rows[0].v;
  if (has) return c.query("select public.dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true, false)", [id]);
  await c.query("update orders set courier_name = 'India Post', awb_number = 'EE123456785IN' where id = $1", [id]);
  return c.query("select public.admin_set_order_status($1, 'shipped', null)", [id]);
}
const shipOutcome = async (c: Client, id: string) => {
  const e = await err(ship(c, id));
  return e === "" ? "dispatched" : e.includes("held for review") ? "refused: held" : e.includes("flagged for review") ? "refused: flagged" : e;
};

const GOOD = (state = "Kerala", city = "Kochi") => ({
  pin_verified: true, state_city_verified: true, verified_state: state, verified_city: city,
  serviceable: true, serviceability_source: "India Post PIN search + Speed Post counter, Alappuzha HO",
  serviceability_reference: "counter clerk, 8 Nov", published_rate_inr: 99, courier_cost_estimate_inr: 47,
  cost_difference_reviewed: true,
});
const decide = (c: Client, reviewId: number, decision: string, evidence: object, reason = "Checked PIN, State and courier coverage") =>
  c.query("select public.admin_decide_delivery_review($1, $2, $3::jsonb, $4) r", [reviewId, decision, JSON.stringify(evidence), reason])
    .then((r) => r.rows[0].r);
const latestReview = async (c: Client, id: string) =>
  (await c.query("select * from order_delivery_reviews where order_id = $1 order by id desc limit 1", [id])).rows[0];

/** The row a route gets: the caller's session, the real select shape (embed emulated). */
async function invoiceRow(c: Client, id: string) {
  const has = (await c.query("select to_regclass('public.order_invoice_snapshots') is not null v")).rows[0].v;
  const sql = has
    ? `select to_jsonb(o) || jsonb_build_object('invoice_snapshot',
         (select jsonb_build_object('invoice_number', s.invoice_number, 'invoice_issued_at', s.invoice_issued_at,
                 'order_created_at', s.order_created_at, 'customer_name', s.customer_name,
                 'customer_email', s.customer_email, 'customer_phone', s.customer_phone,
                 'delivery_address', s.delivery_address, 'document', s.document, 'source', s.source,
                 'sealed_at', s.sealed_at, 'issuer', s.issuer, 'issuer_source', s.issuer_source)
            from order_invoice_snapshots s where s.order_id = o.id)) j
         from orders o where o.id = $1`
    : "select to_jsonb(o) j from orders o where o.id = $1";
  return (await c.query(sql, [id])).rows[0]?.j ?? null;
}
const pin = (inv: ReturnType<typeof buildInvoice>) => inv?.address?.postal_code ?? null;

async function world(engine: Engine, db: string) {
  const root = await engine.connect(db);
  const a = await engine.connect(db);
  const b = await engine.connect(db);
  const obs = await engine.connect(db);
  const admin = await makeAdmin(root, "owner@example.test");
  const admin2 = await makeAdmin(root, "second@example.test");
  await asRoot(root);
  const customer = (await root.query("insert into auth.users (email) values ('buyer@example.test') returning id")).rows[0].id as string;
  await root.query("insert into profiles (id, email) values ($1, 'buyer@example.test') on conflict (id) do nothing", [customer]);
  const p = await liveProduct(root, admin, { stock: 40 });
  await root.query(`insert into site_content (key, value) values ('delivery', '{"unserviceable_prefixes": ["744", "6855"]}'::jsonb)
                    on conflict (key) do update set value = excluded.value`);
  for (const c of [a, b]) await pidOf(c);
  return { root, a, b, obs, admin, admin2, customer, productId: p.productId };
}
type W = Awaited<ReturnType<typeof world>>;

async function asCustomer(c: Client, w: W, email = "buyer@example.test") {
  await asUser(c, w.customer, "aal1");
  await c.query("select set_config('request.jwt.claim.email', $1, false)", [email]);
}

const pids = new Map<Client, number>();
async function pidOf(c: Client) {
  if (!pids.has(c)) pids.set(c, (await c.query("select pg_backend_pid() p")).rows[0].p);
  return pids.get(c)!;
}
async function waitsOn(obs: Client, waiter: Client, holder: Client) {
  const pw = pids.get(waiter)!;
  const ph = pids.get(holder)!;
  for (let i = 0; i < 300; i++) {
    const r = await obs.query("select pg_blocking_pids($1) b", [pw]);
    if ((r.rows[0].b as number[]).includes(ph)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Cancels or delivers every in-flight order of the buyer so the account can be deleted. */
async function clearInFlight(w: W) {
  await asRoot(w.root);
  const rows = (await w.root.query(
    "select id, status from orders where customer_email = 'buyer@example.test' and payment_status = 'paid' and status not in ('delivered','cancelled')")).rows;
  await asAdmin(w.root, w.admin);
  for (const r of rows) {
    if (r.status === "shipped") await w.root.query("select public.admin_set_order_status($1, 'delivered', null)", [r.id]);
    else await w.root.query("select public.cancel_order($1, 'Test: clear before deletion')", [r.id]);
  }
  await asRoot(w.root);
}

async function scenarios(engine: Engine, label: "CONTROL" | "OS2B") {
  const db = label === "CONTROL" ? "os2b_control" : "os2b_full";
  await engine.database(db, label === "CONTROL" ? "0078" : undefined);
  const w = await world(engine, db);
  const P = label === "OS2B";
  console.log(`\n${label} (${P ? "all migrations incl. 0079" : "0001–0078"})`);

  // ── 2. Reprint preserves the issued details (customer + admin), new address on the row
  const o1 = await paidOrder(w.root, w.productId);
  await asCustomer(w.a, w);
  const before = buildInvoice(await invoiceRow(w.a, o1));
  await asAdmin(w.a, w.admin);
  check(`R1 ${label}: correction accepted`, (await correct(w.a, o1, { line1: "Flat 4, 1 Loom Street", postal_code: "682011" })).outcome, "corrected");
  await asCustomer(w.a, w);
  const after = buildInvoice(await invoiceRow(w.a, o1));
  await asAdmin(w.b, w.admin);
  const adminAfter = buildInvoice(await invoiceRow(w.b, o1));
  check(`R1 ${label}: invoice number unchanged`, after?.invoiceNumber === before?.invoiceNumber, true);
  check(`R1 ${label}: customer reprint prints PIN`, pin(after), P ? "682001" : "682011");
  check(`R1 ${label}: admin reprint/resend prints PIN`, pin(adminAfter), P ? "682001" : "682011");
  check(`R1 ${label}: reprint prints line1`, after?.address?.line1, P ? "1 Loom Street" : "Flat 4, 1 Loom Street");
  check(`R1 ${label}: details source`, after?.detailsSource, P ? "at_issue" : "order_row");
  await asRoot(w.a);
  check(`R1 ${label}: order row keeps the latest delivery PIN (for the parcel)`,
    (await w.a.query("select shipping_address->>'postal_code' p from orders where id = $1", [o1])).rows[0].p, "682011");
  const pdf = Buffer.from(await renderToBuffer(InvoiceDocument({ data: after! })));
  check(`R1 ${label}: the PDF renders`, pdf.subarray(0, 5).toString(), "%PDF-");

  if (P) {
    // Amounts come from the snapshot even if the row were changed behind the guard.
    await w.a.query("alter table orders disable trigger orders_integrity_guard");
    await w.a.query("update orders set total_inr = 1, items = '[]' where id = $1", [o1]);
    const tampered = buildInvoice(await invoiceRow(w.a, o1));
    check("R1b OS2B: reprint keeps the issued total and lines even if the row is altered", [tampered?.total, tampered?.lines.length], [2599, 1]);
    await w.a.query("update orders set total_inr = 2599, items = $2::jsonb where id = $1",
      [o1, JSON.stringify([{ id: w.productId, size: "One Size", quantity: 1, price_inr: 2500, name: "Piece" }])]);
    await w.a.query("alter table orders enable trigger orders_integrity_guard");
    const snap = (await w.a.query("select source, document->>'total_inr' t, delivery_address->>'postal_code' p, invoice_number = (select invoice_number from orders where id = $1) num from order_invoice_snapshots where order_id = $1", [o1])).rows[0];
    check("R1 OS2B: snapshot captured at issue with number, total and issued PIN", [snap.source, Number(snap.t), snap.p, snap.num], ["at_issue", 2599, "682001", true]);
  }

  // ── 3. Credit note references the right invoice and names the same party
  const o2 = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await correct(w.a, o2, { postal_code: "682020" }, "Customer emailed: wrong PIN", "A. Buyer-Corrected");
  await w.a.query("select public.cancel_order($1, 'Customer changed their mind')", [o2]);
  await asCustomer(w.a, w);
  const inv2 = buildInvoice(await invoiceRow(w.a, o2));
  const note = (await w.a.query("select id, credit_note_number, order_id, invoice_number, kind, amount_inr, reason, items, issued_at from credit_notes where order_id = $1", [o2])).rows[0];
  const cn = buildCreditNote(note, await invoiceRow(w.a, o2));
  check(`R2 ${label}: credit note quotes the invoice number`, Boolean(cn?.invoiceNumber) && cn?.invoiceNumber === inv2?.invoiceNumber, true);
  check(`R2 ${label}: invoice names`, inv2?.customer.name, P ? "A Buyer" : "A. Buyer-Corrected");
  check(`R2 ${label}: credit note names`, cn?.customer.name, P ? "A Buyer" : "A. Buyer-Corrected");
  check(`R2 ${label}: credit note and invoice print the same party and PIN`,
    cn?.customer.name === inv2?.customer.name && cn?.address?.postal_code === inv2?.address?.postal_code, true);
  check(`R2 ${label}: credit note amount from its own row`, cn?.amount, 2599);

  // ── 6/7/9. PIN validity vs deliverability; review before dispatch
  const o5 = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  // 685501 (Idukki, Kerala) is on the admin's list: a listed PIN in the order's own State.
  const e5 = await err(correct(w.a, o5, { postal_code: "685501" }));
  check(`R5 ${label}: PIN on the (non-authoritative) "don't deliver" list`, e5 === "" ? "accepted" : e5, "accepted");
  await asRoot(w.a);
  const h5 = P ? (await w.a.query("select delivery_hold from orders where id = $1", [o5])).rows[0].delivery_hold : "n/a";
  check(`R5 ${label}: …held for review, not refused`, h5, P ? "review_pending" : "n/a");
  check(`R5 ${label}: dispatch`, await (async () => { await asAdmin(w.a, w.admin); return shipOutcome(w.a, o5); })(), P ? "refused: held" : "dispatched");
  if (P) {
    const r5 = await latestReview(w.root, o5);
    check("R5 OS2B: the review records the list match", r5.listed_unserviceable_prefix, "6855");
    check("R5 OS2B: …and the PIN's postal-circle States", r5.pin_circle_states, ["kerala", "lakshadweep", "puducherry"]);
    await asAdmin(w.a, w.admin);
    check("R5 OS2B: approval without confirming the list entry refused",
      refusedWith(await err(decide(w.a, r5.id, "approve", GOOD())), "we don't deliver here"), "refused: we don't deliver here");
    check("R5 OS2B: approval with the override recorded", (await decide(w.a, r5.id, "approve", { ...GOOD(), listed_exclusion_overridden: true },
      "Speed Post counter confirmed Kattappana is served; list entry is stale")).outcome, "approved");
    check("R5 OS2B: dispatch after approval", await shipOutcome(w.a, o5), "dispatched");

    // WP-09: a listed PIN in ANOTHER State (Port Blair) on a Kerala order. Even
    // with the override and the admin typing "Kerala", it cannot be approved.
    const o5x = await paidOrder(w.root, w.productId);
    await asAdmin(w.a, w.admin);
    await correct(w.a, o5x, { postal_code: "744101", city: "Port Blair" });
    const r5x = await latestReview(w.root, o5x);
    await asAdmin(w.a, w.admin);
    check("X OS2B: cross-State PIN with State typed as the order's → refused by the postal circle",
      refusedWith(await err(decide(w.a, r5x.id, "approve", { ...GOOD("Kerala", "Port Blair"), listed_exclusion_overridden: true })), "another State"),
      "refused: another State");
    check("X OS2B: …still held", await shipOutcome(w.a, o5x), "refused: held");
    check("X OS2B: refusing it is the resolution (then cancel and re-order)", (await decide(w.a, r5x.id, "refuse",
      { pin_verified: true, verified_state: "Andaman and Nicobar Islands", serviceability_source: "India Post PIN search" },
      "Port Blair is another State: cancel and re-order")).outcome, "refused");
    check("X OS2B: cancel of the held order works", await err(w.a.query("select public.cancel_order($1, 'Out of State: re-order')", [o5x])), "");
    // State spelled differently but the same: accepted through the key.
    const o5y = await paidOrder(w.root, w.productId);
    await asRoot(w.a);
    await w.a.query(`update orders set shipping_address = shipping_address || '{"state":"KERALA "}' where id = $1`, [o5y]);
    await asAdmin(w.a, w.admin);
    await correct(w.a, o5y, { postal_code: "682011" });
    const r5y = await latestReview(w.root, o5y);
    await asAdmin(w.a, w.admin);
    check("X OS2B: same State, different case/spacing → approvable", (await decide(w.a, r5y.id, "approve", GOOD("KERALA ", "Kochi"))).outcome, "approved");
    check("X OS2B: postal-circle map: Delhi/Mumbai/Goa/Port Blair/APS",
      (await w.root.query(`select public.indian_pin_circle_states('110001') a, public.indian_pin_circle_states('400001') b,
                                  public.indian_pin_circle_states('403001') c, public.indian_pin_circle_states('744101') d,
                                  public.indian_pin_circle_states('999999') e, public.indian_pin_circle_states('654321') f`)).rows[0],
      { a: ["delhi"], b: ["maharashtra", "goa"], c: ["maharashtra", "goa"], d: ["west bengal", "sikkim", "andaman and nicobar islands"], e: [], f: [] });
    check("X OS2B: state key aliases", (await w.root.query(`select public.indian_state_key('New Delhi') a, public.indian_state_key('Jammu & Kashmir') b, public.indian_state_key('Orissa') c`)).rows[0],
      { a: "delhi", b: "jammu and kashmir", c: "odisha" });
  }

  const o5b = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  check(`R5 ${label}: 999999 (well-formed, no evidence it exists) accepted by the correction`, await err(correct(w.a, o5b, { postal_code: "999999" })), "");
  check(`R5 ${label}: …and dispatch`, await shipOutcome(w.a, o5b), P ? "refused: held" : "dispatched");
  if (P) {
    // Valid shape is not proof: the reviewer refuses.
    const r = await latestReview(w.root, o5b);
    await asAdmin(w.a, w.admin);
    check("X OS2B: 999999 cannot be approved even with every box ticked (no postal circle)",
      refusedWith(await err(decide(w.a, r.id, "approve", GOOD())), "not in any Indian postal circle"), "refused: not in any Indian postal circle");
    check("R5 OS2B: refusing needs only a reason", (await decide(w.a, r.id, "refuse",
      { pin_verified: false, serviceable: false, serviceability_source: "India Post PIN search: no such PIN" }, "PIN does not exist; asked customer")).outcome, "refused");
    await asRoot(w.a);
    check("R5 OS2B: refused review keeps the order held", (await w.a.query("select delivery_hold from orders where id = $1", [o5b])).rows[0].delivery_hold, "refused");
    await asAdmin(w.a, w.admin);
    check("R5 OS2B: refused order is not dispatched", await shipOutcome(w.a, o5b), "refused: held");
    check("R5 OS2B: a refused review cannot then be approved", refusedWith(await err(decide(w.a, r.id, "approve", GOOD())), "already refused"), "refused: already refused");
    check("R5 OS2B: correcting again opens a new review", (await correct(w.a, o5b, { postal_code: "682005" }, "Customer sent the right PIN")).outcome, "corrected");
    const r2 = await latestReview(w.root, o5b);
    check("R5 OS2B: …pending, for the new PIN", [r2.status, r2.new_pin, r2.id > r.id], ["pending", "682005", true]);
    await asAdmin(w.a, w.admin);
    // Cancel is still possible for a held order (only dispatch is blocked).
    check("R5 OS2B: a held order can still be cancelled", await err(w.a.query("select public.cancel_order($1, 'Customer withdrew')", [o5b])), "");
    // Non-PIN shapes are refused on every path, service_role included.
    const o5c = await paidOrder(w.root, w.productId);
    await asService(w.a);
    check("R5 OS2B: service_role writing '012345' is refused (no PIN starts with 0)",
      refusedWith(await err(w.a.query(`update orders set shipping_address = shipping_address || '{"postal_code":"012345"}' where id = $1`, [o5c])), "six digits"), "refused: six digits");
    check("R5 OS2B: service_role PIN change is held like any other",
      await err(w.a.query(`update orders set shipping_address = shipping_address || '{"postal_code":"682030"}' where id = $1`, [o5c])), "");
    await asRoot(w.a);
    check("R5 OS2B: …hold set", (await w.a.query("select delivery_hold from orders where id = $1", [o5c])).rows[0].delivery_hold, "review_pending");
  }

  // ── 8. Kerala ₹99 → Bengaluru PIN with the free-text State still "Kerala"
  const o6 = await paidOrder(w.root, w.productId, 99);
  await asAdmin(w.a, w.admin);
  check(`R6 ${label}: Kerala PIN → Karnataka PIN accepted by the correction`, await err(correct(w.a, o6, { postal_code: "560001", city: "Bengaluru" })), "");
  await asRoot(w.a);
  check(`R6 ${label}: charge not re-quoted (₹99 kept)`, (await w.a.query("select shipping_cost_inr::int s from orders where id = $1", [o6])).rows[0].s, 99);
  check(`R6 ${label}: the published rule quotes the new PIN at`, quoteShipping({ postal_code: "560001", country: "IN" }, 2500, DEFAULT_SHIPPING).cost, 129);
  await asAdmin(w.a, w.admin);
  if (!P) {
    check("R6 CONTROL: dispatched with nobody reviewing the ₹30 gap or the State", await shipOutcome(w.a, o6), "dispatched");
  } else {
    // Clearing the old needs_review flag, or writing the hold directly, does not release it.
    await w.a.query("update orders set needs_review = false where id = $1", [o6]);
    check("R6 OS2B: dispatch refused (needs_review cleared does not help)", await shipOutcome(w.a, o6), "refused: held");
    check("R6 OS2B: admin cannot clear the hold by UPDATE",
      refusedWith(await err(w.a.query("update orders set delivery_hold = null where id = $1", [o6])), "permission denied"), "refused: permission denied");
    await asService(w.a);
    check("R6 OS2B: service_role cannot clear the hold by UPDATE",
      refusedWith(await err(w.a.query("update orders set delivery_hold = null where id = $1", [o6])), "only by the delivery review"), "refused: only by the delivery review");
    const r6 = await latestReview(w.root, o6);
    check("R6 OS2B: review records charged ₹99, order State Kerala, PINs", [Number(r6.charged_delivery_inr), r6.order_state, r6.previous_pin, r6.new_pin], [99, "Kerala", "682001", "560001"]);
    await asAdmin(w.a, w.admin);
    check("R6 OS2B: approving with the PIN's real State (Karnataka) is refused",
      refusedWith(await err(decide(w.a, r6.id, "approve", { ...GOOD("Karnataka", "Bengaluru"), published_rate_inr: 129 })), "place of supply"), "refused: place of supply");
    for (const [k, v] of [["pin_verified", false], ["state_city_verified", false], ["serviceable", false],
                          ["serviceability_source", ""], ["courier_cost_estimate_inr", null], ["cost_difference_reviewed", false],
                          ["published_rate_inr", null]] as const) {
      const e = await err(decide(w.a, r6.id, "approve", { ...GOOD("Karnataka", "Bengaluru"), verified_state: "Kerala", [k]: v }));
      check(`R6 OS2B: approval without ${k} refused`, e !== "", true);
    }
    check("X OS2B: Karnataka PIN with State typed as Kerala and every box ticked → refused by the postal circle",
      refusedWith(await err(decide(w.a, r6.id, "approve", { ...GOOD("Kerala", "Bengaluru"), published_rate_inr: 129 })), "another State"), "refused: another State");
    check("R6 OS2B: approval with too short a reason refused", refusedWith(await err(decide(w.a, r6.id, "approve", GOOD(), "ok")), "at least 10"), "refused: at least 10");
    check("R6 OS2B: still held after the refused attempts", await shipOutcome(w.a, o6), "refused: held");
    // Refuse: the PIN is out of State. Next step is cancel and re-order.
    check("R6 OS2B: reviewer refuses (different State)", (await decide(w.a, r6.id, "refuse",
      { pin_verified: true, state_city_verified: true, verified_state: "Karnataka", verified_city: "Bengaluru", serviceable: true,
        serviceability_source: "India Post PIN search", published_rate_inr: 129, courier_cost_estimate_inr: 60, cost_difference_reviewed: true },
      "PIN is in Karnataka: cancel and re-order")).outcome, "refused");
    await asRoot(w.a);
    const rr = await latestReview(w.a, o6);
    check("R6 OS2B: the decision records state, source, published rate and courier cost",
      [rr.verified_state, rr.serviceability_source, rr.published_rate_inr, rr.courier_cost_estimate_inr, rr.decided_by_email],
      ["Karnataka", "India Post PIN search", 129, 60, "owner@example.test"]);
    const ev = (await w.a.query(
      "select action, changes->'delivery_hold'->>'to' h, reason from order_events where order_id = $1 and changes ? 'delivery_hold' order by id", [o6])).rows;
    check("R6 OS2B: hold set and refused are both in order_events with action and reason", ev.map((e) => [e.action, e.h]),
      [["admin_correct_order_contact", "review_pending"], ["admin_decide_delivery_review", "refused"]]);
    check("R6 OS2B: …the decision's reason is in order_events", ev[1]?.reason, "PIN is in Karnataka: cancel and re-order");
  }

  // Line-only change with no review history: no hold.
  const o6b = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await correct(w.a, o6b, { line1: "Flat 9, 1 Loom Street" });
  if (P) {
    await asRoot(w.a);
    check("R6 OS2B: line-only correction (same PIN, no review history) does not hold",
      (await w.a.query("select delivery_hold from orders where id = $1", [o6b])).rows[0].delivery_hold, null);
  }

  // ── 10. Repeated corrections: an approval is never reused for another address
  if (P) {
    const o7 = await paidOrder(w.root, w.productId);
    await asAdmin(w.a, w.admin);
    await correct(w.a, o7, { postal_code: "682011" });
    const first = await latestReview(w.root, o7);
    await asAdmin(w.a, w.admin);
    await correct(w.a, o7, { postal_code: "682012" }, "Customer corrected it again");
    const second = await latestReview(w.root, o7);
    check("R10 OS2B: second correction supersedes the pending review",
      [(await w.root.query("select status from order_delivery_reviews where id = $1", [first.id])).rows[0].status, second.status], ["superseded", "pending"]);
    await asAdmin(w.a, w.admin);
    check("R10 OS2B: approving the superseded review refused", refusedWith(await err(decide(w.a, first.id, "approve", GOOD())), "already superseded"), "refused: already superseded");
    check("R10 OS2B: approving the current one", (await decide(w.a, second.id, "approve", GOOD())).outcome, "approved");
    // A line-only change AFTER an approval re-holds (the approval was for another address).
    await correct(w.a, o7, { line1: "Different building" }, "Customer moved flat number");
    await asRoot(w.a);
    const third = await latestReview(w.a, o7);
    check("R10 OS2B: any address change after a review opens a new one", [third.trigger_kind, third.status],
      ["address_changed_after_review", "pending"]);
    await asAdmin(w.a, w.admin);
    check("R10 OS2B: …and holds dispatch again", await shipOutcome(w.a, o7), "refused: held");
    check("R10 OS2B: the earlier approval cannot be re-decided", refusedWith(await err(decide(w.a, second.id, "approve", GOOD())), "already approved"), "refused: already approved");
    await asRoot(w.a);
    check("R10 OS2B: a decided review cannot be edited, even by the owner",
      refusedWith(await err(w.a.query("update order_delivery_reviews set decision_reason = 'x' where id = $1", [second.id])), "only by the order functions"), "refused: only by the order functions");
    check("R10 OS2B: nor deleted", (await err(w.a.query("delete from order_delivery_reviews where id = $1", [second.id]))) !== "", true);

    // Race: decision vs a new correction — whichever commits second sees the other.
    const o8 = await paidOrder(w.root, w.productId);
    await asAdmin(w.a, w.admin);
    await correct(w.a, o8, { postal_code: "682021" });
    const r8 = await latestReview(w.root, o8);
    await asAdmin(w.a, w.admin);
    await asAdmin(w.b, w.admin2);
    await w.a.query("begin");
    await correct(w.a, o8, { postal_code: "682022" }, "Customer phoned with another PIN");
    const racing = err(decide(w.b, r8.id, "approve", GOOD()));
    check("R10 OS2B: a decision waits for a concurrent correction (row lock)", await waitsOn(w.obs, w.b, w.a), true);
    await w.a.query("commit");
    check("R10 OS2B: …then refuses the stale review", refusedWith(await racing, "already superseded"), "refused: already superseded");
    await asRoot(w.a);
    check("R10 OS2B: still held", (await w.a.query("select delivery_hold from orders where id = $1", [o8])).rows[0].delivery_hold, "review_pending");

    // Two admins deciding the same review at once: one wins.
    const r8b = await latestReview(w.root, o8);
    await asAdmin(w.a, w.admin);
    await asAdmin(w.b, w.admin2);
    await w.a.query("begin");
    await decide(w.a, r8b.id, "approve", GOOD());
    const dup = err(decide(w.b, r8b.id, "refuse", { serviceable: false }, "Second admin disagrees here"));
    check("R10 OS2B: the second decision waits", await waitsOn(w.obs, w.b, w.a), true);
    await w.a.query("commit");
    check("R10 OS2B: …and is refused (decided once)", refusedWith(await dup, "already approved"), "refused: already approved");
  }

  // Correction racing dispatch: dispatch waits on the row lock, then sees the hold.
  const o9 = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await asAdmin(w.b, w.admin2);
  const hasDispatch = (await w.b.query("select to_regprocedure('public.dispatch_order(uuid, text, text, boolean, boolean)') is not null v")).rows[0].v;
  if (!hasDispatch) await w.b.query("update orders set courier_name = 'India Post', awb_number = 'EE123456785IN' where id = $1", [o9]);
  await w.a.query("begin");
  await correct(w.a, o9, { postal_code: "682050" });
  const disp = err(hasDispatch
    ? w.b.query("select public.dispatch_order($1, 'india_post_speed_post', 'EE123456785IN', true, false)", [o9])
    : w.b.query("select public.admin_set_order_status($1, 'shipped', null)", [o9]));
  check(`R10 ${label}: dispatch waits on the correction`, await waitsOn(w.obs, w.b, w.a), true);
  await w.a.query("commit");
  const de = await disp;
  check(`R10 ${label}: dispatch after a racing PIN correction`, de === "" ? "dispatched" : de.includes("held for review") ? "refused: held" : de, P ? "refused: held" : "dispatched");

  // After dispatch: corrections refused (0078) on both.
  await asAdmin(w.a, w.admin);
  check(`R7 ${label}: correction after dispatch refused`, (await err(correct(w.a, P ? o5 : o6, { postal_code: "560002" }))).includes("only before dispatch"), true);

  // ── 12. RLS
  if (P) {
    await asCustomer(w.a, w);
    check("RLS OS2B: a customer reads their own invoice snapshot", (await w.a.query("select count(*)::int n from order_invoice_snapshots where order_id = $1", [o1])).rows[0].n, 1);
    check("RLS OS2B: a customer reads no delivery review", (await w.a.query("select count(*)::int n from order_delivery_reviews")).rows[0].n, 0);
    check("RLS OS2B: a customer cannot read the sealed store", refusedWith(await err(w.a.query("select 1 from order_invoice_sealed_parties")), "permission denied"), "refused: permission denied");
    check("RLS OS2B: a customer cannot decide a review", refusedWith(await err(decide(w.a, 1, "approve", GOOD())), "Not authorised"), "refused: Not authorised");
    await asCustomer(w.a, w, "someone-else@example.test");
    check("RLS OS2B: another customer reads no snapshot", (await w.a.query("select count(*)::int n from order_invoice_snapshots")).rows[0].n, 0);
    await asUser(w.a, w.admin, "aal1");
    check("RLS OS2B: an admin without 2FA (aal1) cannot decide", refusedWith(await err(decide(w.a, 1, "approve", GOOD())), "Not authorised"), "refused: Not authorised");
    await asService(w.a);
    check("RLS OS2B: service_role cannot decide a review (no EXECUTE)", refusedWith(await err(decide(w.a, 1, "approve", GOOD())), "permission denied"), "refused: permission denied");
    check("RLS OS2B: service_role cannot read the sealed store", refusedWith(await err(w.a.query("select 1 from order_invoice_sealed_parties")), "permission denied"), "refused: permission denied");
    // ── 1. Snapshots cannot be rewritten
    check("G OS2B: service_role cannot update a snapshot", refusedWith(await err(w.a.query("update order_invoice_snapshots set customer_name = 'X' where order_id = $1", [o1])), "permission denied"), "refused: permission denied");
    check("G OS2B: service_role cannot insert a snapshot", refusedWith(await err(w.a.query("insert into order_invoice_snapshots (order_id, invoice_number, document, source) values ($1, 'X', '{}', 'at_issue')", [o6b])), "permission denied"), "refused: permission denied");
    await asAdmin(w.a, w.admin);
    check("G OS2B: an admin cannot update a snapshot", refusedWith(await err(w.a.query("update order_invoice_snapshots set customer_name = 'X' where order_id = $1", [o1])), "permission denied"), "refused: permission denied");
    await asRoot(w.a);
    check("G OS2B: even the owner cannot rewrite a snapshot", refusedWith(await err(w.a.query("update order_invoice_snapshots set customer_name = 'X' where order_id = $1", [o1])), "do not change"), "refused: do not change");
    check("G OS2B: or its figures", refusedWith(await err(w.a.query("update order_invoice_snapshots set document = '{}' where order_id = $1", [o1])), "do not change"), "refused: do not change");
    check("G OS2B: or seal it without retaining the details", refusedWith(await err(w.a.query(
      "update order_invoice_snapshots set customer_name = null, customer_email = null, customer_phone = null, delivery_address = null, sealed_at = now() where order_id = $1", [o1])), "only after its details are retained"), "refused: only after its details are retained");
    check("G OS2B: or delete it", refusedWith(await err(w.a.query("delete from order_invoice_snapshots where order_id = $1", [o1])), "is kept"), "refused: is kept");
    check("G OS2B: an invoiced order cannot be deleted from under its snapshot", (await err(w.a.query("delete from orders where id = $1", [o1]))) !== "", true);
  }

  // ── 5. Account deletion
  await clearInFlight(w);
  await asUser(w.a, w.customer, "aal1");
  const del = (await w.a.query("select public.delete_my_account() r")).rows[0].r;
  check(`R4 ${label}: account deleted, orders anonymised`, del.ok, true);
  await asAdmin(w.a, w.admin);
  const inv4 = buildInvoice(await invoiceRow(w.a, o2));
  check(`R4 ${label}: invoice number and total survive deletion`, [Boolean(inv4?.invoiceNumber), inv4?.total], [true, 2599]);
  check(`R4 ${label}: ordinary print shows no name/email/address after deletion`, [inv4?.customer.name, inv4?.customer.email, inv4?.address], ["", "", null]);
  const cn4 = buildCreditNote(note, await invoiceRow(w.a, o2));
  check(`R4 ${label}: credit note still quotes the invoice, names nobody`, [cn4?.invoiceNumber === inv4?.invoiceNumber, cn4?.customer.name], [true, ""]);
  if (P) {
    await asRoot(w.a);
    const s = (await w.a.query("select customer_name, delivery_address, sealed_at is not null sealed, document->>'total_inr' t from order_invoice_snapshots where order_id = $1", [o2])).rows[0];
    check("R4 OS2B: readable snapshot sealed (personal fields null), figures kept", [s.customer_name, s.delivery_address, s.sealed, Number(s.t)], [null, null, true, 2599]);
    const kept = (await w.a.query("select customer_name, customer_email, delivery_address->>'postal_code' p, basis from order_invoice_sealed_parties where order_id = $1", [o2])).rows[0];
    check("R4 OS2B: the issued details are RETAINED in the restricted store, unchanged", [kept?.customer_name, kept?.customer_email, kept?.p],
      ["A Buyer", "buyer@example.test", "682001"]);
    check("R4 OS2B: every invoiced order of the customer is sealed",
      (await w.a.query("select count(*)::int n from order_invoice_snapshots s join orders o on o.id = s.order_id where o.customer_email is null and s.sealed_at is null")).rows[0].n, 0);
    check("R4 OS2B: delivery reviews redacted (PINs and city)",
      (await w.a.query("select count(*)::int n from order_delivery_reviews r join orders o on o.id = r.order_id where o.customer_email is null and (r.new_pin is not null or r.previous_pin is not null or r.verified_city is not null)")).rows[0].n, 0);
    check("R4 OS2B: no name or address copied into order_events",
      (await w.a.query("select count(*)::int n from order_events where changes::text ilike '%Loom Street%' or changes::text ilike '%A Buyer%' or changes::text ilike '%682001%'")).rows[0].n, 0);
    check("R4 OS2B: the sealed store cannot be altered", (await err(w.a.query("update order_invoice_sealed_parties set customer_name = 'X' where order_id = $1", [o2]))) !== "", true);
    check("R4 OS2B: or emptied", (await err(w.a.query("delete from order_invoice_sealed_parties where order_id = $1", [o2]))) !== "", true);
  }
  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

/** 4. History: a 0078 database with invoiced orders, then 0079 applied on top. */
async function backfill(engine: Engine) {
  console.log("\nBACKFILL (0078 database with history → 0079 applied)");
  await engine.database("os2b_bf", "0078");
  const w = await world(engine, "os2b_bf");
  const plain = await paidOrder(w.root, w.productId);
  const corrected = await paidOrder(w.root, w.productId);
  const held = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await correct(w.a, corrected, { postal_code: "682061" });
  await correct(w.a, corrected, { postal_code: "682062" }, "Second correction, customer again", "B Buyer");
  await correct(w.a, held, { line1: "New line" });
  await asRoot(w.a);
  // Pre-0078 shape: an unaudited direct edit.
  const edited = await paidOrder(w.root, w.productId);
  await w.root.query("alter table orders disable trigger orders_integrity_guard");
  await w.root.query(`update orders set shipping_address = shipping_address || '{"postal_code":"682099"}' where id = $1`, [edited]);
  await w.root.query("alter table orders enable trigger orders_integrity_guard");
  // A correction BEFORE payment is not an invoice change.
  const unpaid = (await w.root.query(
    `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name, shipping_address, payment_provider, razorpay_order_id)
     values ('[]', 100, 0, 'pending', 'placed', 'buyer@example.test', 'A Buyer', $1::jsonb, 'razorpay', 'order_bf_unpaid') returning id`, [JSON.stringify(KOCHI)])).rows[0].id;
  await asAdmin(w.a, w.admin);
  await correct(w.a, unpaid, { postal_code: "682070" }, "Before payment: typo");
  await asRoot(w.a);
  await w.a.query("update orders set payment_status = 'paid' where id = $1", [unpaid]);
  await asService(w.a);
  await w.a.query("select public.assign_invoice_number($1)", [unpaid]);
  await asRoot(w.a);
  // An already-anonymised order (0033 before 0079).
  const gone = await paidOrder(w.root, w.productId);
  await w.root.query("alter table orders disable trigger user");
  await w.root.query("update orders set status = 'delivered', delivered_at = now(), shipped_at = now() where id = $1", [gone]);
  await w.root.query("alter table orders enable trigger user");
  await w.root.query("update orders set customer_email = null, customer_name = null, customer_phone = null, shipping_address = null where id = $1", [gone]);
  // WP-09: an order with a value in the tax column (nothing in the app writes it).
  const taxed = await paidOrder(w.root, w.productId);
  await w.root.query("alter table orders disable trigger user");
  await w.root.query(`update orders set tax = '[{"label":"GST","amount":10}]' where id = $1`, [taxed]);
  await w.root.query("alter table orders enable trigger user");
  // WP-09: a credit note issued before 0079.
  const credited = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await w.a.query("select public.cancel_order($1, 'Pre-0079 cancellation')", [credited]);
  await asRoot(w.a);
  // A PIN corrected under 0078, not yet dispatched: must be held by the backfill.
  const pinFixed = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  await correct(w.a, pinFixed, { postal_code: "682080" });
  await asRoot(w.a);

  const dir = path.join(__dirname, "..", "supabase", "migrations");
  const f = fs.readdirSync(dir).find((x) => x.startsWith("0079_"))!;
  const sql = fs.readFileSync(path.join(dir, f), "utf8");
  await w.root.query(sql);
  const rows = Object.fromEntries((await w.root.query(
    "select order_id, source, provenance_note, delivery_address->>'postal_code' p, customer_name n, sealed_at is not null sealed from order_invoice_snapshots")).rows.map((r) => [r.order_id, r]));
  check("BF: uncorrected order → row_at_migration (not claimed as issued)", [rows[plain].source, rows[plain].p], ["row_at_migration", "682001"]);
  check("BF: …with an honest note", (rows[plain].provenance_note as string).includes("not proven"), true);
  check("BF: corrected after issue → reconstructed to issued PIN and name", [rows[corrected].source, rows[corrected].p, rows[corrected].n], ["reconstructed", "682001", "A Buyer"]);
  check("BF: …and says what it could not rule out", (rows[corrected].provenance_note as string).includes("cannot be ruled out"), true);
  check("BF: unaudited pre-0078 edit stays as found, labelled row_at_migration", [rows[edited].source, rows[edited].p], ["row_at_migration", "682099"]);
  check("BF: corrected before payment → not reversed", [rows[unpaid].source, rows[unpaid].p], ["row_at_migration", "682070"]);
  check("BF: already anonymised → sealed, nothing invented", [rows[gone].source, rows[gone].n, rows[gone].sealed], ["row_at_migration", null, true]);
  const inv = buildInvoice(await invoiceRow(w.root, plain));
  check("BF: builder exposes the provenance", inv?.detailsSource, "row_at_migration");
  const hold = Object.fromEntries((await w.root.query("select id, delivery_hold from orders where id = any($1)", [[pinFixed, held]])).rows.map((r) => [r.id, r.delivery_hold]));
  check("BF: a PIN corrected under 0078 and not dispatched is held", hold[pinFixed], "review_pending");
  check("BF: a line-only correction under 0078 is not held", hold[held], null);
  check("BF: …with a migration_backfill review", (await latestReview(w.root, pinFixed)).trigger_kind, "migration_backfill");
  check("BF: pre-0079 invoices carry the v1 seller block, labelled code_history_at_migration (not at_issue)",
    (await w.root.query("select distinct issuer_source, issuer->>'profile_version' v from order_invoice_snapshots")).rows, [{ issuer_source: "code_history_at_migration", v: "1" }]);
  check("BF: pre-0079 credit notes likewise",
    (await w.root.query("select issuer_source, issuer->>'profile_version' v from credit_note_issuer_snapshots s join credit_notes cn on cn.id = s.credit_note_id where cn.order_id = $1", [credited])).rows, [{ issuer_source: "code_history_at_migration", v: "1" }]);
  check("BF: a tax value found at migration is flagged for the accountant, unchanged",
    (await w.root.query("select provenance_note like '%ACCOUNTANT REVIEW%' f, document->'tax' t from order_invoice_snapshots where order_id = $1", [taxed])).rows[0], { f: true, t: [{ label: "GST", amount: 10 }] });
  check("BF: …and only that one", (await w.root.query("select count(*)::int n from order_invoice_snapshots where provenance_note like '%ACCOUNTANT REVIEW%'")).rows[0].n, 1);
  const bfInv = buildInvoice(await invoiceRow(w.root, plain));
  check("BF: the builder reports the seller block's provenance", bfInv?.issuerSource, "code_history_at_migration");
  check("BF: re-apply refused", (await err(w.root.query(sql))).includes("already applied"), true);
  // New issue after migration: at_issue.
  const fresh = await paidOrder(w.root, w.productId);
  check("BF: an invoice issued after 0079 is captured at_issue",
    (await w.root.query("select source from order_invoice_snapshots where order_id = $1", [fresh])).rows[0].source, "at_issue");
  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

/** The credit note a route gets: its row plus the seller-snapshot embed (emulated). */
async function creditNoteRow(c: Client, orderId: string) {
  return (await c.query(
    `select to_jsonb(cn) - 'issued_by' || jsonb_build_object('issuer_snapshot',
       (select jsonb_build_object('issuer', s.issuer, 'issuer_source', s.issuer_source)
          from credit_note_issuer_snapshots s where s.credit_note_id = cn.id)) j
       from credit_notes cn where cn.order_id = $1 order by issued_at desc limit 1`, [orderId])).rows[0]?.j ?? null;
}

/** WP-09: who issued the document is frozen with it. */
async function issuerScenarios(engine: Engine) {
  console.log("\nISSUER (WP-09: seller identity and tax treatment frozen per document)");
  await engine.database("os2b_iss");
  const w = await world(engine, "os2b_iss");
  await asRoot(w.root);
  const v1 = (await w.root.query("select public.invoice_issuer_at(now()) i")).rows[0].i;
  check("ISS: lib/invoice ISSUER equals 0079's v1 profile exactly (every field, no extras)",
    issuerRenderable(v1) && JSON.stringify(Object.keys(v1).sort()) === JSON.stringify(Object.keys(ISSUER).sort()), true);
  check("ISS: v1 is unregistered, no GSTIN, titled Invoice, no tax charged",
    [v1.gst_registration, v1.gstin, v1.document_title, v1.tax_treatment], ["unregistered", null, "Invoice", "no_gst_charged_unregistered"]);

  // Tax column with a value BEFORE payment (nothing in the app writes it): kept, not printed.
  const oTax = await (async () => {
    seq += 1;
    const rzp = `order_os2b_tax_${process.pid}_${seq}`;
    await asRoot(w.root);
    const id = (await w.root.query(
      `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name,
                           customer_phone, shipping_address, payment_provider, razorpay_order_id, tax)
       values ($1::jsonb, 2599, 99, 'pending', 'placed', 'buyer@example.test', 'A Buyer', '+91 90000 00001', $2::jsonb, 'razorpay', $3,
               '[{"label":"IGST 5%","amount":124}]'::jsonb) returning id`,
      [JSON.stringify([{ id: w.productId, size: "One Size", quantity: 1, price_inr: 2500, name: "Piece" }]), JSON.stringify(KOCHI), rzp])).rows[0].id;
    await asService(w.root);
    await w.root.query("select public.settle_razorpay_payment($1, $2, 259900, 'INR', 5900, 900, 'captured')", [rzp, `pay_${rzp}`]);
    await asRoot(w.root);
    return id as string;
  })();
  const invTax = buildInvoice(await invoiceRow(w.root, oTax));
  check("ISS: a tax value on the order is NOT printed for an unregistered issuer; total unchanged", [invTax?.tax, invTax?.total], [null, 2599]);
  check("ISS: …and is kept unchanged in the snapshot document",
    (await w.root.query("select document->'tax' t from order_invoice_snapshots where order_id = $1", [oTax])).rows[0].t, [{ label: "IGST 5%", amount: 124 }]);

  const o1 = await paidOrder(w.root, w.productId);
  const s1 = (await w.root.query("select issuer, issuer_source from order_invoice_snapshots where order_id = $1", [o1])).rows[0];
  check("ISS: an invoice captures the profile in force, at_issue", [s1.issuer.profile_version, s1.issuer_source], [1, "at_issue"]);
  const inv1 = buildInvoice(await invoiceRow(w.root, o1));
  check("ISS: builder exposes the issued seller block", [inv1?.issuer?.seller_name, inv1?.issuer?.gst_registration, inv1?.issuerSource], ["THE WOVENNE", "unregistered", "at_issue"]);
  const before1 = JSON.stringify(inv1);
  const pdf1 = (await renderToBuffer(InvoiceDocument({ data: inv1! }))).length;
  check("ISS: the v1 PDF renders", pdf1 > 1000, true);

  // Credit note: its own seller snapshot.
  await asAdmin(w.a, w.admin);
  await w.a.query("select public.cancel_order($1, 'Customer changed their mind')", [o1]);
  await asRoot(w.root);
  const cnRow1 = await creditNoteRow(w.root, o1);
  check("ISS: a credit note captures the profile in force, at_issue", [cnRow1?.issuer_snapshot?.issuer?.profile_version, cnRow1?.issuer_snapshot?.issuer_source], [1, "at_issue"]);
  const cn1 = buildCreditNote(cnRow1, await invoiceRow(w.root, o1));
  check("ISS: credit note builder exposes its issued seller block", [cn1?.issuer?.profile_version, cn1?.issuerSource], [1, "at_issue"]);

  // Courier expense recorded after issue does not touch the invoice.
  const o2 = await paidOrder(w.root, w.productId);
  const inv2a = JSON.stringify(buildInvoice(await invoiceRow(w.root, o2)));
  await asAdmin(w.a, w.admin);
  const courierErr = await err(w.a.query("update orders set courier_actual_cost_inr = 61 where id = $1", [o2]));
  await asService(w.a);
  const courierErrSvc = courierErr === "" ? "" : await err(w.a.query("update orders set courier_actual_cost_inr = 61 where id = $1", [o2]));
  await asRoot(w.root);
  check("ISS: actual courier cost can be recorded after issue (admin or service_role)", courierErr === "" || courierErrSvc === "", true);
  check("ISS: …kept separately on the order", Number((await w.root.query("select courier_actual_cost_inr c from orders where id = $1", [o2])).rows[0].c), 61);
  check("ISS: …and the invoice is byte-for-byte the same document data", JSON.stringify(buildInvoice(await invoiceRow(w.root, o2))), inv2a);

  // Profile table: append-only, no registration, no backdating, invisible to the API.
  check("ISS: a profile cannot be edited", refusedWith(await err(w.root.query("update invoice_issuer_profiles set seller_name = 'X'")), "add a new version"), "refused: add a new version");
  check("ISS: or removed", refusedWith(await err(w.root.query("delete from invoice_issuer_profiles")), "add a new version"), "refused: add a new version");
  check("ISS: registering for GST is refused by this version",
    refusedWith(await err(w.root.query(`insert into invoice_issuer_profiles (version, effective_from, seller_name, address_lines, gst_registration, gstin, document_title, tax_treatment, basis)
      values (2, now(), 'THE WOVENNE', '["Somewhere"]', 'registered', '32ABCDE1234F1Z5', 'Tax Invoice', 'gst_registered', 'test registration attempt, must be refused')`)), "not supported"), "refused: not supported");
  check("ISS: an unregistered profile cannot carry a GSTIN or a tax title",
    (await err(w.root.query(`insert into invoice_issuer_profiles (version, effective_from, seller_name, address_lines, gst_registration, gstin, document_title, tax_treatment, basis)
      values (2, now(), 'THE WOVENNE', '["Somewhere"]', 'unregistered', '32ABCDE1234F1Z5', 'Tax Invoice', 'no_gst_charged_unregistered', 'inconsistent profile, must be refused')`))).includes("invoice_issuer_profiles_consistent"), true);
  check("ISS: a new profile cannot be backdated",
    refusedWith(await err(w.root.query(`insert into invoice_issuer_profiles (version, effective_from, seller_name, address_lines, gst_registration, gstin, document_title, tax_treatment, basis)
      values (2, now() - interval '1 day', 'THE WOVENNE', '["Somewhere"]', 'unregistered', null, 'Invoice', 'no_gst_charged_unregistered', 'backdated profile, must be refused')`)), "never backdated"), "refused: never backdated");
  for (const role of ["anon", "authenticated", "service_role"]) {
    check(`ISS: ${role} cannot read the profile table`, (await w.root.query(`select has_table_privilege('${role}', 'public.invoice_issuer_profiles', 'SELECT') v`)).rows[0].v, false);
  }
  check("ISS: the snapshot's seller block cannot be rewritten",
    refusedWith(await err(w.root.query(`update order_invoice_snapshots set issuer = issuer || '{"seller_name":"X"}' where order_id = $1`, [o2])), "do not change"), "refused: do not change");
  check("ISS: a credit note's seller block cannot be rewritten",
    refusedWith(await err(w.root.query(`update credit_note_issuer_snapshots set issuer = '{"profile_version":9}'`)), "does not change"), "refused: does not change");

  // RLS on the credit-note seller snapshot: the customer of the order, not another.
  await asCustomer(w.a, w);
  check("ISS: the customer reads their credit note's seller snapshot",
    (await w.a.query("select count(*)::int n from credit_note_issuer_snapshots")).rows[0].n >= 1, true);
  await asRoot(w.root);
  const other = (await w.root.query("insert into auth.users (email) values ('other@example.test') returning id")).rows[0].id;
  await asUser(w.b, other, "aal1");
  await w.b.query("select set_config('request.jwt.claim.email', 'other@example.test', false)");
  check("ISS: another customer reads none", (await w.b.query("select count(*)::int n from credit_note_issuer_snapshots")).rows[0].n, 0);
  check("ISS: …nor any invoice seller block", (await w.b.query("select count(*)::int n from order_invoice_snapshots")).rows[0].n, 0);
  await asRoot(w.b);

  // A later profile (a new address — registration is refused) reaches only new documents.
  await asRoot(w.root);
  await w.root.query(`insert into invoice_issuer_profiles (version, effective_from, seller_name, address_lines, gst_registration, gstin, document_title, tax_treatment, basis)
    values (2, now(), 'THE WOVENNE', '["New Studio", "Kochi", "Kerala 682001", "India"]', 'unregistered', null, 'Invoice', 'no_gst_charged_unregistered', 'TEST ONLY: a moved studio, to prove old documents keep v1')`);
  check("ISS: after v2, the old invoice still carries v1",
    (await w.root.query("select issuer->>'profile_version' v from order_invoice_snapshots where order_id = $1", [o2])).rows[0].v, "1");
  check("ISS: …and reprints exactly as before", JSON.stringify(buildInvoice(await invoiceRow(w.root, o2))), inv2a);
  check("ISS: …as does the earlier credit note's seller block", buildCreditNote(await creditNoteRow(w.root, o1), await invoiceRow(w.root, o1))?.issuer?.address_lines, ISSUER.address_lines);
  const o3 = await paidOrder(w.root, w.productId);
  check("ISS: a new invoice captures v2",
    (await w.root.query("select issuer->>'profile_version' v, issuer->'address_lines'->>0 a from order_invoice_snapshots where order_id = $1", [o3])).rows[0], { v: "2", a: "New Studio" });
  const orig = console.error;
  const logged: string[] = [];
  console.error = (m: string) => logged.push(String(m));
  const inv3 = buildInvoice(await invoiceRow(w.root, o3));
  console.error = orig;
  check("ISS: v1 code REFUSES to reprint a v2 document (never prints today's block on it)", inv3, null);
  check("ISS: …and logs why", logged.some((m) => m.includes("seller profile v2")), true);
  check("ISS: issuerRenderable rejects any drift (address, GST status, GSTIN, title)",
    [issuerRenderable({ ...ISSUER, address_lines: ["x"] }), issuerRenderable({ ...ISSUER, gst_registration: "registered" }),
     issuerRenderable({ ...ISSUER, gstin: "32ABCDE1234F1Z5" }), issuerRenderable({ ...ISSUER, document_title: "Tax Invoice" }), issuerRenderable(ISSUER)],
    [false, false, false, false, true]);
  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

/** WP-09: sealed details after account deletion — removed from ordinary access, retained, read with a log, purged only under a recorded rule. */
async function retention(engine: Engine) {
  console.log("\nRETAIN (WP-09: deletion, restricted retention, lawful expiry)");
  await engine.database("os2b_ret");
  const w = await world(engine, "os2b_ret");
  const oldOne = await paidOrder(w.root, w.productId);
  const newOne = await paidOrder(w.root, w.productId);
  await asAdmin(w.a, w.admin);
  for (const o of [oldOne, newOne]) {
    await ship(w.a, o);
  }
  await asRoot(w.root);
  await w.root.query("alter table orders disable trigger user");
  await w.root.query("update orders set status = 'delivered', delivered_at = now() where id = any($1)", [[oldOne, newOne]]);
  await w.root.query("alter table orders enable trigger user");
  await asUser(w.a, w.customer, "aal1");
  check("RET: customer deletes their account", (await w.a.query("select public.delete_my_account() r")).rows[0].r.ok, true);
  await asRoot(w.root);
  check("RET: the auth user and profile are gone (no sign-in, no profile data)",
    (await w.root.query("select (select count(*) from auth.users where id = $1)::int u, (select count(*) from profiles where id = $1)::int p", [w.customer])).rows[0], { u: 0, p: 0 });
  check("RET: orders anonymised (no name/email/phone/address)",
    (await w.root.query("select count(*)::int n from orders where id = any($1) and (customer_email is not null or customer_name is not null or customer_phone is not null or shipping_address is not null)", [[oldOne, newOne]])).rows[0].n, 0);
  check("RET: both invoices sealed; details retained in the restricted store",
    (await w.root.query("select count(*)::int n from order_invoice_sealed_parties where order_id = any($1) and customer_email = 'buyer@example.test'", [[oldOne, newOne]])).rows[0].n, 2);

  // Ordinary access: admin and service_role see nothing personal.
  await asAdmin(w.a, w.admin);
  const adminInv = buildInvoice(await invoiceRow(w.a, oldOne));
  check("RET: admin reprint names nobody", [adminInv?.customer.name, adminInv?.customer.email, adminInv?.address], ["", "", null]);
  check("RET: admin cannot read the sealed store", refusedWith(await err(w.a.query("select * from order_invoice_sealed_parties")), "permission denied"), "refused: permission denied");
  check("RET: admin cannot call the owner read", refusedWith(await err(w.a.query("select * from public.owner_read_sealed_invoice_party($1, 'accountant_review', 'test ref')", [oldOne])), "permission denied"), "refused: permission denied");
  await asService(w.a);
  check("RET: service_role cannot read the sealed store", refusedWith(await err(w.a.query("select * from order_invoice_sealed_parties")), "permission denied"), "refused: permission denied");
  check("RET: service_role cannot purge", refusedWith(await err(w.a.query("select * from public.owner_purge_sealed_invoice_parties(1, true)")), "permission denied"), "refused: permission denied");
  check("RET: service_role cannot read the access log", refusedWith(await err(w.a.query("select * from sealed_record_access_log")), "permission denied"), "refused: permission denied");
  await asRoot(w.a);

  // Owner read: purpose and reference required, logged first.
  check("RET: owner read needs a known purpose", (await err(w.root.query("select * from public.owner_read_sealed_invoice_party($1, 'curiosity', 'ref 12345')", [oldOne]))).includes("sealed_record_access_log_purpose_check"), true);
  check("RET: owner read needs a reference", (await err(w.root.query("select * from public.owner_read_sealed_invoice_party($1, 'accountant_review', '')", [oldOne]))).includes("sealed_record_access_log_reference_check"), true);
  const read = (await w.root.query("select * from public.owner_read_sealed_invoice_party($1, 'tax_or_regulatory_enquiry', 'Notice ref TEST/123')", [oldOne])).rows[0];
  check("RET: owner read returns the issued details", [read.customer_name, read.delivery_address.postal_code], ["A Buyer", "682001"]);
  check("RET: …and the read is logged with purpose and reference",
    (await w.root.query("select purpose, reference from sealed_record_access_log where order_id = $1", [oldOne])).rows, [{ purpose: "tax_or_regulatory_enquiry", reference: "Notice ref TEST/123" }]);
  check("RET: the access log cannot be edited", refusedWith(await err(w.root.query("update sealed_record_access_log set reference = 'x'")), "append-only"), "refused: append-only");

  // Purge: nothing without a rule; a rule only purges what has expired; logged first.
  check("RET: no rule → purge refused (period unknown ≠ forever, but nothing is guessed)",
    refusedWith(await err(w.root.query("select * from public.owner_purge_sealed_invoice_parties(1, true)")), "No such retention rule"), "refused: No such retention rule");
  check("RET: a rule needs a basis and who confirmed it", (await err(w.root.query(
    "insert into financial_record_retention_rules (record_kind, period_months, starts_from, basis, confirmed_by) values ('invoice_party_details', 12, 'invoice_issued', 'short', '')"))) !== "", true);
  const rule = (await w.root.query(`insert into financial_record_retention_rules (record_kind, period_months, starts_from, basis, confirmed_by)
    values ('invoice_party_details', 12, 'invoice_issued', 'TEST ONLY: 12 months from issue, fictional CA confirmation', 'Test CA') returning id`)).rows[0].id;
  // Make one invoice two years old (test only: the snapshot guard is lifted for the backdate).
  await w.root.query("alter table order_invoice_snapshots disable trigger order_invoice_snapshots_guard");
  await w.root.query("update order_invoice_snapshots set invoice_issued_at = now() - interval '2 years' where order_id = $1", [oldOne]);
  await w.root.query("alter table order_invoice_snapshots enable trigger order_invoice_snapshots_guard");
  const dry = (await w.root.query("select order_id, purged from public.owner_purge_sealed_invoice_parties($1)", [rule])).rows;
  check("RET: dry run lists only the expired record, removes nothing", [dry.map((r) => r.order_id), dry.map((r) => r.purged),
    (await w.root.query("select count(*)::int n from order_invoice_sealed_parties where order_id = any($1)", [[oldOne, newOne]])).rows[0].n],
    [[oldOne], [false], 2]);
  check("RET: a direct delete is still refused", refusedWith(await err(w.root.query("delete from order_invoice_sealed_parties where order_id = $1", [oldOne])), "not changed or removed"), "refused: not changed or removed");
  check("RET: …even with the purge flag set by hand (no log entry)", refusedWith(await err(w.root.query(
    "select set_config('wovenne.sealed_purge', 'on', false); delete from order_invoice_sealed_parties where order_id = '" + oldOne + "'")), "not changed or removed"), "refused: not changed or removed");
  await w.root.query("select set_config('wovenne.sealed_purge', '', false)");
  const done = (await w.root.query("select order_id, purged from public.owner_purge_sealed_invoice_parties($1, true)", [rule])).rows;
  check("RET: execute purges the expired record", [done.map((r) => r.order_id), done.map((r) => r.purged)], [[oldOne], [true]]);
  check("RET: …the sealed details are gone, the unexpired one stays",
    (await w.root.query("select order_id from order_invoice_sealed_parties where order_id = any($1)", [[oldOne, newOne]])).rows.map((r) => r.order_id), [newOne]);
  check("RET: …the purge is logged (no personal data) under the rule",
    (await w.root.query("select order_id, rule_id::int r from sealed_record_purge_log")).rows, [{ order_id: oldOne, r: Number(rule) }]);
  check("RET: …and the invoice number and figures remain readable",
    (await w.root.query("select invoice_number is not null n, (document->>'total_inr')::numeric::int t from order_invoice_snapshots where order_id = $1", [oldOne])).rows[0], { n: true, t: 2599 });
  check("RET: a rule cannot be edited after the fact", refusedWith(await err(w.root.query("update financial_record_retention_rules set period_months = 1")), "append-only"), "refused: append-only");
  check("RET: expiry from the financial year end (issued 10 May 2026 → 1 Apr 2027 + 12 months)",
    (await w.root.query(`select to_char(public.sealed_record_expiry('2026-05-10T10:00:00+05:30',
       row(0, 'invoice_party_details', 12, 'financial_year_end', 'x', 'x', now())::financial_record_retention_rules) at time zone 'Asia/Kolkata', 'YYYY-MM-DD') d`)).rows[0].d, "2028-04-01");
  for (const c of [w.root, w.a, w.b, w.obs]) await c.end();
}

function pure() {
  console.log("\nPURE (builders + delivery rules, TS)");
  const row = {
    id: "00000000-0000-0000-0000-000000000001", invoice_number: "WOV-2026-0001", invoice_issued_at: "2026-11-08T00:00:00Z",
    created_at: "2026-11-07T00:00:00Z", customer_name: "Live Name", customer_email: "live@example.test", customer_phone: null,
    shipping_address: { ...KOCHI, postal_code: "682999" }, items: [{ name: "Piece", size: "", quantity: 1, price_inr: 100 }],
    total_inr: 199, shipping_cost_inr: 99, payment_provider: "razorpay", payment_status: "paid", razorpay_order_id: "order_x",
  };
  check("PURE: no snapshot → order row (pre-0079 behaviour)", [buildInvoice(row)?.customer.name, buildInvoice(row)?.detailsSource], ["Live Name", "order_row"]);
  const snap = { invoice_number: "WOV-2026-0001", invoice_issued_at: "2026-11-08T00:00:00Z", order_created_at: "2026-11-07T00:00:00Z",
    customer_name: "Issued Name", customer_email: "issued@example.test", customer_phone: null, delivery_address: KOCHI,
    document: { total_inr: 199, items: row.items, shipping_cost_inr: 99, payment_status: "paid" }, source: "at_issue" as const, sealed_at: null };
  const b = buildInvoice({ ...row, invoice_snapshot: snap });
  check("PURE: snapshot wins for party and address", [b?.customer.name, b?.address?.postal_code, b?.detailsSource], ["Issued Name", "682001", "at_issue"]);
  const sealed = buildInvoice({ ...row, customer_name: null, customer_email: null, shipping_address: null,
    invoice_snapshot: { ...snap, customer_name: null, customer_email: null, delivery_address: null, sealed_at: "2026-11-09" } });
  check("PURE: sealed snapshot prints blank (as an erased row did)", [sealed?.customer.name, sealed?.address], ["", null]);
  check("PURE: format: 999999 is a valid shape", isValidPostalFormat("in", "999999"), true);
  check("PURE: format: 012345 is not", isValidPostalFormat("in", "012345"), false);
  const verdict = resolveDelivery({ market: "in", postalCode: "744101", orderValueInr: 2500, delivery: { ...DEFAULT_DELIVERY, unserviceable_prefixes: ["744"] }, shipping: DEFAULT_SHIPPING });
  check("PURE: the estimator calls a listed PIN 'unserviceable'", verdict.status, "unserviceable");
  check("PURE: …but checkout charges it anyway (the list is not enforced, so not authoritative)", quoteShipping({ postal_code: "744101", country: "IN" }, 2500, DEFAULT_SHIPPING).cost, 129);
  check("PURE: above ₹3,000 any PIN is free", quoteShipping({ postal_code: "560001", country: "IN" }, 3000, DEFAULT_SHIPPING).cost, 0);
}

(async () => {
  pure();
  const engine = await startEngine();
  if (!engine) { console.error("FAIL: no PG harness (PG_HARNESS_DIR)"); process.exit(2); }
  console.log(engine.version);
  if (!engine.version.startsWith("PostgreSQL 17.6")) { console.error("FAIL: not PG 17.6"); await engine.stop(); process.exit(2); }
  try {
    await scenarios(engine, "CONTROL");
    await scenarios(engine, "OS2B");
    await backfill(engine);
    await issuerScenarios(engine);
    await retention(engine);
  } catch (e) {
    failed++;
    console.error("CRASH", e);
  } finally {
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
