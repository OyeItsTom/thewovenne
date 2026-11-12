/**
 * LS-1 (0081): loyalty and coupons OFF for launch, in the database.
 *
 *   HISTORY    applying 0081 to a database with real-shaped history — balances,
 *              redeemed points, used coupons, discounted paid orders, a credit
 *              note, a refund owed, a pending checkout quoted WITH a discount —
 *              changes no row outside store_settings.
 *   SWITCHES   discount_switch_on() is strict and fails closed; the switches
 *              cannot be turned on by an admin, service_role or Publish.
 *   REFUSALS   no new earning, redemption, coupon claim or discounted order row,
 *              whoever asks (customer, aal2 admin, service_role); concurrently.
 *   PENDING    a pre-LS-1 discounted checkout still settles at the amount the
 *              customer was shown (and only that amount); no points move and
 *              no coupon use is counted.
 *   OS-1..3    settlement, late-capture refusal and refund obligations behave
 *              as before.
 *   ROLLBACK   the proposed rollback restores the 0029/0037 bodies exactly,
 *              touches no row, keeps both switches off; 0081 re-applies.
 *
 * Real PostgreSQL 17.6 (embedded, throwaway), fictional data, real roles.
 *
 *   PG_HARNESS_DIR=<pgh> LS1_ROLLBACK_SQL=<path to proposed/0081_rollback.sql> \
 *     npx tsx scripts/ls1-discounts-off.test.ts
 */
import fs from "fs";
import path from "path";
import { asAdmin, asRoot, asService, asUser, startEngine, type Client, type Engine } from "./pg-world";
import { cancelPaid, osWorld, paidOrder, placeOrder, rid, settle, type OsWorld, type Placed } from "./os3-world";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e as { code?: string }).code ?? (e as Error).message);
const msg = (p: Promise<unknown>) => p.then(() => "", (e) => (e as Error).message);

const MIG = path.join(process.cwd(), "supabase", "migrations");
const M0081 = fs.readFileSync(path.join(MIG, "0081_ls1_discounts_off_for_launch.sql"), "utf8");
const ROLLBACK = process.env.LS1_ROLLBACK_SQL ? fs.readFileSync(process.env.LS1_ROLLBACK_SQL, "utf8") : null;

/** Every public table except the two 0081 is allowed to write: store_settings' row and its audit entry. */
async function snapshot(c: Client): Promise<Record<string, string>> {
  await asRoot(c);
  const tables = (await c.query(
    `select tablename from pg_tables where schemaname = 'public'
        and tablename not in ('site_content', 'admin_audit_log') order by 1`)).rows.map((r) => r.tablename as string);
  const out: Record<string, string> = {};
  for (const t of tables) {
    out[t] = (await c.query(`select count(*)::text || ':' || md5(coalesce(string_agg(x::text, '|' order by x::text), '')) h from public.${t} x`)).rows[0].h;
  }
  out["site_content (other keys)"] = (await c.query(
    `select md5(coalesce(string_agg(x::text, '|' order by x.key), '')) h from public.site_content x where key <> 'store_settings'`)).rows[0].h;
  return out;
}

async function settingsDoc(c: Client) {
  await asRoot(c);
  return (await c.query("select value, draft_value from site_content where key = 'store_settings'")).rows[0] as
    { value: Record<string, unknown>; draft_value: Record<string, unknown> } | undefined;
}

async function pending(c: Client, w: OsWorld, o: { coupon?: [string, number]; points?: [number, number]; email?: string }): Promise<Placed> {
  // A checkout quoted before LS-1: the stored total is already net of the discount.
  const goods = 2500, ship = 99;
  const total = goods - (o.coupon?.[1] ?? 0) + ship - (o.points?.[1] ?? 0);
  const p = await placeOrder(c, w, total);
  await asRoot(c);
  await c.query(
    `update orders set coupon_code = $2, coupon_discount_inr = $3, loyalty_points_spent = $4, loyalty_discount_inr = $5,
                       customer_email = $6, items = jsonb_set(items, '{0,price_inr}', '2500') where id = $1`,
    [p.id, o.coupon?.[0] ?? null, o.coupon?.[1] ?? 0, o.points?.[0] ?? 0, o.points?.[1] ?? 0, o.email ?? "buyer@example.test"]);
  return p;
}

