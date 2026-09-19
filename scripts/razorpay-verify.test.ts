/**
 * Payment verification and settlement, exercised headlessly.
 *
 * Two things are under test. lib/razorpayVerify decides whether the browser's
 * payment response is genuine. lib/settleOrder is everything that happens
 * afterwards — and it must give the same answer however many times it is
 * asked, because a replayed callback, a webhook, and a webhook retry all
 * arrive with the same two identifiers.
 *
 * THE FAKE DATABASE MODELS THE GUARDS 0058 INSTALLED: one sale movement per
 * (order, product, size), one loyalty redemption per order, one award per
 * order, a confirmation email claimed by a conditional UPDATE. The code under
 * test is real; the guards are simulated. That means these tests prove the
 * APPLICATION reads the guards correctly — a replay is recognised, a claim
 * that fails is respected, a refusal is flagged — and that nothing here
 * depends on browser input. Whether the guards themselves hold under two
 * concurrent connections rests on Postgres (scripts/migration-0058 for the
 * SQL, the unique indexes for the concurrency), not on this file. Run:
 *
 *   npx tsx scripts/razorpay-verify.test.ts
 *
 * No network, no database, no Razorpay. Exits non-zero on failure.
 */
import crypto from "crypto";
import { NextRequest } from "next/server";
import { verifyPaymentSignature } from "../lib/razorpayVerify";
import { settleOrder, type SettlementDeps, type StoredLine } from "../lib/settleOrder";
import { POST } from "../app/api/checkout/razorpay/route";

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

// ── A fake database that remembers what was asked of it ──
//
// Just enough of the PostgREST client for settleOrder and settleLoyalty:
// from().select/insert/update with eq/is/ilike filters, maybeSingle, and the
// five RPCs. Each RPC enforces the same rule the real function or index does.

type Row = Record<string, unknown>;

interface OrderRow extends Row {
  id: string;
  razorpay_order_id: string | null;
  items: StoredLine[] | null;
  payment_status: string;
  needs_review: boolean;
  confirmation_sent_at: string | null;
  invoice_number: string | null;
  customer_email: string | null;
  coupon_code: string | null;
  coupon_discount_inr: number | null;
  loyalty_points_spent: number | null;
  total_inr: number | null;
}

interface World {
  orders: Map<string, OrderRow>;
  profiles: { id: string; email: string; is_admin: boolean }[];
  /** (id|size) → units on the shelf. */
  stock: Map<string, number>;
  /** Claimed sale movements: order|id|size. The 0058 index. */
  claims: Set<string>;
  reserveCalls: { p_items: Row[]; p_order_id: string }[];
  redemptions: Set<string>;
  awards: Set<string>;
  couponUses: string[];
  invoiceCalls: number;
  emails: string[];
  updates: { patch: Row; filters: string }[];
  inserts: Row[];
  gatewayDown: boolean;
}

