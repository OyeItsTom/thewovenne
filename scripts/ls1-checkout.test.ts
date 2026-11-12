/**
 * LS-1: the checkout and settlement application paths with loyalty and coupons
 * OFF — against a FAKE Razorpay and, for the order row, a real PostgreSQL 17.6
 * database with 0001–0081 applied.
 *
 *   SWITCHES   getDiscountSwitches is strict and fails closed (unreadable,
 *              malformed, throwing → off).
 *   CHECKOUT   a couponCode / redeemPoints in the request is disregarded: no
 *              coupon lookup, no balance read; Razorpay is asked for the full
 *              server-priced amount, and the stored total is that same paise
 *              integer; the response says the code was not applied.
 *   BYPASS     with the application check forced open (old code, or a bug),
 *              the database refuses the discounted row; the checkout fails
 *              closed and does NOT retry without the coupon columns.
 *   ROUNDING   fractional prices, free-shipping threshold, ₹1 floor.
 *   CONCURRENT 12 checkouts at once, and the same basket twice.
 *   SETTLEMENT the created order settles only at the amount Razorpay was asked
 *              for; a pre-LS-1 discounted order that is paid is flagged for
 *              review, its points not spent and its coupon not counted.
 *
 * No network, no credentials, no .env.local.
 *
 *   PG_HARNESS_DIR=<pgh> npx tsx scripts/ls1-checkout.test.ts
 */
import { asRoot, asService, startEngine, type Client } from "./pg-world";
import { createCheckout, type CheckoutDeps } from "../lib/checkoutCreate";
import { getDiscountSwitches, DEFAULT_SETTINGS, type StoreSettings } from "../lib/storeSettings";
import { couponsUnavailable } from "../lib/coupons";
import { DEFAULT_SHIPPING } from "../lib/shipping";
import { settleOrder } from "../lib/settleOrder";
import { makeWorld } from "./settlement-world";
import { toPaise } from "../lib/utils";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const DETAILS = {
  email: "buyer@example.test", name: "A Buyer", phone: "+91 90000 00001", delivery_updates: "email",
  address: { line1: "1 Loom Street", line2: "", city: "Kochi", state: "Kerala", postal_code: "682001", country: "India" },
};

type Row = Record<string, unknown>;
interface Harness {
  deps: Partial<CheckoutDeps>;
  gatewayCalls: { amount: number; currency: string; receipt: string }[];
  inserts: Row[];
  couponLookups: string[];
  balanceReads: number;
}

/** A fake Razorpay, spies on the discount functions, and an order store (memory or real PG). */
function harness(opts: {
  goods?: number;
  switches?: CheckoutDeps["switches"];
  insert?: (row: Row) => Promise<{ error: { code?: string; message: string } | null }>;
  couponWorth?: number;
}): Harness {
  const h: Harness = { deps: {}, gatewayCalls: [], inserts: [], couponLookups: [], balanceReads: 0 };
  let n = 0;
  const goods = opts.goods ?? 2500;
  h.deps = {
    priceCart: (async () => ({
      items: [{ id: "prod-A", name: "Piece", size: "One Size", quantity: 1, price_inr: goods, cost_price_inr: 900, sku: "PIECE" }],
      total: goods, error: null, reason: null,
    })) as unknown as CheckoutDeps["priceCart"],
    getShippingConfig: async () => DEFAULT_SHIPPING,
    applyCoupon: (async (code: string) => {
      h.couponLookups.push(code);
      return { ok: true, discount: opts.couponWorth ?? 250, reason: null, message: null, code: code.toUpperCase() };
    }) as CheckoutDeps["applyCoupon"],
    planRedemption: (async () => {
      h.balanceReads++;
      return { points: 400, discount: 100, error: null };
    }) as CheckoutDeps["planRedemption"],
    switches: opts.switches ?? (async () => ({ loyalty: false, coupons: false })),
    gateway: {
      orders: {
        create: async (o) => {
          h.gatewayCalls.push(o);
          n += 1;
          return { id: `order_LS1FAKE${String(n).padStart(6, "0")}${Math.random().toString(36).slice(2, 6).toUpperCase()}`, amount: o.amount, currency: o.currency };
        },
      },
    },
    supabase: (() => ({
      from: () => ({
        insert: async (row: Row) => {
          h.inserts.push(row);
          return opts.insert ? opts.insert(row) : { error: null };
        },
      }),
    })) as unknown as CheckoutDeps["supabase"],
    keyId: () => "rzp_test_fake",
  };
  return h;
}

