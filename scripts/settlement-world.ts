/**
 * A fake database for settlement tests.
 *
 * Just enough of the PostgREST client for settleOrder and settleLoyalty:
 * from().select/insert/update with eq/is/ilike filters, maybeSingle, and the
 * RPCs. Each RPC enforces the same rule the real function or index does — the
 * 0058 guards are MODELLED here, so a test proves the application reads them
 * correctly, not that Postgres enforces them (scripts/migration-0058 does
 * that). Shared by razorpay-verify and razorpay-webhook.
 */
import type { SettlementDeps, StoredLine } from "../lib/settleOrder";

export type Row = Record<string, unknown>;

export interface OrderRow extends Row {
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
  /** orders.status (0024). Absent in older fixtures = 'placed'. */
  status?: string;
  /** The payment that settled the row (0077). */
  razorpay_payment_id?: string | null;
}

/** A payment_refund_obligations row (0077), as the fake keeps it. */
export interface ObligationRow {
  order_id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  amount_paise: number;
  reason: "captured_after_cancellation" | "second_payment";
  order_status_at_capture: string;
  order_payment_status_at_capture: string;
  state: "owed";
  times_seen: number;
}

export interface World {
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
  /** razorpay_webhook_events: event_id → event_type. The 0058 primary key. */
  webhookEvents: Map<string, string | null>;
  /** Every payment id the code asked the gateway about. */
  paymentFetches: string[];
  /** payment_refund_obligations, keyed by razorpay_payment_id (0077's unique key). */
  obligations: Map<string, ObligationRow>;
  /** settle_razorpay_payment calls, in order. */
  settleCalls: Row[];
}

/**
 * What Razorpay's API says about a payment. THE ONLY CAPTURE AUTHORITY the
 * code under test has: settleOrder fetches this and settles on nothing else.
 * Defaults to a captured INR payment for order_1 matching the stored total.
 */
export interface FakePayment {
  id?: string;
  order_id?: string | null;
  status?: string;
  amount?: number;
  currency?: string;
  fee?: number | null;
  tax?: number | null;
}