function makeWorld(opts: {
  order?: Partial<OrderRow> | null;
  stock?: Record<string, number>;
  gatewayDown?: boolean;
  profile?: boolean;
}): { world: World; deps: Partial<SettlementDeps> } {
  const world: World = {
    orders: new Map(),
    profiles: opts.profile ? [{ id: "user-1", email: "a@b.c", is_admin: false }] : [],
    stock: new Map(Object.entries(opts.stock ?? { "prod-A|M": 5 })),
    claims: new Set(),
    reserveCalls: [],
    redemptions: new Set(),
    awards: new Set(),
    couponUses: [],
    invoiceCalls: 0,
    emails: [],
    updates: [],
    inserts: [],
    gatewayDown: Boolean(opts.gatewayDown),
  };
  if (opts.order !== null) {
    world.orders.set("ord-1", {
      id: "ord-1",
      razorpay_order_id: "order_1",
      items: [{ id: "prod-A", size: "M", quantity: 1, price_inr: 2950 }],
      payment_status: "pending",
      needs_review: false,
      confirmation_sent_at: null,
      invoice_number: null,
      customer_email: "a@b.c",
      coupon_code: null,
      coupon_discount_inr: null,
      loyalty_points_spent: null,
      total_inr: 2950,
      ...(opts.order ?? {}),
    });
  }

  type Filter = { col: string; op: "eq" | "is" | "ilike"; val: unknown };
  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const v = row[f.col];
      if (f.op === "is") return v === f.val;
      if (f.op === "ilike") return String(v).toLowerCase() === String(f.val).toLowerCase();
      return v === f.val;
    });

  const table = (name: string) => {
    const rows = (): Row[] =>
      name === "orders" ? [...world.orders.values()] : name === "profiles" ? world.profiles : [];
    const build = (op: "select" | "insert" | "update", payload?: Row) => {
      const filters: Filter[] = [];
      let returning = op === "select";
      const run = () => {
        if (op === "select") return { data: rows().filter((r) => matches(r, filters)), error: null };
        if (op === "insert") {
          const row = payload as Row;
          world.inserts.push(row);
          if (name !== "orders") return { data: [row], error: null };
          const dup = [...world.orders.values()].some(
            (o) => o.razorpay_order_id === row.razorpay_order_id
          );
          if (dup) return { data: [], error: { code: "23505", message: "orders_razorpay_order_id_key" } };
          const full = { id: `thin-${world.orders.size + 1}`, confirmation_sent_at: null, ...row } as OrderRow;
          world.orders.set(full.id, full);
          return { data: returning ? [{ id: full.id }] : [], error: null };
        }
        const hit = rows().filter((r) => matches(r, filters));
        world.updates.push({ patch: payload as Row, filters: filters.map((f) => `${f.col} ${f.op} ${f.val}`).join(", ") });
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit.map((r) => ({ id: r.id })) : [], error: null };
      };
      const q: Record<string, unknown> = {
        eq: (col: string, val: unknown) => (filters.push({ col, op: "eq", val }), q),
        is: (col: string, val: unknown) => (filters.push({ col, op: "is", val }), q),
        ilike: (col: string, val: unknown) => (filters.push({ col, op: "ilike", val }), q),
        select: () => ((returning = true), q),
        maybeSingle: async () => {
          const r = run();
          return { data: (r.data as Row[])[0] ?? null, error: r.error };
        },
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(res, rej),
      };
      return q;
    };
    return {
      select: () => build("select"),
      insert: (row: Row) => build("insert", row),
      update: (patch: Row) => build("update", patch),
    };
  };

  const rpc = async (fn: string, args: Row) => {
    switch (fn) {
      case "reserve_stock": {
        const orderId = args.p_order_id as string;
        const items = args.p_items as { id: string; size: string; quantity: number }[];
        world.reserveCalls.push({ p_items: items, p_order_id: orderId });
        // One transaction: a short line rolls back the whole call, claims included.
        const made: string[] = [];
        const taken = new Map<string, number>();
        let reserved = 0;
        let already = 0;
        for (const i of items) {
          const key = `${orderId}|${i.id}|${i.size}`;
          if (world.claims.has(key)) {
            already += i.quantity;
            continue;
          }
          const shelf = `${i.id}|${i.size}`;
          const have = (world.stock.get(shelf) ?? 0) - (taken.get(shelf) ?? 0);
          if (have < i.quantity) {
            for (const k of made) world.claims.delete(k);
            return { data: null, error: { code: "P0001", message: `SOLD_OUT:${i.id}:${i.size}` } };
          }
          world.claims.add(key);
          made.push(key);
          taken.set(shelf, (taken.get(shelf) ?? 0) + i.quantity);
          reserved += i.quantity;
        }
        for (const [shelf, n] of taken) world.stock.set(shelf, (world.stock.get(shelf) ?? 0) - n);
        return { data: { reserved, already_reserved: already }, error: null };
      }
      case "redeem_loyalty_points": {
        const orderId = args.p_order_id as string;
        if (world.redemptions.has(orderId)) {
          return { data: null, error: { code: "23505", message: "loyalty_ledger_one_redemption_per_order" } };
        }
        world.redemptions.add(orderId);
        return { data: { ok: true, points: args.p_points }, error: null };
      }
      case "award_loyalty_points": {
        const orderId = args.p_order_id as string;
        const order = world.orders.get(orderId);
        // Awards go to accounts, for paid orders, once (0029's unique index).
        if (!order || order.payment_status !== "paid" || !world.profiles.length || world.awards.has(orderId)) {
          return { data: 0, error: null };
        }
        world.awards.add(orderId);
        return { data: 10, error: null };
      }
      case "redeem_coupon": {
        const orderId = args.p_order_id as string;
        if (!world.couponUses.includes(orderId)) world.couponUses.push(orderId);
        return { data: true, error: null };
      }
      case "assign_invoice_number": {
        world.invoiceCalls++;
        const order = world.orders.get(args.p_order_id as string);
        if (order && !order.invoice_number) order.invoice_number = `WOV-2026-000${world.invoiceCalls}`;
        return { data: order?.invoice_number ?? null, error: null };
      }
      default:
        throw new Error(`unexpected rpc ${fn}`);
    }
  };

  const supabase = { from: table, rpc } as unknown as SettlementDeps["supabase"];

  const gateway = {
    orders: {
      fetch: async () => {
        if (world.gatewayDown) throw new Error("gateway unreachable");
        return { amount: 295000 };
      },
    },
    payments: {
      fetch: async () => {
        if (world.gatewayDown) throw new Error("gateway unreachable");
        return { fee: 5900, tax: 900 };
      },
    },
  } as unknown as SettlementDeps["gateway"];

  const deps: Partial<SettlementDeps> = {
    supabase,
    gateway,
    // settlePoints is deliberately NOT injected: the real settleLoyalty runs
    // against this fake, so its reading of the redemption guard is under test.
    sendConfirmation: (async (id: string) => {
      world.emails.push(id);
    }) as unknown as SettlementDeps["sendConfirmation"],
  };

  return { world, deps };
}