const create = (h: Harness, extra: Row = {}) =>
  createCheckout({ action: "create", items: [{ id: "prod-A", size: "One Size", quantity: 1, price_inr: 1 } as never], details: DETAILS, ...extra }, h.deps);

/** The order insert, done for real: as service_role, through every 0001–0081 trigger. */
function pgInsert(c: Client) {
  return async (row: Row) => {
    const keys = Object.keys(row);
    try {
      await asService(c);
      // Only the columns the checkout sent, so every other column keeps its default.
      await c.query(
        `insert into orders (${keys.join(", ")}) select ${keys.join(", ")} from jsonb_populate_record(null::orders, $1::jsonb)`,
        [JSON.stringify(row)]);
      return { error: null };
    } catch (e) {
      // PostgREST hands the PG error code and message straight through.
      return { error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    } finally {
      await asRoot(c);
    }
  };
}

async function switches() {
  console.log("\nLS-1 — getDiscountSwitches fails closed");
  const read = (v: unknown) => getDiscountSwitches(async () => v as StoreSettings);
  check("defaults → off", await read(DEFAULT_SETTINGS), { loyalty: false, coupons: false });
  check("DEFAULT_SETTINGS has coupons_enabled false", DEFAULT_SETTINGS.coupons_enabled, false);
  check("JSON true → on (the only on)", await read({ loyalty_enabled: true, coupons_enabled: true }), { loyalty: true, coupons: true });
  check("\"true\" text → off", await read({ loyalty_enabled: "true", coupons_enabled: "true" }), { loyalty: false, coupons: false });
  check("1 → off", await read({ loyalty_enabled: 1, coupons_enabled: 1 }), { loyalty: false, coupons: false });
  check("missing keys → off", await read({}), { loyalty: false, coupons: false });
  check("null settings → off", await read(null), { loyalty: false, coupons: false });
  check("a reader that throws → off", await getDiscountSwitches(async () => { throw new Error("db down"); }), { loyalty: false, coupons: false });
  check("couponsUnavailable takes nothing off and names no code", couponsUnavailable(),
    { ok: false, discount: 0, reason: "disabled", message: "Discount codes aren't available at the moment.", code: null });
}

async function checkout(c: Client) {
  const full = toPaise(2500 + 99); // ₹2,500 goods, ₹99 standard delivery below ₹3,000

  console.log("\nLS-1 — checkout disregards coupon codes and points while off");
  {
    const h = harness({ insert: pgInsert(c) });
    const r = await create(h, { couponCode: "LAUNCH", redeemPoints: 500 });
    check("200", r.status, 200);
    check("no coupon lookup, no balance read", [h.couponLookups.length, h.balanceReads], [0, 0]);
    check("Razorpay asked for the full amount (₹2,599 = 259900 paise)", h.gatewayCalls.map((g) => g.amount), [full]);
    check("response amount = Razorpay amount", r.body.amount, full);
    check("response: code not applied, says why", r.body.coupon, { ok: false, code: null, discount: 0, message: "Discount codes aren't available at the moment." });
    check("response: nothing redeemed", r.body.redeemed, { points: 0, discount: 0 });
    const row = (await c.query("select total_inr::text t, coupon_code, coupon_discount_inr::int cd, loyalty_points_spent lp, loyalty_discount_inr::int ld, payment_status from orders where razorpay_order_id = $1", [r.body.orderId])).rows[0];
    check("stored row: full total, no discount, pending", row, { t: "2599.00", coupon_code: null, cd: 0, lp: 0, ld: 0, payment_status: "pending" });
  }
  {
    const h = harness({ insert: pgInsert(c), switches: async () => { throw new Error("settings unreadable"); } });
    const r = await create(h, { couponCode: "LAUNCH", redeemPoints: 500 });
    check("switch reader throws → full price, no lookups", [r.status, h.gatewayCalls[0]?.amount, h.couponLookups.length, h.balanceReads], [200, full, 0, 0]);
  }
  {
    const h = harness({ insert: pgInsert(c), switches: async () => ({ loyalty: "true", coupons: 1 }) as never });
    const r = await create(h, { couponCode: "LAUNCH", redeemPoints: 500 });
    check("malformed switch values → full price, no lookups", [r.status, h.gatewayCalls[0]?.amount, h.couponLookups.length, h.balanceReads], [200, full, 0, 0]);
  }
  {
    const h = harness({ insert: pgInsert(c) });
    const r = await create(h);
    check("no code sent → coupon null (contract unchanged)", [r.status, r.body.coupon, h.gatewayCalls[0]?.amount], [200, null, full]);
  }

  console.log("\nLS-1 — application check forced open: the database still refuses");
  for (const [label, sw] of [["coupon", { loyalty: false, coupons: true }], ["points", { loyalty: true, coupons: false }]] as const) {
    const h = harness({ insert: pgInsert(c), switches: async () => sw });
    const r = await create(h, { couponCode: "LAUNCH", redeemPoints: 500 });
    const rzp = h.gatewayCalls.length;
    const rows = Number((await c.query("select count(*) n from orders where coupon_discount_inr > 0 and payment_status = 'pending' and razorpay_order_id like 'order_LS1FAKE%'")).rows[0].n);
    const pts = Number((await c.query("select count(*) n from orders where loyalty_points_spent > 0 and razorpay_order_id like 'order_LS1FAKE%'")).rows[0].n);
    check(`${label}: checkout fails closed (500, "Could not start checkout")`, [r.status, r.body.error], [500, "Could not start checkout. Please try again."]);
    check(`${label}: ONE insert attempt — no retry without the coupon columns`, h.inserts.length, 1);
    check(`${label}: no discounted row recorded`, [rows, pts], [0, 0]);
    check(`${label}: the Razorpay order was created but never returned to a browser (unpayable)`, [rzp, r.body.orderId ?? null], [1, null]);
  }

  console.log("\nLS-1 — totals and rounding");
  for (const [goods, ship] of [[1299.5, 99], [2999.99, 99], [3000, 0], [12450.75, 0]] as const) {
    const h = harness({ goods, insert: pgInsert(c) });
    const r = await create(h, { couponCode: "LAUNCH" });
    const expected = toPaise(goods + ship);
    const t = (await c.query("select (total_inr * 100)::bigint p, shipping_cost_inr::int s from orders where razorpay_order_id = $1", [r.body.orderId])).rows[0];
    check(`₹${goods} goods → Razorpay ${expected} paise, stored total in paise identical, delivery ₹${ship}`, [h.gatewayCalls[0].amount, Number(t.p), t.s], [expected, expected, ship]);
  }

  console.log("\nLS-1 — concurrent and duplicate checkouts");
  {
    // Each needs its own connection to be truly concurrent at the database.
    const conns: Client[] = [];
    for (let i = 0; i < 12; i++) conns.push(await connectAgain());
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => {
      const hh = harness({ insert: pgInsert(conns[i]) });
      return create(hh, { couponCode: `LAUNCH`, redeemPoints: 1000 }).then((r) => ({ r, amounts: hh.gatewayCalls.map((g) => g.amount), lookups: hh.couponLookups.length + hh.balanceReads }));
    }));
    check("12 concurrent: all 200", results.map((x) => x.r.status), Array(12).fill(200));
    check("12 concurrent: every Razorpay amount is the full price", results.flatMap((x) => x.amounts), Array(12).fill(full));
    check("12 concurrent: no discount lookups at all", results.reduce((a, x) => a + x.lookups, 0), 0);
    const ids = results.map((x) => x.r.body.orderId as string);
    check("12 concurrent: 12 distinct Razorpay orders, 12 rows, none discounted",
      [new Set(ids).size, Number((await c.query("select count(*) n from orders where razorpay_order_id = any($1) and coupon_discount_inr = 0 and loyalty_points_spent = 0 and total_inr = 2599", [ids])).rows[0].n)], [12, 12]);
    for (const k of conns) await k.end();
  }
  {
    const h = harness({ insert: pgInsert(c) });
    const a = await create(h, { couponCode: "LAUNCH" });
    const b = await create(h, { couponCode: "LAUNCH" });
    check("the same basket twice → two pending orders, both full price (existing behaviour; only a paid one becomes an order, a second payment is OS-1's refund owed)",
      [a.body.orderId !== b.body.orderId, h.gatewayCalls.map((g) => g.amount)], [true, [full, full]]);
  }

  console.log("\nLS-1 — the created order settles only at what Razorpay was asked for");
  {
    const h = harness({ insert: pgInsert(c) });
    const r = await create(h, { couponCode: "LAUNCH", redeemPoints: 500 });
    const rzp = r.body.orderId as string;
    const settle = async (amount: number, pay: string) => {
      await asService(c);
      try { return (await c.query("select public.settle_razorpay_payment($1, $2, $3, 'INR', 5900, 900, 'captured') r", [rzp, pay, amount])).rows[0].r.path; }
      finally { await asRoot(c); }
    };
    check("a capture of the discounted amount (₹2,349) → mismatch", await settle(toPaise(2349), "pay_LS1DISC0000001"), "mismatch");
    check("a capture of the full amount → settled", await settle(h.gatewayCalls[0].amount, "pay_LS1FULL0000001"), "settled");
  }
}

