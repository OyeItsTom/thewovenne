/**
 * WP-EMAIL-R1c-min — the order-confirmation recovery worker and its endpoint.
 *
 *   A. cronAuthorised and the route: fails closed without a strong secret,
 *      refuses wrong/malformed tokens, never echoes or logs the secret, GET
 *      only, no-store.
 *   B. 0074's recovery functions in real PostgreSQL 17.6: due selection,
 *      limits, orphan eligibility (historical, in-person, cancelled, unpaid,
 *      no lines, already claimed), access.
 *   C. runConfirmationRecovery end to end against that database and a FAKE
 *      Resend that models idempotency: batches, concurrent passes, expired
 *      leases, interrupted sends, uncertain outcomes, the 23 h window,
 *      database errors, missing migration, email not configured, retention,
 *      the time budget, no duplicates, no personal data in the report.
 *
 *   PG_HARNESS_DIR=<dir with embedded-postgres@17.6.0-beta.15> npx tsx scripts/order-confirmation-recovery.test.ts
 *
 * Contacts nothing: Supabase points at a closed local port for the route test,
 * every Resend call is a fake, and the database is a throwaway local cluster.
 */
// Must stay the first import: sets the test env before any Supabase client loads.
import "./order-confirmation-recovery.env";
import { NextRequest } from "next/server";
import { asRoot, asService, failure, startEngine, type Client } from "./pg-world";
import { cronAuthorised } from "../lib/cronAuth";
import { sendEmail } from "../lib/email";
import { attemptOrderConfirmation, enqueueOrderConfirmation, type AttemptDeps } from "../lib/orderConfirmationDelivery";
import { runConfirmationRecovery, type RecoveryDeps } from "../lib/orderConfirmationRecovery";
import type { RenderedConfirmation } from "../lib/sendOrderConfirmation";

