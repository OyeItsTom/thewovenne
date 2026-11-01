/**
 * WP-EMAIL-E3a — dispatch_order (0075) in real PostgreSQL 17.6, and the
 * shipping email through R1's durable delivery (0074).
 *
 *   A. who may dispatch: two-factor admin only; aal1 staff, customers, anon
 *      and service_role refused;
 *   B. which orders: paid, not cancelled, placed/confirmed, with an address;
 *      consignment shape; one intent per dispatch, repeats, 8-way concurrency;
 *   C. the guard: no direct UPDATE into shipped, no editing courier/number
 *      after dispatch; everything else an admin does still works;
 *   D. the email: R1's attempt renders the shipment kind, sends once under
 *      shipment-notification/<order>/1, is not sent after cancellation, is
 *      scrubbed by account deletion, and is recovered by the R1 worker;
 *   E. migration order and the guarded removal;
 *   F. WP-EMAIL-E3c: the server dispatch (lib/dispatchOrder, as the route runs
 *      it) — confirmation of unusual numbers, the one bounded email attempt
 *      and every provider outcome, interruption, retries, double clicks,
 *      cancellation racing the email, and the admin's status read.
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/order-dispatch.test.ts
 *
 * Contacts nothing: a throwaway local cluster and a fake Resend.
 */
process.env.RESEND_API_KEY = "re_" + "dummy_key_for_tests_only_000000";

import { asAdmin, asRoot, asService, asStaffPasswordOnly, asUser, failure, failureCode, makeAdmin, startEngine, type Client } from "./pg-world";
import { sendEmail } from "../lib/email";
import { attemptOrderConfirmation, type AttemptDeps } from "../lib/orderConfirmationDelivery";
import { runConfirmationRecovery } from "../lib/orderConfirmationRecovery";
import { renderShipmentNotification } from "../lib/sendShipmentNotification";
import { checkConsignment, INDIA_POST_LABEL, INDIA_POST_TRACKING_URL, s10CheckDigit } from "../lib/couriers/indiaPost";
import { performDispatch, type DispatchDeps } from "../lib/dispatchOrder";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
  }
}

const COURIER = "india_post_speed_post";
const sp = (serial: string) => `EE${serial}${s10CheckDigit(serial)}IN`;
const ADDRESS = { line1: "12 Lake Road", line2: "", city: "Kochi", state: "Kerala", postal_code: "682001", country: "India" };

type Supa = AttemptDeps["supabase"];
const RPC: Record<string, [string, string[], "rows" | "scalar"]> = {
  claim_order_email_delivery: ["select * from public.claim_order_email_delivery($1, $2)", ["p_delivery_id", "p_lease_seconds"], "rows"],
  begin_order_email_request: ["select * from public.begin_order_email_request($1, $2, $3, $4, $5, $6)", ["p_delivery_id", "p_lease_token", "p_subject", "p_html", "p_text", "p_sha256"], "rows"],
  record_order_email_outcome: ["select public.record_order_email_outcome($1, $2, $3, $4, $5, $6, $7) as r", ["p_delivery_id", "p_lease_token", "p_outcome", "p_provider_message_id", "p_http_status", "p_error_code", "p_error"], "scalar"],
  expire_stale_order_email_deliveries: ["select public.expire_stale_order_email_deliveries($1::interval) as r", ["p_older_than"], "scalar"],
  list_due_order_email_deliveries: ["select * from public.list_due_order_email_deliveries($1)", ["p_limit"], "rows"],
  list_unqueued_paid_orders: ["select * from public.list_unqueued_paid_orders($1)", ["p_limit"], "rows"],
  order_email_delivery_summary: ["select public.order_email_delivery_summary() as r", [], "scalar"],
  enqueue_order_confirmation: ["select * from public.enqueue_order_confirmation($1)", ["p_order_id"], "rows"],
};
/** service_role over a real connection, PostgREST-shaped: rpc + from(orders).select.eq.maybeSingle. */
function client(c: Client): Supa {
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const q = RPC[fn];
      if (!q) throw new Error(`unmapped rpc ${fn}`);
      try {
        const res = await c.query(q[0], q[1].map((k) => args[k] ?? null));
        return { data: q[2] === "scalar" ? res.rows[0]?.r : res.rows, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
      }
    },
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: unknown) => ({
          maybeSingle: async () => {
            try {
              const res = await c.query(`select ${cols} from public.${table} where ${col} = $1`, [val]);
              return { data: res.rows[0] ?? null, error: null };
            } catch (e) {
              return { data: null, error: { message: (e as Error).message } };
            }
          },
        }),
      }),
    }),
  } as unknown as Supa;
}