let connectAgain: () => Promise<Client>;

async function settlement() {
  console.log("\nLS-1 — settleOrder with a pre-LS-1 discounted order (fake database, fake Razorpay)");
  const order = { loyalty_points_spent: 400, coupon_code: "LAUNCH", coupon_discount_inr: 250, total_inr: 2950 };
  {
    const { world, deps } = makeWorld({ profile: true, order, discountsOff: true });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("settles at the amount the customer was shown", [r.outcome, r.ok], ["settled", true]);
    check("no points spent, none awarded, coupon use not counted", [world.redemptions.size, world.awards.size, world.couponUses.length], [0, 0, 0]);
    check("flagged for review (not silent)", world.orders.get("ord-1")!.needs_review, true);
    check("the recorded discount is left as it was", [world.orders.get("ord-1")!.coupon_code, world.orders.get("ord-1")!.coupon_discount_inr], ["LAUNCH", 250]);
  }
  {
    const { world, deps } = makeWorld({ profile: true, order: { ...order, loyalty_points_spent: 0 }, discountsOff: true });
    await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("a coupon alone that cannot be claimed is flagged too", world.orders.get("ord-1")!.needs_review, true);
  }
  {
    const { world, deps } = makeWorld({ profile: true, order: {}, discountsOff: true });
    const r = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("a full-price order settles cleanly and is NOT flagged", [r.outcome, world.orders.get("ord-1")!.needs_review, world.awards.size], ["settled", false, 0]);
  }
  {
    const { world, deps } = makeWorld({ profile: true, order: { coupon_code: "LAUNCH", coupon_discount_inr: 250, total_inr: 2950 }, discountsOff: true, payment: { amount: 295000 } });
    world.couponUses.push("ord-1"); // already counted before LS-1
    await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("a replay for an order whose coupon was already counted is not flagged", world.orders.get("ord-1")!.needs_review, false);
  }
}

(async () => {
  await switches();
  const engine = await startEngine();
  if (!engine) { console.error("FAIL: no PG harness (PG_HARNESS_DIR)"); process.exit(2); }
  console.log(engine.version);
  if (!engine.version.startsWith("PostgreSQL 17.6")) { console.error("FAIL: not PG 17.6"); await engine.stop(); process.exit(2); }
  try {
    await engine.database("ls1app");
    connectAgain = () => engine.connect("ls1app");
    const c = await engine.connect("ls1app");
    await asRoot(c);
    check("database is on 0081", (await c.query("select to_regprocedure('public.discount_switch_on(text)') is not null r")).rows[0].r, true);
    await checkout(c);
    await c.end();
    await settlement();
  } catch (e) {
    console.error(e);
    failed++;
  } finally {
    await engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