let passed = 0;
let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        actual   ${JSON.stringify(actual)}`);
  }
}

const SECRET = "s".repeat(20) + "Kq9vX2mP7wL4nR8tY3zA"; // 40 chars, test only

// ══ A. Auth and route ════════════════════════════════════════════════════════
async function partA() {
  console.log("A. Auth and route");
  check("no secret configured → refused", cronAuthorised(`Bearer ${SECRET}`, undefined), false);
  check("empty secret → refused (even with an empty bearer)", cronAuthorised("Bearer ", ""), false);
  check("short secret (31) → refused even when matching", cronAuthorised(`Bearer ${"x".repeat(31)}`, "x".repeat(31)), false);
  check("correct bearer → allowed", cronAuthorised(`Bearer ${SECRET}`, SECRET), true);
  check("missing header → refused", cronAuthorised(null, SECRET), false);
  check("wrong token → refused", cronAuthorised(`Bearer ${SECRET}x`, SECRET), false);
  check("prefix of the secret → refused", cronAuthorised(`Bearer ${SECRET.slice(0, 35)}`, SECRET), false);
  check("no Bearer scheme → refused", cronAuthorised(SECRET, SECRET), false);
  check("lower-case scheme → refused", cronAuthorised(`bearer ${SECRET}`, SECRET), false);
  check("extra whitespace → refused", cronAuthorised(`Bearer  ${SECRET}`, SECRET), false);
  check("trailing data → refused", cronAuthorised(`Bearer ${SECRET} extra`, SECRET), false);

  const { GET } = await import("../app/api/cron/order-confirmations/route");
  const mod = await import("../app/api/cron/order-confirmations/route");
  check("route exports GET only (POST/PUT/DELETE → 405 by Next)", ["POST", "PUT", "DELETE", "PATCH"].filter((m) => m in mod).length, 0);
  check("route is dynamic, uncached, Node, bounded", [mod.dynamic, mod.revalidate, mod.runtime, mod.maxDuration], ["force-dynamic", 0, "nodejs", 60]);

  const logs: string[] = [];
  const keep = { log: console.log, error: console.error };
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  const call = async (auth: string | null, url = "https://example.test/api/cron/order-confirmations") => {
    const headers = new Headers();
    if (auth !== null) headers.set("authorization", auth);
    const res = await GET(new NextRequest(url, { headers }));
    return { status: res.status, cache: res.headers.get("cache-control"), location: res.headers.get("location"), body: await res.text() };
  };
  try {
    // No network or database work may happen before authorisation.
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      fetches++;
      return realFetch(...args);
    }) as typeof fetch;
    delete process.env.CRON_SECRET;
    const noSecret = await call(`Bearer ${SECRET}`);
    process.env.CRON_SECRET = "short";
    const shortSecret = await call("Bearer short");
    process.env.CRON_SECRET = SECRET;
    const none = await call(null);
    const wrong = await call("Bearer nope");
    const inQuery = await call(null, `https://example.test/api/cron/order-confirmations?secret=${SECRET}`);
    const fetchesBeforeAuth = fetches;
    globalThis.fetch = realFetch;
    const good = await call(`Bearer ${SECRET}`);
    console.log = keep.log;
    console.error = keep.error;

    check("refused requests made no network or database call at all", fetchesBeforeAuth, 0);
    check("CRON_SECRET unset → 401", noSecret.status, 401);
    check("CRON_SECRET too short → 401", shortSecret.status, 401);
    check("no header → 401", none.status, 401);
    check("wrong token → 401", wrong.status, 401);
    check("secret in the query string is ignored → 401", inQuery.status, 401);
    check("401 is no-store, no redirect", [wrong.cache, wrong.location], ["no-store, max-age=0", null]);
    check("authorised, database unreachable → 500 with an error code, no-store", [good.status, JSON.parse(good.body).error, good.cache], [500, "expire_failed", "no-store, max-age=0"]);
    check("the secret appears in no response body", [noSecret, shortSecret, none, wrong, inQuery, good].some((r) => r.body.includes(SECRET)), false);
    check("the secret appears in no log line", logs.some((l) => l.includes(SECRET) || l.includes(SECRET.slice(-12))), false);
    check("a missing secret is logged as such (without a value)", logs.some((l) => l.includes("CRON_SECRET is not configured")), true);
  } finally {
    console.log = keep.log;
    console.error = keep.error;
  }
}

// ══ Helpers for B/C ═════════════════════════════════════════════════════════
type Supa = AttemptDeps["supabase"];

const RPC: Record<string, [string, string[], "rows" | "scalar"]> = {
  enqueue_order_confirmation: ["select * from public.enqueue_order_confirmation($1)", ["p_order_id"], "rows"],
  claim_order_email_delivery: ["select * from public.claim_order_email_delivery($1, $2)", ["p_delivery_id", "p_lease_seconds"], "rows"],
  begin_order_email_request: ["select * from public.begin_order_email_request($1, $2, $3, $4, $5, $6)", ["p_delivery_id", "p_lease_token", "p_subject", "p_html", "p_text", "p_sha256"], "rows"],
  record_order_email_outcome: ["select public.record_order_email_outcome($1, $2, $3, $4, $5, $6, $7) as r", ["p_delivery_id", "p_lease_token", "p_outcome", "p_provider_message_id", "p_http_status", "p_error_code", "p_error"], "scalar"],
  expire_stale_order_email_deliveries: ["select public.expire_stale_order_email_deliveries($1::interval) as r", ["p_older_than"], "scalar"],
  list_due_order_email_deliveries: ["select * from public.list_due_order_email_deliveries($1)", ["p_limit"], "rows"],
  list_unqueued_paid_orders: ["select * from public.list_unqueued_paid_orders($1)", ["p_limit"], "rows"],
  order_email_delivery_summary: ["select public.order_email_delivery_summary() as r", [], "scalar"],
};