async function svc<T = unknown>(c: Client, sql: string, args: unknown[] = []): Promise<T> {
  await asService(c);
  try { return (await c.query(sql, args)).rows[0]?.r as T; } finally { await asRoot(c); }
}
const balance = async (c: Client, uid: string) => Number((await c.query("select public.loyalty_balance($1) b", [uid])).rows[0].b);
const timesUsed = async (c: Client, codeTxt: string) => Number((await c.query("select times_used from coupons where code = $1", [codeTxt])).rows[0].times_used);
const redemptions = async (c: Client) => Number((await c.query("select count(*) n from coupon_redemptions")).rows[0].n);

async function fnBodies(c: Client) {
  await asRoot(c);
  return (await c.query(
    `select p.proname, p.prosrc, l.lanname, p.provolatile, p.prosecdef, p.proconfig::text cfg,
            coalesce(array_to_string(p.proacl, ','), '') acl
       from pg_proc p join pg_language l on l.oid = p.prolang
      where p.pronamespace = 'public'::regnamespace and p.proname in ('loyalty_settings', 'redeem_coupon')
      order by 1`)).rows;
}

async function main(engine: Engine) {
  // ══ HISTORY: build the pre-LS-1 world on 0001–0080 ══════════════════════
  console.log("\nLS-1 — history before 0081 (pre-launch behaviour, loyalty and coupons on)");
  await engine.database("ls1", "0080");
  const w = await osWorld(engine, "ls1");
  const c = w.root;
  await asRoot(c);
  await c.query(`update site_content set value = value || '{"loyalty_enabled": true, "vip_min_orders": 4}',
                                         draft_value = draft_value || '{"loyalty_enabled": true, "vip_min_orders": 4}'
                  where key = 'store_settings'`);
  await c.query(`insert into coupons (code, discount_type, discount_value, is_active, max_uses) values
                   ('LAUNCH', 'flat', 250, true, 100), ('OLDTEN', 'percent', 10, false, null)`);
  const loyal = (await c.query("insert into auth.users (email) values ('loyal@example.test') returning id")).rows[0].id as string;
  await c.query("insert into profiles (id, email, is_admin) values ($1, 'loyal@example.test', false) on conflict (id) do nothing", [loyal]);
  await c.query("insert into loyalty_ledger (user_id, points, reason) values ($1, 1000, 'opening balance')", [loyal]);

  // A paid order that used a coupon and points, settled the old way.
  const hist = await pending(c, w, { coupon: ["LAUNCH", 250], points: [300, 75], email: "loyal@example.test" });
  check("history: discounted order settles at its quoted total", (await settle(c, hist, hist.pay, hist.totalPaise)).path, "settled");
  check("history: coupon claimed", await svc(c, "select public.redeem_coupon('LAUNCH', $1, 'loyal@example.test', 250) r", [hist.id]), true);
  check("history: points redeemed", (await svc<{ ok: boolean }>(c, "select public.redeem_loyalty_points($1, 300, $2) r", [loyal, hist.id])).ok, true);
  check("history: points awarded", (await svc<number>(c, "select public.award_loyalty_points($1) r", [hist.id])) > 0, true);
  const histBalance = await balance(c, loyal);
  // A credit note and a refund owed on other paid orders.
  const noted = await paidOrder(c, w);
  await c.query(
    `insert into credit_notes (credit_note_number, order_id, invoice_number, kind, amount_inr, reason, items, issued_by)
     values ('CN-T-' || nextval('credit_note_number_seq'), $1, null, 'return', 500, 'Returned item (fictional)', null, $2)`, [noted.id, w.admin]);
  const owed = await paidOrder(c, w);
  await cancelPaid(c, w, owed.id);
  // Pending checkouts quoted WITH a discount before LS-1 (expected 0 in Production).
  const staleCoupon = await pending(c, w, { coupon: ["LAUNCH", 250] });
  const stalePoints = await pending(c, w, { points: [400, 100], email: "loyal@example.test" });
  const staleWrongAmount = await pending(c, w, { coupon: ["LAUNCH", 250] });
  const staleCount = Number((await c.query(
    "select count(*) n from orders where payment_status = 'pending' and (coupon_discount_inr > 0 or loyalty_points_spent > 0 or coupon_code is not null)")).rows[0].n);
  check("history: three pending checkouts carry a pre-LS-1 discount", staleCount, 3);
  const usedBefore = await timesUsed(c, "LAUNCH");
  const redemptionsBefore = await redemptions(c);

  const bodiesBefore = await fnBodies(c);
  const before = await snapshot(c);
  const settingsBefore = await settingsDoc(c);

  // ══ APPLY 0081 ═══════════════════════════════════════════════════════════
  console.log("\nLS-1 — applying 0081");
  const notices: string[] = [];
  c.on("notice", (n) => notices.push(n.message ?? ""));
  await asRoot(c);
  check("0081 applies on 0080 with history", await msg(c.query(M0081)), "");
  check("0081 prints the switches it found", notices.some((n) => n.includes('"value_loyalty_enabled": true')), true);
  check("0081 refuses to run twice", (await msg(c.query(M0081))).includes("already applied"), true);
  const after = await snapshot(c);
  const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
  check(`HISTORY: no row changed in any of ${Object.keys(before).length} tables (orders, ledgers, coupons, invoices, credit notes, refunds, payments…)`, changed, []);
  check("HISTORY: loyalty balance unchanged", await balance(c, loyal), histBalance);
  check("HISTORY: coupon uses and redemption rows unchanged", [await timesUsed(c, "LAUNCH"), await redemptions(c)], [usedBefore, redemptionsBefore]);
  const s = await settingsDoc(c);
  check("store_settings: both switches now false, in value and draft",
    [s?.value.loyalty_enabled, s?.value.coupons_enabled, s?.draft_value.loyalty_enabled, s?.draft_value.coupons_enabled], [false, false, false, false]);
  const others = (d?: Record<string, unknown>) => Object.fromEntries(Object.entries(d ?? {}).filter(([k]) => !["loyalty_enabled", "coupons_enabled"].includes(k)));
  check("store_settings: every other key kept (vip_min_orders 4 etc.)", [others(s?.value), others(s?.draft_value)], [others(settingsBefore?.value), others(settingsBefore?.draft_value)]);
  check("both LS-1 guards exist (orders, store_settings)",
    (await c.query("select array_agg(tgname::text order by tgname) t from pg_trigger where tgname in ('orders_discount_switch_guard', 'store_settings_discount_lock') and not tgisinternal")).rows[0].t,
    ["orders_discount_switch_guard", "store_settings_discount_lock"]);
  const audit = Number((await c.query("select count(*) n from admin_audit_log where table_name = 'site_content' and changes::text like '%coupons_enabled%'")).rows[0]?.n ?? 0);
  check("the settings change is in the audit log", audit >= 1, true);

  // ══ SWITCHES ═════════════════════════════════════════════════════════════
  console.log("\nLS-1 — switches are strict and fail closed");
  const readWith = async (value: string | null) => {
    await asRoot(c);
    await c.query("begin");
    try {
      // Lets the test store values the lock would refuse, to exercise the READER.
      // Tolerant of a missing lock so a mutation that drops it is caught by the
      // "nobody can switch them on" checks, not by this helper.
      await c.query(`do $$ begin
                       if exists (select 1 from pg_trigger where tgname = 'store_settings_discount_lock') then
                         alter table site_content disable trigger store_settings_discount_lock;
                       end if; end $$`);
      if (value === null) await c.query("delete from site_content where key = 'store_settings'");
      else await c.query("update site_content set value = $1::jsonb where key = 'store_settings'", [value]);
      const r = (await c.query(
        `select public.discount_switch_on('loyalty_enabled') l, public.discount_switch_on('coupons_enabled') c,
                (public.loyalty_settings() ->> 'enabled')::boolean s`)).rows[0];
      return [r.l, r.c, r.s];
    } finally {
      await c.query("rollback");
    }
  };
  check("JSON true reads as on (the only on)", await readWith('{"loyalty_enabled": true, "coupons_enabled": true}'), [true, true, true]);
  check("string \"true\" reads as off", await readWith('{"loyalty_enabled": "true", "coupons_enabled": "true"}'), [false, false, false]);
  check("1 reads as off", await readWith('{"loyalty_enabled": 1, "coupons_enabled": 1}'), [false, false, false]);
  check("null reads as off", await readWith('{"loyalty_enabled": null, "coupons_enabled": null}'), [false, false, false]);
  check("missing keys read as off", await readWith("{}"), [false, false, false]);
  check("a non-object document reads as off", await readWith('"on"'), [false, false, false]);
  check("a missing store_settings row reads as off", await readWith(null), [false, false, false]);
  check("malformed numbers do not make loyalty_settings() raise",
    await readWith('{"loyalty_enabled": false, "loyalty_points_per_inr": "lots", "loyalty_min_redeem": "x"}'), [false, false, false]);
  check("an unknown key is never on", (await c.query("select public.discount_switch_on('ask_wovenne_enabled') r")).rows[0].r, false);

  console.log("\nLS-1 — nobody can switch them on");
  const setAs = async (who: "admin" | "service" | "root", patch: string, col = "value") => {
    if (who === "admin") await asAdmin(c, w.admin); else if (who === "service") await asService(c); else await asRoot(c);
    try {
      return await code(c.query(`update site_content set ${col} = ${col} || $1::jsonb where key = 'store_settings'`, [patch]));
    } finally { await asRoot(c); }
  };
  check("aal2 admin: loyalty on → refused", await setAs("admin", '{"loyalty_enabled": true}'), "55000");
  check("aal2 admin: coupons on → refused", await setAs("admin", '{"coupons_enabled": true}'), "55000");
  check("aal2 admin: \"true\" as text → refused", await setAs("admin", '{"coupons_enabled": "true"}'), "55000");
  check("aal2 admin: switch on in the DRAFT (for Publish) → refused", await setAs("admin", '{"loyalty_enabled": true}', "draft_value"), "55000");
  check("service_role: coupons on → refused", await setAs("service", '{"coupons_enabled": true}'), "55000");
  check("database owner (SQL editor): loyalty on → refused", await setAs("root", '{"loyalty_enabled": true}'), "55000");
  check("aal2 admin: other settings still save (VIP threshold)", await setAs("admin", '{"vip_min_orders": 5, "loyalty_enabled": false, "coupons_enabled": false}'), "ok");
  await asAdmin(c, w.admin);
  check("aal2 admin: a new store_settings row with a switch on → refused",
    await code(c.query("insert into site_content (key, value) values ('store_settings', '{\"loyalty_enabled\": true}') on conflict (key) do nothing")), "55000");
  await asRoot(c);
  check("switches still off", (await c.query("select public.discount_switch_on('loyalty_enabled') l, public.discount_switch_on('coupons_enabled') c")).rows[0], { l: false, c: false });

  // ══ REFUSALS ═════════════════════════════════════════════════════════════
  console.log("\nLS-1 — no new earning, redemption or coupon use");
  const fresh = await placeOrder(c, w);
  await c.query("update orders set customer_email = 'loyal@example.test' where id = $1", [fresh.id]);
  check("a full-price order still settles", (await settle(c, fresh)).path, "settled");
  const b0 = await balance(c, loyal);
  check("redeem points against a paid order → refused", (await svc<{ ok: boolean; reason: string }>(c, "select public.redeem_loyalty_points($1, 300, $2) r", [loyal, fresh.id])), { ok: false, reason: "Loyalty points are not enabled." });
  check("redeem points with no order → refused", (await svc<{ ok: boolean }>(c, "select public.redeem_loyalty_points($1, 300, null) r", [loyal])).ok, false);
  check("award on a paid order → 0", await svc<number>(c, "select public.award_loyalty_points($1) r", [fresh.id]), 0);
  check("balance unchanged", await balance(c, loyal), b0);
  check("a NEW coupon claim (active code) → false", await svc(c, "select public.redeem_coupon('LAUNCH', $1, 'loyal@example.test', 250) r", [fresh.id]), false);
  check("…no use counted, no redemption row", [await timesUsed(c, "LAUNCH"), await redemptions(c)], [usedBefore, redemptionsBefore]);
  check("a replay for the order that already used it → true, nothing moves",
    [await svc(c, "select public.redeem_coupon('LAUNCH', $1, 'loyal@example.test', 250) r", [hist.id]), await timesUsed(c, "LAUNCH"), await redemptions(c)], [true, usedBefore, redemptionsBefore]);

  console.log("\nLS-1 — direct database bypass attempts");
  const asCustomer = async (sql: string, args: unknown[]) => {
    await asUser(c, loyal, "aal1");
    try { return await code(c.query(sql, args)); } finally { await asRoot(c); }
  };
  const asAdm = async (sql: string, args: unknown[]) => {
    await asAdmin(c, w.admin);
    try { return await code(c.query(sql, args)); } finally { await asRoot(c); }
  };
  for (const [name, sql, args] of [
    ["redeem_coupon", "select public.redeem_coupon('LAUNCH', $1, 'x@example.test', 250)", [fresh.id]],
    ["redeem_loyalty_points", "select public.redeem_loyalty_points($1, 300, null)", [loyal]],
    ["award_loyalty_points", "select public.award_loyalty_points($1)", [fresh.id]],
    ["discount_switch_on", "select public.discount_switch_on('coupons_enabled')", []],
  ] as [string, string, unknown[]][]) {
    check(`customer cannot call ${name}`, await asCustomer(sql, args), "42501");
    check(`aal2 admin cannot call ${name}`, await asAdm(sql, args), "42501");
  }
  check("customer cannot write the points ledger", await asCustomer("insert into loyalty_ledger (user_id, points, reason) values ($1, 5000, 'mint')", [loyal]), "42501");
  check("aal2 admin cannot write the points ledger", await asAdm("insert into loyalty_ledger (user_id, points, reason) values ($1, 5000, 'mint')", [loyal]), "42501");
  await asUser(c, loyal, "aal1");
  check("customer sees no coupon rows (RLS)", Number((await c.query("select count(*) n from coupons")).rows[0].n), 0);
  await asRoot(c);

  console.log("\nLS-1 — no order row takes on a new discount");
  const insertOrder = async (extra: string, vals: string) => {
    await asService(c);
    try {
      return await msg(c.query(
        `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name, customer_phone,
                             shipping_address, payment_provider, razorpay_order_id${extra})
         values ('[]'::jsonb, 2349, 99, 'pending', 'placed', 'x@example.test', 'X', '+91 90000 00009', '{}'::jsonb, 'razorpay', $1${vals})`,
        [rid("order")]));
    } finally { await asRoot(c); }
  };
  const couponRefusal = await insertOrder(", coupon_code, coupon_discount_inr", ", 'LAUNCH', 250");
  check("service_role insert with a coupon → refused", couponRefusal.startsWith("LS-1: discount codes are switched off"), true);
  check("service_role insert with a coupon code only → refused", (await insertOrder(", coupon_code", ", 'LAUNCH'")).startsWith("LS-1:"), true);
  check("service_role insert with a discount amount only → refused", (await insertOrder(", coupon_discount_inr", ", 1")).startsWith("LS-1:"), true);
  check("service_role insert with points → refused", (await insertOrder(", loyalty_points_spent, loyalty_discount_inr", ", 300, 75")).startsWith("LS-1: loyalty points are switched off"), true);
  check("service_role insert with zero discounts → accepted", await insertOrder(", coupon_code, coupon_discount_inr, loyalty_points_spent, loyalty_discount_inr", ", null, 0, 0, 0"), "");
  // The pre-LS-1 checkout's fallbacks retry the insert WITHOUT the coupon columns
  // when the error mentions them (or is PGRST204). This message must not.
  check("the refusal cannot trigger the old checkout's missing-column fallbacks",
    [/delivery_updates/.test(couponRefusal), /cogs_inr/.test(couponRefusal), /coupon_(code|discount_inr)/.test(couponRefusal)], [false, false, false]);
  const upd = async (sql: string, args: unknown[]) => { await asService(c); try { return await code(c.query(sql, args)); } finally { await asRoot(c); } };
  const open = await placeOrder(c, w);
  check("adding a coupon to a pending order → refused", await upd("update orders set coupon_code = 'LAUNCH', coupon_discount_inr = 250, total_inr = 2349 where id = $1", [open.id]), "55000");
  check("adding points to a pending order → refused", await upd("update orders set loyalty_points_spent = 300 where id = $1", [open.id]), "55000");
  check("a pre-LS-1 discounted pending order can still be edited otherwise", await upd("update orders set customer_name = 'Renamed' where id = $1", [staleCoupon.id]), "ok");
  check("…and rewriting its existing discount to the same value is allowed", await upd("update orders set coupon_code = coupon_code, coupon_discount_inr = coupon_discount_inr where id = $1", [staleCoupon.id]), "ok");
  check("…but raising it is refused", await upd("update orders set coupon_discount_inr = 500 where id = $1", [staleCoupon.id]), "55000");

  console.log("\nLS-1 — concurrent attempts");
  const racers: Placed[] = [];
  for (let i = 0; i < 4; i++) racers.push(await placeOrder(c, w));
  for (const r of racers) await settle(c, r);
  const clients = [w.a, w.b, await engine.connect("ls1"), await engine.connect("ls1")];
  await Promise.all(clients.map((cl) => asService(cl)));
  const raced = await Promise.all(racers.map((r, i) =>
    clients[i].query("select public.redeem_coupon('LAUNCH', $1, 'r@example.test', 250) r", [r.id]).then((x) => x.rows[0].r)));
  check("4 concurrent coupon claims → all false", raced, [false, false, false, false]);
  const racedPts = await Promise.all([w.a, w.b].map((cl, i) =>
    cl.query("select public.redeem_loyalty_points($1, 300, $2) r", [loyal, racers[i].id]).then((x) => x.rows[0].r.ok)));
  check("2 concurrent point redemptions → both refused", racedPts, [false, false]);
  await Promise.all(clients.map((cl) => asRoot(cl)));
  await clients[2].end();
  await clients[3].end();
  check("…no use counted, no balance moved", [await timesUsed(c, "LAUNCH"), await redemptions(c), await balance(c, loyal)], [usedBefore, redemptionsBefore, b0]);

  // ══ PENDING CHECKOUTS QUOTED BEFORE LS-1 ════════════════════════════════
  console.log("\nLS-1 — pending checkouts quoted with a discount before 0081");
  check("paid at the full (unquoted) price → mismatch, nothing settled", (await settle(c, staleWrongAmount, staleWrongAmount.pay, 259900)).path, "mismatch");
  check("…the order is still pending", (await c.query("select payment_status from orders where id = $1", [staleWrongAmount.id])).rows[0].payment_status, "pending");
  check("coupon checkout paid at its quoted amount → settled (the customer was shown it)", (await settle(c, staleCoupon)).path, "settled");
  check("…its coupon use is NOT counted", [await svc(c, "select public.redeem_coupon('LAUNCH', $1, 'buyer@example.test', 250) r", [staleCoupon.id]), await timesUsed(c, "LAUNCH"), await redemptions(c)], [false, usedBefore, redemptionsBefore]);
  check("…and its recorded discount is preserved as history", (await c.query("select coupon_code, coupon_discount_inr::int d, total_inr::int t from orders where id = $1", [staleCoupon.id])).rows[0], { coupon_code: "LAUNCH", d: 250, t: 2349 });
  check("points checkout paid at its quoted amount → settled", (await settle(c, stalePoints)).path, "settled");
  check("…no points spent, none awarded", [(await svc<{ ok: boolean }>(c, "select public.redeem_loyalty_points($1, 400, $2) r", [loyal, stalePoints.id])).ok,
    await svc<number>(c, "select public.award_loyalty_points($1) r", [stalePoints.id]), await balance(c, loyal)], [false, 0, b0]);

  // ══ OS-1..OS-3 still hold ════════════════════════════════════════════════
  console.log("\nLS-1 — OS-1..OS-3 protections unchanged");
  const late = await placeOrder(c, w);
  await asAdmin(c, w.admin);
  await c.query("select public.cancel_unpaid_order($1, 'No payment arrived')", [late.id]);
  await asRoot(c);
  check("OS-1: a late capture on a cancelled order is a refund owed, not a revival", (await settle(c, late)).path, "refund_owed");
  check("OS-3: …and it is in the refund ledger", Number((await c.query("select count(*) n from refund_obligations where order_id = $1", [late.id])).rows[0].n), 1);
  check("OS-2: a paid order's discount columns stay immutable", await upd("update orders set coupon_discount_inr = 0 where id = $1", [hist.id]), "55000");
  check("OS-3: the history refund owed is still outstanding", Number((await c.query("select count(*) n from refund_obligations where order_id = $1", [owed.id])).rows[0].n), 1);

  // ══ ROLLBACK ═════════════════════════════════════════════════════════════
  if (!ROLLBACK) {
    console.log("\n  FAIL  LS1_ROLLBACK_SQL not set — rollback not rehearsed");
    failed++;
    return;
  }
  console.log("\nLS-1 — proposed rollback, then re-apply");
  const beforeRb = await snapshot(c);
  const settingsBeforeRb = await settingsDoc(c);
  await asRoot(c);
  check("rollback applies", await msg(c.query(ROLLBACK)), "");
  check("rollback restores the 0029/0037 bodies, language, grants exactly", await fnBodies(c), bodiesBefore);
  check("rollback drops both guards and the helper",
    (await c.query(`select (select count(*) from pg_trigger where tgname in ('orders_discount_switch_guard','store_settings_discount_lock'))::int t,
                           to_regprocedure('public.discount_switch_on(text)') is null h`)).rows[0], { t: 0, h: true });
  const afterRb = await snapshot(c);
  check("rollback changes no row (all tables)", Object.keys(beforeRb).filter((k) => beforeRb[k] !== afterRb[k]), []);
  check("rollback leaves both switches false", await settingsDoc(c), settingsBeforeRb);
  check("rollback refuses to run twice", (await msg(c.query(ROLLBACK))).includes("0081 is not applied"), true);
  await c.query("rollback").catch(() => {});
  check("0081 re-applies after rollback", await msg(c.query(M0081)), "");
  check("…switches still off, guards back",
    (await c.query(`select public.discount_switch_on('coupons_enabled') c,
                           (select count(*) from pg_trigger where tgname in ('orders_discount_switch_guard','store_settings_discount_lock'))::int t`)).rows[0], { c: false, t: 2 });

  // ══ Fresh replay ═════════════════════════════════════════════════════════
  console.log("\nLS-1 — fresh replay 0001–0081");
  await engine.database("ls1fresh");
  const f = await engine.connect("ls1fresh");
  const post = (await f.query(
    `select public.discount_switch_on('loyalty_enabled') l, public.discount_switch_on('coupons_enabled') cp,
            (select value -> 'coupons_enabled' from site_content where key = 'store_settings') v`)).rows[0];
  check("fresh database: both switches off, coupons_enabled explicitly false", post, { l: false, cp: false, v: false });
  await f.end();
  for (const cl of [w.a, w.b, c]) await cl.end();
}

(async () => {
  const engine = await startEngine();
  if (!engine) { console.error("FAIL: no PG harness (PG_HARNESS_DIR)"); process.exit(2); }
  console.log(engine.version);
  if (!engine.version.startsWith("PostgreSQL 17.6")) { console.error("FAIL: not PG 17.6"); await engine.stop(); process.exit(2); }
  try {
    await main(engine);
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
