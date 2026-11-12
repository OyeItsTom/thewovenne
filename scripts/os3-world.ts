/**
 * OS-3 (WP-ORDER-SAFETY-10) test world: fictional orders in a throwaway
 * PostgreSQL 17.6 (scripts/pg-world), a FAKE Razorpay, and a bridge that lets
 * the real application modules (lib/refundLedger, lib/paymentReconciliation,
 * lib/razorpayWebhook) call the real 0080 functions as service_role.
 *
 * Nothing here reads .env.local, a credential, or the network.
 */
import { asAdmin, asRoot, asService, makeAdmin, type Client, type Engine } from "./pg-world";
import { liveProduct } from "./stock-world";
import type { ProviderPayment, ProviderRefund, RefundProvider, Rpc } from "../lib/refundLedger";
import type { PaymentLister } from "../lib/paymentReconciliation";

let seq = 0;
/** Razorpay-shaped ids: prefix + 14 alphanumerics. */
export function rid(prefix: "order" | "pay" | "rfnd") {
  seq += 1;
  const tail = (process.pid.toString(36) + "X" + seq.toString(36)).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${prefix}_${(tail + "ABCDEFGHIJKLMN").slice(0, 14)}`;
}

/** Supabase-style rpc over a pg connection, as service_role. */
export function pgRpc(c: Client): Rpc {
  return async (fn, args) => {
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
    const vals = keys.map((k) => {
      const v = args[k];
      return v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    try {
      await asService(c);
      const r = await c.query(sql, vals);
      return { data: r.rows[0].r, error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
    } finally {
      await asRoot(c);
    }
  };
}

export interface OsWorld {
  root: Client;
  a: Client;
  b: Client;
  admin: string;
  customer: string;
  productId: string;
}

export async function osWorld(engine: Engine, db: string): Promise<OsWorld> {
  const root = await engine.connect(db);
  const a = await engine.connect(db);
  const b = await engine.connect(db);
  const admin = await makeAdmin(root, "owner@example.test");
  await asRoot(root);
  const customer = (await root.query("insert into auth.users (email) values ('buyer@example.test') returning id")).rows[0].id as string;
  await root.query("insert into profiles (id, email) values ($1, 'buyer@example.test') on conflict (id) do nothing", [customer]);
  const p = await liveProduct(root, admin, { stock: 200 });
  await asRoot(root);
  return { root, a, b, admin, customer, productId: p.productId };
}

export interface Placed {
  id: string;
  rzp: string;
  pay: string;
  totalPaise: number;
}

/** A pending Razorpay order (not yet paid). */
export async function placeOrder(c: Client, w: OsWorld, total = 2599, provider = "razorpay"): Promise<Placed> {
  await asRoot(c);
  const rzp = rid("order");
  const items = [{ id: w.productId, size: "One Size", quantity: 1, price_inr: total - 99, name: "Piece" }];
  const id = (await c.query(
    `insert into orders (items, total_inr, shipping_cost_inr, payment_status, status, customer_email, customer_name,
                         customer_phone, shipping_address, payment_provider, razorpay_order_id)
     values ($1::jsonb, $2, 99, 'pending', 'placed', 'buyer@example.test', 'A Buyer', '+91 90000 00001',
             '{"line1":"1 Loom Street","city":"Kochi","state":"Kerala","postal_code":"682001","country":"India"}'::jsonb, $3, $4)
     returning id`,
    [JSON.stringify(items), total, provider, provider === "razorpay" ? rzp : null])).rows[0].id as string;
  return { id, rzp, pay: rid("pay"), totalPaise: total * 100 };
}

export async function settle(c: Client, o: Placed, pay = o.pay, amount = o.totalPaise) {
  await asService(c);
  const r = (await c.query("select public.settle_razorpay_payment($1, $2, $3, 'INR', 5900, 900, 'captured') r", [o.rzp, pay, amount])).rows[0].r;
  await asRoot(c);
  return r as { path: string };
}

export async function paidOrder(c: Client, w: OsWorld, total = 2599): Promise<Placed> {
  const o = await placeOrder(c, w, total);
  const r = await settle(c, o);
  if (r.path !== "settled") throw new Error(`fixture did not settle: ${JSON.stringify(r)}`);
  return o;
}

export async function cancelPaid(c: Client, w: OsWorld, id: string, reason = "Customer asked to cancel") {
  await asAdmin(c, w.admin);
  const r = (await c.query("select public.cancel_order($1, $2) r", [id, reason])).rows[0].r;
  await asRoot(c);
  return r;
}

export async function cancelUnpaid(c: Client, w: OsWorld, id: string) {
  await asAdmin(c, w.admin);
  await c.query("select public.cancel_unpaid_order($1, 'No payment arrived')", [id]);
  await asRoot(c);
}

export interface Evidence {
  refund: string;
  payment: string;
  rzpOrder: string | null;
  amount: number;
  status?: string;
  payAmount: number;
  captured?: boolean;
  refunded?: number;
  currency?: string;
  mode?: "test" | "live";
  source?: string;
  actor?: string | null;
}

/** record_refund_evidence as the server calls it (service_role). */
export async function evidence(c: Client, e: Evidence) {
  await asService(c);
  try {
    const r = await c.query(
      `select public.record_refund_evidence(
         p_refund_id => $1, p_payment_id => $2, p_payment_order_id => $3, p_amount_paise => $4,
         p_currency => $5, p_status => $6, p_created_at => now(), p_speed_processed => 'normal',
         p_payment_amount_paise => $7, p_payment_currency => $5, p_payment_captured => $8,
         p_payment_amount_refunded_paise => $9, p_provider_mode => $10, p_source => $11, p_actor => $12) r`,
      [e.refund, e.payment, e.rzpOrder, e.amount, e.currency ?? "INR", e.status ?? "processed", e.payAmount,
       e.captured ?? true, e.refunded ?? e.amount, e.mode ?? "test", e.source ?? "webhook", e.actor ?? null]);
    return r.rows[0].r as { outcome: string; status: string; reason: string | null; discrepancies: number[]; payment_refund_id: string };
  } finally {
    await asRoot(c);
  }
}

/**
 * The database owner enrols a refund-closure approver (WP-12). In production
 * this is a deliberate insert in the Supabase SQL editor; no API role can do it.
 */
export async function enrolApprover(c: Client, userId: string) {
  await asRoot(c);
  await c.query(
    "insert into refund_closure_approvers (user_id, authorised_by, note) values ($1, 'Owner (test)', 'Owner approval for the test world, fictional.') on conflict do nothing",
    [userId]);
}

export async function ledgerFor(c: Client, key: string) {
  await asRoot(c);
  return (await c.query("select * from refund_ledger where ledger_key = $1 or razorpay_payment_id = $1", [key])).rows[0] ?? null;
}

export async function obligationsOf(c: Client, orderId: string) {
  await asRoot(c);
  return (await c.query("select * from refund_obligations where order_id = $1 order by created_at, id", [orderId])).rows;
}

export async function openDiscrepancies(c: Client, kind?: string) {
  await asRoot(c);
  return (await c.query(
    "select * from payment_reconciliation_discrepancies where status = 'open' and ($1::text is null or kind = $1) order by id",
    [kind ?? null])).rows;
}

// ── Fake Razorpay ────────────────────────────────────────────────────────────

export interface FakeRazorpay {
  refunds: Map<string, ProviderRefund>;
  payments: Map<string, ProviderPayment & { created_at?: number }>;
  calls: string[];
  /** Make the next call(s) fail: "timeout" | "500" | "404". */
  failNext: ("timeout" | "500" | "404")[];
  provider: RefundProvider;
  lister: PaymentLister;
  /** Every property touched on the provider objects (read-only proof). */
  touched: Set<string>;
  listFailAtSkip: number | null;
}

export function fakeRazorpay(): FakeRazorpay {
  const f: FakeRazorpay = {
    refunds: new Map(),
    payments: new Map(),
    calls: [],
    failNext: [],
    touched: new Set(),
    listFailAtSkip: null,
    provider: undefined as unknown as RefundProvider,
    lister: undefined as unknown as PaymentLister,
  };
  const failure = async () => {
    const mode = f.failNext.shift();
    if (!mode) return;
    if (mode === "timeout") await new Promise(() => {});
    if (mode === "500") throw Object.assign(new Error("Internal"), { statusCode: 500, error: { code: "SERVER_ERROR" } });
    if (mode === "404") throw Object.assign(new Error("Not found"), { statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  };
  const notFound = () => Object.assign(new Error("nf"), { statusCode: 400, error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  const provider: RefundProvider = {
    async fetchRefund(id) {
      f.calls.push(`GET refund ${id}`);
      await failure();
      const r = f.refunds.get(id);
      if (!r) throw notFound();
      return JSON.parse(JSON.stringify(r));
    },
    async fetchPayment(id) {
      f.calls.push(`GET payment ${id}`);
      await failure();
      const p = f.payments.get(id);
      if (!p) throw notFound();
      return JSON.parse(JSON.stringify(p));
    },
  };
  const lister: PaymentLister = {
    async listPayments(q) {
      f.calls.push(`LIST payments skip=${q.skip} count=${q.count}`);
      if (f.listFailAtSkip !== null && q.skip === f.listFailAtSkip) {
        f.listFailAtSkip = null;
        throw Object.assign(new Error("gateway timeout"), { statusCode: 504 });
      }
      const all = [...f.payments.values()]
        .filter((p) => (p.created_at ?? 0) >= q.from && (p.created_at ?? 0) <= q.to)
        .sort((x, y) => (y.created_at ?? 0) - (x.created_at ?? 0));
      return { entity: "collection", count: Math.min(q.count, all.length - q.skip), items: all.slice(q.skip, q.skip + q.count) } as never;
    },
  };
  const watch = <T extends object>(o: T, name: string) =>
    new Proxy(o, {
      get(t, k) {
        f.touched.add(`${name}.${String(k)}`);
        return (t as Record<string | symbol, unknown>)[k];
      },
    });
  f.provider = watch(provider, "provider");
  f.lister = watch(lister, "lister");
  return f;
}