function fakeResend() {
  const keys = new Map<string, string>();
  const calls: { key: string; body: Record<string, unknown> }[] = [];
  let sent = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    const key = (init.headers as Record<string, string>)["Idempotency-Key"];
    calls.push({ key, body: JSON.parse(String(init.body)) });
    const id = keys.get(key) ?? `re_${++sent}`;
    keys.set(key, id);
    return new Response(JSON.stringify({ id }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, emailsSent: () => sent };
}

async function main() {
  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED — embedded-postgres not found (set PG_HARNESS_DIR). Nothing was verified.");
    process.exit(0);
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);
  const conns: Client[] = [];
  const connect = async () => {
    const c = await engine.connect("e3");
    conns.push(c);
    return c;
  };
  try {
    await engine.database("e3");
    const root = await connect();
    await asRoot(root);
    const one = async (q: string, a: unknown[] = []) => (await root.query(q, a)).rows[0];
    const adminId = await makeAdmin(root, "admin@example.test");
    const admin = await connect();
    await asAdmin(admin, adminId);
    const svc = await connect();
    await asService(svc);

    let n = 0;
    const order = async (o: { paid?: boolean; status?: string; email?: string | null; address?: unknown; provider?: string } = {}) =>
      (await one(
        `insert into orders (customer_email, customer_name, total_inr, payment_status, payment_provider, razorpay_order_id, items, shipping_address, status)
         values ($1, 'Asha Menon', 2950, $2, $3, $4, $5::jsonb, $6::jsonb, $7) returning id`,
        [
          o.email === undefined ? `c${++n}@example.test` : o.email,
          o.paid === false ? "pending" : "paid",
          o.provider ?? "razorpay",
          `order_D${++n}`,
          JSON.stringify([{ id: "p", size: "M", quantity: 1, price_inr: 2950 }]),
          o.address === undefined ? JSON.stringify(ADDRESS) : o.address === null ? null : JSON.stringify(o.address),
          o.status ?? "placed",
        ]
      )).id as string;
    const dispatch = (c: Client, id: string, consignment: string, courier = COURIER, confirm = false) =>
      c.query("select public.dispatch_order($1, $2, $3, $4) r", [id, courier, consignment, confirm]).then((x) => x.rows[0].r as { outcome: string; delivery_id: string | null; emailed?: boolean; email?: string });
    const ord = (id: string) => one("select status, shipped_at, courier_name, awb_number, payment_status from orders where id = $1", [id]);
    const rows = async (id: string) => (await root.query("select * from order_email_deliveries where order_id = $1 and kind = 'shipment_notification'", [id])).rows;

    // ══ A. Who may dispatch ══════════════════════════════════════════════════
    console.log("A. Authority");
    {
      const o = await order();
      const staff = await connect();
      await asStaffPasswordOnly(staff, adminId);
      const custId = (await one("insert into auth.users (email) values ('cust@example.test') returning id")).id;
      const cust = await connect();
      await asUser(cust, custId, "aal2");
      const anon = await connect();
      await anon.query("set role anon");
      check("staff with password only (aal1) refused", /Not authorised/.test(await failure(() => dispatch(staff, o, sp("10000001")))), true);
      check("customer (even aal2) refused", /Not authorised/.test(await failure(() => dispatch(cust, o, sp("10000001")))), true);
      check("anon cannot execute it at all", /permission denied/.test(await failure(() => dispatch(anon, o, sp("10000001")))), true);
      check("service_role (no signed-in admin) refused", /Not authorised/.test(await failure(() => dispatch(svc, o, sp("10000001")))), true);
      check("nothing changed by the refusals", [(await ord(o)).status, (await rows(o)).length], ["placed", 0]);
      const signedOut = await connect();
      await asAdmin(signedOut, adminId);
      await root.query("delete from auth.sessions where user_id = $1 and id = (select (current_setting('request.jwt.claims', true))::uuid)", [adminId]).catch(() => {});
      await root.query("delete from auth.sessions where user_id = $1", [adminId]);
      check("an admin whose session has ended (0067) is refused", /Not authorised/.test(await failure(() => dispatch(signedOut, o, sp("10000001")))), true);
      await asAdmin(admin, adminId); // fresh live session for the rest
    }

    // ══ B. Which orders, and one intent per dispatch ═════════════════════════
    console.log("B. Dispatch rules");
    {
      const o = await order({ status: "confirmed" });
      const num = sp("47312482");
      const r = await dispatch(admin, o, num);
      check("paid + address: dispatched, one intent", [r.outcome, typeof r.delivery_id, r.emailed], ["dispatched", "string", true]);
      const after = await ord(o);
      check("order: shipped, stamped, fixed label, number stored", [after.status, !!after.shipped_at, after.courier_name, after.awb_number], ["shipped", true, INDIA_POST_LABEL, num]);
      const d = (await rows(o))[0];
      check("delivery row: shipment kind, gen 1, fixed key, frozen recipient, pending", [d.kind, d.generation, d.idempotency_key, d.recipient, d.status], ["shipment_notification", 1, `shipment-notification/${o}/1`, (await one("select customer_email from orders where id = $1", [o])).customer_email, "pending"]);

      const again = await dispatch(admin, o, num);
      check("same dispatch again (double click / retry): already_dispatched, same row", [again.outcome, again.delivery_id === r.delivery_id, (await rows(o)).length], ["already_dispatched", true, 1]);
      check("shipped_at not re-stamped by the repeat", (await ord(o)).shipped_at.getTime(), after.shipped_at.getTime());
      check("different number on a shipped order refused (corrections are their own step)", /already been dispatched with different details/.test(await failure(() => dispatch(admin, o, sp("12345678")))), true);

      const placed = await order({ status: "placed" });
      check("placed (paid, not yet confirmed) can be dispatched", (await dispatch(admin, placed, sp("20000002"))).outcome, "dispatched");

      const unpaid = await order({ paid: false });
      check("unpaid refused", /Only a paid order/.test(await failure(() => dispatch(admin, unpaid, sp("20000003")))), true);
      const cancelled = await order({ status: "cancelled" });
      check("cancelled refused", /cancelled order cannot be dispatched/.test(await failure(() => dispatch(admin, cancelled, sp("20000004")))), true);
      const delivered = await order({ status: "delivered" });
      check("already delivered (never dispatched here) refused, no email", [/already been dispatched/.test(await failure(() => dispatch(admin, delivered, sp("20000005")))), (await rows(delivered)).length], [true, 0]);
      for (const [label, addr] of [["no address", null], ["empty object", {}], ["no line1", { ...ADDRESS, line1: " " }], ["no city", { ...ADDRESS, city: "" }], ["no PIN", { ...ADDRESS, postal_code: "" }], ["not an object", ["x"]]] as const) {
        const id = await order({ address: addr });
        check(`address ${label}: refused, untouched`, [/no complete delivery address/.test(await failure(() => dispatch(admin, id, sp("20000006")))), (await ord(id)).status], [true, "placed"]);
      }
      const inPerson = await order({ provider: "offline", address: null, status: "confirmed" });
      check("in-person order without an address refused", /no complete delivery address/.test(await failure(() => dispatch(admin, inPerson, sp("20000007")))), true);
      const inPersonPosted = await order({ provider: "offline", status: "confirmed" });
      const ip = await dispatch(admin, inPersonPosted, sp("20000017"));
      check("in-person order with an address: dispatched, NO shipping email intent", [ip.outcome, ip.delivery_id, ip.emailed, ip.email, (await rows(inPersonPosted)).length, (await ord(inPersonPosted)).status], ["dispatched", null, false, "in_person", 0, "shipped"]);
      check("…and a repeat stays without one", [(await dispatch(admin, inPersonPosted, sp("20000017"))).outcome, (await rows(inPersonPosted)).length], ["already_dispatched", 0]);
      const forCourier = await order();
      check("unknown courier refused", /Only India Post Speed Post/.test(await failure(() => dispatch(admin, forCourier, sp("20000008"), "delhivery"))), true);
      for (const bad of ["ee123456789in", "EE 123", "EE-123", "<b>1</b>", "A".repeat(31), ""]) {
        const target = await order();
        check(`consignment shape refused in the database: ${JSON.stringify(bad)}`, /letters and digits only/.test(await failure(() => dispatch(admin, target, bad))), true);
      }
      {
        const u = await order();
        const refusedUnusual = await failure(() => dispatch(admin, u, "1234567890"));
        check("an unusual number without confirmation is refused by the database, order untouched", [/confirm it before dispatching/.test(refusedUnusual), (await ord(u)).status, (await rows(u)).length], [true, "placed", 0]);
        check("an unusual but well-formed number, confirmed, is NOT refused", (await dispatch(admin, u, "1234567890", COURIER, true)).outcome, "dispatched");
        const wrongDigit = `EE12345678${(s10CheckDigit("12345678") + 1) % 10}IN`;
        const u2 = await order();
        const u3 = await order();
        check("check-digit mismatch needs confirmation in the database too", /confirm it before dispatching/.test(await failure(() => dispatch(admin, u2, wrongDigit))), true);
        check("a registered-post (R…IN) number needs confirmation", /confirm it before dispatching/.test(await failure(() => dispatch(admin, u3, "RR123456785IN"))), true);
        check("a valid Speed Post number needs no confirmation", (await dispatch(admin, await order(), sp("12345678"))).outcome, "dispatched");
        // The database and the app classify identically.
        const samples = ["EE123456785IN", wrongDigit, "RR123456785IN", "EE123456785GB", "EZ000000000IN", "E1123456785IN", "1234567890", "EEE23456785IN", "EE1234567851N"];
        for (let i = 0; i < 400; i++) {
          const serial = String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
          const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          const l = () => letters[Math.floor(Math.random() * 26)];
          const svc2 = Math.random() < 0.6 ? "E" + l() : l() + l();
          const dig = Math.random() < 0.7 ? s10CheckDigit(serial) : Math.floor(Math.random() * 10);
          samples.push(`${svc2}${serial}${dig}${Math.random() < 0.85 ? "IN" : l() + l()}`);
        }
        const db = (await root.query("select x, public.is_speed_post_consignment(x) ok from unnest($1::text[]) x", [samples])).rows as { x: string; ok: boolean }[];
        const disagree = db.filter((r) => { const c = checkConsignment(r.x); return (c.ok && c.kind === "speed_post") !== r.ok; }).map((r) => r.x);
        check(`database and app agree on which numbers are Speed Post (${samples.length} samples)`, disagree, []);
      }
      check("missing order", await failureCode(() => dispatch(admin, "00000000-0000-4000-8000-000000000000", sp("20000009"))), "P0002");

      const noEmail = await order({ email: null });
      const ne = await dispatch(admin, noEmail, sp("20000010"));
      const ner = (await rows(noEmail))[0];
      check("no recipient: dispatched, intent recorded as failed (no_recipient), emailed false", [ne.outcome, ne.emailed, ner.status, ner.last_error_code, ner.recipient], ["dispatched", false, "failed", "no_recipient", null]);

      // Concurrency: 8 admin tabs at once.
      const race = await order();
      const tabs = await Promise.all(Array.from({ length: 8 }, () => connect()));
      for (const tab of tabs) await asAdmin(tab, adminId);
      const outs = await Promise.all(tabs.map((tab) => dispatch(tab, race, sp("30000003"))));
      check("8 concurrent dispatches: one dispatched, seven already_dispatched", [outs.filter((x) => x.outcome === "dispatched").length, outs.filter((x) => x.outcome === "already_dispatched").length], [1, 7]);
      check("…one row, all naming it", [(await rows(race)).length, new Set(outs.map((x) => x.delivery_id)).size], [1, 1]);
      const race2 = await order();
      const mixed = await Promise.allSettled(tabs.map((tab, i) => dispatch(tab, race2, sp(String(40000000 + (i % 2))))));
      check("8 concurrent with two different numbers: exactly one dispatch wins, no second row", [mixed.filter((m) => m.status === "fulfilled" && m.value.outcome === "dispatched").length, (await rows(race2)).length], [1, 1]);

      // Historical: shipped before E3 with a free-text courier.
      const old = await order({ status: "shipped" });
      // Fixture: as it was written before 0075 existed (the guard rightly refuses this now).
      await root.query("set session_replication_role = replica");
      await root.query("update orders set courier_name = 'Delhivery', awb_number = 'DL123' where id = $1", [old]);
      await root.query("set session_replication_role = origin");
      check("historical shipped order: refused, never emailed", [/already been dispatched/.test(await failure(() => dispatch(admin, old, "DL123"))), (await rows(old)).length], [true, 0]);
    }

    // ══ C. The guard ═════════════════════════════════════════════════════════
    console.log("C. Guard");
    {
      const o = await order({ status: "confirmed" });
      check("admin's browser UPDATE into shipped refused", /only by dispatching them/.test(await failure(() => admin.query("update orders set status = 'shipped' where id = $1", [o]))), true);
      check("…even by the database owner", /only by dispatching them/.test(await failure(() => root.query("update orders set status = 'shipped' where id = $1", [o]))), true);
      check("…and by service_role", /only by dispatching them/.test(await failure(() => svc.query("update orders set status = 'shipped' where id = $1", [o]))), true);
      check("before dispatch: courier cannot be typed in either", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set courier_name = 'x' where id = $1", [o]))), true);
      check("before dispatch: number cannot be typed in either", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set awb_number = 'y' where id = $1", [o]))), true);
      check("before dispatch: shipped_at cannot be stamped", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set shipped_at = now() where id = $1", [o]))), true);
      check("before dispatch: note, cost and review flag still editable", (await admin.query("update orders set admin_note = 'n', shipping_cost_inr = 80, needs_review = false where id = $1", [o])).rowCount, 1);
      check("online order: confirmed -> delivered (skipping dispatch) refused", /only after it has been dispatched/.test(await failure(() => admin.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [o]))), true);
      const pl = await order({ status: "placed" });
      check("placed -> confirmed still a plain step", (await admin.query("update orders set status = 'confirmed' where id = $1", [pl])).rowCount, 1);
      const unpaidPlaced = await order({ status: "placed", paid: false });
      check("unpaid online order -> delivered refused", /only after it has been dispatched/.test(await failure(() => admin.query("update orders set status = 'delivered' where id = $1", [unpaidPlaced]))), true);
      const stall = await order({ provider: "offline", status: "confirmed", address: null });
      check("in-person order: confirmed -> delivered allowed (handed over at the stall)", (await admin.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [stall])).rowCount, 1);
      await dispatch(admin, o, sp("50000005"));
      check("after dispatch: number cannot be edited", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set awb_number = 'NEW' where id = $1", [o]))), true);
      check("after dispatch: courier cannot be edited", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set courier_name = 'Other' where id = $1", [o]))), true);
      check("after dispatch: shipped_at cannot be edited", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set shipped_at = now() - interval '1 day' where id = $1", [o]))), true);
      check("after dispatch: notes and the review flag still editable", (await admin.query("update orders set admin_note = 'ok', needs_review = false where id = $1", [o])).rowCount, 1);
      check("shipped -> confirmed (undoing a dispatch) refused", /cannot be moved back/.test(await failure(() => admin.query("update orders set status = 'confirmed' where id = $1", [o]))), true);
      check("shipped -> placed refused", /cannot be moved back/.test(await failure(() => admin.query("update orders set status = 'placed' where id = $1", [o]))), true);
      check("shipped → delivered still a plain step (no email)", (await admin.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [o])).rowCount, 1);
      check("delivered -> confirmed refused", /cannot be moved back/.test(await failure(() => admin.query("update orders set status = 'confirmed' where id = $1", [o]))), true);
      check("delivered -> shipped refused", /only by dispatching them/.test(await failure(() => admin.query("update orders set status = 'shipped' where id = $1", [o]))), true);
      check("delivered: a repeat dispatch with the same number is still just an answer", (await dispatch(admin, o, (await ord(o)).awb_number)).outcome, "already_dispatched");
      check("delivered: number still locked", /recorded only by dispatching/.test(await failure(() => admin.query("update orders set awb_number = 'NEW' where id = $1", [o]))), true);
      check("settlement-style writes on a shipped order unaffected", (await svc.query("update orders set gateway_fee_inr = 1 where id = $1", [o])).rowCount, 1);
      check("customers still cannot update orders at all", await (async () => {
        const custId = (await one("insert into auth.users (email) values ('c2@example.test') returning id")).id;
        const cust = await connect();
        await asUser(cust, custId, "aal1");
        const r = await cust.query("update orders set status = 'shipped' where id = $1", [o]).catch((e) => e);
        return r instanceof Error ? true : r.rowCount === 0;
      })(), true);
    }

    // ══ D. The email ═════════════════════════════════════════════════════════
    console.log("D. Email through R1");
    const attemptDeps = (rs: ReturnType<typeof fakeResend>): Partial<AttemptDeps> => ({
      supabase: client(svc),
      send: (m) => sendEmail(m, { fetch: rs.fetchImpl }),
      renderShipment: (orderId, recipient) => renderShipmentNotification(orderId, recipient, { supabase: client(svc) }),
      render: async () => { throw new Error("the confirmation renderer must not run for a shipment row"); },
      configured: () => true,
      timeoutMs: 1000,
    });
    {
      const o = await order({ status: "confirmed" });
      const num = sp("60000006");
      const r = await dispatch(admin, o, num);
      const rs = fakeResend();
      check("attempt on a shipment row → accepted", await attemptOrderConfirmation(r.delivery_id!, attemptDeps(rs)), "accepted");
      const call = rs.calls[0];
      check("sent once, with the shipment key", [rs.calls.length, call.key], [1, `shipment-notification/${o}/1`]);
      check("to the frozen recipient", (call.body.to as string[])[0], (await one("select customer_email from orders where id = $1", [o])).customer_email);
      check("subject is the shipping one", call.body.subject, `Your THE WOVENNE order ${o.split("-")[0].toUpperCase()} is on its way`);
      const html = String(call.body.html);
      check("body carries the number, the label and the India Post link", [html.includes(num), html.includes("India Post — Speed Post"), html.includes(`href="${INDIA_POST_TRACKING_URL}"`)], [true, true, true]);
      check("no address in the email", /Lake Road|682001/.test(html + String(call.body.text)), false);
      check("a second attempt sends nothing", [await attemptOrderConfirmation(r.delivery_id!, attemptDeps(rs)), rs.calls.length], ["not_due", 1]);
      check("the order confirmation path is untouched (no confirmation row created)", (await one("select count(*)::int n from order_email_deliveries where order_id = $1 and kind = 'order_confirmation'", [o])).n, 0);
    }
    {
      // Cancelled after dispatch, before the email went.
      const o = await order({ status: "confirmed" });
      const r = await dispatch(admin, o, sp("70000007"));
      let via = "cancel_order()";
      await admin.query("select public.cancel_order($1, 'changed mind')", [o]).catch(async (e) => {
        via = `fallback (${(e as Error).message.slice(0, 80)})`;
        // cancel_order needs stock/invoice context this fixture may lack; fall back to the same state.
        await root.query("set session_replication_role = replica");
        await root.query("update orders set status = 'cancelled' where id = $1", [o]);
        await root.query("set session_replication_role = origin");
      });
      const rs = fakeResend();
      const out = await attemptOrderConfirmation(r.delivery_id!, attemptDeps(rs));
      const d = (await rows(o))[0];
      console.log(`     cancelled via ${via}`);
      check("cancelled after dispatch: not sent, recorded failed (order_cancelled)", [out, rs.calls.length, d.status, d.last_error_code], ["failed", 0, "failed", "order_cancelled"]);
    }
    {
      // Account deletion after delivery: the shipment row loses its recipient.
      const email = "leaving-e3@example.test";
      const uid = (await one("insert into auth.users (email) values ($1) returning id", [email])).id;
      await root.query("insert into profiles (id, email) values ($1, $2) on conflict (id) do update set email = excluded.email", [uid, email]);
      const o = await order({ email, status: "confirmed" });
      const r = await dispatch(admin, o, sp("80000008"));
      await admin.query("update orders set status = 'delivered', delivered_at = now() where id = $1", [o]);
      const me = await connect();
      await asUser(me, uid, "aal1");
      const res = (await me.query("select public.delete_my_account() r")).rows[0].r;
      const d = await one("select * from order_email_deliveries where id = $1", [r.delivery_id]);
      check("account deleted: shipment row erased and closed, never sent", [res.ok, d.recipient, d.status, d.last_error_code], [true, null, "failed", "customer_anonymised"]);
      check("…and the dispatch record on the order is kept (books, not person)", [(await ord(o)).awb_number, (await ord(o)).courier_name], [sp("80000008"), INDIA_POST_LABEL]);
    }
    {
      // The R1 worker recovers a shipment row whose first attempt never ran.
      const o = await order({ status: "confirmed" });
      const r = await dispatch(admin, o, sp("90000009"));
      const rs = fakeResend();
      const deps = attemptDeps(rs);
      const report = await runConfirmationRecovery({ supabase: client(svc), configured: () => true, attempt: (id) => attemptOrderConfirmation(id, deps) });
      const d = await one("select status from order_email_deliveries where id = $1", [r.delivery_id]);
      check("recovery worker sends the shipment email once", [report.ok, d.status, rs.calls.filter((c) => c.key === `shipment-notification/${o}/1`).length], [true, "accepted", 1]);
    }
    {
      // An unknown kind is never sent as something else (constraint blocks it; the app refuses too).
      check("the kind check accepts only the two kinds", /violates check constraint/.test(await failure(() => root.query("insert into order_email_deliveries (order_id, kind, idempotency_key, recipient) values ((select id from orders limit 1), 'promo', 'x/1', 'a@b.c')"))), true);
    }

    // ══ F. The server dispatch (E3c), as the route runs it ════════════════════
    console.log("F. Server dispatch (lib/dispatchOrder)");
    {
      /** A PostgREST-shaped rpc over one real connection: the caller's own session. */
      const sessionOf = (c: Client): DispatchDeps["session"] => ({
        rpc: async (fn: string, args: Record<string, unknown>) => {
          if (fn !== "dispatch_order") throw new Error(`unexpected rpc ${fn}`);
          try {
            const r = await c.query("select public.dispatch_order($1, $2, $3, $4) r", [args.p_order_id, args.p_courier, args.p_consignment, args.p_confirm_unusual]);
            return { data: r.rows[0].r, error: null };
          } catch (e) {
            const pe = e as { code?: string; message: string; hint?: string };
            return { data: null, error: { code: pe.code, message: pe.message, hint: pe.hint ?? null } };
          }
        },
      });
      const readEmail: DispatchDeps["readEmail"] = async (id) =>
        (await one("select status, possibly_accepted, attempts, last_error_code from order_email_deliveries where id = $1", [id])) ?? null;
      /** A Resend that answers with `answer` (status code, or "hang" to time out). */
      const resend = (answer: number | "hang" = 200) => {
        const calls: { key: string; body: Record<string, unknown> }[] = [];
        const fetchImpl = (async (_u: string, init: RequestInit) => {
          calls.push({ key: (init.headers as Record<string, string>)["Idempotency-Key"], body: JSON.parse(String(init.body)) });
          if (answer === "hang") {
            return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted"))));
          }
          if (answer === 200) return new Response(JSON.stringify({ id: `re_${calls.length}` }), { status: 200 });
          return new Response(JSON.stringify({ name: answer === 429 ? "rate_limit_exceeded" : answer === 422 ? "validation_error" : "internal_server_error", message: "x" }), { status: answer });
        }) as unknown as typeof fetch;
        return { calls, fetchImpl };
      };
      const depsFor = (c: Client, rs: ReturnType<typeof resend>, extra: Partial<AttemptDeps> = {}): DispatchDeps => ({
        session: sessionOf(c),
        attempt: (id) => attemptOrderConfirmation(id, {
          supabase: client(svc),
          send: (m) => sendEmail(m, { fetch: rs.fetchImpl }),
          renderShipment: (orderId, recipient) => renderShipmentNotification(orderId, recipient, { supabase: client(svc) }),
          // The worker's orphan scan also queues these fixtures' confirmations; they are not this suite's business.
          render: async () => ({ ok: false, retryable: false, reason: "order_missing" }) as Awaited<ReturnType<AttemptDeps["render"]>>,
          configured: () => true,
          timeoutMs: 300,
          ...extra,
        }),
        readEmail,
      });
      const stateOf = async (o: string) => (await rows(o))[0];

      // Success.
      {
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const r = await performDispatch({ orderId: o, consignment: " ee 1234-5678 5in " }, depsFor(admin, rs));
        check("success: 200, dispatched, normalised number stored", [r.status, r.body.ok && r.body.outcome, r.body.ok && r.body.consignment, (await ord(o)).awb_number], [200, "dispatched", "EE123456785IN", "EE123456785IN"]);
        check("…one attempt, accepted, reported as accepted (never 'delivered')", [rs.calls.length, r.body.ok && r.body.attempt, r.body.ok && r.body.email.state, r.body.ok && /deliver(ed)?\b/i.test(r.body.email.label)], [1, "accepted", "accepted", false]);
        check("…the shipment key, the frozen recipient", [rs.calls[0].key, (rs.calls[0].body.to as string[])[0]], [`shipment-notification/${o}/1`, (await one("select customer_email from orders where id = $1", [o])).customer_email]);
        // Double click after success: the same answer, no second email.
        const again = await performDispatch({ orderId: o, consignment: "EE123456785IN" }, depsFor(admin, rs));
        check("double click: already_dispatched, accepted, still one email, one row", [again.body.ok && again.body.outcome, again.body.ok && again.body.email.state, rs.calls.length, (await rows(o)).length], ["already_dispatched", "accepted", 1, 1]);
        const other = await performDispatch({ orderId: o, consignment: sp("11112222") }, depsFor(admin, rs));
        check("a different number afterwards: 409, refused, nothing sent", [other.status, (await ord(o)).awb_number, rs.calls.length], [409, "EE123456785IN", 1]);
      }

      // Concurrent requests (two tabs, double click before the first returns).
      {
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const tabs = await Promise.all(Array.from({ length: 6 }, () => connect()));
        for (const tab of tabs) await asAdmin(tab, adminId);
        const outs = await Promise.all(tabs.map((tab) => performDispatch({ orderId: o, consignment: sp("13572468") }, depsFor(tab, rs))));
        check("6 concurrent requests: all 200, one dispatched", [outs.every((x) => x.status === 200), outs.filter((x) => x.body.ok && x.body.outcome === "dispatched").length], [true, 1]);
        check("…one row, exactly one email sent", [(await rows(o)).length, rs.calls.length, (await stateOf(o)).status], [1, 1, "accepted"]);
      }

      // Who may: the route's session must be a two-factor admin.
      {
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const staff = await connect();
        await asStaffPasswordOnly(staff, adminId);
        const custId = (await one("insert into auth.users (email) values ('f-cust@example.test') returning id")).id;
        const cust = await connect();
        await asUser(cust, custId, "aal2");
        const r1 = await performDispatch({ orderId: o, consignment: sp("24681357") }, depsFor(staff, rs));
        const r2 = await performDispatch({ orderId: o, consignment: sp("24681357") }, depsFor(cust, rs));
        check("password-only staff and customers: 403, nothing changed or sent", [r1.status, r2.status, (await ord(o)).status, (await rows(o)).length, rs.calls.length], [403, 403, "confirmed", 0, 0]);
        const svcSession = await performDispatch({ orderId: o, consignment: sp("24681357") }, depsFor(svc, rs));
        check("the service key as the session is refused too (no signed-in admin)", svcSession.status, 403);
      }

      // Invalid and unusual numbers, and confirmation.
      {
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        for (const [bad, label] of [["", "empty"], ["EE<b>1</b>", "markup"], ["X".repeat(31), "too long"], ["EE12345678 5IN/", "slash"]] as const) {
          const r = await performDispatch({ orderId: o, consignment: bad }, depsFor(admin, rs));
          check(`invalid number (${label}): 400 before the database`, [r.status, (await ord(o)).status], [400, "confirmed"]);
        }
        check("not an order id: 400", (await performDispatch({ orderId: "1; drop table orders", consignment: sp("1") }, depsFor(admin, rs))).status, 400);
        const unconfirmed = await performDispatch({ orderId: o, consignment: "1234567890" }, depsFor(admin, rs));
        check("unusual, unconfirmed: 409 needsConfirmation with the note, nothing changed", [unconfirmed.status, !unconfirmed.body.ok && unconfirmed.body.needsConfirmation, !unconfirmed.body.ok && typeof unconfirmed.body.note, (await ord(o)).status], [409, true, "string", "confirmed"]);
        const wrongConfirm = await performDispatch({ orderId: o, consignment: "1234567890", confirmUnusual: "1234567891" }, depsFor(admin, rs));
        check("confirmation for a DIFFERENT number does not carry over: 409", [wrongConfirm.status, (await ord(o)).status], [409, "confirmed"]);
        const boolConfirm = await performDispatch({ orderId: o, consignment: "1234567890", confirmUnusual: true }, depsFor(admin, rs));
        check("a bare `true` is not a confirmation: 409", boolConfirm.status, 409);
        const ok = await performDispatch({ orderId: o, consignment: "12345 67890", confirmUnusual: "1234567890" }, depsFor(admin, rs));
        check("confirmed for that exact (normalised) number: dispatched and emailed", [ok.status, ok.body.ok && ok.body.outcome, (await ord(o)).awb_number, rs.calls.length], [200, "dispatched", "1234567890", 1]);
        // The database is the last word even if the app's check were wrong:
        const tricked = await performDispatch({ orderId: await order(), consignment: "1234567890" }, {
          ...depsFor(admin, rs),
          session: { rpc: (fn, args) => sessionOf(admin).rpc(fn, { ...args, p_confirm_unusual: false }) },
        });
        check("an app that skipped confirmation is still refused by the database (409 needsConfirmation)", [tricked.status, !tricked.body.ok && tricked.body.needsConfirmation], [409, true]);
        const seen: unknown[] = [];
        const spy = { rpc: (fn: string, args: Record<string, unknown>) => { seen.push(args.p_confirm_unusual); return sessionOf(admin).rpc(fn, args); } };
        await performDispatch({ orderId: await order(), consignment: sp("19283746") }, { ...depsFor(admin, rs), session: spy });
        await performDispatch({ orderId: await order(), consignment: "ABC123", confirmUnusual: "ABC123" }, { ...depsFor(admin, rs), session: spy });
        check("the database is told 'confirmed' only when the admin confirmed (false for a valid Speed Post number)", seen, [false, true]);
      }

      // Payment and state, through the route path.
      {
        const rs = resend(200);
        const unpaid = await order({ paid: false, status: "placed" });
        const cancelledO = await order({ status: "cancelled" });
        const noAddr = await order({ address: null });
        for (const [id, label, re] of [[unpaid, "unpaid", /Only a paid order/], [cancelledO, "cancelled", /cancelled order/], [noAddr, "no address", /no complete delivery address/]] as const) {
          const r = await performDispatch({ orderId: id, consignment: sp("35791357") }, depsFor(admin, rs));
          check(`${label}: 409 with the database's reason, nothing sent`, [r.status, !r.body.ok && re.test(r.body.error), (await rows(id)).length], [409, true, 0]);
        }
        check("missing order: 404", (await performDispatch({ orderId: "00000000-0000-4000-8000-000000000001", consignment: sp("35791357") }, depsFor(admin, rs))).status, 404);
        check("nothing was emailed for any refusal", rs.calls.length, 0);
      }

      // Provider outcomes: the dispatch stands whatever Resend says.
      for (const [answer, attempt, state] of [[500, "uncertain", "retry"], [429, "retryable", "retry"], [422, "failed", "needs_attention"], ["hang", "uncertain", "retry"]] as const) {
        const o = await order({ status: "confirmed" });
        const rs = resend(answer);
        const r = await performDispatch({ orderId: o, consignment: sp("46802468") }, depsFor(admin, rs));
        check(`Resend ${answer}: still dispatched (200), attempt ${attempt}, shown as ${state}`, [r.status, r.body.ok && r.body.outcome, (await ord(o)).status, r.body.ok && r.body.attempt, r.body.ok && r.body.email.state], [200, "dispatched", "shipped", attempt, state]);
      }

      // Retry after a refused attempt: the recovery worker (or a repeat request) sends it once.
      {
        const o = await order({ status: "confirmed" });
        const first = resend(429);
        await performDispatch({ orderId: o, consignment: sp("57913579") }, depsFor(admin, first));
        await root.query("update order_email_deliveries set next_attempt_at = now() where order_id = $1", [o]);
        const later = resend(200);
        const r = await performDispatch({ orderId: o, consignment: sp("57913579") }, depsFor(admin, later));
        check("repeat request after a 429: already_dispatched, the same row is sent, accepted", [r.body.ok && r.body.outcome, later.calls.length, later.calls[0]?.key, (await stateOf(o)).status, (await rows(o)).length], ["already_dispatched", 1, `shipment-notification/${o}/1`, "accepted", 1]);
      }

      // Server interruption after the database dispatch, before any attempt.
      {
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const crashed = await performDispatch({ orderId: o, consignment: sp("68024680") }, {
          ...depsFor(admin, rs),
          attempt: async () => { throw new Error("the function was frozen / killed"); },
        });
        check("interrupted before the email: dispatch stands, reply still 200, email queued", [crashed.status, (await ord(o)).status, crashed.body.ok && crashed.body.email.state, rs.calls.length], [200, "shipped", "queued", 0]);
        const report = await runConfirmationRecovery({ supabase: client(svc), configured: () => true, attempt: (id) => depsFor(admin, rs).attempt(id) });
        check("…the R1 worker sends it, once", [report.ok, rs.calls.filter((c) => c.key === `shipment-notification/${o}/1`).length, (await stateOf(o)).status], [true, 1, "accepted"]);
        await runConfirmationRecovery({ supabase: client(svc), configured: () => true, attempt: (id) => depsFor(admin, rs).attempt(id) });
        check("…and a second worker pass sends nothing more", rs.calls.filter((c) => c.key === `shipment-notification/${o}/1`).length, 1);
      }
      {
        // Process dies mid-attempt (lease held, request maybe made): the lease runs out, the worker retries with the same key.
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const r = await performDispatch({ orderId: o, consignment: sp("79135791") }, { ...depsFor(admin, rs), attempt: async () => "error" as const });
        const id = r.body.ok ? (await stateOf(o)).id : null;
        await svc.query("select * from public.claim_order_email_delivery($1, 90)", [id]);
        await root.query("update order_email_deliveries set lease_expires_at = now() - interval '1 second' where id = $1", [id]);
        await runConfirmationRecovery({ supabase: client(svc), configured: () => true, attempt: (x) => depsFor(admin, rs).attempt(x) });
        check("killed mid-attempt: recovered after the lease, sent once under the same key", [rs.calls.length, rs.calls[0]?.key, (await stateOf(o)).status], [1, `shipment-notification/${o}/1`, "accepted"]);
      }

      // Cancellation racing the email.
      {
        // (a) Cancelled after dispatch, before the first attempt renders.
        const o = await order({ status: "confirmed" });
        const rs = resend(200);
        const r = await performDispatch({ orderId: o, consignment: sp("80246802") }, {
          ...depsFor(admin, rs),
          attempt: async (id) => {
            await admin.query("select public.cancel_order($1, 'race')", [o]).catch(async () => {
              await root.query("set session_replication_role = replica");
              await root.query("update orders set status = 'cancelled' where id = $1", [o]);
              await root.query("set session_replication_role = origin");
            });
            return depsFor(admin, rs).attempt(id);
          },
        });
        check("cancelled before the email rendered: not sent, needs attention (order_cancelled)", [rs.calls.length, r.body.ok && r.body.email.state, (await stateOf(o)).last_error_code], [0, "needs_attention", "order_cancelled"]);
      }
      {
        // (b) First attempt refused (429), payload frozen; order cancelled; the retry must not send.
        const o = await order({ status: "confirmed" });
        await performDispatch({ orderId: o, consignment: sp("91357913") }, depsFor(admin, resend(429)));
        check("…frozen after a refused attempt", !!(await stateOf(o)).payload_sha256, true);
        await admin.query("select public.cancel_order($1, 'race')", [o]).catch(async () => {
          await root.query("set session_replication_role = replica");
          await root.query("update orders set status = 'cancelled' where id = $1", [o]);
          await root.query("set session_replication_role = origin");
        });
        await root.query("update order_email_deliveries set next_attempt_at = now() where order_id = $1", [o]);
        const rs = resend(200);
        const out = await depsFor(admin, rs).attempt((await stateOf(o)).id);
        check("cancelled between a refused attempt and its retry: the frozen email is NOT sent", [out, rs.calls.length, (await stateOf(o)).status, (await stateOf(o)).last_error_code], ["failed", 0, "failed", "order_cancelled"]);
      }

      // Missing customer email, through the route path.
      {
        const o = await order({ email: null, status: "confirmed" });
        const rs = resend(200);
        const r = await performDispatch({ orderId: o, consignment: sp("10293847") }, depsFor(admin, rs));
        check("no email address: dispatched, 'no recipient', nothing sent", [r.status, r.body.ok && r.body.email.state, rs.calls.length, (await ord(o)).status], [200, "no_recipient", 0, "shipped"]);
      }

      // In person, through the route path.
      {
        const o = await order({ provider: "offline", status: "confirmed" });
        const rs = resend(200);
        const r = await performDispatch({ orderId: o, consignment: sp("29384756") }, depsFor(admin, rs));
        check("in-person order: dispatched, no email (state none, in-person wording)", [r.status, r.body.ok && r.body.email.state, r.body.ok && /In-person/.test(String(r.body.email.detail)), rs.calls.length], [200, "none", true, 0]);
      }

      // The admin's status read.
      {
        const o = await order({ status: "confirmed" });
        await performDispatch({ orderId: o, consignment: sp("38475610") }, depsFor(admin, resend(200)));
        const st = (await admin.query("select * from public.shipment_email_status($1::uuid[])", [[o]])).rows;
        check("shipment_email_status: the admin sees the status, accepted", [st.length, st[0]?.status], [1, "accepted"]);
        check("…and only status columns (no recipient, payload or key)", Object.keys(st[0]).sort(), ["accepted_at", "attempts", "last_error_code", "next_attempt_at", "order_id", "possibly_accepted", "status", "updated_at"]);
        const staff = await connect();
        await asStaffPasswordOnly(staff, adminId);
        check("…password-only staff refused", /Not authorised/.test(await failure(() => staff.query("select * from public.shipment_email_status($1::uuid[])", [[o]]))), true);
        const anon2 = await connect();
        await anon2.query("set role anon");
        check("…anon cannot execute it", /permission denied/.test(await failure(() => anon2.query("select * from public.shipment_email_status($1::uuid[])", [[o]]))), true);
        check("…the table itself is still closed to the admin's session", /permission denied/.test(await failure(() => admin.query("select recipient from order_email_deliveries limit 1"))), true);
      }
    }

    // ══ E. Migration order and removal ═══════════════════════════════════════
    console.log("E. Migration order and removal");
    {
      await engine.database("e3_order", "0073");
      const early = await engine.connect("e3_order");
      conns.push(early);
      await asRoot(early);
      const fs = await import("node:fs");
      const sql0075 = fs.readFileSync("supabase/migrations/0075_order_dispatch.sql", "utf8");
      check("0075 before 0074 refuses to apply", /order_email_deliveries \(0074\) does not exist/.test(await failure(() => early.query(sql0075))), true);
      await early.query("rollback").catch(() => {});

      const refused = await failure(() => root.query(REMOVAL_0075));
      await root.query("rollback").catch(() => {});
      check("removal refuses while shipment rows exist", /0075 removal refused/.test(refused), true);
      check("…and removed nothing", !!(await one("select to_regprocedure('public.dispatch_order(uuid, text, text, boolean)') is not null ok")).ok, true);

      await engine.database("e3_empty");
      const empty = await engine.connect("e3_empty");
      conns.push(empty);
      await asRoot(empty);
      await empty.query(REMOVAL_0075);
      const gone = (await empty.query(`select to_regprocedure('public.dispatch_order(uuid, text, text, boolean)') is null
          and to_regprocedure('public.shipment_email_status(uuid[])') is null
          and to_regprocedure('public.is_speed_post_consignment(text)') is null
          and to_regprocedure('public.orders_dispatch_guard()') is null
          and not exists (select 1 from pg_trigger where tgname = 'orders_dispatch_guard')
          and pg_get_constraintdef((select oid from pg_constraint where conname = 'order_email_deliveries_kind_check')) not like '%shipment_notification%' ok`)).rows[0].ok;
      check("removal on an empty database restores 0074 exactly", gone, true);
      check("…and orders can be marked shipped directly again (pre-E3 behaviour)", (await empty.query("insert into orders (total_inr, items, payment_status, status) values (1, '[]', 'paid', 'confirmed') returning id").then((x) => empty.query("update orders set status = 'shipped' where id = $1", [x.rows[0].id]))).rowCount, 1);
    }
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/**
 * Removing 0075: refused while any shipment row exists (those are records).
 * Code must be reverted first; then this restores 0074's kind check and the
 * pre-E3 ability to mark orders shipped directly.
 */
export const REMOVAL_0075 = `
begin;
do $$
begin
  if exists (select 1 from public.order_email_deliveries where kind = 'shipment_notification') then
    raise exception '0075 removal refused: shipment notification records exist. Archive and remove them deliberately first.';
  end if;
end $$;
drop trigger if exists orders_dispatch_guard on public.orders;
drop function if exists public.orders_dispatch_guard();
drop function if exists public.dispatch_order(uuid, text, text, boolean);
drop function if exists public.shipment_email_status(uuid[]);
drop function if exists public.is_speed_post_consignment(text);
alter table public.order_email_deliveries
  drop constraint order_email_deliveries_kind_check,
  add constraint order_email_deliveries_kind_check check (kind = 'order_confirmation');
commit;
`;

const watchdog = setTimeout(() => {
  console.log("  FAIL  the suite did not finish within 180 s");
  process.exit(1);
}, 180_000);
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => clearTimeout(watchdog));