const settle = (deps: Partial<SettlementDeps>, order = "order_1", payment = "pay_1") =>
  settleOrder({ razorpayOrderId: order, razorpayPaymentId: payment }, deps);
const paidPatches = (world: World) => world.updates.filter((u) => "payment_status" in u.patch);

async function main() {
  console.log("\n=== the payment-response signature ===");
  {
    const secret = "test-key-secret";
    const sign = (o: string, p: string) =>
      crypto.createHmac("sha256", secret).update(`${o}|${p}`).digest("hex");

    check("a genuine signature verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), secret), true);
    check("a signature for another order is rejected", verifyPaymentSignature("order_2", "pay_1", sign("order_1", "pay_1"), secret), false);
    check("a signature for another payment is rejected", verifyPaymentSignature("order_1", "pay_2", sign("order_1", "pay_1"), secret), false);
    check("a signature under another secret is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), "other"), false);
    check("an empty signature is rejected", verifyPaymentSignature("order_1", "pay_1", "", secret), false);
    check("a missing signature is rejected", verifyPaymentSignature("order_1", "pay_1", undefined, secret), false);
    check("a truncated signature is rejected", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1").slice(0, 63), secret), false);
    check("no secret configured means nothing verifies", verifyPaymentSignature("order_1", "pay_1", sign("order_1", "pay_1"), undefined), false);
  }

  console.log("\n=== 1. first settlement ===");
  {
    const { world, deps } = makeWorld({ profile: true });
    const r = await settle(deps);
    check("ok, against the stored row", [r.ok, r.orderId, r.orphan], [true, "ord-1", false]);
    check("stock reserved now", r.stock, "reserved");
    check("reserve_stock called once, with the STORED line", world.reserveCalls[0].p_items, [{ id: "prod-A", size: "M", quantity: 1 }]);
    check("movement attached to the stored order id", world.reserveCalls[0].p_order_id, "ord-1");
    check("shelf 5 → 4", world.stock.get("prod-A|M"), 4);
    check("marked paid, total from the gateway, fees in rupees", [world.orders.get("ord-1")!.payment_status, world.orders.get("ord-1")!.total_inr, paidPatches(world)[0].patch.gateway_fee_inr], ["paid", 2950, 59]);
    check("4. email claimed and one send attempted", [r.emailClaimed, world.emails], [true, ["order_1"]]);
    check("   confirmation_sent_at is set on the row", typeof world.orders.get("ord-1")!.confirmation_sent_at, "string");
    check("12. loyalty awarded", [...world.awards], ["ord-1"]);
    check("15. invoice number assigned", world.orders.get("ord-1")!.invoice_number, "WOV-2026-0001");
    check("not flagged", [r.flaggedForReview, world.orders.get("ord-1")!.needs_review], [false, false]);
  }

  console.log("\n=== 2, 3, 5, 6. the same settlement replayed ===");
  {
    const { world, deps } = makeWorld({ profile: true, order: { loyalty_points_spent: 50, coupon_code: "LAUNCH", coupon_discount_inr: 100 } });
    const first = await settle(deps);
    const second = await settle(deps);
    check("second call still reports ok", second.ok, true);
    check("3. second call is already_reserved — a replay, not a failure", second.stock, "already_reserved");
    check("2. reserve_stock was CALLED twice — the guard is in the database, not a caller-side skip", world.reserveCalls.length, 2);
    check("   but the shelf moved once: 5 → 4", world.stock.get("prod-A|M"), 4);
    check("   one claim exists", [...world.claims], ["ord-1|prod-A|M"]);
    check("5. second attempt does not win the email", second.emailClaimed, false);
    check("6. one send attempt in total — duplicate prevented", world.emails, ["order_1"]);
    check("   confirmation_sent_at was set once, not overwritten", world.updates.filter((u) => "confirmation_sent_at" in u.patch).length, 2, "two conditional UPDATEs were issued; only the first matched");
    check("12. one award", world.awards.size, 1);
    check("13. one redemption — the second hit the index and was read as done", world.redemptions.size, 1);
    check("    and did NOT flag the order", world.orders.get("ord-1")!.needs_review, false);
    check("14. one coupon use", world.couponUses, ["ord-1"]);
    check("15. invoice number unchanged across both", [first.ok, world.invoiceCalls, world.orders.get("ord-1")!.invoice_number], [true, 2, "WOV-2026-0001"]);
    check("    the row is still paid", world.orders.get("ord-1")!.payment_status, "paid");
  }

  console.log("\n=== 7. a webhook-shaped second settlement ===");
  {
    // Same identifiers, different caller — the shape a webhook will use.
    const { world, deps } = makeWorld({ profile: true });
    await settle(deps);
    const viaWebhook = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, deps);
    check("settles without error", viaWebhook.ok, true);
    check("recognised as a replay", viaWebhook.stock, "already_reserved");
    check("no second email", [viaWebhook.emailClaimed, world.emails.length], [false, 1]);
    check("no second decrement", world.stock.get("prod-A|M"), 4);
    // And the reverse order: the webhook lands first, the browser second.
    const w2 = makeWorld({ profile: true });
    const a = await settleOrder({ razorpayOrderId: "order_1", razorpayPaymentId: "pay_1" }, w2.deps);
    const b = await settle(w2.deps);
    check("webhook first, browser second: one email, one decrement", [a.emailClaimed, b.emailClaimed, w2.world.emails.length, w2.world.stock.get("prod-A|M")], [true, false, 1, 4]);
    const w3 = makeWorld({ profile: true });
    await settle(w3.deps); await settle(w3.deps); await settle(w3.deps);
    check("three deliveries, as Razorpay's retries would: still one of everything", [w3.world.emails.length, w3.world.stock.get("prod-A|M"), w3.world.awards.size], [1, 4, 1]);
  }

  console.log("\n=== 8, 9. stock shortage and the review flag ===");
  {
    const { world, deps } = makeWorld({ profile: true, stock: { "prod-A|M": 0 } });
    const r = await settle(deps);
    check("8. stock failed", r.stock, "failed");
    check("   still marked paid — the customer has paid", world.orders.get("ord-1")!.payment_status, "paid");
    check("   needs_review = true", [r.flaggedForReview, world.orders.get("ord-1")!.needs_review], [true, true]);
    check("   no claim was left behind", world.claims.size, 0);
    check("   the obsolete tracking_status is never written", world.updates.some((u) => "tracking_status" in u.patch), false);
    check("   still emailed — the order exists and is paid", world.emails.length, 1);

    // 9. A human has not looked yet; a later settlement that goes smoothly
    // must not lift the flag. Restock, replay.
    world.stock.set("prod-A|M", 5);
    const again = await settle(deps);
    check("9. after a restock the replay reserves (nothing was claimed before)", again.stock, "reserved");
    check("   and does NOT clear needs_review", world.orders.get("ord-1")!.needs_review, true);
    check("   no paid-patch ever carries needs_review: false", paidPatches(world).some((u) => u.patch.needs_review === false), false);
    check("   a clean patch omits the key entirely", "needs_review" in paidPatches(world)[1].patch, false);
  }
  {
    const { world, deps } = makeWorld({ order: { needs_review: true } });
    await settle(deps);
    check("   a pre-existing flag survives a clean first settlement", world.orders.get("ord-1")!.needs_review, true);
  }

  console.log("\n=== 10, 11. the stored basket is the only basket ===");
  {
    const stored: StoredLine[] = [
      { id: "prod-A", size: "M", quantity: 2, price_inr: 1000 },
      { id: "prod-B", size: "One Size", quantity: 1, price_inr: 500 },
    ];
    const { world, deps } = makeWorld({ order: { items: stored }, stock: { "prod-A|M": 5, "prod-B|One Size": 5 } });
    await settle(deps);
    check("10. stock reserved from the stored lines, verbatim", world.reserveCalls[0].p_items, [
      { id: "prod-A", size: "M", quantity: 2 },
      { id: "prod-B", size: "One Size", quantity: 1 },
    ]);
    check("    the stored items were not rewritten", world.orders.get("ord-1")!.items, stored);
    check("    no update patch ever carries items", world.updates.some((u) => "items" in u.patch), false);
    check("11. the API takes two identifiers and nothing else", Object.keys({ razorpayOrderId: "", razorpayPaymentId: "" }).length, 2, "SettlementInput has no items field; a basket cannot be passed");
  }

  console.log("\n=== 16. a paid order with no pending row ===");
  {
    const { world, deps } = makeWorld({ order: null });
    const r = await settle(deps, "order_x", "pay_x");
    check("reported as an orphan", [r.ok, r.orphan, r.stock], [true, true, "none"]);
    check("a thin row was inserted, paid, with the captured amount", [world.inserts[0].payment_status, world.inserts[0].total_inr], ["paid", 2950]);
    check("the thin row carries NO items — there is no trusted source for them", "items" in world.inserts[0], false);
    check("flagged for review", [r.flaggedForReview, world.inserts[0].needs_review], [true, true]);
    check("no stock reserved, no invoice, no email — nothing to base them on", [world.reserveCalls.length, world.invoiceCalls, world.emails.length], [0, 0, 0]);
    const again = await settle(deps, "order_x", "pay_x");
    check("a replay finds the thin row and does not insert a second", [again.orderId, world.orders.size], ["thin-1", 1]);
    check("and still issues no invoice and sends no email for a row with no contents", [world.invoiceCalls, world.emails.length, again.stock], [0, 0, "none"]);
    check("the flag stays up", world.orders.get("thin-1")!.needs_review, true);
  }

  console.log("\n=== 17. the gateway being unreachable ===");
  {
    const { world, deps } = makeWorld({ gatewayDown: true, order: { items: [{ id: "prod-A", size: "M", quantity: 2, price_inr: 1200 }] } });
    const r = await settle(deps);
    check("still settles", [r.ok, r.stock], [true, "reserved"]);
    check("total falls back to the STORED prices, never a request", world.orders.get("ord-1")!.total_inr, 2400);
    check("fee and tax are recorded as unknown", [paidPatches(world)[0].patch.gateway_fee_inr, paidPatches(world)[0].patch.gateway_tax_inr], [null, null]);
    check("still emailed", world.emails.length, 1);
  }

  console.log("\n=== 18. the shape of the email claim ===");
  {
    const { world, deps } = makeWorld({});
    await settle(deps);
    const claim = world.updates.find((u) => "confirmation_sent_at" in u.patch)!;
    check("the claim is a conditional UPDATE on id AND confirmation_sent_at IS null", claim.filters, "id eq ord-1, confirmation_sent_at is null");
    check("it carries nothing but the timestamp", Object.keys(claim.patch), ["confirmation_sent_at"]);
    // A row already claimed by someone else — a webhook that got there first.
    const w2 = makeWorld({ order: { confirmation_sent_at: "2026-09-19T00:00:00Z" } });
    const r = await settle(w2.deps);
    check("a row already claimed yields no email from this caller", [r.emailClaimed, w2.world.emails.length], [false, 0]);
  }

  console.log("\n=== a failed send is contained, and not retried ===");
  {
    const { world, deps } = makeWorld({});
    const sends: string[] = [];
    deps.sendConfirmation = ((id: string) => {
      sends.push(id);
      throw new Error("provider down");
    }) as unknown as SettlementDeps["sendConfirmation"];
    const r = await settle(deps);
    check("a sender that throws synchronously does not fail settlement", [r.ok, r.emailClaimed], [true, true]);
    check("the claim is consumed", typeof world.orders.get("ord-1")!.confirmation_sent_at, "string");
    const again = await settle(deps);
    check("a replay does NOT retry the send — at most one attempt", [again.emailClaimed, sends.length], [false, 1], "recovery is the admin re-send, by design");
  }

  console.log("\n=== the route refuses a bad signature before touching anything ===");
  {
    process.env.RAZORPAY_KEY_SECRET = "route-test-secret";
    const request = new NextRequest("http://localhost/api/checkout/razorpay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "verify",
        razorpay_order_id: "order_x",
        razorpay_payment_id: "pay_x",
        razorpay_signature: "not-a-signature",
        // A basket smuggled in anyway. The contract has no such field, and
        // the route must neither read it nor be moved by it.
        items: [{ id: "prod-B", size: "XL", quantity: 3, price_inr: 1 }],
      }),
    });
    const res = await POST(request);
    const body = await res.json();
    check("responds 200 with verified:false", [res.status, body], [200, { verified: false }]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