/** PostgREST-shaped rpc over a real service_role connection. */
function rpcClient(c: Client, opts: { failOn?: Set<string>; missing?: boolean } = {}): Supa {
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      if (opts.missing) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      if (opts.failOn?.has(fn)) return { data: null, error: { code: "08006", message: "connection lost (injected)" } };
      const q = RPC[fn];
      if (!q) throw new Error(`unmapped rpc ${fn}`);
      try {
        const res = await c.query(q[0], q[1].map((k) => args[k] ?? null));
        return { data: q[2] === "scalar" ? res.rows[0]?.r : res.rows, error: null };
      } catch (e) {
        return { data: null, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
      }
    },
  } as unknown as Supa;
}

type Reply = { status: number; body?: unknown } | "hang";
/** A fake Resend that remembers keys like the real one. */
function fakeResend(script: Reply[] = []) {
  const keys = new Map<string, { body: string; id: string }>();
  let calls = 0;
  let sent = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => {
    calls++;
    const key = (init.headers as Record<string, string>)["Idempotency-Key"];
    const body = String(init.body);
    const reply = script.length ? script.shift()! : { status: 200 };
    if (reply === "hang") {
      if (!keys.has(key)) keys.set(key, { body, id: `re_${++sent}` });
      await new Promise<void>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    }
    const status = reply === "hang" ? 200 : reply.status;
    if (status !== 200) return new Response(JSON.stringify((reply as { body?: unknown }).body ?? {}), { status });
    const prior = keys.get(key);
    if (prior && prior.body !== body) return new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 });
    const id = prior?.id ?? `re_${++sent}`;
    if (!prior) keys.set(key, { body, id });
    return new Response(JSON.stringify({ id }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, emailsSent: () => sent };
}