export function makeWorld(opts: {
  order?: Partial<OrderRow> | null;
  stock?: Record<string, number>;
  gatewayDown?: boolean;
  profile?: boolean;
  /** Overrides for what the gateway reports about the payment. */
  payment?: FakePayment;
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
    webhookEvents: new Map(),
    paymentFetches: [],
    obligations: new Map(),
    settleCalls: [],
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
      name === "orders"
        ? [...world.orders.values()]
        : name === "profiles"
          ? world.profiles
          : name === "razorpay_webhook_events"
            ? [...world.webhookEvents].map(([event_id, event_type]) => ({ event_id, event_type }))
            : [];
    const build = (op: "select" | "insert" | "update", payload?: Row) => {
      const filters: Filter[] = [];
      let returning = op === "select";
      const run = () => {
        if (op === "select") return { data: rows().filter((r) => matches(r, filters)), error: null };
        if (op === "insert") {
          const row = payload as Row;
          world.inserts.push(row);
          if (name === "razorpay_webhook_events") {
            const id = String(row.event_id);
            if (world.webhookEvents.has(id)) {
              return { data: [], error: { code: "23505", message: "razorpay_webhook_events_pkey" } };
            }
            world.webhookEvents.set(id, (row.event_type as string | null) ?? null);
            return { data: [row], error: null };
          }
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

  // Invoice numbers issued inside settle_razorpay_payment — kept apart from
  // invoiceCalls, which counts the application's own assign_invoice_number calls.
  let issuedInside = 0;

  const rpc = async (fn: string, args: Row): Promise<{ data: unknown; error: { code: string; message: string } | null }> => {
    switch (fn) {
      // 0077, MODELLED: the order row lock is implied (this fake is single
      // threaded); the decision and its effects are the real function's.
      // scripts/os1-settlement.test.ts proves the real one in PostgreSQL.
      case "settle_razorpay_payment": {
        world.settleCalls.push(args);
        if (args.p_provider_status !== "captured" || args.p_currency !== "INR" || !(Number(args.p_amount_paise) > 0)) {
          return { data: null, error: { code: "22023", message: "settle_razorpay_payment: refused evidence" } };
        }
        const o = [...world.orders.values()].find((r) => r.razorpay_order_id === args.p_razorpay_order_id);
        if (!o) return { data: { path: "no_order" }, error: null };
        if (o.total_inr !== null && Math.round(Number(o.total_inr) * 100) !== Number(args.p_amount_paise)) {
          return { data: { path: "mismatch", order_id: o.id }, error: null };
        }
        const payId = String(args.p_razorpay_payment_id);
        const status = o.status ?? "placed";
        let reason = world.obligations.get(payId)?.reason ?? null;
        if (!reason) {
          if (status === "cancelled") {
            if (o.payment_status === "paid" && (!o.razorpay_payment_id || o.razorpay_payment_id === payId)) {
              return { data: { path: "already_settled_cancelled", order_id: o.id }, error: null };
            }
            reason = o.payment_status === "paid" ? "second_payment" : "captured_after_cancellation";
          } else if (o.payment_status === "paid" && o.razorpay_payment_id && o.razorpay_payment_id !== payId) {
            reason = "second_payment";
          }
        }
        if (reason) {
          const existing = world.obligations.get(payId);
          if (existing) existing.times_seen += 1;
          else
            world.obligations.set(payId, {
              order_id: o.id,
              razorpay_order_id: String(args.p_razorpay_order_id),
              razorpay_payment_id: payId,
              amount_paise: Number(args.p_amount_paise),
              reason,
              order_status_at_capture: status,
              order_payment_status_at_capture: o.payment_status,
              state: "owed",
              times_seen: 1,
            });
          o.needs_review = true;
          return { data: { path: "refund_owed", reason, order_id: o.id, first: !existing }, error: null };
        }
        const lines = Array.isArray(o.items) ? o.items : [];
        let stock = "none";
        let stockError: string | null = null;
        if (lines.length > 0) {
          const r = await rpc("reserve_stock", {
            p_items: lines.map((i) => ({ id: i.id, size: i.size, quantity: i.quantity })),
            p_order_id: o.id,
          });
          if (r.error) {
            stock = "failed";
            stockError = r.error.message;
          } else {
            const d = r.data as { reserved: number };
            stock = d.reserved > 0 ? "reserved" : "already_reserved";
          }
        }
        const flagged = stock === "failed" || stock === "none";
        const patch: Row = {
          payment_status: "paid",
          total_inr: Number(args.p_amount_paise) / 100,
          gateway_fee_inr: args.p_fee_paise === null || args.p_fee_paise === undefined ? null : Number(args.p_fee_paise) / 100,
          gateway_tax_inr: args.p_tax_paise === null || args.p_tax_paise === undefined ? null : Number(args.p_tax_paise) / 100,
        };
        if (flagged) patch.needs_review = true;
        world.updates.push({ patch, filters: `id eq ${o.id}` });
        Object.assign(o, patch);
        if (!o.razorpay_payment_id) o.razorpay_payment_id = payId;
        if (lines.length > 0 && !o.invoice_number) o.invoice_number = `WOV-2026-000${++issuedInside}`;
        return { data: { path: "settled", order_id: o.id, stock, stock_error: stockError, flagged }, error: null };
      }
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
    payments: {
      fetch: async (id: string) => {
        world.paymentFetches.push(id);
        if (world.gatewayDown) throw new Error("gateway unreachable");
        return {
          id,
          entity: "payment",
          order_id: "order_1",
          status: "captured",
          captured: true,
          amount: 295000,
          currency: "INR",
          fee: 5900,
          tax: 900,
          ...(opts.payment ?? {}),
        };
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