async function main() {
  await partA();

  const engine = await startEngine();
  if (!engine) {
    console.log("SKIPPED B and C — embedded-postgres not found (set PG_HARNESS_DIR). The worker was NOT verified.");
    console.log(`\n${passed} passed, ${failed} failed (B/C skipped)`);
    process.exit(failed ? 1 : 0);
  }
  console.log(`engine: ${engine.version.split(" ").slice(0, 2).join(" ")} (embedded, throwaway)`);
  const conns: Client[] = [];
  try {
    await engine.database("r1c");
    const root = await engine.connect("r1c");
    const svc = await engine.connect("r1c");
    conns.push(root, svc);
    await asRoot(root);
    await asService(svc);
    const one = async (q: string, a: unknown[] = []) => (await root.query(q, a)).rows[0];
    let n = 0;
    const order = async (o: { paid?: boolean; provider?: string; status?: string; items?: unknown; sent?: boolean; ageDays?: number } = {}) => {
      n++;
      const id = (await one(
        `insert into orders (customer_email, customer_name, total_inr, payment_status, payment_provider, razorpay_order_id, items, confirmation_sent_at, status)
         values ($1, 'Asha', 2950, $2, $3, $4, $5::jsonb, $6, $7) returning id`,
        [
          `c${n}@example.test`,
          o.paid === false ? "pending" : "paid",
          o.provider ?? "razorpay",
          (o.provider ?? "razorpay") === "razorpay" ? `order_T${n}` : null,
          JSON.stringify(o.items === undefined ? [{ id: "p", size: "M", quantity: 1, price_inr: 2950 }] : o.items),
          o.sent ? new Date().toISOString() : null,
          o.status ?? "placed",
        ]
      )).id as string;
      if (o.ageDays) await root.query("update orders set created_at = (select orphan_recovery_since from order_email_recovery_settings) - make_interval(days => $2) where id = $1", [id, o.ageDays]);
      return id;
    };
    const enqueue = async (orderId: string) => (await svc.query("select * from enqueue_order_confirmation($1)", [orderId])).rows[0].delivery_id as string;
    const row = async (id: string) => one("select * from order_email_deliveries where id = $1", [id]);
    const rowFor = async (orderId: string) => one("select * from order_email_deliveries where order_id = $1", [orderId]);
    const surgery = async (q: string, a: unknown[] = []) => {
      await root.query("set session_replication_role = replica");
      try {
        await root.query(q, a);
      } finally {
        await root.query("set session_replication_role = origin");
      }
    };
    /** Close every open row, so each block starts from a quiet table. */
    const quiet = () => surgery("update order_email_deliveries set status = 'failed', lease_token = null, lease_expires_at = null, html_body = null, text_body = null where status not in ('accepted', 'failed', 'expired')");
    const makeDue = () => root.query("update order_email_deliveries set next_attempt_at = now() - interval '1 second' where status in ('pending', 'retryable', 'uncertain')");
    const expireLeases = () => root.query("update order_email_deliveries set lease_expires_at = now() - interval '1 second' where status = 'sending'");

    const rendered: RenderedConfirmation = { ok: true, subject: "Your THE WOVENNE order — ABC", html: "<p>Hello Asha, 12 Lake Road</p>", text: "Hello Asha" };
    const workerDeps = (c: Client, rs: ReturnType<typeof fakeResend>, extra: Partial<RecoveryDeps> = {}, attemptExtra: Partial<AttemptDeps> = {}) => {
      const supabase = rpcClient(c);
      return {
        supabase,
        configured: () => true,
        attempt: (id: string) =>
          attemptOrderConfirmation(id, {
            supabase,
            send: (m) => sendEmail(m, { fetch: rs.fetchImpl }),
            render: async () => rendered,
            configured: () => true,
            timeoutMs: 60,
            ...attemptExtra,
          }),
        ...extra,
      } as Partial<RecoveryDeps>;
    };

    // ══ B. Functions ══════════════════════════════════════════════════════════
    console.log("B. Recovery functions");
    {
      const anon = await engine.connect("r1c");
      conns.push(anon);
      await anon.query("set role anon");
      for (const q of ["select * from list_due_order_email_deliveries(10)", "select * from list_unqueued_paid_orders(10)", "select order_email_delivery_summary()", "select * from order_email_recovery_settings"]) {
        check(`anon refused: ${q.slice(0, 48)}`, /permission denied/.test(await failure(() => anon.query(q))), true);
      }
      check("service_role cannot move the cutoff", /permission denied/.test(await failure(() => svc.query("update order_email_recovery_settings set orphan_recovery_since = now() - interval '10 years'"))), true);
      check("the cutoff row exists, set at migration time", (await one("select count(*)::int n from order_email_recovery_settings")).n, 1);

      // Orphan eligibility.
      const eligible = await order();
      const historical = await order({ ageDays: 3 });
      const inPerson = await order({ provider: "offline" });
      const unpaid = await order({ paid: false });
      const noLines = await order({ items: [] });
      const nullLines = await order({ items: null });
      const claimed = await order({ sent: true });
      const cancelled = await order({ status: "cancelled" });
      const queued = await order();
      await enqueue(queued);
      // Each guard on its own: an offline order that somehow carries a Razorpay
      // id, and a "razorpay" order with no Razorpay id.
      const offlineWithId = await order({ provider: "offline" });
      await root.query("update orders set razorpay_order_id = 'order_X' || left(id::text, 8) where id = $1", [offlineWithId]);
      const razorpayNoId = await order();
      await root.query("update orders set razorpay_order_id = null where id = $1", [razorpayNoId]);
      const found = (await svc.query("select order_id from list_unqueued_paid_orders(50)")).rows.map((r) => r.order_id);
      check("orphan scan finds the eligible order", found.includes(eligible), true);
      check("…and none of: historical, in-person, unpaid, no lines, claimed, cancelled, already queued", [historical, inPerson, unpaid, noLines, nullLines, claimed, cancelled, queued].filter((id) => found.includes(id)).length, 0);
      check("offline order excluded even with a Razorpay id", found.includes(offlineWithId), false);
      check("Razorpay order without a Razorpay id excluded", found.includes(razorpayNoId), false);
      check("orphan scan limit is capped at 50", /limit/.test((await one("select pg_get_functiondef('public.list_unqueued_paid_orders(integer)'::regprocedure) d")).d), true);
      for (let i = 0; i < 3; i++) await order();
      check("orphan scan honours a small limit", (await svc.query("select * from list_unqueued_paid_orders(2)")).rows.length, 2);
      check("…and a zero/negative limit still means at least 1, never unbounded", [(await svc.query("select * from list_unqueued_paid_orders(0)")).rows.length, (await svc.query("select * from list_unqueued_paid_orders(-5)")).rows.length], [1, 1]);
      // Leave these for C's orphan test: clear them so later counts are exact.
      await root.query("update orders set confirmation_sent_at = now() where confirmation_sent_at is null");

      // Due selection.
      const mk = async () => enqueue(await order());
      const pend = await mk();
      const notYet = await mk();
      await root.query("update order_email_deliveries set next_attempt_at = now() + interval '1 hour' where id = $1", [notYet]);
      const leased = await mk();
      await svc.query("select * from claim_order_email_delivery($1, 90)", [leased]);
      const lapsed = await mk();
      await svc.query("select * from claim_order_email_delivery($1, 90)", [lapsed]);
      await root.query("update order_email_deliveries set lease_expires_at = now() - interval '1 second' where id = $1", [lapsed]);
      const due = (await svc.query("select delivery_id from list_due_order_email_deliveries(50)")).rows.map((r) => r.delivery_id);
      check("due: pending past backoff and lapsed leases", [due.includes(pend), due.includes(lapsed)], [true, true]);
      check("not due: future backoff, live lease", [due.includes(notYet), due.includes(leased)], [false, false]);
      for (let i = 0; i < 60; i++) await mk();
      check("due list capped at 50 even when asked for more", (await svc.query("select * from list_due_order_email_deliveries(500)")).rows.length, 50);
      const summary = (await svc.query("select order_email_delivery_summary() s")).rows[0].s;
      check("summary is counts only", Object.values(summary).every((v) => typeof v === "number"), true);
      check("summary has no addresses or content", JSON.stringify(summary).includes("@"), false);
      await quiet();
    }

    // ══ C. Worker ═════════════════════════════════════════════════════════════
    console.log("C. Worker");
    {
      // Batch bound and no duplicates across passes.
      for (let i = 0; i < 15; i++) await enqueue(await order());
      const rs = fakeResend();
      const r1 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("one pass attempts at most 10", [r1.ok, r1.attempted, r1.outcomes.accepted], [true, 10, 10]);
      const r2 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("next pass takes the remaining 5", [r2.attempted, r2.outcomes.accepted], [5, 5]);
      const r3 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("then nothing is due; 15 emails in total, no duplicates", [r3.attempted, rs.emailsSent(), rs.calls()], [0, 15, 15]);
      check("report carries no personal data", JSON.stringify([r1, r2, r3]).includes("@") || JSON.stringify([r1, r2, r3]).includes("Asha"), false);
      await quiet();
    }
    {
      // Two passes at once (Vercel may overlap runs).
      for (let i = 0; i < 6; i++) await enqueue(await order());
      const rs = fakeResend();
      const [c1, c2] = await Promise.all([engine.connect("r1c"), engine.connect("r1c")]);
      conns.push(c1, c2);
      await asService(c1);
      await asService(c2);
      const [a, b] = await Promise.all([runConfirmationRecovery(workerDeps(c1, rs)), runConfirmationRecovery(workerDeps(c2, rs))]);
      check("concurrent passes: 6 accepted between them, each row once", [(a.outcomes.accepted ?? 0) + (b.outcomes.accepted ?? 0), rs.emailsSent(), rs.calls()], [6, 6, 6]);
      await quiet();
    }
    {
      // Interrupted send: the process dies after begin (send throws).
      const o = await order();
      const d = await enqueue(o);
      const rs = fakeResend();
      const dying = workerDeps(svc, rs, {}, { send: async () => { throw new Error("killed"); } });
      const r1 = await runConfirmationRecovery(dying);
      check("interrupted attempt contained", [r1.ok, r1.outcomes.error], [true, 1]);
      check("row left 'sending' under its lease", (await row(d)).status, "sending");
      const r2 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("while the lease lives, the next pass leaves it", [r2.attempted, rs.calls()], [0, 0]);
      await expireLeases();
      const r3 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("after the lease: taken over and accepted, possibly_accepted kept", [r3.outcomes.accepted, (await row(d)).status, (await row(d)).possibly_accepted], [1, "accepted", true]);
      await quiet();
    }
    {
      // Resend accepted, recording failed: the retry must not send twice.
      const d = await enqueue(await order());
      const rs = fakeResend();
      const broken = workerDeps(svc, rs, {}, { supabase: rpcClient(svc, { failOn: new Set(["record_order_email_outcome"]) }) });
      await runConfirmationRecovery(broken);
      check("database error after acceptance leaves the row sending", [(await row(d)).status, rs.emailsSent()], ["sending", 1]);
      await expireLeases();
      await runConfirmationRecovery(workerDeps(svc, rs));
      check("recovered: accepted, original id, still ONE email", [(await row(d)).status, (await row(d)).provider_message_id, rs.emailsSent()], ["accepted", "re_1", 1]);
      await quiet();
    }
    {
      // Uncertain (timeout), then recovery inside the window.
      const d = await enqueue(await order());
      const rs = fakeResend(["hang"]);
      const r1 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("timeout → uncertain", [r1.outcomes.uncertain, (await row(d)).status], [1, "uncertain"]);
      const r2 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("not retried during backoff", r2.attempted, 0);
      await makeDue();
      await runConfirmationRecovery(workerDeps(svc, rs));
      check("retried after backoff with the same key: accepted, ONE email", [(await row(d)).status, rs.emailsSent(), rs.calls()], ["accepted", 1, 2]);
      await quiet();
    }
    {
      // Uncertain past the 23 h window: never sent again.
      const d = await enqueue(await order());
      const rs = fakeResend(["hang"]);
      await runConfirmationRecovery(workerDeps(svc, rs));
      await surgery("update order_email_deliveries set first_provider_request_at = now() - interval '23 hours 5 minutes', next_attempt_at = now() - interval '1 second' where id = $1", [d]);
      const r = await runConfirmationRecovery(workerDeps(svc, rs));
      check("past the window: expired, not sent, payload dropped", [(await row(d)).status, rs.calls(), (await row(d)).html_body, r.outcomes.not_due], ["expired", 1, null, 1]);
      const again = await runConfirmationRecovery(workerDeps(svc, rs));
      check("an expired row is never listed again", [again.attempted, rs.calls()], [0, 1]);
      await quiet();
    }
    {
      // Permanent failure: not retried.
      const d = await enqueue(await order());
      const rs = fakeResend([{ status: 422, body: { name: "validation_error" } }]);
      await runConfirmationRecovery(workerDeps(svc, rs));
      await makeDue();
      const r = await runConfirmationRecovery(workerDeps(svc, rs));
      check("failed (422) is never retried", [(await row(d)).status, r.attempted, rs.calls()], ["failed", 0, 1]);
      await quiet();
    }
    {
      // Orphans: enqueued and sent in the same pass; historical never.
      const fresh = await order();
      const old = await order({ ageDays: 30 });
      const inPerson = await order({ provider: "offline" });
      const rs = fakeResend();
      const r = await runConfirmationRecovery(workerDeps(svc, rs));
      check("eligible orphan enqueued and sent in the same pass", [r.orphansFound, r.orphansEnqueued, (await rowFor(fresh))?.status], [1, 1, "accepted"]);
      check("historical and in-person orders untouched: no row, no claim", [await rowFor(old), await rowFor(inPerson), (await one("select confirmation_sent_at from orders where id = $1", [old])).confirmation_sent_at], [undefined, undefined, null]);
      const r2 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("an orphan is enqueued once", [r2.orphansFound, rs.emailsSent()], [0, 1]);
      // Racing settlement: the worker and settleOrder enqueue the same order.
      const racing = await order();
      const [w, s] = await Promise.all([runConfirmationRecovery(workerDeps(svc, rs)), enqueueOrderConfirmation(rpcClient(root), racing)]);
      check("worker and settlement racing on one order: one row, one email", [(await one("select count(*)::int n from order_email_deliveries where order_id = $1", [racing])).n, rs.emailsSent()], [1, 2]);
      void w; void s;
      await quiet();
    }
    {
      // Retention: stale unfinished rows closed by the pass.
      const pend = await enqueue(await order());
      const unc = await enqueue(await order());
      const rs = fakeResend(["hang"]);
      await attemptOrderConfirmation(unc, { supabase: rpcClient(svc), send: (m) => sendEmail(m, { fetch: rs.fetchImpl }), render: async () => rendered, configured: () => true, timeoutMs: 60 });
      await surgery("update order_email_deliveries set created_at = now() - interval '49 hours', next_attempt_at = now() + interval '1 hour' where id = any($1)", [[pend, unc]]);
      const r = await runConfirmationRecovery(workerDeps(svc, fakeResend()));
      check("stale rows closed by the pass", [r.staleClosed, (await row(pend)).status, (await row(unc)).status, (await row(unc)).html_body], [2, "failed", "expired", null]);
      await quiet();
    }
    {
      // Time budget: the pass stops starting attempts, the rest wait.
      for (let i = 0; i < 4; i++) await enqueue(await order());
      let clock = 0;
      const rs = fakeResend();
      const deps = workerDeps(svc, rs, { now: () => clock, budgetMs: 1000 });
      const inner = deps.attempt!;
      deps.attempt = async (id) => {
        const out = await inner(id);
        clock += 600;
        return out;
      };
      const r = await runConfirmationRecovery(deps);
      check("budget spent after 2 attempts → stoppedEarly, 2 left due", [r.attempted, r.stoppedEarly, r.summary?.due], [2, true, 2]);
      const r2 = await runConfirmationRecovery(workerDeps(svc, rs));
      check("the next pass finishes them", [r2.attempted, rs.emailsSent()], [2, 4]);
      await quiet();
    }
    {
      // Email not configured: nothing attempted, nothing spent.
      const d = await enqueue(await order());
      const rs = fakeResend();
      const r = await runConfirmationRecovery(workerDeps(svc, rs, { configured: () => false }));
      check("email not configured: no attempt, row untouched, reported", [r.ok, r.emailConfigured, r.attempted, (await row(d)).attempts, rs.calls()], [true, false, 0, 0, 0]);
      await quiet();
    }
    {
      // Database errors.
      const d = await enqueue(await order());
      const rs = fakeResend();
      const listFail = await runConfirmationRecovery({ ...workerDeps(svc, rs), supabase: rpcClient(svc, { failOn: new Set(["list_due_order_email_deliveries"]) }) });
      check("due scan fails → list_failed, nothing sent", [listFail.ok, listFail.error, rs.calls()], [false, "list_failed", 0]);
      const expireFail = await runConfirmationRecovery({ ...workerDeps(svc, rs), supabase: rpcClient(svc, { failOn: new Set(["expire_stale_order_email_deliveries"]) }) });
      check("stale expiry fails → expire_failed, nothing sent", [expireFail.error, rs.calls()], ["expire_failed", 0]);
      const missing = await runConfirmationRecovery({ ...workerDeps(svc, rs), supabase: rpcClient(svc, { missing: true }) });
      check("migration missing → migration_missing, nothing sent", [missing.error, missing.attempted, rs.calls()], ["migration_missing", 0, 0]);
      const after = await runConfirmationRecovery(workerDeps(svc, rs));
      check("once the database answers, the row is sent", [after.outcomes.accepted, (await row(d)).status], [1, "accepted"]);
      const throwing = await runConfirmationRecovery({ supabase: { rpc: () => { throw new Error("boom"); } } as unknown as Supa });
      check("a throwing client → internal, no throw", [throwing.ok, throwing.error], [false, "internal"]);
      await quiet();
    }
  } finally {
    for (const c of conns) await c.end().catch(() => {});
    await engine.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

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
